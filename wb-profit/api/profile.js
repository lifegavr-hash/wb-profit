// /api/profile — возвращает полный профиль + управление WB-кабинетами + экспорт данных.
//
// === Основные endpoints ===
// GET    /api/profile                    — профиль с лимитами тарифа
// DELETE /api/profile                    — удалить аккаунт (с паролем)
//
// === WB-кабинеты (v0.7.7.29) ===
// GET    /api/profile?resource=wb-accounts            — список кабинетов
// POST   /api/profile?resource=wb-accounts            — создать кабинет
// PATCH  /api/profile?resource=wb-accounts&id=xxx     — обновить (name/is_default/last_used_at)
// DELETE /api/profile?resource=wb-accounts&id=xxx     — удалить кабинет
//
// === Экспорт данных пользователя (v0.7.11.0, ФЗ-152 ст.14) ===
// GET    /api/profile?resource=export                 — JSON-выгрузка всех данных юзера
//        (БЕЗ wb_token, БЕЗ is_admin; user_id берётся ИЗ JWT)

import { createClient } from '@supabase/supabase-js';
import { getUserPlanWithLimits } from '../lib/plan-check.js';
import { audit } from '../lib/audit-log.js';
import { sendTransactional } from '../lib/email.js';

export const config = { maxDuration: 30 };

function makeServiceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

