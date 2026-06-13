-- R2 hardening: accept_team_invite (SECURITY DEFINER, доверяет p_user_id/p_user_email)
-- должна вызываться ТОЛЬКО под service-role из api. Supabase default privileges выдают
-- execute ролям anon/authenticated на новые функции в public — отзываем явно,
-- иначе authenticated мог бы дёрнуть RPC напрямую с произвольным p_user_id (обход JWT-привязки).
revoke execute on function public.accept_team_invite(uuid,uuid,text) from anon, authenticated;
