// /api/costs — себестоимости + доп.расход ₽/шт (extras) + постоянные расходы кабинета
// GET   ?wb_account_id=xxx              — { costs: { nm_id: cost }, extras: { nm_id: extra_per_unit } }
// POST  { costs: {...}, extras: {...}, wb_account_id }  — upsert батчем (costs и/или extras, раздельные колонки)
// DELETE ?nm_id=...&wb_account_id=xxx    — удалить одну запись себестоимости
//
// v0.7.7.30: данные разделены по wb_account_id.
// Модуль «Расходы и налог»: extras (колонка extra_per_unit, Часть 2) + sub-router ?resource=expenses (см. ниже).

import { createClient } from '@supabase/supabase-js';
import { resolveWbAccountId } from '../lib/wb-account.js';
import { getUserPlanWithLimits } from '../lib/plan-check.js';
import { resolveWorkspace } from '../lib/team.js';
import { audit } from '../lib/audit-log.js';

// ====== Sub-router: постоянные расходы кабинета (модуль «Расходы и налог», Часть 1) ======
// GET    ?resource=expenses                          — { expenses: [{id,name,amount,active}] }
// POST   ?resource=expenses {id?,name,amount,active} — insert (без id) / update (с id)
// DELETE ?resource=expenses&id=                      — удалить строку
// Наследует обвес costs.js: JWT+service-role, resolveWbAccountId, workspace+audit.
// Expired-гейт на POST/DELETE применяется ВЫШЕ в handler (до вызова), как для себестоимости.
const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function handleExpenses(req, res, ctx) {
  const { supabase, dataUserId, wbAccountId, wsViewerId } = ctx;

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('fixed_expenses')
      .select('id, name, amount, active, created_at, updated_at')
      .eq('user_id', dataUserId)
      .eq('wb_account_id', wbAccountId)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ expenses: data || [], wb_account_id: wbAccountId });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name || name.length > 100) return res.status(400).json({ error: 'INVALID_NAME', message: 'Название 1-100 символов' });
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'INVALID_AMOUNT', message: 'amount >= 0' });
    const now = new Date().toISOString();
    const id = body.id ? String(body.id) : null;
    if (id && !_UUID_RE.test(id)) return res.status(404).json({ error: 'NOT_FOUND' });

    if (id) {
      // UPDATE — строго по своей строке (скоуп user_id + wb_account_id).
      // active меняем только если поле явно прислано → частичный апдейт не сбросит флаг.
      const patch = { name, amount, updated_at: now };
      if (body.active !== undefined) patch.active = !!body.active;
      const { data, error } = await supabase
        .from('fixed_expenses')
        .update(patch)
        .eq('id', id)
        .eq('user_id', dataUserId)
        .eq('wb_account_id', wbAccountId)
        .select('id, name, amount, active')
        .maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'NOT_FOUND' });
      if (wsViewerId) { try { await audit({ event_type: 'team_cost_edit', user_id: wsViewerId,
        meta: { owner_id: dataUserId, expense_id: id, kind: 'fixed_expense', action: 'update' }, req }); } catch (_) {} }
      return res.status(200).json({ ok: true, expense: data });
    }
    const active = body.active === undefined ? true : !!body.active;
    const { data, error } = await supabase
      .from('fixed_expenses')
      .insert({ user_id: dataUserId, wb_account_id: wbAccountId, name, amount, active, created_at: now, updated_at: now })
      .select('id, name, amount, active')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    if (wsViewerId) { try { await audit({ event_type: 'team_cost_edit', user_id: wsViewerId,
      meta: { owner_id: dataUserId, expense_id: data.id, kind: 'fixed_expense', action: 'insert' }, req }); } catch (_) {} }
    return res.status(200).json({ ok: true, expense: data });
  }

  if (req.method === 'DELETE') {
    const id = req.query.id ? String(req.query.id) : null;
    if (!id) return res.status(400).json({ error: 'MISSING_ID' });
    const { data, error } = await supabase
      .from('fixed_expenses')
      .delete()
      .eq('id', id)
      .eq('user_id', dataUserId)
      .eq('wb_account_id', wbAccountId)
      .select('id');
    if (error) return res.status(500).json({ error: error.message });
    if (!data?.length) return res.status(404).json({ error: 'NOT_FOUND' });
    if (wsViewerId) { try { await audit({ event_type: 'team_cost_edit', user_id: wsViewerId,
      meta: { owner_id: dataUserId, expense_id: id, kind: 'fixed_expense', action: 'delete' }, req }); } catch (_) {} }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed for expenses' });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Нет токена' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Неверный токен' });

  // 🔥 Фаза D шаг2: оператор ЧИТАЕТ и ПИШЕТ себестоимость ВЛАДЕЛЬЦА (?workspace=).
  // Членство + активный Бизнес владельца проверяет resolveWorkspace. RLS не ослабляем (service-role + гейт).
  const workspace = req.query.workspace || null;
  let dataUserId = user.id;
  let wsViewerId = null;               // оператор (actor для audit team_cost_edit)
  if (workspace) {
    const ws = await resolveWorkspace(token, workspace);
    if (ws.error) return res.status(ws.status).json({ error: ws.error });
    if (ws.role === 'viewer') { dataUserId = ws.ownerId; wsViewerId = ws.viewerId; }
    // role==='owner' (workspace==self) → остаётся своё (dataUserId===user.id)
  }

  // 🔥 v0.7.7.30: разрешаем wb_account_id
  const providedWbId = req.query.wb_account_id
    || (req.body && req.body.wb_account_id)
    || null;
  const wbResolve = await resolveWbAccountId(dataUserId, providedWbId);
  if (!wbResolve.ok) {
    return res.status(wbResolve.status).json({ 
      error: wbResolve.error, 
      message: wbResolve.message 
    });
  }
  const wbAccountId = wbResolve.wb_account_id;

  if (req.method === 'GET' && req.query.resource !== 'expenses') {
    const { data, error } = await supabase
      .from('user_costs')
      .select('nm_id, cost, extra_per_unit')
      .eq('user_id', dataUserId)
      .eq('wb_account_id', wbAccountId);
    if (error) return res.status(500).json({ error: error.message });
    const map = {};
    const extras = {};   // 🔥 расходы-на-единицу (упаковка/маркировка), 0 не отдаём
    (data || []).forEach((r) => {
      map[r.nm_id] = Number(r.cost) || 0;
      const ex = Number(r.extra_per_unit) || 0;
      if (ex) extras[r.nm_id] = ex;
    });
    return res.status(200).json({ costs: map, extras, wb_account_id: wbAccountId });
  }

  // 🔥 v0.7.11.1: блок ИЗМЕНЕНИЯ себестоимостей для истёкших подписок (GET остаётся открытым).
  // Чтение своих сохранённых данных — право пользователя (terms «данные сохраняются»),
  // но обновление/удаление = активная работа → требует валидной подписки. Admin не блокируется.
  // 🔥 Фаза D шаг2: expired-чек по плану ОПЕРАТОРА — только для СВОЕГО пространства.
  // Для workspace-записи активность гарантирует resolveWorkspace (isActiveBusiness ВЛАДЕЛЬЦА).
  if (!workspace && (req.method === 'POST' || req.method === 'DELETE')) {
    try {
      const planResult = await getUserPlanWithLimits(token);
      if (!planResult.error && planResult.isExpired && !planResult.isAdmin) {
        return res.status(403).json({
          error: 'SUBSCRIPTION_EXPIRED',
          message: 'Ваша подписка закончилась — изменение себестоимостей недоступно. Просмотр сохранённых остаётся.'
        });
      }
    } catch (e) {
      console.warn('[costs] plan-check error:', e.message);
    }
  }

  // 🔥 Модуль «Расходы и налог» Часть 1: постоянные расходы (sub-router).
  // Размещено ПОСЛЕ expired-гейта → запись расходов тоже требует активной подписки (как себестоимость).
  if (req.query.resource === 'expenses') {
    return handleExpenses(req, res, { supabase, dataUserId, wbAccountId, wsViewerId });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const costs = body.costs || {};
    const extras = body.extras || {};   // 🔥 расходы-на-единицу (колонка extra_per_unit)
    const costKeys = Object.keys(costs);
    const extraKeys = Object.keys(extras);
    if (!costKeys.length && !extraKeys.length) return res.status(200).json({ saved: 0 });
    const now = new Date().toISOString();
    let savedCosts = 0, savedExtras = 0;

    // Себестоимость и extra_per_unit — РАЗДЕЛЬНЫЕ upsert-батчи: каждый трогает только свою
    // колонку (onConflict обновляет лишь переданные поля) → правка extras не затирает cost и наоборот.
    if (costKeys.length) {
      const rows = costKeys
        .map((k) => ({ user_id: dataUserId, wb_account_id: wbAccountId, nm_id: String(k), cost: Number(costs[k]) || 0, updated_at: now }))
        .filter((r) => r.cost >= 0);
      if (rows.length) {
        const { error } = await supabase.from('user_costs').upsert(rows, { onConflict: 'user_id,wb_account_id,nm_id' });
        if (error) return res.status(500).json({ error: error.message });
        savedCosts = rows.length;
      }
    }
    if (extraKeys.length) {
      const rows = extraKeys
        .map((k) => ({ user_id: dataUserId, wb_account_id: wbAccountId, nm_id: String(k), extra_per_unit: Number(extras[k]) || 0, updated_at: now }))
        .filter((r) => r.extra_per_unit >= 0);
      if (rows.length) {
        const { error } = await supabase.from('user_costs').upsert(rows, { onConflict: 'user_id,wb_account_id,nm_id' });
        if (error) return res.status(500).json({ error: error.message });
        savedExtras = rows.length;
      }
    }
    // 🔥 Фаза D шаг2: аудит правки данных ВЛАДЕЛЬЦА оператором (best-effort)
    if (wsViewerId) {
      try { await audit({ event_type: 'team_cost_edit', user_id: wsViewerId,
        meta: { owner_id: dataUserId, count: savedCosts + savedExtras, costs: savedCosts, extras: savedExtras }, req }); } catch (_) {}
    }
    return res.status(200).json({ saved: savedCosts + savedExtras, saved_costs: savedCosts, saved_extras: savedExtras, wb_account_id: wbAccountId });
  }

  if (req.method === 'DELETE') {
    const nm_id = req.query.nm_id;
    if (!nm_id) return res.status(400).json({ error: 'Нет nm_id' });
    const { error } = await supabase
      .from('user_costs')
      .delete()
      .eq('user_id', dataUserId)
      .eq('wb_account_id', wbAccountId)
      .eq('nm_id', String(nm_id));
    if (error) return res.status(500).json({ error: error.message });
    if (wsViewerId) {
      try { await audit({ event_type: 'team_cost_edit', user_id: wsViewerId,
        meta: { owner_id: dataUserId, nm_id: String(nm_id) }, req }); } catch (_) {}
    }
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
