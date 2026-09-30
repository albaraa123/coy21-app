# Email Sandbox Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a super_admin-controlled "sandbox mode" (default ON) that redirects every outbound email from the platform to one configured inbox, embeds the original recipient in the redirected body, blocks Supabase Auth invitations outright while active, shows a persistent admin-panel banner, and requires typing a fixed confirmation phrase to disable.

**Architecture:** A single guarded send layer (`fetchEmailSettings()` + `sendEmailGuarded()`) becomes the only place allowed to call `resend.emails.send(...)`. All 5 existing send call sites are updated to route through it. A new singleton `email_settings` table (RLS: any staff can read, only super_admin can write) backs the toggle. The admin layout fetches settings once per request and threads a banner prop through `AppShell`.

**Tech Stack:** Next.js Server Actions, Supabase Postgres/RLS, Resend SDK, Vitest (mocked-Resend unit tests + live RLS tests against a scratch Supabase project).

**Full design spec:** `docs/superpowers/specs/2026-09-30-email-sandbox-mode-design.md` — read this first. It documents the full reasoning behind every decision below (2 rounds of review, including a fix for a real N-database-round-trip bug in the original draft). Do not deviate from the SQL/function signatures it specifies without going back to that review process.

---

## File Structure

**New files:**
- `supabase/migrations/20260930010000_add_email_settings_table.sql` — the `email_settings` table + RLS (Task 1)
- `src/lib/email/send-guarded.ts` — `fetchEmailSettings()` + `sendEmailGuarded()`, the sole permitted callers of `resend.emails.send()` (Task 2)
- `tests/email/send-guarded.test.ts` — mocked-Resend unit tests for the 3-way branch (Task 2)
- `src/lib/auth/require-super-admin.ts` — extracted shared `requireSuperAdmin()` (Task 3)
- `src/app/[locale]/(admin)/settings/actions.ts` — Server Actions: update recipient email, enable sandbox, disable sandbox (Task 4)
- `src/app/[locale]/(admin)/settings/page.tsx` — the new settings page (Task 5)
- `src/app/[locale]/(admin)/settings/settings-form.tsx` — Client Component: recipient input, enable button, disable-with-typed-confirmation flow (Task 5)
- `src/components/shell/sandbox-banner.tsx` — the persistent banner component (Task 6)
- `tests/settings/email-settings-rls-live.test.ts` — live RLS test: staff can SELECT, only super_admin can UPDATE (Task 7)
- `tests/email/send-guarded-routing-live.test.ts` — static/grep-based live test confirming all 5 send call sites route through the guard (Task 8)

**Modified files:**
- `src/lib/email/resend.ts` — `sendRegistrationConfirmationEmail`/`sendLoginDetailsEmail` internals route through `sendEmailGuarded` (signatures unchanged) (Task 2)
- `src/app/[locale]/(admin)/communications/actions.ts` — `sendBulkEmail` fetches settings once before its loop, passes to each iteration's guarded call (Task 2)
- `src/app/api/cron/session-reminders/route.ts` — same pattern (Task 2)
- `src/app/api/cron/travel-reminders/route.ts` — same pattern (Task 2)
- `src/lib/import/invitation.ts` — `sendInvitation`/`resendInvitation` gain a hard block when sandbox is on (Task 9)
- `src/app/[locale]/(admin)/staff/actions.ts` / `src/app/[locale]/(admin)/staff/assignments/actions.ts` — both call the new shared `requireSuperAdmin()` instead of their local copies (Task 3)
- `src/app/[locale]/(admin)/layout.tsx` — fetches `email_settings` once, passes banner props to `AppShell` (Task 6)
- `src/components/shell/app-shell.tsx` — new optional `sandboxBanner?: React.ReactNode` prop, rendered between `Topbar` and the flex content row (Task 6)
- `src/lib/nav/admin-nav-config.ts` (or wherever nav entries live) — new "Settings" sidebar entry (Task 5)
- `src/messages/en.json` / `src/messages/ar.json` — new translation keys for the banner and settings page (Tasks 5, 6)

---

## Task 1: `email_settings` table + RLS

**Files:**
- Create: `supabase/migrations/20260930010000_add_email_settings_table.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 20260930010000_add_email_settings_table.sql
--
-- Singleton settings table for the email sandbox-mode feature. See
-- docs/superpowers/specs/2026-09-30-email-sandbox-mode-design.md for
-- full reasoning. `id boolean primary key default true` + the check
-- constraint is a standard Postgres pattern enforcing exactly one row —
-- any second insert attempt violates the primary key on `id = true`
-- (there is no other valid value per the check constraint).
create table email_settings (
  id boolean primary key default true,
  constraint email_settings_singleton check (id = true),
  sandbox_enabled boolean not null default true,
  sandbox_recipient_email text,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id) on delete set null
);

insert into email_settings (id) values (true);

alter table email_settings enable row level security;

create policy "staff can read email settings"
  on email_settings for select
  using (is_staff());

create policy "only super_admin can update email settings"
  on email_settings for update
  using (current_user_role() = 'super_admin')
  with check (current_user_role() = 'super_admin');
```

No `INSERT`/`DELETE` policy — the row is seeded once by this migration and never re-created or removed.

- [ ] **Step 2: Verify column/function references are real**

Confirm `is_staff()` exists (`supabase/migrations/20260929000001_migrate_staff_profiles_and_add_helper.sql`) and `current_user_role()` exists (`supabase/migrations/20260721212035_rls_policies.sql`) — both already used extensively elsewhere in this codebase's RLS policies, this migration follows the same convention, not introducing anything new.

