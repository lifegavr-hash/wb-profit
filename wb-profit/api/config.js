// /api/config — конфиг Supabase + health-check + lead capture.
// GET без параметров: возвращает supabaseUrl/Key для фронта (config)
// GET с ?health=1: health-статус для UptimeRobot
// POST с body {email, source?, utm?}: добавляет лид в таблицу leads
// Совмещено в одном эндпойнте чтобы не превышать лимит 12 функций.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // === POST MODE — приём email-подписок с лендинга ===
  if (req.method === 'POST') {
    res.setHeader('Cache-Control', 'no-store');
    try {
      let body = {};
      try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      } catch (_) { body = {}; }

      const email = String(body.email || '').trim().toLowerCase();
      const source = String(body.source || 'landing').slice(0, 50);

      // Простая валидация
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.status(400).json({ error: 'INVALID_EMAIL', message: 'Введите корректный email' });
      }
      if (email.length > 200) {
        return res.status(400).json({ error: 'EMAIL_TOO_LONG' });
      }

      // Извлекаем IP и user-agent (для антифрод)
      const xff = req.headers['x-forwarded-for'];
      const ip = xff ? String(xff).split(',')[0].trim() : (req.headers['x-real-ip'] || null);
      let ua = req.headers['user-agent'] || null;
      if (ua && ua.length > 500) ua = ua.slice(0, 500);

      // UTM-параметры из body или referer
      const utm = body.utm || {};

      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!SUPABASE_URL || !SERVICE_KEY) {
        return res.status(500).json({ error: 'CONFIG_MISSING' });
      }
      const supa = createClient(SUPABASE_URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      });

      const { error } = await supa.from('leads').insert({
        email,
        source,
        utm_source: utm.source || null,
        utm_medium: utm.medium || null,
        utm_campaign: utm.campaign || null,
        utm_term: utm.term || null,
        utm_content: utm.content || null,
        ip,
        user_agent: ua,
        meta: body.meta || {}
      });

      if (error) {
        // Дубликат email — это не ошибка для UX, говорим "успешно"
        if (error.code === '23505') {
          return res.status(200).json({ ok: true, duplicate: true });
        }
        console.error('[/api/config POST lead] error:', error);
        return res.status(500).json({ error: 'INSERT_FAILED', message: error.message });
      }

      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('[/api/config POST lead] unexpected:', e);
      return res.status(500).json({ error: 'INTERNAL', message: e.message });
    }
  }

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
      version: 'v0.7.12.1',
      checks: checks
    });
  }

  // === CONFIG MODE — для фронта (как раньше) ===
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY
  });
}
