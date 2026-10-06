# Offline Scanning Support (5b) — Design Spec

Sub-project 5b of the 6-part COY21 platform decomposition. Depends on nothing merged after 5a (live operations dashboard, merged to `master`). Deferred from 5a's scope explicitly — see `docs/superpowers/specs/2026-10-05-ops-dashboard-design.md`'s Out of Scope section.

## Problem

The scanner app (`src/components/scanner/scanner-client.tsx`) is currently strictly online-only: `use-network-status.ts` wraps `navigator.onLine` and the browser's `online`/`offline` events, and the client short-circuits every submit attempt while offline — it never even calls the server. A failed network call is bucketed into a three-way taxonomy (`offline-blocked`, `uncertain`, `server`) purely for operator-facing messaging; there is no retry, no queue, no persistence of any kind.

The walk-in admission page (`src/app/[locale]/(admin)/attendance/walk-in/`) has no network-status awareness at all today — no offline detection, no retry, nothing. It's a separate admin page (staff-only, `requireAdmissionStaffCaller`), not part of the scanner flow, and is addressed as its own track below rather than conflated with the scanner.

One prior spec (`2026-07-31-flexible-admission-qr-attendance-design.md`, lines 17, 298, 347) flagged offline behavior as a known, explicitly deferred gap, anticipating a future "PWA offline-queue/sync" follow-up spec, and established one hard constraint any such design must preserve: **no local "optimistic" admission that could double-book on reconnect.** That source does not itself forbid a queue — it only forbids a queue (or any design) making a local admission decision the server hasn't confirmed. This spec's choice to build auto-retry instead of a queue is **this spec's own scope decision**, made because a queue gains nothing here (see Scope Decision below), not something the earlier spec mandates.

**The actual failure modes, verified against current code, are asymmetric between the two admission paths:**

- **QR path**: a naive retry after a lost response already resolves safely today. `scan_attempt_transactional` is idempotent in effect — a retried scan of an already-admitted ticket returns `result: 'duplicate'`, which `result-presentation.ts` renders as `severity: 'attention'` ("informational, not an error — they're already in"), not a rejection. Idempotency keys for this path are a UX/efficiency improvement (skip re-running the full decision tree, restore the original `admitted`/`flexible_admitted` result and participant summary instead of a generic `duplicate`), not a correctness fix for a false rejection.
- **Walk-in path**: a naive retry after a lost success genuinely produces a false rejection today. `admit_walk_in`'s pre-insert check (`'This participant already has a booking for this session'`) fires before reaching any uniqueness constraint, so a retried walk-in of an already-admitted participant raises a hard error with no idempotent fallback. **This is the one genuine correctness bug this spec exists to fix**, and the walk-in design below must close it precisely.

## Scope Decision

**Build:** client-side auto-retry for both the scanner and the walk-in admin page, each on top of its own existing architecture, protected by server-side idempotency keys so a lost response can never produce a wrong outcome (double-admission, or — walk-in specifically — a false rejection of an already-admitted participant).

**Do not build:** any offline queue, any local admission decision, any "pending sync" state visible to the operator, any change to the PWA shell (`manifest.ts`, `sw.js`, `install-guidance.tsx` stay untouched — those remain scoped to static-asset caching/installability per their own existing comments).

## Architecture — Server Side

### Two independent idempotency mechanisms, on the tables each function actually writes to

- **QR scan path**: `scan_attempt_transactional` (the function that actually performs every insert — `scan_qr_attempt_transactional` is a thin bridge that delegates to it, see Signature Changes below) inserts exactly one `scan_attempts` row per call in the common case, but has two exception paths that insert nothing at all (advisory-lock-exhausted at line 142-144 of `20261006050000_walk_in_admission.sql`, and scanner-scope-revoked at line 160-162) — both `raise exception`, propagating as a thrown error. Gets `scan_attempts.idempotency_key` (`uuid`, nullable, unique index) plus `scan_attempts.scan_fingerprint` (`bytea`, nullable — a derived fingerprint, not the raw credential hash; see Column Content below).
- **Walk-in path**: `admit_walk_in` writes to `session_bookings` and `attendance_records`, returns only a `booking_id` (`uuid`). Gets `session_bookings.idempotency_key` (`uuid`, nullable, unique index).

