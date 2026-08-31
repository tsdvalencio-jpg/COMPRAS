(function () {
  'use strict';

  const M = window.MercadorIA = window.MercadorIA || {};

  M.escapeHtml = function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  };

  M.normalizeText = function normalizeText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\b(quilogramas?|quilo?s?)\b/g, ' kg ')
      .replace(/\b(gramas?|gr)\b/g, ' g ')
      .replace(/\b(litros?|lts?)\b/g, ' l ')
      .replace(/\b(mililitros?|mls?)\b/g, ' ml ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  M.formatCurrency = function formatCurrency(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);
  };

  M.formatDateTime = function formatDateTime(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '—';
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short'
    }).format(new Date(n));
  };

  M.formatDateOnly = function formatDateOnly(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '—';
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date(n));
  };

  M.toTimestampFromLocalInput = function toTimestampFromLocalInput(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  };

  M.toLocalDateTimeInput = function toLocalDateTimeInput(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  M.slugify = function slugify(value) {
    return M.normalizeText(value).replaceAll(' ', '-').replace(/[^a-z0-9-]/g, '').slice(0, 80);
  };

  M.haversineKm = function haversineKm(lat1, lon1, lat2, lon2) {
    const vals = [lat1, lon1, lat2, lon2].map(Number);
    if (vals.some((v) => !Number.isFinite(v))) return Infinity;
    const [a, b, c, d] = vals;
    const R = 6371;
    const toRad = (deg) => deg * Math.PI / 180;
    const dLat = toRad(c - a);
    const dLon = toRad(d - b);
    const q = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
  };

  M.getCurrentPosition = function getCurrentPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Este navegador não oferece geolocalização.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, (error) => {
        const map = {
          1: 'Permissão de localização negada.',
          2: 'Não foi possível determinar sua localização.',
          3: 'A localização demorou demais para responder.'
        };
        reject(new Error(map[error.code] || 'Falha ao obter localização.'));
      }, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 60000
      });
    });
  };

  M.toast = function toast(message, type = 'info', timeout = 4200) {
    let host = document.querySelector('.toast-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toast-host';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', 'status');
    el.textContent = message;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 250);
    }, timeout);
  };

  M.setBusy = function setBusy(button, busy, busyText = 'Aguarde...') {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.disabled = true;
      button.classList.add('is-busy');
      button.textContent = busyText;
    } else {
      button.disabled = false;
      button.classList.remove('is-busy');
      if (button.dataset.originalText) button.textContent = button.dataset.originalText;
    }
  };

  const modalRuntime = {
    openedAt: new WeakMap(),
    opener: new WeakMap(),
    backdropPointer: new WeakMap(),
    stack: []
  };

  function isCoarsePointer() {
    try { return window.matchMedia && window.matchMedia('(pointer: coarse)').matches; }
    catch (_) { return false; }
  }

  function syncModalBodyState() {
    const anyOpen = modalRuntime.stack.some((el) => el && !el.hidden);
    document.body.classList.toggle('modal-open', anyOpen);
  }

  M.openModal = function openModal(id, options = {}) {
    const el = document.getElementById(id);
    if (!el) return;

    const trigger = options.trigger || document.activeElement;
    if (trigger && trigger !== document.body && !el.contains(trigger)) modalRuntime.opener.set(el, trigger);

    el.hidden = false;
    el.setAttribute('aria-hidden', 'false');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    modalRuntime.openedAt.set(el, performance.now());

    modalRuntime.stack = modalRuntime.stack.filter((x) => x && x !== el && !x.hidden);
    modalRuntime.stack.push(el);
    syncModalBodyState();

    // No celular, abrir o teclado automaticamente altera o viewport e pode gerar
    // um segundo toque/"ghost click" no backdrop. O foco automático fica restrito
    // a ponteiros finos (desktop/mouse) ou quando solicitado explicitamente.
    const shouldFocus = options.focus === true || (options.focus !== false && !isCoarsePointer());
    if (shouldFocus) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const focusable = el.querySelector('[autofocus], input:not([type="hidden"]), select, textarea, button:not([disabled]), [tabindex]:not([tabindex="-1"])');
          try { focusable?.focus({ preventScroll: true }); } catch (_) { focusable?.focus(); }
        });
      });
    }
  };

  M.closeModal = function closeModal(id, options = {}) {
    const el = document.getElementById(id);
    if (!el || el.hidden) return;
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
    modalRuntime.backdropPointer.delete(el);
    modalRuntime.stack = modalRuntime.stack.filter((x) => x && x !== el && !x.hidden);
    syncModalBodyState();

    if (options.restoreFocus !== false && !isCoarsePointer()) {
      const opener = modalRuntime.opener.get(el);
      if (opener && document.contains(opener)) {
        requestAnimationFrame(() => {
          try { opener.focus({ preventScroll: true }); } catch (_) { opener.focus?.(); }
        });
      }
    }
  };

  // Botões explícitos são a forma principal de fechar. Não usamos mais "click"
  // genérico no fundo do modal, pois em navegadores móveis um toque que abre o
  // modal pode ser reprocessado depois da mudança de layout e fechá-lo em seguida.
  document.addEventListener('click', (event) => {
    const close = event.target.closest('[data-close-modal]');
    if (!close) return;
    event.preventDefault();
    event.stopPropagation();
    M.closeModal(close.dataset.closeModal);
  });

  // Fechamento pelo backdrop continua disponível, porém exige pointerdown e
  // pointerup no próprio backdrop, sem arrasto e depois de uma janela mínima
  // desde a abertura. Isso elimina o abre/fecha instantâneo no celular.
  document.addEventListener('pointerdown', (event) => {
    const modal = event.target.classList?.contains('modal') ? event.target : null;
    if (!modal || modal.hidden) return;
    modalRuntime.backdropPointer.set(modal, {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      at: performance.now()
    });
  }, true);

  document.addEventListener('pointerup', (event) => {
    const modal = event.target.classList?.contains('modal') ? event.target : null;
    if (!modal || modal.hidden) return;
    const start = modalRuntime.backdropPointer.get(modal);
    modalRuntime.backdropPointer.delete(modal);
    if (!start || start.pointerId !== event.pointerId) return;
    const openedAt = modalRuntime.openedAt.get(modal) || 0;
    if (performance.now() - openedAt < 420) return;
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (moved > 12) return;
    M.closeModal(modal.id);
  }, true);

  document.addEventListener('pointercancel', (event) => {
    const modal = event.target.classList?.contains('modal') ? event.target : null;
    if (modal) modalRuntime.backdropPointer.delete(modal);
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const top = [...modalRuntime.stack].reverse().find((el) => el && !el.hidden);
    if (!top) return;
    event.preventDefault();
    M.closeModal(top.id);
  });

})();
