// tests/attendance/admit-walk-in-idempotency-live.test.ts
//
// Live coverage for the idempotency-key behavior added to admit_walk_in in
// supabase/migrations/20261006120000_admit_walk_in_idempotency.sql (Task 2
// of docs/superpowers/plans/2026-10-06-offline-scanning-support.md). Covers
// spec Testing Requirements 2, 4, 5 (the walk-in-specific parts) and
// Requirement 7's THREE distinct cases (see
// docs/superpowers/specs/2026-10-06-offline-scanning-support-design.md
// "Testing Requirements"):
//   7a - an ordinary non-staff caller presenting a previously-used, valid
//        idempotency key still gets 'Not authorized' (idempotency check
//        never runs before/instead of the is_staff() gate).
//   7b - an anon-key client (no signed-in user) gets a permission-denied
//        error at the grant layer, never reaching the function body
//        (proves `revoke ... from public, anon` took effect).
//   7c - a signed-in but PROFILE-LESS authenticated user gets
//        'Not authorized' from inside the function body (exercises
//        coalesce(is_staff(), false) specifically).
//
// admit_walk_in's existing, non-idempotency live coverage lives in
// tests/agenda/booking-rules-completion-live.test.ts's
// describe('walk-in admission') block -- this file only covers the new
// idempotency-key/security-fix behavior. Fixture pattern follows
// tests/attendance/scan-qr-idempotency-live.test.ts (Task 1's own test
// file): real Supabase Auth users, real conference_days/rooms/tracks/
// session_types/sessions rows, runId-suffixed identifiers throughout (per
// this project's own memory notes on fixture-collision across reruns),
// careful FK-ordered afterAll cleanup.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
if (!URL || !SERVICE_KEY || !ANON_KEY) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set to run this live test');
}
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

