// src/lib/attendance/qr-credential-issuance.ts
//
// The missing Node-side caller for Phase 6's approved reservation/finalizer
// RPCs — see docs/superpowers/specs/2026-08-12-qr-token-format-and-lifecycle.md
// for the full canonical contract this module implements. Phase 6 itself
// deliberately built only the storage/lifecycle layer (reservation RPCs +
// finalizers accepting precomputed token_hash/token_ciphertext) and left the
// cryptographic generation step to "Node's server-side code" per that
// migration's own comments — this module IS that code.
//
// Server-only by convention (see qr-token-crypto.ts's header note on why
// there is no `server-only` package import). Never import this module from
// a 'use client' file — every export here either generates/handles raw
// token bytes or returns a QR payload string that must only reach a
// trusted server-side caller.
'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import {
  generateQrTokenMaterial,
  hashQrToken,
  encryptQrToken,
  decryptQrToken,
  canonicalEncodeQrToken,
  QR_TOKEN_VERSION,
} from './qr-token-crypto';
import { resolveQrEncryptionKey } from './qr-encryption-keys';

type ServiceClient = SupabaseClient<Database>;

// request_my_qr_issuance_transactional / request_staff_qr_issuance_transactional
// / request_my_qr_reissue_transactional / request_staff_qr_reissue_transactional
// are SECURITY DEFINER but granted EXECUTE only to `authenticated` (see
// supabase/migrations/20260805235959_phase6_qr_issuance_reissue.sql, e.g.
// line 2337) and internally derive the caller from auth.uid() — a
// service_role client has no auth.uid() and is rejected outright ("permission
// denied for function ..." even reaches the grant check before that, since
// service_role itself has no EXECUTE grant on these four functions at all).
// So issuance/reissue genuinely needs TWO clients: the requester's own
// authenticated client for the reservation step, and a service-role client
// for the finalizer (service_role-only) and for reading
// qr_encryption_key_registry (locked out for anon/authenticated). This
// mirrors the real production shape: a participant's own browser session
// reserves; trusted server-side code then generates/encrypts/finalizes.
type AuthenticatedClient = SupabaseClient<Database>;

