# Cafeteria Lunch QR — Design (Phase 1)

## Problem

Attendees get a discounted/free lunch at a university cafeteria, but only some of them are eligible. There's currently no way to check eligibility at the point of service — staff at the cafeteria have no way to verify who's allowed a meal without a manual list. This spec covers **lunch only** (a simple eligible/not-eligible, once-per-day check). A separate coffee-break credit system (a per-person daily spending balance) is an explicitly deferred Phase 2 — nothing in this spec should make Phase 2 harder to add later, but Phase 2's design is out of scope here.

## Eligibility

A person is lunch-eligible if either:

- They are a **participant** (`applications` row) with `participant_type in ('delegate', 'volunteer')`, `status = 'accepted'`, and `attendance_confirmation = 'confirmed'` — the same accepted-and-confirmed gate `qr_credentials` issuance already uses for the attendance QR, reused here rather than re-derived.
- They are **staff**: `profiles.role` is `staff` or `super_admin` (matches `isStaffRole`, `src/lib/auth/is-staff-role.ts`) — no per-person flag; eligibility is automatic for the whole role.

Not eligible (explicit, confirmed): `knowledge_partner`, `speaker`, `youngo` (no `youngo` participants exist yet; revisit if/when any are added — not blocking this phase). `scanner_device`-only accounts are not staff for this purpose (they're operating the scanner, not attending).

This is a single, small, well-named predicate — `isLunchEligible(application, profile)` in `src/lib/cafeteria/eligibility.ts` — used identically everywhere eligibility is checked (QR issuance, My QR Code card visibility, the scan RPC itself). No flags, no admin UI to manage eligibility in this phase: the rule is fixed role/type logic, matching the confirmed decision table exactly. (A later phase can add exceptions if the org ever needs them — not needed now.)

## Data model

Two new tables, deliberately independent of `qr_credentials`/`qr_lifecycle_operations`/`qr_bulk_operation_batches` (Phase 1 does not touch that schema at all — see "Why a separate credential" below).

```sql
create table cafeteria_credentials (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id) on delete cascade,
  profile_id uuid references profiles(id) on delete cascade,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_at timestamptz not null default now(),
  -- Exactly one of application_id/profile_id is set: a participant's
  -- credential is keyed to their application (consistent with
  -- qr_credentials' own application_id keying), a staff member's to
  -- their profile directly (staff have no applications row).
  constraint cafeteria_credentials_one_owner check (
    (application_id is not null and profile_id is null) or
    (application_id is null and profile_id is not null)
  )
);

create unique index cafeteria_credentials_application_idx on cafeteria_credentials (application_id) where application_id is not null;
create unique index cafeteria_credentials_profile_idx on cafeteria_credentials (profile_id) where profile_id is not null;

create table cafeteria_lunch_scans (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid not null references cafeteria_credentials(id) on delete cascade,
  scanned_by uuid references profiles(id) on delete set null,
  scanned_at timestamptz not null default now(),
  scan_date date not null, -- Europe/Istanbul calendar date at scan time, computed server-side
  result text not null check (result in ('admitted', 'already_used_today', 'ineligible', 'invalid_qr'))
);

create unique index cafeteria_lunch_scans_one_per_day on cafeteria_lunch_scans (credential_id, scan_date) where result = 'admitted';
```

`cafeteria_lunch_scans_one_per_day` is the actual once-per-day enforcement — a real unique constraint, not just application-level logic, so a race between two near-simultaneous scans of the same QR can't both succeed. `scan_date` is written by the server as `(now() AT TIME ZONE 'Europe/Istanbul')::date` at scan time, never client-supplied.

Non-`admitted` rows (denials) are still logged for the same audit-trail reason `scan_attempts` logs every attempt in the existing attendance system, but don't count against the one-per-day unique index (only `admitted` does), so a stale/invalid/ineligible scan attempt never blocks a later legitimate one.

### Why a separate credential, not a second row shape in `qr_credentials`

`qr_credentials` is a heavily-guarded, append-only audit table (`qr_credentials_enforce_lifecycle_trigger` structurally forbids `DELETE` and enforces a strict state machine for revoke/replace) built for a much higher-stakes problem: admission-credential forgery. Reusing it for lunch would mean either weakening those guarantees for a second purpose or satisfying its full lifecycle machinery (encryption envelope, key versioning, issuance-channel/actor validation) for a feature that doesn't need any of it. A separate, intentionally simpler table keeps the attendance system's guarantees untouched and keeps the cafeteria feature's code reviewable on its own terms.

### Token scheme

Simple hashed random token, not the attendance system's encrypted-envelope scheme (confirmed: lunch risk is "a stolen free lunch," not identity fraud/credential forgery — doesn't justify the attendance system's AES-GCM/key-rotation machinery). `crypto.randomBytes(32)` → SHA-256 hash stored in `token_hash`; the raw token (base64url-encoded, prefixed e.g. `cafe:v1:<token>`) is what's rendered into the QR image and is never stored in plaintext, mirroring the attendance system's own "never persist the raw bearer token" rule even though the encryption layer itself isn't reused. New small module `src/lib/cafeteria/token.ts` (generate, hash, canonical-encode/parse) — deliberately not added to `qr-token-crypto.ts`, which is scoped to the `rcoy:v1:` attendance format specifically.

`renderQrDataUri` (`src/lib/attendance/qr-image.ts`) is reused as-is — it's a pure `string -> PNG data URI` function with no attendance-specific coupling.

## Credential issuance

A `cafeteria_credentials` row is created lazily, the first time an eligible person's My QR Code page is loaded and no row exists yet for them — mirroring how the existing attendance QR is first issued (confirmed by this session's earlier reading of `getMyQrState`/`participant-qr.ts`: issuance-on-first-view, not a separate admin action). No bulk-issuance UI in Phase 1.

