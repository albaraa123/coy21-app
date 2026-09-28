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
