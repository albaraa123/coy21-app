# Admin Agenda Management (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/admin/agenda` module — conference days, tracks, session types, rooms, people, tags, sessions, session-people assignments, and session tags — with full database-enforced integrity (conflict prevention, status transitions, capacity validation) and a complete admin UI, for `super_admin`/`agenda_allocation_manager` staff only.

**Architecture:** Next.js 16 App Router + Supabase Postgres, following the exact `(admin)` route-group pattern and server-action conventions established in Phase 2 (`requireStaffCaller`-style role gate, service-role client for writes, RLS as defense-in-depth, Zod validation mirrored by DB constraints/triggers). Nine new tables plus a generic `audit_logs` table. Reference-entity modules (days/tracks/session-types/rooms/people/tags) share one CRUD shape; `sessions` is the complex core with cross-cutting triggers for day-matching, capacity, status transitions, and room/speaker conflict prevention.

**Tech Stack:** Supabase (Postgres, RLS, `btree_gist` extension), TypeScript, Zod, Vitest (live-database behavioral tests, same pattern as Phase 1/2), Next.js Server Actions.

**Design spec:** `docs/superpowers/specs/2026-07-22-admin-agenda-management-design.md` — read this first; this plan implements it exactly. Every migration below traces back to a section of that spec.

---

## Plan-Wide Conventions

**Verification checkpoint (run after every task, not just at the end):**
```bash
npx tsc --noEmit
npm run lint
npm run test
```
Full production build (`npm run build`) runs after each major group (see Group boundaries below), not after every single task, to avoid excessive build time during iteration — but must run and pass before a group is considered done.

**Migration rollback/failure behavior:** every migration task below states its rollback plan explicitly. Since Supabase's hosted project has no automatic down-migration tooling in this project (confirmed: Phase 1/2 never used `supabase migration down` or paired down-files — only forward `up` migrations exist in `supabase/migrations/`), "rollback" here means: (a) what a hand-written reverse migration would need to do if this migration must be undone after it's already applied to the live hosted project, and (b) what happens if the migration itself fails partway through applying (Postgres DDL in a single migration file runs in an implicit transaction on Supabase's migration runner, so a failure mid-file rolls back that whole file automatically — this is stated per-task so an implementer isn't left guessing).

**Commit granularity:** one commit per checkbox-level step group (each numbered `Step N` below is usually one commit; some trivial steps are combined with their adjacent step into one commit where separating them would leave the tree in a broken intermediate state — noted explicitly where that happens). Commit messages are given verbatim in each step.

**Role-check helper naming:** Phase 2 established `isAdmissionStaffRole`/`ADMISSION_STAFF_ROLES` in `src/lib/validation/admission-review.ts`. This phase's role set is different (`super_admin`, `agenda_allocation_manager`), so Task 3 creates an analogous, separate `isAgendaStaffRole`/`AGENDA_STAFF_ROLES` in a new `src/lib/validation/agenda.ts` — not a shared cross-phase helper, since the two role lists are semantically distinct (one governs admission review, the other agenda management) and Phase 2's spec review explicitly reasoned about keeping each phase's staff-role check independently named and owned.

---

## Group A: Schema Foundation (Tasks 1–4)

Reference-entity tables, enums, the audit log, and Supabase type regeneration. No triggers yet — those depend on `sessions` existing (Group B).

### Task 1: Migration — Enums, `audit_logs`, and Reference-Entity Tables

**Files:**
- Create: `supabase/migrations/<timestamp>_agenda_enums_and_reference_tables.sql`

- [ ] **Step 1: Write the migration**

```sql
-- agenda_enums_and_reference_tables.sql
create type session_status as enum ('draft', 'published', 'confirmed', 'cancelled', 'completed');
create type session_person_role as enum ('speaker', 'guest', 'moderator', 'facilitator', 'trainer', 'session_lead');
create type session_language as enum ('ar', 'en', 'bilingual');
create type session_difficulty as enum ('beginner', 'intermediate', 'advanced', 'all_levels');
create type audit_actor_type as enum ('admin', 'system');

create table conference_days (
  id uuid primary key default gen_random_uuid(),
  conference_date date not null unique,
  label_ar text not null,
  label_en text not null,
  display_order int not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id)
);

create table tracks (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  name_en text not null,
  color text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id)
);

create table session_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  name_en text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id)
);

create table rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  name_en text not null,
  capacity int not null,
  location text,
  floor text,
  is_accessible boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),
  constraint rooms_capacity_positive check (capacity > 0)
);

create table people (
  id uuid primary key default gen_random_uuid(),
  full_name_ar text not null,
  full_name_en text not null,
  title_ar text,
  title_en text,
  organization_ar text,
  organization_en text,
  bio_ar text,
  bio_en text,
  photo_path text,
  email text,
  phone text,
  linked_profile_id uuid unique references profiles(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id)
);

create table tags (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_ar text not null,
  name_en text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id)
);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  actor_type audit_actor_type not null default 'admin',
  actor_id uuid references profiles(id),
  request_id uuid,
  metadata jsonb,
  old_values jsonb,
  new_values jsonb,
  created_at timestamptz not null default now()
);

-- updated_at auto-touch, matching applications' established moddatetime pattern.
-- moddatetime cannot populate updated_by (no app-level actor context) — every
-- server action sets updated_by explicitly, same rule as audit_logs.actor_id.
create trigger conference_days_set_updated_at before update on conference_days for each row execute function extensions.moddatetime('updated_at');
create trigger tracks_set_updated_at before update on tracks for each row execute function extensions.moddatetime('updated_at');
create trigger session_types_set_updated_at before update on session_types for each row execute function extensions.moddatetime('updated_at');
create trigger rooms_set_updated_at before update on rooms for each row execute function extensions.moddatetime('updated_at');
create trigger people_set_updated_at before update on people for each row execute function extensions.moddatetime('updated_at');
create trigger tags_set_updated_at before update on tags for each row execute function extensions.moddatetime('updated_at');

create index tracks_code_idx on tracks (code);
create index session_types_code_idx on session_types (code);
create index rooms_code_idx on rooms (code);
create index tags_code_idx on tags (code);
create index people_linked_profile_idx on people (linked_profile_id);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id, created_at desc);
create index audit_logs_actor_idx on audit_logs (actor_id);
```

**Note on `moddatetime` extension:** already enabled by Phase 1's `applications_table.sql` (`create extension if not exists moddatetime schema extensions;`) — do not re-create it here, it's idempotent but redundant; confirm it's already active via `select * from pg_extension where extname = 'moddatetime';` before assuming, and only add the `create extension if not exists` line here if that query comes back empty (defensive — it shouldn't be empty given Phase 1 already ran, but verify rather than assume).

- [ ] **Step 2: Apply the migration to the hosted project and verify**

Apply via the Supabase CLI/MCP tooling already configured for this project (same mechanism used in Phase 1/2 — check `supabase/config.toml` or prior task commits for the exact apply command used, e.g. `npx supabase db push` or an MCP migration-apply call). Verify via direct query:
```sql
select table_name from information_schema.tables where table_schema = 'public' and table_name in ('conference_days','tracks','session_types','rooms','people','tags','audit_logs');
```
Expected: all 7 tables present. Also verify the 5 enums exist (`select typname from pg_type where typname in ('session_status','session_person_role','session_language','session_difficulty','audit_actor_type');`) and that `people.linked_profile_id` has a unique constraint (`select conname from pg_constraint where conrelid = 'people'::regclass and contype = 'u';`).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/<timestamp>_agenda_enums_and_reference_tables.sql
git commit -m "feat(db): add agenda enums, audit_logs, and reference entity tables"
```

**Rollback/failure behavior:** This migration is pure `create type`/`create table`/`create trigger`/`create index` — no data migration, no altering of existing tables. If it fails partway (e.g., a typo in a later table), Supabase's migration runner rolls back the entire file transactionally — no partial state persists on the live project. To hand-reverse this migration after it has been successfully applied (only needed if a later task discovers a fundamental problem requiring a redesign): `drop table if exists audit_logs, tags, people, rooms, session_types, tracks, conference_days cascade; drop type if exists audit_actor_type, session_difficulty, session_language, session_person_role, session_status;` — safe to run only if no later migration has added foreign keys into these tables from outside this file (Task 2 onward does add such FKs, so this reverse command would need to run before those, or use `cascade`, which is why `cascade` is included above).

---

### Task 2: RLS Policies for Reference-Entity Tables and `audit_logs`

**Files:**
- Create: `supabase/migrations/<timestamp>_agenda_reference_rls_policies.sql`

- [ ] **Step 1: Write the migration**

```sql
-- agenda_reference_rls_policies.sql
alter table conference_days enable row level security;
alter table tracks enable row level security;
alter table session_types enable row level security;
alter table rooms enable row level security;
alter table people enable row level security;
alter table tags enable row level security;
alter table audit_logs enable row level security;

-- Staff-only select/insert/update on every reference table. No delete policy
-- anywhere (deactivation via is_active, never a real DELETE — see spec's
-- "Deactivation of referenced entities" section). Defense-in-depth only: the
-- operative gate for writes is each server action's own role check via the
-- service-role client, which bypasses RLS entirely (see design spec, Access
-- Control section).
create policy conference_days_staff_all on conference_days
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

create policy tracks_staff_all on tracks
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

create policy session_types_staff_all on session_types
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

create policy rooms_staff_all on rooms
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

create policy people_staff_all on people
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

create policy tags_staff_all on tags
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

-- audit_logs: staff-only select. No insert/update/delete policy for any
-- client role — default-deny, matching application_status_history/email_log
-- in Phase 1. Only the service-role client (bypasses RLS) writes, and only
-- from within a server action that has already independently verified the
-- caller (see design spec, Access Control).
create policy audit_logs_select_staff on audit_logs
  for select using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
```

**Note on `for all`:** unlike Phase 2's applications table (which needed narrower per-action policies because applicants also have their own select/insert/update/delete policies on the same table), these reference tables have exactly one class of legitimate client access — agenda staff — so a single `for all` policy per table is the correct, simplest expression, not a shortcut. `for all` covers select/insert/update/delete; since no delete ever happens from a client (service-role bypasses RLS for the writes server actions actually perform, and no server action issues a DELETE per the soft-delete design), this doesn't open any unintended surface — it only matters for what an RLS-respecting client (used for reads on admin pages, per Phase 2's page-read pattern) can do, which is read-only in practice since pages don't call client-side mutations directly.

- [ ] **Step 2: Apply and verify**

```sql
select tablename, policyname, cmd from pg_policies where tablename in ('conference_days','tracks','session_types','rooms','people','tags','audit_logs') order by tablename;
```
Expected: exactly one policy per table, `cmd = 'ALL'` for the six reference tables, `cmd = 'SELECT'` for `audit_logs`. Also confirm `relrowsecurity = true` for all 7 tables via `pg_class`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/<timestamp>_agenda_reference_rls_policies.sql
git commit -m "feat(db): add RLS policies for agenda reference tables and audit_logs"
```

**Rollback/failure behavior:** Pure policy creation, transactional per-file like Task 1. Hand-reverse: `drop policy` for each of the 7 policies, then `alter table ... disable row level security` for each of the 7 tables (only if fully reverting; in practice a mistake here would more likely be fixed by an additive follow-up migration adjusting a policy, not a full revert).

---

### Task 3: Validation Schemas and Role-Check Helper

