-- Фаза D (оператор кабинета): расширяем CHECK audit_log.event_type на 2 командных события.
-- Сохраняем все 13 существующих типов + добавляем 'team_data_pull', 'team_cost_edit'.
-- Без этого audit() для новых событий тихо не пишет (insert падает на CHECK).
alter table public.audit_log drop constraint if exists audit_log_event_type_chk;
alter table public.audit_log add constraint audit_log_event_type_chk
  check (event_type = any (array[
    'account_created',
    'account_deleted',
    'promo_activated',
    'promo_failed',
    'promo_created_by_admin',
    'promo_deactivated_by_admin',
    'promo_updated_by_admin',
    'promo_deleted_by_admin',
    'token_saved',
    'plan_changed',
    'data_exported',
    'feedback_updated_by_admin',
    'feedback_deleted_by_admin',
    'team_data_pull',
    'team_cost_edit'
  ]));
