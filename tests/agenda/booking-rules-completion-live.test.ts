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

async function seedAcceptedApplicant(emailSlug: string): Promise<{ applicationId: string; client: ReturnType<typeof createClient<Database>> }> {
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

  return { applicationId: app!.id, client };
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
