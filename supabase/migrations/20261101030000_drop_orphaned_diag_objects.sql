-- 20261101030000_drop_orphaned_diag_objects.sql
--
-- Drops the diagnostic-only tables and function left behind by the P0
-- next_application_number() concurrency investigation
-- (docs/superpowers/specs/2026-08-01-next-application-number-concurrency-bug.md),
-- introduced in 20260805200000_diag_application_number_isolation.sql,
-- 20260805210000_diag_lpad_behavior.sql, and
-- 20260805220000_diag_raw_nextval_rpc.sql. The first of those three
-- migrations' own header comment says this table "is meant to be
-- dropped/deleted once the investigation concludes" -- the investigation
-- concluded (the real fix landed separately) but the cleanup never
-- happened, and these objects have stayed live in production ever since.
--
-- Three tables (diag_app_number_log, diag_app_number_function_props,
-- diag_app_number_seq_props): created with no RLS, holding only
-- investigation output (sequence/function introspection values, no
-- participant data of any kind), but still queryable by any role with a
-- table-level grant on them -- they were swept into
-- 20261006080000_fix_missing_service_role_grants.sql's broad
-- service-role-grant-everything-in-public pass, so service_role can read
-- them; dropping the tables removes that grant along with everything
-- else.
--
-- One function (diag_raw_nextval()): a plain `security invoker` SQL
-- function with no restricted grant, so under PostgREST's default RPC
-- exposure it is callable by anon/authenticated and, on every call,
-- advances application_number_seq -- the SAME sequence
-- next_application_number() draws real application numbers from. Live
-- and callable today, this is a bigger latent problem than the tables:
-- an anonymous caller hitting POST /rest/v1/rpc/diag_raw_nextval can burn
-- real sequence values and create unexplained gaps in issued application
-- numbers, for zero legitimate purpose.
--
-- All four objects are diagnostic scaffolding with no remaining caller
-- (confirmed: no references anywhere under src/, only the generated
-- database.ts type definitions, which regenerate clean after this drop).
drop table if exists diag_app_number_log;
drop table if exists diag_app_number_function_props;
drop table if exists diag_app_number_seq_props;
drop function if exists diag_raw_nextval();
