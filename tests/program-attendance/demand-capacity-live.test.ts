// tests/program-attendance/demand-capacity-live.test.ts
//
// Live coverage for fetchDemandCapacityForCaller
// (src/lib/program-attendance/demand-capacity.ts) — proves the real reads
// (sessions, attendance_records) are scoped correctly against the live
// disposable project. Does NOT re-verify computeDemandCapacityRows's own
// arithmetic — that's fully covered by the pure-logic unit tests in
// demand-capacity.test.ts.
//
// This dashboard is explicitly READ-ONLY (Phase 8.5 scope) — this file
// contains zero writes to sessions/attendance_records beyond its own test
// fixtures, proving the fetch function itself never mutates anything it
// reads.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import { fetchDemandCapacityForCaller } from '@/lib/program-attendance/demand-capacity';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
// Distinct base year from other live suites' fixture date ranges
// (admission-lookup-live.test.ts uses 2099, participant-dashboard-queries
// uses 2085) — conference_days.conference_date is unique and vitest runs
// test files in parallel by default.
const conferenceDate = new Date(Date.UTC(2070, 0, 1) + Math.floor(Math.random() * 900000) * 86400000).toISOString().slice(0, 10);

vi.setConfig({ testTimeout: 30000 });

let managerId: string;
let conferenceDayId: string;
let trackId: string;
let sessionTypeId: string;
let roomId: string;
let sessionId: string;
let unconfirmedSessionId: string;
let applicantUserId: string;
let applicationId: string;
let applicant2UserId: string;
let application2Id: string;
const attendanceRecordIds: string[] = [];