Both keys are nullable so existing rows and existing callers (the override path in `src/lib/attendance/admission-management.ts`, and `src/lib/attendance/scan-attempt.ts`'s non-QR scan path) are completely unaffected — every new parameter defaults to `null`, and a `null` key means "skip the idempotency check entirely, behave exactly as today." Postgres's unique index semantics (distinct `NULL`s never conflict) mean this requires no backfill and no behavior change for any caller that doesn't pass a key.

### Idempotency check placement — AFTER auth, AFTER the serialization point, not "at the very top"

This is the one point both admission functions must get right, and it differs by function because their serialization mechanisms differ:

**`admit_walk_in`** (current body: `20261006052000_admit_walk_in_shared_advisory_lock.sql`):
1. `is_staff()` check (line 41) — unchanged, runs first. An idempotency lookup must never run before authorization; returning a cached `booking_id` to an unauthorized caller would be a privilege leak.
2. Application-accepted check (line 45) — unchanged.
3. `select ... for update` on `sessions` (line 49) — unchanged.
4. **New: idempotency key check goes here, immediately after the advisory lock (line 61) and before the capacity/duplicate-booking checks (line 71-89).** This is the fix for the race the naive design misses: if the key check only happened via a `unique_violation` catch around the final `session_bookings` insert (line 91-93), a concurrent retry with the same key would reach the pre-insert `'already has a booking'` check (line 77-82) first — once the original request has committed, that check fires and raises the exact false rejection this spec exists to prevent, never reaching the insert at all. Checking immediately after the lock means every retry with the same key sees the first request's committed row (under READ COMMITTED, once serialized by the lock) and returns it directly, never reaching the business checks that would misfire.
5. If a matching key exists: compare `application_id`+`session_id` against the stored row's. Match → return the stored `booking_id` immediately. Mismatch → raise `'Idempotency key reused with different admission data'`.
6. If no matching key: proceed with existing logic unchanged, write the key into the final `session_bookings` insert.
7. **Race backstop**: still wrap the `session_bookings` insert in `begin...exception when unique_violation`, re-fetching and returning the winning row's `booking_id` — this catches the narrow window between two callers both passing step 5's check before either commits (the advisory lock makes this exceedingly unlikely but not provably impossible across all PostgreSQL isolation behavior; defense in depth, matching this codebase's established `unique_violation`-catch convention).

**`scan_attempt_transactional`** (current body: `20261006050000_walk_in_admission.sql` lines 101-266):
1. Advisory lock acquisition loop (lines 135-144) — unchanged. If lock acquisition fails after retries, this raises an exception with no insert at all; a client-side retry of the *whole attempt* (not just the idempotency wrapper) is the correct response, since nothing was recorded (see Client-Side Error Classification below — this is a retryable error).
2. Scanner-scope re-check (lines 152-163) — unchanged, runs with the lock held. If scope was revoked, this raises `'Not authorized for this session/room'` with no insert. **Decision: the idempotency check runs AFTER this scope re-check, not before.** Rationale: replaying a completed admission to a scanner whose assignment was just revoked mid-shift should still surface the auth failure on retry attempts after revocation, not silently hand back a stale success — the scope check protects a real-time security boundary, and an idempotent replay must not bypass it.
3. **New: idempotency key check goes here**, immediately after the scope re-check, before the application/session lookup (line 165) and before any part of the admission-decision tree.
4. If a matching key exists: compare the stored row's `scan_fingerprint` against the incoming fingerprint using `is not distinct from` (not `=` — see Mismatch Check Details below, this handles the malformed/unresolved-credential branches where the fingerprint input is legitimately `null`-derived), AND compare `session_id`. Match on both → return the stored row immediately (no re-execution of the decision tree, no second `attendance_records` insert). Mismatch on either → raise `'Idempotency key reused with different scan data'`.
5. If no matching key: proceed with existing logic completely unchanged through the full decision tree (lines 165-258).
6. **The final insert at lines 260-262 is the only place the key is written** — this is also where the C2 orphan-admission race is closed: because the idempotency check in step 4 already ran (with the lock held) before any of the decision tree's reads happened, a second caller with the same key physically cannot reach the decision tree at all once the first caller has committed. The lock serializes same-key requests completely; the lock is never released between the key check and the final insert, so there is no window for a second caller to read stale state, compute a different decision, and insert a second `attendance_records` row. The `unique_violation` catch around the final insert (new, wrapping lines 246-262) exists only as a backstop for the narrow pre-lock race (two callers both fail to find an existing key before either acquires the lock) — not as the primary mechanism, unlike a naive design that relies on it alone.
7. **The two unresolved-credential early-return branches in `scan_qr_attempt_transactional`** (malformed hash, no active credential match — lines 291-306 of the file, which insert directly rather than delegating to `scan_attempt_transactional`) need their own, independent idempotency check and insert, since they never reach `scan_attempt_transactional`'s lock at all. They take no advisory lock today and don't need one added — each is a single, unconditional insert, so the insert-level `unique_violation` catch alone is sufficient there (no decision tree to protect from double-execution, since there is no decision — it's an unconditional `invalid_qr`).

### Signature changes

- `scan_attempt_transactional(p_application_id, p_session_id, p_scanned_by, p_device_identifier, p_time_slot_group_key, p_is_override_caller default false, p_scanner_user_id default null, p_idempotency_key uuid default null, p_token_hash bytea default null)` — two new trailing optional parameters, both defaulting to `null`. `p_token_hash` is accepted here (not only in the wrapper) because the idempotency check and the final insert both need it, and both live in this function per the placement rules above.
- `scan_qr_attempt_transactional(..., p_idempotency_key uuid default null)` — one new trailing parameter, forwarded straight through to `scan_attempt_transactional` alongside the `p_token_hash` it already has from its own existing parameter list. Its own two unresolved-credential branches use `p_idempotency_key` directly for their own independent check (point 7 above).
- `admit_walk_in(p_application_id, p_session_id, p_idempotency_key uuid default null)` — one new trailing parameter.
- Every signature change needs: `drop function if exists` on the old arity (matching this codebase's established precedent in `20261006050000_walk_in_admission.sql` lines 98-99), the full `revoke`/`grant` restatement these functions already carry, and regenerating `src/types/database.ts` afterward.
- **Existing callers unaffected**: `src/lib/attendance/scan-attempt.ts`'s direct (non-QR) scan path, and `src/lib/attendance/admission-management.ts`'s override-admission path, both call `scan_attempt_transactional` without the new parameters today and must continue to compile/work unchanged — passing `null` for both new parameters is the default, so no call-site change is required there. This sub-project touches only `scan-qr-attempt.ts`'s call site and the walk-in action.

### Mismatch check details

- Use `is not distinct from` for the stored `scan_fingerprint` comparison, never `=` — the malformed-payload branch passes `p_token_hash = null` today (`scan-qr-attempt.ts`), which feeds into a fingerprint computed from a `null` input, and `null = null` evaluates to `null` (neither true nor false) in SQL — comparing two such fingerprints under plain `=` would incorrectly fail a legitimate retry of a malformed-payload scan. `is not distinct from` treats equal fingerprints (including two both derived from `null`) as equal, exactly as intended.
- The comparison must include `session_id` as well as the fingerprint/`application_id` — a client bug that reuses a key across two different sessions is exactly the kind of misuse this check exists to catch, which the fingerprint alone wouldn't detect (it's already derived including `session_id`, per the Column Content section below, but the check should compare `session_id` explicitly too for clarity rather than relying solely on the fingerprint's own construction).

### Column content — `scan_attempts.scan_fingerprint` is a derived fingerprint, not the raw credential hash

`scan_attempts` already has broader read access than `qr_credentials` (`scan_attempts_scanner_select`/staff policies grant read access to scanner-device and staff roles; `qr_credentials` access is far narrower). Storing the raw `token_hash` value on every `scan_attempts` row would copy credential-lookup material into a more widely readable table purely for an idempotency-mismatch check that doesn't need the real hash — it only needs *something* that changes if the QR changes. Store a derived fingerprint instead: `digest(coalesce(p_token_hash, ''::bytea) || p_session_id::text, 'sha256')`, under a column named `scan_fingerprint bytea` (not `token_hash` — that name would misleadingly imply the real credential hash is stored), computed the same way in both the malformed-payload/unresolved-credential branches and the resolved-credential branch.

## Architecture — Client Side (Scanner)

### Retryable vs. non-retryable errors — the server action must return a typed result, not only throw

Today `scanQrAttemptConfirm` always throws on any failure, and the client treats every throw identically (bucketed by `navigator.onLine` state at catch time, per the existing `uncertain`/`server`/`offline-blocked` taxonomy). This is insufficient for auto-retry: a deterministic server-side rejection (scope revoked, session expired, the new idempotency-mismatch error) would loop forever if blindly retried, because the health check succeeds (the server is genuinely up) while the actual submission keeps failing for a reason retrying can never fix.

**Change**: `scanQrAttemptConfirm` (and the walk-in action) distinguish two failure categories explicitly, since Next.js Server Actions sanitize thrown error messages in production builds (matching on `err.message` text is not reliable):
- **Transport failure** (the fetch/RPC call itself never completed — network drop, timeout): still surfaces as a thrown error from the underlying call, but the catch site below infers retryability from the browser's live state (see Client Retry Loop below) rather than the error's content.
- **Server-rejected** (the call completed; the server explicitly rejected it for a reason retrying cannot fix: auth/scope failure, the new idempotency-mismatch error, `'Session not found'`, etc.): the server action catches the RPC's own `{ data, error }` shape at the call site and returns a typed `{ retryable: false, message: string }` result instead of throwing, so the client can distinguish "stop retrying, show this clearly" from "transport issue, keep trying."
- The one exception already correctly retryable today: `'Another scan for this session is still being processed after N retries'` (the advisory-lock-exhausted case) — this is transient contention, not a deterministic rejection, and should be classified `retryable: true` despite being a server-side error.

### New scanner state: `retrying`

`scan-state-machine.ts` gains a new state variant and transitions, following its existing pure-reducer, zero-dependency convention (testable the same way `scan-state-machine.test.ts` already does):

```typescript
ScanState:
  | { kind: 'ready' }
  | { kind: 'detected'; qrPayload: string }
  | { kind: 'submitting'; qrPayload: string; idempotencyKey: string }
  | { kind: 'retrying'; qrPayload: string; idempotencyKey: string; startedAt: number }
  | { kind: 'result'; result: ScanQrResultLike }

ScanAction additions:
  | { type: 'SUBMIT_TRANSPORT_FAILURE' }   // from 'submitting' -> 'retrying'
  | { type: 'SUBMIT_REJECTED'; message: string }  // from 'submitting' -> 'ready', non-retryable, shows message
  | { type: 'RETRY_ATTEMPT' }              // 'retrying' -> 'submitting', same idempotencyKey/qrPayload
  | { type: 'CANCEL_RETRY' }               // 'retrying' -> 'ready', discards the key
```

- `idempotencyKey` is generated once via `crypto.randomUUID()` on `SUBMIT_START` (not on `DETECT`), and carried unchanged through every subsequent `submitting`/`retrying` transition for that same scan event. `CANCEL_RETRY` or reaching `result` both end the key's lifetime — a fresh `DETECT`/`SUBMIT_START` cycle (new scan, or re-scan after Cancel) always generates a new key.
- The existing single-flight guarantee (`DETECT` is a no-op unless `state.kind === 'ready'`) extends naturally: `retrying` and `submitting` are both non-`ready`, so camera decodes and manual-entry submissions are already ignored while either is active — no new guard code needed beyond adding the new states to the existing "not ready" check, which is how the reducer already behaves for any unlisted state via its default no-op branches.

### Client retry loop (lives in `scanner-client.tsx`, alongside the existing submit-handling effect)

- On `SUBMIT_TRANSPORT_FAILURE`: enter `retrying`, start the health-check poll at a 2s interval, doubling up to a 10s ceiling (2s, 4s, 8s, 10s, 10s, ...).
- Each poll tick calls a new, dedicated health-check server action (see below). On success: immediately dispatch `RETRY_ATTEMPT` (re-invoking `scanQrAttemptConfirm` with the same `qrPayload`/`idempotencyKey`), resetting the poll interval back to 2s for any *subsequent* failure of this same retry cycle.
- Listen for the browser's `online` event while in `retrying`: on fire, immediately run one health-check attempt out-of-cycle (don't wait for the next poll tick).
- A visible "Try Now" button, active throughout `retrying`, triggers the same immediate health-check-then-retry path.
- **Client-side submission timeout**: race every `scanQrAttemptConfirm` call against a timer (e.g. 8s) using `Promise.race` — a hung request (connected but never responding, plausible on flaky venue Wi-Fi) must not leave the UI stuck in `submitting` indefinitely. A timeout is treated as a transport failure (→ `retrying`), not a rejection.
- **Stale-response guard**: since `CANCEL_RETRY` can fire while a `RETRY_ATTEMPT`'s promise is still in flight, the resolved/rejected callback must check that the idempotency key it started with still matches the current state's key before dispatching `SUBMIT_SUCCESS`/`SUBMIT_REJECTED`/`SUBMIT_TRANSPORT_FAILURE` — otherwise a late response arriving after Cancel (or after a newer scan has already started, which single-flight should prevent, but a cancel-then-immediately-rescan sequence is still possible) could render against the wrong UI state.
- At 30 continuous seconds in `retrying` (tracked via `startedAt`): show a persistent message with "Try Now" and "Cancel" buttons. The background poll loop is NOT paused or altered by showing this message — it is purely informational, continuing to retry silently was the original problem being fixed, not something to preserve.
- "Cancel" dispatches `CANCEL_RETRY`, stopping the poll loop (clear the interval/timeout refs) and discarding the idempotency key. A subsequent scan of the same ticket is a new scan event with a new key; if the original attempt had actually succeeded before the cancel, the new attempt correctly surfaces the server's own `'duplicate'` result (already-existing, already-correct UX — `"Already Checked In"` / `"This participant has already been admitted to this session"`, no new message needed for this specific case).

### Health-check mechanism

A new server action, reached through the same trust boundary (`requireScannerDeviceCaller`) and service-role client as `scanQrAttemptConfirm`, performing one trivial real round-trip against the database — e.g. `service.from('scan_attempts').select('id', { head: true }).limit(0)` (head request, no row data transferred) — deliberately exercising the same authenticated path a real scan would use, not a generic "is the server reachable" ping that could return healthy while the database itself is unreachable or the caller's session has expired.

- If the caller's scanner session has itself expired (`requireScannerDeviceCaller` fails), the health check fails every time — this is correct (retrying can't fix an expired session), and must be visible to the operator as a distinct message from a generic connectivity failure, not silently retried forever. This case should surface the same non-retryable path as a `SUBMIT_REJECTED` with the auth failure, breaking out of the retry loop rather than polling it indefinitely.

## Architecture — Client Side (Walk-In Admin Page)

The walk-in form (`walk-in-admission-form.tsx`) has no network-status awareness today and needs its own, simpler retry treatment — it is not part of the scanner's state machine or component tree.

- `admitWalkIn` gains an `idempotencyKey` parameter, generated via `crypto.randomUUID()` once per form submission attempt (on the initial submit, not per retry), threaded into the `admit_walk_in` RPC call.
- On a transport-shaped failure (the `{error}` string result's underlying cause was a network failure, not a server rejection — same retryable/non-retryable distinction as the scanner, but simpler since this form has no camera/single-flight concerns): show a "Connection lost — retrying…" state with the same "Try Now"/"Cancel" affordances as the scanner, reusing the same idempotency key across retries of this one submission.
- A separate, simpler health-check reuse: since this page's caller is `requireAdmissionStaffCaller`, not `requireScannerDeviceCaller`, it cannot share the scanner's health-check action directly (different auth boundary). Add a second, near-identical health-check server action scoped to admission-staff auth, following the exact same "real round-trip through the real auth boundary" principle.
- No camera, no single-flight state machine needed — the existing `submitting` boolean plus a new `retrying` boolean on the form's local state is sufficient; this does not need the scanner's full reducer treatment.

## Non-Goals

- No offline queue, no local admission decisions, no "pending" status shown to operators, on either the scanner or the walk-in page.
- No change to `admit_walk_in`'s return shape (still `uuid`/`booking_id`) beyond adding the new optional parameter.
- No change to the PWA shell (`manifest.ts`, `sw.js`, `install-guidance.tsx`).
- No idempotency protection added to `src/lib/attendance/admission-management.ts`'s override-admission path or to `scan-attempt.ts`'s direct (non-QR) scan path — both continue calling `scan_attempt_transactional` with the new parameters defaulted to `null`, fully unaffected by this sub-project.
- No retry/idempotency design for any RPC beyond `scan_attempt_transactional` (and its `scan_qr_attempt_transactional` wrapper) and `admit_walk_in`.

## Testing Requirements

1. A QR scan retried with the same idempotency key after the original committed (simulating a lost response) returns the exact same row (same `id`, same `result`) without a second `attendance_records` insert or a second `scan_attempts` insert — covering both an `admitted` first attempt and a `duplicate`/`full`/`invalid_qr` first attempt.
2. A walk-in admission retried with the same idempotency key after the original committed returns the same `booking_id` without a second `session_bookings` row and without raising `'already has a booking'`.
3. The malformed-payload branch (`token_hash` null) retried with the same idempotency key returns the same row, not an incorrect mismatch error (`is not distinct from` NULL-safety check).
4. The same idempotency key presented with a different `token_hash`+`session_id` (QR) or a different `application_id`+`session_id` (walk-in) raises the distinct mismatch error, never returning stale data for a different request.
5. **Walk-in concurrency**: two simultaneous `admit_walk_in` calls with the same idempotency key both resolve to the same `booking_id`, with no `'already has a booking'` false rejection on either side — this is the test that would have caught the original design's C1 gap, so it must simulate genuine concurrency (e.g. two parallel RPC calls from a test harness that doesn't serialize them client-side), not two sequential calls.
6. **QR concurrency with changing state**: two simultaneous `scan_qr_attempt_transactional` calls with the same idempotency key, where the session's admission state changes between when each call would have read it (e.g. seeded so the decision could plausibly differ if the lock didn't serialize them) — both resolve to the identical row, with exactly one `attendance_records` row and one `scan_attempts` row total, never an orphaned admission.
7. A non-staff caller presenting a previously-used, valid idempotency key to `admit_walk_in` still gets `'Not authorized'` (idempotency check never bypasses the `is_staff()` gate).
8. A scanner whose assignment was revoked between its original (committed) attempt and a retry with the same key gets `'Not authorized for this session/room'` on the retry, not the original cached success (idempotency check runs after, not before, the scope re-check).
9. Existing callers (`scan-attempt.ts`'s direct path, `admission-management.ts`'s override path) continue to work unchanged with no idempotency key passed (`null` defaults, zero behavior change) — a straightforward regression check, not new behavior.
10. Client (component-level, not live DB): a non-retryable server rejection (e.g. the new mismatch error, or a scope-revoked rejection) does not enter the `retrying` loop — it goes straight to a terminal error message, matching the state machine's `SUBMIT_REJECTED` transition.
11. Client (component-level): a late-arriving response for a superseded attempt (cancelled, or an idempotency key that no longer matches current state) is discarded, never rendered.
12. Client (component-level): `CANCEL_RETRY` followed by a fresh `DETECT`/`SUBMIT_START` on the same QR payload generates a new idempotency key (not a reuse of the cancelled one).
13. Client (component-level): the single-flight guarantee extends correctly to the new `retrying` state — a `DETECT` action while in `retrying` is a no-op, same as while `submitting`.
14. Walk-in form: a retried submission after a transport failure reuses the same idempotency key across all retries of that one submission.
