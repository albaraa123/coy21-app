// src/app/api/cron/session-reminders/route.ts
//
// COY21 §9 — finds every participant with an active booking for a session
// starting 25–35 minutes from now (a 10-minute window around the target
// 30-minute lead time, to tolerate cron drift) and inserts a
// `session_reminder` row into `notifications` via the create_notification
// RPC for each. The actual email send is now dispatched by the unified
// process-notifications cron (Sub-project 6, Task 6) -- this route's own
// job is only to identify WHO gets reminded and WHEN, not to send mail
// itself. Time-window query and active-booking resolution are UNCHANGED
// from before Task 6; only the dispatch mechanism at the bottom of the
// loop changed (direct sendEmailGuarded call -> create_notification RPC).
//
// Dedup (final whole-branch review finding): this cron runs every 5
// minutes against a 10-minute match window, so the SAME upcoming session
// is matched by 2-3 consecutive invocations -- without a guard, each one
// would insert its own session_reminder row for the same participant,
// surfacing as 2-3 duplicate reminders in the bell (and duplicate emails).
// notifications_session_reminder_dedupe_idx (a unique partial index on
// (application_id, session_id, channel) for this channel) makes the
// second/third insert fail with a unique-violation (SQLSTATE 23505) --
// caught below and treated as "already reminded, not a failure", not
// surfaced as an error.
//
// Invoke every 5 minutes from any cron service, e.g.:
//   Vercel Cron:  vercel.json -> { "crons": [{ "path": "/api/cron/session-reminders", "schedule": "*/5 * * * *" }] }
//   External:     GET https://your-domain.com/api/cron/session-reminders
//                 with header  Authorization: Bearer <CRON_SECRET>
//
// SECURITY: guarded by CRON_SECRET env var — callers must pass it as a
// Bearer token. Without it the route is locked (403) to prevent public
// triggering which would spam participants.

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { formatConferenceTime } from '@/lib/datetime/conference-time';

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

  const service = createServiceRoleClient();

  // Sessions starting 25–35 minutes from now
  const now = new Date();
  const windowStart = new Date(now.getTime() + 25 * 60 * 1000).toISOString();
  const windowEnd = new Date(now.getTime() + 35 * 60 * 1000).toISOString();

  // Fetch sessions in the reminder window
  const { data: sessions, error: sessErr } = await service
    .from('sessions')
    .select('id, title_en, title_ar, start_time, end_time, rooms(name_en, name_ar)')
    .gte('start_time', windowStart)
    .lte('start_time', windowEnd)
    .eq('status', 'confirmed');

  if (sessErr) {
    console.error('session-reminders: failed to fetch sessions', sessErr);
    return NextResponse.json({ error: 'Failed to fetch sessions' }, { status: 500 });
  }
  if (!sessions || sessions.length === 0) {
    return NextResponse.json({ sent: 0, message: 'No sessions in reminder window' });
  }

  let sent = 0;
  let failed = 0;
  let alreadyReminded = 0;

  for (const session of sessions) {
    // Get active bookings for this session
    const { data: bookings } = await service
      .from('session_bookings')
      .select('application_id')
      .eq('session_id', session.id)
      .eq('status', 'active');

    if (!bookings || bookings.length === 0) continue;

    const appIds = bookings.map((b) => b.application_id);

    // Resolve to names + emails (preferred_language carried through so the
    // notification row's title can be locale-aware, same as every other
    // create_notification caller in this sub-project).
    const { data: apps } = await service
      .from('applications')
      .select('id, preferred_language, profiles!applications_applicant_id_fkey(full_name, email)')
      .in('id', appIds);

    if (!apps) continue;

    const sessionTitle = (session.title_en ?? session.title_ar ?? 'Your session').trim();
    const room = Array.isArray(session.rooms)
      ? session.rooms[0]?.name_en ?? session.rooms[0]?.name_ar ?? ''
      : (session.rooms as { name_en?: string; name_ar?: string } | null)?.name_en ?? '';

    const startLocal = session.start_time
      ? formatConferenceTime(session.start_time, 'en', { hour12: false })
      : '';

    for (const app of apps) {
      const profile = Array.isArray(app.profiles) ? app.profiles[0] : app.profiles;
      if (!profile?.email || !profile?.full_name) continue;

      const locale = (app.preferred_language as 'ar' | 'en') ?? 'en';
      const title = locale === 'ar'
        ? `تذكير: "${sessionTitle}" يبدأ خلال 30 دقيقة`
        : `Reminder: "${sessionTitle}" starts in 30 minutes`;
      const bodyLines = [
        room ? (locale === 'ar' ? `القاعة: ${room}` : `Room: ${room}`) : '',
        startLocal ? (locale === 'ar' ? `الوقت: ${startLocal}` : `Time: ${startLocal}`) : '',
      ].filter(Boolean);
      const body = bodyLines.length > 0 ? bodyLines.join('\n') : null;

      const { error } = await service.rpc('create_notification' as never, {
        p_application_id: app.id,
        p_channel: 'session_reminder',
        p_title: title,
        p_body: body,
        p_link_path: '/my-agenda',
        p_session_id: session.id,
      } as never);

      if (error) {
        // 23505 = unique_violation on notifications_session_reminder_dedupe_idx
        // (20261008090000) -- a previous invocation, within the last couple
        // of 5-minute cron ticks, already reminded this participant about
        // this exact session. Expected and harmless under this route's
        // 10-minute-window/5-minute-cadence overlap, not a real failure.
        if (error.code === '23505') {
          alreadyReminded++;
        } else {
          console.error('session-reminders: create_notification failed', { applicationId: app.id, sessionId: session.id, error });
          failed++;
        }
      } else {
        sent++;
      }
    }
  }

  return NextResponse.json({ sent, failed, alreadyReminded, sessions: sessions.length });
}
