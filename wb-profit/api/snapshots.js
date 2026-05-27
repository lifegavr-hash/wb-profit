// /api/snapshots
// POST: { snapshots: [...], wb_account_id? }  — сохранить снапшоты для активного кабинета
// GET  ?days=7&wb_account_id=xxx              — отдать последние N дней для кабинета
//
// v0.7.7.30: данные разделены по wb_account_id. Если клиент не передал — используется default.

import { createClient } from '@supabase/supabase-js';
import { getUserPlanWithLimits } from '../lib/plan-check.js';
import { resolveWbAccountId } from '../lib/wb-account.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Нет токена' });

  const planResult = await getUserPlanWithLimits(token);
  if (planResult.error) {
    return res.status(planResult.status || 500).json({ error: planResult.error, message: planResult.message });
  }
  const user = planResult.user;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // 🔥 v0.7.7.30: разрешаем wb_account_id из query (GET) или body (POST)
  const providedWbId = req.query.wb_account_id 
    || (req.body && req.body.wb_account_id) 
    || null;
  const wbResolve = await resolveWbAccountId(user.id, providedWbId);
  if (!wbResolve.ok) {
    return res.status(wbResolve.status).json({ 
      error: wbResolve.error, 
      message: wbResolve.message 
    });
  }
  const wbAccountId = wbResolve.wb_account_id;

  if (req.method === 'GET') {
    const requested = parseInt(req.query.days || '7', 10);
    const maxHistory = planResult.isAdmin
      ? 99999
      : (planResult.limits?.max_history_days || 30);
    const days = Math.min(requested, maxHistory);
    const wasTrimmed = requested > maxHistory;

    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceIso = since.toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from('daily_snapshots')
      .select('*')
      .eq('user_id', user.id)
      .eq('wb_account_id', wbAccountId)
      .gte('day', sinceIso)
      .order('day', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const response = { 
      snapshots: data || [],
      wb_account_id: wbAccountId,
    };
    if (wasTrimmed) {
      response.warning = {
        type: 'HISTORY_LIMIT',
        message: `Ваш тариф позволяет видеть историю до ${maxHistory} дней. Запрошено ${requested} — обрезано.`,
        max_history_days: maxHistory,
        requested_days: requested,
        plan: planResult.plan,
      };
    }
    return res.status(200).json(response);
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const snapshots = Array.isArray(body.snapshots) ? body.snapshots : [];
    if (!snapshots.length) return res.status(400).json({ error: 'snapshots пустой' });

    const rows = snapshots.map((s) => ({
      user_id: user.id,
      wb_account_id: wbAccountId,
      day: s.day,
      sales_count: s.sales_count || 0,
      returns_count: s.returns_count || 0,
      revenue: s.revenue || 0,
      commission: s.commission || 0,
      payout: s.payout || 0,
      logistics: s.logistics || 0,
      storage: s.storage || 0,
      ads: s.ads || 0,
      penalties: s.penalties || 0,
      wb_finance: s.wb_finance || 0,
      cost: s.cost || 0,
      profit: s.profit || 0,
      top_items: s.top_items || [],
      alerts: s.alerts || [],
      source: s.source || 'calc',
      updated_at: new Date().toISOString(),
    }));

    // onConflict теперь (user_id, wb_account_id, day) — новый PK
    const { error } = await supabase
      .from('daily_snapshots')
      .upsert(rows, { onConflict: 'user_id,wb_account_id,day' });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ 
      success: true, 
      saved: rows.length,
      wb_account_id: wbAccountId,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
