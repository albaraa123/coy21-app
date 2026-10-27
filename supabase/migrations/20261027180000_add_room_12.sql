-- supabase/migrations/20261027180000_add_room_12.sql
--
-- Adds a 15th room, Room 12, alongside the 14 rooms seeded in
-- 20261027140000_seed_coy21_rooms.sql. Same column usage: code/name_en/
-- name_ar/capacity, everything else left at defaults/null.
--
-- Idempotent: relies on rooms.code's existing `unique` constraint, so
-- re-running this migration never creates a duplicate or overwrites the
-- existing row. Confirmed before writing this migration that no room
-- with code 'R12' or a name matching "Room 12"/"القاعة 12" already
-- exists.
insert into rooms (code, name_ar, name_en, capacity) values
  ('R12', 'القاعة 12', 'Room 12', 60)
on conflict (code) do nothing;
