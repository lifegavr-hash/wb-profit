// /api/config — конфиг Supabase + health-check для UptimeRobot.
// При обычном вызове: возвращает supabaseUrl/Key для фронта.
// При вызове с ?health=1: возвращает health-статус (для мониторинга UptimeRobot).
// Совмещено в одном эндпойнте чтобы не превышать лимит 12 функций на Vercel Hobby plan.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

  // === HEALTH MODE — для UptimeRobot ===
  if (req.query && req.query.health === '1') {
    const checks = { app: 'ok', env: 'unknown', supabase: 'unknown' };
    let allOk = true;

    // 1. Проверка env переменных
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (supabaseUrl && supabaseKey) {
      checks.env = 'ok';
    } else {
      const missing = [];
      if (!supabaseUrl) missing.push('SUPABASE_URL');
      if (!supabaseKey) missing.push('SUPABASE_PUBLISHABLE_KEY');
      checks.env = 'missing:' + missing.join(',');
      allOk = false;
    }

    // 2. Проверка доступности Supabase через /auth/v1/settings
    if (supabaseUrl && supabaseKey) {
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(supabaseUrl + '/auth/v1/settings', {
          method: 'GET',
          headers: {
            'apikey': supabaseKey,
            'Authorization': 'Bearer ' + supabaseKey
          },
          signal: ctrl.signal
        });
        clearTimeout(tid);
        if (r.ok) {
          checks.supabase = 'ok';
        } else {
          checks.supabase = 'status:' + r.status;
          allOk = false;
        }
      } catch (e) {
        checks.supabase = 'error:' + (e.name || 'unknown');
        allOk = false;
      }
    } else {
      checks.supabase = 'skipped_no_env';
    }

    return res.status(allOk ? 200 : 503).json({
      ok: allOk,
      timestamp: new Date().toISOString(),
      version: 'v0.7.7.8',
      checks: checks
    });
  }

  // === CONFIG MODE — для фронта (как раньше) ===
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY
  });
}
