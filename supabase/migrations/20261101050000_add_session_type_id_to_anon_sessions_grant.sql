-- 20261101050000_add_session_type_id_to_anon_sessions_grant.sql
--
-- Fixes a regression introduced by
-- 20261101020000_narrow_anon_sessions_grant.sql: that migration narrowed
-- the anon SELECT grant on public.sessions to a fixed column list, which
-- did not include session_type_id. The public /conference-agenda page was
-- then updated to embed session_types(code) (to color-code each session
-- card by its real type: Registration/Plenary/Side Event/Break/Culture),
-- which requires PostgREST to read session_type_id to resolve the
-- relationship -- exactly the same reason track_id/room_id were already
-- included for the rooms()/tracks() embeds. Without it, PostgREST does
-- not just omit the embed: the entire query fails outright with
-- "permission denied for table sessions" (confirmed live against the
-- anon-key REST endpoint), which silently fell back to the page's empty
-- state. This migration adds session_type_id to the existing grant;
-- every other column stays exactly as narrowed before.
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
  session_type_id,
  language,
  is_public
) on public.sessions to anon;
