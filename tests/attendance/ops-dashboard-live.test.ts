// tests/attendance/ops-dashboard-live.test.ts
//
// Live coverage for sub-project 5a (live operations dashboard), Task 1:
// ops_dashboard_snapshot() (20261006071000_ops_dashboard_snapshot.sql)
// and the notify_ops_dashboard() broadcast trigger it installs on
// attendance_records/scan_attempts.
//
// Spec Testing Requirements 1-6
// (docs/superpowers/specs/2026-10-05-ops-dashboard-design.md's Testing
// Requirements section) are each covered by one `it(...)` below,
// annotated with the requirement number, plus bonus coverage of fixes
// caught during plan review (the count(distinct ...) double-count fix,
// the room-vs-session staleness scoping fix) that aren't themselves
// numbered spec requirements. Requirement 7's HAPPY PATH (a Realtime
// client receiving a broadcast after a seeded insert) is deliberately
// NOT automated here -- the spec defers that to manual verification in
// this plan's Task 3 Step 3. This file DOES, however, automate a
// security-boundary regression for the same channel (an anon-key
// client cannot subscribe to it at all) -- found live-exploitable
// during final branch review, this is a different kind of test than
// the deferred happy-path one and is not covered by that deferral.
//
// Runs against the live scratch Supabase project. Follows the
// runId-suffixed-fixture, dedicated-room-per-session,
// signed-in-participant-client, and FK-ordered afterAll cleanup
// conventions documented in tests/agenda/booking-rules-completion-live.test.ts
// (this file's template).
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

// Same rationale as booking-rules-completion-live.test.ts: fixture setup
// (createUser + applications/rooms/sessions inserts per test) and
// afterAll cleanup exceed Vitest's 5000ms test / 10000ms hook defaults
// under real Cloud round-trip latency against the live scratch project.
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
let sessionTypeId: string;
// A dedicated staff profile used by the "staff caller succeeds" path --
// ops_dashboard_snapshot() itself only gates on is_staff(), so a plain
// service-role call already satisfies it (service_role bypasses RLS but
// is_staff() is a plain SQL check against current_user_role(), which a
// service-role JWT call has no profiles row/session for -- so the admin
// client's calls below go through the SECURITY DEFINER function body
// directly without needing a signed-in staff session at all; only the
// "rejects a non-staff caller" test needs a real signed-in,
// non-staff-role client to exercise the rejection branch).

const roomIds: string[] = [];
const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const sessionIds: string[] = [];
const scannerUserIds: string[] = [];
const scannerAssignmentIds: string[] = [];

async function seedAcceptedApplicant(emailSlug: string): Promise<{ applicationId: string; applicantId: string; client: ReturnType<typeof createClient<Database>> }> {
  const email = `ops-dashboard-live-${runId}-${emailSlug}@test.local`;
  const { data: user, error: userError } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  if (userError || !user?.user) throw new Error(`Failed to create applicant user: ${userError?.message}`);
  const applicantId = user.user.id;
  applicantUserIds.push(applicantId);

  const { data: app, error: appError } = await admin
    .from('applications')
    .insert({ applicant_id: applicantId, status: 'accepted', preferred_language: 'en', experience_level: 'beginner', interests: [] })
    .select('id')
    .single();
  if (appError || !app) throw new Error(`Failed to seed applications: ${appError?.message}`);
  applicationIds.push(app.id);

  const client = createClient<Database>(URL, ANON_KEY);
  await client.auth.signInWithPassword({ email, password: 'password123' });

  return { applicationId: app.id, applicantId, client };
}

async function seedScannerUser(label: string): Promise<string> {
  const email = `ops-dashboard-live-${runId}-scanner-${label}@test.local`;
  const { data: user, error } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  if (error || !user?.user) throw new Error(`Failed to create scanner user: ${error?.message}`);
  const scannerId = user.user.id;
  // Role value itself is irrelevant to ops_dashboard_snapshot()'s own
  // scanner_count/stale_scanner_count logic -- it only ever reads
  // scanner_assignments.scanner_user_id and scan_attempts.scanned_by,
  // neither of which join back to profiles.role. Left at the default
  // role rather than updated to 'scanner_device', matching the fact that
  // scanner_assignments.scanner_user_id just references profiles(id)
  // with no role constraint of its own.
  scannerUserIds.push(scannerId);
  return scannerId;
}

