-- import_fk_backfill.sql
-- import_batches didn't exist yet when applications/application_answers
-- were created (Task 1) — add the deferred FKs now that it does.
alter table applications add constraint applications_import_batch_fkey
  foreign key (import_batch_id) references import_batches(id);
alter table application_answers add constraint application_answers_import_batch_fkey
  foreign key (import_batch_id) references import_batches(id);

-- import_batches.mapping_template_id references import_mapping_templates,
-- already satisfied within the same migration file in Task 2 Step 1 (both
-- tables created in the same file, template table first) — no backfill
-- needed for that one.
