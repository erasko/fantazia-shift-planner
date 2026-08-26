// Offline support: cache the app shell, and fall back to the last known
// API response (schedule, availability...) when there's no signal.
const CACHE = 'flp-v1';
const SHELL = ['/', '/app.js', '/styles.css', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return; // never intercept writes (hour logs, submissions...)

  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/')) {
    // Network first — API data goes stale fast. Cache successful reads so
    // the last-seen schedule/availability still shows up with no signal.
    e.respondWith(
      fetch(request)
        .then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(request, res.clone()));
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // App shell — serve from cache instantly, refresh in the background.
  e.respondWith(
    caches.match(request).then(cached => {
      const fresh = fetch(request)
        .then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