- [ ] **Step 3: Manual review (no live DB available in a sandboxed environment)**

Same disclosed-limitation pattern as this project's other recent migrations: read the file back once for syntax correctness (balanced parens, every statement terminated, correct table/column names), disclose clearly that live application wasn't possible in this environment rather than fabricating a verification result.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260930010000_add_email_settings_table.sql
git commit -m "feat: add email_settings table with staff-read/super_admin-write RLS"
```

---

## Task 2: The guarded send layer + updating all 5 call sites

**Files:**
- Create: `src/lib/email/send-guarded.ts`
- Create: `tests/email/send-guarded.test.ts`
- Modify: `src/lib/email/resend.ts`
- Modify: `src/app/[locale]/(admin)/communications/actions.ts`
- Modify: `src/app/api/cron/session-reminders/route.ts`
- Modify: `src/app/api/cron/travel-reminders/route.ts`

**Context:** This is the core of the feature. Read the design spec's "2. The interception point" section in full before starting — it already resolved a real bug (re-fetching settings once per email in a send loop) during review; the split between `fetchEmailSettings()` (call once) and `sendEmailGuarded()` (call once per email, takes settings as a param) is deliberate and must not be collapsed back into a single self-fetching function.

- [ ] **Step 1: Write the failing unit tests for `send-guarded.ts`**

```typescript
// tests/email/send-guarded.test.ts
//
// Mocked Resend SDK coverage, same convention as tests/email/resend-send.test.ts
// (never sends a real email). Also mocks the Supabase service-role client's
// email_settings read, since fetchEmailSettings() is the function under test
// for the settings-reading half.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

describe('sendEmailGuarded', () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ data: { id: 'email_123' }, error: null });
  });

  const baseParams = {
    apiKey: 're_test',
    from: 'COY21 <no-reply@example.com>',
    replyTo: 'support@example.com',
    to: 'real-recipient@example.com',
    subject: 'Test subject',
    text: 'Test body',
    originalRecipientDescription: 'Jane Doe <real-recipient@example.com>',
  };

  it('sends unmodified to the real recipient when sandbox is disabled', async () => {
    const { sendEmailGuarded } = await import('@/lib/email/send-guarded');
    const result = await sendEmailGuarded({
      ...baseParams,
      settings: { sandboxEnabled: false, sandboxRecipientEmail: null },
    });

    expect(result.id).toBe('email_123');
    expect(result.error).toBeNull();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].to).toBe('real-recipient@example.com');
    expect(sendMock.mock.calls[0][0].text).toBe('Test body'); // not prefixed
  });

  it('blocks sending entirely when sandbox is enabled with no recipient configured', async () => {
    const { sendEmailGuarded } = await import('@/lib/email/send-guarded');
    const result = await sendEmailGuarded({
      ...baseParams,
      settings: { sandboxEnabled: true, sandboxRecipientEmail: null },
    });

    expect(result.id).toBeNull();
    expect(result.error).toContain('no recipient email is configured');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('redirects to the sandbox recipient and embeds the original recipient when sandbox is enabled with a recipient set', async () => {
    const { sendEmailGuarded } = await import('@/lib/email/send-guarded');
    const result = await sendEmailGuarded({
      ...baseParams,
      settings: { sandboxEnabled: true, sandboxRecipientEmail: 'sandbox-inbox@example.com' },
    });

    expect(result.id).toBe('email_123');
    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0][0];
    expect(call.to).toBe('sandbox-inbox@example.com');
    expect(call.text).toContain('SANDBOX MODE');
    expect(call.text).toContain('Jane Doe <real-recipient@example.com>');
    expect(call.text).toContain('Test body'); // original body still present
  });

  it('prefixes the HTML body too when an html param is given', async () => {
    const { sendEmailGuarded } = await import('@/lib/email/send-guarded');
    await sendEmailGuarded({
      ...baseParams,
      html: '<p>Original HTML</p>',
      settings: { sandboxEnabled: true, sandboxRecipientEmail: 'sandbox-inbox@example.com' },
    });

    const call = sendMock.mock.calls[0][0];
    expect(call.html).toContain('SANDBOX MODE');
    expect(call.html).toContain('Original HTML');
  });

  it('surfaces a Resend API error without throwing, same shape as before', async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: 'invalid_from_address' } });
    const { sendEmailGuarded } = await import('@/lib/email/send-guarded');

    const result = await sendEmailGuarded({
      ...baseParams,
      settings: { sandboxEnabled: false, sandboxRecipientEmail: null },
    });

    expect(result.id).toBeNull();
    expect(result.error).toBe('invalid_from_address');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/email/send-guarded.test.ts`
Expected: FAIL — `Cannot find module '@/lib/email/send-guarded'`

- [ ] **Step 3: Implement `fetchEmailSettings()` and `sendEmailGuarded()`**

```typescript
// src/lib/email/send-guarded.ts
//
// The sole permitted callers of resend.emails.send(...) in this codebase
// (excluding src/app/api/webhooks/resend/route.ts's unrelated
// new Resend('webhook_verify_only') construction, used only for webhook
// signature verification, never for sending). See
// docs/superpowers/specs/2026-09-30-email-sandbox-mode-design.md for the
// full design and the review history behind the fetchEmailSettings/
// sendEmailGuarded split — do not collapse them into one self-fetching
// function; that reintroduces a real N-database-round-trip bug for
// sendBulkEmail's and both cron routes' send loops (see part 2 of the
// spec for the exact reasoning).
import { Resend } from 'resend';
import { createServiceRoleClient } from '@/lib/supabase/server';

