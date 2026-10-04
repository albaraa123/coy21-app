// src/app/api/cron/process-session-notifications/route.ts
//
// Drains session_notification_outbox (written by the
// enforce_session_lifecycle_booking_sync trigger on `sessions`, added in
// 20261004010000_session_lifecycle_notifications.sql) and sends the actual
// cancellation/reschedule notification email for each pending row via the
// existing sendEmailGuarded infrastructure. Triggers cannot send HTTP
// requests, so this cron bridges the gap -- same reliability pattern as
// session-reminders/route.ts (stateless-per-row processing, no retry
// logic, accepted theoretical concurrent-overlap race at this
// low-frequency/small-blast-radius scale -- see
// docs/superpowers/specs/2026-10-01-session-cancellation-reschedule-design.md
// section 6 for the full rationale).
//
// Invoke every 5 minutes from any cron service, e.g.:
//   Vercel Cron:  vercel.json -> { "crons": [{ "path": "/api/cron/process-session-notifications", "schedule": "*/5 * * * *" }] }
//   External:     GET https://your-domain.com/api/cron/process-session-notifications
//                 with header  Authorization: Bearer <CRON_SECRET>
//
// SECURITY: guarded by CRON_SECRET env var, same as session-reminders/route.ts.

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { sendSessionCancellationNotificationEmail, sendSessionRescheduleNotificationEmail, sendWaitlistPromotionNotificationEmail } from '@/lib/email/resend';

// Rows are processed sequentially (2 reads + 1 email send + 1 write each),
// not in parallel, so this has to stay small enough that a full batch
// clears comfortably inside one serverless invocation's duration limit --
// unlike session-reminders/route.ts's time-window query (bounded by how
// many sessions start in a 10-minute slice), a single bulk session
// cancellation can fan out into one outbox row per active booking (see
// enforce_session_lifecycle_booking_sync() in
// 20261004010000_session_lifecycle_notifications.sql), so this route's
// per-run workload isn't inherently bounded the same way. If outbox
// backlogs start regularly exceeding this batch size between 5-minute
// ticks, that's the tripwire to revisit this value, parallelize the loop,
// or add an explicit `export const maxDuration` -- none of that is needed
// at today's expected volume, where falling behind by one tick just means
// the remaining pending rows get picked up next run (stateless, no
// duplicate-send risk either way).
const BATCH_SIZE = 25;

function isAuthorizedCronRequest(req: NextRequest, cronSecret: string): boolean {
  const authHeader = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${cronSecret}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!isAuthorizedCronRequest(req, cronSecret)) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  const service = createServiceRoleClient();

  // `as never` on 'session_notification_outbox': this table was added in
  // 20261004010000_session_lifecycle_notifications.sql and is not yet
  // reflected in the generated src/types/database.ts snapshot -- same
  // established workaround as src/lib/participants/reclassify.ts's
  // `regenerate_application_number` RPC call.
  const { data: rows, error: fetchErr } = await service
    .from('session_notification_outbox' as never)
    .select('id, application_id, session_id, notification_type, old_start_time, new_start_time')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchErr) {
    console.error('process-session-notifications: failed to fetch outbox rows', fetchErr);
    return NextResponse.json({ error: 'Failed to fetch outbox rows' }, { status: 500 });
  }
  if (!rows || rows.length === 0) {
    return NextResponse.json({ sent: 0, failed: 0, message: 'No pending notifications' });
  }

  let sent = 0;
  let failed = 0;

  for (const row of rows as unknown as Array<{
    id: string;
    application_id: string;
    session_id: string;
    notification_type: 'session_cancelled' | 'session_rescheduled' | 'waitlist_promoted';
    old_start_time: string | null;
    new_start_time: string | null;
  }>) {
    const { data: application } = await service
      .from('applications')
      .select('preferred_language, profiles!applications_applicant_id_fkey(full_name, email)')
      .eq('id', row.application_id)
      .single();

    const profile = Array.isArray(application?.profiles) ? application.profiles[0] : application?.profiles;
    const { data: session } = await service
      .from('sessions')
      .select('title_en, title_ar')
      .eq('id', row.session_id)
      .single();

    if (!profile?.email || !profile?.full_name || !session) {
      const missing = [!session && 'session', !profile?.email && 'profile.email', !profile?.full_name && 'profile.full_name'].filter(Boolean).join(', ');
      await service
        .from('session_notification_outbox' as never)
        .update({ status: 'failed', error_message: `Missing: ${missing}` } as never)
        .eq('id', row.id);
      failed++;
      continue;
    }

    const locale = (application?.preferred_language as 'ar' | 'en') ?? 'en';
    const sessionTitle = ((locale === 'ar' ? session.title_ar : session.title_en) || session.title_en || session.title_ar || 'Your session').trim() || 'Your session';

    let result: { id: string | null; error: string | null };
    if (row.notification_type === 'session_cancelled') {
      result = await sendSessionCancellationNotificationEmail({ to: profile.email, fullName: profile.full_name, sessionTitle, locale });
    } else if (row.notification_type === 'session_rescheduled') {
      result = await sendSessionRescheduleNotificationEmail({
        to: profile.email, fullName: profile.full_name, sessionTitle,
        oldStartTime: row.old_start_time!, newStartTime: row.new_start_time!, locale,
      });
    } else {
      result = await sendWaitlistPromotionNotificationEmail({ to: profile.email, fullName: profile.full_name, sessionTitle, locale });
    }

    if (result.error) {
      await service
        .from('session_notification_outbox' as never)
        .update({ status: 'failed', error_message: result.error } as never)
        .eq('id', row.id);
      failed++;
    } else {
      await service
        .from('session_notification_outbox' as never)
        .update({ status: 'sent', sent_at: new Date().toISOString() } as never)
        .eq('id', row.id);
      sent++;
    }
  }

  return NextResponse.json({ sent, failed, total: rows.length });
}
