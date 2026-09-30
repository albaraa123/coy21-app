# Import / Classification / Approval — Closing the Three Gaps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three confirmed gaps in the COY21 participant workflow: (1) no UI to change `participant_type` after import, (2) no link between approval and code/QR issuance for the self-registration intake path, (3) no link between `participant_type = 'speaker'` classification and the `people`/`session_people` speaker system.

**Architecture:** Self-registration's `application_number` generation moves from submission-time to acceptance-time (import is untouched — it already inserts at `status = 'accepted'`, so it already satisfies "code only after approval"). A new "Issue QR" control and individual classification-edit control are added to `participants/[applicationId]` (the real, unflagged participant-detail page — not the legacy, permanently-disabled `applications/[id]`). A bulk classification-edit control is added to `participants/accounts` (the real, nav-linked roster of every imported application). Reclassifying an accepted application with an active QR credential triggers the already-fully-implemented `reissueStaffQrCredential` reissue sequence. A new trigger creates a `people` record whenever an application's classification becomes `'speaker'`, linked via a new `people.linked_application_id` column.

**Tech Stack:** Next.js Server Actions, Supabase Postgres/RLS/triggers, Vitest (mocked-Resend unit tests + live tests against a scratch Supabase project).

**Full design spec:** `docs/superpowers/specs/2026-09-30-import-classification-approval-design.md` — read this first, especially §0 (why the new UI lives on `participants/*` and not the legacy `applications/*` pages — this was a real correction found during plan prep, not an arbitrary choice) and §1.1 (why the import path needs zero changes). Do not deviate from this plan's file/location choices without going back to that spec's review process.

---

## File Structure

**New files:**
- `supabase/migrations/20260930020000_add_people_linked_application_id.sql` — `people.linked_application_id` column (Task 1)
- `supabase/migrations/20260930030000_speaker_classification_people_trigger.sql` — `resolve_application_display_name()`, the `AFTER INSERT OR UPDATE` trigger, and the retroactive backfill (Task 2)
- `supabase/migrations/20260930040000_accept_application_and_issue_number.sql` — `accept_application_and_issue_number(application_id uuid)` SQL function (Task 3)
- `src/app/[locale]/(admin)/participants/[applicationId]/classification-controls.tsx` — individual classification-edit + Issue QR UI (Task 5)
- `src/app/[locale]/(admin)/participants/[applicationId]/qr-actions.ts` — new "Issue QR" Server Action (Task 5)
- `src/app/[locale]/(admin)/participants/accounts/classification-dialog.tsx` — bulk classification-picker dialog content, extracted from `accounts-table.tsx` for size (Task 6)
- `tests/participants/classification-edit.test.ts` — unit tests for the shared reclassify-and-reissue helper (Task 4)
- `tests/participants/classification-edit-live.test.ts` — live test: reclassify with/without active QR, speaker-linking, email-on-claimed-only (Task 4, 7)
- `tests/participants/speaker-linking-live.test.ts` — live test: trigger fires on INSERT and UPDATE, backfill idempotency, name-fallback chain (Task 2)
- `tests/register/submit-application-live.test.ts` or extension of an existing register test file — self-registration `application_number` deferred to acceptance (Task 3)

**Modified files:**
- `src/lib/import/invitation.ts` — none (confirmed out of scope; listed here only to note it was checked, not touched)
- `src/app/[locale]/(participant)/(bare)/register/actions.ts` — `submitApplication` drops its `next_application_number()` call and the `applicationNumber` field from its update/return (Task 3)
- `src/lib/email/resend.ts` — `sendRegistrationConfirmationEmail` drops the `applicationNumber` param; new `sendClassificationChangeNotificationEmail` export (Task 3, Task 4)
- `src/app/[locale]/(participant)/(bare)/register/registration-form.tsx` — `submitApplication`'s return type narrows to `Promise<void>`; call site updated if needed (Task 3)
- `src/app/[locale]/(admin)/applications/[id]/actions.ts` — `updateApplicationStatus` calls the new `accept_application_and_issue_number` function when transitioning to `accepted` (Task 3)
- `src/lib/attendance/qr-credential-issuance.ts` — none (confirmed already complete; listed for traceability)
- `src/app/[locale]/(admin)/participants/[applicationId]/page.tsx` — adds `application_number`/`participant_type` to its `applications` select, fixes its back-link, renders the new `ClassificationControls` (Task 5)
- `src/app/[locale]/(admin)/participants/accounts/page.tsx` — adds `participant_type` to its `applications` select and to `AccountRow` (Task 6)
- `src/app/[locale]/(admin)/participants/accounts/accounts-table.tsx` — adds the bulk "change classification" action, dialog state, and dispatch (Task 6)
- `src/app/[locale]/(admin)/participants/accounts/actions.ts` — new `changeClassificationForSelectedForCaller`/`changeClassificationForSelected` bulk actions, reusing Task 4's shared helper (Task 6)
- `src/app/[locale]/(admin)/participants/import/[batchId]/preview/actions.ts` — new `updateRowParticipantType` action (Task 8)
- `src/app/[locale]/(admin)/participants/import/[batchId]/preview/preview-table.tsx` — per-row editable classification control (Task 8)
- `src/messages/en.json` / `src/messages/ar.json` — new translation keys for all new UI (Tasks 5, 6, 8)

---

## Task 1: `people.linked_application_id` column

**Files:**
- Create: `supabase/migrations/20260930020000_add_people_linked_application_id.sql`

**Context:** Per spec §1.2. A nullable, unique FK from `people` to `applications`, mirroring the existing `people.linked_profile_id uuid unique references profiles(id)` pattern on the same table.

- [ ] **Step 1: Write the migration**

```sql
-- 20260930020000_add_people_linked_application_id.sql
--
-- Links a `people` record (the standalone speaker/session-participant
-- identity table) to the `applications` row it was created from or is
-- otherwise associated with. Mirrors the existing
-- `linked_profile_id uuid unique references profiles(id)` pattern on this
-- same table: nullable (most `people` rows, e.g. external guest speakers,
-- have no associated application at all), unique (one `people` row links
-- to at most one `applications` row, and vice versa). See
-- docs/superpowers/specs/2026-09-30-import-classification-approval-design.md
-- §1.2 for the full design.
alter table people add column linked_application_id uuid unique references applications(id);
```

- [ ] **Step 2: Verify the migration reads correctly**

