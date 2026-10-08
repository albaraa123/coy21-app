-- supabase/migrations/20261008020000_notification_writer_rpcs.sql
--
-- Sub-project 6, Task 1: the three security definer writer RPCs for the
-- notifications table. create_notification itself is security definer so
-- it can write to notifications regardless of its caller's own privileges
-- -- its CALLERS do not need to be security definer themselves (Postgres
-- runs a security definer function with the definer's own rights no
-- matter what context calls it). Specifically: enforce_session_lifecycle_
-- booking_sync() and promote_next_waitlist_candidate() (Task 3) are NOT
-- security definer today and must NOT be changed to become so just to
-- call this -- that would be an unrelated, unnecessary privilege
-- escalation. See the design spec's "Writer RPCs" section for the full
-- trust-boundary reasoning per caller.

create function create_notification(
  p_application_id  uuid,
  p_channel         notification_channel,
  p_title           text,
  p_body            text default null,
  p_link_path       text default null,
  p_session_id      uuid default null,
  p_old_start_time  timestamptz default null,
  p_new_start_time  timestamptz default null
) returns notifications
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row notifications;
begin
  insert into notifications (
    application_id, is_broadcast, channel, title, body, link_path,
    session_id, old_start_time, new_start_time
  ) values (
    p_application_id, false, p_channel, p_title, p_body, p_link_path,
    p_session_id, p_old_start_time, p_new_start_time
  )
  returning * into v_row;
  return v_row;
end;
$$;

-- No PUBLIC/anon/authenticated grant -- callable only by service_role
-- (direct RPC callers using the service-role client) or by other
-- security definer functions that call it internally. Participants never
-- call this directly.
revoke all on function create_notification(uuid, notification_channel, text, text, text, uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function create_notification(uuid, notification_channel, text, text, text, uuid, timestamptz, timestamptz) to service_role;

create function create_announcement(p_title text, p_body text default null) returns notifications
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row notifications;
begin
  -- coalesce(is_staff(), false): is_staff() returns NULL (not false) for
  -- an anonymous caller (no profiles row keyed on auth.uid()) -- a bare
  -- `if not is_staff()` would silently never fire for that caller. Same
  -- NULL-bypass pattern this codebase has already hit and fixed twice
  -- (ops_dashboard_snapshot(), admit_walk_in()). No separate
  -- `or auth.role() = 'service_role'` carve-out here, unlike
  -- ops_dashboard_snapshot() -- this RPC is intended to be called only
  -- from a real staff session via the admin announcement page (Task 5),
  -- never from a service-role context or a live test fixture pretending
  -- to be staff without a real profiles row. If that assumption changes,
  -- add the carve-out explicitly and update this comment plus Testing
  -- Requirement 9's live test.
  if not coalesce(is_staff(), false) then
    raise exception 'Not authorized';
  end if;

  insert into notifications (application_id, is_broadcast, channel, title, body)
  values (null, true, 'announcement', p_title, p_body)
  returning * into v_row;
  return v_row;
end;
$$;

grant execute on function create_announcement(text, text) to authenticated;
revoke execute on function create_announcement(text, text) from public, anon;

create function mark_notification_read(p_notification_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row notifications;
  v_caller_application_id uuid;
begin
  select * into v_row from notifications where id = p_notification_id;
  if v_row.id is null then
    raise exception 'Notification not found';
  end if;

  select id into v_caller_application_id from applications where applicant_id = auth.uid();

  if v_row.is_broadcast then
    if v_caller_application_id is null then
      raise exception 'Not authorized';
    end if;
    insert into notification_broadcast_reads (notification_id, application_id)
    values (p_notification_id, v_caller_application_id)
    on conflict (notification_id, application_id) do nothing;
  else
    if v_row.application_id is distinct from v_caller_application_id or v_caller_application_id is null then
      raise exception 'Not authorized';
    end if;
    update notifications set read_at = coalesce(read_at, now()) where id = p_notification_id;
  end if;
end;
$$;

grant execute on function mark_notification_read(uuid) to authenticated;
revoke execute on function mark_notification_read(uuid) from public, anon;
