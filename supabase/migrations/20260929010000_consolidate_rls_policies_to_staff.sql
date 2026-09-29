-- 20260929010000_consolidate_rls_policies_to_staff.sql
--
-- Part 3 of the staff role consolidation. Replaces every RLS policy that
-- enumerates one or more of the 7 deprecated staff-domain roles
-- (registration_admission_manager, agenda_allocation_manager,
-- communications_attendance_manager, travel_operations_staff,
-- participant_care_staff, participants_communications_manager,
-- program_attendance_manager) with a single is_staff() check (added in
-- 20260929000001). Each policy is dropped and recreated with the SAME name
-- and table — this must be a like-for-like structural replacement, not a
-- new policy, so nothing else about each table's RLS surface changes.
--
-- Only the CURRENT (latest) definition of each policy is targeted here —
-- several policies were themselves dropped and recreated multiple times
-- across earlier migrations as new roles were folded in (e.g.
-- applications_select_staff was last redefined in
-- 20260820100000_add_funding_type.sql); this migration supersedes that
-- latest version, not every historical one.
--
-- application_answers_sensitive_staff_all is deliberately NOT touched here:
-- it is super_admin-only (current_user_role() = 'super_admin'), it never
-- referenced any of the 7 deprecated staff-domain roles, and is_staff()
-- would incorrectly widen it to include plain 'staff' — out of scope for
-- this task.

------------------------------------------------------------------
-- applications
------------------------------------------------------------------
drop policy if exists applications_select_staff on applications;
create policy applications_select_staff on applications
  for select using (is_staff());

drop policy if exists applications_update_staff on applications;
create policy applications_update_staff on applications
  for update using (is_staff());

drop policy if exists applications_select_participant_care_staff on applications;
create policy applications_select_participant_care_staff on applications
  for select using (is_staff());

------------------------------------------------------------------
-- application_status_history / email_log / application_notes
------------------------------------------------------------------
drop policy if exists application_status_history_select_staff on application_status_history;
create policy application_status_history_select_staff on application_status_history
  for select using (is_staff());

drop policy if exists email_log_select_staff on email_log;
create policy email_log_select_staff on email_log
  for select using (is_staff());

drop policy if exists application_notes_select_staff on application_notes;
create policy application_notes_select_staff on application_notes
  for select using (is_staff());

drop policy if exists application_notes_insert_staff on application_notes;
create policy application_notes_insert_staff on application_notes
  for insert with check (is_staff());

------------------------------------------------------------------
-- Agenda reference tables (conference_days, tracks, session_types, rooms,
-- people, tags, audit_logs)
------------------------------------------------------------------
drop policy if exists conference_days_staff_all on conference_days;
create policy conference_days_staff_all on conference_days
  for all using (is_staff());

drop policy if exists tracks_staff_all on tracks;
create policy tracks_staff_all on tracks
  for all using (is_staff());

drop policy if exists session_types_staff_all on session_types;
create policy session_types_staff_all on session_types
  for all using (is_staff());

drop policy if exists rooms_staff_all on rooms;
create policy rooms_staff_all on rooms
  for all using (is_staff());

drop policy if exists people_staff_all on people;
create policy people_staff_all on people
  for all using (is_staff());

drop policy if exists tags_staff_all on tags;
create policy tags_staff_all on tags
  for all using (is_staff());

drop policy if exists audit_logs_select_staff on audit_logs;
create policy audit_logs_select_staff on audit_logs
  for select using (is_staff());

------------------------------------------------------------------
-- Sessions
------------------------------------------------------------------
drop policy if exists sessions_staff_all on sessions;
create policy sessions_staff_all on sessions
  for all using (is_staff());

drop policy if exists session_people_staff_all on session_people;
create policy session_people_staff_all on session_people
  for all using (is_staff());

drop policy if exists session_tags_staff_all on session_tags;
create policy session_tags_staff_all on session_tags
  for all using (is_staff());

