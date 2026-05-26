// /api/plans — возвращает список тарифов из БД (источник истины)
// Кэшируется на 5 минут чтобы не дёргать БД на каждый просмотр карточек

const SUPABASE_URL = process.env.SUPABASE_URL;
// 🔥 Vercel может иметь публичный ключ под разными именами — пробуем все
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY
                  || process.env.SUPABASE_ANON_KEY
                  || process.env.SUPABASE_SERVICE_ROLE_KEY;

let _cache = null;
let _cacheExpiry = 0;
const CACHE_MS = 5 * 60 * 1000; // 5 минут

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[api/plans] missing env: SUPABASE_URL or SUPABASE_KEY');
    return res.status(500).json({ error: 'Server misconfigured: env vars missing' });
  }

  // Кэш
  if (_cache && Date.now() < _cacheExpiry) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json(_cache);
  }

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/plans?select=*&order=sort_order.asc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!r.ok) {
      const text = await r.text();
      console.error('[api/plans] supabase error:', r.status, text);
      return res.status(500).json({ error: 'Failed to load plans' });
    }
    const plans = await r.json();
    _cache = { plans };
    _cacheExpiry = Date.now() + CACHE_MS;
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json(_cache);
  } catch (e) {
    console.error('[api/plans] error:', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
