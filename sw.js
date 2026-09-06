/* Iron Cadence — オフライン用サービスワーカー
 *
 * アプリのファイルを一式キャッシュして、電波が無くても起動できるようにする。
 * ファイルを更新したら VERSION を上げること。古いキャッシュは activate で消える。
 */
'use strict';

const VERSION = 'v1';
const CACHE = 'iron-cadence-' + VERSION;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './fonts/chakra-petch-500-latin.woff2',
  './fonts/chakra-petch-600-latin.woff2',
  './fonts/chakra-petch-700-latin.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon-16.png'
];

self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // ページ遷移はネットワーク優先。落ちていればキャッシュした本体を返す。
  if (req.mode === 'navigate') {
    ev.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // それ以外はキャッシュ優先。取得できたものは次回のために保存しておく。
  ev.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }))
  );
});
