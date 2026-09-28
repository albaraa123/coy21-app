-- import_rls_policies.sql
alter table import_batches enable row level security;
alter table import_column_mappings enable row level security;
alter table import_rows enable row level security;
alter table import_mapping_templates enable row level security;
alter table application_answers enable row level security;
alter table participant_invitations enable row level security;

-- Staff-only tables: no participant ever has a legitimate reason to read
-- these. Default-deny (no participant policy) covers every operation for
-- the participant role automatically. Mirrors
-- schedule_change_events_staff_all / schedule_publication_drafts_staff_all.
create policy import_batches_staff_all on import_batches
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy import_column_mappings_staff_all on import_column_mappings
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy import_rows_staff_all on import_rows
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy import_mapping_templates_staff_all on import_mapping_templates
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy participant_invitations_staff_all on participant_invitations
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

-- application_answers: two-tier. Ordinary (non-sensitive) answers are
-- readable/writable by import-capable staff for allocation review.
-- Sensitive answers (accessibility/dietary/emergency-contact/special-needs)
-- are super_admin only — narrower than ordinary answers.
create policy application_answers_staff_all on application_answers
  for all using (
    not is_sensitive and current_user_role() in ('agenda_allocation_manager', 'super_admin')
  );
create policy application_answers_sensitive_staff_all on application_answers
  for all using (is_sensitive and current_user_role() = 'super_admin');

-- Participant self-read: own application's non-sensitive answers only,
-- select-only. Symmetric with applications_select_own. Because applicant_id
-- is null until claim, applications.applicant_id = auth.uid() cannot match
-- any authenticated session for an unclaimed row — this is what makes
-- unclaimed imported answers unreadable by anyone but staff, with zero new
-- RLS logic beyond this existing pattern.
create policy application_answers_select_own on application_answers
  for select using (
    not is_sensitive
    and application_id in (select id from applications where applicant_id = auth.uid())
  );
