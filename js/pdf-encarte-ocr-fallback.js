(function () {
  'use strict';

  // Motor universal de conhecimento: preserva o importador anterior como validador,
  // mas transforma primeiro o PDF em um JSON canônico (texto nativo, OCR ou híbrido)
  // e extrai as promoções desse documento estruturado.
  const base = window.MercadorPDFImporter;
  if (!base || typeof base.analyzeFile !== 'function') {
    console.error('[Mercador IA] Importador PDF base não encontrado; fallback OCR não foi instalado.');
    return;
  }

  const OCR_ENGINE_VERSION = '3.4.0-card-recovery';
  const KNOWLEDGE_SCHEMA_VERSION = 'mercador.encarte.knowledge.v3';
  const TESSERACT_VERSION = '5.1.1';
  const PDFJS_VERSION = base.PDFJS_VERSION || '5.7.284';
  const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
  const TESSERACT_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`;
  const originalAnalyzeFile = base.analyzeFile.bind(base);
  let tesseractPromise = null;
  let pdfjsPromise = null;

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const cleanText = (v) => String(v || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  const fold = (v) => cleanText(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const center = (box) => ({ x:(Number(box?.x0 || 0)+Number(box?.x1 || 0))/2, y:(Number(box?.y0 || 0)+Number(box?.y1 || 0))/2 });

  function unionBoxes(boxes) {
    const list = (boxes || []).filter(Boolean);
    if (!list.length) return null;
    const x0 = Math.min(...list.map((b) => Number(b.x0 ?? b.x ?? 0)));
    const y0 = Math.min(...list.map((b) => Number(b.y0 ?? b.y ?? 0)));
    const x1 = Math.max(...list.map((b) => Number(b.x1 ?? ((b.x || 0) + (b.width || 0)))));
    const y1 = Math.max(...list.map((b) => Number(b.y1 ?? ((b.y || 0) + (b.height || 0)))));
    return { x0, y0, x1, y1, width:Math.max(1,x1-x0), height:Math.max(1,y1-y0) };
  }

  function toSourceBox(box, scale) {
    if (!box) return null;
    return { x:box.x0/scale, y:box.y0/scale, width:box.width/scale, height:box.height/scale };
  }

  function rangeDistance(value, start, end) {
    if (value < start) return start - value;
    if (value > end) return value - end;
    return 0;
  }

  function overlap1d(a0, a1, b0, b1) {
    return Math.max(0, Math.min(a1,b1)-Math.max(a0,b0));
  }

  function intersectionRatio(a,b) {
    if(!a || !b) return 0;
    const ix=overlap1d(a.x0,a.x1,b.x0,b.x1);
    const iy=overlap1d(a.y0,a.y1,b.y0,b.y1);
    const inter=ix*iy;
    if(!inter)return 0;
    return inter/Math.max(1,Math.min(a.width*a.height,b.width*b.height));
  }

  function median(values) {
    const a=(values||[]).filter(Number.isFinite).sort((x,y)=>x-y);
    if(!a.length)return 0;
    const mid=Math.floor(a.length/2);
    return a.length%2?a[mid]:(a[mid-1]+a[mid])/2;
  }

  async function loadTesseract() {
    if (window.Tesseract?.createWorker) return window.Tesseract;
    if (!tesseractPromise) {
      tesseractPromise = new Promise((resolve, reject) => {
        const existing=document.querySelector(`script[data-mercador-tesseract="${TESSERACT_VERSION}"]`);
        if(existing){
          existing.addEventListener('load',()=>resolve(window.Tesseract),{once:true});
          existing.addEventListener('error',()=>reject(new Error('Falha ao carregar o OCR visual.')),{once:true});
          return;
        }
        const script=document.createElement('script');
        script.src=TESSERACT_URL;script.async=true;script.dataset.mercadorTesseract=TESSERACT_VERSION;
        script.onload=()=>window.Tesseract?.createWorker?resolve(window.Tesseract):reject(new Error('OCR visual carregou sem API disponível.'));
        script.onerror=()=>reject(new Error('Não foi possível carregar o OCR visual. Verifique a conexão.'));
        document.head.appendChild(script);
      });
    }
    return tesseractPromise;
  }

  async function loadPdfJs() {
    if(!pdfjsPromise){
      pdfjsPromise=import(`${PDFJS_BASE}/build/pdf.mjs`).then((pdfjsLib)=>{
        pdfjsLib.GlobalWorkerOptions.workerSrc=`${PDFJS_BASE}/build/pdf.worker.mjs`;
        return pdfjsLib;
      });
    }
    return pdfjsPromise;
  }

  function flattenWords(data) {
    if(Array.isArray(data?.words)&&data.words.length)return data.words;
    const out=[];
    (Array.isArray(data?.blocks)?data.blocks:[]).forEach((block)=>(block.paragraphs||[]).forEach((paragraph)=>(paragraph.lines||[]).forEach((line)=>(line.words||[]).forEach((word)=>out.push(word)))));
    return out;
  }

  function normalizeOcrWords(data, {pass='layout',offsetX=0,offsetY=0}={}) {
    return flattenWords(data).map((word,index)=>{
      const bbox=word.bbox||{};
      const x0=Number(bbox.x0??bbox.left??0)+offsetX;
      const y0=Number(bbox.y0??bbox.top??0)+offsetY;
      const x1=Number(bbox.x1??bbox.right??x0+1)+offsetX;
      const y1=Number(bbox.y1??bbox.bottom??y0+1)+offsetY;
      return {id:`${pass}-${index}`,pass,text:cleanText(word.text),confidence:Number(word.confidence??word.conf??0),x0,y0,x1,y1,width:Math.max(1,x1-x0),height:Math.max(1,y1-y0)};
    }).filter((w)=>w.text&&w.width>0&&w.height>0);
  }

  function wordCenterDistance(a,b){const A=center(a),B=center(b);return Math.hypot(A.x-B.x,A.y-B.y);}

  // Une as leituras sem duplicar palavras sobrepostas. A leitura de maior confiança vence,
  // mas o número de passagens que enxergou a região fica preservado para calibrar confiança.
  function mergeOcrWords(wordSets) {
    const merged=[];
    (wordSets||[]).flat().sort((a,b)=>b.confidence-a.confidence).forEach((word)=>{
      const same=merged.find((x)=>{
        const overlap=intersectionRatio(x,word);
        const close=wordCenterDistance(x,word)<=Math.max(10,Math.min(x.height,word.height)*.7);
        const sizeRatio=Math.min(x.width,word.width)/Math.max(1,Math.max(x.width,word.width));
        return (overlap>=.52 || (close&&sizeRatio>=.55)) && fold(x.text)===fold(word.text);
      });
      if(same){
        same.passNames.add(word.pass);
        same.passCount=same.passNames.size;
        if(word.confidence>same.confidence){
          ['text','confidence','x0','y0','x1','y1','width','height','pass'].forEach((k)=>{same[k]=word[k];});
        }
        return;
      }
      merged.push({...word,passNames:new Set([word.pass]),passCount:1});
    });
    return merged;
  }

  function segmentRows(words) {
    if(!words.length)return [];
    const medianH=median(words.map((w)=>w.height))||18;
    const tolerance=Math.max(7,medianH*.52);
    const rows=[];
    [...words].sort((a,b)=>a.y0-b.y0||a.x0-b.x0).forEach((word)=>{
      const cy=(word.y0+word.y1)/2;
      let best=null,bestDelta=Infinity;
      rows.forEach((row)=>{
        const delta=Math.abs(row.cy-cy);
        const verticalOverlap=overlap1d(word.y0,word.y1,row.y0,row.y1);
        if(delta<=tolerance && (verticalOverlap>0 || delta<=medianH*.42) && delta<bestDelta){best=row;bestDelta=delta;}
      });
      if(!best){best={cy,y0:word.y0,y1:word.y1,words:[]};rows.push(best);}
      best.words.push(word);best.y0=Math.min(best.y0,word.y0);best.y1=Math.max(best.y1,word.y1);
      best.cy=best.words.reduce((s,w)=>s+(w.y0+w.y1)/2,0)/best.words.length;
    });

    const lines=[];
    rows.forEach((row)=>{
      const sorted=row.words.sort((a,b)=>a.x0-b.x0);
      let segment=[];
      const flush=()=>{
        if(!segment.length)return;
        const box=unionBoxes(segment);
        const text=cleanText(segment.map((w)=>w.text).join(' '));
        const confidence=segment.reduce((s,w)=>s+(Number(w.confidence)||0),0)/segment.length;
        lines.push({text,words:[...segment],box,confidence,cy:(box.y0+box.y1)/2});segment=[];
      };
      sorted.forEach((word)=>{
        if(segment.length){
          const prev=segment[segment.length-1];
          const gap=word.x0-prev.x1;
          const scale=Math.max(prev.height,word.height,medianH,9);
          // Limite menor evita juntar ofertas vizinhas na mesma linha do encarte.
          if(gap>Math.max(25,Math.min(54,scale*1.65)))flush();
        }
        segment.push(word);
      });
      flush();
    });
    return lines.sort((a,b)=>a.box.y0-b.box.y0||a.box.x0-b.box.x0);
  }

  function normalizeNumericOcr(value) {
    return fold(value)
      .replace(/[|IL](?=\d)/g,'1')
      .replace(/(?<=\d)[OQ](?=\d|\b)/g,'0')
      .replace(/S(?=\s*\$)/g,'R')
      .replace(/\s+/g,' ')
      .trim();
  }

  function parseOcrMoney(text) {
    let t=normalizeNumericOcr(text);
    const explicit=/\bR\s*\$|R\$|\bRS\b/.test(t);
    t=t.replace(/\bRS\b/g,'R$');

    let m=t.match(/(?:R\s*\$\s*)?(\d{1,4})\s*[,.;:]\s*(\d{2})(?!\d)/);
    if(m){
      const value=Number(`${m[1]}.${m[2]}`);
      if(Number.isFinite(value)&&value>0&&value<10000)return {price:Number(value.toFixed(2)),explicitCurrency:explicit,pattern:'decimal'};
    }

    if(explicit){
      // Encartes usam fonte muito grande: o OCR frequentemente separa reais e centavos.
      m=t.match(/R\s*\$\s*(\d{1,4})\s+(\d{2})(?!\d)/);
      if(m){
        const value=Number(`${m[1]}.${m[2]}`);
        if(Number.isFinite(value)&&value>0&&value<10000)return {price:Number(value.toFixed(2)),explicitCurrency:true,pattern:'split-cents'};
      }

      // Outro erro recorrente em arte promocional é perder a vírgula: R$248 = R$ 2,48.
      // Só aceitamos 3 a 5 dígitos depois de R$, nunca números soltos sem moeda.
      m=t.match(/R\s*\$\s*(\d{3,5})(?!\d)/);
      if(m){
        const digits=m[1];
        const integer=digits.slice(0,-2),cents=digits.slice(-2);
        const value=Number(`${integer}.${cents}`);
        if(Number.isFinite(value)&&value>=.5&&value<1000)return {price:Number(value.toFixed(2)),explicitCurrency:true,pattern:'compact-cents'};
      }
    }
    return null;
  }

  function priceCandidatesFromLines(lines, {pass='layout',medianWordHeight=16}={}) {
    const found=[];
    const maxPriceWidth=Math.max(145,medianWordHeight*10.5);
    const priceToken=(word)=>{
      const raw=cleanText(word?.text||'');
      if(!raw)return false;
      if(currencyAnchor(word))return true;
      const folded=fold(raw).replace(/\s+/g,'');
      if(/^[,.;:]$/.test(folded))return true;
      if(/^(?:R\$)?[0-9ILMOQ|]{1,5}(?:[,.;:][0-9ILMOQ|]{1,2})?$/.test(folded))return true;
      return compactNumericToken(raw)!=='' && !/[A-HJ-KNPR-Z]/i.test(raw);
    };

    lines.forEach((line,lineIndex)=>{
      const words=line.words||[];
      for(let i=0;i<words.length;i+=1){
        if(!priceToken(words[i]))continue;
        for(let len=1;len<=5&&i+len<=words.length;len+=1){
          const slice=words.slice(i,i+len);
          if(slice.some((w)=>!priceToken(w)))break;
          const box=unionBoxes(slice);
          if(!box||box.width>maxPriceWidth)break;
          const text=cleanText(slice.map((w)=>w.text).join(' '));
          const parsed=parseOcrMoney(text);
          if(!parsed)continue;
          const hasCurrency=parsed.explicitCurrency||slice.some(currencyAnchor);
          if(!hasCurrency&&len>2)continue;
          const confidence=slice.reduce((sum,w)=>sum+(Number(w.confidence)||0),0)/slice.length;
          const scale=box.height/Math.max(1,medianWordHeight);
          found.push({price:parsed.price,box,words:slice,lineIndex,confidence,explicitCurrency:hasCurrency,text,pass,pattern:parsed.pattern,scale});
        }
      }
    });

    const dedup=[];
    found.sort((a,b)=>Number(b.explicitCurrency)-Number(a.explicitCurrency)||b.confidence-a.confidence||b.scale-a.scale||a.box.width-b.box.width).forEach((p)=>{
      const pc=center(p.box);
      const exists=dedup.some((x)=>{
        const xc=center(x.box);
        return Math.abs(x.price-p.price)<.001&&Math.abs(xc.x-pc.x)<55&&Math.abs(xc.y-pc.y)<38;
      });
      if(!exists)dedup.push(p);
    });
    return dedup;
  }

  function compactNumericToken(value) {
    const original=cleanText(value);
    // Peso/volume/quantidade não podem virar parte de preço: 400g, 250ml, 3un etc.
    const alpha=fold(original).replace(/[ILMOQ]/g,'').replace(/[^A-Z]/g,'');
    if(alpha)return '';
    const normalized=normalizeNumericOcr(original).replace(/\s+/g,'');
    if(/[A-Z%]/.test(normalized.replace(/R\$?|RS/g,'')))return '';
    const raw=normalized.replace(/[^0-9]/g,'');
    return /^\d{1,5}$/.test(raw)?raw:'';
  }

  function currencyAnchor(word) {
    const t=fold(word?.text||'').replace(/\s+/g,'');
    return t==='R$'||t==='RS'||t==='$'||t==='R';
  }

  // Muitos encartes desenham "R$", reais e centavos como objetos tipográficos separados.
  // Tesseract pode colocar os centavos acima/abaixo da linha e o parser por linha perde o preço.
  // Esta leitura usa geometria, não somente texto corrido, e por isso recupera preços como:
  //   R$ 1 95   /   R$ 14 98   /   R$249   /   R$ 2,49
  // sem transformar números soltos de embalagem em preço.
  function priceCandidatesFromWords(words,{pass='layout',medianWordHeight=16}={}) {
    const list=(words||[]).filter((w)=>w?.text&&w.width>0&&w.height>0);
    const found=[];
    const maxX=Math.max(105,medianWordHeight*7.0);
    const maxY=Math.max(48,medianWordHeight*2.5);

    const push=(price,parts,pattern)=>{
      if(!Number.isFinite(price)||price<=0||price>=10000||!parts?.length)return;
      if(parts.some((w)=>w!==parts[0]&&compactNumericToken(w.text)===''&&!/^[,.;:]$/.test(cleanText(w.text))))return;
      const box=unionBoxes(parts);if(!box)return;
      if(box.width>Math.max(155,medianWordHeight*10.8))return;
      const confidence=parts.reduce((sum,w)=>sum+(Number(w.confidence)||0),0)/parts.length;
      const scale=box.height/Math.max(1,medianWordHeight);
      found.push({price:Number(price.toFixed(2)),box,words:[...parts],lineIndex:-1,confidence,explicitCurrency:true,text:cleanText(parts.map((w)=>w.text).join(' ')),pass,pattern,scale});
    };

    list.filter(currencyAnchor).forEach((anchor)=>{
      const ac=center(anchor);
      const near=list.filter((w)=>{
        if(w===anchor)return false;
        const wc=center(w);
        if(w.x1<anchor.x0-5||w.x0>anchor.x1+maxX)return false;
        if(Math.abs(wc.y-ac.y)>maxY)return false;
        if(compactNumericToken(w.text)===''&&!/^[,.;:]$/.test(cleanText(w.text)))return false;
        return true;
      }).sort((a,b)=>a.x0-b.x0||a.y0-b.y0);

      const ordered=near.filter((w)=>w.x0>=anchor.x0-4).slice(0,6);
      for(let start=0;start<Math.min(2,ordered.length);start+=1){
        for(let len=1;len<=3&&start+len<=ordered.length;len+=1){
          const parts=[anchor,...ordered.slice(start,start+len)];
          const box=unionBoxes(parts);
          if(!box||box.width>Math.max(155,medianWordHeight*10.8))continue;
          const parsed=parseOcrMoney(parts.map((w)=>w.text).join(' '));
          if(parsed?.price)push(parsed.price,parts,`spatial-${parsed.pattern}`);
        }
      }

      // Reais + centavos separados precisam formar um único bloco tipográfico compacto.
      const majors=near.filter((w)=>/^\d{1,4}$/.test(compactNumericToken(w.text)));
      majors.forEach((major)=>{
        const majorDigits=compactNumericToken(major.text);
        if(!majorDigits||major.x0<anchor.x0-5||major.x0-anchor.x1>Math.max(62,medianWordHeight*4.2))return;
        const mc=center(major);
        const cents=near
          .filter((w)=>w!==major&&/^\d{2}$/.test(compactNumericToken(w.text)))
          .filter((w)=>{
            const wc=center(w),gap=w.x0-major.x1;
            const heightRatio=w.height/Math.max(1,major.height);
            return gap>=-5&&gap<=Math.max(46,major.height*2.15)
              &&Math.abs(wc.y-mc.y)<=Math.max(38,major.height*1.15)
              &&heightRatio>=.32&&heightRatio<=1.45;
          })
          .sort((a,b)=>Math.abs(a.x0-major.x1)-Math.abs(b.x0-major.x1)||Math.abs(center(a).y-mc.y)-Math.abs(center(b).y-mc.y));
        if(cents.length){
          const centsDigits=compactNumericToken(cents[0].text);
          const value=Number(`${majorDigits}.${centsDigits}`);
          if(value>=.25&&value<1000)push(value,[anchor,major,cents[0]],'spatial-major-cents');
        }
      });
    });

    // Recuperação tipográfica sem R$: em muitos encartes o símbolo da moeda some no OCR,
    // mas reais e centavos continuam sendo dois glifos grandes e vizinhos. Só aceitamos o par
    // quando ambos têm escala de preço; números de embalagem em fonte normal não entram aqui.
    const largeMajors=list.filter((w)=>{
      const digits=compactNumericToken(w.text);
      return /^\d{1,3}$/.test(digits)&&w.height>=Math.max(24,medianWordHeight*1.34);
    });
    largeMajors.forEach((major)=>{
      const md=compactNumericToken(major.text),mc=center(major);
      const cents=list.filter((w)=>w!==major&&/^\d{2}$/.test(compactNumericToken(w.text))).filter((w)=>{
        const wc=center(w),gap=w.x0-major.x1;
        const hr=w.height/Math.max(1,major.height);
        return gap>=-6&&gap<=Math.max(50,major.height*2.2)
          &&Math.abs(wc.y-mc.y)<=Math.max(40,major.height*1.05)
          &&hr>=.34&&hr<=1.35
          &&w.height>=Math.max(12,medianWordHeight*.66);
      }).sort((a,b)=>Math.abs(a.x0-major.x1)-Math.abs(b.x0-major.x1)||Math.abs(center(a).y-mc.y)-Math.abs(center(b).y-mc.y));
      if(!cents.length)return;
      const value=Number(`${md}.${compactNumericToken(cents[0].text)}`);
      if(!Number.isFinite(value)||value<.25||value>=1000)return;
      const parts=[major,cents[0]],box=unionBoxes(parts);if(!box)return;
      const confidence=parts.reduce((sum,w)=>sum+(Number(w.confidence)||0),0)/parts.length;
      const scale=box.height/Math.max(1,medianWordHeight);
      found.push({price:Number(value.toFixed(2)),box,words:parts,lineIndex:-1,confidence,explicitCurrency:false,text:cleanText(parts.map((w)=>w.text).join(' ')),pass,pattern:'spatial-large-major-cents',scale});
    });

    const dedup=[];
    found.sort((a,b)=>Number(b.explicitCurrency)-Number(a.explicitCurrency)||b.confidence-a.confidence||b.scale-a.scale||a.box.width-b.box.width).forEach((p)=>{
      const pc=center(p.box);
      const duplicate=dedup.some((x)=>{
        const xc=center(x.box);
        return Math.abs(x.price-p.price)<.011&&Math.abs(xc.x-pc.x)<56&&Math.abs(xc.y-pc.y)<42;
      });
      if(!duplicate)dedup.push(p);
    });
    return dedup;
  }

  function collectPassPrices(entry) {
    const linePrices=priceCandidatesFromLines(entry.lines,{pass:entry.pass,medianWordHeight:entry.medianWordHeight});
    const wordPrices=priceCandidatesFromWords(entry.words||[],{pass:entry.pass,medianWordHeight:entry.medianWordHeight});
    const all=[...linePrices,...wordPrices];
    const dedup=[];
    all.sort((a,b)=>Number(b.explicitCurrency)-Number(a.explicitCurrency)||b.confidence-a.confidence||b.scale-a.scale).forEach((p)=>{
      const pc=center(p.box);
      const duplicate=dedup.some((x)=>{
        const xc=center(x.box);
        return Math.abs(x.price-p.price)<.011&&Math.abs(xc.x-pc.x)<68&&Math.abs(xc.y-pc.y)<50;
      });
      if(!duplicate)dedup.push(p);
    });
    return dedup;
  }

  function mergePricePasses(passPrices) {
    const all=(passPrices||[]).flat();
    const groups=[];
    all.sort((a,b)=>Number(b.explicitCurrency)-Number(a.explicitCurrency)||b.confidence-a.confidence).forEach((p)=>{
      const pc=center(p.box);
      let group=groups.find((g)=>{
        const gc=center(g.box);
        return Math.abs(g.price-p.price)<.011&&Math.abs(gc.x-pc.x)<58&&Math.abs(gc.y-pc.y)<44;
      });
      if(!group){
        group={...p,passNames:new Set([p.pass]),passCount:1,observations:[p],conflicts:[]};groups.push(group);return;
      }
      group.passNames.add(p.pass);group.passCount=group.passNames.size;group.observations.push(p);
      if(p.confidence>group.confidence){group.confidence=p.confidence;group.box=p.box;group.words=p.words;group.explicitCurrency=group.explicitCurrency||p.explicitCurrency;group.text=p.text;group.scale=Math.max(group.scale,p.scale);group.pattern=p.pattern||group.pattern;}
      else{group.explicitCurrency=group.explicitCurrency||p.explicitCurrency;group.scale=Math.max(group.scale,p.scale);}
    });

    const regions=[];
    groups.forEach((g)=>{
      const gc=center(g.box);
      let region=regions.find((r)=>Math.abs(r.cx-gc.x)<54&&Math.abs(r.cy-gc.y)<40);
      if(!region){region={cx:gc.x,cy:gc.y,groups:[]};regions.push(region);}
      region.groups.push(g);
      region.cx=region.groups.reduce((sum,x)=>sum+center(x.box).x,0)/region.groups.length;
      region.cy=region.groups.reduce((sum,x)=>sum+center(x.box).y,0)/region.groups.length;
    });

    const resolved=[];
    regions.forEach((region)=>{
      if(region.groups.length===1){resolved.push(region.groups[0]);return;}
      const score=(x)=>Number(x.passCount||1)*110+(x.explicitCurrency?28:0)+Number(x.confidence||0)+Math.min(2.4,Number(x.scale||0))*12;
      const ranked=[...region.groups].sort((a,b)=>score(b)-score(a));
      const best=ranked[0],second=ranked[1];
      const dominant=Number(best.passCount||1)>=2&&score(best)-score(second)>=58;
      if(dominant){
        best.conflicts=[];
        best.resolvedConflicts=ranked.slice(1).map((x)=>x.price);
        resolved.push(best);
      }else{
        ranked.forEach((g)=>{
          const gc=center(g.box);
          g.conflicts=ranked.filter((x)=>x!==g&&Math.abs(center(x.box).x-gc.x)<58&&Math.abs(center(x.box).y-gc.y)<44&&Math.abs(x.price-g.price)>.011).map((x)=>x.price);
          resolved.push(g);
        });
      }
    });
    return resolved;
  }

  const CATEGORY_HEADING_RE=/^(?:ACOUGUE(?:\s+COMPLETO)?|AÇOUGUE(?:\s+COMPLETO)?|PADARIA|PERECIVEIS(?:\s+E\s+SALSICHARIA)?|PERECÍVEIS(?:\s+E\s+SALSICHARIA)?|SALSICHARIA|HORTIFRUTI|HORTI\s*FRUTI|BEBIDAS|MERCEARIA|LIMPEZA|HIGIENE|BAZAR|FRIOS|CONGELADOS)$/i;
  const INSTITUTIONAL_RE=/(?:PRECO\s+BAIXO|PREÇO\s+BAIXO|FEIRA\s+GIGANTE|QUEM\s+QUISER|PODE\s+ECONOMIZAR|TODA\s+A\s+LOJA|SEM\s+JUROS|CARTAO|CARTÃO|CREDIFFATO|CREDIFATO|PECA\s+JA|PEÇA\s+JÁ|CLUBE\s+MAX|BAIXE\s+O\s+APP|APROVEITE\s+DESCONTOS|ACESSE\s+(?:O|AO)|FACA\s+(?:UM\s+)?CADASTRO|FAÇA\s+(?:UM\s+)?CADASTRO|INFORME\s+SEU\s+CPF|PRECOS?\s+VALIDOS?|PREÇOS?\s+VÁLIDOS?|ENQUANTO\s+DURAREM|MODALIDADE\s+ATACADO|PRODUTOS\s+DA\s+MESMA|CONSULTE\s+DISPONIBILIDADE|CONSULTAR\s+DISP(?:ONIBILIDADE)?|O?FERTAS?\s+V[AÁ]LIDAS?|OPORTUNIDADES|CANDIDATE[- ]?SE|INCLUSAO|INCLUSÃO|TELEVENDAS|VALE[- ]?GAS|VALE[- ]?GÁS|WHATSAPP|SAO\s+JOSE\s+DO\s+RIO\s+PRETO|SÃO\s+JOSÉ\s+DO\s+RIO\s+PRETO|VOTUPORANGA|FERNANDOPOLIS|FERNANDÓPOLIS|CATANDUVA|TEMOS\s+OPORTUNIDADES|NAO\s+JOGUE|NÃO\s+JOGUE|PAPEL\s+NO\s+CHAO|PAPEL\s+NO\s+CHÃO|ECONOMIA\s+NO\s+SEU\s+BOLSO|FARTURA\s+NO\s+CHURRASCO|CONDICOES|CONDIÇÕES|PARCELA|PARCELE|PARCELE\s+MINIMA|PARCELA\s+MINIMA|LOJES\s+COM|\bBAZAR\b|\bPARC[A-ZÀ-Ü]{0,7}\b|ACADO\s+SAO\s+VALID|ACADO\s+SÃO\s+VÁLID|SOMONTE\s+PARA|SOMENTE\s+PARA\s+PROD|CRED[ÍI]FIATO|CONDL[A-ZÀ-Ü]*)/i;

  function isInstitutionalText(text) {
    const t=cleanText(text);
    if(!t)return true;
    if(CATEGORY_HEADING_RE.test(t))return true;
    if(INSTITUTIONAL_RE.test(t))return true;
    const f=fold(t);
    if(/^(?:MAX|GIGANTE|OFERTA|OFERTAS|FEIRA|CLUBE|PROMOCAO|PROMOÇÃO)$/.test(f))return true;
    if(/\b(?:VALIDOS?\s+APENAS|MESMA\s+FRAGRANCIA|MESMA\s+FRAGRÂNCIA|SABORES\s+ETC)\b/.test(f))return true;
    return false;
  }

  function isNoiseLine(line) {
    const t=fold(line?.text||'');
    if(!t||t.length<2)return true;
    if(isInstitutionalText(line.text))return true;
    if(/^(?:KG|G|GR|ML|L|LT|LTS|UN|UND|UNIDADE|UNIDADES|CADA|PACOTE|PCT|BANDEJA|BDJ|CAIXA|CX)$/.test(t))return true;
    if(/^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}/.test(t))return true;
    if(extractPackage(line?.text||''))return false;
    const letters=(t.match(/[A-Z]/g)||[]).length,digits=(t.match(/\d/g)||[]).length;
    if(letters<2&&digits>letters*2)return true;
    return false;
  }

  function dedupeWords(text) {
    const words=cleanText(text).split(' ').filter(Boolean);const out=[];
    words.forEach((w)=>{if(!out.length||fold(out[out.length-1])!==fold(w))out.push(w);});
    return out.join(' ').replace(/\b(\w{3,})\s+\1\b/gi,'$1').replace(/\s+/g,' ').trim();
  }

  function sanitizeProductText(text) {
    let value=dedupeWords(text)
      .replace(/^[\s|:;,.\-–—»«'"`´]+/g,'')
      .replace(/[\s|:;,.\-–—»«'"`´]+$/g,'')
      .replace(/\bR\s*\$\s*\d.*$/i,'')
      .replace(/\s+/g,' ')
      .trim();
    // Remove tokens isolados típicos de ruído de OCR nas extremidades sem mexer no miolo real do produto.
    const tokens=value.split(' ').filter(Boolean);
    while(tokens.length>2&&/^[^A-Za-zÀ-ÿ0-9]*[A-Za-zÀ-ÿ]?[^A-Za-zÀ-ÿ0-9]*$/.test(tokens[0])&&tokens[0].length<=2)tokens.shift();
    while(tokens.length>2&&/^[^A-Za-zÀ-ÿ0-9]*[A-Za-zÀ-ÿ]?[^A-Za-zÀ-ÿ0-9]*$/.test(tokens[tokens.length-1])&&tokens[tokens.length-1].length<=2)tokens.pop();
    value=tokens.join(' ');
    return value;
  }

  function extractPackage(text) {
    const t=fold(text);
    const patterns=[
      /\bL\d+P\d+\b/,
      /\b(?:PACOTE|PCT|BANDEJA|BDJ|CAIXA|CX|GARRAFA|PET|LATA|POTE|SACO|SCH|PECA|PEÇA)?\s*\d+(?:[,.]\d+)?\s*(?:KG|G|GR|ML|L|LT|LTS|UN|UND|UNIDADES)\b/,
      /\b\d+\s*X\s*\d+(?:[,.]\d+)?\s*(?:G|ML|L|LT)\b/
    ];
    for(const p of patterns){const m=t.match(p);if(m)return cleanText(m[0]).toLowerCase();}
    return '';
  }

  const PRODUCT_CUE_RE=/\b(?:ABACATE|ABACAXI|ABOBORA|ABÓBORA|ABOBRINHA|ACELGA|ALHO|ALMEIRAO|ALMEIRÃO|ALFACE|BANANA|BATATA|BERINJELA|BETERRABA|BROCOLIS|BRÓCOLIS|CEBOLA|CENOURA|CHUCHU|COUVE|LARANJA|LIMAO|LIMÃO|MACA|MAÇÃ|MAMAO|MAMÃO|MANDIOCA|MANGA|MELANCIA|MELAO|MELÃO|MORANGO|MOURGOT|OVOS?|PEPINO|PERA|PIMENTAO|PIMENTÃO|REPOLHO|TANGERINA|TOMATE|UVA|VAGEM|FRANGO|BOVIN|SUIN|SUÍN|CARNE|COSTELA|PALETA|FILE|FILÉ|COXA|SOBRECOXA|PEITO|PERNIL|PANCETA|LINGUICA|LINGUIÇA|PRESUNTO|QUEIJO|MUSSARELA|MARGARINA|MANTEIGA|REQUEIJAO|REQUEIJÃO|IOGURTE|BEBIDA|LEITE|PAO|PÃO|BOLO|BROA|ROSCA|TORTA|SONHO|SALGADINHO|CAROLINA|EMPANADO|NUGGET|STEAK|SALSICHA|RAVIOLI|ARROZ|FEIJAO|FEIJÃO|CAFE|CAFÉ|ACUCAR|AÇÚCAR|OLEO|ÓLEO|MASSA|MACARR|BISCO|CHOC|REFRIG|CERVEJA|AGUA|ÁGUA|SABAO|SABÃO|DETERG|AMAC|PAPEL|SHAMPOO|SABONETE|FRALDA|DESOD|CARVAO|CARVÃO|AZEITE|FARINHA|MOLHO|MAIONESE|ATUM|MILHO)\b/i;

  function polishProductText(text) {
    let clean=sanitizeProductText(text)
      // Corrige unidades que o OCR costuma confundir somente em contexto inequívoco de embalagem.
      .replace(/\b(PACOTE|PCT|BANDEJA|BDJ|POTE|LATA|GARRAFA)\s*(\d{2,4})9\b/gi,'$1 $2g')
      .replace(/\b(PACOTE|PCT|BANDEJA|BDJ|POTE)\s+(\d{1,2})K[O0]\b/gi,'$1 $2Kg')
      // Condição promocional pertence ao card, mas não ao nome comercial do produto.
      .replace(/\bA\s+PARTIR\s+DE\s+\d+\s+UNIDADES?.*$/i,'')
      .replace(/\bAPARTRDE\s+\d+\s+UNIDADES?.*$/i,'')
      .trim();
    let tokens=clean.split(/\s+/).filter(Boolean);
    let cueIndex=tokens.findIndex((token)=>PRODUCT_CUE_RE.test(token));
    // Ruído típico de OCR antes do nome: duas ou mais sílabas curtas soltas antes de uma
    // marca/subtipo reconhecível e do substantivo do produto. Um único nome curto (ex.: Lar)
    // é preservado para não apagar marcas reais.
    if(cueIndex>=2){
      let shortRun=0;
      while(shortRun<cueIndex&&/^[A-Za-zÀ-ÿ]{1,3}$/.test(tokens[shortRun]))shortRun+=1;
      if(shortRun>=2){tokens=tokens.slice(shortRun);cueIndex=tokens.findIndex((token)=>PRODUCT_CUE_RE.test(token));}
    }
    if(cueIndex===1&&/\d/.test(tokens[0])&&/^(?:IOGURTE|BEBIDA|QUEIJO|PRESUNTO|MARGARINA|REQUEIJAO|REQUEIJÃO|SALSICHA|RAVIOLI|EMPANADO|STEAK|PAO|PÃO|BATATA)$/i.test(fold(tokens[1]))){
      tokens=[tokens[1],tokens[0],...tokens.slice(2)];
      cueIndex=0;
    }
    if(cueIndex>0){
      const prefix=tokens.slice(0,cueIndex);
      const noisy=prefix.filter((t)=>fold(t).replace(/[^A-Z0-9]/g,'').length<=2||/[^A-Za-zÀ-ÿ0-9-]/.test(t)).length/Math.max(1,prefix.length);
      if(noisy>=.45)tokens=tokens.slice(cueIndex);
    }
    const compact=[];
    for(let i=0;i<tokens.length;i+=1){
      const token=tokens[i],next=tokens[i+1];
      if(next){
        const a=fold(token).replace(/[^A-Z0-9]/g,''),b=fold(next).replace(/[^A-Z0-9]/g,'');
        if(a.length>=3&&b.length>=3&&(a.includes(b)||b.startsWith(a))){
          compact.push(b.length>=a.length?next:token);i+=1;continue;
        }
      }
      compact.push(token);
    }
    clean=dedupeWords(compact.join(' '));
    return clean;
  }

  function productSemanticScore(text, ocrConfidence=0) {
    const clean=polishProductText(text);
    if(!clean||isInstitutionalText(clean))return 0;
    const tokens=clean.split(/\s+/).filter(Boolean);
    if(!tokens.length)return 0;
    const chars=[...clean];
    const alpha=chars.filter((c)=>/[A-Za-zÀ-ÿ]/.test(c)).length;
    const weird=chars.filter((c)=>!/[A-Za-zÀ-ÿ0-9\s%/.,+&()\-]/.test(c)).length;
    const alphaRatio=alpha/Math.max(1,chars.length);
    const shortRatio=tokens.filter((t)=>fold(t).replace(/[^A-Z0-9]/g,'').length<=2).length/tokens.length;
    const wordLike=tokens.filter((t)=>{
      const letters=t.replace(/[^A-Za-zÀ-ÿ]/g,'');
      return letters.length<3||/[AEIOUÁÀÂÃÉÊÍÓÔÕÚÜ]/i.test(letters);
    }).length/tokens.length;
    const unique=new Set(tokens.map((t)=>fold(t))).size/Math.max(1,tokens.length);
    let score=.43;
    if(tokens.length>=2&&tokens.length<=9)score+=.15;else if(tokens.length<=13)score+=.07;else score-=.22;
    if(alphaRatio>=.62)score+=.10;else if(alphaRatio<.42)score-=.18;
    if(shortRatio<=.22)score+=.06;else if(shortRatio>.55)score-=.38;else if(shortRatio>.42)score-=.26;
    if(wordLike>=.70)score+=.08;else if(wordLike<.48)score-=.18;
    if(unique>=.72)score+=.05;else score-=.10;
    if(extractPackage(clean))score+=.12;
    if(PRODUCT_CUE_RE.test(clean))score+=.09;
    if(/\b(?:KG|G|GR|ML|L|LT|LTS|UN|UND|PACOTE|PCT|BANDEJA|BDJ|POTE|LATA|PET|GARRAFA|PECA|PEÇA)\b/i.test(clean))score+=.06;
    if(weird/Math.max(1,chars.length)>.055)score-=.18;
    if(ocrConfidence>=85)score+=.05;else if(ocrConfidence<58)score-=.12;
    if(/[»«]{1,}|['"`´]{2,}|\b[A-ZÀ-Ü]\s+[A-ZÀ-Ü]\s+[A-ZÀ-Ü]\b/.test(clean))score-=.10;
    return clamp(score,0,1);
  }


  // A descrição comercial precisa ser completa, não apenas "um texto perto do preço".
  // Esta nota diferencia um nome utilizável (ex.: "Queijo Mussarela Fatiado ... 160g")
  // de um fragmento plausível porém incompleto (ex.: "Fatiado Seara").
  function descriptionCompletenessScore(text) {
    const clean=polishProductText(text);
    if(!clean||isInstitutionalText(clean))return 0;
    const tokens=clean.split(/\s+/).filter(Boolean);
    const cue=PRODUCT_CUE_RE.test(clean);
    const pack=Boolean(extractPackage(clean));
    const folded=fold(clean);
    let score=.28;
    if(tokens.length>=3&&tokens.length<=12)score+=.16;else if(tokens.length===2)score+=.04;else if(tokens.length>15)score-=.20;
    if(cue)score+=.30;
    if(pack)score+=.18;
    if(/\b(?:KG|G|GR|ML|L|LT|LTS|UN|UND|PACOTE|PCT|BANDEJA|BDJ|POTE|LATA|PET|GARRAFA|PECA|PEÇA)\b/i.test(clean))score+=.06;
    if(/\b(?:PACOTE|PCT|BANDEJA|BDJ|POTE|LATA|GARRAFA)\s*$/i.test(clean))score-=.28;
    if(/^(?:FATIAD[OA]|TRADICIONAL|SABORES?|PACOTE|BANDEJA|CONGELAD[OA]|RESFRIAD[OA]|SEM|COM|LIGHT|ZERO|TIPOS?)\b/.test(folded)&&!cue)score-=.30;
    if(!cue&&!pack&&tokens.length<=3)score-=.24;
    if(/[»«]{1,}|['"`´]{2,}/.test(clean))score-=.12;
    return clamp(score,0,1);
  }

  function descriptionTokenSet(value) {
    return new Set(fold(value).replace(/[^A-Z0-9]+/g,' ').split(' ').filter((x)=>x.length>1));
  }

  function descriptionSimilarity(a,b) {
    const A=descriptionTokenSet(a),B=descriptionTokenSet(b);
    if(!A.size||!B.size)return 0;
    const common=[...A].filter((x)=>B.has(x)).length;
    return common/Math.max(A.size,B.size);
  }

  function descriptionContains(longer,shorter) {
    const A=descriptionTokenSet(longer),B=descriptionTokenSet(shorter);
    if(!A.size||!B.size||A.size<B.size)return false;
    const common=[...B].filter((x)=>A.has(x)).length;
    return common/Math.max(1,B.size)>=.88;
  }

  // Expande a descrição escolhida para linhas imediatamente acima/abaixo que pertençam ao
  // mesmo corredor visual. A expansão é conservadora: ela só entra quando aumenta a
  // completude sem degradar a semântica e sem atravessar claramente para o preço vizinho.
  function expandProductDescription(product,price,fragments,prices,pageWidth) {
    if(!product?.selectedFragments?.length)return product;
    const selected=[...product.selectedFragments].sort((a,b)=>a.fragment.box.y0-b.fragment.box.y0||a.fragment.box.x0-b.fragment.box.x0);
    const selectedSet=new Set(selected.map((x)=>x.fragment));
    const baseBox=unionBoxes(selected.map((x)=>x.fragment.box));
    if(!baseBox)return product;
    const pc=center(price.box);
    const corridorPad=Math.max(36,Math.min(105,pageWidth*.038));
    const candidates=(fragments||[]).filter((fragment)=>!selectedSet.has(fragment)).map((fragment)=>{
      const ownership=ownershipForFragment(price,fragment,prices,pageWidth);
      const semantic=productSemanticScore(fragment.text,fragment.confidence);
      const packageOnly=Boolean(extractPackage(fragment.text));
      return {fragment,ownership,semantic,packageOnly};
    }).filter((x)=>{
      if((x.semantic<.20&&!x.packageOnly)||isInstitutionalText(x.fragment.text))return false;
      const box=x.fragment.box,fc=center(box);
      const horizontal=overlap1d(box.x0,box.x1,baseBox.x0-corridorPad,baseBox.x1+corridorPad);
      const centerDiff=Math.abs(fc.x-center(baseBox).x);
      const aboveGap=baseBox.y0-box.y1,belowGap=box.y0-baseBox.y1;
      const nearVertical=(aboveGap>=0&&aboveGap<=78)||(belowGap>=0&&belowGap<=56);
      if(!nearVertical)return false;
      if(horizontal<=0&&centerDiff>Math.max(88,pageWidth*.052))return false;
      if(x.ownership.own>=99999)return false;
      // Se outro preço é claramente dono deste fragmento, não atravessamos o card.
      if(Number.isFinite(x.ownership.other)&&x.ownership.own>x.ownership.other+16)return false;
      // Linhas muito abaixo do preço normalmente já pertencem ao próximo card.
      if(box.y0>price.box.y1+42)return false;
      return true;
    });

    let best={...product,completeness:descriptionCompletenessScore(product.productName)};
    const trySubset=(subset)=>{
      const ordered=[...subset].sort((a,b)=>a.fragment.box.y0-b.fragment.box.y0||a.fragment.box.x0-b.fragment.box.x0);
      const text=polishProductText(ordered.map((x)=>x.fragment.text).join(' '));
      if(!text||isInstitutionalText(text))return;
      const words=text.split(/\s+/).filter(Boolean).length;
      if(words>17)return;
      for(let k=1;k<ordered.length;k+=1){if(ordered[k].fragment.box.y0-ordered[k-1].fragment.box.y1>84)return;}
      const box=unionBoxes(ordered.map((x)=>x.fragment.box));
      const ocrConfidence=ordered.reduce((s,x)=>s+Number(x.fragment.confidence||0),0)/ordered.length;
      const semantic=productSemanticScore(text,ocrConfidence);
      const completeness=descriptionCompletenessScore(text);
      const ownershipConfidence=ordered.reduce((s,x)=>s+Number(x.ownership?.confidence ?? .55),0)/ordered.length;
      const horizontal=rangeDistance(pc.x,box.x0-10,box.x1+10);
      const vertical=box.y1<=price.box.y0?price.box.y0-box.y1:Math.abs(center(box).y-pc.y)*1.1;
      const spatial=clamp(1-horizontal/Math.max(140,pageWidth*.10)-vertical/Math.max(260,pageWidth*.19)*.62,0,1);
      // Para substituir a versão anterior, a expansão precisa ser mais completa e manter
      // semântica/posição em patamar profissional.
      const improvement=completeness-(best.completeness||0);
      const score=completeness*120+semantic*100+spatial*45+ownershipConfidence*35+ocrConfidence*.12+Math.min(words,11)*2;
      const bestScore=(best.completeness||0)*120+Number(best.semantic||0)*100+Number(best.spatial||0)*45+Number(best.ownershipConfidence||0)*35+Number(best.ocrConfidence||0)*.12+Math.min((best.productName||'').split(/\s+/).length,11)*2;
      const additions=ordered.filter((x)=>!selectedSet.has(x.fragment));
      const structuralAddition=additions.some((x)=>x.packageOnly||PRODUCT_CUE_RE.test(x.fragment.text));
      const directAddition=additions.some((x)=>{
        const b=x.fragment.box;
        return Math.min(Math.abs(baseBox.y0-b.y1),Math.abs(b.y0-baseBox.y1))<=38;
      });
      if(semantic>=Math.max(.48,Number(best.semantic||0)-.055)&&completeness>=.55&&(improvement>=.025||score>bestScore+3||(structuralAddition&&directAddition&&completeness>=Number(best.completeness||0)-.01&&score>=bestScore-2))){
        best={...best,productName:text,productBox:box,ocrConfidence,semantic,ownershipConfidence,spatial,selectedFragments:ordered,completeness};
      }
    };

    candidates.forEach((candidate)=>trySubset([...selected,candidate]));
    // Também tenta duas linhas adicionais quando são contíguas e do mesmo corredor.
    for(let i=0;i<candidates.length;i+=1){
      for(let j=i+1;j<candidates.length;j+=1){
        const a=candidates[i].fragment.box,b=candidates[j].fragment.box;
        if(Math.abs(center(a).x-center(b).x)>Math.max(110,pageWidth*.06))continue;
        if(Math.abs(a.y0-b.y0)>150)continue;
        trySubset([...selected,candidates[i],candidates[j]]);
      }
    }
    return best;
  }

  // Fecha a descrição pelo corredor exclusivo do card depois da escolha principal.
  // Diferente da expansão por score, esta etapa recupera cabeçalho e embalagem contíguos
  // (ex.: "Queijo" + "Mussarela ..." + "160g") sem atravessar para o card vizinho.
  function completeOwnedProductDescription(product,price,fragments,prices,pageWidth) {
    if(!product?.selectedFragments?.length)return product;
    const baseItems=[...product.selectedFragments];
    const baseBox=unionBoxes(baseItems.map((x)=>x.fragment.box));
    if(!baseBox)return product;
    const connector=/^(?:OU|COM|SEM|DE|DA|DO|DAS|DOS|E)$/i;
    const pad=Math.max(34,Math.min(62,pageWidth*.034));
    const candidates=(fragments||[]).map((fragment)=>{
      const ownership=ownershipForFragment(price,fragment,prices,pageWidth);
      const semantic=productSemanticScore(fragment.text,fragment.confidence);
      const pack=Boolean(extractPackage(fragment.text));
      const connect=connector.test(fold(fragment.text));
      return {fragment,ownership,semantic,packageOnly:pack,connectorOnly:connect};
    }).filter((x)=>{
      if(!x.ownership.accepted||isInstitutionalText(x.fragment.text))return false;
      if(x.semantic<.20&&!x.packageOnly&&!x.connectorOnly)return false;
      const box=x.fragment.box,fc=center(box),bc=center(baseBox);
      const horizontal=overlap1d(box.x0,box.x1,baseBox.x0-pad,baseBox.x1+pad);
      if(horizontal<=0&&Math.abs(fc.x-bc.x)>Math.max(68,pageWidth*.04))return false;
      if(box.y1<baseBox.y0-58||box.y0>price.box.y0+12)return false;
      return true;
    }).sort((a,b)=>a.fragment.box.y0-b.fragment.box.y0||a.fragment.box.x0-b.fragment.box.x0);

    if(!candidates.length)return product;
    const selected=[];
    // Começa pelos itens já escolhidos e adiciona vizinhos contíguos acima/abaixo.
    const originalSet=new Set(baseItems.map((x)=>x.fragment));
    candidates.forEach((x)=>{if(originalSet.has(x.fragment))selected.push(x);});
    let changed=true;
    while(changed){
      changed=false;
      const currentBox=unionBoxes(selected.map((x)=>x.fragment.box))||baseBox;
      for(const x of candidates){
        if(selected.includes(x))continue;
        const b=x.fragment.box;
        const gapAbove=currentBox.y0-b.y1;
        const gapBelow=b.y0-currentBox.y1;
        const verticalNear=(gapAbove>=-8&&gapAbove<=42)||(gapBelow>=-8&&gapBelow<=38)||(b.y0<=currentBox.y1&&b.y1>=currentBox.y0);
        if(!verticalNear)continue;
        selected.push(x);changed=true;
      }
    }
    if(!selected.length)return product;
    selected.sort((a,b)=>a.fragment.box.y0-b.fragment.box.y0||a.fragment.box.x0-b.fragment.box.x0);
    const text=polishProductText(selected.map((x)=>x.fragment.text).join(' '));
    if(!text||isInstitutionalText(text))return product;
    const words=text.split(/\s+/).filter(Boolean);
    if(words.length>17)return product;
    const ocrConfidence=selected.reduce((sum,x)=>sum+Number(x.fragment.confidence||0),0)/selected.length;
    const semantic=productSemanticScore(text,ocrConfidence);
    const completeness=descriptionCompletenessScore(text);
    const oldWords=(product.productName||'').split(/\s+/).filter(Boolean).length;
    const usefulGain=words.length>oldWords||Boolean(extractPackage(text)&&!extractPackage(product.productName));
    if(!usefulGain||semantic<Math.max(.48,Number(product.semantic||0)-.06)||completeness<Math.max(.52,Number(product.completeness||0)-.04))return product;
    const productBox=unionBoxes(selected.map((x)=>x.fragment.box));
    const ownershipConfidence=selected.reduce((sum,x)=>sum+Number(x.ownership.confidence||0),0)/selected.length;
    const pc=center(price.box);
    const horizontal=rangeDistance(pc.x,productBox.x0-10,productBox.x1+10);
    const vertical=productBox.y1<=price.box.y0?price.box.y0-productBox.y1:Math.abs(center(productBox).y-pc.y)*1.1;
    const spatial=clamp(1-horizontal/Math.max(140,pageWidth*.10)-vertical/Math.max(260,pageWidth*.19)*.62,0,1);
    return {...product,productName:text,productBox,ocrConfidence,semantic,ownershipConfidence,spatial,selectedFragments:selected,completeness};
  }

  // Escolhe a melhor descrição entre as leituras independentes (página inteira, densa,
  // faixas verticais/horizontais). Uma leitura longa e coerente vence um fragmento curto;
  // leituras conflitantes são explicitamente marcadas para revisão.
  function chooseProductDescriptionVariant(variants) {
    const prepared=(variants||[]).filter(Boolean).map((variant)=>{
      const productName=polishProductText(variant.productName||'');
      const semantic=productSemanticScore(productName,variant.ocrConfidence||0);
      const completeness=descriptionCompletenessScore(productName);
      return {...variant,productName,semantic,completeness};
    }).filter((v)=>v.productName&&v.semantic>=.42&&v.completeness>=.35&&!isInstitutionalText(v.productName));
    if(!prepared.length)return null;

    // Remove duplicatas textuais mantendo a leitura mais forte.
    const unique=[];
    prepared.sort((a,b)=>b.completeness-a.completeness||b.semantic-a.semantic||b.ocrConfidence-a.ocrConfidence).forEach((v)=>{
      const existing=unique.find((x)=>descriptionSimilarity(x.productName,v.productName)>=.94);
      if(!existing)unique.push(v);
    });

    unique.forEach((v)=>{
      let agreement=unique.length===1?1:0,support=0,containmentBonus=0;
      unique.forEach((o)=>{
        if(o===v)return;
        const sim=descriptionSimilarity(v.productName,o.productName);
        agreement=Math.max(agreement,sim);
        if(sim>=.64)support+=1;
        if(descriptionContains(v.productName,o.productName)&&v.productName.split(/\s+/).length>o.productName.split(/\s+/).length)containmentBonus+=10;
      });
      const words=v.productName.split(/\s+/).filter(Boolean).length;
      const partialPenalty=unique.some((o)=>o!==v&&descriptionContains(o.productName,v.productName)&&o.completeness>=v.completeness-.04&&o.productName.split(/\s+/).length>=words+2)?18:0;
      v.descriptionAgreement=agreement;
      v.variantSupport=support;
      v.variantScore=v.completeness*150+v.semantic*115+Number(v.spatial||0)*52+Number(v.ownershipConfidence||0)*42+Number(v.ocrConfidence||0)*.16+support*16+containmentBonus+Math.min(words,12)*2-partialPenalty;
    });
    unique.sort((a,b)=>b.variantScore-a.variantScore||b.completeness-a.completeness);
    const best=unique[0],runner=unique[1];
    let conflict=false;
    if(runner&&best.completeness>=.58&&runner.completeness>=.58){
      const sim=descriptionSimilarity(best.productName,runner.productName);
      const contained=descriptionContains(best.productName,runner.productName)||descriptionContains(runner.productName,best.productName);
      conflict=sim<.32&&!contained&&Math.abs(best.variantScore-runner.variantScore)<32;
    }
    const fidelity=clamp(best.completeness*.47+best.semantic*.30+Number(best.spatial||0)*.13+Number(best.descriptionAgreement||0)*.10,0,1);
    return {...best,descriptionConflict:conflict,descriptionFidelity:fidelity,descriptionVariantCount:unique.length};
  }

  function pricesShareCard(a,b) {
    if(!a||!b||!a.box||!b.box)return false;
    const A=center(a.box),B=center(b.box);
    const h=Math.max(Number(a.box.height||0),Number(b.box.height||0),18);
    return Math.abs(A.x-B.x)<=Math.max(52,h*1.8)&&Math.abs(A.y-B.y)<=Math.max(38,h*1.6);
  }

  function horizontalPriceCell(price,prices,pageWidth=1200) {
    const pc=center(price.box);
    const rowTol=Math.max(72,Number(price.box?.height||0)*3.0);
    const peers=(prices||[]).filter((p)=>p!==price&&!pricesShareCard(p,price)&&Math.abs(center(p.box).y-pc.y)<=rowTol);
    const left=peers.filter((p)=>center(p.box).x<pc.x).sort((a,b)=>center(b.box).x-center(a.box).x)[0];
    const right=peers.filter((p)=>center(p.box).x>pc.x).sort((a,b)=>center(a.box).x-center(b.box).x)[0];
    const l=left?(center(left.box).x+pc.x)/2:Math.max(0,pc.x-Math.max(115,pageWidth*.09));
    const r=right?(center(right.box).x+pc.x)/2:Math.min(pageWidth,pc.x+Math.max(115,pageWidth*.09));
    return {left:l,right:r};
  }

  function boxInsideHorizontalCell(box,price,prices,pageWidth=1200) {
    const cell=horizontalPriceCell(price,prices,pageWidth);
    const inside=Math.max(0,Math.min(box.x1,cell.right)-Math.max(box.x0,cell.left));
    const ratio=inside/Math.max(1,box.width);
    const cx=center(box).x;
    return {accepted:cx>=cell.left-4&&cx<=cell.right+4&&ratio>=.62,ratio,cell};
  }

  function nearestPriceOwnerForBox(box,prices,pageWidth=1200) {
    if(!box||(prices||[]).length===0)return {price:null,confidence:0,best:Infinity,second:Infinity};
    const fc=center(box);
    const scored=(prices||[]).map((price)=>{
      const pc=center(price.box);
      const above=price.box.y0-box.y1;
      const below=box.y0-price.box.y1;
      if(above>Math.max(300,pageWidth*.20)||below>Math.max(88,pageWidth*.055))return {price,cost:99999};
      const horizontal=rangeDistance(pc.x,box.x0-10,box.x1+10);
      const vertical=above>=0?above*.58:(below>=0?below*1.9:Math.abs(fc.y-pc.y)*.42);
      const centerDx=Math.abs(fc.x-pc.x);
      return {price,cost:horizontal*1.55+vertical+centerDx*.075};
    }).filter((x)=>x.cost<99999).sort((a,b)=>a.cost-b.cost);
    if(!scored.length)return {price:null,confidence:0,best:Infinity,second:Infinity};
    const best=scored[0],second=scored[1];
    if(!second)return {price:best.price,confidence:1,best:best.cost,second:Infinity};
    const margin=second.cost-best.cost;
    const confidence=clamp(.45+margin/Math.max(55,second.cost)*.72,0,1);
    return {price:best.price,confidence,best:best.cost,second:second.cost,margin};
  }

  function buildTextFragments(words, prices, pageWidth=1200) {
    const lines=segmentRows(words);
    const priceBoxes=(prices||[]).map((p)=>p.box).filter(Boolean);
    const heights=words.map((w)=>w.height);const medianH=median(heights)||16;
    const fragments=[];
    lines.forEach((line)=>{
      const kept=(line.words||[]).filter((word)=>{
        if(/^(?:R\$|R|\$|RS)$/i.test(cleanText(word.text)))return false;
        return !priceBoxes.some((pb)=>intersectionRatio(word,pb)>=.34);
      }).sort((a,b)=>a.x0-b.x0);
      let seg=[],segOwner=null;
      const flush=()=>{
        if(!seg.length)return;
        const box=unionBoxes(seg),text=sanitizeProductText(seg.map((w)=>w.text).join(' '));
        const confidence=seg.reduce((sum,w)=>sum+(Number(w.confidence)||0),0)/seg.length;
        const owner=nearestPriceOwnerForBox(box,prices,pageWidth);
        if(text&&!isNoiseLine({text,box}))fragments.push({text,words:[...seg],box,confidence,cy:(box.y0+box.y1)/2,ownerPrice:owner.price,ownerConfidence:owner.confidence});
        seg=[];segOwner=null;
      };
      kept.forEach((word)=>{
        const wordOwner=nearestPriceOwnerForBox(word,prices,pageWidth);
        if(seg.length){
          const prev=seg[seg.length-1],gap=word.x0-prev.x1,scale=Math.max(prev.height,word.height,medianH,8);
          const ownerChanged=segOwner?.price&&wordOwner?.price&&segOwner.price!==wordOwner.price&&!pricesShareCard(segOwner.price,wordOwner.price)&&Math.max(segOwner.confidence,wordOwner.confidence)>=.54;
          if(gap>Math.max(20,Math.min(40,scale*1.42))||ownerChanged)flush();
        }
        if(!seg.length)segOwner=wordOwner;
        seg.push(word);
      });
      flush();
    });
    return fragments;
  }

  function priceFragmentCost(price,fragment,pageWidth) {
    const pc=center(price.box),fc=center(fragment.box);
    const horizontal=rangeDistance(pc.x,fragment.box.x0-12,fragment.box.x1+12);
    const aboveGap=price.box.y0-fragment.box.y1;
    const belowGap=fragment.box.y0-price.box.y1;
    const sameBand=Math.abs(fc.y-pc.y)<=Math.max(34,price.box.height*1.25);
    if(sameBand&&fragment.box.x1<=price.box.x0+50){
      const gap=Math.max(0,price.box.x0-fragment.box.x1);
      return gap*.58+Math.abs(fc.y-pc.y)*.82+horizontal*.3;
    }
    if(aboveGap>=-18&&aboveGap<=Math.max(250,pageWidth*.18))return Math.max(0,aboveGap)*.70+horizontal*1.04+Math.abs(fc.x-pc.x)*.035;
    if(belowGap>=0&&belowGap<=Math.max(70,price.box.height*2.2))return belowGap*1.35+horizontal*1.15+42;
    return 99999;
  }

  function ownershipForFragment(price,fragment,prices,pageWidth) {
    const own=priceFragmentCost(price,fragment,pageWidth);
    const scored=(prices||[]).map((candidate)=>({candidate,cost:priceFragmentCost(candidate,fragment,pageWidth)})).filter((x)=>x.cost<99999).sort((a,b)=>a.cost-b.cost);
    if(!scored.length)return {accepted:false,confidence:0,own,other:Infinity};
    const best=scored[0],second=scored[1];
    const shares=fragment.ownerPrice&&pricesShareCard(fragment.ownerPrice,price);
    const explicitOwnerOk=!fragment.ownerPrice||fragment.ownerPrice===price||shares||Number(fragment.ownerConfidence||0)<.48;
    const isBest=best.candidate===price||pricesShareCard(best.candidate,price);
    const cellCheck=boxInsideHorizontalCell(fragment.box,price,prices,pageWidth);
    const other=second?.cost??Infinity;
    const margin=Number.isFinite(other)?other-own:Infinity;
    const confidence=!Number.isFinite(other)?1:clamp(.46+margin/Math.max(50,other)*.72,0,1);
    const ambiguous=Number.isFinite(other)&&margin<Math.max(5,Math.min(18,own*.10));
    return {accepted:own<99999&&isBest&&explicitOwnerOk&&cellCheck.accepted&&!ambiguous,confidence:confidence*cellCheck.ratio,own,other,cell:cellCheck.cell};
  }

  function productForPrice(price, fragments, prices, pageWidth) {
    const eligible=[];
    fragments.forEach((fragment)=>{
      const ownership=ownershipForFragment(price,fragment,prices,pageWidth);
      if(!ownership.accepted)return;
      const semantic=productSemanticScore(fragment.text,fragment.confidence);
      if(semantic<.24)return;
      const cost=ownership.own;
      if(cost>=99999)return;
      eligible.push({fragment,ownership,semantic,cost});
    });
    if(!eligible.length)return null;

    eligible.sort((a,b)=>(a.cost-b.cost)||(b.semantic-a.semantic));
    const anchors=eligible.slice(0,Math.min(8,eligible.length));
    let best=null;
    anchors.forEach((anchor)=>{
      const owned=eligible
        .filter((x)=>x.ownership.confidence>=.40)
        .filter((x)=>{
          const box=x.fragment.box,ab=anchor.fragment.box;
          const yDistance=Math.abs(box.y1-ab.y1);
          const hOverlap=overlap1d(box.x0,box.x1,ab.x0-85,ab.x1+85);
          const centerDiff=Math.abs(center(box).x-center(ab).x);
          return yDistance<=220&&(hOverlap>0||centerDiff<=Math.max(120,pageWidth*.08));
        })
        .sort((a,b)=>a.fragment.box.y0-b.fragment.box.y0);

      const anchorIndex=owned.findIndex((x)=>x.fragment===anchor.fragment);
      const start=Math.max(0,anchorIndex-3),end=Math.min(owned.length,anchorIndex+2);
      for(let s=start;s<=anchorIndex;s+=1){
        for(let e=Math.max(anchorIndex,s);e<end;e+=1){
          const subset=owned.slice(s,e+1);
          if(!subset.some((x)=>x.fragment===anchor.fragment))continue;
          let contiguous=true;
          for(let k=1;k<subset.length;k+=1){if(subset[k].fragment.box.y0-subset[k-1].fragment.box.y1>82){contiguous=false;break;}}
          if(!contiguous)continue;
          const text=polishProductText(subset.map((x)=>x.fragment.text).join(' '));
          if(!text||isInstitutionalText(text))continue;
          const box=unionBoxes(subset.map((x)=>x.fragment.box));
          const ocrConfidence=subset.reduce((sum,x)=>sum+x.fragment.confidence,0)/subset.length;
          const semantic=productSemanticScore(text,ocrConfidence);
          const ownershipConfidence=subset.reduce((sum,x)=>sum+x.ownership.confidence,0)/subset.length;
          const pc=center(price.box);
          const horizontal=rangeDistance(pc.x,box.x0-10,box.x1+10);
          const vertical=box.y1<=price.box.y0?price.box.y0-box.y1:Math.abs(center(box).y-pc.y)*1.1;
          const spatial=clamp(1-horizontal/Math.max(140,pageWidth*.10)-vertical/Math.max(260,pageWidth*.19)*.62,0,1);
          const words=text.split(/\s+/).length;
          const score=semantic*145+spatial*64+ownershipConfidence*52+ocrConfidence*.20-Math.max(0,words-12)*8-anchor.cost*.05;
          if(!best||score>best.score)best={score,productName:text,productBox:box,ocrConfidence,semantic,ownershipConfidence,spatial,selectedFragments:subset};
        }
      }
    });
    if(!best||best.semantic<.50)return null;
    if(!PRODUCT_CUE_RE.test(best.productName)&&!extractPackage(best.productName)&&best.semantic<.68)return null;
    if(best.productName.split(/\s+/).length>15)return null;
    return best;
  }

  function parseFilenameValidity(fileName) {
    const name=fold(fileName).replace(/[._-]+/g,' ');const year=new Date().getFullYear();
    const m=name.match(/\b(\d{1,2})\s*(?:E|A|ATE)\s*(\d{1,2})\s+(\d{1,2})\b/);
    if(!m)return null;
    const startDay=Number(m[1]),endDay=Number(m[2]),month=Number(m[3]);
    if(month<1||month>12||startDay<1||startDay>31||endDay<1||endDay>31)return null;
    const start=new Date(year,month-1,startDay,0,0,0,0).getTime();
    const end=new Date(year,month-1,endDay,23,59,59,999).getTime();
    return {startAt:start,endAt:end,raw:`${String(startDay).padStart(2,'0')}/${String(month).padStart(2,'0')}/${year} a ${String(endDay).padStart(2,'0')}/${String(month).padStart(2,'0')}/${year}`,condition:'',inferred:true};
  }

  function enrichValidity(documentText,fileName) {
    const detected=typeof base.extractValidity==='function'?base.extractValidity(documentText):{startAt:null,endAt:null,raw:'',condition:''};
    if(detected?.startAt&&detected?.endAt){
      const condition=/ENQUANTO\s+DURAREM\s+OS?\s+ESTOQUES?/i.test(documentText)?'enquanto durarem os estoques':(detected.condition||'');
      return {...detected,condition,inferred:false};
    }
    return parseFilenameValidity(fileName)||detected||{startAt:null,endAt:null,raw:'',condition:'',inferred:false};
  }

  function candidateConfidence({product,price,validity,packageText,wordsCount}) {
    let score=.55;const evidence=[],risks=[];
    if(price.explicitCurrency){score+=.07;evidence.push('preço com marcador R$ reconhecido por OCR');}else risks.push('ocr_price_without_currency');
    if(price.passCount>=2){score+=.06;evidence.push('preço confirmado em mais de uma leitura visual');}
    else if(price.confidence<84||price.scale<1.18)risks.push('ocr_price_single_pass');
    if(price.confidence>=86){score+=.055;evidence.push('preço visual com OCR de alta confiança');}
    else if(price.confidence>=72)score+=.025;else risks.push('ocr_low_price_confidence');
    if(price.scale>=1.18){score+=.04;evidence.push('preço com destaque tipográfico compatível com oferta');}
    else if(price.scale<.82)risks.push('ocr_price_scale_suspicious');
    if(price.conflicts?.length){risks.push('ocr_price_conflict');score-=.08;}

    if(product.ocrConfidence>=86){score+=.045;evidence.push('texto visual com OCR de alta confiança');}
    else if(product.ocrConfidence>=70){score+=.018;evidence.push('texto visual reconhecido por OCR');}
    else risks.push('ocr_low_text_confidence');

    if(product.semantic>=.78){score+=.12;evidence.push('descrição com estrutura compatível com produto');}
    else if(product.semantic>=.62){score+=.07;evidence.push('descrição de produto consistente');}
    else if(product.semantic<.48){risks.push('ocr_low_description_quality');score-=.10;}

    const completeness=Number(product.completeness ?? descriptionCompletenessScore(product.productName));
    if(completeness>=.82){score+=.065;evidence.push('descrição comercial completa reconstruída por OCR');}
    else if(completeness>=.66){score+=.03;evidence.push('descrição comercial com boa completude');}
    else {risks.push('ocr_incomplete_description');score-=.09;}
    if(Number(product.descriptionVariantCount||0)>=2&&Number(product.descriptionAgreement||0)>=.66){score+=.045;evidence.push('descrição confirmada em leituras independentes');}
    if(product.descriptionConflict){risks.push('ocr_description_conflict');score-=.10;}

    if(product.spatial>=.82){score+=.075;evidence.push('produto e preço no mesmo bloco visual');}
    else if(product.spatial>=.66){score+=.035;evidence.push('associação espacial visual compatível');}
    else risks.push('association_disagreement');

    if(product.ownershipConfidence>=.72){score+=.055;evidence.push('bloco visual pertence ao preço selecionado');}
    else if(product.ownershipConfidence>=.52)score+=.02;
    else {risks.push('ocr_block_ownership_weak');score-=.05;}

    if(wordsCount>=2&&wordsCount<=12)score+=.025;
    if(packageText){score+=.025;evidence.push('embalagem identificada');}
    if(validity?.startAt&&validity?.endAt&&!validity.inferred){score+=.065;evidence.push('validade lida no próprio encarte');}
    else if(validity?.startAt&&validity?.endAt&&validity.inferred){score+=.01;evidence.push('validade inferida pelo nome do arquivo');risks.push('ocr_validity_inferred');}
    else risks.push('missing_validity');

    const hard=new Set(['association_disagreement','missing_validity','ocr_low_price_confidence','ocr_price_conflict','ocr_price_scale_suspicious','ocr_low_description_quality','ocr_incomplete_description','ocr_description_conflict','ocr_validity_inferred']);
    if(risks.some((r)=>hard.has(r)))score=Math.min(score,.91);
    const confidence=clamp(score,.42,.995);
    const agreementOk=Number(product.descriptionVariantCount||0)<2||Number(product.descriptionAgreement||0)>=.46;
    const structuralSafe=!risks.some((r)=>hard.has(r))&&Boolean(validity?.startAt&&validity?.endAt)&&!validity?.inferred&&price.explicitCurrency&&product.semantic>=.62&&completeness>=.66&&agreementOk&&!product.descriptionConflict&&product.spatial>=.68&&product.ownershipConfidence>=.50&&product.ocrConfidence>=68&&price.confidence>=72;
    const automationSafe=structuralSafe&&product.semantic>=.74&&completeness>=.78&&(Number(product.descriptionVariantCount||0)<2||Number(product.descriptionAgreement||0)>=.60)&&product.spatial>=.78&&product.ownershipConfidence>=.64&&product.ocrConfidence>=72&&price.confidence>=78&&(price.passCount>=2||price.scale>=1.28)&&confidence>=.97;
    return {confidence,risks:[...new Set(risks)],evidence:[...new Set(evidence)],structuralSafe,automationSafe};
  }

  function productSimilarity(a,b) {
    const tokens=(v)=>new Set(fold(v).replace(/[^A-Z0-9]+/g,' ').split(' ').filter((x)=>x.length>1));
    const A=tokens(a),B=tokens(b);if(!A.size||!B.size)return 0;
    const common=[...A].filter((x)=>B.has(x)).length;return common/Math.max(A.size,B.size);
  }

  function buildOcrCandidates(pageData,validity,options) {
    const inferCategory=window.MercadorIA?.inferCategory;
    const passContexts=(pageData.passLines||[]).map((entry)=>{
      const prices=collectPassPrices(entry);
      return {entry,prices,fragments:buildTextFragments(entry.words||[],prices,pageData.canvasWidth)};
    });
    const prices=mergePricePasses(passContexts.map((ctx)=>ctx.prices));
    const fragments=buildTextFragments(pageData.words,prices,pageData.canvasWidth);
    const raw=[];

    prices.forEach((price,index)=>{
      const variants=[];
      let mergedProduct=productForPrice(price,fragments,prices,pageData.canvasWidth);
      if(mergedProduct){mergedProduct=expandProductDescription(mergedProduct,price,fragments,prices,pageData.canvasWidth);mergedProduct=completeOwnedProductDescription(mergedProduct,price,fragments,prices,pageData.canvasWidth);variants.push({...mergedProduct,descriptionPass:'merged'});}

      // Reavalia a descrição em cada passagem que realmente enxergou este preço. Isso evita
      // que o merge global escolha apenas a última linha ("Fatiado Seara") quando uma leitura
      // densa possui o nome completo ("Presunto Sem Capa ... Fatiado Seara Pacote 200g").
      (price.observations||[]).forEach((observation)=>{
        if(observation.pass==='color')return; // máscara cromática ajuda no preço, não na descrição.
        const ctx=passContexts.find((x)=>x.entry.pass===observation.pass);
        if(ctx?.entry?.priceOnly)return; // passagem monetária nunca fornece nome de produto.
        if(!ctx)return;
        let localPrice=ctx.prices.find((p)=>p===observation);
        if(!localPrice){
          const oc=center(observation.box);
          localPrice=ctx.prices.filter((p)=>Math.abs(Number(p.price)-Number(price.price))<.011).sort((a,b)=>{
            const ac=center(a.box),bc=center(b.box);
            return Math.hypot(ac.x-oc.x,ac.y-oc.y)-Math.hypot(bc.x-oc.x,bc.y-oc.y);
          })[0];
        }
        if(!localPrice)return;
        let local=productForPrice(localPrice,ctx.fragments,ctx.prices,pageData.canvasWidth);
        if(local){local=expandProductDescription(local,localPrice,ctx.fragments,ctx.prices,pageData.canvasWidth);local=completeOwnedProductDescription(local,localPrice,ctx.fragments,ctx.prices,pageData.canvasWidth);variants.push({...local,descriptionPass:observation.pass});}
      });

      const product=chooseProductDescriptionVariant(variants);
      if(!product||!product.productName||product.productName.length<3)return;
      if(isInstitutionalText(product.productName))return;
      const wordsCount=product.productName.split(/\s+/).filter(Boolean).length;
      if(wordsCount<1||product.semantic<.34)return;
      const packageText=extractPackage(product.productName);
      const quality=candidateConfidence({product,price,validity,packageText,wordsCount});
      const category=inferCategory?(inferCategory(product.productName)||'outros'):'outros';
      const sourceBoxCanvas=unionBoxes([product.productBox,price.box]);
      raw.push({
        id:`ocr-p${pageData.pageNumber}-${index}`,
        pageNumber:pageData.pageNumber,pageWidth:pageData.pageWidth,pageHeight:pageData.pageHeight,
        productName:product.productName,category,brand:'',packageText,
        price:price.price,previousPrice:null,detectedPrices:[price.price],priceKind:'general',requiresClub:false,clubName:'',clubSignal:false,
        conditions:validity?.condition||'',confidence:quality.confidence,riskFlags:quality.risks,evidence:quality.evidence,
        associationAgreement:product.spatial,
        ownershipConfidence:product.ownershipConfidence,
        clusterCoherence:Number(product.descriptionFidelity ?? product.semantic),
        descriptionCompleteness:Number(product.completeness ?? descriptionCompletenessScore(product.productName)),
        descriptionAgreement:Number(product.descriptionAgreement ?? 1),
        descriptionVariantCount:Number(product.descriptionVariantCount || 1),
        descriptionPass:product.descriptionPass || 'merged',
        knowledgeCardText:cleanText((product.selectedFragments||[]).map((x)=>x.fragment?.text||'').join(' ')),
        knowledgeOwnerConfidence:Number(product.ownershipConfidence||0),
        // Mantidos também para compatibilidade com versões intermediárias.
        domainOwnership:product.ownershipConfidence,blockCoherence:Number(product.descriptionFidelity ?? product.semantic),
        structuralSafe:quality.structuralSafe,automationSafe:quality.automationSafe,
        sourceBox:toSourceBox(sourceBoxCanvas,pageData.renderScale),startAt:validity?.startAt||null,endAt:validity?.endAt||null,
        verified:false,verificationMode:'',ignored:false,published:false,reviewed:false,
        extractionMode:'ocr-image-fallback',ocrConfidence:Number(((product.ocrConfidence+price.confidence)/2/100).toFixed(3)),
        ocrPricePasses:price.passCount,ocrPriceScale:Number(price.scale.toFixed(2)),ocrSemanticScore:Number(product.semantic.toFixed(3)),ocrDescriptionCompleteness:Number((product.completeness ?? descriptionCompletenessScore(product.productName)).toFixed(3)),ocrDescriptionAgreement:Number((product.descriptionAgreement ?? 1).toFixed(3))
      });
    });

    // Duplicatas do mesmo card/preço são descartadas. Candidatos semanticamente melhores vencem.
    const dedup=[];
    raw.sort((a,b)=>b.confidence-a.confidence||b.clusterCoherence-a.clusterCoherence).forEach((candidate)=>{
      const cb=candidate.sourceBox||{},ccx=(cb.x||0)+(cb.width||0)/2,ccy=(cb.y||0)+(cb.height||0)/2;
      const duplicate=dedup.some((x)=>{
        const xb=x.sourceBox||{},xcx=(xb.x||0)+(xb.width||0)/2,xcy=(xb.y||0)+(xb.height||0)/2;
        return Math.abs(Number(x.price)-Number(candidate.price))<.011&&Math.abs(xcx-ccx)<38&&Math.abs(xcy-ccy)<38&&productSimilarity(x.productName,candidate.productName)>=.52;
      });
      if(!duplicate)dedup.push(candidate);
    });
    return dedup;
  }

  function preprocessCanvas(source,mode='mild') {
    const canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=source.height;
    const ctx=canvas.getContext('2d',{alpha:false,willReadFrequently:true});ctx.drawImage(source,0,0);
    const image=ctx.getImageData(0,0,canvas.width,canvas.height),d=image.data;
    for(let i=0;i<d.length;i+=4){
      const r=d[i],g=d[i+1],b=d[i+2];
      const lum=.299*r+.587*g+.114*b;
      if(mode==='saturation'){
        const max=Math.max(r,g,b),min=Math.min(r,g,b),sat=(max-min)/Math.max(1,max);
        const keep=(sat>.34&&max<240)||(max<88);
        const v=keep?0:255;d[i]=d[i+1]=d[i+2]=v;d[i+3]=255;continue;
      }
      let v;
      if(mode==='strong'){
        v=(lum-128)*1.42+128;if(v>246)v=255;else if(v<24)v=0;
      }else{
        v=(lum-128)*1.16+128;if(v>251)v=255;else if(v<8)v=0;
      }
      v=clamp(Math.round(v),0,255);d[i]=d[i+1]=d[i+2]=v;d[i+3]=255;
    }
    ctx.putImageData(image,0,0);return canvas;
  }

  function cropCanvas(source,x0,y0,x1,y1) {
    const left=Math.max(0,Math.floor(x0)),top=Math.max(0,Math.floor(y0));
    const right=Math.min(source.width,Math.ceil(x1)),bottom=Math.min(source.height,Math.ceil(y1));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,right-left);canvas.height=Math.max(1,bottom-top);
    const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(source,left,top,canvas.width,canvas.height,0,0,canvas.width,canvas.height);
    return {canvas,offsetX:left,offsetY:top};
  }

  async function recognizePass(worker,canvas,{pass,psm='11',offsetX=0,offsetY=0}={}) {
    await worker.setParameters({preserve_interword_spaces:'1',tessedit_pageseg_mode:String(psm),tessedit_char_whitelist:''}).catch(()=>{});
    const result=await worker.recognize(canvas);
    const words=normalizeOcrWords(result.data,{pass,offsetX,offsetY});
    const lines=segmentRows(words);
    return {pass,words,lines,text:cleanText(result.data?.text||lines.map((x)=>x.text).join(' ')),medianWordHeight:median(words.map((w)=>w.height))||16,priceOnly:false};
  }

  async function recognizePricePass(worker,canvas,{pass,psm='11',offsetX=0,offsetY=0}={}) {
    await worker.setParameters({
      preserve_interword_spaces:'1',
      tessedit_pageseg_mode:String(psm),
      tessedit_char_whitelist:'R$0123456789,. '
    }).catch(()=>{});
    const result=await worker.recognize(canvas);
    const words=normalizeOcrWords(result.data,{pass,offsetX,offsetY});
    const lines=segmentRows(words);
    // Limpa a whitelist imediatamente: nenhuma leitura textual posterior herda o modo de preço.
    await worker.setParameters({tessedit_char_whitelist:''}).catch(()=>{});
    return {pass,words,lines,text:cleanText(result.data?.text||lines.map((x)=>x.text).join(' ')),medianWordHeight:median(words.map((w)=>w.height))||16,priceOnly:true};
  }


  function splitNativeTextItem(item,pdfjsLib,viewport,pass='native') {
    const text=cleanText(item?.str||'');
    if(!text)return [];
    let tx;
    try{tx=pdfjsLib.Util.transform(viewport.transform,item.transform);}catch(_){tx=[1,0,0,1,0,0];}
    const fontHeight=Math.max(1,Math.hypot(Number(tx[2]||0),Number(tx[3]||0))||Math.abs(Number(item.height||0)*viewport.scale)||10);
    const totalWidth=Math.max(1,Math.abs(Number(item.width||0)*viewport.scale)||text.length*fontHeight*.48);
    const x0=Number(tx[4]||0),baselineY=Number(tx[5]||fontHeight),y0=baselineY-fontHeight,y1=baselineY;
    const tokens=[...text.matchAll(/\S+/g)];
    if(!tokens.length)return [];
    const charTotal=Math.max(1,text.length);
    return tokens.map((match,index)=>{
      const start=match.index||0,end=start+match[0].length;
      const left=x0+totalWidth*(start/charTotal),right=x0+totalWidth*(end/charTotal);
      return {id:`${pass}-${index}-${start}`,pass,text:cleanText(match[0]),confidence:100,x0:left,y0,x1:Math.max(left+1,right),y1,width:Math.max(1,right-left),height:fontHeight,passNames:new Set([pass]),passCount:1};
    });
  }

  async function analyzeNativeKnowledge(file,onProgress) {
    const pdfjsLib=await loadPdfJs();
    const bytes=await file.arrayBuffer();
    const pdf=await pdfjsLib.getDocument({data:bytes,cMapUrl:`${PDFJS_BASE}/cmaps/`,cMapPacked:true,standardFontDataUrl:`${PDFJS_BASE}/standard_fonts/`,wasmUrl:`${PDFJS_BASE}/wasm/`}).promise;
    const pages=[],documentTexts=[];
    for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber+=1){
      if(onProgress)onProgress({pageNumber,numPages:pdf.numPages,percent:Math.round(((pageNumber-1)/Math.max(1,pdf.numPages))*18),mode:'knowledge-native'});
      const page=await pdf.getPage(pageNumber);
      const baseViewport=page.getViewport({scale:1});
      const renderScale=2.25;
      const viewport=page.getViewport({scale:renderScale});
      const textContent=await page.getTextContent({normalizeWhitespace:false,disableCombineTextItems:false});
      const words=[];
      (textContent.items||[]).forEach((item,index)=>{
        splitNativeTextItem(item,pdfjsLib,viewport,`native-${pageNumber}-${index}`).forEach((word)=>words.push(word));
      });
      const lines=segmentRows(words);
      const text=cleanText(lines.map((x)=>x.text).join(' '));
      const entry={pass:'native',words,lines,text,medianWordHeight:median(words.map((w)=>w.height))||16};
      const prices=collectPassPrices(entry);
      const usefulWords=words.filter((w)=>!isInstitutionalText(w.text));
      const expectedFloor=Math.round(clamp(usefulWords.length/10.5,2,34));
      pages.push({pageNumber,pageWidth:baseViewport.width,pageHeight:baseViewport.height,canvasWidth:viewport.width,canvasHeight:viewport.height,renderScale,words,lines,text,passLines:[entry],priceCoverageCount:prices.length,expectedPriceFloor:expectedFloor,coveragePasses:0,knowledgeMode:'native'});
      documentTexts.push(text);
    }
    return {pages,documentText:documentTexts.join(' '),numPages:pdf.numPages};
  }

  function knowledgePageNeedsOcr(page) {
    const words=page?.words?.length||0;
    const textChars=String(page?.text||'').replace(/\s+/g,'').length;
    const prices=Number(page?.priceCoverageCount||0);
    const expected=Math.max(2,Number(page?.expectedPriceFloor||2));
    return words<28 || textChars<140 || prices<Math.min(5,Math.ceil(expected*.5));
  }

  function mergeKnowledgePages(nativePage,ocrPage) {
    if(!nativePage)return ocrPage;
    if(!ocrPage)return nativePage;
    const passLines=[...(nativePage.passLines||[]),...(ocrPage.passLines||[])];
    const textPasses=passLines.filter((p)=>p.pass!=='color'&&!p.priceOnly);
    const words=mergeOcrWords(textPasses.map((p)=>p.words||[]));
    const lines=segmentRows(words);
    const text=cleanText([...new Set(textPasses.map((p)=>p.text||'').filter(Boolean))].join(' '));
    const prices=mergePricePasses(passLines.map((entry)=>collectPassPrices(entry)));
    return {...ocrPage,...nativePage,canvasWidth:ocrPage.canvasWidth||nativePage.canvasWidth,canvasHeight:ocrPage.canvasHeight||nativePage.canvasHeight,renderScale:ocrPage.renderScale||nativePage.renderScale,words,lines,text,passLines,priceCoverageCount:prices.length,expectedPriceFloor:Math.max(Number(nativePage.expectedPriceFloor||0),Number(ocrPage.expectedPriceFloor||0)),coveragePasses:Number(ocrPage.coveragePasses||0),knowledgeMode:'hybrid'};
  }

  function serializableWord(word) {
    return {id:word.id||'',text:word.text||'',normalized:fold(word.text||''),confidence:Number(word.confidence||0),bbox:{x:Number(word.x0||0),y:Number(word.y0||0),width:Number(word.width||Math.max(0,Number(word.x1||0)-Number(word.x0||0))),height:Number(word.height||Math.max(0,Number(word.y1||0)-Number(word.y0||0)))},sources:[...(word.passNames||new Set([word.pass||'unknown']))]};
  }

  function serializableLine(line) {
    return {text:line.text||'',confidence:Number(line.confidence||0),bbox:line.box?{x:Number(line.box.x0||0),y:Number(line.box.y0||0),width:Number(line.box.width||0),height:Number(line.box.height||0)}:null,wordIds:(line.words||[]).map((w)=>w.id||'').filter(Boolean)};
  }

  function knowledgePriceFacts(page) {
    return mergePricePasses((page.passLines||[]).map((entry)=>collectPassPrices(entry))).map((price)=>({value:Number(price.price),text:price.text||'',confidence:Number(price.confidence||0),currencyExplicit:price.explicitCurrency===true,pattern:price.pattern||'',passes:Number(price.passCount||1),bbox:price.box?{x:Number(price.box.x0||0),y:Number(price.box.y0||0),width:Number(price.box.width||0),height:Number(price.box.height||0)}:null}));
  }

  function buildKnowledgeDocument(file,hash,pages,validity,candidates,legacyResult) {
    const modes=[...new Set(pages.map((p)=>p.knowledgeMode||'unknown'))];
    const documentText=cleanText(pages.map((p)=>p.text||'').join(' '));
    return {
      schemaVersion:KNOWLEDGE_SCHEMA_VERSION,
      engineVersion:OCR_ENGINE_VERSION,
      generatedAt:new Date().toISOString(),
      source:{fileName:file.name||'',mimeType:file.type||'application/pdf',size:Number(file.size||0),sha256:hash||'',numPages:pages.length},
      extraction:{modes,pdfjsVersion:PDFJS_VERSION,tesseractVersion:TESSERACT_VERSION,legacyValidator:legacyResult?.engineVersion||base.ENGINE_VERSION||'2.2.0'},
      validity:validity||null,
      documentText,
      pages:pages.map((page)=>({pageNumber:page.pageNumber,width:Number(page.pageWidth||0),height:Number(page.pageHeight||0),mode:page.knowledgeMode||'unknown',text:page.text||'',metrics:{words:page.words?.length||0,lines:page.lines?.length||0,pricesDetected:Number(page.priceCoverageCount||0),expectedPriceFloor:Number(page.expectedPriceFloor||0),coveragePasses:Number(page.coveragePasses||0)},words:(page.words||[]).map(serializableWord),lines:(page.lines||[]).map(serializableLine),prices:knowledgePriceFacts(page)})),
      promotionFacts:(candidates||[]).map((c)=>({id:c.id,pageNumber:c.pageNumber,productName:c.productName,category:c.category||'outros',packageText:c.packageText||'',price:Number(c.price||0),previousPrice:Number(c.previousPrice||0)||null,priceKind:c.priceKind||'general',conditions:c.conditions||'',confidence:Number(c.confidence||0),riskFlags:[...(c.riskFlags||[])],evidence:[...(c.evidence||[])],bbox:c.sourceBox||null,sourceCardText:c.knowledgeCardText||'',ownerConfidence:Number(c.knowledgeOwnerConfidence||c.ownershipConfidence||0),descriptionCompleteness:Number(c.descriptionCompleteness||0),descriptionAgreement:Number(c.descriptionAgreement||0),knowledgeMode:c.knowledgeMode||c.extractionMode||''}))
    };
  }

  async function sha256Hex(file) {
    try{
      const bytes=await file.arrayBuffer();
      const hash=await crypto.subtle.digest('SHA-256',bytes);
      return [...new Uint8Array(hash)].map((b)=>b.toString(16).padStart(2,'0')).join('');
    }catch(_){return '';}
  }

  function sourceBoxCenter(candidate){const b=candidate?.sourceBox;if(!b)return null;return {x:Number(b.x||0)+Number(b.width||0)/2,y:Number(b.y||0)+Number(b.height||0)/2};}

  function mergeCandidateEngines(knowledgeCandidates,legacyCandidates) {
    const result=knowledgeCandidates.map((x)=>({...x,knowledgeMode:x.knowledgeMode||x.extractionMode||'knowledge-json'}));
    (legacyCandidates||[]).forEach((legacy)=>{
      const lc=sourceBoxCenter(legacy);
      let bestIndex=-1,bestScore=0;
      result.forEach((candidate,index)=>{
        if(Number(candidate.pageNumber||0)!==Number(legacy.pageNumber||0))return;
        if(Math.abs(Number(candidate.price||0)-Number(legacy.price||0))>.011)return;
        const kc=sourceBoxCenter(candidate);
        const distance=(lc&&kc)?Math.hypot(lc.x-kc.x,lc.y-kc.y):Infinity;
        const nameScore=productSimilarity(candidate.productName,legacy.productName);
        const positionScore=Number.isFinite(distance)?clamp(1-distance/150,0,1):0;
        const score=Math.max(nameScore,positionScore*.72+nameScore*.28);
        if(score>bestScore){bestScore=score;bestIndex=index;}
      });
      if(bestIndex>=0&&bestScore>=.38){
        const current=result[bestIndex];
        const similarity=productSimilarity(current.productName,legacy.productName);
        const currentCompleteness=descriptionCompletenessScore(current.productName);
        const legacyCompleteness=descriptionCompletenessScore(legacy.productName);
        const conflict=similarity<.20&&current.productName&&legacy.productName;
        const risks=new Set([...(current.riskFlags||[]),...(legacy.riskFlags||[])]);
        if(conflict)risks.add('knowledge_legacy_description_conflict');
        const evidence=new Set([...(current.evidence||[]),...(legacy.evidence||[])]);
        evidence.add(conflict?'JSON de conhecimento e motor legado discordam na descrição':'JSON de conhecimento validado por segunda leitura independente');
        const useLegacy=!conflict&&legacyCompleteness>currentCompleteness+.14;
        result[bestIndex]={...legacy,...current,productName:useLegacy?legacy.productName:current.productName,packageText:useLegacy?(legacy.packageText||current.packageText):current.packageText,riskFlags:[...risks],evidence:[...evidence],confidence:conflict?Math.min(Number(current.confidence||0),Number(legacy.confidence||0),.89):Math.min(1,Math.max(Number(current.confidence||0),Number(legacy.confidence||0))+.01),automationSafe:!conflict&&(current.automationSafe===true||legacy.automationSafe===true),structuralSafe:!conflict&&(current.structuralSafe===true||legacy.structuralSafe===true),knowledgeMode:'knowledge-json-validated',extractionMode:'knowledge-json-validated'};
      }else{
        result.push({...legacy,evidence:[...(legacy.evidence||[]),'Mantido pelo motor PDF anterior para compatibilidade sem regressão'],knowledgeMode:'legacy-compatibility',extractionMode:legacy.extractionMode||'legacy-compatibility'});
      }
    });
    const dedup=[];
    result.sort((a,b)=>Number(b.confidence||0)-Number(a.confidence||0)).forEach((candidate)=>{
      const cc=sourceBoxCenter(candidate);
      const duplicate=dedup.some((x)=>{
        if(Number(x.pageNumber||0)!==Number(candidate.pageNumber||0))return false;
        if(Math.abs(Number(x.price||0)-Number(candidate.price||0))>.011)return false;
        const xc=sourceBoxCenter(x);
        const pos=cc&&xc?Math.hypot(cc.x-xc.x,cc.y-xc.y)<45:false;
        return pos&&productSimilarity(x.productName,candidate.productName)>=.45;
      });
      if(!duplicate)dedup.push(candidate);
    });
    return dedup;
  }

  function recoveryBlockText(fragment) {
    return polishProductText(fragment?.text||'');
  }

  function buildRecoveryBlocks(words,pageWidth,pageHeight) {
    const fragments=buildTextFragments(words||[],[],pageWidth).filter((fragment)=>{
      const text=recoveryBlockText(fragment);
      if(!text||isInstitutionalText(text))return false;
      const semantic=productSemanticScore(text,fragment.confidence||0);
      const completeness=descriptionCompletenessScore(text);
      return semantic>=.24||completeness>=.34||Boolean(extractPackage(text));
    });
    const blocks=[];
    [...fragments].sort((a,b)=>a.box.y0-b.box.y0||a.box.x0-b.box.x0).forEach((fragment)=>{
      const fc=center(fragment.box);
      let best=null,bestScore=-Infinity;
      blocks.forEach((block)=>{
        const bb=block.box,bc=center(bb);
        const overlap=overlap1d(fragment.box.x0,fragment.box.x1,bb.x0,bb.x1);
        const overlapRatio=overlap/Math.max(1,Math.min(fragment.box.width,bb.width));
        const centerDx=Math.abs(fc.x-bc.x);
        const vGap=Math.max(0,fragment.box.y0-bb.y1,bb.y0-fragment.box.y1);
        const sameColumn=overlapRatio>=.18||centerDx<=Math.max(58,Math.min(fragment.box.width,bb.width)*.62);
        if(!sameColumn||vGap>Math.max(64,pageHeight*.026))return;
        // Evita colar dois títulos fortes lado a lado ou em cards adjacentes.
        const score=overlapRatio*100-centerDx*.12-vGap*.75;
        if(score>bestScore){best=block;bestScore=score;}
      });
      if(!best){blocks.push({fragments:[fragment],box:{...fragment.box}});return;}
      best.fragments.push(fragment);best.box=unionBoxes(best.fragments.map((x)=>x.box));
    });

    return blocks.map((block,index)=>{
      const ordered=[...block.fragments].sort((a,b)=>a.box.y0-b.box.y0||a.box.x0-b.box.x0);
      const text=polishProductText(ordered.map((x)=>x.text).join(' '));
      const confidence=ordered.reduce((sum,x)=>sum+Number(x.confidence||0),0)/Math.max(1,ordered.length);
      return {id:index,text,box:block.box,confidence,semantic:productSemanticScore(text,confidence),completeness:descriptionCompletenessScore(text)};
    }).filter((block)=>{
      if(!block.text||block.text.length<3||isInstitutionalText(block.text))return false;
      const count=block.text.split(/\s+/).filter(Boolean).length;
      if(count>18)return false;
      return block.semantic>=.32||block.completeness>=.40||Boolean(extractPackage(block.text));
    });
  }

  function nearbyPriceForRecoveryBlock(block,prices,pageWidth,pageHeight) {
    const bc=center(block.box);
    let best=null,bestCost=Infinity;
    (prices||[]).forEach((price)=>{
      const pc=center(price.box);
      const horizontal=rangeDistance(pc.x,block.box.x0-22,block.box.x1+22);
      const above=price.box.y0-block.box.y1;
      const below=block.box.y0-price.box.y1;
      if(above>Math.max(230,pageHeight*.105)||below>Math.max(70,pageHeight*.03))return;
      const vertical=above>=0?above*.62:(below>=0?below*1.8:Math.abs(pc.y-bc.y)*.36);
      const cost=horizontal*1.2+vertical+Math.abs(pc.x-bc.x)*.045;
      if(cost<bestCost){best={price,cost};bestCost=cost;}
    });
    return best&&best.cost<=Math.max(145,pageWidth*.072)?best:null;
  }

  function recoveryCropForBlock(block,blocks,pageWidth,pageHeight) {
    const bc=center(block.box);
    const rowTol=Math.max(105,pageHeight*.045),colTol=Math.max(150,pageWidth*.085);
    const left=[...blocks].filter((b)=>b!==block&&Math.abs(center(b.box).y-bc.y)<=rowTol&&center(b.box).x<bc.x).sort((a,b)=>center(b.box).x-center(a.box).x)[0];
    const right=[...blocks].filter((b)=>b!==block&&Math.abs(center(b.box).y-bc.y)<=rowTol&&center(b.box).x>bc.x).sort((a,b)=>center(a.box).x-center(b.box).x)[0];
    const above=[...blocks].filter((b)=>b!==block&&Math.abs(center(b.box).x-bc.x)<=colTol&&center(b.box).y<bc.y).sort((a,b)=>center(b.box).y-center(a.box).y)[0];
    const below=[...blocks].filter((b)=>b!==block&&Math.abs(center(b.box).x-bc.x)<=colTol&&center(b.box).y>bc.y).sort((a,b)=>center(a.box).y-center(b.box).y)[0];
    let x0=left?(center(left.box).x+bc.x)/2:block.box.x0-Math.max(70,block.box.width*.42);
    let x1=right?(center(right.box).x+bc.x)/2:block.box.x1+Math.max(95,block.box.width*.55);
    let y0=above?(center(above.box).y+bc.y)/2:block.box.y0-Math.max(42,pageHeight*.018);
    const naturalBottom=block.box.y1+Math.max(125,pageHeight*.055);
    let y1=below?Math.min((center(below.box).y+bc.y)/2,naturalBottom):naturalBottom;
    // O preço pode ficar na lateral do nome; garante margem mínima sem invadir o card vizinho.
    x0=Math.min(x0,block.box.x0-26);x1=Math.max(x1,block.box.x1+34);
    y0=Math.min(y0,block.box.y0-24);y1=Math.max(y1,block.box.y1+72);
    return {x0:clamp(x0,0,pageWidth),y0:clamp(y0,0,pageHeight),x1:clamp(x1,0,pageWidth),y1:clamp(y1,0,pageHeight)};
  }

  async function recoverCardPasses(worker,mild,strong,baseWords,basePrices,pageNumber,onProgressLocal) {
    const blocks=buildRecoveryBlocks(baseWords,mild.width,mild.height);
    const queue=blocks.map((block)=>{
      const known=nearbyPriceForRecoveryBlock(block,basePrices,mild.width,mild.height);
      const weakText=block.completeness<.70||block.semantic<.64;
      return {block,known,priority:(known?0:100)+(weakText?35:0)+Math.round((1-block.completeness)*20)};
    }).filter((x)=>!x.known||x.block.completeness<.72||x.block.semantic<.62)
      .sort((a,b)=>b.priority-a.priority)
      .slice(0,26);
    const recovered=[];
    for(let i=0;i<queue.length;i+=1){
      const {block,known}=queue[i];
      const box=recoveryCropForBlock(block,blocks,strong.width,strong.height);
      if(box.x1-box.x0<40||box.y1-box.y0<35)continue;
      const crop=cropCanvas(strong,box.x0,box.y0,box.x1,box.y1);
      if(onProgressLocal)onProgressLocal(i,queue.length,'text');
      const textPass=await recognizePass(worker,crop.canvas,{pass:`card${pageNumber}-${i+1}`,psm:'6',offsetX:crop.offsetX,offsetY:crop.offsetY});
      recovered.push(textPass);
      const localPrices=collectPassPrices(textPass);
      // Se o card não tinha preço global e a leitura textual ainda não o encontrou, uma segunda
      // passagem restrita a caracteres monetários recupera o preço sem contaminar a descrição.
      if(!known&&!localPrices.length){
        if(onProgressLocal)onProgressLocal(i,queue.length,'price');
        const pricePass=await recognizePricePass(worker,crop.canvas,{pass:`pricecard${pageNumber}-${i+1}`,psm:'11',offsetX:crop.offsetX,offsetY:crop.offsetY});
        recovered.push(pricePass);
      }
      crop.canvas.width=crop.canvas.height=1;
    }
    return {passes:recovered,blocks:blocks.length,recovered:queue.length};
  }

  async function analyzeImagePdf(file,options,onProgress) {
    const [pdfjsLib,Tesseract]=await Promise.all([loadPdfJs(),loadTesseract()]);
    const arrayBuffer=await file.arrayBuffer();
    const pdf=await pdfjsLib.getDocument({data:arrayBuffer,cMapUrl:`${PDFJS_BASE}/cmaps/`,cMapPacked:true,standardFontDataUrl:`${PDFJS_BASE}/standard_fonts/`,wasmUrl:`${PDFJS_BASE}/wasm/`}).promise;

    let currentPage=1,progressBase=0,progressWeight=1;
    const worker=await Tesseract.createWorker('por',1,{logger:(m)=>{
      if(m?.status==='recognizing text'&&Number.isFinite(m.progress)&&onProgress){
        const pageFraction=(currentPage-1+(progressBase+m.progress*progressWeight))/pdf.numPages;
        onProgress({pageNumber:currentPage,numPages:pdf.numPages,percent:Math.round(clamp(pageFraction*100,0,99)),mode:'ocr'});
      }
    }});

    try{
      const pages=[],documentTexts=[];
      for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber+=1){
        currentPage=pageNumber;if(onProgress)onProgress({pageNumber,numPages:pdf.numPages,percent:Math.round((pageNumber-1)/pdf.numPages*100),mode:'ocr'});
        const page=await pdf.getPage(pageNumber),baseViewport=page.getViewport({scale:1});
        const targetWidth=Math.min(2500,Math.max(1900,baseViewport.width*3.45));
        const renderScale=targetWidth/baseViewport.width,viewport=page.getViewport({scale:renderScale});
        const source=document.createElement('canvas');source.width=Math.ceil(viewport.width);source.height=Math.ceil(viewport.height);
        const ctx=source.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,source.width,source.height);await page.render({canvasContext:ctx,viewport}).promise;
        const mild=preprocessCanvas(source,'mild');
        const strong=preprocessCanvas(source,'strong');
        const saturation=preprocessCanvas(source,'saturation');
        const passes=[];

        progressBase=0;progressWeight=.34;
        passes.push(await recognizePass(worker,mild,{pass:'layout',psm:'11'}));

        // Segunda leitura independente usa segmentação automática para recuperar linhas corridas.
        progressBase=.34;progressWeight=.27;
        passes.push(await recognizePass(worker,strong,{pass:'dense',psm:'3'}));

        // Terceira leitura é focada em texto destacado/cores. Ela aumenta muito a recuperação de
        // preços estilizados sem contaminar a descrição do produto.
        progressBase=.61;progressWeight=.27;
        passes.push(await recognizePass(worker,saturation,{pass:'color',psm:'11'}));

        let preliminary=mergePricePasses(passes.map((entry)=>collectPassPrices(entry)));

        // COBERTURA ADAPTATIVA DE ENCARTE VISUAL
        // Um encarte denso pode ter 20-30 cards por página. OCR de página inteira frequentemente
        // enxerga só os textos maiores. Em vez de aceitar essa subdetecção, fazemos uma segunda
        // cobertura por regiões. Os recortes se sobrepõem e são consolidados por coordenadas,
        // portanto aumentam recall sem publicar duplicatas.
        const mergedInitialWords=mergeOcrWords(passes.filter((p)=>p.pass!=='color').map((p)=>p.words));
        const usefulInitialWords=mergedInitialWords.filter((w)=>!isInstitutionalText(w.text));
        const expectedFloor=Math.round(clamp(usefulInitialWords.length/9.5,10,28));
        const richPage=mergedInitialWords.length>=55;
        const needsVerticalCoverage=richPage&&(preliminary.length<18||preliminary.length<expectedFloor);
        let coveragePasses=0;

        if(needsVerticalCoverage){
          const strips=5,overlap=Math.round(mild.width*.035);
          for(let i=0;i<strips;i+=1){
            const x0=Math.max(0,Math.round(i*mild.width/strips)-overlap),x1=Math.min(mild.width,Math.round((i+1)*mild.width/strips)+overlap);
            const crop=cropCanvas(mild,x0,0,x1,mild.height);
            progressBase=.88+i*(.065/strips);progressWeight=.065/strips;
            const pass=await recognizePass(worker,crop.canvas,{pass:`vstrip${i+1}`,psm:'11',offsetX:crop.offsetX,offsetY:crop.offsetY});
            passes.push(pass);coveragePasses+=1;crop.canvas.width=crop.canvas.height=1;
          }
          preliminary=mergePricePasses(passes.map((entry)=>collectPassPrices(entry)));
        }

        // Se a varredura vertical ainda estiver abaixo da densidade textual esperada, fazemos
        // faixas horizontais. Isso cobre layouts mistos (ex.: duas colunas grandes + grade de 3 colunas)
        // sem assumir um modelo específico de supermercado.
        const mergedAfterVertical=mergeOcrWords(passes.filter((p)=>p.pass!=='color').map((p)=>p.words));
        const horizontalFloor=Math.max(16,Math.round(expectedFloor*.88));
        const needsHorizontalCoverage=richPage&&preliminary.length<horizontalFloor&&mergedAfterVertical.length>=70;
        if(needsHorizontalCoverage){
          const bands=3,overlap=Math.round(strong.height*.028);
          for(let i=0;i<bands;i+=1){
            const y0=Math.max(0,Math.round(i*strong.height/bands)-overlap),y1=Math.min(strong.height,Math.round((i+1)*strong.height/bands)+overlap);
            const crop=cropCanvas(strong,0,y0,strong.width,y1);
            progressBase=.945+i*(.045/bands);progressWeight=.045/bands;
            const pass=await recognizePass(worker,crop.canvas,{pass:`hband${i+1}`,psm:'11',offsetX:crop.offsetX,offsetY:crop.offsetY});
            passes.push(pass);coveragePasses+=1;crop.canvas.width=crop.canvas.height=1;
          }
          preliminary=mergePricePasses(passes.map((entry)=>collectPassPrices(entry)));
        }

        // RECUPERAÇÃO POR CARD: usa os blocos textuais já enxergados para recortar somente os
        // cards que perderam preço ou nome completo. Isso evita misturar colunas e recupera ofertas
        // sem executar OCR pesado em todos os cards.
        const baseTextPasses=passes.filter((p)=>p.pass!=='color'&&!p.priceOnly);
        const recoveryWords=mergeOcrWords(baseTextPasses.map((p)=>p.words));
        preliminary=mergePricePasses(passes.map((entry)=>collectPassPrices(entry)));
        const recovery=await recoverCardPasses(worker,mild,strong,recoveryWords,preliminary,pageNumber,(idx,total,kind)=>{
          if(!onProgress||!total)return;
          const frac=(idx+(kind==='price'?.55:.15))/total;
          onProgress({pageNumber,numPages:pdf.numPages,percent:Math.round(clamp(((pageNumber-1)/pdf.numPages+(0.86+frac*.12)/pdf.numPages)*100,0,99)),mode:'ocr-card-recovery'});
        });
        recovery.passes.forEach((p)=>passes.push(p));
        preliminary=mergePricePasses(passes.map((entry)=>collectPassPrices(entry)));

        const textPasses=passes.filter((p)=>p.pass!=='color'&&!p.priceOnly);
        const words=mergeOcrWords(textPasses.map((p)=>p.words));
        const lines=segmentRows(words);
        // Validade e condições usam apenas passagens textuais; a máscara cromática serve só ao preço.
        const pageText=cleanText([...new Set(textPasses.map((p)=>p.text).filter(Boolean))].join(' '));
        documentTexts.push(pageText);
        pages.push({pageNumber,pageWidth:baseViewport.width,pageHeight:baseViewport.height,canvasWidth:mild.width,canvasHeight:mild.height,renderScale,words,lines,text:pageText,passLines:passes.map((p)=>({pass:p.pass,words:p.words,lines:p.lines,medianWordHeight:p.medianWordHeight})),priceCoverageCount:preliminary.length,expectedPriceFloor:expectedFloor,coveragePasses,recoveryBlocks:recovery.blocks,recoveryCards:recovery.recovered});
        source.width=source.height=1;mild.width=mild.height=1;strong.width=strong.height=1;saturation.width=saturation.height=1;
      }

      const documentText=documentTexts.join(' '),validity=(Number(options?.suppliedStartAt)>0&&Number(options?.suppliedEndAt)>Number(options?.suppliedStartAt))?{startAt:Number(options.suppliedStartAt),endAt:Number(options.suppliedEndAt),raw:'validade informada pelo administrador',condition:'',inferred:false,provided:true}:enrichValidity(documentText,file.name);
      const candidates=pages.flatMap((page)=>buildOcrCandidates(page,validity,options));
      if(onProgress)onProgress({pageNumber:pdf.numPages,numPages:pdf.numPages,percent:100,mode:'ocr'});
      return {validity,candidates,documentText,numPages:pdf.numPages,pages,ocrPages:pages.map((p)=>({pageNumber:p.pageNumber,words:p.words.length,lines:p.lines.length,passes:p.passLines.length,pricesDetected:p.priceCoverageCount,expectedFloor:p.expectedPriceFloor,coveragePasses:p.coveragePasses,recoveryBlocks:Number(p.recoveryBlocks||0),recoveryCards:Number(p.recoveryCards||0)}))};
    }finally{await worker.terminate().catch(()=>{});}
  }

  async function analyzeFile(file,options={},onProgress) {
    const hashPromise=sha256Hex(file);
    if(onProgress)onProgress({pageNumber:1,numPages:1,percent:1,mode:'knowledge-json'});

    // 1) O PDF vira primeiro um documento canônico de conhecimento. A extração comercial
    // acontece somente depois dessa camada, independentemente de o PDF ser textual, híbrido ou imagem.
    const nativeKnowledge=await analyzeNativeKnowledge(file,onProgress);
    let pages=nativeKnowledge.pages;
    const sparsePages=pages.filter(knowledgePageNeedsOcr).map((p)=>p.pageNumber);
    let ocrResult=null;

    // 2) OCR não substitui o texto nativo: ele complementa somente quando a página não trouxe
    // cobertura suficiente. Em PDF híbrido, as duas evidências permanecem no mesmo JSON.
    if(sparsePages.length){
      if(onProgress)onProgress({pageNumber:sparsePages[0],numPages:nativeKnowledge.numPages,percent:19,mode:'knowledge-ocr'});
      ocrResult=await analyzeImagePdf(file,options,(progress)=>{
        if(!onProgress)return;
        onProgress({...progress,percent:Math.round(20+Number(progress.percent||0)*.62),mode:'knowledge-ocr'});
      });
      const ocrByPage=new Map((ocrResult.pages||[]).map((p)=>[Number(p.pageNumber),p]));
      pages=pages.map((nativePage)=>sparsePages.includes(nativePage.pageNumber)?mergeKnowledgePages(nativePage,ocrByPage.get(nativePage.pageNumber)):nativePage);
    }

    const documentText=cleanText(pages.map((p)=>p.text||'').join(' '));
    const validity=(Number(options?.suppliedStartAt)>0&&Number(options?.suppliedEndAt)>Number(options?.suppliedStartAt))?{startAt:Number(options.suppliedStartAt),endAt:Number(options.suppliedEndAt),raw:'validade informada pelo administrador',condition:'',inferred:false,provided:true}:enrichValidity(documentText,file.name);
    const knowledgeCandidates=pages.flatMap((page)=>buildOcrCandidates(page,validity,options));

    // 3) O motor anterior não é removido. Ele passa a atuar como validador independente e
    // caminho de compatibilidade para não regredir PDFs que já funcionavam bem.
    if(onProgress)onProgress({pageNumber:1,numPages:nativeKnowledge.numPages,percent:84,mode:'legacy-validator'});
    const legacyResult=await originalAnalyzeFile(file,options,(progress)=>{
      if(!onProgress)return;
      onProgress({...progress,percent:Math.round(84+Number(progress.percent||0)*.13),mode:'legacy-validator'});
    });
    const candidates=mergeCandidateEngines(knowledgeCandidates,legacyResult.candidates||[]);
    const hash=(await hashPromise)||legacyResult.hash||'';
    const knowledgeDocument=buildKnowledgeDocument(file,hash,pages,validity,candidates,legacyResult);
    const modes=knowledgeDocument.extraction.modes;
    const extractionMode=modes.includes('hybrid')?'knowledge-json-hybrid':(modes.includes('native')&&!ocrResult?'knowledge-json-native':'knowledge-json-ocr');

    if(onProgress)onProgress({pageNumber:nativeKnowledge.numPages,numPages:nativeKnowledge.numPages,percent:100,mode:'knowledge-json'});
    const result={...legacyResult,fileName:legacyResult.fileName||file.name,hash,numPages:nativeKnowledge.numPages,validity:validity?.startAt?validity:(legacyResult.validity||validity),candidates,engineVersion:OCR_ENGINE_VERSION,extractionMode,knowledgeSchemaVersion:KNOWLEDGE_SCHEMA_VERSION,knowledgeDocument,knowledgeMetrics:{pages:pages.length,modes,words:pages.reduce((s,p)=>s+(p.words?.length||0),0),lines:pages.reduce((s,p)=>s+(p.lines?.length||0),0),prices:pages.reduce((s,p)=>s+knowledgePriceFacts(p).length,0),candidates:candidates.length},ocrEngine:ocrResult?`tesseract.js-${TESSERACT_VERSION}`:'',ocrPages:ocrResult?.ocrPages||[]};
    window.MercadorPDFImporter.lastKnowledgeDocument=knowledgeDocument;
    return result;
  }

  function downloadKnowledgeJson(knowledgeDocument,fileName='encarte') {
    const data=knowledgeDocument||window.MercadorPDFImporter?.lastKnowledgeDocument;
    if(!data)throw new Error('Nenhum JSON de conhecimento disponível. Analise um encarte primeiro.');
    const safe=String(fileName||'encarte').replace(/\.pdf$/i,'').replace(/[^a-z0-9._-]+/gi,'_');
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=`${safe}.mercador-knowledge.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  window.MercadorPDFImporter={...base,ENGINE_VERSION:OCR_ENGINE_VERSION,KNOWLEDGE_SCHEMA_VERSION,analyzeFile,downloadKnowledgeJson,getLastKnowledgeDocument:()=>window.MercadorPDFImporter.lastKnowledgeDocument||null,lastKnowledgeDocument:null};
})();
