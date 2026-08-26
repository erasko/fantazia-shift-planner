// Offline support: keep a copy of everything the app fetches, so a shift with
// no signal still shows the last known schedule instead of a blank screen.
//
// Network first, cache only as a fallback — including for app.js and the page
// itself. Serving the shell from cache first would show everyone the previous
// version on the visit right after a deploy, and the new one only on the next
// visit; for an app that gets fixed and re-deployed mid-season, being a version
// behind is worse than waiting for a small file.
const CACHE = 'flp-v2';
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

  e.respondWith(
    fetch(request)
      .then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(request, res.clone()));
        return res;
      })
      .catch(() => caches.match(request))
  );
});
