// tests/attendance/create-announcement-page-live.test.ts
//
// Sub-project 6, Task 5: live coverage for the admin announcement
// composer's Server Action (src/app/[locale]/(admin)/announcements/actions.ts).
//
// Uses the `...ForCaller` injected-caller pattern this codebase already
// establishes for live-testability without a real Next.js request context
// (see updateApplicationStatusForCaller in
// src/app/[locale]/(admin)/applications/[id]/actions.ts and its own live
// test, tests/attendance/application-decision-notification-live.test.ts).
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { createAnnouncementForCaller } from '@/app/[locale]/(admin)/announcements/actions';

// Live round trips to the real Supabase project routinely exceed Vitest's
// 5000ms default in this codebase -- same established fix as
// tests/attendance/notification-rpcs-live.test.ts and
// tests/attendance/application-decision-notification-live.test.ts.
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
const notificationIds: string[] = [];

// create_announcement is SECURITY DEFINER and derives the caller from
// auth.uid() via coalesce(is_staff(), false), with no service_role
// carve-out (supabase/migrations/20261008020000_notification_writer_rpcs.sql).
// `session` must therefore be a real signed-in anon-key client, not the
// service-role client -- same pattern as
// tests/participants/classification-controls-live.test.ts's createStaffFixture.
async function createStaffCaller(emailSlug: string) {
  const email = `create-announcement-live-${runId}-${emailSlug}@test.local`;
  const { data: user, error } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  if (error || !user.user) throw new Error(`Failed to create ${emailSlug}: ${error?.message}`);
  userIds.push(user.user.id);
  const { error: roleError } = await admin.from('profiles').update({ role: 'staff' }).eq('id', user.user.id);
  if (roleError) throw new Error(`Failed to set staff role for ${emailSlug}: ${roleError.message}`);

  const session = createClient<Database>(URL, ANON_KEY);
  const { error: signInError } = await session.auth.signInWithPassword({ email, password: 'password123' });
  if (signInError) throw new Error(`Staff sign-in failed: ${signInError.message}`);

  return { userId: user.user.id, session, service: admin };
}

async function createNonStaffCaller(emailSlug: string) {
  const email = `create-announcement-live-${runId}-${emailSlug}@test.local`;
  const { data: user, error } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  if (error || !user.user) throw new Error(`Failed to create ${emailSlug}: ${error?.message}`);
  userIds.push(user.user.id);

  const session = createClient<Database>(URL, ANON_KEY);
  const { error: signInError } = await session.auth.signInWithPassword({ email, password: 'password123' });
  if (signInError) throw new Error(`Non-staff sign-in failed: ${signInError.message}`);

  return { userId: user.user.id, session, service: admin };
}

afterAll(async () => {
  await admin.from('notifications').delete().in('id', notificationIds);
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
});

describe('createAnnouncementForCaller', () => {
  it('a staff caller succeeds and creates exactly one is_broadcast=true row', async () => {
    const caller = await createStaffCaller('staff');

    const result = await createAnnouncementForCaller('Welcome!', 'See you soon', caller);
    expect(result.id).toBeTruthy();
    notificationIds.push(result.id);

    const { data: rows } = await admin
      .from('notifications')
      .select('id, is_broadcast, application_id, channel, title, body')
      .eq('id', result.id);
    const notifs = rows ?? [];
    expect(notifs).toHaveLength(1);
    expect(notifs[0].is_broadcast).toBe(true);
    expect(notifs[0].application_id).toBeNull();
    expect(notifs[0].channel).toBe('announcement');
    expect(notifs[0].title).toBe('Welcome!');
    expect(notifs[0].body).toBe('See you soon');
  });

  it('a non-staff caller is rejected', async () => {
    const caller = await createNonStaffCaller('non-staff');

    await expect(createAnnouncementForCaller('Should fail', undefined, caller)).rejects.toThrow();

    const { data: rows } = await admin
      .from('notifications')
      .select('id')
      .eq('title', 'Should fail');
    for (const r of rows ?? []) notificationIds.push(r.id);
    expect(rows ?? []).toHaveLength(0);
  });

  it('a whitespace-only title is rejected before the RPC call, not inserted as a blank row', async () => {
    const caller = await createStaffCaller('whitespace-title');

    await expect(createAnnouncementForCaller('   ', undefined, caller)).rejects.toThrow('Title is required');

    // Confirm this was rejected client-side (before any session.rpc(...)
    // call), not by the RPC after an insert attempt -- a whitespace-only
    // title has no unique marker to filter by, so instead confirm no
    // all-whitespace-titled row exists anywhere in the table at all,
    // which would only be possible if the guard above had been bypassed.
    const { data: rows } = await admin
      .from('notifications')
      .select('id, title')
      .eq('channel', 'announcement');
    const whitespaceOnlyRows = (rows ?? []).filter((r) => r.title.trim() === '');
    expect(whitespaceOnlyRows).toHaveLength(0);
  });
});
