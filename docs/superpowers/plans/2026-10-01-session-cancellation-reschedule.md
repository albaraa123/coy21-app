# Session Cancellation/Reschedule Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When staff cancel a session or change its time, every participant with an active self-service booking for that session is automatically kept in sync (cancelled-and-flagged, or left valid-at-new-time) and notified by email — regardless of which of the three existing admin code paths performs the change.

**Architecture:** A single DB trigger on `sessions` (fires after any of the three admin paths writes) handles both cases by writing to `session_bookings` (cancellation only) and a new narrow outbox table (both cases). A new cron job drains the outbox every few minutes and sends the actual emails via the existing `sendEmailGuarded` infrastructure, mirroring `session-reminders/route.ts`'s exact structure. `/my-agenda` gains a third booking status (`'session_cancelled'`, distinct from participant-voluntary `'cancelled'`) so a session-cancelled booking shows a badge instead of silently disappearing.

**Tech Stack:** Supabase Postgres (PL/pgSQL triggers, `SECURITY DEFINER` functions), Next.js Route Handlers (cron), React Server/Client Components, Vitest live tests.

**Reference spec:** `docs/superpowers/specs/2026-10-01-session-cancellation-reschedule-design.md`

---

### Task 1: Migration — new enum value (isolated, per repo convention)

**Files:**
- Create: `supabase/migrations/20261004000000_add_session_cancelled_booking_status.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 20261004000000_add_session_cancelled_booking_status.sql
--
-- Isolated in its own file with nothing else in it, per this repo's
-- established convention (see 20260804110000_add_scanner_device_role.sql
-- and 20260929000000_add_staff_role_and_migrate.sql) -- a new enum value
-- must be committed before any later migration can reference it.
--
-- Distinct from the existing 'cancelled' value (written by cancel_booking()
-- for a participant's own voluntary cancellation): this new value marks a
-- booking whose SESSION was cancelled by staff, so /my-agenda can show a
-- distinct "session cancelled" badge instead of silently dropping the row
-- (which reusing plain 'cancelled' would do, since that value is already
-- filtered out of every booking list query). See
-- docs/superpowers/specs/2026-10-01-session-cancellation-reschedule-design.md
-- section 1's "conflict discovered during design" note for the full
-- reasoning.
alter type booking_status add value 'session_cancelled';
```

- [ ] **Step 2: Confirm the scratch project is linked, then apply the migration**

Run: `cat supabase/.temp/linked-project.json`
Expected: `"ref":"jgsuguohtjqurnshagup"` (`coy21-dev-scratch3`). **Do not proceed if any other ref appears.** If the file doesn't exist in this worktree, report NEEDS_CONTEXT rather than attempting to link it yourself with a guessed token.

Run: `npx supabase db push`
Expected: migration applies cleanly with no errors.

- [ ] **Step 3: Smoke-check the new enum value is live**

Write a throwaway Node script (not committed) using `.env.local`'s credentials to confirm the value exists, e.g.:
```ts
const { data, error } = await admin.rpc('pg_catalog.pg_enum' as never); // or simpler: just attempt an insert/select using the value in a scratch query
```
Simplest reliable check: attempt to cast the literal in a query, e.g. via a raw SQL check using the service-role client's ability to call a trivial function, OR just proceed to Task 2 and let its own migration (which references this value) be the real proof — if Task 2's `db push` succeeds referencing `'session_cancelled'`, this value is confirmed live. Do not over-engineer this step; a simple confirmation that `db push` succeeded without error in Step 2 is adequate evidence for this narrow, single-statement migration.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20261004000000_add_session_cancelled_booking_status.sql
git commit -m "feat: add session_cancelled booking_status enum value

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Migration — outbox table, trigger, `cancel_booking()` fix

**Context:** This task depends on Task 1 being applied first (the new enum value must be committed in its own transaction before this migration can reference it in the trigger body and the `cancel_booking()` fix).

