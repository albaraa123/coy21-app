// tests/attendance/scan-qr-attempt-live.test.ts
//
// Live, end-to-end coverage for the Phase 7A scanner QR bridge:
// scan_qr_attempt_transactional (SQL, migration 20260814100000) plus its
// intended trusted-server-boundary caller shape — proving genuine
// Phase-6.1-issued credentials (via src/lib/attendance/qr-credential-issuance.ts,
// not synthetic random token_hash fixtures) resolve correctly through to
// the existing, unmodified scan_attempt_transactional admission engine.
//
// Fixture pattern follows tests/attendance/scan-attempt-live.test.ts and
// tests/attendance/scanner-device-access-live.test.ts exactly: real
// Supabase Auth users, real conference_days/rooms/tracks/session_types/
// sessions/scanner_assignments rows, careful afterAll cleanup.
//
// Token resolution boundary under test here is the SQL function's hash
// lookup directly (token_hash computed via the real Phase 6.1
// hashQrToken/parseCanonicalQrPayload) — the trusted Next.js server action
// wrapper (scanQrAttemptConfirm) is covered separately in
// tests/attendance/scan-qr-attempt-server-boundary.test.ts since its
// requireScannerDeviceCaller() call cannot be forged outside a real
// Next.js request context (same structural constraint documented in
// scanner-device-access-live.test.ts).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { issueMyQrCredential, reissueMyQrCredential } from '@/lib/attendance/qr-credential-issuance';
import { parseCanonicalQrPayload, hashQrToken } from '@/lib/attendance/qr-token-crypto';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000 });

let scannerId: string;
let staffId: string;
let conferenceDayId: string;
let trackId: string;
let sessionTypeId: string;

const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const sessionIds: string[] = [];
const roomIds: string[] = [];
const conferenceDayIds: string[] = [];
const scannerAssignmentIds: string[] = [];
let roomCounter = 0;

async function createRoom(): Promise<string> {
  roomCounter += 1;
  const { data, error } = await admin
    .from('rooms')
    .insert({ code: `SCAN-QR-ROOM-${roomCounter}`, name_ar: 'قاعة', name_en: `Room ${roomCounter}`, capacity: 100 })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create room: ${error?.message}`);
  roomIds.push(data.id);
  return data.id;
}

async function createSession(overrides: Partial<Database['public']['Tables']['sessions']['Insert']> & { session_code: string }) {
  const roomForSession = overrides.room_id ?? (await createRoom());
  const { data, error } = await admin
    .from('sessions')
    .insert({
      title_ar: 'ج',
      title_en: 'Session',
      conference_day_id: conferenceDayId,
      start_time: '2026-09-19T09:00:00Z',
      end_time: '2026-09-19T10:00:00Z',
      track_id: trackId,
      session_type_id: sessionTypeId,
      language: 'bilingual',
      difficulty_level: 'all_levels',
      capacity: 10,
      is_mandatory: false,
      status: 'confirmed',
      admission_policy: 'open',
      ...overrides,
      room_id: roomForSession,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create session ${overrides.session_code}: ${error?.message}`);
  sessionIds.push(data.id);
  return data.id;
}

