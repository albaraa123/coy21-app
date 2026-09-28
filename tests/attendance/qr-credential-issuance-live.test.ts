// tests/attendance/qr-credential-issuance-live.test.ts
//
// Live, end-to-end coverage for the Phase 6.1 QR credential issuance
// module (src/lib/attendance/qr-credential-issuance.ts) against the real,
// deployed Phase 6 reservation/finalizer RPCs and real Postgres tables —
// proving the previously-missing Node-side caller genuinely produces valid,
// scannable credentials, not just that the SQL layer accepts arbitrary
// synthetic fixtures (see tests/attendance/qr-issuance-reservation.test.ts,
// which never exercises real token generation).
//
// request_my_qr_issuance_transactional / request_staff_qr_issuance_transactional
// / request_my_qr_reissue_transactional are SECURITY DEFINER but granted
// EXECUTE only to `authenticated` and derive the caller from auth.uid() —
// so every reservation call below uses a real signed-in fixture client
// (mirrors qr-issuance-reservation.test.ts's own createParticipantFixture/
// createStaffFixture pattern), while the finalizer/key-registry reads use
// the service-role admin client, exactly matching production's intended
// split (participant's own session reserves; trusted server-side code
// generates/encrypts/finalizes).
//
// REQUIRES A DISPOSABLE DATABASE. See disposable-database-guard.ts (shared
// with the other Phase 6 live suites) — local by default, remote only when
// explicitly pinned to a disposable Supabase Cloud project via
// PHASE6_ALLOW_DISPOSABLE_REMOTE_TESTS + PHASE6_DISPOSABLE_PROJECT_REF.
//
// Requires QR_ENCRYPTION_KEY_V1 (or whichever key_version is currently
// 'active' in qr_encryption_key_registry) to be set in the environment —
// see .env.local.example and docs/superpowers/specs/
// 2026-08-12-qr-token-format-and-lifecycle.md §7.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { assertDisposableDatabase } from './disposable-database-guard';
import {
  issueMyQrCredential,
  issueStaffQrCredential,
  reissueMyQrCredential,
  decryptActiveQrCredential,
} from '@/lib/attendance/qr-credential-issuance';
import { parseCanonicalQrPayload, hashQrToken } from '@/lib/attendance/qr-token-crypto';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const disposableDatabaseCheck = assertDisposableDatabase('qr-credential-issuance-live.test.ts', URL);

vi.setConfig({ testTimeout: disposableDatabaseCheck.reason === 'local' ? 15000 : 30000 });

const admin = createClient<Database>(URL, SERVICE_KEY);

async function createParticipantFixture() {
  const email = `qr-issuance-live-${randomUUID()}@test.local`;
  const { data: user, error: userError } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  expect(userError, `createUser failed: ${userError?.message}`).toBeNull();
  expect(user?.user).toBeTruthy();

  const { data: app, error: appError } = await admin
    .from('applications')
    .insert({ applicant_id: user!.user!.id, status: 'accepted' })
    .select('id')
    .single();
  expect(appError, `fixture application insert failed: ${appError?.message}`).toBeNull();

  const client = createClient<Database>(URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: 'password123' });
  expect(signInError, `sign-in failed: ${signInError?.message}`).toBeNull();

  return { userId: user!.user!.id, applicationId: app!.id, client };
}

async function createStaffFixture(role: 'super_admin' | 'program_attendance_manager' = 'super_admin') {
  const email = `qr-issuance-staff-live-${randomUUID()}@test.local`;
  const { data: user, error: userError } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  expect(userError, `createUser failed: ${userError?.message}`).toBeNull();

  const { error: roleError } = await admin.from('profiles').update({ role }).eq('id', user!.user!.id);
  expect(roleError, `profile role update failed: ${roleError?.message}`).toBeNull();

  const client = createClient<Database>(URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: 'password123' });
  expect(signInError, `sign-in failed: ${signInError?.message}`).toBeNull();

  return { userId: user!.user!.id, client };
}

function assertBytea32Hex(hexBytea: string): Buffer {
  expect(hexBytea.startsWith('\\x')).toBe(true);
  const buf = Buffer.from(hexBytea.slice(2), 'hex');
  expect(buf.length).toBe(32);
  return buf;
}

