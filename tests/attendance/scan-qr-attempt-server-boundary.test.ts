// tests/attendance/scan-qr-attempt-server-boundary.test.ts
//
// Live coverage for the trusted Next.js server boundary
// (src/lib/attendance/scan-qr-attempt.ts) that completes Phase 7A —
// distinct from tests/attendance/scan-qr-attempt-live.test.ts, which
// exercises scan_qr_attempt_transactional directly via the service-role
// admin client (proving the SQL bridge itself). This file proves the
// production caller: authorization (requireScannerDeviceCaller +
// verifyScannerScope), canonical QR parsing/hashing at the trusted
// boundary (never in SQL), server-derived scanned_by/override, and the
// exact ScanQrResult response contract.
//
// requireScannerDeviceCaller() itself cannot be forged outside a real
// Next.js request context (no next/headers cookies() to construct) — same
// structural constraint documented in scanner-device-access-live.test.ts
// and admission-management-live.test.ts. So:
//   - scanQrAttemptConfirmForCaller (takes `caller: {userId, service}`
//     directly) is tested end-to-end for every authorization/parsing/
//     contract case below — this is where all the real logic lives;
//     requireScannerDeviceCaller's own body is just "look up auth.uid()"
//     + "check isScannerDeviceRole(profile.role)", proven sufficient by
//     scanner-device-access-live.test.ts's own established pattern.
//   - The "participant cannot invoke scanner operation" boundary is
//     proven the same way that file proves it: isScannerDeviceRole(...)
//     read directly against a real fixture's real persisted profiles.role.
//
// Minimizing fixture accumulation on the disposable Cloud project per
// project convention: reuses ONE scanner fixture, ONE session, and ONE
// real Phase 6.1-issued credential across every test that doesn't need a
// fresh one, rather than creating new rows per test where a shared
// fixture is safe (i.e., every read-only/rejection-path test).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { scanQrAttemptConfirmForCaller } from '@/lib/attendance/scan-qr-attempt';
import { issueMyQrCredential, reissueMyQrCredential } from '@/lib/attendance/qr-credential-issuance';
import { isScannerDeviceRole } from '@/lib/validation/scanner-device';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000 });

