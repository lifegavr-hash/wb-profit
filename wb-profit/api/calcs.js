// /api/calcs — CRUD истории подборов товаров
// GET    — список всех подборов пользователя
// POST   — создать или обновить (если есть id)
// DELETE — удалить (нужен ?id=...)

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
      .from('unit_calc_history')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ calcs: data || [] });
  }

  if (req.method === 'POST') {
    const b = req.body || {};
    const row = {
      user_id: user.id,
      name: String(b.name || 'Без названия').slice(0, 200),
      category: b.category || null,
      retail_price: Number(b.retail_price) || 0,
      cost_price: Number(b.cost_price) || 0,
      cost_currency: b.cost_currency || 'RUB',
      cost_rate: Number(b.cost_rate) || 1,
      weight_kg: Number(b.weight_kg) || 0,
      volume_l: Number(b.volume_l) || 0,
      commission_pct: Number(b.commission_pct) || 0,
      logistics_rub: Number(b.logistics_rub) || 0,
      storage_rub: Number(b.storage_rub) || 0,
      tax_pct: Number(b.tax_pct) || 7,
      redemption_pct: Number(b.redemption_pct) || 80,
      ad_pct: Number(b.ad_pct) || 5,
      profit: Number(b.profit) || 0,
      margin_pct: Number(b.margin_pct) || 0,
      roi_pct: Number(b.roi_pct) || 0,
      updated_at: new Date().toISOString(),
    };
    if (b.id) {
      const { data, error } = await supabase
        .from('unit_calc_history')
        .update(row)
        .eq('id', b.id)
        .eq('user_id', user.id)
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ calc: data });
    } else {
      const { data, error } = await supabase
        .from('unit_calc_history')
        .insert(row)
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ calc: data });
    }
  }

  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'Нет id' });
    const { error } = await supabase
      .from('unit_calc_history')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
