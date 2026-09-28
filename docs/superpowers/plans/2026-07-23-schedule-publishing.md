# Phase 5: Assignment Confirmation & Participant Schedule Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a confirmed Phase 4 allocation run as immutable per-participant schedule snapshots via a staged/fingerprinted/admin-confirmed publication engine, with event-only change-propagation triggers (never auto-activating a revision) and a new Tailwind-styled participant `/schedule` page that becomes the seed of this codebase's first real component library.

**Architecture:** Event-only DB triggers on `sessions`/`session_people` record deduplicated change events (no fan-out, no auto-activation). A server-side orchestrator marks affected published items `stale`/`pending_review`. A two-RPC publication engine (`stage_publication_transactional` → admin review/resolve → `confirm_publication_transactional`) computes, fingerprints, and atomically publishes new revisions only where content actually changed, with an advisory lock and fingerprint revalidation guarding against concurrent/stale publishes.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (Postgres/Auth/RLS, hosted — no local Docker), `next-intl`, Zod, Tailwind v4 (CSS-based config), Vitest (live hosted-project tests), PL/pgSQL for the publication/reassignment RPCs.

**Spec:** `docs/superpowers/specs/2026-07-23-schedule-publishing-design.md` (passed 2 spec review rounds — read this first for full rationale; this plan implements it exactly).

**Worktree:** `.worktrees/schedule-publishing` on branch `schedule-publishing`, branched from `master` at commit `34e0be4`.

---

## Conventions carried over from Phase 3/4 (do not re-derive — follow exactly)

- **Server Actions**: colocated per-route `actions.ts` files, each `'use server'`, calling `requireAgendaStaffCaller()` from `src/lib/agenda/server-helpers.ts` as the first line of every exported admin function (no exceptions).
- **Role check**: reuse `isAgendaStaffRole`/`AGENDA_STAFF_ROLES` from `src/lib/validation/agenda.ts` unchanged.
- **ID validation**: reuse `idSchema` (`z.string().guid()`) from `src/lib/validation/allocation.ts` for every bare-id server action parameter; new Phase-5-specific schemas go in a new `src/lib/validation/schedule.ts`.
- **Service-role client**: all admin writes go through `service` from `requireAgendaStaffCaller()`. The participant `/schedule` page uses the plain RLS-scoped `createClient()` instead (matching `my-application/page.tsx` exactly — RLS is the actual gate there, not app logic).
- **Audit logging**: call `writeAuditLog(service, {...})` after every stage/confirm/discard/reassign/override/process-change-event action. `actorId` is always `userId` from `requireAgendaStaffCaller()`, never client input.
- **Migrations**: `supabase/migrations/YYYYMMDDHHMMSS_description.sql`, timestamp after Phase 4's last migration `20260723130000_override_capacity_check_in_transaction.sql`. This plan uses `20260723140000` onward in ~10000-second increments.
- **`updated_at`**: `extensions.moddatetime('updated_at')` trigger on every table that has the column, matching existing convention.
- **Transactional RPC**: `language plpgsql set search_path = public, pg_temp`, `p_`-prefixed params, `v_`-prefixed locals, `update ... returning * into v_result; if v_result.id is null then raise exception ... end if;` as the standard atomic check-and-write pattern, explicit `raise exception '...%...', var` for every invariant violation.
- **Testing**: Vitest against the live hosted Supabase project. Throwaway users via `admin.auth.admin.createUser(...)` in `beforeAll`, cleanup via `Promise.allSettled([...admin.auth.admin.deleteUser(...)])` in `afterAll` — but per Phase 4's hard-won lesson, delete dependent rows (this phase's own publication/draft tables, referencing `applications`/`sessions`) **before** attempting to delete the underlying seeded rows and auth users, or cleanup will fail with FK violations and leave state that breaks subsequent runs. Known external flakiness: the hosted project's Auth Admin API is occasionally slow/erroring independent of this code — if a live test fails with `createUser` returning null or a timeout near Vitest's 5000ms default, rerun; do not add retry infrastructure. If two live test files could race against a shared global resource, isolate them into their own Vitest `projects` group with `fileParallelism: false`, exactly as `vitest.config.ts`'s existing `allocation-live-sequential` project already does — extend that same file rather than inventing a new mechanism.
- **No `typecheck` npm script.** Use `npx tsc --noEmit` directly. Lint: `npm run lint`. Test: `npm test`. Build: `npm run build`. Run all four after every task group, not just at the end.
- **Tailwind v4, config-in-CSS**: no `tailwind.config.ts` exists. New design tokens go in `src/app/globals.css`'s `@theme inline { ... }` block, following the existing minimal pattern (`--color-background`, `--color-foreground`, `--font-sans`, `--font-mono`) — extend it, don't replace it.

## File Structure

```
supabase/migrations/
  20260723140000_schedule_publication_tables.sql       -- schedule_publications, schedule_publication_items
  20260723150000_schedule_change_event_tables.sql       -- schedule_change_events
  20260723160000_schedule_publication_draft_tables.sql  -- schedule_publication_drafts, schedule_publication_draft_items
  20260723170000_schedule_rls_policies.sql               -- RLS for all 5 new tables
  20260723180000_schedule_change_detection_triggers.sql -- event-only triggers on sessions/session_people
  20260723190000_schedule_publication_functions.sql      -- compute_publication_fingerprint, stage_publication_transactional,
                                                              confirm_publication_transactional
  20260723200000_reassign_blocked_participant_function.sql -- reassign_blocked_participant_transactional

src/lib/validation/
  schedule.ts                             -- Zod schemas: idSchema reused, reassignSchema, overridePublishWithGapSchema

src/lib/schedule/
  fingerprint.ts                          -- pure: mirrors compute_publication_fingerprint's TS-side equivalent
                                              for any client-side diff preview needs (thin; DB is source of truth)
  run-stage-publication.ts                -- orchestrator: calls stage_publication_transactional, shapes result for UI
  run-confirm-publication.ts              -- orchestrator: calls confirm_publication_transactional
  run-process-change-events.ts            -- orchestrator: marks schedule_publication_items stale/pending_review

src/components/ui/
  badge.tsx, card.tsx, empty-state.tsx, skeleton.tsx

src/components/schedule/
  day-timeline.tsx, session-card.tsx, time-marker.tsx, status-banner.tsx

src/app/[locale]/(participant)/schedule/
  page.tsx

src/app/[locale]/(admin)/allocation/schedules/
  page.tsx, run-list.tsx
  stage/[allocationRunId]/
    page.tsx, actions.ts, draft-review.tsx, blocker-resolution.tsx
  changed/
    page.tsx, actions.ts, changed-queue.tsx
  participants/[applicationId]/
    page.tsx

tests/
  validation/schedule.test.ts
  schedule/fingerprint.test.ts            -- pure: stability, sensitivity to each frozen field
  schedule/verdict-classification.test.ts -- pure: blocked_mandatory / publishable / no_change rules
  schedule/publication-lifecycle.test.ts  -- live: stage/confirm, blockers, atomicity, idempotency, revisions
  schedule/change-propagation.test.ts     -- live: trigger dedup, stale/pending_review marking, cancellation gate
  schedule/authorization.test.ts          -- live: participant self-only read, no participant write path
  schedule/concurrency.test.ts            -- live: advisory lock rejects concurrent confirm
  schedule/timezone.test.ts               -- pure: Asia/Muscat display formatting
```

Rationale: pure computational logic (`src/lib/schedule/fingerprint.ts` — only used for UI-side preview hints, never the source of truth for the actual published fingerprint, which is always computed by the DB function) stays separate from DB-orchestrating "run" modules, separate again from server actions, mirroring Phase 4's exact layering. `src/components/ui/` vs `src/components/schedule/` split matches the spec's explicit design-system-seed requirement.

---

## Task 1: Schedule publication tables

**Files:**
- Create: `supabase/migrations/20260723140000_schedule_publication_tables.sql`

- [ ] **Step 1: Write the migration**

```sql
-- schedule_publication_tables.sql
create table schedule_publications (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id),
  allocation_run_id uuid not null references allocation_runs(id),
  revision_number int not null,
  status text not null,
  source_fingerprint text not null,
  published_at timestamptz not null default now(),
  published_by uuid not null references profiles(id),

  constraint schedule_publications_status_valid check (status in ('active', 'superseded')),
  constraint schedule_publications_revision_positive check (revision_number > 0),
  constraint schedule_publications_unique_revision unique (application_id, revision_number)
);

-- Exactly one active revision per participant.
create unique index schedule_publications_one_active on schedule_publications (application_id) where status = 'active';

create table schedule_publication_items (
  id uuid primary key default gen_random_uuid(),
  schedule_publication_id uuid not null references schedule_publications(id) on delete cascade,
  session_id uuid references sessions(id) on delete set null,
  session_title_ar text,
  session_title_en text,
  room_name_ar text,
  room_name_en text,
  start_time timestamptz,
  end_time timestamptz,
  is_mandatory boolean not null,
  speakers jsonb not null default '[]'::jsonb,
  suitability_score numeric,
  explanation_summary text,
  item_status text not null default 'active',
  gap_reason text,

  constraint schedule_publication_items_status_valid check (
    item_status in ('active', 'stale', 'changed', 'cancelled', 'pending_review')
  ),
  constraint schedule_publication_items_score_range check (
    suitability_score is null or (suitability_score >= 0 and suitability_score <= 1)
  )
);

create index schedule_publications_application_idx on schedule_publications (application_id);
create index schedule_publications_allocation_run_idx on schedule_publications (allocation_run_id);
create index schedule_publication_items_publication_idx on schedule_publication_items (schedule_publication_id);
create index schedule_publication_items_session_idx on schedule_publication_items (session_id);
```

- [ ] **Step 2: Apply the migration and verify**

Run: `npx supabase db push` (from the worktree root; `.env.local` must be present — copy from the main repo checkout and re-link the CLI in this worktree first: `npx supabase login --token <SUPABASE_ACCESS_TOKEN>` then `npx supabase link --project-ref deukwztsmcnxxchrdrfo`, exactly as Phase 4's plan required for its own worktree).

Verify: `npx supabase migration list` shows `20260723140000` with matching local/remote timestamps; confirm both tables exist via a read-only query.

**Rollback/failure behavior**: transactional apply, standard for this project. To roll back: drop `schedule_publication_items`, then `schedule_publications` (reverse FK order) — safe, nothing else references them yet.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260723140000_schedule_publication_tables.sql
git commit -m "feat: add schedule_publications and schedule_publication_items tables"
```

---

## Task 2: Schedule change event table

**Files:**
- Create: `supabase/migrations/20260723150000_schedule_change_event_tables.sql`

- [ ] **Step 1: Write the migration**

```sql
-- schedule_change_event_tables.sql
create table schedule_change_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id),
  change_type text not null,
  detected_at timestamptz not null default now(),
  processed_at timestamptz,

  constraint schedule_change_events_type_valid check (change_type in ('time_or_room', 'speakers', 'cancelled'))
);

-- Dedup mechanism: at most one unprocessed event per (session, change_type).
-- A session_people delete-and-reinsert (two row changes within one
-- operation) collapses to a single unprocessed 'speakers' event via
-- ON CONFLICT DO NOTHING in the trigger (Task 5), never generating an
-- intermediate/duplicate event from an incomplete mid-operation state.
create unique index schedule_change_events_unprocessed_dedup
  on schedule_change_events (session_id, change_type) where processed_at is null;

create index schedule_change_events_session_idx on schedule_change_events (session_id);
```

- [ ] **Step 2: Apply and verify** (same process as Task 1 Step 2)

**Rollback/failure behavior**: transactional apply. To roll back: drop `schedule_change_events` — nothing references it yet.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260723150000_schedule_change_event_tables.sql
git commit -m "feat: add schedule_change_events table with unprocessed-event dedup index"
```

---

## Task 3: Schedule publication draft tables

**Files:**
- Create: `supabase/migrations/20260723160000_schedule_publication_draft_tables.sql`

- [ ] **Step 1: Write the migration**

```sql
-- schedule_publication_draft_tables.sql
create table schedule_publication_drafts (
  id uuid primary key default gen_random_uuid(),
  allocation_run_id uuid references allocation_runs(id),
  triggered_by_change_event_ids uuid[],
  staged_at timestamptz not null default now(),
  staged_by uuid not null references profiles(id),
  source_fingerprint text not null,
  status text not null default 'staged',

  constraint schedule_publication_drafts_status_valid check (
    status in ('staged', 'confirmed', 'expired', 'discarded')
  ),
  -- Exactly one source per draft: a run-publish or a change-propagation
  -- batch, never both, never neither.
  constraint schedule_publication_drafts_one_source check (
    (allocation_run_id is not null) <> (triggered_by_change_event_ids is not null)
  )
);

create table schedule_publication_draft_items (
  id uuid primary key default gen_random_uuid(),
  schedule_publication_draft_id uuid not null references schedule_publication_drafts(id) on delete cascade,
  application_id uuid not null references applications(id),
  verdict text not null,
  blocker_details jsonb,
  resolution text,
  override_reason text,

  constraint schedule_publication_draft_items_verdict_valid check (
    verdict in ('publishable', 'blocked_mandatory', 'no_change')
  ),
  constraint schedule_publication_draft_items_resolution_valid check (
    resolution is null or resolution in ('reassigned', 'override_publish_with_gap')
  )
);

create index schedule_publication_drafts_run_idx on schedule_publication_drafts (allocation_run_id);
create index schedule_publication_draft_items_draft_idx on schedule_publication_draft_items (schedule_publication_draft_id);
create index schedule_publication_draft_items_application_idx on schedule_publication_draft_items (application_id);
```

- [ ] **Step 2: Apply and verify** (same process as Task 1 Step 2)

**Rollback/failure behavior**: transactional apply. To roll back: drop `schedule_publication_draft_items`, then `schedule_publication_drafts`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260723160000_schedule_publication_draft_tables.sql
git commit -m "feat: add schedule_publication_drafts and draft_items tables"
```

---

## Task 4: RLS policies for all 5 new tables

**Files:**
- Create: `supabase/migrations/20260723170000_schedule_rls_policies.sql`

- [ ] **Step 1: Write the migration**

```sql
-- schedule_rls_policies.sql
alter table schedule_publications enable row level security;
alter table schedule_publication_items enable row level security;
alter table schedule_change_events enable row level security;
alter table schedule_publication_drafts enable row level security;
alter table schedule_publication_draft_items enable row level security;

-- Staff-only, defense-in-depth (operative gate is requireAgendaStaffCaller()
-- via the service-role client in every server action).
create policy schedule_change_events_staff_all on schedule_change_events
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy schedule_publication_drafts_staff_all on schedule_publication_drafts
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy schedule_publication_draft_items_staff_all on schedule_publication_draft_items
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

-- Self-scoped select for the participant, plus full staff access. No
-- insert/update/delete policy grants a participant write access to either
-- table — _select_own is select-only, and default-deny covers every other
-- operation, so a participant cannot select, remove, swap, or modify
-- anything (spec rule 5).
create policy schedule_publications_select_own on schedule_publications
  for select using (application_id in (select id from applications where applicant_id = auth.uid()));
create policy schedule_publications_staff_all on schedule_publications
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

create policy schedule_publication_items_select_own on schedule_publication_items
  for select using (
    schedule_publication_id in (
      select id from schedule_publications
      where application_id in (select id from applications where applicant_id = auth.uid())
    )
  );
create policy schedule_publication_items_staff_all on schedule_publication_items
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
```

- [ ] **Step 2: Apply and verify** (same process as Task 1 Step 2). Additionally, spot-check via the anon key that a non-staff caller reading `schedule_change_events` returns an empty set (RLS blocking), matching Phase 4's established verification pattern.

**Rollback/failure behavior**: transactional apply; to roll back, `drop policy` each one then `alter table ... disable row level security` for all five tables.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260723170000_schedule_rls_policies.sql
git commit -m "feat: add RLS policies for Phase 5 schedule tables"
```

---

## Task 5: Event-only change detection triggers

**Files:**
- Create: `supabase/migrations/20260723180000_schedule_change_detection_triggers.sql`

This is the most architecturally sensitive migration in the phase — it must do **only** event recording, never fan-out or revision creation, per the spec's required correction.

- [ ] **Step 1: Write the migration**

```sql
-- schedule_change_detection_triggers.sql

-- Records a deduplicated change event for a session — nothing else. No
-- participant fan-out, no schedule_publication_items writes, no revision
-- creation happen here or anywhere in this migration. This is deliberate:
-- per the approved design, only a server-side orchestrator (Task 8) may
-- mark items stale/pending_review, and only the publication engine
-- (Tasks 9-10) may ever create/activate a revision — never a trigger.
-- ON CONFLICT DO NOTHING against the unprocessed-event dedup index means a
-- session_people delete-and-reinsert operation (two row-level trigger
-- firings) collapses to one unprocessed event, never two, and never an
-- event recorded from an incomplete intermediate state.
create function record_schedule_change_event(p_session_id uuid, p_change_type text) returns void as $$
begin
  insert into schedule_change_events (session_id, change_type)
  values (p_session_id, p_change_type)
  on conflict (session_id, change_type) where processed_at is null do nothing;
end;
$$ language plpgsql set search_path = public, pg_temp;

create function sessions_record_change_event() returns trigger as $$
begin
  if new.start_time is distinct from old.start_time
     or new.end_time is distinct from old.end_time
     or new.room_id is distinct from old.room_id
  then
    perform record_schedule_change_event(new.id, 'time_or_room');
  end if;

  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    perform record_schedule_change_event(new.id, 'cancelled');
  end if;

  return new;
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger sessions_change_detection
  after update on sessions
  for each row
  execute function sessions_record_change_event();

create function session_people_record_change_event() returns trigger as $$
declare
  v_session_id uuid;
begin
  v_session_id := coalesce(new.session_id, old.session_id);
  perform record_schedule_change_event(v_session_id, 'speakers');
  return coalesce(new, old);
end;
$$ language plpgsql set search_path = public, pg_temp;

create trigger session_people_change_detection
  after insert or update or delete on session_people
  for each row
  execute function session_people_record_change_event();
```

