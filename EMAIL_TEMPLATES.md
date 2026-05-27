# Email-шаблоны для Supabase Auth

Готовые шаблоны писем для замены английских по умолчанию в Supabase.

## Где вставить

1. Открой Supabase Dashboard → твой проект → **Authentication** → **Email Templates**
2. Для каждого шаблона ниже:
   - Выбери соответствующий тип (Confirm signup / Reset password / Magic link / Change email)
   - Замени **Subject** на тот что указан ниже
   - Замени **Message Body** на HTML из блока ниже
   - Сохрани

⚠️ В шаблонах используются переменные Supabase: `{{ .Email }}`, `{{ .ConfirmationURL }}`, `{{ .Token }}`. Их менять не нужно.

---

## 1. Confirm signup (подтверждение регистрации)

**Subject:**
```
Подтвердите регистрацию в WB Profit
```

**Body HTML:**
```html
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>Подтверждение регистрации — WB Profit</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f7f5;color:#1a1a18;line-height:1.5">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f5;padding:40px 16px">
<tr><td align="center">
<table width="100%" style="max-width:520px;background:#fff;border-radius:14px;padding:36px;box-shadow:0 1px 3px rgba(0,0,0,.05)" cellpadding="0" cellspacing="0">
<tr><td>
<div style="text-align:center;margin-bottom:24px">
<div style="display:inline-block;width:48px;height:48px;background:linear-gradient(135deg,#7c3aed,#5b21b6);border-radius:11px;line-height:48px;color:#fff;font-weight:800;font-size:22px">W</div>
<div style="font-size:20px;font-weight:600;color:#5433c6;margin-top:8px">WB Profit</div>
</div>
<h1 style="font-size:22px;margin:0 0 16px;color:#1a1a18">Добро пожаловать!</h1>
<p style="font-size:15px;color:#374151;margin-bottom:24px">Спасибо за регистрацию в WB Profit. Чтобы активировать аккаунт, подтвердите свой email — нажмите кнопку ниже:</p>
<div style="text-align:center;margin:32px 0">
<a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#5433c6;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Подтвердить email</a>
</div>
<p style="font-size:13px;color:#6b6b68;margin-bottom:8px">Если кнопка не работает — скопируйте эту ссылку в браузер:</p>
<p style="font-size:12px;color:#5433c6;word-break:break-all;padding:10px;background:#f5f3ff;border-radius:6px">{{ .ConfirmationURL }}</p>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0">
<p style="font-size:12px;color:#a0a09c;margin:0">Если вы не регистрировались в WB Profit — просто проигнорируйте это письмо.</p>
</td></tr>
</table>
<p style="font-size:11px;color:#a0a09c;margin-top:16px;text-align:center">WB Profit · Аналитика продаж Wildberries<br>ИП Чиркова А.В. · ИНН 233304659652</p>
</td></tr>
</table>
</body>
</html>
```

---

## 2. Reset password (восстановление пароля)

**Subject:**
```
Восстановление пароля в WB Profit
```

**Body HTML:**
```html
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>Восстановление пароля — WB Profit</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f7f5;color:#1a1a18;line-height:1.5">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f5;padding:40px 16px">
<tr><td align="center">
<table width="100%" style="max-width:520px;background:#fff;border-radius:14px;padding:36px;box-shadow:0 1px 3px rgba(0,0,0,.05)" cellpadding="0" cellspacing="0">
<tr><td>
<div style="text-align:center;margin-bottom:24px">
<div style="display:inline-block;width:48px;height:48px;background:linear-gradient(135deg,#7c3aed,#5b21b6);border-radius:11px;line-height:48px;color:#fff;font-weight:800;font-size:22px">W</div>
<div style="font-size:20px;font-weight:600;color:#5433c6;margin-top:8px">WB Profit</div>
</div>
<h1 style="font-size:22px;margin:0 0 16px;color:#1a1a18">Восстановление пароля</h1>
<p style="font-size:15px;color:#374151;margin-bottom:24px">Кто-то (надеемся вы) запросил восстановление пароля для аккаунта <b>{{ .Email }}</b>. Чтобы установить новый пароль — нажмите кнопку ниже:</p>
<div style="text-align:center;margin:32px 0">
<a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#5433c6;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Установить новый пароль</a>
</div>
<p style="font-size:13px;color:#6b6b68;margin-bottom:8px">Если кнопка не работает — скопируйте эту ссылку в браузер:</p>
<p style="font-size:12px;color:#5433c6;word-break:break-all;padding:10px;background:#f5f3ff;border-radius:6px">{{ .ConfirmationURL }}</p>
<p style="font-size:13px;color:#7f1d1d;background:#fef2f2;padding:12px;border-radius:6px;margin-top:24px">⚠️ Ссылка действует 1 час. Если не воспользуетесь — потребуется новый запрос.</p>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0">
<p style="font-size:12px;color:#a0a09c;margin:0">Если вы не запрашивали восстановление — просто проигнорируйте это письмо. Ваш пароль не изменится.</p>
</td></tr>
</table>
<p style="font-size:11px;color:#a0a09c;margin-top:16px;text-align:center">WB Profit · Аналитика продаж Wildberries<br>ИП Чиркова А.В. · ИНН 233304659652</p>
</td></tr>
</table>
</body>
</html>
```

