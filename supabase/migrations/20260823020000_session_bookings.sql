-- 20260823020000_session_bookings.sql
--
-- COY21 Phase 2: self-service session booking.
--
-- Design decisions (confirmed):
--   • Deadline default: start_time - 3 hours (per-session override via booking_deadline column).
--   • Self-cancel: allowed before the deadline; blocked after.
--   • Conflict prevention: EXCLUDE USING GIST on application_id + time overlap.
--   • Capacity: enforced via a CHECK against a live count (function), not a counter column,
--     to avoid race conditions. A partial unique index makes the active-booking uniqueness
--     constraint cheap.

-- ---------------------------------------------------------------------------
-- 1. booking_deadline column on sessions
--    NULL = use default (start_time - interval '3 hours')
-- ---------------------------------------------------------------------------

alter table sessions
  add column booking_deadline timestamptz;

comment on column sessions.booking_deadline is
  'When self-service booking closes for this session. NULL = start_time - 3 hours.';

-- Helper: effective deadline for a session (used in RLS and application logic)
create function session_effective_deadline(p_session sessions) returns timestamptz
language sql stable as $$
  select coalesce(p_session.booking_deadline, p_session.start_time - interval '3 hours');
$$;

-- ---------------------------------------------------------------------------
-- 2. session_bookings table
-- ---------------------------------------------------------------------------

create type booking_status as enum ('active', 'cancelled');

create table session_bookings (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  session_id     uuid not null references sessions(id) on delete cascade,
  status         booking_status not null default 'active',
  booked_at      timestamptz not null default now(),
  cancelled_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger session_bookings_set_updated_at
  before update on session_bookings
  for each row execute function extensions.moddatetime('updated_at');

-- One active booking per (participant, session)
create unique index session_bookings_active_unique
  on session_bookings (application_id, session_id)
  where status = 'active';

-- Fast lookups
create index session_bookings_application_idx on session_bookings (application_id);
create index session_bookings_session_idx     on session_bookings (session_id, status);

-- ---------------------------------------------------------------------------
-- 3. Time-conflict prevention
--    Enforced inside book_session() RPC via an explicit EXISTS check (see §5).
--    A DB-level EXCLUDE USING GIST is not practical here because PostgreSQL
--    does not allow subqueries in EXCLUDE predicates — the RPC lock + check
--    is the correct pattern for this case.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. Capacity enforcement function
--    Called inside book_session RPC to check before INSERT.
-- ---------------------------------------------------------------------------

create function session_active_booking_count(p_session_id uuid) returns int
language sql stable as $$
  select count(*)::int from session_bookings
  where session_id = p_session_id and status = 'active';
$$;

-- ---------------------------------------------------------------------------
-- 5. book_session(p_application_id, p_session_id) RPC
--    SECURITY DEFINER so it can bypass RLS for the atomic read-then-insert.
--    Authorization enforced explicitly inside the function body.
-- ---------------------------------------------------------------------------

create function book_session(
  p_application_id uuid,
  p_session_id     uuid
) returns uuid   -- returns new booking id
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

  -- Capacity check
  v_count := session_active_booking_count(p_session_id);
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

  insert into session_bookings (application_id, session_id)
  values (p_application_id, p_session_id)
  returning id into v_booking_id;

  return v_booking_id;
end;
$$;

grant execute on function book_session(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. cancel_booking(p_booking_id, p_application_id) RPC
-- ---------------------------------------------------------------------------

create function cancel_booking(
  p_booking_id     uuid,
  p_application_id uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_booking  session_bookings%rowtype;
  v_session  sessions%rowtype;
  v_deadline timestamptz;
begin
  -- Caller must own this application
  if not exists (
    select 1 from applications
    where id = p_application_id and applicant_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  select * into v_booking from session_bookings
  where id = p_booking_id and application_id = p_application_id
  for update;

  if v_booking.id is null then
    raise exception 'Booking not found';
  end if;
  if v_booking.status = 'cancelled' then
    raise exception 'Booking is already cancelled';
  end if;

  select * into v_session from sessions where id = v_booking.session_id;
  v_deadline := coalesce(v_session.booking_deadline, v_session.start_time - interval '3 hours');

  if now() > v_deadline then
    raise exception 'Cannot cancel after the booking deadline';
  end if;

  update session_bookings
  set status = 'cancelled', cancelled_at = now()
  where id = p_booking_id;
end;
$$;

grant execute on function cancel_booking(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. RLS on session_bookings
-- ---------------------------------------------------------------------------

alter table session_bookings enable row level security;

-- Participants read their own bookings
create policy session_bookings_select_own on session_bookings
  for select using (
    application_id in (
      select id from applications where applicant_id = auth.uid()
    )
  );

-- Staff reads all
create policy session_bookings_select_staff on session_bookings
  for select using (
    current_user_role() in ('registration_admission_manager', 'super_admin')
  );

-- No direct INSERT/UPDATE/DELETE from clients — must go through RPCs above.
-- (service_role bypasses RLS and can always write.)

-- ---------------------------------------------------------------------------
-- 8. Sessions: participants can SELECT published/confirmed sessions
-- ---------------------------------------------------------------------------

create policy sessions_select_published on sessions
  for select using (status in ('published', 'confirmed', 'completed'));
