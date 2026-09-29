# Accounts Reset and Test Users Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanently reset the production COY21 Supabase project — deleting every account and every row of participant/application data while preserving conference configuration — then provision exactly 4 test accounts, one per role in the current 4-role model, and add a live test proving the `staff` role's existing RLS permissions already satisfy the requested boundary.

**Architecture:** A single new, atomic Postgres migration performs the data reset (nullify/delete config-table dependencies → truncate the ~36-table participant/application graph with `cascade` → delete `auth.users`, which cascades into `profiles` → reset the 5 attendee-code sequences). Account creation is manual (dashboard) by design — no password ever touches code. A SQL role-assignment pass and a full rewrite of one now-obsolete live test file complete the work.

**Tech Stack:** Supabase CLI (`supabase db push`), Postgres migrations, Vitest live integration tests, Supabase JS admin client.

**Full design spec:** `docs/superpowers/specs/2026-09-30-accounts-reset-and-test-users-design.md` — read this first. It documents the full FK-dependency research (3 review rounds) behind every statement in Task 1 below; do not deviate from the SQL it specifies.

---

## File Structure

**New files:**
- `supabase/migrations/20260930000000_reset_all_accounts_and_participant_data.sql` — the reset migration (Task 1)
- `tests/auth/accounts-reset-live.test.ts` — live test proving the reset migration leaves every listed table empty and every sequence restarted, run against a disposable scratch project only, never production (Task 2)

**Modified files:**
- `tests/auth/staff-roles-live.test.ts` — full rewrite (not a patch) to match the new 4-account structure; the old file asserts a now-obsolete 2-staff-account, fixed-password structure with `albaraak2002@gmail.com`/`albaraaalbadwi@gmail.com` role assignments that are the exact opposite of this plan's target state (Task 4)

**Not touched:** no `src/` application code changes in this plan — every RLS permission this plan needs already exists (confirmed in spec research); this plan is migrations + tests + manual dashboard steps only.

---

## Task 1: The reset migration

**Files:**
- Create: `supabase/migrations/20260930000000_reset_all_accounts_and_participant_data.sql`

**Context:** This migration is destructive and, when applied to the real production COY21 project, irreversible. Read the full design spec's "Design" section before writing this file — it explains exactly why each statement is needed (FK dependency chains discovered across 3 rounds of spec review) and must not be deviated from. This task only WRITES the migration file; it does NOT apply it to production. Applying it happens in Task 3, gated by an explicit human confirmation step.

- [ ] **Step 1: Write the migration file**

