-- tests/attendance/qr-credentials-lifecycle-trigger.test-only-setup.sql
--
-- TEST-ONLY. NOT a Supabase migration — deliberately NOT under
-- supabase/migrations/, so it is never picked up by `supabase db push` /
-- the normal migration-apply flow and never ships to any deployed
-- environment (dev, staging, or production). Exists only under this test
-- directory. Must be applied to, and torn down from, a disposable LOCAL
-- Supabase instance only (`supabase start` + `supabase db reset --local`)
-- — never a shared, staging, or production project. See
-- tests/attendance/qr-credentials-lifecycle-trigger.test.ts's own
-- local-database guard for the runtime check that enforces this.
--
-- Defines two test-only helpers used exclusively by that test file:
--   1. test_only_replace_qr_credential_same_application — drives the
--      same two-statement shape (old row -> replaced, new row inserted
--      active, same application) the real finalizer's inner block uses,
--      through one PostgREST call, because PostgREST cannot span one
--      transaction across two separate REST calls. See the SCOPE note
--      directly above its definition below for exactly what this helper
--      does and does NOT prove.
--   2. test_only_rotate_and_probe_inactive_key — a single-transaction
--      helper for the decrypt-only-key rollback-safety test: captures the
--      current active key, rotates to a temporary new version, attempts
--      an insert against the now-decrypt-only old key (expected to be
--      rejected by qr_credentials_enforce_lifecycle_trigger()), then
--      unconditionally raises a documented sentinel so the ENTIRE
--      transaction — including the rotation itself — rolls back, leaving
--      the registry exactly as it was found.
--
-- Apply with (against the LOCAL instance only):
--   supabase db query --local -f tests/attendance/qr-credentials-lifecycle-trigger.test-only-setup.sql
--
-- Tear down with the paired file immediately after the suite finishes —
-- see tests/attendance/qr-credentials-lifecycle-trigger.test-only-teardown.sql.

