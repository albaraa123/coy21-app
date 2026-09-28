# Phase 4: Accepted Participant Clustering & Automatic Session Allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, explainable, reproducible allocation system that clusters already-manually-accepted participants for analytics and computes a draft session allocation staff must explicitly review and confirm — with admission remaining entirely manual throughout.

**Architecture:** Three layers sharing one upstream feature-extraction step: (1) rule-based feature extraction from `applications` into weighted `tags` snapshots, (2) k-means clustering for admin analytics only (does not feed allocation), (3) an allocation engine that hard-filters, cosine-scores, and runs deferred-acceptance stable matching per time-slot group, producing a `draft` run that requires explicit confirmation via one atomic RPC before assignments are final.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (Postgres/Auth/RLS, hosted — no local Docker), `next-intl`, Zod, Vitest (against the live hosted project with real throwaway auth users), PL/pgSQL for the confirmation RPC.

**Spec:** `docs/superpowers/specs/2026-07-23-clustering-allocation-design.md` (passed spec review — read this first for full rationale; this plan implements it exactly, referencing section names rather than re-deriving decisions).

**Worktree:** `.worktrees/allocation-clustering` on branch `allocation-clustering`, branched from `master` at commit `a837947`.

---

## Conventions carried over from Phase 3 (do not re-derive — follow exactly)

- **Server Actions**: colocated per-entity `actions.ts` files under `src/app/[locale]/(admin)/allocation/...`, each `'use server'`, calling `requireAgendaStaffCaller()` from `src/lib/agenda/server-helpers.ts` as the first line of every exported function (no early return may skip this call).
- **Role check**: reuse `isAgendaStaffRole`/`AGENDA_STAFF_ROLES` from `src/lib/validation/agenda.ts` unchanged — no new role, no new file.
- **Service-role client**: all writes and the `applications` read go through `service` returned by `requireAgendaStaffCaller()`. RLS on every new table is defense-in-depth only (staff-only `for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'))`, mirroring `supabase/migrations/20260722201600_agenda_reference_rls_policies.sql`).
- **Audit logging**: call `writeAuditLog(service, {...})` from `src/lib/agenda/server-helpers.ts` after every run/confirm/discard/override — it never throws, logs and continues on its own failure.
- **Migrations**: `supabase/migrations/YYYYMMDDHHMMSS_description.sql`, timestamp after the last Phase 3 migration `20260723070000_document_combined_rpc_conflict_detection.sql`. This plan uses `20260723080000` onward in ~10000-second (≈3hr) increments to leave room; adjust only if a real collision occurs.
- **`updated_at`**: `extensions.moddatetime('updated_at')` trigger on every table that has the column, matching `supabase/migrations/20260722200245_agenda_enums_and_reference_tables.sql:107-112`.
- **Transactional RPC**: `language plpgsql set search_path = public, pg_temp`, `p_`-prefixed params, `v_`-prefixed locals, explicit `raise exception` on invariant violations — mirrors `update_session_and_assignments_transactional` in `supabase/migrations/20260723060000_session_people_transactional_functions.sql`.
- **Testing**: Vitest against the live hosted Supabase project. Throwaway users created via `admin.auth.admin.createUser(...)` in `beforeAll`, deleted via `Promise.allSettled([...admin.auth.admin.deleteUser(...)])` in `afterAll`, matching `tests/agenda/authorization.test.ts`. **Correction to prior-phase assumption**: no retry-wrapper helper exists anywhere in this codebase (verified via grep — zero hits for "retry"/"flaky"). Do not reference or invent one; if a specific live test proves flaky in practice, handle it the same ad hoc way Phase 3 did (rerun), not with new retry infrastructure.
- **No `typecheck` npm script exists.** Use `npx tsc --noEmit` directly. Lint: `npm run lint`. Test: `npm test` (= `vitest run`). Build: `npm run build`.
- Run `npx tsc --noEmit`, `npm run lint`, and `npm test` after every task group below, not just at the end.

## File Structure

```
supabase/migrations/
  20260723080000_feature_extraction_tables.sql
  20260723090000_clustering_tables.sql
  20260723100000_allocation_tables.sql
  20260723110000_allocation_rls_policies.sql
  20260723120000_confirm_allocation_run_function.sql

src/lib/validation/
  allocation.ts                          -- Zod schemas + shared consts (thresholds, enums)

src/lib/allocation/
  feature-extraction.ts                  -- pure: apply rules to one application -> tag weights
  clustering.ts                          -- pure: k-means over feature vectors
  hard-constraints.ts                    -- pure: per-constraint eligibility checks
  scoring.ts                             -- pure: cosine similarity
  time-slot-grouping.ts                  -- pure: connected components + hash key
  deferred-acceptance.ts                 -- pure: stable matching
  issues.ts                              -- pure: derive allocation_issues rows from a completed run's in-memory state
  run-allocation.ts                      -- orchestrator: wires the above into one allocation run (DB reads/writes)
  run-extraction.ts                      -- orchestrator: wires feature-extraction.ts into a DB run
  run-clustering.ts                      -- orchestrator: wires clustering.ts into a DB run

src/app/[locale]/(admin)/allocation/
  page.tsx                               -- overview
  extraction/
    page.tsx
    actions.ts
    rule-manager.tsx
  clustering/
    page.tsx
    actions.ts
    cluster-list.tsx
  runs/
    page.tsx
    actions.ts
    run-list.tsx
    [id]/
      page.tsx
      actions.ts                          -- confirm/discard/override
      assignment-table.tsx
      assignment-detail.tsx
      override-form.tsx
      capacity/
        page.tsx

tests/
  validation/allocation.test.ts
  allocation/feature-extraction.test.ts
  allocation/clustering.test.ts
  allocation/hard-constraints.test.ts
  allocation/scoring.test.ts
  allocation/time-slot-grouping.test.ts
  allocation/deferred-acceptance.test.ts
  allocation/issues.test.ts
  allocation/authorization.test.ts        -- live: unauthorized roles rejected on every server action
  allocation/run-behavioral.test.ts       -- live: bottleneck, no-eligible-sessions, low-confidence boundary, override, immutability
  allocation/reproducibility.test.ts      -- live: identical params twice -> byte-identical output
```

Rationale: pure computational logic (`src/lib/allocation/*.ts`, no DB calls) is separated from DB-orchestrating "run" modules, which is separated again from server actions (`actions.ts`, thin — parse input, call orchestrator, write audit log). This mirrors the spec's own Architecture section (three decoupled layers) and keeps every pure function unit-testable without the live database, per the spec's Testing Requirements #1–4.

---

## Task 1: Feature extraction schema

**Files:**
- Create: `supabase/migrations/20260723080000_feature_extraction_tables.sql`

- [ ] **Step 1: Write the migration**

```sql
-- feature_extraction_tables.sql
create table feature_extraction_rules (
  id uuid primary key default gen_random_uuid(),
  version int not null,
  source_field text not null,
  match_type text not null,
  match_value text not null,
  tag_id uuid not null references tags(id),
  weight numeric not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),

  constraint feature_extraction_rules_match_type_valid check (match_type in ('array_value', 'keyword_substring')),
  constraint feature_extraction_rules_weight_range check (weight >= 0 and weight <= 1),
  constraint feature_extraction_rules_source_field_valid check (
    source_field in ('interests', 'track_interests', 'topics_to_learn', 'participation_goals', 'past_initiatives')
  )
);

create trigger feature_extraction_rules_set_updated_at before update on feature_extraction_rules for each row execute function extensions.moddatetime('updated_at');

create table feature_extraction_runs (
  id uuid primary key default gen_random_uuid(),
  rules_version int not null,
  application_count int not null,
  run_at timestamptz not null default now(),
  run_by uuid not null references profiles(id)
);

create table participant_feature_snapshots (
  id uuid primary key default gen_random_uuid(),
  feature_extraction_run_id uuid not null references feature_extraction_runs(id) on delete cascade,
  application_id uuid not null references applications(id),
  tag_id uuid not null references tags(id),
  weight numeric not null,
  created_at timestamptz not null default now(),

  constraint participant_feature_snapshots_weight_range check (weight >= 0 and weight <= 1),
  constraint participant_feature_snapshots_unique unique (feature_extraction_run_id, application_id, tag_id)
);

create index feature_extraction_rules_source_field_idx on feature_extraction_rules (source_field) where is_active = true;
create index feature_extraction_rules_tag_idx on feature_extraction_rules (tag_id);
create index participant_feature_snapshots_run_idx on participant_feature_snapshots (feature_extraction_run_id);
create index participant_feature_snapshots_application_idx on participant_feature_snapshots (application_id);
create index participant_feature_snapshots_tag_idx on participant_feature_snapshots (tag_id);
```

- [ ] **Step 2: Apply the migration and verify**

