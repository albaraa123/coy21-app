-- Syncs Day 2 (D2) sessions with the final confirmed agenda.
--
-- Scope, per explicit user instruction:
--   1. 15 existing sessions updated (start_time, end_time, room, session
--      type, track, capacity for its new room). D2-31 additionally gets
--      title_en/title_ar/description_en/description_ar updated -- it
--      changed from "Thematic Capacity-Building Session: COP31 Aligned"
--      to "Deep Dive: Climate Finance + Just Transition Mechanism (JTM)"
--      and moved into the Main Hall (MH).
--   2. 14 new sessions inserted as status = 'draft'.
--   3. No D2 session outside this target list existed, so nothing was
--      skipped/flagged for review.
--   4. D1 and D3 sessions are untouched. No session was deleted.
--
-- Applied directly to production via service-role client (same approach
-- as the D1 sync migration) since Supabase CLI auth wasn't available in
-- this environment. This file documents the exact same operations for
-- history and so it can be replayed cleanly elsewhere.
--
-- Room-double-booking note: the sessions_double_booking exclusion
-- constraint on (room_id, during) is NOT deferrable, so a straight
-- UPDATE of 15 interleaved sessions in arbitrary order can transiently
-- collide even though the final state has zero conflicts (e.g. two
-- sessions swapping which one occupies a given room/time). The actual
-- application therefore ran in two passes: (1) every session being
-- updated was first parked at a harmless placeholder time slot late on
-- 6 Nov (after all real D2 sessions end), each in its own 1-minute
-- window so parked rows never collide with each other either -- this
-- vacates every room/time the final values will land on; (2) every
-- parked session was then updated to its real final start_time/end_time/
-- room_id/session_type_id/track_id/capacity, which by construction never
-- collides with anything still in its original slot. This file expresses
-- the same two-pass shape in SQL so a replay elsewhere sees the same
-- guarantee; the inserts need no such precaution since they only ever
-- occupy brand-new (room, time) pairs.
begin;

do $$
begin
  if not exists (select 1 from rooms where code = 'MH') then
    raise exception 'Expected room MH not found — refusing to proceed on an unexpected schema/data state';
  end if;
  if not exists (select 1 from rooms where code = 'R12') then
    raise exception 'Expected room R12 not found — refusing to proceed on an unexpected schema/data state';
  end if;
  if not exists (select 1 from rooms where code = 'OFF') then
    raise exception 'Expected room OFF not found — refusing to proceed on an unexpected schema/data state';
  end if;
end $$;