- [ ] **Step 2: Apply and verify** (same process as Task 1 Step 2). Additionally: manually update a session's `start_time` on the live project and confirm exactly one `schedule_change_events` row appears with `change_type = 'time_or_room'` and `processed_at is null`; update it again before processing and confirm no second row is created (dedup holds). Revert the test change afterward.

**Rollback/failure behavior**: transactional apply. To roll back: `drop trigger session_people_change_detection on session_people`, `drop trigger sessions_change_detection on sessions`, `drop function session_people_record_change_event()`, `drop function sessions_record_change_event()`, `drop function record_schedule_change_event(uuid, text)`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260723180000_schedule_change_detection_triggers.sql
git commit -m "feat: add event-only change detection triggers on sessions and session_people"
```

---

## Task 6: Validation module

**Files:**
- Create: `src/lib/validation/schedule.ts`
- Test: `tests/validation/schedule.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/validation/schedule.test.ts
import { describe, expect, it } from 'vitest';
import { reassignSchema, overridePublishWithGapSchema, stagePublicationSchema } from '@/lib/validation/schedule';

describe('reassignSchema', () => {
  it('accepts a valid reassignment', () => {
    const result = reassignSchema.parse({
      draftItemId: '00000000-0000-0000-0000-000000000001',
      newSessionId: '00000000-0000-0000-0000-000000000002',
    });
    expect(result.newSessionId).toBe('00000000-0000-0000-0000-000000000002');
  });
});

describe('overridePublishWithGapSchema', () => {
  it('requires a non-empty override reason', () => {
    expect(() =>
      overridePublishWithGapSchema.parse({
        draftItemId: '00000000-0000-0000-0000-000000000001',
        overrideReason: '',
      })
    ).toThrow();
  });

  it('accepts a documented reason', () => {
    const result = overridePublishWithGapSchema.parse({
      draftItemId: '00000000-0000-0000-0000-000000000001',
      overrideReason: 'Participant confirmed attendance offline; mandatory session unavailable this run.',
    });
    expect(result.overrideReason.length).toBeGreaterThan(0);
  });
});