**Files:**
- Create: `supabase/migrations/20261004010000_session_lifecycle_notifications.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 20261004010000_session_lifecycle_notifications.sql
--
-- Closes the gap where none of the three admin code paths that can cancel
-- a session (updateSessionStatus) or change its time
-- (updateSession/update_session_transactional,
-- updateSessionScheduleAndAssignments/update_session_and_assignments_transactional)
-- touch session_bookings or send any notification. A trigger-based fix
-- (not per-action) guarantees correctness regardless of which path -- or
-- any future path -- performs the write, mirroring the existing
-- schedule_change_events precedent (20260723180000_schedule_change_detection_triggers.sql)
-- for the same reason. See
-- docs/superpowers/specs/2026-10-01-session-cancellation-reschedule-design.md
-- for full design rationale.
--
-- Requires 20261004000000_add_session_cancelled_booking_status.sql to have
-- already been applied (adds the 'session_cancelled' enum value this
-- migration references).

-- ---------------------------------------------------------------------------
-- 1. Notification outbox -- narrowly scoped to this feature (two
--    notification types only, no generic payload jsonb column, per YAGNI).
--    Triggers cannot send HTTP requests; a separate cron job (Task 3) drains
--    this table and performs the actual send.
-- ---------------------------------------------------------------------------

create type session_notification_type as enum ('session_cancelled', 'session_rescheduled');
create type session_notification_status as enum ('pending', 'sent', 'failed');

create table session_notification_outbox (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid not null references session_bookings(id) on delete cascade,
  application_id  uuid not null references applications(id) on delete cascade,
  session_id      uuid not null references sessions(id) on delete cascade,
  notification_type session_notification_type not null,
  old_start_time  timestamptz,  -- set only for 'session_rescheduled'
  new_start_time  timestamptz,  -- set only for 'session_rescheduled'
  status          session_notification_status not null default 'pending',
  error_message   text,         -- set only when status = 'failed'
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

create index session_notification_outbox_pending_idx
  on session_notification_outbox (status) where status = 'pending';

-- No client-facing RLS -- written only by the trigger below (runs in the
-- same transaction as the sessions UPDATE, not SECURITY DEFINER itself
-- since triggers run with the privileges of the table owner by default)
-- and read only by the outbox-processing cron's service-role client.
alter table session_notification_outbox enable row level security;
-- (No policies created -- RLS enabled with zero policies denies all access
-- to non-service-role callers, matching the lockdown pattern used for
-- allocation_assignments-adjacent internal tables.)

-- ---------------------------------------------------------------------------
-- 2. The lifecycle trigger
-- ---------------------------------------------------------------------------

create function enforce_session_lifecycle_booking_sync() returns trigger as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    -- Session was just cancelled: mark every active booking as
    -- session_cancelled (distinct from participant-voluntary 'cancelled')
    -- and queue one notification per affected booking. Uses a writable CTE
    -- (UPDATE ... RETURNING feeding INSERT ... SELECT) to capture exactly
    -- the rows this statement updated, rather than a second lookup query
    -- that would need some other way to identify "the rows I just
    -- touched" (e.g. re-matching on cancelled_at = now() -- correct since
    -- now() is stable within one statement/transaction, but an indirect,
    -- easier-to-get-wrong way to express the same thing; the CTE form
    -- below is the one to actually implement, not an alternative to
    -- consider).
    with just_cancelled as (
      update session_bookings
      set status = 'session_cancelled', cancelled_at = now()
      where session_id = new.id and status = 'active'
      returning id, application_id, session_id
    )
    insert into session_notification_outbox (booking_id, application_id, session_id, notification_type)
    select id, application_id, session_id, 'session_cancelled' from just_cancelled;

  elsif (new.start_time is distinct from old.start_time or new.end_time is distinct from old.end_time)
        and new.status <> 'cancelled' then
    -- Session's time changed (not a cancellation): bookings stay valid,
    -- queue one reschedule notification per active booking. This SELECT
    -- reads session_bookings without locking it (only the sessions row is
    -- locked for this UPDATE's duration) -- a concurrent book_session()
    -- landing a new active booking right now is correctly swept up (it's
    -- genuinely active at commit), and a concurrent cancel_booking() takes
    -- its own row-level FOR UPDATE lock on that specific booking, so the
    -- worst case is a benign notification-timing race (an extra reschedule
    -- email for a booking cancelled a moment later), never incorrect
    -- session_bookings state.
    insert into session_notification_outbox (booking_id, application_id, session_id, notification_type, old_start_time, new_start_time)
    select id, application_id, session_id, 'session_rescheduled', old.start_time, new.start_time
    from session_bookings
    where session_id = new.id and status = 'active';
  end if;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_enforce_lifecycle_booking_sync
  after update of status, start_time, end_time on sessions
  for each row execute function enforce_session_lifecycle_booking_sync();

-- ---------------------------------------------------------------------------
-- 3. cancel_booking() must also treat 'session_cancelled' as "already
--    cancelled" -- otherwise a participant voluntarily cancelling an
--    already-session-cancelled booking falls through to the deadline check
--    and could succeed in a confusing double-cancel.
-- ---------------------------------------------------------------------------

create or replace function cancel_booking(
  p_booking_id     uuid,
  p_application_id uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_booking  session_bookings%rowtype;
  v_session  sessions%rowtype;
  v_deadline timestamptz;
begin
  if not exists (
    select 1 from applications
    where id = p_application_id and applicant_id = auth.uid()
  ) then
    raise exception 'Not authorized';
  end if;

  select * into v_booking from session_bookings
  where id = p_booking_id and application_id = p_application_id
  for update;

  if v_booking.id is null then
    raise exception 'Booking not found';
  end if;
  if v_booking.status in ('cancelled', 'session_cancelled') then
    raise exception 'Booking is already cancelled';
  end if;

  select * into v_session from sessions where id = v_booking.session_id;
  v_deadline := coalesce(v_session.booking_deadline, v_session.start_time - interval '3 hours');

  if now() > v_deadline then
    raise exception 'Cannot cancel after the booking deadline';
  end if;

  update session_bookings
  set status = 'cancelled', cancelled_at = now()
  where id = p_booking_id;
end;
$$;

grant execute on function cancel_booking(uuid, uuid) to authenticated;
```