// ====== Sub-router: WB-аккаунты ======
async function handleWbAccounts(req, res, jwt) {
  const planResult = await getUserPlanWithLimits(jwt);
  if (planResult.error) {
    return res.status(planResult.status || 500).json({ error: planResult.error, message: planResult.message });
  }
  const user = planResult.user;
  const supa = makeServiceClient();

  // GET — список кабинетов пользователя
  if (req.method === 'GET') {
    const { data, error } = await supa
      .from('wb_accounts')
      .select('id, name, is_default, position, last_used_at, created_at, updated_at')
      .eq('user_id', user.id)
      .order('position', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });
    return res.status(200).json({
      accounts: data || [],
      limits: {
        max_wb_accounts: planResult.limits?.max_wb_accounts || 1,
        current_count: data?.length || 0,
      },
    });
  }

  // POST — создать новый кабинет
  if (req.method === 'POST') {
    let body = {};
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch (_) { body = {}; }

    const name = String(body.name || '').trim();
    const token = String(body.wb_token || '').trim();
    const isDefault = !!body.is_default;

    if (!name || name.length > 100) {
      return res.status(400).json({ error: 'INVALID_NAME', message: 'Название должно быть 1-100 символов' });
    }
    if (!token || !/^[A-Za-z0-9._-]+$/.test(token) || token.length < 50) {
      return res.status(400).json({ error: 'INVALID_TOKEN', message: 'WB-токен невалидный (только латинские буквы/цифры/.-_, минимум 50 символов)' });
    }

    // Проверка лимита (есть и триггер в БД, но даём более понятный 403 в API)
    const { count: currentCount } = await supa
      .from('wb_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id);
    const maxAllowed = planResult.limits?.max_wb_accounts || 1;
    if (!planResult.isAdmin && currentCount >= maxAllowed) {
      return res.status(403).json({
        error: 'WB_ACCOUNTS_LIMIT_REACHED',
        message: `На вашем тарифе максимум ${maxAllowed} кабинет(ов) WB. Сейчас уже: ${currentCount}.`,
        current_count: currentCount,
        max_allowed: maxAllowed,
      });
    }

    // Если это default — сбрасываем предыдущий default
    if (isDefault) {
      await supa
        .from('wb_accounts')
        .update({ is_default: false })
        .eq('user_id', user.id)
        .eq('is_default', true);
    }

    // Auto-default если это первый кабинет
    const finalIsDefault = isDefault || (currentCount === 0);

    const { data, error } = await supa
      .from('wb_accounts')
      .insert({
        user_id: user.id,
        name,
        wb_token: token,
        is_default: finalIsDefault,
        position: currentCount || 0,
        last_used_at: finalIsDefault ? new Date().toISOString() : null,
      })
      .select('id, name, is_default, position, last_used_at, created_at, wb_token')
      .single();

    if (error) {
      if (String(error.message || '').includes('WB_ACCOUNTS_LIMIT_REACHED')) {
        return res.status(403).json({ error: 'WB_ACCOUNTS_LIMIT_REACHED', message: error.message });
      }
      return res.status(500).json({ error: 'DB_ERROR', message: error.message });
    }

    await audit(req, user.id, user.email, 'wb_account_added', 'success', { name, account_id: data.id });

    // 🔥 v0.7.7.29: токен возвращаем ТОЛЬКО если это default (его нужно записать в localStorage сразу)
    const safeData = {
      id: data.id,
      name: data.name,
      is_default: data.is_default,
      position: data.position,
      last_used_at: data.last_used_at,
      created_at: data.created_at,
    };
    if (finalIsDefault) {
      safeData.wb_token = data.wb_token;
    }

    return res.status(200).json({ ok: true, account: safeData });
  }

  // PATCH — обновить кабинет (поля: name, is_default, last_used_at)
  if (req.method === 'PATCH') {
    const id = req.query?.id || req.query?.account_id;
    if (!id) return res.status(400).json({ error: 'MISSING_ID' });

    let body = {};
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch (_) { body = {}; }

    // Что разрешено обновлять
    const update = {};
    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name || name.length > 100) {
        return res.status(400).json({ error: 'INVALID_NAME' });
      }
      update.name = name;
    }
    if (typeof body.is_default === 'boolean') {
      update.is_default = body.is_default;
    }
    if (body.touch_last_used === true) {
      update.last_used_at = new Date().toISOString();
    }
    if (typeof body.wb_token === 'string' && body.wb_token.trim()) {
      const t = body.wb_token.trim();
      if (!/^[A-Za-z0-9._-]+$/.test(t) || t.length < 50) {
        return res.status(400).json({ error: 'INVALID_TOKEN' });
      }
      update.wb_token = t;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'NOTHING_TO_UPDATE' });
    }

    // Если назначаем как default — снимаем default с других
    if (update.is_default === true) {
      await supa
        .from('wb_accounts')
        .update({ is_default: false })
        .eq('user_id', user.id)
        .eq('is_default', true)
        .neq('id', id);
    }

    const { data, error } = await supa
      .from('wb_accounts')
      .update(update)
      .eq('id', id)
      .eq('user_id', user.id)
      .select('id, name, is_default, position, last_used_at, wb_token')
      .single();

    if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });
    if (!data) return res.status(404).json({ error: 'NOT_FOUND' });

    // 🔥 v0.7.7.29: токен возвращаем ТОЛЬКО когда явно делаем switch (is_default=true + touch_last_used=true).
    // В обычных PATCH (rename, etc) скрываем чтобы не светить лишний раз.
    const safeData = {
      id: data.id,
      name: data.name,
      is_default: data.is_default,
      position: data.position,
      last_used_at: data.last_used_at,
    };
    if (update.is_default === true && body.touch_last_used === true) {
      safeData.wb_token = data.wb_token;
    }

    return res.status(200).json({ ok: true, account: safeData });
  }

  // DELETE — удалить кабинет
  if (req.method === 'DELETE') {
    const id = req.query?.id || req.query?.account_id;
    if (!id) return res.status(400).json({ error: 'MISSING_ID' });

    // Сначала находим кабинет чтобы узнать был ли он default
    const { data: acc } = await supa
      .from('wb_accounts')
      .select('id, name, is_default')
      .eq('id', id)
      .eq('user_id', user.id)
      .single();
    if (!acc) return res.status(404).json({ error: 'NOT_FOUND' });

    const { error: delError } = await supa
      .from('wb_accounts')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);
    if (delError) return res.status(500).json({ error: 'DB_ERROR', message: delError.message });

    // Если удалили default — назначаем default другому (первому по позиции)
    if (acc.is_default) {
      const { data: remaining } = await supa
        .from('wb_accounts')
        .select('id')
        .eq('user_id', user.id)
        .order('position', { ascending: true })
        .order('created_at', { ascending: true })
        .limit(1);
      if (remaining && remaining.length > 0) {
        await supa
          .from('wb_accounts')
          .update({ is_default: true })
          .eq('id', remaining[0].id);
      }
    }

    await audit(req, user.id, user.email, 'wb_account_removed', 'success', { account_id: id, name: acc.name });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed for wb-accounts' });
}

