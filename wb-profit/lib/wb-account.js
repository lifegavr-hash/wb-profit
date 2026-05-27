// /lib/wb-account.js — хелпер для разрешения wb_account_id в API endpoints
//
// Используется в каждом endpoint который работает с user-данными
// (daily_snapshots, user_costs, unit_calc_history, product_costs).
//
// Логика:
//   - Если клиент передал wb_account_id → проверяем что он принадлежит юзеру
//   - Если не передал → берём default-кабинет юзера
//   - Если у юзера НЕТ ни одного кабинета → создаём «Магазин 1» прямо здесь
//     (legacy юзеры с localStorage.wb_token но без wb_accounts ещё могут быть)

import { createClient } from '@supabase/supabase-js';

const supa = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

/**
 * Возвращает валидный wb_account_id для пользователя.
 * 
 * @param {string} userId — auth.uid()
 * @param {string|null} providedAccountId — что прислал клиент (из query или body), может быть null
 * @returns {Promise<{ok: true, wb_account_id: string, account: object} | {ok: false, status: number, error: string, message: string}>}
 */
export async function resolveWbAccountId(userId, providedAccountId) {
  const client = supa();

  // Случай 1: клиент явно передал wb_account_id → валидируем принадлежность юзеру
  if (providedAccountId && typeof providedAccountId === 'string') {
    const { data, error } = await client
      .from('wb_accounts')
      .select('id, name, is_default, wb_token')
      .eq('id', providedAccountId)
      .eq('user_id', userId)
      .single();
    if (error || !data) {
      return {
        ok: false,
        status: 403,
        error: 'WB_ACCOUNT_NOT_FOUND',
        message: 'WB-кабинет не найден или не принадлежит этому пользователю'
      };
    }
    return { ok: true, wb_account_id: data.id, account: data };
  }

  // Случай 2: клиент не передал — ищем default
  const { data: defaults } = await client
    .from('wb_accounts')
    .select('id, name, is_default, wb_token')
    .eq('user_id', userId)
    .eq('is_default', true)
    .limit(1);

  if (defaults && defaults.length > 0) {
    return { ok: true, wb_account_id: defaults[0].id, account: defaults[0] };
  }

  // Случай 3: у юзера нет default, но возможно есть какой-то кабинет (например, сломали через UI)
  const { data: anyAcc } = await client
    .from('wb_accounts')
    .select('id, name, is_default, wb_token')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (anyAcc && anyAcc.length > 0) {
    // Делаем его default «по случаю»
    await client.from('wb_accounts').update({ is_default: true }).eq('id', anyAcc[0].id);
    return { ok: true, wb_account_id: anyAcc[0].id, account: anyAcc[0] };
  }

  // Случай 4: у юзера 0 кабинетов и нет default
  // → НЕ создаём автоматически (это сценарий «не подключил ни одного кабинета»)
  // → возвращаем 412 Precondition Failed → клиент должен сначала добавить кабинет
  return {
    ok: false,
    status: 412,
    error: 'NO_WB_ACCOUNT',
    message: 'Сначала подключите WB-кабинет в Настройках'
  };
}

/**
 * Удобный wrapper для использования в handlers — извлекает providedId из query или body.
 * Не используется напрямую но показан паттерн:
 *   const wbId = req.query.wb_account_id || (req.body && req.body.wb_account_id) || null;
 *   const r = await resolveWbAccountId(user.id, wbId);
 *   if (!r.ok) return res.status(r.status).json({ error: r.error, message: r.message });
 *   // используем r.wb_account_id
 */
