# Delegate/Volunteer CSV Import — Design

## Problem

The organizing team has a finished Excel file (`COY21 Final Delegates and Volunteers List.xlsx`, sheet "All Delegates") with 517 real participant rows across 9 registration categories (Delegates, Onground Volunteers, COY21 Organizing Team Volunteers, UN Women Delegates, IOM Youth Delegates, PYCC Delegates, Policy Team On-ground Delegates, LCOY Delegates, RCOY Delegates), each with a pre-assigned delegate code (e.g. `DEL-INT-001`, `VOL-TUR-001`). These codes are already distributed to participants and must be preserved exactly — not regenerated, not renumbered.

The existing import pipeline (`src/app/[locale]/(admin)/participants/import/...`) writes to `applications` and auto-generates its own `application_number` (`COY21-DEL-0001` format, via `next_application_number()`) at acceptance time. It has no mechanism today to accept and preserve an externally pre-assigned code, and no concept of "registration category" or code-prefix-driven classification.

## Scope

In scope:
- A new nullable `applications.external_delegate_code` column (unique), storing the original code verbatim (e.g. `DEL-INT-001`).
- A new nullable `applications.registration_category` column (display-only text), storing which of the 9 named categories the row belongs to (e.g. `"Onground Volunteers"`).
- A fixed, code-prefix-to-classification lookup table (not a column read from the file) mapping each of the 9 known prefixes to `participant_type` (`delegate` or `volunteer`) and the display category string.
- Wiring this lookup into the existing import validation pipeline, so each row's `external_delegate_code` prefix determines its `participant_type` and `registration_category` automatically.
- A pre-upload cleaning pass on the source `.xlsx` file: removing the 8 section-header rows interleaved as data rows, and leaving `Country of residence`/`Phone / WhatsApp`/`DoB` unmapped for the "COY21 Organizing Team Volunteers" (`VOL-YNG-*`) block specifically, since that block's data in those three columns is corrupted (wrong values entirely — `"Yes"/"No"` in the DoB column, blank Country, `#ERROR!`/raw-digit Phone).
- Using the existing import UI (upload → map → preview → confirm) as-is for the actual import run — no new import mechanism, no bypass of its existing validation/duplicate-detection/rollback machinery.

Out of scope (explicitly deferred):
- Setting `profiles.role = 'staff'` for `VOL-TUR-*`/`VOL-YNG-*` rows. The import pipeline never touches `profiles` — a `profiles` row only exists once a person self-registers and claims their imported application via email match (`applications.imported_email`). Role assignment at claim-time, driven by `registration_category`, is a separate future feature, not built here.
- `knowledge_partner`/`speaker` accounts (not present in this file; to be added manually later, per prior confirmation this session).
- Any change to `next_application_number()` or the `COY21-DEL-NNNN` auto-generated code scheme — it continues to run exactly as today, untouched, for every imported row (including these 517).
- Pre-resolving the 36 duplicate-email groups found in the source file before upload — the import pipeline's existing `duplicate_in_file` detection and manual per-row approval in the preview step is used as-is.
- T-shirt size, Age, Passport number, Arrival Date — left unmapped (`ignored`) in this import; no schema change for them now.

## Data Model

```sql
alter table applications
  add column external_delegate_code text,
  add column registration_category text;

alter table applications
  add constraint applications_external_delegate_code_unique unique (external_delegate_code);
```

Both nullable: the vast majority of existing/future applications (self-registered, or imported from other sources) will never have these set. `external_delegate_code`'s uniqueness constraint only applies to non-null values (standard Postgres unique-index behavior), so it never conflicts with existing rows that have `null`.

No RLS policy change needed: these are two more plain columns on `applications`, covered by the same staff/service-role write path every other import column already uses.

## Apply-Time Wiring — `apply_import_row_transactional` Must Be Extended