// ====== Sub-router: экспорт данных пользователя (v0.7.11.0, ФЗ-152 ст.14) ======
// Отдаёт ВСЕ данные текущего юзера одним JSON. user_id берётся из JWT, НЕ из query —
// иначе юзер мог бы выгрузить чужие данные. wb_token и is_admin намеренно не включены.
async function handleExport(req, res, jwt) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed for export' });
  }

  // Авторизация — тот же паттерн что у wb-accounts: JWT → user через plan-check
  const planResult = await getUserPlanWithLimits(jwt);
  if (planResult.error) {
    return res.status(planResult.status || 500).json({ error: planResult.error, message: planResult.message });
  }
  const user = planResult.user; // user.id строго ИЗ JWT
  const supa = makeServiceClient();

  // Параллельная выборка всех таблиц по user_id
  const [
    profileRes,
    accountsRes,
    calcsRes,
    productCostsRes,
    userCostsRes,
    snapshotsRes,
  ] = await Promise.all([
    // profiles: БЕЗ is_admin (чувствительный флаг)
    supa.from('profiles')
      .select('id, email, plan, plan_expires_at, trial_until, billing_period, first_name, created_at')
      .eq('id', user.id)
      .single(),
    // wb_accounts: БЕЗ wb_token (секрет, никогда не экспортируем)
    supa.from('wb_accounts')
      .select('id, name, is_default, position, last_used_at, created_at, updated_at')
      .eq('user_id', user.id)
      .order('position', { ascending: true }),
    // unit_calc_history — расчёты юзера (все поля)
    supa.from('unit_calc_history')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true }),
    // product_costs — себестоимости (все поля)
    supa.from('product_costs')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: true }),
    // user_costs — личные расходы (все поля)
    supa.from('user_costs')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: true }),
    // daily_snapshots — история снапшотов (все поля)
    supa.from('daily_snapshots')
      .select('*')
      .eq('user_id', user.id)
      .order('day', { ascending: true }),
  ]);

  // Если какая-то секция упала — экспорт всё равно отдаём, проблемы складываем в meta.errors
  const errors = [];
  if (profileRes.error)      errors.push({ section: 'profile',         message: profileRes.error.message });
  if (accountsRes.error)     errors.push({ section: 'wb_accounts',     message: accountsRes.error.message });
  if (calcsRes.error)        errors.push({ section: 'saved_calcs',     message: calcsRes.error.message });
  if (productCostsRes.error) errors.push({ section: 'product_costs',   message: productCostsRes.error.message });
  if (userCostsRes.error)    errors.push({ section: 'user_costs',      message: userCostsRes.error.message });
  if (snapshotsRes.error)    errors.push({ section: 'daily_snapshots', message: snapshotsRes.error.message });

  const exportedAt = new Date().toISOString();
  const dateForFilename = exportedAt.slice(0, 10); // YYYY-MM-DD

  const payload = {
    meta: {
      exported_at: exportedAt,
      format_version: 1,
      service: 'SW Profit',
      note: 'персональные данные по ФЗ-152',
      user_id: user.id,
    },
    profile:         profileRes.data || null,
    wb_accounts:     accountsRes.data || [],
    saved_calcs:     calcsRes.data || [],
    product_costs:   productCostsRes.data || [],
    user_costs:      userCostsRes.data || [],
    daily_snapshots: snapshotsRes.data || [],
  };
  if (errors.length > 0) payload.meta.errors = errors;

  // 🔥 v0.7.12.3: пишем событие в audit_log (CHECK constraint расширен миграцией).
  // Аудит вторичен — если INSERT упадёт, экспорт всё равно должен дойти до юзера.
  // Поэтому try/catch + console.warn, без re-throw. В meta только счётчики, без ПД.
  try {
    await audit({
      event_type: 'data_exported',
      event_status: 'success',
      user_id: user.id,
      user_email: user.email,
      meta: {
        counts: {
          wb_accounts:     payload.wb_accounts.length,
          saved_calcs:     payload.saved_calcs.length,
          product_costs:   payload.product_costs.length,
          user_costs:      payload.user_costs.length,
          daily_snapshots: payload.daily_snapshots.length,
        },
        section_errors: errors.length || 0,
        format_version: 1,
      },
      req,
    });
  } catch (auditErr) {
    console.warn('[profile?resource=export] audit failed (export proceeds):', auditErr?.message);
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="swprofit-export-${dateForFilename}.json"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(JSON.stringify(payload, null, 2));
}

