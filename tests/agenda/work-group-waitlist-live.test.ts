// tests/agenda/work-group-waitlist-live.test.ts
//
// Live coverage for join_waitlist()/leave_waitlist() (added in
// 20261005030000_join_and_leave_waitlist_rpcs.sql): participants can only
// join a waitlist for a published/confirmed, enable_waitlist = true,
// actually-full session they don't already hold a booking for; duplicate
// joins and joins without an existing waiting row for leave_waitlist are
// rejected with clear exceptions. FIFO promotion on cancellation (Task 4,
// 20261005040000_cancel_booking_waitlist_promotion.sql) IS covered here,
// in the 'cancel_booking waitlist promotion' describe block below.
//
// Runs against the live scratch Supabase project. Follows the room-overlap
// and auth.uid() gotchas documented in
// tests/agenda/booking-allocation-conflict-live.test.ts and the
// session_notification_outbox-cast/cleanup-order conventions in
// tests/agenda/session-lifecycle-notifications-live.test.ts. Unlike that
// file, session_waitlist and session_notification_outbox are BOTH already
// in the regenerated src/types/database.ts, so no `as never` cast is
// needed here. This file's "does not promote anyone when staff cancel the
// session itself" test DOES directly UPDATE sessions.status (the only
// place in this file that does), so -- same as that other file -- this
// file's afterAll must delete schedule_change_events (written by the
// pre-existing sessions_change_detection trigger with no cascade-delete FK
// back to sessions) before deleting sessions, or the sessions delete fails
// with FK violation 23503 and leaks fixtures on every run.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

// This file's fixture setup (createUser + applications insert per
// applicant, often 2-3 applicants per test) and -- now with Task 4's
// promotion tests added -- its afterAll (which does more deletes than
// before) exceed Vitest's 5000ms test / 10000ms hook defaults under real
// Cloud round-trip latency against the live scratch project. Same fix,
// same established pattern as tests/participants/travel-ops-live.test.ts,
// tests/settings/email-settings-rls-live.test.ts, and
// tests/attendance/scan-attempt-concurrency-live.test.ts.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

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
  await admin.from('session_notification_outbox').delete().in('session_id', sessionIds);
  await admin.from('session_waitlist').delete().in('session_id', sessionIds);
  await admin.from('session_bookings').delete().in('application_id', applicationIds);
  // The 'does not promote anyone when staff cancel the session itself'
  // test directly UPDATEs sessions.status to 'cancelled' (the 4c trigger
  // path), which also fires the pre-existing sessions_change_detection
  // trigger (20260723180000_schedule_change_detection_triggers.sql),
  // inserting rows into schedule_change_events referencing session_id
  // with NO "on delete cascade" (20260723150000_schedule_change_event_tables.sql:4).
  // Without this delete, the sessions delete below fails with FK
  // violation 23503, silently aborting the rest of this cleanup and
  // leaking rooms/tracks/session_types/conference_days/applications/auth
  // users on every run -- same gotcha documented in
  // session-lifecycle-notifications-live.test.ts's afterAll.
  await admin.from('schedule_change_events').delete().in('session_id', sessionIds);
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

  it('rejects a true concurrent duplicate join with the same clean message (unique_violation race, not just the sequential pre-check)', async () => {
    // Regression test for a code-review finding: the pre-check exists()
    // and the insert are two separate statements, so two truly
    // concurrent calls can both pass the pre-check before either commits.
    // The session_waitlist_active_unique partial index (20261005020000)
    // still prevents both from succeeding, but without the
    // unique_violation handler added in 20261005035000, the loser would
    // have surfaced a raw Postgres 23505 error instead of this same
    // clean message. Firing both calls via Promise.allSettled (not
    // sequentially) actually exercises the race rather than the
    // already-covered sequential path above.
    const waitlistTypeId = await seedSessionType('join-race', true);
    const { applicationId: bookerAppId } = await seedAcceptedApplicant('join-race-booker');
    const { applicationId: waiterAppId, client: waiterClient } = await seedAcceptedApplicant('join-race-waiter');
    const sessionId = await seedSession('join-race', { session_type_id: waitlistTypeId, capacity: 1 });
    await directBooking(bookerAppId, sessionId);

    const [first, second] = await Promise.all([
      waiterClient.rpc('join_waitlist', { p_application_id: waiterAppId, p_session_id: sessionId }),
      waiterClient.rpc('join_waitlist', { p_application_id: waiterAppId, p_session_id: sessionId }),
    ]);

    const results = [first, second];
    const succeeded = results.filter((r) => r.error === null);
    const failed = results.filter((r) => r.error !== null);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].error?.message).toContain('You are already on the waitlist for this session');

    const { data: rows } = await admin
      .from('session_waitlist')
      .select('id')
      .eq('application_id', waiterAppId)
      .eq('session_id', sessionId)
      .eq('status', 'waiting');
    expect(rows).toHaveLength(1);
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

