# Миграция домена: `wb-profit.vercel.app` → новый домен

Чек-лист для одномоментной замены домена во всём репозитории, когда зарегистрируешь свой домен (рабочий вариант — `swprofit.ru`).

Снапшот собран на коммите `0ed799a` (после v0.7.7.37). При появлении новых файлов с упоминанием домена — переснять `grep -rn "wb-profit\.vercel\.app" .`.

---

## Правило безопасной миграции

**Не делать замену «всё сразу через sed».** Шаги в правильном порядке:

1. Купить домен, привязать к Vercel, проверить что новый домен отдаёт прод (без замены — Vercel умеет два домена одновременно).
2. Настроить **301-редиректы** со старого `wb-profit.vercel.app/*` на новый — через `vercel.json` rewrites. Это снимает риск 404 по старым ссылкам.
3. Дождаться что новый домен стабильно работает (1–2 дня).
4. Сделать find-replace в коде по чек-листу ниже. Закоммитить.
5. Обновить SEO: подать новый sitemap в Яндекс.Вебмастер и Google Search Console, отметить смену домена.
6. **Только потом** обновлять расширение в Chrome Web Store (см. отдельный пункт ниже).
7. Старый `wb-profit.vercel.app` оставить с редиректом ещё минимум 6 месяцев — пока поисковики переиндексируют.

---

## Группа A — критично для функционирования

Если эти точки не поменять одновременно с миграцией — продукт сломается.

