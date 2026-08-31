(function () {
  'use strict';

  // Mercador IA — resolução documental Card-First.
  // Esta camada NÃO substitui os motores existentes. Ela recebe o Knowledge JSON já
  // produzido pelo importador atual (PDF.js + OCR/híbrido + validador legado), reconstrói
  // blocos comerciais por página e só então valida/resolve as ofertas.
  // O formato final de candidate permanece compatível com js/admin.js.

  const previous = window.MercadorPDFImporter;
  if (!previous || typeof previous.analyzeFile !== 'function') {
    console.error('[Mercador IA] Card Resolver não instalado: MercadorPDFImporter indisponível.');
    return;
  }
  if (previous.__cardFirstResolverInstalled) return;

  const RESOLVER_VERSION = '5.0.0-card-first';
  const KNOWLEDGE_SCHEMA_VERSION = 'mercador.encarte.knowledge.v5';
  const previousAnalyzeFile = previous.analyzeFile.bind(previous);
  const previousDownloadKnowledgeJson = typeof previous.downloadKnowledgeJson === 'function'
    ? previous.downloadKnowledgeJson.bind(previous)
    : null;

  const HARD_RISK = new Set([
    'association_disagreement',
    'missing_validity',
    'too_many_prices',
    'ambiguous_price_kind',
    'invalid_price',
    'invalid_previous_price',
    'header_contamination',
    'price_inside_product_text',
    'price_cluster_disagreement',
    'ocr_price_without_currency',
    'ocr_low_price_confidence',
    'ocr_validity_inferred',
    'ocr_price_scale_suspicious',
    'ocr_price_conflict',
    'ocr_low_description_quality',
    'ocr_block_ownership_weak',
    'knowledge_legacy_description_conflict'
  ]);

  const INSTITUTIONAL_RE = /\b(?:OFERTAS?|OFERTA DO DIA|PRE[CÇ]O\s+BAIXO|TODO\s+DIA|FEIRA\s+GIGANTE|ATACADISTA|ACESSE\s+AQUI|PE[CÇ]A\s+J[ÁA]|CART[AÃ]O|CREDIFFATO|SEM\s+JUROS|PARCEL|PRE[CÇ]OS?\s+V[ÁA]LID|ENQUANTO\s+DURAREM|ESTOQUES?|CONSULTAR\s+DISPONIBILIDADE|MODALIDADE\s+ATACADO|CONTRIBUA\s+COM|N[AÃ]O\s+JOGUE|OPORTUNIDADES|CANDIDATE-SE|INCLUS[AÃ]O|RESPEITO|NOSSA\s+CULTURA|GRUPO\s*MUFFATO|GUPY|LOJAS?\s+DE|S[AÃ]O\s+JOS[ÉE]\s+DO\s+RIO\s+PRETO|CATANDUVA|VOTUPORANGA|FERNAND[ÓO]POLIS|ECONOMIA\s+NO\s+SEU\s+BOLSO|FARTURA\s+NO\s+CHURRASCO|TODA\s+A\s+LOJA)\b/i;
  const CONDITION_RE = /\b(?:A\s+PARTIR\s+DE|LEVE\s+\d+|PAGUE\s+\d+|POR\s+CLIENTE|LIMITE|CLUBE|APP|APLICATIVO|CADA|UNIDADE\s+SAI\s+POR|NESTA\s+EMBALAGEM|ENQUANTO\s+DURAREM|EXCETO|SOMENTE|VALID[AO]S?)\b/i;
  const PACKAGE_RE = /\b(?:PACOTE|PCT|BANDEJA|BDJ|POTE|GARRAFA|PET|LATA|CAIXA|CX|SACO|SACH[ÊE]|FRASCO|CARTELA|UNIDADE|UN|UND)\s*(?:DE\s*)?\d+(?:[,.]\d+)?\s*(?:KG|G|GR|ML|L|LT|LTS|UN|UND|UNIDADES?)?\b|\b\d+(?:[,.]\d+)?\s*(?:KG|G|GR|ML|L|LT|LTS|UN|UND|UNIDADES?)\b|\b(?:KG|UNIDADE|UNIDADES)\b(?=\s*$)/i;
  const MONEY_RE = /(?:R\s*\$|R\$|\bRS\b)?\s*\d{1,5}\s*[,.;:]\s*\d{2}\b/i;
  const UNIT_ONLY_RE = /^(?:R\s*\$|R\$|CADA|KG|G|GR|ML|L|LT|LTS|UN|UND|UNIDADE|UNIDADES|PACOTE|PCT|BANDEJA|BDJ|POTE|GARRAFA|PET|LATA|CAIXA|CX)$/i;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
  const clean = (value) => String(value == null ? '' : value).replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  const fold = (value) => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const normalizedText = (value) => fold(value).replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = (value) => normalizedText(value).split(' ').filter((token) => token.length > 1);
  const unique = (list) => [...new Set((list || []).filter(Boolean))];
  const numberOr = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const validPrice = (value) => Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) < 10000;

  function tokenSet(value) {
    return new Set(tokens(value));
  }

  function tokenCoverage(needle, haystack) {
    const A = tokenSet(needle);
    const B = tokenSet(haystack);
    if (!A.size || !B.size) return 0;
    let common = 0;
    A.forEach((token) => { if (B.has(token)) common += 1; });
    return common / A.size;
  }

  function tokenSimilarity(a, b) {
    const A = tokenSet(a);
    const B = tokenSet(b);
    if (!A.size || !B.size) return 0;
    let common = 0;
    A.forEach((token) => { if (B.has(token)) common += 1; });
    return common / Math.max(A.size, B.size);
  }

  function boxFrom(value) {
    const box = value?.bbox || value?.box || value;
    if (!box) return null;
    const x = numberOr(box.x ?? box.x0, 0);
    const y = numberOr(box.y ?? box.y0, 0);
    const width = Math.max(0, numberOr(box.width, numberOr(box.x1, x) - x));
    const height = Math.max(0, numberOr(box.height, numberOr(box.y1, y) - y));
    if (!(width > 0) || !(height > 0)) return null;
    return { x, y, width, height, x1: x + width, y1: y + height };
  }

  function center(box) {
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  function unionBoxes(boxes) {
    const valid = (boxes || []).map(boxFrom).filter(Boolean);
    if (!valid.length) return null;
    const x = Math.min(...valid.map((box) => box.x));
    const y = Math.min(...valid.map((box) => box.y));
    const x1 = Math.max(...valid.map((box) => box.x1));
    const y1 = Math.max(...valid.map((box) => box.y1));
    return { x, y, width: Math.max(1, x1 - x), height: Math.max(1, y1 - y), x1, y1 };
  }

  function median(values) {
    const list = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!list.length) return 0;
    const i = Math.floor(list.length / 2);
    return list.length % 2 ? list[i] : (list[i - 1] + list[i]) / 2;
  }

  function overlap1d(a0, a1, b0, b1) {
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }

  function boxIntersectionRatio(aValue, bValue) {
    const a = boxFrom(aValue), b = boxFrom(bValue);
    if (!a || !b) return 0;
    const ix = overlap1d(a.x, a.x1, b.x, b.x1);
    const iy = overlap1d(a.y, a.y1, b.y, b.y1);
    const inter = ix * iy;
    if (!inter) return 0;
    return inter / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
  }

  function cleanCardLine(value) {
    return clean(value)
      .replace(/\bR\s*\$\s*\d{1,5}\s*[,.;:]\s*\d{2}\b/gi, ' ')
      .replace(/\bR\$\s*\d{1,5}\s*[,.;:]\s*\d{2}\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isInstitutional(value) {
    const text = clean(value);
    if (!text) return true;
    if (INSTITUTIONAL_RE.test(text)) return true;
    if (/^https?:\/\//i.test(text) || /\bWWW\./i.test(text)) return true;
    if (/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(text) && tokens(text).length <= 8) return true;
    if (/^(?:R\$|R|\$|RS|\d+[,.]?\d*|%)+$/i.test(text.replace(/\s+/g, ''))) return true;
    return false;
  }

  function isCondition(value) {
    const text = clean(value);
    return Boolean(text && CONDITION_RE.test(text));
  }

  function lineTextQuality(value) {
    const text = cleanCardLine(value);
    if (!text || isInstitutional(text) || UNIT_ONLY_RE.test(text)) return -100;
    const list = tokens(text);
    if (!list.length) return -100;
    let score = 0;
    if (list.length >= 1 && list.length <= 10) score += 18;
    else if (list.length <= 15) score += 8;
    else score -= (list.length - 15) * 4;
    if (/[A-ZÀ-ÿ]{3,}/i.test(text)) score += 12;
    if (PACKAGE_RE.test(text)) score += 6;
    if (isCondition(text)) score -= 18;
    if (MONEY_RE.test(text)) score -= 22;
    if (/\b(?:CPF|CNPJ|CEP|TELEFONE|VAGAS?|QR\s*CODE|SITE)\b/i.test(text)) score -= 35;
    const alpha = (text.match(/[A-Za-zÀ-ÿ]/g) || []).length;
    const noise = (text.match(/[^A-Za-zÀ-ÿ0-9\s.,/%+-]/g) || []).length;
    if (alpha >= 3) score += Math.min(10, alpha / 3);
    score -= noise * 2;
    return score;
  }

  function pageExtent(page) {
    const boxes = [];
    (page?.words || []).forEach((item) => { const box = boxFrom(item); if (box) boxes.push(box); });
    (page?.lines || []).forEach((item) => { const box = boxFrom(item); if (box) boxes.push(box); });
    (page?.prices || []).forEach((item) => { const box = boxFrom(item); if (box) boxes.push(box); });
    const observed = unionBoxes(boxes);
    const baseWidth = Math.max(1, numberOr(page?.width, 1));
    const baseHeight = Math.max(1, numberOr(page?.height, 1));
    if (!observed) return { minX: 0, minY: 0, maxX: baseWidth, maxY: baseHeight, width: baseWidth, height: baseHeight, baseWidth, baseHeight };

    // Há versões anteriores do Knowledge JSON em que tokens estão no canvas renderizado,
    // enquanto width/height representam a página PDF. Mantemos o espaço bruto para resolver
    // os cards e fazemos a conversão apenas ao produzir sourceBox.
    const marginX = Math.max(12, observed.width * .025);
    const marginY = Math.max(12, observed.height * .02);
    const minX = Math.max(0, observed.x - marginX);
    const minY = Math.max(0, observed.y - marginY);
    const maxX = Math.max(baseWidth, observed.x1 + marginX);
    const maxY = Math.max(baseHeight, observed.y1 + marginY);
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY, baseWidth, baseHeight };
  }

  function toBaseBox(page, rawBox, extent) {
    const box = boxFrom(rawBox);
    if (!box) return null;
    const sx = extent.baseWidth / Math.max(1, extent.width);
    const sy = extent.baseHeight / Math.max(1, extent.height);
    return {
      x: clamp((box.x - extent.minX) * sx, 0, extent.baseWidth),
      y: clamp((box.y - extent.minY) * sy, 0, extent.baseHeight),
      width: clamp(box.width * sx, 1, extent.baseWidth),
      height: clamp(box.height * sy, 1, extent.baseHeight)
    };
  }

  function pagePointNormalized(page, rawBox, extent) {
    const box = boxFrom(rawBox);
    if (!box) return null;
    const c = center(box);
    return {
      x: clamp((c.x - extent.minX) / Math.max(1, extent.width), 0, 1),
      y: clamp((c.y - extent.minY) / Math.max(1, extent.height), 0, 1)
    };
  }

  function sourcePointNormalized(candidate, page) {
    const box = boxFrom(candidate?.sourceBox);
    if (!box || !(numberOr(page?.width) > 0) || !(numberOr(page?.height) > 0)) return null;
    const c = center(box);
    return {
      x: clamp(c.x / numberOr(page.width, 1), 0, 1),
      y: clamp(c.y / numberOr(page.height, 1), 0, 1)
    };
  }

  function normalizedDistance(a, b) {
    if (!a || !b) return 1;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function dedupePrices(prices) {
    const output = [];
    (prices || [])
      .map((price, index) => ({ ...price, __index: index, __box: boxFrom(price) }))
      .filter((price) => validPrice(price.value) && price.__box)
      .sort((a, b) => numberOr(b.confidence) - numberOr(a.confidence))
      .forEach((price) => {
        const pc = center(price.__box);
        const duplicate = output.some((existing) => {
          const ec = center(existing.__box);
          return Math.abs(numberOr(existing.value) - numberOr(price.value)) < .011
            && Math.abs(ec.x - pc.x) <= Math.max(18, price.__box.height * .9)
            && Math.abs(ec.y - pc.y) <= Math.max(14, price.__box.height * .75);
        });
        if (!duplicate) output.push(price);
      });
    return output.sort((a, b) => a.__box.y - b.__box.y || a.__box.x - b.__box.x);
  }

  function makePriceBands(prices, medianPriceHeight, medianLineHeight) {
    const tolerance = Math.max(28, medianPriceHeight * 2.2, medianLineHeight * 3.4);
    const bands = [];
    prices.forEach((price) => {
      const cy = center(price.__box).y;
      let band = null;
      let delta = Infinity;
      bands.forEach((candidate) => {
        const d = Math.abs(candidate.cy - cy);
        if (d <= tolerance && d < delta) { band = candidate; delta = d; }
      });
      if (!band) {
        band = { cy, prices: [] };
        bands.push(band);
      }
      band.prices.push(price);
      band.cy = band.prices.reduce((sum, item) => sum + center(item.__box).y, 0) / band.prices.length;
    });
    bands.forEach((band) => band.prices.sort((a, b) => center(a.__box).x - center(b.__box).x));
    return bands.sort((a, b) => a.cy - b.cy);
  }

  function horizontalCellFor(price, band, extent, medianPriceHeight) {
    const list = band.prices;
    const index = list.indexOf(price);
    const pc = center(price.__box);
    const leftNeighbor = index > 0 ? center(list[index - 1].__box).x : null;
    const rightNeighbor = index < list.length - 1 ? center(list[index + 1].__box).x : null;
    const fallbackHalf = Math.max(110, medianPriceHeight * 5.2, extent.width * .105);
    const left = leftNeighbor != null ? (leftNeighbor + pc.x) / 2 : Math.max(extent.minX, pc.x - fallbackHalf);
    const right = rightNeighbor != null ? (rightNeighbor + pc.x) / 2 : Math.min(extent.maxX, pc.x + fallbackHalf);
    return { left, right };
  }

  function verticalCellFor(price, prices, extent, horizontal, medianPriceHeight, medianLineHeight) {
    const pc = center(price.__box);
    const columnTolerance = Math.max(90, medianPriceHeight * 4.5, (horizontal.right - horizontal.left) * .62);
    const comparable = prices.filter((other) => other !== price).filter((other) => {
      const oc = center(other.__box);
      return Math.abs(oc.x - pc.x) <= columnTolerance;
    });
    const above = comparable.filter((other) => center(other.__box).y < pc.y)
      .sort((a, b) => center(b.__box).y - center(a.__box).y)[0];
    const below = comparable.filter((other) => center(other.__box).y > pc.y)
      .sort((a, b) => center(a.__box).y - center(b.__box).y)[0];
    const minTopWindow = Math.max(120, medianLineHeight * 9.2, medianPriceHeight * 5.0);
    const minBottomWindow = Math.max(54, medianLineHeight * 3.8, medianPriceHeight * 2.2);
    const topByNeighbor = above ? (center(above.__box).y + pc.y) / 2 : extent.minY;
    const bottomByNeighbor = below ? (center(below.__box).y + pc.y) / 2 : extent.maxY;
    const top = Math.max(extent.minY, Math.min(topByNeighbor, price.__box.y - minTopWindow));
    const bottom = Math.min(extent.maxY, Math.max(bottomByNeighbor, price.__box.y1 + minBottomWindow));
    return { top, bottom };
  }

  function lineCenterInside(lineBox, cell) {
    const c = center(lineBox);
    return c.x >= cell.left && c.x <= cell.right && c.y >= cell.top && c.y <= cell.bottom;
  }

  function lineOverlapsPrice(line, prices) {
    return (prices || []).some((price) => boxIntersectionRatio(line, price.__box) >= .28);
  }

  function selectProductGroup(lines, price, medianLineHeight) {
    const pc = center(price.__box);
    const candidates = (lines || [])
      .map((line) => ({
        ...line,
        __box: boxFrom(line),
        __text: cleanCardLine(line.text),
        __quality: lineTextQuality(line.text)
      }))
      .filter((line) => line.__box && line.__text && line.__quality > -30)
      .filter((line) => !isInstitutional(line.__text))
      .filter((line) => !MONEY_RE.test(line.__text))
      .map((line) => {
        const lc = center(line.__box);
        const aboveGap = price.__box.y - line.__box.y1;
        const belowGap = line.__box.y - price.__box.y1;
        const horizontal = Math.abs(lc.x - pc.x);
        let proximity = 0;
        if (aboveGap >= -12) proximity = 95 - Math.max(0, aboveGap) * .30 - horizontal * .045;
        else if (belowGap >= 0) proximity = 30 - belowGap * .6 - horizontal * .05;
        else proximity = 42 - Math.abs(lc.y - pc.y) * .2 - horizontal * .05;
        return { ...line, __score: line.__quality + proximity };
      })
      .filter((line) => line.__score > 0)
      .sort((a, b) => a.__box.y - b.__box.y || a.__box.x - b.__box.x);

    if (!candidates.length) return { text: '', lines: [], box: null, confidence: 0, score: 0 };

    const anchors = [...candidates].sort((a, b) => b.__score - a.__score).slice(0, Math.min(7, candidates.length));
    let best = null;

    anchors.forEach((anchor) => {
      const anchorIndex = candidates.indexOf(anchor);
      for (let start = Math.max(0, anchorIndex - 3); start <= anchorIndex; start += 1) {
        for (let end = anchorIndex; end <= Math.min(candidates.length - 1, anchorIndex + 2); end += 1) {
          const group = candidates.slice(start, end + 1);
          let contiguous = true;
          for (let i = 1; i < group.length; i += 1) {
            const gap = group[i].__box.y - group[i - 1].__box.y1;
            if (gap > Math.max(44, medianLineHeight * 3.5)) { contiguous = false; break; }
          }
          if (!contiguous) continue;
          const text = clean(group.map((line) => line.__text).join(' '));
          if (!text || isInstitutional(text) || isCondition(text) && group.length === 1) continue;
          const wordCount = tokens(text).length;
          if (!wordCount || wordCount > 18) continue;
          const box = unionBoxes(group.map((line) => line.__box));
          const avgConfidence = group.reduce((sum, line) => sum + numberOr(line.confidence, 80), 0) / group.length;
          const conditionPenalty = group.filter((line) => isCondition(line.__text)).length * 20;
          const packageBonus = PACKAGE_RE.test(text) ? 5 : 0;
          const score = group.reduce((sum, line) => sum + line.__score, 0)
            + Math.min(24, wordCount * 2.2)
            + packageBonus
            - conditionPenalty
            - Math.max(0, wordCount - 13) * 6;
          if (!best || score > best.score) {
            best = { text, lines: group, box, confidence: clamp(avgConfidence / 100, 0, 1), score };
          }
        }
      }
    });

    return best || { text: '', lines: [], box: null, confidence: 0, score: 0 };
  }

  function extractPackage(value) {
    const text = clean(value);
    const match = text.match(PACKAGE_RE);
    return match ? clean(match[0]) : '';
  }

  function splitConditions(lines) {
    return unique((lines || [])
      .map((line) => clean(line.text))
      .filter((text) => text && isCondition(text) && !isInstitutional(text)))
      .join(' · ')
      .slice(0, 250);
  }

  function buildVisualCards(page) {
    const extent = pageExtent(page);
    const lines = (page?.lines || []).map((line) => ({ ...line, __box: boxFrom(line) })).filter((line) => line.__box && clean(line.text));
    const prices = dedupePrices(page?.prices || []);
    if (!prices.length) return { cards: [], extent, prices: [], lineCount: lines.length };

    const medianLineHeight = Math.max(8, median(lines.map((line) => line.__box.height)) || 16);
    const medianPriceHeight = Math.max(medianLineHeight, median(prices.map((price) => price.__box.height)) || medianLineHeight * 1.8);
    const bands = makePriceBands(prices, medianPriceHeight, medianLineHeight);
    const cards = [];

    bands.forEach((band) => {
      band.prices.forEach((price) => {
        const horizontal = horizontalCellFor(price, band, extent, medianPriceHeight);
        const vertical = verticalCellFor(price, prices, extent, horizontal, medianPriceHeight, medianLineHeight);
        const cell = { left: horizontal.left, right: horizontal.right, top: vertical.top, bottom: vertical.bottom };
        const cellLines = lines.filter((line) => lineCenterInside(line.__box, cell))
          .filter((line) => !lineOverlapsPrice(line.__box, prices))
          .filter((line) => !isInstitutional(line.text));
        const hypothesis = selectProductGroup(cellLines, price, medianLineHeight);
        const conditionText = splitConditions(cellLines);
        const rawText = unique(cellLines.map((line) => clean(line.text)).filter(Boolean)).join(' ');
        const useful = cellLines.filter((line) => lineTextQuality(line.text) > 0);
        const textPassSupport = hypothesis.lines.length
          ? Math.max(1, Math.round(hypothesis.lines.reduce((sum, line) => sum + Math.max(1, (line.sources || []).length), 0) / hypothesis.lines.length))
          : 0;
        const cardBoxRaw = unionBoxes([price.__box, ...useful.map((line) => line.__box)]) || price.__box;
        const cardConfidence = clamp(
          .35
          + Math.min(.22, numberOr(price.confidence, 70) / 100 * .22)
          + Math.min(.22, hypothesis.confidence * .22)
          + (hypothesis.text ? .12 : 0)
          + (price.currencyExplicit === true ? .08 : 0),
          0,
          .99
        );

        cards.push({
          id: `p${page.pageNumber}-card-${String(cards.length + 1).padStart(3, '0')}`,
          pageNumber: Number(page.pageNumber || 1),
          price: Number(price.value),
          priceText: clean(price.text),
          priceConfidence: clamp(numberOr(price.confidence, 0) / 100, 0, 1),
          currencyExplicit: price.currencyExplicit === true,
          pricePattern: clean(price.pattern),
          pricePasses: Math.max(1, Math.round(numberOr(price.passes, 1))),
          priceConflict: price.conflict === true,
          priceConflictValues: [...(price.conflictValues || [])].map(Number).filter(Number.isFinite),
          priceBoxRaw: price.__box,
          priceBox: toBaseBox(page, price.__box, extent),
          cardBoxRaw,
          cardBox: toBaseBox(page, cardBoxRaw, extent),
          normalizedCenter: pagePointNormalized(page, price.__box, extent),
          rawText,
          productHypothesis: hypothesis.text,
          productBoxRaw: hypothesis.box,
          productBox: toBaseBox(page, hypothesis.box, extent),
          packageText: extractPackage(hypothesis.text || rawText),
          conditions: conditionText,
          lineIds: hypothesis.lines.map((line) => clean(line.text)),
          textPassSupport,
          confidence: cardConfidence,
          cell: {
            left: clamp((cell.left - extent.minX) / Math.max(1, extent.width), 0, 1),
            right: clamp((cell.right - extent.minX) / Math.max(1, extent.width), 0, 1),
            top: clamp((cell.top - extent.minY) / Math.max(1, extent.height), 0, 1),
            bottom: clamp((cell.bottom - extent.minY) / Math.max(1, extent.height), 0, 1)
          }
        });
      });
    });

    return { cards, extent, prices, lineCount: lines.length };
  }

  function candidateCardScore(candidate, card, page) {
    if (Number(candidate.pageNumber || 0) !== Number(card.pageNumber || 0)) return -1;
    const price = Number(candidate.price);
    const priceDelta = Math.abs(price - Number(card.price));
    const priceScore = priceDelta < .011 ? 1 : (priceDelta <= Math.max(.03, price * .006) ? .68 : 0);
    if (!priceScore) return -1;
    const textScore = Math.max(
      tokenCoverage(candidate.productName, card.rawText),
      tokenSimilarity(candidate.productName, card.productHypothesis)
    );
    const candidatePoint = sourcePointNormalized(candidate, page);
    const spatialDistance = normalizedDistance(candidatePoint, card.normalizedCenter);
    const spatialScore = candidatePoint ? clamp(1 - spatialDistance / .42, 0, 1) : .45;
    return priceScore * .43 + textScore * .40 + spatialScore * .17;
  }

  function chooseCardForCandidate(candidate, pageCards, page) {
    let best = null;
    (pageCards || []).forEach((card) => {
      const score = candidateCardScore(candidate, card, page);
      if (score < 0) return;
      if (!best || score > best.score) best = { card, score };
    });
    return best && best.score >= .48 ? best : null;
  }

  function descriptionDecision(candidateName, card) {
    const original = clean(candidateName);
    const hypothesis = clean(card?.productHypothesis);
    const raw = clean(card?.rawText);
    const originalInCard = tokenCoverage(original, raw);
    const hypothesisContainsOriginal = tokenCoverage(original, hypothesis);
    const hypothesisInOriginal = tokenCoverage(hypothesis, original);
    const similarity = tokenSimilarity(original, hypothesis);
    const originalTokens = tokens(original).length;
    const hypothesisTokens = tokens(hypothesis).length;

    if (!hypothesis) {
      return { name: original, conflict: originalInCard < .45, improved: false, originalInCard, similarity };
    }

    // Completa descrição truncada somente quando TODOS (ou quase todos) os tokens originais
    // continuam dentro da hipótese do MESMO card. Nada é preenchido por conhecimento externo.
    if (hypothesisTokens > originalTokens && hypothesisContainsOriginal >= .82 && !isInstitutional(hypothesis) && hypothesisTokens <= 16) {
      return { name: hypothesis, conflict: false, improved: true, originalInCard, similarity };
    }

    // Remove contaminação de card vizinho quando a hipótese é mais curta, coerente e está
    // inteiramente contida no texto anterior, mas só se o rawText do card a sustentar fortemente.
    if (originalTokens >= hypothesisTokens + 2 && hypothesisInOriginal >= .90 && tokenCoverage(hypothesis, raw) >= .90
      && originalInCard < .76 && hypothesisTokens >= 1 && hypothesisTokens <= 14) {
      return { name: hypothesis, conflict: false, improved: true, trimmed: true, originalInCard, similarity };
    }

    const conflict = originalInCard < .50 || (similarity < .24 && originalTokens >= 2 && hypothesisTokens >= 2);
    return { name: original, conflict, improved: false, originalInCard, similarity };
  }

  function mergeCandidateWithCard(candidate, match, page) {
    const output = { ...candidate };
    const risks = new Set(output.riskFlags || []);
    const evidence = new Set(output.evidence || []);
    const card = match?.card || null;

    if (!card) {
      risks.add('association_disagreement');
      evidence.add('Card Resolver não encontrou um card documental inequívoco para este candidato');
      output.automationSafe = false;
      output.structuralSafe = false;
      output.confidence = Math.min(numberOr(output.confidence, .7), .89);
      output.riskFlags = [...risks];
      output.evidence = [...evidence];
      output.cardResolution = { status: 'unmatched', resolverVersion: RESOLVER_VERSION };
      return output;
    }

    const description = descriptionDecision(output.productName, card);
    const priceAgreement = Math.abs(Number(output.price) - Number(card.price)) < .011;
    const cardSupport = Math.max(description.originalInCard, tokenSimilarity(output.productName, card.productHypothesis));

    if (!priceAgreement) risks.add('price_cluster_disagreement');
    if (description.conflict) risks.add('knowledge_legacy_description_conflict');
    if (isInstitutional(description.name)) risks.add('header_contamination');
    if (!card.currencyExplicit && card.pricePasses < 2) risks.add('ocr_price_without_currency');
    if (card.priceConfidence > 0 && card.priceConfidence < .72) risks.add('ocr_low_price_confidence');
    if (!card.productHypothesis || lineTextQuality(card.productHypothesis) < 8) risks.add('ocr_low_description_quality');
    if (match.score < .58) risks.add('ocr_block_ownership_weak');

    if (description.improved && !description.conflict) {
      output.productName = description.name.slice(0, 160);
      evidence.add(description.trimmed
        ? 'Card documental removeu texto que pertencia a outra região da página'
        : 'Card documental completou a descrição usando somente texto contido no mesmo bloco visual');
      // Uma correção de identidade nunca vira publicação automática no mesmo passe.
      // O dado corrigido continua visível ao administrador, mas exige supervisão.
      output.automationSafe = false;
      output.structuralSafe = false;
      if (description.trimmed) risks.add('knowledge_legacy_description_conflict');
    }

    const packageText = extractPackage(card.productHypothesis || card.rawText);
    if (packageText && (!output.packageText || tokenCoverage(output.packageText, card.rawText) < .55)) output.packageText = packageText.slice(0, 100);
    if (card.conditions && !output.conditions) output.conditions = card.conditions.slice(0, 250);

    evidence.add('produto e preço vinculados ao mesmo card documental antes da resolução da oferta');
    evidence.add(`card ${card.id} · confiança estrutural ${Math.round(card.confidence * 100)}%`);

    const hardBlocked = [...risks].some((risk) => HARD_RISK.has(risk));
    const existingConfidence = clamp(numberOr(output.confidence, .6), 0, 1);
    const resolvedConfidence = clamp(
      existingConfidence * .44
      + card.confidence * .24
      + match.score * .18
      + cardSupport * .14,
      0,
      .995
    );

    output.confidence = hardBlocked ? Math.min(resolvedConfidence, .89) : Math.max(existingConfidence, resolvedConfidence);
    output.associationAgreement = hardBlocked ? Math.min(numberOr(output.associationAgreement, 0), .78) : Math.max(numberOr(output.associationAgreement, 0), match.score);
    output.ownershipConfidence = hardBlocked ? Math.min(numberOr(output.ownershipConfidence, 0), .78) : Math.max(numberOr(output.ownershipConfidence, 0), match.score);
    output.clusterCoherence = hardBlocked ? Math.min(numberOr(output.clusterCoherence, 0), .80) : Math.max(numberOr(output.clusterCoherence, 0), cardSupport, card.confidence);
    output.descriptionAgreement = hardBlocked ? Math.min(numberOr(output.descriptionAgreement, 0), .79) : Math.max(numberOr(output.descriptionAgreement, 0), cardSupport);
    output.descriptionCompleteness = Math.max(numberOr(output.descriptionCompleteness, 0), clamp(tokens(output.productName).length / 8, .40, 1));
    output.knowledgeCardText = card.rawText || output.knowledgeCardText || output.productName;
    output.knowledgeOwnerConfidence = match.score;
    output.sourceBox = card.cardBox || output.sourceBox || null;
    output.cardId = card.id;
    output.cardConfidence = card.confidence;
    output.cardResolutionScore = match.score;
    output.cardResolution = {
      status: hardBlocked ? 'conflict' : 'resolved',
      resolverVersion: RESOLVER_VERSION,
      cardId: card.id,
      score: Number(match.score.toFixed(4)),
      cardSupport: Number(cardSupport.toFixed(4)),
      originalProductName: clean(candidate.productName),
      resolvedProductName: clean(output.productName)
    };
    output.riskFlags = unique([...risks]);
    output.evidence = unique([...evidence]);
    output.structuralSafe = !hardBlocked && card.confidence >= .84 && match.score >= .66 && cardSupport >= .62
      && output.structuralSafe !== false;
    output.automationSafe = !hardBlocked && card.confidence >= .90 && match.score >= .74 && cardSupport >= .72
      && output.automationSafe !== false;
    output.extractionMode = `${clean(output.extractionMode || 'knowledge-json')}+card-first`;
    return output;
  }

  function makeOrphanCandidate(card, validity, page, existingCandidates) {
    if (!card?.productHypothesis || !validPrice(card.price)) return null;
    if (isInstitutional(card.productHypothesis) || lineTextQuality(card.productHypothesis) < 12) return null;
    if ((existingCandidates || []).some((candidate) => {
      if (Number(candidate.pageNumber) !== Number(card.pageNumber)) return false;
      if (Math.abs(Number(candidate.price) - Number(card.price)) >= .011) return false;
      return tokenSimilarity(candidate.productName, card.productHypothesis) >= .42;
    })) return null;

    const risks = ['single_association_pass'];
    if (!card.currencyExplicit) risks.push('ocr_price_without_currency');
    if (card.priceConfidence && card.priceConfidence < .78) risks.push('ocr_low_price_confidence');
    // Orphan sempre exige revisão humana: ele serve para COBERTURA, nunca para publicação automática.
    risks.push('ocr_block_ownership_weak');

    const category = window.MercadorIA?.inferCategory?.(card.productHypothesis) || 'outros';
    const confidence = Math.min(.89, Math.max(.62, card.confidence * .90));
    return {
      id: `card-orphan-${card.id}`,
      pageNumber: card.pageNumber,
      pageWidth: numberOr(page?.width, 0),
      pageHeight: numberOr(page?.height, 0),
      productName: card.productHypothesis.slice(0, 160),
      category,
      brand: '',
      packageText: (card.packageText || '').slice(0, 100),
      price: Number(card.price),
      previousPrice: null,
      detectedPrices: [Number(card.price)],
      priceKind: 'general',
      requiresClub: false,
      clubName: '',
      clubSignal: false,
      conditions: (card.conditions || '').slice(0, 250),
      confidence,
      riskFlags: risks,
      evidence: [
        'card comercial encontrado no Knowledge JSON sem candidato equivalente do motor anterior',
        'item mantido exclusivamente em revisão para evitar perda silenciosa de oferta'
      ],
      associationAgreement: .70,
      ownershipConfidence: .70,
      clusterCoherence: card.confidence,
      descriptionCompleteness: clamp(tokens(card.productHypothesis).length / 8, .45, 1),
      descriptionAgreement: .70,
      descriptionVariantCount: 1,
      knowledgeCardText: card.rawText || card.productHypothesis,
      knowledgeOwnerConfidence: .70,
      structuralSafe: false,
      automationSafe: false,
      sourceBox: card.cardBox || null,
      startAt: validity?.startAt || null,
      endAt: validity?.endAt || null,
      verified: false,
      verificationMode: '',
      ignored: false,
      published: false,
      reviewed: false,
      extractionMode: 'knowledge-json-card-first-orphan',
      cardId: card.id,
      cardConfidence: card.confidence,
      cardResolutionScore: .70,
      cardResolution: { status: 'orphan_review', resolverVersion: RESOLVER_VERSION, cardId: card.id, score: .70 }
    };
  }

  function candidateSignature(candidate) {
    return [
      Number(candidate.pageNumber || 0),
      Number(candidate.price || 0).toFixed(2),
      normalizedText(candidate.productName)
    ].join('|');
  }

  function dedupeCandidates(candidates) {
    const output = [];
    const signatures = new Set();
    [...(candidates || [])]
      .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
      .forEach((candidate) => {
        const signature = candidateSignature(candidate);
        if (signatures.has(signature)) return;
        const nearDuplicate = output.some((existing) => Number(existing.pageNumber) === Number(candidate.pageNumber)
          && Math.abs(Number(existing.price) - Number(candidate.price)) < .011
          && tokenSimilarity(existing.productName, candidate.productName) >= .82
          && (() => {
            const a = boxFrom(existing.sourceBox), b = boxFrom(candidate.sourceBox);
            if (!a || !b) return false;
            const ac = center(a), bc = center(b);
            return Math.abs(ac.x - bc.x) <= Math.max(24, a.width * .22, b.width * .22)
              && Math.abs(ac.y - bc.y) <= Math.max(24, a.height * .22, b.height * .22);
          })());
        if (nearDuplicate) return;
        signatures.add(signature);
        output.push(candidate);
      });
    return output.sort((a, b) => Number(a.pageNumber) - Number(b.pageNumber)
      || numberOr(a.sourceBox?.y, 0) - numberOr(b.sourceBox?.y, 0)
      || numberOr(a.sourceBox?.x, 0) - numberOr(b.sourceBox?.x, 0));
  }

  function serializeCard(card) {
    return {
      id: card.id,
      pageNumber: card.pageNumber,
      bbox: card.cardBox,
      priceAnchor: {
        value: card.price,
        text: card.priceText,
        confidence: card.priceConfidence,
        currencyExplicit: card.currencyExplicit,
        passes: card.pricePasses,
        conflict: card.priceConflict === true,
        conflictValues: [...(card.priceConflictValues || [])],
        bbox: card.priceBox
      },
      rawText: card.rawText,
      productHypothesis: card.productHypothesis,
      packageText: card.packageText,
      conditions: card.conditions,
      confidence: card.confidence,
      textPassSupport: Number(card.textPassSupport || 0),
      cell: card.cell
    };
  }

  function serializeOffer(candidate) {
    return {
      id: candidate.id,
      pageNumber: candidate.pageNumber,
      cardId: candidate.cardId || null,
      productName: candidate.productName,
      brand: candidate.brand || '',
      packageText: candidate.packageText || '',
      price: Number(candidate.price || 0),
      previousPrice: Number(candidate.previousPrice || 0) || null,
      priceKind: candidate.priceKind || 'general',
      conditions: candidate.conditions || '',
      confidence: Number(candidate.confidence || 0),
      automationSafe: candidate.automationSafe === true,
      structuralSafe: candidate.structuralSafe === true,
      riskFlags: [...(candidate.riskFlags || [])],
      evidence: [...(candidate.evidence || [])],
      bbox: candidate.sourceBox || null,
      cardResolution: candidate.cardResolution || null
    };
  }

  function enhanceKnowledgeDocument(result, pageResolutions, candidates) {
    const original = result?.knowledgeDocument && typeof result.knowledgeDocument === 'object'
      ? result.knowledgeDocument
      : {};
    const previousSchemaVersion = original.schemaVersion || result.knowledgeSchemaVersion || '';
    const pageMap = new Map(pageResolutions.map((entry) => [Number(entry.page.pageNumber), entry]));
    const conflicts = candidates.filter((candidate) => (candidate.riskFlags || []).some((risk) => HARD_RISK.has(risk)))
      .map((candidate) => ({
        id: `conflict-${candidate.id}`,
        pageNumber: candidate.pageNumber,
        cardId: candidate.cardId || null,
        productName: candidate.productName,
        price: Number(candidate.price || 0),
        riskFlags: [...(candidate.riskFlags || [])],
        resolution: 'manual_review_required'
      }));

    const pages = (original.pages || []).map((page) => {
      const resolution = pageMap.get(Number(page.pageNumber));
      return {
        ...page,
        visualBlocks: resolution ? resolution.cards.map(serializeCard) : (page.visualBlocks || [])
      };
    });

    return {
      ...original,
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      previousSchemaVersion,
      resolverVersion: RESOLVER_VERSION,
      resolvedAt: new Date().toISOString(),
      pages,
      cardResolution: {
        strategy: 'document-first/card-first',
        resolverVersion: RESOLVER_VERSION,
        cards: pageResolutions.reduce((sum, entry) => sum + entry.cards.length, 0),
        resolved: candidates.filter((candidate) => candidate.cardResolution?.status === 'resolved').length,
        unresolved: candidates.filter((candidate) => candidate.cardResolution?.status !== 'resolved').length,
        conflicts: conflicts.length
      },
      visualBlocks: pageResolutions.flatMap((entry) => entry.cards.map(serializeCard)),
      offerCandidates: candidates.map(serializeOffer),
      resolvedOffers: candidates.filter((candidate) => candidate.cardResolution?.status === 'resolved'
        && !(candidate.riskFlags || []).some((risk) => HARD_RISK.has(risk))).map(serializeOffer),
      conflicts
    };
  }

  function resolveDocument(result) {
    const knowledge = result?.knowledgeDocument;
    if (!knowledge || !Array.isArray(knowledge.pages) || !knowledge.pages.length) {
      return {
        ...result,
        engineVersion: `${result?.engineVersion || previous.ENGINE_VERSION || 'unknown'}+${RESOLVER_VERSION}`,
        knowledgeSchemaVersion: result?.knowledgeSchemaVersion || KNOWLEDGE_SCHEMA_VERSION,
        cardResolverVersion: RESOLVER_VERSION
      };
    }

    const pagesByNumber = new Map(knowledge.pages.map((page, index) => [Number(page.pageNumber || index + 1), page]));
    const pageResolutions = knowledge.pages.map((page) => ({ page, ...buildVisualCards(page) }));
    const cardsByPage = new Map(pageResolutions.map((entry) => [Number(entry.page.pageNumber), entry.cards]));
    const matchedCardIds = new Set();

    const resolvedBase = (result.candidates || []).map((candidate) => {
      const page = pagesByNumber.get(Number(candidate.pageNumber)) || null;
      const match = page ? chooseCardForCandidate(candidate, cardsByPage.get(Number(candidate.pageNumber)) || [], page) : null;
      if (match?.card?.id) matchedCardIds.add(match.card.id);
      return mergeCandidateWithCard(candidate, match, page);
    });

    const orphanCandidates = [];
    pageResolutions.forEach((entry) => {
      entry.cards.forEach((card) => {
        if (matchedCardIds.has(card.id)) return;
        const orphan = makeOrphanCandidate(card, result.validity, entry.page, resolvedBase);
        if (orphan) orphanCandidates.push(orphan);
      });
    });

    const candidates = dedupeCandidates([...resolvedBase, ...orphanCandidates]);
    const enhancedKnowledge = enhanceKnowledgeDocument(result, pageResolutions, candidates);
    const conflicts = candidates.filter((candidate) => (candidate.riskFlags || []).some((risk) => HARD_RISK.has(risk))).length;
    const resolvedCount = candidates.filter((candidate) => candidate.cardResolution?.status === 'resolved').length;
    const cards = pageResolutions.reduce((sum, entry) => sum + entry.cards.length, 0);
    const baseMetrics = result.knowledgeMetrics || {};

    return {
      ...result,
      candidates,
      engineVersion: `${result.engineVersion || previous.ENGINE_VERSION || 'unknown'}+${RESOLVER_VERSION}`,
      extractionMode: `${result.extractionMode || 'knowledge-json'}+card-first`,
      knowledgeSchemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      knowledgeDocument: enhancedKnowledge,
      knowledgeMetrics: {
        ...baseMetrics,
        modes: unique([...(baseMetrics.modes || []), 'card-first']),
        cards,
        resolvedCards: resolvedCount,
        conflicts,
        candidates: candidates.length
      },
      cardResolverVersion: RESOLVER_VERSION,
      cardResolutionMetrics: { cards, resolved: resolvedCount, conflicts, orphans: orphanCandidates.length }
    };
  }

  async function analyzeFile(file, options = {}, onProgress) {
    const progress = typeof onProgress === 'function' ? onProgress : null;
    const result = await previousAnalyzeFile(file, options, (state) => {
      if (!progress) return;
      const percent = clamp(Number(state?.percent || 0) * .94, 0, 94);
      progress({ ...state, percent });
    });
    if (progress) progress({ pageNumber: result?.numPages || 1, numPages: result?.numPages || 1, percent: 96, mode: 'card-first-resolution' });
    const resolved = resolveDocument(result);
    if (progress) progress({ pageNumber: resolved?.numPages || 1, numPages: resolved?.numPages || 1, percent: 100, mode: 'card-first-complete' });
    window.MercadorPDFImporter.lastKnowledgeDocument = resolved.knowledgeDocument || result.knowledgeDocument || null;
    return resolved;
  }

  function downloadKnowledgeJson(knowledgeDocument, fileName = 'encarte') {
    const data = knowledgeDocument || window.MercadorPDFImporter?.lastKnowledgeDocument;
    if (!data) throw new Error('Nenhum JSON de conhecimento disponível. Analise um encarte primeiro.');
    if (previousDownloadKnowledgeJson && data.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION) {
      return previousDownloadKnowledgeJson(data, fileName);
    }
    const safe = String(fileName || 'encarte').replace(/\.pdf$/i, '').replace(/[^a-z0-9._-]+/gi, '_');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safe}.mercador-knowledge-v5.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.MercadorPDFImporter = {
    ...previous,
    ENGINE_VERSION: RESOLVER_VERSION,
    KNOWLEDGE_SCHEMA_VERSION,
    CARD_RESOLVER_VERSION: RESOLVER_VERSION,
    analyzeFile,
    analyzeFileBeforeCardResolver: previousAnalyzeFile,
    resolveKnowledgeDocumentCardFirst: resolveDocument,
    downloadKnowledgeJson,
    __cardFirstResolverInstalled: true
  };

  console.info(`[Mercador IA] Card Resolver ${RESOLVER_VERSION} ativo sobre ${previous.ENGINE_VERSION || 'motor anterior'}.`);
})();
