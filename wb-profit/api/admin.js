import { createClient } from '@supabase/supabase-js';
import { audit } from '../lib/audit-log.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Нет токена' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Неверный токен' });

  const { data: profile } = await supabase.from('profiles').select('is_admin').eq('id', user.id).single();
  if (!profile?.is_admin) return res.status(403).json({ error: 'Нет доступа' });

  if (req.method === 'GET') {
    const PAGE = 25;
    const resource = req.query.resource;
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const search = (req.query.search || '').trim();
    const filter = req.query.filter || 'all';

    // 🔥 v0.7.12.26: страница пользователей с серверными фильтрами/поиском/пагинацией.
    // Не тянем всех разом — WHERE+ILIKE+range в SQL, общее число через {count:'exact'}.
    async function fetchUsersPage() {
      let q = supabase.from('admin_all_users').select('*', { count: 'exact' });
      if (filter === 'paid') {
        // Реально платящие: тариф pro/business И период не триал (trial и NULL — не платёж).
        q = q.in('plan', ['pro', 'business']).neq('billing_period', 'trial');
      } else if (filter === 'trial') {
        // Активный триал: период trial И срок ещё не истёк.
        q = q.eq('billing_period', 'trial').gt('trial_until', new Date().toISOString());
      } else if (filter === 'active') {
        // Заходили ≤7 дней назад. last_activity=NULL не проходит gt → в фильтр не попадает (ок).
        q = q.gt('last_activity', new Date(Date.now() - 7 * 86400000).toISOString());
      }
      if (search) q = q.ilike('email', '%' + search + '%');
      const { data, count } = await q
        .order('last_activity', { ascending: false, nullsFirst: false })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      return { users: data || [], usersTotal: count || 0, usersPage: page, usersPageSize: PAGE };
    }

    // Лёгкий запрос: только страница юзеров (поиск/пагинация/фильтр без перезагрузки промо/фидбэка).
    if (resource === 'users') {
      return res.status(200).json(await fetchUsersPage());
    }

    // 🔥 v0.7.12.26: промокоды + данные использования (кто/когда активировал, активен ли период).
    // Без N+1: 1 запрос на активации + 1 на email'ы активаторов, группировка в JS.
    const { data: promos } = await supabase.from('promo_codes').select('*').order('created_at', { ascending: false });
    const { data: uses } = await supabase.from('promo_uses').select('promo_id, user_id, used_at');
    const userIds = [...new Set((uses || []).map(u => u.user_id).filter(Boolean))];
    const emailById = {};
    if (userIds.length) {
      const { data: profs } = await supabase.from('profiles').select('id, email').in('id', userIds);
      (profs || []).forEach(p => { emailById[p.id] = p.email; });
    }
    const usesByPromo = {};
    (uses || []).forEach(u => { (usesByPromo[u.promo_id] = usesByPromo[u.promo_id] || []).push(u); });
    const now = Date.now();
    const promosEnriched = (promos || []).map(p => {
      // period_active: оплаченный по коду период (used_at + p.days дней) ещё не истёк.
      // НЕ опираемся на текущий plan юзера — его могли менять вручную, это не показатель.
      const list = (usesByPromo[p.id] || []).map(u => ({
        email: emailById[u.user_id] || '—',
        used_at: u.used_at,
        period_active: new Date(u.used_at).getTime() + (p.days || 0) * 86400000 > now
      }));
      return { ...p, uses: list };
    });

    // 🔥 v0.7.12.17: фидбэк целиком (все статусы) для управления в админке.
    const { data: feedback } = await supabase.from('feedback').select('*').order('created_at', { ascending: false }).limit(200);
    const usersPayload = await fetchUsersPage();
    return res.status(200).json({ promos: promosEnriched, feedback, ...usersPayload });
  }

  if (req.method === 'POST') {
    const { action, code, plan, days, maxUses, id, status, response: fbResponse, isActive } = req.body;

    // 🔥 v0.7.12.17: допустимые статусы фидбэка (синхронно с фронтом-дропдауном).
    const FEEDBACK_STATUSES = ['new', 'in_progress', 'done', 'rejected'];
    if (action === 'create_promo') {
      // 🔥 v0.7.12.16: trim+upper при создании — чтобы в БД всегда чистый код без пробелов.
      const normCode = (code || '').trim().toUpperCase();
      if (!normCode) return res.status(400).json({ error: 'Введите код' });
      const { data, error: err } = await supabase.from('promo_codes').insert({
        code: normCode, plan, days, max_uses: maxUses
      }).select().single();
      if (err) return res.status(400).json({ error: err.message });
      await audit({
        event_type: 'promo_created_by_admin',
        event_status: 'success',
        user_id: user.id,
        user_email: user.email,
        meta: { code: normCode, plan, days, max_uses: maxUses, promo_id: data.id },
        req
      });
      return res.status(200).json({ success: true, promo: data });
    }
    if (action === 'deactivate_promo') {
      await supabase.from('promo_codes').update({ is_active: false }).eq('id', id);
      await audit({
        event_type: 'promo_deactivated_by_admin',
        event_status: 'success',
        user_id: user.id,
        user_email: user.email,
        meta: { promo_id: id },
        req
      });
      return res.status(200).json({ success: true });
    }

    // 🔥 v0.7.12.17: вкл/выкл промокода (универсальная замена deactivate_promo).
    if (action === 'toggle_promo') {
      if (!id) return res.status(400).json({ error: 'Нет id' });
      const nextActive = isActive === true;
      const { error: err } = await supabase.from('promo_codes').update({ is_active: nextActive }).eq('id', id);
      if (err) return res.status(400).json({ error: err.message });
      await audit({
        event_type: nextActive ? 'promo_updated_by_admin' : 'promo_deactivated_by_admin',
        event_status: 'success',
        user_id: user.id, user_email: user.email,
        meta: { promo_id: id, is_active: nextActive },
        req
      });
      return res.status(200).json({ success: true });
    }

    // 🔥 v0.7.12.17: редактирование срока/лимита промокода.
    if (action === 'update_promo') {
      if (!id) return res.status(400).json({ error: 'Нет id' });
      const patch = {};
      if (days !== undefined && days !== null && days !== '') {
        const d = parseInt(days, 10);
        if (!Number.isFinite(d) || d < 1 || d > 365) return res.status(400).json({ error: 'Дней: 1–365' });
        patch.days = d;
      }
      if (maxUses !== undefined && maxUses !== null && maxUses !== '') {
        const m = parseInt(maxUses, 10);
        if (!Number.isFinite(m) || m < 1) return res.status(400).json({ error: 'Лимит ≥ 1' });
        patch.max_uses = m;
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Нечего обновлять' });
      const { error: err } = await supabase.from('promo_codes').update(patch).eq('id', id);
      if (err) return res.status(400).json({ error: err.message });
      await audit({
        event_type: 'promo_updated_by_admin',
        event_status: 'success',
        user_id: user.id, user_email: user.email,
        meta: { promo_id: id, ...patch },
        req
      });
      return res.status(200).json({ success: true });
    }

    // 🔥 v0.7.12.17: удаление промокода (опасное — confirm на фронте).
    if (action === 'delete_promo') {
      if (!id) return res.status(400).json({ error: 'Нет id' });
      const { error: err } = await supabase.from('promo_codes').delete().eq('id', id);
      if (err) return res.status(400).json({ error: err.message });
      await audit({
        event_type: 'promo_deleted_by_admin',
        event_status: 'success',
        user_id: user.id, user_email: user.email,
        meta: { promo_id: id },
        req
      });
      return res.status(200).json({ success: true });
    }

    // 🔥 v0.7.12.17: смена статуса фидбэка.
    if (action === 'update_feedback_status') {
      if (!id) return res.status(400).json({ error: 'Нет id' });
      if (!FEEDBACK_STATUSES.includes(status)) return res.status(400).json({ error: 'Недопустимый статус' });
      const { error: err } = await supabase.from('feedback').update({ status }).eq('id', id);
      if (err) return res.status(400).json({ error: err.message });
      await audit({
        event_type: 'feedback_updated_by_admin',
        event_status: 'success',
        user_id: user.id, user_email: user.email,
        meta: { feedback_id: id, status },
        req
      });
      return res.status(200).json({ success: true });
    }

    // 🔥 v0.7.12.17: ответ админа на фидбэк.
    if (action === 'respond_feedback') {
      if (!id) return res.status(400).json({ error: 'Нет id' });
      const text = (fbResponse || '').trim();
      if (!text) return res.status(400).json({ error: 'Пустой ответ' });
      const { error: err } = await supabase.from('feedback')
        .update({ admin_response: text, admin_response_at: new Date().toISOString() }).eq('id', id);
      if (err) return res.status(400).json({ error: err.message });
      await audit({
        event_type: 'feedback_updated_by_admin',
        event_status: 'success',
        user_id: user.id, user_email: user.email,
        meta: { feedback_id: id, responded: true },
        req
      });
      return res.status(200).json({ success: true });
    }

    // 🔥 v0.7.12.17: удаление фидбэка (опасное — confirm на фронте).
    if (action === 'delete_feedback') {
      if (!id) return res.status(400).json({ error: 'Нет id' });
      const { error: err } = await supabase.from('feedback').delete().eq('id', id);
      if (err) return res.status(400).json({ error: err.message });
      await audit({
        event_type: 'feedback_deleted_by_admin',
        event_status: 'success',
        user_id: user.id, user_email: user.email,
        meta: { feedback_id: id },
        req
      });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Неизвестное действие' });
  }
}
