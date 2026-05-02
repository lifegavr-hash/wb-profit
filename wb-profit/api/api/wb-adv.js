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
    const campaignsRes = await fetch(
      `https://advert-api.wildberries.ru/adv/v1/promotion/adverts?status=9&limit=50`,
      { headers: { 'Authorization': token } }
    );

    let totalSpend = 0;
    const byNm = {};

    if (campaignsRes.ok) {
      const campaigns = await campaignsRes.json();
      const ids = (campaigns || []).map(c => c.advertId).filter(Boolean);

      if (ids.length > 0) {
        const chunks = [];
        for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));

        for (const chunk of chunks) {
          const statsRes = await fetch(
            `https://advert-api.wildberries.ru/adv/v2/fullstats`,
            {
              method: 'POST',
              headers: { 'Authorization': token, 'Content-Type': 'application/json' },
              body: JSON.stringify(chunk.map(id => ({ id, dates: [from, to] })))
            }
          );
          if (statsRes.ok) {
            const stats = await statsRes.json();
            for (const s of (stats || [])) {
              for (const d of (s.days || [])) {
                totalSpend += d.sum || 0;
                for (const app of (d.apps || [])) {
                  for (const nm of (app.nm || [])) {
                    const nmId = nm.nmId;
                    if (!byNm[nmId]) byNm[nmId] = 0;
                    byNm[nmId] += nm.sum || 0;
                  }
                }
              }
            }
          }
        }
      }
    }

    const upd = await fetch(
      `https://advert-api.wildberries.ru/adv/v1/upd?from=${from}&to=${to}`,
      { headers: { 'Authorization': token } }
    );
    let updTotal = 0;
    if (upd.ok) {
      const updData = await upd.json();
      for (const d of (updData || [])) updTotal += d.updSum || 0;
    }

    return res.status(200).json({ totalSpend: totalSpend || updTotal, byNm });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
