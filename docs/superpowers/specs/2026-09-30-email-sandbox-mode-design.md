# Email Sandbox Mode — Design Spec

Date: 2026-09-30

## Context

This is sub-project 2 of a larger 6-part plan for the COY21 conference platform (Antalya, 5–7 November 2026, ~500 participants). It's independent of sub-project 1 (accounts reset — already merged) and doesn't depend on it structurally, though it targets the same production project.

## Goal

Add a super_admin-controlled "sandbox mode" that, while enabled (the default), redirects **every** outbound email from the platform to a single operator-configured inbox instead of the real recipient, with the original intended recipient embedded in the redirected message, a persistent banner across the admin dashboard while active, and a deliberately strong confirmation gate before it can be turned off.

## What already exists (confirmed via codebase research)

- **Email sending is not centralized.** Exactly 5 places send outbound email via Resend, and none of them shares a single choke point:
  1. `sendRegistrationConfirmationEmail` (`src/lib/email/resend.ts:20`) — participant registration confirmation, called from the participant's own registration Server Action.
  2. `sendLoginDetailsEmail` (`src/lib/email/resend.ts:66`) — account-created email with a temporary password, called from admin-triggered account provisioning actions.
  3. `sendBulkEmail` (`src/app/[locale]/(admin)/communications/actions.ts:24`) — staff-composed bulk email to a predefined audience cohort; constructs its own `Resend` client and calls `.emails.send()` directly, in a loop, one call per recipient.
  4. The session-reminder cron route (`src/app/api/cron/session-reminders/route.ts`) — sends a 30-minutes-before reminder per active booking, inline `resend.emails.send()` call, no shared function.
  5. The travel-reminder cron route (`src/app/api/cron/travel-reminders/route.ts`) — sends a reminder to accepted participants with no travel info submitted, same inline pattern.
  
  All 5 ultimately call the same underlying method shape: `resend.emails.send({ from, replyTo, to, subject, text, html? })`. This is the natural interception point — wrapping this one call shape, rather than each of the 5 call sites' business logic, is enough to cover all of them.

- **A separate, non-Resend email channel exists and is explicitly out of scope**: participant registration invitations (`sendInvitation`/`resendInvitation`, `src/lib/import/invitation.ts`) go through Supabase Auth's own `service.auth.admin.inviteUserByEmail(...)`, which sends its own email with no body this codebase controls — there's no text to embed an "original recipient" note into. Per explicit decision, **invitations are blocked outright while sandbox mode is on** (see "Design," part 4) rather than attempting a redirect that isn't technically possible.

- **No settings/config table or admin settings page exists anywhere in this codebase.** This is the first platform-wide setting. The closest structural analog, `conference_days` (one-row-per-item, `is_staff()`-gated RLS for all operations), is NOT a template for this feature — a singleton settings row needs different RLS (write restricted to `super_admin` specifically, not any staff) since this control is more sensitive than conference-day metadata.

- **`requireSuperAdmin()` is duplicated locally** in `src/app/[locale]/(admin)/staff/actions.ts:24-38` and `src/app/[locale]/(admin)/staff/assignments/actions.ts:8` (identical shape both places, not shared). The new sandbox-toggle action needs the same guard; this is a natural point to extract it to a shared `src/lib/auth/require-super-admin.ts` rather than adding a third copy.

- **Admin layout choke point**: `src/app/[locale]/(admin)/layout.tsx:87-100` wraps every admin page in `<AppShell>` and already runs a service-role Supabase call (line 48) — the sandbox-mode banner's data fetch belongs here, passed down as a new prop.

- **Existing confirm-before-destructive-action pattern** (`src/app/[locale]/(admin)/staff/staff-manager.tsx:151-166`) is a simple two-button reveal (Confirm/Cancel), no typed confirmation. This feature introduces a **new, stronger pattern** (type an exact confirmation phrase before the confirm button enables) since disabling sandbox mode is significantly higher-stakes than deleting one staff account — it immediately resumes real email delivery to potentially hundreds of real participants. This is a deliberate new precedent, not a reuse of the existing pattern.

## Design

### 1. Settings table

A new table, `email_settings`, holding exactly one row (enforced by a fixed, known primary key rather than an application-level "only one row" convention that could drift):

```sql
create table email_settings (
  id boolean primary key default true,
  constraint email_settings_singleton check (id = true),
  sandbox_enabled boolean not null default true,
  sandbox_recipient_email text,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id) on delete set null
);

insert into email_settings (id) values (true);
```

