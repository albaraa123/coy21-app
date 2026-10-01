// tests/agenda/booking-allocation-conflict-live.test.ts
//
// Live coverage for book_session()'s new allocation-awareness (added in
// 20261003000000_book_session_respects_allocation.sql): it must reject a
// booking that time-conflicts with a CONFIRMED allocation_assignments row
// for the same participant, and must count confirmed allocation_assignments
// toward a session's capacity alongside active session_bookings. A
// 'proposed' (not yet confirmed) assignment must NOT block a booking or
// count toward capacity -- only 'confirmed' does.
//
// Runs against the live scratch Supabase project -- not isolated from
// other test data; see tests/allocation/priority-pool-validation-live.test.ts
// for the same pattern this file follows.
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
let staffId: string;
let featureExtractionRunId: string;
let allocationRunId: string;

const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const sessionIds: string[] = [];
// sessions.sessions_room_no_overlap is a GIST exclusion constraint that
// rejects two draft/published/confirmed sessions in the SAME room with
// overlapping times (supabase/migrations/20260722210000_sessions_table.sql:55-59).
// This suite deliberately creates many sessions sharing the same default
// 09:00-10:00 window (to exercise participant-level time-conflict logic),
// so each seedSession() call gets its own dedicated room to avoid tripping
// that room-level constraint -- room_id is otherwise irrelevant to what
// book_session()'s allocation-awareness checks (participant + time only).
const roomIds: string[] = [];

// book_session()'s own authorization check requires auth.uid() to equal the
// application's applicant_id (20260823020000_session_bookings.sql:97-102).
// Calling it via the service-role `admin` client always fails with
// 'Not authorized', since auth.uid() is null under service_role -- so every
// book_session() call in this suite must go through a real signed-in
// participant client, not `admin`. seedAcceptedApplicant() therefore returns
// both the application id and a ready-to-use signed-in client for that
// applicant, following the sign-in pattern from tests/allocation/authorization.test.ts.
async function seedAcceptedApplicant(emailSlug: string): Promise<{ applicationId: string; client: ReturnType<typeof createClient<Database>> }> {
  const email = `booking-alloc-conflict-live-${runId}-${emailSlug}@test.local`;
  const { data: user } = await admin.auth.admin.createUser({
    email,
    password: 'password123',
    email_confirm: true,
  });
  const applicantId = user!.user!.id;
  applicantUserIds.push(applicantId);

  const { data: app } = await admin
    .from('applications')
    .insert({
      applicant_id: applicantId,
      status: 'accepted',
      preferred_language: 'ar',
      experience_level: 'beginner',
      interests: [],
    })
    .select('id')
    .single();
  applicationIds.push(app!.id);

  const client = createClient<Database>(URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: 'password123' });
  if (signInError) throw new Error(`Failed to sign in seeded applicant: ${signInError.message}`);

  return { applicationId: app!.id, client };
}

