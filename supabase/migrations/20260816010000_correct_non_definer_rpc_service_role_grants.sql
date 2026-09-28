-- 20260816010000_correct_non_definer_rpc_service_role_grants.sql
--
-- CORRECTIVE FOLLOW-UP to 20260816000000_canonical_authenticated_and_
-- service_role_grants.sql, found while re-running live suites against the
-- new canonical grants baseline (Phase 7G-B).
--
-- ROOT CAUSE: that migration's SERVICE_ROLE section assumed every table
-- mutation not already traced to a direct .from(table)... call from
-- src/ was covered by a SECURITY DEFINER RPC body (which runs as the
-- function owner and needs no caller-side grant). That assumption was
-- wrong for several transactional RPCs that are plain `language plpgsql`
-- functions with NO `security definer` clause, so they run as the
-- CALLING role — here, always service_role, since every RPC in this list
-- is invoked via a service-role client (never the authenticated session
-- client). Confirmed directly against each function's own `create or
-- replace function ... $$ language plpgsql ...` definition (no
-- `security definer` present) and its actual insert/update statements:
--
--   scan_attempt_transactional (supabase/migrations/
--   20260814110000_fix_scan_attempt_transactional_finalized_at.sql):
--     insert into scan_attempts (x2), insert into attendance_records,
--     select from attendance_records for capacity counts.
--
--   stage_publication_transactional (supabase/migrations/
--   20260723190000_*.sql): insert into schedule_publication_drafts,
--   insert into schedule_publication_draft_items.
--
--   confirm_publication_transactional (supabase/migrations/
--   20260723195000_*.sql): update + insert into schedule_publications,
--   update schedule_publication_drafts.
--
-- schedule_publication_items and schedule_publication_draft_items already
-- carry full select/insert/update for service_role from the original
-- migration — only schedule_publications and schedule_publication_drafts
-- were missing entirely (previously granted select-only, to authenticated
-- only). scan_attempts had no grant at all; attendance_records had
-- select-only and needs insert added.
--
-- No authenticated-role change. No RLS change. No GRANT ALL.

grant select, insert on public.scan_attempts to service_role;
grant insert on public.attendance_records to service_role;
grant select, insert, update on public.schedule_publications to service_role;
grant select, insert, update on public.schedule_publication_drafts to service_role;
