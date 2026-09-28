-- create_attendance_records_table.sql
create table attendance_records (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id),
  session_id uuid not null references sessions(id),
  time_slot_group_key text not null,
  status text not null default 'admitted',
  entry_type text not null,
  admitted_at timestamptz not null default now(),
  scanned_by uuid not null references profiles(id),
  device_identifier text,
  superseded_attendance_id uuid references attendance_records(id),
  correction_reason text,
  created_at timestamptz not null default now(),

  constraint attendance_records_status_check check (status in ('admitted', 'rejected', 'transferred_out', 'corrected')),
  constraint attendance_records_entry_type_check check (entry_type in ('priority', 'flexible', 'override'))
);

-- Prevents a duplicate ACTIVE admission for the same participant+session —
-- a corrected/transferred-out row does not block a later new admission for
-- the same pair (spec Data Model section).
create unique index attendance_records_no_duplicate_active
  on attendance_records (application_id, session_id)
  where status = 'admitted';

create index attendance_records_session_idx on attendance_records (session_id);
create index attendance_records_application_idx on attendance_records (application_id);
