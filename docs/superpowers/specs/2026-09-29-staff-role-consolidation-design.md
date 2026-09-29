# Staff Role Consolidation — Design Spec

Date: 2026-09-29

## Problem

COY21-App currently has 10 values in the `user_role` Postgres enum:

- `participant`
- `super_admin`
- `scanner_device`
- Seven staff-domain roles: `registration_admission_manager`, `agenda_allocation_manager`, `communications_attendance_manager`, `travel_operations_staff`, `participant_care_staff`, `participants_communications_manager`, `program_attendance_manager`

Each of the seven staff-domain roles was introduced to give a narrow slice of permissions to a specific team function (admission review, agenda/allocation, communications/attendance, travel ops, participant care, participants communications, program attendance). In practice, the organization does not need this level of separation — a single person often needs to act across more than one of these domains, and managing seven separate role assignments has become friction without a matching benefit.

## Goal

Reduce the role model to exactly 4 roles:

- `participant` — **unchanged**
- `super_admin` — **unchanged**
- `staff` — **new**, holds the union of all permissions currently split across the 7 staff-domain roles
- `scanner_device` — **unchanged**

This is an explicit, user-confirmed security tradeoff: a single `staff` account will be able to see and edit everything the 7 separate roles could previously do individually. The separation-of-duties boundary between admission review, travel ops, participant care, etc. is intentionally removed.

## Why RLS-level, not just code-level

Every RLS policy and several `SECURITY DEFINER` RPC functions in this codebase check the caller's role directly against literal enum values (typically via the existing `current_user_role()` SQL helper, e.g. `current_user_role() in ('registration_admission_manager', 'super_admin')`). Consolidating only at the TypeScript layer while leaving these Postgres-side checks untouched would break database access for anyone migrated to a `staff` value that no policy recognizes. The `user_role` enum value and the RLS policies that reference it must change together.

## Scope of impact (confirmed via codebase scan)

- 51 files under `src/` reference at least one of the 7 target roles
- 36 migration files under `supabase/migrations/` reference at least one of the 7 target roles; of those, 30 files contain actual `create policy` / `create function` definitions that need updating (the rest are incidental references, e.g. comments or unrelated column changes)
- 6 `is<X>StaffRole()` function + `<X>_STAFF_ROLES` constant pairs, one per domain (admission-review, agenda, travel-ops, participant-care, participants-communications, program-attendance) — **not 7**: `communications_attendance_manager` has no dedicated validation file of its own; it only appears in `role-label.ts`, `admin-access.ts`, and `admin-dashboard-queries.ts` and is folded into consolidation there directly.
- One `staff-manager.tsx` admin UI screen with an 8-entry role dropdown (`super_admin` + the 7 domain roles)
- One naming collision to resolve (see §3a)
- One composite-permission file to update (see §3b)
- Inline plpgsql role checks inside `SECURITY DEFINER` RPC functions that are not expressed as `create policy` statements and so are not covered by the RLS policy consolidation in §2 (see §2a)

## Design

### 1. Database: enum + data migration

New migration, additive only (no `rename value`, no in-place literal changes):

```sql
alter type user_role add value 'staff';
```

Followed by a data migration (in the same or a subsequent migration file) moving every existing profile off the 7 old roles:

```sql
update profiles set role = 'staff'
where role in (
  'registration_admission_manager', 'agenda_allocation_manager',
  'communications_attendance_manager', 'travel_operations_staff',
  'participant_care_staff', 'participants_communications_manager',
  'program_attendance_manager'
);
```

The 7 old enum values remain physically present in `user_role` (Postgres does not support dropping enum values in place), but are marked deprecated via a SQL comment and are never assigned again after this migration. This is the standard safe pattern for evolving a Postgres enum without a full type-recreation migration.

### 2. RLS policies: consolidate via a shared `is_staff()` helper

A new `SECURITY DEFINER` SQL helper, following the existing `current_user_role()` pattern:

```sql
create function is_staff() returns boolean as $$
  select current_user_role() in ('staff', 'super_admin');
$$ language sql stable security definer set search_path = public;
```

A new migration updates every policy currently matching the pattern `current_user_role() in ('<old-role>', ..., 'super_admin')` or `current_user_role() = '<old-role>'` (across the 30 files identified) to instead read `using (is_staff())` / `with check (is_staff())`. This is done via `drop policy` + `create policy` (Postgres has no `alter policy ... using`) issued from the new migration, not by editing historical migration files. Any `SECURITY DEFINER` RPC function that inlines the same role check internally (e.g. in the allocation or scanner subsystems) is updated the same way.

**Confirmed security implication**: policies that previously distinguished between domains (e.g. an admission-review policy visible only to `registration_admission_manager`, a travel policy visible only to `travel_operations_staff`) now all resolve through the same `is_staff()` check. Any `staff` account can access all of it. This is the tradeoff the user explicitly approved.

### 2a. Inline plpgsql role checks (not expressed as RLS policies)

Some `SECURITY DEFINER` RPC functions check the caller's role via an inline plpgsql `if` statement against a fetched column value, rather than through a `create policy using (...)` clause — these are NOT touched by the drop/recreate policy migration in §2 and need their own pass. Confirmed instances:

- `supabase/migrations/20260805235959_phase6_qr_issuance_reissue.sql` — 14+ occurrences of the pattern `if v_caller_role not in ('super_admin', 'program_attendance_manager') then ...` (or similar per-domain variants) at multiple call sites within the file.
- `supabase/migrations/20260811210000_fix_staff_blocker_resolver_channel_check.sql` — same pattern.

Because plpgsql can call SQL functions directly, these are updated to call `is_staff()` instead of re-deriving the caller's role and comparing against a literal list, e.g.:

```plpgsql
if not is_staff() then
  raise exception '...';
end if;
```

replacing the old `if v_caller_role not in (...) then`. A new migration (or the same one from §2) must locate and rewrite every such inline check — this requires an explicit line-by-line pass over the two files above (and a final `grep` across all migrations for any other `not in ('super_admin', '<role>')`-shaped literal check before considering this step complete), not just the `create policy` search from §2.

### 3. Code consolidation in `src/`

New shared module:

```ts
// src/lib/auth/is-staff-role.ts
export const STAFF_ROLES = ['staff', 'super_admin'] as const;
export function isStaffRole(role: string | null | undefined): boolean {
  return role != null && (STAFF_ROLES as readonly string[]).includes(role);
}
```

The 6 existing `is<X>StaffRole()` functions and their backing `<X>_STAFF_ROLES` constants (in `admission-review.ts`, `travel-ops.ts`, `participants-communications.ts`, `participant-care.ts`, `program-attendance.ts`, `agenda.ts`) are deleted outright — not kept as deprecated wrappers, since there is no external consumer of this code outside this repo. All call sites (identified across the 51 files) are updated to import `isStaffRole` from the new shared module instead. Any remaining direct references to `communications_attendance_manager` (in `role-label.ts`, `admin-access.ts`, `admin-dashboard-queries.ts`) are updated to use `isStaffRole`/`'staff'` the same way.

`provision-staff-account.ts` requires no structural change — it already takes `role` as a generic string parameter; only the values passed to it change (call sites that used to pass one of the 7 roles now pass `'staff'`).

### 3a. Naming collision: `src/lib/auth/post-login-destination.ts`

This file already exports `STAFF_ROLES` and `isStaffRole` — but with a different, wider semantic: "any non-participant role," derived from `ROLE_LABEL_KEYS`, which currently includes `scanner_device`. This is a genuine name collision with the new shared module proposed in §3, which means something narrower ("staff or super_admin", excluding `scanner_device`).

Resolution: the new shared check from §3 is named `isStaffRole` and lives in `src/lib/auth/is-staff-role.ts` as planned. The existing, wider check in `post-login-destination.ts` is renamed to `isNonParticipantRole`/`NON_PARTICIPANT_ROLES` (or similar) to reflect what it actually tests, and its call sites (`admin-access.ts`, its own tests) are updated to the new name. Both checks are needed and are semantically distinct — one collapses onto the other only by coincidence of the old 10-role model; the rename resolves the collision honestly instead of merging two different concepts.

### 3b. Composite permission file: `src/lib/validation/funding-type.ts`

This file defines two functions composed from calls to multiple domain-specific `is<X>StaffRole` functions:

- `isFundingTypeStaffRole(role)` = `isProgramAttendanceStaffRole(role) || isTravelOpsStaffRole(role)`
- `canReadAttendanceConfirmation(role)` = `isFundingTypeStaffRole(role) || isParticipantCareStaffRole(role)`

Once the 3 domain functions it depends on are deleted per §3, both composite functions collapse to the same check — `isStaffRole(role)` — since every one of their constituent domains is now folded into the single `staff` role. Both functions are updated to call `isStaffRole` directly; the file's existing comments explaining the historical read/write distinction are updated to note that the distinction no longer exists post-consolidation (this is a real, intentional behavior change: `participant_care_staff`'s previously read-only reach into `attendance_confirmation` becomes read/write, consistent with the rest of this consolidation's tradeoff).

### 4. `staff-manager.tsx` admin UI

The role dropdown shrinks from 7 domain-specific entries to 2: `super_admin` and `staff` (per explicit user preference — the ability to create a new `super_admin` account from this same screen is kept, not removed). `ROLE_LABELS` and `STAFF_ROLES` in this component shrink to match.

### 5. Translations

`shell.roles.*` in `en.json` / `ar.json` shrinks from 10 keys to 4, matching the new role set. (Pre-existing mojibake corruption in `ar.json` is out of scope, as in prior work — new/touched keys are written with correct encoding.)

### 6. Testing

- All existing per-domain authorization tests referencing one of the 7 old roles are updated to use `staff`.
- A new test asserts that a single `staff`-role profile satisfies every one of the 7 domains' authorization checks — this documents the intended security tradeoff explicitly in the test suite rather than leaving it implicit.
- A live verification pass against a disposable Supabase project (same technique used for the earlier TOCTOU fix) confirms the actual RLS policies — not just the TypeScript layer — permit `staff` access as expected. This is the layer most likely to hide a bug, since RLS behavior cannot be fully verified by unit tests against a mocked client.

### Out of scope

- `participant`, `super_admin`, `scanner_device` roles: unchanged.
- Any UI/UX changes beyond the `staff-manager.tsx` role dropdown.
- Removing the 7 deprecated enum values from `user_role` (not feasible without a full type-recreation migration; not needed for this goal).
- Fixing the pre-existing `ar.json` mojibake corruption.
