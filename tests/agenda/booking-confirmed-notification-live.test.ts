// tests/agenda/booking-confirmed-notification-live.test.ts
//
// Sub-project 6, Task 3: live coverage for book_session()'s new
// booking_confirmed notification dual-write (added in
// 20261008040000_wire_booking_confirmed_notification.sql), added
// immediately after the existing session_bookings insert, alongside (not
// replacing) any pre-existing behavior. Verifies exactly one `notifications`
// row is created per successful booking, with the correct application_id,
// channel, link_path, session_id, and locale-correct title (en and ar).
//
// Runs against the live scratch Supabase project. Follows the
// seedAcceptedApplicant/seedSession/room-overlap conventions documented in
// tests/agenda/booking-allocation-conflict-live.test.ts.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

// Live round trips to the real Supabase project routinely exceed Vitest's
// 5000ms default in this codebase -- same established fix as
// tests/attendance/notification-rpcs-live.test.ts and
// tests/agenda/booking-allocation-conflict-live.test.ts's sibling suites.
vi.setConfig({ testTimeout: 30000 });

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
let sessionTypeId: string;

const roomIds: string[] = [];
const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const sessionIds: string[] = [];
const notificationIds: string[] = [];

// book_session()'s own authorization check requires auth.uid() to equal the
// application's applicant_id -- same gotcha documented in
// tests/agenda/booking-allocation-conflict-live.test.ts -- so every
// book_session() call here goes through a real signed-in participant
// client, not `admin`.
async function seedAcceptedApplicant(emailSlug: string, preferredLanguage: 'en' | 'ar' = 'en'): Promise<{ applicationId: string; client: ReturnType<typeof createClient<Database>> }> {
  const email = `booking-confirmed-notif-live-${runId}-${emailSlug}@test.local`;
  const { data: user } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  const applicantId = user!.user!.id;
  applicantUserIds.push(applicantId);

  const { data: app } = await admin
    .from('applications')
    .insert({ applicant_id: applicantId, status: 'accepted', preferred_language: preferredLanguage, experience_level: 'beginner', interests: [] })
    .select('id')
    .single();
  applicationIds.push(app!.id);

  const client = createClient<Database>(URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: 'password123' });
  if (signInError) throw new Error(`Failed to sign in seeded applicant: ${signInError.message}`);

  return { applicationId: app!.id, client };
}

