-- add_funding_type.sql
--
-- Adds funding_type to applications: how a participant's conference
-- attendance is financed. Independent of application status
-- (admission decision) and unrelated to any allocation/admission logic —
-- purely an operational/informational field, per explicit user decision.
--
-- Visible/editable by both program_attendance_manager and
-- travel_operations_staff (plus super_admin, the universal override role),
-- not restricted to travel_operations_staff alone — unlike
-- application_travel_info, this lives directly on applications because
-- program_attendance_manager also needs to see/set it without gaining
-- access to the sensitive travel table.

create type funding_type as enum (
  'self_funded',
  'partially_funded',
  'fully_funded'
);

alter table applications add column funding_type funding_type;

------------------------------------------------------------------
-- RLS: extend applications_select_staff / applications_update_staff to
-- include program_attendance_manager and travel_operations_staff, using
-- the same drop/recreate convention as every prior extension of these
-- policies (e.g. 20260803110000_participants_communications_manager_rls.sql).
-- This grants those two roles read/write on the WHOLE applications row via
-- RLS (matching how registration_admission_manager/
-- participants_communications_manager already work), not just funding_type
-- specifically — Postgres RLS has no per-column policy. Real field-level
-- restriction stays at the application layer, same as elsewhere in this
-- schema (e.g. participants/travel's own UI only exposes travel columns
-- even though its role can technically read the full applications row via
-- this same policy).
------------------------------------------------------------------
drop policy if exists applications_select_staff on applications;
create policy applications_select_staff on applications
  for select
  using (current_user_role() in (
    'registration_admission_manager',
    'participants_communications_manager',
    'program_attendance_manager',
    'travel_operations_staff',
    'super_admin'
  ));

drop policy if exists applications_update_staff on applications;
create policy applications_update_staff on applications
  for update
  using (current_user_role() in (
    'registration_admission_manager',
    'participants_communications_manager',
    'program_attendance_manager',
    'travel_operations_staff',
    'super_admin'
  ));