Run: `npx supabase db push` (or the project's established migration-apply command — check `package.json`/`AGENTS.md` for the exact one used in Phase 1-3; if none is documented, use `npx supabase migration up` against the linked hosted project).

Verify: `npx supabase db diff` (or equivalent) shows no drift; confirm the three new tables exist via a `select` against the hosted project.

**Rollback/failure behavior**: if this migration fails partway (e.g. constraint typo), Supabase migrations run in a transaction — the whole file rolls back atomically, no partial tables. To roll back after a successful apply, drop the three tables in reverse dependency order (`participant_feature_snapshots`, `feature_extraction_runs`, `feature_extraction_rules`) — safe because nothing else references them yet at this point in the plan.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260723080000_feature_extraction_tables.sql
git commit -m "feat: add feature extraction schema for Phase 4 allocation"
```

---

## Task 2: Clustering schema

**Files:**
- Create: `supabase/migrations/20260723090000_clustering_tables.sql`

- [ ] **Step 1: Write the migration**

```sql
-- clustering_tables.sql
create table clustering_runs (
  id uuid primary key default gen_random_uuid(),
  feature_extraction_run_id uuid not null references feature_extraction_runs(id),
  k int not null,
  random_seed int not null,
  status text not null,
  run_at timestamptz not null default now(),
  run_by uuid not null references profiles(id),

  constraint clustering_runs_k_positive check (k > 0),
  constraint clustering_runs_status_valid check (status in ('completed', 'failed'))
);

create table clusters (
  id uuid primary key default gen_random_uuid(),
  clustering_run_id uuid not null references clustering_runs(id) on delete cascade,
  label text,
  centroid jsonb not null,
  member_count int not null default 0
);

create table cluster_memberships (
  id uuid primary key default gen_random_uuid(),
  cluster_id uuid not null references clusters(id) on delete cascade,
  application_id uuid not null references applications(id),
  distance_to_centroid numeric not null,

  constraint cluster_memberships_unique unique (cluster_id, application_id)
);

create index clustering_runs_feature_run_idx on clustering_runs (feature_extraction_run_id);
create index clusters_clustering_run_idx on clusters (clustering_run_id);
create index cluster_memberships_cluster_idx on cluster_memberships (cluster_id);
create index cluster_memberships_application_idx on cluster_memberships (application_id);
```

- [ ] **Step 2: Apply and verify** (same process as Task 1 Step 2)

**Rollback/failure behavior**: transactional apply, same as Task 1. To roll back: drop `cluster_memberships`, `clusters`, `clustering_runs` in that order.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260723090000_clustering_tables.sql
git commit -m "feat: add clustering schema for Phase 4 allocation"
```

---

## Task 3: Allocation schema

**Files:**
- Create: `supabase/migrations/20260723100000_allocation_tables.sql`

- [ ] **Step 1: Write the migration**

```sql
-- allocation_tables.sql
create table allocation_runs (
  id uuid primary key default gen_random_uuid(),
  feature_extraction_run_id uuid not null references feature_extraction_runs(id),
  status text not null default 'draft',
  run_at timestamptz not null default now(),
  run_by uuid not null references profiles(id),
  confirmed_at timestamptz,
  confirmed_by uuid references profiles(id),

  constraint allocation_runs_status_valid check (status in ('draft', 'confirmed', 'discarded'))
);

create table allocation_assignments (
  id uuid primary key default gen_random_uuid(),
  allocation_run_id uuid not null references allocation_runs(id) on delete cascade,
  application_id uuid not null references applications(id),
  session_id uuid not null references sessions(id),
  time_slot_group_key text not null,
  suitability_score numeric not null,
  is_low_confidence boolean not null default false,
  is_mandatory_assignment boolean not null default false,
  is_manual_override boolean not null default false,
  overridden_by uuid references profiles(id),
  override_reason text,
  status text not null default 'proposed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),

  constraint allocation_assignments_status_valid check (status in ('proposed', 'confirmed')),
  constraint allocation_assignments_score_range check (suitability_score >= 0 and suitability_score <= 1),
  constraint allocation_assignments_unique unique (allocation_run_id, application_id, time_slot_group_key)
);

create trigger allocation_assignments_set_updated_at before update on allocation_assignments for each row execute function extensions.moddatetime('updated_at');

create table allocation_alternatives (
  id uuid primary key default gen_random_uuid(),
  allocation_assignment_id uuid not null references allocation_assignments(id) on delete cascade,
  session_id uuid not null references sessions(id),
  suitability_score numeric not null,
  rank int not null,

  constraint allocation_alternatives_score_range check (suitability_score >= 0 and suitability_score <= 1),
  constraint allocation_alternatives_rank_positive check (rank > 0)
);

create table allocation_issues (
  id uuid primary key default gen_random_uuid(),
  allocation_run_id uuid not null references allocation_runs(id) on delete cascade,
  issue_type text not null,
  application_id uuid references applications(id),
  session_id uuid references sessions(id),
  details jsonb,
  created_at timestamptz not null default now(),

  constraint allocation_issues_type_valid check (
    issue_type in ('unassigned', 'low_confidence', 'capacity_bottleneck', 'schedule_conflict', 'no_eligible_sessions')
  )
);

create table allocation_assignment_explanations (
  id uuid primary key default gen_random_uuid(),
  allocation_assignment_id uuid not null references allocation_assignments(id) on delete cascade,
  constraint_type text not null,
  passed boolean not null,
  detail text not null
);

create index allocation_runs_feature_run_idx on allocation_runs (feature_extraction_run_id);
create index allocation_runs_status_idx on allocation_runs (status);
create index allocation_assignments_run_idx on allocation_assignments (allocation_run_id);
create index allocation_assignments_application_idx on allocation_assignments (application_id);
create index allocation_assignments_session_idx on allocation_assignments (session_id);
create index allocation_alternatives_assignment_idx on allocation_alternatives (allocation_assignment_id);
create index allocation_issues_run_idx on allocation_issues (allocation_run_id);
create index allocation_issues_type_idx on allocation_issues (issue_type);
create index allocation_assignment_explanations_assignment_idx on allocation_assignment_explanations (allocation_assignment_id);
```

- [ ] **Step 2: Apply and verify** (same process as Task 1 Step 2)

**Rollback/failure behavior**: transactional apply. To roll back: drop `allocation_assignment_explanations`, `allocation_issues`, `allocation_alternatives`, `allocation_assignments`, `allocation_runs` in that order.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260723100000_allocation_tables.sql
git commit -m "feat: add allocation schema for Phase 4"
```

---

## Task 4: RLS policies for all new tables

**Files:**
- Create: `supabase/migrations/20260723110000_allocation_rls_policies.sql`

- [ ] **Step 1: Write the migration**

```sql
-- allocation_rls_policies.sql
alter table feature_extraction_rules enable row level security;
alter table feature_extraction_runs enable row level security;
alter table participant_feature_snapshots enable row level security;
alter table clustering_runs enable row level security;
alter table clusters enable row level security;
alter table cluster_memberships enable row level security;
alter table allocation_runs enable row level security;
alter table allocation_assignments enable row level security;
alter table allocation_alternatives enable row level security;
alter table allocation_issues enable row level security;
alter table allocation_assignment_explanations enable row level security;

-- Staff-only for all, defense-in-depth only — the operative gate for every
-- write is requireAgendaStaffCaller() in the server action, which uses the
-- service-role client (bypasses RLS entirely). Mirrors
-- supabase/migrations/20260722201600_agenda_reference_rls_policies.sql.
create policy feature_extraction_rules_staff_all on feature_extraction_rules
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy feature_extraction_runs_staff_all on feature_extraction_runs
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy participant_feature_snapshots_staff_all on participant_feature_snapshots
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy clustering_runs_staff_all on clustering_runs
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy clusters_staff_all on clusters
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy cluster_memberships_staff_all on cluster_memberships
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy allocation_runs_staff_all on allocation_runs
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy allocation_assignments_staff_all on allocation_assignments
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy allocation_alternatives_staff_all on allocation_alternatives
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy allocation_issues_staff_all on allocation_issues
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy allocation_assignment_explanations_staff_all on allocation_assignment_explanations
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
```

- [ ] **Step 2: Apply and verify.** Confirm via a quick manual check (or a throwaway-user test run ahead of Task 13) that a non-staff role is rejected by RLS on a direct `select`.

**Rollback/failure behavior**: transactional apply; to roll back, `drop policy` each one then `alter table ... disable row level security` for all eleven tables.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260723110000_allocation_rls_policies.sql
git commit -m "feat: add RLS policies for Phase 4 allocation tables"
```

---

## Task 5: Shared validation module and constants

**Files:**
- Create: `src/lib/validation/allocation.ts`
- Test: `tests/validation/allocation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/validation/allocation.test.ts
import { describe, expect, it } from 'vitest';
import {
  ALTERNATIVES_COUNT,
  LOW_CONFIDENCE_THRESHOLD,
  extractionRuleSchema,
  overrideAssignmentSchema,
} from '@/lib/validation/allocation';

describe('allocation constants', () => {
  it('has the fixed constants from the spec', () => {
    expect(ALTERNATIVES_COUNT).toBe(5);
    expect(LOW_CONFIDENCE_THRESHOLD).toBe(0.4);
  });
});

describe('extractionRuleSchema', () => {
  it('accepts a valid array_value rule', () => {
    const result = extractionRuleSchema.parse({
      sourceField: 'interests',
      matchType: 'array_value',
      matchValue: 'climate-policy',
      tagId: '00000000-0000-0000-0000-000000000001',
      weight: 0.5,
    });
    expect(result.weight).toBe(0.5);
  });

  it('rejects weight out of range', () => {
    expect(() =>
      extractionRuleSchema.parse({
        sourceField: 'interests',
        matchType: 'array_value',
        matchValue: 'x',
        tagId: '00000000-0000-0000-0000-000000000001',
        weight: 1.5,
      })
    ).toThrow();
  });

  it('rejects an unrecognized source field', () => {
    expect(() =>
      extractionRuleSchema.parse({
        sourceField: 'special_needs',
        matchType: 'array_value',
        matchValue: 'x',
        tagId: '00000000-0000-0000-0000-000000000001',
        weight: 0.5,
      })
    ).toThrow();
  });
});

describe('overrideAssignmentSchema', () => {
  it('requires a non-empty override reason', () => {
    expect(() =>
      overrideAssignmentSchema.parse({
        sessionId: '00000000-0000-0000-0000-000000000002',
        overrideReason: '',
      })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/validation/allocation.test.ts`
Expected: FAIL with "Cannot find module '@/lib/validation/allocation'"

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/validation/allocation.ts
import { z } from 'zod';

// Fixed constants per the spec's "Allocation Algorithm" step on alternatives
// and low-confidence flagging — not admin-configurable, not stored per-run.
export const ALTERNATIVES_COUNT = 5;
export const LOW_CONFIDENCE_THRESHOLD = 0.4;

export const EXTRACTABLE_SOURCE_FIELDS = [
  'interests',
  'track_interests',
  'topics_to_learn',
  'participation_goals',
  'past_initiatives',
] as const;

export const MATCH_TYPES = ['array_value', 'keyword_substring'] as const;

export const ARRAY_SOURCE_FIELDS = ['interests', 'track_interests'] as const;
export const FREE_TEXT_SOURCE_FIELDS = ['topics_to_learn', 'participation_goals', 'past_initiatives'] as const;

export const extractionRuleSchema = z.object({
  sourceField: z.enum(EXTRACTABLE_SOURCE_FIELDS),
  matchType: z.enum(MATCH_TYPES),
  matchValue: z.string().min(1),
  tagId: z.string().uuid(),
  weight: z.number().min(0).max(1),
});

export const overrideAssignmentSchema = z.object({
  sessionId: z.string().uuid(),
  overrideReason: z.string().min(1, 'Override reason is required'),
});

export const triggerExtractionSchema = z.object({
  rulesVersion: z.number().int().positive().optional(),
});

export const triggerClusteringSchema = z.object({
  featureExtractionRunId: z.string().uuid(),
  k: z.number().int().positive(),
  randomSeed: z.number().int(),
});

export const triggerAllocationRunSchema = z.object({
  featureExtractionRunId: z.string().uuid(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/validation/allocation.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/allocation.ts tests/validation/allocation.test.ts
git commit -m "feat: add allocation validation schemas and fixed constants"
```

---

## Task 6: Feature extraction — pure logic

**Files:**
- Create: `src/lib/allocation/feature-extraction.ts`
- Test: `tests/allocation/feature-extraction.test.ts`

Implements the spec's "Feature Extraction Rules" section: array-exact-match, keyword-substring match, per-tag weight summing by distinct matching rule id (not occurrence count), clamped to 1.0.

- [ ] **Step 1: Write the failing test**

```ts
// tests/allocation/feature-extraction.test.ts
import { describe, expect, it } from 'vitest';
import { extractFeatures, type ExtractionRule, type ApplicationForExtraction } from '@/lib/allocation/feature-extraction';

const rules: ExtractionRule[] = [
  { id: 'rule-1', sourceField: 'interests', matchType: 'array_value', matchValue: 'climate-policy', tagId: 'tag-climate', weight: 0.6 },
  { id: 'rule-2', sourceField: 'topics_to_learn', matchType: 'keyword_substring', matchValue: 'policy', tagId: 'tag-climate', weight: 0.5 },
  { id: 'rule-3', sourceField: 'topics_to_learn', matchType: 'keyword_substring', matchValue: 'renewable', tagId: 'tag-energy', weight: 0.7 },
];

describe('extractFeatures', () => {
  it('matches an array_value rule exactly', () => {
    const app: ApplicationForExtraction = { interests: ['climate-policy'], trackInterests: [], topicsToLearn: null, participationGoals: null, pastInitiatives: null };
    const result = extractFeatures(app, rules);
    expect(result).toEqual([{ tagId: 'tag-climate', weight: 0.6 }]);
  });

  it('matches a keyword_substring rule case-insensitively', () => {
    const app: ApplicationForExtraction = { interests: [], trackInterests: [], topicsToLearn: 'I want to learn about RENEWABLE energy', participationGoals: null, pastInitiatives: null };
    const result = extractFeatures(app, rules);
    expect(result).toEqual([{ tagId: 'tag-energy', weight: 0.7 }]);
  });

  it('sums weights from distinct matching rules for the same tag, clamped to 1.0', () => {
    const app: ApplicationForExtraction = {
      interests: ['climate-policy'],
      trackInterests: [],
      topicsToLearn: 'more about policy please',
      participationGoals: null,
      pastInitiatives: null,
    };
    const result = extractFeatures(app, rules);
    // rule-1 (0.6) + rule-2 (0.5) = 1.1, clamped to 1.0
    expect(result).toEqual([{ tagId: 'tag-climate', weight: 1.0 }]);
  });

  it('does not double-count a rule matching multiple times in one field', () => {
    const dupRules: ExtractionRule[] = [
      { id: 'rule-4', sourceField: 'topics_to_learn', matchType: 'keyword_substring', matchValue: 'policy', tagId: 'tag-climate', weight: 0.4 },
    ];
    const app: ApplicationForExtraction = { interests: [], trackInterests: [], topicsToLearn: 'policy policy policy', participationGoals: null, pastInitiatives: null };
    const result = extractFeatures(app, dupRules);
    expect(result).toEqual([{ tagId: 'tag-climate', weight: 0.4 }]);
  });

  it('produces no rows for zero-weight (no match) tags', () => {
    const app: ApplicationForExtraction = { interests: [], trackInterests: [], topicsToLearn: null, participationGoals: null, pastInitiatives: null };
    const result = extractFeatures(app, rules);
    expect(result).toEqual([]);
  });

  it('ignores inactive rules', () => {
    const inactiveRules: ExtractionRule[] = [
      { id: 'rule-5', sourceField: 'interests', matchType: 'array_value', matchValue: 'climate-policy', tagId: 'tag-climate', weight: 0.6, isActive: false },
    ];
    const app: ApplicationForExtraction = { interests: ['climate-policy'], trackInterests: [], topicsToLearn: null, participationGoals: null, pastInitiatives: null };
    const result = extractFeatures(app, inactiveRules);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/allocation/feature-extraction.test.ts`
Expected: FAIL with "Cannot find module '@/lib/allocation/feature-extraction'"

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/allocation/feature-extraction.ts
export interface ExtractionRule {
  id: string;
  sourceField: 'interests' | 'track_interests' | 'topics_to_learn' | 'participation_goals' | 'past_initiatives';
  matchType: 'array_value' | 'keyword_substring';
  matchValue: string;
  tagId: string;
  weight: number;
  isActive?: boolean;
}

export interface ApplicationForExtraction {
  interests: string[] | null;
  trackInterests: string[] | null;
  topicsToLearn: string | null;
  participationGoals: string | null;
  pastInitiatives: string | null;
}

export interface ExtractedFeature {
  tagId: string;
  weight: number;
}

const ARRAY_FIELDS = new Set(['interests', 'track_interests']);

function fieldValue(app: ApplicationForExtraction, field: ExtractionRule['sourceField']): string[] | string | null {
  switch (field) {
    case 'interests':
      return app.interests;
    case 'track_interests':
      return app.trackInterests;
    case 'topics_to_learn':
      return app.topicsToLearn;
    case 'participation_goals':
      return app.participationGoals;
    case 'past_initiatives':
      return app.pastInitiatives;
  }
}

function ruleMatches(app: ApplicationForExtraction, rule: ExtractionRule): boolean {
  const value = fieldValue(app, rule.sourceField);
  if (value == null) return false;

  if (rule.matchType === 'array_value') {
    if (!ARRAY_FIELDS.has(rule.sourceField) || !Array.isArray(value)) return false;
    return value.includes(rule.matchValue);
  }

  // keyword_substring: case-insensitive substring match on a free-text field.
  if (typeof value !== 'string') return false;
  return value.toLowerCase().includes(rule.matchValue.toLowerCase());
}

// Sums weight per distinct matching rule id per tag (a rule contributes its
// weight at most once, regardless of how many times its keyword occurs
// within a field), across all source fields, then clamps to 1.0. Matches
// spec section "Feature Extraction Rules".
export function extractFeatures(app: ApplicationForExtraction, rules: ExtractionRule[]): ExtractedFeature[] {
  const weightByTag = new Map<string, number>();

  for (const rule of rules) {
    if (rule.isActive === false) continue;
    if (!ruleMatches(app, rule)) continue;
    weightByTag.set(rule.tagId, (weightByTag.get(rule.tagId) ?? 0) + rule.weight);
  }

  return Array.from(weightByTag.entries())
    .map(([tagId, weight]) => ({ tagId, weight: Math.min(weight, 1.0) }))
    .filter((f) => f.weight > 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/allocation/feature-extraction.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/allocation/feature-extraction.ts tests/allocation/feature-extraction.test.ts
git commit -m "feat: add pure feature extraction logic"
```

---

## Task 7: Clustering — pure k-means logic

**Files:**
- Create: `src/lib/allocation/clustering.ts`
- Test: `tests/allocation/clustering.test.ts`

Implements the spec's chosen clustering algorithm: k-means with a fixed seed, over sparse tag-weight vectors, deterministic given identical input.

- [ ] **Step 1: Write the failing test**

```ts
// tests/allocation/clustering.test.ts
import { describe, expect, it } from 'vitest';
import { runKMeans, type FeatureVector } from '@/lib/allocation/clustering';

const vectors: FeatureVector[] = [
  { applicationId: 'app-1', weights: { 'tag-a': 1.0 } },
  { applicationId: 'app-2', weights: { 'tag-a': 0.9 } },
  { applicationId: 'app-3', weights: { 'tag-b': 1.0 } },
  { applicationId: 'app-4', weights: { 'tag-b': 0.8 } },
];

describe('runKMeans', () => {
  it('is deterministic: identical seed+k+input produces byte-identical output across repeated invocations', () => {
    const first = runKMeans(vectors, 2, 42);
    const second = runKMeans(vectors, 2, 42);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('groups clearly separated points into distinct clusters', () => {
    const result = runKMeans(vectors, 2, 42);
    expect(result.clusters).toHaveLength(2);
    const clusterOfApp1 = result.memberships.find((m) => m.applicationId === 'app-1')!.clusterIndex;
    const clusterOfApp2 = result.memberships.find((m) => m.applicationId === 'app-2')!.clusterIndex;
    const clusterOfApp3 = result.memberships.find((m) => m.applicationId === 'app-3')!.clusterIndex;
    expect(clusterOfApp1).toBe(clusterOfApp2);
    expect(clusterOfApp1).not.toBe(clusterOfApp3);
  });

  it('produces a centroid and member_count consistent with membership rows', () => {
    const result = runKMeans(vectors, 2, 42);
    for (const cluster of result.clusters) {
      const memberCount = result.memberships.filter((m) => m.clusterIndex === cluster.index).length;
      expect(cluster.memberCount).toBe(memberCount);
    }
  });

  it('a different seed may change assignment but the function remains a pure deterministic function of its inputs', () => {
    const a = runKMeans(vectors, 2, 1);
    const b = runKMeans(vectors, 2, 1);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/allocation/clustering.test.ts`
Expected: FAIL with "Cannot find module '@/lib/allocation/clustering'"

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/allocation/clustering.ts
export interface FeatureVector {
  applicationId: string;
  weights: Record<string, number>; // tagId -> weight, sparse
}

export interface KMeansCluster {
  index: number;
  centroid: Record<string, number>;
  memberCount: number;
}

export interface KMeansMembership {
  applicationId: string;
  clusterIndex: number;
  distanceToCentroid: number;
}

export interface KMeansResult {
  clusters: KMeansCluster[];
  memberships: KMeansMembership[];
}

// Simple mulberry32 PRNG for a fully deterministic, dependency-free seeded
// random sequence — the spec requires "identical seed+k+input -> byte
// identical output", which rules out Math.random.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function allTagIds(vectors: FeatureVector[]): string[] {
  const tags = new Set<string>();
  for (const v of vectors) for (const tagId of Object.keys(v.weights)) tags.add(tagId);
  return Array.from(tags).sort();
}

function euclideanDistance(a: Record<string, number>, b: Record<string, number>, tagIds: string[]): number {
  let sum = 0;
  for (const tagId of tagIds) {
    const diff = (a[tagId] ?? 0) - (b[tagId] ?? 0);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

const MAX_ITERATIONS = 100;

// K-means with a fixed seed over sparse tag-weight vectors. Analytical/
// reporting only per spec — never feeds allocation.
export function runKMeans(vectors: FeatureVector[], k: number, randomSeed: number): KMeansResult {
  const tagIds = allTagIds(vectors);
  const rand = mulberry32(randomSeed);

  // Deterministic seeded initial centroids: shuffle vector indices with the
  // seeded PRNG, take the first k as starting centroids.
  const indices = vectors.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  let centroids: Record<string, number>[] = indices.slice(0, k).map((i) => ({ ...vectors[i].weights }));

  let assignment: number[] = new Array(vectors.length).fill(0);

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;
    const nextAssignment = vectors.map((v) => {
      let best = 0;
      let bestDist = Infinity;
      centroids.forEach((c, ci) => {
        const d = euclideanDistance(v.weights, c, tagIds);
        if (d < bestDist) {
          bestDist = d;
          best = ci;
        }
      });
      return best;
    });

    if (nextAssignment.some((v, i) => v !== assignment[i])) changed = true;
    assignment = nextAssignment;

    const nextCentroids: Record<string, number>[] = centroids.map(() => ({}));
    const counts = new Array(k).fill(0);
    vectors.forEach((v, i) => {
      const ci = assignment[i];
      counts[ci]++;
      for (const tagId of tagIds) {
        nextCentroids[ci][tagId] = (nextCentroids[ci][tagId] ?? 0) + (v.weights[tagId] ?? 0);
      }
    });
    centroids = nextCentroids.map((sum, ci) => {
      if (counts[ci] === 0) return centroids[ci]; // keep stale centroid for an empty cluster
      const avg: Record<string, number> = {};
      for (const tagId of tagIds) avg[tagId] = sum[tagId] / counts[ci];
      return avg;
    });

    if (!changed) break;
  }

  const clusters: KMeansCluster[] = centroids.map((centroid, index) => ({
    index,
    centroid,
    memberCount: assignment.filter((a) => a === index).length,
  }));

  const memberships: KMeansMembership[] = vectors.map((v, i) => ({
    applicationId: v.applicationId,
    clusterIndex: assignment[i],
    distanceToCentroid: euclideanDistance(v.weights, centroids[assignment[i]], tagIds),
  }));

  return { clusters, memberships };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/allocation/clustering.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/allocation/clustering.ts tests/allocation/clustering.test.ts
git commit -m "feat: add deterministic seeded k-means clustering"
```

---

## Task 8: Hard constraints — pure logic

**Files:**
- Create: `src/lib/allocation/hard-constraints.ts`
- Test: `tests/allocation/hard-constraints.test.ts`

Implements spec's "Hard Constraints" section exactly, including the null/out-of-vocabulary fallback rules (language matches any; experience_level falls back to `beginner` tier).

- [ ] **Step 1: Write the failing test**

```ts
// tests/allocation/hard-constraints.test.ts
import { describe, expect, it } from 'vitest';
import { checkStaticHardConstraints, type ParticipantForConstraints, type SessionForConstraints } from '@/lib/allocation/hard-constraints';

const baseSession: SessionForConstraints = {
  id: 'session-1',
  status: 'confirmed',
  includeInAllocation: true,
  language: 'ar',
  difficultyLevel: 'beginner',
  isMandatory: false,
};

const baseParticipant: ParticipantForConstraints = {
  applicationId: 'app-1',
  preferredLanguage: 'ar',
  experienceLevel: 'beginner',
};

describe('checkStaticHardConstraints', () => {
  it('passes when every constraint matches', () => {
    const result = checkStaticHardConstraints(baseParticipant, baseSession);
    expect(result.eligible).toBe(true);
  });

  it('fails when session is not confirmed', () => {
    const result = checkStaticHardConstraints(baseParticipant, { ...baseSession, status: 'draft' });
    expect(result.eligible).toBe(false);
    expect(result.checks.find((c) => c.constraintType === 'confirmed_status')?.passed).toBe(false);
  });

  it('fails when include_in_allocation is false', () => {
    const result = checkStaticHardConstraints(baseParticipant, { ...baseSession, includeInAllocation: false });
    expect(result.eligible).toBe(false);
  });

  it('passes on bilingual session regardless of participant language', () => {
    const result = checkStaticHardConstraints({ ...baseParticipant, preferredLanguage: 'en' }, { ...baseSession, language: 'bilingual' });
    expect(result.checks.find((c) => c.constraintType === 'language_match')?.passed).toBe(true);
  });

  it('fails on a language mismatch', () => {
    const result = checkStaticHardConstraints({ ...baseParticipant, preferredLanguage: 'en' }, { ...baseSession, language: 'ar' });
    expect(result.checks.find((c) => c.constraintType === 'language_match')?.passed).toBe(false);
  });

  it('treats null preferred_language as matching any language', () => {
    const result = checkStaticHardConstraints({ ...baseParticipant, preferredLanguage: null }, { ...baseSession, language: 'en' });
    expect(result.checks.find((c) => c.constraintType === 'language_match')?.passed).toBe(true);
  });

  it('treats an out-of-vocabulary preferred_language as matching any language', () => {
    const result = checkStaticHardConstraints({ ...baseParticipant, preferredLanguage: 'fr' }, { ...baseSession, language: 'en' });
    expect(result.checks.find((c) => c.constraintType === 'language_match')?.passed).toBe(true);
  });

  it('allows adjacent-tier difficulty (beginner participant eligible for intermediate session)', () => {
    const result = checkStaticHardConstraints(baseParticipant, { ...baseSession, difficultyLevel: 'intermediate' });
    expect(result.checks.find((c) => c.constraintType === 'difficulty_match')?.passed).toBe(true);
  });

  it('rejects non-adjacent-tier difficulty (beginner participant not eligible for advanced session)', () => {
    const result = checkStaticHardConstraints(baseParticipant, { ...baseSession, difficultyLevel: 'advanced' });
    expect(result.checks.find((c) => c.constraintType === 'difficulty_match')?.passed).toBe(false);
  });

  it('all_levels sessions are always difficulty-eligible', () => {
    const result = checkStaticHardConstraints({ ...baseParticipant, experienceLevel: 'expert' }, { ...baseSession, difficultyLevel: 'all_levels' });
    expect(result.checks.find((c) => c.constraintType === 'difficulty_match')?.passed).toBe(true);
  });

  it('treats null experience_level as beginner tier (most inclusive)', () => {
    const result = checkStaticHardConstraints({ ...baseParticipant, experienceLevel: null }, { ...baseSession, difficultyLevel: 'intermediate' });
    expect(result.checks.find((c) => c.constraintType === 'difficulty_match')?.passed).toBe(true);
  });

  it('treats an out-of-vocabulary experience_level as beginner tier', () => {
    const result = checkStaticHardConstraints({ ...baseParticipant, experienceLevel: 'guru' }, { ...baseSession, difficultyLevel: 'advanced' });
    expect(result.checks.find((c) => c.constraintType === 'difficulty_match')?.passed).toBe(false);
  });

  it('mandatory sessions are flagged as excluded from this pipeline', () => {
    const result = checkStaticHardConstraints(baseParticipant, { ...baseSession, isMandatory: true });
    expect(result.excludedAsMandatory).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/allocation/hard-constraints.test.ts`
Expected: FAIL with "Cannot find module '@/lib/allocation/hard-constraints'"

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/allocation/hard-constraints.ts
export type SessionLanguage = 'ar' | 'en' | 'bilingual';
export type SessionDifficulty = 'beginner' | 'intermediate' | 'advanced' | 'all_levels';
export type SessionStatus = 'draft' | 'published' | 'confirmed' | 'cancelled' | 'completed';

export interface SessionForConstraints {
  id: string;
  status: SessionStatus;
  includeInAllocation: boolean;
  language: SessionLanguage;
  difficultyLevel: SessionDifficulty;
  isMandatory: boolean;
}

export interface ParticipantForConstraints {
  applicationId: string;
  preferredLanguage: string | null;
  experienceLevel: string | null;
}

export interface ConstraintCheck {
  constraintType: 'confirmed_status' | 'include_in_allocation' | 'language_match' | 'difficulty_match';
  passed: boolean;
  detail: string;
}

export interface StaticConstraintResult {
  eligible: boolean;
  checks: ConstraintCheck[];
  excludedAsMandatory: boolean;
}

const RECOGNIZED_LANGUAGES = new Set(['ar', 'en']);
const RECOGNIZED_EXPERIENCE_LEVELS = new Set(['none', 'beginner', 'intermediate', 'expert']);

// none/beginner -> beginner, intermediate -> intermediate, expert -> advanced.
// Unrecognized/null falls back to 'beginner' — the most inclusive
// non-all_levels mapping (spec: Hard Constraints, constraint 5).
function experienceToTier(experienceLevel: string | null): SessionDifficulty {
  if (experienceLevel === 'intermediate') return 'intermediate';
  if (experienceLevel === 'expert') return 'advanced';
  return 'beginner'; // none, beginner, null, or unrecognized
}

const TIER_ORDER: SessionDifficulty[] = ['beginner', 'intermediate', 'advanced'];

function isAdjacentOrEqualTier(participantTier: SessionDifficulty, sessionTier: SessionDifficulty): boolean {
  if (sessionTier === 'all_levels') return true;
  const pIndex = TIER_ORDER.indexOf(participantTier);
  const sIndex = TIER_ORDER.indexOf(sessionTier);
  return Math.abs(pIndex - sIndex) <= 1;
}

// Static constraints only (1, 2, 4, 5 per spec) — capacity (3) is dynamic and
// checked during deferred acceptance / mandatory pass, not here.
export function checkStaticHardConstraints(
  participant: ParticipantForConstraints,
  session: SessionForConstraints
): StaticConstraintResult {
  const checks: ConstraintCheck[] = [];

  const confirmedStatus = session.status === 'confirmed';
  checks.push({
    constraintType: 'confirmed_status',
    passed: confirmedStatus,
    detail: confirmedStatus ? `Session status is 'confirmed'` : `Session status '${session.status}' is not 'confirmed'`,
  });

  checks.push({
    constraintType: 'include_in_allocation',
    passed: session.includeInAllocation,
    detail: session.includeInAllocation ? 'Session is included in allocation' : 'Session has include_in_allocation = false',
  });

  const langRecognized = participant.preferredLanguage != null && RECOGNIZED_LANGUAGES.has(participant.preferredLanguage);
  const languageMatches =
    !langRecognized || session.language === 'bilingual' || session.language === participant.preferredLanguage;
  checks.push({
    constraintType: 'language_match',
    passed: languageMatches,
    detail: !langRecognized
      ? `Participant has no recognized preferred_language — treated as matching any language`
      : languageMatches
        ? `Session language '${session.language}' matches applicant preferred_language '${participant.preferredLanguage}'`
        : `Session language '${session.language}' does not match applicant preferred_language '${participant.preferredLanguage}'`,
  });

  const participantTier = experienceToTier(participant.experienceLevel);
  const difficultyMatches = isAdjacentOrEqualTier(participantTier, session.difficultyLevel);
  checks.push({
    constraintType: 'difficulty_match',
    passed: difficultyMatches,
    detail: difficultyMatches
      ? `Participant tier '${participantTier}' is within one tier of session difficulty '${session.difficultyLevel}'`
      : `Participant tier '${participantTier}' is not within one tier of session difficulty '${session.difficultyLevel}'`,
  });

  return {
    eligible: checks.every((c) => c.passed),
    checks,
    excludedAsMandatory: session.isMandatory,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/allocation/hard-constraints.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/allocation/hard-constraints.ts tests/allocation/hard-constraints.test.ts
git commit -m "feat: add static hard-constraint eligibility checks"
```

---

## Task 9: Suitability scoring — cosine similarity

**Files:**
- Create: `src/lib/allocation/scoring.ts`
- Test: `tests/allocation/scoring.test.ts`

Implements the spec's Suitability Score section, including the zero-vector convention (resolves to 0, distinguishable from "no overlap").

- [ ] **Step 1: Write the failing test**

```ts
// tests/allocation/scoring.test.ts
import { describe, expect, it } from 'vitest';
import { cosineSimilarity } from '@/lib/allocation/scoring';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const result = cosineSimilarity({ a: 1, b: 0.5 }, { a: 1, b: 0.5 });
    expect(result.score).toBeCloseTo(1.0, 5);
    expect(result.isZeroVector).toBe(false);
  });

  it('returns 0 for orthogonal (no-overlap) vectors', () => {
    const result = cosineSimilarity({ a: 1 }, { b: 1 });
    expect(result.score).toBe(0);
    expect(result.isZeroVector).toBe(false);
  });

  it('returns 0 and flags isZeroVector when the participant vector is empty', () => {
    const result = cosineSimilarity({}, { a: 1 });
    expect(result.score).toBe(0);
    expect(result.isZeroVector).toBe(true);
  });

  it('returns 0 and flags isZeroVector when the session vector is empty', () => {
    const result = cosineSimilarity({ a: 1 }, {});
    expect(result.score).toBe(0);
    expect(result.isZeroVector).toBe(true);
  });

  it('returns 0 and flags isZeroVector when both vectors are empty', () => {
    const result = cosineSimilarity({}, {});
    expect(result.score).toBe(0);
    expect(result.isZeroVector).toBe(true);
  });

  it('computes partial overlap correctly', () => {
    const result = cosineSimilarity({ a: 1, b: 1 }, { a: 1 });
    expect(result.score).toBeCloseTo(1 / Math.sqrt(2), 5);
  });

  it('score is always within [0, 1]', () => {
    const result = cosineSimilarity({ a: 0.3, b: 0.9, c: 0.1 }, { a: 0.8, c: 0.5, d: 0.2 });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/allocation/scoring.test.ts`
Expected: FAIL with "Cannot find module '@/lib/allocation/scoring'"

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/allocation/scoring.ts
export interface SimilarityResult {
  score: number;
  isZeroVector: boolean;
}

// Cosine similarity between two sparse tag-weight vectors (tagId -> weight).
// Zero-vector convention (spec: Suitability Score): if either vector has
// zero magnitude, the result is mathematically undefined (0/0) — resolved to
// score 0 by convention, but distinguished via isZeroVector so callers can
// surface a different explanation than the "no overlap" case.
export function cosineSimilarity(a: Record<string, number>, b: Record<string, number>): SimilarityResult {
  const tagIds = new Set([...Object.keys(a), ...Object.keys(b)]);

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const tagId of tagIds) {
    const av = a[tagId] ?? 0;
    const bv = b[tagId] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }

  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);

  if (magA === 0 || magB === 0) {
    return { score: 0, isZeroVector: true };
  }

  const raw = dot / (magA * magB);
  // Clamp for floating-point safety (cosine similarity of non-negative
  // weight vectors is mathematically in [0, 1], but FP rounding can push
  // slightly outside).
  return { score: Math.min(1, Math.max(0, raw)), isZeroVector: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/allocation/scoring.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/allocation/scoring.ts tests/allocation/scoring.test.ts
git commit -m "feat: add cosine similarity suitability scoring"
```

---

## Task 10: Time-slot grouping — connected components + hash key

**Files:**
- Create: `src/lib/allocation/time-slot-grouping.ts`
- Test: `tests/allocation/time-slot-grouping.test.ts`

Implements spec Algorithm step 2 exactly: connected components per `conference_day_id` over `tstzrange` overlap, `time_slot_group_key` = SHA-256 hex of sorted session-id list joined by `,`. Node's built-in `crypto` module is used (no new dependency).

- [ ] **Step 1: Write the failing test**

```ts
// tests/allocation/time-slot-grouping.test.ts
import { describe, expect, it } from 'vitest';
import { groupSessionsIntoTimeSlots, computeTimeSlotGroupKey, type SessionForGrouping } from '@/lib/allocation/time-slot-grouping';

function s(id: string, day: string, start: string, end: string, mandatory = false): SessionForGrouping {
  return { id, conferenceDayId: day, startTime: start, endTime: end, isMandatory: mandatory };
}

describe('computeTimeSlotGroupKey', () => {
  it('is order-independent (same set, different input order -> same key)', () => {
    const k1 = computeTimeSlotGroupKey(['b', 'a', 'c']);
    const k2 = computeTimeSlotGroupKey(['c', 'b', 'a']);
    expect(k1).toBe(k2);
  });

  it('is deterministic and produces a hex string', () => {
    const k = computeTimeSlotGroupKey(['session-1']);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different keys for different sets', () => {
    expect(computeTimeSlotGroupKey(['a'])).not.toBe(computeTimeSlotGroupKey(['a', 'b']));
  });
});

describe('groupSessionsIntoTimeSlots', () => {
  it('groups two overlapping sessions on the same day into one component', () => {
    const sessions = [
      s('s1', 'day-1', '2026-08-01T09:00:00Z', '2026-08-01T10:00:00Z'),
      s('s2', 'day-1', '2026-08-01T09:30:00Z', '2026-08-01T10:30:00Z'),
    ];
    const groups = groupSessionsIntoTimeSlots(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessionIds.sort()).toEqual(['s1', 's2']);
  });

  it('keeps non-overlapping sessions on the same day as separate groups', () => {
    const sessions = [
      s('s1', 'day-1', '2026-08-01T09:00:00Z', '2026-08-01T10:00:00Z'),
      s('s2', 'day-1', '2026-08-01T10:00:00Z', '2026-08-01T11:00:00Z'), // half-open: touching, not overlapping
    ];
    const groups = groupSessionsIntoTimeSlots(sessions);
    expect(groups).toHaveLength(2);
  });

  it('never groups sessions across different conference days', () => {
    const sessions = [
      s('s1', 'day-1', '2026-08-01T09:00:00Z', '2026-08-01T10:00:00Z'),
      s('s2', 'day-2', '2026-08-01T09:00:00Z', '2026-08-01T10:00:00Z'),
    ];
    const groups = groupSessionsIntoTimeSlots(sessions);
    expect(groups).toHaveLength(2);
  });

  it('transitively links three sessions via a chain of overlaps into one component', () => {
    const sessions = [
      s('s1', 'day-1', '2026-08-01T09:00:00Z', '2026-08-01T10:00:00Z'),
      s('s2', 'day-1', '2026-08-01T09:30:00Z', '2026-08-01T10:30:00Z'),
      s('s3', 'day-1', '2026-08-01T10:15:00Z', '2026-08-01T11:00:00Z'),
    ];
    const groups = groupSessionsIntoTimeSlots(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessionIds.sort()).toEqual(['s1', 's2', 's3']);
  });

  it('produces a valid singleton group key for a session with no overlap partners', () => {
    const sessions = [s('s1', 'day-1', '2026-08-01T09:00:00Z', '2026-08-01T10:00:00Z')];
    const groups = groupSessionsIntoTimeSlots(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].timeSlotGroupKey).toBe(computeTimeSlotGroupKey(['s1']));
  });

  it('includes mandatory sessions in grouping on the same basis as elective sessions', () => {
    const sessions = [
      s('s1', 'day-1', '2026-08-01T09:00:00Z', '2026-08-01T10:00:00Z', true),
      s('s2', 'day-1', '2026-08-01T09:30:00Z', '2026-08-01T10:30:00Z', false),
    ];
    const groups = groupSessionsIntoTimeSlots(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessionIds.sort()).toEqual(['s1', 's2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/allocation/time-slot-grouping.test.ts`
Expected: FAIL with "Cannot find module '@/lib/allocation/time-slot-grouping'"

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/allocation/time-slot-grouping.ts
import { createHash } from 'crypto';

export interface SessionForGrouping {
  id: string;
  conferenceDayId: string;
  startTime: string; // ISO timestamptz
  endTime: string;
  isMandatory: boolean;
}

export interface TimeSlotGroup {
  timeSlotGroupKey: string;
  sessionIds: string[];
}

// Spec: Allocation Algorithm step 2. Sort session ids lexicographically,
// join with ',', SHA-256, hex-encode. Pure and order-independent so the
// same session-id set always yields the same key regardless of discovery
// order — required for reproducibility and for safety as the unique-
// constraint key in allocation_assignments.
export function computeTimeSlotGroupKey(sessionIds: string[]): string {
  const sorted = [...sessionIds].sort();
  return createHash('sha256').update(sorted.join(','), 'utf8').digest('hex');
}

function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  // Half-open [start, end) overlap, matching sessions_room_no_overlap's
  // tstzrange(start_time, end_time, '[)') semantics.
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

// Connected components over time-overlap, scoped per conference_day_id.
// Includes mandatory sessions on the same basis as elective ones — grouping
// only needs day + time range, not the mandatory flag (spec step 2).
export function groupSessionsIntoTimeSlots(sessions: SessionForGrouping[]): TimeSlotGroup[] {
  const byDay = new Map<string, SessionForGrouping[]>();
  for (const s of sessions) {
    if (!byDay.has(s.conferenceDayId)) byDay.set(s.conferenceDayId, []);
    byDay.get(s.conferenceDayId)!.push(s);
  }

  const groups: TimeSlotGroup[] = [];

  for (const daySessions of byDay.values()) {
    const parent = new Map<string, string>();
    const find = (id: string): string => {
      if (parent.get(id) !== id) parent.set(id, find(parent.get(id)!));
      return parent.get(id)!;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    for (const s of daySessions) parent.set(s.id, s.id);

    for (let i = 0; i < daySessions.length; i++) {
      for (let j = i + 1; j < daySessions.length; j++) {
        if (rangesOverlap(daySessions[i].startTime, daySessions[i].endTime, daySessions[j].startTime, daySessions[j].endTime)) {
          union(daySessions[i].id, daySessions[j].id);
        }
      }
    }

    const componentMembers = new Map<string, string[]>();
    for (const s of daySessions) {
      const root = find(s.id);
      if (!componentMembers.has(root)) componentMembers.set(root, []);
      componentMembers.get(root)!.push(s.id);
    }

    for (const sessionIds of componentMembers.values()) {
      groups.push({ timeSlotGroupKey: computeTimeSlotGroupKey(sessionIds), sessionIds });
    }
  }

  return groups;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/allocation/time-slot-grouping.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/allocation/time-slot-grouping.ts tests/allocation/time-slot-grouping.test.ts
git commit -m "feat: add connected-component time-slot grouping"
```

---

## Task 11: Deferred acceptance — stable matching

**Files:**
- Create: `src/lib/allocation/deferred-acceptance.ts`
- Test: `tests/allocation/deferred-acceptance.test.ts`

Implements spec Algorithm step 5 (elective pass): participants propose to their highest-scored eligible session first; sessions accept up to capacity ranked by score, bumping lower scorers on a better late proposal.

- [ ] **Step 1: Write the failing test**

```ts
// tests/allocation/deferred-acceptance.test.ts
import { describe, expect, it } from 'vitest';
import { runDeferredAcceptance, type ParticipantPreferences, type SessionCapacity } from '@/lib/allocation/deferred-acceptance';

describe('runDeferredAcceptance', () => {
  it('assigns each participant to their top eligible choice when capacity allows', () => {
    const participants: ParticipantPreferences[] = [
      { applicationId: 'p1', rankedSessionIds: ['s1', 's2'], scores: { s1: 0.9, s2: 0.5 } },
      { applicationId: 'p2', rankedSessionIds: ['s2'], scores: { s2: 0.8 } },
    ];
    const sessions: SessionCapacity[] = [
      { sessionId: 's1', capacity: 5 },
      { sessionId: 's2', capacity: 5 },
    ];
    const result = runDeferredAcceptance(participants, sessions);
    expect(result.assignments.find((a) => a.applicationId === 'p1')?.sessionId).toBe('s1');
    expect(result.assignments.find((a) => a.applicationId === 'p2')?.sessionId).toBe('s2');
    expect(result.unmatched).toEqual([]);
  });

  it('respects capacity: bumps the lower-scored participant when a higher scorer proposes late', () => {
    const participants: ParticipantPreferences[] = [
      { applicationId: 'low', rankedSessionIds: ['s1'], scores: { s1: 0.2 } },
      { applicationId: 'high', rankedSessionIds: ['s1'], scores: { s1: 0.9 } },
    ];
    const sessions: SessionCapacity[] = [{ sessionId: 's1', capacity: 1 }];
    const result = runDeferredAcceptance(participants, sessions);
    expect(result.assignments.find((a) => a.applicationId === 'high')?.sessionId).toBe('s1');
    expect(result.assignments.find((a) => a.applicationId === 'low')).toBeUndefined();
    expect(result.unmatched).toContain('low');
  });

  it('moves a bumped participant to their next-ranked choice', () => {
    const participants: ParticipantPreferences[] = [
      { applicationId: 'low', rankedSessionIds: ['s1', 's2'], scores: { s1: 0.2, s2: 0.6 } },
      { applicationId: 'high', rankedSessionIds: ['s1'], scores: { s1: 0.9 } },
    ];
    const sessions: SessionCapacity[] = [
      { sessionId: 's1', capacity: 1 },
      { sessionId: 's2', capacity: 1 },
    ];
    const result = runDeferredAcceptance(participants, sessions);
    expect(result.assignments.find((a) => a.applicationId === 'low')?.sessionId).toBe('s2');
    expect(result.unmatched).toEqual([]);
  });

  it('leaves a participant unmatched once their eligible set is exhausted', () => {
    const participants: ParticipantPreferences[] = [
      { applicationId: 'p1', rankedSessionIds: ['s1'], scores: { s1: 0.1 } },
      { applicationId: 'p2', rankedSessionIds: ['s1'], scores: { s1: 0.9 } },
    ];
    const sessions: SessionCapacity[] = [{ sessionId: 's1', capacity: 1 }];
    const result = runDeferredAcceptance(participants, sessions);
    expect(result.unmatched).toEqual(['p1']);
  });

  it('is deterministic given fixed scores', () => {
    const participants: ParticipantPreferences[] = [
      { applicationId: 'p1', rankedSessionIds: ['s1', 's2'], scores: { s1: 0.5, s2: 0.5 } },
      { applicationId: 'p2', rankedSessionIds: ['s1', 's2'], scores: { s1: 0.5, s2: 0.5 } },
    ];
    const sessions: SessionCapacity[] = [
      { sessionId: 's1', capacity: 1 },
      { sessionId: 's2', capacity: 1 },
    ];
    const a = runDeferredAcceptance(participants, sessions);
    const b = runDeferredAcceptance(participants, sessions);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('never exceeds a session capacity', () => {
    const participants: ParticipantPreferences[] = Array.from({ length: 10 }, (_, i) => ({
      applicationId: `p${i}`,
      rankedSessionIds: ['s1'],
      scores: { s1: i / 10 },
    }));
    const sessions: SessionCapacity[] = [{ sessionId: 's1', capacity: 3 }];
    const result = runDeferredAcceptance(participants, sessions);
    expect(result.assignments.filter((a) => a.sessionId === 's1')).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/allocation/deferred-acceptance.test.ts`
Expected: FAIL with "Cannot find module '@/lib/allocation/deferred-acceptance'"

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/allocation/deferred-acceptance.ts
export interface ParticipantPreferences {
  applicationId: string;
  rankedSessionIds: string[]; // caller passes these pre-sorted by score descending
  scores: Record<string, number>;
}

export interface SessionCapacity {
  sessionId: string;
  capacity: number;
}

export interface DeferredAcceptanceAssignment {
  applicationId: string;
  sessionId: string;
  score: number;
}

export interface DeferredAcceptanceResult {
  assignments: DeferredAcceptanceAssignment[];
  unmatched: string[];
}

// Gale-Shapley-style deferred acceptance: participants propose to their
// highest-scored remaining eligible session; sessions hold the top-`capacity`
// proposals by score, bumping the lowest scorer when a higher-scoring
// proposal arrives. Repeats until every participant is matched or has
// exhausted their ranked list (spec: Allocation Algorithm step 5).
export function runDeferredAcceptance(
  participants: ParticipantPreferences[],
  sessions: SessionCapacity[]
): DeferredAcceptanceResult {
  const capacityBySession = new Map(sessions.map((s) => [s.sessionId, s.capacity]));
  const nextProposalIndex = new Map(participants.map((p) => [p.applicationId, 0]));
  const holds = new Map<string, DeferredAcceptanceAssignment[]>(); // sessionId -> held proposals, sorted desc by score

  let freeParticipants = participants.map((p) => p.applicationId);
  const participantById = new Map(participants.map((p) => [p.applicationId, p]));

  while (freeParticipants.length > 0) {
    const stillFree: string[] = [];

    for (const applicationId of freeParticipants) {
      const participant = participantById.get(applicationId)!;
      const idx = nextProposalIndex.get(applicationId)!;

      if (idx >= participant.rankedSessionIds.length) {
        continue; // exhausted eligible set, permanently unmatched
      }

      const sessionId = participant.rankedSessionIds[idx];
      nextProposalIndex.set(applicationId, idx + 1);

      const capacity = capacityBySession.get(sessionId) ?? 0;
      const held = holds.get(sessionId) ?? [];
      const proposal: DeferredAcceptanceAssignment = { applicationId, sessionId, score: participant.scores[sessionId] ?? 0 };

      const combined = [...held, proposal].sort((a, b) => b.score - a.score);

      if (combined.length <= capacity) {
        holds.set(sessionId, combined);
      } else {
        const kept = combined.slice(0, capacity);
        const bumped = combined.slice(capacity);
        holds.set(sessionId, kept);
        for (const b of bumped) {
          if (b.applicationId !== applicationId || kept.some((k) => k.applicationId === applicationId)) {
            // participant who is now not held becomes free again (re-propose next round)
          }
        }
        for (const b of bumped) {
          if (!kept.some((k) => k.applicationId === b.applicationId)) {
            stillFree.push(b.applicationId);
          }
        }
      }
    }

    freeParticipants = stillFree.filter((id) => nextProposalIndex.get(id)! < participantById.get(id)!.rankedSessionIds.length);
  }

  const assignments = Array.from(holds.values()).flat();
  const matchedIds = new Set(assignments.map((a) => a.applicationId));
  const unmatched = participants.map((p) => p.applicationId).filter((id) => !matchedIds.has(id));

  return { assignments, unmatched };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/allocation/deferred-acceptance.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/allocation/deferred-acceptance.ts tests/allocation/deferred-acceptance.test.ts
git commit -m "feat: add deferred acceptance stable matching"
```

---

## Task 12: Issue derivation — pure logic

**Files:**
- Create: `src/lib/allocation/issues.ts`
- Test: `tests/allocation/issues.test.ts`

Implements spec Algorithm step 8: derives `allocation_issues` rows (all 5 types, with the `details` shapes specified in the Data Model section) from a completed run's in-memory state.

- [ ] **Step 1: Write the failing test**

```ts
// tests/allocation/issues.test.ts
import { describe, expect, it } from 'vitest';
import { deriveIssues, type IssueDerivationInput } from '@/lib/allocation/issues';

describe('deriveIssues', () => {
  it('produces an unassigned issue for a participant with no assignment in a slot group', () => {
    const input: IssueDerivationInput = {
      timeSlotGroups: [{ timeSlotGroupKey: 'slot-1', eligibleSessionIdsByParticipant: { p1: ['s1'] } }],
      assignments: [],
      lowConfidenceThreshold: 0.4,
      sessionCapacities: { s1: 5 },
      assignedCountBySession: {},
      allParticipantIds: ['p1'],
    };
    const issues = deriveIssues(input);
    expect(issues.some((i) => i.issueType === 'unassigned' && i.applicationId === 'p1')).toBe(true);
  });

  it('produces a no_eligible_sessions issue when a participant has zero eligible sessions in a slot', () => {
    const input: IssueDerivationInput = {
      timeSlotGroups: [{ timeSlotGroupKey: 'slot-1', eligibleSessionIdsByParticipant: { p1: [] } }],
      assignments: [],
      lowConfidenceThreshold: 0.4,
      sessionCapacities: {},
      assignedCountBySession: {},
      allParticipantIds: ['p1'],
    };
    const issues = deriveIssues(input);
    expect(issues.some((i) => i.issueType === 'no_eligible_sessions' && i.applicationId === 'p1')).toBe(true);
  });

  it('produces a low_confidence issue for an assignment scoring below threshold', () => {
    const input: IssueDerivationInput = {
      timeSlotGroups: [{ timeSlotGroupKey: 'slot-1', eligibleSessionIdsByParticipant: { p1: ['s1'] } }],
      assignments: [{ id: 'a1', applicationId: 'p1', sessionId: 's1', timeSlotGroupKey: 'slot-1', suitabilityScore: 0.1 }],
      lowConfidenceThreshold: 0.4,
      sessionCapacities: { s1: 5 },
      assignedCountBySession: { s1: 1 },
      allParticipantIds: ['p1'],
    };
    const issues = deriveIssues(input);
    expect(issues.some((i) => i.issueType === 'low_confidence' && i.applicationId === 'p1')).toBe(true);
  });

  it('does not flag low_confidence exactly at the threshold boundary (threshold itself is not "below")', () => {
    const input: IssueDerivationInput = {
      timeSlotGroups: [{ timeSlotGroupKey: 'slot-1', eligibleSessionIdsByParticipant: { p1: ['s1'] } }],
      assignments: [{ id: 'a1', applicationId: 'p1', sessionId: 's1', timeSlotGroupKey: 'slot-1', suitabilityScore: 0.4 }],
      lowConfidenceThreshold: 0.4,
      sessionCapacities: { s1: 5 },
      assignedCountBySession: { s1: 1 },
      allParticipantIds: ['p1'],
    };
    const issues = deriveIssues(input);
    expect(issues.some((i) => i.issueType === 'low_confidence')).toBe(false);
  });

  it('produces a capacity_bottleneck issue when a session filled to capacity with eligible participants remaining unmatched', () => {
    const input: IssueDerivationInput = {
      timeSlotGroups: [{ timeSlotGroupKey: 'slot-1', eligibleSessionIdsByParticipant: { p1: ['s1'], p2: ['s1'] } }],
      assignments: [{ id: 'a1', applicationId: 'p1', sessionId: 's1', timeSlotGroupKey: 'slot-1', suitabilityScore: 0.9 }],
      lowConfidenceThreshold: 0.4,
      sessionCapacities: { s1: 1 },
      assignedCountBySession: { s1: 1 },
      allParticipantIds: ['p1', 'p2'],
    };
    const issues = deriveIssues(input);
    expect(issues.some((i) => i.issueType === 'capacity_bottleneck' && i.sessionId === 's1')).toBe(true);
  });

  it('produces a schedule_conflict issue when a participant holds two overlapping assignments, carrying conference_day_id', () => {
    const input: IssueDerivationInput = {
      timeSlotGroups: [],
      assignments: [
        { id: 'a1', applicationId: 'p1', sessionId: 's1', timeSlotGroupKey: 'slot-1', suitabilityScore: 0.9 },
        { id: 'a2', applicationId: 'p1', sessionId: 's2', timeSlotGroupKey: 'slot-1', suitabilityScore: 0.9 },
      ],
      lowConfidenceThreshold: 0.4,
      sessionCapacities: { s1: 5, s2: 5 },
      assignedCountBySession: { s1: 1, s2: 1 },
      allParticipantIds: ['p1'],
      scheduleConflictPairs: [{ assignmentIds: ['a1', 'a2'], conferenceDayId: 'day-1' }],
    };
    const issues = deriveIssues(input);
    const conflict = issues.find((i) => i.issueType === 'schedule_conflict' && i.applicationId === 'p1');
    expect(conflict).toBeDefined();
    expect(conflict!.details.conference_day_id).toBe('day-1');
  });

  it('populates failed_constraints_summary on a no_eligible_sessions issue when the orchestrator supplies it', () => {
    const input: IssueDerivationInput = {
      timeSlotGroups: [{ timeSlotGroupKey: 'slot-1', eligibleSessionIdsByParticipant: { p1: [] } }],
      assignments: [],
      lowConfidenceThreshold: 0.4,
      sessionCapacities: {},
      assignedCountBySession: {},
      allParticipantIds: ['p1'],
      failedConstraintsSummary: { 'p1:slot-1': { language: 3, difficulty: 5, capacity: 0 } },
    };
    const issues = deriveIssues(input);
    const issue = issues.find((i) => i.issueType === 'no_eligible_sessions' && i.applicationId === 'p1');
    expect(issue!.details.failed_constraints_summary).toEqual({ language: 3, difficulty: 5, capacity: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/allocation/issues.test.ts`
Expected: FAIL with "Cannot find module '@/lib/allocation/issues'"

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/allocation/issues.ts
export type IssueType = 'unassigned' | 'low_confidence' | 'capacity_bottleneck' | 'schedule_conflict' | 'no_eligible_sessions';

export interface DerivedIssue {
  issueType: IssueType;
  applicationId: string | null;
  sessionId: string | null;
  details: Record<string, unknown>;
}

export interface AssignmentForIssues {
  id: string;
  applicationId: string;
  sessionId: string;
  timeSlotGroupKey: string;
  suitabilityScore: number;
}

export interface TimeSlotGroupForIssues {
  timeSlotGroupKey: string;
  eligibleSessionIdsByParticipant: Record<string, string[]>;
}

export interface ScheduleConflictPair {
  assignmentIds: [string, string];
  conferenceDayId: string;
}

export interface IssueDerivationInput {
  timeSlotGroups: TimeSlotGroupForIssues[];
  assignments: AssignmentForIssues[];
  lowConfidenceThreshold: number;
  sessionCapacities: Record<string, number>;
  assignedCountBySession: Record<string, number>;
  allParticipantIds: string[];
  // Pairs of assignment ids whose sessions were found to overlap in time for
  // the same participant, plus the shared conference_day_id they overlap on
  // — computed by the orchestrator's defensive post-hoc query (spec step 8's
  // schedule_conflict definition, Data Model's details shape), passed in
  // here already-detected.
  scheduleConflictPairs?: ScheduleConflictPair[];
  // Per-constraint failure counts for a (applicationId, timeSlotGroupKey)
  // pair with zero eligible sessions, keyed `${applicationId}:${timeSlotGroupKey}`
  // — computed by the orchestrator from checkStaticHardConstraints(...).checks
  // across every candidate session in that slot (spec Data Model:
  // no_eligible_sessions.details.failed_constraints_summary). Optional:
  // omitted entries default to an empty summary.
  failedConstraintsSummary?: Record<string, Record<string, number>>;
}

// Derives all 5 allocation_issues types (spec: Allocation Algorithm step 8,
// Data Model's details-shape-per-type list) from a completed run's
// in-memory state. Pure — takes already-computed run state, does no DB I/O.
export function deriveIssues(input: IssueDerivationInput): DerivedIssue[] {
  const issues: DerivedIssue[] = [];
  const assignmentByApplicationAndSlot = new Map<string, AssignmentForIssues>();
  for (const a of input.assignments) {
    assignmentByApplicationAndSlot.set(`${a.applicationId}:${a.timeSlotGroupKey}`, a);
  }

  // unassigned / no_eligible_sessions: per participant per slot group.
  for (const group of input.timeSlotGroups) {
    for (const [applicationId, eligibleSessionIds] of Object.entries(group.eligibleSessionIdsByParticipant)) {
      const key = `${applicationId}:${group.timeSlotGroupKey}`;
      const hasAssignment = assignmentByApplicationAndSlot.has(key);
      if (hasAssignment) continue;

      if (eligibleSessionIds.length === 0) {
        const summary = input.failedConstraintsSummary?.[`${applicationId}:${group.timeSlotGroupKey}`] ?? {};
        issues.push({
          issueType: 'no_eligible_sessions',
          applicationId,
          sessionId: null,
          details: { time_slot_group_key: group.timeSlotGroupKey, failed_constraints_summary: summary },
        });
      } else {
        issues.push({
          issueType: 'unassigned',
          applicationId,
          sessionId: null,
          details: { time_slot_group_key: group.timeSlotGroupKey, eligible_session_ids: eligibleSessionIds, reason: 'capacity_exhausted' },
        });
      }
    }
  }

  // low_confidence: per assignment below threshold.
  for (const a of input.assignments) {
    if (a.suitabilityScore < input.lowConfidenceThreshold) {
      issues.push({
        issueType: 'low_confidence',
        applicationId: a.applicationId,
        sessionId: a.sessionId,
        details: { allocation_assignment_id: a.id, suitability_score: a.suitabilityScore, threshold: input.lowConfidenceThreshold },
      });
    }
  }

  // capacity_bottleneck: any session filled to capacity while eligible
  // participants remain unmatched to it.
  const eligibleCountBySession = new Map<string, number>();
  for (const group of input.timeSlotGroups) {
    for (const eligibleSessionIds of Object.values(group.eligibleSessionIdsByParticipant)) {
      for (const sessionId of eligibleSessionIds) {
        eligibleCountBySession.set(sessionId, (eligibleCountBySession.get(sessionId) ?? 0) + 1);
      }
    }
  }
  for (const [sessionId, capacity] of Object.entries(input.sessionCapacities)) {
    const assigned = input.assignedCountBySession[sessionId] ?? 0;
    const eligible = eligibleCountBySession.get(sessionId) ?? 0;
    if (assigned >= capacity && eligible > assigned) {
      issues.push({
        issueType: 'capacity_bottleneck',
        applicationId: null,
        sessionId,
        details: {
          session_id: sessionId,
          capacity,
          eligible_count: eligible,
          assigned_count: assigned,
          excluded_application_ids: [],
        },
      });
    }
  }

  // schedule_conflict: defensive, from precomputed overlap pairs.
  const assignmentById = new Map(input.assignments.map((a) => [a.id, a]));
  for (const pair of input.scheduleConflictPairs ?? []) {
    const [idA, idB] = pair.assignmentIds;
    const a = assignmentById.get(idA);
    const b = assignmentById.get(idB);
    if (!a || !b) continue;
    issues.push({
      issueType: 'schedule_conflict',
      applicationId: a.applicationId,
      sessionId: null,
      details: { application_id: a.applicationId, conflicting_assignment_ids: [idA, idB], conference_day_id: pair.conferenceDayId },
    });
  }

  return issues;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/allocation/issues.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/allocation/issues.ts tests/allocation/issues.test.ts
git commit -m "feat: add pure allocation issue derivation"
```

---

## Task 13: Run typecheck/lint/test after pure-logic layer

- [ ] **Step 1:** Run `npx tsc --noEmit` — expect no errors.
- [ ] **Step 2:** Run `npm run lint` — expect no errors.
- [ ] **Step 3:** Run `npm test` — expect all tests from Tasks 5–12 passing (this is the checkpoint the spec's Testing Requirements #1–4 map to: pure-function unit tests, no DB).
- [ ] **Step 4:** If anything fails, fix before proceeding — do not carry broken pure logic into the orchestration layer.

No commit for this task (verification only).

---

## Task 14: Feature extraction orchestrator + server action

**Files:**
- Create: `src/lib/allocation/run-extraction.ts`
- Create: `src/app/[locale]/(admin)/allocation/extraction/actions.ts`

This wires `extractFeatures` (Task 6) into a real DB run: reads active `feature_extraction_rules`, reads accepted `applications`, writes a `feature_extraction_runs` row and its `participant_feature_snapshots`.

- [ ] **Step 1: Write the orchestrator**

```ts
// src/lib/allocation/run-extraction.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { extractFeatures, type ApplicationForExtraction, type ExtractionRule } from './feature-extraction';

type ServiceClient = SupabaseClient<Database>;

export async function runFeatureExtraction(service: ServiceClient, runBy: string): Promise<{ id: string; applicationCount: number }> {
  const { data: ruleRows, error: rulesError } = await service
    .from('feature_extraction_rules')
    .select('id, version, source_field, match_type, match_value, tag_id, weight, is_active')
    .eq('is_active', true);
  if (rulesError) throw new Error(`Failed to load extraction rules: ${rulesError.message}`);

  const rules: ExtractionRule[] = (ruleRows ?? []).map((r) => ({
    id: r.id,
    sourceField: r.source_field as ExtractionRule['sourceField'],
    matchType: r.match_type as ExtractionRule['matchType'],
    matchValue: r.match_value,
    tagId: r.tag_id,
    weight: r.weight,
  }));
  const rulesVersion = ruleRows && ruleRows.length > 0 ? Math.max(...ruleRows.map((r) => r.version)) : 0;

  const { data: applications, error: appsError } = await service
    .from('applications')
    .select('id, interests, track_interests, topics_to_learn, participation_goals, past_initiatives')
    .eq('status', 'accepted');
  if (appsError) throw new Error(`Failed to load accepted applications: ${appsError.message}`);

  const { data: run, error: runError } = await service
    .from('feature_extraction_runs')
    .insert({ rules_version: rulesVersion, application_count: applications?.length ?? 0, run_by: runBy })
    .select('id')
    .single();
  if (runError || !run) throw new Error(`Failed to create feature_extraction_runs row: ${runError?.message}`);

  const snapshotRows: { feature_extraction_run_id: string; application_id: string; tag_id: string; weight: number }[] = [];
  for (const app of applications ?? []) {
    const forExtraction: ApplicationForExtraction = {
      interests: app.interests,
      trackInterests: app.track_interests,
      topicsToLearn: app.topics_to_learn,
      participationGoals: app.participation_goals,
      pastInitiatives: app.past_initiatives,
    };
    const features = extractFeatures(forExtraction, rules);
    for (const f of features) {
      snapshotRows.push({ feature_extraction_run_id: run.id, application_id: app.id, tag_id: f.tagId, weight: f.weight });
    }
  }

  if (snapshotRows.length > 0) {
    const { error: snapshotError } = await service.from('participant_feature_snapshots').insert(snapshotRows);
    if (snapshotError) throw new Error(`Failed to write feature snapshots: ${snapshotError.message}`);
  }

  return { id: run.id, applicationCount: applications?.length ?? 0 };
}
```

- [ ] **Step 2: Write the server action**

```ts
// src/app/[locale]/(admin)/allocation/extraction/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { runFeatureExtraction } from '@/lib/allocation/run-extraction';
import { extractionRuleSchema } from '@/lib/validation/allocation';

export async function triggerFeatureExtraction() {
  const { userId, service } = await requireAgendaStaffCaller();
  const result = await runFeatureExtraction(service, userId);
  await writeAuditLog(service, {
    entityType: 'feature_extraction_run',
    entityId: result.id,
    action: 'run',
    actorId: userId,
    metadata: { applicationCount: result.applicationCount },
  });
  return result;
}

export async function createExtractionRule(input: unknown) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = extractionRuleSchema.parse(input);

  const { data: existing } = await service
    .from('feature_extraction_rules')
    .select('version')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (existing?.version ?? 0) + 1;

  const { data, error } = await service
    .from('feature_extraction_rules')
    .insert({
      version: nextVersion,
      source_field: parsed.sourceField,
      match_type: parsed.matchType,
      match_value: parsed.matchValue,
      tag_id: parsed.tagId,
      weight: parsed.weight,
      updated_by: userId,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create extraction rule: ${error?.message}`);

  await writeAuditLog(service, { entityType: 'feature_extraction_rule', entityId: data.id, action: 'create', actorId: userId, newValues: parsed });
  return { id: data.id };
}

export async function deactivateExtractionRule(ruleId: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { error } = await service.from('feature_extraction_rules').update({ is_active: false, updated_by: userId }).eq('id', ruleId);
  if (error) throw new Error(`Failed to deactivate extraction rule: ${error.message}`);
  await writeAuditLog(service, { entityType: 'feature_extraction_rule', entityId: ruleId, action: 'deactivate', actorId: userId });
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no new errors. If `applications` column names or `Database` types don't match exactly, check `src/types/database.ts` for the real generated field names and adjust (this file is generated from the live schema — do not hand-edit it; fix the orchestrator's field references instead).

- [ ] **Step 4: Commit**

```bash
git add src/lib/allocation/run-extraction.ts "src/app/[locale]/(admin)/allocation/extraction/actions.ts"
git commit -m "feat: add feature extraction orchestrator and server actions"
```

---

## Task 15: Clustering orchestrator + server action

**Files:**
- Create: `src/lib/allocation/run-clustering.ts`
- Create: `src/app/[locale]/(admin)/allocation/clustering/actions.ts`

- [ ] **Step 1: Write the orchestrator**

```ts
// src/lib/allocation/run-clustering.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { runKMeans, type FeatureVector } from './clustering';

type ServiceClient = SupabaseClient<Database>;

export async function runClustering(
  service: ServiceClient,
  runBy: string,
  featureExtractionRunId: string,
  k: number,
  randomSeed: number
): Promise<{ id: string }> {
  const { data: snapshots, error } = await service
    .from('participant_feature_snapshots')
    .select('application_id, tag_id, weight')
    .eq('feature_extraction_run_id', featureExtractionRunId);
  if (error) throw new Error(`Failed to load feature snapshots: ${error.message}`);

  const byApplication = new Map<string, Record<string, number>>();
  for (const row of snapshots ?? []) {
    if (!byApplication.has(row.application_id)) byApplication.set(row.application_id, {});
    byApplication.get(row.application_id)![row.tag_id] = row.weight;
  }
  const vectors: FeatureVector[] = Array.from(byApplication.entries()).map(([applicationId, weights]) => ({ applicationId, weights }));

  if (vectors.length < k) {
    const { data: failedRun, error: failError } = await service
      .from('clustering_runs')
      .insert({ feature_extraction_run_id: featureExtractionRunId, k, random_seed: randomSeed, status: 'failed', run_by: runBy })
      .select('id')
      .single();
    if (failError || !failedRun) throw new Error(`Failed to record failed clustering run: ${failError?.message}`);
    return { id: failedRun.id };
  }

  const result = runKMeans(vectors, k, randomSeed);

  const { data: run, error: runError } = await service
    .from('clustering_runs')
    .insert({ feature_extraction_run_id: featureExtractionRunId, k, random_seed: randomSeed, status: 'completed', run_by: runBy })
    .select('id')
    .single();
  if (runError || !run) throw new Error(`Failed to create clustering_runs row: ${runError?.message}`);

  const clusterIdByIndex = new Map<number, string>();
  for (const cluster of result.clusters) {
    const { data: clusterRow, error: clusterError } = await service
      .from('clusters')
      .insert({ clustering_run_id: run.id, centroid: cluster.centroid, member_count: cluster.memberCount })
      .select('id')
      .single();
    if (clusterError || !clusterRow) throw new Error(`Failed to create cluster row: ${clusterError?.message}`);
    clusterIdByIndex.set(cluster.index, clusterRow.id);
  }

  const membershipRows = result.memberships.map((m) => ({
    cluster_id: clusterIdByIndex.get(m.clusterIndex)!,
    application_id: m.applicationId,
    distance_to_centroid: m.distanceToCentroid,
  }));
  if (membershipRows.length > 0) {
    const { error: membershipError } = await service.from('cluster_memberships').insert(membershipRows);
    if (membershipError) throw new Error(`Failed to write cluster memberships: ${membershipError.message}`);
  }

  return { id: run.id };
}
```

- [ ] **Step 2: Write the server action**

```ts
// src/app/[locale]/(admin)/allocation/clustering/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { runClustering } from '@/lib/allocation/run-clustering';
import { triggerClusteringSchema } from '@/lib/validation/allocation';

export async function triggerClusteringRun(input: unknown) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = triggerClusteringSchema.parse(input);
  const result = await runClustering(service, userId, parsed.featureExtractionRunId, parsed.k, parsed.randomSeed);
  await writeAuditLog(service, { entityType: 'clustering_run', entityId: result.id, action: 'run', actorId: userId, metadata: parsed });
  return result;
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/lib/allocation/run-clustering.ts "src/app/[locale]/(admin)/allocation/clustering/actions.ts"
git commit -m "feat: add clustering orchestrator and server action"
```

---

## Task 16: Allocation run orchestrator (the core assignment engine)

**Files:**
- Create: `src/lib/allocation/run-allocation.ts`

This is the largest task: wires Tasks 8–12 (hard constraints, scoring, time-slot grouping, deferred acceptance, issues) into the full algorithm from spec section "Allocation Algorithm", steps 1–9. Because it's a pure orchestration of already-tested pure functions plus straightforward DB reads/writes, it does not need new unit tests of its own — correctness of its logic is covered by Tasks 6–12's tests; correctness of its DB wiring is covered by Task 21's live behavioral suite.

- [ ] **Step 1: Write the orchestrator**

```ts
// src/lib/allocation/run-allocation.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { checkStaticHardConstraints, type ParticipantForConstraints, type SessionForConstraints } from './hard-constraints';
import { cosineSimilarity } from './scoring';
import { groupSessionsIntoTimeSlots, type SessionForGrouping } from './time-slot-grouping';
import { runDeferredAcceptance, type ParticipantPreferences, type SessionCapacity } from './deferred-acceptance';
import { deriveIssues, type AssignmentForIssues, type TimeSlotGroupForIssues } from './issues';
import { ALTERNATIVES_COUNT, LOW_CONFIDENCE_THRESHOLD } from '@/lib/validation/allocation';

type ServiceClient = SupabaseClient<Database>;

interface PendingAssignment {
  applicationId: string;
  sessionId: string;
  timeSlotGroupKey: string;
  suitabilityScore: number;
  isLowConfidence: boolean;
  isMandatoryAssignment: boolean;
  eligibleSessionIds: string[]; // for alternatives
  scoresBySession: Record<string, number>; // for alternatives
}

export async function runAllocation(service: ServiceClient, runBy: string, featureExtractionRunId: string): Promise<{ id: string }> {
  // --- Step 1: gather snapshots (extraction already ran; this run reuses it) ---
  const { data: snapshotRows, error: snapshotErr } = await service
    .from('participant_feature_snapshots')
    .select('application_id, tag_id, weight')
    .eq('feature_extraction_run_id', featureExtractionRunId);
  if (snapshotErr) throw new Error(`Failed to load feature snapshots: ${snapshotErr.message}`);

  const participantVectors = new Map<string, Record<string, number>>();
  for (const row of snapshotRows ?? []) {
    if (!participantVectors.has(row.application_id)) participantVectors.set(row.application_id, {});
    participantVectors.get(row.application_id)![row.tag_id] = row.weight;
  }

  const { data: applications, error: appsErr } = await service
    .from('applications')
    .select('id, preferred_language, experience_level')
    .eq('status', 'accepted');
  if (appsErr) throw new Error(`Failed to load accepted applications: ${appsErr.message}`);
  const participantIds = (applications ?? []).map((a) => a.id);
  const participantMeta = new Map((applications ?? []).map((a) => [a.id, a]));

  // --- sessions + session tag vectors ---
  const { data: sessionRows, error: sessionsErr } = await service
    .from('sessions')
    .select('id, conference_day_id, start_time, end_time, status, include_in_allocation, language, difficulty_level, is_mandatory, capacity')
    .eq('status', 'confirmed')
    .eq('include_in_allocation', true);
  if (sessionsErr) throw new Error(`Failed to load sessions: ${sessionsErr.message}`);

  const { data: sessionTagRows, error: sessionTagsErr } = await service.from('session_tags').select('session_id, tag_id, weight');
  if (sessionTagsErr) throw new Error(`Failed to load session tags: ${sessionTagsErr.message}`);
  const sessionVectors = new Map<string, Record<string, number>>();
  for (const row of sessionTagRows ?? []) {
    if (!sessionVectors.has(row.session_id)) sessionVectors.set(row.session_id, {});
    sessionVectors.get(row.session_id)![row.tag_id] = row.weight;
  }

  // --- Step 2: time-slot grouping (includes mandatory sessions) ---
  const groupingInput: SessionForGrouping[] = (sessionRows ?? []).map((s) => ({
    id: s.id,
    conferenceDayId: s.conference_day_id,
    startTime: s.start_time,
    endTime: s.end_time,
    isMandatory: s.is_mandatory,
  }));
  const timeSlotGroups = groupSessionsIntoTimeSlots(groupingInput);
  const slotKeyBySessionId = new Map<string, string>();
  for (const group of timeSlotGroups) for (const sessionId of group.sessionIds) slotKeyBySessionId.set(sessionId, group.timeSlotGroupKey);

  // --- Step 3: score precomputation for every hard-eligible (participant, session) pair ---
  const mandatorySessions = (sessionRows ?? []).filter((s) => s.is_mandatory);
  const electiveSessions = (sessionRows ?? []).filter((s) => !s.is_mandatory);

  type ScoredPair = { applicationId: string; sessionId: string; score: number; isLowConfidence: boolean };
  const scoresByApplication = new Map<string, ScoredPair[]>(); // per application, all hard-eligible sessions with scores

  for (const applicationId of participantIds) {
    const meta = participantMeta.get(applicationId)!;
    const participant: ParticipantForConstraints = {
      applicationId,
      preferredLanguage: meta.preferred_language,
      experienceLevel: meta.experience_level,
    };
    const pairs: ScoredPair[] = [];
    for (const s of sessionRows ?? []) {
      const sessionForConstraints: SessionForConstraints = {
        id: s.id,
        status: s.status,
        includeInAllocation: s.include_in_allocation,
        language: s.language,
        difficultyLevel: s.difficulty_level,
        isMandatory: s.is_mandatory,
      };
      const constraintResult = checkStaticHardConstraints(participant, sessionForConstraints);
      if (!constraintResult.eligible) continue;

      const participantVector = participantVectors.get(applicationId) ?? {};
      const sessionVector = sessionVectors.get(s.id) ?? {};
      const { score } = cosineSimilarity(participantVector, sessionVector);
      pairs.push({ applicationId, sessionId: s.id, score, isLowConfidence: score < LOW_CONFIDENCE_THRESHOLD });
    }
    scoresByApplication.set(applicationId, pairs);
  }

  const pending: PendingAssignment[] = [];
  const filledSlotByApplication = new Set<string>(); // `${applicationId}:${timeSlotGroupKey}`

  // --- Step 4: mandatory pass ---
  for (const session of mandatorySessions) {
    const eligible = participantIds
      .map((id) => ({ id, pair: (scoresByApplication.get(id) ?? []).find((p) => p.sessionId === session.id) }))
      .filter((x): x is { id: string; pair: ScoredPair } => x.pair !== undefined)
      .sort((a, b) => b.pair.score - a.pair.score);

    const capacity = session.capacity;
    const winners = eligible.slice(0, capacity);
    const slotKey = slotKeyBySessionId.get(session.id)!;

    for (const w of winners) {
      pending.push({
        applicationId: w.id,
        sessionId: session.id,
        timeSlotGroupKey: slotKey,
        suitabilityScore: w.pair.score,
        isLowConfidence: w.pair.isLowConfidence,
        isMandatoryAssignment: true,
        eligibleSessionIds: [session.id],
        scoresBySession: { [session.id]: w.pair.score },
      });
      filledSlotByApplication.add(`${w.id}:${slotKey}`);
    }
  }

  // --- Step 5: elective pass, per remaining time-slot group ---
  const electiveSlotKeys = new Set(electiveSessions.map((s) => slotKeyBySessionId.get(s.id)!));
  for (const slotKey of electiveSlotKeys) {
    const sessionsInGroup = electiveSessions.filter((s) => slotKeyBySessionId.get(s.id) === slotKey);
    const sessionIdsInGroup = new Set(sessionsInGroup.map((s) => s.id));

    const preferences: ParticipantPreferences[] = [];
    for (const applicationId of participantIds) {
      if (filledSlotByApplication.has(`${applicationId}:${slotKey}`)) continue;
      const pairsInGroup = (scoresByApplication.get(applicationId) ?? [])
        .filter((p) => sessionIdsInGroup.has(p.sessionId))
        .sort((a, b) => b.score - a.score);
      if (pairsInGroup.length === 0) continue;
      preferences.push({
        applicationId,
        rankedSessionIds: pairsInGroup.map((p) => p.sessionId),
        scores: Object.fromEntries(pairsInGroup.map((p) => [p.sessionId, p.score])),
      });
    }

    const capacities: SessionCapacity[] = sessionsInGroup.map((s) => ({ sessionId: s.id, capacity: s.capacity }));
    const result = runDeferredAcceptance(preferences, capacities);

    for (const a of result.assignments) {
      const scorePairs = (scoresByApplication.get(a.applicationId) ?? []).filter((p) => sessionIdsInGroup.has(p.sessionId));
      pending.push({
        applicationId: a.applicationId,
        sessionId: a.sessionId,
        timeSlotGroupKey: slotKey,
        suitabilityScore: a.score,
        isLowConfidence: a.score < LOW_CONFIDENCE_THRESHOLD,
        isMandatoryAssignment: false,
        eligibleSessionIds: scorePairs.map((p) => p.sessionId),
        scoresBySession: Object.fromEntries(scorePairs.map((p) => [p.sessionId, p.score])),
      });
    }
  }

  // --- persist the run ---
  const { data: run, error: runErr } = await service
    .from('allocation_runs')
    .insert({ feature_extraction_run_id: featureExtractionRunId, status: 'draft', run_by: runBy })
    .select('id')
    .single();
  if (runErr || !run) throw new Error(`Failed to create allocation_runs row: ${runErr?.message}`);

  const assignmentRows = pending.map((p) => ({
    allocation_run_id: run.id,
    application_id: p.applicationId,
    session_id: p.sessionId,
    time_slot_group_key: p.timeSlotGroupKey,
    suitability_score: p.suitabilityScore,
    is_low_confidence: p.isLowConfidence,
    is_mandatory_assignment: p.isMandatoryAssignment,
    updated_by: runBy,
  }));

  const insertedAssignments: { id: string; application_id: string; session_id: string; time_slot_group_key: string }[] = [];
  if (assignmentRows.length > 0) {
    const { data: inserted, error: insertErr } = await service
      .from('allocation_assignments')
      .insert(assignmentRows)
      .select('id, application_id, session_id, time_slot_group_key');
    if (insertErr) throw new Error(`Failed to write allocation assignments: ${insertErr.message}`);
    insertedAssignments.push(...(inserted ?? []));
  }

  // --- Step 6: alternatives (top-N excluding the winner) ---
  const alternativeRows: { allocation_assignment_id: string; session_id: string; suitability_score: number; rank: number }[] = [];
  for (const inserted of insertedAssignments) {
    const p = pending.find((x) => x.applicationId === inserted.application_id && x.sessionId === inserted.session_id && x.timeSlotGroupKey === inserted.time_slot_group_key);
    if (!p) continue;
    const alternatives = Object.entries(p.scoresBySession)
      .filter(([sessionId]) => sessionId !== p.sessionId)
      .sort((a, b) => b[1] - a[1])
      .slice(0, ALTERNATIVES_COUNT);
    alternatives.forEach(([sessionId, score], index) => {
      alternativeRows.push({ allocation_assignment_id: inserted.id, session_id: sessionId, suitability_score: score, rank: index + 1 });
    });
  }
  if (alternativeRows.length > 0) {
    const { error: altErr } = await service.from('allocation_alternatives').insert(alternativeRows);
    if (altErr) throw new Error(`Failed to write alternatives: ${altErr.message}`);
  }

  // --- Step 8: explanations ---
  const explanationRows: { allocation_assignment_id: string; constraint_type: string; passed: boolean; detail: string }[] = [];
  for (const inserted of insertedAssignments) {
    const meta = participantMeta.get(inserted.application_id)!;
    const session = (sessionRows ?? []).find((s) => s.id === inserted.session_id)!;
    const participant: ParticipantForConstraints = { applicationId: inserted.application_id, preferredLanguage: meta.preferred_language, experienceLevel: meta.experience_level };
    const sessionForConstraints: SessionForConstraints = {
      id: session.id,
      status: session.status,
      includeInAllocation: session.include_in_allocation,
      language: session.language,
      difficultyLevel: session.difficulty_level,
      isMandatory: session.is_mandatory,
    };
    const constraintResult = checkStaticHardConstraints(participant, sessionForConstraints);
    for (const check of constraintResult.checks) {
      explanationRows.push({ allocation_assignment_id: inserted.id, constraint_type: check.constraintType, passed: check.passed, detail: check.detail });
    }
    const p = pending.find((x) => x.applicationId === inserted.application_id && x.sessionId === inserted.session_id);
    explanationRows.push({
      allocation_assignment_id: inserted.id,
      constraint_type: 'tag_similarity',
      passed: true,
      detail: `Cosine similarity score: ${p?.suitabilityScore.toFixed(3) ?? '0.000'}`,
    });
  }
  if (explanationRows.length > 0) {
    const { error: explErr } = await service.from('allocation_assignment_explanations').insert(explanationRows);
    if (explErr) throw new Error(`Failed to write explanations: ${explErr.message}`);
  }

  // --- Step 7 (part 1): unassigned / no_eligible_sessions / capacity_bottleneck via deriveIssues ---
  const timeSlotGroupsForIssues: TimeSlotGroupForIssues[] = timeSlotGroups.map((g) => {
    const eligibleSessionIdsByParticipant: Record<string, string[]> = {};
    for (const applicationId of participantIds) {
      const pairsInGroup = (scoresByApplication.get(applicationId) ?? []).filter((p) => g.sessionIds.includes(p.sessionId));
      eligibleSessionIdsByParticipant[applicationId] = pairsInGroup.map((p) => p.sessionId);
    }
    return { timeSlotGroupKey: g.timeSlotGroupKey, eligibleSessionIdsByParticipant };
  });

  // Per-constraint failure counts for every (participant, slot) pair with
  // zero eligible sessions, feeding no_eligible_sessions.details.failed_constraints_summary
  // (spec Data Model). Only computed for pairs that actually have zero
  // eligible sessions — cheap relative to score precomputation since it
  // only re-checks constraints for participants already known to have no
  // eligible candidates in that slot.
  const failedConstraintsSummary: Record<string, Record<string, number>> = {};
  for (const g of timeSlotGroups) {
    for (const applicationId of participantIds) {
      const eligibleInGroup = eligibleSessionIdsByParticipantForKey(timeSlotGroupsForIssues, g.timeSlotGroupKey, applicationId);
      if (eligibleInGroup.length > 0) continue;
      const meta = participantMeta.get(applicationId)!;
      const participant: ParticipantForConstraints = { applicationId, preferredLanguage: meta.preferred_language, experienceLevel: meta.experience_level };
      const summary: Record<string, number> = {};
      for (const sessionId of g.sessionIds) {
        const session = (sessionRows ?? []).find((s) => s.id === sessionId);
        if (!session || session.is_mandatory) continue;
        const sessionForConstraints: SessionForConstraints = {
          id: session.id,
          status: session.status,
          includeInAllocation: session.include_in_allocation,
          language: session.language,
          difficultyLevel: session.difficulty_level,
          isMandatory: session.is_mandatory,
        };
        const result = checkStaticHardConstraints(participant, sessionForConstraints);
        for (const check of result.checks) {
          if (!check.passed) summary[check.constraintType] = (summary[check.constraintType] ?? 0) + 1;
        }
      }
      failedConstraintsSummary[`${applicationId}:${g.timeSlotGroupKey}`] = summary;
    }
  }

  function eligibleSessionIdsByParticipantForKey(groups: TimeSlotGroupForIssues[], key: string, applicationId: string): string[] {
    return groups.find((x) => x.timeSlotGroupKey === key)?.eligibleSessionIdsByParticipant[applicationId] ?? [];
  }

  const assignmentsForIssues: AssignmentForIssues[] = insertedAssignments.map((a) => {
    const p = pending.find((x) => x.applicationId === a.application_id && x.sessionId === a.session_id)!;
    return { id: a.id, applicationId: a.application_id, sessionId: a.session_id, timeSlotGroupKey: a.time_slot_group_key, suitabilityScore: p.suitabilityScore };
  });

  const sessionCapacities: Record<string, number> = Object.fromEntries((sessionRows ?? []).map((s) => [s.id, s.capacity]));
  const assignedCountBySession: Record<string, number> = {};
  for (const a of insertedAssignments) assignedCountBySession[a.session_id] = (assignedCountBySession[a.session_id] ?? 0) + 1;

  // --- Step 7 (part 2): schedule_conflict defensive post-hoc check ---
  const assignmentsByParticipant = new Map<string, typeof insertedAssignments>();
  for (const a of insertedAssignments) {
    if (!assignmentsByParticipant.has(a.application_id)) assignmentsByParticipant.set(a.application_id, []);
    assignmentsByParticipant.get(a.application_id)!.push(a);
  }
  const scheduleConflictPairs: { assignmentIds: [string, string]; conferenceDayId: string }[] = [];
  for (const [, assignmentsForParticipant] of assignmentsByParticipant) {
    if (assignmentsForParticipant.length < 2) continue;
    const withTimes = assignmentsForParticipant.map((a) => ({ ...a, session: (sessionRows ?? []).find((s) => s.id === a.session_id)! }));
    for (let i = 0; i < withTimes.length; i++) {
      for (let j = i + 1; j < withTimes.length; j++) {
        const a = withTimes[i];
        const b = withTimes[j];
        if (a.session.conference_day_id !== b.session.conference_day_id) continue;
        const overlap = new Date(a.session.start_time) < new Date(b.session.end_time) && new Date(b.session.start_time) < new Date(a.session.end_time);
        if (overlap) scheduleConflictPairs.push({ assignmentIds: [a.id, b.id], conferenceDayId: a.session.conference_day_id });
      }
    }
  }

  const issues = deriveIssues({
    timeSlotGroups: timeSlotGroupsForIssues,
    assignments: assignmentsForIssues,
    lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD,
    sessionCapacities,
    assignedCountBySession,
    allParticipantIds: participantIds,
    scheduleConflictPairs,
    failedConstraintsSummary,
  });

  if (issues.length > 0) {
    const { error: issuesErr } = await service.from('allocation_issues').insert(
      issues.map((i) => ({
        allocation_run_id: run.id,
        issue_type: i.issueType,
        application_id: i.applicationId,
        session_id: i.sessionId,
        details: i.details,
      }))
    );
    if (issuesErr) throw new Error(`Failed to write allocation issues: ${issuesErr.message}`);
  }

  return { id: run.id };
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`

Expected friction point: the generated `Database` type's exact column names/nullability for `applications` (`preferred_language`, `experience_level`) and `sessions` (`language`, `difficulty_level`, `is_mandatory`, `capacity`) must match what's referenced here. If `npx tsc --noEmit` reports mismatches, check `src/types/database.ts` for the real field names/types and fix the orchestrator, not the generated file.

- [ ] **Step 3: Commit**

```bash
git add src/lib/allocation/run-allocation.ts
git commit -m "feat: add allocation run orchestrator implementing the full algorithm"
```

---

## Task 17: `confirmAllocationRun` transactional RPC

**Files:**
- Create: `supabase/migrations/20260723120000_confirm_allocation_run_function.sql`

Implements spec's "Confirmation" section: one atomic transition of the run + all its assignments, mirroring `update_session_and_assignments_transactional`'s pattern.

- [ ] **Step 1: Write the migration**

```sql
-- confirm_allocation_run_function.sql

-- Atomically confirms a draft allocation run: transitions the run to
-- 'confirmed' and every one of its assignments to 'confirmed' in one
-- transaction (plpgsql function bodies are atomic). Rejects if the run is
-- not currently 'draft' — a confirmed or discarded run cannot be
-- re-confirmed, per the spec's "Once confirmed, immutable" rule.
create function confirm_allocation_run_transactional(
  p_run_id uuid,
  p_confirmed_by uuid
) returns allocation_runs as $$
declare
  v_result allocation_runs;
begin
  update allocation_runs
  set status = 'confirmed', confirmed_at = now(), confirmed_by = p_confirmed_by
  where id = p_run_id and status = 'draft'
  returning * into v_result;

  if v_result.id is null then
    raise exception 'Allocation run % is not in draft status (already confirmed or discarded, or does not exist)', p_run_id;
  end if;

  update allocation_assignments
  set status = 'confirmed', updated_by = p_confirmed_by
  where allocation_run_id = p_run_id;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;

-- Discards a draft run (never confirmed, kept for audit history). Same
-- immutability rule: only a draft run can be discarded.
create function discard_allocation_run_transactional(
  p_run_id uuid
) returns allocation_runs as $$
declare
  v_result allocation_runs;
begin
  update allocation_runs
  set status = 'discarded'
  where id = p_run_id and status = 'draft'
  returning * into v_result;

  if v_result.id is null then
    raise exception 'Allocation run % is not in draft status (already confirmed or discarded, or does not exist)', p_run_id;
  end if;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;

-- Overrides a single assignment's session within a draft run. Re-validates
-- hard constraints and this-run-only capacity server-side before writing —
-- hard reject on failure, no bypass (spec: Manual Override Workflow). The
-- constraint/capacity re-check itself happens in the calling server action
-- (TypeScript, reusing checkStaticHardConstraints), not in this function;
-- this function only enforces the atomicity of "the run must still be
-- draft" and the write itself.
create function override_allocation_assignment_transactional(
  p_assignment_id uuid,
  p_new_session_id uuid,
  p_overridden_by uuid,
  p_override_reason text
) returns allocation_assignments as $$
declare
  v_result allocation_assignments;
  v_run_status text;
begin
  select ar.status into v_run_status
  from allocation_assignments aa
  join allocation_runs ar on ar.id = aa.allocation_run_id
  where aa.id = p_assignment_id;

  if v_run_status is null then
    raise exception 'Allocation assignment % not found', p_assignment_id;
  end if;

  if v_run_status <> 'draft' then
    raise exception 'Cannot override an assignment on a % allocation run — only draft runs are editable', v_run_status;
  end if;

  update allocation_assignments
  set session_id = p_new_session_id,
      is_manual_override = true,
      overridden_by = p_overridden_by,
      override_reason = p_override_reason,
      updated_by = p_overridden_by
  where id = p_assignment_id
  returning * into v_result;

  return v_result;
end;
$$ language plpgsql set search_path = public, pg_temp;
```

- [ ] **Step 2: Apply and verify** (same process as Task 1 Step 2). Confirm all three functions exist via `select proname from pg_proc where proname like '%allocation%';` against the hosted project.

**Rollback/failure behavior**: transactional apply. To roll back: `drop function confirm_allocation_run_transactional`, `drop function discard_allocation_run_transactional`, `drop function override_allocation_assignment_transactional`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260723120000_confirm_allocation_run_function.sql
git commit -m "feat: add transactional RPCs for confirm/discard/override"
```

---

## Task 18: Allocation run server actions (trigger, confirm, discard, override)

**Files:**
- Create: `src/app/[locale]/(admin)/allocation/runs/actions.ts`
- Create: `src/app/[locale]/(admin)/allocation/runs/[id]/actions.ts`

- [ ] **Step 1: Write `runs/actions.ts`** (list/trigger)

```ts
// src/app/[locale]/(admin)/allocation/runs/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { runAllocation } from '@/lib/allocation/run-allocation';
import { triggerAllocationRunSchema } from '@/lib/validation/allocation';

export async function triggerAllocationRun(input: unknown) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = triggerAllocationRunSchema.parse(input);
  const result = await runAllocation(service, userId, parsed.featureExtractionRunId);
  await writeAuditLog(service, { entityType: 'allocation_run', entityId: result.id, action: 'run', actorId: userId });
  return result;
}
```

- [ ] **Step 2: Write `runs/[id]/actions.ts`** (confirm/discard/override)

```ts
// src/app/[locale]/(admin)/allocation/runs/[id]/actions.ts
'use server';

import { requireAgendaStaffCaller, writeAuditLog } from '@/lib/agenda/server-helpers';
import { checkStaticHardConstraints, type ParticipantForConstraints, type SessionForConstraints } from '@/lib/allocation/hard-constraints';
import { overrideAssignmentSchema } from '@/lib/validation/allocation';

export async function confirmAllocationRun(runId: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data, error } = await service.rpc('confirm_allocation_run_transactional', { p_run_id: runId, p_confirmed_by: userId });
  if (error) throw new Error(`Failed to confirm allocation run: ${error.message}`);
  await writeAuditLog(service, { entityType: 'allocation_run', entityId: runId, action: 'confirm', actorId: userId });
  return data;
}

export async function discardAllocationRun(runId: string) {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data, error } = await service.rpc('discard_allocation_run_transactional', { p_run_id: runId });
  if (error) throw new Error(`Failed to discard allocation run: ${error.message}`);
  await writeAuditLog(service, { entityType: 'allocation_run', entityId: runId, action: 'discard', actorId: userId });
  return data;
}

export async function overrideAssignment(assignmentId: string, input: unknown) {
  const { userId, service } = await requireAgendaStaffCaller();
  const parsed = overrideAssignmentSchema.parse(input);

  // Re-validate hard constraints server-side before writing — hard reject,
  // never bypassed (spec: Manual Override Workflow failure behavior).
  const { data: assignment, error: assignmentErr } = await service
    .from('allocation_assignments')
    .select('id, application_id, allocation_run_id')
    .eq('id', assignmentId)
    .single();
  if (assignmentErr || !assignment) throw new Error('Assignment not found');

  const { data: application, error: appErr } = await service
    .from('applications')
    .select('preferred_language, experience_level')
    .eq('id', assignment.application_id)
    .single();
  if (appErr || !application) throw new Error('Application not found');

  const { data: session, error: sessionErr } = await service
    .from('sessions')
    .select('id, status, include_in_allocation, language, difficulty_level, is_mandatory, capacity')
    .eq('id', parsed.sessionId)
    .single();
  if (sessionErr || !session) throw new Error('Target session not found');

  const participant: ParticipantForConstraints = {
    applicationId: assignment.application_id,
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
    throw new Error(`Cannot assign: ${failed?.detail ?? 'hard constraint failed'}`);
  }

  // Dynamic capacity check, scoped to this run's own assignments only (spec:
  // "Capacity re-validation scope").
  const { count, error: countErr } = await service
    .from('allocation_assignments')
    .select('id', { count: 'exact', head: true })
    .eq('allocation_run_id', assignment.allocation_run_id)
    .eq('session_id', parsed.sessionId);
  if (countErr) throw new Error(`Failed to check capacity: ${countErr.message}`);
  if ((count ?? 0) >= session.capacity) {
    throw new Error('Cannot assign: session is at capacity for this allocation run');
  }

  const { data, error } = await service.rpc('override_allocation_assignment_transactional', {
    p_assignment_id: assignmentId,
    p_new_session_id: parsed.sessionId,
    p_overridden_by: userId,
    p_override_reason: parsed.overrideReason,
  });
  if (error) throw new Error(`Failed to override assignment: ${error.message}`);

  await writeAuditLog(service, {
    entityType: 'allocation_assignment',
    entityId: assignmentId,
    action: 'override',
    actorId: userId,
    metadata: { newSessionId: parsed.sessionId, reason: parsed.overrideReason },
  });
  return data;
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`

Note: `service.rpc('confirm_allocation_run_transactional', ...)` and the other two RPC names will not be present in the generated `Database` type until the type-generation step is re-run against the hosted project after Task 17's migration is applied (see Task 19). If typecheck fails only on the `.rpc(...)` call's generic inference, proceed to Task 19 first, then re-run typecheck.

- [ ] **Step 4: Commit**

```bash
git add "src/app/[locale]/(admin)/allocation/runs/actions.ts" "src/app/[locale]/(admin)/allocation/runs/[id]/actions.ts"
git commit -m "feat: add allocation run trigger/confirm/discard/override actions"
```

---

## Task 19: Regenerate Supabase types

**Files:**
- Modify: `src/types/database.ts` (generated — do not hand-edit content, only regenerate)

- [ ] **Step 1:** Run whatever command Phase 1–3 used to regenerate `src/types/database.ts` against the hosted project (check `package.json` for a `gen:types` script, or use `npx supabase gen types typescript --project-id <id> > src/types/database.ts` with the project id from `.env`/`supabase/config.toml`).
- [ ] **Step 2:** Run `npx tsc --noEmit` — confirm all Task 14–18 files now typecheck cleanly against the regenerated types, including the three new RPC function names.
- [ ] **Step 3: Commit**

```bash
git add src/types/database.ts
git commit -m "chore: regenerate Supabase types for Phase 4 tables and functions"
```

---

## Task 20: Admin pages

**Files:**
- Create: `src/app/[locale]/(admin)/allocation/page.tsx`
- Create: `src/app/[locale]/(admin)/allocation/extraction/page.tsx`
- Create: `src/app/[locale]/(admin)/allocation/extraction/rule-manager.tsx`
- Create: `src/app/[locale]/(admin)/allocation/clustering/page.tsx`
- Create: `src/app/[locale]/(admin)/allocation/clustering/cluster-list.tsx`
- Create: `src/app/[locale]/(admin)/allocation/runs/page.tsx`
- Create: `src/app/[locale]/(admin)/allocation/runs/run-list.tsx`
- Create: `src/app/[locale]/(admin)/allocation/runs/[id]/page.tsx`
- Create: `src/app/[locale]/(admin)/allocation/runs/[id]/assignment-table.tsx`
- Create: `src/app/[locale]/(admin)/allocation/runs/[id]/assignment-detail.tsx`
- Create: `src/app/[locale]/(admin)/allocation/runs/[id]/override-form.tsx`
- Create: `src/app/[locale]/(admin)/allocation/runs/[id]/capacity/page.tsx`

This task is UI-heavy and best handled by a dedicated implementer subagent given the exact route list above plus the existing Phase 3 page patterns (`src/app/[locale]/(admin)/agenda/sessions/[id]/page.tsx` and its sibling client components) as the reference to follow for: server-component page shell calling `requireAgendaStaffCaller`-gated data fetches, minimal/unstyled Tailwind convention, client components for interactive forms calling the Task 14/15/18 server actions.

- [ ] **Step 1:** Implement `/admin/allocation` — overview page linking to `extraction`, `clustering`, `runs` sub-sections, following the route-group/auth-gate convention of `src/app/[locale]/(admin)/agenda/page.tsx`.
- [ ] **Step 2:** Implement `/admin/allocation/extraction` — list active/inactive `feature_extraction_rules`, a form to create a new rule (calls `createExtractionRule`), a button to trigger a new run (calls `triggerFeatureExtraction`), and a list of past `feature_extraction_runs`.
- [ ] **Step 3:** Implement `/admin/allocation/clustering` — list `clustering_runs`, a form to trigger a new run given a `feature_extraction_run_id`/`k`/`random_seed` (calls `triggerClusteringRun`), and per-run cluster/membership viewer.
- [ ] **Step 4:** Implement `/admin/allocation/runs` — list `allocation_runs` with status, a button to trigger a new run given a `feature_extraction_run_id` (calls `triggerAllocationRun`).
- [ ] **Step 5:** Implement `/admin/allocation/runs/[id]` — draft-run review: summary counts (total assignments, issues by type), filterable assignment table, per-assignment detail (score, `allocation_assignment_explanations`, `allocation_alternatives`) with an override form (calls `overrideAssignment`), and Confirm/Discard buttons (call `confirmAllocationRun`/`discardAllocationRun`) — disabled once `status !== 'draft'`.
- [ ] **Step 6:** Implement `/admin/allocation/runs/[id]/capacity` — per-session capacity usage: `capacity` vs. filled count (counting both `'proposed'` and `'confirmed'` status per spec), oversubscription flag when filled === capacity and `capacity_bottleneck` issues exist for that session.
- [ ] **Step 7:** Run `npx tsc --noEmit`, `npm run lint`.
- [ ] **Step 8:** Manually verify in a browser: start the dev server (`npm run dev`), sign in as a seeded `agenda_allocation_manager` user (or `super_admin`), walk the golden path — trigger extraction, trigger clustering, trigger an allocation run, open the run detail page, override one assignment, confirm the run, verify the capacity page reflects confirmed counts, verify a second confirm attempt is rejected.
- [ ] **Step 9: Commit**

```bash
git add "src/app/[locale]/(admin)/allocation"
git commit -m "feat: add Phase 4 admin allocation pages"
```

---

## Task 21: Live behavioral test suite

**Files:**
- Create: `tests/allocation/authorization.test.ts`
- Create: `tests/allocation/run-behavioral.test.ts`

Implements spec Testing Requirements #5. Follows the exact throwaway-user pattern from `tests/agenda/authorization.test.ts` (see Conventions above) — no retry wrapper exists in this codebase; don't invent one.

- [ ] **Step 1: Write `tests/allocation/authorization.test.ts`**

```ts
// tests/allocation/authorization.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

let participantId: string | undefined;
let staffId: string | undefined;

beforeAll(async () => {
  const { data: participant } = await admin.auth.admin.createUser({ email: 'allocation-authz-participant@test.local', password: 'password123', email_confirm: true });
  participantId = participant.user!.id;
  await admin.from('profiles').update({ role: 'participant' }).eq('id', participantId);

  const { data: staff } = await admin.auth.admin.createUser({ email: 'allocation-authz-staff@test.local', password: 'password123', email_confirm: true });
  staffId = staff.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);
});

afterAll(async () => {
  await Promise.allSettled([
    participantId ? admin.auth.admin.deleteUser(participantId) : Promise.resolve(),
    staffId ? admin.auth.admin.deleteUser(staffId) : Promise.resolve(),
  ]);
});

describe('allocation RLS: non-staff cannot read allocation tables', () => {
  it('rejects a participant reading allocation_runs directly', async () => {
    const client = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    await client.auth.signInWithPassword({ email: 'allocation-authz-participant@test.local', password: 'password123' });
    const { data } = await client.from('allocation_runs').select('id');
    // RLS silently returns an empty set for a non-staff caller rather than an
    // error — the meaningful assertion is that no rows leaked.
    expect(data ?? []).toHaveLength(0);
  });

  it('allows staff to read allocation_runs directly', async () => {
    const client = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    await client.auth.signInWithPassword({ email: 'allocation-authz-staff@test.local', password: 'password123' });
    const { error } = await client.from('allocation_runs').select('id');
    expect(error).toBeNull();
  });
});
```

Note: per the codebase's established pattern (see `tests/agenda/authorization.test.ts`), server actions themselves can't be invoked outside a Next.js request context, so authorization for the actions in Tasks 14/15/18 is verified via `requireAgendaStaffCaller`'s already-shared logic (identical function, already covered by Phase 3's own tests) plus this RLS-level check as defense-in-depth verification, matching Phase 3's own testing scope exactly.

- [ ] **Step 2: Write `tests/allocation/run-behavioral.test.ts`**

This test seeds a minimal real scenario directly via the service-role client, then calls the orchestrators from Tasks 14/16 directly (not through the HTTP action layer, matching the codebase's established test-access pattern) and asserts on the resulting rows. It must cover all six behaviors named in the spec's Testing Requirements #5: oversubscribed-mandatory bottleneck, zero-eligible-sessions, low-confidence boundary, override persistence, confirmed-run immutability, unauthorized-role rejection (the last is covered by `authorization.test.ts` from Step 1).

**Critical schema note**: `applications` has no `email`/`full_name` columns. It has a NOT-NULL `applicant_id uuid references profiles(id)` with a **unique index — one application per applicant**. Every test applicant therefore needs its own throwaway auth user (which auto-creates its `profiles` row), then an `applications` row referencing that `applicant_id`. Do not invent columns — verify every field against `supabase/migrations/20260721202027_applications_table.sql` before writing the insert.

```ts
// tests/allocation/run-behavioral.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { runFeatureExtraction } from '@/lib/allocation/run-extraction';
import { runAllocation } from '@/lib/allocation/run-allocation';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

let staffId: string;
let conferenceDayId: string;
let roomId: string;
let trackId: string;
let sessionTypeId: string;
let mandatorySessionId: string;
let electiveSessionId: string;
let noMatchSessionId: string; // 'en'-only, so an 'ar'-only participant has zero eligible sessions here
let tagId: string;
const applicantUserIds: string[] = []; // throwaway auth users backing each applications.applicant_id
const applicationIds: string[] = [];

// Creates one throwaway auth user + its accepted application row. Returns
// the new applications.id. preferredLanguage/experienceLevel/interests feed
// the hard constraints and feature extraction directly.
async function seedAcceptedApplicant(opts: {
  emailSlug: string;
  preferredLanguage: string | null;
  experienceLevel: string | null;
  interests: string[];
}): Promise<string> {
  const { data: user } = await admin.auth.admin.createUser({
    email: `allocation-behavior-${opts.emailSlug}@test.local`,
    password: 'password123',
    email_confirm: true,
  });
  const applicantId = user!.user!.id;
  applicantUserIds.push(applicantId);

  const { data: app } = await admin
    .from('applications')
    .insert({
      applicant_id: applicantId,
      status: 'accepted',
      preferred_language: opts.preferredLanguage,
      experience_level: opts.experienceLevel,
      interests: opts.interests,
    })
    .select('id')
    .single();
  applicationIds.push(app!.id);
  return app!.id;
}

beforeAll(async () => {
  const { data: staff } = await admin.auth.admin.createUser({ email: 'allocation-behavior-staff@test.local', password: 'password123', email_confirm: true });
  staffId = staff.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);

  const { data: day } = await admin.from('conference_days').insert({ conference_date: '2026-09-01', label_ar: 'يوم 1', label_en: 'Day 1', display_order: 1 }).select('id').single();
  conferenceDayId = day!.id;
  const { data: room } = await admin.from('rooms').insert({ code: 'ALLOC-TEST-ROOM', name_ar: 'قاعة', name_en: 'Room', capacity: 10 }).select('id').single();
  roomId = room!.id;
  const { data: track } = await admin.from('tracks').insert({ code: 'ALLOC-TEST-TRACK', name_ar: 'مسار', name_en: 'Track' }).select('id').single();
  trackId = track!.id;
  const { data: sessionType } = await admin.from('session_types').insert({ code: 'ALLOC-TEST-TYPE', name_ar: 'نوع', name_en: 'Type' }).select('id').single();
  sessionTypeId = sessionType!.id;
  const { data: tag } = await admin.from('tags').insert({ code: 'ALLOC-TEST-TAG', name_ar: 'وسم', name_en: 'Tag' }).select('id').single();
  tagId = tag!.id;

  const { data: mandatory } = await admin
    .from('sessions')
    .insert({
      session_code: 'ALLOC-MANDATORY-1', title_ar: 'إلزامية', title_en: 'Mandatory', conference_day_id: conferenceDayId,
      start_time: '2026-09-01T09:00:00Z', end_time: '2026-09-01T10:00:00Z', track_id: trackId, session_type_id: sessionTypeId,
      room_id: roomId, language: 'bilingual', difficulty_level: 'all_levels', capacity: 1, is_mandatory: true, status: 'confirmed',
    })
    .select('id').single();
  mandatorySessionId = mandatory!.id;

  const { data: elective } = await admin
    .from('sessions')
    .insert({
      session_code: 'ALLOC-ELECTIVE-1', title_ar: 'اختيارية', title_en: 'Elective', conference_day_id: conferenceDayId,
      start_time: '2026-09-01T11:00:00Z', end_time: '2026-09-01T12:00:00Z', track_id: trackId, session_type_id: sessionTypeId,
      room_id: roomId, language: 'bilingual', difficulty_level: 'all_levels', capacity: 1, is_mandatory: false, status: 'confirmed',
    })
    .select('id').single();
  electiveSessionId = elective!.id;
  await admin.from('session_tags').insert({ session_id: electiveSessionId, tag_id: tagId, weight: 1.0 });

  // 'en'-only, non-bilingual — an 'ar'-preferring participant is hard-
  // excluded from this session by the language constraint, giving that
  // participant zero eligible sessions in this slot group.
  const { data: noMatch } = await admin
    .from('sessions')
    .insert({
      session_code: 'ALLOC-NOMATCH-1', title_ar: 'غير متاحة', title_en: 'No Match', conference_day_id: conferenceDayId,
      start_time: '2026-09-01T13:00:00Z', end_time: '2026-09-01T14:00:00Z', track_id: trackId, session_type_id: sessionTypeId,
      room_id: roomId, language: 'en', difficulty_level: 'all_levels', capacity: 5, is_mandatory: false, status: 'confirmed',
    })
    .select('id').single();
  noMatchSessionId = noMatch!.id;

  await seedAcceptedApplicant({ emailSlug: 'app-0', preferredLanguage: 'ar', experienceLevel: 'beginner', interests: [] });
  await seedAcceptedApplicant({ emailSlug: 'app-1', preferredLanguage: 'ar', experienceLevel: 'beginner', interests: [] });
});

afterAll(async () => {
  await Promise.allSettled([
    admin.from('sessions').delete().in('id', [mandatorySessionId, electiveSessionId, noMatchSessionId]),
    admin.from('applications').delete().in('id', applicationIds),
    admin.from('conference_days').delete().eq('id', conferenceDayId),
    admin.from('rooms').delete().eq('id', roomId),
    admin.from('tracks').delete().eq('id', trackId),
    admin.from('session_types').delete().eq('id', sessionTypeId),
    admin.from('tags').delete().eq('id', tagId),
    staffId ? admin.auth.admin.deleteUser(staffId) : Promise.resolve(),
    ...applicantUserIds.map((id) => admin.auth.admin.deleteUser(id)),
  ]);
});

describe('allocation run behavioral suite', () => {
  it('oversubscribed mandatory session produces capacity_bottleneck and unassigned', async () => {
    const extraction = await runFeatureExtraction(admin, staffId);
    const run = await runAllocation(admin, staffId, extraction.id);

    const { data: issues } = await admin.from('allocation_issues').select('issue_type, application_id, session_id').eq('allocation_run_id', run.id);
    expect(issues?.some((i) => i.issue_type === 'capacity_bottleneck' && i.session_id === mandatorySessionId)).toBe(true);
    expect(issues?.some((i) => i.issue_type === 'unassigned')).toBe(true);
  });

  it('a participant hard-excluded from every session in a slot produces no_eligible_sessions', async () => {
    // Both seeded applicants prefer 'ar'; ALLOC-NOMATCH-1 is 'en'-only, so
    // in that session's own singleton slot group, both applicants have zero
    // eligible sessions.
    const extraction = await runFeatureExtraction(admin, staffId);
    const run = await runAllocation(admin, staffId, extraction.id);

    const { data: issues } = await admin
      .from('allocation_issues')
      .select('issue_type, application_id, details')
      .eq('allocation_run_id', run.id)
      .eq('issue_type', 'no_eligible_sessions');
    expect(issues?.some((i) => applicationIds.includes(i.application_id!))).toBe(true);
  });

  it('flags an assignment scoring below 0.4 as low_confidence, consistent with the stored score', async () => {
    // This live test only exercises the below-threshold side (the seeded
    // participants produce a 0-score match here, per the zero-vector
    // convention) — it does not seed a score at exactly the 0.4 boundary, so
    // it cannot by itself catch a `<` vs `<=` regression at the boundary.
    // That exact-boundary case is covered by the pure unit test
    // "does not flag low_confidence exactly at the threshold boundary" in
    // tests/allocation/issues.test.ts (Task 12) — this test's purpose is to
    // confirm the live orchestrator wires suitability_score/is_low_confidence
    // through to the database consistently with LOW_CONFIDENCE_THRESHOLD,
    // not to re-prove the boundary itself.
    const extraction = await runFeatureExtraction(admin, staffId);
    const run = await runAllocation(admin, staffId, extraction.id);

    // app-1 has no extracted tags at all (interests: []) -> cosine similarity
    // against ALLOC-ELECTIVE-1's tag resolves to 0 (zero-vector convention),
    // which is < 0.4 -> must be flagged low_confidence if assigned there.
    const { data: assignments } = await admin
      .from('allocation_assignments')
      .select('id, application_id, session_id, suitability_score, is_low_confidence')
      .eq('allocation_run_id', run.id)
      .eq('session_id', electiveSessionId);

    for (const a of assignments ?? []) {
      expect(a.is_low_confidence).toBe(a.suitability_score < 0.4);
    }
    // At least one zero-tag participant assigned to the tagged elective
    // session must be flagged, proving the below-threshold path actually ran.
    expect((assignments ?? []).some((a) => a.suitability_score < 0.4 && a.is_low_confidence)).toBe(true);
  });

  it('a manual override persists into the confirmed run final state', async () => {
    const extraction = await runFeatureExtraction(admin, staffId);
    const run = await runAllocation(admin, staffId, extraction.id);

    const { data: anAssignment } = await admin
      .from('allocation_assignments')
      .select('id, session_id')
      .eq('allocation_run_id', run.id)
      .neq('session_id', electiveSessionId)
      .limit(1)
      .maybeSingle();
    expect(anAssignment).not.toBeNull();

    const { data: overridden, error: overrideError } = await admin.rpc('override_allocation_assignment_transactional', {
      p_assignment_id: anAssignment!.id,
      p_new_session_id: electiveSessionId,
      p_overridden_by: staffId,
      p_override_reason: 'behavioral test override',
    });
    expect(overrideError).toBeNull();
    expect(overridden?.session_id).toBe(electiveSessionId);

    const { error: confirmError } = await admin.rpc('confirm_allocation_run_transactional', { p_run_id: run.id, p_confirmed_by: staffId });
    expect(confirmError).toBeNull();

    const { data: finalAssignment } = await admin.from('allocation_assignments').select('session_id, is_manual_override, status').eq('id', anAssignment!.id).single();
    expect(finalAssignment?.session_id).toBe(electiveSessionId);
    expect(finalAssignment?.is_manual_override).toBe(true);
    expect(finalAssignment?.status).toBe('confirmed');
  });

  it('confirming a run makes it immutable — a second confirm/override attempt is rejected', async () => {
    const extraction = await runFeatureExtraction(admin, staffId);
    const run = await runAllocation(admin, staffId, extraction.id);

    const { error: firstConfirm } = await admin.rpc('confirm_allocation_run_transactional', { p_run_id: run.id, p_confirmed_by: staffId });
    expect(firstConfirm).toBeNull();

    const { error: secondConfirm } = await admin.rpc('confirm_allocation_run_transactional', { p_run_id: run.id, p_confirmed_by: staffId });
    expect(secondConfirm).not.toBeNull();

    const { data: anAssignment } = await admin.from('allocation_assignments').select('id').eq('allocation_run_id', run.id).limit(1).maybeSingle();
    expect(anAssignment).not.toBeNull();

    const { error: overrideError } = await admin.rpc('override_allocation_assignment_transactional', {
      p_assignment_id: anAssignment!.id, p_new_session_id: electiveSessionId, p_overridden_by: staffId, p_override_reason: 'test',
    });
    expect(overrideError).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run the live tests**

Run: `npx vitest run tests/allocation/authorization.test.ts tests/allocation/run-behavioral.test.ts`
Expected: PASS. If a live Auth Admin API call is intermittently flaky (a known characteristic of this project across all prior phases), rerun the command — do not add retry infrastructure. Note each `it(...)` block triggers its own fresh extraction+allocation run against the same seeded applicants/sessions — this is intentional (each run is independent per the spec's model) but means the suite creates several `feature_extraction_runs`/`allocation_runs` rows; no cleanup of those specific rows is needed since `afterAll` removes the underlying applications/sessions they reference via cascade where applicable, and orphaned run rows referencing deleted applications are acceptable test-data residue (same tolerance Phase 3's tests already accept for its own run tables).

- [ ] **Step 4: Commit**

```bash
git add tests/allocation/authorization.test.ts tests/allocation/run-behavioral.test.ts
git commit -m "test: add live behavioral suite for allocation authorization and run lifecycle"
```

---

## Task 22: Reproducibility test

**Files:**
- Create: `tests/allocation/reproducibility.test.ts`

Implements spec Testing Requirements #6 — the test that actually proves the "reproducible runs" requirement end to end.

- [ ] **Step 1: Write the test**

```ts
// tests/allocation/reproducibility.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { runFeatureExtraction } from '@/lib/allocation/run-extraction';
import { runAllocation } from '@/lib/allocation/run-allocation';
import { runClustering } from '@/lib/allocation/run-clustering';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

let staffId: string;

beforeAll(async () => {
  const { data: staff } = await admin.auth.admin.createUser({ email: 'allocation-repro-staff@test.local', password: 'password123', email_confirm: true });
  staffId = staff.user!.id;
  await admin.from('profiles').update({ role: 'agenda_allocation_manager' }).eq('id', staffId);
});

afterAll(async () => {
  await Promise.allSettled([staffId ? admin.auth.admin.deleteUser(staffId) : Promise.resolve()]);
});

function normalizeAssignments(rows: { application_id: string; session_id: string; suitability_score: number; time_slot_group_key: string }[]) {
  return [...rows]
    .sort((a, b) => (a.application_id + a.time_slot_group_key).localeCompare(b.application_id + b.time_slot_group_key))
    .map((r) => ({ application_id: r.application_id, session_id: r.session_id, score: r.suitability_score, slot: r.time_slot_group_key }));
}

describe('reproducibility', () => {
  it('identical extraction+allocation params against an unchanged snapshot produce identical assignments', async () => {
    const extractionA = await runFeatureExtraction(admin, staffId);
    const runA = await runAllocation(admin, staffId, extractionA.id);
    const { data: assignmentsA } = await admin
      .from('allocation_assignments')
      .select('application_id, session_id, suitability_score, time_slot_group_key')
      .eq('allocation_run_id', runA.id);

    // Second extraction over the same underlying accepted-applications data
    // (unchanged between the two runs in this test) must produce the same
    // snapshots, and a second allocation run over those snapshots must
    // produce the same assignments.
    const extractionB = await runFeatureExtraction(admin, staffId);
    const runB = await runAllocation(admin, staffId, extractionB.id);
    const { data: assignmentsB } = await admin
      .from('allocation_assignments')
      .select('application_id, session_id, suitability_score, time_slot_group_key')
      .eq('allocation_run_id', runB.id);

    expect(normalizeAssignments(assignmentsB ?? [])).toEqual(normalizeAssignments(assignmentsA ?? []));
  });

  it('identical clustering params (same seed+k) against an unchanged snapshot produce identical cluster memberships', async () => {
    const extraction = await runFeatureExtraction(admin, staffId);
    const clusterRunA = await runClustering(admin, staffId, extraction.id, 2, 42);
    const clusterRunB = await runClustering(admin, staffId, extraction.id, 2, 42);

    const { data: clustersA } = await admin.from('clusters').select('id, member_count').eq('clustering_run_id', clusterRunA.id);
    const { data: clustersB } = await admin.from('clusters').select('id, member_count').eq('clustering_run_id', clusterRunB.id);

    const memberCountsA = (clustersA ?? []).map((c) => c.member_count).sort();
    const memberCountsB = (clustersB ?? []).map((c) => c.member_count).sort();
    expect(memberCountsB).toEqual(memberCountsA);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/allocation/reproducibility.test.ts`
Expected: PASS. If the accepted-applications data in the hosted project changes between the two calls within the test (unlikely mid-test, but note the risk), this test's premise ("unchanged data snapshot") would be violated — this is a test-data assumption, not a code bug, if it ever flakes for that specific reason.

- [ ] **Step 3: Commit**

```bash
git add tests/allocation/reproducibility.test.ts
git commit -m "test: add reproducibility test proving identical runs produce identical output"
```

---

## Task 23: Final verification pass

- [ ] **Step 1:** Run `npx tsc --noEmit` — zero errors across the whole worktree.
- [ ] **Step 2:** Run `npm run lint` — zero errors.
- [ ] **Step 3:** Run `npm test` — full suite (Tasks 5–12, 21, 22) passing.
- [ ] **Step 4:** Run `npm run build` — production build succeeds.
- [ ] **Step 5:** Re-read the design spec's 11 numbered functional requirements and the Non-Goals list one more time against the implemented code; confirm nothing automated admission, nothing auto-published a participant-facing schedule, and every one of the 11 requirements has a corresponding table/function/page from Tasks 1–20.
- [ ] **Step 6:** No commit for this task — this is the checkpoint before final code review (see subagent-driven-development's "Dispatch final code reviewer subagent for entire implementation" step, and then `superpowers:finishing-a-development-branch`).

---

## Notes for the implementing agent

- **Do not implement QR/scanner/attendance/schedule-publishing** — explicitly out of scope per the spec's Non-Goals and the user's original instruction.
- **Do not add a `typecheck` npm script** unless asked — this plan intentionally uses `npx tsc --noEmit` directly, matching the codebase's current (scriptless) convention; adding one would be an unrequested change to `package.json`.
- **Do not modify `applications_select_staff`** or any other Phase 1/2-owned RLS policy — Phase 4 reads `applications` via the service-role client specifically because it must not touch that policy (see spec's Access Control section and this plan's Task 14).
- Task 16 (the allocation orchestrator) is the highest-complexity task in this plan. If dispatched to a subagent, use the most capable available model per subagent-driven-development's model-selection guidance — this is not a mechanical task.
- Task 20 (admin pages) is the most independent task from the rest — could be parallelized against Task 21/22 if using multiple worktrees, but this plan assumes single-worktree sequential subagent-driven-development, so keep it in order.
