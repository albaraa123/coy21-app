# Pre-existing test failures — technical debt

Recorded 2026-07-31 during verification of the track-terminology correction
(commits `3633928`, `744fa49`). Each item below was independently reproduced
against completely unmodified `master` (via `git stash`) to confirm it is
pre-existing and unrelated to that correction, not a regression it introduced.

## 1. `tests/allocation/run-behavioral.test.ts` — 3 flaky tests

- `oversubscribed mandatory session produces capacity_bottleneck and unassigned`
- `a participant hard-excluded from every session in a slot produces no_eligible_sessions`
- `flags an assignment scoring below 0.4 as low_confidence, consistent with the stored score`

All three intermittently fail with `Test timed out in 5000ms` when the file
runs as part of a larger combined suite (its own `allocation-live-sequential`
vitest project). A 4th test in the same file —
`a manual override persists into the confirmed run final state` — fails
deterministically with a Postgres `P0001` "session is at capacity (1 / 1)"
error, suggesting non-deterministic tie-breaking seeds an extra participant
into a capacity-1 session before the override step runs.

Independently reproduced identically on unmodified `master` (2+ separate
stash-based isolation runs, same test names, same error signatures each
time). Likely cause: tight 5s default timeouts combined with live-DB
round-trip variance, plus a genuine non-determinism in fixture seeding for
the override test. Not caused by, or related to, any track/import work.

## 2. `tests/import/schedule-integration-live.test.ts` — deterministic failure

Single test: `imports a participant, runs feature extraction -> clustering ->
allocation -> confirm -> publish, claims their account, and reads their own
published schedule via /schedule's real query`.

Fails at the assertion `expect(assignment).toBeTruthy()` around line 552 —
no `allocation_assignments` row is found for the seeded mandatory session.
Reproduced identically and deterministically (not flaky) on unmodified
`master` across 2 separate runs. Exercises the same `runAllocation`
mandatory-session-assignment code path implicated in finding #1 above —
plausibly the same underlying allocation-engine issue, not a separate root
cause, but not confirmed.

## 3. `tests/import/scale-5000.test.ts` — deterministic duplicate-count mismatch

Single test: `runs upload -> parse -> map -> validate -> confirm-import
end-to-end within acceptable time`.

Fails at `expect(validationResult.duplicateCount).toBe(0)` — consistently
reports 3805 duplicates out of 5000 rows. Reproduced identically
(same exact count, 3805) on unmodified `master`, and reproduced even
immediately after confirming zero leftover `applications` rows matching the
fixture's emails existed beforehand — ruling out simple stale-data
collision as the cause. Root cause not yet identified; likely something
about how the live Supabase project currently classifies existing
applications as duplicates against this specific 5,000-row fixture.

## 4. `tests/import/sensitive-data-rls.test.ts` — contention-only timeouts

Two tests intermittently time out (`Test timed out in 5000ms`) only when run
as part of a large combined multi-suite invocation:
- `application_travel_info RLS > allows super_admin to read`
- `application_health_info RLS > denies registration_admission_manager`

Passes cleanly (17/17) every time when run in isolation. This is pure
resource contention under parallel live-DB load, not a real defect —
recorded here only because it appeared during verification and should not
be mistaken for a regression if seen again in a full-suite CI run.

## 5. Stale worktree-exclusion path (already fixed, noted for context)

`vitest.config.ts` and `eslint.config.mjs` both excluded `.worktrees/**` to
avoid double-running/double-linting a worktree's copy of the source tree,
but this repo's worktrees actually land under `.claude/worktrees/**`
(created by `EnterWorktree`). This was already found and fixed in commit
`7035ab5` (before the track-terminology work), listed here only so the fix
and its causal link to findings #1–3's "leftover live-DB fixture data"
symptoms are documented in one place — the double-run bug this fix closed
is the most likely origin of much of the stale test data cleaned up during
this session's verification passes.

## 6. `tests/schedule/publication-lifecycle.test.ts` — genuine, reproducible, pre-existing gap

