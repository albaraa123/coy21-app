// tests/dashboard/participant-dashboard-queries-live.test.ts
//
// Live integration coverage for Task 10's participant dashboard query layer
// (src/lib/dashboard/participant-dashboard-queries.ts). Runs against the
// live linked Supabase project, same as every other tests/**/*-live.test.ts.
//
// getMyApplicationStatus and getMySchedulePublicationState take a plain
// { userId, service } caller object and query with explicit
// .eq(applicant_id/userId) scoping — so they can be exercised directly.
//
// getMyClaimState is different, per the task's CORRECTED requirement: it
// MUST delegate to the real, already-built, security-reviewed
// findMyClaimableApplication() (src/app/[locale]/(participant)/(bare)/claim
// /actions.ts) rather than re-deriving an equivalent
// participant_invitations/applications query. findMyClaimableApplication()
// was extended (mirroring its sibling claimApplication's existing
// sessionClient override in the same file) to accept an optional
// sessionClient — because a 'use server' function cannot reach
// next/headers' cookies() outside a real Next.js request, exactly the
// established constraint documented in tests/shell/logout-live.test.ts and
// tests/import/claim-live.test.ts. getMyClaimState requires a REAL
// sessionClient argument and passes it straight through to the REAL
// findMyClaimableApplication — this is genuine end-to-end delegation, not a
// re-implemented lookalike: this test suite supplies a real anon-key
// client signed in as the invited user, exactly as claim/page.tsx does in
// production via the cookie-backed client.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { getMyApplicationStatus, getMyClaimState, getMySchedulePublicationState, getMyAttendanceForApplication } from '@/lib/dashboard/participant-dashboard-queries';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const PASSWORD = 'password123';
const EMAIL_PREFIX = 'participant-dash-live-';
const EMAIL_DOMAIN = 'test.local';

const createdAuthUserIds: string[] = [];
const createdApplicationIds: string[] = [];
const createdAllocationRunIds: string[] = [];
const createdFeatureExtractionRunIds: string[] = [];
const createdSchedulePublicationIds: string[] = [];
const createdAttendanceRecordIds: string[] = [];
const createdSessionIds: string[] = [];
const createdRoomIds: string[] = [];
const createdTrackIds: string[] = [];
const createdSessionTypeIds: string[] = [];
const createdConferenceDayIds: string[] = [];

async function createTestUser(email: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`Failed to create auth user: ${error?.message}`);
  createdAuthUserIds.push(data.user.id);
  return data.user.id;
}

/** A fresh anon-key client, signed in as the given user — the real
 *  sessionClient argument getMyClaimState (via findMyClaimableApplication)
 *  needs, mirroring tests/import/claim-live.test.ts's established
 *  signInAs() helper. */
async function signInAs(email: string) {
  const client = createClient<Database>(URL, ANON_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`Failed to sign in as ${email}: ${error.message}`);
  return client;
}

/** Minimal real session fixture, for getMyAttendanceForApplication's tests
 *  (attendance_records.session_id references sessions(id), not nullable). */
