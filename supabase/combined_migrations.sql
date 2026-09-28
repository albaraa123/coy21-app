-- ============================================================
-- COY21 Combined Migrations — 118 files
-- Generated: 2026-08-22 20:17
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- Create migration tracking schema/table
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
    version text NOT NULL PRIMARY KEY,
    inserted_at timestamptz NOT NULL DEFAULT now(),
    statements text[] DEFAULT NULL
);


-- ============================================================
-- Migration: 20260721200747_roles_and_profiles.sql
-- ============================================================
-- roles_and_profiles.sql
create type user_role as enum (
  'participant',
  'super_admin',
  'registration_admission_manager',
  'agenda_allocation_manager',
  'communications_attendance_manager'
);

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role user_role not null default 'participant',
  full_name text not null,
  email text not null,
  created_at timestamptz not null default now()
);

create function handle_new_user() returns trigger as $$
begin
  insert into profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), new.email);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260721200747_roles_and_profiles')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260721201242_fix_handle_new_user_search_path.sql
-- ============================================================
-- fix_handle_new_user_search_path.sql
--
-- The handle_new_user() trigger function is SECURITY DEFINER (owned by
-- postgres) but did not pin its own search_path. Postgres functions use
-- the CALLER's search_path unless one is explicitly set on the function.
-- The auth.users insert that fires this trigger is executed by the
-- supabase_auth_admin role, whose search_path is set to `auth` only (no
-- `public`). As a result the unqualified `profiles` reference inside the
-- function failed to resolve, the insert into profiles raised an error,
-- and the entire auth.users insert transaction rolled back — signup
-- failed with "Database error creating new user".
--
-- Fix: pin search_path = public, pg_temp on the function so profiles
-- always resolves regardless of the caller's search_path. pg_temp is
-- included per Postgres/Supabase security-definer best practice to
-- prevent search_path hijacking via temporary objects.
alter function handle_new_user() set search_path = public, pg_temp;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260721201242_fix_handle_new_user_search_path')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260721202027_applications_table.sql
-- ============================================================
-- applications_table.sql
create type application_status as enum (
  'draft',
  'submitted',
  'under_review',
  'accepted',
  'waitlisted',
  'rejected',
  'withdrawn'
);

create sequence application_number_seq start 1;

create extension if not exists moddatetime schema extensions;

create table applications (
  id uuid primary key default gen_random_uuid(),
  applicant_id uuid not null references profiles(id) on delete cascade,
  application_number text unique,
  status application_status not null default 'draft',

  -- Personal information. These are captured on the application (not read from
  -- profiles) because a submitted application is a point-in-time record: profile
  -- data can change after submission without altering what was actually submitted.
  phone text,
  country text,
  nationality text,
  birth_date date,
  age_group text, -- one of: 'under_18' | '18_24' | '25_34' | '35_44' | '45_plus'
  city text,
  organization text,
  field_of_work text,
  preferred_language text, -- one of: 'ar' | 'en'

  -- Conference-related information. Free text / arrays, captured for later manual
  -- review and (in a future phase) clustering input; no value-domain constraints
  -- are enforced in Phase 1 beyond required/optional (see registration form spec).
  interests text[],
  climate_experience text,
  experience_level text, -- one of: 'none' | 'beginner' | 'intermediate' | 'expert'
  past_initiatives text,
  participation_goals text,
  topics_to_learn text,
  content_type_pref text,
  track_interests text[],
  priority_sessions text,
  special_needs text,

  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One application per account. Applicant's name/email come from `profiles`
-- (via applicant_id), which is authoritative for account identity and display.
create unique index applications_one_per_applicant on applications (applicant_id);

create trigger applications_set_updated_at
  before update on applications
  for each row execute function extensions.moddatetime('updated_at');


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260721202027_applications_table')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260721210419_status_history_and_email_log.sql
-- ============================================================
-- status_history_and_email_log.sql
create table application_status_history (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  old_status application_status,
  new_status application_status not null,
  changed_by uuid references profiles(id),
  note text,
  created_at timestamptz not null default now()
);

create table email_log (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id) on delete cascade,
  template text not null,
  status text not null,
  sent_at timestamptz not null default now()
);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260721210419_status_history_and_email_log')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260721212035_rls_policies.sql
-- ============================================================
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


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260721212035_rls_policies')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260721213243_fix_current_user_role_search_path.sql
-- ============================================================
-- Align current_user_role() with the same security-definer search_path hardening
-- applied to handle_new_user() in 20260721201242_fix_handle_new_user_search_path.sql:
-- pg_temp is included explicitly to prevent search_path hijacking via temporary
-- objects, per Postgres/Supabase security-definer best practice.
alter function current_user_role() set search_path = public, pg_temp;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260721213243_fix_current_user_role_search_path')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260722123016_application_number_function.sql
-- ============================================================
-- application_number_function.sql
-- Sequence-backed application number generator. Wrapping nextval() in a SQL
-- function lets the server action call it via rpc() and get an atomic,
-- race-free increment (a count(*)-based scheme would race under concurrent
-- submits).
create function next_application_number() returns text as $$
  select 'RCOY-2026-' || lpad(nextval('application_number_seq')::text, 5, '0');
$$ language sql;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260722123016_application_number_function')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260722170415_assigned_reviewer_and_notes.sql
-- ============================================================
-- One reviewer assignment per application. References profiles (not a separate
-- reviewers table) since any registration_admission_manager can be assigned.
alter table applications add column assigned_reviewer_id uuid references profiles(id);

create index applications_status_idx on applications (status);
create index applications_assigned_reviewer_idx on applications (assigned_reviewer_id);

-- Internal review notes. Deliberately separate from application_status_history:
-- notes are free-form, staff-authored commentary (append-only in this phase, no
-- edit/delete UI); application_status_history is the fixed-shape status-transition
-- audit log from Phase 1 and is not modified by this migration.
create table application_notes (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  author_id uuid not null references profiles(id),
  body text not null,
  created_at timestamptz not null default now()
);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260722170415_assigned_reviewer_and_notes')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260722171019_admission_review_rls_policies.sql
-- ============================================================
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


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260722171019_admission_review_rls_policies')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260722200245_agenda_enums_and_reference_tables.sql
-- ============================================================
-- agenda_enums_and_reference_tables.sql
create type session_status as enum ('draft', 'published', 'confirmed', 'cancelled', 'completed');
create type session_person_role as enum ('speaker', 'guest', 'moderator', 'facilitator', 'trainer', 'session_lead');
create type session_language as enum ('ar', 'en', 'bilingual');
create type session_difficulty as enum ('beginner', 'intermediate', 'advanced', 'all_levels');
create type audit_actor_type as enum ('admin', 'system');

create table conference_days (
  id uuid primary key default gen_random_uuid(),
  conference_date date not null unique,
  label_ar text not null,
  label_en text not null,
  display_order int not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id)
);

create table tracks (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  name_en text not null,
  color text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id)
);

create table session_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  name_en text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id)
);

create table rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  name_en text not null,
  capacity int not null,
  location text,
  floor text,
  is_accessible boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),
  constraint rooms_capacity_positive check (capacity > 0)
);

create table people (
  id uuid primary key default gen_random_uuid(),
  full_name_ar text not null,
  full_name_en text not null,
  title_ar text,
  title_en text,
  organization_ar text,
  organization_en text,
  bio_ar text,
  bio_en text,
  photo_path text,
  email text,
  phone text,
  linked_profile_id uuid unique references profiles(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id)
);

create table tags (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  name_en text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id)
);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  actor_type audit_actor_type not null default 'admin',
  actor_id uuid references profiles(id),
  request_id uuid,
  metadata jsonb,
  old_values jsonb,
  new_values jsonb,
  created_at timestamptz not null default now()
);

-- updated_at auto-touch, matching applications' established moddatetime pattern.
-- moddatetime cannot populate updated_by (no app-level actor context) — every
-- server action sets updated_by explicitly, same rule as audit_logs.actor_id.
create trigger conference_days_set_updated_at before update on conference_days for each row execute function extensions.moddatetime('updated_at');
create trigger tracks_set_updated_at before update on tracks for each row execute function extensions.moddatetime('updated_at');
create trigger session_types_set_updated_at before update on session_types for each row execute function extensions.moddatetime('updated_at');
create trigger rooms_set_updated_at before update on rooms for each row execute function extensions.moddatetime('updated_at');
create trigger people_set_updated_at before update on people for each row execute function extensions.moddatetime('updated_at');
create trigger tags_set_updated_at before update on tags for each row execute function extensions.moddatetime('updated_at');

create index tracks_code_idx on tracks (code);
create index session_types_code_idx on session_types (code);
create index rooms_code_idx on rooms (code);
create index tags_code_idx on tags (code);
create index people_linked_profile_idx on people (linked_profile_id);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id, created_at desc);
create index audit_logs_actor_idx on audit_logs (actor_id);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260722200245_agenda_enums_and_reference_tables')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260722201200_drop_redundant_agenda_indexes.sql
-- ============================================================
-- drop_redundant_agenda_indexes.sql
--
-- The 5 dropped indexes below were redundant with the unique constraints
-- already present on the same single columns (tracks.code, session_types.code,
-- rooms.code, tags.code, people.linked_profile_id) — Postgres auto-creates a
-- unique b-tree index for any `unique` column, so these explicit indexes
-- provided no additional query-planning benefit while still costing write
-- overhead and storage. Caught in code review of the migration that
-- originally added them (20260722200245_agenda_enums_and_reference_tables.sql).
drop index if exists tracks_code_idx;
drop index if exists session_types_code_idx;
drop index if exists rooms_code_idx;
drop index if exists tags_code_idx;
drop index if exists people_linked_profile_idx;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260722201200_drop_redundant_agenda_indexes')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260722201600_agenda_reference_rls_policies.sql
-- ============================================================
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


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260722201600_agenda_reference_rls_policies')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260722210000_sessions_table.sql
-- ============================================================
-- sessions_table.sql
create extension if not exists btree_gist;

create table sessions (
  id uuid primary key default gen_random_uuid(),
  session_code text not null unique,
  title_ar text not null,
  title_en text not null,
  description_ar text,
  description_en text,
  conference_day_id uuid not null references conference_days(id),
  start_time timestamptz not null,
  end_time timestamptz not null,
  track_id uuid not null references tracks(id),
  session_type_id uuid not null references session_types(id),
  room_id uuid not null references rooms(id),
  language session_language not null,
  difficulty_level session_difficulty not null,
  capacity int not null,
  min_capacity int not null default 0,
  is_mandatory boolean not null default false,
  is_public boolean not null default true,
  include_in_allocation boolean not null default true,
  allocation_priority int not null default 0,
  enable_qr_checkin boolean not null default false,
  checkin_opens_at timestamptz,
  checkin_closes_at timestamptz,
  status session_status not null default 'draft',
  internal_notes text,
  published_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),

  constraint sessions_end_after_start check (end_time > start_time),
  constraint sessions_capacity_positive check (capacity > 0),
  constraint sessions_min_capacity_valid check (min_capacity >= 0 and min_capacity <= capacity),
  constraint sessions_checkin_window_order check (
    checkin_opens_at is null or checkin_closes_at is null or checkin_opens_at < checkin_closes_at
  ),
  constraint sessions_checkin_window_required check (
    enable_qr_checkin = false or (checkin_opens_at is not null and checkin_closes_at is not null)
  )
);

create trigger sessions_set_updated_at before update on sessions for each row execute function extensions.moddatetime('updated_at');

-- Room double-booking: draft/published/confirmed sessions block the room;
-- cancelled/completed do not. '[)' matches the design spec's explicit
-- half-open interval choice (a session ending exactly when another starts
-- is not a conflict).
alter table sessions add constraint sessions_room_no_overlap
  exclude using gist (
    room_id with =,
    tstzrange(start_time, end_time, '[)') with &&
  ) where (status in ('draft', 'published', 'confirmed'));

create index sessions_conference_day_idx on sessions (conference_day_id);
create index sessions_track_idx on sessions (track_id);
create index sessions_session_type_idx on sessions (session_type_id);
create index sessions_room_idx on sessions (room_id);
create index sessions_status_day_idx on sessions (status, conference_day_id);
create index sessions_status_track_idx on sessions (status, track_id);
create index sessions_room_start_idx on sessions (room_id, start_time);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260722210000_sessions_table')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260722220000_document_exclusion_constraint.sql
-- ============================================================
-- document_exclusion_constraint.sql
--
-- Review follow-up for 20260722210000_sessions_table.sql: that migration
-- introduced the codebase's first GIST exclusion constraint
-- (sessions_room_no_overlap) but explained only the business rule, not the
-- underlying SQL mechanism, and installed btree_gist without a schema
-- qualifier (inconsistent with this project's established convention of
-- schema-qualifying extensions, e.g. moddatetime -> extensions.moddatetime,
-- reinforced by the two search_path-hardening migrations for functions).
-- This migration is metadata/consistency only: it does not change any
-- table shape, data, or constraint behavior.

do $$
begin
  -- btree_gist may already live in `extensions` (if a prior manual step or
  -- `supabase db push` already placed it there); only move it if needed.
  -- ALTER EXTENSION ... SET SCHEMA is the standard, safe way to relocate an
  -- already-installed *relocatable* extension: btree_gist's control file
  -- declares relocatable = true, so Postgres permits it. The move only
  -- updates pg_extension/pg_namespace bookkeeping and renames the member
  -- objects' schema; it does not drop/recreate anything. In particular, the
  -- existing sessions_room_no_overlap exclusion constraint is unaffected:
  -- its underlying GIST index was already built referencing the concrete
  -- operator class/family by OID at CREATE TIME, not by a schema-qualified
  -- name re-resolved on every query, so moving btree_gist's schema afterward
  -- cannot invalidate it. (Verified functionally below via a throwaway
  -- overlap-insert test run inside this same migration, after the move.)
  if exists (
    select 1 from pg_extension
    where extname = 'btree_gist'
      and extnamespace::regnamespace::text <> 'extensions'
  ) then
    alter extension btree_gist set schema extensions;
  end if;
end $$;

-- Document the mechanism directly on the database objects (queryable via
-- `\d+ sessions`, pg_description, or obj_description()), since a plain SQL
-- comment in the original migration file can't be retroactively attached to
-- already-created objects.
comment on extension btree_gist is 'Supplies GIST operator classes (including equality) for scalar types like uuid, required to combine room_id equality with a time-range overlap check in one exclusion constraint (see sessions_room_no_overlap).';

comment on constraint sessions_room_no_overlap on sessions is 'Exclusion constraint: generalizes UNIQUE to use operators besides "=". Rejects any two rows (draft/published/confirmed sessions only) in the same room whose time ranges overlap. Fires on INSERT/UPDATE, raised as Postgres error 23P01 (exclusion_violation). Requires btree_gist for the uuid equality operator class.';

-- Functional smoke test: prove sessions_room_no_overlap still rejects
-- overlapping rows after the possible schema move above. PL/pgSQL has no
-- explicit SAVEPOINT/ROLLBACK TO SAVEPOINT (it errors with "unsupported
-- transaction command in PL/pgSQL") — instead, a BEGIN...EXCEPTION...END
-- block is itself an implicit savepoint. So the whole test runs inside one
-- such block and deliberately raises a sentinel exception at the end,
-- caught by the outer block, to discard every throwaway row it inserted —
-- they never persist, win or lose.
do $$
declare
  v_day_id uuid;
  v_track_id uuid;
  v_type_id uuid;
  v_room_id uuid;
  v_got_23p01 boolean := false;
begin
  begin
    insert into conference_days (conference_date, label_ar, label_en, display_order)
    values ('2099-01-01', 'يوم اختبار', 'Test Day', 999)
    returning id into v_day_id;

    insert into tracks (code, name_ar, name_en)
    values ('__exclusion_test_track__', 'مسار اختبار', 'Test Track')
    returning id into v_track_id;

    insert into session_types (code, name_ar, name_en)
    values ('__exclusion_test_type__', 'نوع اختبار', 'Test Type')
    returning id into v_type_id;

    insert into rooms (code, name_ar, name_en, capacity)
    values ('__exclusion_test_room__', 'قاعة اختبار', 'Test Room', 10)
    returning id into v_room_id;

    insert into sessions (
      session_code, title_ar, title_en, conference_day_id, start_time, end_time,
      track_id, session_type_id, room_id, language, difficulty_level, capacity, status
    ) values (
      '__exclusion_test_session_1__', 'جلسة 1', 'Session 1', v_day_id,
      '2099-01-01 10:00:00+00', '2099-01-01 11:00:00+00',
      v_track_id, v_type_id, v_room_id, 'en', 'all_levels', 10, 'draft'
    );

    begin
      insert into sessions (
        session_code, title_ar, title_en, conference_day_id, start_time, end_time,
        track_id, session_type_id, room_id, language, difficulty_level, capacity, status
      ) values (
        '__exclusion_test_session_2__', 'جلسة 2', 'Session 2', v_day_id,
        '2099-01-01 10:30:00+00', '2099-01-01 11:30:00+00',
        v_track_id, v_type_id, v_room_id, 'en', 'all_levels', 10, 'draft'
      );
    exception
      when exclusion_violation then
        v_got_23p01 := true;
    end;

    -- Sentinel: always raise, to unwind (via the outer exception handler)
    -- everything inserted in this block, regardless of outcome above.
    raise exception using errcode = 'P0001', message = '__discard_overlap_test_rows__';
  exception
    when others then
      if sqlerrm <> '__discard_overlap_test_rows__' then
        raise;
      end if;
  end;

  if not v_got_23p01 then
    raise exception 'sessions_room_no_overlap did not reject an overlapping insert as expected (exclusion_violation/23P01 not raised) — aborting migration';
  end if;

  raise notice 'sessions_room_no_overlap verified: overlapping insert correctly rejected with 23P01 after btree_gist schema check';
end $$;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260722220000_document_exclusion_constraint')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723000000_session_people_and_tags.sql
-- ============================================================
-- session_people_and_tags.sql
create table session_people (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  person_id uuid not null references people(id),
  role session_person_role not null,
  display_order int not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),

  constraint session_people_unique_role unique (session_id, person_id, role)
);

create trigger session_people_set_updated_at before update on session_people for each row execute function extensions.moddatetime('updated_at');

create table session_tags (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  tag_id uuid not null references tags(id),
  weight numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),

  constraint session_tags_unique unique (session_id, tag_id),
  constraint session_tags_weight_range check (weight >= 0 and weight <= 1)
);

create trigger session_tags_set_updated_at before update on session_tags for each row execute function extensions.moddatetime('updated_at');

create index session_people_session_idx on session_people (session_id);
create index session_people_person_idx on session_people (person_id);
-- Composite index for enforce_speaker_no_conflict's hot path (Task 7) — runs
-- on every session_people write, distinct from the plain person_id FK index.
create index session_people_person_session_idx on session_people (person_id, session_id);
create index session_tags_session_idx on session_tags (session_id);
create index session_tags_tag_idx on session_tags (tag_id);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723000000_session_people_and_tags')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723010000_drop_redundant_session_people_index.sql
-- ============================================================
-- drop_redundant_session_people_index.sql
--
-- session_people_person_idx (person_id) was redundant with the composite
-- index session_people_person_session_idx (person_id, session_id) added in
-- the same migration — by the leftmost-prefix rule, the composite already
-- serves any pure person_id lookup at least as well as the single-column
-- index would. Same class of issue as
-- 20260722201200_drop_redundant_agenda_indexes.sql; caught in code review of
-- 20260723000000_session_people_and_tags.sql.
drop index if exists session_people_person_idx;

-- Document the unique-role business rule directly on the constraint
-- (queryable via \d+ session_people, pg_description, or obj_description()),
-- since a plain SQL comment in the original migration file can't be
-- retroactively attached to an already-created constraint.
comment on constraint session_people_unique_role on session_people is 'Same person may hold multiple distinct roles in one session (e.g. speaker AND moderator), but not the same role twice.';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723010000_drop_redundant_session_people_index')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723020000_sessions_triggers.sql
-- ============================================================
-- sessions_triggers.sql

-- 1. Day-match: a session's start_time/end_time, converted to Asia/Muscat,
-- must fall on the same calendar date as its conference_day_id's
-- conference_date, and must not cross midnight into a different day.
create function enforce_session_day_match() returns trigger as $$
declare
  v_conference_date date;
  v_start_date date;
  v_end_date date;
begin
  select conference_date into v_conference_date from conference_days where id = new.conference_day_id;
  if v_conference_date is null then
    raise exception 'conference_day_id % does not exist', new.conference_day_id;
  end if;

  v_start_date := (new.start_time at time zone 'Asia/Muscat')::date;
  v_end_date := (new.end_time at time zone 'Asia/Muscat')::date;

  if v_start_date <> v_end_date then
    raise exception 'Session cannot span across midnight into a different conference day (start: %, end: %)', v_start_date, v_end_date;
  end if;

  if v_start_date <> v_conference_date then
    raise exception 'Session start/end time (%) does not match its conference day (%)', v_start_date, v_conference_date;
  end if;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_enforce_day_match
  before insert or update of start_time, end_time, conference_day_id on sessions
  for each row execute function enforce_session_day_match();

-- 2. Status transition: mirrors SESSION_VALID_TRANSITIONS from
-- src/lib/validation/agenda.ts exactly. Also enforces cancellation_reason
-- is set when transitioning to cancelled, as a true DB-level backstop (not
-- just Zod/server-action) — see design spec's Data Model note on
-- cancellation_reason.
create function enforce_session_status_transition() returns trigger as $$
begin
  if old.status = new.status then
    return new; -- no-op status update always allowed
  end if;

  if new.status = 'cancelled' and (new.cancellation_reason is null or trim(new.cancellation_reason) = '') then
    raise exception 'A cancellation reason is required when cancelling a session';
  end if;

  case old.status
    when 'draft' then
      if new.status not in ('published', 'cancelled') then
        raise exception 'Cannot transition session from draft to %', new.status;
      end if;
    when 'published' then
      if new.status not in ('confirmed', 'cancelled') then
        raise exception 'Cannot transition session from published to %', new.status;
      end if;
    when 'confirmed' then
      if new.status not in ('completed', 'cancelled') then
        raise exception 'Cannot transition session from confirmed to %', new.status;
      end if;
    when 'cancelled' then
      raise exception 'Cannot transition session out of cancelled (terminal state)';
    when 'completed' then
      raise exception 'Cannot transition session out of completed (terminal state)';
  end case;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_enforce_status_transition
  before update of status on sessions
  for each row execute function enforce_session_status_transition();

-- 3. Session capacity cannot exceed its room's capacity.
create function enforce_session_room_capacity() returns trigger as $$
declare
  v_room_capacity int;
begin
  select capacity into v_room_capacity from rooms where id = new.room_id;
  if v_room_capacity is null then
    raise exception 'room_id % does not exist', new.room_id;
  end if;
  if new.capacity > v_room_capacity then
    raise exception 'Session capacity (%) exceeds room capacity (%)', new.capacity, v_room_capacity;
  end if;
  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_enforce_room_capacity
  before insert or update of capacity, room_id on sessions
  for each row execute function enforce_session_room_capacity();

-- 4. Reducing a room's capacity is rejected if any active session in that
-- room now exceeds it. Admin must first reduce/reassign conflicting
-- sessions. Deliberately does not cascade a silent capacity change onto
-- sessions (see design spec's rationale for this choice).
create function revalidate_sessions_on_room_capacity_change() returns trigger as $$
declare
  v_conflict_count int;
begin
  if new.capacity >= old.capacity then
    return new; -- only a reduction needs checking
  end if;
  select count(*) into v_conflict_count
    from sessions
    where room_id = new.id
      and status in ('draft', 'published', 'confirmed')
      and capacity > new.capacity;
  if v_conflict_count > 0 then
    raise exception 'Cannot reduce room capacity to %: % active session(s) in this room exceed that capacity', new.capacity, v_conflict_count;
  end if;
  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger rooms_revalidate_sessions_on_capacity_change
  before update of capacity on rooms
  for each row execute function revalidate_sessions_on_room_capacity_change();

-- 5. Speaker conflict on session_people insert/update: the person being
-- assigned/reassigned must not already be on another active session whose
-- time range overlaps this one's.
create function enforce_speaker_no_conflict() returns trigger as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_conflict_count int;
begin
  select start_time, end_time into v_start, v_end from sessions where id = new.session_id;
  if v_start is null then
    raise exception 'session_id % does not exist', new.session_id;
  end if;

  select count(*) into v_conflict_count
    from session_people sp
    join sessions s on s.id = sp.session_id
    where sp.person_id = new.person_id
      and sp.id is distinct from new.id
      and sp.session_id <> new.session_id
      and s.status in ('draft', 'published', 'confirmed')
      and tstzrange(s.start_time, s.end_time, '[)') && tstzrange(v_start, v_end, '[)');

  if v_conflict_count > 0 then
    raise exception 'Person % is already assigned to another session that overlaps this time slot', new.person_id;
  end if;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger session_people_enforce_no_conflict
  before insert or update of session_id, person_id, role on session_people
  for each row execute function enforce_speaker_no_conflict();

-- 6. Speaker conflict on sessions time/status change: when an existing
-- session's schedule or status changes, re-check every person currently
-- assigned to it against their other active sessions.
create function enforce_speaker_no_conflict_on_session_change() returns trigger as $$
declare
  v_conflict_person uuid;
begin
  select sp.person_id into v_conflict_person
    from session_people sp
    join session_people other_sp on other_sp.person_id = sp.person_id and other_sp.session_id <> sp.session_id
    join sessions other_s on other_s.id = other_sp.session_id
    where sp.session_id = new.id
      and new.status in ('draft', 'published', 'confirmed')
      and other_s.status in ('draft', 'published', 'confirmed')
      and tstzrange(other_s.start_time, other_s.end_time, '[)') && tstzrange(new.start_time, new.end_time, '[)')
    limit 1;

  if v_conflict_person is not null then
    raise exception 'Rescheduling this session creates a conflict for person % on another active session', v_conflict_person;
  end if;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_enforce_speaker_no_conflict_on_change
  before update of start_time, end_time, status on sessions
  for each row execute function enforce_speaker_no_conflict_on_session_change();


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723020000_sessions_triggers')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723030000_document_trigger_cross_references.sql
-- ============================================================
-- document_trigger_cross_references.sql
--
-- Documentation-only follow-up to 20260723020000_sessions_triggers.sql, per
-- code review: cross-references the two speaker-conflict functions to each
-- other, and flags exception message strings that are matched by substring
-- in Task 12's server-action error translation (not yet implemented at the
-- time this migration was written: translateSessionWriteError() in
-- src/app/[locale]/(admin)/agenda/sessions/[id]/actions.ts). This migration
-- changes no table shape, data, or trigger behavior — comments only.

comment on function enforce_speaker_no_conflict() is 'Fires on session_people insert/update. Enforces the same speaker-conflict rule as enforce_speaker_no_conflict_on_session_change() (which fires on sessions update of start_time/end_time/status) — if the conflict definition changes here (which statuses count as active, interval overlap semantics, etc.), update that function too to keep both directions in sync. Contract: the raise exception message "Person % is already assigned to another session that overlaps this time slot" contains the substring ''overlaps this time slot'', which Task 12''s translateSessionWriteError() matches via error.message.includes(''overlaps this time slot'') to produce a friendly UI error. Do not reword this message without updating that function too.';

comment on function enforce_speaker_no_conflict_on_session_change() is 'Fires on sessions update of start_time/end_time/status. Enforces the same speaker-conflict rule as enforce_speaker_no_conflict() (which fires on session_people insert/update) — if the conflict definition changes here, update that function too to keep both directions in sync. Contract: the raise exception message "Rescheduling this session creates a conflict for person % on another active session" contains the substring ''creates a conflict for person'', which Task 12''s translateSessionWriteError() matches via error.message.includes(''creates a conflict for person'') to produce a friendly UI error. Do not reword this message without updating that function too.';

comment on function enforce_session_room_capacity() is 'Fires on sessions insert/update of capacity, room_id. Rejects a session capacity greater than its room''s capacity. Contract: the raise exception message "Session capacity (%) exceeds room capacity (%)" contains the substring ''exceeds room capacity'', which Task 12''s translateSessionWriteError() (src/app/[locale]/(admin)/agenda/sessions/[id]/actions.ts, not yet implemented as of this migration) matches via error.message.includes(''exceeds room capacity'') to produce a friendly UI error. Do not reword this message without updating that function too.';

comment on function enforce_session_day_match() is 'Fires on sessions insert/update of start_time, end_time, conference_day_id. Enforces that a session''s start/end time (converted to Asia/Muscat) falls on the same calendar date as its conference_day_id''s conference_date, and does not cross midnight. Contract: the raise exception message "Session start/end time (%) does not match its conference day (%)" contains the substring ''does not match its conference day'', which Task 12''s translateSessionWriteError() (src/app/[locale]/(admin)/agenda/sessions/[id]/actions.ts, not yet implemented as of this migration) matches via error.message.includes(''does not match its conference day'') to produce a friendly UI error. Do not reword this message without updating that function too.';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723030000_document_trigger_cross_references')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723040000_sessions_rls_policies.sql
-- ============================================================
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


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723040000_sessions_rls_policies')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723050000_update_session_transactional_function.sql
-- ============================================================
-- update_session_transactional_function.sql
--
-- Wraps a session update and its post-write speaker-conflict re-validation
-- in one real Postgres transaction (a plpgsql function body is atomic by
-- default), so a re-validation failure actually rolls back the update —
-- closing the gap a two-step client-side approach cannot close, since
-- PostgREST/Supabase-js calls are not composable into one client transaction.
create function update_session_transactional(
  p_id uuid,
  p_session_code text, p_title_ar text, p_title_en text,
  p_description_ar text, p_description_en text,
  p_conference_day_id uuid, p_start_time timestamptz, p_end_time timestamptz,
  p_track_id uuid, p_session_type_id uuid, p_room_id uuid,
  p_language session_language, p_difficulty_level session_difficulty,
  p_capacity int, p_min_capacity int,
  p_is_mandatory boolean, p_is_public boolean,
  p_include_in_allocation boolean, p_allocation_priority int,
  p_enable_qr_checkin boolean, p_checkin_opens_at timestamptz, p_checkin_closes_at timestamptz,
  p_internal_notes text, p_updated_by uuid
) returns sessions as $$
declare
  v_result sessions;
  v_conflict_person uuid;
begin
  update sessions set
    session_code = p_session_code, title_ar = p_title_ar, title_en = p_title_en,
    description_ar = p_description_ar, description_en = p_description_en,
    conference_day_id = p_conference_day_id, start_time = p_start_time, end_time = p_end_time,
    track_id = p_track_id, session_type_id = p_session_type_id, room_id = p_room_id,
    language = p_language, difficulty_level = p_difficulty_level,
    capacity = p_capacity, min_capacity = p_min_capacity,
    is_mandatory = p_is_mandatory, is_public = p_is_public,
    include_in_allocation = p_include_in_allocation, allocation_priority = p_allocation_priority,
    enable_qr_checkin = p_enable_qr_checkin, checkin_opens_at = p_checkin_opens_at, checkin_closes_at = p_checkin_closes_at,
    internal_notes = p_internal_notes, updated_by = p_updated_by
  where id = p_id
  returning * into v_result;

  if v_result.id is null then
    raise exception 'Session % not found', p_id;
  end if;

  -- Final re-validation: every person currently assigned to this session,
  -- checked against their other active sessions, using the session's FINAL
  -- committed-within-this-transaction time/status. This runs after the
  -- update above (so session_people's join to sessions sees the new time)
  -- and closes the multi-statement/firing-order gap described in the design
  -- spec — if this finds a conflict, the exception below rolls back the
  -- entire function body, including the update already performed above.
  if v_result.status in ('draft', 'published', 'confirmed') then
    select sp.person_id into v_conflict_person
      from session_people sp
      join session_people other_sp on other_sp.person_id = sp.person_id and other_sp.session_id <> sp.session_id
      join sessions other_s on other_s.id = other_sp.session_id
      where sp.session_id = p_id
        and other_s.status in ('draft', 'published', 'confirmed')
        and tstzrange(other_s.start_time, other_s.end_time, '[)') && tstzrange(v_result.start_time, v_result.end_time, '[)')
      limit 1;

    if v_conflict_person is not null then
      raise exception 'Person % has a scheduling conflict with this session''s new time — the update has been rejected', v_conflict_person;
    end if;
  end if;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723050000_update_session_transactional_function')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723060000_session_people_transactional_functions.sql
-- ============================================================
-- session_people_transactional_functions.sql
--
-- Transactional RPCs backing session-people assignment writes and the
-- combined schedule+assignment update. Mirrors the pattern established in
-- 20260723050000_update_session_transactional_function.sql: a plpgsql
-- function body is atomic by default, so wrapping multi-statement writes in
-- one function closes the gap a two-step client-side approach cannot close
-- (PostgREST/Supabase-js calls are not composable into one client
-- transaction).

create function assign_session_person_transactional(
  p_session_id uuid, p_person_id uuid, p_role session_person_role,
  p_display_order int, p_is_primary boolean, p_updated_by uuid
) returns session_people as $$
declare
  v_result session_people;
begin
  insert into session_people (session_id, person_id, role, display_order, is_primary, updated_by)
  values (p_session_id, p_person_id, p_role, p_display_order, p_is_primary, p_updated_by)
  returning * into v_result;
  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;

create function remove_session_person(p_session_people_id uuid) returns void as $$
begin
  delete from session_people where id = p_session_people_id;
end;
$$ language plpgsql set search_path = public, pg_temp;

-- Combined schedule (start/end/room) + full assignment-set replacement for a
-- session, re-validated for speaker conflicts against the FINAL committed
-- state within this same transaction. This is what makes the "reschedule
-- alone is fine, assignment alone is fine, but the two together conflict"
-- scenario detectable and atomically rejectable — a two-step client
-- reschedule-then-reassign could commit the reschedule, then fail the
-- reassignment re-validation, leaving the session mid-air.
create function update_session_and_assignments_transactional(
  p_id uuid,
  p_start_time timestamptz, p_end_time timestamptz, p_room_id uuid,
  p_updated_by uuid,
  p_new_assignments jsonb -- array of {person_id, role, display_order, is_primary}
) returns sessions as $$
declare
  v_result sessions;
  v_conflict_person uuid;
  v_assignment jsonb;
begin
  update sessions set start_time = p_start_time, end_time = p_end_time, room_id = p_room_id, updated_by = p_updated_by
  where id = p_id
  returning * into v_result;

  if v_result.id is null then
    raise exception 'Session % not found', p_id;
  end if;

  delete from session_people where session_id = p_id;

  for v_assignment in select * from jsonb_array_elements(p_new_assignments) loop
    insert into session_people (session_id, person_id, role, display_order, is_primary, updated_by)
    values (
      p_id,
      (v_assignment->>'person_id')::uuid,
      (v_assignment->>'role')::session_person_role,
      coalesce((v_assignment->>'display_order')::int, 0),
      coalesce((v_assignment->>'is_primary')::boolean, false),
      p_updated_by
    );
  end loop;

  if v_result.status in ('draft', 'published', 'confirmed') then
    select sp.person_id into v_conflict_person
      from session_people sp
      join session_people other_sp on other_sp.person_id = sp.person_id and other_sp.session_id <> sp.session_id
      join sessions other_s on other_s.id = other_sp.session_id
      where sp.session_id = p_id
        and other_s.status in ('draft', 'published', 'confirmed')
        and tstzrange(other_s.start_time, other_s.end_time, '[)') && tstzrange(v_result.start_time, v_result.end_time, '[)')
      limit 1;

    if v_conflict_person is not null then
      raise exception 'Person % has a scheduling conflict created by this combined update — the entire operation has been rejected', v_conflict_person;
    end if;
  end if;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723060000_session_people_transactional_functions')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723070000_document_combined_rpc_conflict_detection.sql
-- ============================================================
-- document_combined_rpc_conflict_detection.sql
--
-- Documentation-only follow-up to 20260723060000_session_people_transactional_functions.sql,
-- per code review: the header comment on update_session_and_assignments_transactional
-- attributed conflict detection to its own final re-validation block, but in
-- the common "reschedule + assign the same person" case, the pre-existing
-- per-row enforce_speaker_no_conflict trigger fires first during the
-- delete-then-reinsert loop (it fires unconditionally on plain insert) and
-- raises before the final block ever runs. The final block remains a real,
-- intentional defense-in-depth backstop for edge cases the row-level trigger
-- can't see — this comment corrects the attribution, it does not change any
-- behavior.
comment on function update_session_and_assignments_transactional(uuid, timestamptz, timestamptz, uuid, uuid, jsonb) is
  'Combined schedule (start/end/room) + full assignment-set replacement for a session, in one transaction. In the common case, the pre-existing per-row enforce_speaker_no_conflict trigger (fires on every insert during the delete-then-reinsert loop below, since the session''s row is already updated to its new time earlier in this same transaction) is what actually raises the conflict error for a "reschedule + assign the same person" scenario. This function''s own final re-validation block is a defense-in-depth backstop for conflict shapes the row-level trigger does not see on its own, not the primary detection path — both mechanisms roll back the entire transaction on failure, so the atomicity guarantee holds regardless of which one raises first.';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723070000_document_combined_rpc_conflict_detection')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723080000_feature_extraction_tables.sql
-- ============================================================
-- feature_extraction_tables.sql
create table feature_extraction_rules (
  id uuid primary key default gen_random_uuid(),
  version int not null,
  source_field text not null,
  match_type text not null,
  match_value text not null,
  tag_id uuid not null references tags(id),
  weight numeric not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),

  constraint feature_extraction_rules_match_type_valid check (match_type in ('array_value', 'keyword_substring')),
  constraint feature_extraction_rules_weight_range check (weight >= 0 and weight <= 1),
  constraint feature_extraction_rules_source_field_valid check (
    source_field in ('interests', 'track_interests', 'topics_to_learn', 'participation_goals', 'past_initiatives')
  )
);

create trigger feature_extraction_rules_set_updated_at before update on feature_extraction_rules for each row execute function extensions.moddatetime('updated_at');

create table feature_extraction_runs (
  id uuid primary key default gen_random_uuid(),
  rules_version int not null,
  application_count int not null,
  run_at timestamptz not null default now(),
  run_by uuid not null references profiles(id)
);

create table participant_feature_snapshots (
  id uuid primary key default gen_random_uuid(),
  feature_extraction_run_id uuid not null references feature_extraction_runs(id) on delete cascade,
  application_id uuid not null references applications(id),
  tag_id uuid not null references tags(id),
  weight numeric not null,
  created_at timestamptz not null default now(),

  constraint participant_feature_snapshots_weight_range check (weight >= 0 and weight <= 1),
  constraint participant_feature_snapshots_unique unique (feature_extraction_run_id, application_id, tag_id)
);

create index feature_extraction_rules_source_field_idx on feature_extraction_rules (source_field) where is_active = true;
create index feature_extraction_rules_tag_idx on feature_extraction_rules (tag_id);
create index participant_feature_snapshots_run_idx on participant_feature_snapshots (feature_extraction_run_id);
create index participant_feature_snapshots_application_idx on participant_feature_snapshots (application_id);
create index participant_feature_snapshots_tag_idx on participant_feature_snapshots (tag_id);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723080000_feature_extraction_tables')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723090000_clustering_tables.sql
-- ============================================================
-- clustering_tables.sql
create table clustering_runs (
  id uuid primary key default gen_random_uuid(),
  feature_extraction_run_id uuid not null references feature_extraction_runs(id),
  k int not null,
  random_seed int not null,
  status text not null,
  run_at timestamptz not null default now(),
  run_by uuid not null references profiles(id),

  constraint clustering_runs_k_positive check (k > 0),
  constraint clustering_runs_status_valid check (status in ('completed', 'failed'))
);

create table clusters (
  id uuid primary key default gen_random_uuid(),
  clustering_run_id uuid not null references clustering_runs(id) on delete cascade,
  label text,
  centroid jsonb not null,
  member_count int not null default 0
);

create table cluster_memberships (
  id uuid primary key default gen_random_uuid(),
  cluster_id uuid not null references clusters(id) on delete cascade,
  application_id uuid not null references applications(id),
  distance_to_centroid numeric not null,

  constraint cluster_memberships_unique unique (cluster_id, application_id)
);

create index clustering_runs_feature_run_idx on clustering_runs (feature_extraction_run_id);
create index clusters_clustering_run_idx on clusters (clustering_run_id);
create index cluster_memberships_cluster_idx on cluster_memberships (cluster_id);
create index cluster_memberships_application_idx on cluster_memberships (application_id);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723090000_clustering_tables')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723100000_allocation_tables.sql
-- ============================================================
-- allocation_tables.sql
create table allocation_runs (
  id uuid primary key default gen_random_uuid(),
  feature_extraction_run_id uuid not null references feature_extraction_runs(id),
  status text not null default 'draft',
  run_at timestamptz not null default now(),
  run_by uuid not null references profiles(id),
  confirmed_at timestamptz,
  confirmed_by uuid references profiles(id),

  constraint allocation_runs_status_valid check (status in ('draft', 'confirmed', 'discarded'))
);

create table allocation_assignments (
  id uuid primary key default gen_random_uuid(),
  allocation_run_id uuid not null references allocation_runs(id) on delete cascade,
  application_id uuid not null references applications(id),
  session_id uuid not null references sessions(id),
  time_slot_group_key text not null,
  suitability_score numeric not null,
  is_low_confidence boolean not null default false,
  is_mandatory_assignment boolean not null default false,
  is_manual_override boolean not null default false,
  overridden_by uuid references profiles(id),
  override_reason text,
  status text not null default 'proposed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),

  constraint allocation_assignments_status_valid check (status in ('proposed', 'confirmed')),
  constraint allocation_assignments_score_range check (suitability_score >= 0 and suitability_score <= 1),
  constraint allocation_assignments_unique unique (allocation_run_id, application_id, time_slot_group_key)
);

create trigger allocation_assignments_set_updated_at before update on allocation_assignments for each row execute function extensions.moddatetime('updated_at');

create table allocation_alternatives (
  id uuid primary key default gen_random_uuid(),
  allocation_assignment_id uuid not null references allocation_assignments(id) on delete cascade,
  session_id uuid not null references sessions(id),
  suitability_score numeric not null,
  rank int not null,

  constraint allocation_alternatives_score_range check (suitability_score >= 0 and suitability_score <= 1),
  constraint allocation_alternatives_rank_positive check (rank > 0)
);

create table allocation_issues (
  id uuid primary key default gen_random_uuid(),
  allocation_run_id uuid not null references allocation_runs(id) on delete cascade,
  issue_type text not null,
  application_id uuid references applications(id),
  session_id uuid references sessions(id),
  details jsonb,
  created_at timestamptz not null default now(),

  constraint allocation_issues_type_valid check (
    issue_type in ('unassigned', 'low_confidence', 'capacity_bottleneck', 'schedule_conflict', 'no_eligible_sessions')
  )
);

create table allocation_assignment_explanations (
  id uuid primary key default gen_random_uuid(),
  allocation_assignment_id uuid not null references allocation_assignments(id) on delete cascade,
  constraint_type text not null,
  passed boolean not null,
  detail text not null
);

create index allocation_runs_feature_run_idx on allocation_runs (feature_extraction_run_id);
create index allocation_runs_status_idx on allocation_runs (status);
create index allocation_assignments_run_idx on allocation_assignments (allocation_run_id);
create index allocation_assignments_application_idx on allocation_assignments (application_id);
create index allocation_assignments_session_idx on allocation_assignments (session_id);
create index allocation_alternatives_assignment_idx on allocation_alternatives (allocation_assignment_id);
create index allocation_issues_run_idx on allocation_issues (allocation_run_id);
create index allocation_issues_type_idx on allocation_issues (issue_type);
create index allocation_assignment_explanations_assignment_idx on allocation_assignment_explanations (allocation_assignment_id);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723100000_allocation_tables')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723110000_allocation_rls_policies.sql
-- ============================================================
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


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723110000_allocation_rls_policies')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723120000_confirm_allocation_run_function.sql
-- ============================================================
-- confirm_allocation_run_function.sql

-- Atomically confirms a draft allocation run: transitions the run to
-- 'confirmed' and every one of its assignments to 'confirmed' in one
-- transaction (plpgsql function bodies are atomic). Rejects if the run is
-- not currently 'draft' — a confirmed or discarded run cannot be
-- re-confirmed, per the spec's "Once confirmed, immutable" rule.
create function confirm_allocation_run_transactional(
  p_run_id uuid,
  p_confirmed_by uuid
) returns allocation_runs as $$
declare
  v_result allocation_runs;
begin
  update allocation_runs
  set status = 'confirmed', confirmed_at = now(), confirmed_by = p_confirmed_by
  where id = p_run_id and status = 'draft'
  returning * into v_result;

  if v_result.id is null then
    raise exception 'Allocation run % is not in draft status (already confirmed or discarded, or does not exist)', p_run_id;
  end if;

  update allocation_assignments
  set status = 'confirmed', updated_by = p_confirmed_by
  where allocation_run_id = p_run_id;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;

-- Discards a draft run (never confirmed, kept for audit history). Same
-- immutability rule: only a draft run can be discarded.
create function discard_allocation_run_transactional(
  p_run_id uuid
) returns allocation_runs as $$
declare
  v_result allocation_runs;
begin
  update allocation_runs
  set status = 'discarded'
  where id = p_run_id and status = 'draft'
  returning * into v_result;

  if v_result.id is null then
    raise exception 'Allocation run % is not in draft status (already confirmed or discarded, or does not exist)', p_run_id;
  end if;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;

-- Overrides a single assignment's session within a draft run. Re-validates
-- hard constraints and this-run-only capacity server-side before writing —
-- hard reject on failure, no bypass (spec: Manual Override Workflow). The
-- constraint/capacity re-check itself happens in the calling server action
-- (TypeScript, reusing checkStaticHardConstraints), not in this function;
-- this function only enforces the atomicity of "the run must still be
-- draft" and the write itself.
create function override_allocation_assignment_transactional(
  p_assignment_id uuid,
  p_new_session_id uuid,
  p_overridden_by uuid,
  p_override_reason text
) returns allocation_assignments as $$
declare
  v_result allocation_assignments;
  v_run_status text;
begin
  select ar.status into v_run_status
  from allocation_assignments aa
  join allocation_runs ar on ar.id = aa.allocation_run_id
  where aa.id = p_assignment_id;

  if v_run_status is null then
    raise exception 'Allocation assignment % not found', p_assignment_id;
  end if;

  if v_run_status <> 'draft' then
    raise exception 'Cannot override an assignment on a % allocation run — only draft runs are editable', v_run_status;
  end if;

  update allocation_assignments
  set session_id = p_new_session_id,
      is_manual_override = true,
      overridden_by = p_overridden_by,
      override_reason = p_override_reason,
      updated_by = p_overridden_by
  where id = p_assignment_id
  returning * into v_result;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723120000_confirm_allocation_run_function')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723130000_override_capacity_check_in_transaction.sql
-- ============================================================
-- override_capacity_check_in_transaction.sql
--
-- Closes a TOCTOU race found in final-branch code review: the original
-- override_allocation_assignment_transactional only re-validated that the
-- target run was still 'draft', leaving the this-run capacity re-count in
-- the calling TypeScript action as a separate, non-transactional read
-- before the write. Two concurrent overrides targeting the same near-full
-- session could both read count < capacity, both pass, and both write,
-- overshooting session.capacity for the run. Moving the count inside this
-- function makes the whole check-then-write atomic.
create or replace function override_allocation_assignment_transactional(
  p_assignment_id uuid,
  p_new_session_id uuid,
  p_overridden_by uuid,
  p_override_reason text
) returns allocation_assignments as $$
declare
  v_result allocation_assignments;
  v_run_id uuid;
  v_run_status text;
  v_capacity int;
  v_current_count int;
begin
  select aa.allocation_run_id, ar.status into v_run_id, v_run_status
  from allocation_assignments aa
  join allocation_runs ar on ar.id = aa.allocation_run_id
  where aa.id = p_assignment_id;

  if v_run_status is null then
    raise exception 'Allocation assignment % not found', p_assignment_id;
  end if;

  if v_run_status <> 'draft' then
    raise exception 'Cannot override an assignment on a % allocation run — only draft runs are editable', v_run_status;
  end if;

  select capacity into v_capacity from sessions where id = p_new_session_id;
  if v_capacity is null then
    raise exception 'Target session % not found', p_new_session_id;
  end if;

  -- Scoped to this run only (spec: "Capacity re-validation scope") — counts
  -- this run's own assignments currently pointing at the target session,
  -- any status. Runs inside the same transaction as the write below, so no
  -- concurrent override can slip in between the count and the update.
  select count(*) into v_current_count
  from allocation_assignments
  where allocation_run_id = v_run_id and session_id = p_new_session_id;

  if v_current_count >= v_capacity then
    raise exception 'Cannot assign: session % is at capacity (% / %) for this allocation run', p_new_session_id, v_current_count, v_capacity;
  end if;

  update allocation_assignments
  set session_id = p_new_session_id,
      is_manual_override = true,
      overridden_by = p_overridden_by,
      override_reason = p_override_reason,
      updated_by = p_overridden_by
  where id = p_assignment_id
  returning * into v_result;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723130000_override_capacity_check_in_transaction')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723140000_schedule_publication_tables.sql
-- ============================================================
-- schedule_publication_tables.sql
create table schedule_publications (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id),
  allocation_run_id uuid not null references allocation_runs(id),
  revision_number int not null,
  status text not null,
  source_fingerprint text not null,
  published_at timestamptz not null default now(),
  published_by uuid not null references profiles(id),

  constraint schedule_publications_status_valid check (status in ('active', 'superseded')),
  constraint schedule_publications_revision_positive check (revision_number > 0),
  constraint schedule_publications_unique_revision unique (application_id, revision_number)
);

-- Exactly one active revision per participant.
create unique index schedule_publications_one_active on schedule_publications (application_id) where status = 'active';

create table schedule_publication_items (
  id uuid primary key default gen_random_uuid(),
  schedule_publication_id uuid not null references schedule_publications(id) on delete cascade,
  session_id uuid references sessions(id) on delete set null,
  session_title_ar text,
  session_title_en text,
  room_name_ar text,
  room_name_en text,
  start_time timestamptz,
  end_time timestamptz,
  is_mandatory boolean not null,
  speakers jsonb not null default '[]'::jsonb,
  suitability_score numeric,
  explanation_summary text,
  item_status text not null default 'active',
  gap_reason text,

  constraint schedule_publication_items_status_valid check (
    item_status in ('active', 'stale', 'changed', 'cancelled', 'pending_review')
  ),
  constraint schedule_publication_items_score_range check (
    suitability_score is null or (suitability_score >= 0 and suitability_score <= 1)
  )
);

create index schedule_publications_application_idx on schedule_publications (application_id);
create index schedule_publications_allocation_run_idx on schedule_publications (allocation_run_id);
create index schedule_publication_items_publication_idx on schedule_publication_items (schedule_publication_id);
create index schedule_publication_items_session_idx on schedule_publication_items (session_id);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723140000_schedule_publication_tables')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723150000_schedule_change_event_tables.sql
-- ============================================================
-- schedule_change_event_tables.sql
create table schedule_change_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id),
  change_type text not null,
  detected_at timestamptz not null default now(),
  processed_at timestamptz,

  constraint schedule_change_events_type_valid check (change_type in ('time_or_room', 'speakers', 'cancelled'))
);

-- Dedup mechanism: at most one unprocessed event per (session, change_type).
-- A session_people delete-and-reinsert (two row changes within one
-- operation) collapses to a single unprocessed 'speakers' event via
-- ON CONFLICT DO NOTHING in the trigger (Task 5), never generating an
-- intermediate/duplicate event from an incomplete mid-operation state.
create unique index schedule_change_events_unprocessed_dedup
  on schedule_change_events (session_id, change_type) where processed_at is null;

create index schedule_change_events_session_idx on schedule_change_events (session_id);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723150000_schedule_change_event_tables')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723160000_schedule_publication_draft_tables.sql
-- ============================================================
-- schedule_publication_draft_tables.sql
create table schedule_publication_drafts (
  id uuid primary key default gen_random_uuid(),
  allocation_run_id uuid references allocation_runs(id),
  triggered_by_change_event_ids uuid[],
  staged_at timestamptz not null default now(),
  staged_by uuid not null references profiles(id),
  source_fingerprint text not null,
  status text not null default 'staged',

  constraint schedule_publication_drafts_status_valid check (
    status in ('staged', 'confirmed', 'expired', 'discarded')
  ),
  -- Exactly one source per draft: a run-publish or a change-propagation
  -- batch, never both, never neither.
  constraint schedule_publication_drafts_one_source check (
    (allocation_run_id is not null) <> (triggered_by_change_event_ids is not null)
  )
);

create table schedule_publication_draft_items (
  id uuid primary key default gen_random_uuid(),
  schedule_publication_draft_id uuid not null references schedule_publication_drafts(id) on delete cascade,
  application_id uuid not null references applications(id),
  verdict text not null,
  blocker_details jsonb,
  resolution text,
  override_reason text,

  constraint schedule_publication_draft_items_verdict_valid check (
    verdict in ('publishable', 'blocked_mandatory', 'no_change')
  ),
  constraint schedule_publication_draft_items_resolution_valid check (
    resolution is null or resolution in ('reassigned', 'override_publish_with_gap')
  )
);

create index schedule_publication_drafts_run_idx on schedule_publication_drafts (allocation_run_id);
create index schedule_publication_draft_items_draft_idx on schedule_publication_draft_items (schedule_publication_draft_id);
create index schedule_publication_draft_items_application_idx on schedule_publication_draft_items (application_id);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723160000_schedule_publication_draft_tables')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723170000_schedule_rls_policies.sql
-- ============================================================
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


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723170000_schedule_rls_policies')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723180000_schedule_change_detection_triggers.sql
-- ============================================================
-- schedule_change_detection_triggers.sql

-- Records a deduplicated change event for a session — nothing else. No
-- participant fan-out, no schedule_publication_items writes, no revision
-- creation happen here or anywhere in this migration. This is deliberate:
-- per the approved design, only a server-side orchestrator (Task 8) may
-- mark items stale/pending_review, and only the publication engine
-- (Tasks 9-10) may ever create/activate a revision — never a trigger.
-- ON CONFLICT DO NOTHING against the unprocessed-event dedup index means a
-- session_people delete-and-reinsert operation (two row-level trigger
-- firings) collapses to one unprocessed event, never two, and never an
-- event recorded from an incomplete intermediate state.
create function record_schedule_change_event(p_session_id uuid, p_change_type text) returns void as $$
begin
  insert into schedule_change_events (session_id, change_type)
  values (p_session_id, p_change_type)
  on conflict (session_id, change_type) where processed_at is null do nothing;
end;
$$ language plpgsql set search_path = public, pg_temp;

create function sessions_record_change_event() returns trigger as $$
begin
  if new.start_time is distinct from old.start_time
     or new.end_time is distinct from old.end_time
     or new.room_id is distinct from old.room_id
  then
    perform record_schedule_change_event(new.id, 'time_or_room');
  end if;

  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    perform record_schedule_change_event(new.id, 'cancelled');
  end if;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_change_detection
  after update on sessions
  for each row
  execute function sessions_record_change_event();

create function session_people_record_change_event() returns trigger as $$
declare
  v_session_id uuid;
begin
  v_session_id := coalesce(new.session_id, old.session_id);
  perform record_schedule_change_event(v_session_id, 'speakers');
  return coalesce(new, old);
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger session_people_change_detection
  after insert or update or delete on session_people
  for each row
  execute function session_people_record_change_event();


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723180000_schedule_change_detection_triggers')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723190000_schedule_publication_functions.sql
-- ============================================================
-- schedule_publication_functions.sql

-- Shared by compute_publication_fingerprint and stage_publication_transactional
-- so "which sessions does this batch of change events affect" is resolved
-- in exactly one place. A prior version of stage_publication_transactional
-- duplicated this query independently and referenced the wrong-scoped
-- variable, causing a runtime 42703 error on the change-propagation path —
-- extracting it here removes that entire class of drift.
create function resolve_change_event_session_ids(p_change_event_ids uuid[]) returns uuid[] as $$
  select array_agg(distinct session_id) from schedule_change_events where id = any(p_change_event_ids);
$$ language sql stable set search_path = public, pg_temp;

-- Shared by stage_publication_transactional and confirm_publication_transactional
-- (Task 9) so the two fingerprint computations can never drift apart.
-- Exactly one of p_allocation_run_id / p_change_event_ids is non-null.
--
-- Run-publish path: hash of every allocation_assignments row for the run
-- (application_id, session_id, suitability_score, status, is_manual_override),
-- ordered by (application_id, session_id), concatenated with every
-- allocation_issues row for the run (issue_type, application_id,
-- session_id), also ordered — so two runs with identical assignments but
-- different issue sets never collide.
--
-- Change-propagation path: hash of, for every distinct session_id
-- referenced by the given change events: the session's (start_time,
-- end_time, room_id, status) AND every session_people row for that
-- session (person_id, role, display_order, ordered) — regardless of which
-- specific change_type triggered the event, so a speakers-only event's
-- fingerprint still reflects the session's current time/room too.
--
-- Uses the built-in sha256(bytea) (available in Postgres core since 13, no
-- extension required) rather than pgcrypto's digest() — pgcrypto is not
-- enabled anywhere in this project's migrations, and even if it were,
-- Supabase installs extensions into the `extensions` schema, which this
-- function's hardened `search_path = public, pg_temp` deliberately
-- excludes. sha256() needs neither.
create function compute_publication_fingerprint(
  p_allocation_run_id uuid,
  p_change_event_ids uuid[]
) returns text as $$
declare
  v_assignment_part text;
  v_issue_part text;
  v_session_part text;
  v_people_part text;
  v_session_ids uuid[];
begin
  if p_allocation_run_id is not null then
    select string_agg(
      format('%s|%s|%s|%s|%s', application_id, session_id, suitability_score, status, is_manual_override),
      ';' order by application_id, session_id
    ) into v_assignment_part
    from allocation_assignments where allocation_run_id = p_allocation_run_id;

    select string_agg(
      format('%s|%s|%s', issue_type, coalesce(application_id::text, ''), coalesce(session_id::text, '')),
      ';' order by issue_type, application_id, session_id
    ) into v_issue_part
    from allocation_issues where allocation_run_id = p_allocation_run_id;

    return encode(sha256(convert_to(coalesce(v_assignment_part, '') || '::' || coalesce(v_issue_part, ''), 'UTF8')), 'hex');
  else
    v_session_ids := resolve_change_event_session_ids(p_change_event_ids);

    select string_agg(
      format('%s|%s|%s|%s|%s', id, start_time, end_time, room_id, status),
      ';' order by id
    ) into v_session_part
    from sessions where id = any(v_session_ids);

    select string_agg(
      format('%s|%s|%s|%s', session_id, person_id, role, display_order),
      ';' order by session_id, person_id, role
    ) into v_people_part
    from session_people where session_id = any(v_session_ids);

    return encode(sha256(convert_to(coalesce(v_session_part, '') || '::' || coalesce(v_people_part, ''), 'UTF8')), 'hex');
  end if;
end;
$$ language plpgsql set search_path = public, pg_temp;

-- Stage: read-only against allocation_assignments/allocation_issues/
-- sessions/session_people/schedule_publications/schedule_publication_items.
-- Writes only to schedule_publication_drafts/schedule_publication_draft_items.
-- Computes the candidate publication set, blockers, diffs, and the source
-- fingerprint. Nothing is published by this function alone (spec:
-- atomicity/rule 8 applies to Confirm's writes, not staging).
create function stage_publication_transactional(
  p_allocation_run_id uuid,
  p_change_event_ids uuid[],
  p_staged_by uuid
) returns schedule_publication_drafts as $$
declare
  v_draft schedule_publication_drafts;
  v_fingerprint text;
  v_application_id uuid;
  v_verdict text;
  v_has_mandatory_blocker boolean;
  v_content_differs boolean;
  v_session_ids uuid[];
begin
  v_fingerprint := compute_publication_fingerprint(p_allocation_run_id, p_change_event_ids);

  -- Resolved once, up front, for the change-propagation path's
  -- content_differs check below, via the same shared helper
  -- compute_publication_fingerprint uses internally — never duplicated
  -- inline, so the two can't drift apart again.
  if p_allocation_run_id is null then
    v_session_ids := resolve_change_event_session_ids(p_change_event_ids);
  end if;

  insert into schedule_publication_drafts (
    allocation_run_id, triggered_by_change_event_ids, staged_by, source_fingerprint, status
  ) values (
    p_allocation_run_id, p_change_event_ids, p_staged_by, v_fingerprint, 'staged'
  ) returning * into v_draft;

  if p_allocation_run_id is not null then
    -- Candidate participants: every accepted application with at least one
    -- assignment in this run.
    for v_application_id in
      select distinct application_id from allocation_assignments where allocation_run_id = p_allocation_run_id
    loop
      select exists (
        select 1 from allocation_issues ai
        join sessions s on s.id = ai.session_id
        where ai.allocation_run_id = p_allocation_run_id
          and ai.application_id = v_application_id
          and ai.issue_type in ('unassigned', 'capacity_bottleneck', 'schedule_conflict', 'no_eligible_sessions')
          and s.is_mandatory = true
      ) into v_has_mandatory_blocker;

      -- content_differs: true if there is no current active
      -- schedule_publications row for this application, or if this run's
      -- assignment set for the participant differs from the active
      -- revision's items (compared on session_id set).
      select not exists (
        select 1 from schedule_publications sp
        where sp.application_id = v_application_id and sp.status = 'active'
          and (
            select array_agg(aa.session_id order by aa.session_id)
            from allocation_assignments aa
            where aa.allocation_run_id = p_allocation_run_id and aa.application_id = v_application_id
          ) = (
            select array_agg(spi.session_id order by spi.session_id)
            from schedule_publication_items spi
            where spi.schedule_publication_id = sp.id and spi.item_status = 'active'
          )
      ) into v_content_differs;

      if v_has_mandatory_blocker then
        v_verdict := 'blocked_mandatory';
      elsif not v_content_differs then
        v_verdict := 'no_change';
      else
        v_verdict := 'publishable';
      end if;

      insert into schedule_publication_draft_items (schedule_publication_draft_id, application_id, verdict, blocker_details)
      values (
        v_draft.id,
        v_application_id,
        v_verdict,
        case when v_has_mandatory_blocker then
          (select jsonb_agg(jsonb_build_object('issue_type', ai.issue_type, 'session_id', ai.session_id))
           from allocation_issues ai join sessions s on s.id = ai.session_id
           where ai.allocation_run_id = p_allocation_run_id and ai.application_id = v_application_id
             and ai.issue_type in ('unassigned', 'capacity_bottleneck', 'schedule_conflict', 'no_eligible_sessions')
             and s.is_mandatory = true)
        else null end
      );
    end loop;
  else
    -- Change-propagation path: candidate participants are those with an
    -- active schedule_publication_items row referencing a session in
    -- v_session_ids (resolved from the change events). Blocking is driven
    -- by change_type = 'cancelled' on ANY affected item — mandatory or
    -- elective — not by allocation_issues (which don't apply to a
    -- change-propagation batch). Per the spec's Change Propagation
    -- Policy, a cancellation "must pick reassignment or explicit 'confirm
    -- cancelled' resolution... before any draft including this
    -- participant can be confirmed" — that requirement is not scoped to
    -- mandatory sessions, so an elective session's cancellation blocks
    -- exactly the same way a mandatory one does. (An earlier version of
    -- this check incorrectly scoped blocking to is_mandatory = true only,
    -- which let an elective cancellation silently reach confirm with no
    -- admin review — fixed here.)
    --
    -- content_differs: unlike the run-publish path, we can't compare
    -- session-id sets (the session assignment itself hasn't changed, only
    -- its frozen fields) — instead compare the recomputed frozen fields
    -- (start_time, end_time, room_id, and the session_people-derived
    -- speaker set) against the currently-stored frozen values on the
    -- active item. This mirrors compute_publication_fingerprint's own
    -- change-propagation hash inputs, so a truly no-op change event (e.g.
    -- a session_people row updated then immediately reverted before this
    -- batch was staged) correctly classifies as no_change rather than
    -- spuriously bumping the participant's revision_number.
    for v_application_id in
      select distinct sp.application_id
      from schedule_publications sp
      join schedule_publication_items spi on spi.schedule_publication_id = sp.id
      join schedule_change_events sce on sce.session_id = spi.session_id
      where sp.status = 'active' and spi.item_status in ('active', 'stale', 'pending_review')
        and sce.id = any(p_change_event_ids)
    loop
      select exists (
        select 1
        from schedule_publications sp
        join schedule_publication_items spi on spi.schedule_publication_id = sp.id
        join schedule_change_events sce on sce.session_id = spi.session_id
        where sp.application_id = v_application_id and sp.status = 'active'
          and sce.id = any(p_change_event_ids) and sce.change_type = 'cancelled'
      ) into v_has_mandatory_blocker;

      select exists (
        select 1
        from schedule_publications sp
        join schedule_publication_items spi on spi.schedule_publication_id = sp.id
        join sessions s on s.id = spi.session_id
        where sp.application_id = v_application_id and sp.status = 'active'
          and spi.session_id = any(v_session_ids)
          and (
            spi.start_time is distinct from s.start_time
            or spi.end_time is distinct from s.end_time
            or spi.room_name_en is distinct from (select r.name_en from rooms r where r.id = s.room_id)
            or spi.speakers is distinct from (
              select coalesce(jsonb_agg(jsonb_build_object('full_name_ar', p.full_name_ar, 'full_name_en', p.full_name_en, 'role', sp2.role)), '[]'::jsonb)
              from session_people sp2 join people p on p.id = sp2.person_id
              where sp2.session_id = s.id
            )
          )
      ) into v_content_differs;

      if v_has_mandatory_blocker then
        v_verdict := 'blocked_mandatory';
      elsif not v_content_differs then
        v_verdict := 'no_change';
      else
        v_verdict := 'publishable';
      end if;

      insert into schedule_publication_draft_items (schedule_publication_draft_id, application_id, verdict)
      values (v_draft.id, v_application_id, v_verdict);
    end loop;
  end if;

  return v_draft;
end;
$$ language plpgsql set search_path = public, pg_temp;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723190000_schedule_publication_functions')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723195000_confirm_publication_function.sql
-- ============================================================
-- confirm_publication_function.sql

-- NOTE: this file's timestamp (195000) predates 20260723200000/201000, but
-- this function's body was edited (via create-or-replace, applied live and
-- committed here) AFTER those two migrations existed, and now references
-- schedule_publication_draft_items.reassigned_session_id — a column
-- 201000 adds. This works today only because v_item below is declared as
-- an untyped `record`, so PL/pgSQL defers field-reference resolution
-- until first execution rather than validating it at CREATE FUNCTION
-- time. If v_item is ever changed to
-- schedule_publication_draft_items%rowtype, this migration would need to
-- be renumbered to run after 201000, or it would fail to apply on a fresh
-- database.

-- Confirm: re-validates the fingerprint against current committed source
-- state (rejects with 'expired' if source data moved since staging);
-- acquires a transaction-scoped advisory lock keyed on the draft's source
-- identity (prevents concurrent publish interleaving); writes new
-- schedule_publications/schedule_publication_items rows only for
-- participants whose draft item verdict is 'publishable' (idempotent —
-- 'no_change' participants get no new row, 'blocked_mandatory' rows with
-- no resolution are skipped entirely); all in one short atomic
-- transaction. Rule 8's atomicity applies to this function's own writes.
create function confirm_publication_transactional(
  p_draft_id uuid,
  p_confirmed_by uuid
) returns schedule_publication_drafts as $$
declare
  v_draft schedule_publication_drafts;
  v_current_fingerprint text;
  v_lock_key bigint;
  v_item record;
  v_new_publication_id uuid;
  v_next_revision int;
  v_session record;
  v_speakers jsonb;
  v_session_ids uuid[];
  v_sorted_event_ids text;
  v_prior_publication_id uuid;
begin
  select * into v_draft from schedule_publication_drafts where id = p_draft_id and status = 'staged';
  if v_draft.id is null then
    raise exception 'Draft % is not in staged status (already confirmed, expired, discarded, or does not exist)', p_draft_id;
  end if;

  -- Sort before joining so two drafts over the same underlying change-event
  -- set, built from arrays passed in a different order, still hash to the
  -- same advisory lock key and correctly mutually exclude each other.
  if v_draft.triggered_by_change_event_ids is not null then
    select string_agg(id::text, ',' order by id) into v_sorted_event_ids
    from unnest(v_draft.triggered_by_change_event_ids) as id;
  end if;
  v_lock_key := hashtext(coalesce(v_draft.allocation_run_id::text, v_sorted_event_ids));
  if not pg_try_advisory_xact_lock(v_lock_key) then
    raise exception 'Another publication for this source is already in progress';
  end if;

  if v_draft.allocation_run_id is null then
    v_session_ids := resolve_change_event_session_ids(v_draft.triggered_by_change_event_ids);
  end if;

  v_current_fingerprint := compute_publication_fingerprint(v_draft.allocation_run_id, v_draft.triggered_by_change_event_ids);
  if v_current_fingerprint <> v_draft.source_fingerprint then
    -- Note: PL/pgSQL has no autonomous transactions, so an update here
    -- cannot durably persist a status change while this same invocation
    -- also raises an exception — Postgres rolls back every write this
    -- function made once the exception propagates, including this one.
    -- The draft is therefore left in 'staged', not 'expired', after this
    -- rejection; re-confirming the same draft re-detects the drift and
    -- re-rejects it identically every time, so this has no data-integrity
    -- consequence, only a cosmetic one (the 'expired' status value is
    -- unreachable via this path as currently designed). Marking a draft
    -- 'expired' for observability would require either a caller-side
    -- follow-up write after catching this exception, or restructuring
    -- this function to return rather than raise on drift — deferred
    -- rather than solved with a workaround here.
    raise exception 'Source data changed since this draft was staged — re-stage before publishing';
  end if;

  -- Ordered by application_id: makes processing order deterministic and
  -- reproducible across runs (otherwise cursor order depends on
  -- unspecified physical row order) — a harmless, cheap guarantee to have
  -- regardless of any specific test's needs.
  for v_item in
    select * from schedule_publication_draft_items
    where schedule_publication_draft_id = p_draft_id
      and (verdict = 'publishable' or (verdict = 'blocked_mandatory' and resolution is not null))
    order by application_id
  loop
    -- Supersede the current active revision for this participant, if any
    -- — capturing its id directly rather than re-deriving "most recent
    -- superseded" later, so the change-propagation carry-forward below
    -- has no implicit ordering dependency on this statement having run
    -- first (previously relied on `status = 'superseded' order by
    -- revision_number desc limit 1`, correct today but fragile against a
    -- future reordering).
    update schedule_publications set status = 'superseded'
    where application_id = v_item.application_id and status = 'active'
    returning id into v_prior_publication_id;

    select coalesce(max(revision_number), 0) + 1 into v_next_revision
    from schedule_publications where application_id = v_item.application_id;

    insert into schedule_publications (application_id, allocation_run_id, revision_number, status, source_fingerprint, published_by)
    values (
      v_item.application_id,
      coalesce(v_draft.allocation_run_id, (select allocation_run_id from schedule_publications where application_id = v_item.application_id order by revision_number desc limit 1)),
      v_next_revision, 'active', v_current_fingerprint, p_confirmed_by
    ) returning id into v_new_publication_id;

    -- The gap item (below, for a publish_with_gap-resolved mandatory
    -- blocker) and the participant's real assigned-session items (the loop
    -- further below) are intentionally NOT mutually exclusive: a
    -- publish_with_gap resolution means "no assignment exists for the
    -- mandatory slot this participant was blocked on" — there is no
    -- allocation_assignments row for that slot, so the loop below simply
    -- never produces an item for it. The gap item fills exactly that
    -- specific missing slot, while the loop below still correctly
    -- publishes every OTHER real assignment (e.g. their electives) the
    -- participant does have. The two paths write disjoint items by
    -- construction, not by an explicit guard.
    if v_item.resolution = 'override_publish_with_gap' then
      insert into schedule_publication_items (schedule_publication_id, session_id, is_mandatory, item_status, gap_reason)
      values (v_new_publication_id, null, true, 'active', v_item.override_reason);
    end if;

    -- A 'reassigned' resolution (reassign_blocked_participant_transactional,
    -- Task 10) means the participant's blocked mandatory slot was pointed
    -- at a different session — reassigned_session_id, on the draft item
    -- itself, not allocation_assignments (which has no row for this
    -- participant+slot; that's exactly why it was blocked). Publish that
    -- session's current data directly, same shape as the run-publish loop
    -- below but sourced from the draft item's reassignment instead of an
    -- allocation_assignments row. Disjoint from both the gap-item branch
    -- above (mutually exclusive resolution values, checked by the enum
    -- constraint) and the allocation_assignments loop below (no row exists
    -- for this participant+slot on the run-publish path, or the loop below
    -- is skipped entirely on the change-propagation path).
    if v_item.resolution = 'reassigned' then
      select s.*, r.name_ar as room_name_ar, r.name_en as room_name_en
      into v_session
      from sessions s join rooms r on r.id = s.room_id
      where s.id = v_item.reassigned_session_id;

      select jsonb_agg(jsonb_build_object('full_name_ar', p.full_name_ar, 'full_name_en', p.full_name_en, 'role', sp.role))
      into v_speakers
      from session_people sp join people p on p.id = sp.person_id
      where sp.session_id = v_session.id;

      insert into schedule_publication_items (
        schedule_publication_id, session_id, session_title_ar, session_title_en,
        room_name_ar, room_name_en, start_time, end_time, is_mandatory, speakers, item_status
      ) values (
        v_new_publication_id, v_session.id, v_session.title_ar, v_session.title_en,
        v_session.room_name_ar, v_session.room_name_en,
        v_session.start_time, v_session.end_time, v_session.is_mandatory,
        coalesce(v_speakers, '[]'::jsonb), 'active'
      );
    end if;

    if v_draft.allocation_run_id is not null then
      for v_session in
        select s.*, r.name_ar as room_name_ar, r.name_en as room_name_en, aa.suitability_score, aa.is_low_confidence
        from allocation_assignments aa
        join sessions s on s.id = aa.session_id
        join rooms r on r.id = s.room_id
        where aa.allocation_run_id = v_draft.allocation_run_id and aa.application_id = v_item.application_id
      loop
        select jsonb_agg(jsonb_build_object('full_name_ar', p.full_name_ar, 'full_name_en', p.full_name_en, 'role', sp.role))
        into v_speakers
        from session_people sp join people p on p.id = sp.person_id
        where sp.session_id = v_session.id;

        insert into schedule_publication_items (
          schedule_publication_id, session_id, session_title_ar, session_title_en,
          room_name_ar, room_name_en, start_time, end_time, is_mandatory, speakers,
          suitability_score, item_status
        ) values (
          v_new_publication_id, v_session.id, v_session.title_ar, v_session.title_en,
          v_session.room_name_ar, v_session.room_name_en,
          v_session.start_time, v_session.end_time, v_session.is_mandatory,
          coalesce(v_speakers, '[]'::jsonb), v_session.suitability_score, 'active'
        );
      end loop;
    else
      -- Change-propagation path: carry forward EVERY item from the
      -- participant's prior active (now-superseded, id captured above in
      -- v_prior_publication_id) revision — the underlying session
      -- assignment hasn't changed, only some sessions' frozen display
      -- fields have. For items whose session_id is one of this batch's
      -- affected sessions, refresh the frozen fields from current live
      -- state (mirrors what stage_publication_transactional's
      -- content_differs check already compared against); every other
      -- item is carried forward verbatim, regardless of its current
      -- item_status (not filtered to 'active' — a 'stale'/'pending_review'
      -- item from an unrelated earlier change batch must not be silently
      -- dropped just because this confirm call is about a different
      -- session).
      --
      -- This branch never needs to decide a 'cancelled' item_status
      -- itself: stage_publication_transactional's blocker check now
      -- treats ANY cancelled session referenced by an active item as
      -- blocking (mandatory or elective — see that function's comment),
      -- so a draft item can only reach this loop at all if either (a) no
      -- affected session was cancelled, or (b) it was cancelled and the
      -- blocker was explicitly resolved. Resolution handling (updating
      -- the carried-forward item to reflect that resolution) is Task 10's
      -- concern once reassign_blocked_participant_transactional exists;
      -- this function does not yet special-case a resolved cancellation
      -- and will simply carry the item's frozen fields forward unchanged
      -- if session_id is not in v_session_ids, or refresh them from
      -- (still-cancelled) live session state if it is — deliberately not
      -- guessing an item_status transition that belongs to a resolution
      -- step this function doesn't implement.
      for v_session in
        select spi.id as item_id, spi.session_id, spi.session_title_ar, spi.session_title_en,
          spi.room_name_ar, spi.room_name_en, spi.start_time, spi.end_time, spi.is_mandatory,
          spi.speakers, spi.suitability_score, spi.explanation_summary, spi.gap_reason, spi.item_status,
          s.id as live_session_id, s.title_ar as live_title_ar, s.title_en as live_title_en,
          r.name_ar as live_room_name_ar, r.name_en as live_room_name_en,
          s.start_time as live_start_time, s.end_time as live_end_time,
          s.is_mandatory as live_is_mandatory
        from schedule_publication_items spi
        left join sessions s on s.id = spi.session_id
        left join rooms r on r.id = s.room_id
        where spi.schedule_publication_id = v_prior_publication_id
      loop
        if v_session.session_id is not null and v_session.session_id = any(v_session_ids) then
          select jsonb_agg(jsonb_build_object('full_name_ar', p.full_name_ar, 'full_name_en', p.full_name_en, 'role', sp2.role))
          into v_speakers
          from session_people sp2 join people p on p.id = sp2.person_id
          where sp2.session_id = v_session.session_id;

          insert into schedule_publication_items (
            schedule_publication_id, session_id, session_title_ar, session_title_en,
            room_name_ar, room_name_en, start_time, end_time, is_mandatory, speakers,
            suitability_score, explanation_summary, item_status
          ) values (
            v_new_publication_id, v_session.session_id, v_session.live_title_ar, v_session.live_title_en,
            v_session.live_room_name_ar, v_session.live_room_name_en,
            v_session.live_start_time, v_session.live_end_time, v_session.live_is_mandatory,
            coalesce(v_speakers, '[]'::jsonb), v_session.suitability_score, v_session.explanation_summary,
            v_session.item_status
          );
        else
          insert into schedule_publication_items (
            schedule_publication_id, session_id, session_title_ar, session_title_en,
            room_name_ar, room_name_en, start_time, end_time, is_mandatory, speakers,
            suitability_score, explanation_summary, gap_reason, item_status
          ) values (
            v_new_publication_id, v_session.session_id, v_session.session_title_ar, v_session.session_title_en,
            v_session.room_name_ar, v_session.room_name_en,
            v_session.start_time, v_session.end_time, v_session.is_mandatory,
            v_session.speakers, v_session.suitability_score, v_session.explanation_summary,
            v_session.gap_reason, v_session.item_status
          );
        end if;
      end loop;
    end if;
  end loop;

  update schedule_publication_drafts set status = 'confirmed' where id = p_draft_id;
  select * into v_draft from schedule_publication_drafts where id = p_draft_id;
  return v_draft;
end;
$$ language plpgsql set search_path = public, pg_temp;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723195000_confirm_publication_function')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723200000_reassign_blocked_participant_function.sql
-- ============================================================
-- reassign_blocked_participant_function.sql

-- Resolves a blocked_mandatory draft item by pointing it at a different
-- session, entirely within the still-staged draft. Never mutates Phase 4's
-- allocation_assignments/allocation_runs — those stay untouched; only this
-- draft's proposed publication content changes. Cannot reuse Phase 4's
-- override_allocation_assignment_transactional, which hard-rejects unless
-- the target run is 'draft' status, and Phase 5 only ever operates on
-- 'confirmed' runs.
--
-- Does NOT re-check hard constraints (status/inclusion/language/
-- difficulty) — that happens in the calling server action via
-- checkStaticHardConstraints (see Task 16), which must run and reject
-- BEFORE this RPC is ever called. This RPC only re-validates the one
-- genuinely SQL-native concern (this-draft capacity) and performs the
-- write.
create function reassign_blocked_participant_transactional(
  p_draft_item_id uuid,
  p_new_session_id uuid,
  p_reassigned_by uuid
) returns schedule_publication_draft_items as $$
declare
  v_item schedule_publication_draft_items;
  v_draft_status text;
  v_session_capacity int;
  v_current_count int;
begin
  -- NOTE: the plan's given SQL used a single
  --   select spdi.*, spd.status into v_item, v_draft_status
  -- but Postgres rejects mixing a record target (v_item receiving spdi.*)
  -- with an additional scalar target in the same INTO list
  -- (SQLSTATE 42601: "record variable cannot be part of multiple-item INTO
  -- list") — confirmed live against the hosted project; the migration does
  -- not apply as originally written. Split into two statements with
  -- identical join/filter semantics; behavior is unchanged.
  select spdi.* into v_item
  from schedule_publication_draft_items spdi
  where spdi.id = p_draft_item_id;

  select spd.status into v_draft_status
  from schedule_publication_drafts spd
  where spd.id = v_item.schedule_publication_draft_id;

  if v_item.id is null then
    raise exception 'Draft item % not found', p_draft_item_id;
  end if;
  if v_item.verdict <> 'blocked_mandatory' then
    raise exception 'Draft item % is not blocked_mandatory (verdict is %)', p_draft_item_id, v_item.verdict;
  end if;
  if v_draft_status <> 'staged' then
    raise exception 'Cannot reassign on a % draft — only staged drafts are editable', v_draft_status;
  end if;

  select capacity into v_session_capacity from sessions where id = p_new_session_id;
  if v_session_capacity is null then
    raise exception 'Target session % not found', p_new_session_id;
  end if;

  -- This-draft-scoped capacity: count draft items ALREADY reassigned to
  -- THIS SPECIFIC target session within this same draft. Scoped by
  -- reassigned_session_id (added because schedule_publication_draft_items
  -- originally had no column recording which session a reassignment
  -- pointed at, making this recount count every reassigned item in the
  -- whole draft regardless of target session — found and fixed after
  -- live verification showed reassigning to a different, empty session
  -- was incorrectly rejected just because an unrelated session was full).
  -- Approximate by design for this within-draft correction step and
  -- re-validated for real at Confirm time by the same session's real
  -- capacity constraint already enforced elsewhere in the system.
  select count(*) into v_current_count
  from schedule_publication_draft_items
  where schedule_publication_draft_id = v_item.schedule_publication_draft_id
    and verdict = 'publishable' and resolution = 'reassigned'
    and reassigned_session_id = p_new_session_id;

  if v_current_count >= v_session_capacity then
    raise exception 'Cannot reassign: session % is at capacity (% / %) within this draft', p_new_session_id, v_current_count, v_session_capacity;
  end if;

  update schedule_publication_draft_items
  set verdict = 'publishable', resolution = 'reassigned', reassigned_session_id = p_new_session_id
  where id = p_draft_item_id
  returning * into v_item;

  return v_item;
end;
$$ language plpgsql set search_path = public, pg_temp;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723200000_reassign_blocked_participant_function')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260723201000_reassigned_session_id_column.sql
-- ============================================================
-- reassigned_session_id_column.sql

-- Real gap found during Task 10's live verification: reassign_blocked_
-- participant_transactional flips a blocked draft item to publishable/
-- reassigned, but schedule_publication_draft_items had no column to
-- record WHICH session it was reassigned to. Without this, the this-draft
-- capacity recount couldn't scope by target session (it counted every
-- reassigned item in the whole draft, rejecting an unrelated reassignment
-- to a different, empty session just because some other item filled an
-- unrelated one), and confirm_publication_transactional had no way to
-- publish the reassigned session's data at all — a reassigned run-publish
-- item would silently fall through with no schedule_publication_items row
-- (no allocation_assignments row exists for a blocked mandatory slot,
-- which is exactly why it was blocked in the first place).
alter table schedule_publication_draft_items
  add column reassigned_session_id uuid references sessions(id);

-- Unlike override_reason (descriptive text, app-layer-enforced pairing
-- with resolution = 'override_publish_with_gap' per Task 3's existing
-- convention), reassigned_session_id is load-bearing:
-- confirm_publication_transactional reads it to decide what to actually
-- publish. A resolution = 'reassigned' row with a null
-- reassigned_session_id would degrade to a confusing NOT NULL constraint
-- violation on schedule_publication_items.is_mandatory at confirm time,
-- rather than a clear error at the point the bad data was written — a DB
-- check constraint converts that into an immediate, clear failure at the
-- write site instead of a deferred, cryptic one at confirm.
alter table schedule_publication_draft_items
  add constraint schedule_publication_draft_items_reassigned_session_required
  check (resolution <> 'reassigned' or reassigned_session_id is not null);

comment on column schedule_publication_draft_items.reassigned_session_id is
  'Set by reassign_blocked_participant_transactional when resolution = ''reassigned''. The session this draft item will actually publish against at confirm time, replacing the original blocked mandatory assignment.';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260723201000_reassigned_session_id_column')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726100000_applications_import_columns.sql
-- ============================================================
-- applications_import_columns.sql
alter table applications alter column applicant_id drop not null;
alter table applications add column imported_email text;
alter table applications add column import_batch_id uuid;

-- Self-registered applications must still have an owner. Imported-and-
-- unclaimed applications are the only legal NULL applicant_id case, and only
-- when they carry a non-null imported_email — a NULL applicant_id row is
-- always traceable to a claim-in-progress import, never an identity-less
-- orphan. See design spec § Schema changes / rule 4.
alter table applications add constraint applications_owner_or_import_identity
  check (applicant_id is not null or imported_email is not null);

-- Case-insensitive matching is achieved by normalizing (trim + lowercase) in
-- application code before every write to this column — never re-derived
-- from profiles.email, and never silently changed after claim (design spec
-- rule 5) — matching this codebase's existing convention of app-layer
-- normalization before insert (see registration's email handling) rather
-- than a DB-level citext/trigger transform. Partial: claimed applications
-- may retain imported_email for provenance and future re-import matching,
-- so the index only needs to prevent duplicate *unclaimed* identities.
create unique index applications_imported_email_unclaimed_unique
  on applications (imported_email) where applicant_id is null;

create index applications_import_batch_idx on applications (import_batch_id);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726100000_applications_import_columns')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726101000_application_answers_table.sql
-- ============================================================
-- application_answers_table.sql
create table application_answers (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  question_key text not null,
  question_label text,
  normalized_value text,
  raw_value text not null,
  value_type text not null,
  source text not null default 'import',
  is_sensitive boolean not null default false,
  import_batch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint application_answers_value_type_valid check (value_type in ('text', 'multiselect', 'boolean', 'number', 'date')),
  constraint application_answers_source_valid check (source in ('import', 'manual')),
  -- One answer per (application, question_key, source): a later import
  -- updates the existing row for the same question_key rather than
  -- inserting a duplicate. See design spec § application_answers.
  constraint application_answers_unique unique (application_id, question_key, source)
);

create index application_answers_application_idx on application_answers (application_id);
create trigger application_answers_set_updated_at before update on application_answers
  for each row execute function extensions.moddatetime('updated_at');


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726101000_application_answers_table')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726102000_import_staging_tables.sql
-- ============================================================
-- import_staging_tables.sql
create table import_mapping_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  header_signature text not null,
  original_headers jsonb not null,
  mappings jsonb not null,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  version int not null default 1
);

create index import_mapping_templates_signature_idx on import_mapping_templates (header_signature);

create table import_batches (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid not null references profiles(id),
  original_filename text not null,
  file_checksum text not null,
  storage_path text not null,
  sheet_name text,
  row_count int,
  mapping_template_id uuid references import_mapping_templates(id),

  status text not null default 'uploaded',
  valid_count int not null default 0,
  warning_count int not null default 0,
  error_count int not null default 0,
  duplicate_count int not null default 0,
  inserted_count int not null default 0,
  updated_count int not null default 0,
  skipped_count int not null default 0,

  auto_process_downstream boolean not null default false,
  auto_process_cluster_k int,
  downstream_status text,

  processing_lock_token uuid,
  processing_lock_expires_at timestamptz,
  next_chunk_offset int not null default 0,

  failure_reason text,
  uploaded_at timestamptz not null default now(),
  confirmed_at timestamptz,
  completed_at timestamptz,

  constraint import_batches_status_valid check (status in (
    'uploaded', 'analyzing', 'awaiting_mapping', 'validating', 'ready_to_import',
    'importing', 'imported', 'processing_features', 'clustering', 'allocating',
    'completed', 'completed_with_warnings', 'failed', 'rolled_back'
  )),
  constraint import_batches_auto_process_k_required check (
    not auto_process_downstream or auto_process_cluster_k is not null
  ),
  constraint import_batches_cluster_k_positive check (auto_process_cluster_k is null or auto_process_cluster_k > 0)
);

create table import_column_mappings (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references import_batches(id) on delete cascade,
  source_column_index int not null,
  source_column_header text not null,
  target_kind text not null,
  target_key text,
  confidence numeric,
  is_manual_override boolean not null default false,

  constraint import_column_mappings_target_kind_valid check (target_kind in ('core_field', 'known_answer', 'generic_answer', 'ignored')),
  constraint import_column_mappings_confidence_range check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint import_column_mappings_unique unique (import_batch_id, source_column_index)
);

create table import_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references import_batches(id) on delete cascade,
  excel_row_number int not null,
  row_fingerprint text not null,
  raw_row jsonb not null,
  normalized_row jsonb,

  validation_status text not null default 'pending',
  warnings jsonb not null default '[]'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  duplicate_status text,
  duplicate_of_row_id uuid references import_rows(id),

  destination_application_id uuid references applications(id),
  action_taken text,

  previous_application_snapshot jsonb,
  previous_answers_snapshot jsonb,

  constraint import_rows_validation_status_valid check (validation_status in ('pending', 'valid', 'warning', 'invalid')),
  constraint import_rows_duplicate_status_valid check (duplicate_status is null or duplicate_status in ('duplicate_in_file', 'existing_unclaimed', 'existing_claimed', 'blocked_downstream')),
  constraint import_rows_action_taken_valid check (action_taken is null or action_taken in ('inserted', 'updated', 'skipped_unchanged', 'skipped_error', 'blocked')),
  constraint import_rows_unique_row unique (import_batch_id, excel_row_number)
);

create index import_rows_batch_idx on import_rows (import_batch_id);
create index import_rows_fingerprint_idx on import_rows (row_fingerprint);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726102000_import_staging_tables')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726103000_import_fk_backfill.sql
-- ============================================================
-- import_fk_backfill.sql
-- import_batches didn't exist yet when applications/application_answers
-- were created (Task 1) — add the deferred FKs now that it does.
alter table applications add constraint applications_import_batch_fkey
  foreign key (import_batch_id) references import_batches(id);
alter table application_answers add constraint application_answers_import_batch_fkey
  foreign key (import_batch_id) references import_batches(id);

-- import_batches.mapping_template_id references import_mapping_templates,
-- already satisfied within the same migration file in Task 2 Step 1 (both
-- tables created in the same file, template table first) — no backfill
-- needed for that one.


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726103000_import_fk_backfill')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726103500_import_rows_fk_and_index_fixes.sql
-- ============================================================
-- import_rows_fk_and_index_fixes.sql
--
-- Fixes two real issues found in code-quality review of
-- 20260726102000_import_staging_tables.sql, before any later task builds on
-- top of the gap:
--
-- 1. import_rows.destination_application_id had no `on delete` clause
--    (default NO ACTION/restrict). Task 16's rollback hard-deletes the
--    `applications` row for every batch-inserted row, but every
--    successfully-imported row's import_rows entry still points at that
--    application via destination_application_id — the delete would be
--    rejected by this FK the moment rollback tried it. `on delete set null`
--    (matching the schedule_publication_items.session_id precedent) lets the
--    staging row survive as an audit trail after rollback, with its
--    destination reference cleared rather than blocking the delete.
-- 2. import_rows.duplicate_of_row_id and import_batches.status had no
--    supporting index despite being explicit query-pattern targets later in
--    the plan (dedup reverse-lookup in the preview UI, status-filtered
--    admin history list).
alter table import_rows drop constraint import_rows_destination_application_id_fkey;
alter table import_rows add constraint import_rows_destination_application_id_fkey
  foreign key (destination_application_id) references applications(id) on delete set null;

create index import_rows_duplicate_of_row_idx on import_rows (duplicate_of_row_id);
create index import_batches_status_idx on import_batches (status);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726103500_import_rows_fk_and_index_fixes')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726104000_participant_invitations_table.sql
-- ============================================================
-- participant_invitations_table.sql
create table participant_invitations (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  imported_email text not null,
  invited_user_id uuid references profiles(id),

  status text not null default 'not_sent',
  sent_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz,
  last_error text,
  sent_by uuid references profiles(id),
  resend_count int not null default 0,

  constraint participant_invitations_status_valid check (status in (
    'not_sent', 'sending', 'sent', 'accepted', 'expired', 'revoked', 'failed'
  )),
  constraint participant_invitations_one_per_application unique (application_id)
);

create index participant_invitations_invited_user_idx on participant_invitations (invited_user_id);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726104000_participant_invitations_table')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726104500_participant_invitations_fk_fix.sql
-- ============================================================
-- participant_invitations_fk_fix.sql
--
-- Fixes a real bug found in code-quality review of
-- 20260726104000_participant_invitations_table.sql — the same bug class
-- already found and fixed once in this phase for
-- import_rows.destination_application_id (see
-- 20260726103500_import_rows_fk_and_index_fixes.sql).
--
-- participant_invitations.invited_user_id had no `on delete` clause
-- (default NO ACTION/restrict). revokeInvitation (a later task) calls
-- admin.auth.admin.deleteUser(invitation.invited_user_id) for unclaimed
-- invitations — profiles.id references auth.users(id) on delete cascade, so
-- deleting the auth.users row cascades to delete the profiles row, which
-- this FK would then block. `on delete set null` lets the invitation row
-- survive (with status already set to 'revoked' by the caller before the
-- delete, so no meaningful state is lost by nulling the now-deleted user's
-- id) rather than blocking the revoke.
alter table participant_invitations drop constraint participant_invitations_invited_user_id_fkey;
alter table participant_invitations add constraint participant_invitations_invited_user_id_fkey
  foreign key (invited_user_id) references profiles(id) on delete set null;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726104500_participant_invitations_fk_fix')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726105000_import_rls_policies.sql
-- ============================================================
-- import_rls_policies.sql
alter table import_batches enable row level security;
alter table import_column_mappings enable row level security;
alter table import_rows enable row level security;
alter table import_mapping_templates enable row level security;
alter table application_answers enable row level security;
alter table participant_invitations enable row level security;

-- Staff-only tables: no participant ever has a legitimate reason to read
-- these. Default-deny (no participant policy) covers every operation for
-- the participant role automatically. Mirrors
-- schedule_change_events_staff_all / schedule_publication_drafts_staff_all.
create policy import_batches_staff_all on import_batches
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy import_column_mappings_staff_all on import_column_mappings
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy import_rows_staff_all on import_rows
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy import_mapping_templates_staff_all on import_mapping_templates
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy participant_invitations_staff_all on participant_invitations
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

-- application_answers: two-tier. Ordinary (non-sensitive) answers are
-- readable/writable by import-capable staff for allocation review.
-- Sensitive answers (accessibility/dietary/emergency-contact/special-needs)
-- are super_admin only — narrower than ordinary answers.
create policy application_answers_staff_all on application_answers
  for all using (
    not is_sensitive and current_user_role() in ('agenda_allocation_manager', 'super_admin')
  );
create policy application_answers_sensitive_staff_all on application_answers
  for all using (is_sensitive and current_user_role() = 'super_admin');

-- Participant self-read: own application's non-sensitive answers only,
-- select-only. Symmetric with applications_select_own. Because applicant_id
-- is null until claim, applications.applicant_id = auth.uid() cannot match
-- any authenticated session for an unclaimed row — this is what makes
-- unclaimed imported answers unreadable by anyone but staff, with zero new
-- RLS logic beyond this existing pattern.
create policy application_answers_select_own on application_answers
  for select using (
    not is_sensitive
    and application_id in (select id from applications where applicant_id = auth.uid())
  );


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726105000_import_rls_policies')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726105500_explicit_answers_with_check.sql
-- ============================================================
-- explicit_answers_with_check.sql
--
-- A security-focused code-quality review found that
-- application_answers_staff_all / application_answers_sensitive_staff_all
-- (20260726105000_import_rls_policies.sql) omit an explicit WITH CHECK
-- clause on their FOR ALL policies. Postgres reuses USING as WITH CHECK
-- automatically when WITH CHECK is omitted — the review traced this through
-- concretely (an agenda_allocation_manager attempting to INSERT a row with
-- is_sensitive = true is correctly rejected, since the reused check clause
-- `not is_sensitive and ...` evaluates false) and found no exploitable gap.
-- Still, relying on that implicit reuse in a security-critical policy file
-- is a maintainability risk (silently breaks if a future policy author adds
-- an explicit narrower WITH CHECK to one sibling without mirroring it) —
-- making both checks explicit removes the ambiguity with zero behavior
-- change, confirmed by the review's own trace.
drop policy application_answers_staff_all on application_answers;
create policy application_answers_staff_all on application_answers
  for all
  using (not is_sensitive and current_user_role() in ('agenda_allocation_manager', 'super_admin'))
  with check (not is_sensitive and current_user_role() in ('agenda_allocation_manager', 'super_admin'));

drop policy application_answers_sensitive_staff_all on application_answers;
create policy application_answers_sensitive_staff_all on application_answers
  for all
  using (is_sensitive and current_user_role() = 'super_admin')
  with check (is_sensitive and current_user_role() = 'super_admin');


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726105500_explicit_answers_with_check')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726106000_import_storage_bucket.sql
-- ============================================================
-- import_storage_bucket.sql
insert into storage.buckets (id, name, public) values ('import-uploads', 'import-uploads', false);

-- Staff-only access to the bucket's objects, mirroring the table RLS
-- convention. Supabase Storage RLS applies to storage.objects, scoped by
-- bucket_id.
create policy import_uploads_staff_read on storage.objects
  for select using (bucket_id = 'import-uploads' and current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy import_uploads_staff_write on storage.objects
  for insert with check (bucket_id = 'import-uploads' and current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy import_uploads_staff_delete on storage.objects
  for delete using (bucket_id = 'import-uploads' and current_user_role() in ('agenda_allocation_manager', 'super_admin'));


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726106000_import_storage_bucket')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726106500_import_storage_policy_consolidation.sql
-- ============================================================
-- import_storage_policy_consolidation.sql
--
-- A code-quality review found the original per-verb (select/insert/delete)
-- policy split on storage.objects was a real, if safe, deviation from this
-- phase's established convention of a single `for all` policy per staff-only
-- resource (see import_rls_policies.sql, every policy there uses `for all`).
-- It also meant UPDATE had no matching policy — Postgres RLS default-denies
-- any unmatched operation, so this was never an access-control hole, but it
-- would silently break a future `upsert: true` call (Supabase Storage
-- performs an UPDATE under the hood for an upsert), which is easy to miss
-- since nothing about the omission was intentional-looking versus
-- oversight-looking. Consolidated into one `for all` policy per operation
-- type actually needed (select/insert/update/delete, all staff-gated),
-- matching the rest of this phase's RLS style exactly.
drop policy import_uploads_staff_read on storage.objects;
drop policy import_uploads_staff_write on storage.objects;
drop policy import_uploads_staff_delete on storage.objects;

create policy import_uploads_staff_all on storage.objects
  for all using (bucket_id = 'import-uploads' and current_user_role() in ('agenda_allocation_manager', 'super_admin'))
  with check (bucket_id = 'import-uploads' and current_user_role() in ('agenda_allocation_manager', 'super_admin'));


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726106500_import_storage_policy_consolidation')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726107000_import_unique_identifier_column.sql
-- ============================================================
-- import_unique_identifier_column.sql
alter table import_batches add column unique_identifier_column_index int;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726107000_import_unique_identifier_column')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726108000_apply_import_row_function.sql
-- ============================================================
-- apply_import_row_function.sql
--
-- Task 15, Step 2. The entire per-row import apply, as ONE Postgres
-- transaction.
--
-- Why this exists at all: the plan's illustrative `applyImportRow` did the
-- before-image snapshot capture and the overwrite as two separate supabase-js
-- `await` calls. That is not atomic — a concurrent reader/writer can observe
-- (or interleave with) the half-applied state between them, and a crash
-- between the two leaves an application overwritten with NO recoverable
-- snapshot, which silently breaks Task 16's rollback. supabase-js has no
-- client-side multi-statement transaction primitive, so a plpgsql function is
-- the correct mechanism, exactly as Phase 5's
-- confirm_publication_transactional established.
--
-- Atomicity guarantee: PostgREST executes each RPC call inside its own
-- transaction, and a plpgsql function body runs entirely within the calling
-- transaction. This function deliberately contains NO exception-handling
-- block, so any error raised anywhere inside it aborts the whole call and
-- rolls back every write it made — snapshot, application insert/update,
-- answers, status history, and the import_rows.action_taken stamp either all
-- land together or none of them do. (An `exception when others` block here
-- would create an implicit subtransaction that could swallow a real error and
-- commit a partial apply — precisely what must not happen. Same reasoning
-- documented in confirm_publication_transactional.)
--
-- Idempotency / re-entrancy: the function takes a row-level FOR UPDATE lock
-- on the import_rows row and returns 'already_applied' if action_taken is
-- already set. A duplicate/retried chunk call therefore cannot produce a
-- second application for the same source row. This is the last line of
-- defence behind the batch-level lock token in actions.ts.

create function apply_import_row_transactional(
  p_import_row_id uuid,
  p_import_batch_id uuid,
  p_actor_id uuid
) returns text as $$
declare
  v_row import_rows;
  v_normalized jsonb;
  v_email text;
  v_application_id uuid;
  v_previous_application jsonb;
  v_previous_answers jsonb;
  v_raw_values jsonb;
  v_key text;
  v_value jsonb;
  v_is_array boolean;
  v_application_number text;
  -- Columns that genuinely exist on `applications` today. Re-derived
  -- column-by-column against 20260721202027_applications_table.sql and
  -- src/types/database.ts's applications Row type at implementation time
  -- rather than trusting the plan's comment, as the plan required.
  --
  -- Deviation from the plan's KNOWN_APPLICATION_COLUMNS list, both
  -- directions:
  --   * REMOVED 'topics_to_learn' from the array-typed handling: the plan
  --     lists it as a known column (it is one — `text`), but
  --     row-validation.ts's MULTISELECT_KEYS normalizes it to a JSON ARRAY.
  --     Writing an array into a `text` column would either error or stringify
  --     unpredictably, so it is handled as a scalar text column below and the
  --     array form is joined back to a comma-separated string. The full
  --     structured array is still preserved losslessly in
  --     application_answers.normalized_value as JSON.
  --   * ADDED the columns the plan's list omitted but which really exist and
  --     can legitimately be imported: climate_experience, past_initiatives,
  --     participation_goals, content_type_pref, priority_sessions,
  --     special_needs, track_interests.
  -- Text[]-typed application columns (interests, track_interests) are the
  -- only ones that take the array form directly.
  v_text_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs'
  ];
  v_array_columns text[] := array['interests', 'track_interests'];
  v_update_sql text;
  v_set_clauses text[] := array[]::text[];
begin
  -- Lock this import row for the duration of the transaction. Two concurrent
  -- callers that somehow both reach the same row (stale lock token, retried
  -- chunk) serialize here, and the second one sees action_taken already set.
  select * into v_row from import_rows
  where id = p_import_row_id and import_batch_id = p_import_batch_id
  for update;

  if v_row.id is null then
    raise exception 'Import row % not found in batch %', p_import_row_id, p_import_batch_id;
  end if;

  -- Already applied by an earlier (or concurrent, now-serialized) call.
  -- Returning a distinct sentinel rather than raising lets the caller treat a
  -- retry as a clean no-op instead of failing an entire chunk.
  if v_row.action_taken is not null then
    return 'already_applied';
  end if;

  if v_row.validation_status = 'invalid' then
    update import_rows set action_taken = 'skipped_error' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'blocked_downstream' then
    update import_rows set action_taken = 'blocked' where id = v_row.id;
    return 'skipped';
  end if;

  -- A within-file duplicate must not be applied twice: the FIRST occurrence
  -- of the email carries duplicate_status null and is imported normally; this
  -- later occurrence is skipped. Without this branch the second row would
  -- fall through to the insert path and violate
  -- applications_imported_email_unclaimed_unique, failing the whole chunk.
  -- The plan's illustrative code omitted this case entirely — an additional
  -- gap found during implementation, not one of the three flagged ones.
  if v_row.duplicate_status = 'duplicate_in_file' then
    update import_rows set action_taken = 'skipped_unchanged' where id = v_row.id;
    return 'skipped';
  end if;

  v_normalized := coalesce(v_row.normalized_row, '{}'::jsonb);
  v_email := v_normalized->>'email';
  if v_email is null or v_email = '' then
    raise exception 'Import row % has no normalized email but passed validation', v_row.id;
  end if;

  -- GAP #2 RESOLUTION: re-derive the TRUE original cell text for every mapped
  -- column from import_rows.raw_row (the stored original cell array, written
  -- by Task 14) joined against this batch's import_column_mappings, keyed by
  -- target_key. This is the real pre-normalization value the admin typed,
  -- NOT the normalized value the plan's draft incorrectly reused.
  --
  -- Chosen over extending Task 10's RowValidationResult because raw_row +
  -- the mapping are both already persisted and are the authoritative record
  -- of the source cell; deriving here keeps the raw value correct even for
  -- rows validated before this task existed, and avoids a signature change
  -- rippling through Task 14's caller. `->>` on a jsonb array by integer
  -- index yields the element as text (null when absent/JSON null).
  select coalesce(jsonb_object_agg(m.target_key, to_jsonb(v_row.raw_row->>m.source_column_index)), '{}'::jsonb)
  into v_raw_values
  from import_column_mappings m
  where m.import_batch_id = p_import_batch_id
    and m.target_key is not null
    and m.target_kind <> 'ignored';

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    ------------------------------------------------------------------
    -- UPDATE PATH
    ------------------------------------------------------------------
    v_application_id := v_row.destination_application_id;
    if v_application_id is null then
      raise exception 'Import row % is marked % but has no destination_application_id', v_row.id, v_row.duplicate_status;
    end if;

    -- Lock the target application, then capture the before-image. Both the
    -- snapshot and the overwrite below happen inside this one transaction
    -- with the row held, so no concurrent writer can slip between them —
    -- this is precisely the interleaving the plan's two-await draft allowed.
    perform 1 from applications where id = v_application_id for update;

    select to_jsonb(a.*) into v_previous_application from applications a where a.id = v_application_id;
    if v_previous_application is null then
      raise exception 'Destination application % for import row % no longer exists', v_application_id, v_row.id;
    end if;

    select coalesce(jsonb_agg(to_jsonb(aa.*)), '[]'::jsonb) into v_previous_answers
    from application_answers aa where aa.application_id = v_application_id;

    -- Snapshot is persisted BEFORE the overwrite statements below, in the
    -- same transaction, so Task 16's rollback always has a recoverable
    -- before-image for anything this function changed.
    update import_rows set
      action_taken = 'updated',
      previous_application_snapshot = v_previous_application,
      previous_answers_snapshot = v_previous_answers,
      destination_application_id = v_application_id
    where id = v_row.id;
  else
    ------------------------------------------------------------------
    -- INSERT PATH
    ------------------------------------------------------------------
    v_application_number := next_application_number();

    insert into applications (applicant_id, imported_email, import_batch_id, status, application_number)
    values (null, v_email, p_import_batch_id, 'accepted', v_application_number)
    returning id into v_application_id;

    update import_rows set
      action_taken = 'inserted',
      destination_application_id = v_application_id
    where id = v_row.id;
  end if;

  ------------------------------------------------------------------
  -- Apply the mapped column values to `applications` (both paths).
  -- Built as a dynamic UPDATE so only keys actually present in the
  -- normalized row are touched — an absent column must keep its existing
  -- value on the update path rather than being nulled out.
  ------------------------------------------------------------------
  foreach v_key in array v_text_columns loop
    if v_normalized ? v_key then
      v_value := v_normalized->v_key;
      v_is_array := jsonb_typeof(v_value) = 'array';
      -- An array-normalized value (topics_to_learn) collapses to a
      -- comma-separated string for its text column; the structured form
      -- survives in application_answers.
      v_set_clauses := v_set_clauses || format(
        '%I = %L',
        v_key,
        case
          when v_value is null or jsonb_typeof(v_value) = 'null' then null
          when v_is_array then (select string_agg(e, ', ') from jsonb_array_elements_text(v_value) as e)
          else v_value #>> '{}'
        end
      );
    end if;
  end loop;

  foreach v_key in array v_array_columns loop
    if v_normalized ? v_key then
      v_value := v_normalized->v_key;
      v_set_clauses := v_set_clauses || format(
        '%I = %L::text[]',
        v_key,
        case
          when v_value is null or jsonb_typeof(v_value) = 'null' then null
          when jsonb_typeof(v_value) = 'array' then (
            select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_value) as e
          )
          -- A scalar arriving for an array column (mapping produced a plain
          -- string) is wrapped rather than dropped.
          else array[v_value #>> '{}']
        end
      );
    end if;
  end loop;

  -- birth_date is handled separately: it is a `date` column and the
  -- normalized value is free text from a spreadsheet cell. A non-parseable
  -- value must not abort the whole import, so it is cast defensively and
  -- simply left unset (still preserved verbatim in application_answers) when
  -- it cannot be interpreted as a date.
  if v_normalized ? 'birth_date' then
    declare
      v_birth_raw text := v_normalized->>'birth_date';
      v_birth_date date;
    begin
      if v_birth_raw is not null and v_birth_raw <> '' then
        begin
          v_birth_date := v_birth_raw::date;
          v_set_clauses := v_set_clauses || format('birth_date = %L::date', v_birth_date);
        exception when others then
          -- Unparseable date: skip the typed column only. This is the one
          -- place an exception block is appropriate and safe — it guards a
          -- single pure cast with no side effects, and swallowing it cannot
          -- hide a partial write.
          null;
        end;
      end if;
    end;
  end if;

  if array_length(v_set_clauses, 1) > 0 then
    v_update_sql := format(
      'update applications set %s where id = %L',
      array_to_string(v_set_clauses, ', '),
      v_application_id
    );
    execute v_update_sql;
  end if;

  ------------------------------------------------------------------
  -- application_answers upsert: every key present in the normalized row,
  -- with raw_value sourced from v_raw_values (gap #2).
  ------------------------------------------------------------------
  for v_key, v_value in select * from jsonb_each(v_normalized) loop
    insert into application_answers (
      application_id, question_key, normalized_value, raw_value, value_type,
      source, is_sensitive, import_batch_id
    ) values (
      v_application_id,
      v_key,
      case
        when jsonb_typeof(v_value) = 'string' then v_value #>> '{}'
        else v_value::text
      end,
      -- raw_value is NOT NULL on this table. The true original cell text is
      -- used whenever the column was mapped; when a normalized key has no
      -- corresponding source column (nothing produces this today, but a
      -- future derived key would), fall back to the normalized rendering so
      -- the NOT NULL constraint can never abort a whole import.
      coalesce(
        v_raw_values->>v_key,
        case
          when jsonb_typeof(v_value) = 'string' then v_value #>> '{}'
          else v_value::text
        end
      ),
      case when jsonb_typeof(v_value) = 'array' then 'multiselect' else 'text' end,
      'import',
      v_key in (
        'accessibility_requirements', 'dietary_requirements',
        'emergency_contact_name', 'emergency_contact_phone', 'special_needs'
      ),
      p_import_batch_id
    )
    on conflict (application_id, question_key, source) do update set
      normalized_value = excluded.normalized_value,
      raw_value = excluded.raw_value,
      value_type = excluded.value_type,
      is_sensitive = excluded.is_sensitive,
      import_batch_id = excluded.import_batch_id;
  end loop;

  ------------------------------------------------------------------
  -- Status history + audit trail, same transaction.
  ------------------------------------------------------------------
  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    insert into application_status_history (application_id, old_status, new_status, changed_by, note)
    values (
      v_application_id,
      (v_previous_application->>'status')::application_status,
      'accepted',
      p_actor_id,
      format('Updated by import batch %s', p_import_batch_id)
    );
  else
    insert into application_status_history (application_id, old_status, new_status, changed_by, note)
    values (v_application_id, null, 'accepted', p_actor_id, format('Created by import batch %s', p_import_batch_id));
  end if;

  -- Audited inside the transaction rather than via writeAuditLog from JS:
  -- an audit row written outside this transaction could survive a rolled-back
  -- apply (claiming a write that never happened) or be lost after a committed
  -- one. Column set matches writeAuditLog's own insert in
  -- src/lib/agenda/server-helpers.ts.
  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'application',
    v_application_id,
    case when v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then 'import_update' else 'import_insert' end,
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_import_batch_id, 'importRowId', v_row.id)
  );

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    return 'updated';
  end if;
  return 'inserted';
end;
$$ language plpgsql set search_path = public, pg_temp;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726108000_apply_import_row_function')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726108500_apply_import_row_sensitive_keys_comment.sql
-- ============================================================
-- apply_import_row_sensitive_keys_comment.sql
--
-- Code-quality review of Task 15 flagged that the is_sensitive key list
-- inlined in apply_import_row_transactional's application_answers insert
-- (accessibility_requirements, dietary_requirements, emergency_contact_name,
-- emergency_contact_phone, special_needs) is now a THIRD copy of the same
-- set already declared once in src/lib/validation/import.ts as
-- SENSITIVE_QUESTION_KEYS ("single source of truth... so the two never
-- drift") and once in tests/rls/import.test.ts's fixture. SQL cannot import
-- a TypeScript constant, so this cannot be de-duplicated outright — but
-- since RLS keys off is_sensitive to gate a genuinely sensitive-data column
-- (see application_answers_sensitive_staff_all in
-- 20260726105000_import_rls_policies.sql), silent drift between these three
-- copies would be a privacy leak, not just a bug. This migration adds an
-- explicit cross-reference comment directly above the list so any future
-- edit to SENSITIVE_QUESTION_KEYS is more likely to be noticed here too.
comment on function apply_import_row_transactional(uuid, uuid, uuid) is
  'Per-row transactional import apply (Task 15). The is_sensitive key list '
  'inlined in this function''s application_answers insert must be kept in '
  'sync with SENSITIVE_QUESTION_KEYS in src/lib/validation/import.ts and the '
  'fixture in tests/rls/import.test.ts — all three currently list '
  'accessibility_requirements, dietary_requirements, emergency_contact_name, '
  'emergency_contact_phone, special_needs. If you change one, change all '
  'three.';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726108500_apply_import_row_sensitive_keys_comment')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726109000_rollback_import_batch_function.sql
-- ============================================================
-- rollback_import_batch_function.sql
--
-- Task 16, Step 1. Undo an entire import batch, as ONE Postgres transaction.
--
-- Atomicity guarantee: identical reasoning to
-- apply_import_row_transactional (20260726108000). PostgREST executes each
-- RPC call inside its own transaction and a plpgsql function body runs
-- entirely within the calling transaction. This function deliberately
-- contains NO exception-handling block around any write, so any error raised
-- anywhere inside it aborts the whole call and rolls back every write it
-- made. An `exception when others` block would create an implicit
-- subtransaction that could swallow a real error and commit a PARTIAL
-- rollback — a half-undone import is strictly worse than a refused one,
-- because the admin would have no way to tell which rows were reverted.
--
-- Safety model: this function is all-or-nothing by construction. Every
-- blocking check runs BEFORE the first write, and any blocker raises, so a
-- refused rollback provably touches nothing. This is why the checks are not
-- interleaved with the per-row restoration loop.

create function rollback_import_batch_transactional(
  p_batch_id uuid,
  p_actor_id uuid
) returns void as $$
declare
  v_batch import_batches;
  v_blocker_count int;
  v_blocker_detail text;
  v_scope_application_ids uuid[];
  v_row record;
  v_snapshot jsonb;
  v_answers jsonb;
  v_application_id uuid;
  v_old_status application_status;
  v_update_sql text;
  v_set_clauses text[];
  v_key text;
  -- Columns restored from previous_application_snapshot. Deliberately a
  -- fixed allowlist rather than "every key in the snapshot": the snapshot is
  -- to_jsonb(applications.*), which also contains id, applicant_id,
  -- created_at, application_number, import_batch_id and imported_email.
  -- Restoring id/applicant_id/application_number would be meaningless or
  -- actively harmful (identity churn, unique-index collisions), and
  -- created_at must not move. This list is exactly the set of columns
  -- apply_import_row_transactional is capable of WRITING on the update path
  -- (its v_text_columns + v_array_columns + birth_date + status), so it
  -- restores precisely what the import could have changed and nothing else.
  -- Kept deliberately in sync with that function's lists; see the
  -- COMMENT ON FUNCTION at the bottom of this file.
  v_restorable_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs',
    'birth_date'
  ];
  v_array_columns text[] := array['interests', 'track_interests'];
begin
  ------------------------------------------------------------------
  -- Lock the batch. Serializes two concurrent rollback attempts and, more
  -- importantly, serializes against anything else keying off batch status.
  -- The second caller finds status already 'rolled_back' and is rejected
  -- below rather than double-restoring.
  ------------------------------------------------------------------
  select * into v_batch from import_batches where id = p_batch_id for update;

  if v_batch.id is null then
    raise exception 'Import batch % not found', p_batch_id;
  end if;

  if v_batch.status = 'rolled_back' then
    raise exception 'Import batch % has already been rolled back', p_batch_id;
  end if;

  ------------------------------------------------------------------
  -- BLOCKING CHECKS. All of these run before ANY write. Each names the
  -- specific blocking dependency in its message, because a generic "cannot
  -- roll back" gives the admin no path forward — they need to know which
  -- downstream artifact to retract first.
  --
  -- Each check joins through applications.import_batch_id = p_batch_id.
  -- Note this deliberately covers applications the batch INSERTED. Rows the
  -- batch merely UPDATED keep whatever import_batch_id they had, so a
  -- pre-existing application that the batch updated is matched via
  -- import_rows.destination_application_id instead — both sets are unioned
  -- into v_batch_application_ids below so no application in scope is missed.
  ------------------------------------------------------------------
  -- Held as a plain uuid[] local rather than a temporary table: a temp table
  -- would persist for the session under PostgREST's connection pooling if a
  -- later statement ever ran outside this transaction, and `on commit drop`
  -- makes the function non-reentrant within one transaction. An array is
  -- transaction-agnostic and these batches are bounded by spreadsheet size.
  select coalesce(array_agg(distinct id), array[]::uuid[])
  into v_scope_application_ids
  from (
    select a.id
    from applications a
    where a.import_batch_id = p_batch_id
    union
    select r.destination_application_id as id
    from import_rows r
    where r.import_batch_id = p_batch_id
      and r.destination_application_id is not null
      and r.action_taken in ('inserted', 'updated')
  ) scope;

  -- 1. Feature extraction
  select count(*) into v_blocker_count
  from participant_feature_snapshots s
  where s.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_feature_snapshots row(s) reference applications from this batch. Delete the feature extraction run first.',
      p_batch_id, v_blocker_count;
  end if;

  -- 2. Clustering
  select count(*) into v_blocker_count
  from cluster_memberships c
  where c.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % cluster_memberships row(s) reference applications from this batch. Delete the clustering run first.',
      p_batch_id, v_blocker_count;
  end if;

  -- 3. Allocation
  select count(*) into v_blocker_count
  from allocation_assignments al
  where al.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % allocation_assignments row(s) reference applications from this batch. Delete the allocation run first.',
      p_batch_id, v_blocker_count;
  end if;

  -- 4. Schedule publication
  select count(*) into v_blocker_count
  from schedule_publications sp
  where sp.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publications row(s) reference applications from this batch. Retract the publication first.',
      p_batch_id, v_blocker_count;
  end if;

  -- 5. Participant invitations that have left 'not_sent'.
  --
  -- REQUIRED per Task 3's post-implementation note, and the single most
  -- dangerous case in this function. participant_invitations.application_id
  -- is `on delete cascade` (verified against
  -- 20260726104000_participant_invitations_table.sql), so unlike checks 1-4
  -- — whose FKs are NO ACTION and would themselves refuse the delete — this
  -- one has NO database-level backstop. Without this explicit check a
  -- 'sent' or 'accepted' invitation would be silently deleted along with its
  -- application, destroying the record of an email already delivered to a
  -- real external person for whom a real Supabase Auth user already exists.
  -- The invitation row would vanish with no trace and no way to reconcile
  -- the orphaned Auth user. Blocking is mandatory; the FK must never be
  -- allowed to decide this.
  select count(*), string_agg(distinct pi.status, ', ' order by pi.status)
  into v_blocker_count, v_blocker_detail
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
    and pi.status <> 'not_sent';
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_invitations row(s) for applications in this batch are no longer in ''not_sent'' status (found: %). An invitation has already been sent to a real recipient and an auth user may exist for them; revoke the invitation(s) before rolling back.',
      p_batch_id, v_blocker_count, v_blocker_detail;
  end if;

  ------------------------------------------------------------------
  -- No blockers. Perform the rollback.
  --
  -- Rows are processed with FOR UPDATE on the import row, mirroring
  -- apply_import_row_transactional, so a rollback cannot interleave with a
  -- still-running chunked import writing the same rows.
  ------------------------------------------------------------------
  for v_row in
    select * from import_rows
    where import_batch_id = p_batch_id
      and action_taken in ('inserted', 'updated')
    order by excel_row_number
    for update
  loop
    v_application_id := v_row.destination_application_id;

    if v_row.action_taken = 'inserted' then
      ------------------------------------------------------------------
      -- INSERT PATH: hard-delete the application the import created.
      --
      -- application_answers, application_status_history (and email_log) all
      -- carry `on delete cascade` on application_id — verified against
      -- 20260726101000_application_answers_table.sql and
      -- 20260721210419_status_history_and_email_log.sql — so they go with
      -- it. import_rows.destination_application_id is `on delete set null`
      -- (Task 2's follow-up fix, 20260726103500), so this staging row
      -- survives as an audit trail with its destination reference cleared,
      -- rather than the FK refusing the delete. Any not_sent
      -- participant_invitations row cascades away, which is correct: an
      -- unsent invitation has no external side effect. Sent ones were
      -- already refused above.
      --
      -- The audit row is written BEFORE the delete: audit_logs.entity_id has
      -- no FK to applications, but writing first keeps the ordering
      -- unambiguous and guarantees the audit exists in the same transaction
      -- as the deletion it describes. No status-history row is written for
      -- this path — it would cascade away with the application microseconds
      -- later, so it could never be read.
      ------------------------------------------------------------------
      if v_application_id is not null then
        insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
        values (
          'application',
          v_application_id,
          'import_rollback_delete',
          'admin',
          p_actor_id,
          jsonb_build_object(
            'batchId', p_batch_id,
            'importRowId', v_row.id,
            'excelRowNumber', v_row.excel_row_number
          )
        );

        delete from applications where id = v_application_id;
      end if;

    else
      ------------------------------------------------------------------
      -- UPDATE PATH: restore the application and its answers from the
      -- before-image snapshots apply_import_row_transactional captured.
      ------------------------------------------------------------------
      v_snapshot := v_row.previous_application_snapshot;

      if v_application_id is null or v_snapshot is null then
        -- An 'updated' row with no snapshot means Task 15's invariant (write
        -- the snapshot in the same transaction as the overwrite) was
        -- violated. There is no recoverable before-image, so restoring is
        -- impossible. Refuse the WHOLE rollback rather than silently leaving
        -- this application overwritten while reverting its neighbours.
        raise exception 'Cannot roll back import batch %: import row % is marked ''updated'' but has no recoverable snapshot (destination_application_id=%, previous_application_snapshot is null).',
          p_batch_id, v_row.id, v_application_id;
      end if;

      -- Lock the target application for the rest of the transaction, same
      -- as the apply path does, so no concurrent writer can interleave
      -- between the restore and the answers rebuild below.
      perform 1 from applications where id = v_application_id for update;

      -- Build the restoring UPDATE dynamically over the fixed allowlist.
      -- Every allowlisted column is set unconditionally — including to NULL
      -- when the snapshot's value was NULL. This is the crucial difference
      -- from the apply path, which only touches keys PRESENT in the
      -- incoming row: a restore must reinstate the exact prior tuple, so a
      -- column the import populated from empty must go back to empty. Using
      -- the apply path's "only if present" logic here would leave
      -- import-written values stranded in columns that were NULL before.
      v_set_clauses := array[]::text[];

      foreach v_key in array v_restorable_columns loop
        v_set_clauses := v_set_clauses || format('%I = %L', v_key, v_snapshot->>v_key);
      end loop;

      foreach v_key in array v_array_columns loop
        -- to_jsonb() renders a text[] column as a JSON array (or JSON null).
        -- Rebuild it as a real text[]; a NULL snapshot value restores NULL,
        -- which is distinct from an empty array and must stay distinct.
        v_set_clauses := v_set_clauses || format(
          '%I = %L::text[]',
          v_key,
          case
            when v_snapshot->v_key is null or jsonb_typeof(v_snapshot->v_key) = 'null' then null
            else (select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_snapshot->v_key) as e)
          end
        );
      end loop;

      -- status is an enum column and is restored explicitly with its cast.
      v_old_status := (v_snapshot->>'status')::application_status;
      v_set_clauses := v_set_clauses || format('status = %L::application_status', v_old_status);

      -- imported_email / import_batch_id are restored too: the apply path
      -- does not change them on the update path, but restoring them from the
      -- snapshot is harmless and keeps the tuple exactly as it was.
      v_update_sql := format(
        'update applications set %s where id = %L',
        array_to_string(v_set_clauses, ', '),
        v_application_id
      );
      execute v_update_sql;

      ------------------------------------------------------------------
      -- Restore application_answers.
      --
      -- THIS IS THE SUBTLEST PART OF THE FUNCTION. previous_answers_snapshot
      -- is jsonb_agg(to_jsonb(aa.*)) over ALL application_answers rows for
      -- this application at the instant before the import overwrote them
      -- (see apply_import_row_transactional's update path). It therefore
      -- contains complete rows, including their original `id`s.
      --
      -- A value-by-value "revert" would be WRONG: the import upserts one
      -- answer row per key in the normalized row, so it can CREATE answer
      -- rows for question_keys that did not exist before. Those rows have no
      -- counterpart in the snapshot, so reverting values alone would leave
      -- them behind as phantom answers that predate nothing.
      --
      -- The correct semantics are "make the answer set equal the snapshot":
      -- delete every current answer row for this application, then re-insert
      -- the snapshot rows verbatim, preserving their original ids. This
      -- necessarily drops import-created keys (not in the snapshot) and
      -- restores pre-existing ones to their exact prior tuple — including
      -- source, is_sensitive, question_label, value_type, import_batch_id and
      -- created_at, all of which the import's `on conflict do update` could
      -- have modified and none of which a value-only revert would restore.
      --
      -- Deleting ALL answers (not just source='import' ones) is intentional
      -- and safe precisely BECAUSE ids are preserved on re-insert: a
      -- manually-entered (source='manual') answer that existed pre-import is
      -- in the snapshot and comes back with the same id, so nothing that
      -- predates the import is lost. The only rows that fail to return are
      -- those that did not exist when the snapshot was taken — which is
      -- exactly the set that should not survive a rollback.
      --
      -- Known and accepted limitation: a manual answer added AFTER the
      -- import but BEFORE the rollback is also not in the snapshot and is
      -- therefore removed. Restoring a point-in-time snapshot cannot
      -- preserve later edits without merge semantics the plan does not
      -- define, and preserving them would make the restored state match
      -- neither the pre-import nor the post-import tuple. This is documented
      -- rather than silently handled.
      ------------------------------------------------------------------
      delete from application_answers where application_id = v_application_id;

      v_answers := coalesce(v_row.previous_answers_snapshot, '[]'::jsonb);

      insert into application_answers (
        id, application_id, question_key, question_label, normalized_value,
        raw_value, value_type, source, is_sensitive, import_batch_id,
        created_at, updated_at
      )
      select
        (e->>'id')::uuid,
        (e->>'application_id')::uuid,
        e->>'question_key',
        e->>'question_label',
        e->>'normalized_value',
        e->>'raw_value',
        e->>'value_type',
        e->>'source',
        (e->>'is_sensitive')::boolean,
        (e->>'import_batch_id')::uuid,
        (e->>'created_at')::timestamptz,
        (e->>'updated_at')::timestamptz
      from jsonb_array_elements(v_answers) as e;

      ------------------------------------------------------------------
      -- Document the restoration. Unlike the insert path, this application
      -- survives, so both a status-history row and an audit row are
      -- readable afterwards and both are written, as the plan requires.
      ------------------------------------------------------------------
      insert into application_status_history (application_id, old_status, new_status, changed_by, note)
      values (
        v_application_id,
        'accepted',
        v_old_status,
        p_actor_id,
        format('Restored by rollback of import batch %s', p_batch_id)
      );

      insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, new_values)
      values (
        'application',
        v_application_id,
        'import_rollback_restore',
        'admin',
        p_actor_id,
        jsonb_build_object(
          'batchId', p_batch_id,
          'importRowId', v_row.id,
          'excelRowNumber', v_row.excel_row_number,
          'restoredAnswerCount', jsonb_array_length(v_answers)
        ),
        v_snapshot
      );
    end if;

    -- Clear the applied state so the staging row reflects that its effect
    -- has been undone. action_taken is nulled rather than the row being
    -- deleted, keeping import_rows as a complete audit trail of what the
    -- batch did (and, via the surviving raw_row/normalized_row, what it
    -- would do if re-imported). The snapshots are cleared because they no
    -- longer describe a live overwrite and retaining them would imply a
    -- pending restore that has already happened.
    update import_rows set
      action_taken = null,
      previous_application_snapshot = null,
      previous_answers_snapshot = null
    where id = v_row.id;
  end loop;

  ------------------------------------------------------------------
  -- Mark the batch rolled back and zero the applied counters, which now
  -- describe writes that no longer exist.
  ------------------------------------------------------------------
  update import_batches set
    status = 'rolled_back',
    inserted_count = 0,
    updated_count = 0,
    skipped_count = 0,
    processing_lock_token = null,
    processing_lock_expires_at = null,
    next_chunk_offset = 0
  where id = p_batch_id;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'import_batch',
    p_batch_id,
    'import_rollback',
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_batch_id)
  );
end;
$$ language plpgsql set search_path = public, pg_temp;

comment on function rollback_import_batch_transactional(uuid, uuid) is
  'Task 16. Undoes an entire import batch atomically, or refuses entirely. '
  'Blocks on any participant_feature_snapshots / cluster_memberships / '
  'allocation_assignments / schedule_publications reference, and on any '
  'participant_invitations row whose status has left ''not_sent'' (that FK '
  'cascades, so it has no DB-level backstop — see Task 3''s note). '
  'v_restorable_columns MUST stay in sync with '
  'apply_import_row_transactional''s v_text_columns/v_array_columns '
  '(20260726108000_apply_import_row_function.sql): this function can only '
  'restore what that function can write. Update both together.';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726109000_rollback_import_batch_function')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726109500_tmp_introspect.sql
-- ============================================================
-- FK delete-rule verification probe (Task 16).
--
-- Task 16 required independently re-verifying, against the LIVE database,
-- that the FK delete rules the rollback function depends on are genuinely in
-- effect — the migration ledger showing a file as applied was explicitly not
-- accepted as sufficient, since this worktree previously had a case of a
-- migration file existing while the live state differed.
--
-- This migration created a temporary introspection function, which was
-- called once to read information_schema.referential_constraints, and is
-- dropped again at the bottom of this same file. It is retained (rather than
-- deleted) because it was already applied to the live database, so removing
-- it would desync the migration ledger for a from-scratch rebuild. It is a
-- no-op on any fresh database: the function is created and immediately
-- dropped, leaving no residue.
--
-- Verified results, live, on project deukwztsmcnxxchrdrfo:
--
--   SET NULL   import_rows.destination_application_id
--   CASCADE    application_answers.application_id
--   CASCADE    application_status_history.application_id
--   CASCADE    participant_invitations.application_id
--   NO ACTION  participant_feature_snapshots.application_id
--   NO ACTION  cluster_memberships.application_id
--   NO ACTION  allocation_assignments.application_id
--   NO ACTION  schedule_publications.application_id
--
-- Conclusions relied upon by
-- 20260726109000_rollback_import_batch_function.sql:
--   * Task 2's `on delete set null` fix on
--     import_rows.destination_application_id is genuinely live, NOT the
--     regressed NO ACTION the plan warned to check for. The rollback's
--     hard-delete of inserted applications will not be refused by that FK.
--   * application_answers / application_status_history really do cascade, so
--     the rollback does not need to delete them explicitly.
--   * participant_invitations really does CASCADE, confirming Task 3's
--     reported gap: without the rollback function's explicit
--     status <> 'not_sent' check, a sent invitation would be silently
--     destroyed. That check is load-bearing, not defensive.
--   * The four downstream pipeline tables are NO ACTION, so they would
--     refuse the delete at the FK level anyway — but the rollback function
--     still checks them first so the admin gets a specific, actionable
--     message naming the blocker instead of a raw FK violation.
create or replace function _tmp_fk_introspect() returns jsonb as $$
  select jsonb_agg(jsonb_build_object(
    'constraint', tc.constraint_name,
    'table', tc.table_name,
    'delete_rule', rc.delete_rule
  ))
  from information_schema.table_constraints tc
  join information_schema.referential_constraints rc on rc.constraint_name = tc.constraint_name
  where tc.constraint_name in (
    'import_rows_destination_application_id_fkey',
    'participant_invitations_application_id_fkey',
    'application_answers_application_id_fkey',
    'application_status_history_application_id_fkey',
    'participant_feature_snapshots_application_id_fkey',
    'cluster_memberships_application_id_fkey',
    'allocation_assignments_application_id_fkey',
    'schedule_publications_application_id_fkey'
  );
$$ language sql;

drop function _tmp_fk_introspect();


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726109500_tmp_introspect')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726109600_rollback_safety_fixes.sql
-- ============================================================
-- rollback_safety_fixes.sql
--
-- Dedicated code-quality review of Task 16 found three Important issues in
-- rollback_import_batch_transactional (20260726109000) and
-- apply_import_row_transactional (20260726108000). All three are fixed here
-- via `create or replace function` (both originals are already applied
-- live and immutable).

-- ---------------------------------------------------------------------
-- Fix 1 (review finding A2): apply_import_row_transactional had no guard
-- against being invoked on a batch that has already been rolled back.
-- rollback_import_batch_transactional clears import_rows.action_taken to
-- NULL when it undoes a row (see 20260726109000's comment on that choice),
-- which is exactly what apply_import_row_transactional's own
-- already_applied idempotency guard keys off of. A stale in-flight chunk
-- call, a client retry, or a resumed batch that races a rollback could
-- therefore see action_taken = null and silently RE-APPLY a row into a
-- batch the admin just rolled back, re-creating applications they just
-- deleted. The application-layer lock token in confirm/actions.ts is the
-- current defense, but the rollback itself clears that token (releasing
-- the mutual exclusion, not holding it) — there was no RPC-level backstop.
-- Fixed by checking the batch's status before doing anything else.
-- ---------------------------------------------------------------------
create or replace function apply_import_row_transactional(
  p_import_row_id uuid,
  p_import_batch_id uuid,
  p_actor_id uuid
) returns text as $$
declare
  v_batch_status text;
  v_row import_rows;
  v_normalized jsonb;
  v_email text;
  v_application_id uuid;
  v_previous_application jsonb;
  v_previous_answers jsonb;
  v_raw_values jsonb;
  v_key text;
  v_value jsonb;
  v_is_array boolean;
  v_application_number text;
  v_text_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs'
  ];
  v_array_columns text[] := array['interests', 'track_interests'];
  v_update_sql text;
  v_set_clauses text[] := array[]::text[];
begin
  -- NEW: refuse to apply into a rolled-back batch. Without this, a race
  -- between a rollback and a stale/retried chunk call could re-create
  -- applications the admin just deleted (review finding A2).
  select status into v_batch_status from import_batches where id = p_import_batch_id;
  if v_batch_status = 'rolled_back' then
    raise exception 'Import batch % has been rolled back; cannot apply row %', p_import_batch_id, p_import_row_id;
  end if;

  select * into v_row from import_rows
  where id = p_import_row_id and import_batch_id = p_import_batch_id
  for update;

  if v_row.id is null then
    raise exception 'Import row % not found in batch %', p_import_row_id, p_import_batch_id;
  end if;

  if v_row.action_taken is not null then
    return 'already_applied';
  end if;

  if v_row.validation_status = 'invalid' then
    update import_rows set action_taken = 'skipped_error' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'blocked_downstream' then
    update import_rows set action_taken = 'blocked' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'duplicate_in_file' then
    update import_rows set action_taken = 'skipped_unchanged' where id = v_row.id;
    return 'skipped';
  end if;

  v_normalized := coalesce(v_row.normalized_row, '{}'::jsonb);
  v_email := v_normalized->>'email';
  if v_email is null or v_email = '' then
    raise exception 'Import row % has no normalized email but passed validation', v_row.id;
  end if;

  select coalesce(jsonb_object_agg(m.target_key, to_jsonb(v_row.raw_row->>m.source_column_index)), '{}'::jsonb)
  into v_raw_values
  from import_column_mappings m
  where m.import_batch_id = p_import_batch_id
    and m.target_key is not null
    and m.target_kind <> 'ignored';

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    v_application_id := v_row.destination_application_id;
    if v_application_id is null then
      raise exception 'Import row % is marked % but has no destination_application_id', v_row.id, v_row.duplicate_status;
    end if;

    perform 1 from applications where id = v_application_id for update;

    select to_jsonb(a.*) into v_previous_application from applications a where a.id = v_application_id;
    if v_previous_application is null then
      raise exception 'Destination application % for import row % no longer exists', v_application_id, v_row.id;
    end if;

    select coalesce(jsonb_agg(to_jsonb(aa.*)), '[]'::jsonb) into v_previous_answers
    from application_answers aa where aa.application_id = v_application_id;

    update import_rows set
      action_taken = 'updated',
      previous_application_snapshot = v_previous_application,
      previous_answers_snapshot = v_previous_answers,
      destination_application_id = v_application_id
    where id = v_row.id;
  else
    v_application_number := next_application_number();

    insert into applications (applicant_id, imported_email, import_batch_id, status, application_number)
    values (null, v_email, p_import_batch_id, 'accepted', v_application_number)
    returning id into v_application_id;

    update import_rows set
      action_taken = 'inserted',
      destination_application_id = v_application_id
    where id = v_row.id;
  end if;

  foreach v_key in array v_text_columns loop
    if v_normalized ? v_key then
      v_value := v_normalized->v_key;
      v_is_array := jsonb_typeof(v_value) = 'array';
      v_set_clauses := v_set_clauses || format(
        '%I = %L',
        v_key,
        case
          when v_value is null or jsonb_typeof(v_value) = 'null' then null
          when v_is_array then (select string_agg(e, ', ') from jsonb_array_elements_text(v_value) as e)
          else v_value #>> '{}'
        end
      );
    end if;
  end loop;

  foreach v_key in array v_array_columns loop
    if v_normalized ? v_key then
      v_value := v_normalized->v_key;
      v_set_clauses := v_set_clauses || format(
        '%I = %L::text[]',
        v_key,
        case
          when v_value is null or jsonb_typeof(v_value) = 'null' then null
          when jsonb_typeof(v_value) = 'array' then (
            select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_value) as e
          )
          else array[v_value #>> '{}']
        end
      );
    end if;
  end loop;

  if v_normalized ? 'birth_date' then
    declare
      v_birth_raw text := v_normalized->>'birth_date';
      v_birth_date date;
    begin
      if v_birth_raw is not null and v_birth_raw <> '' then
        begin
          v_birth_date := v_birth_raw::date;
          v_set_clauses := v_set_clauses || format('birth_date = %L::date', v_birth_date);
        exception when others then
          null;
        end;
      end if;
    end;
  end if;

  if array_length(v_set_clauses, 1) > 0 then
    v_update_sql := format(
      'update applications set %s where id = %L',
      array_to_string(v_set_clauses, ', '),
      v_application_id
    );
    execute v_update_sql;
  end if;

  for v_key, v_value in select * from jsonb_each(v_normalized) loop
    insert into application_answers (
      application_id, question_key, normalized_value, raw_value, value_type,
      source, is_sensitive, import_batch_id
    ) values (
      v_application_id,
      v_key,
      case
        when jsonb_typeof(v_value) = 'string' then v_value #>> '{}'
        else v_value::text
      end,
      coalesce(
        v_raw_values->>v_key,
        case
          when jsonb_typeof(v_value) = 'string' then v_value #>> '{}'
          else v_value::text
        end
      ),
      case when jsonb_typeof(v_value) = 'array' then 'multiselect' else 'text' end,
      'import',
      v_key in (
        'accessibility_requirements', 'dietary_requirements',
        'emergency_contact_name', 'emergency_contact_phone', 'special_needs'
      ),
      p_import_batch_id
    )
    on conflict (application_id, question_key, source) do update set
      normalized_value = excluded.normalized_value,
      raw_value = excluded.raw_value,
      value_type = excluded.value_type,
      is_sensitive = excluded.is_sensitive,
      import_batch_id = excluded.import_batch_id;
  end loop;

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    insert into application_status_history (application_id, old_status, new_status, changed_by, note)
    values (
      v_application_id,
      (v_previous_application->>'status')::application_status,
      'accepted',
      p_actor_id,
      format('Updated by import batch %s', p_import_batch_id)
    );
  else
    insert into application_status_history (application_id, old_status, new_status, changed_by, note)
    values (v_application_id, null, 'accepted', p_actor_id, format('Created by import batch %s', p_import_batch_id));
  end if;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'application',
    v_application_id,
    case when v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then 'import_update' else 'import_insert' end,
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_import_batch_id, 'importRowId', v_row.id)
  );

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    return 'updated';
  end if;
  return 'inserted';
end;
$$ language plpgsql set search_path = public, pg_temp;

-- ---------------------------------------------------------------------
-- Fix 2 (review finding A3): the participant_invitations blocking check
-- was a plain, unlocked SELECT under READ COMMITTED. An invitation
-- transitioning not_sent -> sent in a concurrently-committing transaction,
-- between this check and the loop's cascade-delete, would not be seen —
-- and that FK has no DB-level backstop (CASCADE, not NO ACTION), so the
-- sent invitation would be silently destroyed. This is the exact outcome
-- the check exists to prevent, and the only one of the five blocking
-- checks with a real external side effect (a delivered email, an existing
-- Supabase Auth user for the recipient). Fixed by adding FOR UPDATE, so
-- any concurrent writer to a participant_invitations row in scope
-- serializes against this check rather than racing it.
--
-- Fix 3 (review finding A1): the blocking checks covered 4 downstream
-- pipeline tables but missed schedule_publication_draft_items.application_id
-- (NO ACTION, not null) — a real, reachable state, since the draft tables
-- exist precisely for the pre-publication review step. Without this check,
-- rollback would fail late with a raw "violates foreign key constraint"
-- error instead of one of the five friendly, actionable messages. Added as
-- check 6. (allocation_issues.application_id is also NO ACTION but
-- nullable and low-stakes; application_notes.application_id CASCADEs and
-- is now explicitly documented below as an accepted, low-stakes gap —
-- staff-authored commentary on an application that is itself being
-- deleted, no external side effect, unlike the invitations case.)
-- ---------------------------------------------------------------------
create or replace function rollback_import_batch_transactional(
  p_batch_id uuid,
  p_actor_id uuid
) returns void as $$
declare
  v_batch import_batches;
  v_blocker_count int;
  v_blocker_detail text;
  v_scope_application_ids uuid[];
  v_row record;
  v_snapshot jsonb;
  v_answers jsonb;
  v_application_id uuid;
  v_old_status application_status;
  v_update_sql text;
  v_set_clauses text[];
  v_key text;
  v_restorable_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs',
    'birth_date'
  ];
  v_array_columns text[] := array['interests', 'track_interests'];
begin
  select * into v_batch from import_batches where id = p_batch_id for update;

  if v_batch.id is null then
    raise exception 'Import batch % not found', p_batch_id;
  end if;

  if v_batch.status = 'rolled_back' then
    raise exception 'Import batch % has already been rolled back', p_batch_id;
  end if;

  select coalesce(array_agg(distinct id), array[]::uuid[])
  into v_scope_application_ids
  from (
    select a.id
    from applications a
    where a.import_batch_id = p_batch_id
    union
    select r.destination_application_id as id
    from import_rows r
    where r.import_batch_id = p_batch_id
      and r.destination_application_id is not null
      and r.action_taken in ('inserted', 'updated')
  ) scope;

  select count(*) into v_blocker_count
  from participant_feature_snapshots s
  where s.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_feature_snapshots row(s) reference applications from this batch. Delete the feature extraction run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from cluster_memberships c
  where c.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % cluster_memberships row(s) reference applications from this batch. Delete the clustering run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from allocation_assignments al
  where al.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % allocation_assignments row(s) reference applications from this batch. Delete the allocation run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from schedule_publications sp
  where sp.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publications row(s) reference applications from this batch. Retract the publication first.',
      p_batch_id, v_blocker_count;
  end if;

  -- NEW check 6 (review finding A1): schedule_publication_draft_items is
  -- NO ACTION and would otherwise abort the transaction with a raw FK
  -- error rather than a named, actionable blocker.
  select count(*) into v_blocker_count
  from schedule_publication_draft_items spdi
  where spdi.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publication_draft_items row(s) reference applications from this batch. Discard the schedule draft first.',
      p_batch_id, v_blocker_count;
  end if;

  -- Row lock added (review finding A3): serializes against a concurrent
  -- writer transitioning an invitation out of not_sent between this check
  -- and the delete below. participant_invitations.application_id CASCADEs
  -- with no DB-level backstop, so this check must not race. `FOR UPDATE`
  -- cannot be combined with aggregate functions in the same statement
  -- (Postgres rejects `count(*) ... for update` outright), so the lock is
  -- taken in a separate, non-aggregating statement first — the lock is
  -- held for the rest of this transaction regardless of which statement
  -- acquired it, so the subsequent aggregate query still runs under it.
  perform 1
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
  for update of pi;

  select count(*), string_agg(distinct pi.status, ', ' order by pi.status)
  into v_blocker_count, v_blocker_detail
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
    and pi.status <> 'not_sent';
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_invitations row(s) for applications in this batch are no longer in ''not_sent'' status (found: %). An invitation has already been sent to a real recipient and an auth user may exist for them; revoke the invitation(s) before rolling back.',
      p_batch_id, v_blocker_count, v_blocker_detail;
  end if;

  for v_row in
    select * from import_rows
    where import_batch_id = p_batch_id
      and action_taken in ('inserted', 'updated')
    order by excel_row_number
    for update
  loop
    v_application_id := v_row.destination_application_id;

    if v_row.action_taken = 'inserted' then
      if v_application_id is not null then
        insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
        values (
          'application',
          v_application_id,
          'import_rollback_delete',
          'admin',
          p_actor_id,
          jsonb_build_object(
            'batchId', p_batch_id,
            'importRowId', v_row.id,
            'excelRowNumber', v_row.excel_row_number
          )
        );

        -- application_notes.application_id CASCADEs (verified against
        -- 20260722170415_assigned_reviewer_and_notes.sql) and is not
        -- checked as a blocker: staff-authored review notes are internal
        -- commentary with no external side effect, unlike a sent
        -- invitation, and the application they annotate is itself being
        -- deleted here. Any notes are silently lost with this delete —
        -- an accepted, documented gap, not an oversight.
        delete from applications where id = v_application_id;
      end if;

    else
      v_snapshot := v_row.previous_application_snapshot;

      if v_application_id is null or v_snapshot is null then
        raise exception 'Cannot roll back import batch %: import row % is marked ''updated'' but has no recoverable snapshot (destination_application_id=%, previous_application_snapshot is null).',
          p_batch_id, v_row.id, v_application_id;
      end if;

      perform 1 from applications where id = v_application_id for update;

      -- Current status is read BEFORE the restoring UPDATE so the status-
      -- history row below records the real transition, not a fictitious
      -- accepted -> accepted (or accepted -> <snapshot status>, which was
      -- previously wrong whenever the pre-import status was not
      -- 'accepted' — the apply path's update branch never writes status,
      -- so this was silently inaccurate for any non-'accepted' pre-import
      -- application).
      select status into v_old_status from applications where id = v_application_id;

      v_set_clauses := array[]::text[];

      foreach v_key in array v_restorable_columns loop
        v_set_clauses := v_set_clauses || format('%I = %L', v_key, v_snapshot->>v_key);
      end loop;

      foreach v_key in array v_array_columns loop
        v_set_clauses := v_set_clauses || format(
          '%I = %L::text[]',
          v_key,
          case
            when v_snapshot->v_key is null or jsonb_typeof(v_snapshot->v_key) = 'null' then null
            else (select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_snapshot->v_key) as e)
          end
        );
      end loop;

      v_set_clauses := v_set_clauses || format('status = %L::application_status', (v_snapshot->>'status')::application_status);

      v_update_sql := format(
        'update applications set %s where id = %L',
        array_to_string(v_set_clauses, ', '),
        v_application_id
      );
      execute v_update_sql;

      delete from application_answers where application_id = v_application_id;

      v_answers := coalesce(v_row.previous_answers_snapshot, '[]'::jsonb);

      insert into application_answers (
        id, application_id, question_key, question_label, normalized_value,
        raw_value, value_type, source, is_sensitive, import_batch_id,
        created_at, updated_at
      )
      select
        (e->>'id')::uuid,
        (e->>'application_id')::uuid,
        e->>'question_key',
        e->>'question_label',
        e->>'normalized_value',
        e->>'raw_value',
        e->>'value_type',
        e->>'source',
        (e->>'is_sensitive')::boolean,
        (e->>'import_batch_id')::uuid,
        (e->>'created_at')::timestamptz,
        (e->>'updated_at')::timestamptz
      from jsonb_array_elements(v_answers) as e;

      insert into application_status_history (application_id, old_status, new_status, changed_by, note)
      values (
        v_application_id,
        v_old_status,
        (v_snapshot->>'status')::application_status,
        p_actor_id,
        format('Restored by rollback of import batch %s', p_batch_id)
      );

      insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, new_values)
      values (
        'application',
        v_application_id,
        'import_rollback_restore',
        'admin',
        p_actor_id,
        jsonb_build_object(
          'batchId', p_batch_id,
          'importRowId', v_row.id,
          'excelRowNumber', v_row.excel_row_number,
          'restoredAnswerCount', jsonb_array_length(v_answers)
        ),
        v_snapshot
      );
    end if;

    update import_rows set
      action_taken = null,
      previous_application_snapshot = null,
      previous_answers_snapshot = null
    where id = v_row.id;
  end loop;

  -- skipped_count is no longer zeroed (review finding A8): skipped rows
  -- were never applied, so the rollback does not undo them, and their
  -- action_taken is intentionally left untouched by the loop above (which
  -- only processes 'inserted'/'updated' rows). Reporting 0 skipped while
  -- import_rows still carries skipped_error/blocked stamps would be an
  -- internal inconsistency in the very audit trail this design otherwise
  -- takes care to preserve.
  update import_batches set
    status = 'rolled_back',
    inserted_count = 0,
    updated_count = 0,
    processing_lock_token = null,
    processing_lock_expires_at = null,
    next_chunk_offset = 0
  where id = p_batch_id;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'import_batch',
    p_batch_id,
    'import_rollback',
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_batch_id)
  );
end;
$$ language plpgsql set search_path = public, pg_temp;

comment on function rollback_import_batch_transactional(uuid, uuid) is
  'Task 16. Undoes an entire import batch atomically, or refuses entirely. '
  'Blocks on any participant_feature_snapshots / cluster_memberships / '
  'allocation_assignments / schedule_publications / '
  'schedule_publication_draft_items reference, and on any '
  'participant_invitations row whose status has left ''not_sent'' (that FK '
  'cascades, so it has no DB-level backstop — see Task 3''s note; this check '
  'takes FOR UPDATE to close a TOCTOU race with a concurrent send). '
  'application_notes.application_id also cascades and is NOT checked: '
  'internal staff commentary with no external side effect, accepted as a '
  'documented gap. v_restorable_columns MUST stay in sync with '
  'apply_import_row_transactional''s v_text_columns/v_array_columns '
  '(20260726108000_apply_import_row_function.sql): this function can only '
  'restore what that function can write. Update both together.';

comment on function apply_import_row_transactional(uuid, uuid, uuid) is
  'Per-row transactional import apply (Task 15). Refuses to apply into a '
  'batch whose status is ''rolled_back'' — without this guard, a stale '
  'in-flight chunk call or a retried request racing a rollback could '
  're-apply a row whose action_taken the rollback just cleared to NULL, '
  're-creating an application the admin just deleted. The is_sensitive key '
  'list inlined in this function''s application_answers insert must be kept '
  'in sync with SENSITIVE_QUESTION_KEYS in src/lib/validation/import.ts and '
  'the fixture in tests/rls/import.test.ts — all three currently list '
  'accessibility_requirements, dietary_requirements, emergency_contact_name, '
  'emergency_contact_phone, special_needs. If you change one, change all '
  'three.';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726109600_rollback_safety_fixes')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260726110000_claim_application_function.sql
-- ============================================================
-- claim_application_function.sql
--
-- Task 21, Step 1. The entire participant-side claim, as ONE Postgres
-- transaction. This function is the ONLY place in the entire codebase that
-- is permitted to set applications.applicant_id on an imported row —
-- ownership of an imported accepted-participant record is established here
-- and nowhere else (design spec rule 1: an Auth user merely EXISTING for an
-- imported email implies no ownership whatsoever; only a completed claim
-- through this function does).
--
-- Atomicity guarantee: identical reasoning to
-- apply_import_row_transactional (20260726108000) and
-- rollback_import_batch_transactional (20260726109000). PostgREST executes
-- each RPC call inside its own transaction and a plpgsql function body runs
-- entirely within the calling transaction. There is NO blanket
-- `exception when others` block here, so any unexpected error aborts the
-- whole call and rolls back every write. The single narrow exception block
-- below catches ONLY unique_violation on the one specific UPDATE it wraps,
-- and re-raises — it never swallows an error and never allows the
-- transaction to commit a partial claim.
--
-- SECURITY DEFINER — a deliberate DEVIATION from the security-invoker style
-- of every other transactional RPC in this phase, and the single most
-- security-sensitive decision in this file. Rationale:
--
--   * Every prior transactional RPC (apply_import_row, rollback_import_batch,
--     confirm_publication) is only ever invoked with a SERVICE-ROLE client
--     from a staff-gated server action. The service role bypasses RLS
--     entirely, so security invoker costs those functions nothing.
--   * This function is different by design: the plan requires it to be
--     called with the CLAIMING USER'S OWN authenticated session, precisely
--     so that p_claiming_user_id can be derived from a real
--     supabase.auth.getUser() rather than from client-supplied input.
--   * Under security invoker, the `update applications set applicant_id`
--     below would be evaluated against the claiming participant's RLS.
--     applications' only participant UPDATE policy is
--     applications_update_own_draft (`applicant_id = auth.uid() and status =
--     'draft'`, 20260721212035_rls_policies.sql). An unclaimed imported row
--     has applicant_id = null and status = 'accepted', so it matches
--     NEITHER the USING nor the WITH CHECK clause — the update would affect
--     zero rows and the claim would silently no-op. Likewise the
--     participant cannot even SELECT the row (applications_select_own is
--     also applicant_id = auth.uid()), so the invitation/ownership
--     verification below could not read what it needs to verify.
--
-- The security consequence of SECURITY DEFINER is that RLS provides ZERO
-- protection inside this body, so this function's own checks ARE the entire
-- security boundary. They are therefore written to be exhaustive and to
-- fail closed:
--
--   1. p_claiming_user_id is never trusted from the client. The caller
--      (claim/actions.ts) derives it from supabase.auth.getUser(). To make
--      that non-bypassable at the DB layer too, this function additionally
--      asserts p_claiming_user_id = auth.uid() — auth.uid() is resolved
--      from the verified JWT and is NOT affected by SECURITY DEFINER (it
--      reads the request's JWT claims, not the executing role). So even if
--      an attacker calls this RPC directly via PostgREST with a forged
--      p_claiming_user_id, the assertion rejects it. This makes the
--      parameter effectively advisory and the JWT authoritative.
--   2. The invitation row must exist for p_application_id with BOTH
--      status = 'sent' AND invited_user_id = p_claiming_user_id. This one
--      check simultaneously covers replay (an already-'accepted' invitation
--      fails the status test) and wrong-user attempts (a different
--      authenticated user fails the invited_user_id test), exactly as the
--      plan specifies.
--   3. execute is granted to `authenticated` only, never `anon`.
--
-- Locking: the participant_invitations row is taken FOR UPDATE before the
-- status check, so two concurrent claim attempts for the same application
-- serialize; the loser re-reads status = 'accepted' and is rejected by
-- check 2 rather than performing a second claim.

create function claim_imported_application_transactional(
  p_application_id uuid,
  p_claiming_user_id uuid
) returns void as $$
declare
  v_invitation participant_invitations;
  v_application applications;
begin
  -- Defence in depth (see rationale 1 above): under SECURITY DEFINER the
  -- executing role is the function owner, but auth.uid() still reflects the
  -- caller's verified JWT, so this pins the claim to the real session and
  -- makes a forged p_claiming_user_id unusable even on a direct PostgREST
  -- call that bypasses claim/actions.ts entirely.
  if auth.uid() is null then
    raise exception 'Claiming requires an authenticated session';
  end if;
  if p_claiming_user_id is distinct from auth.uid() then
    raise exception 'Claiming user does not match the authenticated session';
  end if;

  -- Lock the invitation for the duration of the transaction BEFORE reading
  -- its status, so two concurrent claims for the same application serialize
  -- here rather than both observing status = 'sent'.
  select * into v_invitation
  from participant_invitations
  where application_id = p_application_id
  for update;

  if v_invitation.id is null then
    raise exception 'No invitation exists for this application';
  end if;

  -- The single combined check the plan specifies. Deliberately does NOT
  -- distinguish "already claimed" from "wrong user" in the message: telling
  -- an unauthorized caller which of the two conditions they failed leaks
  -- whether a given application has been claimed and by whom, to a caller
  -- who by definition has no right to know anything about this application.
  if v_invitation.status <> 'sent' or v_invitation.invited_user_id is distinct from p_claiming_user_id then
    raise exception 'This invitation cannot be claimed by this account';
  end if;

  -- Lock the application too. Ordered after the invitation lock so every
  -- caller of this function acquires the two locks in the same order (no
  -- deadlock cycle is possible between concurrent claims).
  select * into v_application from applications where id = p_application_id for update;

  if v_application.id is null then
    raise exception 'Application % no longer exists', p_application_id;
  end if;

  -- Belt-and-braces: a non-null applicant_id here would mean the row was
  -- claimed by some path other than this function while its invitation was
  -- still 'sent' — an invariant violation, not a normal user error. Fail
  -- closed rather than overwrite an existing owner.
  if v_application.applicant_id is not null then
    raise exception 'This application has already been claimed';
  end if;

  ------------------------------------------------------------------
  -- The ownership write. THE one place applicant_id is ever set on an
  -- imported row.
  ------------------------------------------------------------------
  begin
    update applications
    set applicant_id = p_claiming_user_id
    where id = p_application_id;
  exception when unique_violation then
    -- applications_one_per_applicant (a plain unique index over the
    -- nullable applicant_id column, created in
    -- 20260721202027_applications_table.sql, predating this phase) permits
    -- unlimited unclaimed (null) rows but at most one row per non-null
    -- applicant_id. So this fires exactly when p_claiming_user_id already
    -- owns a DIFFERENT application. Confirmed with the user as desired
    -- behaviour (one application per account), so the job here is purely to
    -- convert an opaque Postgres constraint error into a message the claim
    -- page can show verbatim.
    --
    -- Safe use of an exception block despite this file's no-error-swallowing
    -- rule: it catches ONE specific, well-understood sqlstate around ONE
    -- statement and unconditionally re-raises. Nothing is swallowed and the
    -- transaction still aborts, so no partial claim can commit. Any other
    -- error from this UPDATE (including any other unique index) propagates
    -- untouched.
    raise exception 'This account has already claimed a different accepted-participant record';
  end;

  ------------------------------------------------------------------
  -- Mark the invitation consumed. Same transaction, so the ownership write
  -- and the invitation state can never disagree — a committed claim always
  -- has status = 'accepted', and a rejected one leaves 'sent' untouched.
  -- This is also what makes replay (Case 2) fail on the status check above.
  ------------------------------------------------------------------
  update participant_invitations
  set status = 'accepted', accepted_at = now()
  where application_id = p_application_id;

  -- Audited inside the transaction, matching the
  -- apply_import_row_transactional / rollback_import_batch_transactional
  -- precedent: an audit row written outside this transaction could survive
  -- a rolled-back claim (claiming an ownership change that never happened)
  -- or be lost after a committed one.
  --
  -- actor_type = 'system' rather than 'admin': audit_actor_type is the
  -- two-value enum ('admin', 'system') from
  -- 20260722200245_agenda_enums_and_reference_tables.sql — there is no
  -- 'participant' value, and this is the first participant-initiated
  -- audited action in the codebase. 'admin' would be an outright false
  -- claim that a staff member performed the claim, which is worse in an
  -- audit trail than the vaguer-but-true 'system'. actor_id still records
  -- exactly who claimed. Adding a 'participant' enum value was considered
  -- and deliberately not done here: altering a shared enum is out of this
  -- task's scope and would touch every audit consumer.
  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'application',
    p_application_id,
    'invitation_claimed',
    'system',
    p_claiming_user_id,
    jsonb_build_object('invitationId', v_invitation.id)
  );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

-- Explicit grants. The default on a newly created function is EXECUTE to
-- PUBLIC, which for a SECURITY DEFINER function would expose it to the
-- `anon` role as well. anon has no auth.uid(), so the first check would
-- reject it anyway — but revoking first and granting narrowly means that
-- protection does not rest on a single `if` statement.
revoke all on function claim_imported_application_transactional(uuid, uuid) from public;
grant execute on function claim_imported_application_transactional(uuid, uuid) to authenticated;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260726110000_claim_application_function')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260727000000_fix_profiles_role_privilege_escalation.sql
-- ============================================================
-- fix_profiles_role_privilege_escalation.sql
--
-- CRITICAL, live vulnerability found by the dedicated Tasks 20-21 security
-- review and independently reproduced: profiles_update_own
-- (20260721212035_rls_policies.sql:18-19) has a WITH CHECK of
-- `id = auth.uid()` only — it constrains WHICH row a user may update, but
-- places no constraint whatsoever on what value the `role` column may be
-- changed to. Any authenticated user could run
-- `update profiles set role = 'super_admin' where id = auth.uid()` and
-- succeed, since `authenticated` also holds table-wide UPDATE on `profiles`
-- with no column-level restriction. Reproduced live: a fresh, self-signed-up
-- 'participant' account escalated itself to 'super_admin' in one request
-- with zero errors, at which point every current_user_role()-gated RLS
-- policy and every isAgendaStaffRole()/isAdmissionStaffRole() application
-- check in the codebase treats that session as fully trusted staff.
--
-- This is Phase 1 code, predating this entire plan, but is fixed here
-- immediately given it is live and actively exploitable in production —
-- not deferred to a later task.
--
-- Fix: revoke UPDATE on `profiles` from authenticated/anon entirely, then
-- grant it back only for the specific columns a user should ever be able to
-- change about their own row. `role` is deliberately excluded — role
-- changes must go through a service-role-authorized path only (e.g. a
-- future admin action, or a service-role migration/seed), never a
-- self-service update. This is the primary fix: it makes a role write from
-- an authenticated/anon session fail at the grant level, before RLS is even
-- evaluated, which is a stronger guarantee than a WITH CHECK clause (a
-- column-level grant cannot be bypassed by any future policy rewrite that
-- forgets to re-add a role check).
revoke update on profiles from authenticated, anon;
grant update (full_name, email) on profiles to authenticated;

-- Belt-and-braces: also make the RLS policies themselves reject a role
-- change, so the protection does not rest on the grant alone. Both existing
-- update policies get an explicit role-immutability check.
drop policy if exists profiles_update_own on profiles;
create policy profiles_update_own on profiles
  for update
  using (id = auth.uid())
  with check (id = auth.uid() and role = (select p.role from profiles p where p.id = auth.uid()));

-- profiles_update_super_admin previously had a USING clause but NO WITH
-- CHECK at all, so it inherited no restriction on the new row values —
-- Postgres only requires a WITH CHECK to be present for it to apply; a
-- missing one means "no restriction" rather than "same as USING". A
-- super_admin genuinely should be able to change another user's role (that
-- is the intended admin capability), so this policy is intentionally left
-- permissive on `role` — the WITH CHECK added here only re-confirms the
-- USING condition, closing the "no restriction at all" gap without
-- narrowing what a real super_admin is allowed to do.
drop policy if exists profiles_update_super_admin on profiles;
create policy profiles_update_super_admin on profiles
  for update
  using (current_user_role() = 'super_admin')
  with check (current_user_role() = 'super_admin');

-- ---------------------------------------------------------------------
-- Medium finding, same review: claim_imported_application_transactional's
-- migration comment (20260726110000_claim_application_function.sql:197-203)
-- claims "revoked from public and granted only to authenticated" is enough
-- to keep anon out, but `revoke all ... from public` only removes the
-- PUBLIC pseudo-role's entry — Supabase's default privileges grant EXECUTE
-- to `anon` explicitly, at CREATE time, which a subsequent `revoke ... from
-- public` cannot remove. Confirmed live via pg_proc.proacl: anon was
-- present. Not exploitable today (the function's own `auth.uid() is null`
-- check correctly rejects an anon caller, verified live — anon reaches the
-- function body and gets a clean 400 from the RPC's own raise exception,
-- not a permission error), but the layered defense the comment claims does
-- not actually exist as deployed. Closing it explicitly rather than relying
-- on the one `if` staying correct forever.
-- ---------------------------------------------------------------------
revoke all on function claim_imported_application_transactional(uuid, uuid) from anon;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260727000000_fix_profiles_role_privilege_escalation')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260727010000_wire_row_fingerprint_idempotent_reimport.sql
-- ============================================================
-- wire_row_fingerprint_idempotent_reimport.sql
--
-- Task 25. Wires import_rows.row_fingerprint into the confirm-import apply
-- path, closing a real gap between the binding design spec and the
-- implementation.
--
-- THE GAP. The design spec
-- (docs/superpowers/specs/2026-07-25-accepted-participants-import-design.md,
-- "Idempotency and concurrency rules") requires:
--
--   "Same row content across different uploads: row_fingerprint (hash of
--    normalized row) lets the confirm-import step classify a row as
--    skipped_unchanged even across different import_batches — re-importing
--    the same person with identical answers does not create a duplicate
--    application_answers history or a spurious application_status_history
--    entry."
--
-- This was never wired up. Task 8's computeRowFingerprint computes the hash
-- and Task 14's validation step stores it on import_rows, but nothing in the
-- codebase ever READ it back — it was write-only data behind an unused index
-- (import_rows_fingerprint_idx). Consequently EVERY re-import of an unchanged
-- person went through the full update path unconditionally: a before-image
-- snapshot capture, an overwrite of applications columns with byte-identical
-- values, a delete+reinsert of application_answers, and a fresh
-- application_status_history + audit_logs entry — every single time, for no
-- data change. That is precisely the "spurious application_status_history
-- entry" the spec forbids.
--
-- ---------------------------------------------------------------------
-- MECHANISM CHOSEN: a new applications.last_import_row_fingerprint column.
--
-- The question this fix has to answer at apply time is "what was the
-- fingerprint of the content most recently applied to THIS destination
-- application?". Two mechanisms were considered.
--
-- REJECTED — deriving it by querying the most recent prior import_rows row
-- targeting this application. This is not merely awkward, it is
-- unimplementable correctly against the current schema: import_rows has NO
-- timestamp column whatsoever (verified column-by-column against
-- 20260726102000_import_staging_tables.sql — there is no created_at/
-- updated_at, unlike import_batches which has uploaded_at). The only
-- candidate ordering columns are excel_row_number, which is scoped to a
-- single batch and carries no cross-batch meaning, and id, which is a random
-- gen_random_uuid() and is not monotonic. Ordering by either across
-- different import_batches would pick an ARBITRARY prior row, not the most
-- recent one — so a re-import could compare against a stale fingerprint from
-- two batches ago and skip a row that genuinely changed, silently dropping
-- the admin's update. Joining out to import_batches.uploaded_at would order
-- by UPLOAD time, which is not APPLY time (batches can be validated, left
-- sitting, and confirmed out of upload order), so it has the same defect in
-- a less obvious form. Shipping any of these would mean comparing against
-- the wrong "previous" state — the exact failure mode this task warns off.
--
-- CHOSEN — store the fingerprint of the content actually applied, on the
-- application it was applied to. It is O(1) at apply time (already-locked
-- row, no extra query, no new index needed), and it is semantically exact:
-- it records what this application's import-managed content IS, rather than
-- inferring it from staging-table archaeology. The "keeping a new column in
-- sync" cost is genuinely small because there are exactly two writers in the
-- whole system, both in this file: the apply function sets it, and the
-- rollback function clears it.
--
-- THE ROLLBACK INTERACTION IS LOAD-BEARING, NOT AN AFTERTHOUGHT. Rollback
-- restores an application to its pre-import tuple. If
-- last_import_row_fingerprint survived that restore, the application's
-- CONTENT would be the old content while its recorded fingerprint claimed
-- the new content — so re-importing the very file the admin just rolled back
-- would be classified skipped_unchanged and silently do nothing, leaving the
-- admin unable to re-apply a batch they had just undone. Rollback therefore
-- clears the column on the update path and it dies with the row on the
-- insert path (hard delete). This restores the true invariant:
-- last_import_row_fingerprint is non-null if and only if the application's
-- current import-managed content was written by an import that has not been
-- rolled back.
-- ---------------------------------------------------------------------

alter table applications add column last_import_row_fingerprint text;

comment on column applications.last_import_row_fingerprint is
  'sha256 of the normalized import row most recently APPLIED to this '
  'application by apply_import_row_transactional, matching '
  'import_rows.row_fingerprint (computed by computeRowFingerprint in '
  'src/lib/import/normalization.ts). Read only by '
  'apply_import_row_transactional, to classify an unchanged re-import as '
  '''skipped_unchanged'' per the design spec''s idempotency rules. Written '
  'by exactly two functions: set by apply_import_row_transactional, cleared '
  'by rollback_import_batch_transactional (a restored application''s content '
  'is once again pre-import, so its recorded fingerprint must not claim '
  'otherwise — leaving it set would make re-importing a just-rolled-back '
  'batch a silent no-op). NULL means no un-rolled-back import has written '
  'this application.';

-- ---------------------------------------------------------------------
-- apply_import_row_transactional, replaced.
--
-- `create or replace function` because the original (20260726108000) and its
-- first follow-up (20260726109600) are both already applied live and
-- immutable — the same pattern 20260726109600 established for exactly this
-- function. The full body is restated because plpgsql has no partial-replace
-- form; the ONLY changes versus 20260726109600 are marked NEW below.
--
-- Scope of the change, precisely: a fingerprint short-circuit at the top of
-- the existing_unclaimed/existing_claimed branch, and a write of
-- last_import_row_fingerprint on both apply paths. The INSERT path's
-- classification logic is untouched — a brand-new application has no prior
-- fingerprint by definition, so the comparison is unreachable there by
-- construction, not by an added guard.
-- ---------------------------------------------------------------------
create or replace function apply_import_row_transactional(
  p_import_row_id uuid,
  p_import_batch_id uuid,
  p_actor_id uuid
) returns text as $$
declare
  v_batch_status text;
  v_row import_rows;
  v_normalized jsonb;
  v_email text;
  v_application_id uuid;
  v_previous_application jsonb;
  v_previous_answers jsonb;
  v_raw_values jsonb;
  v_key text;
  v_value jsonb;
  v_is_array boolean;
  v_application_number text;
  -- NEW: the fingerprint currently recorded on the destination application.
  v_existing_fingerprint text;
  v_text_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs'
  ];
  v_array_columns text[] := array['interests', 'track_interests'];
  v_update_sql text;
  v_set_clauses text[] := array[]::text[];
begin
  select status into v_batch_status from import_batches where id = p_import_batch_id;
  if v_batch_status = 'rolled_back' then
    raise exception 'Import batch % has been rolled back; cannot apply row %', p_import_batch_id, p_import_row_id;
  end if;

  select * into v_row from import_rows
  where id = p_import_row_id and import_batch_id = p_import_batch_id
  for update;

  if v_row.id is null then
    raise exception 'Import row % not found in batch %', p_import_row_id, p_import_batch_id;
  end if;

  if v_row.action_taken is not null then
    return 'already_applied';
  end if;

  if v_row.validation_status = 'invalid' then
    update import_rows set action_taken = 'skipped_error' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'blocked_downstream' then
    update import_rows set action_taken = 'blocked' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'duplicate_in_file' then
    update import_rows set action_taken = 'skipped_unchanged' where id = v_row.id;
    return 'skipped';
  end if;

  v_normalized := coalesce(v_row.normalized_row, '{}'::jsonb);
  v_email := v_normalized->>'email';
  if v_email is null or v_email = '' then
    raise exception 'Import row % has no normalized email but passed validation', v_row.id;
  end if;

  select coalesce(jsonb_object_agg(m.target_key, to_jsonb(v_row.raw_row->>m.source_column_index)), '{}'::jsonb)
  into v_raw_values
  from import_column_mappings m
  where m.import_batch_id = p_import_batch_id
    and m.target_key is not null
    and m.target_kind <> 'ignored';

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    v_application_id := v_row.destination_application_id;
    if v_application_id is null then
      raise exception 'Import row % is marked % but has no destination_application_id', v_row.id, v_row.duplicate_status;
    end if;

    perform 1 from applications where id = v_application_id for update;

    ------------------------------------------------------------------
    -- NEW: unchanged-content short-circuit (design spec, "Same row content
    -- across different uploads").
    --
    -- Read under the FOR UPDATE lock taken immediately above, so the
    -- comparison cannot race a concurrent apply to the same application:
    -- two batches importing the same person serialize here, and the second
    -- one sees the first one's committed fingerprint.
    --
    -- Ordering matters. This runs BEFORE the before-image snapshot capture,
    -- deliberately: on this path nothing is going to change, so there is
    -- nothing to snapshot, and writing a snapshot would be actively wrong —
    -- it would make the row look restorable to Task 16's rollback when
    -- there is nothing to restore.
    --
    -- Null-safe by intent, and `is distinct from` is NOT wanted here: a
    -- NULL v_existing_fingerprint means no un-rolled-back import has ever
    -- written this application (a pre-existing self-registered application,
    -- or one whose import was rolled back), and that MUST fall through to
    -- the normal update path. Plain `=` yields NULL for that case, which is
    -- not true, so the branch is correctly not taken.
    ------------------------------------------------------------------
    select last_import_row_fingerprint into v_existing_fingerprint
    from applications where id = v_application_id;

    if v_existing_fingerprint = v_row.row_fingerprint then
      -- Identical normalized content was already applied to this exact
      -- application by a prior import. Touch no participant data at all: no
      -- snapshot, no applications write, no application_answers
      -- delete/reinsert, no application_status_history row.
      update import_rows set
        action_taken = 'skipped_unchanged',
        destination_application_id = v_application_id
      where id = v_row.id;

      -- A no-op outcome is still a processed row, and this plan's rule is
      -- that every sensitive admin action is audited — including one that
      -- deliberately changed nothing. Without this there would be no trace
      -- distinguishing "this row was evaluated and correctly skipped" from
      -- "this row was never reached". Written inside the same transaction
      -- as the action_taken stamp, for the same reason the other audit
      -- writes in this function are: an audit row outside it could survive
      -- a rolled-back call or be lost after a committed one.
      insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
      values (
        'application',
        v_application_id,
        'import_skip_unchanged',
        'admin',
        p_actor_id,
        jsonb_build_object(
          'batchId', p_import_batch_id,
          'importRowId', v_row.id,
          'excelRowNumber', v_row.excel_row_number,
          'rowFingerprint', v_row.row_fingerprint
        )
      );

      return 'skipped';
    end if;

    -- Fingerprints differ (content genuinely changed), or there is no prior
    -- applied fingerprint. Proceed with the pre-existing update path,
    -- unchanged.
    select to_jsonb(a.*) into v_previous_application from applications a where a.id = v_application_id;
    if v_previous_application is null then
      raise exception 'Destination application % for import row % no longer exists', v_application_id, v_row.id;
    end if;

    select coalesce(jsonb_agg(to_jsonb(aa.*)), '[]'::jsonb) into v_previous_answers
    from application_answers aa where aa.application_id = v_application_id;

    update import_rows set
      action_taken = 'updated',
      previous_application_snapshot = v_previous_application,
      previous_answers_snapshot = v_previous_answers,
      destination_application_id = v_application_id
    where id = v_row.id;
  else
    v_application_number := next_application_number();

    insert into applications (applicant_id, imported_email, import_batch_id, status, application_number)
    values (null, v_email, p_import_batch_id, 'accepted', v_application_number)
    returning id into v_application_id;

    update import_rows set
      action_taken = 'inserted',
      destination_application_id = v_application_id
    where id = v_row.id;
  end if;

  foreach v_key in array v_text_columns loop
    if v_normalized ? v_key then
      v_value := v_normalized->v_key;
      v_is_array := jsonb_typeof(v_value) = 'array';
      v_set_clauses := v_set_clauses || format(
        '%I = %L',
        v_key,
        case
          when v_value is null or jsonb_typeof(v_value) = 'null' then null
          when v_is_array then (select string_agg(e, ', ') from jsonb_array_elements_text(v_value) as e)
          else v_value #>> '{}'
        end
      );
    end if;
  end loop;

  foreach v_key in array v_array_columns loop
    if v_normalized ? v_key then
      v_value := v_normalized->v_key;
      v_set_clauses := v_set_clauses || format(
        '%I = %L::text[]',
        v_key,
        case
          when v_value is null or jsonb_typeof(v_value) = 'null' then null
          when jsonb_typeof(v_value) = 'array' then (
            select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_value) as e
          )
          else array[v_value #>> '{}']
        end
      );
    end if;
  end loop;

  if v_normalized ? 'birth_date' then
    declare
      v_birth_raw text := v_normalized->>'birth_date';
      v_birth_date date;
    begin
      if v_birth_raw is not null and v_birth_raw <> '' then
        begin
          v_birth_date := v_birth_raw::date;
          v_set_clauses := v_set_clauses || format('birth_date = %L::date', v_birth_date);
        exception when others then
          null;
        end;
      end if;
    end;
  end if;

  -- NEW: record the fingerprint of the content being applied, so a later
  -- import of identical content can take the short-circuit above. Appended
  -- to the same dynamic UPDATE the mapped columns already use rather than
  -- issued as a separate statement — one write, and it is impossible for
  -- the recorded fingerprint to land without the content it describes.
  --
  -- Appended UNCONDITIONALLY, outside the `? v_key` presence tests above:
  -- v_set_clauses can legitimately be empty (a row whose normalized keys
  -- map to no applications column at all, e.g. full_name only), and the
  -- fingerprint must still be recorded in that case, because the
  -- application_answers write below is a real content change even when no
  -- applications column moves. This also guarantees array_length(...) > 0
  -- below is now always true, so the mapped-column UPDATE is no longer
  -- conditionally skipped; the guard is retained anyway as it costs nothing
  -- and keeps the statement's shape honest if the list ever changes again.
  v_set_clauses := v_set_clauses || format('last_import_row_fingerprint = %L', v_row.row_fingerprint);

  if array_length(v_set_clauses, 1) > 0 then
    v_update_sql := format(
      'update applications set %s where id = %L',
      array_to_string(v_set_clauses, ', '),
      v_application_id
    );
    execute v_update_sql;
  end if;

  for v_key, v_value in select * from jsonb_each(v_normalized) loop
    insert into application_answers (
      application_id, question_key, normalized_value, raw_value, value_type,
      source, is_sensitive, import_batch_id
    ) values (
      v_application_id,
      v_key,
      case
        when jsonb_typeof(v_value) = 'string' then v_value #>> '{}'
        else v_value::text
      end,
      coalesce(
        v_raw_values->>v_key,
        case
          when jsonb_typeof(v_value) = 'string' then v_value #>> '{}'
          else v_value::text
        end
      ),
      case when jsonb_typeof(v_value) = 'array' then 'multiselect' else 'text' end,
      'import',
      v_key in (
        'accessibility_requirements', 'dietary_requirements',
        'emergency_contact_name', 'emergency_contact_phone', 'special_needs'
      ),
      p_import_batch_id
    )
    on conflict (application_id, question_key, source) do update set
      normalized_value = excluded.normalized_value,
      raw_value = excluded.raw_value,
      value_type = excluded.value_type,
      is_sensitive = excluded.is_sensitive,
      import_batch_id = excluded.import_batch_id;
  end loop;

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    insert into application_status_history (application_id, old_status, new_status, changed_by, note)
    values (
      v_application_id,
      (v_previous_application->>'status')::application_status,
      'accepted',
      p_actor_id,
      format('Updated by import batch %s', p_import_batch_id)
    );
  else
    insert into application_status_history (application_id, old_status, new_status, changed_by, note)
    values (v_application_id, null, 'accepted', p_actor_id, format('Created by import batch %s', p_import_batch_id));
  end if;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'application',
    v_application_id,
    case when v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then 'import_update' else 'import_insert' end,
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_import_batch_id, 'importRowId', v_row.id)
  );

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    return 'updated';
  end if;
  return 'inserted';
end;
$$ language plpgsql set search_path = public, pg_temp;

-- ---------------------------------------------------------------------
-- rollback_import_batch_transactional, replaced.
--
-- Two points, one verified and one changed.
--
-- VERIFIED, NOT CHANGED: the restoration loop's
-- `action_taken in ('inserted', 'updated')` filter already excludes rows
-- reaching 'skipped_unchanged' via the new path above, by construction —
-- 'skipped_unchanged' has never been in that IN-list. This is correct and
-- required: a skipped_unchanged row wrote no participant data and captured
-- no snapshot, so there is nothing to restore and any restoration action on
-- it would be a fabrication. The same filter in the v_scope_application_ids
-- union is also correct to leave alone: a skipped row's destination
-- application is not in the rollback's blast radius via THIS batch (if the
-- batch also inserted it, it is already in scope via
-- applications.import_batch_id; if a PRIOR batch wrote it, undoing that is
-- that batch's rollback to perform, not this one's). Note the loop's
-- trailing `update import_rows set action_taken = null` is likewise scoped
-- to the loop, so a skipped_unchanged stamp is correctly left in place as
-- the audit trail of a row that was evaluated and skipped — consistent with
-- review finding A8's reasoning about skipped_error/blocked stamps.
--
-- CHANGED: the update path now clears last_import_row_fingerprint. See the
-- rollback-interaction note at the top of this file — without this, a
-- restored application would keep a fingerprint describing content it no
-- longer has, and re-importing the just-rolled-back batch would be
-- classified skipped_unchanged and silently do nothing. The insert path
-- needs no change: it hard-deletes the application, taking the column with
-- it. Cleared via the existing dynamic UPDATE by adding the column to
-- v_restorable_columns, which is exactly right for it — the snapshot is
-- to_jsonb(applications.*) taken BEFORE the import wrote the fingerprint,
-- so `%L` of v_snapshot->>'last_import_row_fingerprint' restores the true
-- prior value: NULL for a first-ever import, or the PRECEDING import's
-- fingerprint when several batches have touched the row in sequence. That
-- is strictly more correct than unconditionally nulling it, which would
-- lose the earlier batch's still-valid record.
-- ---------------------------------------------------------------------
create or replace function rollback_import_batch_transactional(
  p_batch_id uuid,
  p_actor_id uuid
) returns void as $$
declare
  v_batch import_batches;
  v_blocker_count int;
  v_blocker_detail text;
  v_scope_application_ids uuid[];
  v_row record;
  v_snapshot jsonb;
  v_answers jsonb;
  v_application_id uuid;
  v_old_status application_status;
  v_update_sql text;
  v_set_clauses text[];
  v_key text;
  -- last_import_row_fingerprint added (Task 25): restored from the
  -- before-image like every other import-writable column, which correctly
  -- yields NULL for a first-ever import and the preceding batch's
  -- fingerprint when imports have stacked.
  v_restorable_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs',
    'birth_date', 'last_import_row_fingerprint'
  ];
  v_array_columns text[] := array['interests', 'track_interests'];
begin
  select * into v_batch from import_batches where id = p_batch_id for update;

  if v_batch.id is null then
    raise exception 'Import batch % not found', p_batch_id;
  end if;

  if v_batch.status = 'rolled_back' then
    raise exception 'Import batch % has already been rolled back', p_batch_id;
  end if;

  select coalesce(array_agg(distinct id), array[]::uuid[])
  into v_scope_application_ids
  from (
    select a.id
    from applications a
    where a.import_batch_id = p_batch_id
    union
    select r.destination_application_id as id
    from import_rows r
    where r.import_batch_id = p_batch_id
      and r.destination_application_id is not null
      and r.action_taken in ('inserted', 'updated')
  ) scope;

  select count(*) into v_blocker_count
  from participant_feature_snapshots s
  where s.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_feature_snapshots row(s) reference applications from this batch. Delete the feature extraction run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from cluster_memberships c
  where c.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % cluster_memberships row(s) reference applications from this batch. Delete the clustering run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from allocation_assignments al
  where al.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % allocation_assignments row(s) reference applications from this batch. Delete the allocation run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from schedule_publications sp
  where sp.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publications row(s) reference applications from this batch. Retract the publication first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from schedule_publication_draft_items spdi
  where spdi.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publication_draft_items row(s) reference applications from this batch. Discard the schedule draft first.',
      p_batch_id, v_blocker_count;
  end if;

  perform 1
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
  for update of pi;

  select count(*), string_agg(distinct pi.status, ', ' order by pi.status)
  into v_blocker_count, v_blocker_detail
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
    and pi.status <> 'not_sent';
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_invitations row(s) for applications in this batch are no longer in ''not_sent'' status (found: %). An invitation has already been sent to a real recipient and an auth user may exist for them; revoke the invitation(s) before rolling back.',
      p_batch_id, v_blocker_count, v_blocker_detail;
  end if;

  for v_row in
    select * from import_rows
    where import_batch_id = p_batch_id
      and action_taken in ('inserted', 'updated')
    order by excel_row_number
    for update
  loop
    v_application_id := v_row.destination_application_id;

    if v_row.action_taken = 'inserted' then
      if v_application_id is not null then
        insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
        values (
          'application',
          v_application_id,
          'import_rollback_delete',
          'admin',
          p_actor_id,
          jsonb_build_object(
            'batchId', p_batch_id,
            'importRowId', v_row.id,
            'excelRowNumber', v_row.excel_row_number
          )
        );

        delete from applications where id = v_application_id;
      end if;

    else
      v_snapshot := v_row.previous_application_snapshot;

      if v_application_id is null or v_snapshot is null then
        raise exception 'Cannot roll back import batch %: import row % is marked ''updated'' but has no recoverable snapshot (destination_application_id=%, previous_application_snapshot is null).',
          p_batch_id, v_row.id, v_application_id;
      end if;

      perform 1 from applications where id = v_application_id for update;

      select status into v_old_status from applications where id = v_application_id;

      v_set_clauses := array[]::text[];

      foreach v_key in array v_restorable_columns loop
        v_set_clauses := v_set_clauses || format('%I = %L', v_key, v_snapshot->>v_key);
      end loop;

      foreach v_key in array v_array_columns loop
        v_set_clauses := v_set_clauses || format(
          '%I = %L::text[]',
          v_key,
          case
            when v_snapshot->v_key is null or jsonb_typeof(v_snapshot->v_key) = 'null' then null
            else (select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_snapshot->v_key) as e)
          end
        );
      end loop;

      v_set_clauses := v_set_clauses || format('status = %L::application_status', (v_snapshot->>'status')::application_status);

      v_update_sql := format(
        'update applications set %s where id = %L',
        array_to_string(v_set_clauses, ', '),
        v_application_id
      );
      execute v_update_sql;

      delete from application_answers where application_id = v_application_id;

      v_answers := coalesce(v_row.previous_answers_snapshot, '[]'::jsonb);

      insert into application_answers (
        id, application_id, question_key, question_label, normalized_value,
        raw_value, value_type, source, is_sensitive, import_batch_id,
        created_at, updated_at
      )
      select
        (e->>'id')::uuid,
        (e->>'application_id')::uuid,
        e->>'question_key',
        e->>'question_label',
        e->>'normalized_value',
        e->>'raw_value',
        e->>'value_type',
        e->>'source',
        (e->>'is_sensitive')::boolean,
        (e->>'import_batch_id')::uuid,
        (e->>'created_at')::timestamptz,
        (e->>'updated_at')::timestamptz
      from jsonb_array_elements(v_answers) as e;

      insert into application_status_history (application_id, old_status, new_status, changed_by, note)
      values (
        v_application_id,
        v_old_status,
        (v_snapshot->>'status')::application_status,
        p_actor_id,
        format('Restored by rollback of import batch %s', p_batch_id)
      );

      insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, new_values)
      values (
        'application',
        v_application_id,
        'import_rollback_restore',
        'admin',
        p_actor_id,
        jsonb_build_object(
          'batchId', p_batch_id,
          'importRowId', v_row.id,
          'excelRowNumber', v_row.excel_row_number,
          'restoredAnswerCount', jsonb_array_length(v_answers)
        ),
        v_snapshot
      );
    end if;

    update import_rows set
      action_taken = null,
      previous_application_snapshot = null,
      previous_answers_snapshot = null
    where id = v_row.id;
  end loop;

  update import_batches set
    status = 'rolled_back',
    inserted_count = 0,
    updated_count = 0,
    processing_lock_token = null,
    processing_lock_expires_at = null,
    next_chunk_offset = 0
  where id = p_batch_id;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'import_batch',
    p_batch_id,
    'import_rollback',
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_batch_id)
  );
end;
$$ language plpgsql set search_path = public, pg_temp;

comment on function apply_import_row_transactional(uuid, uuid, uuid) is
  'Per-row transactional import apply (Task 15). Refuses to apply into a '
  'batch whose status is ''rolled_back'' — without this guard, a stale '
  'in-flight chunk call or a retried request racing a rollback could '
  're-apply a row whose action_taken the rollback just cleared to NULL, '
  're-creating an application the admin just deleted. Task 25: on the '
  'existing_unclaimed/existing_claimed path, compares the row''s '
  'row_fingerprint against the destination application''s '
  'last_import_row_fingerprint (read under the same FOR UPDATE lock) and '
  'classifies an exact match as ''skipped_unchanged'' — no snapshot, no '
  'applications/application_answers write, no status-history row, but still '
  'an ''import_skip_unchanged'' audit_logs entry. Every applied row records '
  'its fingerprint in applications.last_import_row_fingerprint; '
  'rollback_import_batch_transactional restores that column from the '
  'before-image, so a rolled-back batch can be cleanly re-imported. The '
  'is_sensitive key list inlined in this function''s application_answers '
  'insert must be kept in sync with SENSITIVE_QUESTION_KEYS in '
  'src/lib/validation/import.ts and the fixture in tests/rls/import.test.ts '
  '— all three currently list accessibility_requirements, '
  'dietary_requirements, emergency_contact_name, emergency_contact_phone, '
  'special_needs. If you change one, change all three.';

comment on function rollback_import_batch_transactional(uuid, uuid) is
  'Task 16. Undoes an entire import batch atomically, or refuses entirely. '
  'Blocks on any participant_feature_snapshots / cluster_memberships / '
  'allocation_assignments / schedule_publications / '
  'schedule_publication_draft_items reference, and on any '
  'participant_invitations row whose status has left ''not_sent'' (that FK '
  'cascades, so it has no DB-level backstop — see Task 3''s note; this check '
  'takes FOR UPDATE to close a TOCTOU race with a concurrent send). '
  'application_notes.application_id also cascades and is NOT checked: '
  'internal staff commentary with no external side effect, accepted as a '
  'documented gap. Only ''inserted''/''updated'' rows are restored: '
  '''skipped_unchanged'' rows (whether from a within-file duplicate or from '
  'Task 25''s unchanged-content short-circuit) wrote no participant data and '
  'captured no snapshot, so they are correctly excluded and their '
  'action_taken stamp is left in place as an audit trail. '
  'v_restorable_columns MUST stay in sync with '
  'apply_import_row_transactional''s v_text_columns/v_array_columns plus '
  'last_import_row_fingerprint '
  '(20260726108000_apply_import_row_function.sql, '
  '20260727010000_wire_row_fingerprint_idempotent_reimport.sql): this '
  'function can only restore what that function can write. Update both '
  'together.';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260727010000_wire_row_fingerprint_idempotent_reimport')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260727020000_fingerprint_fix_followups.sql
-- ============================================================
-- fingerprint_fix_followups.sql
--
-- Dedicated review of 20260727010000 (the row_fingerprint idempotent-reimport
-- fix) found two issues, both addressed here via `comment on` statements
-- (the original migration is already applied live and immutable — plpgsql
-- function bodies are unchanged, only documentation is corrected/added).
--
-- ISSUE 1 (Important): computeRowFingerprint (src/lib/import/normalization.ts)
-- hashes ONLY normalizedRow, not the raw cell text or the column mapping that
-- produced it. Two batches whose cells normalize identically but differ in
-- raw form (e.g. "  Acme Corp  " vs "Acme Corp" — both trim to the same
-- normalized value) will fingerprint-match and take the skip path, even
-- though application_answers.raw_value would legitimately have changed
-- between the two imports. The skip is correct for every column this system
-- actually uses downstream (normalized_value, and every applications column,
-- both of which the hash genuinely does cover) — the divergence is bounded
-- to raw_value, which is retained for audit/provenance purposes, not
-- participant-facing content or anything read by feature
-- extraction/clustering/allocation. Widening the hash to also cover
-- raw_row + the column mapping was considered and rejected: it would be a
-- non-trivial change to Task 8's already-reviewed, already-tested
-- computeRowFingerprint (a pure function with no knowledge of mappings,
-- called before per-application resolution even happens), for a benefit
-- bounded to provenance metadata rather than actual participant data. The
-- original migration's comments claimed an equivalence ("identical
-- normalized content was already applied") that is accurate for
-- normalized_value but overstated for raw_value — corrected below to state
-- the real, narrower guarantee honestly rather than leave a claim a future
-- maintainer could rely on incorrectly.
--
-- ISSUE 5 (Minor, documentation accuracy): the original migration's header
-- and `comment on column` both said rollback "clears" last_import_row_
-- fingerprint on the update path. The actual, correct implementation
-- RESTORES it from the before-image snapshot (via v_restorable_columns) —
-- this is the better behavior (see the original migration's own "THE
-- ROLLBACK INTERACTION IS LOAD-BEARING" section, which correctly describes
-- restoring, not clearing), but the summary comments contradicted the code
-- they were describing. Corrected.

comment on column applications.last_import_row_fingerprint is
  'sha256 of the normalized import row most recently APPLIED to this '
  'application by apply_import_row_transactional, matching '
  'import_rows.row_fingerprint (computed by computeRowFingerprint in '
  'src/lib/import/normalization.ts). Read only by '
  'apply_import_row_transactional, to classify an unchanged re-import as '
  '''skipped_unchanged'' per the design spec''s idempotency rules. Written '
  'by exactly two functions: set by apply_import_row_transactional, RESTORED '
  '(from the before-image snapshot, not nulled) by '
  'rollback_import_batch_transactional — a rolled-back application''s '
  'content reverts to its pre-import state, so its recorded fingerprint must '
  'revert too, and restoring from the snapshot (rather than unconditionally '
  'nulling) correctly recovers an earlier batch''s still-valid fingerprint '
  'when imports have stacked. NULL means no un-rolled-back import has '
  'written this application. KNOWN LIMITATION: computeRowFingerprint hashes '
  'only normalizedRow, not raw_row or the column mapping, so two imports '
  'whose cells normalize identically but differ in raw form (e.g. '
  'whitespace, casing collapsed by normalizeEmail/normalizePhone/'
  'normalizeYesNo, or multiselect delimiter/ordering differences) will '
  'match and skip even though application_answers.raw_value would have '
  'legitimately changed. This is accepted: the guarantee holds for '
  'normalized_value and every applications column (both fully covered by '
  'the hash), and the divergence is bounded to raw_value, which is '
  'audit/provenance metadata, not participant-facing content or anything '
  'read by downstream feature extraction/clustering/allocation.';

comment on function apply_import_row_transactional(uuid, uuid, uuid) is
  'Per-row transactional import apply (Task 15). Refuses to apply into a '
  'batch whose status is ''rolled_back'' — without this guard, a stale '
  'in-flight chunk call or a retried request racing a rollback could '
  're-apply a row whose action_taken the rollback just cleared to NULL, '
  're-creating an application the admin just deleted. Task 25: on the '
  'existing_unclaimed/existing_claimed path, compares the row''s '
  'row_fingerprint against the destination application''s '
  'last_import_row_fingerprint (read under the same FOR UPDATE lock) and '
  'classifies an exact match as ''skipped_unchanged'' — no snapshot, no '
  'applications/application_answers write, no status-history row, but still '
  'an ''import_skip_unchanged'' audit_logs entry. Every applied row records '
  'its fingerprint in applications.last_import_row_fingerprint; '
  'rollback_import_batch_transactional RESTORES that column from the '
  'before-image (see the column comment on '
  'applications.last_import_row_fingerprint for why restore-not-clear is '
  'correct), so a rolled-back batch can be cleanly re-imported. KNOWN '
  'LIMITATION: the fingerprint covers normalized_value only, not raw_value — '
  'see the column comment for the accepted, bounded divergence this implies. '
  'The is_sensitive key list inlined in this function''s application_answers '
  'insert must be kept in sync with SENSITIVE_QUESTION_KEYS in '
  'src/lib/validation/import.ts and the fixture in tests/rls/import.test.ts '
  '— all three currently list accessibility_requirements, '
  'dietary_requirements, emergency_contact_name, emergency_contact_phone, '
  'special_needs. If you change one, change all three.';

comment on function rollback_import_batch_transactional(uuid, uuid) is
  'Task 16. Undoes an entire import batch atomically, or refuses entirely. '
  'Blocks on any participant_feature_snapshots / cluster_memberships / '
  'allocation_assignments / schedule_publications / '
  'schedule_publication_draft_items reference, and on any '
  'participant_invitations row whose status has left ''not_sent'' (that FK '
  'cascades, so it has no DB-level backstop — see Task 3''s note; this check '
  'takes FOR UPDATE to close a TOCTOU race with a concurrent send). '
  'application_notes.application_id also cascades and is NOT checked: '
  'internal staff commentary with no external side effect, accepted as a '
  'documented gap. Only ''inserted''/''updated'' rows are restored: '
  '''skipped_unchanged'' rows (whether from a within-file duplicate or from '
  'Task 25''s unchanged-content short-circuit) wrote no participant data and '
  'captured no snapshot, so they are correctly excluded and their '
  'action_taken stamp is left in place as an audit trail. RESTORES (not '
  'clears) last_import_row_fingerprint from the before-image, along with '
  'every other import-writable column — see the column comment on '
  'applications.last_import_row_fingerprint for why. '
  'v_restorable_columns MUST stay in sync with '
  'apply_import_row_transactional''s v_text_columns/v_array_columns plus '
  'last_import_row_fingerprint '
  '(20260726108000_apply_import_row_function.sql, '
  '20260727010000_wire_row_fingerprint_idempotent_reimport.sql): this '
  'function can only restore what that function can write. Update both '
  'together.';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260727020000_fingerprint_fix_followups')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260727030000_gate_existing_claimed_updates.sql
-- ============================================================
-- gate_existing_claimed_updates.sql
--
-- Task 28's final whole-phase spec-compliance review found a real,
-- verified gap between the binding design spec and the shipped code, not a
-- deliberate deviation: the design spec
-- (docs/superpowers/specs/2026-07-25-accepted-participants-import-design.md,
-- "Exact flow: upload -> invitation", step 10, second bullet) requires that
-- a re-import row matching an ALREADY-CLAIMED application (an active
-- participant, not a staging row) be treated as a "review-required
-- update, never silently applied ... requiring the admin to explicitly
-- confirm the update before it's included in the batch's importable set,
-- since overwriting a claimed participant's data is a materially different
-- risk than updating an unclaimed staging row."
--
-- This was never built. `apply_import_row_transactional` has always
-- collapsed `existing_unclaimed` and `existing_claimed` into the identical
-- update branch (`if v_row.duplicate_status in ('existing_unclaimed',
-- 'existing_claimed') then ...`), auto-applying overwrites to active
-- participants with no distinct safeguard. Confirmed by tracing the plan's
-- own illustrative code (docs/superpowers/plans/2026-07-26-...-plan.md) --
-- the collapsed form was drafted there from the start, so no per-task
-- review ever compared it back to the spec's step-10 wording.
--
-- This is worth fixing carefully rather than deferring, because the
-- existing safety net (rollback) is usually UNAVAILABLE for exactly the
-- population this gap affects: rollback_import_batch_transactional blocks
-- on any participant_invitations row whose status has left 'not_sent', and
-- a claimed participant is BY DEFINITION one who was already invited and
-- accepted. So an unreviewed overwrite of a claimed participant's data
-- often cannot be cleanly undone after the fact.
--
-- MECHANISM CHOSEN: a per-row approval flag, set at the batch level (this
-- preview UI has no per-row action infrastructure of any kind yet -- see
-- preview-table.tsx, every control is batch-scoped), defaulting to false.
-- apply_import_row_transactional now classifies an unapproved
-- existing_claimed row as 'blocked' (the same terminal, no-write outcome
-- already used for blocked_downstream), rather than taking the update
-- branch. Approving is a new explicit admin action
-- (approveClaimedUpdatesForCaller in preview/actions.ts) that flips the
-- flag for every existing_claimed row in the batch and is itself audited --
-- matching the spec's rule 6 ("every sensitive administrative action ...
-- is audited") and its own step-10 language ("requiring the admin to
-- explicitly confirm the update").
alter table import_rows add column claimed_update_approved boolean not null default false;

comment on column import_rows.claimed_update_approved is
  'Design-spec-required gate (Task 28 fix): an existing_claimed row is only '
  'applied as an update if this is true. Set only by '
  'approveClaimedUpdatesForCaller (preview/actions.ts), an explicit, '
  'audited admin action distinct from validation/mapping/confirm. Ignored '
  'for every other duplicate_status value -- an existing_unclaimed row '
  'applies regardless of this flag, matching the spec''s distinction that '
  'only ALREADY-CLAIMED (active participant) overwrites need this review '
  'step.';

-- ---------------------------------------------------------------------
-- apply_import_row_transactional, replaced.
--
-- `create or replace function` because every prior revision
-- (20260726108000, 20260726109600, 20260727010000) is already applied live
-- and immutable -- the established pattern for this function. The full
-- body is restated because plpgsql has no partial-replace form; the ONLY
-- change versus 20260727010000 is marked NEW below: the existing_claimed
-- branch now requires claimed_update_approved before taking the update
-- path, refusing (classifying as 'blocked') otherwise. existing_unclaimed
-- is completely unaffected -- it still applies unconditionally, exactly as
-- before, since the spec's distinction is specifically about CLAIMED
-- (active participant) records.
-- ---------------------------------------------------------------------
create or replace function apply_import_row_transactional(
  p_import_row_id uuid,
  p_import_batch_id uuid,
  p_actor_id uuid
) returns text as $$
declare
  v_batch_status text;
  v_row import_rows;
  v_normalized jsonb;
  v_email text;
  v_application_id uuid;
  v_previous_application jsonb;
  v_previous_answers jsonb;
  v_raw_values jsonb;
  v_key text;
  v_value jsonb;
  v_is_array boolean;
  v_application_number text;
  v_existing_fingerprint text;
  v_text_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs'
  ];
  v_array_columns text[] := array['interests', 'track_interests'];
  v_update_sql text;
  v_set_clauses text[] := array[]::text[];
begin
  select status into v_batch_status from import_batches where id = p_import_batch_id;
  if v_batch_status = 'rolled_back' then
    raise exception 'Import batch % has been rolled back; cannot apply row %', p_import_batch_id, p_import_row_id;
  end if;

  select * into v_row from import_rows
  where id = p_import_row_id and import_batch_id = p_import_batch_id
  for update;

  if v_row.id is null then
    raise exception 'Import row % not found in batch %', p_import_row_id, p_import_batch_id;
  end if;

  if v_row.action_taken is not null then
    return 'already_applied';
  end if;

  if v_row.validation_status = 'invalid' then
    update import_rows set action_taken = 'skipped_error' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'blocked_downstream' then
    update import_rows set action_taken = 'blocked' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'duplicate_in_file' then
    update import_rows set action_taken = 'skipped_unchanged' where id = v_row.id;
    return 'skipped';
  end if;

  ------------------------------------------------------------------
  -- NEW: existing_claimed requires explicit prior approval (design spec
  -- step 10's "review-required update"). Checked before any lock is taken
  -- on the destination application and before the normalized-row parsing
  -- below, mirroring blocked_downstream's shape immediately above: nothing
  -- is going to be applied, so nothing further needs to be prepared.
  --
  -- existing_unclaimed is deliberately NOT covered by this check -- the
  -- spec's risk distinction is specifically about an ALREADY-CLAIMED
  -- (active, logged-in) participant's data being silently overwritten.
  -- An unclaimed staging row carries no such risk and continues to apply
  -- unconditionally, exactly as every revision of this function has always
  -- done.
  ------------------------------------------------------------------
  if v_row.duplicate_status = 'existing_claimed' and not v_row.claimed_update_approved then
    update import_rows set action_taken = 'blocked' where id = v_row.id;
    return 'skipped';
  end if;

  v_normalized := coalesce(v_row.normalized_row, '{}'::jsonb);
  v_email := v_normalized->>'email';
  if v_email is null or v_email = '' then
    raise exception 'Import row % has no normalized email but passed validation', v_row.id;
  end if;

  select coalesce(jsonb_object_agg(m.target_key, to_jsonb(v_row.raw_row->>m.source_column_index)), '{}'::jsonb)
  into v_raw_values
  from import_column_mappings m
  where m.import_batch_id = p_import_batch_id
    and m.target_key is not null
    and m.target_kind <> 'ignored';

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    v_application_id := v_row.destination_application_id;
    if v_application_id is null then
      raise exception 'Import row % is marked % but has no destination_application_id', v_row.id, v_row.duplicate_status;
    end if;

    perform 1 from applications where id = v_application_id for update;

    select last_import_row_fingerprint into v_existing_fingerprint
    from applications where id = v_application_id;

    if v_existing_fingerprint = v_row.row_fingerprint then
      update import_rows set
        action_taken = 'skipped_unchanged',
        destination_application_id = v_application_id
      where id = v_row.id;

      insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
      values (
        'application',
        v_application_id,
        'import_skip_unchanged',
        'admin',
        p_actor_id,
        jsonb_build_object(
          'batchId', p_import_batch_id,
          'importRowId', v_row.id,
          'excelRowNumber', v_row.excel_row_number,
          'rowFingerprint', v_row.row_fingerprint
        )
      );

      return 'skipped';
    end if;

    select to_jsonb(a.*) into v_previous_application from applications a where a.id = v_application_id;
    if v_previous_application is null then
      raise exception 'Destination application % for import row % no longer exists', v_application_id, v_row.id;
    end if;

    select coalesce(jsonb_agg(to_jsonb(aa.*)), '[]'::jsonb) into v_previous_answers
    from application_answers aa where aa.application_id = v_application_id;

    update import_rows set
      action_taken = 'updated',
      previous_application_snapshot = v_previous_application,
      previous_answers_snapshot = v_previous_answers,
      destination_application_id = v_application_id
    where id = v_row.id;
  else
    v_application_number := next_application_number();

    insert into applications (applicant_id, imported_email, import_batch_id, status, application_number)
    values (null, v_email, p_import_batch_id, 'accepted', v_application_number)
    returning id into v_application_id;

    update import_rows set
      action_taken = 'inserted',
      destination_application_id = v_application_id
    where id = v_row.id;
  end if;

  foreach v_key in array v_text_columns loop
    if v_normalized ? v_key then
      v_value := v_normalized->v_key;
      v_is_array := jsonb_typeof(v_value) = 'array';
      v_set_clauses := v_set_clauses || format(
        '%I = %L',
        v_key,
        case
          when v_value is null or jsonb_typeof(v_value) = 'null' then null
          when v_is_array then (select string_agg(e, ', ') from jsonb_array_elements_text(v_value) as e)
          else v_value #>> '{}'
        end
      );
    end if;
  end loop;

  foreach v_key in array v_array_columns loop
    if v_normalized ? v_key then
      v_value := v_normalized->v_key;
      v_set_clauses := v_set_clauses || format(
        '%I = %L::text[]',
        v_key,
        case
          when v_value is null or jsonb_typeof(v_value) = 'null' then null
          when jsonb_typeof(v_value) = 'array' then (
            select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_value) as e
          )
          else array[v_value #>> '{}']
        end
      );
    end if;
  end loop;

  if v_normalized ? 'birth_date' then
    declare
      v_birth_raw text := v_normalized->>'birth_date';
      v_birth_date date;
    begin
      if v_birth_raw is not null and v_birth_raw <> '' then
        begin
          v_birth_date := v_birth_raw::date;
          v_set_clauses := v_set_clauses || format('birth_date = %L::date', v_birth_date);
        exception when others then
          null;
        end;
      end if;
    end;
  end if;

  v_set_clauses := v_set_clauses || format('last_import_row_fingerprint = %L', v_row.row_fingerprint);

  if array_length(v_set_clauses, 1) > 0 then
    v_update_sql := format(
      'update applications set %s where id = %L',
      array_to_string(v_set_clauses, ', '),
      v_application_id
    );
    execute v_update_sql;
  end if;

  for v_key, v_value in select * from jsonb_each(v_normalized) loop
    insert into application_answers (
      application_id, question_key, normalized_value, raw_value, value_type,
      source, is_sensitive, import_batch_id
    ) values (
      v_application_id,
      v_key,
      case
        when jsonb_typeof(v_value) = 'string' then v_value #>> '{}'
        else v_value::text
      end,
      coalesce(
        v_raw_values->>v_key,
        case
          when jsonb_typeof(v_value) = 'string' then v_value #>> '{}'
          else v_value::text
        end
      ),
      case when jsonb_typeof(v_value) = 'array' then 'multiselect' else 'text' end,
      'import',
      v_key in (
        'accessibility_requirements', 'dietary_requirements',
        'emergency_contact_name', 'emergency_contact_phone', 'special_needs'
      ),
      p_import_batch_id
    )
    on conflict (application_id, question_key, source) do update set
      normalized_value = excluded.normalized_value,
      raw_value = excluded.raw_value,
      value_type = excluded.value_type,
      is_sensitive = excluded.is_sensitive,
      import_batch_id = excluded.import_batch_id;
  end loop;

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    insert into application_status_history (application_id, old_status, new_status, changed_by, note)
    values (
      v_application_id,
      (v_previous_application->>'status')::application_status,
      'accepted',
      p_actor_id,
      format('Updated by import batch %s', p_import_batch_id)
    );
  else
    insert into application_status_history (application_id, old_status, new_status, changed_by, note)
    values (v_application_id, null, 'accepted', p_actor_id, format('Created by import batch %s', p_import_batch_id));
  end if;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'application',
    v_application_id,
    case when v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then 'import_update' else 'import_insert' end,
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_import_batch_id, 'importRowId', v_row.id)
  );

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    return 'updated';
  end if;
  return 'inserted';
end;
$$ language plpgsql set search_path = public, pg_temp;

comment on function apply_import_row_transactional(uuid, uuid, uuid) is
  'Per-row transactional import apply (Task 15, currently on its 4th '
  'revision -- see 20260726108000, 20260726109600, 20260727010000, and this '
  'file, each via create or replace function). Refuses to apply into a '
  'batch whose status is ''rolled_back''. On the existing_unclaimed/'
  'existing_claimed path, compares the row''s row_fingerprint against the '
  'destination application''s last_import_row_fingerprint and classifies an '
  'exact match as ''skipped_unchanged''. NEW in this revision: an '
  'existing_claimed row additionally requires import_rows.'
  'claimed_update_approved = true (set only by an explicit, audited admin '
  'action, approveClaimedUpdatesForCaller in preview/actions.ts) or it is '
  'classified ''blocked'' rather than applied -- the design spec''s '
  '"review-required update" requirement for overwriting an already-claimed, '
  'active participant''s data. existing_unclaimed is unaffected by this '
  'check and continues to apply unconditionally. The is_sensitive key list '
  'inlined in this function''s application_answers insert must be kept in '
  'sync with SENSITIVE_QUESTION_KEYS in src/lib/validation/import.ts and '
  'the fixture in tests/rls/import.test.ts.';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260727030000_gate_existing_claimed_updates')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260730100000_add_travel_operations_and_participant_care_roles.sql
-- ============================================================
-- add_travel_operations_and_participant_care_roles.sql
--
-- Phase A of the controlled-account-provisioning design
-- (docs/superpowers/specs/2026-07-30-controlled-account-provisioning-design.md,
-- section 3.3a). Adds the two new staff roles approved for the sensitive-data
-- separation: travel_operations_staff (travel/visa/passport/funding) and
-- participant_care_staff (medical/accessibility/dietary/emergency-contact).
--
-- Isolated in its own migration file, with nothing else in it: Postgres
-- requires a new enum value to be committed before it can be referenced by
-- any policy or check constraint. No prior migration in this repo has ever
-- used `alter type ... add value`, so this keeps the ordering
-- correct-by-construction rather than relying on how the migration runner
-- batches statements.
alter type user_role add value 'travel_operations_staff';
alter type user_role add value 'participant_care_staff';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260730100000_add_travel_operations_and_participant_care_roles')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260730110000_application_travel_and_health_info_tables.sql
-- ============================================================
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


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260730110000_application_travel_and_health_info_tables')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260731100000_phase_b_import_field_extensions.sql
-- ============================================================
-- phase_b_import_field_extensions.sql
--
-- Phase B of the controlled-account-provisioning design
-- (docs/superpowers/specs/2026-07-30-controlled-account-provisioning-design.md,
-- section 13 — read it before changing anything here). Connects the
-- accepted-participant import pipeline to the fields approved for Phase B:
-- applications.full_name, four structured allocation columns, and the two
-- Phase-A sensitive tables' file-reference columns (renamed per approval).
--
-- All changes are additive/non-destructive. Nothing here alters existing
-- data or drops anything applied by an earlier migration.

------------------------------------------------------------------
-- applications.full_name — first-class column (approval decision #1).
-- Nullable: existing rows (including every row imported before this
-- migration) simply have no value yet until a future import or manual edit
-- populates it. The original imported "full name" answer continues to live
-- in application_answers as the source/audit copy — this migration does not
-- touch that table's existing rows.
------------------------------------------------------------------
alter table applications add column full_name text;

------------------------------------------------------------------
-- Structured allocation columns (approval decision #2). Promoted to
-- first-class columns specifically so feature extraction keeps reading only
-- named applications columns — never open-ended application_answers keys.
-- session_languages/track_N_focus_areas are text[] (normalized multi-select,
-- same shape as the existing interests/track_interests columns).
-- primary_track/secondary_track already exist (added in Phase A,
-- 20260730110000) and are unchanged here.
------------------------------------------------------------------
alter table applications add column session_languages text[];
alter table applications add column track_1_focus_areas text[];
alter table applications add column track_2_focus_areas text[];
alter table applications add column track_3_focus_areas text[];

------------------------------------------------------------------
-- Rename Phase A's storage-path columns to the URL-reference naming approved
-- for Phase B (decision #4): these hold a Google Drive share-link URL
-- verbatim, not a Supabase Storage path — the original names implied a
-- secure internal transfer that Phase B explicitly does not perform (see
-- design doc section 13.8). A rename, not a drop+add: both columns are still
-- empty in production (Phase A shipped with nothing writing to them), so
-- this is safe and loses no data, but a rename is used rather than
-- drop/recreate to preserve the column's identity/comments/any future
-- pg_stat history rather than presenting it as a wholly new column.
------------------------------------------------------------------
alter table application_travel_info rename column passport_copy_storage_path to passport_copy_url;
alter table application_travel_info rename column visa_photo_storage_path to passport_photo_url;

comment on column application_travel_info.passport_copy_url is
  'Google Drive share-link URL exported from the Google Form response, '
  'stored verbatim as plain text. NOT a Supabase Storage path -- no file is '
  'downloaded or re-hosted by this platform. Access to the underlying file '
  'depends entirely on the Google Drive sharing permissions configured by '
  'the form owner, which this platform does not control. Restricted to '
  'travel_operations_staff/super_admin by this table''s existing RLS '
  'policies (application_travel_info_staff_all,
  20260730110000_application_travel_and_health_info_tables.sql) -- never '
  'exposed through applications or application_answers.';

comment on column application_travel_info.passport_photo_url is
  'Same handling as passport_copy_url -- see that column''s comment.';

------------------------------------------------------------------
-- application_answers.section -- lets the mapping/preview UI (Phase B) and
-- any future admin view group original imported answers by category without
-- re-deriving section membership from question_key string matching.
-- Defaulted 'application' for every pre-existing row (safe: nothing
-- previously classified is reclassified as sensitive here, since is_sensitive
-- is untouched) and for any generic_answer column the import pipeline
-- doesn't explicitly tag going forward.
------------------------------------------------------------------
alter table application_answers add column section text not null default 'application'
  check (section in ('profile', 'application', 'allocation', 'travel', 'health'));

------------------------------------------------------------------
-- import_column_mappings.target_kind -- widen to allow the two new kinds
-- introduced for Phase B (travel_field/health_field), so the mapping layer
-- can express "this column must go to the sensitive table" as an explicit,
-- checkable value instead of overloading core_field. Existing rows (all
-- necessarily one of the 4 original values) are unaffected -- this only
-- widens the allowed set, it does not touch any existing row.
------------------------------------------------------------------
alter table import_column_mappings drop constraint import_column_mappings_target_kind_valid;
alter table import_column_mappings add constraint import_column_mappings_target_kind_valid
  check (target_kind in ('core_field', 'known_answer', 'generic_answer', 'ignored', 'travel_field', 'health_field'));


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260731100000_phase_b_import_field_extensions')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260731110000_phase_b_apply_import_row_sensitive_writes.sql
-- ============================================================
-- phase_b_apply_import_row_sensitive_writes.sql
--
-- Phase B (design doc section 13.6): extends apply_import_row_transactional
-- to write applications.full_name (never overwriting an existing non-blank
-- value with a blank import), the four new structured allocation array
-- columns, and conditional upserts into application_travel_info /
-- application_health_info. Also extends rollback_import_batch_transactional
-- to restore all of the above on an updated-row rollback, per the two
-- functions' documented "must stay in sync" invariant
-- (20260726109600_rollback_safety_fixes.sql's trailing comment).
--
-- `create or replace function` because every prior revision is already
-- applied live and immutable -- the established pattern for both functions.
-- The full body of each is restated because plpgsql has no partial-replace
-- form.

------------------------------------------------------------------
-- import_rows gains two more before-image snapshot columns, mirroring
-- previous_application_snapshot/previous_answers_snapshot exactly (same
-- nullable jsonb shape, same "only ever set on the update path, cleared by
-- rollback" lifecycle) -- needed so an updated-row rollback can restore
-- application_travel_info/application_health_info the same way it already
-- restores application_answers.
------------------------------------------------------------------
alter table import_rows add column previous_travel_snapshot jsonb;
alter table import_rows add column previous_health_snapshot jsonb;
--
-- Transactional behavior (design doc section 13.6, decision recorded here):
-- a single participant row's sensitive-data write failure rolls back that
-- row's ENTIRE apply (application + answers + travel + health) and the row
-- is stamped skipped_error by the caller (confirm/actions.ts's existing
-- per-row catch, unchanged) -- never a silent partial import. This falls
-- out of the existing invariant that this function has no swallowing
-- `exception when others` block and runs as one Postgres transaction per
-- row: the new travel/health upserts below are simply more statements
-- inside that same existing transaction, so any error they raise aborts
-- everything else in the same per-row apply exactly like any other
-- statement in this function already does.

------------------------------------------------------------------
-- apply_import_row_transactional
------------------------------------------------------------------
create or replace function apply_import_row_transactional(
  p_import_row_id uuid,
  p_import_batch_id uuid,
  p_actor_id uuid
) returns text as $$
declare
  v_batch_status text;
  v_row import_rows;
  v_normalized jsonb;
  v_email text;
  v_application_id uuid;
  v_previous_application jsonb;
  v_previous_answers jsonb;
  v_previous_travel jsonb;
  v_previous_health jsonb;
  v_raw_values jsonb;
  v_key text;
  v_value jsonb;
  v_is_array boolean;
  v_application_number text;
  v_existing_fingerprint text;
  v_text_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs',
    -- Phase B: profile columns approved for direct applications writes.
    -- full_name is handled separately below (never-overwrite-with-blank
    -- rule), not through this generic array.
    'gender', 'whatsapp_number', 'education_level', 'institution_or_workplace',
    'linkedin_url', 'primary_track', 'secondary_track'
  ];
  v_array_columns text[] := array[
    'interests', 'track_interests',
    -- Phase B: structured allocation columns (design doc section 13.2/13.4,
    -- approved decision #2) -- normalized text[] arrays, read directly by
    -- feature extraction, never derived from application_answers.
    'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas'
  ];
  -- Phase B: target_key -> application_travel_info column. Kept in this
  -- function (not a lookup table) for the same reason v_text_columns/
  -- v_array_columns already are: this function's own arrays are the runtime
  -- authority (defense in depth alongside the TS-side manifest in
  -- src/lib/import/known-application-columns.ts, which rejects an invalid
  -- mapping earlier, at confirmMapping time).
  v_travel_columns text[] := array[
    'support_level_requested', 'can_attend_without_full_support', 'departure_airport',
    'visa_required', 'invitation_letter_required', 'passport_full_name',
    'passport_full_name_ar', 'passport_place_of_issue', 'passport_copy_url', 'passport_photo_url'
  ];
  v_travel_date_columns text[] := array['passport_issue_date', 'passport_expiry_date', 'passport_birth_date'];
  v_health_columns text[] := array[
    'allergies', 'medical_conditions', 'emergency_medication', 'accessibility_requirements',
    'dietary_requirements', 'accommodation_preference', 'cultural_or_religious_requirements',
    'emergency_contact_name', 'emergency_contact_relationship', 'emergency_contact_phone'
  ];
  v_health_bool_columns text[] := array['consent_given'];
  v_full_name text;
  v_update_sql text;
  v_set_clauses text[] := array[]::text[];
  -- Phase B (design doc section 13.7): which section an application_answers
  -- row is tagged with. Determined once per key from which of the new
  -- travel/health arrays (or neither) it belongs to -- every key still
  -- lands in application_answers regardless of section, preserving the
  -- original imported value exactly as before.
  v_section text;
begin
  select status into v_batch_status from import_batches where id = p_import_batch_id;
  if v_batch_status = 'rolled_back' then
    raise exception 'Import batch % has been rolled back; cannot apply row %', p_import_batch_id, p_import_row_id;
  end if;

  select * into v_row from import_rows
  where id = p_import_row_id and import_batch_id = p_import_batch_id
  for update;

  if v_row.id is null then
    raise exception 'Import row % not found in batch %', p_import_row_id, p_import_batch_id;
  end if;

  if v_row.action_taken is not null then
    return 'already_applied';
  end if;

  if v_row.validation_status = 'invalid' then
    update import_rows set action_taken = 'skipped_error' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'blocked_downstream' then
    update import_rows set action_taken = 'blocked' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'duplicate_in_file' then
    update import_rows set action_taken = 'skipped_unchanged' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'existing_claimed' and not v_row.claimed_update_approved then
    update import_rows set action_taken = 'blocked' where id = v_row.id;
    return 'skipped';
  end if;

  v_normalized := coalesce(v_row.normalized_row, '{}'::jsonb);
  v_email := v_normalized->>'email';
  if v_email is null or v_email = '' then
    raise exception 'Import row % has no normalized email but passed validation', v_row.id;
  end if;

  select coalesce(jsonb_object_agg(m.target_key, to_jsonb(v_row.raw_row->>m.source_column_index)), '{}'::jsonb)
  into v_raw_values
  from import_column_mappings m
  where m.import_batch_id = p_import_batch_id
    and m.target_key is not null
    and m.target_kind <> 'ignored';

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    v_application_id := v_row.destination_application_id;
    if v_application_id is null then
      raise exception 'Import row % is marked % but has no destination_application_id', v_row.id, v_row.duplicate_status;
    end if;

    perform 1 from applications where id = v_application_id for update;

    select last_import_row_fingerprint into v_existing_fingerprint
    from applications where id = v_application_id;

    if v_existing_fingerprint = v_row.row_fingerprint then
      update import_rows set
        action_taken = 'skipped_unchanged',
        destination_application_id = v_application_id
      where id = v_row.id;

      insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
      values (
        'application',
        v_application_id,
        'import_skip_unchanged',
        'admin',
        p_actor_id,
        jsonb_build_object(
          'batchId', p_import_batch_id,
          'importRowId', v_row.id,
          'excelRowNumber', v_row.excel_row_number,
          'rowFingerprint', v_row.row_fingerprint
        )
      );

      return 'skipped';
    end if;

    select to_jsonb(a.*) into v_previous_application from applications a where a.id = v_application_id;
    if v_previous_application is null then
      raise exception 'Destination application % for import row % no longer exists', v_application_id, v_row.id;
    end if;

    select coalesce(jsonb_agg(to_jsonb(aa.*)), '[]'::jsonb) into v_previous_answers
    from application_answers aa where aa.application_id = v_application_id;

    -- Phase B: snapshot the existing travel/health rows too (each is at
    -- most one row, 1:1 on application_id), so an updated-row rollback can
    -- restore them exactly like application_answers below.
    select to_jsonb(t.*) into v_previous_travel from application_travel_info t where t.application_id = v_application_id;
    select to_jsonb(h.*) into v_previous_health from application_health_info h where h.application_id = v_application_id;

    update import_rows set
      action_taken = 'updated',
      previous_application_snapshot = v_previous_application,
      previous_answers_snapshot = v_previous_answers,
      previous_travel_snapshot = v_previous_travel,
      previous_health_snapshot = v_previous_health,
      destination_application_id = v_application_id
    where id = v_row.id;
  else
    v_application_number := next_application_number();

    insert into applications (applicant_id, imported_email, import_batch_id, status, application_number)
    values (null, v_email, p_import_batch_id, 'accepted', v_application_number)
    returning id into v_application_id;

    update import_rows set
      action_taken = 'inserted',
      destination_application_id = v_application_id
    where id = v_row.id;
  end if;

  foreach v_key in array v_text_columns loop
    if v_normalized ? v_key then
      v_value := v_normalized->v_key;
      v_is_array := jsonb_typeof(v_value) = 'array';
      v_set_clauses := v_set_clauses || format(
        '%I = %L',
        v_key,
        case
          when v_value is null or jsonb_typeof(v_value) = 'null' then null
          when v_is_array then (select string_agg(e, ', ') from jsonb_array_elements_text(v_value) as e)
          else v_value #>> '{}'
        end
      );
    end if;
  end loop;

  foreach v_key in array v_array_columns loop
    if v_normalized ? v_key then
      v_value := v_normalized->v_key;
      v_set_clauses := v_set_clauses || format(
        '%I = %L::text[]',
        v_key,
        case
          when v_value is null or jsonb_typeof(v_value) = 'null' then null
          when jsonb_typeof(v_value) = 'array' then (
            select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_value) as e
          )
          else array[v_value #>> '{}']
        end
      );
    end if;
  end loop;

  ------------------------------------------------------------------
  -- Phase B: applications.full_name -- never overwrite an existing
  -- non-blank value with a blank imported one (approved decision #1). A
  -- non-blank imported name always overwrites (matching every other
  -- re-importable column's existing behavior); a blank/absent imported name
  -- leaves whatever full_name the application already has untouched.
  ------------------------------------------------------------------
  if v_normalized ? 'full_name' then
    v_full_name := nullif(trim(both from (v_normalized->>'full_name')), '');
    if v_full_name is not null then
      v_set_clauses := v_set_clauses || format('full_name = %L', v_full_name);
    end if;
  end if;

  if v_normalized ? 'birth_date' then
    declare
      v_birth_raw text := v_normalized->>'birth_date';
      v_birth_date date;
    begin
      if v_birth_raw is not null and v_birth_raw <> '' then
        begin
          v_birth_date := v_birth_raw::date;
          v_set_clauses := v_set_clauses || format('birth_date = %L::date', v_birth_date);
        exception when others then
          null;
        end;
      end if;
    end;
  end if;

  v_set_clauses := v_set_clauses || format('last_import_row_fingerprint = %L', v_row.row_fingerprint);

  if array_length(v_set_clauses, 1) > 0 then
    v_update_sql := format(
      'update applications set %s where id = %L',
      array_to_string(v_set_clauses, ', '),
      v_application_id
    );
    execute v_update_sql;
  end if;

  ------------------------------------------------------------------
  -- Phase B: application_travel_info -- conditional upsert. Only executed
  -- if at least one mapped travel target_key has a non-blank value in this
  -- row (design doc section 13.6: "avoid creating empty sensitive rows when
  -- all related fields are blank"). Text/boolean columns via
  -- v_travel_columns; the three passport dates handled separately since an
  -- unparseable date must not abort the row (matches birth_date's existing
  -- swallow-and-skip-that-one-field pattern) but IS still flagged upstream
  -- as a row-validation warning (see row-validation.ts's isPlausibleDate) --
  -- the SQL layer's job here is only to not crash on a bad date string, not
  -- to be the sole place that catches it.
  ------------------------------------------------------------------
  -- Built with real bind-style placeholders via a single parameterized
  -- INSERT ... ON CONFLICT, not dynamic-SQL column assembly: every
  -- application_travel_info column is always present in the statement (as
  -- NULL where this row has no value for it), and ON CONFLICT DO UPDATE SET
  -- col = COALESCE(EXCLUDED.col, application_travel_info.col) means an
  -- absent/blank field in THIS import never clobbers a value a previous
  -- import (or manual edit) already set for that same participant -- while
  -- a present, non-blank field always overwrites, matching every other
  -- re-importable column's existing behavior. has_travel_data guards
  -- against creating an empty row when nothing in this section was mapped
  -- at all.
  declare
    v_has_travel_data boolean := false;
    v_passport_issue_date date;
    v_passport_expiry_date date;
    v_passport_birth_date date;
  begin
    foreach v_key in array v_travel_columns || v_travel_date_columns loop
      if v_normalized ? v_key and v_normalized->>v_key is not null and v_normalized->>v_key <> '' then
        v_has_travel_data := true;
      end if;
    end loop;

    if v_has_travel_data then
      begin v_passport_issue_date := nullif(v_normalized->>'passport_issue_date', '')::date; exception when others then v_passport_issue_date := null; end;
      begin v_passport_expiry_date := nullif(v_normalized->>'passport_expiry_date', '')::date; exception when others then v_passport_expiry_date := null; end;
      begin v_passport_birth_date := nullif(v_normalized->>'passport_birth_date', '')::date; exception when others then v_passport_birth_date := null; end;

      insert into application_travel_info (
        application_id, support_level_requested, can_attend_without_full_support,
        departure_airport, visa_required, invitation_letter_required,
        passport_full_name, passport_full_name_ar, passport_place_of_issue,
        passport_issue_date, passport_expiry_date, passport_birth_date,
        passport_copy_url, passport_photo_url
      ) values (
        v_application_id,
        nullif(v_normalized->>'support_level_requested', ''),
        nullif(v_normalized->>'can_attend_without_full_support', '')::boolean,
        nullif(v_normalized->>'departure_airport', ''),
        nullif(v_normalized->>'visa_required', '')::boolean,
        nullif(v_normalized->>'invitation_letter_required', '')::boolean,
        nullif(v_normalized->>'passport_full_name', ''),
        nullif(v_normalized->>'passport_full_name_ar', ''),
        nullif(v_normalized->>'passport_place_of_issue', ''),
        v_passport_issue_date,
        v_passport_expiry_date,
        v_passport_birth_date,
        nullif(v_normalized->>'passport_copy_url', ''),
        nullif(v_normalized->>'passport_photo_url', '')
      )
      on conflict (application_id) do update set
        support_level_requested = coalesce(excluded.support_level_requested, application_travel_info.support_level_requested),
        can_attend_without_full_support = coalesce(excluded.can_attend_without_full_support, application_travel_info.can_attend_without_full_support),
        departure_airport = coalesce(excluded.departure_airport, application_travel_info.departure_airport),
        visa_required = coalesce(excluded.visa_required, application_travel_info.visa_required),
        invitation_letter_required = coalesce(excluded.invitation_letter_required, application_travel_info.invitation_letter_required),
        passport_full_name = coalesce(excluded.passport_full_name, application_travel_info.passport_full_name),
        passport_full_name_ar = coalesce(excluded.passport_full_name_ar, application_travel_info.passport_full_name_ar),
        passport_place_of_issue = coalesce(excluded.passport_place_of_issue, application_travel_info.passport_place_of_issue),
        passport_issue_date = coalesce(excluded.passport_issue_date, application_travel_info.passport_issue_date),
        passport_expiry_date = coalesce(excluded.passport_expiry_date, application_travel_info.passport_expiry_date),
        passport_birth_date = coalesce(excluded.passport_birth_date, application_travel_info.passport_birth_date),
        passport_copy_url = coalesce(excluded.passport_copy_url, application_travel_info.passport_copy_url),
        passport_photo_url = coalesce(excluded.passport_photo_url, application_travel_info.passport_photo_url),
        updated_at = now();
    end if;
  end;

  ------------------------------------------------------------------
  -- Phase B: application_health_info -- same real-INSERT-ON-CONFLICT shape
  -- as application_travel_info above (see that block's comment for the full
  -- rationale). consent_given is boolean, cast defensively via nullif so a
  -- malformed value never aborts the whole row.
  ------------------------------------------------------------------
  declare
    v_has_health_data boolean := false;
    v_consent_given boolean;
  begin
    foreach v_key in array v_health_columns || v_health_bool_columns loop
      if v_normalized ? v_key and v_normalized->>v_key is not null and v_normalized->>v_key <> '' then
        v_has_health_data := true;
      end if;
    end loop;

    if v_has_health_data then
      begin v_consent_given := nullif(v_normalized->>'consent_given', '')::boolean; exception when others then v_consent_given := null; end;

      insert into application_health_info (
        application_id, allergies, medical_conditions, emergency_medication,
        accessibility_requirements, dietary_requirements, accommodation_preference,
        cultural_or_religious_requirements, emergency_contact_name,
        emergency_contact_relationship, emergency_contact_phone, consent_given
      ) values (
        v_application_id,
        nullif(v_normalized->>'allergies', ''),
        nullif(v_normalized->>'medical_conditions', ''),
        nullif(v_normalized->>'emergency_medication', ''),
        nullif(v_normalized->>'accessibility_requirements', ''),
        nullif(v_normalized->>'dietary_requirements', ''),
        nullif(v_normalized->>'accommodation_preference', ''),
        nullif(v_normalized->>'cultural_or_religious_requirements', ''),
        nullif(v_normalized->>'emergency_contact_name', ''),
        nullif(v_normalized->>'emergency_contact_relationship', ''),
        nullif(v_normalized->>'emergency_contact_phone', ''),
        v_consent_given
      )
      on conflict (application_id) do update set
        allergies = coalesce(excluded.allergies, application_health_info.allergies),
        medical_conditions = coalesce(excluded.medical_conditions, application_health_info.medical_conditions),
        emergency_medication = coalesce(excluded.emergency_medication, application_health_info.emergency_medication),
        accessibility_requirements = coalesce(excluded.accessibility_requirements, application_health_info.accessibility_requirements),
        dietary_requirements = coalesce(excluded.dietary_requirements, application_health_info.dietary_requirements),
        accommodation_preference = coalesce(excluded.accommodation_preference, application_health_info.accommodation_preference),
        cultural_or_religious_requirements = coalesce(excluded.cultural_or_religious_requirements, application_health_info.cultural_or_religious_requirements),
        emergency_contact_name = coalesce(excluded.emergency_contact_name, application_health_info.emergency_contact_name),
        emergency_contact_relationship = coalesce(excluded.emergency_contact_relationship, application_health_info.emergency_contact_relationship),
        emergency_contact_phone = coalesce(excluded.emergency_contact_phone, application_health_info.emergency_contact_phone),
        consent_given = coalesce(excluded.consent_given, application_health_info.consent_given),
        updated_at = now();
    end if;
  end;

  ------------------------------------------------------------------
  -- application_answers: every normalized key, regardless of section,
  -- exactly as before (design doc section 13.7: original imported answers
  -- are preserved even for keys that also land on a first-class column or a
  -- travel/health table). Phase B adds `section` tagging so a future admin
  -- view can filter without re-deriving section from question_key.
  ------------------------------------------------------------------
  for v_key, v_value in select * from jsonb_each(v_normalized) loop
    v_section := case
      when v_key = any(v_travel_columns) or v_key = any(v_travel_date_columns) then 'travel'
      when v_key = any(v_health_columns) or v_key = any(v_health_bool_columns) then 'health'
      when v_key in (
        'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas',
        'language_ability', 'organization', 'organization_role', 'experience_level', 'interests',
        'topics_to_learn', 'volunteer_experience_years', 'previous_conference_participation',
        'initiative_or_organization_name', 'expected_contribution', 'expected_skills_experiences'
      ) then 'allocation'
      when v_key in (
        'gender', 'whatsapp_number', 'education_level', 'institution_or_workplace', 'linkedin_url',
        'primary_track', 'secondary_track', 'full_name', 'nationality', 'city', 'country', 'age_group', 'preferred_language'
      ) then 'profile'
      else 'application'
    end;

    insert into application_answers (
      application_id, question_key, normalized_value, raw_value, value_type,
      source, is_sensitive, import_batch_id, section
    ) values (
      v_application_id,
      v_key,
      case
        when jsonb_typeof(v_value) = 'string' then v_value #>> '{}'
        else v_value::text
      end,
      coalesce(
        v_raw_values->>v_key,
        case
          when jsonb_typeof(v_value) = 'string' then v_value #>> '{}'
          else v_value::text
        end
      ),
      case when jsonb_typeof(v_value) = 'array' then 'multiselect' else 'text' end,
      'import',
      v_key in (
        'accessibility_requirements', 'dietary_requirements',
        'emergency_contact_name', 'emergency_contact_relationship', 'emergency_contact_phone',
        'special_needs', 'allergies', 'medical_conditions', 'emergency_medication',
        'accommodation_preference', 'cultural_or_religious_requirements', 'consent_given'
      ),
      p_import_batch_id,
      v_section
    )
    on conflict (application_id, question_key, source) do update set
      normalized_value = excluded.normalized_value,
      raw_value = excluded.raw_value,
      value_type = excluded.value_type,
      is_sensitive = excluded.is_sensitive,
      import_batch_id = excluded.import_batch_id,
      section = excluded.section;
  end loop;

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    insert into application_status_history (application_id, old_status, new_status, changed_by, note)
    values (
      v_application_id,
      (v_previous_application->>'status')::application_status,
      'accepted',
      p_actor_id,
      format('Updated by import batch %s', p_import_batch_id)
    );
  else
    insert into application_status_history (application_id, old_status, new_status, changed_by, note)
    values (v_application_id, null, 'accepted', p_actor_id, format('Created by import batch %s', p_import_batch_id));
  end if;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'application',
    v_application_id,
    case when v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then 'import_update' else 'import_insert' end,
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_import_batch_id, 'importRowId', v_row.id)
  );

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    return 'updated';
  end if;
  return 'inserted';
end;
$$ language plpgsql set search_path = public, pg_temp;

comment on function apply_import_row_transactional(uuid, uuid, uuid) is
  'Per-row transactional import apply. Phase B (design doc section 13) adds: '
  'applications.full_name (never overwrites an existing non-blank value with '
  'a blank import), 4 new structured allocation array columns '
  '(session_languages, track_1/2/3_focus_areas), and conditional upserts '
  'into application_travel_info/application_health_info (only when at least '
  'one mapped field for that section is non-blank). v_travel_columns/'
  'v_health_columns MUST stay in sync with '
  'src/lib/import/known-application-columns.ts (the TS-side manifest '
  'confirmMapping validates against) and with rollback_import_batch_'
  'transactional''s own restore arrays -- update all three together. The '
  'is_sensitive key list is sourced from SENSITIVE_QUESTION_KEYS in '
  'src/lib/validation/import.ts -- keep both in sync.';

------------------------------------------------------------------
-- rollback_import_batch_transactional -- extended per the two functions'
-- documented "must stay in sync" invariant. Only the updated-row branch
-- needs new logic: an inserted row's application_travel_info/
-- application_health_info rows already cascade-delete for free (both
-- tables are `on delete cascade` from applications(id),
-- 20260730110000_application_travel_and_health_info_tables.sql), so the
-- existing `delete from applications where id = v_application_id` on the
-- inserted-row branch already fully undoes them with zero new code.
------------------------------------------------------------------
create or replace function rollback_import_batch_transactional(
  p_batch_id uuid,
  p_actor_id uuid
) returns void as $$
declare
  v_batch import_batches;
  v_blocker_count int;
  v_blocker_detail text;
  v_scope_application_ids uuid[];
  v_row record;
  v_snapshot jsonb;
  v_answers jsonb;
  v_application_id uuid;
  v_old_status application_status;
  v_update_sql text;
  v_set_clauses text[];
  v_key text;
  v_restorable_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs',
    'birth_date',
    -- Phase B
    'full_name', 'gender', 'whatsapp_number', 'education_level',
    'institution_or_workplace', 'linkedin_url', 'primary_track', 'secondary_track'
  ];
  v_array_columns text[] := array[
    'interests', 'track_interests',
    'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas'
  ];
begin
  select * into v_batch from import_batches where id = p_batch_id for update;

  if v_batch.id is null then
    raise exception 'Import batch % not found', p_batch_id;
  end if;

  if v_batch.status = 'rolled_back' then
    raise exception 'Import batch % has already been rolled back', p_batch_id;
  end if;

  select coalesce(array_agg(distinct id), array[]::uuid[])
  into v_scope_application_ids
  from (
    select a.id
    from applications a
    where a.import_batch_id = p_batch_id
    union
    select r.destination_application_id as id
    from import_rows r
    where r.import_batch_id = p_batch_id
      and r.destination_application_id is not null
      and r.action_taken in ('inserted', 'updated')
  ) scope;

  select count(*) into v_blocker_count
  from participant_feature_snapshots s
  where s.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_feature_snapshots row(s) reference applications from this batch. Delete the feature extraction run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from cluster_memberships c
  where c.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % cluster_memberships row(s) reference applications from this batch. Delete the clustering run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from allocation_assignments al
  where al.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % allocation_assignments row(s) reference applications from this batch. Delete the allocation run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from schedule_publications sp
  where sp.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publications row(s) reference applications from this batch. Retract the publication first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from schedule_publication_draft_items spdi
  where spdi.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publication_draft_items row(s) reference applications from this batch. Discard the schedule draft first.',
      p_batch_id, v_blocker_count;
  end if;

  perform 1
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
  for update of pi;

  select count(*), string_agg(distinct pi.status, ', ' order by pi.status)
  into v_blocker_count, v_blocker_detail
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
    and pi.status <> 'not_sent';
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_invitations row(s) for applications in this batch are no longer in ''not_sent'' status (found: %). An invitation has already been sent to a real recipient and an auth user may exist for them; revoke the invitation(s) before rolling back.',
      p_batch_id, v_blocker_count, v_blocker_detail;
  end if;

  for v_row in
    select * from import_rows
    where import_batch_id = p_batch_id
      and action_taken in ('inserted', 'updated')
    order by excel_row_number
    for update
  loop
    v_application_id := v_row.destination_application_id;

    if v_row.action_taken = 'inserted' then
      if v_application_id is not null then
        insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
        values (
          'application',
          v_application_id,
          'import_rollback_delete',
          'admin',
          p_actor_id,
          jsonb_build_object(
            'batchId', p_batch_id,
            'importRowId', v_row.id,
            'excelRowNumber', v_row.excel_row_number
          )
        );

        -- Phase B: application_travel_info/application_health_info rows for
        -- this application are cascade-deleted automatically by this same
        -- delete (both tables are `on delete cascade` from
        -- applications(id)) -- no new statement needed here.
        delete from applications where id = v_application_id;
      end if;

    else
      v_snapshot := v_row.previous_application_snapshot;

      if v_application_id is null or v_snapshot is null then
        raise exception 'Cannot roll back import batch %: import row % is marked ''updated'' but has no recoverable snapshot (destination_application_id=%, previous_application_snapshot is null).',
          p_batch_id, v_row.id, v_application_id;
      end if;

      perform 1 from applications where id = v_application_id for update;

      select status into v_old_status from applications where id = v_application_id;

      v_set_clauses := array[]::text[];

      foreach v_key in array v_restorable_columns loop
        v_set_clauses := v_set_clauses || format('%I = %L', v_key, v_snapshot->>v_key);
      end loop;

      foreach v_key in array v_array_columns loop
        v_set_clauses := v_set_clauses || format(
          '%I = %L::text[]',
          v_key,
          case
            when v_snapshot->v_key is null or jsonb_typeof(v_snapshot->v_key) = 'null' then null
            else (select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_snapshot->v_key) as e)
          end
        );
      end loop;

      v_set_clauses := v_set_clauses || format('status = %L::application_status', (v_snapshot->>'status')::application_status);

      v_update_sql := format(
        'update applications set %s where id = %L',
        array_to_string(v_set_clauses, ', '),
        v_application_id
      );
      execute v_update_sql;

      delete from application_answers where application_id = v_application_id;

      v_answers := coalesce(v_row.previous_answers_snapshot, '[]'::jsonb);

      insert into application_answers (
        id, application_id, question_key, question_label, normalized_value,
        raw_value, value_type, source, is_sensitive, import_batch_id,
        section, created_at, updated_at
      )
      select
        (e->>'id')::uuid,
        (e->>'application_id')::uuid,
        e->>'question_key',
        e->>'question_label',
        e->>'normalized_value',
        e->>'raw_value',
        e->>'value_type',
        e->>'source',
        (e->>'is_sensitive')::boolean,
        (e->>'import_batch_id')::uuid,
        -- Phase B: section was added after some pre-existing snapshots may
        -- have been captured without it; coalesce to the column default so
        -- a snapshot taken before this migration still restores cleanly.
        coalesce(e->>'section', 'application'),
        (e->>'created_at')::timestamptz,
        (e->>'updated_at')::timestamptz
      from jsonb_array_elements(v_answers) as e;

      -- Phase B: restore application_travel_info/application_health_info to
      -- their pre-update state. Each is delete-then-conditionally-reinsert
      -- (mirroring application_answers' own delete-and-reinsert pattern
      -- immediately above) rather than an UPDATE, since the row may not
      -- have existed at all before this apply (e.g. the first import that
      -- added travel data to a previously travel-less application) --
      -- deleting and only reinserting if a real snapshot exists correctly
      -- restores that "no row" state too.
      delete from application_travel_info where application_id = v_application_id;
      if v_row.previous_travel_snapshot is not null then
        insert into application_travel_info (
          application_id, support_level_requested, can_attend_without_full_support,
          departure_airport, visa_required, invitation_letter_required,
          passport_full_name, passport_full_name_ar, passport_birth_date,
          passport_place_of_issue, passport_issue_date, passport_expiry_date,
          passport_copy_url, passport_photo_url, created_at, updated_at
        )
        select
          v_application_id,
          e->>'support_level_requested',
          (e->>'can_attend_without_full_support')::boolean,
          e->>'departure_airport',
          (e->>'visa_required')::boolean,
          (e->>'invitation_letter_required')::boolean,
          e->>'passport_full_name',
          e->>'passport_full_name_ar',
          (e->>'passport_birth_date')::date,
          e->>'passport_place_of_issue',
          (e->>'passport_issue_date')::date,
          (e->>'passport_expiry_date')::date,
          e->>'passport_copy_url',
          e->>'passport_photo_url',
          (e->>'created_at')::timestamptz,
          (e->>'updated_at')::timestamptz
        from (select v_row.previous_travel_snapshot as e) s;
      end if;

      delete from application_health_info where application_id = v_application_id;
      if v_row.previous_health_snapshot is not null then
        insert into application_health_info (
          application_id, allergies, medical_conditions, emergency_medication,
          accessibility_requirements, dietary_requirements, accommodation_preference,
          cultural_or_religious_requirements, emergency_contact_name,
          emergency_contact_relationship, emergency_contact_phone, consent_given,
          created_at, updated_at
        )
        select
          v_application_id,
          e->>'allergies',
          e->>'medical_conditions',
          e->>'emergency_medication',
          e->>'accessibility_requirements',
          e->>'dietary_requirements',
          e->>'accommodation_preference',
          e->>'cultural_or_religious_requirements',
          e->>'emergency_contact_name',
          e->>'emergency_contact_relationship',
          e->>'emergency_contact_phone',
          (e->>'consent_given')::boolean,
          (e->>'created_at')::timestamptz,
          (e->>'updated_at')::timestamptz
        from (select v_row.previous_health_snapshot as e) s;
      end if;

      insert into application_status_history (application_id, old_status, new_status, changed_by, note)
      values (
        v_application_id,
        v_old_status,
        (v_snapshot->>'status')::application_status,
        p_actor_id,
        format('Restored by rollback of import batch %s', p_batch_id)
      );

      insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, new_values)
      values (
        'application',
        v_application_id,
        'import_rollback_restore',
        'admin',
        p_actor_id,
        jsonb_build_object(
          'batchId', p_batch_id,
          'importRowId', v_row.id,
          'excelRowNumber', v_row.excel_row_number,
          'restoredAnswerCount', jsonb_array_length(v_answers)
        ),
        v_snapshot
      );
    end if;

    update import_rows set
      action_taken = null,
      previous_application_snapshot = null,
      previous_answers_snapshot = null,
      previous_travel_snapshot = null,
      previous_health_snapshot = null
    where id = v_row.id;
  end loop;

  update import_batches set
    status = 'rolled_back',
    inserted_count = 0,
    updated_count = 0,
    processing_lock_token = null,
    processing_lock_expires_at = null,
    next_chunk_offset = 0
  where id = p_batch_id;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'import_batch',
    p_batch_id,
    'import_rollback',
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_batch_id)
  );
end;
$$ language plpgsql set search_path = public, pg_temp;

comment on function rollback_import_batch_transactional(uuid, uuid) is
  'Undoes an entire import batch atomically, or refuses entirely. Phase B '
  'adds restoring application_travel_info/application_health_info on an '
  'updated-row rollback (delete-then-conditionally-reinsert from '
  'import_rows.previous_travel_snapshot/previous_health_snapshot, mirroring '
  'application_answers'' own pattern) -- an inserted-row rollback needs no '
  'new logic since both tables cascade-delete from applications(id) for '
  'free. v_restorable_columns/v_array_columns MUST stay in sync with '
  'apply_import_row_transactional''s own arrays -- update both together.';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260731110000_phase_b_apply_import_row_sensitive_writes')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260731120000_phase_b_travel_health_extra_columns.sql
-- ============================================================
-- phase_b_travel_health_extra_columns.sql
--
-- Phase B (design doc section 13.3, points 2-3): three columns approved for
-- application_travel_info/application_health_info that were documented but
-- not yet added to the schema. Additive and non-destructive.
alter table application_travel_info add column passport_full_name_ar text;
alter table application_travel_info add column passport_birth_date date;
alter table application_health_info add column emergency_contact_relationship text;

comment on column application_travel_info.passport_full_name_ar is
  'Full passport name in Arabic, distinct from passport_full_name (English) '
  '-- both may be required by different visa/travel processes.';

comment on column application_travel_info.passport_birth_date is
  'Date of birth as it appears on the passport, distinct from '
  'applications.birth_date (self-reported elsewhere on the form) -- kept '
  'separate so the authoritative travel-document value is never silently '
  'overwritten by a possibly-differing self-reported age-group answer.';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260731120000_phase_b_travel_health_extra_columns')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260731130000_phase_b_fix_rollback_fingerprint_regression.sql
-- ============================================================
-- phase_b_fix_rollback_fingerprint_regression.sql
--
-- Bug fix: 20260731110000_phase_b_apply_import_row_sensitive_writes.sql's
-- rollback_import_batch_transactional rewrite was based on
-- 20260726109600_rollback_safety_fixes.sql's v_restorable_columns list,
-- which predates 20260727010000_wire_row_fingerprint_idempotent_reimport.sql
-- adding 'last_import_row_fingerprint' to that same array. The Phase B
-- rewrite silently dropped it, regressing rollback so a restored
-- application's fingerprint stayed at the rolled-back batch's value instead
-- of reverting to the prior batch's -- caught by
-- tests/import/reimport-fingerprint-live.test.ts, which failed after the
-- Phase B migration (the fingerprint comparison at the end of that test).
--
-- Fix: re-add 'last_import_row_fingerprint' to v_restorable_columns. Nothing
-- else in the function changes. `create or replace function` because the
-- broken version is already applied live.
create or replace function rollback_import_batch_transactional(
  p_batch_id uuid,
  p_actor_id uuid
) returns void as $$
declare
  v_batch import_batches;
  v_blocker_count int;
  v_blocker_detail text;
  v_scope_application_ids uuid[];
  v_row record;
  v_snapshot jsonb;
  v_answers jsonb;
  v_application_id uuid;
  v_old_status application_status;
  v_update_sql text;
  v_set_clauses text[];
  v_key text;
  v_restorable_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs',
    'birth_date', 'last_import_row_fingerprint',
    -- Phase B
    'full_name', 'gender', 'whatsapp_number', 'education_level',
    'institution_or_workplace', 'linkedin_url', 'primary_track', 'secondary_track'
  ];
  v_array_columns text[] := array[
    'interests', 'track_interests',
    'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas'
  ];
begin
  select * into v_batch from import_batches where id = p_batch_id for update;

  if v_batch.id is null then
    raise exception 'Import batch % not found', p_batch_id;
  end if;

  if v_batch.status = 'rolled_back' then
    raise exception 'Import batch % has already been rolled back', p_batch_id;
  end if;

  select coalesce(array_agg(distinct id), array[]::uuid[])
  into v_scope_application_ids
  from (
    select a.id
    from applications a
    where a.import_batch_id = p_batch_id
    union
    select r.destination_application_id as id
    from import_rows r
    where r.import_batch_id = p_batch_id
      and r.destination_application_id is not null
      and r.action_taken in ('inserted', 'updated')
  ) scope;

  select count(*) into v_blocker_count
  from participant_feature_snapshots s
  where s.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_feature_snapshots row(s) reference applications from this batch. Delete the feature extraction run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from cluster_memberships c
  where c.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % cluster_memberships row(s) reference applications from this batch. Delete the clustering run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from allocation_assignments al
  where al.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % allocation_assignments row(s) reference applications from this batch. Delete the allocation run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from schedule_publications sp
  where sp.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publications row(s) reference applications from this batch. Retract the publication first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from schedule_publication_draft_items spdi
  where spdi.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publication_draft_items row(s) reference applications from this batch. Discard the schedule draft first.',
      p_batch_id, v_blocker_count;
  end if;

  perform 1
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
  for update of pi;

  select count(*), string_agg(distinct pi.status, ', ' order by pi.status)
  into v_blocker_count, v_blocker_detail
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
    and pi.status <> 'not_sent';
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_invitations row(s) for applications in this batch are no longer in ''not_sent'' status (found: %). An invitation has already been sent to a real recipient and an auth user may exist for them; revoke the invitation(s) before rolling back.',
      p_batch_id, v_blocker_count, v_blocker_detail;
  end if;

  for v_row in
    select * from import_rows
    where import_batch_id = p_batch_id
      and action_taken in ('inserted', 'updated')
    order by excel_row_number
    for update
  loop
    v_application_id := v_row.destination_application_id;

    if v_row.action_taken = 'inserted' then
      if v_application_id is not null then
        insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
        values (
          'application',
          v_application_id,
          'import_rollback_delete',
          'admin',
          p_actor_id,
          jsonb_build_object(
            'batchId', p_batch_id,
            'importRowId', v_row.id,
            'excelRowNumber', v_row.excel_row_number
          )
        );

        delete from applications where id = v_application_id;
      end if;

    else
      v_snapshot := v_row.previous_application_snapshot;

      if v_application_id is null or v_snapshot is null then
        raise exception 'Cannot roll back import batch %: import row % is marked ''updated'' but has no recoverable snapshot (destination_application_id=%, previous_application_snapshot is null).',
          p_batch_id, v_row.id, v_application_id;
      end if;

      perform 1 from applications where id = v_application_id for update;

      select status into v_old_status from applications where id = v_application_id;

      v_set_clauses := array[]::text[];

      foreach v_key in array v_restorable_columns loop
        v_set_clauses := v_set_clauses || format('%I = %L', v_key, v_snapshot->>v_key);
      end loop;

      foreach v_key in array v_array_columns loop
        v_set_clauses := v_set_clauses || format(
          '%I = %L::text[]',
          v_key,
          case
            when v_snapshot->v_key is null or jsonb_typeof(v_snapshot->v_key) = 'null' then null
            else (select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_snapshot->v_key) as e)
          end
        );
      end loop;

      v_set_clauses := v_set_clauses || format('status = %L::application_status', (v_snapshot->>'status')::application_status);

      v_update_sql := format(
        'update applications set %s where id = %L',
        array_to_string(v_set_clauses, ', '),
        v_application_id
      );
      execute v_update_sql;

      delete from application_answers where application_id = v_application_id;

      v_answers := coalesce(v_row.previous_answers_snapshot, '[]'::jsonb);

      insert into application_answers (
        id, application_id, question_key, question_label, normalized_value,
        raw_value, value_type, source, is_sensitive, import_batch_id,
        section, created_at, updated_at
      )
      select
        (e->>'id')::uuid,
        (e->>'application_id')::uuid,
        e->>'question_key',
        e->>'question_label',
        e->>'normalized_value',
        e->>'raw_value',
        e->>'value_type',
        e->>'source',
        (e->>'is_sensitive')::boolean,
        (e->>'import_batch_id')::uuid,
        coalesce(e->>'section', 'application'),
        (e->>'created_at')::timestamptz,
        (e->>'updated_at')::timestamptz
      from jsonb_array_elements(v_answers) as e;

      delete from application_travel_info where application_id = v_application_id;
      if v_row.previous_travel_snapshot is not null then
        insert into application_travel_info (
          application_id, support_level_requested, can_attend_without_full_support,
          departure_airport, visa_required, invitation_letter_required,
          passport_full_name, passport_full_name_ar, passport_birth_date,
          passport_place_of_issue, passport_issue_date, passport_expiry_date,
          passport_copy_url, passport_photo_url, created_at, updated_at
        )
        select
          v_application_id,
          e->>'support_level_requested',
          (e->>'can_attend_without_full_support')::boolean,
          e->>'departure_airport',
          (e->>'visa_required')::boolean,
          (e->>'invitation_letter_required')::boolean,
          e->>'passport_full_name',
          e->>'passport_full_name_ar',
          (e->>'passport_birth_date')::date,
          e->>'passport_place_of_issue',
          (e->>'passport_issue_date')::date,
          (e->>'passport_expiry_date')::date,
          e->>'passport_copy_url',
          e->>'passport_photo_url',
          (e->>'created_at')::timestamptz,
          (e->>'updated_at')::timestamptz
        from (select v_row.previous_travel_snapshot as e) s;
      end if;

      delete from application_health_info where application_id = v_application_id;
      if v_row.previous_health_snapshot is not null then
        insert into application_health_info (
          application_id, allergies, medical_conditions, emergency_medication,
          accessibility_requirements, dietary_requirements, accommodation_preference,
          cultural_or_religious_requirements, emergency_contact_name,
          emergency_contact_relationship, emergency_contact_phone, consent_given,
          created_at, updated_at
        )
        select
          v_application_id,
          e->>'allergies',
          e->>'medical_conditions',
          e->>'emergency_medication',
          e->>'accessibility_requirements',
          e->>'dietary_requirements',
          e->>'accommodation_preference',
          e->>'cultural_or_religious_requirements',
          e->>'emergency_contact_name',
          e->>'emergency_contact_relationship',
          e->>'emergency_contact_phone',
          (e->>'consent_given')::boolean,
          (e->>'created_at')::timestamptz,
          (e->>'updated_at')::timestamptz
        from (select v_row.previous_health_snapshot as e) s;
      end if;

      insert into application_status_history (application_id, old_status, new_status, changed_by, note)
      values (
        v_application_id,
        v_old_status,
        (v_snapshot->>'status')::application_status,
        p_actor_id,
        format('Restored by rollback of import batch %s', p_batch_id)
      );

      insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, new_values)
      values (
        'application',
        v_application_id,
        'import_rollback_restore',
        'admin',
        p_actor_id,
        jsonb_build_object(
          'batchId', p_batch_id,
          'importRowId', v_row.id,
          'excelRowNumber', v_row.excel_row_number,
          'restoredAnswerCount', jsonb_array_length(v_answers)
        ),
        v_snapshot
      );
    end if;

    update import_rows set
      action_taken = null,
      previous_application_snapshot = null,
      previous_answers_snapshot = null,
      previous_travel_snapshot = null,
      previous_health_snapshot = null
    where id = v_row.id;
  end loop;

  update import_batches set
    status = 'rolled_back',
    inserted_count = 0,
    updated_count = 0,
    processing_lock_token = null,
    processing_lock_expires_at = null,
    next_chunk_offset = 0
  where id = p_batch_id;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'import_batch',
    p_batch_id,
    'import_rollback',
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_batch_id)
  );
end;
$$ language plpgsql set search_path = public, pg_temp;

comment on function rollback_import_batch_transactional(uuid, uuid) is
  'Undoes an entire import batch atomically, or refuses entirely. Restores '
  'application_travel_info/application_health_info on an updated-row '
  'rollback (delete-then-conditionally-reinsert from '
  'import_rows.previous_travel_snapshot/previous_health_snapshot). '
  'v_restorable_columns MUST include last_import_row_fingerprint (Task 25) '
  'and MUST stay in sync with apply_import_row_transactional''s own arrays '
  '-- update both together. (Fixed 20260731130000: a Phase B rewrite '
  'transiently dropped last_import_row_fingerprint from this array.)';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260731130000_phase_b_fix_rollback_fingerprint_regression')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260801100000_phase_c_provisioning_table.sql
-- ============================================================
-- phase_c_provisioning_table.sql
--
-- Phase C of the controlled-account-provisioning design
-- (docs/superpowers/specs/2026-07-30-controlled-account-provisioning-design.md,
-- section 14 -- the authoritative, approved design for this migration).
-- Adds the password-change gate flag on profiles and the durable,
-- resumable provisioning-state table for admin-controlled account
-- creation/linking/email delivery. Additive and non-destructive.

------------------------------------------------------------------
-- profiles.must_change_password -- the actual gate
-- (participant)/(shell)/layout.tsx reads. Never authenticated-writable
-- (the existing column-level grant on profiles, from
-- 20260727000000_fix_profiles_role_privilege_escalation.sql, grants
-- update only on full_name/email -- this column is deliberately excluded,
-- written only via service-role from the provisioning/password-change
-- server actions).
------------------------------------------------------------------
alter table profiles add column must_change_password boolean not null default false;

------------------------------------------------------------------
-- participant_account_provisioning -- one row per application, the
-- resumable state for bulk account creation/linking/email delivery.
-- must_change_password here is a denormalized mirror of profiles' own
-- column (kept in sync by always being written in the same server-action
-- call), existing only so the admin table's own display/filter queries
-- don't need to join auth.users or add cost to the participant-facing
-- layout's per-request read.
------------------------------------------------------------------
create type provisioning_account_status as enum (
  'no_account', 'account_created', 'password_change_required',
  'active', 'existing_account', 'creation_failed', 'conflict'
);
create type provisioning_email_status as enum ('not_sent', 'sending', 'sent', 'failed');

create table participant_account_provisioning (
  application_id uuid primary key references applications(id) on delete cascade,
  auth_user_id uuid references auth.users(id) on delete set null,
  normalized_email text not null,
  account_status provisioning_account_status not null default 'no_account',
  email_status provisioning_email_status not null default 'not_sent',
  must_change_password boolean not null default false,
  account_created_at timestamptz,
  last_login_email_sent_at timestamptz,
  login_email_send_count int not null default 0,
  provisioning_attempt_count int not null default 0,
  last_attempt_at timestamptz,
  -- Deliberately never a raw caught-error message and never a password --
  -- the provisioning action layer only ever writes one of a small fixed
  -- set of safe, human-readable strings here. See design doc section 14.2.
  last_error_code text,
  last_error_message text,
  created_by uuid references profiles(id),
  updated_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index participant_account_provisioning_status_idx on participant_account_provisioning (account_status);
create index participant_account_provisioning_email_status_idx on participant_account_provisioning (email_status);

create trigger participant_account_provisioning_set_updated_at
  before update on participant_account_provisioning
  for each row execute function extensions.moddatetime('updated_at');

alter table participant_account_provisioning enable row level security;

create policy participant_account_provisioning_staff_all on participant_account_provisioning
  for all
  using (current_user_role() in ('registration_admission_manager', 'super_admin'))
  with check (current_user_role() in ('registration_admission_manager', 'super_admin'));

comment on table participant_account_provisioning is
  'Phase C durable, resumable state for admin-controlled participant '
  'account provisioning. One row per application. Never stores a password '
  '-- the approved temporary password (password@123) is a code-level '
  'constant, never persisted here or anywhere else. Access restricted to '
  'registration_admission_manager/super_admin only, matching this design''s '
  'approved authorization model (deliberately narrower than the sibling '
  'participants/imports pages, which gate on agenda staff).';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260801100000_phase_c_provisioning_table')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260802100000_resend_delivery_tracking.sql
-- ============================================================
-- resend_delivery_tracking.sql
--
-- Production Resend delivery tracking for the Phase C login-details email
-- (docs/superpowers/specs/2026-07-30-controlled-account-provisioning-design.md,
-- section 14/15). Additive and non-destructive: widens the existing
-- provisioning_email_status enum with delivery-lifecycle values and adds
-- the columns needed to correlate a Resend webhook event back to the
-- correct provisioning row.

------------------------------------------------------------------
-- provisioning_email_status: add 'delivered' and 'bounced'. 'sending' and
-- 'failed' already exist from Phase C; 'not_sent'/'sent' too. New values
-- only ever set by: the send call itself ('sending' immediately before
-- the API call, 'sent' on a successful response) and the webhook handler
-- ('delivered'/'bounced' on the corresponding Resend event).
------------------------------------------------------------------
alter type provisioning_email_status add value 'delivered';
alter type provisioning_email_status add value 'bounced';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260802100000_resend_delivery_tracking')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260802110000_resend_delivery_tracking_columns.sql
-- ============================================================
-- resend_delivery_tracking_columns.sql
--
-- Production Resend delivery tracking (design doc section 14/15). Adds the
-- columns needed to correlate a Resend webhook event back to the correct
-- participant_account_provisioning row and to record delivery lifecycle
-- timestamps/failure detail. Additive and non-destructive.
--
-- resend_email_id is the correlation key: Resend's webhook payload includes
-- data.email_id, which matches the id returned by emails.send() at send
-- time -- looking up the provisioning row by this id (not by recipient
-- email, which could theoretically collide across resends) is how the
-- webhook handler finds the right row.
alter table participant_account_provisioning add column resend_email_id text;
alter table participant_account_provisioning add column delivered_at timestamptz;
alter table participant_account_provisioning add column bounced_at timestamptz;
-- last_send_attempt_at is distinct from the existing last_attempt_at
-- (which covers provisioning attempts generally, e.g. account-creation
-- retries) -- this one specifically marks the moment the send API call was
-- made, independent of whether it succeeded.
alter table participant_account_provisioning add column last_send_attempt_at timestamptz;

create index participant_account_provisioning_resend_email_id_idx
  on participant_account_provisioning (resend_email_id)
  where resend_email_id is not null;

comment on column participant_account_provisioning.resend_email_id is
  'Resend''s email id, returned by emails.send() and echoed in every '
  'webhook event for that email. The correlation key the webhook handler '
  'uses to find the right row -- never derived from recipient email alone.';

------------------------------------------------------------------
-- resend_webhook_events -- idempotency ledger for the webhook endpoint.
-- Resend's webhooks are delivered via Svix, which retries on a non-2xx
-- response and stamps every delivery attempt (including retries of the
-- SAME logical event) with the same `svix-id` header. Recording that id
-- here and checking it first is what makes duplicate delivery safe: a
-- retried delivery is detected and short-circuited before any provisioning
-- row is touched a second time.
------------------------------------------------------------------
create table resend_webhook_events (
  svix_id text primary key,
  event_type text not null,
  resend_email_id text,
  received_at timestamptz not null default now()
);

alter table resend_webhook_events enable row level security;
-- No client-facing policy at all: this table is written exclusively by the
-- webhook route handler's service-role client and read by nothing else.
-- Default-deny (RLS enabled, zero policies) matches this schema's existing
-- pattern for service-role-only tables (e.g. audit_logs' insert path).



INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260802110000_resend_delivery_tracking_columns')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260802120000_nullable_staff_actor_columns.sql
-- ============================================================
-- Relax 4 staff-actor "who did this" columns to nullable with ON DELETE
-- SET NULL, so deleting a staff Auth user no longer fails with an FK
-- violation. These columns record who ran/uploaded/staged something for
-- audit purposes only -- never participant data, never conference
-- configuration content itself.
--
-- Historical rows keep their existing values; only future staff-user
-- deletions will null these out automatically via the new SET NULL clause.

alter table public.import_batches
  alter column uploaded_by drop not null;
alter table public.import_batches
  drop constraint if exists import_batches_uploaded_by_fkey;
alter table public.import_batches
  add constraint import_batches_uploaded_by_fkey
  foreign key (uploaded_by) references public.profiles(id) on delete set null;

alter table public.feature_extraction_runs
  alter column run_by drop not null;
alter table public.feature_extraction_runs
  drop constraint if exists feature_extraction_runs_run_by_fkey;
alter table public.feature_extraction_runs
  add constraint feature_extraction_runs_run_by_fkey
  foreign key (run_by) references public.profiles(id) on delete set null;

alter table public.allocation_runs
  alter column run_by drop not null;
alter table public.allocation_runs
  drop constraint if exists allocation_runs_run_by_fkey;
alter table public.allocation_runs
  add constraint allocation_runs_run_by_fkey
  foreign key (run_by) references public.profiles(id) on delete set null;

alter table public.schedule_publication_drafts
  alter column staged_by drop not null;
alter table public.schedule_publication_drafts
  drop constraint if exists schedule_publication_drafts_staged_by_fkey;
alter table public.schedule_publication_drafts
  add constraint schedule_publication_drafts_staged_by_fkey
  foreign key (staged_by) references public.profiles(id) on delete set null;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260802120000_nullable_staff_actor_columns')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260802130000_nullable_clustering_and_assignment_actor_columns.sql
-- ============================================================
-- Follow-up to 20260802120000: two more staff-actor "who did this" columns
-- were found blocking Auth-user deletion (clustering_runs.run_by was NOT
-- NULL; allocation_assignments.updated_by was already nullable but lacked
-- ON DELETE SET NULL). Same rationale as the prior migration: these are
-- audit-style references only, never participant or conference content.

alter table public.clustering_runs
  alter column run_by drop not null;
alter table public.clustering_runs
  drop constraint if exists clustering_runs_run_by_fkey;
alter table public.clustering_runs
  add constraint clustering_runs_run_by_fkey
  foreign key (run_by) references public.profiles(id) on delete set null;

alter table public.allocation_assignments
  drop constraint if exists allocation_assignments_updated_by_fkey;
alter table public.allocation_assignments
  add constraint allocation_assignments_updated_by_fkey
  foreign key (updated_by) references public.profiles(id) on delete set null;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260802130000_nullable_clustering_and_assignment_actor_columns')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260803100000_add_participants_communications_and_program_attendance_roles.sql
-- ============================================================
-- add_participants_communications_and_program_attendance_roles.sql
--
-- Adds the two approved active staff roles: participants_communications_manager
-- (Excel import, participant account provisioning, login-detail delivery,
-- participant communications) and program_attendance_manager (agenda, feature
-- extraction, clustering, allocation, schedule publication, future
-- QR/scanner/attendance). Purely additive -- the existing unused
-- communications_attendance_manager enum value is left in place untouched
-- (Postgres enums cannot drop values; no profile currently uses it).
--
-- Isolated in its own migration file with nothing else in it, matching the
-- precedent in 20260730100000_add_travel_operations_and_participant_care_roles.sql:
-- a new enum value must be committed before it can be referenced by any
-- policy or check constraint in a later migration.
alter type user_role add value 'participants_communications_manager';
alter type user_role add value 'program_attendance_manager';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260803100000_add_participants_communications_and_program_attendance_roles')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260803110000_participants_communications_manager_rls.sql
-- ============================================================
-- participants_communications_manager_rls.sql
--
-- Grants the new participants_communications_manager role RLS access to
-- exactly the tables its responsibilities cover: accepted-participant Excel
-- import (mapping/validation/preview/confirm/retry/rollback), participant
-- profile management, participant account provisioning, and non-sensitive
-- application answers used for communications. Each policy below is
-- dropped and recreated with the new role added to an existing
-- registration_admission_manager or agenda_allocation_manager policy —
-- Postgres has no "alter policy ... add role" for a USING-clause role list,
-- so recreation is the only way to extend one.
--
-- Deliberately NOT touched: application_answers_sensitive_staff_all
-- (stays super_admin only), application_travel_info, application_health_info
-- (no policy added for this role at all — must remain
-- super_admin/travel_operations_staff/participant_care_staff only, per the
-- explicit "denied access" list for this role), and every agenda/allocation/
-- schedule-publication table (program_attendance_manager's domain, not
-- this role's).

-- applications: staff select + status/reviewer update.
drop policy if exists applications_select_staff on applications;
create policy applications_select_staff on applications
  for select using (current_user_role() in ('registration_admission_manager', 'participants_communications_manager', 'super_admin'));

drop policy if exists applications_update_staff on applications;
create policy applications_update_staff on applications
  for update using (current_user_role() in ('registration_admission_manager', 'participants_communications_manager', 'super_admin'));

-- application_status_history, email_log: staff select (audit trail).
drop policy if exists application_status_history_select_staff on application_status_history;
create policy application_status_history_select_staff on application_status_history
  for select using (current_user_role() in ('registration_admission_manager', 'participants_communications_manager', 'super_admin'));

drop policy if exists email_log_select_staff on email_log;
create policy email_log_select_staff on email_log
  for select using (current_user_role() in ('registration_admission_manager', 'participants_communications_manager', 'super_admin'));

-- application_notes: staff select + insert.
drop policy if exists application_notes_select_staff on application_notes;
create policy application_notes_select_staff on application_notes
  for select using (current_user_role() in ('registration_admission_manager', 'participants_communications_manager', 'super_admin'));

drop policy if exists application_notes_insert_staff on application_notes;
create policy application_notes_insert_staff on application_notes
  for insert with check (current_user_role() in ('registration_admission_manager', 'participants_communications_manager', 'super_admin'));

-- participant_account_provisioning: the account-provisioning table itself.
drop policy if exists participant_account_provisioning_staff_all on participant_account_provisioning;
create policy participant_account_provisioning_staff_all on participant_account_provisioning
  for all
  using (current_user_role() in ('registration_admission_manager', 'participants_communications_manager', 'super_admin'))
  with check (current_user_role() in ('registration_admission_manager', 'participants_communications_manager', 'super_admin'));

-- Import pipeline tables (previously agenda_allocation_manager-only).
drop policy if exists import_batches_staff_all on import_batches;
create policy import_batches_staff_all on import_batches
  for all using (current_user_role() in ('agenda_allocation_manager', 'participants_communications_manager', 'super_admin'));

drop policy if exists import_column_mappings_staff_all on import_column_mappings;
create policy import_column_mappings_staff_all on import_column_mappings
  for all using (current_user_role() in ('agenda_allocation_manager', 'participants_communications_manager', 'super_admin'));

drop policy if exists import_rows_staff_all on import_rows;
create policy import_rows_staff_all on import_rows
  for all using (current_user_role() in ('agenda_allocation_manager', 'participants_communications_manager', 'super_admin'));

drop policy if exists import_mapping_templates_staff_all on import_mapping_templates;
create policy import_mapping_templates_staff_all on import_mapping_templates
  for all using (current_user_role() in ('agenda_allocation_manager', 'participants_communications_manager', 'super_admin'));

drop policy if exists participant_invitations_staff_all on participant_invitations;
create policy participant_invitations_staff_all on participant_invitations
  for all using (current_user_role() in ('agenda_allocation_manager', 'participants_communications_manager', 'super_admin'));

-- application_answers: non-sensitive only. The sensitive-answers policy
-- (application_answers_sensitive_staff_all) is intentionally NOT modified —
-- stays super_admin-only.
drop policy if exists application_answers_staff_all on application_answers;
create policy application_answers_staff_all on application_answers
  for all using (
    not is_sensitive and current_user_role() in ('agenda_allocation_manager', 'participants_communications_manager', 'super_admin')
  );

-- schedule_publications / schedule_publication_items: read-only visibility
-- for communications purposes (this role must be able to view a published
-- participant schedule when reaching out, but has no allocation/publication
-- authority). The existing schedule_publications_staff_all /
-- schedule_publication_items_staff_all policies (agenda_allocation_manager,
-- super_admin) are FULL access (for all) and deliberately left untouched —
-- this role instead gets its own new, additional, SELECT-ONLY policy rather
-- than being folded into the full-access one. Does NOT touch
-- schedule_change_events, schedule_publication_drafts, or
-- schedule_publication_draft_items — those stay
-- agenda_allocation_manager/program_attendance_manager (pre-publication
-- workflow) only.
create policy schedule_publications_select_comms_staff on schedule_publications
  for select using (current_user_role() = 'participants_communications_manager');

create policy schedule_publication_items_select_comms_staff on schedule_publication_items
  for select using (current_user_role() = 'participants_communications_manager');


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260803110000_participants_communications_manager_rls')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260803120000_program_attendance_manager_rls.sql
-- ============================================================
-- program_attendance_manager_rls.sql
--
-- Grants the new program_attendance_manager role the same RLS access as
-- agenda_allocation_manager, matching its responsibilities exactly:
-- conference days, tracks, session types, sessions, rooms, people
-- (speakers/moderators/facilitators/trainers), feature extraction,
-- clustering, allocation (automatic + manual override), and schedule
-- confirmation/publication. Each policy is dropped and recreated with the
-- new role added — Postgres has no "alter policy ... add role".
--
-- Deliberately NOT touched: participant account creation/provisioning,
-- login-details email sending, import pipeline (participants_communications_
-- manager's domain), application_travel_info, application_health_info (must
-- remain super_admin/travel_operations_staff/participant_care_staff only —
-- explicit "denied access" for this role), and staff/role management tables
-- (profiles role-management stays super_admin only).

-- Agenda reference tables.
drop policy if exists conference_days_staff_all on conference_days;
create policy conference_days_staff_all on conference_days
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists tracks_staff_all on tracks;
create policy tracks_staff_all on tracks
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists session_types_staff_all on session_types;
create policy session_types_staff_all on session_types
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists rooms_staff_all on rooms;
create policy rooms_staff_all on rooms
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists people_staff_all on people;
create policy people_staff_all on people
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists tags_staff_all on tags;
create policy tags_staff_all on tags
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists audit_logs_select_staff on audit_logs;
create policy audit_logs_select_staff on audit_logs
  for select using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

-- Sessions.
drop policy if exists sessions_staff_all on sessions;
create policy sessions_staff_all on sessions
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists session_people_staff_all on session_people;
create policy session_people_staff_all on session_people
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists session_tags_staff_all on session_tags;
create policy session_tags_staff_all on session_tags
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

-- Feature extraction, clustering, allocation.
drop policy if exists feature_extraction_rules_staff_all on feature_extraction_rules;
create policy feature_extraction_rules_staff_all on feature_extraction_rules
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists feature_extraction_runs_staff_all on feature_extraction_runs;
create policy feature_extraction_runs_staff_all on feature_extraction_runs
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists participant_feature_snapshots_staff_all on participant_feature_snapshots;
create policy participant_feature_snapshots_staff_all on participant_feature_snapshots
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists clustering_runs_staff_all on clustering_runs;
create policy clustering_runs_staff_all on clustering_runs
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists clusters_staff_all on clusters;
create policy clusters_staff_all on clusters
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists cluster_memberships_staff_all on cluster_memberships;
create policy cluster_memberships_staff_all on cluster_memberships
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists allocation_runs_staff_all on allocation_runs;
create policy allocation_runs_staff_all on allocation_runs
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists allocation_assignments_staff_all on allocation_assignments;
create policy allocation_assignments_staff_all on allocation_assignments
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists allocation_alternatives_staff_all on allocation_alternatives;
create policy allocation_alternatives_staff_all on allocation_alternatives
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists allocation_issues_staff_all on allocation_issues;
create policy allocation_issues_staff_all on allocation_issues
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists allocation_assignment_explanations_staff_all on allocation_assignment_explanations;
create policy allocation_assignment_explanations_staff_all on allocation_assignment_explanations
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

-- Schedule publication.
drop policy if exists schedule_change_events_staff_all on schedule_change_events;
create policy schedule_change_events_staff_all on schedule_change_events
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists schedule_publication_drafts_staff_all on schedule_publication_drafts;
create policy schedule_publication_drafts_staff_all on schedule_publication_drafts
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists schedule_publication_draft_items_staff_all on schedule_publication_draft_items;
create policy schedule_publication_draft_items_staff_all on schedule_publication_draft_items
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists schedule_publications_staff_all on schedule_publications;
create policy schedule_publications_staff_all on schedule_publications
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

drop policy if exists schedule_publication_items_staff_all on schedule_publication_items;
create policy schedule_publication_items_staff_all on schedule_publication_items
  for all using (current_user_role() in ('agenda_allocation_manager', 'program_attendance_manager', 'super_admin'));

-- Import tables: program_attendance_manager needs READ access to see which
-- applications exist for allocation purposes (feature extraction reads
-- applications/application_answers), but NOT full import-management access
-- (upload/map/confirm/rollback stays participants_communications_manager +
-- agenda_allocation_manager only, per this role's explicit denied-access
-- list: "participant account creation" is denied, and import management is
-- a participants_communications_manager responsibility, not this role's).
-- applications/application_answers (non-sensitive) already grant
-- agenda_allocation_manager select via existing policies from Phase 1/5 —
-- confirmed via applications_select_staff and application_answers_staff_all
-- already including agenda_allocation_manager, so no change needed there.


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260803120000_program_attendance_manager_rls')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260804100000_add_admission_policy_and_priority_fields.sql
-- ============================================================
-- add_admission_policy_and_priority_fields.sql
--
-- Phase 6 (docs/superpowers/specs/2026-07-31-flexible-admission-qr-attendance-design.md).
-- New sessions columns for the admission-policy/capacity layer. Purely
-- additive; sessions.is_mandatory/enable_qr_checkin/checkin_opens_at/
-- checkin_closes_at are explicitly untouched (see spec Non-Goals) — this
-- migration supersedes their purpose without modifying them.
alter table sessions
  add column admission_policy text not null default 'priority_then_open',
  add column priority_seats int,
  add column priority_release_at timestamptz,
  add column priority_release_minutes_before int,
  add column late_entry_cutoff_minutes int,
  add column flexible_entry_manual_override boolean;

alter table sessions add constraint sessions_admission_policy_check
  check (admission_policy in ('open', 'priority_then_open', 'restricted', 'plenary', 'cross_cutting'));

alter table sessions add constraint sessions_priority_seats_check
  check (priority_seats is null or (priority_seats >= 0 and priority_seats <= capacity));


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260804100000_add_admission_policy_and_priority_fields')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260804110000_add_scanner_device_role.sql
-- ============================================================
-- add_scanner_device_role.sql
--
-- Adds the scanner_device role: a non-human, per-device staff identity used
-- by the QR check-in / attendance scanner terminals to authenticate against
-- the API without impersonating a real staff member's account.
--
-- Isolated in its own file with nothing else in it, per this repo's
-- established convention (see 20260803100000_add_participants_
-- communications_and_program_attendance_roles.sql) — a new enum value
-- must be committed before any later migration in this plan can
-- reference it in a policy or check constraint.
alter type user_role add value 'scanner_device';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260804110000_add_scanner_device_role')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260804120000_create_attendance_records_table.sql
-- ============================================================
-- create_attendance_records_table.sql
create table attendance_records (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id),
  session_id uuid not null references sessions(id),
  time_slot_group_key text not null,
  status text not null default 'admitted',
  entry_type text not null,
  admitted_at timestamptz not null default now(),
  scanned_by uuid not null references profiles(id),
  device_identifier text,
  superseded_attendance_id uuid references attendance_records(id),
  correction_reason text,
  created_at timestamptz not null default now(),

  constraint attendance_records_status_check check (status in ('admitted', 'rejected', 'transferred_out', 'corrected')),
  constraint attendance_records_entry_type_check check (entry_type in ('priority', 'flexible', 'override'))
);

-- Prevents a duplicate ACTIVE admission for the same participant+session —
-- a corrected/transferred-out row does not block a later new admission for
-- the same pair (spec Data Model section).
create unique index attendance_records_no_duplicate_active
  on attendance_records (application_id, session_id)
  where status = 'admitted';

create index attendance_records_session_idx on attendance_records (session_id);
create index attendance_records_application_idx on attendance_records (application_id);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260804120000_create_attendance_records_table')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260804130000_create_scan_attempts_table.sql
-- ============================================================
-- create_scan_attempts_table.sql
create table scan_attempts (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id),
  session_id uuid references sessions(id),
  scanned_by uuid not null references profiles(id),
  device_identifier text,
  result text not null,
  resulting_attendance_id uuid references attendance_records(id),
  metadata jsonb,
  created_at timestamptz not null default now(),

  constraint scan_attempts_result_check check (result in (
    'admitted', 'flexible_admitted', 'priority_hold', 'full',
    'restricted_denied', 'duplicate', 'timeslot_conflict', 'invalid_qr', 'override_admitted'
  ))
);

create index scan_attempts_session_idx on scan_attempts (session_id);
create index scan_attempts_scanned_by_idx on scan_attempts (scanned_by);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260804130000_create_scan_attempts_table')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260804140000_create_scanner_assignments_table.sql
-- ============================================================
-- create_scanner_assignments_table.sql
create table scanner_assignments (
  id uuid primary key default gen_random_uuid(),
  scanner_user_id uuid not null references profiles(id),
  room_id uuid references rooms(id),
  session_id uuid references sessions(id),
  is_active boolean not null default true,
  assigned_by uuid not null references profiles(id),
  assigned_at timestamptz not null default now(),

  constraint scanner_assignments_scope_check check (room_id is not null or session_id is not null)
);

create index scanner_assignments_scanner_user_idx on scanner_assignments (scanner_user_id);
create index scanner_assignments_session_idx on scanner_assignments (session_id);
create index scanner_assignments_room_idx on scanner_assignments (room_id);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260804140000_create_scanner_assignments_table')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260804150000_attendance_rls_policies.sql
-- ============================================================
-- attendance_rls_policies.sql
alter table attendance_records enable row level security;
alter table scan_attempts enable row level security;
alter table scanner_assignments enable row level security;

-- attendance_records: super_admin/program_attendance_manager full access.
create policy attendance_records_manager_all on attendance_records
  for all using (current_user_role() in ('program_attendance_manager', 'super_admin'));

-- scanner_device: read/insert only for rows tied to its own scanner_assignments.
create policy attendance_records_scanner_select on attendance_records
  for select using (
    current_user_role() = 'scanner_device'
    and session_id in (
      select session_id from scanner_assignments where scanner_user_id = auth.uid() and is_active
      union
      select s.id from sessions s
      join scanner_assignments sa on sa.room_id = s.room_id
      where sa.scanner_user_id = auth.uid() and sa.is_active
    )
  );

create policy attendance_records_scanner_insert on attendance_records
  for insert with check (
    current_user_role() = 'scanner_device'
    and scanned_by = auth.uid()
    and session_id in (
      select session_id from scanner_assignments where scanner_user_id = auth.uid() and is_active
      union
      select s.id from sessions s
      join scanner_assignments sa on sa.room_id = s.room_id
      where sa.scanner_user_id = auth.uid() and sa.is_active
    )
  );

-- scan_attempts: same shape as attendance_records.
create policy scan_attempts_manager_all on scan_attempts
  for all using (current_user_role() in ('program_attendance_manager', 'super_admin'));

create policy scan_attempts_scanner_select on scan_attempts
  for select using (
    current_user_role() = 'scanner_device'
    and session_id in (
      select session_id from scanner_assignments where scanner_user_id = auth.uid() and is_active
      union
      select s.id from sessions s
      join scanner_assignments sa on sa.room_id = s.room_id
      where sa.scanner_user_id = auth.uid() and sa.is_active
    )
  );

create policy scan_attempts_scanner_insert on scan_attempts
  for insert with check (
    current_user_role() = 'scanner_device'
    and scanned_by = auth.uid()
    and session_id in (
      select session_id from scanner_assignments where scanner_user_id = auth.uid() and is_active
      union
      select s.id from sessions s
      join scanner_assignments sa on sa.room_id = s.room_id
      where sa.scanner_user_id = auth.uid() and sa.is_active
    )
  );

-- scanner_assignments: manager full access; scanner_device reads only its own row(s).
create policy scanner_assignments_manager_all on scanner_assignments
  for all using (current_user_role() in ('program_attendance_manager', 'super_admin'));

create policy scanner_assignments_scanner_select_own on scanner_assignments
  for select using (current_user_role() = 'scanner_device' and scanner_user_id = auth.uid());


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260804150000_attendance_rls_policies')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260804160000_scan_attempt_transactional_function.sql
-- ============================================================
-- scan_attempt_transactional_function.sql
--
-- The sole write authority for attendance_records/scan_attempts. Mirrors
-- resolveAdmissionDecision's TypeScript logic exactly (src/lib/attendance/
-- resolve-admission-decision.ts) — if you change one, change both and
-- re-run both test suites. Uses pg_try_advisory_xact_lock keyed on
-- session_id (not a `for update` row lock) to serialize concurrent scans
-- for the same session, wrapped in a short bounded retry loop rather than
-- failing on the first miss (unlike confirm_publication_transactional,
-- which fails fast) — a live-event scanning UI should resolve to a real
-- admission decision (admitted/full/etc.) under normal contention, not
-- surface "try again" to the operator for an ordinary two-scan race.
create or replace function scan_attempt_transactional(
  p_application_id uuid,
  p_session_id uuid,
  p_scanned_by uuid,
  p_device_identifier text,
  p_time_slot_group_key text,
  p_is_override_caller boolean default false
) returns scan_attempts as $$
declare
  v_lock_key bigint;
  v_lock_acquired boolean := false;
  v_retry_count int := 0;
  v_max_retries constant int := 20;      -- ~1s total worst case at 50ms apart
  v_retry_delay_seconds constant numeric := 0.05;
  v_session sessions%rowtype;
  v_application_status text;
  v_total_admitted int;
  v_admitted_priority_count int;
  v_admitted_flexible_count int;
  v_has_this_session boolean;
  v_has_conflicting_session boolean;
  v_effective_priority_pool int;
  v_released boolean;
  v_flexible_pool int;
  v_result text;
  v_entry_type text;
  v_attendance_id uuid;
  v_scan_attempt scan_attempts%rowtype;
begin
  v_lock_key := hashtext(p_session_id::text);

  loop
    v_lock_acquired := pg_try_advisory_xact_lock(v_lock_key);
    exit when v_lock_acquired or v_retry_count >= v_max_retries;
    v_retry_count := v_retry_count + 1;
    perform pg_sleep(v_retry_delay_seconds);
  end loop;

  if not v_lock_acquired then
    raise exception 'Another scan for this session is still being processed after % retries — please retry manually', v_max_retries;
  end if;

  select status into v_application_status from applications where id = p_application_id;
  select * into v_session from sessions where id = p_session_id;

  if v_application_status is null or v_application_status <> 'accepted' or v_session.id is null then
    insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result)
    values (p_application_id, p_session_id, p_scanned_by, p_device_identifier, 'invalid_qr')
    returning * into v_scan_attempt;
    return v_scan_attempt;
  end if;

  select exists(
    select 1 from attendance_records
    where application_id = p_application_id and session_id = p_session_id and status = 'admitted'
  ) into v_has_this_session;

  select exists(
    select 1 from attendance_records
    where application_id = p_application_id and time_slot_group_key = p_time_slot_group_key
      and session_id <> p_session_id and status = 'admitted'
  ) into v_has_conflicting_session;

  select count(*) filter (where status = 'admitted') into v_total_admitted from attendance_records where session_id = p_session_id;
  select count(*) filter (where status = 'admitted' and entry_type = 'priority') into v_admitted_priority_count from attendance_records where session_id = p_session_id;
  select count(*) filter (where status = 'admitted' and entry_type = 'flexible') into v_admitted_flexible_count from attendance_records where session_id = p_session_id;

  v_effective_priority_pool := coalesce(v_session.priority_seats, v_session.capacity);

  -- Both "session not open" and "past late-entry cutoff" collapse to the
  -- single 'invalid_qr' result value — the scan_attempts.result check
  -- constraint (Task 4) and the design spec's color table have no 8th/9th
  -- distinct code for either case. resolveAdmissionDecision (Task 8) uses
  -- this exact same collapse, to keep the TS preview and this RPC's
  -- actual write in sync.
  if v_has_this_session then
    v_result := 'duplicate';
  elsif v_has_conflicting_session then
    v_result := 'timeslot_conflict';
  elsif v_session.status <> 'confirmed' then
    v_result := 'invalid_qr'; -- session not open for entry
  elsif v_session.late_entry_cutoff_minutes is not null
        and now() > (v_session.start_time + (v_session.late_entry_cutoff_minutes || ' minutes')::interval)
        and not p_is_override_caller then
    v_result := 'invalid_qr'; -- late-entry blocked; collapsed into invalid_qr, see note above
  elsif v_total_admitted >= v_session.capacity then
    v_result := 'full';
  else
    case v_session.admission_policy
      when 'restricted' then
        if exists(select 1 from allocation_assignments where application_id = p_application_id and session_id = p_session_id and status in ('proposed', 'confirmed')) then
          v_result := 'admitted'; v_entry_type := 'priority';
        else
          v_result := 'restricted_denied';
        end if;
      when 'plenary' then v_result := 'flexible_admitted'; v_entry_type := 'flexible';
      when 'open' then v_result := 'flexible_admitted'; v_entry_type := 'flexible';
      when 'cross_cutting' then v_result := 'flexible_admitted'; v_entry_type := 'flexible';
      when 'priority_then_open' then
        if exists(select 1 from allocation_assignments where application_id = p_application_id and session_id = p_session_id and status in ('proposed', 'confirmed')) then
          v_result := 'admitted'; v_entry_type := 'priority';
        else
          v_released := (
            v_session.flexible_entry_manual_override is true
            or (v_session.flexible_entry_manual_override is distinct from false and v_session.priority_release_at is not null and now() >= v_session.priority_release_at)
            or (v_session.flexible_entry_manual_override is distinct from false and v_session.priority_release_at is null and v_session.priority_release_minutes_before is not null
                and now() >= v_session.start_time - (v_session.priority_release_minutes_before || ' minutes')::interval)
          );
          v_flexible_pool := (v_session.capacity - v_effective_priority_pool)
                              + (case when v_released then greatest(0, v_effective_priority_pool - v_admitted_priority_count) else 0 end);
          if v_total_admitted < v_session.capacity and v_admitted_flexible_count < v_flexible_pool then
            v_result := 'flexible_admitted'; v_entry_type := 'flexible';
          else
            v_result := 'priority_hold';
          end if;
        end if;
    end case;
  end if;

  if p_is_override_caller and v_result in ('restricted_denied', 'full', 'priority_hold') then
    v_result := 'override_admitted'; v_entry_type := 'override';
  end if;

  if v_result in ('admitted', 'flexible_admitted', 'override_admitted') then
    insert into attendance_records (application_id, session_id, time_slot_group_key, entry_type, scanned_by, device_identifier)
    values (p_application_id, p_session_id, p_time_slot_group_key, v_entry_type, p_scanned_by, p_device_identifier)
    returning id into v_attendance_id;
  end if;

  insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, resulting_attendance_id)
  values (p_application_id, p_session_id, p_scanned_by, p_device_identifier, v_result, v_attendance_id)
  returning * into v_scan_attempt;

  return v_scan_attempt;
end;
$$ language plpgsql set search_path = public, pg_temp;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260804160000_scan_attempt_transactional_function')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260804170000_admission_management_functions.sql
-- ============================================================
-- admission_management_functions.sql
create or replace function correct_attendance_transactional(
  p_attendance_id uuid,
  p_corrected_by uuid,
  p_reason text
) returns attendance_records as $$
declare
  v_result attendance_records;
begin
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A correction reason is required';
  end if;

  update attendance_records
  set status = 'corrected', correction_reason = p_reason
  where id = p_attendance_id and status = 'admitted'
  returning * into v_result;

  if v_result.id is null then
    raise exception 'Attendance record % not found or not in admitted status', p_attendance_id;
  end if;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;

create or replace function transfer_attendance_transactional(
  p_attendance_id uuid,
  p_new_session_id uuid,
  p_new_time_slot_group_key text,
  p_transferred_by uuid,
  p_reason text
) returns attendance_records as $$
declare
  v_old attendance_records;
  v_new attendance_records;
begin
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A transfer reason is required';
  end if;

  select * into v_old from attendance_records where id = p_attendance_id and status = 'admitted';
  if v_old.id is null then
    raise exception 'Attendance record % not found or not in admitted status', p_attendance_id;
  end if;

  update attendance_records
  set status = 'transferred_out', correction_reason = p_reason
  where id = p_attendance_id;

  -- p_new_time_slot_group_key is computed by the caller via
  -- computeTimeSlotGroupKeyForSession (Task 9) for p_new_session_id,
  -- immediately before calling this RPC — never recomputed here, same
  -- rationale as scan_attempt_transactional (Task 11).
  -- entry_type is always 'override' for the transferred-in row, regardless
  -- of the original admission's entry_type (priority/flexible) — a transfer
  -- is a manual, exceptional intervention that doesn't re-derive priority or
  -- flexible eligibility for the destination session. This is deliberate,
  -- not a bug: the participant permanently vacates their original pool.
  insert into attendance_records (application_id, session_id, time_slot_group_key, status, entry_type, scanned_by, superseded_attendance_id, correction_reason)
  values (v_old.application_id, p_new_session_id, p_new_time_slot_group_key, 'admitted', 'override', p_transferred_by, v_old.id, p_reason)
  returning * into v_new;

  return v_new;
end;
$$ language plpgsql set search_path = public, pg_temp;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260804170000_admission_management_functions')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260804180000_add_priority_pool_exceeded_issue_type.sql
-- ============================================================
-- add_priority_pool_exceeded_issue_type.sql
--
-- allocation_issues.issue_type is a plain text column with a check
-- constraint named allocation_issues_type_valid (confirmed by reading
-- supabase/migrations/20260723100000_allocation_tables.sql directly, and by
-- grepping every later migration touching allocation_issues -- none of
-- 20260723110000_allocation_rls_policies.sql, 20260723190000_schedule_
-- publication_functions.sql, 20260726109600_rollback_safety_fixes.sql, or
-- 20260803120000_program_attendance_manager_rls.sql redefine this
-- constraint -- so the original 5-value list is still the live one), so
-- this is an ordinary constraint update, not an isolated-enum migration.
alter table allocation_issues drop constraint allocation_issues_type_valid;
alter table allocation_issues add constraint allocation_issues_type_valid
  check (issue_type in ('unassigned', 'low_confidence', 'capacity_bottleneck', 'schedule_conflict', 'no_eligible_sessions', 'priority_pool_exceeded'));


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260804180000_add_priority_pool_exceeded_issue_type')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260805100000_seed_official_tracks.sql
-- ============================================================
-- seed_official_tracks.sql
--
-- The tracks table has never had a seed-data migration; the only rows ever
-- present in it were disposable test fixtures (AUTHZ-TRACK, CONFIRM-PUB-
-- TRACK, TEST-TRACK), left untouched here since each owning test cleans up
-- its own row. This inserts the 4 official conference tracks with
-- deliberately fixed, stable UUIDs so downstream references (seed data,
-- fixtures, documentation) can cite a known id rather than a
-- query-time-generated one.
--
-- cross_cutting_track (this migration) is the code for Track 4, a real
-- agenda track. It is unrelated to and must not be confused with
-- sessions.admission_policy's 'cross_cutting' value (added in the
-- flexible-admission-qr-attendance work) — the two are independently
-- configurable: a session in Track 4 can have any admission_policy, and a
-- session with admission_policy='cross_cutting' can belong to any track.
insert into tracks (id, code, name_ar, name_en, is_active) values
  ('1effc2ca-9bd4-4cc5-94c5-be177195343b', 'adaptation_resilience_communities', 'المحور الأول: التكيف والمرونة وصمود المجتمعات', 'Track 1: Adaptation, Resilience, and Resilient Communities', true),
  ('a4b2c098-1351-4512-8d1e-dfedab0f255c', 'just_transition_green_economy_climate_innovation', 'المحور الثاني: التحول العادل والاقتصاد الأخضر والابتكار المناخي', 'Track 2: Just Transition, Green Economy, and Climate Innovation', true),
  ('472a5779-6dc5-47ef-8093-e414e2cfec49', 'climate_finance_governance_international_cooperation', 'المحور الثالث: تمويل المناخ والحوكمة والتعاون الدولي', 'Track 3: Climate Finance, Governance, and International Cooperation', true),
  ('bd80e41e-cbfb-47f3-9bac-14a24c5a125a', 'cross_cutting_track', 'المحور الرابع: المسار التقاطعي', 'Track 4: Cross-Cutting Track', true)
on conflict (id) do nothing;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260805100000_seed_official_tracks')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260805110000_widen_feature_extraction_source_field_constraint.sql
-- ============================================================
-- widen_feature_extraction_source_field_constraint.sql
--
-- feature_extraction_rules_source_field_valid was never widened when Phase B
-- added session_languages/track_1_focus_areas/track_2_focus_areas/
-- track_3_focus_areas/primary_track/secondary_track to
-- ExtractionRule['sourceField'] (src/lib/allocation/feature-extraction.ts) —
-- inserting a rule with any of those source_field values has been failing
-- live with a check-constraint violation ever since. This brings the
-- constraint in line with the TypeScript type it's meant to mirror.
alter table feature_extraction_rules drop constraint feature_extraction_rules_source_field_valid;
alter table feature_extraction_rules add constraint feature_extraction_rules_source_field_valid check (
  source_field in (
    'interests', 'track_interests', 'topics_to_learn', 'participation_goals', 'past_initiatives',
    'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas',
    'primary_track', 'secondary_track'
  )
);


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260805110000_widen_feature_extraction_source_field_constraint')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260805200000_diag_application_number_isolation.sql
-- ============================================================
-- diag_application_number_isolation.sql
--
-- DIAGNOSTIC ONLY, part of the P0 investigation into next_application_number()
-- returning duplicate values under concurrent RPC calls
-- (docs/superpowers/specs/2026-08-01-next-application-number-concurrency-bug.md).
--
-- This migration runs entirely INSIDE Postgres (no PostgREST, no pooler, no
-- network round-trip per call) to establish ground truth for Layers 1 and 2:
--   Layer 1: the raw sequence itself (nextval/currval/setval).
--   Layer 2: next_application_number() called directly, many times, in a
--            tight loop within a single backend/transaction.
-- Results are written to a temporary diagnostic table (diag_app_number_log)
-- rather than raised as notices, so they can be queried back afterward via
-- the normal Supabase client (which has no way to read a migration's raise
-- notice output). This table, and this migration file itself, are meant to
-- be dropped/deleted once the investigation concludes -- see the report doc.

create table if not exists diag_app_number_log (
  id bigserial primary key,
  layer text not null,
  call_index int not null,
  value text not null,
  captured_at timestamptz not null default clock_timestamp()
);

-- Record function properties BEFORE any test calls, so the diagnostic
-- captures the function's real, currently-live definition/volatility, not
-- an assumption.
create table if not exists diag_app_number_function_props (
  captured_at timestamptz not null default now(),
  proname text,
  provolatile char,       -- 'i' immutable, 's' stable, 'v' volatile
  proparallel char,       -- 's' safe, 'r' restricted, 'u' unsafe
  prosecdef boolean,       -- security definer?
  proconfig text[],        -- e.g. search_path settings, if any
  prosrc text,
  lang text
);

insert into diag_app_number_function_props (proname, provolatile, proparallel, prosecdef, proconfig, prosrc, lang)
select
  p.proname,
  p.provolatile,
  p.proparallel,
  p.prosecdef,
  p.proconfig,
  p.prosrc,
  l.lanname
from pg_proc p
join pg_language l on l.oid = p.prolang
where p.proname = 'next_application_number';

-- Sequence properties before any test calls.
create table if not exists diag_app_number_seq_props (
  captured_at timestamptz not null default now(),
  seqname text,
  last_value bigint,
  start_value bigint,
  increment_by bigint,
  is_called boolean
);

insert into diag_app_number_seq_props (seqname, last_value, start_value, increment_by, is_called)
select sequencename::text, last_value, start_value, increment_by, coalesce(last_value is not null, false)
from pg_sequences
where sequencename = 'application_number_seq';

------------------------------------------------------------------
-- Layer 1: the raw sequence directly. 20 tight-loop nextval() calls in a
-- single backend/transaction (this migration's own session) -- the
-- simplest possible ground truth. If Postgres's nextval() itself were
-- duplicating values, it would show up here with zero other layers
-- involved at all.
------------------------------------------------------------------
do $$
declare
  i int;
  v text;
begin
  for i in 1..20 loop
    v := nextval('application_number_seq')::text;
    insert into diag_app_number_log (layer, call_index, value) values ('layer1_raw_sequence_nextval', i, v);
  end loop;
end $$;

-- Also record currval() right after (same session, sequence already
-- touched by this session so currval() is valid) and a setval() probe that
-- restores the sequence to not lose numbers unnecessarily (setval to the
-- last value actually used, is_called=true, so the NEXT nextval() continues
-- from there rather than skipping or rewinding).
do $$
declare
  v_currval bigint;
begin
  v_currval := currval('application_number_seq');
  insert into diag_app_number_log (layer, call_index, value)
  values ('layer1_currval_after_loop', 0, v_currval::text);
end $$;

------------------------------------------------------------------
-- Layer 2: next_application_number() called directly, 20 times, tight
-- loop, same single backend/transaction. No RPC, no PostgREST, no pooler.
------------------------------------------------------------------
do $$
declare
  i int;
  v text;
begin
  for i in 1..20 loop
    v := next_application_number();
    insert into diag_app_number_log (layer, call_index, value) values ('layer2_function_direct', i, v);
  end loop;
end $$;

-- Sequence properties again after both loops, to see total advancement
-- (40 nextval() calls expected: 20 from layer 1 direct + 20 from layer 2
-- via the function).
insert into diag_app_number_seq_props (seqname, last_value, start_value, increment_by, is_called)
select 'application_number_seq_after_layers_1_2', last_value, start_value, increment_by, coalesce(last_value is not null, false)
from pg_sequences
where sequencename = 'application_number_seq';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260805200000_diag_application_number_isolation')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260805210000_diag_lpad_behavior.sql
-- ============================================================
-- diag_lpad_behavior.sql
-- DIAGNOSTIC ONLY, part of the P0 next_application_number() investigation.
-- Tests lpad()'s real truncation behavior directly, since layer 2's results
-- showed 6-digit sequence values appearing as 5-digit strings in the
-- function's output -- checking whether lpad(text, 5, '0') on an
-- already-6-character string truncates (Postgres docs say it does, from
-- the LEFT, when the target length is shorter than the input -- this
-- contradicts the assumption embedded in next_application_number()'s
-- original design/comment that lpad only pads).
insert into diag_app_number_log (layer, call_index, value)
values
  ('layer_lpad_probe', 1, lpad('165750', 5, '0')),
  ('layer_lpad_probe', 2, lpad('165759', 5, '0')),
  ('layer_lpad_probe', 3, lpad('99999', 5, '0')),
  ('layer_lpad_probe', 4, lpad('100000', 5, '0')),
  ('layer_lpad_probe', 5, lpad('1', 5, '0'));


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260805210000_diag_lpad_behavior')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260805220000_diag_raw_nextval_rpc.sql
-- ============================================================
-- diag_raw_nextval_rpc.sql
-- DIAGNOSTIC ONLY, part of the P0 next_application_number() investigation.
-- Exposes the raw, untruncated nextval() result via its own RPC, so
-- concurrent-call tests can compare the true underlying sequence integers
-- against next_application_number()'s truncated formatted output for the
-- SAME burst of calls -- proving whether the raw integers are unique under
-- real concurrency (they should be, per Postgres's nextval() guarantee),
-- isolated from the separate, already-proven lpad() truncation bug.
create or replace function diag_raw_nextval() returns bigint as $$
  select nextval('application_number_seq');
$$ language sql;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260805220000_diag_raw_nextval_rpc')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260805230000_fix_application_number_truncation.sql
-- ============================================================
-- fix_application_number_truncation.sql
--
-- Fixes the root cause identified in
-- docs/superpowers/specs/2026-08-01-application-number-isolation-report.md:
-- lpad(nextval(...)::text, 5, '0') silently TRUNCATES (not just pads) once
-- the sequence value exceeds 5 digits, which it now has via ordinary
-- cumulative usage -- collapsing every 10 consecutive sequence values into
-- one identical formatted string and causing the observed
-- applications_application_number_key unique-constraint failures. Proven
-- via 5-layer isolation to have zero connection to concurrency, PostgREST,
-- or connection pooling -- reproduces deterministically with a single
-- sequential call, no concurrency required.
--
-- Fix: evaluate nextval() exactly once via a CTE, then pad to a WIDTH
-- computed as GREATEST(5, length(the value)) instead of a fixed 5. This
-- preserves the existing minimum-5-digit zero-padded display format for
-- all values that fit (identical output to today, including the 42
-- existing historical application_number values, none of which this
-- migration touches), while a value that has genuinely grown past 5 digits
-- is padded to its own length (a no-op -- GREATEST(5, length(v)) equals
-- length(v) once length(v) > 5) rather than truncated to 5.
--
-- Kept as a single `language sql` function (unchanged from the original)
-- rather than converting to plpgsql: a `with` CTE binds nextval()'s result
-- once and every reference to it in the final select reads that same
-- bound value, so `nextval()` is still evaluated exactly once per call --
-- the same single-evaluation guarantee a plpgsql local variable would give,
-- achieved without a language change. `create or replace function` (not
-- drop+create) so existing GRANTs are preserved automatically -- Postgres
-- does not reset a function's ACL on CREATE OR REPLACE. Return type
-- (text), volatility (left unmarked, i.e. the same default VOLATILE the
-- original had -- correctly proven NOT the cause by the isolation report's
-- layer 3/4 concurrent-RPC results, which showed the raw sequence is
-- unique under real concurrency regardless of this function's volatility
-- marking), security mode (not security definer, unchanged), and the
-- absence of an explicit search_path (this function references only
-- application_number_seq, a single unqualified object with no ambiguity
-- risk -- unchanged from the original, not something the isolation report
-- found reason to add) are all preserved exactly as documented in the
-- isolation report's "Function definition and properties" section.
--
-- Does NOT reset, restart, or setval() the live sequence. Does NOT
-- renumber or backfill any existing applications.application_number value.
-- Does NOT touch the `unique` constraint on that column (still named
-- applications_application_number_key, retained exactly as-is).
create or replace function next_application_number() returns text as $$
  with generated as (
    select nextval('application_number_seq')::text as value
  )
  select 'RCOY-2026-' || lpad(value, greatest(5, length(value)), '0')
  from generated;
$$ language sql;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260805230000_fix_application_number_truncation')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260805235959_phase6_qr_issuance_reissue.sql
-- ============================================================
-- Phase 6 — Secure Participant QR Issuance: schema + issuance/reissue RPCs
-- Mechanically extracted from docs/superpowers/specs/_phase6-qr-rpc-reference-draft.md
-- Only sections explicitly marked APPROVED (or confirmed approved via surrounding prose
-- / function-name cross-check) are included. SUPERSEDED sections are excluded entirely.
-- Scope: §1 (schema), §2.1 (qr_credentials privilege revocation), §5.0a (fingerprint
-- helper), §5.1 (issuance), §5.2 (reissue). §5.3 onward (revocation, scanning,
-- admission-decision, badge generation) is explicitly out of scope for this migration.

-- Hard prerequisite for the fingerprint helper's digest() call (§1 preamble).
create extension if not exists pgcrypto with schema extensions;

-- ============================================================================
-- §1.2  qr_credentials — full final constraint set
-- ============================================================================
create table public.qr_credentials (
  id                        uuid primary key default gen_random_uuid(),
  application_id            uuid not null references public.applications(id) on delete restrict,

  token_version             smallint not null default 1 check (token_version between 1 and 32767),
  token_hash                bytea not null check (octet_length(token_hash) = 32),
  token_ciphertext          bytea,
  encryption_key_version    smallint check (encryption_key_version between 1 and 32767),

  status                    text not null check (status in ('active','revoked','replaced')),
  issuance_channel          text not null check (issuance_channel in
                               ('participant_self_service','staff_individual','staff_bulk','system')),

  issued_at                 timestamptz not null default now(),
  issued_by                 uuid references public.profiles(id) on delete set null,
  issuance_reason_code      text,
  issuance_note             text check (char_length(issuance_note) <= 500),

  revoked_at                timestamptz,
  revoked_by                uuid references public.profiles(id) on delete set null,
  revocation_reason_code    text,
  revocation_note           text check (char_length(revocation_note) <= 500),

  replaced_at               timestamptz,
  replaced_by               uuid references public.profiles(id) on delete set null,
  replaced_by_credential_id uuid,
  reissue_channel           text check (reissue_channel in
                               ('participant_self_service','staff_individual','staff_bulk','system')),
  reissue_reason_code       text,
  reissue_note              text check (char_length(reissue_note) <= 500),

  created_at                timestamptz not null default now(),

  constraint qr_credentials_token_hash_unique unique (token_hash),
  constraint qr_credentials_no_self_replacement check (id is distinct from replaced_by_credential_id),

  -- Required so qr_credentials_replacement_same_application_fkey below can
  -- reference (id, application_id) as a composite FK target — id alone is
  -- already the primary key, but Postgres requires the EXACT column pair a
  -- composite FK references to be covered by its own unique constraint/
  -- index, not merely implied by a unique constraint on a subset of it.
  -- This is a unique constraint on a superset of the primary key
  -- (id is already unique on its own), which is standard practice for this
  -- "FK must agree with a sibling column" pattern and adds no new
  -- uniqueness requirement beyond what the primary key already guarantees.
  constraint qr_credentials_id_application_unique unique (id, application_id),

  -- CORRECTED this round: replaced_by_credential_id was previously a plain
  -- single-column FK against qr_credentials(id), which enforced only "this
  -- id exists somewhere in the table" — it never required the replacement
  -- target to belong to the SAME application as the row being replaced. A
  -- direct service_role write (or a bug in a future RPC) could otherwise
  -- record a credential from a completely different application as the
  -- "replacement" for this one, corrupting the reissue lineage. Enforced
  -- now as a genuine database invariant via a deferred COMPOSITE FK against
  -- (id, application_id) instead of a single-column FK against id alone —
  -- requires qr_credentials_id_application_unique above, a unique
  -- constraint on that exact pair (a unique constraint on a superset of
  -- the primary key is standard practice for this "FK must agree with a
  -- sibling column" pattern; id alone already being the primary key does
  -- not by itself let Postgres reference (id, application_id) as a
  -- composite FK target).
  -- deferrable initially deferred for the same reason the previous
  -- single-column FK was: the old row must leave 'active' status before
  -- the new row becomes active (satisfying qr_credentials_one_active_per_application),
  -- while the FK requires the new row to already exist before the old
  -- row's update references it — deferring to commit resolves the
  -- opposing ordering requirement exactly as before.
  constraint qr_credentials_replacement_same_application_fkey
    foreign key (replaced_by_credential_id, application_id)
    references public.qr_credentials (id, application_id)
    on delete restrict
    deferrable initially deferred,

  -- issued_by/replaced_by are required only at creation time for staff
  -- channels, enforced transactionally in the RPC, not as a durable
  -- row-shape check (a durable NOT NULL would conflict with ON DELETE SET
  -- NULL once a staff profile is deleted). The only durable channel/actor
  -- rule the database itself enforces forever — restored this round after
  -- the finalizers were found unconditionally writing
  -- v_op.requested_by_profile_id into issued_by/replaced_by regardless of
  -- channel, which populated a "staff actor" on a participant_self_service
  -- row (requested_by_profile_id is auth.uid() itself for the participant
  -- reservation RPCs, never null):
  constraint qr_credentials_self_service_has_no_actor check (
    issuance_channel <> 'participant_self_service' or issued_by is null
  ),
  constraint qr_credentials_self_service_reissue_has_no_actor check (
    reissue_channel is distinct from 'participant_self_service' or replaced_by is null
  ),

  constraint qr_credentials_active_is_consistent check (
    status <> 'active' or (
      token_ciphertext is not null and encryption_key_version is not null
      and revoked_at is null and revoked_by is null and revocation_reason_code is null and revocation_note is null
      and replaced_at is null and replaced_by is null and replaced_by_credential_id is null
      and reissue_channel is null and reissue_reason_code is null and reissue_note is null
    )
  ),
  constraint qr_credentials_revoked_is_consistent check (
    status <> 'revoked' or (
      revoked_at is not null and revocation_reason_code is not null
      and token_ciphertext is null and encryption_key_version is null
      and replaced_at is null and replaced_by is null and replaced_by_credential_id is null
      and reissue_channel is null and reissue_reason_code is null and reissue_note is null
    )
  ),
  constraint qr_credentials_replaced_is_consistent check (
    status <> 'replaced' or (
      replaced_at is not null and replaced_by_credential_id is not null
      and reissue_channel is not null and reissue_reason_code is not null
      and token_ciphertext is null and encryption_key_version is null
      and revoked_at is null and revoked_by is null and revocation_reason_code is null and revocation_note is null
    )
  )
);

create unique index qr_credentials_one_active_per_application
  on public.qr_credentials (application_id) where status = 'active';

create unique index qr_credentials_replacement_target_unique
  on public.qr_credentials (replaced_by_credential_id) where replaced_by_credential_id is not null;

create index qr_credentials_application_idx on public.qr_credentials (application_id);

-- No RLS policies of any kind are added for any client role. Default-deny.

-- ============================================================================
-- §1.3  scan_attempts — additive columns, backfill, and result values
-- ============================================================================
alter table scan_attempts add column finalized_at timestamptz;
alter table scan_attempts add column expires_at timestamptz;

update scan_attempts set finalized_at = created_at where finalized_at is null;

alter table scan_attempts drop constraint scan_attempts_result_check;
alter table scan_attempts add constraint scan_attempts_result_check check (result in (
  -- existing values, UNCHANGED (verified above), still used for their current pre-QR meanings:
  'admitted', 'flexible_admitted', 'priority_hold', 'full',
  'restricted_denied', 'duplicate', 'timeslot_conflict', 'invalid_qr', 'override_admitted',
  -- new, additive, QR-specific:
  'token_malformed', 'token_unknown', 'token_revoked', 'token_replaced', 'token_ineligible',
  'token_valid_pending_confirmation', 'expired_pending', 'cancelled_by_operator'
));

alter table scan_attempts add constraint scan_attempts_finalization_state_check check (
  (
    result = 'token_valid_pending_confirmation'
    and finalized_at is null
    and expires_at is not null
    and expires_at > created_at
  )
  or
  (
    result <> 'token_valid_pending_confirmation'
    and finalized_at is not null
    and expires_at is null
  )
);

create index scan_attempts_pending_expiry_idx on scan_attempts (expires_at)
  where result = 'token_valid_pending_confirmation' and finalized_at is null;

-- ============================================================================
-- §1.4  Reason-code vocabularies
-- ============================================================================
alter table qr_credentials add constraint qr_credentials_issuance_reason_code_valid check (
  issuance_reason_code is null or issuance_reason_code in (
    'advance_badge_printing', 'participant_not_logged_in', 'bulk_event_preparation', 'staff_other',
    -- Added per this round's correction: the SYSTEM-INTERNAL code
    -- automatically applied to a replacement credential's OWN
    -- issuance_reason_code when reissue_qr_credential_transactional
    -- creates it (§5.2) — distinct from a fresh, ground-up issuance.
    -- Never supplied directly by any RPC caller as an input value; only
    -- ever written by reissue_qr_credential_transactional itself. The
    -- detailed cause of the reissue lives on the OLD (now-replaced)
    -- credential's reissue_reason_code/reissue_note, not here.
    'reissued_credential'
  )
);
alter table qr_credentials add constraint qr_credentials_revocation_reason_code_valid check (
  revocation_reason_code is null or revocation_reason_code in (
    'suspected_compromise', 'participant_request', 'administrative_correction', 'staff_other'
  )
);
alter table qr_credentials add constraint qr_credentials_reissue_reason_code_valid check (
  reissue_reason_code is null or reissue_reason_code in (
    -- Participant self-service — the full approved six-option vocabulary:
    'lost_or_stolen_phone', 'screenshot_shared', 'printed_copy_lost',
    'qr_display_issue', 'security_concern', 'participant_other',
    -- Staff force-reissue — separate, staff-scoped codes:
    'staff_assisted_recovery', 'suspected_compromise', 'administrative_correction', 'staff_other'
  )
);

-- ============================================================================
-- §1.5  Defensive lifecycle/immutability trigger — qr_credentials
-- ============================================================================
-- CORRECTED this round: the previous actor-column guard rejected the
-- LEGITIMATE first assignment of revoked_by/replaced_by. Both columns
-- are null on an active row by construction (§1.2's
-- qr_credentials_active_is_consistent constraint), so on the one legal
-- active -> revoked/replaced transition, old.revoked_by/old.replaced_by
-- IS null and new.revoked_by/new.replaced_by IS the (possibly non-null)
-- staff profile being recorded — exactly the case the previous guard's
-- "new.x is not null and new.x is distinct from old.x" condition matched
-- and rejected. The corrected rule scopes each actor column's "may be set
-- to a non-null value" window to the exact transition where it is
-- legitimately allowed to change, and forbids it everywhere else:
--   issued_by: settable only at INSERT (guarded in the INSERT branch
--     below), immutable non-null-to-different-non-null or null-to-non-null
--     on every subsequent UPDATE; may transition to null via ON DELETE SET
--     NULL at any time.
--   revoked_by: may transition null -> (null | staff profile) ONLY in the
--     same UPDATE that also performs old.status = 'active' -> new.status =
--     'revoked'; immutable thereafter except non-null -> null via ON
--     DELETE SET NULL.
--   replaced_by: identical shape, keyed on the active -> replaced
--     transition instead.
create function public.qr_credentials_enforce_lifecycle_trigger() returns trigger
language plpgsql as $$
declare
  v_actor_role text;
begin
  if tg_op = 'DELETE' then
    raise exception 'qr_credentials rows are never deleted, only transitioned';
  end if;

  -- INSERT guard: a newly inserted credential must always begin in the one
  -- legal "freshly issued" shape — never a pre-revoked or pre-replaced row,
  -- even via a direct service-role insert that bypasses the finalizer RPCs
  -- entirely. The finalizers themselves already only ever insert 'active'
  -- rows; this is the second, independent, table-level enforcement layer.
  if tg_op = 'INSERT' then
    if new.status <> 'active' then
      raise exception 'A newly inserted qr_credentials row must have status = active';
    end if;
    if new.revoked_at is not null or new.revoked_by is not null
       or new.revocation_reason_code is not null or new.revocation_note is not null
    then
      raise exception 'A newly inserted qr_credentials row must have all revocation fields null';
    end if;
    if new.replaced_at is not null or new.replaced_by is not null
       or new.replaced_by_credential_id is not null or new.reissue_channel is not null
       or new.reissue_reason_code is not null or new.reissue_note is not null
    then
      raise exception 'A newly inserted qr_credentials row must have all replacement fields null';
    end if;
    if new.token_ciphertext is null or new.encryption_key_version is null then
      raise exception 'A newly inserted qr_credentials row must have non-null ciphertext and encryption_key_version';
    end if;

    -- Correction 3: created_at and issued_at are two independently
    -- defaulted now() reads (§1.2) and must agree exactly on a freshly
    -- inserted row — no legitimate insert path produces a credential
    -- "issued" at a different instant than it was "created."
    if new.created_at is distinct from new.issued_at then
      raise exception 'created_at must equal issued_at on insert';
    end if;

    -- Correction 4: re-validate the ciphertext envelope shape and version
    -- byte at the table level. §5.1/§5.2's finalizers already check this
    -- (octet_length = 61, version byte = 1) before ever calling INSERT, but
    -- this trigger's whole purpose (per the prose above) is to defend even
    -- against a bug in those RPCs or a direct service-role bypass — so the
    -- same check is restated here, independently.
    if octet_length(new.token_ciphertext) <> 61 then
      raise exception 'Invalid or malformed ciphertext envelope';
    end if;
    if get_byte(new.token_ciphertext, 0) <> 1 then
      raise exception 'Unsupported ciphertext envelope version';
    end if;

    -- Correction 5: the referenced key version must currently be active.
    -- The finalizer re-checks this under FOR SHARE (§5.1 step 7) before its
    -- own INSERT, but a direct service-role insert bypassing the finalizer
    -- had no equivalent defense — it could otherwise silently activate a
    -- credential against a decrypt_only/retired key version.
    if not public.is_encryption_key_version_active(new.encryption_key_version) then
      raise exception 'encryption_key_version must be an active key version';
    end if;

    -- Correction 1: actor semantics corrected for all four channels.
    -- participant_self_service and system both carry no staff actor;
    -- staff_individual and staff_bulk both require one. The table CHECK
    -- constraints (qr_credentials_self_service_has_no_actor /
    -- _reissue_has_no_actor) already enforce the participant_self_service
    -- half of this structurally; the trigger enforces the full four-way
    -- split, including the system channel the previous draft mis-grouped
    -- with the staff channels.
    if new.issuance_channel in ('participant_self_service', 'system') then
      if new.issued_by is not null then
        raise exception '% channel rows must have issued_by null', new.issuance_channel;
      end if;
    else
      if new.issued_by is null then
        raise exception '% channel rows must have a non-null issued_by', new.issuance_channel;
      end if;
      -- Correction 2: authorized-role validation, previously a documented
      -- punt. A staff actor must actually hold an authorized staff role at
      -- the moment of insert — the same super_admin/program_attendance_manager
      -- set used throughout §4's authorization matrix and §1.6a's bulk-batch
      -- checks — not merely be some arbitrary profiles.id.
      select role into v_actor_role from public.profiles where id = new.issued_by;
      if v_actor_role is null or v_actor_role not in ('super_admin', 'program_attendance_manager') then
        raise exception 'issued_by must reference a profile with an authorized staff role';
      end if;
    end if;

    return new;
  end if;

  -- Immutable regardless of status transition, forever, no exceptions:
  if new.id is distinct from old.id then
    raise exception 'id is immutable';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'created_at is immutable';
  end if;
  if new.application_id is distinct from old.application_id then
    raise exception 'application_id is immutable';
  end if;
  if new.token_hash is distinct from old.token_hash then
    raise exception 'token_hash is immutable';
  end if;
  if new.token_version is distinct from old.token_version then
    raise exception 'token_version is immutable';
  end if;
  if new.issuance_channel is distinct from old.issuance_channel then
    raise exception 'issuance_channel is immutable';
  end if;
  if new.issued_at is distinct from old.issued_at then
    raise exception 'issued_at is immutable';
  end if;
  if new.issuance_reason_code is distinct from old.issuance_reason_code then
    raise exception 'issuance_reason_code is immutable';
  end if;
  if new.issuance_note is distinct from old.issuance_note then
    raise exception 'issuance_note is immutable';
  end if;

  -- issued_by: set only at INSERT (guarded above); on every UPDATE it may
  -- only transition non-null -> null (ON DELETE SET NULL). It is never
  -- legitimately set to a non-null value by any UPDATE, since it is
  -- always already populated (or intentionally null) at INSERT time.
  if new.issued_by is distinct from old.issued_by and new.issued_by is not null then
    raise exception 'issued_by can never be (re)assigned by update, only set at insert or cleared to null';
  end if;

  -- Status transition whitelist: only active -> revoked and active -> replaced.
  if old.status is distinct from new.status then
    if old.status <> 'active' or new.status not in ('revoked', 'replaced') then
      raise exception 'Illegal status transition: % -> %', old.status, new.status;
    end if;
  end if;

  -- revoked_by: the ONLY transition permitted to move it from null to a
  -- (possibly non-null) value is the active -> revoked transition itself.
  -- Every other UPDATE may only move it non-null -> null (ON DELETE SET
  -- NULL) or leave it unchanged. Correction 2: when it IS legally assigned
  -- a non-null value here, that value must name an authorized staff role —
  -- the same re-verification applied to issued_by at INSERT.
  if old.status = 'active' and new.status = 'revoked' then
    -- legal window: revoked_by may become non-null here.
    if new.revoked_by is not null then
      select role into v_actor_role from public.profiles where id = new.revoked_by;
      if v_actor_role is null or v_actor_role not in ('super_admin', 'program_attendance_manager') then
        raise exception 'revoked_by must reference a profile with an authorized staff role';
      end if;
    end if;
  else
    if new.revoked_by is distinct from old.revoked_by and new.revoked_by is not null then
      raise exception 'revoked_by can only be assigned during the active -> revoked transition, or cleared to null';
    end if;
  end if;

  -- replaced_by: identical shape, keyed on active -> replaced. Gated on
  -- reissue_channel exactly as issued_by is gated on issuance_channel at
  -- INSERT (correction 1): qr_credentials_self_service_reissue_has_no_actor
  -- only covers reissue_channel = 'participant_self_service' — it does NOT
  -- cover 'system', which shares the same "no staff actor" semantics but is
  -- not itself excluded by that CHECK constraint's text. The trigger closes
  -- that gap explicitly rather than relying on the incomplete CHECK.
  if old.status = 'active' and new.status = 'replaced' then
    if new.reissue_channel in ('participant_self_service', 'system') then
      if new.replaced_by is not null then
        raise exception '% reissue_channel rows must have replaced_by null', new.reissue_channel;
      end if;
    else
      if new.replaced_by is null then
        raise exception '% reissue_channel rows must have a non-null replaced_by', new.reissue_channel;
      end if;
      select role into v_actor_role from public.profiles where id = new.replaced_by;
      if v_actor_role is null or v_actor_role not in ('super_admin', 'program_attendance_manager') then
        raise exception 'replaced_by must reference a profile with an authorized staff role';
      end if;
    end if;
  else
    if new.replaced_by is distinct from old.replaced_by and new.replaced_by is not null then
      raise exception 'replaced_by can only be assigned during the active -> replaced transition, or cleared to null';
    end if;
  end if;

  -- Terminal statuses (revoked/replaced) are write-once for their own
  -- lifecycle-ending metadata: once set on a specific row transition, those
  -- fields cannot be rewritten again on a later update to the same row —
  -- EXCEPT revoked_by/replaced_by, which are separately permitted (above)
  -- to transition to null via ON DELETE SET NULL even on an
  -- already-terminal row; this block only guards the NON-actor fields of
  -- each terminal shape.
  if old.status = 'revoked' and new.status = 'revoked' then
    if new.revoked_at is distinct from old.revoked_at
       or new.revocation_reason_code is distinct from old.revocation_reason_code
       or new.revocation_note is distinct from old.revocation_note then
      raise exception 'revocation metadata is immutable once set';
    end if;
  end if;
  if old.status = 'replaced' and new.status = 'replaced' then
    if new.replaced_at is distinct from old.replaced_at
       or new.replaced_by_credential_id is distinct from old.replaced_by_credential_id
       or new.reissue_channel is distinct from old.reissue_channel
       or new.reissue_reason_code is distinct from old.reissue_reason_code
       or new.reissue_note is distinct from old.reissue_note then
      raise exception 'replacement metadata is immutable once set';
    end if;
  end if;

  -- Cryptographic material: explicit rules per requirement, not merely
  -- "ciphertext can only go non-null -> null."
  if old.status = 'active' and new.status = 'active' then
    -- While a credential remains active, both fields must be BYTE-FOR-BYTE
    -- unchanged — not merely "still non-null."
    if new.token_ciphertext is distinct from old.token_ciphertext then
      raise exception 'token_ciphertext must not change while a credential remains active';
    end if;
    if new.encryption_key_version is distinct from old.encryption_key_version then
      raise exception 'encryption_key_version must not change while a credential remains active';
    end if;
  end if;
  if old.status = 'active' and new.status in ('revoked', 'replaced') then
    -- The one legal transition: both fields MUST go from non-null to null,
    -- together, in this exact transition — not independently, not partially.
    if new.token_ciphertext is not null or new.encryption_key_version is not null then
      raise exception 'token_ciphertext and encryption_key_version must both be cleared to null during active -> % transition', new.status;
    end if;
  end if;
  if old.status in ('revoked', 'replaced') then
    -- Terminal credentials must never regain either value, regardless of
    -- what new.status is being set to (which the whitelist above has
    -- already restricted to "unchanged," but this is stated independently
    -- as its own defense-in-depth rule per the requirement).
    if new.token_ciphertext is not null or new.encryption_key_version is not null then
      raise exception 'a terminal (revoked/replaced) credential can never regain ciphertext or a key version';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.qr_credentials_enforce_lifecycle_trigger() from public;

create trigger qr_credentials_lifecycle_guard
  before insert or update or delete on public.qr_credentials
  for each row execute function public.qr_credentials_enforce_lifecycle_trigger();

-- ============================================================================
-- §1.6  Encryption-key-version registry
-- ============================================================================
create table public.qr_encryption_key_registry (
  id             uuid primary key default gen_random_uuid(),  -- audit_logs.entity_id target (verified uuid not null)
  key_version    smallint not null unique check (key_version between 1 and 32767),
  status         text not null check (status in ('active', 'decrypt_only', 'retired')),
  activated_at   timestamptz not null default now(),
  retired_at     timestamptz,
  constraint qr_encryption_key_registry_active_has_no_retired_at check (
    status = 'retired' or retired_at is null
  ),
  constraint qr_encryption_key_registry_retired_requires_retired_at check (
    status <> 'retired' or retired_at is not null
  )
);

-- Point 3: at most one ACTIVE key version, ever, enforced structurally —
-- not merely by application-level discipline. Postgres has no direct
-- "unique where status='active'" syntax for a single-row singleton without
-- a natural key to index; the standard idiom is to index a constant
-- expression, so every 'active' row collides on the same index value.
create unique index qr_encryption_key_registry_one_active_idx
  on public.qr_encryption_key_registry ((true)) where status = 'active';

insert into public.qr_encryption_key_registry (key_version, status) values (1, 'active');

alter table public.qr_encryption_key_registry enable row level security;
revoke select, insert, update, delete, truncate, references, trigger
  on public.qr_encryption_key_registry from anon, authenticated;

-- CORRECTED this round: is_encryption_key_version_active was previously a
-- plain LANGUAGE SQL ... STABLE function performing an unlocked read. The
-- finalizers' own key-registry check (§5.1/§5.2 step 7) takes the row
-- FOR SHARE before re-checking status = 'active', which correctly excludes
-- a rotation from racing a finalizer that has already committed to a key
-- version — but that protection lives entirely inside the finalizer RPCs.
-- A direct service_role INSERT that bypasses both finalizers (exactly the
-- path qr_credentials_enforce_lifecycle_trigger() exists to defend, per
-- §1.5's own stated purpose) only ever went through this STABLE function,
-- which took no lock at all — an unlocked read here could observe
-- status = 'active' a moment before a concurrent rotation flips it to
-- decrypt_only, let the INSERT through, and never be caught by anything,
-- since the trigger's own check was the last line of defense and it
-- wasn't actually locking anything. Rewritten as LANGUAGE PLPGSQL
-- (STABLE removed — a function that takes a row lock has side effects on
-- lock state and must not be marked STABLE) that takes the SAME FOR SHARE
-- lock the finalizers already take, so the trigger's check has the
-- identical race-safety guarantee as the finalizers' own, regardless of
-- which code path reaches the INSERT.
-- CORRECTED this round: `return v_status = 'active';` returns NULL, not
-- false, when p_key_version matches no row at all (v_status stays NULL,
-- and `NULL = 'active'` is NULL under three-valued logic, not false). The
-- trigger calls this as `if not public.is_encryption_key_version_active(...)
-- then raise exception ... end if;` — `not NULL` is also NULL, and an
-- `if NULL then` branch is never entered, so an UNKNOWN key version
-- (one with no registry row at all, not merely a non-active one) silently
-- skipped the trigger's own controlled rejection entirely, falling through
-- to whatever unrelated error (or none) the rest of the INSERT produced.
-- Wrapping in coalesce(..., false) makes the function total: it returns a
-- definite boolean for every possible input, including an unregistered
-- key version, matching the trigger's `if not ...` contract exactly.
-- Reformatted this round into canonical CREATE FUNCTION option order
-- (LANGUAGE, then volatility, then SECURITY DEFINER, then SET) to avoid
-- any parser ambiguity and make the intended VOLATILE explicit rather
-- than merely implied by its absence from the STABLE/IMMUTABLE keywords.
create function public.is_encryption_key_version_active(
  p_key_version smallint
) returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  select status
  into v_status
  from public.qr_encryption_key_registry
  where key_version = p_key_version
  for share;

  return coalesce(v_status = 'active', false);
end;
$$;

create function public.is_encryption_key_version_decryptable(p_key_version smallint) returns boolean
language sql security definer set search_path = public, pg_temp stable as $$
  select coalesce(
    (select status in ('active', 'decrypt_only') from public.qr_encryption_key_registry where key_version = p_key_version),
    false
  );
$$;

revoke all on function public.is_encryption_key_version_active(smallint) from public, anon, authenticated;
revoke all on function public.is_encryption_key_version_decryptable(smallint) from public;
-- is_encryption_key_version_active is called from
-- qr_credentials_enforce_lifecycle_trigger() (§1.5), which is NOT security
-- definer and therefore runs as invoker — i.e. as whichever role actually
-- performs the raw DML against qr_credentials (service_role for every
-- finalizer in this document, since they are security definer functions
-- owned by a privileged role, and potentially service_role directly for a
-- raw bypass insert/update). Grant to BOTH service_role (the invoking role
-- for every real write path) and — implicitly, as the function owner —
-- whichever role owns this function in the deployed schema (typically
-- `postgres` under Supabase's default migration-apply role), since a
-- SECURITY DEFINER function's body executes with the OWNER's privileges
-- for its own internal reads/locks regardless of who calls it; the
-- EXECUTE grant below controls who may call it at all, not what privilege
-- level its body runs under once called. Without the service_role grant,
-- revoke all above leaves service_role with no path to EXECUTE this
-- function, and the trigger would fail with a permission error instead of
-- performing its intended race-safe active-key-version check.
grant execute on function public.is_encryption_key_version_active(smallint) to service_role;

-- Concurrency behavior of the FOR SHARE lock inside
-- is_encryption_key_version_active, documented explicitly since this same
-- lock is now taken from two independent call sites (the finalizers'
-- inline check, and this trigger-facing helper) against the same row:
--
-- 1. An INSERT into qr_credentials (via a finalizer, or a direct
--    service_role bypass) that reaches this function's FOR SHARE first
--    acquires a shared lock on the key-registry row. A concurrent
--    rotate_encryption_key_version_for_server call, which takes that same
--    row FOR UPDATE (§1.6, "lock the current active key row FIRST"), must
--    wait for every shared lock to release — so the INSERT's own
--    transaction is free to finish (commit or abort) without the rotation
--    ever observing an inconsistent status mid-check.
-- 2. Symmetrically, if rotation's FOR UPDATE is acquired first, a
--    concurrent INSERT's FOR SHARE here waits for the rotation's
--    transaction to finish. If the rotation commits before the INSERT's
--    lock is granted, the INSERT observes the ALREADY-ROTATED status
--    (decrypt_only) once it finally acquires its shared lock — and is
--    correctly rejected, exactly the scenario this correction exists to
--    close for a direct-bypass INSERT.
-- 3. After a rotation transaction commits, every subsequent INSERT
--    referencing the now-decrypt_only key version is rejected by this
--    function's own status = 'active' check — there is no window after
--    commit where a stale in-memory read could let one through, since
--    each call re-reads the row fresh under its own lock.
-- 4. The trigger and a finalizer may safely both acquire FOR SHARE on the
--    same key-registry row within the SAME transaction (e.g. a finalizer
--    takes its own FOR SHARE at step 7, then its INSERT fires this
--    trigger, which takes FOR SHARE again on the identical row) — FOR
--    SHARE locks are non-exclusive with respect to OTHER FOR SHARE
--    holders, including a second acquisition by the SAME transaction, so
--    this never self-deadlocks or blocks.

-- Point 9 (previous round) + Point 3 (this round): full defensive trigger.
-- CORRECTED per this round: the previous version returned immediately on
-- old.status = new.status, which meant retired_at (or any other column)
-- could be silently rewritten on an already-retired row, since only the
-- table CHECK constraint (retired_at is not null while retired) was
-- guarding it — that constraint permits retired_at to change to a
-- DIFFERENT non-null value, which is wrong. The trigger now separately
-- validates lifecycle-timestamp immutability even on a same-state update.
create function public.qr_encryption_key_registry_enforce_lifecycle_trigger() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'qr_encryption_key_registry rows are never deleted, only transitioned';
  end if;

  -- INSERT guard (this round's addition): a newly inserted key version
  -- must always begin 'active' with retired_at null — direct insertion of
  -- a decrypt_only or retired row is rejected. Only the rotation
  -- (active -> decrypt_only, via a subsequent UPDATE) and retirement
  -- (decrypt_only -> retired) transitions may ever produce those
  -- statuses; a row can never be BORN into either. The migration seed
  -- (`insert into public.qr_encryption_key_registry (key_version, status)
  -- values (1, 'active')`) satisfies this by construction.
  if tg_op = 'INSERT' then
    if new.status <> 'active' then
      raise exception 'A newly inserted qr_encryption_key_registry row must have status = active';
    end if;
    if new.retired_at is not null then
      raise exception 'A newly inserted qr_encryption_key_registry row must have retired_at null';
    end if;
    return new; -- the table's own qr_encryption_key_registry_one_active_idx
                -- independently enforces the singleton-active invariant on
                -- this INSERT — no additional check needed here.
  end if;

  if new.id is distinct from old.id then raise exception 'id is immutable'; end if;
  if new.key_version is distinct from old.key_version then raise exception 'key_version is immutable'; end if;
  if new.activated_at is distinct from old.activated_at then raise exception 'activated_at is immutable'; end if;

  -- Corrected this round: the previous version keyed the "retired_at must
  -- be null" check off OLD.status, which made the one legal
  -- decrypt_only -> retired transition impossible (old.status was still
  -- 'decrypt_only' at evaluation time, even though new.status was
  -- 'retired' and new.retired_at was correctly non-null). retired_at
  -- rules must key off NEW.status instead:
  if new.status in ('active', 'decrypt_only') and new.retired_at is not null then
    raise exception 'retired_at must remain null while status is active or decrypt_only';
  end if;
  if old.status = 'decrypt_only' and new.status = 'retired' then
    if old.retired_at is not null or new.retired_at is null then
      raise exception 'retired_at must transition from null to a non-null value exactly when decrypt_only -> retired';
    end if;
  end if;
  if old.status = 'retired' and new.retired_at is distinct from old.retired_at then
    raise exception 'retired_at is immutable once a key version is retired';
  end if;

  if old.status = new.status then
    -- Same-state request: status itself didn't change, but the blocks
    -- above already caught any illegal retired_at rewrite. No OTHER
    -- lifecycle field is allowed to change here either — this table has
    -- no additional mutable fields beyond status/retired_at, so reaching
    -- this point with old.status = new.status and a legal retired_at
    -- means nothing of consequence changed; permit it.
    return new;
  end if;

  if old.status = 'active' and new.status = 'decrypt_only' then
    -- legal; retired_at already verified null above via the new.status check
  elsif old.status = 'decrypt_only' and new.status = 'retired' then
    -- legal; retired_at's null -> non-null transition already verified above
  else
    raise exception 'Illegal key version status transition: % -> %', old.status, new.status;
  end if;

  return new;
end;
$$;

revoke all on function public.qr_encryption_key_registry_enforce_lifecycle_trigger() from public;

create trigger qr_encryption_key_registry_lifecycle_guard
  before insert or update or delete on public.qr_encryption_key_registry
  for each row execute function public.qr_encryption_key_registry_enforce_lifecycle_trigger();

-- Point 1/2 (this round): serialized via a fixed advisory transaction
-- lock, idempotent, machine-readable result, and the audit_logs insert
-- column/value ordering FIXED (see the malformed statement identified
-- this round). Registering/activating a NEW key version is
-- service-role-only, called from trusted Node code only AFTER it has
-- independently verified the corresponding external key material exists,
-- decodes, and is exactly 32 bytes — this function trusts that
-- verification already happened; it never receives the key material or
-- any secret-variable name itself, only the version NUMBER.
create function public.rotate_encryption_key_version_for_server(
  p_new_key_version smallint
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_current public.qr_encryption_key_registry;
  v_existing_new public.qr_encryption_key_registry;
  v_now timestamptz;
begin
  if p_new_key_version is null or p_new_key_version not between 1 and 32767 then
    raise exception 'Invalid key version';
  end if;

  -- Point 2: fixed, well-known advisory lock — not derived from any row
  -- data — held for the transaction's duration, serializing ALL concurrent
  -- rotation attempts against EACH OTHER before either one so much as
  -- reads a row. This is deliberately a coarser mechanism than the
  -- finalizers' per-row FOR SHARE (rotation is rare and exclusive by
  -- nature; unlike finalization, there is no benefit to letting two
  -- rotations proceed concurrently).
  perform pg_advisory_xact_lock(hashtext('qr_encryption_key_rotation'));

  -- Idempotency: has this exact version already been registered?
  select * into v_existing_new from public.qr_encryption_key_registry where key_version = p_new_key_version;
  if v_existing_new.id is not null then
    if v_existing_new.status = 'active' then
      return 'already_rotated'; -- safe replay: this rotation already committed, no new audit rows
    end if;
    raise exception 'Key version % already exists with status %, cannot be reused for a new rotation', p_new_key_version, v_existing_new.status;
  end if;

  -- Lock the current active key row FIRST, THEN capture the transition
  -- timestamp — corrected this round: the previous draft captured v_now
  -- before acquiring this lock, so a session that waited on the lock would
  -- record a transition timestamp earlier than when it actually observed
  -- and mutated the row.
  select * into v_current from public.qr_encryption_key_registry where status = 'active' for update;

  v_now := clock_timestamp(); -- one captured timestamp, reused for both the row update and its audit metadata

  if v_current.id is not null then
    update public.qr_encryption_key_registry set status = 'decrypt_only' where id = v_current.id;
    insert into public.audit_logs (entity_type, entity_id, action, actor_type, metadata, created_at)
    values (
      'qr_encryption_key', v_current.id, 'key_version_transitioned', 'system',
      jsonb_build_object('from_status', 'active', 'to_status', 'decrypt_only', 'key_version', v_current.key_version),
      v_now
    );
  end if;
  -- Zero active keys is acceptable temporarily (point 3, prior round) —
  -- if v_current was not found, this rotation activates the new version
  -- with no predecessor to demote; issuance fails closed in the interim.

  insert into public.qr_encryption_key_registry (key_version, status, activated_at)
  values (p_new_key_version, 'active', v_now);

  -- Point 1 fix: column list and value list now correctly correspond —
  -- entity_type gets the literal text, entity_id gets the new row's uuid.
  insert into public.audit_logs (entity_type, entity_id, action, actor_type, metadata, created_at)
  select 'qr_encryption_key', id, 'key_version_transitioned', 'system',
    jsonb_build_object('from_status', null, 'to_status', 'active', 'key_version', p_new_key_version),
    v_now
  from public.qr_encryption_key_registry where key_version = p_new_key_version;

  return 'rotated';
end;
$$;

revoke all on function public.rotate_encryption_key_version_for_server(smallint) from public;
grant execute on function public.rotate_encryption_key_version_for_server(smallint) to service_role;

-- Retirement (decrypt_only -> retired) is super_admin-only, NOT
-- program_attendance_manager — the one narrower role-gate in this entire
-- document, since key-material lifecycle is a strictly higher-privilege
-- operation than credential issuance/revocation.
create function public.retire_encryption_key_version(p_key_version smallint) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller public.profiles;
  v_current public.qr_encryption_key_registry;
  v_active_count integer;
  v_now timestamptz;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v_caller from public.profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role <> 'super_admin' then
    raise exception 'Not authorized';
  end if;

  -- Same fixed advisory lock as rotation — retirement and rotation both
  -- mutate this table's singleton-active invariant space and should not
  -- interleave arbitrarily.
  perform pg_advisory_xact_lock(hashtext('qr_encryption_key_rotation'));

  select * into v_current from public.qr_encryption_key_registry where key_version = p_key_version for update;
  if v_current.id is null then raise exception 'Unknown key version'; end if;

  -- Same-state request is a no-op, no duplicate audit row.
  if v_current.status = 'retired' then
    return 'already_in_status';
  end if;
  if v_current.status <> 'decrypt_only' then
    raise exception 'Only a decrypt_only key version may be retired (current status: %)', v_current.status;
  end if;

  select count(*) into v_active_count
    from public.qr_credentials where status = 'active' and encryption_key_version = p_key_version;
  if v_active_count > 0 then
    raise exception 'Cannot retire key version %: % active credential(s) still reference it', p_key_version, v_active_count;
  end if;

  v_now := clock_timestamp();

  update public.qr_encryption_key_registry set status = 'retired', retired_at = v_now where id = v_current.id;

  insert into public.audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, created_at)
  values (
    'qr_encryption_key', v_current.id, 'key_version_transitioned', 'admin', v_caller.id,
    jsonb_build_object('from_status', 'decrypt_only', 'to_status', 'retired', 'key_version', p_key_version),
    v_now
  );
  return 'retired';
end;
$$;

revoke all on function public.retire_encryption_key_version(smallint) from public;
grant execute on function public.retire_encryption_key_version(smallint) to authenticated;
-- (super_admin-only, enforced inside)

alter table public.qr_credentials
  add constraint qr_credentials_encryption_key_version_fkey
  foreign key (encryption_key_version) references public.qr_encryption_key_registry(key_version)
  on delete restrict;

-- ============================================================================
-- §1.6a  qr_bulk_operation_batches
-- ============================================================================
create table public.qr_bulk_operation_batches (
  id                       uuid primary key default gen_random_uuid(),
  created_by_auth_user_id  uuid not null,
  created_by_profile_id    uuid references public.profiles(id) on delete set null,
  intended_operation_type  text not null check (intended_operation_type in ('issue', 'reissue')),
  status                   text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  created_at               timestamptz not null default now(),
  expires_at               timestamptz not null check (expires_at > created_at),
  closed_at                timestamptz,

  constraint qr_bulk_operation_batches_active_has_no_closed_at check (
    status <> 'active' or closed_at is null
  ),
  constraint qr_bulk_operation_batches_closed_requires_closed_at check (
    status = 'active' or closed_at is not null
  )
);

create index qr_bulk_operation_batches_active_expiry_idx on public.qr_bulk_operation_batches (expires_at)
  where status = 'active';

alter table public.qr_bulk_operation_batches enable row level security;
revoke select, insert, update, delete, truncate, references, trigger
  on public.qr_bulk_operation_batches from anon, authenticated;

-- Defensive trigger, same discipline as every other lifecycle table in
-- this document: identity fields immutable forever, status whitelist
-- enforced even against a direct service-role/owner write.
create function public.qr_bulk_operation_batches_enforce_lifecycle_trigger() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'qr_bulk_operation_batches rows are never deleted, only transitioned';
  end if;

  -- INSERT guard (this round's addition): a newly inserted batch must
  -- always begin 'active' with closed_at null, must declare a valid
  -- operation type, must have matching auth-user/profile ownership (the
  -- same 1:1 identity check create_qr_bulk_operation_batch_for_server
  -- already performs — restated here as a table-level second layer, not
  -- merely trusted from the RPC), and must reference a profile that is
  -- CURRENTLY a valid staff role. Unlike qr_credentials' INSERT guard
  -- (where re-checking role at the trigger layer was judged unnecessary
  -- overhead on issuance's hot path), bulk-batch creation is rare and
  -- low-frequency, so the extra profiles lookup here is an acceptable
  -- cost for a second, independent authorization-shape check.
  if tg_op = 'INSERT' then
    if new.status <> 'active' then
      raise exception 'A newly inserted qr_bulk_operation_batches row must have status = active';
    end if;
    if new.closed_at is not null then
      raise exception 'A newly inserted qr_bulk_operation_batches row must have closed_at null';
    end if;
    if new.intended_operation_type not in ('issue', 'reissue') then
      raise exception 'A newly inserted qr_bulk_operation_batches row must have a valid intended_operation_type';
    end if;
    if new.created_by_auth_user_id is null then
      raise exception 'created_by_auth_user_id is required';
    end if;
    if new.created_by_profile_id is null or new.created_by_profile_id <> new.created_by_auth_user_id then
      raise exception 'created_by_profile_id must equal created_by_auth_user_id';
    end if;
    if not exists (
      select 1 from public.profiles
      where id = new.created_by_profile_id and role in ('super_admin', 'program_attendance_manager')
    ) then
      raise exception 'created_by_profile_id must reference a currently authorized staff profile';
    end if;
    if new.expires_at <= new.created_at then
      raise exception 'expires_at must be after created_at';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id then raise exception 'id is immutable'; end if;
  if new.created_by_auth_user_id is distinct from old.created_by_auth_user_id then
    raise exception 'created_by_auth_user_id is immutable';
  end if;
  if new.intended_operation_type is distinct from old.intended_operation_type then
    raise exception 'intended_operation_type is immutable';
  end if;
  if new.created_at is distinct from old.created_at then raise exception 'created_at is immutable'; end if;
  if new.expires_at is distinct from old.expires_at then raise exception 'expires_at is immutable'; end if;

  if new.created_by_profile_id is not null
     and new.created_by_profile_id is distinct from old.created_by_profile_id then
    raise exception 'created_by_profile_id can never be (re)assigned by update, only cleared to null';
  end if;

  if old.status is distinct from new.status then
    if old.status <> 'active' or new.status not in ('completed', 'cancelled') then
      raise exception 'Illegal bulk batch status transition: % -> %', old.status, new.status;
    end if;
  end if;
  if old.status in ('completed', 'cancelled') and new.closed_at is distinct from old.closed_at then
    raise exception 'closed_at is immutable once a batch is closed';
  end if;

  return new;
end;
$$;

revoke all on function public.qr_bulk_operation_batches_enforce_lifecycle_trigger() from public;

create trigger qr_bulk_operation_batches_lifecycle_guard
  before insert or update or delete on public.qr_bulk_operation_batches
  for each row execute function public.qr_bulk_operation_batches_enforce_lifecycle_trigger();

-- CORRECTED this round: p_staff_auth_user_id and p_staff_profile_id were
-- previously independent, untrusted parameters with no cross-check between
-- them — a caller could in principle supply a mismatched pair. Per this
-- repository's actual schema (supabase/migrations/20260721200747_roles_and_profiles.sql:11,
-- `profiles.id uuid primary key references auth.users(id)`), a profile's id
-- IS the owning auth user's id — a strict 1:1 relationship, not a separate
-- foreign key to a distinct auth-user column. The two parameters are kept
-- (mirroring qr_lifecycle_operations' own requested_by_auth_user_id /
-- requested_by_profile_id pair, for symmetry and so a future schema change
-- decoupling profiles from auth.users doesn't require an API change here),
-- but this function now explicitly verifies they are the same value before
-- trusting either.
create function public.create_qr_bulk_operation_batch_for_server(
  p_staff_auth_user_id uuid,
  p_staff_profile_id uuid,
  p_intended_operation_type text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_batch_id uuid;
  v_created_at timestamptz;
begin
  if p_staff_auth_user_id is null then raise exception 'Staff auth user id is required'; end if;
  if p_intended_operation_type not in ('issue', 'reissue') then
    raise exception 'Invalid intended operation type';
  end if;
  if p_staff_profile_id is null or p_staff_profile_id <> p_staff_auth_user_id then
    raise exception 'Staff auth user id and profile id must identify the same account';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_staff_profile_id and role in ('super_admin','program_attendance_manager')
  ) then
    raise exception 'Invalid staff profile for bulk batch creation';
  end if;

  -- CORRECTED this round: one captured timestamp for BOTH created_at and
  -- expires_at, explicitly inserted — was previously relying on
  -- created_at's column default (now(), i.e. transaction-start time)
  -- while expires_at used clock_timestamp() (call-time), which can be a
  -- different instant within the same transaction, producing a batch
  -- whose stated 1-hour lifetime doesn't actually measure from its own
  -- created_at.
  v_created_at := clock_timestamp();

  insert into public.qr_bulk_operation_batches (
    created_by_auth_user_id, created_by_profile_id, intended_operation_type, created_at, expires_at
  ) values (
    p_staff_auth_user_id, p_staff_profile_id, p_intended_operation_type,
    v_created_at, v_created_at + interval '1 hour'
  ) returning id into v_batch_id;

  insert into public.audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, created_at)
  values (
    'qr_bulk_operation_batch', v_batch_id, 'bulk_batch_created', 'admin', p_staff_profile_id,
    jsonb_build_object('intended_operation_type', p_intended_operation_type),
    v_created_at
  );

  return v_batch_id;
end;
$$;

revoke all on function public.create_qr_bulk_operation_batch_for_server(uuid, uuid, text) from public;
grant execute on function public.create_qr_bulk_operation_batch_for_server(uuid, uuid, text) to service_role;
-- service_role-only: the decision to START a bulk operation is an
-- application-orchestration action authorized once, up front, by the
-- calling Next.js server action's own staff-role gate — not re-derived
-- per-row inside this table. This is the entire point of a batch id: one
-- authorization decision covers the whole batch, and every individual
-- reservation call in the loop below merely PROVES membership in an
-- already-authorized batch, rather than independently asserting bulk
-- status itself.

-- Called once by the Node orchestration loop after all reservations in
-- the batch have been attempted (successfully or not) — marks the batch
-- closed so its id can never be reused for a later, unrelated call.
create function public.complete_qr_bulk_operation_batch_for_server(p_batch_id uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_batch public.qr_bulk_operation_batches;
  v_now timestamptz;
begin
  select * into v_batch from public.qr_bulk_operation_batches where id = p_batch_id for update;
  if v_batch.id is null then raise exception 'Batch not found'; end if;
  if v_batch.status <> 'active' then
    return 'already_closed';
  end if;
  v_now := clock_timestamp();
  update public.qr_bulk_operation_batches set status = 'completed', closed_at = v_now where id = p_batch_id;
  insert into public.audit_logs (entity_type, entity_id, action, actor_type, metadata, created_at)
  values (
    'qr_bulk_operation_batch', p_batch_id, 'bulk_batch_completed', 'system',
    jsonb_build_object('created_by_profile_id', v_batch.created_by_profile_id), v_now
  );
  return 'completed';
end;
$$;

revoke all on function public.complete_qr_bulk_operation_batch_for_server(uuid) from public;
grant execute on function public.complete_qr_bulk_operation_batch_for_server(uuid) to service_role;

-- ============================================================================
-- §1.7  qr_lifecycle_operations — the reservation/finalization bridge table
-- ============================================================================
create table public.qr_lifecycle_operations (
  id                              uuid primary key default gen_random_uuid(),
  operation_type                  text not null check (operation_type in ('issue', 'reissue')),
  application_id                  uuid not null references public.applications(id) on delete restrict,
  requested_by_auth_user_id       uuid not null,
  requested_by_profile_id         uuid references public.profiles(id) on delete set null,
  channel                         text not null check (channel in
                                     ('participant_self_service','staff_individual','staff_bulk')),
  bulk_batch_id                   uuid references public.qr_bulk_operation_batches(id) on delete restrict,
  -- Sub-pass 2: caller-supplied, client-generated BEFORE the user confirms
  -- the action, reused verbatim on every retry of that same action. Not
  -- secret, not derived from any cryptographic material, and never a
  -- credential id/token/hash/ciphertext/nonce itself — a correlation id
  -- only. NOT NULL: every reservation path (participant and staff,
  -- individual and bulk) must supply one; there is no legacy/optional path
  -- that skips idempotency protection.
  --
  -- Format validation: the `uuid` column type itself is the format check —
  -- Postgres (and PostgREST's own parameter-binding layer, before the
  -- value ever reaches this table) rejects any value that is not a
  -- syntactically valid UUID at the type level, with no separate CHECK
  -- constraint needed. No value-range or content validation applies beyond
  -- "is a UUID" — unlike token_hash/token_ciphertext (§1.2), which carry
  -- meaningful shape constraints, request_key is an opaque client-chosen
  -- correlation token with no further structure to validate.
  --
  -- Migration ordering: declared inline in this CREATE TABLE, not via a
  -- later ALTER TABLE — avoiding the exact duplicate-declaration mistake
  -- found and corrected earlier in this document (§1.2's
  -- qr_credentials_id_application_unique). qr_lifecycle_operations is a
  -- new table in this same migration (Phase 6 is a from-scratch addition,
  -- §1.1), so there is no pre-existing deployed table this column needs to
  -- be added to after the fact — it exists from this table's very first
  -- creation statement.
  request_key                     uuid not null,
  reason_code                     text,
  note                            text check (char_length(note) <= 500),
  expected_current_credential_id  uuid,   -- NULL for issue; the active credential's id at
                                           -- reservation time, for reissue (see composite FK below)
  status                          text not null default 'pending' check (status in
                                     ('pending', 'consumed', 'expired', 'cancelled')),
  terminal_reason_code            text check (terminal_reason_code in (
                                     'ttl_expired', 'application_ineligible',
                                     'active_credential_already_exists',
                                     'expected_credential_changed', 'cancelled_by_server',
                                     'bulk_batch_unavailable', 'requester_no_longer_authorized',
                                     -- Added for participant self-reissue reservation
                                     -- (request_my_qr_reissue_transactional, this round):
                                     -- three reissue-specific terminal conditions that have
                                     -- no existing equivalent among the seven codes above.
                                     -- 'expected_credential_changed' is deliberately REUSED
                                     -- (not duplicated) for the case where the active
                                     -- credential still exists but no longer matches
                                     -- expected_current_credential_id — it already means
                                     -- exactly that. These three are genuinely new
                                     -- conditions issuance never has: reissue requires an
                                     -- active credential to exist at all (issuance requires
                                     -- the opposite), and only reissue is rate-limited.
                                     'no_active_credential', 'reissue_cooldown_active',
                                     'reissue_rate_limit_exceeded'
                                   )),
  created_at                      timestamptz not null default now(),
  expires_at                      timestamptz not null check (expires_at > created_at),
  consumed_at                     timestamptz,
  finalized_at                    timestamptz,
  resulting_credential_id         uuid,   -- see composite FK below
  -- This round: a non-secret, deterministic 32-byte fingerprint of exactly
  -- what was finalized, computed by the finalizer from the resulting
  -- credential UUID, token hash, token version, encryption-key version (AT
  -- THE TIME OF FINALIZATION), and a SHA-256 digest of the ciphertext
  -- envelope — see the finalizers below for the exact canonical encoding.
  -- Stored on the OPERATION (not derived from the credential row at replay
  -- time) specifically so idempotent-replay correctness never depends on
  -- qr_credentials.encryption_key_version, which is CLEARED to null on
  -- replacement/revocation (§1.2's active-is-consistent/revoked-is-consistent/
  -- replaced-is-consistent constraints) — a naive "recompute from the
  -- current credential row" comparison would silently break the moment a
  -- credential is later reissued or revoked, making already_finalized
  -- unrecoverable for a legitimately-delayed retry.
  finalization_fingerprint        bytea check (finalization_fingerprint is null or octet_length(finalization_fingerprint) = 32),

  -- Sub-pass 2, third correction round: persists the EXACT credential a
  -- cancelled-because-already-active issuance observed at cancellation
  -- time. Previously, replaying an 'active_credential_already_exists'
  -- cancellation re-queried "whichever credential is active right now" —
  -- if that credential was later revoked or replaced, a retry under the
  -- same request_key would replay a DIFFERENT credential (or none at all)
  -- than what the original decision actually observed, breaking
  -- historical replay stability. Composite FK mirrors
  -- qr_credentials_replacement_same_application_fkey/the expected/
  -- resulting_credential FKs below: proves the referenced credential
  -- belongs to THIS operation's application_id, not merely "some
  -- credential row somewhere." ON DELETE RESTRICT: qr_credentials rows
  -- are never deleted in this design (§1.5's trigger forbids it
  -- unconditionally), so this is unreachable in practice but stated for
  -- the same defense-in-depth reason every other credential FK in this
  -- table states it.
  terminal_related_credential_id  uuid,

  -- This round's addition: durably preserves the exact retry-eligibility
  -- boundary a cooldown/rate-limit denial computed at cancellation time.
  -- Without this, a replayed cooldown/rate-limit denial (same request_key,
  -- reused after the original response was lost) would have to
  -- RE-DERIVE "how long until retry is allowed" from the CURRENT set of
  -- consumed operations — which may have changed (a new reissue may have
  -- since consumed, shifting the window) since the original decision was
  -- made, silently returning a DIFFERENT retry_after_seconds than the one
  -- originally computed and already possibly acted upon by the caller.
  -- Storing the boundary itself, once, at the moment of denial, makes a
  -- replay purely a matter of reading this column and subtracting the
  -- current clock — never re-evaluating historical policy.
  terminal_retry_after_at         timestamptz,

  -- Point 5 (prior round): complete state-consistency, three real shapes
  -- (pending vs. consumed vs. expired-or-cancelled), each fully specified
  -- in both directions rather than only checking what must be non-null.
  -- Sub-pass 2: terminal_related_credential_id folded into every one of
  -- these — required null on pending/consumed/expired, and split within
  -- 'cancelled' by terminal_reason_code (below).
  constraint qr_lifecycle_operations_pending_is_consistent check (
    status <> 'pending' or (
      finalized_at is null and consumed_at is null and resulting_credential_id is null
      and terminal_reason_code is null and finalization_fingerprint is null
      and terminal_related_credential_id is null and terminal_retry_after_at is null
    )
  ),
  constraint qr_lifecycle_operations_consumed_is_consistent check (
    status <> 'consumed' or (
      finalized_at is not null and consumed_at is not null and resulting_credential_id is not null
      and terminal_reason_code is null and finalization_fingerprint is not null
      and terminal_related_credential_id is null and terminal_retry_after_at is null
    )
  ),
  -- consumed_at and finalized_at must be the exact same instant on a
  -- consumed row — a single database-captured transition timestamp, never
  -- two independently-set values that could drift.
  constraint qr_lifecycle_operations_consumed_timestamps_match check (
    status <> 'consumed' or consumed_at = finalized_at
  ),
  -- This round (point 9): expired/cancelled rows must carry a
  -- machine-readable, non-secret terminal_reason_code — never exception
  -- text, never anything derived from cryptographic material.
  -- Sub-pass 2: split into two constraints — 'expired' NEVER carries
  -- terminal_related_credential_id (nothing was ever "the current
  -- credential" for an operation that just timed out); 'cancelled'
  -- carries it if AND ONLY IF terminal_reason_code is specifically
  -- 'active_credential_already_exists' — every other cancellation reason
  -- (application_ineligible, expected_credential_changed,
  -- cancelled_by_server, bulk_batch_unavailable,
  -- requester_no_longer_authorized) has no associated credential to
  -- persist. FOURTH correction round: the reason code is now bound to the
  -- status itself, not merely required to be non-null — 'expired' can
  -- ONLY ever mean 'ttl_expired' (this table has no other concept of
  -- "timed out"; every other terminal-for-cause reason is, by
  -- definition, a 'cancelled' row, never an 'expired' one), and
  -- 'cancelled' can NEVER carry 'ttl_expired' (that value is reserved
  -- exclusively for the 'expired' status, so a direct service-role write
  -- cannot mislabel a for-cause cancellation as a timeout or vice versa).
  constraint qr_lifecycle_operations_expired_is_consistent check (
    status <> 'expired' or (
      finalized_at is not null and consumed_at is null and resulting_credential_id is null
      and terminal_reason_code = 'ttl_expired' and finalization_fingerprint is null
      and terminal_related_credential_id is null and terminal_retry_after_at is null
    )
  ),
  -- This round: terminal_retry_after_at follows the identical
  -- if-and-only-if pattern already established for
  -- terminal_related_credential_id/active_credential_already_exists —
  -- required exactly when terminal_reason_code is one of the two
  -- policy-driven denials ('reissue_cooldown_active',
  -- 'reissue_rate_limit_exceeded'), forbidden for every other cancellation
  -- reason. CORRECTED this round: terminal_related_credential_id is
  -- permitted ONLY for 'active_credential_already_exists' — NOT for
  -- 'expected_credential_changed', which (like every other cancellation
  -- reason) must leave it null. The earlier version of this comment
  -- incorrectly claimed 'expected_credential_changed' also used
  -- terminal_related_credential_id; the CHECK constraint below was always
  -- the authoritative source and never actually permitted that. The two
  -- "extra terminal fields" are mutually exclusive by reason code, never
  -- both set on the same row.
  constraint qr_lifecycle_operations_cancelled_is_consistent check (
    status <> 'cancelled' or (
      finalized_at is not null and consumed_at is null and resulting_credential_id is null
      and terminal_reason_code is not null and terminal_reason_code <> 'ttl_expired'
      and finalization_fingerprint is null
      and (
        (terminal_reason_code = 'active_credential_already_exists' and terminal_related_credential_id is not null)
        or (terminal_reason_code <> 'active_credential_already_exists' and terminal_related_credential_id is null)
      )
      and (
        (terminal_reason_code in ('reissue_cooldown_active', 'reissue_rate_limit_exceeded') and terminal_retry_after_at is not null)
        or (terminal_reason_code not in ('reissue_cooldown_active', 'reissue_rate_limit_exceeded') and terminal_retry_after_at is null)
      )
    )
  ),
  constraint qr_lifecycle_operations_reissue_has_expected_credential check (
    operation_type <> 'reissue' or expected_current_credential_id is not null
  ),
  constraint qr_lifecycle_operations_issue_has_no_expected_credential check (
    operation_type <> 'issue' or expected_current_credential_id is null
  ),
  -- This round (point 7): bulk_batch_id is required exactly when
  -- channel = 'staff_bulk', and must be absent for every other channel —
  -- closes the gap where a batch id could be recorded on the operation
  -- without the channel actually reflecting bulk provenance, or vice versa.
  constraint qr_lifecycle_operations_bulk_batch_matches_channel check (
    (channel = 'staff_bulk' and bulk_batch_id is not null)
    or (channel <> 'staff_bulk' and bulk_batch_id is null)
  ),
  -- For a consumed reissue, the result must genuinely be a DIFFERENT
  -- credential than the one that was replaced — a reissue that somehow
  -- "resulted in" the same credential it expected to replace would
  -- indicate a logic error, not a legitimate outcome.
  constraint qr_lifecycle_operations_reissue_result_differs check (
    status <> 'consumed' or operation_type <> 'reissue'
    or resulting_credential_id is distinct from expected_current_credential_id
  ),

  -- Composite FKs proving both referenced credentials belong to THIS
  -- operation's application_id, not merely "some credential row."
  constraint qr_lifecycle_operations_expected_credential_fkey
    foreign key (expected_current_credential_id, application_id)
    references public.qr_credentials (id, application_id) on delete restrict,
  constraint qr_lifecycle_operations_resulting_credential_fkey
    foreign key (resulting_credential_id, application_id)
    references public.qr_credentials (id, application_id) on delete restrict,
  constraint qr_lifecycle_operations_terminal_related_credential_fkey
    foreign key (terminal_related_credential_id, application_id)
    references public.qr_credentials (id, application_id) on delete restrict
);

create index qr_lifecycle_operations_pending_expiry_idx on public.qr_lifecycle_operations (expires_at)
  where status = 'pending';

-- Point 7: a credential must never be recorded as the result of more than
-- one operation.
create unique index qr_lifecycle_operations_resulting_credential_unique_idx
  on public.qr_lifecycle_operations (resulting_credential_id) where resulting_credential_id is not null;

-- Sub-pass 2, third correction round: REPLACES the previous
-- requester-scoped qr_lifecycle_operations_one_pending_per_requester_idx
-- entirely (that index is REMOVED, not retained alongside this one — two
-- overlapping partial unique indexes on the same conceptual invariant
-- would be redundant and confusing to reason about together). The
-- previous requester-scoped version allowed two DIFFERENT accounts
-- (two different staff members, or a participant and a staff member) to
-- each hold their own concurrent pending operation for the SAME
-- application and operation_type — which is exactly the double-issuance/
-- double-reissue race this table exists to prevent; "requester" is not
-- part of the actual real-world invariant ("this application does not
-- need two people independently working the same lifecycle action at
-- once"). Domain-wide: (application_id, operation_type), no requester
-- column at all.
create unique index qr_lifecycle_operations_one_pending_per_domain_idx
  on public.qr_lifecycle_operations (application_id, operation_type)
  where status = 'pending';

-- Sub-pass 2: the actual request_key idempotency guarantee. Unscoped by
-- status (unlike the pending-only index above) — a request_key must
-- resolve to the SAME operation for that operation's entire lifetime,
-- including after it transitions to consumed/expired/cancelled, so a
-- lost-response retry arriving after finalization still finds the exact
-- row it needs for the already_finalized replay path. Scoped by
-- (requester, operation_type, request_key) rather than including
-- application_id: request_key is generated once per user ACTION, and the
-- application_id for a participant self-service call is itself derived
-- from the requester's own row, so including it would be redundant for
-- that channel and would incorrectly let the SAME staff-generated
-- request_key be reused across two different applications for the staff
-- channels, which must never happen — each confirmed action (one UUID,
-- generated once, before confirmation) targets exactly one application.
create unique index qr_lifecycle_operations_request_key_unique_idx
  on public.qr_lifecycle_operations (requested_by_auth_user_id, operation_type, request_key);

alter table public.qr_lifecycle_operations enable row level security;
revoke select, insert, update, delete, truncate, references, trigger
  on public.qr_lifecycle_operations from anon, authenticated;

create function public.qr_lifecycle_operations_enforce_lifecycle_trigger() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'qr_lifecycle_operations rows are never deleted, only transitioned';
  end if;

  -- CORRECTED this round: the trigger previously fired only on UPDATE/
  -- DELETE, leaving INSERT completely unguarded — a service-role bug (or
  -- a future code path added carelessly) could insert a row directly in
  -- an already-'consumed'/'cancelled' shape, fabricating a finalized
  -- operation that never actually went through a finalizer. Every new
  -- row must begin in exactly the pending, all-terminal-fields-null
  -- shape; the table's own qr_lifecycle_operations_pending_is_consistent
  -- CHECK constraint independently enforces this too, but the trigger
  -- states it explicitly and self-documents the invariant at the point
  -- where a violation would first occur.
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'A newly inserted qr_lifecycle_operations row must have status = pending';
    end if;
    if new.finalized_at is not null or new.consumed_at is not null
       or new.resulting_credential_id is not null or new.terminal_reason_code is not null
       or new.finalization_fingerprint is not null or new.terminal_related_credential_id is not null
       or new.terminal_retry_after_at is not null
    then
      raise exception 'A newly inserted qr_lifecycle_operations row must have all terminal fields null';
    end if;
    return new;
  end if;

  -- Immutable identity/intent fields, forever, regardless of status:
  if new.id is distinct from old.id then raise exception 'id is immutable'; end if;
  if new.operation_type is distinct from old.operation_type then raise exception 'operation_type is immutable'; end if;
  if new.application_id is distinct from old.application_id then raise exception 'application_id is immutable'; end if;
  if new.requested_by_auth_user_id is distinct from old.requested_by_auth_user_id then
    raise exception 'requested_by_auth_user_id is immutable';
  end if;
  if new.channel is distinct from old.channel then raise exception 'channel is immutable'; end if;
  if new.bulk_batch_id is distinct from old.bulk_batch_id then raise exception 'bulk_batch_id is immutable'; end if;
  if new.request_key is distinct from old.request_key then raise exception 'request_key is immutable'; end if;
  if new.reason_code is distinct from old.reason_code then raise exception 'reason_code is immutable'; end if;
  if new.note is distinct from old.note then raise exception 'note is immutable'; end if;
  if new.expected_current_credential_id is distinct from old.expected_current_credential_id then
    raise exception 'expected_current_credential_id is immutable';
  end if;
  if new.created_at is distinct from old.created_at then raise exception 'created_at is immutable'; end if;
  if new.expires_at is distinct from old.expires_at then raise exception 'expires_at is immutable'; end if;

  -- requested_by_profile_id may only transition to null (ON DELETE SET
  -- NULL), same pattern as qr_credentials' actor columns (§1.5).
  if new.requested_by_profile_id is not null
     and new.requested_by_profile_id is distinct from old.requested_by_profile_id then
    raise exception 'requested_by_profile_id can never be (re)assigned by update, only cleared to null';
  end if;

  -- Status transition whitelist: pending -> {consumed, expired, cancelled} only.
  if old.status is distinct from new.status then
    if old.status <> 'pending' or new.status not in ('consumed', 'expired', 'cancelled') then
      raise exception 'Illegal operation status transition: % -> %', old.status, new.status;
    end if;
  end if;

  -- CORRECTED this round (strengthened): a single, unified, EXPLICIT
  -- immutability block covering every terminal state — 'consumed' AND
  -- 'expired'/'cancelled' alike — for all six terminal-shape fields
  -- (status, finalized_at, consumed_at, resulting_credential_id,
  -- terminal_reason_code, finalization_fingerprint,
  -- terminal_related_credential_id). The previous version checked these
  -- asymmetrically (consumed rows guarded all six; expired/cancelled rows
  -- only guarded finalized_at and terminal_reason_code, relying on the
  -- table's CHECK constraints alone for
  -- consumed_at/resulting_credential_id/finalization_fingerprint on those
  -- rows). The trigger is now the FIRST defensive layer, explicit and
  -- self-documenting; the table CHECK constraints (§1.7's
  -- qr_lifecycle_operations_consumed_is_consistent/expired_is_consistent/
  -- cancelled_is_consistent) remain the SECOND, independent layer —
  -- neither depends on the other alone.
  --
  -- CONTROL-FLOW NOTE (fourth correction round, requested for explicit
  -- review): this guard's condition is `old.status in ('consumed',
  -- 'expired', 'cancelled') AND new.status = old.status` — a conjunction,
  -- both halves required. On the legal `pending -> cancelled` transition
  -- itself (the transition that FIRST assigns
  -- terminal_related_credential_id, e.g. for
  -- 'active_credential_already_exists'), old.status is 'pending', which
  -- is NOT a member of ('consumed', 'expired', 'cancelled') — so the
  -- entire `if` is false and NONE of the raises inside this block
  -- (including the terminal_related_credential_id one) ever evaluate.
  -- This block only ever fires on a SAME-terminal-status update (e.g. a
  -- second UPDATE attempted against an already-'cancelled' row), which is
  -- exactly and only the case this immutability guard is meant to
  -- reject. The null-to-credential assignment during the initial
  -- pending -> cancelled(active_credential_already_exists) transition is
  -- therefore never blocked by this block — it is governed instead by the
  -- SEPARATE, transition-specific rules below (search
  -- "terminal_related_credential_id: NEVER set on expired"), which run
  -- unconditionally for every pending -> * transition regardless of this
  -- guard. The only field that additionally tolerates a null-to-non-null
  -- OR non-null-to-null change even on an already-terminal row is
  -- requested_by_profile_id (checked separately, above, for its own
  -- documented ON DELETE SET NULL reason) — terminal_related_credential_id
  -- has no equivalent exception once terminal, by design: a credential
  -- FK (§1.2's qr_credentials_enforce_lifecycle_trigger) never deletes
  -- rows, so there is no ON DELETE SET NULL path that could legitimately
  -- null it out after the fact, unlike requested_by_profile_id's FK to
  -- profiles (which does get deleted, e.g. account removal).
  if old.status in ('consumed', 'expired', 'cancelled') and new.status = old.status then
    if new.finalized_at is distinct from old.finalized_at then
      raise exception 'finalized_at is immutable once a terminal status is reached';
    end if;
    if new.consumed_at is distinct from old.consumed_at then
      raise exception 'consumed_at is immutable once a terminal status is reached';
    end if;
    if new.resulting_credential_id is distinct from old.resulting_credential_id then
      raise exception 'resulting_credential_id is immutable once a terminal status is reached';
    end if;
    if new.terminal_reason_code is distinct from old.terminal_reason_code then
      raise exception 'terminal_reason_code is immutable once a terminal status is reached';
    end if;
    if new.finalization_fingerprint is distinct from old.finalization_fingerprint then
      raise exception 'finalization_fingerprint is immutable once a terminal status is reached';
    end if;
    if new.terminal_related_credential_id is distinct from old.terminal_related_credential_id then
      raise exception 'terminal_related_credential_id is immutable once a terminal status is reached';
    end if;
    -- This round's addition: terminal_retry_after_at follows the exact
    -- same once-terminal-immutable discipline as every other terminal
    -- field above — assignable ONLY during the initial pending -> *
    -- transition (governed by the separate, transition-specific rules
    -- below), never mutable again once that transition has committed.
    if new.terminal_retry_after_at is distinct from old.terminal_retry_after_at then
      raise exception 'terminal_retry_after_at is immutable once a terminal status is reached';
    end if;
  end if;

  -- finalized_at: null while pending, non-null the instant status leaves
  -- pending. On pending -> consumed specifically, consumed_at and
  -- finalized_at must be set TOGETHER in the same update (checked here;
  -- the table's qr_lifecycle_operations_consumed_timestamps_match
  -- constraint additionally forces them to be the exact same value, not
  -- merely both non-null).
  if old.status = 'pending' and new.status <> 'pending' and new.finalized_at is null then
    raise exception 'finalized_at must be set in the same transition that leaves pending';
  end if;
  if old.status = 'pending' and new.status = 'consumed' and new.consumed_at is null then
    raise exception 'consumed_at must be set in the same transition from pending to consumed';
  end if;
  if old.status = 'pending' and new.status in ('expired', 'cancelled')
     and (new.consumed_at is not null or new.resulting_credential_id is not null) then
    raise exception 'consumed_at and resulting_credential_id must remain null when transitioning to expired or cancelled';
  end if;
  if old.status = 'pending' and new.status in ('expired', 'cancelled') and new.terminal_reason_code is null then
    raise exception 'terminal_reason_code must be set in the same transition to expired or cancelled';
  end if;
  -- Fourth correction round: mirrors qr_lifecycle_operations_expired_is_consistent/
  -- cancelled_is_consistent (§1.7) as a controlled TRIGGER error, not only
  -- a CHECK-constraint violation — 'expired' can only ever mean
  -- 'ttl_expired', and 'ttl_expired' can never label a 'cancelled' row.
  if old.status = 'pending' and new.status = 'expired' and new.terminal_reason_code is distinct from 'ttl_expired' then
    raise exception 'terminal_reason_code must be exactly ttl_expired when transitioning to expired';
  end if;
  if old.status = 'pending' and new.status = 'cancelled' and new.terminal_reason_code = 'ttl_expired' then
    raise exception 'terminal_reason_code must not be ttl_expired when transitioning to cancelled';
  end if;
  if old.status = 'pending' and new.status = 'consumed' and new.terminal_reason_code is not null then
    raise exception 'terminal_reason_code must remain null when transitioning to consumed';
  end if;
  if old.status = 'pending' and new.status = 'consumed' and new.finalization_fingerprint is null then
    raise exception 'finalization_fingerprint must be set in the same transition from pending to consumed';
  end if;
  if old.status = 'pending' and new.status in ('expired', 'cancelled') and new.finalization_fingerprint is not null then
    raise exception 'finalization_fingerprint must remain null when transitioning to expired or cancelled';
  end if;

  -- terminal_related_credential_id: NEVER set on expired (nothing was ever
  -- "the current credential" for a timed-out operation); on cancelled, set
  -- if AND ONLY IF the terminal_reason_code being recorded in this SAME
  -- transition is 'active_credential_already_exists' — every other
  -- cancellation reason has no associated credential.
  if old.status = 'pending' and new.status = 'expired' and new.terminal_related_credential_id is not null then
    raise exception 'terminal_related_credential_id must remain null when transitioning to expired';
  end if;
  if old.status = 'pending' and new.status = 'cancelled'
     and new.terminal_reason_code = 'active_credential_already_exists'
     and new.terminal_related_credential_id is null then
    raise exception 'terminal_related_credential_id must be set in the same transition to cancelled when terminal_reason_code is active_credential_already_exists';
  end if;
  if old.status = 'pending' and new.status = 'cancelled'
     and new.terminal_reason_code is distinct from 'active_credential_already_exists'
     and new.terminal_related_credential_id is not null then
    raise exception 'terminal_related_credential_id must remain null for any cancellation reason other than active_credential_already_exists';
  end if;

  -- terminal_retry_after_at: this round's addition, same if-and-only-if
  -- shape as terminal_related_credential_id immediately above, but keyed
  -- on the TWO policy-driven cancellation reasons instead of one. NEVER
  -- set on expired (a timed-out operation was never denied by a
  -- retry-boundary policy — its own TTL is the only "when can I retry"
  -- signal, already exposed via expires_at/finalized_at); on cancelled,
  -- set if AND ONLY IF terminal_reason_code being recorded in this SAME
  -- transition is 'reissue_cooldown_active' or 'reissue_rate_limit_exceeded'.
  if old.status = 'pending' and new.status = 'expired' and new.terminal_retry_after_at is not null then
    raise exception 'terminal_retry_after_at must remain null when transitioning to expired';
  end if;
  if old.status = 'pending' and new.status = 'cancelled'
     and new.terminal_reason_code in ('reissue_cooldown_active', 'reissue_rate_limit_exceeded')
     and new.terminal_retry_after_at is null then
    raise exception 'terminal_retry_after_at must be set in the same transition to cancelled when terminal_reason_code is reissue_cooldown_active or reissue_rate_limit_exceeded';
  end if;
  if old.status = 'pending' and new.status = 'cancelled'
     and new.terminal_reason_code not in ('reissue_cooldown_active', 'reissue_rate_limit_exceeded')
     and new.terminal_retry_after_at is not null then
    raise exception 'terminal_retry_after_at must remain null for any cancellation reason other than reissue_cooldown_active or reissue_rate_limit_exceeded';
  end if;

  return new;
end;
$$;

revoke all on function public.qr_lifecycle_operations_enforce_lifecycle_trigger() from public;

create trigger qr_lifecycle_operations_lifecycle_guard
  before insert or update or delete on public.qr_lifecycle_operations
  for each row execute function public.qr_lifecycle_operations_enforce_lifecycle_trigger();

-- ============================================================================
-- §2.1  Explicit direct table-privilege revocation on qr_credentials
-- ============================================================================
revoke select, insert, update, delete, truncate, references, trigger
  on public.qr_credentials from anon, authenticated;

-- ============================================================================
-- §5.0a  compute_qr_finalization_fingerprint — shared fingerprint helper
-- ============================================================================
create function public.compute_qr_finalization_fingerprint(
  p_operation_type text,
  p_credential_id uuid,
  p_token_hash bytea,
  p_token_version smallint,
  p_encryption_key_version smallint,
  p_token_ciphertext bytea
) returns bytea
language plpgsql as $$
declare
  v_domain bytea := pg_catalog.convert_to('rcoy:qr-finalization:v1', 'UTF8');
  v_op_type bytea := pg_catalog.convert_to(p_operation_type, 'UTF8');
  v_canonical bytea;
begin
  if p_operation_type not in ('issue', 'reissue') then
    raise exception 'Invalid operation type for fingerprint computation';
  end if;
  if p_credential_id is null then raise exception 'Credential id is required for fingerprint computation'; end if;
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'Token hash must be exactly 32 bytes for fingerprint computation';
  end if;
  if p_token_version is null or p_token_version not between 1 and 32767 then
    raise exception 'Invalid token version for fingerprint computation';
  end if;
  if p_encryption_key_version is null or p_encryption_key_version not between 1 and 32767 then
    raise exception 'Invalid encryption key version for fingerprint computation';
  end if;
  if p_token_ciphertext is null then raise exception 'Ciphertext envelope is required for fingerprint computation'; end if;

  -- Canonical binary layout, concatenated in this exact fixed order. Every
  -- field is either intrinsically fixed-width by its Postgres type
  -- (uuid_send: always 16 bytes; a 32-byte hash/digest; int2send: always
  -- 2 bytes for a smallint) or explicitly length-prefixed (domain
  -- separator, operation_type) — no field's width is assumed by
  -- convention alone:
  --   [4-byte big-endian length prefix][domain separator UTF-8 bytes, "rcoy:qr-finalization:v1"]
  --   [4-byte big-endian length prefix][operation_type UTF-8 bytes, "issue" | "reissue"]
  --   [16 bytes: credential UUID, RFC 4122 binary form via pg_catalog.uuid_send]
  --   [32 bytes: raw token hash, fixed-width by construction, no prefix needed]
  --   [2 bytes: token_version, native smallint big-endian encoding via pg_catalog.int2send]
  --   [2 bytes: encryption_key_version, same]
  --   [32 bytes: SHA-256 digest of the ciphertext envelope — the envelope
  --    itself is variable-length (61 bytes for v1, per the token format,
  --    but not assumed fixed here), so its DIGEST (always exactly 32
  --    bytes) is embedded directly rather than the envelope itself,
  --    avoiding a second length prefix while still binding the
  --    fingerprint to the ciphertext's exact content]
  v_canonical :=
    pg_catalog.int4send(octet_length(v_domain)) || v_domain
    || pg_catalog.int4send(octet_length(v_op_type)) || v_op_type
    || pg_catalog.uuid_send(p_credential_id)
    || p_token_hash
    || pg_catalog.int2send(p_token_version)
    || pg_catalog.int2send(p_encryption_key_version)
    || extensions.digest(p_token_ciphertext, 'sha256');

  return extensions.digest(v_canonical, 'sha256');
end;
$$;

revoke all on function public.compute_qr_finalization_fingerprint(
  text, uuid, bytea, smallint, smallint, bytea
) from public;
-- No grant to authenticated/anon/service_role directly — called only from
-- within the two finalizers' own security-definer bodies. Deliberately
-- NOT security definer itself (plain plpgsql, no elevated privilege
-- needed — it touches no table, only computes a value from its inputs),
-- so it inherits the CALLING function's search_path rather than needing
-- its own; still schema-qualifies extensions.digest and every built-in
-- binary-encoding call (pg_catalog.convert_to, pg_catalog.int4send,
-- pg_catalog.uuid_send, pg_catalog.int2send) explicitly regardless, since
-- the caller's search_path is not assumed. pg_catalog is always
-- implicitly first in every session's effective search_path regardless
-- of the explicit search_path setting (Postgres always consults
-- pg_catalog first, documented behavior, not a repo-specific convention)
-- — the pg_catalog.-qualification here is for self-documentation/
-- consistency with this function's explicit-qualification policy, not
-- because an unqualified pg_catalog call could actually fail to resolve.

-- ============================================================================
-- §5.1  Issuance — approved reservation (participant self-service, staff
-- individual/bulk) + approved reissue reservation (staff force-reissue,
-- individual/bulk — physically located within this section of the source doc
-- but is the reissue reservation by actual function name) + approved
-- finalize_qr_issuance_for_server
-- ============================================================================
create type public.qr_credential_lifecycle_result as (
  outcome                text,     -- see §8 for the full vocabulary
  credential_id           uuid,
  status                  text,
  issued_at                timestamptz,
  replaced_at              timestamptz,
  revoked_at               timestamptz,
  retry_after_seconds      integer,
  operation_id             uuid
);

-- Shared helper (called from all four reservation RPCs, §5.1 and §5.2).
--
-- SUB-PASS 2, THIRD CORRECTION ROUND — three further defects fixed on top
-- of the second round's five:
--
-- (A) Domain scope was still requester-scoped. The advisory lock and the
-- "another pending operation" lookup both included
-- requested_by_auth_user_id — which meant two DIFFERENT accounts (two
-- staff members, or a participant and a staff member) each got their OWN
-- serialization domain and could each hold a concurrent pending operation
-- for the SAME application/operation_type — exactly the double-issuance
-- race this table exists to prevent. The advisory lock is now keyed on
-- (application_id, operation_type) ONLY — no requester component at all —
-- and qr_lifecycle_operations_one_pending_per_domain_idx (§1.7, replacing
-- the old per-requester index) enforces the same domain-wide scope as a
-- durable constraint, not merely an advisory convention. request_key
-- uniqueness remains SEPARATELY scoped by requester
-- (qr_lifecycle_operations_request_key_unique_idx), since two different
-- accounts coincidentally generating the same UUID must never collide
-- with each other's rows.
--
-- (B) The "other pending" candidate was found but never locked, never
-- TTL-checked, and the function decided its final effect immediately —
-- an unlocked read could race a concurrent finalizer, and an expired
-- "other" candidate would have wrongly blocked a legitimate new request
-- forever. This function now takes FOR UPDATE on whichever candidate row
-- it finds (by request_key OR the domain-wide other-pending lookup) and
-- returns it to the caller UNRESOLVED as to final TTL disposition for the
-- pending case — 'matching_pending_candidate' or
-- 'other_pending_candidate' — so the CALLER can perform the authoritative
-- TTL recheck only after acquiring every remaining required lock (bulk
-- batch, application, current credential), per correction (C). The lock
-- taken here is held for the remainder of the caller's own transaction.
--
-- (C) TTL is no longer resolved to finality inside this function for the
-- pending case (the second round's claim that "TTL is fully resolved
-- inside reserve_or_reuse before the application lock" was WRONG and is
-- retracted) — it is only checked here far enough to decide whether the
-- candidate is even a plausible match (still needed to route
-- consumed/expired/cancelled replay immediately, since those never
-- depend on any lock this function doesn't already hold). For a PENDING
-- candidate specifically, this function returns it locked and unresolved;
-- the caller RPC re-derives clock_timestamp() and makes the authoritative
-- expiry decision only after the application (and, for reissue, current
-- credential) locks are held — see §5.0b's restated lock order and each
-- caller RPC's own final TTL recheck.
-- SUB-PASS 2, FIFTH CORRECTION ROUND:
--
-- (F) A SECOND advisory lock is now taken FIRST, before the domain lock —
-- keyed on (requester_auth_user_id, operation_type, request_key). Without
-- it, the SAME staff account submitting the SAME request_key for TWO
-- DIFFERENT applications concurrently (application A in one call,
-- application B in another, both in flight at once) acquires two
-- DIFFERENT domain locks (one per application) — neither call serializes
-- against the other at all, both reach the by-key lookup, both find no
-- row, and one of them fails downstream with a raw
-- qr_lifecycle_operations_request_key_unique_idx violation instead of the
-- controlled request_key_intent_conflict outcome. The request-key
-- advisory lock closes this: the second call blocks until the first
-- commits, then finds the first's row under that SAME key, compares full
-- intent (application_id included), and correctly reports
-- request_key_intent_conflict (the application_id differs, so intent
-- cannot match) rather than ever reaching the unique index.
--
-- Fixed global lock order, every reservation RPC, no exceptions: (1)
-- request-key advisory lock (requester, type, request_key) (2)
-- reservation-domain advisory lock (application_id, type) (3) lifecycle
-- operation row (4) bulk batch, where applicable (5) application (6)
-- current credential, where applicable.
create function public.reserve_or_reuse_qr_lifecycle_operation(
  p_operation_type text,
  p_application_id uuid,
  p_requester_auth_user_id uuid,
  p_request_key uuid,
  p_channel text,
  p_bulk_batch_id uuid,
  p_reason_code text,
  p_note text,
  p_expected_current_credential_id uuid,
  out op public.qr_lifecycle_operations,
  out state text
  -- 'no_existing_operation' | 'matching_pending_candidate'
  -- | 'other_pending_candidate' | 'already_consumed' | 'replay_expired'
  -- | 'replay_cancelled' | 'request_key_intent_conflict'
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_by_key public.qr_lifecycle_operations;
  v_other_pending public.qr_lifecycle_operations;
  v_intent_matches boolean;
begin
  if p_request_key is null then
    raise exception 'request_key is required';
  end if;

  -- Position 1: request-key advisory lock — serializes concurrent reuse
  -- of the SAME request_key by the SAME requester, regardless of which
  -- application_id each concurrent call is targeting (correction F).
  perform pg_advisory_xact_lock(
    hashtextextended(p_requester_auth_user_id::text || ':' || p_operation_type || ':' || p_request_key::text, 0)
  );

  -- Position 2: reservation-domain advisory lock — (application_id,
  -- operation_type) ONLY, no requester component. Serializes EVERY
  -- concurrent reservation attempt for this exact application/action
  -- against every other, regardless of WHO is requesting it or which
  -- request_key they present.
  perform pg_advisory_xact_lock(
    hashtextextended(p_application_id::text || ':' || p_operation_type, 0)
  );

  -- Position 3: the lifecycle operation row, by (requester, type,
  -- request_key) — request_key uniqueness remains requester-scoped even
  -- though the advisory lock above is not, per correction (A)'s note that
  -- these are two independent scopes for two independent invariants.
  select * into v_by_key from public.qr_lifecycle_operations
    where requested_by_auth_user_id = p_requester_auth_user_id
      and operation_type = p_operation_type
      and request_key = p_request_key
    for update;

  if v_by_key.id is not null then
    v_intent_matches :=
      v_by_key.application_id = p_application_id
      and v_by_key.operation_type = p_operation_type
      and v_by_key.channel = p_channel
      and v_by_key.bulk_batch_id is not distinct from p_bulk_batch_id
      and v_by_key.reason_code is not distinct from p_reason_code
      and v_by_key.note is not distinct from p_note
      and v_by_key.expected_current_credential_id is not distinct from p_expected_current_credential_id
      and v_by_key.requested_by_auth_user_id = p_requester_auth_user_id
      and v_by_key.request_key = p_request_key;

    if not v_intent_matches then
      op := v_by_key;
      state := 'request_key_intent_conflict';
      return;
    end if;

    if v_by_key.status = 'consumed' then
      op := v_by_key;
      state := 'already_consumed';
      return;
    end if;

    if v_by_key.status = 'expired' then
      op := v_by_key;
      state := 'replay_expired';
      return;
    end if;

    if v_by_key.status = 'cancelled' then
      op := v_by_key;
      state := 'replay_cancelled';
      return;
    end if;

    -- status = 'pending': returned LOCKED and UNRESOLVED (correction B/C)
    -- — the caller performs the authoritative TTL recheck after every
    -- remaining required lock is held.
    op := v_by_key;
    state := 'matching_pending_candidate';
    return;
  end if;

  -- No row under THIS request_key. Correction (A): the domain-wide lookup
  -- below has NO requester filter at all — any pending operation for this
  -- (application_id, operation_type), regardless of who requested it, is
  -- a blocking candidate. Correction (B): FOR UPDATE, held for the rest
  -- of the caller's transaction — not merely read.
  select * into v_other_pending from public.qr_lifecycle_operations
    where application_id = p_application_id
      and operation_type = p_operation_type
      and status = 'pending'
      and request_key is distinct from p_request_key
    for update;

  if v_other_pending.id is not null then
    op := v_other_pending;
    state := 'other_pending_candidate';
    return;
  end if;

  state := 'no_existing_operation';
  return; -- caller proceeds to insert a new pending row under p_request_key
end;
$$;

revoke all on function public.reserve_or_reuse_qr_lifecycle_operation(
  text, uuid, uuid, uuid, text, uuid, text, text, uuid
) from public;
-- No grant to authenticated/anon — called only from within the four
-- reservation RPCs' own security-definer bodies.

-- SUB-PASS 2, FIFTH CORRECTION ROUND (item 3): shared blocker-resolution
-- logic, extracted so the normal other_pending_candidate path and the
-- named-index-violation recovery path never maintain two independently
-- drifting copies of the same sequence. Takes an ALREADY-LOCKED candidate
-- operation row (FOR UPDATE already held by the caller, either via
-- reserve_or_reuse's own domain-wide lookup or via the exception
-- handler's own recovery query) and the ALREADY-LOCKED application row,
-- and resolves the candidate to EXACTLY one of two dispositions:
--   'still_blocking'   — the candidate survived every check; caller
--                         returns another_operation_pending (with the
--                         leak-avoidance id rule applied by the CALLER,
--                         since only the caller knows the current
--                         requester's auth.uid()).
--   'terminalized'      — the candidate was cancelled or expired by this
--                         call; caller proceeds to insert/retry its own
--                         request.
-- Correction order enforced here (item 1, restated precisely): ineligible
-- application decided FIRST (no credential lock needed); otherwise the
-- credential lock is acquired BEFORE the TTL decision; TTL is checked
-- immediately after that lock, and an expired candidate is terminalized
-- as 'expired'/'ttl_expired' even if an active credential ALSO exists —
-- expiry wins. Only when the candidate is confirmed unexpired does an
-- existing active credential terminalize it as
-- 'cancelled'/'active_credential_already_exists'.
create function public.resolve_blocking_qr_lifecycle_operation(
  p_candidate public.qr_lifecycle_operations,
  p_app public.applications,
  out disposition text -- 'still_blocking' | 'terminalized'
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing_credential public.qr_credentials;
  v_transition_now timestamptz;
  v_check_now timestamptz;
begin
  if p_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- Credential lock BEFORE the TTL decision (position 6), per this
  -- round's corrected precedence.
  select * into v_existing_credential from public.qr_credentials
    where application_id = p_app.id and status = 'active' for update;

  -- TTL checked immediately after the credential lock — expiry wins over
  -- an active-credential conflict observed only after waiting for that
  -- lock.
  v_check_now := clock_timestamp();
  if p_candidate.expires_at <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  if v_existing_credential.id is not null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists',
        terminal_related_credential_id = v_existing_credential.id
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  disposition := 'still_blocking';
  return;
end;
$$;

revoke all on function public.resolve_blocking_qr_lifecycle_operation(
  public.qr_lifecycle_operations, public.applications
) from public;
-- No grant to authenticated/anon — called only from within reservation
-- RPCs' own security-definer bodies, which already hold every lock this
-- function itself requires (application row; the candidate row's own
-- lock was acquired by the caller before invoking this function).

-- ================= RESERVATION (participant self-service) =================
-- Lock order (§1.7a, refined this round): advisory reservation lock (inside
-- reserve_or_reuse) -> lifecycle operation -> application -> current
-- credential (not applicable to issuance).
--
-- CORRECTED this round: a matched pending operation is no longer trusted
-- and returned as 'already_pending' immediately — the application is
-- ALWAYS locked and re-validated afterward, for every reserve_or_reuse
-- `state`. If the application is no longer accepted, OR an active
-- credential now exists, and there WAS a matched pending operation, that
-- operation is explicitly cancelled (terminal_reason_code set, one
-- captured timestamp) rather than left dangling until its own TTL — a
-- stale pending operation must never simply be abandoned. No RAISE
-- follows any of these state-changing UPDATEs; every terminal transition
-- is followed by a plain RETURN so the transition commits.
-- SUB-PASS 2: p_request_key is now required — the browser/server must
-- generate one random UUID before the user confirms this action and pass
-- the SAME value on every retry of that confirmed action.
-- SUB-PASS 2, SECOND CORRECTION ROUND:
--
-- (5) First-request business outcomes are now DURABLE. The previous
-- version validated application eligibility and credential state BEFORE
-- ever inserting a row, and RAISED for the "no existing operation, but
-- application is not accepted" case rather than persisting anything — a
-- caller retrying that exact request_key after a lost response would
-- re-run the SAME validation against whatever the CURRENT (possibly
-- different) state is, rather than replaying the original outcome. Now:
-- for a brand-new request_key, the pending row is inserted FIRST (the
-- lifecycle trigger requires every INSERT to begin 'pending' — §1.7's own
-- trigger), then application eligibility and active-credential state are
-- checked under lock and the SAME row is transitioned to 'cancelled' with
-- the appropriate terminal_reason_code if either fails — never a bare
-- RAISE for these two expected business outcomes. A retry under the same
-- request_key later finds this now-cancelled row via
-- reserve_or_reuse_qr_lifecycle_operation's 'replay_cancelled' state and
-- replays the identical outcome, rather than re-evaluating against
-- possibly-changed future state.
--
-- (6) Ownership re-verified after the application lock. The initial
-- unlocked `select id from applications where applicant_id = auth.uid()`
-- is used ONLY to locate a candidate row for the advisory-lock domain —
-- it is explicitly re-verified (v_app.applicant_id = auth.uid()) after
-- FOR UPDATE, not trusted on its own.
--
-- SUB-PASS 2, FOURTH CORRECTION ROUND (supersedes the third round's
-- (B)/(C) — that round moved the TTL recheck to after the APPLICATION
-- lock, but left it BEFORE the CREDENTIAL lock, which is itself a lock
-- the outcome can wait on; this round moves it one step further, to
-- after EVERY lock the eventual outcome depends on):
--
-- Global lock order: 1) reservation-domain advisory lock (inside
-- reserve_or_reuse) 2) lifecycle operation row candidate, locked (inside
-- reserve_or_reuse) 3) bulk batch — not applicable, participant channel
-- 4) application row, FOR UPDATE 5) current active credential, FOR
-- UPDATE (issuance has none to "hold as current," but the existence
-- check itself is lock-guarded so its result is stable for the rest of
-- this transaction) THEN, and only then, a fresh clock_timestamp() and
-- the authoritative TTL decision.
--
-- (D) matching_pending_candidate: an ineligible application is decided
-- and persisted immediately after the application lock alone (no
-- credential lock is needed to prove application ineligibility). If the
-- application IS eligible, the credential lock is acquired, THEN
-- clock_timestamp() is captured, THEN the TTL decision is made — a
-- pending operation that expires while this RPC was waiting on the
-- credential lock is correctly caught here, rather than being missed by
-- an earlier, now-stale TTL check.
--
-- (E) other_pending_candidate is now FULLY resolved, not merely
-- TTL-checked: after the application lock, an ineligible application
-- immediately cancels the BLOCKING operation (application_ineligible) —
-- no credential lock needed for that determination either. Otherwise the
-- credential lock is acquired; if an active credential exists, the
-- blocking operation is cancelled (active_credential_already_exists,
-- terminal_related_credential_id set); THEN clock_timestamp() is
-- captured and the blocking operation's TTL is checked, expiring it if
-- lapsed. Only if the blocking operation survives ALL of these checks
-- (still pending, unexpired, application eligible, no active credential)
-- does this RPC return another_operation_pending — a stale blocker can
-- never indefinitely block the domain. Whenever the blocking operation IS
-- terminalized by any of these checks, THIS request continues processing
-- immediately (falls through to insert its own row and persist its own
-- outcome), in the SAME transaction, under the SAME advisory-lock hold —
-- no second round-trip required.
--
-- (D, restated for the freshly-inserted row) The identical discipline
-- applies to a row THIS call itself just inserted: ineligibility is
-- decided immediately after the application lock (no credential lock
-- needed); otherwise the credential lock is acquired, THEN
-- clock_timestamp() is captured, THEN this NEW row's own TTL is checked
-- — if this RPC's own insert-to-credential-lock window somehow exceeded
-- the 5-minute TTL (pathological, but not assumed impossible), the row
-- it just created is correctly expired rather than incorrectly returned
-- as reserved or cancelled for a since-observed active credential.
--
-- (6, leak avoidance) other_pending_candidate never returns the blocking
-- operation's id when it belongs to a DIFFERENT requester.
-- SUB-PASS 2, FIFTH CORRECTION ROUND: split into a private internal
-- implementation (accepts p_pending_ttl, never exposed to
-- authenticated/anon) and two thin callers — the real public RPC (fixed
-- at 5 minutes) and a test-only wrapper (test-only-setup.sql, short TTL,
-- service_role only, removed at teardown). The public authenticated
-- surface never accepts a caller-supplied TTL.
--
-- Also in this round: the matching_pending_candidate path's ordering is
-- corrected — a prior version acquired the credential lock before the
-- TTL decision (correct precedence) but then applied an
-- active_credential_already_exists conflict IMMEDIATELY upon finding a
-- credential, without checking TTL first — meaning an operation that had
-- ALREADY expired while waiting for the credential lock could still be
-- reported as active_credential_already_exists instead of
-- operation_expired. TTL must be checked immediately after the credential
-- lock and win if expired, exactly mirroring
-- resolve_blocking_qr_lifecycle_operation's own ordering (both paths now
-- share that exact sequence, though matching_pending_candidate cannot
-- literally call the shared resolver, since its RETURN outcomes differ
-- from a blocker's: operation_expired/already_pending/
-- active_credential_already_exists for the CALLER'S OWN operation, not
-- terminalized/still_blocking for someone else's).
create function public.request_my_qr_issuance_transactional_internal(
  p_request_key uuid,
  p_pending_ttl interval
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_application_id_candidate uuid;
  v_app public.applications;
  v_existing_credential public.qr_credentials;
  v_reservation record;
  v_resolution record;
  v_operation_id uuid;
  v_created_at timestamptz;
  v_check_now timestamptz;
  v_transition_now timestamptz;
  v_result public.qr_credential_lifecycle_result;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_request_key is null then raise exception 'request_key is required'; end if;
  if p_pending_ttl is null or p_pending_ttl <= interval '0' then
    raise exception 'p_pending_ttl must be a positive interval';
  end if;

  select id into v_application_id_candidate from public.applications where applicant_id = auth.uid();
  if v_application_id_candidate is null then raise exception 'No application found for this account'; end if;

  select * into v_reservation from public.reserve_or_reuse_qr_lifecycle_operation(
    'issue', v_application_id_candidate, auth.uid(), p_request_key, 'participant_self_service', null, null, null, null
  );

  if v_reservation.state = 'request_key_intent_conflict' then
    v_result.outcome := 'request_key_intent_conflict';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'already_consumed' then
    select * into v_existing_credential from public.qr_credentials
      where id = (v_reservation.op).resulting_credential_id;
    v_result.outcome := 'already_finalized';
    v_result.credential_id := v_existing_credential.id;
    v_result.status := 'active';
    v_result.issued_at := v_existing_credential.issued_at;
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_expired' then
    v_result.outcome := 'operation_expired';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_cancelled' then
    v_result.outcome := (v_reservation.op).terminal_reason_code;
    v_result.operation_id := (v_reservation.op).id;
    if (v_reservation.op).terminal_reason_code = 'active_credential_already_exists' then
      select * into v_existing_credential from public.qr_credentials
        where id = (v_reservation.op).terminal_related_credential_id;
      v_result.credential_id := v_existing_credential.id;
      v_result.status := 'active';
      v_result.issued_at := v_existing_credential.issued_at;
    end if;
    return v_result;
  end if;

  -- Position 5: lock the application, THEN re-verify ownership and
  -- eligibility.
  select * into v_app from public.applications where id = v_application_id_candidate for update;
  if v_app.id is null or v_app.applicant_id is distinct from auth.uid() then
    raise exception 'No application found for this account';
  end if;

  if v_reservation.state = 'other_pending_candidate' then
    -- Fifth correction round (item 3): delegates to the SAME shared
    -- resolver the exception-recovery path below also uses — one copy of
    -- the ineligible -> credential-lock -> TTL -> credential-conflict
    -- sequence, never two independently drifting versions.
    select * into v_resolution from public.resolve_blocking_qr_lifecycle_operation(v_reservation.op, v_app);
    if v_resolution.disposition = 'still_blocking' then
      v_result.outcome := 'another_operation_pending';
      if (v_reservation.op).requested_by_auth_user_id = auth.uid() then
        v_result.operation_id := (v_reservation.op).id;
      end if;
      return v_result;
    end if;
    -- 'terminalized' — falls through to the shared insert-and-resolve
    -- path below, identical to 'no_existing_operation'.
  elsif v_reservation.state = 'matching_pending_candidate' then
    if v_app.status <> 'accepted' then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
      where id = (v_reservation.op).id;
      v_result.outcome := 'application_ineligible';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    -- Position 6: credential lock BEFORE the TTL decision.
    select * into v_existing_credential from public.qr_credentials
      where application_id = v_app.id and status = 'active' for update;

    -- TTL checked IMMEDIATELY after the credential lock, and BEFORE
    -- applying any credential conflict — expiry wins (fifth correction
    -- round, item 1).
    v_check_now := clock_timestamp();
    if (v_reservation.op).expires_at <= v_check_now then
      update public.qr_lifecycle_operations
      set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
      where id = (v_reservation.op).id;
      v_result.outcome := 'operation_expired';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    if v_existing_credential.id is not null then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists',
          terminal_related_credential_id = v_existing_credential.id
      where id = (v_reservation.op).id;
      v_result.outcome := 'active_credential_already_exists';
      v_result.operation_id := (v_reservation.op).id;
      v_result.credential_id := v_existing_credential.id;
      v_result.status := v_existing_credential.status;
      v_result.issued_at := v_existing_credential.issued_at;
      return v_result;
    end if;

    v_result.outcome := 'already_pending';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  -- Shared insert-and-resolve path: reached for 'no_existing_operation',
  -- and for an 'other_pending_candidate' just terminalized above.
  v_created_at := clock_timestamp();
  begin
    insert into public.qr_lifecycle_operations (
      operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
      channel, request_key, created_at, expires_at
    ) values (
      'issue', v_app.id, auth.uid(), auth.uid(), 'participant_self_service',
      p_request_key, v_created_at, v_created_at + p_pending_ttl
    ) returning id into v_operation_id;
  exception
    when unique_violation then
      declare
        v_constraint_name text;
        v_conflicting public.qr_lifecycle_operations;
        v_conflicting_resolution record;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name <> 'qr_lifecycle_operations_one_pending_per_domain_idx' then
          raise;
        end if;
        -- Fifth correction round (item 3): the recovery path now runs the
        -- conflicting row through the SAME shared resolver, rather than
        -- unconditionally reporting another_operation_pending for a row
        -- that may itself already be expired/ineligible/superseded by an
        -- active credential.
        select * into v_conflicting from public.qr_lifecycle_operations
          where application_id = v_app.id and operation_type = 'issue' and status = 'pending'
          for update;
        if v_conflicting.id is null then
          -- Terminalized by someone else between the violation and this
          -- recovery query — retry the insert once, still under this
          -- function's own advisory-lock hold.
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, request_key, created_at, expires_at
          ) values (
            'issue', v_app.id, auth.uid(), auth.uid(), 'participant_self_service',
            p_request_key, v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        else
          select * into v_conflicting_resolution
            from public.resolve_blocking_qr_lifecycle_operation(v_conflicting, v_app);
          if v_conflicting_resolution.disposition = 'still_blocking' then
            v_result.outcome := 'another_operation_pending';
            if v_conflicting.requested_by_auth_user_id = auth.uid() then
              v_result.operation_id := v_conflicting.id;
            end if;
            return v_result;
          end if;
          -- 'terminalized' — retry the insert once, still under this
          -- function's own advisory-lock hold, then continue below.
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, request_key, created_at, expires_at
          ) values (
            'issue', v_app.id, auth.uid(), auth.uid(), 'participant_self_service',
            p_request_key, v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        end if;
      end;
  end;

  if v_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = v_operation_id;
    v_result.outcome := 'application_ineligible';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Position 6: credential lock BEFORE the TTL decision (restated for a
  -- row this call itself just inserted).
  select * into v_existing_credential from public.qr_credentials
    where application_id = v_app.id and status = 'active' for update;

  v_check_now := clock_timestamp();
  if v_created_at + p_pending_ttl <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = v_operation_id;
    v_result.outcome := 'operation_expired';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  if v_existing_credential.id is not null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists',
        terminal_related_credential_id = v_existing_credential.id
    where id = v_operation_id;
    v_result.outcome := 'active_credential_already_exists';
    v_result.operation_id := v_operation_id;
    v_result.credential_id := v_existing_credential.id;
    v_result.status := v_existing_credential.status;
    v_result.issued_at := v_existing_credential.issued_at;
    return v_result;
  end if;

  v_result.outcome := 'reserved';
  v_result.operation_id := v_operation_id;
  return v_result;
end;
$$;

revoke all on function public.request_my_qr_issuance_transactional_internal(uuid, interval) from public;
-- No grant to authenticated/anon — reachable only through the two
-- wrappers below, both of which fix or otherwise control p_pending_ttl.

-- Public, authenticated-facing wrapper — the ONLY entry point exposed to
-- real users. TTL is hardcoded; no caller, however privileged, can pass a
-- different value through this signature.
create function public.request_my_qr_issuance_transactional(
  p_request_key uuid
) returns public.qr_credential_lifecycle_result
language sql security definer set search_path = public, pg_temp as $$
  select public.request_my_qr_issuance_transactional_internal(p_request_key, interval '5 minutes');
$$;

revoke all on function public.request_my_qr_issuance_transactional(uuid) from public;
grant execute on function public.request_my_qr_issuance_transactional(uuid) to authenticated;

-- TEST-ONLY short-TTL wrapper — belongs in the future reservation-RPC
-- test file's own test-only-setup.sql (parallel to
-- tests/attendance/qr-credentials-lifecycle-trigger.test-only-setup.sql's
-- existing pattern: outside supabase/migrations/, local-only, torn down
-- after the suite), NOT in this production migration surface. Documented
-- here as the exact shape to use once that test file is written (deferred
-- — the reservation RPCs and finalizers are not yet complete). Calls the
-- SAME internal implementation the real 5-minute-fixed RPC calls, with a
-- short interval, so TTL-expiry-under-lock tests can run in seconds
-- rather than needing a real 5-minute wait.
--
--   create function public.test_only_request_my_qr_issuance_short_ttl(
--     p_request_key uuid,
--     p_pending_ttl interval
--   ) returns public.qr_credential_lifecycle_result
--   language sql security definer set search_path = public, pg_temp as $$
--     select public.request_my_qr_issuance_transactional_internal(p_request_key, p_pending_ttl);
--   $$;
--
--   revoke all on function public.test_only_request_my_qr_issuance_short_ttl(uuid, interval) from public, anon, authenticated;
--   grant execute on function public.test_only_request_my_qr_issuance_short_ttl(uuid, interval) to service_role;
--
-- Teardown: drop function if exists public.test_only_request_my_qr_issuance_short_ttl(uuid, interval);

-- ================= RESERVATION (staff individual/bulk) — APPROVED =================
-- SUB-PASS 2, this round's addition. Extends the approved participant
-- issuance/reissue foundation exactly — same request_key/dual-advisory-
-- lock protocol via reserve_or_reuse_qr_lifecycle_operation, same split
-- into a private internal implementation (accepts p_pending_ttl, never
-- exposed to authenticated/anon) and a thin public wrapper fixed at 5
-- minutes, same insert-first-then-validate durability discipline, same
-- UPDATE-then-RETURN (never UPDATE-then-RAISE) pattern.
--
-- Supersedes the older sketch immediately following this section (kept
-- only for historical reference — see the "SUPERSEDED" marker below); the
-- old sketch predates request_key entirely, calls
-- reserve_or_reuse_qr_lifecycle_operation with only 8 positional
-- arguments (the approved signature takes 9 — p_request_key is
-- positional argument 4), uses the outcome name 'pending_operation_conflict'
-- (never approved into the schema/vocabulary — the approved name is
-- 'request_key_intent_conflict'), pre-reads authoritative batch/
-- application/credential state with NO row lock before making
-- authorization/eligibility decisions (an unlocked `select ... from
-- qr_bulk_operation_batches ... for share` performed only AFTER an
-- earlier unlocked existence check, and an entirely UNLOCKED
-- `select ... from qr_credentials where status = 'active'` with no FOR
-- UPDATE at all), and never re-derives staff authorization or batch
-- availability for an already-existing pending operation at all.
--
-- A staff-issuance-specific blocker resolver
-- (resolve_blocking_qr_lifecycle_staff_issuance_operation) is introduced
-- alongside it — parameterized separately from both
-- resolve_blocking_qr_lifecycle_operation (participant issuance) and
-- resolve_blocking_qr_lifecycle_reissue_operation (participant reissue)
-- because staff issuance's decision tree includes two conditions neither
-- participant path has any equivalent for: the requester's staff role can
-- itself lapse between reservation and resolution (a participant's
-- identity has no analogous "role" to lose), and a staff_bulk operation's
-- authorizing batch can itself become unavailable (closed, expired,
-- wrong type, or reassigned) independently of the application/credential
-- state the participant resolvers already cover.
create function public.resolve_blocking_qr_lifecycle_staff_issuance_operation(
  p_candidate public.qr_lifecycle_operations,
  p_app public.applications,
  out disposition text -- 'still_blocking' | 'terminalized'
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller_role text;
  v_batch public.qr_bulk_operation_batches;
  v_existing_credential public.qr_credentials;
  v_transition_now timestamptz;
  v_check_now timestamptz;
begin
  -- 1. Requester authorization, re-verified against the CANDIDATE's own
  -- recorded requester (not the CURRENT caller of this resolver, who may
  -- be a different concurrent staff member entirely resolving someone
  -- else's stale blocker) — a candidate whose original requester has
  -- since lost the required role can never legitimately resolve to
  -- 'reserved', regardless of who is asking about it now.
  select role into v_caller_role from public.profiles where id = p_candidate.requested_by_auth_user_id;
  if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 2. Bulk-batch availability, only when this candidate is staff_bulk
  -- (bulk_batch_id is null for staff_individual, per
  -- qr_lifecycle_operations_bulk_batch_matches_channel — nothing to
  -- validate in that case).
  if p_candidate.channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches
      where id = p_candidate.bulk_batch_id for share;
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= clock_timestamp()
       or v_batch.intended_operation_type <> 'issue'
       or v_batch.created_by_auth_user_id is distinct from p_candidate.requested_by_auth_user_id
       or v_batch.created_by_profile_id is distinct from p_candidate.requested_by_profile_id
    then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = p_candidate.id;
      disposition := 'terminalized';
      return;
    end if;
  end if;

  -- 3. Application eligibility (no credential lock needed for this
  -- determination — mirrors both participant resolvers' identical
  -- precedence).
  if p_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 4. Credential lock BEFORE the TTL decision, matching every other
  -- resolver's precedence exactly.
  select * into v_existing_credential from public.qr_credentials
    where application_id = p_app.id and status = 'active' for update;

  -- 5. TTL checked immediately after the credential lock — expiry wins
  -- over every finding below, including a credential conflict.
  v_check_now := clock_timestamp();
  if p_candidate.expires_at <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 6. Active-credential conflict.
  if v_existing_credential.id is not null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists',
        terminal_related_credential_id = v_existing_credential.id
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  disposition := 'still_blocking';
  return;
end;
$$;

revoke all on function public.resolve_blocking_qr_lifecycle_staff_issuance_operation(
  public.qr_lifecycle_operations, public.applications
) from public;
-- No grant to authenticated/anon — called only from within
-- request_staff_qr_issuance_transactional_internal's own security-definer
-- body, which already holds every lock this function itself requires
-- (application row; the candidate row's own lock was acquired by the
-- caller before invoking this function; the batch row's FOR SHARE lock is
-- acquired inside this function itself, at its correct position in the
-- global lock order — batch, position 4, BEFORE application, position 5).

-- Global lock order (unchanged from the participant RPCs, restated for
-- staff issuance, now genuinely including the batch step no participant
-- path has):
--   1. request-key advisory lock (requester, operation_type, request_key)
--      — inside reserve_or_reuse_qr_lifecycle_operation.
--   2. reservation-domain advisory lock (application_id, operation_type)
--      — inside reserve_or_reuse_qr_lifecycle_operation.
--   3. lifecycle-operation row, by request_key or the domain's other
--      pending issue operation — inside reserve_or_reuse_qr_lifecycle_operation.
--   4. bulk batch, FOR SHARE, only for channel = 'staff_bulk' — locked
--      and fully revalidated (existence, status, expiry, type, ownership)
--      AFTER the operation lock and BEFORE the application lock.
--   5. application row, FOR UPDATE.
--   6. current active credential row, FOR UPDATE.
--   7. fresh clock_timestamp() and every authoritative TTL/authorization/
--      batch/eligibility decision, only after every lock above is held.
-- No authoritative application, batch, or credential state is ever read
-- before its corresponding lock in this order — every pre-lock read in
-- this function is used ONLY to shape the advisory-lock domain
-- (application id) or the reservation's immutable-intent channel
-- derivation (bulk batch id being null or not), never to make an
-- eligibility/authorization decision.
--
-- Immutable reservation intent (compared field-for-field by
-- reserve_or_reuse_qr_lifecycle_operation's existing intent-match logic —
-- no changes needed there): operation_type ('issue'), application_id,
-- requested_by_auth_user_id (auth.uid()), requested_by_profile_id
-- (== auth.uid(), the resolved staff profile), channel
-- ('staff_individual' or 'staff_bulk', derived deterministically from
-- whether p_bulk_batch_id is null), request_key, reason_code (the
-- normalized staff issuance reason), note (normalized), bulk_batch_id
-- (non-null only for staff_bulk), expected_current_credential_id (always
-- null — qr_lifecycle_operations_issue_has_no_expected_credential).
create function public.request_staff_qr_issuance_transactional_internal(
  p_request_key uuid,
  p_application_id uuid,
  p_issuance_reason_code text,
  p_issuance_note text,
  p_bulk_batch_id uuid,
  p_pending_ttl interval
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller public.profiles;
  v_normalized_note text;
  v_channel text;
  v_batch public.qr_bulk_operation_batches;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_reservation record;
  v_resolution record;
  v_operation_id uuid;
  v_created_at timestamptz;
  v_check_now timestamptz;
  v_transition_now timestamptz;
  v_result public.qr_credential_lifecycle_result;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_request_key is null then raise exception 'request_key is required'; end if;
  if p_application_id is null then raise exception 'application_id is required'; end if;
  if p_pending_ttl is null or p_pending_ttl <= interval '0' then
    raise exception 'p_pending_ttl must be a positive interval';
  end if;

  -- Authorization: derived from auth.uid() alone, never a parameter.
  -- Re-verified again under lock, against the CANDIDATE row's own
  -- recorded requester, inside the resolver above, for every already-
  -- existing pending operation this call might find — this initial check
  -- governs only whether THIS call itself may proceed to create/replay
  -- anything at all.
  select * into v_caller from public.profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role not in ('super_admin', 'program_attendance_manager') then
    raise exception 'Not authorized';
  end if;

  -- Reason-code/note validation, per §1.4's conditional rules for
  -- staff_individual/staff_bulk issuance: the code must be one of the
  -- four staff codes, never a participant or reissue code.
  -- 'staff_other' requires a non-empty trimmed note. Note normalization —
  -- identical rule applied once, reused for validation, the immutable-
  -- intent comparison, and persistence: null stays null; trimmed-empty
  -- text becomes null; non-empty text is stored trimmed.
  if p_issuance_reason_code is null or p_issuance_reason_code not in (
    'advance_badge_printing', 'participant_not_logged_in', 'bulk_event_preparation', 'staff_other'
  ) then
    raise exception 'A valid staff issuance reason code is required';
  end if;
  v_normalized_note := nullif(trim(p_issuance_note), '');
  if p_issuance_reason_code = 'staff_other' and v_normalized_note is null then
    raise exception 'A note is required when issuance reason is staff_other';
  end if;

  -- Channel is a deterministic function of p_bulk_batch_id alone — no
  -- lock or authoritative batch state is needed to compute it; this is
  -- purely a null-check, used ONLY to shape the reservation's immutable
  -- intent, never to authorize or validate anything about the batch
  -- itself (that happens under lock, at position 4, below).
  v_channel := case when p_bulk_batch_id is null then 'staff_individual' else 'staff_bulk' end;

  -- Positions 1-3: advisory-locked reservation lookup, unchanged shared
  -- helper — operation_type = 'issue', expected_current_credential_id
  -- always null for issuance.
  select * into v_reservation from public.reserve_or_reuse_qr_lifecycle_operation(
    'issue', p_application_id, auth.uid(), p_request_key, v_channel, p_bulk_batch_id,
    p_issuance_reason_code, v_normalized_note, null
  );

  if v_reservation.state = 'request_key_intent_conflict' then
    v_result.outcome := 'request_key_intent_conflict';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'already_consumed' then
    select * into v_current_active from public.qr_credentials
      where id = (v_reservation.op).resulting_credential_id;
    v_result.outcome := 'already_finalized';
    v_result.credential_id := v_current_active.id;
    v_result.status := v_current_active.status;
    v_result.issued_at := v_current_active.issued_at;
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_expired' then
    v_result.outcome := 'operation_expired';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_cancelled' then
    -- Identical replay of ANY previously-cancelled staff issuance
    -- reservation — including requester_no_longer_authorized and
    -- bulk_batch_unavailable — replays the STORED terminal reason,
    -- never re-evaluating current authorization, application, batch, or
    -- credential state for an already-terminal same-key operation.
    v_result.outcome := (v_reservation.op).terminal_reason_code;
    v_result.operation_id := (v_reservation.op).id;
    if (v_reservation.op).terminal_reason_code = 'active_credential_already_exists' then
      select * into v_current_active from public.qr_credentials
        where id = (v_reservation.op).terminal_related_credential_id;
      v_result.credential_id := v_current_active.id;
      v_result.status := v_current_active.status;
      v_result.issued_at := v_current_active.issued_at;
    end if;
    return v_result;
  end if;

  if v_reservation.state = 'other_pending_candidate' then
    -- Delegates to the staff-issuance-specific shared resolver — one copy
    -- of the authorization -> batch -> ineligible -> credential-lock ->
    -- TTL -> credential-conflict sequence, never duplicated between this
    -- path and the exception-recovery path below.
    select * into v_app from public.applications where id = p_application_id;
    select * into v_resolution from public.resolve_blocking_qr_lifecycle_staff_issuance_operation(v_reservation.op, v_app);
    if v_resolution.disposition = 'still_blocking' then
      v_result.outcome := 'another_operation_pending';
      if (v_reservation.op).requested_by_auth_user_id = auth.uid() then
        v_result.operation_id := (v_reservation.op).id;
      end if;
      return v_result;
    end if;
    -- 'terminalized' — falls through to the shared insert-and-resolve
    -- path below, identical to 'no_existing_operation'.
  elsif v_reservation.state = 'matching_pending_candidate' then
    -- Re-evaluate the SAME authoritative conditions the resolver checks,
    -- inline, returning THIS caller's own outcomes
    -- (already_pending/operation_expired/requester_no_longer_authorized/
    -- bulk_batch_unavailable/application_ineligible/
    -- active_credential_already_exists) rather than the resolver's
    -- generic still_blocking/terminalized pair — exactly mirroring both
    -- participant RPCs' identical matching_pending_candidate vs.
    -- other_pending_candidate distinction.
    declare
      v_caller_role text;
    begin
      select role into v_caller_role from public.profiles where id = (v_reservation.op).requested_by_auth_user_id;
      if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
        v_transition_now := clock_timestamp();
        update public.qr_lifecycle_operations
        set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
        where id = (v_reservation.op).id;
        v_result.outcome := 'requester_no_longer_authorized';
        v_result.operation_id := (v_reservation.op).id;
        return v_result;
      end if;
    end;

    if (v_reservation.op).channel = 'staff_bulk' then
      select * into v_batch from public.qr_bulk_operation_batches
        where id = (v_reservation.op).bulk_batch_id for share;
      if v_batch.id is null
         or v_batch.status <> 'active'
         or v_batch.expires_at <= clock_timestamp()
         or v_batch.intended_operation_type <> 'issue'
         or v_batch.created_by_auth_user_id is distinct from (v_reservation.op).requested_by_auth_user_id
         or v_batch.created_by_profile_id is distinct from (v_reservation.op).requested_by_profile_id
      then
        v_transition_now := clock_timestamp();
        update public.qr_lifecycle_operations
        set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
        where id = (v_reservation.op).id;
        v_result.outcome := 'bulk_batch_unavailable';
        v_result.operation_id := (v_reservation.op).id;
        return v_result;
      end if;
    end if;

    select * into v_app from public.applications where id = p_application_id for update;
    if v_app.id is null or v_app.status <> 'accepted' then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
      where id = (v_reservation.op).id;
      v_result.outcome := 'application_ineligible';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    select * into v_current_active from public.qr_credentials
      where application_id = v_app.id and status = 'active' for update;

    v_check_now := clock_timestamp();
    if (v_reservation.op).expires_at <= v_check_now then
      update public.qr_lifecycle_operations
      set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
      where id = (v_reservation.op).id;
      v_result.outcome := 'operation_expired';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    if v_current_active.id is not null then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists',
          terminal_related_credential_id = v_current_active.id
      where id = (v_reservation.op).id;
      v_result.outcome := 'active_credential_already_exists';
      v_result.operation_id := (v_reservation.op).id;
      v_result.credential_id := v_current_active.id;
      v_result.status := v_current_active.status;
      v_result.issued_at := v_current_active.issued_at;
      return v_result;
    end if;

    v_result.outcome := 'already_pending';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  -- ===================== 'no_existing_operation' path =====================
  -- (also reached for an 'other_pending_candidate' just terminalized
  -- above, which falls through here identically.)
  --
  -- Authoritative processing order, restated exactly as specified and
  -- implemented step-for-step below:
  --   1. create or reuse the durable lifecycle operation through the
  --      approved request-key protocol (already done above, at positions
  --      1-3 — shared by every state).
  --   2. lock and validate the bulk batch when applicable.
  --   3. lock the target application.
  --   4. lock/query the current active credential.
  --   5. capture a fresh timestamp.
  --   6. if the operation TTL elapsed while waiting, transition to
  --      expired/ttl_expired.
  --   7. if the requester is no longer authorized, cancel with
  --      requester_no_longer_authorized.
  --   8. if the bulk batch is unavailable, cancel with
  --      bulk_batch_unavailable.
  --   9. if the application is missing or no longer accepted, cancel with
  --      application_ineligible.
  --  10. if an active credential exists, cancel with
  --      active_credential_already_exists and persist
  --      terminal_related_credential_id.
  --  11. otherwise return reserved.
  --
  -- No operation row exists yet for THIS request on this path's early
  -- steps — an insert-first-then-validate discipline is used exactly like
  -- both participant RPCs, so every one of the above denials still leaves
  -- its own durable, queryable row rather than a no-row business outcome.
  v_created_at := clock_timestamp();
  begin
    insert into public.qr_lifecycle_operations (
      operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
      channel, bulk_batch_id, request_key, reason_code, note, created_at, expires_at
    ) values (
      'issue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
      p_request_key, p_issuance_reason_code, v_normalized_note, v_created_at, v_created_at + p_pending_ttl
    ) returning id into v_operation_id;
  exception
    when unique_violation then
      declare
        v_constraint_name text;
        v_conflicting public.qr_lifecycle_operations;
        v_conflicting_resolution record;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name <> 'qr_lifecycle_operations_one_pending_per_domain_idx' then
          raise;
        end if;
        select * into v_conflicting from public.qr_lifecycle_operations
          where application_id = p_application_id and operation_type = 'issue' and status = 'pending'
          for update;
        if v_conflicting.id is null then
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, bulk_batch_id, request_key, reason_code, note, created_at, expires_at
          ) values (
            'issue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
            p_request_key, p_issuance_reason_code, v_normalized_note, v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        else
          select * into v_app from public.applications where id = p_application_id;
          select * into v_conflicting_resolution
            from public.resolve_blocking_qr_lifecycle_staff_issuance_operation(v_conflicting, v_app);
          if v_conflicting_resolution.disposition = 'still_blocking' then
            v_result.outcome := 'another_operation_pending';
            if v_conflicting.requested_by_auth_user_id = auth.uid() then
              v_result.operation_id := v_conflicting.id;
            end if;
            return v_result;
          end if;
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, bulk_batch_id, request_key, reason_code, note, created_at, expires_at
          ) values (
            'issue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
            p_request_key, p_issuance_reason_code, v_normalized_note, v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        end if;
      end;
  end;

  -- Step 2: lock and validate the bulk batch, only for staff_bulk —
  -- position 4, BEFORE the application lock (position 5), per the global
  -- order.
  if v_channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches where id = p_bulk_batch_id for share;
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= clock_timestamp()
       or v_batch.intended_operation_type <> 'issue'
       or v_batch.created_by_auth_user_id is distinct from auth.uid()
       or v_batch.created_by_profile_id is distinct from v_caller.id
    then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = v_operation_id;
      v_result.outcome := 'bulk_batch_unavailable';
      v_result.operation_id := v_operation_id;
      return v_result;
    end if;
  end if;

  -- Step 3: lock the target application — position 5.
  select * into v_app from public.applications where id = p_application_id for update;

  -- Step 4: credential lock — position 6.
  select * into v_current_active from public.qr_credentials
    where application_id = p_application_id and status = 'active' for update;

  -- Step 5: fresh timestamp, captured only after every lock above.
  v_check_now := clock_timestamp();

  -- Step 6: TTL, checked first — expiry wins over every finding below.
  if v_created_at + p_pending_ttl <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = v_operation_id;
    v_result.outcome := 'operation_expired';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 7: requester authorization, re-verified under the full lock set
  -- (this call's own auth.uid() cannot itself have changed mid-call, but
  -- this mirrors the identical re-check performed for
  -- matching_pending_candidate/the blocker resolver, so the SAME
  -- authoritative condition is checked at the SAME logical point on every
  -- code path — no path is exempt from re-verifying it here).
  if v_caller.role not in ('super_admin', 'program_attendance_manager') then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
    where id = v_operation_id;
    v_result.outcome := 'requester_no_longer_authorized';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 8: bulk-batch availability was already fully validated at Step 2,
  -- above, BEFORE the application lock, per the global order — restated
  -- here only as the corresponding numbered step, no further action.

  -- Step 9: application eligibility.
  if v_app.id is null or v_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = v_operation_id;
    v_result.outcome := 'application_ineligible';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 10: active-credential conflict.
  if v_current_active.id is not null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists',
        terminal_related_credential_id = v_current_active.id
    where id = v_operation_id;
    v_result.outcome := 'active_credential_already_exists';
    v_result.operation_id := v_operation_id;
    v_result.credential_id := v_current_active.id;
    v_result.status := v_current_active.status;
    v_result.issued_at := v_current_active.issued_at;
    return v_result;
  end if;

  -- Step 11: every check has passed — the pending row remains genuinely
  -- reserved. Credential creation/revocation/replacement/encryption/
  -- display belongs only to the future issuance finalizer, never this
  -- reservation RPC.
  v_result.outcome := 'reserved';
  v_result.operation_id := v_operation_id;
  return v_result;
end;
$$;

revoke all on function public.request_staff_qr_issuance_transactional_internal(uuid, uuid, text, text, uuid, interval) from public;
-- No grant to authenticated/anon — reachable only through the public
-- wrapper below and a future test-only short-TTL wrapper, both of which
-- fix or otherwise control p_pending_ttl.

-- Public, authenticated-facing wrapper — the ONLY entry point exposed to
-- real staff users. TTL is hardcoded at 5 minutes, identical to both
-- participant RPCs; no caller, however privileged, can pass a different
-- value through this signature.
create function public.request_staff_qr_issuance_transactional(
  p_request_key uuid,
  p_application_id uuid,
  p_issuance_reason_code text,
  p_issuance_note text,
  p_bulk_batch_id uuid default null
) returns public.qr_credential_lifecycle_result
language sql security definer set search_path = public, pg_temp as $$
  select public.request_staff_qr_issuance_transactional_internal(
    p_request_key, p_application_id, p_issuance_reason_code, p_issuance_note, p_bulk_batch_id,
    interval '5 minutes'
  );
$$;

revoke all on function public.request_staff_qr_issuance_transactional(uuid, uuid, text, text, uuid) from public;
grant execute on function public.request_staff_qr_issuance_transactional(uuid, uuid, text, text, uuid) to authenticated;

-- TEST-ONLY short-TTL wrapper — belongs in this suite's own test-only
-- setup SQL (parallel to the participant issuance/reissue test-only
-- wrappers already established), NOT in this production migration
-- surface. Documented here as the exact shape used once written.
--
--   create function public.test_only_request_staff_qr_issuance_short_ttl(
--     p_request_key uuid,
--     p_application_id uuid,
--     p_issuance_reason_code text,
--     p_issuance_note text,
--     p_bulk_batch_id uuid,
--     p_pending_ttl interval,
--     p_waiter_tag text
--   ) returns public.qr_credential_lifecycle_result
--   language plpgsql security definer set search_path = public, pg_temp as $$
--   declare
--     v_result public.qr_credential_lifecycle_result;
--   begin
--     if p_waiter_tag is null or trim(p_waiter_tag) = '' then
--       raise exception 'test_only_request_staff_qr_issuance_short_ttl: p_waiter_tag is required';
--     end if;
--     perform set_config('application_name', p_waiter_tag, true);
--     select * into v_result from public.request_staff_qr_issuance_transactional_internal(
--       p_request_key, p_application_id, p_issuance_reason_code, p_issuance_note, p_bulk_batch_id, p_pending_ttl
--     );
--     return v_result;
--   end;
--   $$;
--
--   revoke all on function public.test_only_request_staff_qr_issuance_short_ttl(uuid, uuid, text, text, uuid, interval, text)
--     from public, anon, service_role;
--   grant execute on function public.test_only_request_staff_qr_issuance_short_ttl(uuid, uuid, text, text, uuid, interval, text)
--     to authenticated;
--
-- Teardown: drop function if exists public.test_only_request_staff_qr_issuance_short_ttl(uuid, uuid, text, text, uuid, interval, text);

-- ================= RESERVATION (staff force-reissue, individual/bulk) — APPROVED =================
-- SUB-PASS 2, this round's addition. Extends the approved reservation
-- foundation exactly — same request_key/dual-advisory-lock protocol via
-- reserve_or_reuse_qr_lifecycle_operation (unmodified, unchanged, no new
-- signature), same split into a private internal implementation (accepts
-- p_pending_ttl, never exposed to authenticated/anon) and a thin public
-- wrapper fixed at 5 minutes, same insert-first-then-validate durability
-- discipline, same UPDATE-then-RETURN (never UPDATE-then-RAISE) pattern.
--
-- A staff-reissue-specific blocker resolver
-- (resolve_blocking_qr_lifecycle_staff_reissue_operation) is introduced
-- alongside it — a NEW function, not a modification of either
-- resolve_blocking_qr_lifecycle_staff_issuance_operation (participant/
-- staff issuance's resolver, frozen, unchanged) or
-- resolve_blocking_qr_lifecycle_reissue_operation (participant reissue's
-- resolver, frozen, unchanged). It mirrors
-- resolve_blocking_qr_lifecycle_staff_issuance_operation's exact
-- authorization -> batch -> application -> credential-lock -> TTL
-- sequence and terminal-update/historical-replay discipline, but replaces
-- that resolver's final "active credential is itself the conflict" step
-- with resolve_blocking_qr_lifecycle_reissue_operation's own reissue-
-- specific credential semantics: an active credential is REQUIRED (its
-- ABSENCE is the terminal condition, 'no_active_credential'), and an
-- active credential that does not match the operation's own durable
-- expected_current_credential_id is ALSO terminal
-- ('expected_credential_changed') — mirroring the two independent
-- credential-state findings the participant reissue resolver already
-- established, now combined with staff issuance's authorization/batch
-- findings neither participant resolver has any equivalent for. Staff
-- reissue has no participant cooldown or rolling-rate-limit concept at
-- all (those are participant-self-service-only policies scoped by
-- channel = 'participant_self_service' in the cooldown/rate-limit
-- query itself — a staff_individual/staff_bulk row can never match that
-- filter, so no staff-specific carve-out is even needed there).
create function public.resolve_blocking_qr_lifecycle_staff_reissue_operation(
  p_candidate public.qr_lifecycle_operations,
  p_app public.applications,
  out disposition text -- 'still_blocking' | 'terminalized'
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller_role text;
  v_batch public.qr_bulk_operation_batches;
  v_existing_credential public.qr_credentials;
  v_transition_now timestamptz;
  v_check_now timestamptz;
begin
  -- 1. Requester authorization, re-verified against the CANDIDATE's own
  -- recorded requester — identical precedence and rationale to
  -- resolve_blocking_qr_lifecycle_staff_issuance_operation's own first
  -- step.
  select role into v_caller_role from public.profiles where id = p_candidate.requested_by_auth_user_id;
  if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 2. Bulk-batch availability, only when this candidate is staff_bulk.
  -- Identical shape to staff issuance's own batch check, EXCEPT
  -- intended_operation_type must be 'reissue', not 'issue' — an
  -- issue-typed batch can never authorize a reissue reservation.
  if p_candidate.channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches
      where id = p_candidate.bulk_batch_id for share;
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= clock_timestamp()
       or v_batch.intended_operation_type <> 'reissue'
       or v_batch.created_by_auth_user_id is distinct from p_candidate.requested_by_auth_user_id
       or v_batch.created_by_profile_id is distinct from p_candidate.requested_by_profile_id
    then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = p_candidate.id;
      disposition := 'terminalized';
      return;
    end if;
  end if;

  -- 3. Application eligibility (no credential lock needed for this
  -- determination — mirrors every other resolver's identical
  -- precedence).
  if p_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 4. Credential lock BEFORE the TTL decision, matching every other
  -- resolver's precedence exactly.
  select * into v_existing_credential from public.qr_credentials
    where application_id = p_app.id and status = 'active' for update;

  -- 5. TTL checked immediately after the credential lock — expiry wins
  -- over every credential-state finding below.
  v_check_now := clock_timestamp();
  if p_candidate.expires_at <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 6. Reissue-specific credential semantics (replaces staff issuance's
  -- "active credential is itself the conflict" step): a MISSING active
  -- credential is terminal.
  if v_existing_credential.id is null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'no_active_credential'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 7. An active credential exists but does not match the candidate's
  -- own durable expected_current_credential_id — also terminal.
  -- CORRECTED this round: terminal_related_credential_id is permitted
  -- ONLY for 'active_credential_already_exists' by the approved
  -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
  -- (§1.7) — it must remain null for 'expected_credential_changed'. The
  -- same narrow correction was applied to every occurrence of this exact
  -- pattern this same round, including finalize_qr_reissue_for_server.
  if v_existing_credential.id <> p_candidate.expected_current_credential_id then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed',
        terminal_related_credential_id = null
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  disposition := 'still_blocking';
  return;
end;
$$;

revoke all on function public.resolve_blocking_qr_lifecycle_staff_reissue_operation(
  public.qr_lifecycle_operations, public.applications
) from public;
-- No grant to authenticated/anon — called only from within
-- request_staff_qr_reissue_transactional_internal's own security-definer
-- body, which already holds every lock this function itself requires.

-- Global lock order (unchanged from staff issuance, restated for staff
-- reissue):
--   1. request-key advisory lock (requester, operation_type, request_key)
--      — inside reserve_or_reuse_qr_lifecycle_operation.
--   2. reservation-domain advisory lock (application_id, operation_type)
--      — inside reserve_or_reuse_qr_lifecycle_operation.
--   3. lifecycle-operation row, by request_key or the domain's other
--      pending reissue operation — inside reserve_or_reuse_qr_lifecycle_operation.
--   4. bulk batch, FOR SHARE, only for channel = 'staff_bulk' — locked
--      and fully revalidated AFTER the operation lock and BEFORE the
--      application lock.
--   5. application row, FOR UPDATE.
--   6. current active credential row, FOR UPDATE. No authoritative
--      current-credential pre-read occurs anywhere before this lock —
--      p_expected_current_credential_id is caller-supplied and compared
--      against the credential actually found active only AFTER this
--      lock is held, exactly like the participant reissue RPC.
--   7. fresh clock_timestamp() and every authoritative TTL/authorization/
--      batch/eligibility/credential decision, only after every lock
--      above is held.
--
-- Immutable reservation intent (compared field-for-field by
-- reserve_or_reuse_qr_lifecycle_operation's existing intent-match logic —
-- no changes needed there): operation_type ('reissue'), application_id,
-- requested_by_auth_user_id (auth.uid()), requested_by_profile_id
-- (== auth.uid(), the resolved staff profile), channel
-- ('staff_individual' or 'staff_bulk', derived deterministically from
-- whether p_bulk_batch_id is null), request_key, reason_code (the
-- normalized staff reissue reason), note (normalized), bulk_batch_id
-- (non-null only for staff_bulk), expected_current_credential_id
-- (caller-supplied, required non-null —
-- qr_lifecycle_operations_reissue_has_expected_credential).
create function public.request_staff_qr_reissue_transactional_internal(
  p_request_key uuid,
  p_application_id uuid,
  p_expected_current_credential_id uuid,
  p_reissue_reason_code text,
  p_reissue_note text,
  p_bulk_batch_id uuid,
  p_pending_ttl interval
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller public.profiles;
  v_normalized_note text;
  v_channel text;
  v_batch public.qr_bulk_operation_batches;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_reservation record;
  v_resolution record;
  v_operation_id uuid;
  v_created_at timestamptz;
  v_check_now timestamptz;
  v_transition_now timestamptz;
  v_result public.qr_credential_lifecycle_result;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_request_key is null then raise exception 'request_key is required'; end if;
  if p_application_id is null then raise exception 'application_id is required'; end if;
  if p_expected_current_credential_id is null then raise exception 'expected_current_credential_id is required'; end if;
  if p_pending_ttl is null or p_pending_ttl <= interval '0' then
    raise exception 'p_pending_ttl must be a positive interval';
  end if;

  -- Authorization: derived from auth.uid() alone, never a parameter.
  -- Re-verified again under lock, against the CANDIDATE row's own
  -- recorded requester, inside the resolver above, for every already-
  -- existing pending operation this call might find.
  select * into v_caller from public.profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role not in ('super_admin', 'program_attendance_manager') then
    raise exception 'Not authorized';
  end if;

  -- Reason-code/note validation, per §1.4's conditional rules for staff
  -- force-reissue: the code must be one of the four staff reissue codes,
  -- never a participant code. 'staff_other' requires a non-empty trimmed
  -- note. Note normalization — identical rule applied once, reused for
  -- validation, the immutable-intent comparison, and persistence: null
  -- stays null; trimmed-empty text becomes null; non-empty text is
  -- stored trimmed.
  if p_reissue_reason_code is null or p_reissue_reason_code not in (
    'staff_assisted_recovery', 'suspected_compromise', 'administrative_correction', 'staff_other'
  ) then
    raise exception 'A valid staff reissue reason code is required';
  end if;
  v_normalized_note := nullif(trim(p_reissue_note), '');
  if p_reissue_reason_code = 'staff_other' and v_normalized_note is null then
    raise exception 'A note is required when reissue reason is staff_other';
  end if;

  -- If p_expected_current_credential_id cannot possibly satisfy
  -- qr_lifecycle_operations_expected_credential_fkey's composite
  -- (id, application_id) target — i.e. it does not identify ANY
  -- qr_credentials row belonging to THIS application, active or not —
  -- this is invalid input, rejected before any operation is ever
  -- created, exactly mirroring the participant reissue RPC's identical
  -- check. A credential that belongs to this application but is no
  -- longer active remains legal immutable intent and must produce the
  -- durable expected_credential_changed outcome via a real operation
  -- row, never an input-validation exception.
  if not exists (
    select 1 from public.qr_credentials
    where id = p_expected_current_credential_id and application_id = p_application_id
  ) then
    raise exception 'expected_current_credential_id does not identify a credential belonging to this application';
  end if;

  -- Channel is a deterministic function of p_bulk_batch_id alone — no
  -- lock or authoritative batch state is needed to compute it.
  v_channel := case when p_bulk_batch_id is null then 'staff_individual' else 'staff_bulk' end;

  -- Positions 1-3: advisory-locked reservation lookup, unchanged shared
  -- helper — operation_type = 'reissue'.
  select * into v_reservation from public.reserve_or_reuse_qr_lifecycle_operation(
    'reissue', p_application_id, auth.uid(), p_request_key, v_channel, p_bulk_batch_id,
    p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id
  );

  if v_reservation.state = 'request_key_intent_conflict' then
    v_result.outcome := 'request_key_intent_conflict';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'already_consumed' then
    select * into v_current_active from public.qr_credentials
      where id = (v_reservation.op).resulting_credential_id;
    v_result.outcome := 'already_finalized';
    v_result.credential_id := v_current_active.id;
    v_result.status := v_current_active.status;
    v_result.issued_at := v_current_active.issued_at;
    v_result.replaced_at := v_current_active.replaced_at;
    v_result.revoked_at := v_current_active.revoked_at;
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_expired' then
    v_result.outcome := 'operation_expired';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_cancelled' then
    -- Identical replay of ANY previously-cancelled staff reissue
    -- reservation — including requester_no_longer_authorized,
    -- bulk_batch_unavailable, no_active_credential, and
    -- expected_credential_changed — replays the STORED terminal reason,
    -- never re-evaluating current role, batch, application, or
    -- credential state for an already-terminal same-key operation.
    v_result.outcome := (v_reservation.op).terminal_reason_code;
    v_result.operation_id := (v_reservation.op).id;
    if (v_reservation.op).terminal_reason_code = 'expected_credential_changed' then
      select * into v_current_active from public.qr_credentials
        where id = (v_reservation.op).terminal_related_credential_id;
      v_result.credential_id := v_current_active.id;
      v_result.status := v_current_active.status;
      v_result.issued_at := v_current_active.issued_at;
    end if;
    return v_result;
  end if;

  if v_reservation.state = 'other_pending_candidate' then
    -- Delegates to the staff-reissue-specific shared resolver.
    select * into v_app from public.applications where id = p_application_id;
    select * into v_resolution from public.resolve_blocking_qr_lifecycle_staff_reissue_operation(v_reservation.op, v_app);
    if v_resolution.disposition = 'still_blocking' then
      v_result.outcome := 'another_operation_pending';
      if (v_reservation.op).requested_by_auth_user_id = auth.uid() then
        v_result.operation_id := (v_reservation.op).id;
      end if;
      return v_result;
    end if;
    -- 'terminalized' — falls through to the shared insert-and-resolve
    -- path below, identical to 'no_existing_operation'.
  elsif v_reservation.state = 'matching_pending_candidate' then
    -- Re-evaluate the SAME authoritative conditions the resolver checks,
    -- inline, returning THIS caller's own outcomes. No participant
    -- cooldown or rolling-rate-limit check applies anywhere on this
    -- path.
    declare
      v_caller_role text;
    begin
      select role into v_caller_role from public.profiles where id = (v_reservation.op).requested_by_auth_user_id;
      if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
        v_transition_now := clock_timestamp();
        update public.qr_lifecycle_operations
        set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
        where id = (v_reservation.op).id;
        v_result.outcome := 'requester_no_longer_authorized';
        v_result.operation_id := (v_reservation.op).id;
        return v_result;
      end if;
    end;

    if (v_reservation.op).channel = 'staff_bulk' then
      select * into v_batch from public.qr_bulk_operation_batches
        where id = (v_reservation.op).bulk_batch_id for share;
      if v_batch.id is null
         or v_batch.status <> 'active'
         or v_batch.expires_at <= clock_timestamp()
         or v_batch.intended_operation_type <> 'reissue'
         or v_batch.created_by_auth_user_id is distinct from (v_reservation.op).requested_by_auth_user_id
         or v_batch.created_by_profile_id is distinct from (v_reservation.op).requested_by_profile_id
      then
        v_transition_now := clock_timestamp();
        update public.qr_lifecycle_operations
        set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
        where id = (v_reservation.op).id;
        v_result.outcome := 'bulk_batch_unavailable';
        v_result.operation_id := (v_reservation.op).id;
        return v_result;
      end if;
    end if;

    select * into v_app from public.applications where id = p_application_id for update;
    if v_app.id is null or v_app.status <> 'accepted' then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
      where id = (v_reservation.op).id;
      v_result.outcome := 'application_ineligible';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    select * into v_current_active from public.qr_credentials
      where application_id = v_app.id and status = 'active' for update;

    v_check_now := clock_timestamp();
    if (v_reservation.op).expires_at <= v_check_now then
      update public.qr_lifecycle_operations
      set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
      where id = (v_reservation.op).id;
      v_result.outcome := 'operation_expired';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    if v_current_active.id is null then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'no_active_credential'
      where id = (v_reservation.op).id;
      v_result.outcome := 'no_active_credential';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    if v_current_active.id <> (v_reservation.op).expected_current_credential_id then
      v_transition_now := clock_timestamp();
      -- CORRECTED this round: terminal_related_credential_id is permitted
      -- ONLY for 'active_credential_already_exists' by the approved
      -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
      -- (§1.7) — it must remain null for 'expected_credential_changed',
      -- and the returned result carries only the stable outcome name, no
      -- credential_id/status/issued_at. The same narrow correction was
      -- applied to finalize_qr_reissue_for_server and every other
      -- occurrence of this exact pattern this same round.
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed',
          terminal_related_credential_id = null
      where id = (v_reservation.op).id;
      v_result.outcome := 'expected_credential_changed';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    v_result.outcome := 'already_pending';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  -- ===================== 'no_existing_operation' path =====================
  -- (also reached for an 'other_pending_candidate' just terminalized
  -- above, which falls through here identically.)
  --
  -- Authoritative processing order:
  --   1. create or reuse the durable lifecycle operation through the
  --      approved request-key protocol (already done above).
  --   2. lock and validate the bulk batch when applicable.
  --   3. lock the target application.
  --   4. lock/query the current active credential.
  --   5. capture a fresh timestamp.
  --   6. TTL precedence after every required lock.
  --   7. if the requester is no longer authorized, cancel with
  --      requester_no_longer_authorized.
  --   8. if the bulk batch is unavailable, cancel with
  --      bulk_batch_unavailable.
  --   9. if the application is missing or no longer accepted, cancel with
  --      application_ineligible.
  --  10. if no active credential exists, cancel with no_active_credential.
  --  11. if the active credential differs from expected, cancel with
  --      expected_credential_changed.
  --  12. otherwise return reserved.
  v_created_at := clock_timestamp();
  begin
    insert into public.qr_lifecycle_operations (
      operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
      channel, bulk_batch_id, request_key, reason_code, note, expected_current_credential_id, created_at, expires_at
    ) values (
      'reissue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
      p_request_key, p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id,
      v_created_at, v_created_at + p_pending_ttl
    ) returning id into v_operation_id;
  exception
    when unique_violation then
      declare
        v_constraint_name text;
        v_conflicting public.qr_lifecycle_operations;
        v_conflicting_resolution record;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name <> 'qr_lifecycle_operations_one_pending_per_domain_idx' then
          raise;
        end if;
        select * into v_conflicting from public.qr_lifecycle_operations
          where application_id = p_application_id and operation_type = 'reissue' and status = 'pending'
          for update;
        if v_conflicting.id is null then
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, bulk_batch_id, request_key, reason_code, note, expected_current_credential_id, created_at, expires_at
          ) values (
            'reissue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
            p_request_key, p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id,
            v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        else
          select * into v_app from public.applications where id = p_application_id;
          select * into v_conflicting_resolution
            from public.resolve_blocking_qr_lifecycle_staff_reissue_operation(v_conflicting, v_app);
          if v_conflicting_resolution.disposition = 'still_blocking' then
            v_result.outcome := 'another_operation_pending';
            if v_conflicting.requested_by_auth_user_id = auth.uid() then
              v_result.operation_id := v_conflicting.id;
            end if;
            return v_result;
          end if;
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, bulk_batch_id, request_key, reason_code, note, expected_current_credential_id, created_at, expires_at
          ) values (
            'reissue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
            p_request_key, p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id,
            v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        end if;
      end;
  end;

  -- Step 2: lock and validate the bulk batch, only for staff_bulk —
  -- position 4, BEFORE the application lock (position 5).
  if v_channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches where id = p_bulk_batch_id for share;
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= clock_timestamp()
       or v_batch.intended_operation_type <> 'reissue'
       or v_batch.created_by_auth_user_id is distinct from auth.uid()
       or v_batch.created_by_profile_id is distinct from v_caller.id
    then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = v_operation_id;
      v_result.outcome := 'bulk_batch_unavailable';
      v_result.operation_id := v_operation_id;
      return v_result;
    end if;
  end if;

  -- Step 3: lock the target application — position 5.
  select * into v_app from public.applications where id = p_application_id for update;

  -- Step 4: credential lock — position 6. No authoritative pre-read of
  -- the current credential occurs anywhere above this line.
  select * into v_current_active from public.qr_credentials
    where application_id = p_application_id and status = 'active' for update;

  -- Step 5: fresh timestamp, captured only after every lock above.
  v_check_now := clock_timestamp();

  -- Step 6: TTL, checked first — expiry wins over every finding below.
  if v_created_at + p_pending_ttl <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = v_operation_id;
    v_result.outcome := 'operation_expired';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 7: requester authorization, re-verified under the full lock
  -- set.
  if v_caller.role not in ('super_admin', 'program_attendance_manager') then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
    where id = v_operation_id;
    v_result.outcome := 'requester_no_longer_authorized';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 8: bulk-batch availability was already fully validated at Step
  -- 2, above, BEFORE the application lock — restated here only as the
  -- corresponding numbered step, no further action.

  -- Step 9: application eligibility.
  if v_app.id is null or v_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = v_operation_id;
    v_result.outcome := 'application_ineligible';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 10: active-credential existence.
  if v_current_active.id is null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'no_active_credential'
    where id = v_operation_id;
    v_result.outcome := 'no_active_credential';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 11: expected-credential match. CORRECTED this round:
  -- terminal_related_credential_id is permitted ONLY for
  -- 'active_credential_already_exists' by the approved
  -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
  -- (§1.7) — it must remain null here, and the returned result carries
  -- only the stable outcome name, no credential_id/status/issued_at.
  if v_current_active.id <> p_expected_current_credential_id then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed',
        terminal_related_credential_id = null
    where id = v_operation_id;
    v_result.outcome := 'expected_credential_changed';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 12: every check has passed — the pending row remains genuinely
  -- reserved. The currently active credential remains completely
  -- unchanged. Credential creation/revocation/replacement/encryption/
  -- display belongs only to the future reissue finalizer, never this
  -- reservation RPC — including replaced_by, which the finalizer alone
  -- writes on the OLD credential, set to the staff profile that
  -- ultimately finalizes the reissue (not necessarily this reservation's
  -- own requester, since reservation and finalization are two separate
  -- steps, matching every other RPC pair in this design).
  v_result.outcome := 'reserved';
  v_result.operation_id := v_operation_id;
  return v_result;
end;
$$;

revoke all on function public.request_staff_qr_reissue_transactional_internal(uuid, uuid, uuid, text, text, uuid, interval) from public;
-- No grant to authenticated/anon — reachable only through the public
-- wrapper below and a future test-only short-TTL wrapper, both of which
-- fix or otherwise control p_pending_ttl.

-- Public, authenticated-facing wrapper — the ONLY entry point exposed to
-- real staff users for force-reissue. TTL is hardcoded at 5 minutes,
-- identical to every other approved reservation RPC; no caller, however
-- privileged, can pass a different value through this signature.
create function public.request_staff_qr_reissue_transactional(
  p_request_key uuid,
  p_application_id uuid,
  p_expected_current_credential_id uuid,
  p_reissue_reason_code text,
  p_reissue_note text,
  p_bulk_batch_id uuid default null
) returns public.qr_credential_lifecycle_result
language sql security definer set search_path = public, pg_temp as $$
  select public.request_staff_qr_reissue_transactional_internal(
    p_request_key, p_application_id, p_expected_current_credential_id, p_reissue_reason_code, p_reissue_note, p_bulk_batch_id,
    interval '5 minutes'
  );
$$;

revoke all on function public.request_staff_qr_reissue_transactional(uuid, uuid, uuid, text, text, uuid) from public;
grant execute on function public.request_staff_qr_reissue_transactional(uuid, uuid, uuid, text, text, uuid) to authenticated;

-- TEST-ONLY short-TTL wrapper — belongs in this suite's own test-only
-- setup SQL, NOT in this production migration surface. Documented here
-- as the exact shape used once written.
--
--   create function public.test_only_request_staff_qr_reissue_short_ttl(
--     p_request_key uuid,
--     p_application_id uuid,
--     p_expected_current_credential_id uuid,
--     p_reissue_reason_code text,
--     p_reissue_note text,
--     p_bulk_batch_id uuid,
--     p_pending_ttl interval,
--     p_waiter_tag text
--   ) returns public.qr_credential_lifecycle_result
--   language plpgsql security definer set search_path = public, pg_temp as $$
--   declare
--     v_result public.qr_credential_lifecycle_result;
--   begin
--     if p_waiter_tag is null or trim(p_waiter_tag) = '' then
--       raise exception 'test_only_request_staff_qr_reissue_short_ttl: p_waiter_tag is required';
--     end if;
--     perform set_config('application_name', p_waiter_tag, true);
--     select * into v_result from public.request_staff_qr_reissue_transactional_internal(
--       p_request_key, p_application_id, p_expected_current_credential_id, p_reissue_reason_code, p_reissue_note, p_bulk_batch_id, p_pending_ttl
--     );
--     return v_result;
--   end;
--   $$;
--
--   revoke all on function public.test_only_request_staff_qr_reissue_short_ttl(uuid, uuid, uuid, text, text, uuid, interval, text)
--     from public, anon, service_role;
--   grant execute on function public.test_only_request_staff_qr_reissue_short_ttl(uuid, uuid, uuid, text, text, uuid, interval, text)
--     to authenticated;
--
-- Teardown: drop function if exists public.test_only_request_staff_qr_reissue_short_ttl(uuid, uuid, uuid, text, text, uuid, interval, text);

-- ================= FINALIZATION — issuance (service-role only) — APPROVED =================
-- SUB-PASS 2, this round's addition. Consumes a 'pending' issuance
-- operation (participant self-service, staff individual, or staff bulk —
-- all three approved reservation RPCs share this ONE finalizer, since
-- nothing about finalization differs by channel except which
-- issuance_channel/issuance_reason_code/issuance_note values the
-- operation itself already carries, durably, from reservation time) and
-- performs the actual `qr_credentials` write — the step no reservation
-- RPC is permitted to perform. `service_role`-only: no `authenticated`,
-- `anon`, participant, or staff browser session can ever call this
-- directly; Node's server-side code is the only caller, using the
-- `service_role` client, only after a reservation RPC has already
-- returned `outcome = 'reserved'` and only after Node has itself
-- generated the credential UUID and encrypted the token client-side of
-- the database trust boundary (§5.1's own opening rationale — the
-- database can never verify a client-supplied ciphertext's GCM
-- authentication tag, so cryptographic material is generated ONLY here,
-- server-side, after reservation succeeds, never accepted from any
-- browser session at any point in this whole design).
--
-- ONE approved signature — no overload. Every input is either an opaque
-- identifier (operation id, credential id) or already-encrypted/hashed
-- material (token hash, ciphertext) — never plaintext, never a key,
-- never a nonce, never a fingerprint. The function computes its own
-- fingerprint internally and never returns it.
--
-- Lock order (CORRECTED this round — five positions, was incorrectly four):
--   1. lifecycle operation row, FOR UPDATE — locked and inspected FIRST,
--      before any other row; the operation is the authoritative
--      idempotency record, not qr_credentials. An EARLY TTL check runs
--      immediately after this lock (see the two-stage TTL note below) —
--      an already-expired operation returns before any further lock is
--      ever taken.
--   2. durable bulk-batch row, FOR SHARE, ONLY when channel = 'staff_bulk'
--      — locked immediately after the operation lock (and the early TTL
--      check), BEFORE the application lock. CORRECTED this round: the
--      previous version of this function took this FOR SHARE lock much
--      later (after BOTH the application FOR UPDATE and the credential
--      FOR UPDATE locks were already held, and after the authoritative
--      v_now timestamp had already been captured) — a plain, late batch
--      read does not protect the finalization decision from a real race:
--      (1) finalizer reads the batch as active late in its own flow;
--      (2) a concurrent transaction cancels or completes that SAME batch
--      in between the read and this function's own commit; (3) this
--      finalizer proceeds to issue a credential authorized by a batch
--      that is no longer valid by the time the transaction actually
--      commits. Taking FOR SHARE on the batch row EARLY — immediately
--      after the operation lock, in this exact position — and holding it
--      for the REMAINDER of the transaction closes this: any concurrent
--      transaction attempting to transition the batch to 'completed'/
--      'cancelled' (both of which require locking the row for their own
--      UPDATE) now blocks behind this finalizer's FOR SHARE hold until
--      this transaction commits or rolls back, so the batch is
--      GUARANTEED to remain in the exact state this finalizer observed
--      for the entire remaining duration of the finalization — never
--      merely "was valid at the moment of an early, unprotected read."
--      Locking the batch here does NOT mean its business outcome
--      (bulk_batch_unavailable) is decided here — the DECISION precedence
--      (TTL -> application -> requester-authorization -> batch ->
--      credential-conflict, restated in the function body below) is
--      independent of lock order and remains exactly as previously
--      approved; only the LOCK itself moves earlier, to close the race.
--   3. application row, FOR UPDATE — reached for every genuinely
--      'pending' operation still unexpired after the early TTL check
--      (for staff_bulk, the batch is already locked by this point, but
--      not yet evaluated for validity).
--   4. current active credential row, FOR UPDATE — same application-
--      scoped active-credential lock every reservation RPC already uses.
--   5. selected encryption-key registry row, FOR SHARE — via
--      is_encryption_key_version_active(), which itself takes this exact
--      lock (§1.6, corrected in an earlier round to close the unlocked-
--      read race); not re-implemented here, reused as the single source
--      of truth for "is this key version currently active" everywhere in
--      this design.
-- No row is ever locked before the lifecycle operation; no authoritative
-- batch/application/credential/key state is ever read before its own
-- corresponding lock in this exact order. This preserves the already-
-- approved RELATIVE lock order used by every reservation RPC: operation
-- before batch, and batch before application and credential.
--
-- TWO-STAGE TTL CHECK: an EARLY check runs immediately after the
-- operation lock (position 1), before any further lock is taken — an
-- already-expired operation never touches the batch/application/
-- credential locks at all. A SECOND, authoritative recheck runs again
-- after every required lock (through position 4) is held, since this
-- call's own wait on those locks can itself consume enough time for the
-- operation to expire in between the two checks. The second check is the
-- one that actually governs decision precedence — it remains decision 1
-- of 5, still winning over every other business outcome, exactly as
-- previously approved.
create function public.finalize_qr_issuance_for_server(
  p_operation_id uuid,
  p_credential_id uuid,
  p_token_hash bytea,
  p_token_ciphertext bytea,
  p_token_version smallint,
  p_encryption_key_version smallint
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_op public.qr_lifecycle_operations;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_caller_role text;
  v_batch public.qr_bulk_operation_batches;
  v_key_is_active boolean;
  v_now timestamptz;
  v_transition_now timestamptz;
  v_fingerprint bytea;
  v_existing_credential public.qr_credentials;
  v_result public.qr_credential_lifecycle_result;
begin
  -- Input-shape validation BEFORE any lock is taken — malformed input is
  -- rejected as an exception, never represented as a lifecycle-result
  -- outcome, exactly mirroring every reservation RPC's own discipline.
  if p_operation_id is null then raise exception 'operation_id is required'; end if;
  if p_credential_id is null then raise exception 'credential_id is required'; end if;
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'token_hash must be exactly 32 bytes';
  end if;
  if p_token_ciphertext is null or octet_length(p_token_ciphertext) <> 61 then
    raise exception 'token_ciphertext must be exactly 61 bytes';
  end if;
  if get_byte(p_token_ciphertext, 0) <> 1 then
    raise exception 'Unsupported ciphertext envelope version';
  end if;
  if p_token_version is null or p_token_version not between 1 and 32767 then
    raise exception 'Invalid token_version';
  end if;
  if p_encryption_key_version is null or p_encryption_key_version not between 1 and 32767 then
    raise exception 'Invalid encryption_key_version';
  end if;

  -- Position 1: lifecycle operation row, FOR UPDATE, locked and
  -- inspected FIRST, before any other row.
  select * into v_op from public.qr_lifecycle_operations where id = p_operation_id for update;
  if v_op.id is null then raise exception 'Lifecycle operation not found'; end if;

  -- Historical states handled FIRST, before any further lock —
  -- 'consumed'/'expired'/'cancelled' are all fully resolved by the
  -- operation row alone.
  if v_op.status = 'consumed' then
    -- Idempotent replay: recompute the SAME canonical fingerprint from
    -- THIS call's supplied inputs and compare against the durably stored
    -- one — never re-derived from the current qr_credentials row.
    -- CORRECTED this round: the replayed result itself must ALSO never be
    -- derived from the current qr_credentials row — a resulting credential
    -- may later become revoked or replaced, and exact finalizer replay
    -- must not change because of that later lifecycle transition. Every
    -- field returned here comes exclusively from the durable
    -- qr_lifecycle_operations row: credential_id from
    -- resulting_credential_id, status hardcoded to 'active' (the state at
    -- the successful finalization transition, never re-queried), and
    -- issued_at from finalized_at (guaranteed equal to the credential's
    -- own issued_at at the moment of that same transition). This branch
    -- no longer depends on the resulting credential row still being
    -- queryable, its current status, its ciphertext, its current
    -- encryption-key version, or any later revocation/replacement field.
    v_fingerprint := public.compute_qr_finalization_fingerprint(
      'issue', p_credential_id, p_token_hash, p_token_version, p_encryption_key_version, p_token_ciphertext
    );
    if v_fingerprint = v_op.finalization_fingerprint and p_credential_id = v_op.resulting_credential_id then
      v_result.outcome := 'already_finalized';
      v_result.credential_id := v_op.resulting_credential_id;
      v_result.status := 'active';
      v_result.issued_at := v_op.finalized_at;
      return v_result;
    end if;
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  if v_op.status = 'expired' then
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  if v_op.status = 'cancelled' then
    -- Replay the durable terminal outcome without re-evaluating current
    -- state — identical discipline to every reservation RPC's own
    -- replay_cancelled path.
    v_result.outcome := v_op.terminal_reason_code;
    if v_op.terminal_reason_code = 'active_credential_already_exists' then
      select * into v_existing_credential from public.qr_credentials where id = v_op.terminal_related_credential_id;
      v_result.credential_id := v_existing_credential.id;
      v_result.status := v_existing_credential.status;
      v_result.issued_at := v_existing_credential.issued_at;
    end if;
    return v_result;
  end if;

  if v_op.status <> 'pending' then
    -- Unsupported/unknown status — never guess. Same safe conflict
    -- outcome finalizers already use for an unrecognized state.
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  -- Pending-operation shape checks: this finalizer handles ISSUANCE
  -- only. A reissue operation reaching this function would be a caller
  -- bug (Node calling the wrong finalizer for the operation's own
  -- recorded type) — rejected as an exception, not a lifecycle outcome,
  -- since it can never legitimately happen through the approved
  -- Node-side flow.
  if v_op.operation_type <> 'issue' then
    raise exception 'finalize_qr_issuance_for_server called for a non-issue operation';
  end if;
  if v_op.expected_current_credential_id is not null then
    raise exception 'issuance operation unexpectedly carries a non-null expected_current_credential_id';
  end if;
  if v_op.channel not in ('participant_self_service', 'staff_individual', 'staff_bulk') then
    raise exception 'issuance operation carries an unrecognized channel';
  end if;
  if v_op.application_id is null or v_op.requested_by_auth_user_id is null then
    raise exception 'issuance operation is missing required durable requester/application information';
  end if;
  -- Channel/batch-binding consistency: never silently ignore an
  -- unexpected combination. staff_bulk MUST carry a non-null
  -- bulk_batch_id; every other channel MUST carry a null one — exactly
  -- mirroring qr_lifecycle_operations_bulk_batch_matches_channel's own
  -- invariant, restated here as a controlled internal-invariant check
  -- rather than trusted blindly (a row reaching this function that
  -- somehow violates its own table constraint would indicate a real bug
  -- elsewhere, not a business outcome to guess about).
  if v_op.channel = 'staff_bulk' and v_op.bulk_batch_id is null then
    raise exception 'staff_bulk issuance operation is missing its required bulk_batch_id';
  end if;
  if v_op.channel <> 'staff_bulk' and v_op.bulk_batch_id is not null then
    raise exception 'non-staff_bulk issuance operation unexpectedly carries a bulk_batch_id';
  end if;

  -- TWO-STAGE TTL CHECK (this round's correction, alongside the batch-
  -- lock reordering below): an EARLY check, immediately after the
  -- operation lock, avoids taking any further lock (batch, application,
  -- credential) for an operation that is already expired — no reason to
  -- lock rows this call will never touch. This does NOT replace the
  -- authoritative recheck after every required lock is held (below) —
  -- clock_timestamp() can advance arbitrarily far while THIS call itself
  -- waits on the batch/application/credential locks, so the operation
  -- could still expire during that wait even though this early check
  -- passed.
  if v_op.expires_at <= clock_timestamp() then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_transition_now, terminal_reason_code = 'ttl_expired'
    where id = v_op.id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  -- Position 2: durable bulk-batch row, FOR SHARE, ONLY for staff_bulk —
  -- locked immediately after the operation lock (and the early TTL
  -- check, which takes no lock of its own), BEFORE the application lock,
  -- and held for the remainder of this transaction (never released
  -- early) so a concurrent batch completion/cancellation is blocked
  -- until this finalization commits or rolls back. No pre-lock read of
  -- authoritative batch state occurs anywhere above this line. The batch
  -- row is selected and locked here, but NO business outcome
  -- (bulk_batch_unavailable or otherwise) is returned yet — every
  -- pending-path business decision, including this one, is evaluated
  -- together, in the approved TTL-first order, only after every required
  -- lock (batch, application, credential) is held.
  if v_op.channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches where id = v_op.bulk_batch_id for share;
  end if;

  -- Position 3: application row, FOR UPDATE.
  select * into v_app from public.applications where id = v_op.application_id for update;

  -- Position 4: current active credential row, FOR UPDATE.
  select * into v_current_active from public.qr_credentials
    where application_id = v_op.application_id and status = 'active' for update;

  -- Position 5: encryption-key registry row, FOR SHARE, via the shared
  -- helper (which itself takes this exact lock). CORRECTED this round:
  -- the authoritative timestamp used for the TTL recheck and every
  -- pending-path decision was previously captured immediately after
  -- position 4 — BEFORE this lock — leaving a gap where the operation
  -- could expire while THIS call itself waited to acquire the
  -- key-registry row, and still be finalized/rejected using a stale
  -- pre-wait timestamp. The key-active result is stored here in
  -- v_key_is_active WITHOUT yet deciding anything; the authoritative
  -- v_now below is captured only AFTER this lock, and every decision —
  -- including the key-version-active outcome, now evaluated last in the
  -- approved precedence rather than the moment its lock is acquired — is
  -- made from that single, final timestamp. Identical narrow correction
  -- to the one applied to finalize_qr_reissue_for_server this same
  -- round; this genuine defect was discovered only after this
  -- function's own earlier static approval, and no other logic in this
  -- function is touched.
  v_key_is_active := public.is_encryption_key_version_active(p_encryption_key_version);

  -- ONE authoritative timestamp, captured only after every required lock
  -- (through position 5) is held — reused for every timestamp field this
  -- finalizer writes from here on, AND for the authoritative TTL
  -- recheck below, which must win over every other business decision
  -- (requester authorization, batch availability, application
  -- eligibility, credential conflict, key-version-active) exactly as the
  -- early check's own comment states: this call's own wait on every lock
  -- above may itself have taken long enough for the operation to expire
  -- since the early check passed.
  v_now := clock_timestamp();

  -- Decision 1: TTL, rechecked authoritatively now that every required
  -- lock is held.
  if v_op.expires_at <= v_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_now, terminal_reason_code = 'ttl_expired'
    where id = v_op.id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  -- Decision 2: application eligibility. The batch row (for staff_bulk)
  -- was already locked at position 2 above, but its OWN business
  -- decision is evaluated later, at decision 4 below, preserving the
  -- exact approved precedence order (TTL -> application ->
  -- requester-authorization -> batch -> credential-conflict) — locking
  -- early (to close the race the batch could otherwise be mutated
  -- through) is independent of, and does not change, WHEN each decision
  -- is allowed to return a result.
  if v_app.id is null or v_app.status <> 'accepted' then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'application_ineligible'
    where id = v_op.id;
    v_result.outcome := 'application_ineligible';
    return v_result;
  end if;

  -- Decision 3: staff-channel requester authorization, re-verified at
  -- finalization time — a staff member's role can lapse in the window
  -- between reservation and finalization, and the operation must not be
  -- finalized on their behalf once that has happened.
  if v_op.channel in ('staff_individual', 'staff_bulk') then
    select role into v_caller_role from public.profiles where id = v_op.requested_by_auth_user_id;
    if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'requester_no_longer_authorized'
      where id = v_op.id;
      v_result.outcome := 'requester_no_longer_authorized';
      return v_result;
    end if;
  end if;

  -- Decision 4: staff_bulk batch availability — the row was already
  -- locked at position 2, above (immediately after the operation lock,
  -- before the application/credential locks); this is simply the first
  -- point in the approved DECISION precedence at which a business
  -- outcome based on that already-held lock may be returned.
  if v_op.channel = 'staff_bulk' then
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= v_now
       or v_batch.intended_operation_type <> 'issue'
       or v_batch.created_by_auth_user_id is distinct from v_op.requested_by_auth_user_id
       or v_batch.created_by_profile_id is distinct from v_op.requested_by_profile_id
    then
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = v_op.id;
      v_result.outcome := 'bulk_batch_unavailable';
      return v_result;
    end if;
  end if;

  -- Decision 5: active-credential conflict — never create a second
  -- active credential for the same application.
  if v_current_active.id is not null then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'active_credential_already_exists',
        terminal_related_credential_id = v_current_active.id
    where id = v_op.id;
    v_result.outcome := 'active_credential_already_exists';
    v_result.credential_id := v_current_active.id;
    v_result.status := v_current_active.status;
    v_result.issued_at := v_current_active.issued_at;
    return v_result;
  end if;

  -- Decision 6: encryption-key version active state — the lock was
  -- already acquired at position 5, above; the result computed there
  -- (v_key_is_active) is evaluated LAST among all pending-path
  -- validations, per the approved order — a missing, decrypt_only, or
  -- retired key is the one RETRYABLE outcome: the operation remains
  -- pending, never cancelled/expired/consumed, since Node can simply
  -- re-fetch the current active key version and retry with fresh crypto
  -- material against this SAME operation before its TTL elapses.
  if not v_key_is_active then
    v_result.outcome := 'key_version_not_active';
    return v_result; -- operation remains pending, untouched
  end if;

  -- Canonical fingerprint, computed ONLY through the shared helper — no
  -- ad-hoc format. Domain-separated for issuance
  -- ('rcoy:qr-finalization:v1' + 'issue'), binding credential id, token
  -- hash, token version, encryption-key version, and a digest of the
  -- ciphertext envelope.
  v_fingerprint := public.compute_qr_finalization_fingerprint(
    'issue', p_credential_id, p_token_hash, p_token_version, p_encryption_key_version, p_token_ciphertext
  );

  -- The credential insert, lifecycle consumed-transition, and success
  -- audit insert are atomic: all three happen inside this one inner
  -- exception block, and either all commit together or (on any
  -- exception, including a caught unique_violation re-raised as a
  -- controlled outcome) all roll back together, leaving the operation's
  -- OUTER row lock (acquired at position 1, still held across this whole
  -- function) available so the function can still return a controlled,
  -- safe result even when the insert itself fails. The lifecycle
  -- operation is never marked consumed before the credential row, its
  -- fingerprint, and every success invariant have already been
  -- persisted.
  begin
    insert into public.qr_credentials (
      id, application_id, token_hash, token_ciphertext, token_version, encryption_key_version,
      status, issuance_channel, issuance_reason_code, issuance_note,
      issued_at, created_at, issued_by
    ) values (
      p_credential_id, v_op.application_id, p_token_hash, p_token_ciphertext, p_token_version, p_encryption_key_version,
      'active', v_op.channel, v_op.reason_code, v_op.note,
      v_now, v_now,
      -- Actor semantics: participant_self_service -> null; staff_individual/
      -- staff_bulk -> the operation's own durable requested_by_profile_id
      -- (never the service-role identity, never re-resolved from
      -- auth.uid() — there is no authenticated client session inside this
      -- SECURITY DEFINER, service-role-only function; the ONLY trustworthy
      -- staff actor identity available here is the one the reservation RPC
      -- already durably recorded).
      case when v_op.channel = 'participant_self_service' then null else v_op.requested_by_profile_id end
    );

    update public.qr_lifecycle_operations
    set status = 'consumed', consumed_at = v_now, finalized_at = v_now,
        resulting_credential_id = p_credential_id, finalization_fingerprint = v_fingerprint,
        terminal_reason_code = null, terminal_related_credential_id = null, terminal_retry_after_at = null
    where id = v_op.id;

    -- Safe metadata only — never token hash, ciphertext, nonce, key
    -- material, or fingerprint.
    insert into public.audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, created_at)
    values (
      'qr_credential', p_credential_id, 'issued',
      case when v_op.channel = 'participant_self_service' then 'system' else 'admin' end,
      case when v_op.channel = 'participant_self_service' then v_op.requested_by_auth_user_id else v_op.requested_by_profile_id end,
      jsonb_build_object('application_id', v_op.application_id, 'issuance_channel', v_op.channel, 'issuance_reason_code', v_op.reason_code),
      v_now
    );
  exception
    when unique_violation then
      declare
        v_constraint_name text;
        v_conflicting_credential public.qr_credentials;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name = 'qr_credentials_token_hash_unique' then
          -- The token hash already belongs to a DIFFERENT, already-
          -- inserted credential row — a Node-side random-generation
          -- collision or a genuine concurrent-finalizer race on the same
          -- hash. The operation remains pending (retryable with fresh
          -- input); no partial credential, no success audit row (this
          -- whole block rolled back together).
          v_result.outcome := 'token_hash_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_credentials_pkey' then
          -- p_credential_id collides with an existing row belonging to a
          -- DIFFERENT operation entirely (this operation's own resulting_
          -- credential_id is still null at this point in the flow, since
          -- the UPDATE above never committed) — resolve safely rather
          -- than expose the raw violation.
          select * into v_conflicting_credential from public.qr_credentials where id = p_credential_id;
          if v_conflicting_credential.id is not null and v_conflicting_credential.status = 'active'
             and v_conflicting_credential.application_id = v_op.application_id then
            -- The conflicting row IS this exact application's active
            -- credential — safe to resolve as the same controlled
            -- conflict outcome the pre-lock check above would have
            -- produced, identifying the credential rather than exposing
            -- a raw error.
            v_result.outcome := 'active_credential_already_exists';
            v_result.credential_id := v_conflicting_credential.id;
            v_result.status := v_conflicting_credential.status;
            v_result.issued_at := v_conflicting_credential.issued_at;
            return v_result;
          end if;
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_lifecycle_operations_resulting_credential_unique_idx' then
          -- p_credential_id is already recorded as the RESULT of a
          -- different lifecycle operation — never legitimate for a fresh
          -- issuance.
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        else
          raise;
        end if;
      end;
  end;

  v_result.outcome := 'issued';
  v_result.credential_id := p_credential_id;
  v_result.status := 'active';
  v_result.issued_at := v_now;
  return v_result;
end;
$$;

revoke all on function public.finalize_qr_issuance_for_server(uuid, uuid, bytea, bytea, smallint, smallint) from public, anon, authenticated;
grant execute on function public.finalize_qr_issuance_for_server(uuid, uuid, bytea, bytea, smallint, smallint) to service_role;

-- ============================================================================
-- §5.2  Reissue — approved participant self-reissue reservation +
-- approved finalize_qr_reissue_for_server
-- (staff reissue reservation already extracted above in the §5.1 block)
-- ============================================================================
-- SUB-PASS 2 — participant self-reissue reservation, this round's addition.
--
-- Reissue-specific blocker resolver. Takes an ALREADY-LOCKED candidate
-- reissue operation row (FOR UPDATE already held by the caller) and the
-- ALREADY-LOCKED application row, and resolves the candidate to exactly
-- one of two dispositions, mirroring resolve_blocking_qr_lifecycle_operation's
-- shape and correction discipline exactly, but with reissue's own decision
-- tree (§ "Reissue-specific blocker resolution" below, restated here):
--   1. application no longer accepted -> cancelled/application_ineligible
--      (no credential lock needed for this determination).
--   2. otherwise, lock the current active credential.
--   3. capture clock_timestamp() AFTER the credential lock.
--   4. if the candidate's own TTL has elapsed -> expired/ttl_expired.
--      Expiry wins over every credential-state finding below, exactly
--      mirroring the issuance resolver's "expiry wins" precedence.
--   5. if no active credential exists at all -> cancelled/no_active_credential.
--   6. if an active credential exists but its id is not the candidate's own
--      expected_current_credential_id -> cancelled/expected_credential_changed
--      (terminal_related_credential_id set to the credential actually
--      found active, for historically-stable replay — NOT the vanished
--      expected one, which by definition no longer exists as the active
--      row).
--   7. otherwise the candidate survives every terminal check and remains
--      genuinely blocking -> 'still_blocking'.
-- Cooldown/rate-limit are DELIBERATELY NOT evaluated here: those limits
-- apply only to a NEW request attempting to reserve, never retroactively
-- to an already-existing pending operation that was validly reserved
-- before the limit would have applied to it — an existing pending blocker
-- must never be terminalized "because a hypothetical new request would
-- have been rate-limited," since the blocker itself already passed its
-- own limit check at its own creation time.
create function public.resolve_blocking_qr_lifecycle_reissue_operation(
  p_candidate public.qr_lifecycle_operations,
  p_app public.applications,
  out disposition text -- 'still_blocking' | 'terminalized'
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing_credential public.qr_credentials;
  v_transition_now timestamptz;
  v_check_now timestamptz;
begin
  if p_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- Credential lock BEFORE the TTL decision, matching the issuance
  -- resolver's precedence exactly.
  select * into v_existing_credential from public.qr_credentials
    where application_id = p_app.id and status = 'active' for update;

  -- TTL checked immediately after the credential lock — expiry wins over
  -- any credential-state finding below.
  v_check_now := clock_timestamp();
  if p_candidate.expires_at <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  if v_existing_credential.id is null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'no_active_credential'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- CORRECTED this round: terminal_related_credential_id is permitted
  -- ONLY for 'active_credential_already_exists' by the approved
  -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
  -- (§1.7) — it must remain null for 'expected_credential_changed'.
  if v_existing_credential.id <> p_candidate.expected_current_credential_id then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed',
        terminal_related_credential_id = null
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  disposition := 'still_blocking';
  return;
end;
$$;

revoke all on function public.resolve_blocking_qr_lifecycle_reissue_operation(
  public.qr_lifecycle_operations, public.applications
) from public;
-- No grant to authenticated/anon — called only from within
-- request_my_qr_reissue_transactional_internal's own security-definer
-- body, which already holds every lock this function itself requires.

-- ================= RESERVATION (participant self-reissue) =================
-- Extends the approved §5.1 issuance foundation exactly — same
-- request_key/dual-advisory-lock protocol via reserve_or_reuse_qr_lifecycle_operation,
-- same split into a private internal implementation (accepts p_pending_ttl,
-- never exposed to authenticated/anon) and a thin public wrapper fixed at
-- 5 minutes, same insert-first-then-validate discipline for durable
-- first-request outcomes, same UPDATE-then-RETURN (never UPDATE-then-RAISE)
-- pattern for every terminal transition.
--
-- Global lock order (unchanged from issuance, restated for reissue):
--   1. request-key advisory lock (requester, operation_type, request_key)
--      — inside reserve_or_reuse_qr_lifecycle_operation.
--   2. reservation-domain advisory lock (application_id, operation_type)
--      — inside reserve_or_reuse_qr_lifecycle_operation.
--   3. lifecycle-operation row, by request_key or the domain's other
--      pending reissue operation — inside reserve_or_reuse_qr_lifecycle_operation.
--   4. bulk batch, where applicable — NOT applicable to participant
--      self-service (channel is always 'participant_self_service', which
--      qr_lifecycle_operations_bulk_batch_matches_channel forces
--      bulk_batch_id to null for).
--   5. application row, FOR UPDATE.
--   6. current active credential row, FOR UPDATE.
--   7. fresh clock_timestamp() and every authoritative TTL/cooldown/
--      rate-limit/business-rule decision, only after every lock above is
--      held.
--
-- Immutable reservation intent (compared field-for-field by
-- reserve_or_reuse_qr_lifecycle_operation's existing intent-match logic —
-- no changes needed there, since it already compares every one of these
-- fields generically): application_id, operation_type ('reissue'),
-- channel ('participant_self_service'), request_key, requested_by_auth_user_id
-- (auth.uid()), expected_current_credential_id, reason_code (the
-- participant reissue reason), note (normalized), bulk_batch_id (always
-- null for this channel).
create function public.request_my_qr_reissue_transactional_internal(
  p_request_key uuid,
  p_expected_current_credential_id uuid,
  p_reissue_reason_code text,
  p_reissue_note text,
  p_pending_ttl interval
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_application_id_candidate uuid;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_normalized_note text;
  v_reservation record;
  v_resolution record;
  v_operation_id uuid;
  v_created_at timestamptz;
  v_check_now timestamptz;
  v_transition_now timestamptz;
  v_retry_after_at timestamptz;
  v_consumed_at_values timestamptz[];
  v_result public.qr_credential_lifecycle_result;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_request_key is null then raise exception 'request_key is required'; end if;
  if p_expected_current_credential_id is null then raise exception 'expected_current_credential_id is required'; end if;
  if p_pending_ttl is null or p_pending_ttl <= interval '0' then
    raise exception 'p_pending_ttl must be a positive interval';
  end if;

  -- Reason-code/note validation, per §1.4's conditional rules for
  -- participant_self_service reissue: the code must be one of the six
  -- participant codes, never a staff code; 'participant_other' requires a
  -- non-empty trimmed note. This is deliberately a RAISED EXCEPTION, not a
  -- returned qr_credential_lifecycle_result outcome — malformed/invalid
  -- input never reaches the point of resolving the participant's
  -- application or creating an operation row (see the processing-order
  -- comment on the 'no_existing_operation' path below for the complete,
  -- authoritative list of what may fail before an operation exists).
  if p_reissue_reason_code is null or p_reissue_reason_code not in (
    'lost_or_stolen_phone', 'screenshot_shared', 'printed_copy_lost',
    'qr_display_issue', 'security_concern', 'participant_other'
  ) then
    raise exception 'A valid participant reissue reason code is required';
  end if;
  -- Note normalization — used identically for validation, the immutable-
  -- intent comparison inside reserve_or_reuse_qr_lifecycle_operation, AND
  -- final persistence: null stays null; trimmed-empty text becomes null;
  -- non-empty text is stored trimmed. Applying the SAME normalized value
  -- everywhere means two callers supplying, e.g., '  ' and null
  -- respectively for the same otherwise-identical request are recognized
  -- as IDENTICAL intent (never a spurious request_key_intent_conflict) —
  -- whitespace differences must never create unstable intent conflicts.
  v_normalized_note := nullif(trim(p_reissue_note), '');
  if p_reissue_reason_code = 'participant_other' and v_normalized_note is null then
    raise exception 'A note is required when reissue reason is participant_other';
  end if;

  -- Resolve the participant's own application — unlocked here, used only
  -- to shape the advisory-lock domain; re-verified under lock at position
  -- 5 below. This, and the two exceptions above, are the ONLY things that
  -- may fail before an operation row exists (beyond
  -- p_expected_current_credential_id's own foreign-key-intent validation,
  -- performed next).
  select id into v_application_id_candidate from public.applications where applicant_id = auth.uid();
  if v_application_id_candidate is null then raise exception 'No application found for this account'; end if;

  -- If p_expected_current_credential_id cannot possibly satisfy
  -- qr_lifecycle_operations_expected_credential_fkey's composite
  -- (id, application_id) target — i.e. it does not identify ANY
  -- qr_credentials row belonging to this participant's OWN application,
  -- active or not — this is treated as INVALID INPUT and rejected before
  -- any operation is ever created, exactly like the reason-code/note
  -- checks above. This is deliberately NOT the same thing as "the
  -- credential exists for this application but is no longer active" —
  -- THAT case is legal immutable intent (the participant may be trying to
  -- reissue against a credential they last saw as active, which has since
  -- been replaced/revoked) and must produce the durable
  -- expected_credential_changed outcome via a real operation row, not an
  -- input-validation exception. The distinction is made by checking
  -- existence+application match only, never status.
  if not exists (
    select 1 from public.qr_credentials
    where id = p_expected_current_credential_id and application_id = v_application_id_candidate
  ) then
    raise exception 'expected_current_credential_id does not identify a credential belonging to this application';
  end if;

  -- Positions 1-3: advisory-locked reservation lookup, unchanged shared
  -- helper — operation_type = 'reissue', bulk_batch_id always null for
  -- this channel. v_normalized_note (not the raw parameter) is passed
  -- through so the intent comparison and any subsequent insert both use
  -- the identical normalized value.
  select * into v_reservation from public.reserve_or_reuse_qr_lifecycle_operation(
    'reissue', v_application_id_candidate, auth.uid(), p_request_key, 'participant_self_service', null,
    p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id
  );

  if v_reservation.state = 'request_key_intent_conflict' then
    v_result.outcome := 'request_key_intent_conflict';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'already_consumed' then
    select * into v_current_active from public.qr_credentials
      where id = (v_reservation.op).resulting_credential_id;
    v_result.outcome := 'already_finalized';
    v_result.credential_id := v_current_active.id;
    v_result.status := v_current_active.status; -- historically-stable: replayed as-stored, even if since revoked/replaced
    v_result.issued_at := v_current_active.issued_at;
    v_result.replaced_at := v_current_active.replaced_at;
    v_result.revoked_at := v_current_active.revoked_at;
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_expired' then
    v_result.outcome := 'operation_expired';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_cancelled' then
    -- Identical replay of ANY previously-cancelled reissue reservation —
    -- including a cooldown/rate-limit denial — replays the STORED
    -- terminal reason and, for the two policy-driven reasons, computes
    -- retry_after_seconds from the STORED terminal_retry_after_at. Never
    -- re-derives which historical operations originally triggered the
    -- denial, and never re-evaluates current application/credential/
    -- cooldown/rate-limit state — this row's outcome was decided once, at
    -- cancellation time, and is replayed verbatim.
    v_result.outcome := (v_reservation.op).terminal_reason_code;
    v_result.operation_id := (v_reservation.op).id;
    if (v_reservation.op).terminal_reason_code = 'expected_credential_changed' then
      select * into v_current_active from public.qr_credentials
        where id = (v_reservation.op).terminal_related_credential_id;
      v_result.credential_id := v_current_active.id;
      v_result.status := v_current_active.status;
      v_result.issued_at := v_current_active.issued_at;
    elsif (v_reservation.op).terminal_reason_code in ('reissue_cooldown_active', 'reissue_rate_limit_exceeded') then
      v_result.retry_after_seconds := greatest(
        0,
        ceil(extract(epoch from (v_reservation.op).terminal_retry_after_at - clock_timestamp()))
      )::integer;
    end if;
    return v_result;
  end if;

  -- Position 5: lock the application, THEN re-verify ownership.
  select * into v_app from public.applications where id = v_application_id_candidate for update;
  if v_app.id is null or v_app.applicant_id is distinct from auth.uid() then
    raise exception 'No application found for this account';
  end if;

  if v_reservation.state = 'other_pending_candidate' then
    -- Delegates to the reissue-specific shared resolver — which evaluates
    -- ONLY application eligibility, the credential lock, TTL, active-
    -- credential existence, and expected-credential match. It deliberately
    -- never touches cooldown/rate-limit: those are admission-time controls
    -- for a NEW request, and must never retroactively invalidate an
    -- already-existing valid pending operation (this also structurally
    -- prevents a pending operation from ever invalidating itself).
    select * into v_resolution from public.resolve_blocking_qr_lifecycle_reissue_operation(v_reservation.op, v_app);
    if v_resolution.disposition = 'still_blocking' then
      v_result.outcome := 'another_operation_pending';
      if (v_reservation.op).requested_by_auth_user_id = auth.uid() then
        v_result.operation_id := (v_reservation.op).id;
      end if;
      return v_result;
    end if;
    -- 'terminalized' (application_ineligible, ttl_expired, no_active_credential,
    -- or expected_credential_changed) — continues processing THIS request
    -- key, falling through to the shared insert-and-resolve path below,
    -- identical to 'no_existing_operation'.
  elsif v_reservation.state = 'matching_pending_candidate' then
    -- Mirrors the reissue-specific resolver's own decision tree exactly
    -- (application eligibility -> credential lock -> TTL -> active-
    -- credential existence -> expected-credential match) but returns THIS
    -- caller's own outcomes (already_pending/operation_expired/
    -- application_ineligible/no_active_credential/expected_credential_changed)
    -- rather than the resolver's generic still_blocking/terminalized pair,
    -- exactly mirroring issuance's identical matching_pending_candidate
    -- vs. other_pending_candidate distinction. Cooldown/rate-limit are NOT
    -- re-evaluated here either, for the identical reason.
    if v_app.status <> 'accepted' then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
      where id = (v_reservation.op).id;
      v_result.outcome := 'application_ineligible';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    -- Position 6: credential lock BEFORE the TTL decision.
    select * into v_current_active from public.qr_credentials
      where application_id = v_app.id and status = 'active' for update;

    -- Position 7: fresh timestamp, captured only after the credential
    -- lock — TTL checked immediately, and wins over every credential-state
    -- finding below.
    v_check_now := clock_timestamp();
    if (v_reservation.op).expires_at <= v_check_now then
      update public.qr_lifecycle_operations
      set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
      where id = (v_reservation.op).id;
      v_result.outcome := 'operation_expired';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    if v_current_active.id is null then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'no_active_credential'
      where id = (v_reservation.op).id;
      v_result.outcome := 'no_active_credential';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    -- CORRECTED this round: terminal_related_credential_id is permitted
    -- ONLY for 'active_credential_already_exists' by the approved
    -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
    -- (§1.7) — it must remain null here, and the returned result carries
    -- only the stable outcome name, no credential_id/status/issued_at.
    if v_current_active.id <> (v_reservation.op).expected_current_credential_id then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed',
          terminal_related_credential_id = null
      where id = (v_reservation.op).id;
      v_result.outcome := 'expected_credential_changed';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    v_result.outcome := 'already_pending';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  -- ===================== 'no_existing_operation' path =====================
  -- (also reached for an 'other_pending_candidate' just terminalized
  -- above, which falls through here identically.)
  --
  -- Authoritative processing order for this path, restated exactly as
  -- specified and implemented step-for-step below:
  --   1. lock and recheck the application and participant ownership
  --      (already done above, at position 5 — shared by every state).
  --   2. lock the current active credential.
  --   3. capture a fresh timestamp.
  --   4. insert the participant's own PENDING reissue operation with the
  --      immutable request intent — durably persisted BEFORE any business
  --      denial is evaluated, so every subsequent denial has a real row
  --      to transition rather than reporting a no-row outcome.
  --   5. if its TTL has elapsed because of lock-waiting time, expire it.
  --      (Pathological — the window between step 3's timestamp and this
  --      check is normally microseconds — but not assumed impossible,
  --      mirroring issuance's identical restated-TTL-recheck discipline
  --      for its own freshly-inserted row.)
  --   6. if the application is ineligible, cancel with application_ineligible.
  --   7. if no active credential exists, cancel with no_active_credential.
  --   8. if the active credential differs from expected, cancel with
  --      expected_credential_changed.
  --   9. evaluate the consumed-operation daily (rolling 24h) limit.
  --  10. if blocked, cancel with reissue_rate_limit_exceeded and persist
  --      terminal_retry_after_at.
  --  11. otherwise evaluate cooldown.
  --  12. if blocked, cancel with reissue_cooldown_active and persist
  --      terminal_retry_after_at.
  --  13. otherwise return reserved.
  --
  -- Every branch below re-derives application/credential state from the
  -- SAME locks already held (position 5's application lock; this path's
  -- own credential lock next) — no separate re-locking required, and the
  -- SAME defense-in-depth exception handler for the named partial unique
  -- index is retained around the insert itself, mirroring issuance's own
  -- retained handler for the identical reason (a concurrent different
  -- request_key theoretically slipping in between the reserve_or_reuse
  -- lookup and this insert — impossible under the domain lock actually
  -- held, retained anyway as defense in depth).

  -- Step 2: credential lock BEFORE any further decision.
  select * into v_current_active from public.qr_credentials
    where application_id = v_app.id and status = 'active' for update;

  -- Step 3: fresh timestamp, captured only after the credential lock.
  v_created_at := clock_timestamp();

  -- Step 4: insert first, always — every business decision below operates
  -- on this real, durable row, never a hypothetical pre-insert check.
  begin
    insert into public.qr_lifecycle_operations (
      operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
      channel, request_key, reason_code, note, expected_current_credential_id, created_at, expires_at
    ) values (
      'reissue', v_app.id, auth.uid(), auth.uid(), 'participant_self_service',
      p_request_key, p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id,
      v_created_at, v_created_at + p_pending_ttl
    ) returning id into v_operation_id;
  exception
    when unique_violation then
      declare
        v_constraint_name text;
        v_conflicting public.qr_lifecycle_operations;
        v_conflicting_resolution record;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name <> 'qr_lifecycle_operations_one_pending_per_domain_idx' then
          raise;
        end if;
        select * into v_conflicting from public.qr_lifecycle_operations
          where application_id = v_app.id and operation_type = 'reissue' and status = 'pending'
          for update;
        if v_conflicting.id is null then
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, request_key, reason_code, note, expected_current_credential_id, created_at, expires_at
          ) values (
            'reissue', v_app.id, auth.uid(), auth.uid(), 'participant_self_service',
            p_request_key, p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id,
            v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        else
          select * into v_conflicting_resolution
            from public.resolve_blocking_qr_lifecycle_reissue_operation(v_conflicting, v_app);
          if v_conflicting_resolution.disposition = 'still_blocking' then
            v_result.outcome := 'another_operation_pending';
            if v_conflicting.requested_by_auth_user_id = auth.uid() then
              v_result.operation_id := v_conflicting.id;
            end if;
            return v_result;
          end if;
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, request_key, reason_code, note, expected_current_credential_id, created_at, expires_at
          ) values (
            'reissue', v_app.id, auth.uid(), auth.uid(), 'participant_self_service',
            p_request_key, p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id,
            v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        end if;
      end;
  end;

  -- Step 5: TTL recheck against THIS row's own just-inserted expires_at —
  -- pathological (the window since step 3 is normally microseconds), but
  -- not assumed impossible.
  v_check_now := clock_timestamp();
  if v_created_at + p_pending_ttl <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = v_operation_id;
    v_result.outcome := 'operation_expired';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 6: application eligibility.
  if v_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = v_operation_id;
    v_result.outcome := 'application_ineligible';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 7: active-credential existence.
  if v_current_active.id is null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'no_active_credential'
    where id = v_operation_id;
    v_result.outcome := 'no_active_credential';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 8: expected-credential match. CORRECTED this round:
  -- terminal_related_credential_id is permitted ONLY for
  -- 'active_credential_already_exists' by the approved
  -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
  -- (§1.7) — it must remain null here, and the returned result carries
  -- only the stable outcome name, no credential_id/status/issued_at.
  if v_current_active.id <> p_expected_current_credential_id then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed',
        terminal_related_credential_id = null
    where id = v_operation_id;
    v_result.outcome := 'expected_credential_changed';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Steps 9-12: consumed-operation cooldown and rolling-rate-limit checks
  -- — see "Cooldown and rate-limit calculation rules" below for the exact
  -- query, window boundaries, and precedence argument. ONE authoritative
  -- post-lock timestamp (v_check_now, re-captured here) is used for both.
  -- Both checks run under the SAME application-domain advisory lock
  -- already held since position 1/2 (reserve_or_reuse_qr_lifecycle_operation
  -- never released it — it is held for the remainder of this transaction)
  -- — no separate lock is required for the counting query itself.
  v_check_now := clock_timestamp();

  -- CORRECTED this round: LIMIT 3 must apply to the SOURCE rows, inside a
  -- subquery, BEFORE array_agg runs — not after array_agg as a top-level
  -- clause. array_agg is an aggregate: it consumes every row the FROM
  -- clause produces and emits exactly ONE result row (the array itself). A
  -- LIMIT 3 placed after that aggregation restricts the number of
  -- AGGREGATE-RESULT rows (already 1), never the number of SOURCE rows fed
  -- into the aggregate — the previous version's `... from
  -- qr_lifecycle_operations where ... order by consumed_at desc limit 3`
  -- with array_agg at the top level therefore aggregated EVERY qualifying
  -- historical row, not merely the three most recent, which would corrupt
  -- v_consumed_at_values[3] (and the daily-limit decision below) for any
  -- application with more than three qualifying consumed reissues ever.
  -- The corrected form nests the ORDER BY + LIMIT 3 inside an explicit
  -- subquery so exactly three rows (or fewer) reach array_agg.
  select coalesce(
           array_agg(
             q.consumed_at
             order by q.consumed_at desc
           ),
           array[]::timestamptz[]
         )
    into v_consumed_at_values
    from (
      select o.consumed_at
      from public.qr_lifecycle_operations o
      where o.application_id = v_app.id
        and o.operation_type = 'reissue'
        and o.channel = 'participant_self_service'
        and o.status = 'consumed'
        and o.consumed_at is not null
      order by o.consumed_at desc
      limit 3
    ) q;

  -- Step 9-10: rolling 24-hour daily limit, evaluated FIRST — its
  -- eligibility boundary (when 3+ qualifying operations exist) is always
  -- the effective LONGER restriction whenever both policies are active
  -- simultaneously, so it must take precedence: a caller must never be
  -- told "cooldown ends in N minutes" while still genuinely blocked by
  -- the daily limit for far longer.
  --
  -- CORRECTED this round: the window test must inspect
  -- v_consumed_at_values[3] (the THIRD-most-recent qualifying operation),
  -- not [1] (the most recent). Checking [1] only proves the LATEST reissue
  -- happened within 24 hours — it says nothing about whether a THIRD
  -- qualifying reissue exists inside that same window at all. Concretely:
  -- if the most recent qualifying reissue is 1 hour old but the second and
  -- third most recent are each several days old, [1] > now - 24h is TRUE
  -- even though only ONE reissue (not three) actually occurred inside the
  -- rolling 24-hour window — the daily limit must NOT fire in that case,
  -- and only inspecting [3] (rather than [1]) correctly reflects that.
  -- Three qualifying operations are inside the window if and only if the
  -- OLDEST of those three — [3], since the array is ordered most-recent-
  -- first — is still newer than the 24-hour boundary.
  if cardinality(v_consumed_at_values) >= 3
     and v_consumed_at_values[3] > v_check_now - interval '24 hours' then
    -- At least 3 qualifying operations exist AND the THIRD-most-recent is
    -- still within the rolling window — rate-limited. The retry boundary
    -- is that same third-most-recent qualifying consumed_at plus 24
    -- hours: once that specific operation ages out of the rolling window,
    -- only 2 qualifying operations remain within it, and a new attempt
    -- becomes eligible again.
    v_retry_after_at := v_consumed_at_values[3] + interval '24 hours';

    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_check_now, terminal_reason_code = 'reissue_rate_limit_exceeded',
        terminal_retry_after_at = v_retry_after_at
    where id = v_operation_id;

    v_result.outcome := 'reissue_rate_limit_exceeded';
    v_result.operation_id := v_operation_id;
    v_result.retry_after_seconds := greatest(0, ceil(extract(epoch from v_retry_after_at - clock_timestamp())))::integer;

    return v_result;
  elsif cardinality(v_consumed_at_values) >= 1
        and v_consumed_at_values[1] > v_check_now - interval '10 minutes' then
    -- Step 11-12: cooldown — reached only when the daily limit above did
    -- NOT fire (an elsif, not a separate independent if), so a cooldown
    -- retry time is never returned while the participant remains blocked
    -- by the longer-lasting daily limit. Cooldown depends ONLY on the
    -- participant's single most recent qualifying reissue — [1], never
    -- [3] — independent of how many total qualifying operations exist.
    v_retry_after_at := v_consumed_at_values[1] + interval '10 minutes';

    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_check_now, terminal_reason_code = 'reissue_cooldown_active',
        terminal_retry_after_at = v_retry_after_at
    where id = v_operation_id;

    v_result.outcome := 'reissue_cooldown_active';
    v_result.operation_id := v_operation_id;
    v_result.retry_after_seconds := greatest(0, ceil(extract(epoch from v_retry_after_at - clock_timestamp())))::integer;

    return v_result;
  end if;

  -- Step 13: every eligibility/TTL/cooldown/rate-limit check has passed —
  -- the pending row inserted at step 4 remains genuinely reserved.
  v_result.outcome := 'reserved';
  v_result.operation_id := v_operation_id;
  return v_result;
end;
$$;

revoke all on function public.request_my_qr_reissue_transactional_internal(uuid, uuid, text, text, interval) from public;
-- No grant to authenticated/anon — reachable only through the public
-- wrapper below and a future test-only short-TTL wrapper, both of which
-- fix or otherwise control p_pending_ttl.

-- Public, authenticated-facing wrapper — the ONLY entry point exposed to
-- real users for participant self-reissue. TTL is hardcoded at 5 minutes,
-- identical to issuance; no caller, however privileged, can pass a
-- different value through this signature.
create function public.request_my_qr_reissue_transactional(
  p_request_key uuid,
  p_expected_current_credential_id uuid,
  p_reissue_reason_code text,
  p_reissue_note text
) returns public.qr_credential_lifecycle_result
language sql security definer set search_path = public, pg_temp as $$
  select public.request_my_qr_reissue_transactional_internal(
    p_request_key, p_expected_current_credential_id, p_reissue_reason_code, p_reissue_note,
    interval '5 minutes'
  );
$$;

revoke all on function public.request_my_qr_reissue_transactional(uuid, uuid, text, text) from public;
grant execute on function public.request_my_qr_reissue_transactional(uuid, uuid, text, text) to authenticated;

-- ================= FINALIZATION — reissue (service-role only) — APPROVED =================
-- SUB-PASS 2, this round's addition. Consumes a 'pending' reissue
-- operation (participant self-service, staff individual, or staff bulk —
-- all three approved reissue reservation RPCs share this ONE finalizer,
-- exactly mirroring how finalize_qr_issuance_for_server serves all three
-- approved issuance reservation RPCs) and performs the atomic
-- old-credential-replacement + new-credential-creation write —
-- `service_role`-only, ONE approved signature, no overload. Every input
-- is either an opaque identifier or already-encrypted/hashed material —
-- never plaintext, never a key, never a nonce, never a fingerprint,
-- never a ciphertext digest. The function computes its own fingerprint
-- internally and never returns it.
--
-- Lock order (five positions, identical shape to the approved issuance
-- finalizer, extended with reissue's own credential semantics):
--   1. lifecycle operation row, FOR UPDATE — locked and inspected FIRST,
--      before any other row; the operation is the authoritative
--      idempotency record, not qr_credentials. A two-stage TTL check
--      (identical protocol to the issuance finalizer) runs around this
--      lock and the locks below — an EARLY check immediately after this
--      lock avoids taking any further lock for an already-expired
--      operation; a SECOND, authoritative recheck runs again after EVERY
--      required lock, THROUGH POSITION 5 (the key-registry lock), is
--      held, and is the one that actually governs decision precedence
--      (TTL still wins over every other business outcome). CORRECTED
--      this round: the authoritative recheck previously ran after only
--      position 4, before the key-registry lock at position 5 was even
--      acquired — closing that gap required moving the authoritative
--      clock_timestamp() capture to after position 5 as well; the
--      identical narrow correction was applied to
--      finalize_qr_issuance_for_server.
--   2. durable bulk-batch row, FOR SHARE, ONLY when channel = 'staff_bulk'
--      — locked immediately after the operation lock (and the early TTL
--      check), BEFORE the application lock, and held for the remainder
--      of this transaction — identical rationale and mechanism to the
--      issuance finalizer's own corrected batch-lock position: a
--      concurrent batch completion/cancellation must block behind this
--      finalizer's hold until the transaction commits or rolls back,
--      never merely "was valid at the moment of an early, unprotected
--      read." Locking here does NOT mean the batch's business outcome
--      (bulk_batch_unavailable) is decided here — the decision
--      precedence below (application -> requester-authorization -> batch
--      -> no-active-credential -> expected-credential-mismatch ->
--      key-version-active) is independent of lock order.
--   3. application row, FOR UPDATE.
--   4. current active credential row, FOR UPDATE — selected by
--      application_id = the operation's own application_id and
--      status = 'active' ONLY; never a caller-supplied "old credential"
--      row or actor identity of any kind.
--   5. selected encryption-key registry row, FOR SHARE — via
--      is_encryption_key_version_active(), which itself takes this exact
--      lock; reused unchanged, the single source of truth for "is this
--      key version currently active" everywhere in this design. Locking
--      here does NOT mean the key's business outcome
--      (key_version_not_active) is decided here — CORRECTED this round,
--      the authoritative clock_timestamp() is captured only AFTER this
--      lock, and every decision (including this one, still evaluated
--      LAST in the approved precedence) runs from that single, final
--      timestamp.
-- No row is ever locked before the lifecycle operation; no authoritative
-- batch/application/credential/key state is ever read before its own
-- corresponding lock in this exact order.
create function public.finalize_qr_reissue_for_server(
  p_operation_id uuid,
  p_new_credential_id uuid,
  p_new_token_hash bytea,
  p_new_token_ciphertext bytea,
  p_new_token_version smallint,
  p_new_encryption_key_version smallint
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_op public.qr_lifecycle_operations;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_caller_role text;
  v_batch public.qr_bulk_operation_batches;
  v_key_is_active boolean;
  v_now timestamptz;
  v_transition_now timestamptz;
  v_fingerprint bytea;
  v_existing_credential public.qr_credentials;
  v_result public.qr_credential_lifecycle_result;
begin
  -- Input-shape validation BEFORE any lock is taken — malformed input is
  -- rejected as an exception, never represented as a lifecycle-result
  -- outcome, exactly mirroring the issuance finalizer's own discipline.
  if p_operation_id is null then raise exception 'operation_id is required'; end if;
  if p_new_credential_id is null then raise exception 'new_credential_id is required'; end if;
  if p_new_token_hash is null or octet_length(p_new_token_hash) <> 32 then
    raise exception 'new_token_hash must be exactly 32 bytes';
  end if;
  if p_new_token_ciphertext is null or octet_length(p_new_token_ciphertext) <> 61 then
    raise exception 'new_token_ciphertext must be exactly 61 bytes';
  end if;
  if get_byte(p_new_token_ciphertext, 0) <> 1 then
    raise exception 'Unsupported ciphertext envelope version';
  end if;
  if p_new_token_version is null or p_new_token_version not between 1 and 32767 then
    raise exception 'Invalid new_token_version';
  end if;
  if p_new_encryption_key_version is null or p_new_encryption_key_version not between 1 and 32767 then
    raise exception 'Invalid new_encryption_key_version';
  end if;

  -- Position 1: lifecycle operation row, FOR UPDATE, locked and
  -- inspected FIRST, before any other row.
  select * into v_op from public.qr_lifecycle_operations where id = p_operation_id for update;
  if v_op.id is null then raise exception 'Lifecycle operation not found'; end if;

  -- The new credential id must differ from the operation's own durable
  -- expected_current_credential_id — checked here, against the
  -- OPERATION's own recorded value (not any later-read live state),
  -- since it is available immediately once the operation is locked and
  -- is true for every legitimate call regardless of historical/pending
  -- status.
  if v_op.expected_current_credential_id is not null and p_new_credential_id = v_op.expected_current_credential_id then
    raise exception 'new_credential_id must differ from expected_current_credential_id';
  end if;

  -- Historical states handled FIRST, before any further lock —
  -- 'consumed'/'expired'/'cancelled' are all fully resolved by the
  -- operation row alone.
  if v_op.status = 'consumed' then
    -- Idempotent replay: recompute the SAME canonical fingerprint from
    -- THIS call's supplied inputs (domain 'reissue') and compare against
    -- the durably stored one — never re-derived from the current
    -- qr_credentials row. CORRECTED this round: the replayed RESULT
    -- itself must ALSO never be derived from the current qr_credentials
    -- row — a resulting credential may later become revoked or replaced,
    -- and exact finalizer replay must not change because of that later
    -- lifecycle transition. Every field returned here comes exclusively
    -- from the durable qr_lifecycle_operations row: credential_id from
    -- resulting_credential_id, status hardcoded to 'active' (the state at
    -- the successful finalization transition, never re-queried), and
    -- issued_at from finalized_at (guaranteed equal to the new
    -- credential's own issued_at at the moment of that same transition).
    -- This branch no longer depends on the resulting credential row still
    -- being queryable, its current status, its ciphertext, its current
    -- encryption-key version, or any later revocation/replacement field.
    v_fingerprint := public.compute_qr_finalization_fingerprint(
      'reissue', p_new_credential_id, p_new_token_hash, p_new_token_version, p_new_encryption_key_version, p_new_token_ciphertext
    );
    if v_fingerprint = v_op.finalization_fingerprint and p_new_credential_id = v_op.resulting_credential_id then
      v_result.outcome := 'already_finalized';
      v_result.credential_id := v_op.resulting_credential_id;
      v_result.status := 'active';
      v_result.issued_at := v_op.finalized_at;
      return v_result;
    end if;
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  if v_op.status = 'expired' then
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  if v_op.status = 'cancelled' then
    -- Replay the durable terminal outcome without re-evaluating current
    -- state — identical discipline to every reservation RPC's own
    -- replay_cancelled path and the issuance finalizer's own replay.
    -- CORRECTED this round: terminal_related_credential_id is permitted
    -- ONLY for 'active_credential_already_exists' by the approved
    -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
    -- (§1.7) — 'expected_credential_changed' always leaves it null, so no
    -- lookup through it is ever performed here. This finalizer has no
    -- cancellation reason that uses terminal_related_credential_id at
    -- all (active_credential_already_exists is a defense-in-depth
    -- constraint-collision outcome for reissue, never a pending-path
    -- cancellation reason set by this function); the stable outcome name
    -- alone is always sufficient to replay 'expected_credential_changed'.
    v_result.outcome := v_op.terminal_reason_code;
    return v_result;
  end if;

  if v_op.status <> 'pending' then
    -- Unsupported/unknown status — never guess. Same safe conflict
    -- outcome finalizers already use for an unrecognized state.
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  -- Pending-operation shape checks: this finalizer handles REISSUE only.
  -- An issue operation reaching this function would be a caller bug
  -- (Node calling the wrong finalizer for the operation's own recorded
  -- type) — rejected as an exception, not a lifecycle outcome, since it
  -- can never legitimately happen through the approved Node-side flow.
  if v_op.operation_type <> 'reissue' then
    raise exception 'finalize_qr_reissue_for_server called for a non-reissue operation';
  end if;
  if v_op.expected_current_credential_id is null then
    raise exception 'reissue operation is missing its required expected_current_credential_id';
  end if;
  if v_op.channel not in ('participant_self_service', 'staff_individual', 'staff_bulk') then
    raise exception 'reissue operation carries an unrecognized channel';
  end if;
  if v_op.application_id is null or v_op.requested_by_auth_user_id is null then
    raise exception 'reissue operation is missing required durable requester/application information';
  end if;
  -- Channel/batch-binding consistency — identical internal-invariant
  -- check to the issuance finalizer's own.
  if v_op.channel = 'staff_bulk' and v_op.bulk_batch_id is null then
    raise exception 'staff_bulk reissue operation is missing its required bulk_batch_id';
  end if;
  if v_op.channel <> 'staff_bulk' and v_op.bulk_batch_id is not null then
    raise exception 'non-staff_bulk reissue operation unexpectedly carries a bulk_batch_id';
  end if;

  -- TWO-STAGE TTL CHECK, stage one: an EARLY check runs immediately
  -- after the operation lock, before any further lock is taken — an
  -- already-expired operation never touches the batch/application/
  -- credential locks at all.
  if v_op.expires_at <= clock_timestamp() then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_transition_now, terminal_reason_code = 'ttl_expired'
    where id = v_op.id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  -- Position 2: durable bulk-batch row, FOR SHARE, ONLY for staff_bulk —
  -- locked here, but NO business outcome is returned yet; every
  -- pending-path business decision is evaluated together, in the
  -- approved order, only after every required lock (through position 5)
  -- is held.
  if v_op.channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches where id = v_op.bulk_batch_id for share;
  end if;

  -- Position 3: application row, FOR UPDATE.
  select * into v_app from public.applications where id = v_op.application_id for update;

  -- Position 4: current active credential row, FOR UPDATE — selected
  -- ONLY by application_id + status = 'active'; never a caller-supplied
  -- "old credential" row or actor identity.
  select * into v_current_active from public.qr_credentials
    where application_id = v_op.application_id and status = 'active' for update;

  -- Position 5: encryption-key registry row, FOR SHARE, via the shared
  -- helper (which itself takes this exact lock). CORRECTED this round:
  -- the authoritative timestamp used for the TTL recheck and every
  -- pending-path decision was previously captured immediately after
  -- position 4 — BEFORE this lock — leaving a gap where the operation
  -- could expire while THIS call itself waited to acquire the
  -- key-registry row, and still be finalized/rejected using a stale
  -- pre-wait timestamp. The key-active result is stored here in
  -- v_key_is_active WITHOUT yet deciding anything; the authoritative
  -- v_now below is captured only AFTER this lock, and every decision —
  -- including this key-version-active outcome, now evaluated last in the
  -- approved precedence rather than the moment its lock is acquired — is
  -- made from that single, final timestamp. This exactly mirrors the
  -- identical narrow correction applied to finalize_qr_issuance_for_server
  -- this same round.
  v_key_is_active := public.is_encryption_key_version_active(p_new_encryption_key_version);

  -- ONE authoritative timestamp, captured only after every required lock
  -- (through position 5) is held — reused for every timestamp field this
  -- finalizer writes from here on, AND for the authoritative TTL
  -- recheck below (stage two), which must win over every other business
  -- decision.
  v_now := clock_timestamp();

  -- Decision 1: TTL, rechecked authoritatively now that every required
  -- lock is held.
  if v_op.expires_at <= v_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_now, terminal_reason_code = 'ttl_expired'
    where id = v_op.id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  -- Decision 2: application eligibility.
  if v_app.id is null or v_app.status <> 'accepted' then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'application_ineligible'
    where id = v_op.id;
    v_result.outcome := 'application_ineligible';
    return v_result;
  end if;

  -- Decision 3: staff-channel requester authorization, re-verified at
  -- finalization time.
  if v_op.channel in ('staff_individual', 'staff_bulk') then
    select role into v_caller_role from public.profiles where id = v_op.requested_by_auth_user_id;
    if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'requester_no_longer_authorized'
      where id = v_op.id;
      v_result.outcome := 'requester_no_longer_authorized';
      return v_result;
    end if;
  end if;

  -- Decision 4: staff_bulk batch availability — the row was already
  -- locked at position 2, above (immediately after the operation lock,
  -- before the application/credential/key locks); this is simply the
  -- first point in the approved decision precedence at which a business
  -- outcome based on that already-held lock may be returned.
  if v_op.channel = 'staff_bulk' then
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= v_now
       or v_batch.intended_operation_type <> 'reissue'
       or v_batch.created_by_auth_user_id is distinct from v_op.requested_by_auth_user_id
       or v_batch.created_by_profile_id is distinct from v_op.requested_by_profile_id
    then
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = v_op.id;
      v_result.outcome := 'bulk_batch_unavailable';
      return v_result;
    end if;
  end if;

  -- Decision 5: no active credential exists at all — reissue's own
  -- credential-existence requirement (the inverse of issuance's
  -- "active-credential-already-exists" conflict).
  if v_current_active.id is null then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'no_active_credential'
    where id = v_op.id;
    v_result.outcome := 'no_active_credential';
    return v_result;
  end if;

  -- Decision 6: the active credential does not match the operation's own
  -- durable expected_current_credential_id. CORRECTED this round:
  -- terminal_related_credential_id is permitted ONLY for
  -- 'active_credential_already_exists' by the approved
  -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
  -- (§1.7) — it must remain null here. The stable outcome name alone
  -- (with no credential_id/status/issued_at) is the entire durable
  -- result; a fresh caller who wants to know the current active
  -- credential can simply reserve a new reissue operation, which itself
  -- re-reads live state.
  if v_current_active.id <> v_op.expected_current_credential_id then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'expected_credential_changed',
        terminal_related_credential_id = null
    where id = v_op.id;
    v_result.outcome := 'expected_credential_changed';
    return v_result;
  end if;

  -- Decision 7: encryption-key version active state — the lock was
  -- already acquired at position 5, above; the result computed there
  -- (v_key_is_active) is evaluated LAST among all pending-path
  -- validations, per the approved order — a missing, decrypt_only, or
  -- retired key is the one RETRYABLE outcome: the operation remains
  -- pending, untouched, and neither the old credential nor audit history
  -- is modified.
  if not v_key_is_active then
    v_result.outcome := 'key_version_not_active';
    return v_result; -- operation remains pending, old credential remains active, untouched
  end if;

  -- Canonical fingerprint, computed ONLY through the shared helper — no
  -- ad-hoc format. Domain-separated for reissue ('rcoy:qr-finalization:v1'
  -- + 'reissue'), binding the NEW credential id, new token hash, new
  -- token version, new encryption-key version, and a digest of the new
  -- ciphertext envelope.
  v_fingerprint := public.compute_qr_finalization_fingerprint(
    'reissue', p_new_credential_id, p_new_token_hash, p_new_token_version, p_new_encryption_key_version, p_new_token_ciphertext
  );

  -- The old-credential replacement, new-credential insert, deferred-FK
  -- IMMEDIATE check, lifecycle consumed-transition, and success audit
  -- insert are ALL atomic: everything happens inside this one inner
  -- exception block, and either all commit together or (on any
  -- exception, including a caught unique_violation re-raised as a
  -- controlled outcome, or a caught foreign_key_violation from the
  -- forced-IMMEDIATE deferred constraint check) all roll back together
  -- — it is unacceptable for the OLD credential to become unusable
  -- (replaced) while the NEW credential's creation fails; both the
  -- active-to-replaced UPDATE and the new-row INSERT below are inside
  -- this SAME block precisely so a failure at any point rolls both back
  -- as one unit, leaving the OLD credential exactly as it was
  -- ('active', untouched) and the operation still 'pending' (retryable).
  --
  -- Order is REQUIRED, not arbitrary: the old row must leave 'active'
  -- status BEFORE the new row can become 'active' (satisfying
  -- qr_credentials_one_active_per_application, a same-statement
  -- non-deferrable partial unique index with no ordering flexibility) —
  -- so the UPDATE runs first. The deferred composite FK
  -- (qr_credentials_replacement_same_application_fkey) is what makes
  -- this legal despite the OLD row's UPDATE referencing a
  -- replaced_by_credential_id (p_new_credential_id) that does not exist
  -- yet at the moment of that UPDATE — the FK's referential check is
  -- deferred to (at latest) COMMIT, by which point the INSERT below has
  -- already made the referenced row exist.
  declare
    v_constraint_name text;
  begin
    update public.qr_credentials
    set status = 'replaced', token_ciphertext = null, encryption_key_version = null,
        replaced_at = v_now, replaced_by_credential_id = p_new_credential_id,
        reissue_channel = v_op.channel, reissue_reason_code = v_op.reason_code, reissue_note = v_op.note,
        -- Actor semantics for the OLD credential: participant_self_service
        -- -> null; staff_individual/staff_bulk -> the operation's own
        -- durable requested_by_profile_id (never the service-role
        -- identity, never re-resolved from any authenticated session —
        -- none exists inside this service-role-only function).
        replaced_by = case when v_op.channel = 'participant_self_service' then null else v_op.requested_by_profile_id end
    where id = v_current_active.id;

    insert into public.qr_credentials (
      id, application_id, token_hash, token_ciphertext, token_version, encryption_key_version,
      status, issuance_channel, issuance_reason_code, issuance_note,
      issued_at, created_at, issued_by
    ) values (
      p_new_credential_id, v_op.application_id, p_new_token_hash, p_new_token_ciphertext, p_new_token_version, p_new_encryption_key_version,
      'active', v_op.channel,
      -- The NEW credential's own issuance_reason_code/issuance_note are
      -- ALWAYS null for a reissue — there is no "reissued_credential"
      -- value in the approved issuance-reason vocabulary, and inventing
      -- one is explicitly out of scope. The reissue's own reason/note
      -- live durably on the OLD (now-replaced) credential's
      -- reissue_reason_code/reissue_note, set above, never here.
      null, null,
      v_now, v_now,
      case when v_op.channel = 'participant_self_service' then null else v_op.requested_by_profile_id end
    );

    -- Force the deferred same-application replacement FK to IMMEDIATE
    -- and let it actually run its check HERE, inside this controlled
    -- block, rather than silently at COMMIT after this RPC has already
    -- returned a result to the caller. SET CONSTRAINTS is transaction-
    -- scoped and affects only the remainder of THIS transaction (which
    -- ends when this function returns and its caller's own transaction
    -- boundary completes — for a service-role RPC call, that is this
    -- statement's own implicit transaction).
    set constraints public.qr_credentials_replacement_same_application_fkey immediate;

    update public.qr_lifecycle_operations
    set status = 'consumed', consumed_at = v_now, finalized_at = v_now,
        resulting_credential_id = p_new_credential_id, finalization_fingerprint = v_fingerprint,
        terminal_reason_code = null, terminal_related_credential_id = null, terminal_retry_after_at = null
    where id = v_op.id;

    -- Safe metadata only — never token hash, ciphertext, nonce, key
    -- material, or fingerprint.
    insert into public.audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, created_at)
    values (
      'qr_credential', p_new_credential_id, 'reissued',
      case when v_op.channel = 'participant_self_service' then 'system' else 'admin' end,
      case when v_op.channel = 'participant_self_service' then v_op.requested_by_auth_user_id else v_op.requested_by_profile_id end,
      jsonb_build_object(
        'application_id', v_op.application_id, 'old_credential_id', v_current_active.id,
        'new_credential_id', p_new_credential_id, 'reissue_channel', v_op.channel,
        'reissue_reason_code', v_op.reason_code
      ),
      v_now
    );
  exception
    when unique_violation then
      declare
        v_conflicting_credential public.qr_credentials;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name = 'qr_credentials_token_hash_unique' then
          -- The new token hash already belongs to a DIFFERENT,
          -- already-inserted credential row. The operation remains
          -- pending (retryable with fresh input); the OLD credential's
          -- active-to-replaced UPDATE rolls back together with the
          -- failed INSERT, so the old credential remains active,
          -- unchanged; no new credential, no success audit row.
          v_result.outcome := 'token_hash_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_credentials_pkey' then
          -- p_new_credential_id collides with an existing row belonging
          -- to a DIFFERENT operation entirely.
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_credentials_replacement_target_unique' then
          -- p_new_credential_id is already recorded as the
          -- replaced_by_credential_id of a DIFFERENT old credential row
          -- — never legitimate for a fresh reissue targeting THIS old
          -- credential.
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_credentials_one_active_per_application' then
          -- The old-row UPDATE above should have already freed this
          -- application's active slot before the INSERT ever ran — a
          -- violation here means a DIFFERENT active credential appeared
          -- for this application between this transaction's own
          -- position-4 lock and this exact statement (should be
          -- structurally impossible under that lock, but resolved
          -- safely rather than exposing a raw violation, per the
          -- approved defense-in-depth discipline used throughout this
          -- design). Re-inspect authoritatively rather than guess.
          select * into v_conflicting_credential from public.qr_credentials
            where application_id = v_op.application_id and status = 'active';
          if v_conflicting_credential.id is not null then
            v_result.outcome := 'active_credential_already_exists';
            v_result.credential_id := v_conflicting_credential.id;
            v_result.status := v_conflicting_credential.status;
            v_result.issued_at := v_conflicting_credential.issued_at;
            return v_result;
          end if;
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_lifecycle_operations_resulting_credential_unique_idx' then
          -- p_new_credential_id is already recorded as the RESULT of a
          -- different lifecycle operation — never legitimate for a
          -- fresh reissue.
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        else
          raise;
        end if;
      end;
    when foreign_key_violation then
      -- CORRECTED this round: previously every foreign_key_violation in
      -- this block was unconditionally mapped to idempotency_conflict —
      -- too broad, since it could silently mask an unrelated integrity
      -- failure (applications, profiles, audit rows, actors, or any
      -- future foreign key touched by this block) behind a misleading
      -- "safe" outcome instead of surfacing the real defect. Only the
      -- ONE expected constraint — the forced-IMMEDIATE deferred
      -- same-application replacement FK
      -- (qr_credentials_replacement_same_application_fkey), checked HERE,
      -- inside this controlled block, never silently at commit after
      -- this RPC has already returned a result — is mapped to a
      -- controlled outcome. This should be structurally unreachable
      -- given the INSERT immediately above always creates a row
      -- satisfying (id, application_id) for the exact application_id the
      -- OLD row's UPDATE just referenced; retained as defense-in-depth,
      -- consistent with every other named-constraint mapping in this
      -- function. Every OTHER foreign_key_violation is re-raised so the
      -- entire outer transaction rolls back and the real defect is never
      -- misreported as a routine idempotency conflict.
      get stacked diagnostics v_constraint_name = constraint_name;
      if v_constraint_name = 'qr_credentials_replacement_same_application_fkey' then
        v_result.outcome := 'idempotency_conflict';
        return v_result;
      end if;
      raise;
  end;

  v_result.outcome := 'reissued';
  v_result.credential_id := p_new_credential_id;
  v_result.status := 'active';
  v_result.issued_at := v_now;
  return v_result;
end;
$$;

revoke all on function public.finalize_qr_reissue_for_server(uuid, uuid, bytea, bytea, smallint, smallint) from public, anon, authenticated;
grant execute on function public.finalize_qr_reissue_for_server(uuid, uuid, bytea, bytea, smallint, smallint) to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260805235959_phase6_qr_issuance_reissue')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260810000000_fix_qr_finalizer_audit_actor_type_cast.sql
-- ============================================================
-- 20260810000000_fix_qr_finalizer_audit_actor_type_cast.sql
--
-- Corrective migration for a genuine production defect discovered during
-- the Phase 6 cloud executable-verification gate (20260805235959_phase6_
-- qr_issuance_reissue.sql), confirmed by real end-to-end test execution
-- against a disposable Supabase Cloud project, not by static review.
--
-- Bug: in both finalize_qr_issuance_for_server and
-- finalize_qr_reissue_for_server, the audit_logs.actor_type value on the
-- success-path audit insert is computed via
--   case when v_op.channel = 'participant_self_service' then 'system' else 'admin' end
-- Both CASE branches are untyped string literals, so Postgres resolves the
-- CASE expression itself to type text (not unknown) — and text does not
-- implicitly cast to the audit_actor_type enum on INSERT, so every
-- successful issuance/reissue's own audit-log write fails with:
--   42804: column "actor_type" is of type audit_actor_type but expression is of type text
-- This fires on the real success path of both finalizers, not on any
-- test-only code — it was never previously exercised end-to-end.
--
-- Fix: an explicit ::audit_actor_type cast on the CASE expression. Every
-- other line below is byte-for-byte identical to the already-applied
-- 20260805235959 migration's own function bodies (diffed to confirm) —
-- no other logic, lock ordering, idempotency behavior, audit semantics,
-- signature, security context, or grant changes. The other five
-- audit_logs inserts elsewhere in 20260805235959_phase6_qr_issuance_
-- reissue.sql use bare literals directly in a VALUES/SELECT list (which
-- Postgres correctly infers against the target column's type in that
-- position) and were verified NOT to have this defect — left untouched.
--
-- The already-applied 20260805235959 migration is intentionally left
-- unmodified: it has already run against the disposable cloud project, so
-- editing it in place would not affect that already-created database
-- state and would create migration-history drift. This corrective
-- migration instead CREATE OR REPLACEs both affected functions using
-- their exact existing signatures.

create or replace function public.finalize_qr_issuance_for_server(
  p_operation_id uuid,
  p_credential_id uuid,
  p_token_hash bytea,
  p_token_ciphertext bytea,
  p_token_version smallint,
  p_encryption_key_version smallint
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_op public.qr_lifecycle_operations;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_caller_role text;
  v_batch public.qr_bulk_operation_batches;
  v_key_is_active boolean;
  v_now timestamptz;
  v_transition_now timestamptz;
  v_fingerprint bytea;
  v_existing_credential public.qr_credentials;
  v_result public.qr_credential_lifecycle_result;
begin
  -- Input-shape validation BEFORE any lock is taken — malformed input is
  -- rejected as an exception, never represented as a lifecycle-result
  -- outcome, exactly mirroring every reservation RPC's own discipline.
  if p_operation_id is null then raise exception 'operation_id is required'; end if;
  if p_credential_id is null then raise exception 'credential_id is required'; end if;
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'token_hash must be exactly 32 bytes';
  end if;
  if p_token_ciphertext is null or octet_length(p_token_ciphertext) <> 61 then
    raise exception 'token_ciphertext must be exactly 61 bytes';
  end if;
  if get_byte(p_token_ciphertext, 0) <> 1 then
    raise exception 'Unsupported ciphertext envelope version';
  end if;
  if p_token_version is null or p_token_version not between 1 and 32767 then
    raise exception 'Invalid token_version';
  end if;
  if p_encryption_key_version is null or p_encryption_key_version not between 1 and 32767 then
    raise exception 'Invalid encryption_key_version';
  end if;

  -- Position 1: lifecycle operation row, FOR UPDATE, locked and
  -- inspected FIRST, before any other row.
  select * into v_op from public.qr_lifecycle_operations where id = p_operation_id for update;
  if v_op.id is null then raise exception 'Lifecycle operation not found'; end if;

  -- Historical states handled FIRST, before any further lock —
  -- 'consumed'/'expired'/'cancelled' are all fully resolved by the
  -- operation row alone.
  if v_op.status = 'consumed' then
    -- Idempotent replay: recompute the SAME canonical fingerprint from
    -- THIS call's supplied inputs and compare against the durably stored
    -- one — never re-derived from the current qr_credentials row.
    -- CORRECTED this round: the replayed result itself must ALSO never be
    -- derived from the current qr_credentials row — a resulting credential
    -- may later become revoked or replaced, and exact finalizer replay
    -- must not change because of that later lifecycle transition. Every
    -- field returned here comes exclusively from the durable
    -- qr_lifecycle_operations row: credential_id from
    -- resulting_credential_id, status hardcoded to 'active' (the state at
    -- the successful finalization transition, never re-queried), and
    -- issued_at from finalized_at (guaranteed equal to the credential's
    -- own issued_at at the moment of that same transition). This branch
    -- no longer depends on the resulting credential row still being
    -- queryable, its current status, its ciphertext, its current
    -- encryption-key version, or any later revocation/replacement field.
    v_fingerprint := public.compute_qr_finalization_fingerprint(
      'issue', p_credential_id, p_token_hash, p_token_version, p_encryption_key_version, p_token_ciphertext
    );
    if v_fingerprint = v_op.finalization_fingerprint and p_credential_id = v_op.resulting_credential_id then
      v_result.outcome := 'already_finalized';
      v_result.credential_id := v_op.resulting_credential_id;
      v_result.status := 'active';
      v_result.issued_at := v_op.finalized_at;
      return v_result;
    end if;
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  if v_op.status = 'expired' then
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  if v_op.status = 'cancelled' then
    -- Replay the durable terminal outcome without re-evaluating current
    -- state — identical discipline to every reservation RPC's own
    -- replay_cancelled path.
    v_result.outcome := v_op.terminal_reason_code;
    if v_op.terminal_reason_code = 'active_credential_already_exists' then
      select * into v_existing_credential from public.qr_credentials where id = v_op.terminal_related_credential_id;
      v_result.credential_id := v_existing_credential.id;
      v_result.status := v_existing_credential.status;
      v_result.issued_at := v_existing_credential.issued_at;
    end if;
    return v_result;
  end if;

  if v_op.status <> 'pending' then
    -- Unsupported/unknown status — never guess. Same safe conflict
    -- outcome finalizers already use for an unrecognized state.
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  -- Pending-operation shape checks: this finalizer handles ISSUANCE
  -- only. A reissue operation reaching this function would be a caller
  -- bug (Node calling the wrong finalizer for the operation's own
  -- recorded type) — rejected as an exception, not a lifecycle outcome,
  -- since it can never legitimately happen through the approved
  -- Node-side flow.
  if v_op.operation_type <> 'issue' then
    raise exception 'finalize_qr_issuance_for_server called for a non-issue operation';
  end if;
  if v_op.expected_current_credential_id is not null then
    raise exception 'issuance operation unexpectedly carries a non-null expected_current_credential_id';
  end if;
  if v_op.channel not in ('participant_self_service', 'staff_individual', 'staff_bulk') then
    raise exception 'issuance operation carries an unrecognized channel';
  end if;
  if v_op.application_id is null or v_op.requested_by_auth_user_id is null then
    raise exception 'issuance operation is missing required durable requester/application information';
  end if;
  -- Channel/batch-binding consistency: never silently ignore an
  -- unexpected combination. staff_bulk MUST carry a non-null
  -- bulk_batch_id; every other channel MUST carry a null one — exactly
  -- mirroring qr_lifecycle_operations_bulk_batch_matches_channel's own
  -- invariant, restated here as a controlled internal-invariant check
  -- rather than trusted blindly (a row reaching this function that
  -- somehow violates its own table constraint would indicate a real bug
  -- elsewhere, not a business outcome to guess about).
  if v_op.channel = 'staff_bulk' and v_op.bulk_batch_id is null then
    raise exception 'staff_bulk issuance operation is missing its required bulk_batch_id';
  end if;
  if v_op.channel <> 'staff_bulk' and v_op.bulk_batch_id is not null then
    raise exception 'non-staff_bulk issuance operation unexpectedly carries a bulk_batch_id';
  end if;

  -- TWO-STAGE TTL CHECK (this round's correction, alongside the batch-
  -- lock reordering below): an EARLY check, immediately after the
  -- operation lock, avoids taking any further lock (batch, application,
  -- credential) for an operation that is already expired — no reason to
  -- lock rows this call will never touch. This does NOT replace the
  -- authoritative recheck after every required lock is held (below) —
  -- clock_timestamp() can advance arbitrarily far while THIS call itself
  -- waits on the batch/application/credential locks, so the operation
  -- could still expire during that wait even though this early check
  -- passed.
  if v_op.expires_at <= clock_timestamp() then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_transition_now, terminal_reason_code = 'ttl_expired'
    where id = v_op.id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  -- Position 2: durable bulk-batch row, FOR SHARE, ONLY for staff_bulk —
  -- locked immediately after the operation lock (and the early TTL
  -- check, which takes no lock of its own), BEFORE the application lock,
  -- and held for the remainder of this transaction (never released
  -- early) so a concurrent batch completion/cancellation is blocked
  -- until this finalization commits or rolls back. No pre-lock read of
  -- authoritative batch state occurs anywhere above this line. The batch
  -- row is selected and locked here, but NO business outcome
  -- (bulk_batch_unavailable or otherwise) is returned yet — every
  -- pending-path business decision, including this one, is evaluated
  -- together, in the approved TTL-first order, only after every required
  -- lock (batch, application, credential) is held.
  if v_op.channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches where id = v_op.bulk_batch_id for share;
  end if;

  -- Position 3: application row, FOR UPDATE.
  select * into v_app from public.applications where id = v_op.application_id for update;

  -- Position 4: current active credential row, FOR UPDATE.
  select * into v_current_active from public.qr_credentials
    where application_id = v_op.application_id and status = 'active' for update;

  -- Position 5: encryption-key registry row, FOR SHARE, via the shared
  -- helper (which itself takes this exact lock). CORRECTED this round:
  -- the authoritative timestamp used for the TTL recheck and every
  -- pending-path decision was previously captured immediately after
  -- position 4 — BEFORE this lock — leaving a gap where the operation
  -- could expire while THIS call itself waited to acquire the
  -- key-registry row, and still be finalized/rejected using a stale
  -- pre-wait timestamp. The key-active result is stored here in
  -- v_key_is_active WITHOUT yet deciding anything; the authoritative
  -- v_now below is captured only AFTER this lock, and every decision —
  -- including the key-version-active outcome, now evaluated last in the
  -- approved precedence rather than the moment its lock is acquired — is
  -- made from that single, final timestamp. Identical narrow correction
  -- to the one applied to finalize_qr_reissue_for_server this same
  -- round; this genuine defect was discovered only after this
  -- function's own earlier static approval, and no other logic in this
  -- function is touched.
  v_key_is_active := public.is_encryption_key_version_active(p_encryption_key_version);

  -- ONE authoritative timestamp, captured only after every required lock
  -- (through position 5) is held — reused for every timestamp field this
  -- finalizer writes from here on, AND for the authoritative TTL
  -- recheck below, which must win over every other business decision
  -- (requester authorization, batch availability, application
  -- eligibility, credential conflict, key-version-active) exactly as the
  -- early check's own comment states: this call's own wait on every lock
  -- above may itself have taken long enough for the operation to expire
  -- since the early check passed.
  v_now := clock_timestamp();

  -- Decision 1: TTL, rechecked authoritatively now that every required
  -- lock is held.
  if v_op.expires_at <= v_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_now, terminal_reason_code = 'ttl_expired'
    where id = v_op.id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  -- Decision 2: application eligibility. The batch row (for staff_bulk)
  -- was already locked at position 2 above, but its OWN business
  -- decision is evaluated later, at decision 4 below, preserving the
  -- exact approved precedence order (TTL -> application ->
  -- requester-authorization -> batch -> credential-conflict) — locking
  -- early (to close the race the batch could otherwise be mutated
  -- through) is independent of, and does not change, WHEN each decision
  -- is allowed to return a result.
  if v_app.id is null or v_app.status <> 'accepted' then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'application_ineligible'
    where id = v_op.id;
    v_result.outcome := 'application_ineligible';
    return v_result;
  end if;

  -- Decision 3: staff-channel requester authorization, re-verified at
  -- finalization time — a staff member's role can lapse in the window
  -- between reservation and finalization, and the operation must not be
  -- finalized on their behalf once that has happened.
  if v_op.channel in ('staff_individual', 'staff_bulk') then
    select role into v_caller_role from public.profiles where id = v_op.requested_by_auth_user_id;
    if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'requester_no_longer_authorized'
      where id = v_op.id;
      v_result.outcome := 'requester_no_longer_authorized';
      return v_result;
    end if;
  end if;

  -- Decision 4: staff_bulk batch availability — the row was already
  -- locked at position 2, above (immediately after the operation lock,
  -- before the application/credential locks); this is simply the first
  -- point in the approved DECISION precedence at which a business
  -- outcome based on that already-held lock may be returned.
  if v_op.channel = 'staff_bulk' then
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= v_now
       or v_batch.intended_operation_type <> 'issue'
       or v_batch.created_by_auth_user_id is distinct from v_op.requested_by_auth_user_id
       or v_batch.created_by_profile_id is distinct from v_op.requested_by_profile_id
    then
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = v_op.id;
      v_result.outcome := 'bulk_batch_unavailable';
      return v_result;
    end if;
  end if;

  -- Decision 5: active-credential conflict — never create a second
  -- active credential for the same application.
  if v_current_active.id is not null then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'active_credential_already_exists',
        terminal_related_credential_id = v_current_active.id
    where id = v_op.id;
    v_result.outcome := 'active_credential_already_exists';
    v_result.credential_id := v_current_active.id;
    v_result.status := v_current_active.status;
    v_result.issued_at := v_current_active.issued_at;
    return v_result;
  end if;

  -- Decision 6: encryption-key version active state — the lock was
  -- already acquired at position 5, above; the result computed there
  -- (v_key_is_active) is evaluated LAST among all pending-path
  -- validations, per the approved order — a missing, decrypt_only, or
  -- retired key is the one RETRYABLE outcome: the operation remains
  -- pending, never cancelled/expired/consumed, since Node can simply
  -- re-fetch the current active key version and retry with fresh crypto
  -- material against this SAME operation before its TTL elapses.
  if not v_key_is_active then
    v_result.outcome := 'key_version_not_active';
    return v_result; -- operation remains pending, untouched
  end if;

  -- Canonical fingerprint, computed ONLY through the shared helper — no
  -- ad-hoc format. Domain-separated for issuance
  -- ('rcoy:qr-finalization:v1' + 'issue'), binding credential id, token
  -- hash, token version, encryption-key version, and a digest of the
  -- ciphertext envelope.
  v_fingerprint := public.compute_qr_finalization_fingerprint(
    'issue', p_credential_id, p_token_hash, p_token_version, p_encryption_key_version, p_token_ciphertext
  );

  -- The credential insert, lifecycle consumed-transition, and success
  -- audit insert are atomic: all three happen inside this one inner
  -- exception block, and either all commit together or (on any
  -- exception, including a caught unique_violation re-raised as a
  -- controlled outcome) all roll back together, leaving the operation's
  -- OUTER row lock (acquired at position 1, still held across this whole
  -- function) available so the function can still return a controlled,
  -- safe result even when the insert itself fails. The lifecycle
  -- operation is never marked consumed before the credential row, its
  -- fingerprint, and every success invariant have already been
  -- persisted.
  begin
    insert into public.qr_credentials (
      id, application_id, token_hash, token_ciphertext, token_version, encryption_key_version,
      status, issuance_channel, issuance_reason_code, issuance_note,
      issued_at, created_at, issued_by
    ) values (
      p_credential_id, v_op.application_id, p_token_hash, p_token_ciphertext, p_token_version, p_encryption_key_version,
      'active', v_op.channel, v_op.reason_code, v_op.note,
      v_now, v_now,
      -- Actor semantics: participant_self_service -> null; staff_individual/
      -- staff_bulk -> the operation's own durable requested_by_profile_id
      -- (never the service-role identity, never re-resolved from
      -- auth.uid() — there is no authenticated client session inside this
      -- SECURITY DEFINER, service-role-only function; the ONLY trustworthy
      -- staff actor identity available here is the one the reservation RPC
      -- already durably recorded).
      case when v_op.channel = 'participant_self_service' then null else v_op.requested_by_profile_id end
    );

    update public.qr_lifecycle_operations
    set status = 'consumed', consumed_at = v_now, finalized_at = v_now,
        resulting_credential_id = p_credential_id, finalization_fingerprint = v_fingerprint,
        terminal_reason_code = null, terminal_related_credential_id = null, terminal_retry_after_at = null
    where id = v_op.id;

    -- Safe metadata only — never token hash, ciphertext, nonce, key
    -- material, or fingerprint.
    insert into public.audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, created_at)
    values (
      'qr_credential', p_credential_id, 'issued',
      (case when v_op.channel = 'participant_self_service' then 'system' else 'admin' end)::audit_actor_type,
      case when v_op.channel = 'participant_self_service' then v_op.requested_by_auth_user_id else v_op.requested_by_profile_id end,
      jsonb_build_object('application_id', v_op.application_id, 'issuance_channel', v_op.channel, 'issuance_reason_code', v_op.reason_code),
      v_now
    );
  exception
    when unique_violation then
      declare
        v_constraint_name text;
        v_conflicting_credential public.qr_credentials;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name = 'qr_credentials_token_hash_unique' then
          -- The token hash already belongs to a DIFFERENT, already-
          -- inserted credential row — a Node-side random-generation
          -- collision or a genuine concurrent-finalizer race on the same
          -- hash. The operation remains pending (retryable with fresh
          -- input); no partial credential, no success audit row (this
          -- whole block rolled back together).
          v_result.outcome := 'token_hash_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_credentials_pkey' then
          -- p_credential_id collides with an existing row belonging to a
          -- DIFFERENT operation entirely (this operation's own resulting_
          -- credential_id is still null at this point in the flow, since
          -- the UPDATE above never committed) — resolve safely rather
          -- than expose the raw violation.
          select * into v_conflicting_credential from public.qr_credentials where id = p_credential_id;
          if v_conflicting_credential.id is not null and v_conflicting_credential.status = 'active'
             and v_conflicting_credential.application_id = v_op.application_id then
            -- The conflicting row IS this exact application's active
            -- credential — safe to resolve as the same controlled
            -- conflict outcome the pre-lock check above would have
            -- produced, identifying the credential rather than exposing
            -- a raw error.
            v_result.outcome := 'active_credential_already_exists';
            v_result.credential_id := v_conflicting_credential.id;
            v_result.status := v_conflicting_credential.status;
            v_result.issued_at := v_conflicting_credential.issued_at;
            return v_result;
          end if;
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_lifecycle_operations_resulting_credential_unique_idx' then
          -- p_credential_id is already recorded as the RESULT of a
          -- different lifecycle operation — never legitimate for a fresh
          -- issuance.
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        else
          raise;
        end if;
      end;
  end;

  v_result.outcome := 'issued';
  v_result.credential_id := p_credential_id;
  v_result.status := 'active';
  v_result.issued_at := v_now;
  return v_result;
end;
$$;

revoke all on function public.finalize_qr_issuance_for_server(uuid, uuid, bytea, bytea, smallint, smallint) from public, anon, authenticated;
grant execute on function public.finalize_qr_issuance_for_server(uuid, uuid, bytea, bytea, smallint, smallint) to service_role;

create or replace function public.finalize_qr_reissue_for_server(
  p_operation_id uuid,
  p_new_credential_id uuid,
  p_new_token_hash bytea,
  p_new_token_ciphertext bytea,
  p_new_token_version smallint,
  p_new_encryption_key_version smallint
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_op public.qr_lifecycle_operations;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_caller_role text;
  v_batch public.qr_bulk_operation_batches;
  v_key_is_active boolean;
  v_now timestamptz;
  v_transition_now timestamptz;
  v_fingerprint bytea;
  v_existing_credential public.qr_credentials;
  v_result public.qr_credential_lifecycle_result;
begin
  -- Input-shape validation BEFORE any lock is taken — malformed input is
  -- rejected as an exception, never represented as a lifecycle-result
  -- outcome, exactly mirroring the issuance finalizer's own discipline.
  if p_operation_id is null then raise exception 'operation_id is required'; end if;
  if p_new_credential_id is null then raise exception 'new_credential_id is required'; end if;
  if p_new_token_hash is null or octet_length(p_new_token_hash) <> 32 then
    raise exception 'new_token_hash must be exactly 32 bytes';
  end if;
  if p_new_token_ciphertext is null or octet_length(p_new_token_ciphertext) <> 61 then
    raise exception 'new_token_ciphertext must be exactly 61 bytes';
  end if;
  if get_byte(p_new_token_ciphertext, 0) <> 1 then
    raise exception 'Unsupported ciphertext envelope version';
  end if;
  if p_new_token_version is null or p_new_token_version not between 1 and 32767 then
    raise exception 'Invalid new_token_version';
  end if;
  if p_new_encryption_key_version is null or p_new_encryption_key_version not between 1 and 32767 then
    raise exception 'Invalid new_encryption_key_version';
  end if;

  -- Position 1: lifecycle operation row, FOR UPDATE, locked and
  -- inspected FIRST, before any other row.
  select * into v_op from public.qr_lifecycle_operations where id = p_operation_id for update;
  if v_op.id is null then raise exception 'Lifecycle operation not found'; end if;

  -- The new credential id must differ from the operation's own durable
  -- expected_current_credential_id — checked here, against the
  -- OPERATION's own recorded value (not any later-read live state),
  -- since it is available immediately once the operation is locked and
  -- is true for every legitimate call regardless of historical/pending
  -- status.
  if v_op.expected_current_credential_id is not null and p_new_credential_id = v_op.expected_current_credential_id then
    raise exception 'new_credential_id must differ from expected_current_credential_id';
  end if;

  -- Historical states handled FIRST, before any further lock —
  -- 'consumed'/'expired'/'cancelled' are all fully resolved by the
  -- operation row alone.
  if v_op.status = 'consumed' then
    -- Idempotent replay: recompute the SAME canonical fingerprint from
    -- THIS call's supplied inputs (domain 'reissue') and compare against
    -- the durably stored one — never re-derived from the current
    -- qr_credentials row. CORRECTED this round: the replayed RESULT
    -- itself must ALSO never be derived from the current qr_credentials
    -- row — a resulting credential may later become revoked or replaced,
    -- and exact finalizer replay must not change because of that later
    -- lifecycle transition. Every field returned here comes exclusively
    -- from the durable qr_lifecycle_operations row: credential_id from
    -- resulting_credential_id, status hardcoded to 'active' (the state at
    -- the successful finalization transition, never re-queried), and
    -- issued_at from finalized_at (guaranteed equal to the new
    -- credential's own issued_at at the moment of that same transition).
    -- This branch no longer depends on the resulting credential row still
    -- being queryable, its current status, its ciphertext, its current
    -- encryption-key version, or any later revocation/replacement field.
    v_fingerprint := public.compute_qr_finalization_fingerprint(
      'reissue', p_new_credential_id, p_new_token_hash, p_new_token_version, p_new_encryption_key_version, p_new_token_ciphertext
    );
    if v_fingerprint = v_op.finalization_fingerprint and p_new_credential_id = v_op.resulting_credential_id then
      v_result.outcome := 'already_finalized';
      v_result.credential_id := v_op.resulting_credential_id;
      v_result.status := 'active';
      v_result.issued_at := v_op.finalized_at;
      return v_result;
    end if;
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  if v_op.status = 'expired' then
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  if v_op.status = 'cancelled' then
    -- Replay the durable terminal outcome without re-evaluating current
    -- state — identical discipline to every reservation RPC's own
    -- replay_cancelled path and the issuance finalizer's own replay.
    -- CORRECTED this round: terminal_related_credential_id is permitted
    -- ONLY for 'active_credential_already_exists' by the approved
    -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
    -- (§1.7) — 'expected_credential_changed' always leaves it null, so no
    -- lookup through it is ever performed here. This finalizer has no
    -- cancellation reason that uses terminal_related_credential_id at
    -- all (active_credential_already_exists is a defense-in-depth
    -- constraint-collision outcome for reissue, never a pending-path
    -- cancellation reason set by this function); the stable outcome name
    -- alone is always sufficient to replay 'expected_credential_changed'.
    v_result.outcome := v_op.terminal_reason_code;
    return v_result;
  end if;

  if v_op.status <> 'pending' then
    -- Unsupported/unknown status — never guess. Same safe conflict
    -- outcome finalizers already use for an unrecognized state.
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  -- Pending-operation shape checks: this finalizer handles REISSUE only.
  -- An issue operation reaching this function would be a caller bug
  -- (Node calling the wrong finalizer for the operation's own recorded
  -- type) — rejected as an exception, not a lifecycle outcome, since it
  -- can never legitimately happen through the approved Node-side flow.
  if v_op.operation_type <> 'reissue' then
    raise exception 'finalize_qr_reissue_for_server called for a non-reissue operation';
  end if;
  if v_op.expected_current_credential_id is null then
    raise exception 'reissue operation is missing its required expected_current_credential_id';
  end if;
  if v_op.channel not in ('participant_self_service', 'staff_individual', 'staff_bulk') then
    raise exception 'reissue operation carries an unrecognized channel';
  end if;
  if v_op.application_id is null or v_op.requested_by_auth_user_id is null then
    raise exception 'reissue operation is missing required durable requester/application information';
  end if;
  -- Channel/batch-binding consistency — identical internal-invariant
  -- check to the issuance finalizer's own.
  if v_op.channel = 'staff_bulk' and v_op.bulk_batch_id is null then
    raise exception 'staff_bulk reissue operation is missing its required bulk_batch_id';
  end if;
  if v_op.channel <> 'staff_bulk' and v_op.bulk_batch_id is not null then
    raise exception 'non-staff_bulk reissue operation unexpectedly carries a bulk_batch_id';
  end if;

  -- TWO-STAGE TTL CHECK, stage one: an EARLY check runs immediately
  -- after the operation lock, before any further lock is taken — an
  -- already-expired operation never touches the batch/application/
  -- credential locks at all.
  if v_op.expires_at <= clock_timestamp() then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_transition_now, terminal_reason_code = 'ttl_expired'
    where id = v_op.id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  -- Position 2: durable bulk-batch row, FOR SHARE, ONLY for staff_bulk —
  -- locked here, but NO business outcome is returned yet; every
  -- pending-path business decision is evaluated together, in the
  -- approved order, only after every required lock (through position 5)
  -- is held.
  if v_op.channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches where id = v_op.bulk_batch_id for share;
  end if;

  -- Position 3: application row, FOR UPDATE.
  select * into v_app from public.applications where id = v_op.application_id for update;

  -- Position 4: current active credential row, FOR UPDATE — selected
  -- ONLY by application_id + status = 'active'; never a caller-supplied
  -- "old credential" row or actor identity.
  select * into v_current_active from public.qr_credentials
    where application_id = v_op.application_id and status = 'active' for update;

  -- Position 5: encryption-key registry row, FOR SHARE, via the shared
  -- helper (which itself takes this exact lock). CORRECTED this round:
  -- the authoritative timestamp used for the TTL recheck and every
  -- pending-path decision was previously captured immediately after
  -- position 4 — BEFORE this lock — leaving a gap where the operation
  -- could expire while THIS call itself waited to acquire the
  -- key-registry row, and still be finalized/rejected using a stale
  -- pre-wait timestamp. The key-active result is stored here in
  -- v_key_is_active WITHOUT yet deciding anything; the authoritative
  -- v_now below is captured only AFTER this lock, and every decision —
  -- including this key-version-active outcome, now evaluated last in the
  -- approved precedence rather than the moment its lock is acquired — is
  -- made from that single, final timestamp. This exactly mirrors the
  -- identical narrow correction applied to finalize_qr_issuance_for_server
  -- this same round.
  v_key_is_active := public.is_encryption_key_version_active(p_new_encryption_key_version);

  -- ONE authoritative timestamp, captured only after every required lock
  -- (through position 5) is held — reused for every timestamp field this
  -- finalizer writes from here on, AND for the authoritative TTL
  -- recheck below (stage two), which must win over every other business
  -- decision.
  v_now := clock_timestamp();

  -- Decision 1: TTL, rechecked authoritatively now that every required
  -- lock is held.
  if v_op.expires_at <= v_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_now, terminal_reason_code = 'ttl_expired'
    where id = v_op.id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  -- Decision 2: application eligibility.
  if v_app.id is null or v_app.status <> 'accepted' then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'application_ineligible'
    where id = v_op.id;
    v_result.outcome := 'application_ineligible';
    return v_result;
  end if;

  -- Decision 3: staff-channel requester authorization, re-verified at
  -- finalization time.
  if v_op.channel in ('staff_individual', 'staff_bulk') then
    select role into v_caller_role from public.profiles where id = v_op.requested_by_auth_user_id;
    if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'requester_no_longer_authorized'
      where id = v_op.id;
      v_result.outcome := 'requester_no_longer_authorized';
      return v_result;
    end if;
  end if;

  -- Decision 4: staff_bulk batch availability — the row was already
  -- locked at position 2, above (immediately after the operation lock,
  -- before the application/credential/key locks); this is simply the
  -- first point in the approved decision precedence at which a business
  -- outcome based on that already-held lock may be returned.
  if v_op.channel = 'staff_bulk' then
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= v_now
       or v_batch.intended_operation_type <> 'reissue'
       or v_batch.created_by_auth_user_id is distinct from v_op.requested_by_auth_user_id
       or v_batch.created_by_profile_id is distinct from v_op.requested_by_profile_id
    then
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = v_op.id;
      v_result.outcome := 'bulk_batch_unavailable';
      return v_result;
    end if;
  end if;

  -- Decision 5: no active credential exists at all — reissue's own
  -- credential-existence requirement (the inverse of issuance's
  -- "active-credential-already-exists" conflict).
  if v_current_active.id is null then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'no_active_credential'
    where id = v_op.id;
    v_result.outcome := 'no_active_credential';
    return v_result;
  end if;

  -- Decision 6: the active credential does not match the operation's own
  -- durable expected_current_credential_id. CORRECTED this round:
  -- terminal_related_credential_id is permitted ONLY for
  -- 'active_credential_already_exists' by the approved
  -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
  -- (§1.7) — it must remain null here. The stable outcome name alone
  -- (with no credential_id/status/issued_at) is the entire durable
  -- result; a fresh caller who wants to know the current active
  -- credential can simply reserve a new reissue operation, which itself
  -- re-reads live state.
  if v_current_active.id <> v_op.expected_current_credential_id then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'expected_credential_changed',
        terminal_related_credential_id = null
    where id = v_op.id;
    v_result.outcome := 'expected_credential_changed';
    return v_result;
  end if;

  -- Decision 7: encryption-key version active state — the lock was
  -- already acquired at position 5, above; the result computed there
  -- (v_key_is_active) is evaluated LAST among all pending-path
  -- validations, per the approved order — a missing, decrypt_only, or
  -- retired key is the one RETRYABLE outcome: the operation remains
  -- pending, untouched, and neither the old credential nor audit history
  -- is modified.
  if not v_key_is_active then
    v_result.outcome := 'key_version_not_active';
    return v_result; -- operation remains pending, old credential remains active, untouched
  end if;

  -- Canonical fingerprint, computed ONLY through the shared helper — no
  -- ad-hoc format. Domain-separated for reissue ('rcoy:qr-finalization:v1'
  -- + 'reissue'), binding the NEW credential id, new token hash, new
  -- token version, new encryption-key version, and a digest of the new
  -- ciphertext envelope.
  v_fingerprint := public.compute_qr_finalization_fingerprint(
    'reissue', p_new_credential_id, p_new_token_hash, p_new_token_version, p_new_encryption_key_version, p_new_token_ciphertext
  );

  -- The old-credential replacement, new-credential insert, deferred-FK
  -- IMMEDIATE check, lifecycle consumed-transition, and success audit
  -- insert are ALL atomic: everything happens inside this one inner
  -- exception block, and either all commit together or (on any
  -- exception, including a caught unique_violation re-raised as a
  -- controlled outcome, or a caught foreign_key_violation from the
  -- forced-IMMEDIATE deferred constraint check) all roll back together
  -- — it is unacceptable for the OLD credential to become unusable
  -- (replaced) while the NEW credential's creation fails; both the
  -- active-to-replaced UPDATE and the new-row INSERT below are inside
  -- this SAME block precisely so a failure at any point rolls both back
  -- as one unit, leaving the OLD credential exactly as it was
  -- ('active', untouched) and the operation still 'pending' (retryable).
  --
  -- Order is REQUIRED, not arbitrary: the old row must leave 'active'
  -- status BEFORE the new row can become 'active' (satisfying
  -- qr_credentials_one_active_per_application, a same-statement
  -- non-deferrable partial unique index with no ordering flexibility) —
  -- so the UPDATE runs first. The deferred composite FK
  -- (qr_credentials_replacement_same_application_fkey) is what makes
  -- this legal despite the OLD row's UPDATE referencing a
  -- replaced_by_credential_id (p_new_credential_id) that does not exist
  -- yet at the moment of that UPDATE — the FK's referential check is
  -- deferred to (at latest) COMMIT, by which point the INSERT below has
  -- already made the referenced row exist.
  declare
    v_constraint_name text;
  begin
    update public.qr_credentials
    set status = 'replaced', token_ciphertext = null, encryption_key_version = null,
        replaced_at = v_now, replaced_by_credential_id = p_new_credential_id,
        reissue_channel = v_op.channel, reissue_reason_code = v_op.reason_code, reissue_note = v_op.note,
        -- Actor semantics for the OLD credential: participant_self_service
        -- -> null; staff_individual/staff_bulk -> the operation's own
        -- durable requested_by_profile_id (never the service-role
        -- identity, never re-resolved from any authenticated session —
        -- none exists inside this service-role-only function).
        replaced_by = case when v_op.channel = 'participant_self_service' then null else v_op.requested_by_profile_id end
    where id = v_current_active.id;

    insert into public.qr_credentials (
      id, application_id, token_hash, token_ciphertext, token_version, encryption_key_version,
      status, issuance_channel, issuance_reason_code, issuance_note,
      issued_at, created_at, issued_by
    ) values (
      p_new_credential_id, v_op.application_id, p_new_token_hash, p_new_token_ciphertext, p_new_token_version, p_new_encryption_key_version,
      'active', v_op.channel,
      -- The NEW credential's own issuance_reason_code/issuance_note are
      -- ALWAYS null for a reissue — there is no "reissued_credential"
      -- value in the approved issuance-reason vocabulary, and inventing
      -- one is explicitly out of scope. The reissue's own reason/note
      -- live durably on the OLD (now-replaced) credential's
      -- reissue_reason_code/reissue_note, set above, never here.
      null, null,
      v_now, v_now,
      case when v_op.channel = 'participant_self_service' then null else v_op.requested_by_profile_id end
    );

    -- Force the deferred same-application replacement FK to IMMEDIATE
    -- and let it actually run its check HERE, inside this controlled
    -- block, rather than silently at COMMIT after this RPC has already
    -- returned a result to the caller. SET CONSTRAINTS is transaction-
    -- scoped and affects only the remainder of THIS transaction (which
    -- ends when this function returns and its caller's own transaction
    -- boundary completes — for a service-role RPC call, that is this
    -- statement's own implicit transaction).
    set constraints public.qr_credentials_replacement_same_application_fkey immediate;

    update public.qr_lifecycle_operations
    set status = 'consumed', consumed_at = v_now, finalized_at = v_now,
        resulting_credential_id = p_new_credential_id, finalization_fingerprint = v_fingerprint,
        terminal_reason_code = null, terminal_related_credential_id = null, terminal_retry_after_at = null
    where id = v_op.id;

    -- Safe metadata only — never token hash, ciphertext, nonce, key
    -- material, or fingerprint.
    insert into public.audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, created_at)
    values (
      'qr_credential', p_new_credential_id, 'reissued',
      (case when v_op.channel = 'participant_self_service' then 'system' else 'admin' end)::audit_actor_type,
      case when v_op.channel = 'participant_self_service' then v_op.requested_by_auth_user_id else v_op.requested_by_profile_id end,
      jsonb_build_object(
        'application_id', v_op.application_id, 'old_credential_id', v_current_active.id,
        'new_credential_id', p_new_credential_id, 'reissue_channel', v_op.channel,
        'reissue_reason_code', v_op.reason_code
      ),
      v_now
    );
  exception
    when unique_violation then
      declare
        v_conflicting_credential public.qr_credentials;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name = 'qr_credentials_token_hash_unique' then
          -- The new token hash already belongs to a DIFFERENT,
          -- already-inserted credential row. The operation remains
          -- pending (retryable with fresh input); the OLD credential's
          -- active-to-replaced UPDATE rolls back together with the
          -- failed INSERT, so the old credential remains active,
          -- unchanged; no new credential, no success audit row.
          v_result.outcome := 'token_hash_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_credentials_pkey' then
          -- p_new_credential_id collides with an existing row belonging
          -- to a DIFFERENT operation entirely.
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_credentials_replacement_target_unique' then
          -- p_new_credential_id is already recorded as the
          -- replaced_by_credential_id of a DIFFERENT old credential row
          -- — never legitimate for a fresh reissue targeting THIS old
          -- credential.
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_credentials_one_active_per_application' then
          -- The old-row UPDATE above should have already freed this
          -- application's active slot before the INSERT ever ran — a
          -- violation here means a DIFFERENT active credential appeared
          -- for this application between this transaction's own
          -- position-4 lock and this exact statement (should be
          -- structurally impossible under that lock, but resolved
          -- safely rather than exposing a raw violation, per the
          -- approved defense-in-depth discipline used throughout this
          -- design). Re-inspect authoritatively rather than guess.
          select * into v_conflicting_credential from public.qr_credentials
            where application_id = v_op.application_id and status = 'active';
          if v_conflicting_credential.id is not null then
            v_result.outcome := 'active_credential_already_exists';
            v_result.credential_id := v_conflicting_credential.id;
            v_result.status := v_conflicting_credential.status;
            v_result.issued_at := v_conflicting_credential.issued_at;
            return v_result;
          end if;
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_lifecycle_operations_resulting_credential_unique_idx' then
          -- p_new_credential_id is already recorded as the RESULT of a
          -- different lifecycle operation — never legitimate for a
          -- fresh reissue.
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        else
          raise;
        end if;
      end;
    when foreign_key_violation then
      -- CORRECTED this round: previously every foreign_key_violation in
      -- this block was unconditionally mapped to idempotency_conflict —
      -- too broad, since it could silently mask an unrelated integrity
      -- failure (applications, profiles, audit rows, actors, or any
      -- future foreign key touched by this block) behind a misleading
      -- "safe" outcome instead of surfacing the real defect. Only the
      -- ONE expected constraint — the forced-IMMEDIATE deferred
      -- same-application replacement FK
      -- (qr_credentials_replacement_same_application_fkey), checked HERE,
      -- inside this controlled block, never silently at commit after
      -- this RPC has already returned a result — is mapped to a
      -- controlled outcome. This should be structurally unreachable
      -- given the INSERT immediately above always creates a row
      -- satisfying (id, application_id) for the exact application_id the
      -- OLD row's UPDATE just referenced; retained as defense-in-depth,
      -- consistent with every other named-constraint mapping in this
      -- function. Every OTHER foreign_key_violation is re-raised so the
      -- entire outer transaction rolls back and the real defect is never
      -- misreported as a routine idempotency conflict.
      get stacked diagnostics v_constraint_name = constraint_name;
      if v_constraint_name = 'qr_credentials_replacement_same_application_fkey' then
        v_result.outcome := 'idempotency_conflict';
        return v_result;
      end if;
      raise;
  end;

  v_result.outcome := 'reissued';
  v_result.credential_id := p_new_credential_id;
  v_result.status := 'active';
  v_result.issued_at := v_now;
  return v_result;
end;
$$;

revoke all on function public.finalize_qr_reissue_for_server(uuid, uuid, bytea, bytea, smallint, smallint) from public, anon, authenticated;
grant execute on function public.finalize_qr_reissue_for_server(uuid, uuid, bytea, bytea, smallint, smallint) to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260810000000_fix_qr_finalizer_audit_actor_type_cast')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260811210000_fix_staff_blocker_resolver_channel_check.sql
-- ============================================================
-- Fixes a genuine Phase 6 authorization-semantics defect in
-- resolve_blocking_qr_lifecycle_staff_issuance_operation AND its reissue
-- counterpart resolve_blocking_qr_lifecycle_staff_reissue_operation, both
-- introduced in 20260805235959_phase6_qr_issuance_reissue.sql and both
-- carrying the identical defect (the reissue resolver's own step 1
-- comment states it is "identical precedence and rationale" to the
-- issuance resolver's).
--
-- ROOT CAUSE: reserve_or_reuse_qr_lifecycle_operation's domain-wide
-- other_pending_candidate lookup (application_id, operation_type = 'issue',
-- status = 'pending') has NO channel filter — the candidate it returns can
-- legitimately be a 'participant_self_service' pending issuance, not only
-- a staff-originated one. resolve_blocking_qr_lifecycle_staff_issuance_
-- operation's step 1, however, unconditionally required the candidate's
-- OWN requester to hold a staff-eligible role
-- (super_admin/program_attendance_manager), and terminalized anything
-- else with terminal_reason_code = 'requester_no_longer_authorized'.
--
-- A participant has no staff role and was never expected to hold one —
-- this check was designed (per that function's own introducing comment)
-- to catch a STAFF requester whose role lapses between reservation and
-- resolution, not to reject a legitimate participant self-service
-- candidate outright. The practical effect: a valid, still-pending
-- participant self-service issuance request racing a concurrent staff
-- issuance request for the SAME application was silently cancelled and
-- mislabeled as "requester no longer authorized," even though the
-- participant never lost any authorization they held. The competing
-- staff request then proceeded to insert its own row instead of
-- correctly observing another_operation_pending.
--
-- No approved migration comment anywhere in this codebase establishes a
-- product rule that staff issuance should preempt a valid participant
-- self-service issuance request. Absent such a rule, this fix makes the
-- resolver channel-aware: a staff-originated candidate
-- (staff_individual/staff_bulk) still has its own requester's staff role
-- re-verified exactly as before; a participant_self_service candidate
-- skips that check entirely and is evaluated purely on the SAME
-- application-eligibility -> credential-lock -> TTL -> credential-
-- conflict sequence resolve_blocking_qr_lifecycle_operation (the
-- participant issuance path's own resolver) already applies to it.
--
-- This is the smallest corrective change: only step 1's guard changes.
-- Every other step (bulk-batch availability, application eligibility,
-- credential lock ordering, TTL precedence, credential-conflict
-- resolution, terminal-reason vocabulary, audit/idempotency columns) is
-- byte-for-byte unchanged.
create or replace function public.resolve_blocking_qr_lifecycle_staff_issuance_operation(
  p_candidate public.qr_lifecycle_operations,
  p_app public.applications,
  out disposition text -- 'still_blocking' | 'terminalized'
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller_role text;
  v_batch public.qr_bulk_operation_batches;
  v_existing_credential public.qr_credentials;
  v_transition_now timestamptz;
  v_check_now timestamptz;
begin
  -- 1. Requester authorization, re-verified against the CANDIDATE's own
  -- recorded requester — but ONLY for a staff-originated candidate
  -- (staff_individual/staff_bulk). A participant_self_service candidate
  -- has no staff role to lapse and must never be evaluated against staff
  -- role eligibility; it is validated purely by the application/
  -- credential/TTL sequence below, identically to how
  -- resolve_blocking_qr_lifecycle_operation already treats it on the
  -- participant issuance path.
  if p_candidate.channel <> 'participant_self_service' then
    select role into v_caller_role from public.profiles where id = p_candidate.requested_by_auth_user_id;
    if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
      where id = p_candidate.id;
      disposition := 'terminalized';
      return;
    end if;
  end if;

  -- 2. Bulk-batch availability, only when this candidate is staff_bulk
  -- (bulk_batch_id is null for staff_individual and participant_self_
  -- service, per qr_lifecycle_operations_bulk_batch_matches_channel —
  -- nothing to validate in either case).
  if p_candidate.channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches
      where id = p_candidate.bulk_batch_id for share;
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= clock_timestamp()
       or v_batch.intended_operation_type <> 'issue'
       or v_batch.created_by_auth_user_id is distinct from p_candidate.requested_by_auth_user_id
       or v_batch.created_by_profile_id is distinct from p_candidate.requested_by_profile_id
    then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = p_candidate.id;
      disposition := 'terminalized';
      return;
    end if;
  end if;

  -- 3. Application eligibility (no credential lock needed for this
  -- determination — mirrors both participant resolvers' identical
  -- precedence).
  if p_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 4. Credential lock BEFORE the TTL decision, matching every other
  -- resolver's precedence exactly.
  select * into v_existing_credential from public.qr_credentials
    where application_id = p_app.id and status = 'active' for update;

  -- 5. TTL checked immediately after the credential lock — expiry wins
  -- over every finding below, including a credential conflict.
  v_check_now := clock_timestamp();
  if p_candidate.expires_at <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 6. Active-credential conflict.
  if v_existing_credential.id is not null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists',
        terminal_related_credential_id = v_existing_credential.id
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  disposition := 'still_blocking';
  return;
end;
$$;

-- Identical fix, identical rationale, for the reissue counterpart. Only
-- step 1's guard changes; steps 2-7 (bulk-batch availability, application
-- eligibility, credential lock ordering, TTL precedence, no-active-
-- credential, expected-credential mismatch, terminal-reason vocabulary,
-- audit/idempotency columns) are byte-for-byte unchanged.
create or replace function public.resolve_blocking_qr_lifecycle_staff_reissue_operation(
  p_candidate public.qr_lifecycle_operations,
  p_app public.applications,
  out disposition text -- 'still_blocking' | 'terminalized'
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller_role text;
  v_batch public.qr_bulk_operation_batches;
  v_existing_credential public.qr_credentials;
  v_transition_now timestamptz;
  v_check_now timestamptz;
begin
  -- 1. Requester authorization, re-verified against the CANDIDATE's own
  -- recorded requester — but ONLY for a staff-originated candidate
  -- (staff_individual/staff_bulk). A participant_self_service candidate
  -- has no staff role to lapse and must never be evaluated against staff
  -- role eligibility; it is validated purely by the application/
  -- credential/TTL/expected-credential sequence below, identically to how
  -- resolve_blocking_qr_lifecycle_reissue_operation already treats it on
  -- the participant reissue path.
  if p_candidate.channel <> 'participant_self_service' then
    select role into v_caller_role from public.profiles where id = p_candidate.requested_by_auth_user_id;
    if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
      where id = p_candidate.id;
      disposition := 'terminalized';
      return;
    end if;
  end if;

  -- 2. Bulk-batch availability, only when this candidate is staff_bulk.
  -- Identical shape to staff issuance's own batch check, EXCEPT
  -- intended_operation_type must be 'reissue', not 'issue' — an
  -- issue-typed batch can never authorize a reissue reservation.
  if p_candidate.channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches
      where id = p_candidate.bulk_batch_id for share;
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= clock_timestamp()
       or v_batch.intended_operation_type <> 'reissue'
       or v_batch.created_by_auth_user_id is distinct from p_candidate.requested_by_auth_user_id
       or v_batch.created_by_profile_id is distinct from p_candidate.requested_by_profile_id
    then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = p_candidate.id;
      disposition := 'terminalized';
      return;
    end if;
  end if;

  -- 3. Application eligibility (no credential lock needed for this
  -- determination — mirrors every other resolver's identical precedence).
  if p_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 4. Credential lock BEFORE the TTL decision, matching every other
  -- resolver's precedence exactly.
  select * into v_existing_credential from public.qr_credentials
    where application_id = p_app.id and status = 'active' for update;

  -- 5. TTL checked immediately after the credential lock — expiry wins
  -- over any credential-state finding below.
  v_check_now := clock_timestamp();
  if p_candidate.expires_at <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 6. Reissue-specific credential semantics: a MISSING active credential
  -- is terminal.
  if v_existing_credential.id is null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'no_active_credential'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 7. An active credential exists but does not match the candidate's own
  -- durable expected_current_credential_id — also terminal.
  -- terminal_related_credential_id remains null for expected_credential_
  -- changed per qr_lifecycle_operations_cancelled_is_consistent (§1.7).
  if v_existing_credential.id <> p_candidate.expected_current_credential_id then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed',
        terminal_related_credential_id = null
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  disposition := 'still_blocking';
  return;
end;
$$;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260811210000_fix_staff_blocker_resolver_channel_check')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260814100000_scan_qr_attempt_transactional.sql
-- ============================================================
-- scan_qr_attempt_transactional.sql
--
-- Phase 7A — Scanner QR Backend Contract & Authorization. Adds the missing
-- database bridge between Phase 6.1's canonical QR credential system
-- (qr_credentials, resolved by token_hash — see docs/superpowers/specs/
-- 2026-08-12-qr-token-format-and-lifecycle.md) and the existing, proven
-- attendance/admission engine (scan_attempt_transactional, unmodified).
--
-- Trust-boundary decision (documented per the Phase 7A brief's §10): the
-- trusted Next.js server layer parses the canonical rcoy:v1:<token> payload
-- and computes token_hash using the existing Phase 6.1 code
-- (src/lib/attendance/qr-token-crypto.ts's parseCanonicalQrPayload +
-- hashQrToken) — never re-implemented here. Only the resulting 32-byte
-- token_hash crosses into this function; the raw token/payload never
-- reaches SQL. This keeps exactly one canonical parsing/hashing
-- implementation (no parity-test burden), minimizes what a compromised or
-- buggy caller could ever leak into the database layer, and still commits
-- resolution + admission as one atomic transaction.
--
-- finalized_at: both direct scan_attempts inserts below (malformed-hash and
-- unresolved-credential branches) set finalized_at = now(), matching the
-- corrective fix applied to scan_attempt_transactional in migration
-- 20260814110000 — both branches write a terminal result
-- ('invalid_qr'), never 'token_valid_pending_confirmation', so
-- scan_attempts_finalization_state_check (from 20260805235959) requires
-- finalized_at IS NOT NULL here too. now() is used for the same reason as
-- that migration: consistency with created_at's own now()-based column
-- default within the same transaction, and this function has no
-- multi-step wait before either insert that would call for
-- clock_timestamp() instead.

-- ============================================================================
-- compute_time_slot_group_key_for_session — narrow SQL port of
-- groupSessionsIntoTimeSlots/computeTimeSlotGroupKey
-- (src/lib/allocation/time-slot-grouping.ts). Grouping/context derivation
-- ONLY — no admission-policy logic. Must remain byte-for-byte equivalent to
-- the TypeScript implementation; see
-- tests/attendance/time-slot-group-key-parity.test.ts for the proof.
-- ============================================================================
-- Path-compressing find over a plain int[] union-find parent array —
-- factored out as its own top-level helper because PL/pgSQL does not
-- support nested function declarations inside a function body. Pure/
-- side-effect-free (never mutates its input), used only by
-- compute_time_slot_group_key_for_session below.
create or replace function public.__tsgk_find_root(p_parent int[], p_idx int) returns int
language plpgsql
immutable
as $$
declare
  v_cur int := p_idx;
begin
  while p_parent[v_cur] <> v_cur loop
    v_cur := p_parent[v_cur];
  end loop;
  return v_cur;
end;
$$;

create or replace function public.compute_time_slot_group_key_for_session(
  p_session_id uuid
) returns text
language plpgsql
volatile
as $$
declare
  v_conference_day_id uuid;
  v_ids uuid[];
  v_starts timestamptz[];
  v_ends timestamptz[];
  v_parent int[];
  v_n int;
  v_i int;
  v_j int;
  v_root_i int;
  v_root_j int;
  v_root int;
  v_member_ids text[];
  v_key text;
begin
  select conference_day_id into v_conference_day_id from public.sessions where id = p_session_id;
  if v_conference_day_id is null then
    raise exception 'Session % not found', p_session_id;
  end if;

  -- Load every session on the same conference day, in a fixed (id-sorted)
  -- order so array indices are deterministic within this call.
  select array_agg(id order by id), array_agg(start_time order by id), array_agg(end_time order by id)
    into v_ids, v_starts, v_ends
    from public.sessions where conference_day_id = v_conference_day_id;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then
    raise exception 'Session % not found in any computed time-slot group', p_session_id;
  end if;

  -- Union-find init: each session starts as its own root.
  v_parent := array_fill(0, array[v_n]);
  for v_i in 1..v_n loop
    v_parent[v_i] := v_i;
  end loop;

  -- Pairwise half-open-interval overlap ([start, end)), exactly matching
  -- rangesOverlap in src/lib/allocation/time-slot-grouping.ts — O(n^2)
  -- over one day's sessions, same complexity as the TS version's own
  -- nested loop.
  for v_i in 1..v_n loop
    for v_j in (v_i + 1)..v_n loop
      if v_starts[v_i] < v_ends[v_j] and v_starts[v_j] < v_ends[v_i] then
        v_root_i := public.__tsgk_find_root(v_parent, v_i);
        v_root_j := public.__tsgk_find_root(v_parent, v_j);
        if v_root_i <> v_root_j then
          v_parent[v_root_i] := v_root_j;
        end if;
      end if;
    end loop;
  end loop;

  -- Locate the target session's index and resolve its final root.
  v_i := null;
  for v_j in 1..v_n loop
    if v_ids[v_j] = p_session_id then
      v_i := v_j;
    end if;
  end loop;
  if v_i is null then
    raise exception 'Session % not found in any computed time-slot group', p_session_id;
  end if;
  v_root := public.__tsgk_find_root(v_parent, v_i);

  -- Collect every session id sharing that root, sort lexicographically
  -- (matching computeTimeSlotGroupKey's `[...sessionIds].sort()`), then
  -- SHA-256 the comma-joined text — identical to the TS implementation.
  v_member_ids := array[]::text[];
  for v_j in 1..v_n loop
    if public.__tsgk_find_root(v_parent, v_j) = v_root then
      v_member_ids := array_append(v_member_ids, v_ids[v_j]::text);
    end if;
  end loop;
  select array_agg(x order by x) into v_member_ids from unnest(v_member_ids) as x;

  v_key := encode(digest(array_to_string(v_member_ids, ','), 'sha256'), 'hex');
  return v_key;
end;
$$;

comment on function public.compute_time_slot_group_key_for_session(uuid) is
  'Narrow SQL port of groupSessionsIntoTimeSlots/computeTimeSlotGroupKey (src/lib/allocation/time-slot-grouping.ts). Grouping only — no admission-policy logic. Must stay in exact parity with the TypeScript implementation; see tests/attendance/time-slot-group-key-parity.test.ts.';

-- ============================================================================
-- scan_qr_attempt_transactional — the Phase 7A bridge. Resolves a
-- Phase-6.1-issued credential by token_hash (already computed server-side,
-- never re-derived here from any text form) and, only for an active
-- credential, delegates to the existing, unmodified scan_attempt_transactional
-- for the actual admission decision/write. Every code path inserts exactly
-- one scan_attempts row: unresolved credentials insert it directly here
-- (application_id null, result 'invalid_qr') and return immediately without
-- ever invoking the admission engine; a resolved, active credential inserts
-- NO row here at all — scan_attempt_transactional owns that single insert.
-- ============================================================================
create or replace function public.scan_qr_attempt_transactional(
  p_token_hash bytea,
  p_session_id uuid,
  p_scanned_by uuid,
  p_device_identifier text,
  p_is_override_caller boolean default false
) returns scan_attempts
language plpgsql
as $$
declare
  v_credential public.qr_credentials%rowtype;
  v_application_id uuid;
  v_time_slot_group_key text;
  v_scan_attempt scan_attempts%rowtype;
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    -- Malformed/absent hash never reaches qr_credentials at all — the
    -- trusted server boundary is expected to reject a non-canonical
    -- payload before ever calling this function, but this is a defensive,
    -- independent re-check at the SQL layer, matching this codebase's
    -- established defense-in-depth convention (e.g.
    -- qr_credentials_enforce_lifecycle_trigger restating checks the
    -- finalizers already perform).
    insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, finalized_at)
    values (null, p_session_id, p_scanned_by, p_device_identifier, 'invalid_qr', now())
    returning * into v_scan_attempt;
    return v_scan_attempt;
  end if;

  -- Hash lookup only — token_ciphertext is never read/decrypted for an
  -- ordinary scan. Unknown, revoked, and replaced credentials are
  -- indistinguishable at this boundary by design (Phase 7A brief §3): the
  -- WHERE clause itself only ever matches an 'active' row, so "no row
  -- found" already collapses all three non-usable states into one branch
  -- with no internal state ever inspected or exposed.
  select * into v_credential from public.qr_credentials
    where token_hash = p_token_hash and status = 'active';

  if v_credential.id is null then
    insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, finalized_at)
    values (null, p_session_id, p_scanned_by, p_device_identifier, 'invalid_qr', now())
    returning * into v_scan_attempt;
    return v_scan_attempt;
  end if;

  v_application_id := v_credential.application_id;
  v_time_slot_group_key := public.compute_time_slot_group_key_for_session(p_session_id);

  -- Delegate entirely to the existing, unmodified attendance engine. No
  -- admission/capacity/eligibility/timeslot/duplicate/override logic is
  -- reimplemented here. This is the ONLY scan_attempts insert on this code
  -- path — scan_attempt_transactional performs it internally exactly once
  -- per its own existing contract.
  select * into v_scan_attempt
  from public.scan_attempt_transactional(
    v_application_id, p_session_id, p_scanned_by, p_device_identifier,
    v_time_slot_group_key, p_is_override_caller
  );

  return v_scan_attempt;
end;
$$;

comment on function public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean) is
  'Phase 7A scanner bridge: resolves a Phase 6.1 QR credential by token_hash (never by decrypting token_ciphertext) and delegates admission to the existing, unmodified scan_attempt_transactional. Raw QR token/payload never reaches this function or is ever stored — only a 32-byte SHA-256 hash computed server-side by src/lib/attendance/qr-token-crypto.ts.';

-- service_role-only: the browser must never call this directly. The
-- trusted Next.js server boundary (requireScannerDeviceCaller +
-- verifyScannerScope, both unchanged) is the only intended caller, using
-- the service-role client — matching scan_attempt_transactional's own
-- existing access pattern (also no authenticated/anon grant) and every
-- Phase 6.1 finalizer's revoke-then-narrow-grant convention.
revoke all on function public.__tsgk_find_root(int[], int) from public, anon, authenticated;
grant execute on function public.__tsgk_find_root(int[], int) to service_role;

revoke all on function public.compute_time_slot_group_key_for_session(uuid) from public, anon, authenticated;
grant execute on function public.compute_time_slot_group_key_for_session(uuid) to service_role;

revoke all on function public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.scan_qr_attempt_transactional(bytea, uuid, uuid, text, boolean) to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260814100000_scan_qr_attempt_transactional')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260814110000_fix_scan_attempt_transactional_finalized_at.sql
-- ============================================================
-- fix_scan_attempt_transactional_finalized_at.sql
--
-- Corrective fix, upstream of Phase 7A. Migration 20260805235959 added
-- scan_attempts.finalized_at/expires_at plus the
-- scan_attempts_finalization_state_check constraint (requiring
-- finalized_at IS NOT NULL for every result other than
-- 'token_valid_pending_confirmation'), but never updated the existing,
-- live scan_attempt_transactional function to set finalized_at on either
-- of its two INSERT statements. Since scan_attempt_transactional only
-- ever produces terminal results — verified by tracing every branch:
-- 'invalid_qr', 'duplicate', 'timeslot_conflict', 'full', 'admitted',
-- 'restricted_denied', 'flexible_admitted', 'priority_hold',
-- 'override_admitted' — it never writes 'token_valid_pending_confirmation',
-- so both of its inserts have been violating the constraint since that
-- migration was applied. This is the only genuine bug: the writer, not the
-- constraint, which correctly encodes the lifecycle contract
-- (pending = finalized_at null + expires_at set; terminal = finalized_at
-- set + expires_at null) — see scan_attempts_finalization_state_check's own
-- definition, unchanged here.
--
-- Fix: both INSERT statements now set finalized_at = now(). now() (not
-- clock_timestamp()) matches this function's own existing convention —
-- every other timestamp comparison in its body (late-entry cutoff,
-- priority-release timing) already uses now(), and created_at's column
-- default is also now() — so created_at and finalized_at resolve to the
-- exact same frozen per-transaction timestamp for every insert here,
-- guaranteeing finalized_at >= created_at structurally, not by race.
-- clock_timestamp() is the correct choice elsewhere in this codebase (the
-- QR lifecycle finalizers) specifically because those functions take
-- multiple locks/waits before their terminal write and need the real
-- current instant, not the frozen transaction start time — neither
-- applies to this function's single-pass, no-intermediate-wait body.
--
-- Everything else is byte-for-byte unchanged: exact same signature,
-- advisory-lock retry loop, application/session validation, duplicate/
-- timeslot-conflict/capacity/eligibility/policy decision tree, override
-- handling, attendance_records write, and result vocabulary. Only the two
-- INSERT ... INTO scan_attempts statements gain one additional column.
create or replace function scan_attempt_transactional(
  p_application_id uuid,
  p_session_id uuid,
  p_scanned_by uuid,
  p_device_identifier text,
  p_time_slot_group_key text,
  p_is_override_caller boolean default false
) returns scan_attempts as $$
declare
  v_lock_key bigint;
  v_lock_acquired boolean := false;
  v_retry_count int := 0;
  v_max_retries constant int := 20;      -- ~1s total worst case at 50ms apart
  v_retry_delay_seconds constant numeric := 0.05;
  v_session sessions%rowtype;
  v_application_status text;
  v_total_admitted int;
  v_admitted_priority_count int;
  v_admitted_flexible_count int;
  v_has_this_session boolean;
  v_has_conflicting_session boolean;
  v_effective_priority_pool int;
  v_released boolean;
  v_flexible_pool int;
  v_result text;
  v_entry_type text;
  v_attendance_id uuid;
  v_scan_attempt scan_attempts%rowtype;
begin
  v_lock_key := hashtext(p_session_id::text);

  loop
    v_lock_acquired := pg_try_advisory_xact_lock(v_lock_key);
    exit when v_lock_acquired or v_retry_count >= v_max_retries;
    v_retry_count := v_retry_count + 1;
    perform pg_sleep(v_retry_delay_seconds);
  end loop;

  if not v_lock_acquired then
    raise exception 'Another scan for this session is still being processed after % retries — please retry manually', v_max_retries;
  end if;

  select status into v_application_status from applications where id = p_application_id;
  select * into v_session from sessions where id = p_session_id;

  if v_application_status is null or v_application_status <> 'accepted' or v_session.id is null then
    insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, finalized_at)
    values (p_application_id, p_session_id, p_scanned_by, p_device_identifier, 'invalid_qr', now())
    returning * into v_scan_attempt;
    return v_scan_attempt;
  end if;

  select exists(
    select 1 from attendance_records
    where application_id = p_application_id and session_id = p_session_id and status = 'admitted'
  ) into v_has_this_session;

  select exists(
    select 1 from attendance_records
    where application_id = p_application_id and time_slot_group_key = p_time_slot_group_key
      and session_id <> p_session_id and status = 'admitted'
  ) into v_has_conflicting_session;

  select count(*) filter (where status = 'admitted') into v_total_admitted from attendance_records where session_id = p_session_id;
  select count(*) filter (where status = 'admitted' and entry_type = 'priority') into v_admitted_priority_count from attendance_records where session_id = p_session_id;
  select count(*) filter (where status = 'admitted' and entry_type = 'flexible') into v_admitted_flexible_count from attendance_records where session_id = p_session_id;

  v_effective_priority_pool := coalesce(v_session.priority_seats, v_session.capacity);

  -- Both "session not open" and "past late-entry cutoff" collapse to the
  -- single 'invalid_qr' result value — the scan_attempts.result check
  -- constraint (Task 4) and the design spec's color table have no 8th/9th
  -- distinct code for either case. resolveAdmissionDecision (Task 8) uses
  -- this exact same collapse, to keep the TS preview and this RPC's
  -- actual write in sync.
  if v_has_this_session then
    v_result := 'duplicate';
  elsif v_has_conflicting_session then
    v_result := 'timeslot_conflict';
  elsif v_session.status <> 'confirmed' then
    v_result := 'invalid_qr'; -- session not open for entry
  elsif v_session.late_entry_cutoff_minutes is not null
        and now() > (v_session.start_time + (v_session.late_entry_cutoff_minutes || ' minutes')::interval)
        and not p_is_override_caller then
    v_result := 'invalid_qr'; -- late-entry blocked; collapsed into invalid_qr, see note above
  elsif v_total_admitted >= v_session.capacity then
    v_result := 'full';
  else
    case v_session.admission_policy
      when 'restricted' then
        if exists(select 1 from allocation_assignments where application_id = p_application_id and session_id = p_session_id and status in ('proposed', 'confirmed')) then
          v_result := 'admitted'; v_entry_type := 'priority';
        else
          v_result := 'restricted_denied';
        end if;
      when 'plenary' then v_result := 'flexible_admitted'; v_entry_type := 'flexible';
      when 'open' then v_result := 'flexible_admitted'; v_entry_type := 'flexible';
      when 'cross_cutting' then v_result := 'flexible_admitted'; v_entry_type := 'flexible';
      when 'priority_then_open' then
        if exists(select 1 from allocation_assignments where application_id = p_application_id and session_id = p_session_id and status in ('proposed', 'confirmed')) then
          v_result := 'admitted'; v_entry_type := 'priority';
        else
          v_released := (
            v_session.flexible_entry_manual_override is true
            or (v_session.flexible_entry_manual_override is distinct from false and v_session.priority_release_at is not null and now() >= v_session.priority_release_at)
            or (v_session.flexible_entry_manual_override is distinct from false and v_session.priority_release_at is null and v_session.priority_release_minutes_before is not null
                and now() >= v_session.start_time - (v_session.priority_release_minutes_before || ' minutes')::interval)
          );
          v_flexible_pool := (v_session.capacity - v_effective_priority_pool)
                              + (case when v_released then greatest(0, v_effective_priority_pool - v_admitted_priority_count) else 0 end);
          if v_total_admitted < v_session.capacity and v_admitted_flexible_count < v_flexible_pool then
            v_result := 'flexible_admitted'; v_entry_type := 'flexible';
          else
            v_result := 'priority_hold';
          end if;
        end if;
    end case;
  end if;

  if p_is_override_caller and v_result in ('restricted_denied', 'full', 'priority_hold') then
    v_result := 'override_admitted'; v_entry_type := 'override';
  end if;

  if v_result in ('admitted', 'flexible_admitted', 'override_admitted') then
    insert into attendance_records (application_id, session_id, time_slot_group_key, entry_type, scanned_by, device_identifier)
    values (p_application_id, p_session_id, p_time_slot_group_key, v_entry_type, p_scanned_by, p_device_identifier)
    returning id into v_attendance_id;
  end if;

  insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, resulting_attendance_id, finalized_at)
  values (p_application_id, p_session_id, p_scanned_by, p_device_identifier, v_result, v_attendance_id, now())
  returning * into v_scan_attempt;

  return v_scan_attempt;
end;
$$ language plpgsql set search_path = public, pg_temp;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260814110000_fix_scan_attempt_transactional_finalized_at')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260815000000_revoke_qr_credential_on_ineligibility.sql
-- ============================================================
-- 20260815000000_revoke_qr_credential_on_ineligibility.sql
--
-- Corrective migration — closes a bearer-credential resurrection gap
-- discovered while building the Participant QR Experience.
--
-- CONFIRMED FACTS (read directly from the live migrations, not assumed):
--   - Every QR issuance/reissue reservation and finalizer RPC
--     (request_my_qr_issuance_transactional, request_staff_qr_issuance_
--     transactional, request_my_qr_reissue_transactional, request_staff_
--     qr_reissue_transactional, finalize_qr_issuance_for_server,
--     finalize_qr_reissue_for_server — all in
--     20260805235959_phase6_qr_issuance_reissue.sql) already correctly
--     check applications.status = 'accepted' before issuing/reissuing.
--   - scan_attempt_transactional (20260804160000, restated in
--     20260814110000) independently re-checks applications.status live
--     at every single scan — an application that is no longer 'accepted'
--     cannot be admitted even if its qr_credentials row is still
--     status = 'active'. There is NO admission-control gap.
--   - VALID_TRANSITIONS (src/lib/validation/admission-review.ts) permits
--     waitlisted -> accepted and rejected -> accepted through the real
--     admin review UI. Nothing in the existing schema revokes/replaces
--     qr_credentials when an application leaves 'accepted'.
--
-- THE GAP THIS MIGRATION CLOSES: because nothing revoked the old
-- credential when eligibility was first lost, a credential that was
-- 'active' while accepted, then correctly could not admit anyone while
-- non-accepted (per the live scan-time check above), would become
-- OPERATIONAL AGAIN with zero re-issuance the moment the application
-- returns to 'accepted' — resurrecting a bearer credential the
-- participant may have already screenshotted/shared/lost. This is a
-- genuine credential-lifecycle defect, independent of the (already
-- sound) admission-control checks.
--
-- FIX: an AFTER UPDATE trigger on applications that revokes the
-- application's current active qr_credentials row (if any) the instant
-- status transitions away from 'accepted'. Purely additive — reuses the
-- EXACT existing active -> revoked transition shape the lifecycle guard
-- trigger (qr_credentials_lifecycle_guard, same migration as above)
-- already permits and enforces: token_ciphertext and
-- encryption_key_version cleared together, revoked_at/revocation_reason_
-- code set, revoked_by left NULL (this is a system-initiated transition,
-- not a staff action — mirrors how reissue_channel = 'system' already
-- means "no staff actor" elsewhere in the same lifecycle guard). No
-- existing constraint, status vocabulary, or table is altered except the
-- one narrow, additive change in step 1 below.

-- ============================================================================
-- 1. Extend revocation_reason_code's CHECK constraint with exactly one new
--    value: 'application_ineligible'. Every existing allowed value is
--    preserved verbatim (read directly from the live constraint definition
--    in 20260805235959, not assumed) — this is drop-and-recreate, not an
--    edit of the already-applied migration.
-- ============================================================================
alter table public.qr_credentials drop constraint qr_credentials_revocation_reason_code_valid;
alter table public.qr_credentials add constraint qr_credentials_revocation_reason_code_valid check (
  revocation_reason_code is null or revocation_reason_code in (
    'suspected_compromise', 'participant_request', 'administrative_correction', 'staff_other',
    'application_ineligible'
  )
);

-- ============================================================================
-- 2. The revocation function itself. SECURITY DEFINER because it must be
--    able to update qr_credentials regardless of the calling transaction's
--    role (the trigger fires under whatever role performed the
--    applications UPDATE — service_role for the existing staff review
--    action). Idempotent/safe no-op if there is no active credential.
-- ============================================================================
create function public.revoke_active_qr_credential_for_ineligible_application()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Only fires on a genuine status change AWAY from 'accepted'. Any other
  -- column changing on the same row (assigned_reviewer_id, updated_at via
  -- the existing moddatetime trigger, etc.) must never trigger a
  -- revocation — this is the exact narrow condition requested.
  if old.status = 'accepted' and new.status <> 'accepted' then
    -- Row-level lock on the credential before transitioning it, same
    -- discipline the issuance/reissue RPCs already use
    -- (`select ... from qr_credentials where application_id = ... and
    -- status = 'active' for update`) — closes the same class of race a
    -- concurrent reissue could otherwise create against this trigger.
    update public.qr_credentials
    set
      status = 'revoked',
      revoked_at = clock_timestamp(),
      revoked_by = null,
      revocation_reason_code = 'application_ineligible',
      revocation_note = 'Automatically revoked: application status changed from accepted to ' || new.status,
      token_ciphertext = null,
      encryption_key_version = null
    where application_id = new.id
      and status = 'active';
    -- Zero matching rows (no active credential existed) is a normal,
    -- expected no-op — never an error.
  end if;
  return new;
end;
$$;

revoke all on function public.revoke_active_qr_credential_for_ineligible_application() from public;

-- AFTER UPDATE (not BEFORE): the status change must actually commit within
-- the same transaction before this trigger reads/acts on it as NEW.status;
-- an AFTER trigger still runs inside the same transaction as the
-- originating UPDATE (so it remains atomic with it — either both the
-- status change and the revocation commit, or neither does), it just
-- observes the row post-change rather than being able to further modify
-- the applications row itself (which this trigger never needs to do).
create trigger applications_revoke_qr_on_ineligibility
  after update on public.applications
  for each row
  execute function public.revoke_active_qr_credential_for_ineligible_application();


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260815000000_revoke_qr_credential_on_ineligibility')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260816000000_canonical_authenticated_and_service_role_grants.sql
-- ============================================================
-- 20260816000000_canonical_authenticated_and_service_role_grants.sql
--
-- CANONICAL PRODUCTION-READINESS GRANT BASELINE — closes the
-- "AUTHENTICATED POSTGRES GRANT BASELINE NOT YET CANONICALLY DEFINED"
-- blocker tracked since Phase 7C, and the related service_role gap
-- discovered while investigating it (Phase 7G-A).
--
-- ROOT CAUSE: every table created by every prior migration in this repo
-- receives only Postgres/Supabase's own bare defaults for `authenticated`
-- and `service_role` (REFERENCES/TRIGGER/TRUNCATE — never SELECT/INSERT/
-- UPDATE/DELETE) unless a migration explicitly GRANTs more. No migration
-- ever did this as a deliberate, complete pass — grants were added
-- piecemeal, table by table, only when a specific feature's own migration
-- happened to need one (e.g. `applications` got SELECT/INSERT/UPDATE for
-- `authenticated` because registration needed it that same migration;
-- `sessions` never did, because no single feature's migration needed
-- service_role SELECT on it badly enough to add it). The result: real
-- end-to-end application flows (participant login, scanner login,
-- scanner assignment admin, participant QR) have repeatedly hit
-- "permission denied for table X" in live testing across Phase 7C
-- through the Participant QR Experience, each time patched with a
-- temporary, disposable-project-only GRANT that was fully revoked
-- afterward — never a real fix.
--
-- METHOD: this migration is the direct output of two exhaustive,
-- code-level audits (not guessed): every `createClient()` (authenticated,
-- cookie-bound session client) call site and every `createServiceRoleClient()`
-- call site in `src/`, tracing every `.from(table).select/insert/update/
-- delete(...)` actually performed through each client. Tables/operations
-- NOT found in that trace are deliberately NOT granted here.
--
-- SCOPE DISCIPLINE (per the approved plan):
--   - No GRANT ALL, no blanket "every table" grant.
--   - DELETE is granted ONLY where a real, traced code path performs one
--     (session_tags — confirmed the single direct-DELETE call site in the
--     whole authenticated+service_role surface; everything else that
--     "removes" something is an UPDATE is_active=false, or a DELETE
--     inside a SECURITY DEFINER RPC body, which runs as the function
--     owner and needs no table-level grant here).
--   - RLS is untouched and remains the actual row-level authority for
--     every `authenticated` grant below — a GRANT only lets the SQL
--     operation reach RLS; RLS still decides which rows are visible/
--     writable. Every `authenticated` table below already has a
--     corresponding _select_own/_insert_own_draft/_update_own_draft or
--     _staff_all RLS policy from an earlier migration (verified, not
--     assumed) — this migration adds no new RLS policy of its own.
--   - `service_role` already bypasses RLS by Supabase's own design; the
--     grants below only let the SQL statement execute at all, they do
--     not change service_role's trust level or reach.
--   - No test-only grants, no test_only_% objects, no disposable-project
--     identifiers. Suitable for real production deployment as-is.

-- ============================================================================
-- AUTHENTICATED — every table a real signed-in participant, scanner_device,
-- or staff account's OWN browser session (never a service-role/RPC-only
-- path) directly touches via .from(table)... Every one of these already
-- has a per-row RLS policy (own-row for participant self-service tables;
-- staff-wide "_staff_all" for the read-only agenda/allocation admin
-- surfaces) — this section only grants the SQL-level permission to reach
-- those existing policies.
-- ============================================================================

-- Own-row participant self-service (own-row RLS: profiles_select_own,
-- applications_select_own/_insert_own_draft/_update_own_draft,
-- schedule_publications_select_own, schedule_publication_items_select_own).
grant select on public.profiles to authenticated;
grant select, insert, update on public.applications to authenticated;
grant select on public.schedule_publications to authenticated;
grant select on public.schedule_publication_items to authenticated;

-- Staff-wide read-only agenda/allocation admin surfaces (RLS: each
-- table's own "<table>_staff_all" policy, `current_user_role() in (...)`,
-- not a per-row owner check — the GRANT below is what lets an
-- authorized staff session's own read reach that policy at all).
grant select on
  public.conference_days,
  public.tracks,
  public.rooms,
  public.session_types,
  public.tags,
  public.people,
  public.sessions,
  public.session_people,
  public.session_tags,
  public.feature_extraction_rules,
  public.feature_extraction_runs,
  public.clustering_runs,
  public.clusters,
  public.cluster_memberships,
  public.allocation_runs,
  public.allocation_assignments,
  public.allocation_issues,
  public.allocation_assignment_explanations,
  public.allocation_alternatives,
  public.schedule_publication_drafts,
  public.schedule_publication_draft_items,
  public.schedule_change_events
to authenticated;

-- ============================================================================
-- SERVICE_ROLE — every table the trusted server boundary (every
-- requireXStaffCaller/requireScannerDeviceCaller/requireParticipantCaller-
-- gated Server Action, and every server-only lib module) actually
-- reads/writes via a service-role client. Traced exhaustively against
-- real (non-test) code in src/ — a table absent from this list is either
-- RPC-body-only (needs no table grant here; SECURITY DEFINER functions
-- run as their owner) or genuinely untouched by any current feature.
-- ============================================================================

grant select, insert, update on
  public.profiles,
  public.applications,
  public.conference_days,
  public.sessions,
  public.rooms,
  public.people,
  public.session_types,
  public.tags,
  public.tracks,
  public.qr_encryption_key_registry,
  public.allocation_runs,
  public.allocation_assignments,
  public.feature_extraction_rules,
  public.feature_extraction_runs,
  public.participant_feature_snapshots,
  public.clustering_runs,
  public.schedule_publication_items,
  public.schedule_publication_draft_items,
  public.schedule_change_events,
  public.import_batches,
  public.import_column_mappings,
  public.import_mapping_templates,
  public.import_rows,
  public.participant_invitations,
  public.participant_account_provisioning,
  public.scanner_assignments
to service_role;

-- Insert-only trails/logs (this server boundary only ever appends to
-- these — no code path updates or re-reads its own prior audit/log rows
-- through this client).
grant insert on
  public.application_status_history,
  public.application_notes,
  public.email_log,
  public.audit_logs,
  public.allocation_alternatives,
  public.allocation_assignment_explanations,
  public.allocation_issues,
  public.clusters,
  public.cluster_memberships,
  public.resend_webhook_events
to service_role;

-- Select-only (read paths only — no direct table write through this
-- client for these; any mutation happens via a SECURITY DEFINER RPC
-- instead, e.g. finalize_qr_issuance_for_server for qr_credentials).
grant select on
  public.qr_credentials,
  public.attendance_records,
  public.application_answers
to service_role;

-- The one confirmed direct-DELETE code path (setSessionTags's
-- full-replace pattern — see agenda/sessions/[id]/actions.ts).
grant delete on public.session_tags to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260816000000_canonical_authenticated_and_service_role_grants')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260816010000_correct_non_definer_rpc_service_role_grants.sql
-- ============================================================
-- 20260816010000_correct_non_definer_rpc_service_role_grants.sql
--
-- CORRECTIVE FOLLOW-UP to 20260816000000_canonical_authenticated_and_
-- service_role_grants.sql, found while re-running live suites against the
-- new canonical grants baseline (Phase 7G-B).
--
-- ROOT CAUSE: that migration's SERVICE_ROLE section assumed every table
-- mutation not already traced to a direct .from(table)... call from
-- src/ was covered by a SECURITY DEFINER RPC body (which runs as the
-- function owner and needs no caller-side grant). That assumption was
-- wrong for several transactional RPCs that are plain `language plpgsql`
-- functions with NO `security definer` clause, so they run as the
-- CALLING role — here, always service_role, since every RPC in this list
-- is invoked via a service-role client (never the authenticated session
-- client). Confirmed directly against each function's own `create or
-- replace function ... $$ language plpgsql ...` definition (no
-- `security definer` present) and its actual insert/update statements:
--
--   scan_attempt_transactional (supabase/migrations/
--   20260814110000_fix_scan_attempt_transactional_finalized_at.sql):
--     insert into scan_attempts (x2), insert into attendance_records,
--     select from attendance_records for capacity counts.
--
--   stage_publication_transactional (supabase/migrations/
--   20260723190000_*.sql): insert into schedule_publication_drafts,
--   insert into schedule_publication_draft_items.
--
--   confirm_publication_transactional (supabase/migrations/
--   20260723195000_*.sql): update + insert into schedule_publications,
--   update schedule_publication_drafts.
--
-- schedule_publication_items and schedule_publication_draft_items already
-- carry full select/insert/update for service_role from the original
-- migration — only schedule_publications and schedule_publication_drafts
-- were missing entirely (previously granted select-only, to authenticated
-- only). scan_attempts had no grant at all; attendance_records had
-- select-only and needs insert added.
--
-- No authenticated-role change. No RLS change. No GRANT ALL.

grant select, insert on public.scan_attempts to service_role;
grant insert on public.attendance_records to service_role;
grant select, insert, update on public.schedule_publications to service_role;
grant select, insert, update on public.schedule_publication_drafts to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260816010000_correct_non_definer_rpc_service_role_grants')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260816020000_correct_attendance_records_update_grant.sql
-- ============================================================
-- 20260816020000_correct_attendance_records_update_grant.sql
--
-- SECOND corrective follow-up to 20260816000000_canonical_authenticated_
-- and_service_role_grants.sql, found while re-running live suites (Phase
-- 7G-B) after the first correction (20260816010000).
--
-- ROOT CAUSE: correct_attendance_transactional and
-- transfer_attendance_transactional (both defined in supabase/migrations/
-- 20260804170000_admission_management_functions.sql) are plain
-- `language plpgsql` functions with NO `security definer` clause, so they
-- run as the calling role — service_role, since both are invoked via
-- correctAttendanceForCaller/transferAttendanceForCaller in
-- src/lib/attendance/admission-management.ts through a service-role
-- client. Both functions UPDATE attendance_records (correct_attendance_
-- transactional line 14; transfer_attendance_transactional line 47), which
-- 20260816010000 granted INSERT+SELECT on but not UPDATE.

grant update on public.attendance_records to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260816020000_correct_attendance_records_update_grant')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260816030000_correct_allocation_issues_select_grant.sql
-- ============================================================
-- 20260816030000_correct_allocation_issues_select_grant.sql
--
-- THIRD corrective follow-up to 20260816000000_canonical_authenticated_and_
-- service_role_grants.sql, found while running the live tests/schedule/*
-- suites (Phase 7G-B) against the corrected schedule_publications/
-- schedule_publication_drafts grants (20260816010000).
--
-- ROOT CAUSE: stage_publication_transactional (supabase/migrations/
-- 20260723190000_*.sql) is a plain `language plpgsql` function with NO
-- `security definer` clause, so it runs as the calling role — service_role,
-- since it is invoked via stagePublication() (src/lib/schedule/
-- run-stage-publication.ts) through a service-role client. Its body reads
-- from allocation_issues in three places (lines 59, 125, 166 of that
-- migration) to determine mandatory-session blockers. The original
-- canonical migration granted service_role only INSERT on allocation_issues
-- (classified as an "insert-only trail", since the real-code audit found no
-- direct .from('allocation_issues').select(...) call in src/) — missing
-- that this RPC's own body reads it. SELECT was missing entirely.

grant select on public.allocation_issues to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260816030000_correct_allocation_issues_select_grant')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260816040000_correct_session_people_select_grant.sql
-- ============================================================
-- 20260816040000_correct_session_people_select_grant.sql
--
-- FOURTH corrective follow-up to 20260816000000_canonical_authenticated_and_
-- service_role_grants.sql, found while running the live tests/schedule/*
-- suites (Phase 7G-B) against the corrected allocation_issues grant
-- (20260816030000).
--
-- ROOT CAUSE: confirm_publication_transactional (supabase/migrations/
-- 20260723195000_*.sql) is a plain `language plpgsql` function with NO
-- `security definer` clause, so it runs as the calling role — service_role,
-- since it is invoked via confirmPublication() (src/lib/schedule/
-- run-confirm-publication.ts) through a service-role client. Its body reads
-- from session_people (joined with people) in three places (lines 147, 171,
-- 231 of that migration) to freeze speaker display fields onto published
-- items. The original canonical migration granted session_people SELECT
-- only to authenticated (staff-wide agenda read surface) — missing that
-- this RPC's own body, running as service_role, also needs to read it.

grant select on public.session_people to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260816040000_correct_session_people_select_grant')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260816050000_stage_publication_allocation_run_status_guard.sql
-- ============================================================
-- 20260816050000_stage_publication_allocation_run_status_guard.sql
--
-- Closes a pre-existing, already-documented production gap (docs/superpowers/
-- specs/2026-07-31-pre-existing-test-failures-technical-debt.md item 6a,
-- deferred there pending "a real design decision"; resolved now during
-- Phase 7G-B): stage_publication_transactional had no guard rejecting a
-- non-'confirmed' allocation_runs.status on the run-publish path, unlike its
-- sibling confirm_publication_transactional, which does guard its own
-- precondition (schedule_publication_drafts.status = 'staged').
--
-- Guard applies ONLY when p_allocation_run_id is not null (the run-publish
-- path) — the change-propagation path (p_allocation_run_id null,
-- p_change_event_ids supplied instead) has no allocation_runs row to check
-- against at all and is unaffected.
--
-- Placed as the very first statement in the function body, before any
-- read/write, so a rejected call causes zero mutation. Everything else
-- below is byte-for-byte identical to the current live definition
-- (supabase/migrations/20260723190000_schedule_publication_functions.sql),
-- copied verbatim — this migration changes nothing else about the
-- function's behavior.

create or replace function stage_publication_transactional(
  p_allocation_run_id uuid,
  p_change_event_ids uuid[],
  p_staged_by uuid
) returns schedule_publication_drafts as $$
declare
  v_draft schedule_publication_drafts;
  v_fingerprint text;
  v_application_id uuid;
  v_verdict text;
  v_has_mandatory_blocker boolean;
  v_content_differs boolean;
  v_session_ids uuid[];
  v_allocation_run_status text;
begin
  if p_allocation_run_id is not null then
    select status into v_allocation_run_status from allocation_runs where id = p_allocation_run_id;
    if v_allocation_run_status is null then
      raise exception 'Allocation run % not found', p_allocation_run_id;
    end if;
    if v_allocation_run_status <> 'confirmed' then
      raise exception 'Allocation run % is not confirmed (status: %) — only a confirmed allocation run can be staged for publication', p_allocation_run_id, v_allocation_run_status;
    end if;
  end if;

  v_fingerprint := compute_publication_fingerprint(p_allocation_run_id, p_change_event_ids);

  -- Resolved once, up front, for the change-propagation path's
  -- content_differs check below, via the same shared helper
  -- compute_publication_fingerprint uses internally — never duplicated
  -- inline, so the two can't drift apart again.
  if p_allocation_run_id is null then
    v_session_ids := resolve_change_event_session_ids(p_change_event_ids);
  end if;

  insert into schedule_publication_drafts (
    allocation_run_id, triggered_by_change_event_ids, staged_by, source_fingerprint, status
  ) values (
    p_allocation_run_id, p_change_event_ids, p_staged_by, v_fingerprint, 'staged'
  ) returning * into v_draft;

  if p_allocation_run_id is not null then
    -- Candidate participants: every accepted application with at least one
    -- assignment in this run.
    for v_application_id in
      select distinct application_id from allocation_assignments where allocation_run_id = p_allocation_run_id
    loop
      select exists (
        select 1 from allocation_issues ai
        join sessions s on s.id = ai.session_id
        where ai.allocation_run_id = p_allocation_run_id
          and ai.application_id = v_application_id
          and ai.issue_type in ('unassigned', 'capacity_bottleneck', 'schedule_conflict', 'no_eligible_sessions')
          and s.is_mandatory = true
      ) into v_has_mandatory_blocker;

      -- content_differs: true if there is no current active
      -- schedule_publications row for this application, or if this run's
      -- assignment set for the participant differs from the active
      -- revision's items (compared on session_id set).
      select not exists (
        select 1 from schedule_publications sp
        where sp.application_id = v_application_id and sp.status = 'active'
          and (
            select array_agg(aa.session_id order by aa.session_id)
            from allocation_assignments aa
            where aa.allocation_run_id = p_allocation_run_id and aa.application_id = v_application_id
          ) = (
            select array_agg(spi.session_id order by spi.session_id)
            from schedule_publication_items spi
            where spi.schedule_publication_id = sp.id and spi.item_status = 'active'
          )
      ) into v_content_differs;

      if v_has_mandatory_blocker then
        v_verdict := 'blocked_mandatory';
      elsif not v_content_differs then
        v_verdict := 'no_change';
      else
        v_verdict := 'publishable';
      end if;

      insert into schedule_publication_draft_items (schedule_publication_draft_id, application_id, verdict, blocker_details)
      values (
        v_draft.id,
        v_application_id,
        v_verdict,
        case when v_has_mandatory_blocker then
          (select jsonb_agg(jsonb_build_object('issue_type', ai.issue_type, 'session_id', ai.session_id))
           from allocation_issues ai join sessions s on s.id = ai.session_id
           where ai.allocation_run_id = p_allocation_run_id and ai.application_id = v_application_id
             and ai.issue_type in ('unassigned', 'capacity_bottleneck', 'schedule_conflict', 'no_eligible_sessions')
             and s.is_mandatory = true)
        else null end
      );
    end loop;
  else
    -- Change-propagation path: candidate participants are those with an
    -- active schedule_publication_items row referencing a session in
    -- v_session_ids (resolved from the change events). Blocking is driven
    -- by change_type = 'cancelled' on ANY affected item — mandatory or
    -- elective — not by allocation_issues (which don't apply to a
    -- change-propagation batch). Per the spec's Change Propagation
    -- Policy, a cancellation "must pick reassignment or explicit 'confirm
    -- cancelled' resolution... before any draft including this
    -- participant can be confirmed" — that requirement is not scoped to
    -- mandatory sessions, so an elective session's cancellation blocks
    -- exactly the same way a mandatory one does. (An earlier version of
    -- this check incorrectly scoped blocking to is_mandatory = true only,
    -- which let an elective cancellation silently reach confirm with no
    -- admin review — fixed here.)
    --
    -- content_differs: unlike the run-publish path, we can't compare
    -- session-id sets (the session assignment itself hasn't changed, only
    -- its frozen fields) — instead compare the recomputed frozen fields
    -- (start_time, end_time, room_id, and the session_people-derived
    -- speaker set) against the currently-stored frozen values on the
    -- active item. This mirrors compute_publication_fingerprint's own
    -- change-propagation hash inputs, so a truly no-op change event (e.g.
    -- a session_people row updated then immediately reverted before this
    -- batch was staged) correctly classifies as no_change rather than
    -- spuriously bumping the participant's revision_number.
    for v_application_id in
      select distinct sp.application_id
      from schedule_publications sp
      join schedule_publication_items spi on spi.schedule_publication_id = sp.id
      join schedule_change_events sce on sce.session_id = spi.session_id
      where sp.status = 'active' and spi.item_status in ('active', 'stale', 'pending_review')
        and sce.id = any(p_change_event_ids)
    loop
      select exists (
        select 1
        from schedule_publications sp
        join schedule_publication_items spi on spi.schedule_publication_id = sp.id
        join schedule_change_events sce on sce.session_id = spi.session_id
        where sp.application_id = v_application_id and sp.status = 'active'
          and sce.id = any(p_change_event_ids) and sce.change_type = 'cancelled'
      ) into v_has_mandatory_blocker;

      select exists (
        select 1
        from schedule_publications sp
        join schedule_publication_items spi on spi.schedule_publication_id = sp.id
        join sessions s on s.id = spi.session_id
        where sp.application_id = v_application_id and sp.status = 'active'
          and spi.session_id = any(v_session_ids)
          and (
            spi.start_time is distinct from s.start_time
            or spi.end_time is distinct from s.end_time
            or spi.room_name_en is distinct from (select r.name_en from rooms r where r.id = s.room_id)
            or spi.speakers is distinct from (
              select coalesce(jsonb_agg(jsonb_build_object('full_name_ar', p.full_name_ar, 'full_name_en', p.full_name_en, 'role', sp2.role)), '[]'::jsonb)
              from session_people sp2 join people p on p.id = sp2.person_id
              where sp2.session_id = s.id
            )
          )
      ) into v_content_differs;

      if v_has_mandatory_blocker then
        v_verdict := 'blocked_mandatory';
      elsif not v_content_differs then
        v_verdict := 'no_change';
      else
        v_verdict := 'publishable';
      end if;

      insert into schedule_publication_draft_items (schedule_publication_draft_id, application_id, verdict)
      values (v_draft.id, v_application_id, v_verdict);
    end loop;
  end if;

  return v_draft;
end;
$$ language plpgsql set search_path = public, pg_temp;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260816050000_stage_publication_allocation_run_status_guard')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260816060000_correct_session_tags_select_grant.sql
-- ============================================================
-- 20260816060000_correct_session_tags_select_grant.sql
--
-- SIXTH corrective follow-up to 20260816000000_canonical_authenticated_and_
-- service_role_grants.sql, found while running the full repository test
-- suite (Phase 7G-K).
--
-- ROOT CAUSE: runAllocation (src/lib/allocation/run-allocation.ts:66) reads
-- session_tags directly via a service-role client
-- (service.from('session_tags').select('session_id, tag_id, weight')) as
-- part of the real allocation orchestration. The original canonical
-- migration granted service_role only DELETE on session_tags (the one
-- confirmed direct-DELETE call site, via setSessionTags's full-replace
-- pattern) and authenticated SELECT (the staff-wide agenda read surface) —
-- missing that service_role's own orchestration code also needs to read
-- this table directly.

grant select on public.session_tags to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260816060000_correct_session_tags_select_grant')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260816070000_correct_cluster_memberships_select_grant.sql
-- ============================================================
-- 20260816070000_correct_cluster_memberships_select_grant.sql
--
-- SEVENTH corrective follow-up to 20260816000000_canonical_authenticated_and_
-- service_role_grants.sql, found while running the full repository test
-- suite (Phase 7G-K).
--
-- ROOT CAUSE: fetchApplicationIdsWithDownstreamReference
-- (src/app/[locale]/(admin)/participants/import/[batchId]/preview/actions.ts:
-- 111-115) checks 5 tables via service_role SELECT for downstream references
-- before allowing an import batch rollback: participant_feature_snapshots,
-- cluster_memberships, allocation_assignments, schedule_publications,
-- schedule_publication_draft_items. The original canonical migration granted
-- service_role SELECT on 4 of these 5 but only INSERT on cluster_memberships
-- (classified as an insert-only trail — missing that this same real code path
-- also reads it directly).

grant select on public.cluster_memberships to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260816070000_correct_cluster_memberships_select_grant')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260816080000_correct_application_sensitive_tables_grants.sql
-- ============================================================
-- 20260816080000_correct_application_sensitive_tables_grants.sql
--
-- EIGHTH corrective follow-up to 20260816000000_canonical_authenticated_and_
-- service_role_grants.sql, found while running the full repository test
-- suite in isolation (Phase 7G-K).
--
-- ROOT CAUSE: apply_import_row_transactional / rollback_import_batch_
-- transactional (supabase/migrations/20260731130000_phase_b_fix_rollback_
-- fingerprint_regression.sql and predecessors) are plain `language plpgsql`
-- functions with NO `security definer` clause, so they run as the calling
-- role — service_role, since they are invoked via the import confirm/
-- rollback Server Actions through a service-role client. Their bodies
-- select from and insert into application_answers, application_travel_info,
-- and application_health_info (sensitive-data tables added in the Phase B
-- import work). The original canonical migration granted service_role only
-- SELECT on application_answers (no INSERT) and nothing at all on
-- application_travel_info/application_health_info.

grant select, insert on public.application_answers to service_role;
grant select, insert on public.application_travel_info to service_role;
grant select, insert on public.application_health_info to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260816080000_correct_application_sensitive_tables_grants')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260816090000_correct_application_answers_authenticated_select_grant.sql
-- ============================================================
-- 20260816090000_correct_application_answers_authenticated_select_grant.sql
--
-- NINTH corrective follow-up to 20260816000000_canonical_authenticated_and_
-- service_role_grants.sql, found while running the full repository test
-- suite (Phase 7G-K, via tests/import/claim-live.test.ts's Case 4: after a
-- participant claims their imported application, their own authenticated
-- session still could not read their own non-sensitive application_answers
-- rows).
--
-- ROOT CAUSE: a real, correctly-designed own-row RLS policy already exists
-- (application_answers_select_own, supabase/migrations/
-- 20260726105500_explicit_answers_with_check.sql), scoping a participant to
-- their own non-sensitive answers via applications.applicant_id = auth.uid().
-- But the canonical migration never granted authenticated SELECT on this
-- table at the Postgres level at all — the policy existed but could never
-- be reached, since GRANT (not RLS) is what lets a SQL statement reach a
-- table in the first place. This is the participant-facing counterpart to
-- the existing application_answers_staff_all/_sensitive_staff_all policies,
-- which are correctly service_role-only (staff reads go through the
-- trusted server boundary, confirmed by code audit — see
-- tests/rls/import.test.ts's "real access is service_role-only" tests).

grant select on public.application_answers to authenticated;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260816090000_correct_application_answers_authenticated_select_grant')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260816100000_correct_application_sensitive_tables_update_grant.sql
-- ============================================================
-- 20260816100000_correct_application_sensitive_tables_update_grant.sql
--
-- TENTH corrective follow-up to 20260816000000_canonical_authenticated_and_
-- service_role_grants.sql, found while running the full repository test
-- suite (Phase 7G-K, via tests/import/claimed-update-gate-live.test.ts).
--
-- ROOT CAUSE: apply_import_row_transactional's actual latest definition
-- (supabase/migrations/20260731110000_phase_b_apply_import_row_sensitive_
-- writes.sql, lines 43-553 — confirmed the true latest version by checking
-- every later migration file for a re-`create or replace`, none exists)
-- uses `insert ... on conflict (...) do update set ...` (an upsert) against
-- all three sensitive/answer tables: application_answers,
-- application_travel_info, application_health_info. An upsert's DO UPDATE
-- branch requires UPDATE privilege at the Postgres level, not just INSERT —
-- migration 20260816080000 granted service_role only SELECT+INSERT on
-- these three tables, missing that the same function's upsert pattern also
-- needs UPDATE. This function is a plain `language plpgsql` function with
-- no `security definer`, so it runs as service_role (its real caller, via
-- runValidationForCaller and the confirm-import Server Actions).

grant update on public.application_answers to service_role;
grant update on public.application_travel_info to service_role;
grant update on public.application_health_info to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260816100000_correct_application_sensitive_tables_update_grant')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260816110000_correct_application_number_seq_usage_grant.sql
-- ============================================================
-- 20260816110000_correct_application_number_seq_usage_grant.sql
--
-- ELEVENTH corrective follow-up to 20260816000000_canonical_authenticated_
-- and_service_role_grants.sql, found while running the full repository test
-- suite (Phase 7G-K, via tests/import/phase-b-sensitive-import-live.test.ts
-- and reproduced directly: apply_import_row_transactional failing with
-- "permission denied for sequence application_number_seq").
--
-- ROOT CAUSE: the application-number-generation function
-- (supabase/migrations/20260805230000_fix_application_number_truncation.sql)
-- calls `nextval('application_number_seq')` directly and is explicitly
-- documented as NOT security definer — it runs as whichever role's
-- statement ultimately triggers it (an applications INSERT via a trigger).
-- The canonical migration granted table-level privileges throughout but
-- never granted USAGE on this SEQUENCE object at all, for either
-- authenticated or service_role — sequences require their own GRANT
-- (USAGE/SELECT/UPDATE), entirely separate from table grants.
--
-- Both roles insert into applications directly in real production code
-- (authenticated: participant self-registration; service_role: import
-- pipeline, staff-provisioned participants) — see the original canonical
-- migration's own applications grant for both roles.

grant usage on sequence public.application_number_seq to authenticated, service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260816110000_correct_application_number_seq_usage_grant')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260816120000_correct_application_sensitive_tables_delete_grant.sql
-- ============================================================
-- 20260816120000_correct_application_sensitive_tables_delete_grant.sql
--
-- TWELFTH corrective follow-up to 20260816000000_canonical_authenticated_
-- and_service_role_grants.sql, found while running the full repository
-- test suite (Phase 7G-K, via tests/import/phase-b-sensitive-import-live.
-- test.ts's rollback tests).
--
-- ROOT CAUSE: rollback_import_batch_transactional's actual latest
-- definition (supabase/migrations/20260731130000_phase_b_fix_rollback_
-- fingerprint_regression.sql, lines 194/219/248) deletes from
-- application_answers, application_travel_info, and application_health_info
-- as part of its real, genuine production rollback flow (delete-then-
-- reinsert the prior snapshot) — this is a REAL production DELETE path,
-- unlike the test-only DELETE grants tracked separately in the scratchpad
-- for Phase 7G-M teardown. This function is a plain `language plpgsql`
-- function with no `security definer`, so it runs as service_role (its
-- real caller, via rollbackImportBatchForCaller). The canonical migration
-- never granted DELETE on any of these three tables to service_role at all.

grant delete on public.application_answers to service_role;
grant delete on public.application_travel_info to service_role;
grant delete on public.application_health_info to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260816120000_correct_application_sensitive_tables_delete_grant')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260816130000_correct_travel_and_health_info_authenticated_select_grant.sql
-- ============================================================
-- 20260816130000_correct_travel_and_health_info_authenticated_select_grant.sql
--
-- THIRTEENTH corrective follow-up to 20260816000000_canonical_authenticated_
-- and_service_role_grants.sql, found while running the full repository test
-- suite (Phase 7G-K, via tests/import/sensitive-data-rls.test.ts).
--
-- ROOT CAUSE: application_travel_info and application_health_info both carry
-- real, pre-existing RLS policies (20260730110000_application_travel_and_
-- health_info_tables.sql, lines 123-142) that grant role-based staff access
-- (travel_operations_staff/participant_care_staff/super_admin, via for-all
-- policies) and own-row SELECT access to participants directly as the
-- `authenticated` role. The canonical migration granted `authenticated`
-- SELECT on application_answers (20260816090000) for the identical own-row
-- pattern but missed these two sibling tables entirely -- no `authenticated`
-- grant existed on either at all, so every direct authenticated read failed
-- with "permission denied for table ..." regardless of RLS outcome.

grant select on public.application_travel_info to authenticated;
grant select on public.application_health_info to authenticated;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260816130000_correct_travel_and_health_info_authenticated_select_grant')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260816140000_correct_application_status_history_select_grant.sql
-- ============================================================
-- 20260816140000_correct_application_status_history_select_grant.sql
--
-- FOURTEENTH corrective follow-up to 20260816000000_canonical_authenticated_
-- and_service_role_grants.sql, found while running the full repository test
-- suite (Phase 7G-K, via tests/import/reimport-fingerprint-live.test.ts,
-- which reads this table with the service-role admin client directly).
--
-- ROOT CAUSE: reimport-fingerprint-live.test.ts reads this table directly
-- with the service-role admin client, and many non-security-definer
-- functions across the import pipeline (apply_import_row_transactional,
-- rollback_import_batch_transactional, etc.) INSERT into it as service_role.
-- No SELECT grant existed for service_role on this table at all -- only
-- INSERT -- so a direct service-role read failed with a permission error,
-- surfaced by Supabase-js as a null count/data rather than a raised error.
--
-- CORRECTION (found during Phase 7G-K's tests/rls/applications.test.ts run):
-- this migration originally also granted SELECT to `authenticated`, reasoned
-- by analogy to the sibling application_answers fix (20260816090000)
-- without direct verification. Re-checked directly: every real production
-- reference to application_status_history (src/app/[locale]/(admin)/
-- applications/[id]/actions.ts:73, src/app/[locale]/(participant)/(bare)/
-- register/actions.ts:65) uses the service-role client only -- there is no
-- real authenticated-role caller for this table, unlike application_answers
-- (which genuinely has a participant-facing own-row read path). The
-- `authenticated` grant was reverted; applications.test.ts's own pre-
-- existing comment ("Direct authenticated-role table access is
-- intentionally not granted") was correct all along.

grant select on public.application_status_history to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260816140000_correct_application_status_history_select_grant')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260816150000_correct_clusters_select_grant.sql
-- ============================================================
-- 20260816150000_correct_clusters_select_grant.sql
--
-- FIFTEENTH corrective follow-up to 20260816000000_canonical_authenticated_
-- and_service_role_grants.sql, found while running the full repository test
-- suite (Phase 7G-K, via tests/import/schedule-integration-live.test.ts's
-- real Phase 5 clustering pass).
--
-- ROOT CAUSE: runClustering (src/lib/allocation/run-clustering.ts:56-68)
-- performs `.from('clusters').insert({...}).select('id').single()` as a real
-- part of the production clustering pipeline (runDownstreamProcessingForCaller
-- -> runClustering) -- the .select('id') after insert requires SELECT
-- privilege to return the inserted row, not just INSERT. The canonical
-- migration granted service_role INSERT on clusters but never SELECT,
-- unlike its sibling cluster_memberships/clustering_runs, both of which
-- already carry SELECT (see 20260816070000 for cluster_memberships).

grant select on public.clusters to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260816150000_correct_clusters_select_grant')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260819100000_add_people_is_public_flag.sql
-- ============================================================
-- 20260819100000_add_people_is_public_flag.sql
--
-- Phase 9.2 — smallest architecture change needed to power the public
-- Speakers page: a staff-curated visibility flag on the existing `people`
-- table. No new table (people/session_people already model everything
-- else needed — name, title, org, bio, photo, and the 'speaker' role via
-- session_people), no RLS/GRANT change (the public page reads via the
-- service-role client with a narrow field allowlist, per the explicit
-- decision to avoid a new anon-grant surface on this table — see
-- src/lib/content/public-speakers.ts).
--
-- Defaults to false: every existing `people` row (all internal
-- agenda-assignment entities today, none curated for public display)
-- stays invisible on the public site until a staff member explicitly
-- opts a person in, per the approved "staff picks who shows" decision.
alter table people add column is_public boolean not null default false;

comment on column people.is_public is
  'Staff-curated flag: true means this person may appear on the public Speakers page (subject to also having a session_people role=speaker row and is_active=true). Never auto-derived from role or activity.';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260819100000_add_people_is_public_flag')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260819110000_correct_session_people_insert_delete_grant.sql
-- ============================================================
-- 20260819110000_correct_session_people_insert_delete_grant.sql
--
-- REAL PRODUCTION DEFECT, found during Phase 9.2 while writing a live test
-- (not a test-fixture-only gap, unlike the tags/other grant gaps flagged
-- earlier this project).
--
-- ROOT CAUSE: assign_session_person_transactional and
-- remove_session_person (supabase/migrations/20260723060000_session_
-- people_transactional_functions.sql) are plain `language plpgsql`
-- functions with NO `security definer` clause, so they run as the CALLING
-- role — service_role, since both are invoked via assignSessionPerson()/
-- removeSessionPerson() (src/app/[locale]/(admin)/agenda/sessions/[id]/
-- actions.ts) through a service-role client, same pattern already
-- documented for confirm_publication_transactional in
-- 20260816040000_correct_session_people_select_grant.sql. Their bodies
-- directly INSERT into / DELETE from session_people. service_role has
-- never held INSERT or DELETE on this table (confirmed by grep across
-- every migration) — only SELECT (granted in 20260816040000, for a
-- different function's read). This means the "assign speaker/moderator/
-- facilitator to a session" and "remove person from a session" admin
-- features have been failing with "permission denied for table
-- session_people" in production since these RPCs were introduced.
grant insert, delete on public.session_people to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260819110000_correct_session_people_insert_delete_grant')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260820100000_add_funding_type.sql
-- ============================================================
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


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260820100000_add_funding_type')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260820110000_add_funding_type_to_import.sql
-- ============================================================
-- add_funding_type_to_import.sql
--
-- Extends apply_import_row_transactional and rollback_import_batch_
-- transactional to write/restore applications.funding_type. funding_type is
-- a plain text-like enum column on applications (no travel/health-table
-- routing, no array handling) -- adding it to v_text_columns
-- (apply function) and v_restorable_columns (rollback function) is the
-- entire change: every other generic code path (dynamic UPDATE SET
-- assembly, snapshot/restore) already handles any column present in those
-- arrays with no further changes needed.
--
-- `create or replace function` because every prior revision is already
-- applied live and immutable -- the established pattern for both
-- functions. The full body of each is restated because plpgsql has no
-- partial-replace form. Body is otherwise byte-for-byte identical to
-- 20260731110000_phase_b_apply_import_row_sensitive_writes.sql, the prior
-- authoritative version, except for the two array literals noted above.

create or replace function apply_import_row_transactional(
  p_import_row_id uuid,
  p_import_batch_id uuid,
  p_actor_id uuid
) returns text as $$
declare
  v_batch_status text;
  v_row import_rows;
  v_normalized jsonb;
  v_email text;
  v_application_id uuid;
  v_previous_application jsonb;
  v_previous_answers jsonb;
  v_previous_travel jsonb;
  v_previous_health jsonb;
  v_raw_values jsonb;
  v_key text;
  v_value jsonb;
  v_is_array boolean;
  v_application_number text;
  v_existing_fingerprint text;
  v_text_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs',
    -- Phase B: profile columns approved for direct applications writes.
    -- full_name is handled separately below (never-overwrite-with-blank
    -- rule), not through this generic array.
    'gender', 'whatsapp_number', 'education_level', 'institution_or_workplace',
    'linkedin_url', 'primary_track', 'secondary_track',
    -- funding_type: how a participant's attendance is financed. Plain
    -- text-like column (the funding_type enum accepts text values via cast
    -- at the dynamic-SQL execute below, same as any other enum-column write
    -- through this generic format(%L) path).
    'funding_type'
  ];
  v_array_columns text[] := array[
    'interests', 'track_interests',
    -- Phase B: structured allocation columns (design doc section 13.2/13.4,
    -- approved decision #2) -- normalized text[] arrays, read directly by
    -- feature extraction, never derived from application_answers.
    'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas'
  ];
  -- Phase B: target_key -> application_travel_info column. Kept in this
  -- function (not a lookup table) for the same reason v_text_columns/
  -- v_array_columns already are: this function's own arrays are the runtime
  -- authority (defense in depth alongside the TS-side manifest in
  -- src/lib/import/known-application-columns.ts, which rejects an invalid
  -- mapping earlier, at confirmMapping time).
  v_travel_columns text[] := array[
    'support_level_requested', 'can_attend_without_full_support', 'departure_airport',
    'visa_required', 'invitation_letter_required', 'passport_full_name',
    'passport_full_name_ar', 'passport_place_of_issue', 'passport_copy_url', 'passport_photo_url'
  ];
  v_travel_date_columns text[] := array['passport_issue_date', 'passport_expiry_date', 'passport_birth_date'];
  v_health_columns text[] := array[
    'allergies', 'medical_conditions', 'emergency_medication', 'accessibility_requirements',
    'dietary_requirements', 'accommodation_preference', 'cultural_or_religious_requirements',
    'emergency_contact_name', 'emergency_contact_relationship', 'emergency_contact_phone'
  ];
  v_health_bool_columns text[] := array['consent_given'];
  v_full_name text;
  v_update_sql text;
  v_set_clauses text[] := array[]::text[];
  -- Phase B (design doc section 13.7): which section an application_answers
  -- row is tagged with. Determined once per key from which of the new
  -- travel/health arrays (or neither) it belongs to -- every key still
  -- lands in application_answers regardless of section, preserving the
  -- original imported value exactly as before.
  v_section text;
begin
  select status into v_batch_status from import_batches where id = p_import_batch_id;
  if v_batch_status = 'rolled_back' then
    raise exception 'Import batch % has been rolled back; cannot apply row %', p_import_batch_id, p_import_row_id;
  end if;

  select * into v_row from import_rows
  where id = p_import_row_id and import_batch_id = p_import_batch_id
  for update;

  if v_row.id is null then
    raise exception 'Import row % not found in batch %', p_import_row_id, p_import_batch_id;
  end if;

  if v_row.action_taken is not null then
    return 'already_applied';
  end if;

  if v_row.validation_status = 'invalid' then
    update import_rows set action_taken = 'skipped_error' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'blocked_downstream' then
    update import_rows set action_taken = 'blocked' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'duplicate_in_file' then
    update import_rows set action_taken = 'skipped_unchanged' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'existing_claimed' and not v_row.claimed_update_approved then
    update import_rows set action_taken = 'blocked' where id = v_row.id;
    return 'skipped';
  end if;

  v_normalized := coalesce(v_row.normalized_row, '{}'::jsonb);
  v_email := v_normalized->>'email';
  if v_email is null or v_email = '' then
    raise exception 'Import row % has no normalized email but passed validation', v_row.id;
  end if;

  select coalesce(jsonb_object_agg(m.target_key, to_jsonb(v_row.raw_row->>m.source_column_index)), '{}'::jsonb)
  into v_raw_values
  from import_column_mappings m
  where m.import_batch_id = p_import_batch_id
    and m.target_key is not null
    and m.target_kind <> 'ignored';

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    v_application_id := v_row.destination_application_id;
    if v_application_id is null then
      raise exception 'Import row % is marked % but has no destination_application_id', v_row.id, v_row.duplicate_status;
    end if;

    perform 1 from applications where id = v_application_id for update;

    select last_import_row_fingerprint into v_existing_fingerprint
    from applications where id = v_application_id;

    if v_existing_fingerprint = v_row.row_fingerprint then
      update import_rows set
        action_taken = 'skipped_unchanged',
        destination_application_id = v_application_id
      where id = v_row.id;

      insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
      values (
        'application',
        v_application_id,
        'import_skip_unchanged',
        'admin',
        p_actor_id,
        jsonb_build_object(
          'batchId', p_import_batch_id,
          'importRowId', v_row.id,
          'excelRowNumber', v_row.excel_row_number,
          'rowFingerprint', v_row.row_fingerprint
        )
      );

      return 'skipped';
    end if;

    select to_jsonb(a.*) into v_previous_application from applications a where a.id = v_application_id;
    if v_previous_application is null then
      raise exception 'Destination application % for import row % no longer exists', v_application_id, v_row.id;
    end if;

    select coalesce(jsonb_agg(to_jsonb(aa.*)), '[]'::jsonb) into v_previous_answers
    from application_answers aa where aa.application_id = v_application_id;

    -- Phase B: snapshot the existing travel/health rows too (each is at
    -- most one row, 1:1 on application_id), so an updated-row rollback can
    -- restore them exactly like application_answers below.
    select to_jsonb(t.*) into v_previous_travel from application_travel_info t where t.application_id = v_application_id;
    select to_jsonb(h.*) into v_previous_health from application_health_info h where h.application_id = v_application_id;

    update import_rows set
      action_taken = 'updated',
      previous_application_snapshot = v_previous_application,
      previous_answers_snapshot = v_previous_answers,
      previous_travel_snapshot = v_previous_travel,
      previous_health_snapshot = v_previous_health,
      destination_application_id = v_application_id
    where id = v_row.id;
  else
    v_application_number := next_application_number();

    insert into applications (applicant_id, imported_email, import_batch_id, status, application_number)
    values (null, v_email, p_import_batch_id, 'accepted', v_application_number)
    returning id into v_application_id;

    update import_rows set
      action_taken = 'inserted',
      destination_application_id = v_application_id
    where id = v_row.id;
  end if;

  foreach v_key in array v_text_columns loop
    if v_normalized ? v_key then
      v_value := v_normalized->v_key;
      v_is_array := jsonb_typeof(v_value) = 'array';
      v_set_clauses := v_set_clauses || format(
        '%I = %L',
        v_key,
        case
          when v_value is null or jsonb_typeof(v_value) = 'null' then null
          when v_is_array then (select string_agg(e, ', ') from jsonb_array_elements_text(v_value) as e)
          else v_value #>> '{}'
        end
      );
    end if;
  end loop;

  foreach v_key in array v_array_columns loop
    if v_normalized ? v_key then
      v_value := v_normalized->v_key;
      v_set_clauses := v_set_clauses || format(
        '%I = %L::text[]',
        v_key,
        case
          when v_value is null or jsonb_typeof(v_value) = 'null' then null
          when jsonb_typeof(v_value) = 'array' then (
            select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_value) as e
          )
          else array[v_value #>> '{}']
        end
      );
    end if;
  end loop;

  ------------------------------------------------------------------
  -- Phase B: applications.full_name -- never overwrite an existing
  -- non-blank value with a blank imported one (approved decision #1). A
  -- non-blank imported name always overwrites (matching every other
  -- re-importable column's existing behavior); a blank/absent imported name
  -- leaves whatever full_name the application already has untouched.
  ------------------------------------------------------------------
  if v_normalized ? 'full_name' then
    v_full_name := nullif(trim(both from (v_normalized->>'full_name')), '');
    if v_full_name is not null then
      v_set_clauses := v_set_clauses || format('full_name = %L', v_full_name);
    end if;
  end if;

  if v_normalized ? 'birth_date' then
    declare
      v_birth_raw text := v_normalized->>'birth_date';
      v_birth_date date;
    begin
      if v_birth_raw is not null and v_birth_raw <> '' then
        begin
          v_birth_date := v_birth_raw::date;
          v_set_clauses := v_set_clauses || format('birth_date = %L::date', v_birth_date);
        exception when others then
          null;
        end;
      end if;
    end;
  end if;

  v_set_clauses := v_set_clauses || format('last_import_row_fingerprint = %L', v_row.row_fingerprint);

  if array_length(v_set_clauses, 1) > 0 then
    v_update_sql := format(
      'update applications set %s where id = %L',
      array_to_string(v_set_clauses, ', '),
      v_application_id
    );
    execute v_update_sql;
  end if;

  ------------------------------------------------------------------
  -- Phase B: application_travel_info -- conditional upsert. Only executed
  -- if at least one mapped travel target_key has a non-blank value in this
  -- row (design doc section 13.6: "avoid creating empty sensitive rows when
  -- all related fields are blank"). Text/boolean columns via
  -- v_travel_columns; the three passport dates handled separately since an
  -- unparseable date must not abort the row (matches birth_date's existing
  -- swallow-and-skip-that-one-field pattern) but IS still flagged upstream
  -- as a row-validation warning (see row-validation.ts's isPlausibleDate) --
  -- the SQL layer's job here is only to not crash on a bad date string, not
  -- to be the sole place that catches it.
  ------------------------------------------------------------------
  -- Built with real bind-style placeholders via a single parameterized
  -- INSERT ... ON CONFLICT, not dynamic-SQL column assembly: every
  -- application_travel_info column is always present in the statement (as
  -- NULL where this row has no value for it), and ON CONFLICT DO UPDATE SET
  -- col = COALESCE(EXCLUDED.col, application_travel_info.col) means an
  -- absent/blank field in THIS import never clobbers a value a previous
  -- import (or manual edit) already set for that same participant -- while
  -- a present, non-blank field always overwrites, matching every other
  -- re-importable column's existing behavior. has_travel_data guards
  -- against creating an empty row when nothing in this section was mapped
  -- at all.
  declare
    v_has_travel_data boolean := false;
    v_passport_issue_date date;
    v_passport_expiry_date date;
    v_passport_birth_date date;
  begin
    foreach v_key in array v_travel_columns || v_travel_date_columns loop
      if v_normalized ? v_key and v_normalized->>v_key is not null and v_normalized->>v_key <> '' then
        v_has_travel_data := true;
      end if;
    end loop;

    if v_has_travel_data then
      begin v_passport_issue_date := nullif(v_normalized->>'passport_issue_date', '')::date; exception when others then v_passport_issue_date := null; end;
      begin v_passport_expiry_date := nullif(v_normalized->>'passport_expiry_date', '')::date; exception when others then v_passport_expiry_date := null; end;
      begin v_passport_birth_date := nullif(v_normalized->>'passport_birth_date', '')::date; exception when others then v_passport_birth_date := null; end;

      insert into application_travel_info (
        application_id, support_level_requested, can_attend_without_full_support,
        departure_airport, visa_required, invitation_letter_required,
        passport_full_name, passport_full_name_ar, passport_place_of_issue,
        passport_issue_date, passport_expiry_date, passport_birth_date,
        passport_copy_url, passport_photo_url
      ) values (
        v_application_id,
        nullif(v_normalized->>'support_level_requested', ''),
        nullif(v_normalized->>'can_attend_without_full_support', '')::boolean,
        nullif(v_normalized->>'departure_airport', ''),
        nullif(v_normalized->>'visa_required', '')::boolean,
        nullif(v_normalized->>'invitation_letter_required', '')::boolean,
        nullif(v_normalized->>'passport_full_name', ''),
        nullif(v_normalized->>'passport_full_name_ar', ''),
        nullif(v_normalized->>'passport_place_of_issue', ''),
        v_passport_issue_date,
        v_passport_expiry_date,
        v_passport_birth_date,
        nullif(v_normalized->>'passport_copy_url', ''),
        nullif(v_normalized->>'passport_photo_url', '')
      )
      on conflict (application_id) do update set
        support_level_requested = coalesce(excluded.support_level_requested, application_travel_info.support_level_requested),
        can_attend_without_full_support = coalesce(excluded.can_attend_without_full_support, application_travel_info.can_attend_without_full_support),
        departure_airport = coalesce(excluded.departure_airport, application_travel_info.departure_airport),
        visa_required = coalesce(excluded.visa_required, application_travel_info.visa_required),
        invitation_letter_required = coalesce(excluded.invitation_letter_required, application_travel_info.invitation_letter_required),
        passport_full_name = coalesce(excluded.passport_full_name, application_travel_info.passport_full_name),
        passport_full_name_ar = coalesce(excluded.passport_full_name_ar, application_travel_info.passport_full_name_ar),
        passport_place_of_issue = coalesce(excluded.passport_place_of_issue, application_travel_info.passport_place_of_issue),
        passport_issue_date = coalesce(excluded.passport_issue_date, application_travel_info.passport_issue_date),
        passport_expiry_date = coalesce(excluded.passport_expiry_date, application_travel_info.passport_expiry_date),
        passport_birth_date = coalesce(excluded.passport_birth_date, application_travel_info.passport_birth_date),
        passport_copy_url = coalesce(excluded.passport_copy_url, application_travel_info.passport_copy_url),
        passport_photo_url = coalesce(excluded.passport_photo_url, application_travel_info.passport_photo_url),
        updated_at = now();
    end if;
  end;

  ------------------------------------------------------------------
  -- Phase B: application_health_info -- same real-INSERT-ON-CONFLICT shape
  -- as application_travel_info above (see that block's comment for the full
  -- rationale). consent_given is boolean, cast defensively via nullif so a
  -- malformed value never aborts the whole row.
  ------------------------------------------------------------------
  declare
    v_has_health_data boolean := false;
    v_consent_given boolean;
  begin
    foreach v_key in array v_health_columns || v_health_bool_columns loop
      if v_normalized ? v_key and v_normalized->>v_key is not null and v_normalized->>v_key <> '' then
        v_has_health_data := true;
      end if;
    end loop;

    if v_has_health_data then
      begin v_consent_given := nullif(v_normalized->>'consent_given', '')::boolean; exception when others then v_consent_given := null; end;

      insert into application_health_info (
        application_id, allergies, medical_conditions, emergency_medication,
        accessibility_requirements, dietary_requirements, accommodation_preference,
        cultural_or_religious_requirements, emergency_contact_name,
        emergency_contact_relationship, emergency_contact_phone, consent_given
      ) values (
        v_application_id,
        nullif(v_normalized->>'allergies', ''),
        nullif(v_normalized->>'medical_conditions', ''),
        nullif(v_normalized->>'emergency_medication', ''),
        nullif(v_normalized->>'accessibility_requirements', ''),
        nullif(v_normalized->>'dietary_requirements', ''),
        nullif(v_normalized->>'accommodation_preference', ''),
        nullif(v_normalized->>'cultural_or_religious_requirements', ''),
        nullif(v_normalized->>'emergency_contact_name', ''),
        nullif(v_normalized->>'emergency_contact_relationship', ''),
        nullif(v_normalized->>'emergency_contact_phone', ''),
        v_consent_given
      )
      on conflict (application_id) do update set
        allergies = coalesce(excluded.allergies, application_health_info.allergies),
        medical_conditions = coalesce(excluded.medical_conditions, application_health_info.medical_conditions),
        emergency_medication = coalesce(excluded.emergency_medication, application_health_info.emergency_medication),
        accessibility_requirements = coalesce(excluded.accessibility_requirements, application_health_info.accessibility_requirements),
        dietary_requirements = coalesce(excluded.dietary_requirements, application_health_info.dietary_requirements),
        accommodation_preference = coalesce(excluded.accommodation_preference, application_health_info.accommodation_preference),
        cultural_or_religious_requirements = coalesce(excluded.cultural_or_religious_requirements, application_health_info.cultural_or_religious_requirements),
        emergency_contact_name = coalesce(excluded.emergency_contact_name, application_health_info.emergency_contact_name),
        emergency_contact_relationship = coalesce(excluded.emergency_contact_relationship, application_health_info.emergency_contact_relationship),
        emergency_contact_phone = coalesce(excluded.emergency_contact_phone, application_health_info.emergency_contact_phone),
        consent_given = coalesce(excluded.consent_given, application_health_info.consent_given),
        updated_at = now();
    end if;
  end;

  ------------------------------------------------------------------
  -- application_answers: every normalized key, regardless of section,
  -- exactly as before (design doc section 13.7: original imported answers
  -- are preserved even for keys that also land on a first-class column or a
  -- travel/health table). Phase B adds `section` tagging so a future admin
  -- view can filter without re-deriving section from question_key.
  ------------------------------------------------------------------
  for v_key, v_value in select * from jsonb_each(v_normalized) loop
    v_section := case
      when v_key = any(v_travel_columns) or v_key = any(v_travel_date_columns) then 'travel'
      when v_key = any(v_health_columns) or v_key = any(v_health_bool_columns) then 'health'
      when v_key in (
        'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas',
        'language_ability', 'organization', 'organization_role', 'experience_level', 'interests',
        'topics_to_learn', 'volunteer_experience_years', 'previous_conference_participation',
        'initiative_or_organization_name', 'expected_contribution', 'expected_skills_experiences'
      ) then 'allocation'
      when v_key in (
        'gender', 'whatsapp_number', 'education_level', 'institution_or_workplace', 'linkedin_url',
        'primary_track', 'secondary_track', 'full_name', 'nationality', 'city', 'country', 'age_group', 'preferred_language',
        'funding_type'
      ) then 'profile'
      else 'application'
    end;

    insert into application_answers (
      application_id, question_key, normalized_value, raw_value, value_type,
      source, is_sensitive, import_batch_id, section
    ) values (
      v_application_id,
      v_key,
      case
        when jsonb_typeof(v_value) = 'string' then v_value #>> '{}'
        else v_value::text
      end,
      coalesce(
        v_raw_values->>v_key,
        case
          when jsonb_typeof(v_value) = 'string' then v_value #>> '{}'
          else v_value::text
        end
      ),
      case when jsonb_typeof(v_value) = 'array' then 'multiselect' else 'text' end,
      'import',
      v_key in (
        'accessibility_requirements', 'dietary_requirements',
        'emergency_contact_name', 'emergency_contact_relationship', 'emergency_contact_phone',
        'special_needs', 'allergies', 'medical_conditions', 'emergency_medication',
        'accommodation_preference', 'cultural_or_religious_requirements', 'consent_given'
      ),
      p_import_batch_id,
      v_section
    )
    on conflict (application_id, question_key, source) do update set
      normalized_value = excluded.normalized_value,
      raw_value = excluded.raw_value,
      value_type = excluded.value_type,
      is_sensitive = excluded.is_sensitive,
      import_batch_id = excluded.import_batch_id,
      section = excluded.section;
  end loop;

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    insert into application_status_history (application_id, old_status, new_status, changed_by, note)
    values (
      v_application_id,
      (v_previous_application->>'status')::application_status,
      'accepted',
      p_actor_id,
      format('Updated by import batch %s', p_import_batch_id)
    );
  else
    insert into application_status_history (application_id, old_status, new_status, changed_by, note)
    values (v_application_id, null, 'accepted', p_actor_id, format('Created by import batch %s', p_import_batch_id));
  end if;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'application',
    v_application_id,
    case when v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then 'import_update' else 'import_insert' end,
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_import_batch_id, 'importRowId', v_row.id)
  );

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    return 'updated';
  end if;
  return 'inserted';
end;
$$ language plpgsql set search_path = public, pg_temp;

comment on function apply_import_row_transactional(uuid, uuid, uuid) is
  'Per-row transactional import apply. Adds funding_type (plain text-like '
  'column written via v_text_columns) on top of the Phase B feature set: '
  'applications.full_name (never overwrites an existing non-blank value '
  'with a blank import), 4 structured allocation array columns '
  '(session_languages, track_1/2/3_focus_areas), and conditional upserts '
  'into application_travel_info/application_health_info (only when at '
  'least one mapped field for that section is non-blank). '
  'v_travel_columns/v_health_columns MUST stay in sync with '
  'src/lib/import/known-application-columns.ts (the TS-side manifest '
  'confirmMapping validates against) and with rollback_import_batch_'
  'transactional''s own restore arrays -- update all three together. The '
  'is_sensitive key list is sourced from SENSITIVE_QUESTION_KEYS in '
  'src/lib/validation/import.ts -- keep both in sync.';

------------------------------------------------------------------
-- rollback_import_batch_transactional -- extended per the two functions'
-- documented "must stay in sync" invariant. Only v_restorable_columns
-- changes (adds funding_type); every other line is identical to
-- 20260731110000_phase_b_apply_import_row_sensitive_writes.sql.
------------------------------------------------------------------
create or replace function rollback_import_batch_transactional(
  p_batch_id uuid,
  p_actor_id uuid
) returns void as $$
declare
  v_batch import_batches;
  v_blocker_count int;
  v_blocker_detail text;
  v_scope_application_ids uuid[];
  v_row record;
  v_snapshot jsonb;
  v_answers jsonb;
  v_application_id uuid;
  v_old_status application_status;
  v_update_sql text;
  v_set_clauses text[];
  v_key text;
  v_restorable_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs',
    'birth_date',
    -- Phase B
    'full_name', 'gender', 'whatsapp_number', 'education_level',
    'institution_or_workplace', 'linkedin_url', 'primary_track', 'secondary_track',
    'funding_type'
  ];
  v_array_columns text[] := array[
    'interests', 'track_interests',
    'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas'
  ];
begin
  select * into v_batch from import_batches where id = p_batch_id for update;

  if v_batch.id is null then
    raise exception 'Import batch % not found', p_batch_id;
  end if;

  if v_batch.status = 'rolled_back' then
    raise exception 'Import batch % has already been rolled back', p_batch_id;
  end if;

  select coalesce(array_agg(distinct id), array[]::uuid[])
  into v_scope_application_ids
  from (
    select a.id
    from applications a
    where a.import_batch_id = p_batch_id
    union
    select r.destination_application_id as id
    from import_rows r
    where r.import_batch_id = p_batch_id
      and r.destination_application_id is not null
      and r.action_taken in ('inserted', 'updated')
  ) scope;

  select count(*) into v_blocker_count
  from participant_feature_snapshots s
  where s.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_feature_snapshots row(s) reference applications from this batch. Delete the feature extraction run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from cluster_memberships c
  where c.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % cluster_memberships row(s) reference applications from this batch. Delete the clustering run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from allocation_assignments al
  where al.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % allocation_assignments row(s) reference applications from this batch. Delete the allocation run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from schedule_publications sp
  where sp.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publications row(s) reference applications from this batch. Retract the publication first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from schedule_publication_draft_items spdi
  where spdi.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publication_draft_items row(s) reference applications from this batch. Discard the schedule draft first.',
      p_batch_id, v_blocker_count;
  end if;

  perform 1
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
  for update of pi;

  select count(*), string_agg(distinct pi.status, ', ' order by pi.status)
  into v_blocker_count, v_blocker_detail
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
    and pi.status <> 'not_sent';
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_invitations row(s) for applications in this batch are no longer in ''not_sent'' status (found: %). An invitation has already been sent to a real recipient and an auth user may exist for them; revoke the invitation(s) before rolling back.',
      p_batch_id, v_blocker_count, v_blocker_detail;
  end if;

  for v_row in
    select * from import_rows
    where import_batch_id = p_batch_id
      and action_taken in ('inserted', 'updated')
    order by excel_row_number
    for update
  loop
    v_application_id := v_row.destination_application_id;

    if v_row.action_taken = 'inserted' then
      if v_application_id is not null then
        insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
        values (
          'application',
          v_application_id,
          'import_rollback_delete',
          'admin',
          p_actor_id,
          jsonb_build_object(
            'batchId', p_batch_id,
            'importRowId', v_row.id,
            'excelRowNumber', v_row.excel_row_number
          )
        );

        -- Phase B: application_travel_info/application_health_info rows for
        -- this application are cascade-deleted automatically by this same
        -- delete (both tables are `on delete cascade` from
        -- applications(id)) -- no new statement needed here.
        delete from applications where id = v_application_id;
      end if;

    else
      v_snapshot := v_row.previous_application_snapshot;

      if v_application_id is null or v_snapshot is null then
        raise exception 'Cannot roll back import batch %: import row % is marked ''updated'' but has no recoverable snapshot (destination_application_id=%, previous_application_snapshot is null).',
          p_batch_id, v_row.id, v_application_id;
      end if;

      perform 1 from applications where id = v_application_id for update;

      select status into v_old_status from applications where id = v_application_id;

      v_set_clauses := array[]::text[];

      foreach v_key in array v_restorable_columns loop
        v_set_clauses := v_set_clauses || format('%I = %L', v_key, v_snapshot->>v_key);
      end loop;

      foreach v_key in array v_array_columns loop
        v_set_clauses := v_set_clauses || format(
          '%I = %L::text[]',
          v_key,
          case
            when v_snapshot->v_key is null or jsonb_typeof(v_snapshot->v_key) = 'null' then null
            else (select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_snapshot->v_key) as e)
          end
        );
      end loop;

      v_set_clauses := v_set_clauses || format('status = %L::application_status', (v_snapshot->>'status')::application_status);

      v_update_sql := format(
        'update applications set %s where id = %L',
        array_to_string(v_set_clauses, ', '),
        v_application_id
      );
      execute v_update_sql;

      delete from application_answers where application_id = v_application_id;

      v_answers := coalesce(v_row.previous_answers_snapshot, '[]'::jsonb);

      insert into application_answers (
        id, application_id, question_key, question_label, normalized_value,
        raw_value, value_type, source, is_sensitive, import_batch_id,
        section, created_at, updated_at
      )
      select
        (e->>'id')::uuid,
        (e->>'application_id')::uuid,
        e->>'question_key',
        e->>'question_label',
        e->>'normalized_value',
        e->>'raw_value',
        e->>'value_type',
        e->>'source',
        (e->>'is_sensitive')::boolean,
        (e->>'import_batch_id')::uuid,
        -- Phase B: section was added after some pre-existing snapshots may
        -- have been captured without it; coalesce to the column default so
        -- a snapshot taken before this migration still restores cleanly.
        coalesce(e->>'section', 'application'),
        (e->>'created_at')::timestamptz,
        (e->>'updated_at')::timestamptz
      from jsonb_array_elements(v_answers) as e;

      -- Phase B: restore application_travel_info/application_health_info to
      -- their pre-update state. Each is delete-then-conditionally-reinsert
      -- (mirroring application_answers' own delete-and-reinsert pattern
      -- immediately above) rather than an UPDATE, since the row may not
      -- have existed at all before this apply (e.g. the first import that
      -- added travel data to a previously travel-less application) --
      -- deleting and only reinserting if a real snapshot exists correctly
      -- restores that "no row" state too.
      delete from application_travel_info where application_id = v_application_id;
      if v_row.previous_travel_snapshot is not null then
        insert into application_travel_info (
          application_id, support_level_requested, can_attend_without_full_support,
          departure_airport, visa_required, invitation_letter_required,
          passport_full_name, passport_full_name_ar, passport_birth_date,
          passport_place_of_issue, passport_issue_date, passport_expiry_date,
          passport_copy_url, passport_photo_url, created_at, updated_at
        )
        select
          v_application_id,
          e->>'support_level_requested',
          (e->>'can_attend_without_full_support')::boolean,
          e->>'departure_airport',
          (e->>'visa_required')::boolean,
          (e->>'invitation_letter_required')::boolean,
          e->>'passport_full_name',
          e->>'passport_full_name_ar',
          (e->>'passport_birth_date')::date,
          e->>'passport_place_of_issue',
          (e->>'passport_issue_date')::date,
          (e->>'passport_expiry_date')::date,
          e->>'passport_copy_url',
          e->>'passport_photo_url',
          (e->>'created_at')::timestamptz,
          (e->>'updated_at')::timestamptz
        from (select v_row.previous_travel_snapshot as e) s;
      end if;

      delete from application_health_info where application_id = v_application_id;
      if v_row.previous_health_snapshot is not null then
        insert into application_health_info (
          application_id, allergies, medical_conditions, emergency_medication,
          accessibility_requirements, dietary_requirements, accommodation_preference,
          cultural_or_religious_requirements, emergency_contact_name,
          emergency_contact_relationship, emergency_contact_phone, consent_given,
          created_at, updated_at
        )
        select
          v_application_id,
          e->>'allergies',
          e->>'medical_conditions',
          e->>'emergency_medication',
          e->>'accessibility_requirements',
          e->>'dietary_requirements',
          e->>'accommodation_preference',
          e->>'cultural_or_religious_requirements',
          e->>'emergency_contact_name',
          e->>'emergency_contact_relationship',
          e->>'emergency_contact_phone',
          (e->>'consent_given')::boolean,
          (e->>'created_at')::timestamptz,
          (e->>'updated_at')::timestamptz
        from (select v_row.previous_health_snapshot as e) s;
      end if;

      insert into application_status_history (application_id, old_status, new_status, changed_by, note)
      values (
        v_application_id,
        v_old_status,
        (v_snapshot->>'status')::application_status,
        p_actor_id,
        format('Restored by rollback of import batch %s', p_batch_id)
      );

      insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, new_values)
      values (
        'application',
        v_application_id,
        'import_rollback_restore',
        'admin',
        p_actor_id,
        jsonb_build_object(
          'batchId', p_batch_id,
          'importRowId', v_row.id,
          'excelRowNumber', v_row.excel_row_number,
          'restoredAnswerCount', jsonb_array_length(v_answers)
        ),
        v_snapshot
      );
    end if;

    update import_rows set
      action_taken = null,
      previous_application_snapshot = null,
      previous_answers_snapshot = null,
      previous_travel_snapshot = null,
      previous_health_snapshot = null
    where id = v_row.id;
  end loop;

  update import_batches set
    status = 'rolled_back',
    inserted_count = 0,
    updated_count = 0,
    processing_lock_token = null,
    processing_lock_expires_at = null,
    next_chunk_offset = 0
  where id = p_batch_id;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'import_batch',
    p_batch_id,
    'import_rollback',
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_batch_id)
  );
end;
$$ language plpgsql set search_path = public, pg_temp;

comment on function rollback_import_batch_transactional(uuid, uuid) is
  'Undoes an entire import batch atomically, or refuses entirely. Adds '
  'funding_type to v_restorable_columns on top of the Phase B feature set '
  '(restoring application_travel_info/application_health_info on an '
  'updated-row rollback via delete-then-conditionally-reinsert from '
  'import_rows.previous_travel_snapshot/previous_health_snapshot, '
  'mirroring application_answers'' own pattern) -- an inserted-row rollback '
  'needs no new logic since both tables cascade-delete from '
  'applications(id) for free. v_restorable_columns/v_array_columns MUST '
  'stay in sync with apply_import_row_transactional''s own arrays -- '
  'update both together.';


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260820110000_add_funding_type_to_import')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260820120000_rollback_import_batch_security_definer.sql
-- ============================================================
-- 20260820120000_rollback_import_batch_security_definer.sql
--
-- Fixes "permission denied for table applications" when rolling back an
-- import batch through the real UI path (rollback-action.ts calls this RPC
-- via a service-role client, per requireImportStaffCaller). Root cause,
-- confirmed by direct inspection (not assumed):
--
--   1. `applications` has no DELETE grant for `authenticated` OR
--      `service_role` (20260816000000_canonical_authenticated_and_
--      service_role_grants.sql's own comment states DELETE is granted
--      "ONLY where a real, traced code path performs one" at the
--      table-grant level, and explicitly defers every RPC-body DELETE to
--      SECURITY DEFINER instead -- e.g. session_tags).
--   2. There is no staff DELETE policy on `applications` (only
--      applications_delete_own_draft, scoped to a participant's own draft).
--   3. service_role bypasses RLS (rolbypassrls = true) but table-level
--      GRANTs are a SEPARATE mechanism RLS bypass does not cover --
--      confirmed live: service_role has SELECT/INSERT/UPDATE but no
--      DELETE grant on applications, same gap as authenticated.
--
-- So `delete from applications ...` inside rollback_import_batch_
-- transactional (SECURITY INVOKER today) fails for every possible caller,
-- matching the canonical grants migration's own stated design: this
-- function should have been SECURITY DEFINER from the start, like
-- claim_imported_application_transactional (20260726110000) and 17 other
-- functions in this codebase, so its DELETE runs as the function owner
-- (postgres) and needs no table-level grant at all.
--
-- Fixing this by ADDING a table-level DELETE grant instead was explicitly
-- rejected (would open unrestricted staff/service delete access on
-- `applications`, contradicting the canonical grants migration's own
-- "DELETE only where a traced direct-DELETE call site exists" discipline).
--
-- Compared line-by-line against claim_imported_application_transactional's
-- three security properties, per explicit review requirement:
--
--   1. search_path: claim_imported_application_transactional uses
--      `set search_path = public, pg_temp` (20260726110000, closing line).
--      This function already had `set search_path = public, pg_temp` on
--      every prior revision (unaffected by this change) -- confirmed
--      identical, no gap to close.
--   2. Caller identity/authorization check: claim_imported_application_
--      transactional asserts `p_claiming_user_id = auth.uid()` (an
--      IDENTITY check, appropriate there because it's a participant
--      claiming an application FOR THEMSELVES). This function is
--      different: it's a STAFF operation with no "owning user" concept, so
--      the correct analogous check is a ROLE check, not an identity check
--      -- added below via current_user_role(), matching
--      requireImportStaffCaller's real role set (isAgendaStaffRole OR
--      isParticipantsCommunicationsStaffRole: agenda_allocation_manager,
--      participants_communications_manager, super_admin) exactly, so the
--      DB-level check cannot authorize anyone the TS-level gate would
--      reject.
--   3. Narrow EXECUTE grant: claim_imported_application_transactional does
--      `revoke all ... from public; grant execute ... to authenticated`.
--      Applied identically below, to authenticated (the RPC is invoked via
--      PostgREST using the caller's own session in the general case, per
--      Postgres/PostgREST's execution model even when the *application
--      code* happens to use a service-role client -- narrowing to
--      authenticated, not granting to service_role separately, since
--      service_role already bypasses grant restrictions as the bypassrls
--      superrole-adjacent role and needs no explicit EXECUTE grant to call
--      any function).
--
-- Row-level delete scope (the third explicit review requirement): the
-- DELETE at "delete from applications where id = v_application_id" is
-- reached only via v_application_id := v_row.destination_application_id,
-- where v_row is drawn from
--   `for v_row in select * from import_rows where import_batch_id =
--   p_batch_id and action_taken in ('inserted', 'updated') ... loop`
-- (unchanged by this migration) -- so the DELETE can structurally never
-- touch any row outside p_batch_id's own import_rows. SECURITY DEFINER
-- does not weaken this: the WHERE clause is unconditional regardless of
-- executing role.
--
-- No change to apply_import_row_transactional in this migration -- it
-- performs no DELETE on applications (only UPDATE, which authenticated and
-- service_role already have granted), so it is not affected by this gap.
--
-- Body is otherwise byte-for-byte identical to
-- 20260820110000_add_funding_type_to_import.sql's rollback function,
-- except: (a) `security definer` added to the language clause, (b) a new
-- caller-authorization block inserted immediately after the `begin`.

create or replace function rollback_import_batch_transactional(
  p_batch_id uuid,
  p_actor_id uuid
) returns void as $$
declare
  v_batch import_batches;
  v_blocker_count int;
  v_blocker_detail text;
  v_scope_application_ids uuid[];
  v_row record;
  v_snapshot jsonb;
  v_answers jsonb;
  v_application_id uuid;
  v_old_status application_status;
  v_update_sql text;
  v_set_clauses text[];
  v_key text;
  v_restorable_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs',
    'birth_date',
    -- Phase B
    'full_name', 'gender', 'whatsapp_number', 'education_level',
    'institution_or_workplace', 'linkedin_url', 'primary_track', 'secondary_track',
    'funding_type'
  ];
  v_array_columns text[] := array[
    'interests', 'track_interests',
    'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas'
  ];
begin
  ------------------------------------------------------------------
  -- SECURITY DEFINER means RLS provides ZERO protection inside this body,
  -- so this check IS the entire authorization boundary for this function.
  -- Mirrors requireImportStaffCaller's exact role set (src/lib/import/
  -- server-helpers.ts): isAgendaStaffRole OR
  -- isParticipantsCommunicationsStaffRole -- agenda_allocation_manager,
  -- participants_communications_manager, or super_admin. current_user_role()
  -- is the existing security-definer helper (20260721212035_rls_policies.sql)
  -- already used throughout this schema's RLS policies, reused unchanged
  -- here rather than re-implemented.
  ------------------------------------------------------------------
  if current_user_role() not in ('agenda_allocation_manager', 'participants_communications_manager', 'super_admin') then
    raise exception 'Not authorized to roll back an import batch';
  end if;

  select * into v_batch from import_batches where id = p_batch_id for update;

  if v_batch.id is null then
    raise exception 'Import batch % not found', p_batch_id;
  end if;

  if v_batch.status = 'rolled_back' then
    raise exception 'Import batch % has already been rolled back', p_batch_id;
  end if;

  select coalesce(array_agg(distinct id), array[]::uuid[])
  into v_scope_application_ids
  from (
    select a.id
    from applications a
    where a.import_batch_id = p_batch_id
    union
    select r.destination_application_id as id
    from import_rows r
    where r.import_batch_id = p_batch_id
      and r.destination_application_id is not null
      and r.action_taken in ('inserted', 'updated')
  ) scope;

  select count(*) into v_blocker_count
  from participant_feature_snapshots s
  where s.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_feature_snapshots row(s) reference applications from this batch. Delete the feature extraction run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from cluster_memberships c
  where c.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % cluster_memberships row(s) reference applications from this batch. Delete the clustering run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from allocation_assignments al
  where al.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % allocation_assignments row(s) reference applications from this batch. Delete the allocation run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from schedule_publications sp
  where sp.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publications row(s) reference applications from this batch. Retract the publication first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from schedule_publication_draft_items spdi
  where spdi.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publication_draft_items row(s) reference applications from this batch. Discard the schedule draft first.',
      p_batch_id, v_blocker_count;
  end if;

  perform 1
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
  for update of pi;

  select count(*), string_agg(distinct pi.status, ', ' order by pi.status)
  into v_blocker_count, v_blocker_detail
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
    and pi.status <> 'not_sent';
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_invitations row(s) for applications in this batch are no longer in ''not_sent'' status (found: %). An invitation has already been sent to a real recipient and an auth user may exist for them; revoke the invitation(s) before rolling back.',
      p_batch_id, v_blocker_count, v_blocker_detail;
  end if;

  for v_row in
    select * from import_rows
    where import_batch_id = p_batch_id
      and action_taken in ('inserted', 'updated')
    order by excel_row_number
    for update
  loop
    v_application_id := v_row.destination_application_id;

    if v_row.action_taken = 'inserted' then
      if v_application_id is not null then
        insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
        values (
          'application',
          v_application_id,
          'import_rollback_delete',
          'admin',
          p_actor_id,
          jsonb_build_object(
            'batchId', p_batch_id,
            'importRowId', v_row.id,
            'excelRowNumber', v_row.excel_row_number
          )
        );

        -- Phase B: application_travel_info/application_health_info rows for
        -- this application are cascade-deleted automatically by this same
        -- delete (both tables are `on delete cascade` from
        -- applications(id)) -- no new statement needed here.
        delete from applications where id = v_application_id;
      end if;

    else
      v_snapshot := v_row.previous_application_snapshot;

      if v_application_id is null or v_snapshot is null then
        raise exception 'Cannot roll back import batch %: import row % is marked ''updated'' but has no recoverable snapshot (destination_application_id=%, previous_application_snapshot is null).',
          p_batch_id, v_row.id, v_application_id;
      end if;

      perform 1 from applications where id = v_application_id for update;

      select status into v_old_status from applications where id = v_application_id;

      v_set_clauses := array[]::text[];

      foreach v_key in array v_restorable_columns loop
        v_set_clauses := v_set_clauses || format('%I = %L', v_key, v_snapshot->>v_key);
      end loop;

      foreach v_key in array v_array_columns loop
        v_set_clauses := v_set_clauses || format(
          '%I = %L::text[]',
          v_key,
          case
            when v_snapshot->v_key is null or jsonb_typeof(v_snapshot->v_key) = 'null' then null
            else (select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_snapshot->v_key) as e)
          end
        );
      end loop;

      v_set_clauses := v_set_clauses || format('status = %L::application_status', (v_snapshot->>'status')::application_status);

      v_update_sql := format(
        'update applications set %s where id = %L',
        array_to_string(v_set_clauses, ', '),
        v_application_id
      );
      execute v_update_sql;

      delete from application_answers where application_id = v_application_id;

      v_answers := coalesce(v_row.previous_answers_snapshot, '[]'::jsonb);

      insert into application_answers (
        id, application_id, question_key, question_label, normalized_value,
        raw_value, value_type, source, is_sensitive, import_batch_id,
        section, created_at, updated_at
      )
      select
        (e->>'id')::uuid,
        (e->>'application_id')::uuid,
        e->>'question_key',
        e->>'question_label',
        e->>'normalized_value',
        e->>'raw_value',
        e->>'value_type',
        e->>'source',
        (e->>'is_sensitive')::boolean,
        (e->>'import_batch_id')::uuid,
        coalesce(e->>'section', 'application'),
        (e->>'created_at')::timestamptz,
        (e->>'updated_at')::timestamptz
      from jsonb_array_elements(v_answers) as e;

      delete from application_travel_info where application_id = v_application_id;
      if v_row.previous_travel_snapshot is not null then
        insert into application_travel_info (
          application_id, support_level_requested, can_attend_without_full_support,
          departure_airport, visa_required, invitation_letter_required,
          passport_full_name, passport_full_name_ar, passport_birth_date,
          passport_place_of_issue, passport_issue_date, passport_expiry_date,
          passport_copy_url, passport_photo_url, created_at, updated_at
        )
        select
          v_application_id,
          e->>'support_level_requested',
          (e->>'can_attend_without_full_support')::boolean,
          e->>'departure_airport',
          (e->>'visa_required')::boolean,
          (e->>'invitation_letter_required')::boolean,
          e->>'passport_full_name',
          e->>'passport_full_name_ar',
          (e->>'passport_birth_date')::date,
          e->>'passport_place_of_issue',
          (e->>'passport_issue_date')::date,
          (e->>'passport_expiry_date')::date,
          e->>'passport_copy_url',
          e->>'passport_photo_url',
          (e->>'created_at')::timestamptz,
          (e->>'updated_at')::timestamptz
        from (select v_row.previous_travel_snapshot as e) s;
      end if;

      delete from application_health_info where application_id = v_application_id;
      if v_row.previous_health_snapshot is not null then
        insert into application_health_info (
          application_id, allergies, medical_conditions, emergency_medication,
          accessibility_requirements, dietary_requirements, accommodation_preference,
          cultural_or_religious_requirements, emergency_contact_name,
          emergency_contact_relationship, emergency_contact_phone, consent_given,
          created_at, updated_at
        )
        select
          v_application_id,
          e->>'allergies',
          e->>'medical_conditions',
          e->>'emergency_medication',
          e->>'accessibility_requirements',
          e->>'dietary_requirements',
          e->>'accommodation_preference',
          e->>'cultural_or_religious_requirements',
          e->>'emergency_contact_name',
          e->>'emergency_contact_relationship',
          e->>'emergency_contact_phone',
          (e->>'consent_given')::boolean,
          (e->>'created_at')::timestamptz,
          (e->>'updated_at')::timestamptz
        from (select v_row.previous_health_snapshot as e) s;
      end if;

      insert into application_status_history (application_id, old_status, new_status, changed_by, note)
      values (
        v_application_id,
        v_old_status,
        (v_snapshot->>'status')::application_status,
        p_actor_id,
        format('Restored by rollback of import batch %s', p_batch_id)
      );

      insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, new_values)
      values (
        'application',
        v_application_id,
        'import_rollback_restore',
        'admin',
        p_actor_id,
        jsonb_build_object(
          'batchId', p_batch_id,
          'importRowId', v_row.id,
          'excelRowNumber', v_row.excel_row_number,
          'restoredAnswerCount', jsonb_array_length(v_answers)
        ),
        v_snapshot
      );
    end if;

    update import_rows set
      action_taken = null,
      previous_application_snapshot = null,
      previous_answers_snapshot = null,
      previous_travel_snapshot = null,
      previous_health_snapshot = null
    where id = v_row.id;
  end loop;

  update import_batches set
    status = 'rolled_back',
    inserted_count = 0,
    updated_count = 0,
    processing_lock_token = null,
    processing_lock_expires_at = null,
    next_chunk_offset = 0
  where id = p_batch_id;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'import_batch',
    p_batch_id,
    'import_rollback',
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_batch_id)
  );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

comment on function rollback_import_batch_transactional(uuid, uuid) is
  'Undoes an entire import batch atomically, or refuses entirely. SECURITY '
  'DEFINER as of 20260820120000 (was invoker; applications has no DELETE '
  'grant for authenticated or service_role, matching the canonical grants '
  'migration''s design that RPC-body deletes run as definer, not via a '
  'table grant) -- the current_user_role() check at the top of this '
  'function is therefore the ENTIRE authorization boundary and must never '
  'be removed or loosened without an equivalent replacement. Restores '
  'application_travel_info/application_health_info on an updated-row '
  'rollback via delete-then-conditionally-reinsert from import_rows.'
  'previous_travel_snapshot/previous_health_snapshot, mirroring '
  'application_answers'' own pattern -- an inserted-row rollback needs no '
  'new logic since both tables cascade-delete from applications(id) for '
  'free. v_restorable_columns/v_array_columns MUST stay in sync with '
  'apply_import_row_transactional''s own arrays -- update both together.';

-- Narrow EXECUTE grant, mirroring claim_imported_application_transactional's
-- own pattern exactly (20260726110000_claim_application_function.sql): the
-- default on a newly (re)created function is EXECUTE to PUBLIC, which for a
-- SECURITY DEFINER function would expose it to `anon` too. anon has no
-- current_user_role() match (not authenticated, current_user_role() reads
-- profiles by auth.uid() which is null), so the check above would reject it
-- anyway -- but revoking first and granting narrowly means that protection
-- does not rest on a single `if` statement.
revoke all on function rollback_import_batch_transactional(uuid, uuid) from public;
grant execute on function rollback_import_batch_transactional(uuid, uuid) to authenticated;

-- authenticated alone is not sufficient: rollback_import_batch_transactional
-- is actually invoked via a SERVICE-ROLE client in the real production path
-- (rollback-action.ts's rollbackImportBatchForCaller receives its caller
-- from requireImportStaffCaller, which returns createServiceRoleClient() --
-- confirmed by direct inspection, unlike claim_imported_application_
-- transactional, whose own doc comment states it is deliberately called
-- with the participant's OWN session, never service-role). `revoke all`
-- above strips service_role's default EXECUTE too, so it needs its own
-- explicit grant here -- discovered live: the authenticated-only grant
-- (mirrored from claim_imported_application_transactional without
-- accounting for this difference) produced "permission denied for
-- function" for the real service-role caller.
grant execute on function rollback_import_batch_transactional(uuid, uuid) to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260820120000_rollback_import_batch_security_definer')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260820130000_add_attendance_confirmation.sql
-- ============================================================
-- 20260820130000_add_attendance_confirmation.sql
--
-- Adds applications.attendance_confirmation: whether an already-accepted
-- participant has confirmed they will actually attend, or declined, or has
-- not responded yet. Deliberately independent of application status
-- (admission decision) and of funding_type — three separate, orthogonal
-- facts, per explicit user decision. Purely operational, used to compute a
-- real headcount for room/catering logistics ahead of the conference.
--
-- Intentionally NOT built: a participant-facing confirmation link, any
-- notification/email trigger, or any link to the 'withdrawn' application
-- status — explicitly deferred to a later phase per user instruction.

create type attendance_confirmation_status as enum (
  'confirmed',
  'not_confirmed',
  'declined'
);

-- default 'not_confirmed' (not null-by-default): every freshly imported
-- accepted participant starts unconfirmed until staff record a real
-- response, per explicit user decision -- distinct from funding_type, which
-- has no default and stays null until set.
alter table applications add column attendance_confirmation attendance_confirmation_status not null default 'not_confirmed';

------------------------------------------------------------------
-- RLS: read/write stays exactly as funding_type's existing policies
-- already grant (applications_select_staff / applications_update_staff,
-- unchanged by this migration -- they already cover the whole applications
-- row, not per-column, so program_attendance_manager/travel_operations_staff/
-- registration_admission_manager/participants_communications_manager/
-- super_admin already have read+write access to this new column with zero
-- policy change needed here).
--
-- participant_care_staff gets its own ADDITIONAL, READ-ONLY policy --
-- deliberately NOT folded into applications_select_staff (which would also
-- imply broader access to every other applications column this role has no
-- business reading) and NOT given any write policy at all (staff.write
-- limited to program_attendance_manager/travel_operations_staff/super_admin
-- per explicit user decision -- participant_care_staff needs to know who is
-- coming to prepare reception/special-needs support, but does not own the
-- attendance decision).
------------------------------------------------------------------
create policy applications_select_participant_care_staff on applications
  for select
  using (current_user_role() in ('participant_care_staff', 'super_admin'));


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260820130000_add_attendance_confirmation')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260820140000_add_attendance_confirmation_to_import.sql
-- ============================================================
-- 20260820140000_add_attendance_confirmation_to_import.sql
--
-- Extends apply_import_row_transactional and rollback_import_batch_
-- transactional to write/restore applications.attendance_confirmation.
-- Same shape as funding_type's own addition (20260820110000): a plain
-- text-like enum column, added to v_text_columns (apply function) and
-- v_restorable_columns (rollback function) -- no other code path changes.
--
-- IMPORTANT: rollback_import_batch_transactional must ALSO carry forward
-- the SECURITY DEFINER fix from 20260820120000_rollback_import_batch_
-- security_definer.sql (security definer + the current_user_role()
-- authorization check), since `create or replace function` fully replaces
-- the previous body -- omitting it here would silently revert rollback to
-- SECURITY INVOKER and reintroduce the "permission denied for table
-- applications" defect fixed earlier today. apply_import_row_transactional
-- is unaffected (never needed SECURITY DEFINER -- it has no DELETE).
--
-- `create or replace function` because every prior revision is already
-- applied live and immutable -- the established pattern for both
-- functions. Body is otherwise byte-for-byte identical to
-- 20260820120000_rollback_import_batch_security_definer.sql (rollback) and
-- 20260820110000_add_funding_type_to_import.sql (apply), except for the
-- one array literal addition noted above.

create or replace function apply_import_row_transactional(
  p_import_row_id uuid,
  p_import_batch_id uuid,
  p_actor_id uuid
) returns text as $$
declare
  v_batch_status text;
  v_row import_rows;
  v_normalized jsonb;
  v_email text;
  v_application_id uuid;
  v_previous_application jsonb;
  v_previous_answers jsonb;
  v_previous_travel jsonb;
  v_previous_health jsonb;
  v_raw_values jsonb;
  v_key text;
  v_value jsonb;
  v_is_array boolean;
  v_application_number text;
  v_existing_fingerprint text;
  v_text_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs',
    'gender', 'whatsapp_number', 'education_level', 'institution_or_workplace',
    'linkedin_url', 'primary_track', 'secondary_track',
    'funding_type',
    -- attendance_confirmation: whether an accepted participant has
    -- confirmed/declined/not responded. Same plain text-like write path as
    -- funding_type immediately above.
    'attendance_confirmation'
  ];
  v_array_columns text[] := array[
    'interests', 'track_interests',
    'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas'
  ];
  v_travel_columns text[] := array[
    'support_level_requested', 'can_attend_without_full_support', 'departure_airport',
    'visa_required', 'invitation_letter_required', 'passport_full_name',
    'passport_full_name_ar', 'passport_place_of_issue', 'passport_copy_url', 'passport_photo_url'
  ];
  v_travel_date_columns text[] := array['passport_issue_date', 'passport_expiry_date', 'passport_birth_date'];
  v_health_columns text[] := array[
    'allergies', 'medical_conditions', 'emergency_medication', 'accessibility_requirements',
    'dietary_requirements', 'accommodation_preference', 'cultural_or_religious_requirements',
    'emergency_contact_name', 'emergency_contact_relationship', 'emergency_contact_phone'
  ];
  v_health_bool_columns text[] := array['consent_given'];
  v_full_name text;
  v_update_sql text;
  v_set_clauses text[] := array[]::text[];
  v_section text;
begin
  select status into v_batch_status from import_batches where id = p_import_batch_id;
  if v_batch_status = 'rolled_back' then
    raise exception 'Import batch % has been rolled back; cannot apply row %', p_import_batch_id, p_import_row_id;
  end if;

  select * into v_row from import_rows
  where id = p_import_row_id and import_batch_id = p_import_batch_id
  for update;

  if v_row.id is null then
    raise exception 'Import row % not found in batch %', p_import_row_id, p_import_batch_id;
  end if;

  if v_row.action_taken is not null then
    return 'already_applied';
  end if;

  if v_row.validation_status = 'invalid' then
    update import_rows set action_taken = 'skipped_error' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'blocked_downstream' then
    update import_rows set action_taken = 'blocked' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'duplicate_in_file' then
    update import_rows set action_taken = 'skipped_unchanged' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'existing_claimed' and not v_row.claimed_update_approved then
    update import_rows set action_taken = 'blocked' where id = v_row.id;
    return 'skipped';
  end if;

  v_normalized := coalesce(v_row.normalized_row, '{}'::jsonb);
  v_email := v_normalized->>'email';
  if v_email is null or v_email = '' then
    raise exception 'Import row % has no normalized email but passed validation', v_row.id;
  end if;

  select coalesce(jsonb_object_agg(m.target_key, to_jsonb(v_row.raw_row->>m.source_column_index)), '{}'::jsonb)
  into v_raw_values
  from import_column_mappings m
  where m.import_batch_id = p_import_batch_id
    and m.target_key is not null
    and m.target_kind <> 'ignored';

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    v_application_id := v_row.destination_application_id;
    if v_application_id is null then
      raise exception 'Import row % is marked % but has no destination_application_id', v_row.id, v_row.duplicate_status;
    end if;

    perform 1 from applications where id = v_application_id for update;

    select last_import_row_fingerprint into v_existing_fingerprint
    from applications where id = v_application_id;

    if v_existing_fingerprint = v_row.row_fingerprint then
      update import_rows set
        action_taken = 'skipped_unchanged',
        destination_application_id = v_application_id
      where id = v_row.id;

      insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
      values (
        'application',
        v_application_id,
        'import_skip_unchanged',
        'admin',
        p_actor_id,
        jsonb_build_object(
          'batchId', p_import_batch_id,
          'importRowId', v_row.id,
          'excelRowNumber', v_row.excel_row_number,
          'rowFingerprint', v_row.row_fingerprint
        )
      );

      return 'skipped';
    end if;

    select to_jsonb(a.*) into v_previous_application from applications a where a.id = v_application_id;
    if v_previous_application is null then
      raise exception 'Destination application % for import row % no longer exists', v_application_id, v_row.id;
    end if;

    select coalesce(jsonb_agg(to_jsonb(aa.*)), '[]'::jsonb) into v_previous_answers
    from application_answers aa where aa.application_id = v_application_id;

    select to_jsonb(t.*) into v_previous_travel from application_travel_info t where t.application_id = v_application_id;
    select to_jsonb(h.*) into v_previous_health from application_health_info h where h.application_id = v_application_id;

    update import_rows set
      action_taken = 'updated',
      previous_application_snapshot = v_previous_application,
      previous_answers_snapshot = v_previous_answers,
      previous_travel_snapshot = v_previous_travel,
      previous_health_snapshot = v_previous_health,
      destination_application_id = v_application_id
    where id = v_row.id;
  else
    v_application_number := next_application_number();

    insert into applications (applicant_id, imported_email, import_batch_id, status, application_number)
    values (null, v_email, p_import_batch_id, 'accepted', v_application_number)
    returning id into v_application_id;

    update import_rows set
      action_taken = 'inserted',
      destination_application_id = v_application_id
    where id = v_row.id;
  end if;

  foreach v_key in array v_text_columns loop
    if v_normalized ? v_key then
      v_value := v_normalized->v_key;
      v_is_array := jsonb_typeof(v_value) = 'array';
      v_set_clauses := v_set_clauses || format(
        '%I = %L',
        v_key,
        case
          when v_value is null or jsonb_typeof(v_value) = 'null' then null
          when v_is_array then (select string_agg(e, ', ') from jsonb_array_elements_text(v_value) as e)
          else v_value #>> '{}'
        end
      );
    end if;
  end loop;

  foreach v_key in array v_array_columns loop
    if v_normalized ? v_key then
      v_value := v_normalized->v_key;
      v_set_clauses := v_set_clauses || format(
        '%I = %L::text[]',
        v_key,
        case
          when v_value is null or jsonb_typeof(v_value) = 'null' then null
          when jsonb_typeof(v_value) = 'array' then (
            select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_value) as e
          )
          else array[v_value #>> '{}']
        end
      );
    end if;
  end loop;

  if v_normalized ? 'full_name' then
    v_full_name := nullif(trim(both from (v_normalized->>'full_name')), '');
    if v_full_name is not null then
      v_set_clauses := v_set_clauses || format('full_name = %L', v_full_name);
    end if;
  end if;

  if v_normalized ? 'birth_date' then
    declare
      v_birth_raw text := v_normalized->>'birth_date';
      v_birth_date date;
    begin
      if v_birth_raw is not null and v_birth_raw <> '' then
        begin
          v_birth_date := v_birth_raw::date;
          v_set_clauses := v_set_clauses || format('birth_date = %L::date', v_birth_date);
        exception when others then
          null;
        end;
      end if;
    end;
  end if;

  v_set_clauses := v_set_clauses || format('last_import_row_fingerprint = %L', v_row.row_fingerprint);

  if array_length(v_set_clauses, 1) > 0 then
    v_update_sql := format(
      'update applications set %s where id = %L',
      array_to_string(v_set_clauses, ', '),
      v_application_id
    );
    execute v_update_sql;
  end if;

  declare
    v_has_travel_data boolean := false;
    v_passport_issue_date date;
    v_passport_expiry_date date;
    v_passport_birth_date date;
  begin
    foreach v_key in array v_travel_columns || v_travel_date_columns loop
      if v_normalized ? v_key and v_normalized->>v_key is not null and v_normalized->>v_key <> '' then
        v_has_travel_data := true;
      end if;
    end loop;

    if v_has_travel_data then
      begin v_passport_issue_date := nullif(v_normalized->>'passport_issue_date', '')::date; exception when others then v_passport_issue_date := null; end;
      begin v_passport_expiry_date := nullif(v_normalized->>'passport_expiry_date', '')::date; exception when others then v_passport_expiry_date := null; end;
      begin v_passport_birth_date := nullif(v_normalized->>'passport_birth_date', '')::date; exception when others then v_passport_birth_date := null; end;

      insert into application_travel_info (
        application_id, support_level_requested, can_attend_without_full_support,
        departure_airport, visa_required, invitation_letter_required,
        passport_full_name, passport_full_name_ar, passport_place_of_issue,
        passport_issue_date, passport_expiry_date, passport_birth_date,
        passport_copy_url, passport_photo_url
      ) values (
        v_application_id,
        nullif(v_normalized->>'support_level_requested', ''),
        nullif(v_normalized->>'can_attend_without_full_support', '')::boolean,
        nullif(v_normalized->>'departure_airport', ''),
        nullif(v_normalized->>'visa_required', '')::boolean,
        nullif(v_normalized->>'invitation_letter_required', '')::boolean,
        nullif(v_normalized->>'passport_full_name', ''),
        nullif(v_normalized->>'passport_full_name_ar', ''),
        nullif(v_normalized->>'passport_place_of_issue', ''),
        v_passport_issue_date,
        v_passport_expiry_date,
        v_passport_birth_date,
        nullif(v_normalized->>'passport_copy_url', ''),
        nullif(v_normalized->>'passport_photo_url', '')
      )
      on conflict (application_id) do update set
        support_level_requested = coalesce(excluded.support_level_requested, application_travel_info.support_level_requested),
        can_attend_without_full_support = coalesce(excluded.can_attend_without_full_support, application_travel_info.can_attend_without_full_support),
        departure_airport = coalesce(excluded.departure_airport, application_travel_info.departure_airport),
        visa_required = coalesce(excluded.visa_required, application_travel_info.visa_required),
        invitation_letter_required = coalesce(excluded.invitation_letter_required, application_travel_info.invitation_letter_required),
        passport_full_name = coalesce(excluded.passport_full_name, application_travel_info.passport_full_name),
        passport_full_name_ar = coalesce(excluded.passport_full_name_ar, application_travel_info.passport_full_name_ar),
        passport_place_of_issue = coalesce(excluded.passport_place_of_issue, application_travel_info.passport_place_of_issue),
        passport_issue_date = coalesce(excluded.passport_issue_date, application_travel_info.passport_issue_date),
        passport_expiry_date = coalesce(excluded.passport_expiry_date, application_travel_info.passport_expiry_date),
        passport_birth_date = coalesce(excluded.passport_birth_date, application_travel_info.passport_birth_date),
        passport_copy_url = coalesce(excluded.passport_copy_url, application_travel_info.passport_copy_url),
        passport_photo_url = coalesce(excluded.passport_photo_url, application_travel_info.passport_photo_url),
        updated_at = now();
    end if;
  end;

  declare
    v_has_health_data boolean := false;
    v_consent_given boolean;
  begin
    foreach v_key in array v_health_columns || v_health_bool_columns loop
      if v_normalized ? v_key and v_normalized->>v_key is not null and v_normalized->>v_key <> '' then
        v_has_health_data := true;
      end if;
    end loop;

    if v_has_health_data then
      begin v_consent_given := nullif(v_normalized->>'consent_given', '')::boolean; exception when others then v_consent_given := null; end;

      insert into application_health_info (
        application_id, allergies, medical_conditions, emergency_medication,
        accessibility_requirements, dietary_requirements, accommodation_preference,
        cultural_or_religious_requirements, emergency_contact_name,
        emergency_contact_relationship, emergency_contact_phone, consent_given
      ) values (
        v_application_id,
        nullif(v_normalized->>'allergies', ''),
        nullif(v_normalized->>'medical_conditions', ''),
        nullif(v_normalized->>'emergency_medication', ''),
        nullif(v_normalized->>'accessibility_requirements', ''),
        nullif(v_normalized->>'dietary_requirements', ''),
        nullif(v_normalized->>'accommodation_preference', ''),
        nullif(v_normalized->>'cultural_or_religious_requirements', ''),
        nullif(v_normalized->>'emergency_contact_name', ''),
        nullif(v_normalized->>'emergency_contact_relationship', ''),
        nullif(v_normalized->>'emergency_contact_phone', ''),
        v_consent_given
      )
      on conflict (application_id) do update set
        allergies = coalesce(excluded.allergies, application_health_info.allergies),
        medical_conditions = coalesce(excluded.medical_conditions, application_health_info.medical_conditions),
        emergency_medication = coalesce(excluded.emergency_medication, application_health_info.emergency_medication),
        accessibility_requirements = coalesce(excluded.accessibility_requirements, application_health_info.accessibility_requirements),
        dietary_requirements = coalesce(excluded.dietary_requirements, application_health_info.dietary_requirements),
        accommodation_preference = coalesce(excluded.accommodation_preference, application_health_info.accommodation_preference),
        cultural_or_religious_requirements = coalesce(excluded.cultural_or_religious_requirements, application_health_info.cultural_or_religious_requirements),
        emergency_contact_name = coalesce(excluded.emergency_contact_name, application_health_info.emergency_contact_name),
        emergency_contact_relationship = coalesce(excluded.emergency_contact_relationship, application_health_info.emergency_contact_relationship),
        emergency_contact_phone = coalesce(excluded.emergency_contact_phone, application_health_info.emergency_contact_phone),
        consent_given = coalesce(excluded.consent_given, application_health_info.consent_given),
        updated_at = now();
    end if;
  end;

  for v_key, v_value in select * from jsonb_each(v_normalized) loop
    v_section := case
      when v_key = any(v_travel_columns) or v_key = any(v_travel_date_columns) then 'travel'
      when v_key = any(v_health_columns) or v_key = any(v_health_bool_columns) then 'health'
      when v_key in (
        'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas',
        'language_ability', 'organization', 'organization_role', 'experience_level', 'interests',
        'topics_to_learn', 'volunteer_experience_years', 'previous_conference_participation',
        'initiative_or_organization_name', 'expected_contribution', 'expected_skills_experiences'
      ) then 'allocation'
      when v_key in (
        'gender', 'whatsapp_number', 'education_level', 'institution_or_workplace', 'linkedin_url',
        'primary_track', 'secondary_track', 'full_name', 'nationality', 'city', 'country', 'age_group', 'preferred_language',
        'funding_type', 'attendance_confirmation'
      ) then 'profile'
      else 'application'
    end;

    insert into application_answers (
      application_id, question_key, normalized_value, raw_value, value_type,
      source, is_sensitive, import_batch_id, section
    ) values (
      v_application_id,
      v_key,
      case
        when jsonb_typeof(v_value) = 'string' then v_value #>> '{}'
        else v_value::text
      end,
      coalesce(
        v_raw_values->>v_key,
        case
          when jsonb_typeof(v_value) = 'string' then v_value #>> '{}'
          else v_value::text
        end
      ),
      case when jsonb_typeof(v_value) = 'array' then 'multiselect' else 'text' end,
      'import',
      v_key in (
        'accessibility_requirements', 'dietary_requirements',
        'emergency_contact_name', 'emergency_contact_relationship', 'emergency_contact_phone',
        'special_needs', 'allergies', 'medical_conditions', 'emergency_medication',
        'accommodation_preference', 'cultural_or_religious_requirements', 'consent_given'
      ),
      p_import_batch_id,
      v_section
    )
    on conflict (application_id, question_key, source) do update set
      normalized_value = excluded.normalized_value,
      raw_value = excluded.raw_value,
      value_type = excluded.value_type,
      is_sensitive = excluded.is_sensitive,
      import_batch_id = excluded.import_batch_id,
      section = excluded.section;
  end loop;

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    insert into application_status_history (application_id, old_status, new_status, changed_by, note)
    values (
      v_application_id,
      (v_previous_application->>'status')::application_status,
      'accepted',
      p_actor_id,
      format('Updated by import batch %s', p_import_batch_id)
    );
  else
    insert into application_status_history (application_id, old_status, new_status, changed_by, note)
    values (v_application_id, null, 'accepted', p_actor_id, format('Created by import batch %s', p_import_batch_id));
  end if;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'application',
    v_application_id,
    case when v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then 'import_update' else 'import_insert' end,
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_import_batch_id, 'importRowId', v_row.id)
  );

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    return 'updated';
  end if;
  return 'inserted';
end;
$$ language plpgsql set search_path = public, pg_temp;

comment on function apply_import_row_transactional(uuid, uuid, uuid) is
  'Per-row transactional import apply. Adds attendance_confirmation and '
  'funding_type (both plain text-like columns written via v_text_columns) '
  'on top of the Phase B feature set: applications.full_name (never '
  'overwrites an existing non-blank value with a blank import), 4 '
  'structured allocation array columns (session_languages, track_1/2/'
  '3_focus_areas), and conditional upserts into application_travel_info/'
  'application_health_info (only when at least one mapped field for that '
  'section is non-blank). v_travel_columns/v_health_columns MUST stay in '
  'sync with src/lib/import/known-application-columns.ts (the TS-side '
  'manifest confirmMapping validates against) and with rollback_import_'
  'batch_transactional''s own restore arrays -- update all three together. '
  'The is_sensitive key list is sourced from SENSITIVE_QUESTION_KEYS in '
  'src/lib/validation/import.ts -- keep both in sync.';

------------------------------------------------------------------
-- rollback_import_batch_transactional -- extended per the two functions'
-- documented "must stay in sync" invariant (adds attendance_confirmation
-- to v_restorable_columns), AND carries forward the SECURITY DEFINER +
-- authorization-check fix from 20260820120000 (see this file's header
-- comment for why that's required here, not optional).
------------------------------------------------------------------
create or replace function rollback_import_batch_transactional(
  p_batch_id uuid,
  p_actor_id uuid
) returns void as $$
declare
  v_batch import_batches;
  v_blocker_count int;
  v_blocker_detail text;
  v_scope_application_ids uuid[];
  v_row record;
  v_snapshot jsonb;
  v_answers jsonb;
  v_application_id uuid;
  v_old_status application_status;
  v_update_sql text;
  v_set_clauses text[];
  v_key text;
  v_restorable_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs',
    'birth_date',
    'full_name', 'gender', 'whatsapp_number', 'education_level',
    'institution_or_workplace', 'linkedin_url', 'primary_track', 'secondary_track',
    'funding_type',
    'attendance_confirmation'
  ];
  v_array_columns text[] := array[
    'interests', 'track_interests',
    'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas'
  ];
begin
  ------------------------------------------------------------------
  -- SECURITY DEFINER means RLS provides ZERO protection inside this body,
  -- so this check IS the entire authorization boundary for this function
  -- (carried forward unchanged from 20260820120000 -- must never be
  -- dropped by a future create-or-replace of this function).
  ------------------------------------------------------------------
  if current_user_role() not in ('agenda_allocation_manager', 'participants_communications_manager', 'super_admin') then
    raise exception 'Not authorized to roll back an import batch';
  end if;

  select * into v_batch from import_batches where id = p_batch_id for update;

  if v_batch.id is null then
    raise exception 'Import batch % not found', p_batch_id;
  end if;

  if v_batch.status = 'rolled_back' then
    raise exception 'Import batch % has already been rolled back', p_batch_id;
  end if;

  select coalesce(array_agg(distinct id), array[]::uuid[])
  into v_scope_application_ids
  from (
    select a.id
    from applications a
    where a.import_batch_id = p_batch_id
    union
    select r.destination_application_id as id
    from import_rows r
    where r.import_batch_id = p_batch_id
      and r.destination_application_id is not null
      and r.action_taken in ('inserted', 'updated')
  ) scope;

  select count(*) into v_blocker_count
  from participant_feature_snapshots s
  where s.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_feature_snapshots row(s) reference applications from this batch. Delete the feature extraction run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from cluster_memberships c
  where c.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % cluster_memberships row(s) reference applications from this batch. Delete the clustering run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from allocation_assignments al
  where al.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % allocation_assignments row(s) reference applications from this batch. Delete the allocation run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from schedule_publications sp
  where sp.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publications row(s) reference applications from this batch. Retract the publication first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from schedule_publication_draft_items spdi
  where spdi.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publication_draft_items row(s) reference applications from this batch. Discard the schedule draft first.',
      p_batch_id, v_blocker_count;
  end if;

  perform 1
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
  for update of pi;

  select count(*), string_agg(distinct pi.status, ', ' order by pi.status)
  into v_blocker_count, v_blocker_detail
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
    and pi.status <> 'not_sent';
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_invitations row(s) for applications in this batch are no longer in ''not_sent'' status (found: %). An invitation has already been sent to a real recipient and an auth user may exist for them; revoke the invitation(s) before rolling back.',
      p_batch_id, v_blocker_count, v_blocker_detail;
  end if;

  for v_row in
    select * from import_rows
    where import_batch_id = p_batch_id
      and action_taken in ('inserted', 'updated')
    order by excel_row_number
    for update
  loop
    v_application_id := v_row.destination_application_id;

    if v_row.action_taken = 'inserted' then
      if v_application_id is not null then
        insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
        values (
          'application',
          v_application_id,
          'import_rollback_delete',
          'admin',
          p_actor_id,
          jsonb_build_object(
            'batchId', p_batch_id,
            'importRowId', v_row.id,
            'excelRowNumber', v_row.excel_row_number
          )
        );

        delete from applications where id = v_application_id;
      end if;

    else
      v_snapshot := v_row.previous_application_snapshot;

      if v_application_id is null or v_snapshot is null then
        raise exception 'Cannot roll back import batch %: import row % is marked ''updated'' but has no recoverable snapshot (destination_application_id=%, previous_application_snapshot is null).',
          p_batch_id, v_row.id, v_application_id;
      end if;

      perform 1 from applications where id = v_application_id for update;

      select status into v_old_status from applications where id = v_application_id;

      v_set_clauses := array[]::text[];

      foreach v_key in array v_restorable_columns loop
        v_set_clauses := v_set_clauses || format('%I = %L', v_key, v_snapshot->>v_key);
      end loop;

      foreach v_key in array v_array_columns loop
        v_set_clauses := v_set_clauses || format(
          '%I = %L::text[]',
          v_key,
          case
            when v_snapshot->v_key is null or jsonb_typeof(v_snapshot->v_key) = 'null' then null
            else (select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_snapshot->v_key) as e)
          end
        );
      end loop;

      v_set_clauses := v_set_clauses || format('status = %L::application_status', (v_snapshot->>'status')::application_status);

      v_update_sql := format(
        'update applications set %s where id = %L',
        array_to_string(v_set_clauses, ', '),
        v_application_id
      );
      execute v_update_sql;

      delete from application_answers where application_id = v_application_id;

      v_answers := coalesce(v_row.previous_answers_snapshot, '[]'::jsonb);

      insert into application_answers (
        id, application_id, question_key, question_label, normalized_value,
        raw_value, value_type, source, is_sensitive, import_batch_id,
        section, created_at, updated_at
      )
      select
        (e->>'id')::uuid,
        (e->>'application_id')::uuid,
        e->>'question_key',
        e->>'question_label',
        e->>'normalized_value',
        e->>'raw_value',
        e->>'value_type',
        e->>'source',
        (e->>'is_sensitive')::boolean,
        (e->>'import_batch_id')::uuid,
        coalesce(e->>'section', 'application'),
        (e->>'created_at')::timestamptz,
        (e->>'updated_at')::timestamptz
      from jsonb_array_elements(v_answers) as e;

      delete from application_travel_info where application_id = v_application_id;
      if v_row.previous_travel_snapshot is not null then
        insert into application_travel_info (
          application_id, support_level_requested, can_attend_without_full_support,
          departure_airport, visa_required, invitation_letter_required,
          passport_full_name, passport_full_name_ar, passport_birth_date,
          passport_place_of_issue, passport_issue_date, passport_expiry_date,
          passport_copy_url, passport_photo_url, created_at, updated_at
        )
        select
          v_application_id,
          e->>'support_level_requested',
          (e->>'can_attend_without_full_support')::boolean,
          e->>'departure_airport',
          (e->>'visa_required')::boolean,
          (e->>'invitation_letter_required')::boolean,
          e->>'passport_full_name',
          e->>'passport_full_name_ar',
          (e->>'passport_birth_date')::date,
          e->>'passport_place_of_issue',
          (e->>'passport_issue_date')::date,
          (e->>'passport_expiry_date')::date,
          e->>'passport_copy_url',
          e->>'passport_photo_url',
          (e->>'created_at')::timestamptz,
          (e->>'updated_at')::timestamptz
        from (select v_row.previous_travel_snapshot as e) s;
      end if;

      delete from application_health_info where application_id = v_application_id;
      if v_row.previous_health_snapshot is not null then
        insert into application_health_info (
          application_id, allergies, medical_conditions, emergency_medication,
          accessibility_requirements, dietary_requirements, accommodation_preference,
          cultural_or_religious_requirements, emergency_contact_name,
          emergency_contact_relationship, emergency_contact_phone, consent_given,
          created_at, updated_at
        )
        select
          v_application_id,
          e->>'allergies',
          e->>'medical_conditions',
          e->>'emergency_medication',
          e->>'accessibility_requirements',
          e->>'dietary_requirements',
          e->>'accommodation_preference',
          e->>'cultural_or_religious_requirements',
          e->>'emergency_contact_name',
          e->>'emergency_contact_relationship',
          e->>'emergency_contact_phone',
          (e->>'consent_given')::boolean,
          (e->>'created_at')::timestamptz,
          (e->>'updated_at')::timestamptz
        from (select v_row.previous_health_snapshot as e) s;
      end if;

      insert into application_status_history (application_id, old_status, new_status, changed_by, note)
      values (
        v_application_id,
        v_old_status,
        (v_snapshot->>'status')::application_status,
        p_actor_id,
        format('Restored by rollback of import batch %s', p_batch_id)
      );

      insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, new_values)
      values (
        'application',
        v_application_id,
        'import_rollback_restore',
        'admin',
        p_actor_id,
        jsonb_build_object(
          'batchId', p_batch_id,
          'importRowId', v_row.id,
          'excelRowNumber', v_row.excel_row_number,
          'restoredAnswerCount', jsonb_array_length(v_answers)
        ),
        v_snapshot
      );
    end if;

    update import_rows set
      action_taken = null,
      previous_application_snapshot = null,
      previous_answers_snapshot = null,
      previous_travel_snapshot = null,
      previous_health_snapshot = null
    where id = v_row.id;
  end loop;

  update import_batches set
    status = 'rolled_back',
    inserted_count = 0,
    updated_count = 0,
    processing_lock_token = null,
    processing_lock_expires_at = null,
    next_chunk_offset = 0
  where id = p_batch_id;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'import_batch',
    p_batch_id,
    'import_rollback',
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_batch_id)
  );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

comment on function rollback_import_batch_transactional(uuid, uuid) is
  'Undoes an entire import batch atomically, or refuses entirely. SECURITY '
  'DEFINER (since 20260820120000) -- the current_user_role() check at the '
  'top of this function is the ENTIRE authorization boundary and must '
  'never be removed or loosened without an equivalent replacement. Adds '
  'attendance_confirmation to v_restorable_columns on top of funding_type '
  'and the earlier Phase B feature set (restoring application_travel_info/'
  'application_health_info on an updated-row rollback via delete-then-'
  'conditionally-reinsert from import_rows.previous_travel_snapshot/'
  'previous_health_snapshot). v_restorable_columns/v_array_columns MUST '
  'stay in sync with apply_import_row_transactional''s own arrays -- '
  'update both together.';

revoke all on function rollback_import_batch_transactional(uuid, uuid) from public;
grant execute on function rollback_import_batch_transactional(uuid, uuid) to authenticated;
grant execute on function rollback_import_batch_transactional(uuid, uuid) to service_role;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260820140000_add_attendance_confirmation_to_import')
ON CONFLICT (version) DO NOTHING;


-- ============================================================
-- Migration: 20260820150000_add_public_sessions_read_policy.sql
-- ============================================================
-- Adds narrow, read-only RLS policies allowing anyone (no login required)
-- to SELECT: sessions rows where is_public = true, plus rooms/tracks/
-- session_types in full (small reference tables with no per-row sensitivity
-- of their own — a room name, track name, or session-type label is not
-- meaningful to restrict once the sessions row referencing it is already
-- public). Purely additive: every existing *_staff_all policy (full access
-- for agenda_allocation_manager/program_attendance_manager/super_admin) is
-- untouched. Enables the public /conference-agenda page to query the real
-- session catalog, and its room/track/type labels, for the first time.
create policy sessions_select_public
  on public.sessions
  for select
  to anon, authenticated
  using (is_public = true);

create policy rooms_select_public
  on public.rooms
  for select
  to anon, authenticated
  using (true);

create policy tracks_select_public
  on public.tracks
  for select
  to anon, authenticated
  using (true);

create policy session_types_select_public
  on public.session_types
  for select
  to anon, authenticated
  using (true);

-- RLS only narrows an already-granted privilege. Confirmed live on all
-- four tables: authenticated already had table-level SELECT (Supabase's
-- default provisioning), but anon had none at all ("permission denied for
-- table sessions" even with the policy above in place) — so only anon
-- needs the grant here; re-granting authenticated would be redundant, not
-- incorrect, but is skipped to keep this migration's diff exactly matched
-- to the actual gap. SELECT only — no INSERT/UPDATE/DELETE for anon on
-- any of the four tables.
grant select on public.sessions to anon;
grant select on public.rooms to anon;
grant select on public.tracks to anon;
grant select on public.session_types to anon;


INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260820150000_add_public_sessions_read_policy')
ON CONFLICT (version) DO NOTHING;

