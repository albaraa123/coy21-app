# Import / Classification / Approval — Closing the Three Gaps

## Context

This is sub-project 3 of 6 in the COY21 conference-platform feature roadmap. A prior investigation found that most of what the original request described (spreadsheet import with preview and duplicate detection, `participant_type` classification with per-type code sequences, invitations as a separate manual step, an applications approval workflow) is **already built** from earlier, unrelated work. This spec covers only the three real, confirmed gaps:

1. **No UI exists to change `participant_type` after import.**
2. **No link exists between approval and code issuance** — `application_number` is generated at import time (before any human review), and QR credential issuance has no connection to `application_number` or approval status at all.
3. **No link exists between `participant_type = 'speaker'` and the `people`/`session_people` system** — they are two entirely disconnected concepts today.

This design closes all three gaps using the codebase's existing conventions and infrastructure wherever it already exists — it deliberately does **not** redesign the import pipeline, the approval state machine, or the QR credential system, all of which already work and are out of scope.

## Background: what already exists (read-only context, not part of this design)

- **Import pipeline**: upload → map columns → **preview** (already has per-row duplicate/validation display) → confirm/commit via `apply_import_row_transactional`. Duplicate detection (`duplicate_in_file` / `existing_unclaimed` / `existing_claimed` / `blocked_downstream`) already implemented in `src/lib/import/row-validation.ts`.
- **Classification**: `participant_type` enum (`delegate | volunteer | knowledge_partner | youngo | speaker`) on `applications` and `import_rows`. `next_application_number(participant_type)` generates codes like `COY21-DEL-0001` via five independent Postgres sequences; its no-arg overload (`next_application_number()`) defaults to the `DEL` sequence. Called from inside `apply_import_row_transactional` (multiple migration-versioned copies of that function) **and** from `submitApplication` (`src/app/[locale]/(participant)/(bare)/register/actions.ts`, the participant self-registration submit action) — both are in scope for §1.1 below.
- **Invitations**: `sendInvitation`/`resendInvitation`/`revokeInvitation` in `src/lib/import/invitation.ts` — already a manual, separate, per-application step (not triggered by import), already gated by the email sandbox-mode guard built in sub-project 2.
- **Approval**: `applications.status` (`draft | submitted | under_review | accepted | waitlisted | rejected | withdrawn`), valid transitions enforced by `VALID_TRANSITIONS` in `src/lib/validation/admission-review.ts`. `updateApplicationStatus` in `src/app/[locale]/(admin)/applications/[id]/actions.ts` is the sole mutation path, gated by `requireStaffCaller()`.
- **QR credentials**: `qr_credentials` keyed by `application_id` (FK `on delete restrict`), one active credential per application (`qr_credentials_one_active_per_application` partial unique index). Issuance and reissuance are both **reservation + finalize** RPC pairs (`request_staff_qr_reissue_transactional` → Node token generation → `finalize_qr_reissue_for_server`), because cryptographic token material is generated in Node, not SQL. An existing trigger, `applications_revoke_qr_on_ineligibility`, already auto-revokes the active QR credential whenever `applications.status` transitions away from `'accepted'` — this design does not touch that trigger.
- **Speakers**: `people` (standalone identity table — name, title, org, bio, optional `linked_profile_id → profiles`) and `session_people` (person↔session join, `role` enum including `'speaker'`) already fully support guest speakers with zero relationship to `applications`. `src/app/[locale]/(admin)/agenda/people/` and `.../agenda/sessions/[id]/speaker-assignment.tsx` are the existing management UIs.
- **Roles**: post role-consolidation, `isStaffRole`/`is_staff()` (accepts `staff` or `super_admin`) is the single authorization gate used throughout. This design introduces no new role distinctions.

---

## 1. Data model changes

### 1.1. `application_number` generation moves from import-time to approval-time — for BOTH intake paths

There are two distinct paths that create an `applications` row and, today, both issue a number before any staff approval:

