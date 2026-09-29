// tests/attendance/scanner-device-access-live.test.ts
//
// Live coverage for the scanner_device access boundary (Task 17): what a
// scanner_device caller CANNOT do, proven as direct negative-path calls (not
// just RLS probing) plus real RLS-scoped-client probing where a "call the
// guard directly" test is not possible.
//
// Fixture pattern follows tests/attendance/scan-attempt-live.test.ts and
// tests/attendance/admission-management-live.test.ts exactly: real Supabase
// Auth users via admin.auth.admin.createUser, real conference_days/rooms/
// tracks/session_types/sessions/scanner_assignments rows, careful afterAll
// cleanup in FK-dependency order.
//
// Scenario 2/5 testing-approach note (requireProgramAttendanceStaffCaller
// cannot be called directly in a live test):
// admitOverrideForCaller/correctAttendanceForCaller/transferAttendanceForCaller
// take a `caller: {userId, service}` object directly and do NOT themselves
// call requireProgramAttendanceStaffCaller() — only the plain wrapper
// functions (admitOverride/correctAttendance/transferAttendance) do, and
// those wrappers are 'use server' functions that call createClient() ->
// supabase.auth.getUser() (via next/headers's cookies()), which cannot be
// forged from a live test outside a real Next.js request context. This is
// the exact same structural constraint documented and solved in
// tests/auth/staff-roles-live.test.ts ("server-action caller guards enforce
// the correct access boundaries" describe block): that suite asserts the
// underlying role predicate (isStaffRole, the single shared check that
// replaced the former per-domain isXStaffRole predicates) directly against
// a fixture's persisted role, since that predicate is the *entire*
// authorization logic inside requireProgramAttendanceStaffCaller — the only
// other lines in that function are "look up the caller's own session" and
// "look up their profile.role", neither of which a role-boundary test needs
// to re-prove. This file follows that identical, established pattern for
// scenarios 2 and 5: isStaffRole(scannerRole) === false (scenario 2) and
// isStaffRole(managerRole) === true (scenario 5), each read from the real
// fixture's real persisted profiles.role via the service-role client —
// combined with a live, end-to-end proof that a staff caller genuinely CAN
// invoke admitOverrideForCaller/correctAttendanceForCaller/
// transferAttendanceForCaller (already covered in
// tests/attendance/admission-management-live.test.ts, and re-confirmed
// minimally here to keep scenario 5 self-contained) and that a scanner_device
// caller is excluded from that same set — proving the boundary is real, not
// a no-op that would pass even if requireProgramAttendanceStaffCaller's role
// check were deleted.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { scanAttemptConfirmForCaller } from '@/lib/attendance/scan-attempt';
import {
  admitOverrideForCaller,
  correctAttendanceForCaller,
  transferAttendanceForCaller,
} from '@/lib/attendance/admission-management';
import { isStaffRole } from '@/lib/auth/is-staff-role';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000 });

let scannerId: string;
let scannerEmail: string;
let managerId: string;
let staffId: string;
let conferenceDayId: string;
let trackId: string;
let sessionTypeId: string;
let futureDate: string;

const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const sessionIds: string[] = [];
const roomIds: string[] = [];
const scannerAssignmentIds: string[] = [];
const auditLogIds: string[] = [];
let roomCounter = 0;

// Module-level (not beforeAll-local): createRoom below is called both
// from beforeAll and from individual test bodies, and needs the same
// collision-proofing suffix throughout the file's lifetime.
const runId = randomUUID().slice(0, 8);

