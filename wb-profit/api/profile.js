// /api/profile — возвращает полный профиль пользователя с лимитами и фичами тарифа.
// Фронт использует для отображения значков 🔒 на запрещённых функциях.
// ВАЖНО: фронтовый currentProfile теперь только UX-помощник — реальные проверки на бэке.

import { getUserPlanWithLimits } from '../lib/plan-check.js';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return res.status(401).json({ error: 'Нет токена авторизации' });

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
