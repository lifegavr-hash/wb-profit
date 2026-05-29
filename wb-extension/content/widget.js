// content/widget.js — SW Profit v0.3.9
// Правки v0.3.5:
//  1) Цена продавца показывается ПО УМОЛЧАНИЮ из СПП-расчёта (без пустоты)
//  2) Поле "Моя реальная комиссия" УБРАНО из основного UI (только в advanced)
//  3) Селектор склада ПЕРЕНЕСЁН в advanced (раздел "Уточнить расчёт")
//  4) Кнопка "Готово" одна, на оба поля
//  5) Закупка не вылезает — оба поля в одной сетке с одинаковой шириной
//  6) Логотип "SW Profit" сверху = АКТИВНАЯ ССЫЛКА на кабинет (новая вкладка)
//     Сворачивание виджета сделано через отдельный шеврон ▼
//  7) Из расчёта убрана кнопка "Настройки", оставлена только "Кабинет"
//  8) "⚙️ Уточнить расчёт" → "⚙️ Уточнить расчёт (склад, габариты, комиссия)"
(() => {
  'use strict';
  const VERSION = '0.3.9';
  const API_TARIFFS = 'https://wb-profit.vercel.app/api/wb-tariffs';
  const API_CARD = 'https://card.wb.ru/cards/v4/detail';
  const DASHBOARD_URL = 'https://wb-profit.vercel.app/dashboard.html';
  const HOST_ID = 'swprofit-host-v039';
  const log = (...a) => console.log('[SW Profit v' + VERSION + ']', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fmtRub = (v) => v == null || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('ru-RU') + ' ₽';
  const fmtPct = (v) => v == null ? '—' : (Math.round(v * 10) / 10) + '%';
  const nmIdFromUrl = () => {
    const m = location.pathname.match(/\/catalog\/(\d+)\/detail/);
    return m ? m[1] : null;
  };
  const getSettings = () => new Promise(resolve => {
    chrome.storage.local.get(null, (data) => resolve({
      model: data.model || 'fbo',
      tax_pct: data.tax_pct ?? 6,
      acquiring_pct: data.acquiring_pct ?? 1.5,
      redemption_pct: data.redemption_pct ?? 80,
      ad_pct: data.ad_pct ?? 10,
      warehouse: data.warehouse || 'auto',
      collapsed: data.collapsed || false,
      detailsCollapsed: data.detailsCollapsed ?? true,
      prices: data.prices || {},
      costs: data.costs || {},
      volumes: data.volumes || {},
      dims: data.dims || {},
      commissions: data.commissions || {},
      auto_dims_disabled: data.auto_dims_disabled || {},
    }));
  });
  const saveSetting = (key, value) => new Promise(resolve => chrome.storage.local.set({ [key]: value }, resolve));
  const wbCardCache = new Map();
  const fetchWbCard = async (nmId) => {
    if (!nmId) return null;
    if (wbCardCache.has(nmId)) return wbCardCache.get(nmId);
    try {
      const r = await fetch(API_CARD + '?appType=1&curr=rub&dest=-1257786&nm=' + nmId, { credentials: 'omit' });
      if (!r.ok) return null;
      const j = await r.json();
      const p = j?.products?.[0];
      if (!p) return null;
      const size = p.sizes?.[0];
      const price = size?.price || {};
      const result = {
        nmId, subjectId: p.subjectId,
        entity: p.entity || '', brand: p.brand || '', supplier: p.supplier || '',
        volume_l: typeof p.volume === 'number' ? p.volume / 10 : null,
        weight_kg: typeof p.weight === 'number' ? p.weight : null,
        priceOriginal: price.basic ? price.basic / 100 : null,
        priceProduct: price.product ? price.product / 100 : null,
        name: p.name || '',
      };
      wbCardCache.set(nmId, result);
      return result;
    } catch (e) { return null; }
  };


  const fetchDimensionsViaDrawer = async () => {
    const sleep_ = (ms) => new Promise(r => setTimeout(r, ms));
    const style = document.createElement('style');
    style.id = 'swprofit-drawer-cloak';
    style.textContent = `
      [class*="detailsDrawer"], [class*="mo-drawer__paper"] {
        transform: translateX(120%) !important; transition: none !important; animation: none !important;
      }
      [class*="mo-drawer__overlay"], [class*="mo-modal__overlay"] {
        opacity: 0 !important; pointer-events: none !important; transition: none !important; animation: none !important;
      }
      [class*="mo-drawer"] { transition: none !important; }
    `;
    document.head.appendChild(style);
    let result = null;
    try {
      const btn = Array.from(document.querySelectorAll('button')).find(
        b => /Характеристики и описание/i.test(b.textContent || '')
      );
      if (!btn) return null;
      btn.click();
      let tc = '';
      for (let i = 0; i < 25; i++) {
        await sleep_(100);
        tc = document.body.textContent;
        if (/Длина упаковки/i.test(tc)) break;
      }
      const grab = (label) => {
        const re = new RegExp(label + '\\s*([\\d.,]+)\\s*см', 'i');
        const m = tc.match(re);
        return m ? parseFloat(m[1].replace(',', '.')) : null;
      };
      const L = grab('Длина упаковки');
      const W = grab('Ширина упаковки');
      const H = grab('Высота упаковки');
      if (L && W && H) result = { L, W, H, volume_l: Math.round((L*W*H/1000)*1000)/1000 };
      document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',code:'Escape',keyCode:27,bubbles:true}));
      for (let i = 0; i < 15; i++) {
        await sleep_(100);
        if (!document.querySelector('[class*="detailsDrawer"]')) break;
      }
    } catch (e) {}
    finally { setTimeout(() => { try { style.remove(); } catch (_) {} }, 200); }
    return result;
  };

  const tariffsCache = new Map();
  const fetchTariffs = async ({ subject_id, subject, parent, volume, model, warehouse }) => {
    const key = (subject_id||subject||'na') + '|' + volume + '|' + model + '|' + (warehouse||'auto');
    if (tariffsCache.has(key)) return tariffsCache.get(key);
    try {
      const params = new URLSearchParams();
      if (subject_id) params.set('subject_id', subject_id);
      if (subject) params.set('subject', subject);
      if (parent) params.set('parent', parent);
      if (volume) params.set('volume', volume);
      params.set('model', model || 'fbo');
      if (warehouse && warehouse !== 'auto') params.set('warehouse', warehouse);
      const r = await fetch(API_TARIFFS + '?' + params);
      if (!r.ok) return null;
      const data = await r.json();
      tariffsCache.set(key, data);
      return data;
    } catch (e) { return null; }
  };

  const parseBreadcrumb = () => {
    const container = document.querySelector('[itemtype*="BreadcrumbList"]');
    if (!container) return { items: [], subject: null, parent: null };
    const items = Array.from(container.querySelectorAll('[itemprop="name"]'))
      .map(el => (el.getAttribute('content') || el.textContent || '').trim())
      .filter(s => s && !/^(главная|wildberries)$/i.test(s));
    const brandLink = document.querySelector('a[href*="/brands/"]');
    const brandText = brandLink ? (brandLink.textContent || '').trim() : '';
    let subject = items[items.length - 1] || null;
    if (brandText && subject && brandText.toLowerCase() === subject.toLowerCase()) {
      subject = items[items.length - 2] || subject;
    }
    return { items, subject, parent: items[0] || null };
  };

  const computeFinancials = ({ priceBasic, cost, tariffs, settings, volumeKnown, overrideCommission }) => {
    if (!priceBasic || !tariffs) return null;
    const base = priceBasic;
    const isFbs = settings.model === 'fbs';
    const isDbs = settings.model === 'dbs';
    const commPct = overrideCommission != null ? overrideCommission : tariffs.commission.pct;
    const fwdLogBase = tariffs.logistics.forward_rub || 0;
    let retLogBase;
    if (isFbs) retLogBase = tariffs.logistics.return_to_pvz_rub || 0;
    else if (isDbs) retLogBase = 0;
    else retLogBase = tariffs.logistics.return_to_wh_rub || 0;
    const ktrAvgPct = (tariffs.ktr?.max_pct || 2.5) / 2;
    const commission = base * commPct / 100;
    const acquiring = base * settings.acquiring_pct / 100;
    const tax = base * settings.tax_pct / 100;
    const advertising = base * settings.ad_pct / 100;
    const returnFactor = 1 - settings.redemption_pct / 100;
    const whCoefData = tariffs.logistics.warehouse_coef;
    let coef = 1.0;
    if ((settings.model === 'fbo' || isFbs) && whCoefData?.coef) coef = whCoefData.coef;
    // 🆕 v0.3.7: API теперь возвращает forward_rub УЖЕ с учётом коэфа склада.
    // Если forward_includes_coef=true — НЕ умножаем повторно.
    const fwdAlreadyHasCoef = tariffs.logistics.forward_includes_coef === true;
    const fwdLogReal = volumeKnown ? (fwdAlreadyHasCoef ? fwdLogBase : fwdLogBase * coef) : 0;
    const retLogReal = volumeKnown ? retLogBase * returnFactor : 0;
    const totalLog = fwdLogReal + retLogReal;
    const ktrAvg = base * ktrAvgPct / 100;
    const toSeller = base - commission - totalLog - acquiring - tax - advertising - ktrAvg;
    const profit = cost ? (toSeller - cost) : null;
    const marginPct = (cost && base > 0) ? (profit / base) * 100 : null;
    const roiPct = (cost && cost > 0) ? (profit / cost) * 100 : null;
    return {
      base, cost, commission, commissionPct: commPct,
      fwdLog: fwdLogReal, retLog: retLogReal, totalLog,
      acquiring, acquiringPct: settings.acquiring_pct,
      tax, taxPct: settings.tax_pct,
      advertising, adPct: settings.ad_pct,
      ktrAvg, ktrAvgPct,
      toSeller, profit, marginPct, roiPct,
      redemption: settings.redemption_pct,
      coef, volumeKnown, whCoefData,
      model: settings.model,
      returnKind: isFbs ? 'pvz' : (isDbs ? 'self' : 'wh'),
      allModels: tariffs.commission.all_models || null,
      isOverride: overrideCommission != null,
      fbsUnavailable: tariffs.logistics.fbs_unavailable === true,
    };
  };

  const findStickyTarget = () =>
    document.querySelector('[class*="productPageAsideSticky"]') ||
    document.querySelector('[class*="productPageAside"]') ||
    document.querySelector('[class*="productSummary--"]');
  const mountInline = () => {
    const target = findStickyTarget();
    if (!target) return null;
    const existing = document.getElementById(HOST_ID);
    if (existing) return existing;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.attachShadow({ mode: 'open' });
    target.appendChild(host);
    return host;
  };


  const CSS = `
    :host { all: initial !important; display: block !important; contain: layout style !important; width: 100% !important; max-width: 360px !important; box-sizing: border-box !important; }
    * { box-sizing: border-box; }
    .rt { width: 100%; margin-top: 16px; font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background: #fff; color: #1a1a1a; border-radius: 14px; box-shadow: 0 2px 16px rgba(0,0,0,.08), 0 0 0 1px rgba(0,0,0,.05); padding: 14px; font-size: 13px; line-height: 1.45; }
    
    .hd { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 6px; }
    .hd-link {
      flex: 1; display: flex; align-items: center; gap: 6px;
      background: transparent; border: none; padding: 4px 6px; margin: -4px -6px;
      border-radius: 6px; cursor: pointer; font-family: inherit;
      font-size: 13px; font-weight: 700; color: #5b3aff;
      text-decoration: none; transition: background .15s;
    }
    .hd-link:hover { background: #f5f5f7; text-decoration: underline; }
    .hd-link .ext-icon { font-size: 10px; opacity: .6; }
    .hd-ver { font-size: 10px; color: #888; font-weight: 400; margin-left: auto; }
    .hd-arrow {
      background: transparent; border: 1px solid #e0e0e0; border-radius: 6px;
      padding: 2px 8px; cursor: pointer; color: #777; font-size: 11px;
      transition: all .15s;
    }
    .hd-arrow:hover { border-color: #5b3aff; color: #5b3aff; }
    .hd-arrow.collapsed { transform: rotate(-90deg); }
    .close { background: transparent; border: none; cursor: pointer; padding: 0 4px; font-size: 18px; color: #999; line-height: 1; }
    .close:hover { color: #1a1a1a; }
    
    .collapsed-summary {
      display: flex; justify-content: space-between; align-items: center;
      padding: 4px 0; font-size: 12px; color: #555;
    }
    .collapsed-summary b { color: #1a1a1a; font-weight: 600; }

    .toggle { display: flex; gap: 4px; background: #f5f5f7; border-radius: 8px; padding: 2px; margin-bottom: 10px; }
    .toggle button { flex: 1; border: none; background: transparent; padding: 6px 4px; border-radius: 6px; font-size: 11px; cursor: pointer; transition: all .15s; font-weight: 500; }
    .toggle button.active { background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.1); font-weight: 600; color: #5b3aff; }
    .toggle button:hover:not(.active) { background: rgba(0,0,0,.04); }
    
    .hero-twin { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
    .hero-twin > div { background: linear-gradient(135deg,#f6f3ff,#ede7ff); border-radius: 10px; padding: 10px 8px; text-align: center; }
    .ht-label { font-size: 10px; color: #555; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 3px; font-weight: 600; }
    .ht-value { font-size: 18px; font-weight: 700; color: #1a1a1a; line-height: 1.1; }
    .ht-sub { font-size: 10px; color: #777; margin-top: 2px; }
    
    .metrics { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-bottom: 10px; }
    .metric { background: #f7f7f9; border-radius: 8px; padding: 7px 5px; text-align: center; }
    .metric-label { font-size: 9px; color: #777; text-transform: uppercase; letter-spacing: .3px; }
    .metric-value { font-size: 13px; font-weight: 700; margin-top: 2px; }
    .metric-value.good { color: #2e7d32; } .metric-value.bad { color: #c62828; }
    
    /* 🆕 v0.3.5: ОБЪЕДИНЁННЫЙ блок цен — фиксированная сетка, поля не вылезают */
    .price-block { background: #f7f7f9; border-radius: 10px; padding: 10px; margin-bottom: 8px; }
    .price-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
    .price-grid > div { min-width: 0; }
    .price-grid label { display: block; font-size: 10px; color: #555; font-weight: 600; margin-bottom: 4px; }
    .price-grid .wrap { 
      display: flex; align-items: center; gap: 2px;
      background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: 0 8px;
    }
    .price-grid .wrap:focus-within { border-color: #5b3aff; }
    .price-grid input {
      flex: 1; min-width: 0; padding: 6px 0; border: none; outline: none;
      font-size: 13px; font-family: inherit; background: transparent;
    }
    .price-grid .suffix { font-size: 11px; color: #777; flex-shrink: 0; }
    .price-hint {
      font-size: 10px; color: #888; margin-bottom: 8px; line-height: 1.3; font-style: italic;
    }
    .btn-done {
      width: 100%; padding: 9px;
      background: #5b3aff; color: #fff; border: none; border-radius: 8px;
      font-size: 12px; font-weight: 700; cursor: pointer;
      letter-spacing: .5px; text-transform: uppercase;
    }
    .btn-done:hover { background: #4926d8; } .btn-done.saved { background: #2e7d32; }
    
    .breakdown { margin-top: 8px; }
    .br-row { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid #f0f0f0; font-size: 12px; }
    .br-row:last-child { border-bottom: none; }
    .br-row.total { font-weight: 700; border-top: 2px solid #1a1a1a; margin-top: 4px; padding-top: 8px; border-bottom: none; }
    .br-k { color: #555; } .br-k small { color: #999; margin-left: 4px; font-size: 10px; font-weight: 400; }
    .br-v { color: #1a1a1a; font-variant-numeric: tabular-nums; }
    
    .section-toggle {
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 0; cursor: pointer; user-select: none;
      font-size: 11px; color: #777; text-transform: uppercase; letter-spacing: .5px; font-weight: 600;
      border-top: 1px solid #f0f0f0; margin-top: 8px;
    }
    .section-toggle:hover { color: #5b3aff; }
    .section-toggle .arr { font-size: 10px; transition: transform .2s; }
    .section-toggle.collapsed .arr { transform: rotate(-90deg); }
    .section-content { padding-top: 4px; }
    .section-content.hidden { display: none; }
    
    .product-info { font-size: 11px; color: #777; margin-bottom: 10px; line-height: 1.4; padding: 7px 9px; background: #fafafa; border-radius: 6px; }
    .product-info b { color: #1a1a1a; font-weight: 500; }
    .actions { display: flex; gap: 6px; margin-top: 10px; }
    .btn-action { flex: 1; padding: 7px; border: 1px solid #e0e0e0; background: #fff; border-radius: 6px; font-size: 11px; cursor: pointer; color: #555; }
    .btn-action:hover { background: #f5f5f7; border-color: #5b3aff; color: #5b3aff; }
    
    .warn { background: #fff8e1; border: 1px solid #ffe0b2; border-radius: 8px; padding: 8px 10px; font-size: 11px; color: #856404; margin-top: 8px; }
    .info { background: #e3f2fd; border: 1px solid #bbdefb; border-radius: 8px; padding: 8px 10px; font-size: 11px; color: #0d47a1; margin-top: 8px; line-height: 1.4; }
    .tip-models { display: flex; gap: 4px; font-size: 10px; margin-top: 6px; flex-wrap: wrap; }
    .tip-models span { background: #f0f0f0; padding: 3px 7px; border-radius: 4px; color: #555; }
    .tip-models span.active { background: #5b3aff; color: #fff; font-weight: 600; }
    
    details.advanced { margin-bottom: 8px; border: 1px solid #e5e5e5; border-radius: 8px; }
    details.advanced summary { padding: 9px 12px; cursor: pointer; font-size: 12px; font-weight: 600; color: #5b3aff; user-select: none; list-style: none; }
    details.advanced summary::-webkit-details-marker { display: none; }
    details.advanced summary:before { content: '▶ '; font-size: 9px; margin-right: 4px; }
    details.advanced[open] summary:before { content: '▼ '; }
    details.advanced summary:hover { background: #f5f5f7; }
    details.advanced[open] summary { border-bottom: 1px solid #e5e5e5; }
    details.advanced .adv-block { padding: 10px 12px; }
    details.advanced .adv-block + .adv-block { border-top: 1px solid #f0f0f0; }
    .adv-label { font-size: 11px; color: #555; font-weight: 600; margin-bottom: 6px; }
    .adv-row { display: flex; align-items: center; gap: 6px; }
    .input-field { flex: 1; padding: 6px 9px; border: 1px solid #e0e0e0; border-radius: 6px; font-size: 13px; font-family: inherit; min-width: 0; background: #fff; }
    .input-field:focus { outline: none; border-color: #5b3aff; }
    .input-field-small { width: 48px; padding: 6px; border: 1px solid #e0e0e0; border-radius: 6px; font-size: 12px; font-family: inherit; text-align: center; background: #fff; }
    .input-suffix { font-size: 12px; color: #777; }
    .wh-select { width: 100%; padding: 7px 9px; border: 1px solid #e0e0e0; border-radius: 6px; font-size: 12px; background: #fff; cursor: pointer; }
    .wh-select:focus { outline: none; border-color: #5b3aff; }
    .btn-save-mini { padding: 6px 10px; background: #5b3aff; color: #fff; border: none; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .btn-save-mini:hover { background: #4926d8; } .btn-save-mini.saved { background: #2e7d32; }
    .adv-hint { font-size: 10px; color: #888; margin-top: 4px; line-height: 1.3; }
    .dim-source { font-size: 10px; color: #2e7d32; margin-top: 4px; font-weight: 600; }
  `;


  const renderHeader = (collapsed) => `
    <div class="hd">
      <a class="hd-link" id="goDash" href="${DASHBOARD_URL}" target="_blank" rel="noopener">
        📊 SW Profit <span class="ext-icon">↗</span>
        <span class="hd-ver">v${VERSION}</span>
      </a>
      <button class="hd-arrow ${collapsed?'collapsed':''}" id="toggleCollapse" title="Свернуть/развернуть">▼</button>
      <button class="close" title="Скрыть">×</button>
    </div>
  `;

  const renderWidget = ({ shadowRoot, data, financials, settings, sppAutoMode, sppAvg, displayPriceBasic }) => {
    const { apiData, savedPrice, savedCost, savedVolume, savedDims, savedCommission, volumeSource, warehouseList } = data;
    const finalVolume = savedVolume || apiData?.volume_l;
    const volumeInfo = finalVolume != null ? finalVolume + ' л' : '?';
    const weightInfo = apiData?.weight_kg != null ? apiData.weight_kg + ' кг' : '?';
    let volumeSourceText = '';
    if (volumeSource === 'auto') volumeSourceText = '✓ авточтение из карточки';
    else if (volumeSource === 'manual') volumeSourceText = '✓ ручной ввод';
    else if (volumeSource === 'api') volumeSourceText = '~ из WB API';

    // Свёрнутое состояние
    if (settings.collapsed) {
      const summary = financials
        ? '<b>' + fmtRub(financials.toSeller) + '</b> на счёт · ' + (financials.profit != null ? fmtRub(financials.profit) + ' прибыль' : 'нет закупки')
        : 'Введи цену и нажми Готово';
      shadowRoot.innerHTML = `<style>${CSS}</style>
        <div class="rt">
          ${renderHeader(true)}
          <div class="collapsed-summary">${summary}</div>
        </div>`;
      attachHandlers(shadowRoot, settings);
      return;
    }

    const heroComm = financials ? fmtRub(financials.commission) : '—';
    const heroCommSub = financials ? fmtPct(financials.commissionPct) + (financials.isOverride?' (твоя)':'') : '';
    const heroLog = financials ? fmtRub(financials.totalLog) : '—';
    const heroLogSub = financials?.whCoefData?.coef
      ? '×' + financials.whCoefData.coef + ' ' + (financials.whCoefData.source==='exact_warehouse' ? financials.whCoefData.warehouse_name : 'медиана ЦФО')
      : '';

    const whOptions = ['<option value="auto">🤖 Авто (медиана ЦФО)</option>']
      .concat((warehouseList || []).map(w =>
        '<option value="' + w.name + '"' + (settings.warehouse===w.name?' selected':'') + '>' + w.name + ' (×' + w.coef + ')</option>'
      )).join('');

    const detCol = settings.detailsCollapsed;
    
    // 🆕 v0.3.5: Цена продавца подставляется ПО УМОЛЧАНИЮ из СПП-расчёта
    // displayPriceBasic = либо savedPrice (приоритет), либо СПП-расчёт
    const priceValue = savedPrice || (sppAutoMode ? displayPriceBasic : '');

    shadowRoot.innerHTML = `
      <style>${CSS}</style>
      <div class="rt">
        ${renderHeader(false)}
        
        <div class="toggle">
          <button data-model="fbo" class="${settings.model==='fbo'?'active':''}" title="Склад WB — товар хранится у WB">FBW</button>
          <button data-model="fbs" class="${settings.model==='fbs'?'active':''}" title="Маркетплейс — товар у тебя, доставляет WB">FBS</button>
          <button data-model="dbs" class="${settings.model==='dbs'?'active':''}" title="Витрина/Курьер — товар у тебя, доставляешь сам">DBS</button>
        </div>
        
        <div class="hero-twin">
          <div><div class="ht-label">Комиссия ${settings.model==='fbo'?'FBW':(settings.model==='fbs'?'FBS':'DBS')}</div><div class="ht-value">${heroComm}</div><div class="ht-sub">${heroCommSub}</div></div>
          <div><div class="ht-label">Логистика</div><div class="ht-value">${heroLog}</div><div class="ht-sub">${heroLogSub}</div></div>
        </div>
        ${financials?.fbsUnavailable ? '<div class="warn">⚠️ На складе ' + (financials.whCoefData?.warehouse_name || '?') + ' модель FBS недоступна. Цифры рассчитаны по тарифам FBW. Выбери другой склад для точного расчёта FBS.</div>' : ''}

        <!-- 🆕 ОБЪЕДИНЁННЫЙ блок цен — одна кнопка Готово на оба поля -->
        <div class="price-block">
          <div class="price-grid">
            <div>
              <label>💰 Цена продавца</label>
              <div class="wrap">
                <input type="number" id="priceBasic" placeholder="—" value="${priceValue}">
                <span class="suffix">₽</span>
              </div>
            </div>
            <div>
              <label>📦 Закупка</label>
              <div class="wrap">
                <input type="number" id="cost" placeholder="—" value="${savedCost||''}">
                <span class="suffix">₽</span>
              </div>
            </div>
          </div>
          ${sppAutoMode && !savedPrice && apiData?.priceProduct
            ? '<div class="price-hint">Цена продавца — автоматически по средней СПП ' + sppAvg + '% от витрины ' + fmtRub(apiData.priceProduct) + '. Если знаешь точную из ЛК — впиши её.</div>'
            : ''}
          <button class="btn-done" id="saveBoth">Готово</button>
        </div>

        <div class="product-info">
          <b>${apiData?.entity||'—'}</b>${apiData?.brand ? ' · ' + apiData.brand : ''} · Объём <b>${volumeInfo}</b> · Вес <b>${weightInfo}</b>${apiData?.subjectId ? ' · ID <b>' + apiData.subjectId + '</b>' : ''}
          ${volumeSourceText ? '<div class="dim-source">' + volumeSourceText + '</div>' : ''}
        </div>

        <!-- 🆕 v0.3.5: единый advanced со складом, габаритами и комиссией -->
        <details class="advanced">
          <summary>⚙️ Уточнить расчёт (склад, габариты, комиссия)</summary>
          <div class="adv-block">
            <div class="adv-label">🏭 Склад отгрузки</div>
            <select class="wh-select" id="warehouse">${whOptions}</select>
            <div class="adv-hint">Авто — медиана ЦФО (≈1.6×). Выбор склада меняет коэф логистики.</div>
          </div>
          <div class="adv-block">
            <div class="adv-label">📐 Габариты упаковки (Д×Ш×В см)</div>
            <div class="adv-row">
              <input type="number" class="input-field-small" id="dimL" placeholder="Д" value="${savedDims?.L||''}">
              <span class="input-suffix">×</span>
              <input type="number" class="input-field-small" id="dimW" placeholder="Ш" value="${savedDims?.W||''}">
              <span class="input-suffix">×</span>
              <input type="number" class="input-field-small" id="dimH" placeholder="В" value="${savedDims?.H||''}">
              <button class="btn-save-mini" id="saveDims">💾</button>
            </div>
            <div class="adv-hint">Если авточтение из карточки не подтянуло точные размеры — впиши.</div>
          </div>
          <div class="adv-block">
            <div class="adv-label">📊 Реальная комиссия из ЛК (${settings.model==='fbo'?'FBW':settings.model.toUpperCase()})</div>
            <div class="adv-row">
              <input type="number" class="input-field" id="commOverride" placeholder="базовая ${financials?.commissionPct||'?'}%" value="${savedCommission?.[settings.model]||''}" step="0.1">
              <span class="input-suffix">%</span>
              <button class="btn-save-mini" id="saveComm">💾</button>
            </div>
            <div class="adv-hint">WB иногда неточно категоризирует товар. Базовая категорийная (${financials?.commissionPct||'?'}%) может не совпадать с твоей фактической из ЛК.</div>
          </div>
        </details>

        ${financials ? `
          <div class="section-toggle ${detCol?'collapsed':''}" id="toggleDetails">
            <span>📊 Расчёт и показатели</span>
            <span class="arr">▼</span>
          </div>
          <div class="section-content ${detCol?'hidden':''}" id="detailsContent">
            ${financials.cost ? `
              <div class="metrics">
                <div class="metric"><div class="metric-label">Прибыль</div><div class="metric-value ${financials.profit>=0?'good':'bad'}">${fmtRub(financials.profit)}</div></div>
                <div class="metric"><div class="metric-label">Маржа</div><div class="metric-value ${financials.marginPct>=15?'good':'bad'}">${fmtPct(financials.marginPct)}</div></div>
                <div class="metric"><div class="metric-label">ROI</div><div class="metric-value ${financials.roiPct>=30?'good':'bad'}">${fmtPct(financials.roiPct)}</div></div>
              </div>
            ` : ''}
            <div class="breakdown">
              <div class="br-row"><span class="br-k">Цена продавца</span><span class="br-v">${fmtRub(financials.base)}</span></div>
              <div class="br-row"><span class="br-k">Комиссия WB <small>${fmtPct(financials.commissionPct)}${financials.isOverride?' (твоя)':''}</small></span><span class="br-v">−${fmtRub(financials.commission)}</span></div>
              ${financials.volumeKnown ? `
                <div class="br-row"><span class="br-k">Прямая логистика ${financials.coef!==1.0?'<small>×'+financials.coef+'</small>':''}</span><span class="br-v">−${fmtRub(financials.fwdLog)}</span></div>
                ${financials.retLog > 0 ? `<div class="br-row"><span class="br-k">${financials.returnKind==='pvz'?'Возврат в ПВЗ':'Возврат на склад'} <small>${100-financials.redemption}% невыкуп</small></span><span class="br-v">−${fmtRub(financials.retLog)}</span></div>` : ''}
              ` : '<div class="warn">⚠️ Объём не указан — логистика не посчитана</div>'}
              <div class="br-row"><span class="br-k">Реклама <small>${fmtPct(financials.adPct)}</small></span><span class="br-v">−${fmtRub(financials.advertising)}</span></div>
              <div class="br-row"><span class="br-k">Налог <small>${fmtPct(financials.taxPct)}</small></span><span class="br-v">−${fmtRub(financials.tax)}</span></div>
              <div class="br-row"><span class="br-k">Эквайринг <small>${fmtPct(financials.acquiringPct)}</small></span><span class="br-v">−${fmtRub(financials.acquiring)}</span></div>
              <div class="br-row"><span class="br-k">КТР <small>~${fmtPct(financials.ktrAvgPct)}</small></span><span class="br-v">−${fmtRub(financials.ktrAvg)}</span></div>
              <div class="br-row total"><span class="br-k">На счёт</span><span class="br-v">${fmtRub(financials.toSeller)}</span></div>
              ${financials.cost ? `
                <div class="br-row"><span class="br-k">− Закупка</span><span class="br-v">−${fmtRub(financials.cost)}</span></div>
                <div class="br-row total"><span class="br-k">Чистая прибыль</span><span class="br-v" style="color:${financials.profit>=0?'#2e7d32':'#c62828'}">${fmtRub(financials.profit)}</span></div>
              ` : ''}
            </div>
            ${financials.allModels ? `
              <div class="tip-models" style="margin-top:10px">
                <span class="${financials.model==='fbo'?'active':''}" title="Склад WB">FBW ${fmtPct(financials.allModels.fbo)}</span>
                <span class="${financials.model==='fbs'?'active':''}">FBS ${fmtPct(financials.allModels.fbs)}</span>
                <span class="${financials.model==='dbs'?'active':''}">DBS ${fmtPct(financials.allModels.dbs)}</span>
                <span title="Витрина экспресс">EDBS ${fmtPct(financials.allModels.dbs_express)}</span>
              </div>
            ` : ''}
            <!-- 🆕 v0.3.5: убрана кнопка Настройки, осталась только Кабинет -->
            <div class="actions">
              <button class="btn-action" id="openDash">📈 Открыть кабинет SW Profit</button>
            </div>
          </div>
        ` : '<div class="info">👆 Цена продавца уже подставлена (по средней СПП). Нажми «Готово» — увидишь расчёт.</div>'}
      </div>
    `;
    attachHandlers(shadowRoot, settings);
  };


  const attachHandlers = (shadowRoot, settings) => {
    const root = shadowRoot.querySelector('.rt');
    ['click', 'mousedown', 'pointerdown'].forEach(ev => {
      root.addEventListener(ev, e => e.stopPropagation(), false);
    });
    
    // Кнопка-шеврон сворачивает виджет
    const toggleBtn = shadowRoot.getElementById('toggleCollapse');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await saveSetting('collapsed', !settings.collapsed);
        run();
      });
    }
    
    // Ссылка-логотип "SW Profit ↗" — ОТКРЫВАЕТ КАБИНЕТ
    const dashLink = shadowRoot.getElementById('goDash');
    if (dashLink) {
      dashLink.addEventListener('click', (e) => {
        // <a target=_blank> сам откроет в новой вкладке; просто гарантируем что не свернёт
        e.stopPropagation();
      });
    }
    
    // Сворачивание расчётов
    const toggleDetails = shadowRoot.getElementById('toggleDetails');
    if (toggleDetails) {
      toggleDetails.addEventListener('click', async (e) => {
        e.preventDefault();
        const content = shadowRoot.getElementById('detailsContent');
        const isCollapsed = content.classList.contains('hidden');
        content.classList.toggle('hidden', !isCollapsed);
        toggleDetails.classList.toggle('collapsed', !isCollapsed);
        await saveSetting('detailsCollapsed', !isCollapsed);
      });
    }
    
    shadowRoot.querySelectorAll('.toggle button').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const newModel = btn.dataset.model;
        if (newModel === settings.model) return;
        await saveSetting('model', newModel);
        run();
      });
    });
    
    // ОДНА кнопка Готово на оба поля (цена + закупка)
    const priceInput = shadowRoot.getElementById('priceBasic');
    const costInput = shadowRoot.getElementById('cost');
    const saveBoth = shadowRoot.getElementById('saveBoth');
    if (saveBoth) {
      const doSave = async () => {
        const priceVal = parseFloat(priceInput?.value);
        const costVal = parseFloat(costInput?.value);
        const nmId = nmIdFromUrl();
        if (!nmId) return;
        const cur = await getSettings();
        if (priceVal > 0) cur.prices[nmId] = priceVal;
        else delete cur.prices[nmId];
        if (costVal > 0) cur.costs[nmId] = costVal;
        else if (costInput?.value === '') delete cur.costs[nmId];
        await chrome.storage.local.set({prices: cur.prices, costs: cur.costs});
        saveBoth.textContent = '✓ Сохранено';
        saveBoth.classList.add('saved');
        setTimeout(() => run(), 400);
      };
      saveBoth.addEventListener('click', (e) => { e.preventDefault(); doSave(); });
      [priceInput, costInput].forEach(inp => {
        if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
      });
    }
    
    const whSelect = shadowRoot.getElementById('warehouse');
    if (whSelect) {
      whSelect.addEventListener('change', async () => {
        await saveSetting('warehouse', whSelect.value);
        tariffsCache.clear();
        run();
      });
    }
    const saveDimsBtn = shadowRoot.getElementById('saveDims');
    if (saveDimsBtn) {
      saveDimsBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const L = parseFloat(shadowRoot.getElementById('dimL').value);
        const W = parseFloat(shadowRoot.getElementById('dimW').value);
        const H = parseFloat(shadowRoot.getElementById('dimH').value);
        const nmId = nmIdFromUrl();
        if (!nmId || !L || !W || !H) return;
        const volL = Math.round((L*W*H/1000)*1000)/1000;
        const cur = await getSettings();
        cur.volumes[nmId] = volL;
        cur.dims[nmId] = { L, W, H };
        cur.auto_dims_disabled[nmId] = true;
        await chrome.storage.local.set({ volumes: cur.volumes, dims: cur.dims, auto_dims_disabled: cur.auto_dims_disabled });
        saveDimsBtn.textContent = '✓';
        saveDimsBtn.classList.add('saved');
        setTimeout(() => run(), 300);
      });
    }
    const saveCommBtn = shadowRoot.getElementById('saveComm');
    if (saveCommBtn) {
      saveCommBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const val = parseFloat(shadowRoot.getElementById('commOverride').value);
        const nmId = nmIdFromUrl();
        if (!nmId) return;
        const cur = await getSettings();
        if (!cur.commissions[nmId]) cur.commissions[nmId] = {};
        if (val > 0 && val <= 100) cur.commissions[nmId][settings.model] = val;
        else delete cur.commissions[nmId][settings.model];
        await saveSetting('commissions', cur.commissions);
        saveCommBtn.textContent = '✓';
        saveCommBtn.classList.add('saved');
        setTimeout(() => run(), 300);
      });
    }
    const closeBtn = shadowRoot.querySelector('.close');
    if (closeBtn) closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const host = document.getElementById(HOST_ID);
      if (host) host.style.display = 'none';
    });
    const openDash = shadowRoot.getElementById('openDash');
    if (openDash) openDash.addEventListener('click', () => window.open(DASHBOARD_URL, '_blank'));
  };

  const POPULAR_WAREHOUSES = [
    { name: 'Коледино', coef: 1.95 }, { name: 'Тула', coef: 1.50 },
    { name: 'Электросталь', coef: 1.60 }, { name: 'Подольск', coef: 2.00 },
    { name: 'Чехов 1', coef: 2.05 }, { name: 'Чехов 2', coef: 2.05 },
    { name: 'Белая дача', coef: 1.95 }, { name: 'Краснодар', coef: 1.60 },
    { name: 'Казань', coef: 2.20 }, { name: 'Новосибирск', coef: 4.45 },
    { name: 'Хабаровск', coef: 2.20 },
  ];

  let isRunning = false;
  const run = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      const nmId = nmIdFromUrl();
      if (!nmId) return;
      const settings = await getSettings();
      const savedPrice = settings.prices[nmId];
      const savedCost = settings.costs[nmId];
      let savedVolume = settings.volumes[nmId];
      const savedDims = settings.dims[nmId];
      const savedCommission = settings.commissions[nmId];
      const apiData = await fetchWbCard(nmId);
      const breadcrumb = parseBreadcrumb();
      let volumeSource = 'api';
      if (savedVolume) {
        volumeSource = savedDims ? 'auto' : 'manual';
      } else if (!settings.auto_dims_disabled[nmId]) {
        const dims = await fetchDimensionsViaDrawer();
        if (dims) {
          const cur = await getSettings();
          cur.volumes[nmId] = dims.volume_l;
          cur.dims[nmId] = { L: dims.L, W: dims.W, H: dims.H };
          await chrome.storage.local.set({ volumes: cur.volumes, dims: cur.dims });
          savedVolume = dims.volume_l;
          volumeSource = 'auto';
        } else {
          const cur = await getSettings();
          cur.auto_dims_disabled[nmId] = true;
          await saveSetting('auto_dims_disabled', cur.auto_dims_disabled);
        }
      }
      const SPP_AVG = 27;
      let priceBasic = savedPrice || null;
      let sppAutoMode = false;
      let displayPriceBasic = '';
      if (!priceBasic && apiData?.priceProduct) {
        priceBasic = Math.round(apiData.priceProduct / (1 - SPP_AVG/100));
        displayPriceBasic = priceBasic;
        sppAutoMode = true;
      }
      const cost = savedCost || null;
      const volume_l = savedVolume || apiData?.volume_l || 0;
      const warehouse = settings.warehouse || 'auto';
      const tariffs = priceBasic && apiData?.subjectId
        ? await fetchTariffs({
            subject_id: apiData.subjectId,
            subject: apiData?.entity || breadcrumb.subject,
            parent: breadcrumb.parent,
            volume: volume_l, model: settings.model, warehouse,
          })
        : null;
      const overrideCommission = savedCommission ? savedCommission[settings.model] : null;
      const financials = priceBasic && tariffs
        ? computeFinancials({ priceBasic, cost, tariffs, settings, volumeKnown: volume_l > 0, overrideCommission })
        : null;
      let host = document.getElementById(HOST_ID);
      if (!host) host = mountInline();
      if (!host) { setTimeout(() => { isRunning = false; run(); }, 1000); return; }
      host.style.display = '';
      renderWidget({
        shadowRoot: host.shadowRoot,
        data: { apiData, savedPrice, savedCost, savedVolume, savedDims, savedCommission, volumeSource, warehouseList: POPULAR_WAREHOUSES },
        financials, settings, sppAutoMode, sppAvg: SPP_AVG, displayPriceBasic,
      });
    } catch (e) { console.error('[SW Profit] run error:', e); }
    finally { isRunning = false; }
  };

  const start = async () => {
    for (let i = 0; i < 30; i++) {
      if (document.querySelector('[class*="productPageAside"], [class*="productSummary--"], [itemtype*="BreadcrumbList"]')) break;
      await sleep(500);
    }
    log('Starting v' + VERSION);
    run();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const old = document.getElementById(HOST_ID);
      if (old) old.remove();
      tariffsCache.clear();
      if (nmIdFromUrl()) setTimeout(run, 1500);
    }
  }, 1500);
})();
