# Cafeteria Coffee Break Credit (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every coffee-break-eligible person (everyone lunch-eligible, plus Speakers) a non-accumulating 50 TL daily credit, deducted in operator-entered amounts at a new, separate scan point, reusing the exact same QR credential Phase 1 already issues.

**Architecture:** One new table (`cafeteria_coffee_scans`, parallel to `cafeteria_lunch_scans`), two new RPCs (a read-only balance check, then a locked deduction — mirroring `cafeteria_lunch_scan_transactional`'s concurrency pattern and its hard-won NULL-safety fix exactly), a new `isCoffeeEligible` function composing the existing `isLunchEligible`, a new `/scanner/coffee` route, and a widened gate on the existing My QR Code cafeteria card so Speakers (who are coffee-eligible but not lunch-eligible) can self-serve a credential.

**Tech Stack:** Next.js 16 App Router, Supabase Postgres (PL/pgSQL), TypeScript, next-intl, Vitest (live DB tests).

---

## Context for every task

- Working directory: `C:\Users\albar\OneDrive\سطح المكتب\COY21\COY21-App\.worktrees\cafeteria-coffee-break`, branch `feature/cafeteria-coffee-break`. `.env.local` present.
- Design spec: `docs/superpowers/specs/2026-10-28-cafeteria-coffee-break-credit-design.md` — went through 3 review rounds, including one real security-sensitive correction (the NULL-safety discipline requirement below). Read it in full before Task 1.
- Supabase project: `vfwcbkjvinbtcntwjrzq` (COY21 production, no dev/staging). Every migration task in this plan follows this session's established split: the implementer writes the migration + its test, then STOPS — the controller applies it live via `supabase db push` after showing the SQL to the human for explicit confirmation, then regenerates `src/types/database.ts`, then the implementer's test is run and the task is committed. Spelled out per-task below.
- **This worktree was freshly branched off `master` after the previous feature branches (`delegate-volunteer-import`, `minor-guardian-info`) were already merged** — `applications.external_delegate_code`/`registration_category` and `guardian_name`/`guardian_phone` already exist in this worktree's schema/types. No rebase needed before starting.
- Known pre-existing `tsc --noEmit` baseline: ~419 errors, confined to `tests/attendance/qr-issuance-reservation.test.ts` and `tests/attendance/qr-credentials-lifecycle-trigger.test.ts`. Any task's typecheck must show zero *new* errors outside those two files.
- **The NULL-safety discipline below is not optional guidance — it is a required pattern, repeated here because Task 3 depends on getting it right.** `cafeteria_lunch_scan_transactional` (`supabase/migrations/20261027130000_cafeteria_lunch_scan_rpc.sql`) had a real security bug during Phase 1: a bare `if not v_eligible` silently fails open when `v_eligible` is SQL NULL rather than `false` (Postgres three-valued logic). The fix, which Task 3's new RPC must replicate exactly: declare the eligibility variable with a `:= false` default (never left at implicit NULL), and gate on `coalesce(v_eligible, false) = false` (never a bare `if not v_eligible`). The new RPC's eligibility expression is an OR of two independently-nullable branches (lunch-eligible-equivalent OR speaker-branch), which is structurally MORE exposed to a stray NULL than the lunch RPC's simpler if/else — making this more necessary here, not less.

---

### Task 1: `isCoffeeEligible` function

**Files:**
- Modify: `src/lib/cafeteria/eligibility.ts` (add new export, do not touch `isLunchEligible`)
- Modify: `src/lib/cafeteria/eligibility.test.ts` (add new test cases)

Pure function, no live DB needed.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/cafeteria/eligibility.test.ts` (read the file first to match its exact existing test fixture/style conventions):

```typescript
describe('isCoffeeEligible', () => {
  it('returns true for everyone isLunchEligible already covers (delegate/volunteer/staff)', () => {
    expect(isCoffeeEligible(
      { participant_type: 'delegate', status: 'accepted', attendance_confirmation: 'confirmed' },
      null
    )).toBe(true);
    expect(isCoffeeEligible(
      { participant_type: 'volunteer', status: 'accepted', attendance_confirmation: 'confirmed' },
      null
    )).toBe(true);
    expect(isCoffeeEligible(null, { role: 'staff' })).toBe(true);
    expect(isCoffeeEligible(null, { role: 'super_admin' })).toBe(true);
  });

  it('returns true for an accepted+confirmed speaker (the one case isLunchEligible excludes)', () => {
    expect(isCoffeeEligible(
      { participant_type: 'speaker', status: 'accepted', attendance_confirmation: 'confirmed' },
      null
    )).toBe(true);
  });

  it('returns false for a speaker not yet accepted+confirmed', () => {
    expect(isCoffeeEligible(
      { participant_type: 'speaker', status: 'accepted', attendance_confirmation: 'pending' },
      null
    )).toBe(false);
    expect(isCoffeeEligible(
      { participant_type: 'speaker', status: 'draft', attendance_confirmation: 'confirmed' },
      null
    )).toBe(false);
  });

  it('returns false for a knowledge_partner (ineligible for both lunch and coffee)', () => {
    expect(isCoffeeEligible(
      { participant_type: 'knowledge_partner', status: 'accepted', attendance_confirmation: 'confirmed' },
      null
    )).toBe(false);
  });

  it('returns false when both application and profile are null', () => {
    expect(isCoffeeEligible(null, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/lib/cafeteria/eligibility.test.ts
```
Expected: fails — `isCoffeeEligible` is not exported yet.

- [ ] **Step 3: Implement**

Add to `src/lib/cafeteria/eligibility.ts` (after the existing `isLunchEligible`, which this calls rather than duplicates):

```typescript
// Coffee-break eligibility (design spec: 2026-10-28-cafeteria-coffee-break-credit-design.md).
// Strict superset of lunch eligibility, plus speaker — the one
// participant_type excluded from lunch but included here per the
// organizing team's explicit decision. Nobody isLunchEligible already
// admits loses eligibility here; this only ever adds one more case.
export function isLunchEligible(...) // unchanged, already above this

export function isCoffeeEligible(
  application: {
    participant_type: Database['public']['Enums']['participant_type'] | null;
    status: Database['public']['Enums']['application_status'];
    attendance_confirmation: Database['public']['Enums']['attendance_confirmation_status'];
  } | null,
  profile: { role: string | null } | null
): boolean {
  if (isLunchEligible(application, profile)) return true;
  return (
    application != null &&
    application.participant_type === 'speaker' &&
    application.status === 'accepted' &&
    application.attendance_confirmation === 'confirmed'
  );
}
```

(The `export function isLunchEligible(...) // unchanged` line above is illustrative only — do not actually duplicate or move the existing function; just add the new `isCoffeeEligible` export after it in the real file.)

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run src/lib/cafeteria/eligibility.test.ts
```
Expected: all pass (existing `isLunchEligible` tests + new `isCoffeeEligible` tests).

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```
Expected: same ~419-error baseline, zero new errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/cafeteria/eligibility.ts src/lib/cafeteria/eligibility.test.ts
git commit -m "feat: add isCoffeeEligible, extending lunch eligibility to include speakers"
```

---

### Task 2a: Database migration — `cafeteria_coffee_scans` table (write only, do not apply)

**Files:**
- Create: `supabase/migrations/20261028130000_cafeteria_coffee_scans.sql`
- Test: `tests/cafeteria/coffee-schema-live.test.ts`

**⚠️ THIS TASK'S JOB IS STEPS 1–2 ONLY.** Do not run the test, do not `supabase db push`, do not regenerate `src/types/database.ts`, do not commit. Report **DONE_WITH_CONCERNS** when Steps 1-2 are done, with the concern "migration + test written, live apply and commit are Task 2b's job, not mine."

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20261028130000_cafeteria_coffee_scans.sql
--
-- Phase 2 of the cafeteria QR feature (coffee-break credit — see
-- docs/superpowers/specs/2026-10-28-cafeteria-coffee-break-credit-design.md).
-- No new credential/QR type: reuses cafeteria_credentials exactly as
-- Phase 1 issues it. This table is parallel to cafeteria_lunch_scans
-- (same credential_id FK shape, same scan_date convention, same
-- RLS posture), but tracks a per-day, non-accumulating 50 TL credit
-- deducted in operator-entered amounts rather than a simple once-per-day
-- admit/deny.
--
-- Remaining balance is never stored as a column -- it's derived live as
-- 50 - sum(amount_deducted) for result='deducted' rows on the current
-- scan_date, computed inside the RPCs in the next migration. This
-- avoids any stored-balance/actual-deductions divergence risk, matching
-- this codebase's existing preference (see cafeteria_lunch_scans) for
-- deriving state from an append-only scan log.
create table cafeteria_coffee_scans (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid not null references cafeteria_credentials(id) on delete cascade,
  scanned_by uuid references profiles(id) on delete set null,
  scanned_at timestamptz not null default now(),
  scan_date date not null, -- Europe/Istanbul calendar date, server-computed, never client-supplied -- identical convention to cafeteria_lunch_scans.scan_date
  amount_deducted numeric(10,2),
  result text not null check (result in ('deducted', 'insufficient_balance', 'ineligible', 'invalid_qr')),
  constraint cafeteria_coffee_scans_amount_only_when_deducted check (
    (result = 'deducted' and amount_deducted is not null and amount_deducted > 0) or
    (result <> 'deducted' and amount_deducted is null)
  )
);

create index cafeteria_coffee_scans_credential_date_idx
  on cafeteria_coffee_scans (credential_id, scan_date)
  where result = 'deducted';

alter table cafeteria_coffee_scans enable row level security;
-- No client-facing policy at all -- identical posture to
-- cafeteria_lunch_scans: written exclusively by the RPCs in the next
-- migration (service-role, which already has full privileges via the
-- existing alter default privileges rule -- see that migration's own
-- comment for the confirmed reasoning, unchanged here), read by nothing
-- in this phase.
revoke all on cafeteria_coffee_scans from authenticated, anon;

-- No explicit service_role grant needed here, same reasoning already
-- verified for cafeteria_lunch_scans and every table since
-- 20261006080000_fix_missing_service_role_grants.sql.
```

- [ ] **Step 2: Write a live test proving the table exists with the right constraints**

```typescript
// tests/cafeteria/coffee-schema-live.test.ts
//
// Minimal live-schema proof for cafeteria_coffee_scans, mirroring
// tests/cafeteria/schema-live.test.ts's shape (the Phase 1 lunch table's
// own schema test).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import { generateCafeteriaToken, hashCafeteriaToken } from '@/lib/cafeteria/token';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

function toByteaHex(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`;
}

vi.setConfig({ testTimeout: 30000 });

const runId = randomUUID().slice(0, 8);
let applicantUserId: string;
let applicationId: string;
let credentialId: string;

beforeAll(async () => {
  const { data: user, error } = await admin.auth.admin.createUser({
    email: `coffee-schema-${runId}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  if (error || !user.user) throw new Error(`fixture user setup failed: ${error?.message}`);
  applicantUserId = user.user.id;

  const { data: app, error: appError } = await admin.from('applications').insert({
    applicant_id: applicantUserId, status: 'accepted', participant_type: 'delegate', attendance_confirmation: 'confirmed',
  }).select('id').single();
  if (appError || !app) throw new Error(`application fixture setup failed: ${appError?.message}`);
  applicationId = app.id;

  const tok = generateCafeteriaToken();
  const { data: cred, error: credError } = await admin.from('cafeteria_credentials').insert({
    application_id: applicationId, token_hash: toByteaHex(hashCafeteriaToken(tok.rawToken)) as unknown as never,
    qr_image_data_uri: 'data:image/png;base64,TEST',
  }).select('id').single();
  if (credError || !cred) throw new Error(`credential fixture setup failed: ${credError?.message}`);
  credentialId = cred.id;
});

afterAll(async () => {
  if (credentialId) await admin.from('cafeteria_coffee_scans').delete().eq('credential_id', credentialId);
  if (credentialId) await admin.from('cafeteria_credentials').delete().eq('id', credentialId);
  if (applicationId) await admin.from('applications').delete().eq('id', applicationId);
  if (applicantUserId) await admin.auth.admin.deleteUser(applicantUserId);
});

describe('cafeteria_coffee_scans', () => {
  it('accepts a deducted row with a positive amount', async () => {
    const { data, error } = await admin.from('cafeteria_coffee_scans').insert({
      credential_id: credentialId, scan_date: '2026-11-05', result: 'deducted', amount_deducted: 15,
    }).select('id, amount_deducted').single();
    expect(error).toBeNull();
    expect(data!.amount_deducted).toBe('15.00');
  });

  it('rejects a deducted row with a null/zero amount', async () => {
    const { error } = await admin.from('cafeteria_coffee_scans').insert({
      credential_id: credentialId, scan_date: '2026-11-05', result: 'deducted', amount_deducted: 0,
    });
    expect(error).not.toBeNull();
  });

  it('rejects a non-deducted row that has an amount set', async () => {
    const { error } = await admin.from('cafeteria_coffee_scans').insert({
      credential_id: credentialId, scan_date: '2026-11-05', result: 'ineligible', amount_deducted: 10,
    });
    expect(error).not.toBeNull();
  });

  it('accepts a non-deducted row with no amount', async () => {
    const { data, error } = await admin.from('cafeteria_coffee_scans').insert({
      credential_id: credentialId, scan_date: '2026-11-05', result: 'insufficient_balance',
    }).select('id, amount_deducted').single();
    expect(error).toBeNull();
    expect(data!.amount_deducted).toBeNull();
  });
});
```

This ends Task 2a. Report DONE_WITH_CONCERNS now — do not continue to the steps below.

---

### Task 2b: Apply migration live, verify, commit (controller only — NOT a subagent task)

Executed by the controller directly in the main session. Depends on Task 2a.

- [ ] **Step 1: Show the migration SQL to the human and get explicit confirmation.**
- [ ] **Step 2: Apply it live**

```bash
SUPABASE_ACCESS_TOKEN="<fresh token>" npx supabase db push --yes
```

(If this worktree's `supabase/.temp/project-ref` isn't linked yet, run `SUPABASE_ACCESS_TOKEN="<token>" npx supabase link --project-ref vfwcbkjvinbtcntwjrzq` first — this session's established pattern for a fresh worktree. If `db push` reports "Remote migration versions not found in local migrations directory," another branch's already-applied-but-locally-absent migration file is the cause, not a real divergence — temporarily copy the missing migration file in from whichever other worktree has it, confirm `supabase migration list` shows everything in sync except this task's own new migration, push, then remove the borrowed file again before committing. This exact situation has recurred multiple times this session across parallel worktrees; it is not a sign of a real problem.)

- [ ] **Step 3: Regenerate types**

```bash
SUPABASE_ACCESS_TOKEN="<fresh token>" npx supabase gen types typescript --project-id vfwcbkjvinbtcntwjrzq > src/types/database.ts
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run tests/cafeteria/coffee-schema-live.test.ts
```
Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261028130000_cafeteria_coffee_scans.sql tests/cafeteria/coffee-schema-live.test.ts src/types/database.ts
git commit -m "feat: add cafeteria_coffee_scans table"
```

Only after this commit lands may Task 3 (which depends on the live table) begin.

---

### Task 3a: Database migration — the two coffee-break RPCs (write only, do not apply)

**Files:**
- Create: `supabase/migrations/20261028140000_cafeteria_coffee_rpcs.sql`
- Test: `tests/cafeteria/coffee-rpc-live.test.ts`

**Depends on Task 2b.** This is the highest-risk task in this plan — read the "NULL-safety discipline" paragraph in "Context for every task" again before writing a single line of SQL.

**⚠️ STEPS 1–2 ONLY. Report DONE_WITH_CONCERNS, do not apply/commit.**

- [ ] **Step 1: Write the migration**

Both RPCs re-derive eligibility as an OR of two independently-nullable sub-expressions. Declare and gate on eligibility using the exact fail-closed pattern from `cafeteria_lunch_scan_transactional` (`supabase/migrations/20261027130000_cafeteria_lunch_scan_rpc.sql`, read it again now if you haven't in this task): `v_eligible boolean := false` default, `coalesce(v_eligible, false) = false` gate, never a bare `if not v_eligible`.

```sql
-- supabase/migrations/20261028140000_cafeteria_coffee_rpcs.sql
--
-- Two RPCs for the coffee-break credit flow (design spec:
-- 2026-10-28-cafeteria-coffee-break-credit-design.md's "Scan Flow — Two
-- RPCs, Not One" section). A single combined RPC can't support the
-- required UX (show remaining balance BEFORE the operator enters an
-- amount), so this is a read-only balance check followed by a separate,
-- locked deduction.
--
-- NULL-safety: both functions declare v_eligible with a `:= false`
-- default and gate on `coalesce(v_eligible, false) = false` -- never a
-- bare `if not v_eligible` -- mirroring cafeteria_lunch_scan_transactional's
-- fix for a real NULL-bypass bug found during Phase 1 (three-valued
-- logic: `not NULL` evaluates to NULL, not true, silently skipping a
-- rejection branch). This feature's eligibility expression (lunch-
-- eligible-equivalent OR speaker-branch) is an OR of two independently-
-- nullable sub-expressions, structurally MORE exposed to a stray NULL
-- than the lunch RPC's simpler if/else -- making this more necessary
-- here, not less.

-- 1. Read-only balance check. Writes nothing -- a device re-scanning the
--    same code twice while an operator decides on an amount never
--    double-counts or creates a spurious audit row.
create or replace function cafeteria_coffee_check_balance(
  p_token_hash bytea
) returns table (eligible boolean, remaining_balance numeric)
language plpgsql
as $$
declare
  v_credential cafeteria_credentials%rowtype;
  v_scan_date date;
  v_eligible boolean := false;
  v_participant_type text;
  v_app_status text;
  v_attendance_confirmation text;
  v_profile_role text;
  v_deducted_today numeric;
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'cafeteria_coffee_check_balance called with a malformed token_hash -- caller must resolve the credential before calling this function';
  end if;

  select * into v_credential from cafeteria_credentials where token_hash = p_token_hash;
  if v_credential.id is null then
    raise exception 'cafeteria_coffee_check_balance called with a token_hash matching no credential -- caller must resolve the credential before calling this function';
  end if;

  v_scan_date := (now() at time zone 'Europe/Istanbul')::date;

  -- Live eligibility re-check -- isCoffeeEligible's logic, re-implemented
  -- in SQL (OR of lunch-eligible-equivalent and speaker-branch), never
  -- trusted from issuance time. Same application_id/profile_id branching
  -- as cafeteria_lunch_scan_transactional.
  if v_credential.application_id is not null then
    select participant_type, status, attendance_confirmation
      into v_participant_type, v_app_status, v_attendance_confirmation
      from applications where id = v_credential.application_id;
    v_eligible := (
      v_participant_type in ('delegate', 'volunteer')
      and v_app_status = 'accepted'
      and v_attendance_confirmation = 'confirmed'
    ) or (
      v_participant_type = 'speaker'
      and v_app_status = 'accepted'
      and v_attendance_confirmation = 'confirmed'
    );
  else
    select role into v_profile_role from profiles where id = v_credential.profile_id;
    v_eligible := v_profile_role in ('staff', 'super_admin');
  end if;

  if coalesce(v_eligible, false) = false then
    return query select false, 0::numeric;
    return;
  end if;

  select coalesce(sum(amount_deducted), 0) into v_deducted_today
    from cafeteria_coffee_scans
    where credential_id = v_credential.id and scan_date = v_scan_date and result = 'deducted';

  return query select true, (50 - v_deducted_today)::numeric;
end;
$$;

comment on function cafeteria_coffee_check_balance(bytea) is
  'Read-only eligibility + remaining-balance check for the coffee-break credit flow. Writes nothing. Re-checks eligibility live (not cached from issuance).';

revoke all on function cafeteria_coffee_check_balance(bytea) from public, anon, authenticated;

-- 2. The actual write -- locked deduction. Mirrors
--    cafeteria_lunch_scan_transactional's concurrency pattern exactly
--    (pg_try_advisory_xact_lock, bounded retry, same LOCK_CONTENTION:
--    exception shape), keyed per-credential.
create or replace function cafeteria_coffee_deduct_transactional(
  p_token_hash bytea,
  p_scanned_by uuid,
  p_amount numeric
) returns cafeteria_coffee_scans
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
  v_eligible boolean := false;
  v_participant_type text;
  v_app_status text;
  v_attendance_confirmation text;
  v_profile_role text;
  v_deducted_today numeric;
  v_remaining numeric;
  v_result text;
  v_scan cafeteria_coffee_scans%rowtype;
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'cafeteria_coffee_deduct_transactional called with a malformed token_hash -- caller must resolve the credential before calling this function';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'cafeteria_coffee_deduct_transactional called with a non-positive amount -- caller must validate the amount before calling this function';
  end if;

  select * into v_credential from cafeteria_credentials where token_hash = p_token_hash;
  if v_credential.id is null then
    raise exception 'cafeteria_coffee_deduct_transactional called with a token_hash matching no credential -- caller must resolve the credential before calling this function';
  end if;

  v_lock_key := hashtext('cafeteria-coffee:' || v_credential.id::text);

  loop
    v_lock_acquired := pg_try_advisory_xact_lock(v_lock_key);
    exit when v_lock_acquired or v_retry_count >= v_max_retries;
    v_retry_count := v_retry_count + 1;
    perform pg_sleep(v_retry_delay_seconds);
  end loop;

  if not v_lock_acquired then
    raise exception 'LOCK_CONTENTION: Another coffee-break deduction for this credential is still being processed after % retries — please retry manually', v_max_retries;
  end if;

  v_scan_date := (now() at time zone 'Europe/Istanbul')::date;

  -- Live eligibility re-check, inside the lock -- not trusting the
  -- balance-check call's earlier read, since time has passed and
  -- another device could have deducted in between.
  if v_credential.application_id is not null then
    select participant_type, status, attendance_confirmation
      into v_participant_type, v_app_status, v_attendance_confirmation
      from applications where id = v_credential.application_id;
    v_eligible := (
      v_participant_type in ('delegate', 'volunteer')
      and v_app_status = 'accepted'
      and v_attendance_confirmation = 'confirmed'
    ) or (
      v_participant_type = 'speaker'
      and v_app_status = 'accepted'
      and v_attendance_confirmation = 'confirmed'
    );
  else
    select role into v_profile_role from profiles where id = v_credential.profile_id;
    v_eligible := v_profile_role in ('staff', 'super_admin');
  end if;

  if coalesce(v_eligible, false) = false then
    insert into cafeteria_coffee_scans (credential_id, scanned_by, scan_date, result)
    values (v_credential.id, p_scanned_by, v_scan_date, 'ineligible')
    returning * into v_scan;
    return v_scan;
  end if;

  select coalesce(sum(amount_deducted), 0) into v_deducted_today
    from cafeteria_coffee_scans
    where credential_id = v_credential.id and scan_date = v_scan_date and result = 'deducted';
  v_remaining := 50 - v_deducted_today;

  if p_amount > v_remaining then
    insert into cafeteria_coffee_scans (credential_id, scanned_by, scan_date, result)
    values (v_credential.id, p_scanned_by, v_scan_date, 'insufficient_balance')
    returning * into v_scan;
    return v_scan;
  end if;

  insert into cafeteria_coffee_scans (credential_id, scanned_by, scan_date, amount_deducted, result)
  values (v_credential.id, p_scanned_by, v_scan_date, p_amount, 'deducted')
  returning * into v_scan;
  return v_scan;
end;
$$;

comment on function cafeteria_coffee_deduct_transactional(bytea, uuid, numeric) is
  'Sole write authority for cafeteria_coffee_scans. Re-checks eligibility and remaining balance live inside an advisory-locked transaction (retry-until-decided, matching cafeteria_lunch_scan_transactional), keyed per-credential. Rejects a deduction exceeding the remaining balance in full -- never partially honored.';

revoke all on function cafeteria_coffee_deduct_transactional(bytea, uuid, numeric) from public, anon, authenticated;

-- No explicit service_role grants needed for either function -- same
-- reasoning already verified for cafeteria_lunch_scan_transactional
-- (this migration postdates 20261006080000_fix_missing_service_role_grants.sql).
```

- [ ] **Step 2: Write a live test**

```typescript
// tests/cafeteria/coffee-rpc-live.test.ts
//
// Fixture pattern mirrors tests/cafeteria/lunch-scan-rpc-live.test.ts
// exactly: real Supabase Auth users, real applications rows, afterAll
// cleanup in FK-dependency order.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';
import { generateCafeteriaToken, hashCafeteriaToken } from '@/lib/cafeteria/token';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

function toByteaHex(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`;
}

vi.setConfig({ testTimeout: 30000 });

const runId = randomUUID().slice(0, 8);
let scannerUserId: string;
let delegateUserId: string;
let delegateApplicationId: string;
let delegateCredentialId: string;
let delegateRawToken: Buffer;
let speakerUserId: string;
let speakerApplicationId: string;
let speakerCredentialId: string;
let speakerRawToken: Buffer;
let kpUserId: string;
let kpApplicationId: string;
let kpCredentialId: string;
let kpRawToken: Buffer;
// Concurrent-deduction test's fixtures: assigned immediately on creation
// (not batched) so the unconditional afterAll sweep can still clean them
// up even if an assertion throws first -- same precedent as
// lunch-scan-rpc-live.test.ts's own concurrent-test fixture handling.
let concurrentUserId: string | undefined;
let concurrentApplicationId: string | undefined;
let concurrentCredentialId: string | undefined;

beforeAll(async () => {
  const { data: scanner, error: scannerError } = await admin.auth.admin.createUser({
    email: `coffee-rpc-${runId}-scanner@test.local`, password: 'password123', email_confirm: true,
  });
  if (scannerError || !scanner.user) throw new Error(`scanner setup failed: ${scannerError?.message}`);
  scannerUserId = scanner.user.id;
  await admin.from('profiles').update({ role: 'scanner_device' }).eq('id', scannerUserId);

  const { data: delegate, error: delegateError } = await admin.auth.admin.createUser({
    email: `coffee-rpc-${runId}-delegate@test.local`, password: 'password123', email_confirm: true,
  });
  if (delegateError || !delegate.user) throw new Error(`delegate setup failed: ${delegateError?.message}`);
  delegateUserId = delegate.user.id;
  const { data: delegateApp, error: delegateAppError } = await admin.from('applications').insert({
    applicant_id: delegateUserId, status: 'accepted', participant_type: 'delegate', attendance_confirmation: 'confirmed',
  }).select('id').single();
  if (delegateAppError || !delegateApp) throw new Error(`delegate application setup failed: ${delegateAppError?.message}`);
  delegateApplicationId = delegateApp.id;
  const delegateTok = generateCafeteriaToken();
  delegateRawToken = delegateTok.rawToken;
  const { data: delegateCred, error: delegateCredError } = await admin.from('cafeteria_credentials').insert({
    application_id: delegateApplicationId, token_hash: toByteaHex(hashCafeteriaToken(delegateTok.rawToken)) as unknown as never,
    qr_image_data_uri: 'data:image/png;base64,TEST',
  }).select('id').single();
  if (delegateCredError || !delegateCred) throw new Error(`delegate credential setup failed: ${delegateCredError?.message}`);
  delegateCredentialId = delegateCred.id;

  // Speaker -- coffee-eligible, NOT lunch-eligible. This fixture is the
  // one case that proves isCoffeeEligible's speaker branch is actually
  // wired into the RPC, not just the TypeScript helper.
  const { data: speaker, error: speakerError } = await admin.auth.admin.createUser({
    email: `coffee-rpc-${runId}-speaker@test.local`, password: 'password123', email_confirm: true,
  });
  if (speakerError || !speaker.user) throw new Error(`speaker setup failed: ${speakerError?.message}`);
  speakerUserId = speaker.user.id;
  const { data: speakerApp, error: speakerAppError } = await admin.from('applications').insert({
    applicant_id: speakerUserId, status: 'accepted', participant_type: 'speaker', attendance_confirmation: 'confirmed',
  }).select('id').single();
  if (speakerAppError || !speakerApp) throw new Error(`speaker application setup failed: ${speakerAppError?.message}`);
  speakerApplicationId = speakerApp.id;
  const speakerTok = generateCafeteriaToken();
  speakerRawToken = speakerTok.rawToken;
  const { data: speakerCred, error: speakerCredError } = await admin.from('cafeteria_credentials').insert({
    application_id: speakerApplicationId, token_hash: toByteaHex(hashCafeteriaToken(speakerTok.rawToken)) as unknown as never,
    qr_image_data_uri: 'data:image/png;base64,TEST',
  }).select('id').single();
  if (speakerCredError || !speakerCred) throw new Error(`speaker credential setup failed: ${speakerCredError?.message}`);
  speakerCredentialId = speakerCred.id;

  // Knowledge partner -- ineligible for both lunch and coffee.
  const { data: kp, error: kpError } = await admin.auth.admin.createUser({
    email: `coffee-rpc-${runId}-kp@test.local`, password: 'password123', email_confirm: true,
  });
  if (kpError || !kp.user) throw new Error(`kp setup failed: ${kpError?.message}`);
  kpUserId = kp.user.id;
  const { data: kpApp, error: kpAppError } = await admin.from('applications').insert({
    applicant_id: kpUserId, status: 'accepted', participant_type: 'knowledge_partner', attendance_confirmation: 'confirmed',
  }).select('id').single();
  if (kpAppError || !kpApp) throw new Error(`kp application setup failed: ${kpAppError?.message}`);
  kpApplicationId = kpApp.id;
  const kpTok = generateCafeteriaToken();
  kpRawToken = kpTok.rawToken;
  const { data: kpCred, error: kpCredError } = await admin.from('cafeteria_credentials').insert({
    application_id: kpApplicationId, token_hash: toByteaHex(hashCafeteriaToken(kpTok.rawToken)) as unknown as never,
    qr_image_data_uri: 'data:image/png;base64,TEST',
  }).select('id').single();
  if (kpCredError || !kpCred) throw new Error(`kp credential setup failed: ${kpCredError?.message}`);
  kpCredentialId = kpCred.id;
});

afterAll(async () => {
  const credentialIds = [delegateCredentialId, speakerCredentialId, kpCredentialId, concurrentCredentialId].filter(Boolean) as string[];
  const applicationIds = [delegateApplicationId, speakerApplicationId, kpApplicationId, concurrentApplicationId].filter(Boolean) as string[];
  const userIds = [scannerUserId, delegateUserId, speakerUserId, kpUserId, concurrentUserId].filter(Boolean) as string[];

  await admin.from('cafeteria_coffee_scans').delete().in('credential_id', credentialIds);
  await admin.from('cafeteria_credentials').delete().in('id', credentialIds);
  await admin.from('applications').delete().in('id', applicationIds);
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id);
  }
});

describe('cafeteria_coffee_check_balance', () => {
  it('returns eligible=true and remaining_balance=50 for a fresh delegate credential', async () => {
    const { data, error } = await admin.rpc('cafeteria_coffee_check_balance', {
      p_token_hash: toByteaHex(hashCafeteriaToken(delegateRawToken)),
    });
    expect(error).toBeNull();
    expect(data![0].eligible).toBe(true);
    expect(Number(data![0].remaining_balance)).toBe(50);
  });

  it('returns eligible=true for a speaker credential (the lunch-ineligible case)', async () => {
    const { data, error } = await admin.rpc('cafeteria_coffee_check_balance', {
      p_token_hash: toByteaHex(hashCafeteriaToken(speakerRawToken)),
    });
    expect(error).toBeNull();
    expect(data![0].eligible).toBe(true);
  });

  it('returns eligible=false for a knowledge_partner credential', async () => {
    const { data, error } = await admin.rpc('cafeteria_coffee_check_balance', {
      p_token_hash: toByteaHex(hashCafeteriaToken(kpRawToken)),
    });
    expect(error).toBeNull();
    expect(data![0].eligible).toBe(false);
  });
});

describe('cafeteria_coffee_deduct_transactional', () => {
  it('deducts a valid amount within balance', async () => {
    const { data, error } = await admin.rpc('cafeteria_coffee_deduct_transactional', {
      p_token_hash: toByteaHex(hashCafeteriaToken(delegateRawToken)), p_scanned_by: scannerUserId, p_amount: 15,
    });
    expect(error).toBeNull();
    expect(data?.result).toBe('deducted');
    expect(Number(data?.amount_deducted)).toBe(15);
  });

  it('reflects the reduced balance on a subsequent check', async () => {
    const { data } = await admin.rpc('cafeteria_coffee_check_balance', {
      p_token_hash: toByteaHex(hashCafeteriaToken(delegateRawToken)),
    });
    expect(Number(data![0].remaining_balance)).toBe(35);
  });

  it('allows a second deduction within the remaining balance', async () => {
    const { data, error } = await admin.rpc('cafeteria_coffee_deduct_transactional', {
      p_token_hash: toByteaHex(hashCafeteriaToken(delegateRawToken)), p_scanned_by: scannerUserId, p_amount: 20,
    });
    expect(error).toBeNull();
    expect(data?.result).toBe('deducted');
  });

  it('rejects a deduction exceeding the remaining balance IN FULL, not partially', async () => {
    // 50 already spent: 15 + 20 = 35, so 15 remains. Requesting 20 must fail outright.
    const { data, error } = await admin.rpc('cafeteria_coffee_deduct_transactional', {
      p_token_hash: toByteaHex(hashCafeteriaToken(delegateRawToken)), p_scanned_by: scannerUserId, p_amount: 20,
    });
    expect(error).toBeNull();
    expect(data?.result).toBe('insufficient_balance');
    expect(data?.amount_deducted).toBeNull();

    // Confirm the balance is unchanged by the rejected attempt (still 15, not reduced).
    const { data: balanceCheck } = await admin.rpc('cafeteria_coffee_check_balance', {
      p_token_hash: toByteaHex(hashCafeteriaToken(delegateRawToken)),
    });
    expect(Number(balanceCheck![0].remaining_balance)).toBe(15);
  });

  it('a knowledge_partner credential deducts as ineligible, never succeeds', async () => {
    const { data, error } = await admin.rpc('cafeteria_coffee_deduct_transactional', {
      p_token_hash: toByteaHex(hashCafeteriaToken(kpRawToken)), p_scanned_by: scannerUserId, p_amount: 10,
    });
    expect(error).toBeNull();
    expect(data?.result).toBe('ineligible');
  });

  it('two concurrent deductions that together exceed the balance resolve to exactly one succeeding', async () => {
    const tok = generateCafeteriaToken();
    const { data: applicant2, error: a2Error } = await admin.auth.admin.createUser({
      email: `coffee-rpc-${runId}-concur@test.local`, password: 'password123', email_confirm: true,
    });
    if (a2Error || !applicant2.user) throw new Error('concurrent fixture setup failed');
    concurrentUserId = applicant2.user.id;
    const { data: app2 } = await admin.from('applications').insert({
      applicant_id: applicant2.user.id, status: 'accepted', participant_type: 'volunteer', attendance_confirmation: 'confirmed',
    }).select('id').single();
    concurrentApplicationId = app2!.id;
    const { data: cred2 } = await admin.from('cafeteria_credentials').insert({
      application_id: app2!.id, token_hash: toByteaHex(hashCafeteriaToken(tok.rawToken)) as unknown as never,
      qr_image_data_uri: 'data:image/png;base64,TEST',
    }).select('id').single();
    concurrentCredentialId = cred2!.id;

    // Two concurrent deductions of 30 each against a 50 balance -- only one can succeed.
    const [r1, r2] = await Promise.all([
      admin.rpc('cafeteria_coffee_deduct_transactional', { p_token_hash: toByteaHex(hashCafeteriaToken(tok.rawToken)), p_scanned_by: scannerUserId, p_amount: 30 }),
      admin.rpc('cafeteria_coffee_deduct_transactional', { p_token_hash: toByteaHex(hashCafeteriaToken(tok.rawToken)), p_scanned_by: scannerUserId, p_amount: 30 }),
    ]);
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();
    const results = [r1.data?.result, r2.data?.result].sort();
    expect(results).toEqual(['deducted', 'insufficient_balance']);
  });
});
```

This ends Task 3a. Report DONE_WITH_CONCERNS now — do not continue to the steps below.

---

### Task 3b: Apply RPC migration live, verify, commit (controller only — NOT a subagent task)

Same controller-only pattern as Task 2b. Depends on Task 3a.

- [ ] **Step 1: Show the full migration SQL to the human and get explicit confirmation** — read it carefully yourself first, specifically confirming both RPCs' `v_eligible` declaration and gate match the required NULL-safety pattern exactly (this is the one thing in this plan most worth double-checking before applying to production).
- [ ] **Step 2: Apply it live** (`supabase db push --yes`, fresh token if needed, same borrowed-migration-file caveat as Task 2b if it recurs).
- [ ] **Step 3: Run the live test**

```bash
npx vitest run tests/cafeteria/coffee-rpc-live.test.ts
```
Expected: all pass (3 balance-check cases + 6 deduction cases, including the concurrency test).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20261028140000_cafeteria_coffee_rpcs.sql tests/cafeteria/coffee-rpc-live.test.ts
git commit -m "feat: add cafeteria_coffee_check_balance and cafeteria_coffee_deduct_transactional RPCs"
```

---

### Task 4: Library code + API routes

**Files:**
- Create: `src/lib/cafeteria/coffee-scan.ts`
- Create: `src/lib/cafeteria/coffee-scan.test.ts` (unit tests for payload-parsing/error-shape behavior that don't need live DB — the RPC behavior itself is already covered by Task 3's live tests)
- Create: `src/app/api/cafeteria-coffee-balance/route.ts`
- Create: `src/app/api/cafeteria-coffee-deduct/route.ts`

**Depends on Task 3b** (needs the live RPCs and regenerated types).

- [ ] **Step 1: Read the exact files to mirror first**

Read `src/lib/cafeteria/lunch-scan.ts` and `src/app/api/cafeteria-scan/route.ts` in full — both are mirrored closely by this task.

- [ ] **Step 2: Implement `src/lib/cafeteria/coffee-scan.ts`**

```typescript
// src/lib/cafeteria/coffee-scan.ts
//
// Trusted server boundary for the coffee-break credit flow — mirrors
// src/lib/cafeteria/lunch-scan.ts's shape exactly, but exposes two
// functions (balance check, then deduction) instead of one, matching
// the two-RPC design (design spec's "Scan Flow — Two RPCs, Not One").
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { parseCanonicalCafeteriaPayload, hashCafeteriaToken } from './token';

type ServiceClient = SupabaseClient<Database>;

export interface CoffeeBalanceResult {
  eligible: boolean;
  remainingBalance: number | null; // null only when eligible=false (no meaningful balance to show)
}

export interface CoffeeDeductionResult {
  result: 'deducted' | 'insufficient_balance' | 'ineligible' | 'invalid_qr';
  amountDeducted: number | null;
  scanId: string | null;
}

// Same bytea-encoding convention this codebase has in four other places
// (src/lib/cafeteria/lunch-scan.ts, credential-issuance.ts,
// src/lib/attendance/qr-credential-issuance.ts, scan-qr-attempt.ts) --
// NOT consolidated here, per the design spec's explicit scope note
// (already-known, already-deferred cleanup).
function toByteaHex(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`;
}

async function resolveCredentialId(
  qrPayload: string,
  service: ServiceClient
): Promise<{ ok: true; credentialId: string } | { ok: false }> {
  const parsed = parseCanonicalCafeteriaPayload(qrPayload);
  if (!parsed.ok) return { ok: false };

  const tokenHashHex = toByteaHex(hashCafeteriaToken(parsed.rawToken));
  const { data: credential } = await service.from('cafeteria_credentials').select('id').eq('token_hash', tokenHashHex).maybeSingle();
  if (!credential) return { ok: false };

  return { ok: true, credentialId: credential.id };
}

export async function checkCafeteriaCoffeeBalanceForCaller(
  params: { qrPayload: string },
  caller: { service: ServiceClient }
): Promise<{ ok: true; result: CoffeeBalanceResult | { eligible: false; remainingBalance: null; invalidQr: true } } | { ok: false; message: string }> {
  const parsed = parseCanonicalCafeteriaPayload(params.qrPayload);
  if (!parsed.ok) {
    return { ok: true, result: { eligible: false, remainingBalance: null, invalidQr: true } };
  }

  const tokenHashHex = toByteaHex(hashCafeteriaToken(parsed.rawToken));
  const { data: credential, error: credError } = await caller.service
    .from('cafeteria_credentials')
    .select('id')
    .eq('token_hash', tokenHashHex)
    .maybeSingle();
  if (credError) return { ok: false, message: credError.message };
  if (!credential) {
    return { ok: true, result: { eligible: false, remainingBalance: null, invalidQr: true } };
  }

  const { data, error } = await caller.service.rpc('cafeteria_coffee_check_balance', { p_token_hash: tokenHashHex });
  if (error) return { ok: false, message: error.message };

  const row = data?.[0];
  return {
    ok: true,
    result: { eligible: row?.eligible ?? false, remainingBalance: row?.eligible ? Number(row.remaining_balance) : null },
  };
}

export async function confirmCafeteriaCoffeeDeductionForCaller(
  params: { qrPayload: string; amount: number },
  caller: { userId: string; service: ServiceClient }
): Promise<{ ok: true; result: CoffeeDeductionResult } | { ok: false; message: string }> {
  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    return { ok: false, message: 'Amount must be a positive number' };
  }

  const parsed = parseCanonicalCafeteriaPayload(params.qrPayload);
  if (!parsed.ok) {
    return { ok: true, result: { result: 'invalid_qr', amountDeducted: null, scanId: null } };
  }

  const tokenHashHex = toByteaHex(hashCafeteriaToken(parsed.rawToken));
  const { data: credential, error: credError } = await caller.service
    .from('cafeteria_credentials')
    .select('id')
    .eq('token_hash', tokenHashHex)
    .maybeSingle();
  if (credError) return { ok: false, message: credError.message };
  if (!credential) {
    return { ok: true, result: { result: 'invalid_qr', amountDeducted: null, scanId: null } };
  }

  const { data, error } = await caller.service.rpc('cafeteria_coffee_deduct_transactional', {
    p_token_hash: tokenHashHex,
    p_scanned_by: caller.userId,
    p_amount: params.amount,
  });
  if (error) return { ok: false, message: error.message };

  return {
    ok: true,
    result: {
      result: data.result as CoffeeDeductionResult['result'],
      amountDeducted: data.amount_deducted !== null ? Number(data.amount_deducted) : null,
      scanId: data.id,
    },
  };
}
```

(`resolveCredentialId` above is written but not actually wired into the two exported functions in this draft — both inline the same resolution logic directly, matching `lunch-scan.ts`'s own style of not extracting a shared helper for a two-call-site duplication. The implementer may either keep the duplication, matching precedent exactly, or use the small helper to avoid it — both are acceptable; note the choice made in the commit.)

- [ ] **Step 3: Write unit tests for the non-DB-dependent behavior**

```typescript
// src/lib/cafeteria/coffee-scan.test.ts
//
// Pure/mocked-boundary tests only -- the RPCs' actual eligibility/
// balance/concurrency behavior is already covered live in
// tests/cafeteria/coffee-rpc-live.test.ts. This file only proves the
// library-layer payload-parsing and amount-validation guards.
import { describe, it, expect } from 'vitest';
import { confirmCafeteriaCoffeeDeductionForCaller } from './coffee-scan';

describe('confirmCafeteriaCoffeeDeductionForCaller', () => {
  it('rejects a non-positive amount before ever resolving a credential or calling the RPC', async () => {
    const result = await confirmCafeteriaCoffeeDeductionForCaller(
      { qrPayload: 'cafe:v1:anything', amount: 0 },
      { userId: 'irrelevant', service: {} as never }
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a negative amount', async () => {
    const result = await confirmCafeteriaCoffeeDeductionForCaller(
      { qrPayload: 'cafe:v1:anything', amount: -5 },
      { userId: 'irrelevant', service: {} as never }
    );
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 4: API routes**

```typescript
// src/app/api/cafeteria-coffee-balance/route.ts
//
// Thin Route Handler, mirrors src/app/api/cafeteria-scan/route.ts's
// shape exactly.
import { NextResponse } from 'next/server';
import { checkCafeteriaCoffeeBalanceForCaller } from '@/lib/cafeteria/coffee-scan';
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

    const outcome = await checkCafeteriaCoffeeBalanceForCaller({ qrPayload }, caller);
    return NextResponse.json(outcome, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false, message: 'Unexpected error' }, { status: 200 });
  }
}
```

```typescript
// src/app/api/cafeteria-coffee-deduct/route.ts
import { NextResponse } from 'next/server';
import { confirmCafeteriaCoffeeDeductionForCaller } from '@/lib/cafeteria/coffee-scan';
import { requireScannerDeviceCaller } from '@/lib/scanner-device/server-helpers';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { qrPayload, amount } = body ?? {};
    if (typeof qrPayload !== 'string' || typeof amount !== 'number') {
      return NextResponse.json({ ok: false, message: 'Invalid request' }, { status: 200 });
    }

    let caller;
    try {
      caller = await requireScannerDeviceCaller();
    } catch (err) {
      return NextResponse.json({ ok: false, message: err instanceof Error ? err.message : 'Not authorized' }, { status: 200 });
    }

    const outcome = await confirmCafeteriaCoffeeDeductionForCaller({ qrPayload, amount }, caller);
    return NextResponse.json(outcome, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false, message: 'Unexpected error' }, { status: 200 });
  }
}
```

- [ ] **Step 5: Run and typecheck**

```bash
npx vitest run src/lib/cafeteria/coffee-scan.test.ts
npx tsc --noEmit
```
Expected: 2/2 pass, same ~419-error baseline.

- [ ] **Step 6: Commit**

```bash
git add src/lib/cafeteria/coffee-scan.ts src/lib/cafeteria/coffee-scan.test.ts src/app/api/cafeteria-coffee-balance/route.ts src/app/api/cafeteria-coffee-deduct/route.ts
git commit -m "feat: add coffee-break balance-check and deduction library/API routes"
```

---

### Task 5: i18n keys

**Files:**
- Modify: `src/messages/en.json`, `src/messages/ar.json`

**Depends on nothing else, can run any time** — purely additive translation keys, no code dependency.

- [ ] **Step 1: Add to both files**

Under `scanner.cafeteria` (sibling of the existing `scanner.cafeteria.result.*`), add a new `coffee` block:

```json
"coffee": {
  "scanInstruction": "Scan the participant's QR to check their coffee-break balance.",
  "eligibleBalance": "Remaining today: {amount} TL",
  "noBalanceRemaining": "No coffee-break balance remaining today.",
  "amountLabel": "Amount (TL)",
  "confirmButton": "Confirm deduction",
  "scanNext": "Scan next",
  "result": {
    "deducted": {
      "headline": "Deducted",
      "instruction": "{amount} TL deducted. New balance: {remaining} TL."
    },
    "insufficient_balance": {
      "headline": "Insufficient balance",
      "instruction": "This participant does not have enough balance remaining today for this amount."
    },
    "ineligible": {
      "headline": "Not eligible",
      "instruction": "This participant is not eligible for coffee-break credit."
    },
    "invalid_qr": {
      "headline": "Invalid QR",
      "instruction": "Ask the participant to show their current cafeteria QR."
    },
    "error": {
      "headline": "Error",
      "instruction": "Something went wrong. Please try again."
    }
  }
}
```

Arabic (`ar.json`), same structure, real translated copy (not placeholder) — e.g.:

```json
"coffee": {
  "scanInstruction": "امسح رمز QR الخاص بالمشارك للتحقق من رصيد استراحة القهوة.",
  "eligibleBalance": "المتبقي اليوم: {amount} ليرة",
  "noBalanceRemaining": "لا يوجد رصيد متبقٍ لاستراحة القهوة اليوم.",
  "amountLabel": "المبلغ (ليرة)",
  "confirmButton": "تأكيد الخصم",
  "scanNext": "مسح التالي",
  "result": {
    "deducted": {
      "headline": "تم الخصم",
      "instruction": "تم خصم {amount} ليرة. الرصيد الجديد: {remaining} ليرة."
    },
    "insufficient_balance": {
      "headline": "رصيد غير كافٍ",
      "instruction": "لا يملك هذا المشارك رصيدًا كافيًا اليوم لهذا المبلغ."
    },
    "ineligible": {
      "headline": "غير مؤهل",
      "instruction": "هذا المشارك غير مؤهل لرصيد استراحة القهوة."
    },
    "invalid_qr": {
      "headline": "رمز QR غير صالح",
      "instruction": "اطلب من المشارك إظهار رمز الكافتيريا الحالي."
    },
    "error": {
      "headline": "خطأ",
      "instruction": "حدث خطأ ما. حاول مرة أخرى."
    }
  }
}
```

Under `myQr.cafeteria`, add one new key for the Speaker-only (coffee-eligible, not lunch-eligible) case:

```json
"instructionCoffeeOnly": "Present this QR at coffee breaks."
```

Arabic:
```json
"instructionCoffeeOnly": "قدّم هذا الرمز في استراحات القهوة."
```

- [ ] **Step 2: Validate both files parse as JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('src/messages/en.json', 'utf8')); console.log('en.json OK')"
node -e "JSON.parse(require('fs').readFileSync('src/messages/ar.json', 'utf8')); console.log('ar.json OK')"
```

- [ ] **Step 3: Commit**

```bash
git add src/messages/en.json src/messages/ar.json
git commit -m "feat: add i18n keys for coffee-break credit scanner and My QR Code copy"
```

---

### Task 6: `/scanner/coffee` route + scanner component

**Files:**
- Create: `src/app/[locale]/scanner/coffee/page.tsx`
- Create: `src/components/scanner/cafeteria-coffee-scanner-client.tsx`

**Depends on Task 4** (needs the two API routes) and **Task 5** (needs the i18n keys).

- [ ] **Step 1: Read the exact files to mirror first**

Read `src/app/[locale]/scanner/cafeteria/page.tsx` and `src/components/scanner/cafeteria-scanner-client.tsx` in full (both are quoted verbatim in the design spec's review notes — the page uses an inline `isScannerDeviceRole` check with a renderable `<ErrorState>` fallback, NOT `requireScannerDeviceCaller()` directly, which throws and is only used by the API routes; the client component's camera-stop-before-setLastResult ordering via a `stopRef` is the specific bug fix that must not regress).

- [ ] **Step 2: Write the page**

```typescript
// src/app/[locale]/scanner/coffee/page.tsx
//
// Nested under src/app/[locale]/scanner/layout.tsx -- inherits its
// kiosk-style chrome automatically, no new layout needed. Auth mirrors
// src/app/[locale]/scanner/cafeteria/page.tsx's own pattern exactly
// (inline isScannerDeviceRole check, renderable ErrorState -- NOT
// requireScannerDeviceCaller(), which throws and fits the API routes'
// contract, not a page's).
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isScannerDeviceRole } from '@/lib/validation/scanner-device';
import { ErrorState } from '@/components/states/error-state';
import { CafeteriaCoffeeScannerClient } from '@/components/scanner/cafeteria-coffee-scanner-client';

export default async function CafeteriaCoffeeScannerPage() {
  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: 'scanner' });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).maybeSingle();

  if (!isScannerDeviceRole(profile?.role)) {
    return <ErrorState title={t('states.unauthorized.title')} description={t('states.unauthorized.description')} />;
  }

  return <CafeteriaCoffeeScannerClient />;
}
```

- [ ] **Step 3: Write the scanner client**

Mirror `cafeteria-scanner-client.tsx`'s structure exactly (same `useQrScanner` usage, same `stopRef` circular-dependency workaround, same mount effect, same `CameraStatusMessage` sub-component with the `CAMERA_MESSAGE_KEY` case-mapping fix — copy that sub-component verbatim, it's shared logic with no feature-specific content), but with a two-step flow instead of one-step:

```typescript
// src/components/scanner/cafeteria-coffee-scanner-client.tsx
//
// Mirrors cafeteria-scanner-client.tsx's structure (useQrScanner usage,
// stopRef circular-dependency workaround, CameraStatusMessage
// sub-component) but with a two-step flow: scan -> show balance ->
// operator enters amount -> confirm -> show deduction result.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQrScanner, type CameraStatus } from './use-qr-scanner';
import { Button } from '@/components/ui/button';

type DeductionResult = 'deducted' | 'insufficient_balance' | 'ineligible' | 'invalid_qr' | 'error';

interface BalanceState {
  eligible: boolean;
  remainingBalance: number | null;
  invalidQr?: boolean;
}

const DEDUCTION_RESULT_CLASSNAME: Record<DeductionResult, string> = {
  deducted: 'bg-green-100 text-green-800 border-green-400',
  insufficient_balance: 'bg-amber-100 text-amber-800 border-amber-400',
  ineligible: 'bg-red-100 text-red-800 border-red-400',
  invalid_qr: 'bg-red-100 text-red-800 border-red-400',
  error: 'bg-red-100 text-red-800 border-red-400',
};

export function CafeteriaCoffeeScannerClient() {
  const t = useTranslations('scanner');
  const [qrPayload, setQrPayload] = useState<string | null>(null);
  const [balance, setBalance] = useState<BalanceState | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [deductionResult, setDeductionResult] = useState<DeductionResult | null>(null);
  const [deductionDetail, setDeductionDetail] = useState<{ amount: number | null; remaining: number | null }>({ amount: null, remaining: null });
  const [busy, setBusy] = useState(false);

  // Same circular-dependency workaround as cafeteria-scanner-client.tsx.
  const stopRef = useRef<(() => void) | null>(null);

  const handleDecode = useCallback(
    async (payload: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const res = await fetch('/api/cafeteria-coffee-balance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qrPayload: payload }),
        });
        const body = await res.json();
        // Stop decoding the moment a result is back, BEFORE any state
        // update that renders a result -- same fix, same ordering
        // requirement as cafeteria-scanner-client.tsx's own handleDecode.
        stopRef.current?.();
        if (body.ok) {
          setQrPayload(payload);
          setBalance(body.result);
        } else {
          setBalance(null);
          setDeductionResult('error');
        }
      } catch {
        stopRef.current?.();
        setBalance(null);
        setDeductionResult('error');
      } finally {
        setBusy(false);
      }
    },
    [busy]
  );

  const { videoRef, status, start, stop } = useQrScanner(handleDecode);

  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  useEffect(() => {
    start();
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConfirmDeduction = useCallback(async () => {
    if (!qrPayload) return;
    const amount = Number(amountInput);
    if (!Number.isFinite(amount) || amount <= 0) return;
    setBusy(true);
    try {
      const res = await fetch('/api/cafeteria-coffee-deduct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qrPayload, amount }),
      });
      const body = await res.json();
      if (body.ok) {
        setDeductionResult(body.result.result as DeductionResult);
        setDeductionDetail({
          amount: body.result.amountDeducted,
          remaining: balance?.remainingBalance != null ? balance.remainingBalance - (body.result.amountDeducted ?? 0) : null,
        });
      } else {
        setDeductionResult('error');
      }
    } catch {
      setDeductionResult('error');
    } finally {
      setBusy(false);
    }
  }, [qrPayload, amountInput, balance]);

  const handleScanNext = useCallback(() => {
    setQrPayload(null);
    setBalance(null);
    setAmountInput('');
    setDeductionResult(null);
    setDeductionDetail({ amount: null, remaining: null });
    start();
  }, [start]);

  return (
    <div className="flex flex-col items-center gap-4">
      <video ref={videoRef} className="w-full rounded-lg bg-black" playsInline muted />
      <CameraStatusMessage t={t} status={status} />

      {!balance && !deductionResult && status === 'active' && (
        <p className="text-sm text-charcoal/70">{t('cafeteria.coffee.scanInstruction')}</p>
      )}

      {balance && !deductionResult && (
        balance.invalidQr || !balance.eligible ? (
          <div className={`w-full rounded-md border-2 p-4 text-center text-lg font-semibold ${DEDUCTION_RESULT_CLASSNAME[balance.invalidQr ? 'invalid_qr' : 'ineligible']}`}>
            <p>{t(`cafeteria.coffee.result.${balance.invalidQr ? 'invalid_qr' : 'ineligible'}.headline`)}</p>
            <p className="text-sm font-normal">{t(`cafeteria.coffee.result.${balance.invalidQr ? 'invalid_qr' : 'ineligible'}.instruction`)}</p>
          </div>
        ) : balance.remainingBalance !== null && balance.remainingBalance <= 0 ? (
          <p className="text-sm text-charcoal/70">{t('cafeteria.coffee.noBalanceRemaining')}</p>
        ) : (
          <div className="flex w-full flex-col gap-3">
            <p className="text-center text-base font-medium">
              {t('cafeteria.coffee.eligibleBalance', { amount: balance.remainingBalance ?? 0 })}
            </p>
            <label className="flex flex-col gap-1 text-sm">
              {t('cafeteria.coffee.amountLabel')}
              <input
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                className="rounded-md border border-charcoal/20 px-3 py-2"
              />
            </label>
            <Button onClick={handleConfirmDeduction} disabled={busy || !amountInput}>
              {t('cafeteria.coffee.confirmButton')}
            </Button>
          </div>
        )
      )}

      {deductionResult && (
        <div className={`w-full rounded-md border-2 p-4 text-center text-lg font-semibold ${DEDUCTION_RESULT_CLASSNAME[deductionResult]}`}>
          <p>{t(`cafeteria.coffee.result.${deductionResult}.headline`)}</p>
          <p className="text-sm font-normal">
            {deductionResult === 'deducted'
              ? t('cafeteria.coffee.result.deducted.instruction', { amount: deductionDetail.amount ?? 0, remaining: deductionDetail.remaining ?? 0 })
              : t(`cafeteria.coffee.result.${deductionResult}.instruction`)}
          </p>
        </div>
      )}

      {(balance || deductionResult) && (
        <Button onClick={handleScanNext} disabled={busy}>
          {t('cafeteria.coffee.scanNext')}
        </Button>
      )}
    </div>
  );
}

// Identical to cafeteria-scanner-client.tsx's own CameraStatusMessage --
// copy verbatim (including the CAMERA_MESSAGE_KEY case-mapping fix for
// 'permission_denied' -> 'permissionDenied'). Not extracted to a shared
// file in this plan (out of scope; matches this codebase's existing
// tolerance for this exact kind of small, scanner-specific duplication
// -- see cafeteria-scanner-client.tsx's own code-review history).
const CAMERA_MESSAGE_KEY: Record<'permission_denied' | 'unavailable' | 'error', string> = {
  permission_denied: 'permissionDenied',
  unavailable: 'unavailable',
  error: 'error',
};

function CameraStatusMessage({ t, status }: { t: ReturnType<typeof useTranslations>; status: CameraStatus }) {
  if (status === 'active' || status === 'idle') return null;
  if (status === 'requesting') {
    return <p className="text-sm text-charcoal/70">{t('camera.requestingPermission')}</p>;
  }
  const messageKey = CAMERA_MESSAGE_KEY[status];
  return (
    <div className="text-center text-sm text-charcoal/70">
      <p className="font-medium">{t(`camera.${messageKey}.title`)}</p>
      <p>{t(`camera.${messageKey}.description`)}</p>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```
Expected: same ~419-error baseline, zero new errors. If `useTranslations`'s type signature rejects the `{amount, remaining}` interpolation-variable argument shape used above, check how next-intl's `t()` calls elsewhere in this codebase pass variables (e.g. search for any existing `t('...', { ... })` call) and adjust to match the real supported signature — this plan's example code assumes standard next-intl ICU variable interpolation works the same way it does in every other next-intl usage in this codebase, but verify rather than assume if typecheck disagrees.

- [ ] **Step 5: Commit**

```bash
git add "src/app/[locale]/scanner/coffee/page.tsx" src/components/scanner/cafeteria-coffee-scanner-client.tsx
git commit -m "feat: add /scanner/coffee route and scanner client for coffee-break deductions"
```

---

### Task 7: Widen My QR Code's cafeteria card gating

**Files:**
- Modify: `src/app/[locale]/(participant)/(shell)/my-qr/page.tsx`
- Modify: `src/app/[locale]/(participant)/(shell)/my-qr/my-qr-client.tsx`

**Depends on Task 1** (needs `isCoffeeEligible`) and **Task 5** (needs the `instructionCoffeeOnly` i18n key).

- [ ] **Step 1: Read the exact current files first**

Read `src/app/[locale]/(participant)/(shell)/my-qr/page.tsx` in full. Confirm line ~61 is still `const isCafeteriaEligible = isLunchEligible(application, profile);` — if it has drifted, adapt while preserving intent. Read `src/app/[locale]/(participant)/(shell)/my-qr/my-qr-client.tsx`'s `cafeteriaCard` block (~lines 96-125) in full too.

- [ ] **Step 2: Widen the page's eligibility check**

In `page.tsx`, change the import and the computation:

```typescript
import { isLunchEligible, isCoffeeEligible } from '@/lib/cafeteria/eligibility';
```

```typescript
// isCoffeeEligible is a strict superset of isLunchEligible (adds only
// the speaker case) -- widening the card's gate to this means nobody
// currently shown the card loses visibility; it only ever gains one
// more case (speakers, who are coffee-eligible but not lunch-eligible).
const isCafeteriaEligible = isCoffeeEligible(application, profile);
// Separately track lunch eligibility too, so the client component can
// pick the right instruction copy (lunch-capable vs. coffee-only).
const isLunchCapable = isLunchEligible(application, profile);
```

Pass the new prop down to `MyQrClient`:

```tsx
<MyQrClient
  initialState={state}
  initialQrImageDataUri={qrImageDataUri}
  isCafeteriaEligible={isCafeteriaEligible}
  isLunchCapable={isLunchCapable}
  initialCafeteriaCredential={initialCafeteriaCredential}
/>
```

- [ ] **Step 3: Update `MyQrClient`'s props and copy selection**

In `my-qr-client.tsx`, add `isLunchCapable: boolean;` to the props type and destructure it, then change the instruction line inside the `cafeteriaCard` block (currently `<p ...>{t('cafeteria.instruction')}</p>` in the `cafeteriaQrImageDataUri` branch) to pick the right key:

```tsx
<p className="text-sm text-charcoal/70 dark:text-gray-400">
  {t(isLunchCapable ? 'cafeteria.instruction' : 'cafeteria.instructionCoffeeOnly')}
</p>
```

Leave everything else in `cafeteriaCard` (the request-button branch, the error display) untouched — only the already-have-a-QR instruction text needs to vary, since the "not yet available" / request-button copy (`cafeteria.notYetAvailable`, `cafeteria.requestButton`) is already generic enough to apply to either case without rewriting.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```
Expected: same ~419-error baseline, zero new errors.

- [ ] **Step 5: Manual verification note**

No automated test for this UI change (matching this session's established pattern for small, visually-verified UI pieces). Note in the task report that manual verification (a speaker-type test account sees the cafeteria card with coffee-only copy; a delegate/volunteer/staff account still sees the original lunch-capable copy, unchanged) is deferred to Task 8's combined manual pass.

- [ ] **Step 6: Commit**

```bash
git add "src/app/[locale]/(participant)/(shell)/my-qr/page.tsx" "src/app/[locale]/(participant)/(shell)/my-qr/my-qr-client.tsx"
git commit -m "feat: widen My QR Code cafeteria card gating to isCoffeeEligible for speakers"
```

---

### Task 8: Final review and merge

Not a subagent task — handled by the controller directly after Tasks 1-7 are all individually spec/quality-reviewed and approved, following this session's established per-task + final-whole-branch review pattern.

- [ ] Dispatch a final whole-branch code-reviewer subagent for the entire `feature/cafeteria-coffee-break` diff against `master`: re-verify the NULL-safety pattern in both new RPCs by reading the actual applied migration (not just this plan's draft), confirm the two-RPC design's eligibility re-check is genuinely live (not cached) at both the balance-check and deduction steps, confirm the My QR Code widening is a genuine strict superset with no currently-eligible case losing visibility, run the full relevant test suite, typecheck/lint.
- [ ] Coordinate one combined manual browser/camera verification pass with the human: issue a cafeteria QR as a speaker test account (confirm the My QR Code card now appears with coffee-only copy), scan it at `/scanner/coffee` as a scanner_device/super_admin account, confirm the balance displays correctly, enter and confirm a deduction amount within balance, confirm the running balance updates correctly across multiple scans in the same day, attempt an amount exceeding the remaining balance and confirm it's rejected in full with a clear message, confirm camera stop/restart behaves correctly between scans (no duplicate resubmission), confirm a non-speaker/non-eligible account (e.g. knowledge_partner) is correctly rejected at the coffee scanner.
- [ ] Use `superpowers:finishing-a-development-branch` to decide merge/PR approach once verification passes.
- [ ] Update `docs/pre-launch-checklist.md` noting Phase 2 (coffee-break credit) is now complete, alongside the already-noted Phase 1 (lunch) completion.
