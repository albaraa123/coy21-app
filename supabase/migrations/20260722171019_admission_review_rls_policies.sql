-- Staff can update status and reviewer assignment on any application. No WITH
-- CHECK: staff are a trusted role with legitimate latitude to set any valid
-- status (validated by the server action, not RLS) — same reasoning as
-- profiles_update_super_admin's WITH CHECK-less policy from Phase 1. This
-- policy is defense-in-depth; the server actions that actually perform these
-- writes use the service-role client and are gated by their own role check.
create policy applications_update_staff on applications
  for update using (current_user_role() in ('registration_admission_manager', 'super_admin'));

-- application_notes was created without RLS enabled (Task 1). Enable it here
-- so the policies below actually take effect.
alter table application_notes enable row level security;

-- application_notes: staff can read and (defense-in-depth) insert. No
-- UPDATE/DELETE policy — no edit/delete UI in this phase, matches Phase 1's
-- default-deny pattern for application_status_history/email_log.
create policy application_notes_select_staff on application_notes
  for select using (current_user_role() in ('registration_admission_manager', 'super_admin'));

create policy application_notes_insert_staff on application_notes
  for insert with check (current_user_role() in ('registration_admission_manager', 'super_admin'));
