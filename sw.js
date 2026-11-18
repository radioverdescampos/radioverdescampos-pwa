/* Rádio Verdes Campos — service worker
   Guarda a "casca" do app para abrir rápido e funcionar sem internet.
   O áudio ao vivo NUNCA passa pelo cache. Ao publicar mudanças, troque a versão abaixo. */
const VERSION = 'vc-app-2026-11-18b';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Transmissão ao vivo: deixa passar direto, sem cache.
  if (url.hostname.endsWith('workers.dev') || req.destination === 'audio' || req.headers.has('range')) return;

  // Páginas: tenta a internet primeiro (sempre a versão mais nova); sem internet, usa a cópia guardada.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Arquivos do app, fontes e a logo do portal: responde do cache e atualiza em segundo plano.
  const sameOrigin = url.origin === self.location.origin;
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  const logo = url.hostname.endsWith('radioverdescamposfm.com.br') && url.pathname.endsWith('.png');
  if (sameOrigin || fonts || logo) {
    event.respondWith(
      caches.open(VERSION).then((cache) =>
        cache.match(req).then((cached) => {
          const network = fetch(req)
            .then((res) => {
              if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
              return res;
            })
            .catch(() => cached);
          return cached || network;
        })
      )
    );
  }
});