---

## 3. Magic link (вход по ссылке)

**Subject:**
```
Ваша ссылка для входа в WB Profit
```

**Body HTML:**
```html
<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f7f5;color:#1a1a18;line-height:1.5">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f5;padding:40px 16px">
<tr><td align="center">
<table width="100%" style="max-width:520px;background:#fff;border-radius:14px;padding:36px;box-shadow:0 1px 3px rgba(0,0,0,.05)" cellpadding="0" cellspacing="0">
<tr><td>
<div style="text-align:center;margin-bottom:24px">
<div style="display:inline-block;width:48px;height:48px;background:linear-gradient(135deg,#7c3aed,#5b21b6);border-radius:11px;line-height:48px;color:#fff;font-weight:800;font-size:22px">W</div>
<div style="font-size:20px;font-weight:600;color:#5433c6;margin-top:8px">WB Profit</div>
</div>
<h1 style="font-size:22px;margin:0 0 16px;color:#1a1a18">Вход в WB Profit</h1>
<p style="font-size:15px;color:#374151;margin-bottom:24px">Нажмите кнопку, чтобы войти в аккаунт <b>{{ .Email }}</b>:</p>
<div style="text-align:center;margin:32px 0">
<a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#5433c6;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Войти в WB Profit</a>
</div>
<p style="font-size:13px;color:#7f1d1d;background:#fef2f2;padding:12px;border-radius:6px">⚠️ Ссылка одноразовая, действует 1 час.</p>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0">
<p style="font-size:12px;color:#a0a09c;margin:0">Если вы не запрашивали вход — просто проигнорируйте это письмо.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
```

---

## 4. Change email (подтверждение смены email)

**Subject:**
```
Подтвердите новый email в WB Profit
```

**Body HTML:**
```html
<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f7f5;color:#1a1a18;line-height:1.5">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f5;padding:40px 16px">
<tr><td align="center">
<table width="100%" style="max-width:520px;background:#fff;border-radius:14px;padding:36px;box-shadow:0 1px 3px rgba(0,0,0,.05)" cellpadding="0" cellspacing="0">
<tr><td>
<div style="text-align:center;margin-bottom:24px">
<div style="display:inline-block;width:48px;height:48px;background:linear-gradient(135deg,#7c3aed,#5b21b6);border-radius:11px;line-height:48px;color:#fff;font-weight:800;font-size:22px">W</div>
<div style="font-size:20px;font-weight:600;color:#5433c6;margin-top:8px">WB Profit</div>
</div>
<h1 style="font-size:22px;margin:0 0 16px;color:#1a1a18">Подтверждение нового email</h1>
<p style="font-size:15px;color:#374151;margin-bottom:24px">В аккаунте <b>WB Profit</b> запрошена смена email на <b>{{ .Email }}</b>. Чтобы подтвердить — нажмите кнопку:</p>
<div style="text-align:center;margin:32px 0">
<a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#5433c6;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Подтвердить новый email</a>
</div>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0">
<p style="font-size:12px;color:#a0a09c;margin:0">Если вы не запрашивали смену email — срочно зайдите в кабинет и смените пароль.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
```

---

## После настройки шаблонов

Также в Supabase Dashboard → **Authentication** → **Settings**:
- **Site URL** = `https://wb-profit.vercel.app` (или твой будущий домен)
- **Sender Name** = `WB Profit` (или твой бренд)
- **Sender Email** = `noreply@wbprofit.ru` (после покупки домена и настройки SPF/DKIM)

⚠️ **Без настройки своего SMTP** Supabase шлёт письма с домена `@supabase.co` — это снижает доставляемость и может попадать в спам. Для прода настоятельно рекомендуется подключить SendGrid / Mailgun / Yandex SMTP через **Authentication → Email Settings → Enable Custom SMTP**.
