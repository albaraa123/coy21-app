# Staff Role Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the 7 staff-domain `user_role` enum values (`registration_admission_manager`, `agenda_allocation_manager`, `communications_attendance_manager`, `travel_operations_staff`, `participant_care_staff`, `participants_communications_manager`, `program_attendance_manager`) into a single `staff` role holding the union of their permissions. Final role set: `participant`, `super_admin`, `staff`, `scanner_device` — 4 roles instead of 10.

**Architecture:** Additive Postgres enum migration (`alter type user_role add value 'staff'`) plus a data migration moving existing profiles, then a single shared `is_staff()` SQL helper used by every RLS policy and inline plpgsql role check that currently enumerates the 7 old roles. On the TypeScript side, a single `isStaffRole()` function replaces 6 domain-specific `is<X>StaffRole()` functions; every call site across `src/` is updated to the shared function. The 7 old enum values remain physically in the Postgres type (Postgres cannot drop enum values in place) but are never assigned again.

**Tech Stack:** Next.js App Router, Supabase/Postgres (RLS, SQL/plpgsql functions), TypeScript, Zod, Vitest (`renderToStaticMarkup`-based component tests, plain assertion tests for pure logic)

**Full design spec:** `docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md` — read this first for the full rationale and the confirmed security tradeoff (approved by the user: a single `staff` account can access everything the 7 separate roles could).

---

## File Structure

**New files:**
- `supabase/migrations/20260929000000_add_staff_role_and_migrate.sql` — enum addition + data migration + `is_staff()` helper
- `supabase/migrations/20260929010000_consolidate_rls_policies_to_staff.sql` — drop/recreate ~30 RLS policies to use `is_staff()`
- `supabase/migrations/20260929020000_consolidate_inline_role_checks_to_staff.sql` — rewrite inline plpgsql checks in the 3 RPC-bearing migrations' functions (via `create or replace function`)
- `src/lib/auth/is-staff-role.ts` — the new shared `isStaffRole()` / `STAFF_ROLES` (narrow: staff + super_admin)

**Modified files (renamed export, not deleted):**
- `src/lib/auth/post-login-destination.ts` — `STAFF_ROLES`/`isStaffRole` renamed to `NON_PARTICIPANT_ROLES`/`isNonParticipantRole` (wider: everything except participant, still includes scanner_device)
- `src/lib/shell/admin-access.ts` — import updated to `isNonParticipantRole`
- `src/lib/shell/role-label.ts` — `ROLE_LABEL_KEYS` shrinks to 4 entries
- `src/lib/validation/funding-type.ts` — both functions collapse to call `isStaffRole` directly

**Deleted files (function bodies inlined into the new shared module, files themselves keep their non-staff-role exports where applicable):**
- `src/lib/validation/admission-review.ts` — `isAdmissionStaffRole`/`ADMISSION_STAFF_ROLES` removed (rest of file, e.g. `VALID_TRANSITIONS`, stays)
- `src/lib/validation/agenda.ts` — `isAgendaStaffRole`/`AGENDA_STAFF_ROLES` removed (rest of file stays)
- `src/lib/validation/travel-ops.ts` — entire file deleted (contains nothing but the role check)
- `src/lib/validation/participant-care.ts` — entire file deleted (contains nothing but the role check)
- `src/lib/validation/participants-communications.ts` — entire file deleted (contains nothing but the role check)
- `src/lib/validation/program-attendance.ts` — entire file deleted (contains nothing but the role check)

**Modified files (~55 call sites across `src/`, mechanical import + call-site swap):** every file returned by the searches in Task 4 below — the plan does not enumerate each one individually; the task defines the exact transformation and requires the implementer to verify completeness via grep, not by trusting a fixed list.

**Modified UI:**
- `src/app/[locale]/(admin)/staff/staff-manager.tsx` — role dropdown shrinks to `super_admin` + `staff`
- `src/messages/en.json`, `src/messages/ar.json` — `shell.roles.*` shrinks to 4 keys

**Not touched:** `src/lib/validation/scanner-device.ts` (unrelated role, confirmed disjoint), `src/lib/auth/provision-staff-account.ts` (generic `role: string` param, no structural change needed).

---

## Task 1: Database — add `staff` enum value, migrate data, add `is_staff()` helper

**Files:**
- Create: `supabase/migrations/20260929000000_add_staff_role_and_migrate.sql`
- Test: manual verification via `supabase db reset` (or equivalent local/scratch project) — this task has no Vitest coverage since it's pure SQL DDL/DML

