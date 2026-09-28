# Test Suite Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 4 remaining root causes documented in `docs/superpowers/specs/2026-07-31-test-stabilization-design.md` (itself built on `docs/superpowers/specs/2026-07-31-pre-existing-test-failures-technical-debt.md`), with zero changes to production allocation/import-validation/admission/attendance/scheduling code.

**Architecture:** Four independent, narrowly-scoped fixes to test files and `vitest.config.ts`: (1) add missing per-test timeouts, (2) fix a fixture capacity value, (3) move a file into an existing sequential vitest project, (4) close a double-run bug and add a self-healing pre-flight sweep. No shared code between the four — they can be implemented and reviewed as independent tasks.

**Tech Stack:** Vitest, Supabase (live linked project), TypeScript.

---

## Ground truth established during design/investigation (do not re-derive — verified against real files)

- `tests/allocation/run-behavioral.test.ts`'s two sibling tests that already have the `15000` timeout are `a manual override persists into the confirmed run final state` (currently ends `..., 15000);` before the next `it`) and `confirming a run makes it immutable — a second confirm/override attempt is rejected` (same pattern). Both use a third-argument-to-`it` timeout with a preceding inline comment explaining why (measured ~4993ms against the 5000ms default).
- `electiveSessionId` is created in this file's `beforeAll` with `capacity: 1`. `runAllocation`'s elective pass (unscoped, runs on every call) fills that single seat, which is why the override test's own later override RPC call always fails with `P0001 "at capacity"`.
- `vitest.config.ts` currently has 4 `projects` entries: `default` (excludes `run-behavioral.test.ts`, `reproducibility.test.ts`, the two dashboard-live files, plus worktree/node_modules), `dashboard-live-sequential`, `allocation-live-sequential` (includes `run-behavioral.test.ts` + `reproducibility.test.ts`, `fileParallelism: false`), `import-scale-sequential` (includes `scale-500.test.ts` + `scale-5000.test.ts`, `fileParallelism: false`).
- `tests/import/schedule-integration-live.test.ts` is currently in neither `default`'s exclude list nor any sequential project's include list — it runs in `default`, concurrently with everything else.
- `tests/import/scale-500.test.ts` / `scale-5000.test.ts` are `include`d in `import-scale-sequential` but **not** excluded from `default` — this is the double-run bug. Both already use a `getOrCreateFixedUser(email)` helper (defined identically in both files) for their fixed staff email (`scale-500-live-staff@test.local` / `scale-5000-live-staff@test.local`) which already reuses-on-failure rather than requiring clean deletion — this part does not need to change.
- Both scale test files' `afterAll` only clean up rows tied to `importBatchId`, a variable set during the test body — if a prior run crashes/is-killed before that assignment (or before `afterAll` completes), nothing from that leftover run is ever found again by a later run. The fixed, deterministic key that IS available before the test runs is `original_filename: 'scale-500.xlsx'` / `'scale-5000.xlsx'` (used in the `import_batches` insert).
- Confirmed via reviewer: joining `allocation-live-sequential` (not creating a new project) is not just simpler but necessary — vitest `projects` run concurrently with each other regardless of their own internal `fileParallelism` setting, so a new dedicated sequential project would not remove `schedule-integration-live.test.ts`'s contention with `run-behavioral.test.ts`/`reproducibility.test.ts`, since all three race the same global `status='accepted'` read.
- The existing worktree-exclusion fix (`.worktrees/**` and `.claude/worktrees/**` in both `exclude` arrays) must not be touched — confirmed present at the top of `vitest.config.ts` and inside `default`'s `exclude` list.

---

## Amendment (added after Task 1's first attempt was blocked)

Task 1's implementer applied the plan's two specified changes exactly, but verification still failed — the override test failed at `P0001 "at capacity (2 / 2)"` instead of `(1 / 1)`, and two other tests failed on assertion mismatches, not timeouts. Independent investigation (direct live-DB query, verified twice with corrected pagination) found the live project currently has **4086 applications with `status='accepted'`**, of which **4067 trace to exactly 3 identifiable, dead (`status: 'imported'`, i.e. already-completed) `import_batches` rows**:

| `import_batches.id` | `original_filename` | accepted-application count |
|---|---|---|
| `5c827ddc-8469-4a0b-8cba-3a76f2c8c8d2` | `scale-5000.xlsx` | 3805 |
| `5a28819f-c16f-4e55-89a2-f8b461213d31` | `confirm-import-live-test.xlsx` | 163 |
| `e4fb64c9-abd7-4c9c-8b76-fca709f496e3` | `confirm-import-live-test.xlsx` | 99 |

