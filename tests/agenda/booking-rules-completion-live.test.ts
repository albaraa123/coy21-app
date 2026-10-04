// tests/agenda/booking-rules-completion-live.test.ts
//
// Live coverage for sub-project 4e (booking rules completion). Task 1
// covers the new conference_settings singleton table and the
// consolidated session_effective_deadline() (20261006000000_conference_
// settings_table.sql, 20261006010000_consolidate_session_effective_
// deadline.sql): a platform-wide global_booking_deadline that combines
// with each session's own (booking_deadline, or start_time - 3h as a
// fallback) via least(), enforced identically across book_session,
// join_waitlist, and cancel_booking. This file will accumulate more
// describe blocks across this plan's later tasks (capacity downsize
// guard, no-show detection, walk-in admission).
//
// Runs against the live scratch Supabase project. Follows the
// runId-suffixed-fixture, dedicated-room-per-session, and signed-in
// participant-client conventions documented in
// tests/agenda/work-group-waitlist-live.test.ts (this file's template).
// There's no standalone RPC exposed for session_effective_deadline
// itself -- it takes a `sessions` composite-type row argument, not
// scalar args, so it can't be invoked directly via `.rpc()`. Its
// behavior is observed indirectly through book_session's/join_waitlist's/
// cancel_booking's accept-or-reject behavior, which is the correct and
// only practical way to exercise it from a live-RPC test.
//
// conference_settings is a genuine singleton -- one row shared across the
// WHOLE scratch project, unlike every other fixture in this file (and in
// every sibling live-test file), which is runId-scoped and isolated per
// test run. Setting conference_settings.global_booking_deadline therefore
// has global, cross-file side effects for the duration it's set. Every
// test that sets it resets it back to null immediately after its own
// assertions (belt) AND afterAll resets it to null unconditionally
// (suspenders), so a failed assertion mid-test (which would otherwise
// skip the rest of that test's cleanup) can't leave the scratch project's
// global deadline permanently set for any other test file -- including
// this plan's own later tasks' test runs.
//
// None of this task's tests directly UPDATE sessions.status/start_time/
// end_time, so -- unlike work-group-waitlist-live.test.ts's
// schedule_change_events pre-delete requirement -- no such pre-delete is
// needed here yet. Re-check this comment if a later task added to this
// file does start mutating session scheduling columns directly.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

// Same rationale as work-group-waitlist-live.test.ts: this file's fixture
// setup (createUser + applications insert per applicant) and afterAll
// cleanup exceed Vitest's 5000ms test / 10000ms hook defaults under real
// Cloud round-trip latency against the live scratch project.
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

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

async function seedAcceptedApplicant(emailSlug: string): Promise<{ applicationId: string; applicantId: string; client: ReturnType<typeof createClient<Database>> }> {
  const email = `booking-rules-completion-live-${runId}-${emailSlug}@test.local`;
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

  return { applicationId: app!.id, applicantId, client };
}

async function seedSessionType(codeSlug: string, enableWaitlist: boolean): Promise<string> {
  const { data } = await admin
    .from('session_types')
    .insert({ code: `BRC-TYPE-${codeSlug}-${runId}`, name_ar: 'نوع', name_en: 'Type', enable_waitlist: enableWaitlist })
    .select('id')
    .single();
  sessionTypeIds.push(data!.id);
  return data!.id as string;
}

