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
