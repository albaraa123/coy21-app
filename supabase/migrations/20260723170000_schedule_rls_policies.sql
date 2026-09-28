-- schedule_rls_policies.sql
alter table schedule_publications enable row level security;
alter table schedule_publication_items enable row level security;
alter table schedule_change_events enable row level security;
alter table schedule_publication_drafts enable row level security;
alter table schedule_publication_draft_items enable row level security;

-- Staff-only, defense-in-depth (operative gate is requireAgendaStaffCaller()
-- via the service-role client in every server action).
create policy schedule_change_events_staff_all on schedule_change_events
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy schedule_publication_drafts_staff_all on schedule_publication_drafts
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy schedule_publication_draft_items_staff_all on schedule_publication_draft_items
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

-- Self-scoped select for the participant, plus full staff access. No
-- insert/update/delete policy grants a participant write access to either
-- table — _select_own is select-only, and default-deny covers every other
-- operation, so a participant cannot select, remove, swap, or modify
-- anything (spec rule 5).
create policy schedule_publications_select_own on schedule_publications
  for select using (application_id in (select id from applications where applicant_id = auth.uid()));
create policy schedule_publications_staff_all on schedule_publications
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

create policy schedule_publication_items_select_own on schedule_publication_items
  for select using (
    schedule_publication_id in (
      select id from schedule_publications
      where application_id in (select id from applications where applicant_id = auth.uid())
    )
  );
create policy schedule_publication_items_staff_all on schedule_publication_items
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
