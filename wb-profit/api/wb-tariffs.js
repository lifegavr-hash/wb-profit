// /api/wb-tariffs v0.3.3 — публичные тарифы WB для виджета.
// Кэш 1 час на CDN.
//
// GET /api/wb-tariffs?
//   subject_id=<int>     ← основной (от WB Card API v4)
//   subject=<name>       ← fallback
//   parent=<name>        ← fallback
//   volume=<L>           ← объём литры
//   model=<fbo|fbs|dbs>  ← модель продаж
//   warehouse=<name>     ← конкретный склад (опционально)
//                          если не указан — медиана по ЦФО для FBO

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

function computeLogisticsCost(tariffRows, volumeL) {
  if (!Number.isFinite(volumeL) || volumeL <= 0) return 0;
  const v = Math.max(0.001, volumeL);
  const row = tariffRows.find(r => v >= Number(r.volume_min_l) && v <= Number(r.volume_max_l));
  if (!row) return 0;
  if (row.flat_per_liter_rub != null) {
    return Math.round(Number(row.flat_per_liter_rub) * v * 100) / 100;
  }
  if (row.first_liter_rub != null && row.extra_liter_rub != null) {
    const extraL = Math.max(0, v - 1);
    return Math.round(
      (Number(row.first_liter_rub) + Number(row.extra_liter_rub) * extraL) * 100
    ) / 100;
  }
  return 0;
}

function normalize(s) {
  if (!s) return null;
  return String(s).trim().toLowerCase();
}

