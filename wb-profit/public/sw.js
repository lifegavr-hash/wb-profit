// 🔥 SW Profit Service Worker v0.7.10.9
//
// НАЗНАЧЕНИЕ: единственная цель этого SW — сделать сайт «устанавливаемым»
// PWA в Chrome/Edge (без активного SW браузер не показывает install-prompt).
//
// АРХИТЕКТУРНОЕ ПРАВИЛО: ничего НЕ кэшируем.
//   - version.js, /api/*, *.html должны всегда быть свежими (no-cache в vercel.json).
//   - Если начнём кэшировать — юзеры застрянут на старой версии после деплоя,
//     это сломает single-source-of-truth архитектуру (см. /version.js).
//   - Браузер сам обрабатывает HTTP-кэш по заголовкам Vercel.
//
// install/activate — минимальные, без precache.
// fetch — даже не объявляем handler (passthrough по умолчанию).

self.addEventListener('install', function(event){
  // Сразу активируемся, не ждём закрытия всех вкладок —
  // иначе при первом релизе с SW юзер должен будет перезагрузить страницу.
  self.skipWaiting();
});

self.addEventListener('activate', function(event){
  // Берём контроль над открытыми клиентами немедленно.
  event.waitUntil(self.clients.claim());
});

// Chrome 89+ требует наличия fetch-listener'а как часть PWA installability check.
// Делаем простейший passthrough: дёргаем сеть, ничего не кэшируем.
// Это эквивалентно "нет SW" с точки зрения сетевого слоя, но удовлетворяет Chrome.
self.addEventListener('fetch', function(event){
  // Не вмешиваемся: ни кэша, ни модификации запроса. event.respondWith не вызываем
  // — браузер обработает запрос своим стандартным механизмом.
  // (respondWith(fetch(event.request)) технически тоже работает, но добавляет
  //  лишний прыжок через SW и портит DevTools Network — поэтому passthrough.)
});