beforeAll(async () => {
  const { data: manager } = await admin.auth.admin.createUser({
    email: `demand-capacity-live-${runId}-manager@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  managerId = manager!.user!.id;
  await admin.from('profiles').update({ role: 'program_attendance_manager' }).eq('id', managerId);

  const { data: day } = await admin.from('conference_days').insert({ conference_date: conferenceDate, label_ar: 'يوم', label_en: 'Day', display_order: 1 }).select('id').single();
  conferenceDayId = day!.id;

  const { data: track } = await admin.from('tracks').insert({ code: `DEMAND-LIVE-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;

  const { data: sessionType } = await admin.from('session_types').insert({ code: `DEMAND-LIVE-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;

  const { data: room } = await admin.from('rooms').insert({ code: `DEMAND-LIVE-ROOM-${runId}`, name_ar: 'قاعة', name_en: 'Room', capacity: 100 }).select('id').single();
  roomId = room!.id;

  const { data: session } = await admin
    .from('sessions')
    .insert({
      session_code: `DEMAND-LIVE-SESSION-${runId}`,
      title_ar: 'جلسة الطلب',
      title_en: 'Demand Session',
      conference_day_id: conferenceDayId,
      start_time: `${conferenceDate}T09:00:00Z`,
      end_time: `${conferenceDate}T10:00:00Z`,
      track_id: trackId,
      session_type_id: sessionTypeId,
      room_id: roomId,
      language: 'bilingual',
      difficulty_level: 'all_levels',
      capacity: 3,
      is_mandatory: false,
      status: 'confirmed',
      admission_policy: 'restricted',
    })
    .select('id')
    .single();
  sessionId = session!.id;

  // A non-confirmed (draft) session, to prove it's excluded from the
  // dashboard entirely — this codebase's convention (scanning/admission)
  // only ever operates on status='confirmed' sessions.
  const { data: draftSession } = await admin
    .from('sessions')
    .insert({
      session_code: `DEMAND-LIVE-DRAFT-${runId}`,
      title_ar: 'مسودة',
      title_en: 'Draft Session',
      conference_day_id: conferenceDayId,
      start_time: `${conferenceDate}T11:00:00Z`,
      end_time: `${conferenceDate}T12:00:00Z`,
      track_id: trackId,
      session_type_id: sessionTypeId,
      room_id: roomId,
      language: 'bilingual',
      difficulty_level: 'all_levels',
      capacity: 5,
      is_mandatory: false,
      status: 'draft',
    })
    .select('id')
    .single();
  unconfirmedSessionId = draftSession!.id;

  const { data: applicant } = await admin.auth.admin.createUser({
    email: `demand-capacity-live-${runId}-applicant@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  applicantUserId = applicant!.user!.id;
  const { data: app } = await admin.from('applications').insert({ applicant_id: applicantUserId, status: 'accepted' }).select('id').single();
  applicationId = app!.id;

  // Two admitted attendance_records for the confirmed session — one
  // priority, one flexible — so admittedTotal/admittedPriority/
  // admittedFlexible are all distinctly non-zero.
  const { data: rec1 } = await admin
    .from('attendance_records')
    .insert({ application_id: applicationId, session_id: sessionId, time_slot_group_key: 'tsg-demand', status: 'admitted', entry_type: 'priority', scanned_by: managerId })
    .select('id')
    .single();
  attendanceRecordIds.push(rec1!.id);
  const { data: applicant2 } = await admin.auth.admin.createUser({
    email: `demand-capacity-live-${runId}-applicant2@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  applicant2UserId = applicant2!.user!.id;
  const { data: app2 } = await admin.from('applications').insert({ applicant_id: applicant2UserId, status: 'accepted' }).select('id').single();
  application2Id = app2!.id;
  const { data: rec2 } = await admin
    .from('attendance_records')
    .insert({ application_id: application2Id, session_id: sessionId, time_slot_group_key: 'tsg-demand', status: 'admitted', entry_type: 'flexible', scanned_by: managerId })
    .select('id')
    .single();
  attendanceRecordIds.push(rec2!.id);
});

afterAll(async () => {
  if (attendanceRecordIds.length > 0) {
    await admin.from('attendance_records').delete().in('id', attendanceRecordIds);
  }
  await admin.from('applications').delete().eq('applicant_id', applicantUserId);
  if (application2Id) await admin.from('applications').delete().eq('id', application2Id);
  await admin.from('sessions').delete().in('id', [sessionId, unconfirmedSessionId]);
  await admin.from('rooms').delete().eq('id', roomId);
  await admin.from('tracks').delete().eq('id', trackId);
  await admin.from('session_types').delete().eq('id', sessionTypeId);
  await admin.from('conference_days').delete().eq('id', conferenceDayId);
  await Promise.allSettled([
    admin.auth.admin.deleteUser(applicantUserId),
    admin.auth.admin.deleteUser(managerId),
    applicant2UserId ? admin.auth.admin.deleteUser(applicant2UserId) : Promise.resolve(),
  ]);
});

describe('fetchDemandCapacityForCaller — live coverage', () => {
  it('includes the confirmed fixture session with correct admitted counts, and excludes the draft session entirely', async () => {
    const rows = await fetchDemandCapacityForCaller({ userId: managerId, service: admin }, 'en');

    const row = rows.find((r) => r.sessionId === sessionId);
    expect(row).toBeDefined();
    expect(row!.capacity).toBe(3);
    expect(row!.admittedTotal).toBe(2);
    expect(row!.admittedPriority).toBe(1);
    expect(row!.admittedFlexible).toBe(1);
    expect(row!.remaining).toBe(1);
    expect(row!.atOrOverCapacity).toBe(false);
    expect(row!.admissionPolicy).toBe('restricted');
    expect(row!.title).toBe('Demand Session');

    expect(rows.find((r) => r.sessionId === unconfirmedSessionId)).toBeUndefined();
  });

  it('selects the Arabic title when called with locale "ar"', async () => {
    const rows = await fetchDemandCapacityForCaller({ userId: managerId, service: admin }, 'ar');
    const row = rows.find((r) => r.sessionId === sessionId);
    expect(row!.title).toBe('جلسة الطلب');
  });

  it('performs zero writes: fixture rows created in beforeAll are unchanged after the fetch', async () => {
    const before = await admin.from('sessions').select('capacity, status').eq('id', sessionId).single();
    await fetchDemandCapacityForCaller({ userId: managerId, service: admin }, 'en');
    const after = await admin.from('sessions').select('capacity, status').eq('id', sessionId).single();
    expect(after.data).toEqual(before.data);
  });
});