------------------------------------------------------------------
-- Feature extraction, clustering, allocation
------------------------------------------------------------------
drop policy if exists feature_extraction_rules_staff_all on feature_extraction_rules;
create policy feature_extraction_rules_staff_all on feature_extraction_rules
  for all using (is_staff());

drop policy if exists feature_extraction_runs_staff_all on feature_extraction_runs;
create policy feature_extraction_runs_staff_all on feature_extraction_runs
  for all using (is_staff());

drop policy if exists participant_feature_snapshots_staff_all on participant_feature_snapshots;
create policy participant_feature_snapshots_staff_all on participant_feature_snapshots
  for all using (is_staff());

drop policy if exists clustering_runs_staff_all on clustering_runs;
create policy clustering_runs_staff_all on clustering_runs
  for all using (is_staff());

drop policy if exists clusters_staff_all on clusters;
create policy clusters_staff_all on clusters
  for all using (is_staff());

drop policy if exists cluster_memberships_staff_all on cluster_memberships;
create policy cluster_memberships_staff_all on cluster_memberships
  for all using (is_staff());

drop policy if exists allocation_runs_staff_all on allocation_runs;
create policy allocation_runs_staff_all on allocation_runs
  for all using (is_staff());

drop policy if exists allocation_assignments_staff_all on allocation_assignments;
create policy allocation_assignments_staff_all on allocation_assignments
  for all using (is_staff());

drop policy if exists allocation_alternatives_staff_all on allocation_alternatives;
create policy allocation_alternatives_staff_all on allocation_alternatives
  for all using (is_staff());

drop policy if exists allocation_issues_staff_all on allocation_issues;
create policy allocation_issues_staff_all on allocation_issues
  for all using (is_staff());

drop policy if exists allocation_assignment_explanations_staff_all on allocation_assignment_explanations;
create policy allocation_assignment_explanations_staff_all on allocation_assignment_explanations
  for all using (is_staff());

------------------------------------------------------------------
-- Schedule publication
------------------------------------------------------------------
drop policy if exists schedule_change_events_staff_all on schedule_change_events;
create policy schedule_change_events_staff_all on schedule_change_events
  for all using (is_staff());

drop policy if exists schedule_publication_drafts_staff_all on schedule_publication_drafts;
create policy schedule_publication_drafts_staff_all on schedule_publication_drafts
  for all using (is_staff());

drop policy if exists schedule_publication_draft_items_staff_all on schedule_publication_draft_items;
create policy schedule_publication_draft_items_staff_all on schedule_publication_draft_items
  for all using (is_staff());

drop policy if exists schedule_publications_staff_all on schedule_publications;
create policy schedule_publications_staff_all on schedule_publications
  for all using (is_staff());

drop policy if exists schedule_publication_items_staff_all on schedule_publication_items;
create policy schedule_publication_items_staff_all on schedule_publication_items
  for all using (is_staff());

-- Read-only communications-staff visibility, previously scoped to the
-- single participants_communications_manager role.
drop policy if exists schedule_publications_select_comms_staff on schedule_publications;
create policy schedule_publications_select_comms_staff on schedule_publications
  for select using (is_staff());

drop policy if exists schedule_publication_items_select_comms_staff on schedule_publication_items;
create policy schedule_publication_items_select_comms_staff on schedule_publication_items
  for select using (is_staff());

------------------------------------------------------------------
-- Import pipeline
------------------------------------------------------------------
drop policy if exists import_batches_staff_all on import_batches;
create policy import_batches_staff_all on import_batches
  for all using (is_staff());

drop policy if exists import_column_mappings_staff_all on import_column_mappings;
create policy import_column_mappings_staff_all on import_column_mappings
  for all using (is_staff());

drop policy if exists import_rows_staff_all on import_rows;
create policy import_rows_staff_all on import_rows
  for all using (is_staff());

drop policy if exists import_mapping_templates_staff_all on import_mapping_templates;
create policy import_mapping_templates_staff_all on import_mapping_templates
  for all using (is_staff());