async function seedRoom(codeSlug: string): Promise<string> {
  const { data, error } = await admin
    .from('rooms')
    .insert({ code: `OPS-ROOM-${codeSlug}-${runId}`, name_ar: 'قاعة', name_en: 'Room', capacity: 100 })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to seed rooms: ${error?.message}`);
  roomIds.push(data.id);
  return data.id;
}

async function seedSession(codeSlug: string, overrides: Partial<Database['public']['Tables']['sessions']['Insert']> = {}): Promise<{ sessionId: string; roomId: string }> {
  const roomId = overrides.room_id ?? (await seedRoom(codeSlug));

  const { data, error } = await admin
    .from('sessions')
    .insert({
      session_code: `OPS-${codeSlug}-${runId}`,
      title_ar: 'جلسة اختبار',
      title_en: 'Test Session',
      conference_day_id: conferenceDayId,
      start_time: `${DAY}T09:00:00+03:00`,
      end_time: `${DAY}T10:00:00+03:00`,
      track_id: trackId,
      session_type_id: sessionTypeId,
      language: 'en',
      difficulty_level: 'beginner',
      capacity: 10,
      min_capacity: 0,
      status: 'confirmed',
      admission_policy: 'open',
      ...overrides,
      room_id: roomId,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to seed sessions: ${error?.message}`);
  sessionIds.push(data.id);
  return { sessionId: data.id as string, roomId };
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

