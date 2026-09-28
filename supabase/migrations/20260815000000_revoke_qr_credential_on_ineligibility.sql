-- 20260815000000_revoke_qr_credential_on_ineligibility.sql
--
-- Corrective migration — closes a bearer-credential resurrection gap
-- discovered while building the Participant QR Experience.
--
-- CONFIRMED FACTS (read directly from the live migrations, not assumed):
--   - Every QR issuance/reissue reservation and finalizer RPC
--     (request_my_qr_issuance_transactional, request_staff_qr_issuance_
--     transactional, request_my_qr_reissue_transactional, request_staff_
--     qr_reissue_transactional, finalize_qr_issuance_for_server,
--     finalize_qr_reissue_for_server — all in
--     20260805235959_phase6_qr_issuance_reissue.sql) already correctly
--     check applications.status = 'accepted' before issuing/reissuing.
--   - scan_attempt_transactional (20260804160000, restated in
--     20260814110000) independently re-checks applications.status live
--     at every single scan — an application that is no longer 'accepted'
--     cannot be admitted even if its qr_credentials row is still
--     status = 'active'. There is NO admission-control gap.
--   - VALID_TRANSITIONS (src/lib/validation/admission-review.ts) permits
--     waitlisted -> accepted and rejected -> accepted through the real
--     admin review UI. Nothing in the existing schema revokes/replaces
--     qr_credentials when an application leaves 'accepted'.
--
-- THE GAP THIS MIGRATION CLOSES: because nothing revoked the old
-- credential when eligibility was first lost, a credential that was
-- 'active' while accepted, then correctly could not admit anyone while
-- non-accepted (per the live scan-time check above), would become
-- OPERATIONAL AGAIN with zero re-issuance the moment the application
-- returns to 'accepted' — resurrecting a bearer credential the
-- participant may have already screenshotted/shared/lost. This is a
-- genuine credential-lifecycle defect, independent of the (already
-- sound) admission-control checks.
--
-- FIX: an AFTER UPDATE trigger on applications that revokes the
-- application's current active qr_credentials row (if any) the instant
-- status transitions away from 'accepted'. Purely additive — reuses the
-- EXACT existing active -> revoked transition shape the lifecycle guard
-- trigger (qr_credentials_lifecycle_guard, same migration as above)
-- already permits and enforces: token_ciphertext and
-- encryption_key_version cleared together, revoked_at/revocation_reason_
-- code set, revoked_by left NULL (this is a system-initiated transition,
-- not a staff action — mirrors how reissue_channel = 'system' already
-- means "no staff actor" elsewhere in the same lifecycle guard). No
-- existing constraint, status vocabulary, or table is altered except the
-- one narrow, additive change in step 1 below.

-- ============================================================================
-- 1. Extend revocation_reason_code's CHECK constraint with exactly one new
--    value: 'application_ineligible'. Every existing allowed value is
--    preserved verbatim (read directly from the live constraint definition
--    in 20260805235959, not assumed) — this is drop-and-recreate, not an
--    edit of the already-applied migration.
-- ============================================================================
alter table public.qr_credentials drop constraint qr_credentials_revocation_reason_code_valid;
alter table public.qr_credentials add constraint qr_credentials_revocation_reason_code_valid check (
  revocation_reason_code is null or revocation_reason_code in (
    'suspected_compromise', 'participant_request', 'administrative_correction', 'staff_other',
    'application_ineligible'
  )
);

-- ============================================================================
-- 2. The revocation function itself. SECURITY DEFINER because it must be
--    able to update qr_credentials regardless of the calling transaction's
--    role (the trigger fires under whatever role performed the
--    applications UPDATE — service_role for the existing staff review
--    action). Idempotent/safe no-op if there is no active credential.
-- ============================================================================
create function public.revoke_active_qr_credential_for_ineligible_application()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Only fires on a genuine status change AWAY from 'accepted'. Any other
  -- column changing on the same row (assigned_reviewer_id, updated_at via
  -- the existing moddatetime trigger, etc.) must never trigger a
  -- revocation — this is the exact narrow condition requested.
  if old.status = 'accepted' and new.status <> 'accepted' then
    -- Row-level lock on the credential before transitioning it, same
    -- discipline the issuance/reissue RPCs already use
    -- (`select ... from qr_credentials where application_id = ... and
    -- status = 'active' for update`) — closes the same class of race a
    -- concurrent reissue could otherwise create against this trigger.
    update public.qr_credentials
    set
      status = 'revoked',
      revoked_at = clock_timestamp(),
      revoked_by = null,
      revocation_reason_code = 'application_ineligible',
      revocation_note = 'Automatically revoked: application status changed from accepted to ' || new.status,
      token_ciphertext = null,
      encryption_key_version = null
    where application_id = new.id
      and status = 'active';
    -- Zero matching rows (no active credential existed) is a normal,
    -- expected no-op — never an error.
  end if;
  return new;
end;
$$;

revoke all on function public.revoke_active_qr_credential_for_ineligible_application() from public;

-- AFTER UPDATE (not BEFORE): the status change must actually commit within
-- the same transaction before this trigger reads/acts on it as NEW.status;
-- an AFTER trigger still runs inside the same transaction as the
-- originating UPDATE (so it remains atomic with it — either both the
-- status change and the revocation commit, or neither does), it just
-- observes the row post-change rather than being able to further modify
-- the applications row itself (which this trigger never needs to do).
create trigger applications_revoke_qr_on_ineligibility
  after update on public.applications
  for each row
  execute function public.revoke_active_qr_credential_for_ineligible_application();
