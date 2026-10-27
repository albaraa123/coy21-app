-- supabase/migrations/20261027150000_seed_coy21_conference_days_and_tracks.sql
--
-- Seeds the 3 real COY21 conference days and 4 session tracks.
-- conference_days/tracks were fully emptied in an earlier cleanup pass
-- (all prior data was dummy/placeholder) -- this reintroduces the real
-- schedule structure only.
--
-- conference_days has no `code` column (it has conference_date, unique,
-- as its natural key) -- the user's D1/D2/D3 codes are therefore NOT
-- stored anywhere; label_ar/label_en carry only "Day One"/"اليوم الأول"
-- etc, per the user's explicit choice. display_order (required, no
-- default) is derived from each day's chronological order (1, 2, 3).
--
-- tracks.color is a single text column (no separate HEX/RGB columns) --
-- stores the HEX value (e.g. '#1F3864'), per the user's explicit choice.
--
-- location/floor-equivalent optional columns (conference_days.updated_by,
-- tracks.updated_by) are intentionally left null -- not specified by the
-- user, not guessed here.
--
-- Idempotent: conference_days.conference_date and tracks.code both have
-- pre-existing `unique` constraints, so `on conflict ... do nothing`
-- relies on those and never creates duplicates or overwrites an existing
-- row on re-run.
insert into conference_days (conference_date, label_ar, label_en, display_order) values
  ('2026-11-05', 'اليوم الأول',  'Day One',   1),
  ('2026-11-06', 'اليوم الثاني', 'Day Two',   2),
  ('2026-11-07', 'اليوم الثالث', 'Day Three', 3)
on conflict (conference_date) do nothing;

insert into tracks (code, name_ar, name_en, color) values
  ('PLN', 'الجلسات العامة',     'Plenary',    '#1F3864'),
  ('CUL', 'الثقافة',            'Culture',    '#8E7CC3'),
  ('SDE', 'الفعاليات الجانبية', 'Side Event', '#E69138'),
  ('BRK', 'استراحة',            'Break',      '#8C8C8C')
on conflict (code) do nothing;
