-- supabase/migrations/20261027160000_add_registration_track.sql
--
-- Adds a 5th track, "Registration", alongside the 4 tracks seeded in
-- 20261027150000_seed_coy21_conference_days_and_tracks.sql. Same column
-- usage: color stores HEX (no separate HEX/RGB columns on this table).
--
-- Idempotent: relies on tracks.code's existing `unique` constraint, so
-- re-running this migration never creates a duplicate or overwrites the
-- existing row. Confirmed before writing this migration that no row with
-- code 'REG' or a name matching "Registration"/"التسجيل" already exists.
insert into tracks (code, name_ar, name_en, color) values
  ('REG', 'التسجيل', 'Registration', '#0E8C82')
on conflict (code) do nothing;
