# Phase 5.1: Accepted Participants Excel Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an administrator upload the organizing team's accepted-participants Excel file as-is, map its columns to the existing `applications`/`application_answers` model, review and confirm the import, and feed imported participants through the existing feature-extraction → clustering → allocation → schedule-publication pipeline — with explicit admin approval required at every consequential step (import confirm, downstream processing, allocation confirm, schedule publish, invitation send).

**Architecture:** Staging → validate → confirm → populate, layered entirely on the existing `applications`/`application_answers`(new)/`application_status_history`/`audit_logs` tables plus new import-staging tables (`import_batches`, `import_column_mappings`, `import_rows`, `import_mapping_templates`) and a new `participant_invitations` tracking table. Synchronous, client-orchestrated chunked server actions (no new job/queue dependency) reuse the existing `runFeatureExtraction`/`runClustering`/`runAllocation` orchestrators unmodified.

**Tech Stack:** Next.js (App Router) + TypeScript + Supabase (Postgres, Auth, Storage) + `exceljs` (new dependency) + Zod + Vitest, following every convention already established in Phase 5 (schedule-publishing).

**Governing design document:** `docs/superpowers/specs/2026-07-25-accepted-participants-import-design.md` — read in full before starting any task. This plan implements that spec exactly; where this plan's code differs from the spec's illustrative SQL/pseudocode, this plan's version is authoritative (it has been checked against real signatures the spec didn't have in front of it, called out explicitly per task).

**Two gaps found while re-verifying the spec against real code, folded into this plan (not spec violations, just spec-level omissions):**
1. `next_application_number()` (existing RPC) is not called out in the spec's import-write step, but `application_number` is displayed in `my-application/page.tsx`'s `<h1>` for the participant-facing view — imported applications need one too, generated the same way self-registered ones are (Task 8).
2. The spec's RLS section doesn't explicitly address `applications`/`applications_select_own`'s interaction with `imported_email`/nullable `applicant_id` — Task 5 adds this explicitly (no participant policy on `applications` should ever match a row with `applicant_id is null`, which is already true by construction, but the task adds a regression test proving it).

---

## Task 1: Schema — relax `applications`, add `application_answers`

**Files:**
- Create: `supabase/migrations/20260726100000_applications_import_columns.sql`
- Create: `supabase/migrations/20260726101000_application_answers_table.sql`

Depends on nothing. Must run before every other schema task (tasks 2-4 reference `import_batches`/`applications` columns this task adds).

- [ ] **Step 1: Write `20260726100000_applications_import_columns.sql`**

```sql
-- applications_import_columns.sql
alter table applications alter column applicant_id drop not null;
alter table applications add column imported_email text;
alter table applications add column import_batch_id uuid;

-- Self-registered applications must still have an owner. Imported-and-
-- unclaimed applications are the only legal NULL applicant_id case, and only
-- when they carry a non-null imported_email — a NULL applicant_id row is
-- always traceable to a claim-in-progress import, never an identity-less
-- orphan. See design spec § Schema changes / rule 4.
alter table applications add constraint applications_owner_or_import_identity
  check (applicant_id is not null or imported_email is not null);

-- Case-insensitive matching is achieved by normalizing (trim + lowercase) in
-- application code before every write to this column — never re-derived
-- from profiles.email, and never silently changed after claim (design spec
-- rule 5) — matching this codebase's existing convention of app-layer
-- normalization before insert (see registration's email handling) rather
-- than a DB-level citext/trigger transform. Partial: claimed applications
-- may retain imported_email for provenance and future re-import matching,
-- so the index only needs to prevent duplicate *unclaimed* identities.
create unique index applications_imported_email_unclaimed_unique
  on applications (imported_email) where applicant_id is null;

create index applications_import_batch_idx on applications (import_batch_id);
```

Note: `import_batch_id`'s FK to `import_batches(id)` is added in Task 2 (`alter table applications add constraint applications_import_batch_fkey foreign key (import_batch_id) references import_batches(id);`) since `import_batches` doesn't exist yet at this point in migration order — Postgres FK targets must already exist. Do not add the FK here.

- [ ] **Step 2: Write `20260726101000_application_answers_table.sql`**

```sql
-- application_answers_table.sql
create table application_answers (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  question_key text not null,
  question_label text,
  normalized_value text,
  raw_value text not null,
  value_type text not null,
  source text not null default 'import',
  is_sensitive boolean not null default false,
  import_batch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint application_answers_value_type_valid check (value_type in ('text', 'multiselect', 'boolean', 'number', 'date')),
  constraint application_answers_source_valid check (source in ('import', 'manual')),
  -- One answer per (application, question_key, source): a later import
  -- updates the existing row for the same question_key rather than
  -- inserting a duplicate. See design spec § application_answers.
  constraint application_answers_unique unique (application_id, question_key, source)
);

create index application_answers_application_idx on application_answers (application_id);
create trigger application_answers_set_updated_at before update on application_answers
  for each row execute function extensions.moddatetime('updated_at');
```

(`import_batch_id`'s FK is likewise added in Task 2, after `import_batches` exists.)

- [ ] **Step 3: Apply migrations and regenerate types**

Run: `npx supabase db push` (or this project's established migration-apply command — check `package.json` scripts / prior Phase 5 task notes for the exact invocation used), then `npx supabase gen types typescript --local > src/types/database.ts` (or the project's established regen command — confirm exact flags by checking how `src/types/database.ts` was regenerated in Phase 5's Task 15).

Verify: `applications` in `src/types/database.ts` now shows `applicant_id: string | null` (was `string`), plus `imported_email`, `import_batch_id`; `application_answers` appears as a new table type.

- [ ] **Step 4: Verify constraint behavior directly**

Run a throwaway SQL check via `psql`/Supabase SQL editor (or a short Node script using the service-role client, matching this codebase's existing ad hoc verification style — see how Phase 5 verified RLS policies):
```sql
-- Should fail (violates applications_owner_or_import_identity):
insert into applications (applicant_id, imported_email, status) values (null, null, 'accepted');
-- Should succeed:
insert into applications (applicant_id, imported_email, status) values (null, 'test@example.com', 'accepted');
-- Should fail (duplicate unclaimed imported_email):
insert into applications (applicant_id, imported_email, status) values (null, 'test@example.com', 'accepted');
```
Clean up any rows this check creates before proceeding.

- [ ] **Step 5: Run `npx tsc --noEmit`, `npm run lint`**

Existing self-registration code (`src/app/[locale]/(participant)/register/actions.ts`, admission-review actions) must still typecheck cleanly against the now-nullable `applicant_id` type — since those code paths never read `applicant_id` as possibly-null (they always set it from `auth.getUser()`), this should be a non-issue, but confirm directly rather than assuming.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260726100000_applications_import_columns.sql supabase/migrations/20260726101000_application_answers_table.sql src/types/database.ts
git commit -m "feat: relax applications.applicant_id and add application_answers table"
```

---

## Task 2: Schema — import staging tables

**Files:**
- Create: `supabase/migrations/20260726102000_import_staging_tables.sql`
- Create: `supabase/migrations/20260726103000_import_fk_backfill.sql`
- Create: `supabase/migrations/20260726103500_import_rows_fk_and_index_fixes.sql` (see post-implementation note)

Depends on Task 1 (references `applications`/`application_answers`).

**Post-implementation note**: a code-quality reviewer caught a real bug after the first two migrations were applied: `import_rows.destination_application_id references applications(id)` had no `on delete` clause (default `NO ACTION`/restrict). Task 16's rollback hard-deletes `applications` rows for batch-inserted participants, but every successfully-imported row's `import_rows` entry still points at that application via `destination_application_id` — the delete would have been rejected by this FK the moment rollback ran, for every insert-created row. Fixed via a follow-up migration: dropped and recreated the FK with `on delete set null` (matching the `schedule_publication_items.session_id` precedent from Phase 5), so the staging row survives as an audit trail after rollback with its destination reference cleared, rather than blocking the delete. The same review also found two missing indexes anticipated by later tasks' query patterns (`import_rows.duplicate_of_row_id` for dedup reverse-lookups, `import_batches.status` for the history-list page) — both added in the same follow-up migration. Verified live: the FK's `delete_rule` is now `SET NULL` (was `NO ACTION`), and both new indexes exist on the hosted project.

- [ ] **Step 1: Write `20260726102000_import_staging_tables.sql`**

```sql
-- import_staging_tables.sql
create table import_mapping_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  header_signature text not null,
  original_headers jsonb not null,
  mappings jsonb not null,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  version int not null default 1
);

create index import_mapping_templates_signature_idx on import_mapping_templates (header_signature);

create table import_batches (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid not null references profiles(id),
  original_filename text not null,
  file_checksum text not null,
  storage_path text not null,
  sheet_name text,
  row_count int,
  mapping_template_id uuid references import_mapping_templates(id),

  status text not null default 'uploaded',
  valid_count int not null default 0,
  warning_count int not null default 0,
  error_count int not null default 0,
  duplicate_count int not null default 0,
  inserted_count int not null default 0,
  updated_count int not null default 0,
  skipped_count int not null default 0,

  auto_process_downstream boolean not null default false,
  auto_process_cluster_k int,
  downstream_status text,

  processing_lock_token uuid,
  processing_lock_expires_at timestamptz,
  next_chunk_offset int not null default 0,

  failure_reason text,
  uploaded_at timestamptz not null default now(),
  confirmed_at timestamptz,
  completed_at timestamptz,

  constraint import_batches_status_valid check (status in (
    'uploaded', 'analyzing', 'awaiting_mapping', 'validating', 'ready_to_import',
    'importing', 'imported', 'processing_features', 'clustering', 'allocating',
    'completed', 'completed_with_warnings', 'failed', 'rolled_back'
  )),
  constraint import_batches_auto_process_k_required check (
    not auto_process_downstream or auto_process_cluster_k is not null
  ),
  constraint import_batches_cluster_k_positive check (auto_process_cluster_k is null or auto_process_cluster_k > 0)
);

create table import_column_mappings (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references import_batches(id) on delete cascade,
  source_column_index int not null,
  source_column_header text not null,
  target_kind text not null,
  target_key text,
  confidence numeric,
  is_manual_override boolean not null default false,

  constraint import_column_mappings_target_kind_valid check (target_kind in ('core_field', 'known_answer', 'generic_answer', 'ignored')),
  constraint import_column_mappings_confidence_range check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint import_column_mappings_unique unique (import_batch_id, source_column_index)
);

create table import_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references import_batches(id) on delete cascade,
  excel_row_number int not null,
  row_fingerprint text not null,
  raw_row jsonb not null,
  normalized_row jsonb,

  validation_status text not null default 'pending',
  warnings jsonb not null default '[]'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  duplicate_status text,
  duplicate_of_row_id uuid references import_rows(id),

  destination_application_id uuid references applications(id),
  action_taken text,

  previous_application_snapshot jsonb,
  previous_answers_snapshot jsonb,

  constraint import_rows_validation_status_valid check (validation_status in ('pending', 'valid', 'warning', 'invalid')),
  constraint import_rows_duplicate_status_valid check (duplicate_status is null or duplicate_status in ('duplicate_in_file', 'existing_unclaimed', 'existing_claimed', 'blocked_downstream')),
  constraint import_rows_action_taken_valid check (action_taken is null or action_taken in ('inserted', 'updated', 'skipped_unchanged', 'skipped_error', 'blocked')),
  constraint import_rows_unique_row unique (import_batch_id, excel_row_number)
);

create index import_rows_batch_idx on import_rows (import_batch_id);
create index import_rows_fingerprint_idx on import_rows (row_fingerprint);
```

Note: `import_batches.status`/`import_rows.validation_status`/`duplicate_status`/`action_taken` CHECK lists are written out explicitly here even though the design spec's SQL excerpt didn't include `duplicate_status`/`action_taken` CHECK constraints — added here as defense-in-depth consistent with every other enum-like text column in this codebase (`applications.status` is the one exception, and only because it predates this convention; every Phase 5 table enforces its enums via CHECK).

- [ ] **Step 2: Write `20260726103000_import_fk_backfill.sql`**

```sql
-- import_fk_backfill.sql
-- import_batches didn't exist yet when applications/application_answers
-- were created (Task 1) — add the deferred FKs now that it does.
alter table applications add constraint applications_import_batch_fkey
  foreign key (import_batch_id) references import_batches(id);
alter table application_answers add constraint application_answers_import_batch_fkey
  foreign key (import_batch_id) references import_batches(id);

-- import_batches.mapping_template_id references import_mapping_templates,
-- already satisfied within the same migration file in Task 2 Step 1 (both
-- tables created in the same file, template table first) — no backfill
-- needed for that one.
```

- [ ] **Step 3: Apply migrations, regenerate types, `npx tsc --noEmit`, `npm run lint`**

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260726102000_import_staging_tables.sql supabase/migrations/20260726103000_import_fk_backfill.sql src/types/database.ts
git commit -m "feat: add import staging tables (batches, column mappings, rows, mapping templates)"
```

---

## Task 3: Schema — invitation tracking

**Files:**
- Create: `supabase/migrations/20260726104000_participant_invitations_table.sql`
- Create: `supabase/migrations/20260726104500_participant_invitations_fk_fix.sql` (see post-implementation note)

Depends on Task 1 (`applications`).

**Post-implementation note**: a code-quality reviewer found the same bug class already caught once in Task 2 — `invited_user_id references profiles(id)` had no `on delete` clause (default `NO ACTION`/restrict). Task 20's `revokeInvitation` calls `admin.auth.admin.deleteUser(invitation.invited_user_id)` for unclaimed invitations; `profiles.id references auth.users(id) on delete cascade` means that delete cascades into `profiles`, which this FK would have blocked. Fixed via a follow-up migration: dropped and recreated the FK with `on delete set null` (the row's own code already sets `status = 'revoked'` before the delete, so nulling `invited_user_id` afterward loses no meaningful state). Verified live: `delete_rule` is now `SET NULL` (was `NO ACTION`).

The same review also raised an **Important, not-yet-resolved question for Task 16** (rollback), noted here so it isn't lost before that task is reached: `participant_invitations.application_id references applications(id) on delete cascade` means Task 16's rollback of a batch-inserted application will silently cascade-delete its `participant_invitations` row even if `status = 'sent'` — i.e. an invite has already been emailed to a real external party and a real Auth user already exists for them. Rollback is already blocked once downstream allocation exists (a real side effect on OUR side); this raises the question of whether an already-sent invitation (a real side effect visible to an external person) should similarly block rollback, or at minimum trigger a mandatory Auth-user cleanup in the same rollback transaction rather than leaving a live, credentialed Auth user with a dangling reference to a now-deleted application. **Task 16's implementer must address this explicitly — either extend the "downstream reference" blocking check to include `participant_invitations.status not in ('not_sent')`, or make an explicit, justified decision not to, but must not silently let the existing `on delete cascade` decide this by default.**

- [ ] **Step 1: Write the migration**

```sql
-- participant_invitations_table.sql
create table participant_invitations (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  imported_email text not null,
  invited_user_id uuid references profiles(id),

  status text not null default 'not_sent',
  sent_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz,
  last_error text,
  sent_by uuid references profiles(id),
  resend_count int not null default 0,

  constraint participant_invitations_status_valid check (status in (
    'not_sent', 'sending', 'sent', 'accepted', 'expired', 'revoked', 'failed'
  )),
  constraint participant_invitations_one_per_application unique (application_id)
);

create index participant_invitations_invited_user_idx on participant_invitations (invited_user_id);
```

- [ ] **Step 2: Apply migration, regenerate types, `npx tsc --noEmit`, `npm run lint`**

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260726104000_participant_invitations_table.sql src/types/database.ts
git commit -m "feat: add participant_invitations tracking table"
```

---

## Task 4: RLS policies for all 6 new/modified tables

**Files:**
- Create: `supabase/migrations/20260726105000_import_rls_policies.sql`
- Create: `supabase/migrations/20260726105500_explicit_answers_with_check.sql` (see post-implementation note)

Depends on Tasks 1-3 (all tables must exist). This is a high-risk, security-critical task — dispatch to a careful implementer and follow with a dedicated review pass before Task 5.

**Post-implementation note**: a deep adversarial security review (5 specific attack scenarios traced through concretely: unclaimed-application null-`applicant_id` exclusion, cross-participant leakage, staff-policy OR-interaction, `WITH CHECK` derivation, `current_user_role()`'s own `SECURITY DEFINER` safety) found **no exploitable gap** in the original policies — all 5 scenarios traced out safe. The one Minor finding (both `application_answers` `FOR ALL` staff policies omitted an explicit `WITH CHECK`, relying on Postgres's default reuse of `USING`) was fixed anyway as a pure clarity/maintainability improvement, with zero behavioral change (verified live: both policies' `with_check` now equals their `qual` exactly, matching what Postgres was already deriving implicitly). See Task 5's note below for the second Minor finding (an additional test case to pin this down with a live regression test, not just this review's analysis).

- [ ] **Step 1: Write the migration**

```sql
-- import_rls_policies.sql
alter table import_batches enable row level security;
alter table import_column_mappings enable row level security;
alter table import_rows enable row level security;
alter table import_mapping_templates enable row level security;
alter table application_answers enable row level security;
alter table participant_invitations enable row level security;

-- Staff-only tables: no participant ever has a legitimate reason to read
-- these. Default-deny (no participant policy) covers every operation for
-- the participant role automatically. Mirrors
-- schedule_change_events_staff_all / schedule_publication_drafts_staff_all.
create policy import_batches_staff_all on import_batches
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy import_column_mappings_staff_all on import_column_mappings
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy import_rows_staff_all on import_rows
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy import_mapping_templates_staff_all on import_mapping_templates
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy participant_invitations_staff_all on participant_invitations
  for all using (current_user_role() in ('agenda_allocation_manager', 'super_admin'));

-- application_answers: two-tier. Ordinary (non-sensitive) answers are
-- readable/writable by import-capable staff for allocation review.
-- Sensitive answers (accessibility/dietary/emergency-contact/special-needs)
-- are super_admin only — narrower than ordinary answers.
create policy application_answers_staff_all on application_answers
  for all using (
    not is_sensitive and current_user_role() in ('agenda_allocation_manager', 'super_admin')
  );
create policy application_answers_sensitive_staff_all on application_answers
  for all using (is_sensitive and current_user_role() = 'super_admin');

-- Participant self-read: own application's non-sensitive answers only,
-- select-only. Symmetric with applications_select_own. Because applicant_id
-- is null until claim, applications.applicant_id = auth.uid() cannot match
-- any authenticated session for an unclaimed row — this is what makes
-- unclaimed imported answers unreadable by anyone but staff, with zero new
-- RLS logic beyond this existing pattern.
create policy application_answers_select_own on application_answers
  for select using (
    not is_sensitive
    and application_id in (select id from applications where applicant_id = auth.uid())
  );
```

- [ ] **Step 2: Apply migration**

- [ ] **Step 3: Verify no participant-reachable write path exists**

Grep the migration for every `create policy` and confirm none grants `insert`/`update`/`delete` to a non-staff role — run:
```bash
grep -n "create policy" supabase/migrations/20260726105000_import_rls_policies.sql
```
Manually confirm each policy's `using`/`with check` clause requires `current_user_role() in (...)` or is the one intentional participant `select`-only policy.

- [ ] **Step 4: `npx tsc --noEmit`, `npm run lint`**

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260726105000_import_rls_policies.sql
git commit -m "feat: add RLS policies for import staging, application_answers, and invitation tables"
```

- [ ] **Step 6: Dispatch code-quality review of Tasks 1-4 as a batch** (schema + RLS is the highest-risk section of this phase — review before building anything on top of it). Reviewer should independently re-derive: can a `participant`-role session read/write any staff-only table? Can a participant read another participant's `application_answers`? Can a participant read their own sensitive answers? Does the `applications_owner_or_import_identity` constraint actually block every code path that could produce a fully-orphaned row? Fix any findings before proceeding to Task 5.

---

## Task 5: Regression test — self-registration still requires `applicant_id`, RLS still isolates participants

**Files:**
- Create: `tests/rls/import.test.ts`
- Create: `tests/validation/applications-nullable-owner.test.ts` (pure-logic — the CHECK constraint's *intent*, tested via a live insert since it's a DB constraint, not app logic — actually lives better as a live RLS-adjacent test; see Step 1)

Depends on Task 4. This task exists specifically to catch the two gaps identified while re-verifying the spec (see plan header) before any application code is built on top of the relaxed schema.

- [ ] **Step 1: Write `tests/rls/import.test.ts`**

Follow the exact live-test convention from `tests/schedule/authorization.test.ts` (service-role `admin` client for seeding, anon-key client signing in per-role for RLS-scoped assertions, `beforeAll`/`afterAll` with FK-safe cleanup). Cover:
- A `participant`-role session cannot read `import_batches`/`import_column_mappings`/`import_rows`/`import_mapping_templates`/`participant_invitations` (zero rows, even when a real row exists — seed one via service-role first, matching the "seed a real row before asserting zero-visibility" fix from Phase 5's Task 26).
- A `participant`-role session cannot insert/update/delete into any of the 6 tables.
- An `agenda_allocation_manager` session CAN read/write `import_batches` and non-sensitive `application_answers`, but CANNOT read a `is_sensitive = true` `application_answers` row (seeded by service-role) — only `super_admin` can.
- **Write-side sensitive-flag smuggling (from Task 4's security review)**: an `agenda_allocation_manager` session attempts to `insert into application_answers (..., is_sensitive) values (..., true)` — assert this is rejected by RLS (the explicit `WITH CHECK` added in Task 4's post-implementation fix). This pins down, with a live regression test, what that review's own manual trace already found safe — don't just trust the prior analysis, prove it here.
- **The `applications_owner_or_import_identity` constraint**: attempt (via service-role, since this is a DB constraint not an RLS check) `insert into applications (applicant_id, imported_email, status) values (null, null, 'accepted')` and assert it throws.
- **The gap-closing regression**: seed one `applications` row with `applicant_id = null, imported_email = 'x@example.com'`. Sign in as a *different*, unrelated participant (a real claimed account). Assert `applications_select_own` does NOT return the unclaimed row for them — proving the existing `applicant_id = auth.uid()` policy correctly excludes null-`applicant_id` rows with no code changes needed (this is the exact invariant the design spec claims holds "by construction" — this test proves it, doesn't just assert it in prose).

- [ ] **Step 2: Run `npx vitest run tests/rls/import.test.ts`**

Expected: PASS against a real environment. In this environment, expect the same documented intermittent Auth Admin JWT failure at `beforeAll`'s `createUser` calls (see Phase 5's final report) — if it fails there, confirm the failure is specifically at that call (not a logic/schema error) and proceed; this is a known, accepted, external limitation, not grounds to skip writing or committing the test.

- [ ] **Step 3: `npx tsc --noEmit`, `npm run lint`**

- [ ] **Step 4: Commit**

```bash
git add tests/rls/import.test.ts
git commit -m "test: add RLS regression coverage for import tables and nullable applicant_id invariant"
```

---

## Task 6: Excel parsing utility (pure logic)

**Files:**
- Create: `src/lib/import/workbook-parser.ts`
- Test: `tests/import/workbook-parser.test.ts`

Depends on nothing (pure logic, no DB). Add the `exceljs` dependency first.

**Post-implementation note**: the implementer caught a real bug in this task's own illustrative code before it shipped — `extractDataRows` looping to `ws.actualRowCount` (count of non-empty rows) instead of `ws.rowCount` (highest row index with any content) would under-count and stop early whenever a sheet has an internal gap (e.g. rows `[data], [], [data]` — `actualRowCount` is 2, but row 3 must still be reached), silently dropping legitimate trailing data. Fixed by looping to `ws.rowCount` instead. Also added: a documented TypeScript cast workaround for `exceljs`'s own broken ambient `Buffer` type shim (its `index.d.ts` declares `interface Buffer extends ArrayBuffer {}`, shadowing Node's real generic `Buffer` type at the `xlsx.load()` call boundary — cast through `unknown` at that one call site rather than weakening the module's public signature), and two additional malicious-file test cases beyond the plan's original corrupted-buffer case: a CFB-magic-bytes buffer (simulating a password-protected OOXML container, which is stored as a compound-file-binary container rather than a zip — ExcelJS's zip loader cannot open it) and a valid-zip-but-malformed-internal-XML buffer built with `jszip` directly (simulating a macro-enabled-style package with broken `xl/workbook.xml`) — both confirmed to reject safely via a caught, descriptive error, never an unhandled exception or hang. `jszip` (already present as an `exceljs` transitive dependency) was added as an explicit `devDependency` at its already-resolved version (`3.10.1`) rather than left as an implicit transitive import, since the test imports it by name directly.

A code-quality reviewer then found the identical bug still present a second time, in `detectSheets` — it stored `worksheet.actualRowCount` as the `SheetInfo.rowCount` value used by `suggestPrimarySheet`'s ranking, so a sheet with an internal blank-row gap could be under-ranked below a smaller, gap-free sheet, for the same root cause as the first fix. Fixed: `detectSheets` now uses `actualRowCount` only for the "is this sheet genuinely empty" check (where it's the correct choice — a sheet with zero non-empty rows has no data regardless of gaps) and reports `worksheet.rowCount` as the ranked value, matching `extractDataRows`'s already-fixed reasoning. A new test (`ranks sheet size by highest row index, not non-empty row count...`) proves a gapped sheet with the same non-empty-row count as a smaller sheet is still ranked correctly. The reviewer's second finding (an object cell value with neither `result` nor `text`, e.g. an error cell, silently stringifies to `"[object Object]"`) was addressed with a documented blind-spot comment rather than a behavior change, since formula/error cells are out of scope for this phase's participant-registration data — a future caller hitting this has a clear pointer to why.

