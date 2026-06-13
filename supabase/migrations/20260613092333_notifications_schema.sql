-- notifications_schema — email-уведомления (Фаза C)
-- Source of truth для схемы уведомлений. Таблицы + RLS + триггер.
-- cron.schedule НЕ здесь (ставится отдельно, секрет из Vault) — см. docs/PHASE_C.
create extension if not exists pg_net;   -- pg_cron/pg_net уже установлены; идемпотентно

create table if not exists public.notification_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  daily_email_enabled boolean not null default false,   -- явный opt-in, по умолчанию OFF
  unsubscribe_token uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists notification_settings_unsub_idx
  on public.notification_settings(unsubscribe_token);

create table if not exists public.email_send_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,                       -- 'daily_digest'
  digest_date date not null,                -- за какой день (по МСК)
  status text not null,                     -- 'sending'|'sent'|'failed'
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, kind, digest_date)       -- физический запрет 2-го письма за день
);
create index if not exists email_send_log_user_idx
  on public.email_send_log(user_id, created_at desc);

alter table public.notification_settings enable row level security;
alter table public.email_send_log        enable row level security;

create policy notif_own_select on public.notification_settings
  for select using (auth.uid() = user_id);
create policy notif_own_insert on public.notification_settings
  for insert with check (auth.uid() = user_id);
create policy notif_own_update on public.notification_settings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- email_send_log: НЕТ политик для authenticated → доступ только service-role (Edge Function)

create or replace function public.touch_updated_at() returns trigger
  language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists notif_touch on public.notification_settings;
create trigger notif_touch before update on public.notification_settings
  for each row execute function public.touch_updated_at();
