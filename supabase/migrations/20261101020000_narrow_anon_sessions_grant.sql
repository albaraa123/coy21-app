-- 20261101020000_narrow_anon_sessions_grant.sql
--
-- Narrows the anon SELECT grant on public.sessions, added in
-- 20260820150000_add_public_sessions_read_policy.sql, from the whole table
-- to only the columns the public /conference-agenda page actually reads
-- (src/app/[locale]/(public)/conference-agenda/page.tsx — the only caller
-- that queries `sessions` through the plain anon-capable client; every
-- other caller of `sessions` in the app runs under an authenticated
-- staff/participant session and is governed by the existing *_staff_all /
-- participant policies, never by this anon grant).
--
-- The gap: sessions_select_public (RLS) correctly restricts rows to
-- is_public = true, but the table-level `grant select on public.sessions
-- to anon` carries no column list, so any anon caller who queries the
-- PostgREST endpoint directly (bypassing the app's own narrower query) can
-- read every column on a public row, including ones never meant for
-- public exposure: internal_notes, cancellation_reason,
-- allocation_priority, checkin_opens_at/closes_at, and updated_by (a
-- staff profiles.id UUID). None of these are rendered by the app today,
-- but there is no enforcement preventing a direct API read of them.
--
-- The fix: revoke the blanket grant and re-grant SELECT on exactly the
-- columns the public page needs. RLS (sessions_select_public) continues
-- to restrict which ROWS are visible; this restricts which COLUMNS are,
-- the same way 20261025000200_narrow_profiles_email_grant.sql already
-- narrowed a different table's anon-reachable grant. No application code
-- changes — the public page's own select list
-- ('id, session_code, title_ar, title_en, start_time, end_time, language,
-- rooms(...), tracks(...)') is already covered: track_id/room_id are
-- granted (not selected directly, but required by PostgREST to resolve
-- the rooms()/tracks() embeds via their foreign keys), and is_public is
-- granted because sessions_select_public's own USING clause must be able
-- to evaluate it for an anon caller, independent of the caller's select
-- list.
revoke select on public.sessions from anon;

grant select (
  id,
  session_code,
  title_ar,
  title_en,
  start_time,
  end_time,
  track_id,
  room_id,
  language,
  is_public
) on public.sessions to anon;
