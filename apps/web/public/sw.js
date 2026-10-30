/* global self, caches, fetch, URL */
// Mezvaan service worker: caches the app shell and static assets so staff screens open during a
// short internet drop. API calls are never cached here; the app keeps its own offline queue.
// A new name: the activate step below removes caches under any other name, the old ones included.
const CACHE = 'mezmitra-shell-v1';
const SHELL = ['/app', '/app/inbox', '/app/kds', '/app/pos', '/app/floor', '/login', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Hashed build assets never change: cache first.
  if (url.pathname.startsWith('/_next/static/') || url.pathname.endsWith('.svg')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
    return;
  }

  // Pages: network first, fall back to the cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('/app'))),
    );
  }
});

// Staff phone alerts (Web Push): new orders to accept, waiter calls, bill requests.
self.addEventListener('push', (event) => {
  let msg = { title: 'Mezvaan', body: '', url: '/app', tag: undefined };
  try {
    msg = { ...msg, ...event.data.json() };
  } catch {
    // keep the defaults
  }
  event.waitUntil(
    self.registration.showNotification(msg.title, { body: msg.body, tag: msg.tag, renotify: Boolean(msg.tag), icon: '/brand/icon-192.png', badge: '/brand/badge-96.png', data: { url: msg.url } }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/app', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((open) => {
      const tab = open.find((c) => c.url.startsWith(self.location.origin));
      if (tab) return tab.navigate(url).then((c) => (c || tab).focus());
      return self.clients.openWindow(url);
    }),
  );
});
