-- 20260929000000_add_staff_role_and_migrate.sql
--
-- Part 1 of the staff role consolidation (see
-- docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md).
-- Adds 'staff' as a new user_role enum value. This is additive only —
-- the 7 old staff-domain values are not removed (Postgres does not
-- support dropping enum values in place) and remain physically in the
-- type but are deprecated: no code path will assign them again after
-- this migration.
alter type user_role add value 'staff';
