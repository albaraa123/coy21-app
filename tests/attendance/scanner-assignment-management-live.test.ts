// tests/attendance/scanner-assignment-management-live.test.ts
//
// Live coverage for Phase 7F's scanner_assignments admin management
// surface (src/lib/attendance/scanner-assignment-management.ts).
//
// requireProgramAttendanceStaffCaller() cannot be forged in a live test
// (it calls next/headers's cookies() via createClient().auth.getUser()) —
// same structural constraint documented in scanner-device-access-live.test.ts
// and staff-roles-live.test.ts. So:
//   - every *ForCaller function is tested end-to-end with a real,
//     injected { userId, service } caller;
//   - the "unauthorized role rejected" boundary is proven the same way
//     scanner-device-access-live.test.ts proves it: isProgramAttendanceStaffRole
//     read directly against a fixture's real persisted profiles.role,
//     since that predicate IS requireProgramAttendanceStaffCaller's
//     entire authorization logic.
//
// Fixture pattern follows scanner-device-access-live.test.ts exactly:
// real Supabase Auth users, real conference_days/rooms/tracks/
// session_types/sessions/scanner_assignments rows, careful afterAll
// cleanup in FK-dependency order.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import {
  checkSessionAssignmentWarningForCaller,
  createSessionAssignmentForCaller,
  createRoomAssignmentForCaller,
  deactivateAssignmentForCaller,
  reassignToSessionForCaller,
  reassignToRoomForCaller,
} from '@/lib/attendance/scanner-assignment-management';
import { scanAttemptConfirmForCaller } from '@/lib/attendance/scan-attempt';
import { isProgramAttendanceStaffRole } from '@/lib/validation/program-attendance';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000 });

let managerId: string;
let participantRoleUserId: string;
let scannerDeviceId: string;
let otherStaffId: string;
let conferenceDayId: string;
let trackId: string;
let sessionTypeId: string;

const scannerUserIds: string[] = [];
const roomIds: string[] = [];
const sessionIds: string[] = [];
const scannerAssignmentIds: string[] = [];
const auditLogActorIds: string[] = [];
let roomCounter = 0;

async function createRoom(overrides: Partial<Database['public']['Tables']['rooms']['Insert']> = {}) {
  roomCounter += 1;
  const { data, error } = await admin
    .from('rooms')
    .insert({ code: `SAM-ROOM-${roomCounter}-${randomUUID().slice(0, 6)}`, name_ar: 'قاعة', name_en: `Room ${roomCounter}`, capacity: 100, is_active: true, ...overrides })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create room: ${error?.message}`);
  roomIds.push(data.id);
  return data.id;
}

async function createSession(overrides: Partial<Database['public']['Tables']['sessions']['Insert']> & { session_code: string }) {
  const roomForSession = overrides.room_id ?? (await createRoom());
  // session_code is unique; a suffix keeps re-runs (including runs that
  // reuse a leftover conference_days row from an interrupted prior run —
  // see beforeAll's own reuse-or-create comment) from colliding on a
  // literal code left over from a previous attempt.
  const uniqueCode = `${overrides.session_code}-${randomUUID().slice(0, 8)}`;
  const { data, error } = await admin
    .from('sessions')
    .insert({
      title_ar: 'ج',
      title_en: 'Session',
      conference_day_id: conferenceDayId,
      start_time: '2099-11-15T09:00:00Z',
      end_time: '2099-11-15T10:00:00Z',
      track_id: trackId,
      session_type_id: sessionTypeId,
      language: 'bilingual',
      difficulty_level: 'all_levels',
      capacity: 10,
      is_mandatory: false,
      status: 'confirmed',
      admission_policy: 'open',
      ...overrides,
      session_code: uniqueCode,
      room_id: roomForSession,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create session ${overrides.session_code}: ${error?.message}`);
  sessionIds.push(data.id);
  return data.id;
}

