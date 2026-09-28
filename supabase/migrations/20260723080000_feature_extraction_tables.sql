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
