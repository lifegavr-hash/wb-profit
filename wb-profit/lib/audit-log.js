// lib/audit-log.js
// Утилита для записи событий безопасности и биллинга в таблицу audit_log.
// Использовать из бэкенд-эндпоинтов (api/*.js) — требует service_role клиент.
//
// Список допустимых event_type:
//   account_created           — регистрация (автоматически через trigger)
//   account_deleted           — удаление аккаунта самообслуживанием
//   promo_activated           — успешная активация промокода
//   promo_failed              — попытка активации с ошибкой
//   promo_created_by_admin    — админ создал промокод
//   promo_deactivated_by_admin — админ деактивировал промокод
//   token_saved               — WB API токен сохранён
//   plan_changed              — тариф изменён (не через промокод)
//
// event_status: 'success' | 'failed' | 'attempt'

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let _client = null;
function getClient() {
  if (!_client) {
    _client = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return _client;
}

/**
 * Записать событие в audit_log. Не блокирует основной код при ошибке.
 *
 * @param {Object} params
 * @param {string} params.event_type - тип события из whitelist
 * @param {string} [params.event_status='success'] - success|failed|attempt
 * @param {string} [params.user_id] - UUID пользователя (если есть)
 * @param {string} [params.user_email] - email (для контекста, особенно при failed)
 * @param {Object} [params.meta] - произвольные доп. данные (jsonb)
 * @param {Object} [params.req] - объект request для извлечения IP и user-agent
 * @returns {Promise<boolean>} true если записано, false при ошибке (не throws)
 */
export async function audit({ event_type, event_status = 'success', user_id = null, user_email = null, meta = {}, req = null }) {
  try {
    if (!event_type) {
      console.warn('[audit] event_type required');
      return false;
    }
    let ip = null, user_agent = null;
    if (req) {
      // Vercel прокидывает оригинальный IP в x-forwarded-for и x-real-ip
      const xff = req.headers?.['x-forwarded-for'];
      if (xff) ip = String(xff).split(',')[0].trim();
      else ip = req.headers?.['x-real-ip'] || null;
      user_agent = req.headers?.['user-agent'] || null;
      // Обрезаем user_agent чтобы не разрастался
      if (user_agent && user_agent.length > 500) user_agent = user_agent.slice(0, 500);
    }
    const client = getClient();
    const { error } = await client.from('audit_log').insert({
      user_id,
      user_email,
      event_type,
      event_status,
      meta,
      ip,
      user_agent
    });
    if (error) {
      console.warn('[audit] insert failed:', error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[audit] unexpected:', e.message);
    return false;
  }
}
