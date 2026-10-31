// src/app/api/cron/session-reminders/route.ts
//
// COY21 §9 — once-daily digest of every session a participant has an
// active booking for THAT DAY (Europe/Istanbul calendar day), sent as one
// email per participant via the create_notification RPC. The actual email
// send is dispatched by the unified process-notifications cron -- this
// route's own job is only to identify WHO gets a digest and build its
// content, not to send mail itself.
//
// Changed 2026-10-31 from a per-session "30 minutes before" reminder
// (running every 5 minutes) to this once-daily digest: the per-session
// version alone could approach Resend's free-tier 100 email/day cap on a
// day with many concurrent sessions, on top of every other notification
// channel competing for the same quota. A once-a-day digest sends at most
// one email per participant with an active booking that day, regardless
// of how many sessions they're booked into.
//
// Dedup: session_reminder rows are deduped by the existing unique index
// notifications_session_reminder_dedupe_idx on
// (application_id, session_id, channel) -- added for the old per-session
// design (20261008090000_dedupe_session_reminder_notifications.sql) but
// reused as-is here by keying each digest row's session_id to the EARLIEST
// booked session that day for that participant. Since "earliest session
// booked for day D" is deterministic for a given participant/day, a second
// invocation on the same day (e.g. cron drift, manual re-trigger) hits the
// same unique-index violation the old design relied on -- no new migration
// needed.
//
// Invoke once daily from any cron service, e.g.:
//   Vercel Cron:  vercel.json -> { "crons": [{ "path": "/api/cron/session-reminders", "schedule": "0 4 * * *" }] }
//                 (04:00 UTC = 07:00 Europe/Istanbul, the intended send time)
//   External:     GET https://your-domain.com/api/cron/session-reminders
//                 with header  Authorization: Bearer <CRON_SECRET>
//
// SECURITY: guarded by CRON_SECRET env var — callers must pass it as a
// Bearer token. Without it the route is locked (403) to prevent public
// triggering which would spam participants.

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { CONFERENCE_TIMEZONE_OFFSET_MS, formatConferenceTime } from '@/lib/datetime/conference-time';

