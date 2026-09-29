-- 20260929000001_migrate_staff_profiles_and_add_helper.sql
--
-- Part 2 of the staff role consolidation. Must run in a migration file
-- AFTER 20260929000000 (which added 'staff' to the user_role enum) is
-- committed — see that file's header comment for why this can't be
-- combined into one file.

-- Move every existing profile off the 7 deprecated staff-domain roles.
update profiles set role = 'staff'
where role in (
  'registration_admission_manager',
  'agenda_allocation_manager',
  'communications_attendance_manager',
  'travel_operations_staff',
  'participant_care_staff',
  'participants_communications_manager',
  'program_attendance_manager'
);

-- Shared helper: single source of truth for "is this caller staff" in
-- SQL/plpgsql. Built on the existing current_user_role() helper
-- (20260721212035_rls_policies.sql). Used by every RLS policy and every
-- inline plpgsql role check this consolidation touches (Tasks 2 and 3).
create function is_staff() returns boolean as $$
  select current_user_role() in ('staff', 'super_admin');
$$ language sql stable security definer set search_path = public;

comment on type user_role is
  'registration_admission_manager, agenda_allocation_manager, communications_attendance_manager, '
  'travel_operations_staff, participant_care_staff, participants_communications_manager, and '
  'program_attendance_manager are DEPRECATED as of 2026-09-29 (see '
  'docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md). Do not assign them to new '
  'profiles — use staff instead. They remain in this type only because Postgres cannot drop enum '
  'values in place.';
