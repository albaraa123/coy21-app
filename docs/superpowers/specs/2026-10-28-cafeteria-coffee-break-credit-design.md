# Cafeteria Coffee Break Credit (Phase 2) — Design

## Problem

Phase 1 (already built and live) gives eligible participants a QR-based lunch credential (`cafeteria_credentials`), checked once-per-day for lunch admission. The organizing team wants a second, independent use for the exact same QR: a non-accumulating daily credit of 50 Turkish lira per person for coffee-break purchases, deducted in operator-entered amounts at a separate scan point, reset every calendar day.

## Scope

In scope:
- A new daily coffee-break credit of 50 TL per eligible person, reset at local midnight (Europe/Istanbul), never carried over.
- Eligibility: everyone already eligible for lunch (`delegate`/`volunteer` with `status=accepted` and `attendance_confirmation=confirmed`, or any `staff`/`super_admin` profile) **plus** `speaker` — the one participant type excluded from lunch but included here, per the organizing team's explicit decision.
- Reuse of the existing `cafeteria_credentials` QR/token — no second credential, no second QR code. The same code a person already has (or requests, if they haven't yet) for lunch works for coffee-break deductions too, the moment their type/role makes them eligible for either.
- A two-step scan flow at a new, separate scanner route (`/scanner/coffee`): scan the code (eligibility + live remaining-balance check, no deduction yet) → operator enters an amount → confirm (atomic deduction, with the same advisory-lock concurrency protection the lunch RPC already uses).
- Unlimited scans per day, as long as each individual deduction amount is `> 0` and `<=` the balance remaining at that moment. Requesting more than the remaining balance in one deduction is rejected outright — no partial deduction.

Out of scope (explicitly deferred):
- Any aggregate/accounting report (e.g. total TL deducted per day, for vendor reconciliation) — the `cafeteria_coffee_scans` table records every deduction with its amount, so such a report can be built later purely as a read against existing data, with no schema change needed when that day comes.
- Actually setting `profiles.role = 'staff'` for anyone at CSV-import time — unrelated, already-deferred work from a separate feature (delegate/volunteer CSV import).
- Any change to the lunch flow, `cafeteria_lunch_scans`, or `cafeteria_lunch_scan_transactional` — this feature is purely additive alongside it.

## Eligibility

```
isCoffeeEligible(application, profile) =
  isLunchEligible(application, profile)  // existing function, unchanged
  OR (application.participant_type == 'speaker'
      AND application.status == 'accepted'
      AND application.attendance_confirmation == 'confirmed')
```

Implemented as a new function, `isCoffeeEligible`, in `src/lib/cafeteria/eligibility.ts` (same file as the existing `isLunchEligible`, which it calls rather than duplicates) — not a modification to `isLunchEligible` itself, since lunch eligibility's own rule (delegate/volunteer/staff only, no speaker) does not change.

## Data Model

```sql
create table cafeteria_coffee_scans (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid not null references cafeteria_credentials(id) on delete cascade,
  scanned_by uuid references profiles(id) on delete set null,
  scanned_at timestamptz not null default now(),
  scan_date date not null, -- Europe/Istanbul calendar date, server-computed, never client-supplied -- identical convention to cafeteria_lunch_scans.scan_date
  amount_deducted numeric(10,2), -- null unless result = 'deducted'
  result text not null check (result in ('deducted', 'insufficient_balance', 'ineligible', 'invalid_qr')),
  constraint cafeteria_coffee_scans_amount_only_when_deducted check (
    (result = 'deducted' and amount_deducted is not null and amount_deducted > 0) or
    (result <> 'deducted' and amount_deducted is null)
  )
);
```

No new column on `cafeteria_credentials` — the same credential row serves both lunch and coffee-break purposes; this table is additive, parallel to `cafeteria_lunch_scans`, keyed the same way (`credential_id`).

**Remaining balance is never stored** — it's derived live:

```sql
50 - coalesce(
  (select sum(amount_deducted) from cafeteria_coffee_scans
   where credential_id = :id and scan_date = :today and result = 'deducted'),
  0
)
```

This avoids any stored-balance/actual-deductions divergence risk and matches this codebase's existing preference (seen in the lunch flow) for deriving state from the append-only scan log rather than maintaining a separate mutable counter.

RLS: `enable row level security` with **no client-facing policy at all** — identical posture to `cafeteria_lunch_scans` (written exclusively by the new RPC via the service-role client, which already has full privileges via the existing `alter default privileges ... grant all on tables to service_role` rule; no explicit grant needed, confirmed by the same reasoning already verified for every table in the Phase 1 migration).

## Scan Flow — Two RPCs, Not One

Lunch's flow is a single scan-and-decide RPC because there's nothing to collect from the operator. Coffee-break needs the operator to see the remaining balance *before* choosing an amount, so this is two separate calls:

**1. `cafeteria_coffee_check_balance(p_token_hash bytea)` — read-only, no write.**
Resolves the credential (same `invalid_qr` handling as the lunch flow: an unresolvable hash is handled by the caller library before this RPC is ever invoked, not inside it), re-checks eligibility live (never trusts issuance-time state, same principle as the lunch RPC), and returns the eligibility result plus the live remaining balance for today. No row is written by this call — it's purely informational, so a device re-scanning the same code twice while an operator is deciding on an amount never double-counts or creates spurious audit rows.

**2. `cafeteria_coffee_deduct_transactional(p_token_hash bytea, p_scanned_by uuid, p_amount numeric)` — the actual write.**
Mirrors `cafeteria_lunch_scan_transactional`'s concurrency pattern exactly: `pg_try_advisory_xact_lock` keyed per-credential (bounded retry loop, same 20-retry/50ms-sleep/`LOCK_CONTENTION:` shape), re-checks eligibility live inside the lock (not trusting the balance-check call's earlier read, since time has passed and another device could have deducted in between), re-derives the remaining balance *inside the lock*, and:
- if `p_amount <= 0`: this is a caller-library-level validation error, never reaches the RPC (mirrors how a malformed/zero token_hash is rejected before the lunch RPC today) — the RPC itself can additionally guard this defensively, same reasoning as the lunch RPC's defensive bare-raise branches for a condition the caller already prevents.
- if ineligible: insert a `result='ineligible'` row (no amount), return that.
- if `p_amount > remaining_balance`: insert a `result='insufficient_balance'` row (no amount — rejected in full, not partially honored), return that.
- otherwise: insert a `result='deducted'` row with `amount_deducted = p_amount`, return that.

