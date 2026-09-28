-- 20260816020000_correct_attendance_records_update_grant.sql
--
-- SECOND corrective follow-up to 20260816000000_canonical_authenticated_
-- and_service_role_grants.sql, found while re-running live suites (Phase
-- 7G-B) after the first correction (20260816010000).
--
-- ROOT CAUSE: correct_attendance_transactional and
-- transfer_attendance_transactional (both defined in supabase/migrations/
-- 20260804170000_admission_management_functions.sql) are plain
-- `language plpgsql` functions with NO `security definer` clause, so they
-- run as the calling role — service_role, since both are invoked via
-- correctAttendanceForCaller/transferAttendanceForCaller in
-- src/lib/attendance/admission-management.ts through a service-role
-- client. Both functions UPDATE attendance_records (correct_attendance_
-- transactional line 14; transfer_attendance_transactional line 47), which
-- 20260816010000 granted INSERT+SELECT on but not UPDATE.

grant update on public.attendance_records to service_role;
