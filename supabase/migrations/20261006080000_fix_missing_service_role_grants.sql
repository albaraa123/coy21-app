-- 20261006080000_fix_missing_service_role_grants.sql
--
-- Found while resuming sub-project 5a's Task 1 after replaying the
-- 2026-09-30..2026-10-06 migration backlog onto deukwztsmcnxxchrdrfo
-- (see docs/superpowers/plans/2026-10-05-ops-dashboard.md, Task 1): this
-- project's `public` schema default ACL only grants back to `postgres`
-- itself (`pg_default_acl` had a single row: defaclrole=postgres,
-- defaclacl={postgres=arwdDxtm/postgres}), unlike a normally-bootstrapped
-- Supabase project, where new tables also pick up grants for
-- anon/authenticated/service_role automatically. As a result, 22 public
-- tables across this project -- not just this sub-project's own tables --
-- never received a table-level GRANT for `service_role`, even though
-- `service_role` correctly has `rolbypassrls = true`. A service-role
-- client (e.g. any test fixture or server-side admin client) got a hard
-- "permission denied for table X" on direct access to any of them,
-- regardless of RLS.
--
-- This is a project-wide infrastructure gap, not specific to any one
-- feature's tables -- it happened to surface via session_bookings while
-- writing this sub-project's live tests, but conference_settings and
-- session_waitlist (both from the immediately-preceding 4d/4e backlog)
-- were affected too, plus several older, unrelated tables.
--
-- Fixes both the existing gap (explicit grant on every currently-affected
-- table) and the root cause (the default ACL itself), so tables created
-- by future migrations don't repeat this.
grant all on table
  allocation_alternatives, allocation_assignment_explanations,
  application_accommodation, application_notes, conference_settings,
  diag_app_number_function_props, diag_app_number_log, diag_app_number_seq_props,
  email_log, email_settings, emergency_contacts,
  local_info_images, local_info_items, local_info_sections,
  qr_bulk_operation_batches, qr_lifecycle_operations, resend_webhook_events,
  session_bookings, session_notification_outbox, session_waitlist,
  staff_assignments, travel_legs
to service_role;

alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;