**Files:**
- Create: `src/lib/validation/agenda.ts`
- Test: `tests/validation/agenda.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/validation/agenda.test.ts
import { describe, it, expect } from 'vitest';
import {
  AGENDA_STAFF_ROLES, isAgendaStaffRole,
  sessionStatusTransitionSchema, SESSION_VALID_TRANSITIONS,
  weightSchema, checkinWindowSchema,
} from '@/lib/validation/agenda';

describe('isAgendaStaffRole', () => {
  it('accepts agenda_allocation_manager', () => {
    expect(isAgendaStaffRole('agenda_allocation_manager')).toBe(true);
  });
  it('accepts super_admin', () => {
    expect(isAgendaStaffRole('super_admin')).toBe(true);
  });
  it('rejects registration_admission_manager (staff, but not agenda staff)', () => {
    expect(isAgendaStaffRole('registration_admission_manager')).toBe(false);
  });
  it('rejects participant', () => {
    expect(isAgendaStaffRole('participant')).toBe(false);
  });
  it('rejects null/undefined', () => {
    expect(isAgendaStaffRole(null)).toBe(false);
    expect(isAgendaStaffRole(undefined)).toBe(false);
  });
});

describe('SESSION_VALID_TRANSITIONS state machine', () => {
  it('draft can only go to published', () => {
    expect(SESSION_VALID_TRANSITIONS.draft).toEqual(expect.arrayContaining(['published']));
    expect(SESSION_VALID_TRANSITIONS.draft).not.toContain('confirmed');
    expect(SESSION_VALID_TRANSITIONS.draft).not.toContain('completed');
  });
  it('published can go to confirmed or cancelled', () => {
    expect(SESSION_VALID_TRANSITIONS.published).toEqual(expect.arrayContaining(['confirmed', 'cancelled']));
  });
  it('confirmed can go to completed or cancelled', () => {
    expect(SESSION_VALID_TRANSITIONS.confirmed).toEqual(expect.arrayContaining(['completed', 'cancelled']));
  });
  it('cancelled and completed are terminal', () => {
    expect(SESSION_VALID_TRANSITIONS.cancelled).toEqual([]);
    expect(SESSION_VALID_TRANSITIONS.completed).toEqual([]);
  });
  it('draft can also be cancelled directly', () => {
    expect(SESSION_VALID_TRANSITIONS.draft).toContain('cancelled');
  });
});

describe('sessionStatusTransitionSchema', () => {
  it('accepts a valid transition', () => {
    const result = sessionStatusTransitionSchema.safeParse({ from: 'draft', to: 'published' });
    expect(result.success).toBe(true);
  });
  it('rejects an invalid transition', () => {
    const result = sessionStatusTransitionSchema.safeParse({ from: 'draft', to: 'confirmed' });
    expect(result.success).toBe(false);
  });
  it('requires cancellation_reason when transitioning to cancelled', () => {
    const withoutReason = sessionStatusTransitionSchema.safeParse({ from: 'published', to: 'cancelled' });
    expect(withoutReason.success).toBe(false);
    const withReason = sessionStatusTransitionSchema.safeParse({ from: 'published', to: 'cancelled', cancellationReason: 'Speaker withdrew' });
    expect(withReason.success).toBe(true);
  });
});

describe('weightSchema', () => {
  it('accepts 0, 0.5, and 1', () => {
    expect(weightSchema.safeParse(0).success).toBe(true);
    expect(weightSchema.safeParse(0.5).success).toBe(true);
    expect(weightSchema.safeParse(1).success).toBe(true);
  });
  it('rejects negative and >1', () => {
    expect(weightSchema.safeParse(-0.1).success).toBe(false);
    expect(weightSchema.safeParse(1.1).success).toBe(false);
  });
});

describe('checkinWindowSchema', () => {
  it('accepts both null when QR check-in is disabled', () => {
    const result = checkinWindowSchema.safeParse({ enableQrCheckin: false, checkinOpensAt: null, checkinClosesAt: null });
    expect(result.success).toBe(true);
  });
  it('rejects enabled with a missing window', () => {
    const result = checkinWindowSchema.safeParse({ enableQrCheckin: true, checkinOpensAt: null, checkinClosesAt: null });
    expect(result.success).toBe(false);
  });
  it('rejects opens >= closes', () => {
    const now = new Date().toISOString();
    const result = checkinWindowSchema.safeParse({ enableQrCheckin: true, checkinOpensAt: now, checkinClosesAt: now });
    expect(result.success).toBe(false);
  });
  it('accepts a valid enabled window', () => {
    const opens = new Date(Date.now()).toISOString();
    const closes = new Date(Date.now() + 3600_000).toISOString();
    const result = checkinWindowSchema.safeParse({ enableQrCheckin: true, checkinOpensAt: opens, checkinClosesAt: closes });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/validation/agenda.test.ts`
Expected: FAIL — `Cannot find module '@/lib/validation/agenda'`.

- [ ] **Step 3: Implement the schemas**

```typescript
// src/lib/validation/agenda.ts
import { z } from 'zod';

// Single source of truth for "is this profile.role allowed to manage the
// agenda". Separate from Phase 2's isAdmissionStaffRole — different phase,
// different role list, deliberately not shared (see plan-wide conventions).
export const AGENDA_STAFF_ROLES = ['agenda_allocation_manager', 'super_admin'] as const;
export function isAgendaStaffRole(role: string | null | undefined): boolean {
  return role != null && (AGENDA_STAFF_ROLES as readonly string[]).includes(role);
}

export const SESSION_STATUSES = ['draft', 'published', 'confirmed', 'cancelled', 'completed'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

// Linear forward progression with cancel-from-anywhere-except-completed.
// Mirrored exactly in the enforce_session_status_transition DB trigger.
export const SESSION_VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  draft: ['published', 'cancelled'],
  published: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled'],
  cancelled: [],
  completed: [],
};

export const sessionStatusTransitionSchema = z
  .object({
    from: z.enum(SESSION_STATUSES),
    to: z.enum(SESSION_STATUSES),
    cancellationReason: z.string().trim().min(1).optional(),
  })
  .refine((data) => SESSION_VALID_TRANSITIONS[data.from]?.includes(data.to), {
    message: 'This status transition is not permitted',
    path: ['to'],
  })
  .refine((data) => data.to !== 'cancelled' || (data.cancellationReason && data.cancellationReason.length > 0), {
    message: 'A cancellation reason is required when cancelling a session',
    path: ['cancellationReason'],
  });

export const weightSchema = z.number().min(0).max(1);

export const checkinWindowSchema = z
  .object({
    enableQrCheckin: z.boolean(),
    checkinOpensAt: z.string().datetime().nullable(),
    checkinClosesAt: z.string().datetime().nullable(),
  })
  .refine((data) => !data.enableQrCheckin || (data.checkinOpensAt !== null && data.checkinClosesAt !== null), {
    message: 'Check-in window is required when QR check-in is enabled',
    path: ['checkinOpensAt'],
  })
  .refine(
    (data) => data.checkinOpensAt === null || data.checkinClosesAt === null || data.checkinOpensAt < data.checkinClosesAt,
    { message: 'Check-in opens time must be before closes time', path: ['checkinClosesAt'] }
  );

export const SESSION_PERSON_ROLES = ['speaker', 'guest', 'moderator', 'facilitator', 'trainer', 'session_lead'] as const;
export type SessionPersonRole = (typeof SESSION_PERSON_ROLES)[number];

export const SESSION_LANGUAGES = ['ar', 'en', 'bilingual'] as const;
export const SESSION_DIFFICULTIES = ['beginner', 'intermediate', 'advanced', 'all_levels'] as const;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- tests/validation/agenda.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/agenda.ts tests/validation/agenda.test.ts
git commit -m "feat: add agenda validation schemas and staff-role helper"
```

---

### Task 4: Regenerate Supabase Database Types

**Files:**
- Modify: `src/types/database.ts`

- [ ] **Step 1: Regenerate**

```bash
npx supabase gen types typescript --linked > src/types/database.ts
```

- [ ] **Step 2: Verify**

Confirm `conference_days`, `tracks`, `session_types`, `rooms`, `people`, `tags`, `audit_logs` all appear in the `Tables` section with correct nullability matching Task 1's schema (e.g. `people.linked_profile_id: string | null`, `rooms.capacity: number`). Confirm no secrets leaked into the file (`grep -in "service_role\|secret\|sb_secret\|sbp_" src/types/database.ts` returns nothing).

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```
Expected: clean (nothing yet imports the new types, so this just confirms the generated file itself is syntactically valid TypeScript).

- [ ] **Step 4: Commit**

```bash
git add src/types/database.ts
git commit -m "chore(db): regenerate database types for agenda reference tables"
```

---

## Group A Checkpoint

```bash
npx tsc --noEmit
npm run lint
npm run test
npm run build
```
Expected: all pass. This confirms the reference-table foundation (schema + RLS + validation + types) is solid before building the far more complex `sessions` table on top of it.

---

## Group B: Sessions Table, Triggers, and Conflict Enforcement (Tasks 5–8)

This is the core of the phase: the `sessions` table itself, the join tables, and every trigger/constraint that makes conflicts, capacity violations, and invalid transitions actually impossible at the database layer.

### Task 5: Migration — `sessions` Table with Constraints and EXCLUDE

**Files:**
- Create: `supabase/migrations/<timestamp>_sessions_table.sql`

- [ ] **Step 1: Write the migration**

```sql
-- sessions_table.sql
create extension if not exists btree_gist;

create table sessions (
  id uuid primary key default gen_random_uuid(),
  session_code text not null unique,
  title_ar text not null,
  title_en text not null,
  description_ar text,
  description_en text,
  conference_day_id uuid not null references conference_days(id),
  start_time timestamptz not null,
  end_time timestamptz not null,
  track_id uuid not null references tracks(id),
  session_type_id uuid not null references session_types(id),
  room_id uuid not null references rooms(id),
  language session_language not null,
  difficulty_level session_difficulty not null,
  capacity int not null,
  min_capacity int not null default 0,
  is_mandatory boolean not null default false,
  is_public boolean not null default true,
  include_in_allocation boolean not null default true,
  allocation_priority int not null default 0,
  enable_qr_checkin boolean not null default false,
  checkin_opens_at timestamptz,
  checkin_closes_at timestamptz,
  status session_status not null default 'draft',
  internal_notes text,
  published_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),

  constraint sessions_end_after_start check (end_time > start_time),
  constraint sessions_capacity_positive check (capacity > 0),
  constraint sessions_min_capacity_valid check (min_capacity >= 0 and min_capacity <= capacity),
  constraint sessions_checkin_window_order check (
    checkin_opens_at is null or checkin_closes_at is null or checkin_opens_at < checkin_closes_at
  ),
  constraint sessions_checkin_window_required check (
    enable_qr_checkin = false or (checkin_opens_at is not null and checkin_closes_at is not null)
  )
);

create trigger sessions_set_updated_at before update on sessions for each row execute function extensions.moddatetime('updated_at');

-- Room double-booking: draft/published/confirmed sessions block the room;
-- cancelled/completed do not. '[)' matches the design spec's explicit
-- half-open interval choice (a session ending exactly when another starts
-- is not a conflict).
alter table sessions add constraint sessions_room_no_overlap
  exclude using gist (
    room_id with =,
    tstzrange(start_time, end_time, '[)') with &&
  ) where (status in ('draft', 'published', 'confirmed'));

create index sessions_conference_day_idx on sessions (conference_day_id);
create index sessions_track_idx on sessions (track_id);
create index sessions_session_type_idx on sessions (session_type_id);
create index sessions_room_idx on sessions (room_id);
create index sessions_status_day_idx on sessions (status, conference_day_id);
create index sessions_status_track_idx on sessions (status, track_id);
create index sessions_room_start_idx on sessions (room_id, start_time);
```

- [ ] **Step 2: Apply and verify**

```sql
select conname, contype from pg_constraint where conrelid = 'sessions'::regclass;
```
Expected: `sessions_end_after_start`, `sessions_capacity_positive`, `sessions_min_capacity_valid`, `sessions_checkin_window_order`, `sessions_checkin_window_required` (all `contype = 'c'`), `sessions_room_no_overlap` (`contype = 'x'`), plus the primary key and unique/FK constraints. Manually test the EXCLUDE constraint with two throwaway overlapping-room inserts (via service-role client, cleaned up after) to confirm it actually rejects — don't just trust the constraint exists, confirm it fires.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/<timestamp>_sessions_table.sql
git commit -m "feat(db): add sessions table with capacity/time constraints and room-overlap exclusion"
```

