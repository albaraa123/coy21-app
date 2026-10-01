// tests/agenda/session-lifecycle-notifications-live.test.ts
//
// Live coverage for enforce_session_lifecycle_booking_sync() (added in
// 20261004010000_session_lifecycle_notifications.sql): cancelling a
// session must mark its active bookings 'session_cancelled' and queue one
// outbox row per booking; changing a session's time (without cancelling)
// must leave bookings 'active' and queue a reschedule outbox row;
// cancel_booking() must reject an already-session_cancelled booking.
//
// Runs against the live scratch Supabase project. Follows the room-overlap
// and auth.uid() gotchas documented in
// tests/agenda/booking-allocation-conflict-live.test.ts.
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
let sessionTypeId: string;

const roomIds: string[] = [];
const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const sessionIds: string[] = [];

async function seedAcceptedApplicant(emailSlug: string): Promise<{ applicationId: string; client: ReturnType<typeof createClient<Database>> }> {
  const email = `session-lifecycle-live-${runId}-${emailSlug}@test.local`;
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

async function seedSession(codeSlug: string, overrides: Partial<Database['public']['Tables']['sessions']['Insert']> = {}) {
  const { data: room } = await admin.from('rooms').insert({ code: `SLC-ROOM-${codeSlug}-${runId}`, name_ar: 'قاعة', name_en: 'Room', capacity: 10 }).select('id').single();
  roomIds.push(room!.id);

  const { data } = await admin
    .from('sessions')
    .insert({
      session_code: `SLC-${codeSlug}-${runId}`,
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
  const { data: track } = await admin.from('tracks').insert({ code: `SLC-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  const { data: sType } = await admin.from('session_types').insert({ code: `SLC-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sType!.id;
});

afterAll(async () => {
  // `as never`: session_notification_outbox (added in
  // 20261004010000_session_lifecycle_notifications.sql) is not yet
  // reflected in the generated src/types/database.ts snapshot -- same
  // established workaround used throughout
  // src/app/api/cron/process-session-notifications/route.ts.
  await admin.from('session_notification_outbox' as never).delete().in('session_id' as never, sessionIds);
  await admin.from('session_bookings').delete().in('application_id', applicationIds);
  // This suite's updates to sessions.status/start_time/end_time also fire
  // the pre-existing sessions_change_detection trigger
  // (20260723180000_schedule_change_detection_triggers.sql), which inserts
  // rows into schedule_change_events referencing session_id with NO "on
  // delete cascade" (20260723150000_schedule_change_event_tables.sql:4).
  // Without this delete, the sessions delete below fails with FK violation
  // 23503, silently aborting the rest of this cleanup and leaking rooms/
  // tracks/session_types/conference_days/applications/auth users on every
  // run (discovered the hard way while verifying this suite's idempotency).
  await admin.from('schedule_change_events').delete().in('session_id', sessionIds);
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

describe('session cancellation syncs bookings and queues notifications', () => {
  it('marks an active booking session_cancelled and queues exactly one outbox row with notification_type session_cancelled', async () => {
    const { applicationId } = await seedAcceptedApplicant('cancel-single');
    const sessionId = await seedSession('cancel-single');
    const bookingId = await directBooking(applicationId, sessionId);

    const { error: updateError } = await admin
      .from('sessions')
      .update({ status: 'cancelled', cancellation_reason: 'test' })
      .eq('id', sessionId);
    expect(updateError).toBeNull();

    const { data: booking } = await admin.from('session_bookings').select('status, cancelled_at').eq('id', bookingId).single();
    expect(booking?.status).toBe('session_cancelled');
    expect(booking?.cancelled_at).not.toBeNull();

    const { data: outboxRows } = await admin
      .from('session_notification_outbox' as never)
      .select('notification_type, booking_id')
      .eq('session_id' as never, sessionId);
    const rows = (outboxRows ?? []) as { notification_type: string; booking_id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].notification_type).toBe('session_cancelled');
    expect(rows[0].booking_id).toBe(bookingId);
  });

  it('queues one outbox row per booking when multiple participants booked the same session', async () => {
    const { applicationId: appA } = await seedAcceptedApplicant('cancel-multi-a');
    const { applicationId: appB } = await seedAcceptedApplicant('cancel-multi-b');
    const sessionId = await seedSession('cancel-multi');
    const bookingA = await directBooking(appA, sessionId);
    const bookingB = await directBooking(appB, sessionId);

    await admin.from('sessions').update({ status: 'cancelled', cancellation_reason: 'test' }).eq('id', sessionId);

    const { data: outboxRows } = await admin
      .from('session_notification_outbox' as never)
      .select('booking_id')
      .eq('session_id' as never, sessionId);
    const rows = (outboxRows ?? []) as { booking_id: string }[];
    expect(rows).toHaveLength(2);
    const bookingIds = rows.map((r) => r.booking_id).sort();
    expect(bookingIds).toEqual([bookingA, bookingB].sort());
  });

  it('creates zero outbox rows when cancelling a session with no active bookings', async () => {
    const sessionId = await seedSession('cancel-empty');

    await admin.from('sessions').update({ status: 'cancelled', cancellation_reason: 'test' }).eq('id', sessionId);

    const { data: outboxRows } = await admin
      .from('session_notification_outbox' as never)
      .select('id')
      .eq('session_id' as never, sessionId);
    expect(outboxRows).toHaveLength(0);
  });

  it('cancel_booking() rejects an attempt to cancel an already-session_cancelled booking', async () => {
    const { applicationId, client } = await seedAcceptedApplicant('cancel-rpc-reject');
    const sessionId = await seedSession('cancel-rpc-reject');
    const bookingId = await directBooking(applicationId, sessionId);
    await admin.from('sessions').update({ status: 'cancelled', cancellation_reason: 'test' }).eq('id', sessionId);

    const { error } = await client.rpc('cancel_booking', { p_booking_id: bookingId, p_application_id: applicationId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain('already cancelled');
  });
});

describe('session reschedule leaves bookings active and queues notifications', () => {
  it('keeps the booking active and queues exactly one reschedule outbox row with correct old/new times', async () => {
    const { applicationId } = await seedAcceptedApplicant('reschedule-single');
    const sessionId = await seedSession('reschedule-single');
    const bookingId = await directBooking(applicationId, sessionId);

    const newStart = `${DAY}T14:00:00+03:00`;
    const newEnd = `${DAY}T15:00:00+03:00`;
    const { error: updateError } = await admin
      .from('sessions')
      .update({ start_time: newStart, end_time: newEnd })
      .eq('id', sessionId);
    expect(updateError).toBeNull();

    const { data: booking } = await admin.from('session_bookings').select('status').eq('id', bookingId).single();
    expect(booking?.status).toBe('active');

    const { data: outboxRows } = await admin
      .from('session_notification_outbox' as never)
      .select('notification_type, old_start_time, new_start_time')
      .eq('session_id' as never, sessionId);
    const rows = (outboxRows ?? []) as { notification_type: string; old_start_time: string | null; new_start_time: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].notification_type).toBe('session_rescheduled');
    // seedSession always inserts `${DAY}T09:00:00+03:00` unless overridden -- that's the pre-update value the trigger should have captured as old_start_time.
    expect(new Date(rows[0].old_start_time!).toISOString()).toBe(new Date(`${DAY}T09:00:00+03:00`).toISOString());
    expect(new Date(rows[0].new_start_time!).toISOString()).toBe(new Date(newStart).toISOString());
  });

  it('queues zero outbox rows when only room_id changes (no time change)', async () => {
    const { applicationId } = await seedAcceptedApplicant('reschedule-room-only');
    const sessionId = await seedSession('reschedule-room-only');
    await directBooking(applicationId, sessionId);

    const { data: newRoom } = await admin.from('rooms').insert({ code: `SLC-ROOM-ALT-${runId}`, name_ar: 'قاعة بديلة', name_en: 'Alt Room', capacity: 10 }).select('id').single();
    roomIds.push(newRoom!.id);

    await admin.from('sessions').update({ room_id: newRoom!.id }).eq('id', sessionId);

    const { data: outboxRows } = await admin
      .from('session_notification_outbox' as never)
      .select('id')
      .eq('session_id' as never, sessionId);
    expect(outboxRows).toHaveLength(0);
  });
});

describe('/my-agenda query includes session_cancelled bookings, excludes participant-voluntary cancelled', () => {
  it('returns both active and session_cancelled bookings for the applicant, never plain cancelled', async () => {
    const { applicationId } = await seedAcceptedApplicant('query-filter');
    const activeSessionId = await seedSession('query-active');
    const cancelledSessionId = await seedSession('query-cancelled');
    const voluntarySessionId = await seedSession('query-voluntary');

    await directBooking(applicationId, activeSessionId);
    const sessionCancelledBookingId = await directBooking(applicationId, cancelledSessionId);
    const voluntaryBookingId = await directBooking(applicationId, voluntarySessionId);

    await admin.from('sessions').update({ status: 'cancelled', cancellation_reason: 'test' }).eq('id', cancelledSessionId);
    await admin.from('session_bookings').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', voluntaryBookingId);

    const { data: rows } = await admin
      .from('session_bookings')
      .select('id, status')
      .eq('application_id', applicationId)
      .in('status', ['active', 'session_cancelled']);

    const ids = (rows ?? []).map((r) => r.id);
    expect(ids).toContain(sessionCancelledBookingId);
    expect(ids).not.toContain(voluntaryBookingId);
  });
});
