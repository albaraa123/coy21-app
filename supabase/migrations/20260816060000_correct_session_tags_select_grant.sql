-- 20260816060000_correct_session_tags_select_grant.sql
--
-- SIXTH corrective follow-up to 20260816000000_canonical_authenticated_and_
-- service_role_grants.sql, found while running the full repository test
-- suite (Phase 7G-K).
--
-- ROOT CAUSE: runAllocation (src/lib/allocation/run-allocation.ts:66) reads
-- session_tags directly via a service-role client
-- (service.from('session_tags').select('session_id, tag_id, weight')) as
-- part of the real allocation orchestration. The original canonical
-- migration granted service_role only DELETE on session_tags (the one
-- confirmed direct-DELETE call site, via setSessionTags's full-replace
-- pattern) and authenticated SELECT (the staff-wide agenda read surface) —
-- missing that service_role's own orchestration code also needs to read
-- this table directly.

grant select on public.session_tags to service_role;