async function seedSession(codeSlug: string, overrides: Partial<Database['public']['Tables']['sessions']['Insert']> = {}) {
  const { data: room } = await admin.from('rooms').insert({ code: `BRC-ROOM-${codeSlug}-${runId}`, name_ar: 'قاعة', name_en: 'Room', capacity: 10 }).select('id').single();
  roomIds.push(room!.id);

  const { data } = await admin
    .from('sessions')
    .insert({
      session_code: `BRC-${codeSlug}-${runId}`,
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

async function setGlobalDeadline(value: string | null) {
  const { error } = await admin.from('conference_settings').update({ global_booking_deadline: value }).eq('id', true);
  if (error) throw new Error(`Failed to set conference_settings.global_booking_deadline: ${error.message}`);
}

beforeAll(async () => {
  const { data: day } = await admin.from('conference_days').insert({ conference_date: DAY, label_ar: 'يوم اختبار', label_en: 'Test Day', display_order: 1 }).select('id').single();
  conferenceDayId = day!.id;
  const { data: track } = await admin.from('tracks').insert({ code: `BRC-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  sessionTypeId = await seedSessionType('default', false);
});

afterAll(async () => {
  // Singleton table shared across the whole scratch project -- always
  // reset it, regardless of which tests ran or how they ended, so this
  // file never leaves a global deadline set for any other test file
  // (including this same plan's later tasks) that runs afterward.
  await setGlobalDeadline(null);

  await admin.from('session_notification_outbox').delete().in('session_id', sessionIds);
  await admin.from('session_waitlist').delete().in('session_id', sessionIds);
  // attendance_records has no ON DELETE CASCADE from sessions/applications
  // (20260804120000_create_attendance_records_table.sql) -- must be
  // deleted before sessions/applications below, or those deletes fail
  // with a foreign key violation. Only this file's no-show describe block
  // inserts attendance_records rows, but deleting by session_id here is
  // harmless (a no-op) for any run where no rows were inserted.
  await admin.from('attendance_records').delete().in('session_id', sessionIds);
  await admin.from('session_bookings').delete().in('application_id', applicationIds);
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

describe('session_effective_deadline', () => {
  it('returns the global deadline when it is earlier than the per-session deadline', async () => {
    const past = new Date(Date.now() - 60_000).toISOString(); // T1: 1 minute ago
    const future = `${DAY}T08:00:00+03:00`; // T2: well before session start, but still in the future relative to "now" at test-authoring time -- session starts 2099+, so this is far in the future
    await setGlobalDeadline(past);

    try {
      const { applicationId, client } = await seedAcceptedApplicant('global-earlier');
      const sessionId = await seedSession('global-earlier', { booking_deadline: future });

      const { error } = await client.rpc('book_session', { p_application_id: applicationId, p_session_id: sessionId });
      expect(error).not.toBeNull();
      expect(error?.message).toContain('Booking deadline has passed');
    } finally {
      await setGlobalDeadline(null);
    }
  });

  it('returns the per-session deadline when it is earlier than the global deadline', async () => {
    const globalFuture = `${DAY}T23:00:00+03:00`; // global deadline far in the future (session day, late)
    const perSessionPast = new Date(Date.now() - 60_000).toISOString(); // per-session deadline already passed
    await setGlobalDeadline(globalFuture);

    try {
      const { applicationId, client } = await seedAcceptedApplicant('per-session-earlier');
      const sessionId = await seedSession('per-session-earlier', { booking_deadline: perSessionPast });

      const { error } = await client.rpc('book_session', { p_application_id: applicationId, p_session_id: sessionId });
      expect(error).not.toBeNull();
      expect(error?.message).toContain('Booking deadline has passed');
    } finally {
      await setGlobalDeadline(null);
    }
  });

  it('falls back to the per-session effective deadline when global_booking_deadline is NULL', async () => {
    await setGlobalDeadline(null);

    const { applicationId, client } = await seedAcceptedApplicant('global-null-ok');
    // No booking_deadline override -- falls back to start_time - 3h, which
    // is far in the future given DAY is in 2099+, so booking should succeed.
    const sessionId = await seedSession('global-null-ok');

    const { error } = await client.rpc('book_session', { p_application_id: applicationId, p_session_id: sessionId });
    expect(error).toBeNull();

    // Non-regression: a per-session deadline that has already passed is
    // still rejected when the global deadline is NULL (existing 4a/4b
    // behavior, now reached via the new consolidated code path).
    const { applicationId: applicationId2, client: client2 } = await seedAcceptedApplicant('global-null-reject');
    const pastDeadline = new Date(Date.now() - 60_000).toISOString();
    const sessionId2 = await seedSession('global-null-reject', { booking_deadline: pastDeadline });

    const { error: error2 } = await client2.rpc('book_session', { p_application_id: applicationId2, p_session_id: sessionId2 });
    expect(error2).not.toBeNull();
    expect(error2?.message).toContain('Booking deadline has passed');
  });
});

describe('global deadline enforcement across book_session/join_waitlist/cancel_booking', () => {
  it('book_session rejects once the global deadline has passed, even though the per-session deadline has not', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const sessionDeadlineFuture = `${DAY}T08:00:00+03:00`;
    await setGlobalDeadline(past);

    try {
      const { applicationId, client } = await seedAcceptedApplicant('enforce-book');
      const sessionId = await seedSession('enforce-book', { booking_deadline: sessionDeadlineFuture });

      const { error } = await client.rpc('book_session', { p_application_id: applicationId, p_session_id: sessionId });
      expect(error).not.toBeNull();
      expect(error?.message).toContain('Booking deadline has passed');
    } finally {
      await setGlobalDeadline(null);
    }
  });

  it('join_waitlist rejects once the global deadline has passed, even though the per-session deadline has not', async () => {
    const sessionDeadlineFuture = `${DAY}T08:00:00+03:00`;
    const waitlistTypeId = await seedSessionType('enforce-waitlist', true);
    const { applicationId: bookerAppId } = await seedAcceptedApplicant('enforce-waitlist-booker');
    const { applicationId: waiterAppId, client: waiterClient } = await seedAcceptedApplicant('enforce-waitlist-waiter');
    // Fill the session to capacity BEFORE setting the global deadline in
    // the past, since directBooking is a plain admin insert unaffected by
    // the deadline, but we want the session genuinely full first either way.
    const sessionId = await seedSession('enforce-waitlist', { session_type_id: waitlistTypeId, capacity: 1, booking_deadline: sessionDeadlineFuture });
    await directBooking(bookerAppId, sessionId);

    await setGlobalDeadline(new Date(Date.now() - 60_000).toISOString());

    try {
      const { error } = await waiterClient.rpc('join_waitlist', { p_application_id: waiterAppId, p_session_id: sessionId });
      expect(error).not.toBeNull();
      expect(error?.message).toContain('Booking deadline has passed');
    } finally {
      await setGlobalDeadline(null);
    }
  });

  it('cancel_booking rejects once the global deadline has passed, even though the per-session deadline has not', async () => {
    const sessionDeadlineFuture = `${DAY}T08:00:00+03:00`;
    const { applicationId, client } = await seedAcceptedApplicant('enforce-cancel');
    const sessionId = await seedSession('enforce-cancel', { booking_deadline: sessionDeadlineFuture });
    const bookingId = await directBooking(applicationId, sessionId);

    await setGlobalDeadline(new Date(Date.now() - 60_000).toISOString());

    try {
      const { error } = await client.rpc('cancel_booking', { p_booking_id: bookingId, p_application_id: applicationId });
      expect(error).not.toBeNull();
      expect(error?.message).toContain('Cannot cancel after the booking deadline');
    } finally {
      await setGlobalDeadline(null);
    }
  });
});

describe('session capacity downsize guard', () => {
  it('rejects reducing capacity below the current occupied count', async () => {
    const sessionId = await seedSession('downsize-reject', { capacity: 3 });
    const { applicationId: appId1 } = await seedAcceptedApplicant('downsize-reject-1');
    const { applicationId: appId2 } = await seedAcceptedApplicant('downsize-reject-2');
    await directBooking(appId1, sessionId);
    await directBooking(appId2, sessionId);

    const { error } = await admin.from('sessions').update({ capacity: 1 }).eq('id', sessionId);
    expect(error).not.toBeNull();
    expect(error?.message).toContain('Cannot reduce session capacity');
  });

  it('allows reducing capacity to exactly the occupied count', async () => {
    const sessionId = await seedSession('downsize-exact', { capacity: 3 });
    const { applicationId: appId1 } = await seedAcceptedApplicant('downsize-exact-1');
    const { applicationId: appId2 } = await seedAcceptedApplicant('downsize-exact-2');
    await directBooking(appId1, sessionId);
    await directBooking(appId2, sessionId);

    const { error } = await admin.from('sessions').update({ capacity: 2 }).eq('id', sessionId);
    expect(error).toBeNull();
  });

  it('allows reducing capacity when no bookings exist', async () => {
    const sessionId = await seedSession('downsize-empty', { capacity: 5 });

    const { error } = await admin.from('sessions').update({ capacity: 1 }).eq('id', sessionId);
    expect(error).toBeNull();
  });

  it('allows increasing capacity regardless of occupied count', async () => {
    const sessionId = await seedSession('downsize-increase', { capacity: 2 });
    const { applicationId: appId1 } = await seedAcceptedApplicant('downsize-increase-1');
    const { applicationId: appId2 } = await seedAcceptedApplicant('downsize-increase-2');
    await directBooking(appId1, sessionId);
    await directBooking(appId2, sessionId);

    const { error } = await admin.from('sessions').update({ capacity: 5 }).eq('id', sessionId);
    expect(error).toBeNull();
  });
});

describe('no-show detection and seat release', () => {
  // All sessions in this block use a start_time/end_time well in the past
  // (relative to "now" at test-run time) so the 15-minute no-show
  // threshold has already elapsed -- process_session_no_shows has no
  // separate "is it actually past the threshold" parameter, it just
  // compares attendance_records against active session_bookings, so a
  // past start_time isn't even strictly required for the RPC itself, but
  // it keeps these fixtures honest relative to what the real cron route
  // would pick up.
  //
  // enforce_session_day_match() (20261002000000_sessions_day_match_europe_
  // istanbul.sql) requires a session's start/end time (in Europe/Istanbul)
  // to fall on the same calendar date as its conference_day_id's
  // conference_date -- the shared `conferenceDayId` from the outer
  // beforeAll points at `DAY` (2099+), so a past start_time needs its own
  // dedicated conference_days row. conference_days.conference_date has a
  // unique constraint, so (like `DAY` above) this is randomized per test
  // run rather than a fixed literal, to avoid colliding with a leftover
  // row from a previous run that errored before its own afterAll ran.
  const pastDayOffset = Math.floor(Math.random() * 3000) + 1;
  const PAST_DAY = new Date(Date.UTC(2015, 0, 1) + pastDayOffset * 86400000).toISOString().slice(0, 10);
  let pastConferenceDayId: string;

  beforeAll(async () => {
    const { data: day, error } = await admin
      .from('conference_days')
      .insert({ conference_date: PAST_DAY, label_ar: 'يوم ماضٍ', label_en: 'Past Day', display_order: 1 })
      .select('id')
      .single();
    if (error) throw new Error(`Failed to seed past conference_days row: ${error.message}`);
    pastConferenceDayId = day!.id;
  });

  afterAll(async () => {
    await admin.from('conference_days').delete().eq('id', pastConferenceDayId);
  });

  async function seedPastSession(codeSlug: string, overrides: Partial<Database['public']['Tables']['sessions']['Insert']> = {}) {
    return seedSession(codeSlug, {
      conference_day_id: pastConferenceDayId,
      start_time: `${PAST_DAY}T09:00:00+03:00`,
      end_time: `${PAST_DAY}T10:00:00+03:00`,
      ...overrides,
    });
  }

  it('marks an active booking with no admitted attendance record as no_show', async () => {
    const sessionId = await seedPastSession('noshow-basic');
    const { applicationId } = await seedAcceptedApplicant('noshow-basic');
    const bookingId = await directBooking(applicationId, sessionId);

    // `as never` on both the function name and args: process_session_no_shows
    // was added in 20261006040000_no_show_detection_and_promotion_helper.sql
    // and is not yet reflected in the generated src/types/database.ts
    // snapshot -- same established workaround as reclassify.ts's
    // regenerate_application_number RPC call.
    const { error: rpcErr } = await admin.rpc('process_session_no_shows' as never, { p_session_id: sessionId } as never);
    expect(rpcErr).toBeNull();

    const { data: booking } = await admin.from('session_bookings').select('status').eq('id', bookingId).single();
    expect(booking?.status).toBe('no_show');
  });

  it('leaves a booking active when a matching admitted attendance record exists', async () => {
    const sessionId = await seedPastSession('noshow-admitted');
    const { applicationId, applicantId } = await seedAcceptedApplicant('noshow-admitted');
    const bookingId = await directBooking(applicationId, sessionId);

    // scanned_by must reference a profiles row -- use the applicant's own
    // user id, same established pattern as session-alternatives-live.test.ts.
    const { error: attendanceErr } = await admin.from('attendance_records').insert({
      application_id: applicationId,
      session_id: sessionId,
      time_slot_group_key: 'noshow-admitted-tsg',
      status: 'admitted',
      entry_type: 'priority',
      scanned_by: applicantId,
      booking_id: bookingId,
    } as never);
    expect(attendanceErr).toBeNull();

    const { error: rpcErr } = await admin.rpc('process_session_no_shows' as never, { p_session_id: sessionId } as never);
    expect(rpcErr).toBeNull();

    const { data: booking } = await admin.from('session_bookings').select('status').eq('id', bookingId).single();
    expect(booking?.status).toBe('active');
  });

  it('triggers waitlist promotion only when the session type has enable_waitlist = true', async () => {
    const waitlistTypeId = await seedSessionType('noshow-promote', true);
    const sessionId = await seedPastSession('noshow-promote', { session_type_id: waitlistTypeId, capacity: 1 });
    const { applicationId: noShowAppId } = await seedAcceptedApplicant('noshow-promote-absent');
    const { applicationId: waitingAppId } = await seedAcceptedApplicant('noshow-promote-waiting');
    const bookingId = await directBooking(noShowAppId, sessionId);

    const { data: waitlistRow } = await admin
      .from('session_waitlist')
      .insert({ application_id: waitingAppId, session_id: sessionId, status: 'waiting' })
      .select('id')
      .single();

    const { error: rpcErr } = await admin.rpc('process_session_no_shows' as never, { p_session_id: sessionId } as never);
    expect(rpcErr).toBeNull();

    const { data: booking } = await admin.from('session_bookings').select('status').eq('id', bookingId).single();
    expect(booking?.status).toBe('no_show');

    const { data: promotedWaitlist } = await admin.from('session_waitlist').select('status').eq('id', waitlistRow!.id).single();
    expect(promotedWaitlist?.status).toBe('promoted');

    const { data: newBooking } = await admin
      .from('session_bookings')
      .select('id, status')
      .eq('application_id', waitingAppId)
      .eq('session_id', sessionId)
      .eq('status', 'active')
      .maybeSingle();
    expect(newBooking).not.toBeNull();
  });

  it('does not re-evaluate a same-pass promoted booking as a no-show within the same call', async () => {
    // Regression test for the central concurrency claim this feature
    // relies on: process_session_no_shows's outer `for v_booking in
    // <query> loop` snapshots its result set at cursor-open (standard
    // PL/pgSQL cursor semantics), so a booking inserted by
    // promote_next_waitlist_candidate mid-loop -- as a side effect of
    // processing an EARLIER no-show candidate in the SAME pass -- cannot
    // be picked up and immediately re-flagged as a no-show by that same
    // pass. Every other promotion test here uses capacity: 1 with a
    // single no-show candidate, so the loop only ever iterates once and
    // never actually exercises this scenario. This test uses capacity: 2
    // with two simultaneous no-show bookings and one waiting candidate,
    // so the outer loop iterates (at least) twice and the promoted
    // booking is present in the table during the second iteration.
    const waitlistTypeId = await seedSessionType('noshow-samepass', true);
    const sessionId = await seedPastSession('noshow-samepass', { session_type_id: waitlistTypeId, capacity: 2 });
    const { applicationId: noShowAppId1 } = await seedAcceptedApplicant('noshow-samepass-absent-1');
    const { applicationId: noShowAppId2 } = await seedAcceptedApplicant('noshow-samepass-absent-2');
    const { applicationId: waitingAppId } = await seedAcceptedApplicant('noshow-samepass-waiting');
    const bookingId1 = await directBooking(noShowAppId1, sessionId);
    const bookingId2 = await directBooking(noShowAppId2, sessionId);

    await admin.from('session_waitlist').insert({ application_id: waitingAppId, session_id: sessionId, status: 'waiting' });

    const { error: rpcErr } = await admin.rpc('process_session_no_shows' as never, { p_session_id: sessionId } as never);
    expect(rpcErr).toBeNull();

    const { data: booking1 } = await admin.from('session_bookings').select('status').eq('id', bookingId1).single();
    expect(booking1?.status).toBe('no_show');
    const { data: booking2 } = await admin.from('session_bookings').select('status').eq('id', bookingId2).single();
    expect(booking2?.status).toBe('no_show');

    // Exactly one promotion happened (FIFO, single waiting candidate),
    // and the promoted booking must still be 'active' after the pass --
    // not re-picked-up and flipped to 'no_show' by the same call.
    const { data: promotedBookings } = await admin
      .from('session_bookings')
      .select('id, status')
      .eq('application_id', waitingAppId)
      .eq('session_id', sessionId);
    expect(promotedBookings).toHaveLength(1);
    expect(promotedBookings![0].status).toBe('active');

    const { data: outboxRows } = await admin
      .from('session_notification_outbox' as never)
      .select('booking_id')
      .eq('session_id', sessionId)
      .eq('notification_type', 'waitlist_promoted');
    expect(outboxRows).toHaveLength(1);
  });

  it('does not attempt promotion when enable_waitlist is false', async () => {
    // sessionTypeId (the shared default from beforeAll) has enable_waitlist = false
    const sessionId = await seedPastSession('noshow-no-promote', { capacity: 1 });
    const { applicationId: noShowAppId } = await seedAcceptedApplicant('noshow-no-promote-absent');
    const { applicationId: waitingAppId } = await seedAcceptedApplicant('noshow-no-promote-waiting');
    await directBooking(noShowAppId, sessionId);

    const { data: waitlistRow } = await admin
      .from('session_waitlist')
      .insert({ application_id: waitingAppId, session_id: sessionId, status: 'waiting' })
      .select('id')
      .single();

    const { error: rpcErr } = await admin.rpc('process_session_no_shows' as never, { p_session_id: sessionId } as never);
    expect(rpcErr).toBeNull();

    const { data: untouchedWaitlist } = await admin.from('session_waitlist').select('status').eq('id', waitlistRow!.id).single();
    expect(untouchedWaitlist?.status).toBe('waiting');

    const { data: newBooking } = await admin
      .from('session_bookings')
      .select('id')
      .eq('application_id', waitingAppId)
      .eq('session_id', sessionId)
      .maybeSingle();
    expect(newBooking).toBeNull();
  });

  it('is idempotent per-booking: a second call makes no further changes to already-processed bookings, and still evaluates a booking added after the first pass', async () => {
    const sessionId = await seedPastSession('noshow-idempotent', { capacity: 5 });
    const { applicationId: appIdA } = await seedAcceptedApplicant('noshow-idempotent-a');
    const bookingIdA = await directBooking(appIdA, sessionId);

    const { error: rpcErr1 } = await admin.rpc('process_session_no_shows' as never, { p_session_id: sessionId } as never);
    expect(rpcErr1).toBeNull();

    const { data: bookingAAfterFirst } = await admin.from('session_bookings').select('status').eq('id', bookingIdA).single();
    expect(bookingAAfterFirst?.status).toBe('no_show');

    // Seed a NEW active booking B for the same session, added after the
    // first pass already ran.
    const { applicationId: appIdB } = await seedAcceptedApplicant('noshow-idempotent-b');
    const bookingIdB = await directBooking(appIdB, sessionId);

    const { error: rpcErr2 } = await admin.rpc('process_session_no_shows' as never, { p_session_id: sessionId } as never);
    expect(rpcErr2).toBeNull();

    const { data: bookingAAfterSecond } = await admin.from('session_bookings').select('status').eq('id', bookingIdA).single();
    expect(bookingAAfterSecond?.status).toBe('no_show'); // untouched by the second pass

    const { data: bookingBAfterSecond } = await admin.from('session_bookings').select('status').eq('id', bookingIdB).single();
    expect(bookingBAfterSecond?.status).toBe('no_show'); // newly evaluated on the second pass
  });

  it('queues a waitlist_promoted outbox notification identical in shape to a cancel_booking-triggered promotion', async () => {
    const waitlistTypeId = await seedSessionType('noshow-outbox', true);
    const sessionId = await seedPastSession('noshow-outbox', { session_type_id: waitlistTypeId, capacity: 1 });
    const { applicationId: noShowAppId } = await seedAcceptedApplicant('noshow-outbox-absent');
    const { applicationId: waitingAppId } = await seedAcceptedApplicant('noshow-outbox-waiting');
    await directBooking(noShowAppId, sessionId);
    await admin.from('session_waitlist').insert({ application_id: waitingAppId, session_id: sessionId, status: 'waiting' });

    const { error: rpcErr } = await admin.rpc('process_session_no_shows' as never, { p_session_id: sessionId } as never);
    expect(rpcErr).toBeNull();

    const { data: newBooking } = await admin
      .from('session_bookings')
      .select('id')
      .eq('application_id', waitingAppId)
      .eq('session_id', sessionId)
      .eq('status', 'active')
      .single();

    const { data: outboxRows } = await admin
      .from('session_notification_outbox' as never)
      .select('booking_id, notification_type')
      .eq('session_id', sessionId)
      .eq('notification_type', 'waitlist_promoted');

    expect(outboxRows).toHaveLength(1);
    expect((outboxRows as unknown as Array<{ booking_id: string; notification_type: string }>)[0].booking_id).toBe(newBooking!.id);
  });
});

describe('walk-in admission', () => {
  // admit_walk_in's sole authorization gate is is_staff() (current_user_role()
  // in ('staff', 'super_admin') -- 20260929000001_migrate_staff_profiles_
  // and_add_helper.sql), checked inside the function itself rather than via a
  // TypeScript-side pre-check. To call it as a caller is_staff() accepts, we
  // need a real signed-in Auth user whose profiles row has role = 'staff' --
  // same pattern tests/attendance/admission-management-live.test.ts uses for
  // its manager/scanner/staff fixtures (createUser, then update profiles.role,
  // then sign in via a fresh client).
  let staffUserId: string;
  let staffClient: ReturnType<typeof createClient<Database>>;

  beforeAll(async () => {
    const email = `booking-rules-completion-live-${runId}-walkin-staff@test.local`;
    const { data: user } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
    staffUserId = user!.user!.id;
    applicantUserIds.push(staffUserId); // reuse the shared afterAll cleanup loop
    await admin.from('profiles').update({ role: 'staff' }).eq('id', staffUserId);

    staffClient = createClient<Database>(URL, ANON_KEY);
    await staffClient.auth.signInWithPassword({ email, password: 'password123' });
  });

  it('succeeds when a staff caller admits a not-yet-booked, accepted applicant below capacity', async () => {
    const sessionId = await seedSession('walkin-success', { capacity: 2 });
    const { applicationId } = await seedAcceptedApplicant('walkin-success');

    const { data: bookingId, error } = await staffClient.rpc('admit_walk_in', {
      p_application_id: applicationId,
      p_session_id: sessionId,
    });
    expect(error, `RPC error: ${error?.message}`).toBeNull();
    expect(bookingId).toBeTruthy();

    const { data: booking } = await admin
      .from('session_bookings')
      .select('id, source, status')
      .eq('id', bookingId as string)
      .single();
    expect(booking?.source).toBe('walk_in');
    expect(booking?.status).toBe('active');

    const { data: attendance } = await admin
      .from('attendance_records')
      .select('entry_type, status, booking_id')
      .eq('application_id', applicationId)
      .eq('session_id', sessionId)
      .single();
    expect(attendance?.entry_type).toBe('walk_in');
    expect(attendance?.status).toBe('admitted');
    expect(attendance?.booking_id).toBe(bookingId);
  });

  it('rejects a non-staff caller with Not authorized', async () => {
    const sessionId = await seedSession('walkin-nonstaff', { capacity: 2 });
    const { applicationId, client: participantClient } = await seedAcceptedApplicant('walkin-nonstaff');

    const { error } = await participantClient.rpc('admit_walk_in', {
      p_application_id: applicationId,
      p_session_id: sessionId,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain('Not authorized');
  });

  it('rejects when the session is at capacity', async () => {
    const sessionId = await seedSession('walkin-capacity', { capacity: 1 });
    const { applicationId: admittedAppId, applicantId: admittedApplicantId } = await seedAcceptedApplicant('walkin-capacity-admitted');
    await admin.from('attendance_records').insert({
      application_id: admittedAppId,
      session_id: sessionId,
      time_slot_group_key: 'walkin-capacity-tsg',
      status: 'admitted',
      entry_type: 'flexible',
      scanned_by: admittedApplicantId,
    });

    const { applicationId } = await seedAcceptedApplicant('walkin-capacity-new');
    const { error } = await staffClient.rpc('admit_walk_in', {
      p_application_id: applicationId,
      p_session_id: sessionId,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain('Session is at capacity');
  });

  it('rejects when the participant already has an active booking for this session', async () => {
    const sessionId = await seedSession('walkin-already-booked', { capacity: 2 });
    const { applicationId } = await seedAcceptedApplicant('walkin-already-booked');
    await directBooking(applicationId, sessionId);

    const { error } = await staffClient.rpc('admit_walk_in', {
      p_application_id: applicationId,
      p_session_id: sessionId,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain('This participant already has a booking for this session');
  });

  it('rejects when the participant has already been admitted to this session', async () => {
    const sessionId = await seedSession('walkin-already-admitted', { capacity: 2 });
    const { applicationId, applicantId } = await seedAcceptedApplicant('walkin-already-admitted');
    // Simulate a normal QR admission with no prior self-service booking --
    // booking_id left null, same as scan_attempt_transactional would leave
    // it when no matching active session_bookings row exists.
    await admin.from('attendance_records').insert({
      application_id: applicationId,
      session_id: sessionId,
      time_slot_group_key: 'walkin-already-admitted-tsg',
      status: 'admitted',
      entry_type: 'flexible',
      scanned_by: applicantId,
    });

    const { error } = await staffClient.rpc('admit_walk_in', {
      p_application_id: applicationId,
      p_session_id: sessionId,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain('This participant has already been admitted to this session');
  });

  it('rejects when the application is not accepted', async () => {
    const sessionId = await seedSession('walkin-not-accepted', { capacity: 2 });
    const email = `booking-rules-completion-live-${runId}-walkin-not-accepted@test.local`;
    const { data: user } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
    const applicantId = user!.user!.id;
    applicantUserIds.push(applicantId);
    const { data: app } = await admin
      .from('applications')
      .insert({ applicant_id: applicantId, status: 'submitted', preferred_language: 'en', experience_level: 'beginner', interests: [] })
      .select('id')
      .single();
    applicationIds.push(app!.id);

    const { error } = await staffClient.rpc('admit_walk_in', {
      p_application_id: app!.id,
      p_session_id: sessionId,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain('Application not found or not accepted');
  });

  it('rejects when the session is not confirmed', async () => {
    const sessionId = await seedSession('walkin-not-confirmed', { capacity: 2, status: 'draft' });
    const { applicationId } = await seedAcceptedApplicant('walkin-not-confirmed');

    const { error } = await staffClient.rpc('admit_walk_in', {
      p_application_id: applicationId,
      p_session_id: sessionId,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain('Session is not open for admission');
  });

  it('regression: book_session still defaults session_bookings.source to self_service', async () => {
    const sessionId = await seedSession('walkin-regression-self-service');
    const { applicationId, client } = await seedAcceptedApplicant('walkin-regression-self-service');

    const { error } = await client.rpc('book_session', { p_application_id: applicationId, p_session_id: sessionId });
    expect(error).toBeNull();

    const { data: booking } = await admin
      .from('session_bookings')
      .select('source')
      .eq('application_id', applicationId)
      .eq('session_id', sessionId)
      .single();
    expect(booking?.source).toBe('self_service');
  });

  it('cross-system visibility: a walk-in booking counts toward session_effective_occupied_count and is visible via the same query path as a self-service booking', async () => {
    const sessionId = await seedSession('walkin-visibility', { capacity: 3 });
    const { applicationId } = await seedAcceptedApplicant('walkin-visibility');

    const { data: countBefore } = await admin.rpc('session_effective_occupied_count', { p_session_id: sessionId });

    const { data: bookingId, error } = await staffClient.rpc('admit_walk_in', {
      p_application_id: applicationId,
      p_session_id: sessionId,
    });
    expect(error, `RPC error: ${error?.message}`).toBeNull();

    const { data: countAfter } = await admin.rpc('session_effective_occupied_count', { p_session_id: sessionId });
    expect(countAfter).toBe((countBefore ?? 0) + 1);

    // Same query shape /my-agenda's page.tsx uses to list a participant's
    // bookings.
    const { data: visibleBookings } = await admin
      .from('session_bookings')
      .select('id')
      .eq('application_id', applicationId)
      .in('status', ['active']);
    expect(visibleBookings?.map((b) => b.id)).toContain(bookingId);
  });
});

describe('scan_attempt_transactional booking_id linkage', () => {
  it('populates booking_id when a matching active booking exists', async () => {
    const openTypeId = await seedSessionType('scan-linkage-matched', false);
    const sessionId = await seedSession('scan-linkage-matched', { session_type_id: openTypeId, admission_policy: 'open', capacity: 2 });
    const { applicationId, applicantId } = await seedAcceptedApplicant('scan-linkage-matched');
    const bookingId = await directBooking(applicationId, sessionId);

    const { data, error } = await admin.rpc('scan_attempt_transactional', {
      p_application_id: applicationId,
      p_session_id: sessionId,
      p_scanned_by: applicantId,
      p_device_identifier: 'scan-linkage-device',
      p_time_slot_group_key: `scan-linkage-matched-${sessionId}`,
    });
    expect(error, `RPC error: ${error?.message}`).toBeNull();
    expect(data!.result).toBe('flexible_admitted');

    const { data: attendance } = await admin
      .from('attendance_records')
      .select('booking_id')
      .eq('id', data!.resulting_attendance_id as string)
      .single();
    expect(attendance?.booking_id).toBe(bookingId);
  });

  it('leaves booking_id NULL when no matching active booking exists', async () => {
    const openTypeId = await seedSessionType('scan-linkage-unmatched', false);
    const sessionId = await seedSession('scan-linkage-unmatched', { session_type_id: openTypeId, admission_policy: 'open', capacity: 2 });
    const { applicationId, applicantId } = await seedAcceptedApplicant('scan-linkage-unmatched');
    // No prior booking for this applicant/session.

    const { data, error } = await admin.rpc('scan_attempt_transactional', {
      p_application_id: applicationId,
      p_session_id: sessionId,
      p_scanned_by: applicantId,
      p_device_identifier: 'scan-linkage-device',
      p_time_slot_group_key: `scan-linkage-unmatched-${sessionId}`,
    });
    expect(error, `RPC error: ${error?.message}`).toBeNull();
    expect(data!.result).toBe('flexible_admitted');

    const { data: attendance } = await admin
      .from('attendance_records')
      .select('booking_id')
      .eq('id', data!.resulting_attendance_id as string)
      .single();
    expect(attendance?.booking_id).toBeNull();
  });
});