Confirm `people` and `applications` both exist with the expected column types (read `supabase/migrations/20260722200245_agenda_enums_and_reference_tables.sql` for `people`'s `id uuid primary key`, and `supabase/migrations/20260721202027_applications_table.sql` for `applications`' `id uuid primary key`). No live DB is available in this environment to apply-and-verify directly — disclose this clearly rather than claiming it was tested, per this repo's established pattern for migrations written without live DB access.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260930020000_add_people_linked_application_id.sql
git commit -m "feat: add people.linked_application_id for speaker-application linking

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Speaker classification → `people` trigger + retroactive backfill

**Files:**
- Create: `supabase/migrations/20260930030000_speaker_classification_people_trigger.sql`
- Create: `tests/participants/speaker-linking-live.test.ts`

**Context:** Per spec §1.3 and §4. `apply_import_row_transactional` does an `INSERT` for a new application, an `UPDATE` for a claimed-application re-import — either can result in `participant_type = 'speaker'`. Individual/bulk classification edits (Tasks 5, 6) always do an `UPDATE`. One trigger function, `create_speaker_people_record_if_needed()`, is used by both an `AFTER INSERT` and an `AFTER UPDATE` trigger on `applications`, so the "does this application need a linked `people` row" logic exists in exactly one place. `resolve_application_display_name()` is a small helper both this trigger and the one-time backfill statement call, so the name-fallback chain (`applications.full_name` → `profiles.full_name` → `'Unknown'`) also exists in exactly one place.

- [ ] **Step 1: Write the migration**

```sql
-- 20260930030000_speaker_classification_people_trigger.sql
--
-- Closes gap 3 from docs/superpowers/specs/2026-09-30-import-classification-approval-design.md:
-- links participant_type = 'speaker' applications to the people/
-- session_people speaker system, which was previously entirely
-- disconnected from applications.
--
-- resolve_application_display_name: shared name-fallback used by both the
-- trigger below and this same migration's one-time backfill statement.
-- applications.full_name is nullable and only populated by import/manual
-- edit (20260731100000_phase_b_import_field_extensions.sql) — a claimed
-- application whose full_name was never backfilled still has a real name
-- on profiles.full_name (via applicant_id), so that's the second fallback
-- before the final literal placeholder.
create function resolve_application_display_name(p_applicant_id uuid, p_application_full_name text)
returns text language sql stable as $$
  select coalesce(
    p_application_full_name,
    (select full_name from profiles where id = p_applicant_id),
    'Unknown'
  );
$$;

-- Shared by the AFTER INSERT and AFTER UPDATE triggers below — the
-- "does this application need a linked people row" logic lives here once,
-- not duplicated per trigger. Idempotent: the not-exists guard means a
-- row that already has a linked people record is never touched again,
-- even if this fires multiple times for the same application (e.g. an
-- UPDATE that doesn't actually change participant_type still fires the
-- trigger — the participant_type-changed guard inside this function is
-- what makes re-fires a no-op, not the not-exists check alone).
create function create_speaker_people_record_if_needed()
returns trigger security definer set search_path = public, pg_temp as $$
begin
  if new.participant_type = 'speaker'
     and (TG_OP = 'INSERT' or old.participant_type is distinct from 'speaker')
     and not exists (select 1 from people where linked_application_id = new.id)
  then
    insert into people (full_name_ar, full_name_en, linked_application_id, is_active, is_public)
    values (
      resolve_application_display_name(new.applicant_id, new.full_name),
      resolve_application_display_name(new.applicant_id, new.full_name),
      new.id, true, false
    );
  end if;
  return new;
end;
$$ language plpgsql;

create trigger applications_create_speaker_people_on_insert
  after insert on applications
  for each row
  execute function create_speaker_people_record_if_needed();

create trigger applications_create_speaker_people_on_update
  after update on applications
  for each row
  execute function create_speaker_people_record_if_needed();

-- One-time retroactive backfill: links every pre-existing speaker
-- application that predates this migration (and therefore never fired
-- either trigger above) to a newly-created people row. Idempotent by
-- construction (the not-exists guard matches the trigger's), safe to
-- leave in migration history permanently.
insert into people (full_name_ar, full_name_en, linked_application_id, is_active, is_public)
select
  resolve_application_display_name(a.applicant_id, a.full_name),
  resolve_application_display_name(a.applicant_id, a.full_name),
  a.id, true, false
from applications a
where a.participant_type = 'speaker'
  and not exists (select 1 from people pe where pe.linked_application_id = a.id);
```

- [ ] **Step 2: Write the live test**

Follow this repo's established live-test pattern (see `tests/auth/staff-roles-live.test.ts` or `tests/settings/email-settings-rls-live.test.ts` for the exact throwaway-fixture-creation, service-role-client, fail-loud-on-missing-env-vars shape). Create `tests/participants/speaker-linking-live.test.ts` covering:

