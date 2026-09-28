-- drop_redundant_agenda_indexes.sql
--
-- The 5 dropped indexes below were redundant with the unique constraints
-- already present on the same single columns (tracks.code, session_types.code,
-- rooms.code, tags.code, people.linked_profile_id) — Postgres auto-creates a
-- unique b-tree index for any `unique` column, so these explicit indexes
-- provided no additional query-planning benefit while still costing write
-- overhead and storage. Caught in code review of the migration that
-- originally added them (20260722200245_agenda_enums_and_reference_tables.sql).
drop index if exists tracks_code_idx;
drop index if exists session_types_code_idx;
drop index if exists rooms_code_idx;
drop index if exists tags_code_idx;
drop index if exists people_linked_profile_idx;
