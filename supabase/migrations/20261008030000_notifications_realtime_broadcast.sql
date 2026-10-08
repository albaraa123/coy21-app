-- supabase/migrations/20261008030000_notifications_realtime_broadcast.sql
--
-- Sub-project 6, Task 2: Realtime broadcast-via-trigger for the
-- notifications table, mirroring sub-project 5a's established pattern
-- (20261006071000_ops_dashboard_snapshot.sql) exactly. Two channel
-- shapes: a single shared 'notifications-broadcast' topic for
-- is_broadcast rows, and a per-applicant 'notifications-<application_id>'
-- topic for personal rows -- each participant subscribes only to their
-- own personal topic plus the one shared broadcast topic.

create or replace function notify_participant_notification() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.is_broadcast then
    perform realtime.send(
      jsonb_build_object('id', new.id), 'change', 'notifications-broadcast', true
    );
  else
    perform realtime.send(
      jsonb_build_object('id', new.id), 'change',
      'notifications-' || new.application_id::text, true
    );
  end if;
  return new;
end;
$$;

create trigger notifications_notify_participant
  after insert on notifications
  for each row execute function notify_participant_notification();

-- Postgres has no `create policy if not exists` -- drop then create,
-- same pattern 5a's migration established.
drop policy if exists notifications_broadcast_channel_select on realtime.messages;
create policy notifications_broadcast_channel_select on realtime.messages
  for select to authenticated
  using (extension = 'broadcast' and realtime.topic() = 'notifications-broadcast');

drop policy if exists notifications_personal_channel_select on realtime.messages;
create policy notifications_personal_channel_select on realtime.messages
  for select to authenticated
  using (
    extension = 'broadcast'
    and realtime.topic() = 'notifications-' || (
      select id::text from applications where applicant_id = auth.uid() limit 1
    )
  );
  -- This policy's correctness relies on applications_one_per_applicant
  -- (20260721202027_applications_table.sql), a single-column unique index
  -- on applicant_id with no `where` clause -- confirmed structurally
  -- guaranteed, not just usually true. If that uniqueness is ever
  -- relaxed, this `limit 1` would silently pick an arbitrary application.