-- ============================================================================
-- 1. test_only_replace_qr_credential_same_application
-- ============================================================================
--
-- SCOPE — what this helper proves and does NOT prove:
--
-- Proves: the atomic old-row transition (active -> replaced) plus new-row
-- insertion (active, SAME application_id as the old row) in one
-- transaction; that qr_credentials_replacement_same_application_fkey (§1.2)
-- is satisfied by a genuine same-application replacement; that a failure
-- of the new-row INSERT (a unique violation, a trigger rejection, anything)
-- rolls back the old-row UPDATE alongside it, since both statements share
-- one transaction; and qr_credentials_enforce_lifecycle_trigger()'s
-- replaced_by/reissue_channel validation on the OLD row's UPDATE, exactly
-- as the real finalizer's own UPDATE would trigger it.
--
-- Does NOT prove, and must not be described or used as proving: correct
-- staff-finalizer behavior for the NEW row. This helper always inserts the
-- new row with issuance_channel = 'system' and issued_by = null,
-- regardless of the reissue_channel passed for the OLD row — it does not
-- reproduce finalize_qr_reissue_for_server's own conditional-expression
-- logic for populating the new row's issued_by from a staff actor. It is
-- NOT "the same finalizer logic" — it is a narrower two-statement shape
-- built only to exercise the OLD row's trigger branches under test in
-- §5.2c. Any assertion about the NEW row's issued_by being correctly
-- populated for a staff reissue, or correctly left null for a participant
-- self-reissue, requires the real finalize_qr_reissue_for_server RPC —
-- deferred to Sub-pass 2 (see the deferred-tests list in
-- qr-credentials-lifecycle-trigger.test.ts's own top-of-file comment).
create function public.test_only_replace_qr_credential_same_application(
  p_old_credential_id uuid,
  p_new_credential_id uuid,
  p_new_token_hash bytea,
  p_new_token_ciphertext bytea,
  p_new_encryption_key_version smallint,
  p_replaced_by uuid,
  p_reissue_channel text,
  p_reissue_reason_code text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old public.qr_credentials;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_old from public.qr_credentials where id = p_old_credential_id for update;
  if v_old.id is null then
    raise exception 'test_only_replace_qr_credential_same_application: old credential not found';
  end if;

  -- Old row transitions to 'replaced' FIRST, freeing
  -- qr_credentials_one_active_per_application's slot for this
  -- application_id before the new row is inserted as 'active' below —
  -- same ordering the real finalizer uses, for the same reason (§1.2's
  -- note on qr_credentials_replacement_same_application_fkey).
  update public.qr_credentials
  set status = 'replaced',
      replaced_at = v_now,
      replaced_by = p_replaced_by,
      replaced_by_credential_id = p_new_credential_id,
      reissue_channel = p_reissue_channel,
      reissue_reason_code = p_reissue_reason_code,
      token_ciphertext = null,
      encryption_key_version = null
  where id = p_old_credential_id;

  -- Same application as the OLD row, always — the actual invariant under
  -- test. If this INSERT fails for any reason (a unique violation, a
  -- trigger rejection, anything), the whole function is one transaction:
  -- the UPDATE above rolls back with it, so the old credential is never
  -- left 'replaced' with no corresponding new active credential. Always
  -- 'system'/null — see the SCOPE note above; this is NOT staff-finalizer
  -- behavior for the new row.
  insert into public.qr_credentials (
    id, application_id, token_hash, token_ciphertext, encryption_key_version,
    status, issuance_channel, issued_by, issued_at, created_at
  ) values (
    p_new_credential_id, v_old.application_id, p_new_token_hash, p_new_token_ciphertext,
    p_new_encryption_key_version, 'active', 'system', null, v_now, v_now
  );
end;
$$;

-- ============================================================================
-- 2. test_only_rotate_and_probe_inactive_key
-- ============================================================================
--
-- Single-transaction rollback-safety helper for the decrypt-only-key
-- trigger test. A prior draft ran the rotation and the rejected insert as
-- two separate PostgREST calls (two separate transactions) — the rotation
-- COMMITTED before the insert was even attempted, so a failed insert could
-- never restore the registry's pre-rotation state. This helper performs
-- the capture, the temporary-version selection, the rotation, the probe
-- insert, and a documented sentinel RAISE all inside ONE transaction, so
-- that the entire thing — rotation included — always rolls back
-- regardless of outcome, leaving the registry exactly as found.
--
-- CORRECTED this round: the temporary key version is no longer chosen by
-- the CALLER (the previous signature took p_new_key_version as a
-- parameter, computed client-side as
-- Math.min(originalActiveKeyVersion + 10000, 32767) — unsafe, since that
-- arithmetic could select an already-registered version, collide when the
-- active version is already near the top of the smallint range, or
-- silently clamp to 32767 and collide with an existing row there). The
-- helper now selects its own temporary version itself, INSIDE this
-- function, while holding the SAME qr_encryption_key_rotation advisory
-- lock rotate_encryption_key_version_for_server itself takes — so no
-- concurrent rotation can register a new max version between this
-- function's own max-lookup and its later call into the rotation RPC.
-- Selected as max(key_version) + 1 and explicitly re-verified absent
-- before rotating, rather than trusting the arithmetic alone.
create function public.test_only_rotate_and_probe_inactive_key(
  p_credential_id uuid,
  p_application_id uuid,
  p_token_hash bytea,
  p_token_ciphertext bytea
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_stale_key_version smallint;
  v_max_key_version smallint;
  v_temporary_key_version smallint;
  v_existing_count integer;
  v_rejected boolean := false;
  v_sqlstate text;
  v_message text;
begin
  -- Same fixed advisory lock rotate_encryption_key_version_for_server
  -- itself takes (§1.6) — held for this function's own transaction
  -- duration, so the max-version lookup below and the later rotation call
  -- are effectively one atomic "pick and reserve" operation with respect
  -- to any other concurrent rotation/retirement.
  perform pg_advisory_xact_lock(hashtext('qr_encryption_key_rotation'));

  select key_version into v_stale_key_version
    from public.qr_encryption_key_registry where status = 'active' limit 1;
  if v_stale_key_version is null then
    raise exception 'test_only_rotate_and_probe_inactive_key: no active key version found';
  end if;

  select max(key_version) into v_max_key_version from public.qr_encryption_key_registry;
  if v_max_key_version is null or v_max_key_version >= 32767 then
    raise exception 'test_only_rotate_and_probe_inactive_key: no safe unused key version available (max registered version is %)', v_max_key_version;
  end if;
  v_temporary_key_version := v_max_key_version + 1;

  -- Explicit existence check, not merely trusting max()+1 arithmetic —
  -- redundant under the advisory lock held above (nothing else can be
  -- concurrently inserting a colliding version while this lock is held),
  -- but stated directly as its own guard rather than only implied.
  select count(*) into v_existing_count
    from public.qr_encryption_key_registry where key_version = v_temporary_key_version;
  if v_existing_count > 0 then
    raise exception 'test_only_rotate_and_probe_inactive_key: selected temporary key version % already exists', v_temporary_key_version;
  end if;

  perform public.rotate_encryption_key_version_for_server(v_temporary_key_version);
  -- v_stale_key_version is now decrypt_only within THIS transaction only —
  -- nothing has committed yet.

  begin
    insert into public.qr_credentials (
      id, application_id, token_hash, token_ciphertext, encryption_key_version,
      status, issuance_channel, issued_by
    ) values (
      p_credential_id, p_application_id, p_token_hash, p_token_ciphertext,
      v_stale_key_version, 'active', 'system', null
    );
    -- The insert must NOT succeed — if it does, this is a genuine test
    -- failure and must be surfaced as such, not silently swallowed.
    raise exception 'test_only_rotate_and_probe_inactive_key: probe insert unexpectedly succeeded';
  exception
    when others then
      -- CORRECTED this round: capture BOTH RETURNED_SQLSTATE and
      -- MESSAGE_TEXT, and require BOTH to match exactly — a bare message
      -- comparison alone cannot distinguish the trigger's own
      -- RAISE EXCEPTION (SQLSTATE P0001, Postgres's default for an
      -- unqualified plpgsql RAISE EXCEPTION) from some other error that
      -- happened to produce coincidentally similar text.
      get stacked diagnostics v_sqlstate = returned_sqlstate, v_message = message_text;
      if v_sqlstate = 'P0001' and v_message = 'encryption_key_version must be an active key version' then
        v_rejected := true;
      else
        -- Unexpected error shape — re-raise it as-is rather than masking
        -- it behind the sentinel below.
        raise;
      end if;
  end;

  if not v_rejected then
    raise exception 'test_only_rotate_and_probe_inactive_key: probe insert did not reach the expected rejection';
  end if;

  -- Documented sentinel: unconditionally raised once the probe insert is
  -- confirmed rejected with the exact expected SQLSTATE and message, so
  -- the entire transaction — the rotation included — rolls back. The
  -- calling test asserts this exact sentinel (code AND message, not
  -- merely toContain) and treats it as success; any OTHER error reaching
  -- the caller (including the three raises above) is a genuine test
  -- failure.
  raise exception 'TEST_ONLY_ROLLBACK_SENTINEL: inactive-key probe completed as expected, rolling back';
end;
$$;

-- ============================================================================
-- Grants — both functions
-- ============================================================================
--
-- CORRECTED: an earlier draft revoked EXECUTE from service_role too and
-- claimed service_role's RLS bypass also bypassed function EXECUTE
-- privileges — that claim was wrong. Postgres's function EXECUTE privilege
-- and row-level security are two independent mechanisms; service_role
-- bypasses RLS (and, separately, is often granted broad table privileges
-- by Supabase's own default grants), but a function with no EXECUTE grant
-- to a role is simply not callable by that role, RLS bypass or not. The
-- Vitest suite invokes both helpers through the service-role Supabase
-- client, so service_role MUST hold an explicit EXECUTE grant here or
-- every call fails with a permission error, not the intended test
-- behavior.
revoke all on function public.test_only_replace_qr_credential_same_application(
  uuid, uuid, bytea, bytea, smallint, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.test_only_replace_qr_credential_same_application(
  uuid, uuid, bytea, bytea, smallint, uuid, text, text
) to service_role;

revoke all on function public.test_only_rotate_and_probe_inactive_key(
  uuid, uuid, bytea, bytea
) from public, anon, authenticated;
grant execute on function public.test_only_rotate_and_probe_inactive_key(
  uuid, uuid, bytea, bytea
) to service_role;
