-- 20260816040000_correct_session_people_select_grant.sql
--
-- FOURTH corrective follow-up to 20260816000000_canonical_authenticated_and_
-- service_role_grants.sql, found while running the live tests/schedule/*
-- suites (Phase 7G-B) against the corrected allocation_issues grant
-- (20260816030000).
--
-- ROOT CAUSE: confirm_publication_transactional (supabase/migrations/
-- 20260723195000_*.sql) is a plain `language plpgsql` function with NO
-- `security definer` clause, so it runs as the calling role — service_role,
-- since it is invoked via confirmPublication() (src/lib/schedule/
-- run-confirm-publication.ts) through a service-role client. Its body reads
-- from session_people (joined with people) in three places (lines 147, 171,
-- 231 of that migration) to freeze speaker display fields onto published
-- items. The original canonical migration granted session_people SELECT
-- only to authenticated (staff-wide agenda read surface) — missing that
-- this RPC's own body, running as service_role, also needs to read it.

grant select on public.session_people to service_role;
