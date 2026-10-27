-- supabase/migrations/20261027170000_seed_d1_session_types_and_sessions.sql
--
-- Adds the 5 session_types needed before any sessions row can be
-- inserted (session_types was completely empty; sessions.session_type_id
-- is a required FK), then seeds COY21's 30-row Day One (D1) agenda --
-- merged to 29 rows: rows #3 (Inauguration: Green Exhibition) and #4
-- (Morning Tea) from the user's original list both target FOY at
-- 2026-11-05 10:30-11:00, which would violate sessions_room_no_overlap
-- (the live GiST exclusion constraint blocking any two draft/published/
-- confirmed sessions in the same room with overlapping time ranges --
-- confirmed directly against 20260722210000_sessions_table.sql, not
-- assumed). Per the user's explicit decision, these two are combined
-- into one session rather than changing status or bypassing the
-- constraint.
--
-- session_types: one row per track code already seeded in
-- 20261027150000_seed_coy21_conference_days_and_tracks.sql /
-- 20261027160000_add_registration_track.sql, same code/name_ar/name_en,
-- per the user's explicit choice ("كل جلسة تاخذ النوع المطابق لكود
-- التراك حقها"). Idempotent via session_types.code's unique constraint.
insert into session_types (code, name_ar, name_en) values
  ('REG', 'التسجيل', 'Registration'),
  ('PLN', 'الجلسات العامة', 'Plenary'),
  ('SDE', 'الفعاليات الجانبية', 'Side Event'),
  ('BRK', 'استراحة', 'Break'),
  ('CUL', 'الثقافة', 'Culture')
on conflict (code) do nothing;

