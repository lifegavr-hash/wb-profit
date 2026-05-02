export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const token = req.headers['authorization'];
  const { from, to } = req.query;

  const results = {};

  try {
    for (const status of [4, 7, 8, 9, 11]) {
      const r = await fetch(
        `https://advert-api.wildberries.ru/adv/v1/promotion/adverts?status=${status}&limit=100`,
        { headers: { Authorization: token } }
      );
      results[`status_${status}`] = { code: r.status, data: await r.text() };
    }
  } catch(e) { results.error = e.message; }

  return res.status(200).json(results);
}
