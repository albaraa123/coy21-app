// src/app/api/cron/process-notifications/route.ts
//
// Sub-project 6, Task 6: unified email-dispatch cron, replacing
// process-session-notifications (left in place until its deletion
// precondition is verified live -- see Task 6 Step 6's explicit gate) and
// absorbing session-reminders'/travel-reminders' direct-send logic (both
// modified this task to insert `notifications` rows via the
// create_notification RPC instead of sending email directly).
// Runs every 1 minute (vercel.json). Same CRON_SECRET Bearer-token guard
// as every other cron in this codebase -- isAuthorizedCronRequest below is
// copied verbatim from process-session-notifications/route.ts.
//
// Drains the `notifications` table (20261008010000_notifications_table.sql)
// for rows with email_status = 'pending', dispatching the correct email
// function per `channel`. Personal (non-broadcast) rows are processed
// sequentially, matching process-session-notifications' existing
// concurrency model for that part. A broadcast row (channel =
// 'announcement') fans out to every currently-'accepted' application,
// queried fresh at send time -- NOT from any snapshot taken when
// create_announcement() inserted the row -- so an applicant whose status
// changes between creation and this cron running is correctly excluded.
// That recipient fan-out is batched (BROADCAST_BATCH_SIZE at a time,
// mirroring travel-reminders' existing Promise.all batching), but the
// broadcast notification row itself is still a single row, marked
// sent/failed once after the whole fan-out completes.
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';
import {
  sendSessionCancellationNotificationEmail,
  sendSessionRescheduleNotificationEmail,
  sendWaitlistPromotionNotificationEmail,
  sendApplicationAcceptedEmail,
  sendApplicationRejectedEmail,
  sendBookingConfirmedEmail,
  sendAnnouncementEmail,
  sendSessionReminderEmail,
  sendTravelReminderEmail,
} from '@/lib/email/resend';

const BATCH_SIZE = 25;
const BROADCAST_BATCH_SIZE = 10; // mirrors travel-reminders' existing batching