async function seedSession(codeSlug: string, overrides: Partial<Database['public']['Tables']['sessions']['Insert']> = {}) {
  const { data: room, error: roomError } = await admin
    .from('rooms')
    .insert({ code: `BCNL-ROOM-${codeSlug}-${runId}`, name_ar: 'قاعة', name_en: 'Room', capacity: 10 })
    .select('id')
    .single();
  if (roomError) throw new Error(`Failed to seed rooms: ${roomError.message}`);
  roomIds.push(room!.id);

  const { data, error } = await admin
    .from('sessions')
    .insert({
      session_code: `BCNL-${codeSlug}-${runId}`,
      title_ar: 'جلسة تأكيد الحجز',
      title_en: 'Booking Confirmation Session',
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
  if (error) throw new Error(`Failed to seed sessions: ${error.message} (code=${error.code}, details=${error.details}, hint=${error.hint})`);
  sessionIds.push(data!.id);
  return data!.id as string;
}

beforeAll(async () => {
  const { data: day } = await admin.from('conference_days').insert({ conference_date: DAY, label_ar: 'يوم اختبار', label_en: 'Test Day', display_order: 1 }).select('id').single();
  conferenceDayId = day!.id;
  const { data: track } = await admin.from('tracks').insert({ code: `BCNL-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  const { data: sType } = await admin.from('session_types').insert({ code: `BCNL-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sType!.id;
});

afterAll(async () => {
  await admin.from('notifications').delete().in('id', notificationIds);
  await admin.from('session_bookings').delete().in('application_id', applicationIds);
  await admin.from('sessions').delete().in('id', sessionIds);
  await admin.from('rooms').delete().in('id', roomIds);
  await admin.from('session_types').delete().eq('id', sessionTypeId);
  await admin.from('tracks').delete().eq('id', trackId);
  await admin.from('conference_days').delete().eq('id', conferenceDayId);
  await admin.from('applications').delete().in('id', applicationIds);
  for (const id of applicantUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
});

describe('book_session() dual-writes a booking_confirmed notification', () => {
  it('creates exactly one notifications row with the correct application_id/channel/link_path/session_id (en locale)', async () => {
    const { applicationId, client } = await seedAcceptedApplicant('en-locale');
    const sessionId = await seedSession('en-locale');

    const { data: bookingId, error } = await client.rpc('book_session', { p_application_id: applicationId, p_session_id: sessionId });
    expect(error).toBeNull();
    expect(bookingId).toBeTruthy();

    const { data: rows } = await admin
      .from('notifications')
      .select('id, application_id, channel, title, link_path, session_id, is_broadcast')
      .eq('application_id', applicationId)
      .eq('channel', 'booking_confirmed');
    const notifRows = rows ?? [];
    for (const r of notifRows) notificationIds.push(r.id);

    expect(notifRows).toHaveLength(1);
    expect(notifRows[0].is_broadcast).toBe(false);
    expect(notifRows[0].link_path).toBe('/my-agenda');
    expect(notifRows[0].session_id).toBe(sessionId);
    expect(notifRows[0].title).toContain('Booking Confirmation Session');
    expect(notifRows[0].title).toContain('Your booking is confirmed');
  });

  it('uses the Arabic session title and Arabic wording for an applicant with preferred_language=ar', async () => {
    const { applicationId, client } = await seedAcceptedApplicant('ar-locale', 'ar');
    const sessionId = await seedSession('ar-locale');

    const { error } = await client.rpc('book_session', { p_application_id: applicationId, p_session_id: sessionId });
    expect(error).toBeNull();

    const { data: rows } = await admin
      .from('notifications')
      .select('id, title, channel')
      .eq('application_id', applicationId)
      .eq('channel', 'booking_confirmed');
    const notifRows = rows ?? [];
    for (const r of notifRows) notificationIds.push(r.id);

    expect(notifRows).toHaveLength(1);
    expect(notifRows[0].title).toBe('تم تأكيد حجزك في: جلسة تأكيد الحجز');
  });

  it('creates zero notifications rows when book_session() rejects the booking (session full)', async () => {
    const sessionId = await seedSession('full-session', { capacity: 1 });
    const { applicationId: firstAppId, client: firstClient } = await seedAcceptedApplicant('full-first');
    const { applicationId: secondAppId, client: secondClient } = await seedAcceptedApplicant('full-second');

    const { error: firstError } = await firstClient.rpc('book_session', { p_application_id: firstAppId, p_session_id: sessionId });
    expect(firstError).toBeNull();

    const { error: secondError } = await secondClient.rpc('book_session', { p_application_id: secondAppId, p_session_id: sessionId });
    expect(secondError).not.toBeNull();
    expect(secondError?.message).toContain('Session is full');

    const { data: rows } = await admin
      .from('notifications')
      .select('id')
      .eq('application_id', secondAppId)
      .eq('channel', 'booking_confirmed');
    for (const r of rows ?? []) notificationIds.push(r.id);
    expect(rows ?? []).toHaveLength(0);

    const { data: firstNotifRows } = await admin
      .from('notifications')
      .select('id')
      .eq('application_id', firstAppId)
      .eq('channel', 'booking_confirmed');
    for (const r of firstNotifRows ?? []) notificationIds.push(r.id);
    expect(firstNotifRows ?? []).toHaveLength(1);
  });
});

// Final whole-branch review of sub-project 6 found that
// session-reminders/route.ts's 10-minute match window overlapping its
// 5-minute cron cadence meant the SAME participant/session pair could be
// reminded 2-3 times by consecutive invocations, with no guard against
// it. Fixed via notifications_session_reminder_dedupe_idx (migration
// 20261008090000), a unique partial index on
// (application_id, session_id, channel) for channel='session_reminder'.
// This suite exercises the REAL live index (not a mocked route, which
// tests/attendance/session-reminders-dedupe.test.ts already covers for
// the route's own 23505-handling logic) -- i.e. that create_notification
// itself genuinely cannot insert a second session_reminder row for the
// same application_id/session_id, and that the constraint is correctly
// scoped to ONLY that channel (a different channel for the same
// application_id/session_id must remain unaffected).
describe('notifications_session_reminder_dedupe_idx', () => {
  it('rejects a second session_reminder insert for the same application_id/session_id with a 23505 unique-violation', async () => {
    const { applicationId } = await seedAcceptedApplicant('dedupe-reminder');
    const sessionId = await seedSession('dedupe-reminder');

    const { data: first, error: firstError } = await admin.rpc('create_notification' as never, {
      p_application_id: applicationId,
      p_channel: 'session_reminder',
      p_title: 'Reminder: "Test Session" starts in 30 minutes',
      p_session_id: sessionId,
    } as never);
    expect(firstError).toBeNull();
    const firstRow = first as unknown as { id: string };
    notificationIds.push(firstRow.id);

    const { data: second, error: secondError } = await admin.rpc('create_notification' as never, {
      p_application_id: applicationId,
      p_channel: 'session_reminder',
      p_title: 'Reminder: "Test Session" starts in 30 minutes',
      p_session_id: sessionId,
    } as never);
    expect(second).toBeNull();
    expect(secondError).not.toBeNull();
    expect(secondError?.code).toBe('23505');

    const { data: rows } = await admin
      .from('notifications')
      .select('id')
      .eq('application_id', applicationId)
      .eq('session_id', sessionId)
      .eq('channel', 'session_reminder');
    for (const r of rows ?? []) notificationIds.push(r.id);
    expect(rows ?? []).toHaveLength(1);
  });

  it('does not affect a different channel for the same application_id/session_id', async () => {
    const { applicationId } = await seedAcceptedApplicant('dedupe-other-channel');
    const sessionId = await seedSession('dedupe-other-channel');

    const { data: reminder, error: reminderError } = await admin.rpc('create_notification' as never, {
      p_application_id: applicationId,
      p_channel: 'session_reminder',
      p_title: 'Reminder: "Test Session" starts in 30 minutes',
      p_session_id: sessionId,
    } as never);
    expect(reminderError).toBeNull();
    notificationIds.push((reminder as unknown as { id: string }).id);

    // Same application_id/session_id, different channel -- must succeed,
    // proving the unique index's WHERE clause correctly scopes it to
    // channel='session_reminder' only, not to the (application_id,
    // session_id) pair in general.
    const { data: cancelled, error: cancelledError } = await admin.rpc('create_notification' as never, {
      p_application_id: applicationId,
      p_channel: 'session_cancelled',
      p_title: '"Test Session" has been cancelled',
      p_session_id: sessionId,
    } as never);
    expect(cancelledError).toBeNull();
    notificationIds.push((cancelled as unknown as { id: string }).id);
  });
});
