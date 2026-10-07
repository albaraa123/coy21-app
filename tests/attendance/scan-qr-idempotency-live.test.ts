// tests/attendance/scan-qr-idempotency-live.test.ts
//
// Live coverage for the idempotency-key/scan-fingerprint behavior added to
// scan_attempt_transactional and scan_qr_attempt_transactional in
// supabase/migrations/20261006110000_scan_attempts_idempotency.sql (Task 1
// of docs/superpowers/plans/2026-10-06-offline-scanning-support.md). Covers
// spec Testing Requirements 1, 3, 4, 6, 8, 9, 12, 13 (see
// docs/superpowers/specs/2026-10-06-offline-scanning-support-design.md
// "Testing Requirements"). Requirements 10/11 (Route Handler HTTP
// classification) belong to Task 3, not here.
//
// Fixture pattern follows tests/attendance/scan-qr-attempt-live.test.ts and
// tests/attendance/scan-attempt-concurrency-live.test.ts: real Supabase
// Auth users, real conference_days/rooms/tracks/session_types/sessions/
// scanner_assignments rows, runId-suffixed identifiers throughout (per this
// project's own memory notes on fixture-collision across reruns), careful
// FK-ordered afterAll cleanup.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000 });

const runId = randomUUID().slice(0, 8);
const dayOffset = Math.floor(Math.random() * 3000) + 1;
const CONFERENCE_DATE = new Date(Date.UTC(2099, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

let scannerId: string;
let staffId: string;
let conferenceDayId: string;
let trackId: string;
let sessionTypeId: string;

const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const sessionIds: string[] = [];
const roomIds: string[] = [];
const scannerAssignmentIds: string[] = [];
let roomCounter = 0;

async function createRoom(): Promise<string> {
  roomCounter += 1;
  const { data, error } = await admin
    .from('rooms')
    .insert({ code: `SCAN-IDEMP-ROOM-${runId}-${roomCounter}`, name_ar: 'قاعة', name_en: `Room ${roomCounter}`, capacity: 100 })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create room: ${error?.message}`);
  roomIds.push(data.id);
  return data.id;
}

async function createApplicant(emailLocalPart: string): Promise<{ userId: string; applicationId: string }> {
  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email: `scan-idemp-${runId}-${emailLocalPart}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (userError || !user.user) throw new Error(`Failed to create applicant ${emailLocalPart}: ${userError?.message}`);
  applicantUserIds.push(user.user.id);

  const { data: app, error: appError } = await admin
    .from('applications')
    .insert({ applicant_id: user.user.id, status: 'accepted' })
    .select('id')
    .single();
  if (appError || !app) throw new Error(`Failed to create application for ${emailLocalPart}: ${appError?.message}`);
  applicationIds.push(app.id);

  return { userId: user.user.id, applicationId: app.id };
}

async function createSession(overrides: Partial<Database['public']['Tables']['sessions']['Insert']> & { session_code: string }) {
  const roomForSession = overrides.room_id ?? (await createRoom());
  const { data, error } = await admin
    .from('sessions')
    .insert({
      title_ar: 'ج',
      title_en: 'Session',
      conference_day_id: conferenceDayId,
      start_time: `${CONFERENCE_DATE}T09:00:00Z`,
      end_time: `${CONFERENCE_DATE}T10:00:00Z`,
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

async function assignScannerToSession(sessionId: string, scannerUserId: string = scannerId) {
  const { data, error } = await admin
    .from('scanner_assignments')
    .insert({ scanner_user_id: scannerUserId, session_id: sessionId, assigned_by: staffId })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to assign scanner to session ${sessionId}: ${error?.message}`);
  scannerAssignmentIds.push(data.id);
}

// scan_attempt_transactional is the direct (non-QR) path -- used here
// because it accepts p_token_hash/p_idempotency_key directly and lets us
// bypass scan_qr_attempt_transactional's credential-resolution layer
// entirely, which is required for Requirement 8 (the in-RPC TOCTOU window
// must be exercised directly, not through the Route Handler's own
// pre-check).
async function callScanAttempt(params: {
  applicationId: string | null;
  sessionId: string;
  deviceIdentifier?: string | null;
  isOverrideCaller?: boolean;
  scannerUserId?: string | null;
  idempotencyKey?: string | null;
  tokenHash?: Buffer | null;
  timeSlotGroupKey?: string;
}) {
  const { data, error } = await admin.rpc('scan_attempt_transactional', {
    p_application_id: params.applicationId as string,
    p_session_id: params.sessionId,
    p_scanned_by: scannerId,
    p_device_identifier: (params.deviceIdentifier ?? null) as string,
    p_time_slot_group_key: params.timeSlotGroupKey ?? `tsgk-${params.sessionId}`,
    p_is_override_caller: params.isOverrideCaller ?? false,
    p_scanner_user_id: (params.scannerUserId === undefined ? scannerId : params.scannerUserId) as string,
    p_idempotency_key: (params.idempotencyKey ?? null) as string,
    p_token_hash: (params.tokenHash ? (`\\x${params.tokenHash.toString('hex')}` as string) : (null as unknown as string)),
  });
  return { data, error };
}

async function callScanQrAttempt(params: {
  tokenHash: Buffer | null;
  sessionId: string;
  deviceIdentifier?: string | null;
  idempotencyKey?: string | null;
}) {
  const { data, error } = await admin.rpc('scan_qr_attempt_transactional', {
    p_token_hash: (params.tokenHash ? (`\\x${params.tokenHash.toString('hex')}` as string) : (null as unknown as string)),
    p_session_id: params.sessionId,
    p_scanned_by: scannerId,
    p_device_identifier: (params.deviceIdentifier ?? null) as string,
    p_is_override_caller: false,
    p_scanner_user_id: scannerId as string,
    p_idempotency_key: (params.idempotencyKey ?? null) as string,
  });
  return { data, error };
}

beforeAll(async () => {
  const { data: scanner } = await admin.auth.admin.createUser({
    email: `scan-idemp-${runId}-scanner@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  scannerId = scanner!.user!.id;
  await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', scannerId);

  const { data: staff } = await admin.auth.admin.createUser({
    email: `scan-idemp-${runId}-staff@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  staffId = staff!.user!.id;
  await admin.from('profiles').update({ role: 'program_attendance_manager' }).eq('id', staffId);

  const { data: day } = await admin
    .from('conference_days')
    .insert({ conference_date: CONFERENCE_DATE, label_ar: 'يوم', label_en: 'Day', display_order: 1 })
    .select('id')
    .single();
  conferenceDayId = day!.id;

  const { data: track } = await admin.from('tracks').insert({ code: `SCAN-IDEMP-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;

  const { data: sessionType } = await admin.from('session_types').insert({ code: `SCAN-IDEMP-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;
});

afterAll(async () => {
  if (sessionIds.length > 0) {
    await admin.from('scan_attempts').delete().in('session_id', sessionIds);
    await admin.from('attendance_records').delete().in('session_id', sessionIds);
  }
  if (scannerAssignmentIds.length > 0) {
    await admin.from('scanner_assignments').delete().in('id', scannerAssignmentIds);
  }
  if (sessionIds.length > 0) {
    await admin.from('sessions').delete().in('id', sessionIds);
  }
  await admin.from('tracks').delete().eq('id', trackId);
  await admin.from('session_types').delete().eq('id', sessionTypeId);
  if (roomIds.length > 0) {
    await admin.from('rooms').delete().in('id', roomIds);
  }
  await admin.from('conference_days').delete().eq('id', conferenceDayId);
  if (applicationIds.length > 0) {
    await admin.from('applications').delete().in('id', applicationIds);
  }
  await Promise.allSettled([
    ...applicantUserIds.map((id) => admin.auth.admin.deleteUser(id)),
    admin.auth.admin.deleteUser(scannerId),
    admin.auth.admin.deleteUser(staffId),
  ]);
});

describe('scan_attempt_transactional / scan_qr_attempt_transactional — idempotency key + scan fingerprint', () => {
  // Requirement 1: a retried call with the same idempotency key after the
  // original committed returns the exact same row, for both an admitted
  // and a non-admitting first attempt, with no second insert of either
  // kind.
  it('[Req 1] replays the same admitted row on retry with the same idempotency key, no second attendance_records/scan_attempts insert', async () => {
    const sessionId = await createSession({ session_code: `req1-admitted-${runId}` });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('req1-admitted');
    const idempotencyKey = randomUUID();

    const first = await callScanAttempt({ applicationId, sessionId, idempotencyKey, deviceIdentifier: 'd1' });
    expect(first.error, `RPC error: ${first.error?.message}`).toBeNull();
    expect(first.data!.result).toBe('flexible_admitted');

    const retry = await callScanAttempt({ applicationId, sessionId, idempotencyKey, deviceIdentifier: 'd2' });
    expect(retry.error).toBeNull();
    expect(retry.data!.id).toBe(first.data!.id);
    expect(retry.data!.result).toBe('flexible_admitted');
    expect(retry.data!.resulting_attendance_id).toBe(first.data!.resulting_attendance_id);

    const { data: attempts } = await admin.from('scan_attempts').select('id').eq('idempotency_key', idempotencyKey);
    expect(attempts).toHaveLength(1);
    const { data: records } = await admin.from('attendance_records').select('id').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(records).toHaveLength(1);
  });

  it('[Req 1] replays the same non-admitting (invalid_qr) row on retry with the same idempotency key', async () => {
    const sessionId = await createSession({ session_code: `req1-invalid-${runId}`, status: 'draft' });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('req1-invalid');
    const idempotencyKey = randomUUID();

    const first = await callScanAttempt({ applicationId, sessionId, idempotencyKey });
    expect(first.error).toBeNull();
    expect(first.data!.result).toBe('invalid_qr');

    const retry = await callScanAttempt({ applicationId, sessionId, idempotencyKey });
    expect(retry.error).toBeNull();
    expect(retry.data!.id).toBe(first.data!.id);
    expect(retry.data!.result).toBe('invalid_qr');

    const { data: attempts } = await admin.from('scan_attempts').select('id').eq('idempotency_key', idempotencyKey);
    expect(attempts).toHaveLength(1);
  });

  // Requirement 3: the malformed-payload branch (token_hash null) retried
  // with the same idempotency key returns the same row, not an incorrect
  // mismatch error -- exercises the `is not distinct from` NULL-safety
  // check on scan_fingerprint.
  it('[Req 3] malformed (null token_hash) branch retried with the same idempotency key replays the same row, not a mismatch error', async () => {
    const sessionId = await createSession({ session_code: `req3-malformed-${runId}` });
    await assignScannerToSession(sessionId);
    const idempotencyKey = randomUUID();

    const first = await callScanQrAttempt({ tokenHash: null, sessionId, idempotencyKey });
    expect(first.error).toBeNull();
    expect(first.data!.result).toBe('invalid_qr');
    expect(first.data!.application_id).toBeNull();

    const retry = await callScanQrAttempt({ tokenHash: null, sessionId, idempotencyKey });
    expect(retry.error).toBeNull();
    expect(retry.data!.id).toBe(first.data!.id);

    const { data: attempts } = await admin.from('scan_attempts').select('id').eq('idempotency_key', idempotencyKey);
    expect(attempts).toHaveLength(1);
  });

  // Requirement 4: the same idempotency key presented with different scan
  // data (different session+tokenHash, or different application+session
  // for the direct path) raises the mismatch error, never returning stale
  // data for a different request.
  it('[Req 4] the same idempotency key with a different session_id raises the mismatch error, not stale data', async () => {
    const sessionIdA = await createSession({ session_code: `req4-sess-a-${runId}` });
    const sessionIdB = await createSession({ session_code: `req4-sess-b-${runId}` });
    await assignScannerToSession(sessionIdA);
    await assignScannerToSession(sessionIdB);
    const { applicationId } = await createApplicant('req4-mismatch');
    const idempotencyKey = randomUUID();

    const first = await callScanAttempt({ applicationId, sessionId: sessionIdA, idempotencyKey });
    expect(first.error).toBeNull();

    const second = await callScanAttempt({ applicationId, sessionId: sessionIdB, idempotencyKey });
    expect(second.error).not.toBeNull();
    expect(second.error!.message).toContain('Idempotency key reused with different scan data');
  });

  it('[Req 4] the same idempotency key with a different token_hash (same session) raises the mismatch error', async () => {
    const sessionId = await createSession({ session_code: `req4-token-${runId}` });
    await assignScannerToSession(sessionId);
    const idempotencyKey = randomUUID();
    const { randomBytes } = await import('node:crypto');

    const first = await callScanQrAttempt({ tokenHash: randomBytes(32), sessionId, idempotencyKey });
    expect(first.error).toBeNull();
    expect(first.data!.result).toBe('invalid_qr');

    const second = await callScanQrAttempt({ tokenHash: randomBytes(32), sessionId, idempotencyKey });
    expect(second.error).not.toBeNull();
    expect(second.error!.message).toContain('Idempotency key reused with different scan data');
  });

  // Same idempotency key, same session_id, null token_hash on both sides
  // (the direct scanner-confirm/override-admit path) but a DIFFERENT
  // application_id -- the scan_fingerprint must fold in application_id, not
  // just token_hash + session_id, or this would silently replay applicant
  // A's row for applicant B's retried scan instead of raising the mismatch
  // error. Caught in code-quality review of this task.
  it('[Req 4] the same idempotency key with a different application_id (same session, null token_hash) raises the mismatch error, not another applicant\'s row', async () => {
    const sessionId = await createSession({ session_code: `req4-app-${runId}` });
    await assignScannerToSession(sessionId);
    const { applicationId: applicationIdA } = await createApplicant('req4-app-a');
    const { applicationId: applicationIdB } = await createApplicant('req4-app-b');
    const idempotencyKey = randomUUID();

    const first = await callScanAttempt({ applicationId: applicationIdA, sessionId, idempotencyKey });
    expect(first.error).toBeNull();

    const second = await callScanAttempt({ applicationId: applicationIdB, sessionId, idempotencyKey });
    expect(second.error).not.toBeNull();
    expect(second.error!.message).toContain('Idempotency key reused with different scan data');
  });

  // Requirement 6: idempotent replay changes the outcome correctly and
  // concretely -- without idempotency, a naive second call of the same
  // scan would compute 'duplicate' (the first call's own admission is now
  // visible); WITH idempotency the second call instead replays the first
  // call's actual original result, identical scan_attempts.id, with
  // exactly one attendance_records row and one scan_attempts row
  // afterward.
  it('[Req 6] a retried scan replays the original admitted result instead of recomputing duplicate, with exactly one row of each kind', async () => {
    const sessionId = await createSession({ session_code: `req6-replay-${runId}` });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('req6-replay');
    const idempotencyKey = randomUUID();

    const first = await callScanAttempt({ applicationId, sessionId, idempotencyKey, deviceIdentifier: 'd1' });
    expect(first.error).toBeNull();
    expect(first.data!.result).toBe('flexible_admitted');

    // Without idempotency, a second call for the SAME application/session
    // would now see its own first admission and compute 'duplicate' (see
    // tests/attendance/scan-attempt-concurrency-live.test.ts's non-idempotent
    // duplicate-detection coverage) -- confirm the idempotent retry instead
    // replays the original 'flexible_admitted' result and the identical
    // scan_attempts row.
    const retry = await callScanAttempt({ applicationId, sessionId, idempotencyKey, deviceIdentifier: 'd2' });
    expect(retry.error).toBeNull();
    expect(retry.data!.result).toBe('flexible_admitted');
    expect(retry.data!.id).toBe(first.data!.id);

    const { data: attendanceRows } = await admin.from('attendance_records').select('id').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(attendanceRows).toHaveLength(1);
    const { data: scanRows } = await admin.from('scan_attempts').select('id').eq('idempotency_key', idempotencyKey);
    expect(scanRows).toHaveLength(1);
  });

  // Requirement 8: a scanner whose assignment was revoked between its
  // original (committed) attempt and a retry with the same key gets
  // 'Not authorized for this session/room' on the retry, not the original
  // cached success -- i.e. the scanner-scope re-check runs BEFORE the
  // idempotency lookup, not after. Calls scan_attempt_transactional
  // directly (not through a Route Handler) to exercise the in-RPC
  // ordering itself, since the Route Handler's own pre-check would
  // normally catch this first.
  it('[Req 8] a retry with the same idempotency key after the scanner assignment was revoked gets "Not authorized", not the cached success', async () => {
    const sessionId = await createSession({ session_code: `req8-revoked-${runId}` });
    const { data: assignment, error: assignError } = await admin
      .from('scanner_assignments')
      .insert({ scanner_user_id: scannerId, session_id: sessionId, assigned_by: staffId })
      .select('id')
      .single();
    if (assignError || !assignment) throw new Error(`assignment insert failed: ${assignError?.message}`);
    scannerAssignmentIds.push(assignment.id);

    const { applicationId } = await createApplicant('req8-revoked');
    const idempotencyKey = randomUUID();

    const first = await callScanAttempt({ applicationId, sessionId, idempotencyKey, scannerUserId: scannerId });
    expect(first.error).toBeNull();
    expect(first.data!.result).toBe('flexible_admitted');

    // Revoke the scanner's assignment to this session.
    const { error: revokeError } = await admin.from('scanner_assignments').update({ is_active: false }).eq('id', assignment.id);
    expect(revokeError).toBeNull();

    const retry = await callScanAttempt({ applicationId, sessionId, idempotencyKey, scannerUserId: scannerId });
    expect(retry.error).not.toBeNull();
    expect(retry.error!.message).toContain('Not authorized for this session/room');
  });

  // Requirement 9: the malformed-payload branch's scan_fingerprint
  // computation does not raise SQLSTATE 42883 (confirms the
  // extensions.digest(...) schema-qualification fix -- an unqualified
  // digest() call would be ambiguous/undefined under this function's
  // `set search_path = public, pg_temp` and raise 42883 "function does not
  // exist").
  it('[Req 9] the malformed-payload scan_fingerprint computation does not raise SQLSTATE 42883 (undefined function)', async () => {
    const sessionId = await createSession({ session_code: `req9-digest-${runId}` });
    await assignScannerToSession(sessionId);

    const { error } = await callScanQrAttempt({ tokenHash: null, sessionId, idempotencyKey: randomUUID() });
    expect(error).toBeNull();

    const { randomBytes } = await import('node:crypto');
    const { error: wrongLengthError } = await callScanQrAttempt({ tokenHash: Buffer.from(randomBytes(16)), sessionId, idempotencyKey: randomUUID() });
    expect(wrongLengthError).toBeNull();
  });

  // Requirement 12: force the unique_violation backstop itself to fire
  // (not just the primary pre-lock idempotency check) for the cross-key
  // mismatch case -- two calls sharing one idempotency key but with
  // deliberately different session/application data, raced so neither's
  // pre-lock SELECT sees the other's row before both attempt their insert.
  //
  // This is the requirement the spec explicitly flags as hard to
  // construct reliably with Promise.all alone, since the pre-lock SELECT
  // (not the final insert) is the one normally hit first once the first
  // call has committed. To force the SECOND call past the pre-lock SELECT
  // (finding no existing row yet) and into the insert's unique_violation
  // backstop instead, this test fires both calls as genuinely concurrent
  // promises (Promise.all, no client-side sequencing) against two
  // DIFFERENT sessions (so they don't contend for the same
  // pg_try_advisory_xact_lock(session_id) and serialize against each
  // other there) -- the only remaining serialization point is the
  // scan_attempts_idempotency_key_unique index itself, which is exactly
  // the backstop this test targets. This makes the test's outcome
  // dependent on genuine timing: one request wins the pre-lock race (sees
  // no row, proceeds to insert and succeeds) while the other must lose at
  // the unique index itself inside the exception block, not at the
  // earlier SELECT. On a fast/unloaded test database both calls can
  // occasionally both slip past the pre-lock SELECT at near-identical
  // times without the race actually interleaving as intended, which would
  // make this assertion flaky rather than deterministic -- see this
  // file's accompanying report for the concrete difficulty encountered
  // here, flagged as DONE_WITH_CONCERNS rather than silently weakened.
  it('[Req 12] a genuine race on the SAME idempotency key across two different sessions/applications raises the mismatch error, never a cross-request row', async () => {
    const sessionIdA = await createSession({ session_code: `req12-sess-a-${runId}` });
    const sessionIdB = await createSession({ session_code: `req12-sess-b-${runId}` });
    await assignScannerToSession(sessionIdA);
    await assignScannerToSession(sessionIdB);
    const { applicationId: applicationIdA } = await createApplicant('req12-a');
    const { applicationId: applicationIdB } = await createApplicant('req12-b');
    const idempotencyKey = randomUUID();

    const [resultA, resultB] = await Promise.allSettled([
      callScanAttempt({ applicationId: applicationIdA, sessionId: sessionIdA, idempotencyKey, deviceIdentifier: 'race-a' }),
      callScanAttempt({ applicationId: applicationIdB, sessionId: sessionIdB, idempotencyKey, deviceIdentifier: 'race-b' }),
    ]);

    // Both calls resolve (the RPC itself never throws at the JS layer --
    // a raised exception surfaces as a populated `.error` on a fulfilled
    // PostgrestResponse, not a rejected promise), so both branches here
    // should be 'fulfilled'.
    expect(resultA.status).toBe('fulfilled');
    expect(resultB.status).toBe('fulfilled');
    const dataA = resultA.status === 'fulfilled' ? resultA.value : null;
    const dataB = resultB.status === 'fulfilled' ? resultB.value : null;

    // Exactly one of the two must have succeeded (no error) and the other
    // must have hit the "reused with different scan data" mismatch --
    // whether that mismatch was caught by the pre-lock SELECT or the
    // unique_violation backstop is exactly the part genuine concurrency
    // makes non-deterministic, which is why this test asserts the
    // OUTCOME (a clean winner + a clean mismatch rejection, never a
    // cross-request row returned to the loser) rather than which specific
    // code path inside the function produced it.
    const succeeded = [dataA, dataB].filter((r) => r && r.error === null);
    const failed = [dataA, dataB].filter((r) => r && r.error !== null);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error!.message).toContain('Idempotency key reused with different scan data');

    // The loser must never have received the winner's row for the OTHER
    // application/session -- confirm each application ended up with
    // scan_attempts rows only for its own session, never cross-assigned.
    const { data: scanRows } = await admin.from('scan_attempts').select('id, application_id, session_id').eq('idempotency_key', idempotencyKey);
    expect(scanRows).toHaveLength(1);
    const winnerApplicationId = succeeded[0] === dataA ? applicationIdA : applicationIdB;
    const winnerSessionId = succeeded[0] === dataA ? sessionIdA : sessionIdB;
    expect(scanRows![0].application_id).toBe(winnerApplicationId);
    expect(scanRows![0].session_id).toBe(winnerSessionId);
  });

  // Requirement 13: existing callers continue to work unchanged with no
  // idempotency key passed (null defaults, zero behavior change) -- a
  // straightforward regression check against the OLD (shorter) argument
  // list, relying on Postgres's own default-parameter resolution for the
  // now-9-argument / 7-argument signatures.
  it('[Req 13] scan_attempt_transactional called with the pre-idempotency argument list (no key/hash) still works unchanged', async () => {
    const sessionId = await createSession({ session_code: `req13-direct-${runId}` });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('req13-direct');

    const { data, error } = await admin.rpc('scan_attempt_transactional', {
      p_application_id: applicationId,
      p_session_id: sessionId,
      p_scanned_by: scannerId,
      p_device_identifier: 'd-req13' as string,
      p_time_slot_group_key: `tsgk-${sessionId}`,
      p_is_override_caller: false,
      p_scanner_user_id: scannerId as string,
    });
    expect(error).toBeNull();
    expect(data!.result).toBe('flexible_admitted');
    expect(data!.idempotency_key).toBeNull();
  });

  it('[Req 13] scan_qr_attempt_transactional called with the pre-idempotency argument list (no key) still works unchanged', async () => {
    const sessionId = await createSession({ session_code: `req13-qr-${runId}` });
    await assignScannerToSession(sessionId);
    const { randomBytes } = await import('node:crypto');

    const { data, error } = await admin.rpc('scan_qr_attempt_transactional', {
      p_token_hash: `\\x${randomBytes(32).toString('hex')}` as string,
      p_session_id: sessionId,
      p_scanned_by: scannerId,
      p_device_identifier: 'd-req13-qr' as string,
      p_is_override_caller: false,
      p_scanner_user_id: scannerId as string,
    });
    expect(error).toBeNull();
    expect(data!.result).toBe('invalid_qr');
    expect(data!.idempotency_key).toBeNull();
  });
});
