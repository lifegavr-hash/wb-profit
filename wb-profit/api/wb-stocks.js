// /api/wb-stocks — прокси к WB statistics API за остатками.
// Кэшируется в Supabase на 1 час (остатки меняются медленно).

import crypto from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HAS_DB = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);

const CACHE_TTL_SEC = 15 * 60; // 15 минут (остатки меняются с каждой продажей)
const MIN_INTERVAL_MS = 65 * 1000; // тот же rate limit, что и в /api/wb

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
}

async function sbSelect(table, query) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!r.ok) return null;
  return r.json();
}

async function sbUpsert(table, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(body),
  });
  return r.ok;
}

async function getCache(key) {
  if (!HAS_DB) return null;
  const rows = await sbSelect('wb_cache', `cache_key=eq.${encodeURIComponent(key)}&select=payload,status,expires_at`);
  if (!rows || !rows.length) return null;
  if (new Date(rows[0].expires_at).getTime() < Date.now()) return null;
  return { status: rows[0].status, payload: rows[0].payload };
}

async function setCache(key, status, payload, ttl) {
  if (!HAS_DB) return;
  await sbUpsert('wb_cache', {
    cache_key: key,
    payload,
    status,
    fetched_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
  });
}

async function checkRateLimit(tokenHash) {
  if (!HAS_DB) return { allowed: true, retryAfterSec: 0 };
  const rows = await sbSelect('wb_rate_limit', `token_hash=eq.${tokenHash}&select=last_request_at`);
  if (!rows || !rows.length) return { allowed: true, retryAfterSec: 0 };
  const elapsed = Date.now() - new Date(rows[0].last_request_at).getTime();
  if (elapsed >= MIN_INTERVAL_MS) return { allowed: true, retryAfterSec: 0 };
  return { allowed: false, retryAfterSec: Math.ceil((MIN_INTERVAL_MS - elapsed) / 1000) };
}

async function markRequest(tokenHash) {
  if (!HAS_DB) return;
  await sbUpsert('wb_rate_limit', { token_hash: tokenHash, last_request_at: new Date().toISOString() });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'Токен не передан' });

  const tokenHash = hashToken(token);
  const cacheKey = `stocks:${tokenHash}`;
  // Отдельный ключ rate-limit, чтобы НЕ конфликтовать с /api/wb (sales).
  // WB считает лимиты по эндпоинту, у нас должно быть так же.
  const rlKey = `${tokenHash}:stocks`;

  // Кэш
  const cached = await getCache(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    res.status(cached.status);
    res.setHeader('Content-Type', 'application/json');
    return res.send(JSON.stringify(cached.payload));
  }

  // Rate limit (только в рамках этого эндпоинта)
  const rl = await checkRateLimit(rlKey);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfterSec));
    return res.status(429).json({ error: 'Подождите перед следующим запросом', retryAfter: rl.retryAfterSec });
  }
  await markRequest(rlKey);

  // Запрос к WB. Передаём dateFrom = вчера (формальное требование API).
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = `https://statistics-api.wildberries.ru/api/v1/supplier/stocks?dateFrom=${yesterday}`;

  try {
    // Таймаут 9 секунд (на Vercel Hobby лимит выполнения 10 сек)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 9000);
    const response = await fetch(url, { headers: { Authorization: token }, signal: controller.signal });
    clearTimeout(timeoutId);

    if (response.status === 429) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'WB rate limit', retryAfter: 60 });
    }
    if (response.status === 204) {
      await setCache(cacheKey, 200, [], CACHE_TTL_SEC);
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send('[]');
    }

    const text = await response.text();
    if (!response.ok) {
      res.status(response.status);
      res.setHeader('Content-Type', 'application/json');
      return res.send(text);
    }

    let payload;
    try { payload = JSON.parse(text); } catch { payload = []; }
    await setCache(cacheKey, 200, payload, CACHE_TTL_SEC);

    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(text);
  } catch (e) {
    if (e.name === 'AbortError') {
      return res.status(504).json({ error: 'WB не ответил за 9 секунд' });
    }
    res.status(500).json({ error: e.message });
  }
}
