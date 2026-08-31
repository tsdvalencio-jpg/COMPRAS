(function () {
  'use strict';

  // Mercador IA — camada universal de entrada documental.
  // Preserva integralmente o importador PDF existente e acrescenta imagens e texto/OCR.
  // Todos os caminhos convergem para o mesmo formato de resultado/candidates usado pelo Admin.

  const previous = window.MercadorPDFImporter;
  if (!previous || typeof previous.analyzeFile !== 'function') {
    console.error('[Mercador IA] Importador documental não instalado: motor PDF base indisponível.');
    return;
  }
  if (previous.__multiFormatDocumentImporterInstalled) return;

  const ENGINE_VERSION = '6.2.0-grid-badge-consensus';
  const KNOWLEDGE_SCHEMA_VERSION = 'mercador.encarte.knowledge.v6';
  const TESSERACT_VERSION = '5.1.1';
  const TESSERACT_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`;
  const MAX_IMAGE_FILES = 12;
  const MAX_IMAGE_BYTES = 18 * 1024 * 1024;
  const IMAGE_TARGET_WIDTH = 900;
  const IMAGE_MAX_HEIGHT = 6200;

  const previousAnalyzeFile = previous.analyzeFile.bind(previous);
  const previousRenderPreview = typeof previous.renderPreview === 'function' ? previous.renderPreview.bind(previous) : null;
  const previousDownloadKnowledgeJson = typeof previous.downloadKnowledgeJson === 'function' ? previous.downloadKnowledgeJson.bind(previous) : null;
  const resolveCardFirst = typeof previous.resolveKnowledgeDocumentCardFirst === 'function'
    ? previous.resolveKnowledgeDocumentCardFirst.bind(previous)
    : null;

  let tesseractPromise = null;
  let activeSource = { type: '', hash: '', rasterPages: [], text: '' };

  const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
  const clean = (v) => String(v == null ? '' : v).replace(/\u0000/g, '').replace(/[\t\u00a0]+/g, ' ').replace(/\s+/g, ' ').trim();
  const fold = (v) => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const normalizeName = (v) => fold(v).replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const unique = (list) => [...new Set((list || []).filter(Boolean))];
  const validPrice = (v) => Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) < 10000;

  const INSTITUTIONAL_RE = /\b(?:HOR[ÁA]RIO\s+DE\s+ATENDIMENTO|PRE[CÇ]OS?\s+V[ÁA]LID|OFERTAS?|FEIR[ÃA]O|WHATSAPP|RECEBA\s+NOSSAS|ESCANEIE|QR\s*CODE|GOOGLE\s*PLAY|APP\s*STORE|CLUBE\s+DE\s+VANTAGENS|TODO\s+MUNDO|ATACADO|ATACADISTA|ENQUANTO\s+HOUVER\s+ESTOQUE|ENQUANTO\s+DURAREM|DOMINGO|FERIADOS?|SEGUNDA\s+A\s+S[ÁA]BADO|PARTICIPE\s+DA\s+COMUNIDADE)\b/i;
  const CONDITION_RE = /\b(?:A\s+PARTIR\s+DE|LEVE\s+\d+|PAGUE\s+\d+|POR\s+CLIENTE|LIMITE|CLUBE|APP|APLICATIVO|CADA|UNIDADE\s+SAI\s+POR|NESTA\s+EMBALAGEM|ENQUANTO\s+HOUVER|ENQUANTO\s+DURAREM|EXCETO|SOMENTE)\b/i;
  const PACKAGE_RE = /\b(?:PACOTE|PCT|BANDEJA|BDJ|POTE|GARRAFA|PET|LATA|CAIXA|CX|SACO|SACH[ÊE]|FRASCO|CARTELA|UNIDADE|UNID|UN|UND)\s*(?:DE\s*)?\d*(?:[,.]\d+)?\s*(?:KG|G|GR|ML|L|LT|LTS|UN|UND|UNIDADES?)?\b|\b\d+(?:[,.]\d+)?\s*(?:KG|G|GR|ML|L|LT|LTS|UN|UND|UNIDADES?)\b|\b(?:KG|UNIDADE|UNID|UNIDADES|BDJ)\b/i;

  function bbox(word) {
    if (!word) return null;
    const x = Number(word.x ?? word.x0 ?? word.left ?? 0);
    const y = Number(word.y ?? word.y0 ?? word.top ?? 0);
    const width = Math.max(1, Number(word.width ?? ((word.x1 ?? x + 1) - x) ?? 1));
    const height = Math.max(1, Number(word.height ?? ((word.y1 ?? y + 1) - y) ?? 1));
    return { x, y, width, height, x1: x + width, y1: y + height };
  }

  function unionBoxes(values) {
    const boxes = (values || []).map(bbox).filter(Boolean);
    if (!boxes.length) return null;
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x1));
    const y1 = Math.max(...boxes.map((b) => b.y1));
    return { x, y, width: Math.max(1, x1 - x), height: Math.max(1, y1 - y), x1, y1 };
  }

  function center(value) {
    const b = bbox(value);
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : { x: 0, y: 0 };
  }

  function overlap1d(a0, a1, b0, b1) {
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }

  function intersectionRatio(aValue, bValue) {
    const a = bbox(aValue), b = bbox(bValue);
    if (!a || !b) return 0;
    const ix = overlap1d(a.x, a.x1, b.x, b.x1);
    const iy = overlap1d(a.y, a.y1, b.y, b.y1);
    const area = ix * iy;
    if (!area) return 0;
    return area / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
  }

  function median(values) {
    const a = (values || []).map(Number).filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return 0;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  async function sha256Bytes(bytes) {
    try {
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (_) { return ''; }
  }

  async function sha256Text(text) {
    return sha256Bytes(new TextEncoder().encode(String(text || '')).buffer);
  }

  async function sha256Files(files) {
    try {
      const parts = [];
      let total = 0;
      for (const file of files) {
        const name = new TextEncoder().encode(`${file.name}\n${file.type}\n${file.size}\n`);
        const body = new Uint8Array(await file.arrayBuffer());
        parts.push(name, body);
        total += name.length + body.length;
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      parts.forEach((part) => { merged.set(part, offset); offset += part.length; });
      return sha256Bytes(merged.buffer);
    } catch (_) { return ''; }
  }

  function normalizeNumericText(value) {
    return fold(value)
      .replace(/(?<=\d)[OQ](?=\d|\b)/g, '0')
      .replace(/[IL|](?=\d)/g, '1')
      .replace(/(?<=\d)[IL|](?=\d|\b)/g, '1')
      .replace(/\bRS\b/g, 'R$')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseMoneyText(value) {
    let text = normalizeNumericText(value);
    const explicitCurrency = /R\s*\$|\bR\$|\bRS\b/.test(text);
    let m = text.match(/(?:R\s*\$\s*)?(\d{1,4})\s*[,.;:]\s*(\d{2})(?!\d)/);
    if (m) {
      const price = Number(`${m[1]}.${m[2]}`);
      if (validPrice(price)) return { price:Number(price.toFixed(2)), explicitCurrency, pattern:'decimal' };
    }
    if (explicitCurrency) {
      m = text.match(/R\s*\$\s*(\d{1,4})\s+(\d{2})(?!\d)/);
      if (m) {
        const price = Number(`${m[1]}.${m[2]}`);
        if (validPrice(price)) return { price:Number(price.toFixed(2)), explicitCurrency:true, pattern:'split-cents' };
      }
      m = text.match(/R\s*\$\s*(\d{3,5})(?!\d)/);
      if (m) {
        const digits = m[1];
        const price = Number(`${digits.slice(0,-2)}.${digits.slice(-2)}`);
        if (validPrice(price)) return { price:Number(price.toFixed(2)), explicitCurrency:true, pattern:'compact-cents' };
      }
    }
    return null;
  }

  function looksNumericWord(value) {
    const t = fold(value).replace(/\s+/g, '');
    return /^(?:R\$|R|\$|RS|[0-9IL|OQ]+|[,.;:])$/.test(t)
      || /^(?:R\$)?[0-9IL|OQ]{1,5}[,.;:][0-9IL|OQ]{1,2}$/.test(t);
  }

  function currencyWord(value) {
    return /^(?:R\$|R|\$|RS)$/i.test(clean(value));
  }

  function numericDigits(value) {
    const t = normalizeNumericText(value).replace(/[^0-9]/g, '');
    return t;
  }

  function normalizeWords(data, pass) {
    const rawWords = Array.isArray(data?.words) && data.words.length
      ? data.words
      : (Array.isArray(data?.blocks) ? data.blocks.flatMap((block) => (block.paragraphs || []).flatMap((p) => (p.lines || []).flatMap((l) => l.words || []))) : []);
    return rawWords.map((word, index) => {
      const b = word.bbox || {};
      const x = Number(b.x0 ?? b.left ?? word.left ?? 0);
      const y = Number(b.y0 ?? b.top ?? word.top ?? 0);
      const x1 = Number(b.x1 ?? b.right ?? x + Number(word.width || 1));
      const y1 = Number(b.y1 ?? b.bottom ?? y + Number(word.height || 1));
      return {
        id:`${pass}-${index}`,
        text:clean(word.text),
        confidence:clamp(Number(word.confidence ?? word.conf ?? 0), 0, 100),
        x, y, width:Math.max(1, x1-x), height:Math.max(1, y1-y),
        sources:[pass], alternatives:[]
      };
    }).filter((word) => word.text && word.width > 0 && word.height > 0);
  }

  function mergeWordSets(wordSets) {
    const output = [];
    (wordSets || []).flat().sort((a,b) => Number(b.confidence)-Number(a.confidence)).forEach((word) => {
      const wc = center(word);
      const same = output.find((existing) => {
        const ec = center(existing);
        const overlap = intersectionRatio(existing, word);
        const dist = Math.hypot(ec.x-wc.x, ec.y-wc.y);
        const scale = Math.max(8, Math.min(existing.height, word.height));
        return overlap >= .50 || (dist <= scale*.58 && Math.abs(existing.width-word.width) <= Math.max(existing.width,word.width)*.55);
      });
      if (!same) {
        output.push({ ...word, sources:[...(word.sources||[])], alternatives:[] });
        return;
      }
      same.sources = unique([...(same.sources||[]), ...(word.sources||[])]);
      if (normalizeName(same.text) !== normalizeName(word.text) && word.text) {
        same.alternatives = unique([...(same.alternatives||[]), word.text]);
      }
      if (Number(word.confidence) > Number(same.confidence)) {
        const preservedSources = same.sources, alternatives = same.alternatives;
        Object.assign(same, word);
        same.sources = preservedSources;
        same.alternatives = alternatives;
      }
    });
    return output.sort((a,b) => a.y-b.y || a.x-b.x);
  }

  function segmentLines(words) {
    if (!(words || []).length) return [];
    const medianH = Math.max(8, median(words.map((w) => w.height)) || 16);
    const tolerance = Math.max(7, medianH*.58);
    const rows = [];
    [...words].sort((a,b)=>a.y-b.y||a.x-b.x).forEach((word) => {
      const cy = word.y + word.height/2;
      let best = null, delta = Infinity;
      rows.forEach((row) => {
        const d = Math.abs(row.cy-cy);
        if (d <= tolerance && d < delta) { best=row; delta=d; }
      });
      if (!best) { best={cy,words:[]}; rows.push(best); }
      best.words.push(word);
      best.cy = best.words.reduce((sum,w)=>sum+w.y+w.height/2,0)/best.words.length;
    });
    const lines=[];
    rows.forEach((row) => {
      const sorted=row.words.sort((a,b)=>a.x-b.x);
      let segment=[];
      const flush=()=>{
        if(!segment.length)return;
        const b=unionBoxes(segment);
        const text=clean(segment.map((w)=>w.text).join(' '));
        const confidence=segment.reduce((sum,w)=>sum+Number(w.confidence||0),0)/segment.length;
        const sources=unique(segment.flatMap((w)=>w.sources||[]));
        lines.push({text,confidence,bbox:{x:b.x,y:b.y,width:b.width,height:b.height},wordIds:segment.map((w)=>w.id),sources});
        segment=[];
      };
      sorted.forEach((word) => {
        if(segment.length){
          const prev=segment[segment.length-1];
          const gap=word.x-(prev.x+prev.width);
          const scale=Math.max(prev.height,word.height,medianH,8);
          if(gap>Math.max(24,Math.min(58,scale*1.75)))flush();
        }
        segment.push(word);
      });
      flush();
    });
    return lines.sort((a,b)=>a.bbox.y-b.bbox.y||a.bbox.x-b.bbox.x);
  }

  function pricesFromPass(words, lines, pass) {
    const found=[];
    const medianH=Math.max(8,median(words.map((w)=>w.height))||16);

    (lines||[]).forEach((line) => {
      const lineWords=(line.wordIds||[]).map((id)=>words.find((w)=>w.id===id)).filter(Boolean).sort((a,b)=>a.x-b.x);
      for(let i=0;i<lineWords.length;i+=1){
        if(!looksNumericWord(lineWords[i].text))continue;
        for(let len=1;len<=5&&i+len<=lineWords.length;len+=1){
          const slice=lineWords.slice(i,i+len);
          if(slice.some((w)=>!looksNumericWord(w.text)))break;
          const parsed=parseMoneyText(slice.map((w)=>w.text).join(' '));
          if(!parsed)continue;
          const b=unionBoxes(slice);
          const confidence=slice.reduce((sum,w)=>sum+Number(w.confidence||0),0)/slice.length;
          const scale=b.height/medianH;
          if(!parsed.explicitCurrency && scale<1.30)continue;
          found.push({value:parsed.price,text:clean(slice.map((w)=>w.text).join(' ')),confidence,currencyExplicit:parsed.explicitCurrency,pattern:parsed.pattern,passes:1,passNames:[pass],bbox:{x:b.x,y:b.y,width:b.width,height:b.height}});
        }
      }
    });

    // Reconstrói tipografia promocional em que reais e centavos são glifos separados.
    const currency = words.filter((w)=>currencyWord(w.text));
    const majors = words.filter((w)=>/^\d{1,3}$/.test(numericDigits(w.text)) && w.height>=medianH*1.30);
    majors.forEach((major) => {
      const mc=center(major), majorDigits=numericDigits(major.text);
      const cents=words.filter((w)=>w!==major&&/^\d{2}$/.test(numericDigits(w.text))).filter((w)=>{
        const wc=center(w), gap=w.x-(major.x+major.width), ratio=w.height/Math.max(1,major.height);
        return gap>=-8&&gap<=Math.max(74,major.height*2.8)&&Math.abs(wc.y-mc.y)<=Math.max(54,major.height*1.25)&&ratio>=.28&&ratio<=1.45;
      }).sort((a,b)=>Math.abs(a.x-(major.x+major.width))-Math.abs(b.x-(major.x+major.width)));
      if(!cents.length)return;
      const nearbyCurrency=currency.filter((r)=>{
        const rc=center(r);
        return rc.x<=mc.x+20&&Math.abs(rc.y-mc.y)<=Math.max(65,major.height*1.5)&&mc.x-rc.x<=Math.max(190,major.height*5.5);
      }).sort((a,b)=>Math.abs(center(a).x-mc.x)-Math.abs(center(b).x-mc.x))[0];
      if(!nearbyCurrency && major.height<medianH*1.58)return;
      const value=Number(`${majorDigits}.${numericDigits(cents[0].text)}`);
      if(!validPrice(value))return;
      const parts=nearbyCurrency?[nearbyCurrency,major,cents[0]]:[major,cents[0]];
      const b=unionBoxes(parts);
      found.push({value:Number(value.toFixed(2)),text:clean(parts.map((w)=>w.text).join(' ')),confidence:parts.reduce((s,w)=>s+Number(w.confidence||0),0)/parts.length,currencyExplicit:Boolean(nearbyCurrency),pattern:'spatial-major-cents',passes:1,passNames:[pass],bbox:{x:b.x,y:b.y,width:b.width,height:b.height}});
    });

    const dedup=[];
    found.sort((a,b)=>Number(b.currencyExplicit)-Number(a.currencyExplicit)||b.confidence-a.confidence).forEach((price)=>{
      const pc=center(price);
      const existing=dedup.find((x)=>Math.abs(Number(x.value)-Number(price.value))<.011&&Math.abs(center(x).x-pc.x)<Math.max(45,price.bbox.height*1.4)&&Math.abs(center(x).y-pc.y)<Math.max(34,price.bbox.height));
      if(!existing)dedup.push(price);
    });
    return dedup;
  }

  function mergePricePasses(passPrices) {
    const all=(passPrices||[]).flat();
    const groups=[];
    all.forEach((price)=>{
      const pc=center(price);
      let group=groups.find((g)=>Math.abs(center(g.reference).x-pc.x)<Math.max(72,price.bbox.height*2.1)&&Math.abs(center(g.reference).y-pc.y)<Math.max(55,price.bbox.height*1.55));
      if(!group){group={reference:price,items:[]};groups.push(group);}
      group.items.push(price);
      if(Number(price.confidence)>Number(group.reference.confidence))group.reference=price;
    });
    return groups.map((group)=>{
      const votes=new Map();
      group.items.forEach((item)=>{
        const key=Number(item.value).toFixed(2);
        if(!votes.has(key))votes.set(key,{value:Number(item.value),items:[],passes:new Set()});
        votes.get(key).items.push(item);
        (item.passNames||[]).forEach((p)=>votes.get(key).passes.add(p));
      });
      const ranked=[...votes.values()].sort((a,b)=>b.passes.size-a.passes.size||b.items.length-a.items.length||Math.max(...b.items.map((x)=>x.confidence))-Math.max(...a.items.map((x)=>x.confidence)));
      const winner=ranked[0];
      const best=[...winner.items].sort((a,b)=>Number(b.currencyExplicit)-Number(a.currencyExplicit)||b.confidence-a.confidence)[0];
      const runner=ranked[1];
      const conflict=Boolean(runner && runner.passes.size>=winner.passes.size);
      const confidence=conflict?Math.min(74,best.confidence):Math.min(99,Math.max(best.confidence,winner.passes.size>=2?92:best.confidence));
      return {...best,value:winner.value,confidence,passes:winner.passes.size,passNames:[...winner.passes],conflict,conflictValues:ranked.slice(1,4).map((x)=>x.value)};
    }).filter((p)=>validPrice(p.value)).sort((a,b)=>a.bbox.y-b.bbox.y||a.bbox.x-b.bbox.x);
  }

  function preprocessCanvas(source, mode) {
    const canvas=document.createElement('canvas');
    canvas.width=source.width;canvas.height=source.height;
    const ctx=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
    ctx.drawImage(source,0,0);
    if(mode==='original')return canvas;
    const image=ctx.getImageData(0,0,canvas.width,canvas.height),d=image.data;
    for(let i=0;i<d.length;i+=4){
      const r=d[i],g=d[i+1],b=d[i+2],lum=.299*r+.587*g+.114*b;
      let value;
      if(mode==='price-invert') value=lum>=176?0:255;
      else if(mode==='strong') value=clamp(Math.round((lum-128)*1.55+128),0,255);
      else value=clamp(Math.round((lum-128)*1.18+128),0,255);
      if(mode!=='price-invert'){
        if(value>248)value=255;
        if(value<12)value=0;
      }
      d[i]=d[i+1]=d[i+2]=value;d[i+3]=255;
    }
    ctx.putImageData(image,0,0);
    return canvas;
  }

  async function loadTesseract() {
    if(window.Tesseract?.createWorker)return window.Tesseract;
    if(!tesseractPromise){
      tesseractPromise=new Promise((resolve,reject)=>{
        const existing=document.querySelector(`script[data-mercador-document-tesseract="${TESSERACT_VERSION}"]`);
        if(existing){
          existing.addEventListener('load',()=>resolve(window.Tesseract),{once:true});
          existing.addEventListener('error',()=>reject(new Error('Falha ao carregar o OCR visual.')),{once:true});
          return;
        }
        const script=document.createElement('script');
        script.src=TESSERACT_URL;script.async=true;script.crossOrigin='anonymous';script.dataset.mercadorDocumentTesseract=TESSERACT_VERSION;
        script.onload=()=>window.Tesseract?.createWorker?resolve(window.Tesseract):reject(new Error('OCR visual carregou sem API disponível.'));
        script.onerror=()=>reject(new Error('Não foi possível carregar o OCR visual. Verifique a conexão.'));
        document.head.appendChild(script);
      });
    }
    return tesseractPromise;
  }

  async function imageFileToCanvas(file) {
    if(!file||!String(file.type||'').startsWith('image/'))throw new Error('Arquivo de imagem inválido.');
    if(file.size>MAX_IMAGE_BYTES)throw new Error(`A imagem ${file.name||''} ultrapassa 18 MB.`);
    let bitmap=null,url='';
    try{
      if(typeof createImageBitmap==='function')bitmap=await createImageBitmap(file);
      let width,height,drawSource;
      if(bitmap){width=bitmap.width;height=bitmap.height;drawSource=bitmap;}
      else{
        url=URL.createObjectURL(file);
        const img=await new Promise((resolve,reject)=>{const el=new Image();el.onload=()=>resolve(el);el.onerror=()=>reject(new Error(`Não foi possível abrir ${file.name||'a imagem'}.`));el.src=url;});
        width=img.naturalWidth;height=img.naturalHeight;drawSource=img;
      }
      if(!(width>0&&height>0))throw new Error('Imagem sem dimensões válidas.');
      const scale=Math.min(Math.max(1,IMAGE_TARGET_WIDTH/width),IMAGE_MAX_HEIGHT/height);
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
      const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(drawSource,0,0,canvas.width,canvas.height);
      return {canvas,originalWidth:width,originalHeight:height,scale};
    }finally{if(bitmap?.close)bitmap.close();if(url)URL.revokeObjectURL(url);}
  }

  async function recognizePass(worker, canvas, pass, psm, onProgress, pageIndex, pageCount, passIndex, passCount, whitelist='') {
    await worker.setParameters({preserve_interword_spaces:'1',tessedit_pageseg_mode:String(psm),tessedit_char_whitelist:whitelist}).catch(()=>{});
    const result=await worker.recognize(canvas);
    const words=normalizeWords(result.data,pass);
    const lines=segmentLines(words);
    if(onProgress){
      const part=(pageIndex+(passIndex+1)/passCount)/pageCount;
      onProgress({pageNumber:pageIndex+1,numPages:pageCount,percent:Math.round(5+part*82),mode:`image-${pass}`});
    }
    return {pass,words,lines,text:clean(result.data?.text||lines.map((x)=>x.text).join(' '))};
  }

  function normalizeValidityRaw(validity) {
    if(!validity)return {startAt:null,endAt:null,raw:'',condition:'',inferred:false};
    return {startAt:Number(validity.startAt)||null,endAt:Number(validity.endAt)||null,raw:clean(validity.raw),condition:clean(validity.condition),inferred:validity.inferred===true,provided:validity.provided===true};
  }

  function localDate(year,month,day,end){
    const d=new Date(Number(year),Number(month)-1,Number(day),end?23:0,end?59:0,end?59:0,end?999:0);
    return Number.isFinite(d.getTime())?d.getTime():null;
  }

  function extractValidityFlexible(rawText) {
    const text=clean(rawText);
    const base=typeof previous.extractValidity==='function'?normalizeValidityRaw(previous.extractValidity(text)):normalizeValidityRaw(null);
    if(base.startAt&&base.endAt)return {...base,inferred:false};
    let m=text.match(/\b(?:DIAS?\s*:?)?\s*(\d{1,2})\s*(?:E|A|AT[ÉE])\s*(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})\b/i);
    if(m)return {startAt:localDate(m[4],m[3],m[1],false),endAt:localDate(m[4],m[3],m[2],true),raw:m[0],condition:/ENQUANTO\s+(?:HOUVER|DURAREM)/i.test(text)?'enquanto houver estoque':'',inferred:false};
    m=text.match(/\b(\d{1,2})[\/.](\d{1,2})\s*(?:E|A|AT[ÉE])\s*(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})\b/i);
    if(m)return {startAt:localDate(m[5],m[2],m[1],false),endAt:localDate(m[5],m[4],m[3],true),raw:m[0],condition:/ENQUANTO\s+(?:HOUVER|DURAREM)/i.test(text)?'enquanto houver estoque':'',inferred:false};
    return base;
  }

  function sourceValidity(options, documentText) {
    const start=Number(options?.suppliedStartAt||0),end=Number(options?.suppliedEndAt||0);
    if(start>0&&end>start)return {startAt:start,endAt:end,raw:'validade informada pelo administrador',condition:'',inferred:false,provided:true};
    return extractValidityFlexible(documentText);
  }

  function serializableWord(word) {
    return {id:word.id,text:word.text,normalized:normalizeName(word.text),confidence:Number(word.confidence||0),bbox:{x:word.x,y:word.y,width:word.width,height:word.height},sources:[...(word.sources||[])],alternatives:[...(word.alternatives||[])]};
  }

  async function analyzeImagesLegacy(files, options={}, onProgress) {
    const list=[...(files||[])].filter((file)=>String(file.type||'').startsWith('image/'));
    if(!list.length)throw new Error('Selecione pelo menos uma imagem válida.');
    if(list.length>MAX_IMAGE_FILES)throw new Error(`Selecione no máximo ${MAX_IMAGE_FILES} imagens por análise.`);
    const Tesseract=await loadTesseract();
    const hashPromise=sha256Files(list);
    const rasterPages=[];let currentProgress={pageIndex:0,passIndex:0,passCount:4,pageCount:list.length};
    const worker=await Tesseract.createWorker('por',1,{logger:(m)=>{
      if(m.status==='recognizing text'&&onProgress){
        const base=(currentProgress.pageIndex+(currentProgress.passIndex+Number(m.progress||0))/currentProgress.passCount)/currentProgress.pageCount;
        onProgress({pageNumber:currentProgress.pageIndex+1,numPages:currentProgress.pageCount,percent:Math.round(4+base*82),mode:'image-ocr'});
      }
    }});
    try{
      const pages=[];const documentParts=[];
      for(let pageIndex=0;pageIndex<list.length;pageIndex+=1){
        const file=list[pageIndex];
        if(onProgress)onProgress({pageNumber:pageIndex+1,numPages:list.length,percent:Math.round(3+pageIndex/list.length*82),mode:'image-prepare'});
        const raster=await imageFileToCanvas(file);
        rasterPages.push({pageNumber:pageIndex+1,fileName:file.name,canvas:raster.canvas,originalWidth:raster.originalWidth,originalHeight:raster.originalHeight,scale:raster.scale});
        const mild=preprocessCanvas(raster.canvas,'mild'),strong=preprocessCanvas(raster.canvas,'strong'),priceInvert=preprocessCanvas(raster.canvas,'price-invert');
        const specs=[
          {pass:'layout',canvas:raster.canvas,psm:11,whitelist:''},
          {pass:'gray',canvas:mild,psm:11,whitelist:''},
          {pass:'strong',canvas:strong,psm:6,whitelist:''},
          {pass:'price',canvas:priceInvert,psm:11,whitelist:'R$0123456789,. '}
        ];
        const passResults=[];
        for(let passIndex=0;passIndex<specs.length;passIndex+=1){
          currentProgress={pageIndex,passIndex,passCount:specs.length,pageCount:list.length};
          const spec=specs[passIndex];
          passResults.push(await recognizePass(worker,spec.canvas,spec.pass,spec.psm,onProgress,pageIndex,list.length,passIndex,specs.length,spec.whitelist));
        }
        await worker.setParameters({tessedit_char_whitelist:''}).catch(()=>{});
        const textPasses=passResults.filter((x)=>x.pass!=='price');
        const words=mergeWordSets(textPasses.map((x)=>x.words));
        const lines=segmentLines(words);
        const passPrices=passResults.map((x)=>pricesFromPass(x.words,x.lines,x.pass));
        const prices=mergePricePasses(passPrices);
        const text=clean(unique(textPasses.map((x)=>x.text).filter(Boolean)).join(' '));
        documentParts.push(text);
        pages.push({
          pageNumber:pageIndex+1,width:raster.canvas.width,height:raster.canvas.height,mode:'image-ocr',text,
          metrics:{words:words.length,lines:lines.length,pricesDetected:prices.length,ocrPasses:passResults.length},
          words:words.map(serializableWord),lines,prices,
          ocrPasses:passResults.map((x)=>({pass:x.pass,text:x.text,words:x.words.length,lines:x.lines.length,prices:pricesFromPass(x.words,x.lines,x.pass).length}))
        });
        [mild,strong,priceInvert].forEach((canvas)=>{canvas.width=1;canvas.height=1;});
      }
      const documentText=clean(documentParts.join(' '));
      const validity=sourceValidity(options,documentText);
      const hash=await hashPromise;
      const knowledgeDocument={
        schemaVersion:KNOWLEDGE_SCHEMA_VERSION,engineVersion:ENGINE_VERSION,generatedAt:new Date().toISOString(),sourceType:'image',
        source:{type:'image',fileName:list.length===1?list[0].name:`${list.length} imagens`,files:list.map((f)=>({name:f.name,mimeType:f.type,size:f.size})),sha256:hash,numPages:pages.length},
        extraction:{mode:'image-ocr-multipass',modes:['image','ocr','geometry','multipass'],tesseractVersion:TESSERACT_VERSION,geometryAvailable:true},
        validity,documentText,pages,promotionFacts:[]
      };
      let result={fileName:list.length===1?list[0].name:`${list.length} imagens do encarte`,hash,numPages:pages.length,validity,candidates:[],engineVersion:ENGINE_VERSION,pdfjsVersion:'—',extractionMode:'image-ocr-multipass',knowledgeSchemaVersion:KNOWLEDGE_SCHEMA_VERSION,knowledgeDocument,knowledgeMetrics:{pages:pages.length,modes:['image-ocr','geometry','multipass'],words:pages.reduce((s,p)=>s+p.words.length,0),lines:pages.reduce((s,p)=>s+p.lines.length,0),prices:pages.reduce((s,p)=>s+p.prices.length,0),candidates:0},sourceType:'image',sourceLabel:list.length===1?'Imagem':'Imagens'};
      if(resolveCardFirst)result=resolveCardFirst(result);
      result=promoteStrongImageCards(result);
      result.sourceType='image';result.sourceLabel=list.length===1?'Imagem':'Imagens';
      result.knowledgeMetrics={...(result.knowledgeMetrics||{}),candidates:(result.candidates||[]).length};
      window.MercadorPDFImporter.lastKnowledgeDocument=result.knowledgeDocument||null;
      activeSource={type:'image',hash,rasterPages,text:''};
      if(onProgress)onProgress({pageNumber:pages.length,numPages:pages.length,percent:100,mode:'image-complete'});
      return result;
    }finally{await worker.terminate().catch(()=>{});}
  }


  function makeCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width || 1));
    canvas.height = Math.max(1, Math.round(height || 1));
    return canvas;
  }

  function cropCanvas(source, box, scale = 1) {
    const sx = clamp(Math.round(Number(box?.x || 0)), 0, Math.max(0, source.width - 1));
    const sy = clamp(Math.round(Number(box?.y || 0)), 0, Math.max(0, source.height - 1));
    const sw = clamp(Math.round(Number(box?.width || source.width)), 1, Math.max(1, source.width - sx));
    const sh = clamp(Math.round(Number(box?.height || source.height)), 1, Math.max(1, source.height - sy));
    const canvas = makeCanvas(sw * scale, sh * scale);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function preprocessBadgeCanvas(source, mode = 'text') {
    const canvas = makeCanvas(source.width, source.height);
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      let ink = false;
      if (mode === 'price') ink = lum >= 150 || (lum >= 118 && sat <= 78);
      else ink = lum >= 142 || (lum >= 112 && sat <= 84);
      const v = ink ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  async function recognizeCanvasQuick(worker, canvas, psm = 6, whitelist = '') {
    await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: whitelist }).catch(() => {});
    const result = await worker.recognize(canvas);
    return { text: clean(result?.data?.text || ''), words: normalizeWords(result?.data || {}, 'grid-card') };
  }

  function connectedComponents(mask, width, height) {
    const visited = new Uint8Array(width * height);
    const components = [];
    const queue = new Int32Array(width * height);
    for (let i = 0; i < mask.length; i += 1) {
      if (!mask[i] || visited[i]) continue;
      let head = 0, tail = 0;
      queue[tail++] = i;
      visited[i] = 1;
      let minX = width, minY = height, maxX = 0, maxY = 0, area = 0;
      while (head < tail) {
        const idx0 = queue[head++];
        const y = Math.floor(idx0 / width);
        const x = idx0 - y * width;
        area += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        const neighbors = [idx0 - 1, idx0 + 1, idx0 - width, idx0 + width];
        if (x > 0 && mask[neighbors[0]] && !visited[neighbors[0]]) { visited[neighbors[0]] = 1; queue[tail++] = neighbors[0]; }
        if (x + 1 < width && mask[neighbors[1]] && !visited[neighbors[1]]) { visited[neighbors[1]] = 1; queue[tail++] = neighbors[1]; }
        if (y > 0 && mask[neighbors[2]] && !visited[neighbors[2]]) { visited[neighbors[2]] = 1; queue[tail++] = neighbors[2]; }
        if (y + 1 < height && mask[neighbors[3]] && !visited[neighbors[3]]) { visited[neighbors[3]] = 1; queue[tail++] = neighbors[3]; }
      }
      const w = maxX - minX + 1, h = maxY - minY + 1;
      const density = area / Math.max(1, w * h);
      components.push({ x: minX, y: minY, width: w, height: h, area, density, cx: minX + w / 2, cy: minY + h / 2 });
    }
    return components;
  }

  function clusterCenters(values, tolerance) {
    const groups = [];
    [...values].sort((a, b) => a - b).forEach((value) => {
      let best = null;
      groups.forEach((group) => {
        if (Math.abs(group.center - value) <= tolerance && (!best || Math.abs(group.center - value) < Math.abs(best.center - value))) best = group;
      });
      if (!best) {
        best = { values: [value], center: value };
        groups.push(best);
      } else {
        best.values.push(value);
        best.center = best.values.reduce((sum, x) => sum + x, 0) / best.values.length;
      }
    });
    return groups;
  }

  function average(values) {
    return (values || []).length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0;
  }

  function stddev(values) {
    if (!(values || []).length) return 0;
    const mean = average(values);
    return Math.sqrt(average(values.map((value) => Math.pow(Number(value || 0) - mean, 2))));
  }

  function segmentsAbove(values, threshold) {
    const output = [];
    let start = -1;
    for (let i = 0; i < values.length; i += 1) {
      if (Number(values[i] || 0) >= threshold && start < 0) start = i;
      if ((Number(values[i] || 0) < threshold || i === values.length - 1) && start >= 0) {
        const end = Number(values[i] || 0) < threshold ? i - 1 : i;
        output.push({ start, end, width: end - start + 1 });
        start = -1;
      }
    }
    return output;
  }

  function detectOfferGrid(canvas) {
    const W = canvas.width, H = canvas.height;
    const scale = Math.min(1, 900 / Math.max(1, W));
    const sw = Math.max(160, Math.round(W * scale));
    const sh = Math.max(160, Math.round(H * scale));
    const sample = makeCanvas(sw, sh);
    const ctx = sample.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, sw, sh);
    const pixels = ctx.getImageData(0, 0, sw, sh).data;
    const mask = new Uint8Array(sw * sh);
    for (let i = 0, p = 0; i < pixels.length; i += 4, p += 1) {
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      mask[p] = (r >= 145 && g <= 138 && b <= 138 && r >= g * 1.22 && r >= b * 1.22) ? 1 : 0;
    }

    // Prefixo vertical por coluna: permite testar centenas de janelas sem refazer a soma dos pixels.
    const prefix = new Uint16Array((sh + 1) * sw);
    for (let y = 0; y < sh; y += 1) {
      const row = y * sw, prev = y * sw, next = (y + 1) * sw;
      for (let x = 0; x < sw; x += 1) prefix[next + x] = prefix[prev + x] + mask[row + x];
    }

    const candidates = [];
    const minH = Math.max(10, Math.round(sh * .032));
    const maxH = Math.max(minH + 2, Math.round(sh * .072));
    const hStep = Math.max(2, Math.round(sh * .004));
    for (let h = minH; h <= maxH; h += hStep) {
      const yStep = Math.max(2, Math.round(h * .12));
      for (let y = 0; y + h <= sh; y += yStep) {
        const density = new Float32Array(sw);
        for (let x = 0; x < sw; x += 1) density[x] = (prefix[(y + h) * sw + x] - prefix[y * sw + x]) / h;
        const rawSegments = segmentsAbove(density, .18);
        const segments = rawSegments.map((segment) => {
          let sum = 0;
          for (let x = segment.start; x <= segment.end; x += 1) sum += density[x];
          return { ...segment, density: sum / Math.max(1, segment.width), center: (segment.start + segment.end) / 2 };
        }).filter((segment) => segment.width >= sw * .075 && segment.width <= sw * .25 && segment.density >= .38);
        if (segments.length < 3 || segments.length > 6) continue;
        const centers = segments.map((segment) => segment.center);
        const widths = segments.map((segment) => segment.width);
        const spacings = centers.slice(1).map((center, index) => center - centers[index]);
        if (spacings.length < 2) continue;
        const spacingCv = stddev(spacings) / Math.max(1, average(spacings));
        const widthCv = stddev(widths) / Math.max(1, average(widths));
        if (spacingCv > .18 || widthCv > .22) continue;
        const score = segments.length * 20 + average(segments.map((segment) => segment.density)) * 10 - spacingCv * 20 - widthCv * 10;
        candidates.push({ y, h, segments, centers, count: segments.length, score });
      }
    }
    if (!candidates.length) return null;

    // NMS vertical: uma única observação por faixa vermelha repetida.
    const rows = [];
    candidates.sort((a, b) => b.score - a.score).forEach((candidate) => {
      const cy = candidate.y + candidate.h / 2;
      if (rows.some((row) => Math.abs(cy - (row.y + row.h / 2)) < Math.max(candidate.h, row.h) * 1.15)) return;
      rows.push(candidate);
    });

    // A grade vencedora precisa repetir o MESMO padrão horizontal em pelo menos duas linhas.
    const groups = [];
    rows.forEach((row) => {
      let group = groups.find((entry) => entry.count === row.count
        && average(row.centers.map((center, index) => Math.abs(center - Number(entry.centers[index] || center)))) <= sw * .035);
      if (!group) {
        group = { count: row.count, rows: [], centers: [...row.centers] };
        groups.push(group);
      }
      group.rows.push(row);
      group.centers = group.centers.map((_, index) => average(group.rows.map((item) => item.centers[index])));
    });
    groups.forEach((group) => {
      const ys = group.rows.map((row) => row.y + row.h / 2).sort((a, b) => a - b);
      const gaps = ys.slice(1).map((value, index) => value - ys[index]);
      const verticalCv = gaps.length >= 2 ? stddev(gaps) / Math.max(1, average(gaps)) : (gaps.length === 1 ? .25 : 1);
      group.score = group.rows.length * group.count * 100 - verticalCv * 100 + average(group.rows.map((row) => row.score));
    });
    const group = groups.filter((entry) => entry.rows.length >= 2 && entry.rows.length * entry.count >= 6).sort((a, b) => b.score - a.score)[0];
    if (!group) return null;

    const selectedRows = [...group.rows].sort((a, b) => a.y - b.y);
    const allSegments = selectedRows.flatMap((row) => row.segments);
    const medianSegmentWidth = median(allSegments.map((segment) => segment.width));
    const badgeWidth = medianSegmentWidth * 1.045;
    const badgeHeight = badgeWidth / 1.94;
    const invScale = 1 / scale;
    const centersX = group.centers;
    const centersY = selectedRows.map((row) => row.y + row.h / 2);
    const cards = [];

    selectedRows.forEach((row, rowIndex) => {
      row.segments.sort((a, b) => a.center - b.center).forEach((segment, colIndex) => {
        const cx = segment.center;
        const badgeBottom = row.y + row.h + Math.max(2, Math.round(row.h * .03));
        const badgeSample = {
          x: cx - badgeWidth / 2,
          y: badgeBottom - badgeHeight,
          width: badgeWidth,
          height: badgeHeight
        };
        const left = colIndex === 0 ? Math.max(0, cx - (centersX[1] ? (centersX[1] - cx) / 2 : badgeWidth * .75)) : (centersX[colIndex - 1] + cx) / 2;
        const right = colIndex === centersX.length - 1 ? Math.min(sw, cx + (centersX[colIndex - 1] ? (cx - centersX[colIndex - 1]) / 2 : badgeWidth * .75)) : (cx + centersX[colIndex + 1]) / 2;
        const rowCenter = centersY[rowIndex];
        const top = rowIndex === 0 ? Math.max(0, rowCenter - (centersY[1] ? (centersY[1] - rowCenter) * .72 : badgeHeight * 2.4)) : (centersY[rowIndex - 1] + rowCenter) / 2;
        const bottom = rowIndex === centersY.length - 1 ? Math.min(sh, rowCenter + (centersY[rowIndex - 1] ? (rowCenter - centersY[rowIndex - 1]) * .55 : badgeHeight * 2)) : (rowCenter + centersY[rowIndex + 1]) / 2;
        cards.push({
          rowIndex,
          colIndex,
          badgeBox: {
            x: Math.max(0, Math.round(badgeSample.x * invScale) + Math.max(1, Math.round(invScale * .55))),
            y: Math.max(0, Math.round(badgeSample.y * invScale)),
            width: Math.min(W, Math.round(badgeSample.width * invScale)),
            height: Math.min(H, Math.round(badgeSample.height * invScale))
          },
          cardBox: {
            x: Math.max(0, Math.round(left * invScale)),
            y: Math.max(0, Math.round(top * invScale)),
            width: Math.min(W, Math.round((right - left) * invScale)),
            height: Math.min(H, Math.round((bottom - top) * invScale))
          }
        });
      });
    });
    const offerTop = Math.min(...cards.map((card) => card.cardBox.y));
    const offerBottom = Math.max(...cards.map((card) => card.cardBox.y + card.cardBox.height));
    return { cards, rows: selectedRows, cols: centersX, offerTop, offerBottom, medianBadgeWidth: badgeWidth * invScale, medianBadgeHeight: badgeHeight * invScale, pattern: `${selectedRows.length}x${group.count}`, confidence: clamp(.82 + Math.min(.16, selectedRows.length * group.count / 100), .82, .98) };
  }

  function splitCleanLines(value) {
    return String(value || '').replace(/\r\n?/g, '\n').split('\n').map((line) => clean(line)).filter(Boolean);
  }

  function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function canonicalPriceText(price) {
    return `R$ ${Number(price || 0).toFixed(2).replace('.', ',')}`;
  }

  function parsePriceVotes(texts) {
    const votes = new Map();
    (texts || []).forEach((text, index) => {
      const matches = textPriceMatches(text);
      matches.forEach((match) => {
        const key = Number(match.price).toFixed(2);
        if (!votes.has(key)) votes.set(key, { value: Number(match.price), count: 0, explicit: 0, indexes: [], raw: [] });
        const row = votes.get(key);
        row.count += 1;
        row.explicit += match.currencyExplicit ? 1 : 0;
        row.indexes.push(index);
        row.raw.push(clean(match.text));
      });
    });
    const ranked = [...votes.values()].sort((a, b) => b.count - a.count || b.explicit - a.explicit || a.value - b.value);
    if (!ranked.length) return null;
    const winner = ranked[0];
    const runner = ranked[1];
    return {
      value: Number(winner.value.toFixed(2)),
      text: winner.raw.find(Boolean) || canonicalPriceText(winner.value),
      confidence: runner ? Math.min(92, 68 + winner.count * 8) : Math.min(98, 78 + winner.count * 6 + winner.explicit * 4),
      currencyExplicit: winner.explicit > 0,
      pattern: 'grid-badge-ocr',
      passes: winner.count,
      passNames: winner.indexes.map((x) => `pass-${x + 1}`),
      conflict: Boolean(runner),
      conflictValues: ranked.slice(1, 4).map((x) => Number(x.value.toFixed(2)))
    };
  }

  function normalizeUnitToken(value) {
    const n = normalizeName(value);
    if (!n) return '';
    if (/^UNID(?:ADE)?S?$/.test(n)) return 'UNID';
    if (/^(?:UN|UND)$/.test(n)) return 'UNID';
    if (/^KG$/.test(n)) return 'KG';
    if (/^BDJ(?:\s+\d+(?:[.,]\d+)?\s*G)?$/.test(n)) return clean(value).replace(/\bBDJ\b/i, 'BDJ');
    return clean(value);
  }

  function cleanProductBlockText(value) {
    let text = clean(value)
      .replace(/(?:R\s*\$|R\$|\$)?\s*\d{1,4}\s*[,.;:]\s*\d{2}\b/gi, ' ')
      .replace(/\b(?:R\$|RS|\$)\b/gi, ' ')
      .replace(/\b(?:UNID(?:ADE)?S?|UN|UND|KG|BDJ)\b(?=\s*$)/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return clean(text);
  }

  function pickProductFromBadgeTexts(primaryText, backupText) {
    const candidates = [];
    [primaryText, backupText].forEach((text) => {
      splitCleanLines(text).forEach((line) => {
        const cleaned = cleanProductBlockText(line);
        if (!cleaned) return;
        if (INSTITUTIONAL_RE.test(cleaned)) return;
        if (/^[\d\s.,]+$/.test(cleaned)) return;
        candidates.push(cleaned);
      });
    });
    const uniqueCandidates = unique(candidates).sort((a, b) => normalizeName(b).length - normalizeName(a).length);
    return clean(uniqueCandidates[0] || cleanProductBlockText(primaryText || backupText || ''));
  }

  const GRID_PRODUCT_LEXICON = new Set(`
    ALFACE CRESPA VERDURAS ROVERSI CEBOLA BATATA DOCE PEPINO JAPONES REPOLHO VERDE BETERRABA BROCOLIS CENOURA
    LARANJA PERA BANANA NANICA MAMAO FORMOSA ABACATE MELAO AMARELO GOIABA VERMELHA UVA VITORIA BDJ MANGA PALMER
    CABOTIA ITALIA TOMATE SWEET GRAPE MANDIOCA SALSA MACA OVOS OVO FRANGO COXA ASA FILE MIGNON SUINO COSTELA PANCETA
    ACEM CARNE BOVINA TANGERINA MORANGO LIMAO CHUCHU ABOBRINHA COUVE VAGEM BERINJELA MELANCIA ALHO ARROZ FEIJAO CAFE
    LEITE QUEIJO PRESUNTO MUSSARELA MARGARINA MANTEIGA REQUEIJAO PAO BOLO FARINHA MACARRAO MASSA BISCOITO CHOCOLATE
    REFRIGERANTE CERVEJA AGUA DETERGENTE SABAO SHAMPOO SABONETE FRALDA AZEITE MOLHO MAIONESE ATUM MILHO
  `.trim().split(/\s+/));
  const GRID_PRODUCT_CUES = new Set(`
    ALFACE CEBOLA BATATA PEPINO REPOLHO BETERRABA BROCOLIS CENOURA LARANJA BANANA MAMAO ABACATE MELAO GOIABA UVA MANGA
    TOMATE MANDIOCA MACA OVOS OVO FRANGO CARNE ARROZ FEIJAO CAFE LEITE QUEIJO PRESUNTO MUSSARELA PAO BOLO FARINHA
    MACARRAO MASSA BISCOITO CHOCOLATE REFRIGERANTE CERVEJA AGUA DETERGENTE SABAO SHAMPOO SABONETE FRALDA AZEITE MOLHO
  `.trim().split(/\s+/));

  function levenshtein(a, b) {
    const A = String(a || ''), B = String(b || '');
    const row = Array.from({ length: B.length + 1 }, (_, i) => i);
    for (let i = 1; i <= A.length; i += 1) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= B.length; j += 1) {
        const old = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (A[i - 1] === B[j - 1] ? 0 : 1));
        prev = old;
      }
    }
    return row[B.length];
  }

  function fuzzyGridToken(token) {
    const raw = normalizeName(token);
    if (!raw) return '';
    if (GRID_PRODUCT_LEXICON.has(raw)) return raw;
    let best = null;
    GRID_PRODUCT_LEXICON.forEach((candidate) => {
      const maxDistance = Math.min(raw.length, candidate.length) >= 5 ? 2 : 1;
      if (Math.abs(raw.length - candidate.length) > maxDistance) return;
      const distance = levenshtein(raw, candidate);
      if (distance <= maxDistance && (!best || distance < best.distance || (distance === best.distance && candidate.length > best.value.length))) {
        best = { distance, value: candidate };
      }
    });
    return best ? best.value : raw;
  }

  function splitCompoundGridToken(token) {
    const raw = normalizeName(token);
    if (!raw) return [];
    for (const first of GRID_PRODUCT_LEXICON) {
      if (first.length < 4 || first === raw || !raw.startsWith(first)) continue;
      const rest = raw.slice(first.length);
      if (GRID_PRODUCT_LEXICON.has(rest)) return [first, rest];
    }
    return [raw];
  }

  function thresholdWhiteTextCanvas(source, threshold) {
    const canvas = makeCanvas(source.width, source.height);
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      const lum = .299 * data[i] + .587 * data[i + 1] + .114 * data[i + 2];
      const value = lum > threshold ? 0 : 255;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  async function ocrThreshold(worker, source, threshold, psm, whitelist = '') {
    const prepared = thresholdWhiteTextCanvas(source, threshold);
    try {
      return await recognizeCanvasQuick(worker, prepared, psm, whitelist);
    } finally {
      prepared.width = 1;
      prepared.height = 1;
    }
  }

  function chooseStableProductName(texts) {
    const lists = [];
    (texts || []).forEach((raw) => {
      const expanded = [];
      normalizeName(raw).split(/\s+/).filter(Boolean).forEach((token) => splitCompoundGridToken(token).forEach((part) => expanded.push(part)));
      let start = -1;
      for (let i = 0; i < expanded.length; i += 1) {
        const corrected = fuzzyGridToken(expanded[i]);
        if (GRID_PRODUCT_CUES.has(corrected)) { start = i; break; }
      }
      if (start < 0) return;
      const output = [];
      for (let i = start; i < expanded.length; i += 1) {
        const token = fuzzyGridToken(expanded[i]);
        if (/^(?:KG|UNID|UNIDADE|UND|UN)$/.test(token)) break;
        if (token.length === 1 && !/^\d$/.test(token)) continue;
        if (/^\d+$/.test(token) && token !== '500') continue;
        output.push(token);
      }
      if (output.length) lists.push(output);
    });
    if (!lists.length) return '';
    const support = new Map();
    lists.forEach((list) => [...new Set(list)].forEach((token) => support.set(token, Number(support.get(token) || 0) + 1)));
    const representative = [...lists].sort((a, b) => {
      const sa = a.filter((token) => Number(support.get(token) || 0) >= 2).length;
      const sb = b.filter((token) => Number(support.get(token) || 0) >= 2).length;
      return sb - sa || a.length - b.length;
    })[0];
    const stable = representative.filter((token) => Number(support.get(token) || 0) >= 2 || /^\d+(?:G|KG|ML|L)$/.test(token));
    if (!stable.length) return '';
    const value = clean(stable.join(' '));
    return GRID_PRODUCT_CUES.has(stable[0]) && value.length >= 3 ? value : '';
  }

  function unitFromEvidence(values, productName) {
    if (/\bBDJ\b/i.test(normalizeName(productName))) return 'BDJ';
    const aliases = { NG:'KG', UG:'KG', GG:'KG', K6:'KG', K:'KG', G:'KG', UNI:'UNID', UNO:'UNID', UND:'UNID', UID:'UNID', UN:'UNID', JNI:'UNID', IN:'UNID', BD:'BDJ', B0:'BDJ', BO:'BDJ', BDI:'BDJ' };
    const votes = [];
    (values || []).forEach((value) => normalizeName(value).split(/\s+/).filter(Boolean).forEach((token) => {
      const mapped = aliases[token] || token;
      if (['KG','UNID','BDJ'].includes(mapped)) { votes.push(mapped); return; }
      ['KG','UNID','BDJ'].some((target) => {
        if (levenshtein(mapped, target) <= 1) { votes.push(target); return true; }
        return false;
      });
    }));
    if (!votes.length) return '';
    const counts = votes.reduce((acc, value) => ({ ...acc, [value]: Number(acc[value] || 0) + 1 }), {});
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }

  async function recognizeGridCard(worker, pageCanvas, card) {
    const badge = cropCanvas(pageCanvas, card.badgeBox, 1);
    try {
      const bw = badge.width, bh = badge.height;
      const nameCrop = cropCanvas(badge, { x:0, y:0, width:bw, height:bh * .38 }, 7);
      const nameReads = [];
      for (const threshold of [130, 150, 170]) {
        const read = await ocrThreshold(worker, nameCrop, threshold, 6, '');
        if (read.text) nameReads.push(read.text);
      }
      nameCrop.width = 1; nameCrop.height = 1;
      const productText = chooseStableProductName(nameReads);
      if (!productText || INSTITUTIONAL_RE.test(productText)) return null;

      // Preço: separa o algarismo principal e os centavos. Em selos tipográficos grandes
      // isso é muito mais estável que pedir ao OCR para compreender R$, reais, vírgula e centavos de uma vez.
      const majorCrop = cropCanvas(badge, { x:bw * .31, y:bh * .30, width:bw * .25, height:bh * .64 }, 7);
      const majorVotes = [];
      for (const threshold of [220, 210, 200, 180]) {
        const read = await ocrThreshold(worker, majorCrop, threshold, 10, '0123456789');
        const value = clean(read.text).replace(/\D/g, '');
        if (/^\d{1,3}$/.test(value)) majorVotes.push(value);
      }
      majorCrop.width = 1; majorCrop.height = 1;

      const centsCrop = cropCanvas(badge, { x:bw * .57, y:bh * .30, width:bw * .26, height:bh * .40 }, 7);
      const centsVotes = [];
      for (const threshold of [220, 210, 200, 180, 160]) {
        const read = await ocrThreshold(worker, centsCrop, threshold, 7, '0123456789');
        const value = clean(read.text).replace(/\D/g, '');
        if (/^\d{2}$/.test(value)) centsVotes.push(value);
      }
      centsCrop.width = 1; centsCrop.height = 1;

      const majority = (values) => {
        if (!values.length) return '';
        const counts = values.reduce((acc, value) => ({ ...acc, [value]: Number(acc[value] || 0) + 1 }), {});
        return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      };
      const major = majority(majorVotes);
      const cents = majority(centsVotes);
      const priceValue = major && cents ? Number(`${major}.${cents}`) : NaN;
      if (!validPrice(priceValue)) return null;

      const fullBadge = cropCanvas(badge, { x:0, y:0, width:bw, height:bh }, 5);
      const fullRead = await ocrThreshold(worker, fullBadge, 180, 6, '');
      fullBadge.width = 1; fullBadge.height = 1;
      const unitCrop = cropCanvas(badge, { x:bw * .60, y:bh * .58, width:bw * .36, height:bh * .37 }, 7);
      const unitReads = [];
      for (const threshold of [140, 160, 180]) {
        const read = await ocrThreshold(worker, unitCrop, threshold, 7, 'KGUNIDBDJ0123456789');
        if (read.text) unitReads.push(read.text);
      }
      unitCrop.width = 1; unitCrop.height = 1;
      unitReads.push(fullRead.text || '');
      const detectedUnit = unitFromEvidence(unitReads, productText);
      const packageText = extractPackage(productText) || detectedUnit;

      const currencyCrop = cropCanvas(badge, { x:bw * .04, y:bh * .30, width:bw * .27, height:bh * .39 }, 7);
      const currencyReads = [];
      for (const threshold of [180, 220]) {
        const read = await ocrThreshold(worker, currencyCrop, threshold, 7, 'R$S');
        if (read.text) currencyReads.push(read.text);
      }
      currencyCrop.width = 1; currencyCrop.height = 1;
      const currencyExplicit = currencyReads.some((value) => /R|\$/i.test(value));

      const majorSupport = majorVotes.filter((value) => value === major).length;
      const centsSupport = centsVotes.filter((value) => value === cents).length;
      const priceConfidence = clamp(.78 + Math.min(.12, majorSupport * .03) + Math.min(.09, centsSupport * .018), .78, .99);
      const nameSupport = nameReads.length;
      const rawBadgeText = clean([...nameReads, fullRead.text].filter(Boolean).join(' '));
      return {
        rawBadgeText,
        productText,
        packageText,
        textPassSupport: Math.max(1, nameSupport),
        price: {
          value:Number(priceValue.toFixed(2)),
          text:`R$ ${Number(priceValue).toFixed(2).replace('.', ',')}`,
          confidence:Math.round(priceConfidence * 100),
          currencyExplicit,
          pattern:'grid-badge-split-digits',
          passes:Math.min(majorSupport, centsSupport),
          passNames:['major-digit-consensus','cents-consensus'],
          conflict:false,
          conflictValues:[]
        },
        confidence:clamp(.76 + Math.min(.15, nameSupport * .04) + Math.min(.08, Math.min(majorSupport, centsSupport) * .02), .76, .99)
      };
    } finally {
      badge.width = 1; badge.height = 1;
    }
  }

  function syntheticWordsForLine(text, box, sources) {
    const parts = clean(text).split(/\s+/).filter(Boolean);
    if (!parts.length) return [];
    const count = parts.length;
    const wordW = Math.max(10, box.width / count);
    return parts.map((part, index) => ({
      id: `w-${Math.random().toString(36).slice(2)}`,
      text: part,
      confidence: 95,
      x: box.x + index * wordW,
      y: box.y,
      width: Math.max(8, wordW - 2),
      height: box.height,
      sources: [...(sources || [])]
    }));
  }

  async function analyzeGridImagePage(worker, rasterCanvas, pageNumber, options, onProgress, pageIndex, pageCount) {
    const grid = detectOfferGrid(rasterCanvas);
    if (!grid || !grid.cards.length) return null;
    const cardResults = [];
    const headerCrop = cropCanvas(rasterCanvas, { x: 0, y: 0, width: rasterCanvas.width, height: Math.max(120, Math.round(grid.offerTop + 40)) }, 1);
    const headerCanvas = preprocessCanvas(headerCrop, 'mild');
    const header = await recognizeCanvasQuick(worker, headerCanvas, 6, '');
    for (let i = 0; i < grid.cards.length; i += 1) {
      const card = grid.cards[i];
      if (onProgress) {
        const base = ((pageIndex) + (i / Math.max(1, grid.cards.length))) / Math.max(1, pageCount);
        onProgress({ pageNumber: pageIndex + 1, numPages: pageCount, percent: Math.round(8 + base * 80), mode: 'image-grid-card' });
      }
      const info = await recognizeGridCard(worker, rasterCanvas, card);
      if (!info || !info.price || !validPrice(info.price.value)) continue;
      cardResults.push({ ...card, ...info });
    }
    const coverage = cardResults.length / Math.max(1, grid.cards.length);
    // Se a grade foi detectada, NUNCA voltamos silenciosamente ao OCR global: isso foi a origem
    // da contaminação por cabeçalho/rodapé. Mesmo uma grade incompleta fica documentada e bloqueada.
    const structuralComplete = grid.cards.length > 0 && cardResults.length === grid.cards.length;

    const words = [];
    const lines = [];
    const prices = [];
    cardResults.forEach((card, idx) => {
      const lineH = Math.max(14, Math.round(card.badgeBox.height * .30));
      const lineY = card.badgeBox.y + Math.max(2, Math.round(card.badgeBox.height * .02));
      const productBox = { x: card.badgeBox.x + Math.round(card.badgeBox.width * .05), y: lineY, width: Math.round(card.badgeBox.width * .90), height: lineH };
      const line = { text: card.productText + (card.packageText ? ` ${card.packageText}` : ''), confidence: Math.round(card.confidence * 100), bbox: productBox, wordIds: [], sources: Array.from({ length: Math.max(1, card.textPassSupport) }, (_, n) => `ocr-badge-${n + 1}`) };
      const lineWords = syntheticWordsForLine(line.text, productBox, line.sources);
      line.wordIds = lineWords.map((w) => w.id);
      words.push(...lineWords);
      lines.push(line);
      const priceBox = { x: card.badgeBox.x + Math.round(card.badgeBox.width * 0.10), y: card.badgeBox.y + Math.round(card.badgeBox.height * 0.36), width: Math.round(card.badgeBox.width * 0.80), height: Math.round(card.badgeBox.height * 0.52) };
      prices.push({ value: card.price.value, text: canonicalPriceText(card.price.value), confidence: card.price.confidence, currencyExplicit: true, pattern: card.price.pattern, passes: card.price.passes, passNames: card.price.passNames, conflict: card.price.conflict === true, conflictValues: [...(card.price.conflictValues || [])], bbox: priceBox });
    });
    const documentText = clean([header.text, ...cardResults.map((c) => [c.productText, c.packageText, canonicalPriceText(c.price.value)].filter(Boolean).join(' '))].join(' '));
    const validity = sourceValidity(options, documentText);
    return {
      page: {
        pageNumber,
        width: rasterCanvas.width,
        height: rasterCanvas.height,
        mode: 'image-grid-badge-ocr',
        text: documentText,
        metrics: { words: words.length, lines: lines.length, pricesDetected: prices.length, gridDetected: true, gridPattern:grid.pattern || '', gridCards: grid.cards.length, parsedCards: cardResults.length, coverage: Number(coverage.toFixed(3)), structuralComplete },
        words: words.map(serializableWord),
        lines,
        prices,
        ocrPasses: [{ pass: 'grid-badge', text: documentText, words: words.length, lines: lines.length, prices: prices.length }]
      },
      cards: cardResults,
      validity,
      documentText,
      coverage,
      structuralComplete,
      expectedCards: grid.cards.length
    };
  }

  async function analyzeImages(files, options = {}, onProgress) {
    const list = [...(files || [])].filter((file) => String(file.type || '').startsWith('image/'));
    if (!list.length) throw new Error('Selecione pelo menos uma imagem válida.');
    if (list.length > MAX_IMAGE_FILES) throw new Error(`Selecione no máximo ${MAX_IMAGE_FILES} imagens por análise.`);
    const Tesseract = await loadTesseract();
    const hashPromise = sha256Files(list);
    const rasterPages = [];
    const worker = await Tesseract.createWorker('por', 1, { logger: () => {} });
    try {
      const pages = [];
      const documentParts = [];
      let allGridCards = 0;
      let allParsedGridCards = 0;
      for (let pageIndex = 0; pageIndex < list.length; pageIndex += 1) {
        const file = list[pageIndex];
        if (onProgress) onProgress({ pageNumber: pageIndex + 1, numPages: list.length, percent: Math.round(3 + pageIndex / Math.max(1, list.length) * 70), mode: 'image-prepare' });
        const raster = await imageFileToCanvas(file);
        rasterPages.push({ pageNumber: pageIndex + 1, fileName: file.name, canvas: raster.canvas, originalWidth: raster.originalWidth, originalHeight: raster.originalHeight, scale: raster.scale });
        const gridPage = await analyzeGridImagePage(worker, raster.canvas, pageIndex + 1, options, onProgress, pageIndex, list.length);
        if (gridPage) {
          pages.push(gridPage.page);
          documentParts.push(gridPage.documentText);
          allGridCards += gridPage.expectedCards;
          allParsedGridCards += gridPage.cards.length;
          continue;
        }
        const fallback = await analyzeImagesLegacy([file], options, onProgress);
        const fallbackPage = (fallback?.knowledgeDocument?.pages || [])[0];
        if (fallbackPage) pages.push(fallbackPage);
        documentParts.push(clean(fallbackPage?.text || fallback?.knowledgeDocument?.documentText || ''));
      }
      const documentText = clean(documentParts.join(' '));
      const validity = sourceValidity(options, documentText);
      const hash = await hashPromise;
      const knowledgeDocument = {
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        engineVersion: ENGINE_VERSION,
        generatedAt: new Date().toISOString(),
        sourceType: 'image',
        source: { type: 'image', fileName: list.length === 1 ? list[0].name : `${list.length} imagens`, files: list.map((f) => ({ name: f.name, mimeType: f.type, size: f.size })), sha256: hash, numPages: pages.length },
        extraction: { mode: allParsedGridCards ? 'image-grid-card-first' : 'image-ocr-multipass', modes: ['image', 'ocr', 'geometry', allParsedGridCards ? 'grid-badge' : 'multipass', 'card-first'], tesseractVersion: TESSERACT_VERSION, geometryAvailable: true },
        validity,
        documentText,
        pages,
        promotionFacts: []
      };
      let result = { fileName: list.length === 1 ? list[0].name : `${list.length} imagens do encarte`, hash, numPages: pages.length, validity, candidates: [], engineVersion: ENGINE_VERSION, pdfjsVersion: '—', extractionMode: allParsedGridCards ? 'image-grid-card-first' : 'image-ocr-multipass', knowledgeSchemaVersion: KNOWLEDGE_SCHEMA_VERSION, knowledgeDocument, knowledgeMetrics: { pages: pages.length, modes: ['image-ocr', 'geometry', allParsedGridCards ? 'grid-badge' : 'multipass', 'card-first'], words: pages.reduce((s, p) => s + (p.words || []).length, 0), lines: pages.reduce((s, p) => s + (p.lines || []).length, 0), prices: pages.reduce((s, p) => s + (p.prices || []).length, 0), gridCards: allGridCards, parsedGridCards: allParsedGridCards, candidates: 0 }, sourceType: 'image', sourceLabel: list.length === 1 ? 'Imagem' : 'Imagens' };
      if (resolveCardFirst) result = resolveCardFirst(result);
      result = promoteStrongImageCards(result);
      const gridIncomplete = allGridCards > 0 && allParsedGridCards !== allGridCards;
      if (gridIncomplete) {
        result.candidates = (result.candidates || []).map((candidate) => ({
          ...candidate,
          riskFlags: unique([...(candidate.riskFlags || []), 'image_grid_incomplete']),
          evidence: unique([...(candidate.evidence || []), `grade visual incompleta: ${allParsedGridCards} de ${allGridCards} cards reconstruídos`]),
          automationSafe:false,
          structuralSafe:false,
          confidence:Math.min(Number(candidate.confidence || .85), .89)
        }));
        if (result.knowledgeDocument) {
          result.knowledgeDocument.gridIntegrity = { expectedCards:allGridCards, parsedCards:allParsedGridCards, complete:false, publicationBlocked:true };
        }
      } else if (allGridCards > 0 && result.knowledgeDocument) {
        result.knowledgeDocument.gridIntegrity = { expectedCards:allGridCards, parsedCards:allParsedGridCards, complete:true, publicationBlocked:false };
      }
      result.sourceType = 'image';
      result.sourceLabel = list.length === 1 ? 'Imagem' : 'Imagens';
      result.knowledgeMetrics = { ...(result.knowledgeMetrics || {}), candidates: (result.candidates || []).length };
      window.MercadorPDFImporter.lastKnowledgeDocument = result.knowledgeDocument || null;
      activeSource = { type: 'image', hash, rasterPages, text: '' };
      if (onProgress) onProgress({ pageNumber: pages.length, numPages: pages.length, percent: 100, mode: 'image-complete' });
      return result;
    } finally {
      await worker.terminate().catch(() => {});
    }
  }

  function upgradeKnowledgeV6(result, sourceType, sourceLabel) {
    if (!result) return result;
    const engine = String(result.engineVersion || '');
    const finalEngine = engine.includes(ENGINE_VERSION) ? engine : `${engine || 'document'}+${ENGINE_VERSION}`;
    let knowledge = result.knowledgeDocument;
    if (knowledge && typeof knowledge === 'object') {
      knowledge = {
        ...knowledge,
        previousSchemaVersion: knowledge.schemaVersion && knowledge.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION ? knowledge.schemaVersion : (knowledge.previousSchemaVersion || ''),
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        sourceType,
        multiformatEngineVersion: ENGINE_VERSION,
        source: { ...(knowledge.source || {}), type: sourceType }
      };
    }
    return { ...result, sourceType, sourceLabel, engineVersion: finalEngine, knowledgeSchemaVersion: KNOWLEDGE_SCHEMA_VERSION, knowledgeDocument: knowledge };
  }

  function promoteStrongImageCards(result) {
    const visualBlocks=result?.knowledgeDocument?.visualBlocks||[];
    const cardMap=new Map(visualBlocks.map((card)=>[card.id,card]));
    const validity=result?.validity||{};
    const validitySafe=Boolean(validity.startAt&&validity.endAt&&!validity.inferred);
    const candidates=(result?.candidates||[]).map((candidate)=>{
      if(!candidate?.cardId)return candidate;
      const card=cardMap.get(candidate.cardId);if(!card)return candidate;
      const anchor=card.priceAnchor||{};
      const textPassSupport=Number(card.textPassSupport||0);
      const conflict=anchor.conflict===true||(anchor.conflictValues||[]).length>0;
      const strong=validitySafe&&!conflict&&anchor.currencyExplicit===true&&Number(anchor.passes||0)>=2&&Number(anchor.confidence||0)>=.90&&Number(card.confidence||0)>=.92&&textPassSupport>=2&&clean(candidate.productName).length>=3;
      const risks=new Set(candidate.riskFlags||[]);
      if(conflict)risks.add('image_price_conflict');
      if(!validitySafe)risks.add('missing_validity');
      if(textPassSupport<2)risks.add('image_text_single_pass');
      if(strong){
        risks.delete('single_association_pass');risks.delete('ocr_block_ownership_weak');risks.delete('ocr_price_without_currency');risks.delete('image_text_single_pass');
      }
      const hard=[...risks].some((risk)=>['association_disagreement','missing_validity','invalid_price','header_contamination','ocr_price_conflict','knowledge_legacy_description_conflict','image_price_conflict'].includes(risk));
      return {...candidate,riskFlags:[...risks],confidence:strong&&!hard?Math.max(Number(candidate.confidence||0),.985):Number(candidate.confidence||0),structuralSafe:strong&&!hard,automationSafe:strong&&!hard,evidence:unique([...(candidate.evidence||[]),strong?'card de imagem confirmado por múltiplas leituras OCR independentes':'imagem preservada para revisão quando a evidência não é unânime']),extractionMode:`${candidate.extractionMode||'image'}+multiformat`};
    });
    if(result?.knowledgeDocument){
      result.knowledgeDocument.offerCandidates=candidates.map((c)=>({id:c.id,pageNumber:c.pageNumber,cardId:c.cardId||null,productName:c.productName,packageText:c.packageText||'',price:Number(c.price||0),confidence:Number(c.confidence||0),automationSafe:c.automationSafe===true,structuralSafe:c.structuralSafe===true,riskFlags:[...(c.riskFlags||[])],bbox:c.sourceBox||null}));
      result.knowledgeDocument.resolvedOffers=candidates.filter((c)=>c.automationSafe===true||c.structuralSafe===true).map((c)=>({id:c.id,pageNumber:c.pageNumber,cardId:c.cardId||null,productName:c.productName,packageText:c.packageText||'',price:Number(c.price||0),confidence:Number(c.confidence||0),bbox:c.sourceBox||null}));
    }
    return upgradeKnowledgeV6({...result,candidates}, 'image', result.sourceLabel || 'Imagem');
  }

  function textPriceMatches(line) {
    const output=[];
    const regex=/(?:R\s*\$|R\$|\$)?\s*(\d{1,4})\s*[,.;:]\s*(\d{2})\b/gi;
    let m;
    while((m=regex.exec(line))){
      const price=Number(`${m[1]}.${m[2]}`);if(!validPrice(price))continue;
      output.push({price:Number(price.toFixed(2)),text:m[0],currencyExplicit:/R\s*\$|R\$/.test(m[0])});
    }
    return output;
  }

  function cleanTextCandidate(value) {
    return clean(value).replace(/(?:R\s*\$|R\$|\$)?\s*\d{1,4}\s*[,.;:]\s*\d{2}\b/gi,' ').replace(/\s+/g,' ').trim();
  }

  function textProductLines(lines, priceIndex, previousPriceIndex) {
    const start=Math.max(previousPriceIndex+1,priceIndex-6);
    const candidates=[];
    for(let i=start;i<=priceIndex;i+=1){
      const text=cleanTextCandidate(lines[i]||'');
      if(!text||INSTITUTIONAL_RE.test(text)||/\bPRE[CÇ]OS?\s+V[ÁA]LID/i.test(text)||/\bHOR[ÁA]RIO\s+DE\s+ATENDIMENTO/i.test(text)||/^\d+[\s\d/.-]*$/.test(text))continue;
      if(CONDITION_RE.test(text)&&candidates.length)continue;
      candidates.push({index:i,text});
    }
    return candidates.slice(-4);
  }

  function extractPackage(text) {
    const m=clean(text).match(PACKAGE_RE);return m?clean(m[0]):'';
  }

  async function analyzeText(rawText, options={}, onProgress, fileName='texto-colado.txt') {
    const raw=String(rawText||'').replace(/\r\n?/g,'\n');
    if(!raw.trim())throw new Error('Cole o texto/OCR do encarte antes de analisar.');
    if(onProgress)onProgress({pageNumber:1,numPages:1,percent:10,mode:'text-parse'});
    const lines=raw.split('\n').map((line)=>line.trim()).filter(Boolean);
    const documentText=clean(raw);
    const validity=sourceValidity(options,documentText);
    const hash=await sha256Text(raw);
    const candidates=[];const conflicts=[];let previousPriceIndex=-1;
    lines.forEach((line,index)=>{
      const prices=textPriceMatches(line);if(!prices.length)return;
      const productLines=textProductLines(lines,index,previousPriceIndex);
      const productName=clean(productLines.map((x)=>x.text).join(' '));
      prices.forEach((price,pIndex)=>{
        if(!productName)return;
        const risks=['text_source_no_geometry'];
        if(!price.currencyExplicit)risks.push('text_price_without_currency');
        if(!validity.startAt||!validity.endAt)risks.push('missing_validity');
        if(prices.length>1)risks.push('ambiguous_price_kind');
        const category=window.MercadorIA?.inferCategory?.(productName)||'outros';
        const id=`text-${index+1}-${pIndex+1}`;
        const candidate={id,pageNumber:1,pageWidth:0,pageHeight:0,productName:productName.slice(0,160),category,brand:'',packageText:extractPackage(productName).slice(0,100),price:price.price,previousPrice:null,detectedPrices:prices.map((x)=>x.price),priceKind:prices.length>1?'review':'general',requiresClub:false,clubName:'',conditions:validity.condition||'',confidence:.72,riskFlags:risks,evidence:['texto/OCR preservado como fonte sem geometria','publicação automática bloqueada porque a relação espacial do encarte não está disponível'],associationAgreement:.45,ownershipConfidence:.30,clusterCoherence:.55,descriptionCompleteness:clamp(productName.split(/\s+/).length/8,.35,1),descriptionAgreement:.45,descriptionVariantCount:1,knowledgeCardText:productLines.map((x)=>x.text).join(' '),structuralSafe:false,automationSafe:false,sourceBox:null,startAt:validity.startAt||null,endAt:validity.endAt||null,verified:false,verificationMode:'',ignored:false,published:false,reviewed:false,extractionMode:'text-no-geometry',sourceText:[...productLines.map((x)=>x.text),price.text].join('\n')};
        candidates.push(candidate);
        conflicts.push({id:`conflict-${id}`,type:'text_source_no_geometry',productName:candidate.productName,price:candidate.price,resolution:'manual_review_required'});
      });
      previousPriceIndex=index;
    });
    const pageLines=lines.map((text,index)=>({text,confidence:100,bbox:null,wordIds:[],sources:['text']}));
    const knowledgeDocument={schemaVersion:KNOWLEDGE_SCHEMA_VERSION,engineVersion:ENGINE_VERSION,generatedAt:new Date().toISOString(),sourceType:'text',source:{type:'text',fileName,mimeType:'text/plain',size:new TextEncoder().encode(raw).length,sha256:hash,numPages:1},extraction:{mode:'text-preserved',modes:['text','no-geometry'],geometryAvailable:false},validity,documentText,pages:[{pageNumber:1,width:0,height:0,mode:'text',text:documentText,metrics:{lines:lines.length,pricesDetected:candidates.length},words:[],lines:pageLines,prices:[]}],visualBlocks:[],offerCandidates:candidates.map((c)=>({id:c.id,productName:c.productName,packageText:c.packageText,price:c.price,riskFlags:c.riskFlags,evidence:c.evidence})),resolvedOffers:[],conflicts,promotionFacts:candidates.map((c)=>({id:c.id,productName:c.productName,price:c.price,packageText:c.packageText,confidence:c.confidence,riskFlags:c.riskFlags}))};
    activeSource={type:'text',hash,rasterPages:[],text:raw};
    window.MercadorPDFImporter.lastKnowledgeDocument=knowledgeDocument;
    if(onProgress)onProgress({pageNumber:1,numPages:1,percent:100,mode:'text-complete'});
    return {fileName,hash,numPages:1,validity,candidates,engineVersion:ENGINE_VERSION,pdfjsVersion:'—',extractionMode:'text-no-geometry',knowledgeSchemaVersion:KNOWLEDGE_SCHEMA_VERSION,knowledgeDocument,knowledgeMetrics:{pages:1,modes:['text','no-geometry'],words:documentText.split(/\s+/).filter(Boolean).length,lines:lines.length,prices:candidates.length,candidates:candidates.length},sourceType:'text',sourceLabel:'Texto/OCR'};
  }

  async function analyzeSource(source={}, options={}, onProgress) {
    const files=[...(source.files||[])].filter(Boolean);
    const pasted=String(source.text||'').trim();
    if(files.length&&pasted)throw new Error('Use um tipo de entrada por vez: arquivo/imagens OU texto colado.');
    if(!files.length&&!pasted)throw new Error('Selecione um PDF/imagem ou cole o texto do encarte.');
    if(pasted)return analyzeText(pasted,options,onProgress,'texto-colado.txt');
    const pdfs=files.filter((f)=>f.type==='application/pdf'||/\.pdf$/i.test(f.name||''));
    const texts=files.filter((f)=>f.type==='text/plain'||/\.txt$/i.test(f.name||''));
    const images=files.filter((f)=>String(f.type||'').startsWith('image/')||/\.(?:jpe?g|png|webp)$/i.test(f.name||''));
    if(pdfs.length){
      if(files.length!==1||pdfs.length!==1)throw new Error('Para PDF, selecione somente um arquivo por análise.');
      const result=upgradeKnowledgeV6(await previousAnalyzeFile(pdfs[0],options,onProgress), 'pdf', 'PDF');
      activeSource={type:'pdf',hash:result.hash||'',rasterPages:[],text:''};
      window.MercadorPDFImporter.lastKnowledgeDocument=result.knowledgeDocument||null;
      return result;
    }
    if(texts.length){
      if(files.length!==1||texts.length!==1)throw new Error('Para TXT, selecione somente um arquivo por análise.');
      return analyzeText(await texts[0].text(),options,onProgress,texts[0].name||'encarte.txt');
    }
    if(images.length===files.length)return analyzeImages(images,options,onProgress);
    throw new Error('Formato não suportado. Use PDF, JPG, JPEG, PNG, WebP, TXT ou texto colado.');
  }

  function wrapCanvasText(canvas, text, x, y, maxWidth, lineHeight) {
    const ctx=canvas.getContext('2d');
    const words=String(text||'').split(/\s+/);let line='';let yy=y;
    words.forEach((word)=>{
      const test=line?`${line} ${word}`:word;
      if(ctx.measureText(test).width>maxWidth&&line){ctx.fillText(line,x,yy);line=word;yy+=lineHeight;}
      else line=test;
    });
    if(line)ctx.fillText(line,x,yy);
  }

  async function renderPreview(candidate, canvas) {
    if(activeSource.type==='pdf'&&previousRenderPreview)return previousRenderPreview(candidate,canvas);
    if(activeSource.type==='image'){
      const page=activeSource.rasterPages.find((p)=>Number(p.pageNumber)===Number(candidate.pageNumber))||activeSource.rasterPages[0];
      if(!page?.canvas)throw new Error('Imagem de origem não está mais disponível.');
      const source=candidate.sourceBox||{x:0,y:0,width:page.canvas.width,height:page.canvas.height};
      const margin=Math.max(28,Math.min(page.canvas.width,page.canvas.height)*.018);
      const sx=Math.max(0,Number(source.x||0)-margin),sy=Math.max(0,Number(source.y||0)-margin);
      const sw=Math.min(page.canvas.width-sx,Number(source.width||page.canvas.width)+margin*2),sh=Math.min(page.canvas.height-sy,Number(source.height||page.canvas.height)+margin*2);
      const ratio=Math.min(1,900/Math.max(1,sw));canvas.width=Math.max(1,Math.round(sw*ratio));canvas.height=Math.max(1,Math.round(sh*ratio));
      const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(page.canvas,sx,sy,sw,sh,0,0,canvas.width,canvas.height);return;
    }
    if(activeSource.type==='text'){
      canvas.width=900;canvas.height=240;const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#222';ctx.font='18px sans-serif';
      wrapCanvasText(canvas,candidate?.sourceText||candidate?.knowledgeCardText||candidate?.productName||'',24,38,850,28);return;
    }
    if(previousRenderPreview)return previousRenderPreview(candidate,canvas);
  }

  function downloadKnowledgeJson(knowledgeDocument,fileName='encarte'){
    const data=knowledgeDocument||window.MercadorPDFImporter?.lastKnowledgeDocument;
    if(!data)throw new Error('Nenhum JSON de conhecimento disponível.');
    if(previousDownloadKnowledgeJson&&data.schemaVersion!==KNOWLEDGE_SCHEMA_VERSION)return previousDownloadKnowledgeJson(data,fileName);
    const safe=String(fileName||'encarte').replace(/\.(?:pdf|txt|jpe?g|png|webp)$/i,'').replace(/[^a-z0-9._-]+/gi,'_');
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=`${safe}.mercador-knowledge-v6.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  window.MercadorPDFImporter={
    ...previous,
    MULTIFORMAT_ENGINE_VERSION:ENGINE_VERSION,
    MULTIFORMAT_KNOWLEDGE_SCHEMA_VERSION:KNOWLEDGE_SCHEMA_VERSION,
    analyzeSource,
    analyzeImages,
    analyzeText,
    renderPreview,
    downloadKnowledgeJson,
    __multiFormatDocumentImporterInstalled:true
  };

  console.info(`[Mercador IA] Document Intelligence ${ENGINE_VERSION} ativo: PDF + imagem + texto.`);
})();
