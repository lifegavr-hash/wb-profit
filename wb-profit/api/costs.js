// /api/costs — себестоимости товаров пользователя
// GET   — вернуть { costs: { nm_id: cost, ... } }
// POST  — { costs: { nm_id: cost, ... } } — upsert батчем
// DELETE — ?nm_id=... — удалить одну запись

import { createClient } from '@supabase/supabase-js';

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

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('user_costs')
      .select('nm_id, cost')
      .eq('user_id', user.id);
    if (error) return res.status(500).json({ error: error.message });
    const map = {};
    (data || []).forEach((r) => { map[r.nm_id] = Number(r.cost) || 0; });
    return res.status(200).json({ costs: map });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const costs = body.costs || {};
    const keys = Object.keys(costs);
    if (!keys.length) return res.status(200).json({ saved: 0 });
    const rows = keys
      .map((k) => ({
        user_id: user.id,
        nm_id: String(k),
        cost: Number(costs[k]) || 0,
        updated_at: new Date().toISOString(),
      }))
      .filter((r) => r.cost >= 0);
    // upsert батчем
    const { error } = await supabase
      .from('user_costs')
      .upsert(rows, { onConflict: 'user_id,nm_id' });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ saved: rows.length });
  }

  if (req.method === 'DELETE') {
    const nm_id = req.query.nm_id;
    if (!nm_id) return res.status(400).json({ error: 'Нет nm_id' });
    const { error } = await supabase
      .from('user_costs')
      .delete()
      .eq('user_id', user.id)
      .eq('nm_id', String(nm_id));
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
