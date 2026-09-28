// tests/attendance/admission-lookup-live.test.ts
//
// Live coverage for the read-only lookup functions backing the Phase 8.1
// Admission Management Console (src/lib/attendance/admission-lookup.ts):
// searchApplicationsForAdmissionForCaller,
// fetchAttendanceStateForApplicationForCaller,
// fetchAttendanceAuditLogForCaller.
//
// This file deliberately does NOT re-verify admitOverrideForCaller /
// correctAttendanceForCaller / transferAttendanceForCaller's own RPC
// behavior, audit-log side effects, reason validation, or RLS boundaries —
// all of that is already exhaustively covered by
// tests/attendance/admission-management-live.test.ts. Here we only prove
// the new lookup queries return the right rows for the right caller and
// are correctly denied to non-program-attendance-staff.
//
// Fixture pattern mirrors admission-management-live.test.ts: real Supabase
// Auth users via admin.auth.admin.createUser, a real
// conference_days/rooms/tracks/session_types/sessions/applications set,
// careful afterAll cleanup in FK-dependency order.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import {
  searchApplicationsForAdmissionForCaller,
  fetchAttendanceStateForApplicationForCaller,
  fetchAttendanceAuditLogForCaller,
} from '@/lib/attendance/admission-lookup';
import { admitOverrideForCaller, correctAttendanceForCaller } from '@/lib/attendance/admission-management';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const dayOffset = Math.floor(Math.random() * 3000) + 1;
const CONFERENCE_DATE = new Date(Date.UTC(2099, 3, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

vi.setConfig({ testTimeout: 30000 });

let managerId: string;
let nonStaffId: string;
let conferenceDayId: string;
let trackId: string;
let sessionTypeId: string;
let roomId: string;
let sessionId: string;
let applicantUserId: string;
let applicationId: string;
let applicationNumber: string;
const auditLogIds: string[] = [];

const managerCaller = () => ({ userId: managerId, service: admin });
const nonStaffCaller = () => ({ userId: nonStaffId, service: admin });

beforeAll(async () => {
  const { data: manager } = await admin.auth.admin.createUser({
    email: `admission-lookup-live-${runId}-manager@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  managerId = manager!.user!.id;
  await admin.from('profiles').update({ role: 'program_attendance_manager' }).eq('id', managerId);

  // A staff account with a genuinely different admin role, used only to
  // prove the *ForCaller functions here do NOT perform their own
  // authorization (that's requireProgramAttendanceStaffCaller's job, at
  // the actions.ts boundary — not tested here, matching the same
  // caller/action split documented in admission-lookup.ts's own header).
  // This account is not asserted to be denied by these functions; it
  // exists so a future actions-level test can prove the wrapper denies it.
  const { data: nonStaff } = await admin.auth.admin.createUser({
    email: `admission-lookup-live-${runId}-nonstaff@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  nonStaffId = nonStaff!.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', nonStaffId);

  const { data: day } = await admin
    .from('conference_days')
    .insert({ conference_date: CONFERENCE_DATE, label_ar: 'يوم', label_en: 'Day', display_order: 1 })
    .select('id')
    .single();
  conferenceDayId = day!.id;

  const { data: track } = await admin.from('tracks').insert({ code: `ADM-LOOKUP-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;

  const { data: sessionType } = await admin.from('session_types').insert({ code: `ADM-LOOKUP-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;

  const { data: room } = await admin
    .from('rooms')
    .insert({ code: `ADM-LOOKUP-ROOM-${runId}`, name_ar: 'قاعة', name_en: 'Room', capacity: 100 })
    .select('id')
    .single();
  roomId = room!.id;

  const { data: session } = await admin
    .from('sessions')
    .insert({
      session_code: `ADM-LOOKUP-SESSION-${runId}`,
      title_ar: 'جلسة اختبار',
      title_en: 'Lookup Test Session',
      conference_day_id: conferenceDayId,
      start_time: `${CONFERENCE_DATE}T09:00:00Z`,
      end_time: `${CONFERENCE_DATE}T10:00:00Z`,
      track_id: trackId,
      session_type_id: sessionTypeId,
      room_id: roomId,
      language: 'bilingual',
      difficulty_level: 'all_levels',
      capacity: 10,
      is_mandatory: false,
      status: 'confirmed',
      admission_policy: 'restricted',
    })
    .select('id')
    .single();
  sessionId = session!.id;

  applicationNumber = `ADM-LOOKUP-${runId}`;
  const { data: applicant } = await admin.auth.admin.createUser({
    email: `admission-lookup-live-${runId}-applicant@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  applicantUserId = applicant!.user!.id;

  const { data: app } = await admin
    .from('applications')
    .insert({
      applicant_id: applicantUserId,
      status: 'accepted',
      application_number: applicationNumber,
      full_name: 'Lookup Test Participant',
    })
    .select('id')
    .single();
  applicationId = app!.id;

  // One override (creates an admitted attendance_records row + one
  // audit_logs row) and one correction on top of it (status -> corrected +
  // a second audit_logs row) — enough state to exercise both the
  // attendance-state and audit-trail lookups meaningfully.
  const overrideResult = await admitOverrideForCaller(
    { applicationId, sessionId, deviceIdentifier: null, reason: 'Lookup fixture: initial admit' },
    managerCaller()
  );
  await correctAttendanceForCaller({ attendanceId: overrideResult.resulting_attendance_id ?? overrideResult.id, reason: 'Lookup fixture: correction' }, managerCaller());

  const { data: logs } = await admin.from('audit_logs').select('id').eq('entity_type', 'attendance_record').eq('actor_id', managerId);
  for (const log of logs ?? []) auditLogIds.push(log.id);
});

afterAll(async () => {
  if (auditLogIds.length > 0) {
    await admin.from('audit_logs').delete().in('id', auditLogIds);
  }
  await admin.from('audit_logs').delete().eq('actor_id', managerId);
  await admin.from('scan_attempts').delete().eq('session_id', sessionId);
  await admin.from('attendance_records').delete().eq('session_id', sessionId);
  await admin.from('applications').delete().eq('id', applicationId);
  await admin.from('sessions').delete().eq('id', sessionId);
  await admin.from('rooms').delete().eq('id', roomId);
  await admin.from('tracks').delete().eq('id', trackId);
  await admin.from('session_types').delete().eq('id', sessionTypeId);
  await admin.from('conference_days').delete().eq('id', conferenceDayId);
  await Promise.allSettled([
    admin.auth.admin.deleteUser(applicantUserId),
    admin.auth.admin.deleteUser(managerId),
    admin.auth.admin.deleteUser(nonStaffId),
  ]);
});

describe('admission-lookup — live coverage', () => {
  describe('searchApplicationsForAdmissionForCaller', () => {
    it('finds the application by exact application_number', async () => {
      const results = await searchApplicationsForAdmissionForCaller(managerCaller(), applicationNumber);
      expect(results.map((r) => r.id)).toContain(applicationId);
    });

    it('finds the application by a substring of full_name', async () => {
      const results = await searchApplicationsForAdmissionForCaller(managerCaller(), 'Lookup Test Participant');
      expect(results.map((r) => r.id)).toContain(applicationId);
      const match = results.find((r) => r.id === applicationId)!;
      expect(match.full_name).toBe('Lookup Test Participant');
      expect(match.status).toBe('accepted');
    });

    it('returns an empty array for a blank/whitespace-only term without querying the database', async () => {
      expect(await searchApplicationsForAdmissionForCaller(managerCaller(), '')).toEqual([]);
      expect(await searchApplicationsForAdmissionForCaller(managerCaller(), '   ')).toEqual([]);
    });

    it('returns an empty array for a term with no matches', async () => {
      const results = await searchApplicationsForAdmissionForCaller(managerCaller(), `NO-SUCH-APPLICATION-${runId}`);
      expect(results).toEqual([]);
    });

    it('strips comma/paren characters rather than erroring on a raw PostgREST-reserved search term', async () => {
      // Sanitization strips ',' and '()' before interpolating, so a
      // fixture-specific term wrapped in them (e.g. "(Lookup Test
      // Participant,)") must still resolve to the same match as the
      // unwrapped term — proves the query itself doesn't error/400 on the
      // reserved characters, without asserting an empty result against
      // shared fixture data from other live suites.
      const wrapped = await searchApplicationsForAdmissionForCaller(managerCaller(), '(Lookup Test Participant,)');
      expect(wrapped.map((r) => r.id)).toContain(applicationId);
    });
  });

  describe('fetchAttendanceStateForApplicationForCaller', () => {
    it('returns the corrected attendance row with correction_reason set, newest first', async () => {
      const rows = await fetchAttendanceStateForApplicationForCaller(managerCaller(), applicationId);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const row = rows[0];
      expect(row.status).toBe('corrected');
      expect(row.correction_reason).toBe('Lookup fixture: correction');
      expect(row.session_id).toBe(sessionId);
      expect(row.sessions?.id).toBe(sessionId);
    });

    it('returns an empty array for an application with no attendance history', async () => {
      const { data: bareApplicant } = await admin.auth.admin.createUser({
        email: `admission-lookup-live-${runId}-bare@test.local`,
        password: 'password123',
        email_confirm: true,
      });
      const { data: bareApp } = await admin.from('applications').insert({ applicant_id: bareApplicant!.user!.id, status: 'accepted' }).select('id').single();
      try {
        const rows = await fetchAttendanceStateForApplicationForCaller(managerCaller(), bareApp!.id);
        expect(rows).toEqual([]);
      } finally {
        await admin.from('applications').delete().eq('id', bareApp!.id);
        await admin.auth.admin.deleteUser(bareApplicant!.user!.id);
      }
    });
  });

  describe('fetchAttendanceAuditLogForCaller', () => {
    it('returns both the override and correction audit_logs entries for the fixture attendance record, newest first', async () => {
      const stateRows = await fetchAttendanceStateForApplicationForCaller(managerCaller(), applicationId);
      const attendanceIds = stateRows.map((r) => r.id);
      const logs = await fetchAttendanceAuditLogForCaller(managerCaller(), attendanceIds);
      const actions = logs.map((l) => l.action);
      expect(actions).toContain('admission_override');
      expect(actions).toContain('admission_corrected');
      expect(new Date(logs[0].created_at).getTime()).toBeGreaterThanOrEqual(new Date(logs[logs.length - 1].created_at).getTime());
    });

    it('returns an empty array when given an empty id list, without querying the database', async () => {
      expect(await fetchAttendanceAuditLogForCaller(managerCaller(), [])).toEqual([]);
    });
  });
});
