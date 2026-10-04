-- 20261006010000_consolidate_session_effective_deadline.sql
--
-- Replaces the dead-code session_effective_deadline() (defined in 4a's
-- migration, never actually called) with a real implementation, and
-- updates book_session/join_waitlist/cancel_booking (their current
-- authoritative bodies, unchanged except this one line each) to call it
-- instead of their own duplicated inline coalesce(...) expression. See
-- docs/superpowers/specs/2026-10-04-booking-rules-completion-design.md
-- scope decision 4.

create or replace function session_effective_deadline(p_session sessions) returns timestamptz
language sql stable as $$
  select least(
    coalesce((select global_booking_deadline from conference_settings), 'infinity'::timestamptz),
    coalesce(p_session.booking_deadline, p_session.start_time - interval '3 hours')
  );
$$;

-- book_session: full current authoritative body from
-- 20261003000000_book_session_respects_allocation.sql, with its single
-- `v_deadline := coalesce(...)` line (that file's line 83) replaced by a
-- call to session_effective_deadline. Every other line is unchanged.
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
  if not exists (
    select 1 from applications
    where id = p_application_id and applicant_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  select * into v_session from sessions where id = p_session_id for update;
  if v_session.id is null then
    raise exception 'Session not found';
  end if;
  if v_session.status not in ('published', 'confirmed') then
    raise exception 'Session is not open for booking';
  end if;

  v_deadline := session_effective_deadline(v_session);
  if now() > v_deadline then
    raise exception 'Booking deadline has passed';
  end if;

  v_count := session_effective_occupied_count(p_session_id);
  if v_count >= v_session.capacity then
    raise exception 'Session is full';
  end if;

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

-- join_waitlist: full current authoritative body from
-- 20261005035000_join_waitlist_unique_violation_handling.sql, with its
-- single `v_deadline := coalesce(...)` line (that file's line 55)
-- replaced the same way. Every other line (including the
-- unique_violation handler) is unchanged.
create or replace function join_waitlist(
  p_application_id uuid,
  p_session_id     uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_session        sessions%rowtype;
  v_enable_waitlist boolean;
  v_count          int;
  v_deadline       timestamptz;
  v_waitlist_id    uuid;
begin
  if not exists (
    select 1 from applications
    where id = p_application_id and applicant_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  select * into v_session from sessions where id = p_session_id for update;
  if v_session.id is null then
    raise exception 'Session not found';
  end if;
  if v_session.status not in ('published', 'confirmed') then
    raise exception 'Session is not open for booking';
  end if;

  select st.enable_waitlist into v_enable_waitlist
  from session_types st where st.id = v_session.session_type_id;
  if not coalesce(v_enable_waitlist, false) then
    raise exception 'This session does not support a waitlist';
  end if;

  v_deadline := session_effective_deadline(v_session);
  if now() > v_deadline then
    raise exception 'Booking deadline has passed';
  end if;

  v_count := session_effective_occupied_count(p_session_id);
  if v_count < v_session.capacity then
    raise exception 'Session is not full -- book it directly instead of joining the waitlist';
  end if;

  if exists (
    select 1 from session_bookings
    where application_id = p_application_id and session_id = p_session_id and status = 'active'
  ) then
    raise exception 'You already have a booking for this session';
  end if;

  if exists (
    select 1 from session_waitlist
    where application_id = p_application_id and session_id = p_session_id and status = 'waiting'
  ) then
    raise exception 'You are already on the waitlist for this session';
  end if;

  begin
    insert into session_waitlist (application_id, session_id)
    values (p_application_id, p_session_id)
    returning id into v_waitlist_id;
  exception when unique_violation then
    raise exception 'You are already on the waitlist for this session';
  end;

  return v_waitlist_id;
end;
$$;

grant execute on function join_waitlist(uuid, uuid) to authenticated;

-- cancel_booking: full current authoritative body from
-- 20261005045000_fix_promotion_recheck_comment.sql, with its single
-- `v_deadline := coalesce(...)` line (that file's line 58) replaced the
-- same way. Every other line (including the full promotion loop) is
-- unchanged here -- Task 4 replaces this same function again to extract
-- the promotion loop into a shared helper; this task's edit is scoped
-- to the deadline line only, so the two tasks' diffs don't fight each
-- other when applied in order.
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
  v_deadline := session_effective_deadline(v_session);

  if now() > v_deadline then
    raise exception 'Cannot cancel after the booking deadline';
  end if;

  update session_bookings
  set status = 'cancelled', cancelled_at = now()
  where id = p_booking_id;

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
