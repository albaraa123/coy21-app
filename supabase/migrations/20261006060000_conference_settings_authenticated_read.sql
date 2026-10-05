-- 20261006060000_conference_settings_authenticated_read.sql
--
-- Final whole-branch review of sub-project 4e found a real UX gap: /my-
-- agenda and /my-agenda/browse computed isPastDeadline from each
-- session's own booking_deadline only, never accounting for the global
-- deadline the rest of this sub-project introduced -- because
-- conference_settings' only existing SELECT policy (20261006000000,
-- "staff can read conference settings") is staff-only, so a participant's
-- own session client got an empty result (RLS filters rows silently, it
-- doesn't error), and the client-side least(global, per-session)
-- computation those two pages now do would always have resolved to just
-- the per-session deadline regardless.
--
-- This is low-risk to widen: the row has exactly one non-metadata column
-- (global_booking_deadline, a single platform-wide timestamp with no
-- participant-specific or otherwise sensitive data), and server-side
-- enforcement in book_session/join_waitlist/cancel_booking (via
-- session_effective_deadline()) was already correct regardless of what
-- any client could read -- this policy only fixes the UI from showing a
-- stale/incomplete deadline, it does not change what's enforced.
--
-- Does not replace or narrow the existing staff-only policy (still needed
-- for the admin settings page's "is a global deadline currently set"
-- read, which doesn't go through this new policy's weaker semantics).
-- Postgres evaluates multiple permissive SELECT policies on the same
-- table with OR, so adding this one strictly widens read access, it
-- cannot accidentally narrow the staff policy's own guarantee.

create policy "authenticated users can read conference settings"
  on conference_settings for select
  using (auth.uid() is not null);
