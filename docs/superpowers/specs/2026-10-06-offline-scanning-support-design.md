# Offline Scanning Support (5b) — Design Spec

Sub-project 5b of the 6-part COY21 platform decomposition. Depends on nothing merged after 5a (live operations dashboard, merged to `master`). Deferred from 5a's scope explicitly — see `docs/superpowers/specs/2026-10-05-ops-dashboard-design.md`'s Out of Scope section.

## Problem

The scanner app (`src/components/scanner/scanner-client.tsx`) is currently strictly online-only: `use-network-status.ts` wraps `navigator.onLine` and the browser's `online`/`offline` events, and the client short-circuits every submit attempt while offline — it never even calls the server. A failed network call is bucketed into a three-way taxonomy (`offline-blocked`, `uncertain`, `server`) purely for operator-facing messaging; there is no retry, no queue, no persistence of any kind.

Two prior specs (`2026-07-31-flexible-admission-qr-attendance-design.md`, twice) flagged this as a known gap and established one hard constraint for any future offline design: **no local "optimistic" admission that could double-admit on reconnect.** That constraint rules out a real offline queue with a deferred/pending admission decision — a queue would either have to show operators a fake "pending" state (defeating a live door check) or make a local decision the server hasn't confirmed (exactly what's forbidden).

The real risk this sub-project addresses is narrower and more precise than "no internet": **a request that actually reached the server and succeeded, but whose response was lost to the client** (dropped connection mid-response, timeout, etc.). Today, a naive retry of that exact request would hit the server's own duplicate-admission detection and could show the operator a false rejection, denying someone who is, in fact, already correctly checked in.

## Scope Decision

**Build:** client-side auto-retry on top of the existing online-only architecture, protected by server-side idempotency keys so a lost response can never produce a wrong outcome (neither a double-admission nor a false rejection).

**Do not build:** any offline queue, any local admission decision, any "pending sync" state visible to the operator. The existing online-only architecture in `use-network-status.ts`/`scanner-client.tsx` is extended, not replaced.

## Architecture

### Two independent idempotency mechanisms

The two admission paths write to different tables and return different shapes, so each gets its own idempotency key on the table it actually writes to — not a shared mechanism forced across both:

- **QR scan path** (`scan_qr_attempt_transactional`, delegating to `scan_attempt_transactional`): every branch inserts exactly one `scan_attempts` row and returns the full row. Gets `scan_attempts.idempotency_key` (`uuid`, nullable, unique index) plus `scan_attempts.token_hash` (`bytea`, nullable) — the latter exists solely to detect idempotency-key reuse against a *different* QR (a client bug, not a legitimate retry), never to re-derive admission logic.
- **Walk-in path** (`admit_walk_in`): writes to `session_bookings` and `attendance_records`, returns only a `booking_id` (`uuid`). Gets `session_bookings.idempotency_key` (`uuid`, nullable, unique index). No `scan_attempts` row is written for walk-ins today, and this sub-project does not change that.

Both keys are nullable so existing rows are unaffected, and Postgres's unique index semantics (NULL values never conflict with each other) mean historical NULL rows impose no constraint.

### Server-side idempotency check (both functions, same pattern)

At the very top of the function body, before any other check:

1. **Key already used, same input** (QR: `token_hash` matches the stored row's; walk-in: `application_id`+`session_id` match): return the existing row/value immediately. No re-execution of capacity checks, eligibility checks, or any other logic — the operation already happened.
2. **Key already used, different input** (e.g. the exact same idempotency key presented with a different QR hash): raise a distinct error (`'Idempotency key reused with different scan data'`). This is a client bug signal, never silently resolved by returning stale data for a different request.
3. **Key not yet used**: proceed with all existing logic unchanged, writing the key (and `token_hash`, for QR) into the final insert.
4. **Race handling**: wrap the insert in `begin ... exception when unique_violation`. On that exception, re-fetch and return the row that won the race — not an error. Two concurrent requests carrying the same key are the same logical operation, not a genuine conflict (contrast with the existing `join_waitlist` unique_violation handler, which re-raises the same rejection message because that case is two *different* operations racing — a meaningfully different situation this sub-project must not copy by pattern-matching alone).

### Client-side key lifecycle

`scanner-client.tsx` generates one `crypto.randomUUID()` per new scan event (a fresh QR decode, or a fresh walk-in form submission) and reuses that exact UUID across every automatic retry of that same attempt. Cancelling an in-flight retry and re-scanning the same ticket is a new scan event — new key, new attempt, full re-execution of admission logic. If the first attempt had actually succeeded before the cancel, the retried attempt correctly surfaces today's existing `duplicate` result (`"Already Checked In"` / `"This participant has already been admitted to this session"` — no new message needed, this result path already exists and already fits).

### Health-check mechanism

A new server action (not a public HTTP endpoint), reached through the same trust boundary and service-role client as `scanQrAttemptConfirm`, running a trivial real round-trip against the actual database (e.g. `select 1 from scan_attempts limit 0`). This deliberately exercises the same path a real scan submission would use — a generic "is the server up" ping could return healthy while the database itself is unreachable, causing a retry to fail again immediately.

### Client-side retry state machine

Replaces today's single `offline-blocked` short-circuit with a new `retrying` state:

- On submit failure (offline-detected OR a real network call that fails for any reason — never trusting `navigator.onLine` alone, since it's unreliable and can misreport captive-portal/no-internet Wi-Fi as connected): enter `retrying`, keep the same idempotency key, start the health-check poll at ~2s intervals backing off to a 10s ceiling.
- Health-check success → immediately re-attempt the real submission with the same key.
- Browser `online` event fires → immediately trigger a health-check attempt, don't wait for the next poll tick.
- Manual "Try Now" button, available throughout `retrying` → same immediate-attempt trigger.
- At ~30s continuously in `retrying`: show a timeout message with "Try Now" and "Cancel" buttons. Background polling continues unchanged — the message is informational, not a stop.
- "Cancel" stops the retry loop, discards the idempotency key, returns to `ready`.
- **Single-flight guard**: while a scan is in-flight or `retrying`, new camera decodes and manual-entry submissions are ignored until the current attempt resolves (success, clean failure, or cancel) — prevents overlapping keys/results from tangling on screen.

## Non-Goals

- No offline queue, no local admission decisions, no "pending" status shown to operators.
- No change to `admit_walk_in`'s return shape (still `uuid`) or to `scan_attempts`'s non-involvement in the walk-in path.
- No change to the PWA shell (`manifest.ts`, `sw.js`, `install-guidance.tsx`) — those remain scoped to static-asset caching/installability, untouched by this sub-project, per the existing explicit comments in that code.
- No retry/idempotency protection added to any other admission-adjacent RPC beyond `scan_qr_attempt_transactional` and `admit_walk_in` (e.g. the admission-review override path is out of scope).

## Testing Requirements

1. A QR scan that times out mid-request, retried with the same idempotency key, returns the exact same result as the original attempt (not a re-execution) — covering both an `admitted` first attempt and an `invalid_qr`/`duplicate`/`full` first attempt.
2. A walk-in admission that times out mid-request, retried with the same idempotency key, returns the same `booking_id` without creating a second `session_bookings` row.
3. The same idempotency key presented with a different `token_hash` (QR path) raises the distinct mismatch error, not a stale result.
4. Two concurrent requests with the same idempotency key (simulated race) both resolve to the same row/value, with no unhandled `unique_violation` surfacing to either caller.
5. Cancelling a `retrying` scan and re-scanning the same ticket produces a fresh idempotency key and, if the original attempt had already succeeded, correctly surfaces the existing `duplicate` result.
6. Client-side: single-flight guard rejects/ignores a second scan attempt while the first is in-flight or retrying (component-level test, not a live DB test).
