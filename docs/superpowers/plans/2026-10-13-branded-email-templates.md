# Branded Email Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every one of the 12 email-sending functions in `src/lib/email/resend.ts` a real, branded HTML body (currently all send plain `text` only) using a shared, reusable template builder, without changing any existing subject line, plain-text body, or send/recipient logic.

**Architecture:** One new file, `src/lib/email/html-template.ts`, exports a `buildBrandedEmailHtml()` function producing a table-based, inline-styled HTML email (the only layout approach that renders consistently across email clients) with a navy header containing the real COY21 logo, an optional colored status badge, content paragraphs, an optional CTA button, and a footer. Each of the 12 functions in `resend.ts` gets one new call into this builder, passed alongside the existing unchanged `text:` value to `sendEmailGuarded`. `sendLoginDetailsEmail`'s existing bespoke `buildLoginDetailsHtml` is deleted and replaced by two calls into the shared builder (one per locale) assembled into one bilingual page.

**Tech Stack:** TypeScript, Vitest (existing test conventions in `tests/email/*`), Resend (already integrated, unchanged).

---

## Context for the implementer

Read these first:

- **Spec:** `docs/superpowers/specs/2026-10-13-branded-email-templates-design.md` — the full approved design. This plan implements it; if anything here seems to contradict the spec, the spec wins.
- **Target file:** `src/lib/email/resend.ts` (604 lines) — contains all 12 email-sending functions plus the existing `escapeHtml` helper (lines 501-508) and the existing `buildLoginDetailsHtml` (lines 510-603, which this plan deletes and replaces).
- **`src/lib/email/send-guarded.ts`** — `sendEmailGuarded` already accepts an optional `html?: string` param and prepends a standalone sandbox-mode warning table before it when sandbox is on. Nothing here needs to change; this plan only ever adds a new `html:` argument to existing calls.
- **Brand colors** (from `src/app/globals.css`): navy `#053269` (CSS var `--color-turquoise`, despite the name), green `#3d9920`, blue `#019de6`, charcoal `#0a1a2e`, warm-white `#f0f4f8`.
- **Logo:** `public/brand/logo/logo-horizontal-white.png` is served at `/brand/logo/logo-horizontal-white.png` by this Next.js app (confirmed: no `basePath`/`assetPrefix`/rewrites). The HTML template references it as `${appUrl}/brand/logo/logo-horizontal-white.png` — every caller already has `appUrl` available from `getResendConfig()`'s `config.appUrl`.
- **Existing test files to update:** `tests/email/resend-send.test.ts` (`sendLoginDetailsEmail`), `tests/email/session-lifecycle-notifications.test.ts` (cancellation/reschedule), `tests/email/application-decision-and-booking-notifications.test.ts` (accepted/rejected/booking-confirmed/announcement), `tests/email/work-group-waitlist-notification.test.ts` (waitlist-promotion). All 4 share an identical mocking pattern: `vi.mock('resend', ...)` intercepting the SDK class, `vi.mock('@/lib/email/send-guarded', ...)` forcing `fetchEmailSettings` to resolve sandbox-disabled, and a `beforeEach`/`afterEach` pair saving/restoring `RESEND_API_KEY`/`RESEND_FROM_EMAIL`/`RESEND_REPLY_TO_EMAIL`/`APP_URL`/`PARTICIPANT_SUPPORT_EMAIL` env vars. New test files for the 4 currently-untested functions should copy this exact pattern.
- **4 functions with NO existing test file:** `sendRegistrationConfirmationEmail`, `sendClassificationChangeNotificationEmail`, `sendSessionReminderEmail`, `sendTravelReminderEmail`. This plan adds one new test file covering all 4, since they're all small and don't warrant 4 separate files.
- **Run tests with:** `npm test` (= `vitest run`) from the worktree root.

## File Structure

- **Create:** `src/lib/email/html-template.ts` — the shared template builder. New, focused file (not added to the already-large `resend.ts`), matching the spec's explicit file-separation decision.
- **Create:** `tests/email/html-template.test.ts` — unit tests for the builder itself (badge rendering, escaping, bilingual concatenation, `\n` → `<br>`).
- **Create:** `tests/email/untested-notification-functions.test.ts` — new coverage for the 4 previously-untested functions.
- **Modify:** `src/lib/email/resend.ts` — add one `buildBrandedEmailHtml(...)` call + `html:` argument to each of 12 functions; delete `buildLoginDetailsHtml` (lines 510-603) and its call site, replacing with 2 calls into the new shared builder.
- **Modify:** `tests/email/resend-send.test.ts`, `tests/email/session-lifecycle-notifications.test.ts`, `tests/email/application-decision-and-booking-notifications.test.ts`, `tests/email/work-group-waitlist-notification.test.ts` — add an `html`-presence assertion to each existing describe block.

