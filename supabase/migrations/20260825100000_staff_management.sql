-- Staff assignments: links a staff profile to a specific task/gate/room
create type staff_assignment_type as enum (
  'scanning_gate',   -- assigned to a QR scanning gate/entrance
  'session_monitor', -- monitoring a specific session/room
  'participant_care', -- general participant care desk
  'data_monitoring', -- monitoring participant data/registration
  'general'          -- general task with free-text description
);

create table staff_assignments (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references profiles(id) on delete cascade,
  assignment_type staff_assignment_type not null default 'general',
  -- optional links to specific resources
  room_id uuid references rooms(id) on delete set null,
  session_id uuid references sessions(id) on delete set null,
  -- human-readable label shown to the staff member
  label text not null,
  notes text,
  -- when this assignment is active
  starts_at timestamptz,
  ends_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index on staff_assignments(staff_id);
create index on staff_assignments(room_id);
create index on staff_assignments(session_id);

-- RLS: only super_admin can manage; staff can read their own assignments
alter table staff_assignments enable row level security;

create policy "super_admin full access"
  on staff_assignments for all
  using (current_user_role() = 'super_admin')
  with check (current_user_role() = 'super_admin');

create policy "staff read own assignments"
  on staff_assignments for select
  using (staff_id = auth.uid());

-- Grant
grant select, insert, update, delete on staff_assignments to authenticated;