Recorded 2026-08-02 during the `worktree-test-stabilization` branch's Task 5
full verification pass (after the separate `next_application_number()` P0 fix
was merged in and after that same pass's own 4-file `afterAll` cleanup fix —
see `docs/superpowers/plans/2026-07-31-test-stabilization-backend.md`). Two
independent, unrelated failure modes in this one file:

**6a. Missing guard in `stage_publication_transactional` against staging a
non-confirmed allocation run.** The test `cannot stage or confirm from a
non-confirmed allocation run` seeds an `allocation_runs` row with
`status: 'draft'` and asserts `stagePublication(...)` rejects — but it
resolves successfully instead. Traced directly to the RPC definition itself
(`supabase/migrations/20260723190000_schedule_publication_functions.sql`):
grepped every `raise exception` in that file and confirmed there is no check
anywhere on `allocation_runs.status` before staging — `confirm_publication`'s
sibling function (`20260723195000_confirm_publication_function.sql`) does
have an equivalent draft-status guard, but `stage_publication_transactional`
does not. This is a genuine gap between the test's documented intent and the
RPC's actual implementation, not a test bug and not a P0/allocation-number
issue.

**6b. Stale, non-reusable `schedule-lifecycle-blocked@test.local` auth user.**
The test `publish_with_gap requires a documented reason and produces a gap
item; a second real-content publish creates revision 2` calls a bare
`admin.auth.admin.createUser({ email: 'schedule-lifecycle-blocked@test.local',
... })` with no reuse-on-failure sweep (see item #7 below). Once that email
is left registered by any interrupted prior run, `secondUser.user` is `null`
and the very next line (`secondApp!.id`) throws `Cannot read properties of
null`. Directly confirmed live: `createUser` on this exact email returns
`"A user with this email address has already been registered"` whenever a
prior run didn't complete cleanly — the same GoTrue "`deleteUser` can
succeed while the address stays permanently reserved" quirk documented
throughout this codebase's other live-test fixture-cleanup comments.

**Confirmed isolated and unrelated**: reproduced identically before and
after both the P0 `next_application_number()` fix and this same pass's
4-file `afterAll` cleanup fix (`confirm-import-live.test.ts`,
`phase-b-sensitive-import-live.test.ts`, `rollback-live.test.ts`,
`reimport-fingerprint-live.test.ts`) — `git status`/diff confirms none of
those changes touch `publication-lifecycle.test.ts`,
`stage_publication_transactional`, or anything in its dependency chain.
Neither failure mode involves `application_number`/duplicate-key errors, the
`import_batches`/FK-cleanup chain those 4 files touch, or allocation
capacity ordering. **Deferred for a future scoped pass** — not fixed here,
per the same treatment as items #1–5 above. Any fix to 6a means changing a
live production RPC (a new migration adding the missing status guard), which
is a real design decision outside the scope of a verification-only pass;
6b would need the same reuse-on-failure sweep pattern as item #7.

## 7. Systemic gap: bare `createUser` with no reuse-on-failure sweep, several files

Recorded 2026-08-02, same pass as item #6. While investigating stale-user
failures across the full-suite verification, found that several
`default`-project live-DB test files still use a bare
`admin.auth.admin.createUser(...)` for their fixed staff/actor email with
**no** stale-user detection, reuse, or reset-password fallback — unlike the
more mature pattern already established elsewhere in this codebase (see
`getOrCreateFixedUser` in `tests/import/confirm-import-live.test.ts`,
`tests/import/phase-b-sensitive-import-live.test.ts`,
`tests/import/rollback-live.test.ts`,
`tests/import/reimport-fingerprint-live.test.ts`, and others). Confirmed
live, directly, that each of the following files' fixed email is currently
stale (returns `"A user with this email address has already been
registered"` on a fresh `createUser` call) after accumulating from repeated
live-DB test runs in the same session:

- `tests/allocation/run-behavioral.test.ts` — `allocation-behavior-staff@test.local`
  (`tests/allocation/run-behavioral.test.ts:57-58`, no error check on `staff.user` at all — a stale
  collision crashes the whole file's `beforeAll` with `Cannot read
  properties of null`, skipping all 5 tests in the file, not just one).
- `tests/auth/accounts-actions-live.test.ts` — `accounts-actions-live-actor@test.local`
- `tests/auth/provision-participant-account-live.test.ts` — same bare-`createUser` pattern
- `tests/schedule/reassign-blocked-participant-behavioral.test.ts` — `reassign-blocked-staff@test.local`

Each of these is a real, provable, scoped defect (same class as the fix
already applied to the 4 import-test files' `afterAll` cleanup in this same
pass) — a single interrupted run of any of these files permanently blocks
every subsequent run's fixed email until someone manually deletes the stale
auth user via the Supabase dashboard/Management API, since `deleteUser` can
itself silently fail to actually free the address (the same GoTrue quirk
noted in item #6b). **Not fixed in this pass** — flagged here as a strong
candidate for a future, narrowly-scoped stabilization pass applying the same
`getOrCreateFixedUser` pattern already proven elsewhere in this codebase to
these 4 (and possibly other, not-yet-audited) files.

## Suggested follow-up (not scheduled)

- Raise `run-behavioral.test.ts`'s per-test timeouts and/or make its
  override-test fixture seeding deterministic.
- Investigate `schedule-integration-live.test.ts`'s missing mandatory-session
  assignment — check whether it shares a root cause with #1.
- Investigate `scale-5000.test.ts`'s duplicate-detection logic against its
  specific fixture — 3805/5000 is too large and too consistent to be
  ordinary flakiness.
- No action needed for #4 (sensitive-data-rls.test.ts) beyond awareness that
  full-suite runs can show contention timeouts on otherwise-passing tests.
- Add a status guard to `stage_publication_transactional` (item #6a) via a
  new migration — a real design decision, not a mechanical fix.
- Apply the `getOrCreateFixedUser` reuse-on-failure pattern to the 4 files
  named in item #7 (and audit for any other bare-`createUser` live test
  files not yet found).

## Update, 2026-08-02 — status after the P0 `next_application_number()` fix and this branch's own Task 5 verification pass

Items #1–3 above are now resolved or substantially narrowed, independent of
this doc (see `docs/superpowers/plans/2026-07-31-test-stabilization-backend.md`
and this branch's Task 5 verification notes for the full evidence trail):

- #1 (`run-behavioral.test.ts`): the deterministic `P0001 "at capacity (1/1)"`
  override-test failure was fixed by this branch's own Task 1
  (`electiveSessionId` capacity/tier fixture correction, commit `9836eec`).
  Re-verified clean (3x isolation, 5/5 tests each, 15/15 total) multiple
  times during Task 5. The 3 originally-flaky timeout tests also passed
  consistently once Task 1's `15000` timeouts were added. **The
  capacity-ordering bug as originally documented here no longer
  reproduces** — confirmed once more via a final clean isolation run after
  removing an unrelated, self-inflicted stale-auth-user artifact from the
  same verification session (see item #7 — `run-behavioral.test.ts`'s own
  bare-`createUser` gap can still crash `beforeAll` entirely under a
  different, unrelated failure mode, but the capacity-ordering bug this item
  originally documented is confirmed fixed).
- #2 (`schedule-integration-live.test.ts`): traced conclusively (Task 5) to
  the same `next_application_number()` truncation bug fixed on the separate
  P0 branch, NOT a shared root cause with #1 as this doc originally
  speculated. Passes cleanly in isolation and with its
  `allocation-live-sequential` siblings now that P0 is merged in. A
  *different*, unrelated full-suite-load contention issue (several other
  `default`-project files' `afterAll` cleanup not being resilient to
  sustained full-suite load — fixed for 4 of them during this same Task 5
  pass) can still transiently affect it under true full-suite load; this is
  tracked separately, not a reopening of this item.
- #3 (`scale-5000.test.ts`): the 3805/5000 duplicate-count mismatch was the
  P0 bug itself (`next_application_number()` truncating past 5 digits,
  colliding 10 consecutive sequence values into one string, which
  compounded into a large accidental "duplicate" count via a different code
  path than originally suspected). Fixed by the P0 branch's migration
  `20260805230000_fix_application_number_truncation.sql`. Re-verified clean
  post-merge: `inserted_count: 5000`, `duplicateCount: 0`.
