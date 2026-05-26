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

    const requiredEnvs = ['SUPABASE_URL'];
    const missingEnvs = requiredEnvs.filter(k => !process.env[k]);
    if (missingEnvs.length === 0) {
      checks.env = 'ok';
    } else {
      checks.env = 'missing:' + missingEnvs.join(',');
      allOk = false;
    }

    try {
      const supabaseUrl = process.env.SUPABASE_URL;
      if (supabaseUrl) {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(supabaseUrl + '/rest/v1/', {
          method: 'HEAD',
          headers: { 'apikey': process.env.SUPABASE_PUBLISHABLE_KEY || '' },
          signal: ctrl.signal
        });
        clearTimeout(tid);
        checks.supabase = (r.ok || r.status === 404) ? 'ok' : 'status:' + r.status;
        if (!r.ok && r.status !== 404) allOk = false;
      } else {
        checks.supabase = 'no_url';
        allOk = false;
      }
    } catch (e) {
      checks.supabase = 'error:' + (e.name || 'unknown');
      allOk = false;
    }

    return res.status(allOk ? 200 : 503).json({
      ok: allOk,
      timestamp: new Date().toISOString(),
      version: 'v0.7.7.7',
      checks: checks
    });
  }

  // === CONFIG MODE — для фронта (как раньше) ===
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY
  });
}
