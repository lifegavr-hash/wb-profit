// /api/wb-tariffs — публичные тарифы WB (комиссии + логистика) для виджета-расширения.
// БЕЗ авторизации, т.к. данные публичные. Кэш 1 час на CDN.
//
// GET /api/wb-tariffs?subject=<name>&parent=<name>&volume=<L>&model=<fbo|fbs>
//
// Возвращает:
//   {
//     commission: { pct, source: 'exact' | 'fallback' | 'default', subject_name, parent_category },
//     logistics:  { forward_rub, return_to_wh_rub, return_to_pvz_rub, volume_l },
//     ktr:        { min_pct: 0, max_pct: 2.5 },
//     offer:      { version_label, effective_from, summary_url }
//   }
//
// Все параметры опциональные:
//   - subject — name предмета (subjectName), напр. «Роботы-мойщики окон»
//   - parent  — корневая категория (fallback, если subject не найден)
//   - volume  — объём в литрах (число; для логистики)
//   - model   — 'fbo' (default) или 'fbs'
// Если ничего не передано — вернётся структура с дефолтными значениями (электроника FBO).

import { createClient } from '@supabase/supabase-js';

// ─── Анонимный supabase-клиент (RLS политики разрешают public SELECT на этих таблицах) ───
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Подсчёт логистики по сетке тарифов и объёму ───
// Возвращает рублёвую стоимость прямой/обратной логистики.
// Логика:
//   - объём ≤ 1 л → flat_per_liter_rub × volume (по диапазону)
//   - объём > 1 л → first_liter_rub + extra_liter_rub × (volume - 1)
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

// ─── Нормализация названия предмета/категории к lowercase + trim ───
function normalize(s) {
  if (!s) return null;
  return String(s).trim().toLowerCase();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Кэш 1 час: тарифы меняются редко (мораторий до 30 апреля 2026)
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const subject = normalize(req.query.subject);
    const parent  = normalize(req.query.parent);
    const volumeL = Number(req.query.volume) || 0;
    const model   = (req.query.model === 'fbs') ? 'fbs' : 'fbo';

    // ─── 1. Комиссия: сначала ищем точный subjectName, потом fallback по корневой ───
    let commission = null;

    if (subject) {
      const { data } = await supabase
        .from('wb_commissions')
        .select('subject_name, parent_category, fbo_pct, fbs_pct, dbs_pct, is_fallback')
        .ilike('subject_name', subject)
        .is('valid_to', null)
        .eq('is_fallback', false)
        .limit(1);
      if (data && data[0]) {
        commission = {
          pct: model === 'fbs' ? Number(data[0].fbs_pct) : Number(data[0].fbo_pct),
          source: 'exact',
          subject_name: data[0].subject_name,
          parent_category: data[0].parent_category,
        };
      }
    }

    // fallback по корневой категории, если subject не нашёлся
    if (!commission && parent) {
      const { data } = await supabase
        .from('wb_commissions')
        .select('subject_name, parent_category, fbo_pct, fbs_pct, is_fallback')
        .ilike('subject_name', parent)
        .is('valid_to', null)
        .eq('is_fallback', true)
        .limit(1);
      if (data && data[0]) {
        commission = {
          pct: model === 'fbs' ? Number(data[0].fbs_pct) : Number(data[0].fbo_pct),
          source: 'fallback',
          subject_name: data[0].subject_name,
          parent_category: data[0].parent_category,
        };
      }
    }

    // Если ничего не нашлось — дефолт «электроника FBO 10% / FBS 18%» (самые низкие)
    if (!commission) {
      commission = {
        pct: model === 'fbs' ? 18.0 : 10.0,
        source: 'default',
        subject_name: null,
        parent_category: null,
      };
    }

    // ─── 2. Логистика: тянем сетку тарифов по нужным kind ───
    const kinds = [`forward_${model}`, 'return_to_wh', 'return_to_pvz'];
    const { data: tariffs } = await supabase
      .from('wb_logistics_tariffs')
      .select('kind, volume_min_l, volume_max_l, flat_per_liter_rub, first_liter_rub, extra_liter_rub')
      .in('kind', kinds)
      .is('valid_to', null);

    const byKind = {};
    (tariffs || []).forEach(t => {
      (byKind[t.kind] = byKind[t.kind] || []).push(t);
    });

    const logistics = {
      forward_rub:       computeLogisticsCost(byKind[`forward_${model}`] || [], volumeL),
      return_to_wh_rub:  computeLogisticsCost(byKind['return_to_wh']    || [], volumeL),
      return_to_pvz_rub: computeLogisticsCost(byKind['return_to_pvz']   || [], volumeL),
      volume_l:          volumeL,
      model,
    };

    // ─── 3. Текущая версия оферты ───
    const { data: offerRows } = await supabase
      .from('wb_offer_versions')
      .select('version_label, effective_from')
      .eq('is_current', true)
      .limit(1);
    const offer = offerRows && offerRows[0]
      ? {
          version_label: offerRows[0].version_label,
          effective_from: offerRows[0].effective_from,
          summary_url: 'https://wb-profit.vercel.app/api/wb-tariffs?summary=1',
        }
      : null;

    // ─── 4. КТР (наценка за нелокальные продажи, % от priceBasic) ───
    const ktr = { min_pct: 0, max_pct: 2.5 };

    return res.status(200).json({ commission, logistics, ktr, offer });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
