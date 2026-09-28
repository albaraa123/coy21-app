-- import_rows_fk_and_index_fixes.sql
--
-- Fixes two real issues found in code-quality review of
-- 20260726102000_import_staging_tables.sql, before any later task builds on
-- top of the gap:
--
-- 1. import_rows.destination_application_id had no `on delete` clause
--    (default NO ACTION/restrict). Task 16's rollback hard-deletes the
--    `applications` row for every batch-inserted row, but every
--    successfully-imported row's import_rows entry still points at that
--    application via destination_application_id — the delete would be
--    rejected by this FK the moment rollback tried it. `on delete set null`
--    (matching the schedule_publication_items.session_id precedent) lets the
--    staging row survive as an audit trail after rollback, with its
--    destination reference cleared rather than blocking the delete.
-- 2. import_rows.duplicate_of_row_id and import_batches.status had no
--    supporting index despite being explicit query-pattern targets later in
--    the plan (dedup reverse-lookup in the preview UI, status-filtered
--    admin history list).
alter table import_rows drop constraint import_rows_destination_application_id_fkey;
alter table import_rows add constraint import_rows_destination_application_id_fkey
  foreign key (destination_application_id) references applications(id) on delete set null;

create index import_rows_duplicate_of_row_idx on import_rows (duplicate_of_row_id);
create index import_batches_status_idx on import_batches (status);
