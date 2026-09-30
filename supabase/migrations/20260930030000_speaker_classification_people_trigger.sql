-- 20260930030000_speaker_classification_people_trigger.sql
--
-- Closes gap 3 from docs/superpowers/specs/2026-09-30-import-classification-approval-design.md:
-- links participant_type = 'speaker' applications to the people/
-- session_people speaker system, which was previously entirely
-- disconnected from applications.
--
-- resolve_application_display_name: shared name-fallback used by both the
-- trigger below and this same migration's one-time backfill statement.
-- applications.full_name is nullable and only populated by import/manual
-- edit (20260731100000_phase_b_import_field_extensions.sql) — a claimed
-- application whose full_name was never backfilled still has a real name
-- on profiles.full_name (via applicant_id), so that's the second fallback
-- before the final literal placeholder.
create function resolve_application_display_name(p_applicant_id uuid, p_application_full_name text)
returns text language sql stable as $$
  select coalesce(
    p_application_full_name,
    (select full_name from profiles where id = p_applicant_id),
    'Unknown'
  );
$$;

-- Shared by the AFTER INSERT and AFTER UPDATE triggers below — the
-- "does this application need a linked people row" logic lives here once,
-- not duplicated per trigger. Idempotent: the not-exists guard means a
-- row that already has a linked people record is never touched again,
-- even if this fires multiple times for the same application (e.g. an
-- UPDATE that doesn't actually change participant_type still fires the
-- trigger — the participant_type-changed guard inside this function is
-- what makes re-fires a no-op, not the not-exists check alone).
create function create_speaker_people_record_if_needed()
returns trigger security definer set search_path = public, pg_temp as $$
begin
  if new.participant_type = 'speaker'
     and (TG_OP = 'INSERT' or old.participant_type is distinct from 'speaker')
     and not exists (select 1 from people where linked_application_id = new.id)
  then
    insert into people (full_name_ar, full_name_en, linked_application_id, is_active, is_public)
    values (
      resolve_application_display_name(new.applicant_id, new.full_name),
      resolve_application_display_name(new.applicant_id, new.full_name),
      new.id, true, false
    );
  end if;
  return new;
end;
$$ language plpgsql;

create trigger applications_create_speaker_people_on_insert
  after insert on applications
  for each row
  execute function create_speaker_people_record_if_needed();

create trigger applications_create_speaker_people_on_update
  after update on applications
  for each row
  execute function create_speaker_people_record_if_needed();

-- One-time retroactive backfill: links every pre-existing speaker
-- application that predates this migration (and therefore never fired
-- either trigger above) to a newly-created people row. Idempotent by
-- construction (the not-exists guard matches the trigger's), safe to
-- leave in migration history permanently.
insert into people (full_name_ar, full_name_en, linked_application_id, is_active, is_public)
select
  resolve_application_display_name(a.applicant_id, a.full_name),
  resolve_application_display_name(a.applicant_id, a.full_name),
  a.id, true, false
from applications a
where a.participant_type = 'speaker'
  and not exists (select 1 from people pe where pe.linked_application_id = a.id);
