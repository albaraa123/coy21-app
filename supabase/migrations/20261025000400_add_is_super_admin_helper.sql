-- 20261025000400_add_is_super_admin_helper.sql
--
-- is_staff() means "staff OR super_admin" and stays that way (several
-- policies depend on that meaning and must keep working for staff --
-- attendance_records, scan_attempts, scanner_assignments, admit_walk_in,
-- and the /attendance/admissions RPCs). Everything ELSE currently on
-- is_staff() needs to become super_admin-only once staff is narrowed --
-- this new helper is what those policies/functions switch to.
create function is_super_admin() returns boolean as $$
  select current_user_role() = 'super_admin';
$$ language sql stable security definer set search_path = public;
