// supabase/functions/daily-digest/index.ts
// Запускается pg_cron раз в день (08:00 МСК). Закрыта CRON_SECRET (verify_jwt=false).
//
// АНТИДУБЛЬ BY DESIGN (требование заказчика, НЕ менять):
//   Перед отправкой "столбим" строку email_send_log(status='sending') через
//   upsert ignoreDuplicates по UNIQUE(user_id,kind,digest_date).
//   Если функция упадёт МЕЖДУ 'sending' и успешной отправкой — письмо за этот
//   день ТЕРЯЕТСЯ и НЕ повторяется (UNIQUE заблокирует повторный claim).
//   Это осознанный компромисс: дайджест не критичен, ретраи/задвоение хуже потери.
//   НИКАКОЙ ретрай-логики здесь быть не должно.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET  = Deno.env.get('CRON_SECRET')!;
const UNI_KEY      = Deno.env.get('UNISENDER_API_KEY')!;
// DC аккаунта = go2 (как у SMTP go2.unisender.ru). Переопределяется env при смене региона.
const UNI_BASE     = Deno.env.get('UNISENDER_API_BASE') ?? 'https://go2.unisender.ru';
const FROM_EMAIL = 'noreply@swprofit.ru';
const FROM_NAME  = 'SW Profit';
const APP_URL    = 'https://swprofit.ru';
const FUNCS_URL  = SUPABASE_URL.replace('.supabase.co', '.functions.supabase.co');

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// "Вчера" по Europe/Moscow: берём СЕГОДНЯШНЮЮ дату МСК как YYYY-MM-DD,
// затем минус N дней через UTC-арифметику над чистой датой (без сдвига часовых поясов).
function mskDateMinus(daysAgo: number): string {
  const todayMsk = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()); // -> "YYYY-MM-DD" (МСК)
  const d = new Date(todayMsk + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

const fmtMoney = (n: number) =>
  Math.round(Number(n) || 0).toLocaleString('ru-RU').replace(/ /g, ' ');

// Маржа с защитой от деления на ноль: revenue<=0 → null → в письме "—".
function marginPct(profit: number, revenue: number): number | null {
  if (!revenue || revenue <= 0) return null;
  return Math.round((profit / revenue) * 1000) / 10; // 1 знак
}

Deno.serve(async (req) => {
  // авторизация крона
  if (req.headers.get('Authorization') !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const digestDate = mskDateMinus(1);     // вчера по МСК
  const date7start = mskDateMinus(7);     // для среднего за 7 дней

  // 1) включившие рассылку
  const { data: settings, error: sErr } = await supabase
    .from('notification_settings')
    .select('user_id, unsubscribe_token')
    .eq('daily_email_enabled', true);
  if (sErr) return new Response(JSON.stringify({ error: sErr.message }), { status: 500 });
  if (!settings?.length) {
    return new Response(JSON.stringify({ sent: 0, skipped: 0, failed: 0, reason: 'no opt-in' }),
      { headers: { 'Content-Type': 'application/json' } });
  }

  const ids = settings.map((s) => s.user_id);

  // 2) снапшоты этих юзеров за окно [digestDate-6 .. digestDate]
  const { data: snaps, error: snErr } = await supabase
    .from('daily_snapshots')
    .select('user_id, day, revenue, profit, sales_count, returns_count')
    .in('user_id', ids)
    .gte('day', date7start)
    .lte('day', digestDate);
  if (snErr) return new Response(JSON.stringify({ error: snErr.message }), { status: 500 });

  // 3) email'ы (auth.users) → карта id→email
  const emailById = new Map<string, string>();
  let page = 1;
  for (;;) {
    const { data: list } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (!list?.users?.length) break;
    for (const u of list.users) if (u.email) emailById.set(u.id, u.email);
    if (list.users.length < 200) break;
    page++;
  }

  // агрегируем по юзеру: суммы за "вчера" по всем WB-кабинетам + дневные суммы для среднего
  type Agg = { rev: number; profit: number; sales: number; returns: number; hasYesterday: boolean; byDay: Record<string, number> };
  const agg = new Map<string, Agg>();
  for (const r of snaps ?? []) {
    const a = agg.get(r.user_id) ?? { rev: 0, profit: 0, sales: 0, returns: 0, hasYesterday: false, byDay: {} };
    a.byDay[r.day] = (a.byDay[r.day] || 0) + (Number(r.profit) || 0); // дневная прибыль (сумма кабинетов)
    if (r.day === digestDate) {
      a.rev += Number(r.revenue) || 0;
      a.profit += Number(r.profit) || 0;
      a.sales += Number(r.sales_count) || 0;
      a.returns += Number(r.returns_count) || 0;
      a.hasYesterday = true;
    }
    agg.set(r.user_id, a);
  }

  let sent = 0, skipped = 0, failed = 0;
  for (const s of settings) {
    const a = agg.get(s.user_id);
    if (!a || !a.hasYesterday) { skipped++; continue; }   // нет данных за вчера → не шлём
    const email = emailById.get(s.user_id);
    if (!email) { skipped++; continue; }

    // claim строки (антидубль). select() вернёт строку ТОЛЬКО если реально вставили.
    const { data: claimed, error: cErr } = await supabase
      .from('email_send_log')
      .upsert({ user_id: s.user_id, kind: 'daily_digest', digest_date: digestDate, status: 'sending' },
              { onConflict: 'user_id,kind,digest_date', ignoreDuplicates: true })
      .select('id');
    if (cErr) { failed++; continue; }
    if (!claimed?.length) { skipped++; continue; }          // уже отправлено/в работе сегодня
    const logId = claimed[0].id;

    // среднее за 7 дней (по дням, где есть данные)
    const days = Object.values(a.byDay);
    const avg7 = days.length ? days.reduce((x, y) => x + y, 0) / days.length : 0;
    const m = marginPct(a.profit, a.rev);
    const unsubUrl = `${FUNCS_URL}/unsubscribe?token=${s.unsubscribe_token}`;
    const view = {
      digestDate, revenue: a.rev, profit: a.profit, margin: m,
      sales: a.sales, returns: a.returns, avg7, unsubUrl,
    };
    const html = renderDigestHtml(view);
    const text = renderDigestText(view);

    try {
      await sendEmail(email, `📊 Сводка за ${digestDate}`, html, text, unsubUrl);
      await supabase.from('email_send_log')
        .update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', logId);
      sent++;
    } catch (e) {
      await supabase.from('email_send_log')
        .update({ status: 'failed', error: String(e).slice(0, 500) }).eq('id', logId);
      failed++;
      // НЕ ретраим — by design (см. шапку файла)
    }
  }

  return new Response(JSON.stringify({ digestDate, sent, skipped, failed }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

// Unisender Go — transactional HTTP API (НЕ SMTP). Endpoint /ru/transactional/api/v1/email/send.json + X-API-KEY.
// ⚠️ DC-зависимость: при ошибке Unisender code 114 "User not found" — это НЕ про получателя,
//    а неверный дата-центр аккаунта → сменить env UNISENDER_API_BASE на https://go1.unisender.ru
//    (подтверждено докой Unisender Go: базовый URL зависит от ДЦ аккаунта go1/go2).
async function sendEmail(to: string, subject: string, html: string, plaintext: string, unsubUrl: string) {
  const r = await fetch(`${UNI_BASE}/ru/transactional/api/v1/email/send.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': UNI_KEY },
    body: JSON.stringify({
      message: {
        recipients: [{ email: to }],
        subject,
        from_email: FROM_EMAIL,
        from_name: FROM_NAME,
        body: { html, plaintext },   // текстовая версия рядом с html — для доставляемости/антиспама
        headers: {
          'List-Unsubscribe': `<${unsubUrl}>, <mailto:unsubscribe@swprofit.ru>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      },
    }),
  });
  if (!r.ok) throw new Error(`unisender ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

type DigestView = {
  digestDate: string; revenue: number; profit: number; margin: number | null;
  sales: number; returns: number; avg7: number; unsubUrl: string;
};

function renderDigestText(d: DigestView): string {
  const marginTxt = d.margin === null ? '—' : `${d.margin}%`;
  const trend = d.profit >= d.avg7 ? 'выше' : 'ниже';
  return [
    `Сводка за ${d.digestDate} (SW Profit)`,
    ``,
    `Выручка: ${fmtMoney(d.revenue)} ₽`,
    `Чистая прибыль: ${fmtMoney(d.profit)} ₽`,
    `Маржа: ${marginTxt}`,
    `Продажи / возвраты: ${fmtMoney(d.sales)} / ${fmtMoney(d.returns)} шт`,
    `Прибыль ${trend} среднего за 7 дней (${fmtMoney(d.avg7)} ₽).`,
    ``,
    `Дашборд: ${APP_URL}/dashboard.html`,
    `Отписаться: ${d.unsubUrl}`,
  ].join('\n');
}

function renderDigestHtml(d: DigestView): string {
  const profitColor = d.profit >= 0 ? '#16a34a' : '#dc2626';
  const marginTxt = d.margin === null ? '—' : `${d.margin}%`;
  const arrow = d.profit >= d.avg7 ? '▲' : '▼';
  const word = d.profit >= d.avg7 ? 'выше' : 'ниже';
  return `<div style="max-width:520px;margin:0 auto;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a2e">
  <h2 style="margin:0 0 4px">📊 Сводка за ${d.digestDate}</h2>
  <p style="color:#6b7280;margin:0 0 16px;font-size:13px">по данным на момент последнего обновления в SW Profit</p>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:8px 0;color:#6b7280">Выручка</td><td style="text-align:right;font-weight:700">${fmtMoney(d.revenue)} ₽</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280">Чистая прибыль</td><td style="text-align:right;font-weight:700;color:${profitColor}">${fmtMoney(d.profit)} ₽</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280">Маржа</td><td style="text-align:right;font-weight:700">${marginTxt}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280">Продажи / возвраты</td><td style="text-align:right">${fmtMoney(d.sales)} / ${fmtMoney(d.returns)} шт</td></tr>
  </table>
  <p style="margin:14px 0;font-size:13px;color:#6b7280">${arrow} прибыль ${word} среднего за 7 дней (${fmtMoney(d.avg7)} ₽).</p>
  <a href="${APP_URL}/dashboard.html" style="display:inline-block;background:#5433c6;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600">Открыть дашборд →</a>
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
  <p style="font-size:11px;color:#9ca3af;text-align:center">Вы получаете это письмо, потому что включили «Сводку по email» в SW Profit.<br>
  <a href="${d.unsubUrl}" style="color:#9ca3af">Отписаться</a></p>
</div>`;
}