This task must run alone, in its own migration file, because `alter type ... add value` cannot run inside the same transaction block as statements that then use the new value (Postgres restriction: a new enum value isn't visible to other statements in the same transaction that added it, in some Postgres versions/configurations). Splitting into two files avoids this entirely — by the time migration 2 runs, `staff` is a committed, visible enum value.

- [ ] **Step 1: Write the migration**

```sql
-- 20260929000000_add_staff_role_and_migrate.sql
--
-- Part 1 of the staff role consolidation (see
-- docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md).
-- Adds 'staff' as a new user_role enum value. This is additive only —
-- the 7 old staff-domain values are not removed (Postgres does not
-- support dropping enum values in place) and remain physically in the
-- type but are deprecated: no code path will assign them again after
-- this migration.
alter type user_role add value 'staff';
```

- [ ] **Step 2: Run this migration alone first**

Postgres requires `alter type ... add value` to be committed before the new value can be used in the same session/subsequent statements in some configurations. Apply this file by itself against your Supabase project (or local `supabase db reset` if the whole migration history is replayed) before writing Step 3's content into a file that will run after it — do NOT put the `update profiles ...` statement in the same file as the `alter type` statement above.

- [ ] **Step 3: Add the data migration and `is_staff()` helper to a SEPARATE new file**

Create `supabase/migrations/20260929000001_migrate_staff_profiles_and_add_helper.sql`:

```sql
-- 20260929000001_migrate_staff_profiles_and_add_helper.sql
--
-- Part 2 of the staff role consolidation. Must run in a migration file
-- AFTER 20260929000000 (which added 'staff' to the user_role enum) is
-- committed — see that file's header comment for why this can't be
-- combined into one file.

-- Move every existing profile off the 7 deprecated staff-domain roles.
update profiles set role = 'staff'
where role in (
  'registration_admission_manager',
  'agenda_allocation_manager',
  'communications_attendance_manager',
  'travel_operations_staff',
  'participant_care_staff',
  'participants_communications_manager',
  'program_attendance_manager'
);

-- Shared helper: single source of truth for "is this caller staff" in
-- SQL/plpgsql. Built on the existing current_user_role() helper
-- (20260721212035_rls_policies.sql). Used by every RLS policy and every
-- inline plpgsql role check this consolidation touches (Tasks 2 and 3).
create function is_staff() returns boolean as $$
  select current_user_role() in ('staff', 'super_admin');
$$ language sql stable security definer set search_path = public;

comment on type user_role is
  'registration_admission_manager, agenda_allocation_manager, communications_attendance_manager, '
  'travel_operations_staff, participant_care_staff, participants_communications_manager, and '
  'program_attendance_manager are DEPRECATED as of 2026-09-29 (see '
  'docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md). Do not assign them to new '
  'profiles — use staff instead. They remain in this type only because Postgres cannot drop enum '
  'values in place.';
```

- [ ] **Step 4: Apply and verify**

Apply both migrations against your target Supabase project. Then run:

```sql
select role, count(*) from profiles group by role order by role;
```

Expected: no rows with any of the 7 deprecated role values; any staff accounts that existed now show `role = 'staff'`.

```sql
select is_staff();
```

Expected: runs without error (returns `false` if called as a `participant`/anon session, `true` if called as `staff`/`super_admin` — exact result depends on the calling session's `auth.uid()`).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260929000000_add_staff_role_and_migrate.sql supabase/migrations/20260929000001_migrate_staff_profiles_and_add_helper.sql
git commit -m "feat: add staff enum value, migrate existing staff profiles, add is_staff() helper"
```

---

## Task 2: Database — consolidate RLS policies to use `is_staff()`

**Files:**
- Create: `supabase/migrations/20260929010000_consolidate_rls_policies_to_staff.sql`
- Reference (read-only, do not edit): the 30 migration files identified in the spec's "Scope of impact" section as containing `create policy` statements that reference one of the 7 old roles

**Context:** Every RLS policy in this codebase reads the caller's role via `current_user_role()` and compares it to a literal role list, e.g. `using (current_user_role() in ('registration_admission_manager', 'super_admin'))`. Postgres has no `alter policy ... using (...)`, so each affected policy must be dropped and recreated with the same name, same table, same command (`for select`/`for insert`/`for update`/`for delete`), and same structure — just swapping the `using`/`with check` expression for `is_staff()`.

- [ ] **Step 1: Enumerate every policy to change**

Run this from the project root to get the definitive list (do not rely on a hand-typed list — re-derive it, since migration history may have shifted since the spec was written):

```bash
grep -rn "current_user_role() in (" supabase/migrations/ | grep -E "registration_admission_manager|agenda_allocation_manager|communications_attendance_manager|travel_operations_staff|participant_care_staff|participants_communications_manager|program_attendance_manager"
grep -rn "current_user_role() = '" supabase/migrations/ | grep -E "registration_admission_manager|agenda_allocation_manager|communications_attendance_manager|travel_operations_staff|participant_care_staff|participants_communications_manager|program_attendance_manager"
```

For each match, note: the migration file it's defined in (for reference only — you will NOT edit that file), the exact `create policy <name> on <table> for <command> ...` statement it belongs to (search upward in the same file from the matched line to find the enclosing `create policy` statement), and whether it's a `using` clause, a `with check` clause, or both.

- [ ] **Step 2: Write the consolidation migration**

For each policy found in Step 1, add a `drop policy` + `create policy` pair to the new migration file. Use the exact same policy name and table so this is a like-for-like replacement, not a new policy. Example, using the two policies already confirmed in `20260721212035_rls_policies.sql`:

```sql
-- 20260929010000_consolidate_rls_policies_to_staff.sql
--
-- Part 3 of the staff role consolidation. Replaces every RLS policy that
-- enumerates one or more of the 7 deprecated staff-domain roles with a
-- single is_staff() check (added in 20260929000001). Each policy is
-- dropped and recreated with the SAME name and table — this must be a
-- like-for-like structural replacement, not a new policy, so nothing
-- else about each table's RLS surface changes.

drop policy if exists applications_select_staff on applications;
create policy applications_select_staff on applications
  for select using (is_staff());

drop policy if exists application_status_history_select_staff on application_status_history;
create policy application_status_history_select_staff on application_status_history
  for select using (is_staff());

drop policy if exists email_log_select_staff on email_log;
create policy email_log_select_staff on email_log
  for select using (is_staff());

-- ... continue for every policy found in Step 1, grouped by the table
-- they belong to for readability. Preserve exact `for select` / `for
-- insert with check` / `for update using ... with check` / `for delete`
-- shape from the original — only the role-comparison expression changes.
```

Work through Step 1's full list systematically, table by table. Do not skip any — if a policy combines a staff-role check with an additional non-role condition (e.g. `current_user_role() = 'travel_operations_staff' and some_other_column = true`), preserve the additional condition and only replace the role-comparison portion with `is_staff()`.

- [ ] **Step 3: Verify no policy was missed**

After writing the full migration, re-run Step 1's grep against the NEW migration file itself — it should return zero matches (every occurrence should now be replaced by `is_staff()`, not re-introduced). Then run Step 1's grep against the full `supabase/migrations/` directory again — the matches will still show up in the OLD (historical) files, which is expected and correct (history is never rewritten); what matters is that Task 2's new migration's `drop policy` list has one entry per distinct policy name found, with no gaps.

- [ ] **Step 4: Apply and spot-check**

Apply the migration. Run:

```sql
select schemaname, tablename, policyname, qual from pg_policies
where qual ilike '%registration_admission_manager%'
   or qual ilike '%agenda_allocation_manager%'
   or qual ilike '%communications_attendance_manager%'
   or qual ilike '%travel_operations_staff%'
   or qual ilike '%participant_care_staff%'
   or qual ilike '%participants_communications_manager%'
   or qual ilike '%program_attendance_manager%';
```

Expected: zero rows. If any row appears, a policy was missed in Step 2 — go back and add it.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260929010000_consolidate_rls_policies_to_staff.sql
git commit -m "feat: consolidate RLS policies to use is_staff() instead of 7 domain roles"
```

---

## Task 3: Database — consolidate inline plpgsql role checks

**Files:**
- Create: `supabase/migrations/20260929020000_consolidate_inline_role_checks_to_staff.sql`
- Reference (read-only): `supabase/migrations/20260805235959_phase6_qr_issuance_reissue.sql`, `supabase/migrations/20260810000000_fix_qr_finalizer_audit_actor_type_cast.sql`, `supabase/migrations/20260811210000_fix_staff_blocker_resolver_channel_check.sql`

**Context:** Some `SECURITY DEFINER` RPC functions check the caller's role via an inline plpgsql `if` statement comparing a fetched column value (e.g. `v_caller_role`) against a literal list, rather than through an RLS policy — these are NOT covered by Task 2 and need their own pass. Since these are full function bodies, the fix is `create or replace function` with the complete corrected body — Postgres has no way to patch a single `if` statement inside an existing function.

- [ ] **Step 1: Locate every affected function**

```bash
grep -n "v_caller_role\|caller_role not in" supabase/migrations/20260805235959_phase6_qr_issuance_reissue.sql supabase/migrations/20260810000000_fix_qr_finalizer_audit_actor_type_cast.sql supabase/migrations/20260811210000_fix_staff_blocker_resolver_channel_check.sql
```

For each match, identify the enclosing `create function` / `create or replace function` statement (search upward from the match to the nearest `create [or replace] function <name>`). Build a list of distinct function names that need a full `create or replace function` in the new migration.

- [ ] **Step 2: For each affected function, read its CURRENT full definition**

RPC functions may have been altered by later migrations (e.g. `20260810000000` and `20260811210000` both post-date `20260805235959` and may themselves be corrections to functions first defined there). For each function name from Step 1, find its most recent `create or replace function` definition across ALL of `supabase/migrations/` (not just the 3 files listed), sorted by migration timestamp, to make sure you replace the CURRENT behavior, not a stale/superseded version.

```bash
grep -rln "create or replace function <function_name>" supabase/migrations/
```

- [ ] **Step 3: Write the new migration with corrected function bodies**

For each function, write a `create or replace function` statement identical to its current (most recent) definition from Step 2, except every occurrence of the pattern:

```plpgsql
if v_caller_role not in ('super_admin', '<some_old_role>') then
  raise exception '...';
end if;
```

becomes:

```plpgsql
if not is_staff() then
  raise exception '...';
end if;
```

`is_staff()` already covers `super_admin` (see Task 1's definition), so the `v_caller_role`-fetching logic that feeds these checks may become dead code within the function if it's not used for anything else in that function body — check each function individually; if `v_caller_role` is used elsewhere in the same function (e.g. for logging/audit purposes), keep the variable and its fetch, and only replace the `if ... not in (...)` condition itself.

- [ ] **Step 4: Verify no inline check was missed**

```bash
grep -n "not in ('super_admin'" supabase/migrations/20260929020000_consolidate_inline_role_checks_to_staff.sql
```

Expected: zero matches in the NEW file (everything should now route through `is_staff()`). Then re-run the full-history sweep from the design spec to confirm no other migration file beyond the 3 already known contains this pattern:

```bash
grep -rlE "v_caller_role|caller_role not in" supabase/migrations/
```

Expected: exactly the 3 files already identified, still present (historical files are never edited) — if a 4th file appears, it was missed in prior research; add its functions to this task before proceeding.

- [ ] **Step 5: Apply and test the affected RPCs manually**

Since these are QR issuance/reissue and staff-blocker-resolution functions, call each one (via `select function_name(...)` in the SQL editor, or through the app's actual flow if a scratch Supabase project with test data is available) once as a `staff`-role caller and once as a `participant`-role caller, confirming the staff caller succeeds and the participant caller is rejected with the expected exception.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260929020000_consolidate_inline_role_checks_to_staff.sql
git commit -m "feat: consolidate inline plpgsql role checks in RPC functions to use is_staff()"
```

---

## Task 4: TypeScript — create the shared `isStaffRole()` module

**Files:**
- Create: `src/lib/auth/is-staff-role.ts`
- Test: `tests/auth/is-staff-role.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/auth/is-staff-role.test.ts
import { describe, it, expect } from 'vitest';
import { isStaffRole, STAFF_ROLES } from '@/lib/auth/is-staff-role';

describe('isStaffRole', () => {
  it('returns true for staff', () => {
    expect(isStaffRole('staff')).toBe(true);
  });

  it('returns true for super_admin', () => {
    expect(isStaffRole('super_admin')).toBe(true);
  });

  it('returns false for participant', () => {
    expect(isStaffRole('participant')).toBe(false);
  });

  it('returns false for scanner_device', () => {
    expect(isStaffRole('scanner_device')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isStaffRole(null)).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
  });

  it('returns false for a deprecated domain role', () => {
    expect(isStaffRole('registration_admission_manager')).toBe(false);
    expect(isStaffRole('travel_operations_staff')).toBe(false);
  });

  it('STAFF_ROLES contains exactly staff and super_admin', () => {
    expect(STAFF_ROLES).toEqual(['staff', 'super_admin']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auth/is-staff-role.test.ts`
Expected: FAIL — `Cannot find module '@/lib/auth/is-staff-role'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/auth/is-staff-role.ts
//
// Single source of truth for "is this profile.role allowed to act as
// staff" — replaces the 6 domain-specific is<X>StaffRole() functions
// this codebase used to have (isAdmissionStaffRole, isAgendaStaffRole,
// isTravelOpsStaffRole, isParticipantCareStaffRole,
// isParticipantsCommunicationsStaffRole, isProgramAttendanceStaffRole),
// now that all 7 staff-domain roles have been consolidated into a
// single 'staff' user_role enum value (see
// docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md).
//
// NOT the same as isNonParticipantRole (src/lib/auth/post-login-destination.ts)
// — that check is deliberately wider and includes scanner_device, for
// post-login-redirect purposes. This check is narrower: "is this a
// general-purpose staff account", excluding the dedicated scanner_device
// role.
export const STAFF_ROLES = ['staff', 'super_admin'] as const;

export function isStaffRole(role: string | null | undefined): boolean {
  return role != null && (STAFF_ROLES as readonly string[]).includes(role);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auth/is-staff-role.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/is-staff-role.ts tests/auth/is-staff-role.test.ts
git commit -m "feat: add shared isStaffRole() to replace 6 domain-specific staff role checks"
```

---

## Task 5: TypeScript — rename `post-login-destination.ts`'s wider check to resolve the naming collision

**Files:**
- Modify: `src/lib/auth/post-login-destination.ts`
- Modify: `src/lib/shell/admin-access.ts`
- Test: check for and update any existing test file covering these two modules (search `tests/` for `post-login-destination` and `admin-access` before starting)

**Context:** `post-login-destination.ts` currently exports `STAFF_ROLES`/`isStaffRole` with a WIDER meaning than Task 4's new module — "any non-participant role," including `scanner_device`, derived from `role-label.ts`'s `ROLE_LABEL_KEYS`. This is a genuine name collision: two different concepts with the same name. This task renames the existing (wider) export so both concepts coexist under distinct names.

- [ ] **Step 1: Locate the existing tests**

```bash
grep -rl "post-login-destination\|resolvePostLoginDestination" tests/
grep -rl "admin-access\|decideAdminAccess" tests/
```

Read whatever test files these return — they will need their imports/assertions updated in Step 3 if they reference `STAFF_ROLES`/`isStaffRole` by name.

- [ ] **Step 2: Rename the export in `post-login-destination.ts`**

In `src/lib/auth/post-login-destination.ts`:
- Rename `export const STAFF_ROLES = ...` to `export const NON_PARTICIPANT_ROLES = ...`
- Rename `export function isStaffRole(...)` to `export function isNonParticipantRole(...)`
- Update the internal call site inside `resolvePostLoginDestination` (currently `if (isStaffRole(role))`) to `if (isNonParticipantRole(role))`
- Update the file's doc comments that reference the old names to the new ones (the comment block already explains the "any non-participant role, built from ROLE_LABEL_KEYS" rationale — keep that rationale, just fix the names it mentions)

Do NOT change the underlying logic (still derived from `ROLE_LABEL_KEYS` minus `participant`) — only the exported names.

- [ ] **Step 3: Update `admin-access.ts`'s import**

In `src/lib/shell/admin-access.ts`, change:
```typescript
import { isStaffRole } from '@/lib/auth/post-login-destination';
```
to:
```typescript
import { isNonParticipantRole } from '@/lib/auth/post-login-destination';
```
and update the call site (`if (!isStaffRole(role))`) to `if (!isNonParticipantRole(role))`. Update the file's doc comment (lines referencing "isStaffRole (src/lib/auth/post-login-destination.ts)") to the new name.

- [ ] **Step 4: Update any test files found in Step 1**

Apply the same rename to any test file that imports or asserts on `STAFF_ROLES`/`isStaffRole` from `post-login-destination.ts` specifically (not Task 4's new module — that one keeps the name `isStaffRole`, it's a different, narrower function).

- [ ] **Step 5: Run affected tests**

Run: `npx vitest run tests/auth tests/shell`
Expected: PASS, no references to the old names remain

- [ ] **Step 6: Verify no other file imports the old names from this specific module**

```bash
grep -rn "from '@/lib/auth/post-login-destination'" src/ tests/
```

For each result, open the file and confirm it doesn't destructure `STAFF_ROLES` or `isStaffRole` from this import (only `NON_PARTICIPANT_ROLES`/`isNonParticipantRole`, or other exports like `resolvePostLoginDestination`/`PostLoginDestination`).

- [ ] **Step 7: Commit**

```bash
git add src/lib/auth/post-login-destination.ts src/lib/shell/admin-access.ts
git commit -m "refactor: rename post-login-destination's staff check to isNonParticipantRole to resolve naming collision with new isStaffRole"
```

---

## Task 6: TypeScript — shrink `role-label.ts`'s `ROLE_LABEL_KEYS` to 4 roles

**Files:**
- Modify: `src/lib/shell/role-label.ts`
- Test: search `tests/` for `role-label` / `roleLabelKey` / `ROLE_LABEL_KEYS` and update accordingly

**Context:** This is the canonical role enumeration that `post-login-destination.ts`'s `NON_PARTICIPANT_ROLES` (Task 5) derives from. Shrinking it here automatically narrows that derived list too — no separate edit needed in `post-login-destination.ts` for this part.

- [ ] **Step 1: Locate existing tests**

```bash
grep -rl "role-label\|roleLabelKey\|ROLE_LABEL_KEYS" tests/
```

- [ ] **Step 2: Update `ROLE_LABEL_KEYS`**

In `src/lib/shell/role-label.ts`, replace the object literal:

```typescript
export const ROLE_LABEL_KEYS = {
  participant: 'roles.participant',
  super_admin: 'roles.super_admin',
  staff: 'roles.staff',
  scanner_device: 'roles.scanner_device',
} as const;
```

Remove the doc comment's historical note about `travel_operations_staff`/`participant_care_staff` being added late (no longer relevant — update or remove that paragraph since those roles no longer exist in this mapping).

- [ ] **Step 3: Update tests found in Step 1**

Any test asserting the old 10-key shape needs updating to the new 4-key shape; any test asserting `roleLabelKey('registration_admission_manager')` (or another deprecated role) returns a specific key should now assert it returns `undefined` (since `roleLabelKey` already handles unrecognized roles by falling back to `undefined` — see its existing doc comment).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/shell`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/shell/role-label.ts
git commit -m "refactor: shrink ROLE_LABEL_KEYS to the 4 consolidated roles"
```

---

## Task 7: TypeScript — delete the 6 domain-specific staff-role checks, update `admission-review.ts` and `agenda.ts`

**Files:**
- Modify: `src/lib/validation/admission-review.ts` (remove `isAdmissionStaffRole`/`ADMISSION_STAFF_ROLES` only; keep the rest of the file)
- Modify: `src/lib/validation/agenda.ts` (remove `isAgendaStaffRole`/`AGENDA_STAFF_ROLES` only; keep the rest of the file)
- Delete: `src/lib/validation/travel-ops.ts`
- Delete: `src/lib/validation/participant-care.ts`
- Delete: `src/lib/validation/participants-communications.ts`
- Delete: `src/lib/validation/program-attendance.ts`
- Test: search `tests/validation/` for each of the 6 role-check functions and update/delete accordingly

**Context:** `travel-ops.ts`, `participant-care.ts`, `participants-communications.ts`, and `program-attendance.ts` contain nothing but their role-check export — they are deleted outright. `admission-review.ts` and `agenda.ts` also contain unrelated logic (status transition schemas, session status logic) that must stay.

- [ ] **Step 1: Locate all existing tests for these 6 functions**

```bash
grep -rl "isAdmissionStaffRole\|isAgendaStaffRole\|isTravelOpsStaffRole\|isParticipantCareStaffRole\|isParticipantsCommunicationsStaffRole\|isProgramAttendanceStaffRole" tests/
```

Read each result. Tests that exist ONLY to test one of these 6 functions in isolation should be deleted (the behavior now lives in Task 4's `tests/auth/is-staff-role.test.ts`). Tests that cover OTHER logic in the same file (e.g. `admission-review.test.ts` likely also tests `VALID_TRANSITIONS`/`statusTransitionSchema`) should have only the role-check-specific test cases removed, keeping the rest intact.

- [ ] **Step 2: Remove the role check from `admission-review.ts`**

Delete these lines from `src/lib/validation/admission-review.ts`:
```typescript
export const ADMISSION_STAFF_ROLES = ['registration_admission_manager', 'super_admin'] as const;
export function isAdmissionStaffRole(role: string | null | undefined): boolean {
  return role != null && (ADMISSION_STAFF_ROLES as readonly string[]).includes(role);
}
```
and the doc comment paragraph directly above it explaining its purpose (lines 35-39 in the version read during planning — verify against current file state, since Tasks 1-6 don't touch this file and line numbers should still match, but confirm before deleting).

- [ ] **Step 3: Remove the role check from `agenda.ts`**

Delete these lines from `src/lib/validation/agenda.ts`:
```typescript
export const AGENDA_STAFF_ROLES = ['agenda_allocation_manager', 'super_admin'] as const;
export function isAgendaStaffRole(role: string | null | undefined): boolean {
  return role != null && (AGENDA_STAFF_ROLES as readonly string[]).includes(role);
}
```
and its doc comment.

- [ ] **Step 4: Delete the 4 single-purpose files**

```bash
git rm src/lib/validation/travel-ops.ts src/lib/validation/participant-care.ts src/lib/validation/participants-communications.ts src/lib/validation/program-attendance.ts
```

- [ ] **Step 5: Update/delete tests per Step 1's findings**

- [ ] **Step 6: Run the validation test suite**

Run: `npx vitest run tests/validation`
Expected: FAIL at this point — every file importing the now-deleted functions (handled in Task 8) will show as a compile/import error. This is expected; do not try to fix downstream call sites in this task. Confirm the failures are all `Cannot find module` or `X is not exported` errors pointing at the 6 removed functions, not some unrelated regression.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove 6 domain-specific staff role checks (superseded by isStaffRole); delete 4 now-empty files"
```

(Deliberately committing a temporarily-broken build state here — Task 8 fixes every call site next. Two atomic commits is clearer history than one giant mixed commit, and this plan's execution model runs Task 8 immediately after.)

---

## Task 8: TypeScript — update every call site to import the shared `isStaffRole`

**Files:** All files returned by the searches below (do not use a fixed list — re-derive it, since it must exactly match Task 7's deletions)

**Context:** This is the largest mechanical task. Every file that imported one of the 6 deleted functions needs its import and call sites updated to `isStaffRole` from `src/lib/auth/is-staff-role.ts` (Task 4). Files that combined multiple domain checks with `||` (e.g. `isAgendaStaffRole(role) || isProgramAttendanceStaffRole(role)`) collapse to a single `isStaffRole(role)` call, since both sides of the `||` are now the same check.

- [ ] **Step 1: Get the definitive list of affected files**

```bash
grep -rl "isAdmissionStaffRole\|isAgendaStaffRole\|isTravelOpsStaffRole\|isParticipantCareStaffRole\|isParticipantsCommunicationsStaffRole\|isProgramAttendanceStaffRole\|ADMISSION_STAFF_ROLES\|AGENDA_STAFF_ROLES\|TRAVEL_OPS_STAFF_ROLES\|PARTICIPANT_CARE_STAFF_ROLES\|PARTICIPANTS_COMMUNICATIONS_STAFF_ROLES\|PROGRAM_ATTENDANCE_STAFF_ROLES" src/
```

This will include the two files already edited in Task 7 in a way that leaves no matches (they should NOT appear if Task 7 was done correctly — if they do appear, Task 7 left something behind; fix that first) and `src/lib/validation/funding-type.ts` (handled separately in Task 9 — skip it in this task).

- [ ] **Step 2: For each file, apply the transformation**

For every file in Step 1's list except `funding-type.ts`:
1. Remove imports of the deleted functions/constants (e.g. `import { isAgendaStaffRole } from '@/lib/validation/agenda';`)
2. Add `import { isStaffRole } from '@/lib/auth/is-staff-role';` (if not already imported)
3. Replace every call site:
   - A single call like `isAdmissionStaffRole(role)` becomes `isStaffRole(role)`
   - A combined call like `isAgendaStaffRole(role) || isProgramAttendanceStaffRole(role)` becomes `isStaffRole(role)` (collapse the redundant `||` — both operands are now identical)
   - A negated call like `!isTravelOpsStaffRole(role)` becomes `!isStaffRole(role)`
4. If a file only used one of the deleted functions and now only needs `isStaffRole` in its place, make sure no now-unused import remains

Work through the file list from Step 1 systematically — group by directory for context (e.g. all `src/app/[locale]/(admin)/agenda/**` pages together) but touch every single one; this task is not done until Step 1's grep returns only `funding-type.ts`.

- [ ] **Step 3: Pay special attention to `src/lib/nav/admin-nav-visibility.ts`**

This file's `isHrefVisible` function currently branches per-href to different domain checks (see the file's own doc comment explaining the href → required-check mapping). After consolidation, EVERY branch collapses to the same `isStaffRole(role)` check, which means the entire per-href branching structure becomes dead logic — there is no longer any href-specific visibility difference between staff accounts.

Do not just mechanically swap each branch's function call and leave the branching structure in place (that would be technically correct but leaves ~70 lines of now-pointless dead code and a doc comment that actively lies about per-role visibility differences that no longer exist). Instead, simplify `isHrefVisible` to:

```typescript
function isHrefVisible(role: string | null | undefined): boolean {
  return isStaffRole(role);
}
```

and update `filterAdminNavGroups` accordingly (it no longer needs to filter per-item by href, since visibility no longer varies by href — every item is visible to any staff account, or none are, uniformly). Rewrite the file's top doc comment to state plainly that after the 2026-09-29 staff role consolidation, all staff-domain distinctions were removed and every admin nav item is visible to any `staff`/`super_admin` account; link to the design spec for the historical per-role mapping this replaces.

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors referencing any of the 6 deleted functions/constants. Any remaining error means a call site was missed — go back to Step 2 for that file.

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS (aside from any test file still pending changes in Task 9's scope — `funding-type.ts`'s own tests, if any, may still fail at this point; that's expected and fixed in Task 9)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: update all call sites to use shared isStaffRole; simplify admin-nav-visibility to a single staff check"
```

---

## Task 9: TypeScript — collapse `funding-type.ts`'s composite functions

**Files:**
- Modify: `src/lib/validation/funding-type.ts`
- Test: search `tests/` for `funding-type`, `isFundingTypeStaffRole`, `canReadAttendanceConfirmation`

**Context:** `isFundingTypeStaffRole` and `canReadAttendanceConfirmation` compose 3 of the now-deleted domain functions. Once those are gone, both collapse to `isStaffRole` — this is an intentional behavior change: `participant_care_staff`'s previously read-only reach into `attendance_confirmation` becomes read/write, consistent with the rest of this consolidation's tradeoff (all 7 old roles now have identical, union permissions).

- [ ] **Step 1: Locate existing tests**

```bash
grep -rl "isFundingTypeStaffRole\|canReadAttendanceConfirmation" tests/
```

Read the results — note any test asserting the OLD distinction (e.g. a test proving `participant_care_staff` passes `canReadAttendanceConfirmation` but fails `isFundingTypeStaffRole`). These specific assertions are now testing behavior that no longer exists and must be removed or rewritten to assert the new collapsed behavior.

- [ ] **Step 2: Update the implementation**

Replace the contents of `src/lib/validation/funding-type.ts`'s two functions:

```typescript
import { isStaffRole } from '@/lib/auth/is-staff-role';

export const FUNDING_TYPE_VALUES = ['self_funded', 'partially_funded', 'fully_funded'] as const;
export type FundingType = (typeof FUNDING_TYPE_VALUES)[number];

export const ATTENDANCE_CONFIRMATION_VALUES = ['confirmed', 'not_confirmed', 'declined'] as const;
export type AttendanceConfirmation = (typeof ATTENDANCE_CONFIRMATION_VALUES)[number];

// Editable: funding_type AND attendance_confirmation.
//
// PRE-2026-09-29 this was narrower (isProgramAttendanceStaffRole OR
// isTravelOpsStaffRole) and canReadAttendanceConfirmation additionally
// granted participant_care_staff READ-ONLY access to
// attendance_confirmation only. Both distinctions collapsed to a single
// isStaffRole check as part of the staff role consolidation (see
// docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md)
// — every account that could reach any of those 3 domains before can
// now read AND write both fields, since all 7 old domain roles are the
// same 'staff' role today. Kept as two named functions (rather than
// deleting one) so call sites' intent stays self-documenting even
// though they're now equivalent.
export function isFundingTypeStaffRole(role: string | null | undefined): boolean {
  return isStaffRole(role);
}

export function canReadAttendanceConfirmation(role: string | null | undefined): boolean {
  return isStaffRole(role);
}
```

- [ ] **Step 3: Update tests per Step 1's findings**

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/validation`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/funding-type.ts
git commit -m "refactor: collapse funding-type.ts's composite role checks now that all staff domains are unified"
```

---

## Task 10: UI — simplify `staff-manager.tsx`'s role dropdown

**Files:**
- Modify: `src/app/[locale]/(admin)/staff/staff-manager.tsx`
- Test: search `tests/` for `staff-manager` and update accordingly

- [ ] **Step 1: Locate existing tests**

```bash
grep -rl "staff-manager\|StaffManager" tests/
```

- [ ] **Step 2: Update the role list**

In `src/app/[locale]/(admin)/staff/staff-manager.tsx`, replace:

```typescript
const STAFF_ROLES = [
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'registration_admission_manager', label: 'Registration & Admission' },
  { value: 'agenda_allocation_manager', label: 'Agenda & Allocation' },
  { value: 'communications_attendance_manager', label: 'Communications & Attendance' },
  { value: 'travel_operations_staff', label: 'Travel Operations' },
  { value: 'participant_care_staff', label: 'Participant Care' },
  { value: 'participants_communications_manager', label: 'Participants Communications' },
  { value: 'program_attendance_manager', label: 'Program Attendance' },
] as const;
```

with:

```typescript
const STAFF_ROLES = [
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'staff', label: 'Staff' },
] as const;
```

Update `EMPTY_FORM`'s default role from `'registration_admission_manager'` to `'staff'`:

```typescript
const EMPTY_FORM = { fullName: '', email: '', role: 'staff' as string, password: '' };
```

No other changes needed in this file — `ROLE_LABELS` is already derived from `STAFF_ROLES` via `Object.fromEntries`, so it shrinks automatically.

- [ ] **Step 3: Update tests per Step 1's findings**

- [ ] **Step 4: Run the component test**

Run: `npx vitest run tests/components` (or the specific path found in Step 1)
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/[locale]/\(admin\)/staff/staff-manager.tsx
git commit -m "refactor: simplify staff-manager role dropdown to super_admin/staff"
```

---

## Task 11: Translations — shrink `shell.roles.*` to 4 keys

**Files:**
- Modify: `src/messages/en.json`
- Modify: `src/messages/ar.json`

**Note:** `ar.json` has a pre-existing, file-wide UTF-8 mojibake corruption (documented in prior work on this repo) that is out of scope to fix here. Write the new/kept Arabic keys with CORRECT encoding — do not propagate or introduce new corruption, but do not attempt to fix the rest of the file either.

- [ ] **Step 1: Locate the `shell.roles` section in both files**

```bash
grep -n '"roles"' src/messages/en.json src/messages/ar.json
```

- [ ] **Step 2: Update `en.json`**

Replace the `roles` object's 10 keys with 4:

```json
"roles": {
  "participant": "Participant",
  "super_admin": "Super Admin",
  "staff": "Staff",
  "scanner_device": "Scanner Device"
}
```

(Use whatever exact label text the existing `super_admin`/`participant`/`scanner_device` entries already have — only remove the 7 deprecated keys and add `staff`; don't invent new wording for the 3 unchanged roles.)

- [ ] **Step 3: Update `ar.json`**

Same 4-key shrink, using the existing Arabic wording for the 3 unchanged roles from the current file, and a correctly-encoded Arabic label for the new `staff` key (e.g. `"موظف"` — verify this reads correctly by opening the file after editing, per this repo's established mojibake-avoidance practice).

- [ ] **Step 4: Verify both files still parse as valid JSON**

```bash
node -e "require('./src/messages/en.json'); console.log('en.json OK')"
node -e "require('./src/messages/ar.json'); console.log('ar.json OK')"
```

(Use `require`, not `JSON.parse(readFileSync(...))` — `ar.json` has a UTF-8 BOM that breaks raw `JSON.parse`; Node's module loader handles it correctly. This is an established workaround from prior work on this repo.)

Expected: both print `OK` with no exception.

- [ ] **Step 5: Search for any other reference to a deprecated role key**

```bash
grep -rn "registration_admission_manager\|agenda_allocation_manager\|communications_attendance_manager\|travel_operations_staff\|participant_care_staff\|participants_communications_manager\|program_attendance_manager" src/messages/
```

Expected: zero matches.

- [ ] **Step 6: Commit**

```bash
git add src/messages/en.json src/messages/ar.json
git commit -m "refactor: shrink shell.roles translations to the 4 consolidated roles"
```

---

## Task 12: Final verification sweep

**Files:** none created/modified — this task is pure verification

- [ ] **Step 1: Confirm zero remaining TypeScript references to the 7 deprecated roles**

```bash
grep -rn "registration_admission_manager\|agenda_allocation_manager\|communications_attendance_manager\|travel_operations_staff\|participant_care_staff\|participants_communications_manager\|program_attendance_manager" src/
```

Expected: zero matches. (Historical migration files under `supabase/migrations/` are expected to still contain these strings — that's correct, history isn't rewritten.)

- [ ] **Step 2: Full typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Full test suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 4: Diff every test failure against the pre-plan base commit**

Compare current test results against a clean run on the commit this feature branch was created from (`git log --oneline` to find it, then `git stash && git checkout <base-sha> && npx vitest run && git checkout - && git stash pop` if needed, or simpler: note that this branch started from a clean, all-green `master`). Any failure that exists on both the base and this branch is pre-existing and out of scope; any new failure must be fixed before this task is considered done. This mirrors the verification technique used for the earlier participant-portal UX work on this repo.

- [ ] **Step 5: Live RLS verification against a disposable Supabase project**

This is the layer no unit test can cover (RLS runs inside Postgres, not in the TypeScript test runner). Using the same technique as the earlier TOCTOU scanner fix on this repo (a scratch/disposable Supabase project, never production):

1. Apply all migrations from Tasks 1-3 to the scratch project.
2. Create one test profile with `role = 'staff'`.
3. As that profile, attempt a representative read/write from each of the 7 old domains that is now supposed to be accessible (e.g. select from `applications`, select from `application_travel_info`, select from `application_health_info`, an agenda/session table, a communications-related table) — confirm all succeed.
4. As a `participant`-role profile, attempt the same reads — confirm all are still denied (RLS should reject exactly as it did before this consolidation for non-staff callers).
5. Delete the scratch project (or its test data) when done, per this repo's established scratch-project hygiene from the earlier TOCTOU work.

- [ ] **Step 6: Report completion**

Summarize: files touched, tests added/removed, confirmation that the 4-role model (`participant`, `super_admin`, `staff`, `scanner_device`) is now the only assignable set, and that the RLS-level verification in Step 5 passed. Flag any deviation from this plan that was necessary during execution.