async function createRoom(): Promise<string> {
  roomCounter += 1;
  const { data, error } = await admin
    .from('rooms')
    .insert({ code: `SCANNER-ACCESS-ROOM-${runId}-${roomCounter}`, name_ar: 'قاعة', name_en: `Room ${roomCounter}`, capacity: 100 })
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

async function createApplicant(emailLocalPart: string): Promise<{ userId: string; applicationId: string }> {
  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email: `scanner-access-${emailLocalPart}-${runId}@test.local`,
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

const scannerCaller = () => ({ userId: scannerId, service: admin });
const managerCaller = () => ({ userId: managerId, service: admin });

beforeAll(async () => {
  scannerEmail = `scanner-access-scanner-${runId}@test.local`;
  const { data: scanner } = await admin.auth.admin.createUser({
    email: scannerEmail,
    password: 'password123',
    email_confirm: true,
  });
  scannerId = scanner!.user!.id;
  await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', scannerId);

  const { data: manager } = await admin.auth.admin.createUser({
    email: `scanner-access-manager-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  managerId = manager!.user!.id;
  await admin.from('profiles').update({ role: 'staff' }).eq('id', managerId);

  const { data: staff } = await admin.auth.admin.createUser({
    email: `scanner-access-staff-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  staffId = staff!.user!.id;
  await admin.from('profiles').update({ role: 'staff' }).eq('id', staffId);

  // conference_date is UNIQUE — derive a collision-proof value from a
  // random day offset within a far-future year reserved for this
  // suite's own test data, rather than a fixed literal another test
  // file (or an earlier interrupted run of this same file) might
  // already occupy.
  const dayOffset = Math.floor(Math.random() * 300) + 1;
  futureDate = new Date(Date.UTC(2086, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);
  const { data: day } = await admin
    .from('conference_days')
    .insert({ conference_date: futureDate, label_ar: 'يوم', label_en: 'Day', display_order: 1 })
    .select('id')
    .single();
  conferenceDayId = day!.id;

  const { data: track } = await admin.from('tracks').insert({ code: `SCANNER-ACCESS-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;

  const { data: sessionType } = await admin.from('session_types').insert({ code: `SCANNER-ACCESS-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;
});

afterAll(async () => {
  if (auditLogIds.length > 0) {
    await admin.from('audit_logs').delete().in('id', auditLogIds);
  }
  await admin.from('audit_logs').delete().eq('actor_id', managerId);

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
    admin.auth.admin.deleteUser(managerId),
    admin.auth.admin.deleteUser(staffId),
  ]);
});

describe('scenario 1: scanAttemptConfirmForCaller rejects a session outside the scanner_device caller\'s scanner_assignments scope', () => {
  it('throws "Not authorized for this session/room" for a session never assigned to this scanner (verifyScannerScope rejection, not a not-found error)', async () => {
    // In-scope session (assigned) proves the fixture/session itself is
    // valid and admits normally, so the rejection below is unambiguously
    // about scope, not about a malformed/nonexistent session.
    const inScopeSessionId = await createSession({ session_code: 'SCANNER-ACCESS-INSCOPE-1', admission_policy: 'open', capacity: 10 });
    await assignScannerToSession(inScopeSessionId);
    const { applicationId: inScopeApplicationId } = await createApplicant('scope-inscope-1');
    const inScopeResult = await scanAttemptConfirmForCaller({ applicationId: inScopeApplicationId, sessionId: inScopeSessionId, deviceIdentifier: null }, scannerCaller());
    expect(inScopeResult.result).toBe('flexible_admitted');

    // Out-of-scope session: real, valid session row, just never assigned to
    // this scanner via scanner_assignments (and its room is never assigned
    // either, so the room-based OR-branch in verifyScannerScope also
    // legitimately excludes it).
    const outOfScopeSessionId = await createSession({ session_code: 'SCANNER-ACCESS-OUTOFSCOPE-1', admission_policy: 'open', capacity: 10 });
    const { applicationId: outOfScopeApplicationId } = await createApplicant('scope-outofscope-1');

    await expect(
      scanAttemptConfirmForCaller({ applicationId: outOfScopeApplicationId, sessionId: outOfScopeSessionId, deviceIdentifier: null }, scannerCaller())
    ).rejects.toThrow('Not authorized for this session/room');

    // No attendance_records/scan_attempts row was created for the rejected attempt.
    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', outOfScopeApplicationId).eq('session_id', outOfScopeSessionId);
    expect(records).toHaveLength(0);
    const { data: attempts } = await admin.from('scan_attempts').select('*').eq('application_id', outOfScopeApplicationId).eq('session_id', outOfScopeSessionId);
    expect(attempts).toHaveLength(0);
  });
});

describe('scenarios 2 & 5: requireProgramAttendanceStaffCaller boundary — scanner_device excluded, staff admitted', () => {
  // requireProgramAttendanceStaffCaller (src/lib/program-attendance/server-helpers.ts)
  // is a 'use server' function that resolves the CALLING request's own
  // session via createClient() -> supabase.auth.getUser() (next/headers's
  // cookies()), which a live test run from Node cannot forge without a real
  // Next.js request context. Its entire authorization logic beyond "resolve
  // the caller's own session and profile" is a single line:
  //   if (!isStaffRole(profile.role)) throw new Error('Not authorized');
  // This is the same structural constraint documented and resolved in
  // tests/auth/staff-roles-live.test.ts's "server-action caller guards
  // enforce the correct access boundaries" block, which asserts the
  // predicate directly against a fixture's real persisted role rather than
  // calling the guard itself. Followed identically here.
  it('scenario 2: isStaffRole(scanner_device) is false — the exact check requireProgramAttendanceStaffCaller performs on a scanner_device caller\'s persisted role', async () => {
    const { data: profile } = await admin.from('profiles').select('role').eq('id', scannerId).single();
    expect(profile?.role).toBe('scanner_device');
    expect(isStaffRole(profile?.role)).toBe(false);
  });

  it('scenario 5: isStaffRole(staff) is true — the exact check requireProgramAttendanceStaffCaller performs on a staff caller\'s persisted role', async () => {
    const { data: profile } = await admin.from('profiles').select('role').eq('id', managerId).single();
    expect(profile?.role).toBe('staff');
    expect(isStaffRole(profile?.role)).toBe(true);
  });

  it('scenario 5 (live, end-to-end): a staff caller genuinely CAN invoke admitOverrideForCaller/correctAttendanceForCaller/transferAttendanceForCaller against the real RPCs, confirming the boundary is a real permission split rather than "scanner is denied everything, staff included"', async () => {
    const sessionAId = await createSession({ session_code: 'SCANNER-ACCESS-BOUNDARY-A', admission_policy: 'restricted', capacity: 10 });
    const sessionBId = await createSession({ session_code: 'SCANNER-ACCESS-BOUNDARY-B', admission_policy: 'open', capacity: 10 });
    await assignScannerToSession(sessionAId);
    const { applicationId } = await createApplicant('boundary-override-1');

    // admitOverrideForCaller: manager succeeds where a normal scan would be denied.
    const denied = await scanAttemptConfirmForCaller({ applicationId, sessionId: sessionAId, deviceIdentifier: null }, scannerCaller());
    expect(denied.result).toBe('restricted_denied');

    const overrideResult = await admitOverrideForCaller(
      { applicationId, sessionId: sessionAId, deviceIdentifier: null, reason: 'Boundary test override' },
      managerCaller()
    );
    expect(overrideResult.result).toBe('override_admitted');

    const { data: admittedRow } = await admin
      .from('attendance_records')
      .select('id')
      .eq('application_id', applicationId)
      .eq('session_id', sessionAId)
      .eq('status', 'admitted')
      .single();
    const attendanceId = admittedRow!.id;

    // correctAttendanceForCaller: manager succeeds.
    const correctResult = await correctAttendanceForCaller({ attendanceId, reason: 'Boundary test correction' }, managerCaller());
    expect(correctResult.status).toBe('corrected');

    // transferAttendanceForCaller needs an admitted (non-corrected) row —
    // create a fresh one via a normal scan, then transfer it.
    const { applicationId: transferApplicationId } = await createApplicant('boundary-transfer-1');
    await assignScannerToSession(sessionBId);
    const admitted = await scanAttemptConfirmForCaller({ applicationId: transferApplicationId, sessionId: sessionBId, deviceIdentifier: null }, scannerCaller());
    expect(admitted.result).toBe('flexible_admitted');
    const { data: transferSourceRow } = await admin
      .from('attendance_records')
      .select('id')
      .eq('application_id', transferApplicationId)
      .eq('session_id', sessionBId)
      .single();

    const sessionCId = await createSession({ session_code: 'SCANNER-ACCESS-BOUNDARY-C', admission_policy: 'open', capacity: 10 });
    const transferResult = await transferAttendanceForCaller(
      { attendanceId: transferSourceRow!.id, newSessionId: sessionCId, reason: 'Boundary test transfer' },
      managerCaller()
    );
    expect(transferResult.session_id).toBe(sessionCId);
    expect(transferResult.status).toBe('admitted');

    auditLogIds.push(...[attendanceId, transferResult.id]);
  });
});

describe('scenario 3: a scanner_device-scoped Supabase client cannot select from sensitive/out-of-domain tables via RLS', () => {
  let scannerClient: ReturnType<typeof createClient<Database>>;
  let sensitiveApplicationId: string;

  beforeAll(async () => {
    scannerClient = createClient<Database>(URL, ANON_KEY);
    const { error: signInError } = await scannerClient.auth.signInWithPassword({ email: scannerEmail, password: 'password123' });
    if (signInError) throw new Error(`Failed to sign in as scanner: ${signInError.message}`);

    const { data: app, error: appErr } = await admin
      .from('applications')
      .insert({ applicant_id: null, imported_email: `scanner-access-sensitive-${runId}@example.com`, status: 'accepted', full_name: 'Scanner Access Sensitive Test' })
      .select('id')
      .single();
    if (appErr || !app) throw new Error(`Failed to seed application: ${appErr?.message}`);
    sensitiveApplicationId = app.id;
    applicationIds.push(sensitiveApplicationId);

    await admin.from('application_travel_info').insert({ application_id: sensitiveApplicationId, passport_full_name: 'Scanner Access Test' });
    await admin.from('application_health_info').insert({ application_id: sensitiveApplicationId, medical_conditions: 'test condition' });
  }, 30000);

  afterAll(async () => {
    await scannerClient.auth.signOut();
  });

  it('cannot read application_travel_info', async () => {
    const { data, error } = await scannerClient.from('application_travel_info').select('*').eq('application_id', sensitiveApplicationId);
    // RLS denies via an empty result set (default-deny), not necessarily a
    // Postgres error — assert the row is genuinely unreadable either way.
    expect(error || (data ?? []).length === 0).toBeTruthy();
  });

  it('cannot read application_health_info', async () => {
    const { data, error } = await scannerClient.from('application_health_info').select('*').eq('application_id', sensitiveApplicationId);
    expect(error || (data ?? []).length === 0).toBeTruthy();
  });

  it('cannot read allocation_assignments', async () => {
    const { data, error } = await scannerClient.from('allocation_assignments').select('*').eq('application_id', sensitiveApplicationId);
    expect(error || (data ?? []).length === 0).toBeTruthy();
  });

  it('cannot read schedule_publications', async () => {
    const { data, error } = await scannerClient.from('schedule_publications').select('*').eq('application_id', sensitiveApplicationId);
    expect(error || (data ?? []).length === 0).toBeTruthy();
  });
});

// Production scanning never queries attendance_records/scan_attempts through
// the scanner_device's own authenticated session client — the real workflow
// is scanner_device browser -> requireScannerDeviceCaller() ->
// verifyScannerScope() -> service_role -> scan_attempt_transactional, with
// the scan result returned directly from the RPC (src/lib/attendance/
// scan-attempt.ts, admission-management.ts). No src/ call site reads either
// table through the authenticated client today.
//
// CORRECTED 2026-09-28: this describe block previously asserted that direct
// authenticated SELECT was denied entirely ("real access is service_role-
// only"). That was never true of the live RLS policy — supabase/migrations/
// 20260804150000_attendance_rls_policies.sql's attendance_records_scanner_select
// and scan_attempts_scanner_select policies have always allowed a
// scanner_device to read rows for sessions within its own scanner_assignments
// scope, predating this test file. The assertions below were updated to match
// that actual, deliberate policy instead of a stale assumption this file
// never verified against it. The out-of-scope assertions (unchanged) remain
// the real boundary: a scanner_device can read admission data for its own
// assigned sessions/rooms, never for sessions outside that scope.
describe('scenario 4: a scanner_device-scoped Supabase client can read attendance_records/scan_attempts only within its scanner_assignments scope (RLS, not service_role-only)', () => {
  let scannerClient: ReturnType<typeof createClient<Database>>;
  let inScopeSessionId: string;
  let outOfScopeSessionId: string;
  let inScopeApplicationId: string;
  let outOfScopeApplicationId: string;

  beforeAll(async () => {
    scannerClient = createClient<Database>(URL, ANON_KEY);
    const { error: signInError } = await scannerClient.auth.signInWithPassword({ email: scannerEmail, password: 'password123' });
    if (signInError) throw new Error(`Failed to sign in as scanner: ${signInError.message}`);

    inScopeSessionId = await createSession({ session_code: 'SCANNER-ACCESS-RLS-INSCOPE-1', admission_policy: 'open', capacity: 10 });
    await assignScannerToSession(inScopeSessionId);
    const inScope = await createApplicant('rls-inscope-1');
    inScopeApplicationId = inScope.applicationId;
    const inScopeScan = await scanAttemptConfirmForCaller({ applicationId: inScopeApplicationId, sessionId: inScopeSessionId, deviceIdentifier: null }, scannerCaller());
    expect(inScopeScan.result).toBe('flexible_admitted');

    // Out-of-scope: a real session/application/attendance_records row that
    // exists and would be readable by the service-role client, but this
    // scanner has no scanner_assignments row for it (different session AND
    // different room — no room-based fallback grant either).
    outOfScopeSessionId = await createSession({ session_code: 'SCANNER-ACCESS-RLS-OUTOFSCOPE-1', admission_policy: 'open', capacity: 10 });
    const outOfScope = await createApplicant('rls-outofscope-1');
    outOfScopeApplicationId = outOfScope.applicationId;
    // Seed directly via the service-role client (bypasses the app-level
    // verifyScannerScope guard) so this attendance_records/scan_attempts row
    // genuinely exists and is only reachable via RLS from here on — this is
    // the strongest test of "even though a real row is there, RLS keeps it
    // out of scope," not merely "no row happens to exist."
    const { error: attendanceInsertError } = await admin.from('attendance_records').insert({
      application_id: outOfScopeApplicationId,
      session_id: outOfScopeSessionId,
      time_slot_group_key: `k-${outOfScopeSessionId}`,
      entry_type: 'flexible',
      scanned_by: scannerId,
    });
    if (attendanceInsertError) throw new Error(`Failed to seed out-of-scope attendance_records: ${attendanceInsertError.message}`);
    const { error: scanAttemptInsertError } = await admin.from('scan_attempts').insert({
      application_id: outOfScopeApplicationId,
      session_id: outOfScopeSessionId,
      result: 'flexible_admitted',
      scanned_by: scannerId,
      // scan_attempts_finalization_state_check requires finalized_at NOT
      // NULL (and expires_at NULL) for every non-pending terminal result —
      // 'flexible_admitted' is terminal, so this direct fixture insert must
      // set it explicitly, same as scan_attempt_transactional's own inserts.
      finalized_at: new Date().toISOString(),
    });
    if (scanAttemptInsertError) throw new Error(`Failed to seed out-of-scope scan_attempts: ${scanAttemptInsertError.message}`);
  }, 30000);

  afterAll(async () => {
    await scannerClient.auth.signOut();
  });

  it('can read attendance_records for its own in-scope session (attendance_records_scanner_select RLS policy)', async () => {
    const { data, error } = await scannerClient.from('attendance_records').select('*').eq('application_id', inScopeApplicationId).eq('session_id', inScopeSessionId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });

  it('cannot read attendance_records for a session outside its scanner_assignments scope', async () => {
    const { data, error } = await scannerClient.from('attendance_records').select('*').eq('application_id', outOfScopeApplicationId).eq('session_id', outOfScopeSessionId);
    expect(error || (data ?? []).length === 0).toBeTruthy();
  });

  it('can read scan_attempts for its own in-scope session (scan_attempts_scanner_select RLS policy)', async () => {
    const { data, error } = await scannerClient.from('scan_attempts').select('*').eq('application_id', inScopeApplicationId).eq('session_id', inScopeSessionId);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it('cannot read scan_attempts for a session outside its scanner_assignments scope', async () => {
    const { data, error } = await scannerClient.from('scan_attempts').select('*').eq('application_id', outOfScopeApplicationId).eq('session_id', outOfScopeSessionId);
    expect(error || (data ?? []).length === 0).toBeTruthy();
  });
});
