// lib/team.js — командный доступ (Фаза D).
// resolveWorkspace — ЕДИНСТВЕННАЯ точка истины «чьё пространство я смотрю».
// Модель: app-layer. RLS базовых таблиц не ослабляется; доступ участника к данным
// владельца идёт ТОЛЬКО через эту функцию + service-role чтение в эндпоинтах.
//
// Гарантии:
//  - личность берётся из верифицированного JWT (getUserPlanWithLimits), не из запроса;
//  - wb_token нигде не читается и не возвращается;
//  - role!=='owner' → вызывающий эндпоинт ОБЯЗАН запретить любой WB-pull (wb.js/wb-adv.js);
//  - отзыв мгновенный (членство проверяется per-request);
//  - доступ участника жив только пока владелец = активный Бизнес (isActiveBusiness, учитывает expired/trial).

import { createClient } from '@supabase/supabase-js';
import { getUserPlanWithLimits, isActiveBusiness } from './plan-check.js';

function svc() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// resolveWorkspace(jwt, requestedOwnerId)
//   → { ownerId, viewerId, role:'owner'|'viewer', ownerLimits:{max_history_days} }
//   → { error, status } при отказе
export async function resolveWorkspace(jwt, requestedOwnerId) {
  const viewer = await getUserPlanWithLimits(jwt);          // личность ТОЛЬКО из JWT
  if (viewer.error) return { error: viewer.error, status: viewer.status || 401 };
  const viewerId = viewer.user.id;

  // Своё пространство (или workspace не задан) — обычный путь, без проверок членства.
  if (!requestedOwnerId || requestedOwnerId === viewerId) {
    return { ownerId: viewerId, viewerId, role: 'owner', ownerLimits: viewer.limits };
  }

  const supa = svc();

  // 1) Членство: есть ли (owner=requested, member=viewer)? service-role, RLS базовых таблиц ни при чём.
  const { data: membership, error: mErr } = await supa
    .from('team_members')
    .select('id')
    .eq('owner_id', requestedOwnerId)
    .eq('member_id', viewerId)
    .maybeSingle();
  if (mErr) return { error: 'DB_ERROR', status: 500 };
  if (!membership) return { error: 'FORBIDDEN', status: 403 };

  // 2) Владелец должен быть активным Бизнесом (канонический isActiveBusiness: business && !expired, либо admin).
  const { data: owner, error: pErr } = await supa
    .from('profiles')
    .select('plan, plan_expires_at, trial_until, billing_period, is_admin')
    .eq('id', requestedOwnerId)
    .single();
  if (pErr || !owner) return { error: 'FORBIDDEN', status: 403 };
  if (!isActiveBusiness(owner)) return { error: 'OWNER_PLAN_INACTIVE', status: 403 };

  // 3) Лимит истории владельца (для max_history_days при чтении его снапшотов).
  const ownerPlanId = owner.is_admin ? 'business' : owner.plan;
  const { data: ownerPlan } = await supa
    .from('plans')
    .select('max_history_days')
    .eq('id', ownerPlanId)
    .maybeSingle();

  return {
    ownerId: requestedOwnerId,
    viewerId,
    role: 'viewer',
    ownerLimits: { max_history_days: ownerPlan?.max_history_days ?? 30 },
  };
}
