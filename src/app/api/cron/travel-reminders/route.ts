// src/app/api/cron/travel-reminders/route.ts
//
// COY21 §11 — sends a travel submission reminder to accepted participants
// who have NOT yet submitted any travel legs.
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
import { getResendConfig } from '@/lib/email/resend-config';
import { Resend } from 'resend';

// COY21 event start — stop sending reminders from this date onward.
const EVENT_START = new Date('2026-11-05T00:00:00Z');

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

  // Don't spam after the event starts
  if (new Date() >= EVENT_START) {
    return NextResponse.json({ skipped: true, reason: 'Event already started' });
  }

  const configResult = getResendConfig();
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Resend not configured', missing: configResult.missing }, { status: 500 });
  }
  const { config } = configResult;

  const service = createServiceRoleClient();
  const resend = new Resend(config.apiKey);

  // Find all accepted application IDs that have at least one travel leg
  const { data: withTravel } = await service
    .from('travel_legs')
    .select('application_id');

  const withTravelIds = new Set((withTravel ?? []).map((r) => r.application_id));

  // All accepted participants
  const { data: apps, error } = await service
    .from('applications')
    .select('id, profiles!applications_applicant_id_fkey(full_name, email)')
    .eq('status', 'accepted');

  if (error) {
    console.error('travel-reminders: failed to fetch applications', error);
    return NextResponse.json({ error: 'Failed to fetch applications' }, { status: 500 });
  }

  const appUrl = config.appUrl;
  let sent = 0;
  let failed = 0;

  const recipients = (apps ?? []).flatMap((app) => {
    if (withTravelIds.has(app.id)) return []; // already submitted
    const profile = Array.isArray(app.profiles) ? app.profiles[0] : app.profiles;
    if (!profile?.email || !profile?.full_name) return [];
    return [{ email: profile.email, fullName: profile.full_name }];
  });

  // Sent in concurrency-limited batches rather than one at a time: a fully
  // serial loop over every accepted-but-travel-less participant can exceed
  // the serverless function's execution timeout on a large participant
  // list, silently truncating the reminder run partway through.
  const BATCH_SIZE = 10;
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((recipient) => sendTravelReminder(resend, config, appUrl, recipient)));
    for (const ok of results) {
      if (ok) sent++;
      else failed++;
    }
  }

  return NextResponse.json({ sent, failed });
}

async function sendTravelReminder(
  resend: Resend,
  config: { fromEmail: string; replyToEmail: string; supportEmail: string },
  appUrl: string,
  profile: { email: string; fullName: string }
): Promise<boolean> {
  const name = escapeHtml(profile.fullName);
  const travelUrl = `${appUrl}/my-travel`;

  const subject = 'Action required: submit your travel details for COY21';
  const text = [
    `Hello ${profile.fullName},`,
    '',
    'We haven\'t received your travel details yet.',
    '',
    'Please log in and submit your flight information so our logistics team can plan airport reception:',
    `  ${travelUrl}`,
    '',
    'If you have any questions, contact us at ' + config.supportEmail,
    '',
    'COY21 Team',
  ].join('\n');

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
We haven&apos;t received your travel details yet. Please submit your flight information so our logistics team can plan airport reception for your arrival.
</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
<tr><td style="border-radius:6px;background:#008080;">
<a href="${escapeHtml(travelUrl)}" style="display:inline-block;padding:12px 28px;font-size:14px;color:#fff;font-weight:bold;text-decoration:none;">Submit travel details</a>
</td></tr>
</table>
<p style="margin:0;font-size:13px;color:#666;">
Questions? Contact us at <a href="mailto:${escapeHtml(config.supportEmail)}" style="color:#008080;">${escapeHtml(config.supportEmail)}</a>
</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const { error: sendErr } = await resend.emails.send({
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: profile.email,
    subject,
    text,
    html,
  });

  return !sendErr;
}
