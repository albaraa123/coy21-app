-- phase_b_import_field_extensions.sql
--
-- Phase B of the controlled-account-provisioning design
-- (docs/superpowers/specs/2026-07-30-controlled-account-provisioning-design.md,
-- section 13 — read it before changing anything here). Connects the
-- accepted-participant import pipeline to the fields approved for Phase B:
-- applications.full_name, four structured allocation columns, and the two
-- Phase-A sensitive tables' file-reference columns (renamed per approval).
--
-- All changes are additive/non-destructive. Nothing here alters existing
-- data or drops anything applied by an earlier migration.

------------------------------------------------------------------
-- applications.full_name — first-class column (approval decision #1).
-- Nullable: existing rows (including every row imported before this
-- migration) simply have no value yet until a future import or manual edit
-- populates it. The original imported "full name" answer continues to live
-- in application_answers as the source/audit copy — this migration does not
-- touch that table's existing rows.
------------------------------------------------------------------
alter table applications add column full_name text;

------------------------------------------------------------------
-- Structured allocation columns (approval decision #2). Promoted to
-- first-class columns specifically so feature extraction keeps reading only
-- named applications columns — never open-ended application_answers keys.
-- session_languages/track_N_focus_areas are text[] (normalized multi-select,
-- same shape as the existing interests/track_interests columns).
-- primary_track/secondary_track already exist (added in Phase A,
-- 20260730110000) and are unchanged here.
------------------------------------------------------------------
alter table applications add column session_languages text[];
alter table applications add column track_1_focus_areas text[];
alter table applications add column track_2_focus_areas text[];
alter table applications add column track_3_focus_areas text[];

------------------------------------------------------------------
-- Rename Phase A's storage-path columns to the URL-reference naming approved
-- for Phase B (decision #4): these hold a Google Drive share-link URL
-- verbatim, not a Supabase Storage path — the original names implied a
-- secure internal transfer that Phase B explicitly does not perform (see
-- design doc section 13.8). A rename, not a drop+add: both columns are still
-- empty in production (Phase A shipped with nothing writing to them), so
-- this is safe and loses no data, but a rename is used rather than
-- drop/recreate to preserve the column's identity/comments/any future
-- pg_stat history rather than presenting it as a wholly new column.
------------------------------------------------------------------
alter table application_travel_info rename column passport_copy_storage_path to passport_copy_url;
alter table application_travel_info rename column visa_photo_storage_path to passport_photo_url;

comment on column application_travel_info.passport_copy_url is
  'Google Drive share-link URL exported from the Google Form response, '
  'stored verbatim as plain text. NOT a Supabase Storage path -- no file is '
  'downloaded or re-hosted by this platform. Access to the underlying file '
  'depends entirely on the Google Drive sharing permissions configured by '
  'the form owner, which this platform does not control. Restricted to '
  'travel_operations_staff/super_admin by this table''s existing RLS '
  'policies (application_travel_info_staff_all,
  20260730110000_application_travel_and_health_info_tables.sql) -- never '
  'exposed through applications or application_answers.';

comment on column application_travel_info.passport_photo_url is
  'Same handling as passport_copy_url -- see that column''s comment.';

------------------------------------------------------------------
-- application_answers.section -- lets the mapping/preview UI (Phase B) and
-- any future admin view group original imported answers by category without
-- re-deriving section membership from question_key string matching.
-- Defaulted 'application' for every pre-existing row (safe: nothing
-- previously classified is reclassified as sensitive here, since is_sensitive
-- is untouched) and for any generic_answer column the import pipeline
-- doesn't explicitly tag going forward.
------------------------------------------------------------------
alter table application_answers add column section text not null default 'application'
  check (section in ('profile', 'application', 'allocation', 'travel', 'health'));

------------------------------------------------------------------
-- import_column_mappings.target_kind -- widen to allow the two new kinds
-- introduced for Phase B (travel_field/health_field), so the mapping layer
-- can express "this column must go to the sensitive table" as an explicit,
-- checkable value instead of overloading core_field. Existing rows (all
-- necessarily one of the 4 original values) are unaffected -- this only
-- widens the allowed set, it does not touch any existing row.
------------------------------------------------------------------
alter table import_column_mappings drop constraint import_column_mappings_target_kind_valid;
alter table import_column_mappings add constraint import_column_mappings_target_kind_valid
  check (target_kind in ('core_field', 'known_answer', 'generic_answer', 'ignored', 'travel_field', 'health_field'));