// ====== Sub-router: настройки email-уведомлений (Фаза C) ======
// GET   /api/profile?resource=notifications  — текущее состояние opt-in
// PATCH /api/profile?resource=notifications  — переключить (body {daily_email_enabled:bool})
// user_id строго из JWT; service-client (минует RLS штатно).
async function handleNotifications(req, res, jwt) {
  const planResult = await getUserPlanWithLimits(jwt);
  if (planResult.error) {
    return res.status(planResult.status || 500).json({ error: planResult.error, message: planResult.message });
  }
  const user = planResult.user;
  const supa = makeServiceClient();

  // GET — текущее состояние (нет строки → выключено по умолчанию)
  if (req.method === 'GET') {
    const { data, error } = await supa
      .from('notification_settings')
      .select('daily_email_enabled')
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });
    return res.status(200).json({ daily_email_enabled: !!data?.daily_email_enabled });
  }

  // PATCH — переключить (upsert по user_id; unsubscribe_token создастся дефолтом при первой вставке)
  if (req.method === 'PATCH') {
    let body = {};
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch (_) { body = {}; }
    if (typeof body.daily_email_enabled !== 'boolean') {
      return res.status(400).json({ error: 'INVALID_VALUE', message: 'daily_email_enabled должно быть boolean' });
    }
    const { error } = await supa
      .from('notification_settings')
      .upsert({ user_id: user.id, daily_email_enabled: body.daily_email_enabled }, { onConflict: 'user_id' });
    if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });
    return res.status(200).json({ ok: true, daily_email_enabled: body.daily_email_enabled });
  }

  return res.status(405).json({ error: 'Method not allowed for notifications' });
}

