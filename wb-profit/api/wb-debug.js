// /api/wb-debug — временный endpoint для отладки нового финансового API WB
// Использование:
//   GET /api/wb-debug?action=info  - кто такой селлер, какие категории у токена
//   GET /api/wb-debug?action=list  - список отчётов реализации за последние 30 дней
//   GET /api/wb-debug?action=detail&id=REPORT_ID  - детали конкретного отчёта
//   GET /api/wb-debug?action=period  - данные за период (новый метод, заменит старый)
//
// Принимает токен из заголовка Authorization или из query ?token=...
// Возвращает СЫРОЙ ответ от WB как есть.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // Токен можно передать в заголовке ИЛИ в query — для удобства теста из браузера
  const tok = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  if (!tok) {
    return res.status(400).json({
      error: 'Нет токена',
      hint: 'Передайте ?token=ВАШ_WB_ТОКЕН в URL',
    });
  }

  const action = req.query.action || 'info';
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const monthAgo = new Date(now);
  monthAgo.setDate(now.getDate() - 30);
  const dateFrom = monthAgo.toISOString().slice(0, 10);

  // === ACTION: PROBE ===
  // Перебор гипотез какой endpoint возвращает ЕЖЕДНЕВНЫЕ отчёты
  if (action === 'probe') {
    const FROM = '2026-05-09';
    const TO = '2026-05-13';
    const probes = [
      { name: 'list + reportType:3', url: 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list', body: { dateFrom: FROM, dateTo: TO, reportType: 3 } },
      { name: 'list + reportType:0', url: 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list', body: { dateFrom: FROM, dateTo: TO, reportType: 0 } },
      { name: 'list + frequency:DAILY', url: 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list', body: { dateFrom: FROM, dateTo: TO, frequency: 'DAILY' } },
      { name: 'list + period:daily', url: 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list', body: { dateFrom: FROM, dateTo: TO, period: 'daily' } },
      { name: 'list + isDaily:true', url: 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list', body: { dateFrom: FROM, dateTo: TO, isDaily: true } },
      { name: '/daily-reports/list', url: 'https://finance-api.wildberries.ru/api/finance/v1/daily-reports/list', body: { dateFrom: FROM, dateTo: TO } },
      { name: '/sales-reports/daily/list', url: 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/daily/list', body: { dateFrom: FROM, dateTo: TO } },
      { name: '/sales-reports/daily', url: 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/daily', body: { dateFrom: FROM, dateTo: TO } },
      { name: '/v2/sales-reports/list', url: 'https://finance-api.wildberries.ru/api/finance/v2/sales-reports/list', body: { dateFrom: FROM, dateTo: TO } },
    ];
    const results = [];
    for (const p of probes) {
      try {
        const r = await fetch(p.url, {
          method: 'POST',
          headers: { Authorization: tok, 'Content-Type': 'application/json' },
          body: JSON.stringify(p.body),
        });
        const txt = await r.text();
        let parsed;
        try { parsed = JSON.parse(txt); } catch { parsed = txt; }
        let count = 0;
        let datesRange = null;
        let sample = null;
        if (Array.isArray(parsed)) {
          count = parsed.length;
          if (parsed.length) {
            sample = parsed[0];
            const dates = parsed.map((x) => `${x.dateFrom}→${x.dateTo}(t${x.reportType})`);
            datesRange = `${dates[0]} ... ${dates[dates.length-1]} (всего ${dates.length})`;
          }
        }
        results.push({
          name: p.name,
          status: r.status,
          ok: r.ok,
          count,
          datesRange,
          firstReport: sample ? { dateFrom: sample.dateFrom, dateTo: sample.dateTo, reportType: sample.reportType, reportId: sample.reportId } : null,
          rawHead: !r.ok ? (typeof parsed === 'string' ? parsed.slice(0, 200) : JSON.stringify(parsed).slice(0, 300)) : null,
        });
        // WB rate-limit 1 запрос/мин — но это разные endpoint'ы, лимит на каждый отдельный.
        // Пауза 1.2 сек чтобы не словить общий лимит.
        await new Promise((rs) => setTimeout(rs, 1200));
      } catch (e) {
        results.push({ name: p.name, error: e.message });
      }
    }
    return res.status(200).json({
      action: 'probe',
      hint: 'Ищем endpoint для ежедневных отчётов. Где count = 5 (за 5 дней) и каждый report имеет dateFrom===dateTo - то и нужный.',
      results,
    });
  }

  // === ACTION: INFO ===
  // Узнаём кто это, какие категории у токена
  if (action === 'info') {
    try {
      const r = await fetch('https://common-api.wildberries.ru/api/v1/seller-info', {
        headers: { Authorization: tok },
      });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      return res.status(200).json({
        action: 'info',
        endpoint: 'GET https://common-api.wildberries.ru/api/v1/seller-info',
        status: r.status,
        ok: r.ok,
        response: body,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message, stack: e.stack });
    }
  }

  // === ACTION: LIST ===
  // Список отчётов реализации
  if (action === 'list') {
    try {
      const r = await fetch('https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list', {
        method: 'POST',
        headers: {
          Authorization: tok,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          dateFrom: dateFrom,
          dateTo: today,
        }),
      });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      return res.status(200).json({
        action: 'list',
        endpoint: 'POST https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list',
        requestBody: { dateFrom, dateTo: today },
        status: r.status,
        ok: r.ok,
        response: body,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message, stack: e.stack });
    }
  }

  // === ACTION: DETAIL ===
  // Детали конкретного отчёта по ID
  if (action === 'detail') {
    const id = req.query.id;
    if (!id) {
      return res.status(400).json({
        error: 'Нет id',
        hint: 'Передайте ?id=REPORT_ID (получите его в action=list)',
      });
    }
    try {
      const r = await fetch(`https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: {
          Authorization: tok,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      // Показываем только первые 3 строки чтобы не было гигантского ответа
      if (body && Array.isArray(body)) {
        const totalRows = body.length;
        body = { _totalRows: totalRows, _firstRows: body.slice(0, 3) };
      } else if (body && body.data && Array.isArray(body.data)) {
        const totalRows = body.data.length;
        body = { ...body, _totalRows: totalRows, data: body.data.slice(0, 3) };
      }
      return res.status(200).json({
        action: 'detail',
        endpoint: `POST .../sales-reports/detailed/${id}`,
        status: r.status,
        ok: r.ok,
        response: body,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message, stack: e.stack });
    }
  }

  // === ACTION: PERIOD ===
  // Данные за период (новая версия старого reportDetailByPeriod)
  if (action === 'period') {
    try {
      const r = await fetch('https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed', {
        method: 'POST',
        headers: {
          Authorization: tok,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          dateFrom: dateFrom,
          dateTo: today,
        }),
      });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      // Покажем только 3 первые строки
      if (body && Array.isArray(body)) {
        const totalRows = body.length;
        body = { _totalRows: totalRows, _firstRows: body.slice(0, 3) };
      } else if (body && body.data && Array.isArray(body.data)) {
        const totalRows = body.data.length;
        body = { ...body, _totalRows: totalRows, data: body.data.slice(0, 3) };
      }
      return res.status(200).json({
        action: 'period',
        endpoint: 'POST https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed',
        requestBody: { dateFrom, dateTo: today },
        status: r.status,
        ok: r.ok,
        response: body,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message, stack: e.stack });
    }
  }

  return res.status(400).json({
    error: 'Неизвестный action',
    available: ['info', 'list', 'detail', 'period'],
  });
}
