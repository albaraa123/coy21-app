-- 20261006120000_admit_walk_in_idempotency.sql
--
-- Task 2 of docs/superpowers/plans/2026-10-06-offline-scanning-support.md:
-- adds an idempotency key to admit_walk_in (the walk-in/staff-admission
-- path), mirroring the idempotency-key mechanism Task 1 added to
-- scan_attempt_transactional / scan_qr_attempt_transactional
-- (20261006110000_scan_attempts_idempotency.sql), and fixes two unrelated
-- but genuine gaps this signature change surfaces: the is_staff() NULL-bypass
-- (coalesce to false) and a missing explicit `anon` revoke.
alter table session_bookings add column idempotency_key uuid;
create unique index session_bookings_idempotency_key_unique on session_bookings (idempotency_key) where idempotency_key is not null;

drop function if exists admit_walk_in(uuid, uuid);

-- 20261006052000_admit_walk_in_shared_advisory_lock.sql
--
-- (Unchanged from that migration -- reproduced here only because
-- `create or replace function` requires the full body, not a diff. The
-- advisory-lock fix below is NOT new in this commit.)
--
-- Code-quality review of Task 6 (walk-in admission) found a genuine race:
-- admit_walk_in serialized against OTHER admit_walk_in/book_session/
-- join_waitlist calls via `select ... for update` on sessions, but
-- scan_attempt_transactional (the normal QR-scan admission path) never
-- takes that lock -- it only reads sessions plainly and instead guards
-- its own attendance_records-based capacity check with a SEPARATE
-- session-scoped advisory lock: pg_try_advisory_xact_lock(hashtext(
-- p_session_id::text)) (20260804160000_scan_attempt_transactional_function.sql,
-- unchanged since). admit_walk_in's capacity check also counts
-- attendance_records (not session_bookings/allocation_assignments --
-- see the comment added below), which is exactly the same invariant
-- scan_attempt_transactional's advisory lock protects. Two different,
-- non-overlapping locking mechanisms guarding the same invariant means a
-- concurrent admit_walk_in + scan_attempt_transactional call for the same
-- session could interleave their admitted-count reads and both insert,
-- overshooting capacity by one -- worse than the "at least as safe as
-- book_session" bar, since book_session/join_waitlist only ever race
-- against each other under the SAME lock.
--
-- Fix: admit_walk_in now takes the identical advisory lock
-- scan_attempt_transactional uses, around its capacity check through its
-- attendance_records insert, so both admission paths serialize against
-- each other for the same session. Uses the blocking
-- pg_advisory_xact_lock (not the try+retry-loop variant
-- scan_attempt_transactional uses) since admit_walk_in has no caller-
-- facing retry budget to preserve -- a staff admission can simply wait
-- for a concurrent scan to finish; the lock is released automatically at
-- transaction end either way.
create or replace function admit_walk_in(
  p_application_id   uuid,
  p_session_id       uuid,
  p_idempotency_key  uuid default null
) returns uuid
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_session      sessions%rowtype;
  v_admitted     int;
  v_booking_id   uuid;
  v_existing     session_bookings%rowtype;
  v_constraint   text;
begin
  if not coalesce(is_staff(), false) then
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

  -- Same session-scoped advisory lock scan_attempt_transactional holds
  -- for its own admitted-count check -- both admission paths must
  -- serialize against each other, not just against themselves, since
  -- they guard the same attendance_records-based capacity invariant.
  perform pg_advisory_xact_lock(hashtext(p_session_id::text));

  -- This check must run before the "already has a booking" / "already
  -- admitted" / capacity checks below -- a retried call with a previously-
  -- committed key has to replay here and return early, never reaching
  -- those checks, or a retry would be rejected as a duplicate instead of
  -- returning the original successful result. Do not hoist any of the
  -- checks below this point above this block.
  if p_idempotency_key is not null then
    select * into v_existing from session_bookings where idempotency_key = p_idempotency_key;
    if v_existing.id is not null then
      if v_existing.application_id = p_application_id and v_existing.session_id = p_session_id then
        return v_existing.id;
      else
        raise exception 'Idempotency key reused with different admission data';
      end if;
    end if;
  end if;

  -- Deliberately counts live attendance_records admissions, not
  -- session_effective_occupied_count() (active session_bookings +
  -- confirmed allocation_assignments, which book_session/join_waitlist/
  -- the capacity-downsize trigger use) -- a walk-in competes for
  -- physical capacity at the door, not for a pre-reserved booking slot.
  -- See the design spec's Walk-In Admission section for the full
  -- rationale; this is intentional, not an inconsistency to "fix" into
  -- matching book_session's occupancy definition.
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

  -- Each begin...exception block below scopes to its own single insert --
  -- PL/pgSQL exception handling is statement-block-local, so a
  -- unique_violation on the session_bookings insert can only be caught by
  -- this block, never by the attendance_records block further down (and
  -- vice versa). No cross-contamination between the two is possible.
  begin
    insert into session_bookings (application_id, session_id, source, idempotency_key)
    values (p_application_id, p_session_id, 'walk_in', p_idempotency_key)
    returning id into v_booking_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'session_bookings_active_unique' then
      raise exception 'This participant already has a booking for this session';
    elsif v_constraint = 'session_bookings_idempotency_key_unique' then
      select * into v_existing from session_bookings where idempotency_key = p_idempotency_key;
      if v_existing.application_id = p_application_id and v_existing.session_id = p_session_id then
        return v_existing.id;
      else
        raise exception 'Idempotency key reused with different admission data';
      end if;
    else
      raise;
    end if;
  end;

  -- Unlike the block above, this one does not branch on constraint_name --
  -- attendance_records_no_duplicate_active (application_id, session_id,
  -- where status = 'admitted') is the table's only unique constraint today
  -- (supabase/migrations/20260804120000_create_attendance_records_table.sql),
  -- so any unique_violation here is unambiguously a duplicate admission. If
  -- a future migration adds another unique constraint to attendance_records,
  -- add the same get stacked diagnostics / constraint_name dispatch used
  -- above before trusting this bare message again.
  begin
    insert into attendance_records (application_id, session_id, time_slot_group_key, entry_type, scanned_by, booking_id)
    values (p_application_id, p_session_id, compute_time_slot_group_key_for_session(p_session_id), 'walk_in', auth.uid(), v_booking_id);
  exception when unique_violation then
    raise exception 'This participant has already been admitted to this session';
  end;

  return v_booking_id;
end;
$$;

grant execute on function admit_walk_in(uuid, uuid, uuid) to authenticated;
revoke execute on function admit_walk_in(uuid, uuid, uuid) from public, anon;

-- service_role retains EXECUTE here via this project's blanket
-- `alter default privileges ... grant execute on functions to service_role`
-- (20261006080000_fix_missing_service_role_grants.sql) and the broader
-- catch-all grant (20261006100000_fix_remaining_service_role_grants.sql),
-- which this migration does not revoke. That's intentional: service_role
-- calls are trusted, server-side-only, and bypass is_staff() by design
-- (same as every other function in this project that service_role can
-- reach) -- not an oversight to close.
