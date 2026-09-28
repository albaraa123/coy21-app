// tests/attendance/admission-management-live.test.ts
//
// Live, end-to-end coverage for admitOverrideForCaller/
// correctAttendanceForCaller/transferAttendanceForCaller (Task 15,
// src/lib/attendance/admission-management.ts) against the real, deployed
// correct_attendance_transactional/transfer_attendance_transactional RPCs
// and scan_attempt_transactional's override branch (Task 11), plus the
// audit_logs table and the RLS policies gating attendance_records/
// scan_attempts writes.
//
// Fixture pattern follows tests/attendance/scan-attempt-live.test.ts and
// tests/attendance/scan-attempt-concurrency-live.test.ts exactly: real
// Supabase Auth users via admin.auth.admin.createUser, real
// conference_days/rooms/tracks/session_types/sessions/allocation_runs rows,
// careful afterAll cleanup in FK-dependency order.
//
// The RLS-scoped (non-service-role) participant client below follows
// tests/rls/applications.test.ts's precedent: an anon-key client that signs
// in as a real Auth user via signInWithPassword, rather than inventing a new
// pattern — this is the only reliable way to prove RLS itself (not just
// application-level authorization) rejects a participant write, since the
// service-role client used everywhere else in this file bypasses RLS
// entirely and would make that assertion a false positive.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '@/types/database';
import {
  admitOverrideForCaller,
  correctAttendanceForCaller,
  transferAttendanceForCaller,
} from '@/lib/attendance/admission-management';
import { scanAttemptConfirmForCaller } from '@/lib/attendance/scan-attempt';
import { computeTimeSlotGroupKeyForSession } from '@/lib/attendance/time-slot-lookup';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const dayOffset = Math.floor(Math.random() * 3000) + 1;
const CONFERENCE_DATE = new Date(Date.UTC(2099, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

// Several scenarios below perform many sequential real network round-trips
// against the live Supabase project (Auth Admin user creation, multiple
// table inserts, one or more real RPC calls, several audit_logs reads).
// Vitest's 5s default is too tight for that — raised file-wide, matching
// the convention and rationale documented in
// tests/attendance/scan-attempt-live.test.ts.
vi.setConfig({ testTimeout: 30000 });

let managerId: string;
let scannerId: string;
let staffId: string;
let conferenceDayId: string;
let trackId: string;
let sessionTypeId: string;
let featureRunId: string;
let allocationRunId: string;

const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const sessionIds: string[] = [];
const roomIds: string[] = [];
const scannerAssignmentIds: string[] = [];
const allocationAssignmentIds: string[] = [];
const auditLogIds: string[] = [];
let roomCounter = 0;

async function createRoom(): Promise<string> {
  roomCounter += 1;
  const { data, error } = await admin
    .from('rooms')
    .insert({ code: `ADMIN-LIVE-ROOM-${runId}-${roomCounter}`, name_ar: 'قاعة', name_en: `Room ${roomCounter}`, capacity: 100 })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create room: ${error?.message}`);
  roomIds.push(data.id);
  return data.id;
}

const managerCaller = () => ({ userId: managerId, service: admin });
const scannerCaller = () => ({ userId: scannerId, service: admin });

async function createApplicant(emailLocalPart: string): Promise<{ userId: string; applicationId: string; email: string }> {
  const email = `admin-live-${runId}-${emailLocalPart}@test.local`;
  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email,
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

  return { userId: user.user.id, applicationId: app.id, email };
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
  return data.id;
}

async function auditLogsFor(entityId: string, action?: string) {
  let query = admin.from('audit_logs').select('*').eq('entity_id', entityId).eq('entity_type', 'attendance_record');
  if (action) query = query.eq('action', action);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to read audit_logs: ${error.message}`);
  return data ?? [];
}

beforeAll(async () => {
  const { data: manager } = await admin.auth.admin.createUser({
    email: `admin-live-${runId}-manager@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  managerId = manager!.user!.id;
  await admin.from('profiles').update({ role: 'program_attendance_manager' }).eq('id', managerId);

  const { data: scanner } = await admin.auth.admin.createUser({
    email: `admin-live-${runId}-scanner@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  scannerId = scanner!.user!.id;
  await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', scannerId);

  const { data: staff } = await admin.auth.admin.createUser({
    email: `admin-live-${runId}-staff@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  staffId = staff!.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  const { data: day } = await admin
    .from('conference_days')
    // Distinct conference_date from the other two live scan-attempt suites
    // (2026-09-19 / 2026-09-20) — conference_days.conference_date is unique
    // and vitest runs test files in parallel by default.
    .insert({ conference_date: CONFERENCE_DATE, label_ar: 'يوم', label_en: 'Day', display_order: 1 })
    .select('id')
    .single();
  conferenceDayId = day!.id;

  const { data: track } = await admin.from('tracks').insert({ code: `ADMIN-LIVE-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;

  const { data: sessionType } = await admin.from('session_types').insert({ code: `ADMIN-LIVE-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
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
  // audit_logs first (deepest dependent, references attendance_records via
  // entity_id but with no FK constraint — safe to delete any time, done
  // first here purely to mirror "deepest dependents first" ordering).
  if (auditLogIds.length > 0) {
    await admin.from('audit_logs').delete().in('id', auditLogIds);
  }
  // Also sweep any audit_logs rows keyed to attendance_records created by
  // sessions in this file that weren't explicitly tracked (belt and
  // braces — writeAuditLog runs after every admin action in every test).
  await admin.from('audit_logs').delete().eq('actor_id', managerId);

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
  await admin.from('conference_days').delete().eq('id', conferenceDayId);
  if (applicationIds.length > 0) {
    await admin.from('applications').delete().in('id', applicationIds);
  }
  await Promise.allSettled([
    ...applicantUserIds.map((id) => admin.auth.admin.deleteUser(id)),
    admin.auth.admin.deleteUser(managerId),
    admin.auth.admin.deleteUser(scannerId),
    admin.auth.admin.deleteUser(staffId),
  ]);
});

describe('admitOverrideForCaller / correctAttendanceForCaller / transferAttendanceForCaller — live coverage', () => {
  it('admitOverrideForCaller succeeds on a restricted_denied case, producing entry_type=override and one audit_logs row', async () => {
    const sessionId = await createSession({ session_code: `ADMIN-OVERRIDE-1-${runId}`, admission_policy: 'restricted', capacity: 10 });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('override-1');

    // Confirm the baseline: a normal (non-override) scan is denied.
    const denied = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, scannerCaller());
    expect(denied.result).toBe('restricted_denied');
    const { data: recordsBefore } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
    expect(recordsBefore).toHaveLength(0);

    const result = await admitOverrideForCaller(
      { applicationId, sessionId, deviceIdentifier: null, reason: 'VIP manual override' },
      managerCaller()
    );
    expect(result.result).toBe('override_admitted');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId).eq('status', 'admitted');
    expect(records).toHaveLength(1);
    expect(records![0].entry_type).toBe('override');

    const attendanceId = records![0].id;
    auditLogIds.push(...(await auditLogsFor(attendanceId)).map((r) => r.id));
    const logs = await auditLogsFor(attendanceId, 'admission_override');
    expect(logs).toHaveLength(1);
    expect(logs[0].actor_id).toBe(managerId);
    expect((logs[0].metadata as Record<string, unknown>)?.reason).toBe('VIP manual override');
  });

  it('admitOverrideForCaller succeeds on a full session, producing entry_type=override and one audit_logs row', async () => {
    const sessionId = await createSession({ session_code: `ADMIN-OVERRIDE-FULL-1-${runId}`, admission_policy: 'open', capacity: 1 });
    await assignScannerToSession(sessionId);

    // Fill the single seat.
    const { applicationId: fillerApplicationId } = await createApplicant('override-full-filler');
    const fillerResult = await scanAttemptConfirmForCaller({ applicationId: fillerApplicationId, sessionId, deviceIdentifier: null }, scannerCaller());
    expect(fillerResult.result).toBe('flexible_admitted');

    const { applicationId } = await createApplicant('override-full-1');
    const full = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, scannerCaller());
    expect(full.result).toBe('full');

    const result = await admitOverrideForCaller(
      { applicationId, sessionId, deviceIdentifier: null, reason: 'Override at capacity' },
      managerCaller()
    );
    expect(result.result).toBe('override_admitted');

    const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId).eq('status', 'admitted');
    expect(records).toHaveLength(1);
    expect(records![0].entry_type).toBe('override');

    const attendanceId = records![0].id;
    auditLogIds.push(...(await auditLogsFor(attendanceId)).map((r) => r.id));
    const logs = await auditLogsFor(attendanceId, 'admission_override');
    expect(logs).toHaveLength(1);
  });

  it('correctAttendanceForCaller marks an admitted row as corrected, never deletes it, and writes one audit_logs row', async () => {
    const sessionId = await createSession({ session_code: `ADMIN-CORRECT-1-${runId}`, admission_policy: 'open', capacity: 10 });
    await assignScannerToSession(sessionId);
    const { applicationId } = await createApplicant('correct-1');

    const admitted = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, scannerCaller());
    expect(admitted.result).toBe('flexible_admitted');

    const { data: before } = await admin.from('attendance_records').select('id').eq('application_id', applicationId).eq('session_id', sessionId).single();
    const attendanceId = before!.id;

    const result = await correctAttendanceForCaller({ attendanceId, reason: 'Scanned wrong badge, correcting entry' }, managerCaller());
    expect(result.status).toBe('corrected');
    expect(result.correction_reason).toBe('Scanned wrong badge, correcting entry');

    // Row still exists (never deleted) with status='corrected'.
    const { data: after, error } = await admin.from('attendance_records').select('*').eq('id', attendanceId).single();
    expect(error).toBeNull();
    expect(after).not.toBeNull();
    expect(after!.status).toBe('corrected');

    auditLogIds.push(...(await auditLogsFor(attendanceId)).map((r) => r.id));
    const logs = await auditLogsFor(attendanceId, 'admission_corrected');
    expect(logs).toHaveLength(1);
    expect(logs[0].actor_id).toBe(managerId);
    expect((logs[0].old_values as Record<string, unknown>)?.status).toBe('admitted');
    expect((logs[0].new_values as Record<string, unknown>)?.status).toBe('corrected');
  });

  it('transferAttendanceForCaller sets old row transferred_out, creates a new admitted row with superseded_attendance_id, and writes one audit_logs row', async () => {
    const sessionAId = await createSession({ session_code: `ADMIN-TRANSFER-A-${runId}`, admission_policy: 'open', capacity: 10 });
    const sessionBId = await createSession({ session_code: `ADMIN-TRANSFER-B-${runId}`, admission_policy: 'open', capacity: 10 });
    await assignScannerToSession(sessionAId);
    const { applicationId } = await createApplicant('transfer-1');

    const admitted = await scanAttemptConfirmForCaller({ applicationId, sessionId: sessionAId, deviceIdentifier: null }, scannerCaller());
    expect(admitted.result).toBe('flexible_admitted');

    const { data: before } = await admin.from('attendance_records').select('id').eq('application_id', applicationId).eq('session_id', sessionAId).single();
    const oldAttendanceId = before!.id;

    const result = await transferAttendanceForCaller(
      { attendanceId: oldAttendanceId, newSessionId: sessionBId, reason: 'Session A cancelled, moving to B' },
      managerCaller()
    );
    expect(result.session_id).toBe(sessionBId);
    expect(result.status).toBe('admitted');
    expect(result.superseded_attendance_id).toBe(oldAttendanceId);

    const { data: oldRow } = await admin.from('attendance_records').select('*').eq('id', oldAttendanceId).single();
    expect(oldRow!.status).toBe('transferred_out');

    const { data: newRow } = await admin.from('attendance_records').select('*').eq('id', result.id).single();
    expect(newRow!.status).toBe('admitted');
    expect(newRow!.session_id).toBe(sessionBId);
    expect(newRow!.superseded_attendance_id).toBe(oldAttendanceId);

    auditLogIds.push(...(await auditLogsFor(result.id)).map((r) => r.id));
    const logs = await auditLogsFor(result.id, 'admission_transferred');
    expect(logs).toHaveLength(1);
    expect(logs[0].actor_id).toBe(managerId);
    expect((logs[0].metadata as Record<string, unknown>)?.previousAttendanceId).toBe(oldAttendanceId);
  });

  describe('empty/missing reason is rejected at both the TS wrapper and the DB RPC level', () => {
    it('admitOverrideForCaller: TS-level requireReason throws before any RPC call', async () => {
      const sessionId = await createSession({ session_code: `ADMIN-REASON-OVERRIDE-1-${runId}`, admission_policy: 'restricted', capacity: 10 });
      await assignScannerToSession(sessionId);
      const { applicationId } = await createApplicant('reason-override-1');

      await expect(
        admitOverrideForCaller({ applicationId, sessionId, deviceIdentifier: null, reason: '   ' }, managerCaller())
      ).rejects.toThrow('A reason is required');

      // No attendance_records row was created — the TS guard threw before
      // the RPC was ever invoked.
      const { data: records } = await admin.from('attendance_records').select('*').eq('application_id', applicationId).eq('session_id', sessionId);
      expect(records).toHaveLength(0);
    });

    it('correctAttendanceForCaller: TS-level requireReason throws before any RPC call', async () => {
      const sessionId = await createSession({ session_code: `ADMIN-REASON-CORRECT-1-${runId}`, admission_policy: 'open', capacity: 10 });
      await assignScannerToSession(sessionId);
      const { applicationId } = await createApplicant('reason-correct-1');
      const admitted = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, scannerCaller());
      expect(admitted.result).toBe('flexible_admitted');
      const { data: before } = await admin.from('attendance_records').select('id').eq('application_id', applicationId).eq('session_id', sessionId).single();

      await expect(correctAttendanceForCaller({ attendanceId: before!.id, reason: '' }, managerCaller())).rejects.toThrow('A reason is required');

      const { data: after } = await admin.from('attendance_records').select('status').eq('id', before!.id).single();
      expect(after!.status).toBe('admitted');
    });

    it('transferAttendanceForCaller: TS-level requireReason throws before any RPC call', async () => {
      const sessionAId = await createSession({ session_code: `ADMIN-REASON-TRANSFER-A-${runId}`, admission_policy: 'open', capacity: 10 });
      const sessionBId = await createSession({ session_code: `ADMIN-REASON-TRANSFER-B-${runId}`, admission_policy: 'open', capacity: 10 });
      await assignScannerToSession(sessionAId);
      const { applicationId } = await createApplicant('reason-transfer-1');
      const admitted = await scanAttemptConfirmForCaller({ applicationId, sessionId: sessionAId, deviceIdentifier: null }, scannerCaller());
      expect(admitted.result).toBe('flexible_admitted');
      const { data: before } = await admin.from('attendance_records').select('id').eq('application_id', applicationId).eq('session_id', sessionAId).single();

      await expect(
        transferAttendanceForCaller({ attendanceId: before!.id, newSessionId: sessionBId, reason: '\t\n ' }, managerCaller())
      ).rejects.toThrow('A reason is required');

      const { data: after } = await admin.from('attendance_records').select('status').eq('id', before!.id).single();
      expect(after!.status).toBe('admitted');
    });

    it('correct_attendance_transactional RPC: DB-level check raises a Postgres exception on null/empty reason, called directly', async () => {
      const sessionId = await createSession({ session_code: `ADMIN-REASON-DB-CORRECT-1-${runId}`, admission_policy: 'open', capacity: 10 });
      await assignScannerToSession(sessionId);
      const { applicationId } = await createApplicant('reason-db-correct-1');
      const admitted = await scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier: null }, scannerCaller());
      expect(admitted.result).toBe('flexible_admitted');
      const { data: before } = await admin.from('attendance_records').select('id').eq('application_id', applicationId).eq('session_id', sessionId).single();

      // Direct RPC call, bypassing the TS wrapper entirely, with an empty
      // reason — exercises the RPC's own `if p_reason is null or trim(...)
      // = ''` guard (20260804170000_admission_management_functions.sql).
      const { data, error } = await admin.rpc('correct_attendance_transactional', {
        p_attendance_id: before!.id,
        p_corrected_by: managerId,
        p_reason: '',
      });
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/reason is required/i);

      const { data: after } = await admin.from('attendance_records').select('status').eq('id', before!.id).single();
      expect(after!.status).toBe('admitted');
    });

    it('transfer_attendance_transactional RPC: DB-level check raises a Postgres exception on null reason, called directly', async () => {
      const sessionAId = await createSession({ session_code: `ADMIN-REASON-DB-TRANSFER-A-${runId}`, admission_policy: 'open', capacity: 10 });
      const sessionBId = await createSession({ session_code: `ADMIN-REASON-DB-TRANSFER-B-${runId}`, admission_policy: 'open', capacity: 10 });
      await assignScannerToSession(sessionAId);
      const { applicationId } = await createApplicant('reason-db-transfer-1');
      const admitted = await scanAttemptConfirmForCaller({ applicationId, sessionId: sessionAId, deviceIdentifier: null }, scannerCaller());
      expect(admitted.result).toBe('flexible_admitted');
      const { data: before } = await admin.from('attendance_records').select('id').eq('application_id', applicationId).eq('session_id', sessionAId).single();

      const { data, error } = await admin.rpc('transfer_attendance_transactional', {
        p_attendance_id: before!.id,
        p_new_session_id: sessionBId,
        p_new_time_slot_group_key: `k-${sessionBId}`,
        p_transferred_by: managerId,
        p_reason: null as unknown as string,
      });
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/reason is required/i);

      const { data: after } = await admin.from('attendance_records').select('status').eq('id', before!.id).single();
      expect(after!.status).toBe('admitted');
    });
  });

  it('full audit trail: a mixed sequence of successful/failed scans plus one of each admin action produces the exact expected scan_attempts and audit_logs counts', async () => {
    const sessionRestrictedId = await createSession({ session_code: `ADMIN-AUDIT-RESTRICTED-${runId}`, admission_policy: 'restricted', capacity: 10 });
    const sessionOpenAId = await createSession({ session_code: `ADMIN-AUDIT-OPEN-A-${runId}`, admission_policy: 'open', capacity: 10 });
    const sessionOpenBId = await createSession({ session_code: `ADMIN-AUDIT-OPEN-B-${runId}`, admission_policy: 'open', capacity: 10 });
    await assignScannerToSession(sessionRestrictedId);
    await assignScannerToSession(sessionOpenAId);

    // Two successful scans (flexible_admitted on an open session).
    const { applicationId: successApp1 } = await createApplicant('audit-success-1');
    const s1 = await scanAttemptConfirmForCaller({ applicationId: successApp1, sessionId: sessionOpenAId, deviceIdentifier: null }, scannerCaller());
    expect(s1.result).toBe('flexible_admitted');

    const { applicationId: successApp2 } = await createApplicant('audit-success-2');
    const s2 = await scanAttemptConfirmForCaller({ applicationId: successApp2, sessionId: sessionOpenAId, deviceIdentifier: null }, scannerCaller());
    expect(s2.result).toBe('flexible_admitted');

    // Two failed scans (restricted_denied on a restricted session).
    const { applicationId: failApp1 } = await createApplicant('audit-fail-1');
    const f1 = await scanAttemptConfirmForCaller({ applicationId: failApp1, sessionId: sessionRestrictedId, deviceIdentifier: null }, scannerCaller());
    expect(f1.result).toBe('restricted_denied');

    const { applicationId: failApp2 } = await createApplicant('audit-fail-2');
    const f2 = await scanAttemptConfirmForCaller({ applicationId: failApp2, sessionId: sessionRestrictedId, deviceIdentifier: null }, scannerCaller());
    expect(f2.result).toBe('restricted_denied');

    // One override admission (on the second failed applicant's restricted_denied case).
    const overrideResult = await admitOverrideForCaller(
      { applicationId: failApp2, sessionId: sessionRestrictedId, deviceIdentifier: null, reason: 'Manual override for audit trail test' },
      managerCaller()
    );
    expect(overrideResult.result).toBe('override_admitted');
    const { data: overrideRecord } = await admin
      .from('attendance_records')
      .select('id')
      .eq('application_id', failApp2)
      .eq('session_id', sessionRestrictedId)
      .eq('status', 'admitted')
      .single();

    // One correction (on the first successful applicant's admitted row).
    const { data: correctTarget } = await admin.from('attendance_records').select('id').eq('application_id', successApp1).eq('session_id', sessionOpenAId).single();
    const correctResult = await correctAttendanceForCaller({ attendanceId: correctTarget!.id, reason: 'Correction for audit trail test' }, managerCaller());
    expect(correctResult.status).toBe('corrected');

    // One transfer (on the second successful applicant's admitted row, A -> B).
    const { data: transferTarget } = await admin.from('attendance_records').select('id').eq('application_id', successApp2).eq('session_id', sessionOpenAId).single();
    const transferResult = await transferAttendanceForCaller(
      { attendanceId: transferTarget!.id, newSessionId: sessionOpenBId, reason: 'Transfer for audit trail test' },
      managerCaller()
    );
    expect(transferResult.status).toBe('admitted');

    // Expected scan_attempts rows: exactly the 4 scanAttemptConfirmForCaller
    // calls above (2 success + 2 fail). Admin actions (override/correct/
    // transfer) go through their own RPCs, not scan_attempt_transactional,
    // and do not write scan_attempts rows themselves — EXCEPT
    // admitOverrideForCaller, which internally calls scan_attempt_transactional
    // (with p_is_override_caller=true), so it DOES add one more scan_attempts
    // row. Total: 4 (scans) + 1 (override's internal scan_attempt_transactional
    // call) = 5.
    const relevantSessionIds = [sessionRestrictedId, sessionOpenAId, sessionOpenBId];
    const { data: scanAttempts } = await admin.from('scan_attempts').select('*').in('session_id', relevantSessionIds);
    expect(scanAttempts).toHaveLength(5);

    const resultCounts = (scanAttempts ?? []).reduce<Record<string, number>>((acc, row) => {
      acc[row.result] = (acc[row.result] ?? 0) + 1;
      return acc;
    }, {});
    expect(resultCounts.flexible_admitted).toBe(2);
    expect(resultCounts.restricted_denied).toBe(2);
    expect(resultCounts.override_admitted).toBe(1);

    // Expected audit_logs rows: exactly 3 — one each for override, correct,
    // transfer (plain scanAttemptConfirmForCaller never writes audit_logs;
    // only the admission-management actions do).
    const entityIds = [overrideRecord!.id, correctTarget!.id, transferResult.id];
    auditLogIds.push(...entityIds);
    const { data: auditRows } = await admin.from('audit_logs').select('*').in('entity_id', entityIds).eq('actor_id', managerId);
    expect(auditRows).toHaveLength(3);
    const actions = (auditRows ?? []).map((r) => r.action).sort();
    expect(actions).toEqual(['admission_corrected', 'admission_override', 'admission_transferred']);
  });

  describe('no participant write path exists for attendance_records/scan_attempts/schedule_publication_items', () => {
    let participantEmail: string;
    let participantUserId: string;
    let participantApplicationId: string;
    let sessionId: string;
    let schedulePublicationId: string;
    let participantClient: ReturnType<typeof createClient<Database>>;

    beforeAll(async () => {
      sessionId = await createSession({ session_code: `ADMIN-NOPATH-1-${runId}`, admission_policy: 'open', capacity: 10 });
      await assignScannerToSession(sessionId);
      const applicant = await createApplicant('nopath-1');
      participantEmail = applicant.email;
      participantUserId = applicant.userId;
      participantApplicationId = applicant.applicationId;

      // A published-schedule row that genuinely belongs to this
      // participant, so the schedule_publication_items write attempt below
      // targets a row RLS's _select_own policy would actually let them
      // read — the strongest possible test of "no write path" (not just
      // "no row happens to exist here").
      const { data: publication, error: publicationError } = await admin
        .from('schedule_publications')
        .insert({
          application_id: participantApplicationId,
          allocation_run_id: allocationRunId,
          revision_number: 1,
          status: 'active',
          source_fingerprint: 'admin-live-nopath-fingerprint',
          published_by: staffId,
        })
        .select('id')
        .single();
      if (publicationError || !publication) throw new Error(`Failed to create schedule_publications row: ${publicationError?.message}`);
      schedulePublicationId = publication.id;

      // RLS-scoped client: anon key + real sign-in as the participant Auth
      // user, NOT the service-role client used everywhere else in this
      // file. This is the only way to genuinely exercise RLS rather than
      // application-level authorization. Pattern follows
      // tests/rls/applications.test.ts.
      participantClient = createClient<Database>(URL, ANON_KEY);
      const { error: signInError } = await participantClient.auth.signInWithPassword({ email: participantEmail, password: 'password123' });
      if (signInError) throw new Error(`Failed to sign in as participant: ${signInError.message}`);
    });

    afterAll(async () => {
      if (schedulePublicationId) {
        await admin.from('schedule_publication_items').delete().eq('schedule_publication_id', schedulePublicationId);
        await admin.from('schedule_publications').delete().eq('id', schedulePublicationId);
      }
    });

    it('no source file under src/lib/attendance/ performs a write against attendance_records/scan_attempts/schedule_publication_items', () => {
      // Real static check (not a placeholder): scans every .ts file under
      // src/lib/attendance/ for .insert(/.update(/.upsert( calls that
      // reference the three tables the plan calls out as off-limits to
      // participants. The live RLS-rejection assertions below are the
      // authoritative enforcement (RLS holds even if application code
      // changes); this test guards the complementary claim that no
      // application code path exists at all — it will fail loudly if a
      // future change adds one, rather than silently passing forever.
      // Blind spots (acceptable since the live RLS tests below are the real
      // enforcement, this is only a complementary regression guard): a
      // table name referenced via a variable/constant instead of a string
      // literal, or a .from() call more than 3 lines before its write.
      const dir = join(process.cwd(), 'src', 'lib', 'attendance');
      const forbiddenTables = ['attendance_records', 'scan_attempts', 'schedule_publication_items'];
      const writeCallPattern = /\.(insert|update|upsert)\s*\(/;

      const offenders: string[] = [];
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.ts')) continue;
        const content = readFileSync(join(dir, file), 'utf8');
        const lines = content.split('\n');
        lines.forEach((line, i) => {
          if (!writeCallPattern.test(line)) return;
          // A write call on this line only matters if it's chained off a
          // .from('<forbidden table>') within a few preceding lines (the
          // Supabase query-builder pattern used throughout this codebase).
          const context = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
          if (forbiddenTables.some((t) => context.includes(`.from('${t}')`))) {
            offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          }
        });
      }

      expect(offenders).toEqual([]);
    });

    it('rejects a direct participant-role RLS-scoped insert into attendance_records', async () => {
      const { error } = await participantClient.from('attendance_records').insert({
        application_id: participantApplicationId,
        session_id: sessionId,
        time_slot_group_key: `k-${sessionId}`,
        entry_type: 'flexible',
        scanned_by: participantUserId,
      } as Database['public']['Tables']['attendance_records']['Insert']);
      expect(error).not.toBeNull();

      const { count } = await admin
        .from('attendance_records')
        .select('*', { count: 'exact', head: true })
        .eq('application_id', participantApplicationId)
        .eq('session_id', sessionId);
      expect(count).toBe(0);
    });

    it('rejects a direct participant-role RLS-scoped insert into scan_attempts', async () => {
      const { error } = await participantClient.from('scan_attempts').insert({
        application_id: participantApplicationId,
        session_id: sessionId,
        result: 'flexible_admitted',
        scanned_by: managerId,
      } as Database['public']['Tables']['scan_attempts']['Insert']);
      expect(error).not.toBeNull();

      const { count } = await admin
        .from('scan_attempts')
        .select('*', { count: 'exact', head: true })
        .eq('application_id', participantApplicationId)
        .eq('session_id', sessionId);
      expect(count).toBe(0);
    });

    it("rejects a direct participant-role RLS-scoped write to the participant's own schedule_publication_items row", async () => {
      // schedule_publication_items is keyed by schedule_publication_id,
      // which in turn belongs to this participant's own application (see
      // beforeAll above) — schedule_publication_items_select_own would let
      // this exact participant SELECT such a row, so attempting to INSERT
      // one here is the strongest possible test that no write grant exists
      // (not merely that no row happens to be visible to them).
      const { error } = await participantClient.from('schedule_publication_items').insert({
        schedule_publication_id: schedulePublicationId,
        session_id: sessionId,
        is_mandatory: false,
      } as Database['public']['Tables']['schedule_publication_items']['Insert']);
      expect(error).not.toBeNull();

      const { count } = await admin
        .from('schedule_publication_items')
        .select('*', { count: 'exact', head: true })
        .eq('schedule_publication_id', schedulePublicationId);
      expect(count).toBe(0);
    });
  });

  describe('recommended-vs-actual reporting query', () => {
    let controlApplicationId: string;
    let flexibleApplicationId: string;
    let sessionAId: string;
    let sessionBId: string;
    let timeSlotGroupKey: string;

    beforeAll(async () => {
      // Two sessions in the SAME timeslot (identical start/end), so a
      // participant recommended for one but admitted to the other is a
      // genuine flexible-entry, same-timeslot case rather than merely
      // attending an extra, non-conflicting session.
      sessionAId = await createSession({
        session_code: `ADMIN-RECVACT-A-${runId}`,
        admission_policy: 'open',
        capacity: 10,
        start_time: `${CONFERENCE_DATE}T14:00:00Z`,
        end_time: `${CONFERENCE_DATE}T15:00:00Z`,
      });
      sessionBId = await createSession({
        session_code: `ADMIN-RECVACT-B-${runId}`,
        admission_policy: 'open',
        capacity: 10,
        start_time: `${CONFERENCE_DATE}T14:00:00Z`,
        end_time: `${CONFERENCE_DATE}T15:00:00Z`,
      });
      await assignScannerToSession(sessionAId);
      await assignScannerToSession(sessionBId);

      // attendance_records.time_slot_group_key is always the REAL computed
      // key from computeTimeSlotGroupKeyForSession (derived from actual
      // overlapping start/end times on the conference day), never an
      // arbitrary caller-supplied string — scanAttemptConfirmForCaller
      // computes it internally and it is not settable from outside. Sessions
      // A and B share identical start/end times above, so they fall in the
      // same computed group; fetch that real key here so the
      // allocation_assignments seed and the reporting query below both key
      // off the value that will actually land in attendance_records, rather
      // than an arbitrary string that would never match.
      timeSlotGroupKey = await computeTimeSlotGroupKeyForSession(admin, sessionAId);
      expect(await computeTimeSlotGroupKeyForSession(admin, sessionBId)).toBe(timeSlotGroupKey);

      // Control: recommended for A, actually admitted to A.
      const control = await createApplicant('recvact-control');
      controlApplicationId = control.applicationId;
      await makeRecommended(controlApplicationId, sessionAId, timeSlotGroupKey);
      const controlScan = await scanAttemptConfirmForCaller(
        { applicationId: controlApplicationId, sessionId: sessionAId, deviceIdentifier: null },
        scannerCaller()
      );
      expect(controlScan.result).toBe('flexible_admitted');

      // Flexible-entry case: recommended for A, actually admitted to B.
      const flexible = await createApplicant('recvact-flexible');
      flexibleApplicationId = flexible.applicationId;
      await makeRecommended(flexibleApplicationId, sessionAId, timeSlotGroupKey);
      const flexibleScan = await scanAttemptConfirmForCaller(
        { applicationId: flexibleApplicationId, sessionId: sessionBId, deviceIdentifier: null },
        scannerCaller()
      );
      expect(flexibleScan.result).toBe('flexible_admitted');
    });

    it('classifies the flexible-entry case as "attended a different session than recommended" and the control case as matching', async () => {
      // Reporting query: join attendance_records (status='admitted') with
      // allocation_assignments (status in proposed/confirmed) on
      // application_id + time_slot_group_key, then compare the recommended
      // session_id against the actually-admitted session_id.
      const { data: attendanceRows, error: attendanceError } = await admin
        .from('attendance_records')
        .select('application_id, session_id, time_slot_group_key')
        .eq('status', 'admitted')
        .eq('time_slot_group_key', timeSlotGroupKey)
        .in('application_id', [controlApplicationId, flexibleApplicationId]);
      expect(attendanceError).toBeNull();
      expect(attendanceRows).toHaveLength(2);

      const { data: recommendedRows, error: recommendedError } = await admin
        .from('allocation_assignments')
        .select('application_id, session_id, time_slot_group_key')
        .in('status', ['proposed', 'confirmed'])
        .eq('time_slot_group_key', timeSlotGroupKey)
        .in('application_id', [controlApplicationId, flexibleApplicationId]);
      expect(recommendedError).toBeNull();
      expect(recommendedRows).toHaveLength(2);

      const recommendedBySlot = new Map(
        recommendedRows!.map((r) => [`${r.application_id}:${r.time_slot_group_key}`, r.session_id])
      );

      const classification = attendanceRows!.map((row) => {
        const recommendedSessionId = recommendedBySlot.get(`${row.application_id}:${row.time_slot_group_key}`);
        return {
          applicationId: row.application_id,
          actualSessionId: row.session_id,
          recommendedSessionId,
          attendedDifferentSession: recommendedSessionId !== undefined && recommendedSessionId !== row.session_id,
        };
      });

      const controlEntry = classification.find((c) => c.applicationId === controlApplicationId);
      const flexibleEntry = classification.find((c) => c.applicationId === flexibleApplicationId);

      expect(controlEntry).toBeDefined();
      expect(controlEntry!.recommendedSessionId).toBe(sessionAId);
      expect(controlEntry!.actualSessionId).toBe(sessionAId);
      expect(controlEntry!.attendedDifferentSession).toBe(false);

      expect(flexibleEntry).toBeDefined();
      expect(flexibleEntry!.recommendedSessionId).toBe(sessionAId);
      expect(flexibleEntry!.actualSessionId).toBe(sessionBId);
      expect(flexibleEntry!.attendedDifferentSession).toBe(true);
    });
  });
});