function pickPct(row, model) {
  if (!row) return null;
  if (model === 'fbs') return Number(row.fbs_pct);
  if (model === 'dbs') return Number(row.dbs_pct);
  return Number(row.fbo_pct);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const subjectId = Number(req.query.subject_id) || null;
    const subject = normalize(req.query.subject);
    const parent  = normalize(req.query.parent);
    const volumeL = Number(req.query.volume) || 0;
    const modelRaw = String(req.query.model || 'fbo').toLowerCase();
    const model = ['fbo', 'fbs', 'dbs'].includes(modelRaw) ? modelRaw : 'fbo';
    const warehouseName = req.query.warehouse ? String(req.query.warehouse).trim() : null;

    // ── 1. Комиссия ──
    let commission = null;

    if (subjectId) {
      const { data } = await supabase
        .from('wb_commissions')
        .select('subject_id, subject_name, parent_id, parent_category, fbo_pct, fbs_pct, dbs_pct, dbs_express_pct, paid_storage_pct')
        .eq('subject_id', subjectId)
        .limit(1);
      if (data && data[0]) {
        const r = data[0];
        commission = {
          pct: pickPct(r, model),
          source: 'exact_id',
          subject_id: r.subject_id,
          subject_name: r.subject_name,
          parent_id: r.parent_id,
          parent_category: r.parent_category,
          all_models: {
            fbo: Number(r.fbo_pct),
            fbs: Number(r.fbs_pct),
            dbs: Number(r.dbs_pct),
            dbs_express: Number(r.dbs_express_pct),
            storage: Number(r.paid_storage_pct),
          },
        };
      }
    }
    if (!commission && subject) {
      const { data } = await supabase
        .from('wb_commissions')
        .select('subject_id, subject_name, parent_id, parent_category, fbo_pct, fbs_pct, dbs_pct, dbs_express_pct, paid_storage_pct')
        .ilike('subject_name', subject)
        .limit(1);
      if (data && data[0]) {
        const r = data[0];
        commission = {
          pct: pickPct(r, model),
          source: 'exact_name',
          subject_id: r.subject_id,
          subject_name: r.subject_name,
          parent_id: r.parent_id,
          parent_category: r.parent_category,
          all_models: {
            fbo: Number(r.fbo_pct), fbs: Number(r.fbs_pct), dbs: Number(r.dbs_pct),
            dbs_express: Number(r.dbs_express_pct), storage: Number(r.paid_storage_pct),
          },
        };
      }
    }
    if (!commission && parent) {
      const { data } = await supabase
        .from('wb_commissions')
        .select('fbo_pct, fbs_pct, dbs_pct, parent_category')
        .ilike('parent_category', parent)
        .limit(50);
      if (data && data.length) {
        const avg = key => Math.round((data.reduce((s, r) => s + Number(r[key] || 0), 0) / data.length) * 100) / 100;
        const fbo = avg('fbo_pct'), fbs = avg('fbs_pct'), dbs = avg('dbs_pct');
        commission = {
          pct: model === 'fbs' ? fbs : (model === 'dbs' ? dbs : fbo),
          source: 'fallback_parent', subject_id: null, subject_name: null,
          parent_id: null, parent_category: data[0].parent_category,
          all_models: { fbo, fbs, dbs, dbs_express: 3, storage: 25 },
        };
      }
    }
    if (!commission) {
      commission = {
        pct: model === 'fbs' ? 22 : (model === 'dbs' ? 17 : 30),
        source: 'default', subject_id: null, subject_name: null,
        parent_id: null, parent_category: null,
        all_models: { fbo: 30, fbs: 22, dbs: 17, dbs_express: 3, storage: 25 },
      };
    }

    // ── 2. Коэффициент склада (НОВОЕ в v0.3.3) ──
    // Если warehouse указан — точный коэф этого склада.
    // Если не указан — медианный коэф по ЦФО (самые популярные склады).
    let warehouseCoef = null;
    if (warehouseName) {
      const { data } = await supabase
        .from('wb_warehouse_tariffs')
        .select('warehouse_name, geo_name, box_delivery_coef_pct, box_delivery_marketplace_coef_pct, valid_date')
        .ilike('warehouse_name', warehouseName)
        .order('valid_date', { ascending: false })
        .limit(1);
      if (data && data[0]) {
        const r = data[0];
        const coefPct = model === 'fbs'
          ? r.box_delivery_marketplace_coef_pct
          : r.box_delivery_coef_pct;
        warehouseCoef = {
          source: 'exact_warehouse',
          warehouse_name: r.warehouse_name,
          geo_name: r.geo_name,
          coef: coefPct ? Math.round((Number(coefPct) / 100) * 100) / 100 : null,
          valid_date: r.valid_date,
        };
      }
    }
    if (!warehouseCoef) {
      // Медиана по ЦФО для авторежима
      const colName = model === 'fbs' ? 'box_delivery_marketplace_coef_pct' : 'box_delivery_coef_pct';
      const { data } = await supabase
        .from('wb_warehouse_tariffs')
        .select(colName + ', valid_date')
        .eq('geo_name', 'Центральный федеральный округ')
        .order('valid_date', { ascending: false })
        .limit(20);
      if (data && data.length) {
        const values = data.map(r => Number(r[colName])).filter(v => v > 0).sort((a, b) => a - b);
        const median = values.length
          ? values[Math.floor(values.length / 2)]
          : 170;
        warehouseCoef = {
          source: 'median_cfo',
          warehouse_name: null,
          geo_name: 'Центральный федеральный округ (медиана)',
          coef: Math.round((median / 100) * 100) / 100,
          valid_date: data[0].valid_date,
        };
      } else {
        warehouseCoef = {
          source: 'default',
          warehouse_name: null, geo_name: null,
          coef: 1.7, valid_date: null,
        };
      }
    }

    // ── 3. Логистика (базовая сетка + коэф склада в виджете) ──
    const kinds = [`forward_${model === 'dbs' ? 'fbs' : model}`, 'return_to_wh', 'return_to_pvz'];
    const { data: tariffs } = await supabase
      .from('wb_logistics_tariffs')
      .select('kind, volume_min_l, volume_max_l, flat_per_liter_rub, first_liter_rub, extra_liter_rub')
      .in('kind', kinds)
      .is('valid_to', null);

    const byKind = {};
    (tariffs || []).forEach(t => {
      (byKind[t.kind] = byKind[t.kind] || []).push(t);
    });
    const fwdKey = `forward_${model === 'dbs' ? 'fbs' : model}`;
    const logistics = {
      forward_rub:       computeLogisticsCost(byKind[fwdKey]         || [], volumeL),
      return_to_wh_rub:  computeLogisticsCost(byKind['return_to_wh']  || [], volumeL),
      return_to_pvz_rub: computeLogisticsCost(byKind['return_to_pvz'] || [], volumeL),
      volume_l:          volumeL,
      model,
      warehouse_coef:    warehouseCoef,
    };

    // ── 4. Версия оферты ──
    const { data: offerRows } = await supabase
      .from('wb_offer_versions')
      .select('version_label, effective_from')
      .eq('is_current', true)
      .limit(1);
    const offer = offerRows && offerRows[0]
      ? { version_label: offerRows[0].version_label, effective_from: offerRows[0].effective_from }
      : { version_label: 'wb_api_official', effective_from: new Date().toISOString().slice(0,10) };

    // ── 5. Средняя СПП по площадке (НОВОЕ в v0.3.3) ──
    // По наблюдениям рынка — 26-28% в среднем.
    const ktr = { min_pct: 0, max_pct: 2.5 };
    const spp = { avg_pct: 27 };

    return res.status(200).json({ commission, logistics, ktr, offer, spp });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
