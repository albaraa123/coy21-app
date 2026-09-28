-- participants_communications_manager_rls.sql
--
-- Grants the new participants_communications_manager role RLS access to
-- exactly the tables its responsibilities cover: accepted-participant Excel
-- import (mapping/validation/preview/confirm/retry/rollback), participant
-- profile management, participant account provisioning, and non-sensitive
-- application answers used for communications. Each policy below is
-- dropped and recreated with the new role added to an existing
-- registration_admission_manager or agenda_allocation_manager policy —
-- Postgres has no "alter policy ... add role" for a USING-clause role list,
-- so recreation is the only way to extend one.
--
-- Deliberately NOT touched: application_answers_sensitive_staff_all
-- (stays super_admin only), application_travel_info, application_health_info
-- (no policy added for this role at all — must remain
-- super_admin/travel_operations_staff/participant_care_staff only, per the
-- explicit "denied access" list for this role), and every agenda/allocation/
-- schedule-publication table (program_attendance_manager's domain, not
-- this role's).

-- applications: staff select + status/reviewer update.
drop policy if exists applications_select_staff on applications;
create policy applications_select_staff on applications
  for select using (current_user_role() in ('registration_admission_manager', 'participants_communications_manager', 'super_admin'));

drop policy if exists applications_update_staff on applications;
create policy applications_update_staff on applications
  for update using (current_user_role() in ('registration_admission_manager', 'participants_communications_manager', 'super_admin'));

-- application_status_history, email_log: staff select (audit trail).
drop policy if exists application_status_history_select_staff on application_status_history;
create policy application_status_history_select_staff on application_status_history
  for select using (current_user_role() in ('registration_admission_manager', 'participants_communications_manager', 'super_admin'));

drop policy if exists email_log_select_staff on email_log;
create policy email_log_select_staff on email_log
  for select using (current_user_role() in ('registration_admission_manager', 'participants_communications_manager', 'super_admin'));

-- application_notes: staff select + insert.
drop policy if exists application_notes_select_staff on application_notes;
create policy application_notes_select_staff on application_notes
  for select using (current_user_role() in ('registration_admission_manager', 'participants_communications_manager', 'super_admin'));

drop policy if exists application_notes_insert_staff on application_notes;
create policy application_notes_insert_staff on application_notes
  for insert with check (current_user_role() in ('registration_admission_manager', 'participants_communications_manager', 'super_admin'));

-- participant_account_provisioning: the account-provisioning table itself.
drop policy if exists participant_account_provisioning_staff_all on participant_account_provisioning;
create policy participant_account_provisioning_staff_all on participant_account_provisioning
  for all
  using (current_user_role() in ('registration_admission_manager', 'participants_communications_manager', 'super_admin'))
  with check (current_user_role() in ('registration_admission_manager', 'participants_communications_manager', 'super_admin'));

-- Import pipeline tables (previously agenda_allocation_manager-only).
drop policy if exists import_batches_staff_all on import_batches;
create policy import_batches_staff_all on import_batches
  for all using (current_user_role() in ('agenda_allocation_manager', 'participants_communications_manager', 'super_admin'));

drop policy if exists import_column_mappings_staff_all on import_column_mappings;
create policy import_column_mappings_staff_all on import_column_mappings
  for all using (current_user_role() in ('agenda_allocation_manager', 'participants_communications_manager', 'super_admin'));

drop policy if exists import_rows_staff_all on import_rows;
create policy import_rows_staff_all on import_rows
  for all using (current_user_role() in ('agenda_allocation_manager', 'participants_communications_manager', 'super_admin'));

drop policy if exists import_mapping_templates_staff_all on import_mapping_templates;
create policy import_mapping_templates_staff_all on import_mapping_templates
  for all using (current_user_role() in ('agenda_allocation_manager', 'participants_communications_manager', 'super_admin'));

drop policy if exists participant_invitations_staff_all on participant_invitations;
create policy participant_invitations_staff_all on participant_invitations
  for all using (current_user_role() in ('agenda_allocation_manager', 'participants_communications_manager', 'super_admin'));

-- application_answers: non-sensitive only. The sensitive-answers policy
-- (application_answers_sensitive_staff_all) is intentionally NOT modified —
-- stays super_admin-only.
drop policy if exists application_answers_staff_all on application_answers;
create policy application_answers_staff_all on application_answers
  for all using (
    not is_sensitive and current_user_role() in ('agenda_allocation_manager', 'participants_communications_manager', 'super_admin')
  );

-- schedule_publications / schedule_publication_items: read-only visibility
-- for communications purposes (this role must be able to view a published
-- participant schedule when reaching out, but has no allocation/publication
-- authority). The existing schedule_publications_staff_all /
-- schedule_publication_items_staff_all policies (agenda_allocation_manager,
-- super_admin) are FULL access (for all) and deliberately left untouched —
-- this role instead gets its own new, additional, SELECT-ONLY policy rather
-- than being folded into the full-access one. Does NOT touch
-- schedule_change_events, schedule_publication_drafts, or
-- schedule_publication_draft_items — those stay
-- agenda_allocation_manager/program_attendance_manager (pre-publication
-- workflow) only.
create policy schedule_publications_select_comms_staff on schedule_publications
  for select using (current_user_role() = 'participants_communications_manager');

create policy schedule_publication_items_select_comms_staff on schedule_publication_items
  for select using (current_user_role() = 'participants_communications_manager');
