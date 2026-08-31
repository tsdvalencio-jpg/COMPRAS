(function () {
  'use strict';

  const M = window.MercadorIA;

  const CATEGORY_TERMS = {
    arroz: ['arroz'],
    feijao: ['feijao'],
    cafe: ['cafe', 'cappuccino'],
    leite: ['leite integral', 'leite desnatado', 'leite semidesnatado', 'leite uht', 'leite'],
    chocolate: ['chocolate', 'barra chocolate', 'bombom'],
    acucar: ['acucar'],
    oleo: ['oleo soja', 'oleo'],
    macarrao: ['macarrao', 'massa espaguete', 'espaguete'],
    farinha: ['farinha trigo', 'farinha'],
    pao: ['pao forma', 'pao'],
    manteiga: ['manteiga'],
    margarina: ['margarina'],
    queijo: ['queijo', 'mussarela', 'mucarela'],
    presunto: ['presunto'],
    carne: ['carne bovina', 'patinho', 'acem', 'contrafile', 'picanha', 'alcatra'],
    frango: ['frango', 'peito frango', 'coxa frango'],
    peixe: ['peixe', 'tilapia', 'sardinha'],
    ovo: ['ovo', 'ovos'],
    tomate: ['tomate'],
    cebola: ['cebola'],
    batata: ['batata'],
    banana: ['banana'],
    maca: ['maca'],
    laranja: ['laranja'],
    refrigerante: ['refrigerante', 'coca cola', 'guarana', 'fanta', 'sprite'],
    agua: ['agua mineral', 'agua'],
    cerveja: ['cerveja'],
    detergente: ['detergente'],
    sabao: ['sabao po', 'sabao liquido', 'sabao'],
    papel_higienico: ['papel higienico'],
    shampoo: ['shampoo'],
    sabonete: ['sabonete'],
    creme_dental: ['creme dental', 'pasta dente'],
    fralda: ['fralda'],
    racao: ['racao cachorro', 'racao gato', 'racao']
  };

  const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'com', 'sem', 'para', 'por', 'tipo', 'pct', 'pacote', 'un', 'unidade', 'unidades']);

  function tokens(value) {
    return M.normalizeText(value).split(' ').filter((t) => t.length >= 2 && !STOP.has(t));
  }

  function containsPhrase(text, phrase) {
    const t = ` ${M.normalizeText(text)} `;
    const p = ` ${M.normalizeText(phrase)} `;
    return t.includes(p);
  }

  M.inferCategory = function inferCategory(value) {
    const text = M.normalizeText(value);
    let best = null;
    let bestLen = 0;
    for (const [category, terms] of Object.entries(CATEGORY_TERMS)) {
      for (const term of terms) {
        const normalized = M.normalizeText(term);
        if (containsPhrase(text, normalized) && normalized.length > bestLen) {
          best = category;
          bestLen = normalized.length;
        }
      }
    }
    return best;
  };

  M.humanCategory = function humanCategory(value) {
    const map = {
      papel_higienico: 'Papel higiênico',
      creme_dental: 'Creme dental'
    };
    if (!value) return 'Outros';
    return map[value] || value.replaceAll('_', ' ').replace(/(^|\s)\S/g, (s) => s.toUpperCase());
  };

  M.scorePromotionMatch = function scorePromotionMatch(item, promo) {
    const itemName = M.normalizeText(item.name || item.nome || '');
    const promoText = M.normalizeText([
      promo.productName,
      promo.brand,
      promo.packageText,
      promo.aliases
    ].filter(Boolean).join(' '));

    if (!itemName || !promoText) return { score: 0, reason: 'sem_texto' };

    const itemCategory = item.category || M.inferCategory(item.name || item.nome);
    const promoCategory = promo.category || M.inferCategory(promoText);

    if (itemCategory && promoCategory && itemCategory !== promoCategory) {
      return { score: 0, reason: 'categoria_diferente', itemCategory, promoCategory };
    }

    let score = 0;
    const reasons = [];

    if (itemName === promoText) {
      score = 1;
      reasons.push('nome_exato');
    } else if (containsPhrase(promoText, itemName)) {
      score += 0.72;
      reasons.push('produto_contem_item');
    }

    if (itemCategory && promoCategory && itemCategory === promoCategory) {
      score += 0.24;
      reasons.push('categoria_igual');
    }

    const a = new Set(tokens(itemName));
    const b = new Set(tokens(promoText));
    const common = [...a].filter((token) => b.has(token));
    const overlap = a.size ? common.length / a.size : 0;
    score += Math.min(0.38, overlap * 0.38);
    if (overlap > 0) reasons.push(`tokens_${Math.round(overlap * 100)}`);

    if (promo.aliases) {
      const aliases = String(promo.aliases).split(',').map(M.normalizeText).filter(Boolean);
      if (aliases.some((alias) => alias === itemName || containsPhrase(itemName, alias) || containsPhrase(alias, itemName))) {
        score += 0.18;
        reasons.push('alias');
      }
    }

    return {
      score: Math.min(1, score),
      reason: reasons.join('+') || 'baixa_correspondencia',
      itemCategory,
      promoCategory
    };
  };

  M.findMatchingOffers = function findMatchingOffers({ items, promotions, units, markets, location, radiusKm }) {
    if (!location) return [];
    const now = Date.now();
    const unitMap = new Map(Object.entries(units || {}).map(([id, value]) => [id, { id, ...value }]));
    const marketMap = new Map(Object.entries(markets || {}).map(([id, value]) => [id, { id, ...value }]));
    const offers = [];

    for (const [promoId, promo] of Object.entries(promotions || {})) {
      if (!promo || promo.active !== true || promo.verified !== true) continue;
      if (promo.startAt && now < Number(promo.startAt)) continue;
      if (promo.endAt && now > Number(promo.endAt)) continue;
      const unit = unitMap.get(promo.unitId);
      if (!unit || unit.active !== true) continue;
      const market = marketMap.get(promo.marketId || unit.marketId);
      if (!market || market.active !== true) continue;

      const distanceKm = M.haversineKm(location.lat, location.lng, unit.lat, unit.lng);
      if (!Number.isFinite(distanceKm) || distanceKm > Number(radiusKm)) continue;

      for (const item of items) {
        if (!['pending','faltando'].includes(item.status)) continue;
        const match = M.scorePromotionMatch(item, promo);
        if (match.score < 0.58) continue;
        offers.push({
          promoId,
          item,
          promo: { id: promoId, ...promo },
          unit,
          market,
          distanceKm,
          matchScore: match.score,
          matchReason: match.reason
        });
      }
    }

    return offers.sort((a, b) => {
      if (a.item.id !== b.item.id) return String(a.item.name || a.item.nome || '').localeCompare(String(b.item.name || b.item.nome || '')); 
      const priceDiff = Number(a.promo.price) - Number(b.promo.price);
      if (Math.abs(priceDiff) > 0.001) return priceDiff;
      return a.distanceKm - b.distanceKm;
    });
  };
})();