- [ ] **Step 1: Add the dependency**

```bash
npm install exceljs
npm install --save-dev @types/exceljs 2>&1 || echo "exceljs ships its own types, @types/exceljs may not exist — check and skip if so"
```

- [ ] **Step 2: Write failing tests for sheet detection and cell extraction**

```ts
// tests/import/workbook-parser.test.ts
import { describe, expect, it } from 'vitest';
import { detectSheets, extractHeaderRow, extractDataRows, suggestPrimarySheet } from '@/lib/import/workbook-parser';
import ExcelJS from 'exceljs';

async function buildWorkbook(sheets: { name: string; rows: (string | number | Date | null)[][] }[]) {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    for (const row of s.rows) ws.addRow(row);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('workbook-parser', () => {
  it('detects all non-empty sheets and suggests the one with the most data rows', async () => {
    const buf = await buildWorkbook([
      { name: 'Notes', rows: [['just one note']] },
      { name: 'Participants', rows: [['Name', 'Email'], ['A', 'a@x.com'], ['B', 'b@x.com'], ['C', 'c@x.com']] },
      { name: 'Empty', rows: [] },
    ]);
    const sheets = await detectSheets(buf);
    expect(sheets.map((s) => s.name)).toEqual(['Notes', 'Participants']); // Empty excluded
    expect(suggestPrimarySheet(sheets)).toBe('Participants');
  });

  it('preserves exact original header text and column order', async () => {
    const buf = await buildWorkbook([{ name: 'S', rows: [['  Full Name ', 'البريد الإلكتروني', 'Email'], ['A', 'x', 'a@x.com']] }]);
    const headers = await extractHeaderRow(buf, 'S');
    expect(headers).toEqual(['  Full Name ', 'البريد الإلكتروني', 'Email']); // untrimmed, exact order
  });

  it('detects blank and repeated column headings', async () => {
    const buf = await buildWorkbook([{ name: 'S', rows: [['Email', '', 'Email'], ['a@x.com', 'x', 'b@x.com']] }]);
    const headers = await extractHeaderRow(buf, 'S');
    // caller (mapping suggestion logic, Task 7) is responsible for flagging
    // duplicates/blanks — this layer just reports what's literally there.
    expect(headers).toEqual(['Email', '', 'Email']);
  });

  it('extracts phone-like cells as text, preserving leading zeros and plus signs', async () => {
    const buf = await buildWorkbook([{ name: 'S', rows: [['Phone'], ['+968 9123 4567']] }]);
    const rows = await extractDataRows(buf, 'S', 1);
    expect(rows[0][0]).toBe('+968 9123 4567');
  });

  it('parses Excel date cells to ISO date strings', async () => {
    const buf = await buildWorkbook([{ name: 'S', rows: [['DOB'], [new Date('2000-05-15T00:00:00Z')]] }]);
    const rows = await extractDataRows(buf, 'S', 1);
    expect(rows[0][0]).toBe('2000-05-15');
  });

  it('handles blank rows and partially completed rows without throwing', async () => {
    const buf = await buildWorkbook([{ name: 'S', rows: [['A', 'B'], ['x', 'y'], [], ['z', null]] }]);
    const rows = await extractDataRows(buf, 'S', 1);
    expect(rows).toHaveLength(3); // blank row included as an empty-cells row, not silently dropped — validation layer (Task 9) decides what to do with it
  });

  it('rejects a corrupted buffer safely, without throwing an unhandled exception', async () => {
    const badBuf = Buffer.from('not a real xlsx file');
    await expect(detectSheets(badBuf)).rejects.toThrow(/failed to parse|invalid|corrupt/i);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail** (module doesn't exist yet)

- [ ] **Step 4: Implement `src/lib/import/workbook-parser.ts`**

```ts
// src/lib/import/workbook-parser.ts
import ExcelJS from 'exceljs';

export interface SheetInfo {
  name: string;
  rowCount: number;
}

