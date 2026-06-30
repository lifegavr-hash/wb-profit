# SW Profit

Аналитика чистой прибыли селлера Wildberries: с учётом комиссий, логистики, рекламы, штрафов и себестоимости. Алерты о потерях, ДРР по товарам, прогнозы. Демо без регистрации.

🌐 Прод: https://wb-profit.vercel.app
📊 Демо: https://wb-profit.vercel.app/demo

---

## Стек

- **Фронтенд**: ванильный JS + HTML/CSS в одном файле `public/dashboard.html` (~520 КБ). Лендинг `public/index.html`. Без билд-системы.
- **Бэкенд**: 12 serverless-функций на Vercel (`api/*.js`), Node.js ESM.
- **БД и Auth**: Supabase (Postgres + Auth + RLS).
- **Хостинг**: Vercel Hobby (планируется Pro к моменту монетизации).
- **Внешние API**: Wildberries Statistics, Promotion, Common API.

## Структура

```
wb-profit/
├── api/                    ← 12 serverless-функций (Vercel предел Hobby)
│   ├── admin.js            ← админка: создать промокод, список юзеров
│   ├── calcs.js            ← CRUD истории подборов
│   ├── config.js           ← конфиг + health-check (?health=1)
│   ├── costs.js            ← себестоимости + доп.расход ₽/шт + постоянные расходы (?resource=expenses)
│   ├── plans.js            ← список тарифов из БД
│   ├── profile.js          ← профиль/аккаунт + WB-кабинеты/экспорт/налог/уведомления/команда (?resource=)
│   ├── promo.js            ← активация промокода
│   ├── snapshots.js        ← снапшоты финансовых данных
│   ├── wb-adv.js           ← реклама WB
│   ├── wb-stocks.js        ← остатки на складах
│   ├── wb-tariffs.js       ← тарифы WB (категории + логистика)
│   └── wb.js               ← основной прокси к WB Statistics API
├── lib/
│   └── plan-check.js       ← общая утилита проверки тарифа на бэке
├── public/                 ← статика (outputDirectory в vercel.json)
│   ├── index.html          ← лендинг
│   ├── dashboard.html      ← основной кабинет (Главная, Калькулятор, и т.д.)
│   ├── login.html          ← вход/регистрация
│   ├── reset-password.html ← установка нового пароля по ссылке
│   ├── offer.html          ← публичная оферта
│   ├── privacy.html        ← политика обработки ПД
│   ├── 404.html            ← кастомная 404
│   ├── favicon.svg         ← брендовый favicon
│   ├── og-image.svg        ← 1200x630 баннер для шеринга
│   ├── robots.txt
│   └── sitemap.xml
├── vercel.json             ← rewrites + cache-policy + CSP/HSTS headers
└── package.json
```

## Env-переменные

Переменные окружения задаются в Vercel Dashboard → Project → Settings → Environment Variables. Локальная разработка — см. `.env.example`.

| Переменная | Где используется | Пример |
|---|---|---|
| `SUPABASE_URL` | все api/* | `https://xxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | все api/* | `eyJhbGc...` (НИКОГДА не отдавать клиенту) |
| `SUPABASE_PUBLISHABLE_KEY` или `SUPABASE_ANON_KEY` | `/api/config` | `sb_publishable_...` |

## Архитектура безопасности

- **RLS включён на всех пользовательских таблицах** (`profiles`, `daily_snapshots`, `user_costs`, `product_costs`, `unit_calc_history`, `ext_activations`, `ext_products`, `tax_settings`, `fixed_expenses`).
- **Service-only таблицы** (`promo_codes`, `promo_uses`, `claude_session_journal`): RLS включён, политик для anon нет → доступ только через service_role.
- **Тарифные ограничения проверяются на бэкенде** через `lib/plan-check.js` — фронтовый `currentProfile` только UX-помощник. Взлом-тест пройден (4 атаки в журнале v0.7.7.1).
- **Промокоды**: `userId` ТОЛЬКО из JWT, не из body (закрыта уязвимость в v0.7.1).
- **Удаление аккаунта**: двойное подтверждение (пароль через `signInWithPassword` + слово DELETE), Postgres функция `delete_user_account()` с `SECURITY DEFINER` доступна только service_role.
- **Безопасность браузера**: HSTS preload, CSP с whitelist, X-Frame-Options DENY, Referrer-Policy strict-origin, Permissions-Policy запрет geolocation/microphone/camera/payment.

## Деплой

`git push origin main` → Vercel автоматически собирает и публикует.

Лимит Vercel Hobby: **12 функций**. Если нужно больше — объединять с существующими (как сделали с health-check внутри `/api/config?health=1`) ИЛИ переходить на Vercel Pro ($20/мес).

## История версий

Журнал сессий разработки хранится в Supabase в таблице `claude_session_journal`. Для чтения:
```sql
SELECT * FROM claude_session_journal ORDER BY id DESC LIMIT 5;
```

## Контакты

Поддержка: ooovsktrans@mail.ru (будет заменён на бренд-домен)

ИП Чиркова А.В., ИНН: 233304659652, ОГРНИП: 321237500373856

## Лицензия

Proprietary. Все права защищены.
