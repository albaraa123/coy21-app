-- drop_redundant_session_people_index.sql
--
-- session_people_person_idx (person_id) was redundant with the composite
-- index session_people_person_session_idx (person_id, session_id) added in
-- the same migration — by the leftmost-prefix rule, the composite already
-- serves any pure person_id lookup at least as well as the single-column
-- index would. Same class of issue as
-- 20260722201200_drop_redundant_agenda_indexes.sql; caught in code review of
-- 20260723000000_session_people_and_tags.sql.
drop index if exists session_people_person_idx;

-- Document the unique-role business rule directly on the constraint
-- (queryable via \d+ session_people, pg_description, or obj_description()),
-- since a plain SQL comment in the original migration file can't be
-- retroactively attached to an already-created constraint.
comment on constraint session_people_unique_role on session_people is 'Same person may hold multiple distinct roles in one session (e.g. speaker AND moderator), but not the same role twice.';