These are leftover live-test data from interrupted prior runs of `tests/import/scale-5000.test.ts` and `tests/import/confirm-import-live.test.ts` (both files have their own `afterAll` cleanup keyed to their own run's `importBatchId`, which never ran to completion for these three specific batches). The remaining **19** accepted applications have `import_batch_id = null` and include at least one real human email (`albaraaalbadwi@gmail.com`) — these are **not** test fixtures and must never be touched.

This directly explains why `run-behavioral.test.ts` cannot pass reliably by adjusting its own fixture capacity alone: `runAllocation` reads every `status='accepted'` row project-wide by design (confirmed in `run-allocation.ts` and the design doc), so thousands of contaminating rows compete for/fill session capacity ahead of or alongside this file's own 2 seeded participants. This same contamination is also very likely the underlying explanation for item #3's `scale-5000.test.ts` duplicate-count mismatch (`5c827ddc-...`'s 3805-row batch is almost certainly the exact source of the previously-documented "3805 duplicates out of 5000" figure) — meaning Task 3/4's double-run-bug fix and this new Task 0's cleanup are complementary, not redundant: Task 0 clears the *existing* leftover batch; Task 3/4 prevent *future* leftovers of the same kind from accumulating again.

A new **Task 0** is inserted before Task 1 to perform this cleanup, narrowly scoped to exactly these 3 named batch ids (never a pattern/heuristic match, never the 19 null-batch rows). Task 1 is otherwise unchanged from its original form below, but should be re-verified against the now-clean baseline Task 0 establishes.

---

### Task 0: One-time cleanup of dead leftover import-batch contamination

**Files:**
- No source files modified — this is a live-database data cleanup only, executed via a throwaway diagnostic vitest test file that is deleted immediately after use (matching the pattern already used during investigation).

**Rationale:** `applications.status = 'accepted'` rows belonging to 3 specific, dead (`status: 'imported'`, already fully processed) `import_batches` rows are contaminating every test that calls the unscoped, project-wide `runAllocation`/`runFeatureExtraction` orchestrators. This is a one-time cleanup of existing leftover state, not a recurring fix — Tasks 3/4 separately close the mechanism that let `scale-5000.test.ts` leak data like this again in the future. This task does NOT touch `confirm-import-live.test.ts` itself (out of scope — that file's own hygiene is not part of this plan), only the dead data it left behind.

**Note for the final report (not an action item for this task):** plan review found 6 additional `import_batches` rows with matching filenames (`confirm-import-live-test.xlsx` ×5, `scale-5000.xlsx` ×1) beyond the named 3, all `status: 'imported'` but with zero accepted applications currently tied to them — correctly out of scope for this task's `import_batch_id`-scoped delete (nothing to clean up), but worth surfacing to the user in Task 5's final report as evidence that this leak has recurred more times historically than the plan's narrative alone suggests, reinforcing why Tasks 3/4's prevention work matters.

- [ ] **Step 1: Re-verify the exact contamination scope immediately before deleting anything**

Do not trust the amendment's table blindly — re-run the same `status='accepted'` query grouped by `import_batch_id`, and re-confirm: (a) the exact 3 batch ids and their row counts still match (data may have changed since this plan was amended), (b) each of those 3 `import_batches` rows has `status` indicating it's dead/completed (not `'validating'`, `'processing'`, or any in-progress status that would indicate a currently-running test), (c) the 19-ish null-`import_batch_id` rows are still present and distinct from the 3 batches (confirming they're correctly excluded from this cleanup by construction, since the delete in Step 2 filters by `import_batch_id IN (...)`, which can never match a null value).

**Pagination trap:** PostgREST silently caps an unranged `.select()` at 1000 rows by default — confirmed during plan review that a bare, unranged query undercounted the 3805-row batch as only 1000. Any count/list query in this task MUST use explicit `.range()`-based pagination (loop until a page returns fewer rows than the page size), never a single bare `.select()`, or the re-verification itself could produce a false "counts differ" or a false sense that fewer rows exist than actually do.

For forensic value only (never persisted to disk/git, console output only, consistent with this project's standing no-PII-export constraint): print the full list of application ids about to be deleted for each batch before deleting, so there's an in-session record to work from if something goes wrong mid-delete.

If the live counts differ meaningfully from the table above (e.g., a 4th batch now exists, or one of the 3 batches has grown further), STOP and report — do not extend the cleanup to cover new batches without the same scrutiny applied to the original 3.

- [ ] **Step 2: Delete only rows FK-dependent on exactly these 3 batch ids, in dependency order**

For each of the 3 confirmed batch ids only (never a broader filter):
```ts
const DEAD_BATCH_IDS = [
  '5c827ddc-8469-4a0b-8cba-3a76f2c8c8d2', // scale-5000.xlsx
  '5a28819f-c16f-4e55-89a2-f8b461213d31', // confirm-import-live-test.xlsx
  'e4fb64c9-abd7-4c9c-8b76-fca709f496e3', // confirm-import-live-test.xlsx
];
```
**The authoritative dependency list is NOT to be re-derived by reading `afterAll` cleanups** (those only cover what each specific test's own fixtures happen to touch, which is incomplete for this purpose) — instead, use the complete `NO ACTION` foreign-key set that this codebase's own migrations already documented and enforce against, found in `supabase/migrations/20260726109500_tmp_introspect.sql` (the introspection query and its results comment) and `supabase/migrations/20260726109600_rollback_safety_fixes.sql` (the `apply_import_rollback`-style function's own explicit blocking-reference checks, and its summary comment listing exactly which tables it blocks on). That authoritative set is:

- `participant_feature_snapshots.application_id` — NO ACTION
- `cluster_memberships.application_id` — NO ACTION
- `allocation_assignments.application_id` — NO ACTION
- `schedule_publications.application_id` — NO ACTION
- `schedule_publication_draft_items.application_id` — NO ACTION (note: NOT `schedule_publication_items` — that table name does not exist; verify the real name against the migration before writing any query)
- `allocation_issues.application_id` — NO ACTION, but nullable (a row can exist unattached to any application)

`attendance_records.application_id` and `scan_attempts.application_id` are ALSO `NO ACTION` per `supabase/migrations/20260804120000_create_attendance_records_table.sql`/`20260804130000_create_scan_attempts_table.sql` (from separate, later work than the introspection migration above, so cross-check both sources) — include them in the delete-before-applications step too, even though live investigation during plan review found 0 rows for these specific 3 batches (still include the check, since "0 today" is not "guaranteed 0" and the delete is idempotent/harmless if empty.

`application_answers`, `application_travel_info`, `application_health_info` all `CASCADE` automatically on `applications` delete (confirmed via `20260730110000_application_travel_and_health_info_tables.sql`/`20260726101000_*`) — no explicit delete needed for these three, though deleting them explicitly first is harmless if done out of an abundance of caution.

Delete, per batch id, in this order:
1. Query `applications` by `import_batch_id` to get this batch's application id list.
2. For that id list, delete (chunked 100 at a time) from every `NO ACTION` table above: `participant_feature_snapshots`, `cluster_memberships`, `allocation_assignments`, `schedule_publications`, `schedule_publication_draft_items`, `allocation_issues`, `attendance_records`, `scan_attempts` — by `application_id IN (...)`.
3. `applications` rows for this batch id (this cascades `application_answers`/`application_travel_info`/`application_health_info` automatically).
4. `import_rows` for this batch id.
5. `import_column_mappings` for this batch id.
6. Any associated storage object (`import_batches.storage_path`, if non-null, removed from the `import-uploads` bucket).
7. `import_batches` row itself.

If ANY delete in steps 2-3 fails with a foreign-key violation, this means the dependency list above is still incomplete for some table not yet identified — STOP, do not force the delete through (e.g. do not disable constraints, do not cascade-force), report the exact error and the table it names, so the list can be corrected with the same scrutiny as this task's original review before retrying.

- [ ] **Step 3: Verify zero rows remain for all 3 batch ids, and the 19 null-batch rows are untouched**

Re-query `applications` by each of the 3 batch ids — expect 0 rows each. Re-query the null-`import_batch_id` accepted-applications count — expect it to be unchanged from Step 1's count (proving nothing outside the 3 named batches was touched).

- [ ] **Step 4: Delete the throwaway diagnostic file, confirm `git status --short` is clean**

This task makes no source-file changes, so there is nothing to commit — confirm the tree is clean and move directly to Task 1.

- [ ] **Step 5: Re-run `run-behavioral.test.ts`'s Task 1 verification against the now-clean baseline**

This is deferred to Task 1 itself (already written below) — Task 1's implementer should re-attempt its Step 4 verification now that Task 0 has run, without needing to change Task 1's own code changes (which were already correctly applied per the plan and remain valid).

---

## Second amendment (Task 0 completed successfully and was independently verified — this addresses a DIFFERENT, deeper finding that surfaced when re-verifying Task 1 against the now-clean baseline)

Task 0 ran successfully: exactly 4067 rows removed across the 3 named dead batches, zero rows touched outside them, independently re-confirmed (total accepted applications dropped from 4086 to exactly 19, matching Task 0's own predicted null-batch count exactly). Re-running `run-behavioral.test.ts`'s Task 1 changes against this clean baseline improved the result from 3/5 failing to 4/5 passing — but the override test (`a manual override persists into the confirmed run final state`) still fails at `P0001 "at capacity (2 / 2)"`.

**This is not contamination.** The remaining 19 accepted applications are legitimate data — real, non-test rows with `import_batch_id = null`, including at least one row backed by a real human account. Task 0 correctly determined these must never be touched, and that determination still holds; nothing about this finding changes Task 0's own scope or correctness.

**The actual issue:** `electiveSessionId` is seeded with `language: 'bilingual'`, `difficulty_level: 'all_levels'` — both of which admit any participant regardless of their own language/tier (per `checkStaticHardConstraints` in `src/lib/allocation/hard-constraints.ts`: `all_levels` always matches, and a session's language check is skipped entirely for a participant with an unrecognized/null `preferred_language`). All 19 real accepted applications have `preferred_language: null` AND `experience_level: null` (confirmed via live query), so language-based exclusion cannot work — but `experience_level: null` maps to `beginner` tier via `experienceToTier`, and `isAdjacentOrEqualTier` only admits tiers within 1 step of each other. A session with `difficulty_level: 'advanced'` is 2 steps from `beginner` — **not adjacent** — so it hard-excludes every one of the 19 real applicants, regardless of language.

**Verified directly** (throwaway diagnostic, reproducing the exact fixture shape with `difficulty_level: 'advanced'` instead of `'all_levels'`, and the file's own 2 seeded participants given `experience_level: 'expert'` — which maps to `advanced` tier and is therefore eligible): the elective session filled to exactly 2/2 from the 2 seeded participants only, zero leakage from the 19 real applicants. This mirrors the file's own pre-existing `noMatchSessionId` pattern (a session deliberately shaped to hard-exclude via a static constraint) — same technique, applied to the tier/difficulty axis instead of the language axis, since language cannot be used to exclude `null`-language real applicants.

**Corrected Step 3** (supersedes the original Step 3 text below — do not follow the original text as written, follow this corrected version instead):

In `beforeAll`:
1. Change `electiveSessionId`'s seeded `difficulty_level` from `'all_levels'` to `'advanced'`.
2. Change `electiveSessionId`'s seeded `capacity` from `1` to `3` (not `2` — see reasoning below).
3. In `seedAcceptedApplicant`'s two call sites for `app-0`/`app-1` (the file's only two seeded participants), change `experienceLevel: 'beginner'` to `experienceLevel: 'expert'` — mapping them to `advanced` tier, making them eligible for the now-`advanced`-only elective session. Confirm this doesn't break any OTHER test's assertions in this file first (read every test that references `app-0`/`app-1`'s scores/eligibility before changing this — the plan's own "flags an assignment scoring below 0.4 as low_confidence" test depends on `interests: []` producing a 0-score match, which is orthogonal to `experienceLevel` and should be unaffected, but confirm this yourself rather than assuming).
4. Capacity must be `3`, not `2`: with exactly 2 eligible (seeded) participants and capacity 2, the elective pass would again fill both seats, recreating the original problem — capacity 3 with only 2 eligible participants guarantees exactly 1 free seat survives the elective pass, which the override test's subsequent RPC call moves into.
5. Add an inline comment on/above these lines explaining the causal chain: `electiveSessionId` uses `difficulty_level: 'advanced'` specifically to hard-exclude the 19+ real, non-test `status='accepted'` applications that exist in this live, shared database outside this test file's control (all of which have `experience_level: null`, mapping to `beginner` tier, 2 steps from `advanced` — not adjacent, per `isAdjacentOrEqualTier` in `hard-constraints.ts`) — language-based exclusion (the `noMatchSessionId` pattern used elsewhere in this file) does NOT work here because those real applications also have `preferred_language: null`, which matches any session language unconditionally. `app-0`/`app-1` are given `experienceLevel: 'expert'` so they remain eligible despite the tier restriction. Capacity is 3 (not 2) so the override test's RPC call always has a genuinely free seat after the elective pass's natural fill of exactly 2. Do not "simplify" any of this back to `all_levels`/`beginner`/capacity 2 — each constraint here is load-bearing.

**Explicitly out of scope for this correction:** do not touch `mandatorySessionId` (`is_mandatory: true`, `all_levels`/`bilingual`) or `noMatchSessionId` — both already pass cleanly against the clean baseline (confirmed: 4/5 tests pass after Task 0, with only the override test affected by this deeper issue), so neither needs the same treatment. The mandatory-pass code path treats `is_mandatory` sessions differently from the elective pass per the design spec (only mandatory-eligible participants compete for a mandatory slot, not the full open applicant pool) — this is a pre-existing, correct distinction, not something to investigate further under this task's scope.

Steps 4-5 (isolation runs, commit) below remain as originally written, applied against this corrected Step 3 instead of the original.

---

### Task 1: Fix `run-behavioral.test.ts` — missing timeouts + capacity fixture bug

**Files:**
- Modify: `tests/allocation/run-behavioral.test.ts`

- [ ] **Step 1: Read the current file in full**

Confirm the exact current text of the 3 flaky tests (`oversubscribed mandatory session produces capacity_bottleneck and unassigned`, `a participant hard-excluded from every session in a slot produces no_eligible_sessions`, `flags an assignment scoring below 0.4 as low_confidence, consistent with the stored score`) and the two sibling tests that already have `15000` timeouts, plus the `beforeAll` where `electiveSessionId` is seeded with `capacity: 1`.

- [ ] **Step 2: Add the timeout to the 3 flaky tests**

For each of the 3 tests named above, add a third argument `15000` to their `it(...)` call, in the exact same style as the two sibling tests that already have it — i.e. convert `it('name', async () => { ... });` to:

```ts
it(
  'name',
  async () => {
    ...
  },
  // <comment explaining why, matching the style/wording of the two
  // existing 15000-timeout tests in this same file — same call shape:
  // extraction + allocation + live round-trips against the real hosted
  // Supabase project, same order-of-magnitude wall-clock cost>
  15000
);
```

Do NOT change any assertion, any seeded data, or any other test in the file. Do NOT raise the vitest-global default timeout in `vitest.config.ts` — this is a scoped, per-test fix only (per the design's explicit "do not weaken assertions... or mask failures with arbitrary timeout increases" constraint — 15000 here is not arbitrary, it matches the two already-precedented tests in the same file with the identical call shape, it is not a blanket increase).

- [ ] **Step 3: Fix the `electiveSessionId` capacity fixture bug**

In `beforeAll`, change `electiveSessionId`'s seeded `capacity` from `1` to `2`. Add a one-line inline comment directly above or on that line explaining why capacity must be ≥2: `runAllocation`'s own elective pass (which runs as part of every `runAllocation` call, including the one the override test itself makes) fills one seat before the override test's own override RPC call runs — capacity 1 leaves zero free seats for the override to move into, which is what caused the deterministic `P0001 "at capacity"` failure. Cite this exact causal chain so a future reader doesn't "simplify" it back to 1.

Do NOT change any other seeded value (other sessions' capacities, tags, participant fixtures) — this is a single scalar change plus a comment.

- [ ] **Step 4: Run this file in isolation 3+ times**

Run: `npx vitest run tests/allocation/run-behavioral.test.ts` at least 3 times back-to-back.
Expected: PASS every time, all tests, no timeouts, no `P0001` errors. If any run still fails or times out, STOP — do not add more retries or raise timeouts further; report the exact failure for investigation rather than silently patching around it (per the plan's constraint against masking failures).

- [ ] **Step 5: Commit**

```bash
git add tests/allocation/run-behavioral.test.ts
git commit -m "test(allocation): fix missing timeouts and elective-session capacity fixture bug"
```

---

### Task 2: Move `schedule-integration-live.test.ts` into `allocation-live-sequential`

**Files:**
- Modify: `vitest.config.ts`

- [ ] **Step 1: Read the current file in full**

Confirm the exact current `default` project's `exclude` array and the `allocation-live-sequential` project's `include` array and its explanatory comment.

- [ ] **Step 2: Add `tests/import/schedule-integration-live.test.ts` to `allocation-live-sequential`'s `include` array**

```ts
include: ['**/tests/allocation/run-behavioral.test.ts', '**/tests/allocation/reproducibility.test.ts', '**/tests/import/schedule-integration-live.test.ts'],
```

Update the project's explanatory comment to mention this third file and why it belongs here too — it calls the same global, unscoped `runFeatureExtraction`/`runAllocation` orchestrators (via `runDownstreamProcessingForCaller`), so it races the same shared `status='accepted'` pool as the other two files in this project.

- [ ] **Step 3: Add the same file path to `default`'s `exclude` array**

```ts
exclude: [
  '**/node_modules/**',
  '**/.worktrees/**',
  '**/.claude/worktrees/**',
  '**/tests/allocation/run-behavioral.test.ts',
  '**/tests/allocation/reproducibility.test.ts',
  '**/tests/import/schedule-integration-live.test.ts',
  '**/tests/dashboard/admin-dashboard-queries-live.test.ts',
  '**/tests/dashboard/participant-dashboard-queries-live.test.ts',
],
```

Do NOT touch the `.worktrees/**`/`.claude/worktrees/**` entries in either array — those must be preserved exactly as-is (per the plan's explicit "preserve the existing worktree exclusion fix" constraint).

- [ ] **Step 4: Run the affected files together 2+ times**

Run: `npx vitest run tests/import/schedule-integration-live.test.ts tests/allocation/run-behavioral.test.ts tests/allocation/reproducibility.test.ts` at least twice.
Expected: PASS every time, all three files, confirming they now correctly run sequentially (not concurrently) against each other and no `assignment).toBeTruthy()` failure recurs.

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts
git commit -m "test(config): move schedule-integration-live.test.ts into allocation-live-sequential"
```

---

### Task 3: Fix the `scale-500.test.ts`/`scale-5000.test.ts` double-run bug

**Files:**
- Modify: `vitest.config.ts`

- [ ] **Step 1: Add both scale files to `default`'s `exclude` array**

Continuing from Task 2's edit to the same array:

```ts
exclude: [
  '**/node_modules/**',
  '**/.worktrees/**',
  '**/.claude/worktrees/**',
  '**/tests/allocation/run-behavioral.test.ts',
  '**/tests/allocation/reproducibility.test.ts',
  '**/tests/import/schedule-integration-live.test.ts',
  '**/tests/import/scale-500.test.ts',
  '**/tests/import/scale-5000.test.ts',
  '**/tests/dashboard/admin-dashboard-queries-live.test.ts',
  '**/tests/dashboard/participant-dashboard-queries-live.test.ts',
],
```

(If Task 2 was implemented as a separate commit before this task starts, re-read the file first to get the real current array rather than assuming the exact snippet above — the ordering/exact prior content must be confirmed live, not blind-pasted.)

- [ ] **Step 2: Confirm `import-scale-sequential`'s existing `include` list is untouched**

No change needed there — it already correctly lists both files. This step is just a read-and-confirm, not an edit.

- [ ] **Step 3: Run BOTH scale files together via a single `vitest run` invocation, twice**

Run: `npx vitest run tests/import/scale-500.test.ts tests/import/scale-5000.test.ts` at least twice.
Expected: each file's test appears exactly ONCE in the output (not once under `|default|` and once under `|import-scale-sequential|`) — confirm by checking the reporter's file/test count, not just pass/fail. This proves the double-run is closed.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts
git commit -m "test(config): stop scale-500/scale-5000 tests from double-running in default + import-scale-sequential"
```

---

### Task 4: Self-healing pre-flight sweep for `scale-500.test.ts`/`scale-5000.test.ts`

**Files:**
- Modify: `tests/import/scale-500.test.ts`
- Modify: `tests/import/scale-5000.test.ts`

- [ ] **Step 1: Read both files' current `beforeAll`/`afterAll`/`getOrCreateFixedUser` in full**

Confirm the exact current `beforeAll` (currently just `staffId = await getOrCreateFixedUser(STAFF_EMAIL); await admin.from('profiles').update(...)`) and the fixed constants (`STAFF_EMAIL`, and the `original_filename: 'scale-500.xlsx'` / `'scale-5000.xlsx'` string used later in the test body's `import_batches` insert — this string needs to be hoisted to a named constant near the top of the file if it isn't already, so the new sweep function and the later insert both reference the same literal rather than risking future drift).

- [ ] **Step 2: Write a `sweepStaleFixtures` helper function in each file**

Add a function (near `getOrCreateFixedUser`, same file) that runs BEFORE `getOrCreateFixedUser`/seeding, sweeping any pre-existing `import_batches` row matching this file's fixed `original_filename`, and everything that FK-depends on it, in dependency order:

```ts
// Self-healing pre-flight sweep: if a prior run of this exact test file
// crashed, was killed, or otherwise never reached its own afterAll, its
// import_batches row (and everything FK-depending on it) is left behind
// with no other mechanism to find it again — afterAll only knows about
// THIS run's own importBatchId, a variable that doesn't exist until the
// test body runs. This sweep uses the fixed, deterministic
// original_filename this file always inserts, so a later run can always
// find and clean up ANY prior leftover run of this same file, not just
// gracefully-completed ones. Runs in beforeAll, before any seeding.
async function sweepStaleFixtures(): Promise<void> {
  const { data: staleBatches } = await admin.from('import_batches').select('id, storage_path').eq('original_filename', ORIGINAL_FILENAME);
  for (const batch of staleBatches ?? []) {
    const { data: apps } = await admin.from('applications').select('id').eq('import_batch_id', batch.id);
    const appIds = (apps ?? []).map((a) => a.id);
    for (let i = 0; i < appIds.length; i += 100) {
      await admin.from('applications').delete().in('id', appIds.slice(i, i + 100));
    }
    const { data: rows } = await admin.from('import_rows').select('id').eq('import_batch_id', batch.id);
    const rowIds = (rows ?? []).map((r) => r.id);
    for (let i = 0; i < rowIds.length; i += 100) {
      await admin.from('import_rows').delete().in('id', rowIds.slice(i, i + 100));
    }
    await admin.from('import_column_mappings').delete().eq('import_batch_id', batch.id);
    await admin.from('import_batches').delete().eq('id', batch.id);
    // Mirrors afterAll's own storage cleanup (storagePath removal) — without
    // this, a crashed prior run's uploaded object leaks in the
    // import-uploads bucket even after its DB rows are swept.
    if (batch.storage_path) await admin.storage.from('import-uploads').remove([batch.storage_path]);
  }
}
```

Where `ORIGINAL_FILENAME` is a new named constant (`const ORIGINAL_FILENAME = 'scale-500.xlsx';` / `'scale-5000.xlsx';`) declared near the file's other existing constants (`STAFF_EMAIL`, `FIXTURE_PATH`, etc.), and the later `original_filename: 'scale-500.xlsx'` literal in the test body's `import_batches` insert is changed to reference `ORIGINAL_FILENAME` instead of repeating the string, so the sweep and the insert can never drift apart.

This mirrors the FK-order cleanup already used in this file's own `afterAll` (applications → import_rows → import_column_mappings → import_batches) — same order, same chunking pattern (100 at a time), just triggered proactively instead of reactively.

- [ ] **Step 3: Call `sweepStaleFixtures()` at the start of `beforeAll`, before `getOrCreateFixedUser`**

```ts
beforeAll(async () => {
  await sweepStaleFixtures();
  staffId = await getOrCreateFixedUser(STAFF_EMAIL);
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);
}, 300000);
```

Do NOT change `getOrCreateFixedUser` itself, and do NOT change any part of the existing `afterAll` — this is purely additive, a new pre-flight step, not a replacement for the existing reactive cleanup (both should coexist: `afterAll` cleans up THIS run's data on graceful completion; the new sweep cleans up any PRIOR run's leftover data that `afterAll` never got to).

- [ ] **Step 4: Apply the identical pattern to the other scale file**

Repeat steps 2-3 for whichever of `scale-500.test.ts`/`scale-5000.test.ts` wasn't done first, using that file's own `STAFF_EMAIL`/`original_filename` constants. The two files' sweep functions will be near-identical (same shape, different string constants) — this is intentional duplication matching this codebase's existing convention of each scale-test file being fully self-contained (confirmed: neither file currently imports helpers from the other).

- [ ] **Step 5: Verify the sweep actually works — manually seed a fake "leftover" batch and confirm it gets cleaned**

Before running the real tests, write a throwaway diagnostic (either inline temporarily in the test file, run once and reverted, or as a separate throwaway vitest file deleted immediately after) that inserts an `import_batches` row with the fixed `original_filename` and a couple of dependent `applications` rows, confirms via direct query that they exist, then runs ONLY `beforeAll` (or the real test file, which will invoke it) and confirms via direct query that the fake leftover rows are gone before the real seeding proceeds. This is the only way to be confident the sweep genuinely works before trusting it to run silently inside the real test suite. Delete any throwaway file used for this and confirm `git status --short` is clean afterward.

- [ ] **Step 6: Run both scale files together via a single invocation, twice**

Run: `npx vitest run tests/import/scale-500.test.ts tests/import/scale-5000.test.ts` at least twice.
Expected: PASS every time, `duplicateCount: 0`, `validCount` equal to `EXPECTED_ROW_COUNT` (500 / 5000) for both files, both times.

**Important — the plan's explicit caveat:** if `duplicateCount` is still nonzero after Tasks 3 and 4 are both applied, this is NOT necessarily proof the fix is wrong — the design doc explicitly flags that the double-run bug may not be the sole cause of the original 3805/5000 mismatch. If a nonzero count persists, STOP and report it as a separately-investigated issue (with the exact count and any new diagnostic findings) rather than adjusting the test's assertion or looping the sweep to "just make it pass." Do not modify `expect(validationResult.duplicateCount).toBe(0)` under any circumstance — if that assertion is wrong for a legitimate reason, that determination belongs to the human reviewing this plan's results, not to code written under this task.

- [ ] **Step 7: Commit**

```bash
git add tests/import/scale-500.test.ts tests/import/scale-5000.test.ts
git commit -m "test(import): self-healing pre-flight sweep for scale-500/scale-5000 stale fixtures"
```

---

### Task 5: Full verification sweep

**Files:** None (verification only, no changes expected — if any change IS needed here, STOP and report rather than silently fixing, since this task's job is to verify Tasks 1-4, not to do new work).

- [ ] **Step 1: Run each of the 4 previously-failing test identities in isolation, 3+ times each**

- `npx vitest run tests/allocation/run-behavioral.test.ts` — 3 times.
- `npx vitest run tests/import/schedule-integration-live.test.ts` — 3 times.
- `npx vitest run tests/import/scale-500.test.ts` — 3 times.
- `npx vitest run tests/import/scale-5000.test.ts` — 3 times.

Expected: PASS every single time, all 12 runs. Record each run's output.

- [ ] **Step 2: Run the affected neighboring suites**

- `npx vitest run tests/allocation/reproducibility.test.ts` (shares the `allocation-live-sequential` project with the fixed files — confirm it still passes, not perturbed by the new file joining its project).
- `npx vitest run tests/import/downstream-processing-live.test.ts` (the file whose `getOrCreateFixedUser` pattern was referenced/mirrored — confirm unaffected).

- [ ] **Step 3: Run the complete import/allocation/agenda/attendance test surface**

Run: `npx vitest run tests/import tests/allocation tests/agenda tests/attendance`
Record the full pass/fail summary. Any failure here that ISN'T one of the 4 already-known pre-existing items (or a newly-introduced regression) must be individually triaged — do not assume it's "probably fine."

- [ ] **Step 4: Verify scale-500/scale-5000 produce the expected row counts**

From Step 1's scale-test runs, confirm `finalBatch?.inserted_count` equals exactly `500` and `5000` respectively (both files already assert this — just double-confirm it in the actual output, not just that the test passed).

- [ ] **Step 5: Verify cleanup leaves no deterministic fixture residue**

After Step 3's full run completes, directly query the live database (via a throwaway diagnostic test file, deleted afterward) for: any `import_batches` row with `original_filename` in `('scale-500.xlsx', 'scale-5000.xlsx')`, any `conference_days`/`tracks`/`session_types`/`rooms` rows matching the fixed codes used by `run-behavioral.test.ts` or `schedule-integration-live.test.ts` (check each file's own fixture-seeding code for its exact fixed codes/emails first — do not guess). Also list the `import-uploads` storage bucket (e.g. `admin.storage.from('import-uploads').list('scale-500-live-test')` / `'scale-5000-live-test'`, matching each file's own `storagePath` prefix) and confirm no leftover objects remain there either — the sweep in Task 4 removes storage objects for batches it finds via `original_filename`, but this step should independently confirm no orphaned storage object exists without a matching `import_batches` row. Expected: zero rows/objects found for all of the above. Delete the diagnostic file and confirm `git status --short` is clean.

- [ ] **Step 6: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: zero errors (pre-existing unrelated warnings, if any, are acceptable — compare against the warning count on unmodified `master` from Step 7 to confirm no new ones were introduced).

- [ ] **Step 7: Compare against unmodified master**

The git stash stack is shared across worktrees/sessions — never use bare `git stash`/`git stash pop`, since another session could push or pop concurrently. Use a uniquely-tagged `git stash push -u -m "<unique-tag>"`, immediately capture its SHA via `git stash list --format='%H %gs'`, restore with `git stash apply <sha>` (not `pop`), then drop the entry by re-finding its current `stash@{n}` by tag. Alternatively, check out `master` in a separate scratch clone/worktree if simpler and safer. Re-run the same 4 previously-failing test identities against unmodified `master` one more time, to have a final, contemporaneous confirmation that: (a) they still fail there exactly as documented, and (b) nothing about the wider environment changed in a way that would make this comparison stale. Restore this branch's changes afterward and confirm `git status --short` is clean.

- [ ] **Step 8: Final report**

Summarize: which of the 4 items are now fully resolved (isolated + combined + full-suite all green), and — if Task 4's caveat triggered — which remain open with the exact evidence gathered, ready for separate investigation. Do not mark an item "resolved" unless it passed ALL of: 3x isolation, 2x combined-with-siblings, and the full-suite run in Step 3.

---

## Handoff

After Task 5, invoke `superpowers:finishing-a-development-branch` to decide how this worktree's branch (`worktree-test-stabilization`) gets merged into `master`. Do not merge or push without going through that skill. Per the user's original instruction, this must be fully merged and green BEFORE returning to Phase 6 (QR issuance) implementation.
