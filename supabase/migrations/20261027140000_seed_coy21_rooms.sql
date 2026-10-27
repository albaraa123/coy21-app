-- supabase/migrations/20261027140000_seed_coy21_rooms.sql
--
-- Seeds the 14 real COY21 conference rooms (Main Hall, 11 breakout rooms,
-- Foyer, Cafeteria). rooms was fully emptied in an earlier cleanup pass
-- (all prior data was dummy/placeholder) -- this reintroduces the real
-- venue rooms only. code/name_en/capacity come directly from the user's
-- spec; name_ar values were separately confirmed with the user (rooms
-- table has name_ar as a required column with no default, so it cannot
-- be left out). location/floor/is_accessible/is_active/updated_by are
-- intentionally left at their table defaults/null -- not specified by
-- the user, not guessed here.
--
-- Idempotent: `on conflict (code) do nothing` relies on rooms.code's
-- existing `unique` constraint, so re-running this migration (or running
-- it after some of these codes were already inserted by hand) never
-- creates duplicates or overwrites an existing room.
insert into rooms (code, name_ar, name_en, capacity) values
  ('MH',  'القاعة الرئيسية', 'Main Hall', 550),
  ('R01', 'القاعة 1',        'Room 1',    100),
  ('R02', 'القاعة 2',        'Room 2',    100),
  ('R03', 'القاعة 3',        'Room 3',    60),
  ('R04', 'القاعة 4',        'Room 4',    60),
  ('R05', 'القاعة 5',        'Room 5',    60),
  ('R06', 'القاعة 6',        'Room 6',    60),
  ('R07', 'القاعة 7',        'Room 7',    60),
  ('R08', 'القاعة 8',        'Room 8',    60),
  ('R09', 'القاعة 9',        'Room 9',    60),
  ('R10', 'القاعة 10',       'Room 10',   60),
  ('R11', 'القاعة 11',       'Room 11',   60),
  ('FOY', 'البهو',           'Foyer',     1000),
  ('CAF', 'الكافتيريا',      'Cafeteria', 1000)
on conflict (code) do nothing;
