-- claim_application_function.sql
--
-- Task 21, Step 1. The entire participant-side claim, as ONE Postgres
-- transaction. This function is the ONLY place in the entire codebase that
-- is permitted to set applications.applicant_id on an imported row —
-- ownership of an imported accepted-participant record is established here
-- and nowhere else (design spec rule 1: an Auth user merely EXISTING for an
-- imported email implies no ownership whatsoever; only a completed claim
-- through this function does).
--
-- Atomicity guarantee: identical reasoning to
-- apply_import_row_transactional (20260726108000) and
-- rollback_import_batch_transactional (20260726109000). PostgREST executes
-- each RPC call inside its own transaction and a plpgsql function body runs
-- entirely within the calling transaction. There is NO blanket
-- `exception when others` block here, so any unexpected error aborts the
-- whole call and rolls back every write. The single narrow exception block
-- below catches ONLY unique_violation on the one specific UPDATE it wraps,
-- and re-raises — it never swallows an error and never allows the
-- transaction to commit a partial claim.
--
-- SECURITY DEFINER — a deliberate DEVIATION from the security-invoker style
-- of every other transactional RPC in this phase, and the single most
-- security-sensitive decision in this file. Rationale:
--
--   * Every prior transactional RPC (apply_import_row, rollback_import_batch,
--     confirm_publication) is only ever invoked with a SERVICE-ROLE client
--     from a staff-gated server action. The service role bypasses RLS
--     entirely, so security invoker costs those functions nothing.
--   * This function is different by design: the plan requires it to be
--     called with the CLAIMING USER'S OWN authenticated session, precisely
--     so that p_claiming_user_id can be derived from a real
--     supabase.auth.getUser() rather than from client-supplied input.
--   * Under security invoker, the `update applications set applicant_id`
--     below would be evaluated against the claiming participant's RLS.
--     applications' only participant UPDATE policy is
--     applications_update_own_draft (`applicant_id = auth.uid() and status =
--     'draft'`, 20260721212035_rls_policies.sql). An unclaimed imported row
--     has applicant_id = null and status = 'accepted', so it matches
--     NEITHER the USING nor the WITH CHECK clause — the update would affect
--     zero rows and the claim would silently no-op. Likewise the
--     participant cannot even SELECT the row (applications_select_own is
--     also applicant_id = auth.uid()), so the invitation/ownership
--     verification below could not read what it needs to verify.
--
-- The security consequence of SECURITY DEFINER is that RLS provides ZERO
-- protection inside this body, so this function's own checks ARE the entire
-- security boundary. They are therefore written to be exhaustive and to
-- fail closed:
--
--   1. p_claiming_user_id is never trusted from the client. The caller
--      (claim/actions.ts) derives it from supabase.auth.getUser(). To make
--      that non-bypassable at the DB layer too, this function additionally
--      asserts p_claiming_user_id = auth.uid() — auth.uid() is resolved
--      from the verified JWT and is NOT affected by SECURITY DEFINER (it
--      reads the request's JWT claims, not the executing role). So even if
--      an attacker calls this RPC directly via PostgREST with a forged
--      p_claiming_user_id, the assertion rejects it. This makes the
--      parameter effectively advisory and the JWT authoritative.
--   2. The invitation row must exist for p_application_id with BOTH
--      status = 'sent' AND invited_user_id = p_claiming_user_id. This one
--      check simultaneously covers replay (an already-'accepted' invitation
--      fails the status test) and wrong-user attempts (a different
--      authenticated user fails the invited_user_id test), exactly as the
--      plan specifies.
--   3. execute is granted to `authenticated` only, never `anon`.
--
-- Locking: the participant_invitations row is taken FOR UPDATE before the
-- status check, so two concurrent claim attempts for the same application
-- serialize; the loser re-reads status = 'accepted' and is rejected by
-- check 2 rather than performing a second claim.

create function claim_imported_application_transactional(
  p_application_id uuid,
  p_claiming_user_id uuid
) returns void as $$
declare
  v_invitation participant_invitations;
  v_application applications;
begin
  -- Defence in depth (see rationale 1 above): under SECURITY DEFINER the
  -- executing role is the function owner, but auth.uid() still reflects the
  -- caller's verified JWT, so this pins the claim to the real session and
  -- makes a forged p_claiming_user_id unusable even on a direct PostgREST
  -- call that bypasses claim/actions.ts entirely.
  if auth.uid() is null then
    raise exception 'Claiming requires an authenticated session';
  end if;
  if p_claiming_user_id is distinct from auth.uid() then
    raise exception 'Claiming user does not match the authenticated session';
  end if;

  -- Lock the invitation for the duration of the transaction BEFORE reading
  -- its status, so two concurrent claims for the same application serialize
  -- here rather than both observing status = 'sent'.
  select * into v_invitation
  from participant_invitations
  where application_id = p_application_id
  for update;

  if v_invitation.id is null then
    raise exception 'No invitation exists for this application';
  end if;

  -- The single combined check the plan specifies. Deliberately does NOT
  -- distinguish "already claimed" from "wrong user" in the message: telling
  -- an unauthorized caller which of the two conditions they failed leaks
  -- whether a given application has been claimed and by whom, to a caller
  -- who by definition has no right to know anything about this application.
  if v_invitation.status <> 'sent' or v_invitation.invited_user_id is distinct from p_claiming_user_id then
    raise exception 'This invitation cannot be claimed by this account';
  end if;

  -- Lock the application too. Ordered after the invitation lock so every
  -- caller of this function acquires the two locks in the same order (no
  -- deadlock cycle is possible between concurrent claims).
  select * into v_application from applications where id = p_application_id for update;

  if v_application.id is null then
    raise exception 'Application % no longer exists', p_application_id;
  end if;

  -- Belt-and-braces: a non-null applicant_id here would mean the row was
  -- claimed by some path other than this function while its invitation was
  -- still 'sent' — an invariant violation, not a normal user error. Fail
  -- closed rather than overwrite an existing owner.
  if v_application.applicant_id is not null then
    raise exception 'This application has already been claimed';
  end if;

  ------------------------------------------------------------------
  -- The ownership write. THE one place applicant_id is ever set on an
  -- imported row.
  ------------------------------------------------------------------
  begin
    update applications
    set applicant_id = p_claiming_user_id
    where id = p_application_id;
  exception when unique_violation then
    -- applications_one_per_applicant (a plain unique index over the
    -- nullable applicant_id column, created in
    -- 20260721202027_applications_table.sql, predating this phase) permits
    -- unlimited unclaimed (null) rows but at most one row per non-null
    -- applicant_id. So this fires exactly when p_claiming_user_id already
    -- owns a DIFFERENT application. Confirmed with the user as desired
    -- behaviour (one application per account), so the job here is purely to
    -- convert an opaque Postgres constraint error into a message the claim
    -- page can show verbatim.
    --
    -- Safe use of an exception block despite this file's no-error-swallowing
    -- rule: it catches ONE specific, well-understood sqlstate around ONE
    -- statement and unconditionally re-raises. Nothing is swallowed and the
    -- transaction still aborts, so no partial claim can commit. Any other
    -- error from this UPDATE (including any other unique index) propagates
    -- untouched.
    raise exception 'This account has already claimed a different accepted-participant record';
  end;

  ------------------------------------------------------------------
  -- Mark the invitation consumed. Same transaction, so the ownership write
  -- and the invitation state can never disagree — a committed claim always
  -- has status = 'accepted', and a rejected one leaves 'sent' untouched.
  -- This is also what makes replay (Case 2) fail on the status check above.
  ------------------------------------------------------------------
  update participant_invitations
  set status = 'accepted', accepted_at = now()
  where application_id = p_application_id;

  -- Audited inside the transaction, matching the
  -- apply_import_row_transactional / rollback_import_batch_transactional
  -- precedent: an audit row written outside this transaction could survive
  -- a rolled-back claim (claiming an ownership change that never happened)
  -- or be lost after a committed one.
  --
  -- actor_type = 'system' rather than 'admin': audit_actor_type is the
  -- two-value enum ('admin', 'system') from
  -- 20260722200245_agenda_enums_and_reference_tables.sql — there is no
  -- 'participant' value, and this is the first participant-initiated
  -- audited action in the codebase. 'admin' would be an outright false
  -- claim that a staff member performed the claim, which is worse in an
  -- audit trail than the vaguer-but-true 'system'. actor_id still records
  -- exactly who claimed. Adding a 'participant' enum value was considered
  -- and deliberately not done here: altering a shared enum is out of this
  -- task's scope and would touch every audit consumer.
  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'application',
    p_application_id,
    'invitation_claimed',
    'system',
    p_claiming_user_id,
    jsonb_build_object('invitationId', v_invitation.id)
  );
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

-- Explicit grants. The default on a newly created function is EXECUTE to
-- PUBLIC, which for a SECURITY DEFINER function would expose it to the
-- `anon` role as well. anon has no auth.uid(), so the first check would
-- reject it anyway — but revoking first and granting narrowly means that
-- protection does not rest on a single `if` statement.
revoke all on function claim_imported_application_transactional(uuid, uuid) from public;
grant execute on function claim_imported_application_transactional(uuid, uuid) to authenticated;