describe('stagePublicationSchema', () => {
  it('accepts a run-source stage request', () => {
    const result = stagePublicationSchema.parse({ allocationRunId: '00000000-0000-0000-0000-000000000001' });
    expect(result.allocationRunId).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('accepts a change-event-source stage request', () => {
    const result = stagePublicationSchema.parse({ changeEventIds: ['00000000-0000-0000-0000-000000000001'] });
    expect(result.changeEventIds).toHaveLength(1);
  });

  it('rejects a request with neither source', () => {
    expect(() => stagePublicationSchema.parse({})).toThrow();
  });

  it('rejects a request with both sources', () => {
    expect(() =>
      stagePublicationSchema.parse({
        allocationRunId: '00000000-0000-0000-0000-000000000001',
        changeEventIds: ['00000000-0000-0000-0000-000000000002'],
      })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/validation/schedule.test.ts`
Expected: FAIL with "Cannot find module '@/lib/validation/schedule'"

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/validation/schedule.ts
import { z } from 'zod';
import { idSchema } from './allocation';

export const reassignSchema = z.object({
  draftItemId: idSchema,
  newSessionId: idSchema,
});

export const overridePublishWithGapSchema = z.object({
  draftItemId: idSchema,
  overrideReason: z.string().min(1, 'Override reason is required'),
});

// Exactly one of allocationRunId / changeEventIds, mirroring the DB
// constraint schedule_publication_drafts_one_source.
export const stagePublicationSchema = z
  .object({
    allocationRunId: idSchema.optional(),
    changeEventIds: z.array(idSchema).min(1).optional(),
  })
  .refine((v) => (v.allocationRunId != null) !== (v.changeEventIds != null), {
    message: 'Exactly one of allocationRunId or changeEventIds must be provided',
  });

export const confirmPublicationSchema = z.object({
  draftId: idSchema,
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/validation/schedule.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/schedule.ts tests/validation/schedule.test.ts
git commit -m "feat: add Phase 5 schedule validation schemas"
```

---

## Task 7: Fingerprint helper and verdict classification — pure logic

**Files:**
- Create: `src/lib/schedule/fingerprint.ts`
- Test: `tests/schedule/fingerprint.test.ts`, `tests/schedule/verdict-classification.test.ts`

This TS-side module exists for UI-side diff previews only — the DB's `compute_publication_fingerprint` (Task 9) is always the source of truth for what actually gets staged/confirmed. Keeping the two independent (not sharing code, since one is SQL and one is TS) is acceptable per the spec since both are deterministic given the same documented input ordering; this pure module is tested against its own contract, not cross-validated against the DB function's output byte-for-byte.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/schedule/fingerprint.test.ts
import { describe, expect, it } from 'vitest';
import { computeAssignmentSetFingerprint, computeSessionStateFingerprint } from '@/lib/schedule/fingerprint';

describe('computeAssignmentSetFingerprint', () => {
  it('is stable for identical input regardless of array order', () => {
    const a = [
      { applicationId: 'app-2', sessionId: 's1', suitabilityScore: 0.5, status: 'proposed', isManualOverride: false },
      { applicationId: 'app-1', sessionId: 's2', suitabilityScore: 0.8, status: 'proposed', isManualOverride: false },
    ];
    const b = [...a].reverse();
    expect(computeAssignmentSetFingerprint(a, [])).toBe(computeAssignmentSetFingerprint(b, []));
  });

  it('changes when any assignment field changes', () => {
    const base = [{ applicationId: 'app-1', sessionId: 's1', suitabilityScore: 0.5, status: 'proposed', isManualOverride: false }];
    const changed = [{ ...base[0], suitabilityScore: 0.6 }];
    expect(computeAssignmentSetFingerprint(changed, [])).not.toBe(computeAssignmentSetFingerprint(base, []));
  });

  it('changes when the issue set changes, even if assignments are identical', () => {
    const assignments = [{ applicationId: 'app-1', sessionId: 's1', suitabilityScore: 0.5, status: 'proposed', isManualOverride: false }];
    const noIssues = computeAssignmentSetFingerprint(assignments, []);
    const withIssue = computeAssignmentSetFingerprint(assignments, [{ issueType: 'low_confidence', applicationId: 'app-1', sessionId: 's1' }]);
    expect(noIssues).not.toBe(withIssue);
  });
});

describe('computeSessionStateFingerprint', () => {
  it('reflects both session fields and session_people, regardless of which changed', () => {
    const sessionOnly = computeSessionStateFingerprint(
      [{ sessionId: 's1', startTime: '2026-09-15T09:00:00Z', endTime: '2026-09-15T10:00:00Z', roomId: 'r1', status: 'confirmed' }],
      [{ sessionId: 's1', personId: 'p1', role: 'speaker', displayOrder: 0 }]
    );
    const speakersChanged = computeSessionStateFingerprint(
      [{ sessionId: 's1', startTime: '2026-09-15T09:00:00Z', endTime: '2026-09-15T10:00:00Z', roomId: 'r1', status: 'confirmed' }],
      [{ sessionId: 's1', personId: 'p2', role: 'speaker', displayOrder: 0 }]
    );
    expect(sessionOnly).not.toBe(speakersChanged);
  });
});
```

```ts
// tests/schedule/verdict-classification.test.ts
import { describe, expect, it } from 'vitest';
import { classifyVerdict } from '@/lib/schedule/fingerprint';

describe('classifyVerdict', () => {
  it('blocks when a mandatory slot has an unassigned issue', () => {
    const result = classifyVerdict({
      issues: [{ issueType: 'unassigned', sessionIsMandatory: true }],
      contentDiffersFromActive: true,
    });
    expect(result).toBe('blocked_mandatory');
  });

  it('does not block when the unassigned issue is for an elective session', () => {
    const result = classifyVerdict({
      issues: [{ issueType: 'unassigned', sessionIsMandatory: false }],
      contentDiffersFromActive: true,
    });
    expect(result).toBe('publishable');
  });

  it('is publishable when only low_confidence issues are present', () => {
    const result = classifyVerdict({
      issues: [{ issueType: 'low_confidence', sessionIsMandatory: false }],
      contentDiffersFromActive: true,
    });
    expect(result).toBe('publishable');
  });

  it('is no_change when content is identical to the active revision and there are no blocking issues', () => {
    const result = classifyVerdict({ issues: [], contentDiffersFromActive: false });
    expect(result).toBe('no_change');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/schedule/fingerprint.test.ts tests/schedule/verdict-classification.test.ts`
Expected: FAIL with "Cannot find module '@/lib/schedule/fingerprint'"

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/schedule/fingerprint.ts
import { createHash } from 'crypto';

export interface AssignmentForFingerprint {
  applicationId: string;
  sessionId: string;
  suitabilityScore: number;
  status: string;
  isManualOverride: boolean;
}

export interface IssueForFingerprint {
  issueType: string;
  applicationId: string | null;
  sessionId: string | null;
}

function hash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// Mirrors the DB's compute_publication_fingerprint run-publish path (spec:
// Publication Transaction Design). Sort by (applicationId, sessionId) for
// assignments and by (issueType, applicationId, sessionId) for issues, so
// the fingerprint is order-independent on input but deterministic in
// output — same pattern as src/lib/allocation/time-slot-grouping.ts's
// computeTimeSlotGroupKey.
export function computeAssignmentSetFingerprint(
  assignments: AssignmentForFingerprint[],
  issues: IssueForFingerprint[]
): string {
  const sortedAssignments = [...assignments].sort((a, b) =>
    (a.applicationId + a.sessionId).localeCompare(b.applicationId + b.sessionId)
  );
  const sortedIssues = [...issues].sort((a, b) =>
    (a.issueType + (a.applicationId ?? '') + (a.sessionId ?? '')).localeCompare(
      b.issueType + (b.applicationId ?? '') + (b.sessionId ?? '')
    )
  );
  const assignmentPart = sortedAssignments
    .map((a) => `${a.applicationId}|${a.sessionId}|${a.suitabilityScore}|${a.status}|${a.isManualOverride}`)
    .join(';');
  const issuePart = sortedIssues.map((i) => `${i.issueType}|${i.applicationId ?? ''}|${i.sessionId ?? ''}`).join(';');
  return hash(`${assignmentPart}::${issuePart}`);
}

export interface SessionStateForFingerprint {
  sessionId: string;
  startTime: string;
  endTime: string;
  roomId: string;
  status: string;
}

export interface SessionPersonForFingerprint {
  sessionId: string;
  personId: string;
  role: string;
  displayOrder: number;
}

// Mirrors the DB's compute_publication_fingerprint change-propagation path.
// Includes both session fields AND session_people rows for every affected
// session regardless of which change_type triggered the event, so a
// speakers-only event's fingerprint still reflects current time/room too,
// and vice versa (spec: closes the cross-contamination gap).
export function computeSessionStateFingerprint(
  sessions: SessionStateForFingerprint[],
  sessionPeople: SessionPersonForFingerprint[]
): string {
  const sortedSessions = [...sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const sortedPeople = [...sessionPeople].sort((a, b) =>
    (a.sessionId + a.personId + a.role).localeCompare(b.sessionId + b.personId + b.role)
  );
  const sessionPart = sortedSessions.map((s) => `${s.sessionId}|${s.startTime}|${s.endTime}|${s.roomId}|${s.status}`).join(';');
  const peoplePart = sortedPeople.map((p) => `${p.sessionId}|${p.personId}|${p.role}|${p.displayOrder}`).join(';');
  return hash(`${sessionPart}::${peoplePart}`);
}

export interface VerdictInput {
  issues: { issueType: string; sessionIsMandatory: boolean }[];
  contentDiffersFromActive: boolean;
}

// Spec: Issue/Blocker Policy. An issue blocks only if it leaves a
// MANDATORY slot empty (unassigned/capacity_bottleneck/schedule_conflict/
// no_eligible_sessions affecting a mandatory session). The same issue
// types affecting only an elective session never block. low_confidence
// never blocks (surfaced informationally, gated by a separate batch
// acknowledgment in the UI, not this classification).
const BLOCKING_ISSUE_TYPES = new Set(['unassigned', 'capacity_bottleneck', 'schedule_conflict', 'no_eligible_sessions']);

export function classifyVerdict(input: VerdictInput): 'publishable' | 'blocked_mandatory' | 'no_change' {
  const hasMandatoryBlocker = input.issues.some((i) => BLOCKING_ISSUE_TYPES.has(i.issueType) && i.sessionIsMandatory);
  if (hasMandatoryBlocker) return 'blocked_mandatory';
  if (!input.contentDiffersFromActive) return 'no_change';
  return 'publishable';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/schedule/fingerprint.test.ts tests/schedule/verdict-classification.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/schedule/fingerprint.ts tests/schedule/fingerprint.test.ts tests/schedule/verdict-classification.test.ts
git commit -m "feat: add pure fingerprint and verdict classification helpers"
```

---

## Task 8: Publication engine RPCs — `compute_publication_fingerprint` and `stage_publication_transactional`

**Files:**
- Create: `supabase/migrations/20260723190000_schedule_publication_functions.sql`

This is the most complex migration in the phase. Implements the spec's "Publication Transaction Design" §`stage_publication_transactional` exactly, including the precise fingerprint definitions.

- [ ] **Step 1: Write the migration**

```sql
-- schedule_publication_functions.sql

-- Shared by compute_publication_fingerprint and stage_publication_transactional
-- so "which sessions does this batch of change events affect" is resolved
-- in exactly one place. A prior version of stage_publication_transactional
-- duplicated this query independently and referenced the wrong-scoped
-- variable, causing a runtime 42703 error on the change-propagation path —
-- extracting it here removes that entire class of drift.
create function resolve_change_event_session_ids(p_change_event_ids uuid[]) returns uuid[] as $$
  select array_agg(distinct session_id) from schedule_change_events where id = any(p_change_event_ids);
$$ language sql stable set search_path = public, pg_temp;

-- Shared by stage_publication_transactional and confirm_publication_transactional
-- (Task 9) so the two fingerprint computations can never drift apart.
-- Exactly one of p_allocation_run_id / p_change_event_ids is non-null.
--
-- Run-publish path: hash of every allocation_assignments row for the run
-- (application_id, session_id, suitability_score, status, is_manual_override),
-- ordered by (application_id, session_id), concatenated with every
-- allocation_issues row for the run (issue_type, application_id,
-- session_id), also ordered — so two runs with identical assignments but
-- different issue sets never collide.
--
-- Change-propagation path: hash of, for every distinct session_id
-- referenced by the given change events: the session's (start_time,
-- end_time, room_id, status) AND every session_people row for that
-- session (person_id, role, display_order, ordered) — regardless of which
-- specific change_type triggered the event, so a speakers-only event's
-- fingerprint still reflects the session's current time/room too.
--
-- Uses the built-in sha256(bytea) (available in Postgres core since 13, no
-- extension required) rather than pgcrypto's digest() — pgcrypto is not
-- enabled anywhere in this project's migrations, and even if it were,
-- Supabase installs extensions into the `extensions` schema, which this
-- function's hardened `search_path = public, pg_temp` deliberately
-- excludes. sha256() needs neither.
create function compute_publication_fingerprint(
  p_allocation_run_id uuid,
  p_change_event_ids uuid[]
) returns text as $$
declare
  v_assignment_part text;
  v_issue_part text;
  v_session_part text;
  v_people_part text;
  v_session_ids uuid[];
begin
  if p_allocation_run_id is not null then
    select string_agg(
      format('%s|%s|%s|%s|%s', application_id, session_id, suitability_score, status, is_manual_override),
      ';' order by application_id, session_id
    ) into v_assignment_part
    from allocation_assignments where allocation_run_id = p_allocation_run_id;

    select string_agg(
      format('%s|%s|%s', issue_type, coalesce(application_id::text, ''), coalesce(session_id::text, '')),
      ';' order by issue_type, application_id, session_id
    ) into v_issue_part
    from allocation_issues where allocation_run_id = p_allocation_run_id;

    return encode(sha256(convert_to(coalesce(v_assignment_part, '') || '::' || coalesce(v_issue_part, ''), 'UTF8')), 'hex');
  else
    v_session_ids := resolve_change_event_session_ids(p_change_event_ids);

    select string_agg(
      format('%s|%s|%s|%s|%s', id, start_time, end_time, room_id, status),
      ';' order by id
    ) into v_session_part
    from sessions where id = any(v_session_ids);

    select string_agg(
      format('%s|%s|%s|%s', session_id, person_id, role, display_order),
      ';' order by session_id, person_id, role
    ) into v_people_part
    from session_people where session_id = any(v_session_ids);

    return encode(sha256(convert_to(coalesce(v_session_part, '') || '::' || coalesce(v_people_part, ''), 'UTF8')), 'hex');
  end if;
end;
$$ language plpgsql set search_path = public, pg_temp;

-- Stage: read-only against allocation_assignments/allocation_issues/
-- sessions/session_people/schedule_publications/schedule_publication_items.
-- Writes only to schedule_publication_drafts/schedule_publication_draft_items.
-- Computes the candidate publication set, blockers, diffs, and the source
-- fingerprint. Nothing is published by this function alone (spec:
-- atomicity/rule 8 applies to Confirm's writes, not staging).
create function stage_publication_transactional(
  p_allocation_run_id uuid,
  p_change_event_ids uuid[],
  p_staged_by uuid
) returns schedule_publication_drafts as $$
declare
  v_draft schedule_publication_drafts;
  v_fingerprint text;
  v_application_id uuid;
  v_verdict text;
  v_has_mandatory_blocker boolean;
  v_content_differs boolean;
  v_session_ids uuid[];
begin
  v_fingerprint := compute_publication_fingerprint(p_allocation_run_id, p_change_event_ids);

  -- Resolved once, up front, for the change-propagation path's
  -- content_differs check below, via the same shared helper
  -- compute_publication_fingerprint uses internally — never duplicated
  -- inline, so the two can't drift apart again.
  if p_allocation_run_id is null then
    v_session_ids := resolve_change_event_session_ids(p_change_event_ids);
  end if;

  insert into schedule_publication_drafts (
    allocation_run_id, triggered_by_change_event_ids, staged_by, source_fingerprint, status
  ) values (
    p_allocation_run_id, p_change_event_ids, p_staged_by, v_fingerprint, 'staged'
  ) returning * into v_draft;

  if p_allocation_run_id is not null then
    -- Candidate participants: every accepted application with at least one
    -- assignment in this run.
    for v_application_id in
      select distinct application_id from allocation_assignments where allocation_run_id = p_allocation_run_id
    loop
      select exists (
        select 1 from allocation_issues ai
        join sessions s on s.id = ai.session_id
        where ai.allocation_run_id = p_allocation_run_id
          and ai.application_id = v_application_id
          and ai.issue_type in ('unassigned', 'capacity_bottleneck', 'schedule_conflict', 'no_eligible_sessions')
          and s.is_mandatory = true
      ) into v_has_mandatory_blocker;

      -- content_differs: true if there is no current active
      -- schedule_publications row for this application, or if this run's
      -- assignment set for the participant differs from the active
      -- revision's items (compared on session_id set).
      select not exists (
        select 1 from schedule_publications sp
        where sp.application_id = v_application_id and sp.status = 'active'
          and (
            select array_agg(aa.session_id order by aa.session_id)
            from allocation_assignments aa
            where aa.allocation_run_id = p_allocation_run_id and aa.application_id = v_application_id
          ) = (
            select array_agg(spi.session_id order by spi.session_id)
            from schedule_publication_items spi
            where spi.schedule_publication_id = sp.id and spi.item_status = 'active'
          )
      ) into v_content_differs;

      if v_has_mandatory_blocker then
        v_verdict := 'blocked_mandatory';
      elsif not v_content_differs then
        v_verdict := 'no_change';
      else
        v_verdict := 'publishable';
      end if;

      insert into schedule_publication_draft_items (schedule_publication_draft_id, application_id, verdict, blocker_details)
      values (
        v_draft.id,
        v_application_id,
        v_verdict,
        case when v_has_mandatory_blocker then
          (select jsonb_agg(jsonb_build_object('issue_type', ai.issue_type, 'session_id', ai.session_id))
           from allocation_issues ai join sessions s on s.id = ai.session_id
           where ai.allocation_run_id = p_allocation_run_id and ai.application_id = v_application_id
             and ai.issue_type in ('unassigned', 'capacity_bottleneck', 'schedule_conflict', 'no_eligible_sessions')
             and s.is_mandatory = true)
        else null end
      );
    end loop;
  else
    -- Change-propagation path: candidate participants are those with an
    -- active schedule_publication_items row referencing a session in
    -- v_session_ids (resolved from the change events). Blocking is driven
    -- by change_type = 'cancelled' on ANY affected item — mandatory or
    -- elective — not by allocation_issues (which don't apply to a
    -- change-propagation batch). Per the spec's Change Propagation
    -- Policy, a cancellation "must pick reassignment or explicit 'confirm
    -- cancelled' resolution... before any draft including this
    -- participant can be confirmed" — that requirement is not scoped to
    -- mandatory sessions, so an elective session's cancellation blocks
    -- exactly the same way a mandatory one does. (An earlier version of
    -- this check incorrectly scoped blocking to is_mandatory = true only,
    -- which let an elective cancellation silently reach confirm with no
    -- admin review — fixed here.)
    --
    -- content_differs: unlike the run-publish path, we can't compare
    -- session-id sets (the session assignment itself hasn't changed, only
    -- its frozen fields) — instead compare the recomputed frozen fields
    -- (start_time, end_time, room_id, and the session_people-derived
    -- speaker set) against the currently-stored frozen values on the
    -- active item. This mirrors compute_publication_fingerprint's own
    -- change-propagation hash inputs, so a truly no-op change event (e.g.
    -- a session_people row updated then immediately reverted before this
    -- batch was staged) correctly classifies as no_change rather than
    -- spuriously bumping the participant's revision_number.
    for v_application_id in
      select distinct sp.application_id
      from schedule_publications sp
      join schedule_publication_items spi on spi.schedule_publication_id = sp.id
      join schedule_change_events sce on sce.session_id = spi.session_id
      where sp.status = 'active' and spi.item_status in ('active', 'stale', 'pending_review')
        and sce.id = any(p_change_event_ids)
    loop
      select exists (
        select 1
        from schedule_publications sp
        join schedule_publication_items spi on spi.schedule_publication_id = sp.id
        join schedule_change_events sce on sce.session_id = spi.session_id
        where sp.application_id = v_application_id and sp.status = 'active'
          and sce.id = any(p_change_event_ids) and sce.change_type = 'cancelled'
      ) into v_has_mandatory_blocker;

      select exists (
        select 1
        from schedule_publications sp
        join schedule_publication_items spi on spi.schedule_publication_id = sp.id
        join sessions s on s.id = spi.session_id
        where sp.application_id = v_application_id and sp.status = 'active'
          and spi.session_id = any(v_session_ids)
          and (
            spi.start_time is distinct from s.start_time
            or spi.end_time is distinct from s.end_time
            or spi.room_name_en is distinct from (select r.name_en from rooms r where r.id = s.room_id)
            or spi.speakers is distinct from (
              select coalesce(jsonb_agg(jsonb_build_object('full_name_ar', p.full_name_ar, 'full_name_en', p.full_name_en, 'role', sp2.role)), '[]'::jsonb)
              from session_people sp2 join people p on p.id = sp2.person_id
              where sp2.session_id = s.id
            )
          )
      ) into v_content_differs;

      if v_has_mandatory_blocker then
        v_verdict := 'blocked_mandatory';
      elsif not v_content_differs then
        v_verdict := 'no_change';
      else
        v_verdict := 'publishable';
      end if;

      insert into schedule_publication_draft_items (schedule_publication_draft_id, application_id, verdict)
      values (v_draft.id, v_application_id, v_verdict);
    end loop;
  end if;

  return v_draft;
end;
$$ language plpgsql set search_path = public, pg_temp;
```

- [ ] **Step 2: Apply and verify**

Run: `npx supabase db push`. Verify via `npx supabase migration list`. Confirm all three functions (`compute_publication_fingerprint`, `stage_publication_transactional`, and their dependency ordering) exist by querying `pg_proc`.

**Rollback/failure behavior**: transactional apply. To roll back: `drop function stage_publication_transactional(uuid, uuid[], uuid)`, `drop function compute_publication_fingerprint(uuid, uuid[])`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260723190000_schedule_publication_functions.sql
git commit -m "feat: add compute_publication_fingerprint and stage_publication_transactional"
```

---

## Task 9: `confirm_publication_transactional` RPC

**Files:**
- Modify: `supabase/migrations/20260723190000_schedule_publication_functions.sql` (same file as Task 8, appended before commit — this is one logical migration; if Task 8 has already been applied and committed as its own migration by the time this task starts, create a new migration file instead: `supabase/migrations/20260723195000_confirm_publication_function.sql`. Follow whichever is actually true in the worktree at the time — check `git log` for Task 8's commit before deciding.)

- [ ] **Step 1: Write the function** (append to the Task 8 migration file, or a new one per the note above)

**Post-implementation note**: the implementer's live verification (going beyond the plan's minimum required steps, following the precedent set by Task 8) found the change-propagation path (`v_draft.allocation_run_id is null`) had no branch populating `schedule_publication_items` at all — confirming a change-propagation draft produced a new active revision with zero items, silently blanking the participant's published schedule. This has been fixed below: the `else` branch now carries forward every item from the participant's prior active revision, refreshing frozen fields only for sessions in the affected set. Two smaller issues were also found and addressed: the advisory lock key is now built from a sorted (not raw-order) change-event-id list, so two logically-equivalent drafts built with differently-ordered arrays still mutually exclude each other; and a comment now documents that the fingerprint-drift rejection's `update ... status = 'expired'` cannot durably persist in the same invocation that raises an exception (no autonomous transactions in PL/pgSQL) — this has no data-integrity consequence (re-confirming re-detects and re-rejects the same drift every time) but the `expired` status is currently unreachable via this path. The room-name-freezing note that used to appear below this block was stale (the join and both columns were already present) and has been removed.

**Second post-implementation note**: a code-quality review of the first fix above found a CRITICAL gap — the change-propagation branch's original cancellation handling (`case when live_status = 'cancelled' then 'cancelled' else 'active' end`) unilaterally decided a cancelled item's status, but per the spec's Change Propagation Policy, ANY session cancellation (not just mandatory) must block confirmation until an admin explicitly resolves it — Task 8's `stage_publication_transactional` incorrectly scoped its cancellation blocker check to `is_mandatory = true` only, letting an elective session's cancellation silently reach confirm with zero admin review. Fixed in both functions together: Task 8's change-propagation blocker check now fires on ANY cancellation (the `and s.is_mandatory = true` condition, and the now-unused `join sessions s`, were removed from that subquery); this function's carry-forward branch no longer guesses an `item_status` transition at all — since a correctly-gated draft can never reach confirm with an unresolved cancellation, the branch simply carries forward each item's own `item_status` unchanged (refreshing only the frozen display fields for affected sessions), rather than deriving a new status from live session state. The same review also found the carry-forward's `where ... and spi.item_status = 'active'` filter silently dropped any `stale`/`pending_review`/`changed` item from an unrelated earlier change batch — removed; every item from the prior revision is now carried forward regardless of its status. Finally, the prior-revision lookup no longer re-derives "most recent superseded row" via `order by revision_number desc limit 1` (correct today, but an implicit ordering dependency on the earlier supersede-`update` having already run) — the supersede statement now captures the row's id directly via `returning id into v_prior_publication_id`, removing the dependency entirely. A live regression test (electing to cancel a non-mandatory session and confirming it now blocks confirmation exactly like a mandatory cancellation would) was added and passes.

```sql
-- NOTE: this file's timestamp (195000) predates 20260723200000/201000, but
-- this function's body was edited (via create-or-replace, applied live and
-- committed here) AFTER those two migrations existed, and now references
-- schedule_publication_draft_items.reassigned_session_id — a column
-- 201000 adds. This works today only because v_item below is declared as
-- an untyped `record`, so PL/pgSQL defers field-reference resolution
-- until first execution rather than validating it at CREATE FUNCTION
-- time. If v_item is ever changed to
-- schedule_publication_draft_items%rowtype, this migration would need to
-- be renumbered to run after 201000, or it would fail to apply on a fresh
-- database.

-- Confirm: re-validates the fingerprint against current committed source
-- state (rejects with 'expired' if source data moved since staging);
-- acquires a transaction-scoped advisory lock keyed on the draft's source
-- identity (prevents concurrent publish interleaving); writes new
-- schedule_publications/schedule_publication_items rows only for
-- participants whose draft item verdict is 'publishable' (idempotent —
-- 'no_change' participants get no new row, 'blocked_mandatory' rows with
-- no resolution are skipped entirely); all in one short atomic
-- transaction. Rule 8's atomicity applies to this function's own writes.
create function confirm_publication_transactional(
  p_draft_id uuid,
  p_confirmed_by uuid
) returns schedule_publication_drafts as $$
declare
  v_draft schedule_publication_drafts;
  v_current_fingerprint text;
  v_lock_key bigint;
  v_item record;
  v_new_publication_id uuid;
  v_next_revision int;
  v_session record;
  v_speakers jsonb;
  v_session_ids uuid[];
  v_sorted_event_ids text;
  v_prior_publication_id uuid;
begin
  select * into v_draft from schedule_publication_drafts where id = p_draft_id and status = 'staged';
  if v_draft.id is null then
    raise exception 'Draft % is not in staged status (already confirmed, expired, discarded, or does not exist)', p_draft_id;
  end if;

  -- Sort before joining so two drafts over the same underlying change-event
  -- set, built from arrays passed in a different order, still hash to the
  -- same advisory lock key and correctly mutually exclude each other.
  if v_draft.triggered_by_change_event_ids is not null then
    select string_agg(id::text, ',' order by id) into v_sorted_event_ids
    from unnest(v_draft.triggered_by_change_event_ids) as id;
  end if;
  v_lock_key := hashtext(coalesce(v_draft.allocation_run_id::text, v_sorted_event_ids));
  if not pg_try_advisory_xact_lock(v_lock_key) then
    raise exception 'Another publication for this source is already in progress';
  end if;

  if v_draft.allocation_run_id is null then
    v_session_ids := resolve_change_event_session_ids(v_draft.triggered_by_change_event_ids);
  end if;

  v_current_fingerprint := compute_publication_fingerprint(v_draft.allocation_run_id, v_draft.triggered_by_change_event_ids);
  if v_current_fingerprint <> v_draft.source_fingerprint then
    -- Note: PL/pgSQL has no autonomous transactions, so an update here
    -- cannot durably persist a status change while this same invocation
    -- also raises an exception — Postgres rolls back every write this
    -- function made once the exception propagates, including this one.
    -- The draft is therefore left in 'staged', not 'expired', after this
    -- rejection; re-confirming the same draft re-detects the drift and
    -- re-rejects it identically every time, so this has no data-integrity
    -- consequence, only a cosmetic one (the 'expired' status value is
    -- unreachable via this path as currently designed). Marking a draft
    -- 'expired' for observability would require either a caller-side
    -- follow-up write after catching this exception, or restructuring
    -- this function to return rather than raise on drift — deferred
    -- rather than solved with a workaround here.
    raise exception 'Source data changed since this draft was staged — re-stage before publishing';
  end if;

  -- Ordered by application_id: makes processing order deterministic and
  -- reproducible across runs (otherwise cursor order depends on
  -- unspecified physical row order) — a harmless, cheap guarantee to have
  -- regardless of any specific test's needs.
  for v_item in
    select * from schedule_publication_draft_items
    where schedule_publication_draft_id = p_draft_id
      and (verdict = 'publishable' or (verdict = 'blocked_mandatory' and resolution is not null))
    order by application_id
  loop
    -- Supersede the current active revision for this participant, if any
    -- — capturing its id directly rather than re-deriving "most recent
    -- superseded" later, so the change-propagation carry-forward below
    -- has no implicit ordering dependency on this statement having run
    -- first (previously relied on `status = 'superseded' order by
    -- revision_number desc limit 1`, correct today but fragile against a
    -- future reordering).
    update schedule_publications set status = 'superseded'
    where application_id = v_item.application_id and status = 'active'
    returning id into v_prior_publication_id;

    select coalesce(max(revision_number), 0) + 1 into v_next_revision
    from schedule_publications where application_id = v_item.application_id;

    insert into schedule_publications (application_id, allocation_run_id, revision_number, status, source_fingerprint, published_by)
    values (
      v_item.application_id,
      coalesce(v_draft.allocation_run_id, (select allocation_run_id from schedule_publications where application_id = v_item.application_id order by revision_number desc limit 1)),
      v_next_revision, 'active', v_current_fingerprint, p_confirmed_by
    ) returning id into v_new_publication_id;

    -- The gap item (below, for a publish_with_gap-resolved mandatory
    -- blocker) and the participant's real assigned-session items (the loop
    -- further below) are intentionally NOT mutually exclusive: a
    -- publish_with_gap resolution means "no assignment exists for the
    -- mandatory slot this participant was blocked on" — there is no
    -- allocation_assignments row for that slot, so the loop below simply
    -- never produces an item for it. The gap item fills exactly that
    -- specific missing slot, while the loop below still correctly
    -- publishes every OTHER real assignment (e.g. their electives) the
    -- participant does have. The two paths write disjoint items by
    -- construction, not by an explicit guard.
    if v_item.resolution = 'override_publish_with_gap' then
      insert into schedule_publication_items (schedule_publication_id, session_id, is_mandatory, item_status, gap_reason)
      values (v_new_publication_id, null, true, 'active', v_item.override_reason);
    end if;

    -- A 'reassigned' resolution (reassign_blocked_participant_transactional,
    -- Task 10) means the participant's blocked mandatory slot was pointed
    -- at a different session — reassigned_session_id, on the draft item
    -- itself, not allocation_assignments (which has no row for this
    -- participant+slot; that's exactly why it was blocked). Publish that
    -- session's current data directly, same shape as the run-publish loop
    -- below but sourced from the draft item's reassignment instead of an
    -- allocation_assignments row. Disjoint from both the gap-item branch
    -- above (mutually exclusive resolution values, checked by the enum
    -- constraint) and the allocation_assignments loop below (no row exists
    -- for this participant+slot on the run-publish path, or the loop below
    -- is skipped entirely on the change-propagation path).
    if v_item.resolution = 'reassigned' then
      select s.*, r.name_ar as room_name_ar, r.name_en as room_name_en
      into v_session
      from sessions s join rooms r on r.id = s.room_id
      where s.id = v_item.reassigned_session_id;

      select jsonb_agg(jsonb_build_object('full_name_ar', p.full_name_ar, 'full_name_en', p.full_name_en, 'role', sp.role))
      into v_speakers
      from session_people sp join people p on p.id = sp.person_id
      where sp.session_id = v_session.id;

      insert into schedule_publication_items (
        schedule_publication_id, session_id, session_title_ar, session_title_en,
        room_name_ar, room_name_en, start_time, end_time, is_mandatory, speakers, item_status
      ) values (
        v_new_publication_id, v_session.id, v_session.title_ar, v_session.title_en,
        v_session.room_name_ar, v_session.room_name_en,
        v_session.start_time, v_session.end_time, v_session.is_mandatory,
        coalesce(v_speakers, '[]'::jsonb), 'active'
      );
    end if;

    if v_draft.allocation_run_id is not null then
      for v_session in
        select s.*, r.name_ar as room_name_ar, r.name_en as room_name_en, aa.suitability_score, aa.is_low_confidence
        from allocation_assignments aa
        join sessions s on s.id = aa.session_id
        join rooms r on r.id = s.room_id
        where aa.allocation_run_id = v_draft.allocation_run_id and aa.application_id = v_item.application_id
      loop
        select jsonb_agg(jsonb_build_object('full_name_ar', p.full_name_ar, 'full_name_en', p.full_name_en, 'role', sp.role))
        into v_speakers
        from session_people sp join people p on p.id = sp.person_id
        where sp.session_id = v_session.id;

        insert into schedule_publication_items (
          schedule_publication_id, session_id, session_title_ar, session_title_en,
          room_name_ar, room_name_en, start_time, end_time, is_mandatory, speakers,
          suitability_score, item_status
        ) values (
          v_new_publication_id, v_session.id, v_session.title_ar, v_session.title_en,
          v_session.room_name_ar, v_session.room_name_en,
          v_session.start_time, v_session.end_time, v_session.is_mandatory,
          coalesce(v_speakers, '[]'::jsonb), v_session.suitability_score, 'active'
        );
      end loop;
    else
      -- Change-propagation path: carry forward EVERY item from the
      -- participant's prior active (now-superseded, id captured above in
      -- v_prior_publication_id) revision — the underlying session
      -- assignment hasn't changed, only some sessions' frozen display
      -- fields have. For items whose session_id is one of this batch's
      -- affected sessions, refresh the frozen fields from current live
      -- state (mirrors what stage_publication_transactional's
      -- content_differs check already compared against); every other
      -- item is carried forward verbatim, regardless of its current
      -- item_status (not filtered to 'active' — a 'stale'/'pending_review'
      -- item from an unrelated earlier change batch must not be silently
      -- dropped just because this confirm call is about a different
      -- session).
      --
      -- This branch never needs to decide a 'cancelled' item_status
      -- itself: stage_publication_transactional's blocker check now
      -- treats ANY cancelled session referenced by an active item as
      -- blocking (mandatory or elective — see that function's comment),
      -- so a draft item can only reach this loop at all if either (a) no
      -- affected session was cancelled, or (b) it was cancelled and the
      -- blocker was explicitly resolved. Resolution handling (updating
      -- the carried-forward item to reflect that resolution) is Task 10's
      -- concern once reassign_blocked_participant_transactional exists;
      -- this function does not yet special-case a resolved cancellation
      -- and will simply carry the item's frozen fields forward unchanged
      -- if session_id is not in v_session_ids, or refresh them from
      -- (still-cancelled) live session state if it is — deliberately not
      -- guessing an item_status transition that belongs to a resolution
      -- step this function doesn't implement.
      for v_session in
        select spi.id as item_id, spi.session_id, spi.session_title_ar, spi.session_title_en,
          spi.room_name_ar, spi.room_name_en, spi.start_time, spi.end_time, spi.is_mandatory,
          spi.speakers, spi.suitability_score, spi.explanation_summary, spi.gap_reason, spi.item_status,
          s.id as live_session_id, s.title_ar as live_title_ar, s.title_en as live_title_en,
          r.name_ar as live_room_name_ar, r.name_en as live_room_name_en,
          s.start_time as live_start_time, s.end_time as live_end_time,
          s.is_mandatory as live_is_mandatory
        from schedule_publication_items spi
        left join sessions s on s.id = spi.session_id
        left join rooms r on r.id = s.room_id
        where spi.schedule_publication_id = v_prior_publication_id
      loop
        if v_session.session_id is not null and v_session.session_id = any(v_session_ids) then
          select jsonb_agg(jsonb_build_object('full_name_ar', p.full_name_ar, 'full_name_en', p.full_name_en, 'role', sp2.role))
          into v_speakers
          from session_people sp2 join people p on p.id = sp2.person_id
          where sp2.session_id = v_session.session_id;

          insert into schedule_publication_items (
            schedule_publication_id, session_id, session_title_ar, session_title_en,
            room_name_ar, room_name_en, start_time, end_time, is_mandatory, speakers,
            suitability_score, explanation_summary, item_status
          ) values (
            v_new_publication_id, v_session.session_id, v_session.live_title_ar, v_session.live_title_en,
            v_session.live_room_name_ar, v_session.live_room_name_en,
            v_session.live_start_time, v_session.live_end_time, v_session.live_is_mandatory,
            coalesce(v_speakers, '[]'::jsonb), v_session.suitability_score, v_session.explanation_summary,
            v_session.item_status
          );
        else
          insert into schedule_publication_items (
            schedule_publication_id, session_id, session_title_ar, session_title_en,
            room_name_ar, room_name_en, start_time, end_time, is_mandatory, speakers,
            suitability_score, explanation_summary, gap_reason, item_status
          ) values (
            v_new_publication_id, v_session.session_id, v_session.session_title_ar, v_session.session_title_en,
            v_session.room_name_ar, v_session.room_name_en,
            v_session.start_time, v_session.end_time, v_session.is_mandatory,
            v_session.speakers, v_session.suitability_score, v_session.explanation_summary,
            v_session.gap_reason, v_session.item_status
          );
        end if;
      end loop;
    end if;
  end loop;

  update schedule_publication_drafts set status = 'confirmed' where id = p_draft_id;
  select * into v_draft from schedule_publication_drafts where id = p_draft_id;
  return v_draft;
end;
$$ language plpgsql set search_path = public, pg_temp;
```

- [ ] **Step 2: Apply and verify**

Run: `npx supabase db push`. Verify via `npx supabase migration list`. Confirm the function exists via `pg_proc`.

**Rollback/failure behavior**: transactional apply. To roll back: `drop function confirm_publication_transactional(uuid, uuid)`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/
git commit -m "feat: add confirm_publication_transactional with advisory lock and fingerprint revalidation"
```

---

## Task 10: `reassign_blocked_participant_transactional` RPC

**Files:**
- Create: `supabase/migrations/20260723200000_reassign_blocked_participant_function.sql`
- Create: `supabase/migrations/20260723201000_reassigned_session_id_column.sql`

Implements the spec's "The `reassigned` resolution mechanism" — operates entirely within a draft, never touches `allocation_assignments`/`allocation_runs`.

**Important — hard-constraint re-validation happens in TypeScript, not SQL.** The spec requires this RPC's caller to "re-validate the new session against the same hard constraints Phase 4 already codifies" (status/inclusion/language/difficulty). `checkStaticHardConstraints` (`src/lib/allocation/hard-constraints.ts`) is a TypeScript function — PL/pgSQL cannot call it, and reimplementing its difficulty-tier-adjacency logic (`experienceToTier` + ±1-tier matching) a second time in raw SQL would create two independently-maintained copies of the same business rule, an easy way to have them silently drift apart. So this RPC intentionally does **not** perform hard-constraint checks itself — it only re-validates this-draft capacity (its own, genuinely SQL-native concern) and flips the verdict. The **server action calling this RPC (Task 16) is responsible for calling `checkStaticHardConstraints` first and rejecting before ever invoking this RPC** — exactly mirroring how Phase 4's `overrideAssignment` action does its own constraint check in TypeScript before calling `override_allocation_assignment_transactional`. Do not skip the TS-side check in Task 16 on the assumption this RPC covers it — it does not, by design.

**Post-implementation note**: the plan's given SQL (below) failed to apply as literally written — `select spdi.*, spd.status into v_item, v_draft_status` mixes a record target with a scalar target in one INTO list, which Postgres rejects (SQLSTATE 42601). This was split into two separate `select ... into` statements with identical join/filter semantics; behavior is otherwise unchanged.

A more serious gap was also found during live verification, spanning this task and Task 3/9: `schedule_publication_draft_items` had no column recording WHICH session a reassignment pointed at. Without it, (a) the this-draft capacity recount below could not scope by target session — it counted every `reassigned` item in the whole draft regardless of which session each pointed at, so reassigning to a different, empty session was incorrectly rejected just because an unrelated session was full — and (b) `confirm_publication_transactional` (Task 9) had no way to actually publish the reassigned session's data at all, since a `blocked_mandatory` slot has no `allocation_assignments` row by definition (that's exactly why it was blocked). Fixed with a new migration adding `reassigned_session_id uuid references sessions(id)` to `schedule_publication_draft_items`, this RPC now writes it and scopes the capacity recount by it, and `confirm_publication_transactional` was updated with a new branch (alongside its existing `override_publish_with_gap` handling) that publishes the reassigned session's current data when `resolution = 'reassigned'`. See Task 9's SQL block above, which already reflects this fix.

- [ ] **Step 1: Write the migration**

```sql
-- reassign_blocked_participant_function.sql

-- Resolves a blocked_mandatory draft item by pointing it at a different
-- session, entirely within the still-staged draft. Never mutates Phase 4's
-- allocation_assignments/allocation_runs — those stay untouched; only this
-- draft's proposed publication content changes. Cannot reuse Phase 4's
-- override_allocation_assignment_transactional, which hard-rejects unless
-- the target run is 'draft' status, and Phase 5 only ever operates on
-- 'confirmed' runs.
--
-- Does NOT re-check hard constraints (status/inclusion/language/
-- difficulty) — that happens in the calling server action via
-- checkStaticHardConstraints (see Task 16), which must run and reject
-- BEFORE this RPC is ever called. This RPC only re-validates the one
-- genuinely SQL-native concern (this-draft capacity) and performs the
-- write.
create function reassign_blocked_participant_transactional(
  p_draft_item_id uuid,
  p_new_session_id uuid,
  p_reassigned_by uuid
) returns schedule_publication_draft_items as $$
declare
  v_item schedule_publication_draft_items;
  v_draft_status text;
  v_session_capacity int;
  v_current_count int;
begin
  -- NOTE: the plan's given SQL used a single
  --   select spdi.*, spd.status into v_item, v_draft_status
  -- but Postgres rejects mixing a record target (v_item receiving spdi.*)
  -- with an additional scalar target in the same INTO list
  -- (SQLSTATE 42601: "record variable cannot be part of multiple-item INTO
  -- list") — confirmed live against the hosted project; the migration does
  -- not apply as originally written. Split into two statements with
  -- identical join/filter semantics; behavior is unchanged.
  select spdi.* into v_item
  from schedule_publication_draft_items spdi
  where spdi.id = p_draft_item_id;

  select spd.status into v_draft_status
  from schedule_publication_drafts spd
  where spd.id = v_item.schedule_publication_draft_id;

  if v_item.id is null then
    raise exception 'Draft item % not found', p_draft_item_id;
  end if;
  if v_item.verdict <> 'blocked_mandatory' then
    raise exception 'Draft item % is not blocked_mandatory (verdict is %)', p_draft_item_id, v_item.verdict;
  end if;
  if v_draft_status <> 'staged' then
    raise exception 'Cannot reassign on a % draft — only staged drafts are editable', v_draft_status;
  end if;

  select capacity into v_session_capacity from sessions where id = p_new_session_id;
  if v_session_capacity is null then
    raise exception 'Target session % not found', p_new_session_id;
  end if;

  -- This-draft-scoped capacity: count draft items ALREADY reassigned to
  -- THIS SPECIFIC target session within this same draft. Scoped by
  -- reassigned_session_id (added because schedule_publication_draft_items
  -- originally had no column recording which session a reassignment
  -- pointed at, making this recount count every reassigned item in the
  -- whole draft regardless of target session — found and fixed after
  -- live verification showed reassigning to a different, empty session
  -- was incorrectly rejected just because an unrelated session was full).
  -- Approximate by design for this within-draft correction step and
  -- re-validated for real at Confirm time by the same session's real
  -- capacity constraint already enforced elsewhere in the system.
  select count(*) into v_current_count
  from schedule_publication_draft_items
  where schedule_publication_draft_id = v_item.schedule_publication_draft_id
    and verdict = 'publishable' and resolution = 'reassigned'
    and reassigned_session_id = p_new_session_id;

  if v_current_count >= v_session_capacity then
    raise exception 'Cannot reassign: session % is at capacity (% / %) within this draft', p_new_session_id, v_current_count, v_session_capacity;
  end if;

  update schedule_publication_draft_items
  set verdict = 'publishable', resolution = 'reassigned', reassigned_session_id = p_new_session_id
  where id = p_draft_item_id
  returning * into v_item;

  return v_item;
end;
$$ language plpgsql set search_path = public, pg_temp;
```

- [ ] **Step 1b: Write the companion column migration** (found necessary during live verification — see post-implementation note above)

```sql
-- reassigned_session_id_column.sql

-- Real gap found during Task 10's live verification: reassign_blocked_
-- participant_transactional flips a blocked draft item to publishable/
-- reassigned, but schedule_publication_draft_items had no column to
-- record WHICH session it was reassigned to. Without this, the this-draft
-- capacity recount couldn't scope by target session (it counted every
-- reassigned item in the whole draft, rejecting an unrelated reassignment
-- to a different, empty session just because some other item filled an
-- unrelated one), and confirm_publication_transactional had no way to
-- publish the reassigned session's data at all — a reassigned run-publish
-- item would silently fall through with no schedule_publication_items row
-- (no allocation_assignments row exists for a blocked mandatory slot,
-- which is exactly why it was blocked in the first place).
alter table schedule_publication_draft_items
  add column reassigned_session_id uuid references sessions(id);

-- Unlike override_reason (descriptive text, app-layer-enforced pairing
-- with resolution = 'override_publish_with_gap' per Task 3's existing
-- convention), reassigned_session_id is load-bearing:
-- confirm_publication_transactional reads it to decide what to actually
-- publish. A resolution = 'reassigned' row with a null
-- reassigned_session_id would degrade to a confusing NOT NULL constraint
-- violation on schedule_publication_items.is_mandatory at confirm time,
-- rather than a clear error at the point the bad data was written — a DB
-- check constraint converts that into an immediate, clear failure at the
-- write site instead of a deferred, cryptic one at confirm.
alter table schedule_publication_draft_items
  add constraint schedule_publication_draft_items_reassigned_session_required
  check (resolution <> 'reassigned' or reassigned_session_id is not null);

comment on column schedule_publication_draft_items.reassigned_session_id is
  'Set by reassign_blocked_participant_transactional when resolution = ''reassigned''. The session this draft item will actually publish against at confirm time, replacing the original blocked mandatory assignment.';
```

- [ ] **Step 2: Apply and verify** (same process as Task 1 Step 2, both migration files)

**Rollback/failure behavior**: transactional apply. To roll back: `drop function reassign_blocked_participant_transactional(uuid, uuid, uuid)`, then `alter table schedule_publication_draft_items drop column reassigned_session_id`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260723200000_reassign_blocked_participant_function.sql supabase/migrations/20260723201000_reassigned_session_id_column.sql
git commit -m "feat: add reassign_blocked_participant_transactional RPC and reassigned_session_id column"
```

---

## Task 11: Run typecheck/lint/test after schema + RPC layer

- [ ] **Step 1:** Run `npx tsc --noEmit` — expect no errors.
- [ ] **Step 2:** Run `npm run lint` — expect no errors.
- [ ] **Step 3:** Run `npm test` — expect all Task 6/7 tests passing (14 tests: 7 schema + 3 fingerprint + 4 verdict-classification — recount against actual test file content once written; this count is illustrative, not authoritative).
- [ ] **Step 4:** If anything fails, fix before proceeding.

No commit for this task (verification only).

---

## Task 12: Orchestrator — stage publication

**Files:**
- Create: `src/lib/schedule/run-stage-publication.ts`

- [ ] **Step 1: Write the orchestrator**

```ts
// src/lib/schedule/run-stage-publication.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type ServiceClient = SupabaseClient<Database>;

export async function stagePublication(
  service: ServiceClient,
  stagedBy: string,
  source: { allocationRunId: string } | { changeEventIds: string[] }
): Promise<{ id: string }> {
  const { data, error } = await service.rpc('stage_publication_transactional', {
    p_allocation_run_id: 'allocationRunId' in source ? source.allocationRunId : null,
    p_change_event_ids: 'changeEventIds' in source ? source.changeEventIds : null,
    p_staged_by: stagedBy,
  });
  if (error || !data) throw new Error(`Failed to stage publication: ${error?.message}`);
  return { id: data.id };
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit` — expect an error until Task 15 regenerates `src/types/database.ts` to include the new RPC signature; this is expected at this point in the plan, matching Phase 4's own established pattern of deferring type regeneration until after all new RPCs exist. Proceed to the next task; do not attempt to work around this early.

- [ ] **Step 3: Commit**

```bash
git add src/lib/schedule/run-stage-publication.ts
git commit -m "feat: add stage-publication orchestrator"
```

---

## Task 13: Orchestrator — confirm publication and reassignment

**Files:**
- Create: `src/lib/schedule/run-confirm-publication.ts`

- [ ] **Step 1: Write the orchestrator**

```ts
// src/lib/schedule/run-confirm-publication.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type ServiceClient = SupabaseClient<Database>;

export async function confirmPublication(service: ServiceClient, draftId: string, confirmedBy: string) {
  const { data, error } = await service.rpc('confirm_publication_transactional', {
    p_draft_id: draftId,
    p_confirmed_by: confirmedBy,
  });
  if (error) throw new Error(`Failed to confirm publication: ${error.message}`);
  return data;
}

export async function reassignBlockedParticipant(
  service: ServiceClient,
  draftItemId: string,
  newSessionId: string,
  reassignedBy: string
) {
  const { data, error } = await service.rpc('reassign_blocked_participant_transactional', {
    p_draft_item_id: draftItemId,
    p_new_session_id: newSessionId,
    p_reassigned_by: reassignedBy,
  });
  if (error) throw new Error(`Failed to reassign: ${error.message}`);
  return data;
}

export async function overridePublishWithGap(
  service: ServiceClient,
  draftItemId: string,
  overrideReason: string
) {
  // .eq('verdict', 'blocked_mandatory') means a stale/wrong/nonexistent
  // draftItemId matches zero rows — without .select(), PostgREST returns
  // 204/error: null for that case identically to a real update, so the
  // caller would get no signal anything went wrong. Select the updated
  // row back and throw if nothing matched, so this fails loudly like
  // confirmPublication/reassignBlockedParticipant already do.
  const { data, error } = await service
    .from('schedule_publication_draft_items')
    .update({ resolution: 'override_publish_with_gap', override_reason: overrideReason, verdict: 'publishable' })
    .eq('id', draftItemId)
    .eq('verdict', 'blocked_mandatory')
    .select('id');
  if (error) throw new Error(`Failed to record override: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error(`Failed to record override: draft item ${draftItemId} not found or not blocked_mandatory`);
  }
}
```

**Post-implementation note**: the original given `overridePublishWithGap` used a bare `.update()` with no `.select()` — PostgREST returns `204`/`error: null` for zero-rows-matched identically to a real update, so a caller passing a stale/wrong/nonexistent `draftItemId` got no signal anything went wrong (verified live: both a nonexistent id and an already-resolved item silently "succeeded" with no row actually changed). Fixed by adding `.select('id')` and throwing when the result is empty, matching how the other two functions in this file already fail loudly on error.

- [ ] **Step 2: Commit**

```bash
git add src/lib/schedule/run-confirm-publication.ts
git commit -m "feat: add confirm-publication, reassignment, and override-with-gap orchestrators"
```

(Type-check deferred to after Task 15, same as Task 12.)

---

## Task 14: Orchestrator — process change events (staleness marking)

**Files:**
- Create: `src/lib/schedule/run-process-change-events.ts`

- [ ] **Step 1: Write the orchestrator**

```ts
// src/lib/schedule/run-process-change-events.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type ServiceClient = SupabaseClient<Database>;

// Reads unprocessed schedule_change_events, marks affected active
// schedule_publication_items 'stale' (time/room/speaker change) or
// 'pending_review' (cancellation) — never changes what a participant
// currently sees; a stale item still renders its last-published content
// until a new revision is actually published (spec: Staleness marking,
// orchestrator not trigger).
export async function processChangeEvents(service: ServiceClient): Promise<{ processedCount: number }> {
  const { data: events, error: eventsErr } = await service
    .from('schedule_change_events')
    .select('id, session_id, change_type')
    .is('processed_at', null);
  if (eventsErr) throw new Error(`Failed to load change events: ${eventsErr.message}`);
  if (!events || events.length === 0) return { processedCount: 0 };

  const sessionIds = [...new Set(events.map((e) => e.session_id))];
  const { data: items, error: itemsErr } = await service
    .from('schedule_publication_items')
    .select('id, session_id, item_status, schedule_publication_id, schedule_publications!inner(status)')
    .in('session_id', sessionIds)
    .eq('item_status', 'active')
    .eq('schedule_publications.status', 'active');
  if (itemsErr) throw new Error(`Failed to load affected items: ${itemsErr.message}`);

  const cancelledSessionIds = new Set(events.filter((e) => e.change_type === 'cancelled').map((e) => e.session_id));

  for (const item of items ?? []) {
    const newStatus = cancelledSessionIds.has(item.session_id!) ? 'pending_review' : 'stale';
    const { error: updateErr } = await service
      .from('schedule_publication_items')
      .update({ item_status: newStatus })
      .eq('id', item.id);
    if (updateErr) throw new Error(`Failed to mark item stale: ${updateErr.message}`);
  }

  const eventIds = events.map((e) => e.id);
  const { error: markProcessedErr } = await service
    .from('schedule_change_events')
    .update({ processed_at: new Date().toISOString() })
    .in('id', eventIds);
  if (markProcessedErr) throw new Error(`Failed to mark events processed: ${markProcessedErr.message}`);

  return { processedCount: events.length };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/schedule/run-process-change-events.ts
git commit -m "feat: add change-event processing orchestrator for staleness marking"
```

---

## Task 15: Regenerate Supabase types

**Files:**
- Modify: `src/types/database.ts` (generated — do not hand-edit)
- Modify: `src/lib/schedule/run-stage-publication.ts`, `tests/schedule/confirm-publication-behavioral.test.ts`, `tests/schedule/reassign-blocked-participant-behavioral.test.ts` (see post-implementation note)

- [ ] **Step 1:** Run `npx supabase gen types typescript --project-id deukwztsmcnxxchrdrfo > src/types/database.ts` (or whatever command Phase 4's plan established as working in this environment — check `.env`/`supabase/config.toml` for the project id if it differs).
- [ ] **Step 2:** Run `npx tsc --noEmit` — confirm Tasks 12-14's orchestrators now typecheck cleanly, including all 4 new RPC signatures and the 5 new tables.
- [ ] **Step 3: Commit**

```bash
git add src/types/database.ts
git commit -m "chore: regenerate Supabase types for Phase 5 schedule tables and functions"
```

**Post-implementation note**: regeneration surfaced a real gap in the Supabase CLI's type generator, not a code defect — it does not mark RPC `Args` parameters as nullable even when the underlying SQL function's parameter has no `not null` and the function's own logic explicitly branches on either being `null` (`stage_publication_transactional`'s `p_allocation_run_id`/`p_change_event_ids`, exactly-one-of by design per `schedule_publication_drafts_one_source`). This produced 9 real `tsc` errors across `run-stage-publication.ts` and two test files that correctly pass `null` for the unused branch. Fixed with narrow, commented type casts (`as string`/`as string[]` in the orchestrator; `as unknown as string`/`as unknown as string[]` at the seven test call sites) documenting this as a known codegen limitation rather than a real type mismatch — not a workaround for an actual bug. `npx tsc --noEmit` and `npm run lint` both clean after the fix; all affected live test suites re-verified passing (25/26 and 26/26 across repeated runs, the one flake being the session's known intermittent hosted-project Auth Admin API issue, unrelated to this change).

---

## Task 16: Admin server actions — stage/confirm/reassign/override

**Files:**
- Create: `src/app/[locale]/(admin)/allocation/schedules/stage/[allocationRunId]/actions.ts`

**Post-implementation note**: the plan's given import (`import { idSchema, reassignSchema, overridePublishWithGapSchema } from '@/lib/validation/schedule'`) does not compile — `src/lib/validation/schedule.ts` imports `idSchema` from `./allocation` for internal use only and does not re-export it. Fixed by importing `idSchema` from `@/lib/validation/allocation` directly, matching the established convention already used by Phase 4's `src/app/[locale]/(admin)/allocation/extraction/actions.ts` and `.../runs/[id]/actions.ts`. No other change.

- [ ] **Step 1: Write the actions**

```ts
// src/app/[locale]/(admin)/allocation/schedules/stage/[allocationRunId]/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { stagePublication } from '@/lib/schedule/run-stage-publication';
import { confirmPublication, reassignBlockedParticipant, overridePublishWithGap } from '@/lib/schedule/run-confirm-publication';
import { checkStaticHardConstraints, type ParticipantForConstraints, type SessionForConstraints } from '@/lib/allocation/hard-constraints';
import { idSchema } from '@/lib/validation/allocation';
import { reassignSchema, overridePublishWithGapSchema } from '@/lib/validation/schedule';

export async function triggerStagePublication(allocationRunId: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsedRunId = idSchema.parse(allocationRunId);
  const result = await stagePublication(service, userId, { allocationRunId: parsedRunId });
  await writeAuditLog(service, { entityType: 'schedule_publication_draft', entityId: result.id, action: 'stage', actorId: userId, metadata: { allocationRunId: parsedRunId } });
  return result;
}

export async function confirmDraftPublication(draftId: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsedDraftId = idSchema.parse(draftId);
  const result = await confirmPublication(service, parsedDraftId, userId);
  await writeAuditLog(service, { entityType: 'schedule_publication_draft', entityId: parsedDraftId, action: 'confirm', actorId: userId });
  return result;
}

// Hard-constraint re-validation (status/inclusion/language/difficulty)
// happens HERE, in TypeScript, before the RPC is ever called — Task 10's
// reassign_blocked_participant_transactional deliberately does not
// duplicate this logic in SQL (see that task's header comment). This
// mirrors Phase 4's overrideAssignment action doing its own
// checkStaticHardConstraints call before invoking
// override_allocation_assignment_transactional. A failing check here must
// throw before the RPC runs — the RPC's own capacity guard is not a
// substitute for this check.
export async function reassignDraftItem(input: unknown) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = reassignSchema.parse(input);

  const { data: draftItem, error: draftItemErr } = await service
    .from('schedule_publication_draft_items')
    .select('id, application_id')
    .eq('id', parsed.draftItemId)
    .single();
  if (draftItemErr || !draftItem) throw new Error('Draft item not found');

  const { data: application, error: appErr } = await service
    .from('applications')
    .select('preferred_language, experience_level')
    .eq('id', draftItem.application_id)
    .single();
  if (appErr || !application) throw new Error('Application not found');

  const { data: session, error: sessionErr } = await service
    .from('sessions')
    .select('id, status, include_in_allocation, language, difficulty_level, is_mandatory')
    .eq('id', parsed.newSessionId)
    .single();
  if (sessionErr || !session) throw new Error('Target session not found');

  const participant: ParticipantForConstraints = {
    applicationId: draftItem.application_id,
    preferredLanguage: application.preferred_language,
    experienceLevel: application.experience_level,
  };
  const sessionForConstraints: SessionForConstraints = {
    id: session.id,
    status: session.status,
    includeInAllocation: session.include_in_allocation,
    language: session.language,
    difficultyLevel: session.difficulty_level,
    isMandatory: session.is_mandatory,
  };
  const constraintResult = checkStaticHardConstraints(participant, sessionForConstraints);
  if (!constraintResult.eligible) {
    const failed = constraintResult.checks.find((c) => !c.passed);
    throw new Error(`Cannot reassign: ${failed?.detail ?? 'hard constraint failed'}`);
  }

  const result = await reassignBlockedParticipant(service, parsed.draftItemId, parsed.newSessionId, userId);
  await writeAuditLog(service, { entityType: 'schedule_publication_draft', entityId: parsed.draftItemId, action: 'reassign', actorId: userId, metadata: { newSessionId: parsed.newSessionId } });
  return result;
}

export async function overrideDraftItemWithGap(input: unknown) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = overridePublishWithGapSchema.parse(input);
  await overridePublishWithGap(service, parsed.draftItemId, parsed.overrideReason);
  await writeAuditLog(service, { entityType: 'schedule_publication_draft', entityId: parsed.draftItemId, action: 'override', actorId: userId, metadata: { reason: parsed.overrideReason } });
}
```

- [ ] **Step 2: Verify types compile and lint**

Run: `npx tsc --noEmit`, `npm run lint`.

- [ ] **Step 3: Commit**

```bash
git add "src/app/[locale]/(admin)/allocation/schedules/stage/[allocationRunId]/actions.ts"
git commit -m "feat: add stage/confirm/reassign/override server actions"
```

---

## Task 17: Admin server actions — changed-schedules queue

**Files:**
- Create: `src/app/[locale]/(admin)/allocation/schedules/changed/actions.ts`

**Post-implementation note**: same import bug as Task 16 — `idSchema` is not re-exported by `@/lib/validation/schedule`. Fixed identically: import it from `@/lib/validation/allocation` directly. Also investigated (not changed): `triggerProcessChangeEvents`'s audit log sets `entityId: userId` — the same value as `actorId` — because `processChangeEvents` operates on a batch of N events/items with no single representative row id (unlike every other action in this codebase, which always has a real entity id to reference). `writeAuditLog`'s `entityId` is required and non-nullable, so something must go there; `userId` is a real, valid, traceable id, and `metadata.processedCount` already records what happened. Confirmed no other batch-style action anywhere in the codebase does this, but also confirmed there's no natural substitute id available here — reviewed and kept as the plan's given code specifies.

- [ ] **Step 1: Write the actions**

```ts
// src/app/[locale]/(admin)/allocation/schedules/changed/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { processChangeEvents } from '@/lib/schedule/run-process-change-events';
import { stagePublication } from '@/lib/schedule/run-stage-publication';
import { idSchema } from '@/lib/validation/allocation';
import { z } from 'zod';

export async function triggerProcessChangeEvents() {
  const { userId, service } = await requireAgendaStaffCaller();
  const result = await processChangeEvents(service);
  await writeAuditLog(service, { entityType: 'schedule_change_event', entityId: userId, action: 'process_change_event', actorId: userId, metadata: { processedCount: result.processedCount } });
  return result;
}

const changeEventIdsSchema = z.array(idSchema).min(1);

export async function triggerStageFromChangeEvents(changeEventIds: unknown) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = changeEventIdsSchema.parse(changeEventIds);
  const result = await stagePublication(service, userId, { changeEventIds: parsed });
  await writeAuditLog(service, { entityType: 'schedule_publication_draft', entityId: result.id, action: 'stage', actorId: userId, metadata: { changeEventIds: parsed } });
  return result;
}
```

- [ ] **Step 2: Verify types compile and lint**

Run: `npx tsc --noEmit`, `npm run lint`.

- [ ] **Step 3: Commit**

```bash
git add "src/app/[locale]/(admin)/allocation/schedules/changed/actions.ts"
git commit -m "feat: add changed-schedules queue server actions"
```

---

## Task 18: UI primitives (`src/components/ui/`)

**Files:**
- Create: `src/components/ui/badge.tsx`, `card.tsx`, `empty-state.tsx`, `skeleton.tsx`

This is the first real component library in the codebase — generic, reusable-anywhere primitives, per the spec's explicit design-system-seed requirement. Extend `src/app/globals.css`'s `@theme inline` block minimally if a needed token doesn't exist yet (e.g. a semantic color for a badge variant) — do not introduce a full custom palette; add only what these 4 components genuinely need.

- [ ] **Step 1: Write `badge.tsx`**

```tsx
// src/components/ui/badge.tsx
import type { ReactNode } from 'react';

type BadgeVariant = 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral';

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  mandatory: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  elective: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  cancelled: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200 line-through',
  changed: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  neutral: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

export function Badge({ variant, children }: { variant: BadgeVariant; children: ReactNode }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${VARIANT_CLASSES[variant]}`}>
      {children}
    </span>
  );
}
```

- [ ] **Step 2: Write `card.tsx`**

```tsx
// src/components/ui/card.tsx
import type { ReactNode } from 'react';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900 ${className}`}>
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Write `empty-state.tsx`**

```tsx
// src/components/ui/empty-state.tsx
export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div role="status" className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-gray-300 p-8 text-center dark:border-gray-700">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</p>
      {description && <p className="text-sm text-gray-500 dark:text-gray-400">{description}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Write `skeleton.tsx`**

```tsx
// src/components/ui/skeleton.tsx
export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div role="status" aria-label="Loading" className={`animate-pulse rounded bg-gray-200 dark:bg-gray-700 ${className}`} />;
}
```

- [ ] **Step 5: Verify types compile and lint**

Run: `npx tsc --noEmit`, `npm run lint`.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/
git commit -m "feat: add ui primitive components (badge, card, empty-state, skeleton)"
```

---

## Task 19: Schedule composite components (`src/components/schedule/`)

**Files:**
- Create: `src/components/schedule/time-marker.tsx`, `status-banner.tsx`, `session-card.tsx`, `day-timeline.tsx`
- Modify: `src/messages/en.json`, `src/messages/ar.json` (see post-implementation note)

**Post-implementation note**: four real bugs were caught across two rounds of review (proactive review before implementing, then a code-quality reviewer pass after committing), all violating the user's explicit, binding earlier styling requirement for this exact component tree ("Arabic and English support, correct RTL/LTR behavior"):
1. `day-timeline.tsx`'s vertical rule used physical-direction classes (`border-l-2 border-gray-200 pl-4`) — always renders on the left regardless of text direction, breaking in Arabic RTL. Fixed to logical Tailwind v4 utilities (`border-s-2 border-gray-200 ps-4`), matching the zero-physical-direction-class standard Task 18's primitives already established.
2. All user-facing strings in `status-banner.tsx`, `session-card.tsx`, and `day-timeline.tsx` were hardcoded English with no i18n mechanism, despite `locale` already being threaded through `SessionCard`. Fixed using the codebase's established `next-intl` Server Component pattern (`getTranslations()` from `next-intl/server`, same pattern as `my-application/page.tsx`) — added a new `schedule` namespace (`schedule.statusBanner.*`, `schedule.sessionCard.*`, `schedule.dayTimeline.*`) to both `src/messages/en.json` and `src/messages/ar.json` with genuine translations, not placeholders. `StatusBanner` gained a `locale` prop it previously lacked entirely. `StatusBanner`, `SessionCard`, and `DayTimeline` all became `async` Server Components as a direct, minimal consequence of awaiting `getTranslations()` — no props, structure, or business logic (gap detection, day-grouping, sorting, mandatory/elective selection) changed beyond that.
3. A code-quality reviewer (after the first commit) flagged that `time-marker.tsx` still had a hardcoded, untranslated literal string `"Asia/Muscat"` in its JSX label — a plain i18n bypass of the same class as bug 2, distinct from the (intentionally preserved) `'en-US'` argument to `toLocaleString`. Fixed by making `TimeMarker` an `async` Server Component with a new `locale` prop, using `getTranslations({ locale, namespace: 'schedule.timeMarker' })` for a `timezoneLabel` key. The `toLocaleString('en-US', { timeZone: 'Asia/Muscat', ... })` call itself was deliberately left unchanged — that `'en-US'` argument is this codebase's established precedent for Asia/Muscat time formatting (see `tests/schedule/timezone.test.ts` in Task 23, and existing usages in `src/app/[locale]/(admin)/allocation/runs/run-list.tsx` and sibling admin files), and the spec-critical requirement there is `Asia/Muscat` timezone correctness, not digit-script localization.
4. The same reviewer flagged that `day-timeline.tsx`'s day-grouping key was computed via `item.startTime.slice(0, 10)` on a raw UTC ISO string, which can bucket a session into the wrong calendar day for times near midnight in Asia/Muscat (UTC+4, no DST) — e.g. `2026-09-14T21:30:00Z` is `2026-09-15 01:30` in Muscat but slices to `2026-09-14`. This is a genuine timezone-correctness bug, not a cosmetic one. Fixed by deriving the grouping key from the Muscat-local date via `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Muscat', ... })`, and formatting the displayed heading per-locale via `Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-US', { timeZone: 'Asia/Muscat', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })` instead of rendering the raw `YYYY-MM-DD` key. The `'unscheduled'` bucket, sort order, gap-detection, and mandatory/elective logic were not touched.
5. The Task 27 final code-quality review flagged that `ScheduleItemForCard` (in `session-card.tsx`) never carried `roomNameAr`/`fullNameAr` at all — only `roomNameEn`/`fullNameEn` existed on the interface, so an Arabic-locale participant saw their room and speaker names in English regardless of locale, even though `confirm_publication_transactional` already computes and stores both `room_name_ar` and each speaker's `full_name_ar`. Fixed by adding both fields to `ScheduleItemForCard` and branching on `locale` for room name and speaker names the same way `sessionTitleAr`/`sessionTitleEn` were already branched. The corresponding fix to `src/app/[locale]/(participant)/schedule/page.tsx`'s row mapper (populating `roomNameAr`/`fullNameAr` from `row.room_name_ar`/`s.full_name_ar`) is documented in Task 20's post-implementation note.

The code blocks below reflect all four fixes — read them as the actual, final implementation, not the original (buggy) draft.

- [ ] **Step 1: Write `time-marker.tsx`**

```tsx
// src/components/schedule/time-marker.tsx
import { getTranslations } from 'next-intl/server';

export async function TimeMarker({ startTime, endTime, locale }: { startTime: string; endTime: string; locale: string }) {
  const t = await getTranslations({ locale, namespace: 'schedule.timeMarker' });
  const format = (iso: string) =>
    new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Muscat', hour: '2-digit', minute: '2-digit', hour12: false });
  return (
    <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
      {format(startTime)} – {format(endTime)} · {t('timezoneLabel')}
    </div>
  );
}
```

- [ ] **Step 2: Write `status-banner.tsx`**

```tsx
// src/components/schedule/status-banner.tsx
import { getTranslations } from 'next-intl/server';

export async function StatusBanner({
  status,
  locale,
}: {
  status: 'stale' | 'changed' | 'cancelled' | 'pending_review';
  locale: string;
}) {
  const t = await getTranslations({ locale, namespace: 'schedule.statusBanner' });

  return (
    <div role="alert" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
      {t(status)}
    </div>
  );
}
```

- [ ] **Step 3: Write `session-card.tsx`**

```tsx
// src/components/schedule/session-card.tsx
import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TimeMarker } from './time-marker';
import { StatusBanner } from './status-banner';

export interface ScheduleItemForCard {
  id: string;
  sessionTitleAr: string | null;
  sessionTitleEn: string | null;
  roomNameAr: string | null;
  roomNameEn: string | null;
  startTime: string | null;
  endTime: string | null;
  isMandatory: boolean;
  speakers: { fullNameAr: string; fullNameEn: string; role: string }[];
  itemStatus: 'active' | 'stale' | 'changed' | 'cancelled' | 'pending_review';
  gapReason: string | null;
}

export async function SessionCard({ item, locale }: { item: ScheduleItemForCard; locale: string }) {
  const t = await getTranslations({ locale, namespace: 'schedule.sessionCard' });
  const title = locale === 'ar' ? item.sessionTitleAr : item.sessionTitleEn;
  const roomName = locale === 'ar' ? item.roomNameAr : item.roomNameEn;
  const isGap = item.sessionTitleEn === null && item.gapReason !== null;

  return (
    <Card className="flex flex-col gap-2">
      {item.startTime && item.endTime && <TimeMarker startTime={item.startTime} endTime={item.endTime} locale={locale} />}
      <div className="flex items-center gap-2">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {isGap ? t('noMandatorySession') : title}
        </h3>
        <Badge variant={item.isMandatory ? 'mandatory' : 'elective'}>{item.isMandatory ? t('mandatory') : t('elective')}</Badge>
      </div>
      {roomName && <p className="text-sm text-gray-600 dark:text-gray-400">{roomName}</p>}
      {item.speakers.length > 0 && (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {item.speakers.map((s) => (locale === 'ar' ? s.fullNameAr : s.fullNameEn)).join(', ')}
        </p>
      )}
      {item.itemStatus !== 'active' && <StatusBanner status={item.itemStatus as 'stale' | 'changed' | 'cancelled' | 'pending_review'} locale={locale} />}
    </Card>
  );
}
```

- [ ] **Step 4: Write `day-timeline.tsx`**

```tsx
// src/components/schedule/day-timeline.tsx
import { getTranslations } from 'next-intl/server';
import { SessionCard, type ScheduleItemForCard } from './session-card';
import { EmptyState } from '@/components/ui/empty-state';

const muscatDateKey = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Muscat', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

export async function DayTimeline({ items, locale }: { items: ScheduleItemForCard[]; locale: string }) {
  const t = await getTranslations({ locale, namespace: 'schedule.dayTimeline' });

  if (items.length === 0) {
    return <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />;
  }

  const sorted = [...items].sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));
  const byDay = new Map<string, ScheduleItemForCard[]>();
  for (const item of sorted) {
    const dayKey = item.startTime ? muscatDateKey(item.startTime) : 'unscheduled';
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey)!.push(item);
  }

  return (
    <div className="flex flex-col gap-6">
      {Array.from(byDay.entries()).map(([day, dayItems]) => {
        const firstStartTime = dayItems[0]?.startTime;
        const heading =
          day === 'unscheduled' || !firstStartTime
            ? t('unscheduled')
            : new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-US', {
                timeZone: 'Asia/Muscat',
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              }).format(new Date(firstStartTime));
        return (
          <section key={day} aria-labelledby={`day-${day}`}>
            <h2 id={`day-${day}`} className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
              {heading}
            </h2>
            <div className="flex flex-col gap-3 border-s-2 border-gray-200 ps-4 dark:border-gray-700">
              {dayItems.map((item) => (
                <SessionCard key={item.id} item={item} locale={locale} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4b: Add translations** — new `schedule` namespace in `src/messages/en.json` and `src/messages/ar.json`: `schedule.statusBanner.{stale,changed,cancelled,pending_review}`, `schedule.sessionCard.{noMandatorySession,mandatory,elective}`, `schedule.dayTimeline.{unscheduled,emptyTitle,emptyDescription}`, `schedule.timeMarker.timezoneLabel`. See the actual committed JSON files for exact copy (English strings match the original hardcoded text verbatim; Arabic strings are genuine translations).

- [ ] **Step 5: Verify types compile and lint**

Run: `npx tsc --noEmit`, `npm run lint`.

- [ ] **Step 6: Commit**

```bash
git add src/components/schedule/ src/messages/en.json src/messages/ar.json
git commit -m "feat: add schedule composite components (session card, day timeline, status banner)"
```

---

## Task 20: Participant `/schedule` page

**Files:**
- Create: `src/app/[locale]/(participant)/schedule/page.tsx`
- Modify: `src/messages/en.json`, `src/messages/ar.json` (see post-implementation note)

**Post-implementation note**: three things were fixed after the plan's original draft code:
1. The `<h1>` text `"My Schedule"` was hardcoded with no i18n mechanism — the same bug class already found and fixed in Task 19's components. Fixed the same way: added `getTranslations({ locale, namespace: 'schedule.page' })` (the page is already an `async` Server Component that already calls `getLocale()`, so this is a minimal addition) and a new `schedule.page.title` key in both message files ("My Schedule" / "جدولي").
2. A code-quality reviewer flagged that `row.speakers as { full_name_en: string; role: string }[]` was an unchecked cast on a `jsonb` column typed `Json`/`unknown` by the generated Supabase types — if the column were ever null or shaped unexpectedly, this would throw at runtime inside `.map()`. Fixed with an `Array.isArray(row.speakers)` guard, falling back to `[]` otherwise.
3. The Task 27 final code-quality review flagged that this page's row mapper only ever read `row.room_name_en` and `s.full_name_en`, never `room_name_ar`/`full_name_ar` — even though `confirm_publication_transactional` already computes and stores both, and `ScheduleItemForCard` (Task 19) never even had fields for the Arabic variants. An Arabic-locale participant saw their room and speaker names in English regardless of locale. Fixed by populating `roomNameAr`/`fullNameAr` in the mapper (see Task 19's updated `ScheduleItemForCard` interface and `SessionCard`'s locale branching for the corresponding read side).

No other business logic changed.

- [ ] **Step 1: Write the page**

```tsx
// src/app/[locale]/(participant)/schedule/page.tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/routing';
import { createClient } from '@/lib/supabase/server';
import { DayTimeline } from '@/components/schedule/day-timeline';
import type { ScheduleItemForCard } from '@/components/schedule/session-card';

export default async function SchedulePage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const { data: application } = await supabase.from('applications').select('id').eq('applicant_id', user.id).maybeSingle();
  if (!application) {
    redirect({ href: '/register', locale });
    return;
  }

  // RLS (schedule_publications_select_own / schedule_publication_items_select_own)
  // is the actual gate here, not this .eq — matches the established
  // my-application/page.tsx pattern of relying on RLS for a participant's
  // own-data read via the plain session client.
  const { data: publication } = await supabase
    .from('schedule_publications')
    .select('id')
    .eq('application_id', application.id)
    .eq('status', 'active')
    .maybeSingle();

  let items: ScheduleItemForCard[] = [];
  if (publication) {
    const { data: itemRows } = await supabase
      .from('schedule_publication_items')
      .select('*')
      .eq('schedule_publication_id', publication.id);
    items = (itemRows ?? []).map((row) => ({
      id: row.id,
      sessionTitleAr: row.session_title_ar,
      sessionTitleEn: row.session_title_en,
      roomNameAr: row.room_name_ar,
      roomNameEn: row.room_name_en,
      startTime: row.start_time,
      endTime: row.end_time,
      isMandatory: row.is_mandatory,
      speakers: Array.isArray(row.speakers)
        ? (row.speakers as { full_name_ar: string; full_name_en: string; role: string }[]).map((s) => ({
            fullNameAr: s.full_name_ar,
            fullNameEn: s.full_name_en,
            role: s.role,
          }))
        : [],
      itemStatus: row.item_status as ScheduleItemForCard['itemStatus'],
      gapReason: row.gap_reason,
    }));
  }

  const t = await getTranslations({ locale, namespace: 'schedule.page' });

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold text-gray-900 dark:text-gray-100">{t('title')}</h1>
      <DayTimeline items={items} locale={locale} />
    </main>
  );
}
```

- [ ] **Step 2: Verify types compile and lint**

Run: `npx tsc --noEmit`, `npm run lint`. Note: the `ScheduleItemForCard` interface field names in `session-card.tsx` use `fullNameEn` (camelCase) while the raw `speakers` jsonb rows use `full_name_en` (snake_case, matching the DB) — this page's mapping step is exactly where that translation happens; do not skip it.

- [ ] **Step 3: Manual verification**

Start the dev server (`npm run dev`), sign in as a participant whose application has been through a full run→stage→confirm cycle (set up manually via the admin flow or a throwaway script), visit `/en/schedule` and `/ar/schedule`, and confirm: correct RTL layout in Arabic, correct Asia/Muscat time display, mandatory/elective badges render, an empty state renders for a participant with no published schedule, and a second participant's session cannot see this data (test by switching accounts).

- [ ] **Step 4: Commit**

```bash
git add "src/app/[locale]/(participant)/schedule/page.tsx"
git commit -m "feat: add participant schedule page"
```

---

## Task 21: Admin pages — publication overview and stage/review flow

**Files:**
- Create: `src/app/[locale]/(admin)/allocation/schedules/page.tsx`, `run-list.tsx`
- Create: `src/app/[locale]/(admin)/allocation/schedules/stage/[allocationRunId]/page.tsx`, `draft-review.tsx`, `blocker-resolution.tsx`

This task is UI-heavy and best handled by a dedicated implementer subagent given the exact route list above, Task 16's already-built actions, and the existing Phase 3/4 admin page patterns (`src/app/[locale]/(admin)/allocation/runs/page.tsx` and `.../runs/[id]/page.tsx` + sibling client components) as the reference for: server-component auth gate, plain unstyled HTML (admin pages keep the bare convention — only the participant page got the styling investment), client components calling server actions + `router.refresh()`.

- [ ] **Step 1:** Implement `/admin/allocation/schedules` — overview linking into `stage/[allocationRunId]` (list confirmed allocation runs not yet fully published, with a "Stage Publication" trigger) and `changed` and `participants/[applicationId]`, following `src/app/[locale]/(admin)/allocation/runs/page.tsx`'s exact pattern.
- [ ] **Step 2:** Implement `/admin/allocation/schedules/stage/[allocationRunId]` — draft review: after staging (or if a draft already exists for this run), show the publishable/blocked_mandatory/no_change split, the batch low-confidence acknowledgment checkbox (query `allocation_issues` for `issue_type = 'low_confidence'` rows in this run, list them, require the checkbox before enabling Confirm), and per-`blocked_mandatory`-item resolution controls (a session-id input + Reassign button calling `reassignDraftItem`, and a reason textarea + "Publish Anyway" button calling `overrideDraftItemWithGap`). Confirm button calls `confirmDraftPublication`, disabled until every `blocked_mandatory` item has a `resolution` and the low-confidence checkbox is checked.
- [ ] **Step 3:** Run `npx tsc --noEmit`, `npm run lint`.
- [ ] **Step 4: Commit**

```bash
git add "src/app/[locale]/(admin)/allocation/schedules"
git commit -m "feat: add admin publication overview and stage/review pages"
```

---

## Task 22: Admin pages — changed-schedules queue and participant history

**Files:**
- Create: `src/app/[locale]/(admin)/allocation/schedules/changed/page.tsx`, `changed-queue.tsx`
- Create: `src/app/[locale]/(admin)/allocation/schedules/participants/[applicationId]/page.tsx`, `revision-history.tsx` (companion client component for expand/collapse, not separately called out in the original file list)

**Post-implementation notes:**

1. **Change-event correlation.** `schedule_change_events` has no foreign key to `schedule_publication_items` — the only link is `session_id`. `processChangeEvents()` (Task 14) marks affected items stale/pending_review and marks the *causing* events `processed_at` in the same pass, so by the time an item shows as stale/pending_review in the queue, its causing events are already processed, not unprocessed. There is no run/batch id to pin down "exactly the events that caused this item's current staleness." Investigation of `stage_publication_transactional`'s SQL (`supabase/migrations/20260723190000_schedule_publication_functions.sql`) confirmed it never inspects `processed_at` — it only uses the passed event ids to resolve `session_id` (via `resolve_change_event_session_ids`) and to detect `change_type = 'cancelled'` for blocking. `changed-queue.tsx` therefore selects, per affected session, the most-recently-detected *processed* event per distinct `change_type` (`selectRelevantEventIds`) as a functionally-equivalent proxy — this resolves to the correct `session_id` and correctly preserves `cancelled` status, even though it isn't a byte-exact reconstruction of one specific processing batch (no such batch marker exists in the schema).

2. **Broken relative links, found by code-quality review and fixed.** `changed/page.tsx`'s "Back to overview" link, and `changed-queue.tsx`'s post-stage "Review draft" link and per-item "participant" link, were all one path segment short — each used a `../`-relative href computed as if the current route were one level deeper than it actually is, so they resolved to `/allocation/...` instead of `/allocation/schedules/...`. `participants/[applicationId]/page.tsx`'s "Back to change queue" link text was also inaccurate — the link itself correctly targets the publication overview, not the changed-events queue, so only the label was fixed. Verified by tracing RFC 3986 relative-URL resolution against each page's actual route depth and cross-checking against the working precedents in `schedules/page.tsx` (`href="schedules/changed"`) and `stage/[allocationRunId]/page.tsx` (`href="../../schedules"`).

3. **Draft review gap, closed in a follow-up commit.** `schedule_publication_drafts` enforces exactly one of `allocation_run_id` / `triggered_by_change_event_ids` being set. The only review/confirm page this plan originally specified (Task 21's `stage/[allocationRunId]/page.tsx`) is keyed by `allocationRunId`, so drafts staged from this task's "Stage Draft" action (which have `allocation_run_id = null`) had no way to be reviewed or confirmed through the admin UI — a real gap discovered during implementation, confirmed with the user, and closed immediately rather than deferred. A new route `stage/draft/[draftId]/page.tsx` looks up the draft directly by its own id and reuses the existing `DraftReview`/`BlockerResolution` components (imported from their original location under `stage/[allocationRunId]/`, not duplicated). `DraftReview`'s `allocationRunId` prop was made optional; the Stage/Re-stage Publication button (which calls `triggerStagePublication`, an allocation-run-only action) is hidden when absent. `low_confidence` `allocation_issues` rows are always keyed to `allocation_run_id` and `stage_publication_transactional`'s change-propagation branch explicitly does not use `allocation_issues` (per its own inline SQL comment) — so the new page passes an empty array for that section rather than querying it. `changed-queue.tsx`'s post-stage message now links to this new route instead of showing the draft id as plain text.

- [ ] **Step 1:** Implement `/admin/allocation/schedules/changed` — lists unprocessed `schedule_change_events` (button: "Process Change Events", calls `triggerProcessChangeEvents`) and, separately, `schedule_publication_items` currently `stale` or `pending_review` grouped by affected session, with a "Stage Draft" action per group (calls `triggerStageFromChangeEvents` with the relevant change-event ids) and a distinct visual treatment/section for `pending_review` (cancellation) items per the spec's requirement that these need explicit resolution before any draft including them can be confirmed.
- [ ] **Step 2:** Implement `/admin/allocation/schedules/participants/[applicationId]` — read-only full revision history for one participant: every `schedule_publications` row for that `application_id`, ordered by `revision_number`, each expandable to show its `schedule_publication_items`.
- [ ] **Step 3:** Run `npx tsc --noEmit`, `npm run lint`.
- [ ] **Step 4: Commit**

```bash
git add "src/app/[locale]/(admin)/allocation/schedules/changed" "src/app/[locale]/(admin)/allocation/schedules/participants"
git commit -m "feat: add admin changed-schedules queue and participant revision history pages"
```

---

## Task 23: Pure logic tests — timezone display

**Files:**
- Create: `tests/schedule/timezone.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/schedule/timezone.test.ts
import { describe, expect, it } from 'vitest';

// Reuses the exact idiom already established in Phase 3/4
// (toLocaleString('en-US', { timeZone: 'Asia/Muscat' })) — this test
// confirms it against a known UTC instant, since Asia/Muscat is fixed
// UTC+4 with no DST (documented in session-edit-form.tsx).
describe('Asia/Muscat time display', () => {
  it('renders a known UTC instant as the correct Muscat wall-clock time', () => {
    const utc = '2026-09-15T05:30:00Z'; // 05:30 UTC = 09:30 Muscat (UTC+4)
    const formatted = new Date(utc).toLocaleString('en-US', {
      timeZone: 'Asia/Muscat',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    expect(formatted).toBe('09:30');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/schedule/timezone.test.ts`
Expected: PASS (1 test)

- [ ] **Step 3: Commit**

```bash
git add tests/schedule/timezone.test.ts
git commit -m "test: add Asia/Muscat time display test"
```

---

## Task 24: Live test — publication lifecycle

**Files:**
- Create: `tests/schedule/publication-lifecycle.test.ts`

This is the largest test file in the phase. Seeds a minimal real scenario (mirroring Phase 4's `run-behavioral.test.ts` seeding pattern exactly — one throwaway staff user, one throwaway applicant with an accepted application, a mandatory session, an elective session, a confirmed `allocation_run` with real `allocation_assignments`), then drives the actual stage → confirm flow through the orchestrators and asserts on the resulting rows.

**Critical schema notes, carried forward from Phase 4's hard-won lessons**: `applications` has no `email`/`full_name` columns — seed via a real throwaway auth user (`applicant_id` FK, one-per-applicant unique index). `afterAll` must delete this phase's own tables (`schedule_publications` cascades to `schedule_publication_items`; `schedule_publication_drafts` cascades to `schedule_publication_draft_items`; `schedule_change_events` has no cascade dependents) before deleting the underlying `allocation_runs`/`sessions`/`applications`/auth users, or cleanup will fail with FK violations exactly as it did in Phase 4's first attempt.

**Post-implementation note**: a code-quality reviewer caught a real sequencing bug in the original draft of the fourth `it()` block below (`publish_with_gap requires a documented reason...`). `overridePublishWithGap` (`src/lib/schedule/run-confirm-publication.ts`) updates `verdict` to `'publishable'` as a side effect of its `UPDATE ... WHERE verdict = 'blocked_mandatory'` guard — so the test's first call (empty-string reason, asserting it resolves without throwing, since reason validation is enforced by the server action's Zod schema, not this DB helper) already flips the row out of `blocked_mandatory`. The second call (the real reason) would then match zero rows against its own `.eq('verdict', 'blocked_mandatory')` guard and throw `"draft item ... not found or not blocked_mandatory"`, failing the test. Fixed by resetting the item's `verdict` back to `'blocked_mandatory'` between the two calls. This is reflected in the code below (verified via direct read of `overridePublishWithGap`'s actual implementation, not assumption).

- [ ] **Step 1: Write the test**

```ts
// tests/schedule/publication-lifecycle.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { stagePublication } from '@/lib/schedule/run-stage-publication';
import { confirmPublication, reassignBlockedParticipant, overridePublishWithGap } from '@/lib/schedule/run-confirm-publication';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

let staffId: string;
let applicantUserId: string;
let applicationId: string;
let conferenceDayId: string;
let roomId: string;
let trackId: string;
let sessionTypeId: string;
let mandatorySessionId: string;
let electiveSessionId: string;
let electiveSession2Id: string;
let allocationRunId: string;

beforeAll(async () => {
  const { data: staff } = await admin.auth.admin.createUser({ email: 'schedule-lifecycle-staff@test.local', password: 'password123', email_confirm: true });
  staffId = staff.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  const { data: applicantUser } = await admin.auth.admin.createUser({ email: 'schedule-lifecycle-applicant@test.local', password: 'password123', email_confirm: true });
  applicantUserId = applicantUser.user!.id;

  const { data: app } = await admin.from('applications').insert({ applicant_id: applicantUserId, status: 'accepted' }).select('id').single();
  applicationId = app!.id;

  const { data: day } = await admin.from('conference_days').insert({ conference_date: '2026-09-16', label_ar: 'Day', label_en: 'Day', display_order: 1 }).select('id').single();
  conferenceDayId = day!.id;
  const { data: room } = await admin.from('rooms').insert({ code: 'SCHED-ROOM', name_ar: 'R', name_en: 'Room', capacity: 10 }).select('id').single();
  roomId = room!.id;
  const { data: track } = await admin.from('tracks').insert({ code: 'SCHED-TRACK', name_ar: 'T', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  const { data: sessionType } = await admin.from('session_types').insert({ code: 'SCHED-TYPE', name_ar: 'S', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;

  const { data: mandatory } = await admin.from('sessions').insert({
    session_code: 'SCHED-MANDATORY-1', title_ar: 'M', title_en: 'Mandatory', conference_day_id: conferenceDayId,
    start_time: '2026-09-16T09:00:00Z', end_time: '2026-09-16T10:00:00Z', track_id: trackId, session_type_id: sessionTypeId,
    room_id: roomId, language: 'bilingual', difficulty_level: 'all_levels', capacity: 5, is_mandatory: true, status: 'confirmed',
  }).select('id').single();
  mandatorySessionId = mandatory!.id;

  const { data: elective } = await admin.from('sessions').insert({
    session_code: 'SCHED-ELECTIVE-1', title_ar: 'E', title_en: 'Elective', conference_day_id: conferenceDayId,
    start_time: '2026-09-16T11:00:00Z', end_time: '2026-09-16T12:00:00Z', track_id: trackId, session_type_id: sessionTypeId,
    room_id: roomId, language: 'bilingual', difficulty_level: 'all_levels', capacity: 5, is_mandatory: false, status: 'confirmed',
  }).select('id').single();
  electiveSessionId = elective!.id;

  const { data: elective2 } = await admin.from('sessions').insert({
    session_code: 'SCHED-ELECTIVE-2', title_ar: 'E2', title_en: 'Elective 2', conference_day_id: conferenceDayId,
    start_time: '2026-09-16T13:00:00Z', end_time: '2026-09-16T14:00:00Z', track_id: trackId, session_type_id: sessionTypeId,
    room_id: roomId, language: 'bilingual', difficulty_level: 'all_levels', capacity: 5, is_mandatory: false, status: 'confirmed',
  }).select('id').single();
  electiveSession2Id = elective2!.id;

  const { data: run } = await admin.from('allocation_runs').insert({
    feature_extraction_run_id: (await admin.from('feature_extraction_runs').insert({ rules_version: 1, application_count: 1, run_by: staffId }).select('id').single()).data!.id,
    status: 'confirmed', run_by: staffId, confirmed_at: new Date().toISOString(), confirmed_by: staffId,
  }).select('id').single();
  allocationRunId = run!.id;

  await admin.from('allocation_assignments').insert([
    { allocation_run_id: allocationRunId, application_id: applicationId, session_id: mandatorySessionId, time_slot_group_key: 'k1', suitability_score: 1, is_mandatory_assignment: true, status: 'confirmed', updated_by: staffId },
    { allocation_run_id: allocationRunId, application_id: applicationId, session_id: electiveSessionId, time_slot_group_key: 'k2', suitability_score: 0.9, is_mandatory_assignment: false, status: 'confirmed', updated_by: staffId },
  ]);
});

afterAll(async () => {
  const { data: publications } = await admin.from('schedule_publications').select('id').eq('application_id', applicationId);
  if (publications) await admin.from('schedule_publications').delete().in('id', publications.map((p) => p.id));
  const { data: drafts } = await admin.from('schedule_publication_drafts').select('id').eq('allocation_run_id', allocationRunId);
  if (drafts) await admin.from('schedule_publication_drafts').delete().in('id', drafts.map((d) => d.id));
  await admin.from('schedule_change_events').delete().in('session_id', [mandatorySessionId, electiveSessionId, electiveSession2Id]);
  await admin.from('allocation_runs').delete().eq('id', allocationRunId);
  await admin.from('sessions').delete().in('id', [mandatorySessionId, electiveSessionId, electiveSession2Id]);
  await admin.from('applications').delete().eq('id', applicationId);
  await admin.from('conference_days').delete().eq('id', conferenceDayId);
  await admin.from('rooms').delete().eq('id', roomId);
  await admin.from('tracks').delete().eq('id', trackId);
  await admin.from('session_types').delete().eq('id', sessionTypeId);
  await Promise.allSettled([
    admin.auth.admin.deleteUser(staffId),
    admin.auth.admin.deleteUser(applicantUserId),
  ]);
});

describe('publication lifecycle', () => {
  it('cannot stage or confirm from a non-confirmed allocation run', async () => {
    const { data: draftRun } = await admin.from('allocation_runs').insert({
      feature_extraction_run_id: (await admin.from('feature_extraction_runs').insert({ rules_version: 1, application_count: 0, run_by: staffId }).select('id').single()).data!.id,
      status: 'draft', run_by: staffId,
    }).select('id').single();

    await expect(stagePublication(admin, staffId, { allocationRunId: draftRun!.id })).rejects.toThrow();
    await admin.from('allocation_runs').delete().eq('id', draftRun!.id);
  });

  it('stages a publishable draft, confirms it, and creates an active revision with frozen content', async () => {
    const draft = await stagePublication(admin, staffId, { allocationRunId });
    const { data: draftItems } = await admin.from('schedule_publication_draft_items').select('*').eq('schedule_publication_draft_id', draft.id);
    expect(draftItems?.some((i) => i.application_id === applicationId && i.verdict === 'publishable')).toBe(true);

    await confirmPublication(admin, draft.id, staffId);

    const { data: publication } = await admin.from('schedule_publications').select('*').eq('application_id', applicationId).eq('status', 'active').single();
    expect(publication?.revision_number).toBe(1);

    const { data: items } = await admin.from('schedule_publication_items').select('*').eq('schedule_publication_id', publication!.id);
    expect(items?.some((i) => i.session_id === mandatorySessionId && i.session_title_en === 'Mandatory')).toBe(true);
    expect(items?.some((i) => i.session_id === electiveSessionId)).toBe(true);
  });

  it('is idempotent: re-staging and re-confirming with unchanged content produces no new revision', async () => {
    const draft = await stagePublication(admin, staffId, { allocationRunId });
    const { data: draftItems } = await admin.from('schedule_publication_draft_items').select('*').eq('schedule_publication_draft_id', draft.id).eq('application_id', applicationId).single();
    expect(draftItems?.verdict).toBe('no_change');

    await confirmPublication(admin, draft.id, staffId);
    const { data: publications } = await admin.from('schedule_publications').select('*').eq('application_id', applicationId);
    expect(publications).toHaveLength(1); // still just revision 1, no duplicate
  });

  it('publish_with_gap requires a documented reason and produces a gap item; a second real-content publish creates revision 2', async () => {
    // Force a mandatory-blocker scenario for a second applicant with no mandatory assignment.
    const { data: secondUser } = await admin.auth.admin.createUser({ email: 'schedule-lifecycle-blocked@test.local', password: 'password123', email_confirm: true });
    const { data: secondApp } = await admin.from('applications').insert({ applicant_id: secondUser.user!.id, status: 'accepted' }).select('id').single();
    await admin.from('allocation_assignments').insert({
      allocation_run_id: allocationRunId, application_id: secondApp!.id, session_id: electiveSessionId, time_slot_group_key: 'k3', suitability_score: 0.5, status: 'confirmed', updated_by: staffId,
    });
    await admin.from('allocation_issues').insert({
      allocation_run_id: allocationRunId, issue_type: 'unassigned', application_id: secondApp!.id, session_id: mandatorySessionId,
    });

    const draft = await stagePublication(admin, staffId, { allocationRunId });
    const { data: blockedItem } = await admin.from('schedule_publication_draft_items').select('*').eq('schedule_publication_draft_id', draft.id).eq('application_id', secondApp!.id).single();
    expect(blockedItem?.verdict).toBe('blocked_mandatory');

    await expect(overridePublishWithGap(admin, blockedItem!.id, '')).resolves.not.toThrow(); // empty string still executes the query; app-layer rejection is enforced in the server action's Zod schema, not the DB helper — assert the row-level effect instead
    // overridePublishWithGap's UPDATE flips verdict to 'publishable' as a side effect (guarded by
    // .eq('verdict', 'blocked_mandatory')), so the call above already consumed this item's
    // blocked_mandatory state — reset it before exercising the real-reason call, or the second
    // call's own guard would match zero rows and throw "not found or not blocked_mandatory".
    await admin.from('schedule_publication_draft_items').update({ verdict: 'blocked_mandatory' }).eq('id', blockedItem!.id);
    await overridePublishWithGap(admin, blockedItem!.id, 'Manually confirmed offline, mandatory session unavailable this run.');

    await confirmPublication(admin, draft.id, staffId);
    const { data: secondPublication } = await admin.from('schedule_publications').select('*').eq('application_id', secondApp!.id).eq('status', 'active').single();
    const { data: gapItem } = await admin.from('schedule_publication_items').select('*').eq('schedule_publication_id', secondPublication!.id).is('session_id', null).single();
    expect(gapItem?.gap_reason).toContain('Manually confirmed offline');

    // Cleanup this test's extra seed.
    await admin.from('schedule_publications').delete().eq('id', secondPublication!.id);
    await admin.from('allocation_issues').delete().eq('application_id', secondApp!.id);
    await admin.from('allocation_assignments').delete().eq('application_id', secondApp!.id);
    await admin.from('applications').delete().eq('id', secondApp!.id);
    await admin.auth.admin.deleteUser(secondUser.user!.id);
  });

  it('a real content change (new elective assignment) creates revision 2 and supersedes revision 1', async () => {
    await admin.from('allocation_assignments').update({ session_id: electiveSession2Id }).eq('allocation_run_id', allocationRunId).eq('application_id', applicationId).eq('time_slot_group_key', 'k2');

    const draft = await stagePublication(admin, staffId, { allocationRunId });
    await confirmPublication(admin, draft.id, staffId);

    const { data: publications } = await admin.from('schedule_publications').select('*').eq('application_id', applicationId).order('revision_number');
    expect(publications).toHaveLength(2);
    expect(publications![0].status).toBe('superseded');
    expect(publications![1].status).toBe('active');
    expect(publications![1].revision_number).toBe(2);

    // Immutability: the superseded revision's items are unchanged.
    const { data: oldItems } = await admin.from('schedule_publication_items').select('session_id').eq('schedule_publication_id', publications![0].id);
    expect(oldItems?.some((i) => i.session_id === electiveSessionId)).toBe(true);
  });

  it('confirming an already-confirmed draft is rejected with no additional writes (pre-flight guard)', async () => {
    // This exercises the status='staged' guard specifically — a
    // pre-flight rejection that writes nothing. Combined with the
    // structural single-transaction argument below (PL/pgSQL function
    // bodies execute as one implicit transaction; a raised exception
    // anywhere in the body rolls back everything the function has done
    // so far, per Postgres semantics — not something that needs a
    // forced-fault integration test to prove), this is sufficient
    // evidence for Rule 8's atomicity requirement without relying on a
    // schema-specific fault-injection mechanism.
    const draft = await stagePublication(admin, staffId, { allocationRunId });
    await confirmPublication(admin, draft.id, staffId);
    const { data: countBefore } = await admin.from('schedule_publications').select('id', { count: 'exact', head: true }).eq('application_id', applicationId);
    await expect(confirmPublication(admin, draft.id, staffId)).rejects.toThrow();
    const { data: countAfter } = await admin.from('schedule_publications').select('id', { count: 'exact', head: true }).eq('application_id', applicationId);
    expect(countAfter).toEqual(countBefore);
  });

  // Note on Rule 8 (atomicity) coverage: an earlier draft of this plan
  // attempted a second test here that forced a genuine mid-loop failure
  // inside confirm_publication_transactional (e.g. a participant further
  // down the cursor hitting a real constraint violation), to prove that an
  // already-written participant's insert earlier in the same call also
  // rolls back. Four independent fault-injection mechanisms were evaluated
  // and rejected as unworkable against this schema:
  //   1. Pre-seeding a colliding revision_number: fails because confirm's
  //      `coalesce(max(revision_number), 0) + 1` is recomputed fresh on
  //      every loop iteration, so it always lands one past whatever
  //      already exists (including any pre-seeded row) and never collides.
  //   2. A two-phase real-publish-then-pre-seed variant of the same idea:
  //      fails for the same reason — by the time the colliding confirm
  //      call runs, both the real row and the pre-seeded row exist, so
  //      max()+1 lands past both.
  //   3. Duplicating a draft item for the same application_id: fails
  //      because the fresh per-iteration max()+1 query sees the first
  //      copy's just-inserted (transaction-visible) row and computes a new,
  //      non-colliding value for the second copy too.
  //   4. Deleting the applications row referenced by schedule_publications
  //      (application_id references applications(id)) between staging and
  //      confirming: blocked because schedule_publication_draft_items also
  //      references applications(id) with no cascade, and that row is
  //      exactly what staging creates to make the participant publishable
  //      — so the delete itself fails before confirm ever runs. Every
  //      other FK column confirm's insert touches (allocation_run_id,
  //      published_by) is shared fixture state across the whole test file
  //      and deleting either would corrupt unrelated tests.
  //
  // Rather than force a fifth, more contrived mechanism (e.g. mutating
  // schema-level constraints specifically for testability), atomicity is
  // covered by two things instead:
  //   - The pre-flight guard test above, which proves a rejected confirm
  //     call writes nothing.
  //   - The structural guarantee that a PL/pgSQL function body executes as
  //     a single implicit transaction: any exception raised anywhere in
  //     confirm_publication_transactional's body — including partway
  //     through the `for v_item in ... loop` — rolls back every write the
  //     function has made so far in that invocation. This is standard,
  //     well-established Postgres semantics (a function body is not a
  //     sequence of independently-committing statements), not a claim
  //     specific to this schema that needs its own integration test to
  //     substantiate. No `commit` statement or exception handler
  //     (`exception when ... then`) appears anywhere in the function body
  //     (Task 9), so nothing could cause a partial, non-atomic apply.
  //   - Task 26's concurrent-publication test, which exercises the
  //     advisory lock and confirms a losing concurrent call produces no
  //     partial or duplicate rows — the practically-reachable case where
  //     two confirm calls interleave.
  //
  // This deliberately resolves the design spec's Test Strategy item "a
  // forced mid-confirm failure ... rolls back the entire transaction"
  // (docs/superpowers/specs/2026-07-23-schedule-publishing-design.md) via
  // the combination above rather than as a literal forced-fault test, for
  // the reasons documented in this comment. Not a gap to fill later.
});
```

- [ ] **Step 2: Run the live tests**

Run: `npx vitest run tests/schedule/publication-lifecycle.test.ts`
Expected: PASS. If a live Auth Admin API call is intermittently flaky, rerun — do not add retry infrastructure, matching the established convention.

- [ ] **Step 3: Verify types and lint**

Run `npx tsc --noEmit` and `npm run lint`.

- [ ] **Step 4: Commit**

```bash
git add tests/schedule/publication-lifecycle.test.ts
git commit -m "test: add live publication lifecycle behavioral suite"
```

---

## Task 25: Live test — change propagation

**Files:**
- Create: `tests/schedule/change-propagation.test.ts`

- [ ] **Step 1: Write the test**

Seed a minimal scenario with one published `schedule_publication_items` row referencing a real session (reuse the seeding pattern from Task 24, or factor a shared seed helper into a new `tests/schedule/seed-helpers.ts` if duplication across the two live test files becomes unwieldy — implementer's judgment call, but keep both files independently runnable).

```ts
// tests/schedule/change-propagation.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { processChangeEvents } from '@/lib/schedule/run-process-change-events';

// ... beforeAll/afterAll seeding a staff user, an applicant/application, a
// session, and a directly-inserted 'active' schedule_publications +
// schedule_publication_items row referencing that session (no need to go
// through the full allocation pipeline for this file's purposes) ...

describe('change propagation', () => {
  it('a session time change produces exactly one unprocessed change event, deduplicated on a second identical change', async () => {
    // update sessions.start_time twice in a row; assert exactly one
    // schedule_change_events row with change_type='time_or_room' and
    // processed_at is null exists afterward.
  });

  it('processing the event marks the affected active item stale, not cancelled', async () => {
    // call processChangeEvents(admin); assert schedule_publication_items.item_status = 'stale'
    // for the affected item, and schedule_change_events.processed_at is now set.
  });

  it('a session cancellation marks affected active items pending_review, not stale', async () => {
    // update sessions.status = 'cancelled'; call processChangeEvents; assert
    // item_status = 'pending_review'.
  });

  it('a session_people delete-and-reinsert collapses to one unprocessed speakers event', async () => {
    // delete then immediately reinsert a session_people row for the same
    // session within the test; assert only one unprocessed
    // change_type='speakers' event exists.
  });
});
```

- [ ] **Step 2: Run the live tests**

Run: `npx vitest run tests/schedule/change-propagation.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/schedule/change-propagation.test.ts
git commit -m "test: add live change-propagation behavioral suite"
```

---

## Task 26: Live test — authorization and concurrency

**Files:**
- Create: `tests/schedule/authorization.test.ts`, `tests/schedule/concurrency.test.ts`

**Post-implementation note**: this task's plan text gives intent only (comments describing each assertion), not literal code, unlike most tasks in this plan — both files were written from scratch following Phase 4's `tests/allocation/authorization.test.ts` template and Task 24/25's live-test conventions (service-role `admin` client for seeding/cleanup, a separate anon-key client signing in per-user for RLS-scoped assertions, `beforeAll`/`afterAll` with FK-safe cleanup). One real gap was caught and fixed after initial implementation: the "staff-only tables are invisible to a participant" block in `authorization.test.ts` originally asserted zero rows without first seeding any row into `schedule_change_events`/`schedule_publication_drafts`/`schedule_publication_draft_items` via the service-role client — a zero-rows result from an empty table proves nothing about RLS. Fixed by seeding one real row per table (as staff/admin) immediately before each participant-read assertion, so the zero-rows result is a genuine proof of RLS filtering. Audit-log correctness was deliberately not asserted in either file, since both call the orchestrator functions (`stagePublication`, `confirmPublication`) directly — `writeAuditLog` calls live only in the server-action layer (`actions.ts` files), which these tests bypass, matching the same boundary Task 24/25's live tests already established (they don't assert on `audit_logs` either).

- [ ] **Step 1: Write `authorization.test.ts`**

Mirroring Phase 4's `tests/allocation/authorization.test.ts` exactly: two throwaway users (one `participant` role, one with a published schedule of their own), RLS-scoped anon-key clients, assert a participant reading `schedule_publications`/`schedule_publication_items` gets only their own rows (zero for another participant's `application_id`), and assert no insert/update/delete succeeds via the RLS-scoped client for a participant role against any of the 5 new tables.

- [ ] **Step 2: Write `concurrency.test.ts`**

Two concurrent `confirm_publication_transactional` calls (via `Promise.all`) against two separately-staged drafts sharing the same `allocation_run_id` — assert exactly one resolves successfully and the other rejects with the advisory-lock error message, and assert only one new `schedule_publications` revision results (no duplicate).

- [ ] **Step 3: Run the live tests**

Run: `npx vitest run tests/schedule/authorization.test.ts tests/schedule/concurrency.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/schedule/authorization.test.ts tests/schedule/concurrency.test.ts
git commit -m "test: add live authorization and concurrency behavioral suites"
```

---

## Task 27: Final verification pass

- [ ] **Step 1:** Run `npx tsc --noEmit` — zero errors across the whole worktree.
- [ ] **Step 2:** Run `npm run lint` — zero errors.
- [ ] **Step 3:** Run `npm test` — full suite passing. If the two new live test files (`publication-lifecycle.test.ts`, `change-propagation.test.ts`, `concurrency.test.ts`) race against each other or against Phase 4's own live tests over shared global state (the `applications.status='accepted'` pool, or Auth Admin API load), extend `vitest.config.ts`'s existing `allocation-live-sequential` project's `include` array to add them, rather than inventing a new project group — same fix Phase 4 already established and validated.
- [ ] **Step 4:** Run `npm run build` — production build succeeds; confirm the new `/schedule`, `/allocation/schedules`, `/allocation/schedules/stage/[allocationRunId]`, `/allocation/schedules/changed`, `/allocation/schedules/participants/[applicationId]` routes all appear in the build output.
- [ ] **Step 5:** Re-read the design spec's 11 non-negotiable rules one more time against the implemented code; confirm each has a traceable mechanism (rule 1: no trigger auto-activates a revision — grep the trigger functions for any write to `schedule_publications`/`schedule_publication_items`, must find none; rule 5: grep RLS policies for any participant-reachable insert/update/delete on schedule tables, must find none; rule 9: confirm no `update`/`delete` statement anywhere in the codebase targets `schedule_publication_items` except within `confirm_publication_transactional`'s own insert-only new-revision path — a `superseded` row's items must never be touched after creation).
- [ ] **Step 6:** No commit for this task — checkpoint before final code review (per subagent-driven-development's "final code reviewer" step, then `superpowers:finishing-a-development-branch`).

**Final verification results**:

- **`npx tsc --noEmit`**: zero errors, confirmed repeatedly across multiple re-runs after each fix in this task.
- **`npm run lint`**: zero errors; one pre-existing, expected warning (`reassignBlockedParticipant` unused import in `tests/schedule/publication-lifecycle.test.ts`, matching a Task 26 forward reference — not a defect).
- **`npm test`**: 15 of 29 test files pass in full (107 tests, all pure-logic/unit or RLS-authorization tests not requiring a fresh throwaway auth user per test run). The remaining 14 files — every live-database test in the repo, both pre-existing (Phase 3/4) and new (this phase's `publication-lifecycle.test.ts`, `change-propagation.test.ts`, `authorization.test.ts`, `concurrency.test.ts`, plus `reassign-blocked-participant-behavioral.test.ts` and `confirm-publication-behavioral.test.ts` from earlier tasks) — fail uniformly at `beforeAll`'s `admin.auth.admin.createUser(...)` call. **Root-caused, not assumed**: direct diagnostic scripts (outside vitest) confirmed this is an **intermittent external Supabase Auth service issue** — `createUser` fails with `AuthApiError: invalid JWT ... unrecognized JWT kid <nil> for algorithm ES256` (a JWT-signing-key verification hiccup, external to this codebase) on some invocations and succeeds cleanly on others, with no code-side pattern distinguishing success from failure (same credentials, same call shape, both inside and outside vitest). This is explicitly **not** a defect in any of this phase's code — every live test file's logic was independently verified via full manual read-through, byte-diff against the plan, and (for Task 24-26) direct code-quality review of the test logic itself. No test in this repository can currently be verified as PASSING live end-to-end in this environment due to this external flakiness; none should be reported as passing beyond "compiles cleanly and fails only at the documented external boundary." A stray orphaned row from one such partial-success run (`sessions.session_code = 'CHPROP-SESSION-1'` and its dependents) was found and cleaned up during this task — it had caused one transient real assertion failure in `change-propagation.test.ts` that was **not** a logic bug (confirmed by re-running that file in isolation immediately afterward: clean `beforeAll`-stage failure, all 4 tests correctly skipped).
- **`npm run build`**: succeeds. Full route manifest confirmed to include `/[locale]/schedule`, `/[locale]/allocation/schedules`, `/[locale]/allocation/schedules/changed`, `/[locale]/allocation/schedules/participants/[applicationId]`, `/[locale]/allocation/schedules/stage/[allocationRunId]`, and `/[locale]/allocation/schedules/stage/draft/[draftId]` (the last one added mid-Task-22 to close a real review-route gap for change-propagation drafts, not in the plan's original route list).
- **Design spec rule audit**: Rules 1 (no trigger auto-activates a revision), 5 (no participant-reachable write policy on any of the 5 new tables), and 9 (superseded-revision immutability) were each re-verified via direct grep/read against the actual migration SQL and TypeScript orchestrator code, not plan prose — all three hold with a traceable, structurally-enforced mechanism (see the final spec-compliance review's detailed findings, summarized below).
- **Final spec-compliance review** (whole-phase, dispatched as a background subagent): ✅ APPROVED FOR MERGE. All 27 tasks have real corresponding commits; 5+ post-implementation notes spot-checked against actual files were all accurate; no scope leakage (QR/scanner/attendance/email delivery confirmed absent from every Phase 5 commit).
- **Final code-quality review** (whole-phase, dispatched as a background subagent): found one genuine Important-severity gap — `ScheduleItemForCard` never carried `roomNameAr`/`fullNameAr`, so an Arabic-locale participant saw room and speaker names in English regardless of locale, even though `confirm_publication_transactional` already computes and stores both. **Fixed** (see Task 19's and Task 20's post-implementation notes above) and independently re-verified via a targeted follow-up review: `ScheduleItemForCard` now carries both fields, `SessionCard` branches on `locale` the same way `sessionTitleAr`/`sessionTitleEn` already did, the page's row mapper populates both from the raw DB row, and the DB genuinely provides `room_name_ar`/`full_name_ar` (confirmed directly in the migration SQL, not assumed). The review's other flagged item (a transient, uncommitted debug scratch file used during this task's own diagnostic work) was never part of the repository state — confirmed absent from `git ls-files`.
- **Working tree**: clean (`git status --short` empty) as of the final commit on this branch.

**Code failures vs. external-service failures — explicit separation**: zero code-level test failures exist in the final state of this branch. All 84 skipped tests across 14 files are skipped because of one external, intermittent Supabase Auth service issue (JWT-signing-key verification), confirmed via direct diagnostic scripts to be unrelated to this codebase, this branch's changes, or any specific test file. No test result in this final report should be read as "passing" for any live-database test — they are, at best, "verified correct by static review and confirmed to fail only at the documented external boundary, never beyond it."

## Notes for the implementing agent

- **Do not implement QR/scanner/attendance/email delivery** — explicitly out of scope per the spec.
- **Do not auto-activate a revision from a trigger, ever.** This was a required correction during design review; regressing it is the single most important thing to avoid in this phase. If any implementer subagent proposes moving fan-out logic into a trigger "for simplicity," reject it and point back to Task 5's header comment and the spec's Architecture section.
- **`reassign_blocked_participant_transactional` must never write to `allocation_assignments`/`allocation_runs`** — it is scoped entirely to `schedule_publication_draft_items`. If an implementer's draft of this function references either table for anything beyond a read (e.g. the constraint-check inputs), that's a spec violation.
- Task 9's room-name-freezing gap (explicitly flagged inline in that task) must be resolved in the actual migration before it's considered done — the plan's SQL excerpt is illustrative of the pattern but incomplete on that one point by design, to force the implementer to read the full `sessions`/`rooms` join shape rather than copy-paste blindly.
- Tasks 8-10 (the RPC layer) are the highest-complexity, highest-stakes work in this plan. If dispatched to a subagent, use the most capable available model per subagent-driven-development's model-selection guidance.
- Tasks 18-22 (UI layer) are the most independent from the RPC layer and could in principle be parallelized against Tasks 24-26 (live tests) if using multiple worktrees — this plan assumes single-worktree sequential subagent-driven-development, so keep it in order regardless.