**Rollback/failure behavior:** Transactional per-file, same as Task 1. A failure applying the EXCLUDE constraint specifically (e.g. if `btree_gist` somehow isn't available on the hosted project — verify this is not the case before relying on it, since it's a standard, always-available Supabase extension) would roll back the whole file. Hand-reverse: `alter table sessions drop constraint sessions_room_no_overlap; drop table if exists sessions cascade;` (cascade needed once Task 6's join tables reference it).

---

### Task 6: Migration — `session_people` and `session_tags` Join Tables

**Files:**
- Create: `supabase/migrations/<timestamp>_session_people_and_tags.sql`

- [ ] **Step 1: Write the migration**

```sql
-- session_people_and_tags.sql
create table session_people (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  person_id uuid not null references people(id),
  role session_person_role not null,
  display_order int not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),

  constraint session_people_unique_role unique (session_id, person_id, role)
);

create trigger session_people_set_updated_at before update on session_people for each row execute function extensions.moddatetime('updated_at');

create table session_tags (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  tag_id uuid not null references tags(id),
  weight numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),

  constraint session_tags_unique unique (session_id, tag_id),
  constraint session_tags_weight_range check (weight >= 0 and weight <= 1)
);

create trigger session_tags_set_updated_at before update on session_tags for each row execute function extensions.moddatetime('updated_at');

create index session_people_session_idx on session_people (session_id);
create index session_people_person_idx on session_people (person_id);
-- Composite index for enforce_speaker_no_conflict's hot path (Task 7) — runs
-- on every session_people write, distinct from the plain person_id FK index.
create index session_people_person_session_idx on session_people (person_id, session_id);
create index session_tags_session_idx on session_tags (session_id);
create index session_tags_tag_idx on session_tags (tag_id);
```

- [ ] **Step 2: Apply and verify**

Confirm both tables exist, confirm `session_people_unique_role` and `session_tags_unique`/`session_tags_weight_range` constraints are present via `pg_constraint`, confirm `on delete cascade` behavior with a throwaway session+session_people row (delete the session, confirm the session_people row is gone too), clean up.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/<timestamp>_session_people_and_tags.sql
git commit -m "feat(db): add session_people and session_tags join tables"
```

**Rollback/failure behavior:** Transactional per-file. Hand-reverse: `drop table if exists session_tags, session_people cascade;` — safe standalone since nothing else references these two tables.

---

### Task 7: Migration — Triggers (Day-Match, Status Transition, Capacity, Speaker Conflict)

This is the most intricate migration in the phase. Each trigger function is written and tested independently before moving to the next, but all are committed together since they're one cohesive "make the schema self-enforcing" unit and splitting them into 5 separate migrations would leave the schema in an inconsistent (partially-enforced) state between commits, which is worse than one larger reviewable commit here.

**`search_path` hardening (applies to every function in this plan, not just this task):** this codebase has twice needed a dedicated follow-up migration to retrofit `set search_path = public, pg_temp` onto a function that originally lacked it (`20260721201242_fix_handle_new_user_search_path.sql`, `20260721213243_fix_current_user_role_search_path.sql`), both framed explicitly as closing a search-path-hijacking gap. Every function defined in this plan (all 6 trigger functions below, plus the 4 RPC functions in Tasks 12–13) includes `set search_path = public, pg_temp` in its `language plpgsql` clause from the start, so this phase never needs its own retroactive fix migration.

**Files:**
- Create: `supabase/migrations/<timestamp>_sessions_triggers.sql`

- [ ] **Step 1: Write the day-match trigger**

```sql
-- sessions_triggers.sql

-- 1. Day-match: a session's start_time/end_time, converted to Asia/Muscat,
-- must fall on the same calendar date as its conference_day_id's
-- conference_date, and must not cross midnight into a different day.
create function enforce_session_day_match() returns trigger as $$
declare
  v_conference_date date;
  v_start_date date;
  v_end_date date;
begin
  select conference_date into v_conference_date from conference_days where id = new.conference_day_id;
  if v_conference_date is null then
    raise exception 'conference_day_id % does not exist', new.conference_day_id;
  end if;

  v_start_date := (new.start_time at time zone 'Asia/Muscat')::date;
  v_end_date := (new.end_time at time zone 'Asia/Muscat')::date;

  if v_start_date <> v_end_date then
    raise exception 'Session cannot span across midnight into a different conference day (start: %, end: %)', v_start_date, v_end_date;
  end if;

  if v_start_date <> v_conference_date then
    raise exception 'Session start/end time (%) does not match its conference day (%)', v_start_date, v_conference_date;
  end if;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_enforce_day_match
  before insert or update of start_time, end_time, conference_day_id on sessions
  for each row execute function enforce_session_day_match();
```

- [ ] **Step 2: Write the status-transition trigger (including cancellation_reason enforcement)**

```sql
-- 2. Status transition: mirrors SESSION_VALID_TRANSITIONS from
-- src/lib/validation/agenda.ts exactly. Also enforces cancellation_reason
-- is set when transitioning to cancelled, as a true DB-level backstop (not
-- just Zod/server-action) — see design spec's Data Model note on
-- cancellation_reason.
create function enforce_session_status_transition() returns trigger as $$
begin
  if old.status = new.status then
    return new; -- no-op status update always allowed
  end if;

  if new.status = 'cancelled' and (new.cancellation_reason is null or trim(new.cancellation_reason) = '') then
    raise exception 'A cancellation reason is required when cancelling a session';
  end if;

  case old.status
    when 'draft' then
      if new.status not in ('published', 'cancelled') then
        raise exception 'Cannot transition session from draft to %', new.status;
      end if;
    when 'published' then
      if new.status not in ('confirmed', 'cancelled') then
        raise exception 'Cannot transition session from published to %', new.status;
      end if;
    when 'confirmed' then
      if new.status not in ('completed', 'cancelled') then
        raise exception 'Cannot transition session from confirmed to %', new.status;
      end if;
    when 'cancelled' then
      raise exception 'Cannot transition session out of cancelled (terminal state)';
    when 'completed' then
      raise exception 'Cannot transition session out of completed (terminal state)';
  end case;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_enforce_status_transition
  before update of status on sessions
  for each row execute function enforce_session_status_transition();
```

- [ ] **Step 3: Write the capacity triggers**

```sql
-- 3. Session capacity cannot exceed its room's capacity.
create function enforce_session_room_capacity() returns trigger as $$
declare
  v_room_capacity int;
begin
  select capacity into v_room_capacity from rooms where id = new.room_id;
  if v_room_capacity is null then
    raise exception 'room_id % does not exist', new.room_id;
  end if;
  if new.capacity > v_room_capacity then
    raise exception 'Session capacity (%) exceeds room capacity (%)', new.capacity, v_room_capacity;
  end if;
  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_enforce_room_capacity
  before insert or update of capacity, room_id on sessions
  for each row execute function enforce_session_room_capacity();

-- 4. Reducing a room's capacity is rejected if any active session in that
-- room now exceeds it. Admin must first reduce/reassign conflicting
-- sessions. Deliberately does not cascade a silent capacity change onto
-- sessions (see design spec's rationale for this choice).
create function revalidate_sessions_on_room_capacity_change() returns trigger as $$
declare
  v_conflict_count int;
begin
  if new.capacity >= old.capacity then
    return new; -- only a reduction needs checking
  end if;
  select count(*) into v_conflict_count
    from sessions
    where room_id = new.id
      and status in ('draft', 'published', 'confirmed')
      and capacity > new.capacity;
  if v_conflict_count > 0 then
    raise exception 'Cannot reduce room capacity to %: % active session(s) in this room exceed that capacity', new.capacity, v_conflict_count;
  end if;
  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger rooms_revalidate_sessions_on_capacity_change
  before update of capacity on rooms
  for each row execute function revalidate_sessions_on_room_capacity_change();
```

- [ ] **Step 4: Write the speaker-conflict triggers**

```sql
-- 5. Speaker conflict on session_people insert/update: the person being
-- assigned/reassigned must not already be on another active session whose
-- time range overlaps this one's.
create function enforce_speaker_no_conflict() returns trigger as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_conflict_count int;
begin
  select start_time, end_time into v_start, v_end from sessions where id = new.session_id;
  if v_start is null then
    raise exception 'session_id % does not exist', new.session_id;
  end if;

  select count(*) into v_conflict_count
    from session_people sp
    join sessions s on s.id = sp.session_id
    where sp.person_id = new.person_id
      and sp.id is distinct from new.id
      and sp.session_id <> new.session_id
      and s.status in ('draft', 'published', 'confirmed')
      and tstzrange(s.start_time, s.end_time, '[)') && tstzrange(v_start, v_end, '[)');

  if v_conflict_count > 0 then
    raise exception 'Person % is already assigned to another session that overlaps this time slot', new.person_id;
  end if;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger session_people_enforce_no_conflict
  before insert or update of session_id, person_id, role on session_people
  for each row execute function enforce_speaker_no_conflict();

-- 6. Speaker conflict on sessions time/status change: when an existing
-- session's schedule or status changes, re-check every person currently
-- assigned to it against their other active sessions.
create function enforce_speaker_no_conflict_on_session_change() returns trigger as $$
declare
  v_conflict_person uuid;
begin
  select sp.person_id into v_conflict_person
    from session_people sp
    join session_people other_sp on other_sp.person_id = sp.person_id and other_sp.session_id <> sp.session_id
    join sessions other_s on other_s.id = other_sp.session_id
    where sp.session_id = new.id
      and new.status in ('draft', 'published', 'confirmed')
      and other_s.status in ('draft', 'published', 'confirmed')
      and tstzrange(other_s.start_time, other_s.end_time, '[)') && tstzrange(new.start_time, new.end_time, '[)')
    limit 1;

  if v_conflict_person is not null then
    raise exception 'Rescheduling this session creates a conflict for person % on another active session', v_conflict_person;
  end if;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_enforce_speaker_no_conflict_on_change
  before update of start_time, end_time, status on sessions
  for each row execute function enforce_speaker_no_conflict_on_session_change();
```

- [ ] **Step 5: Apply the full migration and verify each trigger individually**

Apply, then run 6 independent throwaway checks (one per trigger function), via service-role client, cleaning up after each:
1. Day-match: insert a session with `start_time` on a date not matching its `conference_day_id` — expect rejection.
2. Status transition: attempt `draft → confirmed` directly — expect rejection. Attempt `published → cancelled` with null `cancellation_reason` — expect rejection. Attempt `published → cancelled` with a reason — expect success.
3. Room capacity: insert a session with `capacity` > its room's `capacity` — expect rejection.
4. Room capacity reduction: create a session at a room's current capacity, then attempt to reduce the room's capacity below it — expect rejection.
5. Speaker conflict (session_people): assign the same person to two sessions with overlapping times — expect the second assignment to be rejected.
6. Speaker conflict (session change): assign a person to two non-overlapping sessions, then reschedule one to overlap the other — expect rejection.

This is manual/exploratory verification at this stage (not the formal automated test suite — that's Group D) purely to confirm each trigger fires correctly in isolation before building server actions on top of them.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/<timestamp>_sessions_triggers.sql
git commit -m "feat(db): add day-match, status-transition, capacity, and speaker-conflict triggers"
```

**Rollback/failure behavior:** Transactional per-file — if any single trigger function has a syntax error, the entire file (all 6 functions + 6 triggers) fails to apply, leaving the pre-migration state fully intact (no partial trigger set). Hand-reverse: `drop trigger` for all 6 triggers, `drop function` for all 6 functions, in the reverse order listed above (triggers before their functions, since a function can't be dropped while a trigger still references it).

---

### Task 8: RLS Policies for `sessions`, `session_people`, `session_tags`

**Files:**
- Create: `supabase/migrations/<timestamp>_sessions_rls_policies.sql`

- [ ] **Step 1: Write the migration**

```sql
-- sessions_rls_policies.sql
alter table sessions enable row level security;
alter table session_people enable row level security;
alter table session_tags enable row level security;

create policy sessions_staff_all on sessions
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

create policy session_people_staff_all on session_people
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

create policy session_tags_staff_all on session_tags
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
```

- [ ] **Step 2: Apply and verify**

Confirm RLS enabled and exactly one `ALL`-scoped policy per table, same verification pattern as Task 2.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/<timestamp>_sessions_rls_policies.sql
git commit -m "feat(db): add RLS policies for sessions, session_people, session_tags"
```

**Rollback/failure behavior:** Same pattern as Task 2.

---

### Task 9: Regenerate Supabase Database Types (post-Group-B)

**Files:**
- Modify: `src/types/database.ts`

- [ ] **Step 1–4:** Same procedure as Task 4 — regenerate, verify `sessions`/`session_people`/`session_tags` present with correct shapes (including the enum types), no secrets, typecheck clean, commit as `chore(db): regenerate database types for sessions and join tables`.

---

## Group B Checkpoint

```bash
npx tsc --noEmit
npm run lint
npm run test
npm run build
```

---

## Group C: Server Actions (Tasks 10–13)

### Task 10: `requireAgendaStaffCaller` Helper and Audit-Log Write Helper

**Files:**
- Create: `src/lib/agenda/server-helpers.ts`

- [ ] **Step 1: Implement**

```typescript
// src/lib/agenda/server-helpers.ts
import 'server-only';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import type { Database } from '@/types/database';

type ServiceClient = ReturnType<typeof createServiceRoleClient>;

export async function requireAgendaStaffCaller(): Promise<{ userId: string; service: ServiceClient }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (error || !profile) throw new Error('Profile not found');
  // Kept in sync manually with isAgendaStaffRole — this call delegates to it
  // directly (not a re-implementation), so there is nothing to keep in sync
  // beyond this one call site importing the shared helper correctly.
  if (!isAgendaStaffRole(profile.role)) {
    throw new Error('Not authorized');
  }

  return { userId: user.id, service };
}

export async function writeAuditLog(
  service: ServiceClient,
  entry: {
    entityType: string;
    entityId: string;
    action: string;
    actorId: string;
    requestId?: string;
    metadata?: Record<string, unknown>;
    oldValues?: Record<string, unknown> | null;
    newValues?: Record<string, unknown> | null;
  }
): Promise<void> {
  const { error } = await service.from('audit_logs').insert({
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    action: entry.action,
    actor_type: 'admin',
    actor_id: entry.actorId,
    request_id: entry.requestId ?? null,
    metadata: entry.metadata ?? null,
    old_values: entry.oldValues ?? null,
    new_values: entry.newValues ?? null,
  });
  if (error) {
    // Audit log failure should not silently corrupt the caller's understanding
    // of whether the underlying write succeeded — log loudly, but the caller
    // decides whether a failed audit write should fail the whole operation
    // (see each entity action below; the default is: log and continue, same
    // as Phase 1/2's email_log/history-insert failure handling, since the
    // primary write already succeeded and blocking on audit-log failure would
    // make agenda editing hostage to a secondary system).
    console.error('writeAuditLog: failed to insert audit log row', { entry, error });
  }
}
```

**Note:** `import 'server-only'` is a new addition not present in Phase 1/2's action files — worth including here specifically because this helper module, unlike a `'use server'` actions file (which Next.js already restricts to server-only usage), is a plain importable module that could theoretically be imported from a client component by mistake. Adding `server-only` (already a transitive dependency via Next.js) makes that a build-time error instead of a runtime service-role-key leak. If `server-only` is not already an available package in this project, verify via `npm ls server-only` before using it — if unavailable, omit the import and rely on the same convention Phase 1/2 already use (these helpers are only ever imported from `'use server'` files), noting the gap rather than introducing a new dependency without checking first.

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/agenda/server-helpers.ts
git commit -m "feat: add agenda staff-auth and audit-log server helpers"
```

---

### Task 11: Reference-Entity Server Actions (Days, Tracks, Session Types, Rooms, People, Tags)

Six structurally-identical CRUD modules. Written as one task since they share one shape and reviewing them separately would be repetitive, but each gets its own file.

**Files:**
- Create: `src/app/[locale]/(admin)/agenda/days/actions.ts`
- Create: `src/app/[locale]/(admin)/agenda/tracks/actions.ts`
- Create: `src/app/[locale]/(admin)/agenda/session-types/actions.ts`
- Create: `src/app/[locale]/(admin)/agenda/rooms/actions.ts`
- Create: `src/app/[locale]/(admin)/agenda/people/actions.ts`
- Create: `src/app/[locale]/(admin)/agenda/tags/actions.ts`

- [ ] **Step 1: Implement one representative module in full — `rooms/actions.ts`** (chosen as the representative because it has the most fields/constraints among the six, making it the best template)

```typescript
// src/app/[locale]/(admin)/agenda/rooms/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { z } from 'zod';

const roomInputSchema = z.object({
  code: z.string().trim().min(1),
  nameAr: z.string().trim().min(1),
  nameEn: z.string().trim().min(1),
  capacity: z.number().int().positive(),
  location: z.string().trim().optional().nullable(),
  floor: z.string().trim().optional().nullable(),
  isAccessible: z.boolean(),
});

export async function createRoom(input: z.infer<typeof roomInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = roomInputSchema.parse(input);

  const { data: existing } = await service.from('rooms').select('id').eq('code', parsed.code).maybeSingle();
  if (existing) throw new Error(`Room code "${parsed.code}" is already in use`);

  const { data: room, error } = await service
    .from('rooms')
    .insert({
      code: parsed.code,
      name_ar: parsed.nameAr,
      name_en: parsed.nameEn,
      capacity: parsed.capacity,
      location: parsed.location ?? null,
      floor: parsed.floor ?? null,
      is_accessible: parsed.isAccessible,
      updated_by: userId,
    })
    .select('id')
    .single();
  if (error || !room) {
    console.error('createRoom: insert failed', { input: parsed, userId, error });
    throw error ?? new Error('Failed to create room');
  }

  await writeAuditLog(service, { entityType: 'room', entityId: room.id, action: 'create', actorId: userId, newValues: parsed });
  return { id: room.id };
}

export async function updateRoom(id: string, input: z.infer<typeof roomInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = roomInputSchema.parse(input);

  const { data: existing } = await service.from('rooms').select('*').eq('id', id).single();
  if (!existing) throw new Error('Room not found');

  const { data: codeConflict } = await service.from('rooms').select('id').eq('code', parsed.code).neq('id', id).maybeSingle();
  if (codeConflict) throw new Error(`Room code "${parsed.code}" is already in use`);

  // Room-capacity-reduction conflicts are caught by the DB trigger
  // (revalidate_sessions_on_room_capacity_change) — this action does not
  // pre-check separately, it lets the trigger reject and translates the
  // resulting Postgres error into a clear message.
  const { error } = await service
    .from('rooms')
    .update({
      code: parsed.code,
      name_ar: parsed.nameAr,
      name_en: parsed.nameEn,
      capacity: parsed.capacity,
      location: parsed.location ?? null,
      floor: parsed.floor ?? null,
      is_accessible: parsed.isAccessible,
      updated_by: userId,
    })
    .eq('id', id);
  if (error) {
    if (error.message.includes('exceed that capacity')) {
      throw new Error(error.message); // trigger's message is already staff-readable
    }
    console.error('updateRoom: update failed', { id, input: parsed, userId, error });
    throw error;
  }

  await writeAuditLog(service, { entityType: 'room', entityId: id, action: 'update', actorId: userId, oldValues: existing, newValues: parsed });
  return { id };
}

export async function deactivateRoom(id: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data: existing } = await service.from('rooms').select('is_active').eq('id', id).single();
  if (!existing) throw new Error('Room not found');

  const { error } = await service.from('rooms').update({ is_active: false, updated_by: userId }).eq('id', id);
  if (error) {
    console.error('deactivateRoom: update failed', { id, userId, error });
    throw error;
  }

  await writeAuditLog(service, { entityType: 'room', entityId: id, action: 'deactivate', actorId: userId, oldValues: { is_active: existing.is_active }, newValues: { is_active: false } });
  return { id };
}

export async function reactivateRoom(id: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { error } = await service.from('rooms').update({ is_active: true, updated_by: userId }).eq('id', id);
  if (error) {
    console.error('reactivateRoom: update failed', { id, userId, error });
    throw error;
  }
  await writeAuditLog(service, { entityType: 'room', entityId: id, action: 'reactivate', actorId: userId, newValues: { is_active: true } });
  return { id };
}
```

- [ ] **Step 2: Implement the remaining five modules following the identical shape**

`days/actions.ts` (fields: `conferenceDate`, `labelAr`, `labelEn`, `displayOrder`; uniqueness on `conference_date` not `code`), `tracks/actions.ts` (fields: `code`, `nameAr`, `nameEn`, `color`), `session-types/actions.ts` (fields: `code`, `nameAr`, `nameEn`), `people/actions.ts` (fields: `fullNameAr`, `fullNameEn`, `titleAr`, `titleEn`, `organizationAr`, `organizationEn`, `bioAr`, `bioEn`, `photoPath`, `email`, `phone`, `linkedProfileId`), `tags/actions.ts` (fields: `code`, `nameAr`, `nameEn`). Each gets its own `create*`/`update*`/`deactivate*`/`reactivate*` quartet, same structure as `rooms/actions.ts`.

**Note on `people/actions.ts`'s `linked_profile_id` uniqueness:** unlike `updateRoom`'s capacity-trigger catch (a `RAISE EXCEPTION`-raised custom message, matched by substring), a duplicate `linked_profile_id` arrives as Postgres error code `23505` (`unique_violation`) directly from the `people_linked_profile_id_key` constraint, with no substring match needed — check `error.code === '23505'` and translate to `"This platform account is already linked to another person record"`, following the same `error.code`-based pattern (not substring matching) already used for `23P01` in `translateSessionWriteError` (Task 12).

- [ ] **Step 3: Typecheck and lint**

```bash
npx tsc --noEmit
npm run lint
```

- [ ] **Step 4: Commit** (one commit per module keeps this reviewable — 6 commits, not 1)

```bash
git add "src/app/[locale]/(admin)/agenda/rooms/actions.ts" && git commit -m "feat: add room CRUD server actions"
git add "src/app/[locale]/(admin)/agenda/days/actions.ts" && git commit -m "feat: add conference day CRUD server actions"
git add "src/app/[locale]/(admin)/agenda/tracks/actions.ts" && git commit -m "feat: add track CRUD server actions"
git add "src/app/[locale]/(admin)/agenda/session-types/actions.ts" && git commit -m "feat: add session type CRUD server actions"
git add "src/app/[locale]/(admin)/agenda/people/actions.ts" && git commit -m "feat: add people CRUD server actions"
git add "src/app/[locale]/(admin)/agenda/tags/actions.ts" && git commit -m "feat: add tag CRUD server actions"
```

---

### Task 12: Session Server Actions (Create, Update, Status Transition)

**Files:**
- Create: `src/app/[locale]/(admin)/agenda/sessions/[id]/actions.ts`

- [ ] **Step 1: Implement `createSession` and `updateSession`**

```typescript
// src/app/[locale]/(admin)/agenda/sessions/[id]/actions.ts
'use server';

import { randomUUID } from 'crypto';
import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { sessionStatusTransitionSchema, checkinWindowSchema, type SessionStatus } from '@/lib/validation/agenda';
import { z } from 'zod';

const sessionInputSchema = z.object({
  sessionCode: z.string().trim().min(1),
  titleAr: z.string().trim().min(1),
  titleEn: z.string().trim().min(1),
  descriptionAr: z.string().trim().optional().nullable(),
  descriptionEn: z.string().trim().optional().nullable(),
  conferenceDayId: z.string().uuid(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  trackId: z.string().uuid(),
  sessionTypeId: z.string().uuid(),
  roomId: z.string().uuid(),
  language: z.enum(['ar', 'en', 'bilingual']),
  difficultyLevel: z.enum(['beginner', 'intermediate', 'advanced', 'all_levels']),
  capacity: z.number().int().positive(),
  minCapacity: z.number().int().min(0),
  isMandatory: z.boolean(),
  isPublic: z.boolean(),
  includeInAllocation: z.boolean(),
  allocationPriority: z.number().int(),
  enableQrCheckin: z.boolean(),
  checkinOpensAt: z.string().datetime().nullable(),
  checkinClosesAt: z.string().datetime().nullable(),
  internalNotes: z.string().trim().optional().nullable(),
}).refine((data) => new Date(data.endTime) > new Date(data.startTime), {
  message: 'End time must be after start time', path: ['endTime'],
}).refine((data) => data.minCapacity <= data.capacity, {
  message: 'Minimum capacity cannot exceed capacity', path: ['minCapacity'],
});

// Postgres error codes this module translates into staff-readable messages,
// rather than surfacing raw DB errors. 23P01 = exclusion_violation (room
// overlap). Trigger-raised exceptions arrive as plain error messages (custom
// RAISE EXCEPTION has no dedicated SQLSTATE here), matched by substring.
function translateSessionWriteError(error: { code?: string; message: string }): Error {
  if (error.code === '23P01') {
    return new Error('This room is already booked for an overlapping time on this day');
  }
  if (error.message.includes('overlaps this time slot') || error.message.includes('creates a conflict for person')) {
    return new Error('One or more assigned people have a scheduling conflict with this time');
  }
  if (error.message.includes('exceeds room capacity')) {
    return new Error(error.message);
  }
  if (error.message.includes('does not match its conference day')) {
    return new Error(error.message);
  }
  return new Error(error.message);
}

export async function createSession(input: z.infer<typeof sessionInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = sessionInputSchema.parse(input);
  checkinWindowSchema.parse({
    enableQrCheckin: parsed.enableQrCheckin,
    checkinOpensAt: parsed.checkinOpensAt,
    checkinClosesAt: parsed.checkinClosesAt,
  });

  const { data: codeConflict } = await service.from('sessions').select('id').eq('session_code', parsed.sessionCode).maybeSingle();
  if (codeConflict) throw new Error(`Session code "${parsed.sessionCode}" is already in use`);

  const { data: session, error } = await service
    .from('sessions')
    .insert({
      session_code: parsed.sessionCode,
      title_ar: parsed.titleAr,
      title_en: parsed.titleEn,
      description_ar: parsed.descriptionAr ?? null,
      description_en: parsed.descriptionEn ?? null,
      conference_day_id: parsed.conferenceDayId,
      start_time: parsed.startTime,
      end_time: parsed.endTime,
      track_id: parsed.trackId,
      session_type_id: parsed.sessionTypeId,
      room_id: parsed.roomId,
      language: parsed.language,
      difficulty_level: parsed.difficultyLevel,
      capacity: parsed.capacity,
      min_capacity: parsed.minCapacity,
      is_mandatory: parsed.isMandatory,
      is_public: parsed.isPublic,
      include_in_allocation: parsed.includeInAllocation,
      allocation_priority: parsed.allocationPriority,
      enable_qr_checkin: parsed.enableQrCheckin,
      checkin_opens_at: parsed.checkinOpensAt,
      checkin_closes_at: parsed.checkinClosesAt,
      internal_notes: parsed.internalNotes ?? null,
      updated_by: userId,
    })
    .select('id')
    .single();
  if (error || !session) {
    console.error('createSession: insert failed', { input: parsed, userId, error });
    throw error ? translateSessionWriteError(error) : new Error('Failed to create session');
  }

  await writeAuditLog(service, { entityType: 'session', entityId: session.id, action: 'create', actorId: userId, newValues: parsed });
  return { id: session.id };
}

export async function updateSession(id: string, input: z.infer<typeof sessionInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = sessionInputSchema.parse(input);
  checkinWindowSchema.parse({
    enableQrCheckin: parsed.enableQrCheckin,
    checkinOpensAt: parsed.checkinOpensAt,
    checkinClosesAt: parsed.checkinClosesAt,
  });

  const { data: existing } = await service.from('sessions').select('*').eq('id', id).single();
  if (!existing) throw new Error('Session not found');

  const { data: codeConflict } = await service.from('sessions').select('id').eq('session_code', parsed.sessionCode).neq('id', id).maybeSingle();
  if (codeConflict) throw new Error(`Session code "${parsed.sessionCode}" is already in use`);

  const timeOrRoomChanged = existing.start_time !== parsed.startTime || existing.end_time !== parsed.endTime || existing.room_id !== parsed.roomId;

  const { error } = await service
    .from('sessions')
    .update({
      session_code: parsed.sessionCode,
      title_ar: parsed.titleAr,
      title_en: parsed.titleEn,
      description_ar: parsed.descriptionAr ?? null,
      description_en: parsed.descriptionEn ?? null,
      conference_day_id: parsed.conferenceDayId,
      start_time: parsed.startTime,
      end_time: parsed.endTime,
      track_id: parsed.trackId,
      session_type_id: parsed.sessionTypeId,
      room_id: parsed.roomId,
      language: parsed.language,
      difficulty_level: parsed.difficultyLevel,
      capacity: parsed.capacity,
      min_capacity: parsed.minCapacity,
      is_mandatory: parsed.isMandatory,
      is_public: parsed.isPublic,
      include_in_allocation: parsed.includeInAllocation,
      allocation_priority: parsed.allocationPriority,
      enable_qr_checkin: parsed.enableQrCheckin,
      checkin_opens_at: parsed.checkinOpensAt,
      checkin_closes_at: parsed.checkinClosesAt,
      internal_notes: parsed.internalNotes ?? null,
      updated_by: userId,
    })
    .eq('id', id);
  if (error) {
    console.error('updateSession: update failed', { id, input: parsed, userId, error });
    throw translateSessionWriteError(error);
  }

  // Per design spec's multi-step transaction safety requirement: if the
  // schedule/room changed, re-validate every currently-assigned person's
  // conflict status once more as a final gate, closing the same-transaction
  // firing-order gap between the two speaker-conflict triggers. This re-query
  // uses the exact same overlap logic the triggers use; if it finds a
  // conflict, it throws — which, since this all runs within the request's
  // implicit Supabase transaction semantics for a single server action call,
  // must itself be wrapped so that a failure here does not leave the session
  // update applied without this check having passed. See Task 12 Step 2 for
  // the transactional wrapping this requires.
  if (timeOrRoomChanged) {
    await revalidateSpeakerConflictsOrThrow(service, id);
  }

  await writeAuditLog(service, { entityType: 'session', entityId: id, action: 'update', actorId: userId, oldValues: existing, newValues: parsed });
  return { id };
}

async function revalidateSpeakerConflictsOrThrow(service: Awaited<ReturnType<typeof requireAgendaStaffCaller>>['service'], sessionId: string) {
  const { data: assignedPeople } = await service.from('session_people').select('person_id').eq('session_id', sessionId);
  if (!assignedPeople || assignedPeople.length === 0) return;

  const { data: session } = await service.from('sessions').select('start_time, end_time, status').eq('id', sessionId).single();
  if (!session || session.status === 'cancelled' || session.status === 'completed') return;

  for (const { person_id } of assignedPeople) {
    const { data: conflicts } = await service
      .from('session_people')
      .select('session_id, sessions!inner(start_time, end_time, status)')
      .eq('person_id', person_id)
      .neq('session_id', sessionId);

    const hasConflict = (conflicts ?? []).some((row) => {
      const other = row.sessions as unknown as { start_time: string; end_time: string; status: string };
      if (!['draft', 'published', 'confirmed'].includes(other.status)) return false;
      const otherStart = new Date(other.start_time).getTime();
      const otherEnd = new Date(other.end_time).getTime();
      const thisStart = new Date(session.start_time).getTime();
      const thisEnd = new Date(session.end_time).getTime();
      return otherStart < thisEnd && thisStart < otherEnd;
    });

    if (hasConflict) {
      throw new Error(`Person ${person_id} has a scheduling conflict with this session's new time — the update has been rejected`);
    }
  }
}
```

**Important implementation note for the implementer:** the comment in `updateSession` above flags a real design tension: Supabase's JS client does not expose explicit multi-statement transactions (`BEGIN`/`COMMIT`) the way a raw `pg` connection would — each `.from(...).update(...)`/`.insert(...)` call is its own implicit transaction against PostgREST. This means `revalidateSpeakerConflictsOrThrow` running *after* the `UPDATE sessions` call has already committed is NOT truly atomic with that update — if it throws, the session's new time has already been persisted, contradicting the design spec's requirement that "the entire operation fails without leaving partial database changes" (Testing Requirement 8). **This must be resolved before Task 12 is considered done — do not proceed to Task 13 with this gap unresolved.** The correct fix is to wrap `updateSession`'s write and the re-validation in a single Postgres function (`update_session_and_revalidate(...)`) called via `service.rpc(...)`, so the whole thing runs as one real DB transaction that rolls back atomically if the final check fails — mirroring how `submitApplication` (Phase 1) uses `service.rpc('next_application_number')` for its own transactional needs, and how this same problem was implicitly avoided everywhere else in this plan by putting checks in triggers (which ARE part of the same transaction as the statement that fired them) rather than in application code after the fact. Rewrite `updateSession` as a call to a new RPC function `update_session_transactional` (defined in a new migration, Task 12a below) instead of the two-step client-side approach shown above, which is provided only to make the *logic* being ported into SQL clear, not as the final shipped implementation.

- [ ] **Step 1a (mandatory, supersedes the naive Step 1 approach above): Migration — `update_session_transactional` RPC function**

**Files:**
- Create: `supabase/migrations/<timestamp>_update_session_transactional_function.sql`

```sql
-- update_session_transactional_function.sql
--
-- Wraps a session update and its post-write speaker-conflict re-validation
-- in one real Postgres transaction (a plpgsql function body is atomic by
-- default), so a re-validation failure actually rolls back the update —
-- closing the gap a two-step client-side approach cannot close, since
-- PostgREST/Supabase-js calls are not composable into one client transaction.
create function update_session_transactional(
  p_id uuid,
  p_session_code text, p_title_ar text, p_title_en text,
  p_description_ar text, p_description_en text,
  p_conference_day_id uuid, p_start_time timestamptz, p_end_time timestamptz,
  p_track_id uuid, p_session_type_id uuid, p_room_id uuid,
  p_language session_language, p_difficulty_level session_difficulty,
  p_capacity int, p_min_capacity int,
  p_is_mandatory boolean, p_is_public boolean,
  p_include_in_allocation boolean, p_allocation_priority int,
  p_enable_qr_checkin boolean, p_checkin_opens_at timestamptz, p_checkin_closes_at timestamptz,
  p_internal_notes text, p_updated_by uuid
) returns sessions as $$
declare
  v_result sessions;
  v_conflict_person uuid;