Two RPCs (not one combined call) specifically because the UI needs a round-trip in between — scan, display balance, THEN collect the amount — and collapsing that into one call would force the amount to be guessed or entered blind before the operator even knows if the person is eligible or has enough balance left.

## Library Code

`src/lib/cafeteria/coffee-scan.ts` — mirrors `src/lib/cafeteria/lunch-scan.ts`'s shape exactly: resolve the credential from the QR payload first (so an unresolvable token never reaches either RPC, consistent with the lunch flow's existing design), using the same `toByteaHex` convention this codebase already has four copies of (not consolidated here — out of scope, already flagged as a deferred cleanup in the Phase 1 code review).

Two exported functions:
- `checkCafeteriaCoffeeBalanceForCaller(params: { qrPayload: string }, caller): Promise<CoffeeBalanceResult>` — calls the balance-check RPC.
- `confirmCafeteriaCoffeeDeductionForCaller(params: { qrPayload: string; amount: number }, caller): Promise<CoffeeDeductionResult>` — calls the deduction RPC.

Both return the same `invalid_qr` shape the lunch flow uses when the credential can't be resolved at all, for UI consistency.

## API Routes

Two thin Route Handlers, mirroring `src/app/api/cafeteria-scan/route.ts`'s shape exactly (same `requireScannerDeviceCaller()` auth, same always-200-with-`{ok,...}`-body convention):
- `src/app/api/cafeteria-coffee-balance/route.ts` — POST `{ qrPayload }` → balance-check result.
- `src/app/api/cafeteria-coffee-deduct/route.ts` — POST `{ qrPayload, amount }` → deduction result.

## UI — `/scanner/coffee`

New route (`src/app/[locale]/scanner/coffee/page.tsx`), same auth-gated pattern as the existing `/scanner` and `/scanner/cafeteria` pages, nested under the existing `scanner/layout.tsx` — no new layout.

