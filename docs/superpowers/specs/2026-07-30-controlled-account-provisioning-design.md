# Controlled Account Provisioning — Design

Status: **Phase A approved and finalized below. Phases B–G remain design-only, not yet approved.**

Approval record (2026-07-30): decisions on sensitive-data table separation, the two new staff roles, and the bulk-processing UX are final — see §3.3a (Phase A final design) below. Phase A implementation proceeds on schema/RLS/tests only; no provisioning, email, or admin UI code is in scope until Phase A is reviewed and a separate approval is given for Phase D onward.

## 0. Summary

Participants never self-register. An external screening team hands you an Excel file of already-accepted participants. You import it (existing pipeline). Afterward, **you** — not the import step — decide exactly who gets a login, using a new admin table with bulk actions. Account creation always uses the participant's email as username and a fixed temporary password (`password@123`), and every such account is forced through a change-password gate before it can see anything participant-facing.

This does not replace the existing invitation/claim flow (Auth-user-invite-by-email, session-based RPC claim) — that stays intact for any case where an email-link flow is preferred later. It adds a second, admin-controlled provisioning path alongside it.

---

## 1. Current-system findings

Everything below was verified directly against the migrations and source in this repo (see file:line citations); nothing here is assumed.

**`applications`** (`supabase/migrations/20260721202027_applications_table.sql`, extended by 3 later migrations) already has `applicant_id` (nullable, FK → `profiles`), `imported_email`, `import_batch_id`, `last_import_row_fingerprint`, `status` (enum incl. `accepted`), plus ~20 free-text/array columns for personal + application data (`phone, country, nationality, birth_date, age_group, city, organization, field_of_work, preferred_language, interests, climate_experience, experience_level, past_initiatives, participation_goals, topics_to_learn, content_type_pref, track_interests, priority_sessions, special_needs`). Constraint `applications_owner_or_import_identity` requires `applicant_id is not null OR imported_email is not null` — an imported, unclaimed row is a first-class, legal state, not a workaround.

**`application_answers`** is already the free-form key/value overflow table (`question_key, normalized_value, raw_value, value_type, source, is_sensitive`), unique on `(application_id, question_key, source)`, with an `is_sensitive` boolean already wired into RLS (two policies split sensitive vs. non-sensitive access by role). This is closer to what you're calling "sections B/C/D/E" than a single flat table — it already supports per-answer sensitivity, just not yet a coarse **section** classification.

**`profiles`** is intentionally minimal: `id, role, full_name, email, created_at`. No `must_change_password` or any first-login flag exists anywhere in the codebase (verified: zero matches for any password-gating pattern). No `middleware.ts` exists at all — every page does its own `supabase.auth.getUser()` check; there is no request-level gate today.

**The import pipeline** (`import_batches → import_column_mappings → import_rows → apply_import_row_transactional RPC`) already does almost everything §1 of your request asks for: upload, column mapping with confidence scoring, preview, required-field/email validation, in-file duplicate detection, existing-applicant matching (by normalized email), resumable chunked apply (250 rows/chunk, 120s lock TTL), and full rollback with downstream-reference blocking. **Imported rows are inserted directly at `status = 'accepted'`** — there is no draft→accepted transition to hook into; provisioning has to key off *import completion*, not a status change.

**Feature extraction/allocation** already reads a narrow, fixed set of `applications` columns (`interests, track_interests, topics_to_learn, participation_goals, past_initiatives`, plus `preferred_language, experience_level` as hard constraints) — it does **not** read `application_answers` or any travel/health data. Your requested separation (allocation vs. everything else) is **already the actual behavior of the running system** — nothing in the allocation engine needs to change to satisfy "must not affect session suitability." What's missing is that the *admin UI* doesn't yet visually/access-wise separate these concerns the way your spec describes.

**Schedule publication**: participants only ever see their **active** `schedule_publications` row; before one exists, the schedule page already renders an empty state (`schedule/page.tsx:28-40`). This already satisfies §3 of your request with zero changes needed.

**Resend** is a single-email function (`sendRegistrationConfirmationEmail`), no batching/rate-limiting exists. **Supabase Auth admin** usage today is entirely inside `src/lib/import/invitation.ts`: `listUsers` (paginated, 1000/page), `inviteUserByEmail`, `deleteUser`. **No `createUser` or `updateUserById` call exists anywhere** — this design introduces both, for the first time.

---

## 2. Existing tables and flows that can be reused

Reused as-is, no schema change:
- `import_batches`, `import_column_mappings`, `import_rows`, `import_mapping_templates` — the entire upload/map/validate/apply/rollback pipeline (§1 of your request is ~95% already built).
- `apply_import_row_transactional` — continues to be the only writer of `applications`/`application_answers` at import time. Provisioning is **not** added inside this SQL function (Postgres cannot call the Supabase Auth Admin HTTP API) — it happens as a separate, later, explicit admin action.
- `applications.applicant_id` / `imported_email` / the `applications_imported_email_unclaimed_unique` index — this is exactly the ownership model needed; no change to its semantics.
- `application_answers.is_sensitive` — reused as the storage mechanism for section D/E answers; extended (see §3) with an explicit `section` column so the UI/RLS can group by section without re-deriving it from `question_key` string matching every time.
- `feature_extraction_rules` / the extraction pipeline — **unchanged**. It already only reads the allocation-relevant `applications` columns.
- `src/lib/import/invitation.ts`'s `findExistingAuthUserByEmail` pagination helper — reused verbatim as the "does an Auth user already exist for this email" check, shared by the new provisioning code instead of duplicated.
- RLS role-check pattern (`current_user_role() in (...)`) and the `isAgendaStaffRole`/`isAdmissionStaffRole` TS helpers — reused for the new roles this design needs (see §5).

---

## 3. Required migration changes

All additive (new tables/columns), nothing destructive to existing data or behavior.

### 3.1 `profiles` — add password-gate + new granular roles

```sql
alter table profiles add column must_change_password boolean not null default false;
```

Role model: your request implies roles beyond the current 4 (travel/ops staff, participant-care staff, general reviewers with restricted access). Rather than overload `agenda_allocation_manager`/`registration_admission_manager` with meanings they don't have, add to the `user_role` enum:

```sql
alter type user_role add value 'travel_operations_staff';
alter type user_role add value 'participant_care_staff';
```

