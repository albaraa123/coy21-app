// src/app/api/cron/process-notifications/route.ts
//
// Sub-project 6, Task 6: unified email-dispatch cron, replacing
// process-session-notifications (deleted 2026-10-13 once its deletion
// precondition -- Task 6 Step 6's explicit gate -- was verified live in
// production: all 9 notification channel types confirmed sending via this
// route, see docs/pre-launch-checklist.md) and absorbing session-reminders'/
// travel-reminders' direct-send logic (both modified this task to insert
// `notifications` rows via the create_notification RPC instead of sending
// email directly).
// Runs every 1 minute (external cron-job.org job, see pre-launch-checklist.md
// -- Vercel Hobby's cron limit couldn't fit this cadence). Same CRON_SECRET
// Bearer-token guard as every other cron in this codebase --
// isAuthorizedCronRequest below was originally copied from the now-deleted
// process-session-notifications/route.ts.
//
// Drains the `notifications` table (20261008010000_notifications_table.sql)
// for rows with email_status = 'pending' (or a stale 'processing' row --
// see below), dispatching the correct email function per `channel`.
// Personal (non-broadcast) rows are processed sequentially, matching the
// now-deleted process-session-notifications' concurrency model for that part.
// A broadcast row (channel = 'announcement') fans out to every currently-
// 'accepted' application, queried fresh at send time -- NOT from any
// snapshot taken when create_announcement() inserted the row -- so an
// applicant whose status changes between creation and this cron running is
// correctly excluded. That recipient fan-out is batched (BROADCAST_BATCH_SIZE
// at a time, mirroring travel-reminders' existing batching, using
// Promise.allSettled rather than Promise.all so one recipient's send
// throwing never takes the rest of that batch down with it), but the
// broadcast notification row itself is still a single row, marked
// sent/failed once after the whole fan-out completes.
//
// Concurrency safety (code-quality review of this task's first commit
// found this gap): Vercel Cron does not guarantee a previous invocation
// has finished before the next one fires, and at this route's 1-minute
// schedule against per-row work that includes an awaited Resend HTTP call,
// two overlapping invocations both reading the same row as 'pending' was a
// real risk, not a theoretical one. Each row is now atomically CLAIMED
// (email_status: pending -> processing, conditional on still being
// 'pending') before any send is attempted; a losing concurrent claim
// affects 0 rows and is simply skipped. `STALE_PROCESSING_MS` below lets
// the route self-heal a row abandoned mid-processing by a crashed/timed-out
// prior invocation (claimed but never resolved to sent/failed) -- the
// query also admits a 'processing' row once it has sat that long,
// so it isn't a new PERMANENT stuck state.
//
// Every row's processing is wrapped in its own try/catch so one row's
// thrown exception (not a handled {error} return, but a real throw --
// e.g. a transient connection drop) cannot abort the whole batch and
// strand every row after it as silently 'processing' forever with no log
// line to debug from.
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { sendTeamThankYouEmail } from '@/lib/email/resend';
import { TEAM_THANKS_LEDGER_TYPE, TEAM_THANKS_QUEUE_TYPE, teamThanksLedgerId } from '@/lib/email/team-thanks';
import { THANKS_SUBJECT, THANKS_PARAGRAPHS } from '@/app/[locale]/(admin)/attendance/staff-thanks/thanks-content';
import {
  sendSessionCancellationNotificationEmail,
  sendSessionRescheduleNotificationEmail,
  sendWaitlistPromotionNotificationEmail,
  sendBookingConfirmedEmail,
  sendAnnouncementEmail,
  sendSessionReminderEmail,
  sendTravelReminderEmail,
} from '@/lib/email/resend';
// sendApplicationAcceptedEmail/sendApplicationRejectedEmail are NOT
// imported here -- see the 'application_accepted'/'application_rejected'
// case below for why these 2 channels are disabled, not deleted. Both
// functions still exist in resend.ts, unused only from this file.