// ====== Фаза D: командный доступ ======
// HTML-экранирование для интерполяции в шаблон письма (regex email не режет <>"', не полагаемся на него).
function _escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Шаблон письма-инвайта (html + plaintext). Стиль как daily-digest (--purple #5433c6).
function renderInviteEmail({ inviterEmail, inviteeEmail, link }) {
  const inv = _escHtml(inviterEmail), gst = _escHtml(inviteeEmail);
  const html = `<div style="max-width:520px;margin:0 auto;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a2e">
  <h2 style="margin:0 0 8px">👥 Приглашение в команду SW Profit</h2>
  <p style="font-size:14px;line-height:1.5"><b>${inv}</b> приглашает вас в свою команду в SW Profit.</p>
  <p style="font-size:13px;color:#6b7280;line-height:1.5">Доступ — просмотр кабинета владельца: <b>Главная и Аналитика</b> (только чтение). Изменять данные, видеть токены и настройки нельзя.</p>
  <p style="margin:20px 0"><a href="${link}" style="display:inline-block;background:#5433c6;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Принять приглашение →</a></p>
  <div style="background:#fef9c3;border:1px solid #fde68a;color:#854d0e;padding:12px 14px;border-radius:8px;font-size:13px;line-height:1.5">⚠️ <b>Важно:</b> зарегистрируйтесь или войдите на <b>этот же email — ${gst}</b>. Иначе приглашение не примется.</div>
  <p style="font-size:12px;color:#9ca3af;margin-top:16px">Ссылка действует 7 дней. Если кнопка не работает, скопируйте:<br>${link}</p>
</div>`;
  const text = [
    `${inviterEmail} приглашает вас в команду SW Profit.`, ``,
    `Доступ: просмотр Главной и Аналитики кабинета владельца (только чтение).`, ``,
    `Принять приглашение: ${link}`, ``,
    `ВАЖНО: зарегистрируйтесь или войдите на ЭТОТ ЖЕ email — ${inviteeEmail}, иначе приглашение не примется.`,
    `Ссылка действует 7 дней.`,
  ].join('\n');
  return { html, text };
}

// Карта id→email одним запросом к profiles (источник email как в админ-вьюхах).
async function emailsByIds(supa, ids) {
  const uniq = [...new Set(ids)].filter(Boolean);
  if (!uniq.length) return {};
  const { data } = await supa.from('profiles').select('id, email').in('id', uniq);
  const map = {};
  for (const p of (data || [])) map[p.id] = p.email;
  return map;
}

// GET    ?resource=team               — участники + инвайты + счётчик мест
// POST   ?resource=team {email}       — создать инвайт
// DELETE ?resource=team&member_id=    — удалить участника (мгновенный отзыв)
// DELETE ?resource=team&invite_id=    — отозвать pending-инвайт
async function handleTeam(req, res, jwt) {
  const plan = await getUserPlanWithLimits(jwt);
  if (plan.error) return res.status(plan.status || 401).json({ error: plan.error, message: plan.message });
  const ownerId = plan.user.id;                              // R3: owner_id ВСЕГДА из JWT

  // R5: управлять командой может только активный Бизнес (прямо, без пересборки профиля)
  const eligible = plan.isAdmin || (plan.plan === 'business' && !plan.isExpired);
  if (!eligible) return res.status(403).json({ error: 'TEAM_REQUIRES_BUSINESS', message: 'Командный доступ доступен на тарифе Бизнес' });

  const supa = makeServiceClient();
  const maxTotal = plan.limits?.max_team_members || 1;       // всего мест вкл. владельца
  const memberSeats = Math.max(maxTotal - 1, 0);

  // ─── GET: участники + инвайты + места ───
  if (req.method === 'GET') {
    const { data: members, error: mErr } = await supa
      .from('team_members')
      .select('member_id, created_at')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: true });
    if (mErr) return res.status(500).json({ error: 'DB_ERROR', message: mErr.message });

    const { data: invites, error: iErr } = await supa
      .from('team_invites')
      .select('id, email, status, expires_at, created_at')
      .eq('owner_id', ownerId)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: true });
    if (iErr) return res.status(500).json({ error: 'DB_ERROR', message: iErr.message });

    const emailMap = await emailsByIds(supa, (members || []).map(m => m.member_id));
    const used = (members?.length || 0) + (invites?.length || 0);
    return res.status(200).json({
      members: (members || []).map(m => ({ member_id: m.member_id, email: emailMap[m.member_id] || null, created_at: m.created_at })),
      invites: (invites || []).map(i => ({ id: i.id, email: i.email, status: i.status, expires_at: i.expires_at, created_at: i.created_at })),
      seats: { used, member_seats: memberSeats, max_total: maxTotal },
    });
  }

  // ─── POST: создать инвайт ───
  if (req.method === 'POST') {
    let body = {};
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch (_) { body = {}; }
    const email = String(body.email || '').trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'INVALID_EMAIL', message: 'Введите корректный email' });
    }
    if (email === (plan.user.email || '').toLowerCase()) {
      return res.status(400).json({ error: 'CANNOT_INVITE_SELF', message: 'Нельзя пригласить себя' });
    }
    // R6: lazy-expire протухших pending на этот email (освобождает seat-счёт и partial-unique)
    await supa.from('team_invites')
      .update({ status: 'expired' })
      .eq('owner_id', ownerId).eq('status', 'pending')
      .lte('expires_at', new Date().toISOString())
      .ilike('email', email);
    // вставка pending; триггер enforce_team_limit добьёт лимит, partial-unique — дубли
    const { data, error } = await supa
      .from('team_invites')
      .insert({ owner_id: ownerId, email })
      .select('id, email, token, expires_at')
      .single();
    if (error) {
      if (String(error.message || '').includes('TEAM_LIMIT_REACHED'))
        return res.status(403).json({ error: 'TEAM_LIMIT_REACHED', message: `Максимум ${memberSeats} участник(ов) кроме владельца` });
      if (error.code === '23505')
        return res.status(409).json({ error: 'INVITE_EXISTS', message: 'Приглашение на этот email уже отправлено' });
      return res.status(500).json({ error: 'DB_ERROR', message: error.message });
    }
    const link = `https://swprofit.ru/login.html?next=${encodeURIComponent('/dashboard.html?invite=' + data.token)}`;
    // best-effort письмо-инвайт: упало → инвайт всё равно создан, owner копирует link (не валим 500)
    let emailSent = false;
    try {
      const { html, text } = renderInviteEmail({ inviterEmail: plan.user.email, inviteeEmail: data.email, link });
      await sendTransactional(data.email, `${plan.user.email} приглашает вас в команду SW Profit`, html, text);
      emailSent = true;
    } catch (e) {
      console.error('[team] invite email failed:', e?.message);
    }
    return res.status(200).json({ ok: true, email_sent: emailSent, invite: { id: data.id, email: data.email, expires_at: data.expires_at, link } });
  }

  // ─── DELETE: участник или инвайт ───
  if (req.method === 'DELETE') {
    const memberId = req.query?.member_id;
    const inviteId = req.query?.invite_id;
    if (memberId) {
      const { data, error } = await supa
        .from('team_members')
        .delete().eq('owner_id', ownerId).eq('member_id', memberId)   // R3: скоуп owner_id=JWT
        .select('id');
      if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });
      if (!data?.length) return res.status(403).json({ error: 'FORBIDDEN' });  // не своя строка
      return res.status(200).json({ ok: true });                              // мгновенный отзыв
    }
    if (inviteId) {
      const { data, error } = await supa
        .from('team_invites')
        .update({ status: 'revoked' })
        .eq('owner_id', ownerId).eq('id', inviteId).eq('status', 'pending')
        .select('id');
      if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });
      if (!data?.length) return res.status(403).json({ error: 'FORBIDDEN' });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'MISSING_TARGET' });
  }

  return res.status(405).json({ error: 'Method not allowed for team' });
}