export interface EmailSettings {
  sandboxEnabled: boolean;
  sandboxRecipientEmail: string | null;
}

// Uses the service-role client, matching every one of this feature's 5
// send call sites (Server Actions and cron routes, none of which act on
// behalf of an end-user browser session at the point they send email).
// The email_settings table's RLS SELECT policy (staff-readable) is not
// actually exercised by this read path — it exists as defense-in-depth
// for a future direct-client read (e.g. a client component checking
// sandbox state without going through a Server Action), not as what
// makes this function safe to call. Safety here comes from every caller
// already being server-only and independently authorized (staff/
// super_admin server actions, or Bearer-token-gated cron routes).
export async function fetchEmailSettings(): Promise<EmailSettings> {
  const service = createServiceRoleClient();
  const { data } = await service.from('email_settings').select('sandbox_enabled, sandbox_recipient_email').eq('id', true).single();
  return {
    sandboxEnabled: data?.sandbox_enabled ?? true, // fail toward sandbox-on if the row is somehow unreadable
    sandboxRecipientEmail: data?.sandbox_recipient_email ?? null,
  };
}

let resendClient: Resend | null = null;
function getResendClient(apiKey: string): Resend {
  if (!resendClient) {
    resendClient = new Resend(apiKey);
  }
  return resendClient;
}

const SANDBOX_TEXT_PREFIX = (original: string) =>
  `[SANDBOX MODE — this email was NOT sent to the real recipient]\nOriginal recipient: ${original}\n---\n\n`;

