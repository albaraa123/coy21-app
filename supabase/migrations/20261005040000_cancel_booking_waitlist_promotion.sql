-- 20261005040000_cancel_booking_waitlist_promotion.sql
--
-- Extends cancel_booking() to promote the next eligible waitlisted
-- participant (FIFO, conflict-aware) when a voluntary cancellation frees
-- a seat on a session whose type has enable_waitlist = true. Does NOT
-- apply to staff-initiated session cancellation (session_cancelled
-- bookings, handled entirely by the 4c trigger) -- when staff cancel a
-- session outright there is nothing left to promote anyone into. See
-- docs/superpowers/specs/2026-10-01-work-group-waitlist-design.md
-- scope decision #5.
--
-- Concurrency note on the promotion cursor's `for update of sw`: without
-- locking each candidate row as the loop reads it, a concurrent
-- leave_waitlist call could withdraw a candidate's waitlist row between
-- this loop's read and its later `update ... where id = v_candidate.id`
-- promoting them -- i.e. someone who just withdrew could still get
-- promoted (their status would flip from 'withdrawn' back to 'promoted',
-- overwriting their own voluntary withdrawal). `for update of sw` closes
-- this gap: if a concurrent leave_waitlist already holds, or is about to
-- acquire, a lock on that specific session_waitlist row, this loop will
-- either wait for it or acquire first (and leave_waitlist will then
-- block until this transaction commits, then correctly find no
-- 'waiting' row to withdraw, matching its own existing "not on
-- waitlist" rejection).
--
-- Per Postgres's row-locking semantics for SELECT ... FOR UPDATE (which
-- a PL/pgSQL FOR loop over a query executes via the same plan, not some
-- different lock-free cursor path): if a row was concurrently updated
-- and committed before this loop's lock request on it was granted, the
-- lock is acquired on, and the *latest committed version* of, that row
-- is returned to the loop body -- not the original pre-update
-- snapshot. That means v_candidate's status, as bound inside the loop
-- body, already reflects post-lock-acquisition state, so a concurrent
-- withdrawal that commits while this loop is waiting on the lock IS
-- visible as status = 'withdrawn' once the lock is finally granted.
-- Hence the explicit re-check immediately below is required (and
-- correct) to skip such a row rather than assume 'waiting' just because
-- it matched the cursor's original where clause.

create or replace function cancel_booking(
  p_booking_id     uuid,
  p_application_id uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_booking         session_bookings%rowtype;
  v_session         sessions%rowtype;
  v_deadline        timestamptz;
  v_enable_waitlist boolean;
  v_candidate       record;
  v_new_booking_id  uuid;
begin
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
  if v_booking.status in ('cancelled', 'session_cancelled') then
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

  -- Waitlist promotion: only for voluntary cancellation (this function),
  -- never for staff-initiated session cancellation (handled by the 4c
  -- trigger, which never calls this function).
  select st.enable_waitlist into v_enable_waitlist
  from session_types st where st.id = v_session.session_type_id;

  if coalesce(v_enable_waitlist, false) then
    <<promotion>>
    for v_candidate in
      select sw.id, sw.application_id, sw.status
      from session_waitlist sw
      where sw.session_id = v_booking.session_id
        and sw.status = 'waiting'
      order by sw.joined_at asc
      for update of sw
    loop
      -- Re-check status after acquiring the lock: a concurrent
      -- leave_waitlist may have withdrawn this exact row while this
      -- loop was waiting to acquire the FOR UPDATE lock on it (see
      -- migration header comment for the full race this closes).
      if v_candidate.status is distinct from 'waiting' then
        continue;
      end if;

      if exists (
        select 1 from session_bookings sb join sessions s on s.id = sb.session_id
        where sb.application_id = v_candidate.application_id and sb.status = 'active'
          and tstzrange(s.start_time, s.end_time, '[)') && tstzrange(v_session.start_time, v_session.end_time, '[)')
      ) or exists (
        select 1 from allocation_assignments aa join sessions s on s.id = aa.session_id
        where aa.application_id = v_candidate.application_id and aa.status = 'confirmed'
          and tstzrange(s.start_time, s.end_time, '[)') && tstzrange(v_session.start_time, v_session.end_time, '[)')
      ) then
        continue;
      end if;

      insert into session_bookings (application_id, session_id)
      values (v_candidate.application_id, v_booking.session_id)
      returning id into v_new_booking_id;

      update session_waitlist
      set status = 'promoted', promoted_at = now()
      where id = v_candidate.id;

      update session_waitlist sw2
      set status = 'withdrawn', withdrawn_at = now()
      from sessions s2
      where sw2.session_id = s2.id
        and sw2.application_id = v_candidate.application_id
        and sw2.status = 'waiting'
        and tstzrange(s2.start_time, s2.end_time, '[)') && tstzrange(v_session.start_time, v_session.end_time, '[)');

      insert into session_notification_outbox (booking_id, application_id, session_id, notification_type)
      values (v_new_booking_id, v_candidate.application_id, v_booking.session_id, 'waitlist_promoted');

      exit promotion;
    end loop;
  end if;
end;
$$;

grant execute on function cancel_booking(uuid, uuid) to authenticated;