(`id boolean primary key default true` with `check (id = true)` is a standard Postgres pattern for enforcing exactly one row — any second insert violates the primary key.)

**RLS**: `SELECT` is granted to any `staff`/`super_admin` (via `is_staff()`, matching the existing convention — the banner needs to be visible to all admin-panel users). `UPDATE` is restricted to `super_admin` specifically:

```sql
alter table email_settings enable row level security;

create policy "staff can read email settings"
  on email_settings for select
  using (is_staff());

create policy "only super_admin can update email settings"
  on email_settings for update
  using (current_user_role() = 'super_admin')
  with check (current_user_role() = 'super_admin');
```

No `INSERT`/`DELETE` policy — the single row is seeded by the migration itself and never re-created or removed; only `UPDATE` is a legitimate operation on this table going forward.

**Default state after this migration ships**: `sandbox_enabled = true`, `sandbox_recipient_email = null` — sandbox mode is on immediately, but with no destination configured yet (per explicit decision, no default recipient is pre-filled). See part 3 for what happens to a send attempt in this exact state.

### 2. The interception point: a single guarded send wrapper

A new function, `sendEmailGuarded` (exact name TBD in the plan), in a new file `src/lib/email/send-guarded.ts`, becomes the only place in the codebase that's allowed to call `resend.emails.send(...)` directly. It has the same parameter shape as the underlying Resend call, plus one addition — a human-readable description of the original recipient for use in the redirect banner:

```ts
async function sendEmailGuarded(params: {
  apiKey: string;
  from: string;
  replyTo: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  // Shown inside the redirected email body when sandbox mode is active.
  // Not the same as `to` in every case — e.g. for a bulk send this might
  // be "Jane Doe <jane@example.com>", not just the raw address.
  originalRecipientDescription: string;
}): Promise<{ id: string | null; error: string | null }>
```

