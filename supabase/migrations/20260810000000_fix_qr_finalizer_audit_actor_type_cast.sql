-- 20260810000000_fix_qr_finalizer_audit_actor_type_cast.sql
--
-- Corrective migration for a genuine production defect discovered during
-- the Phase 6 cloud executable-verification gate (20260805235959_phase6_
-- qr_issuance_reissue.sql), confirmed by real end-to-end test execution
-- against a disposable Supabase Cloud project, not by static review.
--
-- Bug: in both finalize_qr_issuance_for_server and
-- finalize_qr_reissue_for_server, the audit_logs.actor_type value on the
-- success-path audit insert is computed via
--   case when v_op.channel = 'participant_self_service' then 'system' else 'admin' end
-- Both CASE branches are untyped string literals, so Postgres resolves the
-- CASE expression itself to type text (not unknown) — and text does not
-- implicitly cast to the audit_actor_type enum on INSERT, so every
-- successful issuance/reissue's own audit-log write fails with:
--   42804: column "actor_type" is of type audit_actor_type but expression is of type text
-- This fires on the real success path of both finalizers, not on any
-- test-only code — it was never previously exercised end-to-end.
--
-- Fix: an explicit ::audit_actor_type cast on the CASE expression. Every
-- other line below is byte-for-byte identical to the already-applied
-- 20260805235959 migration's own function bodies (diffed to confirm) —
-- no other logic, lock ordering, idempotency behavior, audit semantics,
-- signature, security context, or grant changes. The other five
-- audit_logs inserts elsewhere in 20260805235959_phase6_qr_issuance_
-- reissue.sql use bare literals directly in a VALUES/SELECT list (which
-- Postgres correctly infers against the target column's type in that
-- position) and were verified NOT to have this defect — left untouched.
--
-- The already-applied 20260805235959 migration is intentionally left
-- unmodified: it has already run against the disposable cloud project, so
-- editing it in place would not affect that already-created database
-- state and would create migration-history drift. This corrective
-- migration instead CREATE OR REPLACEs both affected functions using
-- their exact existing signatures.