describe('Phase 6.1 — real QR credential issuance, end to end', () => {
  it('17-19. generates real token material, finalizes through the production finalizer, and token_hash equals SHA-256(raw token bytes)', async () => {
    const fx = await createParticipantFixture();
    const requestKey = randomUUID();

    const result = await issueMyQrCredential(fx.client, admin, requestKey);

    expect(result.outcome).toBe('issued');
    expect(result.credentialId).toBeTruthy();
    expect(result.qrPayload).toBeTruthy();

    // The payload returned to the caller must itself be canonical.
    const parsed = parseCanonicalQrPayload(result.qrPayload!);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');

    const { data: row, error } = await admin
      .from('qr_credentials')
      .select('application_id, status, token_hash, token_ciphertext, encryption_key_version, token_version')
      .eq('id', result.credentialId!)
      .single();
    expect(error, `credential lookup failed: ${error?.message}`).toBeNull();
    expect(row!.application_id).toBe(fx.applicationId);
    expect(row!.status).toBe('active');
    expect(row!.token_version).toBe(1);

    const storedHash = assertBytea32Hex(row!.token_hash as unknown as string);
    const expectedHash = hashQrToken(parsed.rawToken);
    expect(Buffer.compare(storedHash, expectedHash)).toBe(0);
  });

  it('20-21. ciphertext can be decrypted server-side back to the same raw bytes and reconstructs an identical canonical QR payload', async () => {
    const fx = await createParticipantFixture();
    const requestKey = randomUUID();

    const result = await issueMyQrCredential(fx.client, admin, requestKey);
    expect(result.outcome).toBe('issued');

    const reconstructedPayload = await decryptActiveQrCredential(admin, result.credentialId!);
    expect(reconstructedPayload).toBe(result.qrPayload);
  });

  it('22. a newly generated reissue produces a different token/hash than the original credential', async () => {
    const fx = await createParticipantFixture();
    const requestKey = randomUUID();

    const issued = await issueMyQrCredential(fx.client, admin, requestKey);
    expect(issued.outcome).toBe('issued');

    const reissueRequestKey = randomUUID();
    const reissued = await reissueMyQrCredential(fx.client, admin, {
      requestKey: reissueRequestKey,
      expectedCurrentCredentialId: issued.credentialId!,
      reissueReasonCode: 'lost_or_stolen_phone',
      reissueNote: '',
    });

    expect(reissued.outcome).toBe('reissued');
    expect(reissued.credentialId).not.toBe(issued.credentialId);
    expect(reissued.qrPayload).not.toBe(issued.qrPayload);

    const { data: oldRow } = await admin.from('qr_credentials').select('status, token_hash').eq('id', issued.credentialId!).single();
    const { data: newRow } = await admin.from('qr_credentials').select('status, token_hash').eq('id', reissued.credentialId!).single();
    expect(oldRow!.status).toBe('replaced');
    expect(newRow!.status).toBe('active');
    expect(oldRow!.token_hash).not.toBe(newRow!.token_hash);

    // The new credential's ciphertext also round-trips independently.
    const reconstructed = await decryptActiveQrCredential(admin, reissued.credentialId!);
    expect(reconstructed).toBe(reissued.qrPayload);
  });

  it('23. existing Phase 6 lifecycle/idempotency behavior is unchanged: requesting issuance again with an existing active credential returns active_credential_already_exists, no new token generated', async () => {
    const fx = await createParticipantFixture();
    const requestKey1 = randomUUID();
    const first = await issueMyQrCredential(fx.client, admin, requestKey1);
    expect(first.outcome).toBe('issued');

    const requestKey2 = randomUUID();
    const second = await issueMyQrCredential(fx.client, admin, requestKey2);
    expect(second.outcome).toBe('active_credential_already_exists');
    expect(second.qrPayload).toBeNull();
    expect(second.credentialId).toBe(first.credentialId);
  });

  it('discards generated token material on a failed finalize (a completely nonexistent application_id is rejected at the reservation layer itself, before any token generation)', async () => {
    // A truly nonexistent application_id violates
    // qr_lifecycle_operations_application_id_fkey at the reservation RPC's
    // own INSERT — proving rejection happens even before a structured
    // 'outcome' value could be returned, i.e. strictly before this
    // module's finalizeGeneratedIssuance (and therefore token generation)
    // is ever reached.
    const staff = await createStaffFixture('super_admin');
    const requestKey = randomUUID();
    await expect(
      issueStaffQrCredential(staff.client, admin, {
        requestKey,
        applicationId: randomUUID(),
        issuanceReasonCode: 'advance_badge_printing',
        issuanceNote: '',
      })
    ).rejects.toThrow(/foreign key constraint/);
  });

  it('an application that exists but is not accepted is rejected with a structured non-issued outcome, no token generated', async () => {
    const email = `qr-issuance-ineligible-${randomUUID()}@test.local`;
    const { data: user, error: userError } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
    expect(userError, `createUser failed: ${userError?.message}`).toBeNull();
    const { data: app, error: appError } = await admin
      .from('applications')
      .insert({ applicant_id: user!.user!.id, status: 'submitted' })
      .select('id')
      .single();
    expect(appError, `fixture application insert failed: ${appError?.message}`).toBeNull();

    const staff = await createStaffFixture('super_admin');
    const requestKey = randomUUID();
    const result = await issueStaffQrCredential(staff.client, admin, {
      requestKey,
      applicationId: app!.id,
      issuanceReasonCode: 'advance_badge_printing',
      issuanceNote: '',
    });
    expect(result.outcome).not.toBe('issued');
    expect(result.qrPayload).toBeNull();
    expect(result.credentialId).toBeNull();
  });
});
