// tests/attendance/application-decision-notification-live.test.ts
//
// Sub-project 6, Task 3: live coverage for updateApplicationStatusForCaller's
// new application_accepted/application_rejected notification dual-write
// (src/app/[locale]/(admin)/applications/[id]/actions.ts), added right
// after the optimistic-concurrency status-update success check and before
// the accepted-only accept_application_and_issue_number RPC call.
//
// Uses the `...ForCaller` injected-caller pattern this codebase already
// establishes for live-testability without a real Next.js request context
// (see tests/auth/accounts-actions-live.test.ts's identical use of
// createAccountsForSelectedForCaller, and this action file's own comment on
// updateApplicationStatusForCaller).
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { updateApplicationStatusForCaller } from '@/app/[locale]/(admin)/applications/[id]/actions';

// Live round trips to the real Supabase project routinely exceed Vitest's
// 5000ms default in this codebase -- same established fix as
// tests/attendance/notification-rpcs-live.test.ts.
vi.setConfig({ testTimeout: 30000 });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!URL || !SERVICE_KEY) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to run this live test');
}
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const notificationIds: string[] = [];
let staffId: string;

async function seedUnderReviewApplicant(emailSlug: string, preferredLanguage: 'en' | 'ar' = 'en') {
  const email = `app-decision-notif-live-${runId}-${emailSlug}@test.local`;
  const { data: user, error } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  if (error || !user.user) throw new Error(`Failed to create ${emailSlug}: ${error?.message}`);
  const applicantId = user.user.id;
  applicantUserIds.push(applicantId);

  const { data: app, error: appError } = await admin
    .from('applications')
    .insert({
      applicant_id: applicantId,
      status: 'under_review',
      preferred_language: preferredLanguage,
      experience_level: 'beginner',
      interests: [],
      participant_type: 'delegate',
    })
    .select('id')
    .single();
  if (appError || !app) throw new Error(`Failed to create application for ${emailSlug}: ${appError?.message}`);
  applicationIds.push(app.id);

  return app.id as string;
}

afterAll(async () => {
  await admin.from('notifications').delete().in('id', notificationIds);
  await admin.from('application_status_history').delete().in('application_id', applicationIds);
  await admin.from('applications').delete().in('id', applicationIds);
  for (const id of [...applicantUserIds, staffId].filter(Boolean)) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
});

describe('updateApplicationStatusForCaller dual-writes application_accepted/application_rejected notifications', () => {
  it('creates exactly one application_accepted notification with the correct application_id/link_path (en locale)', async () => {
    const applicationId = await seedUnderReviewApplicant('accept-en');
    const { data: staff } = await admin.auth.admin.createUser({ email: `app-decision-notif-live-${runId}-staff-accept@test.local`, password: 'password123', email_confirm: true });
    staffId = staff!.user!.id;

    const result = await updateApplicationStatusForCaller(applicationId, 'accepted', { userId: staffId, service: admin });
    expect(result.status).toBe('accepted');

    const { data: rows } = await admin
      .from('notifications')
      .select('id, application_id, channel, title, link_path, is_broadcast')
      .eq('application_id', applicationId)
      .eq('channel', 'application_accepted');
    const notifs = rows ?? [];
    for (const r of notifs) notificationIds.push(r.id);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].is_broadcast).toBe(false);
    expect(notifs[0].link_path).toBe('/my-dashboard');
    expect(notifs[0].title).toBe('Your application has been accepted!');
  });

  it('creates exactly one application_rejected notification with the correct application_id/link_path (en locale)', async () => {
    const applicationId = await seedUnderReviewApplicant('reject-en');
    const { data: staff } = await admin.auth.admin.createUser({ email: `app-decision-notif-live-${runId}-staff-reject@test.local`, password: 'password123', email_confirm: true });
    staffId = staff!.user!.id;

    const result = await updateApplicationStatusForCaller(applicationId, 'rejected', { userId: staffId, service: admin });
    expect(result.status).toBe('rejected');

    const { data: rows } = await admin
      .from('notifications')
      .select('id, application_id, channel, title, link_path, is_broadcast')
      .eq('application_id', applicationId)
      .eq('channel', 'application_rejected');
    const notifs = rows ?? [];
    for (const r of notifs) notificationIds.push(r.id);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].is_broadcast).toBe(false);
    expect(notifs[0].link_path).toBe('/my-application');
    expect(notifs[0].title).toBe('Update on your application');
  });

  it('uses the Arabic title for an applicant with preferred_language=ar (accepted)', async () => {
    const applicationId = await seedUnderReviewApplicant('accept-ar', 'ar');
    const { data: staff } = await admin.auth.admin.createUser({ email: `app-decision-notif-live-${runId}-staff-accept-ar@test.local`, password: 'password123', email_confirm: true });
    staffId = staff!.user!.id;

    const result = await updateApplicationStatusForCaller(applicationId, 'accepted', { userId: staffId, service: admin });
    expect(result.status).toBe('accepted');

    const { data: rows } = await admin
      .from('notifications')
      .select('id, title')
      .eq('application_id', applicationId)
      .eq('channel', 'application_accepted');
    const notifs = rows ?? [];
    for (const r of notifs) notificationIds.push(r.id);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].title).toBe('تم قبول طلبك!');
  });

  it('uses the Arabic title for an applicant with preferred_language=ar (rejected)', async () => {
    const applicationId = await seedUnderReviewApplicant('reject-ar', 'ar');
    const { data: staff } = await admin.auth.admin.createUser({ email: `app-decision-notif-live-${runId}-staff-reject-ar@test.local`, password: 'password123', email_confirm: true });
    staffId = staff!.user!.id;

    const result = await updateApplicationStatusForCaller(applicationId, 'rejected', { userId: staffId, service: admin });
    expect(result.status).toBe('rejected');

    const { data: rows } = await admin
      .from('notifications')
      .select('id, title')
      .eq('application_id', applicationId)
      .eq('channel', 'application_rejected');
    const notifs = rows ?? [];
    for (const r of notifs) notificationIds.push(r.id);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].title).toBe('تحديث بخصوص طلبك');
  });

  it('creates zero application_accepted/application_rejected notifications for an unrelated transition (under_review -> submitted)', async () => {
    const applicationId = await seedUnderReviewApplicant('other-transition');
    const { data: staff } = await admin.auth.admin.createUser({ email: `app-decision-notif-live-${runId}-staff-other@test.local`, password: 'password123', email_confirm: true });
    staffId = staff!.user!.id;

    const result = await updateApplicationStatusForCaller(applicationId, 'submitted', { userId: staffId, service: admin });
    expect(result.status).toBe('submitted');

    const { data: rows } = await admin
      .from('notifications')
      .select('id')
      .eq('application_id', applicationId)
      .in('channel', ['application_accepted', 'application_rejected']);
    for (const r of rows ?? []) notificationIds.push(r.id);
    expect(rows ?? []).toHaveLength(0);
  });
});
