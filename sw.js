/* pyPath service worker: opens the app and runs Python without internet.
   - the app page: network first (so updates arrive), cached copy when offline
   - Python (Pyodide) files: cache first, saved the first time they are fetched
   - /api/ is never cached */
var APP = 'pp-app-v1', PY = 'pp-py-v1';
self.addEventListener('install', function (e) { self.skipWaiting(); e.waitUntil(caches.open(APP).then(function (c) { return c.addAll(['/', '/manifest.webmanifest', '/icon-192.png']).catch(function () {}); })); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k.indexOf('pp-app-') === 0 && k !== APP; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var r = e.request, u = new URL(r.url);
  if (r.method !== 'GET') return;
  if (u.origin === location.origin) {
    if (u.pathname.indexOf('/api/') === 0 || u.pathname === '/admin' || u.pathname === '/sw.js') return;
    e.respondWith(fetch(r).then(function (res) {
      if (res && res.ok) { var cp = res.clone(); caches.open(APP).then(function (c) { c.put(r.mode === 'navigate' ? '/' : r, cp); }); }
      return res;
    }).catch(function () { return caches.match(r.mode === 'navigate' ? '/' : r).then(function (m) { return m || caches.match('/'); }); }));
    return;
  }
  if (u.hostname === 'cdn.jsdelivr.net' && u.pathname.indexOf('/pyodide/') === 0) {
    e.respondWith(caches.open(PY).then(function (c) {
      return c.match(r.url).then(function (m) {
        if (m) return m;
        return fetch(r).then(function (res) { if (res && res.ok) c.put(r.url, res.clone()); return res; });
      });
    }));
  }
});