-- Pass 1: park every session being updated at a harmless late-night slot
-- on the same conference day (so the "start/end must match its
-- conference day" check constraint is still satisfied), each in its own
-- 1-minute window.
with to_park(session_code, slot_offset) as (
  values
    ('D2-01', 0), ('D2-02', 1), ('D2-31', 2), ('D2-32', 3), ('D2-03', 4),
    ('D2-04', 5), ('D2-05', 6), ('D2-06', 7), ('D2-07', 8), ('D2-35', 9),
    ('D2-36', 10), ('D2-22', 11), ('D2-08', 12), ('D2-37', 13), ('D2-40', 14)
)
update sessions s
set start_time = '2026-11-06T20:00:00+00:00'::timestamptz + (to_park.slot_offset || ' minutes')::interval,
    end_time   = '2026-11-06T20:01:00+00:00'::timestamptz + (to_park.slot_offset || ' minutes')::interval
from to_park
where s.session_code = to_park.session_code;

-- Pass 2: apply the real final values.
update sessions set start_time = '2026-11-06T05:00:00+00:00', end_time = '2026-11-06T05:30:00+00:00',
  room_id = (select id from rooms where code = 'MH'), session_type_id = (select id from session_types where code = 'PLN'),
  track_id = (select id from tracks where name_en = 'Plenary'), capacity = (select capacity from rooms where code = 'MH'), updated_at = now()
where session_code = 'D2-01';

update sessions set start_time = '2026-11-06T05:30:00+00:00', end_time = '2026-11-06T07:00:00+00:00',
  room_id = (select id from rooms where code = 'MH'), session_type_id = (select id from session_types where code = 'PLN'),
  track_id = (select id from tracks where name_en = 'Plenary'), capacity = (select capacity from rooms where code = 'MH'), updated_at = now()
where session_code = 'D2-02';

update sessions set start_time = '2026-11-06T07:30:00+00:00', end_time = '2026-11-06T08:30:00+00:00',
  room_id = (select id from rooms where code = 'MH'), session_type_id = (select id from session_types where code = 'SDE'),
  track_id = (select id from tracks where name_en = 'Side Event'), capacity = (select capacity from rooms where code = 'MH'),
  title_en = 'Deep Dive: Climate Finance + Just Transition Mechanism (JTM)',
  title_ar = 'تعمّق: التمويل المناخي وآلية الانتقال العادل',
  description_en = 'Hosted by: YOUNGO Working Groups', description_ar = 'تنظيم: YOUNGO Working Groups', updated_at = now()
where session_code = 'D2-31';

update sessions set start_time = '2026-11-06T09:00:00+00:00', end_time = '2026-11-06T09:45:00+00:00',
  room_id = (select id from rooms where code = 'R01'), session_type_id = (select id from session_types where code = 'SDE'),
  track_id = (select id from tracks where name_en = 'Side Event'), capacity = (select capacity from rooms where code = 'R01'), updated_at = now()
where session_code = 'D2-32';

update sessions set start_time = '2026-11-06T09:00:00+00:00', end_time = '2026-11-06T09:45:00+00:00',
  room_id = (select id from rooms where code = 'R02'), session_type_id = (select id from session_types where code = 'SDE'),
  track_id = (select id from tracks where name_en = 'Side Event'), capacity = (select capacity from rooms where code = 'R02'), updated_at = now()
where session_code = 'D2-03';

update sessions set start_time = '2026-11-06T09:00:00+00:00', end_time = '2026-11-06T09:45:00+00:00',
  room_id = (select id from rooms where code = 'R04'), session_type_id = (select id from session_types where code = 'SDE'),
  track_id = (select id from tracks where name_en = 'Side Event'), capacity = (select capacity from rooms where code = 'R04'), updated_at = now()
where session_code = 'D2-04';

update sessions set start_time = '2026-11-06T09:00:00+00:00', end_time = '2026-11-06T09:45:00+00:00',
  room_id = (select id from rooms where code = 'R05'), session_type_id = (select id from session_types where code = 'SDE'),
  track_id = (select id from tracks where name_en = 'Side Event'), capacity = (select capacity from rooms where code = 'R05'), updated_at = now()
where session_code = 'D2-05';

update sessions set start_time = '2026-11-06T09:00:00+00:00', end_time = '2026-11-06T09:45:00+00:00',
  room_id = (select id from rooms where code = 'R07'), session_type_id = (select id from session_types where code = 'SDE'),
  track_id = (select id from tracks where name_en = 'Side Event'), capacity = (select capacity from rooms where code = 'R07'), updated_at = now()
where session_code = 'D2-06';

update sessions set start_time = '2026-11-06T09:00:00+00:00', end_time = '2026-11-06T09:45:00+00:00',
  room_id = (select id from rooms where code = 'R08'), session_type_id = (select id from session_types where code = 'SDE'),
  track_id = (select id from tracks where name_en = 'Side Event'), capacity = (select capacity from rooms where code = 'R08'), updated_at = now()
where session_code = 'D2-07';

update sessions set start_time = '2026-11-06T09:00:00+00:00', end_time = '2026-11-06T09:45:00+00:00',
  room_id = (select id from rooms where code = 'R09'), session_type_id = (select id from session_types where code = 'SDE'),
  track_id = (select id from tracks where name_en = 'Side Event'), capacity = (select capacity from rooms where code = 'R09'), updated_at = now()
where session_code = 'D2-35';

update sessions set start_time = '2026-11-06T09:00:00+00:00', end_time = '2026-11-06T09:45:00+00:00',
  room_id = (select id from rooms where code = 'R10'), session_type_id = (select id from session_types where code = 'SDE'),
  track_id = (select id from tracks where name_en = 'Side Event'), capacity = (select capacity from rooms where code = 'R10'), updated_at = now()
where session_code = 'D2-36';

update sessions set start_time = '2026-11-06T09:00:00+00:00', end_time = '2026-11-06T09:45:00+00:00',
  room_id = (select id from rooms where code = 'R11'), session_type_id = (select id from session_types where code = 'SDE'),
  track_id = (select id from tracks where name_en = 'Side Event'), capacity = (select capacity from rooms where code = 'R11'), updated_at = now()
where session_code = 'D2-22';

update sessions set start_time = '2026-11-06T09:45:00+00:00', end_time = '2026-11-06T11:00:00+00:00',
  room_id = (select id from rooms where code = 'CAF'), session_type_id = (select id from session_types where code = 'BRK'),
  track_id = (select id from tracks where name_en = 'Break'), capacity = (select capacity from rooms where code = 'CAF'), updated_at = now()
where session_code = 'D2-08';

update sessions set start_time = '2026-11-06T13:00:00+00:00', end_time = '2026-11-06T13:45:00+00:00',
  room_id = (select id from rooms where code = 'R06'), session_type_id = (select id from session_types where code = 'SDE'),
  track_id = (select id from tracks where name_en = 'Side Event'), capacity = (select capacity from rooms where code = 'R06'), updated_at = now()
where session_code = 'D2-37';

update sessions set start_time = '2026-11-06T14:00:00+00:00', end_time = '2026-11-06T14:45:00+00:00',
  room_id = (select id from rooms where code = 'R05'), session_type_id = (select id from session_types where code = 'SDE'),
  track_id = (select id from tracks where name_en = 'Side Event'), capacity = (select capacity from rooms where code = 'R05'), updated_at = now()
where session_code = 'D2-40';

-- Insert the 14 new sessions.
insert into sessions (
  session_code, title_en, title_ar, description_en, description_ar,
  start_time, end_time, conference_day_id, room_id, session_type_id, track_id,
  status, language, difficulty_level, capacity, min_capacity,
  is_mandatory, is_public, admission_policy, enable_qr_checkin, include_in_allocation
)
select v.session_code, v.title_en, v.title_ar, v.description_en, v.description_ar,
  v.start_time::timestamptz, v.end_time::timestamptz,
  (select conference_day_id from sessions where session_code = 'D2-01' limit 1),
  (select id from rooms where code = v.room_code),
  (select id from session_types where code = v.type_code),
  (select id from tracks where name_en = v.track_name),
  'draft', 'en', 'all_levels', (select capacity from rooms where code = v.room_code), 0,
  false, true, 'open', false, true
from (values
  ('D2-60', 'Break', 'استراحة', null, null, '2026-11-06T07:00:00+00:00', '2026-11-06T07:30:00+00:00', 'FOY', 'BRK', 'Break'),
  ('D2-48', 'Deep Dive: Action for Climate Empowerment (ACE)', 'تعمّق: العمل من أجل التمكين المناخي (ACE)', 'Hosted by: YOUNGO Working Groups', 'تنظيم: YOUNGO Working Groups', '2026-11-06T07:30:00+00:00', '2026-11-06T08:30:00+00:00', 'R01', 'SDE', 'Side Event'),
  ('D2-49', 'Deep Dive: Adaptation', 'تعمّق: التكيّف', 'Hosted by: YOUNGO Working Groups', 'تنظيم: YOUNGO Working Groups', '2026-11-06T07:30:00+00:00', '2026-11-06T08:30:00+00:00', 'R02', 'SDE', 'Side Event'),
  ('D2-50', 'Deep Dive: Food and Agriculture', 'تعمّق: الغذاء والزراعة', 'Hosted by: YOUNGO Working Groups', 'تنظيم: YOUNGO Working Groups', '2026-11-06T07:30:00+00:00', '2026-11-06T08:30:00+00:00', 'R03', 'SDE', 'Side Event'),
  ('D2-51', 'Deep Dive: Migration', 'تعمّق: الهجرة', 'Hosted by: YOUNGO Working Groups', 'تنظيم: YOUNGO Working Groups', '2026-11-06T07:30:00+00:00', '2026-11-06T08:30:00+00:00', 'R04', 'SDE', 'Side Event'),
  ('D2-52', 'Deep Dive: Cities', 'تعمّق: المدن', 'Hosted by: YOUNGO Working Groups', 'تنظيم: YOUNGO Working Groups', '2026-11-06T07:30:00+00:00', '2026-11-06T08:30:00+00:00', 'R05', 'SDE', 'Side Event'),
  ('D2-53', 'Deep Dive: Human Rights', 'تعمّق: حقوق الإنسان', 'Hosted by: YOUNGO Working Groups', 'تنظيم: YOUNGO Working Groups', '2026-11-06T07:30:00+00:00', '2026-11-06T08:30:00+00:00', 'R06', 'SDE', 'Side Event'),
  ('D2-54', 'Deep Dive: Oceans', 'تعمّق: المحيطات', 'Hosted by: YOUNGO Working Groups', 'تنظيم: YOUNGO Working Groups', '2026-11-06T07:30:00+00:00', '2026-11-06T08:30:00+00:00', 'R07', 'SDE', 'Side Event'),
  ('D2-55', 'Deep Dive: Nationally Determined Contributions (NDCs)', 'تعمّق: المساهمات المحددة وطنياً (NDCs)', 'Hosted by: YOUNGO Working Groups', 'تنظيم: YOUNGO Working Groups', '2026-11-06T07:30:00+00:00', '2026-11-06T08:30:00+00:00', 'R08', 'SDE', 'Side Event'),
  ('D2-56', 'Deep Dive: Mitigation', 'تعمّق: التخفيف', 'Hosted by: YOUNGO Working Groups', 'تنظيم: YOUNGO Working Groups', '2026-11-06T07:30:00+00:00', '2026-11-06T08:30:00+00:00', 'R09', 'SDE', 'Side Event'),
  ('D2-61', 'Break', 'استراحة', null, null, '2026-11-06T08:30:00+00:00', '2026-11-06T09:00:00+00:00', 'FOY', 'BRK', 'Break'),
  ('D2-57', 'From Seed to Cycle: Ecological Production and Sustainability Workshop', 'من البذرة إلى الدورة: ورشة الإنتاج البيئي والاستدامة', 'Hosted by: UNDP', 'تنظيم: UNDP', '2026-11-06T09:00:00+00:00', '2026-11-06T10:30:00+00:00', 'R03', 'SDE', 'Side Event'),
  ('D2-59', 'The White Thread: One Planet, Many Cultures, One Connection', 'الخيط الأبيض: كوكب واحد، ثقافات كثيرة، رابط واحد', 'Hosted by: TED Denizli College', 'تنظيم: TED Denizli College', '2026-11-06T09:00:00+00:00', '2026-11-06T09:45:00+00:00', 'R12', 'SDE', 'Side Event'),
  ('D2-58', 'UNFCCC Reform: Why It Matters Now', 'إصلاح اتفاقية الأمم المتحدة الإطارية بشأن تغير المناخ: لماذا يهم الآن', 'Hosted by: United Beyond Border', 'تنظيم: United Beyond Border', '2026-11-06T13:00:00+00:00', '2026-11-06T13:45:00+00:00', 'R11', 'SDE', 'Side Event')
) as v(session_code, title_en, title_ar, description_en, description_ar, start_time, end_time, room_code, type_code, track_name)
where not exists (select 1 from sessions where session_code = v.session_code);

commit;
