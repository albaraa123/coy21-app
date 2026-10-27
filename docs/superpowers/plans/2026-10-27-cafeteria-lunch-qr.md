# Cafeteria Lunch QR (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give lunch-eligible attendees (delegates/volunteers/staff) a second, independent QR code that cafeteria staff scan once per day to admit them for lunch — simple eligible/not-eligible, no spending balance (that's Phase 2, explicitly out of scope here).

**Architecture:** A new, deliberately simple credential system (`cafeteria_credentials` + `cafeteria_lunch_scans`), separate from the existing `qr_credentials` attendance system (which is append-only/DELETE-blocked and encryption-heavy for a much higher-stakes problem). Hashed-random-token scheme (no envelope encryption). A new session-independent scanner route (`/scanner/cafeteria`) reusing the existing `isScannerDeviceRole`/`requireScannerDeviceCaller` auth and the existing `useQrScanner` camera hook, but with a plain, simple result UI (no offline retry/wake-lock/sound — confirmed explicitly deferred).

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres + RPC), TypeScript, Vitest.

**Design spec:** `docs/superpowers/specs/2026-10-27-cafeteria-lunch-qr-design.md`

---

### Task 1: Database schema

**Files:**
- Create: `supabase/migrations/20261027120000_cafeteria_lunch_qr.sql`
- Test: `tests/cafeteria/schema-live.test.ts`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20261027120000_cafeteria_lunch_qr.sql
--
-- Phase 1 of the cafeteria QR feature (lunch eligibility only — see
-- docs/superpowers/specs/2026-10-27-cafeteria-lunch-qr-design.md).
-- Deliberately independent of qr_credentials/qr_lifecycle_operations/
-- qr_bulk_operation_batches: that system is append-only (DELETE
-- unconditionally blocked by qr_credentials_enforce_lifecycle_trigger)
-- and envelope-encrypted for a much higher-stakes problem (admission
-- credential forgery). Lunch risk is "a stolen free lunch," not identity
-- fraud, so this uses a simple hashed-random-token scheme instead.

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
  --
  -- KNOWN EDGE CASE, accepted out of scope for Phase 1: this does not
  -- prevent one human from holding two credentials if they are
  -- simultaneously a staff/super_admin profile AND linked via
  -- applicant_id to an accepted+confirmed participant application
  -- (e.g. promoted to staff after applying). See the design spec's
  -- "Known edge case" paragraph. Not cross-checked at issuance time.
  constraint cafeteria_credentials_one_owner check (
    (application_id is not null and profile_id is null) or
    (application_id is null and profile_id is not null)
  )
);

create unique index cafeteria_credentials_application_idx on cafeteria_credentials (application_id) where application_id is not null;
create unique index cafeteria_credentials_profile_idx on cafeteria_credentials (profile_id) where profile_id is not null;

alter table cafeteria_credentials enable row level security;

