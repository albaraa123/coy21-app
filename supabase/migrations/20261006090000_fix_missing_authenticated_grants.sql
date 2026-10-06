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
-- FIRST ATTEMPT at this migration granted full CRUD on all 21 tables
-- below. A re-review (same session, before merge) caught that this was
-- too broad: attendance_records and scan_attempts both carry a dormant
-- `*_scanner_insert` policy (current_user_role() = 'scanner_device' and
-- scanned_by = auth.uid() and session in caller's own assignments) that
-- NO app code anywhere calls directly -- confirmed via
-- `grep -rln "from('scan_attempts')\.insert\|from('attendance_records')\.insert" src/`
-- returning nothing; every real scan/attendance write goes through the
-- service-role RPCs in src/lib/attendance/scan-attempt.ts. Granting
-- INSERT there was never needed and would let a lost/stolen
-- scanner-device token write attendance_records/scan_attempts rows
-- directly over PostgREST, skipping QR verification and capacity
-- checks entirely -- a real privilege-escalation path this migration
-- would have silently opened for the first time.
--
-- This corrected version grants per-table exactly what each table's own
-- RLS policies and real src/ call sites need, checked individually via
-- pg_policy (not just "has nonzero policy count, grant everything"):
--   - Genuinely participant-owned, self-service tables (own-row insert/
--     update/delete policies exist and are used by real app code):
--     application_accommodation, emergency_contacts, travel_legs.
--   - Staff-only `*_all`/`*_staff_all` policies (already is_staff()-
--     gated, so full CRUD here adds no new exposure beyond what RLS
--     already permits for staff accounts): import_batches,
--     import_column_mappings, import_mapping_templates, import_rows,
--     participant_account_provisioning, participant_feature_snapshots,
--     participant_invitations, scanner_assignments.
--   - Select + staff-insert only, no update/delete policy exists at all
--     (granting update/delete would be a harmless no-op, but there is
--     no reason to grant privileges no policy can ever satisfy):
--     application_notes (select, insert).
--   - SELECT ONLY -- every policy on these is read-only for
--     authenticated (confirmed via pg_policy: zero write policies of
--     any kind target a non-staff authenticated caller) OR, for
--     attendance_records/scan_attempts specifically, select is the only
--     grant that's actually needed while deliberately withholding
--     insert/update/delete to keep the dormant scanner-device policies
--     unreachable via PostgREST, as described above:
--     application_status_history, attendance_records, audit_logs,
--     conference_settings, email_log, email_settings, scan_attempts,
--     session_bookings, session_waitlist.
--
-- Still deliberately EXCLUDES qr_credentials (RLS disabled, zero
-- policies -- granting authenticated there would expose raw QR
-- credential rows with no protection at all), qr_bulk_operation_batches/
-- qr_lifecycle_operations/resend_webhook_events (RLS enabled but zero
-- policies -- default-deny, so granting here is a no-op that fixes
-- nothing and only adds unnecessary surface), and diag_app_number_*
-- (RLS disabled, internal diagnostics tables). Those need their own
-- dedicated security review, not a blanket grant from this migration.
--
-- Does NOT grant `anon` -- every policy checked on these tables was
-- defined without `to <role>` (applies broadly once reached) rather
-- than explicitly targeting anon, and the one confirmed failure
-- scenario this fixes is an `authenticated` participant session, not an
-- anonymous one. Granting anon is a separate, larger decision that
-- should not ride along with this fix.
grant select, insert, update, delete on table
  application_accommodation, emergency_contacts, travel_legs,
  import_batches, import_column_mappings, import_mapping_templates,
  import_rows, participant_account_provisioning, participant_feature_snapshots,
  participant_invitations, scanner_assignments
to authenticated;

grant select, insert on table application_notes to authenticated;

grant select on table
  application_status_history, attendance_records, audit_logs,
  conference_settings, email_log, email_settings, scan_attempts,
  session_bookings, session_waitlist
to authenticated;

-- conference_settings/email_settings each have their own super_admin-
-- gated update policy, which needs the UPDATE grant to ever fire (RLS
-- still restricts WHO can actually update; this grant only makes the
-- privilege reachable for the role the policy checks against).
grant update on table conference_settings, email_settings to authenticated;