```sql
-- 20260930000000_reset_all_accounts_and_participant_data.sql
--
-- Resets the COY21 project to a clean slate: deletes every account and
-- every row of participant/application data, while preserving conference
-- configuration (rooms, session types, tracks, days, tags, sessions,
-- local info content). See
-- docs/superpowers/specs/2026-09-30-accounts-reset-and-test-users-design.md
-- for the full FK-dependency research behind every statement below —
-- this file must not be edited without re-reading that spec, since the
-- statement list and order were derived from 3 rounds of review finding
-- real FK-violation bugs in earlier drafts.
--
-- THIS MIGRATION IS DESTRUCTIVE AND IRREVERSIBLE WHEN APPLIED TO A REAL
-- PROJECT. Do not apply it without first positively confirming, via the
-- Supabase dashboard project name/ref (not just "it looks empty" or "it
-- looks full") and a row-count sanity check, that you are connected to
-- the intended target project. See the design spec's "Execution-time
-- safety gate" section — this confirmation happens outside this file,
-- immediately before running `supabase db push`, not inside the SQL.

-- ============================================================================
-- Part 1: truncate the full participant/application dependency graph.
-- Every table here has a direct or transitive FK to `applications`.
-- `cascade` is required (not optional) because several of these tables
-- use `on delete restrict` (qr_credentials, qr_lifecycle_operations,
-- qr_bulk_operation_batches via qr_lifecycle_operations.bulk_batch_id)
-- and others use plain `references` with no `on delete` action, which
-- Postgres defaults to `no action` (same effective behavior as restrict).
-- `truncate ... cascade` resolves the whole dependency graph itself, so
-- the listed order does not matter — but every table with any FK path
-- back to `applications` MUST be named here; cascade only follows
-- children of tables actually named in the statement.
-- ============================================================================
truncate table
  application_status_history, email_log, application_notes,
  feature_extraction_runs, participant_feature_snapshots,
  clustering_runs, clusters, cluster_memberships,
  allocation_runs, allocation_assignments, allocation_alternatives,
  allocation_issues, allocation_assignment_explanations,
  schedule_publications, schedule_publication_items,
  schedule_publication_drafts, schedule_publication_draft_items,
  application_answers,
  import_batches, import_column_mappings, import_rows, import_mapping_templates,
  participant_invitations,
  application_travel_info, application_health_info,
  participant_account_provisioning,
  attendance_records, scan_attempts,
  qr_lifecycle_operations, qr_bulk_operation_batches, qr_credentials,
  session_bookings, travel_legs,
  emergency_contacts, application_accommodation,
  applications
cascade;

-- ============================================================================
-- Part 2: clear every dependency the KEPT conference-config tables have on
-- profiles, so the auth.users delete in Part 3 doesn't hit a foreign-key
-- violation. These tables and their actual config data (room names,
-- session titles, day definitions, tags) are NOT truncated — only the
-- "who last touched this" attribution columns are nulled, since the
-- person who touched them is about to no longer exist.
-- ============================================================================
update rooms set updated_by = null where updated_by is not null;
update tracks set updated_by = null where updated_by is not null;
update session_types set updated_by = null where updated_by is not null;
update conference_days set updated_by = null where updated_by is not null;
update tags set updated_by = null where updated_by is not null;
update people set updated_by = null, linked_profile_id = null where updated_by is not null or linked_profile_id is not null;
update sessions set updated_by = null where updated_by is not null;
update session_people set updated_by = null where updated_by is not null;
update session_tags set updated_by = null where updated_by is not null;
update audit_logs set actor_id = null where actor_id is not null;

-- scanner_assignments is deleted outright, not nullified: both of its
-- profile-referencing columns (scanner_user_id, assigned_by) are `not
-- null`, and an assignment record pointing at a now-deleted account has
-- no meaning to preserve (unlike a room or session, which still makes
-- sense to keep with an anonymous "last updated by" trail).
delete from scanner_assignments;

-- staff_assignments needs no explicit statement here: its staff_id column
-- is already `references profiles(id) on delete cascade`, so it is
-- correctly and automatically cleared by the auth.users delete in Part 3
-- below. Named here only so this migration's own comments give a
-- complete accounting of every table with any dependency on the accounts
-- being deleted, matching the standard applied to scanner_assignments
-- just above.

-- ============================================================================
-- Part 3: delete every account. profiles.id references auth.users(id) on
-- delete cascade (see supabase/migrations/20260721200747_roles_and_profiles.sql),
-- so this single statement also removes every profiles row — do not
-- truncate profiles separately or first, which would leave orphaned
-- auth.users rows.
-- ============================================================================
delete from auth.users;

-- ============================================================================
-- Part 4: restart the 5 per-classification attendee-code sequences so the
-- first real import after this reset gets clean COY21-DEL-0001-style
-- numbering.
-- ============================================================================
alter sequence attendee_code_seq_del restart with 1;
alter sequence attendee_code_seq_vol restart with 1;
alter sequence attendee_code_seq_kp restart with 1;
alter sequence attendee_code_seq_yng restart with 1;
alter sequence attendee_code_seq_spk restart with 1;
```

- [ ] **Step 2: Confirm the file is syntactically well-formed**