1. **Staff import**: every current call site of `next_application_number(participant_type)` is inside a versioned copy of `apply_import_row_transactional` (8 migration-history copies, latest being `20260823010000_wire_participant_type_to_apply_import_row.sql`).
2. **Participant self-registration**: `submitApplication` in `src/app/[locale]/(participant)/(bare)/register/actions.ts` calls the same function (its no-arg overload, `next_application_number()`, which — as of `20260822000000_coy21_attendee_codes.sql` — resolves to the `DEL` sequence and produces the current `COY21-DEL-NNNN` format, not the older `RCOY-2026-NNNNN` format its own stale code comment describes) at the moment a participant submits their own draft application (`status: draft → submitted`), which is well before any staff review.

Both call sites are in scope for this change, since "code only issued after approval" is the stated goal regardless of which path created the application:

- The import path: a new migration adds one more versioned copy of `apply_import_row_transactional` that **stops** calling `next_application_number(...)` and leaves `applications.application_number` as `null` on insert. Everything else in that function (participant_type wiring, travel/health field extension, claimed-update gating) is unchanged — a narrow, surgical diff against the latest existing version.
- The self-registration path: `submitApplication` removes its `next_application_number()` call entirely. The `applications` update at `draft → submitted` no longer sets `application_number`; it stays `null` until acceptance, exactly like an imported row. The rest of `submitApplication` (draft-ownership scoping, the concurrent-resubmit guard, `application_status_history` insert) is unchanged, with one downstream fix: `sendRegistrationConfirmationEmail` (`src/lib/email/resend.ts`) currently takes a required `applicationNumber: string` param and interpolates it directly into both the subject line and body of the confirmation email. Since a number no longer exists at submission time, this param is removed from the function's signature and both call sites in its template text — the email keeps its existing "receipt does not constitute final admission" language (already present, unrelated to this change) but drops the reference to a number that hasn't been assigned yet. `submitApplication`'s return type (`Promise<{ applicationNumber: string }>`) and `registration-form.tsx`'s consumption of it are checked as part of this same change — the current UI (read above) doesn't actually display the returned `applicationNumber` anywhere (it just calls `submitApplication` and redirects to `/my-application` on success), so the return type can be simplified to `Promise<void>` without any UI change, but this should be confirmed against the real current file before the implementation plan finalizes it, since UI code changes independently of this spec being written.

After this change, both intake paths land with `application_number = null` until a human accepts them — one single rule, applied uniformly. The participant-facing `/my-application` page (`src/app/[locale]/(participant)/(shell)/my-application/page.tsx:95`) already renders `application.application_number ?? '—'` — it requires no change and will correctly show a dash for the "no code yet" period between submission and acceptance.

### 1.2. `people.linked_application_id`

```sql
alter table people add column linked_application_id uuid unique references applications(id);
```

Nullable, unique (mirrors the existing `linked_profile_id uuid unique references profiles(id)` pattern on the same table — one `people` row can link to at most one `applications` row, and one `applications` row can be linked from at most one `people` row).

### 1.3. Retroactive backfill (one-time, point-in-time migration)

Confirmed against the real schema: `applications.full_name` (single `text` column, nullable, added by `20260731100000_phase_b_import_field_extensions.sql`) is the source-of-truth name for an application record regardless of claim status — it is populated by import and is distinct from `profiles.full_name`, which only exists once an application is claimed into a real account. Because `applications.full_name` was added after some earlier imports, and because not every accepted/claimed application is guaranteed to have had it backfilled, the name lookup falls back to `profiles.full_name` (via `applicant_id`) when `applications.full_name` is null, before finally falling back to a literal placeholder. This fallback chain is identical to the one the trigger in §4.1 needs, so both this migration and that trigger call one shared function, `resolve_application_display_name(p_applicant_id uuid, p_application_full_name text) returns text`, defined once by this same migration:

```sql
create function resolve_application_display_name(p_applicant_id uuid, p_application_full_name text)
returns text language sql stable as $$
  select coalesce(
    p_application_full_name,
    (select full_name from profiles where id = p_applicant_id),
    'Unknown'
  );
$$;

insert into people (full_name_ar, full_name_en, linked_application_id, is_active, is_public)
select
  resolve_application_display_name(a.applicant_id, a.full_name),
  resolve_application_display_name(a.applicant_id, a.full_name),
  a.id, true, false
from applications a
where a.participant_type = 'speaker'
  and not exists (select 1 from people pe where pe.linked_application_id = a.id);
```

`people` has no native Arabic/English name distinction to draw from either source — both `full_name_ar` and `full_name_en` are seeded with the same value, exactly as before; staff corrects them manually afterward per the design decision in this section's parent context.

This uses the same name-resolution logic as the trigger described in §4.1, but as a one-time backfill statement rather than the trigger itself, since the trigger only fires on future `UPDATE`s, not on rows that already had `participant_type = 'speaker'` before this migration ran.

---

## 2. Approval → code issuance

### 2.1. `application_number` issued on acceptance

`updateApplicationStatus(applicationId, 'accepted')` in `src/app/[locale]/(admin)/applications/[id]/actions.ts` gains one new step, inline, after the existing status-transition write and before returning: if `applications.application_number is null`, generate one via `next_application_number(participant_type)` and persist it in the same update. If a number already exists (re-entry to `accepted` after a prior `waitlisted`/`rejected` detour), it is left untouched — no new number is generated.

`next_application_number` currently has no TypeScript RPC wrapper (it has only ever been called from inside other PL/pgSQL functions). `nextval()`-based sequence generation is already atomic and race-free by Postgres semantics regardless of whether it's called via a raw RPC or wrapped in a new function — so that is not, by itself, a reason to prefer one over the other. The actual race to guard against is different: the "only generate a number if `application_number is null`" check and the write must happen atomically for a *single* application, so two concurrent accept-attempts on the *same* application (e.g. a double-click, or two staff members both loading and accepting the same record) can't both pass the null-check and each generate a wasted/duplicate number. This is naturally solved by folding the check-and-generate into one SQL function (e.g. `accept_application_and_issue_number(application_id uuid)`, called from the Server Action) that does `update applications set application_number = coalesce(application_number, next_application_number(participant_type)) where id = ... returning application_number` in one statement — the existing `updateApplicationStatus`'s established optimistic-concurrency pattern (`.eq('status', oldStatus)` guard) is a separate, unrelated race-guard for the status transition itself and doesn't cover this. The implementation plan should follow the established convention of doing sequence-based code generation in PL/pgSQL (matching every other call site of `next_application_number`), which also naturally gives this single-statement atomicity for free.

### 2.2. QR issuance remains a separate, manual staff action

No automatic QR issuance on acceptance. `src/lib/attendance/qr-credential-issuance.ts` already exports both `issueStaffQrCredential` (fresh issuance) and `reissueStaffQrCredential` (line 188 — wraps `request_staff_qr_reissue_transactional` → Node token generation → `finalize_qr_reissue_for_server`, the exact pair used in §3.4 below), but **neither has a Server Action caller anywhere in the codebase today** — both are fully implemented, wired to nothing. This design adds the first caller for `issueStaffQrCredential`: a new Server Action and an "Issue QR" control on `applications/[id]`, visible only when `status = 'accepted'` and no active `qr_credentials` row exists for the application. Wires straight to the existing function — no new SQL.

### 2.3. Moving away from `accepted`

Unchanged existing behavior: the `applications_revoke_qr_on_ineligibility` trigger already revokes any active QR credential automatically when `status` transitions away from `'accepted'`. `application_number`, once issued, is never cleared by a later status change — it remains on the record as history, and is reused (not regenerated) if the application is later re-accepted.

---