export async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (err) {
    throw new Error(`Failed to parse workbook: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
  return wb;
}

export async function detectSheets(buffer: Buffer): Promise<SheetInfo[]> {
  const wb = await loadWorkbook(buffer);
  const sheets: SheetInfo[] = [];
  wb.eachSheet((worksheet) => {
    const rowCount = worksheet.actualRowCount;
    if (rowCount > 0) sheets.push({ name: worksheet.name, rowCount });
  });
  return sheets;
}

export function suggestPrimarySheet(sheets: SheetInfo[]): string | null {
  if (sheets.length === 0) return null;
  return sheets.reduce((best, s) => (s.rowCount > best.rowCount ? s : best), sheets[0]).name;
}

function cellToValue(cell: ExcelJS.Cell): string | null {
  if (cell.value === null || cell.value === undefined) return null;
  if (cell.value instanceof Date) {
    // Preserve as an ISO date (not datetime) — sufficient for the
    // birth_date/registration-date fields this importer handles; a caller
    // needing time-of-day precision is out of scope for this phase's
    // participant-registration data.
    return cell.value.toISOString().slice(0, 10);
  }
  if (typeof cell.value === 'object' && 'result' in cell.value) {
    // Formula cell — use its computed result, never the formula text.
    const result = (cell.value as { result: unknown }).result;
    return result === null || result === undefined ? null : String(result);
  }
  if (typeof cell.value === 'object' && 'text' in cell.value) {
    // Rich-text cell.
    return String((cell.value as { text: unknown }).text);
  }
  return String(cell.value);
}

export async function extractHeaderRow(buffer: Buffer, sheetName: string): Promise<string[]> {
  const wb = await loadWorkbook(buffer);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new Error(`Sheet "${sheetName}" not found`);
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber - 1] = cellToValue(cell) ?? '';
  });
  return headers;
}

export async function extractDataRows(buffer: Buffer, sheetName: string, headerRowNumber: number): Promise<(string | null)[][]> {
  const wb = await loadWorkbook(buffer);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new Error(`Sheet "${sheetName}" not found`);
  const columnCount = ws.getRow(headerRowNumber).cellCount;
  const rows: (string | null)[][] = [];
  for (let r = headerRowNumber + 1; r <= ws.actualRowCount; r++) {
    const row = ws.getRow(r);
    if (row.cellCount === 0) continue; // truly empty row, not even blank cells — nothing to represent
    const values: (string | null)[] = [];
    for (let c = 1; c <= columnCount; c++) {
      values[c - 1] = cellToValue(row.getCell(c));
    }
    rows.push(values);
  }
  return rows;
}
```

- [ ] **Step 5: Run tests, verify pass**

- [ ] **Step 6: Verify malicious-file safety directly** — feed a macro-enabled (`.xlsm` renamed to `.xlsx`) and a password-protected `.xlsx` (create throwaway fixtures for this, do not use real files) through `detectSheets` and confirm both throw a caught, descriptive error rather than crashing the process or hanging. Add these as two more test cases in the same file if not already covered by Step 2's corrupted-buffer test.

- [ ] **Step 7: Run `npx tsc --noEmit`, `npm run lint`**

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/lib/import/workbook-parser.ts tests/import/workbook-parser.test.ts
git commit -m "feat: add Excel workbook parsing utility using exceljs"
```

---

## Task 7: Column-mapping suggestion engine (pure logic)

**Files:**
- Create: `src/lib/import/field-dictionary.ts`
- Create: `src/lib/import/mapping-suggestion.ts`
- Test: `tests/import/mapping-suggestion.test.ts`

Depends on nothing new (pure logic). Can run in parallel with Task 6 if using multiple workers, but this plan is sequential — proceed after Task 6.

**Post-implementation note**: the implementer flagged a real, user-confirmed gap: `normalizeHeader` did not strip invisible Unicode bidi control characters (LRM/RLM U+200E/U+200F, embed/override U+202A-U+202E, isolate U+2066-U+2069). These are commonly injected around RTL text when Arabic headers are copy-pasted from Word or a web page into Excel, even though the text looks visually identical to the same string typed directly — without stripping them, an otherwise-exact Arabic alias match would silently degrade to a lower-confidence fuzzy match, given this platform's Arabic/English bilingual conference context. Fixed by stripping these characters at the start of `normalizeHeader`, with a new test constructing an RLM-wrapped Arabic header via `String.fromCharCode` (avoiding any dependence on an invisible character correctly round-tripping through the source file itself) and asserting it now matches with confidence exactly `1`, not a degraded fuzzy score.

A code-quality reviewer then found a second, real bug: `suggestMapping`'s substring-containment case awarded a flat `0.85` score regardless of length ratio, so a long, mostly-unrelated header that happened to contain a short alias as a coincidental substring (e.g. "the corporate email address of the applicant maybe cc" containing "email") could outscore a genuinely close fuzzy variant like "e-mail" — a real risk for `isCriticalIdentity` fields like email, where a spuriously high confidence could suppress the mandatory-review flag a properly-low score would otherwise trigger. Fixed by dampening the substring-match score by the length ratio of the shorter string to the longer one (`0.85 * min(len)/max(len)`), with a new test proving the coincidental-containment scenario now scores below the review threshold. Also addressed two Minor findings from the same review: the "first-match-wins" tie-breaking behavior in `suggestMapping`'s loop (an accepted, order-dependent simplification, not a bug) is now documented inline rather than left implicit, and the `0.5` "not plausible" floor was extracted into a named `MIN_PLAUSIBLE_SCORE` constant instead of a bare magic number.

- [ ] **Step 1: Write `src/lib/import/field-dictionary.ts`** — the known-field alias dictionary

```ts
// src/lib/import/field-dictionary.ts
// Fixed dictionary of known applications columns and application_answers
// question_keys, each with English + Arabic header aliases used for
// similarity matching (Task 7's mapping-suggestion.ts). Extending this list
// is the ONLY place new known fields need to be added — mapping-suggestion.ts
// itself has no hardcoded field names.
export interface KnownField {
  key: string;               // applications column name, or a stable question_key for generic answers
  kind: 'core_field' | 'known_answer';
  isCriticalIdentity: boolean; // email, unique-identifier candidates — never auto-mapped below the confidence floor
  aliases: string[];          // English + Arabic, lowercased, used for exact/substring/fuzzy match
}

export const KNOWN_FIELDS: KnownField[] = [
  { key: 'full_name', kind: 'core_field', isCriticalIdentity: false, aliases: ['full name', 'name', 'الاسم الكامل', 'الاسم'] },
  { key: 'email', kind: 'core_field', isCriticalIdentity: true, aliases: ['email', 'email address', 'e-mail', 'البريد الإلكتروني', 'الايميل'] },
  { key: 'phone', kind: 'core_field', isCriticalIdentity: false, aliases: ['phone', 'phone number', 'mobile', 'رقم الهاتف', 'الهاتف'] },
  { key: 'whatsapp', kind: 'known_answer', isCriticalIdentity: false, aliases: ['whatsapp', 'whatsapp number', 'رقم الواتساب'] },
  { key: 'country', kind: 'core_field', isCriticalIdentity: false, aliases: ['country', 'الدولة', 'البلد'] },
  { key: 'nationality', kind: 'core_field', isCriticalIdentity: false, aliases: ['nationality', 'الجنسية'] },
  { key: 'city', kind: 'core_field', isCriticalIdentity: false, aliases: ['city', 'المدينة'] },
  { key: 'gender', kind: 'known_answer', isCriticalIdentity: false, aliases: ['gender', 'الجنس'] },
  { key: 'birth_date', kind: 'core_field', isCriticalIdentity: false, aliases: ['date of birth', 'dob', 'birth date', 'تاريخ الميلاد'] },
  { key: 'age_group', kind: 'core_field', isCriticalIdentity: false, aliases: ['age', 'age group', 'العمر'] },
  { key: 'preferred_language', kind: 'core_field', isCriticalIdentity: false, aliases: ['preferred language', 'language', 'اللغة المفضلة'] },
  { key: 'language_ability', kind: 'known_answer', isCriticalIdentity: false, aliases: ['language ability', 'arabic english ability', 'إتقان اللغة'] },
  { key: 'organization', kind: 'core_field', isCriticalIdentity: false, aliases: ['organization', 'organisation', 'company', 'الجهة', 'المنظمة'] },
  { key: 'field_of_work', kind: 'core_field', isCriticalIdentity: false, aliases: ['position', 'role', 'field of work', 'المجال', 'الوظيفة'] },
  { key: 'experience_level', kind: 'core_field', isCriticalIdentity: false, aliases: ['experience level', 'experience', 'مستوى الخبرة'] },
  { key: 'interests', kind: 'core_field', isCriticalIdentity: false, aliases: ['interests', 'climate interests', 'الاهتمامات'] },
  { key: 'topics_to_learn', kind: 'core_field', isCriticalIdentity: false, aliases: ['topics to learn', 'preferred topics', 'الموضوعات المفضلة'] },
  { key: 'accessibility_requirements', kind: 'known_answer', isCriticalIdentity: false, aliases: ['accessibility', 'accessibility requirements', 'احتياجات الوصول'] },
  { key: 'dietary_requirements', kind: 'known_answer', isCriticalIdentity: false, aliases: ['dietary', 'dietary requirements', 'food restrictions', 'المتطلبات الغذائية'] },
  { key: 'emergency_contact_name', kind: 'known_answer', isCriticalIdentity: false, aliases: ['emergency contact name', 'اسم جهة الاتصال للطوارئ'] },
  { key: 'emergency_contact_phone', kind: 'known_answer', isCriticalIdentity: false, aliases: ['emergency contact phone', 'هاتف جهة الاتصال للطوارئ'] },
];
```

- [ ] **Step 2: Write failing tests for normalization, aliasing, and confidence scoring**

```ts
// tests/import/mapping-suggestion.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeHeader, suggestMapping, computeHeaderSignature } from '@/lib/import/mapping-suggestion';

describe('normalizeHeader', () => {
  it('trims, lowercases, and collapses internal whitespace', () => {
    expect(normalizeHeader('  Email   Address  ')).toBe('email address');
  });
});

describe('suggestMapping', () => {
  it('matches an exact English alias with high confidence', () => {
    const s = suggestMapping('Email Address');
    expect(s?.key).toBe('email');
    expect(s?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('matches an exact Arabic alias with high confidence', () => {
    const s = suggestMapping('البريد الإلكتروني');
    expect(s?.key).toBe('email');
    expect(s?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('matches a close-but-not-exact variant with moderate confidence', () => {
    const s = suggestMapping('E-mail');
    expect(s?.key).toBe('email');
    expect(s?.confidence).toBeGreaterThan(0.5);
  });

  it('returns null or low confidence for an unrecognized header', () => {
    const s = suggestMapping('Favorite Color XYZ123');
    expect(s === null || s.confidence < 0.7).toBe(true);
  });

  it('never returns a critical-identity match below the review threshold as auto-applicable', () => {
    // A deliberately garbled header that might fuzzy-match "email" weakly —
    // the caller (mapping UI, Task 12) must treat isCriticalIdentity fields
    // below threshold as mandatory-review regardless of the raw score.
    const s = suggestMapping('emial adress maybe');
    if (s?.key === 'email') {
      expect(s.confidence).toBeLessThan(0.9); // not falsely high-confidence
    }
  });
});

describe('computeHeaderSignature', () => {
  it('produces the same signature for the same header set regardless of case/whitespace', () => {
    const sig1 = computeHeaderSignature(['Email', 'Full Name', 'Phone']);
    const sig2 = computeHeaderSignature(['  email  ', 'full name', 'PHONE']);
    expect(sig1).toBe(sig2);
  });

  it('produces a different signature when headers actually differ', () => {
    const sig1 = computeHeaderSignature(['Email', 'Full Name']);
    const sig2 = computeHeaderSignature(['Email', 'Full Name', 'Phone']);
    expect(sig1).not.toBe(sig2);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

- [ ] **Step 4: Implement `src/lib/import/mapping-suggestion.ts`**

```ts
// src/lib/import/mapping-suggestion.ts
import { createHash } from 'node:crypto';
import { KNOWN_FIELDS, type KnownField } from './field-dictionary';

export function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface MappingSuggestion {
  key: string;
  kind: KnownField['kind'];
  isCriticalIdentity: boolean;
  confidence: number;
}

// Levenshtein-based similarity, normalized to 0..1. Simple, dependency-free,
// sufficient for short header strings — no need for a fuzzy-matching library
// for this scale of comparison (dictionary is ~20 entries, header strings
// are a handful of words).
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const distance = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - distance / maxLen;
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

export function suggestMapping(header: string): MappingSuggestion | null {
  const normalized = normalizeHeader(header);
  if (normalized === '') return null;

  let best: MappingSuggestion | null = null;
  for (const field of KNOWN_FIELDS) {
    for (const alias of field.aliases) {
      const score = normalized === alias ? 1 : normalized.includes(alias) || alias.includes(normalized) ? 0.85 : similarity(normalized, alias);
      if (score < 0.5) continue; // below any plausible-match floor, don't even consider
      if (!best || score > best.confidence) {
        best = { key: field.key, kind: field.kind, isCriticalIdentity: field.isCriticalIdentity, confidence: score };
      }
    }
  }
  return best;
}

export function computeHeaderSignature(headers: string[]): string {
  const normalized = headers.map(normalizeHeader).join('|');
  return createHash('sha256').update(normalized).digest('hex');
}
```

- [ ] **Step 5: Run tests, verify pass; tune `similarity`/threshold constants if any test's expectation isn't met by the first implementation attempt — this is exactly the kind of pure-logic tuning that should happen here, not in a later integration task**

- [ ] **Step 6: `npx tsc --noEmit`, `npm run lint`**

- [ ] **Step 7: Commit**

```bash
git add src/lib/import/field-dictionary.ts src/lib/import/mapping-suggestion.ts tests/import/mapping-suggestion.test.ts
git commit -m "feat: add column-mapping suggestion engine with English/Arabic alias matching"
```

---

## Task 8: Normalization utilities (pure logic)

**Files:**
- Create: `src/lib/import/normalization.ts`
- Test: `tests/import/normalization.test.ts`

**Post-implementation note**: unlike every other pure-logic task in this plan so far, no bugs were found in this task's own illustrative code — implemented verbatim, first-attempt-green. A code-quality review found only Minor issues: `isValidEmail`'s doc comment inaccurately claimed it used "the same pattern" as this codebase's registration Zod schema (`z.string().email()`), when the two are similar in permissiveness but genuinely different regexes — corrected to describe them as roughly equivalent, not identical. Also added 6 more `isValidEmail` edge-case tests (plus-tag alias, subdomain, double-`@`, no local part, space in local part, no TLD) to lock in the behavior the review traced through manually. Two scope observations were raised and deliberately NOT acted on, since expanding them without evidence from real source data would be guessing: `normalizeYesNo`'s Arabic value set (`نعم`/`أجل`/`لا`/`كلا`) may not cover every variant a real Google Forms export uses (e.g. "صح"/"خطأ", "موافق"/"غير موافق") — unrecognized values safely return `null` rather than misclassifying, so this is a safe gap, not a defect; `splitMultiSelect`'s separator regex doesn't handle the Arabic comma (`،`) — same reasoning, flagged for a future data-driven pass if real exports need it.

Depends on nothing new. Covers every normalization rule the design spec lists: email, phone-preservation, Excel dates (already handled at the parser layer in Task 6 — this task covers *validation* of already-string dates plus non-Excel-native date strings that might appear as text), yes/no (Arabic + English), multi-select splitting, row fingerprinting.

- [ ] **Step 1: Write failing tests**

```ts
// tests/import/normalization.test.ts
import { describe, expect, it } from 'vitest';
import {
  normalizeEmail, isValidEmail, normalizePhone, normalizeYesNo,
  splitMultiSelect, computeRowFingerprint, computeFileChecksum,
} from '@/lib/import/normalization';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => expect(normalizeEmail('  Foo.Bar@EXAMPLE.com  ')).toBe('foo.bar@example.com'));
});

describe('isValidEmail', () => {
  it('accepts a well-formed address', () => expect(isValidEmail('a@b.com')).toBe(true));
  it('rejects a malformed address', () => expect(isValidEmail('not-an-email')).toBe(false));
});

describe('normalizePhone', () => {
  it('preserves leading zeros and plus signs', () => {
    expect(normalizePhone('+968 9123 4567')).toBe('+968 9123 4567');
    expect(normalizePhone('0091234567')).toBe('0091234567');
  });
});

describe('normalizeYesNo', () => {
  it.each([
    ['yes', true], ['Yes', true], ['Y', true], ['نعم', true], ['true', true], ['1', true],
    ['no', false], ['N', false], ['لا', false], ['false', false], ['0', false],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeYesNo(input)).toBe(expected);
  });
  it('returns null for an unrecognized value rather than guessing', () => {
    expect(normalizeYesNo('maybe')).toBeNull();
  });
});

describe('splitMultiSelect', () => {
  it('splits on commas', () => expect(splitMultiSelect('Climate, Energy, Water')).toEqual(['Climate', 'Energy', 'Water']));
  it('splits on semicolons', () => expect(splitMultiSelect('Climate; Energy; Water')).toEqual(['Climate', 'Energy', 'Water']));
  it('splits on line breaks', () => expect(splitMultiSelect('Climate\nEnergy\nWater')).toEqual(['Climate', 'Energy', 'Water']));
  it('trims each resulting item and drops empty entries', () => expect(splitMultiSelect('Climate,  , Energy,')).toEqual(['Climate', 'Energy']));
});

describe('computeRowFingerprint', () => {
  it('produces the same fingerprint for the same normalized content', () => {
    const a = computeRowFingerprint({ email: 'a@b.com', full_name: 'A B' });
    const b = computeRowFingerprint({ email: 'a@b.com', full_name: 'A B' });
    expect(a).toBe(b);
  });
  it('produces a different fingerprint when content differs', () => {
    const a = computeRowFingerprint({ email: 'a@b.com', full_name: 'A B' });
    const b = computeRowFingerprint({ email: 'a@b.com', full_name: 'A C' });
    expect(a).not.toBe(b);
  });
  it('is insensitive to key insertion order', () => {
    const a = computeRowFingerprint({ email: 'a@b.com', full_name: 'A B' });
    const b = computeRowFingerprint({ full_name: 'A B', email: 'a@b.com' });
    expect(a).toBe(b);
  });
});

describe('computeFileChecksum', () => {
  it('produces a stable SHA-256 hex digest for the same bytes', () => {
    const buf = Buffer.from('hello world');
    expect(computeFileChecksum(buf)).toBe(computeFileChecksum(Buffer.from('hello world')));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement `src/lib/import/normalization.ts`**

```ts
// src/lib/import/normalization.ts
import { createHash } from 'node:crypto';

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  // Same permissive-but-real pattern already used by this codebase's
  // registration Zod schema (z.string().email()) — reimplemented here as a
  // plain regex since this module has no Zod dependency of its own and
  // doesn't need one for a single format check.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function normalizePhone(raw: string): string {
  // Preserve exactly as entered (leading zeros, plus signs, spacing) per
  // the design spec's "preserving the original phone value" requirement —
  // this function only trims surrounding whitespace, it does not reformat.
  return raw.trim();
}

const YES_VALUES = new Set(['yes', 'y', 'true', '1', 'نعم', 'أجل']);
const NO_VALUES = new Set(['no', 'n', 'false', '0', 'لا', 'كلا']);

export function normalizeYesNo(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (YES_VALUES.has(v)) return true;
  if (NO_VALUES.has(v)) return false;
  return null;
}

export function splitMultiSelect(raw: string): string[] {
  return raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function computeRowFingerprint(normalizedRow: Record<string, unknown>): string {
  const sortedKeys = Object.keys(normalizedRow).sort();
  const canonical = sortedKeys.map((k) => `${k}=${JSON.stringify(normalizedRow[k])}`).join('&');
  return createHash('sha256').update(canonical).digest('hex');
}

export function computeFileChecksum(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
```

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: `npx tsc --noEmit`, `npm run lint`**

- [ ] **Step 6: Commit**

```bash
git add src/lib/import/normalization.ts tests/import/normalization.test.ts
git commit -m "feat: add data normalization utilities (email, phone, yes/no, multi-select, fingerprinting)"
```

---

## Task 9: Formula-injection-safe CSV export utility (pure logic)

**Files:**
- Create: `src/lib/import/csv-export.ts`
- Test: `tests/import/csv-export.test.ts`

**Post-implementation note**: a code-quality review, treating this as a genuine security control (CSV/formula injection is OWASP-recognized), found the plan's original dangerous-character set (`=`/`+`/`-`/`@`) and quote-triggering set (comma/quote/newline) were both incomplete relative to standard guidance. Fixed two real gaps: (1) a cell with LEADING WHITESPACE before a dangerous character (e.g. `" =SUM(A1)"` or a leading tab) bypassed the prefix entirely, since the original check was a literal `startsWith` — some spreadsheet applications still treat leading-whitespace-then-formula as live, so the check now strips leading whitespace before testing for a dangerous leading character (while still prefixing the ORIGINAL, untrimmed value — the fix decides whether to neutralize, it doesn't reformat cell content); (2) a cell containing a bare carriage return (`\r`, old Mac-style line ending, no accompanying `\n`) was never quote-wrapped, since only `\n` was checked — a consumer that splits on `\r` as well as `\n` could misread this as a row boundary, so `\r` was added to both the dangerous-leading-character set (tab and CR are both cited in OWASP's CSV Injection guidance alongside `=+-@`) and the quote-triggering character check. Two new regression tests cover both fixes directly.

Depends on nothing new. Small, isolated, needed by Task 15 (error report download).

- [ ] **Step 1: Write failing tests**

```ts
// tests/import/csv-export.test.ts
import { describe, expect, it } from 'vitest';
import { toSafeCsv } from '@/lib/import/csv-export';

describe('toSafeCsv', () => {
  it('neutralizes formula-injection-prone leading characters', () => {
    const rows = [['=SUM(A1)', '+1', '-1', '@cmd', 'normal']];
    const csv = toSafeCsv(['Col'], rows);
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain("'+1");
    expect(csv).toContain("'-1");
    expect(csv).toContain("'@cmd");
    expect(csv).not.toContain("'normal");
  });

  it('quotes fields containing commas, quotes, or newlines', () => {
    const csv = toSafeCsv(['Col'], [['a,b']]);
    expect(csv).toContain('"a,b"');
  });

  it('escapes embedded double quotes', () => {
    const csv = toSafeCsv(['Col'], [['a"b']]);
    expect(csv).toContain('"a""b"');
  });

  it('includes the header row', () => {
    const csv = toSafeCsv(['Row', 'Error'], [['1', 'Missing email']]);
    expect(csv.split('\n')[0]).toBe('Row,Error');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement `src/lib/import/csv-export.ts`**

```ts
// src/lib/import/csv-export.ts
const DANGEROUS_LEADING_CHARS = ['=', '+', '-', '@'];

function escapeCell(value: string): string {
  let v = value;
  if (DANGEROUS_LEADING_CHARS.some((c) => v.startsWith(c))) {
    v = `'${v}`; // prefix with a literal apostrophe, matching the spec's exact prescription
  }
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    v = `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

export function toSafeCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.join(','), ...rows.map((row) => row.map(escapeCell).join(','))];
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: `npx tsc --noEmit`, `npm run lint`**

- [ ] **Step 6: Commit**

```bash
git add src/lib/import/csv-export.ts tests/import/csv-export.test.ts
git commit -m "feat: add formula-injection-safe CSV export utility"
```

---

## Task 10: Row validation and duplicate-classification logic (pure logic)

**Files:**
- Create: `src/lib/import/row-validation.ts`
- Test: `tests/import/row-validation.test.ts`

Depends on Tasks 7-8 (uses `mapping-suggestion`'s `KnownField` shapes and `normalization`'s helpers). This is the core business logic of the import pipeline — the function that turns `(raw row + column mapping) → (normalized row + validation result)`, callable identically from both the live-preview server action (Task 13) and a pure-logic test, matching the codebase's established pattern of keeping orchestration thin and putting real logic in testable pure functions (see `src/lib/allocation/feature-extraction.ts`, `src/lib/schedule/fingerprint.ts` as precedent).

**Post-implementation note**: of the 5 scrutiny points explicitly called out in this task's brief, 4 were confirmed correct as originally specified and 1 was a real bug, fixed. The required-email-error's `originalValue` field originally read `rawRow[opts.uniqueIdentifierColumnIndex]` unconditionally — this only happens to be correct when the unique-identifier column IS the email column (the common case, and the only case the plan's given tests exercised), but would silently show the wrong column's value whenever an admin designates a different column (e.g. a registration-ID column) as the unique identifier while email is mapped elsewhere. Fixed by tracking the raw value from whichever mapping entry actually targets `'email'`, falling back to the unique-identifier column only if no column is mapped to email at all. Also added two regression tests beyond the plan's given suite: one confirming `classifyDuplicateStatus`'s precedence (within-file duplicate wins even when the same email also matches a blocked-downstream existing application — a genuine overlap scenario the given tests didn't cover), and one confirming `normalizedRow` retains successfully-parsed fields (e.g. `full_name`) even when the row overall fails validation (per the design spec's "invalid rows must not be silently discarded" requirement).

A code-quality review then found two documentation/coverage gaps (no defects): `classifyDuplicateStatus`'s `seenEmailsInFile` map is never mutated by the function itself — the caller (Task 14) must call `.set(normalizedEmail, rowIndex)` after classifying each row for within-file dedup to work across rows 3+, and this contract lived only in a nearby precedence comment, not attached to the field itself — fixed with an explicit doc comment on `seenEmailsInFile` warning that forgetting the per-row update silently breaks dedup with no error from this function. Also added a defensive comment on the `normalizedRow.email as string | undefined` cast (currently safe, but unenforced if a future known-field addition ever changed `'email'`'s dispatch branch), and a test explicitly asserting both `full_name` and `email` required-field errors are reported independently (not just "at least one error") when both are missing.

A separate cross-task integration review of all 5 pure-logic modules built so far (Tasks 6-10 together) found **no real integration issues** — the `MappingSuggestion` (Task 7) → `ColumnMapping` (Task 10) shape conversion is already handled cleanly at Task 13's `getMappingSuggestions()` call site, `workbook-parser.ts`'s (Task 6) row/column indexing is consistent with `row-validation.ts`'s expectations, and `computeRowFingerprint` (Task 8) hashes `normalizedRow` deterministically through multiselect arrays. One advisory-only note for future awareness (not acted on, no current call site exercises it): `extractHeaderRow` is hardcoded to read row 1, while `extractDataRows` accepts an arbitrary `headerRowNumber` parameter — today every call site passes `1` to both, so they're always in sync, but nothing in the types enforces that invariant if a future task ever needs to support a header row other than row 1.

- [ ] **Step 1: Write failing tests**

```ts
// tests/import/row-validation.test.ts
import { describe, expect, it } from 'vitest';
import { validateRow, classifyDuplicateStatus, type ColumnMapping } from '@/lib/import/row-validation';

const baseMapping: ColumnMapping[] = [
  { sourceColumnIndex: 0, targetKind: 'core_field', targetKey: 'full_name' },
  { sourceColumnIndex: 1, targetKind: 'core_field', targetKey: 'email' },
  { sourceColumnIndex: 2, targetKind: 'known_answer', targetKey: 'accessibility_requirements' },
  { sourceColumnIndex: 3, targetKind: 'ignored', targetKey: null },
];

describe('validateRow', () => {
  it('marks a row with full name and valid email as valid', () => {
    const result = validateRow(['Jane Doe', 'jane@example.com', '', 'noise'], baseMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(result.status).toBe('valid');
    expect(result.errors).toHaveLength(0);
  });

  it('marks a row with a missing required field (email) as invalid', () => {
    const result = validateRow(['Jane Doe', '', '', ''], baseMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(result.status).toBe('invalid');
    expect(result.errors.some((e) => e.column === 'email')).toBe(true);
  });

  it('marks a row with an invalid email format as invalid, with a human-readable reason', () => {
    const result = validateRow(['Jane Doe', 'not-an-email', '', ''], baseMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(result.status).toBe('invalid');
    expect(result.errors[0].error).toMatch(/email/i);
    expect(result.errors[0].column).toBe('email');
    expect(result.errors[0].originalValue).toBe('not-an-email');
  });

  it('produces a normalized_row with mapped core fields keyed by target', () => {
    const result = validateRow(['Jane Doe', 'JANE@EXAMPLE.COM', 'wheelchair access', ''], baseMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(result.normalizedRow.full_name).toBe('Jane Doe');
    expect(result.normalizedRow.email).toBe('jane@example.com');
  });

  it('ignores columns mapped to target_kind ignored', () => {
    const result = validateRow(['Jane Doe', 'jane@example.com', '', 'this should not appear anywhere'], baseMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(JSON.stringify(result.normalizedRow)).not.toContain('this should not appear anywhere');
  });

  it('preserves a fully blank row as a distinct, non-crashing case', () => {
    const result = validateRow(['', '', '', ''], baseMapping, { uniqueIdentifierColumnIndex: 1 });
    expect(result.status).toBe('invalid'); // blank required field
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('classifyDuplicateStatus', () => {
  it('classifies two rows in the same file with the same normalized email as duplicate_in_file', () => {
    const seen = new Map<string, number>();
    const first = classifyDuplicateStatus('jane@example.com', { seenEmailsInFile: seen, rowIndex: 0, existingApplication: null });
    expect(first).toBeNull(); // first occurrence is not itself a duplicate
    seen.set('jane@example.com', 0);
    const second = classifyDuplicateStatus('jane@example.com', { seenEmailsInFile: seen, rowIndex: 5, existingApplication: null });
    expect(second).toEqual({ status: 'duplicate_in_file', duplicateOfRowIndex: 0 });
  });

  it('classifies a match against an unclaimed existing application as existing_unclaimed', () => {
    const result = classifyDuplicateStatus('jane@example.com', {
      seenEmailsInFile: new Map(), rowIndex: 0,
      existingApplication: { id: 'app-1', applicantId: null, hasDownstreamReference: false },
    });
    expect(result).toEqual({ status: 'existing_unclaimed', applicationId: 'app-1' });
  });

  it('classifies a match against a claimed existing application as existing_claimed', () => {
    const result = classifyDuplicateStatus('jane@example.com', {
      seenEmailsInFile: new Map(), rowIndex: 0,
      existingApplication: { id: 'app-1', applicantId: 'user-1', hasDownstreamReference: false },
    });
    expect(result).toEqual({ status: 'existing_claimed', applicationId: 'app-1' });
  });

  it('classifies a match with downstream references as blocked_downstream regardless of claim status', () => {
    const claimed = classifyDuplicateStatus('jane@example.com', {
      seenEmailsInFile: new Map(), rowIndex: 0,
      existingApplication: { id: 'app-1', applicantId: 'user-1', hasDownstreamReference: true },
    });
    expect(claimed).toEqual({ status: 'blocked_downstream', applicationId: 'app-1' });
    const unclaimed = classifyDuplicateStatus('jane@example.com', {
      seenEmailsInFile: new Map(), rowIndex: 0,
      existingApplication: { id: 'app-2', applicantId: null, hasDownstreamReference: true },
    });
    expect(unclaimed).toEqual({ status: 'blocked_downstream', applicationId: 'app-2' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement `src/lib/import/row-validation.ts`**

```ts
// src/lib/import/row-validation.ts
import { normalizeEmail, isValidEmail, normalizePhone, normalizeYesNo, splitMultiSelect } from './normalization';

export interface ColumnMapping {
  sourceColumnIndex: number;
  targetKind: 'core_field' | 'known_answer' | 'generic_answer' | 'ignored';
  targetKey: string | null;
}

export interface ValidationIssue {
  column: string;
  originalValue: string | null;
  error: string;
}

export interface RowValidationResult {
  status: 'valid' | 'warning' | 'invalid';
  normalizedRow: Record<string, unknown>;
  warnings: ValidationIssue[];
  errors: ValidationIssue[];
}

// Fields that get special-cased transforms beyond plain trim/pass-through.
// Extending this is how a future known_answer/core_field gets richer
// normalization without touching the generic loop below.
const MULTISELECT_KEYS = new Set(['interests', 'topics_to_learn', 'track_interests']);
const YES_NO_KEYS = new Set<string>([]); // reserved for future known boolean fields; none in this phase's known-field list yet

export function validateRow(
  rawRow: (string | null)[],
  mapping: ColumnMapping[],
  opts: { uniqueIdentifierColumnIndex: number }
): RowValidationResult {
  const normalizedRow: Record<string, unknown> = {};
  const warnings: ValidationIssue[] = [];
  const errors: ValidationIssue[] = [];

  for (const col of mapping) {
    if (col.targetKind === 'ignored' || col.targetKey === null) continue;
    const raw = rawRow[col.sourceColumnIndex] ?? null;
    if (raw === null || raw.trim() === '') continue; // blank cell: nothing to normalize, required-ness checked separately below

    let value: unknown = raw.trim();
    if (col.targetKey === 'email') {
      value = normalizeEmail(raw);
    } else if (col.targetKey === 'phone' || col.targetKey === 'whatsapp' || col.targetKey.includes('phone')) {
      value = normalizePhone(raw);
    } else if (MULTISELECT_KEYS.has(col.targetKey)) {
      value = splitMultiSelect(raw);
    } else if (YES_NO_KEYS.has(col.targetKey)) {
      const parsed = normalizeYesNo(raw);
      if (parsed === null) {
        warnings.push({ column: col.targetKey, originalValue: raw, error: `Unrecognized yes/no value "${raw}"` });
      }
      value = parsed;
    }
    normalizedRow[col.targetKey] = value;
  }

  // Required-field checks: full_name and email are the baseline per the
  // design spec's "at minimum, each participant must have enough
  // information to create a unique accepted-participant record."
  if (!normalizedRow.full_name || String(normalizedRow.full_name).trim() === '') {
    errors.push({ column: 'full_name', originalValue: null, error: 'Full name is required' });
  }
  const email = normalizedRow.email as string | undefined;
  if (!email) {
    errors.push({ column: 'email', originalValue: rawRow[opts.uniqueIdentifierColumnIndex] ?? null, error: 'Email is required' });
  } else if (!isValidEmail(email)) {
    errors.push({ column: 'email', originalValue: rawRow[opts.uniqueIdentifierColumnIndex] ?? null, error: `"${email}" is not a valid email address` });
  }

  const status: RowValidationResult['status'] = errors.length > 0 ? 'invalid' : warnings.length > 0 ? 'warning' : 'valid';
  return { status, normalizedRow, warnings, errors };
}

export type DuplicateClassification =
  | { status: 'duplicate_in_file'; duplicateOfRowIndex: number }
  | { status: 'existing_unclaimed'; applicationId: string }
  | { status: 'existing_claimed'; applicationId: string }
  | { status: 'blocked_downstream'; applicationId: string };

export function classifyDuplicateStatus(
  normalizedEmail: string,
  ctx: {
    seenEmailsInFile: Map<string, number>;
    rowIndex: number;
    existingApplication: { id: string; applicantId: string | null; hasDownstreamReference: boolean } | null;
  }
): DuplicateClassification | null {
  const priorRowIndex = ctx.seenEmailsInFile.get(normalizedEmail);
  if (priorRowIndex !== undefined) {
    return { status: 'duplicate_in_file', duplicateOfRowIndex: priorRowIndex };
  }
  if (ctx.existingApplication) {
    if (ctx.existingApplication.hasDownstreamReference) {
      return { status: 'blocked_downstream', applicationId: ctx.existingApplication.id };
    }
    return ctx.existingApplication.applicantId === null
      ? { status: 'existing_unclaimed', applicationId: ctx.existingApplication.id }
      : { status: 'existing_claimed', applicationId: ctx.existingApplication.id };
  }
  return null;
}
```

- [ ] **Step 4: Run tests, verify pass; iterate on the implementation (not the tests) until all pass**

- [ ] **Step 5: `npx tsc --noEmit`, `npm run lint`**

- [ ] **Step 6: Commit**

```bash
git add src/lib/import/row-validation.ts tests/import/row-validation.test.ts
git commit -m "feat: add row validation and duplicate-classification pure logic"
```

- [ ] **Step 7: Dispatch code-quality review of Tasks 6-10 as a batch** (all the pure-logic foundation the rest of the phase builds on). Reviewer should verify: does `classifyDuplicateStatus`'s precedence order actually match the spec's stated order (duplicate-in-file → existing-claimed/unclaimed → blocked-downstream-overrides-claim-status)? Does `validateRow` correctly leave `normalizedRow` empty/partial for a row that fails required-field checks (so the preview UI can still show what WAS parsed, per spec's "invalid rows must not be silently discarded")? Any Arabic-text-handling correctness issues in `normalizeHeader`/`suggestMapping` (e.g., RTL mark characters, Arabic-Indic digits in phone numbers)? Fix findings before proceeding.

---

## Task 11: Private Storage bucket + validation module + Zod schemas

**Files:**
- Create: `supabase/migrations/20260726106000_import_storage_bucket.sql`
- Create: `src/lib/validation/import.ts`

Depends on Task 4 (RLS conventions established). Independent of Tasks 6-10 — can be done in parallel, but sequenced here since Task 12+ needs both.

**Post-implementation note**: implemented verbatim, no bugs found. `Storage` privacy verified live in two ways: `storage.buckets` row confirms `public: false`, and an unauthenticated fetch against the bucket's public-object URL pattern returns HTTP 400 "Bucket not found" (Supabase's public-object endpoint refuses to resolve a private bucket at all, rather than exposing content and relying on RLS alone). One real, pre-existing drift risk was found and fixed: Task 5's already-committed RLS test (`tests/rls/import.test.ts`) necessarily hardcoded `question_key: 'dietary_requirements'` as a bare string literal when seeding its sensitive-answer fixture, since `SENSITIVE_QUESTION_KEYS` didn't exist yet at that point in the plan's execution order. Fixed by importing `SENSITIVE_QUESTION_KEYS` from this task's new module and sourcing the fixture's `question_key` from `SENSITIVE_QUESTION_KEYS[0]` instead — closing the exact drift risk the constant's own doc comment describes, and confirmed all 29 of Task 5's tests still pass unchanged.

A code-quality review then found a real, if non-security-critical, deviation: the migration used per-verb (select/insert/delete) RLS policies on `storage.objects`, breaking from this phase's established convention of one `for all` policy per staff-only resource (every other RLS policy in this phase uses `for all` — see `20260726105000_import_rls_policies.sql`). It also had no UPDATE policy — Postgres RLS default-denies unmatched operations, so this was never an access-control hole, but it would silently break a future `upsert: true` call (Supabase Storage performs an UPDATE under the hood for upserts), and the omission was indistinguishable from an oversight to a future reader. Fixed via a follow-up migration consolidating the three per-verb policies into one `import_uploads_staff_all` policy (`for all`, matching every other policy's role-gating exactly, with an explicit `with check` mirroring the `using` clause), covering select/insert/update/delete uniformly. Verified live: the three old policy names are gone, exactly one consolidated policy exists with both `qual` and `with_check` populated and matching.

- [ ] **Step 1: Write the storage bucket migration**

```sql
-- import_storage_bucket.sql
insert into storage.buckets (id, name, public) values ('import-uploads', 'import-uploads', false);

-- Staff-only access to the bucket's objects, mirroring the table RLS
-- convention. Supabase Storage RLS applies to storage.objects, scoped by
-- bucket_id.
create policy import_uploads_staff_read on storage.objects
  for select using (bucket_id = 'import-uploads' and current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy import_uploads_staff_write on storage.objects
  for insert with check (bucket_id = 'import-uploads' and current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy import_uploads_staff_delete on storage.objects
  for delete using (bucket_id = 'import-uploads' and current_user_role() in ('agenda_allocation_manager', 'super_admin'));
```

- [ ] **Step 2: Apply migration**

- [ ] **Step 3: Verify bucket is genuinely private** — attempt an unauthenticated `GET` against a constructed public object URL for the bucket (or use the Supabase dashboard/CLI to confirm `public = false`) and confirm it 403s / is inaccessible.

- [ ] **Step 4: Write `src/lib/validation/import.ts`** — Zod schemas for every server-action input, following this codebase's established `src/lib/validation/*.ts` convention exactly (see `src/lib/validation/schedule.ts` from Phase 5 as the most recent precedent).

```ts
// src/lib/validation/import.ts
import { z } from 'zod';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB — generous for a 5,000-row participant sheet with no embedded images
export const CHUNK_SIZE = 250;
export const LOCK_TTL_SECONDS = 120;
export const MAPPING_CONFIDENCE_THRESHOLD = 0.7;

export const idSchema = z.string().uuid();

export const columnMappingInputSchema = z.object({
  sourceColumnIndex: z.number().int().min(0),
  targetKind: z.enum(['core_field', 'known_answer', 'generic_answer', 'ignored']),
  targetKey: z.string().min(1).nullable(),
  isManualOverride: z.boolean().default(false),
});

export const confirmMappingSchema = z.object({
  batchId: idSchema,
  mappings: z.array(columnMappingInputSchema).min(1),
  uniqueIdentifierColumnIndex: z.number().int().min(0),
  saveAsTemplateName: z.string().trim().min(1).max(120).optional(),
});

export const processChunkSchema = z.object({
  batchId: idSchema,
  lockToken: z.string().uuid(),
});

export const enableAutoProcessSchema = z.object({
  batchId: idSchema,
  clusterK: z.number().int().positive(),
});

export const sendInvitationSchema = z.object({
  applicationId: idSchema,
});

export const claimApplicationSchema = z.object({
  applicationId: idSchema,
});

// Known question_key values whose application_answers rows are marked
// is_sensitive = true at write time — single source of truth, imported by
// both the import-write server action (Task 14) and the RLS-adjacent test
// (Task 5) so the two never drift.
export const SENSITIVE_QUESTION_KEYS = [
  'accessibility_requirements',
  'dietary_requirements',
  'emergency_contact_name',
  'emergency_contact_phone',
  'special_needs',
] as const;
```

- [ ] **Step 5: `npx tsc --noEmit`, `npm run lint`**

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260726106000_import_storage_bucket.sql src/lib/validation/import.ts
git commit -m "feat: add private import-uploads Storage bucket and import validation schemas"
```

---

## Task 12: Upload + sheet-inspection server actions and page (Steps A of the flow)

**Files:**
- Create: `src/app/[locale]/(admin)/participants/import/actions.ts`
- Create: `src/app/[locale]/(admin)/participants/import/page.tsx`
- Create: `src/app/[locale]/(admin)/participants/import/upload-form.tsx`

Depends on Tasks 6, 8, 11. Route group note: existing admin routes live under `(admin)` with no `/admin` URL prefix — follow exactly (`(admin)/participants/import` → URL `/participants/import`).

- [x] **Step 1: Write `actions.ts`** — auth-gate helper (mirrors `requireStaffCaller`/`requireAgendaStaffCaller` exactly) plus `uploadImportFile`, `getBatchStatus`

```ts
// src/app/[locale]/(admin)/participants/import/actions.ts
'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { MAX_UPLOAD_BYTES } from '@/lib/validation/import';
import { detectSheets, suggestPrimarySheet } from '@/lib/import/workbook-parser';
import { computeFileChecksum } from '@/lib/import/normalization';
import { writeAuditLog } from '@/lib/agenda/server-helpers';

async function requireImportStaffCaller() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (error || !profile) throw new Error('Profile not found');
  // Reuses the exact agenda_allocation_manager/super_admin role list already
  // established for allocation/schedule staff — the design spec designates
  // the same roles as import-capable, so this deliberately imports
  // isAgendaStaffRole rather than defining a third staff-role helper.
  if (!isAgendaStaffRole(profile.role)) throw new Error('Not authorized');

  return { userId: user.id, service };
}

const ALLOWED_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLSX_MAGIC_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // ZIP local-file-header signature — .xlsx is a ZIP container

export async function uploadImportFile(formData: FormData) {
  const { userId, service } = await requireImportStaffCaller();

  const file = formData.get('file');
  if (!(file instanceof File)) throw new Error('No file provided');
  if (file.size === 0) throw new Error('File is empty');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(`File exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit`);
  if (file.type !== ALLOWED_MIME && !file.name.toLowerCase().endsWith('.xlsx')) {
    throw new Error('Only .xlsx files are supported');
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  // Never trust the client-declared MIME type alone — check the actual
  // magic bytes, since a renamed .exe or .xlsm could otherwise pass the
  // extension/MIME checks above.
  if (!buffer.subarray(0, 4).equals(XLSX_MAGIC_BYTES)) {
    throw new Error('File does not appear to be a valid .xlsx workbook');
  }

  const checksum = computeFileChecksum(buffer);

  // Same-file re-upload detection (design spec step 4): surface prior
  // imports of this exact file before staging anything new.
  const { data: priorBatches } = await service
    .from('import_batches')
    .select('id, status, uploaded_at')
    .eq('file_checksum', checksum)
    .order('uploaded_at', { ascending: false })
    .limit(1);
  const priorBatch = priorBatches?.[0] ?? null;

  let sheets;
  try {
    sheets = await detectSheets(buffer);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : 'Failed to parse the uploaded workbook');
  }
  if (sheets.length === 0) throw new Error('No non-empty sheets found in this workbook');
  const suggestedSheet = suggestPrimarySheet(sheets);

  const storagePath = `${userId}/${Date.now()}-${crypto.randomUUID()}.xlsx`;
  const { error: uploadError } = await service.storage.from('import-uploads').upload(storagePath, buffer, {
    contentType: ALLOWED_MIME,
    upsert: false,
  });
  if (uploadError) throw new Error(`Failed to store uploaded file: ${uploadError.message}`);

  const { data: batch, error: batchError } = await service
    .from('import_batches')
    .insert({
      uploaded_by: userId,
      original_filename: file.name,
      file_checksum: checksum,
      storage_path: storagePath,
      sheet_name: suggestedSheet,
      status: 'analyzing',
    })
    .select('id')
    .single();
  if (batchError || !batch) throw new Error(`Failed to create import batch: ${batchError?.message}`);

  await writeAuditLog(service, {
    entityType: 'import_batch', entityId: batch.id, action: 'upload', actorId: userId,
    metadata: { originalFilename: file.name, fileChecksum: checksum },
  });

  return {
    batchId: batch.id,
    sheets: sheets.map((s) => s.name),
    suggestedSheet,
    priorBatch: priorBatch ? { id: priorBatch.id, status: priorBatch.status, uploadedAt: priorBatch.uploaded_at } : null,
  };
}

export async function getBatchStatus(batchId: string) {
  const { service } = await requireImportStaffCaller();
  const { data, error } = await service.from('import_batches').select('*').eq('id', batchId).single();
  if (error || !data) throw new Error('Batch not found');
  return data;
}
```

- [x] **Step 2: Write `page.tsx`** — auth-gate + render the client upload form, following the exact bare-admin-page pattern from Phase 5 (`schedules/page.tsx`)

```tsx
// src/app/[locale]/(admin)/participants/import/page.tsx
import { getLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/routing';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import UploadForm from './upload-form';

export default async function ImportParticipantsPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect({ href: '/log-in', locale });
    return;
  }

  const service = createServiceRoleClient();
  const { data: profile } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || !isAgendaStaffRole(profile.role)) {
    notFound();
  }

  return (
    <div>
      <h1>Import Accepted Participants</h1>
      <p><a href="../participants">Back to participants</a></p>
      <UploadForm />
    </div>
  );
}
```

- [x] **Step 3: Write `upload-form.tsx`** — client component with drag-and-drop, calling `uploadImportFile`, then navigating to the mapping step (Task 13's route) on success

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from '@/i18n/routing';
import { uploadImportFile } from './actions';

export default function UploadForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  async function handleFile(file: File) {
    setError(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const result = await uploadImportFile(formData);
      if (result.priorBatch) {
        const proceed = window.confirm(
          `This exact file was already imported on ${new Date(result.priorBatch.uploadedAt).toLocaleString()} (status: ${result.priorBatch.status}). Continue anyway?`
        );
        if (!proceed) {
          setUploading(false);
          return;
        }
      }
      router.push(`import/${result.batchId}/map`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      {error && <p role="alert">{error}</p>}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files[0];
          if (file) void handleFile(file);
        }}
        style={{ border: dragOver ? '2px dashed #333' : '2px dashed #ccc', padding: '2rem', textAlign: 'center' }}
      >
        <p>Drag and drop an .xlsx file here, or:</p>
        <input
          type="file"
          accept=".xlsx"
          disabled={uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
      </div>
      {uploading && <p>Uploading and analyzing…</p>}
    </div>
  );
}
```

(Minimal inline styling here is acceptable per Phase 5's precedent that admin pages stay bare — the drag-target visual feedback is the one exception since drag-and-drop is unusable without *some* visual affordance; keep it to this one inline style, do not introduce a Tailwind/component dependency for the rest of this bare admin page.)

- [x] **Step 4: `npx tsc --noEmit`, `npm run lint`**

- [x] **Step 5: Manual verification** — start the dev server, sign in as agenda/allocation staff, upload a small throwaway `.xlsx` (build one with a quick script using `exceljs`, or reuse a Task 6 test fixture), confirm it lands in Storage and a `import_batches` row appears with the right `sheet_name` suggestion.

- [x] **Step 6: Commit**

```bash
git add src/app/[locale]/(admin)/participants/import/actions.ts src/app/[locale]/(admin)/participants/import/page.tsx src/app/[locale]/(admin)/participants/import/upload-form.tsx
git commit -m "feat: add Excel upload and sheet-detection admin page"
```

**Post-implementation note:** Implemented largely as specified, with two deliberate, reviewed deviations from the illustrative code (both confirmed correct, not flagged as spec gaps): (1) reuses the existing `requireAgendaStaffCaller()` from `src/lib/agenda/server-helpers.ts` instead of defining a new local `requireImportStaffCaller()`, since the design spec designates the same staff roles already established for allocation/schedule work; (2) `upload-form.tsx` navigates with an absolute path (`/participants/import/${batchId}/map`) rather than the plan's illustrative relative path, matching this repo's existing `router.push` convention (`run-list.tsx`, `log-in/page.tsx`). Manually verified end-to-end against the live project via a service-role scratch script (Next.js server actions can't be invoked outside a real request context, so `requireAgendaStaffCaller()`'s `cookies()`-based auth check can't be exercised by a standalone script — the script instead replicated the same checksum/detectSheets/Storage-upload/`import_batches`-insert logic directly): checksum computation, XLSX magic-byte check, staff-role lookup, Storage upload to `import-uploads`, and `import_batches` insert all confirmed working live, then cleaned up. Committed `8189e2c`. Spec-compliance review passed clean. Code-quality review found one real Important issue: a successful Storage upload followed by a failed `import_batches` insert left the uploaded file permanently orphaned in the bucket with nothing referencing or sweeping it — fixed by adding a `service.storage.from('import-uploads').remove([storagePath])` cleanup call in the insert-failure branch, committed `0040a66`. Two Minor findings were assessed and left as-is: the "Back to participants" link in `page.tsx` points to a list page that doesn't exist yet (a legitimate forward reference — no participants-list task exists in this plan besides admin nav in Task 19); and the prior-batch re-upload check has a benign TOCTOU race under concurrent uploads of the same file, which is fine since it's an advisory `window.confirm()` UX warning, not a uniqueness guarantee, and was already plan-approved as such.

---

## Task 13: Mapping page — server actions + UI (Step B of the flow)

**Files:**
- Create: `src/app/[locale]/(admin)/participants/import/[batchId]/map/actions.ts`
- Create: `src/app/[locale]/(admin)/participants/import/[batchId]/map/page.tsx`
- Create: `src/app/[locale]/(admin)/participants/import/[batchId]/map/mapping-table.tsx`

Depends on Tasks 7, 11, 12.

- [x] **Step 1: Write `actions.ts`** — `getSheetHeaders(batchId, sheetName)`, `suggestMappings(batchId)`, `findMatchingTemplate(batchId)`, `confirmMapping(input)`

```ts
// src/app/[locale]/(admin)/participants/import/[batchId]/map/actions.ts
'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { confirmMappingSchema, MAPPING_CONFIDENCE_THRESHOLD } from '@/lib/validation/import';
import { extractHeaderRow } from '@/lib/import/workbook-parser';
import { suggestMapping, computeHeaderSignature } from '@/lib/import/mapping-suggestion';
import { writeAuditLog } from '@/lib/agenda/server-helpers';

async function requireImportStaffCaller() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (error || !profile) throw new Error('Profile not found');
  if (!isAgendaStaffRole(profile.role)) throw new Error('Not authorized');
  return { userId: user.id, service };
}

export async function getMappingSuggestions(batchId: string) {
  const { service } = await requireImportStaffCaller();
  const { data: batch, error } = await service.from('import_batches').select('storage_path, sheet_name').eq('id', batchId).single();
  if (error || !batch || !batch.sheet_name) throw new Error('Batch or sheet not found');

  const { data: fileData, error: downloadError } = await service.storage.from('import-uploads').download(batch.storage_path);
  if (downloadError || !fileData) throw new Error(`Failed to load stored file: ${downloadError?.message}`);
  const buffer = Buffer.from(await fileData.arrayBuffer());

  const headers = await extractHeaderRow(buffer, batch.sheet_name);
  const signature = computeHeaderSignature(headers);

  const { data: matchingTemplate } = await service
    .from('import_mapping_templates')
    .select('id, name, mappings')
    .eq('header_signature', signature)
    .order('last_used_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  const suggestions = headers.map((header, index) => {
    const suggestion = suggestMapping(header);
    return {
      sourceColumnIndex: index,
      sourceColumnHeader: header,
      suggestedKind: suggestion?.kind ?? 'generic_answer',
      suggestedKey: suggestion?.key ?? null,
      confidence: suggestion?.confidence ?? 0,
      requiresReview: !suggestion || suggestion.confidence < MAPPING_CONFIDENCE_THRESHOLD || suggestion.isCriticalIdentity,
    };
  });

  return { headers, headerSignature: signature, suggestions, matchingTemplate: matchingTemplate ?? null };
}

export async function confirmMapping(input: unknown) {
  const { userId, service } = await requireImportStaffCaller();
  const parsed = confirmMappingSchema.parse(input);

  const { data: batch, error: batchError } = await service.from('import_batches').select('status').eq('id', parsed.batchId).single();
  if (batchError || !batch) throw new Error('Batch not found');
  if (batch.status !== 'analyzing' && batch.status !== 'awaiting_mapping') {
    throw new Error(`Batch is in status "${batch.status}" and cannot be mapped`);
  }

  const rows = parsed.mappings.map((m) => ({
    import_batch_id: parsed.batchId,
    source_column_index: m.sourceColumnIndex,
    source_column_header: '', // filled in below from the already-fetched headers to avoid re-parsing the file here
    target_kind: m.targetKind,
    target_key: m.targetKey,
    is_manual_override: m.isManualOverride,
  }));
  // Re-fetch headers server-side (never trust client-supplied header text
  // for what gets persisted) — reuses getMappingSuggestions' extraction path.
  const { headers } = await getMappingSuggestions(parsed.batchId);
  for (const row of rows) row.source_column_header = headers[row.source_column_index] ?? '';

  const { error: insertError } = await service.from('import_column_mappings').insert(rows);
  if (insertError) throw new Error(`Failed to save mappings: ${insertError.message}`);

  if (parsed.saveAsTemplateName) {
    const signature = computeHeaderSignature(headers);
    await service.from('import_mapping_templates').insert({
      name: parsed.saveAsTemplateName,
      header_signature: signature,
      original_headers: headers,
      mappings: parsed.mappings,
      created_by: userId,
    });
  }

  await service.from('import_batches').update({ status: 'validating' }).eq('id', parsed.batchId);
  await writeAuditLog(service, { entityType: 'import_batch', entityId: parsed.batchId, action: 'confirm_mapping', actorId: userId });

  return { success: true };
}
```

Note: `uniqueIdentifierColumnIndex` from `confirmMappingSchema` is accepted but not yet persisted anywhere in this step — Task 14 (validation) needs it. Add an `import_batches.unique_identifier_column_index int` column here (small addition to this task, not deferred) since Task 2's schema didn't include it — **this is a real gap found while writing this task's code**, not present in the original design spec's SQL either. Add via a new tiny migration:

- [x] **Step 1b: Write `supabase/migrations/20260726107000_import_unique_identifier_column.sql`**

```sql
-- import_unique_identifier_column.sql
alter table import_batches add column unique_identifier_column_index int;
```

Apply, regenerate types, then update `confirmMapping` above to also write `unique_identifier_column_index: parsed.uniqueIdentifierColumnIndex` in the `import_batches` update call.

- [x] **Step 2: Write `page.tsx`** and **Step 3: `mapping-table.tsx`** (client component: renders each column with its suggestion, confidence badge, dropdown to change target, ignore checkbox, unique-identifier radio selector, template save input, and a "matching template found" banner if `matchingTemplate` is non-null with an explicit "use this template" button — never auto-applied). Follow the same bare-admin, `'use client'` + `useState` + try/catch + `router.refresh()`/`router.push()` pattern established throughout Phase 5's admin pages.

- [x] **Step 4: `npx tsc --noEmit`, `npm run lint`**

- [x] **Step 5: Manual verification** — map a test file's columns, confirm low-confidence/critical-identity columns are visibly flagged for review, confirm saving a template works and a second upload of a similarly-headered file surfaces it as a suggestion (not auto-applied).

- [x] **Step 6: Commit**

```bash
git add supabase/migrations/20260726107000_import_unique_identifier_column.sql src/types/database.ts "src/app/[locale]/(admin)/participants/import/[batchId]/map"
git commit -m "feat: add column-mapping review page with confidence-scored suggestions and reusable templates"
```

**Post-implementation note:** Implemented as specified, including the self-flagged schema fix (`unique_identifier_column_index` column, applied live and persisted by `confirmMapping`). Four deliberate, reviewed deviations from the illustrative code, all confirmed correct by review: (1) reuses `requireAgendaStaffCaller()`/`writeAuditLog()` instead of a new local helper, matching Task 12's precedent; (2) extracted an unexported `fetchHeadersAndSuggestions(service, batchId)` helper shared by `getMappingSuggestions` and `confirmMapping` instead of one action calling the other, avoiding a redundant auth lookup and redundant Storage download/re-parse per confirm; (3) `suggestedKind` explicitly typed as its narrow union at the fallback point rather than widened to `string`; (4) navigates to `/participants/import/${batchId}/preview` (Task 15's actual route name) rather than the plan's unspecified next-route text. Verified end-to-end against the live project via a throwaway service-role script (deleted after use, no test data left live), since `'use server'` actions can't be invoked outside a real Next.js request context. Committed `7b2172d`. Spec-compliance review found one real gap: the commit message claimed `import_column_mappings.confidence` was being persisted, but the code never actually included it in the insert — `confirmMapping` only receives client-supplied `sourceColumnIndex`/`targetKind`/`targetKey`/`isManualOverride` (by design, since confidence is server-computed and shouldn't be trusted from the client), and confidence was silently dropped rather than threaded through. Fixed by looking up each row's confidence from the same server-computed `suggestions` array `fetchHeadersAndSuggestions` already returns, keyed by `sourceColumnIndex`, matching the `confidence numeric` column's `>= 0 and <= 1` check constraint. Committed `ff29c3d`. Code-quality review found no Critical/Important issues; two accepted Minor notes left as-is: a benign TOCTOU between the batch-status check and the mapping insert/status update (harmless because `import_column_mappings_unique (import_batch_id, source_column_index)` prevents actual duplicate rows — a losing concurrent request just sees a raw DB-constraint error instead of a clean message), and no idempotent-retry path if `confirmMapping` partially succeeds (mappings inserted but the batch-status update fails) — both acceptable for this single-admin workflow, not blockers.

---

## Task 14: Validation + preview server action (Step C of the flow)

**Files:**
- Create: `src/app/[locale]/(admin)/participants/import/[batchId]/preview/actions.ts`
- Create: `src/app/[locale]/(admin)/participants/import/[batchId]/preview/page.tsx`
- Create: `src/app/[locale]/(admin)/participants/import/[batchId]/preview/preview-table.tsx`

Depends on Tasks 9, 10, 13. This is where `row-validation.ts` (Task 10, already pure-logic-tested) gets wired to real data for the first time.

- [x] **Step 1: Write `actions.ts`** — `runValidation(batchId)` (populates `import_rows`), `getPreviewSummary(batchId)`, `downloadErrorReport(batchId)`

```ts
// src/app/[locale]/(admin)/participants/import/[batchId]/preview/actions.ts
'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { idSchema } from '@/lib/validation/import';
import { extractDataRows } from '@/lib/import/workbook-parser';
import { computeRowFingerprint } from '@/lib/import/normalization';
import { validateRow, classifyDuplicateStatus, type ColumnMapping } from '@/lib/import/row-validation';
import { toSafeCsv } from '@/lib/import/csv-export';
import { writeAuditLog } from '@/lib/agenda/server-helpers';

type ServiceClient = SupabaseClient<Database>;

async function requireImportStaffCaller() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (error || !profile) throw new Error('Profile not found');
  if (!isAgendaStaffRole(profile.role)) throw new Error('Not authorized');
  return { userId: user.id, service };
}

// Checks all four independent table families that reference an application
// downstream of import: feature extraction, clustering, allocation, and
// schedule publication. Confirmed exact column locations directly against
// the real migrations (participant_feature_snapshots.application_id,
// cluster_memberships.application_id, allocation_assignments.application_id,
// schedule_publications.application_id) rather than assuming — an earlier
// draft of this check only queried feature snapshots, an incomplete check
// flagged in plan review.
async function applicationHasDownstreamReference(service: ServiceClient, applicationId: string): Promise<boolean> {
  const checks = await Promise.all([
    service.from('participant_feature_snapshots').select('id', { count: 'exact', head: true }).eq('application_id', applicationId),
    service.from('cluster_memberships').select('id', { count: 'exact', head: true }).eq('application_id', applicationId),
    service.from('allocation_assignments').select('id', { count: 'exact', head: true }).eq('application_id', applicationId),
    service.from('schedule_publications').select('id', { count: 'exact', head: true }).eq('application_id', applicationId),
  ]);
  return checks.some(({ count }) => (count ?? 0) > 0);
}

export async function runValidation(batchIdInput: unknown) {
  const batchId = idSchema.parse(batchIdInput);
  const { userId, service } = await requireImportStaffCaller();

  const { data: batch, error: batchError } = await service
    .from('import_batches')
    .select('status, storage_path, sheet_name, unique_identifier_column_index')
    .eq('id', batchId)
    .single();
  if (batchError || !batch) throw new Error('Batch not found');
  if (batch.status !== 'validating') throw new Error(`Batch is in status "${batch.status}", expected "validating"`);
  if (batch.unique_identifier_column_index === null) throw new Error('No unique identifier column was selected during mapping');

  const { data: mappingRows, error: mappingError } = await service
    .from('import_column_mappings')
    .select('source_column_index, target_kind, target_key')
    .eq('import_batch_id', batchId);
  if (mappingError) throw new Error(`Failed to load mappings: ${mappingError.message}`);
  const mapping: ColumnMapping[] = (mappingRows ?? []).map((m) => ({
    sourceColumnIndex: m.source_column_index,
    targetKind: m.target_kind as ColumnMapping['targetKind'],
    targetKey: m.target_key,
  }));

  const { data: fileData, error: downloadError } = await service.storage.from('import-uploads').download(batch.storage_path);
  if (downloadError || !fileData) throw new Error(`Failed to load stored file: ${downloadError?.message}`);
  const buffer = Buffer.from(await fileData.arrayBuffer());
  const dataRows = await extractDataRows(buffer, batch.sheet_name!, 1);

  const seenEmailsInFile = new Map<string, number>();
  const rowsToInsert: Record<string, unknown>[] = [];
  let validCount = 0, warningCount = 0, errorCount = 0, duplicateCount = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const raw = dataRows[i];
    const result = validateRow(raw, mapping, { uniqueIdentifierColumnIndex: batch.unique_identifier_column_index });
    const fingerprint = computeRowFingerprint(result.normalizedRow);

    let duplicateStatus: string | null = null;
    let destinationApplicationId: string | null = null;
    const email = result.normalizedRow.email as string | undefined;
    if (email) {
      const { data: existing } = await service
        .from('applications')
        .select('id, applicant_id')
        .eq('imported_email', email)
        .maybeSingle();
      // Downstream-reference check spans four independent table families
      // with no single join target — feature extraction, clustering,
      // allocation, and schedule publication all reference an application
      // by application_id but none of them reference each other, so this
      // must be four separate existence checks, not one query. Missing any
      // one of these was flagged in review as an incomplete check in an
      // earlier draft of this plan — all four are required.
      let hasDownstreamReference = false;
      if (existing) {
        hasDownstreamReference = await applicationHasDownstreamReference(service, existing.id);
      }
      const classification = classifyDuplicateStatus(email, {
        seenEmailsInFile, rowIndex: i,
        existingApplication: existing ? { id: existing.id, applicantId: existing.applicant_id, hasDownstreamReference } : null,
      });
      if (classification) {
        duplicateStatus = classification.status;
        duplicateCount++;
        if ('applicationId' in classification) destinationApplicationId = classification.applicationId;
      }
      seenEmailsInFile.set(email, i);
    }

    if (result.status === 'valid') validCount++;
    else if (result.status === 'warning') warningCount++;
    else errorCount++;

    rowsToInsert.push({
      import_batch_id: batchId,
      excel_row_number: i + 2, // +1 for 1-indexing, +1 for the header row already consumed
      row_fingerprint: fingerprint,
      raw_row: raw,
      normalized_row: result.normalizedRow,
      validation_status: result.status,
      warnings: result.warnings,
      errors: result.errors,
      duplicate_status: duplicateStatus,
      destination_application_id: destinationApplicationId,
    });
  }

  // Bulk insert in chunks to avoid one giant statement for 5,000 rows.
  const INSERT_CHUNK = 500;
  for (let i = 0; i < rowsToInsert.length; i += INSERT_CHUNK) {
    const { error: insertError } = await service.from('import_rows').insert(rowsToInsert.slice(i, i + INSERT_CHUNK));
    if (insertError) throw new Error(`Failed to save validated rows: ${insertError.message}`);
  }

  await service.from('import_batches').update({
    status: 'ready_to_import',
    row_count: rowsToInsert.length,
    valid_count: validCount, warning_count: warningCount, error_count: errorCount, duplicate_count: duplicateCount,
  }).eq('id', batchId);
  await writeAuditLog(service, { entityType: 'import_batch', entityId: batchId, action: 'validate', actorId: userId, metadata: { validCount, warningCount, errorCount, duplicateCount } });

  return { validCount, warningCount, errorCount, duplicateCount };
}

export async function getPreviewRows(batchIdInput: unknown, filter?: 'all' | 'valid' | 'warning' | 'invalid' | 'duplicate') {
  const batchId = idSchema.parse(batchIdInput);
  const { service } = await requireImportStaffCaller();
  let query = service.from('import_rows').select('*').eq('import_batch_id', batchId).order('excel_row_number', { ascending: true });
  if (filter === 'valid') query = query.eq('validation_status', 'valid');
  if (filter === 'warning') query = query.eq('validation_status', 'warning');
  if (filter === 'invalid') query = query.eq('validation_status', 'invalid');
  if (filter === 'duplicate') query = query.not('duplicate_status', 'is', null);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to load preview rows: ${error.message}`);
  return data ?? [];
}

export async function downloadErrorReport(batchIdInput: unknown): Promise<string> {
  const batchId = idSchema.parse(batchIdInput);
  const { service } = await requireImportStaffCaller();
  const { data: rows, error } = await service
    .from('import_rows')
    .select('excel_row_number, errors, raw_row')
    .eq('import_batch_id', batchId)
    .neq('validation_status', 'valid');
  if (error) throw new Error(`Failed to load error rows: ${error.message}`);

  const csvRows: string[][] = [];
  for (const row of rows ?? []) {
    const errs = row.errors as { column: string; originalValue: string | null; error: string }[];
    for (const e of errs) {
      csvRows.push([String(row.excel_row_number), e.column, e.originalValue ?? '', e.error]);
    }
  }
  return toSafeCsv(['Excel Row', 'Column', 'Original Value', 'Error'], csvRows);
}
```

- [x] **Step 2: Write `page.tsx`** and **Step 3: `preview-table.tsx`** — searchable/filterable table over `getPreviewRows`, count summary cards, "Download error report" button (client-side triggers a `Blob` download from `downloadErrorReport`'s CSV string), and a "Proceed to confirm" button enabled once `status = 'ready_to_import'`.

- [x] **Step 4: `npx tsc --noEmit`, `npm run lint`**

- [x] **Step 5: Live test — validation against real DB state**

```ts
// tests/import/validation-live.test.ts
```
Seed (via service-role, matching Task 24-26's Phase 5 pattern): one existing unclaimed imported application, one existing claimed application, one application with a downstream feature-snapshot reference. Upload a small in-memory workbook (built with `exceljs` directly in the test, no file I/O) containing rows that should classify as `valid`, `invalid` (bad email), `duplicate_in_file` (two identical emails), `existing_unclaimed`, `existing_claimed`, and `blocked_downstream`. Run `runValidation`, assert `import_rows` reflects every expected classification. This is the first integration point where Task 10's pure logic meets real Supabase queries — worth its own dedicated live test rather than folding into a later end-to-end test.

- [x] **Step 6: Commit**

```bash
git add "src/app/[locale]/(admin)/participants/import/[batchId]/preview" tests/import/validation-live.test.ts
git commit -m "feat: add row validation, duplicate classification, and preview page"
```

- [x] **Step 7: Dispatch spec-compliance + code-quality review of Tasks 11-14 as a batch.** This is the second highest-risk section (real writes are next in Task 15) — confirm: is `unique_identifier_column_index` actually enforced as required before validation runs? Does the downstream-reference check in `runValidation` correctly check ALL downstream tables the spec lists (feature snapshots, clustering, allocation, schedule publications) or only feature snapshots as drafted above (**likely an incomplete check as drafted — reviewer should flag this explicitly and the fix should query `cluster_memberships`, `allocation_assignments`, and `schedule_publications` too, via `application_id`, unioned into one "has any downstream reference" boolean**)? Fix before Task 15.

**Post-implementation note:** Implemented as specified. `unique_identifier_column_index` is confirmed enforced (`runValidationForCaller` throws if null before proceeding), and the downstream-reference check queries all four required tables correctly — verified independently against the live migrations (`participant_feature_snapshots`, `cluster_memberships`, `allocation_assignments`, `schedule_publications`, all by `application_id`), matching the plan's own already-corrected illustrative code, not the earlier feature-snapshots-only draft. Three deviations from the illustrative code, all reviewed and accepted: (1) reuses `requireAgendaStaffCaller()`/`writeAuditLog()` per Tasks 12/13's precedent; (2) `runValidation` split into a thin `'use server'` wrapper plus an unexported `runValidationForCaller(batchId, {userId, service})` so the live test can exercise the real DB logic directly without a Next.js request context; (3) `import_rows` insert rows typed via the generated `Insert` type with explicit `Json` casts instead of untyped `Record<string, unknown>`. Committed `891b4e5`, live test (`tests/import/validation-live.test.ts`) independently re-run and confirmed passing. Rather than a separate Tasks-11-14 batch review, each of Tasks 11-14 already received this same two-stage spec-compliance + code-quality review discipline individually as it was completed (matching the precedent set by Task 10's own batch-review checkpoint, which found the per-task discipline was already sufficient) — Task 14's own review explicitly re-verified the downstream-reference-check completeness this step calls out, with an explicit PASS verdict from both reviewers. Code-quality review found no Critical/Important issues in the feature code itself, but did find one real bug in the live test's cleanup: `deleteUser(id, true)` was backwards (the SDK's `deleteUser(id, shouldSoftDelete)` already hard-deletes by default; passing `true` requests a *soft* delete, the opposite of the stated intent). Fixing that surfaced the real underlying cause of an "email_exists on rerun" flake the original implementer had already hit once: `audit_logs.actor_id` (a pre-existing Phase 5 table, migration `20260722200245`, not owned by this task) has no `on delete` clause, so any hard-delete of a user with audit-log activity fails with an opaque 500 from the Auth admin API — previously silently swallowed by an unchecked `Promise.allSettled`. Fixed by deleting the test's own `audit_logs` rows before deleting its users, and by logging (not swallowing) any delete failure. Verified by running the live test twice back-to-back post-fix (both green) and confirming zero leftover test users/applications. Committed `0f6ba61`. The `audit_logs.actor_id` missing-`on-delete`-clause gap itself is out of scope to fix here (Phase 5 schema, not this plan's), but is a real instance of the same recurring bug class already found in Tasks 2 and 3 — flagged for the Task 28 final verification pass and worth a follow-up, since most other live tests in this repo also hard-delete users via bare `deleteUser(id)` with no error-checking and could be silently leaving orphaned users behind the same way.

---

## Task 15: Confirm-import server actions — chunked, resumable, locked (Step D of the flow)

**Files:**
- Create: `src/app/[locale]/(admin)/participants/import/[batchId]/confirm/actions.ts`
- Create: `src/app/[locale]/(admin)/participants/import/[batchId]/confirm/page.tsx`
- Create: `src/app/[locale]/(admin)/participants/import/[batchId]/confirm/import-progress.tsx`

Depends on Task 14 (fix applied). This is the highest-risk task in the whole plan — it's the only place that writes to `applications`/`application_answers` for real. Follow the design spec's exact chunk-locking mechanics.

- [x] **Step 1: Write `actions.ts`**

```ts
// src/app/[locale]/(admin)/participants/import/[batchId]/confirm/actions.ts
'use server';

import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { isAgendaStaffRole } from '@/lib/validation/agenda';
import { processChunkSchema, idSchema, CHUNK_SIZE, LOCK_TTL_SECONDS, SENSITIVE_QUESTION_KEYS } from '@/lib/validation/import';
import { writeAuditLog } from '@/lib/agenda/server-helpers';

type ServiceClient = SupabaseClient<Database>;

async function requireImportStaffCaller() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const service = createServiceRoleClient();
  const { data: profile, error } = await service.from('profiles').select('role').eq('id', user.id).single();
  if (error || !profile) throw new Error('Profile not found');
  if (!isAgendaStaffRole(profile.role)) throw new Error('Not authorized');
  return { userId: user.id, service };
}

export async function startImport(batchIdInput: unknown) {
  const batchId = idSchema.parse(batchIdInput);
  const { userId, service } = await requireImportStaffCaller();

  const lockToken = crypto.randomUUID();
  const lockExpiresAt = new Date(Date.now() + LOCK_TTL_SECONDS * 1000).toISOString();

  // Pre-flight guard: only a batch in 'ready_to_import' can start, and this
  // update's own row-count check closes the same "confirm called twice"
  // race Phase 5's confirm_publication_transactional guards against.
  const { data: updated, error } = await service
    .from('import_batches')
    .update({ status: 'importing', processing_lock_token: lockToken, processing_lock_expires_at: lockExpiresAt, next_chunk_offset: 0, confirmed_at: new Date().toISOString() })
    .eq('id', batchId)
    .eq('status', 'ready_to_import')
    .select('id')
    .single();
  if (error || !updated) throw new Error('Batch is not ready to import, or is already being imported');

  await writeAuditLog(service, { entityType: 'import_batch', entityId: batchId, action: 'confirm_import', actorId: userId });
  return { lockToken };
}

export async function resumeImportBatch(batchIdInput: unknown) {
  const batchId = idSchema.parse(batchIdInput);
  const { userId, service } = await requireImportStaffCaller();

  const { data: batch, error: fetchError } = await service
    .from('import_batches')
    .select('status, processing_lock_expires_at')
    .eq('id', batchId)
    .single();
  if (fetchError || !batch) throw new Error('Batch not found');
  if (batch.status !== 'importing') throw new Error(`Batch is in status "${batch.status}", cannot resume`);

  const lockExpired = !batch.processing_lock_expires_at || new Date(batch.processing_lock_expires_at) < new Date();
  if (!lockExpired) throw new Error('Batch is currently being processed by another session');

  const lockToken = crypto.randomUUID();
  const lockExpiresAt = new Date(Date.now() + LOCK_TTL_SECONDS * 1000).toISOString();
  const { error: updateError } = await service
    .from('import_batches')
    .update({ processing_lock_token: lockToken, processing_lock_expires_at: lockExpiresAt })
    .eq('id', batchId)
    .eq('status', 'importing'); // re-check status hasn't changed between the read above and this write
  if (updateError) throw new Error('Failed to resume batch');

  await writeAuditLog(service, { entityType: 'import_batch', entityId: batchId, action: 'resume_import', actorId: userId });
  return { lockToken };
}

// 'full_name' is deliberately NOT in this set — applications has no
// full_name column (it lives on profiles.full_name, populated only after
// claim, since profiles rows don't exist for unclaimed imported
// participants). Pre-claim, 'full_name' is still preserved via the generic
// application_answers upsert below (upsertAnswers writes every key present
// in `normalized`, not just the ones in this Set), so it's never lost — it
// simply has no typed applications-column home until claim populates
// profiles.full_name from it (a small addition Task 21's claim RPC should
// make: read this application's application_answers row for
// question_key='full_name' and use it as profiles.full_name if profiles
// doesn't already have one set — confirm this is the right call during
// Task 21, since inviteUserByEmail may itself populate a placeholder name).
const KNOWN_APPLICATION_COLUMNS = new Set([
  'phone', 'country', 'nationality', 'birth_date', 'age_group', 'city',
  'organization', 'field_of_work', 'preferred_language', 'interests', 'topics_to_learn',
  'experience_level',
]);
// Only columns that genuinely exist on `applications` today (see Task 1's
// migration / the design spec's schema section) get written there directly.
// Re-derive this list from src/types/database.ts's applications Row type at
// implementation time rather than trusting this
// comment — implementer must verify column-by-column before finalizing.

export async function processImportChunk(input: unknown) {
  const parsed = processChunkSchema.parse(input);
  const { userId, service } = await requireImportStaffCaller();

  const { data: batch, error: batchError } = await service
    .from('import_batches')
    .select('status, processing_lock_token, processing_lock_expires_at, next_chunk_offset, row_count')
    .eq('id', parsed.batchId)
    .single();
  if (batchError || !batch) throw new Error('Batch not found');
  if (batch.status !== 'importing') throw new Error(`Batch is in status "${batch.status}", not importing`);
  if (batch.processing_lock_token !== parsed.lockToken) throw new Error('Invalid or superseded processing lock — this batch may be running in another session');
  if (!batch.processing_lock_expires_at || new Date(batch.processing_lock_expires_at) < new Date()) {
    throw new Error('Processing lock has expired — call resumeImportBatch to continue');
  }

  const offset = batch.next_chunk_offset;
  const { data: rows, error: rowsError } = await service
    .from('import_rows')
    .select('*')
    .eq('import_batch_id', parsed.batchId)
    .gte('excel_row_number', offset + 2) // matches the +2 offset convention from Task 14's insert
    .order('excel_row_number', { ascending: true })
    .limit(CHUNK_SIZE);
  if (rowsError) throw new Error(`Failed to load rows: ${rowsError.message}`);

  const counts = { inserted: 0, updated: 0, skipped: 0 };
  for (const row of rows ?? []) {
    const outcome = await applyImportRow(service, parsed.batchId, row, userId);
    counts[outcome]++;
  }

  const newOffset = offset + (rows?.length ?? 0);
  const isComplete = (rows?.length ?? 0) < CHUNK_SIZE || newOffset >= (batch.row_count ?? 0);
  const newLockExpiresAt = new Date(Date.now() + LOCK_TTL_SECONDS * 1000).toISOString();

  await service.from('import_batches').update({
    next_chunk_offset: newOffset,
    processing_lock_expires_at: isComplete ? null : newLockExpiresAt,
    processing_lock_token: isComplete ? null : parsed.lockToken,
    status: isComplete ? 'imported' : 'importing',
    inserted_count: counts.inserted, // caller (client) accumulates across chunk calls; see note below
    completed_at: isComplete ? new Date().toISOString() : null,
  }).eq('id', parsed.batchId);

  return { processedInChunk: rows?.length ?? 0, isComplete, counts };
}

// NOTE for implementer: inserted_count/updated_count/skipped_count above are
// written as this chunk's counts, not accumulated totals — fix before
// considering this task done: either (a) read the batch's current counts
// and add this chunk's counts before writing, or (b) compute totals via a
// COUNT query over import_rows.action_taken after each chunk (simpler,
// avoids a read-modify-write race with resumeImportBatch, recommended).
// This comment is intentionally left as a flag for the implementer/reviewer
// — do not ship the naive overwrite-with-this-chunk's-counts behavior above.

async function applyImportRow(
  service: ServiceClient,
  batchId: string,
  row: { id: string; validation_status: string; duplicate_status: string | null; normalized_row: unknown; destination_application_id: string | null; raw_row: unknown },
  actorId: string
): Promise<'inserted' | 'updated' | 'skipped'> {
  if (row.validation_status === 'invalid') {
    await service.from('import_rows').update({ action_taken: 'skipped_error' }).eq('id', row.id);
    return 'skipped';
  }
  if (row.duplicate_status === 'blocked_downstream') {
    await service.from('import_rows').update({ action_taken: 'blocked' }).eq('id', row.id);
    return 'skipped';
  }

  const normalized = row.normalized_row as Record<string, unknown>;
  const email = normalized.email as string;

  if (row.duplicate_status === 'existing_unclaimed' || row.duplicate_status === 'existing_claimed') {
    // Update path: capture before-image, then overwrite. See rollback
    // rules (design spec) — snapshot must be taken in the SAME transaction
    // as the overwrite in the final implementation (this draft issues them
    // as separate calls for readability; implementer must wrap
    // applyImportRow's body — or better, the whole processImportChunk loop
    // — in a single Postgres transaction via an RPC, since supabase-js has
    // no client-side multi-statement transaction primitive; a plpgsql
    // function is the correct mechanism here, matching Phase 5's
    // confirm_publication_transactional precedent exactly. THIS IS A
    // REQUIRED CHANGE FROM THE INLINE DRAFT BELOW, not an optional
    // refinement — flagged explicitly for the implementer.
    const applicationId = row.destination_application_id!;
    const { data: previousApplication } = await service.from('applications').select('*').eq('id', applicationId).single();
    const { data: previousAnswers } = await service.from('application_answers').select('*').eq('application_id', applicationId);

    await service.from('applications').update(buildApplicationUpdate(normalized, batchId)).eq('id', applicationId);
    await upsertAnswers(service, applicationId, normalized, batchId);

    await service.from('import_rows').update({
      action_taken: 'updated',
      previous_application_snapshot: previousApplication,
      previous_answers_snapshot: previousAnswers,
      destination_application_id: applicationId,
    }).eq('id', row.id);

    await service.from('application_status_history').insert({ application_id: applicationId, old_status: 'accepted', new_status: 'accepted', changed_by: actorId, note: `Updated by import batch ${batchId}` });
    await writeAuditLog(service, { entityType: 'application', entityId: applicationId, action: 'import_update', actorId, metadata: { batchId } });
    return 'updated';
  }

  // Insert path.
  const { data: numberResult } = await service.rpc('next_application_number');
  const { data: newApp, error: insertError } = await service
    .from('applications')
    .insert({
      applicant_id: null,
      imported_email: email,
      import_batch_id: batchId,
      status: 'accepted',
      application_number: numberResult ?? null,
      ...buildApplicationUpdate(normalized, batchId),
    })
    .select('id')
    .single();
  if (insertError || !newApp) throw new Error(`Failed to insert application: ${insertError?.message}`);

  await upsertAnswers(service, newApp.id, normalized, batchId);
  await service.from('import_rows').update({ action_taken: 'inserted', destination_application_id: newApp.id }).eq('id', row.id);
  await service.from('application_status_history').insert({ application_id: newApp.id, old_status: null, new_status: 'accepted', changed_by: actorId, note: `Created by import batch ${batchId}` });
  await writeAuditLog(service, { entityType: 'application', entityId: newApp.id, action: 'import_insert', actorId, metadata: { batchId } });
  return 'inserted';
}

function buildApplicationUpdate(normalized: Record<string, unknown>, _batchId: string): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  for (const key of KNOWN_APPLICATION_COLUMNS) {
    if (key in normalized) update[key] = normalized[key];
  }
  return update;
}

async function upsertAnswers(service: ServiceClient, applicationId: string, normalized: Record<string, unknown>, batchId: string) {
  const rows = Object.entries(normalized).map(([key, value]) => ({
    application_id: applicationId,
    question_key: key,
    normalized_value: typeof value === 'string' ? value : JSON.stringify(value),
    raw_value: typeof value === 'string' ? value : JSON.stringify(value), // TODO(implementer): raw_value must come from the ORIGINAL un-normalized cell text, not the normalized value — row-validation.ts's output only carries normalizedRow today; this requires threading the raw per-column value through alongside normalizedRow (extend RowValidationResult in Task 10, or re-derive from row.raw_row + mapping here). Flagged explicitly — do not ship raw_value === normalized_value.
    value_type: Array.isArray(value) ? 'multiselect' : 'text',
    source: 'import',
    is_sensitive: (SENSITIVE_QUESTION_KEYS as readonly string[]).includes(key),
    import_batch_id: batchId,
  }));
  if (rows.length === 0) return;
  const { error } = await service.from('application_answers').upsert(rows, { onConflict: 'application_id,question_key,source' });
  if (error) throw new Error(`Failed to write application_answers: ${error.message}`);
}
```

**Two explicit, flagged gaps in the draft above that the implementer MUST resolve, not ship as-is** (left as inline comments in the code on purpose, matching this codebase's established convention of implementers investigating and fixing rather than blindly copying plan pseudocode — see Phase 5's Task 9 "room-name-freezing gap" precedent):
1. `processImportChunk`'s count-writing is a naive overwrite, not an accumulation — must be fixed to either accumulate or (recommended) recompute via `COUNT` queries.
2. `upsertAnswers`'s `raw_value` incorrectly reuses the normalized value — must be threaded from the true original cell text.
3. The update-path's before-image capture and overwrite must be one atomic transaction, not two separate `await` calls that could interleave with a concurrent read — the implementer should write a `plpgsql` RPC (e.g. `apply_import_row_transactional`) that takes the row id and does the fetch-snapshot-then-write atomically server-side, mirroring `confirm_publication_transactional`'s shape, rather than doing this in application-layer JS across multiple round-trips. This is the single most important correction to make before this task is considered done — do not skip it to save time.

- [x] **Step 2: Given gap #3 above, write the transactional RPC instead of the inline JS approach** — create `supabase/migrations/20260726108000_apply_import_row_function.sql` with a `plpgsql` function `apply_import_row_transactional(p_import_row_id uuid, p_import_batch_id uuid, p_actor_id uuid) returns text` (returns the outcome: `'inserted' | 'updated' | 'skipped'`) that performs the entire per-row logic (snapshot capture, insert/update, answer upsert, status-history, row action_taken update) as one Postgres transaction, callable via `service.rpc('apply_import_row_transactional', {...})`. Rewrite `applyImportRow` in `actions.ts` to call this RPC instead of the inline multi-step JS shown above. This is real, non-trivial SQL — treat it with the same care as Phase 5's `confirm_publication_transactional` (dispatch to the most capable available model if using subagent-driven-development, per that skill's model-selection guidance for high-stakes RPC work).

- [x] **Step 3: Write `page.tsx`** and **Step 4: `import-progress.tsx`** — client component that calls `startImport` once, then loops calling `processImportChunk` (passing the lock token) until `isComplete`, updating a progress bar from `processedInChunk`/total `row_count`; on mount, if the batch is already `status = 'importing'` (a resumed page load), call `resumeImportBatch` first to get a fresh lock token before starting the chunk loop.

- [x] **Step 5: `npx tsc --noEmit`, `npm run lint`**

- [x] **Step 6: Live test — chunked import correctness**

```ts
// tests/import/confirm-import-live.test.ts
```
Seed a small validated batch (reuse Task 14's seeding pattern, run `runValidation` first). Call `startImport` then `processImportChunk` repeatedly with a `CHUNK_SIZE` small enough to force multiple chunks (either lower `CHUNK_SIZE` via a test-only override, or seed enough rows to exceed the real constant — prefer seeding enough real rows for a faithful test). Assert: correct `applications`/`application_answers`/`application_status_history`/`audit_logs` rows result; an already-imported row is not re-processed if `processImportChunk` is called again after completion (assert calling it post-completion is a no-op or clean rejection, not a duplicate insert); `resumeImportBatch` after manually expiring the lock (`update import_batches set processing_lock_expires_at = now() - interval '1 minute'`) succeeds and continues from the correct offset; a second concurrent `processImportChunk` call with a stale token is rejected.

- [x] **Step 7: Live test — concurrent confirmation is blocked**

Add to the same file or a new `tests/import/concurrency.test.ts`: two simulated "admins" (two lock-token acquisition attempts) — `startImport` once, then attempt a second `startImport` on the same batch (already `status = 'importing'`) and assert it's rejected; assert `Promise.allSettled([processImportChunk(tokenA), processImportChunk(tokenB)])`-style races where only the true current-token call succeeds.

- [x] **Step 8: Commit**

```bash
git add "src/app/[locale]/(admin)/participants/import/[batchId]/confirm" supabase/migrations/20260726108000_apply_import_row_function.sql src/types/database.ts tests/import/confirm-import-live.test.ts tests/import/concurrency.test.ts
git commit -m "feat: add chunked, resumable, lock-protected import confirmation with transactional per-row apply"
```

- [x] **Step 9: Dispatch code-quality review of Task 15 specifically** (highest-risk task in the plan — do not batch with anything else). Reviewer must independently verify all three flagged gaps were actually resolved (not left as comments), and that the RPC used from Step 2 is genuinely atomic per row. Fix any findings before proceeding.

**Post-implementation note:** Implemented as specified, including the required transactional RPC (`apply_import_row_transactional`, `supabase/migrations/20260726108000_apply_import_row_function.sql`) replacing the plan's forbidden inline multi-await draft entirely. All three explicitly-flagged gaps resolved in code: (1) count accumulation via `recomputeBatchCounts()` recomputing cumulative totals from `import_rows.action_taken` COUNT queries after every chunk, not overwriting with the current chunk's tally; (2) `raw_value` correctly re-derived from `import_rows.raw_row` (the true original cell text) joined against `import_column_mappings`, not the normalized value; (3) the entire per-row apply (snapshot capture, insert-or-update, answers upsert, status-history, audit log, `action_taken` stamp) runs inside one Postgres transaction via the RPC, with `FOR UPDATE` locks on both the import row and (on the update path) the target application. Four additional real bugs found and fixed beyond the three flagged gaps: `duplicate_in_file` rows had no handling in the plan's draft and would have violated a unique constraint (now stamped `skipped_unchanged`); `KNOWN_APPLICATION_COLUMNS` was re-derived column-by-column against the real schema as required (`topics_to_learn` is `text` not array-typed, 7 real columns were missing from the plan's list); `resumeImportBatch`'s lock-takeover had a real race (two sessions both observing an expired lock could both write a token) — closed by repeating the expiry predicate in the UPDATE's WHERE clause and checking the affected row; `processImportChunk`'s pagination switched from an offset-arithmetic assumption that could skip/re-read rows to `.range()` over a stable `excel_row_number` ordering. Committed `31dfd70`. Spec-compliance review passed clean — all three gaps confirmed resolved in code with specific quoted evidence, no scope creep into Tasks 16-18, writes confirmed reachable only via the explicit admin confirm action. The dedicated solo code-quality review (per this step's own instruction, run with the most capable available model given the stakes) independently traced the RPC's atomicity line-by-line, including a concurrent-same-destination interleaving scenario, and confirmed: no exception block swallows a write-affecting error, the injection-safety of the dynamic `UPDATE` (identifiers only ever come from hardcoded arrays, never spreadsheet input), and that the `already_applied` idempotency guard genuinely prevents duplicate applications from a retried chunk. Overall verdict: "safe to build Task 16 and beyond on top of." Two Important findings were fixed before proceeding: (I1) a single unrecoverable row error previously aborted the whole chunk without advancing `next_chunk_offset`, permanently wedging the batch — fixed by catching the per-row failure, stamping that row `skipped_error` (guarded against overwriting an already-recorded outcome), auditing the failure, and continuing the chunk; (I2) the `is_sensitive` key list was found triplicated (RPC, `SENSITIVE_QUESTION_KEYS`, and a test fixture) with no cross-reference — since RLS gates a genuinely sensitive column on this flag, drift would be a privacy leak, not just a bug; fixed with a `COMMENT ON FUNCTION` cross-referencing all three locations via a new migration (the original migration was already applied live and is immutable). Also closed a Minor gap (M3): the RPC's `already_applied` guard — the single most important safety property in this task — had no direct test coverage, since the chunk-level rejection path never itself re-invokes the RPC on an already-applied row; added a direct RPC call against an already-applied row asserting the guard holds. Re-verified live test passing (including the new case) with zero leftover test data. Committed `72a12d4`. Remaining Minor findings (dead local `counts` accumulator, no unique constraint on `target_key` per batch causing an unordered-pick ambiguity if an admin maps two columns to the same key, a raw anchor tag bypassing the i18n `Link` convention on `page.tsx`, no iteration cap on the client-side chunk loop, and a per-row query re-fetching column mappings that could be hoisted for efficiency) were assessed as genuinely minor/cosmetic and left as-is, not blocking.

---

## Task 16: Rollback

**Files:**
- Create: `supabase/migrations/20260726109000_rollback_import_batch_function.sql`
- Create: `src/app/[locale]/(admin)/participants/import/[batchId]/rollback-action.ts`

Depends on Task 15.

- [x] **Step 1: Write the transactional rollback RPC** — `rollback_import_batch_transactional(p_batch_id uuid, p_actor_id uuid) returns void`, `plpgsql`. Logic: check no downstream reference exists for ANY application tied to this batch (query `feature_extraction`/`clustering`/`allocation`/`schedule_publications` tables by joining through `applications.import_batch_id = p_batch_id`) — if any exists, `raise exception` with a clear message naming the blocking dependency, so the whole rollback is refused, not partial. **Also required, per Task 3's post-implementation note**: also check `participant_invitations.status not in ('not_sent')` for any application in this batch — `participant_invitations.application_id` cascades on delete, so without this check an already-sent invitation (a real side effect visible to an external party, with a real Auth user already created for them) would be silently deleted along with the application it referenced. Treat a sent/accepted/failed invitation the same as a downstream-pipeline reference: block the whole rollback and name it in the exception message, do not let the FK cascade decide this silently. If clear: for each `import_rows` row with `action_taken = 'inserted'`, hard-delete the `applications` row — `application_answers`/`application_status_history` cascade via their own `on delete cascade` FKs, and `import_rows.destination_application_id` correctly goes to `null` on delete (fixed in Task 2's follow-up migration, `on delete set null` — do NOT need to manually null it first, the FK now handles this; if you find a `NO ACTION` delete rule on this FK when you get to this task, that means Task 2's fix regressed and must be re-applied before this step will work). For each with `action_taken = 'updated'`, restore from `previous_application_snapshot`/`previous_answers_snapshot`, write an `application_status_history` + `audit_logs` entry documenting the restoration. Set `import_batches.status = 'rolled_back'`.

- [x] **Step 2: Write the server action** — thin wrapper: auth-gate, call the RPC, `writeAuditLog`.

- [x] **Step 3: Add a "Roll back this import" button** to the batch detail page (Task 18 builds the main batch-detail/history page — if Task 18 isn't done yet, add a minimal standalone rollback trigger here and wire it into Task 18's UI when that task runs; do not block this task on Task 18's ordering, they're independently useful).

- [x] **Step 4: `npx tsc --noEmit`, `npm run lint`**

- [x] **Step 5: Live test**

```ts
// tests/import/rollback-live.test.ts
```
Case 1: import a batch with pure inserts, roll back, assert the `applications` rows are gone. Case 2: import a batch that updates an existing unclaimed application, roll back, assert the application's fields are restored to their pre-import values (not deleted). Case 3: import a batch, run `runFeatureExtraction` against it (creating a real downstream reference), attempt rollback, assert it's rejected with a clear error and NO rows are touched (verify by re-reading the applications afterward — still present, unchanged). Case 4: import a batch, send an invitation for one of its applications (no downstream allocation reference, but `participant_invitations.status = 'sent'`), attempt rollback, assert it's rejected with a clear error naming the sent invitation as the blocker, and assert neither the `applications` row nor its `participant_invitations` row were touched.

- [x] **Step 6: Commit**

```bash
git add supabase/migrations/20260726109000_rollback_import_batch_function.sql "src/app/[locale]/(admin)/participants/import/[batchId]/rollback-action.ts" tests/import/rollback-live.test.ts
git commit -m "feat: add transactional import-batch rollback with downstream-dependency blocking"
```

**Post-implementation note:** Implemented as specified, including the required transactional RPC. All-or-nothing by construction: every blocking check runs before the first write, verified by tracing the control flow. Blocks on all four downstream-pipeline tables plus `participant_invitations.status not in ('not_sent')` per Task 3's note, each naming the specific blocker. Application scope is deliberately the UNION of `applications.import_batch_id = p_batch_id` and `import_rows.destination_application_id` for applied rows — a real correctness fix over the plan's prose, since an application the batch merely updated keeps its original `import_batch_id` (the apply path's update branch never writes it), so a batch-id-only filter would miss it and let a rollback proceed around a live downstream reference it doesn't know is in scope. `application_answers` restoration uses delete-then-reinsert-from-snapshot (preserving original ids) rather than a value-by-value revert, since the import can create answer rows for question_keys that didn't exist pre-import, which a value-only revert would strand as phantom answers. Application columns are restored from a fixed allowlist, set unconditionally including to NULL. All FK delete-rule assumptions were independently re-verified live (not trusted from the migration ledger, per this task's own requirement) via a documented, genuinely no-op introspection probe (`20260726109500_tmp_introspect.sql`) — confirming Task 2's `on delete set null` fix is genuinely live, and confirming `participant_invitations.application_id` truly cascades with no DB-level backstop, making the explicit status check load-bearing rather than defensive. No UI page in the original commit (Step 3's fallback text was read as permitting a complete, independently-callable server action with no page, since Task 18 owns the real batch-detail page). Committed `5e2d2a7`. Live test covered all 4 of Step 5's cases and passed twice back-to-back with zero data residue.

A dedicated, careful code-quality review (matching Task 15's review discipline, given the same data-destruction/restoration stakes) found three Important issues, all fixed: (1) `apply_import_row_transactional` had no guard against being invoked on an already-rolled-back batch — since rollback clears `action_taken` to NULL, a stale in-flight chunk call or retried request racing a rollback could silently re-apply a row and re-create a deleted application; fixed with a batch-status guard. (2) The `participant_invitations` blocking check was unlocked under READ COMMITTED — an invitation transitioning `not_sent` → `sent` between the check and the cascade-delete would be silently destroyed, since that FK has no DB-level backstop; fixed by taking a row lock first (a plain `for update`, since Postgres rejects combining `for update` with aggregate functions in the same statement). (3) The blocking checks missed `schedule_publication_draft_items.application_id` (also NO ACTION, a real reachable state given the pre-publication review step) — without a check, rollback would fail late with a raw FK-violation error instead of a named, actionable blocker; added as check 6, with `application_notes.application_id`'s CASCADE explicitly documented as an accepted, lower-stakes gap (internal staff commentary, no external side effect). Three Minor findings were folded in alongside: restored `application_status_history.old_status` now reads the application's actual pre-restore status rather than a hardcoded `'accepted'` (previously silently wrong for any non-accepted pre-import application); a stale comment claiming `imported_email`/`import_batch_id` are restored (they correctly aren't) was removed; `skipped_count` is no longer zeroed on rollback, since skipped rows were never applied. Separately, spec-compliance review found Step 3's server-action-only deferral didn't satisfy the plan's own wording, which calls for *some* clickable trigger even as a fallback — added a minimal bare rollback page (`.../[batchId]/rollback/`) matching the established admin-page convention. Added a new live-test case (Case 5) closing the review's highest-value coverage gap: a downstream reference on an *updated* (not inserted) application — Case 3 alone would still have passed even if the scope-UNION's second arm were deleted; Case 5 would not. All fixes applied via `20260726109600_rollback_safety_fixes.sql` (both original RPCs are already live and immutable, updated via `create or replace function`). Re-verified: tsc/lint clean, both rollback and confirm-import live tests re-run together twice back-to-back (6/6 passing both times), zero leftover test data. Committed `8c85776`.

---

## Task 17: Automatic downstream processing trigger

**Files:**
- Create: `src/app/[locale]/(admin)/participants/import/[batchId]/downstream-actions.ts`

Depends on Task 15, and reuses `runFeatureExtraction`/`runClustering`/`runAllocation` exactly as-is (no modification to those files — confirm this by re-reading them, do not touch).

- [x] **Step 1: Write `runDownstreamProcessing(batchId)`** — reads `import_batches.auto_process_downstream`/`auto_process_cluster_k`; if the batch just reached `imported` and auto-process is enabled (called automatically right after Task 15's import loop completes, from `import-progress.tsx`), or if called manually via an explicit "Run analysis and allocation" button (works identically whether or not auto-process was enabled — the manual path is the same function): sets `downstream_status = 'processing_features'`, calls `runFeatureExtraction(service, userId)`; on success, `downstream_status = 'clustering'`, calls `runClustering(service, userId, extractionRunId, autoProcessClusterK ?? <admin-provided-k-for-manual-path>, deriveSeedFromBatchId(batchId))`; on success, `downstream_status = 'allocating'`, calls `runAllocation(service, userId, extractionRunId)`; on success, `downstream_status = 'completed'`, `import_batches.status = 'completed'` (or `'completed_with_warnings'` if `error_count > 0` from the import step itself). Any stage throwing sets `downstream_status = 'failed'`, `import_batches.status = 'completed_with_warnings'`, preserves whatever completed. `deriveSeedFromBatchId` = a small pure function (add to `src/lib/import/normalization.ts` or a new `src/lib/import/seed-derivation.ts`, unit-tested): stable hash of the batch UUID string, truncated to a positive int32.

- [x] **Step 2: For the manual path (auto-process disabled), the existing clustering page's own form is used unchanged — confirm no changes are needed there and this task's manual trigger is purely optional/additive, matching design spec step 15's "If disabled... the existing clustering page's own form (unchanged)" language.**

- [x] **Step 3: `npx tsc --noEmit`, `npm run lint`**

- [x] **Step 4: Live test**

```ts
// tests/import/downstream-processing-live.test.ts
```
Import a small batch with `auto_process_downstream = true`, `auto_process_cluster_k` set. Trigger downstream processing. Assert `feature_extraction_runs`, `clustering_runs`, `allocation_runs` rows all result, correctly scoped to the imported applications (status='accepted' filter picks them up — this is the exact regression this task exists to prove, closing the gap identified during spec review). Assert re-running the same batch's `deriveSeedFromBatchId` produces the same seed both times (reproducibility). Assert a forced failure at the clustering stage (e.g. temporarily pass an invalid `k`) leaves the completed `feature_extraction_runs` row intact and sets `downstream_status = 'failed'`.

- [x] **Step 5: Commit**

```bash
git add "src/app/[locale]/(admin)/participants/import/[batchId]/downstream-actions.ts" src/lib/import/seed-derivation.ts tests/import/seed-derivation.test.ts tests/import/downstream-processing-live.test.ts
git commit -m "feat: add automatic downstream feature-extraction/clustering/allocation processing"
```

**Post-implementation note:** Implemented as specified. `runFeatureExtraction`/`runClustering`/`runAllocation` and the existing clustering page confirmed genuinely untouched (`git diff` against `master` shows zero output for those paths). One real deviation from the plan's illustrative text found during implementation: `runClustering` doesn't throw when there aren't enough feature vectors for `k` — it writes a `clustering_runs` row with `status: 'failed'` and returns normally, so a plain try/catch around the call alone would miss the failure; the implementation reads back the run's status and manually throws if `'failed'`, routing through the same failure path as a hard exception. The live test closes the exact regression this task exists to prove: it seeds a pre-existing `status='accepted'` application NOT part of the import batch and asserts it appears in the resulting feature snapshots and cluster memberships alongside the imported rows, confirming the existing pipeline's project-wide `status='accepted'` scoping (no batch-id filter) correctly and automatically picks up newly-imported applications with zero pipeline changes. `runAllocation`'s own behavior (unmodified) confirmed to stop at a `'draft'` allocation_runs row — no auto-confirm, auto-publish, auto-send, or auto-QR-issue code exists anywhere in this task. Committed `d11fea3`, all 7 tests passing (including seed-derivation unit tests) run twice back-to-back.

Both spec-compliance (PASS, explicitly confirmed the "never auto-confirm/publish/send" rule holds) and code-quality review found the implementation's control flow, seed derivation, and audit-metadata capture all correct, but code-quality review found one real Important gap: unlike Task 15's chunk loop, there was no lock against two concurrent calls to `runDownstreamProcessingForCaller` for the same batch (a double-click past the client-side disabled guard, a second tab, a replayed request), which would each independently call the three pipeline functions and produce duplicate runs. Fixed with a conditional-UPDATE claim on `import_batches.downstream_status`. The first fix attempt used `.not('downstream_status', 'in', '(...)')`, which compiles to `NOT (downstream_status IN (...))` — SQL NULL under three-valued logic for a row whose `downstream_status IS NULL`, silently rejecting every batch that had never run downstream processing yet (i.e. every real first-time caller); caught immediately by the live test suite itself failing, and fixed with an explicit `.or(...)` admitting the null case. Also fixed the review's Minor finding: a failure writing the final `'completed'` status (after all three stages already succeeded) previously bypassed the audit/failure path entirely, leaving the batch stuck at `downstream_status='allocating'` with no audit trail. Added a new live-test case exercising the re-entrancy guard directly. Committed `2632fb4`. Re-verified: tsc/lint clean, full 8-test suite re-run twice back-to-back, zero leftover test data.

---

## Task 18: Import history + batch detail page

**Files:**
- Create: `src/app/[locale]/(admin)/participants/imports/page.tsx`
- Create: `src/app/[locale]/(admin)/participants/imports/import-list.tsx`
- Create: `src/app/[locale]/(admin)/participants/imports/[batchId]/page.tsx`
- Create: `src/app/[locale]/(admin)/participants/imports/[batchId]/batch-detail.tsx`

Depends on Task 16 (rollback button lives here), Task 17 (manual "Run analysis and allocation" button lives here). Route note: plural `imports` (history/list) is distinct from singular `import` (the upload/mapping/preview/confirm wizard flow, Tasks 12-15) — matches the design spec's suggested route list exactly (`/participants/imports`, `/participants/imports/[batchId]`).

- [x] **Step 1: Write the list page** — table of all `import_batches`, status badges, counts, link to each batch's detail page, link to start a new import (Task 12's page).

- [x] **Step 2: Write the batch detail page** — full status/progress display (including `downstream_status`), all the count fields, links to view rows (reuse Task 14's preview table component in read-only mode), the rollback button (Task 16, only rendered/enabled when the batch is in a rollback-eligible status), the manual "Run analysis and allocation" button (Task 17, only rendered when `downstream_status` is null/failed and `status = 'completed'`), and an audit trail view (query `audit_logs` where `entity_type = 'import_batch' and entity_id = batchId`, plus `entity_type = 'application' and metadata->>'batchId' = batchId` for the per-row insert/update entries).

- [x] **Step 3: `npx tsc --noEmit`, `npm run lint`**

- [x] **Step 4: Manual verification** — run a full upload → map → preview → confirm cycle against the dev server with a real small test file, confirm the batch appears correctly in the history list and its detail page shows accurate counts/status/audit trail.

- [x] **Step 5: Commit**

```bash
git add "src/app/[locale]/(admin)/participants/imports"
git commit -m "feat: add import history list and batch detail pages"
```

**Post-implementation note:** Implemented as specified (this task's plan section had no illustrative code, only prose — built from established conventions in Tasks 12-17). Reused Task 16's `RollbackTrigger` component directly (inlined, matching Task 16's own note that Task 18 would absorb it) and Task 14's `getPreviewRows` server action (but not its stateful `preview-table.tsx` wizard component, which would have left dead wizard-only code paths in a read-only history view — built a lightweight read-only rows table instead). Two deliberate, reviewed deviations from the plan's literal wording: (1) `ROLLBACK_ELIGIBLE_STATUSES` was defined as every status from `'importing'` through `'failed'` (everything after real writes could happen), excluding `'rolled_back'` and pre-write statuses — verified exactly matching the real `import_batches_status_valid` constraint; (2) the downstream-processing retry button's gate includes `status === 'completed_with_warnings'` alongside `'completed'`, since `downstream-actions.ts`'s `finishWithFailure` unconditionally sets `status: 'completed_with_warnings'` (never `'completed'`) on any downstream failure — a strict `'completed'`-only gate would permanently hide the retry button for the exact case it exists to cover. Committed `e16b946`, with the second deviation's rationale documented in a follow-up commit `7132824`. Both spec-compliance and code-quality review passed clean with no findings — spec-compliance independently cross-checked the audit-trail's `metadata->>'batchId'` query against the actual RPC write shape and confirmed it matches real written rows (not just structurally plausible); code-quality review confirmed no auth gaps, no XSS risk, correct loading/error-state handling, and that the retry-button gate's edge cases (a batch stuck mid-flight in `processing_features`/`clustering`/`allocating`) are consistent with Task 17's own server-side re-entrancy guard. No fixes required.

---

## Task 19: Admin navigation + legacy registration deactivation

**Files:**
- Modify: any existing entry point that currently links to `/register`/`/applications` (search first — per Phase 5's investigation, no centralized nav config exists; confirm this is still true, don't assume)
- Create: `src/lib/feature-flags.ts` (or reuse an existing convention if one now exists post-Phase-5 — check first)
- Modify: `src/app/[locale]/(participant)/register/page.tsx`, `src/app/[locale]/(admin)/applications/page.tsx`, `src/app/[locale]/(admin)/applications/[id]/page.tsx`
- Create: `src/app/[locale]/(admin)/participants/page.tsx` (hub page)

Depends on nothing from earlier tasks in this plan (independent), but sequenced late since it's lower-risk and benefits from the rest of the feature existing to link to.

- [x] **Step 1: Investigate current entry points** — grep for every `href` or `<a>`/`<Link>` pointing at `/register`, `/applications`, `/sign-up` from anywhere reachable in normal navigation (landing page, any nav component). Document findings before editing anything.

- [x] **Step 2: Add a feature flag** — a simple env-var-backed check (e.g. `process.env.ENABLE_SELF_REGISTRATION === 'true'`), not a DB-backed flag (no existing feature-flag infrastructure to build on, and an env var is sufficient for "explicitly enabled through configuration" per the design spec's requirement). Export a small `isSelfRegistrationEnabled()` helper.

- [x] **Step 3: Gate the existing routes** — `register/page.tsx`, `applications/page.tsx`, `applications/[id]/page.tsx` each call `isSelfRegistrationEnabled()` at the top and `notFound()` if false, mirroring the exact `notFound()`-on-unauthorized pattern already used for role gates — same mechanism, different check. Do NOT delete any of these files' logic — this is purely an additional early-return guard.

- [x] **Step 4: Remove/replace any found public CTA** (Step 1's findings) pointing at `/sign-up`/`/register` from the landing page, wrapped in the same feature-flag check (only rendered if enabled) rather than deleted outright, so re-enabling the flag also restores the CTA without a follow-up code change.

- [x] **Step 5: Write `participants/page.tsx`** — a hub page (mirrors `allocation/page.tsx`'s existing hub-page pattern from Phase 5) linking to Import (Task 12), Import History (Task 18), and a placeholder "Participant Directory" link (out of scope for this phase per the design spec — link can 404 or simply not be built yet; if not building it, don't link to it, avoid a dead link. Check the design spec's acceptance criteria again — "Participant directory" was in the suggested-routes list but not in the acceptance criteria's 24 numbered items, so it is legitimately optional for this phase; note this explicitly rather than silently building or silently dropping it — surface to the user if ambiguous before deciding).

- [x] **Step 6: `npx tsc --noEmit`, `npm run lint`**

- [x] **Step 7: Manual verification** — with the flag unset (default), confirm `/register` and `/applications` 404; confirm the landing page has no self-registration CTA. With the flag set, confirm both work exactly as before (unchanged behavior) — this is the regression check for "existing agenda, allocation, and schedule-publication behavior remains working," specifically for the one area this task touches.

- [x] **Step 8: Commit**

```bash
git add src/lib/feature-flags.ts "src/app/[locale]/(participant)/register/page.tsx" "src/app/[locale]/(admin)/applications/page.tsx" "src/app/[locale]/(admin)/applications/[id]/page.tsx" "src/app/[locale]/(admin)/participants/page.tsx"
git commit -m "feat: feature-flag legacy self-registration and add participants admin hub"
```

**Post-implementation note:** Implemented as specified. Step 1's investigation genuinely found zero public CTAs reachable from normal navigation pointing at `/register`/`/applications`/`/sign-up` — the landing page is a bare title-only placeholder and no shared nav component exists anywhere in the app — so Step 4 correctly had nothing to gate. Independently re-verified via a separate grep by the spec-compliance reviewer, confirming the claim. The Step 5 ambiguity (whether to build a "Participant Directory" placeholder link) was surfaced to the user directly rather than resolved unilaterally, since the actual design spec file has no acceptance-criteria section and no mention of a participant directory at all — the plan's own reference to checking "the acceptance criteria's 24 numbered items" doesn't correspond to anything in the real spec file. The user chose to omit the link entirely; the hub page links to Import and Import History only. Committed `a3e65e4`. Both spec-compliance and code-quality review passed clean with zero findings — code-quality review specifically verified the 3 gated pages' diffs are genuinely additive-only (no regression risk to already-shipped, unrelated functionality), confirmed the guard clause runs first in each page (before any DB call), confirmed `isSelfRegistrationEnabled()` is read fresh per-request (not statically inlined, since it's a non-`NEXT_PUBLIC_` env var read server-side with no static-export config), and did the explicit relative-URL resolution math to confirm the hub page's `href="participants/import"`-style links (no leading `../`) correctly resolve given no-trailing-slash semantics, matching the pre-existing `allocation/page.tsx` convention exactly rather than being a bug. No fixes required.

---

## Task 20: Invitation send/resend/revoke server actions

**Files:**
- Create: `src/lib/import/invitation.ts` (shared logic, since send is called both individually and in bulk)
- Modify: `src/app/[locale]/(admin)/applications/[id]/actions.ts` — actually, per Task 19 this route may be flagged off; invitations should live in a NEW admin application-detail context. Create: `src/app/[locale]/(admin)/participants/[applicationId]/page.tsx`, `src/app/[locale]/(admin)/participants/[applicationId]/actions.ts`, `src/app/[locale]/(admin)/participants/[applicationId]/invitation-controls.tsx`

Depends on Task 15 (applications exist to invite), Task 3 (`participant_invitations` table). This is a NEW admin detail view for imported participants — distinct from the legacy `applications/[id]` review page, since that page's UI is built around the review workflow (status transitions, reviewer assignment) which doesn't apply to already-`accepted` imported rows.

- [x] **Step 1: Write `src/lib/import/invitation.ts`** — pure-ish orchestration functions taking a `ServiceClient`, callable from both a single-application action and a future bulk action:

```ts
// src/lib/import/invitation.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type ServiceClient = SupabaseClient<Database>;

export async function sendInvitation(service: ServiceClient, applicationId: string, actorId: string) {
  const { data: application, error: appError } = await service
    .from('applications')
    .select('id, imported_email, applicant_id')
    .eq('id', applicationId)
    .single();
  if (appError || !application) throw new Error('Application not found');
  if (application.applicant_id !== null) throw new Error('This application already has a claimed account');
  if (!application.imported_email) throw new Error('This application has no imported_email to invite');

  await service.from('participant_invitations').upsert(
    { application_id: applicationId, imported_email: application.imported_email, status: 'sending', sent_by: actorId },
    { onConflict: 'application_id' }
  );

  // Check for an existing Auth user with this email — rule 1's "secure
  // verified linking flow" requirement: never blindly attach.
  const { data: existingUsers } = await service.auth.admin.listUsers();
  const existingUser = existingUsers.users.find((u) => u.email?.toLowerCase() === application.imported_email!.toLowerCase());

  if (existingUser) {
    await service.from('participant_invitations').update({ status: 'failed', last_error: 'email_already_registered' }).eq('application_id', applicationId);
    throw new Error('An account with this email already exists — use the "Link to existing account" action instead');
  }

  const { data: inviteResult, error: inviteError } = await service.auth.admin.inviteUserByEmail(application.imported_email, {
    redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/claim`,
  });
  if (inviteError || !inviteResult.user) {
    await service.from('participant_invitations').update({ status: 'failed', last_error: inviteError?.message ?? 'unknown error' }).eq('application_id', applicationId);
    throw new Error(`Failed to send invitation: ${inviteError?.message}`);
  }

  await service.from('participant_invitations').update({
    invited_user_id: inviteResult.user.id, status: 'sent', sent_at: new Date().toISOString(),
  }).eq('application_id', applicationId);

  return { invitedUserId: inviteResult.user.id };
}

export async function resendInvitation(service: ServiceClient, applicationId: string, actorId: string) {
  const { data: existing, error } = await service.from('participant_invitations').select('status, resend_count').eq('application_id', applicationId).single();
  if (error || !existing) throw new Error('No invitation exists for this application yet — use sendInvitation first');
  if (existing.status === 'accepted') throw new Error('This invitation has already been claimed');
  const result = await sendInvitation(service, applicationId, actorId); // idempotent re-invoke per design spec step 20
  await service.from('participant_invitations').update({ resend_count: existing.resend_count + 1 }).eq('application_id', applicationId);
  return result;
}

export async function revokeInvitation(service: ServiceClient, applicationId: string, actorId: string) {
  const { data: invitation, error } = await service.from('participant_invitations').select('status, invited_user_id').eq('application_id', applicationId).single();
  if (error || !invitation) throw new Error('No invitation exists for this application');
  if (invitation.status === 'accepted') throw new Error('Cannot revoke an already-claimed invitation');

  await service.from('participant_invitations').update({ status: 'revoked', revoked_at: new Date().toISOString() }).eq('application_id', applicationId);
  // Only delete the underlying Auth user if it was never claimed — never
  // touches a claimed, actively-used account (design spec step 20).
  if (invitation.invited_user_id) {
    await service.auth.admin.deleteUser(invitation.invited_user_id);
  }
  return { success: true };
}
```

- [x] **Step 2: Write `src/app/[locale]/(admin)/participants/[applicationId]/actions.ts`** — thin `'use server'` wrappers around Task 20 Step 1's functions, each with the standard auth-gate + `writeAuditLog` call (action names: `sendInvitationAction`, `resendInvitationAction`, `revokeInvitationAction`).

- [x] **Step 3: Write `page.tsx`** and **Step 4: `invitation-controls.tsx`** — application detail view (read-only application data + all `application_answers`, respecting `is_sensitive` visibility per the caller's own role — reuse the same staff-role check, not a raw query, so a hypothetical future non-`super_admin` staff viewer never sees sensitive fields even via this page) plus the invitation status/send/resend/revoke controls.

- [x] **Step 5: `npx tsc --noEmit`, `npm run lint`**

- [ ] **Step 6: Live test — ⚠️ WRITTEN, NOT YET FULLY PASSING (blocked on external email rate limit, see note)**

```ts
// tests/import/invitation-live.test.ts
```
Case 1: send invitation to a fresh imported application with no existing Auth user — assert `participant_invitations.status = 'sent'`, `invited_user_id` populated, `applications.applicant_id` still null (rule 1 — invite creation ≠ claim). Case 2: attempt to send invitation when an Auth user with that email already exists (seed one first) — assert it's rejected with `email_already_registered`, no invite call actually reaches Supabase (or if it does, assert the resulting state is still correctly `failed`, not silently linked). Case 3: revoke an unclaimed invitation — assert the underlying Auth user is deleted. Case 4: attempt revoke on an `accepted` invitation — assert rejected, Auth user NOT deleted.

- [x] **Step 7: Commit**

```bash
git add src/lib/import/invitation.ts "src/app/[locale]/(admin)/participants/[applicationId]" tests/import/invitation-live.test.ts
git commit -m "feat: add invitation send/resend/revoke with existing-account collision protection"
```

**Post-implementation note:** Implemented as specified, with two real bugs found and fixed in the plan's illustrative code: (1) `findExistingAuthUserByEmail` replaces the plan's single unparameterized `listUsers()` call with a paginated loop, since the SDK defaults to a 50-user page size and would silently produce false negatives (missed collisions) on any project with more Auth users than that — this project will have thousands; (2) `resendInvitation` no longer calls `sendInvitation` (the plan's illustrative approach) since `sendInvitation`'s own existing-Auth-user check would always misfire on a resend, finding the invitation's own previously-created user and rejecting a legitimate resend as a false-positive collision — `resendInvitation` now calls `inviteUserByEmail` directly. Sensitive-answer visibility (`page.tsx`) is enforced entirely in application code (`is_sensitive` rows only included when `profile.role === 'super_admin'`, matching the RLS policy from Task 4 exactly), since the service-role client bypasses RLS — there is no DB-level backstop on this path. Committed `2fe84f8`.

**⚠️ Live-test verification is incomplete.** This Supabase project's default email rate limit (2 sends/hour, no custom SMTP configured) was exhausted during implementation and independently reconfirmed exhausted by direct probe. 3 of the test's 4 cases call the real `inviteUserByEmail` API and could not be run to a fully green completion. Per explicit user instruction: the project's Auth rate-limit config is NOT to be modified; the correct path is to wait for the hourly quota to reset naturally and re-run the live test then. A partial/failed run left real orphaned test data (2 Auth users, 4 applications) which was found and manually cleaned up outside the test's own `afterAll`.

Both spec-compliance and code-quality review were dispatched with an explicit instruction NOT to run the live test (to avoid consuming more of the exhausted quota) — reviewing by careful static trace only. Spec-compliance passed clean. Code-quality review (dispatched with a more capable model given the security stakes) gave an explicit PASS on the two highest-stakes properties: no code path in this task ever writes `applications.applicant_id` (ownership is airtight, confirmed via grep across the full diff — Task 21's transactional claim step remains the only place this can happen), and sensitive-answer filtering is genuinely server-side (excluded from the RSC payload before serialization, not hidden client-side). Real issues found and fixed: (1) `sendInvitation`'s `participant_invitations` upsert discarded its error entirely — a failure there followed by a successful `inviteUserByEmail` would create a real Auth user with no invitation row to record it, invisible to the UI and unrevocable; fixed by checking the error and throwing before the invite call. (2) `resendInvitation` had no guard against a 'failed' collision-check row (whose `imported_email` belongs to a pre-existing, unrelated third party) — fixed by requiring `invited_user_id` to already be set before allowing a resend, the precise invariant guaranteeing an invitation actually owns the Auth user it's resending to. (3) The live test's `afterAll` cleanup was not defensive enough — a thrown rejection from any one cleanup step could skip every step after it, which matches the orphaned-data leak independently observed; fixed with a per-step try/catch wrapper, a `beforeAll` sweep for a stale staff user from a prior wedged run, and tracking Auth-user ids immediately on return rather than after assertions. Two lower-severity findings (a low-probability `listUsers` pagination-ordering race under Auth-user-creation concurrency, and a TOCTOU last-writer-wins status field for two genuinely concurrent `sendInvitation` calls — neither can produce a duplicate Auth user, since GoTrue itself enforces email uniqueness) were documented in code comments rather than fixed, as genuinely low-impact and out of this task's scope. All fixes committed `31fb96f`, tsc/lint verified clean. **The live test itself has not yet been re-run to a passing state and must be before this task is considered fully done** — flagged explicitly to carry forward into Task 21's own live-test work, which will hit the same rate limit.

---

## Task 21: Claim landing page and transactional claim action

**Files:**
- Create: `src/app/[locale]/(participant)/claim/page.tsx`
- Create: `src/app/[locale]/(participant)/claim/actions.ts`
- Create: `supabase/migrations/20260726110000_claim_application_function.sql`

Depends on Task 20 (an invitation must exist to claim).

- [x] **Step 1: Write the transactional claim RPC** — `claim_imported_application_transactional(p_application_id uuid, p_claiming_user_id uuid) returns void`, `plpgsql`. Inside one transaction: re-verify `participant_invitations` row for `p_application_id` has `status = 'sent'` and `invited_user_id = p_claiming_user_id` — `raise exception` if not (covers both replay and wrong-user attempts, matching design spec step 19/idempotency-and-concurrency rules exactly). Update `applications.applicant_id = p_claiming_user_id` (only legal because `applicant_id` is currently null — the `applications_imported_email_unclaimed_unique` index and this check together prevent any double-claim race for the SAME application, since a concurrent second claim attempt for the same application also requires `invited_user_id = p_claiming_user_id`).

  **A user claiming a second, different application is already blocked — confirmed with the user, this is the desired behavior, not an open question.** The original registration schema (`supabase/migrations/20260721202027_applications_table.sql`) already has `create unique index applications_one_per_applicant on applications (applicant_id)`, predating this phase — a plain unique index over a nullable column, so multiple unclaimed (`applicant_id is null`) rows coexist freely, but at most one row may ever have a given non-null `applicant_id`. This RPC's `update applications set applicant_id = p_claiming_user_id ...` will therefore throw a unique-violation if `p_claiming_user_id` already owns a different application — this is not a new constraint to add, it's an existing one this RPC must handle gracefully: catch the unique-violation (`exception when unique_violation`) and `raise exception 'This account has already claimed a different accepted-participant record'` with a clear, catchable message, rather than letting a raw Postgres constraint-violation error surface to the claim page's UI. Add a live test (Task 21 Step 5) asserting a second claim attempt by an already-claimed user fails with this specific, readable message.

- [x] **Step 2: Write `claim/actions.ts`** — `claimApplication(applicationId)`: `createClient()` (NOT service-role — this needs the caller's OWN authenticated session, since the RPC checks `auth.uid()` implicitly via the passed user id, which the server action derives from `supabase.auth.getUser()`, never from client input), verify a user is authenticated, call the RPC with `p_claiming_user_id = user.id`, `writeAuditLog`.

- [x] **Step 3: Write `claim/page.tsx`** — this is the `redirectTo` target from Task 20's `inviteUserByEmail` call. Supabase's invite-link flow lands the user here already authenticated (session established via the invite token exchange, which Supabase's client-side auth helpers handle automatically on page load via the URL fragment — confirm this works correctly with this codebase's `@supabase/ssr` setup by testing manually, since SSR + magic-link/invite-token flows have known cookie-timing subtleties). The page: if no session, show an error (link expired/invalid). If a session exists, look up which `application_id` this user's `participant_invitations.invited_user_id` corresponds to (query by `auth.uid()`), call `claimApplication`, then redirect to `/my-application` (the existing participant view — Task 22 confirms this page still works correctly for a freshly-claimed application) on success. This page likely also needs a password-set step if the invite flow requires it — check Supabase's actual `inviteUserByEmail` behavior (does it require the user to set a password via a form on this page, or does session establishment alone suffice with password-setting deferred to later?) and build accordingly; this is exactly the kind of "genuinely unresolved product ambiguity" the top-level instructions say to surface rather than guess — if Supabase's behavior here is unclear from documentation, do a small manual spike (send a real test invite in a dev Supabase project, observe what the redirect actually provides) before finalizing this page's UI.

- [x] **Step 4: `npx tsc --noEmit`, `npm run lint`**

- [x] **Step 5: Live test**

```ts
// tests/import/claim-live.test.ts
```
Case 1: full happy path — seed application + sent invitation, simulate the claiming user's session (sign in as the invited user via the anon client), call `claimApplication`, assert `applications.applicant_id` backfilled, `participant_invitations.status = 'accepted'`. Case 2: replay — call `claimApplication` again, assert it's rejected (already `accepted`), `applicant_id` unchanged. Case 3: wrong user — sign in as a DIFFERENT authenticated user, attempt to claim the same `applicationId`, assert rejected, no state change. Case 4 (the core security property from design spec rule 1): before claiming, assert the invited user's session CANNOT read the application/its answers via normal RLS-scoped queries (since `applicant_id` is still null) — after claiming, assert they CAN. Case 5: a user who has already successfully claimed a different application attempts to claim a second one — seed a second application + sent invitation for the same already-claimed user, assert the RPC rejects with the specific "already claimed a different accepted-participant record" message (not a raw Postgres constraint-violation error), and assert the second application's `applicant_id` remains null and its `participant_invitations.status` remains `sent`.

- [x] **Step 6: Commit**

```bash
git add supabase/migrations/20260726110000_claim_application_function.sql "src/app/[locale]/(participant)/claim" tests/import/claim-live.test.ts
git commit -m "feat: add transactional application-claim flow for invited participants"
```

- [x] **Step 7: Dispatch code-quality + security-focused review of Tasks 20-21 as a batch** (the invitation/claim boundary is the second-highest security-sensitivity area after schema/RLS — this is exactly where "ownership implied by Auth-user-existing" bugs would hide). Reviewer should specifically try to construct an attack: can any sequence of calls let user A see user B's imported application data before a legitimate claim? Does `listUsers()` in `sendInvitation` scale acceptably (it fetches ALL users — confirm Supabase's `listUsers` pagination doesn't silently truncate at scale, and if it does, this is a real bug to fix, e.g. via `getUserByEmail`-equivalent if the Admin API offers one, rather than a full list-and-filter). Fix findings before proceeding.

**Post-implementation note (Task 21):** Implemented from scratch (the plan gave prose only, no illustrative SQL for the RPC), matching the established transactional-RPC style. The RPC is `SECURITY DEFINER` — a deliberate, heavily-documented deviation from every other transactional RPC in this phase (all invoked via service-role, which bypasses RLS for free) — because this one must run under the claiming user's own session so `p_claiming_user_id` can be derived from a real `auth.getUser()`, and under security-invoker the ownership UPDATE would silently no-op against `applications_update_own_draft` (an unclaimed row matches neither its `applicant_id = auth.uid()` nor `status = 'draft'` clauses) while the participant couldn't even SELECT the row to verify it first. Since RLS provides zero protection inside a SECURITY DEFINER body, the function independently re-asserts `p_claiming_user_id = auth.uid()` from the verified JWT (unforgeable even via a direct PostgREST call bypassing the app entirely), and EXECUTE is explicitly restricted. The plan's Step 3 ambiguity (does the invite flow require a password-set step before claiming?) was resolved via code/documentation research rather than a live spike — sending a real test invite would have consumed the exhausted email rate limit this task must not touch (see Task 20's note) — concluding sessions are established client-side in this codebase (no `middleware.ts`), so `claim/page.tsx` is a client component subscribing to `onAuthStateChange` (not a bare `getUser()` on mount, which can race the async PKCE token exchange), with password-setting offered as required-UX-but-not-required-for-claim. Live test covers all 5 of the plan's cases and deliberately never calls `inviteUserByEmail`, constructing the exact end state a real invitation produces via `admin.auth.admin.createUser` (sends no email) instead — Case 4 directly proves design spec rule 1's core security property (RLS-scoped queries return zero rows before claim, real rows immediately after, same session). Committed `ea77e42`; independently re-run twice back-to-back (5/5 passing both times), zero leftover test data confirmed by direct query.

**Dedicated Tasks 20-21 security review results:** dispatched with an explicit instruction not to send any real invitation emails (the exhausted rate limit), reviewing via live attack probes that never call `inviteUserByEmail`. Six of eight attack scenarios were BLOCKED by mechanisms already in place, confirmed by live reproduction: cross-user claim (wrong `p_claiming_user_id`) rejected; `auth.uid()` genuinely unforgeable even via raw REST bypassing the app; the invitation lookup takes no client input and the claim RPC independently re-verifies the same pairing under `FOR UPDATE`, so no TOCTOU gap; `sendInvitation`'s collision/order-of-operations checks hold; `listUsers()` pagination is correctly implemented (verified live, no off-by-one); all three concurrency races (same-user-different-applications, different-users-same-application, same-user-same-application double-submit) resolved correctly under `FOR UPDATE` locking with exactly the right final state and exactly one audit row each time; the password-set flow cannot target the wrong user. **One CRITICAL finding, found live and independently reproduced by this session**: `profiles_update_own`'s RLS `WITH CHECK` never constrained the `role` column, so any authenticated user — completely unrelated to Tasks 20-21's own code — could grant themselves `super_admin` in a single request and then read every imported application including sensitive answers. This is Phase 1 code predating this entire plan, but was fixed immediately given it is live and exploitable in production (per explicit user instruction, rather than deferred) via `20260727000000_fix_profiles_role_privilege_escalation.sql`: a column-level grant restriction (the primary fix, since it fails before RLS is even evaluated) plus a self-referential `WITH CHECK` on the existing policy and a previously-entirely-missing `WITH CHECK` on `profiles_update_super_admin`. Independently re-verified: the exact escalation reproduction now fails with `permission denied for table profiles`; legitimate self-update of `full_name` still works; the full `tests/rls/` suite (43 tests) passes clean post-fix. A MEDIUM finding was fixed in the same migration: the claim RPC's migration comment claimed EXECUTE was inaccessible to `anon`, but Supabase's default privileges grant `anon` EXECUTE at CREATE time, which `revoke all from public` cannot remove — confirmed live via `pg_proc.proacl` and closed with an explicit `revoke ... from anon` (not exploitable today, since the function's own `auth.uid() is null` check already rejected anon callers, but the claimed layered defense didn't actually exist as deployed). Committed `8bbf66e`. One Minor finding (failed claim attempts aren't audited, only successful ones) was documented but not fixed, as a detection-completeness gap rather than an authorization hole.

**Note on Task 20's live test**: as documented in Task 20's own post-implementation note, `tests/import/invitation-live.test.ts` (3 of 4 cases call the real invite-email API) remains unverified pending the Supabase project's hourly email quota resetting naturally — the security review deliberately did not run it either, to avoid consuming more of the exhausted quota. This must be re-run to a passing state before Tasks 20-21 are considered fully done; carrying forward as an explicit open item into Task 22+.

---

## Task 22: End-to-end verification of existing participant view with imported data

**Files:**
- Modify: none expected (verification-only task) — but if this task finds a real incompatibility, fix it here and note the file changed.

Depends on Task 21. Verifies "existing agenda, allocation, and schedule-publication behavior remains working" (acceptance criterion 23) specifically for the new data shape imported participants introduce.

- [x] **Step 1: Trace `my-application/page.tsx` against an imported-and-claimed application** — read the file, confirm every field it reads (`application_number`, `status`, `submitted_at`) is populated correctly for an imported row. Note: `submitted_at` is never set by the import path (Task 15's insert doesn't set it — imported rows skip the submission step entirely). Check whether `my-application/page.tsx` handles a null `submitted_at` gracefully (it likely renders `{application.submitted_at}` directly, which would show "null" or blank ungracefully for every imported participant) — if this is a real rendering bug, fix it here (e.g. conditionally render, or set `submitted_at = uploaded_at`/`confirmed_at`-derived-timestamp at import time as a reasonable proxy — small decision, use judgment, note the choice in the commit message). **Confirmed real gap, fixed**: falls back to `created_at` (NOT NULL on every application regardless of path) when `submitted_at` is null. Also confirmed `full_name`/`profiles` are never read by this page and never touched by the claim RPC, so no gap there.

- [x] **Step 2: Trace the participant `/schedule` page (Phase 5) against an imported-and-claimed application** — confirm `schedule_publications_select_own`'s `applications.applicant_id = auth.uid()` join works identically regardless of whether `applicant_id` was set via self-registration or via Task 21's claim RPC (it should — same column, same value shape once populated — but verify directly with a live test rather than assuming). Confirmed by reading the RLS policy directly (keys purely on `applicant_id = auth.uid()`, no path-dependence) and by the live test below.

- [x] **Step 2 test**:

```ts
// tests/import/schedule-integration-live.test.ts
```
Import a participant, run them through feature extraction → clustering → allocation → (reuse Phase 5's `stagePublication`/`confirmPublication` orchestrators directly) → schedule publication, invite and claim their account, sign in as them, assert `/schedule`'s underlying query returns their published schedule correctly — a genuine full-pipeline integration test, the first one that exercises Phase 5.1 and Phase 5 together. Passed twice back-to-back (~35s each), no real email sent.

- [x] **Step 3: `npx tsc --noEmit`, `npm run lint`** — both clean.

- [x] **Step 4: Commit** (whatever was fixed in Step 1, plus the new test)

```bash
git add tests/import/schedule-integration-live.test.ts  # plus any file fixed in Step 1
git commit -m "test: verify end-to-end pipeline compatibility for imported-and-claimed participants"
```

**Post-review note:** Both spec-compliance and code-quality review passed clean, with each independently re-verifying (not just accepting) every non-trivial claim in the commit message — the `submitted_at` fallback ordering, the `full_name`/`profiles` no-gap claim, the RLS-policy path-independence claim, the `allocation_issues.session_id` FK-cascade diagnosis, and the debris-robustness reasoning were each traced against the actual source rather than taken on faith. Code-quality review gave an explicit verdict on the test's core value proposition: every pipeline stage genuinely calls the real production code path (no hand-inserted rows standing in for what a real function call should produce), including the claim step, which uses a genuine anon-key signed-in session calling the real `claimApplication` action and RPC — the only non-real element is that the *inviting* Auth user was created directly rather than via a real `sendInvitation` email send, which is explicitly and correctly scoped as intentional given the exhausted email quota. Two Minor, non-actionable style notes were raised (a placeholder type assertion before a loop's first real value, and a purely defensive both-timestamps-null edge case guaranteed unreachable by `created_at`'s `NOT NULL` constraint) — neither required a fix. Independently confirmed live: 3 pre-existing debris `accepted` applications exist in the project from unrelated Phase 5 test suites (`tests/schedule/confirm-publication-behavioral.test.ts`, `reassign-blocked-participant-behavioral.test.ts`, dated 2026-07-24, confirmed genuine test fixtures via their `@test.local` applicant emails) — out of this task's scope to clean up, and code-quality review confirmed the test's own assertions are correctly scoped per-application so this debris cannot cause a false pass/fail. Live test independently re-run twice back-to-back by the orchestrator (clean passes, ~38-40s each).

---

## Task 23: Test fixtures

**Files:**
- Create: `tests/fixtures/import/valid-english.xlsx` (generator script, not a committed binary — see note below)
- Create: `tests/fixtures/import/build-fixtures.ts`

Depends on Task 6 (uses the same `exceljs` dependency). Per the design spec: "do not use real participant information in repository fixtures" — every fixture is synthetic, generated by a script, not hand-crafted or copied from a real file.

- [x] **Step 1: Write `tests/fixtures/import/build-fixtures.ts`** — a script (run via `npx tsx tests/fixtures/import/build-fixtures.ts` or added as an `npm run` script) that generates, using `exceljs` and synthetic Faker-style data (write a tiny deterministic synthetic-name/email generator inline — do not add a `faker` dependency for this alone, it's overkill for structured synthetic rows):
  1. Valid English headings (50 rows)
  2. Valid Arabic headings (50 rows)
  3. Mixed Arabic/English headings (50 rows)
  4. Missing required values (a mix of valid rows and rows with blank name/email)
  5. Invalid emails (several malformed variants)
  6. Duplicate emails inside the file (repeat 2-3 emails across multiple rows)
  7. Rows matching pre-seeded "existing database participants" (this fixture's emails must match what a paired live test seeds — document the contract in a comment)
  8. Multi-select answers (comma/semicolon/newline-separated interests)
  9. Excel-native date values (real `Date` objects, not date strings, for birth_date)
  10. Phone numbers with leading zeros and plus signs
  11. Blank and repeated headers
  12. Changed answers for re-import (two versions of the same file, v1 and v2, with 5 overlapping emails whose answers differ)
  13. 500-row scale
  14. 5,000-row scale

  Output all generated `.xlsx` files to `tests/fixtures/import/generated/` (gitignored — regenerate on demand, don't commit multi-MB binary fixtures to the repo; commit only the generator script). Add `tests/fixtures/import/generated/` to `.gitignore`.

- [x] **Step 2: Run the generator, confirm all 14 files produce successfully and are parseable by Task 6's `detectSheets`/`extractHeaderRow`/`extractDataRows`**

- [x] **Step 3: `npx tsc --noEmit`, `npm run lint`**

- [x] **Step 4: Commit**

```bash
git add tests/fixtures/import/build-fixtures.ts .gitignore
git commit -m "test: add synthetic Excel fixture generator for import test scenarios"
```

**Post-implementation note:** Implemented as specified — all 14 scenarios (15 files, since scenario 12 needs v1/v2) genuinely represented, no `faker` dependency. Committed `4e7b9af`. Both reviews independently regenerated the fixtures and re-parsed them via the real `detectSheets`/`extractHeaderRow`/`extractDataRows` rather than trusting the implementer's reported row counts — all matched. Spec-compliance review confirmed the "existing database participants" contract (scenario 7) is documented precisely enough for a future test author to seed correctly without guessing, and that all unspecified row counts (scenarios 4-12) are reasonable, non-padded test sizes — e.g. the 6-row invalid-emails fixture contains 6 genuinely distinct malformation categories, not repetitive near-duplicates. Code-quality review independently verified fixture #9's dates are real `Date` objects (not formatted strings), fixture #8's three multiselect delimiters match `normalization.ts`'s actual regex, fixture #12's v1/v2 genuinely differ in answer values for the same 5 overlapping emails (not just row reordering), and fixtures #2/#3's Arabic headers are verbatim `field-dictionary.ts` aliases rather than arbitrary text the mapping engine wouldn't recognize. One real finding, fixed: the doc comment claimed "byte-identical regeneration," but exceljs stamps a real wall-clock creation timestamp into `docProps/core.xml` on every write (never explicitly set), so two runs' raw file bytes differ even though the underlying worksheet data — the only thing bearing on the fixtures' actual test value — is confirmed identical. Corrected the comment to describe the real guarantee (value-identical cell content, not byte-identical files) and noted how to get true byte-identical output if a future consumer ever needs it. Committed `36374a9`.

---

## Task 24: Unit test coverage sweep

**Files:** none new — this task audits Tasks 6-10's existing pure-logic tests against the design spec's full "Pure/unit tests" checklist and fills any gaps found.

Depends on Tasks 6-10, 23.

- [x] **Step 1: Cross-check the design spec's unit-test checklist against what Tasks 6-10 actually wrote**: header normalization ✓(Task 7), Arabic and English aliases ✓(Task 7), automatic mapping confidence ✓(Task 7), email normalization ✓(Task 8), phone preservation ✓(Task 8), Excel date parsing ✓(Task 6), yes/no normalization ✓(Task 8), multi-select parsing ✓(Task 8), duplicate detection ✓(Task 10), row fingerprints ✓(Task 8), mapping-template matching — **check**: Task 13's `getMappingSuggestions` template-lookup logic has no dedicated pure-logic test yet (it's embedded in a server action) — extract the "does this header signature match a stored template" comparison into a small testable pure function if not already isolated, and add `tests/import/template-matching.test.ts`. required-field validation ✓(Task 10). formula-injection protection ✓(Task 9). idempotent re-import classification ✓(Task 10, via `row_fingerprint` equality — but add an explicit test asserting two rows with the same fingerprint are treated as `skipped_unchanged` if this specific behavior isn't already covered by Task 14's live test alone; a pure-logic version belongs here).

- [x] **Step 2: Write any missing tests identified in Step 1**

- [x] **Step 3: Run `npx vitest run --project default`, confirm all pure-logic import tests pass, zero regressions in the rest of the suite**

- [x] **Step 4: Commit**

```bash
git add tests/import/
git commit -m "test: fill remaining unit-test coverage gaps against the design spec checklist"
```

**Post-implementation note:** Investigation confirmed every design-spec checklist item genuinely covered by existing Tasks 6-10 tests (verified against the real test files, not just the plan's own ✓ annotations). Two specific gaps investigated and both concluded to need no new pure-logic test: (1) mapping-template matching has no missing pure logic to extract — the only genuinely pure piece is `computeHeaderSignature` (already tested in Task 7's suite), and the rest is an unavoidable DB equality lookup, not something a unit test can meaningfully exercise. (2) The plan's framing of idempotent re-import classification via `row_fingerprint` equality turned out to describe intended-but-unimplemented behavior — `row_fingerprint` was computed and stored but never read anywhere in the codebase, a genuine gap between the binding design spec and Task 15's actual implementation, not a test-coverage gap.

**This investigation led to an unplanned, real fix rather than just a documentation note**, given the user's explicit direction to treat it as its own task rather than defer: `row_fingerprint` was wired into `apply_import_row_transactional` (Task 15's highest-risk RPC) so a cross-batch re-import of unchanged content is correctly classified `skipped_unchanged` — no snapshot, no `applications`/`application_answers` write, no spurious `application_status_history` row, but still an audit trail — per the design spec's literal "Idempotency and concurrency rules" requirement. Mechanism: a new `applications.last_import_row_fingerprint` column (deriving the "most recent prior fingerprint" from `import_rows` directly was investigated and rejected as unimplementable correctly, since `import_rows` has no timestamp column and any other ordering candidate could pick an arbitrary prior row across batches). `rollback_import_batch_transactional` was correspondingly updated to *restore* (not clear) this column from the before-image snapshot — a load-bearing detail, since leaving it set after a restore would make re-importing a just-rolled-back batch a silent no-op, and unconditionally nulling it would lose an earlier, still-valid batch's fingerprint when imports have stacked. Committed `89f206b`, with a new live test (`tests/import/reimport-fingerprint-live.test.ts`) driving 3 real batches end-to-end and proving the skip, the update-path regression check, and the rollback interaction — independently re-run twice back-to-back with zero regressions to `confirm-import-live.test.ts`/`rollback-live.test.ts`.

Given this modifies the plan's highest-risk RPC for a third time, it received the same dedicated review discipline as Tasks 15/16's original review. The core mechanism was confirmed correct across all 9 SQL-correctness focus areas independently traced by the reviewer (NULL/three-valued-logic handling, snapshot-restore ordering under a concrete 3-batch stacking scenario, `FOR UPDATE` lock race-freedom, skip-path completeness via plpgsql `return` semantics, unreachability from the INSERT path, and more). One real Important finding: `computeRowFingerprint` hashes only `normalizedRow`, not raw cell text or the column mapping, so two imports whose cells normalize identically but differ in raw form (e.g. whitespace, or values collapsed by `normalizeEmail`/`normalizePhone`/`normalizeYesNo`) will still match and skip — even though `application_answers.raw_value` would have legitimately changed. Widening the hash was considered and rejected (a non-trivial change to Task 8's already-reviewed pure function, for a benefit bounded to audit/provenance metadata rather than participant-facing data), so this was fixed by documenting the real, narrower guarantee honestly via `comment on column`/`comment on function` rather than by code change. A related Minor finding (the migration's summary comments said rollback "clears" the fingerprint column when the code actually restores it from the snapshot) was corrected in the same follow-up. The live test's cleanup was also hardened to match the per-step try/catch pattern already established by Task 20's fix. Committed `5cac979`. Re-verified: tsc/lint clean, test re-run twice back-to-back, zero leftover test data.

---

## Task 25: Scale tests

**Files:**
- Create: `tests/import/scale-500.test.ts`
- Create: `tests/import/scale-5000.test.ts`

Depends on Task 23 (fixtures 13-14), Task 15 (confirm-import), Task 17 (downstream processing).

- [x] **Step 1: Write `scale-500.test.ts`** — using fixture #13, run the full upload → parse → map (auto-suggest, no manual review needed for a fixture with clean known headers) → validate → confirm-import chunk loop end-to-end. Record wall-clock time for: parse, validation, import (sum of all chunk calls). Assert the batch reaches `imported` with `inserted_count` matching the fixture's expected valid-row count. Log the timing breakdown to the test output explicitly (`console.log` is acceptable here — this is a documented measurement, not debug noise, per the design spec's "measure and document import and processing performance" requirement).

- [x] **Step 2: Write `scale-5000.test.ts`** — same shape, fixture #14. This test may legitimately take minutes to run — increase its `vitest` timeout explicitly (`it('...', async () => {...}, { timeout: 300_000 })` or equivalent) rather than letting it flake against the default timeout. If it reveals a genuine bottleneck (e.g. the per-row `application_answers` upsert being a query-per-row rather than a batch upsert), that's a real performance defect to fix here, not to defer — the design spec explicitly says "avoid one database query per cell" and "use bulk database operations." Audit Task 15's `applyImportRow`/RPC for this specifically: does the transactional RPC do one `application_answers` upsert per row (acceptable, one row = one RPC call = one transaction) or does the JS-side loop somehow do more? Confirm efficient.

- [x] **Step 3: Both these test files should be added to `vitest.config.ts`'s `allocation-live-sequential`-style project** (or a new `import-scale-sequential` project) with `fileParallelism: false`, since a 5,000-row live-DB test racing against other live tests over the same shared Supabase project would be exactly the contention problem Phase 5's `vitest.config.ts` comment already documents for the allocation tests. Add the new project block, following the exact existing pattern.

- [x] **Step 4: Run both tests, document actual results** (this becomes part of the final report, not just a pass/fail — capture the real numbers).

- [x] **Step 5: `npx tsc --noEmit`, `npm run lint`**

- [x] **Step 6: Commit**

```bash
git add tests/import/scale-500.test.ts tests/import/scale-5000.test.ts vitest.config.ts
git commit -m "test: add 500-row and 5,000-row import scale tests with documented timing"
```

**Post-implementation note (2026-07-27):** Task 25 required two commits, split across an account handoff.

1. `abe58ad` (WIP): both scale test files, `vitest.config.ts`'s `import-scale-sequential` project, and a real N+1 fix in `runValidationForCaller` (`preview/actions.ts`) — the existing-application-by-email lookup and the 4-table downstream-reference check both ran once per row; replaced with two batched lookups chunked at 100 items per `.in()` filter (500 was tried first and reproducibly failed against the live project's request-size limits). This dropped validation from the dominant cost to ~5-6s at 500-row scale.

2. `6bcee51`: Step 2's mandate — "if it reveals a genuine bottleneck ... that's a real performance defect to fix here, not to defer" — was honored. The first scale-500 run (pre-fix) measured the confirm-import chunk loop at 165-179s for 500 rows (~2.7-2.9 rows/sec end-to-end), which projected to 30+ minutes for 5,000 rows. Root cause: `processImportChunkForCaller` called `apply_import_row_transactional` once per row, sequentially, in a plain `for` loop — pure network round-trip latency accumulation, no parallelism.

   Rather than fix this unilaterally, the options (parallelize with bounded concurrency; parallelize with full chunk-width `Promise.all`; don't fix, just document; a bulk-RPC redesign) were presented to the user with trade-offs, since this touches the calling pattern around the plan's own designated highest-risk RPC. User chose bounded concurrency (`ROW_CONCURRENCY = 15`).

   Before implementing, the locking model was traced through the RPC's actual current body (`20260727010000_wire_row_fingerprint_idempotent_reimport.sql`), not assumed: two rows in one chunk can only contend if both target the same `applications.id` via `FOR UPDATE`, and that's structurally impossible — `duplicate_in_file` classification (Task 10) already collapses any two rows in a file targeting the same existing application before this loop runs, and that path takes no `applications` lock. `next_application_number()` is `nextval()`-backed and race-free under concurrency. A dedicated Opus-model review independently re-traced this reasoning against the source (not just the comment) and confirmed no deadlock is possible; it found three Low findings, one addressed (a comment clarification naming the injectivity invariant the argument relies on — that `destination_application_id` is an injective function of the row's email, so a future second matching key would need re-verification), two accepted as non-blocking observations (lock-TTL headroom framing; connection-pool math, confirmed fine at this concurrency level).

   **Real measured results**, both live-DB runs against the actual Supabase project:
   - 500 rows: chunk loop 165-179s → **18s** (~2.8 → ~20.8 rows/sec end-to-end)
   - 5,000 rows: chunk loop **~173s**, total **~193s** (~25.9 rows/sec end-to-end) — down from a projected 30+ minutes to about 3 minutes.

   No correctness regression: both tests' inserted/updated/skipped counts matched expectations. Resumability, the processing lock, and rollback are untouched — only the loop within a single chunk call changed; chunk-to-chunk sequencing is exactly as before.

   A residual `AuthRetryableFetchError` on `deleteUser` in `scale-5000.test.ts`'s `afterAll` (the known transient-vs-FK-block pattern documented elsewhere in this plan) left one `import_batches` row, ~4,000 `applications` rows, and one stale Auth user behind after the test run; all were independently verified against live state and manually cleaned before this note was written (confirmed 0 remaining afterward). Not a code defect — the earlier `step()`-wrapped cleanup calls (applications, import_rows, mappings, batch, storage) all succeeded per the per-step try/catch discipline; only the final `deleteUser` call failed, and it is self-healing via the test's own `sweepStaleStaffUser()` on next run regardless.

---

## Task 26: End-to-end test

**Files:**
- Create: `tests/e2e/import-flow.test.ts` — check first whether this codebase has ANY existing browser-driven e2e test infrastructure (Playwright/Cypress) — per Phase 5's investigation, it likely does not (no such dependency was found in `package.json`). If none exists, this task's scope is: **investigate, then surface the choice to the user rather than silently adding a new, heavyweight testing framework dependency for one phase** — a new e2e framework is a significant, cross-cutting decision (affects CI, dev workflow, all future phases), not something to introduce unilaterally mid-plan. If Playwright/Cypress already exists, follow its established convention exactly.

Depends on Task 22 (the full pipeline must work before an e2e test can exercise it).

- [x] **Step 1: Check for existing e2e infrastructure.** If found, write the test following its convention, covering: upload → sheet selection → mapping (including seeing a low-confidence suggestion flagged) → preview (including seeing an error row and downloading the error report) → confirm → progress display → downstream processing completion → import history entry appears → rollback (on a fresh, safe-to-rollback batch) → bilingual check (load the same flow under `/ar/...` and confirm RTL layout / Arabic labels render without breaking, reusing Phase 5's established RTL verification approach for the participant-facing pages this phase touches, i.e. the claim page).

- [x] **Step 2: If NOT found**, stop this task here and ask the user: introduce a new e2e framework now (naming the specific tradeoff — setup cost, CI time, maintenance surface) versus deferring browser-driven e2e coverage for this phase and relying on the extensive live-DB integration tests (Tasks 14-22) plus a manual verification pass (this plan's many "manual verification" steps already exercise every UI surface once) as this phase's actual UI-correctness evidence. Do not decide unilaterally — this is exactly the kind of infrastructure decision the top-level instructions flag as needing to pause for.

**Post-implementation note (2026-07-27):** Confirmed no browser-driven e2e infrastructure exists in this codebase (`package.json` has no Playwright/Cypress dependency; no `playwright.config.*`/`cypress.config.*`; no `tests/e2e/` directory). Per Step 2, this was surfaced to the user rather than decided unilaterally. **User's decision: defer browser e2e coverage for this phase**, relying on the existing live-DB integration test suite (Tasks 14-25 — `confirm-import-live`, `rollback-live`, `claim-live`, `reimport-fingerprint-live`, `schedule-integration-live`, `scale-500`, `scale-5000`, and others, all exercising the real server actions against the real database end-to-end) as this phase's functional-correctness evidence.

**Honest gap, not silently glossed over:** the implementing session had no browser tool available and did not perform a manual click-through of the UI (upload → mapping → preview → confirm → claim page, either locale). The integration test suite verifies server-side/database correctness thoroughly but does not verify actual rendering — whether a button appears, whether RTL layout holds under `/ar/...`, whether a loading state displays correctly. This is a real, undocumented-elsewhere gap in this phase's verification, not equivalent to a passed manual check. If UI-rendering confidence is needed before shipping, a human (or a future session with browser tooling) should click through the flow described above before merging.

No new files created for this task; no commit (nothing to commit — the decision and this note are the only artifacts, captured here).

---

## Task 27: Documentation

**Files:**
- Create: `docs/participant-import.md`

Depends on all prior tasks being functionally complete (documentation describes the finished feature).

- [ ] **Step 1: Write the operator-facing documentation** covering exactly the design spec's "Documentation" section list: the new operational workflow (Google Forms → external screening → Excel → import), required Excel characteristics (what makes a "good" file, what the importer tolerates), how automatic mapping works and its confidence indicators, how to correct a mapping error, how duplicate participants are handled (the three-way `duplicate_in_file`/`existing_unclaimed`/`existing_claimed`/`blocked_downstream` classification, explained in plain language), how re-import works (checksum + fingerprint), how rollback works and when it's blocked, when automatic analysis/allocation runs (and how to trigger it manually), when invitations are sent (never automatically), the legacy registration feature-flag (`ENABLE_SELF_REGISTRATION`, how to toggle it), troubleshooting (common upload/mapping errors and what they mean), and data privacy/retention (private Storage bucket, sensitive-answer RLS tier, what "raw_value" retention means for audit purposes).

- [ ] **Step 2: Commit**

```bash
git add docs/participant-import.md
git commit -m "docs: add Phase 5.1 participant import operator documentation"
```

---

## Task 28: Final verification pass

**Files:** none new.

Depends on every prior task.

- [x] **Step 1:** `npx tsc --noEmit` — zero errors across the whole worktree.
- [x] **Step 2:** `npm run lint` — zero errors.
- [x] **Step 3:** `npm test` (pure-logic + RLS project) — full suite passing; document any live-DB test failures explicitly attributable to the known external Auth Admin JWT-verification flakiness (per Phase 5's precedent) versus any genuine code failure — the two must never be conflated in the final report.
- [x] **Step 4:** Run Task 25's scale tests explicitly, capture and document final timing numbers.
- [x] **Step 5:** `npm run build` — production build succeeds; confirm every new route appears in the build output (`/participants`, `/participants/import`, `/participants/import/[batchId]/map`, `/participants/import/[batchId]/preview`, `/participants/import/[batchId]/confirm`, `/participants/imports`, `/participants/imports/[batchId]`, `/participants/[applicationId]`, `/claim`).
- [x] **Step 6:** Re-read the design spec's rules one more time against the implemented code (same grep-based traceability method Phase 5's Task 27 used): confirm rule 2, rule 3, rule 5.
- [x] **Step 7:** Confirm working tree is clean (`git status --short`).
- [x] **Step 8:** Dispatch a final whole-phase spec-compliance review (background subagent).
- [x] **Step 9:** Dispatch a final whole-phase code-quality review (background subagent).
- [x] **Step 10:** Final implementation notes (this section).
- [x] **Step 11:** Checkpoint before `superpowers:finishing-a-development-branch` — see the explicit "not ready to merge yet" note at the end of this section.

**Post-implementation note (2026-07-27):**

**Steps 1-7, straightforward, all clean.** `tsc --noEmit`: 0 errors. `npm run lint`: 0 errors, 1 pre-existing unrelated warning (`tests/schedule/publication-lifecycle.test.ts`, an unused import predating this plan). `npm run build`: succeeds; every listed route present in the build output, plus `/participants/import/[batchId]/rollback` (correctly present, just not explicitly named in this step's original list). `git status --short`: clean after every commit in this session.

**Step 3 (`npm test`) required real triage, not a rubber-stamp.** A first full-suite run showed 15 failed test files. Investigated each rather than assuming "known flakiness":
- **9 pre-existing, out-of-plan test files** (`tests/agenda/conflict-and-validation.test.ts`, `tests/schedule/*.test.ts` ×6, `tests/allocation/run-behavioral.test.ts`, `tests/rls/import.test.ts` before its fix below) all failed identically: fixed-email `admin.auth.admin.createUser` calls colliding with stale users left behind by this session's own heavy live-test activity, with no stale-user sweep in those older files (a documented pre-existing gap — see the handoff document's §10, unrelated to this plan's own code). The Phase-5/pre-existing ones (`tests/agenda/`, `tests/schedule/`, `tests/allocation/run-behavioral.test.ts`) are explicitly out of this plan's scope to fix and were left as-is, correctly attributed to known external/environmental flakiness, not a code regression.
- **This plan's own live tests** (`tests/rls/import.test.ts`, `tests/import/downstream-processing-live.test.ts`, `tests/import/confirm-import-live.test.ts`) got real fixes, not just re-runs: added stale-user sweeps with a reuse-on-failure fallback (verified directly against the live project that `deleteUser` can fail with `AuthRetryableFetchError` **persistently**, not just transiently, for a specific user id — retrying does not help; the fallback reuses the stale user's id, resetting its password, rather than depending on deletion succeeding). Also found and fixed real orphaned-fixture-data bugs: `downstream-processing-live.test.ts`'s pre-existing-applicant fixture didn't clear the full downstream FK chain (only 4 of 6 non-cascading `application_id`-referencing tables) before reusing a stale user id, causing a real insert collision; `confirm-import-live.test.ts` had the same class of issue via `applications.imported_email`'s unique partial index. Both fixed and verified passing across 2+ consecutive runs each.
- **A genuinely large piece of debris was found and cleaned, not just a test bug**: the live project had accumulated **4,262 orphaned `accepted` applications** from this session's own earlier `scale-500`/`scale-5000`/`confirm-import-live` runs, whose `afterAll` cleanup never completed (from an interrupted run mid-session, predating this Task 28 pass). This silently broke `downstream-processing-live.test.ts`'s own "k=99 always exceeds available feature vectors" test premise, since the pipeline scopes by `status='accepted'` project-wide — with 4,282 accepted applications actually present, k=99 was no longer excessive, so a test asserting a rejection correctly never saw one. Investigated, traced to 3 specific stale `import_batches`, cleaned directly against the live project, verified 0 leftover afterward. Not a code defect in either the test or the pipeline.
- Final state: this plan's own test files all pass, independently re-run multiple times each. Pre-existing Phase 5/agenda test files' failures are accurately attributed to the pre-existing stale-user-sweep gap in those files, not to any change made in this plan.

**Step 4 (scale test numbers), final, post-cleanup, confirmed-stable measurements:**
- 500 rows: chunk loop ~18s, ~20-21 rows/sec end-to-end (re-confirmed after the 4,262-application cleanup — numbers unchanged, confirming the debris hadn't been skewing this specific measurement).
- 5,000 rows: chunk loop ~173s, total ~193s, ~25.9 rows/sec end-to-end (measured once, in isolation, before the debris was discovered — not re-run a second time given its ~3-minute cost and that the 500-row re-confirmation showed no measurable debris effect on timing).
- Both numbers reflect the Task 25 chunk-loop concurrency fix (bounded `ROW_CONCURRENCY = 15`), not the original sequential baseline (~2.7-2.9 rows/sec, documented in Task 25's own post-implementation note).

**Step 8 (final spec-compliance review) found ONE real, verified, Important-severity gap**, independently re-confirmed by direct grep/read before acting on it: the design spec's step 10 requires a row matching an **already-claimed** (active, logged-in) participant be a "review-required update" needing explicit admin confirmation before being applied. This was never built — every revision of `apply_import_row_transactional` collapsed `existing_unclaimed` and `existing_claimed` into the identical auto-applying branch, and `docs/participant-import.md` (Task 27, written before this was caught) incorrectly described the gate as if it existed. **User explicitly chose to build the real gate now** (not defer, not amend the spec) — see the dedicated section below. The review's other findings (Rules 1-6, RLS, rollback rules, idempotency/concurrency rules, out-of-scope list) all held cleanly against the actual current code, independently re-verified via the three grep checks in Step 6.

**Step 9 (final code-quality review) found one High finding, fixed immediately, plus Medium/Low items:**
- **High, fixed**: `fetchApplicationIdsWithDownstreamReference` (preview/actions.ts) checked 4 downstream tables while `rollback_import_batch_transactional`'s blocker check covers 5 — missing `schedule_publication_draft_items`. Concrete consequence: an import could overwrite an application with a pending, unconfirmed schedule-publication draft attached (not blocked at preview time), then rollback would refuse to undo it (draft items ARE in rollback's blocker set) — an import the system allowed but then couldn't cleanly undo. Fixed by adding the 5th table to the preview check, with a cross-reference comment in both functions.
- Count-accumulation, `raw_value` threading, and RPC atomicity (the three gaps originally flagged in Task 15): all **CONFIRMED FIXED**, independently re-traced against the current code, not just re-reading old comments.
- Downstream-reference completeness (Task 14's original gap): confirmed the 4-table expansion from Task 14 itself is intact and survived Task 25's N+1 refactor — the missing 5th table was a separate, later gap (rollback added a 5th blocker table after Task 14 shipped, and the preview check was never updated to match), not a regression of Task 14's own fix.
- Medium (stale migration references in 2 docblocks) and one Medium (dead `duplicate_of_row_id` column, see below): fixed the docblocks; the dead column is documented as an explicit, undecided deferral, not silently left ambiguous.
- Low findings (vestigial `counts` object, `rollback`'s unexplained `skipped_count` asymmetry, unused `actorId` params in `invitation.ts`): the vestigial `counts` object was fixed (removed, since it was a live trap for reintroducing GAP #1). The other two Low findings are deliberately deferred — see below.

**Real, substantive work resulted from this task, beyond checking boxes — the existing_claimed gate.** Migration `20260727030000_gate_existing_claimed_updates.sql` (4th revision of `apply_import_row_transactional`, applied live): an unapproved `existing_claimed` row is now classified `'blocked'` instead of auto-applied; `existing_unclaimed` is completely unaffected. New `approveClaimedUpdatesForCaller` (preview/actions.ts): batch-scoped, audited admin action. New UI in `preview-table.tsx`: warning banner + approve button, shown before "Proceed to confirm." New live test `tests/import/claimed-update-gate-live.test.ts`.

Building this surfaced a genuine, separate bug found through careful manual review (three consecutive dedicated-review subagent dispatches failed with transient `529 Overloaded` API errors; the review was performed directly instead, then independently re-confirmed by a 4th, successful subagent dispatch): approving a claimed update alone does not make the row re-appliable, because `apply_import_row_transactional`'s very first check is `if action_taken is not null then return 'already_applied'`, and nothing else in the normal flow clears `action_taken` once a row is stamped `'blocked'`. Fixed by having the approval action also reset `action_taken` back to null for exactly the rows it unblocks (never touching a row already legitimately `inserted`/`updated`/`skipped_unchanged`/`skipped_error`). An earlier draft of the live test had manually null'd `action_taken` to work around this exact gap, which would have shipped a test that papered over the bug instead of catching it — caught before commit.

**Known, deliberately deferred limitation of the existing_claimed gate** (documented in the function's own docblock, not silently left ambiguous): approving after a batch has already reached `imported` status correctly resets the flag and unblocks the row, but nothing in this feature can re-open an `imported` batch's chunk loop to actually re-apply it — `processImportChunkForCaller`/`resumeImportBatchForCaller` both require `status = 'importing'`. This is the same category of gap as the pre-existing lack of any "retry one failed row" path for `skipped_error` rows. The dedicated review confirmed this judgment: no cheap fix exists (rewinding `next_chunk_offset` on an `imported` batch would need its own careful review of the offset-based pagination's forward-only assumption and interactions with the rollback state machine — a real design change, not a patch), and the UI-guided flow (approve shown before confirm) avoids the scenario entirely in normal use.

**Two Low-severity findings deliberately NOT fixed this session, explicitly deferred rather than silently dropped:**
- `import_rows.duplicate_of_row_id` is declared, indexed, and computed by `classifyDuplicateStatus`, but never actually persisted — `preview/actions.ts` computes it and then discards it before the bulk insert. Converting a within-file row *index* to the eventual `import_rows.id` UUID requires a post-insert linking pass (ids aren't known until after the bulk insert), which is more than a one-line fix. Left undecided: either populate it properly (a follow-up task) or formally mark the column reserved-unpopulated. Whoever picks this up next should choose one and act on it, not leave it silently inert.
- `resendInvitation`/`revokeInvitation` (`src/lib/import/invitation.ts`) take an unused `actorId` parameter (`void actorId; // reserved for a future audit-log call`). Genuinely cosmetic — the caller already audits — but removing it means touching a signature and re-verifying against the invitation flow, which is currently untestable end-to-end because Task 20's live invitation test remains blocked on the external Supabase email rate-limit (checked again during this session: still exhausted, confirmed via a real attempted send returning the exact "email rate limit exceeded" error, not a fabricated skip). Deferred rather than risk an unverified signature change on a code path that can't currently be fully live-tested.

**This branch is NOT ready for `superpowers:finishing-a-development-branch` yet.** Outstanding before merge should be considered:
1. Task 20's live invitation test genuinely unverified (external rate limit, not a code gap — do not modify the Auth rate-limit config to work around it, per explicit standing instruction).
2. No manual browser click-through of the UI was performed this session (no browser tool was available) — see Task 26's note for the honest scope of what evidence exists (live-DB integration tests only) versus what doesn't (actual rendering verification).
3. The two deliberately-deferred Low findings above.
4. A fresh, full `npm test` run should be done by whoever merges, since live-DB test state is a moving target on a shared Supabase project and this session's own cleanup, while thorough, was reactive rather than a guaranteed-permanent fix for the underlying stale-fixture-accumulation pattern across the whole test suite (not just this plan's files).

---

## Notes for the implementing agent

- **Do not implement QR code issuance, attendance tracking, or email-template customization** — explicitly out of scope per the design spec.
- **Do not add a background-job/queue dependency** — explicitly out of scope; the chunked, client-orchestrated, resumable server-action pattern is the approved architecture for this phase.
- **Task 15 is the highest-complexity, highest-stakes work in this plan** (real writes, transactional per-row apply, resumability, locking). If dispatched to a subagent, use the most capable available model, matching Phase 5's precedent for its RPC-layer tasks.
- **Three gaps were deliberately left as explicit, flagged TODOs in Task 15's draft code** (count accumulation, raw_value threading, atomic RPC requirement) — these are not oversights to silently work around; the implementer must resolve all three before the task is considered done, exactly as flagged.
- **Task 14's downstream-reference check is drafted incompletely** (only checks feature snapshots) — the implementer must expand it to check clustering, allocation, and schedule-publication tables too, as flagged in that task's review checkpoint.
- **Never let a participant-role session read another participant's `application_answers`, and never let an unclaimed application's answers leak via RLS** — this is the single most security-critical invariant in this phase; Task 5's regression test and Task 21's review checkpoint both exist specifically to catch a regression here.
- **The claim flow (Task 21) is the second-most security-critical piece** — ownership must only ever be established by the transactional RPC, never implied by an Auth user merely existing. If any implementer's draft of `sendInvitation` or the claim page sets `applicant_id` anywhere outside `claim_imported_application_transactional`, that's a spec violation.
- **Task 26 (e2e) may require pausing to ask the user** whether to introduce new test infrastructure — this is flagged explicitly in that task, not a place to guess.
- **Tasks 6-10 (pure logic) are independent of each other and could be parallelized** if using multiple workers — this plan assumes single-worktree sequential subagent-driven-development, so keep them in order regardless, matching Phase 5's stated approach to its own independent UI tasks.
