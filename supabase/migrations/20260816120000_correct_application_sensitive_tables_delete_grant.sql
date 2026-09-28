-- 20260816120000_correct_application_sensitive_tables_delete_grant.sql
--
-- TWELFTH corrective follow-up to 20260816000000_canonical_authenticated_
-- and_service_role_grants.sql, found while running the full repository
-- test suite (Phase 7G-K, via tests/import/phase-b-sensitive-import-live.
-- test.ts's rollback tests).
--
-- ROOT CAUSE: rollback_import_batch_transactional's actual latest
-- definition (supabase/migrations/20260731130000_phase_b_fix_rollback_
-- fingerprint_regression.sql, lines 194/219/248) deletes from
-- application_answers, application_travel_info, and application_health_info
-- as part of its real, genuine production rollback flow (delete-then-
-- reinsert the prior snapshot) — this is a REAL production DELETE path,
-- unlike the test-only DELETE grants tracked separately in the scratchpad
-- for Phase 7G-M teardown. This function is a plain `language plpgsql`
-- function with no `security definer`, so it runs as service_role (its
-- real caller, via rollbackImportBatchForCaller). The canonical migration
-- never granted DELETE on any of these three tables to service_role at all.

grant delete on public.application_answers to service_role;
grant delete on public.application_travel_info to service_role;
grant delete on public.application_health_info to service_role;