## 3. Classification editing (three methods) and reissue-on-change

### 3.1. Individual edit

A new control on `applications/[id]` (staff-gated) to change `participant_type` for one application.

### 3.2. Bulk edit

A new multi-select + "change classification" action on the `applications` list page (`src/app/[locale]/(admin)/applications/page.tsx`), for changing `participant_type` on multiple selected applications in one operation.

### 3.3. Edit during import preview

The existing `preview` step (`participants/import/[batchId]/preview/`) gains a per-row editable `participant_type` control, so staff can manually correct auto-mapped or missing classifications before committing the batch — separate from (and in addition to) the existing automatic column-mapping behavior in the `map` step.

### 3.4. Reissue-on-change (shared logic across 3.1 and 3.2; not applicable to 3.3)

All three edit paths funnel through one shared Server Action / helper. Its behavior depends on the application's current state:

- **Not yet `accepted`** (no `application_number`, no QR): plain column update. No side effects.
- **`accepted`, no active QR credential** (number exists, QR was never issued or was revoked by an earlier status change): the `application_number` is regenerated for the new `participant_type` via the same mechanism as §2.1. No QR action (there is none to reissue).
- **`accepted`, with an active QR credential**: the full reissue sequence runs via the existing, already-fully-implemented `reissueStaffQrCredential` (`src/lib/attendance/qr-credential-issuance.ts:188`) — this is the staff-specific counterpart to the participant self-service `reissueMyQrCredential` used by `my-qr/actions.ts`'s `reissueMyQrCredentialAction`, and it already wraps the exact `request_staff_qr_reissue_transactional` → Node token generation → `finalize_qr_reissue_for_server` sequence needed here. No new reissue logic is required, only a new caller:
  1. Regenerate `application_number` for the new type (as above).
  2. Call `reissueStaffQrCredential(requester, service, { requestKey, applicationId, expectedCurrentCredentialId, reissueReasonCode: 'administrative_correction', reissueNote, bulkBatchId? })` — the existing `'administrative_correction'` value already in `qr_credentials_reissue_reason_code_valid`'s check constraint, no new reason code or constraint migration needed.
  3. If `applications.applicant_id` is set (the participant has a claimed account), send a notification email via `sendEmailGuarded` informing them their code changed. If unclaimed, no email is sent (there is no account to notify, and email would go nowhere useful).

The old `application_number` value is not separately archived — it is simply overwritten, and the change is captured by this codebase's existing `audit_logs` table (the same pattern already used for other sensitive mutations), which is judged sufficient for review purposes.

Bulk edit (3.2) applies this same per-application logic to each selected application in the batch, sequentially, and surfaces a summary of successes/failures (mirroring the codebase's existing per-row reporting pattern from the import pipeline).

---

## 4. Speaker linking

### 4.1. Trigger

A new `AFTER UPDATE FOR EACH ROW` trigger on `applications`, modeled directly on the existing `applications_revoke_qr_on_ineligibility` trigger's shape (narrow guard, `SECURITY DEFINER`, idempotent):

```sql
begin
  if new.participant_type = 'speaker'
     and (old.participant_type is distinct from 'speaker')
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
```

Calls the same `resolve_application_display_name(...)` function defined by §1.3's migration (this trigger's own migration must run after that one, or define the function itself if ordered first — the implementation plan should sequence these two migrations accordingly), so the `applications.full_name` → `profiles.full_name` → literal-placeholder fallback logic exists in exactly one place, not duplicated between the trigger and the backfill migration.

