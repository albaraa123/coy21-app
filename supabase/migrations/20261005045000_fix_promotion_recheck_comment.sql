-- 20261005045000_fix_promotion_recheck_comment.sql
--
-- Comment-only correction found during code review of 20261005040000 --
-- no behavioral change, the SQL body is identical to the prior
-- definition.
--
-- The previous header comment claimed the explicit
-- "if v_candidate.status is distinct from 'waiting' then continue"
-- check was *required* to close the leave_waitlist race, implying
-- Postgres's FOR UPDATE alone was insufficient. That overstates the
-- gap: per EvalPlanQual semantics, when a FOR UPDATE cursor's lock
-- request on a row is granted after a wait, Postgres re-evaluates that
-- query's own WHERE clause against the row's latest committed version
-- before returning it to the loop -- a row that no longer satisfies
-- status = 'waiting' is silently excluded from the result set
-- entirely, not handed to the loop body with stale data. So the cursor
-- itself already excludes a row a concurrent leave_waitlist withdrew
-- before this loop's lock on it was granted; the loop body should never
-- actually observe v_candidate.status <> 'waiting' for a row this
-- specific query shape produces. The explicit re-check is correct and
-- worth keeping as defense-in-depth against relying on
-- not-SQL-level-documented EPQ behavior staying stable across a future
-- Postgres version or planner change -- it just isn't closing a
-- distinct gap EPQ leaves open today.

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
      -- Defense-in-depth, not closing a distinct gap: see this
      -- migration's header comment for why FOR UPDATE's own
      -- EvalPlanQual re-check already excludes a row a concurrent
      -- leave_waitlist withdrew before this loop's lock on it was
      -- granted.
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