begin
  update sessions set
    session_code = p_session_code, title_ar = p_title_ar, title_en = p_title_en,
    description_ar = p_description_ar, description_en = p_description_en,
    conference_day_id = p_conference_day_id, start_time = p_start_time, end_time = p_end_time,
    track_id = p_track_id, session_type_id = p_session_type_id, room_id = p_room_id,
    language = p_language, difficulty_level = p_difficulty_level,
    capacity = p_capacity, min_capacity = p_min_capacity,
    is_mandatory = p_is_mandatory, is_public = p_is_public,
    include_in_allocation = p_include_in_allocation, allocation_priority = p_allocation_priority,
    enable_qr_checkin = p_enable_qr_checkin, checkin_opens_at = p_checkin_opens_at, checkin_closes_at = p_checkin_closes_at,
    internal_notes = p_internal_notes, updated_by = p_updated_by
  where id = p_id
  returning * into v_result;

  if v_result.id is null then
    raise exception 'Session % not found', p_id;
  end if;

  -- Final re-validation: every person currently assigned to this session,
  -- checked against their other active sessions, using the session's FINAL
  -- committed-within-this-transaction time/status. This runs after the
  -- update above (so session_people's join to sessions sees the new time)
  -- and closes the multi-statement/firing-order gap described in the design
  -- spec — if this finds a conflict, the exception below rolls back the
  -- entire function body, including the update already performed above.
  if v_result.status in ('draft', 'published', 'confirmed') then
    select sp.person_id into v_conflict_person
      from session_people sp
      join session_people other_sp on other_sp.person_id = sp.person_id and other_sp.session_id <> sp.session_id
      join sessions other_s on other_s.id = other_sp.session_id
      where sp.session_id = p_id
        and other_s.status in ('draft', 'published', 'confirmed')
        and tstzrange(other_s.start_time, other_s.end_time, '[)') && tstzrange(v_result.start_time, v_result.end_time, '[)')
      limit 1;

    if v_conflict_person is not null then
      raise exception 'Person % has a scheduling conflict with this session''s new time — the update has been rejected', v_conflict_person;
    end if;
  end if;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;
```

**Note:** this RPC function duplicates the overlap-check logic already present in the `sessions_enforce_speaker_no_conflict_on_change` trigger (Task 7). This duplication is intentional, not an oversight: the trigger fires on the `UPDATE sessions` statement inside this function too (triggers fire regardless of whether the statement originates from a client call or from within another function), so the trigger already catches most cases — this RPC's own final check exists specifically for the narrower case the design spec identified (a `session_people` change combined with a `sessions` time change in what the *client* considers one logical operation). Since this RPC only touches `sessions`, not `session_people`, in practice this particular function's own re-check is redundant with the trigger for this specific call path — but the RPC pattern established here (do the write, then re-validate, all inside one plpgsql function so it's genuinely transactional) is what Task 13's `update_session_and_assignments_transactional` RPC extends: a single function that accepts both session-field changes and a full replacement set of `session_people` rows in one call, used by the one UI flow that changes both together (see Task 13 and Task 17 Step 2).

Apply this migration, verify the function exists (`select proname from pg_proc where proname = 'update_session_transactional';`), commit as `feat(db): add update_session_transactional RPC for atomic session updates with re-validation`.

**Rollback/failure behavior:** Transactional per-file — a syntax error in the function body fails the whole file, leaving no partial function definition. Hand-reverse: `drop function if exists update_session_transactional(uuid, text, text, text, text, text, uuid, timestamptz, timestamptz, uuid, uuid, uuid, session_language, session_difficulty, int, int, boolean, boolean, boolean, int, boolean, timestamptz, timestamptz, text, uuid);` (full signature required since Postgres allows function overloading by signature) — safe with no data-loss risk, since nothing else references this function by dependency (only application code calls it via `service.rpc(...)`).

**Mandatory: regenerate Supabase database types before writing any TypeScript that calls this RPC.** `service.rpc('update_session_transactional', {...})` is typed against `Database['public']['Functions']` in `src/types/database.ts` (the same mechanism already used for `current_user_role`/`next_application_number` — see how those appear in the generated file). This function does not exist in the generated types until regenerated, so Step 1b below will not typecheck correctly without this step first:

```bash
npx supabase gen types typescript --linked > src/types/database.ts
```
Verify `update_session_transactional` appears under `Functions`, verify no secrets leaked (same check as Task 4), then commit as its own step: `git add src/types/database.ts && git commit -m "chore(db): regenerate database types for update_session_transactional"`.

- [ ] **Step 1b: Rewrite `updateSession` in `sessions/[id]/actions.ts` to call the RPC**

Replace the naive two-step body shown in Step 1 with:
```typescript
export async function updateSession(id: string, input: z.infer<typeof sessionInputSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = sessionInputSchema.parse(input);
  checkinWindowSchema.parse({ enableQrCheckin: parsed.enableQrCheckin, checkinOpensAt: parsed.checkinOpensAt, checkinClosesAt: parsed.checkinClosesAt });

  const { data: existing } = await service.from('sessions').select('*').eq('id', id).single();
  if (!existing) throw new Error('Session not found');

  const { data: codeConflict } = await service.from('sessions').select('id').eq('session_code', parsed.sessionCode).neq('id', id).maybeSingle();
  if (codeConflict) throw new Error(`Session code "${parsed.sessionCode}" is already in use`);

  const { data: result, error } = await service.rpc('update_session_transactional', {
    p_id: id, p_session_code: parsed.sessionCode, p_title_ar: parsed.titleAr, p_title_en: parsed.titleEn,
    p_description_ar: parsed.descriptionAr ?? null, p_description_en: parsed.descriptionEn ?? null,
    p_conference_day_id: parsed.conferenceDayId, p_start_time: parsed.startTime, p_end_time: parsed.endTime,
    p_track_id: parsed.trackId, p_session_type_id: parsed.sessionTypeId, p_room_id: parsed.roomId,
    p_language: parsed.language, p_difficulty_level: parsed.difficultyLevel,
    p_capacity: parsed.capacity, p_min_capacity: parsed.minCapacity,
    p_is_mandatory: parsed.isMandatory, p_is_public: parsed.isPublic,
    p_include_in_allocation: parsed.includeInAllocation, p_allocation_priority: parsed.allocationPriority,
    p_enable_qr_checkin: parsed.enableQrCheckin, p_checkin_opens_at: parsed.checkinOpensAt, p_checkin_closes_at: parsed.checkinClosesAt,
    p_internal_notes: parsed.internalNotes ?? null, p_updated_by: userId,
  });
  if (error) {
    console.error('updateSession: rpc failed', { id, input: parsed, userId, error });
    throw translateSessionWriteError(error);
  }

  await writeAuditLog(service, { entityType: 'session', entityId: id, action: 'update', actorId: userId, oldValues: existing, newValues: parsed });
  return { id: result.id };
}
```
Remove the now-unused `revalidateSpeakerConflictsOrThrow` helper from the actions file (it moved into SQL).

- [ ] **Step 2: Implement `updateSessionStatus`**

```typescript
export async function updateSessionStatus(id: string, to: SessionStatus, cancellationReason?: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data: existing } = await service.from('sessions').select('status').eq('id', id).single();
  if (!existing) throw new Error('Session not found');

  sessionStatusTransitionSchema.parse({ from: existing.status, to, cancellationReason });

  const updates: Record<string, unknown> = { status: to, updated_by: userId };
  if (to === 'published') updates.published_at = new Date().toISOString();
  if (to === 'confirmed') updates.confirmed_at = new Date().toISOString();
  if (to === 'cancelled') {
    updates.cancelled_at = new Date().toISOString();
    updates.cancellation_reason = cancellationReason;
  }

  // Optimistic-concurrency guard: re-check the expected prior status on the
  // UPDATE itself and require exactly one affected row, exactly like Phase
  // 2's updateApplicationStatus (src/app/[locale]/(admin)/applications/[id]/actions.ts).
  // PostgREST returns error: null when an UPDATE matches zero rows — without
  // the explicit rowcount check below, a concurrent status change by another
  // admin between the read above and this write would silently no-op while
  // this function still wrote an audit log and returned success.
  const { data: updatedRows, error } = await service
    .from('sessions')
    .update(updates)
    .eq('id', id)
    .eq('status', existing.status)
    .select('id');
  if (error) {
    console.error('updateSessionStatus: update failed', { id, to, userId, error });
    throw translateSessionWriteError(error);
  }
  if (!updatedRows || updatedRows.length === 0) {
    throw new Error('Session status changed by someone else, please refresh');
  }

  await writeAuditLog(service, { entityType: 'session', entityId: id, action: 'status_change', actorId: userId, oldValues: { status: existing.status }, newValues: { status: to, cancellationReason } });
  return { id, status: to };
}
```
Note: `.eq('status', existing.status)` on the update is the same optimistic-concurrency guard pattern from Phase 1/2 — closes the read-then-write race for concurrent status changes, on top of (not instead of) the DB trigger's own transition-validity check.

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add "src/app/[locale]/(admin)/agenda/sessions/[id]/actions.ts"
git commit -m "feat: add session create/update/status-transition server actions"
```

