// Общая утилита для проверки тарифа пользователя на бэкенде.
// v0.7.1: расширена — возвращает все лимиты из таблицы `plans`, кэширует план в памяти.
//
// API:
//   extractJwt(req) — извлекает JWT из заголовков
//   getUserPlan(jwt) — возвращает {user, plan, hasPro, expiresAt, isAdmin} (старая совместимость)
//   getUserPlanWithLimits(jwt) — то же + plan_obj (полная запись из plans с лимитами)
//   requirePro(jwt, featureName) — если не PRO — {error:'PRO_REQUIRED', status:403}
//   requireFeature(jwt, featureKey) — проверяет конкретную фичу (has_detail, has_analytics и т.д.)
//   checkPeriodLimit(jwt, dateFrom, dateTo) — проверяет что период не превышает max_period_days
//   sendIfPlanError(res, result) — короткий ответ 4xx если в result есть error
//
// При ошибке: {error, status, message?, feature?}
// При успехе: {user, plan, plan_obj, hasPro, expiresAt, isAdmin, limits, features}

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function makeClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

// === Кэш тарифов в памяти (5 мин) ===
// Тарифы редко меняются, нет смысла дёргать БД каждый запрос
let _plansCache = null;
let _plansCacheExpiry = 0;
const PLANS_CACHE_MS = 5 * 60 * 1000;

async function loadPlans() {
  if (_plansCache && Date.now() < _plansCacheExpiry) return _plansCache;
  const supabase = makeClient();
  const { data, error } = await supabase.from('plans').select('*');
  if (error || !data) {
    console.warn('[plan-check] loadPlans failed:', error?.message);
    return _plansCache || []; // используем последний кеш если есть
  }
  _plansCache = data;
  _plansCacheExpiry = Date.now() + PLANS_CACHE_MS;
  return data;
}

function findPlan(plans, planId) {
  // Fallback на 'pro' если plan не найден (free больше нет с v0.7.7.22)
  return plans.find(p => p.id === planId) || plans.find(p => p.id === 'pro') || null;
}

// === Извлечение JWT из заголовков ===
export function extractJwt(req) {
  const xUser = req.headers['x-user-auth'];
  if (xUser) return String(xUser).replace(/^Bearer\s+/i, '');
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '');
  return null;
}

// === Базовая функция (старая) — для обратной совместимости ===
export async function getUserPlan(jwt) {
  const r = await getUserPlanWithLimits(jwt);
  if (r.error) return r;
  // Возвращаем только базовые поля для совместимости
  return {
    user: r.user,
    plan: r.plan,
    hasPro: r.hasPro,
    expiresAt: r.expiresAt,
    isAdmin: r.isAdmin,
  };
}

