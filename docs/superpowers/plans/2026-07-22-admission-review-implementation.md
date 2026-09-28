# Admission Review Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `registration_admission_manager` staff dashboard for manually reviewing submitted conference applications — a paginated/filterable/searchable list, a detail view, and three actions (change status, assign reviewer, add note) — as specified in `docs/superpowers/specs/2026-07-22-admission-review-design.md`.

**Architecture:** Two new server-component pages under a new `(admin)` route group, three new server actions writing via the service-role client (mirroring Phase 1's `submitApplication`), one schema migration adding `assigned_reviewer_id` to `applications` and a new `application_notes` table, and one RLS migration adding the corresponding policies. Pages read via the RLS-respecting client; server actions write via the service-role client and enforce authorization with their own explicit role check (not RLS) — this asymmetry is deliberate and documented in the spec.

**Tech Stack:** Same as Phase 1 — Next.js App Router (`app/[locale]/...`), Supabase (Postgres/Auth/RLS), TypeScript, Tailwind, Vitest. Supabase CLI linked to the hosted project (ref `deukwztsmcnxxchrdrfo`); no local Docker available in this environment, so migrations apply via `npx supabase db push` and are verified via `npx supabase db query --linked` read-only queries, following the exact pattern established in Phase 1 Tasks 3–7.

---

## File Structure

```
supabase/migrations/
  <timestamp>_assigned_reviewer_and_notes.sql   (assigned_reviewer_id column, application_notes table, indexes)
  <timestamp>_admission_review_rls_policies.sql (new RLS policies)

src/types/
  database.ts                  (regenerated after the migrations above)

src/app/[locale]/(admin)/
  applications/
    page.tsx                  (list page: search, filter, paginate)
    [id]/
      page.tsx                (detail page: full read + staff controls)
      review-controls.tsx     (client component: status/reviewer dropdowns, notes form)
      actions.ts               (updateApplicationStatus, assignReviewer, addNote)

src/lib/validation/
  admission-review.ts          (Zod schemas: status transition input, note body)

tests/
  rls/
    admission-review.test.ts   (RLS behavioral tests, extends applications.test.ts pattern)
  validation/
    admission-review.test.ts   (Zod schema unit tests)
  server-actions/
    admission-review-authorization.test.ts  (direct test of the role-check gating the 3 actions)
```

**Responsibility notes:**
- `(admin)/applications/[id]/actions.ts` holds all three server actions together (unlike Phase 1's single-action `register/actions.ts`) since they're small, share the same role-check helper, and are only ever called from the detail page — splitting them into separate files would add indirection without benefit.
- `review-controls.tsx` is a separate client component from `[id]/page.tsx` (a server component) because the interactive controls (dropdowns, note form) need client-side state and event handlers, while the surrounding data fetch stays server-side — the same server-component-wraps-client-component split Phase 1 didn't need (its pages had no interactive controls beyond forms with their own dedicated pages) but this task does.
- `src/lib/validation/admission-review.ts` mirrors `src/lib/validation/registration.ts`'s role: the single source of truth for what a valid status transition input and note body look like, shared by both the server actions (defense-in-depth validation before hitting the DB) and any future client-side form validation.
- The two migrations are split by concern (schema vs. RLS) exactly like Phase 1 did (Tasks 4 and 6 were separate), so each is independently reviewable.
- `tests/server-actions/` is a new top-level test category (Phase 1 only had `tests/rls/` and `tests/validation/`) because this phase's server actions have an authorization property — the role check — that RLS tests structurally cannot verify (RLS is bypassed by the service-role client these actions use), so it needs its own direct test rather than fitting into either existing category.

---

## Task 1: Migration — `assigned_reviewer_id` Column and `application_notes` Table

**Files:**
- Create: `supabase/migrations/<timestamp>_assigned_reviewer_and_notes.sql` (use `npx supabase migration new assigned_reviewer_and_notes` to get the correct timestamp prefix — this repo's established convention since Phase 1 Task 3, not sequential `000N_` numbering)

- [ ] **Step 1: Write the migration**

```sql
-- One reviewer assignment per application. References profiles (not a separate
-- reviewers table) since any registration_admission_manager can be assigned.
alter table applications add column assigned_reviewer_id uuid references profiles(id);

create index applications_status_idx on applications (status);
create index applications_assigned_reviewer_idx on applications (assigned_reviewer_id);

-- Internal review notes. Deliberately separate from application_status_history:
-- notes are free-form, staff-authored commentary (append-only in this phase, no
-- edit/delete UI); application_status_history is the fixed-shape status-transition
-- audit log from Phase 1 and is not modified by this migration.
create table application_notes (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  author_id uuid not null references profiles(id),
  body text not null,
  created_at timestamptz not null default now()
);
```

- [ ] **Step 2: Apply migration to the linked cloud project**

Load env vars from `.env.local` (gitignored, do not print contents) and run `npx supabase db push` to apply to the linked project (ref `deukwztsmcnxxchrdrfo`).

- [ ] **Step 3: Verify on the live database**

Use `npx supabase db query --linked` (or equivalent read-only query mechanism) with READ-ONLY SELECTs only:
```sql
select column_name, data_type, is_nullable from information_schema.columns where table_name = 'applications' and column_name = 'assigned_reviewer_id';
select indexname from pg_indexes where tablename = 'applications';
select column_name, data_type, is_nullable from information_schema.columns where table_name = 'application_notes' order by ordinal_position;
```
Expected: `assigned_reviewer_id` exists as nullable `uuid`; `applications_status_idx` and `applications_assigned_reviewer_idx` both present alongside the pre-existing indexes; `application_notes` has exactly `id, application_id, author_id, body, created_at` with correct types/nullability (all `not null` except none — every column here is `not null` per the migration).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/<actual-filename>.sql
git commit -m "feat(db): add assigned_reviewer_id column and application_notes table"
```

---

## Task 2: Migration — RLS Policies for Admission Review

**Files:**
- Create: `supabase/migrations/<timestamp>_admission_review_rls_policies.sql`

- [ ] **Step 1: Write the migration**

Per the spec: the new `applications` UPDATE policy has **no `WITH CHECK`** clause (staff are trusted, mirrors `profiles_update_super_admin`'s precedent from Phase 1). Both this policy and `application_notes`'s INSERT policy are defense-in-depth — the actual write-authorization gate is each server action's own role check, since all three actions use the service-role client (Task 6). The `application_notes` SELECT policy, by contrast, genuinely is the operative gate for reads, since the detail page reads via the RLS-respecting client.

```sql
-- Staff can update status and reviewer assignment on any application. No WITH
-- CHECK: staff are a trusted role with legitimate latitude to set any valid
-- status (validated by the server action, not RLS) — same reasoning as
-- profiles_update_super_admin's WITH CHECK-less policy from Phase 1. This
-- policy is defense-in-depth; the server actions that actually perform these
-- writes use the service-role client and are gated by their own role check.
create policy applications_update_staff on applications
  for update using (current_user_role() in ('registration_admission_manager', 'super_admin'));

-- application_notes: staff can read and (defense-in-depth) insert. No
-- UPDATE/DELETE policy — no edit/delete UI in this phase, matches Phase 1's
-- default-deny pattern for application_status_history/email_log.
create policy application_notes_select_staff on application_notes
  for select using (current_user_role() in ('registration_admission_manager', 'super_admin'));

create policy application_notes_insert_staff on application_notes
  for insert with check (current_user_role() in ('registration_admission_manager', 'super_admin'));
```

- [ ] **Step 2: Apply migration**

Run: `npx supabase db push`
Expected: applies with no errors.

- [ ] **Step 3: Verify structurally (behavioral testing is Task 5's job)**

```sql
select policyname, tablename, cmd from pg_policies where schemaname = 'public' and tablename in ('applications', 'application_notes') order by tablename, policyname;
```
Expected: `applications` now shows 6 policies total (5 from Phase 1 plus `applications_update_staff`); `application_notes` shows exactly 2 policies (`application_notes_select_staff`, `application_notes_insert_staff`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/<actual-filename>.sql
git commit -m "feat(db): add RLS policies for staff application updates and notes"
```

---

## Task 3: Regenerate Supabase Database Types

**Files:**
- Modify: `src/types/database.ts` (regenerated, not hand-edited)

Phase 1's own generated types file (`src/types/database.ts`, added in Phase 1 Task 17) predates Task 1's schema changes and does not yet know about `assigned_reviewer_id` or `application_notes`. Every later task in this plan (validation, tests, server actions, both pages) writes TypeScript that references these new columns/tables through the typed Supabase client — none of it will typecheck without this step. Phase 1 hit this exact gap once already (see commit `7c0e0b7`); this task exists so Phase 2 doesn't repeat it.

- [ ] **Step 1: Regenerate types from the linked project**

```bash
npx supabase gen types typescript --linked > src/types/database.ts
```

- [ ] **Step 2: Verify the new schema objects are present**

```bash
grep -n "assigned_reviewer_id" src/types/database.ts
grep -n "application_notes" src/types/database.ts
```
Expected: both greps return matches (the column appears in the `applications` Row/Insert/Update types; `application_notes` appears as a full table entry).

- [ ] **Step 3: Verify no secrets were captured**

```bash
grep -iE "key|secret|password|token" src/types/database.ts
```
Expected: no matches, or only matches that are clearly schema/column names (e.g. a hypothetical `api_key` column), not literal credential values — generated type files are schema-only and contain no runtime secrets, but this is a cheap sanity check before committing.

- [ ] **Step 4: Commit**

```bash
git add src/types/database.ts
git commit -m "chore: regenerate Supabase types for assigned_reviewer_id and application_notes"
```

---

## Task 4: Validation Schemas

**Files:**
- Create: `src/lib/validation/admission-review.ts`
- Test: `tests/validation/admission-review.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/validation/admission-review.test.ts
import { describe, it, expect } from 'vitest';
import { statusTransitionSchema, noteBodySchema, VALID_TRANSITIONS } from '@/lib/validation/admission-review';

describe('statusTransitionSchema', () => {
  it('accepts a valid transition', () => {
    const result = statusTransitionSchema.safeParse({ from: 'submitted', to: 'under_review' });
    expect(result.success).toBe(true);
  });

  it('rejects a transition not in the state machine', () => {
    const result = statusTransitionSchema.safeParse({ from: 'submitted', to: 'accepted' });
    expect(result.success).toBe(false);
  });

  it('rejects draft as a target status', () => {
    const result = statusTransitionSchema.safeParse({ from: 'submitted', to: 'draft' });
    expect(result.success).toBe(false);
  });
});

describe('VALID_TRANSITIONS state machine', () => {
  it('allows all three decision states to reach each other directly', () => {
    expect(VALID_TRANSITIONS.accepted).toContain('rejected');
    expect(VALID_TRANSITIONS.accepted).toContain('waitlisted');
    expect(VALID_TRANSITIONS.rejected).toContain('accepted');
    expect(VALID_TRANSITIONS.rejected).toContain('waitlisted');
    expect(VALID_TRANSITIONS.waitlisted).toContain('accepted');
    expect(VALID_TRANSITIONS.waitlisted).toContain('rejected');
  });

  it('allows submitted and under_review to reach each other', () => {
    expect(VALID_TRANSITIONS.submitted).toContain('under_review');
    expect(VALID_TRANSITIONS.under_review).toContain('submitted');
  });

  it('never lists draft or withdrawn as a reachable target from any state', () => {
    for (const targets of Object.values(VALID_TRANSITIONS)) {
      expect(targets).not.toContain('draft');
      expect(targets).not.toContain('withdrawn');
    }
  });
});

describe('noteBodySchema', () => {
  it('rejects an empty body', () => {
    const result = noteBodySchema.safeParse({ body: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a whitespace-only body', () => {
    const result = noteBodySchema.safeParse({ body: '   \n  ' });
    expect(result.success).toBe(false);
  });

  it('accepts a real note', () => {
    const result = noteBodySchema.safeParse({ body: 'Looks good, strong policy background.' });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/validation/admission-review.test.ts`
Expected: FAIL — `Cannot find module '@/lib/validation/admission-review'`.

- [ ] **Step 3: Implement the schemas**

```typescript
// src/lib/validation/admission-review.ts
import { z } from 'zod';

export const APPLICATION_STATUSES = [
  'draft', 'submitted', 'under_review', 'accepted', 'waitlisted', 'rejected', 'withdrawn',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

// The full status state machine from the design spec. draft and withdrawn are
// never a valid target from any state reachable through this dashboard —
// draft is pre-submission, withdrawn has no UI path anywhere in the app yet.
export const VALID_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  draft: [],
  submitted: ['under_review'],
  under_review: ['submitted', 'accepted', 'waitlisted', 'rejected'],
  accepted: ['waitlisted', 'rejected'],
  waitlisted: ['accepted', 'rejected'],
  rejected: ['accepted', 'waitlisted'],
  withdrawn: [],
};

export const statusTransitionSchema = z
  .object({
    from: z.enum(APPLICATION_STATUSES),
    to: z.enum(APPLICATION_STATUSES),
  })
  .refine((data) => VALID_TRANSITIONS[data.from]?.includes(data.to), {
    message: 'This status transition is not permitted',
    path: ['to'],
  });

export const noteBodySchema = z.object({
  body: z.string().trim().min(1, 'Note cannot be empty'),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- tests/validation/admission-review.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/admission-review.ts tests/validation/admission-review.test.ts
git commit -m "feat: add validation schemas for status transitions and notes"
```

---

## Task 5: RLS Behavioral Tests

**Files:**
- Create: `tests/rls/admission-review.test.ts`

This follows the exact pattern of `tests/rls/applications.test.ts` from Phase 1 — real authenticated sessions against the live hosted project, not local Docker. Read that file first for the setup/teardown pattern (service-role user creation, `signInWithPassword`, `afterAll` cleanup guarded against partial `beforeAll` failure).

- [ ] **Step 1: Write the test**

```typescript
// tests/rls/admission-review.test.ts
//
// Runs against the live/hosted Supabase project (see tests/rls/applications.test.ts
// for the full rationale — Docker is unavailable in this environment). Creates and
// cleans up its own throwaway users and one throwaway application per run.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient<Database>(URL, SERVICE_KEY);

let applicantId: string;
let staffId: string;       // registration_admission_manager
let wrongRoleId: string;   // agenda_allocation_manager — should be denied
let applicationId: string;
let clientApplicant: ReturnType<typeof createClient<Database>>;
let clientStaff: ReturnType<typeof createClient<Database>>;
let clientWrongRole: ReturnType<typeof createClient<Database>>;

beforeAll(async () => {
  const { data: applicant } = await admin.auth.admin.createUser({
    email: 'admission-review-applicant@test.local',
    password: 'password123',
    email_confirm: true,
  });
  const { data: staff } = await admin.auth.admin.createUser({
    email: 'admission-review-staff@test.local',
    password: 'password123',
    email_confirm: true,
  });
  const { data: wrongRole } = await admin.auth.admin.createUser({
    email: 'admission-review-wrongrole@test.local',
    password: 'password123',
    email_confirm: true,
  });
  applicantId = applicant.user!.id;
  staffId = staff.user!.id;
  wrongRoleId = wrongRole.user!.id;

  await admin.from('profiles').update({ role: 'registration_admission_manager' }).eq('id', staffId);
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', wrongRoleId);

  const { data: application } = await admin
    .from('applications')
    .insert({ applicant_id: applicantId, status: 'submitted' })
    .select('id')
    .single();
  applicationId = application!.id;

  clientApplicant = createClient<Database>(URL, ANON_KEY);
  await clientApplicant.auth.signInWithPassword({ email: 'admission-review-applicant@test.local', password: 'password123' });

  clientStaff = createClient<Database>(URL, ANON_KEY);
  await clientStaff.auth.signInWithPassword({ email: 'admission-review-staff@test.local', password: 'password123' });

  clientWrongRole = createClient<Database>(URL, ANON_KEY);
  await clientWrongRole.auth.signInWithPassword({ email: 'admission-review-wrongrole@test.local', password: 'password123' });
});

afterAll(async () => {
  await Promise.allSettled([
    applicantId ? admin.auth.admin.deleteUser(applicantId) : Promise.resolve(),
    staffId ? admin.auth.admin.deleteUser(staffId) : Promise.resolve(),
    wrongRoleId ? admin.auth.admin.deleteUser(wrongRoleId) : Promise.resolve(),
  ]);
});

describe('applications RLS — staff update policy', () => {
  it('registration_admission_manager can update status on any application', async () => {
    const { error } = await clientStaff
      .from('applications')
      .update({ status: 'under_review' })
      .eq('id', applicationId);
    expect(error).toBeNull();
    const { data } = await clientStaff.from('applications').select('status').eq('id', applicationId).single();
    expect(data?.status).toBe('under_review');
  });

  it('agenda_allocation_manager (wrong staff role) cannot update status', async () => {
    const { error } = await clientWrongRole
      .from('applications')
      .update({ status: 'accepted' })
      .eq('id', applicationId);
    // RLS silently affects zero rows rather than erroring; verify via re-query.
    const { data } = await clientWrongRole.from('applications').select('status').eq('id', applicationId).single();
    expect(data?.status).not.toBe('accepted');
  });

  it('applicant cannot update their own submitted application via this policy', async () => {
    await clientApplicant
      .from('applications')
      .update({ status: 'accepted' })
      .eq('id', applicationId);
    const { data } = await clientStaff.from('applications').select('status').eq('id', applicationId).single();
    expect(data?.status).not.toBe('accepted');
  });
});

describe('application_notes RLS', () => {
  it('registration_admission_manager can insert and read notes', async () => {
    const { error: insertError } = await clientStaff.from('application_notes').insert({
      application_id: applicationId,
      author_id: staffId,
      body: 'RLS test note',
    });
    expect(insertError).toBeNull();

    const { data, error } = await clientStaff.from('application_notes').select('*').eq('application_id', applicationId);
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThanOrEqual(1);
  });

  it('agenda_allocation_manager cannot read notes', async () => {
    const { data } = await clientWrongRole.from('application_notes').select('*').eq('application_id', applicationId);
    expect(data).toEqual([]);
  });

  it('applicant cannot read notes on their own application', async () => {
    const { data } = await clientApplicant.from('application_notes').select('*').eq('application_id', applicationId);
    expect(data).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npm run test -- tests/rls/admission-review.test.ts`
Expected: PASS, 6 tests, all against the live hosted project. Confirm cleanup afterward by re-checking (via a quick manual query or trusting the `afterAll` cascade delete, same as Phase 1's pattern) that no `admission-review-*@test.local` users remain.

- [ ] **Step 3: Commit**

```bash
git add tests/rls/admission-review.test.ts
git commit -m "test: verify admission review RLS policies against the hosted project"
```

---

## Task 6: Server Actions

**Files:**
- Create: `src/app/[locale]/(admin)/applications/[id]/actions.ts`

This is the security-critical task — these three actions write via the service-role client and are gated by their own role check, not RLS (per the spec). Read `src/app/[locale]/(participant)/register/actions.ts` first as the reference pattern for structure, error logging, and the optimistic-concurrency guard style.

- [ ] **Step 1: Implement the actions**

```typescript
// src/app/[locale]/(admin)/applications/[id]/actions.ts
'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { statusTransitionSchema, noteBodySchema, type ApplicationStatus } from '@/lib/validation/admission-review';

async function requireStaffCaller() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (error || !profile) throw new Error('Profile not found');
  if (profile.role !== 'registration_admission_manager' && profile.role !== 'super_admin') {
    throw new Error('Not authorized');
  }

  return { userId: user.id, service };
}

export async function updateApplicationStatus(applicationId: string, newStatus: ApplicationStatus) {
  const { userId, service } = await requireStaffCaller();

  const { data: application, error: fetchError } = await service
    .from('applications')
    .select('status')
    .eq('id', applicationId)
    .single();
  if (fetchError || !application) throw new Error('Application not found');

  const oldStatus = application.status as ApplicationStatus;
  const transitionCheck = statusTransitionSchema.safeParse({ from: oldStatus, to: newStatus });
  if (!transitionCheck.success) {
    throw new Error(`Cannot transition from ${oldStatus} to ${newStatus}`);
  }

  // Re-check the fetched status on the write itself and require exactly one
  // affected row — closes the read-then-write race between two staff members
  // concurrently transitioning the same application (same pattern as
  // submitApplication's draft->submitted guard).
  const { data: updatedRows, error: updateError } = await service
    .from('applications')
    .update({ status: newStatus })
    .eq('id', applicationId)
    .eq('status', oldStatus)
    .select('id');
  if (updateError) {
    console.error('updateApplicationStatus: failed to update application', { applicationId, userId, error: updateError });
    throw updateError;
  }
  if (!updatedRows || updatedRows.length === 0) {
    throw new Error('Application status changed by someone else, please refresh');
  }

  const { error: historyError } = await service.from('application_status_history').insert({
    application_id: applicationId,
    old_status: oldStatus,
    new_status: newStatus,
    changed_by: userId,
    note: 'Status changed by reviewer',
  });
  if (historyError) {
    console.error('updateApplicationStatus: status updated but history insert failed', { applicationId, userId, error: historyError });
  }

  return { status: newStatus };
}

export async function assignReviewer(applicationId: string, reviewerId: string | null) {
  const { service } = await requireStaffCaller();

  if (reviewerId !== null) {
    const { data: reviewerProfile, error: reviewerError } = await service
      .from('profiles')
      .select('role')
      .eq('id', reviewerId)
      .single();
    if (reviewerError || !reviewerProfile) throw new Error('Reviewer not found');
    if (reviewerProfile.role !== 'registration_admission_manager' && reviewerProfile.role !== 'super_admin') {
      throw new Error('Target user is not an authorized reviewer');
    }
  }

  const { error } = await service
    .from('applications')
    .update({ assigned_reviewer_id: reviewerId })
    .eq('id', applicationId);
  if (error) {
    console.error('assignReviewer: failed to update assignment', { applicationId, reviewerId, error });
    throw error;
  }

  return { assignedReviewerId: reviewerId };
}

export async function addNote(applicationId: string, body: string) {
  const { userId, service } = await requireStaffCaller();

  const parsed = noteBodySchema.safeParse({ body });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid note');

  const { error } = await service.from('application_notes').insert({
    application_id: applicationId,
    author_id: userId,
    body: parsed.data.body,
  });
  if (error) {
    console.error('addNote: failed to insert note', { applicationId, userId, error });
    throw error;
  }

  return { success: true };
}
```

- [ ] **Step 2: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Automated test — role-check enforcement (this is the spec's most emphasized testing requirement)**

The spec explicitly requires this be tested directly, not inferred from the RLS tests: *"a test calling `updateApplicationStatus`/`assignReviewer`/`addNote` as an authenticated `participant` or `agenda_allocation_manager` must confirm the action itself rejects the call, not rely on RLS tests to prove this."* This matters because all three actions use the service-role client, which bypasses RLS — so `requireStaffCaller()`'s own role check is the only thing standing between an unauthorized caller and a write, and that specific logic needs its own regression test.

Server actions can't be imported and invoked directly outside a Next.js request context (`'use server'` functions depend on framework-managed request scoping — same constraint Phase 1 documented for `submitApplication` in Task 14 of the Phase 1 plan). So this test exercises `requireStaffCaller`'s underlying logic — the same `profiles.role` lookup and rejection the real function performs — against the live database with real authenticated users, following the exact verification pattern Phase 1 used for `submitApplication` (replicate the action's real Supabase call sequence, not a mock).

Create `tests/server-actions/admission-review-authorization.test.ts`:

```typescript
// tests/server-actions/admission-review-authorization.test.ts
//
// Verifies the role-check that gates updateApplicationStatus/assignReviewer/
// addNote (src/app/[locale]/(admin)/applications/[id]/actions.ts). These
// actions write via the service-role client and bypass RLS, so this check —
// not RLS — is the actual authorization gate; it needs its own direct test
// per the design spec's explicit testing requirement.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient<Database>(URL, SERVICE_KEY);

// Mirrors requireStaffCaller's exact check from actions.ts.
async function isAuthorizedStaffCaller(userId: string): Promise<boolean> {
  const { data: profile, error } = await admin.from('profiles').select('role').eq('id', userId).single();
  if (error || !profile) return false;
  return profile.role === 'registration_admission_manager' || profile.role === 'super_admin';
}

let participantId: string;
let staffId: string;
let wrongRoleId: string;

beforeAll(async () => {
  const { data: participant } = await admin.auth.admin.createUser({
    email: 'authz-participant@test.local', password: 'password123', email_confirm: true,
  });
  const { data: staff } = await admin.auth.admin.createUser({
    email: 'authz-staff@test.local', password: 'password123', email_confirm: true,
  });
  const { data: wrongRole } = await admin.auth.admin.createUser({
    email: 'authz-wrongrole@test.local', password: 'password123', email_confirm: true,
  });
  participantId = participant.user!.id;
  staffId = staff.user!.id;
  wrongRoleId = wrongRole.user!.id;

  await admin.from('profiles').update({ role: 'registration_admission_manager' }).eq('id', staffId);
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', wrongRoleId);
});

afterAll(async () => {
  await Promise.allSettled([
    participantId ? admin.auth.admin.deleteUser(participantId) : Promise.resolve(),
    staffId ? admin.auth.admin.deleteUser(staffId) : Promise.resolve(),
    wrongRoleId ? admin.auth.admin.deleteUser(wrongRoleId) : Promise.resolve(),
  ]);
});

describe('requireStaffCaller role check', () => {
  it('accepts registration_admission_manager', async () => {
    expect(await isAuthorizedStaffCaller(staffId)).toBe(true);
  });

  it('rejects a plain participant', async () => {
    expect(await isAuthorizedStaffCaller(participantId)).toBe(false);
  });

  it('rejects agenda_allocation_manager (a real staff role, but not an admission reviewer)', async () => {
    expect(await isAuthorizedStaffCaller(wrongRoleId)).toBe(false);
  });
});
```

Run: `npm run test -- tests/server-actions/admission-review-authorization.test.ts`
Expected: PASS, 3 tests, against the live hosted project.

*(Note for implementer: if at implementation time you find a way to genuinely import and invoke the real `'use server'` functions from a test — e.g. a newer Next.js/Vitest integration makes this practical — prefer that over the logic-replication approach above, since it tests the actual shipped code rather than a parallel implementation of its logic. Only fall back to replication if direct invocation isn't practical, and say so in the commit message, mirroring how Phase 1 handled this same tradeoff.)*

- [ ] **Step 4: Manual verification against the live database**

Using a throwaway staff user and application (same pattern as prior tasks' manual verification — create via service-role client, exercise, clean up):
1. Call `updateApplicationStatus` through a valid transition (e.g. `submitted` → `under_review`) — confirm status updates and exactly one `application_status_history` row is inserted with `changed_by` set to the staff user's id.
2. Call `updateApplicationStatus` with an invalid transition (e.g. `submitted` → `accepted`) — confirm it throws and no DB write occurs.
3. Call `assignReviewer` with a valid `registration_admission_manager` id — confirm `assigned_reviewer_id` updates.
4. Call `assignReviewer` with a `participant`'s id — confirm it throws "Target user is not an authorized reviewer".
5. Call `addNote` with an empty string — confirm it throws. Call it with real text — confirm the row appears.

Clean up all test users/applications afterward.

- [ ] **Step 5: Commit**

```bash
git add "src/app/[locale]/(admin)/applications/[id]/actions.ts" "tests/server-actions/admission-review-authorization.test.ts"
git commit -m "feat: add status/reviewer/note server actions for admission review"
```

---

## Task 7: List Page

**Files:**
- Create: `src/app/[locale]/(admin)/applications/page.tsx`

- [ ] **Step 1: Implement the list page**

```tsx
// src/app/[locale]/(admin)/applications/page.tsx
import { getLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

const PAGE_SIZE = 50;

export default async function ApplicationsListPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string; reviewer?: string; q?: string }>;
}) {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || (profile.role !== 'registration_admission_manager' && profile.role !== 'super_admin')) {
    notFound();
  }

  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from('applications')
    .select('id, application_number, status, submitted_at, country, applicant_id, assigned_reviewer_id, profiles!applications_applicant_id_fkey(full_name, email)', { count: 'exact' })
    .neq('status', 'draft')
    .order('submitted_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, to);

  if (params.status) query = query.eq('status', params.status);
  if (params.reviewer) query = query.eq('assigned_reviewer_id', params.reviewer);
  if (params.q) {
    query = query.or(
      `full_name.ilike.%${params.q}%,email.ilike.%${params.q}%`,
      { referencedTable: 'profiles' }
    );
  }

  const { data: applications, count } = await query;

  return (
    <div>
      <h1>Applications</h1>
      <table>
        <thead>
          <tr>
            <th>Application #</th>
            <th>Name</th>
            <th>Email</th>
            <th>Country</th>
            <th>Status</th>
            <th>Reviewer</th>
            <th>Submitted</th>
          </tr>
        </thead>
        <tbody>
          {applications?.map((app) => (
            <tr key={app.id}>
              <td><a href={`applications/${app.id}`}>{app.application_number}</a></td>
              <td>{(app.profiles as any)?.full_name}</td>
              <td>{(app.profiles as any)?.email}</td>
              <td>{app.country}</td>
              <td>{app.status}</td>
              <td>{app.assigned_reviewer_id ?? '—'}</td>
              <td>{app.submitted_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Page {page} of {Math.ceil((count ?? 0) / PAGE_SIZE)}</p>
    </div>
  );
}
```

*(Note for implementer: the country/email search-column split in the spec — `ilike` against `profiles.full_name`, `profiles.email`, and `applications.country` — requires an `.or()` across a joined table plus the base table. Supabase-js's `.or()` with `referencedTable` only covers one table per call; if a single free-text box needs to search all three columns simultaneously, this may need two separate queries unioned, or restructuring the search UI into per-field inputs. Verify the exact `.or()` behavior against the installed `@supabase/supabase-js` version during implementation and adjust — this is a known rough edge, not a design defect, and the plan's snippet above is a starting point that may need adjustment once you see the real query behavior.)*

- [ ] **Step 2: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: no new errors (some `as any` casts on the joined `profiles` relation are expected here since the generated `Database` types don't model ad-hoc joins — acceptable for this phase, consistent with the codebase's existing tolerance for `any` at Supabase join boundaries).

- [ ] **Step 3: Manual verification**

Using a throwaway staff user and a few throwaway applications with different statuses/countries (create via service-role client): visit the list page (via dev server + curl with a real session cookie, following the pattern established in Phase 1 Task 15's verification), confirm the table renders, confirm `?status=under_review` filters correctly, confirm `?q=<name fragment>` narrows results, confirm pagination math is correct with more than `PAGE_SIZE` rows (or verify the query/count logic directly against a smaller threshold if creating 50+ rows isn't practical — use judgment). Confirm a `participant` account hitting this URL gets a 404. Clean up test data afterward.

- [ ] **Step 4: Commit**

```bash
git add "src/app/[locale]/(admin)/applications/page.tsx"
git commit -m "feat: add admission review list page with search/filter/pagination"
```

---

## Task 8: Detail Page

**Files:**
- Create: `src/app/[locale]/(admin)/applications/[id]/page.tsx`

- [ ] **Step 1: Implement the detail page**

```tsx
// src/app/[locale]/(admin)/applications/[id]/page.tsx
import { getLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { VALID_TRANSITIONS, type ApplicationStatus } from '@/lib/validation/admission-review';
import ReviewControls from './review-controls';

export default async function ApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const locale = await getLocale();
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || (profile.role !== 'registration_admission_manager' && profile.role !== 'super_admin')) {
    notFound();
  }

  const { data: application } = await supabase
    .from('applications')
    .select('*, profiles!applications_applicant_id_fkey(full_name, email)')
    .eq('id', id)
    .neq('status', 'draft') // spec non-goal: draft applications never appear in this dashboard,
    // including via direct navigation to a draft's id — the list page already excludes
    // drafts, but RLS alone doesn't (applications_select_staff grants staff read access
    // to all applications regardless of status), so the query itself must exclude it too.
    .single();
  if (!application) notFound();

  const { data: notes } = await supabase
    .from('application_notes')
    .select('*, profiles!application_notes_author_id_fkey(full_name)')
    .eq('application_id', id)
    .order('created_at', { ascending: false });

  const { data: reviewers } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in('role', ['registration_admission_manager', 'super_admin']);

  const validNextStatuses = VALID_TRANSITIONS[application.status as ApplicationStatus] ?? [];

  return (
    <div>
      <h1>{application.application_number}</h1>
      <p>Status: {application.status}</p>
      {/* Render every personal-info and conference-info field from the applications
          row here (phone, country, nationality, interests, experience_level, etc. —
          the full field list is in supabase/migrations/20260721202027_applications_table.sql).
          Omitted from this snippet for brevity, following the same pattern Task 13
          of the Phase 1 plan used for its own "omitted for brevity" fields. */}
      <ReviewControls
        applicationId={application.id}
        currentStatus={application.status}
        validNextStatuses={validNextStatuses}
        assignedReviewerId={application.assigned_reviewer_id}
        reviewers={reviewers ?? []}
        notes={notes ?? []}
      />
    </div>
  );
}
```

- [ ] **Step 2: Implement the client-side controls component**

```tsx
// src/app/[locale]/(admin)/applications/[id]/review-controls.tsx
'use client';

import { useState } from 'react';
import { useRouter } from '@/i18n/routing';
import { updateApplicationStatus, assignReviewer, addNote } from './actions';
import type { ApplicationStatus } from '@/lib/validation/admission-review';

type Reviewer = { id: string; full_name: string };
type Note = { id: string; body: string; created_at: string; profiles: { full_name: string } | null };

export default function ReviewControls({
  applicationId,
  currentStatus,
  validNextStatuses,
  assignedReviewerId,
  reviewers,
  notes,
}: {
  applicationId: string;
  currentStatus: string;
  validNextStatuses: ApplicationStatus[];
  assignedReviewerId: string | null;
  reviewers: Reviewer[];
  notes: Note[];
}) {
  const router = useRouter();
  const [noteBody, setNoteBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleStatusChange(newStatus: string) {
    setError(null);
    try {
      await updateApplicationStatus(applicationId, newStatus as ApplicationStatus);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
    }
  }

  async function handleReviewerChange(reviewerId: string) {
    setError(null);
    try {
      await assignReviewer(applicationId, reviewerId || null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign reviewer');
    }
  }

  async function handleAddNote(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await addNote(applicationId, noteBody);
      setNoteBody('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add note');
    }
  }

  return (
    <div>
      {error && <p role="alert">{error}</p>}

      <select value="" onChange={(e) => e.target.value && handleStatusChange(e.target.value)}>
        <option value="">Change status ({currentStatus})...</option>
        {validNextStatuses.map((status) => (
          <option key={status} value={status}>{status}</option>
        ))}
      </select>

      <select value={assignedReviewerId ?? ''} onChange={(e) => handleReviewerChange(e.target.value)}>
        <option value="">Unassigned</option>
        {reviewers.map((r) => (
          <option key={r.id} value={r.id}>{r.full_name}</option>
        ))}
      </select>

      <form onSubmit={handleAddNote}>
        <textarea value={noteBody} onChange={(e) => setNoteBody(e.target.value)} placeholder="Add a note" />
        <button type="submit">Add Note</button>
      </form>

      <ul>
        {notes.map((note) => (
          <li key={note.id}>
            <p>{note.body}</p>
            <p>{note.profiles?.full_name} — {note.created_at}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Manual verification**

Using a throwaway staff user and application (create via service-role client): visit the detail page, confirm all application fields render, confirm the status dropdown only offers valid next states for the current status, confirm changing status/assigning a reviewer/adding a note all work and `router.refresh()` reflects the change, confirm a `participant` account hitting this URL gets a 404. Clean up afterward.

- [ ] **Step 5: Commit**

```bash
git add "src/app/[locale]/(admin)/applications/[id]/page.tsx" "src/app/[locale]/(admin)/applications/[id]/review-controls.tsx"
git commit -m "feat: add admission review detail page with status/reviewer/notes controls"
```

---

## Task 9: Full Test Suite Run

- [ ] **Step 1: Run all tests**

Run: `npm run test`
Expected: all tests pass, including the new `tests/rls/admission-review.test.ts`, `tests/validation/admission-review.test.ts`, and `tests/server-actions/admission-review-authorization.test.ts` alongside the existing Phase 1 suites.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Run production build**

Run: `npm run build`
Expected: succeeds, new `(admin)/applications` and `(admin)/applications/[id]` routes appear in the build output alongside Phase 1's routes.

- [ ] **Step 5: Fix any issues found, commit**

```bash
git add -A
git commit -m "chore: fix issues found in full-suite verification" --allow-empty
```

---

## Out of Scope (confirmed non-goals, do not implement here)

- Excel/CSV bulk import or export
- Bulk accept/reject actions
- Automatic decision emails on status change
- Clustering, session allocation, or any post-admission phase
- Access for any role other than `registration_admission_manager`/`super_admin`
- Setting `withdrawn` from this dashboard
- Reviewer-assignment history/audit trail (only current assignment is tracked)
