-- application_travel_and_health_info_tables.sql
--
-- Phase A of the controlled-account-provisioning design
-- (docs/superpowers/specs/2026-07-30-controlled-account-provisioning-design.md,
-- section 3.3a — the authoritative, approved final design for this
-- migration; read it before changing anything here).
--
-- Creates two new tables holding the two sensitive-data sections that must
-- never be exposed merely because a role can read the general `applications`
-- table: travel/visa/passport/funding/accommodation-operations data, and
-- medical/allergy/accessibility/dietary/emergency-contact/participant-support
-- data. Each is a strict 1:1 extension of `applications` (application_id is
-- both the primary key and the foreign key — no surrogate id, so a
-- participant can never end up with two rows), cascading on delete exactly
-- like every other `applications`-child table in this schema
-- (application_answers, application_notes, ...).
--
-- Non-destructive: adds new tables and new nullable columns only. Does not
-- alter, drop, or rename anything on applications, application_answers, or
-- any existing RLS policy. apply_import_row_transactional is NOT modified by
-- this migration — nothing writes to these two new tables yet (deferred to
-- Phase B). Existing accepted-participant Excel imports are therefore
-- unaffected: same columns, same tables, same behavior as before this file.
--
-- No backfill: there is no pre-existing travel/health data anywhere in this
-- schema (these columns/sections never existed before this design), so both
-- tables legitimately start empty for every existing application. A
-- participant imported before this migration simply has no
-- application_travel_info/application_health_info row until Phase B's import
-- wiring (or manual entry, out of Phase A's scope) populates one.

------------------------------------------------------------------
-- 3.3: profile/allocation columns directly on applications — not sensitive,
-- already readable by admission + agenda staff today, so no new RLS
-- boundary is needed for these.
------------------------------------------------------------------
alter table applications add column gender text;
alter table applications add column whatsapp_number text;
alter table applications add column education_level text;
alter table applications add column institution_or_workplace text;
alter table applications add column linkedin_url text;
alter table applications add column primary_track text;
alter table applications add column secondary_track text;

------------------------------------------------------------------
-- application_travel_info — travel, visa, passport, funding,
-- accommodation-operations data. Readable/writable only by
-- travel_operations_staff and super_admin (plus the owning participant,
-- read-only).
------------------------------------------------------------------
create table application_travel_info (
  application_id uuid primary key references applications(id) on delete cascade,
  support_level_requested text,
  can_attend_without_full_support boolean,
  departure_airport text,
  visa_required boolean,
  invitation_letter_required boolean,
  -- Deliberately distinct from applications' profile name: this is the name
  -- exactly as printed on the passport, which may differ from how the
  -- participant is otherwise known.
  passport_full_name text,
  passport_issue_date date,
  passport_expiry_date date,
  passport_place_of_issue text,
  -- Storage bucket paths, not the files themselves — mirrors
  -- import_batches.storage_path's existing convention.
  passport_copy_storage_path text,
  visa_photo_storage_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger application_travel_info_set_updated_at
  before update on application_travel_info
  for each row execute function extensions.moddatetime('updated_at');

------------------------------------------------------------------
-- application_health_info — medical, allergy, accessibility, dietary,
-- emergency-contact, participant-support data. Readable/writable only by
-- participant_care_staff and super_admin (plus the owning participant,
-- read-only). Must never be reachable by reviewers, session managers, or
-- the allocation engine.
------------------------------------------------------------------
create table application_health_info (
  application_id uuid primary key references applications(id) on delete cascade,
  allergies text,
  medical_conditions text,
  emergency_medication text,
  accessibility_requirements text,
  dietary_requirements text,
  accommodation_preference text,
  cultural_or_religious_requirements text,
  emergency_contact_name text,
  emergency_contact_phone text,
  consent_given boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger application_health_info_set_updated_at
  before update on application_health_info
  for each row execute function extensions.moddatetime('updated_at');

------------------------------------------------------------------
-- RLS. Both `_staff_all` policies carry an explicit `with check` (not just
-- `using`) — matching the hardened pattern established by
-- 20260727000000_fix_profiles_role_privilege_escalation.sql, which found
-- that a `for all` policy relying on `using` alone for writes is a fragile
-- implicit fallback, not a documented guarantee.
--
-- current_user_role() is the existing security-definer helper
-- (20260721212035_rls_policies.sql:2-4) — reused unchanged, not
-- re-implemented.
--
-- No policy on either table references applications_select_staff or any
-- other existing admission/agenda policy: access to `applications` grants
-- zero access to either of these tables. That is the entire point of the
-- split.
------------------------------------------------------------------
alter table application_travel_info enable row level security;
alter table application_health_info enable row level security;

create policy application_travel_info_staff_all on application_travel_info
  for all
  using (current_user_role() in ('travel_operations_staff', 'super_admin'))
  with check (current_user_role() in ('travel_operations_staff', 'super_admin'));

create policy application_health_info_staff_all on application_health_info
  for all
  using (current_user_role() in ('participant_care_staff', 'super_admin'))
  with check (current_user_role() in ('participant_care_staff', 'super_admin'));

-- Participants may read (never write, in Phase A) their own row. These are
-- import-sourced operational fields, not self-service profile fields, so no
-- participant update/insert/delete policy exists here.
create policy application_travel_info_select_own on application_travel_info
  for select
  using (application_id in (select id from applications where applicant_id = auth.uid()));

create policy application_health_info_select_own on application_health_info
  for select
  using (application_id in (select id from applications where applicant_id = auth.uid()));
