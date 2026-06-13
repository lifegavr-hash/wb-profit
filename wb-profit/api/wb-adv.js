// /api/wb-adv — прокси к WB advert-api за разбивкой расходов на рекламу.
//
// v0.7.12.5: расширен ответ. Возвращаем (back-compat):
//   { totalSpend, byNm } — как было раньше
//   + byCampaign: [{id, name, status, statusLabel, spend, nm_ids}]
//   + byDay:      [{day, spend}]
//   + noAccess:   true|false — true если promotion/adverts вернул 401/403
//                              (нет права «Продвижение» у токена)
// Старые поля не меняются — если кто-то ещё зовёт endpoint в прежнем формате,
// он продолжит работать как раньше.

import { extractJwt, getUserPlanWithLimits } from '../lib/plan-check.js';

// Маппинг статусов кампаний WB advert-api (по официальной документации)
const STATUS_LABEL = {
  4:  'Активна',
  7:  'Завершена',
  9:  'Приостановлена',
  11: 'Готова к запуску',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'Токен не передан' });

  // 🔥 v0.7.11.1: блок свежих WB-данных рекламы для истёкших подписок (admin исключён).
  // 🔥 v0.7.12.45 (Фаза B): /api/wb-adv эксклюзивно питает рекламную разбивку Аналитики
  //   (единственный вызыватель — loadAnalytics → getOrLoadAdsCampaigns, шлёт X-User-Auth).
  //   Поэтому здесь — настоящий серверный enforce фичи analytics, fail-closed:
  //   нет валидного JWT → 403 (голый запрос больше не обходит гейт).
  //   isExpired-проверка ниже сохранена 1-в-1; на ИНФРА-ошибке (catch) — fail-open, как было.
  const jwt = extractJwt(req);
  if (!jwt) {
    return res.status(403).json({
      error: 'FEATURE_REQUIRED', feature: 'analytics',
      message: 'Аналитика доступна на тарифах PRO и Бизнес'
    });
  }
  try {
    const planResult = await getUserPlanWithLimits(jwt);
    // нет валидного плана (невалидный JWT / профиль не найден) → fail-closed для фичи
    if (planResult.error) {
      return res.status(403).json({
        error: 'FEATURE_REQUIRED', feature: 'analytics',
        message: 'Аналитика доступна на тарифах PRO и Бизнес'
      });
    }
    // expired — поведение как было (срабатывает только для истёкших, admin исключён)
    if (planResult.isExpired && !planResult.isAdmin) {
      return res.status(403).json({
        error: 'SUBSCRIPTION_EXPIRED',
        message: 'Ваша подписка закончилась — свежие данные не поступают. Ваши сохранённые данные доступны для просмотра.'
      });
    }
    // гейт фичи analytics (admin байпас): Старт / тариф без analytics → 403
    if (!planResult.isAdmin && !planResult.features?.analytics) {
      return res.status(403).json({
        error: 'FEATURE_REQUIRED', feature: 'analytics',
        message: 'Аналитика доступна на тарифах PRO и Бизнес'
      });
    }
  } catch (e) {
    console.warn('[wb-adv] plan-check error:', e.message);
    // fail-open на ИНФРА-ошибке плана — сохраняем прежнее поведение isExpired-проверки, скоуп не расширяем
  }

  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Укажите from и to' });

  let totalSpend = 0;
  const byNm = {};
  const campaignMeta = {};        // id → {name, status}
  const byCampaignMap = {};       // id → {spend, nm_ids:Set}
  const byDayMap = {};             // 'YYYY-MM-DD' → spend
  // 🔥 v0.7.12.5: если ВСЕ запросы promotion/adverts вернули 401/403 — значит
  // у токена нет права «Продвижение». Отвечаем 200 с noAccess:true, чтобы фронт
  // показал понятную подсказку, а не «упс, ошибка».
  let advertsCallsMade = 0;
  let advertsCallsForbidden = 0;

  try {
    // 1) Собираем кампании всех статусов: активные, завершённые, на паузе, готовы к запуску.
    let allIds = [];
    for (const status of [4, 7, 9, 11]) {
      try {
        const r = await fetch(
          `https://advert-api.wildberries.ru/adv/v1/promotion/adverts?status=${status}&limit=1000`,
          { headers: { Authorization: token } }
        );
        advertsCallsMade++;
        if (r.status === 401 || r.status === 403) {
          advertsCallsForbidden++;
          continue;
        }
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data)) {
            for (const c of data) {
              if (!c || !c.advertId) continue;
              allIds.push(c.advertId);
              campaignMeta[c.advertId] = {
                name: c.name || ('Кампания #' + c.advertId),
                status: c.status ?? status,
              };
            }
          }
        }
      } catch(e) { /* network — пробуем следующий статус */ }
    }

    // Если ВСЕ запросы adverts получили 401/403 — токен без прав «Продвижение».
    const noAccess = advertsCallsMade > 0 && advertsCallsForbidden === advertsCallsMade;
    if (noAccess) {
      return res.status(200).json({
        totalSpend: 0, byNm: {},
        byCampaign: [], byDay: [],
        noAccess: true,
      });
    }

    // 2) Статистика по кампаниям через fullstats (батчи по 100).
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
              const cid = s.advertId;
              if (!byCampaignMap[cid]) byCampaignMap[cid] = { spend: 0, nm_ids: new Set() };
              for (const d of (s.days || [])) {
                const sum = d.sum || 0;
                totalSpend += sum;
                byCampaignMap[cid].spend += sum;
                const day = (d.date || '').slice(0, 10);
                if (day) byDayMap[day] = (byDayMap[day] || 0) + sum;
                for (const app of (d.apps || [])) {
                  for (const nm of (app.nm || [])) {
                    if (!nm || nm.nmId == null) continue;
                    if (!byNm[nm.nmId]) byNm[nm.nmId] = 0;
                    byNm[nm.nmId] += nm.sum || 0;
                    byCampaignMap[cid].nm_ids.add(nm.nmId);
                  }
                }
              }
            }
          }
        } catch(e) { /* пропускаем батч */ }
      }
    }

    // 3) Резервный метод — общие расходы через /upd (если fullstats не дал ничего).
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

    // 4) Финальная сборка byCampaign / byDay.
    const byCampaign = Object.keys(byCampaignMap)
      .filter(id => byCampaignMap[id].spend > 0)  // кампании без расхода не показываем
      .map(id => {
        const meta = campaignMeta[id] || {};
        return {
          id: Number(id) || id,
          name: meta.name || ('Кампания #' + id),
          status: meta.status ?? null,
          statusLabel: STATUS_LABEL[meta.status] || null,
          spend: Math.round(byCampaignMap[id].spend),
          nm_ids: Array.from(byCampaignMap[id].nm_ids),
        };
      })
      .sort((a, b) => b.spend - a.spend);

    const byDay = Object.keys(byDayMap)
      .sort()
      .map(day => ({ day, spend: Math.round(byDayMap[day]) }));

    return res.status(200).json({
      totalSpend: Math.round(totalSpend),
      byNm,
      byCampaign,
      byDay,
      noAccess: false,
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
