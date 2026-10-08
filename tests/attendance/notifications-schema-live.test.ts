// tests/attendance/notifications-schema-live.test.ts
//
// Sub-project 6 (notifications layer), Task 0: live schema/constraint/RLS
// tests for the new notifications + notification_broadcast_reads tables.
// Follows this codebase's established live-test convention: real Supabase
// Auth users, runId-suffixed fixture identifiers (per this project's own
// documented fixture-leak issue), service-role admin client for setup,
// anon/authenticated clients for RLS assertions.
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

async function createApplicant(label: string) {
  const { data: user, error } = await admin.auth.admin.createUser({
    email: `notif-schema-${runId}-${label}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (error || !user.user) throw new Error(`Failed to create ${label}: ${error?.message}`);
  applicantUserIds.push(user.user.id);
  const { data: app, error: appError } = await admin
    .from('applications')
    .insert({ applicant_id: user.user.id, status: 'accepted' })
    .select('id')
    .single();
  if (appError || !app) throw new Error(`Failed to create application for ${label}: ${appError?.message}`);
  applicationIds.push(app.id);
  return { userId: user.user.id, applicationId: app.id };
}

afterAll(async () => {
  await admin.from('notification_broadcast_reads').delete().in('notification_id', notificationIds);
  await admin.from('notifications').delete().in('id', notificationIds);
  await admin.from('applications').delete().in('id', applicationIds);
  await Promise.allSettled(applicantUserIds.map((id) => admin.auth.admin.deleteUser(id)));
});

describe('notifications table — schema, constraint, RLS', () => {
  it('rejects a broadcast row with a non-null application_id', async () => {
    const { applicationId } = await createApplicant('constraint-a');
    const { error } = await admin.from('notifications').insert({
      is_broadcast: true,
      application_id: applicationId,
      channel: 'announcement',
      title: 'Test',
    } as never);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/notifications_broadcast_application_id_check/);
  });

  it('rejects a non-broadcast row with a null application_id', async () => {
    const { error } = await admin.from('notifications').insert({
      is_broadcast: false,
      application_id: null,
      channel: 'booking_confirmed',
      title: 'Test',
    } as never);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/notifications_broadcast_application_id_check/);
  });

  it('a participant cannot select another participant\'s personal notification row', async () => {
    const { applicationId: appA } = await createApplicant('rls-a');
    const { userId: userB } = await createApplicant('rls-b');

    const { data: row } = await admin
      .from('notifications')
      .insert({ is_broadcast: false, application_id: appA, channel: 'booking_confirmed', title: 'A\'s notification' } as never)
      .select('id')
      .single();
    notificationIds.push((row as { id: string }).id);

    const clientB = createClient<Database>(URL, ANON_KEY);
    await clientB.auth.signInWithPassword({ email: `notif-schema-${runId}-rls-b@test.local`, password: 'password123' });
    const { data: seenByB } = await clientB.from('notifications').select('id').eq('id', (row as { id: string }).id);
    expect(seenByB).toHaveLength(0);
    void userB;
  });

  it('every authenticated participant can select a broadcast row', async () => {
    const { userId } = await createApplicant('rls-broadcast');
    const { data: row } = await admin
      .from('notifications')
      .insert({ is_broadcast: true, application_id: null, channel: 'announcement', title: 'Broadcast test' } as never)
      .select('id')
      .single();
    notificationIds.push((row as { id: string }).id);

    const client = createClient<Database>(URL, ANON_KEY);
    await client.auth.signInWithPassword({ email: `notif-schema-${runId}-rls-broadcast@test.local`, password: 'password123' });
    const { data: seen } = await client.from('notifications').select('id').eq('id', (row as { id: string }).id);
    expect(seen).toHaveLength(1);
    void userId;
  });

  it('a direct client-side insert is rejected (no insert policy; GRANT-level lockout)', async () => {
    const { userId, applicationId } = await createApplicant('no-direct-insert');
    const client = createClient<Database>(URL, ANON_KEY);
    await client.auth.signInWithPassword({ email: `notif-schema-${runId}-no-direct-insert@test.local`, password: 'password123' });
    const { error } = await client.from('notifications').insert({
      is_broadcast: false, application_id: applicationId, channel: 'booking_confirmed', title: 'Should fail',
    } as never);
    expect(error).not.toBeNull();
    void userId;
  });
});
