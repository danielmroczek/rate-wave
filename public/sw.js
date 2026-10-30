/* rate-wave — Service Worker: app-shell cache (spec §7, bilet 01).
   Żyje w public/ → kopiowany 1:1 do dist/sw.js przez Vite (klasyczny SW, bez bundlowania).
   Strategia: precache nawigacji + manifest; hashowane /assets/* → cache-first (immutable);
   nawigacja → network-first z fallbackiem (żeby deploy podmieniał shell). */

const CACHE = "rate-wave-shell-v1"; // wersjonowany — bump przy zmianie strategii

// Precache build-time: lista podmieniana wtyczką Vite (vite.config.js) na realne,
// hashowane nazwy assetów emitowanych do dist/assets/. Build-time, nie runtime.
const PRECACHE_URLS = __PRECACHE_URLS__;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const scopePath = new URL(self.registration.scope).pathname;
      await cache.addAll([scopePath, scopePath + "manifest.webmanifest", ...PRECACHE_URLS]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API pCloud / Worker / audio — nigdy nie cache'ujemy

  const inScope = url.pathname.startsWith(new URL(self.registration.scope).pathname);

  // Nawigacja: network-first z fallbackiem do cache (deploy podmienia shell).
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          if (fresh.ok && inScope) {
            const cache = await caches.open(CACHE);
            cache.put(req, fresh.clone());
          }
          return fresh;
        } catch {
          const cached = await caches.match(req);
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Assety buildu (hashowane nazwy → immutable): cache-first.
  if (inScope && /\/assets\//.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const fresh = await fetch(req);
        if (fresh.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone());
        }
        return fresh;
      })(),
    );
  }
});

/* Background Sync (tag flush-ratings) — progressive enhancement (spec §7).
   Logika flush `pending-ratings` przychodzi w bilecie 15; tutaj placeholder
   utrzymuje rejestrowalność tagu. */
self.addEventListener("sync", (event) => {
  if (event.tag === "flush-ratings") {
    event.waitUntil(Promise.resolve());
  }
});
