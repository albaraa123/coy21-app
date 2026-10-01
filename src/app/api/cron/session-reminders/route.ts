// src/app/api/cron/session-reminders/route.ts
//
// COY21 §9 — sends a session reminder email to every participant with an
// active booking for a session starting 25–35 minutes from now (a 10-minute
// window around the target 30-minute lead time, to tolerate cron drift).
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
import { getResendConfig } from '@/lib/email/resend-config';
import { fetchEmailSettings, sendEmailGuarded } from '@/lib/email/send-guarded';
import { formatConferenceTime } from '@/lib/datetime/conference-time';

function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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

  const configResult = getResendConfig();
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Resend not configured', missing: configResult.missing }, { status: 500 });
  }
  const { config } = configResult;

  const service = createServiceRoleClient();
  const settings = await fetchEmailSettings();

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

  for (const session of sessions) {
    // Get active bookings for this session
    const { data: bookings } = await service
      .from('session_bookings')
      .select('application_id')
      .eq('session_id', session.id)
      .eq('status', 'active');

    if (!bookings || bookings.length === 0) continue;

    const appIds = bookings.map((b) => b.application_id);

    // Resolve to names + emails
    const { data: apps } = await service
      .from('applications')
      .select('profiles!applications_applicant_id_fkey(full_name, email)')
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

      const name = escapeHtml(profile.full_name);
      const subject = `Reminder: "${sessionTitle}" starts in 30 minutes`;
      const text = [
        `Hello ${profile.full_name},`,
        '',
        `This is a reminder that your session is starting soon:`,
        '',
        `  Session: ${sessionTitle}`,
        room ? `  Room:    ${room}` : '',
        startLocal ? `  Time:    ${startLocal}` : '',
        '',
        'Please make your way to the venue now.',
        '',
        'COY21 Team',
      ].filter(Boolean).join('\n');

      const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/></head>
<body style="font-family:Arial,sans-serif;color:#1a1a1a;background:#f5f5f5;margin:0;padding:24px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td align="center">
<table role="presentation" style="max-width:520px;width:100%;background:#fff;border-radius:8px;overflow:hidden;">
<tr><td style="background:#008080;padding:20px 24px;text-align:center;">
<span style="color:#fff;font-size:18px;font-weight:bold;">COY21 Türkiye 2026</span>
</td></tr>
<tr><td style="padding:24px;">
<p style="margin:0 0 16px;font-size:15px;">Hello ${name},</p>
<p style="margin:0 0 16px;font-size:14px;color:#333;line-height:1.6;">
Your session is starting in <strong>30 minutes</strong>:
</p>
<table role="presentation" width="100%" style="background:#f0f9f9;border-radius:6px;margin:0 0 20px;">
<tr><td style="padding:16px;">
<p style="margin:0 0 8px;font-size:13px;color:#666;">Session</p>
<p style="margin:0 0 12px;font-size:15px;font-weight:bold;">${escapeHtml(sessionTitle)}</p>
${room ? `<p style="margin:0 0 8px;font-size:13px;color:#666;">Room</p><p style="margin:0 0 12px;font-size:14px;">${escapeHtml(room)}</p>` : ''}
${startLocal ? `<p style="margin:0 0 8px;font-size:13px;color:#666;">Time</p><p style="margin:0;font-size:14px;">${startLocal}</p>` : ''}
</td></tr>
</table>
<p style="margin:0;font-size:13px;color:#666;">Please make your way to the venue now.</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

      const { error } = await sendEmailGuarded({
        settings,
        apiKey: config.apiKey,
        from: config.fromEmail,
        replyTo: config.replyToEmail,
        to: profile.email,
        subject,
        text,
        html,
        originalRecipientDescription: `${profile.full_name} <${profile.email}>`,
      });

      if (error) {
        failed++;
      } else {
        sent++;
      }
    }
  }

  return NextResponse.json({ sent, failed, sessions: sessions.length });
}