- [ ] **Step 2: Apply the migration**

Re-confirm linked project (same check as Task 1 Step 2) before `npx supabase db push`.

- [ ] **Step 3: Manual smoke test against the live scratch project**

Write a throwaway Node script (not committed) that: creates a conference_day/room/track/session_type, a session, an accepted application + auth user, a `session_bookings` row (insert directly, bypassing `book_session()` for simplicity in this manual check), then:
1. `UPDATE sessions SET status = 'cancelled', cancellation_reason = 'test' WHERE id = ...` via the service-role client — confirm the booking's `status` is now `'session_cancelled'` and exactly one `session_notification_outbox` row exists with `notification_type = 'session_cancelled'`.
2. Create a second session + booking, update its `start_time` only — confirm the booking's `status` is still `'active'` and exactly one outbox row exists with `notification_type = 'session_rescheduled'` and correct `old_start_time`/`new_start_time`.
3. Call `cancel_booking()` on the already-`session_cancelled` booking from step 1 — confirm it raises `'Booking is already cancelled'`.
Clean up all fixture rows afterward. Delete the throwaway script when done.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20261004010000_session_lifecycle_notifications.sql
git commit -m "feat: sync session_bookings and queue notifications on session cancel/reschedule

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Email functions

**Files:**
- Modify: `src/lib/email/resend.ts`

- [ ] **Step 1: Add the two new functions**

Add after `sendClassificationChangeNotificationEmail` (before the `escapeHtml` helper), following its exact established shape:

```typescript
export async function sendSessionCancellationNotificationEmail(params: {
  to: string;
  fullName: string;
  sessionTitle: string;
  locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> {
  const configResult = getResendConfig();
  if (!configResult.ok) {
    return { id: null, error: `Resend not configured: missing ${configResult.missing.join(', ')}` };
  }
  const { config } = configResult;

  const browseUrl = `${config.appUrl}/my-agenda/browse`;

  const subject =
    params.locale === 'ar'
      ? `تم إلغاء الجلسة: ${params.sessionTitle}`
      : `Session cancelled: ${params.sessionTitle}`;

  const body =
    params.locale === 'ar'
      ? `مرحباً ${params.fullName}،\n\nنأسف لإبلاغك بأن الجلسة التي حجزتها "${params.sessionTitle}" تم إلغاؤها. حجزك لهذه الجلسة أُلغي تلقائياً.\n\nيمكنك تصفح الجلسات المتاحة الأخرى وحجز بديل من هنا: ${browseUrl}\n\nإذا كان لديك أي استفسار، يرجى التواصل معنا.`
      : `Hello ${params.fullName},\n\nWe're sorry to let you know that the session you booked, "${params.sessionTitle}", has been cancelled. Your booking for this session has been automatically cancelled.\n\nYou can browse other available sessions and book a replacement here: ${browseUrl}\n\nIf you have any questions, please contact us.`;

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: params.to,
    subject,
    text: body,
    originalRecipientDescription: `${params.fullName} <${params.to}>`,
  });
}

export async function sendSessionRescheduleNotificationEmail(params: {
  to: string;
  fullName: string;
  sessionTitle: string;
  oldStartTime: string;
  newStartTime: string;
  locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> {
  const configResult = getResendConfig();
  if (!configResult.ok) {
    return { id: null, error: `Resend not configured: missing ${configResult.missing.join(', ')}` };
  }
  const { config } = configResult;

  const oldTimeFormatted = `${formatConferenceDate(params.oldStartTime, params.locale)} ${formatConferenceTime(params.oldStartTime, params.locale)}`;
  const newTimeFormatted = `${formatConferenceDate(params.newStartTime, params.locale)} ${formatConferenceTime(params.newStartTime, params.locale)}`;

  const subject =
    params.locale === 'ar'
      ? `تغيّر موعد الجلسة: ${params.sessionTitle}`
      : `Session time changed: ${params.sessionTitle}`;

  const body =
    params.locale === 'ar'
      ? `مرحباً ${params.fullName}،\n\nتغيّر موعد الجلسة التي حجزتها "${params.sessionTitle}".\n\nالموعد السابق: ${oldTimeFormatted}\nالموعد الجديد: ${newTimeFormatted}\n\nحجزك لا يزال سارياً على الموعد الجديد تلقائياً، ولا حاجة لإعادة الحجز. إذا تعارض الموعد الجديد مع حجز آخر لديك، يرجى مراجعة برنامجك.\n\nإذا كان لديك أي استفسار، يرجى التواصل معنا.`
      : `Hello ${params.fullName},\n\nThe session you booked, "${params.sessionTitle}", has had its time changed.\n\nPrevious time: ${oldTimeFormatted}\nNew time: ${newTimeFormatted}\n\nYour booking remains valid for the new time automatically -- no need to re-book. If the new time conflicts with another of your bookings, please review your agenda.\n\nIf you have any questions, please contact us.`;

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: params.to,
    subject,
    text: body,
    originalRecipientDescription: `${params.fullName} <${params.to}>`,
  });
}
```

Add the import at the top of the file:
```typescript
import { formatConferenceTime, formatConferenceDate } from '@/lib/datetime/conference-time';
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Write unit tests**

