-- 20261025000500_narrow_staff_rls_to_super_admin.sql
--
-- Staff role narrowing (docs/superpowers/specs/2026-10-25-profile-
-- accommodation-staff-narrowing-design.md Item 6, layer 8). Converts
-- every is_staff()-gated RLS policy EXCEPT the attendance-domain surface
-- (attendance_records, scan_attempts, scanner_assignments) from
-- is_staff() to is_super_admin(). Also converts the 2 non-table objects
-- review found easy to miss (ops_dashboard_snapshot(), the
-- ops_dashboard_broadcast_select policy on realtime.messages) and the
-- 3 other SECURITY DEFINER RPCs whose bodies reference is_staff()
-- directly (create_announcement, request_staff_qr_issuance_transactional_
-- internal, request_staff_qr_reissue_transactional_internal,
-- rollback_import_batch_transactional).
--
-- Generated from a live `select * from pg_policies where qual ilike
-- '%is_staff%' or with_check ilike '%is_staff%'` query against the real
-- linked project (vfwcbkjvinbtcntwjrzq) at implementation time -- 60
-- policies found, all handled below. Also from a live
-- `select proname from pg_proc where prosrc ilike '%is_staff()%' and
-- pronamespace = 'public'::regnamespace` query -- 6 functions found:
-- admit_walk_in (kept, backs the kept /attendance/walk-in capability),
-- the 5 others converted below.
--
-- admit_walk_in is deliberately NOT touched -- confirmed it backs the
-- kept /attendance/walk-in capability (src/app/api/admit-walk-in/
-- route.ts via requireWalkInStaffCaller), must keep admitting staff.
--
-- The 6 /attendance/admissions Server Actions (performAdmitOverride,
-- performCorrectAttendance, performTransferAttendance,
-- searchApplicationsForAdmission, fetchAttendanceStateForApplication,
-- fetchAttendanceAuditLog) all use a SERVICE-ROLE client gated by the
-- application-layer requireProgramAttendanceStaffCaller() check, not by
-- RLS -- confirmed by reading src/app/[locale]/(admin)/attendance/
-- admissions/actions.ts. RLS is bypassed entirely for those 6 actions'
-- own table access, so this migration's table-policy changes do not
-- affect them; they remain correctly gated at the application layer
-- (already patched to keep staff in Step 4.6).

-- =====================================================================
-- Part 1: table-level RLS policies -- is_staff() -> is_super_admin()
-- =====================================================================
-- Straightforward USING-clause policies (qual = 'is_staff()' exactly,
-- with_check null): drop and recreate identically, swapping only the
-- helper. Grouped by table for readability.

drop policy allocation_alternatives_staff_all on allocation_alternatives;
create policy allocation_alternatives_staff_all on allocation_alternatives for all using (is_super_admin());

drop policy allocation_assignment_explanations_staff_all on allocation_assignment_explanations;
create policy allocation_assignment_explanations_staff_all on allocation_assignment_explanations for all using (is_super_admin());

drop policy allocation_assignments_staff_all on allocation_assignments;
create policy allocation_assignments_staff_all on allocation_assignments for all using (is_super_admin());

drop policy allocation_issues_staff_all on allocation_issues;
create policy allocation_issues_staff_all on allocation_issues for all using (is_super_admin());

drop policy allocation_runs_staff_all on allocation_runs;
create policy allocation_runs_staff_all on allocation_runs for all using (is_super_admin());

drop policy accommodation_select_staff on application_accommodation;
create policy accommodation_select_staff on application_accommodation for select using (is_super_admin());

-- application_answers: qual is `((NOT is_sensitive) AND is_staff())`, not
-- a bare is_staff() -- preserve the is_sensitive condition, only swap
-- the helper.
drop policy application_answers_staff_all on application_answers;
create policy application_answers_staff_all on application_answers for all using ((NOT is_sensitive) AND is_super_admin());

drop policy application_health_info_staff_all on application_health_info;
create policy application_health_info_staff_all on application_health_info for all using (is_super_admin()) with check (is_super_admin());

-- application_notes: 2 separate policies (INSERT with_check-only, SELECT
-- qual-only) -- preserve the exact same split.
drop policy application_notes_insert_staff on application_notes;
create policy application_notes_insert_staff on application_notes for insert with check (is_super_admin());

drop policy application_notes_select_staff on application_notes;
create policy application_notes_select_staff on application_notes for select using (is_super_admin());

drop policy application_status_history_select_staff on application_status_history;
create policy application_status_history_select_staff on application_status_history for select using (is_super_admin());

drop policy application_travel_info_staff_all on application_travel_info;
create policy application_travel_info_staff_all on application_travel_info for all using (is_super_admin()) with check (is_super_admin());

-- applications: 3 separate policies, preserve the exact same split.
drop policy applications_select_participant_care_staff on applications;
create policy applications_select_participant_care_staff on applications for select using (is_super_admin());

drop policy applications_select_staff on applications;
create policy applications_select_staff on applications for select using (is_super_admin());

