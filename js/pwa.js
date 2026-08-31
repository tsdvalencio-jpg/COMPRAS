(function () {
  'use strict';

  // O resolvedor documental é carregado somente no painel que possui o importador de PDF.
  // Consumidores não baixam esse módulo e a Lista Inteligente continua com o shell leve.
  function loadCardResolverIfNeeded() {
    const pdfForm = document.getElementById('pdfImportForm');
    if (!pdfForm || !window.MercadorPDFImporter || window.MercadorPDFImporter.__cardFirstResolverInstalled) return;

    const analyzeButton = document.getElementById('pdfImportAnalyzeBtn');
    const previousDisabled = analyzeButton ? analyzeButton.disabled : false;
    if (analyzeButton) {
      analyzeButton.disabled = true;
      analyzeButton.dataset.cardResolverLoading = '1';
    }

    const script = document.createElement('script');
    script.src = './js/pdf-encarte-card-resolver.js?v=2.9.0';
    script.async = true;
    script.dataset.mercadorCardResolver = '2.9.0';
    script.onload = function () {
      if (analyzeButton) {
        analyzeButton.disabled = previousDisabled;
        delete analyzeButton.dataset.cardResolverLoading;
      }
      if (!window.MercadorPDFImporter?.__cardFirstResolverInstalled) {
        console.warn('[Mercador IA] O Card Resolver foi carregado, mas não conseguiu envolver o importador atual. O motor anterior permanece disponível.');
      }
    };
    script.onerror = function () {
      if (analyzeButton) {
        analyzeButton.disabled = previousDisabled;
        delete analyzeButton.dataset.cardResolverLoading;
      }
      console.warn('[Mercador IA] Card Resolver não carregado. O importador anterior foi preservado e continua disponível.');
    };
    document.head.appendChild(script);
  }

  loadCardResolverIfNeeded();

  // Mantém a identificação visual do painel coerente com o build instalado sem
  // exigir alteração estrutural no admin.html.
  document.querySelectorAll('.footer').forEach((footer) => {
    if (/Mercador IA V2\.8\.0/.test(footer.textContent || '')) {
      footer.innerHTML = footer.innerHTML.replace(/Mercador IA V2\.8\.0/g, 'Mercador IA V2.9.0');
    }
  });

  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js', { scope: './' }).catch((error) => {
      console.warn('[Mercador IA] Service Worker não registrado:', error);
    });
  });
})();
