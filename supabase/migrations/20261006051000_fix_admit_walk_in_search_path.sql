-- 20261006051000_fix_admit_walk_in_search_path.sql
--
-- Corrective fix discovered while writing this task's own live tests (not
-- a pre-existing, already-reviewed bug): admit_walk_in
-- (20261006050000_walk_in_admission.sql) was created with
-- `set search_path = public, pg_temp`, matching the hardened-search_path
-- convention used elsewhere in this codebase (e.g.
-- compute_publication_fingerprint's comment in
-- 20260723190000_schedule_publication_functions.sql). But admit_walk_in
-- calls compute_time_slot_group_key_for_session(), which itself calls
-- pgcrypto's digest() UNQUALIFIED and declares no search_path of its own
-- (20260814100000_scan_qr_attempt_transactional.sql) -- it inherits
-- whatever search_path its caller is running under. Every existing caller
-- of compute_time_slot_group_key_for_session (scan_qr_attempt_transactional)
-- also declares no explicit search_path, so it runs under Postgres's
-- session/role default, which already includes `extensions` (pgcrypto's
-- install schema on Supabase) -- that's why this gap was never hit until
-- admit_walk_in, the first caller to run under an explicitly hardened
-- search_path. Live test run failed with "function digest(text, unknown)
-- does not exist" (SQLSTATE 42883) before this fix.
--
-- Fixed by adding `extensions` to admit_walk_in's own search_path, rather
-- than widening compute_time_slot_group_key_for_session's search_path or
-- schema-qualifying its digest() call -- that function is shared, already
-- tested (tests/attendance/time-slot-group-key-parity.test.ts), and out of
-- this task's scope.
--
-- Signature is unchanged (uuid, uuid), so `create or replace function`
-- preserves the existing `grant execute ... to authenticated` from
-- 20261006050000 -- no grant needs restating.
--
-- Generalized lesson for future SECURITY DEFINER functions: any helper
-- that calls an extension function (digest(), gen_random_uuid(), etc.)
-- UNQUALIFIED and declares no search_path of its own will silently break
-- the first caller that sets an explicit, hardened search_path omitting
-- that extension's install schema -- check every transitive helper call
-- before hardening a new function's search_path, not just its own body.

create or replace function admit_walk_in(
  p_application_id uuid,
  p_session_id     uuid
) returns uuid
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_session      sessions%rowtype;
  v_admitted     int;
  v_booking_id   uuid;
begin
  if not is_staff() then
    raise exception 'Not authorized';
  end if;

  if not exists (select 1 from applications where id = p_application_id and status = 'accepted') then
    raise exception 'Application not found or not accepted';
  end if;

  select * into v_session from sessions where id = p_session_id for update;
  if v_session.id is null then
    raise exception 'Session not found';
  end if;
  if v_session.status <> 'confirmed' then
    raise exception 'Session is not open for admission';
  end if;

  select count(*) into v_admitted
  from attendance_records where session_id = p_session_id and status = 'admitted';
  if v_admitted >= v_session.capacity then
    raise exception 'Session is at capacity';
  end if;

  if exists (
    select 1 from session_bookings
    where application_id = p_application_id and session_id = p_session_id and status = 'active'
  ) then
    raise exception 'This participant already has a booking for this session';
  end if;

  if exists (
    select 1 from attendance_records
    where application_id = p_application_id and session_id = p_session_id and status = 'admitted'
  ) then
    raise exception 'This participant has already been admitted to this session';
  end if;

  insert into session_bookings (application_id, session_id, source)
  values (p_application_id, p_session_id, 'walk_in')
  returning id into v_booking_id;

  begin
    insert into attendance_records (application_id, session_id, time_slot_group_key, entry_type, scanned_by, booking_id)
    values (p_application_id, p_session_id, compute_time_slot_group_key_for_session(p_session_id), 'walk_in', auth.uid(), v_booking_id);
  exception when unique_violation then
    raise exception 'This participant has already been admitted to this session';
  end;

  return v_booking_id;
end;
$$;
