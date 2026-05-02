export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'Токен не передан' });

  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Укажите from и to' });

  try {
    const byNm = {};
    let totalSpend = 0;

    // Запрашиваем кампании всех статусов: активные, завершённые, на паузе
    const statuses = [7, 9, 11];
    let allCampaigns = [];

    for (const status of statuses) {
      try {
        const r = await fetch(
          `https://advert-api.wildberries.ru/adv/v1/promotion/adverts?status=${status}&limit=1000`,
          { headers: { 'Authorization': token } }
        );
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data)) allCampaigns = allCampaigns.concat(data);
        }
      } catch(e) {}
    }

    const ids = allCampaigns.map(c => c.advertId).filter(Boolean);

    if (ids.length > 0) {
      // Разбиваем на группы по 100
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        try {
          const r = await fetch(
            'https://advert-api.wildberries.ru/adv/v2/fullstats',
            {
              method: 'POST',
              headers: { 'Authorization': token, 'Content-Type': 'application/json' },
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

    // Резервный способ — общие расходы через /upd
    if (totalSpend === 0) {
      try {
        const r = await fetch(
          `https://advert-api.wildberries.ru/adv/v1/upd?from=${from}&to=${to}`,
          { headers: { 'Authorization': token } }
        );
        if (r.ok) {
          const data = await r.json();
          for (const d of (data || [])) totalSpend += d.updSum || 0;
        }
      } catch(e) {}
    }

    return res.status(200).json({ totalSpend, byNm });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
