-- 20260930031000_harden_speaker_people_functions.sql
--
-- Code review follow-up on 20260930030000_speaker_classification_people_trigger.sql:
-- resolve_application_display_name() was missing set search_path (only the
-- trigger function had it), and neither new function had its default PUBLIC
-- EXECUTE grant revoked, unlike this feature's own cited model migration
-- (20260815000000_revoke_qr_credential_on_ineligibility.sql), which does
-- both for its SECURITY DEFINER trigger function. Applying the same
-- hardening here for consistency and defense-in-depth: resolve_application_
-- display_name is only ever called from within
-- create_speaker_people_record_if_needed()'s already-pinned SECURITY
-- DEFINER context today, but pinning it independently means it stays safe
-- if a future caller ever invokes it directly.
create or replace function resolve_application_display_name(p_applicant_id uuid, p_application_full_name text)
returns text language sql stable
set search_path = public, pg_temp
as $$
  select coalesce(
    p_application_full_name,
    (select full_name from profiles where id = p_applicant_id),
    'Unknown'
  );
$$;

revoke all on function resolve_application_display_name(uuid, text) from public;
revoke all on function create_speaker_people_record_if_needed() from public;
