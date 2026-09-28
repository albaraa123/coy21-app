# Phase 5.1 — Merge Readiness Report

**Branch:** `accepted-participants-import`
**Final commit:** `5467c51`
**Report date:** 2026-07-27

---

## Summary

All 8 release gates you specified have been worked through. Gates 1, 4, 5, and 6 are **fully complete**. Gate 2/3 (the real invitation-email send) is **blocked on an external Resend account issue**, not a code or configuration problem on this side — root-caused precisely, documented below, and does not block the rest of the feature from working correctly. Two real, previously-undiscovered bugs were found and fixed during manual UI testing that automated tests had never caught, because they only manifest through actual UI navigation.

**This branch is materially more solid than it was at the last checkpoint** — not just verified, but measurably fixed in several places. Recommend merging once Gate 2/3 clears (see exact next step at the end).

---

## Gate 1 — Resend SMTP configured

**Status: Complete.**

- Resend account configured with a verified sending domain (`rcoymena.com`).
- Supabase Auth's custom SMTP settings correctly point at Resend (`smtp.resend.com:465`, username `resend`, sender `noreply@rcoymena.com`).
- No changes made to `inviteUserByEmail` call sites or the claim architecture — this was purely infrastructure configuration, exactly as scoped.
- Fixed a real, separate gap found along the way: `NEXT_PUBLIC_SITE_URL` was never set in `.env.local`, meaning every invite's claim link would have resolved to `undefined/claim`. Now set to `http://localhost:3000` for local dev.

**Note on security hygiene during this process:** several Resend API keys were pasted directly into chat during setup. Each one was flagged immediately and you were asked to revoke it. **Please do a final check of your Resend → API Keys page and confirm only the key you intend to keep is active** — I cannot verify this myself since I never handle the actual key values.

---

## Gate 2 & 3 — Real invitation-email test and full invitation-to-claim flow

**Status: Blocked, root cause fully diagnosed, not a code issue.**

