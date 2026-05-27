// /api/calcs — CRUD истории подборов товаров v0.4.1
// GET    ?wb_account_id=xxx   — список подборов для кабинета (фильтры/сорт)
// POST   { ..., wb_account_id }  — создать (с учётом активного кабинета) или обновить (по id)
// DELETE ?id=...                  — удалить (id уникален, кабинет проверяется RLS+FK)
//
// v0.7.7.30: данные разделены по wb_account_id.

import { createClient } from '@supabase/supabase-js';
import { getUserPlan } from '../lib/plan-check.js';
import { resolveWbAccountId } from '../lib/wb-account.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Нет токена' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Неверный токен' });

  // 🔥 v0.7.7.30: разрешаем wb_account_id (DELETE может без него — id уникален)
  const providedWbId = req.query.wb_account_id 
    || (req.body && req.body.wb_account_id) 
    || null;
  let wbAccountId = null;
  if (req.method !== 'DELETE') {
    const wbResolve = await resolveWbAccountId(user.id, providedWbId);
    if (!wbResolve.ok) {
      return res.status(wbResolve.status).json({ 
        error: wbResolve.error, 
        message: wbResolve.message 
      });
    }
    wbAccountId = wbResolve.wb_account_id;
  }

  // ───── GET — список подборов ─────
  if (req.method === 'GET') {
    const { sort = 'created_desc', q = '', minMargin, model, source } = req.query;
    let query = supabase
      .from('unit_calc_history')
      .select('*')
      .eq('user_id', user.id)
      .eq('wb_account_id', wbAccountId)   // 🔥 v0.7.7.30
      .limit(200);

    if (q) query = query.or(`name.ilike.%${q}%,category.ilike.%${q}%,subject_name.ilike.%${q}%,notes.ilike.%${q}%`);
    if (minMargin && !isNaN(Number(minMargin))) query = query.gte('margin_pct', Number(minMargin));
    if (model && ['fbo','fbs','dbs'].includes(model)) query = query.eq('model', model);
    if (source) query = query.eq('source', source);

    switch (sort) {
      case 'profit_desc':  query = query.order('profit', { ascending: false }); break;
      case 'profit_asc':   query = query.order('profit', { ascending: true });  break;
      case 'margin_desc':  query = query.order('margin_pct', { ascending: false }); break;
      case 'margin_asc':   query = query.order('margin_pct', { ascending: true }); break;
      case 'roi_desc':     query = query.order('roi_pct', { ascending: false }); break;
      case 'created_asc':  query = query.order('created_at', { ascending: true }); break;
      case 'created_desc':
      default:             query = query.order('created_at', { ascending: false });
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ calcs: data || [], wb_account_id: wbAccountId });
  }

  // ───── POST — создать или обновить ─────
  if (req.method === 'POST') {
    const b = req.body || {};

    if (!b.id) {
      const planResult = await getUserPlan(token);
      if (!planResult.hasPro) {
        const { count } = await supabase
          .from('unit_calc_history')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id);
        if ((count || 0) >= 5) {
          return res.status(403).json({
            error: 'PRO_REQUIRED',
            message: 'На тарифе Free можно сохранить до 5 подборов. Для безлимита — нужен PRO.',
            feature: 'Безлимитные подборы товара',
          });
        }
      }
    }

    const row = {
      user_id: user.id,
      wb_account_id: wbAccountId,   // 🔥 v0.7.7.30
      name: String(b.name || 'Без названия').slice(0, 200),
      category: b.category || null,
      retail_price: Number(b.retail_price) || 0,
      cost_price: Number(b.cost_price) || 0,
      cost_currency: b.cost_currency || 'RUB',
      cost_rate: Number(b.cost_rate) || 1,
      weight_kg: Number(b.weight_kg) || 0,
      volume_l: Number(b.volume_l) || 0,
      commission_pct: Number(b.commission_pct) || 0,
      logistics_rub: Number(b.logistics_rub) || 0,
      storage_rub: Number(b.storage_rub) || 0,
      tax_pct: Number(b.tax_pct) || 7,
      redemption_pct: Number(b.redemption_pct) || 80,
      ad_pct: Number(b.ad_pct) || 5,
      profit: Number(b.profit) || 0,
      margin_pct: Number(b.margin_pct) || 0,
      roi_pct: Number(b.roi_pct) || 0,
      subject_id: b.subject_id ? Number(b.subject_id) : null,
      subject_name: b.subject_name || null,
      model: ['fbo','fbs','dbs'].includes(b.model) ? b.model : 'fbo',
      warehouse_name: b.warehouse_name || null,
      retail_price_seen: b.retail_price_seen != null ? Number(b.retail_price_seen) : null,
      retail_price_basic_set: b.retail_price_basic_set !== false,
      nm_id: b.nm_id ? Number(b.nm_id) : null,
      notes: b.notes ? String(b.notes).slice(0, 500) : null,
      all_models: b.all_models || null,
      source: b.source || 'manual',
      updated_at: new Date().toISOString(),
    };

    if (b.id) {
      // UPDATE: НЕ меняем wb_account_id при редактировании (запись остаётся в своём кабинете)
      const { wb_account_id, ...updateRow } = row;
      const { data, error } = await supabase
        .from('unit_calc_history')
        .update(updateRow)
        .eq('id', b.id)
        .eq('user_id', user.id)
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ calc: data });
    } else {
      const { data, error } = await supabase
        .from('unit_calc_history')
        .insert(row)
        .select()
        .single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ calc: data });
    }
  }

  // ───── DELETE — удалить ─────
  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'Нет id' });
    const { error } = await supabase
      .from('unit_calc_history')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
