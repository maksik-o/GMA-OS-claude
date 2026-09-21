const CACHE = 'rl-v249';

/* В кэш кладём только целые ответы.
   Видео и аудио браузер тянет диапазонами (Range), сервер отвечает
   206 Partial Content, а Cache.put такие ответы не принимает и
   бросает исключение — оно и сыпалось в консоль. Заодно отсекаем
   opaque-ответы: их размер не виден и они раздувают квоту. */
function cacheable(res) {
  return !!res && res.ok && res.status === 200 && res.type !== 'opaque' && res.type !== 'opaqueredirect';
}
function putSafe(req, res) {
  if (!cacheable(res)) return;
  const copy = res.clone();
  caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
}
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/style.css',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-180.png',
  './js/app.js', './js/config.js', './js/db.js', './js/files.js', './js/hotkeys.js',
  './js/search.js', './js/store.js', './js/sync.js', './js/timer.js',
  './js/week.js', './js/sheet.js', './js/notes.js', './js/focus.js',
  './js/widgets.js', './js/cal.js', './js/contacts.js', './js/kanban.js',
  './js/finance.js', './js/finimport.js', './js/anim.js',
  './js/timeline.js', './js/kb.js', './js/charts.js',
  './images/sky.jpg', './images/sunset.jpg', './images/waves.jpg',
  './images/mountains.jpg', './images/winter.jpg'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled(SHELL.map(u => c.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* Файлы, которые НЕЛЬЗЯ отдавать из кэша.
   config.js держит адрес развёртывания Apps Script: при cache-first
   после переразвёртывания приложение продолжало стучаться по старой
   ссылке, и запрос уходил в архивное развёртывание (302 → echo 404).
   Такие файлы берём из сети, а кэш оставляем только как офлайн-резерв. */
const NETWORK_FIRST = ['/js/config.js', '/index.html', '/'];
const isNetworkFirst = url =>
  NETWORK_FIRST.some(p => url.pathname === p || url.pathname.endsWith(p));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (e.request.headers.has('range')) return;   // медиа тянется диапазонами
  if (isNetworkFirst(url)) {
    e.respondWith((async () => {
      try {
        const res = await fetch(e.request, { cache: 'no-store' });
        putSafe(e.request, res);
        return res;
      } catch {
        const hit = await caches.match(e.request, { ignoreSearch: true });
        return hit || Response.error();
      }
    })());
    return;
  }
  e.respondWith((async () => {
    const hit = await caches.match(e.request, { ignoreSearch: true });
    if (navigator.onLine) {
      fetch(e.request).then(res => putSafe(e.request, res)).catch(() => {});
    }
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      putSafe(e.request, res);
      return res;
    } catch {
      return hit || Response.error();
    }
  })());
});