async function seedSession(codeSlug: string, overrides: Partial<Database['public']['Tables']['sessions']['Insert']> = {}) {
  // Dedicated room per session -- see roomIds comment above for why.
  const { data: room, error: roomError } = await admin
    .from('rooms')
    .insert({ code: `BALC-ROOM-${codeSlug}-${runId}`, name_ar: 'قاعة', name_en: 'Room', capacity: 10 })
    .select('id')
    .single();
  if (roomError) throw new Error(`Failed to seed rooms: ${roomError.message}`);
  roomIds.push(room!.id);

  const { data, error } = await admin
    .from('sessions')
    .insert({
      session_code: `BALC-${codeSlug}-${runId}`,
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
      capacity: 2,
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

async function insertAllocationAssignment(applicationId: string, sessionId: string, status: 'proposed' | 'confirmed') {
  const { data, error } = await admin
    .from('allocation_assignments')
    .insert({
      allocation_run_id: allocationRunId,
      application_id: applicationId,
      session_id: sessionId,
      time_slot_group_key: `slot-${sessionId}`,
      suitability_score: 0.9,
      status,
    })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to seed allocation_assignments: ${error.message}`);
  return data!.id as string;
}

beforeAll(async () => {
  const { data: staff } = await admin.auth.admin.createUser({ email: `booking-alloc-conflict-live-${runId}-staff@test.local`, password: 'password123', email_confirm: true });
  staffId = staff!.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  const { data: day } = await admin.from('conference_days').insert({ conference_date: DAY, label_ar: 'يوم اختبار', label_en: 'Test Day', display_order: 1 }).select('id').single();
  conferenceDayId = day!.id;
  const { data: track } = await admin.from('tracks').insert({ code: `BALC-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  const { data: sType } = await admin.from('session_types').insert({ code: `BALC-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sType!.id;

  const { data: extraction } = await admin
    .from('feature_extraction_runs')
    .insert({ rules_version: 1, application_count: 0, run_by: staffId })
    .select('id')
    .single();
  featureExtractionRunId = extraction!.id;

  const { data: run } = await admin
    .from('allocation_runs')
    .insert({ feature_extraction_run_id: featureExtractionRunId, run_by: staffId, status: 'draft' })
    .select('id')
    .single();
  allocationRunId = run!.id;
});

afterAll(async () => {
  await admin.from('allocation_assignments').delete().eq('allocation_run_id', allocationRunId);
  await admin.from('allocation_runs').delete().eq('id', allocationRunId);
  await admin.from('feature_extraction_runs').delete().eq('id', featureExtractionRunId);
  await admin.from('session_bookings').delete().in('application_id', applicationIds);
  await admin.from('sessions').delete().in('id', sessionIds);
  await admin.from('rooms').delete().in('id', roomIds);
  await admin.from('session_types').delete().eq('id', sessionTypeId);
  await admin.from('tracks').delete().eq('id', trackId);
  await admin.from('conference_days').delete().eq('id', conferenceDayId);
  await admin.from('applications').delete().in('id', applicationIds);
  for (const id of [...applicantUserIds, staffId]) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
});

describe('book_session() respects confirmed allocation_assignments', () => {
  it('rejects a booking that time-conflicts with a CONFIRMED allocation assignment', async () => {
    const { applicationId, client } = await seedAcceptedApplicant('conflict-confirmed');
    const assignedSessionId = await seedSession('assigned-1');
    const bookableSessionId = await seedSession('bookable-1'); // same default 09:00-10:00 window -> overlaps
    await insertAllocationAssignment(applicationId, assignedSessionId, 'confirmed');

    const { error } = await client.rpc('book_session', { p_application_id: applicationId, p_session_id: bookableSessionId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain('Time conflict with an assigned session');
  });

  it('allows a booking that time-conflicts with only a PROPOSED (not confirmed) allocation assignment', async () => {
    const { applicationId, client } = await seedAcceptedApplicant('conflict-proposed');
    const assignedSessionId = await seedSession('assigned-2');
    const bookableSessionId = await seedSession('bookable-2');
    await insertAllocationAssignment(applicationId, assignedSessionId, 'proposed');

    const { error } = await client.rpc('book_session', { p_application_id: applicationId, p_session_id: bookableSessionId });
    expect(error).toBeNull();
  });

  it('counts confirmed allocation_assignments toward capacity, rejecting once combined occupancy reaches it', async () => {
    // capacity=2 session; fill it with 1 confirmed allocation_assignment + 1 active session_booking,
    // then a third participant's booking attempt must be rejected as full.
    const sessionId = await seedSession('capacity-1', { capacity: 2 });
    const { applicationId: allocatedApplicantId } = await seedAcceptedApplicant('capacity-allocated');
    const { applicationId: bookedApplicantId, client: bookedClient } = await seedAcceptedApplicant('capacity-booked');
    const { applicationId: thirdApplicantId, client: thirdClient } = await seedAcceptedApplicant('capacity-third');

    await insertAllocationAssignment(allocatedApplicantId, sessionId, 'confirmed');
    const { error: firstBookingError } = await bookedClient.rpc('book_session', { p_application_id: bookedApplicantId, p_session_id: sessionId });
    expect(firstBookingError).toBeNull(); // 1 confirmed allocation + this booking = 2, still fits capacity=2

    const { error: thirdError } = await thirdClient.rpc('book_session', { p_application_id: thirdApplicantId, p_session_id: sessionId });
    expect(thirdError).not.toBeNull();
    expect(thirdError?.message).toContain('Session is full');
  });

  it('still succeeds for a session with zero allocation assignments at all (no regression)', async () => {
    const { applicationId, client } = await seedAcceptedApplicant('no-allocation');
    const sessionId = await seedSession('no-allocation-session');

    const { data, error } = await client.rpc('book_session', { p_application_id: applicationId, p_session_id: sessionId });
    expect(error).toBeNull();
    expect(data).toBeTruthy();
  });
});

describe('session_allocation_confirmed_counts()', () => {
  it('returns correct per-session aggregate counts and is callable without staff privileges', async () => {
    const { applicationId } = await seedAcceptedApplicant('agg-count');
    const sessionId = await seedSession('agg-count-session');
    await insertAllocationAssignment(applicationId, sessionId, 'confirmed');

    // `as never`: session_allocation_confirmed_counts()
    // (20261003000000_book_session_respects_allocation.sql) is not yet
    // reflected in the generated src/types/database.ts snapshot -- same
    // established workaround as src/lib/participants/reclassify.ts's
    // regenerate_application_number call. Task 3 of this plan handles
    // regenerating types / the browse-page call site; out of scope here.
    const { data, error } = await admin.rpc('session_allocation_confirmed_counts' as never);
    expect(error).toBeNull();
    const row = ((data ?? []) as { session_id: string; confirmed_count: number }[]).find((r) => r.session_id === sessionId);
    expect(row?.confirmed_count).toBe(1);
  });

  it('is callable by a real participant session (authenticated grant works end-to-end, not just via service_role)', async () => {
    // A real sign-in, not the service-role client -- proves the function's
    // `grant execute ... to authenticated` actually works for a genuine
    // participant JWT, which is the only thing that matters (an
    // introspection query against pg_catalog would only prove the grant
    // statement ran, not that PostgREST/RLS actually honors it end-to-end).
    // Follows the exact sign-in pattern established in
    // tests/allocation/authorization.test.ts.
    const { applicationId } = await seedAcceptedApplicant('grant-check');
    const sessionId = await seedSession('grant-check-session');
    await insertAllocationAssignment(applicationId, sessionId, 'confirmed');

    const email = `booking-alloc-conflict-live-${runId}-grant-check@test.local`;
    const participantClient = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const { error: signInError } = await participantClient.auth.signInWithPassword({ email, password: 'password123' });
    expect(signInError).toBeNull();

    const { data, error } = await participantClient.rpc('session_allocation_confirmed_counts' as never);
    expect(error).toBeNull();
    const row = ((data ?? []) as { session_id: string; confirmed_count: number }[]).find((r) => r.session_id === sessionId);
    expect(row?.confirmed_count).toBe(1);
  });
});
