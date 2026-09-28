-- security definer helper: reads the caller's role without re-entering RLS on profiles
create function current_user_role() returns user_role as $$
  select role from profiles where id = auth.uid();
$$ language sql stable security definer set search_path = public;

alter table profiles enable row level security;
alter table applications enable row level security;
alter table application_status_history enable row level security;
alter table email_log enable row level security;

-- profiles: read/update own row; super_admin reads/updates all; no client insert (trigger-only)
create policy profiles_select_own on profiles
  for select using (id = auth.uid());

create policy profiles_select_super_admin on profiles
  for select using (current_user_role() = 'super_admin');

create policy profiles_update_own on profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

create policy profiles_update_super_admin on profiles
  for update using (current_user_role() = 'super_admin');

-- applications: applicant can select/delete own row anytime; insert own draft; update own draft only
create policy applications_select_own on applications
  for select using (applicant_id = auth.uid());

create policy applications_select_staff on applications
  for select using (current_user_role() in ('registration_admission_manager', 'super_admin'));

create policy applications_insert_own_draft on applications
  for insert with check (applicant_id = auth.uid() and status = 'draft');

create policy applications_update_own_draft on applications
  for update
  using (applicant_id = auth.uid() and status = 'draft')
  with check (applicant_id = auth.uid() and status = 'draft');

create policy applications_delete_own_draft on applications
  for delete using (applicant_id = auth.uid() and status = 'draft');

-- application_status_history / email_log: no client insert policies at all (default-deny);
-- only the service role (which bypasses RLS) writes these. Select is staff-only.
create policy application_status_history_select_staff on application_status_history
  for select using (current_user_role() in ('registration_admission_manager', 'super_admin'));

create policy email_log_select_staff on email_log
  for select using (current_user_role() in ('registration_admission_manager', 'super_admin'));