function toByteaHex(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`;
}

function fromByteaHex(value: string): Buffer {
  // PostgREST bytea JSON encoding: "\x" followed by hex.
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  return Buffer.from(hex, 'hex');
}

async function getActiveEncryptionKeyVersion(service: ServiceClient): Promise<number> {
  const { data, error } = await service
    .from('qr_encryption_key_registry')
    .select('key_version')
    .eq('status', 'active')
    .single();
  if (error || !data) throw new Error('No active QR encryption key version found');
  return data.key_version;
}

export interface QrIssuanceOutcome {
  outcome: string;
  credentialId: string | null;
  /** Only present when outcome === 'issued' (or the idempotent 'already_finalized' replay). Never persisted, never logged. */
  qrPayload: string | null;
}

/**
 * Full participant self-service issuance flow: reserve -> generate/hash/
 * encrypt (Node-side, this call) -> finalize. Mirrors the exact sequence
 * documented in the draft spec's "Full issuance flow" section, now actually
 * implemented rather than left as prose.
 */
export async function issueMyQrCredential(
  requester: AuthenticatedClient,
  service: ServiceClient,
  requestKey: string
): Promise<QrIssuanceOutcome> {
  const { data: reservation, error: reservationError } = await requester.rpc('request_my_qr_issuance_transactional', {
    p_request_key: requestKey,
  });
  if (reservationError) throw new Error(reservationError.message);
  if (!reservation) throw new Error('request_my_qr_issuance_transactional returned no result');

  if (reservation.outcome !== 'reserved') {
    // active_credential_already_exists / another_operation_pending / etc. —
    // no token is generated; caller decides how to handle (e.g. redisplay
    // path for an existing active credential).
    return { outcome: reservation.outcome ?? 'unknown', credentialId: reservation.credential_id ?? null, qrPayload: null };
  }

  return finalizeGeneratedIssuance(service, reservation.operation_id!);
}

/** Staff-initiated issuance — same finalize step, different reservation RPC. */
export async function issueStaffQrCredential(
  requester: AuthenticatedClient,
  service: ServiceClient,
  params: { requestKey: string; applicationId: string; issuanceReasonCode: string; issuanceNote: string; bulkBatchId?: string }
): Promise<QrIssuanceOutcome> {
  const { data: reservation, error: reservationError } = await requester.rpc('request_staff_qr_issuance_transactional', {
    p_request_key: params.requestKey,
    p_application_id: params.applicationId,
    p_issuance_reason_code: params.issuanceReasonCode,
    p_issuance_note: params.issuanceNote,
    p_bulk_batch_id: params.bulkBatchId,
  });
  if (reservationError) throw new Error(reservationError.message);
  if (!reservation) throw new Error('request_staff_qr_issuance_transactional returned no result');

  if (reservation.outcome !== 'reserved') {
    return { outcome: reservation.outcome ?? 'unknown', credentialId: reservation.credential_id ?? null, qrPayload: null };
  }

  return finalizeGeneratedIssuance(service, reservation.operation_id!);
}

async function finalizeGeneratedIssuance(service: ServiceClient, operationId: string): Promise<QrIssuanceOutcome> {
  // Node-side cryptographic generation — the step Phase 6's finalizers
  // deliberately never perform themselves (see this module's header).
  const credentialId = randomUUID();
  const keyVersion = await getActiveEncryptionKeyVersion(service);
  const key = resolveQrEncryptionKey(keyVersion);
  const { rawToken, qrPayload } = generateQrTokenMaterial();
  const tokenHash = hashQrToken(rawToken);
  const envelope = encryptQrToken(rawToken, key);
  // rawToken/qrPayload go out of scope after this function returns (or
  // throws) — never persisted, never logged, per the canonical contract's
  // plaintext-handling rules. A caller that needs the payload again after
  // this call must decrypt via decryptActiveQrCredential, not regenerate.

  const { data: result, error } = await service.rpc('finalize_qr_issuance_for_server', {
    p_operation_id: operationId,
    p_credential_id: credentialId,
    p_token_hash: toByteaHex(tokenHash),
    p_token_ciphertext: toByteaHex(envelope),
    p_token_version: QR_TOKEN_VERSION,
    p_encryption_key_version: keyVersion,
  });
  if (error) throw new Error(error.message);
  if (!result) throw new Error('finalize_qr_issuance_for_server returned no result');

  if (result.outcome === 'issued' || result.outcome === 'already_finalized') {
    return { outcome: result.outcome, credentialId: result.credential_id ?? credentialId, qrPayload };
  }
  // key_version_not_active / token_hash_conflict / idempotency_conflict /
  // operation_expired / etc. — no credential was newly issued with THIS
  // payload; the generated material is simply discarded (never persisted),
  // matching the canonical contract's retry rule (a fresh call must
  // generate fresh bytes, never reuse this attempt's rawToken).
  return { outcome: result.outcome ?? 'unknown', credentialId: result.credential_id ?? null, qrPayload: null };
}

/**
 * Reissue: always generates an entirely new, independent token — never
 * derived from or related to the old one. Same finalize sequence, staff or
 * participant self-service reservation RPC depending on caller.
 */
export async function reissueMyQrCredential(
  requester: AuthenticatedClient,
  service: ServiceClient,
  params: { requestKey: string; expectedCurrentCredentialId: string; reissueReasonCode: string; reissueNote: string }
): Promise<QrIssuanceOutcome> {
  const { data: reservation, error: reservationError } = await requester.rpc('request_my_qr_reissue_transactional', {
    p_request_key: params.requestKey,
    p_expected_current_credential_id: params.expectedCurrentCredentialId,
    p_reissue_reason_code: params.reissueReasonCode,
    p_reissue_note: params.reissueNote,
  });
  if (reservationError) throw new Error(reservationError.message);
  if (!reservation) throw new Error('request_my_qr_reissue_transactional returned no result');

  if (reservation.outcome !== 'reserved') {
    return { outcome: reservation.outcome ?? 'unknown', credentialId: reservation.credential_id ?? null, qrPayload: null };
  }

  return finalizeGeneratedReissue(service, reservation.operation_id!);
}

export async function reissueStaffQrCredential(
  requester: AuthenticatedClient,
  service: ServiceClient,
  params: {
    requestKey: string;
    applicationId: string;
    expectedCurrentCredentialId: string;
    reissueReasonCode: string;
    reissueNote: string;
    bulkBatchId?: string;
  }
): Promise<QrIssuanceOutcome> {
  const { data: reservation, error: reservationError } = await requester.rpc('request_staff_qr_reissue_transactional', {
    p_request_key: params.requestKey,
    p_application_id: params.applicationId,
    p_expected_current_credential_id: params.expectedCurrentCredentialId,
    p_reissue_reason_code: params.reissueReasonCode,
    p_reissue_note: params.reissueNote,
    p_bulk_batch_id: params.bulkBatchId,
  });
  if (reservationError) throw new Error(reservationError.message);
  if (!reservation) throw new Error('request_staff_qr_reissue_transactional returned no result');

  if (reservation.outcome !== 'reserved') {
    return { outcome: reservation.outcome ?? 'unknown', credentialId: reservation.credential_id ?? null, qrPayload: null };
  }

  return finalizeGeneratedReissue(service, reservation.operation_id!);
}

async function finalizeGeneratedReissue(service: ServiceClient, operationId: string): Promise<QrIssuanceOutcome> {
  const credentialId = randomUUID();
  const keyVersion = await getActiveEncryptionKeyVersion(service);
  const key = resolveQrEncryptionKey(keyVersion);
  // Fresh, independent token generation — never derived from the old
  // credential in any way, per the canonical contract's reissue rule.
  const { rawToken, qrPayload } = generateQrTokenMaterial();
  const tokenHash = hashQrToken(rawToken);
  const envelope = encryptQrToken(rawToken, key);

  const { data: result, error } = await service.rpc('finalize_qr_reissue_for_server', {
    p_operation_id: operationId,
    p_new_credential_id: credentialId,
    p_new_token_hash: toByteaHex(tokenHash),
    p_new_token_ciphertext: toByteaHex(envelope),
    p_new_token_version: QR_TOKEN_VERSION,
    p_new_encryption_key_version: keyVersion,
  });
  if (error) throw new Error(error.message);
  if (!result) throw new Error('finalize_qr_reissue_for_server returned no result');

  if (result.outcome === 'reissued' || result.outcome === 'already_finalized') {
    return { outcome: result.outcome, credentialId: result.credential_id ?? credentialId, qrPayload };
  }
  return { outcome: result.outcome ?? 'unknown', credentialId: result.credential_id ?? null, qrPayload: null };
}

/**
 * Server-only rendering support: decrypt an existing ACTIVE credential's
 * stored ciphertext back to its raw bytes and reconstruct the canonical QR
 * payload, proving token_ciphertext is genuinely recoverable rather than
 * write-only. Not wired to any UI in this subphase (Phase 6.1) — only the
 * cryptographic round-trip capability is required here.
 */
export async function decryptActiveQrCredential(service: ServiceClient, credentialId: string): Promise<string> {
  const { data: credential, error } = await service
    .from('qr_credentials')
    .select('status, token_ciphertext, encryption_key_version')
    .eq('id', credentialId)
    .single();
  if (error || !credential) throw new Error('Credential not found');
  if (credential.status !== 'active') throw new Error('Credential is not active');
  if (credential.encryption_key_version == null) throw new Error('Credential has no encryption_key_version');

  const key = resolveQrEncryptionKey(credential.encryption_key_version);
  const envelope = fromByteaHex(credential.token_ciphertext as unknown as string);
  const rawToken = decryptQrToken(envelope, key);
  return canonicalEncodeQrToken(rawToken);
}
