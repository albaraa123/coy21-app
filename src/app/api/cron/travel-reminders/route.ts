// src/app/api/cron/travel-reminders/route.ts
//
// COY21 §11 — finds accepted participants who have NOT yet submitted any
// travel legs and inserts a `travel_reminder` row into `notifications` via
// the create_notification RPC for each. The actual email send is now
// dispatched by the unified process-notifications cron (Sub-project 6,
// Task 6) -- this route's own job is only to identify WHO needs reminding,
// not to send mail itself. No-travel-legs-row query and the 2026-11-05
// event-start cutoff are UNCHANGED from before Task 6; only the dispatch
// mechanism changed (direct sendEmailGuarded call -> create_notification
// RPC), still batched 10-at-a-time via Promise.all.
//
// Run once daily (e.g. 09:00 UTC). Stops running automatically after the
// COY21 event start date — add an early-exit guard for that below.
//
// Invoke via:
//   GET /api/cron/travel-reminders
//   Authorization: Bearer <CRON_SECRET>

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

// COY21 event start — stop sending reminders from this date onward.
const EVENT_START = new Date('2026-11-05T00:00:00Z');

function isAuthorizedCronRequest(req: NextRequest, cronSecret: string): boolean {
  const authHeader = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${cronSecret}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  // Auth guard — fail closed if CRON_SECRET isn't configured.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!isAuthorizedCronRequest(req, cronSecret)) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  // Don't spam after the event starts
  if (new Date() >= EVENT_START) {
    return NextResponse.json({ skipped: true, reason: 'Event already started' });
  }

  const service = createServiceRoleClient();

  // Find all accepted application IDs that have at least one travel leg
  const { data: withTravel } = await service
    .from('travel_legs')
    .select('application_id');

  const withTravelIds = new Set((withTravel ?? []).map((r) => r.application_id));

  // All accepted participants (preferred_language carried through so the
  // notification row's title can be locale-aware, same as every other
  // create_notification caller in this sub-project).
  const { data: apps, error } = await service
    .from('applications')
    .select('id, preferred_language, profiles!applications_applicant_id_fkey(full_name, email)')
    .eq('status', 'accepted');

  if (error) {
    console.error('travel-reminders: failed to fetch applications', error);
    return NextResponse.json({ error: 'Failed to fetch applications' }, { status: 500 });
  }

  let sent = 0;
  let failed = 0;

  const recipients = (apps ?? []).flatMap((app) => {
    if (withTravelIds.has(app.id)) return []; // already submitted
    const profile = Array.isArray(app.profiles) ? app.profiles[0] : app.profiles;
    if (!profile?.email || !profile?.full_name) return [];
    const locale = (app.preferred_language as 'ar' | 'en') ?? 'en';
    return [{ applicationId: app.id, locale }];
  });

  // Sent in concurrency-limited batches rather than one at a time: a fully
  // serial loop over every accepted-but-travel-less participant can exceed
  // the serverless function's execution timeout on a large participant
  // list, silently truncating the reminder run partway through. Now
  // batching create_notification RPC calls instead of email sends --
  // functionally equivalent concurrency shape, same BATCH_SIZE.
  const BATCH_SIZE = 10;
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((recipient) => createTravelReminderNotification(service, recipient)));
    for (const ok of results) {
      if (ok) sent++;
      else failed++;
    }
  }

  return NextResponse.json({ sent, failed });
}

async function createTravelReminderNotification(
  service: ServiceClient,
  recipient: { applicationId: string; locale: 'ar' | 'en' }
): Promise<boolean> {
  const title = recipient.locale === 'ar'
    ? 'مطلوب إجراء: يرجى تقديم تفاصيل رحلتك لـ COY21'
    : 'Action required: submit your travel details for COY21';
  const body = recipient.locale === 'ar'
    ? 'لم نستلم تفاصيل رحلتك بعد. يرجى تسجيل الدخول وتقديم معلومات رحلتك الجوية حتى يتمكن فريق اللوجستيات من التخطيط لاستقبالك في المطار.'
    : 'We haven\'t received your travel details yet. Please log in and submit your flight information so our logistics team can plan airport reception.';

  const { error } = await service.rpc('create_notification' as never, {
    p_application_id: recipient.applicationId,
    p_channel: 'travel_reminder',
    p_title: title,
    p_body: body,
    p_link_path: '/my-travel',
  } as never);

  if (error) {
    console.error('travel-reminders: create_notification failed', { applicationId: recipient.applicationId, error });
  }

  return !error;
}