Fires regardless of *why* `participant_type` became `'speaker'` — individual edit, bulk edit, or (once §1.1 ships) any future non-import path. It does **not** fire from the import pipeline directly, since `apply_import_row_transactional` performs an `INSERT`, not an `UPDATE` — a newly imported row classified `speaker` from the start needs a separate one-time check at commit time, OR (simpler, preferred) the import flow is left to rely on this same trigger by ensuring the insert path also invokes the equivalent logic. The implementation plan should resolve this exactly: either extend `apply_import_row_transactional` to call the same `people`-creation logic directly for `INSERT`s classified `speaker`, or add a companion `AFTER INSERT` trigger sharing the same underlying function. Both are equivalent in effect; the plan should pick whichever keeps the logic in exactly one place (e.g., a shared `create_speaker_people_record_if_needed(application_id)` function called from both the `AFTER INSERT` and `AFTER UPDATE` triggers).

### 4.2. Un-classifying away from `speaker`

No effect. The `people` row and any `session_people` links it has remain exactly as they are — removing a session assignment or deactivating the `people` record, if ever needed, is a manual staff action from the existing People management page, not an automatic consequence of reclassification.

### 4.3. Retroactive linking

Covered by the one-time backfill migration in §1.3.

---

## Out of scope (explicitly)

- Any redesign of the import pipeline, preview mechanics, or duplicate-detection logic — all already correct and untouched.
- Any redesign of the approval status machine or its valid transitions.
- Any change to how QR credentials, once issued, are used for scanning/attendance (sub-project 5's territory).
- Automatic QR issuance on acceptance (deliberately kept manual, per design decision in §2.2).
- Any new `qr_credentials` reason codes (the existing `administrative_correction` value is reused).
- Editing or removing `people`/`session_people` records when a participant's classification moves away from `speaker` (§4.2).
- Fine-grained staff permission scoping within the `staff` role (e.g. "only admissions staff can approve") — this distinction no longer exists in the data model since the September 2026 role consolidation, and reintroducing it is out of scope here.

## Testing

Per the user's explicit requirements, the implementation plan must include tests covering:
- Duplicate detection and validation during import continue to work unchanged (regression coverage, not new behavior).
- No invitation is sent automatically on import (regression coverage).
- `application_number` is null immediately after import and only appears after `status` transitions to `accepted`.
- `application_number` is null immediately after self-registration submission (`submitApplication`, `draft → submitted`) and only appears after `status` transitions to `accepted` — same rule as the import path, verified independently for this second intake path. The confirmation email sent by `submitApplication` no longer references any application number.
- Reclassifying an application changes `participant_type` correctly in each of the 3 edit paths (individual, bulk, import-preview).
- Reclassifying an `accepted` application with an active QR: old `application_number` is replaced, old QR credential is invalidated (`status = 'replaced'`), a new active QR credential exists, and — only when `applicant_id` is set — exactly one notification email is sent via the guarded send layer (and zero emails when `applicant_id` is null).
- Reclassifying a not-yet-accepted application: plain column update, no `application_number`/QR/email side effects.
- Speaker linking: classifying an application as `speaker` (via import, individual edit, or bulk edit) creates exactly one linked `people` row; reclassifying away from `speaker` leaves the `people` row and its `session_people` links untouched; the retroactive backfill migration links all pre-existing `speaker` applications exactly once (idempotent — running it twice creates no duplicates); the name-fallback chain (`applications.full_name` → `profiles.full_name` → `'Unknown'`) is exercised for a claimed application whose `applications.full_name` is null.
- Moving an `accepted` application away from `accepted` (e.g. to `rejected`) still triggers the existing QR-revocation behavior unchanged, while `application_number` remains on the record.
- Bulk edit (§3.2) applied to a single batch containing applications in different states (some not-yet-accepted, some accepted-without-QR, some accepted-with-active-QR): each application takes the correct branch of §3.4's logic independently — a not-yet-accepted row in the batch gets a plain column update with no side effects, while an accepted-with-QR row in the *same* batch gets a full reissue, and the batch's success/failure summary correctly attributes each outcome to its row.
- Two concurrent `accept` calls targeting the **same** application (e.g. simulating a double-click or two staff sessions) never produce two different `application_number` values or two `next_application_number()` sequence increments for that one application — exactly one number is generated and both calls observe the same final value.
