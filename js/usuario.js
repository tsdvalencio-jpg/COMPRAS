(function () {
  'use strict';

  const M = window.MercadorIA;
  const { db, serverTimestamp } = M;
  const state = { user:null, profile:null, items:{}, markets:{}, units:{}, promotions:{}, settings:{radiusKm:5}, location:null, offers:[] };
  const byId = (id) => document.getElementById(id);
  const itemsArray = () => Object.entries(state.items || {}).map(([id,value]) => ({id,...(value || {})}));

  function syncBadge(text, kind='ok') { const el=byId('syncBadge'); el.textContent=text; el.className=`badge ${kind}`; }

  function renderList() {
    const items = itemsArray().sort((a,b) => {
      if ((a.status === 'pending') !== (b.status === 'pending')) return a.status === 'pending' ? -1 : 1;
      const p = {high:0,normal:1,low:2};
      return (p[a.priority] ?? 1) - (p[b.priority] ?? 1) || Number(b.createdAt || 0) - Number(a.createdAt || 0);
    });
    const pending = items.filter((x)=>x.status==='pending');
    byId('pendingCount').textContent=pending.length;
    byId('listCountBadge').textContent=`${items.length} ite${items.length===1?'m':'ns'}`;
    byId('shoppingList').innerHTML = items.length ? items.map((x)=>{
      const bought=x.status==='bought'; const cat=x.category ? M.humanCategory(x.category) : M.humanCategory(M.inferCategory(x.name));
      const priority = x.priority==='high'?'Alta':x.priority==='low'?'Baixa':'Normal';
      return `<article class="shopping-item ${bought?'bought':''}">
        <button class="item-check" type="button" data-item-toggle="${x.id}" aria-label="${bought?'Voltar para a comprar':'Marcar como comprado'}">${bought?'✓':''}</button>
        <div><div class="item-name">${M.escapeHtml(x.name)}</div><div class="item-sub">Qtd. ${Number(x.quantity || 1)} · ${M.escapeHtml(cat)} · Prioridade ${priority}${x.note?` · ${M.escapeHtml(x.note)}`:''}</div></div>
        <button class="icon-btn" type="button" data-item-delete="${x.id}" aria-label="Excluir">×</button>
      </article>`;
    }).join('') : '<div class="empty">Sua lista está vazia. Adicione o primeiro produto acima.</div>';
    calculateOffers();
  }

  function calculateOffers() {
    if (!state.location) {
      state.offers=[]; renderOffers(); return;
    }
    state.offers = M.findMatchingOffers({ items:itemsArray(), promotions:state.promotions, units:state.units, markets:state.markets, location:state.location, radiusKm:Number(state.settings.radiusKm || 5) });
    renderOffers();
  }

  function renderOffers() {
    const offers=state.offers;
    const uniquePromo = new Set(offers.map((o)=>o.promoId));
    byId('offerCount').textContent=uniquePromo.size;
    if(!state.location){ byId('offerStatusBadge').textContent='aguardando localização'; byId('offerStatusBadge').className='badge warn'; byId('offersList').innerHTML='<div class="empty">Autorize sua localização para procurar promoções verificadas dentro do raio escolhido.</div>'; byId('savingTotal').textContent=M.formatCurrency(0); return; }

    const grouped = new Map();
    for(const offer of offers){ if(!grouped.has(offer.item.id)) grouped.set(offer.item.id,[]); grouped.get(offer.item.id).push(offer); }
    let saving=0;
    for(const list of grouped.values()){
      list.sort((a,b)=>Number(a.promo.price)-Number(b.promo.price)||a.distanceKm-b.distanceKm);
      const best=list[0]; const old=Number(best.promo.previousPrice); const price=Number(best.promo.price); if(Number.isFinite(old)&&old>price) saving+=(old-price)*Number(best.item.quantity||1);
    }
    byId('savingTotal').textContent=M.formatCurrency(saving);
    byId('offerStatusBadge').textContent=offers.length?`${offers.length} correspondência${offers.length===1?'':'s'}`:'nenhuma oferta no raio';
    byId('offerStatusBadge').className=`badge ${offers.length?'ok':'info'}`;

    if(!offers.length){ byId('offersList').innerHTML=`<div class="empty">Nenhuma promoção verificada dos itens pendentes foi encontrada em até ${state.settings.radiusKm || 5} km agora.</div>`; return; }

    const blocks=[];
    for(const [itemId,list] of grouped){
      list.sort((a,b)=>Number(a.promo.price)-Number(b.promo.price)||a.distanceKm-b.distanceKm);
      const item=list[0].item;
      blocks.push(`<section><div style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin:4px 0 9px"><strong>Para: ${M.escapeHtml(item.name)}</strong><span class="badge info">${list.length} oferta${list.length===1?'':'s'}</span></div>${list.map((o,index)=>{
        const old=Number(o.promo.previousPrice); const price=Number(o.promo.price); const economy=Number.isFinite(old)&&old>price?old-price:0;
        const maps=`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${o.unit.lat},${o.unit.lng}`)}`;
        return `<article class="offer-card">
          <div class="offer-head"><div><div class="small muted">${M.escapeHtml(o.market.name)} · ${M.escapeHtml(o.unit.name)}</div><div class="entity-title">${M.escapeHtml(o.promo.productName)}</div><div class="small muted">${M.escapeHtml([o.promo.brand,o.promo.packageText].filter(Boolean).join(' · '))}</div></div>${index===0?'<span class="best-tag">MELHOR PREÇO</span>':''}</div>
          <div style="display:flex;gap:10px;align-items:baseline;margin-top:10px;flex-wrap:wrap"><span class="offer-price">${M.formatCurrency(price)}</span>${Number.isFinite(old)&&old>0?`<span class="offer-old">${M.formatCurrency(old)}</span>`:''}${economy>0?`<span class="badge ok">economize ${M.formatCurrency(economy)}</span>`:''}</div>
          <div class="offer-meta"><span class="badge info">📍 ${o.distanceKm.toFixed(1)} km</span><span class="badge ok">✓ valor conferido</span><span class="badge">até ${M.formatDateTime(o.promo.endAt)}</span><span class="badge">confiança ${Math.round(o.matchScore*100)}%</span></div>
          <div class="small muted" style="margin-top:9px">Origem: ${M.escapeHtml(o.promo.sourceType || 'informada')} · ${M.escapeHtml(o.promo.sourceReference || 'referência administrativa')}</div>
          <div class="offer-actions"><a class="btn btn-primary btn-sm" target="_blank" rel="noopener" href="${maps}">Abrir rota</a><button class="btn btn-secondary btn-sm" type="button" data-add-market-note="${o.item.id}" data-market-name="${M.escapeHtml(o.market.name)}">Guardar referência</button></div>
        </article>`;
      }).join('')}</section>`);
    }
    byId('offersList').innerHTML=blocks.join('<div style="height:10px"></div>');
  }

  async function addItem(event){
    event.preventDefault(); const name=byId('itemName').value.trim(); const quantity=Number(byId('itemQuantity').value||1); if(name.length<2)return;
    const ref=db.ref(`shopping_lists/${state.user.uid}`).push();
    await ref.set({ name, normalizedName:M.normalizeText(name), category:M.inferCategory(name)||null, quantity:Number.isFinite(quantity)&&quantity>0?quantity:1, priority:byId('itemPriority').value, note:byId('itemNote').value.trim(), status:'pending', createdAt:serverTimestamp, updatedAt:serverTimestamp });
    byId('itemName').value=''; byId('itemQuantity').value='1'; byId('itemNote').value=''; byId('itemName').focus(); M.toast('Item adicionado à sua lista.', 'success');
  }

  async function locate(){
    const btn=byId('locateBtn'); M.setBusy(btn,true,'Localizando...');
    try{ const p=await M.getCurrentPosition(); state.location={lat:p.coords.latitude,lng:p.coords.longitude,accuracy:p.coords.accuracy,timestamp:p.timestamp}; byId('locationDot').classList.add('live'); byId('locationTitle').textContent='Localização atual disponível'; byId('locationText').textContent=`Precisão aproximada: ${Math.round(p.coords.accuracy)} m. Cálculo feito neste aparelho.`; calculateOffers(); M.toast('Localização atualizada. Promoções recalculadas.', 'success'); }
    catch(error){ M.toast(error.message,'error',6000); }
    finally{M.setBusy(btn,false);}
  }

  function listen(){
    syncBadge('sincronizando','info');
    db.ref(`shopping_lists/${state.user.uid}`).on('value',(s)=>{state.items=s.val()||{};renderList();syncBadge('tempo real','ok');},()=>syncBadge('erro no banco','danger'));
    db.ref(`user_settings/${state.user.uid}`).on('value',(s)=>{state.settings={radiusKm:5,...(s.val()||{})};byId('radiusSelect').value=String(state.settings.radiusKm||5);calculateOffers();});
    db.ref('markets').on('value',(s)=>{state.markets=s.val()||{};calculateOffers();});
    db.ref('market_units').on('value',(s)=>{state.units=s.val()||{};calculateOffers();});
    db.ref('promotions').on('value',(s)=>{state.promotions=s.val()||{};calculateOffers();});
  }

  function bind(){
    byId('logoutBtn').addEventListener('click',M.logout); byId('quickAddForm').addEventListener('submit',(e)=>addItem(e).catch((er)=>M.toast(er.message,'error'))); byId('locateBtn').addEventListener('click',locate);
    byId('radiusSelect').addEventListener('change',async()=>{const radius=Number(byId('radiusSelect').value);state.settings.radiusKm=radius;await db.ref(`user_settings/${state.user.uid}`).update({radiusKm:radius,updatedAt:serverTimestamp});calculateOffers();});
    byId('clearBoughtBtn').addEventListener('click',async()=>{const bought=itemsArray().filter((x)=>x.status==='bought');if(!bought.length){M.toast('Não há itens comprados para remover.','info');return;} if(!confirm(`Remover ${bought.length} item(ns) já comprados?`))return; const updates={};bought.forEach((x)=>updates[x.id]=null);await db.ref(`shopping_lists/${state.user.uid}`).update(updates);M.toast('Itens comprados removidos.','success');});
    document.addEventListener('click',async(event)=>{const t=event.target.closest('button');if(!t)return;
      if(t.dataset.itemToggle){const x=state.items[t.dataset.itemToggle];if(!x)return;const next=x.status==='bought'?'pending':'bought';await db.ref(`shopping_lists/${state.user.uid}/${t.dataset.itemToggle}`).update({status:next,boughtAt:next==='bought'?serverTimestamp:null,updatedAt:serverTimestamp});}
      if(t.dataset.itemDelete){const x=state.items[t.dataset.itemDelete];if(!x)return;if(confirm(`Excluir "${x.name}" da lista?`))await db.ref(`shopping_lists/${state.user.uid}/${t.dataset.itemDelete}`).remove();}
      if(t.dataset.addMarketNote){const x=state.items[t.dataset.addMarketNote];if(!x)return;const market=t.dataset.marketName||'';const note=[x.note,`Oferta vista em ${market}`].filter(Boolean).join(' · ').slice(0,120);await db.ref(`shopping_lists/${state.user.uid}/${t.dataset.addMarketNote}`).update({note,updatedAt:serverTimestamp});M.toast('Referência adicionada ao item.','success');}
    });
  }

  (async function init(){
    try{ const {user,profile}=await M.requireRole(['user','admin','superadmin']); state.user=user;state.profile=profile; const first=(profile.name||user.email||'').split(' ')[0]; byId('userGreeting').textContent=`${first ? `${first}, `:''}sua lista já pode procurar preços perto de você.`; bind(); listen(); byId('loading').hidden=true; }
    catch(error){console.error(error);}
  })();
})();
