// 🔥 v0.7.10.1: единая точка истины версии для всех HTML-страниц.
// При релизе меняй только здесь (и в wb-profit/api/config.js для health-check).
window.__APP_VERSION = 'v0.7.12.4';

// 🔥 v0.7.10.9: inline Supabase config — снимает 4 лишних fetch('/api/config')
// с критического пути логина/дашборда. supabaseKey — publishable_key,
// специально публичный для фронта (виден в DevTools после первого запроса).
// Безопасно вшивать. Если когда-то ротируется — обновить здесь.
window.__SUPA = {
  url: 'https://bqbccehwbgqzfczfubvf.supabase.co',
  key: 'sb_publishable_88reCpqaY8MvtJH8pg0I1w_3syxqzZz'
};
