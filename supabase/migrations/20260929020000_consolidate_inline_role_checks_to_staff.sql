-- 20260929020000_consolidate_inline_role_checks_to_staff.sql
--
-- Task 3 of the staff-role-consolidation plan. Task 1
-- (20260929000001_migrate_staff_profiles_and_add_helper.sql) added
-- is_staff(), a SECURITY DEFINER helper equivalent to
-- current_user_role() in ('staff', 'super_admin'). Task 2
-- (20260929010000_consolidate_rls_policies_to_staff.sql) switched every
-- `create policy` RLS clause that inline-checked a caller's role to use
-- is_staff() instead.
--
-- This migration handles a DIFFERENT category Task 2 did not touch:
-- SECURITY DEFINER RPC function bodies that check the caller's role via
-- an inline plpgsql `if` statement (not a `create policy` clause) —
-- against a variable fetched from public.profiles.role (v_caller_role /
-- v_caller.role), by calling current_user_role() directly, or via a
-- positive-form `role in (...)` direct-table-subquery idiom
-- (`not exists (select 1 from public.profiles where id = ... and role
-- in (...))`). Since these are full function bodies, Postgres offers no
-- way to patch a single `if` statement inside an existing function, so
-- each affected function is reproduced here in full via `create or
-- replace function`, with ONLY the role-check condition changed to use
-- is_staff(). is_staff() already covers super_admin, so the old
-- '(...) not in (''super_admin'', ''program_attendance_manager'')' /
-- '(...) not in (''agenda_allocation_manager'',
-- ''participants_communications_manager'', ''super_admin'')' /
-- 'role in (''super_admin'',''program_attendance_manager'')' conditions
-- all collapse to is_staff() (negated as `not is_staff()` for the
-- negative-form checks, or substituted directly for `role in (...)`
-- inside the positive-form `not exists (...)` checks).
--
-- Functions rewritten here (grouped by source), each taken from its
-- CURRENT (most recently applied) definition, not the migration that
-- first introduced it:
--
--   From 20260805235959_phase6_qr_issuance_reissue.sql (body unchanged
--   since introduction for these three):
--     - request_staff_qr_issuance_transactional_internal  (2 checks)
--     - request_staff_qr_reissue_transactional_internal   (2 checks)
--     - create_qr_bulk_operation_batch_for_server          (1 check,
--       positive-form `role in (...)` inside a `not exists (...)`
--       subquery — a different shape from the other 7 functions'
--       negative-form checks, added after an initial pass on this
--       migration missed it; the original grep pattern set targeted
--       only v_caller_role/current_user_role() shapes and does not
--       match this idiom)
--
--   Current body superseded by 20260811210000_fix_staff_blocker_
--   resolver_channel_check.sql (channel-aware fix applied after Phase 6):
--     - resolve_blocking_qr_lifecycle_staff_issuance_operation (1 check)
--     - resolve_blocking_qr_lifecycle_staff_reissue_operation  (1 check)
--
--   Current body superseded by 20260810000000_fix_qr_finalizer_audit_
--   actor_type_cast.sql (actor_type cast fix applied after Phase 6):
--     - finalize_qr_issuance_for_server (1 check)
--     - finalize_qr_reissue_for_server  (1 check)
--
--   Current body superseded by 20260820140000_add_attendance_
--   confirmation_to_import.sql (itself carrying forward the
--   20260820120000 SECURITY DEFINER + authorization-check fix):
--     - rollback_import_batch_transactional (1 check)
--
-- Confirmed correctly OUT of scope (same source file, checked during a
-- manual skim for the `role in (...)`/`role = '...'` idiom prompted by
-- the above miss — no other occurrence found in any of the 5 reference
-- files beyond the one added above):
--   - retire_encryption_key_version (~line 799): `v_caller.role <>
--     'super_admin'` — intentionally narrower than staff (super_admin
--     only); converting to is_staff() would be a privilege escalation.
--   - qr_bulk_operation_batches_enforce_lifecycle_trigger (~line 889):
--     same `role in ('super_admin', 'program_attendance_manager')`
--     phrase as create_qr_bulk_operation_batch_for_server above, but
--     this one is plain `language plpgsql` with NO `security definer` —
--     RLS/grants apply, not a SECURITY DEFINER authorization boundary,
--     out of scope for this task.
--
-- NOTE on apply_import_row_transactional: 20260820140000 (one of the
-- five files identified during plan review) DOES contain a
-- current_user_role() check at its line 516, but that match belongs to
-- rollback_import_batch_transactional (the SECOND function defined in
-- that file), not to apply_import_row_transactional (the first). The
-- file's own header comment confirms this explicitly: "apply_import_row_
-- transactional is unaffected (never needed SECURITY DEFINER -- it has
-- no DELETE)." Furthermore apply_import_row_transactional's own CURRENT
-- definition lives in the later 20260823010000_wire_participant_type_to_
-- apply_import_row.sql, whose body has no inline role check of any kind
-- (it is plain SECURITY INVOKER, relying on RLS/grants). So
-- apply_import_row_transactional requires no change here.
--
-- Every rewritten function below is byte-for-byte identical to its
-- source definition except for the role-check condition itself (and, in
-- the two request_staff_qr_*_transactional_internal functions, removal
-- of the now-truly-dead nested v_caller_role declare/fetch that fed
-- ONLY that removed condition inside the matching_pending_candidate
-- branch -- the outer v_caller record is used elsewhere in both
-- functions for v_caller.id/v_caller.role and is kept unchanged). No
-- signature, parameter list, return type, security context, lock
-- ordering, or any other business logic is altered.

