-- Adds a narrow, read-only RLS policy allowing anyone (no login required)
-- to SELECT all of conference_days. This table was missed by the
-- 2026-08-20 migration (add_public_sessions_read_policy.sql) that added
-- matching policies for sessions/rooms/tracks/session_types -- conference_days
-- has had RLS enabled since 2026-07-22 (agenda_reference_rls_policies.sql)
-- with ONLY a staff-all policy, no public/participant-read policy.
--
-- Real-world impact (found live 2026-11-01, during agenda vertical-
-- timeline QA): the participant Browse Sessions page joins
-- sessions -> conference_days to group sessions by day. Because
-- conference_days was unreadable for any authenticated non-staff user,
-- that join always resolved to null, and the page's own groupByDay()
-- silently drops any session with a null day -- so the Browse page
-- showed "No sessions available yet" for EVERY real participant,
-- regardless of how many sessions were actually published. This bug
-- predates the Timeline feature entirely; it was in the original
-- Browse page query from before this session's work began.
create policy conference_days_select_public
  on public.conference_days
  for select
  to anon, authenticated
  using (true);

-- RLS only narrows an already-granted privilege; confirm the same
-- anon-grant gap the 2026-08-20 migration found and fixed for the other
-- four tables doesn't also apply here (authenticated already has
-- table-level SELECT via Supabase's default provisioning; anon does not).
grant select on public.conference_days to anon;
