(function () {
  'use strict';

  const PDFJS_VERSION = '5.7.284';
  const ENGINE_VERSION = '2.2.0';
  const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
  let pdfjsPromise = null;
  let activeDocument = null;
  let activeFileHash = '';

  function cleanText(value) {
    return String(value || '')
      .replace(/\u0000/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function collapseDuplicatedGlyphs(word) {
    const text = cleanText(word);
    if (/^\d+$/.test(text)) return text;
    if (text.length < 6) return text;
    const chunks = [...text.matchAll(/(.)\1*/g)].map((m) => ({ char:m[1], length:m[0].length }));
    const repeated = chunks.filter((x) => x.length > 1).reduce((sum, x) => sum + x.length, 0);
    if (repeated / text.length < 0.55) return text;
    const repeatedLengths = chunks.filter((x) => x.length > 1).map((x) => x.length);
    const gcd = (a,b) => b ? gcd(b, a % b) : a;
    const factor = repeatedLengths.reduce((acc, n) => gcd(acc, n), repeatedLengths[0] || 1);
    if (factor <= 1) return text;
    return chunks.map((x) => x.char.repeat(Math.max(1, Math.round(x.length / factor)))).join('');
  }

  function sanitizeWord(value) {
    return collapseDuplicatedGlyphs(value)
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseMoney(value) {
    const match = String(value || '').replace(/\s+/g, '').match(/(?:R\$)?(\d{1,8})[,.](\d{2})/i);
    if (!match) return null;
    let integer = match[1];
    if (integer.length >= 4 && integer.length % 2 === 0) {
      const half = integer.length / 2;
      if (integer.slice(0, half) === integer.slice(half)) integer = integer.slice(0, half);
    }
    const number = Number(`${integer}.${match[2]}`);
    return Number.isFinite(number) && number > 0 && number < 10000 ? number : null;
  }

  function center(box) {
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  function unionBoxes(boxes) {
    const valid = (boxes || []).filter(Boolean);
    if (!valid.length) return null;
    const x0 = Math.min(...valid.map((b) => b.x));
    const y0 = Math.min(...valid.map((b) => b.y));
    const x1 = Math.max(...valid.map((b) => b.x + b.width));
    const y1 = Math.max(...valid.map((b) => b.y + b.height));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  function overlapX(a, b) {
    const left = Math.max(a.x, b.x);
    const right = Math.min(a.x + a.width, b.x + b.width);
    return Math.max(0, right - left);
  }

  function genericLine(text) {
    const t = cleanText(text).toUpperCase();
    if (!t) return true;
    return /^(R\$|CADA|KG|UN|UND|UNIDADE|UNIDADES|CLIENTE|CLUBE|PAGA|OFERTA|OFERTAS|ESPECIAIS|PREÇO|PRECO)$/.test(t)
      || /^(LIMITE|LIMITE DE|POR CLIENTE|EXCETO|LEVE|PAGUE)\b/.test(t)
      || /^(PREÇOS?|PRECOS?|OFERTAS?)\s+VÁLID[AO]S?\b/.test(t)
      || /^HORÁRIO DE ATENDIMENTO\b/.test(t)
      || /^\d{1,2}\/\d{1,2}/.test(t)
      || /^\d+[,.]?\d*$/.test(t);
  }

  function conditionLine(text) {
    const t = cleanText(text).toUpperCase();
    return /\b(LIMITE|POR CLIENTE|EXCETO|LEV[EA]|PAGUE|ENQUANTO HOUVER ESTOQUE|CLUBE)\b/.test(t);
  }

  function groupLines(boxes, tolerance = 4.5) {
    const rows = [];
    [...boxes].sort((a, b) => a.y - b.y || a.x - b.x).forEach((box) => {
      const cy = box.y + box.height / 2;
      let row = rows.find((x) => Math.abs(x.cy - cy) <= tolerance);
      if (!row) {
        row = { cy, boxes: [] };
        rows.push(row);
      }
      row.boxes.push(box);
      row.cy = row.boxes.reduce((sum, x) => sum + x.y + x.height / 2, 0) / row.boxes.length;
    });

    const lines = [];
    rows.forEach((row) => {
      const sorted = row.boxes.sort((a, b) => a.x - b.x);
      let segment = [];
      const flush = () => {
        if (!segment.length) return;
        const text = cleanText(segment.map((x) => x.text).join(' '));
        lines.push({
          cy: segment.reduce((sum, x) => sum + x.y + x.height / 2, 0) / segment.length,
          boxes: [...segment],
          text,
          box: unionBoxes(segment)
        });
        segment = [];
      };
      sorted.forEach((box) => {
        if (segment.length) {
          const prev = segment[segment.length - 1];
          const gap = box.x - (prev.x + prev.width);
          const scale = Math.max(prev.height || 0, box.height || 0, 6);
          const maxGap = Math.max(15, Math.min(30, scale * 1.9));
          if (gap > maxGap) flush();
        }
        segment.push(box);
      });
      flush();
    });

    return lines.sort((a, b) => a.cy - b.cy || a.box.x - b.box.x);
  }

  function productSimilarity(a, b) {
    const norm = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const aa = new Set(norm(a).split(' ').filter((x) => x.length > 1));
    const bb = new Set(norm(b).split(' ').filter((x) => x.length > 1));
    if (!aa.size || !bb.size) return 0;
    const common = [...aa].filter((x) => bb.has(x)).length;
    return common / Math.max(aa.size, bb.size);
  }

  function extractPackage(text) {
    const t = cleanText(text).toUpperCase();
    const patterns = [
      /(L\d+P\d+)/,
      /(PACK\s*C\/?\s*\d+\s*UN(?:IDADES)?)/,
      /(\d+(?:[,.]\d+)?\s*(?:KG|G|ML|L|LT|LTS|LITROS?|UN|UND|UNIDADES|PCT|BDJ))/,
      /(PCT\s*\d+(?:[,.]\d+)?\s*(?:KG|G|ML|L|LT|LTS))/
    ];
    for (const pattern of patterns) {
      const m = t.match(pattern);
      if (m) return cleanText(m[1]).toLowerCase();
    }
    return '';
  }

  function rangeDistance(value, start, end) {
    if (value < start) return start - value;
    if (value > end) return value - end;
    return 0;
  }


  function priceLineDistance(priceBox, lineBox) {
    const pc = center(priceBox);
    const lc = center(lineBox);
    const horizontal = rangeDistance(pc.x, lineBox.x - 3, lineBox.x + lineBox.width + 3);
    const vertical = lineBox.y <= priceBox.y
      ? Math.max(0, priceBox.y - (lineBox.y + lineBox.height))
      : Math.max(0, lineBox.y - (priceBox.y + priceBox.height));
    const belowPenalty = lc.y > pc.y ? Math.min(34, (lc.y - pc.y) * 1.55) : 0;
    return horizontal * 1.45 + vertical * .74 + belowPenalty;
  }

  function likelySiblingPrice(a, b) {
    if (!a || !b) return false;
    const ac = center(a.box || a);
    const bc = center(b.box || b);
    const dx = Math.abs(ac.x - bc.x);
    const dy = Math.abs(ac.y - bc.y);
    const xOverlap = overlapX(a.box || a, b.box || b);
    return (dx <= 46 && dy <= 74) || (xOverlap > 0 && dy <= 92);
  }

  function lineOwnership(line, currentPrice, allPrices) {
    const own = priceLineDistance(currentPrice.box || currentPrice, line.box);
    let other = Infinity;
    for (const candidate of (allPrices || [])) {
      if (candidate === currentPrice) continue;
      if (likelySiblingPrice(currentPrice, candidate)) continue;
      other = Math.min(other, priceLineDistance(candidate.box || candidate, line.box));
    }
    if (!Number.isFinite(other)) return { accepted:true, confidence:1, own, other };
    const margin = other - own;
    const confidence = Math.max(0, Math.min(1, margin / Math.max(20, other)));
    return {
      accepted: own <= other + 4 && (margin >= -4),
      confidence,
      own,
      other
    };
  }

  function nearbyContext(priceBox, boxes, xWindow = 95, yWindow = 82) {
    const pc = center(priceBox);
    return cleanText((boxes || [])
      .filter((box) => {
        const bc = center(box);
        return Math.abs(bc.x - pc.x) <= xWindow && Math.abs(bc.y - pc.y) <= yWindow;
      })
      .sort((a,b) => a.y - b.y || a.x - b.x)
      .map((x) => x.text)
      .join(' '));
  }

  function auxiliaryUnitPrice(priceBox, boxes) {
    const context = nearbyContext(priceBox, boxes, 150, 110).toUpperCase();
    return /NESTA\s+EMBALAGEM.{0,45}UNIDADE\s+SAI\s+POR/.test(context)
      || /UNIDADE\s+SAI\s+POR/.test(context);
  }

  function dedupeProductText(value) {
    let text = cleanText(value);
    if (!text) return text;
    const words = text.split(' ').filter(Boolean);
    const compact = [];
    for (const word of words) {
      if (!compact.length || compact[compact.length - 1].toUpperCase() !== word.toUpperCase()) compact.push(word);
    }
    for (let size = Math.floor(compact.length / 2); size >= 2; size -= 1) {
      const a = compact.slice(0, size).join(' ').toUpperCase();
      const b = compact.slice(size, size * 2).join(' ').toUpperCase();
      if (a === b) return compact.slice(0, size).join(' ');
    }
    return compact.join(' ')
      .replace(/\b(\w+(?:[./-]\w+)*)\s+\1\b/gi, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function textQuality(text) {
    const clean = dedupeProductText(text);
    const words = clean.split(' ').filter(Boolean);
    if (!words.length) return -100;
    let score = 0;
    if (words.length >= 2 && words.length <= 10) score += 8;
    else if (words.length <= 14) score += 4;
    else score -= (words.length - 14) * 2;
    if (extractPackage(clean)) score += 5;
    if (/\b(?:ARROZ|CAF[ÉE]|CERVEJA|REFRIG|LEITE|FEIJ|A[ÃA]O|PAP|SAB[ÃA]O|CARVAO|CARV[ÃA]O|LINGUI|AZEITE|MACAR|BOMBOM|IOGURTE|QUEIJO|FRANGO|BOVINO|SUINO|SUÍNO|ATUM|MILHO|FARINHA|A[CÇ][UÚ]CAR|CHOC|BISC|PAO|P[ÃA]O|FRALDA|DESOD|SH|AMAC|LAVA|AGUA|ÁGUA)\b/i.test(clean)) score += 4;
    const unique = new Set(words.map((w) => w.toUpperCase()));
    if (unique.size / Math.max(1, words.length) < .62) score -= 6;
    if (/\b(?:OFERTA|WHATSAPP|HORARIO|HORÁRIO|VALIDA|VÁLIDA|TODO MUNDO)\b/i.test(clean)) score -= 12;
    return score;
  }

  function chooseBestProductText(...values) {
    const candidates = [...new Set(values.map(dedupeProductText).filter((x) => x && x.length >= 3))];
    return candidates.sort((a, b) => textQuality(b) - textQuality(a) || a.length - b.length)[0] || '';
  }

  function extractProductForPrice(priceEntry, boxes, allPrices = [], strict = false) {
    const priceBox = priceEntry.box || priceEntry;
    const pc = center(priceBox);
    const xLimit = strict ? 50 : 72;
    const topWindow = strict ? 78 : 102;
    const bottomWindow = strict ? 16 : 24;
    const candidateLines = groupLines(boxes, strict ? 3.0 : 4.0)
      .filter((line) => {
        if (!line.text || genericLine(line.text) || conditionLine(line.text)) return false;
        if (/R\$\s*\d|\b\d{1,5}[,.]\d{2}\b/.test(line.text)) return false;
        if (line.box.height > 20) return false;
        const lc = center(line.box);
        const horizontal = rangeDistance(pc.x, line.box.x - 4, line.box.x + line.box.width + 4);
        if (horizontal > xLimit) return false;
        if (line.box.y < priceBox.y - topWindow) return false;
        if (line.box.y > priceBox.y + priceBox.height + bottomWindow) return false;
        if (lc.y > pc.y + bottomWindow) return false;
        const ownership = lineOwnership(line, priceEntry, allPrices);
        if (!ownership.accepted) return false;
        line._priceOwnership = ownership;
        return true;
      });

    if (!candidateLines.length) return { productText:'', productBox:null, localConditions:'', ownershipConfidence:0, localContext:nearbyContext(priceBox, boxes) };

    const ranked = candidateLines.map((line) => {
      const lc = center(line.box);
      const horizontal = rangeDistance(pc.x, line.box.x, line.box.x + line.box.width);
      const aboveGap = Math.max(0, priceBox.y - (line.box.y + line.box.height));
      const overlapPenalty = lc.y > pc.y ? (lc.y - pc.y) * 2.8 : 0;
      const farSidePenalty = Math.abs(lc.x - pc.x) > 58 ? 22 : 0;
      const ownershipBonus = (line._priceOwnership?.confidence || 0) * 10;
      const score = horizontal * 1.35 + aboveGap * .74 + overlapPenalty + farSidePenalty - Math.min(9, textQuality(line.text)) - ownershipBonus;
      return { line, score };
    }).sort((a,b) => a.score - b.score);

    const seed = ranked[0].line;
    const seedC = center(seed.box);
    const ordered = candidateLines.sort((a,b) => a.cy - b.cy || a.box.x - b.box.x);
    const seedIndex = ordered.indexOf(seed);
    const selected = [seed];

    const compatible = (line, reference) => {
      const lc = center(line.box);
      const rc = center(reference.box);
      const centerDx = Math.abs(lc.x - rc.x);
      const verticalGap = Math.max(0, Math.max(line.box.y, reference.box.y) - Math.min(line.box.y + line.box.height, reference.box.y + reference.box.height));
      const minWidth = Math.max(1, Math.min(line.box.width, reference.box.width));
      const xShare = overlapX(line.box, reference.box) / minWidth;
      return centerDx <= (strict ? 38 : 48)
        && verticalGap <= (strict ? 13 : 18)
        && (xShare >= .08 || centerDx <= (strict ? 26 : 34));
    };

    for (let i = seedIndex - 1, ref = seed; i >= 0 && selected.length < (strict ? 4 : 5); i -= 1) {
      const line = ordered[i];
      if (seedC.y - center(line.box).y > (strict ? 46 : 60)) break;
      if (!compatible(line, ref)) continue;
      selected.unshift(line);
      ref = line;
    }
    for (let i = seedIndex + 1, ref = seed; i < ordered.length && selected.length < (strict ? 4 : 5); i += 1) {
      const line = ordered[i];
      if (center(line.box).y - seedC.y > (strict ? 32 : 44)) break;
      if (!compatible(line, ref)) continue;
      selected.push(line);
      ref = line;
    }

    const nearest = selected
      .filter((line, idx, arr) => arr.findIndex((x) => x === line) === idx)
      .sort((a,b) => a.cy - b.cy || a.box.x - b.box.x);

    let productText = dedupeProductText(nearest.map((x) => x.text).join(' '));

    // Se um bloco já contém uma embalagem e, depois dela, começa uma nova categoria
    // forte, cortamos a cauda. Isso reduz mistura de dois produtos vizinhos sem
    // apagar detalhes como "ovos tipos" ou "exceto italiano" do produto atual.
    const boundary = productText.match(/\b\d+(?:[,.]\d+)?\s*(?:KG|G|ML|L|LT|LTS|UN|UND|UNIDADES|PCT|BDJ)\b/i);
    if (boundary) {
      const after = productText.slice((boundary.index || 0) + boundary[0].length);
      const nextAnchor = after.search(/\b(?:CERVEJA|REFRIG|ARROZ|FEIJ[ÃA]O|CAF[ÉE]|LEITE|AZEITE|A[CÇ][UÚ]CAR|MACAR|MOLHO|FARINHA|CHOC|BISC|CARV[ÃA]O|SAB[ÃA]O|AMAC|LINGUI[CÇ]A|VINHO|AGUARDENTE|VODKA|WHISKY|SUCO|P[ÃA]O|QUEIJO|BACON|FRANGO|BOVINO|SU[IÍ]NO|IOGURTE|REQUEIJ[ÃA]O|MARGARINA|FRALDA|DESOD|LAVA|[ÁA]GUA)\b/i);
      if (nextAnchor >= 0) {
        const cut = (boundary.index || 0) + boundary[0].length + nextAnchor;
        const trimmed = cleanText(productText.slice(0, cut));
        if (trimmed.split(' ').length >= 2) productText = trimmed;
      }
    }

    const conditionLines = groupLines(boxes, 4.0).filter((line) => {
      if (!conditionLine(line.text)) return false;
      const lc = center(line.box);
      if (Math.abs(lc.x - pc.x) > 88) return false;
      if (line.box.y < priceBox.y - 112 || line.box.y > priceBox.y + priceBox.height + 44) return false;
      return true;
    });

    const ownershipValues = nearest.map((line) => line._priceOwnership?.confidence).filter(Number.isFinite);
    const ownershipConfidence = ownershipValues.length
      ? ownershipValues.reduce((sum, x) => sum + x, 0) / ownershipValues.length
      : 0;

    return {
      productText,
      productBox: unionBoxes(nearest.flatMap((x) => x.boxes)),
      localConditions: cleanText(conditionLines.map((x) => x.text).join(' · ')),
      ownershipConfidence,
      localContext: nearbyContext(priceBox, boxes)
    };
  }

  function findProductForPrice(priceEntry, boxes, allPrices) {
    return extractProductForPrice(priceEntry, boxes, allPrices, false);
  }

  function findProductForPriceStrict(priceEntry, boxes, allPrices) {
    return extractProductForPrice(priceEntry, boxes, allPrices, true);
  }

  function candidateQuality(input) {
    const {
      productName, packageText, category, detectedPrices, price, previousPrice,
      validity, sourceBox, primaryProduct, strictProduct, priceBox, options, conditions,
      ownershipConfidence = 0, clusterCoherence = 0, localContext = ''
    } = input;
    const risks = [];
    const evidence = [];
    let score = 0.55;
    const words = cleanText(productName).split(' ').filter(Boolean);
    const agreement = productSimilarity(primaryProduct, strictProduct);
    const quality = textQuality(productName);
    const ownershipRescue = agreement < 0.60
      && ownershipConfidence >= 0.82
      && quality >= 7
      && words.length >= 2
      && words.length <= 14;

    if (agreement >= 0.80) { score += 0.15; evidence.push('dupla associação espacial concordante'); }
    else if (agreement >= 0.60) { score += 0.09; evidence.push('associação espacial compatível'); }
    else if (ownershipRescue) { score += 0.08; evidence.push('associação isolada pelo domínio espacial'); }
    else if (strictProduct) { score -= 0.10; risks.push('association_disagreement'); }
    else if (ownershipConfidence >= 0.88 && quality >= 7) { score += 0.045; evidence.push('associação única com domínio espacial forte'); }
    else { score -= 0.04; risks.push('single_association_pass'); }

    if (ownershipConfidence >= 0.82) { score += 0.045; evidence.push('texto pertence ao mesmo bloco de preço'); }
    else if (ownershipConfidence >= 0.55) { score += 0.02; evidence.push('domínio espacial compatível'); }

    if (clusterCoherence >= 0.78) { score += 0.035; evidence.push('preços do bloco concordam com o mesmo produto'); }
    else if ((detectedPrices || []).length > 1 && clusterCoherence < 0.45) { score -= 0.07; risks.push('price_cluster_disagreement'); }

    if (words.length >= 4) { score += 0.06; evidence.push('descrição detalhada'); }
    else if (words.length >= 2) score += 0.03;
    else risks.push('short_product_name');

    if (packageText) { score += 0.06; evidence.push('embalagem identificada'); }
    if (category && category !== 'outros') { score += 0.04; evidence.push('categoria reconhecida'); }
    if (sourceBox && priceBox) { score += 0.04; evidence.push('origem espacial preservada'); }

    if (validity?.startAt && validity?.endAt) { score += 0.08; evidence.push('validade identificada'); }
    else { score -= 0.12; risks.push('missing_validity'); }

    const countPrices = (detectedPrices || []).length;
    const clubEvidence = options.lowerPriceIsClub || /\b(CLUBE|CLIENTE\s+CLUBE|CLIENTE.*PAGA)\b/i.test(`${conditions || ''} ${localContext || ''}`);
    if (countPrices === 1) { score += 0.05; evidence.push('preço único no bloco'); }
    else if (countPrices === 2 && clubEvidence) { score += 0.06; evidence.push('duplo preço com sinal de programa/clube'); }
    else if (countPrices > 2) { score -= 0.12; risks.push('too_many_prices'); }
    else if (countPrices === 2) { score -= 0.06; risks.push('ambiguous_price_kind'); }

    if (conditions) score += 0.015;
    if (!Number.isFinite(price) || price <= 0 || price >= 10000) risks.push('invalid_price');
    if (previousPrice && Number(previousPrice) <= Number(price)) risks.push('invalid_previous_price');

    const upper = cleanText(productName).toUpperCase();
    if (/HOR[ÁA]RIO|VALID[AO]S?|TODO MUNDO|COMUNIDADE|WHATSAPP|OFERTAS ESPECIAIS/.test(upper)) {
      score -= 0.18;
      risks.push('header_contamination');
    }
    if ((upper.match(/R\$/g) || []).length || /\b\d{1,4}[,.]\d{2}\b/.test(upper)) {
      score -= 0.12;
      risks.push('price_inside_product_text');
    }
    if (words.length > 18) { score -= 0.08; risks.push('overlong_product_text'); }

    const critical = new Set([
      'association_disagreement','missing_validity','too_many_prices','ambiguous_price_kind',
      'invalid_price','invalid_previous_price','header_contamination','price_inside_product_text',
      'price_cluster_disagreement'
    ]);
    if (risks.some((r) => critical.has(r))) score = Math.min(score, 0.965);
    if (risks.includes('association_disagreement') || risks.includes('header_contamination') || risks.includes('price_cluster_disagreement')) score = Math.min(score, 0.89);
    if (risks.includes('missing_validity') || risks.includes('invalid_price')) score = Math.min(score, 0.84);

    score = Math.max(0.35, Math.min(0.997, score));
    const uniqueRisks = [...new Set(risks)];
    const hasCritical = uniqueRisks.some((r) => critical.has(r));
    const associationSafe = agreement >= 0.80 || ownershipRescue || (agreement >= 0.60 && ownershipConfidence >= 0.72);
    const structuralSafe = !hasCritical
      && Boolean(validity?.startAt && validity?.endAt)
      && associationSafe
      && (ownershipConfidence >= 0.55 || agreement >= 0.90)
      && words.length >= 2 && words.length <= 14
      && !uniqueRisks.includes('overlong_product_text')
      && !uniqueRisks.includes('short_product_name')
      && (countPrices === 1 || (countPrices === 2 && clubEvidence));
    return {
      confidence: score,
      riskFlags: uniqueRisks,
      evidence: [...new Set(evidence)],
      associationAgreement: agreement,
      ownershipConfidence,
      clusterCoherence,
      structuralSafe,
      automationSafe: !hasCritical && structuralSafe && score >= 0.97
    };
  }

  function findPriceBoxes(boxes) {
    const prices = [];

    boxes.forEach((box) => {
      const direct = parseMoney(box.text);
      if (/R\$/i.test(box.text) && direct) {
        prices.push({ price: direct, box, parts: [box] });
        return;
      }

      if (box.text.toUpperCase() !== 'R$') return;
      const bc = center(box);

      const directNumber = boxes
        .filter((candidate) => {
          const cc = center(candidate);
          return candidate.x >= box.x + box.width - 4
            && candidate.x <= box.x + 110
            && Math.abs(cc.y - bc.y) <= 23
            && /^\d{1,8}[,.]\d{2}$/.test(candidate.text)
            && candidate.height >= box.height * .9;
        })
        .sort((a,b) => Math.abs(a.x - (box.x + box.width)) - Math.abs(b.x - (box.x + box.width)))[0];

      if (directNumber) {
        const value = parseMoney(directNumber.text);
        if (value) prices.push({ price:value, box:unionBoxes([box,directNumber]), parts:[box,directNumber] });
        return;
      }

      const integers = boxes
        .filter((candidate) => {
          const cc = center(candidate);
          return candidate.x >= box.x + box.width - 4
            && candidate.x <= box.x + 90
            && Math.abs(cc.y - bc.y) <= 23
            && /^\d{1,8}$/.test(candidate.text)
            && candidate.height >= box.height * 1.15;
        })
        .sort((a,b) => {
          const dxA = Math.abs(a.x - (box.x + box.width));
          const dxB = Math.abs(b.x - (box.x + box.width));
          return dxA - dxB || b.height - a.height;
        });

      const integer = integers[0];
      if (!integer) return;

      const decimals = boxes
        .filter((candidate) => {
          const cc = center(candidate);
          const ic = center(integer);
          return candidate.x >= integer.x + integer.width - 8
            && candidate.x <= integer.x + integer.width + 35
            && Math.abs(cc.y - ic.y) <= 20
            && /^[,.]\d{2}$/.test(candidate.text)
            && candidate.height >= box.height * .85;
        })
        .sort((a,b) => Math.abs(a.x - (integer.x + integer.width)) - Math.abs(b.x - (integer.x + integer.width)));

      const decimal = decimals[0];
      if (!decimal) return;
      const value = parseMoney(`${integer.text}${decimal.text}`);
      if (value) prices.push({ price:value, box:unionBoxes([box,integer,decimal]), parts:[box,integer,decimal] });
    });

    const deduped = [];
    for (const price of prices) {
      const pc = center(price.box);
      const duplicate = deduped.some((x) => {
        const xc = center(x.box);
        return Math.abs(x.price - price.price) < 0.001 && Math.abs(pc.x - xc.x) < 8 && Math.abs(pc.y - xc.y) < 8;
      });
      if (!duplicate) deduped.push(price);
    }
    return deduped.filter((price) => !auxiliaryUnitPrice(price.box, boxes));
  }

  function detectGlobalCondition(text) {
    const normalized = cleanText(text);
    const parts = [];
    if (/enquanto houver estoque/i.test(normalized)) parts.push('ou enquanto houver estoque');
    return parts.join(' · ');
  }

  function localMidnight(year, month, day, endOfDay) {
    const d = new Date(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
    return d.getTime();
  }

  function extractValidity(text) {
    const t = cleanText(text);
    let m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(?:a|até)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i);
    if (m) {
      return {
        startAt: localMidnight(Number(m[3]), Number(m[2]), Number(m[1]), false),
        endAt: localMidnight(Number(m[6]), Number(m[5]), Number(m[4]), true),
        raw: m[0],
        condition: detectGlobalCondition(t)
      };
    }
    m = t.match(/\b(\d{1,2})\/(\d{1,2})\s*(?:a|até)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i);
    if (m) {
      return {
        startAt: localMidnight(Number(m[5]), Number(m[2]), Number(m[1]), false),
        endAt: localMidnight(Number(m[5]), Number(m[4]), Number(m[3]), true),
        raw: m[0],
        condition: detectGlobalCondition(t)
      };
    }
    m = t.match(/\b(\d{1,2})\s*(?:a|até)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i);
    if (m) {
      return {
        startAt: localMidnight(Number(m[4]), Number(m[3]), Number(m[1]), false),
        endAt: localMidnight(Number(m[4]), Number(m[3]), Number(m[2]), true),
        raw: m[0],
        condition: detectGlobalCondition(t)
      };
    }
    return { startAt: null, endAt: null, raw: '', condition: detectGlobalCondition(t) };
  }

  function normalizeTextItem(item, viewport, pdfjsLib) {
    const text = sanitizeWord(item.str);
    if (!text) return null;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const height = Math.max(2, Math.hypot(tx[2], tx[3]));
    const width = Math.max(1, Math.abs(Number(item.width || 0) * viewport.scale));
    return {
      text,
      x: tx[4],
      y: tx[5] - height,
      width,
      height
    };
  }

  function buildCandidates(pageNumber, pageWidth, pageHeight, boxes, priceBoxes, validity, options, inferCategory) {
    const globalCondition = validity?.condition || '';
    const rawPrices = priceBoxes.map((price, index) => {
      const info = findProductForPrice(price, boxes, priceBoxes);
      const strict = findProductForPriceStrict(price, boxes, priceBoxes);
      return {
        id: `${pageNumber}-${index}`,
        pageNumber,
        pageWidth,
        pageHeight,
        price: price.price,
        priceBox: price.box,
        productName: dedupeProductText(info.productText),
        strictProductName: dedupeProductText(strict.productText),
        productBox: info.productBox,
        localConditions: info.localConditions,
        localContext: info.localContext || strict.localContext || '',
        ownershipConfidence: Math.max(Number(info.ownershipConfidence || 0), Number(strict.ownershipConfidence || 0))
      };
    }).filter((x) => x.productName && x.productName.length >= 3);

    const clusters = [];
    rawPrices.forEach((entry) => {
      const ec = center(entry.priceBox);
      let best = null;
      for (const candidate of clusters) {
        const first = candidate.entries[0];
        const xc = center(first.priceBox);
        const sim = Math.max(
          productSimilarity(entry.productName, first.productName),
          productSimilarity(entry.strictProductName, first.strictProductName),
          productSimilarity(entry.productName, first.strictProductName),
          productSimilarity(entry.strictProductName, first.productName)
        );
        const dx = Math.abs(ec.x - xc.x);
        const dy = Math.abs(ec.y - xc.y);
        const overlap = overlapX(entry.priceBox, first.priceBox);
        const context = `${entry.localContext || ''} ${entry.localConditions || ''} ${first.localContext || ''} ${first.localConditions || ''}`;
        const clubish = /\b(CLUBE|CLIENTE\s+CLUBE|CLIENTE.*PAGA)\b/i.test(context);
        const geometricPair = (dx <= 48 && dy <= 78) || (overlap > 0 && dy <= 92);
        const sameProduct = sim >= 0.62 && dx <= 62 && dy <= 112;
        const clubPair = clubish && geometricPair && sim >= 0.18;
        if (!(sameProduct || clubPair)) continue;
        const rank = sim * 100 - dx * .35 - dy * .18 + (clubPair ? 18 : 0);
        if (!best || rank > best.rank) best = { candidate, rank };
      }
      if (!best) {
        clusters.push({ entries: [entry] });
      } else {
        best.candidate.entries.push(entry);
      }
    });

    return clusters.map((cluster, index) => {
      const productName = chooseBestProductText(...cluster.entries.flatMap((x) => [x.productName, x.strictProductName]));
      const strictProduct = chooseBestProductText(...cluster.entries.map((x) => x.strictProductName));
      const uniquePrices = [...new Set(cluster.entries.map((x) => Number(x.price.toFixed(2))))].sort((a, b) => a - b);
      const promoPrice = uniquePrices[0];
      const normalPrice = uniquePrices.length > 1 ? uniquePrices[uniquePrices.length - 1] : null;
      const multiple = uniquePrices.length > 1;
      const packageText = extractPackage(productName);
      const category = inferCategory ? (inferCategory(productName) || 'outros') : 'outros';
      const localContext = cleanText(cluster.entries.map((x) => x.localContext).filter(Boolean).join(' · '));
      const conditions = cleanText([globalCondition, ...cluster.entries.map((x) => x.localConditions)].filter(Boolean).join(' · '));
      const clubSignal = /\b(CLUBE|CLIENTE\s+CLUBE|CLIENTE.*PAGA)\b/i.test(`${conditions} ${localContext}`);
      const priceKind = multiple ? ((clubSignal || options.lowerPriceIsClub) ? 'club' : 'review') : 'general';
      const sourceBox = unionBoxes(cluster.entries.flatMap((x) => [x.productBox, x.priceBox]));
      const ownershipConfidence = cluster.entries.length
        ? cluster.entries.reduce((sum, x) => sum + Number(x.ownershipConfidence || 0), 0) / cluster.entries.length
        : 0;
      const coherenceValues = cluster.entries
        .map((x) => Math.max(productSimilarity(productName, x.productName), productSimilarity(productName, x.strictProductName)))
        .filter(Number.isFinite);
      const clusterCoherence = coherenceValues.length
        ? coherenceValues.reduce((sum, x) => sum + x, 0) / coherenceValues.length
        : 0;
      const quality = candidateQuality({
        productName,
        packageText,
        category,
        detectedPrices: uniquePrices,
        price: promoPrice,
        previousPrice: normalPrice,
        validity,
        sourceBox,
        primaryProduct: productName,
        strictProduct,
        priceBox: cluster.entries[0].priceBox,
        options,
        conditions,
        localContext,
        ownershipConfidence,
        clusterCoherence
      });

      return {
        id: `p${pageNumber}-c${index}`,
        pageNumber,
        pageWidth,
        pageHeight,
        productName,
        category,
        brand: '',
        packageText,
        price: promoPrice,
        previousPrice: normalPrice,
        detectedPrices: uniquePrices,
        priceKind,
        requiresClub: priceKind === 'club',
        clubName: priceKind === 'club' ? cleanText(options.clubName || '') : '',
        clubSignal,
        conditions,
        confidence: quality.confidence,
        riskFlags: quality.riskFlags,
        evidence: quality.evidence,
        associationAgreement: quality.associationAgreement,
        ownershipConfidence: quality.ownershipConfidence,
        clusterCoherence: quality.clusterCoherence,
        structuralSafe: quality.structuralSafe,
        automationSafe: quality.automationSafe,
        sourceBox,
        startAt: validity?.startAt || null,
        endAt: validity?.endAt || null,
        verified: false,
        verificationMode: '',
        ignored: false,
        published: false,
        reviewed: false
      };
    }).filter((x) => Number.isFinite(x.price) && x.price > 0 && x.productName.length >= 3);
  }

  async function loadPdfJs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(`${PDFJS_BASE}/build/pdf.mjs`).then((pdfjsLib) => {
        pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.mjs`;
        return pdfjsLib;
      });
    }
    return pdfjsPromise;
  }

  async function sha256(arrayBuffer) {
    if (!crypto?.subtle) return '';
    const digest = await crypto.subtle.digest('SHA-256', arrayBuffer.slice(0));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function analyzeFile(file, options = {}, onProgress) {
    if (!file || (file.type && file.type !== 'application/pdf') || !/\.pdf$/i.test(file.name || '')) throw new Error('Selecione um arquivo PDF válido.');
    const pdfjsLib = await loadPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    const hash = await sha256(arrayBuffer);
    const loadingTask = pdfjsLib.getDocument({
      data: arrayBuffer,
      cMapUrl: `${PDFJS_BASE}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
      wasmUrl: `${PDFJS_BASE}/wasm/`
    });
    const pdf = await loadingTask.promise;
    activeDocument = pdf;
    activeFileHash = hash;

    const pages = [];
    const allText = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (onProgress) onProgress({ pageNumber, numPages: pdf.numPages, percent: Math.round((pageNumber - 1) / pdf.numPages * 100) });
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const boxes = textContent.items.map((item) => normalizeTextItem(item, viewport, pdfjsLib)).filter(Boolean);
      const pageText = cleanText(boxes.map((x) => x.text).join(' '));
      allText.push(pageText);
      const priceBoxes = findPriceBoxes(boxes);
      pages.push({ pageNumber, width: viewport.width, height: viewport.height, boxes, priceBoxes });
    }

    const documentText = allText.join(' ');
    const validity = extractValidity(documentText);
    const inferCategory = window.MercadorIA?.inferCategory;
    const candidates = pages.flatMap((page) => buildCandidates(
      page.pageNumber,
      page.width,
      page.height,
      page.boxes,
      page.priceBoxes,
      validity,
      options,
      inferCategory
    ));

    if (onProgress) onProgress({ pageNumber: pdf.numPages, numPages: pdf.numPages, percent: 100 });

    return {
      fileName: file.name,
      fileSize: file.size,
      hash,
      numPages: pdf.numPages,
      validity,
      candidates,
      analyzedAt: Date.now(),
      engineVersion: ENGINE_VERSION,
      pdfjsVersion: PDFJS_VERSION
    };
  }

  async function renderPreview(candidate, canvas) {
    if (!activeDocument || !candidate || !canvas) return;
    const page = await activeDocument.getPage(candidate.pageNumber);
    const scale = 1.8;
    const viewport = page.getViewport({ scale });
    const full = document.createElement('canvas');
    full.width = Math.ceil(viewport.width);
    full.height = Math.ceil(viewport.height);
    const ctx = full.getContext('2d', { alpha: false });
    await page.render({ canvasContext: ctx, viewport }).promise;

    const source = candidate.sourceBox || { x: 0, y: 0, width: candidate.pageWidth, height: candidate.pageHeight };
    const margin = 38;
    const sx = Math.max(0, (source.x - margin) * scale);
    const sy = Math.max(0, (source.y - margin) * scale);
    const sw = Math.min(full.width - sx, (source.width + margin * 2) * scale);
    const sh = Math.min(full.height - sy, (source.height + margin * 2) * scale);
    const maxWidth = 900;
    const ratio = Math.min(1, maxWidth / Math.max(1, sw));
    canvas.width = Math.max(1, Math.round(sw * ratio));
    canvas.height = Math.max(1, Math.round(sh * ratio));
    const out = canvas.getContext('2d', { alpha: false });
    out.clearRect(0, 0, canvas.width, canvas.height);
    out.drawImage(full, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  }

  function hasActiveDocument(hash) {
    return Boolean(activeDocument && (!hash || activeFileHash === hash));
  }

  window.MercadorPDFImporter = {
    PDFJS_VERSION,
    ENGINE_VERSION,
    analyzeFile,
    renderPreview,
    extractValidity,
    hasActiveDocument
  };
})();