---

### Task 1: Shared HTML template builder

**Files:**
- Create: `src/lib/email/html-template.ts`
- Test: `tests/email/html-template.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/email/html-template.test.ts
import { describe, it, expect } from 'vitest';
import { buildBrandedEmailHtml } from '@/lib/email/html-template';

const BASE_PARAMS = {
  locale: 'en' as const,
  heading: 'Test Heading',
  paragraphs: ['First paragraph.', 'Second paragraph.'],
  logoUrl: 'https://example.com/brand/logo/logo-horizontal-white.png',
};

describe('buildBrandedEmailHtml', () => {
  it('renders the logo image with the given URL', () => {
    const html = buildBrandedEmailHtml(BASE_PARAMS);
    expect(html).toContain('https://example.com/brand/logo/logo-horizontal-white.png');
    expect(html).toContain('<img');
  });

  it('renders every paragraph as its own <p>', () => {
    const html = buildBrandedEmailHtml(BASE_PARAMS);
    expect(html).toContain('First paragraph.');
    expect(html).toContain('Second paragraph.');
    expect((html.match(/<p/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('converts a single newline within one paragraph into <br>, not a dropped character or a new <p>', () => {
    const html = buildBrandedEmailHtml({
      ...BASE_PARAMS,
      paragraphs: ['Previous time: 10:00\nNew time: 11:00'],
    });
    expect(html).toContain('Previous time: 10:00<br');
    expect(html).toContain('New time: 11:00');
    expect(html).not.toContain('Previous time: 10:00\nNew time: 11:00');
  });

  it('renders no badge markup when badge is omitted', () => {
    const html = buildBrandedEmailHtml(BASE_PARAMS);
    expect(html).not.toContain('ACCEPTED');
  });

  it('renders a green badge with the given label when badge.color is green', () => {
    const html = buildBrandedEmailHtml({
      ...BASE_PARAMS,
      badge: { label: 'ACCEPTED', color: 'green' },
    });
    expect(html).toContain('ACCEPTED');
    expect(html).toContain('#3d9920');
  });

  it('renders a red badge with the given label when badge.color is red', () => {
    const html = buildBrandedEmailHtml({
      ...BASE_PARAMS,
      badge: { label: 'APPLICATION UPDATE', color: 'red' },
    });
    expect(html).toContain('APPLICATION UPDATE');
    expect(html).toContain('#c0392b');
  });

  it('renders a blue badge with the given label when badge.color is blue', () => {
    const html = buildBrandedEmailHtml({
      ...BASE_PARAMS,
      badge: { label: 'REMINDER', color: 'blue' },
    });
    expect(html).toContain('REMINDER');
    expect(html).toContain('#019de6');
  });

  it('renders a gold badge with the given label when badge.color is gold', () => {
    const html = buildBrandedEmailHtml({
      ...BASE_PARAMS,
      badge: { label: 'CANCELLED', color: 'gold' },
    });
    expect(html).toContain('CANCELLED');
    expect(html).toContain('#b8860b');
  });

  it('renders a CTA button with the given label and URL when cta is provided', () => {
    const html = buildBrandedEmailHtml({
      ...BASE_PARAMS,
      cta: { label: 'View My Application', url: 'https://example.com/my-application' },
    });
    expect(html).toContain('View My Application');
    expect(html).toContain('https://example.com/my-application');
  });

  it('renders no CTA markup when cta is omitted', () => {
    const html = buildBrandedEmailHtml(BASE_PARAMS);
    expect(html).not.toContain('my-application');
  });

  it('HTML-escapes interpolated heading and paragraph text', () => {
    const html = buildBrandedEmailHtml({
      ...BASE_PARAMS,
      heading: '<script>alert(1)</script>',
      paragraphs: ['<img src=x onerror=alert(1)>'],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('sets dir="rtl" for Arabic locale and dir="ltr" for English', () => {
    const ar = buildBrandedEmailHtml({ ...BASE_PARAMS, locale: 'ar' });
    const en = buildBrandedEmailHtml({ ...BASE_PARAMS, locale: 'en' });
    expect(ar).toContain('dir="rtl"');
    expect(en).toContain('dir="ltr"');
  });

  it('includes the COY21 footer text', () => {
    const html = buildBrandedEmailHtml(BASE_PARAMS);
    expect(html).toContain('COY21');
    expect(html).toContain('Antalya');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/email/html-template.test.ts`
