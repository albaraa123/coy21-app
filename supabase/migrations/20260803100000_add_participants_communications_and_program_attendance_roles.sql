-- add_participants_communications_and_program_attendance_roles.sql
--
-- Adds the two approved active staff roles: participants_communications_manager
-- (Excel import, participant account provisioning, login-detail delivery,
-- participant communications) and program_attendance_manager (agenda, feature
-- extraction, clustering, allocation, schedule publication, future
-- QR/scanner/attendance). Purely additive -- the existing unused
-- communications_attendance_manager enum value is left in place untouched
-- (Postgres enums cannot drop values; no profile currently uses it).
--
-- Isolated in its own migration file with nothing else in it, matching the
-- precedent in 20260730100000_add_travel_operations_and_participant_care_roles.sql:
-- a new enum value must be committed before it can be referenced by any
-- policy or check constraint in a later migration.
alter type user_role add value 'participants_communications_manager';
alter type user_role add value 'program_attendance_manager';