const SANDBOX_HTML_PREFIX = (original: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff3cd;border:1px solid #ffe69c;border-radius:6px;margin-bottom:16px;"><tr><td style="padding:12px 16px;"><p style="margin:0;font-size:13px;color:#664d03;font-weight:bold;">SANDBOX MODE — this email was NOT sent to the real recipient</p><p style="margin:4px 0 0;font-size:13px;color:#664d03;">Original recipient: ${original}</p></td></tr></table>`;

export async function sendEmailGuarded(params: {
  settings: EmailSettings;
  apiKey: string;
  from: string;
  replyTo: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  originalRecipientDescription: string;
}): Promise<{ id: string | null; error: string | null }> {
  const { settings, apiKey, from, replyTo, subject, text, html, originalRecipientDescription } = params;

  let to = params.to;
  let finalText = text;
  let finalHtml = html;

  if (settings.sandboxEnabled) {
    if (!settings.sandboxRecipientEmail) {
      return { id: null, error: 'Sandbox mode is enabled but no recipient email is configured. Set one in Settings before any email can be sent.' };
    }
    to = settings.sandboxRecipientEmail;
    finalText = SANDBOX_TEXT_PREFIX(originalRecipientDescription) + text;
    if (html) {
      finalHtml = SANDBOX_HTML_PREFIX(originalRecipientDescription) + html;
    }
  }

  const { data, error } = await getResendClient(apiKey).emails.send({
    from,
    replyTo,
    to,
    subject,
    text: finalText,
    ...(finalHtml ? { html: finalHtml } : {}),
  });

  return { id: data?.id ?? null, error: error ? error.message : null };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/email/send-guarded.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Update `resend.ts`'s two functions to route through the guard**

In `src/lib/email/resend.ts`, both `sendRegistrationConfirmationEmail` and `sendLoginDetailsEmail` keep their exact existing signatures (external callers are unaffected). Replace their final `getResendClient(config.apiKey).emails.send({...})` call with a call to `fetchEmailSettings()` then `sendEmailGuarded()`. Example for `sendRegistrationConfirmationEmail`:

```typescript
import { fetchEmailSettings, sendEmailGuarded } from './send-guarded';

export async function sendRegistrationConfirmationEmail(params: {
  to: string;
  fullName: string;
  applicationNumber: string;
  locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> {
  const configResult = getResendConfig();
  if (!configResult.ok) {
    return { id: null, error: `Resend not configured: missing ${configResult.missing.join(', ')}` };
  }
  const { config } = configResult;

  const subject = /* unchanged */ ...;
  const body = /* unchanged */ ...;

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

Apply the same transformation to `sendLoginDetailsEmail` (keep its existing `subject`/`text`/`html` construction exactly as-is, only change the final send call). Remove the now-unused local `getResendClient` from `resend.ts` if nothing else in that file calls it directly after this change (check before removing).

- [ ] **Step 6: Run the existing `resend-send.test.ts` suite to confirm no regression**

Run: `npx vitest run tests/email/resend-send.test.ts`
Expected: PASS, unchanged — these tests mock the `resend` module directly and assert on the final call shape reaching it; since sandbox defaults to disabled in this test file's env setup (no `email_settings` mock needed if `fetchEmailSettings()` itself needs mocking — see note below), the assertions on `call.to`/`call.text`/`call.html` should still hold as long as `fetchEmailSettings()` is also mocked to return `{ sandboxEnabled: false, sandboxRecipientEmail: null }` in this test file. Add that mock if the test run reveals it's needed (e.g. `vi.mock('@/lib/email/send-guarded', async (importOriginal) => { ... })` or mock the underlying service-role client) — do not skip this step if the existing suite breaks; fix the test's mocking to match the new call path rather than declaring it "close enough."

- [ ] **Step 7: Update `sendBulkEmail`**

In `src/app/[locale]/(admin)/communications/actions.ts`, replace the direct `new Resend(config.apiKey)` construction and the loop's `resend.emails.send({...})` call:

```typescript
import { fetchEmailSettings, sendEmailGuarded } from '@/lib/email/send-guarded';

// ... after resolving `recipients`, BEFORE the loop:
const settings = await fetchEmailSettings();

for (const r of recipients) {
  const personalizedBody = params.body.replace(/\{\{name\}\}/g, r.name);
  const { error } = await sendEmailGuarded({
    settings, // same resolved value reused every iteration — fetched once above
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: r.email,
    subject: params.subject,
    text: personalizedBody,
    originalRecipientDescription: `${r.name} <${r.email}>`,
  });
  if (error) {
    failed++;
  } else {
    sent++;
  }
}
```

Remove the `new Resend(config.apiKey)` line and the now-unused `Resend` import if nothing else in this file needs it.

- [ ] **Step 8: Update `session-reminders/route.ts`**

Fetch settings once, right after `const service = createServiceRoleClient();` (before any per-session/per-booking loop):

```typescript
import { fetchEmailSettings, sendEmailGuarded } from '@/lib/email/send-guarded';

// ... replace `const resend = new Resend(config.apiKey);` with:
const settings = await fetchEmailSettings();
```

Then replace the inner loop's `resend.emails.send({...})` call:

```typescript
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
```

Remove the now-unused `Resend` import if nothing else in this file needs it.

- [ ] **Step 9: Update `travel-reminders/route.ts`**

Same pattern as Steps 5/7/8, but this call site is structurally different: it uses `Promise.all` batching (`BATCH_SIZE = 10`) rather than a plain loop, and the per-recipient send logic lives in a separate `sendTravelReminder` helper function that currently takes a `resend: Resend` instance as a parameter. `sendEmailGuarded` constructs its own client internally from an `apiKey` string, so `sendTravelReminder` no longer needs (or should keep) a `Resend` param.

Fetch settings once, right after `const service = createServiceRoleClient();` (before the batching loop):

```typescript
import { fetchEmailSettings, sendEmailGuarded } from '@/lib/email/send-guarded';

// ... replace `const resend = new Resend(config.apiKey);` with:
const settings = await fetchEmailSettings();
```

Update the batching loop's call site — `resend` is no longer threaded through, `settings` is:

```typescript
const BATCH_SIZE = 10;
for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
  const batch = recipients.slice(i, i + BATCH_SIZE);
  const results = await Promise.all(
    batch.map((recipient) => sendTravelReminder(settings, config, appUrl, recipient))
  );
  for (const ok of results) {
    if (ok) sent++;
    else failed++;
  }
}
```

Update `sendTravelReminder`'s signature — drop the `resend: Resend` param, add `settings: EmailSettings` as the new first param, and replace its `resend.emails.send({...})` call with `sendEmailGuarded({...})`:

```typescript
async function sendTravelReminder(
  settings: EmailSettings,
  config: { fromEmail: string; replyToEmail: string; supportEmail: string; apiKey: string },
  appUrl: string,
  profile: { email: string; fullName: string }
): Promise<boolean> {
  // ...unchanged subject/text/html construction above...

  const { error: sendErr } = await sendEmailGuarded({
    settings,
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: profile.email,
    subject,
    text,
    html,
    originalRecipientDescription: `${profile.fullName} <${profile.email}>`,
  });

  return !sendErr;
}
```

`config` here is the object returned by `getResendConfig()` — confirm it already exposes `apiKey` alongside `fromEmail`/`replyToEmail`/`supportEmail` (it does, per `resend-config.ts`); if the local `config` destructuring in this route only pulls a subset of fields into the object passed to `sendTravelReminder`, widen it to include `apiKey`. Remove the now-unused `Resend` import if nothing else in this file needs it.

- [ ] **Step 10: Run the full email-related test suite**

```bash
npx vitest run tests/email tests/communications 2>&1
```

Expected: all pass. If `tests/communications` doesn't exist as a path, adjust to whatever test files cover `sendBulkEmail` (search first: `grep -rl "sendBulkEmail" tests/`).

- [ ] **Step 11: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: no new errors beyond this repo's known ~394-error baseline (stale generated types in `tests/attendance/qr-issuance-reservation.test.ts` and `tests/attendance/qr-credentials-lifecycle-trigger.test.ts` — unrelated, pre-existing, do not chase).

- [ ] **Step 12: Commit**

```bash
git add src/lib/email/send-guarded.ts tests/email/send-guarded.test.ts src/lib/email/resend.ts src/app/[locale]/\(admin\)/communications/actions.ts src/app/api/cron/session-reminders/route.ts src/app/api/cron/travel-reminders/route.ts
git commit -m "feat: add guarded email send layer, route all 5 existing send paths through it"
```

---

## Task 3: Extract shared `requireSuperAdmin()`

**Files:**
- Create: `src/lib/auth/require-super-admin.ts`
- Modify: `src/app/[locale]/(admin)/staff/actions.ts`
- Modify: `src/app/[locale]/(admin)/staff/assignments/actions.ts`

**Context:** `requireSuperAdmin()` is currently duplicated verbatim in these two files. This task extracts it to a shared location before Task 4 needs a third copy for the settings actions — do this extraction now rather than adding a fourth near-duplicate.

- [ ] **Step 1: Read both existing copies — they are NOT identical, do not assume otherwise**

Despite the design spec describing these as "identical shape," they differ in a real way. Confirmed directly:

- `src/app/[locale]/(admin)/staff/actions.ts:24-38` — queries `profiles.select('role')`, returns `{ service }` only.
- `src/app/[locale]/(admin)/staff/assignments/actions.ts:8-22` — queries `profiles.select('id, role')`, returns `{ service, userId: profile.id }`. `userId` is used by this file's `createAssignment` (line 48: `created_by: userId`).

The shared function must return the **superset** shape (`{ service, userId }`) so `assignments/actions.ts`'s existing `userId` usage keeps working, and so Task 4's settings actions can use `userId` too instead of the awkward inline `createClient()`/`auth.getUser()` re-fetch a naive extraction would otherwise need. `staff/actions.ts`'s 3 call sites only ever destructure `{ service }` today — receiving an object that also has a `userId` field is harmless to them (unused destructured fields are simply not requested), so widening the shared function's return shape does not break `staff/actions.ts`.

- [ ] **Step 2: Write the shared module with the superset return shape**

```typescript
// src/lib/auth/require-super-admin.ts
//
// Extracted from src/app/[locale]/(admin)/staff/actions.ts and
// src/app/[locale]/(admin)/staff/assignments/actions.ts. These two
// files' local copies were NOT identical before this extraction —
// assignments/actions.ts's version also returned `userId` (the caller's
// own profile id, used for `created_by` on inserts) and queried
// `profiles.select('id, role')` instead of just `role`. This shared
// version uses assignments/actions.ts's superset shape so both files'
// existing usages keep working: staff/actions.ts's 3 call sites only
// ever destructured `{ service }` and are unaffected by the extra field.
//
// Any Server Action that must be callable by super_admin only (not any
// staff role) uses this — do not use isStaffRole/is_staff() for this
// purpose, which is deliberately broader.
import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

export async function requireSuperAdmin() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    throw new Error('Unauthenticated');
  }
  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('id, role').eq('id', user.id).single();
  if (!profile || profile.role !== 'super_admin') {
    throw new Error('Forbidden: super_admin only');
  }
  return { service, userId: profile.id };
}
```

- [ ] **Step 3: Update both existing call sites**

In both `src/app/[locale]/(admin)/staff/actions.ts` and `src/app/[locale]/(admin)/staff/assignments/actions.ts`: delete the local `requireSuperAdmin` function definition, add `import { requireSuperAdmin } from '@/lib/auth/require-super-admin';` at the top. `assignments/actions.ts`'s existing `const { service, userId } = await requireSuperAdmin();` (line 37) and its `userId` usage (line 48) need NO changes — the shared function's return shape matches exactly. `staff/actions.ts`'s existing `const { service } = await requireSuperAdmin();` call sites (lines 48, 76, 87) also need no changes — they simply don't destructure the now-available `userId` field, which is fine.

- [ ] **Step 4: Run the existing staff-management test suite**

```bash
grep -rl "requireSuperAdmin\|createStaffAccount\|updateStaffRole\|deleteStaffAccount" tests/ 
```

Run whatever test files that returns, confirm all still pass unchanged.

- [ ] **Step 5: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth/require-super-admin.ts "src/app/[locale]/(admin)/staff/actions.ts" "src/app/[locale]/(admin)/staff/assignments/actions.ts"
git commit -m "refactor: extract requireSuperAdmin to a shared module, using the userId-returning superset shape"
```

