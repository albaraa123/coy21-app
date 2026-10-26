-- 20261025000200_narrow_profiles_email_grant.sql
--
-- 20260727000000_fix_profiles_role_privilege_escalation.sql:32 granted
-- `update (full_name, email) on profiles to authenticated`. Once My
-- Profile's email field goes through supabase.auth.updateUser({ email })
-- (Supabase's own confirm-by-link flow, see the next migration), this
-- grant would let a user bypass that confirmation flow entirely by
-- writing `update profiles set email = '...'` directly via the
-- Supabase client, landing an unconfirmed email straight into profiles.
-- Narrow the grant to full_name only -- profiles.email becomes writable
-- only by the new sync trigger (SECURITY DEFINER / table owner, not
-- subject to this grant), never directly by an authenticated client.
-- saveIdentity (my-profile/actions.ts) only ever calls
-- supabase.auth.updateUser({ email }), never writes profiles.email
-- directly, so this narrowing does not break the intended flow.
revoke update on profiles from authenticated;
grant update (full_name) on profiles to authenticated;
