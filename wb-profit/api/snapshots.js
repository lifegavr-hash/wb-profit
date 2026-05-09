// /api/snapshots
// POST: { snapshots: [{day, sales_count, ...}, ...] }  — сохранить снапшоты
// GET  ?days=7                                        — отдать последние N дней

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Нет токена' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Неверный токен' });

  if (req.method === 'GET') {
    const days = Math.min(parseInt(req.query.days || '7', 10), 90);
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceIso = since.toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from('daily_snapshots')
      .select('*')
      .eq('user_id', user.id)
      .gte('day', sinceIso)
      .order('day', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ snapshots: data || [] });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const snapshots = Array.isArray(body.snapshots) ? body.snapshots : [];
    if (!snapshots.length) return res.status(400).json({ error: 'snapshots пустой' });

    const rows = snapshots.map((s) => ({
      user_id: user.id,
      day: s.day,
      sales_count: s.sales_count || 0,
      returns_count: s.returns_count || 0,
      revenue: s.revenue || 0,
      commission: s.commission || 0,
      payout: s.payout || 0,
      logistics: s.logistics || 0,
      storage: s.storage || 0,
      ads: s.ads || 0,
      penalties: s.penalties || 0,
      wb_finance: s.wb_finance || 0,
      cost: s.cost || 0,
      profit: s.profit || 0,
      top_items: s.top_items || [],
      alerts: s.alerts || [],
      source: s.source || 'calc',
      updated_at: new Date().toISOString(),
    }));

    // Upsert по PK (user_id, day)
    const { error } = await supabase
      .from('daily_snapshots')
      .upsert(rows, { onConflict: 'user_id,day' });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true, saved: rows.length });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