(`super_admin` remains the universal override, matching every existing RLS policy's pattern of `role in (specific_roles, 'super_admin')`.)

### 3.2 `application_answers` — add a `section` column

```sql
alter table application_answers add column section text not null default 'application'
  check (section in ('profile', 'application', 'allocation', 'travel', 'health'));
```

Why a column instead of relying on `is_sensitive` + `question_key` pattern-matching: your spec names five distinct sections (profile/application/allocation/travel/health), but `is_sensitive` is only a boolean. An explicit `section` lets RLS and the admin UI filter directly (`where section = 'health'`) instead of re-deriving section membership from a hardcoded key list scattered across the app. The **profile fields** (full name, email, age, gender, nationality, city, WhatsApp, education, org, specialization, language, LinkedIn) mostly already exist as `applications` columns or map cleanly onto them — those stay on `applications`/get added there (§3.3), not in `application_answers`; `section='profile'` in `application_answers` is for any profile-shaped field that arrives as a generic import column not already modeled on `applications`.

Backfill plan for the migration: default `'application'` for all pre-existing rows (safe — nothing existing is reclassified as sensitive that wasn't already `is_sensitive=true`), and the import mapping step is responsible for tagging new rows with the correct section going forward (§4).

### 3.3 `applications` — profile/allocation columns (non-sensitive, Phase A)

Profile and allocation-relevant fields not currently modeled as first-class columns are added directly to `applications` — these are already readable by broad staff audiences today (admission + agenda staff), so no new RLS boundary is needed for them:

```sql
-- profile
alter table applications add column gender text;
alter table applications add column whatsapp_number text;
alter table applications add column education_level text;
alter table applications add column institution_or_workplace text;
alter table applications add column linkedin_url text;

-- allocation (secondary track was previously absent — track_interests is multi-value but the business
-- process distinguishes primary/secondary explicitly)
alter table applications add column primary_track text;
alter table applications add column secondary_track text;
```

Both are plain `ADD COLUMN ... ` with no default-required backfill (nullable, additive, non-destructive) — existing rows simply read `null` for these until a future import populates them.

### 3.3a — Phase A final design: sensitive-data separation (APPROVED)

This section is the authoritative, final Phase A design, approved 2026-07-30. It supersedes any earlier draft in this document that suggested column-level grants on `applications` instead of dedicated tables.

**Final table names and relationships**

Two new tables, each in a strict 1:1 relationship with `applications` via a shared primary key that is also the foreign key (no surrogate `id`, no possibility of a participant having two travel-info rows):

- `application_travel_info` — travel, visa, passport, funding, accommodation-operations data.
- `application_health_info` — medical, allergy, accessibility, dietary, emergency-contact, participant-support data.

Both cascade-delete with their parent `applications` row (matching every other child table's existing FK behavior in this schema — `application_answers`, `application_notes`, etc. all use `on delete cascade` from `applications`), so no orphaned sensitive rows can ever exist. Neither table is created with any destructive interaction with `applications`, `application_answers`, or the import pipeline — see the migration/backfill and import-compatibility sections below.

**Exact fields stored in each table**

`application_travel_info`:

| Column | Type | Notes |
|---|---|---|
| `application_id` | `uuid primary key references applications(id) on delete cascade` | shared PK/FK |
| `support_level_requested` | `text` | |
| `can_attend_without_full_support` | `boolean` | |
| `departure_airport` | `text` | |
| `visa_required` | `boolean` | |
| `invitation_letter_required` | `boolean` | |
| `passport_full_name` | `text` | as printed on passport — deliberately distinct from `applications` profile name |
| `passport_issue_date` | `date` | |
| `passport_expiry_date` | `date` | |
| `passport_place_of_issue` | `text` | |
| `passport_copy_storage_path` | `text` | storage bucket path, not the file itself — mirrors `import_batches.storage_path`'s existing pattern |
| `visa_photo_storage_path` | `text` | same pattern |
| `created_at` | `timestamptz not null default now()` | |
| `updated_at` | `timestamptz not null default now()`, `moddatetime` trigger | matches every other table's convention in this schema |

`application_health_info`:

| Column | Type | Notes |
|---|---|---|
| `application_id` | `uuid primary key references applications(id) on delete cascade` | shared PK/FK |
| `allergies` | `text` | |
| `medical_conditions` | `text` | |
| `emergency_medication` | `text` | |
| `accessibility_requirements` | `text` | |
| `dietary_requirements` | `text` | |
| `accommodation_preference` | `text` | |
| `cultural_or_religious_requirements` | `text` | |
| `emergency_contact_name` | `text` | |
| `emergency_contact_phone` | `text` | |
| `consent_given` | `boolean` | |
| `created_at` | `timestamptz not null default now()` | |
| `updated_at` | `timestamptz not null default now()`, `moddatetime` trigger | |

**Role-access matrix (final)**

| Role | `application_travel_info` | `application_health_info` |
|---|---|---|
| `super_admin` | full | full |
| `travel_operations_staff` | full | none |
| `participant_care_staff` | none | full |
| `registration_admission_manager` | none | none |
| `agenda_allocation_manager` | none | none |
| `communications_attendance_manager` | none | none (no future access without a separate, explicit approval) |
| participant (own row, via `applicant_id = auth.uid()`) | own row only, select only (no participant-initiated update in Phase A — these are import-sourced operational fields, not self-service profile fields) | own row only, select only |

No role gets access "merely because it can access the general `applications` table" — both tables have their own independent RLS policies; there is no policy on either new table that references `applications_select_staff` or any existing admission/agenda policy.

**RLS policy design**

```sql
alter table application_travel_info enable row level security;
alter table application_health_info enable row level security;

create policy application_travel_info_staff_all on application_travel_info
  for all
  using (current_user_role() in ('travel_operations_staff', 'super_admin'))
  with check (current_user_role() in ('travel_operations_staff', 'super_admin'));

create policy application_health_info_staff_all on application_health_info
  for all
  using (current_user_role() in ('participant_care_staff', 'super_admin'))
  with check (current_user_role() in ('participant_care_staff', 'super_admin'));

create policy application_travel_info_select_own on application_travel_info
  for select
  using (application_id in (select id from applications where applicant_id = auth.uid()));

create policy application_health_info_select_own on application_health_info
  for select
  using (application_id in (select id from applications where applicant_id = auth.uid()));
```

Both `_staff_all` policies carry an explicit `with check` (not just `using`) — this project's own July-27 privilege-escalation fix (`20260727000000_fix_profiles_role_privilege_escalation.sql`) established that a `for all` policy without `with check` silently reuses the `using` clause for writes, which is correct here anyway, but writing it explicitly matches the hardened pattern that fix introduced and avoids relying on the implicit fallback. `current_user_role()` (the existing `security definer` helper, `20260721212035_rls_policies.sql:2-4`) is reused unchanged.

**Defense in depth — server actions must not rely on RLS alone.** Per your explicit Phase A requirement, every server action that touches either table uses a service-role client (which bypasses RLS entirely) and therefore must independently verify the caller's role before any read/write — mirroring the existing `requireStaffCaller`/`requireAgendaStaffCaller` pattern exactly. Two new helpers are added alongside the existing ones:

```ts
// src/lib/validation/travel-ops.ts
export const TRAVEL_OPS_STAFF_ROLES = ['travel_operations_staff', 'super_admin'] as const;
export function isTravelOpsStaffRole(role: string | null | undefined): boolean {
  return role != null && (TRAVEL_OPS_STAFF_ROLES as readonly string[]).includes(role);
}

// src/lib/validation/participant-care.ts
export const PARTICIPANT_CARE_STAFF_ROLES = ['participant_care_staff', 'super_admin'] as const;
export function isParticipantCareStaffRole(role: string | null | undefined): boolean {
  return role != null && (PARTICIPANT_CARE_STAFF_ROLES as readonly string[]).includes(role);
}
```

No server actions are added in Phase A (no provisioning/UI code per your explicit scope limit) — these two helpers are added now, in Phase A, purely as the shared, testable single source of truth the RLS policies' role lists are cross-checked against, and because "server actions must verify permissions even when using a service-role client" needs *something* concrete to test against in Phase A's test suite (§ Testing below exercises these helpers directly, plus live RLS tests against the tables using both a service-role client explicitly filtered by a caller-role check and a real anon-key session per role, matching the existing `tests/agenda/authorization.test.ts` pattern).

**No exposure through general application-list or generic application-detail queries.** Verified: no existing query anywhere in `src/app/[locale]/(admin)/applications/` or `src/app/[locale]/(admin)/participants/` does a `select('*')` or joins to a table by naming convention/wildcard — every existing query explicitly lists its selected columns (confirmed by the earlier investigation and re-checked against `applications/page.tsx`, `applications/[id]/page.tsx`, `participants/[applicationId]/page.tsx`). Because `application_travel_info`/`application_health_info` are **new, separate tables that nothing currently queries**, no existing query can accidentally start returning their columns — there is no `select('*')` anywhere that would silently start pulling in a joined table's data. This is a structural guarantee from the table split itself, not just a promise to be careful in future code.

**Migration and backfill strategy**

Three new migration files, in this order, each independently safe to run and non-destructive:

1. `..._add_travel_operations_and_participant_care_roles.sql` — `alter type user_role add value` for both new roles, in its own migration file with nothing else in it. Postgres requires a new enum value to be committed before it can be referenced by any policy or check constraint in the same session; isolating it in its own file guarantees that ordering regardless of how Supabase's migration runner batches statements (no precedent for `alter type ... add value` exists yet in this repo, so this is the conservative, correct-by-construction approach rather than assuming batching behavior).
2. `..._application_travel_and_health_info_tables.sql` — creates both tables, enables RLS, adds all 4 policies (2 staff, 2 own-select), adds the `moddatetime` triggers. Also adds `applications.gender/whatsapp_number/education_level/institution_or_workplace/linkedin_url/primary_track/secondary_track` (§3.3) in the same file, since they're additive and unrelated to any ordering constraint.
3. Backfill: **none required**. Both new tables start empty for every existing row — there is no pre-existing travel/health data anywhere in this schema to migrate (confirmed: no such columns ever existed on `applications` or as recognized `application_answers.question_key` values before this design). A participant imported before this migration simply has no `application_travel_info`/`application_health_info` row until a future import (or manual entry, out of Phase A's scope) populates one — this is a legal, expected state, not a data-loss condition. No `insert into application_travel_info select ... from applications` backfill statement is needed or included.

**Rollback strategy**

Each migration is reversible without data loss for anything outside its own new tables:
- Migration 3 (columns on `applications`) rolls back with plain `alter table applications drop column ...` — these are brand-new nullable columns with no data yet referenced by anything else, so dropping them cannot break `apply_import_row_transactional` (that function is not modified in Phase A — see Import Compatibility below) or any other query.
- Migration 2 (new tables + RLS) rolls back with `drop table application_travel_info, application_health_info` — no other table has a foreign key pointing *into* either of these two tables, so the drop cannot cascade-break anything else.
- Migration 1 (enum values) has **no clean rollback** — Postgres does not support removing a value from an enum type without recreating the type entirely (a genuinely destructive, high-risk operation touching every column of that type across every table). This is accepted as a one-way door, consistent with how the existing `user_role` enum has never had a value removed since its original creation. If the two new roles are ever abandoned, the correct remediation is "stop creating profiles with that role," not a type-rewrite migration — documented here so this tradeoff is explicit rather than discovered later.
- None of the three migrations modify, drop, or truncate `applications`, `application_answers`, `import_batches`, `import_rows`, or any existing RLS policy — the entire rollback surface is contained to what Phase A itself creates.

**How the existing Excel import writes to the new tables**

**Phase A itself makes no changes to `apply_import_row_transactional` or any import-pipeline code.** The two new tables exist and are RLS-protected starting with this migration, but nothing writes to them yet — that wiring (extending the row-apply function's dynamic UPDATE/INSERT logic, extending column-mapping suggestions to recognize travel/health headers) is explicitly deferred to Phase B, per your instruction to keep Phase A scoped to schema/RLS/tests only. This means: existing accepted-participant Excel files continue to import exactly as they do today, writing to exactly the same columns and tables as before, with zero behavioral change to the import pipeline. Phase A is purely additive infrastructure sitting alongside the running system, not yet connected to it.

**How original imported answers remain preserved for audit.** Unaffected by Phase A — `application_answers` (with its existing `raw_value`, `normalized_value`, `source`, `import_batch_id` columns) continues to be the durable, unmodified record of every original imported cell exactly as today; Phase A adds no column to it and changes no write path into it. (The `section` column proposed in §3.2's earlier draft is deferred to Phase B alongside the mapping-UI changes it depends on — it is not part of Phase A's migration set, since Phase A explicitly excludes import-pipeline changes and an unused classification column with no writer would be dead schema until Phase B lands.)

### 3.4 New table: `participant_account_provisioning`

The admin account-management table (§4/§7 of your request) needs its own state — it's not just "does an Auth user exist," it's a per-participant record of *what the admin has done*: which batch, temp-password-vs-changed status, email send history, retry state.

```sql
create type provisioning_account_status as enum (
  'no_account', 'account_created', 'login_details_sent',
  'password_change_required', 'active', 'existing_account',
  'creation_failed', 'email_failed', 'conflict'
);

create table participant_account_provisioning (
  application_id uuid primary key references applications(id) on delete cascade,
  import_batch_id uuid references import_batches(id),
  auth_user_id uuid references auth.users(id) on delete set null,
  account_status provisioning_account_status not null default 'no_account',
  is_temporary_password boolean not null default false,
  last_email_status text check (last_email_status in ('not_sent', 'sent', 'failed')) default 'not_sent',
  last_email_at timestamptz,
  last_error text,
  linked_existing_account boolean not null default false,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index participant_account_provisioning_batch_idx on participant_account_provisioning (import_batch_id);
create index participant_account_provisioning_status_idx on participant_account_provisioning (account_status);

create policy participant_account_provisioning_staff_all on participant_account_provisioning
  for all using (current_user_role() in ('registration_admission_manager', 'super_admin'));
```

Why a dedicated table instead of adding columns to `applications`: this state is specific to the *account-provisioning workflow*, has its own lifecycle independent of application review status, and keeping it separate means the account-management table's queries (filter by status, batch, email state) don't compete with or clutter the applications-review table's own indexes/RLS. It also gives a clean 1:1 audit surface: one row per application, always present after first touch, never guessed from scattered signals.

### 3.5 `profiles.must_change_password` enforcement — no DB trigger, application-layer gate

Postgres RLS cannot inspect `auth.users` session claims about "has this password ever been changed" (Supabase doesn't expose that). The gate has to be: (a) set `must_change_password = true` when the admin-provisioning path creates or resets an account, (b) a server-side check in `(participant)/(shell)/layout.tsx` (the shared layout wrapping every participant-facing page) that redirects to a mandatory change-password page whenever `must_change_password = true`, (c) that page calls `supabase.auth.updateUser({ password })` then sets `must_change_password = false` via a service-role action. This mirrors the claim page's existing `updateUser` call — reused pattern, not new API surface.

### 3.6 Column-level grant fix on `profiles`

Current grant (`20260727000000_fix_profiles_role_privilege_escalation.sql:32`) is `grant update (full_name, email) on profiles to authenticated`. `must_change_password` must **not** be authenticated-writable (a participant could self-clear the gate) — it's written only via service-role from the password-change server action, so no grant change is needed there; just confirming this explicitly so implementation doesn't accidentally add it to the authenticated grant list.

---

## 4. Excel-column mapping approach

Reuse the existing mapping UI and `import_column_mappings` table entirely — no new mapping mechanism. Two additions to the *mapping suggestion logic* (`suggestMapping`, called from `map/actions.ts`):

1. **Extend `target_key` coverage** to include every new column from §3.3/§3.4's field list, so the auto-suggestion engine can recognize headers like "WhatsApp Number", "Departure Airport", "Allergies", etc., the same way it already recognizes `phone`/`nationality`/etc. today.
2. **Add a `target_section` alongside `target_kind`**: when a column maps to a `generic_answer` (goes to `application_answers`, not a first-class `applications` column), the admin (or auto-suggestion) must also pick which of the 5 sections it belongs to, driving the new `application_answers.section` value. Columns mapping directly to a first-class column on `applications`, `application_travel_info`, or `application_health_info` don't need this — the destination table already implies the section.

`apply_import_row_transactional` needs a scoped edit (not a rewrite): its dynamic `applications` UPDATE gains the new `applications` columns from §3.3 (profile/allocation fields) to its `v_text_columns`/`v_array_columns` lists, and two new `INSERT ... ON CONFLICT (application_id) DO UPDATE` blocks are added for `application_travel_info`/`application_health_info`, executed only when the mapped row actually has data for those sections (so an import file with no travel columns doesn't create empty travel rows). The `application_answers` upsert gains the `section` value per key from the mapping. This is the only SQL function requiring changes beyond the new tables — everything else in the pipeline (validation, duplicate detection, chunking, rollback) is section-agnostic and untouched.

---

## 5. Data-access and role-permission design

| Role | applications (core) | application_answers (non-sensitive) | application_answers (sensitive) | application_travel_info | application_health_info | provisioning table |
|---|---|---|---|---|---|---|
| `super_admin` | full | full | full | full | full | full |
| `registration_admission_manager` | full (existing) | full (existing) | none (existing) | none | none | full (new) |
| `agenda_allocation_manager` | full (existing, for agenda purposes) | staff view (existing) | none | none | none | none |
| `travel_operations_staff` (new) | read profile/allocation-safe columns only¹ | none | none | full | none | none |
| `participant_care_staff` (new) | read profile-safe columns only¹ | none | none | none | full | none |
| participant (own row) | own row, own columns | own, non-sensitive only (existing) | none | own | own | none |

¹ **Gap acknowledged**: RLS on `applications` today is row-level (`applicant_id = auth.uid()` or full staff access by role), not column-level — `travel_operations_staff`/`participant_care_staff` getting "read-only access to non-sensitive applications columns but not, say, review notes" is a column-level distinction Postgres RLS can't express on the same table. Two options: (a) accept that these two new roles get row-level SELECT on `applications` core columns (which are not sensitive — name/email/track/language, nothing from §D/E since those moved to separate tables) alongside their dedicated table's full access, and simply never grant them `application_notes`/`assigned_reviewer_id`-adjacent UI; or (b) build a Postgres VIEW exposing only the safe subset of `applications` columns and grant these roles SELECT on the view instead of the base table. Recommending **(a)** — simpler, and since sections D/E (the actually sensitive data) are now physically separated into their own tables per §3.3, the remaining `applications` columns readable by these roles are all things already visible to two other staff roles anyway (name, track, language). No new sensitive-data exposure results from row-level-only access here.

`isTravelStaffRole()` / `isParticipantCareStaffRole()` TS helpers added in `src/lib/validation/` alongside the existing `isAgendaStaffRole`/`isAdmissionStaffRole`, following the exact same single-source-of-truth pattern (one exported role-list constant, imported everywhere the check is needed — page gates, server actions, and a mirrored SQL role list in the new RLS policies, kept in sync manually as the existing two pairs already are).

---

## 6. Account-provisioning workflow

**Trigger**: admin-initiated only, from the new account-management table (§7) — never automatic from import. This directly satisfies "importing a participant must not automatically create an Auth account or send an email."

**Core operation** — `provisionParticipantAccount(service, applicationId)`, a new server action:

1. Load the `applications` row; require `applicant_id is null` and `imported_email is not null` (else: not an eligible target — already has an account, or was never an import in the first place).
2. Call `findExistingAuthUserByEmail` (reused from `invitation.ts`, moved to a shared location e.g. `src/lib/auth/find-user-by-email.ts` since it's now used by two features) against `imported_email`.
3. **No existing Auth user** → `auth.admin.createUser({ email, password: 'password@123', email_confirm: true })`. On success: set `applications.applicant_id = <new user id>` (only if still null — re-check on the UPDATE's WHERE clause exactly like `updateApplicationStatus`'s existing optimistic-concurrency pattern), upsert `profiles.full_name` from the imported name field, set `profiles.must_change_password = true`, upsert `participant_account_provisioning` to `account_status = 'account_created', is_temporary_password = true, auth_user_id = <id>`.
4. **Existing Auth user found** → do not touch its password. If that Auth user has no `applications` row yet owning this email's application, link: `applications.applicant_id = <existing id>` (again, only if still null). Mark provisioning row `account_status = 'existing_account', linked_existing_account = true`. If the existing user is already linked to a *different* application, do **not** overwrite — mark `account_status = 'conflict'`, `last_error` describing the collision, and leave both applications untouched (matches your "never overwrite an application already owned by another Auth user" requirement exactly).
5. Every step wrapped so a single participant's failure (Auth API error, DB write error) is caught, recorded as `account_status = 'creation_failed'`/`'conflict'`, `last_error` populated, and does **not** abort the batch — mirrors the existing import chunk loop's per-row isolation pattern (`applyOneRow`'s try/catch in `confirm/actions.ts`).

**Reset-to-temporary-password action** (explicit, separate action, never silently invoked): `auth.admin.updateUserById(userId, { password: 'password@123' })`, sets `profiles.must_change_password = true`, `participant_account_provisioning.is_temporary_password = true`. Requires a typed/explicit confirmation in the UI (matches this project's established pattern for irreversible actions, e.g. the schedule-publication confirmation gate built earlier).

**Login-details email** — new function in `src/lib/email/resend.ts`, `sendLoginDetailsEmail({ to, fullName, locale })`, bilingual, containing exactly the fields your spec lists (username = email, password = `password@123`, login URL, change-password instruction, support contact). Called only for participants explicitly selected in a "send login details" bulk action, never as a side effect of account creation alone (satisfies "Create accounts for selected participants" being a distinct action from "Create accounts **and send** login details").

---

## 7. Admin table and bulk-action UX

New route: `src/app/[locale]/(admin)/participants/accounts/` (staff-gated, `isAdmissionStaffRole` — since `registration_admission_manager` is the role your provisioning-table RLS grants access to).

**Table** — one row per `applications` row that is either unclaimed-imported (`imported_email is not null`) or already linked, joined against `participant_account_provisioning`:

| Column | Source |
|---|---|
| checkbox | client state |
| participant name | `applications` profile fields |
| username | `applications.imported_email` (normalized) |
| temporary password | `password@123` while `is_temporary_password = true`, else literal text "Password changed" — **never** any other real password value, matching your explicit requirement |
| import batch | `import_batches.original_filename` / uploaded date, via `participant_account_provisioning.import_batch_id` |
| profile status | derived from `applications.status` |
| allocation status | derived from latest `allocation_assignments` presence for this application |
| account status | `participant_account_provisioning.account_status` |
| login-email status | `last_email_status` |
| last email date | `last_email_at` |
| actions | row-level: create account / send login details / resend / reset password |

**Selection**: standard checkbox-per-row + header "select all visible" (scoped to the current filtered/paginated view, not the whole table — avoids a silent 5000-row select-all footgun) + explicit "clear selection" button. Selection state lives client-side, keyed by `application_id`, survives pagination within a session (matches the pattern already used in the import preview table's row-selection, per the "preview-table.tsx" file already found by the investigation).

**Filters**: search (name/email, debounced), batch dropdown, account-status multiselect, email-status multiselect, and three canned toggle filters (no account / no login details sent / failed-or-conflict) — implemented as compound query params on the page, matching this project's existing filter-URL-param convention on other admin list pages.

**Bulk actions**, each a distinct server action, each operating only on the explicit selected-id list (never "all matching filter" implicitly — satisfies "unselected participants must remain completely untouched"):
- `createAccountsForSelected(applicationIds)`
- `createAccountsAndSendLoginDetails(applicationIds)`
- `sendLoginDetailsForSelected(applicationIds)` — existing accounts only
- `resendLoginDetails(applicationIds)`
- `retryFailedForSelected(applicationIds)` — re-runs provisioning only for rows currently in `creation_failed`/`conflict`/`email_failed`, skipping anything already succeeded
- `resetToTemporaryPassword(applicationIds)` — requires typed confirmation per §6

**Pre-execution confirmation dialog**: computed client-side from the current selection + each row's known `account_status` (no extra round-trip needed — the table already has this data loaded): counts for selected / new accounts / existing accounts / emails to send / conflicts-or-skipped, exactly as specified.

**Progress/results after execution**: since these are potentially long-running bulk operations (§8 covers 500+ scale), the action returns a per-row outcome list; UI renders a results summary (selected / created / linked / sent / failed / conflicts / skipped / remaining) and updates each row's status in place without a full page reload.

---

## 8. Email-processing approach for 500+ participants

Two independent concerns: **Auth Admin API calls** (create/update user) and **Resend email sends** — neither has an existing batch API in this codebase, and neither Supabase Auth Admin nor Resend's standard send endpoint offers true server-side bulk batching for this shape of operation, so this is chunked-sequential-with-bounded-concurrency, mirroring the exact pattern already proven in the import pipeline (`ROW_CONCURRENCY = 15` in `confirm/actions.ts`):

- Bulk actions process the selected id list in chunks (e.g. 50 at a time) with bounded concurrency (e.g. 10 concurrent) per chunk — same rationale as the import loop: network round-trip latency dominates, and uncapped concurrency risks tripping Supabase/Resend rate limits.
- Each participant's provisioning + email send is fully isolated (try/catch per item, non-aborting) — one failure never stops the batch, matching `applyOneRow`'s established pattern exactly.
- Progress is reported incrementally back to the UI (either via a returned running total after each chunk, using the same polling/chunk-call shape as the import UI's chunk progress bar, or a simple server action that processes everything and returns a final tally — recommend reusing the import UI's proven chunked-polling pattern rather than inventing a new one, since it already handles resumability-on-failure).
- Retry-only-failed (§8's explicit requirement) is a query filter, not new logic: `retryFailedForSelected` re-derives its working set as `selected ∩ {status in ('creation_failed','conflict','email_failed')}` before dispatching, so a full re-run of a large batch after partial failure never repeats already-successful work.

---

## 9. First-login password-change flow

1. Server action (§6) sets `profiles.must_change_password = true` at account creation or explicit reset.
2. `(participant)/(shell)/layout.tsx` (the shared server-component layout every participant page already renders through) adds one additional read: fetch `profiles.must_change_password` alongside the existing profile fetch it already does, and `redirect()` to a new `/change-password` route if true — for every route under that layout (dashboard, my-application, schedule, QR code, etc.), satisfying "block access to... other protected participant pages" as a single shared choke point rather than per-page checks that could be missed.
3. `/change-password` page (new, under `(participant)/(bare)/` alongside `claim/` and `register/` since it also needs to work before the user has "normal" shell access) — form calls `supabase.auth.updateUser({ password })` client-side (reusing the exact pattern from `claim/page.tsx:183`), then a server action sets `must_change_password = false` and `participant_account_provisioning.is_temporary_password = false, account_status = 'active'` via service-role.
4. New password is **never** read back or displayed anywhere — satisfied automatically, since nothing in this design ever stores or re-reads the post-change password; Supabase Auth stores only its hash.

---

## 10. Failure handling and retry design

Every provisioning/email operation writes its outcome to `participant_account_provisioning` before moving to the next item (not batched at the end) — this is what makes retry-only-failed correct even if the whole process is interrupted (browser closed, server restarted) partway through a large batch: the table itself is the resumable state, no separate job-queue table needed. This mirrors `import_rows.action_taken`'s role in the import pipeline's own resumability.

Failure categories map directly to your requested statuses:
- Auth API error on create → `creation_failed`, `last_error` = raw message.
- Email send error → `email_failed` (account itself may still be `account_created`/`active` — these are independent axes, not conflated into one status).
- Email already belongs to a different application's owner → `conflict`, never auto-resolved.
- Everything else succeeding → `account_created` → (after email sent) `login_details_sent` → (after first login + password change) `active`.

---

## 11. Testing plan

Following this project's established test conventions (unit tests for pure logic, live-Supabase integration tests for anything touching Auth Admin API or RLS, `*-live.test.ts` naming):

- **Unit**: `provisionParticipantAccount`'s branch logic (new user / existing user / conflict / already-linked) with a mocked service client — mirrors the existing test style for `sendInvitation`.
- **Live**: a `tests/import/account-provisioning-live.test.ts` exercising real `auth.admin.createUser` against the test Supabase project, covering: fresh email creates account + sets `applicant_id`; pre-existing Auth user with no application link gets linked; pre-existing Auth user already owning a different application produces `conflict` and touches nothing; reset-to-temporary-password actually changes the password and sets `must_change_password`.
- **RLS live tests**: new tests analogous to existing `tests/agenda/authorization.test.ts` pattern, verifying `travel_operations_staff` can read `application_travel_info` but not `application_health_info` or sensitive `application_answers`, and vice versa for `participant_care_staff`; verifying `registration_admission_manager`/`agenda_allocation_manager` get zero rows from both new tables.
- **Password-gate test**: a live test signing in as a `must_change_password = true` user and asserting every participant-shell route redirects to `/change-password`, then asserting normal access resumes after the flag clears.
- **Bulk-action isolation test**: seed a mixed batch (some destined to succeed, one deliberately forced to fail — e.g. malformed email) and assert the failure doesn't block the others, and that `retryFailedForSelected` only re-touches the failed one.
- Existing import/allocation/schedule test suites are **not expected to need changes** — the design deliberately keeps `apply_import_row_transactional`'s existing behavior for already-modeled columns unchanged, only adding new column handling and two new upserts.

---

## 12. Phased task list

**Phase A — Schema**
1. Migration: `profiles.must_change_password`, new enum roles.
2. Migration: `application_answers.section`.
3. Migration: `application_travel_info`, `application_health_info` tables + RLS.
4. Migration: new `applications` columns (profile + allocation fields only — travel/health now live on their own tables).
5. Migration: `participant_account_provisioning` table + RLS.
6. Regenerate `src/types/database.ts`; update `tests/lib/nav/nav-config.test.ts`-style schema-drift tests if any exist for these tables.

**Phase B — Import pipeline extension**
7. Extend `suggestMapping` target-key coverage + add `target_section` to the mapping UI for generic answers.
8. Extend `apply_import_row_transactional`: new `applications` columns in the dynamic UPDATE; new `application_travel_info`/`application_health_info` upsert blocks; `section` value on `application_answers` upserts.
9. Update `tests/import/*` for the extended row-apply behavior (new columns present/absent cases).

**Phase C — Role & access plumbing**
10. Add `isTravelStaffRole`/`isParticipantCareStaffRole` TS helpers + wire into every relevant page/action gate.
11. Verify/extend `admin-nav-visibility.ts` (the filter built earlier this session) to cover any new nav entries these roles need.

**Phase D — Provisioning core**
12. `src/lib/auth/find-user-by-email.ts` — extract the shared pagination helper out of `invitation.ts`.
13. `provisionParticipantAccount` action (create/link/conflict logic, §6).
14. `resetToTemporaryPassword` action.
15. `sendLoginDetailsEmail` in `resend.ts`.
16. Unit + live tests for the above (§11).

**Phase E — Admin UI**
17. `(admin)/participants/accounts/` table page: query, filters, search, pagination.
18. Selection state + bulk-action confirmation dialog.
19. Bulk-action server actions with chunked/bounded-concurrency execution + per-item outcome persistence (§8).
20. Progress/results UI.

**Phase F — First-login gate**
21. `/change-password` page + server action.
22. `(participant)/(shell)/layout.tsx` redirect gate.
23. Live test: full gate round-trip (§11).

**Phase G — Verification & merge**
24. Full regression pass: existing import/allocation/schedule/claim test suites unchanged and green.
25. tsc/lint/build.
26. Spec-compliance + code-quality review (matching this project's established review discipline for feature-sized work).
27. Merge-readiness report, following the same format used for Phase 5.5.

---

## §Ω (superseded) Open questions from the original draft

The 3 open questions originally listed here were resolved by your Phase A approval (2026-07-30): table-split approach confirmed, role names confirmed, bulk-processing UX approach confirmed. See §3.3a for the final Phase A design and §13 below for Phase B.

---

## 13. Phase B — accepted-participant import wiring (design, pending approval)

Phase A created the schema (`application_travel_info`, `application_health_info`, 7 new `applications` columns, 2 new roles, RLS). **Nothing writes to any of it yet.** Phase B connects the existing import pipeline to it. Scope, per your instructions: mapping, validation, the SQL apply/rollback functions, and the mapping/preview UI only. No account provisioning, temporary passwords, emails, or admin account-management UI.

### 13.1 Current-system findings (verified, not assumed)

- **Mapping suggestion** (`src/lib/import/mapping-suggestion.ts` + `src/lib/import/field-dictionary.ts`) already has real bilingual support: `KNOWN_FIELDS` is a flat array of `{ key, kind, isCriticalIdentity, aliases: string[] }`, each with both English and Arabic alias strings, scored via Levenshtein similarity + substring-containment boost, gated at `MIN_PLAUSIBLE_SCORE = 0.5`. Extending it is **additive only** — appending new entries, per the file's own header comment ("Extending this list is the ONLY place new known fields need to be added").
- **`target_kind`** is `core_field | known_answer | generic_answer | ignored` — a flat 4-way classification with **no concept of "section" or "sensitivity" today**. `generic_answer` is the catch-all for anything not in the dictionary; it has no further subdivision.
- **There is no `KNOWN_APPLICATION_COLUMNS` constant anywhere.** The dictionary (TypeScript, drives suggestions only) and the SQL function's `v_text_columns`/`v_array_columns` arrays (drive actual writes) are two independently-maintained lists that happen to overlap. This is a pre-existing gap, not introduced by Phase B — but Phase B's new fields make the gap larger if not addressed (see 13.3).
- **`apply_import_row_transactional`** (current definition: `20260727030000_gate_existing_claimed_updates.sql`) writes every normalized key to `application_answers` unconditionally via a `jsonb_each` loop, **regardless of whether that key is also a first-class column** — a key that lands on an `applications` column is written to *both* `applications` and `application_answers` today (this is why "original imported answers remain preserved for audit" already holds structurally: the answers-table write is never skipped just because a column-table write also happened). Phase B's new travel/health writes will follow the exact same pattern: write to the sensitive table AND leave the original answer in `application_answers` untouched.
- **Row-validation has real gaps** relevant to your explicit test requirements: `normalizePhone` does no shape validation at all (trim only); `birth_date` has no validation at the JS layer — an unparseable date is silently discarded 3 layers downstream inside the SQL function's cast (wrapped in a swallow-and-continue exception block), with no warning ever surfaced to the preview UI. Phase B must not silently extend this same gap to `passport_issue_date`/`passport_expiry_date` — see 13.5.
- **Multi-select splitting** (`splitMultiSelect`) is a hardcoded `/[,;\n]+/` regex — comma, semicolon, or newline, not configurable. Reused as-is for the new multi-select allocation fields (priority focus areas per track, languages usable in sessions).
- **Feature extraction reads exactly 5 `applications` columns** (`interests, track_interests, topics_to_learn, participation_goals, past_initiatives`) and **nothing** from `application_answers`, `application_travel_info`, or `application_health_info` — confirmed by grep, zero references. This is the structural guarantee that sensitive data cannot influence allocation scores: Phase B does not need to add any exclusion logic, because the allocation code simply never queries the new tables. The risk is entirely on the *mapping* side (an admin could technically map a travel/health header to `target_key = 'interests'`) — addressed in 13.3/13.9.
- **No file-upload/attachment handling exists anywhere in the import pipeline today.** The only Storage interaction is the Excel file itself, uploaded to the private `import-uploads` bucket at `${userId}/${timestamp}-${uuid}.xlsx`. Phase A's `passport_copy_storage_path`/`visa_photo_storage_path` columns were designed to mirror this convention but nothing populates them yet.
- **Rollback** (`rollback_import_batch_transactional`, current definition `20260726109600_rollback_safety_fixes.sql`) restores `applications` from a full-row jsonb snapshot and does a delete-and-reinsert of `application_answers` from its own snapshot. It has zero knowledge of the two new tables (they didn't exist when it was written). Its own trailing comment states the restorable-column list "MUST stay in sync with apply_import_row_transactional... update both together" — Phase B must extend both functions together, not just one.
- **Test fixtures** (`tests/fixtures/import/build-fixtures.ts`) currently populate only 9 fields (full name, email, phone, country, city, organization, interests, experience level, birth date) and already have EN/AR/mixed header fixtures. None of Phase A's or Phase B's new fields are populated by any existing fixture.

### 13.2 Google Form → internal field mapping (exact list, per your §2/§3/§4/§5)

All entries below are additive to `KNOWN_FIELDS`. `kind` follows the existing convention: `core_field` for anything landing directly on an `applications` (or new sensitive-table) column via a first-class destination, `known_answer` for anything that stays in `application_answers` under a stable `question_key` but is still recognized/suggested. Arabic aliases are placeholders reflecting common Google Form phrasing — **you should review/correct these against the actual form headings** before Phase B is implemented; I do not have the real form text.

**§2 — Participant profile → `applications` columns (Phase A) + `application_answers` (specialization, if no dedicated column)**

| `target_key` | Destination | EN alias (example) | AR alias (example) |
|---|---|---|---|
| `full_name` | `applications.full_name`-equivalent¹ | Full Name | الاسم الكامل |
| `email` | `applications.imported_email` | Email | البريد الإلكتروني |
| `age_group` | `applications.age_group` (existing) | Age | العمر |
| `gender` | `applications` (Phase A) | Gender | الجنس |
| `nationality` | `applications.nationality` (existing) | Nationality | الجنسية |
| `country` | `applications.country` (existing) | Country of Residence | بلد الإقامة |
| `city` | `applications.city` (existing) | City of Residence | مدينة الإقامة |
| `whatsapp_number` | `applications` (Phase A) | WhatsApp Number | رقم الواتساب |
| `education_level` | `applications` (Phase A) | Educational Level | المستوى التعليمي |
| `institution_or_workplace` | `applications` (Phase A) | Institution / Workplace | الجهة / مكان العمل |
| `field_of_work` (specialization) | `applications.field_of_work` (existing) | Specialization | التخصص |
| `preferred_language` | `applications.preferred_language` (existing) | Preferred Communication Language | لغة التواصل المفضلة |
| `linkedin_url` | `applications` (Phase A) | LinkedIn / Portfolio | لينكدإن / ملف الأعمال |
| `primary_track` | `applications` (Phase A) | Primary Track | المسار الأساسي |
| `secondary_track` | `applications` (Phase A) | Secondary Track | المسار الثانوي |

¹ **Note**: `applications` has no `full_name` column today (confirmed in Phase A investigation) — full name currently only exists as an `application_answers` row. Phase B needs to decide: add `applications.full_name` as a first-class column (recommended — it's used constantly: preview table, provisioning-table §7 of the earlier design, emails), or continue leaving it answers-only. **Recommendation: add it in Phase B's migration**, since it's a profile field your own spec lists first and the account-management table (Phase D+) will need to display it as a real column, not a joined answer lookup.

**§3 — Application & allocation answers → `application_answers` (existing table, `question_key`s below), all `known_answer`**

| `question_key` | EN alias | AR alias | Feeds allocation? |
|---|---|---|---|
| `session_languages` | Languages Usable in Sessions | اللغات المستخدمة في الجلسات | Yes (new — see 13.4) |
| `climate_interest_areas` | Climate/Environmental Interest Areas | مجالات الاهتمام البيئي | Yes (maps to existing `interests`) |
| `volunteer_experience_years` | Years of Volunteer/Environmental Experience | سنوات الخبرة التطوعية/البيئية | Yes |
| `previous_conference_participation` | Previous Conference/Initiative Participation | المشاركة السابقة في مؤتمرات/مبادرات | Yes |
| `initiative_or_organization_name` | Initiative/Organization Name | اسم المبادرة أو الجهة | Yes |
| `organization_role` | Organization and Current Role | الجهة والدور الحالي | Yes |
| `personal_introduction` | Personal Introduction | نبذة شخصية | Reference only² |
| `significant_achievement` | Significant Environmental Achievement | أبرز إنجاز بيئي | Reference only² |
| `reason_for_joining` | Reason for Joining RCOY | سبب الانضمام لـ RCOY | Reference only² |
| `expected_contribution` | Expected Contribution | المساهمة المتوقعة | Yes |
| `expected_skills_experiences` | Skills/Experiences Expected | المهارات/الخبرات المتوقع اكتسابها | Yes |
| `community_impact_plan` | Community Impact Plan | خطة الأثر المجتمعي | Reference only² |
| `priority_focus_track1` | Priority Focus Areas — Track 1 | مجالات الأولوية — المسار الأول | Yes |
| `priority_focus_track2` | Priority Focus Areas — Track 2 | مجالات الأولوية — المسار الثاني | Yes |
| `priority_focus_track3` | Priority Focus Areas — Track 3 | مجالات الأولوية — المسار الثالث | Yes |

² Your spec lists these under "Application and evaluation answers... remain available for authorized admin reference, but must not all be used automatically for session allocation" — flagged here as reference-only since they're free-text narrative, not structured signal; feature-extraction rules could theoretically be added against them later, but none are proposed in Phase B.

**§4 — Travel/visa → `application_travel_info` (Phase A table), all `core_field`, new `target_kind` value needed (see 13.3)**

| `target_key` | Column | EN alias | AR alias |
|---|---|---|---|
| `support_level_requested` | `support_level_requested` | Requested Support Level | مستوى الدعم المطلوب |
| `can_attend_without_full_support` | `can_attend_without_full_support` | Able to Attend Without Full Support | القدرة على الحضور بدون دعم كامل |
| `departure_airport` | `departure_airport` | Departure Airport / City / Country | مطار/مدينة/بلد المغادرة |
| `visa_required` | `visa_required` | Visa Required | يتطلب تأشيرة |
| `invitation_letter_required` | `invitation_letter_required` | Stamped Invitation Letter Required | يتطلب خطاب دعوة مختوم |
| `passport_full_name_ar` | *(new column, see 13.3)* | Full Passport Name (Arabic) | الاسم الكامل في جواز السفر (عربي) |
| `passport_full_name_en` | `passport_full_name` (rename/reuse, see 13.3) | Full Passport Name (English) | الاسم الكامل في جواز السفر (إنجليزي) |
| `passport_birth_date` | *(new column, see 13.3)* | Date of Birth (Passport) | تاريخ الميلاد (جواز السفر) |
| `passport_place_of_issue` | `passport_place_of_issue` | Passport Place of Issue | مكان إصدار جواز السفر |
| `passport_issue_date` | `passport_issue_date` | Passport Issue Date | تاريخ إصدار جواز السفر |
| `passport_expiry_date` | `passport_expiry_date` | Passport Expiry Date | تاريخ انتهاء جواز السفر |
| `passport_copy_storage_path` | `passport_copy_storage_path` | Passport Copy (file reference only — see 13.8) | صورة جواز السفر |
| `visa_photo_storage_path` | `visa_photo_storage_path` | Visa Photograph (file reference only — see 13.8) | صورة شخصية للتأشيرة |

**§5 — Health/accessibility → `application_health_info` (Phase A table), all `core_field`, same new `target_kind` value**

| `target_key` | Column | EN alias | AR alias |
|---|---|---|---|
| `allergies` | `allergies` | Allergy Status and Details | الحساسية وتفاصيلها |
| `medical_conditions` | `medical_conditions` | Medical Conditions | الحالات الطبية |
| `emergency_medication` | `emergency_medication` | Emergency Medication | أدوية الطوارئ |
| `accessibility_requirements` | `accessibility_requirements`³ | Disability/Accessibility Status & Accommodations | الإعاقة/احتياجات الوصول |
| `dietary_requirements` | `dietary_requirements`³ | Dietary Requirements | المتطلبات الغذائية |
| `accommodation_preference` | `accommodation_preference` | Accommodation Preference | تفضيلات الإقامة |
| `cultural_or_religious_requirements` | `cultural_or_religious_requirements` | Religious/Cultural/Organizational Requirements | متطلبات دينية/ثقافية/تنظيمية |
| `emergency_contact_name` | `emergency_contact_name`³ | Emergency Contact Name | اسم جهة اتصال الطوارئ |
| `emergency_contact_relationship` | *(new column, see 13.3)* | Emergency Contact Relationship | صلة القرابة بجهة اتصال الطوارئ |
| `emergency_contact_phone` | `emergency_contact_phone`³ | Emergency Contact Phone | هاتف جهة اتصال الطوارئ |
| `consent_given` | `consent_given` | Consent | الموافقة |

³ These 4 keys **already exist** in `KNOWN_FIELDS` today as `known_answer` entries destined for `application_answers` (with `is_sensitive = true` there). Phase B redirects them to the new dedicated table instead — this is the one place Phase B changes existing dictionary entries rather than purely adding new ones (details in 13.3).

### 13.3 Required migration changes (Phase B's own, separate from Phase A's)

1. **`applications.full_name`** — new nullable `text` column (see 13.2 footnote 1). Additive.
2. **`application_travel_info`**: add `passport_full_name_ar text`, `passport_birth_date date` (distinct from the participant's own `applications.birth_date`, since a passport DOB should be authoritative for travel documents even if it differs from a self-reported age-group elsewhere). Rename consideration: keep `passport_full_name` as-is and treat it as the English name (`passport_full_name_en` alias in mapping only, no column rename — renaming a Phase-A-just-shipped column is unnecessary churn for zero benefit; the mapping layer's `target_key` string doesn't have to equal the DB column name).
3. **`application_health_info`**: add `emergency_contact_relationship text`.
4. **New `target_kind` enum value**: `alter table import_column_mappings drop constraint import_column_mappings_target_kind_valid; alter table import_column_mappings add constraint import_column_mappings_target_kind_valid check (target_kind in ('core_field', 'known_answer', 'generic_answer', 'ignored', 'travel_field', 'health_field'));` — **why a new kind instead of reusing `core_field`**: `core_field` today means "goes on `applications`" implicitly, consumed by the SQL function's `v_text_columns`/`v_array_columns` arrays. Introducing `travel_field`/`health_field` as distinct kinds gives the SQL apply function (and the mapping UI) an explicit, checkable signal for "this must go to the sensitive table, never to `applications` or a plain `application_answers` row without the section tag" — turning "don't let travel/health data leak into allocation" from a convention into a constraint the mapping layer itself enforces (an admin cannot mis-map a travel column as `core_field` pointing at, say, `interests`, because `passport_full_name` is never a valid `target_key` for `core_field`+the fixed `v_text_columns` list — see 13.9 for the UI-side enforcement, and 13.6 for why this alone isn't sufficient and a second server-side check is added too).
5. **`application_answers.section`** (deferred from Phase A's original draft, now actually needed): `alter table application_answers add column section text not null default 'application' check (section in ('profile', 'application', 'allocation', 'travel', 'health'));` — used so `application_answers` rows for §3's allocation-relevant keys are tagged distinctly from generic/unmapped answers, giving the future admin UI (Phase E+) a filter without re-deriving section from `question_key` string matching.

All 5 changes are additive/non-destructive. None touch existing data (the `target_kind` constraint change only widens the allowed set; existing rows keep their existing values).

### 13.4 Allocation feature-extraction change (new rule source fields, not new tables)

Your §3 lists several §3 answers as allocation-relevant that aren't among the 5 columns `run-extraction.ts` currently reads (`interests, track_interests, topics_to_learn, participation_goals, past_initiatives`). Two are already covered by existing columns your mapping should target directly (`climate_interest_areas` → `interests`, general track preference → `primary_track`/`secondary_track` — new, see 13.9 for how allocation should incorporate them). The genuinely new inputs — `session_languages`, `priority_focus_track1/2/3` — require `run-extraction.ts`'s query and `ExtractionRule.sourceField`'s union type to gain new allowed values. **This is a Phase B code change to `src/lib/allocation/feature-extraction.ts`/`run-extraction.ts`, not a schema change** (both fields land as `application_answers` rows in Phase B per 13.2, so extraction needs to read `application_answers` for these specific keys in addition to its existing `applications` column read — a materially new capability for that module, worth flagging as the single highest-risk code change in Phase B since it's the first time feature-extraction ever reads from `application_answers`). Given your explicit constraint that Phase B must not let sensitive data influence scores, this extension is scoped tightly: it adds exactly `session_languages` and `priority_focus_track1/2/3` (plus reading `primary_track`/`secondary_track` directly off `applications`) as new allowed `sourceField` values — it does not open extraction up to reading arbitrary `application_answers` keys.

### 13.5 Validation extensions (closing gaps your test list explicitly calls out)

- **Date validation**: add explicit JS-layer validation for `passport_issue_date`, `passport_expiry_date`, `passport_birth_date` in `row-validation.ts` (currently `birth_date` has none — Phase B does not "fix" the pre-existing `birth_date` gap since that's out of scope, but does not repeat the gap for the 3 new passport dates). An unparseable date produces a row **warning** (not a hard error — matching your explicit requirement that "invalid rows can be corrected or excluded," not silently blocked) surfaced in the preview UI, with the raw value still preserved verbatim in `application_answers`/the sensitive table's own text-fallback (see 13.6 for the "never silently drop" mechanism).
- **Phone validation**: add a permissive format check (E.164-ish: optional `+`, digits, spaces/dashes allowed, minimum digit count) for `whatsapp_number` and `emergency_contact_phone` — warning-level, not blocking, consistent with `normalizePhone`'s existing "preserve original formatting" philosophy. Malformed phones are flagged for admin review, not silently accepted or silently dropped.
- **Multi-select fields**: `session_languages`, `priority_focus_track1/2/3` join `MULTISELECT_KEYS`, reusing `splitMultiSelect` unchanged.

### 13.6 Transactional behavior — the exact answer to your §6 question

**Decision: a single participant row's sensitive-data write failure rolls back that participant's entire row-apply (application + answers + travel + health), and the row is stamped `skipped_error` — never a silent partial import.**

Concretely: `apply_import_row_transactional` already runs as one Postgres transaction per row (this is true today, unchanged) — Phase B adds the `application_travel_info`/`application_health_info` upserts **inside the same existing transaction**, after the `application_answers` loop. Since the whole function has no swallowing `exception when others` block (confirmed in the investigation — this is a deliberate, existing invariant), any error raised by the new upsert statements aborts the entire per-row transaction exactly like any other statement in the function today: the `applications` write, the `application_answers` writes, and the new sensitive-table writes either all land together or none do. At the call-site level (`confirm/actions.ts`'s `applyOneRow`), this surfaces exactly like today's existing per-row failure path: caught, the row is stamped `skipped_error`, and the chunk continues — one participant's malformed passport data can never silently drop their travel info while still marking them imported, and it can never abort the whole batch either. This directly satisfies "it must never silently import the participant while dropping supplied passport, travel, medical, or emergency data" — the only two outcomes are "everything for this row lands" or "nothing for this row lands, flagged as a failure for admin retry."

**Empty-sensitive-data case** (your explicit "avoid creating empty sensitive rows when all related fields are blank"): the new upsert blocks are conditionally executed — only run `insert into application_travel_info (...) values (...) on conflict (application_id) do update ...` if at least one mapped travel `target_key` was actually present with a non-blank value in this row's `normalized_row`; same for health. A participant with zero travel-mapped columns gets no `application_travel_info` row at all (matches Phase A's "legal, expected state" framing for pre-Phase-B rows).

**Idempotent re-import**: reuses the existing `last_import_row_fingerprint` short-circuit unchanged — if a re-imported row's fingerprint matches, the entire row (including the new sensitive-table upserts) is already skipped via the existing `skipped_unchanged` path before any write is attempted, so re-import is automatically idempotent for the new data too, with zero new logic needed. If the fingerprint differs (something changed), the existing update path re-runs and the new upserts use `on conflict (application_id) do update`, so a changed travel/health field on re-import correctly overwrites the prior value rather than erroring or duplicating.

### 13.7 Original source preservation — confirmed by existing behavior, extended consistently

Already true structurally (13.1): every normalized key is written to `application_answers` regardless of whether it also lands on a first-class column. Phase B's new travel/health `target_key`s follow the identical pattern — a `travel_field`/`health_field`-classified column still flows through the same `jsonb_each` loop into `application_answers` (tagged `section = 'travel'`/`'health'` per 13.3's new column), so the original imported cell value is preserved there **in addition to** the normalized write into `application_travel_info`/`application_health_info`. Nothing in Phase B removes or bypasses the existing answers-preservation mechanism.

### 13.8 File references — Google Drive upload handling (documented limitation, not solved)

Investigated: Google Forms' native file-upload question type exports, in the response spreadsheet, a **Google Drive share-link URL** per response (not a file, not a downloadable blob directly usable server-side without separate Drive API authorization this project does not have). No code anywhere in this repo parses or fetches Google Drive URLs, and no Storage-upload-during-import logic exists.

**Phase B decision, per your explicit instruction #8**: do **not** attempt to download and re-host these files into Supabase Storage — that would require Google Drive API credentials/OAuth this project has never set up, is a meaningfully separate integration effort, and silently "succeeding" at a partial/broken transfer is exactly the failure mode you told me to avoid pretending doesn't exist. Instead: `passport_copy_storage_path`/`visa_photo_storage_path` store the **original Google Drive URL string verbatim**, imported as plain text via the normal mapping mechanism (both fields are `core_field`/`travel_field` `target_key`s pointing at those two columns). The column names remain accurate to their Phase A intent (a "reference," not a raw URL type) but Phase B does not add a checked/typed URL format or attempt link validation beyond basic non-empty presence — it is documented here, explicitly, as: **these two columns currently hold a Google Drive link, not a secure Supabase Storage path, until a future phase adds real Drive-to-Storage transfer.** No sensitive file URL is ever exposed through a generic `applications`/`application_answers` query (it only ever lives in `application_travel_info`, which is already RLS-restricted to `travel_operations_staff`/`super_admin`) — but the underlying Drive link itself carries whatever access model Google Drive's own sharing settings impose, which this platform does not control. This limitation should be read aloud to you plainly in the Phase B completion report, not softened.

### 13.9 Mapping/preview UX changes

- **`mapping-table.tsx`**: group the flat column list into 5 visual sections (Participant profile / Application & allocation / Travel & visa / Health & accessibility / Unmapped) — computed client-side from each row's current `targetKind`/`targetKey` against the (now-shared, see below) known-field list, not a new server round-trip. Rows with `targetKind in ('travel_field', 'health_field')` get a visible "Restricted" badge (red/amber, matching the existing `needsReview`/`lowConfidence` badge pattern already in this file) so an admin editing the mapping sees at a glance which columns are sensitive before ever reaching preview/confirm.
- **A shared `KNOWN_APPLICATION_COLUMNS`-equivalent** is introduced (13.1 flagged this as a pre-existing gap Phase B's growth makes worth finally closing): a single TypeScript-side manifest listing every `target_key` valid for each `target_kind`, imported by both `field-dictionary.ts` (suggestions) and a new validation check in `map/actions.ts`'s `confirmMapping` (rejects, before it ever reaches SQL, a mapping where `target_kind = 'travel_field'` but `target_key` isn't one of the known travel columns — closing the loophole 13.3 point 4 flagged). The SQL function's `v_text_columns`/`v_array_columns`/new travel/health arrays remain the actual runtime authority (defense in depth, matching this project's established "server actions must verify even when a check exists elsewhere" discipline from Phase A) — this manifest makes the TWO lists (TS suggestion dictionary, SQL write arrays) derive from one shared source instead of three independently-maintained ones.
- **`preview-table.tsx`**: extend the flat per-row summary to show a compact icon/badge per section indicating "this row has travel data" / "this row has health data" (derived from whether any travel/health `target_key` has a non-blank value in that row's `normalized_row`) — not a full field-by-field preview (out of scope; the existing preview intentionally only surfaces `full_name`/`email`/issues today, and a full-fields preview for every row would be a much larger UI change than Phase B's stated scope).
- **Mapping validation errors before confirmation**: `confirmMapping`'s existing validation gains one more check — any `target_kind in ('travel_field','health_field')` row must have a non-null `target_key` from the closed manifest (13.9 point 2); a violation blocks confirmation with an inline error, consistent with how missing-target-key-for-non-ignored-columns likely already needs to be (re)confirmed as existing behavior during implementation, not assumed.

### 13.10 Required tests (mapped to your explicit list)

All added under `tests/import/`, following the two established patterns exactly (pure-logic unit tests for dictionary/validation extensions; live tests against the real Supabase project via `apply_import_row_transactional` for anything touching the SQL function):

1. Bilingual AR/EN header mapping for every new `KNOWN_FIELDS` entry (unit, `mapping-suggestion.test.ts`-style).
2. General participant fields end-to-end (live, extends `confirm-import-live.test.ts` pattern).
3. Primary/secondary track mapping and write.
4. Multi-select focus areas (3 tracks) — split + array write.
5. Multi-select session languages.
6. Travel-only data (health absent) → confirms no `application_health_info` row created.
7. Health-only data (travel absent) → confirms no `application_travel_info` row created.
8. Both travel and health present → both rows created, correctly linked.
9. Participant with neither sensitive section → zero rows in either new table (existing Phase A "legal empty state" behavior, now exercised through the actual import path for the first time).
10. Invalid passport dates → row warning surfaced, raw value still preserved in `application_answers`, no hard failure.
11. Malformed phone numbers (whatsapp/emergency contact) → warning, not a blocking error.
12. Duplicate email (existing coverage, re-run to confirm travel/health fields don't break existing duplicate-detection logic).
13. Re-import/idempotent upsert — change a travel field on a second import of the same email, confirm the row updates via `on conflict` rather than erroring or duplicating.
14. Sensitive-data write failure (deliberately induced, e.g. a constraint violation) → confirms the WHOLE row (application + answers + travel + health) rolls back together, row stamped `skipped_error`, batch continues.
15. No silent loss of sensitive answers — a row with valid travel data, verify both `application_travel_info` AND the corresponding `application_answers` rows (tagged `section='travel'`) exist after import.
16. Original-answer preservation — same style, for a mix of core/travel/health fields in one row.
17. No travel/health leakage into generic queries — extends Phase A's own `sensitive-data-rls.test.ts` "no leak through select('*')" test, now with real imported data present (previously tested against manually-seeded rows only).
18. 500-row import with mixed sensitive-data completeness (some rows travel-only, some health-only, some both, some neither, in one batch) — extends `scale-500.test.ts`'s fixture generation (13.1: current fixtures populate only 9 fields; Phase B needs a new fixture variant).
19. Rollback and cleanup — extends the rollback function per 13.1's "must stay in sync" invariant; a live test confirming a rolled-back batch's inserted applications cascade-delete their travel/health rows (already true via `on delete cascade`, verified not assumed) and that an updated-row rollback correctly restores prior travel/health state (new logic, mirroring the existing `application_answers` delete-and-reinsert pattern).

### 13.11 Phase B task list

1. Migration: `applications.full_name`, `application_travel_info` 2 new columns, `application_health_info` 1 new column, `application_answers.section`, widened `target_kind` check constraint.
2. Regenerate `database.ts`.
3. Extend `field-dictionary.ts` with all §13.2 entries (redirecting the 4 footnote-³ keys' destination).
4. New shared known-column manifest (13.9) consumed by both the dictionary and `confirmMapping`'s new validation.
5. Extend `row-validation.ts`: new multi-select keys, new date/phone validation (warning-level).
6. Extend `apply_import_row_transactional`: new `v_text_columns`/array entries for `applications.full_name`+new profile columns already covered by Phase A; new conditional travel/health upsert blocks; `application_answers` section tagging.
7. Extend `rollback_import_batch_transactional`: mirror the new writes' restore path (13.1's sync invariant).
8. Extend `run-extraction.ts`/`feature-extraction.ts`: new allowed `sourceField` values for `session_languages`/`priority_focus_track1-3`, plus `primary_track`/`secondary_track` reads.
9. `mapping-table.tsx`: section grouping + restricted badges.
10. `preview-table.tsx`: per-row travel/health indicator badges.
11. `map/actions.ts`: `confirmMapping`'s new pre-confirmation validation.
12. Extend `build-fixtures.ts`: new fixture variant(s) covering the mixed-completeness 500-row case and AR/EN headers for the new fields.
13. All 19 test scenarios (13.10).
14. tsc/lint/build; full existing import/allocation regression suite green.
15. Completion report per your 10-point structure.

### 13.12 Points needing your confirmation before implementation

1. **`applications.full_name`** (13.2 footnote 1, 13.3 point 1) — add as a first-class column now, or keep full name as `application_answers`-only for another phase? Recommended: add now.
2. **`session_languages`/`priority_focus_track1-3` reading `application_answers`** (13.4) — this is feature-extraction's first-ever read from that table. Confirmed safe (adds exactly 4 new named keys, not open-ended access) but flagging explicitly since it's a real precedent change, not a mechanical extension.
3. **Arabic alias text throughout 13.2** is my best-guess phrasing, not the real Google Form wording — I don't have the actual form. These need your correction (or the real form's exported header row) before the mapping dictionary is implemented, or bilingual auto-suggestion will under-perform on your real file until corrected.
4. **File-link handling (13.8)** — confirmed as "store the Drive URL verbatim, document the limitation," per your own instruction #8's fallback clause. Confirming you're fine proceeding on that exact basis (vs. wanting Phase B to also scope out what a future Drive-to-Storage transfer phase would need).

**All 4 resolved by your Phase B approval — see the completion report in that phase's commit history. Superseded by §14 below, approved 2026-07-31.**

---

## 14. Phase C — account provisioning, admin selection, email delivery, first-login gate (approved, implementing)

### 14.1 Current-system findings (verified fresh against the post-Phase-B codebase, not assumed)

- **`profiles` has zero password-related columns** — confirmed via a full re-grep of every migration. `must_change_password` does not exist yet; this phase adds it.
- **No `auth.admin.createUser` or `auth.admin.updateUserById` call exists anywhere in the codebase.** `src/lib/import/invitation.ts` is the only file using any Auth Admin method (`listUsers`, `inviteUserByEmail`, `deleteUser`), for the pre-existing per-user email-invite flow — Phase C is the first feature needing `createUser`/`updateUserById`, and does not touch this file's exported behavior. `findExistingAuthUserByEmail` (invitation.ts:63-75, not exported) is reused by extracting it to a shared location, per 13's original design.
- **The existing invitation/claim flow is completely untouched.** `claim_imported_application_transactional`'s ownership guard — `if v_application.applicant_id is not null then raise exception 'This application has already been claimed'` — is the exact pattern Phase C's own linking logic reuses (never overwrite a non-null `applicant_id`).
- **`(participant)/(shell)/layout.tsx`** is the single correct choke point for the password-change gate: it already does one `getUser()` + one service-role `profiles` read per request; adding a `must_change_password` read to that same query and a `redirect()` costs nothing structurally. Exactly 3 routes live under `(shell)/`: `my-dashboard`, `my-application`, `schedule` — all 3 are gated by extending this one file. `(participant)/(bare)/` (containing `claim/`, `register/`, and the new `/change-password`) is a sibling group Next.js does not nest under `(shell)/layout.tsx`, so it stays reachable without any special-casing.
- **No `middleware.ts` exists anywhere in this project, confirmed still true.** The gate is enforced entirely server-side inside the shared layout — never client-only, satisfying your explicit requirement.
- **`src/lib/email/resend.ts`** is a single 27-line file, one function (`sendRegistrationConfirmationEmail`), no batching. Phase C adds a second function in the same file rather than a new module, keeping one Resend client construction site.
- **The chunked-progress mechanism is not polling** — it is a client `while` loop that repeatedly calls a server action per chunk (`processImportChunk`), each call internally bounded-concurrency (`ROW_CONCURRENCY = 15` over `Promise.all` slices), with `import_batches.next_chunk_offset`/lock-token persisted server-side so a page reload mid-run resumes rather than restarts. This exact mechanism — client loop + persisted offset + lock token + per-item try/catch — is what Phase C's bulk-provisioning UI reuses, adapted to a `participant_account_provisioning` selection instead of an `import_rows` table.
- **No shared `requireAdmissionStaffCaller` helper exists** — `registration_admission_manager`-gated actions (`applications/[id]/actions.ts`) currently redefine a local `requireStaffCaller` per file, unlike the agenda feature's shared `server-helpers.ts`. Phase C adds a proper shared helper (mirroring `requireAgendaStaffCaller`'s exact shape) rather than another one-off local copy, since Phase C's actions live in their own new directory with no natural "local" file to inline into.
- **`audit_logs`** is a strict `entity_type/entity_id/action/actor_type('admin'|'system')/actor_id/metadata` shape; `writeAuditLog` (server-helpers.ts) hardcodes `actor_type: 'admin'` and swallows its own failures (log-and-continue, never throws) — Phase C's audit calls use this exact same helper, unchanged.
- **No existing admin list page has search/filter/pagination** — `participants/imports/page.tsx` lists all rows unconditionally. Phase C's account-management table is the first admin list in this codebase to need real filtering/pagination; no existing pattern to copy verbatim, so §14.6 below establishes one from scratch, deliberately kept simple (URL query params, not a new library).

### 14.2 Migration

One migration, additive only:

```sql
alter table profiles add column must_change_password boolean not null default false;

create type provisioning_account_status as enum (
  'no_account', 'account_created', 'password_change_required',
  'active', 'existing_account', 'creation_failed', 'conflict'
);
create type provisioning_email_status as enum ('not_sent', 'sending', 'sent', 'failed');

create table participant_account_provisioning (
  application_id uuid primary key references applications(id) on delete cascade,
  auth_user_id uuid references auth.users(id) on delete set null,
  normalized_email text not null,
  account_status provisioning_account_status not null default 'no_account',
  email_status provisioning_email_status not null default 'not_sent',
  must_change_password boolean not null default false,
  account_created_at timestamptz,
  last_login_email_sent_at timestamptz,
  login_email_send_count int not null default 0,
  provisioning_attempt_count int not null default 0,
  last_attempt_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_by uuid references profiles(id),
  updated_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index participant_account_provisioning_status_idx on participant_account_provisioning (account_status);
create index participant_account_provisioning_email_status_idx on participant_account_provisioning (email_status);
create trigger participant_account_provisioning_set_updated_at
  before update on participant_account_provisioning
  for each row execute function extensions.moddatetime('updated_at');

alter table participant_account_provisioning enable row level security;
create policy participant_account_provisioning_staff_all on participant_account_provisioning
  for all
  using (current_user_role() in ('registration_admission_manager', 'super_admin'))
  with check (current_user_role() in ('registration_admission_manager', 'super_admin'));
```

Why `must_change_password` lives on **both** `profiles` (the actual gate the shared layout reads) and `participant_account_provisioning` (a denormalized mirror): the layout's per-request read must be as cheap as the single `profiles` row it already fetches — joining a second table on every participant page load is avoidable cost. The provisioning table's copy exists purely for the admin table's own display/filter queries, and is written in the same transaction as the `profiles` write, so the two can never actually diverge in practice (same server action always writes both together — see 14.3/14.5).

`last_error_message` is explicitly a **safe, sanitized string** (never a raw driver/Postgres error, never any password), matching your "safe last_error_message" wording — enforced by the provisioning action layer choosing from a small fixed set of human messages keyed by error category, never interpolating a raw caught error's `.message` into this column.

**Nowhere does `password@123` get stored.** It is a module-level constant (`APPROVED_TEMP_PASSWORD` in the new provisioning module), used only as the literal string passed to `auth.admin.createUser`/`updateUserById` and to the email template — never written to any table or log line. The admin table's temp-password column (§14.4) computes its display text from `account_status`/`must_change_password`/whether the account is `existing_account`, never from a stored value.

### 14.3 Account-provisioning core (`src/lib/auth/provision-participant-account.ts`)

Single function, `provisionParticipantAccount(service, applicationId, actorId)`, covering §6's full decision tree:

1. Load the `applications` row (`id, imported_email, applicant_id, full_name`). If `applicant_id` is already non-null, this application is **not eligible** — return a `'not_eligible'` outcome without touching anything (an already-claimed/owned application is out of scope for this admin-controlled path entirely; it already has a real owner, possibly via the pre-existing invite/claim flow).
2. Normalize the email (reuses `normalizeEmail` from `src/lib/import/normalization.ts` — the exact same normalization the import pipeline already uses, so "the participant's normalized email" means the same thing everywhere in this codebase).
3. `findExistingAuthUserByEmail` (extracted from `invitation.ts` into `src/lib/auth/find-user-by-email.ts`, reused verbatim — same pagination logic, same documented residual race-condition caveat).
4. **No existing Auth user** → `auth.admin.createUser({ email, password: APPROVED_TEMP_PASSWORD, email_confirm: true })`. On success: `applications.applicant_id = <new id>` guarded by `.eq('applicant_id', null)` on the UPDATE itself (closes the same race window `claimApplication`'s own unique-index-catch guards against, but via an explicit WHERE predicate here since this path holds a service-role client, not a session — see 14.3.1); upsert `profiles` (insert if the trigger from `handle_new_user` hasn't already created one — it always will have, since `createUser` fires that trigger — so this is actually an UPDATE of `full_name` from the application's `full_name`/`must_change_password = true`); upsert `participant_account_provisioning` to `account_status: 'password_change_required', email_status` unchanged, `must_change_password: true, account_created_at: now()`.
5. **Existing Auth user found, not linked to any other application** → link only (`applications.applicant_id = <existing id>`, same guarded UPDATE), do **not** touch password, mark `account_status: 'existing_account'`.
6. **Existing Auth user found, already linked to a DIFFERENT application** → `account_status: 'conflict'`, `last_error_message` set to a fixed, safe string ("This email is already linked to a different application"), nothing else touched — matches your explicit "never overwrite a non-null applicant_id belonging to another user" requirement exactly, and reuses the RPC's own phrasing style.
7. Every step wrapped so a single participant's failure never aborts a caller processing multiple applications — same per-item isolation shape as `applyOneRow` in the import chunk loop.
8. Every outcome writes one `participant_account_provisioning` upsert (the durable, resumable state — see 14.8) and one `writeAuditLog` call (`action: 'account_created' | 'account_linked' | 'account_conflict'`).

**14.3.1 — idempotency, concretely.** Calling `provisionParticipantAccount` twice on the same `applicationId`:
- If the first call succeeded (created or linked), the second call re-reads `applications.applicant_id`, finds it already non-null, and returns `'not_eligible'` immediately — no second Auth user, no second write. This is the actual mechanism satisfying "idempotent" and "duplicate execution" from your test list, not a separate dedup layer.
- If the first call's Auth-create succeeded but the `applications` UPDATE failed (crash between the two), the second call's `findExistingAuthUserByEmail` finds the just-created Auth user and takes the "link only" branch — self-healing, no duplicate Auth account, matching your "prevent duplicate accounts" requirement even across a mid-operation crash.

**14.3.2 — reset-to-temporary-password**, a **separate, explicitly-invoked** function (`resetToTemporaryPassword(service, applicationId, actorId)`), never called from `provisionParticipantAccount`: requires the application already have a linked `auth_user_id`; calls `auth.admin.updateUserById(authUserId, { password: APPROVED_TEMP_PASSWORD })`; sets `profiles.must_change_password = true`, `participant_account_provisioning.account_status = 'password_change_required'`, increments nothing (this is a reset, not a creation attempt); audits `action: 'password_reset'`. This is the **only** code path that ever changes an existing account's password — satisfying "resetting an existing account password must be a separate explicit action and must never happen automatically."

### 14.4 Admin table — exact status-to-display mapping (§2)

| Condition | Temp-password column shows |
|---|---|
| `account_status = 'no_account'` | "No account" |
| `must_change_password = true` (regardless of `account_status`) | `password@123` (the literal approved constant, rendered from the module constant, never a stored value) |
| `must_change_password = false` and `account_status in ('password_change_required' transitioned to 'active', 'account_created')` — i.e. the participant has completed their first login | "Password changed" |
| `account_status = 'existing_account'` | "Existing password" |

This directly implements your §2 4-state rule as a pure function of `(account_status, must_change_password)` — no new stored field needed beyond what §14.2 already has, and it is structurally impossible for this function to ever read or return an actual password value, since none is ever stored.

Full column set per your §2 spec: checkbox, `applications.full_name`, `participant_account_provisioning.normalized_email` (username), the derived temp-password text above, `import_batches.original_filename` (batch, joined via `applications.import_batch_id`), `account_status`, a derived "password status" label (must-change vs. changed, redundant with the temp-password column's own logic but shown as its own badge per your explicit column list), `email_status`, `last_login_email_sent_at`, **last login date** — sourced from `auth.users.last_sign_in_at` (a real Supabase Auth column, read via a service-role `auth.admin.getUserById` call per visible row or a batched equivalent — see 14.9 for the query-cost note), `last_error_message`, and row actions.

### 14.5 Bulk actions — server action list

All 7 from your §4, each a distinct exported action in `src/app/[locale]/(admin)/participants/accounts/actions.ts`, each gated by the new shared `requireAdmissionStaffCaller()` (14.1's finding — a new shared helper, `src/lib/admission/server-helpers.ts`, mirroring `requireAgendaStaffCaller`'s exact shape but checking `isAdmissionStaffRole`):

- `createAccountsForSelected(applicationIds)` — `provisionParticipantAccount` per id, no email.
- `createAccountsAndSendLoginDetails(applicationIds)` — `provisionParticipantAccount` then, only for ids that ended in `account_created`/`password_change_required` (never `existing_account`/`conflict`), `sendLoginDetailsEmail`.
- `sendLoginDetailsForSelected(applicationIds)` — email only, filtered server-side to `account_status in ('account_created', 'password_change_required')` — an `existing_account` row is silently excluded here (not emailed with `password@123`, satisfying §8's explicit "do not send password@123 as though it were valid" for an unreset existing account), and the exclusion is reported back in the result summary, not silently dropped from view.
- `resendLoginDetails(applicationIds)` — same email, no re-provisioning, increments `login_email_send_count`.
- `retryFailedForSelected(applicationIds)` — server-side re-filters the input list to `account_status in ('creation_failed', 'conflict')` before dispatching, so calling this on a mixed selection only touches the actually-failed subset (satisfies "retry failed only" without the client needing to pre-filter correctly).
- `resetSelectedToTemporaryPassword(applicationIds)` — calls `resetToTemporaryPassword` per id; UI requires typed confirmation before this action fires at all (matching this project's established pattern for irreversible-ish actions, e.g. the schedule-publication confirm gate from Phase 5.5).
- `excludeSelectedFromOperation` — this is purely a **client-side** selection-state operation (removes ids from the current selection set before confirming a bulk action), not a server action — no server round-trip needed for "I changed my mind about these 3 rows before confirming."

Every action takes an explicit `applicationIds: string[]` — never "all matching current filter" implicitly. This is the direct mechanism behind "unselected participants must remain untouched": there is no code path in this feature that operates on anything other than an explicit id list the client sent.

### 14.6 Filters, search, selection, pagination

New URL-query-param-driven page (`src/app/[locale]/(admin)/participants/accounts/page.tsx`), following this codebase's existing filter-URL-param convention (noted in 14.1 as the only viable pattern to reuse, since no prior admin list page has real filters to copy). Query params: `q` (name/email search), `batch`, `status` (account_status), `emailStatus`. Canned toggle filters (no account / no login details sent / requires password change / active / failed-or-conflict) are just presets that set `status`/`emailStatus` combinations, not separate server logic.

**Selection across pagination** — the concrete mechanism: selection state is a `Set<string>` of `application_id` held in client component state (not URL state, to avoid an unbounded URL for a large selection), explicitly documented as scoped to what's currently loaded — "select all visible filtered" selects only the ids present in the current page's fetched rows (mirroring Phase A's design note about avoiding a silent 5000-row select-all footgun), never a server-computed "all matching filter" set. Paginating away and back preserves the Set's contents (it's not cleared by a page-param change) so a multi-page selection genuinely survives navigation, exactly as your §3 requires — the Set itself is the survival mechanism.

### 14.7 Confirmation dialog

Computed **client-side** from already-loaded row data plus the current selection Set — no extra round-trip needed (same reasoning as Phase A's original design for this dialog): total selected, new-accounts-to-create count (`account_status === 'no_account'` in selection), existing-accounts-to-link count (would resolve to `existing_account` — determinable only after actually calling `findExistingAuthUserByEmail`, so this number is presented as "up to N, confirmed after processing" rather than a precise pre-count, an honest limitation flagged in the dialog copy itself rather than a fabricated precise number), passwords-to-reset count (only relevant for the reset action), emails-to-send count, conflicts (existing `account_status === 'conflict'` rows already known from prior attempts), skipped (rows the specific action will filter out server-side, e.g. `existing_account` rows in a "send login details" action). Requires an explicit "Confirm" click; the reset-password action additionally requires typed confirmation text.

### 14.8 Batch processing, resumability, and progress (§9)

Reuses the exact mechanism from 14.1's finding, adapted: a new server action `processProvisioningChunk(applicationIds, offset, action)` processes a bounded slice (chunk size matching `CHUNK_SIZE` from `src/lib/validation/import.ts`, reused rather than a new constant) with the same `ROW_CONCURRENCY`-bounded `Promise.all` shape, each item wrapped in try/catch writing its outcome to `participant_account_provisioning` before moving on — this table **is** the resumable state (mirroring `import_rows.action_taken`'s role exactly), so:
- **Resumable**: a page reload mid-run re-queries `participant_account_provisioning` for the selected ids' current `account_status`/`email_status` and continues from wherever it left off — no separate lock-token/offset bookkeeping needed beyond what the table itself already records, since (unlike the import pipeline) there's no ordering requirement across chunks here — each application's outcome is independent and idempotent per 14.3.1.
- **No duplicate submission**: the "start" button disables itself for the duration of an in-flight run (client state), and server-side, `provisionParticipantAccount`'s own idempotency (14.3.1) makes a genuinely duplicate concurrent submission a safe no-op rather than a duplicate account — belt-and-braces, not relying on the UI disable alone.
- **No repeated email sends unless resend is explicit**: `sendLoginDetailsForSelected` server-side filters to rows where `email_status != 'sent'` OR the action is specifically `resendLoginDetails` — the two actions share the send logic but differ in exactly this one predicate.
- **500+ scale**: identical chunking math to the import pipeline, already proven at this scale by `scale-500`/`scale-5000` tests.

Progress totals shown (§9's list) are computed client-side from the accumulating per-chunk results, identical in spirit to the import progress bar's `processed`/`counts` state.

### 14.9 First-login password-change enforcement (§7)

- `(participant)/(shell)/layout.tsx` gains one field to its existing `profiles` select (`must_change_password`) and, immediately after the existing unauthenticated-redirect check, a second check: `if (profile?.must_change_password) redirect({ href: '/change-password', locale })`. This is a **server-side redirect inside a Server Component** — not a client effect, not middleware — satisfying "must be enforced server-side, not only through client-side redirects" as directly as this codebase's existing architecture allows (the codebase has no middleware anywhere; this layout is the equivalent choke point for everything under `(shell)/`).
- New route `(participant)/(bare)/change-password/page.tsx` (client component, since it needs `supabase.auth.updateUser()` exactly like `claim/page.tsx`'s existing password form) — reuses that exact call pattern. On submit: `supabase.auth.updateUser({ password })` (new password chosen by the participant, never `password@123` again — the form has no memory of what the temporary password was), then a server action `completePasswordChange()` sets `profiles.must_change_password = false` and `participant_account_provisioning.account_status = 'active'` via service-role, then client-side `router.push('/my-dashboard')`.
- **The new password is never read back, logged, or stored anywhere by this codebase** — Supabase Auth stores only its own hash; nothing here ever queries it.
- `/change-password` itself performs its own `getUser()` check (redirect to `/log-in` if unauthenticated) but does **not** gate on `must_change_password` being true — a participant who already changed their password and navigates here directly just sees the form again harmlessly (no gate needed either direction, since submitting a new password is always a safe, idempotent action to allow).

### 14.10 Authorization and audit (§10, §11)

`isAdmissionStaffRole` (`registration_admission_manager` + `super_admin`) gates every new route and server action in this feature — matching your explicit "at minimum: super_admin full access, registration_admission_manager account creation and email management, other roles denied unless already explicitly approved" instruction precisely (no other role, including `agenda_allocation_manager` which currently gates the sibling `participants`/`imports` pages, gets access here — a deliberate, explicit divergence from those sibling pages, called out here since it differs from the closest existing precedent).

Every server action uses a service-role client (bypasses RLS) and therefore independently re-verifies the caller's role via `requireAdmissionStaffCaller()` before any Auth Admin or email operation — the same "service-role client bypasses RLS, so this check is the actual gate" discipline established in every prior phase of this project.

Audit actions written (all via the existing `writeAuditLog`, `actor_type: 'admin'`, matching 14.1's finding): `account_created`, `account_linked`, `account_conflict`, `password_reset`, `login_email_sent`, `login_email_resent`, `provisioning_failed`, plus the existing claim-flow audit rows remain completely untouched.

### 14.11 Required tests

Mirrors your §11 list exactly, split unit/live per this codebase's established convention:
- **Unit**: `provisionParticipantAccount`'s branch logic (not-eligible / new-account / link-existing / conflict) against a mocked service client; the temp-password-display derivation function (14.4) against every `(account_status, must_change_password)` combination — this one is pure and exhaustively testable without any live dependency.
- **Live** (`tests/provisioning/*.test.ts`, mirroring `tests/import/*-live.test.ts`'s established shape): new account creation with normalized-email-as-username verified against the real created Auth user's email; no-`applicant_id`-overwrite (seed a claimed application, attempt provisioning, assert untouched); duplicate-call idempotency (call twice, assert exactly one Auth user and one `applications` write); existing-account linking; existing-account conflict (seed an Auth user already linked elsewhere); explicit password reset changes the password (verified via a real `signInWithPassword` using the new value) while a plain provisioning call never does; `must_change_password` gate — a live session as a `must_change_password = true` user is redirected from all 3 `(shell)/` routes and reaches `/change-password`, then after `completePasswordChange()` reaches `/my-dashboard` normally; email sent only to explicitly selected ids (mock/spy the Resend call, assert call count matches selection, not total eligible); `password@123` never appears in an email body for an `existing_account` row; one failure in a batch of several doesn't stop the rest (seed one deliberately-malformed row); retry-failed only re-touches previously-failed rows; concurrent duplicate submission of the same id resolves to one account (Promise.all-raced calls); role-authorization denial for every non-approved role; audit rows exist with the correct `action` values; a 500+-selection run completes and matches `scale-500`'s existing performance envelope; and a direct assertion that no test anywhere queries the real changed password out of any table/log (a negative test — search provisioning + audit tables for the string `password@123` after a password-change flow and assert zero rows contain the participant's real new value, which by construction can never be true since it's never stored, but codified as an explicit regression guard).

### 14.12 Phase C task list

1. Migration: `profiles.must_change_password`, the 2 new enums, `participant_account_provisioning` table + RLS + trigger.
2. Regenerate `database.ts`.
3. `src/lib/auth/find-user-by-email.ts` — extract `findExistingAuthUserByEmail` from `invitation.ts` (invitation.ts imports it back, zero behavior change to the existing flow).
4. `src/lib/auth/provision-participant-account.ts` — `provisionParticipantAccount`, `resetToTemporaryPassword`, the temp-password-display pure function.
5. `src/lib/admission/server-helpers.ts` — new shared `requireAdmissionStaffCaller`.
6. `sendLoginDetailsEmail` added to `src/lib/email/resend.ts`.
7. `src/app/[locale]/(admin)/participants/accounts/` — page, table component, actions.ts (7 bulk actions + `processProvisioningChunk`), confirmation dialog.
8. `(participant)/(shell)/layout.tsx` — must-change-password redirect.
9. `(participant)/(bare)/change-password/` — page + `completePasswordChange` action.
10. All unit + live tests (14.11).
11. tsc/lint/build; full existing regression suite green; live Auth/DB/email tests with cleanup verification.
12. Commit in logical order; confirm migrations match; confirm clean worktree; completion report per your 11-point structure.

Not in scope for Phase C (explicitly deferred per your instruction): QR generation, Scanner PWA, attendance.

---

## 15. Production Resend email setup (approved, implementing)

Builds on Phase C's `sendLoginDetailsEmail` — does not rebuild the provisioning workflow, selection table, bulk actions, provisioning records, audit logging, or chunked processing, all reused exactly as-is.

### 15.1 Current-implementation findings (verified against the post-Phase-C codebase)

- Installed Resend SDK: **v6.18.0** (confirmed via `node_modules/resend/package.json`). It ships a real `Webhooks.verify()` method backed by the `standardwebhooks` package (Svix-compatible, confirmed via `node_modules/resend/dist/index.mjs`'s `import { Webhook } from "standardwebhooks"`) — no hand-rolled HMAC needed. `emails.send()` supports `html`, `text`, and `replyTo` (`string | string[]`) natively, and returns `{ id: string }` on success — the correlation key for delivery tracking.
- No true batch-send API is used: `CreateBatchOptions`/`resend.batch.send()` exists in this SDK version but Resend's batch endpoint doesn't support per-recipient personalized content the way this feature needs (unique username/password/name per email) — bounded-concurrency individual `emails.send()` calls (reusing the exact `processInChunks`/`ROW_CONCURRENCY` shape from the import pipeline) is what Phase C already built and what this task extends, not a new mechanism.
- `resend.ts`'s lazy client construction (Phase C) is preserved unchanged in spirit — the module still never crashes at import time on a missing key.
- `participant_account_provisioning.email_status` (Phase C) only had `not_sent/sending/sent/failed` — missing `delivered`/`bounced` and any Resend-side correlation id. This task's own migration adds both.
- No webhook endpoint existed anywhere in the codebase; `src/app/api/` didn't exist yet.

### 15.2 Environment variables

Six new variables, all read via `src/lib/email/resend-config.ts`'s `getResendConfig()`/`getWebhookSecret()` — a narrowly-scoped validation module (this codebase has no general env-schema framework, so this stays scoped to Resend rather than introducing one):

| Variable | Required for | Behavior when missing |
|---|---|---|
| `RESEND_API_KEY` | any send | `getResendConfig()` returns `{ ok: false, missing: [...] }`; the send function returns `{ id: null, error: "Resend not configured: missing RESEND_API_KEY" }` — never throws, never sends. |
| `RESEND_FROM_EMAIL` | any send | same fail-safe pattern |
| `RESEND_REPLY_TO_EMAIL` | optional | falls back to `PARTICIPANT_SUPPORT_EMAIL` |
| `RESEND_WEBHOOK_SECRET` | webhook route | the route returns `503` for every request, never accepts an unverified event |
| `APP_URL` | login URL in email | falls back to `NEXT_PUBLIC_SITE_URL` if unset; if both unset, same fail-safe missing-config path |
| `PARTICIPANT_SUPPORT_EMAIL` | support contact in email, reply-to fallback | same fail-safe pattern |

Added to `.env.example` (new file — none existed before) with inline comments explaining each; added to local `.env.local` as empty/placeholder values (no real secret ever written there by this change).

### 15.3 Bilingual HTML + text template

`buildLoginDetailsHtml()` in `resend.ts` — table-based layout with inline styles (the only approach that renders reliably across email clients, notably Outlook), `max-width:560px` + `width:100%` responsive container, Arabic (RTL) section first, English (LTR) section second, both containing name/username/temporary-password/login-button/support-contact — matches your suggested content exactly. Plain-text fallback (`text`) is generated in parallel, same content, always sent alongside `html` in the same `emails.send()` call. All interpolated values pass through `escapeHtml()` before insertion — verified by a dedicated test injecting `<script>` markup into a name field.

### 15.4 Selected-only sending — unchanged from Phase C, re-verified

`sendLoginDetailsForCaller`/`createAccountsAndSendLoginDetails`/`sendLoginDetailsForSelected`/`resendLoginDetails` all still take an explicit `applicationIds: string[]`; no code path in this task adds an implicit "all eligible" option. Re-verified live (not just re-asserted) that an unselected application's `participant_account_provisioning` row is never touched by an email action scoped to a different selection.

### 15.5 Eligibility (§4) — tightened

`sendLoginDetailsForCaller` now checks, in order: `auth_user_id` is non-null (a real linked account exists) → `account_status in ('account_created', 'password_change_required')` → `must_change_password = true`. All three must hold. An `existing_account` row (real password never reset) fails the second check and is marked `email_skipped` with a message stating a password-reset action is required first — never silently attempted, never sent `password@123`.

### 15.6 Delivery/status tracking — new migration

Two migrations (`20260802100000_resend_delivery_tracking.sql`, isolating the enum-value additions per this project's established "enum changes need their own migration" rule; `20260802110000_resend_delivery_tracking_columns.sql`, the columns):

- `provisioning_email_status` gains `delivered`, `bounced` (now: `not_sent | sending | sent | delivered | bounced | failed`).
- `participant_account_provisioning` gains `resend_email_id` (the correlation key — Resend's returned id, echoed in every webhook event for that email), `delivered_at`, `bounced_at`, `last_send_attempt_at`.
- New table `resend_webhook_events` (`svix_id primary key, event_type, resend_email_id, received_at`) — the idempotency ledger described in 15.8.
- The send path (`sendLoginDetailsForCaller`) now writes `email_status = 'sending'` **before** calling the API (so a crash mid-send leaves a visibly in-flight state, not a misleadingly-untouched `not_sent`), then `sent` + `resend_email_id` on success, or `failed` + a safe `last_error_message` (never a raw exception, never a password) on failure.
- **No password is ever written to any of these columns or to `resend_webhook_events`** — confirmed by construction (none of the new columns' write sites ever reference `APPROVED_TEMP_PASSWORD` or any password value) and by a dedicated regression test.

### 15.7 Bulk sending (§6) — reuses Phase C's mechanism exactly

`processInChunks` (unchanged) with `CHUNK_SIZE` (reused from `src/lib/validation/import.ts`) and `ITEM_CONCURRENCY = 10` bounded `Promise.all` per slice. Confirmed via a live test processing 520 selected applications through both account creation and email dispatch without incident, each item isolated (every one of the 520 email attempts failing independently in the test environment, none blocking another). `retryFailedEmailsForSelectedForCaller` (new) mirrors `retryFailedForSelectedForCaller`'s shape but filters on `email_status = 'failed'` specifically, distinct from `retryFailedForSelected` (which retries account-creation failures) and from `resendLoginDetails` (which forces a re-send even for an already-successful row).

### 15.8 Webhook (§8) — new route

`src/app/api/webhooks/resend/route.ts`, `POST` handler:

1. Reads `RESEND_WEBHOOK_SECRET` via `getWebhookSecret()`; returns `503` if unset.
2. Extracts the 3 Svix signature headers (`svix-id`, `svix-timestamp`, `svix-signature`) — the SDK's `Webhooks.verify()` expects them as a plain `{ id, timestamp, signature }` object, not the raw `Request.headers` (confirmed against the SDK's own type definitions, a real gap caught while implementing, not assumed). Missing headers → `401`.
3. Calls `new Resend('webhook_verify_only').webhooks.verify(...)` (a placeholder key — `verify()` needs no real API key, but the SDK's constructor throws on an empty string, a second real gap caught and fixed during implementation). Invalid signature → the SDK throws, caught → `401`.
4. Idempotency: inserts `{ svix_id, event_type, resend_email_id }` into `resend_webhook_events` first; a unique-constraint violation (`23505`) means this exact delivery attempt was already processed → returns `200` with `{ duplicate: true }` without touching any provisioning row a second time.
5. Correlates via `resend_email_id` (never recipient email) and updates the matching `participant_account_provisioning` row: `email.delivered` → `email_status='delivered', delivered_at`; `email.bounced` → `email_status='bounced', bounced_at`, safe `last_error_message` from Resend's own `bounce.message`; `email.failed` → `email_status='failed'`, safe `last_error_message` from `failed.reason`. Every other event type is acknowledged (`200`) and ignored.
6. Response body never echoes participant email/name — `{ ok: true }` only (verified by a dedicated test).

### 15.9 Admin interface (§9)

`accounts-table.tsx` gains: an `EMAIL_STATUS_BADGE` map covering all 6 statuses, a "Send count" column, a "Failure reason" column, a `retryFailedEmails` action button. Progress summary after a bulk action now includes `selected`/`eligible`/`remaining` alongside the existing created/linked/sent/failed/conflicts/skipped counts. Confirmation dialog shows the large-selection warning (`"You are about to send login details to {count} participants."`) whenever the send-related action's selection is ≥50, still requiring the existing explicit confirm click.

### 15.10 Testing (§10)

- **Mocked** (`tests/email/resend-config.test.ts`, `tests/email/resend-send.test.ts`): config validation for every missing-variable combination; `sendLoginDetailsEmail` with a mocked `Resend` client (`vi.mock('resend', ...)`) — correct username/password in the sent content, HTML+text both present, no sensitive-data leakage (passport/medical/allocation keywords asserted absent), HTML-escaping of a hostile name value, safe failure on a missing API key (asserting the mock's `send` was never even called), and correct reply-to fallback behavior. **No real Resend API call happens in this suite.**
- **Live, small controlled recipients** (`tests/api/resend-webhook.test.ts`): genuinely valid and invalid Svix signatures generated via the real `standardwebhooks` package (the same one Resend vendors) — not mocked — proving real signature verification, not an assumption of it. Covers delivered/bounced/failed event handling, idempotent duplicate delivery, unrelated-event-type handling, and no-participant-data-in-response.
- **Live, no real sends** (`tests/auth/resend-production-email-live.test.ts`): status transitions through `sending → failed` in an environment with no real `RESEND_API_KEY` (deliberately — never sends a real email to a real inbox during automated testing, per your explicit instruction), `retryFailedEmailsForSelectedForCaller`'s filtering, and a 520-application bulk run proving bounded processing and per-item isolation at scale without touching a real mailbox.

### 15.11 Deployment checklist (manual steps, not automatable from this environment)

1. Create or open the Resend account at resend.com.
2. Add and verify the sending domain (e.g. `rcoymena.org`) under Resend → Domains.
3. Add the DNS records Resend provides (SPF/DKIM, typically TXT + CNAME records) at your DNS provider.
4. Create a Resend API key (Resend → API Keys) scoped to sending.
5. Add all 6 environment variables (§15.2) to the deployment platform's environment configuration — never commit real values to any file in this repo.
6. In Resend → Webhooks, add an endpoint pointing at `https://<your-deployed-domain>/api/webhooks/resend`, subscribed to at minimum `email.delivered`, `email.bounced`, `email.failed`.
7. Copy the webhook's signing secret into `RESEND_WEBHOOK_SECRET`.
8. Send a real test batch to a small, explicitly-selected group of real addresses you control from `/participants/accounts`.
9. Confirm delivered/bounced statuses actually update in the admin table (watch the webhook arrive within a few seconds of the send).
10. Only after confirming the above, send to the full selected participant group.

### 15.12 Task list

1. Migrations: enum widening, new columns, `resend_webhook_events` table.
2. Regenerate `database.ts`.
3. `.env.example` (new file), `.env.local` placeholder additions.
4. `src/lib/email/resend-config.ts` — config validation, fail-safe.
5. `src/lib/email/resend.ts` — env-driven `from`/`replyTo`, bilingual HTML+text template, `{ id, error }` return shape.
6. `src/app/[locale]/(admin)/participants/accounts/actions.ts` — eligibility tightening, `sending` status write, `resend_email_id` tracking, `retryFailedEmailsForSelectedForCaller`.
7. `src/app/api/webhooks/resend/route.ts` — new signature-verified, idempotent webhook endpoint.
8. `accounts-table.tsx` — new statuses/columns/action/large-selection warning.
9. i18n additions (en/ar).
10. All tests (15.10).
11. tsc/lint/build; stable suite; mocked Resend suite; controlled live webhook/email suite.
12. Commit in logical order; confirm migrations match; confirm clean worktree; completion report per your 10-point structure.

Not in scope (explicitly deferred per your instruction): QR generation, Scanner PWA, attendance.

## 16. Live Auth user cleanup (2026-07-30)

After local Resend verification, the live Supabase project held 20 Auth
users: the 2 real accounts (`albaraak2002@gmail.com` / super_admin,
`albaraaalbadwi@gmail.com` / participant) plus 18 `@test.local` fixtures
left over from earlier live-test runs. All 18 (plus one incidental
artifact created by re-running a test suite mid-verification, 19 total)
were deleted, leaving exactly the 2 real accounts.

**Blocker encountered:** 6 staff-actor "who did this" columns
(`import_batches.uploaded_by`, `feature_extraction_runs.run_by`,
`allocation_runs.run_by`, `schedule_publication_drafts.staged_by`,
`clustering_runs.run_by`, `allocation_assignments.updated_by`) had no
`ON DELETE` clause on their FK to `profiles(id)`, defaulting to
`RESTRICT` — blocking user deletion whenever a test fixture had run an
import/extraction/allocation/clustering/staging action. Four of the six
were also `NOT NULL`. Resolved via two migrations
(`20260802120000_nullable_staff_actor_columns.sql`,
`20260802130000_nullable_clustering_and_assignment_actor_columns.sql`)
making all six nullable with `ON DELETE SET NULL`, so a future
staff-account deletion no longer fails — historical rows keep their
existing values; only the deleted fixtures' references were nulled.

**Data preserved:** all shared conference data (sessions, tracks,
rooms, people, conference days, session types, tags, allocation runs,
import batches, clustering runs, feature extraction runs) untouched.
4100+ unclaimed imported applications (`applicant_id IS NULL`)
untouched. The retained participant's application, provisioning row,
and role were re-verified unchanged after cleanup. A full JSON backup
of every deleted user and their associated rows was taken before
deletion and is stored outside the repository (not committed, contains
emails/UUIDs/personal data).

**App-layer follow-up:** the audit-log actor display
(`batch-detail.tsx`) now shows a translated "Deleted user" / "مستخدم
محذوف" fallback instead of an empty string when `actor_id` is null;
two hand-written local types (`Batch.uploaded_by`, `Draft.staged_by`)
updated to `string | null` to match.
