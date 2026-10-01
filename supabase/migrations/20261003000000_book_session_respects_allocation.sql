-- 20261003000000_book_session_respects_allocation.sql
--
-- Closes the gap between the two independent systems that can place a
-- participant into a session: self-service booking (session_bookings,
-- this file's book_session()) and admin-run allocation
-- (allocation_assignments). Until now, neither system was aware of the
-- other's occupancy of a session -- a participant could be allocated to a
-- mandatory session by the algorithm, then separately self-book a
-- time-conflicting elective session, with neither system's capacity
-- counter reflecting the other's rows. This is a one-directional fix:
-- book_session() now respects existing CONFIRMED allocation assignments.
-- The allocation algorithm itself (src/lib/allocation/run-allocation.ts)
-- is unchanged and stays blind to session_bookings -- see
-- docs/superpowers/specs/2026-10-01-booking-allocation-conflict-design.md
-- for the full scope decision and rationale.

-- ---------------------------------------------------------------------------
-- 1. Combined occupancy count: session_bookings (active) + allocation_assignments (confirmed)
-- ---------------------------------------------------------------------------

create function session_effective_occupied_count(p_session_id uuid) returns int
language sql stable as $$
  select
    (select count(*)::int from session_bookings where session_id = p_session_id and status = 'active')
    +
    (select count(*)::int from allocation_assignments where session_id = p_session_id and status = 'confirmed');
$$;

-- ---------------------------------------------------------------------------
-- 2. Aggregate-only confirmed-allocation counts per session, for the
--    participant-facing browse page (which has no RLS access to
--    allocation_assignments directly -- staff-only is_staff() policy).
--    Returns counts only, never individual assignment/participant data.
-- ---------------------------------------------------------------------------

create function session_allocation_confirmed_counts() returns table(session_id uuid, confirmed_count int)
language sql stable security definer set search_path = public, pg_temp as $$
  select session_id, count(*)::int as confirmed_count
  from allocation_assignments
  where status = 'confirmed'
  group by session_id;
$$;

revoke execute on function session_allocation_confirmed_counts() from public;
grant execute on function session_allocation_confirmed_counts() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. book_session(): combined capacity check + new allocation-conflict check.
--    Everything else (authorization, row lock, status check, deadline
--    check, the existing session_bookings-vs-session_bookings conflict
--    check, the final insert) is unchanged from the original definition in
--    20260823020000_session_bookings.sql.
-- ---------------------------------------------------------------------------

create or replace function book_session(
  p_application_id uuid,
  p_session_id     uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_session       sessions%rowtype;
  v_booking_id    uuid;
  v_count         int;
  v_deadline      timestamptz;
begin
  -- Caller must own this application
  if not exists (
    select 1 from applications
    where id = p_application_id and applicant_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  -- Lock the session row to prevent race on capacity
  select * into v_session from sessions where id = p_session_id for update;
  if v_session.id is null then
    raise exception 'Session not found';
  end if;
  if v_session.status not in ('published', 'confirmed') then
    raise exception 'Session is not open for booking';
  end if;

  v_deadline := coalesce(v_session.booking_deadline, v_session.start_time - interval '3 hours');
  if now() > v_deadline then
    raise exception 'Booking deadline has passed';
  end if;

  -- Capacity check (now combined: session_bookings + confirmed allocation_assignments)
  v_count := session_effective_occupied_count(p_session_id);
  if v_count >= v_session.capacity then
    raise exception 'Session is full';
  end if;

  -- Conflict check: any active booking for this participant that overlaps?
  if exists (
    select 1
    from session_bookings sb
    join sessions s on s.id = sb.session_id
    where sb.application_id = p_application_id
      and sb.status = 'active'
      and tstzrange(s.start_time, s.end_time, '[)') &&
          tstzrange(v_session.start_time, v_session.end_time, '[)')
  ) then
    raise exception 'Time conflict with an existing booking';
  end if;

  -- NEW: conflict check against this participant's confirmed allocation assignments
  if exists (
    select 1
    from allocation_assignments aa
    join sessions s on s.id = aa.session_id
    where aa.application_id = p_application_id
      and aa.status = 'confirmed'
      and tstzrange(s.start_time, s.end_time, '[)') &&
          tstzrange(v_session.start_time, v_session.end_time, '[)')
  ) then
    raise exception 'Time conflict with an assigned session';
  end if;

  insert into session_bookings (application_id, session_id)
  values (p_application_id, p_session_id)
  returning id into v_booking_id;

  return v_booking_id;
end;
$$;

grant execute on function book_session(uuid, uuid) to authenticated;