drop policy if exists participant_invitations_staff_all on participant_invitations;
create policy participant_invitations_staff_all on participant_invitations
  for all using (is_staff());

-- application_answers: non-sensitive-only staff policy. The additional
-- `not is_sensitive` condition is preserved unchanged; only the
-- role-comparison portion is replaced. application_answers_sensitive_staff_all
-- (super_admin-only) is intentionally left untouched — see file header.
drop policy if exists application_answers_staff_all on application_answers;
create policy application_answers_staff_all on application_answers
  for all using (not is_sensitive and is_staff());

------------------------------------------------------------------
-- import-uploads storage bucket (storage.objects)
------------------------------------------------------------------
drop policy if exists import_uploads_staff_all on storage.objects;
create policy import_uploads_staff_all on storage.objects
  for all using (bucket_id = 'import-uploads' and is_staff())
  with check (bucket_id = 'import-uploads' and is_staff());

------------------------------------------------------------------
-- application_travel_info / application_health_info
------------------------------------------------------------------
drop policy if exists application_travel_info_staff_all on application_travel_info;
create policy application_travel_info_staff_all on application_travel_info
  for all
  using (is_staff())
  with check (is_staff());

drop policy if exists application_health_info_staff_all on application_health_info;
create policy application_health_info_staff_all on application_health_info
  for all
  using (is_staff())
  with check (is_staff());

------------------------------------------------------------------
-- participant_account_provisioning
------------------------------------------------------------------
drop policy if exists participant_account_provisioning_staff_all on participant_account_provisioning;
create policy participant_account_provisioning_staff_all on participant_account_provisioning
  for all
  using (is_staff())
  with check (is_staff());

------------------------------------------------------------------
-- Attendance (attendance_records, scan_attempts, scanner_assignments)
------------------------------------------------------------------
drop policy if exists attendance_records_manager_all on attendance_records;
create policy attendance_records_manager_all on attendance_records
  for all using (is_staff());

drop policy if exists scan_attempts_manager_all on scan_attempts;
create policy scan_attempts_manager_all on scan_attempts
  for all using (is_staff());

drop policy if exists scanner_assignments_manager_all on scanner_assignments;
create policy scanner_assignments_manager_all on scanner_assignments
  for all using (is_staff());

------------------------------------------------------------------
-- participant-documents storage bucket (storage.objects)
------------------------------------------------------------------
drop policy if exists "participant_documents_select_staff" on storage.objects;
create policy "participant_documents_select_staff"
  on storage.objects for select
  using (
    bucket_id = 'participant-documents'
    and is_staff()
  );

------------------------------------------------------------------
-- session_bookings / travel_legs / emergency_contacts / application_accommodation
------------------------------------------------------------------
drop policy if exists session_bookings_select_staff on session_bookings;
create policy session_bookings_select_staff on session_bookings
  for select using (is_staff());

drop policy if exists travel_legs_select_staff on travel_legs;
create policy travel_legs_select_staff on travel_legs
  for select using (is_staff());

drop policy if exists emergency_contacts_select_staff on emergency_contacts;
create policy emergency_contacts_select_staff on emergency_contacts
  for select using (is_staff());

drop policy if exists accommodation_select_staff on application_accommodation;
create policy accommodation_select_staff on application_accommodation
  for select using (is_staff());

------------------------------------------------------------------
-- Local Info Hub (local_info_sections, local_info_items, local_info_images)
------------------------------------------------------------------
drop policy if exists "admin full access sections" on local_info_sections;
create policy "admin full access sections"
  on local_info_sections for all
  using (is_staff())
  with check (is_staff());

drop policy if exists "admin full access items" on local_info_items;
create policy "admin full access items"
  on local_info_items for all
  using (is_staff())
  with check (is_staff());

drop policy if exists "admin full access images" on local_info_images;
create policy "admin full access images"
  on local_info_images for all
  using (is_staff())
  with check (is_staff());
