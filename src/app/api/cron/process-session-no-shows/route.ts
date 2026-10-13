// src/app/api/cron/process-session-no-shows/route.ts
//
// Detects no-shows and releases their seats. For every `confirmed`
// session whose start_time was 15+ minutes ago (bounded to a 2-hour
// lookback window so this doesn't become an ever-growing scan as the
// conference progresses), calls process_session_no_shows() via RPC,
// which marks any active booking with no admitted attendance record as
// 'no_show' and -- for waitlist-enabled session types -- promotes the
// next FIFO waitlist candidate via the same promote_next_waitlist_
// candidate() helper cancel_booking uses (added in
// 20261006040000_no_show_detection_and_promotion_helper.sql, latest
// definition in 20261008060000_isolate_notification_failures.sql). No
// per-row email handling is needed here: a promotion already calls
// create_notification() directly inside that RPC (isolated in its own
// exception block so a notification failure never undoes the already-
// committed promotion), dispatched by process-notifications/route.ts --
// confirmed live in production 2026-10-13. The RPC also still dual-writes
// a row into session_notification_outbox as of this writing, but nothing
// drains that table any more (process-session-notifications, the cron
// that used to, was deleted 2026-10-13 once the create_notification path
// above was verified) -- the outbox write is now inert, not a second
// delivery path. See docs/pre-launch-checklist.md for the full context.
//
// Invoke every 5 minutes from any cron service, e.g.:
//   Vercel Cron:  vercel.json -> { "crons": [{ "path": "/api/cron/process-session-no-shows", "schedule": "*/5 * * * *" }] }
//   External:     GET https://your-domain.com/api/cron/process-session-no-shows
//                 with header  Authorization: Bearer <CRON_SECRET>
//
// SECURITY: guarded by CRON_SECRET env var.

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';

const NO_SHOW_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const LOOKBACK_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

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

  const { data: sessions, error: fetchErr } = await service
    .from('sessions')
    .select('id')
    .eq('status', 'confirmed')
    .lte('start_time', new Date(Date.now() - NO_SHOW_THRESHOLD_MS).toISOString())
    .gte('start_time', new Date(Date.now() - LOOKBACK_WINDOW_MS).toISOString());

  if (fetchErr) {
    console.error('process-session-no-shows: failed to fetch sessions', fetchErr);
    return NextResponse.json({ error: 'Failed to fetch sessions' }, { status: 500 });
  }
  if (!sessions || sessions.length === 0) {
    return NextResponse.json({ processed: 0, errored: 0, total: 0, message: 'No sessions to process' });
  }

  let processed = 0;
  let errored = 0;

  for (const session of sessions) {
    const { error: rpcErr } = await service.rpc('process_session_no_shows', { p_session_id: session.id });
    if (rpcErr) {
      console.error(`process-session-no-shows: failed for session ${session.id}`, rpcErr);
      errored++;
    } else {
      processed++;
    }
  }

  return NextResponse.json({ processed, errored, total: sessions.length });
}