create or replace function public.finalize_qr_issuance_for_server(
  p_operation_id uuid,
  p_credential_id uuid,
  p_token_hash bytea,
  p_token_ciphertext bytea,
  p_token_version smallint,
  p_encryption_key_version smallint
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_op public.qr_lifecycle_operations;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_caller_role text;
  v_batch public.qr_bulk_operation_batches;
  v_key_is_active boolean;
  v_now timestamptz;
  v_transition_now timestamptz;
  v_fingerprint bytea;
  v_existing_credential public.qr_credentials;
  v_result public.qr_credential_lifecycle_result;
begin
  -- Input-shape validation BEFORE any lock is taken — malformed input is
  -- rejected as an exception, never represented as a lifecycle-result
  -- outcome, exactly mirroring every reservation RPC's own discipline.
  if p_operation_id is null then raise exception 'operation_id is required'; end if;
  if p_credential_id is null then raise exception 'credential_id is required'; end if;
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'token_hash must be exactly 32 bytes';
  end if;
  if p_token_ciphertext is null or octet_length(p_token_ciphertext) <> 61 then
    raise exception 'token_ciphertext must be exactly 61 bytes';
  end if;
  if get_byte(p_token_ciphertext, 0) <> 1 then
    raise exception 'Unsupported ciphertext envelope version';
  end if;
  if p_token_version is null or p_token_version not between 1 and 32767 then
    raise exception 'Invalid token_version';
  end if;
  if p_encryption_key_version is null or p_encryption_key_version not between 1 and 32767 then
    raise exception 'Invalid encryption_key_version';
  end if;

  -- Position 1: lifecycle operation row, FOR UPDATE, locked and
  -- inspected FIRST, before any other row.
  select * into v_op from public.qr_lifecycle_operations where id = p_operation_id for update;
  if v_op.id is null then raise exception 'Lifecycle operation not found'; end if;

  -- Historical states handled FIRST, before any further lock —
  -- 'consumed'/'expired'/'cancelled' are all fully resolved by the
  -- operation row alone.
  if v_op.status = 'consumed' then
    -- Idempotent replay: recompute the SAME canonical fingerprint from
    -- THIS call's supplied inputs and compare against the durably stored
    -- one — never re-derived from the current qr_credentials row.
    -- CORRECTED this round: the replayed result itself must ALSO never be
    -- derived from the current qr_credentials row — a resulting credential
    -- may later become revoked or replaced, and exact finalizer replay
    -- must not change because of that later lifecycle transition. Every
    -- field returned here comes exclusively from the durable
    -- qr_lifecycle_operations row: credential_id from
    -- resulting_credential_id, status hardcoded to 'active' (the state at
    -- the successful finalization transition, never re-queried), and
    -- issued_at from finalized_at (guaranteed equal to the credential's
    -- own issued_at at the moment of that same transition). This branch
    -- no longer depends on the resulting credential row still being
    -- queryable, its current status, its ciphertext, its current
    -- encryption-key version, or any later revocation/replacement field.
    v_fingerprint := public.compute_qr_finalization_fingerprint(
      'issue', p_credential_id, p_token_hash, p_token_version, p_encryption_key_version, p_token_ciphertext
    );
    if v_fingerprint = v_op.finalization_fingerprint and p_credential_id = v_op.resulting_credential_id then
      v_result.outcome := 'already_finalized';
      v_result.credential_id := v_op.resulting_credential_id;
      v_result.status := 'active';
      v_result.issued_at := v_op.finalized_at;
      return v_result;
    end if;
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  if v_op.status = 'expired' then
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  if v_op.status = 'cancelled' then
    -- Replay the durable terminal outcome without re-evaluating current
    -- state — identical discipline to every reservation RPC's own
    -- replay_cancelled path.
    v_result.outcome := v_op.terminal_reason_code;
    if v_op.terminal_reason_code = 'active_credential_already_exists' then
      select * into v_existing_credential from public.qr_credentials where id = v_op.terminal_related_credential_id;
      v_result.credential_id := v_existing_credential.id;
      v_result.status := v_existing_credential.status;
      v_result.issued_at := v_existing_credential.issued_at;
    end if;
    return v_result;
  end if;

  if v_op.status <> 'pending' then
    -- Unsupported/unknown status — never guess. Same safe conflict
    -- outcome finalizers already use for an unrecognized state.
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  -- Pending-operation shape checks: this finalizer handles ISSUANCE
  -- only. A reissue operation reaching this function would be a caller
  -- bug (Node calling the wrong finalizer for the operation's own
  -- recorded type) — rejected as an exception, not a lifecycle outcome,
  -- since it can never legitimately happen through the approved
  -- Node-side flow.
  if v_op.operation_type <> 'issue' then
    raise exception 'finalize_qr_issuance_for_server called for a non-issue operation';
  end if;
  if v_op.expected_current_credential_id is not null then
    raise exception 'issuance operation unexpectedly carries a non-null expected_current_credential_id';
  end if;
  if v_op.channel not in ('participant_self_service', 'staff_individual', 'staff_bulk') then
    raise exception 'issuance operation carries an unrecognized channel';
  end if;
  if v_op.application_id is null or v_op.requested_by_auth_user_id is null then
    raise exception 'issuance operation is missing required durable requester/application information';
  end if;
  -- Channel/batch-binding consistency: never silently ignore an
  -- unexpected combination. staff_bulk MUST carry a non-null
  -- bulk_batch_id; every other channel MUST carry a null one — exactly
  -- mirroring qr_lifecycle_operations_bulk_batch_matches_channel's own
  -- invariant, restated here as a controlled internal-invariant check
  -- rather than trusted blindly (a row reaching this function that
  -- somehow violates its own table constraint would indicate a real bug
  -- elsewhere, not a business outcome to guess about).
  if v_op.channel = 'staff_bulk' and v_op.bulk_batch_id is null then
    raise exception 'staff_bulk issuance operation is missing its required bulk_batch_id';
  end if;
  if v_op.channel <> 'staff_bulk' and v_op.bulk_batch_id is not null then
    raise exception 'non-staff_bulk issuance operation unexpectedly carries a bulk_batch_id';
  end if;

  -- TWO-STAGE TTL CHECK (this round's correction, alongside the batch-
  -- lock reordering below): an EARLY check, immediately after the
  -- operation lock, avoids taking any further lock (batch, application,
  -- credential) for an operation that is already expired — no reason to
  -- lock rows this call will never touch. This does NOT replace the
  -- authoritative recheck after every required lock is held (below) —
  -- clock_timestamp() can advance arbitrarily far while THIS call itself
  -- waits on the batch/application/credential locks, so the operation
  -- could still expire during that wait even though this early check
  -- passed.
  if v_op.expires_at <= clock_timestamp() then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_transition_now, terminal_reason_code = 'ttl_expired'
    where id = v_op.id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  -- Position 2: durable bulk-batch row, FOR SHARE, ONLY for staff_bulk —
  -- locked immediately after the operation lock (and the early TTL
  -- check, which takes no lock of its own), BEFORE the application lock,
  -- and held for the remainder of this transaction (never released
  -- early) so a concurrent batch completion/cancellation is blocked
  -- until this finalization commits or rolls back. No pre-lock read of
  -- authoritative batch state occurs anywhere above this line. The batch
  -- row is selected and locked here, but NO business outcome
  -- (bulk_batch_unavailable or otherwise) is returned yet — every
  -- pending-path business decision, including this one, is evaluated
  -- together, in the approved TTL-first order, only after every required
  -- lock (batch, application, credential) is held.
  if v_op.channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches where id = v_op.bulk_batch_id for share;
  end if;

  -- Position 3: application row, FOR UPDATE.
  select * into v_app from public.applications where id = v_op.application_id for update;

  -- Position 4: current active credential row, FOR UPDATE.
  select * into v_current_active from public.qr_credentials
    where application_id = v_op.application_id and status = 'active' for update;

  -- Position 5: encryption-key registry row, FOR SHARE, via the shared
  -- helper (which itself takes this exact lock). CORRECTED this round:
  -- the authoritative timestamp used for the TTL recheck and every
  -- pending-path decision was previously captured immediately after
  -- position 4 — BEFORE this lock — leaving a gap where the operation
  -- could expire while THIS call itself waited to acquire the
  -- key-registry row, and still be finalized/rejected using a stale
  -- pre-wait timestamp. The key-active result is stored here in
  -- v_key_is_active WITHOUT yet deciding anything; the authoritative
  -- v_now below is captured only AFTER this lock, and every decision —
  -- including the key-version-active outcome, now evaluated last in the
  -- approved precedence rather than the moment its lock is acquired — is
  -- made from that single, final timestamp. Identical narrow correction
  -- to the one applied to finalize_qr_reissue_for_server this same
  -- round; this genuine defect was discovered only after this
  -- function's own earlier static approval, and no other logic in this
  -- function is touched.
  v_key_is_active := public.is_encryption_key_version_active(p_encryption_key_version);

  -- ONE authoritative timestamp, captured only after every required lock
  -- (through position 5) is held — reused for every timestamp field this
  -- finalizer writes from here on, AND for the authoritative TTL
  -- recheck below, which must win over every other business decision
  -- (requester authorization, batch availability, application
  -- eligibility, credential conflict, key-version-active) exactly as the
  -- early check's own comment states: this call's own wait on every lock
  -- above may itself have taken long enough for the operation to expire
  -- since the early check passed.
  v_now := clock_timestamp();

  -- Decision 1: TTL, rechecked authoritatively now that every required
  -- lock is held.
  if v_op.expires_at <= v_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_now, terminal_reason_code = 'ttl_expired'
    where id = v_op.id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  -- Decision 2: application eligibility. The batch row (for staff_bulk)
  -- was already locked at position 2 above, but its OWN business
  -- decision is evaluated later, at decision 4 below, preserving the
  -- exact approved precedence order (TTL -> application ->
  -- requester-authorization -> batch -> credential-conflict) — locking
  -- early (to close the race the batch could otherwise be mutated
  -- through) is independent of, and does not change, WHEN each decision
  -- is allowed to return a result.
  if v_app.id is null or v_app.status <> 'accepted' then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'application_ineligible'
    where id = v_op.id;
    v_result.outcome := 'application_ineligible';
    return v_result;
  end if;

  -- Decision 3: staff-channel requester authorization, re-verified at
  -- finalization time — a staff member's role can lapse in the window
  -- between reservation and finalization, and the operation must not be
  -- finalized on their behalf once that has happened.
  if v_op.channel in ('staff_individual', 'staff_bulk') then
    select role into v_caller_role from public.profiles where id = v_op.requested_by_auth_user_id;
    if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'requester_no_longer_authorized'
      where id = v_op.id;
      v_result.outcome := 'requester_no_longer_authorized';
      return v_result;
    end if;
  end if;

  -- Decision 4: staff_bulk batch availability — the row was already
  -- locked at position 2, above (immediately after the operation lock,
  -- before the application/credential locks); this is simply the first
  -- point in the approved DECISION precedence at which a business
  -- outcome based on that already-held lock may be returned.
  if v_op.channel = 'staff_bulk' then
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= v_now
       or v_batch.intended_operation_type <> 'issue'
       or v_batch.created_by_auth_user_id is distinct from v_op.requested_by_auth_user_id
       or v_batch.created_by_profile_id is distinct from v_op.requested_by_profile_id
    then
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = v_op.id;
      v_result.outcome := 'bulk_batch_unavailable';
      return v_result;
    end if;
  end if;

  -- Decision 5: active-credential conflict — never create a second
  -- active credential for the same application.
  if v_current_active.id is not null then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'active_credential_already_exists',
        terminal_related_credential_id = v_current_active.id
    where id = v_op.id;
    v_result.outcome := 'active_credential_already_exists';
    v_result.credential_id := v_current_active.id;
    v_result.status := v_current_active.status;
    v_result.issued_at := v_current_active.issued_at;
    return v_result;
  end if;

  -- Decision 6: encryption-key version active state — the lock was
  -- already acquired at position 5, above; the result computed there
  -- (v_key_is_active) is evaluated LAST among all pending-path
  -- validations, per the approved order — a missing, decrypt_only, or
  -- retired key is the one RETRYABLE outcome: the operation remains
  -- pending, never cancelled/expired/consumed, since Node can simply
  -- re-fetch the current active key version and retry with fresh crypto
  -- material against this SAME operation before its TTL elapses.
  if not v_key_is_active then
    v_result.outcome := 'key_version_not_active';
    return v_result; -- operation remains pending, untouched
  end if;

  -- Canonical fingerprint, computed ONLY through the shared helper — no
  -- ad-hoc format. Domain-separated for issuance
  -- ('rcoy:qr-finalization:v1' + 'issue'), binding credential id, token
  -- hash, token version, encryption-key version, and a digest of the
  -- ciphertext envelope.
  v_fingerprint := public.compute_qr_finalization_fingerprint(
    'issue', p_credential_id, p_token_hash, p_token_version, p_encryption_key_version, p_token_ciphertext
  );

  -- The credential insert, lifecycle consumed-transition, and success
  -- audit insert are atomic: all three happen inside this one inner
  -- exception block, and either all commit together or (on any
  -- exception, including a caught unique_violation re-raised as a
  -- controlled outcome) all roll back together, leaving the operation's
  -- OUTER row lock (acquired at position 1, still held across this whole
  -- function) available so the function can still return a controlled,
  -- safe result even when the insert itself fails. The lifecycle
  -- operation is never marked consumed before the credential row, its
  -- fingerprint, and every success invariant have already been
  -- persisted.
  begin
    insert into public.qr_credentials (
      id, application_id, token_hash, token_ciphertext, token_version, encryption_key_version,
      status, issuance_channel, issuance_reason_code, issuance_note,
      issued_at, created_at, issued_by
    ) values (
      p_credential_id, v_op.application_id, p_token_hash, p_token_ciphertext, p_token_version, p_encryption_key_version,
      'active', v_op.channel, v_op.reason_code, v_op.note,
      v_now, v_now,
      -- Actor semantics: participant_self_service -> null; staff_individual/
      -- staff_bulk -> the operation's own durable requested_by_profile_id
      -- (never the service-role identity, never re-resolved from
      -- auth.uid() — there is no authenticated client session inside this
      -- SECURITY DEFINER, service-role-only function; the ONLY trustworthy
      -- staff actor identity available here is the one the reservation RPC
      -- already durably recorded).
      case when v_op.channel = 'participant_self_service' then null else v_op.requested_by_profile_id end
    );

    update public.qr_lifecycle_operations
    set status = 'consumed', consumed_at = v_now, finalized_at = v_now,
        resulting_credential_id = p_credential_id, finalization_fingerprint = v_fingerprint,
        terminal_reason_code = null, terminal_related_credential_id = null, terminal_retry_after_at = null
    where id = v_op.id;

    -- Safe metadata only — never token hash, ciphertext, nonce, key
    -- material, or fingerprint.
    insert into public.audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, created_at)
    values (
      'qr_credential', p_credential_id, 'issued',
      (case when v_op.channel = 'participant_self_service' then 'system' else 'admin' end)::audit_actor_type,
      case when v_op.channel = 'participant_self_service' then v_op.requested_by_auth_user_id else v_op.requested_by_profile_id end,
      jsonb_build_object('application_id', v_op.application_id, 'issuance_channel', v_op.channel, 'issuance_reason_code', v_op.reason_code),
      v_now
    );
  exception
    when unique_violation then
      declare
        v_constraint_name text;
        v_conflicting_credential public.qr_credentials;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name = 'qr_credentials_token_hash_unique' then
          -- The token hash already belongs to a DIFFERENT, already-
          -- inserted credential row — a Node-side random-generation
          -- collision or a genuine concurrent-finalizer race on the same
          -- hash. The operation remains pending (retryable with fresh
          -- input); no partial credential, no success audit row (this
          -- whole block rolled back together).
          v_result.outcome := 'token_hash_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_credentials_pkey' then
          -- p_credential_id collides with an existing row belonging to a
          -- DIFFERENT operation entirely (this operation's own resulting_
          -- credential_id is still null at this point in the flow, since
          -- the UPDATE above never committed) — resolve safely rather
          -- than expose the raw violation.
          select * into v_conflicting_credential from public.qr_credentials where id = p_credential_id;
          if v_conflicting_credential.id is not null and v_conflicting_credential.status = 'active'
             and v_conflicting_credential.application_id = v_op.application_id then
            -- The conflicting row IS this exact application's active
            -- credential — safe to resolve as the same controlled
            -- conflict outcome the pre-lock check above would have
            -- produced, identifying the credential rather than exposing
            -- a raw error.
            v_result.outcome := 'active_credential_already_exists';
            v_result.credential_id := v_conflicting_credential.id;
            v_result.status := v_conflicting_credential.status;
            v_result.issued_at := v_conflicting_credential.issued_at;
            return v_result;
          end if;
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_lifecycle_operations_resulting_credential_unique_idx' then
          -- p_credential_id is already recorded as the RESULT of a
          -- different lifecycle operation — never legitimate for a fresh
          -- issuance.
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        else
          raise;
        end if;
      end;
  end;

  v_result.outcome := 'issued';
  v_result.credential_id := p_credential_id;
  v_result.status := 'active';
  v_result.issued_at := v_now;
  return v_result;
