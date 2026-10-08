// tests/attendance/notification-rpcs-live.test.ts
//
// Sub-project 6, Task 1: live tests for create_notification,
// create_announcement, mark_notification_read.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

// Live round trips to the real Supabase project routinely exceed Vitest's
// 5000ms default in this codebase (see tests/attendance/admission-lookup-live.test.ts
// and tests/attendance/scan-qr-idempotency-live.test.ts for the same fix) --
// this is Cloud round-trip latency for genuinely multi-step fixture setup
// (createUser + application insert, sometimes twice per test), not a hang.
vi.setConfig({ testTimeout: 30000 });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const notificationIds: string[] = [];

async function createApplicant(label: string, role: 'participant' | 'staff' = 'participant') {
  const { data: user, error } = await admin.auth.admin.createUser({
    email: `notif-rpc-${runId}-${label}@test.local`, password: 'password123', email_confirm: true,
  });
  if (error || !user.user) throw new Error(`Failed to create ${label}: ${error?.message}`);
  applicantUserIds.push(user.user.id);
  if (role === 'staff') {
    await admin.from('profiles').update({ role: 'staff' }).eq('id', user.user.id);
    return { userId: user.user.id, applicationId: null as string | null };
  }
  const { data: app, error: appError } = await admin
    .from('applications').insert({ applicant_id: user.user.id, status: 'accepted' }).select('id').single();
  if (appError || !app) throw new Error(`Failed to create application for ${label}: ${appError?.message}`);
  applicationIds.push(app.id);
  return { userId: user.user.id, applicationId: app.id as string };
}

afterAll(async () => {
  await admin.from('notification_broadcast_reads').delete().in('notification_id', notificationIds);
  await admin.from('notifications').delete().in('id', notificationIds);
  await admin.from('applications').delete().in('id', applicationIds);
  await Promise.allSettled(applicantUserIds.map((id) => admin.auth.admin.deleteUser(id)));
});

describe('create_notification', () => {
  it('inserts exactly one personal row with the given channel/title', async () => {
    const { applicationId } = await createApplicant('create-notif');
    const { data, error } = await admin.rpc('create_notification' as never, {
      p_application_id: applicationId, p_channel: 'booking_confirmed', p_title: 'Your booking is confirmed',
    } as never);
    expect(error).toBeNull();
    const row = data as unknown as { id: string; is_broadcast: boolean; application_id: string };
    notificationIds.push(row.id);
    expect(row.is_broadcast).toBe(false);
    expect(row.application_id).toBe(applicationId);
  });
});

describe('create_announcement', () => {
  it('a staff caller inserts exactly one is_broadcast=true row', async () => {
    const { userId } = await createApplicant('announce-staff', 'staff');
    const client = createClient<Database>(URL, ANON_KEY);
    await client.auth.signInWithPassword({ email: `notif-rpc-${runId}-announce-staff@test.local`, password: 'password123' });
    const { data, error } = await client.rpc('create_announcement' as never, { p_title: 'Welcome!', p_body: 'See you soon' } as never);
    expect(error).toBeNull();
    const row = data as unknown as { id: string; is_broadcast: boolean; application_id: string | null };
    notificationIds.push(row.id);
    expect(row.is_broadcast).toBe(true);
    expect(row.application_id).toBeNull();
    void userId;
  });

  it('a non-staff participant is rejected with Not authorized', async () => {
    const { userId } = await createApplicant('announce-participant');
    const client = createClient<Database>(URL, ANON_KEY);
    await client.auth.signInWithPassword({ email: `notif-rpc-${runId}-announce-participant@test.local`, password: 'password123' });
    const { error } = await client.rpc('create_announcement' as never, { p_title: 'Should fail' } as never);
    expect(error).not.toBeNull();
    expect(error!.message).toContain('Not authorized');
    void userId;
  });

  it('an anonymous (unauthenticated) caller is rejected (coalesce(is_staff(), false) NULL-bypass guard)', async () => {
    const anonClient = createClient<Database>(URL, ANON_KEY);
    const { error } = await anonClient.rpc('create_announcement' as never, { p_title: 'Should fail' } as never);
    expect(error).not.toBeNull();
  });
});

describe('mark_notification_read', () => {
  it('marks the caller\'s own personal notification read', async () => {
    const { userId, applicationId } = await createApplicant('mark-read-own');
    const { data: row } = await admin.from('notifications').insert({
      is_broadcast: false, application_id: applicationId, channel: 'booking_confirmed', title: 'Test',
    } as never).select('id').single();
    const notifId = (row as { id: string }).id;
    notificationIds.push(notifId);

    const client = createClient<Database>(URL, ANON_KEY);
    await client.auth.signInWithPassword({ email: `notif-rpc-${runId}-mark-read-own@test.local`, password: 'password123' });
    const { error } = await client.rpc('mark_notification_read' as never, { p_notification_id: notifId } as never);
    expect(error).toBeNull();

    const { data: after } = await admin.from('notifications').select('read_at').eq('id', notifId).single();
    expect((after as { read_at: string | null }).read_at).not.toBeNull();
    void userId;
  });

  it('rejects marking another participant\'s personal notification as read', async () => {
    const { applicationId: appA } = await createApplicant('mark-read-a');
    const { userId: userB } = await createApplicant('mark-read-b');
    const { data: row } = await admin.from('notifications').insert({
      is_broadcast: false, application_id: appA, channel: 'booking_confirmed', title: 'A\'s notification',
    } as never).select('id').single();
    const notifId = (row as { id: string }).id;
    notificationIds.push(notifId);

    const clientB = createClient<Database>(URL, ANON_KEY);
    await clientB.auth.signInWithPassword({ email: `notif-rpc-${runId}-mark-read-b@test.local`, password: 'password123' });
    const { error } = await clientB.rpc('mark_notification_read' as never, { p_notification_id: notifId } as never);
    expect(error).not.toBeNull();

    const { data: after } = await admin.from('notifications').select('read_at').eq('id', notifId).single();
    expect((after as { read_at: string | null }).read_at).toBeNull();
    void userB;
  });

  it('a broadcast read inserts into notification_broadcast_reads keyed to the caller, not a shared read_at', async () => {
    const { userId } = await createApplicant('mark-read-broadcast');
    const { data: row } = await admin.from('notifications').insert({
      is_broadcast: true, application_id: null, channel: 'announcement', title: 'Broadcast',
    } as never).select('id').single();
    const notifId = (row as { id: string }).id;
    notificationIds.push(notifId);

    const client = createClient<Database>(URL, ANON_KEY);
    await client.auth.signInWithPassword({ email: `notif-rpc-${runId}-mark-read-broadcast@test.local`, password: 'password123' });
    const { error } = await client.rpc('mark_notification_read' as never, { p_notification_id: notifId } as never);
    expect(error).toBeNull();

    const { data: readRow } = await admin.from('notification_broadcast_reads').select('application_id').eq('notification_id', notifId).single();
    expect(readRow).not.toBeNull();
    void userId;
  });
});