async function createMinimalSession(): Promise<string> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  // Distinct base year (2085 + a wide random offset) from other live suites'
  // fixture date ranges (e.g. admission-lookup-live.test.ts uses a 2099
  // base) — conference_days.conference_date is unique and vitest runs test
  // files in parallel by default, so overlapping ranges across files can
  // collide even with a random offset.
  const conferenceDate = new Date(Date.UTC(2085, 0, 1) + Math.floor(Math.random() * 900000) * 86400000).toISOString().slice(0, 10);
  const { data: day, error: dayError } = await admin
    .from('conference_days')
    .insert({ conference_date: conferenceDate, label_ar: 'يوم', label_en: 'Day', display_order: 1 })
    .select('id')
    .single();
  if (dayError || !day) throw new Error(`Failed to create conference_days fixture: ${dayError?.message}`);
  createdConferenceDayIds.push(day.id);

  const { data: track, error: trackError } = await admin.from('tracks').insert({ code: `${EMAIL_PREFIX}TRACK-${suffix}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  if (trackError || !track) throw new Error(`Failed to create tracks fixture: ${trackError?.message}`);
  createdTrackIds.push(track.id);

  const { data: sessionType, error: sessionTypeError } = await admin.from('session_types').insert({ code: `${EMAIL_PREFIX}TYPE-${suffix}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  if (sessionTypeError || !sessionType) throw new Error(`Failed to create session_types fixture: ${sessionTypeError?.message}`);
  createdSessionTypeIds.push(sessionType.id);

  const { data: room, error: roomError } = await admin.from('rooms').insert({ code: `${EMAIL_PREFIX}ROOM-${suffix}`, name_ar: 'قاعة', name_en: 'Room', capacity: 100 }).select('id').single();
  if (roomError || !room) throw new Error(`Failed to create rooms fixture: ${roomError?.message}`);
  createdRoomIds.push(room.id);

  const { data: session, error: sessionError } = await admin
    .from('sessions')
    .insert({
      session_code: `${EMAIL_PREFIX}SESSION-${suffix}`,
      title_ar: 'جلسة',
      title_en: 'Session',
      conference_day_id: day.id,
      start_time: `${conferenceDate}T09:00:00Z`,
      end_time: `${conferenceDate}T10:00:00Z`,
      track_id: track.id,
      session_type_id: sessionType.id,
      room_id: room.id,
      language: 'bilingual',
      difficulty_level: 'all_levels',
      capacity: 10,
      is_mandatory: false,
      status: 'confirmed',
    })
    .select('id')
    .single();
  if (sessionError || !session) throw new Error(`Failed to create sessions fixture: ${sessionError?.message}`);
  createdSessionIds.push(session.id);
  return session.id;
}

async function sweepByPrefix() {
  let page = 1;
  const perPage = 1000;
  const stragglers: string[] = [];
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) break;
    for (const u of data.users) {
      if (u.email?.toLowerCase().startsWith(EMAIL_PREFIX)) stragglers.push(u.id);
    }
    if (data.users.length < perPage) break;
    page += 1;
  }
  for (const id of stragglers) {
    await admin.from('applications').delete().eq('applicant_id', id);
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}

beforeAll(async () => {
  await sweepByPrefix();
}, 300000);

