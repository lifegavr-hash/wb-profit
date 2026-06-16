// /api/costs — себестоимости товаров пользователя
// GET   ?wb_account_id=xxx              — { costs: { nm_id: cost, ... } }
// POST  { costs: {...}, wb_account_id }  — upsert батчем
// DELETE ?nm_id=...&wb_account_id=xxx    — удалить одну запись
//
// v0.7.7.30: данные разделены по wb_account_id.

import { createClient } from '@supabase/supabase-js';
import { resolveWbAccountId } from '../lib/wb-account.js';
import { getUserPlanWithLimits } from '../lib/plan-check.js';
import { resolveWorkspace } from '../lib/team.js';
import { audit } from '../lib/audit-log.js';

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

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('user_costs')
      .select('nm_id, cost')
      .eq('user_id', dataUserId)
      .eq('wb_account_id', wbAccountId);
    if (error) return res.status(500).json({ error: error.message });
    const map = {};
    (data || []).forEach((r) => { map[r.nm_id] = Number(r.cost) || 0; });
    return res.status(200).json({ costs: map, wb_account_id: wbAccountId });
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

  if (req.method === 'POST') {
    const body = req.body || {};
    const costs = body.costs || {};
    const keys = Object.keys(costs);
    if (!keys.length) return res.status(200).json({ saved: 0 });
    const rows = keys
      .map((k) => ({
        user_id: dataUserId,
        wb_account_id: wbAccountId,
        nm_id: String(k),
        cost: Number(costs[k]) || 0,
        updated_at: new Date().toISOString(),
      }))
      .filter((r) => r.cost >= 0);
    // onConflict теперь по (user_id, wb_account_id, nm_id)
    const { error } = await supabase
      .from('user_costs')
      .upsert(rows, { onConflict: 'user_id,wb_account_id,nm_id' });
    if (error) return res.status(500).json({ error: error.message });
    // 🔥 Фаза D шаг2: аудит правки себестоимости ВЛАДЕЛЬЦА оператором (best-effort)
    if (wsViewerId) {
      try { await audit({ event_type: 'team_cost_edit', user_id: wsViewerId,
        meta: { owner_id: dataUserId, count: rows.length, nm_ids: keys.slice(0, 20) }, req }); } catch (_) {}
    }
    return res.status(200).json({ saved: rows.length, wb_account_id: wbAccountId });
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