You cannot apply this against production yet (that's Task 3, gated). Do a careful manual read-through instead: confirm every `truncate table` entry and every `update`/`delete` target matches a real table name from the migrations listed in the design spec (cross-reference against `supabase/migrations/*.sql` `create table` statements if you have any doubt about a name — do not guess). Confirm there are no trailing commas, no missing semicolons, and the statement order matches Parts 1→4 exactly as given above (nullify/delete config dependencies BEFORE the `auth.users` delete, not after).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260930000000_reset_all_accounts_and_participant_data.sql
git commit -m "feat: add production account and participant-data reset migration"
```

---

## Task 2: Live test proving the reset works correctly (scratch project only)

**Files:**
- Create: `tests/auth/accounts-reset-live.test.ts`

**Context:** This test applies Task 1's migration logic against a **disposable scratch Supabase project** — never production — seeded with representative rows across every truncated/nullified table, then asserts the end state is correct. This is the safety check that catches an FK-violation bug in Task 1's SQL *before* anyone runs it against real data. Follow the same scratch-project technique used in prior work on this repo (see `docs/superpowers/specs/2026-09-29-staff-role-consolidation-design.md`'s "Live RLS verification" precedent) — this test needs `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` env vars pointed at a scratch project, and will not run in a sandboxed environment without them (same limitation as every other `-live.test.ts` file in this repo).

- [ ] **Step 1: Write the test**

```typescript
// tests/auth/accounts-reset-live.test.ts
//
// Live verification that the reset migration
// (supabase/migrations/20260930000000_reset_all_accounts_and_participant_data.sql)
// correctly empties every table it targets and correctly PRESERVES every
// table it doesn't, without hitting a foreign-key violation. MUST be run
// against a disposable scratch Supabase project that has this migration
// already applied — never production. Requires NEXT_PUBLIC_SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY env vars pointed at that scratch project.
//
// This test does NOT apply the migration itself (that already happened
// when the scratch project was set up, via `supabase db push`) — it only
// verifies the END STATE: every truncated table is empty, the config
// tables kept their rows but lost their attribution columns, and the
// sequences restart from 1. This is intentionally read-only against
// whatever data was present when the migration ran, which the operator
// running this live suite is responsible for seeding first (create a few
// rows across a representative sample of tables, run `supabase db push`,
// then run this test) — that seed-then-verify workflow is manual and
// outside this test file's own scope, matching how every other
// -live.test.ts file in this repo assumes its fixture data already
// exists rather than creating an entire schema's worth of rows itself.
import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const TRUNCATED_TABLES = [
  'application_status_history', 'email_log', 'application_notes',
  'feature_extraction_runs', 'participant_feature_snapshots',
  'clustering_runs', 'clusters', 'cluster_memberships',
  'allocation_runs', 'allocation_assignments', 'allocation_alternatives',
  'allocation_issues', 'allocation_assignment_explanations',
  'schedule_publications', 'schedule_publication_items',
  'schedule_publication_drafts', 'schedule_publication_draft_items',
  'application_answers',
  'import_batches', 'import_column_mappings', 'import_rows', 'import_mapping_templates',
  'participant_invitations',
  'application_travel_info', 'application_health_info',
  'participant_account_provisioning',
  'attendance_records', 'scan_attempts',
  'qr_lifecycle_operations', 'qr_bulk_operation_batches', 'qr_credentials',
  'session_bookings', 'travel_legs',
  'emergency_contacts', 'application_accommodation',
  'applications', 'profiles',
  'scanner_assignments', 'staff_assignments',
] as const;

describe('reset migration: every targeted table is empty', () => {
  it.each(TRUNCATED_TABLES)('%s has zero rows', async (table) => {
    const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true });
    expect(error).toBeNull();
    expect(count).toBe(0);
  });

  it('auth.users has zero rows', async () => {
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
    expect(error).toBeNull();
    expect(data.users).toHaveLength(0);
  });
});

describe('reset migration: config tables are preserved, only attribution is cleared', () => {
  it('rooms, tracks, session_types, conference_days, tags, sessions, session_people, session_tags, people, audit_logs still have their rows (if any existed pre-reset), with updated_by/actor_id/linked_profile_id nulled', async () => {
    const configTables = [
      { table: 'rooms', col: 'updated_by' },
      { table: 'tracks', col: 'updated_by' },
      { table: 'session_types', col: 'updated_by' },
      { table: 'conference_days', col: 'updated_by' },
      { table: 'tags', col: 'updated_by' },
      { table: 'sessions', col: 'updated_by' },
      { table: 'session_people', col: 'updated_by' },
      { table: 'session_tags', col: 'updated_by' },
      { table: 'audit_logs', col: 'actor_id' },
    ] as const;

    for (const { table, col } of configTables) {
      const { count, error: countErr } = await admin.from(table).select('*', { count: 'exact', head: true }).not(col, 'is', null);
      expect(countErr).toBeNull();
      // Zero rows with a non-null attribution column — whatever rows
      // exist (this test doesn't assert row COUNT here, since that
      // depends on what the operator seeded before running the reset)
      // must have had their attribution cleared.
      expect(count).toBe(0);
    }

    const { count: peopleCount, error: peopleErr } = await admin
      .from('people')
      .select('*', { count: 'exact', head: true })
      .or('updated_by.not.is.null,linked_profile_id.not.is.null');
    expect(peopleErr).toBeNull();
    expect(peopleCount).toBe(0);
  });
});