function isAuthorizedCronRequest(req: NextRequest, cronSecret: string): boolean {
  const authHeader = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${cronSecret}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Today's Europe/Istanbul calendar day, as a [start, end) UTC instant
// range -- matching grid-layout.ts's established fixed-offset approach
// (Turkey has observed permanent UTC+3 with no DST since 2016) rather than
// a full IANA-aware library.
function istanbulTodayUtcRange(now: Date): { start: Date; end: Date } {
  const istanbulMs = now.getTime() + CONFERENCE_TIMEZONE_OFFSET_MS;
  const istanbulDate = new Date(istanbulMs);
  const y = istanbulDate.getUTCFullYear();
  const m = istanbulDate.getUTCMonth();
  const d = istanbulDate.getUTCDate();
  // Midnight Istanbul, expressed back in UTC.
  const startUtcMs = Date.UTC(y, m, d) - CONFERENCE_TIMEZONE_OFFSET_MS;
  const endUtcMs = startUtcMs + 24 * 60 * 60 * 1000;
  return { start: new Date(startUtcMs), end: new Date(endUtcMs) };
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

  const service = createServiceRoleClient();
  const { start, end } = istanbulTodayUtcRange(new Date());

  // Confirmed sessions starting today (Istanbul calendar day).
  const { data: sessions, error: sessErr } = await service
    .from('sessions')
    .select('id, title_en, title_ar, start_time, rooms(name_en, name_ar)')
    .gte('start_time', start.toISOString())
    .lt('start_time', end.toISOString())
    .eq('status', 'confirmed')
    .order('start_time', { ascending: true });

  if (sessErr) {
    console.error('session-reminders: failed to fetch sessions', sessErr);
    return NextResponse.json({ error: 'Failed to fetch sessions' }, { status: 500 });
  }
  if (!sessions || sessions.length === 0) {
    return NextResponse.json({ sent: 0, message: 'No sessions today' });
  }

  const sessionIds = sessions.map((s) => s.id);
  const { data: bookings } = await service
    .from('session_bookings')
    .select('application_id, session_id')
    .in('session_id', sessionIds)
    .eq('status', 'active');

  if (!bookings || bookings.length === 0) {
    return NextResponse.json({ sent: 0, message: 'No active bookings for today\'s sessions' });
  }

  // Group booked session ids by participant, preserving sessions' own
  // start_time ordering (already sorted above) so each digest lists the
  // participant's day chronologically.
  const sessionsByApplication = new Map<string, string[]>();
  for (const booking of bookings) {
    const list = sessionsByApplication.get(booking.application_id) ?? [];
    list.push(booking.session_id);
    sessionsByApplication.set(booking.application_id, list);
  }

  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const applicationIds = [...sessionsByApplication.keys()];

  const { data: apps } = await service
    .from('applications')
    .select('id, preferred_language, profiles!applications_applicant_id_fkey(full_name, email)')
    .in('id', applicationIds);

  if (!apps) {
    return NextResponse.json({ sent: 0, message: 'No matching applications' });
  }

  let sent = 0;
  let failed = 0;
  let alreadyReminded = 0;

  for (const app of apps) {
    const profile = Array.isArray(app.profiles) ? app.profiles[0] : app.profiles;
    // Only email is actually required -- a missing *name* degrades to an
    // empty greeting (same established pattern as every other
    // process-notifications channel; see the matching live-incident fix
    // this route's git history already carries for this exact gate).
    if (!profile?.email) continue;

    const bookedSessionIds = sessionsByApplication.get(app.id) ?? [];
    if (bookedSessionIds.length === 0) continue;

    const locale = (app.preferred_language as 'ar' | 'en') ?? 'en';
    const lines = bookedSessionIds.map((sessionId) => {
      const session = sessionById.get(sessionId);
      if (!session) return null;
      const title = (session.title_en ?? session.title_ar ?? '').trim() || (locale === 'ar' ? 'جلسة' : 'Session');
      const room = Array.isArray(session.rooms)
        ? session.rooms[0]?.name_en ?? session.rooms[0]?.name_ar ?? ''
        : (session.rooms as { name_en?: string; name_ar?: string } | null)?.name_en ?? '';
      const time = session.start_time ? formatConferenceTime(session.start_time, locale, { hour12: false }) : '';
      const roomSuffix = room ? ` — ${room}` : '';
      return `${time} ${title}${roomSuffix}`;
    }).filter((line): line is string => line !== null);

    if (lines.length === 0) continue;

    const title = locale === 'ar'
      ? `جدولك اليوم في COY21 (${lines.length} جلسة)`
      : `Your COY21 schedule today (${lines.length} session${lines.length === 1 ? '' : 's'})`;
    const body = lines.join('\n');

    // Dedup key: the earliest booked session that day for this
    // participant -- deterministic per participant/day, so a second
    // invocation the same day hits notifications_session_reminder_dedupe_idx
    // and is treated as already-sent (see this file's header comment).
    const dedupeSessionId = bookedSessionIds[0];

    const { error } = await service.rpc('create_notification' as never, {
      p_application_id: app.id,
      p_channel: 'session_reminder',
      p_title: title,
      p_body: body,
      p_link_path: '/my-agenda',
      p_session_id: dedupeSessionId,
    } as never);

    if (error) {
      // 23505 = unique_violation on notifications_session_reminder_dedupe_idx
      // -- this participant already got today's digest (cron drift, manual
      // re-trigger). Expected and harmless, not a real failure.
      if (error.code === '23505') {
        alreadyReminded++;
      } else {
        console.error('session-reminders: create_notification failed', { applicationId: app.id, error });
        failed++;
      }
    } else {
      sent++;
    }
  }

  return NextResponse.json({ sent, failed, alreadyReminded, sessionsToday: sessions.length });
}