---

### Task 13: Session-People and Session-Tags Server Actions (Transactional)

**Files:**
- Create: `supabase/migrations/<timestamp>_session_people_transactional_functions.sql`
- Modify: `src/app/[locale]/(admin)/agenda/sessions/[id]/actions.ts`

- [ ] **Step 1: Migration — transactional RPCs for assignment writes**

Per Task 12's note, any operation that could combine a `session_people` change with the same session's schedule change in one logical UI action needs real transactional re-validation. Since this UI (per the Pages section) edits a session's people assignments on the same detail page as its schedule, but as visually separate actions (add speaker vs. reschedule), the simplest correct design is: keep `assignSessionPerson`/`removeSessionPerson` as their own RPCs that re-validate at the end of their own function body (mirroring `update_session_transactional`'s pattern), which is sufficient for the common case (one change at a time). The specific "combined write in one operation" scenario the mandatory test (Group D, Scenario 8) requires is satisfied by `update_session_transactional` when a caller updates both a session's time AND (in the same request) issues `session_people` writes via a *new* combined RPC — add `update_session_and_assignments_transactional` specifically for this, used only by the one UI flow that needs it (see Task 15's detail page), while `assignSessionPerson`/`removeSessionPerson` remain available as their own simpler RPCs for the common single-change case.

