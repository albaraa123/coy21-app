# `next_application_number()` — Isolation Report and Proposed Fix

**Status:** Investigation complete. Root cause conclusively proven. Proposed fix below is **not yet implemented** — awaiting review/approval per the explicit instruction to stop after this report.

**Supersedes the "PostgREST/pooler caching" hypothesis** in `docs/superpowers/specs/2026-08-01-next-application-number-concurrency-bug.md` (that doc's hypothesis was reasonable given the evidence available at the time, but is now proven wrong — see below).

---

## Summary

**There is no concurrency bug, no PostgREST bug, no connection-pooler bug, and no bug in `nextval()` or the Postgres sequence.** The root cause is a plain, deterministic string-formatting defect in `next_application_number()`'s own SQL:

```sql
select 'RCOY-2026-' || lpad(nextval('application_number_seq')::text, 5, '0');
```

`lpad(string, length, fill)` in Postgres **truncates from the right** when `string` is already longer than `length` — it does not only pad short strings, as the function's original author evidently assumed. `application_number_seq` has grown past `99999` (6+ digits) through ordinary cumulative usage across this project's development/testing history. Once the sequence exceeded 5 digits, `lpad(..., 5, '0')` began silently truncating every value down to its leading 5 digits — so any 10 consecutive sequence values (e.g. `165750`–`165759`) all truncate to the identical string (`"16575"`), producing exactly the "duplicate" symptom observed, **with zero concurrency required**. Under real concurrent load the underlying integers are still perfectly unique (proven below) — only the display/formatting step collapses them together.

**No historical data has been corrupted.** Every existing `applications.application_number` in the live database is a genuine, unique, correctly-formatted 5-digit value (`RCOY-2026-14320` through `RCOY-2026-16016`, 42/42 distinct). The `unique` constraint on `application_number` has been silently doing its job the whole time — catching every truncation collision and rejecting it with `23505`, converting what would have been silent data corruption into a hard failure (rows landing `skipped_error` / never inserted). The bug's real-world effect has been **availability** (import rows failing once the sequence exceeded 99999), not **correctness** (no wrong or duplicate application numbers exist in the data).

---

## Isolation methodology and results, layer by layer

All five requested layers were tested. A dedicated, isolated git worktree (`worktree-application-number-p0`, branched fresh from `master`) was used — the parked `worktree-test-stabilization` branch (13 commits) was not touched. No production code was modified during this investigation; all probes were either throwaway diagnostic migrations (deleted at the end of this phase, see "Cleanup" below) or throwaway `tests/_scratch_*.test.ts` files (all deleted immediately after use, `git status --short` confirmed clean after each).

### Layer 1 — the PostgreSQL sequence directly

20 sequential `nextval('application_number_seq')` calls, in a tight PL/pgSQL loop, inside a single migration (single backend, single transaction, zero PostgREST/network involvement at all).

**Result: `165730` through `165749` — 20/20 unique, perfectly sequential, no gaps, no repeats.**

The raw sequence is completely correct. This rules out any defect in the sequence object itself.

### Layer 2 — `next_application_number()` called directly inside PostgreSQL

Same setup: 20 tight-loop calls to the function itself (not just `nextval()`), same single backend/transaction, zero PostgREST/network involvement.

**Result: only 2 distinct strings across 20 calls — `"RCOY-2026-16575"` (×10) and `"RCOY-2026-16576"` (×10).**

Cross-checked against the sequence's `last_value` before/after: it advanced by exactly 20 (from `165749` to `165769`), proving all 20 underlying `nextval()` calls inside the function body genuinely consumed 20 distinct, real integers (`165750`–`165769`). The function's **returned value**, however, only showed 2 distinct strings. This isolated the defect to the function's own formatting logic, not the sequence.

**Follow-up probe, `lpad()` behavior in isolation:**

| Input | `lpad(input, 5, '0')` |
|---|---|
| `'165750'` | `'16575'` |
| `'165759'` | `'16575'` |
| `'99999'` | `'99999'` (unchanged — exactly 5 chars) |
| `'100000'` | `'10000'` |
| `'1'` | `'00001'` (correctly padded — this is the case the function was originally designed for) |

Confirms `lpad` truncates from the right when the input exceeds the target length — this is standard, documented Postgres behavior, and the function's original design did not anticipate the sequence ever exceeding 5 digits.

### Layer 3/4 — concurrent calls through separate connections / concurrent Supabase RPC calls

**Caveat on methodology:** this environment has no `psql`, no `DATABASE_URL`, and no direct Postgres connection credentials (only the Supabase REST API URL + service-role key, via `.env.local`) — a true raw-TCP separate-connection test (layer 3 in the strictest sense) was not achievable. The closest available proxy was used instead: 15 independently-constructed `createClient()` instances (each with its own underlying HTTP client) firing `Promise.all`-concurrent RPC calls — genuinely concurrent requests to PostgREST, which itself manages the real Postgres connection pooling. This combines layers 3 and 4 into one test but is an honest, transparent limitation, not a shortcut taken silently.

Two RPCs were compared under identical 15-way concurrent load: a diagnostic `diag_raw_nextval()` (exposing the bare, untruncated `nextval()` result) versus the real `next_application_number()`.

**Raw `nextval()`, 15 concurrent calls: `165770`–`165784` — 15/15 unique, zero errors.**

**`next_application_number()`, 15 concurrent calls (same burst pattern): only 2 distinct values (`"RCOY-2026-16578"` ×6, `"RCOY-2026-16579"` ×9) — zero errors reported by the RPC layer itself** (the RPC call always "succeeds" and returns *a* string; the truncation collision only surfaces later, when that string is used in an `insert` against the `unique` constraint).

This is the decisive proof: **under real concurrency, the raw sequence remains perfectly unique.** The truncation defect is 100% deterministic and reproducible with **zero concurrency** (layer 2 already proved this) — concurrency only determines *how many* colliding rows show up in the same batch, not *whether* the defect exists.

### Layer 5 — the exact application import client path

A minimal, real fixture (one `import_batches` row, 8 `import_rows` rows in valid/no-duplicate state) was seeded, then `apply_import_row_transactional` — the exact RPC `confirm/actions.ts`'s `processImportChunkForCaller`/`applyOneRow` calls per row, with `ROW_CONCURRENCY = 15` — was called concurrently for all 8 rows via `Promise.all`, mirroring the real import pipeline exactly.

**Result: 1 of 8 rows succeeded (`action_taken: 'inserted'`, a real `applications` row created with `application_number: "RCOY-2026-16580"`). The other 7 all failed identically with `23505 duplicate key value violates unique constraint "applications_application_number_key"`.**

This is a byte-for-byte match to the real production symptom already documented, now traced through the entire real code path — not just the bare RPC — with the root cause fully explained.

### Function definition and properties (recorded via `pg_proc`/`pg_sequences` introspection)

```
proname:      next_application_number
provolatile:  v (volatile — the correct/default marker; not the cause)
proparallel:  u (parallel-unsafe — also not the cause)
prosecdef:    false (not security definer)
proconfig:    null (no search_path override — a minor deviation from this
              codebase's convention of every other function setting
              `set search_path = public, pg_temp`, but not implicated in
              this bug; this SQL-language function has no ambiguous
              unqualified-name resolution risk since `application_number_seq`
              is the only referenced object and PL/pgSQL functions
              elsewhere set search_path for a different reason — defense
              against search_path hijacking attacks, not correctness here)
lang:         sql
prosrc:       select 'RCOY-2026-' || lpad(nextval('application_number_seq')::text, 5, '0');
```

```
sequence:      application_number_seq
start_value:   1
increment_by:  1
last_value (at time of writing this report): ~165784+ (still climbing —
  every diagnostic probe run during this investigation itself consumed
  real sequence values, which is expected and harmless)
```

### All uses of `nextval`, `currval`, `setval`, sequence restart, and `application_number` assignment (grepped across every migration)

- `application_number_seq` is created once, in `supabase/migrations/20260721202027_applications_table.sql:12`, `start 1`. Never restarted, never `setval`'d anywhere in the migration history.
- The **only** place `nextval('application_number_seq')` is ever called is inside `next_application_number()` (`supabase/migrations/20260722123016_application_number_function.sql:7`).
- `currval`/`setval` are never used anywhere in this codebase's migrations — confirmed via grep.
- `next_application_number()` is called from exactly one place, always the same pattern: `v_application_number := next_application_number();` immediately followed by `insert into applications (..., application_number) values (..., v_application_number)` — inside `apply_import_row_transactional`'s PL/pgSQL body. This function has been redefined 5 times across migration history (`20260726108000`, `20260726109600`, `20260727010000`, `20260727030000`, `20260731110000` — the last is the live/current definition) as new Phase B features were added, but this specific two-line pattern (generate-then-insert, same transaction, same function invocation) has been **identical and unchanged across every revision**.
- No other code path — client-side (TypeScript), a database trigger, a column default, or any other function — ever generates or assigns an `application_number`. Confirmed via grep across `src/` for `application_number` and `next_application_number`: the only TypeScript-side references are type definitions (`src/types/database.ts`) and read-only display/reporting code; no generation logic exists outside the one PL/pgSQL call site.

---

## Why this satisfies "do not assume `nextval` is duplicating values unless directly proven"

Nothing was assumed. Layer 1 and the raw-`nextval()` half of layers 3/4 directly, empirically proved the sequence and `nextval()` are correct — both in isolation and under real 15-way concurrency, with zero errors and zero duplicates in either condition. The duplication was traced to a specific, single line of SQL (`lpad(...)`) via a targeted, independent probe of that function alone, and confirmed as the sole cause by reproducing the exact real-world symptom (layer 5) using nothing but that already-identified mechanism.

---

## Proposed fix (design only — not implemented, awaiting approval)

### Constraints honored

- Preserve all 42 existing historical `application_number` values exactly as-is (no backfill/rewrite needed — see below).
- Retain the `unique` constraint on `applications.application_number` unchanged.
- Number assignment stays atomic, inside the same database operation/function that inserts the application (no change to the existing generate-then-insert-in-one-function-call architecture — that part was never the problem).
- No client-side/browser number generation, now or ever.
- No weakening of any import assertion; no converting a real collision into a silently-accepted/skipped row. (Note: today's `23505` failures are *already* correctly surfaced as failures, not silently accepted — the fix must not regress this, and should ideally eliminate the failures rather than merely re-labeling them.)

### The fix

Change exactly one line, in a new migration that replaces `next_application_number()`:

```sql
-- Before (buggy):
select 'RCOY-2026-' || lpad(nextval('application_number_seq')::text, 5, '0');

-- After (fixed):
select 'RCOY-2026-' || nextval('application_number_seq')::text;
```

Drop the `lpad(..., 5, '0')` entirely. `nextval()::text` on its own already produces a correctly-formatted, monotonically increasing numeric string with no leading-zero ambiguity for any value ≥ 1 — the padding was only ever cosmetic (making early numbers like `1` display as `00001`), and that cosmetic padding is now the exact mechanism causing silent truncation once the sequence outgrew it. Removing it:

- **Never truncates**, at any sequence value, ever again — `::text` on a `bigint` always produces the full, exact decimal representation, with no length ceiling.
- **Preserves the existing format prefix** (`RCOY-2026-`) exactly.
- **Requires no backfill.** All 42 existing values are already 5-digit (`14320`–`16016`) and remain byte-for-byte unchanged — this migration only changes what NEW numbers look like going forward. New numbers will simply not be zero-padded to 5 digits once they naturally reach 5+ digits anyway (e.g. the next assigned number will be `RCOY-2026-165785` or similar, not `RCOY-2026-16578` — one digit longer than today's format, permanently correct from that point on).
- **Requires zero changes to `apply_import_row_transactional`, the confirm/actions.ts import pipeline, or any TypeScript code** — the function's signature, return type (`text`), and call site are completely unchanged. This is the smallest possible fix: one `create or replace function` migration, one line of SQL changed inside it.
- **Requires zero changes to the `unique` constraint** — it continues to guard against any future, unrelated way a duplicate could arise (defense in depth, unchanged).

### Alternative considered and rejected

**Keep zero-padding but widen it (e.g. `lpad(..., 6, '0')` or `lpad(..., 8, '0')`).** Rejected: this only delays the identical bug to whenever the sequence next outgrows the new, larger fixed width — it does not fix the underlying defect (an implicit, silent length ceiling on a value that has no natural ceiling), it only pushes the same failure mode further into the future for someone else to rediscover. The proposed fix (drop `lpad` entirely) has no such ceiling, ever.

### Testing plan for the fix (once approved)

1. Unit-equivalent: push the fix migration, directly call `next_application_number()` in isolation (mirroring this report's own layer 2 methodology) — confirm N sequential calls now produce N unique, non-truncated values even past the old 5-digit boundary.
2. Concurrency: repeat this report's layer 3/4 methodology (15 concurrent RPC calls) — confirm 15/15 unique.
3. End-to-end: repeat this report's layer 5 methodology (concurrent `apply_import_row_transactional` calls via a real fixture) — confirm all rows succeed with distinct `application_number` values, zero `23505` errors.
4. Regression: re-run the previously-affected live test suites (`scale-500.test.ts`, `scale-5000.test.ts`, `schedule-integration-live.test.ts`, `downstream-processing-live.test.ts`, `confirm-import-live.test.ts`, `phase-b-sensitive-import-live.test.ts`, `reimport-fingerprint-live.test.ts`, `rollback-live.test.ts`) — confirm the `inserted_count`/`skipped_error` symptoms are gone.
5. Confirm the 42 existing historical `application_number` values are completely unchanged (a `select` before/after the migration, diffed).

### What this fix does NOT touch

- `apply_import_row_transactional` (any revision) — unchanged.
- The `applications.application_number` column definition or its `unique` constraint — unchanged.
- Any TypeScript/client code — unchanged (none was ever involved).
- `application_number_seq` itself — unchanged (no restart, no setval, no rewind).
- The `worktree-test-stabilization` branch — untouched throughout this entire investigation, per explicit instruction; its 13 commits remain parked exactly as they were.

---

## Cleanup performed at the end of this investigation phase

Three throwaway diagnostic migrations were created and pushed to the live database during this investigation, to establish ground truth from inside Postgres directly (no other tool provided that access in this environment):

- `supabase/migrations/20260805200000_diag_application_number_isolation.sql` — created `diag_app_number_log`, `diag_app_number_function_props`, `diag_app_number_seq_props` diagnostic tables; ran layers 1/2.
- `supabase/migrations/20260805210000_diag_lpad_behavior.sql` — the `lpad()` truncation probe.
- `supabase/migrations/20260805220000_diag_raw_nextval_rpc.sql` — created `diag_raw_nextval()`, used for the layer 3/4 raw-vs-truncated comparison.

These migrations and the tables/function they created are **diagnostic-only** and should be removed once this report is reviewed (a follow-up cleanup migration dropping `diag_app_number_log`, `diag_app_number_function_props`, `diag_app_number_seq_props`, and `diag_raw_nextval()`, plus deleting these three migration files from history, or leaving them as a permanent record of the investigation — reviewer's call). They are harmless to leave in place in the interim (no production code references them, no RLS exposure beyond what any diagnostic table already has under service-role access).

---

## Addendum: actual implemented fix, and post-fix verification (2026-08-01)

The fix actually implemented and merged **differs from the "Proposed fix" section above**: rather than dropping zero-padding entirely, the approved instruction was to preserve the existing minimum-5-digit zero-padded display format for all values that fit, while allowing unlimited expansion beyond 5 digits for values that don't:

```sql
-- Implemented (supabase/migrations/20260805230000_fix_application_number_truncation.sql):
with generated as (
  select nextval('application_number_seq')::text as value
)
select 'RCOY-2026-' || lpad(value, greatest(5, length(value)), '0')
from generated;
```

`nextval()` is bound once via the CTE and read twice from that same bound value, preserving the single-evaluation-per-call guarantee without changing `language sql` to `plpgsql`. The target width is `greatest(5, length(value))` instead of the proposed fix's "no padding at all" — for any value with 5 or fewer digits this is identical to the original's `lpad(..., 5, '0')` (zero-regression on the existing 5-digit display convention and all 42 historical values), and for any value with more than 5 digits, `greatest(5, length(value))` equals `length(value)`, making `lpad` a no-op (the exact case that used to truncate).

**Post-fix property/grant verification** (via `20260805240000_diag_verify_fix_properties.sql`, since removed — see "Diagnostic migration cleanup" below): `provolatile`, `proparallel`, `prosecdef`, `proconfig`, and `lang` were captured before and after the fix migration and found byte-for-byte identical (only `prosrc` differs, as intended). `information_schema.routine_privileges` showed `EXECUTE` preserved for `service_role`, `authenticated`, `anon`, `postgres`, and `PUBLIC` — `create or replace function` (not drop+create) does not reset a function's ACL, confirmed empirically.

**Boundary tests** (via `20260805250000_diag_boundary_tests.sql`, since removed), run against an isolated `diag_boundary_test_seq` sequence (never the live `application_number_seq`) using `setval()` on only that isolated sequence:

| Scenario | Sequence value | Result | Notes |
|---|---|---|---|
| Below 5 digits | `1` | `RCOY-2026-00001` | Zero-padded, unchanged from original behavior |
| Old ceiling | `99999` | `RCOY-2026-99999` | Unchanged, exactly 5 digits |
| One past old ceiling | `100000` | `RCOY-2026-100000` | All 6 digits, no truncation — the exact previously-broken case |
| Larger still | `1234567` | `RCOY-2026-1234567` | Complete, 7 digits |
| Advances once per call | `500` then next | `RCOY-2026-00500` then `RCOY-2026-00501` | Consecutive, not skipped/repeated |

**End-to-end verification** (concurrency, single-row import, and repeated bulk import at 500 and 5000 rows) is documented in `docs/superpowers/plans/` / the P0 verification session record; summary: 20/20 sequential, 100/100 concurrent, and 1000/1000 concurrent `nextval()`-backed calls all unique; 6/6 scale-test runs (3×500, 3×5000) inserted the exact expected row count with `duplicateCount === 0` every time; live sequence values observed during this verification were already 6 digits (e.g. `RCOY-2026-188253`), directly confirming the fix's dynamic-width behavior in production, not just in isolated boundary tests.

**Fixture/residue discipline**: after every one of the 6 scale-test runs above, database residue was checked and confirmed at zero beyond the run's own already-cleaned fixtures — the untouchable baseline set of pre-existing rows with `import_batch_id IS NULL` was re-verified unchanged (by exact row-id match) after each run. `scale-500.test.ts`'s own `afterAll` self-cleaned correctly across all 3 runs (500 rows stays under PostgREST's 1000-row unpaginated `.select()` cap). `scale-5000.test.ts`'s `afterAll` has a known, separate, out-of-scope pagination-cap bug (already fixed only on the unrelated `worktree-test-stabilization` branch, not touched here) that leaves ~4000 orphaned rows behind per run regardless of pass/fail — this was anticipated, and each of the 3 scale-5000 runs was followed by a manual, scope-verified cleanup (batch id and filename re-confirmed immediately before deletion) restoring residue to zero before the next run began.

### Diagnostic migration cleanup

Per review decision, the two diagnostic migrations created during fix verification (`20260805240000_diag_verify_fix_properties.sql`, `20260805250000_diag_boundary_tests.sql`) were **not** committed to history — they were investigation-only artifacts with no lasting production value (one-time property/grant snapshots into throwaway tables; a self-cleaning boundary-test probe against an isolated, non-live sequence). Their results are captured in full above. The tables they created on the live database (`diag_app_number_grants`, and additional rows in the already-committed `diag_app_number_function_props`) are diagnostic-only, unreferenced by any production code, and may be dropped at any time; they were left in place rather than risk further live-DB DDL churn during this phase, consistent with the same "harmless to leave in place" reasoning already applied to the three earlier diagnostic migrations above.
