// Общая утилита для проверки тарифа пользователя на бэкенде.
// Используется в /api/wb, /api/snapshots, /api/calcs.
//
// Идея: фронтенд отправляет JWT в X-User-Auth (или Authorization для endpoint'ов которые
// принимают только наш токен). Мы по JWT находим пользователя в БД, проверяем plan и
// plan_expires_at. Если истёк — даунгрейдим в БД и возвращаем free.
//
// API:
//   getUserPlan(jwt) -> {user, plan, hasPro, error}
//   requirePro(jwt) -> {user, plan, hasPro, error}   // дополнительно проверяет hasPro
//
// При ошибке возвращает {error: '...', status: 401|403}.
// Если всё ок — {user, plan, hasPro, expiresAt}.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function makeClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

// Извлекает JWT из заголовков запроса.
// Сначала пробует X-User-Auth (для endpoint'ов где Authorization уже занят WB-токеном),
// потом Authorization (Bearer ...).
export function extractJwt(req) {
  const xUser = req.headers['x-user-auth'];
  if (xUser) return String(xUser).replace(/^Bearer\s+/i, '');
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '');
  return null;
}

// Возвращает {user, plan, hasPro, expiresAt} или {error, status}.
export async function getUserPlan(jwt) {
  if (!jwt) return { error: 'Нет токена авторизации', status: 401 };
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { error: 'Сервер не настроен (нет SUPABASE env)', status: 500 };
  }
  const supabase = makeClient();
  // Аутентификация
  const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !user) return { error: 'Неверный JWT', status: 401 };
  // Профиль
  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('plan, plan_expires_at, is_admin')
    .eq('id', user.id)
    .single();
  if (profErr || !profile) return { error: 'Профиль не найден', status: 404 };
  let plan = profile.plan || 'free';
  const expiresAt = profile.plan_expires_at ? new Date(profile.plan_expires_at) : null;
  const isAdmin = !!profile.is_admin;
  // Авто-даунгрейд если истёк (но не для админа)
  if (!isAdmin && (plan === 'pro' || plan === 'business') && expiresAt && expiresAt.getTime() < Date.now()) {
    await supabase.from('profiles').update({ plan: 'free', plan_expires_at: null }).eq('id', user.id);
    plan = 'free';
  }
  const hasPro = plan === 'pro' || plan === 'business' || isAdmin;
  return { user, plan, hasPro, expiresAt, isAdmin };
}

// Если требуется PRO — возвращает {error, status:403} если нет.
// Иначе возвращает {user, plan, hasPro, ...}.
export async function requirePro(jwt, featureName) {
  const result = await getUserPlan(jwt);
  if (result.error) return result;
  if (!result.hasPro) {
    return {
      error: 'PRO_REQUIRED',
      message: `${featureName || 'Эта функция'} доступна только на тарифе PRO`,
      feature: featureName,
      status: 403,
    };
  }
  return result;
}

// Хелпер: отправляет 403 в ответ если PRO нужен но его нет.
// Возвращает true если ответ отправлен (надо прервать handler), false если можно продолжать.
export function sendIfPlanError(res, result) {
  if (result.error) {
    res.status(result.status || 500).json({
      error: result.error,
      message: result.message,
      feature: result.feature,
    });
    return true;
  }
  return false;
}