describe('reset migration: attendee-code sequences restart from 1', () => {
  it('the next value drawn from each per-classification sequence is 1', async () => {
    // nextval() mutates the sequence, so this must be the FIRST read of
    // each sequence after the reset for this assertion to hold — running
    // this test twice against the same scratch project without reapplying
    // the reset migration in between will correctly fail the second time,
    // which is expected, not a flaky test.
    const sequences = ['attendee_code_seq_del', 'attendee_code_seq_vol', 'attendee_code_seq_kp', 'attendee_code_seq_yng', 'attendee_code_seq_spk'];
    for (const seq of sequences) {
      const { data, error } = await admin.rpc('nextval_test_only' as never, { sequence_name: seq } as never);
      // No existing RPC wraps nextval() for test inspection — if one
      // doesn't exist, this assertion needs a small test-only SQL helper
      // function added in a companion migration (nextval() itself cannot
      // be called via PostgREST without one). Flag this to the plan's
      // reviewer rather than fabricating an RPC name that may not exist.
      expect(error).toBeNull();
      expect(data).toBe(1);
    }
  });
});
```

- [ ] **Step 2: Flag the sequence-verification gap honestly**

The last `describe` block above depends on a test-only RPC (`nextval_test_only`) that likely doesn't exist yet in this codebase. Before finalizing this file, search for an existing pattern:

```bash
grep -rn "test_only_" supabase/migrations/*.sql | grep -i sequence
```

If nothing matches, either (a) add a small `create or replace function nextval_test_only(sequence_name text) returns bigint as $$ select nextval(sequence_name); $$ language sql security definer;` to a new tiny companion migration (grant execute to `service_role` only, following this repo's `test_only_*` RPC naming convention used elsewhere for exactly this kind of test-inspection helper), or (b) drop the sequence-restart assertions from this test file and verify that behavior manually via the SQL Editor instead, noting in a code comment why. Do not silently invent an RPC name and leave it broken — resolve this explicitly one way or the other before this task is done.

- [ ] **Step 3: Run the test against a scratch project**

This cannot run without live credentials. If you have a scratch project available (ask the user if unsure, per this repo's established pattern — do not assume one exists or is already seeded):

```bash
npx vitest run tests/auth/accounts-reset-live.test.ts
```

If no scratch project is available in your environment, report this clearly as a disclosed limitation (same pattern as every other live-test task in this repo's history) rather than skipping silently.

- [ ] **Step 4: Commit**

```bash
git add tests/auth/accounts-reset-live.test.ts
git commit -m "test: add live verification that the reset migration correctly empties/preserves the right tables"
```

---

## Task 3: Apply the reset migration to production, with explicit human confirmation

**Files:** none — this task is an operational/execution task, not a code change

**Context:** This is the actual destructive step. It must not be automated away or run without a human explicitly, freshly confirming the target project in the moment. This mirrors the "Execution-time safety gate" section of the design spec.

- [ ] **Step 1: Confirm the target project**

Before running anything, positively verify you are connected to the real production COY21 project, not a scratch/dev project:
- Check the Supabase dashboard project name/URL directly (not from memory).
- Run a read-only row count against a table you expect to have real data (e.g. `select count(*) from applications;`) and have the user confirm the number looks like genuine production volume, not suspiciously empty or unfamiliar.
- Do not proceed past this step without an explicit "yes, this is the right project" from the user in this exact session — a prior confirmation from earlier in the conversation does not carry forward to this specific, irreversible action.

- [ ] **Step 2: Apply the migration**

```bash
npx supabase db push --db-url "<production connection string>" --yes
```

(Use whichever connection method was already established and working in this session/project — see prior sessions' precedent for how the CLI was successfully linked to a real project via `--db-url` with the pooler connection string, not the direct-connection hostname which failed to resolve for this project.)

- [ ] **Step 3: Verify the reset**

Run the same verification queries as Task 2's live test, but against production now, via the SQL Editor (read-only, safe):

```sql
select
  (select count(*) from applications) as applications,
  (select count(*) from profiles) as profiles,
  (select count(*) from qr_credentials) as qr_credentials,
  (select count(*) from scanner_assignments) as scanner_assignments;
```

Expected: all zero. If any is non-zero, STOP — do not proceed to Task 4/5 until the discrepancy is understood; this likely means the migration didn't fully apply or a table was missed.

- [ ] **Step 4: No commit** — this task produces no file changes, only a verified production state change. Note the completion in the plan's tracking (e.g. TodoWrite) rather than a git commit.

---

## Task 4: Rewrite `staff-roles-live.test.ts` for the new 4-account structure

**Files:**
- Modify (full rewrite, not a patch): `tests/auth/staff-roles-live.test.ts`

**Context:** The existing file asserts a now-obsolete structure: two `staff` accounts (`albaraa@scaleagency.om`, `albaraa.scale.om@gmail.com`) with a fixed shared password `'password'`, and role assertions for `albaraak2002@gmail.com` (asserted `super_admin`) and `albaraaalbadwi@gmail.com` (asserted `participant`) that are the **exact opposite** of this plan's target roles for those two emails (`participant` and `staff` respectively). After Task 3's reset and Task 5's manual account creation, every one of these assertions will be wrong. This is a confirmed, deliberate full rewrite (user explicitly chose this over deferring to a later sub-project), not a bug to patch around.

Additionally: `albaraa.scale.om@gmail.com` — previously a `staff` test account in the old file — is being repurposed as the new `scanner_device` test account per this plan's target mapping. The rewritten file must reflect this account now being `scanner_device`, not assert anything about it being `staff`.

- [ ] **Step 1: Read the current file fully**

```bash
cat tests/auth/staff-roles-live.test.ts
```

(Already read in full during planning — reproduced context: it has 6 `describe` blocks: account-existence/role checks for the 2 old fixed staff emails, password-auth checks for those 2 emails, `provisionStaffAccount` idempotency checks for those 2 emails, unchanged-role checks for `albaraak2002@gmail.com`/`albaraaalbadwi@gmail.com`, a positive `isStaffRole` cross-domain-access proof using throwaway fixtures, a sensitive-data RLS proof using throwaway fixtures, and a no-plaintext-password proof. The throwaway-fixture-based blocks — cross-domain access, sensitive-data RLS, no-plaintext-password — do NOT depend on the 2 fixed emails and remain valid as-is; only the fixed-email-dependent blocks need rewriting.)

- [ ] **Step 2: Write the new file**

```typescript
// tests/auth/staff-roles-live.test.ts
//
// Live integration coverage for the 4 manually-provisioned production
// test accounts created after the 2026-09-30 full accounts reset (see
// docs/superpowers/specs/2026-09-30-accounts-reset-and-test-users-design.md).
// Unlike the pre-reset version of this file, none of these accounts has
// a fixed/known password — they were created by hand in the Supabase
// dashboard with passwords only the operator knows — so this file can
// only verify ACCOUNT STATE (existence, role, confirmation status), never
// sign in as them. Sign-in/auth-flow coverage lives in throwaway
// test-only fixtures created inline (see the cross-domain-access and
// sensitive-data-RLS blocks below), matching the pattern already
// established pre-reset.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { findExistingAuthUserByEmail } from '@/lib/auth/find-user-by-email';
import { isStaffRole } from '@/lib/auth/is-staff-role';
import { requireParticipantsCommunicationsStaffCaller } from '@/lib/participants-communications/server-helpers';
import { requireProgramAttendanceStaffCaller } from '@/lib/program-attendance/server-helpers';
import { requireAgendaStaffCaller } from '@/lib/agenda/server-helpers';
import { requireAdmissionStaffCaller } from '@/lib/admission/server-helpers';
import { requireImportStaffCaller } from '@/lib/import/server-helpers';

// See find-user-by-email.ts's own doc comment: a full pagination scan is
// used instead of a single-page listUsers() call. Post-reset, auth.users
// has only 4 rows, so this is fast — the 30s timeout from the pre-reset
// version (needed when the project had thousands of test-only accounts)
// is no longer necessary, but is kept as a safety margin rather than
// tuned down, since this file runs infrequently and cost of over-waiting
// is near zero.
vi.setConfig({ testTimeout: 30000 });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const PARTICIPANT_EMAIL = 'albaraak2002@gmail.com';
const SUPER_ADMIN_EMAIL = 'albaraa.coy21@gmail.com';
const STAFF_EMAIL = 'albaraaalbadwi@gmail.com';
const SCANNER_DEVICE_EMAIL = 'albaraa.scale.om@gmail.com';

const createdAuthUserIds: string[] = [];

afterAll(async () => {
  for (const id of createdAuthUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
}, 60000);

describe('the 4 manually-provisioned test accounts exist with the correct role', () => {
  it(`${PARTICIPANT_EMAIL} exists and is role participant`, async () => {
    const user = await findExistingAuthUserByEmail(admin, PARTICIPANT_EMAIL);
    expect(user).toBeTruthy();
    expect(user?.email_confirmed_at).toBeTruthy();
    const { data: profile } = await admin.from('profiles').select('role').eq('id', user!.id).single();
    expect(profile?.role).toBe('participant');
  });

  it(`${SUPER_ADMIN_EMAIL} exists and is role super_admin`, async () => {
    const user = await findExistingAuthUserByEmail(admin, SUPER_ADMIN_EMAIL);
    expect(user).toBeTruthy();
    expect(user?.email_confirmed_at).toBeTruthy();
    const { data: profile } = await admin.from('profiles').select('role').eq('id', user!.id).single();
    expect(profile?.role).toBe('super_admin');
  });

  it(`${STAFF_EMAIL} exists and is role staff`, async () => {
    const user = await findExistingAuthUserByEmail(admin, STAFF_EMAIL);
    expect(user).toBeTruthy();
    expect(user?.email_confirmed_at).toBeTruthy();
    const { data: profile } = await admin.from('profiles').select('role').eq('id', user!.id).single();
    expect(profile?.role).toBe('staff');
  });

  it(`${SCANNER_DEVICE_EMAIL} exists and is role scanner_device`, async () => {
    const user = await findExistingAuthUserByEmail(admin, SCANNER_DEVICE_EMAIL);
    expect(user).toBeTruthy();
    expect(user?.email_confirmed_at).toBeTruthy();
    const { data: profile } = await admin.from('profiles').select('role').eq('id', user!.id).single();
    expect(profile?.role).toBe('scanner_device');
  });

  it('exactly 4 accounts exist in total (the reset left nothing else behind)', async () => {
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    expect(error).toBeNull();
    expect(data.users).toHaveLength(4);
  });
});

describe('a single staff-role profile satisfies every domain\'s authorization check (live, using a throwaway fixture user)', () => {
  // Unchanged from the pre-reset version of this file: uses a disposable
  // fixture, not the real STAFF_EMAIL account, since these tests create
  // and tear down freely and shouldn't touch the one real production
  // staff account. Every requireXStaffCaller helper below delegates its
  // entire authorization logic to the single shared isStaffRole(role)
  // check (see each helper's src/lib/*/server-helpers.ts) — none can be
  // invoked directly in a live test, since each is a 'use server'
  // function resolving the CALLING request's own session via
  // createClient() -> auth.getUser() (next/headers's cookies()), which
  // cannot be forged outside a real Next.js request context. Asserting
  // isStaffRole directly against a real fixture's persisted role is
  // therefore the exact same check every one of these guards performs
  // internally.
  let staffFixtureId: string;

  it('a staff account satisfies isStaffRole — the exact check every requireXStaffCaller guard performs internally', async () => {
    const { data: staff, error: staffErr } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-staff-fixture@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (staffErr || !staff.user) throw new Error(`Failed to create staff fixture: ${staffErr?.message}`);
    staffFixtureId = staff.user.id;
    createdAuthUserIds.push(staffFixtureId);
    await admin.from('profiles').update({ role: 'staff' }).eq('id', staffFixtureId);

    const { data: profile } = await admin.from('profiles').select('role').eq('id', staffFixtureId).single();
    expect(profile?.role).toBe('staff');
    expect(isStaffRole(profile?.role)).toBe(true);
  });

  it('a plain participant does NOT satisfy isStaffRole', async () => {
    const { data: participant, error } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-participant-fixture@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (error || !participant.user) throw new Error(`Failed to create participant fixture: ${error?.message}`);
    createdAuthUserIds.push(participant.user.id);
    const { data: profile } = await admin.from('profiles').select('role').eq('id', participant.user.id).single();
    expect(isStaffRole(profile?.role)).toBe(false);
  });

  it('the requireXStaffCaller helper modules exist and are the real exported functions this file documents as un-forgeable', () => {
    expect(typeof requireImportStaffCaller).toBe('function');
    expect(typeof requireParticipantsCommunicationsStaffCaller).toBe('function');
    expect(typeof requireProgramAttendanceStaffCaller).toBe('function');
    expect(typeof requireAgendaStaffCaller).toBe('function');
    expect(typeof requireAdmissionStaffCaller).toBe('function');
  });
});

