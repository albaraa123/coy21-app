-- create_scanner_assignments_table.sql
create table scanner_assignments (
  id uuid primary key default gen_random_uuid(),
  scanner_user_id uuid not null references profiles(id),
  room_id uuid references rooms(id),
  session_id uuid references sessions(id),
  is_active boolean not null default true,
  assigned_by uuid not null references profiles(id),
  assigned_at timestamptz not null default now(),

  constraint scanner_assignments_scope_check check (room_id is not null or session_id is not null)
);

create index scanner_assignments_scanner_user_idx on scanner_assignments (scanner_user_id);
create index scanner_assignments_session_idx on scanner_assignments (session_id);
create index scanner_assignments_room_idx on scanner_assignments (room_id);