function isAuthorizedCronRequest(req: NextRequest, cronSecret: string): boolean {
  const authHeader = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${cronSecret}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type NotificationRow = {
  id: string;
  is_broadcast: boolean;
  application_id: string | null;
  channel: string;
  title: string;
  body: string | null;
  session_id: string | null;
  old_start_time: string | null;
  new_start_time: string | null;
};

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!isAuthorizedCronRequest(req, cronSecret)) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  const service = createServiceRoleClient();

  // `as never` on 'notifications': same established workaround used
  // throughout this sub-project (e.g. process-session-notifications/route.ts
  // for session_notification_outbox) for tables not yet reflected in the
  // generated src/types/database.ts snapshot at the time this route was
  // written.
  const { data: rows } = await service
    .from('notifications' as never)
    .select('*')
    .eq('email_status', 'pending')
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  let sent = 0;
  let failed = 0;

  for (const row of (rows ?? []) as unknown as NotificationRow[]) {
    const r = row;

    if (r.is_broadcast) {
      // Query recipients AT SEND TIME, not at create_announcement's
      // insert time -- an applicant whose status changes away from
      // 'accepted' in the narrow window between creation and this cron
      // running is correctly excluded (per the design spec's documented
      // lazy-evaluation decision). This is the ONE row that fans out to
      // many emails; still marked sent/failed as a single row afterward.
      const { data: recipients } = await service
        .from('applications')
        .select('id, preferred_language, profiles!applications_applicant_id_fkey(full_name, email)')
        .eq('status', 'accepted');

      let anyFailed = false;
      const list = (recipients ?? []) as unknown as Array<{
        preferred_language: string | null;
        profiles: { full_name: string | null; email: string | null } | { full_name: string | null; email: string | null }[] | null;
      }>;

      for (let i = 0; i < list.length; i += BROADCAST_BATCH_SIZE) {
        const batch = list.slice(i, i + BROADCAST_BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (recipient) => {
            const profile = Array.isArray(recipient.profiles) ? recipient.profiles[0] : recipient.profiles;
            if (!profile?.email) return false;
            const locale = (recipient.preferred_language as 'ar' | 'en') ?? 'en';
            const { error } = await sendAnnouncementEmail({
              to: profile.email,
              fullName: profile.full_name ?? '',
              title: r.title,
              body: r.body,
              locale,
            });
            return !error;
          })
        );
        if (results.some((ok) => !ok)) anyFailed = true;
      }

      await service
        .from('notifications' as never)
        .update({
          email_status: 'sent',
          sent_at: new Date().toISOString(),
          error_message: anyFailed ? 'One or more recipients failed; see send logs' : null,
        } as never)
        .eq('id', r.id);
      sent++;
      continue;
    }

    // Personal row -- sequential, matching process-session-notifications'
    // existing concurrency model for this part (not Promise.all; only the
    // broadcast fan-out above uses batched concurrency, intentionally two
    // different models in one route, per the plan's own research notes).
    // application_id is guaranteed non-null here by the table's own
    // notifications_broadcast_application_id_check constraint (any row
    // with is_broadcast = false must have a non-null application_id) --
    // the `!` reflects that DB-enforced invariant, not an unchecked
    // assumption.
    const { data: app } = await service
      .from('applications')
      .select('preferred_language, profiles!applications_applicant_id_fkey(full_name, email)')
      .eq('id', r.application_id!)
      .single();

    const profile = Array.isArray(app?.profiles) ? app.profiles[0] : app?.profiles;
    if (!profile?.email) {
      await service
        .from('notifications' as never)
        .update({ email_status: 'failed', error_message: 'Missing profile/email' } as never)
        .eq('id', r.id);
      failed++;
      continue;
    }
    const locale = (app?.preferred_language as 'ar' | 'en') ?? 'en';

    let result: { id: string | null; error: string | null };
    switch (r.channel) {
      case 'application_accepted':
        result = await sendApplicationAcceptedEmail({ to: profile.email, fullName: profile.full_name ?? '', locale });
        break;
      case 'application_rejected':
        result = await sendApplicationRejectedEmail({ to: profile.email, fullName: profile.full_name ?? '', locale });
        break;
      case 'booking_confirmed':
        result = await sendBookingConfirmedEmail({ to: profile.email, fullName: profile.full_name ?? '', sessionTitle: r.title, locale });
        break;
      case 'session_cancelled':
        result = await sendSessionCancellationNotificationEmail({ to: profile.email, fullName: profile.full_name ?? '', sessionTitle: r.title, locale });
        break;
      case 'session_rescheduled':
        result = await sendSessionRescheduleNotificationEmail({
          to: profile.email,
          fullName: profile.full_name ?? '',
          sessionTitle: r.title,
          oldStartTime: r.old_start_time!,
          newStartTime: r.new_start_time!,
          locale,
        });
        break;
      case 'waitlist_promoted':
        result = await sendWaitlistPromotionNotificationEmail({ to: profile.email, fullName: profile.full_name ?? '', sessionTitle: r.title, locale });
        break;
      // session_reminder / travel_reminder: session-reminders/route.ts and
      // travel-reminders/route.ts (Task 6 Steps 4-5) keep their OWN
      // time-window/no-travel-leg queries and build their own
      // locale-resolved title/body -- they call create_notification purely
      // as the new dispatch mechanism, replacing their old direct
      // sendEmailGuarded call. The actual email send for both channels
      // happens HERE (this cron), using the row's own title/body exactly
      // as the producer route built them -- see sendSessionReminderEmail/
      // sendTravelReminderEmail in resend.ts, which (unlike every other
      // export in that file) don't re-derive locale copy themselves since
      // it's already correct on the row.
      case 'session_reminder':
        result = await sendSessionReminderEmail({ to: profile.email, fullName: profile.full_name ?? '', title: r.title, body: r.body, locale });
        break;
      case 'travel_reminder':
        result = await sendTravelReminderEmail({ to: profile.email, fullName: profile.full_name ?? '', title: r.title, body: r.body, locale });
        break;
      // Any other channel value reaching here is a genuine gap (a new
      // notification_channel enum value added without a matching case) --
      // surfaced immediately as a visible 'failed' row with a clear error
      // message, rather than silently dropping the notification.
      default:
        result = { id: null, error: `Unhandled channel: ${r.channel}` };
    }

    if (result.error) {
      await service
        .from('notifications' as never)
        .update({ email_status: 'failed', error_message: result.error } as never)
        .eq('id', r.id);
      failed++;
    } else {
      await service
        .from('notifications' as never)
        .update({ email_status: 'sent', sent_at: new Date().toISOString() } as never)
        .eq('id', r.id);
      sent++;
    }
  }

  return NextResponse.json({ processed: (rows ?? []).length, sent, failed });
}
