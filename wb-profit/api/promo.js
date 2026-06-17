// /api/promo — активация промокода
// v0.7.1: SECURITY FIX — userId теперь берётся ТОЛЬКО из JWT, не из body.
// Раньше можно было активировать промокод на чужой аккаунт прислав чужой userId.
//
// Также: запрет активации промокода если уже есть активный платный план
// (иначе можно стакать триалы бесконечно).

import { createClient } from '@supabase/supabase-js';
import { getUserPlanWithLimits } from '../lib/plan-check.js';
import { audit } from '../lib/audit-log.js';

const PLAN_RANK = { free: 0, start: 1, pro: 2, business: 3 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // SECURITY: userId — ТОЛЬКО из JWT, не из body
  const jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return res.status(401).json({ error: 'Нет токена авторизации' });
  const planResult = await getUserPlanWithLimits(jwt);
  if (planResult.error) {
    return res.status(planResult.status || 401).json({ error: planResult.error, message: planResult.message });
  }
  const userId = planResult.user.id;
  const userEmail = planResult.user.email;
  const isAdmin = planResult.isAdmin;
  const currentPlan = planResult.plan;
  const currentExpires = planResult.expiresAt;

  // 🔥 v0.7.12.16: нормализуем код (trim+upper) чтобы 'igorek2000', ' IGOREK2000 ', 'Igorek2000'
  // все находили IGOREK2000 в БД. Раньше был только toUpperCase без trim → пробелы ломали поиск.
  const code = ((req.body && req.body.code) || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Укажите code' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Ищем промокод (code уже нормализован выше)
  const { data: promo, error: promoError } = await supabase
    .from('promo_codes').select('*').eq('code', code).eq('is_active', true).single();

  if (promoError || !promo) {
    await audit({ event_type: 'promo_failed', event_status: 'failed', user_id: userId, user_email: userEmail, meta: { code: code, reason: 'not_found' }, req });
    return res.status(404).json({ error: 'Промокод не найден или недействителен' });
  }
  if (promo.used_count >= promo.max_uses) {
    await audit({ event_type: 'promo_failed', event_status: 'failed', user_id: userId, user_email: userEmail, meta: { code: code, reason: 'max_uses' }, req });
    return res.status(400).json({ error: 'Промокод использован максимальное количество раз' });
  }

  // Уже использовал этот промокод?
  const { data: existing } = await supabase
    .from('promo_uses').select('id').eq('promo_id', promo.id).eq('user_id', userId).maybeSingle();
  if (existing) {
    await audit({ event_type: 'promo_failed', event_status: 'failed', user_id: userId, user_email: userEmail, meta: { code: code, reason: 'already_used' }, req });
    return res.status(400).json({ error: 'Вы уже использовали этот промокод' });
  }

  // 🔥 v0.7.1: запрет активации поверх активного платного плана (если не админ).
  // Исключение: можно АПГРЕЙД (например со Старта на PRO). Даунгрейд/тот же уровень — запрет.
  if (!isAdmin && currentExpires && currentExpires.getTime() > Date.now()) {
    const curRank = PLAN_RANK[currentPlan] ?? 0;
    const promoRank = PLAN_RANK[promo.plan] ?? 0;
    if (promoRank <= curRank) {
      await audit({ event_type: 'promo_failed', event_status: 'failed', user_id: userId, user_email: userEmail, meta: { code: code, reason: 'active_plan', current: currentPlan, promo: promo.plan }, req });
      return res.status(400).json({
        error: 'ACTIVE_PLAN',
        message: `У вас уже активен тариф ${currentPlan.toUpperCase()} до ${currentExpires.toLocaleDateString('ru-RU')}. Этот промокод даёт ${promo.plan.toUpperCase()} — нет смысла активировать.`,
      });
    }
    // Апгрейд (например с start на pro) — разрешён
  }

  // Активация
  const expires = new Date();
  expires.setDate(expires.getDate() + promo.days);

  await supabase.from('promo_uses').insert({ promo_id: promo.id, user_id: userId });
  await supabase.from('promo_codes').update({ used_count: promo.used_count + 1 }).eq('id', promo.id);
  // 🔥 v0.7.12.74: промокод задаёт plan/days + ЯВНО billing_period='promo' и сбрасывает trial_until
  // (иначе оставались дефолты регистрации trial/+14, и фронт показывал «Trial PRO»). service_role-клиент
  // (см. createClient выше) проходит триггер protect_profile_admin_fields, поэтому запись plan/expires/billing/trial разрешена.
  await supabase.from('profiles').update({ plan: promo.plan, plan_expires_at: expires.toISOString(), billing_period: 'promo', trial_until: null }).eq('id', userId);

  await audit({
    event_type: 'promo_activated',
    event_status: 'success',
    user_id: userId,
    user_email: userEmail,
    meta: { code: code, plan: promo.plan, days: promo.days, expires_at: expires.toISOString() },
    req
  });

  return res.status(200).json({
    success: true,
    plan: promo.plan,
    days: promo.days,
    expires_at: expires.toISOString(),
  });
}
