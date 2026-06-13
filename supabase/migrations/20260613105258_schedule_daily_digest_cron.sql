-- Крон ежедневного email-дайджеста (Фаза C). Идемпотентно по jobname.
-- Секрет берётся из Vault (cron_secret) — НЕ хардкодим. = env CRON_SECRET функции daily-digest.
-- Расписание: 05:00 UTC = 08:00 МСК, ежедневно.
select cron.schedule(
  'daily-digest-email',
  '0 5 * * *',
  $$
  select net.http_post(
    url := 'https://bqbccehwbgqzfczfubvf.functions.supabase.co/daily-digest',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
