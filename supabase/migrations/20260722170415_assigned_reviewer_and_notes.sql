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