If a person becomes ineligible later (e.g. an application is un-confirmed), their existing `cafeteria_credentials` row is left in place (not deleted) — eligibility is re-checked at **scan time**, not issuance time, so a stale QR code naturally stops working the moment the person's underlying eligibility changes, with no cleanup job needed.

## UI — My QR Code page

A second card, "Cafeteria QR", added to `src/app/[locale]/(participant)/(shell)/my-qr/page.tsx`, rendered only when `isLunchEligible(...)` is true for the signed-in user. Not eligible → the card doesn't render at all (not shown-disabled) — matches how the rest of this codebase hides inapplicable UI rather than graying it out, and avoids ever showing a KP/Speaker a lunch-shaped control that will never work for them.

## UI — Cafeteria Scanner mode

New route `/[locale]/scanner/cafeteria`, parallel to the existing `/[locale]/scanner` (session-scoped) — not a mode switch inside the existing scanner shell, because the existing shell's whole structure (`loadScannerAssignmentContext`, `SessionSwitcher`) is built around "which session/room is this device authorized for," which has no meaning here. Auth gate: `isScannerDeviceRole` (`src/lib/validation/scanner-device.ts`), identical role set to the existing scanner (`scanner_device`, `super_admin`) — reused directly, not re-derived, since "who's allowed to operate a scanner device" doesn't change based on what's being scanned.

Flow: operator scans → client posts the raw payload to a new route handler → server parses/hashes the token, looks up `cafeteria_credentials`, re-checks eligibility live (not cached), checks today's `cafeteria_lunch_scans` for that credential, and returns one of:
- **Admitted** (green) — first scan today, eligible
- **Already used today** (amber) — eligible, but already scanned today
- **Not eligible** (red) — valid QR, but the person's current eligibility is false (e.g. KP, or a since-unconfirmed delegate)
- **Invalid QR** (red) — token doesn't match any known credential

Every outcome is written to `cafeteria_lunch_scans` (including denials), matching the attendance system's "always log the attempt" discipline.

## Server action / route shape

Mirrors `scan-qr-attempt.ts`'s existing split exactly: a `confirmCafeteriaLunchScanForCaller(params, caller)` pure function (unit-testable without a request context) called from a thin `'use server'`-boundary Route Handler that performs `requireScannerDeviceCaller`-equivalent auth first (new `src/lib/cafeteria/server-helpers.ts`, same shape as the other `require*StaffCaller` helpers in this codebase, just checking `isScannerDeviceRole` instead of a staff-domain role). New table `src/lib/cafeteria/lunch-scan.ts` holds the actual logic (parse token → hash → look up credential → check eligibility → check today's scan → insert scan row → return result), as a single RPC (`confirm_cafeteria_lunch_scan_transactional` or similar) so the "check + insert" is atomic under the unique index, the same reasoning `scan_qr_attempt_transactional` already uses for the attendance path.

## Testing

- `isLunchEligible` unit tests: every `participant_type` × `status` × `attendance_confirmation` combination relevant to the table above, plus every `profiles.role` value, confirming the exact eligibility table from this spec.
- Live RPC test: two scans of the same credential same day → second is `already_used_today`; same credential different `scan_date` → both `admitted`; concurrent same-day scans → exactly one `admitted` (verifies the unique index actually prevents the race, not just typical-case logic).
- Live RPC test: a KP/Speaker credential (once credentials are allowed to be created for ineligible-at-scan-time people, which can happen if eligibility changes after issuance) scans as `ineligible`, not `admitted`.
- Component/page test or manual verification: Cafeteria QR card only renders for eligible accounts, never for KP/Speaker/Youngo.
