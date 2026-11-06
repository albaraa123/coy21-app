// src/app/api/cron/login-reminder/route.ts
//
// One-off Day 3 reminder (scheduled in vercel.json for 07:00 Istanbul on
// 7 November 2026): every participant whose login email was delivered but
// who has still never signed in gets a personal announcement telling them
// to log in and open "My QR" before registration. The unified
// process-notifications cron then sends the emails. Idempotent: a
// participant who already has this reminder is skipped, so a retried run
// never emails anyone twice. Same CRON_SECRET Bearer guard as the other
// crons.
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';

const REMINDER_TITLE = 'Reminder: please log in now - you need your QR for registration today';

function isAuthorizedCronRequest(req: NextRequest, cronSecret: string): boolean {
  const authHeader = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${cronSecret}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (!isAuthorizedCronRequest(req, cronSecret)) return new NextResponse('Forbidden', { status: 403 });

  const service = createServiceRoleClient();

  const { data: rows, error } = await service
    .from('participant_account_provisioning')
    .select('application_id, auth_user_id')
    .eq('email_status', 'delivered')
    .eq('must_change_password', true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Who has never signed in (paginate Auth's user list).
  const neverSignedIn = new Map<string, string>();
  for (let page = 1; page <= 20; page++) {
    const { data, error: listError } = await service.auth.admin.listUsers({ page, perPage: 1000 });
    if (listError) return NextResponse.json({ error: listError.message }, { status: 500 });
    for (const u of data.users) if (!u.last_sign_in_at && u.email) neverSignedIn.set(u.id, u.email);
    if (data.users.length < 1000) break;
  }

  const { data: already } = await service.from('notifications').select('application_id').eq('title', REMINDER_TITLE);
  const alreadySet = new Set((already ?? []).map((n) => n.application_id));

  const toInsert = (rows ?? [])
    .filter((r) => r.auth_user_id && neverSignedIn.has(r.auth_user_id) && !alreadySet.has(r.application_id))
    .map((r) => ({
      application_id: r.application_id,
      is_broadcast: false,
      channel: 'announcement' as const,
      title: REMINDER_TITLE,
      body:
        `Registration starts at 8:30 AM today (Day 3, 7 November), and your personal QR code is how you check in. ` +
        `You have not logged in to the platform yet, so your QR is not on your phone.\n\n` +
        `Please log in now at https://register.climatecoy.com/en/log-in with:\n\n` +
        `Username: ${neverSignedIn.get(r.auth_user_id!)}\nPassword: password@123\n\n` +
        `(You will be asked to set a new password the first time you log in.)\n\n` +
        `Then open "My QR" and keep it ready to show at the registration desk.`,
      link_path: '/my-qr',
    }));

  // ?dry=1 reports who WOULD be reminded without queueing anything.
  if (req.nextUrl.searchParams.get('dry') === '1') {
    return NextResponse.json({ dryRun: true, wouldQueue: toInsert.length, skippedAlreadyReminded: alreadySet.size });
  }

  if (toInsert.length > 0) {
    const { error: insertError } = await service.from('notifications').insert(toInsert);
    if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });
  }
  return NextResponse.json({ queued: toInsert.length, skippedAlreadyReminded: alreadySet.size });
}
