(function () {
  'use strict';

  const M = window.MercadorIA;
  if (!M) return;
  const { auth, db } = M;

  const state = {
    uid: null,
    items: {},
    markets: {},
    units: {},
    promotions: {},
    location: null,
    radiusKm: 5,
    listenersStarted: false,
    offers: [],
    groupedOffers: new Map()
  };

  const $ = (id) => document.getElementById(id);
  let decorateTimer = 0;
  let listObserver = null;

  function setStatus(message) {
    const el = $('geo-promo-status');
    if (el) el.textContent = message;
  }

  function getPendingItems() {
    return Object.entries(state.items || {})
      .map(([id, item]) => ({ id, ...item }))
      .filter((item) => item && item.status === 'faltando');
  }

  function sortOffers(list) {
    return [...list].sort((a, b) => {
      const pa = Number(a.promo && a.promo.price);
      const pb = Number(b.promo && b.promo.price);
      if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb;
      return Number(a.distanceKm || 0) - Number(b.distanceKm || 0);
    });
  }

  function buildGroups(offers) {
    const grouped = new Map();
    for (const offer of offers || []) {
      const key = String(offer.item && offer.item.id != null ? offer.item.id : '');
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(offer);
    }
    for (const [key, list] of grouped) grouped.set(key, sortOffers(list));
    return grouped;
  }

  function uniqueMarketCount(offers) {
    return new Set((offers || []).map((o) => String(o.market && (o.market.id || o.promo && o.promo.marketId) || o.market && o.market.name || ''))).size;
  }

  function scheduleDecorate() {
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(decorateItemRows, 20);
  }

  function updatePurchaseProgress() {
    const el = $('purchase-progress');
    if (!el) return;
    const all = Object.values(state.items || {}).filter(Boolean);
    const pending = all.filter((x) => x.status === 'faltando').length;
    const bought = all.filter((x) => x.status === 'comprado').length;
    if (!all.length) el.textContent = 'Sua lista está vazia';
    else if (!pending) el.textContent = bought ? `${bought} comprado${bought === 1 ? '' : 's'} · nada faltando` : 'Nada para comprar';
    else el.textContent = `${pending} para comprar${bought ? ` · ${bought} no carrinho` : ''}`;
  }

  function renderCompactSummary() {
    const results = $('geo-promo-results');
    const summary = $('geo-promo-summary');
    if (!summary) return;

    const pending = getPendingItems();
    updatePurchaseProgress();

    if (!state.location) {
      summary.textContent = 'Ative a localização para comparar';
      if (results) results.textContent = 'A lista continua funcionando normalmente. A localização é usada somente no aparelho para encontrar ofertas próximas.';
      state.offers = [];
      state.groupedOffers = new Map();
      scheduleDecorate();
      return;
    }

    if (!pending.length) {
      summary.textContent = 'Nenhum item em A Comprar';
      if (results) results.textContent = 'Adicione produtos à lista para comparar promoções próximas.';
      state.offers = [];
      state.groupedOffers = new Map();
      scheduleDecorate();
      return;
    }

    const offers = M.findMatchingOffers({
      items: pending,
      promotions: state.promotions,
      units: state.units,
      markets: state.markets,
      location: state.location,
      radiusKm: state.radiusKm
    });

    state.offers = offers;
    state.groupedOffers = buildGroups(offers);

    const itemsWithOffers = state.groupedOffers.size;
    const markets = uniqueMarketCount(offers);
    summary.textContent = itemsWithOffers
      ? `${itemsWithOffers} de ${pending.length} item${pending.length === 1 ? '' : 's'} com oferta`
      : `Nenhuma oferta em ${state.radiusKm} km`;

    if (results) {
      results.textContent = itemsWithOffers
        ? `${offers.length} oferta${offers.length === 1 ? '' : 's'} verificada${offers.length === 1 ? '' : 's'} em ${markets} mercado${markets === 1 ? '' : 's'}. A melhor aparece diretamente em cada item.`
        : `Nenhuma promoção válida e conferida dos seus itens foi encontrada em até ${state.radiusKm} km agora.`;
    }

    scheduleDecorate();
  }

  function offerSignature(itemId, offers) {
    if (!state.location) return 'no-location';
    if (!offers || !offers.length) return `no-offer:${state.radiusKm}`;
    const best = offers[0];
    return [
      itemId,
      state.radiusKm,
      offers.length,
      best.promo && best.promo.id,
      best.promo && best.promo.price,
      best.market && best.market.name,
      Number(best.distanceKm || 0).toFixed(2)
    ].join('|');
  }

  function decorateItemRows() {
    const list = $('lista-faltando');
    if (!list) return;
    const rows = list.querySelectorAll('.item-row[data-id]');

    rows.forEach((row) => {
      const itemId = String(row.dataset.id || '');
      const details = row.querySelector('.item-details');
      if (!details || !itemId) return;

      const offers = state.groupedOffers.get(itemId) || [];
      const signature = offerSignature(itemId, offers);
      let zone = details.querySelector('.item-offer-zone');
      if (zone && zone.dataset.signature === signature) return;
      if (zone) zone.remove();

      if (!state.location) return;

      zone = document.createElement('div');
      zone.className = 'item-offer-zone item-offer-action';
      zone.dataset.signature = signature;

      if (!offers.length) {
        zone.classList.add('no-offer');
        zone.textContent = `Sem oferta verificada em até ${state.radiusKm} km`;
        details.appendChild(zone);
        return;
      }

      const best = offers[0];
      const market = best.market && best.market.name ? best.market.name : 'Mercado';
      const unit = best.unit && best.unit.name ? best.unit.name : '';
      const price = M.formatCurrency(best.promo.price);
      const distance = Number(best.distanceKm || 0).toFixed(1).replace('.', ',');
      const countLabel = offers.length === 1 ? 'Ver oferta' : `Ver ${offers.length} ofertas`;

      zone.innerHTML = `
        <div class="item-offer-best">
          <span class="item-offer-flame" aria-hidden="true">🔥</span>
          <span class="item-offer-market">${M.escapeHtml(market)}${unit ? ` · ${M.escapeHtml(unit)}` : ''}</span>
          <span class="item-offer-price">${price}</span>
        </div>
        <div class="item-offer-sub">
          <span class="item-offer-distance">📍 ${distance} km · melhor preço encontrado</span>
          <button type="button" class="item-offer-action" data-offers-item="${M.escapeHtml(itemId)}">${countLabel}</button>
        </div>`;
      details.appendChild(zone);
    });
  }

  function ensureOfferSheet() {
    let overlay = $('offer-sheet-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'offer-sheet-overlay';
    overlay.className = 'offer-sheet-overlay item-offer-action';
    overlay.innerHTML = `
      <section class="offer-sheet" role="dialog" aria-modal="true" aria-labelledby="offer-sheet-heading">
        <header class="offer-sheet-head">
          <div class="offer-sheet-title">
            <strong id="offer-sheet-heading">Ofertas</strong>
            <span id="offer-sheet-subtitle"></span>
          </div>
          <button type="button" class="offer-sheet-close item-offer-action" data-close-offer-sheet aria-label="Fechar">×</button>
        </header>
        <div id="offer-sheet-body" class="offer-sheet-body"></div>
      </section>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  function offerCardHtml(offer, index, nearestDistance) {
    const p = offer.promo || {};
    const marketName = offer.market && offer.market.name ? offer.market.name : 'Mercado';
    const unitName = offer.unit && offer.unit.name ? offer.unit.name : 'Unidade';
    const previous = Number(p.previousPrice);
    const price = Number(p.price);
    const saving = Number.isFinite(previous) && previous > price ? previous - price : 0;
    const distance = Number(offer.distanceKm || 0);
    const isNearest = Math.abs(distance - nearestDistance) < 0.001;
    const destination = offer.unit && Number.isFinite(Number(offer.unit.lat)) && Number.isFinite(Number(offer.unit.lng))
      ? `${offer.unit.lat},${offer.unit.lng}`
      : `${marketName} ${unitName}`;
    const route = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;

    return `<article class="offer-sheet-card${index === 0 ? ' best' : ''}">
      <div class="offer-sheet-card-top">
        <div>
          <div class="offer-sheet-market">${M.escapeHtml(marketName)} · ${M.escapeHtml(unitName)}</div>
          <div class="offer-sheet-product">${M.escapeHtml(p.productName || '')}${p.brand ? ` · ${M.escapeHtml(p.brand)}` : ''}${p.packageText ? ` · ${M.escapeHtml(p.packageText)}` : ''}</div>
        </div>
        <div class="offer-sheet-price">${M.formatCurrency(price)}</div>
      </div>
      <div class="offer-sheet-meta">
        ${index === 0 ? '<span class="offer-pill best">⭐ Menor preço</span>' : ''}
        ${isNearest ? '<span class="offer-pill">📍 Mais perto</span>' : ''}
        <span class="offer-pill">${distance.toFixed(1).replace('.', ',')} km</span>
        ${saving > 0 ? `<span class="offer-pill best">economiza ${M.formatCurrency(saving)}</span>` : ''}
        <span class="offer-pill best">✓ valor conferido</span>
        ${p.endAt ? `<span class="offer-pill">até ${M.formatDateTime(p.endAt)}</span>` : ''}
      </div>
      <div class="offer-sheet-actions"><a class="item-offer-action" target="_blank" rel="noopener" href="${route}">Abrir rota</a></div>
    </article>`;
  }

  function openOfferSheet(itemId) {
    const offers = sortOffers(state.groupedOffers.get(String(itemId)) || []);
    if (!offers.length) return;
    const overlay = ensureOfferSheet();
    const item = offers[0].item || {};
    const heading = $('offer-sheet-heading');
    const subtitle = $('offer-sheet-subtitle');
    const body = $('offer-sheet-body');
    const nearestDistance = Math.min(...offers.map((x) => Number(x.distanceKm || Infinity)));

    if (heading) heading.textContent = item.nome || item.name || 'Ofertas do item';
    if (subtitle) subtitle.textContent = `${offers.length} oferta${offers.length === 1 ? '' : 's'} em até ${state.radiusKm} km · menor preço primeiro`;
    if (body) body.innerHTML = offers.map((offer, index) => offerCardHtml(offer, index, nearestDistance)).join('');
    overlay.classList.add('visible');
    document.documentElement.style.overflow = 'hidden';
  }

  function closeOfferSheet() {
    const overlay = $('offer-sheet-overlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
    document.documentElement.style.overflow = '';
  }

  function startListObserver() {
    const list = $('lista-faltando');
    if (!list || listObserver) return;
    listObserver = new MutationObserver(() => scheduleDecorate());
    listObserver.observe(list, { childList: true, subtree: true });
  }

  function startRealtimeListeners() {
    if (state.listenersStarted || !state.uid) return;
    state.listenersStarted = true;
    db.ref(`shopping_lists/${state.uid}`).on('value', (snap) => {
      state.items = snap.val() || {};
      renderCompactSummary();
    });
    db.ref('markets').on('value', (snap) => {
      state.markets = snap.val() || {};
      renderCompactSummary();
    });
    db.ref('market_units').on('value', (snap) => {
      state.units = snap.val() || {};
      renderCompactSummary();
    });
    db.ref('promotions').on('value', (snap) => {
      state.promotions = snap.val() || {};
      renderCompactSummary();
    });
  }

  async function loadSettings() {
    if (!state.uid) return;
    const snap = await db.ref(`user_settings/${state.uid}/radiusKm`).once('value');
    const saved = Number(snap.val());
    if ([1, 3, 5, 10, 25].includes(saved)) state.radiusKm = saved;
    if ($('geo-promo-radius')) $('geo-promo-radius').value = String(state.radiusKm);
  }

  async function locateAndSearch(options) {
    if (!state.uid) return;
    const automatic = Boolean(options && options.automatic);
    const button = $('geo-promo-locate');
    if (button && !automatic) {
      button.disabled = true;
      button.textContent = 'Localizando...';
    }
    try {
      state.radiusKm = Number($('geo-promo-radius') && $('geo-promo-radius').value || state.radiusKm || 5);
      if (!automatic) {
        await db.ref(`user_settings/${state.uid}`).update({ radiusKm: state.radiusKm, updatedAt: M.serverTimestamp });
      }
      const pos = await M.getCurrentPosition();
      state.location = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy
      };
      setStatus(`Localização atualizada · precisão aproximada ${Math.round(pos.coords.accuracy)} m · raio ${state.radiusKm} km.`);
      if (button) button.textContent = 'Atualizar localização e ofertas';
      renderCompactSummary();
      if (!automatic) {
        $('geo-promo-strip') && $('geo-promo-strip').classList.remove('open');
        M.toast('Ofertas próximas atualizadas na sua lista.', 'success');
      }
    } catch (error) {
      if (!automatic) {
        setStatus(error.message || 'Não foi possível usar sua localização.');
        M.toast(error.message || 'Falha ao localizar.', 'error');
      }
    } finally {
      if (button && !automatic) {
        button.disabled = false;
        button.textContent = 'Atualizar localização e ofertas';
      }
    }
  }

  async function autoLocateIfAlreadyAllowed() {
    if (!navigator.geolocation || !navigator.permissions || !navigator.permissions.query) return;
    try {
      const permission = await navigator.permissions.query({ name: 'geolocation' });
      if (permission.state === 'granted') await locateAndSearch({ automatic: true });
    } catch (_) {
      /* Navegadores que não expõem Permissions API continuam com o botão manual. */
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    startListObserver();
    ensureOfferSheet();

    $('geo-promo-toggle')?.addEventListener('click', () => $('geo-promo-strip')?.classList.toggle('open'));
    $('geo-promo-locate')?.addEventListener('click', () => locateAndSearch({ automatic: false }));
    $('geo-promo-radius')?.addEventListener('change', async (event) => {
      state.radiusKm = Number(event.target.value || 5);
      if (state.uid) {
        await db.ref(`user_settings/${state.uid}`).update({ radiusKm: state.radiusKm, updatedAt: M.serverTimestamp }).catch(() => {});
      }
      if (state.location) renderCompactSummary();
    });

    document.addEventListener('click', (event) => {
      const offerButton = event.target.closest('[data-offers-item]');
      if (offerButton) {
        event.preventDefault();
        event.stopPropagation();
        openOfferSheet(offerButton.dataset.offersItem);
        return;
      }
      if (event.target.closest('[data-close-offer-sheet]')) {
        event.preventDefault();
        event.stopPropagation();
        closeOfferSheet();
        return;
      }
      const overlay = event.target.closest('#offer-sheet-overlay');
      if (overlay && event.target === overlay) closeOfferSheet();
    }, true);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeOfferSheet();
    });
  });

  auth.onAuthStateChanged(async (user) => {
    if (!user) return;
    state.uid = user.uid;
    try {
      await loadSettings();
      startRealtimeListeners();
      await autoLocateIfAlreadyAllowed();
    } catch (error) {
      console.warn('[Mercador IA] Não foi possível iniciar promoções próximas:', error);
      startRealtimeListeners();
    }
  });
})();