------------------------------------------------------------------
-- resolve_blocking_qr_lifecycle_staff_issuance_operation
-- Current source: 20260811210000_fix_staff_blocker_resolver_channel_check.sql
-- 1 check changed: v_caller_role fetch + "not in (...)" -> not is_staff()
-- (v_caller_role was used only for this one check; declare + fetch removed)
------------------------------------------------------------------
create or replace function public.resolve_blocking_qr_lifecycle_staff_issuance_operation(
  p_candidate public.qr_lifecycle_operations,
  p_app public.applications,
  out disposition text -- 'still_blocking' | 'terminalized'
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_batch public.qr_bulk_operation_batches;
  v_existing_credential public.qr_credentials;
  v_transition_now timestamptz;
  v_check_now timestamptz;
begin
  -- 1. Requester authorization, re-verified against the CANDIDATE's own
  -- recorded requester — but ONLY for a staff-originated candidate
  -- (staff_individual/staff_bulk). A participant_self_service candidate
  -- has no staff role to lapse and must never be evaluated against staff
  -- role eligibility; it is validated purely by the application/
  -- credential/TTL sequence below, identically to how
  -- resolve_blocking_qr_lifecycle_operation already treats it on the
  -- participant issuance path.
  if p_candidate.channel <> 'participant_self_service' then
    if not is_staff() then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
      where id = p_candidate.id;
      disposition := 'terminalized';
      return;
    end if;
  end if;

  -- 2. Bulk-batch availability, only when this candidate is staff_bulk
  -- (bulk_batch_id is null for staff_individual and participant_self_
  -- service, per qr_lifecycle_operations_bulk_batch_matches_channel —
  -- nothing to validate in either case).
  if p_candidate.channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches
      where id = p_candidate.bulk_batch_id for share;
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= clock_timestamp()
       or v_batch.intended_operation_type <> 'issue'
       or v_batch.created_by_auth_user_id is distinct from p_candidate.requested_by_auth_user_id
       or v_batch.created_by_profile_id is distinct from p_candidate.requested_by_profile_id
    then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = p_candidate.id;
      disposition := 'terminalized';
      return;
    end if;
  end if;

  -- 3. Application eligibility (no credential lock needed for this
  -- determination — mirrors both participant resolvers' identical
  -- precedence).
  if p_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 4. Credential lock BEFORE the TTL decision, matching every other
  -- resolver's precedence exactly.
  select * into v_existing_credential from public.qr_credentials
    where application_id = p_app.id and status = 'active' for update;

  -- 5. TTL checked immediately after the credential lock — expiry wins
  -- over every finding below, including a credential conflict.
  v_check_now := clock_timestamp();
  if p_candidate.expires_at <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 6. Active-credential conflict.
  if v_existing_credential.id is not null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists',
        terminal_related_credential_id = v_existing_credential.id
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  disposition := 'still_blocking';
  return;
end;
$$;

------------------------------------------------------------------
-- resolve_blocking_qr_lifecycle_staff_reissue_operation
-- Current source: 20260811210000_fix_staff_blocker_resolver_channel_check.sql
-- 1 check changed: v_caller_role fetch + "not in (...)" -> not is_staff()
-- (v_caller_role was used only for this one check; declare + fetch removed)
------------------------------------------------------------------
create or replace function public.resolve_blocking_qr_lifecycle_staff_reissue_operation(
  p_candidate public.qr_lifecycle_operations,
  p_app public.applications,
  out disposition text -- 'still_blocking' | 'terminalized'
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_batch public.qr_bulk_operation_batches;
  v_existing_credential public.qr_credentials;
  v_transition_now timestamptz;
  v_check_now timestamptz;
begin
  -- 1. Requester authorization, re-verified against the CANDIDATE's own
  -- recorded requester — but ONLY for a staff-originated candidate
  -- (staff_individual/staff_bulk). A participant_self_service candidate
  -- has no staff role to lapse and must never be evaluated against staff
  -- role eligibility; it is validated purely by the application/
  -- credential/TTL/expected-credential sequence below, identically to how
  -- resolve_blocking_qr_lifecycle_reissue_operation already treats it on
  -- the participant reissue path.
  if p_candidate.channel <> 'participant_self_service' then
    if not is_staff() then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
      where id = p_candidate.id;
      disposition := 'terminalized';
      return;
    end if;
  end if;

  -- 2. Bulk-batch availability, only when this candidate is staff_bulk.
  -- Identical shape to staff issuance's own batch check, EXCEPT
  -- intended_operation_type must be 'reissue', not 'issue' — an
  -- issue-typed batch can never authorize a reissue reservation.
  if p_candidate.channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches
      where id = p_candidate.bulk_batch_id for share;
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= clock_timestamp()
       or v_batch.intended_operation_type <> 'reissue'
       or v_batch.created_by_auth_user_id is distinct from p_candidate.requested_by_auth_user_id
       or v_batch.created_by_profile_id is distinct from p_candidate.requested_by_profile_id
    then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = p_candidate.id;
      disposition := 'terminalized';
      return;
    end if;
  end if;

  -- 3. Application eligibility (no credential lock needed for this
  -- determination — mirrors every other resolver's identical precedence).
  if p_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 4. Credential lock BEFORE the TTL decision, matching every other
  -- resolver's precedence exactly.
  select * into v_existing_credential from public.qr_credentials
    where application_id = p_app.id and status = 'active' for update;

  -- 5. TTL checked immediately after the credential lock — expiry wins
  -- over any credential-state finding below.
  v_check_now := clock_timestamp();
  if p_candidate.expires_at <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 6. Reissue-specific credential semantics: a MISSING active credential
  -- is terminal.
  if v_existing_credential.id is null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'no_active_credential'
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  -- 7. An active credential exists but does not match the candidate's own
  -- durable expected_current_credential_id — also terminal.
  -- terminal_related_credential_id remains null for expected_credential_
  -- changed per qr_lifecycle_operations_cancelled_is_consistent (§1.7).
  if v_existing_credential.id <> p_candidate.expected_current_credential_id then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed',
        terminal_related_credential_id = null
    where id = p_candidate.id;
    disposition := 'terminalized';
    return;
  end if;

  disposition := 'still_blocking';
  return;
end;
$$;

------------------------------------------------------------------
-- finalize_qr_issuance_for_server
-- Current source: 20260810000000_fix_qr_finalizer_audit_actor_type_cast.sql
-- 1 check changed: v_caller_role fetch + "not in (...)" -> not is_staff()
-- (v_caller_role was used only for this one check; declare + fetch removed)
------------------------------------------------------------------
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
    if not is_staff() then
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

------------------------------------------------------------------
-- finalize_qr_reissue_for_server
-- Current source: 20260810000000_fix_qr_finalizer_audit_actor_type_cast.sql
-- 1 check changed: v_caller_role fetch + "not in (...)" -> not is_staff()
-- (v_caller_role was used only for this one check; declare + fetch removed)
------------------------------------------------------------------
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
    if not is_staff() then
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

------------------------------------------------------------------
-- request_staff_qr_issuance_transactional_internal
-- Current source: 20260805235959_phase6_qr_issuance_reissue.sql (never
-- superseded)
-- 2 checks changed:
--   1. v_caller.role not in (...) -> not is_staff() (v_caller record is
--      used elsewhere in this function for v_caller.id/v_caller.role and
--      is kept unchanged)
--   2. nested v_caller_role fetch + "not in (...)" -> not is_staff()
--      (v_caller_role was used only for this one check; declare + fetch
--      removed)
------------------------------------------------------------------
create or replace function public.request_staff_qr_issuance_transactional_internal(
  p_request_key uuid,
  p_application_id uuid,
  p_issuance_reason_code text,
  p_issuance_note text,
  p_bulk_batch_id uuid,
  p_pending_ttl interval
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller public.profiles;
  v_normalized_note text;
  v_channel text;
  v_batch public.qr_bulk_operation_batches;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_reservation record;
  v_resolution record;
  v_operation_id uuid;
  v_created_at timestamptz;
  v_check_now timestamptz;
  v_transition_now timestamptz;
  v_result public.qr_credential_lifecycle_result;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_request_key is null then raise exception 'request_key is required'; end if;
  if p_application_id is null then raise exception 'application_id is required'; end if;
  if p_pending_ttl is null or p_pending_ttl <= interval '0' then
    raise exception 'p_pending_ttl must be a positive interval';
  end if;

  -- Authorization: derived from auth.uid() alone, never a parameter.
  -- Re-verified again under lock, against the CANDIDATE row's own
  -- recorded requester, inside the resolver above, for every already-
  -- existing pending operation this call might find — this initial check
  -- governs only whether THIS call itself may proceed to create/replay
  -- anything at all.
  select * into v_caller from public.profiles where id = auth.uid();
  if v_caller.id is null or not is_staff() then
    raise exception 'Not authorized';
  end if;

  -- Reason-code/note validation, per §1.4's conditional rules for
  -- staff_individual/staff_bulk issuance: the code must be one of the
  -- four staff codes, never a participant or reissue code.
  -- 'staff_other' requires a non-empty trimmed note. Note normalization —
  -- identical rule applied once, reused for validation, the immutable-
  -- intent comparison, and persistence: null stays null; trimmed-empty
  -- text becomes null; non-empty text is stored trimmed.
  if p_issuance_reason_code is null or p_issuance_reason_code not in (
    'advance_badge_printing', 'participant_not_logged_in', 'bulk_event_preparation', 'staff_other'
  ) then
    raise exception 'A valid staff issuance reason code is required';
  end if;
  v_normalized_note := nullif(trim(p_issuance_note), '');
  if p_issuance_reason_code = 'staff_other' and v_normalized_note is null then
    raise exception 'A note is required when issuance reason is staff_other';
  end if;

  -- Channel is a deterministic function of p_bulk_batch_id alone — no
  -- lock or authoritative batch state is needed to compute it; this is
  -- purely a null-check, used ONLY to shape the reservation's immutable
  -- intent, never to authorize or validate anything about the batch
  -- itself (that happens under lock, at position 4, below).
  v_channel := case when p_bulk_batch_id is null then 'staff_individual' else 'staff_bulk' end;

  -- Positions 1-3: advisory-locked reservation lookup, unchanged shared
  -- helper — operation_type = 'issue', expected_current_credential_id
  -- always null for issuance.
  select * into v_reservation from public.reserve_or_reuse_qr_lifecycle_operation(
    'issue', p_application_id, auth.uid(), p_request_key, v_channel, p_bulk_batch_id,
    p_issuance_reason_code, v_normalized_note, null
  );

  if v_reservation.state = 'request_key_intent_conflict' then
    v_result.outcome := 'request_key_intent_conflict';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'already_consumed' then
    select * into v_current_active from public.qr_credentials
      where id = (v_reservation.op).resulting_credential_id;
    v_result.outcome := 'already_finalized';
    v_result.credential_id := v_current_active.id;
    v_result.status := v_current_active.status;
    v_result.issued_at := v_current_active.issued_at;
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_expired' then
    v_result.outcome := 'operation_expired';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_cancelled' then
    -- Identical replay of ANY previously-cancelled staff issuance
    -- reservation — including requester_no_longer_authorized and
    -- bulk_batch_unavailable — replays the STORED terminal reason,
    -- never re-evaluating current authorization, application, batch, or
    -- credential state for an already-terminal same-key operation.
    v_result.outcome := (v_reservation.op).terminal_reason_code;
    v_result.operation_id := (v_reservation.op).id;
    if (v_reservation.op).terminal_reason_code = 'active_credential_already_exists' then
      select * into v_current_active from public.qr_credentials
        where id = (v_reservation.op).terminal_related_credential_id;
      v_result.credential_id := v_current_active.id;
      v_result.status := v_current_active.status;
      v_result.issued_at := v_current_active.issued_at;
    end if;
    return v_result;
  end if;

  if v_reservation.state = 'other_pending_candidate' then
    -- Delegates to the staff-issuance-specific shared resolver — one copy
    -- of the authorization -> batch -> ineligible -> credential-lock ->
    -- TTL -> credential-conflict sequence, never duplicated between this
    -- path and the exception-recovery path below.
    select * into v_app from public.applications where id = p_application_id;
    select * into v_resolution from public.resolve_blocking_qr_lifecycle_staff_issuance_operation(v_reservation.op, v_app);
    if v_resolution.disposition = 'still_blocking' then
      v_result.outcome := 'another_operation_pending';
      if (v_reservation.op).requested_by_auth_user_id = auth.uid() then
        v_result.operation_id := (v_reservation.op).id;
      end if;
      return v_result;
    end if;
    -- 'terminalized' — falls through to the shared insert-and-resolve
    -- path below, identical to 'no_existing_operation'.
  elsif v_reservation.state = 'matching_pending_candidate' then
    -- Re-evaluate the SAME authoritative conditions the resolver checks,
    -- inline, returning THIS caller's own outcomes
    -- (already_pending/operation_expired/requester_no_longer_authorized/
    -- bulk_batch_unavailable/application_ineligible/
    -- active_credential_already_exists) rather than the resolver's
    -- generic still_blocking/terminalized pair — exactly mirroring both
    -- participant RPCs' identical matching_pending_candidate vs.
    -- other_pending_candidate distinction.
    if not is_staff() then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
      where id = (v_reservation.op).id;
      v_result.outcome := 'requester_no_longer_authorized';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    if (v_reservation.op).channel = 'staff_bulk' then
      select * into v_batch from public.qr_bulk_operation_batches
        where id = (v_reservation.op).bulk_batch_id for share;
      if v_batch.id is null
         or v_batch.status <> 'active'
         or v_batch.expires_at <= clock_timestamp()
         or v_batch.intended_operation_type <> 'issue'
         or v_batch.created_by_auth_user_id is distinct from (v_reservation.op).requested_by_auth_user_id
         or v_batch.created_by_profile_id is distinct from (v_reservation.op).requested_by_profile_id
      then
        v_transition_now := clock_timestamp();
        update public.qr_lifecycle_operations
        set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
        where id = (v_reservation.op).id;
        v_result.outcome := 'bulk_batch_unavailable';
        v_result.operation_id := (v_reservation.op).id;
        return v_result;
      end if;
    end if;

    select * into v_app from public.applications where id = p_application_id for update;
    if v_app.id is null or v_app.status <> 'accepted' then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
      where id = (v_reservation.op).id;
      v_result.outcome := 'application_ineligible';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    select * into v_current_active from public.qr_credentials
      where application_id = v_app.id and status = 'active' for update;

    v_check_now := clock_timestamp();
    if (v_reservation.op).expires_at <= v_check_now then
      update public.qr_lifecycle_operations
      set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
      where id = (v_reservation.op).id;
      v_result.outcome := 'operation_expired';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    if v_current_active.id is not null then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists',
          terminal_related_credential_id = v_current_active.id
      where id = (v_reservation.op).id;
      v_result.outcome := 'active_credential_already_exists';
      v_result.operation_id := (v_reservation.op).id;
      v_result.credential_id := v_current_active.id;
      v_result.status := v_current_active.status;
      v_result.issued_at := v_current_active.issued_at;
      return v_result;
    end if;

    v_result.outcome := 'already_pending';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  -- ===================== 'no_existing_operation' path =====================
  -- (also reached for an 'other_pending_candidate' just terminalized
  -- above, which falls through here identically.)
  --
  -- Authoritative processing order, restated exactly as specified and
  -- implemented step-for-step below:
  --   1. create or reuse the durable lifecycle operation through the
  --      approved request-key protocol (already done above, at positions
  --      1-3 — shared by every state).
  --   2. lock and validate the bulk batch when applicable.
  --   3. lock the target application.
  --   4. lock/query the current active credential.
  --   5. capture a fresh timestamp.
  --   6. if the operation TTL elapsed while waiting, transition to
  --      expired/ttl_expired.
  --   7. if the requester is no longer authorized, cancel with
  --      requester_no_longer_authorized.
  --   8. if the bulk batch is unavailable, cancel with
  --      bulk_batch_unavailable.
  --   9. if the application is missing or no longer accepted, cancel with
  --      application_ineligible.
  --  10. if an active credential exists, cancel with
  --      active_credential_already_exists and persist
  --      terminal_related_credential_id.
  --  11. otherwise return reserved.
  --
  -- No operation row exists yet for THIS request on this path's early
  -- steps — an insert-first-then-validate discipline is used exactly like
  -- both participant RPCs, so every one of the above denials still leaves
  -- its own durable, queryable row rather than a no-row business outcome.
  v_created_at := clock_timestamp();
  begin
    insert into public.qr_lifecycle_operations (
      operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
      channel, bulk_batch_id, request_key, reason_code, note, created_at, expires_at
    ) values (
      'issue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
      p_request_key, p_issuance_reason_code, v_normalized_note, v_created_at, v_created_at + p_pending_ttl
    ) returning id into v_operation_id;
  exception
    when unique_violation then
      declare
        v_constraint_name text;
        v_conflicting public.qr_lifecycle_operations;
        v_conflicting_resolution record;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name <> 'qr_lifecycle_operations_one_pending_per_domain_idx' then
          raise;
        end if;
        select * into v_conflicting from public.qr_lifecycle_operations
          where application_id = p_application_id and operation_type = 'issue' and status = 'pending'
          for update;
        if v_conflicting.id is null then
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, bulk_batch_id, request_key, reason_code, note, created_at, expires_at
          ) values (
            'issue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
            p_request_key, p_issuance_reason_code, v_normalized_note, v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        else
          select * into v_app from public.applications where id = p_application_id;
          select * into v_conflicting_resolution
            from public.resolve_blocking_qr_lifecycle_staff_issuance_operation(v_conflicting, v_app);
          if v_conflicting_resolution.disposition = 'still_blocking' then
            v_result.outcome := 'another_operation_pending';
            if v_conflicting.requested_by_auth_user_id = auth.uid() then
              v_result.operation_id := v_conflicting.id;
            end if;
            return v_result;
          end if;
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, bulk_batch_id, request_key, reason_code, note, created_at, expires_at
          ) values (
            'issue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
            p_request_key, p_issuance_reason_code, v_normalized_note, v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        end if;
      end;
  end;

  -- Step 2: lock and validate the bulk batch, only for staff_bulk —
  -- position 4, BEFORE the application lock (position 5), per the global
  -- order.
  if v_channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches where id = p_bulk_batch_id for share;
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= clock_timestamp()
       or v_batch.intended_operation_type <> 'issue'
       or v_batch.created_by_auth_user_id is distinct from auth.uid()
       or v_batch.created_by_profile_id is distinct from v_caller.id
    then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = v_operation_id;
      v_result.outcome := 'bulk_batch_unavailable';
      v_result.operation_id := v_operation_id;
      return v_result;
    end if;
  end if;

  -- Step 3: lock the target application — position 5.
  select * into v_app from public.applications where id = p_application_id for update;

  -- Step 4: credential lock — position 6.
  select * into v_current_active from public.qr_credentials
    where application_id = p_application_id and status = 'active' for update;

  -- Step 5: fresh timestamp, captured only after every lock above.
  v_check_now := clock_timestamp();

  -- Step 6: TTL, checked first — expiry wins over every finding below.
  if v_created_at + p_pending_ttl <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = v_operation_id;
    v_result.outcome := 'operation_expired';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 7: requester authorization, re-verified under the full lock set
  -- (this call's own auth.uid() cannot itself have changed mid-call, but
  -- this mirrors the identical re-check performed for
  -- matching_pending_candidate/the blocker resolver, so the SAME
  -- authoritative condition is checked at the SAME logical point on every
  -- code path — no path is exempt from re-verifying it here).
  if not is_staff() then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
    where id = v_operation_id;
    v_result.outcome := 'requester_no_longer_authorized';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 8: bulk-batch availability was already fully validated at Step 2,
  -- above, BEFORE the application lock, per the global order — restated
  -- here only as the corresponding numbered step, no further action.

  -- Step 9: application eligibility.
  if v_app.id is null or v_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = v_operation_id;
    v_result.outcome := 'application_ineligible';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 10: active-credential conflict.
  if v_current_active.id is not null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'active_credential_already_exists',
        terminal_related_credential_id = v_current_active.id
    where id = v_operation_id;
    v_result.outcome := 'active_credential_already_exists';
    v_result.operation_id := v_operation_id;
    v_result.credential_id := v_current_active.id;
    v_result.status := v_current_active.status;
    v_result.issued_at := v_current_active.issued_at;
    return v_result;
  end if;

  -- Step 11: every check has passed — the pending row remains genuinely
  -- reserved. Credential creation/revocation/replacement/encryption/
  -- display belongs only to the future issuance finalizer, never this
  -- reservation RPC.
  v_result.outcome := 'reserved';
  v_result.operation_id := v_operation_id;
  return v_result;
end;
$$;

------------------------------------------------------------------
-- request_staff_qr_reissue_transactional_internal
-- Current source: 20260805235959_phase6_qr_issuance_reissue.sql (never
-- superseded)
-- 2 checks changed:
--   1. v_caller.role not in (...) -> not is_staff() (v_caller record is
--      used elsewhere in this function for v_caller.id/v_caller.role and
--      is kept unchanged)
--   2. nested v_caller_role fetch + "not in (...)" -> not is_staff()
--      (v_caller_role was used only for this one check; declare + fetch
--      removed)
------------------------------------------------------------------
create or replace function public.request_staff_qr_reissue_transactional_internal(
  p_request_key uuid,
  p_application_id uuid,
  p_expected_current_credential_id uuid,
  p_reissue_reason_code text,
  p_reissue_note text,
  p_bulk_batch_id uuid,
  p_pending_ttl interval
) returns public.qr_credential_lifecycle_result
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller public.profiles;
  v_normalized_note text;
  v_channel text;
  v_batch public.qr_bulk_operation_batches;
  v_app public.applications;
  v_current_active public.qr_credentials;
  v_reservation record;
  v_resolution record;
  v_operation_id uuid;
  v_created_at timestamptz;
  v_check_now timestamptz;
  v_transition_now timestamptz;
  v_result public.qr_credential_lifecycle_result;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_request_key is null then raise exception 'request_key is required'; end if;
  if p_application_id is null then raise exception 'application_id is required'; end if;
  if p_expected_current_credential_id is null then raise exception 'expected_current_credential_id is required'; end if;
  if p_pending_ttl is null or p_pending_ttl <= interval '0' then
    raise exception 'p_pending_ttl must be a positive interval';
  end if;

  -- Authorization: derived from auth.uid() alone, never a parameter.
  -- Re-verified again under lock, against the CANDIDATE row's own
  -- recorded requester, inside the resolver above, for every already-
  -- existing pending operation this call might find.
  select * into v_caller from public.profiles where id = auth.uid();
  if v_caller.id is null or not is_staff() then
    raise exception 'Not authorized';
  end if;

  -- Reason-code/note validation, per §1.4's conditional rules for staff
  -- force-reissue: the code must be one of the four staff reissue codes,
  -- never a participant code. 'staff_other' requires a non-empty trimmed
  -- note. Note normalization — identical rule applied once, reused for
  -- validation, the immutable-intent comparison, and persistence: null
  -- stays null; trimmed-empty text becomes null; non-empty text is
  -- stored trimmed.
  if p_reissue_reason_code is null or p_reissue_reason_code not in (
    'staff_assisted_recovery', 'suspected_compromise', 'administrative_correction', 'staff_other'
  ) then
    raise exception 'A valid staff reissue reason code is required';
  end if;
  v_normalized_note := nullif(trim(p_reissue_note), '');
  if p_reissue_reason_code = 'staff_other' and v_normalized_note is null then
    raise exception 'A note is required when reissue reason is staff_other';
  end if;

  -- If p_expected_current_credential_id cannot possibly satisfy
  -- qr_lifecycle_operations_expected_credential_fkey's composite
  -- (id, application_id) target — i.e. it does not identify ANY
  -- qr_credentials row belonging to THIS application, active or not —
  -- this is invalid input, rejected before any operation is ever
  -- created, exactly mirroring the participant reissue RPC's identical
  -- check. A credential that belongs to this application but is no
  -- longer active remains legal immutable intent and must produce the
  -- durable expected_credential_changed outcome via a real operation
  -- row, never an input-validation exception.
  if not exists (
    select 1 from public.qr_credentials
    where id = p_expected_current_credential_id and application_id = p_application_id
  ) then
    raise exception 'expected_current_credential_id does not identify a credential belonging to this application';
  end if;

  -- Channel is a deterministic function of p_bulk_batch_id alone — no
  -- lock or authoritative batch state is needed to compute it.
  v_channel := case when p_bulk_batch_id is null then 'staff_individual' else 'staff_bulk' end;

  -- Positions 1-3: advisory-locked reservation lookup, unchanged shared
  -- helper — operation_type = 'reissue'.
  select * into v_reservation from public.reserve_or_reuse_qr_lifecycle_operation(
    'reissue', p_application_id, auth.uid(), p_request_key, v_channel, p_bulk_batch_id,
    p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id
  );

  if v_reservation.state = 'request_key_intent_conflict' then
    v_result.outcome := 'request_key_intent_conflict';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'already_consumed' then
    select * into v_current_active from public.qr_credentials
      where id = (v_reservation.op).resulting_credential_id;
    v_result.outcome := 'already_finalized';
    v_result.credential_id := v_current_active.id;
    v_result.status := v_current_active.status;
    v_result.issued_at := v_current_active.issued_at;
    v_result.replaced_at := v_current_active.replaced_at;
    v_result.revoked_at := v_current_active.revoked_at;
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_expired' then
    v_result.outcome := 'operation_expired';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  if v_reservation.state = 'replay_cancelled' then
    -- Identical replay of ANY previously-cancelled staff reissue
    -- reservation — including requester_no_longer_authorized,
    -- bulk_batch_unavailable, no_active_credential, and
    -- expected_credential_changed — replays the STORED terminal reason,
    -- never re-evaluating current role, batch, application, or
    -- credential state for an already-terminal same-key operation.
    v_result.outcome := (v_reservation.op).terminal_reason_code;
    v_result.operation_id := (v_reservation.op).id;
    if (v_reservation.op).terminal_reason_code = 'expected_credential_changed' then
      select * into v_current_active from public.qr_credentials
        where id = (v_reservation.op).terminal_related_credential_id;
      v_result.credential_id := v_current_active.id;
      v_result.status := v_current_active.status;
      v_result.issued_at := v_current_active.issued_at;
    end if;
    return v_result;
  end if;

  if v_reservation.state = 'other_pending_candidate' then
    -- Delegates to the staff-reissue-specific shared resolver.
    select * into v_app from public.applications where id = p_application_id;
    select * into v_resolution from public.resolve_blocking_qr_lifecycle_staff_reissue_operation(v_reservation.op, v_app);
    if v_resolution.disposition = 'still_blocking' then
      v_result.outcome := 'another_operation_pending';
      if (v_reservation.op).requested_by_auth_user_id = auth.uid() then
        v_result.operation_id := (v_reservation.op).id;
      end if;
      return v_result;
    end if;
    -- 'terminalized' — falls through to the shared insert-and-resolve
    -- path below, identical to 'no_existing_operation'.
  elsif v_reservation.state = 'matching_pending_candidate' then
    -- Re-evaluate the SAME authoritative conditions the resolver checks,
    -- inline, returning THIS caller's own outcomes. No participant
    -- cooldown or rolling-rate-limit check applies anywhere on this
    -- path.
    if not is_staff() then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
      where id = (v_reservation.op).id;
      v_result.outcome := 'requester_no_longer_authorized';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    if (v_reservation.op).channel = 'staff_bulk' then
      select * into v_batch from public.qr_bulk_operation_batches
        where id = (v_reservation.op).bulk_batch_id for share;
      if v_batch.id is null
         or v_batch.status <> 'active'
         or v_batch.expires_at <= clock_timestamp()
         or v_batch.intended_operation_type <> 'reissue'
         or v_batch.created_by_auth_user_id is distinct from (v_reservation.op).requested_by_auth_user_id
         or v_batch.created_by_profile_id is distinct from (v_reservation.op).requested_by_profile_id
      then
        v_transition_now := clock_timestamp();
        update public.qr_lifecycle_operations
        set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
        where id = (v_reservation.op).id;
        v_result.outcome := 'bulk_batch_unavailable';
        v_result.operation_id := (v_reservation.op).id;
        return v_result;
      end if;
    end if;

    select * into v_app from public.applications where id = p_application_id for update;
    if v_app.id is null or v_app.status <> 'accepted' then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
      where id = (v_reservation.op).id;
      v_result.outcome := 'application_ineligible';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    select * into v_current_active from public.qr_credentials
      where application_id = v_app.id and status = 'active' for update;

    v_check_now := clock_timestamp();
    if (v_reservation.op).expires_at <= v_check_now then
      update public.qr_lifecycle_operations
      set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
      where id = (v_reservation.op).id;
      v_result.outcome := 'operation_expired';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    if v_current_active.id is null then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'no_active_credential'
      where id = (v_reservation.op).id;
      v_result.outcome := 'no_active_credential';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    if v_current_active.id <> (v_reservation.op).expected_current_credential_id then
      v_transition_now := clock_timestamp();
      -- CORRECTED this round: terminal_related_credential_id is permitted
      -- ONLY for 'active_credential_already_exists' by the approved
      -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
      -- (§1.7) — it must remain null for 'expected_credential_changed',
      -- and the returned result carries only the stable outcome name, no
      -- credential_id/status/issued_at. The same narrow correction was
      -- applied to finalize_qr_reissue_for_server and every other
      -- occurrence of this exact pattern this same round.
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed',
          terminal_related_credential_id = null
      where id = (v_reservation.op).id;
      v_result.outcome := 'expected_credential_changed';
      v_result.operation_id := (v_reservation.op).id;
      return v_result;
    end if;

    v_result.outcome := 'already_pending';
    v_result.operation_id := (v_reservation.op).id;
    return v_result;
  end if;

  -- ===================== 'no_existing_operation' path =====================
  -- (also reached for an 'other_pending_candidate' just terminalized
  -- above, which falls through here identically.)
  --
  -- Authoritative processing order:
  --   1. create or reuse the durable lifecycle operation through the
  --      approved request-key protocol (already done above).
  --   2. lock and validate the bulk batch when applicable.
  --   3. lock the target application.
  --   4. lock/query the current active credential.
  --   5. capture a fresh timestamp.
  --   6. TTL precedence after every required lock.
  --   7. if the requester is no longer authorized, cancel with
  --      requester_no_longer_authorized.
  --   8. if the bulk batch is unavailable, cancel with
  --      bulk_batch_unavailable.
  --   9. if the application is missing or no longer accepted, cancel with
  --      application_ineligible.
  --  10. if no active credential exists, cancel with no_active_credential.
  --  11. if the active credential differs from expected, cancel with
  --      expected_credential_changed.
  --  12. otherwise return reserved.
  v_created_at := clock_timestamp();
  begin
    insert into public.qr_lifecycle_operations (
      operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
      channel, bulk_batch_id, request_key, reason_code, note, expected_current_credential_id, created_at, expires_at
    ) values (
      'reissue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
      p_request_key, p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id,
      v_created_at, v_created_at + p_pending_ttl
    ) returning id into v_operation_id;
  exception
    when unique_violation then
      declare
        v_constraint_name text;
        v_conflicting public.qr_lifecycle_operations;
        v_conflicting_resolution record;
      begin
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name <> 'qr_lifecycle_operations_one_pending_per_domain_idx' then
          raise;
        end if;
        select * into v_conflicting from public.qr_lifecycle_operations
          where application_id = p_application_id and operation_type = 'reissue' and status = 'pending'
          for update;
        if v_conflicting.id is null then
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, bulk_batch_id, request_key, reason_code, note, expected_current_credential_id, created_at, expires_at
          ) values (
            'reissue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
            p_request_key, p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id,
            v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        else
          select * into v_app from public.applications where id = p_application_id;
          select * into v_conflicting_resolution
            from public.resolve_blocking_qr_lifecycle_staff_reissue_operation(v_conflicting, v_app);
          if v_conflicting_resolution.disposition = 'still_blocking' then
            v_result.outcome := 'another_operation_pending';
            if v_conflicting.requested_by_auth_user_id = auth.uid() then
              v_result.operation_id := v_conflicting.id;
            end if;
            return v_result;
          end if;
          insert into public.qr_lifecycle_operations (
            operation_type, application_id, requested_by_auth_user_id, requested_by_profile_id,
            channel, bulk_batch_id, request_key, reason_code, note, expected_current_credential_id, created_at, expires_at
          ) values (
            'reissue', p_application_id, auth.uid(), v_caller.id, v_channel, p_bulk_batch_id,
            p_request_key, p_reissue_reason_code, v_normalized_note, p_expected_current_credential_id,
            v_created_at, v_created_at + p_pending_ttl
          ) returning id into v_operation_id;
        end if;
      end;
  end;

  -- Step 2: lock and validate the bulk batch, only for staff_bulk —
  -- position 4, BEFORE the application lock (position 5).
  if v_channel = 'staff_bulk' then
    select * into v_batch from public.qr_bulk_operation_batches where id = p_bulk_batch_id for share;
    if v_batch.id is null
       or v_batch.status <> 'active'
       or v_batch.expires_at <= clock_timestamp()
       or v_batch.intended_operation_type <> 'reissue'
       or v_batch.created_by_auth_user_id is distinct from auth.uid()
       or v_batch.created_by_profile_id is distinct from v_caller.id
    then
      v_transition_now := clock_timestamp();
      update public.qr_lifecycle_operations
      set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'bulk_batch_unavailable'
      where id = v_operation_id;
      v_result.outcome := 'bulk_batch_unavailable';
      v_result.operation_id := v_operation_id;
      return v_result;
    end if;
  end if;

  -- Step 3: lock the target application — position 5.
  select * into v_app from public.applications where id = p_application_id for update;

  -- Step 4: credential lock — position 6. No authoritative pre-read of
  -- the current credential occurs anywhere above this line.
  select * into v_current_active from public.qr_credentials
    where application_id = p_application_id and status = 'active' for update;

  -- Step 5: fresh timestamp, captured only after every lock above.
  v_check_now := clock_timestamp();

  -- Step 6: TTL, checked first — expiry wins over every finding below.
  if v_created_at + p_pending_ttl <= v_check_now then
    update public.qr_lifecycle_operations
    set status = 'expired', finalized_at = v_check_now, terminal_reason_code = 'ttl_expired'
    where id = v_operation_id;
    v_result.outcome := 'operation_expired';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 7: requester authorization, re-verified under the full lock
  -- set.
  if not is_staff() then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'requester_no_longer_authorized'
    where id = v_operation_id;
    v_result.outcome := 'requester_no_longer_authorized';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 8: bulk-batch availability was already fully validated at Step
  -- 2, above, BEFORE the application lock — restated here only as the
  -- corresponding numbered step, no further action.

  -- Step 9: application eligibility.
  if v_app.id is null or v_app.status <> 'accepted' then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'application_ineligible'
    where id = v_operation_id;
    v_result.outcome := 'application_ineligible';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 10: active-credential existence.
  if v_current_active.id is null then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'no_active_credential'
    where id = v_operation_id;
    v_result.outcome := 'no_active_credential';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 11: expected-credential match. CORRECTED this round:
  -- terminal_related_credential_id is permitted ONLY for
  -- 'active_credential_already_exists' by the approved
  -- qr_lifecycle_operations_cancelled_is_consistent CHECK constraint
  -- (§1.7) — it must remain null here, and the returned result carries
  -- only the stable outcome name, no credential_id/status/issued_at.
  if v_current_active.id <> p_expected_current_credential_id then
    v_transition_now := clock_timestamp();
    update public.qr_lifecycle_operations
    set status = 'cancelled', finalized_at = v_transition_now, terminal_reason_code = 'expected_credential_changed',
        terminal_related_credential_id = null
    where id = v_operation_id;
    v_result.outcome := 'expected_credential_changed';
    v_result.operation_id := v_operation_id;
    return v_result;
  end if;

  -- Step 12: every check has passed — the pending row remains genuinely
  -- reserved. The currently active credential remains completely
  -- unchanged. Credential creation/revocation/replacement/encryption/
  -- display belongs only to the future reissue finalizer, never this
  -- reservation RPC — including replaced_by, which the finalizer alone
  -- writes on the OLD credential, set to the staff profile that
  -- ultimately finalizes the reissue (not necessarily this reservation's
  -- own requester, since reservation and finalization are two separate
  -- steps, matching every other RPC pair in this design).
  v_result.outcome := 'reserved';
  v_result.operation_id := v_operation_id;
  return v_result;
end;
$$;

------------------------------------------------------------------
-- rollback_import_batch_transactional
-- Current source: 20260820140000_add_attendance_confirmation_to_import.sql
-- (itself carrying forward the SECURITY DEFINER + authorization-check
-- fix from 20260820120000_rollback_import_batch_security_definer.sql)
-- 1 check changed: current_user_role() not in (...) -> not is_staff()
-- (current_user_role() was called only inline for this check; no
-- variable/declare to remove)
------------------------------------------------------------------
create or replace function rollback_import_batch_transactional(
  p_batch_id uuid,
  p_actor_id uuid
) returns void as $$
declare
  v_batch import_batches;
  v_blocker_count int;
  v_blocker_detail text;
  v_scope_application_ids uuid[];
  v_row record;
  v_snapshot jsonb;
  v_answers jsonb;
  v_application_id uuid;
  v_old_status application_status;
  v_update_sql text;
  v_set_clauses text[];
  v_key text;
  v_restorable_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs',
    'birth_date',
    'full_name', 'gender', 'whatsapp_number', 'education_level',
    'institution_or_workplace', 'linkedin_url', 'primary_track', 'secondary_track',
    'funding_type',
    'attendance_confirmation'
  ];
  v_array_columns text[] := array[
    'interests', 'track_interests',
    'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas'
  ];
begin
  ------------------------------------------------------------------
  -- SECURITY DEFINER means RLS provides ZERO protection inside this body,
  -- so this check IS the entire authorization boundary for this function
  -- (carried forward from 20260820120000/20260820140000, now expressed
  -- via is_staff() -- the same super_admin-inclusive staff-role set
  -- current_user_role() not in ('agenda_allocation_manager',
  -- 'participants_communications_manager', 'super_admin') previously
  -- encoded -- must never be dropped by a future create-or-replace of
  -- this function).
  ------------------------------------------------------------------
  if not is_staff() then
    raise exception 'Not authorized to roll back an import batch';
  end if;

  select * into v_batch from import_batches where id = p_batch_id for update;

  if v_batch.id is null then
    raise exception 'Import batch % not found', p_batch_id;
  end if;

  if v_batch.status = 'rolled_back' then
    raise exception 'Import batch % has already been rolled back', p_batch_id;
  end if;

  select coalesce(array_agg(distinct id), array[]::uuid[])
  into v_scope_application_ids
  from (
    select a.id
    from applications a
    where a.import_batch_id = p_batch_id
    union
    select r.destination_application_id as id
    from import_rows r
    where r.import_batch_id = p_batch_id
      and r.destination_application_id is not null
      and r.action_taken in ('inserted', 'updated')
  ) scope;

  select count(*) into v_blocker_count
  from participant_feature_snapshots s
  where s.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_feature_snapshots row(s) reference applications from this batch. Delete the feature extraction run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from cluster_memberships c
  where c.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % cluster_memberships row(s) reference applications from this batch. Delete the clustering run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from allocation_assignments al
  where al.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % allocation_assignments row(s) reference applications from this batch. Delete the allocation run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from schedule_publications sp
  where sp.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publications row(s) reference applications from this batch. Retract the publication first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from schedule_publication_draft_items spdi
  where spdi.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publication_draft_items row(s) reference applications from this batch. Discard the schedule draft first.',
      p_batch_id, v_blocker_count;
  end if;

  perform 1
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
  for update of pi;

  select count(*), string_agg(distinct pi.status, ', ' order by pi.status)
  into v_blocker_count, v_blocker_detail
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
    and pi.status <> 'not_sent';
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_invitations row(s) for applications in this batch are no longer in ''not_sent'' status (found: %). An invitation has already been sent to a real recipient and an auth user may exist for them; revoke the invitation(s) before rolling back.',
      p_batch_id, v_blocker_count, v_blocker_detail;
  end if;

  for v_row in
    select * from import_rows
    where import_batch_id = p_batch_id
      and action_taken in ('inserted', 'updated')
    order by excel_row_number
    for update
  loop
    v_application_id := v_row.destination_application_id;

    if v_row.action_taken = 'inserted' then
      if v_application_id is not null then
        insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
        values (
          'application',
          v_application_id,
          'import_rollback_delete',
          'admin',
          p_actor_id,
          jsonb_build_object(
            'batchId', p_batch_id,
            'importRowId', v_row.id,
            'excelRowNumber', v_row.excel_row_number
          )
        );

        delete from applications where id = v_application_id;
      end if;

    else
      v_snapshot := v_row.previous_application_snapshot;

      if v_application_id is null or v_snapshot is null then
        raise exception 'Cannot roll back import batch %: import row % is marked ''updated'' but has no recoverable snapshot (destination_application_id=%, previous_application_snapshot is null).',
          p_batch_id, v_row.id, v_application_id;
      end if;

      perform 1 from applications where id = v_application_id for update;

      select status into v_old_status from applications where id = v_application_id;

      v_set_clauses := array[]::text[];

      foreach v_key in array v_restorable_columns loop
        v_set_clauses := v_set_clauses || format('%I = %L', v_key, v_snapshot->>v_key);
      end loop;

      foreach v_key in array v_array_columns loop
        v_set_clauses := v_set_clauses || format(
          '%I = %L::text[]',
          v_key,
          case
            when v_snapshot->v_key is null or jsonb_typeof(v_snapshot->v_key) = 'null' then null
            else (select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_snapshot->v_key) as e)
          end
        );
      end loop;

      v_set_clauses := v_set_clauses || format('status = %L::application_status', (v_snapshot->>'status')::application_status);

      v_update_sql := format(
        'update applications set %s where id = %L',
        array_to_string(v_set_clauses, ', '),
        v_application_id
      );
      execute v_update_sql;

      delete from application_answers where application_id = v_application_id;

      v_answers := coalesce(v_row.previous_answers_snapshot, '[]'::jsonb);

      insert into application_answers (
        id, application_id, question_key, question_label, normalized_value,
        raw_value, value_type, source, is_sensitive, import_batch_id,
        section, created_at, updated_at
      )
      select
        (e->>'id')::uuid,
        (e->>'application_id')::uuid,
        e->>'question_key',
        e->>'question_label',
        e->>'normalized_value',
        e->>'raw_value',
        e->>'value_type',
        e->>'source',
        (e->>'is_sensitive')::boolean,
        (e->>'import_batch_id')::uuid,
        coalesce(e->>'section', 'application'),
        (e->>'created_at')::timestamptz,
        (e->>'updated_at')::timestamptz
      from jsonb_array_elements(v_answers) as e;

      delete from application_travel_info where application_id = v_application_id;
      if v_row.previous_travel_snapshot is not null then
        insert into application_travel_info (
          application_id, support_level_requested, can_attend_without_full_support,
          departure_airport, visa_required, invitation_letter_required,
          passport_full_name, passport_full_name_ar, passport_birth_date,
          passport_place_of_issue, passport_issue_date, passport_expiry_date,
          passport_copy_url, passport_photo_url, created_at, updated_at
        )
        select
          v_application_id,
          e->>'support_level_requested',
          (e->>'can_attend_without_full_support')::boolean,
          e->>'departure_airport',
          (e->>'visa_required')::boolean,
          (e->>'invitation_letter_required')::boolean,
          e->>'passport_full_name',
          e->>'passport_full_name_ar',
          (e->>'passport_birth_date')::date,
          e->>'passport_place_of_issue',
          (e->>'passport_issue_date')::date,
          (e->>'passport_expiry_date')::date,
          e->>'passport_copy_url',
          e->>'passport_photo_url',
          (e->>'created_at')::timestamptz,
          (e->>'updated_at')::timestamptz
        from (select v_row.previous_travel_snapshot as e) s;
      end if;

      delete from application_health_info where application_id = v_application_id;
      if v_row.previous_health_snapshot is not null then
        insert into application_health_info (
          application_id, allergies, medical_conditions, emergency_medication,
          accessibility_requirements, dietary_requirements, accommodation_preference,
          cultural_or_religious_requirements, emergency_contact_name,
          emergency_contact_relationship, emergency_contact_phone, consent_given,
          created_at, updated_at
        )
        select
          v_application_id,
          e->>'allergies',
          e->>'medical_conditions',
          e->>'emergency_medication',
          e->>'accessibility_requirements',
          e->>'dietary_requirements',
          e->>'accommodation_preference',
          e->>'cultural_or_religious_requirements',
          e->>'emergency_contact_name',
          e->>'emergency_contact_relationship',
          e->>'emergency_contact_phone',
          (e->>'consent_given')::boolean,
          (e->>'created_at')::timestamptz,
          (e->>'updated_at')::timestamptz
        from (select v_row.previous_health_snapshot as e) s;
      end if;

      insert into application_status_history (application_id, old_status, new_status, changed_by, note)
      values (
        v_application_id,
        v_old_status,
        (v_snapshot->>'status')::application_status,
        p_actor_id,
        format('Restored by rollback of import batch %s', p_batch_id)
      );

      insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, new_values)
      values (
        'application',
        v_application_id,
        'import_rollback_restore',
        'admin',
        p_actor_id,
        jsonb_build_object(
          'batchId', p_batch_id,
          'importRowId', v_row.id,
          'excelRowNumber', v_row.excel_row_number,
          'restoredAnswerCount', jsonb_array_length(v_answers)
        ),
        v_snapshot
      );
    end if;

    update import_rows set
      action_taken = null,
      previous_application_snapshot = null,
      previous_answers_snapshot = null,
      previous_travel_snapshot = null,
      previous_health_snapshot = null
    where id = v_row.id;
  end loop;

  update import_batches set
    status = 'rolled_back',
    inserted_count = 0,
    updated_count = 0,
    processing_lock_token = null,
    processing_lock_expires_at = null,
    next_chunk_offset = 0
  where id = p_batch_id;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'import_batch',
    p_batch_id,
    'import_rollback',
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_batch_id)
  );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

