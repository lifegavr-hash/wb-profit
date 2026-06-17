// /api/wb-stocks — прокси к WB statistics API за остатками.
// 🔥 v0.7.12.80: кэш остатков вынесен из Postgres (wb_cache) в Redis (Upstash) — как отчёты в v71-72.
// Тот же CACHE_BACKEND (redis|supabase|off, дефолт supabase), KV_REST_API_*, gzip, best-effort.
// Готовит дроп wb_cache: при CACHE_BACKEND=redis остатки в Postgres больше НЕ пишутся.

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { extractJwt, getUserPlanWithLimits } from '../lib/plan-check.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HAS_DB = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
// Redis (Upstash REST) — те же env, что в api/wb.js (KV_REST_API_*, fallback UPSTASH_*; НЕ KV_URL/REDIS_URL — те TCP).
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const HAS_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);
const CACHE_BACKEND = (process.env.CACHE_BACKEND === 'redis' && HAS_REDIS) ? 'redis'
  : (process.env.CACHE_BACKEND === 'off' ? 'off' : 'supabase');

const CACHE_TTL_SEC = 15 * 60; // 15 минут (остатки меняются с каждой продажей)
const MIN_INTERVAL_MS = 65 * 1000; // тот же rate limit, что и в /api/wb

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
}

// best-effort fetch с таймаутом (внешний вызов не держит serverless-функцию).
function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 4000);
  return fetch(url, { ...(opts || {}), signal: ctrl.signal }).finally(() => clearTimeout(t));
}
// Upstash Redis REST (command-array). Транспортная ошибка → {ok:false} (деградируем, не виснем).
async function redisCmd(args, ms) {
  try {
    const r = await fetchWithTimeout(REDIS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    }, ms || 3000);
    if (!r.ok) return { ok: false };
    const d = await r.json();
    return { ok: true, result: (d && 'result' in d) ? d.result : null };
  } catch (e) { return { ok: false }; }
}
function gzB64(obj) { return zlib.gzipSync(Buffer.from(JSON.stringify(obj))).toString('base64'); }
function ungzB64(b64) { try { return JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString()); } catch (e) { return null; } }

// === Supabase REST helpers (best-effort, для fallback CACHE_BACKEND=supabase) ===
async function sbSelect(table, query) {
  try {
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    }, 4000);
    if (!r.ok) return null;
    return r.json();
  } catch (e) { return null; }
}

async function sbUpsert(table, body) {
  try {
    const r = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(body),
    }, 4000);
    return r.ok;
  } catch (e) { return false; }
}

// === Cache (диспетчер по CACHE_BACKEND, идентично api/wb.js) ===
async function getCache(key) {
  if (CACHE_BACKEND === 'off') return null;
  if (CACHE_BACKEND === 'redis') {
    const c = await redisCmd(['GET', `wbc:${key}`]);
    if (!c.ok || c.result == null) return null;   // Redis недоступен/промах → cache miss
    return ungzB64(c.result);                       // { status, payload } | null
  }
  if (!HAS_DB) return null;
  const rows = await sbSelect('wb_cache', `cache_key=eq.${encodeURIComponent(key)}&select=payload,status,expires_at`);
  if (!rows || !rows.length) return null;
  if (new Date(rows[0].expires_at).getTime() < Date.now()) return null;
  return { status: rows[0].status, payload: rows[0].payload };
}

async function setCache(key, status, payload, ttl) {
  if (CACHE_BACKEND === 'off') return;
  if (CACHE_BACKEND === 'redis') {
    await redisCmd(['SET', `wbc:${key}`, gzB64({ status, payload }), 'EX', String(ttl)]); // ошибка SET → no-op (best-effort)
    return;
  }
  if (!HAS_DB) return;
  await sbUpsert('wb_cache', {
    cache_key: key,
    payload,
    status,
    fetched_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
  });
}

// === Rate limit (per token+endpoint) ===
async function checkRateLimit(tokenHash) {
  if (CACHE_BACKEND === 'off') return { allowed: true, retryAfterSec: 0 };
  if (CACHE_BACKEND === 'redis') {
    // Атомарно: SET NX EX — OK → разрешено и сразу помечено; null → недавно был запрос.
    const ttl = Math.ceil(MIN_INTERVAL_MS / 1000);
    const c = await redisCmd(['SET', `wbrl:${tokenHash}`, '1', 'EX', String(ttl), 'NX']);
    if (!c.ok) return { allowed: true, retryAfterSec: 0 };                  // Redis недоступен → разрешаем (деградируем)
    if (c.result === null) return { allowed: false, retryAfterSec: ttl };   // ключ уже есть → лимит
    return { allowed: true, retryAfterSec: 0 };                             // SET прошёл → разрешено + помечено
  }
  if (!HAS_DB) return { allowed: true, retryAfterSec: 0 };
  const rows = await sbSelect('wb_rate_limit', `token_hash=eq.${tokenHash}&select=last_request_at`);
  if (!rows || !rows.length) return { allowed: true, retryAfterSec: 0 };
  const elapsed = Date.now() - new Date(rows[0].last_request_at).getTime();
  if (elapsed >= MIN_INTERVAL_MS) return { allowed: true, retryAfterSec: 0 };
  return { allowed: false, retryAfterSec: Math.ceil((MIN_INTERVAL_MS - elapsed) / 1000) };
}

async function markRequest(tokenHash) {
  if (CACHE_BACKEND === 'redis' || CACHE_BACKEND === 'off') return;  // redis: помечено атомарно в checkRateLimit (SET NX)
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

  // 🔥 v0.7.11.1: блок свежих WB-данных для истёкших подписок (admin не блокируется).
  // JWT в X-User-Auth (Authorization занят WB-токеном). Если JWT не передан —
  // fail-open: не блокируем (анонимный/legacy-вызов, существующее поведение сохраняется).
  try {
    const jwt = extractJwt(req);
    if (jwt) {
      const planResult = await getUserPlanWithLimits(jwt);
      if (!planResult.error && planResult.isExpired && !planResult.isAdmin) {
        return res.status(403).json({
          error: 'SUBSCRIPTION_EXPIRED',
          message: 'Ваша подписка закончилась — свежие данные не поступают. Ваши сохранённые данные доступны для просмотра.'
        });
      }
    }
  } catch (e) {
    console.warn('[wb-stocks] plan-check error:', e.message);
  }

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

  // 🔥 v0.7.12.78: dateFrom ФИЛЬТРУЕТ по lastChangeDate (НЕ формальность!). WB отдаёт только
  // записи с lastChangeDate >= dateFrom. С dateFrom=вчера выпадали «тихие» склады (без движения
  // за сутки) → остаток занижался (мяч 390 вместо 596). Давняя дата (офиц. пример WB) → весь остаток.
  const url = `https://statistics-api.wildberries.ru/api/v1/supplier/stocks?dateFrom=2019-06-20`;

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
