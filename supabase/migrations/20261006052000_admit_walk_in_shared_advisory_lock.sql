-- 20261006052000_admit_walk_in_shared_advisory_lock.sql
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

  -- Same session-scoped advisory lock scan_attempt_transactional holds
  -- for its own admitted-count check -- both admission paths must
  -- serialize against each other, not just against themselves, since
  -- they guard the same attendance_records-based capacity invariant.
  perform pg_advisory_xact_lock(hashtext(p_session_id::text));

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
