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
