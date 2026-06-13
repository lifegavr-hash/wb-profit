-- Командный доступ (Фаза D). Бизнес, до 3 пользователей всего (владелец + 2 участника).
-- Модель доступа: app-layer (resolveWorkspace в lib/team.js). RLS базовых таблиц НЕ трогаем.
-- Таблицы команды + индексы + RLS + триггер лимита + RPC приёма инвайта + правка delete_user_account.

-- ===== team_members =====
create table public.team_members (
  id         bigint generated always as identity primary key,
  owner_id   uuid not null references public.profiles(id) on delete cascade,  -- чьё пространство
  member_id  uuid not null references public.profiles(id) on delete cascade,  -- кто смотрит
  role       text not null default 'viewer',
  created_at timestamptz not null default now(),
  unique (owner_id, member_id),
  check (owner_id <> member_id)            -- нельзя добавить самого себя
);
create index team_members_member_idx on public.team_members(member_id);
create index team_members_owner_idx  on public.team_members(owner_id);

-- ===== team_invites =====
create table public.team_invites (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  email       text not null,
  token       uuid not null default gen_random_uuid(),
  status      text not null default 'pending'
              check (status in ('pending','accepted','revoked','expired')),
  expires_at  timestamptz not null default (now() + interval '7 days'),
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references public.profiles(id) on delete set null
);
create unique index team_invites_token_uniq on public.team_invites(token);
create index team_invites_owner_idx on public.team_invites(owner_id);
-- запрет двух ЖИВЫХ pending-инвайтов на один email у одного владельца
create unique index team_invites_pending_uniq
  on public.team_invites(owner_id, lower(email)) where status = 'pending';

-- ===== RLS (базовые таблицы не трогаем; здесь только новые) =====
alter table public.team_members enable row level security;
alter table public.team_invites enable row level security;

-- team_members: владелец видит свою команду; участник — только строки про себя.
-- Запись — без authenticated-политик → только service-role (api/RPC). service_role обходит RLS.
create policy team_members_select on public.team_members
  for select to authenticated
  using (owner_id = auth.uid() or member_id = auth.uid());

-- team_invites: видит только владелец. Приём — по токену через RPC (service-role).
create policy team_invites_select on public.team_invites
  for select to authenticated
  using (owner_id = auth.uid());

-- ===== Триггер лимита мест (зеркало enforce_wb_accounts_limit) =====
-- max_team_members = всего мест ВКЛ. владельца (business=3) → участников = max-1 (=2).
-- Считаем: принятые участники + ЖИВЫЕ pending-инвайты (expires_at>now()).
create or replace function public.enforce_team_limit() returns trigger
  language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  owner_plan     text;
  owner_is_admin boolean;
  max_total      integer;
  member_seats   integer;
  used           integer;
begin
  select plan, is_admin into owner_plan, owner_is_admin from profiles where id = NEW.owner_id;
  if owner_is_admin then return NEW; end if;

  select max_team_members into max_total from plans where id = coalesce(owner_plan, 'pro');
  if max_total is null then max_total := 1; end if;
  member_seats := greatest(max_total - 1, 0);

  select count(*) into used from (
    select 1 from team_members where owner_id = NEW.owner_id
    union all
    select 1 from team_invites
      where owner_id = NEW.owner_id and status = 'pending' and expires_at > now()
  ) s;

  if used >= member_seats then
    raise exception 'TEAM_LIMIT_REACHED: на тарифе % максимум % участник(ов) кроме владельца. Занято (участники+приглашения): %',
      coalesce(owner_plan,'pro'), member_seats, used;
  end if;
  return NEW;
end $$;

create trigger enforce_team_limit_members before insert on public.team_members
  for each row execute function public.enforce_team_limit();
create trigger enforce_team_limit_invites before insert on public.team_invites
  for each row when (NEW.status = 'pending') execute function public.enforce_team_limit();

-- ===== RPC приёма инвайта (одна транзакция; КАТЧ 1 порядок, КАТЧ 4 idempotent, R6 expiry) =====
create or replace function public.accept_team_invite(p_token uuid, p_user_id uuid, p_user_email text)
  returns jsonb language plpgsql security definer set search_path to 'public','pg_temp'
as $$
declare
  inv     public.team_invites%rowtype;
  already boolean;