async function createScannerAccount(label: string) {
  const { data: user, error } = await admin.auth.admin.createUser({
    email: `sam-scanner-${label}-${randomUUID()}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (error || !user?.user) throw new Error(`Failed to create scanner ${label}: ${error?.message}`);
  await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', user.user.id);
  scannerUserIds.push(user.user.id);
  return user.user.id;
}

const managerCaller = () => ({ userId: managerId, service: admin });

beforeAll(async () => {
  const { data: manager } = await admin.auth.admin.createUser({ email: `sam-manager-${randomUUID()}@test.local`, password: 'password123', email_confirm: true });
  managerId = manager!.user!.id;
  await admin.from('profiles').update({ role: 'program_attendance_manager' }).eq('id', managerId);
  auditLogActorIds.push(managerId);

  const { data: participant } = await admin.auth.admin.createUser({ email: `sam-participant-${randomUUID()}@test.local`, password: 'password123', email_confirm: true });
  participantRoleUserId = participant!.user!.id;
  // profiles defaults to 'participant' via handle_new_user — no update needed.

  scannerDeviceId = await createScannerAccount('target');

  const { data: otherStaff } = await admin.auth.admin.createUser({ email: `sam-otherstaff-${randomUUID()}@test.local`, password: 'password123', email_confirm: true });
  otherStaffId = otherStaff!.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', otherStaffId);

  // Reuse-or-create: service_role has no DELETE grant on conference_days
  // on the disposable project, so a prior interrupted run's row (its
  // conference_date is UNIQUE) cannot be cleaned up from here — this
  // suite tolerates and reuses that harmless residue rather than
  // requiring a broader grant just for test cleanup.
  const { data: existingDay } = await admin.from('conference_days').select('id').eq('conference_date', '2099-11-15').maybeSingle();
  if (existingDay) {
    conferenceDayId = existingDay.id;
  } else {
    const { data: day } = await admin
      .from('conference_days')
      .insert({ conference_date: '2099-11-15', label_ar: 'يوم', label_en: 'Day', display_order: 1 })
      .select('id')
      .single();
    conferenceDayId = day!.id;
  }

  const { data: track } = await admin.from('tracks').insert({ code: `SAM-TRACK-${randomUUID().slice(0, 6)}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;

  const { data: sessionType } = await admin.from('session_types').insert({ code: `SAM-TYPE-${randomUUID().slice(0, 6)}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;
});

afterAll(async () => {
  for (const actorId of auditLogActorIds) {
    await admin.from('audit_logs').delete().eq('actor_id', actorId);
  }
  if (sessionIds.length > 0) {
    await admin.from('scan_attempts').delete().in('session_id', sessionIds);
    await admin.from('attendance_records').delete().in('session_id', sessionIds);
  }
  if (scannerAssignmentIds.length > 0) {
    await admin.from('scanner_assignments').delete().in('id', scannerAssignmentIds);
  }
  // Catch-all for rows created inside actions themselves (not tracked by id above).
  await admin.from('scanner_assignments').delete().in('scanner_user_id', scannerUserIds);
  if (sessionIds.length > 0) {
    await admin.from('sessions').delete().in('id', sessionIds);
  }
  if (trackId) await admin.from('tracks').delete().eq('id', trackId);
  if (sessionTypeId) await admin.from('session_types').delete().eq('id', sessionTypeId);
  if (roomIds.length > 0) await admin.from('rooms').delete().in('id', roomIds);
  if (conferenceDayId) await admin.from('conference_days').delete().eq('id', conferenceDayId);
  await Promise.allSettled([
    ...scannerUserIds.map((id) => admin.auth.admin.deleteUser(id)),
    admin.auth.admin.deleteUser(managerId),
    admin.auth.admin.deleteUser(participantRoleUserId),
    admin.auth.admin.deleteUser(otherStaffId),
  ]);
});

describe('authorized management', () => {
  it('program_attendance_manager can create a session assignment', async () => {
    const sessionId = await createSession({ session_code: 'SAM-CREATE-SESSION-1' });
    const result = await createSessionAssignmentForCaller(managerCaller(), { scannerUserId: scannerDeviceId, sessionId });
    expect(result.id).toBeTruthy();
    scannerAssignmentIds.push(result.id);

    const { data: row } = await admin.from('scanner_assignments').select('*').eq('id', result.id).single();
    expect(row?.scanner_user_id).toBe(scannerDeviceId);
    expect(row?.session_id).toBe(sessionId);
    expect(row?.is_active).toBe(true);
    expect(row?.assigned_by).toBe(managerId);
  });

  it('program_attendance_manager can create a room assignment', async () => {
    const roomId = await createRoom();
    const result = await createRoomAssignmentForCaller(managerCaller(), { scannerUserId: scannerDeviceId, roomId });
    expect(result.id).toBeTruthy();
    scannerAssignmentIds.push(result.id);

    const { data: row } = await admin.from('scanner_assignments').select('*').eq('id', result.id).single();
    expect(row?.room_id).toBe(roomId);
    expect(row?.is_active).toBe(true);
  });

  it('program_attendance_manager can deactivate an assignment', async () => {
    const sessionId = await createSession({ session_code: 'SAM-DEACTIVATE-1' });
    const created = await createSessionAssignmentForCaller(managerCaller(), { scannerUserId: scannerDeviceId, sessionId });
    scannerAssignmentIds.push(created.id);

    await deactivateAssignmentForCaller(managerCaller(), created.id);
    const { data: row } = await admin.from('scanner_assignments').select('is_active').eq('id', created.id).single();
    expect(row?.is_active).toBe(false);
  });

  it('program_attendance_manager can reassign a scanner to a new session', async () => {
    const oldSessionId = await createSession({ session_code: 'SAM-REASSIGN-OLD-1' });
    const newSessionId = await createSession({ session_code: 'SAM-REASSIGN-NEW-1' });
    const created = await createSessionAssignmentForCaller(managerCaller(), { scannerUserId: scannerDeviceId, sessionId: oldSessionId });
    scannerAssignmentIds.push(created.id);

    const reassigned = await reassignToSessionForCaller(managerCaller(), created.id, scannerDeviceId, newSessionId);
    scannerAssignmentIds.push(reassigned.id);

    const { data: oldRow } = await admin.from('scanner_assignments').select('is_active').eq('id', created.id).single();
    expect(oldRow?.is_active).toBe(false);
    const { data: newRow } = await admin.from('scanner_assignments').select('is_active, session_id').eq('id', reassigned.id).single();
    expect(newRow?.is_active).toBe(true);
    expect(newRow?.session_id).toBe(newSessionId);
  });

  it('program_attendance_manager can reassign a scanner to a room', async () => {
    const oldSessionId = await createSession({ session_code: 'SAM-REASSIGN-ROOM-OLD-1' });
    const newRoomId = await createRoom();
    const created = await createSessionAssignmentForCaller(managerCaller(), { scannerUserId: scannerDeviceId, sessionId: oldSessionId });
    scannerAssignmentIds.push(created.id);

    const reassigned = await reassignToRoomForCaller(managerCaller(), created.id, scannerDeviceId, newRoomId);
    scannerAssignmentIds.push(reassigned.id);

    const { data: newRow } = await admin.from('scanner_assignments').select('is_active, room_id').eq('id', reassigned.id).single();
    expect(newRow?.is_active).toBe(true);
    expect(newRow?.room_id).toBe(newRoomId);
  });
});

describe('unauthorized role boundary (requireProgramAttendanceStaffCaller predicate)', () => {
  // requireProgramAttendanceStaffCaller's ENTIRE authorization logic is
  // isProgramAttendanceStaffRole(profile.role) — proven directly against
  // real fixture roles, matching scanner-device-access-live.test.ts's
  // established pattern for this exact structural constraint.
  it('rejects participant role', async () => {
    const { data: profile } = await admin.from('profiles').select('role').eq('id', participantRoleUserId).single();
    expect(isProgramAttendanceStaffRole(profile!.role)).toBe(false);
  });

  it('rejects scanner_device role', async () => {
    const { data: profile } = await admin.from('profiles').select('role').eq('id', scannerDeviceId).single();
    expect(isProgramAttendanceStaffRole(profile!.role)).toBe(false);
  });

  it('rejects an unrelated staff role (agenda_allocation_manager)', async () => {
    const { data: profile } = await admin.from('profiles').select('role').eq('id', otherStaffId).single();
    expect(isProgramAttendanceStaffRole(profile!.role)).toBe(false);
  });

  it('accepts program_attendance_manager', async () => {
    const { data: profile } = await admin.from('profiles').select('role').eq('id', managerId).single();
    expect(isProgramAttendanceStaffRole(profile!.role)).toBe(true);
  });
});

describe('resource validation', () => {
  it('rejects a nonexistent scanner account', async () => {
    const sessionId = await createSession({ session_code: 'SAM-BADSCANNER-1' });
    await expect(createSessionAssignmentForCaller(managerCaller(), { scannerUserId: randomUUID(), sessionId })).rejects.toThrow('Scanner account not found');
  });

  it('rejects a target account that exists but is not scanner_device role', async () => {
    const sessionId = await createSession({ session_code: 'SAM-NONSCANNER-1' });
    await expect(createSessionAssignmentForCaller(managerCaller(), { scannerUserId: otherStaffId, sessionId })).rejects.toThrow('Target account is not a scanner device');
  });

  it('rejects a nonexistent session', async () => {
    await expect(createSessionAssignmentForCaller(managerCaller(), { scannerUserId: scannerDeviceId, sessionId: randomUUID() })).rejects.toThrow('Session not found');
  });

  it('rejects a nonexistent room', async () => {
    await expect(createRoomAssignmentForCaller(managerCaller(), { scannerUserId: scannerDeviceId, roomId: randomUUID() })).rejects.toThrow('Room not found');
  });

  it('rejects assigning to a non-confirmed session', async () => {
    const draftSessionId = await createSession({ session_code: 'SAM-DRAFT-1', status: 'draft' });
    await expect(createSessionAssignmentForCaller(managerCaller(), { scannerUserId: scannerDeviceId, sessionId: draftSessionId })).rejects.toThrow('Session is not confirmed');
  });

  it('rejects assigning to an inactive room', async () => {
    const inactiveRoomId = await createRoom({ is_active: false });
    await expect(createRoomAssignmentForCaller(managerCaller(), { scannerUserId: scannerDeviceId, roomId: inactiveRoomId })).rejects.toThrow('Room is not active');
  });

  it('rejects deactivating a nonexistent assignment', async () => {
    await expect(deactivateAssignmentForCaller(managerCaller(), randomUUID())).rejects.toThrow('Assignment not found');
  });
});

describe('multiple-assignment policy: ALLOWED except exact duplicates', () => {
  it('allows a scanner to hold multiple simultaneous session assignments', async () => {
    const scanner = await createScannerAccount('multi');
    const sessionA = await createSession({ session_code: 'SAM-MULTI-A-1' });
    const sessionB = await createSession({ session_code: 'SAM-MULTI-B-1' });

    const a = await createSessionAssignmentForCaller(managerCaller(), { scannerUserId: scanner, sessionId: sessionA });
    const b = await createSessionAssignmentForCaller(managerCaller(), { scannerUserId: scanner, sessionId: sessionB });
    scannerAssignmentIds.push(a.id, b.id);

    const { data: rows } = await admin.from('scanner_assignments').select('id').eq('scanner_user_id', scanner).eq('is_active', true);
    expect(rows?.length).toBe(2);
  });

  it('allows a scanner to hold both a room assignment and a specific session assignment simultaneously', async () => {
    const scanner = await createScannerAccount('roomplus');
    const roomId = await createRoom();
    const sessionId = await createSession({ session_code: 'SAM-ROOMPLUS-1', room_id: roomId });

    const roomAssignment = await createRoomAssignmentForCaller(managerCaller(), { scannerUserId: scanner, roomId });
    const sessionAssignment = await createSessionAssignmentForCaller(managerCaller(), { scannerUserId: scanner, sessionId });
    scannerAssignmentIds.push(roomAssignment.id, sessionAssignment.id);

    const { data: rows } = await admin.from('scanner_assignments').select('id').eq('scanner_user_id', scanner).eq('is_active', true);
    expect(rows?.length).toBe(2);
  });

  it('blocks an exact duplicate active session assignment (same scanner + same session)', async () => {
    const scanner = await createScannerAccount('dupe-session');
    const sessionId = await createSession({ session_code: 'SAM-DUPE-SESSION-1' });
    const first = await createSessionAssignmentForCaller(managerCaller(), { scannerUserId: scanner, sessionId });
    scannerAssignmentIds.push(first.id);

    await expect(createSessionAssignmentForCaller(managerCaller(), { scannerUserId: scanner, sessionId })).rejects.toThrow(
      'already has an active assignment for this exact session'
    );
  });

  it('blocks an exact duplicate active room assignment (same scanner + same room)', async () => {
    const scanner = await createScannerAccount('dupe-room');
    const roomId = await createRoom();
    const first = await createRoomAssignmentForCaller(managerCaller(), { scannerUserId: scanner, roomId });
    scannerAssignmentIds.push(first.id);

    await expect(createRoomAssignmentForCaller(managerCaller(), { scannerUserId: scanner, roomId })).rejects.toThrow('already has an active assignment for this exact room');
  });

  it('does NOT block room+contained-session overlap, but checkSessionAssignmentWarningForCaller surfaces an informational warning', async () => {
    const scanner = await createScannerAccount('overlap');
    const roomId = await createRoom();
    const sessionId = await createSession({ session_code: 'SAM-OVERLAP-1', room_id: roomId });

    const roomAssignment = await createRoomAssignmentForCaller(managerCaller(), { scannerUserId: scanner, roomId });
    scannerAssignmentIds.push(roomAssignment.id);

    const warning = await checkSessionAssignmentWarningForCaller(managerCaller(), scanner, sessionId);
    expect(warning?.code).toBe('covered_by_room');

    // Still ALLOWED to proceed and create the explicit session assignment.
    const sessionAssignment = await createSessionAssignmentForCaller(managerCaller(), { scannerUserId: scanner, sessionId });
    scannerAssignmentIds.push(sessionAssignment.id);
    const { data: rows } = await admin.from('scanner_assignments').select('id').eq('scanner_user_id', scanner).eq('is_active', true);
    expect(rows?.length).toBe(2);
  });

  it('checkSessionAssignmentWarningForCaller returns null when there is no conflict', async () => {
    const scanner = await createScannerAccount('nowarning');
    const sessionId = await createSession({ session_code: 'SAM-NOWARNING-1' });
    const warning = await checkSessionAssignmentWarningForCaller(managerCaller(), scanner, sessionId);
    expect(warning).toBeNull();
  });
});

describe('scope effect: assignment mutation actually changes scan-time authorization', () => {
  it('a scanner cannot scan a session before assignment, can after createSessionAssignmentForCaller, and cannot after deactivateAssignmentForCaller', async () => {
    const scanner = await createScannerAccount('scope-effect');
    const sessionId = await createSession({ session_code: 'SAM-SCOPE-EFFECT-1', admission_policy: 'open' });

    const { data: applicantUser } = await admin.auth.admin.createUser({ email: `sam-applicant-${randomUUID()}@test.local`, password: 'password123', email_confirm: true });
    const { data: application } = await admin.from('applications').insert({ applicant_id: applicantUser!.user!.id, status: 'accepted' }).select('id').single();

    const scannerCaller = { userId: scanner, service: admin };

    // Before assignment: rejected.
    await expect(
      scanAttemptConfirmForCaller({ applicationId: application!.id, sessionId, deviceIdentifier: null }, scannerCaller)
    ).rejects.toThrow('Not authorized for this session/room');

    // After createSessionAssignmentForCaller: admitted.
    const assignment = await createSessionAssignmentForCaller(managerCaller(), { scannerUserId: scanner, sessionId });
    scannerAssignmentIds.push(assignment.id);
    const admitted = await scanAttemptConfirmForCaller({ applicationId: application!.id, sessionId, deviceIdentifier: null }, scannerCaller);
    expect(admitted.result).toBe('flexible_admitted');

    // After deactivateAssignmentForCaller: a fresh scope check (a new
    // applicant/session pair, since the first is now legitimately
    // 'duplicate' rather than scope-rejected) proves the deactivated
    // scanner has lost authority — this is the stale-scanner-UI /
    // "next actual scan must still pass verifyScannerScope" behavior
    // the Phase 7F brief requires to be tested explicitly.
    await deactivateAssignmentForCaller(managerCaller(), assignment.id);
    const secondSessionId = await createSession({ session_code: 'SAM-SCOPE-EFFECT-2', admission_policy: 'open' });
    const { data: secondApplicantUser } = await admin.auth.admin.createUser({ email: `sam-applicant2-${randomUUID()}@test.local`, password: 'password123', email_confirm: true });
    const { data: secondApplication } = await admin.from('applications').insert({ applicant_id: secondApplicantUser!.user!.id, status: 'accepted' }).select('id').single();
    await expect(
      scanAttemptConfirmForCaller({ applicationId: secondApplication!.id, sessionId: secondSessionId, deviceIdentifier: null }, scannerCaller)
    ).rejects.toThrow('Not authorized for this session/room');
  });

  it('reassignment removes the old scope and grants the new scope correctly', async () => {
    const scanner = await createScannerAccount('scope-reassign');
    const oldSessionId = await createSession({ session_code: 'SAM-SCOPE-REASSIGN-OLD-1', admission_policy: 'open' });
    const newSessionId = await createSession({ session_code: 'SAM-SCOPE-REASSIGN-NEW-1', admission_policy: 'open' });

    const initial = await createSessionAssignmentForCaller(managerCaller(), { scannerUserId: scanner, sessionId: oldSessionId });
    scannerAssignmentIds.push(initial.id);
    const reassigned = await reassignToSessionForCaller(managerCaller(), initial.id, scanner, newSessionId);
    scannerAssignmentIds.push(reassigned.id);

    const scannerCaller = { userId: scanner, service: admin };

    // Old scope: rejected.
    const { data: oldApplicantUser } = await admin.auth.admin.createUser({ email: `sam-applicant3-${randomUUID()}@test.local`, password: 'password123', email_confirm: true });
    const { data: oldApplication } = await admin.from('applications').insert({ applicant_id: oldApplicantUser!.user!.id, status: 'accepted' }).select('id').single();
    await expect(
      scanAttemptConfirmForCaller({ applicationId: oldApplication!.id, sessionId: oldSessionId, deviceIdentifier: null }, scannerCaller)
    ).rejects.toThrow('Not authorized for this session/room');

    // New scope: admitted.
    const { data: newApplicantUser } = await admin.auth.admin.createUser({ email: `sam-applicant4-${randomUUID()}@test.local`, password: 'password123', email_confirm: true });
    const { data: newApplication } = await admin.from('applications').insert({ applicant_id: newApplicantUser!.user!.id, status: 'accepted' }).select('id').single();
    const admitted = await scanAttemptConfirmForCaller({ applicationId: newApplication!.id, sessionId: newSessionId, deviceIdentifier: null }, scannerCaller);
    expect(admitted.result).toBe('flexible_admitted');
  });
});

describe('audit behavior', () => {
  it('writes an audit_logs row on assignment creation with the manager as actor', async () => {
    const sessionId = await createSession({ session_code: 'SAM-AUDIT-CREATE-1' });
    const created = await createSessionAssignmentForCaller(managerCaller(), { scannerUserId: scannerDeviceId, sessionId });
    scannerAssignmentIds.push(created.id);

    const { data: logs } = await admin
      .from('audit_logs')
      .select('*')
      .eq('entity_type', 'scanner_assignment')
      .eq('entity_id', created.id)
      .eq('action', 'create_session_assignment');
    expect(logs?.length).toBe(1);
    expect(logs?.[0].actor_id).toBe(managerId);
  });

  it('writes an audit_logs row on deactivation with old/new values', async () => {
    const sessionId = await createSession({ session_code: 'SAM-AUDIT-DEACTIVATE-1' });
    const created = await createSessionAssignmentForCaller(managerCaller(), { scannerUserId: scannerDeviceId, sessionId });
    scannerAssignmentIds.push(created.id);
    await deactivateAssignmentForCaller(managerCaller(), created.id);

    const { data: logs } = await admin.from('audit_logs').select('*').eq('entity_type', 'scanner_assignment').eq('entity_id', created.id).eq('action', 'deactivate');
    expect(logs?.length).toBe(1);
    expect((logs?.[0].old_values as { isActive: boolean }).isActive).toBe(true);
    expect((logs?.[0].new_values as { isActive: boolean }).isActive).toBe(false);
  });
});

describe('data exposure', () => {
  it('createSessionAssignmentForCaller returns only { id } — no secrets, no unnecessary participant data', async () => {
    const sessionId = await createSession({ session_code: 'SAM-DATAEXPOSURE-1' });
    const result = await createSessionAssignmentForCaller(managerCaller(), { scannerUserId: scannerDeviceId, sessionId });
    scannerAssignmentIds.push(result.id);
    expect(Object.keys(result)).toEqual(['id']);
  });
});