// resource=team-accept — приём инвайта участником
async function handleTeamAccept(req, res, jwt) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const plan = await getUserPlanWithLimits(jwt);
  if (plan.error) return res.status(plan.status || 401).json({ error: plan.error });
  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch (_) { body = {}; }
  const token = String(body.token || '').trim();
  if (!token) return res.status(400).json({ error: 'TOKEN_REQUIRED' });

  const supa = makeServiceClient();
  // R2: личность СТРОГО из JWT (plan.user), НИКОГДА из тела запроса
  const { data, error } = await supa.rpc('accept_team_invite', {
    p_token: token,
    p_user_id: plan.user.id,
    p_user_email: plan.user.email,
  });
  if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });
  if (!data?.ok) {
    const map = { INVITE_INVALID: 404, INVITE_EXPIRED: 410, EMAIL_MISMATCH: 403, CANNOT_INVITE_SELF: 400, TEAM_LIMIT_REACHED: 403 };
    return res.status(map[data?.error] || 400).json({ error: data?.error || 'ACCEPT_FAILED' });
  }
  return res.status(200).json({ ok: true, owner_id: data.owner_id, already_member: !!data.already_member });
}

// resource=team-workspaces — список пространств, где я участник (для селектора)
async function handleTeamWorkspaces(req, res, jwt) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const plan = await getUserPlanWithLimits(jwt);
  if (plan.error) return res.status(plan.status || 401).json({ error: plan.error });
  const viewerId = plan.user.id;
  const supa = makeServiceClient();

  const { data: rows, error } = await supa
    .from('team_members')
    .select('owner_id')
    .eq('member_id', viewerId);                       // только МОИ членства (из JWT)
  if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });

  const emailMap = await emailsByIds(supa, (rows || []).map(r => r.owner_id));
  const workspaces = (rows || []).map(r => ({ owner_id: r.owner_id, owner_email: emailMap[r.owner_id] || null }));
  return res.status(200).json({ workspaces });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return res.status(401).json({ error: 'Нет токена авторизации' });

  // 🔥 v0.7.7.29: sub-router для wb-accounts
  const resource = req.query?.resource;
  if (resource === 'wb-accounts') {
    return handleWbAccounts(req, res, jwt);
  }
  // 🔥 v0.7.11.0: sub-router для экспорта данных юзера (ФЗ-152 ст.14)
  if (resource === 'export') {
    return handleExport(req, res, jwt);
  }
  // 🔥 Фаза C: sub-router для настроек email-уведомлений (opt-in дайджеста)
  if (resource === 'notifications') {
    return handleNotifications(req, res, jwt);
  }
  // 🔥 Фаза D: командный доступ (Бизнес)
  if (resource === 'team') {
    return handleTeam(req, res, jwt);
  }
  if (resource === 'team-accept') {
    return handleTeamAccept(req, res, jwt);
  }
  if (resource === 'team-workspaces') {
    return handleTeamWorkspaces(req, res, jwt);
  }

  // Основной маршрут — GET профиль / DELETE аккаунт
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // === GET — текущий профиль ===
  if (req.method === 'GET') {
    const r = await getUserPlanWithLimits(jwt);
    if (r.error) {
      return res.status(r.status || 500).json({ error: r.error, message: r.message });
    }

    return res.status(200).json({
      user: {
        id: r.user.id,
        email: r.user.email,
      },
      plan: r.plan,
      plan_name: r.plan_obj?.name || r.plan,
      plan_price: r.plan_obj?.price_monthly ?? 0,
      plan_price_yearly: r.plan_obj?.price_yearly ?? null,
      plan_expires_at: r.expiresAt?.toISOString() || null,
      is_admin: r.isAdmin,
      has_pro: r.hasPro,
      limits: r.limits,
      features: r.features,
      // 🔥 v0.7.7.22: trial + billing-период
      is_trial: r.isTrial,
      trial_days_left: r.trialDaysLeft,
      trial_until: r.trialUntil?.toISOString() || null,
      billing_period: r.billingPeriod,
      is_expired: r.isExpired,
      effective_plan_id: r.effectivePlanId,
    });
  }

  // === DELETE — удалить аккаунт ===
  // Тело: { password: '...', confirm: 'DELETE' }
  // Двойная защита: проверяем что текущий пароль введён правильно
  // (даже имея JWT, без знания пароля удалить нельзя)
  try {
    // Парсим body
    let body = {};
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch(_) { body = {}; }
    const password = (body.password || '').trim();
    const confirm = (body.confirm || '').trim();

    if (confirm !== 'DELETE') {
      return res.status(400).json({ error: 'CONFIRM_REQUIRED', message: 'Подтверждение удаления не получено' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'PASSWORD_REQUIRED', message: 'Введите пароль для подтверждения' });
    }

    // Сначала получаем user из JWT (через service_role)
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return res.status(500).json({ error: 'CONFIG_MISSING' });
    }
    const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);

    // Получаем user.id и email через verify JWT
    const planInfo = await getUserPlanWithLimits(jwt);
    if (planInfo.error) {
      return res.status(planInfo.status || 401).json({ error: planInfo.error });
    }
    const userId = planInfo.user.id;
    const userEmail = planInfo.user.email;

    if (!userId || !userEmail) {
      return res.status(401).json({ error: 'INVALID_SESSION' });
    }

    // Проверяем пароль через signInWithPassword (это создаст временную сессию,
    // но мы её не сохраняем — клиент anon, не подписка на сессию)
    const anonClient = createClient(SUPABASE_URL, SERVICE_KEY); // используем service_key как auth — он умеет signIn
    const { data: signIn, error: signInErr } = await anonClient.auth.signInWithPassword({
      email: userEmail,
      password: password
    });
    if (signInErr || !signIn?.user || signIn.user.id !== userId) {
      // 🔥 v0.7.7.17: лог попыток с неверным паролем
      await audit({
        event_type: 'account_deleted',
        event_status: 'failed',
        user_id: userId,
        user_email: userEmail,
        meta: { reason: 'wrong_password' },
        req
      });
      return res.status(403).json({ error: 'WRONG_PASSWORD', message: 'Неверный пароль' });
    }

    // Пароль подтверждён. Удаляем все пользовательские данные через RPC
    const { data: deleted, error: delErr } = await adminClient.rpc('delete_user_account', {
      target_user_id: userId
    });
    if (delErr) {
      console.error('[/api/profile DELETE] RPC error:', delErr);
      return res.status(500).json({ error: 'DELETE_FAILED', message: delErr.message });
    }

    // Финально — удаляем учётку из auth.users
    const { error: authDelErr } = await adminClient.auth.admin.deleteUser(userId);
    if (authDelErr) {
      console.error('[/api/profile DELETE] auth.admin.deleteUser error:', authDelErr);
      // Данные уже удалены — auth-учётка останется, но это лучше чем half-state
      return res.status(500).json({
        error: 'AUTH_DELETE_FAILED',
        message: 'Данные удалены, но учётка осталась. Свяжитесь с поддержкой.',
        deleted
      });
    }

    // 🔥 v0.7.7.17: успешный лог
    await audit({
      event_type: 'account_deleted',
      event_status: 'success',
      user_id: userId,
      user_email: userEmail,
      meta: { deleted },
      req
    });

    return res.status(200).json({ ok: true, deleted });
  } catch (e) {
    console.error('[/api/profile DELETE] unexpected:', e);
    return res.status(500).json({ error: 'INTERNAL', message: e.message });
  }
}
