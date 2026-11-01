-- 20261101040000_add_public_launch_indexes.sql
--
-- Adds three indexes identified by a pre-launch performance pass, ahead of
-- real registration/traffic volume for the Nov 5-7 2026 conference.
-- Purely additive -- no behavior change, just faster reads on paths that
-- will be hit far more often once real participants start registering.
--
-- 1. sessions(is_public) -- the public /conference-agenda page's only
--    query filters `where is_public = true`
--    (src/app/[locale]/(public)/conference-agenda/page.tsx), and this
--    column has no index coverage today (sessions_table.sql indexes
--    conference_day_id/track_id/session_type_id/room_id and two
--    status-composite pairs, but not is_public). At 112 rows this is a
--    harmless sequential scan; it won't stay harmless if the agenda
--    grows or this page gets cached/revalidated frequently under real
--    traffic.
create index sessions_is_public_idx on public.sessions (is_public);

-- 2. applications(imported_email) -- the Add Participant form's
--    duplicate-email check (src/app/[locale]/(admin)/applications/new/
--    actions.ts) queries `where imported_email = ...` with NO
--    `applicant_id is null` filter, so it cannot use the existing
--    PARTIAL unique index applications_imported_email_unclaimed_unique
--    (which only covers unclaimed rows) for an already-claimed
--    applicant's row. A plain index on the full column covers every row,
--    claimed or not.
create index applications_imported_email_idx on public.applications (imported_email);

-- 3. profiles(email) -- the same duplicate-email check's second query
--    filters `where profiles.email = ...` via an inner join, and
--    profiles.email has no index at all today. This is the query most
--    likely to get slower as real participants claim their invitations
--    and accumulate profile rows between now and the event.
create index profiles_email_idx on public.profiles (email);
