-- tests/attendance/qr-credentials-lifecycle-trigger.test-only-teardown.sql
--
-- Run immediately after the suite finishes, against the SAME disposable
-- local instance the setup file was applied to:
--
--   supabase db query --local -f tests/attendance/qr-credentials-lifecycle-trigger.test-only-teardown.sql
--
-- CORRECTED this round: a prior version issued a separate
-- `revoke all on function ... from service_role` before each
-- `drop function if exists`. If setup had only partially completed (e.g.
-- the first CREATE FUNCTION succeeded but the second failed, or this
-- teardown is re-run after an earlier teardown already dropped one of the
-- two), REVOKE on a function that does not exist raises an error and
-- halts the rest of the file — meaning the second function's own cleanup
-- statements would never run. `drop function if exists` is unconditionally
-- safe (no-op when the function is absent) AND removes any grants along
-- with the function itself — there is nothing left for a separate REVOKE
-- to do that DROP doesn't already do. This file is now exactly two
-- statements, both idempotent, safe to run zero, one, or many times in
-- any order relative to setup succeeding, partially succeeding, or never
-- having run at all.
drop function if exists public.test_only_replace_qr_credential_same_application(
  uuid, uuid, bytea, bytea, smallint, uuid, text, text
);

drop function if exists public.test_only_rotate_and_probe_inactive_key(
  uuid, uuid, bytea, bytea
);
