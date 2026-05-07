import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code, userId } = req.body;
  if (!code || !userId) return res.status(400).json({ error: 'Укажите code и userId' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: promo, error: promoError } = await supabase
    .from('promo_codes').select('*').eq('code', code.toUpperCase()).eq('is_active', true).single();

  if (promoError || !promo) return res.status(404).json({ error: 'Промокод не найден или недействителен' });
  if (promo.used_count >= promo.max_uses) return res.status(400).json({ error: 'Промокод использован максимальное количество раз' });

  const { data: existing } = await supabase.from('promo_uses').select('id').eq('promo_id', promo.id).eq('user_id', userId).single();
  if (existing) return res.status(400).json({ error: 'Вы уже использовали этот промокод' });

  const expires = new Date();
  expires.setDate(expires.getDate() + promo.days);

  await supabase.from('promo_uses').insert({ promo_id: promo.id, user_id: userId });
  await supabase.from('promo_codes').update({ used_count: promo.used_count + 1 }).eq('id', promo.id);
  await supabase.from('profiles').update({ plan: promo.plan, plan_expires_at: expires.toISOString() }).eq('id', userId);

  return res.status(200).json({ success: true, plan: promo.plan, days: promo.days });
}
