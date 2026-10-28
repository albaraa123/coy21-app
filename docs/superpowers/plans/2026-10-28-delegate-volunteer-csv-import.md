# Delegate/Volunteer CSV Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing import pipeline to accept pre-assigned delegate codes (e.g. `DEL-INT-001`) from a real 517-row Excel file, classify each row's `participant_type`/`registration_category` from the code's prefix, and actually persist both new fields to `applications` — without touching the existing auto-generated `application_number` scheme.

**Architecture:** Two new nullable `applications` columns (`external_delegate_code`, `registration_category`). A static 9-entry prefix lookup, consulted in two places: inside `validateRow()` (static, in-memory — sets `participant_type`/`registration_category` on `normalizedRow`) and in `runValidationForCaller`'s pass-2 loop (batch-level collision check, mirroring the existing email-duplicate pattern). A new migration extends `apply_import_row_transactional`'s `v_text_columns` array so the two new fields actually reach `applications` at confirm time — this was the single most important gap this plan's spec review process caught; see Task 3.

**Tech Stack:** Next.js 16 App Router, Supabase Postgres (PL/pgSQL), TypeScript, Vitest (live DB tests).

---

## Context for every task

- Working directory: `C:\Users\albar\OneDrive\سطح المكتب\COY21\COY21-App\.worktrees\delegate-volunteer-import`, branch `feature/delegate-volunteer-import`. Fully rebased onto current `master` as of this plan's writing (0 commits behind). `.env.local` already present.
- Design spec: `docs/superpowers/specs/2026-10-28-delegate-volunteer-csv-import-design.md` — read it in full before Task 1. It went through 4 review rounds against the live codebase and production database; its code/line-number citations are verified, not assumed. This plan implements it exactly; where this plan is more specific (literal code), the plan's code wins.
- Supabase project: `vfwcbkjvinbtcntwjrzq` (COY21 production, no separate dev/staging). Every migration task in this plan follows the same split this session has used consistently: the implementer writes the migration + its test, then STOPS — the controller (not a subagent) applies it live via `supabase db push` after showing the SQL to the human for explicit confirmation, then regenerates `src/types/database.ts`, then the implementer's test is run and the task is committed. This is spelled out per-task below; follow it exactly, do not self-push.
- Known pre-existing `tsc --noEmit` baseline: ~419 errors, confined to `tests/attendance/qr-issuance-reservation.test.ts` and `tests/attendance/qr-credentials-lifecycle-trigger.test.ts`. Any task's typecheck must show zero *new* errors outside those two files.
- This plan does NOT include the actual 517-row import run itself (file cleaning + upload + map + preview + confirm) — that's a manual, one-time operation the controller performs with the human after all code tasks below are merged, described in Task 7.

---

### Task 1a: Database migration — `external_delegate_code` / `registration_category` columns (write only, do not apply)

**Files:**
- Create: `supabase/migrations/20261028110000_add_delegate_code_and_registration_category.sql`
- Test: `tests/import/delegate-code-schema-live.test.ts`

**Confirmed live** (2026-10-28, against `vfwcbkjvinbtcntwjrzq`): `applications` does not have `external_delegate_code` or `registration_category` today. `applications`' existing unique constraints are `applications_one_per_applicant` (on `applicant_id`) and `applications_imported_email_unclaimed_unique` — neither conflicts with a new `applications_external_delegate_code_unique`.

**⚠️ THIS TASK'S JOB IS STEPS 1–2 ONLY. Do not run the test, do not attempt `supabase db push`, do not regenerate `src/types/database.ts`, do not commit.** When you finish Step 2, report **DONE_WITH_CONCERNS** with the concern "migration + test written, live apply and commit are Task 1b's job, not mine."

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20261028110000_add_delegate_code_and_registration_category.sql
--
-- Adds the two columns needed to import participants from a source file
-- with pre-assigned delegate codes (e.g. DEL-INT-001) without disturbing
-- the existing auto-generated application_number scheme
-- (next_application_number(), COY21-DEL-NNNN format). Both nullable:
-- the vast majority of applications (self-registered, or imported from
-- a source with no such code) will never have these set.
--
-- external_delegate_code is unique (Postgres unique constraints permit
-- unlimited NULLs, so this never conflicts with existing/future rows
-- that have none). registration_category is a plain display-only text
-- field (e.g. "Onground Volunteers") with no constraint -- it's derived
-- from external_delegate_code's prefix by application code, not
-- independently validated at the DB level.
alter table applications
  add column if not exists external_delegate_code text,
  add column if not exists registration_category text;

