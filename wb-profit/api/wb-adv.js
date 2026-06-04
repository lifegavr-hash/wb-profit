import { extractJwt, getUserPlanWithLimits } from '../lib/plan-check.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'Токен не передан' });

  // 🔥 v0.7.11.1: блок свежих WB-данных рекламы для истёкших подписок (admin исключён).
  // JWT в X-User-Auth. fail-open если JWT не передан.
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
    console.warn('[wb-adv] plan-check error:', e.message);
  }

  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Укажите from и to' });

  let totalSpend = 0;
  const byNm = {};

  try {
    // Собираем кампании всех статусов: активные, на паузе, завершённые
    let allIds = [];
    for (const status of [4, 7, 9, 11]) {
      try {
        const r = await fetch(
          `https://advert-api.wildberries.ru/adv/v1/promotion/adverts?status=${status}&limit=1000`,
          { headers: { Authorization: token } }
        );
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data)) {
            allIds = allIds.concat(data.map(c => c.advertId).filter(Boolean));
          }
        }
      } catch(e) {}
    }

    // Получаем статистику по каждой кампании
    if (allIds.length > 0) {
      for (let i = 0; i < allIds.length; i += 100) {
        const chunk = allIds.slice(i, i + 100);
        try {
          const r = await fetch(
            'https://advert-api.wildberries.ru/adv/v2/fullstats',
            {
              method: 'POST',
              headers: { Authorization: token, 'Content-Type': 'application/json' },
              body: JSON.stringify(chunk.map(id => ({ id, dates: [from, to] })))
            }
          );
          if (r.ok) {
            const stats = await r.json();
            for (const s of (stats || [])) {
              for (const d of (s.days || [])) {
                totalSpend += d.sum || 0;
                for (const app of (d.apps || [])) {
                  for (const nm of (app.nm || [])) {
                    if (!byNm[nm.nmId]) byNm[nm.nmId] = 0;
                    byNm[nm.nmId] += nm.sum || 0;
                  }
                }
              }
            }
          }
        } catch(e) {}
      }
    }

    // Резервный метод — общие расходы через /upd
    if (totalSpend === 0) {
      try {
        const r = await fetch(
          `https://advert-api.wildberries.ru/adv/v1/upd?from=${from}&to=${to}`,
          { headers: { Authorization: token } }
        );
        if (r.ok) {
          const data = await r.json();
          for (const d of (data || [])) totalSpend += d.updSum || 0;
        }
      } catch(e) {}
    }

    return res.status(200).json({ totalSpend, byNm });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
