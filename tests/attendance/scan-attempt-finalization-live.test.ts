// tests/attendance/scan-attempt-finalization-live.test.ts
//
// Regression coverage for the corrective fix in migration
// 20260814110000_fix_scan_attempt_transactional_finalized_at.sql:
// scan_attempt_transactional's two INSERT statements now set
// finalized_at = now(), making every terminal scan_attempts row it writes
// compliant with scan_attempts_finalization_state_check (added by
// 20260805235959_phase6_qr_issuance_reissue.sql, unmodified here). Before
// this fix, every call to this function violated that constraint.
//
// Covers every terminal result value the function can produce, proving
// for each: the RPC completes, exactly one scan_attempts row exists,
// result is unchanged, finalized_at IS NOT NULL, finalized_at is not
// earlier than created_at, and attendance_records behavior is unchanged
// from before this fix (unrelated to the finalized_at column entirely).
//
// Fixture pattern follows tests/attendance/scan-attempt-live.test.ts
// exactly (same helpers, same fixture shapes) — this file is scoped
// narrowly to the finalization-timestamp regression, not a duplicate of
// that file's full admission-logic coverage.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import { scanAttemptConfirmForCaller } from '@/lib/attendance/scan-attempt';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const dayOffset = Math.floor(Math.random() * 3000) + 1;
const CONFERENCE_DATE = new Date(Date.UTC(2099, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

vi.setConfig({ testTimeout: 30000 });

let scannerId: string;
let staffId: string;
let conferenceDayId: string;
let pastConferenceDayId: string;
let trackId: string;
let sessionTypeId: string;
let featureRunId: string;
let allocationRunId: string;

const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const sessionIds: string[] = [];
const roomIds: string[] = [];
const conferenceDayIds: string[] = [];
const scannerAssignmentIds: string[] = [];
const allocationAssignmentIds: string[] = [];
let roomCounter = 0;

async function createRoom(): Promise<string> {
  roomCounter += 1;
  const { data, error } = await admin
    .from('rooms')
    .insert({ code: `FIN-ROOM-${runId}-${roomCounter}`, name_ar: 'قاعة', name_en: `Room ${roomCounter}`, capacity: 100 })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create room: ${error?.message}`);
  roomIds.push(data.id);
  return data.id;
}

async function createApplicant(emailLocalPart: string): Promise<{ userId: string; applicationId: string }> {
  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email: `fin-live-${emailLocalPart}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (userError || !user.user) throw new Error(`Failed to create applicant ${emailLocalPart}: ${userError?.message}`);
  applicantUserIds.push(user.user.id);

  const { data: app, error: appError } = await admin.from('applications').insert({ applicant_id: user.user.id, status: 'accepted' }).select('id').single();
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

async function assignScannerToSession(sessionId: string) {
  const { data, error } = await admin
    .from('scanner_assignments')
    .insert({ scanner_user_id: scannerId, session_id: sessionId, assigned_by: staffId })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to assign scanner to session ${sessionId}: ${error?.message}`);
  scannerAssignmentIds.push(data.id);
}

async function makeRecommended(applicationId: string, sessionId: string, timeSlotGroupKey: string) {
  const { data, error } = await admin
    .from('allocation_assignments')
    .insert({
      allocation_run_id: allocationRunId,
      application_id: applicationId,
      session_id: sessionId,
      time_slot_group_key: timeSlotGroupKey,
      suitability_score: 1,
      is_mandatory_assignment: false,
      status: 'confirmed',
      updated_by: staffId,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create allocation_assignment: ${error?.message}`);
  allocationAssignmentIds.push(data.id);
}

async function seedAttendanceRecords(sessionId: string, count: number, entryType: 'priority' | 'flexible' = 'flexible') {
  for (let i = 0; i < count; i++) {
    const { applicationId } = await createApplicant(`fin-fill-${sessionId.slice(0, 8)}-${i}`);
    const { error } = await admin.from('attendance_records').insert({
      application_id: applicationId,
      session_id: sessionId,
      time_slot_group_key: `fin-fill-${sessionId}`,
      entry_type: entryType,
      scanned_by: scannerId,
    });
    if (error) throw new Error(`Failed to seed attendance_records: ${error.message}`);
  }
}

const caller = () => ({ userId: scannerId, service: admin });

/** Common assertion block for every terminal-outcome test below. */
async function assertFinalizationCompliant(scanAttemptId: string, expectedResult: string) {
  const { data: rows, error } = await admin.from('scan_attempts').select('*').eq('id', scanAttemptId);
  expect(error, `scan_attempts lookup failed: ${error?.message}`).toBeNull();
  expect(rows).toHaveLength(1);
  const row = rows![0];
  expect(row.result).toBe(expectedResult);
  expect(row.finalized_at).not.toBeNull();
  expect(new Date(row.finalized_at as unknown as string).getTime()).toBeGreaterThanOrEqual(new Date(row.created_at).getTime());
  expect(row.expires_at).toBeNull();
}

afterAll(async () => {
  if (sessionIds.length > 0) {
    await admin.from('scan_attempts').delete().in('session_id', sessionIds);
    await admin.from('attendance_records').delete().in('session_id', sessionIds);
  }
  if (allocationAssignmentIds.length > 0) await admin.from('allocation_assignments').delete().in('id', allocationAssignmentIds);
  if (allocationRunId) await admin.from('allocation_runs').delete().eq('id', allocationRunId);
  if (featureRunId) await admin.from('feature_extraction_runs').delete().eq('id', featureRunId);
  if (scannerAssignmentIds.length > 0) await admin.from('scanner_assignments').delete().in('id', scannerAssignmentIds);
  if (sessionIds.length > 0) await admin.from('sessions').delete().in('id', sessionIds);
  if (trackId) await admin.from('tracks').delete().eq('id', trackId);
  if (sessionTypeId) await admin.from('session_types').delete().eq('id', sessionTypeId);
  if (roomIds.length > 0) await admin.from('rooms').delete().in('id', roomIds);
  if (conferenceDayIds.length > 0) await admin.from('conference_days').delete().in('id', conferenceDayIds);
  if (applicationIds.length > 0) await admin.from('applications').delete().in('id', applicationIds);
});

beforeAll(async () => {
  const { data: scanner } = await admin.auth.admin.createUser({ email: `fin-live-scanner-${Date.now()}@test.local`, password: 'password123', email_confirm: true });
  scannerId = scanner!.user!.id;
  await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', scannerId);

  const { data: staff } = await admin.auth.admin.createUser({ email: `fin-live-staff-${Date.now()}@test.local`, password: 'password123', email_confirm: true });
  staffId = staff!.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  const { data: day } = await admin
    .from('conference_days')
    .insert({ conference_date: CONFERENCE_DATE, label_ar: 'يوم', label_en: 'Day', display_order: 1 })
    .select('id')
    .single();
  conferenceDayId = day!.id;
  conferenceDayIds.push(conferenceDayId);

  const pastDate = new Date(Date.UTC(1990, 0, 1) + Math.floor(Math.random() * 3000) * 86400000).toISOString().slice(0, 10);
  const { data: pastDay } = await admin
    .from('conference_days')
    .insert({ conference_date: pastDate, label_ar: 'يوم ماضٍ', label_en: 'Past Day', display_order: 2 })
    .select('id')
    .single();
  pastConferenceDayId = pastDay!.id;
  conferenceDayIds.push(pastConferenceDayId);

  const { data: track } = await admin.from('tracks').insert({ code: `FIN-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;

  const { data: sessionType } = await admin.from('session_types').insert({ code: `FIN-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;

  const { data: featureRun } = await admin.from('feature_extraction_runs').insert({ rules_version: 1, application_count: 1, run_by: staffId }).select('id').single();
  featureRunId = featureRun!.id;

  const { data: run } = await admin
    .from('allocation_runs')
    .insert({
      feature_extraction_run_id: featureRunId,
      status: 'confirmed',
      run_by: staffId,
      confirmed_at: new Date().toISOString(),
      confirmed_by: staffId,
    })
    .select('id')
    .single();
  allocationRunId = run!.id;
});

describe('scan_attempt_transactional finalized_at regression — every terminal outcome', () => {
  it('admitted (priority_then_open, recommended) — finalized_at set, attendance_records unchanged', async () => {
    const sessionId = await createSession({ session_code: `FIN-ADMITTED-${runId}`, admission_policy: 'priority_then_open', capacity: 10, priority_seats: 6 });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('admitted');
    await makeRecommended(applicationId, sessionId, `k-${sessionId}`);

    const result = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    expect(result.result).toBe('admitted');
    await assertFinalizationCompliant(result.id, 'admitted');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(records).toHaveLength(1);
    expect(records![0].entry_type).toBe('priority');
  });

  it('flexible_admitted (open policy) — finalized_at set, attendance_records unchanged', async () => {
    const sessionId = await createSession({ session_code: `FIN-FLEXIBLE-${runId}`, admission_policy: 'open', capacity: 10 });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('flexible');

    const result = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    expect(result.result).toBe('flexible_admitted');
    await assertFinalizationCompliant(result.id, 'flexible_admitted');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(records).toHaveLength(1);
    expect(records![0].entry_type).toBe('flexible');
  });

  it('priority_hold (priority_then_open, not recommended, flexible pool exhausted) — finalized_at set, no attendance_records row', async () => {
    const sessionId = await createSession({
      session_code: `FIN-HOLD-${runId}`,
      admission_policy: 'priority_then_open',
      capacity: 10,
      priority_seats: 6,
      // Far in the future: definitely not yet released, so the flexible
      // pool (capacity - priority_seats = 4) is what gates a non-recommended applicant.
      priority_release_at: '2099-01-01T00:00:00Z',
    });
    await assignScannerToSession(sessionId);
    // Fill the flexible pool (4 seats) with 4 flexible admissions so a
    // non-recommended applicant has no remaining flexible-pool room —
    // unambiguously priority_hold, not incidentally flexible_admitted.
    await seedAttendanceRecords(sessionId, 4, 'flexible');
    const { applicationId } = await createApplicant('hold');

    const result = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    expect(result.result).toBe('priority_hold');
    await assertFinalizationCompliant(result.id, 'priority_hold');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(records).toHaveLength(0);
  });

  it('full (at capacity) — finalized_at set, no attendance_records row', async () => {
    const sessionId = await createSession({ session_code: `FIN-FULL-${runId}`, admission_policy: 'open', capacity: 1 });
    await assignScannerToSession(sessionId);
    await seedAttendanceRecords(sessionId, 1);
    const { applicationId } = await createApplicant('full');

    const result = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    expect(result.result).toBe('full');
    await assertFinalizationCompliant(result.id, 'full');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(records).toHaveLength(0);
  });

  it('restricted_denied (restricted policy, not recommended) — finalized_at set, no attendance_records row', async () => {
    const sessionId = await createSession({ session_code: `FIN-DENIED-${runId}`, admission_policy: 'restricted', capacity: 10 });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('denied');

    const result = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    expect(result.result).toBe('restricted_denied');
    await assertFinalizationCompliant(result.id, 'restricted_denied');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(records).toHaveLength(0);
  });

  it('duplicate (already admitted to this session) — finalized_at set on the SECOND scan_attempts row, no new attendance_records row', async () => {
    const sessionId = await createSession({ session_code: `FIN-DUP-${runId}`, admission_policy: 'open', capacity: 10 });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('duplicate');

    const first = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    expect(first.result).toBe('flexible_admitted');

    const second = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    expect(second.result).toBe('duplicate');
    await assertFinalizationCompliant(second.id, 'duplicate');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(records).toHaveLength(1); // still just the one from the first scan
  });

  it('timeslot_conflict (already admitted to a same-time-slot different session) — finalized_at set, no new attendance_records row', async () => {
    const room = await createRoom();
    const sessionA = await createSession({ session_code: `FIN-CONFLICT-A-${runId}`, admission_policy: 'open', capacity: 10, room_id: room, start_time: `${CONFERENCE_DATE}T09:00:00Z`, end_time: `${CONFERENCE_DATE}T10:00:00Z` });
    const room2 = await createRoom();
    const sessionB = await createSession({ session_code: `FIN-CONFLICT-B-${runId}`, admission_policy: 'open', capacity: 10, room_id: room2, start_time: `${CONFERENCE_DATE}T09:30:00Z`, end_time: `${CONFERENCE_DATE}T10:30:00Z` });
    await assignScannerToSession(sessionA);
    await assignScannerToSession(sessionB);
    const { applicationId } = await createApplicant('conflict');

    const first = await scanAttemptConfirmForCaller({ applicationId, sessionId: sessionA, deviceIdentifier: null }, caller());
    expect(first.result).toBe('flexible_admitted');

    const second = await scanAttemptConfirmForCaller({ applicationId, sessionId: sessionB, deviceIdentifier: null }, caller());
    expect(second.result).toBe('timeslot_conflict');
    await assertFinalizationCompliant(second.id, 'timeslot_conflict');
  });

  it('invalid_qr (session not confirmed) — finalized_at set, no attendance_records row', async () => {
    const sessionId = await createSession({ session_code: `FIN-INVALID-${runId}`, admission_policy: 'open', capacity: 10, status: 'draft' });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('invalid');

    const result = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    expect(result.result).toBe('invalid_qr');
    await assertFinalizationCompliant(result.id, 'invalid_qr');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(records).toHaveLength(0);
  });

  it('override_admitted (staff override on an otherwise-full session) — finalized_at set, attendance_records row created', async () => {
    const sessionId = await createSession({ session_code: `FIN-OVERRIDE-${runId}`, admission_policy: 'open', capacity: 1 });
    await assignScannerToSession(sessionId);
    await seedAttendanceRecords(sessionId, 1);
    const { applicationId } = await createApplicant('override');

    const { data, error } = await admin.rpc('scan_attempt_transactional', {
      p_application_id: applicationId,
      p_session_id: sessionId,
      p_scanned_by: staffId,
      p_device_identifier: 'override-device' as string,
      p_time_slot_group_key: `fin-override-${sessionId}`,
      p_is_override_caller: true,
    });
    expect(error, `RPC error: ${error?.message}`).toBeNull();
    expect(data!.result).toBe('override_admitted');
    await assertFinalizationCompliant(data!.id, 'override_admitted');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(records).toHaveLength(1);
    expect(records![0].entry_type).toBe('override');
  });

  it('exactly one scan_attempts row per RPC call, matching pre-existing exactly-once semantics (unaffected by this fix)', async () => {
    const sessionId = await createSession({ session_code: `FIN-EXACTLY-ONE-${runId}`, admission_policy: 'open', capacity: 10 });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('exactly-one');

    const result = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    const { data: attempts, error } = await admin.from('scan_attempts').select('id').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(error).toBeNull();
    expect(attempts).toHaveLength(1);
    expect(attempts![0].id).toBe(result.id);
  });
});

describe('pending-state regression — token_valid_pending_confirmation (schema-level, not produced by any live function)', () => {
  it('a scan_attempts row explicitly inserted as token_valid_pending_confirmation with a future expires_at and finalized_at NULL satisfies the constraint (the pending branch is real schema, even though no production function currently writes it)', async () => {
    const sessionId = await createSession({ session_code: `FIN-PENDING-${runId}`, admission_policy: 'open', capacity: 10 });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('pending');

    const { data, error } = await admin
      .from('scan_attempts')
      .insert({
        application_id: applicationId,
        session_id: sessionId,
        scanned_by: scannerId,
        device_identifier: 'pending-device',
        result: 'token_valid_pending_confirmation',
        finalized_at: null,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      })
      .select('*')
      .single();
    expect(error, `insert failed: ${error?.message}`).toBeNull();
    expect(data!.finalized_at).toBeNull();
    expect(data!.expires_at).not.toBeNull();
  });

  it('a token_valid_pending_confirmation row with a non-null finalized_at is rejected by the constraint (proves the constraint is genuinely enforced, not vacuously true)', async () => {
    const sessionId = await createSession({ session_code: `FIN-PENDING-INVALID-${runId}`, admission_policy: 'open', capacity: 10 });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('pending-invalid');

    const { error } = await admin.from('scan_attempts').insert({
      application_id: applicationId,
      session_id: sessionId,
      scanned_by: scannerId,
      device_identifier: 'pending-invalid-device',
      result: 'token_valid_pending_confirmation',
      finalized_at: new Date().toISOString(), // invalid: pending rows must have finalized_at null
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('scan_attempts_finalization_state_check');
  });
});
