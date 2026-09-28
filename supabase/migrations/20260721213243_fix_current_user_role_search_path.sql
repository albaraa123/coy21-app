-- Align current_user_role() with the same security-definer search_path hardening
-- applied to handle_new_user() in 20260721201242_fix_handle_new_user_search_path.sql:
-- pg_temp is included explicitly to prevent search_path hijacking via temporary
-- objects, per Postgres/Supabase security-definer best practice.
alter function current_user_role() set search_path = public, pg_temp;
