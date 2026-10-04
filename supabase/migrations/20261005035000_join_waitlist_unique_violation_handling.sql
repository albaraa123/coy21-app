-- 20261005035000_join_waitlist_unique_violation_handling.sql
--
-- Code review of 20261005030000 found a gap against the design spec
-- (docs/superpowers/specs/2026-10-01-work-group-waitlist-design.md,
-- section "RPC Changes / join_waitlist", step 7): a duplicate join raced
-- past the pre-check exists() and hitting the session_waitlist_active_unique
-- partial index (20261005020000) directly would surface a raw, uncaught
-- Postgres 23505 unique_violation instead of the same clean
-- 'You are already on the waitlist for this session' message the
-- pre-check already produces for the non-racing case -- exactly the
-- "clear exceptions instead of raw constraint violations" promise this
-- function's own header comment makes, and the established pattern this
-- codebase already uses for the identical situation in
-- claim_application_transactional() (20260726110000_claim_application_
-- function.sql): wrap the write in begin/exception when unique_violation,
-- re-raising a hand-written message instead of letting the raw
-- constraint error reach the caller.
--
-- Full replace (only the final insert's error handling changes; every
-- other check/line is unchanged from 20261005030000).

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

  begin
    insert into session_waitlist (application_id, session_id)
    values (p_application_id, p_session_id)
    returning id into v_waitlist_id;
  exception when unique_violation then
    -- session_waitlist_active_unique (20261005020000) permits at most one
    -- 'waiting' row per (application_id, session_id). The exists() check
    -- above already rejects this on the common path; this catches the
    -- narrow concurrent-double-submit race where two calls both pass that
    -- check before either commits -- same pattern and rationale as
    -- claim_application_transactional()'s unique_violation handling in
    -- 20260726110000_claim_application_function.sql. Re-raising the same
    -- message the pre-check uses keeps the error stable/matchable for the
    -- participant-facing UI regardless of which path produced it.
    raise exception 'You are already on the waitlist for this session';
  end;

  return v_waitlist_id;
end;
$$;

grant execute on function join_waitlist(uuid, uuid) to authenticated;
