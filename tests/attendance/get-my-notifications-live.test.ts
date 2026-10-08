// tests/attendance/get-my-notifications-live.test.ts
//
// Sub-project 6, Task 7 Step 3a: live test for the get_my_notifications()
// RPC (supabase/migrations/20261008080000_get_my_notifications_rpc.sql).
//
// Placement: this RPC is DB-layer, not component-layer -- following this
// codebase's established split, live DB-hitting tests live under
// tests/attendance/ (see tests/attendance/notification-rpcs-live.test.ts
// for Task 1's create_notification/create_announcement/
// mark_notification_read RPC tests, and
// tests/attendance/create-announcement-page-live.test.ts for Task 5's
// Server Action test), while src/components/shell/notification-bell.test.ts
// stays co-located but pure-logic-only (no Supabase client, per that
// file's own header comment -- it can't import notification-bell.tsx
// itself under plain node/vitest, let alone open a live DB connection).
//
// get_my_notifications() is SECURITY DEFINER but still resolves the
// caller via auth.uid() internally (see the migration's v_application_id
// lookup) -- so, exactly like create_announcement's and
// mark_notification_read's own live tests, this must go through a real
// signed-in anon-key client via signInWithPassword, never the
// service-role client (which has no auth.uid() of its own and would
// either get an unrelated error or silently resolve to no row).
//
// Setup here inserts notifications rows directly via the admin
// (service-role) client rather than going through create_notification/
// create_announcement -- this is a READ rpc under test, not a WRITE one,
// so fixture rows only need to exist in the right shape; exercising the
// writer RPCs too would just add unrelated failure surface to a test
// that's specifically about get_my_notifications()'s own merge/order/
// read-state logic.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

// Live round trips to the real Supabase project routinely exceed Vitest's
// 5000ms default in this codebase -- same established fix as
// tests/attendance/notification-rpcs-live.test.ts and
// tests/attendance/create-announcement-page-live.test.ts.
vi.setConfig({ testTimeout: 30000 });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
if (!URL || !SERVICE_KEY || !ANON_KEY) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set to run this live test');
}
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const userIds: string[] = [];
const applicationIds: string[] = [];
const notificationIds: string[] = [];

async function createParticipantCaller(emailSlug: string) {
  const email = `get-my-notifs-live-${runId}-${emailSlug}@test.local`;
  const { data: user, error } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  if (error || !user.user) throw new Error(`Failed to create ${emailSlug}: ${error?.message}`);
  userIds.push(user.user.id);

  const { data: app, error: appError } = await admin
    .from('applications').insert({ applicant_id: user.user.id, status: 'accepted' }).select('id').single();
  if (appError || !app) throw new Error(`Failed to create application for ${emailSlug}: ${appError?.message}`);
  applicationIds.push(app.id);

  const session = createClient<Database>(URL, ANON_KEY);
  const { error: signInError } = await session.auth.signInWithPassword({ email, password: 'password123' });
  if (signInError) throw new Error(`Participant sign-in failed: ${signInError.message}`);

  return { userId: user.user.id, applicationId: app.id as string, session };
}

async function createCallerWithNoApplication(emailSlug: string) {
  const email = `get-my-notifs-live-${runId}-${emailSlug}@test.local`;
  const { data: user, error } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  if (error || !user.user) throw new Error(`Failed to create ${emailSlug}: ${error?.message}`);
  userIds.push(user.user.id);

  const session = createClient<Database>(URL, ANON_KEY);
  const { error: signInError } = await session.auth.signInWithPassword({ email, password: 'password123' });
  if (signInError) throw new Error(`Sign-in failed: ${signInError.message}`);

  return { userId: user.user.id, session };
}

afterAll(async () => {
  await admin.from('notification_broadcast_reads').delete().in('notification_id', notificationIds);
  await admin.from('notifications').delete().in('id', notificationIds);
  await admin.from('applications').delete().in('id', applicationIds);
  await Promise.allSettled(userIds.map((id) => admin.auth.admin.deleteUser(id)));
});

