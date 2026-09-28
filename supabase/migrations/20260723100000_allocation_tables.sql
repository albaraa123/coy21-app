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
