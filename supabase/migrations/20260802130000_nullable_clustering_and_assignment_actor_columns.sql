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
