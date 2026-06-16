// /api/wb — прокси к WB statistics API с кэшем и rate limit на токен.
// WB лимит: 1 запрос/мин на токен. Мы держим этот лимит сами и кэшируем прошлые дни.

import crypto from 'node:crypto';
import { extractJwt, checkPeriodLimit, sendIfPlanError } from '../lib/plan-check.js';
import { resolveWorkspace } from '../lib/team.js';
import { resolveWbAccountId } from '../lib/wb-account.js';
import { audit } from '../lib/audit-log.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HAS_DB = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);

// 🔥 v0.7.9.9: снижено с 65 до 15 сек. Это нужно для chunked-загрузки больших периодов
// (v0.7.9.8 разрезает >30 дней на куски). Реально WB API допускает burst-режим —
// 25 мая мы успешно загрузили 674 дня одной сессией, ни одного 429 от самого WB.
// 65 сек был "1 req/min" по WB-документации, но фактическая толерантность WB больше.
// При 15 сек: 6 кусков (152 дня) загружаются за ~1.5 мин вместо ~9 мин.
// Кэш в /api/wb (24 ч TTL для прошедших дней) дополнительно снижает реальные запросы к WB.
const MIN_INTERVAL_MS = 15 * 1000;

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
// 🔥 v0.6.10: maxDuration=60 сек (Vercel Hobby лимит).
// По дефолту serverless function убивается через 10 сек — на длинных периодах WB
// не успевает ответить и клиент получает 504. 60 сек хватает на самые большие запросы.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  let token = req.headers['authorization'];   // WB-токен своего кабинета
  let viewerCtx = null;                        // {ownerId, viewerId, ownerLimits} — оператор кабинета владельца
  // 🔥 Фаза D шаг1: оператор грузит данные ВЛАДЕЛЬЦА — pull токеном ВЛАДЕЛЬЦА (токен только на сервере, в ответ НЕ кладём).
  if (req.query.workspace) {
    const ws = await resolveWorkspace(extractJwt(req), req.query.workspace);
    if (ws.error) return res.status(ws.status).json({ error: ws.error });
    if (ws.role === 'viewer') {
      const acc = await resolveWbAccountId(ws.ownerId, req.query.wb_account_id || null);
      if (!acc.ok) return res.status(200).json([]);        // у владельца нет кабинета → пусто
      token = acc.account.wb_token;                         // СЕРВЕРНО: токен владельца (наружу не уходит)
      viewerCtx = { ownerId: ws.ownerId, viewerId: ws.viewerId, ownerLimits: ws.ownerLimits };
    }
    // ws.role==='owner' (workspace == свой id) → обычный путь со своим токеном
  }
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

  // === resource=cards — фото/бренд/название карточек товара (content API), СЕРВЕРНО (токен не на фронт) ===
  // 🔥 Слой1/B: курсорная пагинация content/v2/get/cards/list → карта nmID→{p,b,t,v}. Не зависит от периода.
  // Работает и для оператора (?workspace=): token уже = токен ВЛАДЕЛЬЦА (резолв выше). Долго живёт на клиенте.
  if (req.query.resource === 'cards') {
    try {
      const out = {};
      let cursor = null, pages = 0;
      const MAX_PAGES = 60; // потолок ~6000 карточек — не упираемся в maxDuration/лимит content API ~100/мин
      while (pages < MAX_PAGES) {
        const cur = { limit: 100 };
        if (cursor) { cur.updatedAt = cursor.updatedAt; cur.nmID = cursor.nmID; }
        const r = await fetch('https://content-api.wildberries.ru/content/v2/get/cards/list', {
          method: 'POST',
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: { cursor: cur, filter: { withPhoto: -1 } } }),
        });
        if (!r.ok) {
          const t = await r.text();
          if (pages === 0) return res.status(r.status).json({ error: 'CONTENT_API', status: r.status, message: String(t).slice(0, 200) });
          break; // частичный результат — отдаём что успели собрать
        }
        const data = await r.json();
        const cards = (data && data.cards) || [];
        for (const c of cards) {
          if (c.nmID == null) continue;
          const ph = (c.photos && c.photos[0]) || null;
          const photo = ph ? (ph.c246x328 || ph.square || ph.tm || ph.big || '') : '';
          out[c.nmID] = { p: photo, b: c.brand || '', t: c.title || '', v: c.vendorCode || '' };
        }
        pages++;
        const cc = (data && data.cursor) || {};
        if (cards.length < 100 || cc.nmID == null) break;
        cursor = { updatedAt: cc.updatedAt, nmID: cc.nmID };
      }
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
      return res.status(200).json({ cards: out, pages });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const { dateFrom, dateTo, rrdid = 0 } = req.query;
  if (!dateFrom || !dateTo) return res.status(400).json({ error: 'Укажите dateFrom и dateTo' });

  // ─── Проверка тарифа ───
  // 🔥 Фаза D шаг1: для ОПЕРАТОРА лимит периода и активность — по плану ВЛАДЕЛЬЦА (не участника).
  // Активность владельца (Бизнес && !expired) уже проверена в resolveWorkspace.
  if (viewerCtx) {
    const days = Math.round((new Date(dateTo).getTime() - new Date(dateFrom).getTime()) / (24 * 60 * 60 * 1000)) + 1;
    const maxDays = viewerCtx.ownerLimits?.max_period_days;
    if (maxDays && days > maxDays) {
      return res.status(403).json({
        error: 'PERIOD_LIMIT',
        message: `Период ${days} дней превышает лимит тарифа владельца (до ${maxDays} дней)`,
        maxDays,
      });
    }
  } else
  // v0.7.1: используем лимит max_period_days из таблицы plans, а не хардкод.
  // Free/Start: 30 дней / PRO/Business: 365. JWT в X-User-Auth (Authorization занят WB-токеном).
  try {
    const jwt = extractJwt(req);
    if (jwt) {
      const check = await checkPeriodLimit(jwt, dateFrom, dateTo);
      if (check.error) {
        // PERIOD_LIMIT → 403 с понятным сообщением для фронта
        if (sendIfPlanError(res, check)) return;
      }
      // 🔥 v0.7.11.1: блокируем свежие WB-данные для истёкших подписок.
      // checkPeriodLimit при успехе возвращает все поля плана включая isExpired/isAdmin —
      // переиспользуем результат, не делая второй round-trip. Период уже проверен выше.
      if (check.isExpired && !check.isAdmin) {
        return res.status(403).json({
          error: 'SUBSCRIPTION_EXPIRED',
          message: 'Ваша подписка закончилась — свежие данные не поступают. Ваши сохранённые данные доступны для просмотра.'
        });
      }
    } else {
      // Если JWT нет — анонимный пробный режим, ограничиваем как Free (30 дней max)
      const fromMs = new Date(dateFrom).getTime();
      const toMs = new Date(dateTo).getTime();
      const days = Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000)) + 1;
      if (days > 30) {
        return res.status(403).json({
          error: 'PERIOD_LIMIT',
          message: `Период ${days} дней доступен только авторизованным пользователям. Войдите в аккаунт.`,
          maxDays: 30,
        });
      }
    }
  } catch (e) {
    // Failsafe: если что-то сломалось — пропускаем (не хотим блокировать всех из-за бага)
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

  // 🔥 Фаза D шаг1: аудит pull кабинета владельца оператором (best-effort, не блокирует)
  if (viewerCtx) {
    try { await audit({ event_type: 'team_data_pull', user_id: viewerCtx.viewerId,
      meta: { owner_id: viewerCtx.ownerId, df: dateFrom, dt: dateTo }, req }); } catch (_) {}
  }

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
