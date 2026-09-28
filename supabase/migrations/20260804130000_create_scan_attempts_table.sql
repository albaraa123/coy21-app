-- create_scan_attempts_table.sql
create table scan_attempts (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id),
  session_id uuid references sessions(id),
  scanned_by uuid not null references profiles(id),
  device_identifier text,
  result text not null,
  resulting_attendance_id uuid references attendance_records(id),
  metadata jsonb,
  created_at timestamptz not null default now(),

  constraint scan_attempts_result_check check (result in (
    'admitted', 'flexible_admitted', 'priority_hold', 'full',
    'restricted_denied', 'duplicate', 'timeslot_conflict', 'invalid_qr', 'override_admitted'
  ))
);

create index scan_attempts_session_idx on scan_attempts (session_id);
create index scan_attempts_scanned_by_idx on scan_attempts (scanned_by);
