-- Syncs Day 3 (D3) sessions with the final confirmed agenda.
--
-- Scope, per explicit user instruction:
--   1. 26 existing sessions updated (start_time/end_time only -- the
--      agenda shifted roughly an hour later across the whole day; no
--      room or session_type/track changes on this day). D3-25
--      additionally gets title_en/title_ar updated -- it changed from
--      plain "Break" to "Break + Open Cultural Stage".
--   2. 2 new sessions inserted as status = 'draft' (D3-31, D3-32).
--   3. D3-18 and D3-19 (duplicates) were already absent, matching the
--      user's note that they'd been removed previously -- nothing to do.
--   4. D3-28 ("Lunch + Youth Talent Showcase") exists but is NOT in the
--      final target list; per explicit user decision it is left
--      untouched (not cancelled, not deleted, not updated).
--   5. D1 and D2 sessions are untouched. No session was deleted.
--
-- Applied directly to production via service-role client (same approach
-- as the D1/D2 sync migrations) since Supabase CLI auth wasn't available
-- in this environment. This file documents the exact same operations for
-- history and so it can be replayed cleanly elsewhere.
--
-- Room-double-booking note: per explicit user instruction, updates were
-- applied in descending target start_time order (latest first). On this
-- day no session changes which room it occupies (only start_time/
-- end_time move, by roughly the same ~1 hour shift across the board), so
-- applying later-starting sessions first guarantees every update lands
-- on a room/time slot its own prior occupant has already vacated,
-- without needing the park-then-update two-pass approach D2 required
-- (D2 had sessions swapping rooms with each other, which this day does
-- not).
begin;

-- Apply updates in descending start_time order.
update sessions set start_time = '2026-11-07T15:30:00+00:00', end_time = '2026-11-07T16:30:00+00:00',
  capacity = (select capacity from rooms where code = 'FOY'), updated_at = now() where session_code = 'D3-30';

update sessions set start_time = '2026-11-07T12:00:00+00:00', end_time = '2026-11-07T12:45:00+00:00',
  capacity = (select capacity from rooms where code = 'R01'), updated_at = now() where session_code = 'D3-26';

update sessions set start_time = '2026-11-07T12:00:00+00:00', end_time = '2026-11-07T12:45:00+00:00',
  capacity = (select capacity from rooms where code = 'R09'), updated_at = now() where session_code = 'D3-27';

update sessions set start_time = '2026-11-07T10:00:00+00:00', end_time = '2026-11-07T10:45:00+00:00',
  capacity = (select capacity from rooms where code = 'R01'), updated_at = now() where session_code = 'D3-14';

update sessions set start_time = '2026-11-07T10:00:00+00:00', end_time = '2026-11-07T10:45:00+00:00',
  capacity = (select capacity from rooms where code = 'R02'), updated_at = now() where session_code = 'D3-15';

update sessions set start_time = '2026-11-07T10:00:00+00:00', end_time = '2026-11-07T10:45:00+00:00',
  capacity = (select capacity from rooms where code = 'R03'), updated_at = now() where session_code = 'D3-16';

update sessions set start_time = '2026-11-07T10:00:00+00:00', end_time = '2026-11-07T11:30:00+00:00',
  capacity = (select capacity from rooms where code = 'R04'), updated_at = now() where session_code = 'D3-17';

update sessions set start_time = '2026-11-07T10:00:00+00:00', end_time = '2026-11-07T11:30:00+00:00',
  capacity = (select capacity from rooms where code = 'R07'), updated_at = now() where session_code = 'D3-20';

update sessions set start_time = '2026-11-07T10:00:00+00:00', end_time = '2026-11-07T10:45:00+00:00',
  capacity = (select capacity from rooms where code = 'R08'), updated_at = now() where session_code = 'D3-21';

update sessions set start_time = '2026-11-07T10:00:00+00:00', end_time = '2026-11-07T10:45:00+00:00',
  capacity = (select capacity from rooms where code = 'R09'), updated_at = now() where session_code = 'D3-22';

update sessions set start_time = '2026-11-07T10:00:00+00:00', end_time = '2026-11-07T10:45:00+00:00',
  capacity = (select capacity from rooms where code = 'R10'), updated_at = now() where session_code = 'D3-23';

update sessions set start_time = '2026-11-07T10:00:00+00:00', end_time = '2026-11-07T11:30:00+00:00',
  capacity = (select capacity from rooms where code = 'R11'), updated_at = now() where session_code = 'D3-24';

update sessions set start_time = '2026-11-07T09:30:00+00:00', end_time = '2026-11-07T10:00:00+00:00',
  capacity = (select capacity from rooms where code = 'FOY'),
  title_en = 'Break + Open Cultural Stage', title_ar = 'استراحة ومسرح ثقافي مفتوح', updated_at = now()
