// tests/attendance/scan-attempt-live.test.ts
//
// Live, end-to-end coverage for scanAttemptPreviewForCaller/
// scanAttemptConfirmForCaller (Task 12) against the real, deployed
// scan_attempt_transactional RPC (Task 11) and real Postgres tables — not
// the pure resolveAdmissionDecision unit tests (Task 8,
// tests/attendance/resolve-admission-decision.test.ts), and not the
// implementer's disposable smoke tests from Task 11. This is the first
// permanent, committed coverage for the whole scan-confirmation flow.
//
// Fixture pattern follows tests/schedule/concurrency.test.ts exactly: real
// Supabase Auth users via admin.auth.admin.createUser, real
// conference_days/rooms/tracks/session_types/sessions rows, real
// allocation_runs/allocation_assignments rows for "recommended" scenarios,
// and careful afterAll cleanup in FK-dependency order.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { scanAttemptConfirmForCaller, scanAttemptPreviewForCaller } from '@/lib/attendance/scan-attempt';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

let scannerId: string;
let staffId: string;
let conferenceDayId: string;
let pastConferenceDayId: string;
let futureDate: string;
let pastDate: string;
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

// Module-level (not beforeAll-local): createRoom below is called both
// from beforeAll and from individual test bodies, and needs the same
// collision-proofing suffix throughout the file's lifetime. Randomized
// identifiers (email local-parts, unique codes, conference date) rather
// than fixed literals — a fixed value collides with a leftover row from
// any earlier run whose own afterAll cleanup didn't complete (e.g. an
// interrupted test process) — FIXTURE COLLISION, not a production
// defect. Matches the randomUUID()-suffix convention every other live
// test file in this suite already uses.
const runId = randomUUID().slice(0, 8);

