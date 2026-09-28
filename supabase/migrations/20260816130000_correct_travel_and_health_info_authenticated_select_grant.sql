-- 20260816130000_correct_travel_and_health_info_authenticated_select_grant.sql
--
-- THIRTEENTH corrective follow-up to 20260816000000_canonical_authenticated_
-- and_service_role_grants.sql, found while running the full repository test
-- suite (Phase 7G-K, via tests/import/sensitive-data-rls.test.ts).
--
-- ROOT CAUSE: application_travel_info and application_health_info both carry
-- real, pre-existing RLS policies (20260730110000_application_travel_and_
-- health_info_tables.sql, lines 123-142) that grant role-based staff access
-- (travel_operations_staff/participant_care_staff/super_admin, via for-all
-- policies) and own-row SELECT access to participants directly as the
-- `authenticated` role. The canonical migration granted `authenticated`
-- SELECT on application_answers (20260816090000) for the identical own-row
-- pattern but missed these two sibling tables entirely -- no `authenticated`
-- grant existed on either at all, so every direct authenticated read failed
-- with "permission denied for table ..." regardless of RLS outcome.

grant select on public.application_travel_info to authenticated;
grant select on public.application_health_info to authenticated;
