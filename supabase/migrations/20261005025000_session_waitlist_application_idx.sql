-- 20261005025000_session_waitlist_application_idx.sql
--
-- Follow-up from code review of 20261005020000: session_bookings has a
-- standalone application_id index (session_bookings_application_idx,
-- 20260823020000) for "fetch this participant's rows" access patterns --
-- the RLS select_own policy's subquery, and page queries like
-- /my-agenda's planned "Waitlisted" section (see
-- docs/superpowers/specs/2026-10-01-work-group-waitlist-design.md). The
-- original session_waitlist migration only indexed application_id as
-- part of a partial unique index scoped to status = 'waiting', which
-- Postgres can't use for a query that doesn't filter on status. Adding
-- the same plain index session_bookings already has, for consistency and
-- to avoid a sequential scan as the table grows.

create index session_waitlist_application_idx
  on session_waitlist (application_id);
