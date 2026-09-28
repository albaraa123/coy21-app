-- Fixes a genuine Phase 6 authorization-semantics defect in
-- resolve_blocking_qr_lifecycle_staff_issuance_operation AND its reissue
-- counterpart resolve_blocking_qr_lifecycle_staff_reissue_operation, both
-- introduced in 20260805235959_phase6_qr_issuance_reissue.sql and both
-- carrying the identical defect (the reissue resolver's own step 1
-- comment states it is "identical precedence and rationale" to the
-- issuance resolver's).
--
-- ROOT CAUSE: reserve_or_reuse_qr_lifecycle_operation's domain-wide
-- other_pending_candidate lookup (application_id, operation_type = 'issue',
-- status = 'pending') has NO channel filter — the candidate it returns can
-- legitimately be a 'participant_self_service' pending issuance, not only
-- a staff-originated one. resolve_blocking_qr_lifecycle_staff_issuance_
-- operation's step 1, however, unconditionally required the candidate's
-- OWN requester to hold a staff-eligible role
-- (super_admin/program_attendance_manager), and terminalized anything
-- else with terminal_reason_code = 'requester_no_longer_authorized'.
--
-- A participant has no staff role and was never expected to hold one —
-- this check was designed (per that function's own introducing comment)
-- to catch a STAFF requester whose role lapses between reservation and
-- resolution, not to reject a legitimate participant self-service
-- candidate outright. The practical effect: a valid, still-pending
-- participant self-service issuance request racing a concurrent staff
-- issuance request for the SAME application was silently cancelled and
-- mislabeled as "requester no longer authorized," even though the
-- participant never lost any authorization they held. The competing
-- staff request then proceeded to insert its own row instead of
-- correctly observing another_operation_pending.
--
-- No approved migration comment anywhere in this codebase establishes a
-- product rule that staff issuance should preempt a valid participant
-- self-service issuance request. Absent such a rule, this fix makes the
-- resolver channel-aware: a staff-originated candidate
-- (staff_individual/staff_bulk) still has its own requester's staff role
-- re-verified exactly as before; a participant_self_service candidate
-- skips that check entirely and is evaluated purely on the SAME
-- application-eligibility -> credential-lock -> TTL -> credential-
-- conflict sequence resolve_blocking_qr_lifecycle_operation (the
-- participant issuance path's own resolver) already applies to it.
--
-- This is the smallest corrective change: only step 1's guard changes.
-- Every other step (bulk-batch availability, application eligibility,
-- credential lock ordering, TTL precedence, credential-conflict
-- resolution, terminal-reason vocabulary, audit/idempotency columns) is
-- byte-for-byte unchanged.
create or replace function public.resolve_blocking_qr_lifecycle_staff_issuance_operation(
  p_candidate public.qr_lifecycle_operations,
  p_app public.applications,
  out disposition text -- 'still_blocking' | 'terminalized'
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller_role text;
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
    select role into v_caller_role from public.profiles where id = p_candidate.requested_by_auth_user_id;
    if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
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

-- Identical fix, identical rationale, for the reissue counterpart. Only
-- step 1's guard changes; steps 2-7 (bulk-batch availability, application
-- eligibility, credential lock ordering, TTL precedence, no-active-
-- credential, expected-credential mismatch, terminal-reason vocabulary,
-- audit/idempotency columns) are byte-for-byte unchanged.
create or replace function public.resolve_blocking_qr_lifecycle_staff_reissue_operation(
  p_candidate public.qr_lifecycle_operations,
  p_app public.applications,
  out disposition text -- 'still_blocking' | 'terminalized'
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller_role text;
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
    select role into v_caller_role from public.profiles where id = p_candidate.requested_by_auth_user_id;
    if v_caller_role is null or v_caller_role not in ('super_admin', 'program_attendance_manager') then
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