// Sessions must live within one room-time exclusion domain
// (sessions_room_no_overlap) and each session's date must match its
// conference_day_id's conference_date (sessions_triggers.sql) — so every
// test session gets its own freshly created room, and sessions that need
// a past start_time (late-entry-cutoff scenarios) get their own past
// conference_day.
async function createRoom(): Promise<string> {
  roomCounter += 1;
  const { data, error } = await admin
    .from('rooms')
    .insert({ code: `SCAN-LIVE-ROOM-${runId}-${roomCounter}`, name_ar: 'قاعة', name_en: `Room ${roomCounter}`, capacity: 100 })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create room: ${error?.message}`);
  roomIds.push(data.id);
  return data.id;
}

const caller = () => ({ userId: scannerId, service: admin });

async function createApplicant(emailLocalPart: string): Promise<{ userId: string; applicationId: string }> {
  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email: `scan-live-${emailLocalPart}-${runId}@test.local`,
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
      start_time: `${futureDate}T09:00:00Z`,
      end_time: `${futureDate}T10:00:00Z`,
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

async function makeRecommended(applicationId: string, sessionId: string, timeSlotGroupKey = 'k-recommended') {
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

// Seeds N raw attendance_records + scan_attempts rows directly (bypassing
// the RPC) to fill a session's capacity for the "full" scenario, without
// needing N real distinct recommended/non-recommended admission flows.
async function seedAttendanceRecords(sessionId: string, count: number, entryType: 'priority' | 'flexible' = 'flexible') {
  for (let i = 0; i < count; i++) {
    const { userId, applicationId } = await createApplicant(`fill-${sessionId.slice(0, 8)}-${i}`);
    void userId;
    const { error } = await admin.from('attendance_records').insert({
      application_id: applicationId,
      session_id: sessionId,
      time_slot_group_key: `fill-${sessionId}`,
      entry_type: entryType,
      scanned_by: scannerId,
    });
    if (error) throw new Error(`Failed to seed attendance_records: ${error.message}`);
  }
}

// Several scenarios below perform many sequential real network round-trips
// against the live Supabase project in one test (Auth Admin user creation,
// multiple table inserts, one or more real RPC calls — e.g. seeding
// attendance_records to reach capacity, or admitting several applicants
// in the priority-release/unused-priority-seat scenarios). Vitest's 5s
// default is too tight for that; raise it file-wide to match the generous
// headroom used by other live-DB suites in this repo.
//
// Deliberately file-wide (vi.setConfig) rather than per-test third-argument
// timeouts (this repo's more common convention, e.g. `}, 120000)` in
// tests/import/*-live.test.ts) — unlike those suites, EVERY test here does
// nontrivial per-test fixture setup (its own session/room/application, not
// just a shared fixture), so no test in this file is meaningfully "trivial"
// enough to warrant a narrower per-test timeout; a uniform ceiling is
// simpler to reason about than 13 individually-tuned values that would all
// converge on roughly the same number anyway.
vi.setConfig({ testTimeout: 30000 });

beforeAll(async () => {
  const { data: scanner } = await admin.auth.admin.createUser({
    email: `scan-live-scanner-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  scannerId = scanner!.user!.id;
  await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', scannerId);

  const { data: staff } = await admin.auth.admin.createUser({
    email: `scan-live-staff-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  staffId = staff!.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  // conference_date is UNIQUE; derive a collision-proof value from a
  // random day offset within a far-future year reserved for this suite's
  // own test data, rather than any fixed literal date another test file
  // (or an earlier interrupted run of this same file) might already
  // occupy.
  const dayOffset = Math.floor(Math.random() * 300) + 1;
  futureDate = new Date(Date.UTC(2085, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);
  const { data: day } = await admin
    .from('conference_days')
    .insert({ conference_date: futureDate, label_ar: 'يوم', label_en: 'Day', display_order: 1 })
    .select('id')
    .single();
  conferenceDayId = day!.id;
  conferenceDayIds.push(conferenceDayId);

  // Separate conference day dated in the past, for late-entry-cutoff
  // sessions that need a start_time far enough in the past to already be
  // past their cutoff (sessions must fall on their conference_day_id's
  // conference_date per sessions_triggers.sql). Randomized within a
  // long-past range reserved for this purpose, same collision-avoidance
  // reasoning as futureDate above.
  const pastDayOffset = Math.floor(Math.random() * 300) + 1;
  pastDate = new Date(Date.UTC(1975, 0, 1) + pastDayOffset * 86400000).toISOString().slice(0, 10);
  const { data: pastDay } = await admin
    .from('conference_days')
    .insert({ conference_date: pastDate, label_ar: 'يوم ماضٍ', label_en: 'Past Day', display_order: 2 })
    .select('id')
    .single();
  pastConferenceDayId = pastDay!.id;
  conferenceDayIds.push(pastConferenceDayId);

  const { data: track } = await admin.from('tracks').insert({ code: `SCAN-LIVE-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;

  const { data: sessionType } = await admin.from('session_types').insert({ code: `SCAN-LIVE-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;

  const { data: featureRun } = await admin
    .from('feature_extraction_runs')
    .insert({ rules_version: 1, application_count: 1, run_by: staffId })
    .select('id')
    .single();
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

afterAll(async () => {
  // scan_attempts + attendance_records first (deepest dependents).
  if (sessionIds.length > 0) {
    await admin.from('scan_attempts').delete().in('session_id', sessionIds);
    await admin.from('attendance_records').delete().in('session_id', sessionIds);
  }
  if (allocationAssignmentIds.length > 0) {
    await admin.from('allocation_assignments').delete().in('id', allocationAssignmentIds);
  }
  await admin.from('allocation_runs').delete().eq('id', allocationRunId);
  await admin.from('feature_extraction_runs').delete().eq('id', featureRunId);
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
  if (conferenceDayIds.length > 0) {
    await admin.from('conference_days').delete().in('id', conferenceDayIds);
  }
  if (applicationIds.length > 0) {
    await admin.from('applications').delete().in('id', applicationIds);
  }
  await Promise.allSettled([
    ...applicantUserIds.map((id) => admin.auth.admin.deleteUser(id)),
    admin.auth.admin.deleteUser(scannerId),
    admin.auth.admin.deleteUser(staffId),
  ]);
});

describe('scanAttemptConfirmForCaller / scanAttemptPreviewForCaller — live RPC coverage', () => {
  it('admits a recommended participant to a priority_then_open session as admitted/priority', async () => {
    const sessionId = await createSession({ session_code: 'SCAN-PRIORITY-1', admission_policy: 'priority_then_open', capacity: 10, priority_seats: 6 });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('priority-1');
    await makeRecommended(applicationId, sessionId, `k-${sessionId}`);

    // Note: the RPC returns a scan_attempts row (result.result is a
    // scan_attempts.result value); scan_attempts has no entry_type column
    // — entry_type lives only on attendance_records, asserted below.
    const result = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    expect(result.result).toBe('admitted');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(records).toHaveLength(1);
    expect(records![0].entry_type).toBe('priority');
  });

  it('flexibly admits a non-recommended participant to an open session', async () => {
    const sessionId = await createSession({ session_code: 'SCAN-OPEN-1', admission_policy: 'open', capacity: 10 });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('open-1');

    const result = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    expect(result.result).toBe('flexible_admitted');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(records).toHaveLength(1);
    expect(records![0].entry_type).toBe('flexible');
  });

  it('denies a non-recommended participant at a restricted session with no attendance_records row', async () => {
    const sessionId = await createSession({ session_code: 'SCAN-RESTRICTED-1', admission_policy: 'restricted', capacity: 10 });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('restricted-1');

    const result = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    expect(result.result).toBe('restricted_denied');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(records).toHaveLength(0);
  });

  it('unconditionally flexibly admits at a plenary session', async () => {
    const sessionId = await createSession({ session_code: 'SCAN-PLENARY-1', admission_policy: 'plenary', capacity: 10 });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('plenary-1');

    const result = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    expect(result.result).toBe('flexible_admitted');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(records).toHaveLength(1);
    expect(records![0].entry_type).toBe('flexible');
  });

  it('returns full at capacity, even for a recommended participant', async () => {
    const sessionId = await createSession({ session_code: 'SCAN-FULL-1', admission_policy: 'priority_then_open', capacity: 2, priority_seats: 1 });
    await assignScannerToSession(sessionId);
    await seedAttendanceRecords(sessionId, 2);

    const { applicationId } = await createApplicant('full-1');
    await makeRecommended(applicationId, sessionId, `k-${sessionId}`);

    const result = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    expect(result.result).toBe('full');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(records).toHaveLength(0);
  });

  it('returns duplicate on a second confirm for the same participant/session, leaving exactly one attendance_records row', async () => {
    const sessionId = await createSession({ session_code: 'SCAN-DUP-1', admission_policy: 'open', capacity: 10 });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('dup-1');

    const first = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    expect(first.result).toBe('flexible_admitted');

    const second = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    expect(second.result).toBe('duplicate');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(records).toHaveLength(1);
  });

  it('returns timeslot_conflict when attempting a second, time-overlapping session on the same day', async () => {
    const sessionAId = await createSession({
      session_code: 'SCAN-CONFLICT-A',
      admission_policy: 'open',
      capacity: 10,
      start_time: `${futureDate}T11:00:00Z`,
      end_time: `${futureDate}T12:00:00Z`,
    });
    const sessionBId = await createSession({
      session_code: 'SCAN-CONFLICT-B',
      admission_policy: 'open',
      capacity: 10,
      // Overlaps session A's [11:00, 12:00) window.
      start_time: `${futureDate}T11:30:00Z`,
      end_time: `${futureDate}T12:30:00Z`,
    });
    await assignScannerToSession(sessionAId);
    await assignScannerToSession(sessionBId);
    const { applicationId } = await createApplicant('conflict-1');

    const admitted = await scanAttemptConfirmForCaller({ applicationId, sessionId: sessionAId, deviceIdentifier: null }, caller());
    expect(admitted.result).toBe('flexible_admitted');

    const conflicting = await scanAttemptConfirmForCaller({ applicationId, sessionId: sessionBId, deviceIdentifier: null }, caller());
    expect(conflicting.result).toBe('timeslot_conflict');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionBId);
    expect(records).toHaveLength(0);
  });

  it('blocks a normal confirm past the late-entry cutoff with invalid_qr (per resolveAdmissionDecision/RPC collapse, not a distinct "late" code)', async () => {
    // start_time far enough in the past that "now" is well past
    // start_time + late_entry_cutoff_minutes.
    const sessionId = await createSession({
      session_code: 'SCAN-LATE-1',
      admission_policy: 'open',
      capacity: 10,
      conference_day_id: pastConferenceDayId,
      start_time: `${pastDate}T09:00:00Z`,
      end_time: `${pastDate}T10:00:00Z`,
      late_entry_cutoff_minutes: 15,
    });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('late-1');

    const result = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    expect(result.result).toBe('invalid_qr');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(records).toHaveLength(0);
  });

  it('override half of the late-entry-cutoff scenario, exercised via a DIRECT RPC call (not scanAttemptConfirmForCaller)', async () => {
    // scanAttemptConfirmForCaller hardcodes p_is_override_caller: false by
    // deliberate design (Task 12) — override admission is scoped to a
    // separate, manager-only code path that Task 15 will build as the real
    // production caller for this capability. scanAttemptConfirmForCaller
    // therefore structurally cannot exercise this branch. This test calls
    // scan_attempt_transactional directly with the service-role client,
    // bypassing the wrapper, solely to prove the underlying RPC's override
    // branch itself works correctly ahead of Task 15's real caller.
    //
    // Per the RPC (20260804160000_scan_attempt_transactional_function.sql):
    // the late-entry-cutoff check itself is skipped entirely when
    // p_is_override_caller is true (`and not p_is_override_caller` in the
    // elsif), so evaluation falls through to the normal admission_policy
    // switch below it. On a plain 'open' session that switch alone would
    // just yield flexible_admitted — no different from a non-override
    // call — which would not actually demonstrate the override branch
    // doing anything. The v_result -> 'override_admitted' conversion at
    // the bottom of the function only fires for results in
    // ('restricted_denied', 'full', 'priority_hold'), so this session uses
    // admission_policy='restricted' (which a non-recommended, non-override
    // caller would get restricted_denied from) — that is what actually
    // proves the override conversion path itself works, on top of proving
    // the cutoff bypass.
    const sessionId = await createSession({
      session_code: 'SCAN-LATE-OVERRIDE-1',
      admission_policy: 'restricted',
      capacity: 10,
      conference_day_id: pastConferenceDayId,
      start_time: `${pastDate}T09:00:00Z`,
      end_time: `${pastDate}T10:00:00Z`,
      late_entry_cutoff_minutes: 15,
    });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('late-override-1');

    const { data, error } = await admin.rpc('scan_attempt_transactional', {
      p_application_id: applicationId,
      p_session_id: sessionId,
      p_scanned_by: scannerId,
      p_device_identifier: null as unknown as string,
      p_time_slot_group_key: `k-${sessionId}`,
      p_is_override_caller: true,
    });
    expect(error).toBeNull();
    expect(data!.result).toBe('override_admitted');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(records).toHaveLength(1);
    expect(records![0].entry_type).toBe('override');
  });

  it('produces exactly one scan_attempts row with the correct result for every attempt, success or failure', async () => {
    const sessionId = await createSession({ session_code: 'SCAN-AUDIT-1', admission_policy: 'restricted', capacity: 10 });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('audit-1');

    const result = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
    expect(result.result).toBe('restricted_denied');

    const { data: attempts } = await admin.from('scan_attempts').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(attempts).toHaveLength(1);
    expect(attempts![0].result).toBe('restricted_denied');
  });

  it('scanAttemptPreviewForCaller never writes to attendance_records or scan_attempts', async () => {
    const sessionId = await createSession({ session_code: 'SCAN-PREVIEW-1', admission_policy: 'open', capacity: 10 });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('preview-1');

    const before = await Promise.all([
      admin.from('attendance_records').select('*', { count: 'exact', head: true }).eq('session_id', sessionId),
      admin.from('scan_attempts').select('*', { count: 'exact', head: true }).eq('session_id', sessionId),
    ]);

    const preview = await scanAttemptPreviewForCaller({ applicationId, sessionId }, caller());
    expect(preview.decision.result).toBe('flexible_admitted');

    const after = await Promise.all([
      admin.from('attendance_records').select('*', { count: 'exact', head: true }).eq('session_id', sessionId),
      admin.from('scan_attempts').select('*', { count: 'exact', head: true }).eq('session_id', sessionId),
    ]);

    expect(after[0].count).toBe(before[0].count);
    expect(after[1].count).toBe(before[1].count);
  });

  describe('priority_then_open release timing against the real RPC', () => {
    it('holds a non-recommended participant before priority_release_at, then flexibly admits the same participant after it has passed', async () => {
      const sessionId = await createSession({
        session_code: 'SCAN-RELEASE-1',
        admission_policy: 'priority_then_open',
        capacity: 10,
        priority_seats: 6,
        // Far in the future: definitely not yet released for the first attempt.
        priority_release_at: '2099-01-01T00:00:00Z',
      });
      await assignScannerToSession(sessionId);

      // Fill the flexible pool (capacity - priority_seats = 4) with 4
      // flexible admissions so the "before release" attempt has no
      // remaining flexible-pool room and therefore is unambiguously a
      // priority_hold (not incidentally flexible_admitted because the
      // pool still had space).
      await seedAttendanceRecords(sessionId, 4, 'flexible');

      const { applicationId } = await createApplicant('release-1');

      const before = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
      expect(before.result).toBe('priority_hold');
      const { data: recordsBefore } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
      expect(recordsBefore).toHaveLength(0);

      // Move priority_release_at into the past so the flexible pool opens
      // up (4 unused priority seats join the flexible pool), then retry
      // the SAME participant.
      await admin.from('sessions').update({ priority_release_at: '2020-01-01T00:00:00Z' }).eq('id', sessionId);

      const after = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
      expect(after.result).toBe('flexible_admitted');
      const { data: recordsAfter } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
      expect(recordsAfter).toHaveLength(1);
      expect(recordsAfter![0].entry_type).toBe('flexible');
    });
  });

  describe('unused priority-seat auto-release against the real RPC', () => {
    it('counts unused priority seats toward the flexible pool once priority_release_at has passed', async () => {
      // capacity=10, priority_seats=6 -> flexible pool pre-release = 4.
      // Admit fewer priority participants (2) than priority_seats (6)
      // allows, then advance past priority_release_at: the 4 unused
      // priority seats should join the flexible pool, giving a total
      // flexible capacity of 4 + 4 = 8.
      const sessionId = await createSession({
        session_code: 'SCAN-UNUSED-PRIORITY-1',
        admission_policy: 'priority_then_open',
        capacity: 10,
        priority_seats: 6,
        priority_release_at: '2020-01-01T00:00:00Z', // already past
      });
      await assignScannerToSession(sessionId);

      // Admit 2 recommended (priority) participants — well under the 6
      // priority_seats allowance.
      for (let i = 0; i < 2; i++) {
        const { applicationId } = await createApplicant(`unused-priority-p${i}`);
        await makeRecommended(applicationId, sessionId, `k-${sessionId}`);
        const result = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, caller());
        expect(result.result).toBe('admitted');
      }

      const { count: priorityCount } = await admin
        .from('attendance_records')
        .select('*', { count: 'exact', head: true })
        .eq('session_id', sessionId)
        .eq('entry_type', 'priority');
      expect(priorityCount).toBe(2);

      // Now confirm a non-recommended participant: expected flexible pool
      // = (10 - 6) + max(0, 6 - 2) = 4 + 4 = 8, with 0 flexible admitted so
      // far -> room -> flexible_admitted.
      const { applicationId: flexApplicationId } = await createApplicant('unused-priority-flex-1');
      const flexResult = await scanAttemptConfirmForCaller({ applicationId: flexApplicationId, sessionId, deviceIdentifier: null }, caller());
      expect(flexResult.result).toBe('flexible_admitted');

      const { data: flexRecords } = await admin
        .from('attendance_records')
        .select('*')
        .eq('application_id', flexApplicationId)
        .eq('session_id', sessionId);
      expect(flexRecords).toHaveLength(1);
      expect(flexRecords![0].entry_type).toBe('flexible');
    });
  });
});
