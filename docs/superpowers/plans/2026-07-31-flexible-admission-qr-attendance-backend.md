# Flexible Admission, QR Check-In & Attendance — Backend (Phases 1–2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete server-side backend for flexible admission and QR-based attendance — schema, RLS, the `resolveAdmissionDecision` pure decision function, the transactional scan RPC, and the admission-management RPCs (override/correct/transfer) — fully proven by tests, with zero UI. This is exactly Phases 1–2 of the approved design spec (`docs/superpowers/specs/2026-07-31-flexible-admission-qr-attendance-design.md`).

**Architecture:** Three additive migrations groups (schema, RLS, functions) on top of the existing allocation/schedule tables, which are read but never modified. A new pure TypeScript module (`resolveAdmissionDecision`) mirrors the Postgres RPC's decision logic exactly, tested in isolation. The RPC uses `pg_try_advisory_xact_lock` (not a `for update` row lock — see Task 8's design note) to serialize concurrent scans per session, matching the existing `confirm_publication_transactional` precedent.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres, RLS, PL/pgSQL functions), Vitest (unit + live integration tests against the real linked Supabase project), TypeScript.

---

## Important context for the implementer

- This repo's convention: **every new Postgres enum value goes in its own isolated migration file** containing nothing else (a new enum value must be committed before it can be referenced in the same transaction by a later migration). See `supabase/migrations/20260803100000_add_participants_communications_and_program_attendance_roles.sql` for the exact pattern.
- `allocation_issues.issue_type` is a plain `text` column with a `check` constraint, **not** a Postgres enum — adding a new allowed value is an ordinary `alter table ... drop constraint ... add constraint` migration, not an isolated-enum migration. Confirmed against `supabase/migrations/20260723100000_allocation_tables.sql`.
- After every migration that changes the schema, regenerate types: `npx supabase gen types typescript --project-id <ref> > src/types/database.ts` (see any recent commit in this repo for the exact command; the project ref is in `.env.local`'s `SUPABASE_PROJECT_REF`).
- Push migrations with `npx supabase db push --linked` (interactive confirm — this project has no local Postgres, migrations apply directly to the linked remote project).
- Live tests in this repo hit the **real** Supabase project (no local DB). Every live test file creates its own `@test.local` fixture users/data in `beforeAll` and tears them down in `afterAll` — follow that exact pattern (see `tests/schedule/concurrency.test.ts` for the closest existing precedent, including its `Promise.allSettled` concurrency-assertion style).
- `'use server'` action files cannot be called directly from a live test (they reach `next/headers`'s `cookies()`, which throws outside a real Next.js request). Every server action in this codebase is split into a plain `xxxForCaller(args, {userId, service})` function plus a thin `'use server'` wrapper that resolves the caller and delegates. Live tests call the `...ForCaller` variant with a service-role client substituted directly. Follow this exact pattern for every new server action in this plan.
- No photo-approval mechanism exists anywhere in this codebase for participants (`applications` has no photo column at all — only `people`, the speakers/staff directory, has `photo_path`). Per the spec's own Risks section, **photos are omitted entirely** from the scanner-facing participant summary in this phase — do not build a photo field into the summary retrieval function.
- `sessions.is_mandatory`, `enable_qr_checkin`, `checkin_opens_at`, `checkin_closes_at` are explicitly **not touched** by any migration in this plan (see spec Non-Goals). Do not read them in any new code.

---

## File Structure

**New migrations** (`supabase/migrations/`, in this exact order — later ones depend on earlier ones):
1. `20260804100000_add_admission_policy_and_priority_fields.sql` — `sessions` new columns
2. `20260804110000_add_scanner_device_role.sql` — isolated enum-value migration
3. `20260804120000_create_attendance_records_table.sql`
4. `20260804130000_create_scan_attempts_table.sql`
5. `20260804140000_create_scanner_assignments_table.sql`
6. `20260804150000_attendance_rls_policies.sql`
7. `20260804160000_scan_attempt_transactional_function.sql`
8. `20260804170000_admission_management_functions.sql` (override/correct/transfer)
9. `20260804180000_add_priority_pool_exceeded_issue_type.sql`

**New TypeScript modules:**
- `src/lib/attendance/resolve-admission-decision.ts` — the pure decision function (mirrors the RPC)
- `src/lib/attendance/time-slot-lookup.ts` — small helper: given a `session_id`, find its `time_slot_group_key` by reusing `groupSessionsIntoTimeSlots` from `src/lib/allocation/time-slot-grouping.ts`
- `src/lib/attendance/participant-summary.ts` — the allow-list-only retrieval function for scanner display
- `src/lib/allocation/priority-pool-validation.ts` — the pure `derivePriorityPoolIssues` function (sibling to `src/lib/allocation/issues.ts`'s `deriveIssues`, not a modification of it)
- `src/lib/validation/scanner-device.ts` — `SCANNER_DEVICE_ROLES` const + `isScannerDeviceRole` predicate (mirrors `src/lib/validation/program-attendance.ts`)
- `src/lib/scanner-device/server-helpers.ts` — `requireScannerDeviceCaller()` (mirrors `src/lib/program-attendance/server-helpers.ts`)
- `src/lib/attendance/scan-attempt.ts` — `scanAttemptPreviewForCaller`/`scanAttemptConfirmForCaller` + thin `'use server'` wrappers (no page/route calls these yet — Phase 3+ wires them into UI)
- `src/lib/attendance/admission-management.ts` — `admitOverrideForCaller`/`correctAttendanceForCaller`/`transferAttendanceForCaller` + thin `'use server'` wrappers

**Modified files:**
- `src/lib/allocation/run-allocation.ts` — one new call to `derivePriorityPoolIssues` + insert, right after the existing `deriveIssues` insert (Task 12)
- `src/types/database.ts` — regenerated after each schema migration group

**New tests:**
- `tests/attendance/resolve-admission-decision.test.ts` — pure unit tests
- `tests/attendance/scan-attempt-live.test.ts` — live integration (happy paths, denials, duplicate, conflict)
- `tests/attendance/scan-attempt-concurrency-live.test.ts` — live integration (the two required real-concurrency scenarios)
- `tests/attendance/admission-management-live.test.ts` — live integration (override/correct/transfer + audit trail)
- `tests/attendance/scanner-device-access-live.test.ts` — live integration (RLS + server-guard denial tests)
- `tests/allocation/priority-pool-validation.test.ts` — pure unit tests for `derivePriorityPoolIssues`
- `tests/allocation/priority-pool-validation-live.test.ts` — live integration (a real `runAllocation` run produces the issue)

---

## Task 1: `sessions` admission-policy columns

**Files:**
- Create: `supabase/migrations/20260804100000_add_admission_policy_and_priority_fields.sql`

- [ ] **Step 1: Write the migration**

```sql
-- add_admission_policy_and_priority_fields.sql
--
-- Phase 6 (docs/superpowers/specs/2026-07-31-flexible-admission-qr-attendance-design.md).
-- New sessions columns for the admission-policy/capacity layer. Purely
-- additive; sessions.is_mandatory/enable_qr_checkin/checkin_opens_at/
-- checkin_closes_at are explicitly untouched (see spec Non-Goals) — this
-- migration supersedes their purpose without modifying them.
alter table sessions
  add column admission_policy text not null default 'priority_then_open',
  add column priority_seats int,
  add column priority_release_at timestamptz,
  add column priority_release_minutes_before int,
  add column late_entry_cutoff_minutes int,
  add column flexible_entry_manual_override boolean;

alter table sessions add constraint sessions_admission_policy_check
  check (admission_policy in ('open', 'priority_then_open', 'restricted', 'plenary', 'cross_cutting'));

alter table sessions add constraint sessions_priority_seats_check
  check (priority_seats is null or (priority_seats >= 0 and priority_seats <= capacity));
```

- [ ] **Step 2: Push and regenerate types**

Run: `npx supabase db push --linked` (confirm the single new migration), then regenerate `src/types/database.ts`.

- [ ] **Step 3: Verify**

Run a one-off check (e.g. via a scratch script, not committed) that `sessions.admission_policy` defaults to `'priority_then_open'` on a fresh insert, and that a `priority_seats` value exceeding `capacity` is rejected by the DB.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260804100000_add_admission_policy_and_priority_fields.sql src/types/database.ts
git commit -m "feat(db): add admission-policy and priority-seat fields to sessions"
```

---

## Task 2: `scanner_device` role

**Files:**
- Create: `supabase/migrations/20260804110000_add_scanner_device_role.sql`

- [ ] **Step 1: Write the isolated migration**

```sql
-- add_scanner_device_role.sql
--
-- Isolated in its own file with nothing else in it, per this repo's
-- established convention (see 20260803100000_add_participants_
-- communications_and_program_attendance_roles.sql) — a new enum value
-- must be committed before any later migration in this plan can
-- reference it in a policy or check constraint.
alter type user_role add value 'scanner_device';
```

- [ ] **Step 2: Push and regenerate types**

- [ ] **Step 3: Add the role label**

Modify `src/lib/shell/role-label.ts`'s `ROLE_LABEL_KEYS` to add:
```ts
scanner_device: 'roles.scanner_device',
```
Add the matching `roles.scanner_device` key to `src/messages/en.json` (`"QR & Attendance Operator"`) and `src/messages/ar.json` (`"مسؤول المسح وتسجيل الحضور"`), in the same `roles` block as the other role labels.

- [ ] **Step 4: Update `tests/lib/shell/role-label.test.ts` and `tests/lib/auth/post-login-destination.test.ts`**

Both hardcode a role list, but they are currently **out of sync with each other and with the real enum**: `tests/lib/auth/post-login-destination.test.ts`'s `STAFF_ROLES` list was correctly updated in the prior session to include all 8 non-participant roles that existed at that time. `tests/lib/shell/role-label.test.ts`'s `REAL_ENUM_VALUES` const, by contrast, was **never updated** — it still only lists the original 5 roles from `20260721200747_roles_and_profiles.sql` (`participant`, `super_admin`, `registration_admission_manager`, `agenda_allocation_manager`, `communications_attendance_manager`), missing `travel_operations_staff`, `participant_care_staff`, `participants_communications_manager`, and `program_attendance_manager` entirely. Fix both in this step: add `scanner_device` to `post-login-destination.test.ts`'s list, and bring `role-label.test.ts`'s `REAL_ENUM_VALUES` fully up to date with all 9 real enum values (including `scanner_device`) — this second fix is a pre-existing gap unrelated to this plan's own work, caught while touching this file, not something to skip.

- [ ] **Step 5: Run the two updated tests**

Run: `npx vitest run tests/lib/shell/role-label.test.ts tests/lib/auth/post-login-destination.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260804110000_add_scanner_device_role.sql src/types/database.ts src/lib/shell/role-label.ts src/messages/en.json src/messages/ar.json tests/lib/shell/role-label.test.ts tests/lib/auth/post-login-destination.test.ts
git commit -m "feat(auth): add scanner_device role"
```

---

## Task 3: `attendance_records` table

**Files:**
- Create: `supabase/migrations/20260804120000_create_attendance_records_table.sql`

- [ ] **Step 1: Write the migration**

```sql
-- create_attendance_records_table.sql
create table attendance_records (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id),
  session_id uuid not null references sessions(id),
  time_slot_group_key text not null,
  status text not null default 'admitted',
  entry_type text not null,
  admitted_at timestamptz not null default now(),
  scanned_by uuid not null references profiles(id),
  device_identifier text,
  superseded_attendance_id uuid references attendance_records(id),
  correction_reason text,
  created_at timestamptz not null default now(),

  constraint attendance_records_status_check check (status in ('admitted', 'rejected', 'transferred_out', 'corrected')),
  constraint attendance_records_entry_type_check check (entry_type in ('priority', 'flexible', 'override'))
);

-- Prevents a duplicate ACTIVE admission for the same participant+session —
-- a corrected/transferred-out row does not block a later new admission for
-- the same pair (spec Data Model section).
create unique index attendance_records_no_duplicate_active
  on attendance_records (application_id, session_id)
  where status = 'admitted';

create index attendance_records_session_idx on attendance_records (session_id);
create index attendance_records_application_idx on attendance_records (application_id);
```

- [ ] **Step 2: Push and regenerate types**

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260804120000_create_attendance_records_table.sql src/types/database.ts
git commit -m "feat(db): create attendance_records table"
```

---

## Task 4: `scan_attempts` table

**Files:**
- Create: `supabase/migrations/20260804130000_create_scan_attempts_table.sql`

- [ ] **Step 1: Write the migration**

```sql
-- create_scan_attempts_table.sql
create table scan_attempts (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id),
  session_id uuid references sessions(id),
  scanned_by uuid not null references profiles(id),
  device_identifier text,
  result text not null,
  resulting_attendance_id uuid references attendance_records(id),
  metadata jsonb,
  created_at timestamptz not null default now(),

  constraint scan_attempts_result_check check (result in (
    'admitted', 'flexible_admitted', 'priority_hold', 'full',
    'restricted_denied', 'duplicate', 'timeslot_conflict', 'invalid_qr', 'override_admitted'
  ))
);

create index scan_attempts_session_idx on scan_attempts (session_id);
create index scan_attempts_scanned_by_idx on scan_attempts (scanned_by);
```

- [ ] **Step 2: Push and regenerate types**

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260804130000_create_scan_attempts_table.sql src/types/database.ts
git commit -m "feat(db): create scan_attempts table"
```

---

## Task 5: `scanner_assignments` table

**Files:**
- Create: `supabase/migrations/20260804140000_create_scanner_assignments_table.sql`

- [ ] **Step 1: Write the migration**

```sql
-- create_scanner_assignments_table.sql
create table scanner_assignments (
  id uuid primary key default gen_random_uuid(),
  scanner_user_id uuid not null references profiles(id),
  room_id uuid references rooms(id),
  session_id uuid references sessions(id),
  is_active boolean not null default true,
  assigned_by uuid not null references profiles(id),
  assigned_at timestamptz not null default now(),

  constraint scanner_assignments_scope_check check (room_id is not null or session_id is not null)
);

create index scanner_assignments_scanner_user_idx on scanner_assignments (scanner_user_id);
create index scanner_assignments_session_idx on scanner_assignments (session_id);
create index scanner_assignments_room_idx on scanner_assignments (room_id);
```

- [ ] **Step 2: Push and regenerate types**

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260804140000_create_scanner_assignments_table.sql src/types/database.ts
git commit -m "feat(db): create scanner_assignments table"
```

---

## Task 6: RLS policies for the three new tables

**Files:**
- Create: `supabase/migrations/20260804150000_attendance_rls_policies.sql`

- [ ] **Step 1: Write the migration**

```sql
-- attendance_rls_policies.sql
alter table attendance_records enable row level security;
alter table scan_attempts enable row level security;
alter table scanner_assignments enable row level security;

-- attendance_records: super_admin/program_attendance_manager full access.
create policy attendance_records_manager_all on attendance_records
  for all using (current_user_role() in ('program_attendance_manager', 'super_admin'));

-- scanner_device: read/insert only for rows tied to its own scanner_assignments.
create policy attendance_records_scanner_select on attendance_records
  for select using (
    current_user_role() = 'scanner_device'
    and session_id in (
      select session_id from scanner_assignments where scanner_user_id = auth.uid() and is_active
      union
      select s.id from sessions s
      join scanner_assignments sa on sa.room_id = s.room_id
      where sa.scanner_user_id = auth.uid() and sa.is_active
    )
  );

create policy attendance_records_scanner_insert on attendance_records
  for insert with check (
    current_user_role() = 'scanner_device'
    and scanned_by = auth.uid()
    and session_id in (
      select session_id from scanner_assignments where scanner_user_id = auth.uid() and is_active
      union
      select s.id from sessions s
      join scanner_assignments sa on sa.room_id = s.room_id
      where sa.scanner_user_id = auth.uid() and sa.is_active
    )
  );

-- scan_attempts: same shape as attendance_records.
create policy scan_attempts_manager_all on scan_attempts
  for all using (current_user_role() in ('program_attendance_manager', 'super_admin'));

create policy scan_attempts_scanner_select on scan_attempts
  for select using (
    current_user_role() = 'scanner_device'
    and session_id in (
      select session_id from scanner_assignments where scanner_user_id = auth.uid() and is_active
      union
      select s.id from sessions s
      join scanner_assignments sa on sa.room_id = s.room_id
      where sa.scanner_user_id = auth.uid() and sa.is_active
    )
  );

create policy scan_attempts_scanner_insert on scan_attempts
  for insert with check (
    current_user_role() = 'scanner_device'
    and scanned_by = auth.uid()
    and session_id in (
      select session_id from scanner_assignments where scanner_user_id = auth.uid() and is_active
      union
      select s.id from sessions s
      join scanner_assignments sa on sa.room_id = s.room_id
      where sa.scanner_user_id = auth.uid() and sa.is_active
    )
  );

-- scanner_assignments: manager full access; scanner_device reads only its own row(s).
create policy scanner_assignments_manager_all on scanner_assignments
  for all using (current_user_role() in ('program_attendance_manager', 'super_admin'));

create policy scanner_assignments_scanner_select_own on scanner_assignments
  for select using (current_user_role() = 'scanner_device' and scanner_user_id = auth.uid());
```

**Note for implementer:** the `union`-based room/session scope check is repeated three times because Postgres RLS policies can't share a subquery expression directly. If this feels too duplicative once written, consider a small `security definer` helper function `is_scanner_authorized_for_session(p_session_id uuid)` following the `current_user_role()` precedent (`supabase/migrations/20260721212035_rls_policies.sql`) — optional simplification, not required for correctness.

- [ ] **Step 2: Push**

- [ ] **Step 3: Verify RLS denies cross-scope access**

Write and run a throwaway scratch script (not committed) that: creates a `scanner_device` user with a `scanner_assignments` row scoped to session A only, then attempts to `select`/`insert` into `attendance_records` for session B as that user — confirm both are rejected (empty result / permission error). Delete the scratch script after confirming.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260804150000_attendance_rls_policies.sql
git commit -m "feat(db): RLS policies for attendance_records, scan_attempts, scanner_assignments"
```

---

## Task 7: role helper, validation predicate, server-action guard for `scanner_device`

**Files:**
- Create: `src/lib/validation/scanner-device.ts`
- Create: `src/lib/scanner-device/server-helpers.ts`

- [ ] **Step 1: Write `src/lib/validation/scanner-device.ts`**

Mirror `src/lib/validation/program-attendance.ts` exactly:

```ts
// Single source of truth for "is this profile.role allowed to act as a
// scanner_device (QR & Attendance Operator)". Deliberately narrow — this
// role may only scan/confirm entry for its assigned scope; it has no
// access to allocation, schedule-publication, or participant-account
// management, and no access to application_travel_info/application_
// health_info.
export const SCANNER_DEVICE_ROLES = ['scanner_device', 'super_admin'] as const;
export function isScannerDeviceRole(role: string | null | undefined): boolean {
  return role != null && (SCANNER_DEVICE_ROLES as readonly string[]).includes(role);
}
```

**Design note for implementer:** `super_admin` is included here (matching every other role predicate in this codebase — `super_admin` is always allowed everywhere) but `program_attendance_manager` is deliberately NOT included in this specific predicate, since "can act as a scanner device" and "can manage the attendance system" are different capabilities per the spec's permission matrix — `program_attendance_manager` gets its own separate, broader access via `requireProgramAttendanceStaffCaller` for the admin-management RPCs (Task 9), not via this scanner-scoped check.

- [ ] **Step 2: Write `src/lib/scanner-device/server-helpers.ts`**

Mirror `src/lib/program-attendance/server-helpers.ts` exactly, substituting `isScannerDeviceRole`:

```ts
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isScannerDeviceRole } from '@/lib/validation/scanner-device';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

export async function requireScannerDeviceCaller(): Promise<{ userId: string; service: ServiceClient }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (error || !profile) throw new Error('Profile not found');
  if (!isScannerDeviceRole(profile.role)) {
    throw new Error('Not authorized');
  }

  return { userId: user.id, service };
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/validation/scanner-device.ts src/lib/scanner-device/server-helpers.ts
git commit -m "feat(auth): scanner_device role predicate and server-action guard"
```

---

## Task 8: `resolveAdmissionDecision` — pure TypeScript decision function

**Files:**
- Create: `src/lib/attendance/resolve-admission-decision.ts`
- Test: `tests/attendance/resolve-admission-decision.test.ts`

This is the TypeScript mirror of the Postgres RPC's decision logic (Task 11 implements the same logic in PL/pgSQL — they must stay in sync; this TS version is used for the preview-only call and for `getAlternativesForTimeslot`, per the spec).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/attendance/resolve-admission-decision.test.ts
import { describe, expect, it } from 'vitest';
import { resolveAdmissionDecision, type AdmissionDecisionInput } from '@/lib/attendance/resolve-admission-decision';

const baseSession = {
  status: 'confirmed' as const,
  admissionPolicy: 'priority_then_open' as const,
  capacity: 10,
  prioritySeats: 6,
  priorityReleaseAt: null,
  priorityReleaseMinutesBefore: null,
  lateEntryCutoffMinutes: null,
  flexibleEntryManualOverride: null,
  startTime: '2026-09-19T09:00:00Z',
};

const baseCounts = { totalAdmitted: 0, admittedPriorityCount: 0, admittedFlexibleCount: 0 };

function input(overrides: Partial<AdmissionDecisionInput> = {}): AdmissionDecisionInput {
  return {
    now: new Date('2026-09-19T08:55:00Z'),
    session: baseSession,
    isRecommended: false,
    hasActiveAttendanceForThisSession: false,
    hasActiveAttendanceForConflictingSession: false,
    sessionCounts: baseCounts,
    isOverrideCaller: false,
    ...overrides,
  };
}

describe('resolveAdmissionDecision', () => {
  it('returns duplicate when already admitted to this exact session', () => {
    expect(resolveAdmissionDecision(input({ hasActiveAttendanceForThisSession: true })).result).toBe('duplicate');
  });

  it('returns timeslot_conflict when admitted to a different session in the same slot', () => {
    expect(resolveAdmissionDecision(input({ hasActiveAttendanceForConflictingSession: true })).result).toBe('timeslot_conflict');
  });

  it('duplicate takes precedence over timeslot_conflict when both are somehow true', () => {
    expect(
      resolveAdmissionDecision(input({ hasActiveAttendanceForThisSession: true, hasActiveAttendanceForConflictingSession: true })).result
    ).toBe('duplicate');
  });

  it('rejects when the session is not confirmed', () => {
    // Collapses to 'invalid_qr' — matches scan_attempts.result's check
    // constraint (Task 4) and the RPC (Task 11), which has no separate
    // "not open" code; the design spec's 7-color table has no distinct
    // color for this case either.
    expect(resolveAdmissionDecision(input({ session: { ...baseSession, status: 'draft' } })).result).toBe('invalid_qr');
  });

  it('blocks a normal scan past the late-entry cutoff', () => {
    // Also collapses to 'invalid_qr', for the same reason.
    const session = { ...baseSession, lateEntryCutoffMinutes: 15 };
    const now = new Date('2026-09-19T09:20:00Z'); // 20 min after start_time
    expect(resolveAdmissionDecision(input({ session, now })).result).toBe('invalid_qr');
  });

  it('an override caller bypasses the late-entry cutoff entirely', () => {
    const session = { ...baseSession, lateEntryCutoffMinutes: 15 };
    const now = new Date('2026-09-19T09:20:00Z');
    expect(resolveAdmissionDecision(input({ session, now, isOverrideCaller: true, isRecommended: true })).result).toBe('admitted');
  });

  it('returns full when total_admitted has reached capacity, even for a recommended participant', () => {
    const sessionCounts = { ...baseCounts, totalAdmitted: 10 };
    expect(resolveAdmissionDecision(input({ isRecommended: true, sessionCounts })).result).toBe('full');
  });

  describe('restricted policy', () => {
    it('denies a non-recommended participant', () => {
      const session = { ...baseSession, admissionPolicy: 'restricted' as const };
      expect(resolveAdmissionDecision(input({ session, isRecommended: false })).result).toBe('restricted_denied');
    });

    it('admits a recommended participant with entry_type priority', () => {
      const session = { ...baseSession, admissionPolicy: 'restricted' as const };
      const decision = resolveAdmissionDecision(input({ session, isRecommended: true }));
      expect(decision.result).toBe('admitted');
      expect(decision.entryType).toBe('priority');
    });
  });

  describe('plenary / open / cross_cutting policies', () => {
    for (const policy of ['plenary', 'open', 'cross_cutting'] as const) {
      it(`admits any participant with entry_type flexible under ${policy}`, () => {
        const session = { ...baseSession, admissionPolicy: policy };
        const decision = resolveAdmissionDecision(input({ session, isRecommended: false }));
        expect(decision.result).toBe('flexible_admitted');
        expect(decision.entryType).toBe('flexible');
      });
    }
  });

  describe('priority_then_open policy', () => {
    it('admits a recommended participant with entry_type priority regardless of release timing', () => {
      const decision = resolveAdmissionDecision(input({ isRecommended: true }));
      expect(decision.result).toBe('admitted');
      expect(decision.entryType).toBe('priority');
    });

    it('holds a non-recommended participant before release timing when priority seats are not exhausted-flexible-pool', () => {
      // capacity=10, prioritySeats=6 -> flexible pool pre-release = 10-6 = 4.
      // 4 flexible already admitted -> pool exhausted -> hold, even pre-release.
      const sessionCounts = { ...baseCounts, totalAdmitted: 4, admittedFlexibleCount: 4 };
      expect(resolveAdmissionDecision(input({ isRecommended: false, sessionCounts })).result).toBe('priority_hold');
    });

    it('flexibly admits a non-recommended participant before release timing while the flexible pool has room', () => {
      const sessionCounts = { ...baseCounts, totalAdmitted: 2, admittedFlexibleCount: 2 };
      const decision = resolveAdmissionDecision(input({ isRecommended: false, sessionCounts }));
      expect(decision.result).toBe('flexible_admitted');
      expect(decision.entryType).toBe('flexible');
    });

    it('holds a non-recommended participant when the flexible pool is exhausted and priority seats are not yet released', () => {
      const sessionCounts = { ...baseCounts, totalAdmitted: 4, admittedFlexibleCount: 4, admittedPriorityCount: 0 };
      expect(resolveAdmissionDecision(input({ isRecommended: false, sessionCounts })).result).toBe('priority_hold');
    });

    it('flexibly admits a non-recommended participant into a released-but-unused priority seat after release timing', () => {
      const session = { ...baseSession, priorityReleaseAt: '2026-09-19T08:50:00Z' }; // already past
      const sessionCounts = { ...baseCounts, totalAdmitted: 4, admittedFlexibleCount: 4, admittedPriorityCount: 2 };
      // effective_priority_pool=6, priority_used=2 -> 4 released seats join the 4-seat flexible pool = 8 total flexible capacity, 4 used -> room.
      const decision = resolveAdmissionDecision(input({ session, isRecommended: false, sessionCounts }));
      expect(decision.result).toBe('flexible_admitted');
    });

    it('manual override (flexibleEntryManualOverride=true) opens flexible entry even before the automatic release time', () => {
      const session = { ...baseSession, priorityReleaseAt: '2026-09-20T00:00:00Z', flexibleEntryManualOverride: true };
      const sessionCounts = { ...baseCounts, totalAdmitted: 4, admittedFlexibleCount: 4, admittedPriorityCount: 1 };
      const decision = resolveAdmissionDecision(input({ session, isRecommended: false, sessionCounts }));
      expect(decision.result).toBe('flexible_admitted');
    });

    it('manual override (flexibleEntryManualOverride=false) keeps flexible entry closed even after the automatic release time', () => {
      const session = { ...baseSession, priorityReleaseAt: '2026-09-19T08:50:00Z', flexibleEntryManualOverride: false };
      const sessionCounts = { ...baseCounts, totalAdmitted: 4, admittedFlexibleCount: 4, admittedPriorityCount: 0 };
      expect(resolveAdmissionDecision(input({ session, isRecommended: false, sessionCounts })).result).toBe('priority_hold');
    });

    it('treats a null priority_seats as "all seats are priority" (effective_priority_pool = capacity)', () => {
      const session = { ...baseSession, prioritySeats: null };
      // flexible pool pre-release = capacity - capacity = 0 -> immediate hold for non-recommended.
      expect(resolveAdmissionDecision(input({ session, isRecommended: false })).result).toBe('priority_hold');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/attendance/resolve-admission-decision.test.ts`
Expected: FAIL — module `@/lib/attendance/resolve-admission-decision` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/attendance/resolve-admission-decision.ts
//
// Pure TypeScript mirror of the scan_attempt_transactional RPC's decision
// logic (supabase/migrations/20260804160000_scan_attempt_transactional_
// function.sql). Used for: (a) the read-only preview call before operator
// confirmation, (b) getAlternativesForTimeslot's availability preview.
// The RPC is the sole source of truth for what actually gets WRITTEN —
// this function must never be used to justify a write itself, only to
// preview one. Keep the two implementations logically identical; if you
// change one, change the other and re-run both test suites.
export type AdmissionPolicy = 'open' | 'priority_then_open' | 'restricted' | 'plenary' | 'cross_cutting';
// Exactly the 9 values in scan_attempts.result's check constraint (Task
// 4) plus 'override_admitted' — deliberately no separate "not open"/
// "late entry blocked" codes: both collapse into 'invalid_qr' below, to
// stay byte-for-byte in sync with what scan_attempt_transactional (Task
// 11) actually writes.
export type AdmissionResult =
  | 'admitted'
  | 'flexible_admitted'
  | 'priority_hold'
  | 'full'
  | 'restricted_denied'
  | 'duplicate'
  | 'timeslot_conflict'
  | 'invalid_qr';
export type EntryType = 'priority' | 'flexible' | 'override' | null;

export interface SessionForAdmission {
  status: string;
  admissionPolicy: AdmissionPolicy;
  capacity: number;
  prioritySeats: number | null;
  priorityReleaseAt: string | null;
  priorityReleaseMinutesBefore: number | null;
  lateEntryCutoffMinutes: number | null;
  flexibleEntryManualOverride: boolean | null;
  startTime: string;
}

export interface SessionCounts {
  totalAdmitted: number;
  admittedPriorityCount: number;
  admittedFlexibleCount: number;
}

export interface AdmissionDecisionInput {
  now: Date;
  session: SessionForAdmission;
  isRecommended: boolean;
  hasActiveAttendanceForThisSession: boolean;
  hasActiveAttendanceForConflictingSession: boolean;
  sessionCounts: SessionCounts;
  isOverrideCaller: boolean;
}

export interface AdmissionDecision {
  result: AdmissionResult;
  entryType: EntryType;
}

function effectivePriorityPool(session: SessionForAdmission): number {
  return session.prioritySeats ?? session.capacity;
}

function isPastLateEntryCutoff(session: SessionForAdmission, now: Date): boolean {
  if (session.lateEntryCutoffMinutes == null) return false;
  const cutoff = new Date(session.startTime);
  cutoff.setMinutes(cutoff.getMinutes() + session.lateEntryCutoffMinutes);
  return now > cutoff;
}

function isPriorityReleased(session: SessionForAdmission, now: Date): boolean {
  if (session.flexibleEntryManualOverride === true) return true;
  if (session.flexibleEntryManualOverride === false) return false;
  if (session.priorityReleaseAt != null) return now >= new Date(session.priorityReleaseAt);
  if (session.priorityReleaseMinutesBefore != null) {
    const releaseAt = new Date(session.startTime);
    releaseAt.setMinutes(releaseAt.getMinutes() - session.priorityReleaseMinutesBefore);
    return now >= releaseAt;
  }
  return false; // never auto-releases without explicit timing or manual override
}

export function resolveAdmissionDecision(input: AdmissionDecisionInput): AdmissionDecision {
  const { session, now, sessionCounts } = input;

  if (input.hasActiveAttendanceForThisSession) return { result: 'duplicate', entryType: null };
  if (input.hasActiveAttendanceForConflictingSession) return { result: 'timeslot_conflict', entryType: null };
  // Both "session not confirmed" and "past late-entry cutoff" collapse to
  // 'invalid_qr' — see the AdmissionResult type's comment above for why.
  if (session.status !== 'confirmed') return { result: 'invalid_qr', entryType: null };
  if (isPastLateEntryCutoff(session, now) && !input.isOverrideCaller) {
    return { result: 'invalid_qr', entryType: null };
  }
  if (sessionCounts.totalAdmitted >= session.capacity) return { result: 'full', entryType: null };

  switch (session.admissionPolicy) {
    case 'restricted':
      if (!input.isRecommended) return { result: 'restricted_denied', entryType: null };
      return { result: 'admitted', entryType: 'priority' };

    case 'plenary':
    case 'open':
    case 'cross_cutting':
      return { result: 'flexible_admitted', entryType: 'flexible' };

    case 'priority_then_open': {
      if (input.isRecommended) return { result: 'admitted', entryType: 'priority' };

      const pool = effectivePriorityPool(session);
      const released = isPriorityReleased(session, now);
      const flexiblePool = session.capacity - pool + (released ? Math.max(0, pool - sessionCounts.admittedPriorityCount) : 0);

      if (sessionCounts.totalAdmitted < session.capacity && sessionCounts.admittedFlexibleCount < flexiblePool) {
        return { result: 'flexible_admitted', entryType: 'flexible' };
      }
      return { result: 'priority_hold', entryType: null };
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/attendance/resolve-admission-decision.test.ts`
Expected: PASS (all cases green)

- [ ] **Step 5: Commit**

```bash
git add src/lib/attendance/resolve-admission-decision.ts tests/attendance/resolve-admission-decision.test.ts
git commit -m "feat(attendance): pure resolveAdmissionDecision function with full unit coverage"
```

---

## Task 9: time-slot-group-key lookup helper

**Files:**
- Create: `src/lib/attendance/time-slot-lookup.ts`

- [ ] **Step 1: Write the helper**

```ts
// src/lib/attendance/time-slot-lookup.ts
//
// Given a specific session_id, find its time_slot_group_key by reusing the
// existing allocation-time grouping logic (src/lib/allocation/time-slot-
// grouping.ts) — never recomputes conflict-detection logic independently.
// Needed at scan time to check "is this participant already admitted to a
// DIFFERENT session in the same time slot" without a stored per-session
// group-key column (sessions.time_slot_group_key does not exist — only
// attendance_records.time_slot_group_key, computed via this helper at
// insert time).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { groupSessionsIntoTimeSlots, type SessionForGrouping } from '@/lib/allocation/time-slot-grouping';

type ServiceClient = SupabaseClient<Database>;

export async function computeTimeSlotGroupKeyForSession(service: ServiceClient, sessionId: string): Promise<string> {
  const { data: target, error: targetError } = await service.from('sessions').select('id, conference_day_id').eq('id', sessionId).single();
  if (targetError || !target) throw new Error(`Session ${sessionId} not found`);

  const { data: daySessions, error: dayError } = await service
    .from('sessions')
    .select('id, conference_day_id, start_time, end_time, is_mandatory')
    .eq('conference_day_id', target.conference_day_id);
  if (dayError) throw new Error(`Failed to load sessions for conference day: ${dayError.message}`);

  const forGrouping: SessionForGrouping[] = (daySessions ?? []).map((s) => ({
    id: s.id,
    conferenceDayId: s.conference_day_id,
    startTime: s.start_time,
    endTime: s.end_time,
    isMandatory: s.is_mandatory,
  }));

  const groups = groupSessionsIntoTimeSlots(forGrouping);
  const group = groups.find((g) => g.sessionIds.includes(sessionId));
  if (!group) throw new Error(`Session ${sessionId} not found in any computed time-slot group`);
  return group.timeSlotGroupKey;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/lib/attendance/time-slot-lookup.ts
git commit -m "feat(attendance): time-slot-group-key lookup helper"
```

(This helper is exercised indirectly by the live tests in Task 12/13, not with a standalone unit test — it's a thin DB-reading wrapper around already-tested pure logic.)

---

## Task 10: participant summary retrieval (allow-list)

**Files:**
- Create: `src/lib/attendance/participant-summary.ts`

- [ ] **Step 1: Write the retrieval function**

```ts
// src/lib/attendance/participant-summary.ts
//
// The ONLY function anywhere in the scan flow permitted to read
// participant-identifying data for scanner display. Deliberately an
// allow-list, not `select *` — see design spec's "Participant Summary
// Shown to the Operator" section. No photo field: no photo-approval
// mechanism exists anywhere in this codebase for participants (only
// `people`, the speakers/staff directory, has photo_path) — per the
// spec's Risks section, photos are omitted entirely in this phase rather
// than sourced from an unapproved place.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type ServiceClient = SupabaseClient<Database>;

export interface ScannerParticipantSummary {
  fullName: string;
  country: string | null;
  nationality: string | null;
}

export async function getScannerParticipantSummary(service: ServiceClient, applicationId: string): Promise<ScannerParticipantSummary | null> {
  const { data, error } = await service
    .from('applications')
    .select('full_name, country, nationality')
    .eq('id', applicationId)
    .single();
  if (error || !data) return null;
  return { fullName: data.full_name ?? '', country: data.country, nationality: data.nationality };
}
```

- [ ] **Step 2: Typecheck**

- [ ] **Step 3: Commit**

```bash
git add src/lib/attendance/participant-summary.ts
git commit -m "feat(attendance): allow-list-only participant summary for scanner display"
```

---

## Task 11: `scan_attempt_transactional` RPC

**Files:**
- Create: `supabase/migrations/20260804160000_scan_attempt_transactional_function.sql`

This is the PL/pgSQL mirror of Task 8's TypeScript function — the actual write authority. **Design note:** uses `pg_try_advisory_xact_lock` in a bounded retry loop, matching the existing `confirm_publication_transactional` precedent's locking primitive (`supabase/migrations/20260723195000_confirm_publication_function.sql`) but NOT its fail-fast-on-first-miss behavior — that precedent is for a rare admin action where "try again" is an acceptable UX; live QR scanning at an event gate is a much higher-contention, real-time-UX-sensitive path, so this function retries the lock a bounded number of times with a short sleep before finally giving up (confirmed with user).

- [ ] **Step 1: Write the migration**

```sql
-- scan_attempt_transactional_function.sql
--
-- The sole write authority for attendance_records/scan_attempts. Mirrors
-- resolveAdmissionDecision's TypeScript logic exactly (src/lib/attendance/
-- resolve-admission-decision.ts) — if you change one, change both and
-- re-run both test suites. Uses pg_try_advisory_xact_lock keyed on
-- session_id (not a `for update` row lock) to serialize concurrent scans
-- for the same session, wrapped in a short bounded retry loop rather than
-- failing on the first miss (unlike confirm_publication_transactional,
-- which fails fast) — a live-event scanning UI should resolve to a real
-- admission decision (admitted/full/etc.) under normal contention, not
-- surface "try again" to the operator for an ordinary two-scan race.
create or replace function scan_attempt_transactional(
  p_application_id uuid,
  p_session_id uuid,
  p_scanned_by uuid,
  p_device_identifier text,
  p_time_slot_group_key text,
  p_is_override_caller boolean default false
) returns scan_attempts as $$
declare
  v_lock_key bigint;
  v_lock_acquired boolean := false;
  v_retry_count int := 0;
  v_max_retries constant int := 20;      -- ~1s total worst case at 50ms apart
  v_retry_delay_seconds constant numeric := 0.05;
  v_session sessions%rowtype;
  v_application_status text;
  v_total_admitted int;
  v_admitted_priority_count int;
  v_admitted_flexible_count int;
  v_has_this_session boolean;
  v_has_conflicting_session boolean;
  v_effective_priority_pool int;
  v_released boolean;
  v_flexible_pool int;
  v_result text;
  v_entry_type text;
  v_attendance_id uuid;
  v_scan_attempt scan_attempts%rowtype;
begin
  v_lock_key := hashtext(p_session_id::text);

  loop
    v_lock_acquired := pg_try_advisory_xact_lock(v_lock_key);
    exit when v_lock_acquired or v_retry_count >= v_max_retries;
    v_retry_count := v_retry_count + 1;
    perform pg_sleep(v_retry_delay_seconds);
  end loop;

  if not v_lock_acquired then
    raise exception 'Another scan for this session is still being processed after % retries — please retry manually', v_max_retries;
  end if;

  select status into v_application_status from applications where id = p_application_id;
  select * into v_session from sessions where id = p_session_id;

  if v_application_status is null or v_application_status <> 'accepted' or v_session.id is null then
    insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result)
    values (p_application_id, p_session_id, p_scanned_by, p_device_identifier, 'invalid_qr')
    returning * into v_scan_attempt;
    return v_scan_attempt;
  end if;

  select exists(
    select 1 from attendance_records
    where application_id = p_application_id and session_id = p_session_id and status = 'admitted'
  ) into v_has_this_session;

  select exists(
    select 1 from attendance_records
    where application_id = p_application_id and time_slot_group_key = p_time_slot_group_key
      and session_id <> p_session_id and status = 'admitted'
  ) into v_has_conflicting_session;

  select count(*) filter (where status = 'admitted') into v_total_admitted from attendance_records where session_id = p_session_id;
  select count(*) filter (where status = 'admitted' and entry_type = 'priority') into v_admitted_priority_count from attendance_records where session_id = p_session_id;
  select count(*) filter (where status = 'admitted' and entry_type = 'flexible') into v_admitted_flexible_count from attendance_records where session_id = p_session_id;

  v_effective_priority_pool := coalesce(v_session.priority_seats, v_session.capacity);

  -- Both "session not open" and "past late-entry cutoff" collapse to the
  -- single 'invalid_qr' result value — the scan_attempts.result check
  -- constraint (Task 4) and the design spec's color table have no 8th/9th
  -- distinct code for either case. resolveAdmissionDecision (Task 8) uses
  -- this exact same collapse, to keep the TS preview and this RPC's
  -- actual write in sync.
  if v_has_this_session then
    v_result := 'duplicate';
  elsif v_has_conflicting_session then
    v_result := 'timeslot_conflict';
  elsif v_session.status <> 'confirmed' then
    v_result := 'invalid_qr'; -- session not open for entry
  elsif v_session.late_entry_cutoff_minutes is not null
        and now() > (v_session.start_time + (v_session.late_entry_cutoff_minutes || ' minutes')::interval)
        and not p_is_override_caller then
    v_result := 'invalid_qr'; -- late-entry blocked; collapsed into invalid_qr, see note above
  elsif v_total_admitted >= v_session.capacity then
    v_result := 'full';
  else
    case v_session.admission_policy
      when 'restricted' then
        if exists(select 1 from allocation_assignments where application_id = p_application_id and session_id = p_session_id and status in ('proposed', 'confirmed')) then
          v_result := 'admitted'; v_entry_type := 'priority';
        else
          v_result := 'restricted_denied';
        end if;
      when 'plenary' then v_result := 'flexible_admitted'; v_entry_type := 'flexible';
      when 'open' then v_result := 'flexible_admitted'; v_entry_type := 'flexible';
      when 'cross_cutting' then v_result := 'flexible_admitted'; v_entry_type := 'flexible';
      when 'priority_then_open' then
        if exists(select 1 from allocation_assignments where application_id = p_application_id and session_id = p_session_id and status in ('proposed', 'confirmed')) then
          v_result := 'admitted'; v_entry_type := 'priority';
        else
          v_released := (
            v_session.flexible_entry_manual_override is true
            or (v_session.flexible_entry_manual_override is distinct from false and v_session.priority_release_at is not null and now() >= v_session.priority_release_at)
            or (v_session.flexible_entry_manual_override is distinct from false and v_session.priority_release_at is null and v_session.priority_release_minutes_before is not null
                and now() >= v_session.start_time - (v_session.priority_release_minutes_before || ' minutes')::interval)
          );
          v_flexible_pool := (v_session.capacity - v_effective_priority_pool)
                              + (case when v_released then greatest(0, v_effective_priority_pool - v_admitted_priority_count) else 0 end);
          if v_total_admitted < v_session.capacity and v_admitted_flexible_count < v_flexible_pool then
            v_result := 'flexible_admitted'; v_entry_type := 'flexible';
          else
            v_result := 'priority_hold';
          end if;
        end if;
    end case;
  end if;

  if p_is_override_caller and v_result in ('restricted_denied', 'full', 'priority_hold') then
    v_result := 'override_admitted'; v_entry_type := 'override';
  end if;

  if v_result in ('admitted', 'flexible_admitted', 'override_admitted') then
    insert into attendance_records (application_id, session_id, time_slot_group_key, entry_type, scanned_by, device_identifier)
    values (p_application_id, p_session_id, p_time_slot_group_key, v_entry_type, p_scanned_by, p_device_identifier)
    returning id into v_attendance_id;
  end if;

  insert into scan_attempts (application_id, session_id, scanned_by, device_identifier, result, resulting_attendance_id)
  values (p_application_id, p_session_id, p_scanned_by, p_device_identifier, v_result, v_attendance_id)
  returning * into v_scan_attempt;

  return v_scan_attempt;
end;
$$ language plpgsql set search_path = public, pg_temp;
```

`p_time_slot_group_key` is computed by the calling TypeScript action via `computeTimeSlotGroupKeyForSession` (Task 9) immediately before the RPC call, and passed in directly — never recomputed inside PL/pgSQL. This is deliberate: porting `time-slot-grouping.ts`'s connected-components algorithm into SQL would duplicate logic the design spec's Non-Goals explicitly say must stay untouched. Task 12's `scanAttemptConfirmForCaller` already wires this correctly.

- [ ] **Step 2: Push**

- [ ] **Step 3: Regenerate types**

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260804160000_scan_attempt_transactional_function.sql src/types/database.ts
git commit -m "feat(db): scan_attempt_transactional RPC"
```

---

## Task 12: scan-attempt server actions (preview + confirm)

**Files:**
- Create: `src/lib/attendance/scan-attempt.ts`

- [ ] **Step 1: Write the module**

```ts
// src/lib/attendance/scan-attempt.ts
'use server';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { requireScannerDeviceCaller } from '@/lib/scanner-device/server-helpers';
import { requireProgramAttendanceStaffCaller } from '@/lib/program-attendance/server-helpers';
import { computeTimeSlotGroupKeyForSession } from './time-slot-lookup';
import { getScannerParticipantSummary } from './participant-summary';
import { resolveAdmissionDecision, type SessionForAdmission, type SessionCounts } from './resolve-admission-decision';

type ServiceClient = SupabaseClient<Database>;

async function verifyScannerScope(service: ServiceClient, userId: string, sessionId: string): Promise<void> {
  const { data: session } = await service.from('sessions').select('id, room_id').eq('id', sessionId).single();
  if (!session) throw new Error('Session not found');
  const { count } = await service
    .from('scanner_assignments')
    .select('*', { count: 'exact', head: true })
    .eq('scanner_user_id', userId)
    .eq('is_active', true)
    .or(`session_id.eq.${sessionId},room_id.eq.${session.room_id}`);
  if (!count || count === 0) throw new Error('Not authorized for this session/room');
}

async function loadSessionForAdmission(service: ServiceClient, sessionId: string): Promise<SessionForAdmission> {
  const { data, error } = await service
    .from('sessions')
    .select('status, admission_policy, capacity, priority_seats, priority_release_at, priority_release_minutes_before, late_entry_cutoff_minutes, flexible_entry_manual_override, start_time')
    .eq('id', sessionId)
    .single();
  if (error || !data) throw new Error('Session not found');
  return {
    status: data.status,
    admissionPolicy: data.admission_policy as SessionForAdmission['admissionPolicy'],
    capacity: data.capacity,
    prioritySeats: data.priority_seats,
    priorityReleaseAt: data.priority_release_at,
    priorityReleaseMinutesBefore: data.priority_release_minutes_before,
    lateEntryCutoffMinutes: data.late_entry_cutoff_minutes,
    flexibleEntryManualOverride: data.flexible_entry_manual_override,
    startTime: data.start_time,
  };
}

async function loadSessionCounts(service: ServiceClient, sessionId: string): Promise<SessionCounts> {
  const { data } = await service.from('attendance_records').select('entry_type').eq('session_id', sessionId).eq('status', 'admitted');
  const rows = data ?? [];
  return {
    totalAdmitted: rows.length,
    admittedPriorityCount: rows.filter((r) => r.entry_type === 'priority').length,
    admittedFlexibleCount: rows.filter((r) => r.entry_type === 'flexible').length,
  };
}

export async function scanAttemptPreviewForCaller(
  params: { applicationId: string; sessionId: string },
  caller: { userId: string; service: ServiceClient }
) {
  const { service, userId } = caller;
  await verifyScannerScope(service, userId, params.sessionId);

  const session = await loadSessionForAdmission(service, params.sessionId);
  const sessionCounts = await loadSessionCounts(service, params.sessionId);
  const timeSlotGroupKey = await computeTimeSlotGroupKeyForSession(service, params.sessionId);

  const { count: hasThisSession } = await service
    .from('attendance_records')
    .select('*', { count: 'exact', head: true })
    .eq('application_id', params.applicationId)
    .eq('session_id', params.sessionId)
    .eq('status', 'admitted');

  const { count: hasConflicting } = await service
    .from('attendance_records')
    .select('*', { count: 'exact', head: true })
    .eq('application_id', params.applicationId)
    .eq('time_slot_group_key', timeSlotGroupKey)
    .neq('session_id', params.sessionId)
    .eq('status', 'admitted');

  const { count: isRecommendedCount } = await service
    .from('allocation_assignments')
    .select('*', { count: 'exact', head: true })
    .eq('application_id', params.applicationId)
    .eq('session_id', params.sessionId)
    .in('status', ['proposed', 'confirmed']);

  const decision = resolveAdmissionDecision({
    now: new Date(),
    session,
    isRecommended: (isRecommendedCount ?? 0) > 0,
    hasActiveAttendanceForThisSession: (hasThisSession ?? 0) > 0,
    hasActiveAttendanceForConflictingSession: (hasConflicting ?? 0) > 0,
    sessionCounts,
    isOverrideCaller: false,
  });

  const summary = await getScannerParticipantSummary(service, params.applicationId);
  return { decision, summary };
}

export async function scanAttemptConfirmForCaller(
  params: { applicationId: string; sessionId: string; deviceIdentifier: string | null },
  caller: { userId: string; service: ServiceClient }
) {
  const { service, userId } = caller;
  await verifyScannerScope(service, userId, params.sessionId);
  const timeSlotGroupKey = await computeTimeSlotGroupKeyForSession(service, params.sessionId);

  const { data, error } = await service.rpc('scan_attempt_transactional', {
    p_application_id: params.applicationId,
    p_session_id: params.sessionId,
    p_scanned_by: userId,
    p_device_identifier: params.deviceIdentifier,
    p_time_slot_group_key: timeSlotGroupKey,
    p_is_override_caller: false,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function scanAttemptPreview(applicationId: string, sessionId: string) {
  const caller = await requireScannerDeviceCaller();
  return scanAttemptPreviewForCaller({ applicationId, sessionId }, caller);
}

export async function scanAttemptConfirm(applicationId: string, sessionId: string, deviceIdentifier: string | null) {
  const caller = await requireScannerDeviceCaller();
  return scanAttemptConfirmForCaller({ applicationId, sessionId, deviceIdentifier }, caller);
}
```

**Note:** `requireProgramAttendanceStaffCaller` import is unused in this file as drafted — remove it, or wire a manager-initiated non-override preview/confirm path if the implementer decides managers should also be able to scan directly (not required by the spec for Phase 1–2; the spec's override path is a separate function in Task 14). Clean up the unused import before committing.

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors (remove the unused import flagged above first).

- [ ] **Step 3: Commit**

```bash
git add src/lib/attendance/scan-attempt.ts
git commit -m "feat(attendance): scan-attempt preview and confirm server actions"
```

---

## Task 13: live tests — happy paths, denials, duplicate, conflict

**Files:**
- Create: `tests/attendance/scan-attempt-live.test.ts`

- [ ] **Step 1: Write the test file**

Follow the exact fixture pattern from `tests/schedule/concurrency.test.ts` (create staff/scanner/participant users, conference_day/room/track/session_type/sessions, an `allocation_run` + `allocation_assignments` row where a recommendation is needed, a `scanner_assignments` row scoping the scanner to the test session). Cover:

- Recommended participant, `priority_then_open` session → `scanAttemptConfirmForCaller` returns `admitted`; `attendance_records` has one row with `entry_type='priority'`.
- Non-recommended participant, `open` session → `flexible_admitted`, `entry_type='flexible'`.
- `restricted` session, non-recommended participant → `restricted_denied`, no `attendance_records` row.
- `plenary` session → `flexible_admitted` unconditionally.
- Session at `capacity` (seed enough prior `attendance_records` rows directly) → next attempt returns `full`, including for a recommended participant.
- Duplicate: confirm twice for the same participant/session → second call returns `duplicate`, `attendance_records` still has exactly one row.
- Timeslot conflict: admit to session A, then attempt session B overlapping in time on the same day → `timeslot_conflict`, no new row.
- Late-entry cutoff: a session with `late_entry_cutoff_minutes` set and `start_time` far enough in the past → normal confirm is blocked; confirming with `p_is_override_caller=true` succeeds and produces `entry_type='override'`.
- Every scan attempt (successful and failed) produces exactly one `scan_attempts` row with the correct `result`.
- `scanAttemptPreviewForCaller` never writes to `attendance_records`/`scan_attempts` (call it, then assert row counts are unchanged).
- **`priority_then_open` release timing against the real RPC** (spec Testing Plan items — these were only unit-tested against the pure function in Task 8; this task must also exercise the real RPC end-to-end, since the pure function and the RPC are two independent implementations that must be proven to agree): a non-recommended participant attempting a `priority_then_open` session *before* `priority_release_at` gets `priority_hold` and no `attendance_records` row; the same participant attempting *after* `priority_release_at` has passed gets `flexible_admitted` and a row with `entry_type='flexible'`, provided the flexible pool has room.
- **Unused priority-seat auto-release against the real RPC**: seed a session with `priority_seats` less than `capacity`, admit fewer priority participants than `priority_seats` allows, advance past `priority_release_at`, then confirm a non-recommended participant — assert the now-unused priority seats correctly count toward the flexible pool (mirrors the pure-function test `flexibly admits a non-recommended participant into a released-but-unused priority seat after release timing`, but against the actual database state via repeated real `scanAttemptConfirmForCaller` calls, not mocked counts).

Use `application_id`, not participant-user sessions, for these tests (mirrors the existing pattern of testing server actions with a service-role client directly, per the `...ForCaller` convention).

- [ ] **Step 2: Run**

Run: `npx vitest run tests/attendance/scan-attempt-live.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/attendance/scan-attempt-live.test.ts
git commit -m "test(attendance): live coverage for scan-attempt happy paths, denials, duplicate, conflict"
```

---

## Task 14: real-concurrency live tests

**Files:**
- Create: `tests/attendance/scan-attempt-concurrency-live.test.ts`

- [ ] **Step 1: Write the test file**

Two scenarios. Unlike `tests/schedule/concurrency.test.ts` (which asserts one `fulfilled` + one `rejected`, since `confirm_publication_transactional` fails fast on lock contention), `scan_attempt_transactional` (Task 11) uses a bounded retry loop around the advisory lock, so under normal test-scale contention **both calls should resolve with a real outcome, not one of them throwing** — use `Promise.all` (not `allSettled`) and expect both promises to fulfill:

1. **Last-seat race**: a session at `capacity - 1` admitted already; two different participants both attempt `scanAttemptConfirmForCaller` for the last seat via `Promise.all`. Assert exactly one call's result is `admitted`/`flexible_admitted` and the other's is `full`. Assert `attendance_records` has exactly `capacity` rows for this session afterward, never more.
2. **Same-participant double-scan race**: the same participant, two different `scanner_assignments`-scoped callers (simulating two devices), both attempt to confirm the same participant for the same session at the same instant via `Promise.all`. Assert `attendance_records` has exactly one `admitted` row for that `(application_id, session_id)` pair afterward (the unique partial index from Task 3 is what actually guarantees this — the advisory lock plus retry loop serializes the two calls, and whichever runs second sees `hasActiveAttendanceForThisSession=true` after the first's insert and returns `duplicate`, not an error).

- [ ] **Step 2: Run**

Run: `npx vitest run tests/attendance/scan-attempt-concurrency-live.test.ts`
Expected: PASS, both promises fulfilled in each scenario. If either scenario is flaky, or if a call unexpectedly rejects with the "still being processed after N retries" exception, that's a real signal — do not adjust the test to hide it or silently switch to `allSettled`; investigate whether the retry count/delay in Task 11 needs tuning, or whether the advisory lock/unique index has a real bug.

- [ ] **Step 3: Commit**

```bash
git add tests/attendance/scan-attempt-concurrency-live.test.ts
git commit -m "test(attendance): real-concurrency coverage for last-seat and double-scan races"
```

---

## Task 15: admission-management RPCs (override, correct, transfer)

**Files:**
- Create: `supabase/migrations/20260804170000_admission_management_functions.sql`
- Create: `src/lib/attendance/admission-management.ts`

- [ ] **Step 1: Write the migration**

Three functions. `admit_override_transactional` calls the same logic as `scan_attempt_transactional` with `p_is_override_caller := true` (simplest: have the override server action call `scan_attempt_transactional` directly with that flag set — no separate RPC needed for override; only `correct` and `transfer` need new RPCs). Write:

```sql
-- admission_management_functions.sql
create or replace function correct_attendance_transactional(
  p_attendance_id uuid,
  p_corrected_by uuid,
  p_reason text
) returns attendance_records as $$
declare
  v_result attendance_records;
begin
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A correction reason is required';
  end if;

  update attendance_records
  set status = 'corrected', correction_reason = p_reason
  where id = p_attendance_id and status = 'admitted'
  returning * into v_result;

  if v_result.id is null then
    raise exception 'Attendance record % not found or not in admitted status', p_attendance_id;
  end if;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;

create or replace function transfer_attendance_transactional(
  p_attendance_id uuid,
  p_new_session_id uuid,
  p_new_time_slot_group_key text,
  p_transferred_by uuid,
  p_reason text
) returns attendance_records as $$
declare
  v_old attendance_records;
  v_new attendance_records;
begin
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A transfer reason is required';
  end if;

  select * into v_old from attendance_records where id = p_attendance_id and status = 'admitted';
  if v_old.id is null then
    raise exception 'Attendance record % not found or not in admitted status', p_attendance_id;
  end if;

  update attendance_records
  set status = 'transferred_out', correction_reason = p_reason
  where id = p_attendance_id;

  -- p_new_time_slot_group_key is computed by the caller via
  -- computeTimeSlotGroupKeyForSession (Task 9) for p_new_session_id,
  -- immediately before calling this RPC — never recomputed here, same
  -- rationale as scan_attempt_transactional (Task 11).
  insert into attendance_records (application_id, session_id, time_slot_group_key, status, entry_type, scanned_by, superseded_attendance_id, correction_reason)
  values (v_old.application_id, p_new_session_id, p_new_time_slot_group_key, 'admitted', 'override', p_transferred_by, v_old.id, p_reason)
  returning * into v_new;

  return v_new;
end;
$$ language plpgsql set search_path = public, pg_temp;
```

- [ ] **Step 2: Push and regenerate types**

- [ ] **Step 3: Write `src/lib/attendance/admission-management.ts`**

Three `...ForCaller` + `'use server'` wrapper pairs, all gated by `requireProgramAttendanceStaffCaller` (not `requireScannerDeviceCaller` — these are manager-only per the spec's permission matrix):

- `admitOverrideForCaller`/`admitOverride`: calls `scanAttemptConfirmForCaller`'s underlying RPC directly (`service.rpc('scan_attempt_transactional', {..., p_is_override_caller: true})`), then writes a full `audit_logs` entry (actor, application/session ids, reason) via the existing shared `writeAuditLog` helper (`src/lib/agenda/server-helpers.ts` — reuse it, do not duplicate).
- `correctAttendanceForCaller`/`correctAttendance`: calls `correct_attendance_transactional`, then `writeAuditLog`.
- `transferAttendanceForCaller`/`transferAttendance`: computes the new session's time-slot key via `computeTimeSlotGroupKeyForSession`, calls `transfer_attendance_transactional`, then `writeAuditLog`.

All three require a non-empty `reason` string at the TypeScript layer too (defense-in-depth alongside the DB check), matching this codebase's established validation-at-every-layer pattern.

- [ ] **Step 4: Typecheck**

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260804170000_admission_management_functions.sql src/types/database.ts src/lib/attendance/admission-management.ts
git commit -m "feat(attendance): override, correct, and transfer admission-management actions"
```

---

## Task 16: admission-management + audit-trail live tests

**Files:**
- Create: `tests/attendance/admission-management-live.test.ts`

- [ ] **Step 1: Write the test file**

Cover:
- `admitOverrideForCaller` on a `restricted_denied`/`full` case → succeeds, `entry_type='override'`, one `audit_logs` row.
- `correctAttendanceForCaller` on an `admitted` row → row becomes `status='corrected'`, never deleted, one `audit_logs` row.
- `transferAttendanceForCaller` → old row `transferred_out`, new row `admitted` with `superseded_attendance_id` pointing to the old row, one `audit_logs` row.
- Rejecting all three when `reason` is empty/missing (both a DB-level and a TS-level check).
- Full audit trail: run a mixed sequence (a few successful scans, a few failed ones, one of each admin action) and assert the exact expected count of `scan_attempts` rows and `audit_logs` rows.
- **No participant write path** (spec Testing Plan item, backend-verifiable without any UI): confirm there is no server action anywhere in `src/lib/attendance/` or the existing `(participant)` route tree that lets a participant-role caller write to `attendance_records`, `scan_attempts`, or their own `schedule_publication_items` — attempt a direct RLS-scoped write as a participant-role Supabase client (matching the pattern in `tests/attendance/scanner-device-access-live.test.ts`, Task 17) and assert it is rejected.
- **Recommended-vs-actual reporting query** (spec Testing Plan item): seed a scenario where a participant is recommended for session A but actually admitted to session B (a flexible entry) in the same timeslot. Write and run a query joining `attendance_records` (status='admitted') with `allocation_assignments` (status in ('proposed','confirmed')) on `application_id` + `time_slot_group_key`, and assert it correctly classifies this case as "attended a different session than recommended" versus a control case where the participant attended their actual recommended session.

- [ ] **Step 2: Run**

Run: `npx vitest run tests/attendance/admission-management-live.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/attendance/admission-management-live.test.ts
git commit -m "test(attendance): live coverage for override, correct, transfer, audit trail, and recommended-vs-actual reporting"
```

---

## Task 17: `scanner_device` access-boundary live tests

**Files:**
- Create: `tests/attendance/scanner-device-access-live.test.ts`

- [ ] **Step 1: Write the test file**

Cover, as direct negative-path calls (not just RLS probing):
- A `scanner_device` user attempting `scanAttemptConfirmForCaller` for a session **not** in its `scanner_assignments` → throws.
- A `scanner_device` user attempting to call `admitOverrideForCaller`/`correctAttendanceForCaller`/`transferAttendanceForCaller` → throws (`requireProgramAttendanceStaffCaller` rejects it).
- A `scanner_device`-scoped Supabase client (real signed-in session, anon key, matching the pattern from `tests/auth/staff-roles-live.test.ts`'s sensitive-data RLS tests) cannot `select` from `application_travel_info`/`application_health_info`/`allocation_assignments`/`schedule_publications` — empty result or error.
- A `scanner_device`-scoped client cannot read `attendance_records`/`scan_attempts` for a session outside its `scanner_assignments` scope, even though it can read its own scope.
- A `program_attendance_manager` (not `scanner_device`) CAN call `admitOverrideForCaller` etc. — confirms the boundary is real, not just "scanner is denied everything."

- [ ] **Step 2: Run**

Run: `npx vitest run tests/attendance/scanner-device-access-live.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/attendance/scanner-device-access-live.test.ts
git commit -m "test(attendance): scanner_device access-boundary coverage"
```

---

## Task 18: `priority_pool_exceeded` issue type + validation logic

**Files:**
- Create: `supabase/migrations/20260804180000_add_priority_pool_exceeded_issue_type.sql`
- Create: `src/lib/allocation/priority-pool-validation.ts`
- Test: `tests/allocation/priority-pool-validation.test.ts`
- Modify: `src/lib/allocation/run-allocation.ts`

- [ ] **Step 1: Write the migration**

```sql
-- add_priority_pool_exceeded_issue_type.sql
--
-- allocation_issues.issue_type is a plain text column with a check
-- constraint named allocation_issues_type_valid (confirmed by reading
-- supabase/migrations/20260723100000_allocation_tables.sql directly —
-- NOT a Postgres enum, and NOT auto-named allocation_issues_issue_type_
-- check as a naive guess might assume), so this is an ordinary
-- constraint update, not an isolated-enum migration.
alter table allocation_issues drop constraint allocation_issues_type_valid;
alter table allocation_issues add constraint allocation_issues_type_valid
  check (issue_type in ('unassigned', 'low_confidence', 'capacity_bottleneck', 'schedule_conflict', 'no_eligible_sessions', 'priority_pool_exceeded'));
```

- [ ] **Step 2: Push and regenerate types**

- [ ] **Step 3: Write the failing test**

```ts
// tests/allocation/priority-pool-validation.test.ts
import { describe, expect, it } from 'vitest';
import { derivePriorityPoolIssues } from '@/lib/allocation/priority-pool-validation';

describe('derivePriorityPoolIssues', () => {
  it('flags a session where recommended count exceeds priority_seats', () => {
    const issues = derivePriorityPoolIssues({
      recommendedCountBySession: { 'session-a': 12 },
      prioritySeatsBySession: { 'session-a': 8 },
      capacityBySession: { 'session-a': 15 },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ issueType: 'priority_pool_exceeded', sessionId: 'session-a' });
    expect(issues[0].details).toMatchObject({ recommended_count: 12, priority_seats: 8 });
  });

  it('treats a null priority_seats as capacity (never flags in that case unless recommended exceeds capacity itself)', () => {
    const issues = derivePriorityPoolIssues({
      recommendedCountBySession: { 'session-a': 10 },
      prioritySeatsBySession: { 'session-a': null },
      capacityBySession: { 'session-a': 15 },
    });
    expect(issues).toHaveLength(0);
  });

  it('does not flag a session at or under its priority pool', () => {
    const issues = derivePriorityPoolIssues({
      recommendedCountBySession: { 'session-a': 8 },
      prioritySeatsBySession: { 'session-a': 8 },
      capacityBySession: { 'session-a': 15 },
    });
    expect(issues).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/allocation/priority-pool-validation.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 5: Write the implementation**

```ts
// src/lib/allocation/priority-pool-validation.ts
//
// Sibling to src/lib/allocation/issues.ts's deriveIssues — a separate pure
// function, not a modification of deriveIssues, since it needs
// priority_seats data that deriveIssues' existing input shape doesn't
// carry. Report-only: never blocks run confirmation (design spec's
// "Recommendation-to-Priority-Pool Validation" section).
export interface PriorityPoolIssue {
  issueType: 'priority_pool_exceeded';
  sessionId: string;
  applicationId: null;
  details: Record<string, unknown>;
}

export interface PriorityPoolValidationInput {
  recommendedCountBySession: Record<string, number>;
  prioritySeatsBySession: Record<string, number | null>;
  capacityBySession: Record<string, number>;
}

export function derivePriorityPoolIssues(input: PriorityPoolValidationInput): PriorityPoolIssue[] {
  const issues: PriorityPoolIssue[] = [];
  for (const [sessionId, recommendedCount] of Object.entries(input.recommendedCountBySession)) {
    const prioritySeats = input.prioritySeatsBySession[sessionId];
    const capacity = input.capacityBySession[sessionId];
    const effectivePool = prioritySeats ?? capacity;
    if (recommendedCount > effectivePool) {
      issues.push({
        issueType: 'priority_pool_exceeded',
        sessionId,
        applicationId: null,
        details: { recommended_count: recommendedCount, priority_seats: prioritySeats, capacity, session_id: sessionId },
      });
    }
  }
  return issues;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/allocation/priority-pool-validation.test.ts`
Expected: PASS

- [ ] **Step 7: Wire into `run-allocation.ts`**

Read the current insert block around line 350-377 of `src/lib/allocation/run-allocation.ts` (the `deriveIssues` call site) first. Add a second, separate call right after the existing `issues` insert:

```ts
// Second, independent issue-derivation pass — see design spec's
// "Recommendation-to-Priority-Pool Validation" section. Deliberately not
// merged into deriveIssues' input/output shape above.
const { data: sessionsForPriorityCheck } = await service
  .from('sessions')
  .select('id, priority_seats, capacity')
  .in('id', [...new Set(assignmentsForIssues.map((a) => a.sessionId))]);

const recommendedCountBySession: Record<string, number> = {};
for (const a of assignmentsForIssues) {
  recommendedCountBySession[a.sessionId] = (recommendedCountBySession[a.sessionId] ?? 0) + 1;
}
const prioritySeatsBySession: Record<string, number | null> = {};
const capacityBySession: Record<string, number> = {};
for (const s of sessionsForPriorityCheck ?? []) {
  prioritySeatsBySession[s.id] = s.priority_seats;
  capacityBySession[s.id] = s.capacity;
}

const priorityPoolIssues = derivePriorityPoolIssues({ recommendedCountBySession, prioritySeatsBySession, capacityBySession });
if (priorityPoolIssues.length > 0) {
  const { error: priorityIssuesErr } = await service.from('allocation_issues').insert(
    priorityPoolIssues.map((i) => ({
      allocation_run_id: run.id,
      issue_type: i.issueType,
      application_id: i.applicationId,
      session_id: i.sessionId,
      details: i.details as Json,
    }))
  );
  if (priorityIssuesErr) throw new Error(`Failed to write priority-pool issues: ${priorityIssuesErr.message}`);
}
```

Add the import: `import { derivePriorityPoolIssues } from './priority-pool-validation';`

**Read the actual current file first** (do not blind-paste — `assignmentsForIssues`'s exact shape/variable name must be confirmed against the real file content, which may have shifted slightly since this plan was written).

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 9: Write and run a live test**

Create `tests/allocation/priority-pool-validation-live.test.ts`: seed a session with `capacity=10, priority_seats=3`, seed enough eligible participants that a real `runAllocation` call recommends more than 3 for that session, run allocation, then assert an `allocation_issues` row with `issue_type='priority_pool_exceeded'` exists for that session. Follow the fixture pattern from an existing allocation live test (e.g. `tests/allocation/run-behavioral.test.ts`).

Run: `npx vitest run tests/allocation/priority-pool-validation-live.test.ts`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/20260804180000_add_priority_pool_exceeded_issue_type.sql src/types/database.ts src/lib/allocation/priority-pool-validation.ts tests/allocation/priority-pool-validation.test.ts tests/allocation/priority-pool-validation-live.test.ts src/lib/allocation/run-allocation.ts
git commit -m "feat(allocation): priority_pool_exceeded issue detection after runAllocation"
```

---

## Task 19: full-suite verification and final review

- [ ] **Step 1: Run the complete new/modified test surface**

Run: `npx vitest run tests/attendance tests/allocation/priority-pool-validation.test.ts tests/allocation/priority-pool-validation-live.test.ts tests/lib/shell/role-label.test.ts tests/lib/auth/post-login-destination.test.ts`
Expected: PASS, all files.

- [ ] **Step 2: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: no errors; only pre-existing unrelated warnings.

- [ ] **Step 3: Confirm migrations local == remote**

Run: `npx supabase migration list` — verify every migration's `local` matches `remote`, including all 9 new ones from this plan.

- [ ] **Step 4: Confirm git tree is clean**

Run: `git status --short` — should show nothing uncommitted.

- [ ] **Step 5: Hand off to finishing-a-development-branch**

At this point, invoke the `superpowers:finishing-a-development-branch` skill to decide how this worktree's branch gets merged/PR'd/kept, per that skill's standard 4-option flow. Do not merge or push without going through that skill.
