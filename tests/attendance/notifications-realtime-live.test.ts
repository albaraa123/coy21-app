// tests/attendance/notifications-realtime-live.test.ts
//
// Sub-project 6, Task 2: confirms the broadcast-via-trigger fires without
// error for both personal and broadcast inserts (an AFTER INSERT trigger
// that raised would roll back the whole insert, so a successful insert is
// itself evidence the trigger ran cleanly). Does NOT assert on actual
// WebSocket delivery -- no such test infrastructure exists in this repo
// for the identical 5a pattern either; client-side delivery is verified
// manually/via the bell's own behavior in Task 7.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

vi.setConfig({ testTimeout: 30000 });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const notificationIds: string[] = [];

afterAll(async () => {
  await admin.from('notifications').delete().in('id', notificationIds);
  await admin.from('applications').delete().in('id', applicationIds);
  await Promise.allSettled(applicantUserIds.map((id) => admin.auth.admin.deleteUser(id)));
});

describe('notifications realtime broadcast trigger', () => {
  it('a personal-row insert succeeds without the trigger raising', async () => {
    const { data: user } = await admin.auth.admin.createUser({
      email: `notif-realtime-${runId}-personal@test.local`, password: 'password123', email_confirm: true,
    });
    applicantUserIds.push(user!.user!.id);
    const { data: app } = await admin.from('applications').insert({ applicant_id: user!.user!.id, status: 'accepted' }).select('id').single();
    applicationIds.push(app!.id);

    const { data, error } = await admin.from('notifications').insert({
      is_broadcast: false, application_id: app!.id, channel: 'booking_confirmed', title: 'Trigger test',
    } as never).select('id').single();
    expect(error).toBeNull();
    notificationIds.push((data as { id: string }).id);
  });

  it('a broadcast-row insert succeeds without the trigger raising', async () => {
    const { data, error } = await admin.from('notifications').insert({
      is_broadcast: true, application_id: null, channel: 'announcement', title: 'Broadcast trigger test',
    } as never).select('id').single();
    expect(error).toBeNull();
    notificationIds.push((data as { id: string }).id);
  });
});
