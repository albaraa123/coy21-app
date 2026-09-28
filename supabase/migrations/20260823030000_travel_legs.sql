-- 20260823030000_travel_legs.sql
--
-- COY21 Phase 4: Arrival & Logistics Tracking (BUILD_SPEC §11).
--
-- Participants enter their own flight legs (outbound, return, connecting).
-- The Logistics team sees an arrivals dashboard sorted by arrival datetime.
-- This table is separate from application_travel_info (which stores
-- pre-event visa/passport support data) — travel_legs is purely about
-- actual flight itinerary submitted by the participant.

create type travel_leg_type as enum ('outbound', 'return', 'connecting');

create table travel_legs (
  id                  uuid primary key default gen_random_uuid(),
  application_id      uuid not null references applications(id) on delete cascade,
  leg_type            travel_leg_type not null,
  flight_number       text,
  departure_airport   text,
  arrival_airport     text,
  departure_datetime  timestamptz,
  arrival_datetime    timestamptz,
  ticket_file_url     text,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger travel_legs_set_updated_at
  before update on travel_legs
  for each row execute function extensions.moddatetime('updated_at');

create index travel_legs_application_idx on travel_legs (application_id);
create index travel_legs_arrival_idx     on travel_legs (arrival_datetime nulls last);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table travel_legs enable row level security;

-- Participants: full CRUD on their own legs
create policy travel_legs_select_own on travel_legs
  for select using (
    application_id in (select id from applications where applicant_id = auth.uid())
  );

create policy travel_legs_insert_own on travel_legs
  for insert with check (
    application_id in (select id from applications where applicant_id = auth.uid())
  );

create policy travel_legs_update_own on travel_legs
  for update using (
    application_id in (select id from applications where applicant_id = auth.uid())
  );

create policy travel_legs_delete_own on travel_legs
  for delete using (
    application_id in (select id from applications where applicant_id = auth.uid())
  );

-- Logistics staff + super_admin: read all
create policy travel_legs_select_staff on travel_legs
  for select using (
    current_user_role() in ('travel_operations_staff', 'registration_admission_manager', 'super_admin')
  );
