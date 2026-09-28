-- agenda_reference_rls_policies.sql
alter table conference_days enable row level security;
alter table tracks enable row level security;
alter table session_types enable row level security;
alter table rooms enable row level security;
alter table people enable row level security;
alter table tags enable row level security;
alter table audit_logs enable row level security;

-- Staff-only select/insert/update on every reference table. No delete policy
-- anywhere (deactivation via is_active, never a real DELETE — see spec's
-- "Deactivation of referenced entities" section). Defense-in-depth only: the
-- operative gate for writes is each server action's own role check via the
-- service-role client, which bypasses RLS entirely (see design spec, Access
-- Control section).
create policy conference_days_staff_all on conference_days
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

create policy tracks_staff_all on tracks
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

create policy session_types_staff_all on session_types
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

create policy rooms_staff_all on rooms
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

create policy people_staff_all on people
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

create policy tags_staff_all on tags
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

-- audit_logs: staff-only select. No insert/update/delete policy for any
-- client role — default-deny, matching application_status_history/email_log
-- in Phase 1. Only the service-role client (bypasses RLS) writes, and only
-- from within a server action that has already independently verified the
-- caller (see design spec, Access Control).
create policy audit_logs_select_staff on audit_logs
  for select using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
