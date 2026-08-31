(function () {
  'use strict';

  const M = window.MercadorIA;
  const { db, auth, serverTimestamp, firebaseConfig } = M;
  const state = { users: {}, markets: {}, units: {}, promotions: {}, inbox: {}, audit: {}, profile: null, user: null, pdfImport: null };

  const byId = (id) => document.getElementById(id);
  const entries = (obj) => Object.entries(obj || {}).map(([id, value]) => ({ ...(value || {}), id }));
  const activeNow = (promo) => {
    const now = Date.now();
    return promo.active === true && promo.verified === true && (!promo.startAt || Number(promo.startAt) <= now) && (!promo.endAt || Number(promo.endAt) >= now);
  };
  const getMarket = (id) => state.markets[id] || null;
  const getUnit = (id) => state.units[id] || null;
  const digitsOnly = (value) => String(value || '').replace(/\D/g, '');
  const whatsappHref = (value) => {
    let digits = digitsOnly(value);
    if (!digits) return '';
    if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) digits = `55${digits}`;
    return `https://wa.me/${digits}`;
  };
  const userStatusLabel = (status) => ({pending:'pendente',active:'ativo',blocked:'bloqueado',rejected:'rejeitado',deleted:'excluído'}[status] || status || '—');
  const userStatusClass = (status) => status === 'active' ? 'ok' : status === 'pending' ? 'warn' : status === 'deleted' ? 'danger' : 'danger';

  const geoUnitRecord = (unit, marketOverride = null) => {
    if (!unit || unit.active !== true || !unit.marketId) return null;
    const market = marketOverride || getMarket(unit.marketId);
    const lat = Number(unit.lat), lng = Number(unit.lng);
    if (!market || market.active !== true || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      marketId: unit.marketId,
      marketName: market.name || 'Mercado',
      unitName: unit.name || 'Unidade',
      address: unit.address || '',
      city: unit.city || '',
      state: unit.state || '',
      mapsUrl: unit.mapsUrl || '',
      lat, lng, active: true
    };
  };

  function addGeoUnitUpdate(updates, unitId, nextUnit, previousUnit = null, marketOverride = null) {
    const oldId = previousUnit?.id || unitId;
    const live = geoUnitRecord(nextUnit, marketOverride);
    if (live) updates[`geo_catalog/${unitId}`] = live;
    else updates[`geo_catalog/${oldId}`] = null;
  }

  function addMarketGeoCatalogUpdates(updates, marketId, nextMarket) {
    entries(state.units).filter((unit) => unit.marketId === marketId).forEach((unit) => {
      addGeoUnitUpdate(updates, unit.id, unit, unit, nextMarket);
    });
  }

  const livePromotionRecord = (promo) => {
    if (!promo || promo.active !== true || promo.verified !== true || !promo.unitId || !promo.marketId) return null;
    const endAt = Number(promo.endAt || 0); if (!endAt || endAt < Date.now() - 60000) return null;
    return {
      marketId: promo.marketId,
      unitId: promo.unitId,
      productName: promo.productName || '',
      category: promo.category || 'outros',
      brand: promo.brand || '',
      packageText: promo.packageText || '',
      price: Number(promo.price || 0),
      previousPrice: Number(promo.previousPrice) > Number(promo.price) ? Number(promo.previousPrice) : null,
      startAt: Number(promo.startAt || 0),
      endAt,
      priceKind: promo.priceKind || 'general',
      requiresClub: promo.requiresClub === true,
      clubName: promo.requiresClub ? (promo.clubName || '') : '',
      conditions: promo.conditions || '',
      aliases: promo.aliases || '',
      verified: true,
      active: true
    };
  };

  function addPromotionLiveUpdates(updates, promoId, nextPromo, previousPromo = null) {
    if (previousPromo?.unitId && previousPromo.unitId !== nextPromo?.unitId) updates[`promotion_live/${previousPromo.unitId}/${promoId}`] = null;
    const live = livePromotionRecord(nextPromo);
    if (live) updates[`promotion_live/${live.unitId}/${promoId}`] = live;
    else if ((nextPromo?.unitId || previousPromo?.unitId)) updates[`promotion_live/${nextPromo?.unitId || previousPromo.unitId}/${promoId}`] = null;
  }

  async function rebuildPromotionLiveIndex() {
    if (state.profile?.role !== 'superadmin') { M.toast('Somente o SuperAdmin pode reconstruir os índices leves.', 'warning'); return; }
    const activePromos = entries(state.promotions).filter((promo) => livePromotionRecord(promo));
    const geo = {};
    entries(state.units).forEach((unit) => { const rec=geoUnitRecord(unit); if (rec) geo[unit.id]=rec; });
    if (!window.confirm(`Otimizar os dados usados pelos usuários?\n\nSerão reconstruídos em uma única operação:\n• ${Object.keys(geo).length} unidades no catálogo geográfico leve\n• ${activePromos.length} promoções válidas no índice de ofertas\n\nIsso reduz as leituras do aplicativo sem alterar os cadastros originais.`)) return;
    const btn = byId('rebuildPromotionLiveBtn'); M.setBusy(btn, true, 'Otimizando...');
    try {
      const feed = {};
      activePromos.forEach((promo) => { const live=livePromotionRecord(promo); if (!feed[live.unitId]) feed[live.unitId]={}; feed[live.unitId][promo.id]=live; });
      await db.ref().update({ geo_catalog:geo, promotion_live:feed });
      await audit('user_indexes_rebuilt','system','user_indexes',{promotions:activePromos.length,units:Object.keys(geo).length});
      M.toast(`Índices otimizados: ${Object.keys(geo).length} unidades e ${activePromos.length} promoções prontas para os usuários.`, 'success', 7500);
    } catch(error) { console.error(error); M.toast(error.message || 'Falha ao otimizar os índices dos usuários.','error',8000); }
    finally { M.setBusy(btn, false); }
  }

  function navigate(section) {
    document.querySelectorAll('.admin-section').forEach((el) => el.classList.toggle('active', el.id === `section-${section}`));
    document.querySelectorAll('[data-section]').forEach((el) => el.classList.toggle('active', el.dataset.section === section));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function audit(action, targetType, targetId, details = {}) {
    try {
      await db.ref('audit_logs').push({
        action,
        targetType,
        targetId: targetId || null,
        details,
        actorUid: state.user.uid,
        actorEmail: state.user.email || '',
        actorRole: state.profile.role,
        createdAt: serverTimestamp
      });
    } catch (error) {
      console.warn('[Mercador IA] Falha ao registrar auditoria:', error);
    }
  }

  function renderDashboard() {
    const users = entries(state.users);
    const markets = entries(state.markets);
    const units = entries(state.units);
    const promotions = entries(state.promotions);
    byId('kpiUsers').textContent = users.filter((x) => x.status === 'active').length;
    byId('kpiMarkets').textContent = markets.filter((x) => x.active === true).length;
    byId('kpiUnits').textContent = units.filter((x) => x.active === true).length;
    byId('kpiPromos').textContent = promotions.filter(activeNow).length;

    const unverified = promotions.filter((x) => x.active === true && x.verified !== true).length;
    const expired = promotions.filter((x) => x.endAt && Number(x.endAt) < Date.now()).length;
    const pendingUsers = users.filter((x) => x.status === 'pending').length;
    byId('qualitySummary').innerHTML = `
      <div class="entity-card"><div class="entity-top"><div><div class="entity-title">Cadastros aguardando liberação</div><div class="small muted">Usuários do cadastro público ainda sem acesso.</div></div><span class="badge ${pendingUsers ? 'warn' : 'ok'}">${pendingUsers}</span></div></div>
      <div class="entity-card"><div class="entity-top"><div><div class="entity-title">Promoções aguardando conferência</div><div class="small muted">Não aparecem ao consumidor.</div></div><span class="badge ${unverified ? 'warn' : 'ok'}">${unverified}</span></div></div>
      <div class="entity-card"><div class="entity-top"><div><div class="entity-title">Promoções vencidas</div><div class="small muted">Mantidas para histórico administrativo.</div></div><span class="badge info">${expired}</span></div></div>`;
  }

  function renderUsers() {
    const q = M.normalizeText(byId('userSearch').value);
    const filter = byId('userStatusFilter')?.value || 'all';
    const allUsers = entries(state.users);
    const pendingCount = allUsers.filter((u) => u.status === 'pending').length;
    const pendingBanner = byId('userPendingBanner');
    if (pendingBanner) pendingBanner.hidden = pendingCount === 0;
    if (byId('userPendingCount')) byId('userPendingCount').textContent = pendingCount;

    const users = allUsers
      .filter((u) => filter === 'all' ? u.status !== 'deleted' : u.status === filter)
      .filter((u) => !q || M.normalizeText(`${u.name} ${u.email} ${u.contactEmail} ${u.phone} ${u.role} ${u.status} ${u.notes}`).includes(q))
      .sort((a,b) => {
        const order={pending:0,active:1,blocked:2,rejected:3,deleted:4};
        const statusDiff=(order[a.status]??9)-(order[b.status]??9);
        return statusDiff || String(a.name || a.email).localeCompare(String(b.name || b.email));
      });
    byId('userCountBadge').textContent = `${users.length} usuário${users.length === 1 ? '' : 's'}`;
    byId('usersList').innerHTML = users.length ? users.map((u) => {
      const isMaster = u.id === M.MASTER_UID;
      const isDeleted = u.status === 'deleted';
      const roleClass = ['superadmin','admin'].includes(u.role) ? 'warn' : 'info';
      const phoneLink=whatsappHref(u.phone);
      const contactEmail=u.contactEmail || u.email || '';
      let actions='';
      if(!isMaster && !isDeleted){
        const primary = u.status === 'pending' || u.status === 'rejected'
          ? `<button type="button" class="btn btn-primary btn-sm" data-user-status="active" data-user-id="${u.id}">Aprovar</button>`
          : u.status === 'active'
            ? `<button type="button" class="btn btn-danger btn-sm" data-user-status="blocked" data-user-id="${u.id}">Bloquear</button>`
            : `<button type="button" class="btn btn-secondary btn-sm" data-user-status="active" data-user-id="${u.id}">Ativar</button>`;
        const reject = u.status === 'pending' ? `<button type="button" class="btn btn-secondary btn-sm" data-user-status="rejected" data-user-id="${u.id}">Rejeitar</button>` : '';
        const deleteBtn = state.profile?.role === 'superadmin' && u.role === 'user' ? `<button type="button" class="btn btn-danger btn-sm" data-user-delete="${u.id}">Excluir</button>` : '';
        actions=`<button type="button" class="btn btn-secondary btn-sm" data-user-edit="${u.id}">Editar</button>${primary}${reject}${deleteBtn}`;
      }
      return `<article class="entity-card">
        <div class="entity-top">
          <div><div class="entity-title">${M.escapeHtml(u.name || 'Sem nome')}</div><div class="small muted">${M.escapeHtml(u.email || '')}</div>
            <div class="entity-meta"><span class="badge ${roleClass}">${M.escapeHtml(u.role || 'user')}</span><span class="badge ${userStatusClass(u.status)}">${M.escapeHtml(userStatusLabel(u.status))}</span>${isMaster ? '<span class="badge ok">MASTER</span>' : ''}<span class="badge">UID ${M.escapeHtml(u.id.slice(0,8))}…</span></div>
            <div class="user-contact-line">${phoneLink ? `<a href="${M.escapeHtml(phoneLink)}" target="_blank" rel="noopener">💬 ${M.escapeHtml(u.phone)}</a>` : '<span class="small muted">📱 sem telefone</span>'}${contactEmail ? `<a href="mailto:${M.escapeHtml(contactEmail)}">✉ ${M.escapeHtml(contactEmail)}</a>` : ''}</div>
            ${u.notes ? `<div class="user-note">${M.escapeHtml(u.notes)}</div>` : ''}
          </div>
          <div class="entity-actions user-actions">${actions}</div>
        </div>
      </article>`;
    }).join('') : '<div class="empty">Nenhum usuário encontrado.</div>';
  }

  function renderMarkets() {
    const q = M.normalizeText(byId('marketSearch').value);
    const markets = entries(state.markets).filter((x) => !q || M.normalizeText(`${x.name} ${x.legalName} ${x.cnpj}`).includes(q)).sort((a,b) => String(a.name).localeCompare(String(b.name)));
    byId('marketCountBadge').textContent = `${markets.length} mercado${markets.length === 1 ? '' : 's'}`;
    byId('marketsList').innerHTML = markets.length ? markets.map((x) => {
      const unitCount = entries(state.units).filter((u) => u.marketId === x.id).length;
      return `<article class="entity-card"><div class="entity-top"><div><div class="entity-title">${M.escapeHtml(x.name)}</div><div class="small muted">${M.escapeHtml(x.legalName || x.cnpj || 'Cadastro comercial')}</div><div class="entity-meta"><span class="badge ${x.active ? 'ok':'danger'}">${x.active ? 'ativo':'inativo'}</span><span class="badge info">${unitCount} unidade${unitCount === 1 ? '' : 's'}</span>${x.contact ? `<span class="badge">${M.escapeHtml(x.contact)}</span>`:''}</div></div><div class="entity-actions"><button type="button" class="btn btn-secondary btn-sm" data-market-edit="${x.id}">Editar</button><button type="button" class="btn btn-sm ${x.active ? 'btn-danger':'btn-secondary'}" data-market-toggle="${x.id}">${x.active ? 'Desativar':'Ativar'}</button>${state.profile?.role === 'superadmin' ? `<button type="button" class="btn btn-danger btn-sm" data-market-delete="${x.id}">Excluir</button>` : ''}</div></div></article>`;
    }).join('') : '<div class="empty">Nenhum mercado cadastrado.</div>';
    refreshMarketSelects();
  }

  function renderUnits() {
    const q = M.normalizeText(byId('unitSearch').value);
    const units = entries(state.units).filter((x) => !q || M.normalizeText(`${x.name} ${x.address} ${x.city} ${x.state} ${getMarket(x.marketId)?.name || ''}`).includes(q)).sort((a,b) => String(a.name).localeCompare(String(b.name)));
    byId('unitCountBadge').textContent = `${units.length} unidade${units.length === 1 ? '' : 's'}`;
    byId('unitsList').innerHTML = units.length ? units.map((x) => { const mapHref = x.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${x.lat},${x.lng}`)}`; const hasCoords = Number.isFinite(Number(x.lat)) && Number.isFinite(Number(x.lng)); return `<article class="entity-card"><div class="entity-top"><div><div class="entity-title">${M.escapeHtml(x.name)}</div><div class="small muted">${M.escapeHtml(getMarket(x.marketId)?.name || 'Mercado não encontrado')}${x.address ? ` · ${M.escapeHtml(x.address)}` : ''}${x.city ? ` · ${M.escapeHtml(x.city)}${x.state ? `/${M.escapeHtml(x.state)}` : ''}` : ''}</div><div class="entity-meta"><span class="badge ${x.active ? 'ok':'danger'}">${x.active ? 'ativa':'inativa'}</span><span class="badge ${hasCoords ? 'ok':'warn'}">${hasCoords ? '📍 GPS interno válido' : '⚠️ sem coordenadas'}</span>${x.mapsUrl ? '<span class="badge info">Google Maps vinculado</span>' : '<span class="badge">cadastro legado</span>'}</div></div><div class="entity-actions"><a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="${M.escapeHtml(mapHref)}">Mapa</a><button type="button" class="btn btn-secondary btn-sm" data-unit-edit="${x.id}">Editar</button><button type="button" class="btn btn-sm ${x.active ? 'btn-danger':'btn-secondary'}" data-unit-toggle="${x.id}">${x.active ? 'Desativar':'Ativar'}</button>${state.profile?.role === 'superadmin' ? `<button type="button" class="btn btn-danger btn-sm" data-unit-delete="${x.id}">Excluir</button>` : ''}</div></div></article>`; }).join('') : '<div class="empty">Nenhuma unidade cadastrada.</div>';
    refreshUnitSelects();
    refreshPdfImportUnitSelects();
  }

  function renderPromotions() {
    const q = M.normalizeText(byId('promoSearch').value);
    const filter = byId('promoFilter').value;
    let list = entries(state.promotions).filter((p) => !q || M.normalizeText(`${p.productName} ${p.brand} ${p.category} ${getMarket(p.marketId)?.name || ''}`).includes(q));
    if (filter === 'valid') list = list.filter(activeNow);
    if (filter === 'expired') list = list.filter((p) => p.endAt && Number(p.endAt) < Date.now());
    if (filter === 'inactive') list = list.filter((p) => p.active !== true);
    list.sort((a,b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
    byId('promoCountBadge').textContent = `${list.length} promoç${list.length === 1 ? 'ão':'ões'}`;
    byId('promotionsList').innerHTML = list.length ? list.map((p) => {
      const market = getMarket(p.marketId);
      const unit = getUnit(p.unitId);
      const saving = Number(p.previousPrice) > Number(p.price) ? Number(p.previousPrice) - Number(p.price) : 0;
      const valid = activeNow(p);
      return `<article class="entity-card"><div class="entity-top"><div><div class="entity-title">${M.escapeHtml(p.productName)}</div><div class="small muted">${M.escapeHtml(market?.name || 'Mercado')} · ${M.escapeHtml(unit?.name || 'Unidade')}</div><div class="entity-meta"><span class="badge ${valid ? 'ok':(p.active ? 'warn':'danger')}">${valid ? 'válida agora':(p.active ? 'fora da validade':'inativa')}</span><span class="badge ${p.verified ? 'ok':'warn'}">${p.verified ? 'valor conferido':'não conferida'}</span><span class="badge info">${M.formatCurrency(p.price)}</span>${p.requiresClub ? `<span class="badge warn">💳 ${M.escapeHtml(p.clubName || 'Preço Clube')}</span>`:''}${saving > 0 ? `<span class="badge ok">economia ${M.formatCurrency(saving)}</span>`:''}<span class="badge">até ${M.formatDateTime(p.endAt)}</span></div><div class="small muted" style="margin-top:9px">Origem: ${M.escapeHtml(p.sourceType || '—')} · ${M.escapeHtml(p.sourceReference || 'sem referência')}</div>${p.conditions ? `<div class="small muted" style="margin-top:6px">Condições: ${M.escapeHtml(p.conditions)}</div>`:''}</div><div class="entity-actions"><button type="button" class="btn btn-secondary btn-sm" data-promo-edit="${p.id}">Editar</button><button type="button" class="btn btn-sm ${p.active ? 'btn-danger':'btn-secondary'}" data-promo-toggle="${p.id}">${p.active ? 'Desativar':'Ativar'}</button>${state.profile?.role === 'superadmin' ? `<button type="button" class="btn btn-danger btn-sm" data-promo-delete="${p.id}">Excluir</button>` : ''}</div></div></article>`;
    }).join('') : '<div class="empty">Nenhuma promoção encontrada.</div>';
  }

  function renderInbox() {
    const list = entries(state.inbox).sort((a,b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    byId('inboxList').innerHTML = list.length ? list.map((x) => `<article class="entity-card"><div class="entity-top"><div><div class="entity-title">${M.escapeHtml(getMarket(x.marketId)?.name || 'Mercado não definido')}</div><div class="small muted">${M.escapeHtml(x.sourceType || 'recebimento')} · ${M.formatDateTime(x.createdAt)}</div><div style="white-space:pre-wrap;margin-top:10px;font-size:.86rem">${M.escapeHtml(x.rawText || '')}</div><div class="entity-meta"><span class="badge ${x.status === 'processed' ? 'ok':'warn'}">${x.status === 'processed' ? 'processado':'aguardando revisão'}</span></div></div><div class="entity-actions"><button class="btn btn-secondary btn-sm" data-inbox-promo="${x.id}">Usar em promoção</button>${x.status !== 'processed' ? `<button class="btn btn-primary btn-sm" data-inbox-process="${x.id}">Marcar revisado</button>`:''}</div></div></article>`).join('') : '<div class="empty">Nenhuma mensagem recebida ainda.</div>';
  }

  function renderAudit() {
    const list = entries(state.audit).sort((a,b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0,80);
    byId('auditList').innerHTML = list.length ? list.map((x) => `<article class="entity-card"><div class="entity-top"><div><div class="entity-title">${M.escapeHtml(x.action || 'ação')}</div><div class="small muted">${M.escapeHtml(x.actorEmail || x.actorUid || '')} · ${M.formatDateTime(x.createdAt)}</div><div class="entity-meta"><span class="badge info">${M.escapeHtml(x.targetType || 'sistema')}</span>${x.targetId ? `<span class="badge">${M.escapeHtml(String(x.targetId).slice(0,18))}</span>`:''}</div></div></div></article>`).join('') : '<div class="empty">A auditoria começará a ser preenchida conforme o painel for utilizado.</div>';
  }

  function refreshMarketSelects() {
    const options = entries(state.markets).filter((x) => x.active === true).sort((a,b) => String(a.name).localeCompare(String(b.name))).map((x) => `<option value="${x.id}">${M.escapeHtml(x.name)}</option>`).join('');
    ['unitMarketId','promoMarketId','pdfImportMarketId'].forEach((id) => { const el = byId(id); if (!el) return; const current = el.value; el.innerHTML = `<option value="">Selecione...</option>${options}`; if ([...el.options].some((o) => o.value === current)) el.value = current; });
    const inbox = byId('inboxMarketId'); if (inbox) { const current = inbox.value; inbox.innerHTML = `<option value="">Não definido</option>${options}`; if ([...inbox.options].some((o) => o.value === current)) inbox.value = current; }
    refreshUnitSelects();
    refreshPdfImportUnitSelects();
  }

  function refreshUnitSelects() {
    const marketId = byId('promoMarketId')?.value;
    const el = byId('promoUnitId');
    if (!el) return;
    const current = el.value;
    const options = entries(state.units).filter((x) => x.active === true && (!marketId || x.marketId === marketId)).sort((a,b) => String(a.name).localeCompare(String(b.name))).map((x) => `<option value="${x.id}">${M.escapeHtml(x.name)} — ${M.escapeHtml(x.city || '')}</option>`).join('');
    el.innerHTML = `<option value="">Selecione...</option>${options}`;
    if ([...el.options].some((o) => o.value === current)) el.value = current;
  }

  function refreshPdfImportUnitSelects() {
    const marketId = byId('pdfImportMarketId')?.value;
    const el = byId('pdfImportUnitId');
    if (!el) return;
    const current = el.value;
    const options = entries(state.units)
      .filter((x) => x.active === true && (!marketId || x.marketId === marketId))
      .sort((a,b) => String(a.name).localeCompare(String(b.name)))
      .map((x) => `<option value="${x.id}">${M.escapeHtml(x.name)} — ${M.escapeHtml(x.city || '')}</option>`).join('');
    el.innerHTML = `<option value="">Selecione...</option>${options}`;
    if ([...el.options].some((o) => o.value === current)) el.value = current;
  }

  function listenData() {
    db.ref('users').on('value', (s) => { state.users = s.val() || {}; renderUsers(); renderDashboard(); });
    db.ref('markets').on('value', (s) => { state.markets = s.val() || {}; renderMarkets(); renderUnits(); renderPromotions(); renderInbox(); renderDashboard(); });
    db.ref('market_units').on('value', (s) => { state.units = s.val() || {}; renderUnits(); renderPromotions(); renderDashboard(); });
    db.ref('promotions').on('value', (s) => { state.promotions = s.val() || {}; renderPromotions(); renderDashboard(); });
    db.ref('promotion_inbox').on('value', (s) => { state.inbox = s.val() || {}; renderInbox(); });
    db.ref('audit_logs').limitToLast(80).on('value', (s) => { state.audit = s.val() || {}; renderAudit(); });
  }

  function bindNavigation() {
    document.querySelectorAll('[data-section]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.section)));
    document.querySelectorAll('[data-open-modal]').forEach((button) => button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const id = button.dataset.openModal;
      if (id === 'marketModal') resetMarketForm();
      if (id === 'unitModal') resetUnitForm();
      if (id === 'promotionModal') resetPromotionForm();
      if (id === 'userModal') byId('userForm').reset();
      if (id === 'inboxModal') byId('inboxForm').reset();
      M.openModal(id, { trigger: button });
    }));
  }

  function resetMarketForm() { const f = byId('marketForm'); f.reset(); f.elements.id.value = ''; f.elements.active.checked = true; byId('marketModalTitle').textContent = 'Cadastrar mercado'; }
  function resetUnitForm() { const f = byId('unitForm'); f.reset(); f.elements.id.value = ''; f.elements.lat.value = ''; f.elements.lng.value = ''; f.elements.state.value = 'SP'; f.elements.active.checked = true; const status=byId('unitMapStatus'); if(status){status.className='map-link-status';status.textContent='Cole o link do local no Google Maps. Latitude e longitude ficam ocultas e são usadas apenas pelo cálculo de proximidade.';} byId('unitModalTitle').textContent = 'Cadastrar unidade'; refreshMarketSelects(); }
  function resetPromotionForm() {
    const f = byId('promotionForm'); f.reset(); f.elements.id.value = ''; f.elements.active.checked = true; f.elements.verified.checked = false; f.elements.priceKind.value = 'general'; byId('promotionModalTitle').textContent = 'Cadastrar promoção real';
    const now = new Date(); const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    f.elements.startAt.value = M.toLocalDateTimeInput(now.getTime()); f.elements.endAt.value = M.toLocalDateTimeInput(end.getTime()); refreshMarketSelects();
  }

  async function createUser(event) {
    event.preventDefault();
    const f = event.currentTarget;
    const btn = byId('userSubmit');
    const name = f.elements.name.value.trim();
    const email = f.elements.email.value.trim().toLowerCase();
    const password = f.elements.password.value;
    const role = f.elements.role.value;
    const phone = f.elements.phone.value.trim();
    const contactEmail = f.elements.contactEmail.value.trim().toLowerCase() || email;
    const notes = f.elements.notes.value.trim();
    if (role === 'admin' && state.profile.role !== 'superadmin') { M.toast('Somente SuperAdmin pode criar outro administrador.', 'error'); return; }
    M.setBusy(btn, true, 'Criando...');
    try {
      const secondaryApp = firebase.apps.find((x) => x.name === 'AdminUserCreator') || firebase.initializeApp(firebaseConfig, 'AdminUserCreator');
      const secondaryAuth = secondaryApp.auth();
      await secondaryAuth.setPersistence(firebase.auth.Auth.Persistence.NONE);
      const credential = await secondaryAuth.createUserWithEmailAndPassword(email, password);
      const uid = credential.user.uid;
      await secondaryAuth.signOut();
      await db.ref(`users/${uid}`).set({ name, email, phone, contactEmail, notes, role, status: 'active', registrationSource:'admin', approvedAt:serverTimestamp, approvedBy:state.user.uid, createdAt: serverTimestamp, createdBy: state.user.uid, updatedAt: serverTimestamp });
      await db.ref(`user_settings/${uid}`).set({ radiusKm: 5, updatedAt: serverTimestamp });
      await audit('user_created', 'user', uid, { email, role, phone });
      f.reset(); M.closeModal('userModal'); M.toast('Usuário criado com sucesso.', 'success');
    } catch (error) {
      const msg = error.code === 'auth/email-already-in-use' ? 'Esse e-mail já está cadastrado no Firebase Authentication.' : (error.message || 'Falha ao criar usuário.');
      M.toast(msg, 'error', 7000);
    } finally { M.setBusy(btn, false); }
  }

  function openUserEditModal(id, trigger) {
    const user=state.users[id]; if(!user) { M.toast('Usuário não encontrado.','error'); return; }
    if(id===M.MASTER_UID) { M.toast('O perfil MASTER é protegido.','warning'); return; }
    const f=byId('userEditForm');
    f.elements.id.value=id; f.elements.name.value=user.name||''; f.elements.email.value=user.email||'';
    f.elements.phone.value=user.phone||''; f.elements.contactEmail.value=user.contactEmail||user.email||'';
    f.elements.role.value=['admin','user'].includes(user.role)?user.role:'user'; f.elements.status.value=['pending','active','blocked','rejected'].includes(user.status)?user.status:'blocked';
    f.elements.notes.value=user.notes||'';
    if(state.profile?.role!=='superadmin') f.elements.role.disabled=true; else f.elements.role.disabled=false;
    M.openModal('userEditModal',{trigger});
  }

  async function saveUserEdit(event) {
    event.preventDefault(); const f=event.currentTarget; const id=f.elements.id.value; const current=state.users[id];
    if(!current || id===M.MASTER_UID) return;
    const role=f.elements.role.disabled ? current.role : f.elements.role.value;
    const status=f.elements.status.value;
    if((role!==current.role || status!==current.status) && state.profile?.role!=='superadmin'){M.toast('Somente o SuperAdmin pode alterar perfil ou status.','error');return;}
    const patch={name:f.elements.name.value.trim(),phone:f.elements.phone.value.trim(),contactEmail:f.elements.contactEmail.value.trim().toLowerCase()||current.email||'',notes:f.elements.notes.value.trim(),role,status,updatedAt:serverTimestamp,updatedBy:state.user.uid};
    if(status==='active' && current.status!=='active'){patch.approvedAt=serverTimestamp;patch.approvedBy=state.user.uid;}
    const updates={ [`users/${id}`]:{...current,...patch} };
    if(status==='active' && current.registrationSource==='public' && !current.approvedAt) updates[`user_settings/${id}`]={ radiusKm:5, updatedAt:serverTimestamp };
    const btn=byId('userEditSubmit'); M.setBusy(btn,true,'Salvando...');
    try{await db.ref().update(updates);await audit('user_updated','user',id,{fields:['name','phone','contactEmail','notes','role','status'],status,role});M.closeModal('userEditModal');M.toast('Usuário atualizado.','success');}
    catch(error){M.toast(error.message||'Não foi possível atualizar o usuário.','error',7000);}
    finally{M.setBusy(btn,false);}
  }

  async function setUserStatus(id,status) {
    const current=state.users[id]; if(!current||id===M.MASTER_UID)return;
    if(state.profile?.role!=='superadmin'){M.toast('Somente o SuperAdmin pode aprovar, rejeitar ou alterar o acesso.','error');return;}
    const labels={active:'aprovar/ativar',blocked:'bloquear',rejected:'rejeitar'};
    if(!confirm(`Confirma ${labels[status]||'alterar'} o acesso de “${current.name||current.email}”?`))return;
    const updates={ [`users/${id}/status`]:status,[`users/${id}/updatedAt`]:serverTimestamp,[`users/${id}/updatedBy`]:state.user.uid };
    if(status==='active'){updates[`users/${id}/approvedAt`]=serverTimestamp;updates[`users/${id}/approvedBy`]=state.user.uid;if(current.registrationSource==='public'&&!current.approvedAt)updates[`user_settings/${id}`]={radiusKm:5,updatedAt:serverTimestamp};}
    if(status==='rejected'){updates[`users/${id}/rejectedAt`]=serverTimestamp;updates[`users/${id}/rejectedBy`]=state.user.uid;}
    try{await db.ref().update(updates);await audit('user_status_changed','user',id,{from:current.status,to:status});M.toast(`Usuário ${userStatusLabel(status)}.`,'success');}
    catch(error){M.toast(error.message||'Não foi possível alterar o acesso.','error',7000);}
  }

  async function saveMarket(event) {
    event.preventDefault(); const f=event.currentTarget; const id=f.elements.id.value || db.ref('markets').push().key;
    const value={ name:f.elements.name.value.trim(), legalName:f.elements.legalName.value.trim(), cnpj:f.elements.cnpj.value.trim(), contact:f.elements.contact.value.trim(), active:f.elements.active.checked, updatedAt:serverTimestamp, updatedBy:state.user.uid };
    const previous=state.markets[id] || null; const merged={...(previous||{}),...value};
    if(!f.elements.id.value){merged.createdAt=serverTimestamp;merged.createdBy=state.user.uid;}
    const updates={ [`markets/${id}`]:merged };
    addMarketGeoCatalogUpdates(updates,id,merged);
    await db.ref().update(updates); await audit(f.elements.id.value ? 'market_updated':'market_created','market',id,{name:value.name}); M.closeModal('marketModal'); M.toast('Mercado salvo.', 'success');
  }

  function decodeMapUrl(value) {
    let text = String(value || '').trim();
    for (let i = 0; i < 3; i += 1) {
      try { const decoded = decodeURIComponent(text); if (decoded === text) break; text = decoded; } catch (_) { break; }
    }
    return text;
  }

  function validCoords(lat, lng) {
    return Number.isFinite(lat) && lat >= -90 && lat <= 90 && Number.isFinite(lng) && lng >= -180 && lng <= 180;
  }

  function extractCoordinatesFromGoogleMapsUrl(rawUrl) {
    const raw = String(rawUrl || '').trim();
    if (!raw) return null;
    let url;
    try { url = new URL(raw); } catch (_) { return null; }
    if (!/(^|\.)google\.[^/]+$|(^|\.)googleusercontent\.com$|(^|\.)goo\.gl$/.test(url.hostname) && url.hostname !== 'maps.app.goo.gl') return null;
    const text = decodeMapUrl(raw);
    const patterns = [
      // Place Details embedded in a full Google Maps URL are preferred over
      // the @lat,lng camera center because they identify the actual place marker.
      /!3d(-?\d{1,3}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/i,
      /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)(?:,|z|\/|$)/i,
      /[?&](?:q|query|center|destination|ll)=(-?\d{1,3}(?:\.\d+)?)[,%2C\s]+(-?\d{1,3}(?:\.\d+)?)(?:&|$)/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;
      const lat = Number(match[1]); const lng = Number(match[2]);
      if (validCoords(lat, lng)) return { lat, lng };
    }
    try {
      const parsed = new URL(raw);
      for (const key of ['q','query','center','destination','ll']) {
        const value = decodeMapUrl(parsed.searchParams.get(key) || '');
        const match = value.match(/^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
        if (match) { const lat=Number(match[1]), lng=Number(match[2]); if (validCoords(lat,lng)) return {lat,lng}; }
      }
    } catch (_) {}
    return null;
  }

  function mapsUrlFromCoords(lat, lng) {
    if (!validCoords(Number(lat), Number(lng))) return '';
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${Number(lat)},${Number(lng)}`)}`;
  }

  function applyUnitMapsLink({ quiet = false } = {}) {
    const f = byId('unitForm'); const status = byId('unitMapStatus');
    const raw = f.elements.mapsUrl.value.trim();
    const coords = extractCoordinatesFromGoogleMapsUrl(raw);
    if (!coords) {
      if (status) { status.className='map-link-status warn'; status.textContent = raw.includes('maps.app.goo.gl') ? 'Esse é um link curto do Google Maps e ele não expõe as coordenadas no navegador. Abra o link, aguarde o local abrir no Google Maps pelo navegador e copie o endereço completo da barra, que contém a posição.' : 'Não encontrei coordenadas nesse URL. Use o link completo da página do local no Google Maps (normalmente contém @latitude,longitude ou query=latitude,longitude).'; }
      if (!quiet) M.toast('Não foi possível extrair a posição desse link do Google Maps.', 'warning', 7000);
      return null;
    }
    f.elements.lat.value = String(coords.lat);
    f.elements.lng.value = String(coords.lng);
    if (status) { status.className='map-link-status ok'; status.textContent = `✓ Localização lida com sucesso. Coordenadas internas: ${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}. Você não precisa digitá-las.`; }
    return coords;
  }

  async function saveUnit(event) {
    event.preventDefault(); const f = event.currentTarget; const id = f.elements.id.value || db.ref('market_units').push().key;
    const mapsUrl = f.elements.mapsUrl.value.trim();
    const parsed = applyUnitMapsLink({ quiet: true });
    const lat = Number(parsed ? parsed.lat : f.elements.lat.value), lng = Number(parsed ? parsed.lng : f.elements.lng.value);
    if (!mapsUrl) { M.toast('Cole o link do Google Maps da unidade.', 'warning'); return; }
    if (!validCoords(lat, lng)) { applyUnitMapsLink(); return; }
    const value = { marketId:f.elements.marketId.value, name:f.elements.name.value.trim(), mapsUrl, address:f.elements.address.value.trim(), city:f.elements.city.value.trim(), state:(f.elements.state.value.trim() || 'SP').toUpperCase(), lat, lng, active:f.elements.active.checked, updatedAt:serverTimestamp, updatedBy:state.user.uid };
    const previous=state.units[id] || null; const merged={...(previous||{}),...value,id};
    if (!f.elements.id.value) { merged.createdAt=serverTimestamp; merged.createdBy=state.user.uid; }
    const stored={...merged}; delete stored.id;
    const updates={ [`market_units/${id}`]:stored };
    addGeoUnitUpdate(updates,id,merged,previous);
    await db.ref().update(updates); await audit(f.elements.id.value ? 'unit_updated':'unit_created','market_unit',id,{name:value.name,marketId:value.marketId,mapsUrl:value.mapsUrl}); M.closeModal('unitModal'); M.toast('Unidade salva com localização do Google Maps.', 'success');
  }

  async function savePromotion(event) {
    event.preventDefault(); const f=event.currentTarget; const id=f.elements.id.value || db.ref('promotions').push().key;
    const startAt=M.toTimestampFromLocalInput(f.elements.startAt.value), endAt=M.toTimestampFromLocalInput(f.elements.endAt.value); const price=Number(f.elements.price.value), previousPrice=f.elements.previousPrice.value ? Number(f.elements.previousPrice.value) : null;
    if (!startAt || !endAt || endAt <= startAt) { M.toast('A validade deve terminar depois do início.', 'warning'); return; }
    if (!Number.isFinite(price) || price <= 0) { M.toast('Informe um preço promocional válido.', 'warning'); return; }
    if (!f.elements.verified.checked) { M.toast('A promoção só pode ser salva como oferta real após a conferência do valor.', 'warning'); return; }
    const unit=getUnit(f.elements.unitId.value); if (!unit || unit.marketId !== f.elements.marketId.value) { M.toast('A unidade selecionada não pertence ao mercado informado.', 'error'); return; }
    const priceKind=f.elements.priceKind.value || 'general'; const requiresClub=priceKind==='club'; const clubName=f.elements.clubName.value.trim(); const conditions=f.elements.conditions.value.trim();
    if (requiresClub && !clubName) { M.toast('Informe o nome do Clube/programa exigido por esse preço.', 'warning'); return; }
    if (priceKind === 'condition' && !conditions) { M.toast('Descreva a condição necessária para esse preço.', 'warning'); return; }
    const value={ marketId:f.elements.marketId.value, unitId:f.elements.unitId.value, productName:f.elements.productName.value.trim(), category:M.slugify(f.elements.category.value).replaceAll('-','_') || M.inferCategory(f.elements.productName.value) || 'outros', brand:f.elements.brand.value.trim(), packageText:f.elements.packageText.value.trim(), price, previousPrice, startAt, endAt, sourceType:f.elements.sourceType.value, sourceReference:f.elements.sourceReference.value.trim(), aliases:f.elements.aliases.value.trim(), priceKind, requiresClub, clubName:requiresClub?clubName:'', conditions, verified:true, verifiedAt:serverTimestamp, verifiedBy:state.user.uid, active:f.elements.active.checked, updatedAt:serverTimestamp, updatedBy:state.user.uid };
    const previous = state.promotions[id] || null;
    const merged = { ...(previous || {}), ...value };
    if (!f.elements.id.value) { merged.createdAt=serverTimestamp; merged.createdBy=state.user.uid; }
    const updates={}; updates[`promotions/${id}`]=merged; addPromotionLiveUpdates(updates,id,merged,previous);
    await db.ref().update(updates); await audit(f.elements.id.value ? 'promotion_updated':'promotion_created','promotion',id,{product:value.productName,price:value.price,marketId:value.marketId}); M.closeModal('promotionModal'); M.toast('Promoção real salva e índice leve sincronizado.', 'success');
  }

  async function saveInbox(event) {
    event.preventDefault(); const f=event.currentTarget; const ref=db.ref('promotion_inbox').push(); const value={ marketId:f.elements.marketId.value || null, sourceType:f.elements.sourceType.value, rawText:f.elements.rawText.value.trim(), status:'pending', createdAt:serverTimestamp, createdBy:state.user.uid };
    await ref.set(value); await audit('inbox_received','promotion_inbox',ref.key,{marketId:value.marketId,sourceType:value.sourceType}); M.closeModal('inboxModal'); f.reset(); M.toast('Recebimento registrado para revisão.', 'success');
  }

  function populateMarketForm(id, trigger) { const x=state.markets[id]; if(!x)return; resetMarketForm(); const f=byId('marketForm'); Object.entries(x).forEach(([k,v])=>{ if(f.elements[k] && k!=='active') f.elements[k].value=v ?? ''; }); f.elements.id.value=id; f.elements.active.checked=x.active===true; byId('marketModalTitle').textContent='Editar mercado'; M.openModal('marketModal', { trigger }); }
  function populateUnitForm(id, trigger) { const x=state.units[id]; if(!x)return; resetUnitForm(); const f=byId('unitForm'); ['marketId','name','address','city','state','lat','lng'].forEach((k)=>{ if(f.elements[k])f.elements[k].value=x[k] ?? '';}); f.elements.mapsUrl.value=x.mapsUrl || mapsUrlFromCoords(x.lat,x.lng); f.elements.id.value=id; f.elements.active.checked=x.active===true; byId('unitModalTitle').textContent='Editar unidade'; applyUnitMapsLink({ quiet:true }); M.openModal('unitModal', { trigger }); }
  function populatePromotionForm(id, trigger) { const x=state.promotions[id]; if(!x)return; resetPromotionForm(); const f=byId('promotionForm'); ['marketId','productName','category','brand','packageText','price','previousPrice','sourceType','sourceReference','clubName','conditions','aliases'].forEach((k)=>{ if(f.elements[k])f.elements[k].value=x[k] ?? '';}); f.elements.priceKind.value=x.priceKind || (x.requiresClub ? 'club':'general'); refreshUnitSelects(); f.elements.unitId.value=x.unitId || ''; f.elements.startAt.value=M.toLocalDateTimeInput(x.startAt); f.elements.endAt.value=M.toLocalDateTimeInput(x.endAt); f.elements.id.value=id; f.elements.active.checked=x.active===true; f.elements.verified.checked=x.verified===true; byId('promotionModalTitle').textContent='Editar promoção'; M.openModal('promotionModal', { trigger }); }

  async function toggle(path,id,field,current,action,type) {
    if(!id || id === 'undefined' || id === 'null'){ M.toast('Não foi possível identificar o registro. Atualize a página e tente novamente.', 'error'); return; }
    try {
      if (path === 'promotions' && field === 'active') {
        const previous = state.promotions[id]; if (!previous) throw new Error('Promoção não encontrada.');
        const nextPromo = { ...previous, active:!current, updatedAt:serverTimestamp, updatedBy:state.user.uid };
        const updates={ [`promotions/${id}/active`]:!current, [`promotions/${id}/updatedAt`]:serverTimestamp, [`promotions/${id}/updatedBy`]:state.user.uid };
        addPromotionLiveUpdates(updates,id,nextPromo,previous);
        await db.ref().update(updates);
      } else if (path === 'market_units' && field === 'active') {
        const previous=state.units[id]; if(!previous) throw new Error('Unidade não encontrada.');
        const next={...previous,active:!current,updatedAt:serverTimestamp,updatedBy:state.user.uid,id};
        const updates={ [`market_units/${id}/active`]:!current, [`market_units/${id}/updatedAt`]:serverTimestamp, [`market_units/${id}/updatedBy`]:state.user.uid };
        addGeoUnitUpdate(updates,id,next,previous);
        await db.ref().update(updates);
      } else if (path === 'markets' && field === 'active') {
        const previous=state.markets[id]; if(!previous) throw new Error('Mercado não encontrado.');
        const next={...previous,active:!current,updatedAt:serverTimestamp,updatedBy:state.user.uid};
        const updates={ [`markets/${id}/active`]:!current, [`markets/${id}/updatedAt`]:serverTimestamp, [`markets/${id}/updatedBy`]:state.user.uid };
        addMarketGeoCatalogUpdates(updates,id,next);
        await db.ref().update(updates);
      } else {
        await db.ref(`${path}/${id}`).update({ [field]: !current, updatedAt: serverTimestamp, updatedBy: state.user.uid });
      }
      await audit(action,type,id,{[field]:!current}); M.toast('Status atualizado.', 'success');
    } catch(error) { console.error('[Mercador IA] Falha ao alterar status', {path,id,field,error}); M.toast(error?.code === 'PERMISSION_DENIED' || /permission/i.test(error?.message || '') ? 'O Firebase recusou essa alteração. Verifique sua permissão de administrador.' : 'Não foi possível atualizar o status.', 'error', 7000); }
  }


  function getPdfImport() {
    return state.pdfImport;
  }

  function extractFirstSourceUrl(text) {
    const match = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
    return match ? match[0].replace(/[),.;!?]+$/, '') : '';
  }

  function detectValidityHint(text) {
    const raw = String(text || '');
    const full = raw.match(/(?:ofertas?|pre[cç]os?)\s+v[aá]lid[oa]s?[^0-9]{0,35}(?:de\s*)?(\d{1,2})\s*(?:a|até|-)\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/i);
    if (full) return `${full[1].padStart(2,'0')} a ${full[2].padStart(2,'0')}/${full[3].padStart(2,'0')}/${full[4]}`;
    const single = raw.match(/(?:ofertas?|pre[cç]os?)\s+v[aá]lid[oa]s?[^0-9]{0,35}(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/i);
    return single ? `${single[1].padStart(2,'0')}/${single[2].padStart(2,'0')}/${single[3]}` : '';
  }

  function countPriceSignals(text) {
    return (String(text || '').match(/R\$\s*\d{1,4}(?:[.,]\d{2})?/gi) || []).length;
  }

  function updatePdfSourceSummary() {
    const box = byId('pdfImportSourceSummary');
    if (!box) return;
    const files = [...(byId('pdfImportFile')?.files || [])];
    const text = byId('pdfImportText')?.value?.trim() || '';
    const urlInput = byId('pdfImportSourceUrl');
    const detectedUrl = extractFirstSourceUrl(text);
    if (detectedUrl && urlInput && !urlInput.value.trim()) urlInput.value = detectedUrl;
    const url = urlInput?.value?.trim() || detectedUrl;
    const validity = detectValidityHint(text);
    const priceSignals = countPriceSignals(text);
    box.className = 'pdf-source-diagnostic';
    if (files.length) {
      const types = [...new Set(files.map((f) => /^image\//.test(f.type) ? 'imagem' : (f.type === 'application/pdf' || /\.pdf$/i.test(f.name) ? 'PDF' : 'texto')))];
      const singlePdf = files.length === 1 && (files[0].type === 'application/pdf' || /\.pdf$/i.test(files[0].name));
      const largePdf = singlePdf && Number(files[0].size || 0) > 11.5 * 1024 * 1024;
      box.classList.add('ok');
      box.innerHTML = `<strong>${files.length} arquivo${files.length===1?'':'s'} pronto${files.length===1?'':'s'} para leitura</strong><span>${M.escapeHtml(types.join(' + '))}${url ? ` · origem: ${M.escapeHtml(url)}` : ''}. ${largePdf ? 'PDF grande detectado: não precisa compactar; o sistema tentará leitura multimodal por páginas e, se indisponível, continuará com análise local supervisionada. ' : ''}A fonte visual será a autoridade para produto e preço.</span>`;
      return;
    }
    if (text) {
      if (!priceSignals) box.classList.add('warn'); else box.classList.add('ok');
      box.innerHTML = `<strong>Texto detectado · ${priceSignals} sinal${priceSignals===1?'':'is'} explícito${priceSignals===1?'':'s'} de preço</strong><span>${validity ? `Validade citada: ${M.escapeHtml(validity)}. ` : ''}${url ? `URL preservada como origem: ${M.escapeHtml(url)}. ` : ''}${priceSignals ? 'As ofertas continuarão supervisionadas porque texto não possui geometria visual.' : 'Sem pares produto+preço explícitos, nenhuma promoção será criada. A URL não é usada para inventar conteúdo.'}</span>`;
      return;
    }
    box.innerHTML = '<strong>Fonte aguardando entrada</strong><span>Envie PDF/imagem ou cole texto contendo ofertas. Links encontrados no texto serão preservados como origem, mas nunca serão tratados como preço/produto.</span>';
  }

  function resetPdfImport() {
    state.pdfImport = null;
    const workspace = byId('pdfImportWorkspace');
    if (workspace) workspace.hidden = true;
    const progress = byId('pdfImportProgress');
    if (progress) progress.hidden = true;
    if (byId('pdfImportProgressBar')) byId('pdfImportProgressBar').style.width = '0%';
    if (byId('pdfImportStatus')) byId('pdfImportStatus').textContent = 'Selecione mercado, unidade e PDF/imagem ou cole o texto do encarte.';
    if (byId('pdfCandidatesList')) byId('pdfCandidatesList').innerHTML = '';
    if (byId('pdfImportMeta')) byId('pdfImportMeta').textContent = '';
    if (byId('pdfCandidateSearch')) byId('pdfCandidateSearch').value = '';
    if (byId('pdfCandidateFilter')) byId('pdfCandidateFilter').value = 'all';
    if (byId('pdfImportFile')) byId('pdfImportFile').value = '';
    if (byId('pdfImportText')) byId('pdfImportText').value = '';
    updatePdfSourceSummary();
  }

  function setPdfProgress(percent, text) {
    const progress = byId('pdfImportProgress');
    const bar = byId('pdfImportProgressBar');
    if (progress) progress.hidden = false;
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
    if (text && byId('pdfImportStatus')) byId('pdfImportStatus').textContent = text;
  }

  function confidenceLabel(value) {
    const n = Math.round(Number(value || 0) * 100);
    if (n >= 98) return { n, label:'muito alta', klass:'ok' };
    if (n >= 90) return { n, label:'alta', klass:'info' };
    if (n >= 75) return { n, label:'média', klass:'warn' };
    return { n, label:'baixa', klass:'danger' };
  }

  const PDF_RISK_LABELS = {
    association_disagreement: 'associação produto↔preço conflitante',
    single_association_pass: 'apenas uma associação espacial',
    short_product_name: 'descrição curta',
    missing_validity: 'validade não identificada',
    too_many_prices: 'mais de dois preços no mesmo bloco',
    ambiguous_price_kind: 'tipo do preço ambíguo',
    invalid_price: 'preço inválido',
    invalid_previous_price: 'preço anterior inconsistente',
    header_contamination: 'texto de cabeçalho misturado',
    price_inside_product_text: 'preço misturado ao nome',
    overlong_product_text: 'descrição excessivamente longa',
    missing_club_name: 'programa/clube sem nome',
    price_cluster_disagreement: 'preços próximos parecem pertencer a produtos diferentes',
    ocr_price_without_currency: 'OCR identificou valor sem marcador R$',
    ocr_low_text_confidence: 'OCR com baixa confiança na descrição',
    ocr_low_price_confidence: 'OCR com baixa confiança no preço',
    ocr_validity_inferred: 'validade inferida pelo nome do arquivo',
    ocr_price_single_pass: 'preço apareceu em apenas uma leitura OCR',
    ocr_price_scale_suspicious: 'tamanho visual do valor não parece preço de oferta',
    ocr_price_conflict: 'leituras OCR discordaram sobre o preço nesta região',
    ocr_low_description_quality: 'descrição visual não tem qualidade suficiente para publicação',
    ocr_block_ownership_weak: 'bloco de produto não pertence com segurança a este preço',
    knowledge_legacy_description_conflict: 'JSON de conhecimento e validador independente discordaram sobre o produto',
    text_source_no_geometry: 'texto sem geometria visual — conferência manual obrigatória',
    text_price_without_currency: 'texto contém preço sem marcador R$ confirmado',
    image_price_conflict: 'leituras da imagem discordaram sobre o valor deste card',
    image_text_single_pass: 'descrição do card apareceu em apenas uma leitura da imagem',
    image_grid_incomplete: 'grade visual do encarte não foi reconstruída por completo',
    invalid_source_geometry: 'região visual do card não foi localizada com segurança',
    source_geometry_conflict: 'as leituras discordaram sobre a posição do card'
    ,ai_unavailable_local_review: 'motor multimodal opcional indisponível — conferência local obrigatória'
  };

  function automationThreshold() {
    const raw = Number(byId('pdfAutomationMode')?.value || .98);
    return Number.isFinite(raw) ? Math.max(.97, Math.min(.99, raw)) : .98;
  }

  function classifyPdfCandidate(candidate, threshold = automationThreshold()) {
    if (candidate.published) return 'published';
    if (candidate.ignored) return 'ignored';
    if (candidate.verified && candidate.verificationMode === 'manual') return 'manual';
    const risks = new Set(candidate.riskFlags || []);
    candidate.riskFlags = [...risks];
    const hardBlock = ['association_disagreement','missing_validity','too_many_prices','ambiguous_price_kind','invalid_price','invalid_previous_price','header_contamination','price_inside_product_text','price_cluster_disagreement','ocr_price_without_currency','ocr_low_price_confidence','ocr_validity_inferred','ocr_price_scale_suspicious','ocr_price_conflict','ocr_low_description_quality','ocr_block_ownership_weak','knowledge_legacy_description_conflict','text_source_no_geometry','text_price_without_currency','image_price_conflict','image_text_single_pass','image_grid_incomplete','invalid_source_geometry','source_geometry_conflict']
      .some((x) => risks.has(x));
    const confidence = Number(candidate.confidence || 0);
    // Fail-closed: o painel nunca promove para automático um candidato que o motor marcou automationSafe=false.
    // structuralSafe significa apenas que a estrutura pode ser supervisionada; não é autorização de publicação automática.
    if (!hardBlock && candidate.automationSafe === true && confidence >= threshold) return 'auto';
    if (!hardBlock && candidate.structuralSafe === true && confidence >= .90) return 'supervised';
    if (!hardBlock && confidence >= .90) return 'supervised';
    return 'review';
  }

  function refreshPdfClassifications() {
    const imp = getPdfImport();
    if (!imp) return;
    const threshold = imp.threshold || automationThreshold();
    imp.threshold = threshold;
    imp.candidates.forEach((candidate) => {
      if (!candidate.published && !candidate.ignored && !(candidate.verified && candidate.verificationMode === 'manual')) {
        candidate.automationDecision = classifyPdfCandidate(candidate, threshold);
      }
    });
  }

  function pdfCandidateStatus(candidate) {
    if (candidate.published) return { label:candidate.verificationMode === 'automatic' ? 'publicado automático' : 'publicado', klass:'info' };
    if (candidate.ignored) return { label:'ignorado', klass:'danger' };
    if (candidate.verified && candidate.verificationMode === 'manual') return { label:'conferido manualmente', klass:'ok' };
    if (candidate.automationDecision === 'auto') return { label:'automático seguro', klass:'ok' };
    if (candidate.automationDecision === 'supervised') return { label:'supervisionado', klass:'warn' };
    return { label:'revisão necessária', klass:'danger' };
  }

  function renderPdfImport() {
    const imp = getPdfImport();
    const workspace = byId('pdfImportWorkspace');
    if (!imp || !workspace) {
      if (workspace) workspace.hidden = true;
      return;
    }
    refreshPdfClassifications();
    workspace.hidden = false;
    const candidates = imp.candidates || [];
    const autoPending = candidates.filter((x) => !x.published && !x.ignored && x.automationDecision === 'auto').length;
    const manualReady = candidates.filter((x) => x.verified && x.verificationMode === 'manual' && !x.published && !x.ignored).length;
    const reviewPending = candidates.filter((x) => !x.published && !x.ignored && x.automationDecision !== 'auto' && !(x.verified && x.verificationMode === 'manual')).length;
    const published = candidates.filter((x) => x.published).length;
    const ignored = candidates.filter((x) => x.ignored).length;
    byId('pdfKpiCandidates').textContent = candidates.length;
    const sourceTypeLabel = imp.result.sourceLabel || (imp.result.sourceType === 'image' ? 'Imagem' : (imp.result.sourceType === 'text' ? 'Texto/OCR' : 'PDF'));
    byId('pdfKpiPagesFoot').textContent = `${imp.result.numPages || 0} página${imp.result.numPages === 1 ? '' : 's'} · ${sourceTypeLabel}`;
    byId('pdfKpiAuto').textContent = autoPending;
    byId('pdfKpiReview').textContent = reviewPending;
    byId('pdfKpiPublished').textContent = published;

    const validity = imp.result.validity || {};
    const validityText = validity.startAt && validity.endAt
      ? `${M.formatDateOnly(validity.startAt)} a ${M.formatDateOnly(validity.endAt)}`
      : 'validade não confirmada automaticamente';
    const thresholdPct = Math.round((imp.threshold || .98) * 100);
    const km = imp.result.knowledgeMetrics || null;
    const knowledgeInfo = km ? `<br><strong>Arquivo de conhecimento:</strong> ${M.escapeHtml(imp.result.knowledgeSchemaVersion || 'mercador.encarte.knowledge.v1')} · ${km.words || 0} palavras · ${km.lines || 0} linhas · ${km.prices || 0} fatos de preço · modos ${M.escapeHtml((km.modes || []).join(' + ') || '—')}` : '';
    const engineDetail = imp.result.sourceType === 'pdf' ? ` / PDF.js ${M.escapeHtml(imp.result.pdfjsVersion || '')}` : '';
    byId('pdfImportMeta').innerHTML = `<div class="pdf-automation-summary">Fonte: <strong>${M.escapeHtml(sourceTypeLabel)}</strong> · Arquivo: <strong>${M.escapeHtml(imp.result.fileName)}</strong> · ${imp.result.numPages} página${imp.result.numPages === 1 ? '' : 's'} · ${M.escapeHtml(validityText)} · SHA-256 ${M.escapeHtml((imp.result.hash || '').slice(0,16))}…<br><strong>${autoPending}</strong> automáticos prontos · <strong>${manualReady}</strong> revisados prontos · <strong>${reviewPending}</strong> pendentes de revisão · <strong>${ignored}</strong> excluídos desta importação · limite automático <strong>${thresholdPct}%</strong> · motor ${M.escapeHtml(imp.result.engineVersion || 'desconhecido')}${engineDetail} · <strong>JSON de conhecimento</strong>${knowledgeInfo}</div>`;

    const q = M.normalizeText(byId('pdfCandidateSearch')?.value || '');
    const filter = byId('pdfCandidateFilter')?.value || 'all';
    let list = candidates.filter((x) => !q || M.normalizeText(`${x.productName} ${x.category} ${x.brand} ${x.packageText}`).includes(q));
    if (filter === 'auto') list = list.filter((x) => !x.published && !x.ignored && x.automationDecision === 'auto');
    if (filter === 'pending') list = list.filter((x) => !x.published && !x.ignored && x.automationDecision !== 'auto' && !(x.verified && x.verificationMode === 'manual'));
    if (filter === 'verified') list = list.filter((x) => x.verified && x.verificationMode === 'manual' && !x.published && !x.ignored);
    if (filter === 'published') list = list.filter((x) => x.published);
    if (filter === 'ignored') list = list.filter((x) => x.ignored);
    if (filter === 'low') list = list.filter((x) => Number(x.confidence || 0) < .90 && !x.ignored);

    byId('pdfCandidatesList').innerHTML = list.length ? list.map((x) => {
      const conf = confidenceLabel(x.confidence);
      const status = pdfCandidateStatus(x);
      const hasOld = Number(x.previousPrice) > Number(x.price);
      const priceType = x.priceKind === 'club' ? `💳 ${x.clubName || 'Preço Clube'}` : (x.priceKind === 'condition' ? 'Preço com condição' : (x.priceKind === 'review' ? 'tipo de preço a confirmar' : 'preço geral'));
      const decisionClass = x.automationDecision === 'auto' ? 'auto-approved' : (x.automationDecision === 'supervised' ? 'needs-review' : (x.automationDecision === 'review' ? 'blocked-auto' : ''));
      const riskHtml = (x.riskFlags || []).length ? `<div class="pdf-risk-list">${x.riskFlags.map((r) => `<span class="pdf-risk-chip">⚠ ${M.escapeHtml(PDF_RISK_LABELS[r] || r)}</span>`).join('')}</div>` : '';
      const evidenceHtml = (x.evidence || []).length ? `<div class="pdf-evidence-list">${x.evidence.slice(0,5).map((e) => `<span class="pdf-evidence-chip">✓ ${M.escapeHtml(e)}</span>`).join('')}</div>` : '';
      return `<article class="entity-card pdf-candidate-card ${decisionClass} ${x.verified ? 'verified':''} ${x.published ? 'published':''} ${x.ignored ? 'ignored':''}">
        <div class="pdf-candidate-main">
          <div>
            <div class="entity-title">${M.escapeHtml(x.productName)}</div>
            <div class="small muted">Página ${x.pageNumber} · ${M.escapeHtml(x.category || 'outros')}${x.packageText ? ` · ${M.escapeHtml(x.packageText)}`:''}</div>
            <div class="entity-meta">
              <span class="badge ${status.klass}">${status.label}</span>
              <span class="badge ${conf.klass}">confiança ${conf.n}% · ${conf.label}</span>
              <span class="badge">${M.escapeHtml(priceType)}</span>
              ${x.detectedPrices?.length > 1 ? `<span class="badge warn">${x.detectedPrices.length} preços detectados</span>`:''}
            </div>
            ${evidenceHtml}${riskHtml}
            ${x.conditions ? `<div class="small muted pdf-source-meta">Condições: ${M.escapeHtml(x.conditions)}</div>`:''}
          </div>
          <div class="pdf-price-stack">
            <span class="pdf-price-main">${M.formatCurrency(x.price)}</span>
            ${hasOld ? `<span class="pdf-price-old">${M.formatCurrency(x.previousPrice)}</span>`:''}
          </div>
        </div>
        <div class="pdf-confidence ${conf.n < 90 ? 'low':''}">
          <div class="pdf-confidence-track"><span style="width:${conf.n}%"></span></div>
          <span class="small muted">Associação dupla: ${Math.round(Number(x.associationAgreement || 0) * 100)}% · domínio do bloco: ${Math.round(Number(x.ownershipConfidence || 0) * 100)}% · coerência do bloco: ${Math.round(Number(x.clusterCoherence || 0) * 100)}%.</span>
        </div>
        <div class="entity-actions pdf-candidate-actions" style="margin-top:12px">
          ${x.published ? `<button class="btn btn-secondary btn-sm" type="button" data-pdf-review="${M.escapeHtml(x.id)}">Ver origem</button>` : (x.ignored ? `<button class="btn btn-secondary btn-sm" type="button" data-pdf-restore="${M.escapeHtml(x.id)}">Restaurar candidato</button>` : `<button class="btn btn-secondary btn-sm" type="button" data-pdf-review="${M.escapeHtml(x.id)}">${x.automationDecision === 'auto' ? 'Ver evidência' : 'Revisar exceção'}</button><button class="btn btn-danger btn-sm" type="button" data-pdf-ignore-quick="${M.escapeHtml(x.id)}">Excluir da importação</button>`)}
        </div>
      </article>`;
    }).join('') : '<div class="empty">Nenhum candidato neste filtro.</div>';

    const publishBtn = byId('pdfPublishVerifiedBtn');
    if (publishBtn) {
      publishBtn.disabled = manualReady === 0;
      publishBtn.textContent = manualReady ? `Publicar ${manualReady} revisada${manualReady === 1 ? '' : 's'}` : 'Publicar revisados';
    }
    const autoBtn = byId('pdfPublishAutoBtn');
    if (autoBtn) {
      autoBtn.disabled = autoPending === 0;
      autoBtn.textContent = autoPending ? `Publicar ${autoPending} automática${autoPending === 1 ? '' : 's'}` : 'Publicar automáticos seguros';
    }
    const readyBtn = byId('pdfPublishReadyBtn');
    const readyCount = autoPending + manualReady;
    if (readyBtn) {
      readyBtn.disabled = readyCount === 0;
      readyBtn.textContent = readyCount ? `Publicar ${readyCount} pronta${readyCount === 1 ? '' : 's'}` : 'Publicar tudo que está pronto';
    }
    const discardBtn = byId('pdfDiscardPendingBtn');
    if (discardBtn) {
      discardBtn.disabled = reviewPending === 0;
      discardBtn.textContent = reviewPending ? `Excluir ${reviewPending} pendente${reviewPending === 1 ? '' : 's'}` : 'Excluir pendentes de revisão';
    }
    const knowledgeBtn = byId('pdfDownloadKnowledgeBtn');
    if (knowledgeBtn) {
      knowledgeBtn.disabled = !imp.result?.knowledgeDocument;
      knowledgeBtn.title = imp.result?.knowledgeDocument ? 'Baixar o documento JSON usado como fonte de conhecimento da extração' : 'O JSON aparece depois da análise do encarte';
    }
  }

  function downloadPdfKnowledge() {
    const imp = getPdfImport();
    const knowledge = imp?.result?.knowledgeDocument;
    if (!knowledge) { M.toast('Analise um encarte antes de baixar o JSON de conhecimento.', 'warning'); return; }
    try {
      if (window.MercadorPDFImporter?.downloadKnowledgeJson) window.MercadorPDFImporter.downloadKnowledgeJson(knowledge, imp.result.fileName || 'encarte');
      else {
        const blob = new Blob([JSON.stringify(knowledge, null, 2)], { type:'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = `${String(imp.result.fileName || 'encarte').replace(/\.pdf$/i,'').replace(/[^a-z0-9._-]+/gi,'_')}.mercador-knowledge.json`;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      M.toast('JSON de conhecimento gerado a partir do encarte analisado.', 'success', 5000);
    } catch(error) { console.error(error); M.toast(error.message || 'Não foi possível gerar o JSON de conhecimento.', 'error', 7000); }
  }

  async function analyzePdfImport(event) {
    event.preventDefault();
    const importer = window.MercadorPDFImporter;
    if (!importer) { M.toast('Módulo de encartes não carregado. Verifique a conexão e recarregue o painel.', 'error', 7000); return; }
    const marketId = byId('pdfImportMarketId').value;
    const unitId = byId('pdfImportUnitId').value;
    const files = [...(byId('pdfImportFile').files || [])];
    const pastedText = byId('pdfImportText')?.value?.trim() || '';
    const detectedSourceUrl = extractFirstSourceUrl(pastedText);
    if (detectedSourceUrl && byId('pdfImportSourceUrl') && !byId('pdfImportSourceUrl').value.trim()) byId('pdfImportSourceUrl').value = detectedSourceUrl;
    updatePdfSourceSummary();
    const unit = getUnit(unitId);
    if (!marketId || !unitId || !unit || unit.marketId !== marketId) { M.toast('Selecione um mercado e uma unidade válidos.', 'warning'); return; }
    if (!files.length && !pastedText) { M.toast('Selecione um PDF/imagem ou cole o texto do encarte.', 'warning'); return; }
    if (files.length && pastedText) { M.toast('Use um tipo de entrada por vez: arquivo/imagens OU texto colado.', 'warning'); return; }

    const btn = byId('pdfImportAnalyzeBtn');
    M.setBusy(btn, true, 'Analisando e conferindo...');
    setPdfProgress(2, 'Carregando a inteligência documental...');
    try {
      const lowerPriceIsClub = byId('pdfImportLowerIsClub').checked;
      const clubName = byId('pdfImportClubName').value.trim();
      const threshold = automationThreshold();
      const suppliedStartAt = M.toTimestampFromLocalInput(byId('pdfImportStartAt').value);
      const suppliedEndAt = M.toTimestampFromLocalInput(byId('pdfImportEndAt').value);
      const options = { lowerPriceIsClub, clubName, suppliedStartAt, suppliedEndAt };
      const progressCallback = (progress) => {
        const mode = String(progress.mode || '');
        const aiStages = {
          'ai-professional-a':'1ª leitura multimodal da fonte',
          'ai-professional-b':'2ª leitura independente',
          'ai-professional-c':'auditoria final olhando novamente a fonte',
          'ai-pdf-page-a':`página ${progress.pageNumber}: 1ª leitura`,
          'ai-pdf-page-b':`página ${progress.pageNumber}: 2ª leitura independente`,
          'ai-pdf-page-c':`página ${progress.pageNumber}: auditoria final`,
          'pdf-auto-render':`preparando automaticamente a página ${progress.pageNumber}`,
          'ai-professional-complete':'conciliação concluída',
          'local-fallback-start':'motor multimodal indisponível; continuando com análise local supervisionada',
          'local-fallback-complete':'análise local supervisionada concluída'
        };
        if (aiStages[mode]) {
          setPdfProgress(progress.percent, `${aiStages[mode]} · ${progress.numPages || 1} página${Number(progress.numPages || 1) === 1 ? '' : 's'}`);
          return;
        }
        const sourceLabel = mode.startsWith('image') ? 'imagem' : (mode.startsWith('text') ? 'texto' : 'página');
        setPdfProgress(progress.percent, `Conferindo ${sourceLabel} ${progress.pageNumber} de ${progress.numPages}...`);
      };
      const result = typeof importer.analyzeSource === 'function'
        ? await importer.analyzeSource({ files, text:pastedText }, options, progressCallback)
        : await importer.analyzeFile(files[0], options, progressCallback);
      if (!result.engineVersion) result.engineVersion = importer.ENGINE_VERSION || '2.2.0';
      if (result.validity?.startAt && !byId('pdfImportStartAt').value) byId('pdfImportStartAt').value = M.toLocalDateTimeInput(result.validity.startAt);
      if (result.validity?.endAt && !byId('pdfImportEndAt').value) byId('pdfImportEndAt').value = M.toLocalDateTimeInput(result.validity.endAt);

      state.pdfImport = {
        result,
        candidates: (result.candidates || []).map((x) => ({ ...x, detectedProductName: x.detectedProductName || x.productName })),
        marketId,
        unitId,
        sourceUrl: byId('pdfImportSourceUrl').value.trim(),
        sourceType: result.sourceType || 'pdf',
        lowerPriceIsClub,
        clubName,
        threshold
      };
      refreshPdfClassifications();
      const autoCount = state.pdfImport.candidates.filter((x) => x.automationDecision === 'auto').length;
      const reviewCount = state.pdfImport.candidates.filter((x) => x.automationDecision !== 'auto').length;
      setPdfProgress(100, `${result.candidates?.length || 0} ofertas detectadas: ${autoCount} seguras para automação e ${reviewCount} exceções.`);
      renderPdfImport();
      await audit('encarte_import_analyzed_v3', 'encarte_import', (result.hash || '').slice(0,20), { sourceType:result.sourceType || 'pdf', fileName:result.fileName, pages:result.numPages, candidates:result.candidates?.length || 0, auto:autoCount, review:reviewCount, threshold, marketId, unitId, engineVersion:result.engineVersion, knowledgeSchemaVersion:result.knowledgeSchemaVersion || '', knowledgeMetrics:result.knowledgeMetrics || null });
      if (!result.candidates?.length) {
        const textOnlyWithoutPrices = (result.sourceType === 'text' || (!files.length && pastedText)) && countPriceSignals(pastedText) === 0;
        M.toast(textOnlyWithoutPrices ? 'O texto não contém ofertas com produto + preço explícito. A URL e a validade foram reconhecidas como referência, mas nenhuma promoção foi inventada.' : 'A fonte foi lida, mas nenhuma oferta pôde ser reconstruída com segurança.', 'warning', 9000);
      } else if (byId('pdfAutoPublish')?.checked && autoCount) {
        await publishAutomaticPdfCandidates(true);
        const remaining = state.pdfImport.candidates.filter((x) => !x.published && !x.ignored && x.automationDecision !== 'auto').length;
        setPdfProgress(100, `Automação concluída. ${remaining} exceção${remaining === 1 ? '' : 'ões'} aguardando revisão.`);
        M.toast(`Automação concluída. Revise somente ${remaining} exceção${remaining === 1 ? '' : 'ões'}.`, remaining ? 'info' : 'success', 7000);
      } else if (result.aiFallback) {
        M.toast(`Análise local concluída: ${reviewCount} oferta${reviewCount === 1 ? '' : 's'} para conferência. Nenhuma publicação automática foi liberada.`, 'info', 7500);
      } else {
        M.toast(`Análise concluída: ${autoCount} automáticas e ${reviewCount} para supervisão.`, 'success', 6500);
      }
    } catch (error) {
      console.error(error);
      state.pdfImport = null;
      byId('pdfImportWorkspace').hidden = true;
      setPdfProgress(0, error.message || 'Falha ao analisar o encarte.');
      M.toast(error.message || 'Falha ao analisar o encarte.', 'error', 8000);
    } finally {
      M.setBusy(btn, false);
    }
  }

  async function openPdfReview(candidateId, trigger) {
    const imp = getPdfImport();
    const candidate = imp?.candidates.find((x) => x.id === candidateId);
    if (!candidate) return;
    const f = byId('pdfReviewForm');
    f.reset();
    f.elements.candidateId.value = candidate.id;
    f.elements.productName.value = candidate.productName || '';
    f.elements.category.value = candidate.category || M.inferCategory(candidate.productName) || 'outros';
    f.elements.brand.value = candidate.brand || '';
    f.elements.packageText.value = candidate.packageText || '';
    f.elements.price.value = Number(candidate.price || 0).toFixed(2);
    f.elements.previousPrice.value = Number(candidate.previousPrice) > 0 ? Number(candidate.previousPrice).toFixed(2) : '';
    f.elements.priceKind.value = candidate.priceKind === 'review' ? '' : (candidate.priceKind || 'general');
    f.elements.clubName.value = candidate.clubName || imp.clubName || '';
    f.elements.conditions.value = candidate.conditions || '';
    const globalStart = M.toTimestampFromLocalInput(byId('pdfImportStartAt').value);
    const globalEnd = M.toTimestampFromLocalInput(byId('pdfImportEndAt').value);
    f.elements.startAt.value = M.toLocalDateTimeInput(candidate.startAt || globalStart || imp.result.validity?.startAt);
    f.elements.endAt.value = M.toLocalDateTimeInput(candidate.endAt || globalEnd || imp.result.validity?.endAt);
    f.elements.verified.checked = candidate.verified === true;
    const reviewSourceLabel = imp.result.sourceLabel || (imp.result.sourceType === 'image' ? 'Imagem' : (imp.result.sourceType === 'text' ? 'Texto/OCR' : 'PDF'));
    byId('pdfReviewSource').textContent = `${reviewSourceLabel} · ${imp.result.fileName} · página ${candidate.pageNumber} · SHA-256 ${(imp.result.hash || '').slice(0,16)}…`;
    byId('pdfDetectedPrices').textContent = `Valores detectados nesta região: ${(candidate.detectedPrices || [candidate.price]).map(M.formatCurrency).join(' · ')}. A detecção automática é apenas uma sugestão; confira a evidência de origem acima.`;
    M.openModal('pdfReviewModal', { trigger });
    const canvas = byId('pdfReviewCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 560; canvas.height = 160;
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = '#333'; ctx.font = '16px sans-serif'; ctx.fillText('Renderizando recorte da página...', 20, 50);
    try {
      await window.MercadorPDFImporter.renderPreview(candidate, canvas);
    } catch (error) {
      console.error(error);
      M.toast('Não foi possível renderizar o recorte, mas os dados podem ser revisados manualmente.', 'warning');
    }
  }

  function savePdfReview(event) {
    event.preventDefault();
    const imp = getPdfImport();
    if (!imp) return;
    const f = event.currentTarget;
    const candidate = imp.candidates.find((x) => x.id === f.elements.candidateId.value);
    if (!candidate || candidate.published) { M.closeModal('pdfReviewModal'); return; }

    const price = Number(f.elements.price.value);
    const previousPrice = f.elements.previousPrice.value ? Number(f.elements.previousPrice.value) : null;
    const startAt = M.toTimestampFromLocalInput(f.elements.startAt.value);
    const endAt = M.toTimestampFromLocalInput(f.elements.endAt.value);
    const priceKind = f.elements.priceKind.value;
    const clubName = f.elements.clubName.value.trim();
    const conditions = f.elements.conditions.value.trim();
    if (!Number.isFinite(price) || price <= 0) { M.toast('Informe o preço correto do encarte.', 'warning'); return; }
    if (!startAt || !endAt || endAt <= startAt) { M.toast('Confira o período de validade.', 'warning'); return; }
    if (!priceKind) { M.toast('Defina se é preço geral, Clube ou outra condição.', 'warning'); return; }
    if (priceKind === 'club' && !clubName) { M.toast('Informe o nome do Clube/programa exigido pelo preço.', 'warning'); return; }
    if (priceKind === 'condition' && !conditions) { M.toast('Descreva a condição necessária para esse preço.', 'warning'); return; }
    if (f.elements.verified.checked && (!f.elements.productName.value.trim() || !f.elements.category.value.trim())) { M.toast('Produto e categoria precisam estar conferidos.', 'warning'); return; }

    Object.assign(candidate, {
      productName: f.elements.productName.value.trim(),
      category: M.slugify(f.elements.category.value).replaceAll('-','_') || M.inferCategory(f.elements.productName.value) || 'outros',
      brand: f.elements.brand.value.trim(),
      packageText: f.elements.packageText.value.trim(),
      price,
      previousPrice: Number.isFinite(previousPrice) && previousPrice > price ? previousPrice : null,
      priceKind,
      requiresClub: priceKind === 'club',
      clubName: priceKind === 'club' ? clubName : '',
      conditions: conditions.slice(0,250),
      startAt,
      endAt,
      verified: f.elements.verified.checked,
      verificationMode: f.elements.verified.checked ? 'manual' : '',
      automationDecision: f.elements.verified.checked ? 'manual' : classifyPdfCandidate(candidate, imp.threshold || automationThreshold()),
      reviewed: true,
      ignored: false
    });
    M.closeModal('pdfReviewModal');
    renderPdfImport();
    M.toast(candidate.verified ? 'Oferta conferida e pronta para publicação.' : 'Revisão salva. O item ainda não será publicado.', candidate.verified ? 'success' : 'info');
  }

  function markPdfCandidateIgnored(candidate, reason = 'manual_discard') {
    if (!candidate || candidate.published) return false;
    candidate.ignored = true;
    candidate.verified = false;
    candidate.verificationMode = '';
    candidate.reviewed = true;
    candidate.discardReason = reason;
    candidate.discardedAt = Date.now();
    candidate.discardedBy = state.user?.uid || '';
    return true;
  }

  async function ignorePdfCandidate() {
    const imp = getPdfImport();
    const f = byId('pdfReviewForm');
    const candidate = imp?.candidates.find((x) => x.id === f.elements.candidateId.value);
    if (!markPdfCandidateIgnored(candidate, 'manual_review_discard')) return;
    M.closeModal('pdfReviewModal');
    renderPdfImport();
    audit('pdf_import_candidate_discarded', 'pdf_import', (imp?.result?.hash || '').slice(0,20), { candidateId:candidate.id, productName:candidate.productName, page:candidate.pageNumber, reason:'manual_review_discard' }).catch(console.error);
    M.toast('Candidato excluído desta importação. Nada foi gravado em Promoções.', 'info');
  }

  async function discardPdfCandidateById(candidateId) {
    const imp = getPdfImport();
    const candidate = imp?.candidates.find((x) => x.id === candidateId);
    if (!candidate || candidate.published || candidate.ignored) return;
    if (!window.confirm(`Excluir "${candidate.productName}" desta importação? Esse candidato não será publicado.`)) return;
    markPdfCandidateIgnored(candidate, 'quick_discard');
    renderPdfImport();
    audit('pdf_import_candidate_discarded', 'pdf_import', (imp?.result?.hash || '').slice(0,20), { candidateId:candidate.id, productName:candidate.productName, page:candidate.pageNumber, reason:'quick_discard' }).catch(console.error);
    M.toast('Candidato excluído da importação.', 'info');
  }

  function restorePdfCandidate(candidateId) {
    const imp = getPdfImport();
    const candidate = imp?.candidates.find((x) => x.id === candidateId);
    if (!candidate || candidate.published || !candidate.ignored) return;
    candidate.ignored = false;
    candidate.reviewed = false;
    candidate.discardReason = '';
    candidate.discardedAt = null;
    candidate.discardedBy = '';
    candidate.automationDecision = classifyPdfCandidate(candidate, imp.threshold || automationThreshold());
    renderPdfImport();
    M.toast('Candidato restaurado para a fila.', 'success');
  }

  async function discardAllPendingPdfCandidates() {
    const imp = getPdfImport();
    if (!imp) return;
    refreshPdfClassifications();
    const pending = imp.candidates.filter((x) => !x.published && !x.ignored && x.automationDecision !== 'auto' && !(x.verified && x.verificationMode === 'manual'));
    if (!pending.length) { M.toast('Não há pendências de revisão para excluir.', 'info'); return; }
    const ok = window.confirm(`Excluir ${pending.length} candidato${pending.length === 1 ? '' : 's'} que ainda precisa${pending.length === 1 ? '' : 'm'} de revisão?\n\nOs automáticos e os que você já revisou permanecerão prontos/publicados. Os excluídos NÃO serão gravados em Promoções.`);
    if (!ok) return;
    pending.forEach((candidate) => markPdfCandidateIgnored(candidate, 'bulk_pending_discard'));
    byId('pdfCandidateFilter').value = 'all';
    renderPdfImport();
    audit('pdf_import_pending_bulk_discarded', 'pdf_import', (imp.result.hash || '').slice(0,20), { count:pending.length, fileName:imp.result.fileName, marketId:imp.marketId, unitId:imp.unitId }).catch(console.error);
    M.toast(`${pending.length} pendência${pending.length === 1 ? '' : 's'} excluída${pending.length === 1 ? '' : 's'} da importação.`, 'success', 6500);
  }

  function pdfPromotionFingerprint(candidate, imp) {
    return [
      imp.result.hash || '',
      imp.unitId || '',
      M.normalizeText(candidate.productName || ''),
      M.normalizeText(candidate.packageText || ''),
      Number(candidate.price || 0).toFixed(2),
      candidate.priceKind || 'general',
      candidate.requiresClub ? M.normalizeText(candidate.clubName || '') : ''
    ].join('|');
  }

  function isDuplicatePdfPromotion(candidate, imp) {
    const fingerprint = pdfPromotionFingerprint(candidate, imp);
    return Object.values(state.promotions || {}).some((promo) => {
      if (!promo || !promo.sourceHash || promo.sourceHash !== imp.result.hash || promo.unitId !== imp.unitId) return false;
      const existing = [
        promo.sourceHash || '',
        promo.unitId || '',
        M.normalizeText(promo.productName || ''),
        M.normalizeText(promo.packageText || ''),
        Number(promo.price || 0).toFixed(2),
        promo.priceKind || 'general',
        promo.requiresClub ? M.normalizeText(promo.clubName || '') : ''
      ].join('|');
      return existing === fingerprint;
    });
  }

  async function publishPdfCandidateSet(candidates, mode, silent = false) {
    const imp = getPdfImport();
    if (!imp || !candidates.length) return { created:0, duplicates:0 };
    const market = getMarket(imp.marketId);
    const unit = getUnit(imp.unitId);
    if (!market || !unit || unit.marketId !== imp.marketId) throw new Error('Mercado/unidade do encarte não estão mais válidos.');

    const updates = {};
    const created = [];
    const batchFingerprints = new Set();
    let duplicates = 0;
    candidates.forEach((candidate) => {
      const fingerprint = pdfPromotionFingerprint(candidate, imp);
      if (batchFingerprints.has(fingerprint) || isDuplicatePdfPromotion(candidate, imp)) {
        candidate.published = true;
        candidate.duplicate = true;
        duplicates += 1;
        return;
      }
      batchFingerprints.add(fingerprint);
      const startAt = Number(candidate.startAt || M.toTimestampFromLocalInput(byId('pdfImportStartAt').value) || imp.result.validity?.startAt || 0);
      const endAt = Number(candidate.endAt || M.toTimestampFromLocalInput(byId('pdfImportEndAt').value) || imp.result.validity?.endAt || 0);
      if (!startAt || !endAt || endAt <= startAt || !Number.isFinite(Number(candidate.price)) || Number(candidate.price) <= 0 || candidate.priceKind === 'review') {
        throw new Error(`A oferta "${candidate.productName}" não passou nas travas obrigatórias de publicação.`);
      }
      const key = db.ref('promotions').push().key;
      const sourceDocumentType = imp.result.sourceType || imp.sourceType || 'pdf';
      const sourceKindLabel = sourceDocumentType === 'image' ? 'IMAGEM' : (sourceDocumentType === 'text' ? 'TEXTO/OCR' : 'PDF');
      const sourceReference = `${sourceKindLabel} ${imp.result.fileName} · pág. ${candidate.pageNumber} · SHA256 ${(imp.result.hash || '').slice(0,16)}${imp.sourceUrl ? ' · fonte oficial informada' : ''}`.slice(0,250);
      const promoRecord = {
        marketId: imp.marketId,
        unitId: imp.unitId,
        productName: candidate.productName.slice(0,160),
        category: candidate.category || M.inferCategory(candidate.productName) || 'outros',
        brand: (candidate.brand || '').slice(0,80),
        packageText: (candidate.packageText || '').slice(0,80),
        price: Number(candidate.price),
        previousPrice: Number(candidate.previousPrice) > Number(candidate.price) ? Number(candidate.previousPrice) : null,
        startAt,
        endAt,
        sourceType: 'encarte',
        sourceDocumentType,
        sourceReference,
        sourceUrl: imp.sourceUrl || '',
        sourceFileName: imp.result.fileName,
        sourcePage: candidate.pageNumber,
        sourceHash: imp.result.hash || '',
        sourceBox: candidate.sourceBox || null,
        detectedProductName: candidate.detectedProductName || candidate.productName,
        importConfidence: Number(candidate.confidence || 0),
        priceKind: candidate.priceKind || 'general',
        requiresClub: candidate.requiresClub === true,
        clubName: candidate.requiresClub ? (candidate.clubName || '').slice(0,80) : '',
        conditions: (candidate.conditions || '').slice(0,250),
        aliases: '',
        verified: true,
        verificationMode: mode === 'automatic' ? 'automatic' : 'manual',
        automationEngineVersion: imp.result.engineVersion || '2.2.0',
        automationThreshold: Number(imp.threshold || .98),
        automationConfidence: Number(candidate.confidence || 0),
        automationEvidence: (candidate.evidence || []).slice(0,10),
        automationRiskFlags: (candidate.riskFlags || []).slice(0,10),
        verifiedAt: serverTimestamp,
        verifiedBy: state.user.uid,
        active: true,
        createdAt: serverTimestamp,
        createdBy: state.user.uid,
        updatedAt: serverTimestamp,
        updatedBy: state.user.uid
      };
      updates[`promotions/${key}`] = promoRecord;
      addPromotionLiveUpdates(updates, key, promoRecord, null);
      created.push({ candidate, key });
    });
    if (created.length) await db.ref().update(updates);
    created.forEach(({ candidate }) => {
      candidate.published = true;
      candidate.verified = true;
      candidate.verificationMode = mode === 'automatic' ? 'automatic' : 'manual';
    });
    if (created.length || duplicates) {
      await audit(mode === 'automatic' ? 'pdf_import_auto_published' : 'pdf_import_manual_published', 'pdf_import', (imp.result.hash || '').slice(0,20), {
        fileName: imp.result.fileName,
        sourceType: imp.result.sourceType || imp.sourceType || 'pdf',
        created: created.length,
        duplicates,
        marketId: imp.marketId,
        unitId: imp.unitId,
        pages: imp.result.numPages,
        sourceUrl: imp.sourceUrl || '',
        threshold: imp.threshold || .98,
        engineVersion: imp.result.engineVersion || '2.2.0'
      });
    }
    renderPdfImport();
    if (!silent) M.toast(`${created.length} promoção${created.length === 1 ? '' : 'ões'} publicada${created.length === 1 ? '' : 's'}${duplicates ? ` · ${duplicates} duplicada${duplicates === 1 ? '' : 's'} ignorada${duplicates === 1 ? '' : 's'}` : ''}.`, 'success', 7000);
    return { created:created.length, duplicates };
  }

  async function publishAutomaticPdfCandidates(silent = false) {
    const imp = getPdfImport();
    if (!imp) return { created:0, duplicates:0 };
    refreshPdfClassifications();
    const candidates = imp.candidates.filter((x) => !x.published && !x.ignored && x.automationDecision === 'auto');
    if (!candidates.length) {
      if (!silent) M.toast('Nenhuma oferta atingiu o nível de segurança para publicação automática.', 'warning');
      return { created:0, duplicates:0 };
    }
    const btn = byId('pdfPublishAutoBtn');
    if (btn && !silent) M.setBusy(btn, true, 'Publicando seguros...');
    try {
      return await publishPdfCandidateSet(candidates, 'automatic', silent);
    } catch (error) {
      console.error(error);
      if (!silent) M.toast(error.message || 'Falha na publicação automática.', 'error', 8000);
      else throw error;
      return { created:0, duplicates:0 };
    } finally {
      if (btn && !silent) M.setBusy(btn, false);
      renderPdfImport();
    }
  }

  async function publishVerifiedPdfCandidates() {
    const imp = getPdfImport();
    if (!imp) return;
    const candidates = imp.candidates.filter((x) => x.verified && x.verificationMode === 'manual' && !x.published && !x.ignored);
    if (!candidates.length) { M.toast('Nenhuma exceção conferida aguardando publicação.', 'warning'); return; }
    const btn = byId('pdfPublishVerifiedBtn');
    M.setBusy(btn, true, 'Publicando revisados...');
    try {
      await publishPdfCandidateSet(candidates, 'manual', false);
    } catch (error) {
      console.error(error);
      M.toast(error.message || 'Falha ao publicar promoções revisadas.', 'error', 8000);
    } finally {
      M.setBusy(btn, false);
      renderPdfImport();
    }
  }

  async function publishReadyPdfCandidates() {
    const imp = getPdfImport();
    if (!imp) return;
    refreshPdfClassifications();
    const automatic = imp.candidates.filter((x) => !x.published && !x.ignored && x.automationDecision === 'auto');
    const manual = imp.candidates.filter((x) => x.verified && x.verificationMode === 'manual' && !x.published && !x.ignored);
    const total = automatic.length + manual.length;
    if (!total) { M.toast('Não há ofertas prontas para publicar. Pendências de revisão permanecem fora do Firebase.', 'info'); return; }
    const btn = byId('pdfPublishReadyBtn');
    M.setBusy(btn, true, 'Publicando prontos...');
    let created = 0;
    let duplicates = 0;
    try {
      if (automatic.length) {
        const result = await publishPdfCandidateSet(automatic, 'automatic', true);
        created += result.created || 0;
        duplicates += result.duplicates || 0;
      }
      if (manual.length) {
        const result = await publishPdfCandidateSet(manual, 'manual', true);
        created += result.created || 0;
        duplicates += result.duplicates || 0;
      }
      const pending = imp.candidates.filter((x) => !x.published && !x.ignored && x.automationDecision !== 'auto' && !(x.verified && x.verificationMode === 'manual')).length;
      M.toast(`${created} promoção${created === 1 ? '' : 'ões'} publicada${created === 1 ? '' : 's'}${duplicates ? ` · ${duplicates} duplicada${duplicates === 1 ? '' : 's'} ignorada${duplicates === 1 ? '' : 's'}` : ''}. ${pending ? `${pending} pendência${pending === 1 ? '' : 's'} continua${pending === 1 ? '' : 'm'} fora da publicação.` : 'Nenhuma pendência ficou para trás.'}`, 'success', 8000);
    } catch (error) {
      console.error(error);
      M.toast(error.message || 'Falha ao publicar ofertas prontas.', 'error', 8000);
    } finally {
      M.setBusy(btn, false);
      renderPdfImport();
    }
  }

  const deleteState = { type: '', id: '', name: '', plan: null, trigger: null };

  function buildDeletePlan(type, id) {
    if (type === 'user') {
      const user=state.users[id]; if(!user || id===M.MASTER_UID) return null;
      return { type, id, name:user.name || user.email || id, user };
    }
    if (type === 'market') {
      const market = state.markets[id];
      if (!market) return null;
      const units = entries(state.units).filter((u) => u.marketId === id);
      const unitIds = new Set(units.map((u) => u.id));
      const promotions = entries(state.promotions).filter((p) => p.marketId === id || unitIds.has(p.unitId));
      const inbox = entries(state.inbox).filter((m) => m.marketId === id);
      return { type, id, name: market.name || id, units, promotions, inbox };
    }
    if (type === 'unit') {
      const unit = state.units[id];
      if (!unit) return null;
      const promotions = entries(state.promotions).filter((p) => p.unitId === id);
      return { type, id, name: `${getMarket(unit.marketId)?.name || 'Mercado'} · ${unit.name || id}`, unit, promotions };
    }
    if (type === 'promotion') {
      const promotion = state.promotions[id];
      if (!promotion) return null;
      return { type, id, name: promotion.productName || id, promotion };
    }
    return null;
  }

  function deletePlanHtml(plan) {
    if (plan.type === 'user') return `<div class="delete-impact"><div><strong>1</strong><span>perfil</span></div><div><strong>✓</strong><span>lista e relatórios</span></div></div><p>Serão removidos a lista, configurações e relatórios deste usuário. O perfil ficará marcado como <strong>excluído</strong> para negar o acesso e preservar a rastreabilidade. A conta do Firebase Authentication não pode ser apagada por outro usuário diretamente do navegador; isso exige o backend administrativo.</p>`;
    if (plan.type === 'market') {
      return `<div class="delete-impact"><div><strong>${plan.units.length}</strong><span>unidade${plan.units.length === 1 ? '' : 's'}</span></div><div><strong>${plan.promotions.length}</strong><span>promoç${plan.promotions.length === 1 ? 'ão' : 'ões'}</span></div><div><strong>${plan.inbox.length}</strong><span>registro${plan.inbox.length === 1 ? '' : 's'} de inbox</span></div></div><p>As <strong>unidades e promoções vinculadas serão excluídas definitivamente</strong>. Registros de Inbox serão preservados como histórico, mas perderão o vínculo ativo com o mercado.</p>`;
    }
    if (plan.type === 'unit') {
      return `<div class="delete-impact"><div><strong>${plan.promotions.length}</strong><span>promoç${plan.promotions.length === 1 ? 'ão vinculada' : 'ões vinculadas'}</span></div></div><p>A unidade e todas as promoções vinculadas a ela serão excluídas definitivamente.</p>`;
    }
    return '<p>Esta promoção será excluída definitivamente. Se você só não quiser exibi-la agora, prefira <strong>Desativar</strong>.</p>';
  }

  function updateDeleteConfirmState() {
    const input = byId('deleteEntityConfirmText');
    const btn = byId('deleteEntityConfirmBtn');
    if (!input || !btn) return;
    btn.disabled = M.normalizeText(input.value) !== M.normalizeText(deleteState.name);
  }

  function openDeleteEntityModal(type, id, trigger) {
    if (state.profile?.role !== 'superadmin') {
      M.toast('Somente o SuperAdmin pode excluir dados definitivamente. Use Desativar para arquivar.', 'warning', 6500);
      return;
    }
    const plan = buildDeletePlan(type, id);
    if (!plan) { M.toast('Registro não encontrado para exclusão.', 'error'); return; }
    Object.assign(deleteState, { type, id, name: plan.name, plan, trigger });
    byId('deleteEntityName').textContent = plan.name;
    byId('deleteEntityImpact').innerHTML = deletePlanHtml(plan);
    const label = type === 'user' ? 'usuário' : (type === 'market' ? 'mercado' : (type === 'unit' ? 'unidade' : 'promoção'));
    byId('deleteEntityTitle').textContent = type === 'user' ? 'Excluir acesso e dados do usuário' : `Excluir ${label} definitivamente`;
    byId('deleteEntityConfirmLabel').textContent = `Digite exatamente “${plan.name}” para confirmar:`;
    byId('deleteEntityConfirmText').value = '';
    byId('deleteEntityConfirmBtn').textContent = type === 'user' ? 'Excluir acesso e dados' : 'Excluir definitivamente';
    byId('deleteEntityConfirmBtn').disabled = true;
    M.openModal('deleteEntityModal', { trigger });
    setTimeout(() => byId('deleteEntityConfirmText')?.focus({ preventScroll: true }), 120);
  }

  async function deleteEntityPermanently(event) {
    event.preventDefault();
    if (state.profile?.role !== 'superadmin') throw new Error('Somente o SuperAdmin pode excluir definitivamente.');
    const input = byId('deleteEntityConfirmText');
    if (M.normalizeText(input.value) !== M.normalizeText(deleteState.name)) {
      M.toast('Digite o nome exatamente como exibido para confirmar.', 'warning');
      return;
    }
    const plan = buildDeletePlan(deleteState.type, deleteState.id);
    if (!plan) { M.closeModal('deleteEntityModal'); M.toast('O registro já não existe.', 'info'); return; }
    const btn = byId('deleteEntityConfirmBtn');
    M.setBusy(btn, true, 'Excluindo...');
    try {
      const updates = {};
      const details = { name: plan.name };
      if (plan.type === 'user') {
        if(plan.user.role!=='user') throw new Error('Exclusão pelo navegador está limitada a usuários consumidores. Para administradores, use Bloquear.');
        updates[`shopping_lists/${plan.id}`]=null; updates[`user_settings/${plan.id}`]=null; updates[`purchase_reports/${plan.id}`]=null;
        updates[`users/${plan.id}`]={ name:'Cadastro excluído', email:plan.user.email||'', contactEmail:'', phone:'', notes:'', role:'user', status:'deleted', registrationSource:plan.user.registrationSource||'unknown', createdAt:plan.user.createdAt||serverTimestamp, deletedAt:serverTimestamp, deletedBy:state.user.uid, updatedAt:serverTimestamp };
        details.previousStatus=plan.user.status; details.email=plan.user.email||''; details.appDataRemoved=true; details.authAccountRemoved=false;
      } else if (plan.type === 'market') {
        updates[`markets/${plan.id}`] = null;
        plan.units.forEach((u) => { updates[`market_units/${u.id}`] = null; updates[`geo_catalog/${u.id}`] = null; });
        plan.promotions.forEach((p) => { updates[`promotions/${p.id}`] = null; if (p.unitId) updates[`promotion_live/${p.unitId}/${p.id}`] = null; });
        plan.inbox.forEach((m) => {
          updates[`promotion_inbox/${m.id}/marketId`] = null;
          updates[`promotion_inbox/${m.id}/marketNameSnapshot`] = plan.name;
          updates[`promotion_inbox/${m.id}/marketDeletedAt`] = serverTimestamp;
        });
        details.unitsDeleted = plan.units.length;
        details.promotionsDeleted = plan.promotions.length;
        details.inboxPreserved = plan.inbox.length;
      } else if (plan.type === 'unit') {
        updates[`market_units/${plan.id}`] = null; updates[`geo_catalog/${plan.id}`] = null;
        plan.promotions.forEach((p) => { updates[`promotions/${p.id}`] = null; if (p.unitId) updates[`promotion_live/${p.unitId}/${p.id}`] = null; });
        details.promotionsDeleted = plan.promotions.length;
        details.marketId = plan.unit.marketId;
      } else if (plan.type === 'promotion') {
        updates[`promotions/${plan.id}`] = null; if (plan.promotion.unitId) updates[`promotion_live/${plan.promotion.unitId}/${plan.id}`] = null;
        details.marketId = plan.promotion.marketId;
        details.unitId = plan.promotion.unitId;
        details.price = plan.promotion.price;
      }
      await db.ref().update(updates);
      const action = plan.type === 'user' ? 'user_app_data_deleted' : (plan.type === 'market' ? 'market_deleted_permanently' : (plan.type === 'unit' ? 'unit_deleted_permanently' : 'promotion_deleted_permanently'));
      await audit(action, plan.type === 'unit' ? 'market_unit' : plan.type, plan.id, details);
      M.closeModal('deleteEntityModal');
      M.toast(`${plan.type === 'user' ? 'Acesso e dados do usuário removidos' : (plan.type === 'market' ? 'Mercado excluído definitivamente' : (plan.type === 'unit' ? 'Unidade excluída definitivamente' : 'Promoção excluída definitivamente'))}.`, 'success', 7000);
    } catch (error) {
      console.error('[Mercador IA] Falha na exclusão definitiva:', error);
      M.toast(error.message || 'Não foi possível excluir o registro.', 'error', 8000);
    } finally {
      M.setBusy(btn, false);
    }
  }

  function bindActions() {
    byId('logoutBtn').addEventListener('click', M.logout);
    byId('deleteEntityForm')?.addEventListener('submit', deleteEntityPermanently);
    byId('deleteEntityConfirmText')?.addEventListener('input', updateDeleteConfirmState);
    byId('userForm').addEventListener('submit', createUser);
    byId('userEditForm')?.addEventListener('submit', saveUserEdit);
    byId('userStatusFilter')?.addEventListener('change', renderUsers);
    byId('showPendingUsersBtn')?.addEventListener('click',()=>{byId('userStatusFilter').value='pending';renderUsers();navigate('users');});
    byId('marketForm').addEventListener('submit', (e)=>saveMarket(e).catch((er)=>M.toast(er.message,'error')));
    byId('unitForm').addEventListener('submit', (e)=>saveUnit(e).catch((er)=>M.toast(er.message,'error')));
    byId('promotionForm').addEventListener('submit', (e)=>savePromotion(e).catch((er)=>M.toast(er.message,'error')));
    byId('inboxForm').addEventListener('submit', (e)=>saveInbox(e).catch((er)=>M.toast(er.message,'error')));
    byId('pdfImportForm').addEventListener('submit', analyzePdfImport);
    byId('pdfReviewForm').addEventListener('submit', savePdfReview);
    byId('pdfImportMarketId').addEventListener('change', refreshPdfImportUnitSelects);
    byId('pdfImportFile')?.addEventListener('change', updatePdfSourceSummary);
    byId('pdfImportText')?.addEventListener('input', updatePdfSourceSummary);
    byId('pdfImportText')?.addEventListener('paste', () => setTimeout(updatePdfSourceSummary, 0));
    byId('pdfImportSourceUrl')?.addEventListener('input', updatePdfSourceSummary);
    byId('pdfImportResetBtn').addEventListener('click', resetPdfImport);
    byId('pdfPublishReadyBtn').addEventListener('click', publishReadyPdfCandidates);
    byId('pdfPublishVerifiedBtn').addEventListener('click', publishVerifiedPdfCandidates);
    byId('pdfPublishAutoBtn').addEventListener('click', () => publishAutomaticPdfCandidates(false));
    byId('pdfDiscardPendingBtn').addEventListener('click', discardAllPendingPdfCandidates);
    byId('pdfDownloadKnowledgeBtn')?.addEventListener('click', downloadPdfKnowledge);
    byId('pdfAutomationMode').addEventListener('change', () => { if (state.pdfImport) { state.pdfImport.threshold = automationThreshold(); refreshPdfClassifications(); renderPdfImport(); } });
    byId('pdfIgnoreCandidateBtn').addEventListener('click', ignorePdfCandidate);
    byId('pdfCandidateSearch').addEventListener('input', renderPdfImport);
    byId('pdfCandidateFilter').addEventListener('change', renderPdfImport);
    byId('promoMarketId').addEventListener('change', refreshUnitSelects);
    ['userSearch','marketSearch','unitSearch','promoSearch'].forEach((id)=>byId(id).addEventListener('input', ()=>({userSearch:renderUsers,marketSearch:renderMarkets,unitSearch:renderUnits,promoSearch:renderPromotions}[id])()));
    byId('promoFilter').addEventListener('change', renderPromotions);
    byId('rebuildPromotionLiveBtn')?.addEventListener('click', rebuildPromotionLiveIndex);
    byId('parseUnitMapsLink')?.addEventListener('click', () => applyUnitMapsLink());
    byId('unitMapsUrl')?.addEventListener('paste', () => setTimeout(() => applyUnitMapsLink({ quiet:true }), 30));
    byId('unitMapsUrl')?.addEventListener('change', () => applyUnitMapsLink({ quiet:true }));

    document.addEventListener('click', async (event) => {
      const t=event.target.closest('button,a'); if(!t)return;
      if(t.dataset.pdfReview) { event.preventDefault(); event.stopPropagation(); await openPdfReview(t.dataset.pdfReview, t); return; }
      if(t.dataset.pdfIgnoreQuick) { event.preventDefault(); event.stopPropagation(); await discardPdfCandidateById(t.dataset.pdfIgnoreQuick); return; }
      if(t.dataset.pdfRestore) { event.preventDefault(); event.stopPropagation(); restorePdfCandidate(t.dataset.pdfRestore); return; }
      if(t.dataset.userEdit){ event.preventDefault(); event.stopPropagation(); openUserEditModal(t.dataset.userEdit,t); return; }
      if(t.dataset.userStatus){ event.preventDefault(); event.stopPropagation(); await setUserStatus(t.dataset.userId,t.dataset.userStatus); return; }
      if(t.dataset.userDelete){ event.preventDefault(); event.stopPropagation(); openDeleteEntityModal('user',t.dataset.userDelete,t); return; }
      if(t.dataset.marketEdit) { event.preventDefault(); event.stopPropagation(); populateMarketForm(t.dataset.marketEdit, t); return; }
      if(t.dataset.unitEdit) { event.preventDefault(); event.stopPropagation(); populateUnitForm(t.dataset.unitEdit, t); return; }
      if(t.dataset.promoEdit) { event.preventDefault(); event.stopPropagation(); populatePromotionForm(t.dataset.promoEdit, t); return; }
      if(t.dataset.marketDelete) { event.preventDefault(); event.stopPropagation(); openDeleteEntityModal('market', t.dataset.marketDelete, t); return; }
      if(t.dataset.unitDelete) { event.preventDefault(); event.stopPropagation(); openDeleteEntityModal('unit', t.dataset.unitDelete, t); return; }
      if(t.dataset.promoDelete) { event.preventDefault(); event.stopPropagation(); openDeleteEntityModal('promotion', t.dataset.promoDelete, t); return; }
      if(t.dataset.marketToggle){ event.preventDefault(); const id=t.dataset.marketToggle; const x=state.markets[id]; if(x) await toggle('markets',id,'active',x.active,'market_status_changed','market'); return; }
      if(t.dataset.unitToggle){ event.preventDefault(); const id=t.dataset.unitToggle; const x=state.units[id]; if(x) await toggle('market_units',id,'active',x.active,'unit_status_changed','market_unit'); return; }
      if(t.dataset.promoToggle){ event.preventDefault(); const id=t.dataset.promoToggle; const x=state.promotions[id]; if(x) await toggle('promotions',id,'active',x.active,'promotion_status_changed','promotion'); return; }
      if(t.dataset.inboxProcess){ await db.ref(`promotion_inbox/${t.dataset.inboxProcess}`).update({status:'processed',processedAt:serverTimestamp,processedBy:state.user.uid}); await audit('inbox_processed','promotion_inbox',t.dataset.inboxProcess); }
      if(t.dataset.inboxPromo){ const x=state.inbox[t.dataset.inboxPromo]; if(!x)return; resetPromotionForm(); const f=byId('promotionForm'); if(x.marketId){f.elements.marketId.value=x.marketId;refreshUnitSelects();} f.elements.sourceType.value=x.sourceType==='encarte'?'encarte':'whatsapp'; f.elements.sourceReference.value=`Inbox ${t.dataset.inboxPromo} · recebido em ${M.formatDateTime(x.createdAt)}`; f.elements.aliases.value=''; M.openModal('promotionModal', { trigger: t }); }
    });
  }

  (async function init(){
    try {
      const {user,profile}=await M.requireRole(['superadmin','admin']); state.user=user; state.profile=profile;
      byId('adminRoleBadge').textContent=profile.role; byId('adminWelcome').textContent=`${profile.name || user.email} · ${user.email}`;
      if(profile.role!=='superadmin') byId('newUserRole').querySelector('option[value="admin"]')?.remove();
      bindNavigation(); bindActions(); listenData(); byId('loading').hidden=true;
    } catch(error){ console.error(error); }
  })();
})();