Expected: FAIL — `Cannot find module '@/lib/email/html-template'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/email/html-template.ts
//
// Shared HTML template builder for every branded transactional/notification
// email this codebase sends (see docs/superpowers/specs/
// 2026-10-13-branded-email-templates-design.md for the full design). Kept
// separate from resend.ts (which stays focused on WHAT each email says, not
// HOW the HTML is assembled -- resend.ts is already large).
//
// Table-based layout with inline styles throughout -- the only approach
// that renders consistently across email clients, notably Outlook's
// Word-based rendering engine, which does not support flexbox/grid/
// external CSS. Every interpolated value goes through escapeHtml (copied
// from resend.ts's existing helper -- see Step on resend.ts below for the
// single-source-of-truth decision) before being placed in the output.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type BadgeColor = 'green' | 'red' | 'blue' | 'gold';

const BADGE_COLORS: Record<BadgeColor, { text: string; bg: string }> = {
  green: { text: '#3d9920', bg: '#e8f5e0' },
  red: { text: '#c0392b', bg: '#fdecea' },
  blue: { text: '#019de6', bg: '#e6f4fb' },
  gold: { text: '#b8860b', bg: '#fdf3e3' },
};

export interface BrandedEmailParams {
  locale: 'ar' | 'en';
  badge?: { label: string; color: BadgeColor };
  heading: string;
  paragraphs: string[];
  cta?: { label: string; url: string };
  logoUrl: string;
}

// Renders just the inner content card (logo header + badge + heading +
// paragraphs + CTA) WITHOUT the outer <html>/<body>/page-background
// wrapper -- used directly by buildBrandedEmailHtml for the normal
// single-locale case, and called twice (once per locale) by
// sendLoginDetailsEmail's bilingual migration in resend.ts, which stacks
// two of these sections inside one page itself.
export function buildBrandedEmailBodySection(params: BrandedEmailParams): string {
  const dir = params.locale === 'ar' ? 'rtl' : 'ltr';
  const heading = escapeHtml(params.heading);
  const logoUrl = escapeHtml(params.logoUrl);

  const badgeHtml = params.badge
    ? (() => {
        const colors = BADGE_COLORS[params.badge!.color];
        const label = escapeHtml(params.badge!.label);
        return `<div style="display:inline-block;background:${colors.bg};color:${colors.text};font-size:12px;font-weight:600;padding:4px 12px;border-radius:20px;margin-bottom:16px;">${label}</div>`;
      })()
    : '';

  // A single '\n' inside one paragraph entry becomes <br> (not a new <p>,
  // not dropped) -- e.g. sendSessionRescheduleNotificationEmail's
  // "Previous time: X\nNew time: Y" block. escapeHtml runs on the raw text
  // FIRST, then \n is split into <br>-joined lines, so a literal "\n"
  // inside escaped/attacker-controlled text can never itself produce a
  // <br> tag -- only this function's own intentional split does.
  const paragraphsHtml = params.paragraphs
    .map((p) => {
      const escaped = escapeHtml(p);
      const withBreaks = escaped.split('\n').join('<br />');
      return `<p style="margin:0 0 16px;color:#555555;font-size:14px;line-height:1.6;">${withBreaks}</p>`;
    })
    .join('');

  const ctaHtml = params.cta
    ? `<div style="text-align:center;margin-top:8px;"><a href="${escapeHtml(params.cta.url)}" style="display:inline-block;background:#3d9920;color:#ffffff;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;text-decoration:none;">${escapeHtml(params.cta.label)}</a></div>`
    : '';

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);" dir="${dir}">
      <tr>
        <td style="background-color:#053269;padding:28px 24px;text-align:center;">
          <img src="${logoUrl}" alt="COY21" style="height:36px;width:auto;" />
        </td>
      </tr>
      <tr>
        <td style="padding:28px 24px;">
          ${badgeHtml}
          <h2 style="margin:0 0 12px;color:#0a1a2e;font-size:18px;">${heading}</h2>
          ${paragraphsHtml}
          ${ctaHtml}
        </td>
      </tr>
    </table>`;
}