-- Owner can read their own credential (needed for the My QR Code page's
-- "do I already have one" check via the regular session client — mirrors
-- qr_credentials' own owner-read policy shape).
create policy cafeteria_credentials_select_own_application on cafeteria_credentials
  for select using (
    application_id is not null
    and application_id in (select id from applications where applicant_id = auth.uid())
  );
create policy cafeteria_credentials_select_own_profile on cafeteria_credentials
  for select using (profile_id = auth.uid());

-- No INSERT/UPDATE/DELETE policy for authenticated/anon: issuance is
-- exclusively a service-role operation (mirrors every other credential-
-- issuance path in this codebase — RLS is not the write gate here, the
-- server action's own auth check is).
revoke insert, update, delete on cafeteria_credentials from authenticated, anon;

create table cafeteria_lunch_scans (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid not null references cafeteria_credentials(id) on delete cascade,
  scanned_by uuid references profiles(id) on delete set null,
  scanned_at timestamptz not null default now(),
  scan_date date not null, -- Europe/Istanbul calendar date at scan time, server-computed, never client-supplied
  result text not null check (result in ('admitted', 'already_used_today', 'ineligible', 'invalid_qr'))
);

-- The actual once-per-day enforcement: a real unique constraint, not
-- just application-level logic, so two near-simultaneous scans of the
-- same QR can't both succeed. Only 'admitted' rows count against it —
-- denials (ineligible/invalid_qr/already_used_today) are still logged
-- for audit purposes but never block a later legitimate admission.
create unique index cafeteria_lunch_scans_one_per_day on cafeteria_lunch_scans (credential_id, scan_date) where result = 'admitted';

alter table cafeteria_lunch_scans enable row level security;
-- No client-facing policy at all: written exclusively by the scan RPC
-- (service-role, SECURITY DEFINER-equivalent via service_role grant) and
-- read by nothing in this phase. Default-deny matches resend_webhook_events'
-- existing precedent for a table with no client-facing read/write need.

revoke all on cafeteria_lunch_scans from authenticated, anon;
grant select, insert on cafeteria_lunch_scans to service_role;
grant select, insert on cafeteria_credentials to service_role;
```

- [ ] **Step 2: Run the migration manually**

Ask the user to run this migration in the Supabase Dashboard SQL Editor against production (`vfwcbkjvinbtcntwjrzq`), per this session's established pattern for live-DB changes. **Before running, re-verify the exact current `applications`/`profiles` column/constraint shapes referenced above are still correct** by querying `information_schema` live — do not trust `combined_migrations.sql` (confirmed stale multiple times this session). If the migration errors, stop and get the exact error message before retrying.

- [ ] **Step 3: Regenerate TypeScript types**

Run `npx supabase gen types typescript --project-id vfwcbkjvinbtcntwjrzq > src/types/database.ts` (or the project's existing type-gen command — check `package.json` scripts first) so `cafeteria_credentials`/`cafeteria_lunch_scans` are typed.

- [ ] **Step 4: Write a live schema smoke test**

```typescript
// tests/cafeteria/schema-live.test.ts
import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

describe('cafeteria schema', () => {
  it('cafeteria_credentials rejects a row with both application_id and profile_id set', async () => {
    const { error } = await admin.from('cafeteria_credentials').insert({
      application_id: '00000000-0000-0000-0000-000000000000',
      profile_id: '00000000-0000-0000-0000-000000000000',
      token_hash: Buffer.alloc(32, 1) as unknown as never,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/cafeteria_credentials_one_owner|violates/i);
  });

  it('cafeteria_credentials rejects a row with neither set', async () => {
    const { error } = await admin.from('cafeteria_credentials').insert({
      token_hash: Buffer.alloc(32, 2) as unknown as never,
    });
    expect(error).not.toBeNull();
  });
});
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/cafeteria/schema-live.test.ts`
Expected: PASS (2/2)

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20261027120000_cafeteria_lunch_qr.sql src/types/database.ts tests/cafeteria/schema-live.test.ts
git commit -m "feat: add cafeteria_credentials/cafeteria_lunch_scans schema"
```

---

### Task 2: Token scheme + eligibility predicate

**Files:**
- Create: `src/lib/cafeteria/token.ts`
- Create: `src/lib/cafeteria/eligibility.ts`
- Test: `src/lib/cafeteria/token.test.ts`
- Test: `src/lib/cafeteria/eligibility.test.ts`

- [ ] **Step 1: Write the failing token test**

```typescript
// src/lib/cafeteria/token.test.ts
import { describe, it, expect } from 'vitest';
import { generateCafeteriaToken, hashCafeteriaToken, canonicalEncodeCafeteriaToken, parseCanonicalCafeteriaPayload } from './token';

describe('cafeteria token', () => {
  it('generates a 32-byte raw token and a matching canonical payload', () => {
    const { rawToken, payload } = generateCafeteriaToken();
    expect(rawToken).toHaveLength(32);
    expect(payload).toMatch(/^cafe:v1:[A-Za-z0-9_-]{43}$/);
  });

  it('round-trips encode/parse', () => {
    const { rawToken, payload } = generateCafeteriaToken();
    const parsed = parseCanonicalCafeteriaPayload(payload);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rawToken.equals(rawToken)).toBe(true);
  });

  it('rejects a malformed payload (wrong prefix)', () => {
    const parsed = parseCanonicalCafeteriaPayload('rcoy:v1:' + 'A'.repeat(43));
    expect(parsed.ok).toBe(false);
  });

  it('rejects a payload with invalid base64url characters', () => {
    const parsed = parseCanonicalCafeteriaPayload('cafe:v1:' + '+'.repeat(43));
    expect(parsed.ok).toBe(false);
  });

  it('hash is deterministic and 32 bytes (sha256)', () => {
    const { rawToken } = generateCafeteriaToken();
    const h1 = hashCafeteriaToken(rawToken);
    const h2 = hashCafeteriaToken(rawToken);
    expect(h1.equals(h2)).toBe(true);
    expect(h1).toHaveLength(32);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/cafeteria/token.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write the token module**

```typescript
// src/lib/cafeteria/token.ts
//
// Simple hashed-random-token scheme for the cafeteria credential —
// deliberately NOT the attendance system's envelope-encrypted scheme
// (src/lib/attendance/qr-token-crypto.ts, scoped to the rcoy:v1: format).
// Lunch risk is "a stolen free lunch," not identity fraud, so there's no
// need for AES-GCM/key-rotation machinery here. The raw token is still
// never persisted in plaintext (only its SHA-256 hash is stored),
// mirroring the attendance system's "never persist the raw bearer
// credential" rule even without reusing its encryption layer.
import { randomBytes, createHash } from 'node:crypto';

export const CAFETERIA_PAYLOAD_PREFIX = 'cafe:v1:';
const RAW_TOKEN_BYTES = 32;
const TOKEN_TEXT_LENGTH = 43; // base64url, unpadded, 32 raw bytes
const BASE64URL_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_TEXT_LENGTH}}$`);

export function generateCafeteriaToken(): { rawToken: Buffer; payload: string } {
  const rawToken = randomBytes(RAW_TOKEN_BYTES);
  return { rawToken, payload: canonicalEncodeCafeteriaToken(rawToken) };
}

export function canonicalEncodeCafeteriaToken(rawToken: Buffer): string {
  if (rawToken.length !== RAW_TOKEN_BYTES) throw new Error('rawToken must be 32 bytes');
  return CAFETERIA_PAYLOAD_PREFIX + rawToken.toString('base64url');
}

export function hashCafeteriaToken(rawToken: Buffer): Buffer {
  return createHash('sha256').update(rawToken).digest();
}

export function parseCanonicalCafeteriaPayload(payload: string): { ok: true; rawToken: Buffer } | { ok: false } {
  if (!payload.startsWith(CAFETERIA_PAYLOAD_PREFIX)) return { ok: false };
  const tokenText = payload.slice(CAFETERIA_PAYLOAD_PREFIX.length);
  if (!BASE64URL_PATTERN.test(tokenText)) return { ok: false };
  return { ok: true, rawToken: Buffer.from(tokenText, 'base64url') };
}
```

- [ ] **Step 4: Run the token test to verify it passes**

Run: `npx vitest run src/lib/cafeteria/token.test.ts`
Expected: PASS (5/5)

- [ ] **Step 5: Write the failing eligibility test**

```typescript
// src/lib/cafeteria/eligibility.test.ts
import { describe, it, expect } from 'vitest';
import { isLunchEligible } from './eligibility';

describe('isLunchEligible', () => {
  const baseApp = { participant_type: null as string | null, status: 'accepted', attendance_confirmation: 'confirmed' };

  it('delegate accepted+confirmed is eligible', () => {
    expect(isLunchEligible({ ...baseApp, participant_type: 'delegate' }, null)).toBe(true);
  });
  it('volunteer accepted+confirmed is eligible', () => {
    expect(isLunchEligible({ ...baseApp, participant_type: 'volunteer' }, null)).toBe(true);
  });
  it('delegate not confirmed is NOT eligible', () => {
    expect(isLunchEligible({ ...baseApp, participant_type: 'delegate', attendance_confirmation: 'not_confirmed' }, null)).toBe(false);
  });
  it('delegate not accepted is NOT eligible', () => {
    expect(isLunchEligible({ ...baseApp, participant_type: 'delegate', status: 'waitlisted' }, null)).toBe(false);
  });
  it('knowledge_partner is NOT eligible regardless of status', () => {
    expect(isLunchEligible({ ...baseApp, participant_type: 'knowledge_partner' }, null)).toBe(false);
  });
  it('speaker is NOT eligible', () => {
    expect(isLunchEligible({ ...baseApp, participant_type: 'speaker' }, null)).toBe(false);
  });
  it('youngo is NOT eligible (not yet classified)', () => {
    expect(isLunchEligible({ ...baseApp, participant_type: 'youngo' }, null)).toBe(false);
  });
  it('staff role is eligible regardless of application', () => {
    expect(isLunchEligible(null, { role: 'staff' })).toBe(true);
  });
  it('super_admin role is eligible', () => {
    expect(isLunchEligible(null, { role: 'super_admin' })).toBe(true);
  });
  it('scanner_device role is NOT eligible', () => {
    expect(isLunchEligible(null, { role: 'scanner_device' })).toBe(false);
  });
  it('participant role (no staff role) with no application is NOT eligible', () => {
    expect(isLunchEligible(null, { role: 'participant' })).toBe(false);
  });
  it('both null is NOT eligible', () => {
    expect(isLunchEligible(null, null)).toBe(false);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/lib/cafeteria/eligibility.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 7: Write the eligibility module**

```typescript
// src/lib/cafeteria/eligibility.ts
//
// Single source of truth for lunch eligibility (design spec: delegates/
// volunteers who are accepted+confirmed, or any staff/super_admin
// account). Used identically at credential issuance, My QR Code card
// visibility, and scan-time re-check — never re-derived elsewhere.
import { isStaffRole } from '@/lib/auth/is-staff-role';

const ELIGIBLE_PARTICIPANT_TYPES = ['delegate', 'volunteer'] as const;

export function isLunchEligible(
  application: { participant_type: string | null; status: string; attendance_confirmation: string } | null,
  profile: { role: string | null } | null
): boolean {
  if (profile && isStaffRole(profile.role)) return true;
  if (
    application &&
    application.participant_type != null &&
    (ELIGIBLE_PARTICIPANT_TYPES as readonly string[]).includes(application.participant_type) &&
    application.status === 'accepted' &&
    application.attendance_confirmation === 'confirmed'
  ) {
    return true;
  }
  return false;
}
```

- [ ] **Step 8: Run the eligibility test to verify it passes**

Run: `npx vitest run src/lib/cafeteria/eligibility.test.ts`
Expected: PASS (12/12)

- [ ] **Step 9: Commit**

```bash
git add src/lib/cafeteria/token.ts src/lib/cafeteria/token.test.ts src/lib/cafeteria/eligibility.ts src/lib/cafeteria/eligibility.test.ts
git commit -m "feat: add cafeteria token scheme and lunch-eligibility predicate"
```

---

### Task 3: Scan RPC (database function)

**Files:**
- Create: `supabase/migrations/20261027130000_cafeteria_lunch_scan_rpc.sql`
- Test: `tests/cafeteria/lunch-scan-rpc-live.test.ts`

- [ ] **Step 1: Write the migration**

Before writing this migration, re-read the LIVE current definition of `scan_attempt_transactional` via `pg_get_functiondef` (not `combined_migrations.sql`, confirmed stale multiple times this session) to double check the retry-loop/advisory-lock pattern below matches current production exactly — the version shown in Task background research came from migration file `20261006110000_scan_attempts_idempotency.sql`, which should be current but must be reconfirmed live before relying on it.

```sql
-- supabase/migrations/20261027130000_cafeteria_lunch_scan_rpc.sql
--
-- Scan RPC for the cafeteria lunch credential. Mirrors
-- scan_attempt_transactional's retry-until-decided concurrency pattern
-- (bounded retry loop around pg_try_advisory_xact_lock, ~1s worst case)
-- rather than confirm_publication_transactional's fail-fast pattern —
-- this feature's operator-facing "scan and get an answer" UX needs both
-- concurrent scanners to resolve with a real decision, never one
-- throwing. See design spec's "Concurrency semantics" section.
--
-- Eligibility is re-checked LIVE at scan time (not cached from
-- issuance) by re-reading applications/profiles inside this function —
-- a credential issued while eligible but since become ineligible (e.g.
-- an unconfirmed delegate) must scan as 'ineligible', not 'admitted'.
create or replace function cafeteria_lunch_scan_transactional(
  p_token_hash bytea,
  p_scanned_by uuid
) returns cafeteria_lunch_scans
language plpgsql
as $$
declare
  v_lock_key bigint;
  v_lock_acquired boolean := false;
  v_retry_count int := 0;
  v_max_retries constant int := 20;
  v_retry_delay_seconds constant numeric := 0.05;
  v_credential cafeteria_credentials%rowtype;
  v_scan_date date;
  v_eligible boolean;
  v_already_today boolean;
  v_result text;
  v_scan cafeteria_lunch_scans%rowtype;
  v_participant_type text;
  v_app_status text;
  v_attendance_confirmation text;
  v_profile_role text;
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    insert into cafeteria_lunch_scans (credential_id, scanned_by, scan_date, result)
    -- No credential row exists for an unparseable/unknown token, so
    -- credential_id can't be populated -- but the column is NOT NULL.
    -- Resolve this the same way scan_attempts does for an unresolved
    -- credential: there is no cafeteria_lunch_scans row written at all
    -- for an invalid_qr with no matching credential; the Route Handler
    -- returns 'invalid_qr' to the operator directly without an RPC
    -- round-trip for this case (see Task 4's parse-first flow). This
    -- branch should therefore be unreachable in practice -- kept only
    -- as a defensive guard; if hit, raise rather than violate NOT NULL.
    values (null, p_scanned_by, (now() at time zone 'Europe/Istanbul')::date, 'invalid_qr');
    raise exception 'cafeteria_lunch_scan_transactional called with an unresolvable token_hash -- caller must resolve the credential before calling this function';
  end if;

  select * into v_credential from cafeteria_credentials where token_hash = p_token_hash;
  if v_credential.id is null then
    raise exception 'cafeteria_lunch_scan_transactional called with a token_hash matching no credential -- caller must resolve the credential before calling this function';
  end if;

  v_lock_key := hashtext('cafeteria:' || v_credential.id::text);

  loop
    v_lock_acquired := pg_try_advisory_xact_lock(v_lock_key);
    exit when v_lock_acquired or v_retry_count >= v_max_retries;
    v_retry_count := v_retry_count + 1;
    perform pg_sleep(v_retry_delay_seconds);
  end loop;

  if not v_lock_acquired then
    raise exception 'LOCK_CONTENTION: Another scan for this credential is still being processed after % retries', v_max_retries;
  end if;

  v_scan_date := (now() at time zone 'Europe/Istanbul')::date;

  -- Live eligibility re-check, inside the lock, re-reading current
  -- applications/profiles state -- never trusted from issuance time.
  if v_credential.application_id is not null then
    select participant_type, status, attendance_confirmation
      into v_participant_type, v_app_status, v_attendance_confirmation
      from applications where id = v_credential.application_id;
    v_eligible := v_participant_type in ('delegate', 'volunteer')
      and v_app_status = 'accepted'
      and v_attendance_confirmation = 'confirmed';
  else
    select role into v_profile_role from profiles where id = v_credential.profile_id;
    v_eligible := v_profile_role in ('staff', 'super_admin');
  end if;

  if not v_eligible then
    insert into cafeteria_lunch_scans (credential_id, scanned_by, scan_date, result)
    values (v_credential.id, p_scanned_by, v_scan_date, 'ineligible')
    returning * into v_scan;
    return v_scan;
  end if;

  select exists(
    select 1 from cafeteria_lunch_scans
    where credential_id = v_credential.id and scan_date = v_scan_date and result = 'admitted'
  ) into v_already_today;

  v_result := case when v_already_today then 'already_used_today' else 'admitted' end;

  insert into cafeteria_lunch_scans (credential_id, scanned_by, scan_date, result)
  values (v_credential.id, p_scanned_by, v_scan_date, v_result)
  returning * into v_scan;

  return v_scan;
end;
$$;

comment on function cafeteria_lunch_scan_transactional(bytea, uuid) is
  'Sole write authority for cafeteria_lunch_scans. Re-checks eligibility live (not cached from issuance) and once-per-day usage inside an advisory-locked transaction (retry-until-decided, matching scan_attempt_transactional), keyed per-credential so concurrent scans of the SAME credential serialize but scans of DIFFERENT credentials never contend.';

revoke all on function cafeteria_lunch_scan_transactional(bytea, uuid) from public, anon, authenticated;
grant execute on function cafeteria_lunch_scan_transactional(bytea, uuid) to service_role;
```

- [ ] **Step 2: Run the migration manually**

Same live-DB process as Task 1 Step 2 — ask the user to run it, re-verify current schema first, stop on any error.

- [ ] **Step 3: Regenerate TypeScript types**

Same command as Task 1 Step 3, so the new RPC is typed.

- [ ] **Step 4: Write the failing live RPC test**

```typescript
// tests/cafeteria/lunch-scan-rpc-live.test.ts
//
// Fixture pattern mirrors tests/attendance/scan-attempt-concurrency-live.test.ts
// exactly: real Supabase Auth users, real applications rows, afterAll
// cleanup in FK-dependency order. Unlike that file's session-scoped
// concurrency, this credential's advisory lock is keyed per-credential-id
// (not per-session), so two DIFFERENT credentials never contend with
// each other — only two scans of the SAME credential do.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import { generateCafeteriaToken, hashCafeteriaToken } from '@/lib/cafeteria/token';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

vi.setConfig({ testTimeout: 30000 });

const runId = randomUUID().slice(0, 8);
let scannerUserId: string;
let applicantUserId: string;
let applicationId: string;
let credentialId: string;
let credentialRawToken: Buffer;
let ineligibleApplicantUserId: string;
let ineligibleApplicationId: string;
let ineligibleCredentialId: string;
let ineligibleRawToken: Buffer;

beforeAll(async () => {
  const { data: scanner, error: scannerError } = await admin.auth.admin.createUser({
    email: `cafe-scan-${runId}-scanner@test.local`, password: 'password123', email_confirm: true,
  });
  if (scannerError || !scanner.user) throw new Error(`scanner setup failed: ${scannerError?.message}`);
  scannerUserId = scanner.user.id;
  await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', scannerUserId);

  const { data: applicant, error: applicantError } = await admin.auth.admin.createUser({
    email: `cafe-scan-${runId}-delegate@test.local`, password: 'password123', email_confirm: true,
  });
  if (applicantError || !applicant.user) throw new Error(`applicant setup failed: ${applicantError?.message}`);
  applicantUserId = applicant.user.id;
  const { data: app, error: appError } = await admin.from('applications').insert({
    applicant_id: applicantUserId, status: 'accepted', participant_type: 'delegate', attendance_confirmation: 'confirmed',
  }).select('id').single();
  if (appError || !app) throw new Error(`application setup failed: ${appError?.message}`);
  applicationId = app.id;

  const tok = generateCafeteriaToken();
  credentialRawToken = tok.rawToken;
  const { data: cred, error: credError } = await admin.from('cafeteria_credentials').insert({
    application_id: applicationId, token_hash: hashCafeteriaToken(tok.rawToken) as unknown as never,
  }).select('id').single();
  if (credError || !cred) throw new Error(`credential setup failed: ${credError?.message}`);
  credentialId = cred.id;

  // A second, ineligible (knowledge_partner) credential for the
  // live-eligibility-recheck test.
  const { data: kp, error: kpError } = await admin.auth.admin.createUser({
    email: `cafe-scan-${runId}-kp@test.local`, password: 'password123', email_confirm: true,
  });
  if (kpError || !kp.user) throw new Error(`kp setup failed: ${kpError?.message}`);
  ineligibleApplicantUserId = kp.user.id;
  const { data: kpApp, error: kpAppError } = await admin.from('applications').insert({
    applicant_id: ineligibleApplicantUserId, status: 'accepted', participant_type: 'knowledge_partner', attendance_confirmation: 'confirmed',
  }).select('id').single();
  if (kpAppError || !kpApp) throw new Error(`kp application setup failed: ${kpAppError?.message}`);
  ineligibleApplicationId = kpApp.id;
  const kpTok = generateCafeteriaToken();
  ineligibleRawToken = kpTok.rawToken;
  const { data: kpCred, error: kpCredError } = await admin.from('cafeteria_credentials').insert({
    application_id: ineligibleApplicationId, token_hash: hashCafeteriaToken(kpTok.rawToken) as unknown as never,
  }).select('id').single();
  if (kpCredError || !kpCred) throw new Error(`kp credential setup failed: ${kpCredError?.message}`);
  ineligibleCredentialId = kpCred.id;
});

afterAll(async () => {
  await admin.from('cafeteria_lunch_scans').delete().in('credential_id', [credentialId, ineligibleCredentialId].filter(Boolean));
  await admin.from('cafeteria_credentials').delete().in('id', [credentialId, ineligibleCredentialId].filter(Boolean));
  await admin.from('applications').delete().in('id', [applicationId, ineligibleApplicationId].filter(Boolean));
  for (const id of [scannerUserId, applicantUserId, ineligibleApplicantUserId].filter(Boolean)) {
    await admin.auth.admin.deleteUser(id);
  }
});

describe('cafeteria_lunch_scan_transactional', () => {
  it('first scan of the day admits', async () => {
    const { data, error } = await admin.rpc('cafeteria_lunch_scan_transactional', {
      p_token_hash: hashCafeteriaToken(credentialRawToken) as unknown as string,
      p_scanned_by: scannerUserId,
    });
    expect(error).toBeNull();
    expect(data?.result).toBe('admitted');
  });

  it('second scan same day is already_used_today', async () => {
    const { data, error } = await admin.rpc('cafeteria_lunch_scan_transactional', {
      p_token_hash: hashCafeteriaToken(credentialRawToken) as unknown as string,
      p_scanned_by: scannerUserId,
    });
    expect(error).toBeNull();
    expect(data?.result).toBe('already_used_today');
  });

  it('knowledge_partner credential scans as ineligible, never admitted', async () => {
    const { data, error } = await admin.rpc('cafeteria_lunch_scan_transactional', {
      p_token_hash: hashCafeteriaToken(ineligibleRawToken) as unknown as string,
      p_scanned_by: scannerUserId,
    });
    expect(error).toBeNull();
    expect(data?.result).toBe('ineligible');
  });

  it('two concurrent same-day scans of the same credential resolve to exactly one admitted (fresh credential)', async () => {
    const tok = generateCafeteriaToken();
    const { data: applicant2, error: a2Error } = await admin.auth.admin.createUser({
      email: `cafe-scan-${runId}-concur@test.local`, password: 'password123', email_confirm: true,
    });
    if (a2Error || !applicant2.user) throw new Error('concurrent fixture setup failed');
    const { data: app2 } = await admin.from('applications').insert({
      applicant_id: applicant2.user.id, status: 'accepted', participant_type: 'volunteer', attendance_confirmation: 'confirmed',
    }).select('id').single();
    const { data: cred2 } = await admin.from('cafeteria_credentials').insert({
      application_id: app2!.id, token_hash: hashCafeteriaToken(tok.rawToken) as unknown as never,
    }).select('id').single();

    const [r1, r2] = await Promise.all([
      admin.rpc('cafeteria_lunch_scan_transactional', { p_token_hash: hashCafeteriaToken(tok.rawToken) as unknown as string, p_scanned_by: scannerUserId }),
      admin.rpc('cafeteria_lunch_scan_transactional', { p_token_hash: hashCafeteriaToken(tok.rawToken) as unknown as string, p_scanned_by: scannerUserId }),
    ]);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    const results = [r1.data?.result, r2.data?.result].sort();
    expect(results).toEqual(['admitted', 'already_used_today']);

    await admin.from('cafeteria_lunch_scans').delete().eq('credential_id', cred2!.id);
    await admin.from('cafeteria_credentials').delete().eq('id', cred2!.id);
    await admin.from('applications').delete().eq('id', app2!.id);
    await admin.auth.admin.deleteUser(applicant2.user.id);
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run tests/cafeteria/lunch-scan-rpc-live.test.ts`
Expected: FAIL (function `cafeteria_lunch_scan_transactional` does not exist, until Step 2's migration is actually applied live)

- [ ] **Step 6: Apply the migration live (Step 2 above), then re-run**

Run: `npx vitest run tests/cafeteria/lunch-scan-rpc-live.test.ts`
Expected: PASS (4/4)

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20261027130000_cafeteria_lunch_scan_rpc.sql src/types/database.ts tests/cafeteria/lunch-scan-rpc-live.test.ts
git commit -m "feat: add cafeteria_lunch_scan_transactional RPC"
```

---

### Task 4: Credential issuance (lib + server action)

**Files:**
- Create: `src/lib/cafeteria/credential-issuance.ts`
- Modify: `src/app/[locale]/(participant)/(shell)/my-qr/actions.ts`
- Test: `tests/cafeteria/credential-issuance-live.test.ts`

- [ ] **Step 1: Write the failing live issuance test**

```typescript
// tests/cafeteria/credential-issuance-live.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import { issueCafeteriaCredentialForCaller } from '@/lib/cafeteria/credential-issuance';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);
let delegateUserId: string;
let delegateApplicationId: string;
let kpUserId: string;

beforeAll(async () => {
  const { data: delegate } = await admin.auth.admin.createUser({
    email: `cafe-issue-${runId}-delegate@test.local`, password: 'password123', email_confirm: true,
  });
  delegateUserId = delegate!.user!.id;
  const { data: app } = await admin.from('applications').insert({
    applicant_id: delegateUserId, status: 'accepted', participant_type: 'delegate', attendance_confirmation: 'confirmed',
  }).select('id').single();
  delegateApplicationId = app!.id;

  const { data: kp } = await admin.auth.admin.createUser({
    email: `cafe-issue-${runId}-kp@test.local`, password: 'password123', email_confirm: true,
  });
  kpUserId = kp!.user!.id;
  await admin.from('applications').insert({
    applicant_id: kpUserId, status: 'accepted', participant_type: 'knowledge_partner', attendance_confirmation: 'confirmed',
  });
});

afterAll(async () => {
  await admin.from('cafeteria_credentials').delete().eq('application_id', delegateApplicationId);
  await admin.from('applications').delete().in('applicant_id', [delegateUserId, kpUserId]);
  await admin.auth.admin.deleteUser(delegateUserId);
  await admin.auth.admin.deleteUser(kpUserId);
});

describe('issueCafeteriaCredentialForCaller', () => {
  it('issues a credential for an eligible delegate', async () => {
    const result = await issueCafeteriaCredentialForCaller({ userId: delegateUserId, service: admin });
    expect(result.outcome).toBe('issued');
  });

  it('is idempotent — a second call returns the existing credential', async () => {
    const first = await issueCafeteriaCredentialForCaller({ userId: delegateUserId, service: admin });
    const second = await issueCafeteriaCredentialForCaller({ userId: delegateUserId, service: admin });
    expect(second.outcome).toBe('already_exists');
    if (first.outcome === 'issued' && second.outcome === 'already_exists') {
      expect(second.credentialId).toBe(first.credentialId);
    }
  });

  it('refuses to issue for an ineligible knowledge_partner', async () => {
    const result = await issueCafeteriaCredentialForCaller({ userId: kpUserId, service: admin });
    expect(result.outcome).toBe('not_eligible');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/cafeteria/credential-issuance-live.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write the issuance module**

```typescript
// src/lib/cafeteria/credential-issuance.ts
//
// Self-service issuance for the cafeteria credential, mirroring
// src/lib/attendance/qr-credential-issuance.ts's own
// issueMyQrCredential shape: idempotent (a repeat call returns the
// existing credential rather than erroring), eligibility re-checked
// server-side (never trusts a client claim), never issues for an
// ineligible caller.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { generateCafeteriaToken, hashCafeteriaToken } from './token';
import { isLunchEligible } from './eligibility';

type ServiceClient = SupabaseClient<Database>;

export type IssueCafeteriaCredentialResult =
  | { outcome: 'issued'; credentialId: string; qrPayload: string }
  | { outcome: 'already_exists'; credentialId: string }
  | { outcome: 'not_eligible' }
  | { outcome: 'error'; message: string };

export async function issueCafeteriaCredentialForCaller(
  caller: { userId: string; service: ServiceClient }
): Promise<IssueCafeteriaCredentialResult> {
  const { userId, service } = caller;

  const { data: profile, error: profileError } = await service.from('profiles').select('role').eq('id', userId).maybeSingle();
  if (profileError) return { outcome: 'error', message: profileError.message };

  const { data: application, error: appError } = await service
    .from('applications')
    .select('id, participant_type, status, attendance_confirmation')
    .eq('applicant_id', userId)
    .maybeSingle();
  if (appError) return { outcome: 'error', message: appError.message };

  const eligible = isLunchEligible(application, profile);
  if (!eligible) return { outcome: 'not_eligible' };

  // Staff (no application) key by profile_id; a participant keys by
  // application_id — matches the schema's one-owner constraint exactly.
  const ownerColumn = application ? 'application_id' : 'profile_id';
  const ownerValue = application ? application.id : userId;

  const { data: existing, error: existingError } = await service
    .from('cafeteria_credentials')
    .select('id')
    .eq(ownerColumn, ownerValue)
    .maybeSingle();
  if (existingError) return { outcome: 'error', message: existingError.message };
  if (existing) return { outcome: 'already_exists', credentialId: existing.id };

  const { rawToken, payload } = generateCafeteriaToken();
  const tokenHash = hashCafeteriaToken(rawToken);

  const { data: inserted, error: insertError } = await service
    .from('cafeteria_credentials')
    .insert({
      [ownerColumn]: ownerValue,
      token_hash: tokenHash as unknown as never,
    })
    .select('id')
    .single();
  if (insertError || !inserted) {
    // A unique_violation here means a concurrent request already
    // inserted one (race between this check and this insert) — treat
    // as success, not failure, same idempotent-by-construction
    // reasoning as issueMyQrCredential's own handling.
    const { data: retryExisting } = await service.from('cafeteria_credentials').select('id').eq(ownerColumn, ownerValue).maybeSingle();
    if (retryExisting) return { outcome: 'already_exists', credentialId: retryExisting.id };
    return { outcome: 'error', message: insertError?.message ?? 'Insert failed' };
  }

  return { outcome: 'issued', credentialId: inserted.id, qrPayload: payload };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/cafeteria/credential-issuance-live.test.ts`
Expected: PASS (3/3)

- [ ] **Step 5: Wire a server action into the My QR Code page**

Add to `src/app/[locale]/(participant)/(shell)/my-qr/actions.ts` (same file, same `requireParticipantCaller` helper already defined there):

```typescript
import { issueCafeteriaCredentialForCaller } from '@/lib/cafeteria/credential-issuance';
import { renderQrDataUri } from '@/lib/attendance/qr-image';

export interface CafeteriaQrActionResult {
  outcome: 'issued' | 'already_exists' | 'not_eligible' | 'error';
  qrImageDataUri: string | null;
}

export async function requestCafeteriaCredential(): Promise<CafeteriaQrActionResult> {
  const { userId, service } = await requireParticipantCaller();
  const result = await issueCafeteriaCredentialForCaller({ userId, service });
  if (result.outcome === 'issued') {
    return { outcome: 'issued', qrImageDataUri: await renderQrDataUri(result.qrPayload) };
  }
  if (result.outcome === 'already_exists') {
    // Re-fetch to render the existing credential's QR — issuance itself
    // doesn't return the raw payload for an already-existing row (it's
    // never re-derivable from the stored hash), so the page must track
    // whether it has already rendered one this session; see Task 5's
    // client component for how this is handled (fetchMyCafeteriaQrImage).
    return { outcome: 'already_exists', qrImageDataUri: null };
  }
  return { outcome: result.outcome, qrImageDataUri: null };
}
```

**Important note for the implementer:** because `token_hash` is a one-way hash, the raw QR payload can only ever be shown once — at the moment of issuance. Task 5 must account for this: either (a) store the QR image (not just the hash) server-side after first issuance so it can be redisplayed, or (b) accept that a user who navigates away and back before Task 5's page caches the image client-side will see "already issued" with no way to redisplay the actual scannable code, which would be a real usability bug. **Resolve this explicitly in Task 5 — do not ship behavior (b).** The simplest fix: also store the rendered PNG data URI (or just re-render from a newly-added `qr_image_cache` style column is overkill — instead render on EVERY page load for an existing credential using a reversible scheme, OR simplest of all: don't hash the token at rest — store it in a way the page can always redisplay it). Flag this to the user/reviewer before implementing Task 5 — it's a real design decision this plan's spec review did not fully resolve.

- [ ] **Step 6: Commit**

```bash
git add src/lib/cafeteria/credential-issuance.ts src/app/[locale]/(participant)/(shell)/my-qr/actions.ts tests/cafeteria/credential-issuance-live.test.ts
git commit -m "feat: add cafeteria credential self-service issuance"
```

---

### Task 5: My QR Code page — Cafeteria QR card

**STOP before starting this task — resolve Task 4 Step 5's flagged design gap first** (how the QR payload is redisplayed on a later page visit, given the token is only stored hashed). Confirm the chosen approach with the user before writing this task's code; this plan does not prescribe one, since it's a real tradeoff (storing the plaintext payload server-side weakens the "never persist the raw bearer token" property from the design spec, even though the security stakes are low — the user should make this call explicitly, it's exactly the kind of judgment call the design spec's own "Token scheme" section didn't fully specify).

**Files:**
- Modify: `src/app/[locale]/(participant)/(shell)/my-qr/page.tsx`
- Modify: `src/app/[locale]/(participant)/(shell)/my-qr/my-qr-client.tsx`
- Modify: `src/app/[locale]/(participant)/(shell)/my-qr/actions.ts` (resolved per the Task 4 Step 5 decision)

- [ ] **Step 1: Server-side eligibility + existing-credential check**

In `page.tsx`, alongside the existing `getMyQrState` call, add a lunch-eligibility check (reusing `isLunchEligible` against the already-fetched application/profile data) and pass an `isLunchEligible: boolean` + any existing-credential display state down to the client component. Card renders only when `true`.

- [ ] **Step 2: Add the Cafeteria QR card to `my-qr-client.tsx`**

New card below the existing attendance-QR card (not replacing it — both can be shown together), following the exact same `NOT_YET_AVAILABLE` → request-button → `QR_AVAILABLE` shape as the existing component, using `requestCafeteriaCredential` (from Task 4) instead of `requestMyQrCredential`. Only rendered when the server passed `isLunchEligible: true`.

- [ ] **Step 3: Manual verification**

Start the dev server, log in as a test delegate account (accepted + confirmed), confirm the Cafeteria QR card appears and the request flow issues a scannable code. Log in as a test knowledge_partner account, confirm the card does not render at all.

- [ ] **Step 4: Commit**

```bash
git add "src/app/[locale]/(participant)/(shell)/my-qr/page.tsx" "src/app/[locale]/(participant)/(shell)/my-qr/my-qr-client.tsx" "src/app/[locale]/(participant)/(shell)/my-qr/actions.ts"
git commit -m "feat: show Cafeteria QR card on My QR Code page for eligible users"
```

---

### Task 6: Cafeteria scanner route (simple version, confirmed scope)

**Files:**
- Create: `src/app/[locale]/scanner/cafeteria/page.tsx`
- Create: `src/components/scanner/cafeteria-scanner-client.tsx`
- Create: `src/app/api/cafeteria-scan/route.ts`
- Create: `src/lib/cafeteria/lunch-scan.ts`

- [ ] **Step 1: Write the server-side scan-confirmation module**

```typescript
// src/lib/cafeteria/lunch-scan.ts
//
// Trusted server boundary for cafeteria scan submission — mirrors
// src/lib/attendance/scan-qr-attempt.ts's shape exactly (parse payload
// here, call the RPC, never trust client-supplied eligibility/result).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { parseCanonicalCafeteriaPayload, hashCafeteriaToken } from './token';

type ServiceClient = SupabaseClient<Database>;

export interface CafeteriaScanResult {
  result: 'admitted' | 'already_used_today' | 'ineligible' | 'invalid_qr';
  scanId: string | null;
}

export async function confirmCafeteriaLunchScanForCaller(
  params: { qrPayload: string },
  caller: { userId: string; service: ServiceClient }
): Promise<{ ok: true; result: CafeteriaScanResult } | { ok: false; message: string }> {
  const parsed = parseCanonicalCafeteriaPayload(params.qrPayload);
  if (!parsed.ok) {
    return { ok: true, result: { result: 'invalid_qr', scanId: null } };
  }

  const tokenHash = hashCafeteriaToken(parsed.rawToken);

  // Resolve the credential first (outside the RPC) so an unknown token
  // never reaches cafeteria_lunch_scan_transactional at all — that
  // function raises on an unresolvable hash by design (Task 3), not
  // returns a row, so this check must happen here.
  const { data: credential, error: credError } = await caller.service
    .from('cafeteria_credentials')
    .select('id')
    .eq('token_hash', tokenHash as unknown as never)
    .maybeSingle();
  if (credError) return { ok: false, message: credError.message };
  if (!credential) return { ok: true, result: { result: 'invalid_qr', scanId: null } };

  const { data, error } = await caller.service.rpc('cafeteria_lunch_scan_transactional', {
    p_token_hash: tokenHash as unknown as string,
    p_scanned_by: caller.userId,
  });
  if (error) return { ok: false, message: error.message };

  return { ok: true, result: { result: data.result as CafeteriaScanResult['result'], scanId: data.id } };
}
```

- [ ] **Step 2: Write the Route Handler**

```typescript
// src/app/api/cafeteria-scan/route.ts
import { NextResponse } from 'next/server';
import { confirmCafeteriaLunchScanForCaller } from '@/lib/cafeteria/lunch-scan';
import { requireScannerDeviceCaller } from '@/lib/scanner-device/server-helpers';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { qrPayload } = body ?? {};
    if (typeof qrPayload !== 'string') {
      return NextResponse.json({ ok: false, message: 'Invalid request' }, { status: 200 });
    }

    let caller;
    try {
      caller = await requireScannerDeviceCaller();
    } catch (err) {
      return NextResponse.json({ ok: false, message: err instanceof Error ? err.message : 'Not authorized' }, { status: 200 });
    }

    const outcome = await confirmCafeteriaLunchScanForCaller({ qrPayload }, caller);
    return NextResponse.json(outcome, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false, message: 'Unexpected error' }, { status: 200 });
  }
}
```

- [ ] **Step 3: Write the scanner page**

```typescript
// src/app/[locale]/scanner/cafeteria/page.tsx
//
// Nested under src/app/[locale]/scanner/layout.tsx — inherits its
// kiosk-style chrome automatically, no new layout needed. Separate from
// the existing session-scoped /scanner route (not a mode flag on it) —
// see design spec's "UI — Cafeteria Scanner mode" section for why.
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isScannerDeviceRole } from '@/lib/validation/scanner-device';
import { ErrorState } from '@/components/states/error-state';
import { CafeteriaScannerClient } from '@/components/scanner/cafeteria-scanner-client';

export default async function CafeteriaScannerPage() {
  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: 'scanner' });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).maybeSingle();

  if (!isScannerDeviceRole(profile?.role)) {
    return <ErrorState title={t('states.unauthorized.title')} description={t('states.unauthorized.description')} />;
  }

  return <CafeteriaScannerClient />;
}
```

- [ ] **Step 4: Write the simple scanner client component**

Explicitly simple per the confirmed scope decision (no offline retry, no wake-lock, no sound/haptic — "نطوره لاحقاً لو احتجنا"). Reuses `useQrScanner` (the pure camera-decode hook, `src/components/scanner/use-qr-scanner.ts`) as-is.

```typescript
// src/components/scanner/cafeteria-scanner-client.tsx
'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQrScanner } from './use-qr-scanner';
import { Button } from '@/components/ui/button';