---

## Task 4: Settings Server Actions

**Files:**
- Create: `src/app/[locale]/(admin)/settings/actions.ts`

**Context:** Three actions: update the recipient email, enable sandbox mode (simple, no confirmation), disable sandbox mode (gated by the typed-confirmation flow's server-side check — the CLIENT enforces the typed phrase for UX, but the SERVER must not trust that alone; it re-validates the same phrase was sent, matching this codebase's general principle that RLS/server checks are the real boundary, UI is a convenience).

- [ ] **Step 1: Write the actions**

```typescript
// src/app/[locale]/(admin)/settings/actions.ts
'use server';

import { requireSuperAdmin } from '@/lib/auth/require-super-admin';
import { revalidatePath } from 'next/cache';

const DISABLE_CONFIRMATION_PHRASE = 'DISABLE';

export async function updateSandboxRecipient(email: string): Promise<{ error: string | null }> {
  const { service, userId } = await requireSuperAdmin();
  const trimmed = email.trim();
  if (trimmed.length === 0) {
    return { error: 'Recipient email cannot be empty' };
  }
  // Minimal shape check only — this is an internal operator-configured
  // address, not user-facing input requiring exhaustive validation.
  if (!trimmed.includes('@')) {
    return { error: 'Enter a valid email address' };
  }

  const { error } = await service
    .from('email_settings')
    .update({ sandbox_recipient_email: trimmed, updated_at: new Date().toISOString(), updated_by: userId })
    .eq('id', true);

  if (error) return { error: error.message };
  revalidatePath('/[locale]/(admin)', 'layout');
  return { error: null };
}

export async function enableSandboxMode(): Promise<{ error: string | null }> {
  const { service, userId } = await requireSuperAdmin();
  const { error } = await service
    .from('email_settings')
    .update({ sandbox_enabled: true, updated_at: new Date().toISOString(), updated_by: userId })
    .eq('id', true);

  if (error) return { error: error.message };
  revalidatePath('/[locale]/(admin)', 'layout');
  return { error: null };
}

export async function disableSandboxMode(confirmationText: string): Promise<{ error: string | null }> {
  const { service, userId } = await requireSuperAdmin();
  if (confirmationText !== DISABLE_CONFIRMATION_PHRASE) {
    return { error: `You must type exactly "${DISABLE_CONFIRMATION_PHRASE}" to confirm.` };
  }

  const { error } = await service
    .from('email_settings')
    .update({ sandbox_enabled: false, updated_at: new Date().toISOString(), updated_by: userId })
    .eq('id', true);

  if (error) return { error: error.message };
  revalidatePath('/[locale]/(admin)', 'layout');
  return { error: null };
}
```

