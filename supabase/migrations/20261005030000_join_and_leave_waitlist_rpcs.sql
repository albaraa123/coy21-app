-- 20261005030000_join_and_leave_waitlist_rpcs.sql
--
-- join_waitlist / leave_waitlist: participant-facing self-service RPCs
-- for the waitlist. Modeled directly on book_session()/cancel_booking()'s
-- existing structure (auth check, row lock, clear exceptions instead of
-- raw constraint violations). See
-- docs/superpowers/specs/2026-10-01-work-group-waitlist-design.md
-- section "RPC Changes".

create function join_waitlist(
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

  v_deadline := coalesce(v_session.booking_deadline, v_session.start_time - interval '3 hours');
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

  insert into session_waitlist (application_id, session_id)
  values (p_application_id, p_session_id)
  returning id into v_waitlist_id;

  return v_waitlist_id;
end;
$$;

grant execute on function join_waitlist(uuid, uuid) to authenticated;

create function leave_waitlist(
  p_application_id uuid,
  p_session_id     uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_waitlist_id uuid;
begin
  if not exists (
    select 1 from applications
    where id = p_application_id and applicant_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  select id into v_waitlist_id from session_waitlist
  where application_id = p_application_id and session_id = p_session_id and status = 'waiting'
  for update;

  if v_waitlist_id is null then
    raise exception 'You are not on the waitlist for this session';
  end if;

  update session_waitlist
  set status = 'withdrawn', withdrawn_at = now()
  where id = v_waitlist_id;
end;
$$;

grant execute on function leave_waitlist(uuid, uuid) to authenticated;
