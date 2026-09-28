-- fix_profiles_role_privilege_escalation.sql
--
-- CRITICAL, live vulnerability found by the dedicated Tasks 20-21 security
-- review and independently reproduced: profiles_update_own
-- (20260721212035_rls_policies.sql:18-19) has a WITH CHECK of
-- `id = auth.uid()` only — it constrains WHICH row a user may update, but
-- places no constraint whatsoever on what value the `role` column may be
-- changed to. Any authenticated user could run
-- `update profiles set role = 'super_admin' where id = auth.uid()` and
-- succeed, since `authenticated` also holds table-wide UPDATE on `profiles`
-- with no column-level restriction. Reproduced live: a fresh, self-signed-up
-- 'participant' account escalated itself to 'super_admin' in one request
-- with zero errors, at which point every current_user_role()-gated RLS
-- policy and every isAgendaStaffRole()/isAdmissionStaffRole() application
-- check in the codebase treats that session as fully trusted staff.
--
-- This is Phase 1 code, predating this entire plan, but is fixed here
-- immediately given it is live and actively exploitable in production —
-- not deferred to a later task.
--
-- Fix: revoke UPDATE on `profiles` from authenticated/anon entirely, then
-- grant it back only for the specific columns a user should ever be able to
-- change about their own row. `role` is deliberately excluded — role
-- changes must go through a service-role-authorized path only (e.g. a
-- future admin action, or a service-role migration/seed), never a
-- self-service update. This is the primary fix: it makes a role write from
-- an authenticated/anon session fail at the grant level, before RLS is even
-- evaluated, which is a stronger guarantee than a WITH CHECK clause (a
-- column-level grant cannot be bypassed by any future policy rewrite that
-- forgets to re-add a role check).
revoke update on profiles from authenticated, anon;
grant update (full_name, email) on profiles to authenticated;

-- Belt-and-braces: also make the RLS policies themselves reject a role
-- change, so the protection does not rest on the grant alone. Both existing
-- update policies get an explicit role-immutability check.
drop policy if exists profiles_update_own on profiles;
create policy profiles_update_own on profiles
  for update
  using (id = auth.uid())
  with check (id = auth.uid() and role = (select p.role from profiles p where p.id = auth.uid()));

-- profiles_update_super_admin previously had a USING clause but NO WITH
-- CHECK at all, so it inherited no restriction on the new row values —
-- Postgres only requires a WITH CHECK to be present for it to apply; a
-- missing one means "no restriction" rather than "same as USING". A
-- super_admin genuinely should be able to change another user's role (that
-- is the intended admin capability), so this policy is intentionally left
-- permissive on `role` — the WITH CHECK added here only re-confirms the
-- USING condition, closing the "no restriction at all" gap without
-- narrowing what a real super_admin is allowed to do.
drop policy if exists profiles_update_super_admin on profiles;
create policy profiles_update_super_admin on profiles
  for update
  using (current_user_role() = 'super_admin')
  with check (current_user_role() = 'super_admin');

-- ---------------------------------------------------------------------
-- Medium finding, same review: claim_imported_application_transactional's
-- migration comment (20260726110000_claim_application_function.sql:197-203)
-- claims "revoked from public and granted only to authenticated" is enough
-- to keep anon out, but `revoke all ... from public` only removes the
-- PUBLIC pseudo-role's entry — Supabase's default privileges grant EXECUTE
-- to `anon` explicitly, at CREATE time, which a subsequent `revoke ... from
-- public` cannot remove. Confirmed live via pg_proc.proacl: anon was
-- present. Not exploitable today (the function's own `auth.uid() is null`
-- check correctly rejects an anon caller, verified live — anon reaches the
-- function body and gets a clean 400 from the RPC's own raise exception,
-- not a permission error), but the layered defense the comment claims does
-- not actually exist as deployed. Closing it explicitly rather than relying
-- on the one `if` staying correct forever.
-- ---------------------------------------------------------------------
revoke all on function claim_imported_application_transactional(uuid, uuid) from anon;