type ScanResult = 'admitted' | 'already_used_today' | 'ineligible' | 'invalid_qr' | 'error';

const RESULT_COPY: Record<ScanResult, { label: string; className: string }> = {
  admitted: { label: 'Admitted', className: 'bg-green-100 text-green-800 border-green-400' },
  already_used_today: { label: 'Already used today', className: 'bg-amber-100 text-amber-800 border-amber-400' },
  ineligible: { label: 'Not eligible', className: 'bg-red-100 text-red-800 border-red-400' },
  invalid_qr: { label: 'Invalid QR', className: 'bg-red-100 text-red-800 border-red-400' },
  error: { label: 'Error — try again', className: 'bg-red-100 text-red-800 border-red-400' },
};

export function CafeteriaScannerClient() {
  const t = useTranslations('scanner');
  const [lastResult, setLastResult] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);

  const handleDecode = useCallback(async (payload: string) => {
    if (busy) return; // simple re-entrancy guard — no debounce/lock state machine in this phase
    setBusy(true);
    try {
      const res = await fetch('/api/cafeteria-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qrPayload: payload }),
      });
      const body = await res.json();
      setLastResult(body.ok ? body.result.result : 'error');
    } catch {
      setLastResult('error');
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const { videoRef, status } = useQrScanner(handleDecode);

  return (
    <div className="flex flex-col items-center gap-4">
      <video ref={videoRef} className="w-full rounded-lg bg-black" playsInline muted />
      {status !== 'active' && <p className="text-sm text-charcoal/70">{status}</p>}
      {lastResult && (
        <div className={`w-full rounded-md border-2 p-4 text-center text-lg font-semibold ${RESULT_COPY[lastResult].className}`}>
          {RESULT_COPY[lastResult].label}
        </div>
      )}
      <Button onClick={() => setLastResult(null)} disabled={busy}>
        {t('scanNext') ?? 'Scan next'}
      </Button>
    </div>
  );
}
```

(Implementer note: check `useQrScanner`'s actual exported shape against `src/components/scanner/use-qr-scanner.ts` before wiring this up — confirm it returns `videoRef`/`status` as named here, or adjust to match its real API. Confirmed in this plan's background research that its signature is `useQrScanner(onDecode: (payload: string) => void)`, but its full return shape wasn't re-verified against the latest file state — do that first.)

- [ ] **Step 5: Manual verification**

Run the dev server over HTTPS (camera access requires it — check how the existing `/scanner` route is tested locally, likely via a tunnel or `next dev --experimental-https`), confirm a generated cafeteria QR scans and shows the correct result for an eligible first scan, a repeat scan same day, and an ineligible account's QR.

- [ ] **Step 6: Commit**

```bash
git add "src/app/[locale]/scanner/cafeteria/page.tsx" src/components/scanner/cafeteria-scanner-client.tsx src/app/api/cafeteria-scan/route.ts src/lib/cafeteria/lunch-scan.ts
git commit -m "feat: add cafeteria scanner route (simple, non-offline version)"
```

---

### Task 7: Final review and merge

- [ ] Dispatch a final code-reviewer subagent for the entire branch diff against `master`.
- [ ] Use `superpowers:finishing-a-development-branch` to decide merge/PR.
- [ ] Update `docs/pre-launch-checklist.md` with a summary of this feature (new tables, new routes, Phase 2 — coffee-break credit system — explicitly still pending).