- Inserting an `applications` row directly with `participant_type = 'speaker'` creates exactly one linked `people` row, with `full_name_ar`/`full_name_en` both equal to the application's `full_name`.
- Updating an existing non-speaker application's `participant_type` to `'speaker'` creates exactly one linked `people` row.
- Updating a `participant_type = 'speaker'` application's `participant_type` again (e.g. to `'speaker'` — no actual change, or to some other type and back) never creates a second `people` row for the same application — the `not exists`/`is distinct from` guards hold.
- Reclassifying a `'speaker'` application away from `'speaker'` leaves its linked `people` row untouched (still exists, still linked) — per spec §4.2, no cleanup happens.
- The name-fallback chain: an application with `full_name = null` but a claimed `applicant_id` whose `profiles.full_name` is set produces a `people` row using the profile's name, not `'Unknown'`. An application with both `full_name` and `applicant_id` null produces `'Unknown'`.
- Backfill idempotency: manually insert an `applications` row with `participant_type = 'speaker'` directly via SQL (bypassing the trigger is not possible via normal INSERT, so instead: re-run the backfill's `insert ... select ... where not exists (...)` statement a second time against the live DB and confirm it inserts zero rows the second time).

- [ ] **Step 3: Run the test if live credentials are available; otherwise disclose clearly**

```bash
npx vitest run tests/participants/speaker-linking-live.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260930030000_speaker_classification_people_trigger.sql tests/participants/speaker-linking-live.test.ts
git commit -m "feat: link speaker-classified applications to the people/session_people system

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: `application_number` deferred to acceptance for self-registration

**Files:**
- Create: `supabase/migrations/20260930040000_accept_application_and_issue_number.sql`
- Modify: `src/app/[locale]/(participant)/(bare)/register/actions.ts`
- Modify: `src/lib/email/resend.ts`
- Modify: `src/app/[locale]/(participant)/(bare)/register/registration-form.tsx` (if needed — confirm in Step 1)
- Modify: `src/app/[locale]/(admin)/applications/[id]/actions.ts`
- Create/modify: a test file covering self-registration's deferred numbering

**Context:** Per spec §1.1 and §2.1. The import path (`apply_import_row_transactional`) is **not** modified — it already inserts at `status = 'accepted'` with a number, and that already satisfies "code only after approval." Only `submitApplication` (self-registration) changes.

- [ ] **Step 1: Read the current state of every file this task touches**

```bash
cat "src/app/[locale]/(participant)/(bare)/register/actions.ts"
cat "src/app/[locale]/(participant)/(bare)/register/registration-form.tsx"
grep -n "applicationNumber" src/lib/email/resend.ts
```

Confirm: `submitApplication`'s exact current body (already read during plan prep — reproduced below, but re-verify nothing has changed), and whether `registration-form.tsx` actually consumes the returned `applicationNumber` anywhere (per spec §1.1, it doesn't — it just awaits the call and redirects). If this has changed since plan-writing, treat the real current file as authoritative and adjust this task's steps accordingly rather than forcing the plan's assumption.

- [ ] **Step 2: Write the `accept_application_and_issue_number` SQL function**

```sql
-- 20260930040000_accept_application_and_issue_number.sql
--
-- Generates and persists application_number exactly once, atomically, when
-- an application is accepted — closing the gap where application_number
-- previously existed on a self-registered application from the moment of
-- submission (draft -> submitted), well before any staff review. See
-- docs/superpowers/specs/2026-09-30-import-classification-approval-design.md
-- §2.1 for the full reasoning, including why this needs to be a single
-- atomic statement rather than a read-then-write from the caller: two
-- concurrent accept-attempts on the SAME application (e.g. a double-click)
-- must not each generate a number for the one application. The
-- coalesce(...) inside a single UPDATE makes the check-and-generate
-- atomic; nextval()-based generation itself is already race-free
-- regardless, per the same section's reasoning.
--
-- Only ever called from updateApplicationStatus's Server Action after that
-- function has already validated the transition and performed its own
-- optimistic-concurrency status write — this function does not repeat
-- that check, it only handles the number.
create function accept_application_and_issue_number(p_application_id uuid)
returns text language sql as $$
  update applications
  set application_number = coalesce(application_number, next_application_number(participant_type))
  where id = p_application_id
  returning application_number;
$$;
```

- [ ] **Step 3: Wire it into `updateApplicationStatus`**

In `src/app/[locale]/(admin)/applications/[id]/actions.ts`, after the existing status-transition `update`/`select('id')` block succeeds (i.e., after the `if (!updatedRows || updatedRows.length === 0) { throw ... }` check) and before the `application_status_history` insert, add:

```typescript
  if (newStatus === 'accepted') {
    const { error: numberError } = await service.rpc('accept_application_and_issue_number', {
      p_application_id: applicationId,
    });
    if (numberError) {
      console.error('updateApplicationStatus: failed to issue application_number', { applicationId, userId, error: numberError });
      throw numberError;
    }
  }
```

Place this immediately after the status-update block, before the history insert — if number generation fails, the function should throw before recording history for a transition that didn't fully complete. Read the current file's exact surrounding structure (Step 1) and place this at the precise correct point, adjusting variable names if they differ from what's shown here.

- [ ] **Step 4: Remove `next_application_number()` from `submitApplication`**

In `src/app/[locale]/(participant)/(bare)/register/actions.ts`:
- Delete the block calling `service.rpc('next_application_number')` and the `applicationNumber` variable it produces.
- Remove `application_number: applicationNumber` from the `applications` update object (the `draft → submitted` write) — leave every other field in that update (`status: 'submitted'`, `submitted_at`) unchanged.
- Update the call to `sendRegistrationConfirmationEmail` to no longer pass `applicationNumber` (Step 5 removes this param from the function's signature).
- Change the function's return type from `Promise<{ applicationNumber: string }>` to `Promise<void>`, and its final `return { applicationNumber };` to nothing (or remove the explicit return entirely if the function body allows).

- [ ] **Step 5: Remove the `applicationNumber` param from `sendRegistrationConfirmationEmail`**

In `src/lib/email/resend.ts`, remove `applicationNumber: string;` from the function's `params` type, and rewrite the `subject`/`body` template strings to drop the `${params.applicationNumber}` interpolations while keeping the surrounding sentence sensible in both `ar`/`en` (e.g. "Your registration application has been received" instead of "...application (${params.applicationNumber}) has been received" — keep the existing "receipt does not constitute final admission" sentence unchanged, it's unrelated to this task). Match this codebase's existing tone/phrasing for the rest of the message.

- [ ] **Step 6: Fix `registration-form.tsx` if it consumed the return value**

Per Step 1's finding: if `registration-form.tsx` only calls `await submitApplication(draft.id)` and ignores the result (as read during plan prep), no change is needed here beyond confirming the `Promise<void>` return type still typechecks at that call site. If Step 1 found it actually reads `applicationNumber` from the result, update that usage — but per the spec's own caveat, verify this against the real current file rather than assuming.

- [ ] **Step 7: Write the test**

Add to an existing register-flow test file, or create `tests/register/submit-application-live.test.ts` following this repo's established live-test pattern. Cover:
- `submitApplication` on a fresh draft leaves `application_number` null after the `draft → submitted` transition.
- The confirmation email sent by `submitApplication` (mock or inspect via the live test's own established email-verification pattern) no longer contains any application-number-shaped string in its subject/body.
- `updateApplicationStatus(id, 'accepted')` on a `submitted`/`under_review` application with `application_number = null` generates and persists a number (call `accept_application_and_issue_number` directly via a live-test service-role RPC call, or exercise it through `updateApplicationStatus` itself if that function has a `*ForCaller` testable variant — check `applications/[id]/actions.ts` for one; if it doesn't have one, note this as a gap and add the minimal `*ForCaller` split needed, following the exact pattern in `participants/accounts/actions.ts`'s `createAccountsForSelectedForCaller`/`createAccountsForSelected` split).
- `updateApplicationStatus(id, 'accepted')` on an application that already has a non-null `application_number` (simulating a `waitlisted`/`rejected` → `accepted` re-entry) does not change the existing number.
- Two concurrent calls to `accept_application_and_issue_number` for the **same** application (e.g. `Promise.all([rpc(...), rpc(...)])` against the live DB) result in exactly one `next_application_number()` sequence increment and both calls observe the identical final `application_number` value — confirm by checking the relevant sequence's `last_value` before and after, or by comparing both calls' returned values are equal and non-null.

- [ ] **Step 8: Run tests and typecheck**

```bash
npx vitest run tests/register tests/participants
npx tsc --noEmit
```

Expected: all new/modified tests pass; no new typecheck errors beyond this repo's known pre-existing baseline (stale generated types in `tests/attendance/qr-issuance-reservation.test.ts` and/or `tests/attendance/qr-credentials-lifecycle-trigger.test.ts`).

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20260930040000_accept_application_and_issue_number.sql \
  "src/app/[locale]/(participant)/(bare)/register/actions.ts" \
  "src/app/[locale]/(participant)/(bare)/register/registration-form.tsx" \
  src/lib/email/resend.ts \
  "src/app/[locale]/(admin)/applications/[id]/actions.ts" \
  tests/register tests/participants
git commit -m "feat: defer application_number generation to acceptance for self-registration

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Shared reclassify-and-reissue helper

**Files:**
- Create: `src/lib/participants/reclassify.ts`
- Create: `tests/participants/classification-edit.test.ts`
- Create: `tests/participants/classification-edit-live.test.ts`
- Modify: `src/lib/email/resend.ts` (add `sendClassificationChangeNotificationEmail`)

**Context:** Per spec §3.4. This is the shared logic Tasks 5 (individual edit) and 6 (bulk edit) both call — write and test it standalone first, before wiring any UI to it. Per spec §0/§3.4, the "not yet accepted" branch is unreachable through either new UI (both scope to already-`accepted` imported applications) but is still implemented defensively and tested directly here.

- [ ] **Step 1: Read `reissueStaffQrCredential`'s exact signature once more**

```bash
sed -n '188,216p' src/lib/attendance/qr-credential-issuance.ts
```

Confirm the params shape (`requestKey`, `applicationId`, `expectedCurrentCredentialId`, `reissueReasonCode`, `reissueNote`, optional `bulkBatchId`) matches what Step 3 below assumes.

- [ ] **Step 2: Write `sendClassificationChangeNotificationEmail`**

In `src/lib/email/resend.ts`, following the exact existing pattern of `sendRegistrationConfirmationEmail`/`sendLoginDetailsEmail` (read those two in full first if not already fresh in context — both already fetch config, build bilingual subject/body, call `fetchEmailSettings()` once, then `sendEmailGuarded`):

```typescript
export async function sendClassificationChangeNotificationEmail(params: {
  to: string;
  fullName: string;
  newApplicationNumber: string;
  locale: 'ar' | 'en';
}): Promise<{ id: string | null; error: string | null }> {
  const configResult = getResendConfig();
  if (!configResult.ok) {
    return { id: null, error: `Resend not configured: missing ${configResult.missing.join(', ')}` };
  }
  const { config } = configResult;

  const subject =
    params.locale === 'ar'
      ? `تم تحديث رمز مشاركتك - ${params.newApplicationNumber}`
      : `Your attendee code has been updated - ${params.newApplicationNumber}`;

  const body =
    params.locale === 'ar'
      ? `مرحباً ${params.fullName}،\n\nتم تحديث تصنيف مشاركتك، ونتيجة لذلك تم إصدار رمز مشاركة جديد لك: ${params.newApplicationNumber}. الرمز السابق لم يعد صالحاً. إذا كان لديك رمز QR سابق، يرجى استخدام النسخة المحدّثة من حسابك.\n\nإذا كان لديك أي استفسار، يرجى التواصل معنا.`
      : `Hello ${params.fullName},\n\nYour participation classification has been updated, and as a result a new attendee code has been issued: ${params.newApplicationNumber}. Your previous code is no longer valid. If you had a QR code, please use the updated one from your account.\n\nIf you have any questions, please contact us.`;

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

- [ ] **Step 3: Write the failing tests for the shared helper**

Create `tests/participants/classification-edit.test.ts` — mocked unit tests (mock `reissueStaffQrCredential`, `sendClassificationChangeNotificationEmail`, and the Supabase service-role client, following this repo's established mocking conventions for similar helper-level tests). Cover the three branches from spec §3.4:

```typescript
// tests/participants/classification-edit.test.ts
//
// Unit tests for the shared reclassify-and-reissue helper (spec §3.4).
// Mocks reissueStaffQrCredential and sendClassificationChangeNotificationEmail
// so no real crypto/DB/email work happens — this suite verifies BRANCHING
// logic only (which of the 3 states triggers which side effects), not the
// underlying QR/email mechanics themselves (those are covered by
// qr-credential-issuance's own tests and send-guarded.test.ts respectively).
```

Test cases:
- Not-yet-accepted application (`status !== 'accepted'`): `participant_type` is updated, `reissueStaffQrCredential` is never called, `sendClassificationChangeNotificationEmail` is never called, `application_number` is untouched.
- Accepted, no active QR credential: `participant_type` is updated, `application_number` is regenerated (assert the new value differs from the old one and reflects the new type's prefix), `reissueStaffQrCredential` is never called (there's nothing to reissue), no email is sent.
- Accepted, with an active QR credential, `applicant_id` set (claimed): `participant_type` updated, `application_number` regenerated, `reissueStaffQrCredential` called exactly once with `reissueReasonCode: 'administrative_correction'`, `sendClassificationChangeNotificationEmail` called exactly once with the new number.
- Accepted, with an active QR credential, `applicant_id` null (unclaimed): same as above but `sendClassificationChangeNotificationEmail` is never called.

- [ ] **Step 4: Run tests to verify they fail**

```bash
npx vitest run tests/participants/classification-edit.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/participants/reclassify'`.

- [ ] **Step 5: Implement the shared helper**

```typescript
// src/lib/participants/reclassify.ts
//
// Shared logic for all 3 classification-edit paths (spec §3.1 individual,
// §3.2 bulk, both funnel through here; §3.3 import-preview does NOT — it
// edits import_rows before apply_import_row_transactional ever runs, so
// there is no application/QR state to reconcile yet). See
// docs/superpowers/specs/2026-09-30-import-classification-approval-design.md
// §3.4 for the full 3-branch design this implements.
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Database as DB } from '@/types/database';
import { reissueStaffQrCredential } from '@/lib/attendance/qr-credential-issuance';
import { sendClassificationChangeNotificationEmail } from '@/lib/email/resend';

type ServiceClient = SupabaseClient<Database>;
type ParticipantType = DB['public']['Enums']['participant_type'];

export interface ReclassifyResult {
  applicationId: string;
  outcome: 'updated_only' | 'number_regenerated' | 'reissued' | 'error';
  newApplicationNumber?: string;
  errorMessage?: string;
}

// requester (the caller's own authenticated session client) is required
// only for the QR-reissue branch — reissueStaffQrCredential's reservation
// RPC is SECURITY DEFINER and asserts requester_id = auth.uid() internally,
// which only resolves over the caller's own session (see
// qr-credential-issuance.ts's module doc comment). Callers in Task 6's
// bulk-edit path that already have a *ForCaller-testable shape must thread
// this through the same way participants/accounts/actions.ts's existing
// bulk actions do.
export async function reclassifyApplication(
  requester: SupabaseClient<Database>,
  service: ServiceClient,
  params: { applicationId: string; newParticipantType: ParticipantType; actorId: string }
): Promise<ReclassifyResult> {
  const { applicationId, newParticipantType, actorId } = params;

  const { data: application, error: fetchError } = await service
    .from('applications')
    .select('status, applicant_id, full_name, profiles!applications_applicant_id_fkey(full_name, email)')
    .eq('id', applicationId)
    .single();
  if (fetchError || !application) {
    return { applicationId, outcome: 'error', errorMessage: fetchError?.message ?? 'Application not found' };
  }

  const { error: updateError } = await service
    .from('applications')
    .update({ participant_type: newParticipantType })
    .eq('id', applicationId);
  if (updateError) {
    return { applicationId, outcome: 'error', errorMessage: updateError.message };
  }

  if (application.status !== 'accepted') {
    return { applicationId, outcome: 'updated_only' };
  }

  const { data: activeCredential } = await service
    .from('qr_credentials')
    .select('id')
    .eq('application_id', applicationId)
    .eq('status', 'active')
    .maybeSingle();

  const { data: numberResult, error: numberError } = await service.rpc('accept_application_and_issue_number', {
    p_application_id: applicationId,
  });
  if (numberError || !numberResult) {
    return { applicationId, outcome: 'error', errorMessage: numberError?.message ?? 'Failed to regenerate application_number' };
  }
  const newApplicationNumber = numberResult as string;

  if (!activeCredential) {
    return { applicationId, outcome: 'number_regenerated', newApplicationNumber };
  }

  const reissueOutcome = await reissueStaffQrCredential(requester, service, {
    requestKey: randomUUID(),
    applicationId,
    expectedCurrentCredentialId: activeCredential.id,
    reissueReasonCode: 'administrative_correction',
    reissueNote: `Classification changed to ${newParticipantType}`,
  });
  if (reissueOutcome.outcome !== 'reissued' && reissueOutcome.outcome !== 'already_finalized') {
    console.error('reclassifyApplication: unexpected reissue outcome', { applicationId, outcome: reissueOutcome.outcome });
  }

  if (application.applicant_id) {
    const profile = Array.isArray(application.profiles) ? application.profiles[0] : application.profiles;
    if (profile?.email && profile?.full_name) {
      const emailResult = await sendClassificationChangeNotificationEmail({
        to: profile.email,
        fullName: profile.full_name,
        newApplicationNumber,
        locale: 'en',
      });
      if (emailResult.error) {
        console.error('reclassifyApplication: notification email failed', { applicationId, error: emailResult.error });
      }
    }
  }

  return { applicationId, outcome: 'reissued', newApplicationNumber };
}
```

Note: `accept_application_and_issue_number` (Task 3) is reused here for its coalesce-based idempotency — since `application_number` already exists on an accepted application (it wouldn't be `accepted` otherwise per Task 3's guarantee), this call will NOT actually regenerate anything unless the function is changed. **This is a bug requiring resolution before this step is considered done**: `accept_application_and_issue_number`'s `coalesce(application_number, ...)` means it only ever generates a number when one is absent, but §3.4 requires the number to be genuinely regenerated (replaced) on every reclassification of an accepted application. Do not reuse that function as-is. Instead, write the regeneration inline here (or as a small second SQL function, e.g. `regenerate_application_number(application_id uuid)` with no coalesce guard, doing `update applications set application_number = next_application_number(participant_type) where id = ... returning application_number` unconditionally) and call that instead. Add this second function to Task 3's migration file if Task 3 has not yet been committed, or as a new migration in this task if it has — check the actual state of the repo before deciding which.

- [ ] **Step 6: Run tests to verify they pass**

```bash
npx vitest run tests/participants/classification-edit.test.ts
```

- [ ] **Step 7: Write the live test**

Create `tests/participants/classification-edit-live.test.ts`, following this repo's established live-test pattern. Cover the same 4 scenarios as Step 3 but against a real database and a real (or realistically mocked-at-the-Resend-SDK-layer, following `resend-send.test.ts`'s convention) email send — specifically:
- A real accepted application with a real active QR credential (create one via `issueStaffQrCredential` as test setup) gets reclassified: assert the OLD credential's `status` is now `'replaced'` in the DB, a NEW credential exists with `status = 'active'`, and `application_number` genuinely changed value.
- Confirm exactly one email is sent via the guarded layer when `applicant_id` is set, and zero when it's null — reuse this repo's established `vi.mock('@/lib/email/send-guarded', ...)`-style pattern if this test isn't meant to hit real Resend, or follow whatever this repo's convention is for a live test that also needs to avoid real email sends (check `tests/import/invitation-live.test.ts` or similar for how a live-DB test avoids real external side effects it doesn't want).

- [ ] **Step 8: Run tests and typecheck**

```bash
npx vitest run tests/participants
npx tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add src/lib/participants/reclassify.ts src/lib/email/resend.ts tests/participants/classification-edit.test.ts tests/participants/classification-edit-live.test.ts supabase/migrations/
git commit -m "feat: shared reclassify-and-reissue helper for classification changes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Individual classification edit + Issue QR on `participants/[applicationId]`

**Files:**
- Create: `src/app/[locale]/(admin)/participants/[applicationId]/classification-controls.tsx`
- Create: `src/app/[locale]/(admin)/participants/[applicationId]/qr-actions.ts`
- Modify: `src/app/[locale]/(admin)/participants/[applicationId]/page.tsx`
- Modify: `src/app/[locale]/(admin)/participants/[applicationId]/actions.ts`
- Modify: `src/messages/en.json`, `src/messages/ar.json`

**Context:** Per spec §0, §2.2, §3.1. This is the primary correction from the original spec draft — these controls go here, not on the legacy `applications/[id]` page.

- [ ] **Step 1: Read the current full file**

```bash
cat "src/app/[locale]/(admin)/participants/[applicationId]/page.tsx"
cat "src/app/[locale]/(admin)/participants/[applicationId]/actions.ts"
```

(Already read in full during plan prep — re-confirm nothing has changed since.)

- [ ] **Step 2: Add `application_number`/`participant_type` to the page's query, fix the back-link**

In `page.tsx`, add `application_number, participant_type` to the existing `applications` select's column list. Add both to the `fields` array's display (e.g. `[t('applicationNumber'), application.application_number ?? '—']` and `[t('participantType'), application.participant_type ?? '—']`, placed near the existing `status`/`claimed` fields). Change `<Link href="/participants" ...>` to `<Link href="/participants/accounts" ...>` (per spec §0 — `/participants` currently redirects into the flagged-off `/applications`, which 404s; `/participants/accounts` is the real, reachable roster this page's "back" link should actually go to).

- [ ] **Step 3: Write the new "Issue QR" Server Action**

```typescript
// src/app/[locale]/(admin)/participants/[applicationId]/qr-actions.ts
'use server';

import { randomUUID } from 'node:crypto';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isStaffRole } from '@/lib/auth/is-staff-role';
import { issueStaffQrCredential } from '@/lib/attendance/qr-credential-issuance';

// Two-client shape matches qr-credential-issuance.ts's own documented
// requirement (see that module's header comment): the reservation RPC is
// SECURITY DEFINER and derives the caller from auth.uid(), which only
// resolves over the caller's own session client — service-role has no
// auth.uid() and is rejected outright. `session` (this caller's own
// authenticated client) reserves; `service` finalizes and does every other
// read/write. Mirrors my-qr/actions.ts's requireParticipantCaller shape,
// adapted for a staff (not participant) caller.
async function requireStaffCallerWithSession() {
  const session = await createClient();
  const { data: { user } } = await session.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (error || !profile) throw new Error('Profile not found');
  if (!isStaffRole(profile.role)) throw new Error('Not authorized');

  return { userId: user.id, session, service };
}

export async function issueQrForApplicationAction(applicationId: string): Promise<{ error: string | null }> {
  const { session, service } = await requireStaffCallerWithSession();

  const { data: application, error: fetchError } = await service
    .from('applications')
    .select('status')
    .eq('id', applicationId)
    .single();
  if (fetchError || !application) return { error: 'Application not found' };
  if (application.status !== 'accepted') return { error: 'Only accepted applications can be issued a QR code' };

  const result = await issueStaffQrCredential(session, service, {
    requestKey: randomUUID(),
    applicationId,
    issuanceReasonCode: 'staff_other',
    issuanceNote: 'Issued from participant detail page',
  });

  if (result.outcome !== 'issued' && result.outcome !== 'already_finalized' && result.outcome !== 'active_credential_already_exists') {
    return { error: `Unexpected issuance outcome: ${result.outcome}` };
  }
  return { error: null };
}
```

Verify `issuance_reason_code`'s valid values include `'staff_other'` before finalizing this (per prior investigation: `qr_credentials_issuance_reason_code_valid` allows `'advance_badge_printing', 'participant_not_logged_in', 'bulk_event_preparation', 'staff_other', 'reissued_credential'` — `'staff_other'` is valid).

- [ ] **Step 4: Write `classification-controls.tsx`**

Client Component, following `invitation-controls.tsx`'s exact conventions (same `busy`/`error` state shape, same `Card`/`Button` usage, same `window.location.reload()` after a successful action). Props: `applicationId: string`, `currentParticipantType: string | null`, `applicationStatus: string`, `hasActiveQrCredential: boolean` (page.tsx queries `qr_credentials` for this — see Step 5).

- A `<select>` of the 5 `participant_type` values (`delegate | volunteer | knowledge_partner | youngo | speaker`) defaulting to the current value, plus a "Save" button that calls a new `updateParticipantTypeAction(applicationId, newType)` Server Action (add this to `actions.ts` — thin wrapper around Task 4's `reclassifyApplication`, following the `*ForCaller`/plain-export split already established in `actions.ts`'s existing `sendInvitationActionForCaller`/`sendInvitationAction` pattern).
- An "Issue QR" button, rendered only when `applicationStatus === 'accepted' && !hasActiveQrCredential`, calling `issueQrForApplicationAction` from Step 3.
- Both actions follow the same `run()`-wrapper/error-display/reload pattern as `invitation-controls.tsx`.

- [ ] **Step 5: Wire `updateParticipantTypeAction` into `actions.ts`**

```typescript
// Add to src/app/[locale]/(admin)/participants/[applicationId]/actions.ts
import { reclassifyApplication } from '@/lib/participants/reclassify';
import { createClient } from '@/lib/supabase/server';

export async function updateParticipantTypeActionForCaller(
  applicationId: string,
  newParticipantType: Database['public']['Enums']['participant_type'],
  caller: { userId: string; session: SupabaseClient<Database>; service: ServiceClient }
) {
  const result = await reclassifyApplication(caller.session, caller.service, {
    applicationId,
    newParticipantType,
    actorId: caller.userId,
  });
  if (result.outcome === 'error') throw new Error(result.errorMessage ?? 'Failed to update classification');
  return result;
}

export async function updateParticipantTypeAction(
  applicationId: string,
  newParticipantType: Database['public']['Enums']['participant_type']
) {
  const session = await createClient();
  const { data: { user } } = await session.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || !isStaffRole(profile.role)) throw new Error('Not authorized');
  return updateParticipantTypeActionForCaller(applicationId, newParticipantType, { userId: user.id, session, service });
}
```

Read the current top of `actions.ts` first to match its existing import style/`ServiceClient` type alias exactly rather than introducing a second, differently-named one.

- [ ] **Step 6: Wire everything into `page.tsx`**

Add a `qr_credentials` query (`.select('id').eq('application_id', applicationId).eq('status', 'active').maybeSingle()`) alongside the existing queries, and render `<ClassificationControls applicationId={applicationId} currentParticipantType={application.participant_type} applicationStatus={application.status} hasActiveQrCredential={!!activeCredential} />` after the existing `<InvitationControls .../>`.

- [ ] **Step 7: Add translation keys**

Add whatever `en.json`/`ar.json` keys `classification-controls.tsx` and the new `applicationNumber`/`participantType` display fields need, under the `participants.detail` namespace (matching the existing key structure in that file). For `ar.json`: valid, clean Arabic text only — do not propagate or attempt to fix the repo's known pre-existing mojibake corruption elsewhere in that file (established rule from prior sub-projects).

- [ ] **Step 8: Run typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add "src/app/[locale]/(admin)/participants/[applicationId]/" src/messages/
git commit -m "feat: individual classification edit + Issue QR control on participant detail page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Bulk classification edit on `participants/accounts`

**Files:**
- Modify: `src/app/[locale]/(admin)/participants/accounts/page.tsx`
- Modify: `src/app/[locale]/(admin)/participants/accounts/accounts-table.tsx`
- Modify: `src/app/[locale]/(admin)/participants/accounts/actions.ts`
- Create: `src/app/[locale]/(admin)/participants/accounts/classification-dialog.tsx` (extracted for size — see Step 4)
- Modify: `src/messages/en.json`, `src/messages/ar.json`

**Context:** Per spec §0, §3.2. Extends the already-real, nav-linked accounts roster with a bulk "change classification" action, reusing its existing multi-select + dialog + per-item-result-reporting conventions exactly.

- [ ] **Step 1: Read the current full state of all 3 files**

```bash
cat "src/app/[locale]/(admin)/participants/accounts/page.tsx"
cat "src/app/[locale]/(admin)/participants/accounts/accounts-table.tsx"
cat "src/app/[locale]/(admin)/participants/accounts/actions.ts"
```

(Already read substantial portions during plan prep — re-confirm current state, especially `accounts-table.tsx`'s full ~380+ lines beyond what was read, since only the first ~180 lines were reviewed.)

- [ ] **Step 2: Add `participant_type` to the page query and `AccountRow`**

In `page.tsx`, add `participant_type` to the `applications` select's column list. In `accounts-table.tsx`, add `participantType: string | null` to the `AccountRow` interface, and map it in `page.tsx`'s row-building code (`app.participant_type` → `participantType: app.participant_type`).

- [ ] **Step 3: Write the new bulk action**

```typescript
// Add to src/app/[locale]/(admin)/participants/accounts/actions.ts
import { reclassifyApplication } from '@/lib/participants/reclassify';

export interface ClassificationChangeResult {
  applicationId: string;
  outcome: 'updated_only' | 'number_regenerated' | 'reissued' | 'error';
  errorMessage?: string;
}

export async function changeClassificationForSelectedForCaller(
  applicationIds: string[],
  newParticipantType: Database['public']['Enums']['participant_type'],
  caller: { userId: string; session: SupabaseClient<Database>; service: ServiceClient }
): Promise<ClassificationChangeResult[]> {
  return processInChunks(applicationIds, async (applicationId) => {
    const result = await reclassifyApplication(caller.session, caller.service, {
      applicationId,
      newParticipantType,
      actorId: caller.userId,
    });
    return { applicationId: result.applicationId, outcome: result.outcome, errorMessage: result.errorMessage };
  });
}

export async function changeClassificationForSelected(
  applicationIds: string[],
  newParticipantType: Database['public']['Enums']['participant_type']
): Promise<ClassificationChangeResult[]> {
  const session = await createClient();
  const { data: { user } } = await session.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const { service } = await requireAdmissionStaffCaller();
  return changeClassificationForSelectedForCaller(applicationIds, newParticipantType, { userId: user.id, session, service });
}
```

Check `requireAdmissionStaffCaller`'s actual return shape (`src/lib/admission/server-helpers.ts`) — if it doesn't already return a session client, adapt this to fetch one directly via `createClient()` the same way, matching whatever this file's own established pattern for obtaining both clients is (check if any of the file's existing actions already need a session client for anything, or if this is the first one to need it — reissueStaffQrCredential's requirement makes this genuinely necessary here, unlike the file's other existing actions).

Note: `processInChunks` is already defined in this file (read in full during plan prep) — reuse it exactly as-is, do not redefine.

- [ ] **Step 4: Extract `classification-dialog.tsx` and wire it into `accounts-table.tsx`**

Given `accounts-table.tsx` is already a large file (380+ lines per Step 1), extract the new classification-picker dialog content into its own small Client Component rather than inlining a 6th `pendingAction` branch directly into the existing dialog's JSX. This component receives the current `selected` set size, a callback to run the change, and renders: a `<select>` of the 5 `participant_type` values (defaulting to nothing selected — this is a bulk SET operation, not a per-row edit, so there's no sensible "current value" default), a confirmation button disabled until a type is chosen, following the same `disabled={processing || ...}` pattern as the existing `reset` action's `resetConfirmText !== 'CONFIRM'` guard.

In `accounts-table.tsx` itself: add `'changeClassification'` to `BulkActionKind`, add a new toolbar button (following the existing button-per-action pattern) that sets `pendingAction = 'changeClassification'`, and add the corresponding case to `runAction`'s switch statement calling `changeClassificationForSelected(ids, selectedType)` (threading the dialog's selected type through — this requires either lifting that piece of state up into `AccountsTable` itself, or having `classification-dialog.tsx` own it and call a passed-in `onConfirm(type)` callback that `AccountsTable` provides).

- [ ] **Step 5: Add translation keys**

Add whatever new keys the toolbar button, dialog, and `participantType` table column need, under the `participants.accounts` namespace.

- [ ] **Step 6: Run typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add "src/app/[locale]/(admin)/participants/accounts/" src/messages/
git commit -m "feat: bulk classification edit on the participants accounts roster

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: Live verification of Task 4's helper wired through Tasks 5 and 6

**Files:** none (test-only)

**Context:** Tasks 5 and 6 wire UI to Task 4's already-tested helper. This task adds live tests specifically exercising the two new Server Action entry points (not re-testing the helper's own branching logic, already covered by Task 4).

- [ ] **Step 1: Write live tests for the two new Server Action entry points**

Add to `tests/participants/classification-edit-live.test.ts` (created in Task 4) or a sibling file:
- `updateParticipantTypeActionForCaller` (Task 5) correctly delegates to `reclassifyApplication` and its result shape matches what `classification-controls.tsx` expects.
- `changeClassificationForSelectedForCaller` (Task 6) applied to a batch of 3 applications in mixed QR states (per spec §3.4/Testing: since `participants/accounts` only ever lists accepted applications, the batch varies by QR state, not approval state — one with no active QR, one with an active QR) produces the correct per-application outcome for each, and the aggregate result array correctly attributes each outcome to its `applicationId`.
- `issueQrForApplicationAction` (Task 5): succeeds for an accepted application with no active credential; returns an error (not a throw) for a non-accepted application; is idempotent on a repeated call for an application that already has an active credential (returns `active_credential_already_exists`-equivalent success, not a hard failure).

- [ ] **Step 2: Run tests**

```bash
npx vitest run tests/participants
```

- [ ] **Step 3: Commit**

```bash
git add tests/participants/
git commit -m "test: live coverage for classification-edit and issue-QR Server Actions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: Classification edit during import preview

**Files:**
- Modify: `src/app/[locale]/(admin)/participants/import/[batchId]/preview/actions.ts`
- Modify: `src/app/[locale]/(admin)/participants/import/[batchId]/preview/preview-table.tsx`
- Modify: `src/messages/en.json`, `src/messages/ar.json`

**Context:** Per spec §3.3. This is entirely independent of Tasks 4-7 — it edits `import_rows.normalized_row` before `apply_import_row_transactional` ever runs, not `applications`. No reissue/QR/email logic applies here at all.

- [ ] **Step 1: Read the current full state of both files**

```bash
cat "src/app/[locale]/(admin)/participants/import/[batchId]/preview/actions.ts"
cat "src/app/[locale]/(admin)/participants/import/[batchId]/preview/preview-table.tsx"
```

Confirm the exact shape of `import_rows.normalized_row` (jsonb) and how `getPreviewRows` currently returns it to the client (already partially read during plan prep — the `PreviewRow` type includes `normalized_row: Record<string, unknown> | null`).

- [ ] **Step 2: Write the new Server Action**

```typescript
// Add to preview/actions.ts
const PARTICIPANT_TYPES = ['delegate', 'volunteer', 'knowledge_partner', 'youngo', 'speaker'] as const;

export async function updateRowParticipantTypeForCaller(
  importRowId: string,
  newParticipantType: (typeof PARTICIPANT_TYPES)[number],
  caller: { userId: string; service: ServiceClient }
): Promise<{ error: string | null }> {
  const { service } = caller;
  const { data: row, error: fetchError } = await service
    .from('import_rows')
    .select('normalized_row')
    .eq('id', importRowId)
    .single();
  if (fetchError || !row) return { error: 'Import row not found' };

  const updatedNormalized = { ...(row.normalized_row as Record<string, unknown> ?? {}), participant_type: newParticipantType };
  const { error: updateError } = await service
    .from('import_rows')
    .update({ normalized_row: updatedNormalized as Json })
    .eq('id', importRowId);
  if (updateError) return { error: updateError.message };
  return { error: null };
}

export async function updateRowParticipantType(
  importRowId: string,
  newParticipantType: (typeof PARTICIPANT_TYPES)[number]
) {
  const caller = await requireImportStaffCaller();
  return updateRowParticipantTypeForCaller(importRowId, newParticipantType, caller);
}
```

Match this file's exact existing import style (it already imports `requireImportStaffCaller`, `Json`, `Database`, `SupabaseClient` — reuse those, don't reintroduce).

