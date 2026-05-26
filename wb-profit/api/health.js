// 🔥 v0.7.7.6: Health check endpoint для UptimeRobot
// GET /api/health — возвращает 200 если приложение и Supabase живы, 503 если нет.
// UptimeRobot пингует каждые 5 минут и шлёт алёрт при недоступности.

export default async function handler(req, res) {
  // Только GET
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // Без кеширования
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const checks = {
    app: 'ok',
    supabase: 'unknown',
    env: 'unknown'
  };
  let allOk = true;

  // Проверяем переменные окружения
  const requiredEnvs = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
  const missingEnvs = requiredEnvs.filter(k => !process.env[k]);
  if (missingEnvs.length === 0) {
    checks.env = 'ok';
  } else {
    checks.env = 'missing:' + missingEnvs.join(',');
    allOk = false;
  }

  // Проверяем Supabase (короткий timeout)
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    if (supabaseUrl) {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(supabaseUrl + '/rest/v1/', {
        method: 'HEAD',
        headers: { 'apikey': process.env.SUPABASE_ANON_KEY || '' },
        signal: ctrl.signal
      });
      clearTimeout(tid);
      checks.supabase = r.ok || r.status === 404 ? 'ok' : 'status:' + r.status;
      if (!r.ok && r.status !== 404) allOk = false;
    } else {
      checks.supabase = 'no_url';
      allOk = false;
    }
  } catch (e) {
    checks.supabase = 'error:' + (e.name || 'unknown');
    allOk = false;
  }

  const status = allOk ? 200 : 503;
  return res.status(status).json({
    ok: allOk,
    timestamp: new Date().toISOString(),
    version: 'v0.7.7.6',
    checks: checks
  });
}
