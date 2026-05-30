# Migration to swprofit.ru — Done (May 30, 2026)

## Summary

С 30 мая 2026 года основной домен проекта — **swprofit.ru** (вместо прежнего `wb-profit.vercel.app`). Старый домен остаётся живым алиасом на тот же Vercel-деплой для backward compatibility (нужен расширению v0.3.x у юзеров до их обновления на v0.4.0). Миграция выполнена в коммите `c2c12f1` (релиз v0.7.8.0), затронуто 16 файлов кода/документации/расширения.

## Что сделано

- [x] **Домен куплен** на Beget (`swprofit.ru`, 1 год)
- [x] **Vercel настроен**: apex `swprofit.ru` основной, `www.swprofit.ru` → apex (HTTP 307)
- [x] **DNS** на Beget: `A swprofit.ru → 216.198.79.1`, `CNAME www → 82f493ca6b2d0c2a.vercel-dns-017.com`
- [x] **SSL** Let's Encrypt — Vercel выпустил автоматически после привязки домена
- [x] **Supabase Auth → URL Configuration** обновлено: Site URL = `https://swprofit.ru`, Redirect URLs дополнен новым доменом (старый оставлен на время для backward compatibility восстановления пароля по email)
- [x] **Код мигрирован** (v0.7.8.0, коммит `c2c12f1`): canonical, og:url, twitter:image, JSON-LD `@id`/`url`/`logo`/`publisher`, sitemap.xml, robots.txt, Sentry `environment === 'swprofit.ru'`, alert про менеджер паролей, meta-блоки оферты/политики/Terms, реквизиты, ROADMAP, EMAIL_TEMPLATES, draft РКН-уведомления. Юр-документы обновили дату редакции до 30.05.2026
- [x] **Расширение** v0.4.0: API_TARIFFS и DASHBOARD_URL на `swprofit.ru`, HOST_ID `swprofit-host-v040`, `host_permissions` содержит **оба домена** (`swprofit.ru/*` + `wb-profit.vercel.app/*`) для backward compat при автообновлении

## Что в backlog'е (не сделано)

- [ ] **Chrome Safe Browsing** временно блокирует свежий домен `swprofit.ru` («Deceptive site ahead» при первом визите в Chrome). Подан **Reconsideration Request** через [Search Console → Security Issues](https://search.google.com/search-console). Ожидание ответа — 1–3 рабочих дня. До разблокировки юзеры из Chrome видят intercept-страницу — нужно предупредить первых тестеров.
- [ ] **Google Search Console** — property для `swprofit.ru` не создан. Сделать после разблокировки Safe Browsing. Через инструмент *Change of Address* указать переезд с `wb-profit.vercel.app`.
- [ ] **Яндекс.Вебмастер** — новый сайт не добавлен. Инструменты → Переезд сайта → указать что было `wb-profit.vercel.app`.
- [ ] **ZIP-пакет расширения v0.4.0** для Chrome Web Store не собран. Команда: `cd wb-extension && zip -r ../swprofit-ext-v0.4.0.zip . -x "*.DS_Store" -x ".gitignore"`. Публикация — после того как `manifest.json` пройдёт ревью (host_permissions содержит два домена, что Chrome может спросить — обосновать «backward compat для миграции домена»).
- [ ] **301-редирект** `wb-profit.vercel.app/*` → `swprofit.ru/*` через `vercel.json` rewrites — **намеренно отложен**. Пока расширение у юзеров на старых версиях стучится на `wb-profit.vercel.app/api/wb-tariffs`, редирект сломает виджет (Chrome `fetch` не следует 301 при cross-origin без явного указания). Включить редирект после ~3 месяцев — когда статистика Chrome Web Store покажет что 99% юзеров на 0.4.x.
- [ ] **Очистка `host_permissions`** в расширении — убрать `wb-profit.vercel.app/*` после включения 301 (см. предыдущий пункт). Это потребует майнор-апдейта расширения v0.5.0.
- [ ] **Email-домен** — `noreply@swprofit.ru` и `support@swprofit.ru` пока не настроены (SPF/DKIM/MX). Сейчас все email от `@supabase.co`. Настроить через Beget Mail или Яндекс 360 → подключить к Supabase Custom SMTP.
- [ ] **RKN-уведомление** обновить с правильным сайтом (`drafts/01-rkn-notification.md` уже содержит `swprofit.ru` после коммита `c2c12f1`).

## Известные проблемы

### 1. Медленная загрузка из РФ

Vercel прод-окружение проекта — US-датацентр (`iad1`). TTFB из РФ — 300–500ms, что заметно на лендинге. На `wb-profit.vercel.app` это была норма (юзеры привыкли), но для собственного домена ожидания выше.

**План решения** (выбор предстоит):
- **Cloudflare прокси** (оранжевая туча в DNS) — бесплатно, CDN-edge включая Москву, кеширование статики. Возможный риск: Cloudflare блокирует подозрительный трафик селлерских ботов с WB.
- **Yandex Cloud CDN** — российский edge, без риска блокировок, но платно и менее удобный для статики.
- **Перенос Vercel на FRA1** — Frankfurt ближе к РФ географически (~80ms vs 300ms), но Vercel Hobby не позволяет выбирать регион (только Pro $20/мес).

Решение откладывается до получения метрик после разблокировки Safe Browsing.

### 2. Email из Supabase — спам-фолдер

С момента смены домена в Supabase Auth → Site URL некоторые юзеры (с включённым строгим anti-spam в Gmail/Mail.ru) сообщают что письма «Подтвердите email» уходят в спам. Это нормально для первых дней после смены домена-источника. Решится после настройки Custom SMTP с правильными SPF/DKIM (см. пункт в backlog).

---

## Ссылки

- Прод: https://swprofit.ru
- Legacy алиас: https://wb-profit.vercel.app (живой, тот же deploy)
- Vercel project: `wb-profit` (имя проекта не переименовано, это косметика)
- Beget DNS: панель управления Beget → swprofit.ru → DNS-зона
- Supabase: dashboard.supabase.com → проект `wb-profit` (имя не переименовано)

---

*Документ ведётся как post-mortem. История старого плана миграции — в git history: `git show c2c12f1~1 -- MIGRATION_DOMAIN.md`.*
