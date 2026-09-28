-- seed_official_tracks.sql
--
-- The tracks table has never had a seed-data migration; the only rows ever
-- present in it were disposable test fixtures (AUTHZ-TRACK, CONFIRM-PUB-
-- TRACK, TEST-TRACK), left untouched here since each owning test cleans up
-- its own row. This inserts the 4 official conference tracks with
-- deliberately fixed, stable UUIDs so downstream references (seed data,
-- fixtures, documentation) can cite a known id rather than a
-- query-time-generated one.
--
-- cross_cutting_track (this migration) is the code for Track 4, a real
-- agenda track. It is unrelated to and must not be confused with
-- sessions.admission_policy's 'cross_cutting' value (added in the
-- flexible-admission-qr-attendance work) — the two are independently
-- configurable: a session in Track 4 can have any admission_policy, and a
-- session with admission_policy='cross_cutting' can belong to any track.
insert into tracks (id, code, name_ar, name_en, is_active) values
  ('1effc2ca-9bd4-4cc5-94c5-be177195343b', 'adaptation_resilience_communities', 'المحور الأول: التكيف والمرونة وصمود المجتمعات', 'Track 1: Adaptation, Resilience, and Resilient Communities', true),
  ('a4b2c098-1351-4512-8d1e-dfedab0f255c', 'just_transition_green_economy_climate_innovation', 'المحور الثاني: التحول العادل والاقتصاد الأخضر والابتكار المناخي', 'Track 2: Just Transition, Green Economy, and Climate Innovation', true),
  ('472a5779-6dc5-47ef-8093-e414e2cfec49', 'climate_finance_governance_international_cooperation', 'المحور الثالث: تمويل المناخ والحوكمة والتعاون الدولي', 'Track 3: Climate Finance, Governance, and International Cooperation', true),
  ('bd80e41e-cbfb-47f3-9bac-14a24c5a125a', 'cross_cutting_track', 'المحور الرابع: المسار التقاطعي', 'Track 4: Cross-Cutting Track', true)
on conflict (id) do nothing;