const BATCH_SIZE = 25;
const BROADCAST_BATCH_SIZE = 10; // mirrors travel-reminders' existing batching
// A row claimed (moved to 'processing') longer ago than this is treated as
// abandoned by a crashed/timed-out prior invocation and is picked up again.
// 5 minutes is the balance point: long enough that a still-alive invocation
// (a single Resend call, or a broadcast fan-out batching through a large
// accepted-applicant list) is never falsely declared abandoned and
// double-claimed -- which would reintroduce the exact double-send risk this
// mechanism exists to close -- while short enough that a genuinely crashed
// invocation's rows don't sit stuck for an operationally painful amount of
// time.
const STALE_PROCESSING_MS = 5 * 60 * 1000;

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
  email_status: string;
  claimed_at: string | null;
};

// Marks a row 'failed' with the given message, swallowing (but logging) any
// error from the update itself -- this is already inside a catch/cleanup
// path, so it must never throw and mask the original failure.
async function markFailed(
  service: ReturnType<typeof createServiceRoleClient>,
  id: string,
  errorMessage: string
) {
  const { error } = await service
    .from('notifications' as never)
    .update({ email_status: 'failed', error_message: errorMessage } as never)
    .eq('id', id);
  if (error) {
    console.error('process-notifications: failed to mark row failed', { id, error });
  }
}

// ---------------------------------------------------------------------------
// One-off: the Day 3 booking REMINDER, queued at 07:30 Istanbul time on
// 7 November 2026 (04:30 UTC). This cron already runs every minute, so doing
// it here gives minute-accurate timing without another scheduled job. Every
// accepted participant gets one personal announcement (the same channel the
// first wave used). Idempotent: skipped once any row with this title exists,
// and wrapped so a failure here can never stop normal notification dispatch.
// ---------------------------------------------------------------------------
const DAY3_REMINDER_TITLE = 'Reminder: Day 3 (final day) - please book your Side Event sessions';
const DAY3_REMINDER_BODY = "Today is Day 3, the final day of COY21. Please book all the Side Event sessions you want to attend today, using the platform.\n\nHOW TO BOOK (takes one minute)\n1. Log in here: https://register.climatecoy.com/en/log-in\n2. Open \"My Program\" and choose the Day 3 Side Event sessions.\n3. Press \"Book\" on each Side Event session you want to attend. You will see a \"Booked\" confirmation.\n   - If a session is full, press \"Join waitlist\" and we will notify you if a seat opens.\n   - You cannot book two sessions that overlap in time. The platform will tell you which one conflicts.\n   - You can cancel a booking from the same page if your plans change.\n\nIMPORTANT\n- Side Events (the breakout sessions in Rooms 1-9) are by booking only. If you have not booked a Side Event, you will not be admitted to it.\n- You do NOT need to book: Registration, Lunch, breaks, the Closing Plenary and the Social & Cultural Evening.\n- The Day 3 agenda was updated. If you had booked Side Events that were moved, your booking is still valid with the new time or room. A few sessions were removed, so please check and rebook if needed.\n- Booking stays open until each session ends, but please book as early as possible.\n\nAT THE DOOR\nOpen \"My QR\" on your phone and show your QR code to the volunteer at the room entrance. Registration is from 8:30 to 9:30 AM in the Main Hall. Your lunch QR is in the same \"My QR\" page.\n\nIf you cannot log in, please come to the registration desk and our team will help you.";
const DAY3_REMINDER_START_MS = Date.UTC(2026, 10, 7, 4, 30);
const DAY3_REMINDER_END_MS = Date.UTC(2026, 10, 7, 13, 0);

