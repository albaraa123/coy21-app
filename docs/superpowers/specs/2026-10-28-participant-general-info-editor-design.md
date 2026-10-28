# Participant General Information Editor — Design

## Problem

The admin participant detail page (`src/app/[locale]/(admin)/participants/[applicationId]/page.tsx`) and its sibling consoles (Participant Care, Travel Ops, Funding, Classification) already cover most of `applications`' 49 columns with dedicated, business-logic-aware edit surfaces (Classification triggers QR reissuance + notification email; Guardian is scoped to minors; Health/Travel write to separate tables with their own RLS; Funding/attendance-confirmation has its own bulk-search console). A `super_admin` has no way to correct the remaining ~31 general-profile columns at all today — not even a basic typo fix to `full_name` or `country` — regardless of whether the row was self-registered or came from the CSV import pipeline (which has its own documented, unrelated data-quality gaps, e.g. the `VOL-YNG-*` block's corrupted DoB/Country/Phone columns).

## Scope

In scope — a new "General Information" section on the existing `/participants/[applicationId]` page, editable only by `super_admin`, covering exactly these columns:

**Plain text fields:**
`full_name`, `phone`, `whatsapp_number`, `country`, `nationality`, `city`, `gender`, `birth_date`, `age_group`, `education_level`, `institution_or_workplace`, `field_of_work`, `organization`, `preferred_language`, `linkedin_url`, `primary_track`, `secondary_track`, `topics_to_learn`, `content_type_pref`, `experience_level`, `climate_experience`, `past_initiatives`, `participation_goals`, `priority_sessions`, `special_needs`

**Array fields (`text[]`), edited as a single comma-separated text input, split/joined at the form boundary:**
`interests`, `track_interests`, `session_languages`, `track_1_focus_areas`, `track_2_focus_areas`, `track_3_focus_areas`

Explicitly out of scope (already have dedicated, business-logic-aware edit surfaces — this feature does not touch, duplicate, or bypass any of them):
- `participant_type` — Classification (`classification-controls.tsx` + `reclassifyApplication`), which triggers QR reissuance and a notification email; editing this via a generic form would skip that logic entirely.
- `guardian_name`, `guardian_phone` — the Guardian section (just shipped), scoped to `isApplicationMinor()` and its own audit action.
- `funding_type`, `attendance_confirmation` — the Funding console.
- `status`, `assigned_reviewer_id` — the application review page (`/applications/[id]`), which has its own status-transition side effects (notifications, application-number issuance).
- `application_health_info`/`application_travel_info` (separate tables, not `applications` columns at all) — Participant Care and Travel Ops consoles.
- System/pipeline columns never meant for manual editing: `id`, `created_at`, `updated_at`, `submitted_at`, `applicant_id`, `application_number`, `import_batch_id`, `imported_email`, `last_import_row_fingerprint`, `external_delegate_code`, `registration_category`.

(31 in-scope + 18 out-of-scope = 49, accounting for every column on the live `applications` table — confirmed against `src/types/database.ts`'s generated Row type before writing this spec, not assumed.)

Also out of scope: any bulk/multi-row editing (this is a single-application form, matching every existing console's per-application edit shape), any new RLS policy (service-role write path, same as every other edit surface in this codebase), any change to the CSV import pipeline's own data-quality handling.

## Who Can Edit

`super_admin` only, via `requireAgendaStaffCaller()` (`src/lib/agenda/server-helpers.ts`) — confirmed, not assumed: despite its name, this helper is already `super_admin`-only in practice (`isStaffRole(profile.role) && profile.role !== 'staff'`, per the 2026-10-25 staff-narrowing change), and it's the exact helper `[applicationId]/actions.ts` (the file this feature's new action lives in) already uses for `updateParticipantTypeAction`. This is not a new authorization decision — it reuses the file's own established gate, and matches the page's existing `canSeeSensitive = profile.role === 'super_admin'` flag (`page.tsx:47`), which already restricts sensitive `application_answers` visibility to the same role. The new General Information section's visibility (not just its editability) is also gated on `canSeeSensitive` — a non-`super_admin` staff member who can reach this page at all (the page itself is reachable by any `isStaffRole` caller, confirmed at `page.tsx:33`) does not see the new section at all, not just a disabled one.

## Data Model

No new table, no new columns — every field in scope already exists on `applications`. The new server action writes directly to the existing row.

## Server Action

New file or addition to existing `[applicationId]/actions.ts` (implementer's call, matching the plan's pattern for similar decisions) — following the exact `updateParticipantTypeActionForCaller`/`updateParticipantTypeAction` split already in that file:

```typescript
export async function updateGeneralInfoForCaller(
  applicationId: string,
  input: GeneralInfoUpdateInput,
  caller: { userId: string; service: ServiceClient }
): Promise<GeneralInfo> {
  const { service, userId } = caller;
  const { data: before } = await service.from('applications').select(<scope columns>).eq('id', applicationId).maybeSingle();

  const { data, error } = await service.from('applications').update(input).eq('id', applicationId).select(<scope columns>).single();
  if (error) throw new Error(error.message);

  await writeAuditLog(service, {
    entityType: 'applications',
    entityId: applicationId,
    action: 'general_info_updated',
    actorId: userId,
    oldValues: before,
    newValues: data,
  });

  return data;
}

export async function updateGeneralInfoAction(applicationId: string, input: GeneralInfoUpdateInput) {
  const caller = await requireAgendaStaffCaller();
  return updateGeneralInfoForCaller(applicationId, input, caller);
}
```

This mirrors `updateGuardianInfoForCaller`'s exact shape (plain `update`, not `upsert` — `applications` always has exactly one row per application already, same reasoning as the guardian feature) and `updateHealthInfoForCaller`'s audit-log call pattern. `writeAuditLog`'s `action` field is a free string (confirmed: `src/lib/agenda/server-helpers.ts`'s `writeAuditLog` takes `action: string`, not an enum), so `'general_info_updated'` needs no new type/migration.