Create `tests/email/session-lifecycle-notifications.test.ts`, following the mocked-Resend-SDK pattern established in `tests/email/resend-send.test.ts` (mock `'resend'` module, mock `fetchEmailSettings` to resolve sandbox-disabled, assert on `sendMock.mock.calls[0][0]`):

```typescript
// tests/email/session-lifecycle-notifications.test.ts
//
// Mocked Resend SDK coverage, following tests/email/resend-send.test.ts's
// established pattern exactly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

vi.mock('@/lib/email/send-guarded', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/send-guarded')>();
  return {
    ...actual,
    fetchEmailSettings: vi.fn().mockResolvedValue({ sandboxEnabled: false, sandboxRecipientEmail: null }),
  };
});

const ENV_KEYS = ['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'RESEND_REPLY_TO_EMAIL', 'APP_URL', 'PARTICIPANT_SUPPORT_EMAIL'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.RESEND_FROM_EMAIL = 'RCOY MENA 2026 <participants@rcoymena.org>';
  process.env.APP_URL = 'https://example.com';
  process.env.PARTICIPANT_SUPPORT_EMAIL = 'support@rcoymena.org';
  delete process.env.RESEND_REPLY_TO_EMAIL;
  sendMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('sendSessionCancellationNotificationEmail', () => {
  it('sends a cancellation email with a link to the browse page, in the requested locale', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendSessionCancellationNotificationEmail } = await import('@/lib/email/resend');

    const result = await sendSessionCancellationNotificationEmail({
      to: 'participant@example.com',
      fullName: 'Test Participant',
      sessionTitle: 'Intro to Climate Policy',
      locale: 'en',
    });

    expect(result.id).toBe('email_1');
    expect(result.error).toBeNull();
    const call = sendMock.mock.calls[0][0];
    expect(call.to).toBe('participant@example.com');
    expect(call.subject).toContain('Intro to Climate Policy');
    expect(call.text).toContain('Intro to Climate Policy');
    expect(call.text).toContain('https://example.com/my-agenda/browse');
  });

  it('sends Arabic subject/body when locale is ar', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendSessionCancellationNotificationEmail } = await import('@/lib/email/resend');

    await sendSessionCancellationNotificationEmail({
      to: 'participant@example.com',
      fullName: 'مشارك',
      sessionTitle: 'جلسة اختبار',
      locale: 'ar',
    });

    const call = sendMock.mock.calls[0][0];
    const arabicBlock = /[؀-ۿ]/;
    expect(call.subject).toMatch(arabicBlock);
    expect(call.text).toMatch(arabicBlock);
  });
});

describe('sendSessionRescheduleNotificationEmail', () => {
  it('includes both old and new formatted times', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const { sendSessionRescheduleNotificationEmail } = await import('@/lib/email/resend');

    const result = await sendSessionRescheduleNotificationEmail({
      to: 'participant@example.com',
      fullName: 'Test Participant',
      sessionTitle: 'Intro to Climate Policy',
      oldStartTime: '2026-11-05T09:00:00Z',
      newStartTime: '2026-11-05T11:00:00Z',
      locale: 'en',
    });

    expect(result.id).toBe('email_1');
    const call = sendMock.mock.calls[0][0];
    expect(call.subject).toContain('Intro to Climate Policy');
    // Both formatted times should appear and be distinct from each other.
    expect(call.text).toContain('Previous time:');
    expect(call.text).toContain('New time:');
  });

  it('fails safely when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendSessionRescheduleNotificationEmail } = await import('@/lib/email/resend');

    const result = await sendSessionRescheduleNotificationEmail({
      to: 'a@example.com',
      fullName: 'A',
      sessionTitle: 'S',
      oldStartTime: '2026-11-05T09:00:00Z',
      newStartTime: '2026-11-05T11:00:00Z',
      locale: 'en',
    });

    expect(result.id).toBeNull();
    expect(result.error).toContain('RESEND_API_KEY');
    expect(sendMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/email/session-lifecycle-notifications.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/resend.ts tests/email/session-lifecycle-notifications.test.ts
git commit -m "feat: add session cancellation/reschedule notification email functions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: The outbox-processing cron

**Files:**
- Create: `src/app/api/cron/process-session-notifications/route.ts`
- Modify: `vercel.json`

- [ ] **Step 1: Write the route**

Follow `src/app/api/cron/session-reminders/route.ts`'s exact structure (same `CRON_SECRET` guard via `isAuthorizedCronRequest`, same fail-closed behavior, same service-role client pattern):

```typescript
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
import { sendSessionCancellationNotificationEmail, sendSessionRescheduleNotificationEmail } from '@/lib/email/resend';

