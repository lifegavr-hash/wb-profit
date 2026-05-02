export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const token = req.headers['authorization'];
  if (!token) {
    return res.status(401).json({ error: 'Токен не передан' });
  }

  const { dateFrom, dateTo, rrdid = 0 } = req.query;
  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'Укажите dateFrom и dateTo' });
  }

  const url = `https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod?dateFrom=${dateFrom}&dateTo=${dateTo}&rrdid=${rrdid}&limit=100000`;

  try {
    const response = await fetch(url, {
      headers: { 'Authorization': token }
    });

    const text = await response.text();

    res.status(response.status);
    res.setHeader('Content-Type', 'application/json');
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