describe('get_my_notifications', () => {
  it('returns exactly the caller\'s personal rows + all broadcast rows, each with correct is_read, ordered by created_at desc', async () => {
    const caller = await createParticipantCaller('merge-order');

    // Deliberately insert out of created_at order, to prove the RPC's
    // own `order by created_at desc` -- not insertion order -- governs
    // the result.
    const t0 = new Date(Date.now() - 3 * 60_000).toISOString(); // oldest
    const t1 = new Date(Date.now() - 2 * 60_000).toISOString();
    const t2 = new Date(Date.now() - 1 * 60_000).toISOString();
    const t3 = new Date().toISOString(); // newest

    const { data: personalRead } = await admin.from('notifications').insert({
      is_broadcast: false, application_id: caller.applicationId, channel: 'booking_confirmed',
      title: 'Personal read', created_at: t0, read_at: t0,
    } as never).select('id').single();
    const { data: personalUnread } = await admin.from('notifications').insert({
      is_broadcast: false, application_id: caller.applicationId, channel: 'booking_confirmed',
      title: 'Personal unread', created_at: t3,
    } as never).select('id').single();
    const { data: broadcastReadByCaller } = await admin.from('notifications').insert({
      is_broadcast: true, application_id: null, channel: 'announcement',
      title: 'Broadcast read by caller', created_at: t1,
    } as never).select('id').single();
    const { data: broadcastUnread } = await admin.from('notifications').insert({
      is_broadcast: true, application_id: null, channel: 'announcement',
      title: 'Broadcast unread', created_at: t2,
    } as never).select('id').single();

    const ids = {
      personalRead: (personalRead as { id: string }).id,
      personalUnread: (personalUnread as { id: string }).id,
      broadcastReadByCaller: (broadcastReadByCaller as { id: string }).id,
      broadcastUnread: (broadcastUnread as { id: string }).id,
    };
    notificationIds.push(ids.personalRead, ids.personalUnread, ids.broadcastReadByCaller, ids.broadcastUnread);

    // Mark the broadcast row read BY THIS CALLER specifically -- the read
    // state is per-reader for broadcasts, resolved via
    // notification_broadcast_reads, not a shared read_at on the row.
    const { error: readInsertError } = await admin.from('notification_broadcast_reads').insert({
      notification_id: ids.broadcastReadByCaller, application_id: caller.applicationId,
    } as never);
    expect(readInsertError).toBeNull();

    // A second, unrelated participant's personal notification must NOT
    // leak into the caller's feed -- this is the one fixture row in this
    // test with no expectation of appearing in the result below.
    const other = await createParticipantCaller('merge-order-other');
    const { data: otherPersonal } = await admin.from('notifications').insert({
      is_broadcast: false, application_id: other.applicationId, channel: 'booking_confirmed',
      title: 'Someone else\'s personal notification', created_at: t3,
    } as never).select('id').single();
    notificationIds.push((otherPersonal as { id: string }).id);

    const { data, error } = await caller.session.rpc('get_my_notifications');
    expect(error).toBeNull();

    type Row = { id: string; is_broadcast: boolean; title: string; created_at: string; is_read: boolean };
    const rows = (data ?? []) as unknown as Row[];

    // The other participant's personal notification must never appear in
    // this caller's feed -- personal rows are scoped by application_id,
    // unlike broadcasts.
    const resultIds = rows.map((r) => r.id);
    expect(resultIds).not.toContain((otherPersonal as { id: string }).id);

    // Exactly this test's own 4 fixture rows must all be present. Note:
    // this test does NOT assert the full result set contains ONLY these 4
    // rows -- broadcast rows are global (not scoped to one applicant), and
    // this suite's other live test files (e.g.
    // notification-rpcs-live.test.ts, create-announcement-page-live.test.ts)
    // may insert their own broadcast rows concurrently against the same
    // live DB. Asserting a closed universe of broadcasts would make this
    // test flaky under concurrent test-file execution; asserting "my 4
    // rows are in there, correctly shaped, and the other participant's
    // personal row is not" exercises the RPC's merge/read-state logic
    // just as precisely without that hazard.
    const myRows = rows.filter((r) => (Object.values(ids) as string[]).includes(r.id));
    expect(myRows).toHaveLength(4);

    const byId = new Map(myRows.map((r) => [r.id, r]));
    expect(byId.get(ids.personalRead)?.is_read).toBe(true);
    expect(byId.get(ids.personalUnread)?.is_read).toBe(false);
    expect(byId.get(ids.broadcastReadByCaller)?.is_read).toBe(true);
    expect(byId.get(ids.broadcastUnread)?.is_read).toBe(false);

    // created_at desc among this test's own rows, regardless of whatever
    // else got interleaved: newest (personalUnread, t3) first, oldest
    // (personalRead, t0) last.
    const myOrderedIds = rows.filter((r) => (Object.values(ids) as string[]).includes(r.id)).map((r) => r.id);
    expect(myOrderedIds).toEqual([ids.personalUnread, ids.broadcastUnread, ids.broadcastReadByCaller, ids.personalRead]);
  });

  it('a caller with no applications row is rejected with Not authorized', async () => {
    const caller = await createCallerWithNoApplication('no-application');

    const { error } = await caller.session.rpc('get_my_notifications');
    expect(error).not.toBeNull();
    // Pin this to the RPC's own authorization check specifically, not
    // just "some error occurred" -- same rigor as
    // tests/attendance/notification-rpcs-live.test.ts's
    // mark_notification_read rejection test. Without this, an unrelated
    // failure (bad grant, typo'd RPC name, transient network error, a
    // PostgREST 404) could pass this test by accident.
    expect(error!.message).toContain('Not authorized');
  });
});
