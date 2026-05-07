import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Нет токена' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Неверный токен' });

  const { data: profile } = await supabase.from('profiles').select('is_admin').eq('id', user.id).single();
  if (!profile?.is_admin) return res.status(403).json({ error: 'Нет доступа' });

  if (req.method === 'GET') {
    const { data: promos } = await supabase.from('promo_codes').select('*').order('created_at', { ascending: false });
    const { data: users } = await supabase.from('profiles').select('*').order('created_at', { ascending: false });
    return res.status(200).json({ promos, users });
  }

  if (req.method === 'POST') {
    const { action, code, plan, days, maxUses, id } = req.body;
    if (action === 'create_promo') {
      const { data, error: err } = await supabase.from('promo_codes').insert({
        code: code.toUpperCase(), plan, days, max_uses: maxUses
      }).select().single();
      if (err) return res.status(400).json({ error: err.message });
      return res.status(200).json({ success: true, promo: data });
    }
    if (action === 'deactivate_promo') {
      await supabase.from('promo_codes').update({ is_active: false }).eq('id', id);
      return res.status(200).json({ success: true });
    }
  }
}
