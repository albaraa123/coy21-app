// tests/attendance/scan-attempt-concurrency-live.test.ts
//
// Real-concurrency coverage for scan_attempt_transactional (Task 11) via
// scanAttemptConfirmForCaller (Task 12) — proving the system's core safety
// guarantee ("physically impossible to overbook a session") under genuine
// JavaScript-level concurrent execution, not sequential awaits.
//
// Fixture pattern follows tests/schedule/concurrency.test.ts and
// tests/attendance/scan-attempt-live.test.ts exactly: real Supabase Auth
// users, real conference_days/rooms/tracks/session_types/sessions rows,
// careful afterAll cleanup in FK-dependency order.
//
// Unlike tests/schedule/concurrency.test.ts (confirm_publication_transactional
// fails fast on lock contention -> one fulfilled + one rejected),
// scan_attempt_transactional uses a bounded retry loop (20 retries * 50ms =
// ~1s worst case) around its pg_try_advisory_xact_lock, so under normal
// two-way contention BOTH calls should resolve with a real decision, never
// one throwing. We therefore use Promise.all (not allSettled) and assert
// both promises genuinely fulfill.
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

let scannerAId: string;
let scannerBId: string;
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
    .insert({ code: `SCAN-CONCUR-ROOM-${runId}-${roomCounter}`, name_ar: 'قاعة', name_en: `Room ${roomCounter}`, capacity: 100 })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create room: ${error?.message}`);
  roomIds.push(data.id);
  return data.id;
}

async function createApplicant(emailLocalPart: string): Promise<{ userId: string; applicationId: string }> {
  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email: `scan-concur-${runId}-${emailLocalPart}@test.local`,
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

async function assignScannerToSession(scannerUserId: string, sessionId: string) {
  const { data, error } = await admin
    .from('scanner_assignments')
    .insert({ scanner_user_id: scannerUserId, session_id: sessionId, assigned_by: staffId })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to assign scanner to session ${sessionId}: ${error?.message}`);
  scannerAssignmentIds.push(data.id);
}

// Seeds N raw attendance_records rows directly (bypassing the RPC) to
// pre-fill a session's admitted count, mirroring
// tests/attendance/scan-attempt-live.test.ts's seedAttendanceRecords.
async function seedAttendanceRecords(sessionId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const { applicationId } = await createApplicant(`fill-${sessionId.slice(0, 8)}-${i}`);
    const { error } = await admin.from('attendance_records').insert({
      application_id: applicationId,
      session_id: sessionId,
      time_slot_group_key: `fill-${sessionId}`,
      entry_type: 'flexible',
      scanned_by: scannerAId,
    });
    if (error) throw new Error(`Failed to seed attendance_records: ${error.message}`);
  }
}

beforeAll(async () => {
  const { data: scannerA } = await admin.auth.admin.createUser({
    email: `scan-concur-${runId}-scanner-a@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  scannerAId = scannerA!.user!.id;
  await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', scannerAId);

  const { data: scannerB } = await admin.auth.admin.createUser({
    email: `scan-concur-${runId}-scanner-b@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  scannerBId = scannerB!.user!.id;
  await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', scannerBId);

  const { data: staff } = await admin.auth.admin.createUser({
    email: `scan-concur-${runId}-staff@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  staffId = staff!.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  const { data: day } = await admin
    .from('conference_days')
    // Distinct conference_date from tests/attendance/scan-attempt-live.test.ts
    // (which uses 2026-09-19) — conference_days.conference_date is unique,
    // and vitest runs test files in parallel by default, so both files'
    // beforeAll hooks can race for the same date otherwise.
    .insert({ conference_date: CONFERENCE_DATE, label_ar: 'يوم', label_en: 'Day', display_order: 1 })
    .select('id')
    .single();
  conferenceDayId = day!.id;

  const { data: track } = await admin.from('tracks').insert({ code: `SCAN-CONCUR-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;

  const { data: sessionType } = await admin.from('session_types').insert({ code: `SCAN-CONCUR-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
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
    admin.auth.admin.deleteUser(scannerAId),
    admin.auth.admin.deleteUser(scannerBId),
    admin.auth.admin.deleteUser(staffId),
  ]);
});

describe('scan_attempt_transactional — real JS-level concurrency', () => {
  it('admits exactly one of two participants racing for the last seat, never overbooking capacity', async () => {
    const capacity = 5;
    const sessionId = await createSession({ session_code: `SCAN-CONCUR-LASTSEAT-1-${runId}`, admission_policy: 'open', capacity });
    await assignScannerToSession(scannerAId, sessionId);
    await assignScannerToSession(scannerBId, sessionId);

    // Fill capacity - 1 seats already admitted.
    await seedAttendanceRecords(sessionId, capacity - 1);

    const { applicationId: applicationIdX } = await createApplicant('lastseat-x');
    const { applicationId: applicationIdY } = await createApplicant('lastseat-y');

    // Two genuinely concurrent calls (different participants, different
    // scanner callers) racing for the single remaining seat.
    const [resultX, resultY] = await Promise.all([
      scanAttemptConfirmForCaller(
        { applicationId: applicationIdX, sessionId, deviceIdentifier: null },
        { userId: scannerAId, service: admin }
      ),
      scanAttemptConfirmForCaller(
        { applicationId: applicationIdY, sessionId, deviceIdentifier: null },
        { userId: scannerBId, service: admin }
      ),
    ]);

    const outcomes = [resultX.result, resultY.result];
    const admittedOutcomes = outcomes.filter((r) => r === 'admitted' || r === 'flexible_admitted');
    const fullOutcomes = outcomes.filter((r) => r === 'full');
    expect(admittedOutcomes).toHaveLength(1);
    expect(fullOutcomes).toHaveLength(1);

    const { data: records } = await admin
      .from('attendance_records')
      .select('*')
      .eq('session_id', sessionId)
      .eq('status', 'admitted');
    expect(records).toHaveLength(capacity);
  });

  it('produces exactly one admitted attendance_records row when the same participant is confirmed by two scanner devices at once', async () => {
    const sessionId = await createSession({ session_code: `SCAN-CONCUR-DUP-1-${runId}`, admission_policy: 'open', capacity: 10 });
    await assignScannerToSession(scannerAId, sessionId);
    await assignScannerToSession(scannerBId, sessionId);

    const { applicationId } = await createApplicant('dup-race-1');

    // Same participant, same session, two different scanner-device callers
    // ("device A" and "device B"), both attempting confirm at the same
    // instant.
    const [resultA, resultB] = await Promise.all([
      scanAttemptConfirmForCaller(
        { applicationId, sessionId, deviceIdentifier: 'device-a' },
        { userId: scannerAId, service: admin }
      ),
      scanAttemptConfirmForCaller(
        { applicationId, sessionId, deviceIdentifier: 'device-b' },
        { userId: scannerBId, service: admin }
      ),
    ]);

    const outcomes = [resultA.result, resultB.result];
    const admittedOutcomes = outcomes.filter((r) => r === 'admitted' || r === 'flexible_admitted');
    const duplicateOutcomes = outcomes.filter((r) => r === 'duplicate');
    expect(admittedOutcomes).toHaveLength(1);
    expect(duplicateOutcomes).toHaveLength(1);

    const { data: records } = await admin
      .from('attendance_records')
      .select('*')
      .eq('application_id', applicationId)
      .eq('session_id', sessionId)
      .eq('status', 'admitted');
    expect(records).toHaveLength(1);
  });
});
