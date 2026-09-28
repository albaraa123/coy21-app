-- schedule_change_event_tables.sql
create table schedule_change_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id),
  change_type text not null,
  detected_at timestamptz not null default now(),
  processed_at timestamptz,

  constraint schedule_change_events_type_valid check (change_type in ('time_or_room', 'speakers', 'cancelled'))
);

-- Dedup mechanism: at most one unprocessed event per (session, change_type).
-- A session_people delete-and-reinsert (two row changes within one
-- operation) collapses to a single unprocessed 'speakers' event via
-- ON CONFLICT DO NOTHING in the trigger (Task 5), never generating an
-- intermediate/duplicate event from an incomplete mid-operation state.
create unique index schedule_change_events_unprocessed_dedup
  on schedule_change_events (session_id, change_type) where processed_at is null;

create index schedule_change_events_session_idx on schedule_change_events (session_id);