describe('sensitive travel and health data: a staff account can read it (consolidated tradeoff); a participant still cannot', () => {
  // Unchanged in substance from the pre-reset version — this proves the
  // staff-role-consolidation's RLS tradeoff (docs/superpowers/specs/
  // 2026-09-29-staff-role-consolidation-design.md), which is orthogonal
  // to this accounts-reset work and remains true regardless of which
  // specific accounts exist. Uses throwaway fixtures, not the real
  // STAFF_EMAIL/PARTICIPANT_EMAIL accounts.
  let staffFixtureId: string;
  let participantFixtureId: string;
  let sensitiveApplicationId: string;

  it('setup: create fixtures and seed a sensitive application', async () => {
    const { data: staff, error: staffErr } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-sensitive-staff@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (staffErr || !staff.user) throw new Error(`Failed: ${staffErr?.message}`);
    staffFixtureId = staff.user.id;
    createdAuthUserIds.push(staffFixtureId);
    await admin.from('profiles').update({ role: 'staff' }).eq('id', staffFixtureId);

    const { data: participant, error: participantErr } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-sensitive-participant-caller@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (participantErr || !participant.user) throw new Error(`Failed: ${participantErr?.message}`);
    participantFixtureId = participant.user.id;
    createdAuthUserIds.push(participantFixtureId);

    const SENSITIVE_EMAIL = 'staff-roles-live-sensitive-participant@example.com';
    const { data: app, error: appErr } = await admin
      .from('applications')
      .insert({ applicant_id: null, imported_email: SENSITIVE_EMAIL, status: 'accepted', full_name: 'Sensitive Data Test Person' })
      .select('id')
      .single();
    if (appErr || !app) throw new Error(`Failed to seed application: ${appErr?.message}`);
    sensitiveApplicationId = app.id;

    await admin.from('application_travel_info').insert({ application_id: sensitiveApplicationId, passport_full_name: 'Test Person' });
    await admin.from('application_health_info').insert({ application_id: sensitiveApplicationId, medical_conditions: 'test condition' });
  }, 30000);

  it('a staff-scoped client CAN read application_travel_info via RLS', async () => {
    const anonClient = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const { error: signInErr } = await anonClient.auth.signInWithPassword({ email: 'staff-roles-live-sensitive-staff@test.local', password: 'password123' });
    expect(signInErr).toBeNull();

    const { data, error } = await anonClient.from('application_travel_info').select('*').eq('application_id', sensitiveApplicationId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
    await anonClient.auth.signOut();
  });

  it('a staff-scoped client CAN read application_health_info via RLS', async () => {
    const anonClient = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    await anonClient.auth.signInWithPassword({ email: 'staff-roles-live-sensitive-staff@test.local', password: 'password123' });

    const { data, error } = await anonClient.from('application_health_info').select('*').eq('application_id', sensitiveApplicationId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
    await anonClient.auth.signOut();
  });

  it('a participant-scoped client still cannot read application_travel_info via RLS', async () => {
    const anonClient = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    await anonClient.auth.signInWithPassword({ email: 'staff-roles-live-sensitive-participant-caller@test.local', password: 'password123' });

    const { data, error } = await anonClient.from('application_travel_info').select('*').eq('application_id', sensitiveApplicationId);
    expect(error || (data ?? []).length === 0).toBeTruthy();
    await anonClient.auth.signOut();
  });

  it('a participant-scoped client still cannot read application_health_info via RLS', async () => {
    const anonClient = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    await anonClient.auth.signInWithPassword({ email: 'staff-roles-live-sensitive-participant-caller@test.local', password: 'password123' });

    const { data, error } = await anonClient.from('application_health_info').select('*').eq('application_id', sensitiveApplicationId);
    expect(error || (data ?? []).length === 0).toBeTruthy();
    await anonClient.auth.signOut();
  });

  afterAll(async () => {
    if (sensitiveApplicationId) await admin.from('applications').delete().eq('id', sensitiveApplicationId);
  });
});

describe('the staff role cannot change any account\'s role or delete any account (the requested permission boundary)', () => {
  // NEW block, per the design spec's §3 ("Verifying the staff permission
  // boundary") — this is the part of this plan's scope that confirms an
  // ALREADY-EXISTING protection, not something newly built. Documents the
  // boundary explicitly in the test suite rather than leaving it implicit,
  // matching this repo's established practice (see the equivalent
  // "single staff account satisfies every domain" test that documents the
  // consolidation's tradeoff above).
  it('a staff-scoped client cannot update another profile\'s role via RLS', async () => {
    const { data: staffFx, error: staffErr } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-boundary-staff@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (staffErr || !staffFx.user) throw new Error(`Failed: ${staffErr?.message}`);
    createdAuthUserIds.push(staffFx.user.id);
    await admin.from('profiles').update({ role: 'staff' }).eq('id', staffFx.user.id);

    const { data: targetFx, error: targetErr } = await admin.auth.admin.createUser({
      email: 'staff-roles-live-boundary-target@test.local',
      password: 'password123',
      email_confirm: true,
    });
    if (targetErr || !targetFx.user) throw new Error(`Failed: ${targetErr?.message}`);
    createdAuthUserIds.push(targetFx.user.id);

    const anonClient = createClient<Database>(URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    await anonClient.auth.signInWithPassword({ email: 'staff-roles-live-boundary-staff@test.local', password: 'password123' });

    const { error } = await anonClient.from('profiles').update({ role: 'super_admin' }).eq('id', targetFx.user.id);
    // RLS denies this write — either an explicit error, or a silent
    // no-op (0 rows affected under default-deny RLS UPDATE semantics).
    // Confirm via the service-role client that the role genuinely never
    // changed, regardless of which shape the denial took.
    const { data: afterProfile } = await admin.from('profiles').select('role').eq('id', targetFx.user.id).single();
    expect(afterProfile?.role).not.toBe('super_admin');
    await anonClient.auth.signOut();
  });
});

describe('no plaintext password is stored or logged anywhere', () => {
  it('the profiles table has no password column at all', async () => {
    const { data } = await admin.from('profiles').select('*').limit(1).single();
    expect(data).not.toHaveProperty('password');
    expect(data).not.toHaveProperty('plaintext_password');
  });

  it('audit_logs never contains any test fixture password string in metadata', async () => {
    const { data: logs } = await admin.from('audit_logs').select('metadata').in('actor_id', createdAuthUserIds);
    for (const row of logs ?? []) {
      expect(JSON.stringify(row.metadata ?? '')).not.toContain('password123');
    }
  });
});
```

- [ ] **Step 3: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: no new errors referencing this file (this repo has a known ~394-error baseline from unrelated stale generated types — don't chase those).

- [ ] **Step 4: Run the test** (requires live credentials pointed at the now-reset production project, or a scratch project seeded with the 4 accounts at matching emails/roles for a dry run first — see Task 3's completion before this can meaningfully pass against production)

```bash
npx vitest run tests/auth/staff-roles-live.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add tests/auth/staff-roles-live.test.ts
git commit -m "test: rewrite staff-roles-live.test.ts for the post-reset 4-account structure"
```

---

## Task 5: Manual account provisioning (human step, documented here for tracking)

**Files:** none

**Context:** Per your explicit instruction, no password is ever written in code. This task is a checklist for you to execute directly in the Supabase dashboard, with me available to run the SQL role-assignment step via the SQL Editor once you confirm the accounts exist.

- [ ] **Step 1: Create 4 Auth users** (Supabase dashboard → Authentication → Add user), choosing your own password for each:
  - `albaraak2002@gmail.com`
  - `albaraa.coy21@gmail.com`
  - `albaraaalbadwi@gmail.com`
  - `albaraa.scale.om@gmail.com`

- [ ] **Step 2: Confirm creation, then run the role-assignment SQL** (via SQL Editor, after Step 1 is done for all 4 — the `handle_new_user()` trigger has already given each a `participant` default row by this point):

```sql
update profiles set role = 'super_admin'    where email = 'albaraa.coy21@gmail.com';
update profiles set role = 'staff'          where email = 'albaraaalbadwi@gmail.com';
update profiles set role = 'scanner_device' where email = 'albaraa.scale.om@gmail.com';
-- albaraak2002@gmail.com needs no update — 'participant' is already the trigger default.
```

- [ ] **Step 3: Verify** — run:

```sql
select email, role from profiles order by email;
```

Expected: exactly 4 rows, matching the mapping above.

- [ ] **Step 4: No commit** — this task is operational, not a code change.

---

## Task 6: Final verification sweep

**Files:** none

- [ ] **Step 1:** Run Task 4's rewritten `staff-roles-live.test.ts` against the now-live production project (with real credentials in env vars) and confirm all tests pass.
- [ ] **Step 2:** Run `npx tsc --noEmit` and confirm no new errors beyond the known baseline.
- [ ] **Step 3:** Manually sign in to the app as each of the 4 new accounts (real browser, real login) and confirm each lands on the expected post-login destination (`participant` → `/my-dashboard`, `super_admin`/`staff` → `/dashboard`, `scanner_device` → `/scanner`, per `resolvePostLoginDestination`'s existing, unmodified behavior).
- [ ] **Step 4:** Report completion — summarize what was reset, what accounts now exist, and explicitly confirm to the user that sub-project 1 of 6 is done and sub-project 2 (sandbox mode for email) or sub-project 3 (import/classification) is ready to start whenever they choose.
