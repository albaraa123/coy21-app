-- sessions_rls_policies.sql
alter table sessions enable row level security;
alter table session_people enable row level security;
alter table session_tags enable row level security;

create policy sessions_staff_all on sessions
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

create policy session_people_staff_all on session_people
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

create policy session_tags_staff_all on session_tags
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
