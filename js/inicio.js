(function(){
  'use strict';
  const M=window.MercadorIA;
  const {auth,db}=M;
  const els={
    shell:document.getElementById('homeShell'),boot:document.getElementById('bootState'),logout:document.getElementById('logoutBtn'),welcome:document.getElementById('welcomeTitle'),
    pending:document.getElementById('pendingCount'),bought:document.getElementById('boughtCount'),deferred:document.getElementById('deferredCount'),total:document.getElementById('cartTotal'),
    radius:document.getElementById('radiusChip'),locationBtn:document.getElementById('locationBtn'),status:document.getElementById('offersStatus'),list:document.getElementById('offerList'),all:document.getElementById('allOffersLink')
  };
  const state={user:null,profile:null,items:[],radiusKm:5,loadingOffers:false};
  const normalizeItem=(raw,id)=>({id,nome:raw?.nome||raw?.name||'',status:raw?.status||'faltando',quantidade:Number(raw?.quantidade??raw?.quantity??1),preco:Number(raw?.preco??raw?.price??0)});

  function loadCachedList(uid){
    try{
      const raw=localStorage.getItem(`mercadorIA:list-cache:${uid}`);
      const parsed=raw?JSON.parse(raw):null;
      if(!parsed||!Array.isArray(parsed.items))return false;
      state.items=parsed.items.map((item)=>normalizeItem(item,item.id));
      renderStats();
      return true;
    }catch(_){return false;}
  }
  function reveal(){els.boot.hidden=true;els.shell.hidden=false;}
  function firstName(name){return String(name||'').trim().split(/\s+/)[0]||'';}
  function renderStats(){
    const pending=state.items.filter(i=>['faltando','pending'].includes(i.status));
    const bought=state.items.filter(i=>['comprado','bought'].includes(i.status));
    const deferred=state.items.filter(i=>i.status==='adiado');
    const total=bought.reduce((s,i)=>s+(Number(i.quantidade)||0)*(Number(i.preco)||0),0);
    els.pending.textContent=pending.length;els.bought.textContent=bought.length;els.deferred.textContent=deferred.length;els.total.textContent=M.formatCurrency(total);
  }
  function setOfferStatus(message){els.status.textContent=message;}
  function mapsUrl(unit){if(unit.mapsUrl)return unit.mapsUrl;return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${unit.lat},${unit.lng}`)}`;}
  function renderOffers(offers,nearbyCount){
    if(!offers.length){els.list.hidden=true;els.all.hidden=false;setOfferStatus(`Nenhuma promoção compatível foi encontrada nas ${nearbyCount} unidade${nearbyCount===1?'':'s'} próxima${nearbyCount===1?'':'s'} consultada${nearbyCount===1?'':'s'}. Sua lista continua disponível normalmente.`);return;}
    const bestByItem=new Map();
    for(const o of offers){const key=o.item.id||M.normalizeText(o.item.nome);const current=bestByItem.get(key);if(!current||Number(o.promo.price)<Number(current.promo.price)||(Number(o.promo.price)===Number(current.promo.price)&&o.distanceKm<current.distanceKm))bestByItem.set(key,o);}
    const best=[...bestByItem.values()].sort((a,b)=>Number(a.promo.price)-Number(b.promo.price)).slice(0,4);
    els.list.innerHTML=best.map(o=>`<a class="offer-row" href="${M.escapeHtml(mapsUrl(o.unit))}" target="_blank" rel="noopener"><span><span class="offer-product">${M.escapeHtml(o.item.nome)}</span><span class="offer-market">${M.escapeHtml(o.unit.marketName||'Mercado')} · ${M.escapeHtml(o.unit.unitName||'Unidade')} · ${o.distanceKm.toFixed(1).replace('.',',')} km</span></span><span class="offer-price">${M.escapeHtml(M.formatCurrency(o.promo.price))}<small>${M.escapeHtml(o.promo.productName||'oferta')}</small></span></a>`).join('');
    els.list.hidden=false;els.all.hidden=false;setOfferStatus(`${bestByItem.size} item${bestByItem.size===1?'':'s'} da sua lista ${bestByItem.size===1?'tem':'têm'} oferta nas unidades próximas. Mostrando as melhores opções.`);
  }
  async function loadOffers(){
    if(state.loadingOffers)return;
    const pending=state.items.filter(i=>['faltando','pending'].includes(i.status)&&i.nome);
    if(!pending.length){setOfferStatus('Sua lista não tem itens em “A comprar” agora. Adicione produtos para comparar promoções.');return;}
    state.loadingOffers=true;els.locationBtn.disabled=true;els.locationBtn.textContent='Localizando...';
    try{
      const pos=await M.getCurrentPosition();const loc={lat:pos.coords.latitude,lng:pos.coords.longitude};
      setOfferStatus('Localização encontrada. Buscando unidades e ofertas próximas...');
      const catalogSnap=await db.ref('geo_catalog').once('value');const catalog=catalogSnap.val()||{};
      const nearby=Object.entries(catalog).map(([id,u])=>({id,...u,distanceKm:M.haversineKm(loc.lat,loc.lng,u.lat,u.lng)})).filter(u=>u.active===true&&Number.isFinite(u.distanceKm)&&u.distanceKm<=state.radiusKm).sort((a,b)=>a.distanceKm-b.distanceKm);
      if(!nearby.length){renderOffers([],0);return;}
      // Dashboard é um resumo leve: consulta no máximo as 30 unidades mais próximas.
      const unitsToRead=nearby.slice(0,30);
      const now=Date.now();
      const snaps=await Promise.all(unitsToRead.map(async unit=>({unit,snap:await db.ref(`promotion_live/${unit.id}`).orderByChild('endAt').startAt(now).once('value')})));
      const offers=[];
      for(const {unit,snap} of snaps){const promos=snap.val()||{};for(const [promoId,promo] of Object.entries(promos)){if(!promo||promo.active!==true||promo.verified!==true)continue;if(promo.startAt&&now<Number(promo.startAt))continue;for(const item of pending){const match=M.scorePromotionMatch(item,promo);if(match.score<.58)continue;offers.push({promoId,promo,item,unit,distanceKm:unit.distanceKm,score:match.score});}}}
      renderOffers(offers,unitsToRead.length);
    }catch(error){console.error('[Mercador IA] Falha ao carregar ofertas no início:',error);setOfferStatus(error?.message||'Não foi possível carregar as promoções próximas agora.');M.toast?.(error?.message||'Não foi possível obter sua localização.','error');}
    finally{state.loadingOffers=false;els.locationBtn.disabled=false;els.locationBtn.textContent='📍 Atualizar promoções próximas';}
  }
  async function init(user){
    state.user=user;
    try{
      const profile=await M.ensureAuthenticatedProfile(user);if(!profile||profile.status!=='active')throw new Error('Sua conta está bloqueada.');
      if(['superadmin','admin'].includes(profile.role)){location.replace('./admin.html');return;}
      state.profile=profile;els.welcome.textContent=`Olá${firstName(profile.name)?`, ${firstName(profile.name)}`:''}`;
      // O painel aparece primeiro com o cache da lista; a confirmação do Firebase vem por trás.
      loadCachedList(user.uid);
      reveal();
      const [listSnap,radiusSnap]=await Promise.all([db.ref(`shopping_lists/${user.uid}`).once('value'),db.ref(`user_settings/${user.uid}/radiusKm`).once('value')]);
      const raw=listSnap.val()||{};state.items=Object.entries(raw).map(([id,value])=>normalizeItem(value,id));state.radiusKm=Number(radiusSnap.val())||5;els.radius.textContent=`${state.radiusKm} km`;renderStats();
      if(navigator.permissions?.query){try{const permission=await navigator.permissions.query({name:'geolocation'});if(permission.state==='granted')loadOffers();}catch(_){}}
    }catch(error){els.boot.innerHTML=`<div class="error-box">${M.escapeHtml(error.message||'Não foi possível abrir seu painel.')}<br><br><a href="./index.html">Voltar ao login</a></div>`;}
  }
  els.logout.addEventListener('click',()=>M.logout());els.locationBtn.addEventListener('click',loadOffers);
  auth.onAuthStateChanged(user=>{if(!user){location.replace('./index.html');return;}init(user);});
})();
