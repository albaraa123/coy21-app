-- 20260816000000_canonical_authenticated_and_service_role_grants.sql
--
-- CANONICAL PRODUCTION-READINESS GRANT BASELINE — closes the
-- "AUTHENTICATED POSTGRES GRANT BASELINE NOT YET CANONICALLY DEFINED"
-- blocker tracked since Phase 7C, and the related service_role gap
-- discovered while investigating it (Phase 7G-A).
--
-- ROOT CAUSE: every table created by every prior migration in this repo
-- receives only Postgres/Supabase's own bare defaults for `authenticated`
-- and `service_role` (REFERENCES/TRIGGER/TRUNCATE — never SELECT/INSERT/
-- UPDATE/DELETE) unless a migration explicitly GRANTs more. No migration
-- ever did this as a deliberate, complete pass — grants were added
-- piecemeal, table by table, only when a specific feature's own migration
-- happened to need one (e.g. `applications` got SELECT/INSERT/UPDATE for
-- `authenticated` because registration needed it that same migration;
-- `sessions` never did, because no single feature's migration needed
-- service_role SELECT on it badly enough to add it). The result: real
-- end-to-end application flows (participant login, scanner login,
-- scanner assignment admin, participant QR) have repeatedly hit
-- "permission denied for table X" in live testing across Phase 7C
-- through the Participant QR Experience, each time patched with a
-- temporary, disposable-project-only GRANT that was fully revoked
-- afterward — never a real fix.
--
-- METHOD: this migration is the direct output of two exhaustive,
-- code-level audits (not guessed): every `createClient()` (authenticated,
-- cookie-bound session client) call site and every `createServiceRoleClient()`
-- call site in `src/`, tracing every `.from(table).select/insert/update/
-- delete(...)` actually performed through each client. Tables/operations
-- NOT found in that trace are deliberately NOT granted here.
--
-- SCOPE DISCIPLINE (per the approved plan):
--   - No GRANT ALL, no blanket "every table" grant.
--   - DELETE is granted ONLY where a real, traced code path performs one
--     (session_tags — confirmed the single direct-DELETE call site in the
--     whole authenticated+service_role surface; everything else that
--     "removes" something is an UPDATE is_active=false, or a DELETE
--     inside a SECURITY DEFINER RPC body, which runs as the function
--     owner and needs no table-level grant here).
--   - RLS is untouched and remains the actual row-level authority for
--     every `authenticated` grant below — a GRANT only lets the SQL
--     operation reach RLS; RLS still decides which rows are visible/
--     writable. Every `authenticated` table below already has a
--     corresponding _select_own/_insert_own_draft/_update_own_draft or
--     _staff_all RLS policy from an earlier migration (verified, not
--     assumed) — this migration adds no new RLS policy of its own.
--   - `service_role` already bypasses RLS by Supabase's own design; the
--     grants below only let the SQL statement execute at all, they do
--     not change service_role's trust level or reach.
--   - No test-only grants, no test_only_% objects, no disposable-project
--     identifiers. Suitable for real production deployment as-is.

-- ============================================================================
-- AUTHENTICATED — every table a real signed-in participant, scanner_device,
-- or staff account's OWN browser session (never a service-role/RPC-only
-- path) directly touches via .from(table)... Every one of these already
-- has a per-row RLS policy (own-row for participant self-service tables;
-- staff-wide "_staff_all" for the read-only agenda/allocation admin
-- surfaces) — this section only grants the SQL-level permission to reach
-- those existing policies.
-- ============================================================================

-- Own-row participant self-service (own-row RLS: profiles_select_own,
-- applications_select_own/_insert_own_draft/_update_own_draft,
-- schedule_publications_select_own, schedule_publication_items_select_own).
grant select on public.profiles to authenticated;
grant select, insert, update on public.applications to authenticated;
grant select on public.schedule_publications to authenticated;
grant select on public.schedule_publication_items to authenticated;

-- Staff-wide read-only agenda/allocation admin surfaces (RLS: each
-- table's own "<table>_staff_all" policy, `current_user_role() in (...)`,
-- not a per-row owner check — the GRANT below is what lets an
-- authorized staff session's own read reach that policy at all).
grant select on
  public.conference_days,
  public.tracks,
  public.rooms,
  public.session_types,
  public.tags,
  public.people,
  public.sessions,
  public.session_people,
  public.session_tags,
  public.feature_extraction_rules,
  public.feature_extraction_runs,
  public.clustering_runs,
  public.clusters,
  public.cluster_memberships,
  public.allocation_runs,
  public.allocation_assignments,
  public.allocation_issues,
  public.allocation_assignment_explanations,
  public.allocation_alternatives,
  public.schedule_publication_drafts,
  public.schedule_publication_draft_items,
  public.schedule_change_events
to authenticated;

-- ============================================================================
-- SERVICE_ROLE — every table the trusted server boundary (every
-- requireXStaffCaller/requireScannerDeviceCaller/requireParticipantCaller-
-- gated Server Action, and every server-only lib module) actually
-- reads/writes via a service-role client. Traced exhaustively against
-- real (non-test) code in src/ — a table absent from this list is either
-- RPC-body-only (needs no table grant here; SECURITY DEFINER functions
-- run as their owner) or genuinely untouched by any current feature.
-- ============================================================================

grant select, insert, update on
  public.profiles,
  public.applications,
  public.conference_days,
  public.sessions,
  public.rooms,
  public.people,
  public.session_types,
  public.tags,
  public.tracks,
  public.qr_encryption_key_registry,
  public.allocation_runs,
  public.allocation_assignments,
  public.feature_extraction_rules,
  public.feature_extraction_runs,
  public.participant_feature_snapshots,
  public.clustering_runs,
  public.schedule_publication_items,
  public.schedule_publication_draft_items,
  public.schedule_change_events,
  public.import_batches,
  public.import_column_mappings,
  public.import_mapping_templates,
  public.import_rows,
  public.participant_invitations,
  public.participant_account_provisioning,
  public.scanner_assignments
to service_role;

-- Insert-only trails/logs (this server boundary only ever appends to
-- these — no code path updates or re-reads its own prior audit/log rows
-- through this client).
grant insert on
  public.application_status_history,
  public.application_notes,
  public.email_log,
  public.audit_logs,
  public.allocation_alternatives,
  public.allocation_assignment_explanations,
  public.allocation_issues,
  public.clusters,
  public.cluster_memberships,
  public.resend_webhook_events
to service_role;

-- Select-only (read paths only — no direct table write through this
-- client for these; any mutation happens via a SECURITY DEFINER RPC
-- instead, e.g. finalize_qr_issuance_for_server for qr_credentials).
grant select on
  public.qr_credentials,
  public.attendance_records,
  public.application_answers
to service_role;

-- The one confirmed direct-DELETE code path (setSessionTags's
-- full-replace pattern — see agenda/sessions/[id]/actions.ts).
grant delete on public.session_tags to service_role;
