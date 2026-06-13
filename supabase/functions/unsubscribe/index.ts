// supabase/functions/unsubscribe/index.ts
// Публичная (verify_jwt=false). GET — отписка по token; POST — one-click (RFC 8058).
// Невалидный/несуществующий token → та же нейтральная страница "Вы отписаны"
//   (НЕ раскрываем, существует ли токен; статус всегда 200).
import { createClient } from 'jsr:@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Отписка — SW Profit</title>
<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:420px;margin:80px auto;text-align:center;color:#1a1a2e">
<div style="font-size:40px">✅</div><h2>Вы отписаны</h2>
<p style="color:#6b7280">Больше не будем присылать ежедневную сводку по email. Включить снова можно в Настройках.</p>
<a href="https://swprofit.ru/dashboard.html" style="color:#5433c6">Открыть SW Profit →</a></div>`;

function htmlResponse() {
  return new Response(PAGE, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  if (token) {
    // невалидный uuid / несуществующий — апдейт просто не затронет строк, ошибку наружу не отдаём
    try {
      await supabase.from('notification_settings')
        .update({ daily_email_enabled: false }).eq('unsubscribe_token', token);
    } catch (_) { /* нейтрально молчим — не раскрываем существование токена */ }
  }
  return htmlResponse();
});
