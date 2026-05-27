# Changelog

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.0.0/).

## [v0.7.7.19] — 2026-05-27

### Безопасность (КРИТИЧНО)
- 🔴 **Закрыта эскалация привилегий** через клиентский SDK на таблице `profiles`. Раньше любой пользователь мог сделать `update({is_admin:true, plan:'pro'})` и стать админом с бесплатным PRO. Теперь триггер `protect_profile_admin_fields` блокирует изменение служебных полей (`is_admin`, `plan`, `plan_expires_at`, `id`, `created_at`) для всех ролей кроме `service_role`.
- 🔴 **Закрыта подделка user_id в INSERT** на таблицах `unit_calc_history` и `user_costs`. INSERT-политики получили `WITH CHECK (user_id = auth.uid())`.

### Добавлено
- Lead-форма на лендинге внизу страницы. Сбор email + UTM-параметров. Защита от дубликатов (UNIQUE на email). Endpoint `/api/config` POST.
- Таблица `public.leads` с RLS (service-only), индексы по `created_at` и `source`.

## [v0.7.7.18] — 2026-05-27

### Безопасность
- Исправлено расхождение цен между офертой и лендингом (юридический риск ст.437 ГК РФ): синхронизированы 490/690/890 ₽.
- SLA в оферте понижен с 99% до 95% (реалистичнее для Vercel Hobby).
- Указано место хранения ПД в `privacy.html` (требование 152-ФЗ ст.18).

### Добавлено
- `LEGAL_AUDIT.md` — чек-лист юридических находок (14 пунктов).
- `EMAIL_TEMPLATES.md` — 4 готовых HTML-шаблона для Supabase Auth на русском.

## [v0.7.7.17] — 2026-05-27

### Добавлено (M11 из аудита)
- Таблица `audit_log` с CHECK на whitelist event_type.
- Триггер `audit_log_on_signup` — автоматический лог регистрации.
- `lib/audit-log.js` — единая утилита для всех `/api/*`.
- Интеграция в `/api/profile`, `/api/promo`, `/api/admin`.

## [v0.7.7.16] — 2026-05-27 (Пакет А housekeeping)

### Добавлено
- `public/404.html` — кастомная страница 404 с фирменным дизайном.
- `README.md` — описание стека, структуры, env, security.
- `.env.example` — placeholder для всех env-переменных.
- `.gitignore` — защита от утечки секретов.

### Изменено
- Архивирована таблица `dev_journal` → `dev_journal_archive_v1` (106 записей сохранены).

## [v0.7.7.15] — 2026-05-27 (Dark theme audit)

### Исправлено
- Полоски «Куда ушли деньги» на Главной — был тёмный фон поверх градиента.
- Danger zone «Удалить аккаунт» в Настройках — светло-розовый фон в dark.
- Кнопка «Удалить аккаунт» — была фиолетовой вместо красной.
- `<code>DELETE</code>` подсказка в модале — слишком яркая.

## [v0.7.7.14] — 2026-05-27

### Добавлено
- JSON-LD structured data на лендинге: Organization, WebSite, SoftwareApplication с 3 Offers, FAQPage с 5 вопросами.

## [v0.7.7.13] — 2026-05-27 (M3 из аудита, 152-ФЗ ст.9)

### Добавлено
- Удаление аккаунта самообслуживанием.
- Postgres-функция `delete_user_account(uuid)` (SECURITY DEFINER, service_role only).
- `/api/profile` DELETE с двойной защитой (пароль + слово DELETE).
- Модал в Настройках с danger zone.

## [v0.7.7.12] — 2026-05-27 (M2)

### Добавлено
- Восстановление пароля: ссылка «Забыли пароль?» на login.html.
- Новая страница `reset-password.html` для установки нового пароля.
- Интеграция с Supabase Auth recovery flow.

## [v0.7.7.11] — 2026-05-27 (B3 + C5 + M1)

### Безопасность
- 🔴 **RLS leak fix**: `claude_session_journal` и `wb_warehouse_tariffs` имели `rowsecurity=false` — anon ключ мог читать содержимое. Включён RLS + service-only policy.

### Изменено
- Кэш-политика разделена: лендинг/оферта/политика — `public max-age=300`, dashboard/login — `no-store`, static — `immutable 1 year`.
- Сильно расширены SEO meta-теги (description, OG, Twitter Cards) на лендинге.

### Добавлено
- `/favicon.svg`, `/og-image.svg` (1200×630), `/robots.txt`, `/sitemap.xml`.

## [v0.7.7.10] — 2026-05-27

### Изменено
- Убраны 5 дублирующих кнопок 🔄 с виджетов Главной — все вызывали одну и ту же глобальную загрузку.

## [v0.7.7.9] — 2026-05-27 (Hotfix)

### Исправлено
- 🔴 Критический баг: `localStorage.wb_token` мог перетереться 422 буллетами (U+2022) от автозаполнения паролей браузера, после чего все запросы к WB API падали. Добавлена 3-слойная защита `isAsciiToken`.

## [v0.7.7.8] — 2026-05-26

### Исправлено
- Health-check `/api/config?health=1` — переключен на `/auth/v1/settings` для корректной проверки Supabase.

## До v0.7.7.8

Подробная история ранних версий хранится в Supabase в таблице `dev_journal_archive_v1` (заархивирована в v0.7.7.16).