async function enqueueDay3BookingReminder(service: ReturnType<typeof createServiceRoleClient>) {
  try {
    const now = Date.now();
    if (now < DAY3_REMINDER_START_MS || now > DAY3_REMINDER_END_MS) return;
    const { count } = await service.from('notifications' as never).select('id', { count: 'exact', head: true }).eq('title', DAY3_REMINDER_TITLE);
    if ((count ?? 0) > 0) return;
    const { data: apps } = await service.from('applications').select('id').eq('status', 'accepted');
    const rows = (apps ?? []).map((a) => ({
      application_id: a.id,
      is_broadcast: false,
      channel: 'announcement',
      title: DAY3_REMINDER_TITLE,
      body: DAY3_REMINDER_BODY,
      link_path: '/my-agenda/browse',
    }));
    for (let i = 0; i < rows.length; i += 100) {
      await service.from('notifications' as never).insert(rows.slice(i, i + 100) as never);
    }
  } catch (err) {
    console.error('process-notifications: day-3 reminder enqueue failed', err);
  }
}

// ---------------------------------------------------------------------------
// One-off: the personal thank-you email to the COY21 team, sent from 06:30
// Istanbul time on 7 November 2026 (03:30 UTC). The recipient list lives in a
// private audit_logs row (never in the repository) queued by an admin. A few
// addresses per run, each claimed in the once-per-address ledger BEFORE the
// send (released again if the send fails), so overlapping runs or the admin
// page can never email the same person twice. Isolated by try/catch so it can
// never block normal notification dispatch.
// ---------------------------------------------------------------------------
const TEAM_THANKS_START_MS = Date.UTC(2026, 10, 7, 3, 30);
const TEAM_THANKS_END_MS = Date.UTC(2026, 10, 7, 9, 0);
const TEAM_THANKS_PER_RUN = 8;