drop policy applications_update_staff on applications;
create policy applications_update_staff on applications for update using (is_super_admin());

-- attendance_records: KEPT on is_staff() -- not touched. See the
-- attendance-domain exception list at the top of this file.

drop policy audit_logs_select_staff on audit_logs;
create policy audit_logs_select_staff on audit_logs for select using (is_super_admin());

drop policy cluster_memberships_staff_all on cluster_memberships;
create policy cluster_memberships_staff_all on cluster_memberships for all using (is_super_admin());

drop policy clustering_runs_staff_all on clustering_runs;
create policy clustering_runs_staff_all on clustering_runs for all using (is_super_admin());

drop policy clusters_staff_all on clusters;
create policy clusters_staff_all on clusters for all using (is_super_admin());

drop policy conference_days_staff_all on conference_days;
create policy conference_days_staff_all on conference_days for all using (is_super_admin());

drop policy "staff can read conference settings" on conference_settings;
create policy "staff can read conference settings" on conference_settings for select using (is_super_admin());

drop policy email_log_select_staff on email_log;
create policy email_log_select_staff on email_log for select using (is_super_admin());

drop policy "staff can read email settings" on email_settings;
create policy "staff can read email settings" on email_settings for select using (is_super_admin());

drop policy emergency_contacts_select_staff on emergency_contacts;
create policy emergency_contacts_select_staff on emergency_contacts for select using (is_super_admin());

drop policy feature_extraction_rules_staff_all on feature_extraction_rules;
create policy feature_extraction_rules_staff_all on feature_extraction_rules for all using (is_super_admin());

drop policy feature_extraction_runs_staff_all on feature_extraction_runs;
create policy feature_extraction_runs_staff_all on feature_extraction_runs for all using (is_super_admin());

drop policy import_batches_staff_all on import_batches;
create policy import_batches_staff_all on import_batches for all using (is_super_admin());

drop policy import_column_mappings_staff_all on import_column_mappings;
create policy import_column_mappings_staff_all on import_column_mappings for all using (is_super_admin());

drop policy import_mapping_templates_staff_all on import_mapping_templates;
create policy import_mapping_templates_staff_all on import_mapping_templates for all using (is_super_admin());

drop policy import_rows_staff_all on import_rows;
create policy import_rows_staff_all on import_rows for all using (is_super_admin());

drop policy "admin full access images" on local_info_images;
create policy "admin full access images" on local_info_images for all using (is_super_admin()) with check (is_super_admin());

drop policy "admin full access items" on local_info_items;
create policy "admin full access items" on local_info_items for all using (is_super_admin()) with check (is_super_admin());

drop policy "admin full access sections" on local_info_sections;
create policy "admin full access sections" on local_info_sections for all using (is_super_admin()) with check (is_super_admin());

drop policy participant_account_provisioning_staff_all on participant_account_provisioning;
create policy participant_account_provisioning_staff_all on participant_account_provisioning for all using (is_super_admin()) with check (is_super_admin());

drop policy participant_feature_snapshots_staff_all on participant_feature_snapshots;
create policy participant_feature_snapshots_staff_all on participant_feature_snapshots for all using (is_super_admin());

drop policy participant_invitations_staff_all on participant_invitations;
create policy participant_invitations_staff_all on participant_invitations for all using (is_super_admin());

drop policy people_staff_all on people;
create policy people_staff_all on people for all using (is_super_admin());

drop policy rooms_staff_all on rooms;
create policy rooms_staff_all on rooms for all using (is_super_admin());

-- scan_attempts, scanner_assignments: KEPT on is_staff() -- not touched.
-- See the attendance-domain exception list at the top of this file.

drop policy schedule_change_events_staff_all on schedule_change_events;
create policy schedule_change_events_staff_all on schedule_change_events for all using (is_super_admin());

drop policy schedule_publication_draft_items_staff_all on schedule_publication_draft_items;
create policy schedule_publication_draft_items_staff_all on schedule_publication_draft_items for all using (is_super_admin());

drop policy schedule_publication_drafts_staff_all on schedule_publication_drafts;
create policy schedule_publication_drafts_staff_all on schedule_publication_drafts for all using (is_super_admin());

-- schedule_publication_items: 2 separate policies, preserve the exact
-- same split.
drop policy schedule_publication_items_select_comms_staff on schedule_publication_items;
create policy schedule_publication_items_select_comms_staff on schedule_publication_items for select using (is_super_admin());

drop policy schedule_publication_items_staff_all on schedule_publication_items;
create policy schedule_publication_items_staff_all on schedule_publication_items for all using (is_super_admin());

-- schedule_publications: 2 separate policies, preserve the exact same
-- split.
drop policy schedule_publications_select_comms_staff on schedule_publications;
create policy schedule_publications_select_comms_staff on schedule_publications for select using (is_super_admin());

drop policy schedule_publications_staff_all on schedule_publications;
create policy schedule_publications_staff_all on schedule_publications for all using (is_super_admin());