This is exactly why Task 3's shared `requireSuperAdmin()` was corrected to return `{ service, userId }` rather than the narrower `{ service }` — these three actions all need `userId` for `updated_by`, and now get it directly from the same call that already does the super_admin check, with no second client/session fetch needed.

- [ ] **Step 2: Check for an existing test pattern for similar settings-style actions**

```bash
grep -rl "updateStaffRole\|createStaffAccount" tests/
```

Read the resulting test file's structure for the established pattern of testing a `requireSuperAdmin()`-gated Server Action (likely a live test using service-role + a staff-vs-super_admin fixture, given these actions touch a real table via RLS). Follow that same structure for this task's tests rather than inventing a new one.

- [ ] **Step 3: Write live tests**

Create `tests/settings/email-settings-actions-live.test.ts` (or extend an existing settings test file if Step 2 found one) covering: a `super_admin` fixture can call all 3 actions successfully; a `staff` fixture gets a thrown/rejected error from all 3 (since `requireSuperAdmin` throws, not returns an error object, for the auth failure itself — confirm this matches `requireSuperAdmin`'s actual throw-vs-return contract from Task 3); `disableSandboxMode` with a wrong confirmation string returns the typed error and does NOT flip `sandbox_enabled` to false (verify via a service-role read after the call).

- [ ] **Step 4: Run tests if live credentials available; otherwise disclose clearly**

```bash
npx vitest run tests/settings/email-settings-actions-live.test.ts
```

- [ ] **Step 5: Run typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add "src/app/[locale]/(admin)/settings/actions.ts" tests/settings/
git commit -m "feat: add settings Server Actions for email sandbox mode"
```

---

## Task 5: Settings page UI

**Files:**
- Create: `src/app/[locale]/(admin)/settings/page.tsx`
- Create: `src/app/[locale]/(admin)/settings/settings-form.tsx`
- Modify: nav config (whichever file defines `adminNavGroups`, likely `src/lib/nav/admin-nav-config.ts`)
- Modify: `src/messages/en.json`, `src/messages/ar.json`

**Context:** First settings page in the platform. `page.tsx` (Server Component) fetches the current `email_settings` row and the caller's role, passes both to `settings-form.tsx` (Client Component) which renders the read-only view for `staff` and the editable controls for `super_admin`. The disable flow's typed-confirmation UI is new to this codebase — no existing component to copy; build it as a simple inline reveal (matching `staff-manager.tsx`'s general two-step-reveal spirit) with a text input whose value must exactly match `"DISABLE"` before the confirm button's `disabled` prop clears.

- [ ] **Step 1: Read `staff-manager.tsx` fully for the established component conventions**

(File path: `src/app/[locale]/(admin)/staff/staff-manager.tsx`.) Match its button variants (`destructive`/`secondary`), its `role="alert"` error-banner pattern, its `submitting` state disabling buttons mid-flight, and its general two-column form-field layout style so this new page looks native to the codebase rather than introducing a new visual language.

- [ ] **Step 2: Write `page.tsx`**

Fetch `email_settings` (service-role, one row via `.eq('id', true).single()`) and the caller's role (same pattern as every other admin page — `createClient()` + `createServiceRoleClient()` + `profiles.select('role')`). Pass both down to `SettingsForm`.

- [ ] **Step 3: Write `settings-form.tsx`**

Client Component. Props: current `sandboxEnabled`, `sandboxRecipientEmail`, `isSuperAdmin` (boolean — drives whether editable controls render at all, matching the codebase's "RLS is the real boundary, UI reflects it" convention). State: recipient input value, disable-confirmation text input value, submitting flags, error message. Calls the 3 Server Actions from Task 4. The disable button's confirm-button `disabled` prop is `confirmationInput !== 'DISABLE'`.

- [ ] **Step 4: Add the sidebar nav entry**

Find the file defining `adminNavGroups` (likely `src/lib/nav/admin-nav-config.ts` — confirm via `grep -rl "adminNavGroups" src/lib/nav/`), add a new `NavItem` for `/settings` in whichever group is most appropriate (or a new group if none fits — check the existing group structure first). Add corresponding translation keys.

- [ ] **Step 5: Add translation keys**

Add whatever `en.json`/`ar.json` keys the page and form need (labels, button text, confirmation prompt, error messages). For `ar.json`, write new keys with correct UTF-8 encoding — this repo has a known pre-existing, unrelated mojibake corruption in that file; do not propagate it into new keys, and do not attempt to fix the pre-existing corruption (explicitly out of scope, documented in prior work on this repo).

- [ ] **Step 6: Manual verification (disclosed limitation if no browser available)**

If a dev server can be started and connected to a real/scratch Supabase project with a `staff` and a `super_admin` test account, sign in as each and confirm: staff sees read-only state, super_admin sees editable controls, the disable-confirmation button stays disabled until the exact phrase is typed. If not possible in this environment, disclose clearly rather than claiming success without having seen it.

- [ ] **Step 7: Run typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add "src/app/[locale]/(admin)/settings/" src/lib/nav/ src/messages/
git commit -m "feat: add email sandbox mode settings page"
```

---

## Task 6: Admin-panel banner

**Files:**
- Create: `src/components/shell/sandbox-banner.tsx`
- Modify: `src/components/shell/app-shell.tsx`
- Modify: `src/app/[locale]/(admin)/layout.tsx`

**Context:** The banner must appear on every admin page regardless of which one is open. `(admin)/layout.tsx` is the single choke point already confirmed by the design spec's research — it already runs a service-role query for the caller's profile, so adding one more `email_settings` read alongside it is a small, consistent addition (this is a SEPARATE read from Task 2's `fetchEmailSettings()` used at send-time — both read the same table, but this one is for display, not for gating a send; sharing the same helper function is fine and preferred over duplicating the query).

- [ ] **Step 1: Write `sandbox-banner.tsx`**

A simple server component (no client state needed — it's a static display of props passed in):

```typescript
// src/components/shell/sandbox-banner.tsx
export function SandboxBanner({ recipientEmail }: { recipientEmail: string | null }) {
  return (
    <div role="status" className="w-full bg-amber-100 border-b border-amber-300 px-4 py-2 text-sm text-amber-900">
      {recipientEmail
        ? `Sandbox mode is ON — all outgoing email is redirected to ${recipientEmail}.`
        : 'Sandbox mode is ON, but no redirect email is set — all sending is currently blocked. Configure one in Settings.'}
    </div>
  );
}
```

(Colors/classes should match this codebase's existing Tailwind design tokens — check `staff-manager.tsx`'s `role="alert"` error banner styling for the established warning-color convention rather than inventing new amber/yellow shades.)

- [ ] **Step 2: Add the prop to `AppShell`**

In `src/components/shell/app-shell.tsx`, add `sandboxBanner?: React.ReactNode` to `AppShellProps`, render it as a new element directly after `<Topbar .../>` and before the `<MobileDrawer .../>`/`<div className="flex flex-1">` block (i.e., full-width, above everything else, matching the design spec's placement description). Omit it entirely (render nothing) when the prop is undefined — the participant-facing shell never passes this prop, so its behavior is unaffected.

- [ ] **Step 3: Wire it up in `(admin)/layout.tsx`**

Add an `email_settings` fetch (reuse `fetchEmailSettings()` from `src/lib/email/send-guarded.ts` — same function, different call site, avoids a second near-duplicate query) alongside the existing `profile` fetch. Pass `sandboxBanner={settings.sandboxEnabled ? <SandboxBanner recipientEmail={settings.sandboxRecipientEmail} /> : null}` to `<AppShell>`.

- [ ] **Step 4: Check for an existing `AppShell` test file and update if needed**

```bash
grep -rl "AppShell\|app-shell" tests/
```

If a test file renders `AppShell` and asserts on its structure via `renderToStaticMarkup` (this codebase's established no-jsdom testing convention), add a case confirming the banner renders when `sandboxBanner` is provided and doesn't when omitted.

- [ ] **Step 5: Run typecheck and the relevant test suite**

```bash
npx tsc --noEmit
npx vitest run tests/shell tests/components/shell
```

- [ ] **Step 6: Commit**

```bash
git add src/components/shell/sandbox-banner.tsx src/components/shell/app-shell.tsx "src/app/[locale]/(admin)/layout.tsx" tests/
git commit -m "feat: show a persistent sandbox-mode banner across the admin panel"
```

---

## Task 7: Live RLS test for `email_settings`

**Files:**
- Create: `tests/settings/email-settings-rls-live.test.ts`

**Context:** Proves the RLS policies from Task 1 actually behave as designed against a real Postgres instance — a `staff` session can read but not write, a `super_admin` session can do both. This is distinct from Task 4's action-level tests (which test the Server Action's own `requireSuperAdmin()` guard, a code-level check) — this test proves the DATABASE-level guarantee holds even if a future code change accidentally bypassed the Server Action layer.

- [ ] **Step 1: Write the test**

Follow this repo's established live-RLS-test pattern (see `tests/auth/staff-roles-live.test.ts`'s sensitive-data-RLS block for the exact shape: create throwaway `staff` and `super_admin` fixtures, sign in as each via the anon client, attempt reads/writes, assert on the RLS-driven outcome via a service-role cross-check). Specifically:

- A `staff`-scoped client can `SELECT` from `email_settings` and gets the row back.
- A `staff`-scoped client's `UPDATE` attempt on `email_settings` is rejected (either an explicit error or a silent no-op under RLS's default-deny UPDATE semantics — assert via a service-role re-read that nothing changed, matching the pattern already established for the equivalent profiles-role-boundary test).
- A `super_admin`-scoped client can both `SELECT` and successfully `UPDATE`.
- A `participant`-scoped client cannot `SELECT` at all (confirms `is_staff()` genuinely excludes participants, not just "any authenticated user").

- [ ] **Step 2: Run if live credentials available; otherwise disclose clearly**

```bash
npx vitest run tests/settings/email-settings-rls-live.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add tests/settings/email-settings-rls-live.test.ts
git commit -m "test: add live RLS verification for email_settings table"
```

---

## Task 8: Routing verification (grep-based live test)

**Files:**
- Create: `tests/email/send-guarded-routing-live.test.ts`

**Context:** Per the design spec's Testing section: confirms zero remaining direct `new Resend(...)` / `.emails.send()` construction anywhere in `src/` outside `send-guarded.ts` itself — with an explicit exclusion for `src/app/api/webhooks/resend/route.ts`'s unrelated `new Resend('webhook_verify_only')` signature-verification usage (this exclusion was added during spec review specifically to prevent a permanent false positive; do not omit it).

**Scope note:** `walk()` below only scans `src/`, not `tests/`. This is deliberate — every real email-send call site in this codebase lives under `src/` (the 5 sites this plan touches, plus the excluded webhook route), and test files legitimately contain their own `new Resend(...)` mock/stub constructions (e.g. `tests/email/resend-send.test.ts`'s `vi.mock('resend', ...)` shim) that are not production send paths and would be false positives if swept. Do not widen `walk()` to include `tests/` — that would break this test against its own supporting fixtures. The test's docstring and assertion name should make this `src/`-only scope explicit so a future reader doesn't assume a broader guarantee than what's actually checked.

- [ ] **Step 1: Write the test**

```typescript
// tests/email/send-guarded-routing-live.test.ts
//
// Static verification (not a live-DB test despite the file suffix
// convention — "live" here means "checks real repo file contents," not
// "hits a live Supabase project") that every email-sending call site in
// src/ routes through sendEmailGuarded rather than constructing its own
// Resend client. See docs/superpowers/specs/2026-09-30-email-sandbox-mode-design.md's
// Testing section for why the webhook route is explicitly excluded.
//
// Scope: this only scans src/, not tests/. Every real send call site lives
// under src/; test files legitimately mock `new Resend(...)` (e.g.
// tests/email/resend-send.test.ts's vi.mock('resend', ...) shim) and would
// be false positives if swept. Do not widen walk() to include tests/.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const EXCLUDED_FILES = [
  'src/lib/email/send-guarded.ts', // the guard itself, legitimately constructs Resend
  'src/app/api/webhooks/resend/route.ts', // signature verification only, never sends
];

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      files.push(full);
    }
  }
  return files;
}

describe('every email send call site routes through sendEmailGuarded', () => {
  it('no file outside the excluded list constructs its own Resend client or calls .emails.send() directly', () => {
    const violations: string[] = [];
    for (const file of walk('src')) {
      const relative = file.replace(/\\/g, '/');
      if (EXCLUDED_FILES.some((excluded) => relative.endsWith(excluded))) continue;
      const content = readFileSync(file, 'utf-8');
      if (/new Resend\(/.test(content) || /\.emails\.send\(/.test(content)) {
        violations.push(relative);
      }
    }
    expect(violations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

```bash
npx vitest run tests/email/send-guarded-routing-live.test.ts
```

Expected: PASS. If it fails, that means Task 2 missed a call site — go back and fix Task 2's changes, do not adjust this test's exclusion list to paper over a real miss.

- [ ] **Step 3: Commit**

```bash
git add tests/email/send-guarded-routing-live.test.ts
git commit -m "test: verify no email call site bypasses the guarded send layer"
```

---

## Task 9: Block invitations while sandbox mode is active

**Files:**
- Modify: `src/lib/import/invitation.ts`

**Context:** `sendInvitation`/`resendInvitation` use Supabase Auth's own `inviteUserByEmail`, which this codebase has no control over the body of — per the design spec's explicit decision, these are blocked outright while sandbox mode is on, not redirected.

- [ ] **Step 1: Read the current file fully**

```bash
cat src/lib/import/invitation.ts
```

Confirm both functions' current return-type shape (the design spec references `{ success: false, error: ... }` as an example — verify the actual shape before matching it).

- [ ] **Step 2: Add the guard to both functions**

At the start of both `sendInvitation` and `resendInvitation`, before any call to `service.auth.admin.inviteUserByEmail(...)`:

```typescript
import { fetchEmailSettings } from '@/lib/email/send-guarded';

// ... inside each function, before the invite call:
const settings = await fetchEmailSettings();
if (settings.sandboxEnabled) {
  return { success: false, error: 'Invitations are disabled while sandbox mode is enabled.' } /* match this function's exact existing return shape */;
}
```

- [ ] **Step 3: Update/add tests**

```bash
grep -rl "sendInvitation\|resendInvitation" tests/
```

Read the existing test file(s), add cases confirming: sandbox enabled → invite blocked, `inviteUserByEmail` never called; sandbox disabled → existing behavior unchanged (mock `fetchEmailSettings` appropriately, matching whatever mocking convention Task 2's Step 6 established for the `resend-send.test.ts` fix).

- [ ] **Step 4: Run tests and typecheck**

```bash
npx vitest run tests/import
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/import/invitation.ts tests/import/
git commit -m "feat: block registration invitations while email sandbox mode is enabled"
```

---

## Task 10: Final verification sweep

**Files:** none

- [ ] **Step 1:** Run the full test suite: `npx vitest run`. Confirm no NEW failures beyond this repo's known pre-existing baseline (live-DB tests failing on missing env vars in a sandboxed environment; the 13 known pre-existing non-live failures in `tests/lib/nav/*` and `tests/components/not-found-state.test.tsx`, both unrelated to this feature and predating it).
- [ ] **Step 2:** Run `npx tsc --noEmit`, confirm the error count matches the known ~394 baseline with nothing new.
- [ ] **Step 3:** Re-run Task 8's routing-verification test specifically, one more time, as the definitive proof no call site was missed across the whole plan's execution.
- [ ] **Step 4:** If a scratch Supabase project is available, apply Task 1's migration to it and manually walk through: sandbox on with no recipient → attempt sends from each of the 5 paths (or as many as can be feasibly triggered manually) → confirm all report the "no recipient configured" error, none reaches Resend; set a recipient → repeat → confirm redirected emails arrive with the original-recipient banner; disable sandbox mode via the settings page → confirm the typed-confirmation gate genuinely blocks a wrong phrase and accepts the exact one. If no scratch project is available in this environment, disclose this clearly as a limitation rather than claiming it was verified.
- [ ] **Step 5:** Report completion — summarize what was built, confirm sub-project 2 of 6 is done, and that sub-project 3 (import/classification/approval workflow) is ready to start whenever the user chooses.
