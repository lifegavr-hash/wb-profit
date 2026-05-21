// /api/wb-tariffs v0.3.7 — публичные тарифы WB для виджета.
// Кэш 1 час на CDN.
//
// v0.3.7 ИЗМЕНЕНИЯ:
// - Базовая логистика берётся из wb_warehouse_tariffs (актуальная WB Box API)
//   а не из старой таблицы wb_logistics_tariffs
// - Добавлен флаг fbs_unavailable когда склад не принимает FBS-товары
// - Возврат остался по упрощённой формуле (будет улучшен в v0.4)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

// 🆕 v0.3.7: Расчёт логистики напрямую из тарифов склада WB
// Формула WB: первый литр = base, каждый следующий = liter ₽
function computeLogisticsFromWarehouse(volumeL, base, perLiter) {
  if (!Number.isFinite(volumeL) || volumeL <= 0) return 0;
  if (!Number.isFinite(base) || !Number.isFinite(perLiter)) return 0;
  // Первый литр включён в base; следующие литры считаются дополнительно
  const extraL = Math.max(0, volumeL - 1);
  return Math.round((Number(base) + Number(perLiter) * extraL) * 100) / 100;
}

// Старая логика для return_to_pvz (пока в БД, потом обновим в v0.4)
function computeReturnPvz(tariffRows, volumeL) {
  if (!Number.isFinite(volumeL) || volumeL <= 0) return 0;
  const row = tariffRows.find(r => volumeL >= Number(r.volume_min_l) && volumeL <= Number(r.volume_max_l));
  if (!row) return 0;
  if (row.first_liter_rub != null && row.extra_liter_rub != null) {
    const extraL = Math.max(0, volumeL - 1);
    return Math.round((Number(row.first_liter_rub) + Number(row.extra_liter_rub) * extraL) * 100) / 100;
  }
  if (row.flat_per_liter_rub != null) {
    return Math.round(Number(row.flat_per_liter_rub) * volumeL * 100) / 100;
  }
  return 0;
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

    // ── 1. КОМИССИЯ ──
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
          subject_id: r.subject_id, subject_name: r.subject_name,
          parent_id: r.parent_id, parent_category: r.parent_category,
          all_models: {
            fbo: Number(r.fbo_pct), fbs: Number(r.fbs_pct), dbs: Number(r.dbs_pct),
            dbs_express: Number(r.dbs_express_pct), storage: Number(r.paid_storage_pct),
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
          pct: pickPct(r, model), source: 'exact_name',
          subject_id: r.subject_id, subject_name: r.subject_name,
          parent_id: r.parent_id, parent_category: r.parent_category,
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
        .ilike('parent_category', parent).limit(50);
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

    // ── 2. СКЛАД и КОЭФФИЦИЕНТ ──
    let warehouseRow = null;
    let warehouseCoef = null;
    let fbsUnavailable = false;
    let coefSource = 'median_cfo';

    if (warehouseName) {
      const { data } = await supabase
        .from('wb_warehouse_tariffs')
        .select('*')
        .ilike('warehouse_name', warehouseName)
        .order('valid_date', { ascending: false })
        .limit(1);
      if (data && data[0]) {
        warehouseRow = data[0];
        coefSource = 'exact_warehouse';
      }
    }

    if (!warehouseRow) {
      // Медиана по ЦФО (только склады с непустым FBW)
      const { data } = await supabase
        .from('wb_warehouse_tariffs')
        .select('*')
        .eq('geo_name', 'Центральный федеральный округ')
        .not('box_delivery_coef_pct', 'is', null)
        .order('valid_date', { ascending: false })
        .limit(20);
      if (data && data.length) {
        // Берём средний склад по медиане коэфа
        const sorted = data.slice().sort((a, b) =>
          Number(a.box_delivery_coef_pct) - Number(b.box_delivery_coef_pct)
        );
        warehouseRow = sorted[Math.floor(sorted.length / 2)];
        coefSource = 'median_cfo';
      }
    }

    // Определяем коэф и базу для выбранной модели
    let baseRub = null, literRub = null, coefPct = null;

    if (warehouseRow) {
      if (model === 'fbs') {
        // 🆕 v0.3.7: FBS-данные могут быть NULL — склад не принимает FBS-товары
        if (warehouseRow.box_delivery_marketplace_coef_pct == null) {
          fbsUnavailable = true;
          // Fallback на FBW-данные с предупреждением
          baseRub = Number(warehouseRow.box_delivery_base);
          literRub = Number(warehouseRow.box_delivery_liter);
          coefPct = Number(warehouseRow.box_delivery_coef_pct);
        } else {
          baseRub = Number(warehouseRow.box_delivery_marketplace_base);
          literRub = Number(warehouseRow.box_delivery_marketplace_liter);
          coefPct = Number(warehouseRow.box_delivery_marketplace_coef_pct);
        }
      } else {
        // FBO/FBW (default) — используем box_delivery_*
        baseRub = Number(warehouseRow.box_delivery_base);
        literRub = Number(warehouseRow.box_delivery_liter);
        coefPct = Number(warehouseRow.box_delivery_coef_pct);
      }
      warehouseCoef = {
        source: coefSource,
        warehouse_name: warehouseRow.warehouse_name,
        geo_name: warehouseRow.geo_name,
        coef: coefPct ? Math.round((coefPct / 100) * 100) / 100 : null,
        base_rub: baseRub,
        per_liter_rub: literRub,
        valid_date: warehouseRow.valid_date,
        fbs_unavailable: fbsUnavailable,
      };
    } else {
      // Полный fallback — старые цифры
      warehouseCoef = {
        source: 'default', warehouse_name: null, geo_name: null,
        coef: 1.7, base_rub: 46, per_liter_rub: 14, valid_date: null,
        fbs_unavailable: false,
      };
      baseRub = 46;
      literRub = 14;
    }

    // ── 3. ЛОГИСТИКА ──
    // 🆕 v0.3.7: forward_rub теперь считается ИЗ WB Box API (base + per_liter * (volume-1))
    // Это УЖЕ С УЧЁТОМ коэфа склада — поэтому в виджете НЕ умножать ещё раз!
    const forwardRub = computeLogisticsFromWarehouse(volumeL, baseRub, literRub);

    // Возврат на склад (FBO): используем те же base+liter (как у прямой доставки FBO)
    const returnToWhRub = model === 'fbo' ? forwardRub : 0;

    // Возврат в ПВЗ (FBS): пока берём из старой таблицы
    const { data: pvzTariffs } = await supabase
      .from('wb_logistics_tariffs')
      .select('volume_min_l, volume_max_l, flat_per_liter_rub, first_liter_rub, extra_liter_rub')
      .eq('kind', 'return_to_pvz')
      .is('valid_to', null);
    const returnToPvzRub = computeReturnPvz(pvzTariffs || [], volumeL);

    const logistics = {
      forward_rub: forwardRub,
      return_to_wh_rub: returnToWhRub,
      return_to_pvz_rub: returnToPvzRub,
      volume_l: volumeL,
      model,
      warehouse_coef: warehouseCoef,
      // 🆕 v0.3.7: флаг для виджета — показать предупреждение
      fbs_unavailable: fbsUnavailable && model === 'fbs',
      // 🆕 v0.3.7: forward_rub уже включает коэф склада, виджет НЕ должен умножать
      forward_includes_coef: true,
    };

    // ── 4. ОФЕРТА ──
    const { data: offerRows } = await supabase
      .from('wb_offer_versions')
      .select('version_label, effective_from')
      .eq('is_current', true)
      .limit(1);
    const offer = offerRows && offerRows[0]
      ? { version_label: offerRows[0].version_label, effective_from: offerRows[0].effective_from }
      : { version_label: 'wb_api_official', effective_from: new Date().toISOString().slice(0,10) };

    const ktr = { min_pct: 0, max_pct: 2.5 };
    const spp = { avg_pct: 27 };

    return res.status(200).json({ commission, logistics, ktr, offer, spp });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
