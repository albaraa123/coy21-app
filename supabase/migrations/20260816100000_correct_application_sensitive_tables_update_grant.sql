-- 20260816100000_correct_application_sensitive_tables_update_grant.sql
--
-- TENTH corrective follow-up to 20260816000000_canonical_authenticated_and_
-- service_role_grants.sql, found while running the full repository test
-- suite (Phase 7G-K, via tests/import/claimed-update-gate-live.test.ts).
--
-- ROOT CAUSE: apply_import_row_transactional's actual latest definition
-- (supabase/migrations/20260731110000_phase_b_apply_import_row_sensitive_
-- writes.sql, lines 43-553 — confirmed the true latest version by checking
-- every later migration file for a re-`create or replace`, none exists)
-- uses `insert ... on conflict (...) do update set ...` (an upsert) against
-- all three sensitive/answer tables: application_answers,
-- application_travel_info, application_health_info. An upsert's DO UPDATE
-- branch requires UPDATE privilege at the Postgres level, not just INSERT —
-- migration 20260816080000 granted service_role only SELECT+INSERT on
-- these three tables, missing that the same function's upsert pattern also
-- needs UPDATE. This function is a plain `language plpgsql` function with
-- no `security definer`, so it runs as service_role (its real caller, via
-- runValidationForCaller and the confirm-import Server Actions).

grant update on public.application_answers to service_role;
grant update on public.application_travel_info to service_role;
grant update on public.application_health_info to service_role;