comment on function rollback_import_batch_transactional(uuid, uuid) is
  'Undoes an entire import batch atomically, or refuses entirely. SECURITY '
  'DEFINER (since 20260820120000) -- the is_staff() check at the top of '
  'this function (consolidated from an inline current_user_role() check '
  'by 20260929020000) is the ENTIRE authorization boundary and must '
  'never be removed or loosened without an equivalent replacement. Adds '
  'attendance_confirmation to v_restorable_columns on top of funding_type '
  'and the earlier Phase B feature set (restoring application_travel_info/'
  'application_health_info on an updated-row rollback via delete-then-'
  'conditionally-reinsert from import_rows.previous_travel_snapshot/'
  'previous_health_snapshot). v_restorable_columns/v_array_columns MUST '
  'stay in sync with apply_import_row_transactional''s own arrays -- '
  'update both together.';

------------------------------------------------------------------
-- create_qr_bulk_operation_batch_for_server
-- Current source: 20260805235959_phase6_qr_issuance_reissue.sql (never
-- superseded)
-- 1 check changed: positive-form `role in ('super_admin',
-- 'program_attendance_manager')` inside the existing `not exists
-- (select 1 from public.profiles where id = p_staff_profile_id and
-- ...)` subquery -> `role in ('staff', 'super_admin')`.
--
-- NOTE: is_staff() is NOT used here, unlike every other function in
-- this migration. is_staff() resolves current_user_role(), which reads
-- profiles.role for auth.uid() — the CALLER's own session identity. But
-- this function is service_role-only (see its `revoke all ... grant
-- execute ... to service_role` below, unchanged from source) and is
-- invoked by the Node orchestration layer, not by an authenticated
-- client session, so auth.uid() is not the identity being authorized
-- here at all: the check must instead validate the ARBITRARY profile
-- row identified by the p_staff_profile_id parameter (already asserted
-- above to equal p_staff_auth_user_id), exactly as the original
-- `role in (...)` subquery did. Substituting is_staff() would silently
-- decouple the check from p_staff_profile_id and evaluate the wrong
-- (likely null/service-role) identity instead, breaking every
-- legitimate call. Keeping the same `select 1 from public.profiles
-- where id = p_staff_profile_id and role in (...)` shape and swapping
-- only the deprecated two-role list for the post-consolidation
-- ('staff', 'super_admin') pair preserves the original parameterized
-- semantics while still folding every deprecated staff-domain role
-- into the new 'staff' enum value, consistent with is_staff()'s own
-- role set.
------------------------------------------------------------------
create or replace function public.create_qr_bulk_operation_batch_for_server(
  p_staff_auth_user_id uuid,
  p_staff_profile_id uuid,
  p_intended_operation_type text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_batch_id uuid;
  v_created_at timestamptz;
begin
  if p_staff_auth_user_id is null then raise exception 'Staff auth user id is required'; end if;
  if p_intended_operation_type not in ('issue', 'reissue') then
    raise exception 'Invalid intended operation type';
  end if;
  if p_staff_profile_id is null or p_staff_profile_id <> p_staff_auth_user_id then
    raise exception 'Staff auth user id and profile id must identify the same account';
  end if;
  if not exists (
    select 1 from public.profiles where id = p_staff_profile_id and role in ('staff', 'super_admin')
  ) then
    raise exception 'Invalid staff profile for bulk batch creation';
  end if;

  -- CORRECTED this round: one captured timestamp for BOTH created_at and
  -- expires_at, explicitly inserted — was previously relying on
  -- created_at's column default (now(), i.e. transaction-start time)
  -- while expires_at used clock_timestamp() (call-time), which can be a
  -- different instant within the same transaction, producing a batch
  -- whose stated 1-hour lifetime doesn't actually measure from its own
  -- created_at.
  v_created_at := clock_timestamp();

  insert into public.qr_bulk_operation_batches (
    created_by_auth_user_id, created_by_profile_id, intended_operation_type, created_at, expires_at
  ) values (
    p_staff_auth_user_id, p_staff_profile_id, p_intended_operation_type,
    v_created_at, v_created_at + interval '1 hour'
  ) returning id into v_batch_id;

  insert into public.audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, created_at)
  values (
    'qr_bulk_operation_batch', v_batch_id, 'bulk_batch_created', 'admin', p_staff_profile_id,
    jsonb_build_object('intended_operation_type', p_intended_operation_type),
    v_created_at
  );

  return v_batch_id;
end;
$$;