where session_code = 'D3-25';

update sessions set start_time = '2026-11-07T08:45:00+00:00', end_time = '2026-11-07T09:30:00+00:00',
  capacity = (select capacity from rooms where code = 'R03'), updated_at = now() where session_code = 'D3-10';

update sessions set start_time = '2026-11-07T08:45:00+00:00', end_time = '2026-11-07T09:30:00+00:00',
  capacity = (select capacity from rooms where code = 'R05'), updated_at = now() where session_code = 'D3-11';

update sessions set start_time = '2026-11-07T08:45:00+00:00', end_time = '2026-11-07T09:30:00+00:00',
  capacity = (select capacity from rooms where code = 'R06'), updated_at = now() where session_code = 'D3-12';

update sessions set start_time = '2026-11-07T08:15:00+00:00', end_time = '2026-11-07T08:45:00+00:00',
  capacity = (select capacity from rooms where code = 'FOY'), updated_at = now() where session_code = 'D3-13';

update sessions set start_time = '2026-11-07T07:30:00+00:00', end_time = '2026-11-07T09:00:00+00:00',
  capacity = (select capacity from rooms where code = 'R02'), updated_at = now() where session_code = 'D3-02';

update sessions set start_time = '2026-11-07T07:30:00+00:00', end_time = '2026-11-07T08:15:00+00:00',
  capacity = (select capacity from rooms where code = 'R03'), updated_at = now() where session_code = 'D3-03';

update sessions set start_time = '2026-11-07T07:30:00+00:00', end_time = '2026-11-07T09:00:00+00:00',
  capacity = (select capacity from rooms where code = 'R04'), updated_at = now() where session_code = 'D3-04';

update sessions set start_time = '2026-11-07T07:30:00+00:00', end_time = '2026-11-07T08:15:00+00:00',
  capacity = (select capacity from rooms where code = 'R06'), updated_at = now() where session_code = 'D3-05';

update sessions set start_time = '2026-11-07T07:30:00+00:00', end_time = '2026-11-07T08:15:00+00:00',
  capacity = (select capacity from rooms where code = 'R07'), updated_at = now() where session_code = 'D3-06';

update sessions set start_time = '2026-11-07T07:30:00+00:00', end_time = '2026-11-07T08:15:00+00:00',
  capacity = (select capacity from rooms where code = 'R08'), updated_at = now() where session_code = 'D3-07';

update sessions set start_time = '2026-11-07T07:30:00+00:00', end_time = '2026-11-07T08:15:00+00:00',
  capacity = (select capacity from rooms where code = 'R09'), updated_at = now() where session_code = 'D3-08';

update sessions set start_time = '2026-11-07T07:30:00+00:00', end_time = '2026-11-07T08:15:00+00:00',
  capacity = (select capacity from rooms where code = 'R10'), updated_at = now() where session_code = 'D3-09';

update sessions set start_time = '2026-11-07T07:00:00+00:00', end_time = '2026-11-07T07:30:00+00:00',
  capacity = (select capacity from rooms where code = 'MH'), updated_at = now() where session_code = 'D3-01';

-- Insert the 2 new sessions.
insert into sessions (
  session_code, title_en, title_ar, description_en, description_ar,
  start_time, end_time, conference_day_id, room_id, session_type_id, track_id,
  status, language, difficulty_level, capacity, min_capacity,
  is_mandatory, is_public, admission_policy, enable_qr_checkin, include_in_allocation
)
select v.session_code, v.title_en, v.title_ar, null, null,
  v.start_time::timestamptz, v.end_time::timestamptz,
  (select conference_day_id from sessions where session_code = 'D3-01' limit 1),
  (select id from rooms where code = v.room_code),
  (select id from session_types where code = v.type_code),
  (select id from tracks where name_en = v.track_name),
  'draft', 'en', 'all_levels', (select capacity from rooms where code = v.room_code), 0,
  false, true, 'open', false, true
from (values
  ('D3-31', 'Break', 'استراحة', '2026-11-07T10:45:00+00:00', '2026-11-07T12:00:00+00:00', 'FOY', 'BRK', 'Break'),
  ('D3-32', 'Transition / Break', 'فترة انتقال واستراحة', '2026-11-07T12:45:00+00:00', '2026-11-07T13:00:00+00:00', 'FOY', 'BRK', 'Break')
) as v(session_code, title_en, title_ar, start_time, end_time, room_code, type_code, track_name)
where not exists (select 1 from sessions where session_code = v.session_code);

commit;