let scannerId: string;
let conferenceDayId: string;
let trackId: string;
let sessionTypeId: string;
let sharedSessionId: string;

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
    .insert({ code: `SCAN-QR-BOUNDARY-ROOM-${roomCounter}`, name_ar: 'قاعة', name_en: `Room ${roomCounter}`, capacity: 100 })
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
      start_time: '2026-09-23T09:00:00Z',
      end_time: '2026-09-23T10:00:00Z',
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
    .insert({ scanner_user_id: scannerId, session_id: sessionId, assigned_by: scannerId })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to assign scanner to session ${sessionId}: ${error?.message}`);
  scannerAssignmentIds.push(data.id);
}

async function createParticipantWithSession() {
  const email = `scan-qr-boundary-${randomUUID()}@test.local`;
  const { data: user, error: userError } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  if (userError || !user?.user) throw new Error(`createUser failed: ${userError?.message}`);
  applicantUserIds.push(user.user.id);

  const { data: app, error: appError } = await admin
    .from('applications')
    .insert({ applicant_id: user.user.id, status: 'accepted', full_name: 'Boundary Test Participant', country: 'Oman', nationality: 'Omani' })
    .select('id')
    .single();
  if (appError || !app) throw new Error(`Failed to create application: ${appError?.message}`);
  applicationIds.push(app.id);

  const client = createClient<Database>(URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: 'password123' });
  if (signInError) throw new Error(`sign-in failed: ${signInError.message}`);

  return { userId: user.user.id, applicationId: app.id, client };
}

const scannerCaller = () => ({ userId: scannerId, service: admin });

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
});

beforeAll(async () => {
  const { data: scanner } = await admin.auth.admin.createUser({ email: `scan-qr-boundary-scanner-${randomUUID()}@test.local`, password: 'password123', email_confirm: true });
  scannerId = scanner!.user!.id;
  await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', scannerId);

  const { data: day } = await admin
    .from('conference_days')
    .insert({ conference_date: '2026-09-23', label_ar: 'يوم', label_en: 'Day', display_order: 1 })
    .select('id')
    .single();
  conferenceDayId = day!.id;
  conferenceDayIds.push(conferenceDayId);

  const { data: track } = await admin.from('tracks').insert({ code: 'SCAN-QR-BOUNDARY-TRACK', name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;

  const { data: sessionType } = await admin.from('session_types').insert({ code: 'SCAN-QR-BOUNDARY-TYPE', name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;

  sharedSessionId = await createSession({ session_code: 'boundary-shared' });
  await assignScannerToSession(sharedSessionId);
});

describe('scanQrAttemptConfirmForCaller — trusted server boundary', () => {
  it('1. a valid, real Phase 6.1 QR credential admits through the full trusted boundary, with the exact ScanQrResult contract', async () => {
    const fx = await createParticipantWithSession();
    const issued = await issueMyQrCredential(fx.client, admin, randomUUID());
    expect(issued.outcome).toBe('issued');

    const result = await scanQrAttemptConfirmForCaller(
      { qrPayload: issued.qrPayload!, sessionId: sharedSessionId, deviceIdentifier: 'boundary-device-1' },
      scannerCaller()
    );

    expect(result.result).toBe('flexible_admitted');
    expect(result.scanAttemptId).toBeTruthy();
    expect(result.attendanceId).toBeTruthy();
    expect(result.participantSummary).toEqual({ fullName: 'Boundary Test Participant', country: 'Oman', nationality: 'Omani' });

    // 13. exact ScanQrResult response shape — no extra/leaked keys.
    expect(Object.keys(result).sort()).toEqual(['attendanceId', 'participantSummary', 'result', 'scanAttemptId'].sort());
  });

  it('2. a malformed QR payload produces a controlled invalid_qr result AND exactly one scan_attempts row (audit trail preserved even though parsing failed at the trusted boundary)', async () => {
    const sessionId = await createSession({ session_code: 'boundary-malformed' });
    await assignScannerToSession(sessionId);

    const result = await scanQrAttemptConfirmForCaller(
      { qrPayload: 'not-a-real-qr-payload', sessionId, deviceIdentifier: 'boundary-device-malformed' },
      scannerCaller()
    );

    expect(result.result).toBe('invalid_qr');
    expect(result.attendanceId).toBeNull();
    expect(result.participantSummary).toBeNull();

    const { data: attempts, error } = await admin.from('scan_attempts').select('id, application_id').eq('id', result.scanAttemptId);
    expect(error).toBeNull();
    expect(attempts).toHaveLength(1);
    expect(attempts![0].application_id).toBeNull();
  });

  it('3. a mutated/unknown QR (well-formed, no matching credential) resolves to invalid_qr through the trusted boundary', async () => {
    const sessionId = await createSession({ session_code: 'boundary-unknown' });
    await assignScannerToSession(sessionId);
    const fakePayload = 'rcoy:v1:' + 'A'.repeat(43);

    const result = await scanQrAttemptConfirmForCaller({ qrPayload: fakePayload, sessionId, deviceIdentifier: null }, scannerCaller());
    expect(result.result).toBe('invalid_qr');
    expect(result.participantSummary).toBeNull();
  });

  it('4. a replaced (old) QR resolves to invalid_qr through the trusted boundary', async () => {
    const fx = await createParticipantWithSession();
    const sessionId = await createSession({ session_code: 'boundary-replaced' });
    await assignScannerToSession(sessionId);

    const original = await issueMyQrCredential(fx.client, admin, randomUUID());
    expect(original.outcome).toBe('issued');
    const reissued = await reissueMyQrCredential(fx.client, admin, {
      requestKey: randomUUID(),
      expectedCurrentCredentialId: original.credentialId!,
      reissueReasonCode: 'lost_or_stolen_phone',
      reissueNote: '',
    });
    expect(reissued.outcome).toBe('reissued');

    const result = await scanQrAttemptConfirmForCaller(
      { qrPayload: original.qrPayload!, sessionId, deviceIdentifier: 'boundary-old-token' },
      scannerCaller()
    );
    expect(result.result).toBe('invalid_qr');
  });

  it('5. the NEW reissued QR is accepted through the trusted boundary (the same reissue as test 4)', async () => {
    const fx = await createParticipantWithSession();
    const sessionId = await createSession({ session_code: 'boundary-reissued-new' });
    await assignScannerToSession(sessionId);

    const original = await issueMyQrCredential(fx.client, admin, randomUUID());
    const reissued = await reissueMyQrCredential(fx.client, admin, {
      requestKey: randomUUID(),
      expectedCurrentCredentialId: original.credentialId!,
      reissueReasonCode: 'lost_or_stolen_phone',
      reissueNote: '',
    });
    expect(reissued.outcome).toBe('reissued');

    const result = await scanQrAttemptConfirmForCaller(
      { qrPayload: reissued.qrPayload!, sessionId, deviceIdentifier: 'boundary-new-token' },
      scannerCaller()
    );
    expect(result.result).toBe('flexible_admitted');
  });

  it('6. a participant-role caller is not authorized to invoke scanner operations (role-boundary check, same established pattern as scanner-device-access-live.test.ts)', async () => {
    const fx = await createParticipantWithSession();
    const { data: profile } = await admin.from('profiles').select('role').eq('id', fx.userId).single();
    expect(isScannerDeviceRole(profile!.role)).toBe(false);
  });

  it('7. a scanner_device caller with the correct assignment succeeds', async () => {
    const fx = await createParticipantWithSession();
    const issued = await issueMyQrCredential(fx.client, admin, randomUUID());

    const result = await scanQrAttemptConfirmForCaller(
      { qrPayload: issued.qrPayload!, sessionId: sharedSessionId, deviceIdentifier: 'boundary-correct-scope' },
      scannerCaller()
    );
    // The shared session may already hold other participants from
    // earlier tests, so the specific admission outcome isn't the point
    // here — a real, non-throwing terminal result proves the scope check
    // passed (an out-of-scope call throws before ever reaching this).
    expect(typeof result.result).toBe('string');
    expect(result.scanAttemptId).toBeTruthy();
  });

  it('8. a scanner_device caller WITHOUT a matching scanner_assignments row for the target session is rejected before any scan executes', async () => {
    const fx = await createParticipantWithSession();
    const issued = await issueMyQrCredential(fx.client, admin, randomUUID());
    // A session the shared scanner fixture was never assigned to.
    const outOfScopeSessionId = await createSession({ session_code: 'boundary-out-of-scope' });

    await expect(
      scanQrAttemptConfirmForCaller(
        { qrPayload: issued.qrPayload!, sessionId: outOfScopeSessionId, deviceIdentifier: 'boundary-wrong-scope' },
        scannerCaller()
      )
    ).rejects.toThrow(/Not authorized/);

    const { data: attempts } = await admin.from('scan_attempts').select('id').eq('session_id', outOfScopeSessionId);
    expect(attempts).toHaveLength(0);
  });

  it('9. scanned_by is derived from the caller, never from client input (no scannedBy/userId field accepted in params at all)', async () => {
    const fx = await createParticipantWithSession();
    const issued = await issueMyQrCredential(fx.client, admin, randomUUID());
    const sessionId = await createSession({ session_code: 'boundary-scanned-by' });
    await assignScannerToSession(sessionId);

    const result = await scanQrAttemptConfirmForCaller(
      { qrPayload: issued.qrPayload!, sessionId, deviceIdentifier: null },
      scannerCaller()
    );
    const { data: row } = await admin.from('scan_attempts').select('scanned_by').eq('id', result.scanAttemptId).single();
    expect(row!.scanned_by).toBe(scannerId); // the caller's own id, not anything client-supplied (params has no such field to supply)
  });

  it('10. the client cannot escalate to override — scanQrAttemptConfirmForCaller\'s params type has no override field, and the underlying RPC always receives p_is_override_caller=false', async () => {
    // Structural proof: params only ever accepts {qrPayload, sessionId,
    // deviceIdentifier} (enforced at the TypeScript type level — this
    // test documents/locks that contract). Functional proof: even a
    // request that WOULD be rejected/held for a normal scanner_device
    // caller (e.g. a restricted session with no allocation) is never
    // silently promoted to override_admitted through this path.
    const fx = await createParticipantWithSession();
    const issued = await issueMyQrCredential(fx.client, admin, randomUUID());
    const restrictedSessionId = await createSession({ session_code: 'boundary-no-override', admission_policy: 'restricted' });
    await assignScannerToSession(restrictedSessionId);

    const result = await scanQrAttemptConfirmForCaller(
      { qrPayload: issued.qrPayload!, sessionId: restrictedSessionId, deviceIdentifier: null },
      scannerCaller()
    );
    expect(result.result).toBe('restricted_denied');
    expect(result.result).not.toBe('override_admitted');
  });

  it('11-12. no service-role secret, token, hash, or ciphertext ever appears in the returned ScanQrResult', async () => {
    const fx = await createParticipantWithSession();
    const issued = await issueMyQrCredential(fx.client, admin, randomUUID());
    const sessionId = await createSession({ session_code: 'boundary-no-leak' });
    await assignScannerToSession(sessionId);

    const result = await scanQrAttemptConfirmForCaller(
      { qrPayload: issued.qrPayload!, sessionId, deviceIdentifier: 'boundary-leak-check' },
      scannerCaller()
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(issued.qrPayload!.slice(8)); // the token portion
    expect(serialized).not.toContain(SERVICE_KEY);
    expect(serialized).not.toMatch(/token_hash|token_ciphertext|application_id/);
  });

  it('14. existing admission outcomes (duplicate) are preserved unchanged through the trusted boundary, matching the DB engine directly', async () => {
    const fx = await createParticipantWithSession();
    const issued = await issueMyQrCredential(fx.client, admin, randomUUID());
    const sessionId = await createSession({ session_code: 'boundary-duplicate' });
    await assignScannerToSession(sessionId);

    const first = await scanQrAttemptConfirmForCaller({ qrPayload: issued.qrPayload!, sessionId, deviceIdentifier: 'd1' }, scannerCaller());
    expect(first.result).toBe('flexible_admitted');

    const second = await scanQrAttemptConfirmForCaller({ qrPayload: issued.qrPayload!, sessionId, deviceIdentifier: 'd2' }, scannerCaller());
    expect(second.result).toBe('duplicate');
    expect(second.attendanceId).toBeNull();
  });
});