async function assignScannerToSession(sessionId: string) {
  const { data, error } = await admin
    .from('scanner_assignments')
    .insert({ scanner_user_id: scannerId, session_id: sessionId, assigned_by: staffId })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to assign scanner to session ${sessionId}: ${error?.message}`);
  scannerAssignmentIds.push(data.id);
}

async function createParticipantWithSession() {
  const email = `scan-qr-live-${randomUUID()}@test.local`;
  const { data: user, error: userError } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  if (userError || !user?.user) throw new Error(`createUser failed: ${userError?.message}`);
  applicantUserIds.push(user.user.id);

  const { data: app, error: appError } = await admin
    .from('applications')
    .insert({ applicant_id: user.user.id, status: 'accepted' })
    .select('id')
    .single();
  if (appError || !app) throw new Error(`Failed to create application: ${appError?.message}`);
  applicationIds.push(app.id);

  const client = createClient<Database>(URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: 'password123' });
  if (signInError) throw new Error(`sign-in failed: ${signInError.message}`);

  return { userId: user.user.id, applicationId: app.id, client };
}

/** Issues a REAL Phase 6.1 credential for a participant and returns its resolved raw token hash for direct SQL-layer testing. */
async function issueRealCredential(requester: ReturnType<typeof createClient<Database>>) {
  const result = await issueMyQrCredential(requester, admin, randomUUID());
  if (result.outcome !== 'issued') throw new Error(`Unexpected issuance outcome: ${result.outcome}`);
  const parsed = parseCanonicalQrPayload(result.qrPayload!);
  if (!parsed.ok) throw new Error('unreachable: issued payload must be canonical');
  return { credentialId: result.credentialId!, qrPayload: result.qrPayload!, rawToken: parsed.rawToken };
}

async function callScanQr(params: { tokenHash: Buffer; sessionId: string; deviceIdentifier?: string | null }) {
  const { data, error } = await admin.rpc('scan_qr_attempt_transactional', {
    p_token_hash: `\\x${params.tokenHash.toString('hex')}`,
    p_session_id: params.sessionId,
    p_scanned_by: scannerId,
    p_device_identifier: (params.deviceIdentifier ?? null) as string,
    p_is_override_caller: false,
  });
  return { data, error };
}

afterAll(async () => {
  if (sessionIds.length > 0) {
    await admin.from('scan_attempts').delete().in('session_id', sessionIds);
    await admin.from('attendance_records').delete().in('session_id', sessionIds);
  }
  if (scannerAssignmentIds.length > 0) await admin.from('scanner_assignments').delete().in('id', scannerAssignmentIds);
  if (sessionIds.length > 0) await admin.from('sessions').delete().in('id', sessionIds);
  if (trackId) await admin.from('tracks').delete().eq('id', trackId);
  if (sessionTypeId) await admin.from('session_types').delete().eq('id', sessionTypeId);
  if (roomIds.length > 0) await admin.from('rooms').delete().in('id', roomIds);
  if (conferenceDayIds.length > 0) await admin.from('conference_days').delete().in('id', conferenceDayIds);
  if (applicationIds.length > 0) await admin.from('applications').delete().in('id', applicationIds);
});

beforeAll(async () => {
  const { data: scanner } = await admin.auth.admin.createUser({ email: `scan-qr-live-scanner-${randomUUID()}@test.local`, password: 'password123', email_confirm: true });
  scannerId = scanner!.user!.id;
  await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', scannerId);

  const { data: staff } = await admin.auth.admin.createUser({ email: `scan-qr-live-staff-${randomUUID()}@test.local`, password: 'password123', email_confirm: true });
  staffId = staff!.user!.id;
  await admin.from('profiles').update({ role: 'program_attendance_manager' }).eq('id', staffId);

  const { data: day } = await admin
    .from('conference_days')
    .insert({ conference_date: '2026-09-19', label_ar: 'يوم', label_en: 'Day', display_order: 1 })
    .select('id')
    .single();
  conferenceDayId = day!.id;
  conferenceDayIds.push(conferenceDayId);

  const { data: track } = await admin.from('tracks').insert({ code: 'SCAN-QR-TRACK', name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;

  const { data: sessionType } = await admin.from('session_types').insert({ code: 'SCAN-QR-TYPE', name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;
});

describe('scan_qr_attempt_transactional — real Phase 6.1 credential resolves through the existing attendance engine', () => {
  it('a genuine, active, Phase-6.1-issued QR credential admits the participant (open policy)', async () => {
    const fx = await createParticipantWithSession();
    const sessionId = await createSession({ session_code: 'open-1' });
    await assignScannerToSession(sessionId);
    const cred = await issueRealCredential(fx.client);

    const { data, error } = await callScanQr({ tokenHash: hashQrToken(cred.rawToken), sessionId, deviceIdentifier: 'device-1' });
    expect(error, `RPC error: ${error?.message}`).toBeNull();
    expect(data!.result).toBe('flexible_admitted');
    expect(data!.application_id).toBe(fx.applicationId);
    expect(data!.resulting_attendance_id).toBeTruthy();
  });

  it('a mutated (bit-flipped) token is rejected as invalid_qr, never admitted', async () => {
    const fx = await createParticipantWithSession();
    const sessionId = await createSession({ session_code: 'mutated-1' });
    await assignScannerToSession(sessionId);
    const cred = await issueRealCredential(fx.client);

    const mutated = Buffer.from(cred.rawToken);
    mutated[0] ^= 0xff; // flip a byte -> different raw token -> different hash -> no matching row
    const { data, error } = await callScanQr({ tokenHash: hashQrToken(mutated), sessionId });
    expect(error).toBeNull();
    expect(data!.result).toBe('invalid_qr');
    expect(data!.application_id).toBeNull();
  });

  it('a reissued credential works with its NEW token; the OLD token now returns invalid_qr', async () => {
    const fx = await createParticipantWithSession();
    const sessionId = await createSession({ session_code: 'reissue-1' });
    await assignScannerToSession(sessionId);
    const original = await issueRealCredential(fx.client);

    const reissued = await reissueMyQrCredential(fx.client, admin, {
      requestKey: randomUUID(),
      expectedCurrentCredentialId: original.credentialId,
      reissueReasonCode: 'lost_or_stolen_phone',
      reissueNote: '',
    });
    expect(reissued.outcome).toBe('reissued');
    const newParsed = parseCanonicalQrPayload(reissued.qrPayload!);
    if (!newParsed.ok) throw new Error('unreachable');

    // OLD token -> now 'replaced' -> invalid_qr, never admits.
    const oldResult = await callScanQr({ tokenHash: hashQrToken(original.rawToken), sessionId, deviceIdentifier: 'd-old' });
    expect(oldResult.error).toBeNull();
    expect(oldResult.data!.result).toBe('invalid_qr');
    expect(oldResult.data!.application_id).toBeNull();

    // NEW token -> active -> admits normally through the same bridge.
    const newResult = await callScanQr({ tokenHash: hashQrToken(newParsed.rawToken), sessionId, deviceIdentifier: 'd-new' });
    expect(newResult.error).toBeNull();
    expect(newResult.data!.result).toBe('flexible_admitted');
    expect(newResult.data!.application_id).toBe(fx.applicationId);
  });

  it('a completely unknown token_hash (never issued) resolves to invalid_qr', async () => {
    const sessionId = await createSession({ session_code: 'unknown-1' });
    await assignScannerToSession(sessionId);
    const { randomBytes } = await import('node:crypto');
    const { data, error } = await callScanQr({ tokenHash: randomBytes(32), sessionId });
    expect(error).toBeNull();
    expect(data!.result).toBe('invalid_qr');
    expect(data!.application_id).toBeNull();
  });

  it('duplicate attendance: scanning the SAME active credential twice for the same session returns duplicate on the second scan', async () => {
    const fx = await createParticipantWithSession();
    const sessionId = await createSession({ session_code: 'dup-1' });
    await assignScannerToSession(sessionId);
    const cred = await issueRealCredential(fx.client);
    const tokenHash = hashQrToken(cred.rawToken);

    const first = await callScanQr({ tokenHash, sessionId, deviceIdentifier: 'd1' });
    expect(first.data!.result).toBe('flexible_admitted');

    const second = await callScanQr({ tokenHash, sessionId, deviceIdentifier: 'd2' });
    expect(second.error).toBeNull();
    expect(second.data!.result).toBe('duplicate');
    expect(second.data!.application_id).toBe(fx.applicationId);
  });

  it('capacity rejection: a full session returns full for a valid, otherwise-eligible credential', async () => {
    const sessionId = await createSession({ session_code: 'full-1', capacity: 1 });
    await assignScannerToSession(sessionId);

    const fillFx = await createParticipantWithSession();
    const fillCred = await issueRealCredential(fillFx.client);
    const fillResult = await callScanQr({ tokenHash: hashQrToken(fillCred.rawToken), sessionId, deviceIdentifier: 'd-fill' });
    expect(fillResult.data!.result).toBe('flexible_admitted');

    const overflowFx = await createParticipantWithSession();
    const overflowCred = await issueRealCredential(overflowFx.client);
    const overflowResult = await callScanQr({ tokenHash: hashQrToken(overflowCred.rawToken), sessionId, deviceIdentifier: 'd-overflow' });
    expect(overflowResult.error).toBeNull();
    expect(overflowResult.data!.result).toBe('full');
    expect(overflowResult.data!.application_id).toBe(overflowFx.applicationId);
  });

  it('exactly one scan_attempts row is created per resolved-and-admitted scan (no double-insert across the wrapper + delegated function)', async () => {
    const fx = await createParticipantWithSession();
    const sessionId = await createSession({ session_code: 'exactly-one-admitted' });
    await assignScannerToSession(sessionId);
    const cred = await issueRealCredential(fx.client);

    const { data } = await callScanQr({ tokenHash: hashQrToken(cred.rawToken), sessionId, deviceIdentifier: 'd-exactly-one' });
    expect(data!.result).toBe('flexible_admitted');

    const { data: attempts, error } = await admin.from('scan_attempts').select('id').eq('application_id', fx.applicationId).eq('session_id', sessionId);
    expect(error).toBeNull();
    expect(attempts).toHaveLength(1);
    expect(attempts![0].id).toBe(data!.id);
  });

  it('exactly one scan_attempts row is created for an unresolved (unknown) QR, with application_id null', async () => {
    const sessionId = await createSession({ session_code: 'exactly-one-unknown' });
    await assignScannerToSession(sessionId);
    const { randomBytes } = await import('node:crypto');
    const unknownHash = randomBytes(32);

    const { data } = await callScanQr({ tokenHash: unknownHash, sessionId, deviceIdentifier: 'd-unknown' });
    expect(data!.result).toBe('invalid_qr');
    expect(data!.application_id).toBeNull();

    const { data: attempts, error } = await admin.from('scan_attempts').select('id, application_id').eq('id', data!.id);
    expect(error).toBeNull();
    expect(attempts).toHaveLength(1);
    expect(attempts![0].application_id).toBeNull();
  });

  it('malformed token_hash (wrong byte length) is rejected before any qr_credentials lookup, exactly one invalid_qr scan_attempts row', async () => {
    const sessionId = await createSession({ session_code: 'malformed-hash' });
    await assignScannerToSession(sessionId);
    const { randomBytes } = await import('node:crypto');
    const wrongLengthHash = randomBytes(16); // not 32 bytes

    const { data, error } = await admin.rpc('scan_qr_attempt_transactional', {
      p_token_hash: `\\x${wrongLengthHash.toString('hex')}`,
      p_session_id: sessionId,
      p_scanned_by: scannerId,
      p_device_identifier: 'd-malformed' as string,
      p_is_override_caller: false,
    });
    expect(error).toBeNull();
    expect(data!.result).toBe('invalid_qr');
    expect(data!.application_id).toBeNull();
  });

  it('the wrapper never returns token_hash, token_ciphertext, or any credential secret in its response', async () => {
    const fx = await createParticipantWithSession();
    const sessionId = await createSession({ session_code: 'no-secret-leak' });
    await assignScannerToSession(sessionId);
    const cred = await issueRealCredential(fx.client);

    const { data } = await callScanQr({ tokenHash: hashQrToken(cred.rawToken), sessionId, deviceIdentifier: 'd-secret-check' });
    const responseKeys = Object.keys(data as unknown as Record<string, unknown>);
    expect(responseKeys).not.toContain('token_hash');
    expect(responseKeys).not.toContain('token_ciphertext');
    expect(JSON.stringify(data)).not.toContain(cred.rawToken.toString('hex'));
    expect(JSON.stringify(data)).not.toContain(cred.qrPayload);
  });
});
