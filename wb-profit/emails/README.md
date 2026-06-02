# Email-шаблоны SW Profit

Все шаблоны написаны как **email-friendly HTML**: table layout, inline CSS, fallback fonts, поддержка Outlook (MSO conditional comments). Брендинг: фиолетовый `#5433c6`, светлый фон `#f7f7f5`, шрифт system stack с fallback.

Тестировались в почтовых клиентах: Gmail Web/iOS/Android, Apple Mail (macOS + iOS), Outlook Web/Desktop, Yandex Mail, Mail.ru.

---

## 📁 Структура

```
emails/
├── onboarding/              ← Транзакционные письма (требуют backend/cron)
│   ├── welcome.html         ← Сразу после регистрации
│   ├── day1.html            ← Через 24 часа
│   └── day7.html            ← Через 7 дней (фидбэк)
└── supabase-auth/           ← Кастомизация писем Supabase Auth
    ├── confirm-email.html   ← Подтверждение email (replaces default)
    └── recovery.html        ← Восстановление пароля (replaces default)
```

---

## 🚀 Активация: Supabase Auth (быстро — 2 шаблона)

Эти шаблоны **уже сейчас** заменят дефолтные письма Supabase (с логотипом Supabase) на брендированные SW Profit.

**Условие**: SMTP должен быть настроен в Supabase Dashboard (`Project Settings → Auth → SMTP Settings`).

**Шаги активации:**

1. Открыть https://supabase.com/dashboard → проект `bqbccehwbgqzfczfubvf` → **Authentication** → **Email Templates**
2. Для каждого шаблона:
   - **Confirm signup** ← вставить содержимое `supabase-auth/confirm-email.html`
     - Subject: `Подтвердите email — SW Profit`
   - **Reset password** ← вставить содержимое `supabase-auth/recovery.html`
     - Subject: `Восстановление пароля — SW Profit`
3. Нажать **Save** для каждого

Доступные переменные Supabase (используются в шаблонах):
- `{{ .ConfirmationURL }}` — ссылка для действия (подтверждение / сброс)
- `{{ .Email }}` — email юзера
- `{{ .SiteURL }}` — URL сайта (https://swprofit.ru)

---

## 📨 Активация: Onboarding (требует backend — welcome + day1 + day7)

Эти 3 шаблона **отправляются вручную** через backend-логику (которая ещё не написана). Шаблоны лежат в коде «впрок» — когда backend будет, шаблоны уже готовы.

### Что нужно для активации:

1. **SMTP** настроен в Supabase Dashboard (Unisender Go)
2. **Edge Function** для каждого письма:
   - `send-welcome-email` — триггер: после `auth.users INSERT` (через DB Trigger)
   - `send-day1-email` — триггер: `pg_cron` каждый час, ищет юзеров `created_at = NOW() - 24h ± 30min`, проверяет `wb_accounts` для условной логики
   - `send-day7-email` — триггер: `pg_cron` каждый день, ищет юзеров `created_at = NOW() - 7d ± 1 день`

### Переменные в шаблонах:

В файлах используются плейсхолдеры **Handlebars-style** `{{VARIABLE_NAME}}` для подстановки на стороне backend. Конкретные:

| Шаблон | Переменная | Значение |
|---|---|---|
| `welcome.html` | — | Статический текст, переменных нет |
| `day1.html` | `{{FIRST_NAME|default:Привет}}` | Имя юзера (или `Привет` если не указан) |
| `day1.html` | `{{SALES_COUNT}}` | Количество загруженных продаж (для варианта Б) |
| `day1.html` | `{{PERIOD_DAYS}}` | Период загрузки в днях (для варианта Б) |
| `day7.html` | `{{FIRST_NAME|default:Привет}}` | Имя юзера (или `Привет`) |

### Версии Day 1

`day1.html` содержит **два варианта** контента:
- **Вариант A (по умолчанию активный)**: токен НЕ подключён → текст «как дела с подключением + помощь»
- **Вариант B (закомментирован)**: токен подключён → текст «отлично, что попробовать сейчас»

При отправке backend выбирает версию по проверке `SELECT COUNT(*) FROM wb_accounts WHERE user_id = ...`. Соответствующий блок раскомментируется (или используется отдельная копия шаблона `day1-success.html`).

---

## 🧪 Локальное тестирование

Открыть любой `.html` файл в браузере — видно как будет выглядеть письмо. Реальный рендер в почтовом клиенте может отличаться (особенно Outlook Desktop, где не поддерживается современный CSS).

Рекомендуется проверить в:
1. https://www.mail-tester.com — отправить тестовое письмо, проверить spam score
2. https://litmus.com или https://www.emailonacid.com — preview в разных клиентах
3. Реальная отправка на свои почты: Gmail, Yandex, Mail.ru, Outlook

---

## ⚠️ Что НЕ работает в email клиентах

Если будешь править шаблоны:
- ❌ Flexbox / Grid — не поддерживается Outlook
- ❌ `position: absolute/fixed` — не работает
- ❌ Web fonts через `@import` — заблокированы Gmail
- ❌ `<script>`, `<iframe>`, `<form>` — вырезаются клиентами
- ❌ Background images через CSS (только через `<img>` или MSO conditional)
- ❌ External CSS `<link>` — игнорируется большинством клиентов

Что работает везде:
- ✅ Table layout
- ✅ Inline CSS на каждом элементе
- ✅ Эмодзи (Unicode)
- ✅ Web-safe шрифты + fallback на system stack
- ✅ Кнопки через `<table>` с `background-color` и `<a>` с padding

---

## 📝 История

- **v0.7.10.5** (03.06.2026): первая версия — 5 шаблонов