async function sendQueuedTeamThanks(service: ReturnType<typeof createServiceRoleClient>) {
  try {
    const now = Date.now();
    if (now < TEAM_THANKS_START_MS || now > TEAM_THANKS_END_MS) return;
    const { data: queue } = await service
      .from('audit_logs')
      .select('metadata')
      .eq('entity_type', TEAM_THANKS_QUEUE_TYPE)
      .eq('action', 'queued')
      .limit(1);
    const emails = ((queue?.[0]?.metadata as { emails?: string[] } | null)?.emails ?? []).filter((e) => typeof e === 'string');
    if (emails.length === 0) return;
    const { data: done } = await service
      .from('audit_logs')
      .select('entity_id')
      .eq('entity_type', TEAM_THANKS_LEDGER_TYPE)
      .eq('action', 'sent')
      .in('entity_id', emails.map(teamThanksLedgerId));
    const doneIds = new Set((done ?? []).map((r) => r.entity_id as string));
    const pending = emails.filter((e) => !doneIds.has(teamThanksLedgerId(e))).slice(0, TEAM_THANKS_PER_RUN);
    for (const email of pending) {
      const id = teamThanksLedgerId(email);
      const { error: claimError } = await service
        .from('audit_logs')
        .insert({ entity_type: TEAM_THANKS_LEDGER_TYPE, entity_id: id, action: 'sent', metadata: { email, via: 'scheduled' } });
      if (claimError) continue;
      const result = await sendTeamThankYouEmail({ to: email, subject: THANKS_SUBJECT, paragraphs: THANKS_PARAGRAPHS });
      if (result.error) {
        await service.from('audit_logs').delete().eq('entity_type', TEAM_THANKS_LEDGER_TYPE).eq('entity_id', id).eq('action', 'sent');
        console.error('process-notifications: team thanks send failed', { reason: result.error });
      }
      await new Promise((res) => setTimeout(res, 600));
    }
  } catch (err) {
    console.error('process-notifications: team thanks run failed', err);
  }
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

  await enqueueDay3BookingReminder(service);
  await sendQueuedTeamThanks(service);

  // `as never` on 'notifications': same established workaround used
  // throughout this sub-project (e.g. process-session-notifications/route.ts
  // for session_notification_outbox) for tables not yet reflected in the
  // generated src/types/database.ts snapshot at the time this route was
  // written.
  //
  // Includes 'processing' rows claimed longer ago than STALE_PROCESSING_MS
  // so a row abandoned by a crashed/timed-out prior invocation self-heals
  // instead of sitting stuck forever (20261008071000_add_notification_claimed_at.sql).
  const staleCutoff = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
  const { data: rows, error: fetchErr } = await service
    .from('notifications' as never)
    .select('*')
    .or(`email_status.eq.pending,and(email_status.eq.processing,claimed_at.lt.${staleCutoff})`)
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchErr) {
    console.error('process-notifications: failed to fetch pending rows', fetchErr);
    return NextResponse.json({ error: 'Failed to fetch pending notifications' }, { status: 500 });
  }

  let sent = 0;
  let failed = 0;

  for (const row of (rows ?? []) as unknown as NotificationRow[]) {
    const r = row;

    try {
      // Claim this row before doing any send work: an atomic conditional
      // update (email_status -> 'processing', stamping claimed_at) that
      // only succeeds if no other invocation has already claimed it.
      // Vercel Cron does not guarantee a previous invocation has finished
      // before the next one fires -- at a 1-minute schedule, against a
      // route whose per-row work includes an awaited Resend HTTP call, two
      // overlapping invocations both reading the same row is a real, not
      // theoretical, risk (code-quality review of this task found this gap
      // and flagged it as materially worse than the 5-minute-cadence
      // precedent this route replaces). `.eq('email_status', r.email_status)`
      // and, for a stale-processing row, `.eq('claimed_at', r.claimed_at)`
      // match the exact row state the fetch above observed it in -- if a
      // concurrent invocation already re-claimed it in between, neither
      // condition holds any more, 0 rows are affected, and
      // `.select('id')` reveals that so this invocation skips the row
      // rather than double-sending.
      const claimQuery = service
        .from('notifications' as never)
        .update({ email_status: 'processing', claimed_at: new Date().toISOString() } as never)
        .eq('id', r.id)
        .eq('email_status', r.email_status);
      const { data: claimed, error: claimErr } = await (
        r.email_status === 'processing'
          ? claimQuery.eq('claimed_at', r.claimed_at as string)
          : claimQuery
      ).select('id');

      if (claimErr) {
        console.error('process-notifications: failed to claim row', { id: r.id, error: claimErr });
        continue;
      }
      if (!claimed || (claimed as unknown[]).length === 0) {
        // Another invocation already claimed this row between our SELECT
        // above and this UPDATE -- skip it, do not send, do not count it.
        continue;
      }

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
        let anySent = false;
        const list = (recipients ?? []) as unknown as Array<{
          preferred_language: string | null;
          profiles: { full_name: string | null; email: string | null } | { full_name: string | null; email: string | null }[] | null;
        }>;

        for (let i = 0; i < list.length; i += BROADCAST_BATCH_SIZE) {
          const batch = list.slice(i, i + BROADCAST_BATCH_SIZE);
          // Promise.allSettled, not Promise.all: a single recipient's send
          // throwing (not just returning {error}) must not take down the
          // rest of this batch, or silently abort every batch after it in
          // the same invocation (Important finding from code-quality
          // review -- with 10 recipients per batch, one bad address/thrown
          // exception previously could have failed 9 unrelated sends too).
          const results = await Promise.allSettled(
            batch.map(async (recipient) => {
              const profile = Array.isArray(recipient.profiles) ? recipient.profiles[0] : recipient.profiles;
              if (!profile?.email) return false;
              // English-only by product decision (2026-10-31): never send
              // Arabic email, regardless of a participant's
              // preferred_language. See the matching fix on the personal-row
              // path below and in session-reminders/route.ts and
              // applications/[id]/actions.ts.
              const locale = 'en' as const;
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
          for (const outcome of results) {
            if (outcome.status === 'rejected') {
              console.error('process-notifications: broadcast recipient send threw', {
                notificationId: r.id,
                reason: outcome.reason,
              });
              anyFailed = true;
            } else if (!outcome.value) {
              anyFailed = true;
            } else {
              anySent = true;
            }
          }
        }

        // A zero-recipient broadcast (no accepted applications at send
        // time) previously fell through this same "sent, no error" path
        // as a genuinely successful send with nothing to report -- found
        // live, 2026-10-09: an announcement created while the database had
        // zero accepted applicants was marked 'sent' with a null
        // error_message, even though sendAnnouncementEmail was never
        // called even once (list.length === 0, so the batching loop above
        // never runs). This is indistinguishable from a real send in the
        // UI and in any later audit of this table, which is exactly how
        // the gap was discovered: a confirmed 'sent' row with no
        // corresponding entry in Resend's own send log at all. Marked
        // 'failed' here instead, with a specific, non-generic error
        // message, so this case is visibly different from both "sent
        // cleanly" and "sent with some per-recipient failures."
        const genuinelyHadNoRecipients = !anySent && !anyFailed;
        const broadcastUpdate = genuinelyHadNoRecipients
          ? { email_status: 'failed', error_message: 'No accepted applicants to notify at send time' }
          : {
              email_status: 'sent',
              sent_at: new Date().toISOString(),
              error_message: anyFailed ? 'One or more recipients failed; see send logs' : null,
            };
        await service
          .from('notifications' as never)
          .update(broadcastUpdate as never)
          .eq('id', r.id);
        if (genuinelyHadNoRecipients) {
          failed++;
        } else {
          sent++;
        }
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
        await markFailed(service, r.id, 'Missing profile/email');
        failed++;
        continue;
      }
      // English-only by product decision (2026-10-31): see the matching
      // comment on the broadcast path above.
      const locale = 'en' as const;

      let result: { id: string | null; error: string | null };
      switch (r.channel) {
        // Disabled 2026-10-26 per explicit product decision: every
        // participant now arrives through staff-run CSV import, not
        // self-registration, so these two channels' real trigger
        // (updateApplicationStatus in applications/[id]/actions.ts) never
        // fires in practice -- but acceptance/rejection notices are still
        // sent manually, outside this system, by the organising team. Not
        // deleted (the notification-insert call sites, the email
        // templates in resend.ts, and this cron's dispatch wiring are all
        // left intact) in case this is reversed later -- only the actual
        // send is skipped, treated the same as a successful send so the
        // row doesn't sit as 'pending' forever.
        case 'application_accepted':
        case 'application_rejected':
          result = { id: null, error: null };
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
        // A PERSONAL (non-broadcast) announcement addressed to one
        // application, e.g. "the agenda changed, please re-book". The
        // broadcast fan-out above only handles is_broadcast rows.
        case 'announcement':
          result = await sendAnnouncementEmail({ to: profile.email, fullName: profile.full_name ?? '', title: r.title, body: r.body, locale });
          break;
        // Any other channel value reaching here is a genuine gap (a new
        // notification_channel enum value added without a matching case) --
        // surfaced immediately as a visible 'failed' row with a clear error
        // message, rather than silently dropping the notification.
        default:
          result = { id: null, error: `Unhandled channel: ${r.channel}` };
      }

      if (result.error) {
        await markFailed(service, r.id, result.error);
        failed++;
      } else {
        await service
          .from('notifications' as never)
          .update({ email_status: 'sent', sent_at: new Date().toISOString() } as never)
          .eq('id', r.id);
        sent++;
      }
    } catch (err) {
      // A thrown (not handled {error}-returned) exception anywhere in this
      // row's processing -- e.g. a transient connection drop mid-send --
      // must not abort the whole batch (Critical finding from code-quality
      // review: previously there was no catch at all, so one such throw
      // would silently kill every row after it in the same invocation with
      // zero logging). Mark the row 'failed' with full context so it's
      // debuggable, rather than leaving it stuck in 'processing' with no
      // trace -- it will also self-heal via STALE_PROCESSING_MS if this
      // catch itself somehow can't run.
      console.error('process-notifications: unhandled exception while processing row', {
        id: r.id,
        channel: r.channel,
        applicationId: r.application_id,
        error: err,
      });
      await markFailed(service, r.id, err instanceof Error ? err.message : 'Unknown error');
      failed++;
    }
  }

  return NextResponse.json({ processed: (rows ?? []).length, sent, failed });
}
