-- allocation_rls_policies.sql
alter table feature_extraction_rules enable row level security;
alter table feature_extraction_runs enable row level security;
alter table participant_feature_snapshots enable row level security;
alter table clustering_runs enable row level security;
alter table clusters enable row level security;
alter table cluster_memberships enable row level security;
alter table allocation_runs enable row level security;
alter table allocation_assignments enable row level security;
alter table allocation_alternatives enable row level security;
alter table allocation_issues enable row level security;
alter table allocation_assignment_explanations enable row level security;

-- Staff-only for all, defense-in-depth only — the operative gate for every
-- write is requireAgendaStaffCaller() in the server action, which uses the
-- service-role client (bypasses RLS entirely). Mirrors
-- supabase/migrations/20260722201600_agenda_reference_rls_policies.sql.
create policy feature_extraction_rules_staff_all on feature_extraction_rules
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy feature_extraction_runs_staff_all on feature_extraction_runs
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy participant_feature_snapshots_staff_all on participant_feature_snapshots
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy clustering_runs_staff_all on clustering_runs
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy clusters_staff_all on clusters
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy cluster_memberships_staff_all on cluster_memberships
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy allocation_runs_staff_all on allocation_runs
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy allocation_assignments_staff_all on allocation_assignments
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy allocation_alternatives_staff_all on allocation_alternatives
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy allocation_issues_staff_all on allocation_issues
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy allocation_assignment_explanations_staff_all on allocation_assignment_explanations
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
