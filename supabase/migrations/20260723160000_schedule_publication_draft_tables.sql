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