```sql
-- session_people_transactional_functions.sql

create function assign_session_person_transactional(
  p_session_id uuid, p_person_id uuid, p_role session_person_role,
  p_display_order int, p_is_primary boolean, p_updated_by uuid
) returns session_people as $$
declare
  v_result session_people;
begin
  insert into session_people (session_id, person_id, role, display_order, is_primary, updated_by)
  values (p_session_id, p_person_id, p_role, p_display_order, p_is_primary, p_updated_by)
  returning * into v_result;
  -- Conflict checking is fully handled by the enforce_speaker_no_conflict
  -- trigger, which fires as part of this same INSERT statement (and thus
  -- this same transaction) — no separate re-validation needed here, unlike
  -- update_session_transactional, since there's only one write in this
  -- function body.
  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;

create function remove_session_person(p_session_people_id uuid) returns void as $$
begin
  delete from session_people where id = p_session_people_id;
end;
$$ language plpgsql set search_path = public, pg_temp;

-- Combined operation: update a session's schedule AND replace its full
-- session_people assignment set in one real transaction. This is the RPC
-- Testing Requirement 8 (Group D) exercises directly — it's the only code
-- path in this phase where a schedule change and an assignment change
-- happen as one atomic unit, so it's also the only path that needs its own
-- dedicated final re-validation covering both kinds of change together.
create function update_session_and_assignments_transactional(
  p_id uuid,
  p_start_time timestamptz, p_end_time timestamptz, p_room_id uuid,
  p_updated_by uuid,
  p_new_assignments jsonb -- array of {person_id, role, display_order, is_primary}
) returns sessions as $$
declare
  v_result sessions;
  v_conflict_person uuid;
  v_assignment jsonb;
begin
  update sessions set start_time = p_start_time, end_time = p_end_time, room_id = p_room_id, updated_by = p_updated_by
  where id = p_id
  returning * into v_result;

  if v_result.id is null then
    raise exception 'Session % not found', p_id;
  end if;

  delete from session_people where session_id = p_id;

  for v_assignment in select * from jsonb_array_elements(p_new_assignments) loop
    insert into session_people (session_id, person_id, role, display_order, is_primary, updated_by)
    values (
      p_id,
      (v_assignment->>'person_id')::uuid,
      (v_assignment->>'role')::session_person_role,
      coalesce((v_assignment->>'display_order')::int, 0),
      coalesce((v_assignment->>'is_primary')::boolean, false),
      p_updated_by
    );
  end loop;

  -- Final combined-state re-validation: check every person now assigned to
  -- this session against their OTHER active sessions, using the session's
  -- final new time. This is what Testing Requirement 8 verifies directly —
  -- a conflict only visible after both the reschedule and the reassignment
  -- are both applied must still be caught, and caught here it is, because
  -- this whole function body is one transaction: the exception below rolls
  -- back both the sessions UPDATE and every session_people change above.
  if v_result.status in ('draft', 'published', 'confirmed') then
    select sp.person_id into v_conflict_person
      from session_people sp
      join session_people other_sp on other_sp.person_id = sp.person_id and other_sp.session_id <> sp.session_id
      join sessions other_s on other_s.id = other_sp.session_id
      where sp.session_id = p_id
        and other_s.status in ('draft', 'published', 'confirmed')
        and tstzrange(other_s.start_time, other_s.end_time, '[)') && tstzrange(v_result.start_time, v_result.end_time, '[)')
      limit 1;

    if v_conflict_person is not null then
      raise exception 'Person % has a scheduling conflict created by this combined update — the entire operation has been rejected', v_conflict_person;
    end if;
  end if;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;
```

Apply, verify all 3 functions exist, commit as `feat(db): add transactional RPCs for session-people assignment and combined updates`.

**Rollback/failure behavior:** Transactional per-file, same as every other migration in this plan. Hand-reverse: `drop function if exists assign_session_person_transactional(uuid, uuid, session_person_role, int, boolean, uuid); drop function if exists remove_session_person(uuid); drop function if exists update_session_and_assignments_transactional(uuid, timestamptz, timestamptz, uuid, uuid, jsonb);` — no data-loss risk, same reasoning as Task 12 Step 1a.

**Mandatory: regenerate Supabase database types before Step 2 writes any TypeScript calling these RPCs** (same requirement and reasoning as Task 12 Step 1a — `service.rpc(...)` needs these 3 new functions present in `Database['public']['Functions']` to typecheck):

```bash
npx supabase gen types typescript --linked > src/types/database.ts
```
Verify all 3 functions appear under `Functions`, verify no secrets leaked, commit: `git add src/types/database.ts && git commit -m "chore(db): regenerate database types for session-people transactional RPCs"`.

- [ ] **Step 2: Add the corresponding server actions**

```typescript
// appended to src/app/[locale]/(admin)/agenda/sessions/[id]/actions.ts

const assignPersonSchema = z.object({
  personId: z.string().uuid(),
  role: z.enum(['speaker', 'guest', 'moderator', 'facilitator', 'trainer', 'session_lead']),
  displayOrder: z.number().int().default(0),
  isPrimary: z.boolean().default(false),
});

export async function assignSessionPerson(sessionId: string, input: z.infer<typeof assignPersonSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = assignPersonSchema.parse(input);

  const { data, error } = await service.rpc('assign_session_person_transactional', {
    p_session_id: sessionId, p_person_id: parsed.personId, p_role: parsed.role,
    p_display_order: parsed.displayOrder, p_is_primary: parsed.isPrimary, p_updated_by: userId,
  });
  if (error) {
    console.error('assignSessionPerson: rpc failed', { sessionId, input: parsed, userId, error });
    throw translateSessionWriteError(error);
  }

  await writeAuditLog(service, { entityType: 'session_people', entityId: data.id, action: 'create', actorId: userId, newValues: { sessionId, ...parsed } });
  return { id: data.id };
}

export async function removeSessionPerson(sessionPeopleId: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { error } = await service.rpc('remove_session_person', { p_session_people_id: sessionPeopleId });
  if (error) {
    console.error('removeSessionPerson: rpc failed', { sessionPeopleId, userId, error });
    throw error;
  }
  await writeAuditLog(service, { entityType: 'session_people', entityId: sessionPeopleId, action: 'delete', actorId: userId });
  return { id: sessionPeopleId };
}

const combinedUpdateSchema = z.object({
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  roomId: z.string().uuid(),
  assignments: z.array(z.object({
    personId: z.string().uuid(),
    role: z.enum(['speaker', 'guest', 'moderator', 'facilitator', 'trainer', 'session_lead']),
    displayOrder: z.number().int().default(0),
    isPrimary: z.boolean().default(false),
  })),
});

export async function updateSessionScheduleAndAssignments(sessionId: string, input: z.infer<typeof combinedUpdateSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = combinedUpdateSchema.parse(input);

  const { data, error } = await service.rpc('update_session_and_assignments_transactional', {
    p_id: sessionId, p_start_time: parsed.startTime, p_end_time: parsed.endTime, p_room_id: parsed.roomId,
    p_updated_by: userId,
    p_new_assignments: parsed.assignments.map((a) => ({ person_id: a.personId, role: a.role, display_order: a.displayOrder, is_primary: a.isPrimary })),
  });
  if (error) {
    console.error('updateSessionScheduleAndAssignments: rpc failed', { sessionId, input: parsed, userId, error });
    throw translateSessionWriteError(error);
  }

  await writeAuditLog(service, { entityType: 'session', entityId: sessionId, action: 'update_schedule_and_assignments', actorId: userId, newValues: parsed });
  return { id: data.id };
}

const setTagsSchema = z.array(z.object({ tagId: z.string().uuid(), weight: z.number().min(0).max(1) }));

export async function setSessionTags(sessionId: string, tags: z.infer<typeof setTagsSchema>) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = setTagsSchema.parse(tags);

  const { error: deleteError } = await service.from('session_tags').delete().eq('session_id', sessionId);
  if (deleteError) throw deleteError;

  if (parsed.length > 0) {
    const { error: insertError } = await service.from('session_tags').insert(
      parsed.map((t) => ({ session_id: sessionId, tag_id: t.tagId, weight: t.weight, updated_by: userId }))
    );
    if (insertError) {
      console.error('setSessionTags: insert failed', { sessionId, tags: parsed, userId, error: insertError });
      throw insertError;
    }
  }

  await writeAuditLog(service, { entityType: 'session_tags', entityId: sessionId, action: 'update', actorId: userId, newValues: { tags: parsed } });
  return { sessionId };
}
```
Note: `setSessionTags`'s delete-then-insert is not wrapped in its own RPC — unlike the speaker-conflict scenario, there is no trigger-enforced invariant here that a two-step client-side delete+insert could violate mid-way (the `unique(session_id, tag_id)`/weight-range constraints are per-row and don't depend on the full set), so the simpler two-call approach is sufficient and consistent with how `assignReviewer` and similar simple writes work in Phase 2.