`GeneralInfoUpdateInput`/`GeneralInfo` types list exactly the in-scope columns (both plain-text and array fields, typed `string | null` and `string[] | null` respectively) — never includes any out-of-scope column, so a caller cannot accidentally (or a future refactor cannot silently) widen this action's write surface to touch `participant_type`/`status`/etc.

## UI

New section "General Information" rendered on `/participants/[applicationId]/page.tsx`, gated on `canSeeSensitive` (not rendered at all for non-`super_admin` staff), positioned near the existing Classification/Guardian sections.

New client component, mirroring the existing Health Info/Travel Info consoles' single-form-single-save-button shape (not `GuardianControls`'/`ClassificationControls`' narrower per-field-action shape, since this form has ~31 fields, not 1-2): local form state initialized from the page's server-fetched current values, one "Save" button that submits every field's current value in one `updateGeneralInfoAction` call (not per-field saves — matches the user's explicit choice), busy/error state identical to every other console's pattern.

**Array fields**: rendered as a single text input per field, comma-separated (e.g. `interests` shows/accepts `"climate policy, youth engagement, renewable energy"`). On load, `array.join(', ')`; on save, `input.split(',').map(s => s.trim()).filter(s => s !== '')` — an empty input produces an empty array (not `[null]` or a single empty-string element). This is a simple, explicit choice (not the more elaborate one-input-per-array-element UI) per the user's explicit decision, prioritizing implementation simplicity over input ergonomics for what's expected to be an infrequent correction tool, not a primary data-entry surface.

**Residual risk of the comma-split design, confirmed and scoped per-column, not just assumed safe:** these 6 array columns have exactly two write paths in the codebase today, confirmed by grep — not one, and this spec does not overclaim otherwise:
1. The CSV import pipeline's `MULTISELECT_KEYS` mechanism (`src/lib/import/row-validation.ts`), which splits incoming values on `/[,;\n]+/` (commas, semicolons, or newlines) via `splitMultiSelect()` *before* writing to the DB — the only write path for `session_languages`, `track_1_focus_areas`, `track_2_focus_areas`, `track_3_focus_areas`.
2. The self-registration autosave flow (`src/app/[locale]/(participant)/(bare)/register/registration-form.tsx`), which also writes `interests`/`track_interests` directly as real arrays (validated by `conferenceInfoSchema` in `src/lib/validation/registration.ts`) built from a fixed, comma-free checkbox option list (`INTEREST_OPTIONS`/`TRACK_OPTIONS`), never passing through `splitMultiSelect()` at all.

Both paths independently guarantee no stored element can already contain a literal comma today: path 1 because every element was itself produced by splitting on comma; path 2 because its only possible values come from a fixed, comma-free option list. This makes the new editor's naive comma-split UI safe for *all existing data* across all 6 columns, confirmed by tracing every write path into each column, not merely assumed. It is NOT safe in general: if any future write path (a new self-registration form field, a manual entry) ever stores a single semantic item containing a human-typed comma (e.g. a track focus area literally named "Policy, Governance, and Leadership" as one string), this editor's save action will silently fragment it into multiple array elements with no error or warning. This is an accepted, explicitly-named tradeoff for implementation simplicity on an infrequent correction tool — not a defect to fix now, but the implementer must not "fix" it by inventing a different delimiter or escaping scheme, since that would be unrequested scope creep; if this risk ever materializes, it's a future design question, not something this spec should pre-solve.

(Note: `MULTISELECT_KEYS` in `row-validation.ts` also includes `topics_to_learn`, which is a plain-text column in this spec's scope, not one of the 6 array columns — `MULTISELECT_KEYS` is not a 1:1 mirror of "this spec's array fields," don't treat it as one.)

The page must widen its existing `applications` select (currently spanning several lines in `page.tsx`'s `.select(...)` call, starting around line 49 — read the exact current lines before editing, don't assume a fixed line range) to include every in-scope column alongside what it already selects. Of the 31 in-scope columns, 19 are already selected today for existing display purposes (including `country`, `nationality`, `organization`, `field_of_work`); the following 12 are not yet selected and must be added: `full_name, whatsapp_number, gender, education_level, institution_or_workplace, linkedin_url, primary_track, secondary_track, session_languages, track_1_focus_areas, track_2_focus_areas, track_3_focus_areas`.

## Testing

- Live test for `updateGeneralInfoForCaller`: writes a representative subset of plain-text and array fields to a fixture application, asserts the written values round-trip correctly (including the array-field join/split boundary — e.g. a 3-element array survives a full save/reload cycle), and asserts a `writeAuditLog` row is created with `action: 'general_info_updated'` and the expected `oldValues`/`newValues`.
- Live/logic test confirming `updateGeneralInfoAction`'s auth gate: same logic-replication approach as the guardian-info feature's Task 6 (`requireAgendaStaffCaller` cannot be invoked directly in a test outside a request context), re-implementing the exact condition and asserting `staff` is rejected, `super_admin` is accepted.
- Unit test for the array-field split/join helper in isolation (empty string → empty array; trailing/leading whitespace trimmed; a single trailing comma doesn't produce a stray empty-string element).
- Manual verification (deferred to a combined pass, matching this session's established pattern): non-`super_admin` staff cannot see the General Information section at all; `super_admin` can edit and save a full round of changes across both plain-text and array fields and see them persist on reload; saving does not affect any other section's data (Classification/Guardian/etc. unchanged by a General Info save).
