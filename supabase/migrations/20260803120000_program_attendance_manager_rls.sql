-- program_attendance_manager_rls.sql
--
-- Grants the new program_attendance_manager role the same RLS access as
-- agenda_allocation_manager, matching its responsibilities exactly:
-- conference days, tracks, session types, sessions, rooms, people
-- (speakers/moderators/facilitators/trainers), feature extraction,
-- clustering, allocation (automatic + manual override), and schedule
-- confirmation/publication. Each policy is dropped and recreated with the
-- new role added — Postgres has no "alter policy ... add role".
--
-- Deliberately NOT touched: participant account creation/provisioning,
-- login-details email sending, import pipeline (participants_communications_
-- manager's domain), application_travel_info, application_health_info (must
-- remain super_admin/travel_operations_staff/participant_care_staff only —
-- explicit "denied access" for this role), and staff/role management tables
-- (profiles role-management stays super_admin only).

-- Agenda reference tables.
drop policy if exists conference_days_staff_all on conference_days;
create policy conference_days_staff_all on conference_days
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists tracks_staff_all on tracks;
create policy tracks_staff_all on tracks
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists session_types_staff_all on session_types;
create policy session_types_staff_all on session_types
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists rooms_staff_all on rooms;
create policy rooms_staff_all on rooms
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists people_staff_all on people;
create policy people_staff_all on people
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists tags_staff_all on tags;
create policy tags_staff_all on tags
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists audit_logs_select_staff on audit_logs;
create policy audit_logs_select_staff on audit_logs
  for select using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

-- Sessions.
drop policy if exists sessions_staff_all on sessions;
create policy sessions_staff_all on sessions
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists session_people_staff_all on session_people;
create policy session_people_staff_all on session_people
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists session_tags_staff_all on session_tags;
create policy session_tags_staff_all on session_tags
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

-- Feature extraction, clustering, allocation.
drop policy if exists feature_extraction_rules_staff_all on feature_extraction_rules;
create policy feature_extraction_rules_staff_all on feature_extraction_rules
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists feature_extraction_runs_staff_all on feature_extraction_runs;
create policy feature_extraction_runs_staff_all on feature_extraction_runs
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists participant_feature_snapshots_staff_all on participant_feature_snapshots;
create policy participant_feature_snapshots_staff_all on participant_feature_snapshots
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists clustering_runs_staff_all on clustering_runs;
create policy clustering_runs_staff_all on clustering_runs
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists clusters_staff_all on clusters;
create policy clusters_staff_all on clusters
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists cluster_memberships_staff_all on cluster_memberships;
create policy cluster_memberships_staff_all on cluster_memberships
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists allocation_runs_staff_all on allocation_runs;
create policy allocation_runs_staff_all on allocation_runs
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists allocation_assignments_staff_all on allocation_assignments;
create policy allocation_assignments_staff_all on allocation_assignments
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists allocation_alternatives_staff_all on allocation_alternatives;
create policy allocation_alternatives_staff_all on allocation_alternatives
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists allocation_issues_staff_all on allocation_issues;
create policy allocation_issues_staff_all on allocation_issues
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists allocation_assignment_explanations_staff_all on allocation_assignment_explanations;
create policy allocation_assignment_explanations_staff_all on allocation_assignment_explanations
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

-- Schedule publication.
drop policy if exists schedule_change_events_staff_all on schedule_change_events;
create policy schedule_change_events_staff_all on schedule_change_events
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists schedule_publication_drafts_staff_all on schedule_publication_drafts;
create policy schedule_publication_drafts_staff_all on schedule_publication_drafts
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists schedule_publication_draft_items_staff_all on schedule_publication_draft_items;
create policy schedule_publication_draft_items_staff_all on schedule_publication_draft_items
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists schedule_publications_staff_all on schedule_publications;
create policy schedule_publications_staff_all on schedule_publications
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists schedule_publication_items_staff_all on schedule_publication_items;
create policy schedule_publication_items_staff_all on schedule_publication_items
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

-- Import tables: program_attendance_manager needs READ access to see which
-- applications exist for allocation purposes (feature extraction reads
-- applications/application_answers), but NOT full import-management access
-- (upload/map/confirm/rollback stays participants_communications_manager +
-- agenda_allocation_manager only, per this role's explicit denied-access
-- list: "participant account creation" is denied, and import management is
-- a participants_communications_manager responsibility, not this role's).
-- applications/application_answers (non-sensitive) already grant
-- agenda_allocation_manager select via existing policies from Phase 1/5 —
-- confirmed via applications_select_staff and application_answers_staff_all
-- already including agenda_allocation_manager, so no change needed there.
