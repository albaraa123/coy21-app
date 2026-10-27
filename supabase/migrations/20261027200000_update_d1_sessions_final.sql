-- supabase/migrations/20261027200000_update_d1_sessions_final.sql
--
-- Reconciles D1 (2026-11-05) sessions with the user's final 32-row
-- agenda. Compared the full current D1 state (29 rows, from
-- 20261027170000_seed_d1_session_types_and_sessions.sql) against the
-- new list before writing this migration: D1-01..D1-23 and D1-25..D1-29
-- are byte-for-byte identical to the new list (time, room, track,
-- titles, description) and are therefore left untouched. Only D1-24
-- changes (title/description updated), and D1-30/D1-31/D1-32 are new.
-- No D1 session in the current table is absent from the new list, so
-- there is nothing to flag/ask about per the user's "show me and wait"
-- instruction for that case.
--
-- status is never touched for existing rows (session_code already
-- exists -> update only the content columns below, not status). New
-- rows get the table default ('draft'), matching the user's instruction.
--
-- Room-overlap safety: confirmed live, before writing this migration,
-- that none of the 3 new rows' room+time combinations
-- (R10 14:00-15:30, R08 16:00-16:45, R09 14:00-15:30) overlap any
-- existing session in those rooms -- so sessions_room_no_overlap will
-- not reject this migration.
--
-- Idempotent + single transaction: wrapped in begin/commit. The update
-- is a plain re-assignment keyed on session_code (safe to re-run, same
-- values every time). The insert uses `where not exists` keyed on
-- session_code, same pattern as the original seed migration.
begin;

-- D1-24: title/description changed ("Coffee Break" -> "Coffee Break +
-- Open Cultural Stage"). Time/room/track/type/capacity/language/
-- difficulty_level are unchanged from the current row, but restated
-- here anyway so this statement is a complete, self-contained
-- reconciliation against the new list (not a diff against assumptions
-- about what's already correct).
update sessions set
  start_time = '2026-11-05 15:45:00+03'::timestamptz,
  end_time = '2026-11-05 16:00:00+03'::timestamptz,
  room_id = (select id from rooms where code = 'FOY'),
  track_id = (select id from tracks where code = 'BRK'),
  session_type_id = (select id from session_types where code = 'BRK'),
  title_en = 'Coffee Break + Open Cultural Stage',
  title_ar = 'استراحة قهوة ومسرح ثقافي مفتوح',
  description_en = null,
  description_ar = null,
  capacity = (select capacity from rooms where code = 'FOY'),
  language = 'en',
  difficulty_level = 'all_levels'
where session_code = 'D1-24';

-- D1-30, D1-31, D1-32: new rows, same column mapping/defaults as
-- 20261027170000_seed_d1_session_types_and_sessions.sql (session_type_id
-- resolved from the same code as track_id; capacity from the linked
-- room; language='en', difficulty_level='all_levels'; description_en/
-- description_ar populated for SDE only, per the user's explicit
-- choice; status left at its table default, 'draft').
insert into sessions (
  session_code, title_en, title_ar, conference_day_id, start_time, end_time,
  track_id, session_type_id, room_id, language, difficulty_level, capacity,
  description_en, description_ar
)
select
  v.session_code, v.title_en, v.title_ar,
  (select id from conference_days where conference_date = '2026-11-05'),
  v.start_time, v.end_time,
  (select id from tracks where code = v.track_code),
  (select id from session_types where code = v.track_code),
  (select id from rooms where code = v.room_code),
  'en', 'all_levels',
  (select capacity from rooms where code = v.room_code),
  case when v.track_code = 'SDE' then 'Hosted by: ' || v.organisation else null end,
  case when v.track_code = 'SDE' then 'تنظيم: ' || v.organisation else null end
from (values
  ('D1-30', '2026-11-05 14:00:00+03'::timestamptz, '2026-11-05 15:30:00+03'::timestamptz, 'R10', 'SDE', 'From Seed to Cycle: Ecological Production and Sustainability Workshop', 'من البذرة إلى الدورة: ورشة الإنتاج البيئي والاستدامة', 'UNDP'),
  ('D1-31', '2026-11-05 16:00:00+03'::timestamptz, '2026-11-05 16:45:00+03'::timestamptz, 'R08', 'SDE', 'Eco-Design Litmus Test: Using Material Research to Audit Corporate Greenwashing in Local Supply Chains', 'اختبار التصميم البيئي: استخدام أبحاث المواد لتدقيق الغسل الأخضر للشركات في سلاسل التوريد المحلية', 'Academics for Circular Economy + The CircLab'),
  ('D1-32', '2026-11-05 14:00:00+03'::timestamptz, '2026-11-05 15:30:00+03'::timestamptz, 'R09', 'SDE', 'One Plant, Many Stories', 'نبتة واحدة وقصص كثيرة', 'Non-Aligned Movement Youth Organization (NAMYO)')
) as v(session_code, start_time, end_time, room_code, track_code, title_en, title_ar, organisation)
where not exists (select 1 from sessions s where s.session_code = v.session_code);

commit;
