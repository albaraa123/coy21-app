# `next_application_number()` returns duplicate values under concurrency

**Discovered:** 2026-08-01, during Task 4 verification of the test-stabilization plan (`docs/superpowers/plans/2026-07-31-test-stabilization-backend.md`). Out of scope for that plan — recorded here as a standing, separate issue per explicit user instruction to track it independently rather than fix it under the stabilization work.

## Severity

High. This function backs every accepted application's human-facing application number, and the import pipeline that relies on its uniqueness (`confirm/actions.ts`'s `applyOneRow`, run with `ROW_CONCURRENCY = 15`) is real production code, not test-only. If this reproduces in production traffic (not just the test suite), concurrent participant imports would silently fail for most rows in a chunk via unique-constraint collisions, each caught and stamped `skipped_error` rather than surfacing as an import-level failure.

## Symptom

`supabase/migrations/20260722123016_application_number_function.sql` defines:

```sql
create function next_application_number() returns text as $$
  select 'RCOY-2026-' || lpad(nextval('application_number_seq')::text, 5, '0');
$$ language sql;
```

`nextval()` on a real Postgres sequence is one of the most fundamental atomicity guarantees the database provides — under any correct condition, N concurrent calls must return N distinct values, no exceptions, no locking required by the caller.

**Independently reproduced directly** (twice — once during Task 4 investigation, once by the orchestrating session confirming it): 15 concurrent `admin.rpc('next_application_number')` calls against the live linked Supabase project returned only **2 unique values** across all 15 calls, with **zero errors** reported by any call. Example observed output: `RCOY-2026-11176` (×11), `RCOY-2026-11177` (×4).

## How this was found

Task 4's verification of `scale-500.test.ts`/`scale-5000.test.ts` (which import several hundred/thousand rows via `processImportChunkForCaller`'s row-concurrency-15 loop) started intermittently failing on `expect(finalBatch?.inserted_count).toBe(EXPECTED_ROW_COUNT)` — actual counts landed far below expected (51/500, 501/5000, 1198/5000 across different runs). Tracing the shortfall found `apply_import_row_transactional` raising `23505 duplicate key value violates unique constraint "applications_application_number_key"` for most rows in an affected chunk, all colliding on the same generated `application_number`. Isolating with a standalone diagnostic that called `next_application_number()` directly and concurrently — with zero import code involved — reproduced the duplicate-value behavior on its own, ruling out any interaction with the import pipeline's own logic as the cause.

## What this is NOT

- Not a bug in the test files, the import validation/duplicate-detection logic, or anything touched by the test-stabilization plan (Tasks 0-4). Confirmed by reproducing on the exact committed baseline before any test-stabilization changes, and by reproducing with a standalone diagnostic containing zero import-pipeline code.
- Not (as far as investigated) a logic bug in `next_application_number()`'s own SQL — the SQL is a textbook-correct `nextval()` wrapper. The defect is very likely one layer below: something in how Supabase's PostgREST/connection-pooler layer handles concurrent identical RPC calls against this specific function (leading hypothesis: response caching or connection-pooler transaction-mode interaction with `nextval()`'s session-local behavior — unconfirmed, needs dedicated investigation).

## Updates from Task 5 (full verification sweep) and follow-up investigation

- **Reproduces at a much lower concurrency threshold than first documented.** Originally reproduced at n=15 concurrent calls (2/15 unique). Task 5's verification independently reproduced it at **n=3 concurrent calls (1/3 unique)** — a materially lower bar, meaning even light concurrent load (e.g. two unrelated live-test files each importing one row at the same moment) can trigger it, not just the scale tests' n=15 chunk concurrency.
- **Wider blast radius than originally scoped.** Beyond `scale-500.test.ts`/`scale-5000.test.ts`, this bug was also observed causing failures in: `tests/import/downstream-processing-live.test.ts`, `tests/import/confirm-import-live.test.ts`, `tests/import/phase-b-sensitive-import-live.test.ts` (11 sub-tests), `tests/import/reimport-fingerprint-live.test.ts`, `tests/import/rollback-live.test.ts` (3 cases), and — confirmed via dedicated follow-up investigation — **`tests/import/schedule-integration-live.test.ts`**, even though that file only imports a single participant row. Any two of these files running concurrently (which happens routinely under a full-suite run, since vitest `projects` always run concurrently with each other regardless of each project's own `fileParallelism` setting) is sufficient to trigger a collision.
- **`schedule-integration-live.test.ts` specifically**: initially suspected (during Task 5) to indicate an unclosed gap in Task 2's vitest-project-grouping fix (a genuine mandatory-session capacity/eligibility contention issue). Dedicated follow-up investigation ruled this out: a minimal reproduction (`schedule-integration-live.test.ts` run alongside just `downstream-processing-live.test.ts`) showed the single seeded participant's OWN import row gets stamped `skipped_error` with the exact `23505 duplicate key value violates unique constraint "applications_application_number_key"` signature — the participant's `applications` row is never created at all, so they can never enter the allocation pool in the first place. The later assignment-check failure (`tests/import/schedule-integration-live.test.ts:552`) is a downstream symptom of this same upstream collision, not a separate contention mechanism. **Task 2's fix (grouping the three `allocation-live-sequential` files so they don't race each other) is confirmed working correctly for its own actual scope** — it just cannot protect against contention from `default`-project files outside that group, which is an inherent limitation of vitest's `projects` model (separate projects always run concurrently with each other), not a defect in Task 2's implementation.

## Revised conclusion

This bug's blast radius is broad enough that **any test file performing a live import (single-row or bulk) is at risk whenever it runs concurrently with any other live-import test file** — which is common under a full-suite run. A durable test-suite-level mitigation (isolating every import-touching live test into one fully-sequential project) is possible but is a materially larger architectural change than anything in the original test-stabilization plan's scope, and would only mask the underlying issue rather than fix it. The real fix belongs in `next_application_number()` (or its RPC/pooler interaction) itself.

## Suggested next steps (not scheduled, not investigated further under this finding)

- Reproduce with a controlled experiment isolating whether this is PostgREST-level (e.g., an `Accept-Profile`/caching header issue), pooler-level (PgBouncer transaction-mode session state bleed), or something else — try calling the same function via a plain `psql`/direct Postgres connection concurrently to see if the bug reproduces outside PostgREST entirely.
- If confirmed to be a caching/pooler interaction, consider whether marking the function `volatile` explicitly (Postgres SQL functions default to `volatile`, so this shouldn't be the cause, but worth double-checking the function's actual `provolatile` flag in `pg_proc` against what's expected) or wrapping it differently (e.g., `security definer`, or moving the generation inline into `apply_import_row_transactional` instead of a separate RPC hop) changes the behavior.
- Audit whether this could already be causing silent data issues in real (non-test) production imports — check `applications` for any historical `application_number` collisions or gaps that don't match expected sequential behavior.