- [ ] **Step 3: Typecheck and lint**

```bash
npx tsc --noEmit
npm run lint
```

- [ ] **Step 4: Commit**

```bash
git add "src/app/[locale]/(admin)/agenda/sessions/[id]/actions.ts"
git commit -m "feat: add session-people assignment, combined-update, and tag server actions"
```

---

## Group C Checkpoint

```bash
npx tsc --noEmit
npm run lint
npm run test
npm run build
```

---

## Group D: Behavioral Test Suite (Task 14)

All 8 required scenarios, run against the live hosted Supabase project following the exact pattern established in `tests/rls/admission-review.test.ts` (real throwaway auth users, `beforeAll`/`afterAll` with `Promise.allSettled` cleanup guards).

### Task 14: The Full 8-Scenario Test Suite

**Files:**
- Create: `tests/agenda/conflict-and-validation.test.ts`
- Create: `tests/agenda/authorization.test.ts`

- [ ] **Step 1: Write `authorization.test.ts`** (Scenario 7 — unauthorized direct server-action calls)

```typescript
// tests/agenda/authorization.test.ts
//
// Verifies the role-check that gates every agenda server action
// (requireAgendaStaffCaller in src/lib/agenda/server-helpers.ts). Mirrors
// the logic-replication approach from Phase 2's admission-review
// authorization test — 'use server' functions can't be invoked outside a
// Next.js request context, so this exercises the same profiles.role lookup
// and rejection the real helper performs, against the live database with
// real authenticated users.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

async function isAuthorizedAgendaStaffCaller(userId: string): Promise<boolean> {
  const { data: profile, error } = await admin.from('profiles').select('role').eq('id', userId).single();
  if (error || !profile) return false;
  return profile.role === 'agenda_allocation_manager' || profile.role === 'super_admin';
}

let participantId: string;
let agendaStaffId: string;
let wrongRoleId: string; // registration_admission_manager — real staff, wrong module

beforeAll(async () => {
  const { data: participant } = await admin.auth.admin.createUser({ email: 'agenda-authz-participant@test.local', password: 'password123', email_confirm: true });
  const { data: staff } = await admin.auth.admin.createUser({ email: 'agenda-authz-staff@test.local', password: 'password123', email_confirm: true });
  const { data: wrongRole } = await admin.auth.admin.createUser({ email: 'agenda-authz-wrongrole@test.local', password: 'password123', email_confirm: true });
  participantId = participant.user!.id;
  agendaStaffId = staff.user!.id;
  wrongRoleId = wrongRole.user!.id;

  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', agendaStaffId);
  await admin.from('profiles').update({ role: 'registration_admission_manager' }).eq('id', wrongRoleId);
});

afterAll(async () => {
  await Promise.allSettled([
    participantId ? admin.auth.admin.deleteUser(participantId) : Promise.resolve(),
    agendaStaffId ? admin.auth.admin.deleteUser(agendaStaffId) : Promise.resolve(),
    wrongRoleId ? admin.auth.admin.deleteUser(wrongRoleId) : Promise.resolve(),
  ]);
});

describe('requireAgendaStaffCaller role check', () => {
  it('accepts agenda_allocation_manager', async () => {
    expect(await isAuthorizedAgendaStaffCaller(agendaStaffId)).toBe(true);
  });
  it('rejects a plain participant', async () => {
    expect(await isAuthorizedAgendaStaffCaller(participantId)).toBe(false);
  });
  it('rejects registration_admission_manager (real staff, wrong module)', async () => {
    expect(await isAuthorizedAgendaStaffCaller(wrongRoleId)).toBe(false);
  });
});
```

- [ ] **Step 2: Write `conflict-and-validation.test.ts` — shared setup and Scenarios 1–2 (room overlap)**

```typescript
// tests/agenda/conflict-and-validation.test.ts
//
// Covers the 8 required behavioral scenarios from the design spec's Testing
// Requirements. Runs against the live hosted Supabase project (see
// tests/rls/applications.test.ts for the Docker-unavailability rationale —
// NOT isolated from production data; not yet safe for CI gating).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

let staffUserId: string;
let dayId: string;
let otherDayId: string;
let trackId: string;
let sessionTypeId: string;
let roomId: string;
let smallRoomId: string;
let personAId: string;
let personBId: string;

beforeAll(async () => {
  const { data: staff } = await admin.auth.admin.createUser({ email: 'agenda-conflict-staff@test.local', password: 'password123', email_confirm: true });
  staffUserId = staff!.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffUserId);

  const { data: day } = await admin.from('conference_days').insert({ conference_date: '2026-11-10', label_ar: 'اليوم الأول', label_en: 'Day 1', display_order: 1 }).select('id').single();
  dayId = day!.id;
  const { data: day2 } = await admin.from('conference_days').insert({ conference_date: '2026-11-11', label_ar: 'اليوم الثاني', label_en: 'Day 2', display_order: 2 }).select('id').single();
  otherDayId = day2!.id;

  const { data: track } = await admin.from('tracks').insert({ code: 'TEST-TRACK', name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  const { data: sType } = await admin.from('session_types').insert({ code: 'TEST-TYPE', name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sType!.id;
  const { data: room } = await admin.from('rooms').insert({ code: 'TEST-ROOM', name_ar: 'قاعة', name_en: 'Room', capacity: 100 }).select('id').single();
  roomId = room!.id;
  const { data: smallRoom } = await admin.from('rooms').insert({ code: 'TEST-SMALL-ROOM', name_ar: 'قاعة صغيرة', name_en: 'Small Room', capacity: 10 }).select('id').single();
  smallRoomId = smallRoom!.id;

  const { data: pA } = await admin.from('people').insert({ full_name_ar: 'شخص أ', full_name_en: 'Person A' }).select('id').single();
  personAId = pA!.id;
  const { data: pB } = await admin.from('people').insert({ full_name_ar: 'شخص ب', full_name_en: 'Person B' }).select('id').single();
  personBId = pB!.id;
});

afterAll(async () => {
  await admin.from('sessions').delete().eq('track_id', trackId);
  await admin.from('people').delete().in('id', [personAId, personBId]);
  await admin.from('rooms').delete().in('id', [roomId, smallRoomId]);
  await admin.from('session_types').delete().eq('id', sessionTypeId);
  await admin.from('tracks').delete().eq('id', trackId);
  await admin.from('conference_days').delete().in('id', [dayId, otherDayId]);
  await Promise.allSettled([staffUserId ? admin.auth.admin.deleteUser(staffUserId) : Promise.resolve()]);
});

function baseSession(overrides: Partial<Database['public']['Tables']['sessions']['Insert']> = {}) {
  return {
    session_code: `TEST-${Math.random().toString(36).slice(2, 10)}`,
    title_ar: 'جلسة اختبار', title_en: 'Test Session',
    conference_day_id: dayId,
    start_time: '2026-11-10T09:00:00+04:00',
    end_time: '2026-11-10T10:00:00+04:00',
    track_id: trackId, session_type_id: sessionTypeId, room_id: roomId,
    language: 'en' as const, difficulty_level: 'beginner' as const,
    capacity: 20, min_capacity: 0,
    ...overrides,
  };
}

// clean up sessions created by each test so tests don't interfere with each other
afterEach ?? (() => {}); // placeholder removed below — see Step 3 for real afterEach

describe('Scenario 1: adjacent non-overlapping sessions in the same room', () => {
  it('both succeed', async () => {
    const { error: e1 } = await admin.from('sessions').insert(baseSession({
      start_time: '2026-11-10T09:00:00+04:00', end_time: '2026-11-10T10:00:00+04:00',
    }));
    expect(e1).toBeNull();
    const { error: e2 } = await admin.from('sessions').insert(baseSession({
      start_time: '2026-11-10T10:00:00+04:00', end_time: '2026-11-10T11:00:00+04:00',
    }));
    expect(e2).toBeNull();
  });
});

describe('Scenario 2: overlapping room bookings', () => {
  it('second insert fails with an exclusion violation', async () => {
    const { error: e1 } = await admin.from('sessions').insert(baseSession({
      start_time: '2026-11-10T11:00:00+04:00', end_time: '2026-11-10T12:00:00+04:00',
    }));
    expect(e1).toBeNull();
    const { error: e2 } = await admin.from('sessions').insert(baseSession({
      start_time: '2026-11-10T11:30:00+04:00', end_time: '2026-11-10T12:30:00+04:00',
    }));
    expect(e2).not.toBeNull();
    expect(e2?.code).toBe('23P01');
  });
});
```

- [ ] **Step 3: Add `afterEach` cleanup and Scenarios 3–8**

Replace the placeholder `afterEach` line with a real one, and append the remaining scenarios:

```typescript
afterEach(async () => {
  await admin.from('sessions').delete().eq('track_id', trackId);
});

describe('Scenario 3: speaker conflict created by changing an existing session\'s time', () => {
  it('rejects a reschedule that creates a new overlap for an assigned speaker', async () => {
    const { data: s1 } = await admin.from('sessions').insert(baseSession({
      start_time: '2026-11-10T09:00:00+04:00', end_time: '2026-11-10T10:00:00+04:00',
    })).select('id').single();
    const { data: s2 } = await admin.from('sessions').insert(baseSession({
      start_time: '2026-11-10T13:00:00+04:00', end_time: '2026-11-10T14:00:00+04:00',
    })).select('id').single();

    await admin.from('session_people').insert({ session_id: s1!.id, person_id: personAId, role: 'speaker' });
    await admin.from('session_people').insert({ session_id: s2!.id, person_id: personAId, role: 'speaker' });

    // Reschedule s2 to overlap s1 — should be rejected by
    // enforce_speaker_no_conflict_on_session_change.
    const { error } = await admin.from('sessions').update({
      start_time: '2026-11-10T09:30:00+04:00', end_time: '2026-11-10T10:30:00+04:00',
    }).eq('id', s2!.id);
    expect(error).not.toBeNull();
    expect(error?.message).toContain('conflict');
  });
});

describe('Scenario 4: mismatched conference day and timestamp', () => {
  it('rejects a session whose time does not match its conference_day_id', async () => {
    const { error } = await admin.from('sessions').insert(baseSession({
      conference_day_id: dayId, // 2026-11-10
      start_time: '2026-11-11T09:00:00+04:00', // wrong day
      end_time: '2026-11-11T10:00:00+04:00',
    }));
    expect(error).not.toBeNull();
    expect(error?.message).toContain('does not match');
  });

  it('rejects a session that spans across midnight into another day', async () => {
    const { error } = await admin.from('sessions').insert(baseSession({
      start_time: '2026-11-10T23:30:00+04:00',
      end_time: '2026-11-11T00:30:00+04:00',
    }));
    expect(error).not.toBeNull();
  });
});

describe('Scenario 5: room capacity reduction', () => {
  it('rejects reducing a room capacity below an existing active session\'s capacity', async () => {
    await admin.from('sessions').insert(baseSession({ room_id: smallRoomId, capacity: 10 }));
    const { error } = await admin.from('rooms').update({ capacity: 5 }).eq('id', smallRoomId);
    expect(error).not.toBeNull();
    expect(error?.message).toContain('exceed');
    await admin.from('rooms').update({ capacity: 10 }).eq('id', smallRoomId); // restore
  });

  it('allows reducing capacity when all active sessions still fit', async () => {
    const { error } = await admin.from('rooms').update({ capacity: 50 }).eq('id', roomId);
    expect(error).toBeNull();
    await admin.from('rooms').update({ capacity: 100 }).eq('id', roomId); // restore
  });
});

describe('Scenario 6: invalid status transitions', () => {
  it('rejects draft -> confirmed directly (must go through published)', async () => {
    const { data: s } = await admin.from('sessions').insert(baseSession()).select('id').single();
    const { error } = await admin.from('sessions').update({ status: 'confirmed' }).eq('id', s!.id);
    expect(error).not.toBeNull();
  });

  it('rejects cancelling without a cancellation_reason', async () => {
    const { data: s } = await admin.from('sessions').insert(baseSession()).select('id').single();
    const { error } = await admin.from('sessions').update({ status: 'cancelled' }).eq('id', s!.id);
    expect(error).not.toBeNull();
    expect(error?.message).toContain('reason');
  });

  it('rejects transitioning out of a terminal state', async () => {
    const { data: s } = await admin.from('sessions').insert(baseSession()).select('id').single();
    await admin.from('sessions').update({ status: 'cancelled', cancellation_reason: 'test' }).eq('id', s!.id);
    const { error } = await admin.from('sessions').update({ status: 'draft' }).eq('id', s!.id);
    expect(error).not.toBeNull();
  });

  it('allows the full valid path: draft -> published -> confirmed -> completed', async () => {
    const { data: s } = await admin.from('sessions').insert(baseSession()).select('id').single();
    const { error: e1 } = await admin.from('sessions').update({ status: 'published' }).eq('id', s!.id);
    expect(e1).toBeNull();
    const { error: e2 } = await admin.from('sessions').update({ status: 'confirmed' }).eq('id', s!.id);
    expect(e2).toBeNull();
    const { error: e3 } = await admin.from('sessions').update({ status: 'completed' }).eq('id', s!.id);
    expect(e3).toBeNull();
  });
});

describe('Scenario 8 (mandatory, per explicit user requirement): combined schedule + assignment update', () => {
  it('detects a conflict only visible in the final combined state, and rejects the entire operation atomically', async () => {
    // s1: 09:00-10:00, personB assigned.
    const { data: s1 } = await admin.from('sessions').insert(baseSession({
      start_time: '2026-11-10T09:00:00+04:00', end_time: '2026-11-10T10:00:00+04:00',
    })).select('id').single();
    await admin.from('session_people').insert({ session_id: s1!.id, person_id: personBId, role: 'speaker' });

    // s2: currently 13:00-14:00 (no conflict with s1), currently has no
    // assignments. The combined operation both reschedules s2 to overlap
    // s1's time AND assigns personB to s2 — a conflict that does not exist
    // before OR after either half of the change is considered alone (s2's
    // reschedule alone doesn't conflict, since s2 has no assignments yet;
    // assigning personB to s2 alone doesn't conflict, since s2's current
    // time doesn't overlap s1). Only the COMBINATION creates the conflict.
    const { data: s2 } = await admin.from('sessions').insert(baseSession({
      start_time: '2026-11-10T13:00:00+04:00', end_time: '2026-11-10T14:00:00+04:00',
    })).select('id').single();

    const { data: beforeCall } = await admin.from('sessions').select('start_time, end_time').eq('id', s2!.id).single();

    const { error } = await admin.rpc('update_session_and_assignments_transactional', {
      p_id: s2!.id,
      p_start_time: '2026-11-10T09:30:00+04:00', // now overlaps s1
      p_end_time: '2026-11-10T10:30:00+04:00',
      p_room_id: roomId,
      p_updated_by: staffUserId,
      p_new_assignments: [{ person_id: personBId, role: 'speaker', display_order: 0, is_primary: false }],
    });

    expect(error).not.toBeNull();
    expect(error?.message).toContain('conflict');

    // Verify the entire operation left no partial changes: s2's time must
    // be unchanged (the sessions UPDATE inside the RPC must have rolled
    // back), and s2 must have no session_people rows (the INSERTs inside
    // the same RPC must also have rolled back).
    const { data: afterCall } = await admin.from('sessions').select('start_time, end_time').eq('id', s2!.id).single();
    expect(afterCall?.start_time).toBe(beforeCall?.start_time);
    expect(afterCall?.end_time).toBe(beforeCall?.end_time);

    const { data: s2People } = await admin.from('session_people').select('id').eq('session_id', s2!.id);
    expect(s2People).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the full suite**

```bash
npm run test -- tests/agenda/
```
Expected: PASS, all scenarios (3 authorization + 14 conflict/validation tests across scenarios 1,2,3,4×2,5×2,6×4,8 = 14, plus the 3 authorization tests = 17 total — exact count may shift slightly during implementation if additional edge assertions are added, but every one of the 8 named scenarios from the design spec must have at least one passing test).

- [ ] **Step 5: Verify cleanup**

Query for any remaining `agenda-*@test.local` users and any remaining rows with `track_id`/`code` matching the test fixtures' `TEST-` prefixes — confirm zero, matching the cleanup-verification discipline established in Phase 2.

- [ ] **Step 6: Commit**

```bash
git add tests/agenda/
git commit -m "test: add full 8-scenario behavioral test suite for agenda conflict and validation rules"
```

---

## Group D Checkpoint

```bash
npx tsc --noEmit
npm run lint
npm run test
npm run build
```

---

## Group E: Admin UI (Tasks 15–17)

### Task 15: Reference-Entity List/Edit Pages

**Files:**
- Create: `src/app/[locale]/(admin)/agenda/page.tsx` (overview/dashboard linking to each sub-section)
- Create: `src/app/[locale]/(admin)/agenda/days/page.tsx`
- Create: `src/app/[locale]/(admin)/agenda/tracks/page.tsx`
- Create: `src/app/[locale]/(admin)/agenda/session-types/page.tsx`
- Create: `src/app/[locale]/(admin)/agenda/rooms/page.tsx`
- Create: `src/app/[locale]/(admin)/agenda/people/page.tsx`
- Create: `src/app/[locale]/(admin)/agenda/tags/page.tsx`

- [ ] **Step 1: Implement the overview page** — auth/role gate (mirrors Phase 2's `notFound()` pattern via `isAgendaStaffRole`), links to each of the 6 sub-sections plus the sessions list.

- [ ] **Step 2: Implement `rooms/page.tsx` as the representative full example** — same auth/role gate, service-role-client list query (service-role needed for the same reason Phase 2's list page needed it: reading other staff members' `updated_by`-attributed names, if displayed, would hit the same `profiles` self-read RLS gap — verify this against the live database the same way Phase 2 did, don't assume), a plain table listing all rooms (active and inactive, with an `is_active` badge), and inline create/edit forms calling the Task 11 server actions with `router.refresh()` on success, following Phase 2's `review-controls.tsx` client-component pattern.

- [ ] **Step 3: Implement the remaining 5 reference-entity pages following the identical shape** — `days`, `tracks`, `session-types`, `people` (slightly larger form — bilingual title/org/bio, photo path, linked profile picker), `tags`.

- [ ] **Step 4: Manual verification** — for each of the 6 pages: visit as agenda staff, confirm the list renders, confirm create/edit/deactivate/reactivate all work and `router.refresh()` reflects changes, confirm a `participant` and a `registration_admission_manager` (wrong-role staff) both get 404. Confirm unauthenticated redirects to `/log-in`.

- [ ] **Step 5: Typecheck, lint**

```bash
npx tsc --noEmit
npm run lint
```

- [ ] **Step 6: Commit** (one commit per page)

```bash
git add "src/app/[locale]/(admin)/agenda/page.tsx" && git commit -m "feat: add agenda module overview page"
git add "src/app/[locale]/(admin)/agenda/rooms/page.tsx" && git commit -m "feat: add rooms list/edit page"
git add "src/app/[locale]/(admin)/agenda/days/page.tsx" && git commit -m "feat: add conference days list/edit page"
git add "src/app/[locale]/(admin)/agenda/tracks/page.tsx" && git commit -m "feat: add tracks list/edit page"
git add "src/app/[locale]/(admin)/agenda/session-types/page.tsx" && git commit -m "feat: add session types list/edit page"
git add "src/app/[locale]/(admin)/agenda/people/page.tsx" && git commit -m "feat: add people list/edit page"
git add "src/app/[locale]/(admin)/agenda/tags/page.tsx" && git commit -m "feat: add tags list/edit page"
```

---

### Task 16: Sessions List Page

**Files:**
- Create: `src/app/[locale]/(admin)/agenda/sessions/page.tsx`

- [ ] **Step 1: Implement** — auth/role gate, filters (day, track, room, status — query-string based, following Phase 2's list-page pattern including its sanitization lesson for any free-text filter), a table listing session code, title, day, time, track, room, status, capacity. Link each row to its detail page.

- [ ] **Step 2: Manual verification, typecheck, lint** — same discipline as Task 15.

- [ ] **Step 3: Commit**

```bash
git add "src/app/[locale]/(admin)/agenda/sessions/page.tsx"
git commit -m "feat: add sessions list page with day/track/room/status filters"
```

---

### Task 17: Session Detail Page (Full Edit, Speaker/Tag Assignment, Status Controls)

**Files:**
- Create: `src/app/[locale]/(admin)/agenda/sessions/[id]/page.tsx`
- Create: `src/app/[locale]/(admin)/agenda/sessions/[id]/session-controls.tsx`

- [ ] **Step 1: Implement the server component page** — auth/role gate, fetch the session with all fields, fetch its `session_people` (joined to `people` for names), fetch its `session_tags` (joined to `tags`), fetch the full reference lists (days/tracks/session-types/rooms/people/tags) needed to populate the edit form's selects, compute `SESSION_VALID_TRANSITIONS[session.status]` for the status control.

- [ ] **Step 2: Implement `session-controls.tsx`** — client component with: full field edit form (calls `updateSession`), status transition control (calls `updateSessionStatus`, prompts for `cancellationReason` when targeting `cancelled`), speaker/guest assignment UI (add via `assignSessionPerson`, remove via `removeSessionPerson`, each independently — the combined-transaction RPC `updateSessionScheduleAndAssignments` is used only when the UI explicitly offers a single "reschedule and reassign" combined action, distinct from editing the two independently; if the UI design doesn't need that combined flow beyond what the test suite exercises, wire an explicit "Reschedule & Reassign" button that calls it as its own distinct affordance, rather than silently routing every independent change through it), tag weighting UI (calls `setSessionTags`).

- [ ] **Step 3: Manual verification** — create a throwaway session with speakers/tags, confirm all fields render and edit correctly, confirm invalid status transitions are rejected with a clear error, confirm assigning a conflicting speaker is rejected, confirm a `participant`/wrong-role staff member gets 404.

- [ ] **Step 4: Typecheck, lint**

```bash
npx tsc --noEmit
npm run lint
```

- [ ] **Step 5: Commit**

```bash
git add "src/app/[locale]/(admin)/agenda/sessions/[id]/page.tsx" "src/app/[locale]/(admin)/agenda/sessions/[id]/session-controls.tsx"
git commit -m "feat: add session detail page with edit, status, assignment, and tag controls"
```

---

## Group E Checkpoint (Final)

```bash
npx tsc --noEmit
npm run lint
npm run test
npm run build
```
Expected: all pass, with `/admin/agenda` and all its sub-routes appearing in the build output.

---

## Task 18: Full Test Suite Run and Final Verification

- [ ] **Step 1:** `npm run test` — expect all agenda tests plus every pre-existing Phase 1/2 test passing (no regression).
- [ ] **Step 2:** `npx tsc --noEmit` — clean.
- [ ] **Step 3:** `npm run lint` — clean.
- [ ] **Step 4:** `npm run build` — succeeds, all agenda routes present.
- [ ] **Step 5:** Fix any issues found, commit:
```bash
git add -A
git commit -m "chore: fix issues found in full-suite verification" --allow-empty
```

---

## Resolution of the Spec's Open Question

The design spec's one remaining Open Question — whether `conference_days.conference_date` needs an application-level sanity range beyond plain uniqueness (e.g. "must fall within the conference's overall date span") — is resolved as: **no additional range check.** Uniqueness alone (already enforced by the `conference_date unique` constraint, Task 1) is sufficient: an admin manually creates each conference day one at a time via `days/actions.ts`'s `createConferenceDay` (Task 11), so an out-of-range date is a data-entry mistake an admin would immediately notice on the days list page (Task 15) rather than a risk requiring a second layer of validation — the same reasoning already applied to not range-checking other admin-entered dates elsewhere in this codebase (e.g. Phase 1's `applications.birth_date` has no plausible-range check either).

---

## Out of Scope (confirmed non-goals, do not implement here)

- Clustering or automatic session allocation logic (`include_in_allocation`/`allocation_priority`/`session_tags.weight` are stored, not acted upon)
- Participant-facing schedule/agenda display
- QR code generation, scanning, or check-in enforcement (`enable_qr_checkin`/`checkin_opens_at`/`checkin_closes_at` are stored, not enforced against real check-in events)
- Attendance tracking
- Excel/CSV import of any agenda data
- Any background/scheduled job (sessions never auto-transition to `completed`)
- Access for any role other than `super_admin`/`agenda_allocation_manager`
