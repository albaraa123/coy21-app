// src/lib/attendance/participant-qr.ts
//
// Server-only trusted read for the Participant QR Experience: resolves
// the AUTHENTICATED caller's own current, usable conference QR payload —
// nothing else. Reuses the existing Phase 6.1 modules exactly as they
// already exist:
//   - getMyApplicationStatus (participant-dashboard-queries.ts) for the
//     ownership-scoped application lookup — never a client-supplied
//     application_id.
//   - decryptActiveQrCredential (qr-credential-issuance.ts) for the
//     server-only ciphertext -> canonical payload reconstruction — this
//     module is its first real caller; the crypto/key-resolution logic
//     itself is entirely unmodified.
//
// Eligibility rule (approved): only applications.status = 'accepted' may
// view/hold an operational QR. This is enforced independently at THREE
// layers, all already existing before this module: the issuance/reissue
// RPCs (request_my_qr_issuance_transactional etc., accepted-only checked
// under row lock), the live scan-time re-check (scan_attempt_transactional
// re-reads applications.status on every scan), and now also here — this
// module additionally short-circuits and never even attempts to look up
// a credential once eligibility already fails, so an ineligible
// participant never triggers a decrypt attempt.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { getMyApplicationStatus, type DashboardParticipantCaller } from '@/lib/dashboard/participant-dashboard-queries';
import { decryptActiveQrCredential } from './qr-credential-issuance';

type ServiceClient = SupabaseClient<Database>;

export interface ParticipantQrDisplay {
  fullName: string;
  country: string | null;
  nationality: string | null;
  attendeeCode: string | null;
  participantType: string | null;
}

// CREDENTIAL_REVOKED is reserved for a FUTURE staff-initiated
// "revoke without replacing" workflow, which does not exist anywhere in
// this codebase today (confirmed by direct audit: no RPC, server
// action, or migration ever sets qr_credentials.revocation_reason_code
// to anything other than 'application_ineligible' — the other four
// vocabulary values in the CHECK constraint are schema-only, never
// written). getMyQrState below never returns this kind; it exists only
// so a future staff-revocation feature has a state to slot into without
// widening this union again. Do not build UI/query logic around it
// until that real backend workflow exists — see the Participant QR
// report's "deferred items" for the full design requirements such a
// feature would need.
export type ParticipantQrState =
  | { kind: 'QR_AVAILABLE'; qrPayload: string; credentialId: string; participant: ParticipantQrDisplay }
  | { kind: 'NOT_YET_AVAILABLE' }
  | { kind: 'NOT_ELIGIBLE' }
  | { kind: 'CREDENTIAL_REVOKED' }
  | { kind: 'ERROR' };

/**
 * Allow-list read of the caller's own display fields — mirrors
 * getScannerParticipantSummary's exact shape (participant-summary.ts),
 * reused here rather than re-invented, since the operator-facing and
 * self-facing display needs are identical (name/country/nationality,
 * nothing more).
 */
async function getOwnDisplaySummary(service: ServiceClient, applicationId: string): Promise<ParticipantQrDisplay> {
  const { data } = await service.from('applications').select('full_name, country, nationality, application_number, participant_type').eq('id', applicationId).maybeSingle();
  return {
    fullName: data?.full_name ?? '',
    country: data?.country ?? null,
    nationality: data?.nationality ?? null,
    attendeeCode: data?.application_number ?? null,
    participantType: data?.participant_type ?? null,
  };
}

/**
 * Resolves the caller's current QR state. Never throws on an expected
 * ineligibility/absence case — only genuinely unexpected failures
 * (decrypt/key errors, unreachable service) collapse to 'ERROR', logged
 * server-side only, never surfaced with detail to the caller.
 */
export async function getMyQrState(caller: DashboardParticipantCaller): Promise<ParticipantQrState> {
  const applicationResult = await getMyApplicationStatus(caller);

  if (applicationResult.kind === 'error') {
    console.error('getMyQrState: application lookup failed', { userId: caller.userId, message: applicationResult.message });
    return { kind: 'ERROR' };
  }
  if (applicationResult.kind === 'unauthorized') {
    // getMyApplicationStatus's own contract never actually returns this
    // (it has no internal auth check of its own to fail — see its doc
    // comment), but CardResult<T> is a shared union across every
    // dashboard query function. Treated as ERROR rather than silently
    // matched by the 'data' branch below, which would be a type error
    // and — worse — would treat "we couldn't verify" as "verified empty".
    console.error('getMyQrState: unexpected unauthorized result from getMyApplicationStatus', { userId: caller.userId });
    return { kind: 'ERROR' };
  }
  if (applicationResult.kind === 'empty') {
    // No application row at all for this account — nothing to be
    // eligible or ineligible about yet.
    return { kind: 'NOT_YET_AVAILABLE' };
  }

  const { applicationId, status } = applicationResult.value;

  if (status === 'rejected' || status === 'withdrawn') {
    return { kind: 'NOT_ELIGIBLE' };
  }
  if (status !== 'accepted') {
    // draft / submitted / under_review / waitlisted — may still become
    // eligible later, never eligible right now.
    return { kind: 'NOT_YET_AVAILABLE' };
  }

  // status === 'accepted' from here on.
  const { data: credential, error: credentialError } = await caller.service
    .from('qr_credentials')
    .select('id, status')
    .eq('application_id', applicationId)
    .eq('status', 'active')
    .maybeSingle();

  if (credentialError) {
    console.error('getMyQrState: credential lookup failed', { userId: caller.userId, applicationId, message: credentialError.message });
    return { kind: 'ERROR' };
  }
  if (!credential) {
    // Accepted, but no active credential yet — the page's own issuance
    // action (self-service, per the approved Phase 6.1 policy) is what
    // gets a participant from here to QR_AVAILABLE; this function only
    // reports current state, never issues one itself.
    return { kind: 'NOT_YET_AVAILABLE' };
  }

  try {
    const qrPayload = await decryptActiveQrCredential(caller.service, credential.id);
    const participant = await getOwnDisplaySummary(caller.service, applicationId);
    return { kind: 'QR_AVAILABLE', qrPayload, credentialId: credential.id, participant };
  } catch (err) {
    // Fail-closed per the approved contract: a missing/malformed/retired
    // encryption key, or any other decrypt failure, must never surface
    // crypto detail to the participant, and must never fall back to
    // showing something else. Distinguish "the row itself isn't usable"
    // (CREDENTIAL_REVOKED) from a genuine unexpected failure (ERROR) —
    // but by the time we reach this branch the row is already known
    // status='active', so any throw here is necessarily a decrypt/key
    // problem, not a lifecycle-state problem; report ERROR, not
    // CREDENTIAL_REVOKED, since the credential IS the current one and a
    // future retry (once the key issue is fixed) should succeed.
    console.error('getMyQrState: decryptActiveQrCredential failed', { userId: caller.userId, applicationId, credentialId: credential.id, err });
    return { kind: 'ERROR' };
  }
}
