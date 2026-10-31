-- 20261101000100_cleanup_orphaned_feature_extraction_runs.sql
--
-- Follow-up to 20261101000000_full_test_fixture_cleanup.sql: that
-- migration deleted every feature_extraction_runs row linked to a
-- fixture profile via run_by, but 40 further rows remained with
-- run_by = null (despite the column's `not null` constraint -- these
-- predate or otherwise bypassed it) and no other identifying link to a
-- fixture user. Independently verified immediately before writing this
-- migration:
--   - All 40 dated 2026-10-28 19:40 UTC through 2026-10-30 22:48 UTC --
--     the same incident window as the rest of this cleanup effort, well
--     after the one real application (8ac9f5f2-c832-4e24-96a0-
--     2b351103ba92, created 2026-10-13 09:04 UTC) and unrelated to it.
--   - Zero allocation_runs, zero clustering_runs, and zero
--     participant_feature_snapshots reference any of these 40 rows --
--     fully orphaned, no cascade risk to any other table.
--   - This table has no UI surface in the app (feature extraction is an
--     internal allocation-pipeline step, never displayed to staff or
--     participants) -- deleting stale rows here has no user-visible
--     effect beyond removing clutter from a table nothing currently reads.
--
-- No backup snapshot beyond this migration's own WHERE clause is needed:
-- the row shape (id, rules_version, application_count, run_at, run_by)
-- carries no PII and no reference to any real participant, application,
-- or session -- confirmed by the zero-dependents check above.

begin;

do $$
declare
  v_count int;
  v_dependents int;
begin
  select count(*) into v_count
  from feature_extraction_runs
  where run_by is null;
  if v_count <> 40 then
    raise exception 'Expected 40 orphaned feature_extraction_runs rows (run_by is null), found %', v_count;
  end if;

  select count(*) into v_dependents
  from (
    select feature_extraction_run_id from clustering_runs
    where feature_extraction_run_id in (select id from feature_extraction_runs where run_by is null)
    union all
    select feature_extraction_run_id from participant_feature_snapshots
    where feature_extraction_run_id in (select id from feature_extraction_runs where run_by is null)
    union all
    select feature_extraction_run_id from allocation_runs
    where feature_extraction_run_id in (select id from feature_extraction_runs where run_by is null)
  ) deps;
  if v_dependents > 0 then
    raise exception 'Found % dependent row(s) referencing an orphaned feature_extraction_runs row -- aborting', v_dependents;
  end if;
end $$;

delete from public.feature_extraction_runs
  where run_by is null;

commit;
