-- supabase/migrations/20261027190000_add_off_campus_room.sql
--
-- Adds a 16th room, "Off-campus", alongside the 15 rooms seeded in
-- 20261027140000_seed_coy21_rooms.sql and
-- 20261027180000_add_room_12.sql. Same column usage: code/name_en/
-- name_ar/capacity, everything else left at defaults/null.
--
-- Idempotent: relies on rooms.code's existing `unique` constraint, so
-- re-running this migration never creates a duplicate or overwrites the
-- existing row. Confirmed before writing this migration that no room
-- with code 'OFF' or a name matching "Off-campus"/"خارج الحرم الجامعي"
-- already exists.
insert into rooms (code, name_ar, name_en, capacity) values
  ('OFF', 'خارج الحرم الجامعي', 'Off-campus', 1000)
on conflict (code) do nothing;