- [ ] **Step 3: Add the per-row editable control to `preview-table.tsx`**

In each row's rendering (both the mobile-card and desktop-table branches, per this codebase's established dual-rendering convention — see `preview-table.tsx`'s existing structure), add a `<select>` showing `row.normalized_row?.participant_type` with the 5 valid values, calling `updateRowParticipantType(row.id, newValue)` on change and then refreshing that row's local state (follow whatever local-state-update pattern `preview-table.tsx` already uses elsewhere for row-level mutations — read the file fully in Step 1 to find the established convention, e.g. optimistic local update vs. full `loadRows` re-fetch).

- [ ] **Step 4: Add translation keys**

- [ ] **Step 5: Run typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Manual verification note**

No live DB in this environment to click through the actual preview UI end-to-end. Disclose this clearly rather than claiming visual verification.

- [ ] **Step 7: Commit**

```bash
git add "src/app/[locale]/(admin)/participants/import/[batchId]/preview/" src/messages/
git commit -m "feat: editable participant_type control in import preview step

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 9: Final verification sweep

**Files:** none

- [ ] **Step 1:** Run the full test suite: `npx vitest run`. Confirm no NEW failures beyond this repo's known pre-existing baseline (live-DB tests failing on missing env vars in a sandboxed environment; any other pre-existing failures already documented in this repo's own test-suite history — check the most recent sub-project's final-sweep notes for the current known-baseline list before drawing conclusions, since it may have shifted).
- [ ] **Step 2:** Run `npx tsc --noEmit`, confirm the error count matches the known baseline with nothing new.
- [ ] **Step 3:** Re-run every live test this plan added (Tasks 2, 3, 4, 7) one more time together, as the definitive proof the whole feature works end-to-end against a real database: speaker linking, deferred self-registration numbering, the full reclassify-and-reissue branch logic, and the two new Server Action entry points.
- [ ] **Step 4:** If a scratch Supabase project is available, manually walk through: import a spreadsheet with a `speaker`-classified row via the full UI, confirm a linked `people` row appears in `/agenda/people`; accept a self-registered application and confirm `application_number` appears only after acceptance; reclassify an accepted-with-QR application via `/participants/accounts`'s bulk action and confirm the old QR is revoked/replaced and a notification email arrives (or lands in the sandbox-mode inbox, per sub-project 2's guard) only for a claimed application. If no scratch project is available, disclose this clearly as a limitation.
- [ ] **Step 5:** Report completion — summarize what was built, confirm sub-project 3 of 6 is done, and that sub-project 4 (sessions/booking/work-groups) is ready to start whenever the user chooses.