drop policy session_bookings_select_staff on session_bookings;
create policy session_bookings_select_staff on session_bookings for select using (is_super_admin());

drop policy session_people_staff_all on session_people;
create policy session_people_staff_all on session_people for all using (is_super_admin());

drop policy session_tags_staff_all on session_tags;
create policy session_tags_staff_all on session_tags for all using (is_super_admin());

drop policy session_types_staff_all on session_types;
create policy session_types_staff_all on session_types for all using (is_super_admin());

drop policy session_waitlist_select_staff on session_waitlist;
create policy session_waitlist_select_staff on session_waitlist for select using (is_super_admin());

drop policy sessions_staff_all on sessions;
create policy sessions_staff_all on sessions for all using (is_super_admin());

drop policy tags_staff_all on tags;
create policy tags_staff_all on tags for all using (is_super_admin());

drop policy tracks_staff_all on tracks;
create policy tracks_staff_all on tracks for all using (is_super_admin());

drop policy travel_legs_select_staff on travel_legs;
create policy travel_legs_select_staff on travel_legs for select using (is_super_admin());

-- =====================================================================
-- Part 2: non-table objects -- realtime policy and storage policies
-- =====================================================================

-- ops_dashboard_broadcast_select: qual is
-- `((extension = 'broadcast') AND (realtime.topic() = 'ops-dashboard-events') AND COALESCE(is_staff(), false))`
-- -- preserve the extension/topic conditions, only swap the helper
-- (and its NULL-safe coalesce wrapper, now around is_super_admin()).
drop policy ops_dashboard_broadcast_select on realtime.messages;
create policy ops_dashboard_broadcast_select on realtime.messages
  for select using (
    (extension = 'broadcast'::text)
    and (realtime.topic() = 'ops-dashboard-events'::text)
    and coalesce(is_super_admin(), false)
  );

-- import-uploads bucket: qual/with_check both
-- `((bucket_id = 'import-uploads') AND is_staff())` -- preserve the
-- bucket_id condition, only swap the helper.
drop policy import_uploads_staff_all on storage.objects;
create policy import_uploads_staff_all on storage.objects
  for all
  using ((bucket_id = 'import-uploads'::text) and is_super_admin())
  with check ((bucket_id = 'import-uploads'::text) and is_super_admin());

-- participant-documents bucket: qual-only
-- `((bucket_id = 'participant-documents') AND is_staff())`.
drop policy participant_documents_select_staff on storage.objects;
create policy participant_documents_select_staff on storage.objects
  for select using ((bucket_id = 'participant-documents'::text) and is_super_admin());

-- =====================================================================
-- Part 3: SECURITY DEFINER function bodies referencing is_staff()
-- directly in plpgsql (not an RLS policy -- these checks run INSIDE the
-- function, which typically executes via a service-role client that
-- bypasses RLS entirely, so the function's own internal check is the
-- real authorization gate).
-- =====================================================================
--
-- These 2 functions (request_staff_qr_issuance_transactional_internal,
-- request_staff_qr_reissue_transactional_internal) and
-- rollback_import_batch_transactional are large (300-600+ lines),
-- heavily-evolved SECURITY DEFINER functions -- rollback_import_batch_
-- transactional alone has been redefined 9 times across this project's
-- migration history. Hand-retyping bodies this large and this sensitive
-- into a migration file is a real risk of introducing a transcription
-- bug in security-critical code. Instead, this migration reads each
-- function's CURRENT, LIVE definition via pg_get_functiondef (the
-- authoritative source -- not a copy-pasted/retyped version), does a
-- plain text substitution of is_staff() -> is_super_admin(), and
-- re-executes the result -- recreating the exact same function with only
-- the helper call changed, nothing else. ops_dashboard_snapshot() and
-- create_announcement() use the same technique for consistency, even
-- though both were small enough to have been hand-written safely.
--
-- admit_walk_in is deliberately excluded from this DO block's target
-- list -- it must keep calling is_staff() unchanged.
do $$
declare
  v_func text;
  v_def text;
  v_new_def text;
  v_targets text[] := array[
    'public.ops_dashboard_snapshot()',
    'public.create_announcement(text, text)',
    'public.request_staff_qr_issuance_transactional_internal(uuid, uuid, text, text, uuid, interval)',
    'public.request_staff_qr_reissue_transactional_internal(uuid, uuid, uuid, text, text, uuid, interval)',
    'public.rollback_import_batch_transactional(uuid, uuid)'
  ];
begin
  foreach v_func in array v_targets loop
    select pg_get_functiondef(v_func::regprocedure) into v_def;
    if v_def is null then
      raise exception 'Function not found: %', v_func;
    end if;
    if v_def not like '%is_staff()%' then
      raise exception 'Expected is_staff() in the current definition of % but found none -- aborting rather than silently no-op-ing', v_func;
    end if;
    v_new_def := replace(v_def, 'is_staff()', 'is_super_admin()');
    execute v_new_def;
  end loop;
end $$;