alter table applications
  add constraint applications_external_delegate_code_unique unique (external_delegate_code);
```

- [ ] **Step 2: Write a live test proving the columns exist and are writable/nullable/unique**

```typescript
// tests/import/delegate-code-schema-live.test.ts
//
// Minimal live-schema proof for the external_delegate_code/
// registration_category columns added in
// 20261028110000_add_delegate_code_and_registration_category.sql --
// mirrors the shape of other *-schema-live.test.ts files in this
// codebase (e.g. tests/cafeteria/schema-live.test.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000 });

const runId = randomUUID().slice(0, 8);
let applicantUserId: string;
let applicantUserId2: string;
let applicationId: string;
let applicationId2: string | undefined;

beforeAll(async () => {
  const { data: user, error } = await admin.auth.admin.createUser({
    email: `delcode-schema-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (error || !user.user) throw new Error(`fixture user setup failed: ${error?.message}`);
  applicantUserId = user.user.id;

  const { data: user2, error: error2 } = await admin.auth.admin.createUser({
    email: `delcode-schema-${runId}-b@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (error2 || !user2.user) throw new Error(`fixture user 2 setup failed: ${error2?.message}`);
  applicantUserId2 = user2.user.id;
});

afterAll(async () => {
  if (applicationId2) await admin.from('applications').delete().eq('id', applicationId2);
  if (applicationId) await admin.from('applications').delete().eq('id', applicationId);
  for (const id of [applicantUserId, applicantUserId2].filter(Boolean)) {
    await admin.auth.admin.deleteUser(id);
  }
});

describe('applications.external_delegate_code / registration_category', () => {
  it('accepts null on insert (both columns nullable)', async () => {
    const { data, error } = await admin
      .from('applications')
      .insert({ applicant_id: applicantUserId, status: 'draft' })
      .select('id, external_delegate_code, registration_category')
      .single();
    expect(error).toBeNull();
    applicationId = data!.id;
    expect(data!.external_delegate_code).toBeNull();
    expect(data!.registration_category).toBeNull();
  });

  it('stores and reads back real values', async () => {
    const code = `DEL-TEST-${runId}`;
    const { data, error } = await admin
      .from('applications')
      .update({ external_delegate_code: code, registration_category: 'Delegates' })
      .eq('id', applicationId)
      .select('external_delegate_code, registration_category')
      .single();
    expect(error).toBeNull();
    expect(data!.external_delegate_code).toBe(code);
    expect(data!.registration_category).toBe('Delegates');
  });

  it('rejects a duplicate external_delegate_code', async () => {
    const dupeCode = `DEL-DUPE-${runId}`;
    await admin.from('applications').update({ external_delegate_code: dupeCode }).eq('id', applicationId);

    const { data: app2, error: insertError } = await admin
      .from('applications')
      .insert({ applicant_id: applicantUserId2, status: 'draft', external_delegate_code: dupeCode })
      .select('id')
      .maybeSingle();
    if (app2) applicationId2 = app2.id; // only set if it unexpectedly succeeded, so afterAll can still clean it up
    expect(insertError).not.toBeNull();
    expect(insertError!.message).toMatch(/unique|duplicate/i);
  });
});
```

- [ ] **Step 3: Report the migration + test to the controller; stop here.**

This ends Task 1a. Report DONE_WITH_CONCERNS now — do not continue to the steps below.

---

### Task 1b: Apply migration live, verify, commit (controller only — NOT a subagent task)

Executed by the controller directly in the main session, never dispatched to an implementer subagent. Depends on Task 1a being done.

- [ ] **Step 1: Show the migration SQL to the human and get explicit confirmation to apply it.**
- [ ] **Step 2: Apply it live**

```bash
SUPABASE_ACCESS_TOKEN="<fresh token>" npx supabase db push --yes
```

A fresh personal access token will likely be needed. Ask the human for one via Dashboard → Account Settings → Access Tokens, Project-scoped to COY21, when this reports "Invalid access token".

- [ ] **Step 3: Regenerate types**

```bash
SUPABASE_ACCESS_TOKEN="<fresh token>" npx supabase gen types typescript --project-id vfwcbkjvinbtcntwjrzq > src/types/database.ts
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run tests/import/delegate-code-schema-live.test.ts
```
Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261028110000_add_delegate_code_and_registration_category.sql tests/import/delegate-code-schema-live.test.ts src/types/database.ts
git commit -m "feat: add external_delegate_code/registration_category columns to applications"
```

Only after this commit lands may Tasks 2 and 3 (which depend on the regenerated types and live columns) begin.

---

### Task 2: Prefix lookup table + `field-dictionary.ts` entry + `validateRow()` wiring

**Files:**
- Create: `src/lib/import/delegate-code-classification.ts`
- Create: `src/lib/import/delegate-code-classification.test.ts`
- Modify: `src/lib/import/field-dictionary.ts` (add one new `KnownField` entry)
- Modify: `src/lib/import/row-validation.ts` (`validateRow()` — add the prefix-lookup block)
- Modify: `tests/import/validation-live.test.ts` or add a new sibling test file for `validateRow()`-level coverage (implementer's call which is cleaner; check how the existing file is organized first)

**Depends on Task 1b** (needs `external_delegate_code`/`registration_category` to exist as real columns for the live tests in Task 3+ to make sense, though this task's own unit tests are pure/in-memory and don't strictly need it — still wait for 1b to land first to keep task ordering simple and avoid merge surprises).

- [ ] **Step 1: Write the failing unit test for the pure lookup function**

```typescript
// src/lib/import/delegate-code-classification.test.ts
import { describe, it, expect } from 'vitest';
import { classifyDelegateCode } from './delegate-code-classification';

describe('classifyDelegateCode', () => {
  const cases: Array<[string, { participantType: string; registrationCategory: string } | null]> = [
    ['DEL-INT-001', { participantType: 'delegate', registrationCategory: 'Delegates' }],
    ['VOL-TUR-001', { participantType: 'volunteer', registrationCategory: 'Onground Volunteers' }],
    ['VOL-YNG-049', { participantType: 'volunteer', registrationCategory: 'COY21 Organizing Team Volunteers' }],
    ['DEL-UNW-375', { participantType: 'delegate', registrationCategory: 'UN Women Delegates' }],
    ['DEL-IOM-390', { participantType: 'delegate', registrationCategory: 'IOM Youth Delegates' }],
    ['DEL-PYCC-397', { participantType: 'delegate', registrationCategory: 'PYCC Delegates' }],
    ['DEL-YNG-001', { participantType: 'delegate', registrationCategory: 'Policy Team On-ground Delegates' }],
    ['DEL-LCOY-001', { participantType: 'delegate', registrationCategory: 'LCOY Delegates' }],
    ['DEL-RCOY-001', { participantType: 'delegate', registrationCategory: 'RCOY Delegates' }],
  ];

  it.each(cases)('classifies %s correctly', (code, expected) => {
    expect(classifyDelegateCode(code)).toEqual(expected);
  });

  it('returns null for an unrecognized prefix', () => {
    expect(classifyDelegateCode('XYZ-001')).toBeNull();
  });

  it('returns null for an empty or malformed string', () => {
    expect(classifyDelegateCode('')).toBeNull();
    expect(classifyDelegateCode('DEL')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/lib/import/delegate-code-classification.test.ts
```
Expected: fails — module doesn't exist yet.

- [ ] **Step 3: Implement the pure lookup function**

```typescript
// src/lib/import/delegate-code-classification.ts
//
// Fixed prefix -> classification lookup for the one-time delegate/
// volunteer CSV import (design spec:
// docs/superpowers/specs/2026-10-28-delegate-volunteer-csv-import-design.md).
// Deliberately a fixed in-code table, not a database table or a column
// read from the source file -- matches this codebase's existing
// field-dictionary.ts convention for fixed import-time lookups.
//
// Every prefix is mutually non-prefixing with every other (verified by
// hand and by a dedicated test in this file's sibling test suite) --
// DEL-YNG- is not a substring-prefix of DEL-LCOY-/DEL-RCOY-/etc, so
// longest-match-first ordering is not required for correctness, but the
// entries are still checked in this fixed array order for determinism.
const PREFIX_CLASSIFICATION: Array<{
  prefix: string;
  participantType: 'delegate' | 'volunteer';
  registrationCategory: string;
}> = [
  { prefix: 'DEL-INT-', participantType: 'delegate', registrationCategory: 'Delegates' },
  { prefix: 'VOL-TUR-', participantType: 'volunteer', registrationCategory: 'Onground Volunteers' },
  { prefix: 'VOL-YNG-', participantType: 'volunteer', registrationCategory: 'COY21 Organizing Team Volunteers' },
  { prefix: 'DEL-UNW-', participantType: 'delegate', registrationCategory: 'UN Women Delegates' },
  { prefix: 'DEL-IOM-', participantType: 'delegate', registrationCategory: 'IOM Youth Delegates' },
  { prefix: 'DEL-PYCC-', participantType: 'delegate', registrationCategory: 'PYCC Delegates' },
  { prefix: 'DEL-YNG-', participantType: 'delegate', registrationCategory: 'Policy Team On-ground Delegates' },
  { prefix: 'DEL-LCOY-', participantType: 'delegate', registrationCategory: 'LCOY Delegates' },
  { prefix: 'DEL-RCOY-', participantType: 'delegate', registrationCategory: 'RCOY Delegates' },
];

export function classifyDelegateCode(
  code: string
): { participantType: 'delegate' | 'volunteer'; registrationCategory: string } | null {
  const trimmed = code.trim();
  for (const entry of PREFIX_CLASSIFICATION) {
    if (trimmed.startsWith(entry.prefix)) {
      return { participantType: entry.participantType, registrationCategory: entry.registrationCategory };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run src/lib/import/delegate-code-classification.test.ts
```
Expected: all cases pass (9 table cases + 2 edge cases).

- [ ] **Step 5: Add the new field to `field-dictionary.ts`**

Add this entry to the `KNOWN_FIELDS` array (exact position doesn't matter, group it near `participant_type`/other identity-adjacent fields for readability):

```typescript
{ key: 'external_delegate_code', kind: 'core_field', isCriticalIdentity: true, aliases: ['delegate code', 'كود المندوب'] },
```

- [ ] **Step 6: Wire the prefix lookup into `validateRow()`**

Read `src/lib/import/row-validation.ts` first — the insertion point is **after the per-column mapping loop ends (after line ~195's closing `}`) and before the "Required-field checks" comment block (~line 197)**, i.e. after `normalizedRow` is fully built from the column mapping but before the `errors`/`status` are finalized. Add:

```typescript
  // Delegate/volunteer CSV import: classify participant_type/
  // registration_category from external_delegate_code's prefix, when
  // present. This OVERRIDES whatever the column mapping separately
  // produced for participant_type (if the admin also mapped some other
  // column to participant_type -- unlikely for this source file, since
  // it has no such column, but this precedence avoids ambiguity if it
  // ever does). An external_delegate_code present but matching no known
  // prefix is a hard validation error, never a guessed classification.
  const externalDelegateCode = normalizedRow.external_delegate_code as string | undefined;
  if (externalDelegateCode && externalDelegateCode.trim() !== '') {
    const classification = classifyDelegateCode(externalDelegateCode);
    if (classification) {
      normalizedRow.participant_type = classification.participantType;
      normalizedRow.registration_category = classification.registrationCategory;
    } else {
      errors.push({
        column: 'external_delegate_code',
        originalValue: externalDelegateCode,
        error: `Unrecognized delegate code prefix: "${externalDelegateCode}"`,
      });
    }
  }
```

Add the import at the top of the file: `import { classifyDelegateCode } from './delegate-code-classification';`

- [ ] **Step 7: Write a `validateRow()`-level test**

Add to `tests/import/validation-live.test.ts` (read it first to match its existing style/fixture conventions exactly — column mapping shape, how other tests construct a `ColumnMapping[]` and call `validateRow`) or a new sibling file if that's cleaner for this specific feature's tests to live separately — implementer's judgment, but check the existing file's structure before deciding:

- A row with `external_delegate_code` mapped and set to a known-prefix value (e.g. `DEL-INT-005`) → expect `normalizedRow.participant_type === 'delegate'` and `normalizedRow.registration_category === 'Delegates'`, `status !== 'invalid'` (assuming `full_name`/`email` are also present and valid in the fixture row).
- A row with `external_delegate_code` set to an unrecognized prefix (e.g. `XYZ-001`) → expect `status === 'invalid'` and an error entry with `column: 'external_delegate_code'`.
- A row with no `external_delegate_code` column mapped at all → expect no `participant_type`/`registration_category` side-effect (proving this logic is purely additive and doesn't affect every other import that isn't this one).

- [ ] **Step 8: Run the full test suite for this area**

```bash
npx vitest run src/lib/import/delegate-code-classification.test.ts tests/import/validation-live.test.ts
```
Expected: all pass.

- [ ] **Step 9: Typecheck**

```bash
npx tsc --noEmit
```
Expected: same ~419-error baseline, zero new errors.

- [ ] **Step 10: Commit**

```bash
git add src/lib/import/delegate-code-classification.ts src/lib/import/delegate-code-classification.test.ts src/lib/import/field-dictionary.ts src/lib/import/row-validation.ts tests/import/validation-live.test.ts
git commit -m "feat: classify participant_type/registration_category from delegate code prefix"
```

---

### Task 3: Cross-batch `external_delegate_code` collision check

**Files:**
- Modify: `src/app/[locale]/(admin)/participants/import/[batchId]/preview/actions.ts`

**Depends on Task 2** (needs `classifyDelegateCode`/the field-dictionary entry to exist, though this task's own change is independent code in a different function) and **Task 1b** (needs the live column to query against for its live test).

This is architecturally different from Task 2's prefix-lookup — re-read the spec's "Cross-Batch `external_delegate_code` Collision Check" section in full before starting; it was corrected twice during spec review after an initial wrong placement (inside `validateRow()`, which has no slot for batch-level data) was caught. The check belongs in `runValidationForCaller`'s pass-2 loop, mirroring exactly how email-duplicate detection already works — NOT inside `validateRow()`.

- [ ] **Step 1: Read the exact current code first**

Read `src/app/[locale]/(admin)/participants/import/[batchId]/preview/actions.ts` in full, specifically:
- `fetchExistingApplicationsByEmail` (~lines 48-63) — the function to mirror.
- `LOOKUP_CHUNK`/`chunkedIn` (~lines 25-37) — reused as-is, no changes needed.
- `runValidationForCaller`'s structure: where `fetchExistingApplicationsByEmail` is called (~line 183), and the pass-2 loop (~lines 205-258) where `const result = perRowResults[i]` is in scope (~line 207) and the status-counting block / `rowsToInsert.push(...)` read `result.status`/`result.errors` (~lines 242-257).

- [ ] **Step 2: Add the new lookup function**

Add, near `fetchExistingApplicationsByEmail`:

```typescript
async function fetchExistingApplicationsByExternalDelegateCode(
  service: ServiceClient,
  codes: string[]
): Promise<Map<string, { id: string }>> {
  const byCode = new Map<string, { id: string }>();
  if (codes.length === 0) return byCode;
  const rows = await chunkedIn(codes, LOOKUP_CHUNK, async (slice) => {
    const { data, error } = await service.from('applications').select('id, external_delegate_code').in('external_delegate_code', slice);
    if (error) throw new Error(`Failed to look up existing applications by delegate code: ${error.message}`);
    return data ?? [];
  });
  for (const r of rows) {
    if (r.external_delegate_code) byCode.set(r.external_delegate_code, { id: r.id });
  }
  return byCode;
}
```

- [ ] **Step 3: Call it once per validation run, alongside the existing email lookup**

Find where `fetchExistingApplicationsByEmail` is called (collecting the distinct emails first — read the exact surrounding code to match its pattern for collecting the input list, likely from `perRowResults` after pass 1). Add an analogous call collecting distinct `external_delegate_code` values from `perRowResults` and calling the new function:

```typescript
const existingByExternalDelegateCode = await fetchExistingApplicationsByExternalDelegateCode(
  service,
  [...new Set(perRowResults.map((r) => r.normalizedRow.external_delegate_code as string | undefined).filter((c): c is string => !!c && c.trim() !== ''))]
);
```

- [ ] **Step 4: Check the map inside the pass-2 loop, mutating `result` in place**

Inside the pass-2 `for` loop, after `const result = perRowResults[i];` and before the status-counting block (`if (result.status === 'valid') validCount++...`), add:

```typescript
    const externalDelegateCode = result.normalizedRow.external_delegate_code as string | undefined;
    if (externalDelegateCode && externalDelegateCode.trim() !== '' && existingByExternalDelegateCode.has(externalDelegateCode)) {
      result.errors.push({
        column: 'external_delegate_code',
        originalValue: externalDelegateCode,
        error: `Delegate code "${externalDelegateCode}" is already assigned to an existing application`,
      });
      result.status = 'invalid';
    }
```

This mutates the same `RowValidationResult` object `validateRow()` returned in pass 1 — confirmed safe by spec review: `errors`/`status` are plain mutable fields (no `readonly`), and nothing else in the loop reads/resets them before the counting block that follows.

- [ ] **Step 5: Write a live test**

Add to `tests/import/validation-live.test.ts` (or wherever Task 2's `validateRow()`-level tests landed): a test that pre-seeds a real `applications` row with a known `external_delegate_code` (clean up in `afterAll`), then runs `runValidationForCaller` (or the narrowest function that exercises this new check — check what the existing test file's conventions call directly) against a batch containing a row with that same code, and asserts the row comes back `invalid` with the "already assigned" error message.

- [ ] **Step 6: Run and typecheck**

```bash
npx vitest run tests/import/validation-live.test.ts
npx tsc --noEmit
```
Expected: new test passes, zero new typecheck errors.

- [ ] **Step 7: Commit**

```bash
git add "src/app/[locale]/(admin)/participants/import/[batchId]/preview/actions.ts" tests/import/validation-live.test.ts
git commit -m "feat: detect cross-batch external_delegate_code collisions in import preview"
```

---

### Task 4a: Extend `apply_import_row_transactional` (write only, do not apply)

**Files:**
- Create: `supabase/migrations/20261028120000_add_delegate_code_to_apply_import_row.sql`
- Test: `tests/import/apply-delegate-code-live.test.ts`

**Depends on Task 1b** (needs the live columns) and conceptually on Task 2 (the values being written come from that task's wiring, though this task's own migration is independent SQL).

**This is the most important task in this plan — it closes the gap found during spec review.** Without it, `external_delegate_code`/`registration_category` would be correctly computed during preview but silently never written to `applications` at confirm time.

**⚠️ THIS TASK'S JOB IS STEPS 1–2 ONLY — same split as Task 1a.** Do not run the test, do not `supabase db push`, do not commit. Report **DONE_WITH_CONCERNS** when Steps 1-2 are done.

- [ ] **Step 1: Write the migration**

Read `supabase/migrations/20260823010000_wire_participant_type_to_apply_import_row.sql` in full first — this migration's job is to `create or replace` the same function, carrying the ENTIRE current body forward verbatim, with exactly one change: add `'external_delegate_code'` and `'registration_category'` to the `v_text_columns` array (currently 25 entries, declared ~line 47). Do not touch anything else in the function — not the INSERT branch, not `v_participant_type` handling, not the travel/health upsert logic, nothing. Copy the full function body from the current file and make only that one array edit.

```sql
-- supabase/migrations/20261028120000_add_delegate_code_to_apply_import_row.sql
--
-- Adds external_delegate_code and registration_category to
-- apply_import_row_transactional's v_text_columns array, the ONLY
-- mechanism by which a plain-text core_field actually gets copied from
-- normalized_row into the applications table at confirm/apply time
-- (confirmed by reading the full function body and tracing every write
-- path into applications before this migration was written -- see
-- docs/superpowers/specs/2026-10-28-delegate-volunteer-csv-import-design.md's
-- "Apply-Time Wiring" section). Without this, Task 2's prefix
-- classification would compute the right values on normalizedRow during
-- preview, but they would be silently discarded at confirm time -- no
-- error, no warning, just missing data in applications.
--
-- Both new fields are plain text with no special transform (no
-- multi-select splitting, no date/phone parsing), so the existing
-- generic v_text_columns handling (plain passthrough via
-- v_value #>> '{}') is sufficient -- neither needs the kind of
-- dedicated branch full_name/birth_date have.
--
-- This is a CREATE OR REPLACE carrying forward the full function body
-- from 20260823010000 verbatim, with only the v_text_columns array
-- changed. [Implementer: paste the complete current function body here,
-- copied exactly from 20260823010000_wire_participant_type_to_apply_import_row.sql,
-- modifying ONLY the v_text_columns array declaration to add the two
-- new entries. Do not retype the function from memory -- copy it.]
```

**Explicit instruction, not a suggestion:** open the current migration file, copy its ENTIRE `create or replace function apply_import_row_transactional(...) ... $$;` body (everything from `create or replace function` through the final `$$;`) into the new file, and change only the `v_text_columns text[] := array[...]` line to add `'external_delegate_code', 'registration_category'` as two new entries (position doesn't matter, append at the end for minimal diff). Also copy forward the `comment on function apply_import_row_transactional(...) is '...'` statement if the source file has one at its end (it does — check for it), updating the comment text to mention the new fields are now included, so the live function's self-description (which the spec's review confirmed is queryable via the PostgREST OpenAPI spec) stays accurate.

- [ ] **Step 2: Write a live test proving the fix actually works end-to-end**

```typescript
// tests/import/apply-delegate-code-live.test.ts
//
// Proves the Task 4a/4b migration actually works -- that
// external_delegate_code/registration_category genuinely reach the
// applications table after a real apply_import_row_transactional call,
// not just that they're present in normalized_row (which Task 2/3's
// tests already cover at the preview-stage level, before this fix, and
// would pass even if this migration were never applied -- this test is
// the only one that would have caught the original gap).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000 });

const runId = randomUUID().slice(0, 8);
let staffUserId: string;
let importBatchId: string;
let importRowId: string;
let applicationId: string | undefined;

beforeAll(async () => {
  const { data: staff, error: staffError } = await admin.auth.admin.createUser({
    email: `apply-delcode-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (staffError || !staff.user) throw new Error(`staff fixture setup failed: ${staffError?.message}`);
  staffUserId = staff.user.id;
  await admin.from('profiles').update({ role: 'super_admin' }).eq('id', staffUserId);

  const { data: batch, error: batchError } = await admin
    .from('import_batches')
    .insert({
      uploaded_by: staffUserId,
      original_filename: `apply-delcode-${runId}.xlsx`,
      file_checksum: `apply-delcode-${runId}-checksum`,
      storage_path: `apply-delcode-${runId}/dummy.xlsx`,
      status: 'importing',
    })
    .select('id')
    .single();
  if (batchError || !batch) throw new Error(`import batch fixture setup failed: ${batchError?.message}`);
  importBatchId = batch.id;

  const testCode = `DEL-APPLYTEST-${runId}`;
  const { data: row, error: rowError } = await admin
    .from('import_rows')
    .insert({
      import_batch_id: importBatchId,
      excel_row_number: 2,
      row_fingerprint: `fp-${runId}`,
      raw_row: [testCode, 'Apply Test Participant', `apply-delcode-${runId}@test.local`],
      normalized_row: {
        full_name: 'Apply Test Participant',
        email: `apply-delcode-${runId}@test.local`,
        external_delegate_code: testCode,
        participant_type: 'delegate',
        registration_category: 'Delegates',
      },
      validation_status: 'valid',
    })
    .select('id')
    .single();
  if (rowError || !row) throw new Error(`import row fixture setup failed: ${rowError?.message}`);
  importRowId = row.id;
});

afterAll(async () => {
  if (applicationId) await admin.from('applications').delete().eq('id', applicationId);
  if (importRowId) await admin.from('import_rows').delete().eq('id', importRowId);
  if (importBatchId) await admin.from('import_batches').delete().eq('id', importBatchId);
  if (staffUserId) await admin.auth.admin.deleteUser(staffUserId);
});

describe('apply_import_row_transactional — delegate code fields', () => {
  it('writes external_delegate_code and registration_category to the resulting application', async () => {
    const testCode = `DEL-APPLYTEST-${runId}`;
    const { data, error } = await admin.rpc('apply_import_row_transactional', {
      p_import_row_id: importRowId,
      p_import_batch_id: importBatchId,
      p_actor_id: staffUserId,
    });
    expect(error).toBeNull();
    // apply_import_row_transactional returns a plain status string, NOT
    // an application id (confirmed by reading the real function's
    // `return` statements: 'already_applied' | 'skipped' | 'updated' |
    // 'inserted'). This fixture is a fresh row with no pre-existing
    // matching application, so the expected outcome is 'inserted'.
    expect(data).toBe('inserted');

    // Look up the resulting application by external_delegate_code
    // (unique, and known from this fixture) rather than by a returned
    // id, since the RPC doesn't return one.
    const { data: app, error: appError } = await admin
      .from('applications')
      .select('id, external_delegate_code, registration_category, participant_type')
      .eq('external_delegate_code', testCode)
      .single();
    expect(appError).toBeNull();
    applicationId = app!.id; // captured here so afterAll can clean it up
    expect(app!.external_delegate_code).toBe(testCode);
    expect(app!.registration_category).toBe('Delegates');
    expect(app!.participant_type).toBe('delegate');
  });
});
```

- [ ] **Step 3: Report to the controller; stop here.**

This ends Task 4a. Report DONE_WITH_CONCERNS now — do not continue to Task 4b's steps.

---

### Task 4b: Apply the `apply_import_row_transactional` migration live, verify, commit (controller only)

Same controller-only pattern as Task 1b. Depends on Task 4a.

- [ ] **Step 1: Show the full migration SQL to the human and get explicit confirmation** — this one is higher-risk than most (it redefines a 485+-line function that many other import flows depend on), so read the diff carefully yourself before presenting it: confirm the ONLY semantic change from the current live function is the two new array entries, nothing else was accidentally altered in transcription.
- [ ] **Step 2: Apply it live** (`supabase db push --yes`, fresh token if needed).
- [ ] **Step 3: Run the live test**

```bash
npx vitest run tests/import/apply-delegate-code-live.test.ts
```
Expected: 1/1 pass. If it fails, do NOT proceed to commit — investigate (the most likely failure mode is the return-shape assumption noted in Task 4a Step 2, or a transcription slip in carrying the function body forward).

- [ ] **Step 4: Also re-run the full existing import test suite**, to confirm this migration didn't regress anything else that depends on `apply_import_row_transactional`:

```bash
npx vitest run tests/import/
```
Expected: all pass, same as before this migration.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261028120000_add_delegate_code_to_apply_import_row.sql tests/import/apply-delegate-code-live.test.ts
git commit -m "feat: write external_delegate_code/registration_category to applications at import apply time"
```

---

### Task 5: Final review

Not a subagent task — handled by the controller directly after Tasks 1-4 are all individually spec/quality-reviewed and approved, following this session's established pattern (per-task two-stage review during execution, then one final whole-branch review here).

- [ ] Dispatch a final whole-branch code-reviewer subagent for the entire `feature/delegate-volunteer-import` diff against `master`: cross-task consistency (does Task 2's `validateRow()` change and Task 3's pass-2 change correctly compose — e.g. does a row needing BOTH an unrecognized-prefix error from Task 2 AND a collision error from Task 3 behave sensibly, even though that's an unlikely combination), re-verify the migration in Task 4 is genuinely a faithful carry-forward with only the intended array change (diff it against the prior version line-by-line if feasible), full test suite run, typecheck/lint.
- [ ] Use `superpowers:finishing-a-development-branch` to decide merge/PR approach once the final review passes.

---

## Task 6 (NOT part of subagent-driven-development — a manual, one-time operation for the controller + human together, after Task 5's merge)

This is the actual 517-row import run, performed once the code from Tasks 1-5 is live in production. Not a coding task — included here for completeness since the spec's "Source File Preparation" section describes it.

- [ ] Clean the source `.xlsx` file: delete the 8 section-header rows (`"Onground Volunteers"`, `"COY21 Organizing Team Volunteers"`, `"UN Women Delegates"`, `"IOM Youth Delegates"`, `"PYCC Delegates"`, `"Policy Team On-ground Delegates"`, `"LCOY Delegates"`, `"RCOY Delegates"` — each the sole populated cell in a row, sitting in the `Country of residence` column position).
- [ ] Upload the cleaned file via `/admin/participants/import`.
- [ ] On the map step: map `Delegate Code` → `external_delegate_code`, `Full name (as in passport)` → `full_name`, `Email Address` → `email`, `Country of residence` → `country`, `DoB` → `birth_date`, `Phone / WhatsApp` → `phone`, `Emergency Contact` → `emergency_contact_relationship`, `Contact` → `emergency_contact_phone`. Leave `T-shirt size`, `Age`, `Passport number`, `Arrival Date` unmapped (ignored). For the `COY21 Organizing Team Volunteers` (`VOL-YNG-*`) rows specifically: per the spec, `Country of residence`/`Phone / WhatsApp`/`DoB` are corrupted for this block and must NOT be mapped for those rows — since mapping is per-column for the whole file, not per-row, this means either mapping those three columns normally and accepting that the ~49 `VOL-YNG` rows will show garbage warnings in preview (to be manually reviewed/rejected per-field in a later admin edit pass), or splitting this into two separate uploads (all other categories in one file with those columns mapped, `VOL-YNG` rows in a second file with those three columns left unmapped). Decide which with the human before running the import — the spec didn't fully resolve this operational detail, since it's a one-time manual step, not a code question.
- [ ] On the preview step: review and resolve the 36 duplicate-email groups (the pipeline's existing `duplicate_in_file` detection surfaces these automatically) and any rows flagged `invalid` by the new delegate-code validation — before confirming.
- [ ] Confirm the import.
- [ ] Verify: query `applications` directly (not just the preview UI) for a final count and spot-check rows across different prefixes for correct `external_delegate_code`/`participant_type`/`registration_category`, per the spec's Testing section.
