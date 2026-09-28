-- attendance_rls_policies.sql
alter table attendance_records enable row level security;
alter table scan_attempts enable row level security;
alter table scanner_assignments enable row level security;

-- attendance_records: super_admin/program_attendance_manager full access.
create policy attendance_records_manager_all on attendance_records
  for all using (current_user_role() in ('program_attendance_manager', 'super_admin'));

-- scanner_device: read/insert only for rows tied to its own scanner_assignments.
create policy attendance_records_scanner_select on attendance_records
  for select using (
    current_user_role() = 'scanner_device'
    and session_id in (
      select session_id from scanner_assignments where scanner_user_id = auth.uid() and is_active
      union
      select s.id from sessions s
      join scanner_assignments sa on sa.room_id = s.room_id
      where sa.scanner_user_id = auth.uid() and sa.is_active
    )
  );

create policy attendance_records_scanner_insert on attendance_records
  for insert with check (
    current_user_role() = 'scanner_device'
    and scanned_by = auth.uid()
    and session_id in (
      select session_id from scanner_assignments where scanner_user_id = auth.uid() and is_active
      union
      select s.id from sessions s
      join scanner_assignments sa on sa.room_id = s.room_id
      where sa.scanner_user_id = auth.uid() and sa.is_active
    )
  );

-- scan_attempts: same shape as attendance_records.
create policy scan_attempts_manager_all on scan_attempts
  for all using (current_user_role() in ('program_attendance_manager', 'super_admin'));

create policy scan_attempts_scanner_select on scan_attempts
  for select using (
    current_user_role() = 'scanner_device'
    and session_id in (
      select session_id from scanner_assignments where scanner_user_id = auth.uid() and is_active
      union
      select s.id from sessions s
      join scanner_assignments sa on sa.room_id = s.room_id
      where sa.scanner_user_id = auth.uid() and sa.is_active
    )
  );

create policy scan_attempts_scanner_insert on scan_attempts
  for insert with check (
    current_user_role() = 'scanner_device'
    and scanned_by = auth.uid()
    and session_id in (
      select session_id from scanner_assignments where scanner_user_id = auth.uid() and is_active
      union
      select s.id from sessions s
      join scanner_assignments sa on sa.room_id = s.room_id
      where sa.scanner_user_id = auth.uid() and sa.is_active
    )
  );

-- scanner_assignments: manager full access; scanner_device reads only its own row(s).
create policy scanner_assignments_manager_all on scanner_assignments
  for all using (current_user_role() in ('program_attendance_manager', 'super_admin'));

create policy scanner_assignments_scanner_select_own on scanner_assignments
  for select using (current_user_role() = 'scanner_device' and scanner_user_id = auth.uid());