// Full standalone HTML page for the normal (single-locale) case: one
// buildBrandedEmailBodySection wrapped in <html>/<body> plus the
// warm-white page background and footer. sendLoginDetailsEmail does NOT
// call this directly -- it calls buildBrandedEmailBodySection twice and
// assembles its own bilingual page (see resend.ts).
export function buildBrandedEmailHtml(params: BrandedEmailParams): string {
  const dir = params.locale === 'ar' ? 'rtl' : 'ltr';
  const section = buildBrandedEmailBodySection(params);

  return `<!doctype html>
<html lang="${params.locale}" dir="${dir}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>COY21 Türkiye 2026</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f0f4f8;font-family:Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f4f8;padding:24px 0;">
      <tr>
        <td align="center">
          ${section}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
            <tr>
              <td style="padding:16px 24px;text-align:center;color:#8899aa;font-size:11px;">
                COY21 Türkiye 2026 · Antalya, 5–7 Nov 2026
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/email/html-template.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/html-template.ts tests/email/html-template.test.ts
git commit -m "feat: add shared branded HTML email template builder"
```

---

### Task 2: Migrate sendLoginDetailsEmail to the shared template

**Files:**
- Modify: `src/lib/email/resend.ts:94-114` (the `html = buildLoginDetailsHtml(...)` call site) and `:510-603` (delete `buildLoginDetailsHtml`)
- Test: `tests/email/resend-send.test.ts` (existing file — add one assertion, don't rewrite)

This is the one function with bilingual-in-one-message HTML (Arabic section stacked above an English section) — it calls `buildBrandedEmailBodySection` twice and assembles the two sections into one page itself, rather than calling `buildBrandedEmailHtml` once.

- [ ] **Step 1: Add the import and replace the `html` construction**

In `src/lib/email/resend.ts`, add to the top imports:

```typescript
import { buildBrandedEmailBodySection } from './html-template';
```

Replace the `const html = buildLoginDetailsHtml({...})` block inside `sendLoginDetailsEmail` (currently lines 94-100) with:

```typescript
  const arabicSection = buildBrandedEmailBodySection({
    locale: 'ar',
    heading: 'تم إنشاء حسابك',
    paragraphs: [
      `مرحبًا ${params.fullName}،`,
      `تم إنشاء حسابك في منصة COY21 Türkiye 2026.\n\nاسم المستخدم: ${params.to}\nكلمة المرور المؤقتة: ${params.temporaryPassword}`,
      'سيُطلب منك تغيير كلمة المرور عند أول تسجيل دخول. لن تتمكن من الوصول إلى ملفك وجدولك الشخصي قبل إكمال تغيير كلمة المرور.',
      `للدعم: ${config.supportEmail}`,
    ],
    cta: { label: 'تسجيل الدخول', url: loginUrl },
    logoUrl: `${config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });

  const englishSection = buildBrandedEmailBodySection({
    locale: 'en',
    heading: 'Your account has been created',
    paragraphs: [
      `Hello ${params.fullName},`,
      `Your COY21 Türkiye 2026 platform account has been created.\n\nUsername: ${params.to}\nTemporary password: ${params.temporaryPassword}`,
      'You will be required to change your password when you first log in. Access to your participant profile and personal schedule will remain restricted until this step is completed.',
      `Support: ${config.supportEmail}`,
    ],
    cta: { label: 'Log in', url: loginUrl },
    logoUrl: `${config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });

  const html = `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>COY21 Türkiye 2026</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f0f4f8;font-family:Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f4f8;padding:24px 0;">
      <tr><td align="center">${arabicSection}</td></tr>
      <tr><td align="center" style="padding-top:16px;">${englishSection}</td></tr>
      <tr><td style="padding:16px 24px;text-align:center;color:#8899aa;font-size:11px;">COY21 Türkiye 2026 · Antalya, 5–7 Nov 2026</td></tr>
    </table>
  </body>
</html>`;
```

Note: `config` and `loginUrl` are already in scope in this function (lines 61-63) — this snippet doesn't redeclare them.

- [ ] **Step 2: Delete the old `buildLoginDetailsHtml` function and its leftover `escapeHtml` usages inside it**

Delete lines 510-603 of the original file (the entire `buildLoginDetailsHtml` function, from `function buildLoginDetailsHtml(params: {` through its closing `}`). Also delete the standalone `escapeHtml` function (lines 501-508) — its only caller was `buildLoginDetailsHtml`, which this step just removed, so it becomes dead code otherwise (the new `html-template.ts` has its own separate, unexported `escapeHtml` copy — this isn't reused across files, it's intentionally duplicated once, matching the spec's file-separation decision).

- [ ] **Step 3: Update the existing test file**

In `tests/email/resend-send.test.ts`, the existing `'includes both HTML and a plain-text fallback'` test (lines 104-115) already asserts `call.html.length > 0` — no change needed there, it will keep passing. Add one new assertion to the first test (`'sends the correct username and temporary password...'`, lines 57-78) confirming both locale sections are present:

Find this block:
```typescript
    expect(call.html).toContain('participant@example.com');
    expect(call.html).toContain('password@123');
    expect(call.html).toContain('Test Participant');
```

Replace with:
```typescript
    expect(call.html).toContain('participant@example.com');
    expect(call.html).toContain('password@123');
    expect(call.html).toContain('Test Participant');
    expect(call.html).toContain('مرحبًا'); // Arabic section present
    expect(call.html).toContain('Hello Test Participant'); // English section present
```

- [ ] **Step 4: Run the test file**

Run: `npx vitest run tests/email/resend-send.test.ts`
Expected: PASS (all 8 existing tests, including the updated one, the mojibake-regression test, the escaping test, and the forbidden-data test)

- [ ] **Step 5: Typecheck and confirm no leftover references**

Run: `npx tsc --noEmit 2>&1 | grep -i "resend.ts\|html-template"`
Expected: no output (no new errors in either file)

Run: `grep -n "buildLoginDetailsHtml" src/lib/email/resend.ts`
Expected: no output (fully removed)

- [ ] **Step 6: Commit**

```bash
git add src/lib/email/resend.ts tests/email/resend-send.test.ts
git commit -m "feat: migrate sendLoginDetailsEmail to the shared branded template"
```

---

### Task 3: Add branded HTML to the 6 session/application/booking notification functions

**Files:**
- Modify: `src/lib/email/resend.ts` — `sendSessionCancellationNotificationEmail` (~line 151), `sendSessionRescheduleNotificationEmail` (~line 194), `sendWaitlistPromotionNotificationEmail` (~line 234), `sendApplicationAcceptedEmail` (~line 275), `sendApplicationRejectedEmail` (~line 311), `sendBookingConfirmedEmail` (~line 345)
- Test: `tests/email/session-lifecycle-notifications.test.ts`, `tests/email/application-decision-and-booking-notifications.test.ts`, `tests/email/work-group-waitlist-notification.test.ts` (3 existing files — add assertions, don't rewrite)

Badge mapping for this task (from the spec): `sendSessionCancellationNotificationEmail` → gold "CANCELLED"/"ألغيت"; `sendSessionRescheduleNotificationEmail` → gold "TIME CHANGED"/"تغيّر الموعد"; `sendWaitlistPromotionNotificationEmail` → green "CONFIRMED"/"مؤكّد"; `sendApplicationAcceptedEmail` → green "ACCEPTED"/"تم القبول"; `sendApplicationRejectedEmail` → red "APPLICATION UPDATE"/"تحديث على الطلب" (deliberately gentle, matching the existing gentle subject/body tone — never "REJECTED"); `sendBookingConfirmedEmail` → green "CONFIRMED"/"مؤكّد".

- [ ] **Step 1: Add the import**

In `src/lib/email/resend.ts`, update the import added in Task 2 to also bring in the full-page builder:

```typescript
import { buildBrandedEmailBodySection, buildBrandedEmailHtml } from './html-template';
```

- [ ] **Step 2: Add `html` to `sendSessionCancellationNotificationEmail`**

Find (inside this function, after the existing `body` ternary):
```typescript
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
(this exact shape repeats per-function; locate it specifically within `sendSessionCancellationNotificationEmail`, which also has `browseUrl` in scope above it)

Replace with:
```typescript
  const html = buildBrandedEmailHtml({
    locale: params.locale,
    badge: { label: params.locale === 'ar' ? 'ألغيت' : 'CANCELLED', color: 'gold' },
    heading: subject,
    paragraphs: body.split('\n\n'),
    cta: { label: params.locale === 'ar' ? 'تصفح الجلسات الأخرى' : 'Browse other sessions', url: browseUrl },
    logoUrl: `${config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });

  const settings = await fetchEmailSettings();
  return sendEmailGuarded({
    settings,
    apiKey: config.apiKey,
    from: config.fromEmail,
    replyTo: config.replyToEmail,
    to: params.to,
    subject,
    text: body,
    html,
    originalRecipientDescription: `${params.fullName} <${params.to}>`,
  });
}
```

- [ ] **Step 3: Add `html` to the remaining 5 functions in this task, following the identical pattern**

For each of `sendSessionRescheduleNotificationEmail`, `sendWaitlistPromotionNotificationEmail`, `sendApplicationAcceptedEmail`, `sendApplicationRejectedEmail`, `sendBookingConfirmedEmail`: insert a `const html = buildBrandedEmailHtml({...})` call before the existing `return sendEmailGuarded({...})`, using that function's own `subject`/`body`/`config.appUrl` (already in scope), the badge from the mapping above, `paragraphs: body.split('\n\n')`, and a `cta` pointing at whatever URL that function's existing plain-text body already links to (`loginUrl` for accepted, `agendaUrl` for waitlist-promotion/booking-confirmed). **Two of these five functions have no link in their existing plain-text body and must omit `cta` entirely: `sendApplicationRejectedEmail` AND `sendSessionRescheduleNotificationEmail`** (the latter's body only states the old/new time, with no URL — do not invent one or borrow `browseUrl`/`agendaUrl` from a different function, neither is in scope there). Add `html,` to the `sendEmailGuarded({...})` call, same as Step 2.

- [ ] **Step 4: Add `html`-presence assertions to the 3 existing test files**

In `tests/email/session-lifecycle-notifications.test.ts`, add to the existing `sendSessionCancellationNotificationEmail` and `sendSessionRescheduleNotificationEmail` describe blocks (test names vary per file — don't search for a literal `'sends an English ...'` string; instead find each describe block's first/English-locale happy-path test, e.g. `'sends a cancellation email with a link to the browse page, in the requested locale'` or `'includes both old and new formatted times'`, and add after that test's existing `call.text` assertions):
```typescript
    expect(typeof call.html).toBe('string');
    expect(call.html.length).toBeGreaterThan(0);
```

Do the same in `tests/email/application-decision-and-booking-notifications.test.ts` for `sendApplicationAcceptedEmail`, `sendApplicationRejectedEmail`, `sendBookingConfirmedEmail` (the `sendAnnouncementEmail` coverage in this same file is handled in Task 4), and in `tests/email/work-group-waitlist-notification.test.ts` for `sendWaitlistPromotionNotificationEmail`.

- [ ] **Step 5: Run all 3 test files**

Run: `npx vitest run tests/email/session-lifecycle-notifications.test.ts tests/email/application-decision-and-booking-notifications.test.ts tests/email/work-group-waitlist-notification.test.ts`
Expected: PASS (all existing + new assertions)

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -i "resend.ts"`
Expected: no output

- [ ] **Step 7: Commit**

```bash
git add src/lib/email/resend.ts tests/email/session-lifecycle-notifications.test.ts tests/email/application-decision-and-booking-notifications.test.ts tests/email/work-group-waitlist-notification.test.ts
git commit -m "feat: add branded HTML to session and application notification emails"
```

---

### Task 4: Add branded HTML to the announcement email, and the 4 previously-untested functions

**Files:**
- Modify: `src/lib/email/resend.ts` — `sendAnnouncementEmail` (~line 454), `sendRegistrationConfirmationEmail` (~line 5), `sendClassificationChangeNotificationEmail` (~line 116), `sendSessionReminderEmail` (~line 398), `sendTravelReminderEmail` (~line 426)
- Test: `tests/email/application-decision-and-booking-notifications.test.ts` (existing — add `sendAnnouncementEmail` assertion), create `tests/email/untested-notification-functions.test.ts`

`sendRegistrationConfirmationEmail` and `sendAnnouncementEmail` use no badge (neutral, per spec). `sendClassificationChangeNotificationEmail` → gold "UPDATED"/"تحديث". `sendSessionReminderEmail` → blue "REMINDER"/"تذكير". `sendTravelReminderEmail` → blue "ACTION NEEDED"/"إجراء مطلوب".

`sendSessionReminderEmail`/`sendTravelReminderEmail` do **not** have a fixed subject template — both already set `subject: params.title` (an arbitrary string from a producer route). For these two, `heading` in the `buildBrandedEmailHtml` call is simply `params.title` directly, not a derived string.

- [ ] **Step 1: Add `html` to `sendAnnouncementEmail`**

Insert before its existing `return sendEmailGuarded({...})`:
```typescript
  const html = buildBrandedEmailHtml({
    locale: params.locale,
    heading: subject,
    paragraphs: bodyText.split('\n\n'),
    logoUrl: `${config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });
```
Add `html,` to the `sendEmailGuarded({...})` call. (No badge, no cta — announcements are neutral per spec, and have no link in the existing body.) **Important: use `heading: subject` (matching every other function with a fixed subject template, including `sendApplicationAcceptedEmail`/`sendBookingConfirmedEmail`/etc. in Task 3), not `params.title`** — `subject` already embeds `params.title` inside the "Announcement from COY21 Türkiye 2026: ..." template, so using `subject` as the heading is consistent with the rest of the function set. **Also use `paragraphs: bodyText.split('\n\n')`, not a manually-constructed array.** `bodyText` (the function's own existing variable, defined just above this snippet) already embeds `params.body` inside itself when it's present (see its ternary: `` `...${params.title}${params.body ? `\n\n${params.body}` : ''}...` ``) — constructing `paragraphs` as `[bodyText, params.body]` would render `params.body`'s text a second time as a duplicate paragraph. Splitting the single already-complete `bodyText` string is correct and matches the pattern used by every other function in this plan.

- [ ] **Step 2: Add `html` to `sendRegistrationConfirmationEmail`**

```typescript
  const html = buildBrandedEmailHtml({
    locale: params.locale,
    heading: subject,
    paragraphs: body.split('\n\n'),
    logoUrl: `${config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });
```
Add `html,` to its `sendEmailGuarded({...})` call. (No badge — neutral per spec. No cta — existing body has no link.)

- [ ] **Step 3: Add `html` to `sendClassificationChangeNotificationEmail`**

```typescript
  const html = buildBrandedEmailHtml({
    locale: params.locale,
    badge: { label: params.locale === 'ar' ? 'تحديث' : 'UPDATED', color: 'gold' },
    heading: subject,
    paragraphs: body.split('\n\n'),
    logoUrl: `${config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });
```
Add `html,` to its `sendEmailGuarded({...})` call.

- [ ] **Step 4: Add `html` to `sendSessionReminderEmail`**

```typescript
  const html = buildBrandedEmailHtml({
    locale: params.locale,
    badge: { label: params.locale === 'ar' ? 'تذكير' : 'REMINDER', color: 'blue' },
    heading: params.title,
    paragraphs: params.body ? [params.body] : [params.title],
    logoUrl: `${configResult.config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });
```
Add `html,` to its `sendEmailGuarded({...})` call. Note this function uses `configResult.config` (not a destructured `config`), matching its existing code shape — check the actual variable name in context before writing this.

- [ ] **Step 5: Add `html` to `sendTravelReminderEmail`**

```typescript
  const html = buildBrandedEmailHtml({
    locale: params.locale,
    badge: { label: params.locale === 'ar' ? 'إجراء مطلوب' : 'ACTION NEEDED', color: 'blue' },
    heading: params.title,
    paragraphs: params.body ? [params.body] : [params.title],
    logoUrl: `${configResult.config.appUrl}/brand/logo/logo-horizontal-white.png`,
  });
```
Add `html,` to its `sendEmailGuarded({...})` call. Same `configResult.config` note as Step 4.

- [ ] **Step 6: Add `html`-presence assertion for `sendAnnouncementEmail` to the existing test file**

In `tests/email/application-decision-and-booking-notifications.test.ts`, find the `sendAnnouncementEmail` describe block's first test and add:
```typescript
    expect(typeof call.html).toBe('string');
    expect(call.html.length).toBeGreaterThan(0);
```

- [ ] **Step 7: Write the new test file for the 4 previously-untested functions**

```typescript
// tests/email/untested-notification-functions.test.ts
//
// sendRegistrationConfirmationEmail, sendClassificationChangeNotificationEmail,
// sendSessionReminderEmail, sendTravelReminderEmail had no dedicated test
// coverage before this file (confirmed by a 2026-10-13 spec review's grep
// across tests/email/*). They now carry real HTML-generation logic, so
// "still untested" would be a worse gap than before -- this file closes
// it. Mocking pattern copied verbatim from the other 4 test files in this
// directory (tests/email/resend-send.test.ts etc.) for consistency.
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
  process.env.RESEND_FROM_EMAIL = 'COY21 Türkiye 2026 <participants@example.com>';
  process.env.APP_URL = 'https://example.com';
  process.env.PARTICIPANT_SUPPORT_EMAIL = 'support@example.com';
  delete process.env.RESEND_REPLY_TO_EMAIL;
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: 'email_test' }, error: null });
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('sendRegistrationConfirmationEmail', () => {
  it('sends with both text and html, English', async () => {
    const { sendRegistrationConfirmationEmail } = await import('@/lib/email/resend');
    await sendRegistrationConfirmationEmail({ to: 'a@example.com', fullName: 'Test User', locale: 'en' });

    const call = sendMock.mock.calls[0][0];
    expect(call.text).toContain('Registration Received');
    expect(typeof call.html).toBe('string');
    expect(call.html.length).toBeGreaterThan(0);
    expect(call.html).toContain('Test User');
  });

  it('sends with both text and html, Arabic', async () => {
    const { sendRegistrationConfirmationEmail } = await import('@/lib/email/resend');
    await sendRegistrationConfirmationEmail({ to: 'a@example.com', fullName: 'مستخدم', locale: 'ar' });

    const call = sendMock.mock.calls[0][0];
    expect(call.html).toMatch(/[؀-ۿ]/);
  });
});

describe('sendClassificationChangeNotificationEmail', () => {
  it('sends with both text and html, including the new attendee code', async () => {
    const { sendClassificationChangeNotificationEmail } = await import('@/lib/email/resend');
    await sendClassificationChangeNotificationEmail({
      to: 'a@example.com',
      fullName: 'Test User',
      newApplicationNumber: 'COY21-DEL-0042',
      locale: 'en',
    });

    const call = sendMock.mock.calls[0][0];
    expect(call.text).toContain('COY21-DEL-0042');
    expect(call.html).toContain('COY21-DEL-0042');
    expect(call.html).toContain('UPDATED');
  });
});

describe('sendSessionReminderEmail', () => {
  it('sends with both text and html, using the producer-supplied title as the heading', async () => {
    const { sendSessionReminderEmail } = await import('@/lib/email/resend');
    await sendSessionReminderEmail({
      to: 'a@example.com',
      fullName: 'Test User',
      title: 'Reminder: "Opening Ceremony" starts in 30 minutes',
      body: 'Room: Main Hall\nTime: 09:00',
      locale: 'en',
    });

    const call = sendMock.mock.calls[0][0];
    expect(call.html).toContain('Opening Ceremony');
    expect(call.html).toContain('REMINDER');
  });
});

describe('sendTravelReminderEmail', () => {
  it('sends with both text and html', async () => {
    const { sendTravelReminderEmail } = await import('@/lib/email/resend');
    await sendTravelReminderEmail({
      to: 'a@example.com',
      fullName: 'Test User',
      title: 'Action required: submit your travel details for COY21',
      body: null,
      locale: 'en',
    });

    const call = sendMock.mock.calls[0][0];
    expect(typeof call.html).toBe('string');
    expect(call.html.length).toBeGreaterThan(0);
    expect(call.html).toContain('ACTION NEEDED');
  });
});
```

- [ ] **Step 8: Run all tests touched by this task**

Run: `npx vitest run tests/email/application-decision-and-booking-notifications.test.ts tests/email/untested-notification-functions.test.ts`
Expected: PASS

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -i "resend.ts"`
Expected: no output

- [ ] **Step 10: Commit**

```bash
git add src/lib/email/resend.ts tests/email/application-decision-and-booking-notifications.test.ts tests/email/untested-notification-functions.test.ts
git commit -m "feat: add branded HTML to remaining notification emails, close test coverage gap"
```

---

### Task 5: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full existing test suite**

Run: `npm test`
Expected: all tests that passed before this work still pass, plus all new tests from Tasks 1-4. Compare against the pre-existing baseline (if any tests were already failing before this branch, e.g. unrelated live-DB tests requiring env vars not present in this environment, confirm the SAME set is failing now — no new failures).

- [ ] **Step 2: Run the full typecheck**

Run: `npx tsc --noEmit`
Expected: same error count as the pre-existing baseline (check `git log`/ask the user what the baseline count was if unsure — this project has pre-existing unrelated type errors in some live-DB test files, not something this plan fixes).

- [ ] **Step 3: Manual verification — send real test emails**

This cannot be done by an automated agent (requires real Resend credentials already configured in this project's Vercel environment, and a human to look at the resulting inbox). Using `npm run dev` locally, or by triggering one of the already-verified-working notification channels in production with sandbox mode on (per `docs/pre-launch-checklist.md`'s existing 2026-10-13 notification-verification entry), send at least 2-3 different email types and visually confirm in a real inbox:
- Logo renders correctly
- Badge color/label is legible and matches the email's meaning
- Layout doesn't break on mobile Gmail/Outlook (check on a phone if possible)
- Arabic (`dir="rtl"`) email displays correctly, not mirrored/broken
- Plain-text fallback (view email source, confirm `text/plain` part still has the original unstyled content, unchanged from before this work)

Report explicitly which of these was and wasn't actually checked, per this project's standing practice of being explicit about what was/wasn't browser/inbox-verified — don't claim "looks correct" without having actually looked.

- [ ] **Step 4: Update the pre-launch checklist**

Add a new line to `docs/pre-launch-checklist.md` noting the branded HTML email templates are complete, referencing this plan and the spec, and explicitly noting whether Step 3's manual inbox check was completed.

- [ ] **Step 5: Commit**

```bash
git add docs/pre-launch-checklist.md
git commit -m "docs: mark branded email templates complete in pre-launch checklist"
```

---

## After all tasks

Once all 5 tasks are complete and verified, use **superpowers:finishing-a-development-branch** to merge `feature/branded-email-templates` back and clean up the worktree.