New client component (`src/components/scanner/cafeteria-coffee-scanner-client.tsx`), reusing `useQrScanner` exactly as `cafeteria-scanner-client.tsx` does (including its camera stop/restart fix — this is a new component, not a copy-paste of the old pre-fix version). Flow:
1. Camera active, scanning.
2. On decode: stop the camera (same fix as the lunch scanner — never leave the camera running while showing a result, to avoid the exact duplicate-resubmission bug found and fixed in Phase 1), call the balance-check endpoint.
3. Display: participant eligible + remaining balance, OR an ineligible/invalid-QR message (translated, same `scanner.cafeteria.result.*`-shaped i18n convention, new keys under `scanner.cafeteria.coffee.*`).
4. If eligible with balance > 0: show a numeric amount input (operator types the TL amount) + a confirm button.
5. On confirm: call the deduction endpoint with the entered amount, display the result (deducted — show new remaining balance; insufficient balance — show the attempted amount vs. actual remaining; error).
6. "Scan next" button restarts the camera, same pattern as the lunch scanner.

If eligible but balance is already 0 (used up for the day): skip the amount-input step entirely, show a "no balance remaining today" message directly — no point offering an input that can only fail.

## My QR Code Page — Widened Gating for Speakers

**Resolved (not left open):** the existing "Cafeteria QR" card on My QR Code is currently gated on `isLunchEligible`, which `speaker` fails — meaning a speaker (coffee-eligible but not lunch-eligible) would never see the card and could never self-serve a credential. The card's gating condition changes from `isLunchEligible(application, profile)` to `isCoffeeEligible(application, profile)` (which is a strict OR-superset: everyone currently shown the card under `isLunchEligible` continues to see it, since `isCoffeeEligible` includes `isLunchEligible` as one of its two branches — nobody currently eligible loses visibility).

The card's copy must also be corrected to not unconditionally say "lunch" for someone who is only coffee-eligible (a speaker). The instruction/subtitle text becomes conditional on which eligibility branch actually applies:
- Lunch-eligible (regardless of coffee eligibility, i.e. delegate/volunteer/staff): existing copy, unchanged — "Present this QR at the cafeteria for lunch, once per day." (plus, once Phase 2 ships, it's also valid for coffee breaks, but Phase 1's copy already doesn't mention coffee and this spec doesn't require rewriting it just for this — out of scope unless the team wants the copy to explicitly mention both uses).
- Coffee-only eligible (speaker): new copy needed, e.g. "Get your QR code for coffee breaks." — added as a new i18n key (`myQr.cafeteria.instructionCoffeeOnly` or similar; exact key naming left to the implementation plan), not overloading the existing `instruction` key with conditional logic baked into translation files.

This requires `src/app/[locale]/(participant)/(shell)/my-qr/page.tsx` to also read whatever `isCoffeeEligible` needs (same `participant_type`/`status`/`attendance_confirmation`/`profiles.role` shape `isLunchEligible` already reads — no new query fields, since `isCoffeeEligible` is a pure function of the same inputs) and pass a richer eligibility signal (not just a boolean) down to `MyQrClient` so it can pick the right copy variant.

## Testing

- Unit tests for `isCoffeeEligible`: speaker+accepted+confirmed → true; speaker+not confirmed → false; every case already covered by `isLunchEligible`'s own test suite, re-asserted true here too (delegate/volunteer/staff) to prove the OR composition doesn't accidentally narrow anything.
- Live tests for `cafeteria_coffee_check_balance`: fresh credential → 50 remaining; after one deduction → reduced correctly; next calendar day (if testable) → resets to 50; ineligible credential → ineligible result, no balance exposed.
- Live tests for `cafeteria_coffee_deduct_transactional`: a deduction within balance succeeds and the row records the right amount; a deduction exceeding remaining balance is rejected in full (verify no partial-amount row was written); two concurrent deductions that together exceed the balance resolve to exactly one succeeding and one `insufficient_balance` (real `Promise.all`-based concurrency test, mirroring the lunch RPC's own concurrency test); an ineligible credential is rejected regardless of amount.
- Manual verification (deferred to a combined pass with the rest of this feature, same convention as Phase 1): the full scan → balance → amount → confirm UI flow in a real browser with a real camera.
