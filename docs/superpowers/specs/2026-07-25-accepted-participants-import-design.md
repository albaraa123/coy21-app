# Phase 5.1: Accepted Participants Excel Import — Design

## Context and product-flow change

Public registration and applicant screening no longer happen inside this platform. Applications are collected externally via Google Forms; screening and selection happen externally. The organizing team produces one Excel file of accepted participants and uploads it here. The platform must adapt to whatever the Excel file looks like — not the other way around — and feed imported participants through the existing feature-extraction → clustering → allocation → schedule-publication pipeline (merged to `master` as of this phase's start).

Existing registration/admissions code is preserved but deactivated from production navigation (feature-flagged, not deleted).

## Non-negotiable rules

1. No parallel data model. Reuse `applications`, `application_status_history`, `audit_logs`, feature extraction, clustering, allocation, and schedule publication as they exist today. Import-specific staging/audit tables are allowed but must feed the existing tables, never replace them.
2. Uploading and previewing never touches `applications`/`application_answers`. Only an explicit admin confirmation triggers writes.
3. Automatic post-import processing may run feature extraction → clustering → allocation. It must **never** automatically confirm an allocation run, publish a schedule, activate a schedule revision, send an invitation, or issue a QR credential — all of those remain explicit, separate admin actions, identical to how Phase 5's `confirm_publication_transactional` already requires an explicit `confirmDraftPublication` call.
4. Self-registered applications continue to require `applicant_id` (enforced, not just conventional). Only externally-imported, not-yet-claimed applications may have `applicant_id IS NULL`.
5. An Auth user existing is never sufficient to grant access to an imported application or its schedule. Ownership is only established by an explicit, transactional claim step — never implied by `inviteUserByEmail` succeeding.
6. Every sensitive administrative action (upload, mapping, confirm, rollback, downstream processing, invitation send/resend/revoke/claim) is audited via the existing `audit_logs` table.

## Schema changes

### 1. `applications` — minimal relaxation

```sql
alter table applications alter column applicant_id drop not null;
alter table applications add column imported_email text;
alter table applications add column import_batch_id uuid references import_batches(id);

-- Self-registered applications must still have an owner. Imported-and-unclaimed
-- applications are the only legal NULL case, and only when they carry a
-- non-null imported_email (so a NULL applicant_id row is always traceable to
-- either a claim-in-progress import, never an orphan with no identity at all).
alter table applications add constraint applications_owner_or_import_identity
  check (applicant_id is not null or imported_email is not null);

-- Case-insensitive, normalized (lowercased/trimmed at write time — enforced by
-- the import code path, not a DB-level transform, matching this codebase's
-- existing convention of app-layer normalization before insert). Partial:
-- claimed applications may retain imported_email for provenance (rule 5), so
-- the index only needs to prevent duplicate *unclaimed* identities.
create unique index applications_imported_email_unclaimed_unique
  on applications (imported_email) where applicant_id is null;

create index applications_import_batch_idx on applications (import_batch_id);
```

`imported_email` is set at import time, normalized (trim + lowercase) in application code before the insert — never re-derived from `profiles.email` later, and never silently changed if `profiles.email` changes post-claim (rule 5). It is the sole matching key for duplicate/re-import detection while `applicant_id IS NULL`; once claimed, matching for *future* re-imports of the same person still uses `imported_email` (preserved), not `profiles.email`, so a participant changing their login email after claiming doesn't break re-import matching.

**Self-registration invariant (rule 4)**: the existing registration flow (`src/app/[locale]/(participant)/register/actions.ts`) always sets `applicant_id` from `supabase.auth.getUser()` before any insert — this is unchanged, so self-registered rows always satisfy `applicant_id is not null`. The new CHECK constraint is defense-in-depth confirming no code path can produce a row with both `applicant_id` and `imported_email` null.

### 2. `application_answers` — new generic table

```sql
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
  import_batch_id uuid references import_batches(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint application_answers_value_type_valid check (value_type in ('text', 'multiselect', 'boolean', 'number', 'date')),
  constraint application_answers_source_valid check (source in ('import', 'manual')),
  -- Deterministic dedup: one answer per (application, question_key, source).
  -- A later import updates the existing row for the same question_key rather
  -- than inserting a duplicate.
  constraint application_answers_unique unique (application_id, question_key, source)
);

create index application_answers_application_idx on application_answers (application_id);
create trigger application_answers_set_updated_at before update on application_answers
  for each row execute function extensions.moddatetime('updated_at');
```

`raw_value` is always the exact original Excel cell text (rule 3: "preserve raw_value exactly as imported"). `normalized_value` is the cleaned form (trimmed, case-normalized where applicable, multi-select joined to a canonical delimiter, etc.). `is_sensitive` is set `true` at import time for a fixed set of `question_key`s (accessibility requirements, dietary requirements, emergency contact name/phone, and the existing `special_needs` concept) — see RLS section.

Known pipeline-critical fields (`interests`, `track_interests`, `topics_to_learn`, `participation_goals`, `past_initiatives`, `preferred_language`, `experience_level`, plus `phone`, `country`, `nationality`, `city`, `organization`, `field_of_work`, `birth_date`, `age_group`) continue to populate their existing typed `applications` columns directly — they are *also* mirrored into `application_answers` for traceability/audit (so "every original answer is preserved" holds even for fields with a typed home), but feature extraction and allocation keep reading the typed columns exactly as today, unchanged.

### 3. Import staging tables

```sql
create table import_batches (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid not null references profiles(id),
  original_filename text not null,
  file_checksum text not null,
  storage_path text not null,          -- private Supabase Storage object path
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
  auto_process_cluster_k int,           -- required if auto_process_downstream is true; see rule below
  downstream_status text,              -- null until import completes; see state machine

  constraint import_batches_auto_process_k_required check (
    not auto_process_downstream or auto_process_cluster_k is not null
  ),
  constraint import_batches_cluster_k_positive check (auto_process_cluster_k is null or auto_process_cluster_k > 0),

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
  ))
);

create table import_column_mappings (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references import_batches(id) on delete cascade,
  source_column_index int not null,
  source_column_header text not null,
  target_kind text not null,           -- 'core_field' | 'known_answer' | 'generic_answer' | 'ignored'
  target_key text,                     -- applications column name, or question_key
  confidence numeric,                  -- 0..1, null for manually-set mappings
  is_manual_override boolean not null default false,

  constraint import_column_mappings_target_kind_valid check (target_kind in ('core_field', 'known_answer', 'generic_answer', 'ignored')),
  constraint import_column_mappings_confidence_range check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint import_column_mappings_unique unique (import_batch_id, source_column_index)
);

create table import_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references import_batches(id) on delete cascade,
  excel_row_number int not null,
  row_fingerprint text not null,       -- stable hash of normalized row content
  raw_row jsonb not null,
  normalized_row jsonb,

  validation_status text not null default 'pending',
  warnings jsonb not null default '[]'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  duplicate_status text,               -- null | 'duplicate_in_file' | 'existing_unclaimed' | 'existing_claimed' | 'blocked_downstream'
  duplicate_of_row_id uuid references import_rows(id),

  destination_application_id uuid references applications(id),
  action_taken text,                   -- null | 'inserted' | 'updated' | 'skipped_unchanged' | 'skipped_error' | 'blocked'

  previous_application_snapshot jsonb, -- before-image for update rollback
  previous_answers_snapshot jsonb,     -- before-image for update rollback

  constraint import_rows_validation_status_valid check (validation_status in ('pending', 'valid', 'warning', 'invalid')),
  constraint import_rows_unique_row unique (import_batch_id, excel_row_number)
);

create index import_rows_batch_idx on import_rows (import_batch_id);
create index import_rows_fingerprint_idx on import_rows (row_fingerprint);

create table import_mapping_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  header_signature text not null,      -- stable hash of normalized header set, for match-suggestion
  original_headers jsonb not null,
  mappings jsonb not null,             -- serialized target_kind/target_key/transform rules per column
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  version int not null default 1
);

create index import_mapping_templates_signature_idx on import_mapping_templates (header_signature);
```

### 4. Invitation tracking

```sql
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
```

An `audit_logs` entry is written for every send/resend/revoke/claim (rule: durable + audited), in addition to the row-level state on this table itself. `invited_user_id` is populated as soon as Supabase resolves/creates the Auth user — but per rule 1, this **does not** grant access; `applications.applicant_id` is only backfilled at the transactional claim step, described below.

## Exact flow: upload → invitation

### A. Upload and inspect

1. Admin uploads `.xlsx` (drag-and-drop). Server validates: file extension + MIME sniffing + magic-byte signature check (not trusting the client-declared MIME type), size limit, and rejects password-protected/macro-enabled/corrupted workbooks safely (parse in a try/catch, surface a clear error, never crash the request).
2. File is streamed to a private Supabase Storage bucket (`import-uploads`, no public policy). `import_batches` row created: `status = 'uploaded'`, `file_checksum` = SHA-256 of the file bytes.
3. Server parses the workbook (new dependency: `exceljs`, chosen for streaming-friendly parsing and explicit cell-type handling needed for "phone as text" / "safe date parsing" requirements — `xlsx`/SheetJS's community edition has known formula-injection and prototype-pollution CVEs that would need mitigation work `exceljs` avoids). Detects all non-empty sheets, suggests the most likely one (most non-empty data rows). `status → analyzing → awaiting_mapping`.
4. **Same-file re-upload detection**: if `file_checksum` matches a prior `import_batches` row, surface that immediately ("this file was already imported on [date] as batch [id], status [x]") before the admin proceeds further — satisfies "same file uploaded again" handling without blocking a legitimate re-run.

### B. Mapping

5. Server computes normalized header signatures for the selected sheet's header row, checks `import_mapping_templates.header_signature` for a match. If found, suggest it (never auto-apply silently — always requires an explicit "use this template" click, even for an exact signature match, per the spec's "do not apply it silently when headers differ materially" combined with rule 1's overall "explicit admin action" philosophy).
6. For each column, run alias/similarity matching against a fixed known-field dictionary (full name, email, phone, WhatsApp, country, nationality, city, gender, DOB/age, preferred language, language ability, organization, position, experience level, interests, topics, accessibility, dietary, emergency contact, + generic fallback) with English and Arabic aliases. Each suggestion gets a confidence score; anything below a threshold (e.g. 0.7) is flagged for mandatory review and **never** auto-mapped to a critical identity field (email, the chosen unique-identifier column) regardless of confidence — rule from the original spec, reaffirmed.
7. Admin reviews the mapping table: change target, mark ignored, designate the unique-identifier column (defaults to the email-mapped column if one exists), mark required fields. Save as a reusable template (optional).
8. `import_column_mappings` rows persisted. `status → validating`.

### C. Validation and preview

9. Server processes all rows in memory-bounded chunks (streaming read, not loading the whole sheet as one giant object graph — required for the 5,000-row scale target), applying mapping + normalization rules (trim, Unicode normalize, lowercase+validate email, phone-as-text preservation, Excel date parsing, yes/no normalization with Arabic/English recognition, multi-select splitting on comma/semicolon/newline). Each row becomes an `import_rows` entry: `raw_row` (exact original), `normalized_row`, `row_fingerprint` (stable hash of normalized content, used for idempotent-reimport classification), `validation_status`, `warnings`, `errors`.
10. Duplicate detection: within-file (same normalized email appearing twice → both rows flagged `duplicate_in_file`, neither silently dropped) and against-database, checked in this order:
    - `imported_email` matches an application with `applicant_id is null` and no downstream reference → `existing_unclaimed`: this row will *update* the existing application (with a before-image captured for rollback, per the rollback rules below).
    - `imported_email` matches an application with `applicant_id is not null` (already claimed) → `existing_claimed`: this row is treated as a **review-required update**, never silently applied — the preview UI surfaces it in its own category (distinct from `existing_unclaimed`/`blocked_downstream`) requiring the admin to explicitly confirm the update before it's included in the batch's importable set, since overwriting a claimed participant's data is a materially different risk than updating an unclaimed staging row.
    - Any match (claimed or unclaimed) where downstream allocation/schedule data already exists for that application → `blocked_downstream`, regardless of claim status: requires explicit resolution before it can be included, taking precedence over `existing_claimed` when both conditions hold.
11. `status → ready_to_import`. Preview UI shows counts (valid/warning/error/duplicate/will-update) and a searchable per-row table. Error report is downloadable (CSV, formula-injection-safe — leading `=`/`+`/`-`/`@` characters in any exported cell are prefixed with a `'` or otherwise neutralized).

### D. Confirm and import

12. Admin clicks confirm. Server acquires the batch's `processing_lock_token` (generates one, sets `processing_lock_expires_at = now() + 2 minutes`), sets `status = 'importing'`, `next_chunk_offset = 0`.
13. Client repeatedly calls a `processImportChunk(batchId, lockToken)` server action. Each call: validates the presented token matches and hasn't expired, processes rows `[next_chunk_offset, next_chunk_offset + CHUNK_SIZE)` in one DB transaction. For each `valid`/`warning` row: if inserting, the new `applications` row is written with **`status = 'accepted'` directly** (imported rows have a distinct provenance from the self-registration review pipeline and never pass through the `draft → submitted → under_review` state machine — see the state-machine section below), `applicant_id = null`, `imported_email` set; if updating an `existing_unclaimed`/confirmed-`existing_claimed` row, `previous_application_snapshot`/`previous_answers_snapshot` are captured before the overwrite. Every write also creates `application_answers` rows, an `application_status_history` entry (`old_status = null, new_status = 'accepted'` for inserts; the prior status for updates, which will itself already be `'accepted'` in the update case), and an `audit_logs` entry. The transaction advances `next_chunk_offset` and `import_rows.action_taken` only on successful commit, renews the lock expiry, and returns updated counts.
    - **Chunk-level atomicity vs. resumability**: because each chunk commits or rolls back as a whole (no chunk is ever left half-applied), a resumed/retried call for an already-fully-committed chunk cannot occur — `next_chunk_offset` only ever advances past a chunk once it's durably committed, so retrying always means "this exact chunk never committed, start it fresh." The `action_taken` field is therefore not an idempotency check *within* a single chunk's retry; it exists for a different, real scenario: a **resumed batch reprocessing a chunk boundary that was previously committed under an old, smaller `CHUNK_SIZE`** is not applicable here since `CHUNK_SIZE` is a fixed server constant, not client-supplied — the field's actual purpose is enabling the *rollback* path (§ Rollback rules) to distinguish rows this batch itself inserted from rows it updated, and enabling the preview/history UI to show "what happened to this row" after the fact. No retry-idempotency logic depends on it.
    - If the browser stops calling (crash/close), the lock simply expires — **any** admin (including a different one) can resume by calling a `resumeImportBatch(batchId)` action that re-acquires the lock only if the previous one is expired or absent, and resumes from `next_chunk_offset` (rule 7: resumable, no progress loss, no two-admin concurrent processing). Because the last chunk boundary is only ever recorded after a committed transaction, resuming from `next_chunk_offset` never re-processes a chunk that already landed.
14. When `next_chunk_offset >= row_count`, `status → imported`.

### E. Automatic downstream processing (optional, admin-toggleable)

15. `runClustering(service, runBy, featureExtractionRunId, k, randomSeed)` requires an explicit `k` (cluster count) and `randomSeed` — normally chosen by an admin on the existing clustering page's form; there is no parameter-free "just cluster it" call to make unattended. So enabling `auto_process_downstream` is itself a small form, not a bare checkbox: the admin must also supply `auto_process_cluster_k` at that point (pre-filled with a sensible default — the same default/last-used value the existing clustering page itself uses, so this isn't a new UX concept, just the same input surfaced one step earlier). `randomSeed` is *not* asked of the admin — it's derived deterministically from `import_batches.id` (e.g. a stable hash truncated to an int32), so it never needs to be a manually-chosen "magic number" and re-running the same batch's auto-process reproducibly picks the same seed. If `auto_process_downstream = false`, none of this applies — the batch reaches `completed` after import alone, and the *existing* clustering page's own form (unchanged) is used for the manual "Run analysis and allocation" path, with its own admin-chosen `k`/`randomSeed` exactly as today.
16. When enabled: `downstream_status` cycles `processing_features → clustering → allocating → completed`, calling the *existing* `runFeatureExtraction`, then `runClustering` (with the `k`/derived-seed from step 15), then `runAllocation` — exactly as they're called today from their respective admin pages, no new orchestration logic duplicated. A failure at any stage sets `downstream_status = 'failed'`, preserves whatever completed successfully (rule: "preserve completed earlier stages for inspection"), and the batch's own `status` becomes `completed_with_warnings`.
17. **Hard stop, by construction, not convention**: nothing in this chain calls `confirmDraftPublication`, `stagePublication`, `inviteUserByEmail`, or any QR-issuance code. Those remain separate pages/actions requiring their own explicit clicks — this is the same boundary Phase 5 already established for schedule confirmation, now extended to cover invitations and allocation confirmation too.

### F. Invitation (fully separate admin action, days/weeks later typically)

17. From an application's admin detail view (or a bulk "Send invitations" action over a filtered set), admin triggers `sendInvitation(applicationId)`.
18. Server checks: does an `auth.users` row already exist for `imported_email`?
    - **No** → call `admin.auth.admin.inviteUserByEmail(imported_email, { redirectTo: '<claim-landing-page>' })`. On success, `participant_invitations` row created/updated: `invited_user_id = <new user id>`, `status = 'sent'`, `sent_at = now()`. **`applications.applicant_id` is NOT touched here** — rule 1.
    - **Yes** (email collision with an existing Auth user) → do **not** call `inviteUserByEmail`. Set `participant_invitations.status = 'failed'`, `last_error = 'email_already_registered'`. Admin must resolve manually via a separate "Link to existing account" action (explicit, requires the admin to view and confirm the existing account's identity before linking) — never automatic.
19. Participant clicks the emailed link, lands on the claim page, authenticates (Supabase handles the invite-token exchange, establishing a real session for that Auth user). The claim page then calls a `claimImportedApplication(applicationId)` server action that, in one transaction: re-verifies the caller's authenticated `user.id` matches `participant_invitations.invited_user_id` for that `application_id` (never trusts a client-supplied user id), backfills `applications.applicant_id = user.id`, sets `participant_invitations.status = 'accepted'`, `accepted_at = now()`, writes `audit_logs`. Only after this transaction commits can the participant's session see their application/schedule — RLS's existing `schedule_publications_select_own`/`applications_select_own`-style policies (keyed on `applicant_id = auth.uid()`) naturally enforce this with zero new RLS logic, since `applicant_id` is null until this exact moment.
20. Resend: re-invoke step 18's invite branch (Supabase's `inviteUserByEmail` is itself idempotent for an unaccepted invite — resending refreshes the link); increment `resend_count`. Revoke: `status = 'revoked'`, and if no claim ever happened, optionally also revoke the underlying Auth user via `admin.auth.admin.deleteUser` (only if unclaimed — never deletes a claimed, actively-used account).

## Import status state machine (rule 8)

```
uploaded → analyzing → awaiting_mapping → validating → ready_to_import
  → importing → imported
  → [if auto_process_downstream] processing_features → clustering → allocating → completed | completed_with_warnings
  → [else] completed
(any state) → failed        -- on unrecoverable error, failure_reason set
ready_to_import|importing → rolled_back   -- only reachable per the rollback rules below
```

Enforced server-side in the action layer (each transition function checks current `status` before writing the next one, rejecting invalid jumps) — not a DB CHECK constraint on transitions themselves (Postgres has no native state-machine constraint type without triggers; a `plpgsql` trigger validating the transition table is used instead, mirroring the existing `applications` status-history convention of recording transitions explicitly rather than just allowing any status value).

## RLS and role behavior

The six new/modified tables (`import_batches`, `import_column_mappings`, `import_rows`, `import_mapping_templates`, `application_answers`, `participant_invitations`) follow the two RLS patterns already established across this codebase — not one uniform pattern, but the same *choice between two* patterns Phase 5 itself uses depending on whether participants need any access at all:

- **Staff-only tables** (`import_batches`, `import_column_mappings`, `import_rows`, `import_mapping_templates`, `participant_invitations` — no participant ever has any legitimate reason to read these): a single `for all using (current_user_role() in (...))` policy, mirroring `schedule_change_events_staff_all`/`schedule_publication_drafts_staff_all` in the existing schedule-publication RLS migration. Default-deny (no participant policy at all) covers every operation for the `participant` role automatically.
- **Participant-readable tables** (`application_answers`, since a participant should eventually be able to see their own non-sensitive answers): the split pattern, mirroring `schedule_publications_select_own` + `schedule_publications_staff_all` — a narrow `_select_own` policy scoped through `applications.applicant_id = auth.uid()` (select-only, non-sensitive rows only) *plus* a separate staff `_all` policy for full read/write. No participant-reachable insert/update/delete policy exists on `application_answers` either way — participants only ever get the read-only self-scoped grant.

In all cases, defense-in-depth: the real authorization gate is a server-action-level `require<X>StaffCaller()` check using the service-role client (which bypasses RLS), exactly as established throughout this codebase — RLS policies exist as a second layer, not the primary boundary.

- **Import tables** (`import_batches`, `import_column_mappings`, `import_rows`, `import_mapping_templates`): staff role list = `agenda_allocation_manager`, `super_admin` (the roles this spec designates as import-capable) — matches the "Agenda and Allocation Manager may upload/confirm/run analysis" requirement.
- **`application_answers`**: two-tier. Ordinary (`is_sensitive = false`) answers: same staff list as above (agenda/allocation staff need these for allocation review). Sensitive (`is_sensitive = true`) answers: `super_admin` only — a second, narrower RLS policy plus a matching server-action check, so agenda/allocation staff's normal answer-browsing queries never surface accessibility/dietary/emergency-contact data.
- **`participant_invitations`**: `super_admin`, `agenda_allocation_manager` for read/send (matches "may send invitations" in the spec's role table); actual `inviteUserByEmail`/`deleteUser` Auth Admin calls happen only through the service-role client in a server action gated the same way — RLS never grants a client-side path to Auth Admin operations regardless.
- **Participants**: zero access to the five staff-only tables (`import_batches`, `import_column_mappings`, `import_rows`, `import_mapping_templates`, `participant_invitations`), enforced by default-deny (no participant policy exists at all for any of them) — the same pattern already used for `application_status_history`/`schedule_publication_drafts` in this codebase. On `application_answers`, participants get exactly the narrow `_select_own` grant described above: their own row, once `applicant_id` is backfilled, non-sensitive (`is_sensitive = false`) rows only — sensitive answers stay staff-administrative context, not something the participant-facing UI currently redisplays to them (if a future phase needs this, it's an additive RLS change, not a blocker here). Until `applicant_id` is backfilled (the pre-claim state), `applications.applicant_id = auth.uid()` is false for every authenticated user by construction (no session can equal a null column value), so an unclaimed imported application's answers are unreadable by anyone except staff — exactly the "never expose unclaimed records through RLS" requirement, achieved with zero new RLS logic beyond the existing `_select_own` pattern.

## Failure and recovery paths

- **Corrupted/password-protected/macro-enabled workbook**: caught at parse time (step 3), `import_batches.status = 'failed'`, `failure_reason` set, no rows ever staged.
- **Chunk processing failure mid-batch** (e.g. a transient DB error on one chunk): that chunk's transaction rolls back entirely (atomic per chunk, per the spec's "atomic at the appropriate batch or chunk level"), so nothing from a failed chunk is ever partially visible; `next_chunk_offset` is NOT advanced, so a retry (automatic client retry or manual resume) cleanly re-attempts the exact same, still-unapplied chunk from the same offset — no no-op/partial-completion logic is needed here, since atomicity already guarantees the retried chunk starts from a clean slate every time.
- **Downstream stage failure** (feature extraction/clustering/allocation throws): `downstream_status = 'failed'`, prior completed stages' output rows remain untouched and inspectable (they're just rows in `feature_extraction_runs`/`clustering_runs`/etc., same as if run manually), `import_batches.status = 'completed_with_warnings'` — admin can inspect and manually re-trigger the failed stage via the same "Run analysis and allocation" action, which is itself safe to re-run (existing orchestrators are already idempotent/re-runnable by design, confirmed in Phase 5's investigation of `runAllocation`/`stagePublication`).
- **Two admins confirming the same batch simultaneously**: the second `processImportChunk`/`resumeImportBatch` call fails the lock-token check (first admin's token is still valid and unexpired) with a clear "batch is currently being processed by another session" error — no silent double-processing.
- **Invitation send failure** (Supabase Auth Admin API error, matching the intermittent JWT issue documented in Phase 5's final report): `participant_invitations.status = 'failed'`, `last_error` populated, resend is safe (idempotent) and simply retries the same `inviteUserByEmail` call.

## Idempotency and concurrency rules

- **Same file re-uploaded**: detected via `file_checksum` before any staging happens (step 4) — surfaced to the admin, who chooses whether to proceed (e.g. intentionally re-running because the source Excel was regenerated with the same content) or cancel.
- **Same row content across different uploads**: `row_fingerprint` (hash of normalized row) lets the confirm-import step classify a row as `skipped_unchanged` even across different `import_batches` — re-importing the same person with identical answers does not create a duplicate `application_answers` history or a spurious `application_status_history` entry.
- **Confirm called twice on the same batch**: blocked by the status state machine (`confirmImportBatch` requires `status = 'ready_to_import'`; the first call transitions it to `importing`, so a second concurrent call sees the wrong status and is rejected) — same pre-flight-guard pattern as Phase 5's `confirm_publication_transactional`.
- **Claim called twice / by the wrong user**: `claimImportedApplication`'s transaction re-checks `participant_invitations.status = 'sent'` and `invited_user_id = auth.uid()` inside the same transaction that backfills `applicant_id` — a second claim attempt (replay, or a different authenticated user somehow reaching the action) fails the precondition check and writes nothing.

## Rollback rules

- **Before any downstream reference exists** (no `feature_extraction_runs`/`clustering_runs`/`allocation_assignments`/`schedule_publications` row anywhere references an application created or updated by this batch): rollback is permitted.
  - Rows this batch **inserted** (`import_rows.action_taken = 'inserted'`): hard-delete the `applications` row (cascades to `application_answers`, `application_status_history` via existing FK cascade semantics — confirmed `on delete cascade` already exists on `application_status_history.application_id`; `application_answers` gets the same cascade per its DDL above).
  - Rows this batch **updated** (`action_taken = 'updated'`): restore `applications` and `application_answers` from `previous_application_snapshot`/`previous_answers_snapshot`, write a `status_history`/`audit_logs` entry documenting the restoration (not a hard delete — the application existed before this batch touched it).
  - All of this happens in one transaction per batch (or safely chunked the same way import itself is, for very large batches), `import_batches.status → rolled_back`.
- **Once any downstream reference exists** for even one application in the batch: rollback is blocked entirely for the whole batch (not partially) — the admin sees exactly which applications/downstream artifacts are blocking it, and the documented remediation is a **correction/superseding import** (a new batch that updates the same records going forward), never a forced rollback. This matches Phase 5's existing philosophy of "never silently overwrite confirmed/published state."

## What's explicitly out of scope for this phase

- Customizing Supabase's invite email template/branding (uses Supabase defaults; only the redirect landing page is custom).
- A background-job/queue system (deferred; synchronous chunked server actions are sufficient at 5,000-row scale per the performance requirements, to be confirmed empirically during scale testing).
- Any change to the existing self-registration code paths beyond removing them from active navigation (feature-flagged off, not deleted, not modified).