const runId = randomUUID().slice(0, 8);
const dayOffset = Math.floor(Math.random() * 3000) + 1;
const CONFERENCE_DATE = new Date(Date.UTC(2099, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

let staffUserId: string;
let staffClient: ReturnType<typeof createClient<Database>>;
let conferenceDayId: string;
let trackId: string;
let sessionTypeId: string;

const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const sessionIds: string[] = [];
const roomIds: string[] = [];
let roomCounter = 0;

async function createRoom(): Promise<string> {
  roomCounter += 1;
  const { data, error } = await admin
    .from('rooms')
    .insert({ code: `WALKIN-IDEMP-ROOM-${runId}-${roomCounter}`, name_ar: 'قاعة', name_en: `Room ${roomCounter}`, capacity: 100 })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create room: ${error?.message}`);
  roomIds.push(data.id);
  return data.id;
}

async function createApplicant(emailLocalPart: string): Promise<{ userId: string; applicationId: string }> {
  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email: `walkin-idemp-${runId}-${emailLocalPart}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (userError || !user.user) throw new Error(`Failed to create applicant ${emailLocalPart}: ${userError?.message}`);
  applicantUserIds.push(user.user.id);

  const { data: app, error: appError } = await admin
    .from('applications')
    .insert({ applicant_id: user.user.id, status: 'accepted' })
    .select('id')
    .single();
  if (appError || !app) throw new Error(`Failed to create application for ${emailLocalPart}: ${appError?.message}`);
  applicationIds.push(app.id);

  return { userId: user.user.id, applicationId: app.id };
}

async function createSession(overrides: Partial<Database['public']['Tables']['sessions']['Insert']> & { session_code: string }) {
  const roomForSession = overrides.room_id ?? (await createRoom());
  const { data, error } = await admin
    .from('sessions')
    .insert({
      title_ar: 'ج',
      title_en: 'Session',
      conference_day_id: conferenceDayId,
      start_time: `${CONFERENCE_DATE}T09:00:00Z`,
      end_time: `${CONFERENCE_DATE}T10:00:00Z`,
      track_id: trackId,
      session_type_id: sessionTypeId,
      language: 'bilingual',
      difficulty_level: 'all_levels',
      capacity: 10,
      is_mandatory: false,
      status: 'confirmed',
      admission_policy: 'open',
      ...overrides,
      room_id: roomForSession,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create session ${overrides.session_code}: ${error?.message}`);
  sessionIds.push(data.id);
  return data.id;
}

async function callAdmitWalkIn(
  client: ReturnType<typeof createClient<Database>>,
  params: { applicationId: string | null; sessionId: string; idempotencyKey?: string | null },
) {
  const { data, error } = await client.rpc('admit_walk_in', {
    p_application_id: params.applicationId as string,
    p_session_id: params.sessionId,
    p_idempotency_key: (params.idempotencyKey ?? null) as string,
  });
  return { data, error };
}

beforeAll(async () => {
  const { data: staff } = await admin.auth.admin.createUser({
    email: `walkin-idemp-${runId}-staff@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  staffUserId = staff!.user!.id;
  applicantUserIds.push(staffUserId); // reuse the shared afterAll cleanup loop
  await admin.from('profiles').update({ role: 'staff' }).eq('id', staffUserId);

  staffClient = createClient<Database>(URL, ANON_KEY);
  await staffClient.auth.signInWithPassword({ email: `walkin-idemp-${runId}-staff@test.local`, password: 'password123' });

  const { data: day } = await admin
    .from('conference_days')
    .insert({ conference_date: CONFERENCE_DATE, label_ar: 'يوم', label_en: 'Day', display_order: 1 })
    .select('id')
    .single();
  conferenceDayId = day!.id;

  const { data: track } = await admin.from('tracks').insert({ code: `WALKIN-IDEMP-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;

  const { data: sessionType } = await admin.from('session_types').insert({ code: `WALKIN-IDEMP-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;
});

afterAll(async () => {
  if (sessionIds.length > 0) {
    await admin.from('attendance_records').delete().in('session_id', sessionIds);
    await admin.from('session_bookings').delete().in('session_id', sessionIds);
    await admin.from('sessions').delete().in('id', sessionIds);
  }
  await admin.from('tracks').delete().eq('id', trackId);
  await admin.from('session_types').delete().eq('id', sessionTypeId);
  if (roomIds.length > 0) {
    await admin.from('rooms').delete().in('id', roomIds);
  }
  await admin.from('conference_days').delete().eq('id', conferenceDayId);
  if (applicationIds.length > 0) {
    await admin.from('applications').delete().in('id', applicationIds);
  }
  await Promise.allSettled(applicantUserIds.map((id) => admin.auth.admin.deleteUser(id)));
});

describe('admit_walk_in — idempotency key + security fixes', () => {
  // Requirement 2: a walk-in admission retried with the same idempotency
  // key after the original committed returns the same booking_id, no
  // second session_bookings row, and no 'already has a booking' error.
  it('[Req 2] retrying with the same idempotency key after the original committed returns the same booking_id, no second row', async () => {
    const sessionId = await createSession({ session_code: `req2-replay-${runId}` });
    const { applicationId } = await createApplicant('req2-replay');
    const idempotencyKey = randomUUID();

    const first = await callAdmitWalkIn(staffClient, { applicationId, sessionId, idempotencyKey });
    expect(first.error, `RPC error: ${first.error?.message}`).toBeNull();
    expect(first.data).toBeTruthy();

    const retry = await callAdmitWalkIn(staffClient, { applicationId, sessionId, idempotencyKey });
    expect(retry.error).toBeNull();
    expect(retry.data).toBe(first.data);

    const { data: bookings } = await admin.from('session_bookings').select('id').eq('idempotency_key', idempotencyKey);
    expect(bookings).toHaveLength(1);
  });

  // Requirement 4: the same idempotency key presented with different
  // admission data (a different application_id + session_id pair) raises
  // the distinct mismatch error, never returning stale data.
  it('[Req 4] the same idempotency key with a different application_id/session_id raises the mismatch error, not stale data', async () => {
    const sessionIdA = await createSession({ session_code: `req4-sess-a-${runId}` });
    const sessionIdB = await createSession({ session_code: `req4-sess-b-${runId}` });
    const { applicationId: applicationIdA } = await createApplicant('req4-a');
    const { applicationId: applicationIdB } = await createApplicant('req4-b');
    const idempotencyKey = randomUUID();

    const first = await callAdmitWalkIn(staffClient, { applicationId: applicationIdA, sessionId: sessionIdA, idempotencyKey });
    expect(first.error).toBeNull();

    const second = await callAdmitWalkIn(staffClient, { applicationId: applicationIdB, sessionId: sessionIdB, idempotencyKey });
    expect(second.error).not.toBeNull();
    expect(second.error!.message).toContain('Idempotency key reused with different admission data');
  });

  // Requirement 5: two genuinely parallel admit_walk_in calls with the
  // same idempotency key both resolve to the same booking_id, with no
  // false 'already has a booking' rejection on either side. Defense-in-
  // depth backstop coverage alongside Req 2's sequential case, not the
  // sole proof the race is closed (per the spec's own note).
  it('[Req 5] two genuinely parallel calls with the same idempotency key both resolve to the same booking_id, no false rejection', async () => {
    const sessionId = await createSession({ session_code: `req5-race-${runId}`, capacity: 5 });
    const { applicationId } = await createApplicant('req5-race');
    const idempotencyKey = randomUUID();

    const [resultA, resultB] = await Promise.allSettled([
      callAdmitWalkIn(staffClient, { applicationId, sessionId, idempotencyKey }),
      callAdmitWalkIn(staffClient, { applicationId, sessionId, idempotencyKey }),
    ]);

    expect(resultA.status).toBe('fulfilled');
    expect(resultB.status).toBe('fulfilled');
    const dataA = resultA.status === 'fulfilled' ? resultA.value : null;
    const dataB = resultB.status === 'fulfilled' ? resultB.value : null;

    expect(dataA!.error).toBeNull();
    expect(dataB!.error).toBeNull();
    expect(dataA!.data).toBe(dataB!.data);

    const { data: bookings } = await admin.from('session_bookings').select('id').eq('idempotency_key', idempotencyKey);
    expect(bookings).toHaveLength(1);
  });

  // Requirement 7a: an ordinary non-staff PARTICIPANT presenting a valid,
  // previously-committed idempotency key from someone else's successful
  // admission still gets 'Not authorized' -- the idempotency check never
  // runs before (or instead of) the is_staff() gate, regardless of
  // whether the key itself would have matched.
  it('[Req 7a] a non-staff caller presenting a previously-used, valid idempotency key still gets Not authorized', async () => {
    const sessionId = await createSession({ session_code: `req7a-nonstaff-${runId}` });
    const { applicationId: staffAdmittedAppId } = await createApplicant('req7a-donor');
    const usedKey = randomUUID();
    const original = await callAdmitWalkIn(staffClient, { applicationId: staffAdmittedAppId, sessionId, idempotencyKey: usedKey });
    expect(original.error).toBeNull();

    const { userId: participantUserId, applicationId: participantApplicationId } = await createApplicant('req7a-participant');
    const email = `walkin-idemp-${runId}-req7a-participant@test.local`;
    const participantClient = createClient<Database>(URL, ANON_KEY);
    await participantClient.auth.signInWithPassword({ email, password: 'password123' });
    void participantUserId;

    const attempt = await callAdmitWalkIn(participantClient, {
      applicationId: participantApplicationId,
      sessionId,
      idempotencyKey: usedKey,
    });
    expect(attempt.error).not.toBeNull();
    expect(attempt.error!.message).toContain('Not authorized');
  });

  // Requirement 7b: an anon-key client (no signed-in user at all) gets a
  // permission-denied error at the GRANT layer, never reaching the
  // function body -- proves `revoke ... from public, anon` took effect.
  it('[Req 7b] an anon-key client (no signed-in user) is rejected at the grant layer, not inside the function', async () => {
    const sessionId = await createSession({ session_code: `req7b-anon-${runId}` });
    const { applicationId } = await createApplicant('req7b-anon');

    const anonClient = createClient<Database>(URL, ANON_KEY);
    const attempt = await callAdmitWalkIn(anonClient, { applicationId, sessionId, idempotencyKey: randomUUID() });

    expect(attempt.error).not.toBeNull();
    // A grant-layer rejection surfaces as a Postgres permission-denied
    // error (SQLSTATE 42501), not the function's own 'Not authorized'
    // exception text -- the two must be distinguishable, since only the
    // grant-layer rejection proves the revoke, rather than merely the
    // is_staff() check, is what's stopping this caller.
    expect(attempt.error!.message).not.toContain('Not authorized');
    expect(attempt.error!.message.toLowerCase()).toMatch(/permission denied|function .* does not exist/);
  });

  // Requirement 7c: a genuinely signed-in but PROFILE-LESS authenticated
  // user gets 'Not authorized' from INSIDE the function body -- the only
  // way to actually exercise coalesce(is_staff(), false) specifically,
  // since the anon case above never reaches it at all once the grant is
  // fixed.
  it('[Req 7c] a signed-in but profile-less authenticated user gets Not authorized from inside the function (coalesce fix)', async () => {
    const sessionId = await createSession({ session_code: `req7c-noprofile-${runId}` });
    const { applicationId } = await createApplicant('req7c-target');

    const email = `walkin-idemp-${runId}-req7c-noprofile@test.local`;
    const { data: user, error: userError } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
    if (userError || !user.user) throw new Error(`Failed to create profile-less user: ${userError?.message}`);
    applicantUserIds.push(user.user.id);

    // Remove the profiles row the handle_new_user trigger (or equivalent)
    // creates automatically, so is_staff() has no row to read and returns
    // NULL rather than false.
    await admin.from('profiles').delete().eq('id', user.user.id);

    const profileLessClient = createClient<Database>(URL, ANON_KEY);
    await profileLessClient.auth.signInWithPassword({ email, password: 'password123' });

    const attempt = await callAdmitWalkIn(profileLessClient, { applicationId, sessionId, idempotencyKey: randomUUID() });
    expect(attempt.error).not.toBeNull();
    expect(attempt.error!.message).toContain('Not authorized');
  });
});
