# Test Suite Stabilization — Design

**Status:** Draft, pending spec review and user approval.

**Goal:** Fix the three still-open items (#1-3) from `docs/superpowers/specs/2026-07-31-pre-existing-test-failures-technical-debt.md`, isolated in this worktree, without touching `src/lib/allocation/run-allocation.ts`'s actual logic, `src/lib/allocation/deferred-acceptance.ts`, `src/lib/allocation/hard-constraints.ts`, or `src/lib/import/row-validation.ts` — root-cause investigation confirmed all four are internally correct; every failure traces to test fixtures/config, not production code.

## Root causes (from investigation)

1. **`run-behavioral.test.ts` — 3 flaky timeouts.** Missing the `15000ms` per-test timeout override that two sibling tests in the same file (identical live round-trip shape: extraction + allocation + RPC calls) already carry.
2. **`run-behavioral.test.ts` — deterministic override `P0001` failure.** `electiveSessionId` is seeded with `capacity: 1`. `runAllocation`'s own elective pass (run as part of the same call the test is exercising) fills that single seat before the test's own override RPC call runs, so the override always fails with "at capacity."
3. **`schedule-integration-live.test.ts` — deterministic missing mandatory assignment.** Calls the same global, unscoped `runFeatureExtraction`/`runAllocation` orchestrators as `run-behavioral.test.ts` (by design: `run-allocation.ts` reads every `status='accepted'` application project-wide, no per-test scoping) but was never added to a `fileParallelism: false` sequential vitest project, unlike its sibling that exercises the same orchestrators. Runs concurrently with ~30 other live-DB test files in the `default` project.
4. **`scale-500.test.ts`/`scale-5000.test.ts` — duplicate-count mismatch.** Not a fixture-generation bug (verified zero within-file duplicate emails in both `.xlsx` fixtures). Two compounding causes:
   - `vitest.config.ts`'s `default` project exclude list omits both files, even though they're separately `include`d in the `import-scale-sequential` project — so every `npx vitest run` invocation runs each file **twice, concurrently**, against the same live Supabase project. Confirmed via direct reproduction: two simultaneous failures, one tagged `|default|` and one `|import-scale-sequential|`, both reporting the identical duplicate count.
   - `afterAll` cleanup is not resilient to an interrupted prior run (crash, kill, or the already-documented `AuthRetryableFetchError` on `deleteUser`) — leftover `applications`/`import_rows`/`import_batches` rows accumulate across runs with no self-healing mechanism.

## Fixes

### Fix 1 & 2 — `tests/allocation/run-behavioral.test.ts`

- Add the third-argument `15000` timeout to the 3 currently-flaky tests (`oversubscribed mandatory session...`, `a participant hard-excluded...`, `flags an assignment scoring below 0.4...`), matching the exact pattern and inline-comment style already used on the two sibling tests (`a manual override persists...`, `confirming a run makes it immutable...`).
- Change `electiveSessionId`'s seeded `capacity` from `1` to `2` in this file's fixture setup (`beforeAll`), so `runAllocation`'s own elective pass filling one seat during the override test still leaves a free seat for the test's subsequent override RPC call. Add an inline comment explaining why capacity 2 (not 1) is required, so a future reader doesn't "simplify" it back to 1.

### Fix 3 — `tests/import/schedule-integration-live.test.ts` + `vitest.config.ts`

- Add `tests/import/schedule-integration-live.test.ts` to the existing `allocation-live-sequential` vitest project's `include` list (it drives the identical `runFeatureExtraction`/`runAllocation` orchestrators as that project's other two files, so joining rather than creating a new project is the minimal, precedented change) — OR create a new project if the reviewer/plan-writer determines the two shouldn't share a project (e.g., if `schedule-integration-live.test.ts`'s own runtime profile is meaningfully different). Default assumption: join `allocation-live-sequential`.
- Add the same file path to the `default` project's exclude list, mirroring the pattern already used for `run-behavioral.test.ts`/`reproducibility.test.ts`.

### Fix 4 — `tests/import/scale-500.test.ts`, `tests/import/scale-5000.test.ts` + `vitest.config.ts`

- Add both file paths to the `default` project's exclude list (closing the double-run bug; they're already correctly `include`d in `import-scale-sequential`).
- Add a `beforeAll` self-healing sweep to both files: before seeding, delete any pre-existing `import_batches` row(s) matching this file's own fixed `original_filename` (`scale-500.xlsx` / `scale-5000.xlsx`) and their dependent `applications`/`import_rows`/`import_column_mappings`, plus reuse-or-clean the fixed staff email — mirroring the `getOrCreateFixedUser` stale-user-reuse pattern already established in `tests/import/downstream-processing-live.test.ts`. This makes a future interrupted run self-heal on its next invocation without manual database intervention.

## Explicitly out of scope

- No changes to `run-allocation.ts`, `deferred-acceptance.ts`, `hard-constraints.ts`, `issues.ts`, or any production allocation/import code.
- No changes to `sensitive-data-rls.test.ts` (item #4 in the tech-debt doc, confirmed contention-only, no code fix warranted) or the already-fixed worktree-exclusion path (item #5).
- No changes related to Phase 6 (QR issuance/participant interface) — fully separate track of work.

## Testing plan

- After each fix, run the specific affected file(s) in isolation 3+ times to confirm no flakiness remains.
- After all fixes, run the full previously-failing combination (`tests/allocation/run-behavioral.test.ts`, `tests/import/schedule-integration-live.test.ts`, `tests/import/scale-500.test.ts`, `tests/import/scale-5000.test.ts`) together at least twice to confirm the double-run/contention issues are resolved under combined load, not just in isolation.
- Full relevant-suite run (`tests/import`, `tests/allocation`, `tests/attendance`, `tests/agenda`) to confirm no new regressions.
- Typecheck, lint, build.
