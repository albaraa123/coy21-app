-- supabase/migrations/20261008080000_get_my_notifications_rpc.sql
--
-- Sub-project 6, Task 7: a single RPC that joins the caller's personal
-- notifications rows with every broadcast row into one read-state-
-- resolved feed, so the bell's read query stays a plain RPC call with no
-- client-side two-query join / manual read-state merge, and so
-- notification_broadcast_reads itself never needs a direct client select
-- grant (see the design spec's "Architecture — Realtime (the bell)"
-- section for the RPC-vs-client-join decision).
--
-- NOTE: this file's timestamp is 20261008080000, not the
-- 20261008060000 the implementation plan's Step 3a literally names --
-- that exact filename is already taken by Task 3's
-- 20261008060000_isolate_notification_failures.sql (already committed
-- and applied live). The highest existing migration timestamp in this
-- directory as of writing is 20261008071000, so 20261008080000 is free.
--
-- security definer so it can read notification_broadcast_reads (no
-- direct client select grant on that table) on the caller's behalf,
-- scoped defensively to the caller's own application_id resolved from
-- auth.uid() inside the function body -- never trusts a caller-supplied
-- application id.
create function get_my_notifications() returns table (
  id uuid,
  is_broadcast boolean,
  channel notification_channel,
  title text,
  body text,
  link_path text,
  created_at timestamptz,
  is_read boolean
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_application_id uuid;
begin
  select a.id into v_application_id from applications a where a.applicant_id = auth.uid();
  if v_application_id is null then
    raise exception 'Not authorized';
  end if;

  return query
    select n.id, n.is_broadcast, n.channel, n.title, n.body, n.link_path, n.created_at,
      (n.read_at is not null) as is_read
    from notifications n
    where not n.is_broadcast and n.application_id = v_application_id
    union all
    select n.id, n.is_broadcast, n.channel, n.title, n.body, n.link_path, n.created_at,
      (r.notification_id is not null) as is_read
    from notifications n
    left join notification_broadcast_reads r
      on r.notification_id = n.id and r.application_id = v_application_id
    where n.is_broadcast
    order by created_at desc;
end;
$$;

grant execute on function get_my_notifications() to authenticated;
revoke execute on function get_my_notifications() from public, anon;
