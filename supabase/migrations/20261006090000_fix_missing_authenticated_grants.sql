-- 20261006090000_fix_missing_authenticated_grants.sql
--
-- Follow-up to 20261006080000_fix_missing_service_role_grants.sql: that
-- migration's own header claimed this project's broken default ACL
-- (public schema default ACL only ever grants back to postgres, see
-- that file's comment) was fixed, but it only restored grants for
-- service_role. The same gap exists for `authenticated` on every table
-- that already has real RLS policies written against it -- meaning
-- client access was clearly intended and gated by RLS, it just never
-- received the table-level GRANT a normally-bootstrapped Supabase
-- project would have applied automatically.
--
-- Found 2026-10-06 during sub-project 5a's (ops dashboard) final
-- whole-branch review, which traced a concrete failure: with no
-- `authenticated` grant on session_bookings/session_waitlist/
-- conference_settings, src/app/[locale]/(participant)/(shell)/
-- my-agenda/browse/page.tsx's user-client reads of those tables fail
-- with "permission denied", silently swallowed by that page's error
-- handling -- so booked/waitlisted state and the global deadline never
-- show for real participants on this project right now. This is a
-- pre-existing gap unrelated to the ops dashboard feature itself.
--
-- Scope: ONLY the tables with pre-existing RLS policies already written
-- (confirmed via pg_policy -- a nonzero policy count is direct evidence
-- client-facing access was intended and is meant to be RLS-gated, not
-- service-role-only). Deliberately EXCLUDES qr_credentials (RLS
-- disabled, zero policies -- granting authenticated there would expose
-- raw QR credential rows with no protection at all), qr_bulk_operation_
-- batches/qr_lifecycle_operations/resend_webhook_events (RLS enabled but
-- zero policies -- default-deny, so granting here is a no-op that fixes
-- nothing and only adds unnecessary surface), and diag_app_number_*
-- (RLS disabled, internal diagnostics tables). Those five need their own
-- dedicated security review, not a blanket grant from this migration.
--
-- Does NOT grant `anon` -- every policy checked on these 20 tables was
-- defined without `to <role>` (applies broadly once reached) rather
-- than explicitly targeting anon, and the one confirmed failure
-- scenario this fixes is an `authenticated` participant session, not an
-- anonymous one. Granting anon is a separate, larger decision that
-- should not ride along with this fix.
grant select, insert, update, delete on table
  application_accommodation, application_notes, application_status_history,
  attendance_records, audit_logs, conference_settings, email_log,
  email_settings, emergency_contacts, import_batches, import_column_mappings,
  import_mapping_templates, import_rows, participant_account_provisioning,
  participant_feature_snapshots, participant_invitations, scan_attempts,
  scanner_assignments, session_bookings, session_waitlist, travel_legs
to authenticated;
