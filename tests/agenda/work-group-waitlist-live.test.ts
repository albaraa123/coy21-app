// tests/agenda/work-group-waitlist-live.test.ts
//
// Live coverage for join_waitlist()/leave_waitlist() (added in
// 20261005030000_join_and_leave_waitlist_rpcs.sql): participants can only
// join a waitlist for a published/confirmed, enable_waitlist = true,
// actually-full session they don't already hold a booking for; duplicate
// joins and joins without an existing waiting row for leave_waitlist are
// rejected with clear exceptions. FIFO promotion on cancellation is Task 4,
// not covered here.
//
// Runs against the live scratch Supabase project. Follows the room-overlap
// and auth.uid() gotchas documented in
// tests/agenda/booking-allocation-conflict-live.test.ts and the
// session_notification_outbox-cast/cleanup-order conventions in
// tests/agenda/session-lifecycle-notifications-live.test.ts. Unlike that
// file, session_waitlist IS already in the regenerated src/types/
// database.ts (from Task 2), so no `as never` cast is needed here. Also
// unlike that file, none of these tests directly UPDATE sessions.status/
// start_time/end_time, so the schedule_change_events-before-sessions
// delete-order cleanup step is not needed in this file's afterAll.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
if (!URL || !SERVICE_KEY || !ANON_KEY) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set to run this live test');
}
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const dayOffset = Math.floor(Math.random() * 3000) + 1;
const DAY = new Date(Date.UTC(2099, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

let conferenceDayId: string;
let trackId: string;
let sessionTypeId: string; // shared non-waitlist type, set up once in beforeAll

const roomIds: string[] = [];
const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const sessionIds: string[] = [];
const sessionTypeIds: string[] = []; // per-test waitlist-enabled types, cleaned up in afterAll

async function seedAcceptedApplicant(emailSlug: string): Promise<{ applicationId: string; client: ReturnType<typeof createClient<Database>> }> {
  const email = `work-group-waitlist-live-${runId}-${emailSlug}@test.local`;
  const { data: user } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  const applicantId = user!.user!.id;
  applicantUserIds.push(applicantId);

  const { data: app } = await admin
    .from('applications')
    .insert({ applicant_id: applicantId, status: 'accepted', preferred_language: 'en', experience_level: 'beginner', interests: [] })
    .select('id')
    .single();
  applicationIds.push(app!.id);

  const client = createClient<Database>(URL, ANON_KEY);
  await client.auth.signInWithPassword({ email, password: 'password123' });

  return { applicationId: app!.id, client };
}

async function seedSessionType(codeSlug: string, enableWaitlist: boolean): Promise<string> {
  const { data } = await admin
    .from('session_types')
    .insert({ code: `WGW-TYPE-${codeSlug}-${runId}`, name_ar: 'نوع', name_en: 'Type', enable_waitlist: enableWaitlist })
    .select('id')
    .single();
  sessionTypeIds.push(data!.id);
  return data!.id as string;
}

async function seedSession(codeSlug: string, overrides: Partial<Database['public']['Tables']['sessions']['Insert']> = {}) {
  const { data: room } = await admin.from('rooms').insert({ code: `WGW-ROOM-${codeSlug}-${runId}`, name_ar: 'قاعة', name_en: 'Room', capacity: 10 }).select('id').single();
  roomIds.push(room!.id);

  const { data } = await admin
    .from('sessions')
    .insert({
      session_code: `WGW-${codeSlug}-${runId}`,
      title_ar: 'جلسة اختبار',
      title_en: 'Test Session',
      conference_day_id: conferenceDayId,
      start_time: `${DAY}T09:00:00+03:00`,
      end_time: `${DAY}T10:00:00+03:00`,
      track_id: trackId,
      session_type_id: sessionTypeId,
      room_id: room!.id,
      language: 'en',
      difficulty_level: 'beginner',
      capacity: 10,
      min_capacity: 0,
      status: 'confirmed',
      ...overrides,
    })
    .select('id')
    .single();
  sessionIds.push(data!.id);
  return data!.id as string;
}

async function directBooking(applicationId: string, sessionId: string) {
  const { data, error } = await admin
    .from('session_bookings')
    .insert({ application_id: applicationId, session_id: sessionId, status: 'active' })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to seed session_bookings: ${error.message}`);
  return data!.id as string;
}

beforeAll(async () => {
  const { data: day } = await admin.from('conference_days').insert({ conference_date: DAY, label_ar: 'يوم اختبار', label_en: 'Test Day', display_order: 1 }).select('id').single();
  conferenceDayId = day!.id;
  const { data: track } = await admin.from('tracks').insert({ code: `WGW-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  sessionTypeId = await seedSessionType('default', false);
});

afterAll(async () => {
  await admin.from('session_waitlist').delete().in('session_id', sessionIds);
  await admin.from('session_bookings').delete().in('application_id', applicationIds);
  // No test in this file directly UPDATEs sessions.status/start_time/
  // end_time, so the schedule_change_events trigger from
  // 20260723180000_schedule_change_detection_triggers.sql never fires and
  // the sessions delete below is not blocked by its FK (see
  // session-lifecycle-notifications-live.test.ts's afterAll for the case
  // where that extra cleanup step IS needed).
  await admin.from('sessions').delete().in('id', sessionIds);
  await admin.from('rooms').delete().in('id', roomIds);
  await admin.from('session_types').delete().in('id', sessionTypeIds);
  await admin.from('session_types').delete().eq('id', sessionTypeId);
  await admin.from('tracks').delete().eq('id', trackId);
  await admin.from('conference_days').delete().eq('id', conferenceDayId);
  await admin.from('applications').delete().in('id', applicationIds);
  for (const id of applicantUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
});

describe('join_waitlist', () => {
  it('succeeds when the session is full and its type has enable_waitlist = true', async () => {
    const waitlistTypeId = await seedSessionType('join-ok', true);
    const { applicationId: bookerAppId } = await seedAcceptedApplicant('join-ok-booker');
    const { applicationId: waiterAppId, client: waiterClient } = await seedAcceptedApplicant('join-ok-waiter');
    const sessionId = await seedSession('join-ok', { session_type_id: waitlistTypeId, capacity: 1 });
    await directBooking(bookerAppId, sessionId);

    const { data, error } = await waiterClient.rpc('join_waitlist', { p_application_id: waiterAppId, p_session_id: sessionId });
    expect(error).toBeNull();
    expect(data).not.toBeNull();

    const { data: row } = await admin.from('session_waitlist').select('status, application_id, session_id').eq('id', data as string).single();
    expect(row?.status).toBe('waiting');
    expect(row?.application_id).toBe(waiterAppId);
    expect(row?.session_id).toBe(sessionId);
  });

  it('rejects when the session is not published/confirmed (e.g. draft)', async () => {
    const waitlistTypeId = await seedSessionType('join-draft', true);
    const { applicationId: bookerAppId } = await seedAcceptedApplicant('join-draft-booker');
    const { applicationId: waiterAppId, client: waiterClient } = await seedAcceptedApplicant('join-draft-waiter');
    // Seed directly as 'draft' via the insert override -- an UPDATE to
    // 'draft' from 'confirmed' would be rejected by the
    // sessions_enforce_status_transition trigger
    // (20260723020000_sessions_triggers.sql), which only allows
    // confirmed -> completed/cancelled. Inserting as draft from the start
    // sidesteps that transition check entirely. directBooking inserts
    // into session_bookings directly (bypassing book_session's own status
    // check), so seeding a "full draft session" this way is possible even
    // though book_session itself would never allow booking a draft session.
    const sessionId = await seedSession('join-draft', { session_type_id: waitlistTypeId, capacity: 1, status: 'draft' });
    await directBooking(bookerAppId, sessionId);

    const { error } = await waiterClient.rpc('join_waitlist', { p_application_id: waiterAppId, p_session_id: sessionId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain('Session is not open for booking');
  });

  it('rejects when the session is not full', async () => {
    const waitlistTypeId = await seedSessionType('join-notfull', true);
    const { applicationId: bookerAppId } = await seedAcceptedApplicant('join-notfull-booker');
    const { applicationId: waiterAppId, client: waiterClient } = await seedAcceptedApplicant('join-notfull-waiter');
    const sessionId = await seedSession('join-notfull', { session_type_id: waitlistTypeId, capacity: 2 });
    await directBooking(bookerAppId, sessionId);

    const { error } = await waiterClient.rpc('join_waitlist', { p_application_id: waiterAppId, p_session_id: sessionId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain('Session is not full -- book it directly instead of joining the waitlist');
  });

  it('rejects when the session type does not have enable_waitlist = true', async () => {
    // sessionTypeId (shared beforeAll type) has enable_waitlist = false.
    const { applicationId: bookerAppId } = await seedAcceptedApplicant('join-notype-booker');
    const { applicationId: waiterAppId, client: waiterClient } = await seedAcceptedApplicant('join-notype-waiter');
    const sessionId = await seedSession('join-notype', { capacity: 1 });
    await directBooking(bookerAppId, sessionId);

    const { error } = await waiterClient.rpc('join_waitlist', { p_application_id: waiterAppId, p_session_id: sessionId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain('This session does not support a waitlist');
  });

  it('rejects a duplicate join', async () => {
    const waitlistTypeId = await seedSessionType('join-dup', true);
    const { applicationId: bookerAppId } = await seedAcceptedApplicant('join-dup-booker');
    const { applicationId: waiterAppId, client: waiterClient } = await seedAcceptedApplicant('join-dup-waiter');
    const sessionId = await seedSession('join-dup', { session_type_id: waitlistTypeId, capacity: 1 });
    await directBooking(bookerAppId, sessionId);

    const { error: firstError } = await waiterClient.rpc('join_waitlist', { p_application_id: waiterAppId, p_session_id: sessionId });
    expect(firstError).toBeNull();

    const { error } = await waiterClient.rpc('join_waitlist', { p_application_id: waiterAppId, p_session_id: sessionId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain('You are already on the waitlist for this session');
  });

  it('rejects when the caller already holds an active booking for the session', async () => {
    const waitlistTypeId = await seedSessionType('join-selfbooked', true);
    const { applicationId: bookerAppId, client: bookerClient } = await seedAcceptedApplicant('join-selfbooked-booker');
    const sessionId = await seedSession('join-selfbooked', { session_type_id: waitlistTypeId, capacity: 1 });
    await directBooking(bookerAppId, sessionId);

    const { error } = await bookerClient.rpc('join_waitlist', { p_application_id: bookerAppId, p_session_id: sessionId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain('You already have a booking for this session');
  });
});

describe('leave_waitlist', () => {
  it('succeeds and marks the row withdrawn', async () => {
    const waitlistTypeId = await seedSessionType('leave-ok', true);
    const { applicationId: bookerAppId } = await seedAcceptedApplicant('leave-ok-booker');
    const { applicationId: waiterAppId, client: waiterClient } = await seedAcceptedApplicant('leave-ok-waiter');
    const sessionId = await seedSession('leave-ok', { session_type_id: waitlistTypeId, capacity: 1 });
    await directBooking(bookerAppId, sessionId);

    const { data: waitlistId, error: joinError } = await waiterClient.rpc('join_waitlist', { p_application_id: waiterAppId, p_session_id: sessionId });
    expect(joinError).toBeNull();

    const { error } = await waiterClient.rpc('leave_waitlist', { p_application_id: waiterAppId, p_session_id: sessionId });
    expect(error).toBeNull();

    const { data: row } = await admin.from('session_waitlist').select('status, withdrawn_at').eq('id', waitlistId as string).single();
    expect(row?.status).toBe('withdrawn');
    expect(row?.withdrawn_at).not.toBeNull();
  });

  it('rejects when the caller has no waiting row for that session', async () => {
    const waitlistTypeId = await seedSessionType('leave-none', true);
    const { applicationId: bookerAppId } = await seedAcceptedApplicant('leave-none-booker');
    const { applicationId: waiterAppId, client: waiterClient } = await seedAcceptedApplicant('leave-none-waiter');
    const sessionId = await seedSession('leave-none', { session_type_id: waitlistTypeId, capacity: 1 });
    await directBooking(bookerAppId, sessionId);

    const { error } = await waiterClient.rpc('leave_waitlist', { p_application_id: waiterAppId, p_session_id: sessionId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain('You are not on the waitlist for this session');
  });
});