**Behavior**:
1. Read the current `email_settings` row (service-role client — this function runs server-side only, never client-side).
2. If `sandbox_enabled = false`: call `resend.emails.send()` with `params` exactly as given (unmodified real-recipient send — today's behavior, unchanged).
3. If `sandbox_enabled = true` and `sandbox_recipient_email` is `null`/empty: **do not call Resend at all**. Return `{ id: null, error: 'Sandbox mode is enabled but no recipient email is configured. Set one in Settings before any email can be sent.' }`. This is a clear, typed failure the caller's existing error-handling already knows how to surface — not a silent no-op.
4. If `sandbox_enabled = true` and a recipient is configured: call `resend.emails.send()` with `to` replaced by `sandbox_recipient_email`, and both `text`/`html` bodies prefixed with a clearly-marked block naming the original intended recipient and the platform's sandbox-mode state, e.g.:
   ```
   [SANDBOX MODE — this email was NOT sent to the real recipient]
   Original recipient: Jane Doe <jane@example.com>
   ---
   <original body follows>
   ```
   For the HTML body, an equivalent styled banner block is prepended (matching the existing table-based email layout convention in `resend.ts`'s `buildLoginDetailsHtml`, not a separate ad-hoc style).

Every one of the 5 existing send call sites is updated to call `sendEmailGuarded` instead of constructing its own `Resend` client / calling `.emails.send()` directly. `sendRegistrationConfirmationEmail` and `sendLoginDetailsEmail` keep their existing signatures (callers outside `resend.ts` are unaffected) — only their internal implementation changes to route through the guard. `sendBulkEmail` and both cron routes are updated at their inline call sites the same way.

Per explicit decision: **the same redirect behavior applies uniformly across all 5 paths**, including the two cron reminder routes — a reminder that would have gone to a real participant is redirected to the sandbox inbox exactly like every other email, rather than being silently suppressed. This keeps the mental model simple ("sandbox mode redirects everything, no path is special-cased") at the cost of the sandbox inbox potentially receiving a high volume of redirected reminders close to the conference dates — an accepted tradeoff given the goal is testing safety, not volume minimization.

### 3. Invitations are blocked outright, not redirected

`sendInvitation`/`resendInvitation` (`src/lib/import/invitation.ts`) gain a new guard at their start: read `email_settings.sandbox_enabled`; if `true`, return a typed failure (`{ success: false, error: 'Invitations are disabled while sandbox mode is enabled.' }` or equivalent matching this function's existing return shape) without calling `service.auth.admin.inviteUserByEmail(...)` at all. This is a hard block, not a redirect — per the explicit decision that there is no email body to embed a redirect notice into for this channel.

### 4. Admin UI: banner + settings page

**Banner**: `src/app/[locale]/(admin)/layout.tsx` fetches `email_settings` (service-role, alongside its existing profile fetch) and passes `sandboxEnabled`/`sandboxRecipientEmail` down to `AppShell` as new optional props. `AppShell` renders a persistent banner strip between `Topbar` and the main content area when `sandboxEnabled` is true, visible on every admin page regardless of role (any `staff`/`super_admin` who can reach the admin panel at all sees it, matching the RLS `SELECT` grant). Banner text distinguishes the two sandboxed states:
- Recipient configured: "Sandbox mode is ON — all outgoing email is redirected to `<recipient>`."
- No recipient configured yet: "Sandbox mode is ON, but no redirect email is set — all sending is currently blocked. Configure one in Settings."

No success-message duplication per send action (per explicit decision) — the banner alone is the ongoing reminder; individual "email sent" confirmations in the UI stay exactly as they read today.

**Settings page** — first settings page in the platform, at `src/app/[locale]/(admin)/settings/page.tsx` (or a project-appropriate path decided in the plan), reachable from a new sidebar entry. Shows:
- Current sandbox state (on/off) and configured recipient.
- A text input for the recipient email, editable by `super_admin` only (the RLS `UPDATE` policy is the real enforcement; the UI simply doesn't render an editable control for `staff`, matching this codebase's established pattern of RLS as the actual authorization boundary and the UI reflecting it).
- An "Enable sandbox mode" action (available whenever it's currently off) — a normal one-click action, no special confirmation needed for turning protection ON.
- A "Disable sandbox mode" action gated behind the new strong-confirmation pattern from part 5.

### 5. Disable confirmation flow (new UI pattern)

Clicking "Disable sandbox mode" reveals a confirmation panel (not a full modal — inline within the settings page, consistent with this codebase's existing preference for inline state over modal dialogs) requiring the `super_admin` to type an exact fixed phrase (e.g. `DISABLE`) into a text field before the actual confirm button becomes enabled. The confirm button stays disabled (not just hidden) until the typed value matches exactly — this is a deliberately stronger bar than the existing two-button Confirm/Cancel pattern used elsewhere, justified by the scale of consequence (immediate resumption of real email delivery to the full participant list, vs. deleting one staff account). Cancelling clears the typed text and collapses the panel back to the single "Disable sandbox mode" button.

The disable action itself is a Server Action gated by (the newly-shared) `requireSuperAdmin()`, updating `email_settings.sandbox_enabled = false` and `updated_by`/`updated_at`.

### Testing

- **Unit tests** for `sendEmailGuarded`'s three-way branch (disabled → passthrough unmodified; enabled + no recipient → blocked with typed error, zero Resend calls; enabled + recipient set → redirected with original-recipient text embedded in both `text` and `html` bodies) — using a mocked Resend client, matching this codebase's existing email test conventions (`tests/email/resend-send.test.ts`).
- **RLS tests**: a `staff`-role session can `SELECT` `email_settings` but an `UPDATE` attempt is rejected by RLS; a `super_admin`-role session can do both. Live test against a disposable scratch project, per this codebase's established convention for RLS verification.
- **Live test** confirming all 5 send call sites genuinely route through `sendEmailGuarded` and none constructs its own `Resend` client anymore — a grep-based static check is acceptable here (confirm zero remaining direct `new Resend(...)` / `.emails.send(...)` call sites outside `send-guarded.ts` itself) rather than requiring a live-email-triggering test, since actually sending real email in a test run is out of scope and unnecessary to prove the routing.
- No test attempts to verify actual email delivery through Resend's real API — consistent with this codebase's existing `-live.test.ts` conventions, which test against a real Supabase project but never trigger real third-party email sends in an automated run.

### Out of scope

- Any change to email *content* beyond the sandbox-mode prefix banner — subject lines, existing bilingual bodies, HTML templates are otherwise unchanged.
- A UI for previewing what a redirected email will look like before enabling/disabling sandbox mode.
- Rate-limiting or deduplication of redirected emails landing in the sandbox inbox (e.g. if cron reminders fire for hundreds of bookings, the sandbox inbox receives hundreds of redirected messages — accepted per the "uniform behavior across all 5 paths" decision in part 2).
- Any change to the Supabase Auth invitation email's own content or template — it is blocked, not modified, while sandbox mode is on.