-- sessions: links to conference_days/rooms/tracks/session_types are all
-- uuid FKs (no code column on sessions itself), so each row below
-- resolves the user's codes to ids via a subquery against the tables
-- seeded in prior migrations.
--
-- Column mapping (confirmed against the live sessions schema before
-- writing this migration):
--   session_code     <- synthesized 'D1-01'..'D1-29' (session_code is
--                        NOT NULL UNIQUE with no default; not specified
--                        by the user, so a stable, collision-free value
--                        derived from day+sequence is used rather than
--                        guessed free text)
--   title_en/title_ar <- user's title_en/title_ar
--   conference_day_id <- resolved from conference_days.conference_date
--                        = '2026-11-05' (D1)
--   start_time/end_time <- user's times, construed as Europe/Istanbul
--                        (UTC+03:00) per the user's explicit instruction,
--                        stored as timestamptz (the column's real type)
--   track_id          <- resolved from tracks.code
--   session_type_id   <- resolved from session_types.code, same code as
--                        the session's track (user's explicit choice)
--   room_id           <- resolved from rooms.code
--   language           <- 'en' (user's explicit choice; column is
--                        required, not in the original request)
--   difficulty_level   <- 'all_levels' (user's explicit choice)
--   capacity            <- the linked room's own capacity (user's
--                        explicit choice; column is required, not in
--                        the original request)
--   description_en/description_ar <- for Side Event (SDE) sessions only:
--                        'Hosted by: <organisation>' / 'تنظيم: <organisation>'
--                        (organisation name given in English in both, per
--                        the user's explicit choice). Left null for
--                        REG/PLN/BRK/CUL sessions (organisation COY21 /
--                        COY21 Cultural WG, per the user's explicit
--                        choice). This is the only place "الجهة" is
--                        stored -- there is no organisation/organiser
--                        column on sessions, and the my-agenda/browse
--                        participant page does not currently select
--                        description_en/description_ar at all (confirmed
--                        by reading src/app/[locale]/(participant)/
--                        (shell)/my-agenda/browse/page.tsx before this
--                        migration was written), so this will not be
--                        visible to participants until that query is
--                        updated separately.
--   internal_notes, checkin_*, cancellation_reason,
--   published_at/confirmed_at/cancelled_at, updated_by <- left null (not
--                        specified)
--   min_capacity, is_mandatory, is_public, include_in_allocation,
--   allocation_priority, enable_qr_checkin, status, created_at,
--   updated_at           <- left at their table defaults
--
-- "الجهة" (organisation) from the user's table has no column on
-- sessions at all -- there is no organisation/organiser text column on
-- this table (confirmed against the live schema). It is therefore not
-- stored anywhere by this migration; flagged here rather than silently
-- dropped.
--
-- Idempotent: relies on sessions.session_code's existing unique
-- constraint, so re-running this migration never creates a duplicate or
-- overwrites an existing row.
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
  ('D1-01', '2026-11-05 08:00:00+03'::timestamptz, '2026-11-05 09:00:00+03'::timestamptz, 'MH',  'REG', 'Registration & Arrival', 'التسجيل والوصول', 'COY21'),
  ('D1-02', '2026-11-05 09:00:00+03'::timestamptz, '2026-11-05 10:30:00+03'::timestamptz, 'MH',  'PLN', 'Opening Plenary', 'الجلسة الافتتاحية', 'COY21'),
  ('D1-03', '2026-11-05 10:30:00+03'::timestamptz, '2026-11-05 11:00:00+03'::timestamptz, 'FOY', 'PLN', 'Inauguration: Green Exhibition & Morning Tea', 'افتتاح المعرض الأخضر واستراحة شاي الصباح', 'COY21'),
  ('D1-04', '2026-11-05 11:00:00+03'::timestamptz, '2026-11-05 12:00:00+03'::timestamptz, 'MH',  'PLN', 'Welcome Session', 'الجلسة الترحيبية', 'COY21'),
  ('D1-05', '2026-11-05 12:00:00+03'::timestamptz, '2026-11-05 13:00:00+03'::timestamptz, 'CAF', 'BRK', 'Lunch — Taste of Türkiye', 'الغداء — مذاق تركيا', 'COY21'),
  ('D1-06', '2026-11-05 13:00:00+03'::timestamptz, '2026-11-05 13:45:00+03'::timestamptz, 'R02', 'SDE', 'BOAT: Youth Advancing 30×30 for Coastal Resilience in Africa', 'BOAT: الشباب يدفعون هدف 30×30 من أجل صمود السواحل في أفريقيا', 'BluerAfrica – Africa Blue and Coastal Community Development Initiative'),
  ('D1-07', '2026-11-05 13:00:00+03'::timestamptz, '2026-11-05 13:45:00+03'::timestamptz, 'R03', 'SDE', 'From Community Voices to Climate Action: Participatory Storytelling for Youth Leaders', 'من أصوات المجتمع إلى العمل المناخي: السرد التشاركي للقادة الشباب', 'Education for Change Initiative for Young People'),
  ('D1-08', '2026-11-05 13:00:00+03'::timestamptz, '2026-11-05 13:45:00+03'::timestamptz, 'R04', 'SDE', 'From Waste to Wisdom: Empowering Education Through Stationery Reuse', 'من النفايات إلى المعرفة: تمكين التعليم عبر إعادة استخدام القرطاسية', 'EduCycle Foundation'),
  ('D1-09', '2026-11-05 13:00:00+03'::timestamptz, '2026-11-05 13:45:00+03'::timestamptz, 'R05', 'SDE', 'Rooted Resilience: Scaling Youth-Led Grassroots Climate Solutions Across the Global South', 'صمود متجذّر: توسيع الحلول المناخية الشعبية بقيادة الشباب في الجنوب العالمي', 'CorpsAfrica'),
  ('D1-10', '2026-11-05 13:00:00+03'::timestamptz, '2026-11-05 13:45:00+03'::timestamptz, 'R06', 'SDE', 'Burning Compost: Participatory Art for Climate Wellbeing', 'السماد المشتعل: فن تشاركي من أجل الرفاه المناخي', 'Masterpiece for Good'),
  ('D1-11', '2026-11-05 13:00:00+03'::timestamptz, '2026-11-05 13:45:00+03'::timestamptz, 'R08', 'SDE', 'Ancient Water Wisdom for a Changing Climate: What Oasis Communities Can Teach Future Climate Leaders', 'حكمة المياه القديمة لمناخ متغيّر: ما تعلّمه مجتمعات الواحات لقادة المناخ المستقبليين', 'University Mohammed VI Polytechnic – IWRI'),
  ('D1-12', '2026-11-05 13:00:00+03'::timestamptz, '2026-11-05 13:45:00+03'::timestamptz, 'R09', 'SDE', 'From Community Dialogues to COP31: Building National Youth Climate Statements Through Inclusive Local Consultations', 'من الحوارات المجتمعية إلى COP31: بناء بيانات وطنية للشباب حول المناخ عبر مشاورات محلية شاملة', 'Letters to Strangers'),
  ('D1-13', '2026-11-05 13:45:00+03'::timestamptz, '2026-11-05 14:00:00+03'::timestamptz, 'FOY', 'BRK', 'Coffee Break', 'استراحة قهوة', 'COY21'),
  ('D1-14', '2026-11-05 14:00:00+03'::timestamptz, '2026-11-05 14:45:00+03'::timestamptz, 'R03', 'SDE', 'GYS Session – PT', 'جلسة GYS – PT', 'YOUNGO'),
  ('D1-15', '2026-11-05 14:00:00+03'::timestamptz, '2026-11-05 14:45:00+03'::timestamptz, 'R05', 'SDE', 'UNFCCC Reform: Why It Matters Now', 'إصلاح اتفاقية الأمم المتحدة الإطارية بشأن تغير المناخ: لماذا يهم الآن', 'United Beyond Border'),
  ('D1-16', '2026-11-05 14:00:00+03'::timestamptz, '2026-11-05 14:45:00+03'::timestamptz, 'R08', 'SDE', 'Nothing About Us Without Us: Meaningful Inclusion of Persons with Disabilities', 'لا شيء عنّا بدوننا: الإشراك الفعلي للأشخاص ذوي الإعاقة', 'Action for Differently Abled Children Network Sierra Leone'),
  ('D1-17', '2026-11-05 14:45:00+03'::timestamptz, '2026-11-05 15:00:00+03'::timestamptz, 'FOY', 'BRK', 'Coffee Break', 'استراحة قهوة', 'COY21'),
  ('D1-18', '2026-11-05 15:00:00+03'::timestamptz, '2026-11-05 15:45:00+03'::timestamptz, 'R01', 'SDE', 'Climate Justice Beyond Ambition', 'العدالة المناخية ما بعد الطموح', 'YOUNGO Human Rights WG'),
  ('D1-19', '2026-11-05 15:00:00+03'::timestamptz, '2026-11-05 15:45:00+03'::timestamptz, 'R02', 'SDE', 'The Cadastral Invisibility Loop: A Grassroots Toolkit for Informal Settlements', 'حلقة الغياب عن السجلات العقارية: أدوات شعبية للمستوطنات غير الرسمية', 'Biblioteca Infantil en Salida'),
  ('D1-20', '2026-11-05 15:00:00+03'::timestamptz, '2026-11-05 15:45:00+03'::timestamptz, 'R05', 'SDE', 'Ocean Guardians: Indigenous Pacific Voices', 'حرّاس المحيط: أصوات الشعوب الأصلية في المحيط الهادئ', 'Melanesian Women Today'),
  ('D1-21', '2026-11-05 15:00:00+03'::timestamptz, '2026-11-05 15:45:00+03'::timestamptz, 'R06', 'SDE', 'Plastic Waste to Purpose: Innovative Solutions for Sustainable Communities', 'من نفايات البلاستيك إلى غاية: حلول مبتكرة لمجتمعات مستدامة', 'Rural Women Action for Environment Sierra Leone'),
  ('D1-22', '2026-11-05 15:00:00+03'::timestamptz, '2026-11-05 15:45:00+03'::timestamptz, 'R07', 'SDE', 'Different Contexts, Common Aspiration — Lake Victoria Voices', 'سياقات مختلفة وطموح مشترك — أصوات بحيرة فيكتوريا', 'Amazon Theatrix Ensemble'),
  ('D1-23', '2026-11-05 15:00:00+03'::timestamptz, '2026-11-05 15:45:00+03'::timestamptz, 'R08', 'SDE', 'Youth, AI and the Future of Climate Action', 'الشباب والذكاء الاصطناعي ومستقبل العمل المناخي', 'Skillistan'),
  ('D1-24', '2026-11-05 15:45:00+03'::timestamptz, '2026-11-05 16:00:00+03'::timestamptz, 'FOY', 'BRK', 'Coffee Break', 'استراحة قهوة', 'COY21'),
  ('D1-25', '2026-11-05 16:00:00+03'::timestamptz, '2026-11-05 16:45:00+03'::timestamptz, 'R02', 'SDE', 'Beyond the Pledge: Turning Climate Targets into Real Projects', 'ما بعد التعهّد: تحويل الأهداف المناخية إلى مشاريع حقيقية', 'European Young Engineers (EYE)'),
  ('D1-26', '2026-11-05 16:00:00+03'::timestamptz, '2026-11-05 16:45:00+03'::timestamptz, 'R03', 'SDE', 'Youth-led Innovations for Climate Action', 'ابتكارات بقيادة الشباب من أجل العمل المناخي', 'Global Youth Coalition'),
  ('D1-27', '2026-11-05 16:00:00+03'::timestamptz, '2026-11-05 16:45:00+03'::timestamptz, 'R09', 'SDE', 'From Mountain Frontlines to Global Action: Indigenous Youth Leading Climate Resilience', 'من خطوط المواجهة في الجبال إلى العمل العالمي: شباب الشعوب الأصلية يقودون الصمود المناخي', 'Youth Action for Next Generations'),
  ('D1-28', '2026-11-05 16:45:00+03'::timestamptz, '2026-11-05 17:30:00+03'::timestamptz, 'MH',  'PLN', 'Wrap-up & Announcements', 'الختام والإعلانات', 'COY21'),
  ('D1-29', '2026-11-05 19:00:00+03'::timestamptz, '2026-11-05 22:00:00+03'::timestamptz, 'MH',  'CUL', 'Cultural Night 1 — Turkish Heritage & Welcome', 'الليلة الثقافية الأولى — التراث التركي والترحيب', 'COY21 Cultural WG')
) as v(session_code, start_time, end_time, room_code, track_code, title_en, title_ar, organisation)
where not exists (select 1 from sessions s where s.session_code = v.session_code);
