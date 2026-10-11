-- 20261011000000_fix_is_staff_null_bypass_in_rpcs.sql
--
-- Closes the is_staff() NULL-bypass in SECURITY DEFINER RPC bodies that
-- 20260929020000_consolidate_inline_role_checks_to_staff.sql rewrote to
-- use a bare `if not is_staff() then` / `if v_caller.id is null or not
-- is_staff() then`.
--
-- The bug: is_staff() is `select current_user_role() in ('staff',
-- 'super_admin')`, and current_user_role() returns NULL for any caller
-- with no public.profiles row keyed on auth.uid() (anon, service_role,
-- or an authenticated auth.users row whose profile row does not exist).
-- `NULL in (...)` is NULL, `not NULL` is NULL, and plpgsql `if` treats
-- NULL as false -- so a bare `if not is_staff() then raise ...` silently
-- never fires for exactly the callers it most needs to reject. This is
-- the same NULL-bypass pattern already fixed with
-- `coalesce(is_staff(), false)` in ops_dashboard_snapshot()
-- (20261006071000) and create_announcement() (20261008020000); this
-- migration applies the identical `not coalesce(is_staff(), false)` form.
-- No `or auth.role() = 'service_role'` carve-out is added anywhere here:
-- every check changed below runs only in an authenticated end-user
-- session (see per-function notes), never under service_role.
--
-- Each function is reproduced in full via `create or replace function`
-- from its CURRENT definition in 20260929020000 (nothing later
-- supersedes any of them), byte-for-byte identical except that each
-- bare `not is_staff()` becomes `not coalesce(is_staff(), false)`. No
-- signature, return type, security context, search_path, grant, or other
-- logic changes. `create or replace` preserves existing grants/ownership.
--
-- Functions changed (5 functions, 9 checks):
--
--   EXPLOITABLE (real-world reachable by an `authenticated` caller):
--     - rollback_import_batch_transactional (1 check)
--       Granted DIRECTLY to `authenticated` (20260820120000/
--       20260820140000). Its own comment says this check IS the entire
--       authorization boundary. An authenticated user with no profiles
--       row got NULL from is_staff(), skipped the raise, and could roll
--       back any import batch (restoring/mutating PII such as full_name,
--       phone, special_needs).
--
--   DEFENSE-IN-DEPTH (no live bypass today, fixed for consistency):
--     - request_staff_qr_issuance_transactional_internal (3 checks)
--     - request_staff_qr_reissue_transactional_internal  (3 checks)
--       Reachable by `authenticated` via the thin wrappers
--       request_staff_qr_issuance_transactional /
--       request_staff_qr_reissue_transactional (20260805235959), but the
--       first check is `v_caller.id is null or not is_staff()` -- a
--       missing profiles row makes `v_caller.id is null` true, which
--       raises regardless of is_staff()'s NULL; and profiles.role is
--       NOT NULL, so is_staff() is never NULL once a profile row exists.
--       The later re-checks run only after that guard passed. Coalescing
--       them removes the latent hazard should either guard ever change.
--     - resolve_blocking_qr_lifecycle_staff_issuance_operation (1 check)
--     - resolve_blocking_qr_lifecycle_staff_reissue_operation  (1 check)
--       service_role-only grant; called internally only from the two
--       *_internal functions above, i.e. always in a caller session that
--       already passed the staff guard, so the coalesce is behavior-
--       neutral today. (They share the identity defect described for
--       the finalizers below -- they check the current caller rather
--       than p_candidate.requested_by_auth_user_id -- which this
--       migration does not attempt to address.)
--
-- DELIBERATELY NOT CHANGED here (see review notes, needs a decision):
--     - finalize_qr_issuance_for_server / finalize_qr_reissue_for_server
--       These are service_role-only and are invoked by the Node layer
--       through a service-role client (src/lib/attendance/
--       qr-credential-issuance.ts), so auth.uid() is NULL and is_staff()
--       is ALWAYS NULL there. Coalescing would make every staff-channel
--       finalization cancel with 'requester_no_longer_authorized',
--       breaking staff QR issuance/reissue outright. The underlying
--       defect is that 20260929020000 replaced a check of the RECORDED
--       requester's role (`select role ... where id =
--       v_op.requested_by_auth_user_id`) with is_staff(), which checks
--       the current session instead -- so the role-lapse re-check in the
--       finalizers is currently a no-op. The correct fix restores a
--       parameterized lookup against v_op.requested_by_auth_user_id with
--       role in ('staff', 'super_admin') (as 20260929020000 itself did
--       for create_qr_bulk_operation_batch_for_server), and belongs in a
--       separate, reviewed migration.
--     - create_qr_bulk_operation_batch_for_server
--       Does not call is_staff() at all (uses a parameterized
--       `role in ('staff', 'super_admin')` subquery); not affected.

------------------------------------------------------------------
-- resolve_blocking_qr_lifecycle_staff_issuance_operation
-- Current source: 20260929020000_consolidate_inline_role_checks_to_staff.sql
-- 1 check: not is_staff() -> not coalesce(is_staff(), false)
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
    if not coalesce(is_staff(), false) then
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
-- Current source: 20260929020000_consolidate_inline_role_checks_to_staff.sql
-- 1 check: not is_staff() -> not coalesce(is_staff(), false)
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
    if not coalesce(is_staff(), false) then
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
-- request_staff_qr_issuance_transactional_internal
-- Current source: 20260929020000_consolidate_inline_role_checks_to_staff.sql
-- 3 checks: not is_staff() -> not coalesce(is_staff(), false)
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
  if v_caller.id is null or not coalesce(is_staff(), false) then
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
    if not coalesce(is_staff(), false) then
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
  if not coalesce(is_staff(), false) then
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
-- Current source: 20260929020000_consolidate_inline_role_checks_to_staff.sql
-- 3 checks: not is_staff() -> not coalesce(is_staff(), false)
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
  if v_caller.id is null or not coalesce(is_staff(), false) then
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
    if not coalesce(is_staff(), false) then
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
  if not coalesce(is_staff(), false) then
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
-- Current source: 20260929020000_consolidate_inline_role_checks_to_staff.sql
-- 1 check: not is_staff() -> not coalesce(is_staff(), false)
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
  if not coalesce(is_staff(), false) then
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
