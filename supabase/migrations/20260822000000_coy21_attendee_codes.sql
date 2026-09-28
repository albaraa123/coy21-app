-- 20260822000000_coy21_attendee_codes.sql
--
-- Phase 1 (COY21 Task 1): attendee code infrastructure per BUILD_SPEC.md §10.
--
-- Introduces the COY21-[TYPE]-[SEQ] code format (e.g. COY21-DEL-0001) to
-- replace the RCOY-2026-NNNNN format used in the pilot. Adds:
--   • participant_type enum (delegate/volunteer/knowledge_partner/youngo/speaker)
--   • participant_type column on applications and import_rows
--   • Five independent per-type sequences (one per type, no shared counter)
--   • New next_application_number(p_type participant_type DEFAULT NULL) that
--     replaces the old no-arg version — existing callers that pass no argument
--     receive the delegate-type fallback code (preserves call-site compat while
--     the import function is updated separately in the next migration).
--
-- Security notes (unchanged from the original next_application_number):
--   • NOT security definer — runs as calling role.
--   • No explicit search_path — only references schema-qualified sequences.
--   • Sequences granted to authenticated and service_role (mirrors original
--     20260816110000_correct_application_number_seq_usage_grant.sql grant).

-- ---------------------------------------------------------------------------
-- 1.  participant_type enum
-- ---------------------------------------------------------------------------

create type public.participant_type as enum (
  'delegate',
  'volunteer',
  'knowledge_partner',
  'youngo',
  'speaker'
);

-- ---------------------------------------------------------------------------
-- 2.  participant_type column on applications and import_rows
-- ---------------------------------------------------------------------------

alter table public.applications
  add column participant_type public.participant_type;

alter table public.import_rows
  add column participant_type public.participant_type;

-- ---------------------------------------------------------------------------
-- 3.  Per-type sequences (independent counters, start at 1)
-- ---------------------------------------------------------------------------

create sequence public.attendee_code_seq_del start 1;
create sequence public.attendee_code_seq_vol start 1;
create sequence public.attendee_code_seq_kp  start 1;
create sequence public.attendee_code_seq_yng start 1;
create sequence public.attendee_code_seq_spk start 1;

-- ---------------------------------------------------------------------------
-- 4.  Replace next_application_number()
--
--     Drop the old no-arg function first; PostgreSQL cannot CREATE OR REPLACE
--     a function with a different signature. The call signature
--     next_application_number() (no args) continues to resolve here because
--     p_type has a DEFAULT — PostgreSQL matches a no-arg call to a function
--     whose only parameter has a default value.
-- ---------------------------------------------------------------------------

drop function if exists public.next_application_number();

create function public.next_application_number(
  p_type public.participant_type default null
)
returns text
language sql
as $$
  select case p_type
    when 'delegate'          then 'COY21-DEL-' || lpad(nextval('public.attendee_code_seq_del')::text, 4, '0')
    when 'volunteer'         then 'COY21-VOL-' || lpad(nextval('public.attendee_code_seq_vol')::text, 4, '0')
    when 'knowledge_partner' then 'COY21-KP-'  || lpad(nextval('public.attendee_code_seq_kp')::text,  4, '0')
    when 'youngo'            then 'COY21-YNG-' || lpad(nextval('public.attendee_code_seq_yng')::text, 4, '0')
    when 'speaker'           then 'COY21-SPK-' || lpad(nextval('public.attendee_code_seq_spk')::text, 4, '0')
    -- fallback when caller passes no type (legacy no-arg path during
    -- transition period before apply_import_row_transactional is updated)
    else                          'COY21-DEL-' || lpad(nextval('public.attendee_code_seq_del')::text, 4, '0')
  end;
$$;

-- ---------------------------------------------------------------------------
-- 5.  Grants — mirrors 20260816110000_correct_application_number_seq_usage_grant
-- ---------------------------------------------------------------------------

grant execute on function public.next_application_number(public.participant_type)
  to authenticated, service_role;

grant usage on sequence public.attendee_code_seq_del to authenticated, service_role;
grant usage on sequence public.attendee_code_seq_vol to authenticated, service_role;
grant usage on sequence public.attendee_code_seq_kp  to authenticated, service_role;
grant usage on sequence public.attendee_code_seq_yng to authenticated, service_role;
grant usage on sequence public.attendee_code_seq_spk to authenticated, service_role;