// === Полная функция с лимитами ===
export async function getUserPlanWithLimits(jwt) {
  if (!jwt) return { error: 'Нет токена авторизации', status: 401 };
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { error: 'Сервер не настроен (нет SUPABASE env)', status: 500 };
  }
  const supabase = makeClient();
  // Аутентификация по JWT
  const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !user) return { error: 'Неверный JWT', status: 401 };
  // Профиль
  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('plan, plan_expires_at, trial_until, billing_period, is_admin')
    .eq('id', user.id)
    .single();
  if (profErr || !profile) return { error: 'Профиль не найден', status: 404 };
  let plan = profile.plan || 'pro';
  const expiresAt = profile.plan_expires_at ? new Date(profile.plan_expires_at) : null;
  const trialUntil = profile.trial_until ? new Date(profile.trial_until) : null;
  const billingPeriod = profile.billing_period || 'monthly';
  const isAdmin = !!profile.is_admin;
  // 🔥 v0.7.7.22: Trial-механика + новая логика expired
  // Trial active = sейчас < trial_until И billing_period='trial'
  const now = Date.now();
  const isTrial = trialUntil && trialUntil.getTime() > now && billingPeriod === 'trial';
  const trialDaysLeft = isTrial ? Math.ceil((trialUntil.getTime() - now) / (24*60*60*1000)) : 0;
  // Expired = plan истёк И (не trial или trial истёк) И не админ
  const isExpired = !isAdmin && expiresAt && expiresAt.getTime() < now;
  // ВАЖНО: при expired НЕ переключаем plan на 'free' (free больше нет).
  // Возвращаем эффективный план как 'expired' — это виртуальный план
  // с доступом только к Главной (read-only).
  // Реальное значение profile.plan в БД остаётся прежним, чтобы при
  // успешной оплате access восстановился.
  const effectivePlanId = isAdmin ? 'business' : (isExpired ? 'expired' : plan);
  // Подгружаем лимиты из таблицы plans
  const plans = await loadPlans();
  let planObj = findPlan(plans, effectivePlanId);
  // Виртуальный 'expired' план — только Главная, никаких фич
  if (effectivePlanId === 'expired' || !planObj) {
    planObj = {
      id: 'expired',
      name: 'Истёк',
      price_monthly: 0,
      max_sku: 30,
      max_period_days: 7,
      max_history_days: 7,
      max_wb_accounts: 1,
      max_team_members: 1,
      has_detail: false,
      has_analytics: false,
      has_unit_calc: false,
      has_telegram: false,
      has_email_alerts: false,
      has_excel_export: false,
      has_priority_support: false,
      has_ai_chat: false,
      short_description: 'Подписка истекла — доступ только к Главной',
      features: ['Только просмотр Главной','Загрузка данных за 7 дней','Без новой аналитики']
    };
  }
  const limits = {
    max_sku: planObj.max_sku,
    max_period_days: planObj.max_period_days,
    max_history_days: planObj.max_history_days,
    max_wb_accounts: planObj.max_wb_accounts || 1,
    max_team_members: planObj.max_team_members || 1,
  };
  const features = {
    detail: !!planObj.has_detail,
    analytics: !!planObj.has_analytics,
    unit_calc: !!planObj.has_unit_calc,
    telegram: !!planObj.has_telegram,
    email_alerts: !!planObj.has_email_alerts,
    excel_export: !!planObj.has_excel_export,
    priority_support: !!planObj.has_priority_support,
    ai_chat: !!planObj.has_ai_chat,
  };
  const hasPro = !isExpired && (plan === 'pro' || plan === 'business' || isAdmin);
  return {
    user, plan, plan_obj: planObj,
    hasPro, expiresAt, isAdmin,
    limits, features,
    // 🔥 v0.7.7.22: новые поля для UI
    isTrial,
    trialDaysLeft,
    trialUntil,
    billingPeriod,
    isExpired,
    effectivePlanId,
  };
}

// === requirePro — обратная совместимость ===
export async function requirePro(jwt, featureName) {
  const result = await getUserPlanWithLimits(jwt);
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

// === requireFeature(jwt, 'detail' | 'analytics' | 'excel_export' | ...) ===
// Проверяет включена ли конкретная фича в тарифе пользователя.
// Это правильный путь — не просто "PRO/не PRO", а конкретное право.
export async function requireFeature(jwt, featureKey, displayName) {
  const result = await getUserPlanWithLimits(jwt);
  if (result.error) return result;
  if (!result.features || !result.features[featureKey]) {
    return {
      error: 'FEATURE_REQUIRED',
      message: `${displayName || featureKey} недоступна на вашем тарифе`,
      feature: featureKey,
      status: 403,
    };
  }
  return result;
}

// === checkPeriodLimit(jwt, dateFrom, dateTo) ===
// Проверяет что период не превышает max_period_days тарифа.
// Возвращает {ok:true, days, plan} или {error, status, ...}
export async function checkPeriodLimit(jwt, dateFrom, dateTo) {
  const result = await getUserPlanWithLimits(jwt);
  if (result.error) return result;
  const fromMs = new Date(dateFrom).getTime();
  const toMs = new Date(dateTo).getTime();
  if (isNaN(fromMs) || isNaN(toMs) || fromMs > toMs) {
    return { error: 'Некорректные даты', status: 400 };
  }
  const days = Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000)) + 1;
  const maxDays = result.limits?.max_period_days; // null = безлимит
  if (maxDays && days > maxDays) {
    return {
      error: 'PERIOD_LIMIT',
      message: `Период ${days} дней превышает лимит вашего тарифа (${result.plan_obj?.name}: до ${maxDays} дней)`,
      feature: `Период ${days} дней`,
      maxDays,
      currentPlan: result.plan,
      status: 403,
    };
  }
  return { ok: true, days, ...result };
}

// === Хелпер для короткого ответа из handler'а ===
export function sendIfPlanError(res, result) {
  if (result.error) {
    res.status(result.status || 500).json({
      error: result.error,
      message: result.message,
      feature: result.feature,
      maxDays: result.maxDays,
      currentPlan: result.currentPlan,
    });
    return true;
  }
  return false;
}
