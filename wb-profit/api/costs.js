// /api/costs — себестоимости товаров пользователя
// GET   ?wb_account_id=xxx              — { costs: { nm_id: cost, ... } }
// POST  { costs: {...}, wb_account_id }  — upsert батчем
// DELETE ?nm_id=...&wb_account_id=xxx    — удалить одну запись
//
// v0.7.7.30: данные разделены по wb_account_id.

import { createClient } from '@supabase/supabase-js';
import { resolveWbAccountId } from '../lib/wb-account.js';

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

  // 🔥 v0.7.7.30: разрешаем wb_account_id
  const providedWbId = req.query.wb_account_id 
    || (req.body && req.body.wb_account_id) 
    || null;
  const wbResolve = await resolveWbAccountId(user.id, providedWbId);
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
      .eq('user_id', user.id)
      .eq('wb_account_id', wbAccountId);
    if (error) return res.status(500).json({ error: error.message });
    const map = {};
    (data || []).forEach((r) => { map[r.nm_id] = Number(r.cost) || 0; });
    return res.status(200).json({ costs: map, wb_account_id: wbAccountId });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const costs = body.costs || {};
    const keys = Object.keys(costs);
    if (!keys.length) return res.status(200).json({ saved: 0 });
    const rows = keys
      .map((k) => ({
        user_id: user.id,
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
    return res.status(200).json({ saved: rows.length, wb_account_id: wbAccountId });
  }

  if (req.method === 'DELETE') {
    const nm_id = req.query.nm_id;
    if (!nm_id) return res.status(400).json({ error: 'Нет nm_id' });
    const { error } = await supabase
      .from('user_costs')
      .delete()
      .eq('user_id', user.id)
      .eq('wb_account_id', wbAccountId)
      .eq('nm_id', String(nm_id));
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
