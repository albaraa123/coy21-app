-- 20261102020000_cleanup_leftover_test_import_batches.sql
--
-- Cleans up 10 leftover live-test-suite import_batches rows (all from
-- tests/import/*-live.test.ts runs against this production project on
-- 2026-10-28: filenames claimed-gate-live-test.xlsx (8 rows),
-- confirm-import-live-test.xlsx (1 row), debug.xlsx (1 row); every row
-- has uploaded_by = null, confirming none are a real staff-initiated
-- import). Same class of incident as the full fixture cleanup done
-- earlier this session (20261101000000_full_test_fixture_cleanup.sql) --
-- this batch was missed because it left behind only import_batches rows,
-- no sessions/applications/auth.users rows, so it wasn't caught by that
-- pass's scope. Found live: these rows were showing in the admin
-- Participants > Imports "Recent imports" list, which should be empty
-- for a project with no real imports run yet.
--
-- Pre-verified zero dependents before writing this migration (both
-- import_rows and import_column_mappings are globally empty right now,
-- not just for these batch ids) -- a plain delete is safe, no FK-order
-- juggling needed.
begin;

do $$
declare
  v_batch_count int;
  v_non_test_count int;
begin
  select count(*) into v_batch_count from import_batches;
  if v_batch_count <> 10 then
    raise exception 'Expected exactly 10 import_batches rows, found % -- data has changed since this migration was written, aborting rather than guessing.', v_batch_count;
  end if;

  select count(*) into v_non_test_count
  from import_batches
  where uploaded_by is not null
     or original_filename not in ('claimed-gate-live-test.xlsx', 'confirm-import-live-test.xlsx', 'debug.xlsx');
  if v_non_test_count > 0 then
    raise exception 'Found % import_batches row(s) that do not match the known test-fixture pattern -- aborting rather than deleting something real.', v_non_test_count;
  end if;
end $$;

delete from import_batches;

commit;