describe('cancel_booking waitlist promotion', () => {
  it('promotes in FIFO order when a seat frees up', async () => {
    const waitlistTypeId = await seedSessionType('promo-fifo', true);
    const { applicationId: aAppId, client: aClient } = await seedAcceptedApplicant('promo-fifo-a');
    const { applicationId: bAppId, client: bClient } = await seedAcceptedApplicant('promo-fifo-b');
    const { applicationId: cAppId, client: cClient } = await seedAcceptedApplicant('promo-fifo-c');
    const sessionId = await seedSession('promo-fifo', { session_type_id: waitlistTypeId, capacity: 1 });
    const bookingId = await directBooking(aAppId, sessionId);

    const { data: bWaitlistId, error: bJoinError } = await bClient.rpc('join_waitlist', { p_application_id: bAppId, p_session_id: sessionId });
    expect(bJoinError).toBeNull();
    const { data: cWaitlistId, error: cJoinError } = await cClient.rpc('join_waitlist', { p_application_id: cAppId, p_session_id: sessionId });
    expect(cJoinError).toBeNull();

    const { error: cancelError } = await aClient.rpc('cancel_booking', { p_booking_id: bookingId, p_application_id: aAppId });
    expect(cancelError).toBeNull();

    const { data: bBooking } = await admin
      .from('session_bookings')
      .select('status')
      .eq('application_id', bAppId)
      .eq('session_id', sessionId)
      .eq('status', 'active')
      .maybeSingle();
    expect(bBooking?.status).toBe('active');

    const { data: bWaitlistRow } = await admin.from('session_waitlist').select('status').eq('id', bWaitlistId as string).single();
    expect(bWaitlistRow?.status).toBe('promoted');

    const { data: cWaitlistRow } = await admin.from('session_waitlist').select('status').eq('id', cWaitlistId as string).single();
    expect(cWaitlistRow?.status).toBe('waiting');
  });

  it('skips a candidate with a time conflict and promotes the next eligible one', async () => {
    const waitlistTypeId = await seedSessionType('promo-conflict', true);
    const { applicationId: aAppId, client: aClient } = await seedAcceptedApplicant('promo-conflict-a');
    const { applicationId: bAppId, client: bClient } = await seedAcceptedApplicant('promo-conflict-b');
    const { applicationId: cAppId, client: cClient } = await seedAcceptedApplicant('promo-conflict-c');
    const sessionId = await seedSession('promo-conflict', { session_type_id: waitlistTypeId, capacity: 1 });
    const bookingId = await directBooking(aAppId, sessionId);

    // B has a conflicting active booking elsewhere at the same time as
    // the vacated session (distinct room, per seedSession's room-overlap
    // handling, but the SAME start/end time window).
    const conflictingSessionId = await seedSession('promo-conflict-other', { session_type_id: sessionTypeId, capacity: 10 });
    await directBooking(bAppId, conflictingSessionId);

    const { data: bWaitlistId, error: bJoinError } = await bClient.rpc('join_waitlist', { p_application_id: bAppId, p_session_id: sessionId });
    expect(bJoinError).toBeNull();
    const { data: cWaitlistId, error: cJoinError } = await cClient.rpc('join_waitlist', { p_application_id: cAppId, p_session_id: sessionId });
    expect(cJoinError).toBeNull();

    const { error: cancelError } = await aClient.rpc('cancel_booking', { p_booking_id: bookingId, p_application_id: aAppId });
    expect(cancelError).toBeNull();

    const { data: cBooking } = await admin
      .from('session_bookings')
      .select('status')
      .eq('application_id', cAppId)
      .eq('session_id', sessionId)
      .eq('status', 'active')
      .maybeSingle();
    expect(cBooking?.status).toBe('active');

    const { data: bWaitlistRow } = await admin.from('session_waitlist').select('status').eq('id', bWaitlistId as string).single();
    expect(bWaitlistRow?.status).toBe('waiting');

    const { data: cWaitlistRow } = await admin.from('session_waitlist').select('status').eq('id', cWaitlistId as string).single();
    expect(cWaitlistRow?.status).toBe('promoted');
  });

  it("withdraws the promoted participant's other overlapping waitlist entries", async () => {
    const waitlistTypeId = await seedSessionType('promo-crosswl', true);
    const { applicationId: aAppId, client: aClient } = await seedAcceptedApplicant('promo-crosswl-a');
    const { applicationId: bAppId, client: bClient } = await seedAcceptedApplicant('promo-crosswl-b');

    // session_X: capacity-1, A booked, B waitlisted. session_Y: a
    // second, time-overlapping (same start/end), distinct-room,
    // waitlist-enabled session that B is ALSO waitlisted for.
    const sessionXId = await seedSession('promo-crosswl-x', { session_type_id: waitlistTypeId, capacity: 1 });
    const bookingId = await directBooking(aAppId, sessionXId);
    const sessionYId = await seedSession('promo-crosswl-y', { session_type_id: waitlistTypeId, capacity: 1 });
    const { applicationId: yBookerAppId } = await seedAcceptedApplicant('promo-crosswl-ybooker');
    await directBooking(yBookerAppId, sessionYId);

    const { data: bWaitlistXId, error: bJoinXError } = await bClient.rpc('join_waitlist', { p_application_id: bAppId, p_session_id: sessionXId });
    expect(bJoinXError).toBeNull();
    const { data: bWaitlistYId, error: bJoinYError } = await bClient.rpc('join_waitlist', { p_application_id: bAppId, p_session_id: sessionYId });
    expect(bJoinYError).toBeNull();

    const { error: cancelError } = await aClient.rpc('cancel_booking', { p_booking_id: bookingId, p_application_id: aAppId });
    expect(cancelError).toBeNull();

    const { data: bWaitlistXRow } = await admin.from('session_waitlist').select('status').eq('id', bWaitlistXId as string).single();
    expect(bWaitlistXRow?.status).toBe('promoted');

    const { data: bWaitlistYRow } = await admin.from('session_waitlist').select('status, withdrawn_at').eq('id', bWaitlistYId as string).single();
    expect(bWaitlistYRow?.status).toBe('withdrawn');
    expect(bWaitlistYRow?.withdrawn_at).not.toBeNull();
  });

  it('inserts exactly one waitlist_promoted outbox row on promotion', async () => {
    const waitlistTypeId = await seedSessionType('promo-outbox', true);
    const { applicationId: aAppId, client: aClient } = await seedAcceptedApplicant('promo-outbox-a');
    const { applicationId: bAppId, client: bClient } = await seedAcceptedApplicant('promo-outbox-b');
    const sessionId = await seedSession('promo-outbox', { session_type_id: waitlistTypeId, capacity: 1 });
    const bookingId = await directBooking(aAppId, sessionId);

    const { error: bJoinError } = await bClient.rpc('join_waitlist', { p_application_id: bAppId, p_session_id: sessionId });
    expect(bJoinError).toBeNull();

    const { error: cancelError } = await aClient.rpc('cancel_booking', { p_booking_id: bookingId, p_application_id: aAppId });
    expect(cancelError).toBeNull();

    const { data: newBooking } = await admin
      .from('session_bookings')
      .select('id')
      .eq('application_id', bAppId)
      .eq('session_id', sessionId)
      .eq('status', 'active')
      .single();

    const { data: outboxRows } = await admin
      .from('session_notification_outbox')
      .select('id, booking_id, notification_type')
      .eq('notification_type', 'waitlist_promoted')
      .eq('session_id', sessionId);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows?.[0]?.booking_id).toBe(newBooking!.id);
  });

  it('does not promote anyone when staff cancel the session itself', async () => {
    const waitlistTypeId = await seedSessionType('promo-staffcancel', true);
    const { applicationId: aAppId } = await seedAcceptedApplicant('promo-staffcancel-a');
    const { applicationId: bAppId, client: bClient } = await seedAcceptedApplicant('promo-staffcancel-b');
    const sessionId = await seedSession('promo-staffcancel', { session_type_id: waitlistTypeId, capacity: 1 });
    await directBooking(aAppId, sessionId);

    const { data: bWaitlistId, error: bJoinError } = await bClient.rpc('join_waitlist', { p_application_id: bAppId, p_session_id: sessionId });
    expect(bJoinError).toBeNull();

    // Staff-initiated session cancellation path (4c trigger), NOT
    // cancel_booking -- directly UPDATE sessions.status. cancellation_reason
    // is required by the sessions_enforce_status_transition trigger
    // (20260723020000_sessions_triggers.sql) whenever status = 'cancelled'.
    const { error: staffCancelError } = await admin.from('sessions').update({ status: 'cancelled', cancellation_reason: 'Test: staff cancellation' }).eq('id', sessionId);
    expect(staffCancelError).toBeNull();

    const { data: bWaitlistRow } = await admin.from('session_waitlist').select('status').eq('id', bWaitlistId as string).single();
    expect(bWaitlistRow?.status).toBe('waiting');

    const { data: outboxRows } = await admin
      .from('session_notification_outbox')
      .select('id')
      .eq('notification_type', 'waitlist_promoted')
      .eq('session_id', sessionId);
    expect(outboxRows).toHaveLength(0);
  });

  it('leaves the seat unfilled when every candidate is conflicted', async () => {
    const waitlistTypeId = await seedSessionType('promo-allconflict', true);
    const { applicationId: aAppId, client: aClient } = await seedAcceptedApplicant('promo-allconflict-a');
    const { applicationId: bAppId, client: bClient } = await seedAcceptedApplicant('promo-allconflict-b');
    const { applicationId: cAppId, client: cClient } = await seedAcceptedApplicant('promo-allconflict-c');
    const sessionId = await seedSession('promo-allconflict', { session_type_id: waitlistTypeId, capacity: 1 });
    const bookingId = await directBooking(aAppId, sessionId);

    const conflictingSessionId = await seedSession('promo-allconflict-other', { session_type_id: sessionTypeId, capacity: 10 });
    await directBooking(bAppId, conflictingSessionId);
    await directBooking(cAppId, conflictingSessionId);

    const { data: bWaitlistId, error: bJoinError } = await bClient.rpc('join_waitlist', { p_application_id: bAppId, p_session_id: sessionId });
    expect(bJoinError).toBeNull();
    const { data: cWaitlistId, error: cJoinError } = await cClient.rpc('join_waitlist', { p_application_id: cAppId, p_session_id: sessionId });
    expect(cJoinError).toBeNull();

    const { error: cancelError } = await aClient.rpc('cancel_booking', { p_booking_id: bookingId, p_application_id: aAppId });
    expect(cancelError).toBeNull();

    const { data: activeBookings } = await admin
      .from('session_bookings')
      .select('id')
      .eq('session_id', sessionId)
      .eq('status', 'active');
    expect(activeBookings).toHaveLength(0);

    const { data: bWaitlistRow } = await admin.from('session_waitlist').select('status').eq('id', bWaitlistId as string).single();
    expect(bWaitlistRow?.status).toBe('waiting');

    const { data: cWaitlistRow } = await admin.from('session_waitlist').select('status').eq('id', cWaitlistId as string).single();
    expect(cWaitlistRow?.status).toBe('waiting');
  });
});
