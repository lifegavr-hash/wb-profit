// lib/email.js — транзакционная отправка через Unisender Go HTTP API (Node, для Vercel-функций).
// Секрет UNISENDER_API_KEY — в Vercel env (server-side). DC по умолчанию go2 (как у Edge daily-digest).
// Транзакционное письмо: List-Unsubscribe НЕ нужен.
const UNI_BASE = process.env.UNISENDER_API_BASE || 'https://go2.unisender.ru';
const FROM_EMAIL = 'noreply@swprofit.ru';
const FROM_NAME = 'SW Profit';

export async function sendTransactional(to, subject, html, plaintext) {
  const key = process.env.UNISENDER_API_KEY;
  if (!key) throw new Error('UNISENDER_API_KEY not set');
  const r = await fetch(`${UNI_BASE}/ru/transactional/api/v1/email/send.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({
      message: {
        recipients: [{ email: to }],
        subject,
        from_email: FROM_EMAIL,
        from_name: FROM_NAME,
        body: { html, plaintext },
      },
    }),
  });
  if (!r.ok) throw new Error(`unisender ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return true;
}