afterAll(async () => {
  for (const id of createdAttendanceRecordIds) {
    await admin.from('attendance_records').delete().eq('id', id);
  }
  for (const id of createdSchedulePublicationIds) {
    await admin.from('schedule_publications').delete().eq('id', id);
  }
  for (const id of createdAllocationRunIds) {
    await admin.from('allocation_runs').delete().eq('id', id);
  }
  for (const id of createdFeatureExtractionRunIds) {
    await admin.from('feature_extraction_runs').delete().eq('id', id);
  }
  for (const id of createdApplicationIds) {
    await admin.from('participant_invitations').delete().eq('application_id', id);
    await admin.from('applications').delete().eq('id', id);
  }
  for (const id of createdAuthUserIds) {
    await admin.from('applications').delete().eq('applicant_id', id);
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
  for (const id of createdSessionIds) {
    await admin.from('sessions').delete().eq('id', id);
  }
  for (const id of createdTrackIds) {
    await admin.from('tracks').delete().eq('id', id);
  }
  for (const id of createdSessionTypeIds) {
    await admin.from('session_types').delete().eq('id', id);
  }
  for (const id of createdRoomIds) {
    await admin.from('rooms').delete().eq('id', id);
  }
  for (const id of createdConferenceDayIds) {
    await admin.from('conference_days').delete().eq('id', id);
  }
  await sweepByPrefix();
}, 300000);

describe('participant-dashboard-queries — live', () => {
  describe('getMyApplicationStatus', () => {
    it('returns { kind: "empty" } for a participant with no application at all', async () => {
      const userId = await createTestUser(`${EMAIL_PREFIX}noapp-${Date.now()}@${EMAIL_DOMAIN}`);
      const result = await getMyApplicationStatus({ userId, service: admin });
      expect(result).toEqual({ kind: 'empty' });
    }, 60000);

    it("returns real data for the caller's own application (id, status)", async () => {
      const userId = await createTestUser(`${EMAIL_PREFIX}hasapp-${Date.now()}@${EMAIL_DOMAIN}`);
      const { data: app, error } = await admin.from('applications').insert({ applicant_id: userId, status: 'under_review' }).select('id').single();
      expect(error).toBeNull();
      createdApplicationIds.push(app!.id);

      const result = await getMyApplicationStatus({ userId, service: admin });
      expect(result.kind).toBe('data');
      if (result.kind === 'data') {
        expect(result.value.status).toBe('under_review');
        expect(result.value.applicationId).toBe(app!.id);
      }
    }, 60000);
  });

  describe('getMyClaimState', () => {
    it('reports claimed: true when the caller has no pending invitation but already has an applications row (applicant_id = own userId)', async () => {
      const email = `${EMAIL_PREFIX}claimed-${Date.now()}@${EMAIL_DOMAIN}`;
      const userId = await createTestUser(email);
      const { data: app, error } = await admin.from('applications').insert({ applicant_id: userId, status: 'accepted' }).select('id').single();
      expect(error).toBeNull();
      createdApplicationIds.push(app!.id);

      // No participant_invitations row at all for this user -> the real
      // findMyClaimableApplication() returns {} -> getMyClaimState must
      // fall back to the applications lookup and report already-claimed.
      const sessionClient = await signInAs(email);
      const result = await getMyClaimState({ userId, service: admin }, sessionClient);
      expect(result).toEqual({ kind: 'data', value: { claimed: true, applicationId: app!.id } });
    }, 60000);

    it('reports claimed: false when a real, genuine "sent" invitation exists (claimable via the real findMyClaimableApplication)', async () => {
      const email = `${EMAIL_PREFIX}claimable-${Date.now()}@${EMAIL_DOMAIN}`;
      const userId = await createTestUser(email);

      const { data: app, error: appError } = await admin
        .from('applications')
        .insert({ applicant_id: null, imported_email: email, status: 'accepted' })
        .select('id')
        .single();
      expect(appError).toBeNull();
      createdApplicationIds.push(app!.id);

      const { error: invError } = await admin.from('participant_invitations').insert({
        application_id: app!.id,
        imported_email: email,
        invited_user_id: userId,
        status: 'sent',
      });
      expect(invError).toBeNull();

      const sessionClient = await signInAs(email);
      const result = await getMyClaimState({ userId, service: admin }, sessionClient);
      expect(result).toEqual({ kind: 'data', value: { claimed: false, applicationId: app!.id } });
    }, 60000);

    it('reports { kind: "empty" } when there is no invitation and no application at all', async () => {
      const email = `${EMAIL_PREFIX}nothing-${Date.now()}@${EMAIL_DOMAIN}`;
      const userId = await createTestUser(email);
      const sessionClient = await signInAs(email);
      const result = await getMyClaimState({ userId, service: admin }, sessionClient);
      expect(result).toEqual({ kind: 'empty' });
    }, 60000);

    it("propagates a real lookup failure (unauthenticated session) as { kind: 'error' }, never a silently-displayed empty/claimed state", async () => {
      const userId = await createTestUser(`${EMAIL_PREFIX}lookuperror-${Date.now()}@${EMAIL_DOMAIN}`);
      // An unauthenticated (never signed in) anon client: its own
      // auth.getUser() call inside findMyClaimableApplication() returns no
      // user, which that function reports as a real { error } result — a
      // genuine failure path, not a fabricated one.
      const unauthenticatedClient = createClient<Database>(URL, ANON_KEY, { auth: { persistSession: false } });
      const result = await getMyClaimState({ userId, service: admin }, unauthenticatedClient);
      expect(result.kind).toBe('error');
      if (result.kind === 'error') {
        expect(typeof result.message).toBe('string');
        expect(result.message.length).toBeGreaterThan(0);
      }
    }, 60000);

    it('genuinely delegates to the REAL findMyClaimableApplication and correctly distinguishes claimable vs already-claimed-by-me WITHOUT leaking the claimed-by-someone-else/revoked/failed distinction', async () => {
      // inviteeA: a real 'sent' invitation -> claimable.
      const emailA = `${EMAIL_PREFIX}real-claimable-${Date.now()}@${EMAIL_DOMAIN}`;
      const inviteeA = await createTestUser(emailA);
      const { data: appForA, error: appAError } = await admin
        .from('applications')
        .insert({ applicant_id: null, imported_email: emailA, status: 'accepted' })
        .select('id')
        .single();
      expect(appAError).toBeNull();
      createdApplicationIds.push(appForA!.id);
      const { error: invAError } = await admin.from('participant_invitations').insert({
        application_id: appForA!.id,
        imported_email: emailA,
        invited_user_id: inviteeA,
        status: 'sent',
      });
      expect(invAError).toBeNull();

      // inviteeB: their invitation has already moved to 'accepted' (claimed
      // — by definition B claimed it themselves in the real system, so B
      // also owns a real applications row via applicant_id). From
      // findMyClaimableApplication()'s perspective this returns {} (status
      // != 'sent'), the SAME undifferentiated empty result revoked/failed/
      // never-invited would also produce.
      const emailB = `${EMAIL_PREFIX}real-claimedbyme-${Date.now()}@${EMAIL_DOMAIN}`;
      const inviteeB = await createTestUser(emailB);
      const { data: appForB, error: appBError } = await admin
        .from('applications')
        .insert({ applicant_id: inviteeB, status: 'accepted' })
        .select('id')
        .single();
      expect(appBError).toBeNull();
      createdApplicationIds.push(appForB!.id);
      const { error: invBError } = await admin.from('participant_invitations').insert({
        application_id: appForB!.id,
        imported_email: emailB,
        invited_user_id: inviteeB,
        status: 'accepted',
        accepted_at: new Date().toISOString(),
      });
      expect(invBError).toBeNull();

      const sessionClientA = await signInAs(emailA);
      const resultA = await getMyClaimState({ userId: inviteeA, service: admin }, sessionClientA);
      expect(resultA).toEqual({ kind: 'data', value: { claimed: false, applicationId: appForA!.id } });

      const sessionClientB = await signInAs(emailB);
      const resultB = await getMyClaimState({ userId: inviteeB, service: admin }, sessionClientB);
      // inviteeB's real findMyClaimableApplication() call returns {}
      // (status != 'sent'), so getMyClaimState falls back to checking
      // applications.applicant_id = inviteeB's own id — which DOES exist,
      // so it correctly reports claimed: true. The result contains ONLY
      // inviteeB's own applicationId — nothing anywhere in the result
      // reveals the underlying invitation status ('accepted' specifically,
      // vs. revoked/failed/never-invited) — proving the anti-leak property
      // survives getMyClaimState's wrapping.
      expect(resultB).toEqual({ kind: 'data', value: { claimed: true, applicationId: appForB!.id } });
      expect(JSON.stringify(resultB)).not.toMatch(/revoked|failed|accepted_at|someone else|invitation/i);
    }, 60000);
  });

  describe('getMySchedulePublicationState', () => {
    it('returns { kind: "empty" } when the caller has no application at all', async () => {
      const userId = await createTestUser(`${EMAIL_PREFIX}noschedule-${Date.now()}@${EMAIL_DOMAIN}`);
      const result = await getMySchedulePublicationState({ userId, service: admin });
      expect(result).toEqual({ kind: 'empty' });
    }, 60000);

    it("returns real data for the caller's own active schedule_publications row", async () => {
      const userId = await createTestUser(`${EMAIL_PREFIX}schedule-${Date.now()}@${EMAIL_DOMAIN}`);
      const { data: app } = await admin.from('applications').insert({ applicant_id: userId, status: 'accepted' }).select('id').single();
      createdApplicationIds.push(app!.id);

      const { data: featureRun, error: featureRunError } = await admin
        .from('feature_extraction_runs')
        .insert({ rules_version: 1, application_count: 0, run_by: userId })
        .select('id')
        .single();
      expect(featureRunError).toBeNull();
      createdFeatureExtractionRunIds.push(featureRun!.id);

      const { data: run, error: runError } = await admin
        .from('allocation_runs')
        .insert({ feature_extraction_run_id: featureRun!.id, run_by: userId, status: 'confirmed' })
        .select('id')
        .single();
      expect(runError).toBeNull();
      createdAllocationRunIds.push(run!.id);

      const { data: pub, error: pubError } = await admin
        .from('schedule_publications')
        .insert({
          application_id: app!.id,
          allocation_run_id: run!.id,
          revision_number: 1,
          status: 'active',
          source_fingerprint: `${EMAIL_PREFIX}fingerprint-${Date.now()}`,
          published_by: userId,
        })
        .select('id')
        .single();
      expect(pubError).toBeNull();
      createdSchedulePublicationIds.push(pub!.id);

      const result = await getMySchedulePublicationState({ userId, service: admin });
      expect(result.kind).toBe('data');
      if (result.kind === 'data') {
        expect(result.value.status).toBe('active');
        expect(result.value.publicationId).toBe(pub!.id);
      }
    }, 60000);

    it('a claimed application with no active publication yet returns { kind: "empty" }, not an error', async () => {
      const userId = await createTestUser(`${EMAIL_PREFIX}noactivepub-${Date.now()}@${EMAIL_DOMAIN}`);
      const { data: app, error } = await admin.from('applications').insert({ applicant_id: userId, status: 'accepted' }).select('id').single();
      expect(error).toBeNull();
      createdApplicationIds.push(app!.id);

      const result = await getMySchedulePublicationState({ userId, service: admin });
      expect(result).toEqual({ kind: 'empty' });
    }, 60000);
  });

  describe('getMyAttendanceForApplication', () => {
    it('returns { kind: "empty" } when the caller has no application at all', async () => {
      const userId = await createTestUser(`${EMAIL_PREFIX}noapp-attendance-${Date.now()}@${EMAIL_DOMAIN}`);
      const result = await getMyAttendanceForApplication({ userId, service: admin }, '00000000-0000-0000-0000-000000000000');
      expect(result).toEqual({ kind: 'empty' });
    }, 60000);

    it('rejects an applicationId that does not belong to the caller, returning { kind: "empty" } rather than another participant\'s data', async () => {
      const userA = await createTestUser(`${EMAIL_PREFIX}attend-ownerA-${Date.now()}@${EMAIL_DOMAIN}`);
      const userB = await createTestUser(`${EMAIL_PREFIX}attend-ownerB-${Date.now()}@${EMAIL_DOMAIN}`);
      const { data: appB } = await admin.from('applications').insert({ applicant_id: userB, status: 'accepted' }).select('id').single();
      createdApplicationIds.push(appB!.id);

      const result = await getMyAttendanceForApplication({ userId: userA, service: admin }, appB!.id);
      expect(result).toEqual({ kind: 'empty' });
    }, 60000);

    it('returns { kind: "empty" } for the caller\'s own application when it has no attendance_records rows yet', async () => {
      const userId = await createTestUser(`${EMAIL_PREFIX}attend-none-${Date.now()}@${EMAIL_DOMAIN}`);
      const { data: app } = await admin.from('applications').insert({ applicant_id: userId, status: 'accepted' }).select('id').single();
      createdApplicationIds.push(app!.id);

      const result = await getMyAttendanceForApplication({ userId, service: admin }, app!.id);
      expect(result).toEqual({ kind: 'empty' });
    }, 60000);

    it('returns the attendance row keyed by session_id, for a real admitted attendance_records row', async () => {
      const userId = await createTestUser(`${EMAIL_PREFIX}attend-admitted-${Date.now()}@${EMAIL_DOMAIN}`);
      const { data: app } = await admin.from('applications').insert({ applicant_id: userId, status: 'accepted' }).select('id').single();
      createdApplicationIds.push(app!.id);
      const sessionId = await createMinimalSession();

      const { data: record, error } = await admin
        .from('attendance_records')
        .insert({ application_id: app!.id, session_id: sessionId, time_slot_group_key: 'tsg-1', status: 'admitted', entry_type: 'priority', scanned_by: userId })
        .select('id')
        .single();
      expect(error).toBeNull();
      createdAttendanceRecordIds.push(record!.id);

      const result = await getMyAttendanceForApplication({ userId, service: admin }, app!.id);
      expect(result.kind).toBe('data');
      if (result.kind === 'data') {
        expect(result.value[sessionId]).toEqual({ status: 'admitted', entryType: 'priority', admittedAt: expect.any(String) });
      }
    }, 60000);

    it('keeps only the most recent row per session_id when a session has more than one attendance_records row (e.g. after a correction)', async () => {
      const userId = await createTestUser(`${EMAIL_PREFIX}attend-corrected-${Date.now()}@${EMAIL_DOMAIN}`);
      const { data: app } = await admin.from('applications').insert({ applicant_id: userId, status: 'accepted' }).select('id').single();
      createdApplicationIds.push(app!.id);
      const sessionId = await createMinimalSession();

      // Matches the real shape transferAttendanceForCaller leaves behind
      // (src/lib/attendance/admission-management.ts): the old row's status
      // moves to 'transferred_out' (never a second 'admitted' row for the
      // same session — attendance_records_no_duplicate_active is a unique
      // partial index on (application_id, session_id) where status =
      // 'admitted'), and the new row supersedes it.
      const older = new Date(Date.now() - 60000).toISOString();
      const newer = new Date().toISOString();
      const { data: rowOld, error: rowOldError } = await admin
        .from('attendance_records')
        .insert({ application_id: app!.id, session_id: sessionId, time_slot_group_key: 'tsg-1', status: 'transferred_out', entry_type: 'priority', scanned_by: userId, admitted_at: older })
        .select('id')
        .single();
      expect(rowOldError).toBeNull();
      createdAttendanceRecordIds.push(rowOld!.id);
      const { data: rowNew, error: rowNewError } = await admin
        .from('attendance_records')
        .insert({ application_id: app!.id, session_id: sessionId, time_slot_group_key: 'tsg-1', status: 'admitted', entry_type: 'flexible', scanned_by: userId, admitted_at: newer, superseded_attendance_id: rowOld!.id })
        .select('id')
        .single();
      expect(rowNewError).toBeNull();
      createdAttendanceRecordIds.push(rowNew!.id);

      const result = await getMyAttendanceForApplication({ userId, service: admin }, app!.id);
      expect(result.kind).toBe('data');
      if (result.kind === 'data') {
        expect(Object.keys(result.value)).toHaveLength(1);
        expect(result.value[sessionId].entryType).toBe('flexible');
      }
    }, 60000);
  });

  describe('cross-participant isolation (NON-NEGOTIABLE)', () => {
    it("participant A's getMyApplicationStatus result contains ZERO trace of participant B's data, even though B's application exists in the same table", async () => {
      const userA = await createTestUser(`${EMAIL_PREFIX}isoA-${Date.now()}@${EMAIL_DOMAIN}`);
      const userB = await createTestUser(`${EMAIL_PREFIX}isoB-${Date.now()}@${EMAIL_DOMAIN}`);

      const { data: appA } = await admin
        .from('applications')
        .insert({ applicant_id: userA, status: 'submitted', organization: 'Org-A-Secret', field_of_work: 'Field-A-Secret' })
        .select('id')
        .single();
      createdApplicationIds.push(appA!.id);

      const { data: appB } = await admin
        .from('applications')
        .insert({ applicant_id: userB, status: 'rejected', organization: 'Org-B-Secret', field_of_work: 'Field-B-Secret' })
        .select('id')
        .single();
      createdApplicationIds.push(appB!.id);

      const resultA = await getMyApplicationStatus({ userId: userA, service: admin });
      expect(resultA.kind).toBe('data');
      if (resultA.kind === 'data') {
        expect(resultA.value.applicationId).toBe(appA!.id);
        expect(resultA.value.status).toBe('submitted');
      }
      // Prove zero trace of B anywhere in A's serialized result.
      const serializedA = JSON.stringify(resultA);
      expect(serializedA).not.toContain(appB!.id);
      expect(serializedA).not.toContain('rejected');
      expect(serializedA).not.toContain('Org-B-Secret');
      expect(serializedA).not.toContain('Field-B-Secret');

      const resultB = await getMyApplicationStatus({ userId: userB, service: admin });
      expect(resultB.kind).toBe('data');
      if (resultB.kind === 'data') {
        expect(resultB.value.applicationId).toBe(appB!.id);
        expect(resultB.value.status).toBe('rejected');
      }
      const serializedB = JSON.stringify(resultB);
      expect(serializedB).not.toContain(appA!.id);
      expect(serializedB).not.toContain('submitted');
      expect(serializedB).not.toContain('Org-A-Secret');
    }, 60000);

    it("participant A cannot retrieve participant B's claim state or schedule-publication state — every query is scoped to A's own userId/session server-side", async () => {
      const emailA = `${EMAIL_PREFIX}isoclaimA-${Date.now()}@${EMAIL_DOMAIN}`;
      const userA = await createTestUser(emailA);
      const userB = await createTestUser(`${EMAIL_PREFIX}isoclaimB-${Date.now()}@${EMAIL_DOMAIN}`);

      const { data: appB } = await admin.from('applications').insert({ applicant_id: userB, status: 'accepted' }).select('id').single();
      createdApplicationIds.push(appB!.id);

      // A has neither an invitation nor an application. Even though B's
      // application/claim state genuinely exists in the same tables,
      // calling getMyClaimState/getMySchedulePublicationState with A's own
      // userId and A's own real signed-in session must never surface
      // anything about B.
      const sessionClientA = await signInAs(emailA);
      const resultA = await getMyClaimState({ userId: userA, service: admin }, sessionClientA);
      expect(resultA).toEqual({ kind: 'empty' });
      expect(JSON.stringify(resultA)).not.toContain(appB!.id);

      const scheduleResultA = await getMySchedulePublicationState({ userId: userA, service: admin });
      expect(scheduleResultA).toEqual({ kind: 'empty' });
      expect(JSON.stringify(scheduleResultA)).not.toContain(appB!.id);
    }, 60000);

    it("getMyClaimState's claimable-application result is scoped by the SESSION CLIENT's own identity, not by the caller object's userId argument — even if a mismatched userId is supplied, B's real claimable application never leaks into A's result", async () => {
      const emailA = `${EMAIL_PREFIX}isotamperA-${Date.now()}@${EMAIL_DOMAIN}`;
      await createTestUser(emailA);
      const emailB = `${EMAIL_PREFIX}isotamperB-${Date.now()}@${EMAIL_DOMAIN}`;
      const userB = await createTestUser(emailB);

      // B has a real claimable invitation.
      const { data: appB, error: appBError } = await admin
        .from('applications')
        .insert({ applicant_id: null, imported_email: emailB, status: 'accepted' })
        .select('id')
        .single();
      expect(appBError).toBeNull();
      createdApplicationIds.push(appB!.id);
      const { error: invBError } = await admin.from('participant_invitations').insert({
        application_id: appB!.id,
        imported_email: emailB,
        invited_user_id: userB,
        status: 'sent',
      });
      expect(invBError).toBeNull();

      // A calls getMyClaimState with A's OWN signed-in session client, but
      // the caller object's userId is (mis)supplied as B's id (simulating
      // a bug or tampering attempt upstream). findMyClaimableApplication()
      // derives identity ONLY from the session client's own auth.getUser()
      // (never from an argument), so the invitation lookup is genuinely
      // scoped to A (who has no invitation), not B — proving userId alone
      // cannot be used to pivot onto another participant's claimable
      // application via this function.
      const sessionClientA = await signInAs(emailA);
      const tamperedResult = await getMyClaimState({ userId: userB, service: admin }, sessionClientA);
      expect(JSON.stringify(tamperedResult)).not.toContain(appB!.id);
    }, 60000);
  });
});