const BATCH_SIZE = 100;

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

  const { data: rows, error: fetchErr } = await service
    .from('session_notification_outbox')
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

  for (const row of rows) {
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
      await service.from('session_notification_outbox').update({ status: 'failed', error_message: 'Missing profile or session data' }).eq('id', row.id);
      failed++;
      continue;
    }

    const locale = (application?.preferred_language as 'ar' | 'en') ?? 'en';
    const sessionTitle = (locale === 'ar' ? session.title_ar : session.title_en) ?? session.title_en ?? session.title_ar ?? 'Your session';

    const result = row.notification_type === 'session_cancelled'
      ? await sendSessionCancellationNotificationEmail({
          to: profile.email,
          fullName: profile.full_name,
          sessionTitle,
          locale,
        })
      : await sendSessionRescheduleNotificationEmail({
          to: profile.email,
          fullName: profile.full_name,
          sessionTitle,
          oldStartTime: row.old_start_time!,
          newStartTime: row.new_start_time!,
          locale,
        });

    if (result.error) {
      await service.from('session_notification_outbox').update({ status: 'failed', error_message: result.error }).eq('id', row.id);
      failed++;
    } else {
      await service.from('session_notification_outbox').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', row.id);
      sent++;
    }
  }

  return NextResponse.json({ sent, failed, total: rows.length });
}
```

- [ ] **Step 2: Register the cron in `vercel.json`**

Add to the `crons` array (alongside the existing `session-reminders` and `travel-reminders` entries):

```json
    {
      "path": "/api/cron/process-session-notifications",
      "schedule": "*/5 * * * *"
    }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. The `session_notification_outbox` table is new (added in Task 2's migration) — if generated Supabase types (`src/types/database.ts`) don't yet recognize it, use the established `as never` cast workaround (see `src/lib/participants/reclassify.ts` and `tests/agenda/booking-allocation-conflict-live.test.ts` for the precedent) on the `.from('session_notification_outbox')` calls rather than blocking on type regeneration.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/process-session-notifications/route.ts vercel.json
git commit -m "feat: add cron to drain session notification outbox

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: `/my-agenda` UI — show session-cancelled bookings with a badge

**Files:**
- Modify: `src/app/[locale]/(participant)/(shell)/my-agenda/page.tsx`
- Modify: `src/app/[locale]/(participant)/(shell)/my-agenda/agenda-day.tsx`

- [ ] **Step 1: Update the query filter in `page.tsx`**

Change (currently `.eq('status', 'active')` in the `session_bookings` query, and add `status` to the selected columns):

```typescript
  const { data: bookings } = await supabase
    .from('session_bookings')
    .select(`
      id,
      session_id,
      booked_at,
      status,
      sessions (
        id,
        title_en,
        title_ar,
        start_time,
        end_time,
        booking_deadline,
        capacity,
        rooms ( name_en, name_ar ),
        tracks ( color ),
        conference_days ( conference_date, label_en, label_ar, display_order )
      )
    `)
    .eq('application_id', application.id)
    .in('status', ['active', 'session_cancelled'])
    .order('booked_at');
```

- [ ] **Step 2: Update `agenda-day.tsx`'s types and rendering**

Add `status: string` to the `Booking` type. In the row-rendering map, when `b.status === 'session_cancelled'`, render a badge in place of `<CancelButton ... />`:

```tsx
{b.status === 'session_cancelled' ? (
  <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
    Session Cancelled
  </span>
) : (
  <CancelButton
    bookingId={b.id}
    isPastDeadline={isPastDeadline}
    onCancelled={() => setCancelled((prev) => new Set([...prev, b.id]))}
  />
)}
```

Leave the existing `cancelled` `Set`/`visible` filter mechanism (lines 35-37) untouched — it handles participant-voluntary cancellation optimistic UI only, and is orthogonal to this new status-driven badge (per the spec's explicit note on this).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. Note: `page.tsx`'s query result flows through as an implicitly-`any`-typed value before reaching `agenda-day.tsx` (confirmed existing pattern — see its `groupByDay(bookings: any[])` and the `@typescript-eslint/no-explicit-any` suppressions already in that file), so a clean typecheck here is weak evidence that `status` was actually added to the Step 1 select list — it would stay silent even if that column were missing from the query. Manually re-read Step 1's diff to confirm `status` is genuinely present in the `.select(...)` string, rather than relying on this typecheck alone to catch that mistake.

- [ ] **Step 4: Manual verification**

With the scratch-project `.env.local` present, start the dev server, seed a throwaway fixture (a session, an accepted application, a `session_bookings` row, then trigger the cancellation path via a direct `UPDATE sessions SET status='cancelled', cancellation_reason='test'` through the service-role client), and visit `/my-agenda` as that participant. Confirm the badge renders instead of the Cancel button. Clean up the fixture. Stop the dev server when done.

- [ ] **Step 5: Commit**

```bash
git add "src/app/[locale]/(participant)/(shell)/my-agenda/page.tsx" "src/app/[locale]/(participant)/(shell)/my-agenda/agenda-day.tsx"
git commit -m "feat: show a cancelled-session badge on /my-agenda instead of dropping the booking

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Live tests for the full lifecycle

**Files:**
- Create: `tests/agenda/session-lifecycle-notifications-live.test.ts`

- [ ] **Step 1: Write the test file**

Follow the fixture conventions established in `tests/agenda/booking-allocation-conflict-live.test.ts` (same worktree history — `runId`-suffixed emails/codes, `beforeAll`/`afterAll`, dedicated room per session to avoid the `sessions_room_no_overlap` GIST exclusion constraint, a real signed-in participant client where `auth.uid()`-gated RPCs are involved). This file tests the trigger's direct effect on `session_bookings`/`session_notification_outbox` via direct `sessions` table updates (not through the admin UI/server actions, which are out of scope for a DB-level live test), covering every scenario in spec section 8:

```typescript
// tests/agenda/session-lifecycle-notifications-live.test.ts
//
// Live coverage for enforce_session_lifecycle_booking_sync() (added in
// 20261004010000_session_lifecycle_notifications.sql): cancelling a
// session must mark its active bookings 'session_cancelled' and queue one
// outbox row per booking; changing a session's time (without cancelling)
// must leave bookings 'active' and queue a reschedule outbox row;
// cancel_booking() must reject an already-session_cancelled booking.
//
// Runs against the live scratch Supabase project. Follows the room-overlap
// and auth.uid() gotchas documented in
// tests/agenda/booking-allocation-conflict-live.test.ts.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
if (!URL || !SERVICE_KEY || !ANON_KEY) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set to run this live test');
}
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
const dayOffset = Math.floor(Math.random() * 3000) + 1;
const DAY = new Date(Date.UTC(2099, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);

let conferenceDayId: string;
let trackId: string;
let sessionTypeId: string;

const roomIds: string[] = [];
const applicantUserIds: string[] = [];
const applicationIds: string[] = [];
const sessionIds: string[] = [];

async function seedAcceptedApplicant(emailSlug: string): Promise<{ applicationId: string; client: ReturnType<typeof createClient<Database>> }> {
  const email = `session-lifecycle-live-${runId}-${emailSlug}@test.local`;
  const { data: user } = await admin.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  const applicantId = user!.user!.id;
  applicantUserIds.push(applicantId);

  const { data: app } = await admin
    .from('applications')
    .insert({ applicant_id: applicantId, status: 'accepted', preferred_language: 'en', experience_level: 'beginner', interests: [] })
    .select('id')
    .single();
  applicationIds.push(app!.id);

  const client = createClient<Database>(URL, ANON_KEY);
  await client.auth.signInWithPassword({ email, password: 'password123' });

  return { applicationId: app!.id, client };
}

async function seedSession(codeSlug: string, overrides: Partial<Database['public']['Tables']['sessions']['Insert']> = {}) {
  const { data: room } = await admin.from('rooms').insert({ code: `SLC-ROOM-${codeSlug}-${runId}`, name_ar: 'قاعة', name_en: 'Room', capacity: 10 }).select('id').single();
  roomIds.push(room!.id);

  const { data } = await admin
    .from('sessions')
    .insert({
      session_code: `SLC-${codeSlug}-${runId}`,
      title_ar: 'جلسة اختبار',
      title_en: 'Test Session',
      conference_day_id: conferenceDayId,
      start_time: `${DAY}T09:00:00+03:00`,
      end_time: `${DAY}T10:00:00+03:00`,
      track_id: trackId,
      session_type_id: sessionTypeId,
      room_id: room!.id,
      language: 'en',
      difficulty_level: 'beginner',
      capacity: 10,
      min_capacity: 0,
      status: 'confirmed',
      ...overrides,
    })
    .select('id')
    .single();
  sessionIds.push(data!.id);
  return data!.id as string;
}

async function directBooking(applicationId: string, sessionId: string) {
  const { data, error } = await admin
    .from('session_bookings')
    .insert({ application_id: applicationId, session_id: sessionId, status: 'active' })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to seed session_bookings: ${error.message}`);
  return data!.id as string;
}

beforeAll(async () => {
  const { data: day } = await admin.from('conference_days').insert({ conference_date: DAY, label_ar: 'يوم اختبار', label_en: 'Test Day', display_order: 1 }).select('id').single();
  conferenceDayId = day!.id;
  const { data: track } = await admin.from('tracks').insert({ code: `SLC-TRACK-${runId}`, name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  const { data: sType } = await admin.from('session_types').insert({ code: `SLC-TYPE-${runId}`, name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sType!.id;
});

afterAll(async () => {
  await admin.from('session_notification_outbox').delete().in('session_id', sessionIds);
  await admin.from('session_bookings').delete().in('application_id', applicationIds);
  await admin.from('sessions').delete().in('id', sessionIds);
  await admin.from('rooms').delete().in('id', roomIds);
  await admin.from('session_types').delete().eq('id', sessionTypeId);
  await admin.from('tracks').delete().eq('id', trackId);
  await admin.from('conference_days').delete().eq('id', conferenceDayId);
  await admin.from('applications').delete().in('id', applicationIds);
  for (const id of applicantUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
});

describe('session cancellation syncs bookings and queues notifications', () => {
  it('marks an active booking session_cancelled and queues exactly one outbox row', async () => {
    const { applicationId } = await seedAcceptedApplicant('cancel-single');
    const sessionId = await seedSession('cancel-single');
    const bookingId = await directBooking(applicationId, sessionId);

    const { error: updateError } = await admin
      .from('sessions')
      .update({ status: 'cancelled', cancellation_reason: 'test' })
      .eq('id', sessionId);
    expect(updateError).toBeNull();

    const { data: booking } = await admin.from('session_bookings').select('status, cancelled_at').eq('id', bookingId).single();
    expect(booking?.status).toBe('session_cancelled');
    expect(booking?.cancelled_at).not.toBeNull();

    const { data: outboxRows } = await admin
      .from('session_notification_outbox')
      .select('notification_type, booking_id')
      .eq('session_id', sessionId);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows?.[0].notification_type).toBe('session_cancelled');
    expect(outboxRows?.[0].booking_id).toBe(bookingId);
  });

  it('queues one outbox row per booking when multiple participants booked the same session', async () => {
    const { applicationId: appA } = await seedAcceptedApplicant('cancel-multi-a');
    const { applicationId: appB } = await seedAcceptedApplicant('cancel-multi-b');
    const sessionId = await seedSession('cancel-multi');
    const bookingA = await directBooking(appA, sessionId);
    const bookingB = await directBooking(appB, sessionId);

    await admin.from('sessions').update({ status: 'cancelled', cancellation_reason: 'test' }).eq('id', sessionId);

    const { data: outboxRows } = await admin
      .from('session_notification_outbox')
      .select('booking_id')
      .eq('session_id', sessionId);
    expect(outboxRows).toHaveLength(2);
    const bookingIds = (outboxRows ?? []).map((r) => r.booking_id).sort();
    expect(bookingIds).toEqual([bookingA, bookingB].sort());
  });

  it('creates zero outbox rows when cancelling a session with no active bookings', async () => {
    const sessionId = await seedSession('cancel-empty');

    await admin.from('sessions').update({ status: 'cancelled', cancellation_reason: 'test' }).eq('id', sessionId);

    const { data: outboxRows } = await admin.from('session_notification_outbox').select('id').eq('session_id', sessionId);
    expect(outboxRows).toHaveLength(0);
  });

  it('cancel_booking() rejects an attempt to cancel an already-session_cancelled booking', async () => {
    const { applicationId, client } = await seedAcceptedApplicant('cancel-rpc-reject');
    const sessionId = await seedSession('cancel-rpc-reject');
    const bookingId = await directBooking(applicationId, sessionId);
    await admin.from('sessions').update({ status: 'cancelled', cancellation_reason: 'test' }).eq('id', sessionId);

    const { error } = await client.rpc('cancel_booking', { p_booking_id: bookingId, p_application_id: applicationId });
    expect(error).not.toBeNull();
    expect(error?.message).toContain('Booking is already cancelled');
  });
});

describe('session reschedule leaves bookings active and queues notifications', () => {
  it('keeps the booking active and queues exactly one reschedule outbox row with correct old/new times', async () => {
    const { applicationId } = await seedAcceptedApplicant('reschedule-single');
    const sessionId = await seedSession('reschedule-single');
    const bookingId = await directBooking(applicationId, sessionId);

    const newStart = `${DAY}T14:00:00+03:00`;
    const newEnd = `${DAY}T15:00:00+03:00`;
    const { error: updateError } = await admin
      .from('sessions')
      .update({ start_time: newStart, end_time: newEnd })
      .eq('id', sessionId);
    expect(updateError).toBeNull();

    const { data: booking } = await admin.from('session_bookings').select('status').eq('id', bookingId).single();
    expect(booking?.status).toBe('active');

    const { data: outboxRows } = await admin
      .from('session_notification_outbox')
      .select('notification_type, old_start_time, new_start_time')
      .eq('session_id', sessionId);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows?.[0].notification_type).toBe('session_rescheduled');
    expect(new Date(outboxRows![0].new_start_time!).toISOString()).toBe(new Date(newStart).toISOString());
  });

  it('queues zero outbox rows when only room_id changes (no time change)', async () => {
    const { applicationId } = await seedAcceptedApplicant('reschedule-room-only');
    const sessionId = await seedSession('reschedule-room-only');
    await directBooking(applicationId, sessionId);

    const { data: newRoom } = await admin.from('rooms').insert({ code: `SLC-ROOM-ALT-${runId}`, name_ar: 'قاعة بديلة', name_en: 'Alt Room', capacity: 10 }).select('id').single();
    roomIds.push(newRoom!.id);

    await admin.from('sessions').update({ room_id: newRoom!.id }).eq('id', sessionId);

    const { data: outboxRows } = await admin.from('session_notification_outbox').select('id').eq('session_id', sessionId);
    expect(outboxRows).toHaveLength(0);
  });
});

describe('/my-agenda query includes session_cancelled bookings, excludes participant-voluntary cancelled', () => {
  it('returns both active and session_cancelled bookings for the applicant, never plain cancelled', async () => {
    const { applicationId } = await seedAcceptedApplicant('query-filter');
    const activeSessionId = await seedSession('query-active');
    const cancelledSessionId = await seedSession('query-cancelled');
    const voluntarySessionId = await seedSession('query-voluntary');

    await directBooking(applicationId, activeSessionId);
    const sessionCancelledBookingId = await directBooking(applicationId, cancelledSessionId);
    const voluntaryBookingId = await directBooking(applicationId, voluntarySessionId);

    await admin.from('sessions').update({ status: 'cancelled', cancellation_reason: 'test' }).eq('id', cancelledSessionId);
    await admin.from('session_bookings').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', voluntaryBookingId);

    const { data: rows } = await admin
      .from('session_bookings')
      .select('id, status')
      .eq('application_id', applicationId)
      .in('status', ['active', 'session_cancelled']);

    const ids = (rows ?? []).map((r) => r.id);
    expect(ids).toContain(sessionCancelledBookingId);
    expect(ids).not.toContain(voluntaryBookingId);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/agenda/session-lifecycle-notifications-live.test.ts`
Expected: all tests pass. If any fail, root-cause and fix the ROOT CAUSE (this is new test code hitting the live schema for the first time) — do not weaken an assertion to force a pass. Known gotchas to watch for (per the precedent in `tests/agenda/booking-allocation-conflict-live.test.ts`): the `sessions_room_no_overlap` GIST exclusion constraint (this plan's `seedSession()` already gives each session its own room, matching that precedent) and any `auth.uid()`-gated RPC needing a real signed-in client rather than the service-role client (this plan's `cancel_booking()` test already uses the signed-in `client`, matching that precedent).

- [ ] **Step 3: Self-review**

Confirm all tests pass, `afterAll` cleanup leaves no orphaned rows, suite is idempotent (passes on a second consecutive run).

- [ ] **Step 4: Commit**

```bash
git add tests/agenda/session-lifecycle-notifications-live.test.ts
git commit -m "test: live coverage for session cancellation/reschedule lifecycle sync

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Final sweep verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full relevant test suites**

Run: `npx vitest run tests/agenda/ tests/email/`
Expected: all pass, including every pre-existing test from earlier sub-projects (4a, 4b) — confirming no regression.

- [ ] **Step 2: Full typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors (pre-existing unrelated errors in `tests/attendance/qr-issuance-reservation.test.ts` and `tests/attendance/qr-credentials-lifecycle-trigger.test.ts` are known and out of scope, per every prior sub-project's established baseline).

- [ ] **Step 3: Full lint**

Run: `npx eslint` on all files this branch touched.
Expected: no new issues.

- [ ] **Step 4: Dispatch final code review**

Use a code-reviewer subagent to review the entire branch diff (`git diff master...HEAD`) against the spec, confirming: the trigger's two branches are genuinely mutually exclusive and match the spec exactly; the `cancel_booking()` fix is in place; the outbox table has no client-facing RLS gap; the cron follows the exact `session-reminders/route.ts` reliability pattern (no accidental retry logic, no accidental double-send protection beyond what was explicitly decided); `/my-agenda`'s query and badge changes don't disturb the existing participant-voluntary-cancel flow; every scenario in spec section 8 has live test coverage.

- [ ] **Step 5: Proceed to superpowers:finishing-a-development-branch**
