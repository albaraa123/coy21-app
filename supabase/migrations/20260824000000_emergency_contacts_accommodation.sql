-- 20260824000000_emergency_contacts_accommodation.sql
--
-- COY21 §12: Emergency Contacts and Accommodation details,
-- per the Extended Participant Profile spec.

-- ---------------------------------------------------------------------------
-- 1. emergency_contacts
--    One or more emergency contacts per application.
--    Participants manage their own; staff/ops read all.
-- ---------------------------------------------------------------------------

create table emergency_contacts (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  name           text not null,
  relationship   text not null,
  phone          text not null,
  email          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger emergency_contacts_set_updated_at
  before update on emergency_contacts
  for each row execute function extensions.moddatetime('updated_at');

create index emergency_contacts_application_idx on emergency_contacts (application_id);

alter table emergency_contacts enable row level security;

-- Participants manage their own
create policy emergency_contacts_select_own on emergency_contacts
  for select using (
    application_id in (select id from applications where applicant_id = auth.uid())
  );
create policy emergency_contacts_insert_own on emergency_contacts
  for insert with check (
    application_id in (select id from applications where applicant_id = auth.uid())
  );
create policy emergency_contacts_update_own on emergency_contacts
  for update using (
    application_id in (select id from applications where applicant_id = auth.uid())
  );
create policy emergency_contacts_delete_own on emergency_contacts
  for delete using (
    application_id in (select id from applications where applicant_id = auth.uid())
  );

-- Staff reads all (registration_admission_manager + super_admin)
create policy emergency_contacts_select_staff on emergency_contacts
  for select using (
    current_user_role() in ('registration_admission_manager', 'super_admin')
  );

-- ---------------------------------------------------------------------------
-- 2. application_accommodation
--    One row per application (upsert pattern).
--    Hotel name, location note, room number — for Logistics planning.
-- ---------------------------------------------------------------------------

create table application_accommodation (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references applications(id) on delete cascade,
  hotel_name     text,
  location_note  text,
  room_number    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger application_accommodation_set_updated_at
  before update on application_accommodation
  for each row execute function extensions.moddatetime('updated_at');

alter table application_accommodation enable row level security;

-- Participants manage their own
create policy accommodation_select_own on application_accommodation
  for select using (
    application_id in (select id from applications where applicant_id = auth.uid())
  );
create policy accommodation_insert_own on application_accommodation
  for insert with check (
    application_id in (select id from applications where applicant_id = auth.uid())
  );
create policy accommodation_update_own on application_accommodation
  for update using (
    application_id in (select id from applications where applicant_id = auth.uid())
  );

-- Staff reads all
create policy accommodation_select_staff on application_accommodation
  for select using (
    current_user_role() in (
      'registration_admission_manager',
      'travel_operations_staff',
      'super_admin'
    )
  );