**This is not optional and was missed in an earlier draft of this spec — confirmed against the live production database (`vfwcbkjvinbtcntwjrzq`) before being added here, not assumed.** Adding a new `core_field` to `field-dictionary.ts` and having `validateRow()`/the pass-2 loop populate it on `normalizedRow` is NOT sufficient on its own to get the value into the `applications` table. The actual write happens later, at confirm/apply time, inside the SQL function `apply_import_row_transactional` (its current, live definition — confirmed as the latest of 8 historical `create or replace` migrations, and confirmed live via the function's own description string returned by the PostgREST OpenAPI spec — lives in `supabase/migrations/20260823010000_wire_participant_type_to_apply_import_row.sql`). That function reads `v_normalized jsonb` (the stored `normalized_row` JSON) and copies a **fixed, explicit list of column names** — `v_text_columns text[]` (declared ~line 47, currently 25 entries: `phone, country, nationality, age_group, city, organization, field_of_work, preferred_language, experience_level, climate_experience, past_initiatives, participation_goals, topics_to_learn, content_type_pref, priority_sessions, special_needs, gender, whatsapp_number, education_level, institution_or_workplace, linkedin_url, primary_track, secondary_track, funding_type, attendance_confirmation`) — into a dynamically built `update applications set ...` statement (the `foreach v_key in array v_text_columns loop` block, ~lines 206-220). A column NOT in this array is silently never written to `applications`, no matter what's in `normalized_row` — this is exactly what would happen to `external_delegate_code`/`registration_category` without this fix, and the gap would not surface as an error anywhere; the import would appear to succeed while silently discarding both new fields for all 517 rows.

**Required change:** a new migration, `create or replace function apply_import_row_transactional(...)`, carrying forward the full current function body verbatim (same pattern `20260823010000` itself used relative to its predecessor — see that file's own header comment listing its diffs from the prior version) with exactly one change: add `'external_delegate_code'` and `'registration_category'` to the `v_text_columns` array. Both are plain text fields with no special transform (no array-splitting, no date/phone parsing) — the existing generic `v_text_columns` handling (plain string passthrough via `v_value #>> '{}'`) is the correct, sufficient mechanism; neither needs its own dedicated branch like `full_name`/`birth_date` have.

No other part of the function needs to change — `v_participant_type` extraction/handling (already wired by `20260823010000`) is untouched, since `participant_type` is set via the new prefix-lookup logic the same way it's set by any other column mapping today (see "Import Pipeline Wiring" below); this spec does not alter how `participant_type` itself flows into `next_application_number()` or the INSERT branch.

## Prefix → Classification Lookup

A fixed table (TypeScript constant, not a database table — matches this codebase's existing `field-dictionary.ts` convention of fixed-in-code lookups for import-time logic):

| Prefix | `participant_type` | `registration_category` |
|---|---|---|
| `DEL-INT-` | `delegate` | `Delegates` |
| `VOL-TUR-` | `volunteer` | `Onground Volunteers` |
| `VOL-YNG-` | `volunteer` | `COY21 Organizing Team Volunteers` |
| `DEL-UNW-` | `delegate` | `UN Women Delegates` |
| `DEL-IOM-` | `delegate` | `IOM Youth Delegates` |
| `DEL-PYCC-` | `delegate` | `PYCC Delegates` |
| `DEL-YNG-` | `delegate` | `Policy Team On-ground Delegates` |
| `DEL-LCOY-` | `delegate` | `LCOY Delegates` |
| `DEL-RCOY-` | `delegate` | `RCOY Delegates` |

A code whose prefix doesn't match any of these 9 exactly produces a validation error on that row (surfaced in the preview step as `invalid`, same as any other validation failure today) — never a guessed classification, never a silently skipped field.

## Import Pipeline Wiring

**New recognized field** in `src/lib/import/field-dictionary.ts`:
```typescript
{ key: 'external_delegate_code', kind: 'core_field', isCriticalIdentity: true, aliases: ['delegate code', 'كود المندوب'] },
```
Marked `isCriticalIdentity: true` (same category as `email`) since it's this file's primary identifier and must never be auto-mapped below the dictionary's confidence floor — the human must confirm the mapping explicitly on the map step, same as email already requires.

**Classification derivation — exact location (confirmed against the real current code, not assumed):** `runValidationForCaller` (`src/app/[locale]/(admin)/participants/import/[batchId]/preview/actions.ts`) does NOT itself contain per-field logic — it calls `validateRow()` (`src/lib/import/row-validation.ts`) per row, which builds `normalizedRow` via a fully generic column-mapping pass-through (`normalizedRow[col.targetKey] = value`, `row-validation.ts:194`). `participant_type` is consumed later, at apply/confirm time, inside the SQL function `apply_import_row_transactional` (added by `supabase/migrations/20260823010000_wire_participant_type_to_apply_import_row.sql`), which reads it back out of the stored `normalized_row` JSON.

The new prefix-lookup logic must be added as an explicit new block inside `validateRow()` in `src/lib/import/row-validation.ts` — not inside `runValidationForCaller`, which has no field-specific logic to extend. Concretely, after `normalizedRow` is built for a row, when `normalizedRow.external_delegate_code` is present and non-empty:
1. Match its prefix against the 9-entry lookup table above (exact prefix match, case-sensitive, matching the file's own consistent casing).
2. On match: set `normalizedRow.participant_type` and `normalizedRow.registration_category` from the lookup, overriding/filling whatever the user's column mapping produced for `participant_type` (if they separately mapped a `participant_type`-aliased column — unlikely for this file, since it has no such column, but this precedence rule avoids ambiguity if it ever does).
3. On no match: add a validation error to the row's existing `errors` array (`"Unrecognized delegate code prefix: <code>"`), classify the row `invalid` — same mechanism `validateRow` already uses for every other field-level validation failure.

This keeps `external_delegate_code` → classification as a single, auditable, two-step translation (prefix lookup, then write to two fields on `normalizedRow`) inside the one function already responsible for all other per-row field derivation — not open-ended logic scattered across the pipeline, and not misplaced in a function (`runValidationForCaller`) that has no other per-field logic to pattern-match against.

## Source File Preparation (one-time, before this specific upload)

Not a code change — a one-time cleaning pass on the actual `.xlsx` file before it's uploaded through the existing UI:
1. Delete the 8 rows whose only populated cell is a category name in the `Country of residence` column position (`"Onground Volunteers"`, `"COY21 Organizing Team Volunteers"`, `"UN Women Delegates"`, `"IOM Youth Delegates"`, `"PYCC Delegates"`, `"Policy Team On-ground Delegates"`, `"LCOY Delegates"`, `"RCOY Delegates"`) — these are section separators, not participant data, and would otherwise surface as 8 spurious `invalid` rows in the preview.
2. No other row deletions. The known data-quality issues (49 `VOL-YNG` rows with garbage DoB/Country/Phone, 36 duplicate-email groups, a handful of inconsistent DoB text formats across sections) are handled by the import pipeline's own existing mechanisms (unmapped columns, `duplicate_in_file` detection, free-text field tolerance) rather than pre-cleaned — per this session's explicit decisions.

## Cross-Batch `external_delegate_code` Collision Check

Duplicate detection in `row-validation.ts`/`preview/actions.ts` today is keyed entirely on **email** (`fetchExistingApplicationsByEmail`, matched against `applications.imported_email`), never on `external_delegate_code`. This spec's new `applications_external_delegate_code_unique` constraint protects data integrity at the database level, but on its own it would surface as an ungraceful raw Postgres unique-violation at apply/confirm time (not a clean, per-row `invalid` message in preview) for the realistic scenario of re-uploading a corrected version of the file where a row's email changed but its delegate code didn't (e.g. a typo fix between an initial partial upload and a corrected re-upload).

**Exact location (confirmed against the real current code — this is NOT inside `validateRow()`):** `validateRow()` is a pure, single-row, in-memory function (`src/lib/import/row-validation.ts`) with no parameter slot for a batch-level lookup Map, and no other part of this pipeline adds one for that reason. The real precedent for "a batch-wide lookup, consulted per row, that can affect a row's outcome" is how email-duplicate detection already works: `runValidationForCaller` (`preview/actions.ts`) runs `validateRow()` for every row in pass 1 (no DB I/O, lines ~176-178, producing `perRowResults`), then fetches `existingByEmail` once for the whole batch (`fetchExistingApplicationsByEmail`, ~line 183), then in a **separate pass-2 loop** (~lines 205-258) calls `classifyDuplicateStatus(email, {...})` per row using that pre-fetched Map — entirely after and outside `validateRow()`.

The delegate-code collision check must follow this exact same pattern, not the prefix-lookup pattern (which is legitimately static/in-memory and correctly lives inside `validateRow()` — see "Import Pipeline Wiring" above):
1. Add `fetchExistingApplicationsByExternalDelegateCode` to `preview/actions.ts`, mirroring `fetchExistingApplicationsByEmail`'s exact shape (same `chunkedIn`/`LOOKUP_CHUNK` batching, same `Map` return shape keyed by code instead of email, querying `applications.external_delegate_code` instead of `imported_email`). Call it once in `runValidationForCaller`, immediately alongside the existing `fetchExistingApplicationsByEmail` call (~line 183).
2. Inside the pass-2 loop (~lines 205-240), where `const result = perRowResults[i]` is already in scope: if `result.normalizedRow.external_delegate_code` is non-empty and matches a key in the newly-fetched Map, **mutate `result` in place** — push `"Delegate code <code> is already assigned to an existing application"` onto `result.errors` and set `result.status = 'invalid'` — *before* the loop's existing `if (result.status === 'valid') validCount++; else if (...) warningCount++; else errorCount++;` counting block and the `rowsToInsert.push(...)` call (~lines 242-257), both of which read `result.status`/`result.errors` directly off the same object. This is mechanically different from the prefix-lookup case (which writes into `normalizedRow`/`errors` from inside `validateRow()` itself, before that function returns) — here, the write happens from the caller, onto the already-returned `result` object, after `validateRow()` has already run — but it achieves the identical visible outcome: the row ends up `invalid` with a clear error message in the preview UI, through `rowsToInsert.errors`/`validation_status`, exactly like every other validation failure.

## Testing

- Unit test for the prefix-lookup function: one assertion per known prefix (9 cases), one case for an unrecognized prefix (expect no match / validation error), one case for a prefix that's a substring of another known prefix if any such collision exists in the 9 (confirmed none do — `DEL-INT-`, `DEL-UNW-`, `DEL-IOM-`, `DEL-PYCC-`, `DEL-YNG-`, `DEL-LCOY-`, `DEL-RCOY-`, `VOL-TUR-`, `VOL-YNG-` are all mutually non-prefixing).
- Live test extending the existing import validation test suite (`tests/import/validation-live.test.ts` or sibling): a small in-memory workbook with a handful of rows covering a known-prefix row (expect correct `participant_type`/`registration_category`), an unrecognized-prefix row (expect `invalid` with the specific error message), a row with no `external_delegate_code` at all (expect no classification side-effect — this column is optional for every import that isn't this one), and a row whose `external_delegate_code` matches a pre-seeded existing `applications` row (expect `invalid` with the "already assigned" error message, proving the cross-batch collision check actually fires).
- Live test for the `apply_import_row_transactional` extension: after a confirm/apply run on a fixture row with `external_delegate_code`/`registration_category` set in `normalized_row`, assert the resulting `applications` row genuinely has both columns populated with the expected values — this is the only test that actually proves the "Apply-Time Wiring" fix works end-to-end (the other tests above only prove `normalizedRow`/preview-time behavior, which is necessary but not sufficient on its own, per the gap this spec section closes).
- Manual verification (this specific import run, not a repeatable automated test): after cleaning the source file and running it through upload → map → preview → confirm, verify the final `applications` count increase matches 517 minus whatever rows get explicitly rejected in preview (duplicates, any other validation failures), and spot-check a handful of rows across different prefixes for correct `external_delegate_code`/`participant_type`/`registration_category` values **by querying `applications` directly** (not just trusting the preview UI, since preview only reflects `normalized_row`, not the actual post-apply table state).
