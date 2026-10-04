-- 20261006040000_no_show_detection_and_promotion_helper.sql
--
-- Extracts cancel_booking's inline promotion loop into a shared
-- promote_next_waitlist_candidate() helper (cancel_booking's existing
-- promotion behavior is unchanged -- this is a pure refactor, verified
-- by Task 1's/4d's existing cancel_booking tests staying green), and
-- adds process_session_no_shows(), which calls the same helper. See
-- docs/superpowers/specs/2026-10-04-booking-rules-completion-design.md
-- "No-Show Detection and Seat Release" section for full rationale,
-- including why idempotency is per-booking (via status = 'active') and
-- not a session-level marker column, and why within-pass promotion
-- feedback is safe by construction (PL/pgSQL cursor materialization).

create function promote_next_waitlist_candidate(p_session_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_session         sessions%rowtype;
  v_candidate       record;
  v_new_booking_id  uuid;
begin
  select * into v_session from sessions where id = p_session_id;

  <<promotion>>
  for v_candidate in
    select sw.id, sw.application_id, sw.status
    from session_waitlist sw
    where sw.session_id = p_session_id
      and sw.status = 'waiting'
    order by sw.joined_at asc
    for update of sw
  loop
    -- Defense-in-depth, not closing a distinct gap: Postgres's FOR
    -- UPDATE / EvalPlanQual re-check already excludes a row a
    -- concurrent leave_waitlist withdrew before this loop's lock on
    -- it was granted, so this branch should be unreachable in
    -- practice -- kept as a guard against relying on undocumented
    -- planner behavior staying stable across a future Postgres
    -- version.
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
    values (v_candidate.application_id, p_session_id)
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
    values (v_new_booking_id, v_candidate.application_id, p_session_id, 'waitlist_promoted');

    exit promotion;
  end loop;
end;
$$;

create function process_session_no_shows(p_session_id uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_booking         record;
  v_enable_waitlist boolean;
begin
  select st.enable_waitlist into v_enable_waitlist
  from sessions s join session_types st on st.id = s.session_type_id
  where s.id = p_session_id;

  for v_booking in
    select sb.id
    from session_bookings sb
    where sb.session_id = p_session_id
      and sb.status = 'active'
      and not exists (
        select 1 from attendance_records ar
        where ar.booking_id = sb.id and ar.status = 'admitted'
      )
    for update of sb
  loop
    update session_bookings set status = 'no_show' where id = v_booking.id;

    if coalesce(v_enable_waitlist, false) then
      perform promote_next_waitlist_candidate(p_session_id);
    end if;
  end loop;
end;
$$;

-- cancel_booking: full current authoritative body from
-- 20261006010000_consolidate_session_effective_deadline.sql, with its
-- entire inline <<promotion>> for v_candidate in ... end loop; block
-- replaced by a call to the new promote_next_waitlist_candidate()
-- helper above -- preserving the exact same "only call into the
-- promotion path when the session type supports a waitlist" gate
-- process_session_no_shows also uses, so neither caller diverges from
-- the other's contract with promote_next_waitlist_candidate. Every
-- other line (the session_effective_deadline() call from Task 1, the
-- restored explanatory comments from Task 1's own code-quality fix) is
-- unchanged. v_candidate/v_new_booking_id are dropped from the declare
-- block -- no longer used here, now local to the extracted helper.
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

  -- Waitlist promotion: only for voluntary cancellation (this function),
  -- never for staff-initiated session cancellation (handled by the 4c
  -- trigger, which never calls this function).
  select st.enable_waitlist into v_enable_waitlist
  from session_types st where st.id = v_session.session_type_id;

  if coalesce(v_enable_waitlist, false) then
    perform promote_next_waitlist_candidate(v_booking.session_id);
  end if;
end;
$$;

grant execute on function cancel_booking(uuid, uuid) to authenticated;
