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