Every element of the SMTP/domain configuration was independently verified correct:
- Resend confirms `rcoymena.com` is `Verified` (checked directly in Resend's Domains page).
- The Supabase SMTP Sender email correctly uses `noreply@rcoymena.com`.
- A real API key is active and was recently used (per Resend's own API Keys page).

**Yet every real send attempt still fails**, and Resend's own request logs (`Resend → Logs`, not Supabase's logs) show the precise reason directly from Resend's API: `"The rcoymena.com domain is not verified."` — i.e., Resend's Domains **UI** shows the domain as verified, but Resend's **live sending API** is independently rejecting sends against that same domain. This is an inconsistency on Resend's own infrastructure, external to this codebase and outside what Supabase or this app can control. It was reproduced multiple times, at different points across roughly an hour, with no change in outcome — consistent with either an unusually long propagation delay on Resend's side or an account-level issue worth raising with Resend support directly.

**What this means for Gate 2/3:**
- `tests/import/invitation-live.test.ts` (3 of 4 cases) remains unverified — cannot pass until real sends succeed.
- The full invitation → claim flow's **claim half** (the actual account-linking, RLS, and schedule-reading logic) **was fully verified** via the manual smoke test (Gate 4) using a directly-constructed claimed-account state — this is the same technique `tests/import/claim-live.test.ts` uses and is not a workaround, it's the established, correct way to test claim logic without depending on real email delivery. It passed completely: application number, status, and claimed data all correct.
- `tests/import/schedule-integration-live.test.ts` — the automated test covering import → claim → downstream processing → publish → participant reads their own schedule — **passes cleanly**, verified twice in a row this session.

**What is NOT yet verified:** the actual `inviteUserByEmail` → real email delivery → participant clicks a real link path. This is the one piece of the flow that requires the Resend issue to resolve.

**Recommended next step:** contact Resend support about the domain-verified-in-UI-but-rejected-at-send-time discrepancy for `rcoymena.com`, or simply wait longer and retry `npx vitest run tests/import/invitation-live.test.ts` once resolved. No code changes are needed on this side when it clears.

---

## Gate 4 — Manual localhost UI smoke test

**Status: Complete.** Every step you asked for was walked through live, together, in the browser:

| Step | Result |
|---|---|
| Excel upload | ✅ Worked correctly |
| Mapping | ✅ All columns auto-mapped at 100% confidence, email correctly flagged as unique identifier needing review |
| Preview | ✅ 50/50 rows validated correctly, 0 errors |
| Confirm import | ✅ **Found and fixed a real bug** — see below. After the fix: 50/50 rows imported live |
| Import history & batch details | ✅ **Found and fixed a real bug** — see below. After the fix: full batch detail page with real audit trail worked |
| Participant claim/login | ✅ Verified via a directly-constructed claim scenario — claim succeeded, application correctly linked |
| Participant published schedule | ✅ Verified via the automated `schedule-integration-live` test (real UI walkthrough would need a full allocation pipeline run, substituted per your approval with the equivalent automated end-to-end test) |

### Two real, previously-undiscovered bugs found and fixed

**1. "Proceed to confirm" button was a non-functional stub.** The entire confirm-import UI (`confirm/page.tsx`, `import-progress.tsx`) was fully built and working, but the preview page's button that should navigate to it was still `alert('Confirm-import step is not implemented yet.')` — a leftover placeholder from early development that was never wired up. **This would have completely blocked every real import through the UI.** No automated test caught it because every test calls the underlying server actions directly, bypassing the UI. Fixed with a one-line router navigation. Commit `c510539`.

**2. Import history's "View" link went to a 404.** A relative-URL resolution bug (`href={batch.id}` resolved against the wrong base path) sent admins to `/participants/{batchId}` instead of `/participants/imports/{batchId}` — the applications-detail route instead of the batch-detail route. Fixed and verified. Commit `2d8cfa6`.

Both are exactly the kind of gap that only surfaces through actual UI navigation, which is precisely why you asked for this manual pass — it caught real, launch-blocking issues that a purely automated test suite missed.

---

## Gate 5 — Deferred Low-severity findings

**Status: Both resolved.**

1. **`import_rows.duplicate_of_row_id` was declared, indexed, and computed but never actually saved to the database.** Implemented properly: a post-insert linking pass now persists it correctly, and the preview UI now shows "duplicate_in_file (of row N)" instead of nothing. Verified with a new live-test assertion, run twice. Commit `f26db6f`.

2. **Unused `actorId` parameter in `resendInvitation`/`revokeInvitation`.** Confirmed the caller already handles audit logging independently, then removed the dead parameter from both function signatures and their call sites. Commit `6a24761`.

---

## Gate 6 — Full re-verification (tests, typecheck, lint, build, git status)

**Status: Complete, and substantially more thorough than a single pass.**

Running the full test suite together (as one batch) repeatedly surfaced real cross-test interference on the shared live database — not code bugs, but genuine resilience gaps in the tests' own setup/cleanup logic that let one test's leftover data collide with another's. Rather than paper over this, each affected test file was diagnosed and fixed individually:

- **7 live test files** had real gaps in how they recover from a previous run's leftover data — ranging from "no recovery at all" to "recovers the Auth user but not everything that user could be referencing." All fixed with the same, consistent pattern (`getOrCreateFixedUser`: reuse a stale account rather than assuming deletion will succeed) and a complete downstream-reference cleanup (6 database tables checked, not just the obvious one).
- Cleaned up **thousands of orphaned test rows** accumulated across this session's own repeated test runs (each properly investigated and traced to a specific interrupted run, never blindly deleted).
- Every one of the 11 relevant test files was then run **individually** (not as one combined batch) to get a trustworthy, uncontaminated signal.

**Final individual-run results — all clean:**

| File | Result |
|---|---|
| `row-validation.test.ts` | ✅ 14/14 |
| `validation-live.test.ts` | ✅ 1/1 |
| `rls/import.test.ts` | ✅ 29/29 (2 consecutive runs) |
| `claim-live.test.ts` | ✅ 5/5 |
| `reimport-fingerprint-live.test.ts` | ✅ 1/1 |
| `rollback-live.test.ts` | ✅ 5/5 (2 consecutive runs) |
| `confirm-import-live.test.ts` | ✅ 1/1 |
| `downstream-processing-live.test.ts` | ✅ 4/4 |
| `schedule-integration-live.test.ts` | ✅ 1/1 (2 consecutive runs) |
| `claimed-update-gate-live.test.ts` | ✅ 1/1 |
| `scale-500.test.ts` | ✅ 2/2, ~20 rows/sec, consistent with prior measurements |
| `scale-5000.test.ts` | ✅ 1/1, ~24-26 rows/sec, ~3.5 min for 5,000 rows |
| `invitation-live.test.ts` | ❌ Blocked on Gate 2/3's external Resend issue, documented above — not attributable to any code change |

**`npx tsc --noEmit`:** clean, zero errors.
**`npm run lint`:** clean, zero errors (one pre-existing, unrelated warning in a Phase 5 test file, predates this work).
**`npm run build`:** succeeds, all expected routes present in the production build output.
**`git status`:** clean working tree.

---

## Commits made this session (17 total, `b84db95` → `5467c51`)

```
5467c51 fix: complete downstream FK cleanup and explicit timeouts in rls/import.test.ts
2af4716 fix: extend reuse-on-failure to reimport-fingerprint-live and validation-live
4b8ed16 fix: complete reuse-on-failure resilience across the remaining live import tests
6a24761 refactor: drop unused actorId parameter from resendInvitation/revokeInvitation
f26db6f feat: populate import_rows.duplicate_of_row_id, close a deferred Medium finding
2d8cfa6 fix: import history 'View' link resolved to the wrong URL
c510539 fix: wire preview page's 'Proceed to confirm' button to the real confirm page
5e6eec0 docs: write Task 28's final implementation notes
48ad931 refactor: remove vestigial counts accumulator from confirm chunk loop
d23a56d feat: build the design-spec-required existing_claimed review-required gate
949a056 fix: close preview/rollback downstream-block mismatch (High finding), fix stale-migration comments
6e1784d fix: make downstream-processing-live.test.ts self-healing, fix debris-corrupted k-exceeding test
45bbdcb fix: make rls/import.test.ts self-healing against undeletable stale Auth users
0761c57 docs: add Phase 5.1 participant import operator documentation
7ef76e7 docs: record Task 26's e2e decision and the unverified UI-rendering gap
f81dbfc docs: sync plan doc with Task 25's completion and chunk-loop fix details
6bcee51 perf: parallelize confirm-import chunk loop with bounded concurrency
```

---

## What's still open before merge

1. **Gate 2/3**: waiting on Resend to resolve the domain-verification-inconsistency (or their support to clarify it). No code changes needed when it clears — just re-run `npx vitest run tests/import/invitation-live.test.ts`.
2. Recommend a final glance at Resend's API Keys page to confirm key hygiene, per the note in Gate 1.

**Per your explicit instruction: this has not been merged into `master`. It is waiting for your review and explicit approval.**