begin
  select * into inv from team_invites where token = p_token and status = 'pending' for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'INVITE_INVALID'); end if;

  if now() >= inv.expires_at then
    update team_invites set status='expired' where id = inv.id;
    return jsonb_build_object('ok', false, 'error', 'INVITE_EXPIRED');
  end if;
  if lower(inv.email) <> lower(p_user_email) then
    return jsonb_build_object('ok', false, 'error', 'EMAIL_MISMATCH');
  end if;
  if inv.owner_id = p_user_id then
    return jsonb_build_object('ok', false, 'error', 'CANNOT_INVITE_SELF');
  end if;

  -- КАТЧ 1: сначала выводим инвайт из pending, потом вставляем участника (триггер не считает дважды)
  update team_invites set status='accepted', accepted_at=now(), accepted_by=p_user_id where id = inv.id;

  -- КАТЧ 4: уже участник → мягко подтверждаем
  select exists(select 1 from team_members where owner_id=inv.owner_id and member_id=p_user_id) into already;
  if already then
    return jsonb_build_object('ok', true, 'owner_id', inv.owner_id, 'already_member', true);
  end if;

  insert into team_members(owner_id, member_id, role) values (inv.owner_id, p_user_id, 'viewer');
  return jsonb_build_object('ok', true, 'owner_id', inv.owner_id, 'already_member', false);
exception
  when others then
    -- лимит/прочее → откат всей транзакции (invite остаётся pending), код наверх
    return jsonb_build_object('ok', false, 'error', SQLERRM);
end $$;

-- ВАЖНО: revoke ТОЛЬКО from public недостаточно — Supabase default privileges выдают
-- execute ролям anon/authenticated на новые функции в public. Отзываем явно у них тоже,
-- иначе SECURITY DEFINER RPC (доверяет p_user_id/p_user_email) дёргается напрямую в обход JWT.
revoke all on function public.accept_team_invite(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.accept_team_invite(uuid,uuid,text) to service_role;

-- ===== Правка delete_user_account (152-ФЗ каскад команды) =====
create or replace function public.delete_user_account(target_user_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  result jsonb := '{}'::jsonb;
  cnt int;
BEGIN
  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'target_user_id is required';
  END IF;

  DELETE FROM public.unit_calc_history WHERE user_id = target_user_id;
  GET DIAGNOSTICS cnt = ROW_COUNT;  result := result || jsonb_build_object('unit_calc_history', cnt);

  DELETE FROM public.daily_snapshots WHERE user_id = target_user_id;
  GET DIAGNOSTICS cnt = ROW_COUNT;  result := result || jsonb_build_object('daily_snapshots', cnt);

  DELETE FROM public.user_costs WHERE user_id = target_user_id;
  GET DIAGNOSTICS cnt = ROW_COUNT;  result := result || jsonb_build_object('user_costs', cnt);

  DELETE FROM public.product_costs WHERE user_id = target_user_id;
  GET DIAGNOSTICS cnt = ROW_COUNT;  result := result || jsonb_build_object('product_costs', cnt);

  DELETE FROM public.promo_uses WHERE user_id = target_user_id;
  GET DIAGNOSTICS cnt = ROW_COUNT;  result := result || jsonb_build_object('promo_uses', cnt);

  DELETE FROM public.ext_products WHERE user_id = target_user_id;
  GET DIAGNOSTICS cnt = ROW_COUNT;  result := result || jsonb_build_object('ext_products', cnt);

  DELETE FROM public.ext_activations WHERE user_id = target_user_id;
  GET DIAGNOSTICS cnt = ROW_COUNT;  result := result || jsonb_build_object('ext_activations', cnt);

  -- Фаза D: командные связи (и как владелец, и как участник, и как принявший инвайт)
  DELETE FROM public.team_invites WHERE owner_id = target_user_id OR accepted_by = target_user_id;
  GET DIAGNOSTICS cnt = ROW_COUNT;  result := result || jsonb_build_object('team_invites', cnt);

  DELETE FROM public.team_members WHERE owner_id = target_user_id OR member_id = target_user_id;
  GET DIAGNOSTICS cnt = ROW_COUNT;  result := result || jsonb_build_object('team_members', cnt);

  DELETE FROM public.profiles WHERE id = target_user_id;
  GET DIAGNOSTICS cnt = ROW_COUNT;  result := result || jsonb_build_object('profiles', cnt);

  RETURN result;
END;
$function$;
