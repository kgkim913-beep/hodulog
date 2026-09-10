// 호두로그 서비스워커
// - PWA 설치 요건(등록된 SW + manifest) 충족
// - 앱 셸(정적 파일)만 캐시. Supabase API/이미지 요청은 캐시하지 않고 항상 네트워크로 보냄
//   (기록 데이터가 오래된 캐시로 보이는 것을 방지하기 위함)

const CACHE_NAME = 'hodulog-shell-v6';
const APP_SHELL = [
  './index.html',
  './manifest.webmanifest',
  './config.js',
  './app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // addAll은 하나라도 실패하면 전체가 실패한다.
      // 아이콘 등 일부 파일이 아직 없어도 나머지 캐싱과 SW 설치가 진행되도록
      // 파일별로 개별 시도한다.
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((e) => console.warn('[SW] 캐시 실패(무시):', url, e))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Supabase(데이터/이미지) 요청은 캐시하지 않고 그대로 네트워크로 전달
  if (url.includes('supabase.co')) {
    return; // 브라우저 기본 네트워크 처리에 맡김
  }

  // 앱 셸: 캐시 우선, 실패 시 네트워크
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
