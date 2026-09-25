/* SOBE ISTO sempre que mexeres em app.js, style.css ou index.html.
   Os três são network-first de propósito: sem isto, um deploy dá ao
   browser o index.html novo com o app.js velho da cache — botões novos a
   chamar funções que ainda não existem, sem erro visível. Já aconteceu nas
   apps irmãs. */
const CACHE_NAME = 'wc-cache-v26';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.map((key) => {
                if (key !== CACHE_NAME) return caches.delete(key);
            }))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    const url = new URL(e.request.url);
    if (url.hostname !== self.location.hostname) return;
    if (url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.endsWith('/')
        || url.pathname.endsWith('/app.js') || url.pathname.endsWith('/style.css')) {
        e.respondWith(
            fetch(e.request.url, { cache: 'no-store' })
                .then((res) => {
                    if (res && res.status === 200) {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
                    }
                    return res;
                })
                .catch(() => caches.match(e.request))
        );
        return;
    }
    // Cache-first para o resto (ícones, manifest, fontes)
    e.respondWith(
        caches.match(e.request).then((cached) =>
            cached || fetch(e.request).then((res) => {
                if (res && res.status === 200) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
                }
                return res;
            })
        )
    );
});