| Файл:строка | Контекст | Что поменять |
|---|---|---|
| [wb-profit/public/dashboard.html:64](wb-profit/public/dashboard.html#L64) | `environment: location.hostname === 'wb-profit.vercel.app' ? 'production' : 'preview'` | На новый домен — иначе Sentry будет всегда писать `preview`. |
| [wb-extension/manifest.json:12](wb-extension/manifest.json#L12) | `"https://wb-profit.vercel.app/*"` в `host_permissions` | На новый — иначе расширение **не сможет ходить в API**. Требует перевыпуска версии в Chrome Web Store. |
| [wb-extension/content/widget.js:15](wb-extension/content/widget.js#L15) | `const API_TARIFFS = 'https://wb-profit.vercel.app/api/wb-tariffs'` | На новый — иначе виджет на странице WB **перестанет грузить тарифы**. |
| [wb-extension/content/widget.js:17](wb-extension/content/widget.js#L17) | `const DASHBOARD_URL = 'https://wb-profit.vercel.app/dashboard.html'` | На новый — иначе кнопка «Открыть кабинет» из виджета поведёт на 301-редирект (работает, но грязно). |
| [wb-extension/popup.html:8](wb-extension/popup.html#L8) | `<a href="https://wb-profit.vercel.app/dashboard.html">` | На новый. |

---

## Группа B — SEO и поисковые системы

Если не поменять — Google/Yandex продолжат думать что прод на старом домене.

| Файл:строка | Контекст | Что поменять |
|---|---|---|
| [wb-profit/public/index.html:9](wb-profit/public/index.html#L9) | `<link rel="canonical" href="https://wb-profit.vercel.app/">` | На новый. |
| [wb-profit/public/index.html:16](wb-profit/public/index.html#L16) | `<meta property="og:url" content="https://wb-profit.vercel.app/">` | На новый. |
| [wb-profit/public/index.html:19](wb-profit/public/index.html#L19) | `<meta property="og:image" content="https://wb-profit.vercel.app/og-image.svg">` | На новый. |
| [wb-profit/public/index.html:28](wb-profit/public/index.html#L28) | `<meta name="twitter:image" content="https://wb-profit.vercel.app/og-image.svg">` | На новый. |
| [wb-profit/public/index.html:37](wb-profit/public/index.html#L37) | JSON-LD `"@id": "https://wb-profit.vercel.app/#organization"` | На новый. **Внимание:** `@id` — это глобальный идентификатор сущности, после смены поисковики посчитают это новой организацией. После миграции — указать `sameAs` со старым `@id` или подождать переиндексации. |
| [wb-profit/public/index.html:39](wb-profit/public/index.html#L39) | JSON-LD Organization `"url"` | На новый. |
| [wb-profit/public/index.html:40](wb-profit/public/index.html#L40) | JSON-LD `"logo": ".../favicon.svg"` | На новый. |
| [wb-profit/public/index.html:53](wb-profit/public/index.html#L53) | JSON-LD `"@id": "...#website"` | На новый (см. предупреждение про `@id` выше). |
| [wb-profit/public/index.html:54](wb-profit/public/index.html#L54) | JSON-LD WebSite `"url"` | На новый. |
| [wb-profit/public/index.html:57](wb-profit/public/index.html#L57) | JSON-LD `"publisher": {"@id": "...#organization"}` | На новый. |
| [wb-profit/public/index.html:65](wb-profit/public/index.html#L65) | JSON-LD SoftwareApplication `"url"` | На новый. |
| [wb-profit/public/login.html:9](wb-profit/public/login.html#L9) | `<link rel="canonical" href="https://wb-profit.vercel.app/login.html">` | На новый. |
| [wb-profit/public/offer.html:7](wb-profit/public/offer.html#L7) | `<link rel="canonical" href="https://wb-profit.vercel.app/offer.html">` | На новый. |
| [wb-profit/public/privacy.html:7](wb-profit/public/privacy.html#L7) | `<link rel="canonical" href="https://wb-profit.vercel.app/privacy.html">` | На новый. |
| [wb-profit/public/sitemap.xml:4](wb-profit/public/sitemap.xml#L4) | `<loc>https://wb-profit.vercel.app/</loc>` | На новый. |
| [wb-profit/public/sitemap.xml:9](wb-profit/public/sitemap.xml#L9) | `<loc>https://wb-profit.vercel.app/index.html</loc>` | На новый. |
| [wb-profit/public/sitemap.xml:14](wb-profit/public/sitemap.xml#L14) | `<loc>https://wb-profit.vercel.app/demo</loc>` | На новый. |
| [wb-profit/public/sitemap.xml:19](wb-profit/public/sitemap.xml#L19) | `<loc>https://wb-profit.vercel.app/login.html</loc>` | На новый. |
| [wb-profit/public/sitemap.xml:24](wb-profit/public/sitemap.xml#L24) | `<loc>https://wb-profit.vercel.app/offer.html</loc>` | На новый. |
| [wb-profit/public/sitemap.xml:29](wb-profit/public/sitemap.xml#L29) | `<loc>https://wb-profit.vercel.app/privacy.html</loc>` | На новый. |

---

## Группа C — видимые юзеру тексты

Если не поменять — юзер увидит старый домен в подсказках/документах.

| Файл:строка | Контекст | Что поменять |
|---|---|---|
| [wb-profit/public/dashboard.html:3781](wb-profit/public/dashboard.html#L3781) | alert: `«…добавьте wb-profit.vercel.app в исключения»` | На новый — иначе подсказка про менеджер паролей назовёт старый домен. |
| [wb-profit/public/offer.html:48](wb-profit/public/offer.html#L48) | meta-блок: `«…доступна по адресу wb-profit.vercel.app/offer.html»` | На новый. После замены — обновить **дату редакции оферты** (юр.артефакт). |
| [wb-profit/public/privacy.html:51](wb-profit/public/privacy.html#L51) | meta-блок: `«…Действующая версия — wb-profit.vercel.app/privacy.html»` | На новый. Обновить дату редакции. |

---

## Группа D — документация репо

Внутренние документы. Заменить можно в одном проходе с `sed`.

| Файл:строка | Контекст |
|---|---|
| [README.md:5](README.md#L5) | `🌐 Прод: https://wb-profit.vercel.app` |
| [README.md:6](README.md#L6) | `📊 Демо: https://wb-profit.vercel.app/demo` |
| [ROADMAP.md:25](ROADMAP.md#L25) | `прод на wb-profit.vercel.app` |
| [ROADMAP.md:86](ROADMAP.md#L86) | про настройку Я.Метрики |
| [EMAIL_TEMPLATES.md:187](EMAIL_TEMPLATES.md#L187) | `Site URL = https://wb-profit.vercel.app` (потом меняется в Supabase Auth) |
| [drafts/01-rkn-notification.md:34](drafts/01-rkn-notification.md#L34) | про РКН-уведомление |
| [drafts/04-domain-rename-plan.md:18](drafts/04-domain-rename-plan.md#L18) | «Было: wb-profit.vercel.app» — **не трогать**, это исторический контекст плана |
| [drafts/04-domain-rename-plan.md:93](drafts/04-domain-rename-plan.md#L93) | про 301-редиректы — **не трогать**, контекст плана |
| [drafts/04-domain-rename-plan.md:131](drafts/04-domain-rename-plan.md#L131) | «Старый домен оставил с редиректом» — **не трогать**, чек-лист после миграции |

---

## Команда для одномоментной замены кода/SEO

После пунктов 1–3 правила безопасной миграции:

```bash
# В переменную NEWDOMAIN подставь свой (без https://, например swprofit.ru)
NEWDOMAIN="swprofit.ru"

# Группы A + B + C: код, SEO, видимые тексты
find wb-profit/public wb-extension -type f \( -name "*.html" -o -name "*.js" -o -name "*.json" -o -name "*.xml" \) \
  -exec sed -i '' "s|wb-profit\.vercel\.app|${NEWDOMAIN}|g" {} +

# Группа D: документация (без drafts/04 — там история)
sed -i '' "s|wb-profit\.vercel\.app|${NEWDOMAIN}|g" README.md ROADMAP.md EMAIL_TEMPLATES.md drafts/01-rkn-notification.md

# Проверка: должно остаться только в drafts/04-domain-rename-plan.md
grep -rn "wb-profit\.vercel\.app" . --include="*.html" --include="*.js" --include="*.json" --include="*.md" --include="*.xml"
```

---

## Отдельные действия вне кода

После замены кода:

- [ ] **Supabase Auth → Settings → Site URL** — заменить на новый домен.
- [ ] **Supabase Auth → Redirect URLs** — добавить новый домен в whitelist (старый оставить временно для совместимости).
- [ ] **Vercel → Project → Domains** — основной поставить новый, старый — с 301-редиректом.
- [ ] **Яндекс.Метрика → Настройки** — добавить новый домен в счётчик.
- [ ] **Яндекс.Вебмастер** — добавить новый сайт, заявить смену хоста (Инструменты → Переезд сайта).
- [ ] **Google Search Console** — добавить новый property, использовать Change of Address tool.
- [ ] **Chrome Web Store (если расширение опубликовано)** — выпустить новую версию (`0.4.0`) с новым `host_permissions`. Если URL отличается — Chrome потребует подтвердить новые права у пользователя при апгрейде.
- [ ] **Email-домен** — `noreply@wbprofit.ru` → `noreply@<новый>`, обновить в Supabase Custom SMTP, в footer email-шаблонов, поднять SPF/DKIM на новом домене.

---

## Что НЕ трогать никогда

- Имена колонок БД: `wb_account_id`, `wb_token`, `wb_costs`, `wb_seller_name` и т.д. Это про **платформу Wildberries** (внешняя сущность), не про наш бренд.
- DOM/CSS-идентификаторы в расширении: `wbprofit-host-v037`, `wbprofit-drawer-cloak`. Это внутренние id хоста виджета на странице WB.
- Все упоминания «Wildberries» / «WB» в текстах оферты, политики, лендинга — это **описание платформы**, на которой работает сервис, использовать чужой бренд для обозначения совместимости юридически допустимо.

---

*Документ собран автоматически. При появлении новых файлов с упоминанием домена — переснять snapshot:*
```bash
grep -rn "wb-profit\.vercel\.app" . --include="*.html" --include="*.js" --include="*.ts" --include="*.json" --include="*.md" --include="*.xml" --include="*.svg" | wc -l
```
*Ожидаемое число точек на момент сборки документа: **37**.*
