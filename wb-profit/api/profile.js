// /api/profile — возвращает полный профиль пользователя с лимитами и фичами тарифа.
// Фронт использует для отображения значков 🔒 на запрещённых функциях.
// ВАЖНО: фронтовый currentProfile теперь только UX-помощник — реальные проверки на бэке.
//
// GET    — профиль с лимитами тарифа
// DELETE — удаление аккаунта пользователя (с подтверждением паролем) — v0.7.7.13

import { createClient } from '@supabase/supabase-js';
import { getUserPlanWithLimits } from '../lib/plan-check.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return res.status(401).json({ error: 'Нет токена авторизации' });

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
      plan_expires_at: r.expiresAt?.toISOString() || null,
      is_admin: r.isAdmin,
      has_pro: r.hasPro,
      limits: r.limits,
      features: r.features,
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

    return res.status(200).json({ ok: true, deleted });
  } catch (e) {
    console.error('[/api/profile DELETE] unexpected:', e);
    return res.status(500).json({ error: 'INTERNAL', message: e.message });
  }
}
