-- supabase/migrations/20261008010000_notifications_table.sql
--
-- Sub-project 6 (notifications layer): the unified notifications table,
-- replacing session_notification_outbox (20261004010000_session_lifecycle_notifications.sql)
-- for all NEW notification writes going forward. session_notification_outbox
-- itself is left entirely unmodified -- a frozen pre-cutover archive, no new
-- writes, no deletion, no retroactive migration. See
-- docs/superpowers/specs/2026-10-08-notifications-layer-design.md for the
-- full design rationale.

create type notification_channel as enum (
  'application_accepted', 'application_rejected',
  'booking_confirmed',
  'session_cancelled', 'session_rescheduled', 'waitlist_promoted',
  'session_reminder', 'travel_reminder',
  'announcement'
);
create type notification_status as enum ('pending', 'sent', 'failed');

create table notifications (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid references applications(id) on delete cascade,
  is_broadcast    boolean not null default false,
  channel         notification_channel not null,
  title           text not null,
  body            text,
  link_path       text,
  session_id      uuid references sessions(id) on delete set null,
  old_start_time  timestamptz,
  new_start_time  timestamptz,
  email_status    notification_status not null default 'pending',
  error_message   text,
  read_at         timestamptz,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  constraint notifications_broadcast_application_id_check
    check ((is_broadcast and application_id is null) or (not is_broadcast and application_id is not null))
);

create index notifications_pending_idx on notifications (created_at) where email_status = 'pending';
create index notifications_application_feed_idx on notifications (application_id, created_at desc) where not is_broadcast;

alter table notifications enable row level security;

create policy notifications_own_select on notifications
  for select to authenticated
  using (not is_broadcast and application_id in (
    select id from applications where applicant_id = auth.uid()
  ));

create policy notifications_broadcast_select on notifications
  for select to authenticated
  using (is_broadcast = true);

-- No insert/update/delete policy -- every write goes through the
-- security definer create_notification/create_announcement RPCs (Task 1),
-- enforced by GRANT discipline (revoked from public/anon below), the same
-- pattern session_notification_outbox already established.
revoke all on notifications from public, anon, authenticated;
grant select on notifications to authenticated;
grant all on notifications to service_role;

create table notification_broadcast_reads (
  notification_id uuid not null references notifications(id) on delete cascade,
  application_id  uuid not null references applications(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, application_id)
);

alter table notification_broadcast_reads enable row level security;

create policy notification_broadcast_reads_own_select on notification_broadcast_reads
  for select to authenticated
  using (application_id in (select id from applications where applicant_id = auth.uid()));

-- No insert policy -- rows are created exclusively via mark_notification_read
-- (Task 1), not direct client insert, so a participant cannot mark another
-- participant's copy of a broadcast as read.
revoke all on notification_broadcast_reads from public, anon, authenticated;
grant select on notification_broadcast_reads to authenticated;
grant all on notification_broadcast_reads to service_role;