async function seedScannerAssignment(
  scannerUserId: string,
  overrides: { sessionId?: string; roomId?: string }
): Promise<string> {
  const { data, error } = await admin
    .from('scanner_assignments')
    .insert({
      scanner_user_id: scannerUserId,
      session_id: overrides.sessionId ?? null,
      room_id: overrides.roomId ?? null,
      is_active: true,
      assigned_by: scannerUserId, // assigned_by only needs to reference a real profiles row; reusing the scanner's own id keeps this fixture self-contained, same shorthand admin-client fixtures elsewhere in this codebase use when the actual assigning identity is irrelevant to what's under test
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to seed scanner_assignments: ${error.message}`);
  scannerAssignmentIds.push(data.id);
  return data.id as string;
}

async function seedScanAttempt(
  sessionId: string,
  scannedBy: string,
  result: Database['public']['Tables']['scan_attempts']['Insert']['result'],
  overrides: Partial<Database['public']['Tables']['scan_attempts']['Insert']> = {}
): Promise<string> {
  const now = new Date();
  // scan_attempts_finalization_state_check requires finalized_at NOT NULL
  // (and expires_at NULL) for every non-'token_valid_pending_confirmation'
  // result -- every result value used by this file's tests is terminal,
  // so finalized_at must always be set explicitly on this direct fixture
  // insert, same as scan_attempt_transactional's own inserts do.
  const { data, error } = await admin
    .from('scan_attempts')
    .insert({
      session_id: sessionId,
      scanned_by: scannedBy,
      result,
      created_at: now.toISOString(),
      finalized_at: now.toISOString(),
      ...overrides,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to seed scan_attempts: ${error.message}`);
  return data.id as string;
}

type SnapshotRow = Database['public']['Functions']['ops_dashboard_snapshot']['Returns'][number];

async function findSnapshotRow(rows: SnapshotRow[] | null, sessionId: string): Promise<SnapshotRow> {
  const row = rows?.find((r) => r.session_id === sessionId);
  if (!row) throw new Error(`ops_dashboard_snapshot() did not return a row for session ${sessionId}`);
  return row;
}

beforeAll(async () => {
  const { data: day, error: dayError } = await admin
    .from('conference_days')
    .insert({ conference_date: DAY, label_ar: 'يوم اختبار', label_en: 'Test Day', display_order: 1 })
    .select('id')
    .single();
  if (dayError || !day) throw new Error(`Failed to seed conference_days: ${dayError?.message}`);
  conferenceDayId = day.id;

  const { data: track, error: trackError } = await admin.from('tracks').insert({ code: `OPS-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  if (trackError || !track) throw new Error(`Failed to seed tracks: ${trackError?.message}`);
  trackId = track.id;

  const { data: sessionType, error: sessionTypeError } = await admin
    .from('session_types')
    .insert({ code: `OPS-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type', enable_waitlist: false })
    .select('id')
    .single();
  if (sessionTypeError || !sessionType) throw new Error(`Failed to seed session_types: ${sessionTypeError?.message}`);
  sessionTypeId = sessionType.id;
});

afterAll(async () => {
  await admin.from('scanner_assignments').delete().in('id', scannerAssignmentIds);
  // scan_attempts has no ON DELETE CASCADE from sessions -- must be
  // deleted before sessions below, or that delete fails with a foreign
  // key violation (same FK-ordering requirement documented in
  // booking-rules-completion-live.test.ts for attendance_records).
  await admin.from('scan_attempts').delete().in('session_id', sessionIds);
  await admin.from('attendance_records').delete().in('session_id', sessionIds);
  await admin.from('session_bookings').delete().in('application_id', applicationIds);
  await admin.from('sessions').delete().in('id', sessionIds);
  await admin.from('rooms').delete().in('id', roomIds);
  await admin.from('session_types').delete().eq('id', sessionTypeId);
  await admin.from('tracks').delete().eq('id', trackId);
  await admin.from('conference_days').delete().eq('id', conferenceDayId);
  await admin.from('applications').delete().in('id', applicationIds);
  for (const id of [...applicantUserIds, ...scannerUserIds]) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
});

describe('ops_dashboard_snapshot', () => {
  it('returns occupied_count/occupancy_pct matching session_effective_occupied_count exactly [spec req 1]', async () => {
    const { sessionId } = await seedSession('occupied-match', { capacity: 4 });
    const { applicationId: appId1 } = await seedAcceptedApplicant('occupied-match-1');
    const { applicationId: appId2 } = await seedAcceptedApplicant('occupied-match-2');
    await directBooking(appId1, sessionId);
    await directBooking(appId2, sessionId);

    const { data: effectiveCount, error: effectiveError } = await admin.rpc('session_effective_occupied_count', { p_session_id: sessionId });
    expect(effectiveError).toBeNull();
    expect(effectiveCount).toBe(2);

    const { data: snapshotRows, error: snapshotError } = await admin.rpc('ops_dashboard_snapshot');
    expect(snapshotError, `RPC error: ${snapshotError?.message}`).toBeNull();
    const row = await findSnapshotRow(snapshotRows, sessionId);

    expect(row.occupied_count).toBe(effectiveCount);
    expect(row.occupancy_pct).toBe(Math.round(100 * (2 / 4) * 10) / 10);
    expect(row.occupancy_pct).toBe(50.0);
  });

  it('is_full is true exactly at capacity, false one below it [spec req 2]', async () => {
    const { sessionId } = await seedSession('is-full-boundary', { capacity: 2 });
    const { applicationId: appId1 } = await seedAcceptedApplicant('is-full-boundary-1');
    await directBooking(appId1, sessionId);

    const { data: rowsBelow } = await admin.rpc('ops_dashboard_snapshot');
    const belowRow = await findSnapshotRow(rowsBelow, sessionId);
    expect(belowRow.is_full).toBe(false);

    const { applicationId: appId2 } = await seedAcceptedApplicant('is-full-boundary-2');
    await directBooking(appId2, sessionId);

    const { data: rowsAt } = await admin.rpc('ops_dashboard_snapshot');
    const atRow = await findSnapshotRow(rowsAt, sessionId);
    expect(atRow.is_full).toBe(true);
  });

  it(
    'is_near_full is true at the 90% threshold boundary [spec req 2]',
    async () => {
      const { sessionId } = await seedSession('is-near-full-boundary', { capacity: 10 });
      for (let i = 0; i < 9; i++) {
        const { applicationId } = await seedAcceptedApplicant(`is-near-full-boundary-${i}`);
        await directBooking(applicationId, sessionId);
      }

      const { data: rows } = await admin.rpc('ops_dashboard_snapshot');
      const row = await findSnapshotRow(rows, sessionId);
      expect(row.is_near_full).toBe(true);
      expect(row.is_full).toBe(false);
    },
    // 9 sequential seedAcceptedApplicant calls (each its own multi-step
    // live round-trip) make this test heavier than its siblings -- the
    // file's default 30s testTimeout is occasionally too tight under
    // concurrent load from other live test files hitting the same
    // scratch project at once. Not a bug in the RPC itself (confirmed
    // passing reliably in isolation); just a slower fixture.
    60000
  );

  it('does not count a scanner twice when it has both a room-scoped and session-scoped assignment row [bonus coverage of the plan-review-caught double-count fix, not itself a spec req]', async () => {
    const { sessionId, roomId } = await seedSession('scanner-dedupe');
    const scannerId = await seedScannerUser('dedupe');
    await seedScannerAssignment(scannerId, { roomId });
    await seedScannerAssignment(scannerId, { sessionId });

    const { data: rows, error } = await admin.rpc('ops_dashboard_snapshot');
    expect(error, `RPC error: ${error?.message}`).toBeNull();
    const row = await findSnapshotRow(rows, sessionId);
    expect(row.scanner_count).toBe(1);
  });

  it('flags a scanner stale after 15 minutes with no scan, not stale within 15 minutes [spec req 3]', async () => {
    const { sessionId } = await seedSession('stale-basic');
    const staleScannerId = await seedScannerUser('stale-basic-stale');
    const freshScannerId = await seedScannerUser('stale-basic-fresh');
    await seedScannerAssignment(staleScannerId, { sessionId });
    await seedScannerAssignment(freshScannerId, { sessionId });

    const twentyMinutesAgo = new Date(Date.now() - 20 * 60_000).toISOString();
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    await seedScanAttempt(sessionId, staleScannerId, 'invalid_qr', { created_at: twentyMinutesAgo, finalized_at: twentyMinutesAgo });
    await seedScanAttempt(sessionId, freshScannerId, 'invalid_qr', { created_at: fiveMinutesAgo, finalized_at: fiveMinutesAgo });

    const { data: rows, error } = await admin.rpc('ops_dashboard_snapshot');
    expect(error, `RPC error: ${error?.message}`).toBeNull();
    const row = await findSnapshotRow(rows, sessionId);
    // staleScannerId's last scan is 20 minutes ago (stale); freshScannerId's
    // last scan is 5 minutes ago (not stale) -- exactly one of the two
    // assigned scanners should be counted stale.
    expect(row.scanner_count).toBe(2);
    expect(row.stale_scanner_count).toBe(1);
  });

  it('does not flag a room-scoped scanner stale if it recently scanned a DIFFERENT session in the same room [bonus coverage of the room-vs-session scoping fix, not itself a spec req]', async () => {
    const roomId = await seedRoom('room-scoping');
    const { sessionId: sessionA } = await seedSession('room-scoping-a', { room_id: roomId });
    // Same room, back-to-back slot (not overlapping sessionA's 09:00-10:00) --
    // sessions_room_no_overlap forbids two sessions sharing a room at the same time.
    const { sessionId: sessionB } = await seedSession('room-scoping-b', {
      room_id: roomId,
      start_time: `${DAY}T10:00:00+03:00`,
      end_time: `${DAY}T11:00:00+03:00`,
    });
    const scannerId = await seedScannerUser('room-scoping');
    // Room-scoped only -- matches both sessionA and sessionB via room_id.
    await seedScannerAssignment(scannerId, { roomId });

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    await seedScanAttempt(sessionA, scannerId, 'invalid_qr', { created_at: fiveMinutesAgo, finalized_at: fiveMinutesAgo });

    const { data: rows, error } = await admin.rpc('ops_dashboard_snapshot');
    expect(error, `RPC error: ${error?.message}`).toBeNull();
    const rowB = await findSnapshotRow(rows, sessionB);
    expect(rowB.scanner_count).toBe(1);
    expect(rowB.stale_scanner_count).toBe(0);
  });

  it('rejection_count_30m and rejection_breakdown exclude admitted-flavored results and age out scans older than 30 minutes [spec req 4]', async () => {
    const { sessionId } = await seedSession('rejection-window');
    const scannerId = await seedScannerUser('rejection-window');

    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const fortyMinutesAgo = new Date(Date.now() - 40 * 60_000).toISOString();
    await seedScanAttempt(sessionId, scannerId, 'admitted', { created_at: tenMinutesAgo, finalized_at: tenMinutesAgo }); // excluded: admitted-flavored
    await seedScanAttempt(sessionId, scannerId, 'invalid_qr', { created_at: tenMinutesAgo, finalized_at: tenMinutesAgo }); // counted: within window, rejection-flavored
    await seedScanAttempt(sessionId, scannerId, 'duplicate', { created_at: fortyMinutesAgo, finalized_at: fortyMinutesAgo }); // excluded: aged out (older than 30 minutes)

    const { data: rows, error } = await admin.rpc('ops_dashboard_snapshot');
    expect(error, `RPC error: ${error?.message}`).toBeNull();
    const row = await findSnapshotRow(rows, sessionId);
    expect(row.rejection_count_30m).toBe(1);
    expect(row.rejection_breakdown).toEqual({ invalid_qr: 1 });
  });

  it('rejects a non-staff caller with Not authorized [spec req 5]', async () => {
    const { client: participantClient } = await seedAcceptedApplicant('non-staff-caller');

    const { error } = await participantClient.rpc('ops_dashboard_snapshot');
    expect(error).not.toBeNull();
    expect(error?.message).toContain('Not authorized');
  });

  it('rejects a genuinely unauthenticated (anon key, no signed-in user) caller [spec req 5]', async () => {
    // Distinct from the test above: that one uses a signed-in participant,
    // where current_user_role() returns a real non-staff role and
    // is_staff() correctly returns false. An anon-key client with NO
    // signed-in user is a different case -- auth.uid() is null, so
    // current_user_role()'s profiles lookup returns no row, and
    // is_staff() returns NULL (not false). A bare `if not is_staff()`
    // treats NULL as falsy and silently skips the check entirely,
    // which is exactly the bug this test guards against (found during
    // final branch review; fixed via coalesce(is_staff(), false) plus
    // revoking the function's default PUBLIC execute grant).
    const anonClient = createClient<Database>(URL, ANON_KEY);
    const { error } = await anonClient.rpc('ops_dashboard_snapshot');
    expect(error).not.toBeNull();
  });

  it('inserting attendance_records/scan_attempts rows does not error (broadcast trigger does not break normal writes) [spec req 6]', async () => {
    const { sessionId } = await seedSession('trigger-regression');
    const { applicationId, applicantId } = await seedAcceptedApplicant('trigger-regression');
    const bookingId = await directBooking(applicationId, sessionId);

    const { error: attendanceError } = await admin.from('attendance_records').insert({
      application_id: applicationId,
      session_id: sessionId,
      time_slot_group_key: `ops-dashboard-trigger-regression-${sessionId}`,
      status: 'admitted',
      entry_type: 'flexible',
      scanned_by: applicantId,
      booking_id: bookingId,
    });
    expect(attendanceError, `attendance_records insert error: ${attendanceError?.message}`).toBeNull();

    const { error: scanError } = await admin.from('scan_attempts').insert({
      session_id: sessionId,
      scanned_by: applicantId,
      result: 'flexible_admitted',
      finalized_at: new Date().toISOString(),
    });
    expect(scanError, `scan_attempts insert error: ${scanError?.message}`).toBeNull();
  });

  it(
    'an anon-key client with no signed-in user cannot subscribe to the ops-dashboard-events broadcast channel [security regression]',
    async () => {
      // NOT deferred to manual verification like the happy-path delivery
      // test this file's header comment describes (spec Testing
      // Requirement 7) -- this is a different kind of test: it guards a
      // security boundary that was found live-exploitable during final
      // branch review, not the Realtime delivery mechanism itself.
      // Found: notify_ops_dashboard() originally sent with private=false,
      // which means Realtime never consults the realtime.messages RLS
      // policy at all for this channel (that check only applies to
      // private channels) -- so a correctly-written, staff-scoped policy
      // was silently never enforced, and any anon-key client with no
      // signed-in user could subscribe and receive every broadcast.
      // Fixed by sending with private=true (trigger side) and
      // subscribing with { config: { private: true } } (client side) --
      // both ends must agree, or Realtime treats the channel as public.
      const { sessionId } = await seedSession('private-channel-anon');
      const scannerId = await seedScannerUser('private-channel-anon');

      const anonClient = createClient<Database>(URL, ANON_KEY);
      let anonReceived = false;
      const anonChannel = anonClient.channel('ops-dashboard-events', { config: { private: true } });
      anonChannel.on('broadcast', { event: 'change' }, () => {
        anonReceived = true;
      });

      // RLS on a private channel rejects the subscription itself at the
      // Realtime/websocket layer (observed live as CHANNEL_ERROR, not a
      // success status) -- not just individual broadcast messages. The
      // callback's exact status enum isn't asserted directly here since
      // what actually matters, and what this test checks below, is that
      // no broadcast payload ever reaches this client regardless of
      // which non-SUBSCRIBED status Realtime reports.
      anonChannel.subscribe();

      await new Promise((r) => setTimeout(r, 1500));
      await seedScanAttempt(sessionId, scannerId, 'invalid_qr', {
        created_at: new Date().toISOString(),
        finalized_at: new Date().toISOString(),
      });
      await new Promise((r) => setTimeout(r, 2000));

      expect(anonReceived).toBe(false);
      await anonClient.removeChannel(anonChannel);
    },
    15000
  );
});
