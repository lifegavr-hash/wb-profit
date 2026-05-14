// /api/wb — прокси к WB statistics API с кэшем и rate limit на токен.
// WB лимит: 1 запрос/мин на токен. Мы держим этот лимит сами и кэшируем прошлые дни.

import crypto from 'node:crypto';
import { extractJwt, getUserPlan, sendIfPlanError } from '../lib/plan-check.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HAS_DB = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);

// Окно между запросами к WB на один токен. WB говорит «1/мин», берём 65 сек на всякий.
const MIN_INTERVAL_MS = 65 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
}

function isPastDay(dateIso) {
  // Москва = UTC+3. День считается прошедшим, если он раньше сегодня по MSK.
  const now = new Date();
  const msk = new Date(now.getTime() + (3 * 60 + now.getTimezoneOffset()) * 60000);
  const today = msk.toISOString().slice(0, 10);
  return dateIso < today;
}

// === Supabase REST helpers ===
async function sbSelect(table, query) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
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

// === Cache ===
async function getCache(cacheKey) {
  if (!HAS_DB) return null;
  const rows = await sbSelect('wb_cache', `cache_key=eq.${encodeURIComponent(cacheKey)}&select=payload,status,expires_at`);
  if (!rows || !rows.length) return null;
  const row = rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return { status: row.status, payload: row.payload };
}

async function setCache(cacheKey, status, payload, ttlSeconds) {
  if (!HAS_DB) return;
  const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await sbUpsert('wb_cache', {
    cache_key: cacheKey,
    payload,
    status,
    fetched_at: new Date().toISOString(),
    expires_at: expires,
  });
}

// === Rate limit (per token) ===
async function checkRateLimit(tokenHash) {
  // Возвращает { allowed: bool, retryAfterSec: number }
  if (!HAS_DB) return { allowed: true, retryAfterSec: 0 };
  const rows = await sbSelect('wb_rate_limit', `token_hash=eq.${tokenHash}&select=last_request_at`);
  if (!rows || !rows.length) return { allowed: true, retryAfterSec: 0 };
  const last = new Date(rows[0].last_request_at).getTime();
  const elapsed = Date.now() - last;
  if (elapsed >= MIN_INTERVAL_MS) return { allowed: true, retryAfterSec: 0 };
  return { allowed: false, retryAfterSec: Math.ceil((MIN_INTERVAL_MS - elapsed) / 1000) };
}

async function markRequest(tokenHash) {
  if (!HAS_DB) return;
  await sbUpsert('wb_rate_limit', {
    token_hash: tokenHash,
    last_request_at: new Date().toISOString(),
  });
}

// === Handler ===
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'Токен не передан' });

  // === action=seller — вернуть инфу о селлере (имя/бренд) ===
  // Используем в Главной для приветствия «Здравствуйте, Чиркова А. В.»
  if (req.query.action === 'seller') {
    try {
      const r = await fetch('https://common-api.wildberries.ru/api/v1/seller-info', {
        headers: { Authorization: token },
      });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate'); // 1 day
      return res.status(r.status).json(body);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const { dateFrom, dateTo, rrdid = 0 } = req.query;
  if (!dateFrom || !dateTo) return res.status(400).json({ error: 'Укажите dateFrom и dateTo' });

  // ─── Проверка тарифа ───
  // Если период > 7 дней — требуем PRO. JWT берём из X-User-Auth (Authorization занят WB-токеном).
  try {
    const fromMs = new Date(dateFrom).getTime();
    const toMs = new Date(dateTo).getTime();
    const days = Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000)) + 1;
    if (days > 7) {
      const jwt = extractJwt(req);
      const plan = await getUserPlan(jwt);
      if (plan.error) {
        if (sendIfPlanError(res, plan)) return;
      }
      if (!plan.hasPro) {
        return res.status(403).json({
          error: 'PRO_REQUIRED',
          message: `Период ${days} дней доступен только на тарифе PRO. Бесплатно — до 7 дней.`,
          feature: `Период ${days} дней`,
        });
      }
    }
  } catch (e) {
    // Если что-то сломалось в проверке тарифа — НЕ блокируем запрос (failsafe).
    console.warn('[wb] plan-check error:', e.message);
  }

  const tokenHash = hashToken(token);
  const cacheKey = `${tokenHash}:${dateFrom}:${dateTo}:${rrdid}`;

  // 1) Кэш
  const cached = await getCache(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    res.status(cached.status);
    res.setHeader('Content-Type', 'application/json');
    return res.send(JSON.stringify(cached.payload));
  }
  res.setHeader('X-Cache', 'MISS');

  // 2) Rate limit на токен
  const rl = await checkRateLimit(tokenHash);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfterSec));
    res.setHeader('X-Rate-Limit', 'queued');
    return res.status(429).json({
      error: 'Подождите перед следующим запросом',
      retryAfter: rl.retryAfterSec,
    });
  }

  // 3) Помечаем заранее, чтобы параллельные вызовы получили 429 (а не пробивали лимит)
  await markRequest(tokenHash);

  // 4) Запрос к WB
  const url = `https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod?dateFrom=${dateFrom}&dateTo=${dateTo}&rrdid=${rrdid}&period=daily&limit=100000`;

  try {
    const response = await fetch(url, { headers: { Authorization: token } });

    // 204 — нет данных. Кэшируем тоже (на сутки если день прошедший).
    if (response.status === 204) {
      const ttl = isPastDay(dateTo) ? 24 * 3600 : 5 * 60;
      await setCache(cacheKey, 204, [], ttl);
      res.setHeader('Content-Type', 'application/json');
      return res.status(204).send('');
    }

    const text = await response.text();

    // 429 от WB — пробрасываем
    if (response.status === 429) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'WB rate limit', retryAfter: 60 });
    }

    if (!response.ok) {
      // Не кэшируем ошибки
      res.status(response.status);
      res.setHeader('Content-Type', 'application/json');
      return res.send(text);
    }

    // 200 — парсим, кладём в кэш
    let payload;
    try { payload = JSON.parse(text); } catch { payload = []; }
    const ttl = isPastDay(dateTo) ? 24 * 3600 : 5 * 60;
    await setCache(cacheKey, 200, payload, ttl);

    res.status(200);
    res.setHeader('Content-Type', 'application/json');
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