end;
$$;

revoke all on function public.finalize_qr_issuance_for_server(uuid, uuid, bytea, bytea, smallint, smallint) from public, anon, authenticated;
grant execute on function public.finalize_qr_issuance_for_server(uuid, uuid, bytea, bytea, smallint, smallint) to service_role;

create or replace function public.finalize_qr_reissue_for_server(
  p_operation_id uuid,
  p_new_credential_id uuid,
  p_new_token_hash bytea,
  p_new_token_ciphertext bytea,
  p_new_token_version smallint,
  p_new_encryption_key_version smallint
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_op public.qr_lifecycle_operations;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_caller_role text;
  v_batch public.qr_bulk_operation_batches;
  v_key_is_active boolean;
  v_now timestamptz;
  v_transition_now timestamptz;
  v_fingerprint bytea;
  v_existing_credential public.qr_credentials;
  v_result public.qr_credential_lifecycle_result;
begin
  -- Input-shape validation BEFORE any lock is taken — malformed input is
  -- rejected as an exception, never represented as a lifecycle-result
  -- outcome, exactly mirroring the issuance finalizer's own discipline.
  if p_operation_id is null then raise exception 'operation_id is required'; end if;
  if p_new_credential_id is null then raise exception 'new_credential_id is required'; end if;
  if p_new_token_hash is null or octet_length(p_new_token_hash) <> 32 then
    raise exception 'new_token_hash must be exactly 32 bytes';
  end if;
  if p_new_token_ciphertext is null or octet_length(p_new_token_ciphertext) <> 61 then
    raise exception 'new_token_ciphertext must be exactly 61 bytes';
  end if;
  if get_byte(p_new_token_ciphertext, 0) <> 1 then
    raise exception 'Unsupported ciphertext envelope version';
  end if;
  if p_new_token_version is null or p_new_token_version not between 1 and 32767 then
    raise exception 'Invalid new_token_version';
  end if;
  if p_new_encryption_key_version is null or p_new_encryption_key_version not between 1 and 32767 then
    raise exception 'Invalid new_encryption_key_version';
  end if;

  -- Position 1: lifecycle operation row, FOR UPDATE, locked and
  -- inspected FIRST, before any other row.
  select * into v_op from public.qr_lifecycle_operations where id = p_operation_id for update;
  if v_op.id is null then raise exception 'Lifecycle operation not found'; end if;

  -- The new credential id must differ from the operation's own durable
  -- expected_current_credential_id — checked here, against the
  -- OPERATION's own recorded value (not any later-read live state),
  -- since it is available immediately once the operation is locked and
  -- is true for every legitimate call regardless of historical/pending
  -- status.
  if v_op.expected_current_credential_id is not null and p_new_credential_id = v_op.expected_current_credential_id then
    raise exception 'new_credential_id must differ from expected_current_credential_id';
  end if;

  -- Historical states handled FIRST, before any further lock —
  -- 'consumed'/'expired'/'cancelled' are all fully resolved by the
  -- operation row alone.
  if v_op.status = 'consumed' then
    -- Idempotent replay: recompute the SAME canonical fingerprint from
    -- THIS call's supplied inputs (domain 'reissue') and compare against
    -- the durably stored one — never re-derived from the current
    -- qr_credentials row. CORRECTED this round: the replayed RESULT
    -- itself must ALSO never be derived from the current qr_credentials
    -- row — a resulting credential may later become revoked or replaced,
    -- and exact finalizer replay must not change because of that later
    -- lifecycle transition. Every field returned here comes exclusively
    -- from the durable qr_lifecycle_operations row: credential_id from
    -- resulting_credential_id, status hardcoded to 'active' (the state at
    -- the successful finalization transition, never re-queried), and
    -- issued_at from finalized_at (guaranteed equal to the new
    -- credential's own issued_at at the moment of that same transition).
    -- This branch no longer depends on the resulting credential row still
    -- being queryable, its current status, its ciphertext, its current
    -- encryption-key version, or any later revocation/replacement field.
    v_fingerprint := public.compute_qr_finalization_fingerprint(
      'reissue', p_new_credential_id, p_new_token_hash, p_new_token_version, p_new_encryption_key_version, p_new_token_ciphertext
    );
    if v_fingerprint = v_op.finalization_fingerprint and p_new_credential_id = v_op.resulting_credential_id then
      v_result.outcome := 'already_finalized';
      v_result.credential_id := v_op.resulting_credential_id;
      v_result.status := 'active';
      v_result.issued_at := v_op.finalized_at;
      return v_result;
    end if;
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  if v_op.status = 'expired' then
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  if v_op.status = 'cancelled' then
    -- Replay the durable terminal outcome without re-evaluating current
    -- state — identical discipline to every reservation RPC's own
    -- replay_cancelled path and the issuance finalizer's own replay.
    -- CORRECTED this round: terminal_related_credential_id is permitted
    -- ONLY for 'active_credential_already_exists' by the approved
    -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
    -- (§1.7) — 'expected_credential_changed' always leaves it null, so no
    -- lookup through it is ever performed here. This finalizer has no
    -- cancellation reason that uses terminal_related_credential_id at
    -- all (active_credential_already_exists is a defense-in-depth
    -- constraint-collision outcome for reissue, never a pending-path
    -- cancellation reason set by this function); the stable outcome name
    -- alone is always sufficient to replay 'expected_credential_changed'.
    v_result.outcome := v_op.terminal_reason_code;
    return v_result;
  end if;

  if v_op.status <> 'pending' then
    -- Unsupported/unknown status — never guess. Same safe conflict
    -- outcome finalizers already use for an unrecognized state.
    v_result.outcome := 'idempotency_conflict';
    return v_result;
  end if;

  -- Pending-operation shape checks: this finalizer handles REISSUE only.
  -- An issue operation reaching this function would be a caller bug
  -- (Node calling the wrong finalizer for the operation's own recorded
  -- type) — rejected as an exception, not a lifecycle outcome, since it
  -- can never legitimately happen through the approved Node-side flow.
  if v_op.operation_type <> 'reissue' then
    raise exception 'finalize_qr_reissue_for_server called for a non-reissue operation';
  end if;
  if v_op.expected_current_credential_id is null then
    raise exception 'reissue operation is missing its required expected_current_credential_id';
  end if;
  if v_op.channel not in ('participant_self_service', 'staff_individual', 'staff_bulk') then
    raise exception 'reissue operation carries an unrecognized channel';
  end if;
  if v_op.application_id is null or v_op.requested_by_auth_user_id is null then
    raise exception 'reissue operation is missing required durable requester/application information';
  end if;
  -- Channel/batch-binding consistency — identical internal-invariant
  -- check to the issuance finalizer's own.
  if v_op.channel = 'staff_bulk' and v_op.bulk_batch_id is null then
    raise exception 'staff_bulk reissue operation is missing its required bulk_batch_id';
  end if;
  if v_op.channel <> 'staff_bulk' and v_op.bulk_batch_id is not null then
    raise exception 'non-staff_bulk reissue operation unexpectedly carries a bulk_batch_id';
  end if;

  -- TWO-STAGE TTL CHECK, stage one: an EARLY check runs immediately
  -- after the operation lock, before any further lock is taken — an
  -- already-expired operation never touches the batch/application/
  -- credential locks at all.
  if v_op.expires_at <= clock_timestamp() then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_transition_now, terminal_reason_code = 'ttl_expired'
    where id = v_op.id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  -- Position 2: durable bulk-batch row, FOR SHARE, ONLY for staff_bulk —
  -- locked here, but NO business outcome is returned yet; every
  -- pending-path business decision is evaluated together, in the
  -- approved order, only after every required lock (through position 5)
  -- is held.
  if v_op.channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches where id = v_op.bulk_batch_id for share;
  end if;

  -- Position 3: application row, FOR UPDATE.
  select * into v_app from public.applications where id = v_op.application_id for update;

  -- Position 4: current active credential row, FOR UPDATE — selected
  -- ONLY by application_id + status = 'active'; never a caller-supplied
  -- "old credential" row or actor identity.
  select * into v_current_active from public.qr_credentials
    where application_id = v_op.application_id and status = 'active' for update;

  -- Position 5: encryption-key registry row, FOR SHARE, via the shared
  -- helper (which itself takes this exact lock). CORRECTED this round:
  -- the authoritative timestamp used for the TTL recheck and every
  -- pending-path decision was previously captured immediately after
  -- position 4 — BEFORE this lock — leaving a gap where the operation
  -- could expire while THIS call itself waited to acquire the
  -- key-registry row, and still be finalized/rejected using a stale
  -- pre-wait timestamp. The key-active result is stored here in
  -- v_key_is_active WITHOUT yet deciding anything; the authoritative
  -- v_now below is captured only AFTER this lock, and every decision —
  -- including this key-version-active outcome, now evaluated last in the
  -- approved precedence rather than the moment its lock is acquired — is
  -- made from that single, final timestamp. This exactly mirrors the
  -- identical narrow correction applied to finalize_qr_issuance_for_server
  -- this same round.
  v_key_is_active := public.is_encryption_key_version_active(p_new_encryption_key_version);

  -- ONE authoritative timestamp, captured only after every required lock
  -- (through position 5) is held — reused for every timestamp field this
  -- finalizer writes from here on, AND for the authoritative TTL
  -- recheck below (stage two), which must win over every other business
  -- decision.
  v_now := clock_timestamp();

  -- Decision 1: TTL, rechecked authoritatively now that every required
  -- lock is held.
  if v_op.expires_at <= v_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_now, terminal_reason_code = 'ttl_expired'
    where id = v_op.id;
    v_result.outcome := 'operation_expired';
    return v_result;
  end if;

  -- Decision 2: application eligibility.
  if v_app.id is null or v_app.status <> 'accepted' then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'application_ineligible'
    where id = v_op.id;
    v_result.outcome := 'application_ineligible';
    return v_result;
  end if;

  -- Decision 3: staff-channel requester authorization, re-verified at
  -- finalization time.
  if v_op.channel in ('staff_individual', 'staff_bulk') then
    select role into v_caller_role from public.profiles where id = v_op.requested_by_auth_user_id;
    if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'requester_no_longer_authorized'
      where id = v_op.id;
      v_result.outcome := 'requester_no_longer_authorized';
      return v_result;
    end if;
  end if;

  -- Decision 4: staff_bulk batch availability — the row was already
  -- locked at position 2, above (immediately after the operation lock,
  -- before the application/credential/key locks); this is simply the
  -- first point in the approved decision precedence at which a business
  -- outcome based on that already-held lock may be returned.
  if v_op.channel = 'staff_bulk' then
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= v_now
       or v_batch.intended_operation_type <> 'reissue'
       or v_batch.created_by_auth_user_id is distinct from v_op.requested_by_auth_user_id
       or v_batch.created_by_profile_id is distinct from v_op.requested_by_profile_id
    then
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = v_op.id;
      v_result.outcome := 'bulk_batch_unavailable';
      return v_result;
    end if;
  end if;

  -- Decision 5: no active credential exists at all — reissue's own
  -- credential-existence requirement (the inverse of issuance's
  -- "active-credential-already-exists" conflict).
  if v_current_active.id is null then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'no_active_credential'
    where id = v_op.id;
    v_result.outcome := 'no_active_credential';
    return v_result;
  end if;

  -- Decision 6: the active credential does not match the operation's own
  -- durable expected_current_credential_id. CORRECTED this round:
  -- terminal_related_credential_id is permitted ONLY for
  -- 'active_credential_already_exists' by the approved
  -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
  -- (§1.7) — it must remain null here. The stable outcome name alone
  -- (with no credential_id/status/issued_at) is the entire durable
  -- result; a fresh caller who wants to know the current active
  -- credential can simply reserve a new reissue operation, which itself
  -- re-reads live state.
  if v_current_active.id <> v_op.expected_current_credential_id then
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_now, terminal_reason_code = 'expected_credential_changed',
        terminal_related_credential_id = null
    where id = v_op.id;
    v_result.outcome := 'expected_credential_changed';
    return v_result;
  end if;

  -- Decision 7: encryption-key version active state — the lock was
  -- already acquired at position 5, above; the result computed there
  -- (v_key_is_active) is evaluated LAST among all pending-path
  -- validations, per the approved order — a missing, decrypt_only, or
  -- retired key is the one RETRYABLE outcome: the operation remains
  -- pending, untouched, and neither the old credential nor audit history
  -- is modified.
  if not v_key_is_active then
    v_result.outcome := 'key_version_not_active';
    return v_result; -- operation remains pending, old credential remains active, untouched
  end if;

  -- Canonical fingerprint, computed ONLY through the shared helper — no
  -- ad-hoc format. Domain-separated for reissue ('rcoy:qr-finalization:v1'
  -- + 'reissue'), binding the NEW credential id, new token hash, new
  -- token version, new encryption-key version, and a digest of the new
  -- ciphertext envelope.
  v_fingerprint := public.compute_qr_finalization_fingerprint(
    'reissue', p_new_credential_id, p_new_token_hash, p_new_token_version, p_new_encryption_key_version, p_new_token_ciphertext
  );

  -- The old-credential replacement, new-credential insert, deferred-FK
  -- IMMEDIATE check, lifecycle consumed-transition, and success audit
  -- insert are ALL atomic: everything happens inside this one inner
  -- exception block, and either all commit together or (on any
  -- exception, including a caught unique_violation re-raised as a
  -- controlled outcome, or a caught foreign_key_violation from the
  -- forced-IMMEDIATE deferred constraint check) all roll back together
  -- — it is unacceptable for the OLD credential to become unusable
  -- (replaced) while the NEW credential's creation fails; both the
  -- active-to-replaced UPDATE and the new-row INSERT below are inside
  -- this SAME block precisely so a failure at any point rolls both back
  -- as one unit, leaving the OLD credential exactly as it was
  -- ('active', untouched) and the operation still 'pending' (retryable).
  --
  -- Order is REQUIRED, not arbitrary: the old row must leave 'active'
  -- status BEFORE the new row can become 'active' (satisfying
  -- qr_credentials_one_active_per_application, a same-statement
  -- non-deferrable partial unique index with no ordering flexibility) —
  -- so the UPDATE runs first. The deferred composite FK
  -- (qr_credentials_replacement_same_application_fkey) is what makes
  -- this legal despite the OLD row's UPDATE referencing a
  -- replaced_by_credential_id (p_new_credential_id) that does not exist
  -- yet at the moment of that UPDATE — the FK's referential check is
  -- deferred to (at latest) COMMIT, by which point the INSERT below has
  -- already made the referenced row exist.
  declare
    v_constraint_name text;
  begin
    update public.qr_credentials
    set status = 'replaced', token_ciphertext = null, encryption_key_version = null,
        replaced_at = v_now, replaced_by_credential_id = p_new_credential_id,
        reissue_channel = v_op.channel, reissue_reason_code = v_op.reason_code, reissue_note = v_op.note,
        -- Actor semantics for the OLD credential: participant_self_service
        -- -> null; staff_individual/staff_bulk -> the operation's own
        -- durable requested_by_profile_id (never the service-role
        -- identity, never re-resolved from any authenticated session —
        -- none exists inside this service-role-only function).
        replaced_by = case when v_op.channel = 'participant_self_service' then null else v_op.requested_by_profile_id end
    where id = v_current_active.id;

    insert into public.qr_credentials (
      id, application_id, token_hash, token_ciphertext, token_version, encryption_key_version,
      status, issuance_channel, issuance_reason_code, issuance_note,
      issued_at, created_at, issued_by
    ) values (
      p_new_credential_id, v_op.application_id, p_new_token_hash, p_new_token_ciphertext, p_new_token_version, p_new_encryption_key_version,
      'active', v_op.channel,
      -- The NEW credential's own issuance_reason_code/issuance_note are
      -- ALWAYS null for a reissue — there is no "reissued_credential"
      -- value in the approved issuance-reason vocabulary, and inventing
      -- one is explicitly out of scope. The reissue's own reason/note
      -- live durably on the OLD (now-replaced) credential's
      -- reissue_reason_code/reissue_note, set above, never here.
      null, null,
      v_now, v_now,
      case when v_op.channel = 'participant_self_service' then null else v_op.requested_by_profile_id end
    );

    -- Force the deferred same-application replacement FK to IMMEDIATE
    -- and let it actually run its check HERE, inside this controlled
    -- block, rather than silently at COMMIT after this RPC has already
    -- returned a result to the caller. SET CONSTRAINTS is transaction-
    -- scoped and affects only the remainder of THIS transaction (which
    -- ends when this function returns and its caller's own transaction
    -- boundary completes — for a service-role RPC call, that is this
    -- statement's own implicit transaction).
    set constraints public.qr_credentials_replacement_same_application_fkey immediate;

    update public.qr_lifecycle_operations
    set status = 'consumed', consumed_at = v_now, finalized_at = v_now,
        resulting_credential_id = p_new_credential_id, finalization_fingerprint = v_fingerprint,
        terminal_reason_code = null, terminal_related_credential_id = null, terminal_retry_after_at = null
    where id = v_op.id;

    -- Safe metadata only — never token hash, ciphertext, nonce, key
    -- material, or fingerprint.
    insert into public.audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, created_at)
    values (
      'qr_credential', p_new_credential_id, 'reissued',
      (case when v_op.channel = 'participant_self_service' then 'system' else 'admin' end)::audit_actor_type,
      case when v_op.channel = 'participant_self_service' then v_op.requested_by_auth_user_id else v_op.requested_by_profile_id end,
      jsonb_build_object(
        'application_id', v_op.application_id, 'old_credential_id', v_current_active.id,
        'new_credential_id', p_new_credential_id, 'reissue_channel', v_op.channel,
        'reissue_reason_code', v_op.reason_code
      ),
      v_now
    );
  exception
    when unique_violation then
      declare
        v_conflicting_credential public.qr_credentials;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name = 'qr_credentials_token_hash_unique' then
          -- The new token hash already belongs to a DIFFERENT,
          -- already-inserted credential row. The operation remains
          -- pending (retryable with fresh input); the OLD credential's
          -- active-to-replaced UPDATE rolls back together with the
          -- failed INSERT, so the old credential remains active,
          -- unchanged; no new credential, no success audit row.
          v_result.outcome := 'token_hash_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_credentials_pkey' then
          -- p_new_credential_id collides with an existing row belonging
          -- to a DIFFERENT operation entirely.
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_credentials_replacement_target_unique' then
          -- p_new_credential_id is already recorded as the
          -- replaced_by_credential_id of a DIFFERENT old credential row
          -- — never legitimate for a fresh reissue targeting THIS old
          -- credential.
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_credentials_one_active_per_application' then
          -- The old-row UPDATE above should have already freed this
          -- application's active slot before the INSERT ever ran — a
          -- violation here means a DIFFERENT active credential appeared
          -- for this application between this transaction's own
          -- position-4 lock and this exact statement (should be
          -- structurally impossible under that lock, but resolved
          -- safely rather than exposing a raw violation, per the
          -- approved defense-in-depth discipline used throughout this
          -- design). Re-inspect authoritatively rather than guess.
          select * into v_conflicting_credential from public.qr_credentials
            where application_id = v_op.application_id and status = 'active';
          if v_conflicting_credential.id is not null then
            v_result.outcome := 'active_credential_already_exists';
            v_result.credential_id := v_conflicting_credential.id;
            v_result.status := v_conflicting_credential.status;
            v_result.issued_at := v_conflicting_credential.issued_at;
            return v_result;
          end if;
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        elsif v_constraint_name = 'qr_lifecycle_operations_resulting_credential_unique_idx' then
          -- p_new_credential_id is already recorded as the RESULT of a
          -- different lifecycle operation — never legitimate for a
          -- fresh reissue.
          v_result.outcome := 'idempotency_conflict';
          return v_result;
        else
          raise;
        end if;
      end;
    when foreign_key_violation then
      -- CORRECTED this round: previously every foreign_key_violation in
      -- this block was unconditionally mapped to idempotency_conflict —
      -- too broad, since it could silently mask an unrelated integrity
      -- failure (applications, profiles, audit rows, actors, or any
      -- future foreign key touched by this block) behind a misleading
      -- "safe" outcome instead of surfacing the real defect. Only the
      -- ONE expected constraint — the forced-IMMEDIATE deferred
      -- same-application replacement FK
      -- (qr_credentials_replacement_same_application_fkey), checked HERE,
      -- inside this controlled block, never silently at commit after
      -- this RPC has already returned a result — is mapped to a
      -- controlled outcome. This should be structurally unreachable
      -- given the INSERT immediately above always creates a row
      -- satisfying (id, application_id) for the exact application_id the
      -- OLD row's UPDATE just referenced; retained as defense-in-depth,
      -- consistent with every other named-constraint mapping in this
      -- function. Every OTHER foreign_key_violation is re-raised so the
      -- entire outer transaction rolls back and the real defect is never
      -- misreported as a routine idempotency conflict.
      get stacked diagnostics v_constraint_name = constraint_name;
      if v_constraint_name = 'qr_credentials_replacement_same_application_fkey' then
        v_result.outcome := 'idempotency_conflict';
        return v_result;
      end if;
      raise;
  end;

  v_result.outcome := 'reissued';
  v_result.credential_id := p_new_credential_id;
  v_result.status := 'active';
  v_result.issued_at := v_now;
  return v_result;
end;
$$;

revoke all on function public.finalize_qr_reissue_for_server(uuid, uuid, bytea, bytea, smallint, smallint) from public, anon, authenticated;
grant execute on function public.finalize_qr_reissue_for_server(uuid, uuid, bytea, bytea, smallint, smallint) to service_role;
