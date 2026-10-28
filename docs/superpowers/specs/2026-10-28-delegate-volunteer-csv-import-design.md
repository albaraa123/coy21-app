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

**Classification derivation**: inside the per-row validation logic (`runValidationForCaller` in `preview/actions.ts`, where `participant_type` is already set per Task 23's prior wiring — confirmed by migration `20260823010000_wire_participant_type_to_apply_import_row.sql`), when `external_delegate_code` is present and non-empty:
1. Match its prefix against the 9-entry lookup table above (exact prefix match, case-sensitive, matching the file's own consistent casing).
2. On match: set `participant_type` and `registration_category` from the lookup, overriding/filling whatever the user's column mapping produced for `participant_type` (if they separately mapped a `participant_type`-aliased column — unlikely for this file, since it has no such column, but this precedence rule avoids ambiguity if it ever does).
3. On no match: add a validation error to the row (`"Unrecognized delegate code prefix: <code>"`), classify the row `invalid` — same mechanism `validateRow` already uses for every other field-level validation failure.

This keeps `external_delegate_code` → classification as a single, auditable, two-step translation (prefix lookup, then write to two columns) rather than open-ended per-row logic scattered across the pipeline.

## Source File Preparation (one-time, before this specific upload)

Not a code change — a one-time cleaning pass on the actual `.xlsx` file before it's uploaded through the existing UI:
1. Delete the 8 rows whose only populated cell is a category name in the `Country of residence` column position (`"Onground Volunteers"`, `"COY21 Organizing Team Volunteers"`, `"UN Women Delegates"`, `"IOM Youth Delegates"`, `"PYCC Delegates"`, `"Policy Team On-ground Delegates"`, `"LCOY Delegates"`, `"RCOY Delegates"`) — these are section separators, not participant data, and would otherwise surface as 8 spurious `invalid` rows in the preview.
2. No other row deletions. The known data-quality issues (49 `VOL-YNG` rows with garbage DoB/Country/Phone, 36 duplicate-email groups, a handful of inconsistent DoB text formats across sections) are handled by the import pipeline's own existing mechanisms (unmapped columns, `duplicate_in_file` detection, free-text field tolerance) rather than pre-cleaned — per this session's explicit decisions.

## Testing

- Unit test for the prefix-lookup function: one assertion per known prefix (9 cases), one case for an unrecognized prefix (expect no match / validation error), one case for a prefix that's a substring of another known prefix if any such collision exists in the 9 (confirmed none do — `DEL-INT-`, `DEL-UNW-`, `DEL-IOM-`, `DEL-PYCC-`, `DEL-YNG-`, `DEL-LCOY-`, `DEL-RCOY-`, `VOL-TUR-`, `VOL-YNG-` are all mutually non-prefixing).
- Live test extending the existing import validation test suite (`tests/import/validation-live.test.ts` or sibling): a small in-memory workbook with a handful of rows covering a known-prefix row (expect correct `participant_type`/`registration_category`), an unrecognized-prefix row (expect `invalid` with the specific error message), and a row with no `external_delegate_code` at all (expect no classification side-effect — this column is optional for every import that isn't this one).
- Manual verification (this specific import run, not a repeatable automated test): after cleaning the source file and running it through upload → map → preview → confirm, verify the final `applications` count increase matches 517 minus whatever rows get explicitly rejected in preview (duplicates, any other validation failures), and spot-check a handful of rows across different prefixes for correct `external_delegate_code`/`participant_type`/`registration_category` values.
