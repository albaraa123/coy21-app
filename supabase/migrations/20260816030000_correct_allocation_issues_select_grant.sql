-- 20260816030000_correct_allocation_issues_select_grant.sql
--
-- THIRD corrective follow-up to 20260816000000_canonical_authenticated_and_
-- service_role_grants.sql, found while running the live tests/schedule/*
-- suites (Phase 7G-B) against the corrected schedule_publications/
-- schedule_publication_drafts grants (20260816010000).
--
-- ROOT CAUSE: stage_publication_transactional (supabase/migrations/
-- 20260723190000_*.sql) is a plain `language plpgsql` function with NO
-- `security definer` clause, so it runs as the calling role — service_role,
-- since it is invoked via stagePublication() (src/lib/schedule/
-- run-stage-publication.ts) through a service-role client. Its body reads
-- from allocation_issues in three places (lines 59, 125, 166 of that
-- migration) to determine mandatory-session blockers. The original
-- canonical migration granted service_role only INSERT on allocation_issues
-- (classified as an "insert-only trail", since the real-code audit found no
-- direct .from('allocation_issues').select(...) call in src/) — missing
-- that this RPC's own body reads it. SELECT was missing entirely.

grant select on public.allocation_issues to service_role;
