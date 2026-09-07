const CACHE = 'mercador-ia-shell-v3.12.0-list-ux';

// Shell enxuto do consumidor. O painel Admin/PDF e o Card Resolver são carregados
// somente quando um administrador realmente os acessa — não pesam no PWA do usuário.
const USER_SHELL = [
  './', './index.html', './cadastro.html', './inicio.html', './usuario.html',
  './css/app.css', './css/auth.css', './css/inicio.css',
  './js/firebase-config.js', './js/utils.js', './js/auth.js', './js/smart-matcher.js',
  './js/index.js', './js/cadastro.js', './js/inicio.js', './js/lista-promocoes.js', './js/pwa.js',
  './manifest.webmanifest', './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(USER_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key.startsWith('mercador-ia-')).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // HTML é network-first para uma atualização publicada chegar rápido.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, clone));
        return response;
      }).catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // Assets versionados são cache-first; se não estiverem no shell, entram no cache
  // sob demanda (ex.: Admin, importador PDF e Card Resolver).
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response && response.ok) {
        const clone = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, clone));
      }
      return response;
    }))
  );
});
