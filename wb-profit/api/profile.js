// /api/profile — возвращает полный профиль + управление WB-кабинетами.
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

import { createClient } from '@supabase/supabase-js';
import { getUserPlanWithLimits } from '../lib/plan-check.js';
import { audit } from '../lib/audit-log.js';

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
