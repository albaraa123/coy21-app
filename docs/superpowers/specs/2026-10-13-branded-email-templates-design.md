# Branded HTML Email Templates — Design

Date: 2026-10-13

## Context

Every one of the 12 email-sending functions in `src/lib/email/resend.ts` sends plain `text` only to Resend (`sendEmailGuarded`'s `html` param is optional and almost never passed). Resend renders these as unstyled plain text — no logo, no color, no layout. The user described the current result as "very basic and bad."

One function, `sendLoginDetailsEmail` / `buildLoginDetailsHtml`, already has a real table-based HTML template — built for a previous, now-outdated brand palette (`#0f2a2e` teal, `#c9a227` gold). It proves the right structural approach (table-based layout, inline styles — the only rendering approach that works consistently across email clients, notably Outlook) already exists in this codebase; it just needs to move to the current brand colors and be shared across all 12 functions instead of living only in one.

`sendEmailGuarded` (`src/lib/email/send-guarded.ts`) already has sandbox-mode HTML handling ready: when sandbox is on, it prepends a standalone warning table (`SANDBOX_HTML_PREFIX`) before whatever `html` is passed. Nothing in this design needs to account for sandbox mode itself — it's already handled upstream, and new templates just need to be a self-contained block.

## Goal

Give every transactional/notification email in this codebase a real, branded HTML look — using COY21's actual logo and current color palette — while keeping every email's existing plain-text body as the real `text` fallback (required for text-only email clients and spam-filter friendliness; never removed, only supplemented).

## Scope

**In scope:**
- One shared, reusable HTML template builder for the common envelope (header with real COY21 logo, colored status badge, content area, CTA button where applicable, footer) that every email function's content plugs into.
- HTML content for all 12 `resend.ts` functions: `sendRegistrationConfirmationEmail`, `sendLoginDetailsEmail` (migrated to the new shared template, replacing its own bespoke `buildLoginDetailsHtml`), `sendClassificationChangeNotificationEmail`, `sendSessionCancellationNotificationEmail`, `sendSessionRescheduleNotificationEmail`, `sendWaitlistPromotionNotificationEmail`, `sendApplicationAcceptedEmail`, `sendApplicationRejectedEmail`, `sendBookingConfirmedEmail`, `sendSessionReminderEmail`, `sendTravelReminderEmail`, `sendAnnouncementEmail`.
- Bilingual handling matching each function's existing locale behavior: single-locale functions (everything except `sendLoginDetailsEmail`) render HTML in that one locale (`dir="rtl"` for Arabic, `dir="ltr"` for English) exactly as their existing plain-text bodies already do; `sendLoginDetailsEmail` stays bilingual-in-one-message (Arabic section, then an English section below it), matching its current text body's structure.
- Status-badge color mapping per email type (approved in the visual walkthrough): green for positive outcomes (accepted, booking confirmed, waitlist promoted), muted red for the one negative outcome (rejected), blue for informational/reminder (session reminder, travel reminder), gold/amber for "needs attention" (session cancelled, session rescheduled, classification change). Registration-confirmation and announcement emails use a neutral/no-badge treatment (not a positive/negative outcome).

**Explicitly out of scope:**
- Changing any email's subject line, recipient logic, or when it's sent — purely the HTML body content/styling.
- Changing `sendEmailGuarded`, `fetchEmailSettings`, sandbox-mode behavior, or the plain-text bodies themselves (text bodies are reused as-is as the `text` param; this work only adds a matching `html` param alongside each).
- A generic "email template" admin UI for staff to edit copy — these are still hardcoded in `resend.ts`, same as today.
- Email client-by-client visual QA beyond basic table-layout conventions known to work broadly (no access to a cross-client testing tool like Litmus in this environment) — the design follows established email-HTML conventions (tables, inline styles, no flexbox/grid, no external CSS) specifically because they're broadly compatible, but a full client matrix test isn't part of this work.

## Design

### Visual direction (approved via visual walkthrough)

- **Layout:** rounded white card (`border-radius:12px`), centered, `max-width:420–480px`, soft drop shadow, on a light warm-white page background (`#f0f4f8`, the existing `--color-warm-white` token) — approved as "Option A" against two alternatives (a minimal editorial style with no boxes, and a dark/bold navy-background style).
- **Header:** solid navy (`#053269`, the existing `--color-turquoise` token — the brand's actual navy, despite the CSS variable's name) background, centered, containing the **real COY21 logo image** (`public/brand/logo/logo-horizontal-white.png`, the white logo variant for a dark background) — approved over a styled-text alternative in a second round of the walkthrough, after seeing both side by side with the real logo file.
- **Status badge:** a small pill-shaped badge directly under the header, inside the content area, color-coded per email type (see mapping below) with a one-or-two-word label and a simple symbol (✓ / ✕ / ⏰ / ⚠).
- **Content:** greeting, 1-2 short paragraphs (the existing plain-text body's content, reflowed into HTML paragraphs), optional solid CTA button (`background:#3d9920` green, white text, rounded) where the existing plain-text body includes a link.
- **Footer:** small muted text, warm-white background, "COY21 Türkiye 2026 · Antalya, 5–7 Nov 2026".

### Badge color/label mapping

| Email function | Badge label (EN) | Badge label (AR) | Color |
|---|---|---|---|
| `sendApplicationAcceptedEmail` | ✓ ACCEPTED | ✓ تم القبول | Green (`#3d9920` text on `#e8f5e0` bg) |
| `sendApplicationRejectedEmail` | APPLICATION UPDATE | تحديث على الطلب | Muted red (`#c0392b` text on `#fdecea` bg) |
| `sendBookingConfirmedEmail` | ✓ CONFIRMED | ✓ مؤكّد | Green |
| `sendWaitlistPromotionNotificationEmail` | ✓ CONFIRMED | ✓ مؤكّد | Green |
| `sendSessionCancellationNotificationEmail` | ⚠ CANCELLED | ⚠ ألغيت | Gold/amber (`#b8860b` text on `#fdf3e3` bg) |
| `sendSessionRescheduleNotificationEmail` | ⚠ TIME CHANGED | ⚠ تغيّر الموعد | Gold/amber |
| `sendClassificationChangeNotificationEmail` | ⚠ UPDATED | ⚠ تحديث | Gold/amber |
| `sendSessionReminderEmail` | ⏰ REMINDER | ⏰ تذكير | Blue (`#019de6` text on `#e6f4fb` bg) |
| `sendTravelReminderEmail` | ⏰ ACTION NEEDED | ⏰ إجراء مطلوب | Blue |
| `sendRegistrationConfirmationEmail` | *(no badge)* | *(no badge)* | — |
| `sendAnnouncementEmail` | *(no badge)* | *(no badge)* | — |
| `sendLoginDetailsEmail` | *(no badge — migrates structure, not badge)* | — | — |

`sendApplicationRejectedEmail`'s subject/body is deliberately gentle ("An update on your application," not "Rejected") in the existing plain-text copy — the badge label matches that same tone ("APPLICATION UPDATE," not "REJECTED"), not introducing a harsher tone than the text body already has.

### Shared template builder

One new function, `buildBrandedEmailHtml(params)`, in a new file `src/lib/email/html-template.ts` (kept separate from `resend.ts` itself, which is already large and focused on *what* each email says, not *how* HTML is assembled):

```ts
interface BrandedEmailParams {
  locale: 'ar' | 'en';
  badge?: { label: string; color: 'green' | 'red' | 'blue' | 'gold' };
  heading: string;
  paragraphs: string[];       // plain text, HTML-escaped internally, one <p> each
  cta?: { label: string; url: string };
  logoUrl: string;            // absolute URL — see "Logo hosting" below
}
function buildBrandedEmailHtml(params: BrandedEmailParams): string
```

For `sendLoginDetailsEmail`'s bilingual-in-one-message shape specifically, the function is called twice (once per locale) and the two resulting HTML fragments' *content sections* (not the full `<html>` wrapper) are concatenated inside one page, matching how `buildLoginDetailsHtml` already stacks an Arabic section above an English section today. This needs a second, smaller helper (`buildBrandedEmailBodySection`) that `buildBrandedEmailHtml` itself uses internally, so the bilingual case can reuse the same content-rendering logic without duplicating it.

### Logo hosting

The logo must be served from a real, publicly reachable HTTPS URL for email clients to load it (a relative path or bundled asset doesn't work in email). `public/brand/logo/logo-horizontal-white.png` is already served by Next.js at `/brand/logo/logo-horizontal-white.png` on the deployed site — `${config.appUrl}/brand/logo/logo-horizontal-white.png` (using the existing `appUrl` config value already available in every caller) is the logo URL every template uses. No new asset hosting needed.

### Escaping

Every interpolated value (participant name, session title, etc.) goes through the existing `escapeHtml` helper in `resend.ts` (already used by `buildLoginDetailsHtml`) — this is reused, not reimplemented, in the new shared builder.

### Migration shape per function

Each of the 11 non-`sendLoginDetailsEmail` functions gets one new line calling `buildBrandedEmailHtml(...)` with that function's own existing subject-derived heading, its existing plain-text body's paragraphs (split on the body's own `\n\n` breaks, reusing the exact same copy — no new wording), its badge config per the table above, and its existing link (if any) as the `cta`. The `text:` param passed to `sendEmailGuarded` is **completely unchanged** — same variable, same value, still the sole fallback. Only a new `html:` param is added alongside it.

`sendLoginDetailsEmail` is the one function whose *existing* `buildLoginDetailsHtml` is deleted and replaced by two calls into the new shared builder (one per locale) assembled into one page, as described above — this is a genuine migration (old bespoke template → new shared one), not an addition alongside something that stays.

## Non-goals (explicit)

- No new i18n/`messages/*.json` keys — same as every other email body in this file today, this copy is hardcoded, not translated via `next-intl`.
- No automated visual-regression testing for email HTML (no existing precedent/tooling in this codebase for that).
- No change to which events trigger which emails.

## Testing

This is additive HTML generation alongside already-tested plain-text bodies and already-tested send logic (`sendEmailGuarded`, the cron routes, the Server Actions that call these functions) — none of that changes. New coverage:
- Unit tests for `buildBrandedEmailHtml` / `buildBrandedEmailBodySection` in `src/lib/email/html-template.ts`: confirm badge color/label renders correctly per config, confirm `escapeHtml` is actually applied to interpolated values (a participant name containing `<script>` must not appear unescaped in the output), confirm the bilingual two-locale concatenation produces both sections.
- No changes needed to existing tests in `tests/email/*` — they test subject/text-body content and send-call shape, which are unchanged; a new assertion may be added confirming `html` is now present on the `sendEmailGuarded` call for each function, matching the pattern `tests/email/resend-send.test.ts` (if it exists — the implementer should check) already uses for text/subject assertions.
- Manual verification: send at least 2-3 real emails through the full pipeline (one of the already-proven-working notification channels from the 2026-10-13 verification pass) with sandbox mode on, and visually confirm the HTML renders correctly in a real inbox — consistent with this project's standing practice of being explicit about what was/wasn't actually visually verified, not just unit-tested.
