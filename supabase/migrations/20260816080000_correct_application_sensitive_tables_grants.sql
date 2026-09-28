-- 20260816080000_correct_application_sensitive_tables_grants.sql
--
-- EIGHTH corrective follow-up to 20260816000000_canonical_authenticated_and_
-- service_role_grants.sql, found while running the full repository test
-- suite in isolation (Phase 7G-K).
--
-- ROOT CAUSE: apply_import_row_transactional / rollback_import_batch_
-- transactional (supabase/migrations/20260731130000_phase_b_fix_rollback_
-- fingerprint_regression.sql and predecessors) are plain `language plpgsql`
-- functions with NO `security definer` clause, so they run as the calling
-- role — service_role, since they are invoked via the import confirm/
-- rollback Server Actions through a service-role client. Their bodies
-- select from and insert into application_answers, application_travel_info,
-- and application_health_info (sensitive-data tables added in the Phase B
-- import work). The original canonical migration granted service_role only
-- SELECT on application_answers (no INSERT) and nothing at all on
-- application_travel_info/application_health_info.

grant select, insert on public.application_answers to service_role;
grant select, insert on public.application_travel_info to service_role;
grant select, insert on public.application_health_info to service_role;
