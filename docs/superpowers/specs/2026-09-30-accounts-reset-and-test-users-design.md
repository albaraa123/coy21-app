# Accounts Reset and Test Users — Design Spec

Date: 2026-09-30

## Context

This is sub-project 1 of a larger 6-part plan for the COY21 conference platform (Antalya, 5–7 November 2026, ~500 participants). The full request was decomposed into 6 independent sub-projects because it spans multiple largely-unrelated subsystems; each gets its own spec → plan → implementation cycle. This spec covers only the first: resetting the production COY21 Supabase project to a clean slate and provisioning 4 test accounts, one per role in the current 4-role model (`participant`, `super_admin`, `staff`, `scanner_device` — implemented by the staff-role-consolidation work merged just before this spec was written).

Everything else in the original request — classification expansion and its edit UI, import/invitation/approval workflow, sessions/booking/work-groups, scanning/offline sync + ops dashboard, and the shared timezone/notification layer — is explicitly out of scope here and deferred to later sub-projects (see "Deferred to later sub-projects" below).

## Goal

1. Permanently delete every existing user/account and every row of data tied to participants/applications from the **production** COY21 Supabase project (confirmed explicitly: this is the real project, not a scratch/disposable one — the project is still 100% experimental with no real registrant data, so a destructive reset is acceptable).
2. Provision exactly 4 new accounts, one per role, at 4 specific emails.
3. Confirm (not modify) that the current `staff` role's RLS permissions already match the requested boundary: full operational access to participants/applications/conference data, but never role changes or account deletion.

## What already exists (confirmed via codebase research, not assumed)

- **4-role model is live**: `participant`, `super_admin`, `staff`, `scanner_device`, implemented via `is_staff()` and consolidated RLS policies (merged 2026-09-29).
- **`profiles` RLS already enforces the exact boundary requested for `staff`**: only `super_admin` can select/update other users' `profiles` rows or change any `role` value (`profiles_update_super_admin`, `supabase/migrations/20260727000000_fix_profiles_role_privilege_escalation.sql`). A caller can never change their own role (`with check ... role = (select role from profiles where id = auth.uid())`). Account deletion goes through `service.auth.admin.deleteUser`, called only from `deleteStaffAccount` in `src/app/[locale]/(admin)/staff/actions.ts`, gated by `requireSuperAdmin()` at the application layer. **No code or policy change is needed for this boundary — it already exists.**
- **`staff` already has broad operational access**: `is_staff()`-gated policies grant full select/update on `applications` and full CRUD (`for all using (is_staff())`) on conference-config tables (`conference_days`, `tracks`, `rooms`, `session_types`, etc.) from the RLS-consolidation migration. This already covers "staff manages sessions/rooms/schedules/participant data" from the original request. Whether `staff` should be *restricted* from editing certain "conference settings" as a distinct concept is deferred — no such concept exists in the schema today (see "Deferred" below).
- **No `scanner_device` provisioning path exists yet** (not in `provision-staff-account.ts`, not in `provision-participant-account.ts`, not in `staff-manager.tsx`'s role dropdown). This spec creates one `scanner_device` account by hand (see below); a real provisioning UI/flow for scanner devices is deferred to the scanning sub-project.

## Deferred to later sub-projects (explicitly out of scope here)

- Expanding `participant_type` beyond its current 5 fixed values, and building any UI to view/edit/bulk-change it or generate classification-specific registration links — deferred to the import/approval sub-project.
- Any new RLS restriction that would block `staff` from editing conference-config tables (rooms, session types, days) as a distinct "conference settings" concept — deferred to the sessions/booking sub-project, since that's where "conference settings" as a bounded concept will first need a real definition.
- `scanner_device`'s advanced behavior: location selection at login, forced device logout on password change, offline-scan-queue preservation — deferred to the scanning sub-project. This spec only confirms the bare account can authenticate and lands on `/scanner` (existing `resolvePostLoginDestination` behavior), nothing more.

## Design

### 1. Full data reset (production COY21 project)

A single new migration performs the reset as one atomic transaction (Postgres DDL/DML in a migration file is transactional by default — if any statement fails, nothing is deleted).

**What gets truncated** (every table found via `grep -rl "references public.applications\|references applications" supabase/migrations/*.sql`, confirmed exhaustive against migration history — corrected during spec review to add 2 tables initially missed on a manual transcription pass through the large `20260805235959_phase6_qr_issuance_reissue.sql` migration file: `qr_lifecycle_operations`, which has its own `application_id uuid not null references public.applications(id) on delete restrict`, and `qr_bulk_operation_batches`, which has no direct FK to `applications` but is referenced by `qr_lifecycle_operations.bulk_batch_id on delete restrict` and would otherwise be left silently populated with stale data after the reset):

```
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
```

A single statement:

```sql
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
```

Using `truncate ... cascade` (rather than manually ordering `delete` statements) is deliberate: Postgres resolves the dependency graph itself, so the exact listed order doesn't matter and no table can be missed due to an ordering mistake — the earlier research found several of these tables use plain `references` with no `on delete` action (would block a naive `delete`), and `qr_credentials.application_id` / `qr_lifecycle_operations.application_id` / `qr_lifecycle_operations.bulk_batch_id` are all explicitly `on delete restrict` (would actively reject deletion). `truncate cascade` correctly overrides all of that — but only for tables actually named in the statement; `cascade` walks children of the *named* tables, it does not discover additional tables that reference them. This is exactly why `qr_lifecycle_operations`/`qr_bulk_operation_batches` had to be added explicitly rather than assumed to be swept up automatically — every table with any FK path back to `applications` must be named, not just the ones a manual first pass happens to catch.

**Execution-time safety gate**: because this operation is genuinely irreversible and explicitly targets the real production COY21 project (not a scratch/disposable one), whoever applies this migration must first positively confirm they are connected to the correct project before running it — e.g. by checking the project ref shown by `supabase status`/the dashboard URL against the known production project ref, or by running a read-only row-count query first and having a human confirm the counts look like real production volumes (not a suspiciously empty or unfamiliar project) before proceeding. This spec does not automate that check away — the implementation plan must include an explicit manual confirmation step immediately before the truncate/delete statements run, not just a comment saying "be careful."

**What is explicitly NOT truncated** (conference configuration, not user data, rows are kept): `conference_days`, `tracks`, `rooms`, `session_types`, `sessions`, `session_people`, `session_tags`, `tags`, `people`, `audit_logs`, `local_info_sections/items/images`, and any other non-participant-scoped table. Per your confirmation, "delete all users" means accounts and their data, not conference setup. (`scanner_assignments` is a partial exception — see immediately below — its rows are deleted, not kept, since they lose all meaning once the accounts they link no longer exist.)

**Before deleting `auth.users`, nullify every "who did this" column on the config tables above.** Several of them still carry an `updated_by`/`actor_id`/`scanned_by`/`assigned_by`/`linked_profile_id` column that references `profiles(id)` with no `on delete` action (plain `references profiles(id)`, defaulting to Postgres's `no action`, i.e. restrict). If any of those columns is non-null when `delete from auth.users` runs — which is likely, since a project with any staff/scanner activity will have audit trails recorded on these tables — the delete will raise a foreign-key-violation error and the whole migration rolls back (transactional, so this fails safely rather than partially, but it does mean the reset as a naive single `delete from auth.users` would simply not work). This was caught during spec review, not assumed correct without checking.

The fix: null out these columns first, keeping the row itself (so the config data — room names, session titles, day definitions — survives untouched, only the "who last touched this" attribution is cleared, which is expected and correct since the person who touched it no longer exists):

```sql
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
delete from scanner_assignments;
```

`scanner_assignments` is deleted outright rather than nullified — both of its profile-referencing columns (`scanner_user_id`, `assigned_by`) are `not null`, so nullifying isn't possible, and an assignment record that points at a now-deleted scanner/staff account has no meaning to preserve (unlike a room or session, which still makes sense to keep with an anonymous "last updated by" trail). `scanner_assignments` was not already in the main truncate list because it has no FK to `applications` — it only references `profiles` directly — so it's called out here specifically rather than folded into the earlier list.

This list was derived by searching every migration for `references profiles(id)` (not just `references applications`, which is a narrower search than the truncate-list derivation above) and checking each hit's `on delete` behavior; any hit landing on a table already in the truncate list above is not repeated here since that table is being emptied anyway.

**Then**, delete every row in `profiles` and `auth.users`:

```sql
delete from auth.users;
```

Since `profiles.id references auth.users(id) on delete cascade`, this single statement also removes every `profiles` row. No separate `profiles` truncate is needed or safe to do first (truncating `profiles` before `auth.users` would leave orphaned `auth.users` rows with no matching profile, which is worse — deleting `auth.users` first, letting cascade clean up `profiles`, is correct and matches the existing cascade already declared in the base schema migration). By this point every other FK into `profiles` has already been cleared (either by truncating the referencing table earlier, or by the nullify/delete statements just above), so this delete cannot hit a foreign-key violation.

**Failure/recovery note**: because every statement above runs inside one migration file, a failure at any point (an FK violation from a table this spec's research missed, despite two review passes) rolls the entire transaction back automatically — nothing is left half-deleted. If that happens, the correct response is to stop, diagnose the specific FK violation Postgres reports (it names the exact table and constraint), add the missing handling to the migration, and re-run from a clean state — not to work around it with a broader hammer like `disable trigger` or dropping constraints, which would remove real data-integrity protection from a still-live schema.

**Sequences**: the 5 per-classification attendee-code sequences (`attendee_code_seq_del/vol/kp/yng/spk`, from `20260822000000_coy21_attendee_codes.sql`) are reset to restart from 1, so the first real import after this reset gets clean `COY21-DEL-0001`-style numbering rather than continuing from wherever test data left off:

```sql
alter sequence attendee_code_seq_del restart with 1;
alter sequence attendee_code_seq_vol restart with 1;
alter sequence attendee_code_seq_kp restart with 1;
alter sequence attendee_code_seq_yng restart with 1;
alter sequence attendee_code_seq_spk restart with 1;
```

### 2. Provisioning the 4 test accounts

No password ever appears in code, a migration, or a commit — per your explicit instruction. The flow:

1. **You** create the 4 Auth users by hand, in the Supabase dashboard (Authentication → Add user), choosing your own passwords, at these emails:
   - `albaraak2002@gmail.com`
   - `albaraa.coy21@gmail.com`
   - `albaraaalbadwi@gmail.com`
   - `albaraa.scale.om@gmail.com`
2. The existing `handle_new_user()` trigger (`supabase/migrations/20260721200747_roles_and_profiles.sql`) fires automatically on each Auth user creation and inserts a `profiles` row with the enum default role (`participant`) for all 4.
3. A follow-up SQL statement (run by you, or by me via the dashboard's SQL Editor with your explicit go-ahead each time — same pattern used for the earlier RLS live-verification) corrects each profile's role to match:

```sql
update profiles set role = 'participant' where email = 'albaraak2002@gmail.com';
update profiles set role = 'super_admin' where email = 'albaraa.coy21@gmail.com';
update profiles set role = 'staff'       where email = 'albaraaalbadwi@gmail.com';
update profiles set role = 'scanner_device' where email = 'albaraa.scale.om@gmail.com';
```

(`participant`'s own update is a no-op given the trigger default, included only for explicitness/completeness — if the email-to-role mapping above ever needs to change, this makes every row visible in one place rather than assuming the default silently held.)

No `applications` row is created for the `participant` test account by this spec — the account can self-complete a real application through the existing registration flow afterward if needed for later testing, which is a more realistic test path than fabricating one via SQL.

### 3. Verifying the `staff` permission boundary (confirmation only, no code change)

Since research confirmed the current RLS already enforces the requested boundary, this section is testing, not implementation:

- A live test (against a disposable scratch Supabase project, never production — same technique used in the staff-role-consolidation work) proves: a `staff`-role session can read/update `applications` and conference-config tables; a `staff`-role session attempting to update another profile's `role` column, or call `deleteStaffAccount`, is rejected.
- This test is written once and can be reused/extended by later sub-projects as the permission surface grows (e.g., once "conference settings" becomes a real bounded concept in the sessions sub-project, a new assertion gets added here rather than a new test file).

### Testing

- Migration correctness: apply the reset migration against a scratch Supabase project seeded with representative data across every truncated table (reusing fixtures/patterns from existing live tests where possible), confirm zero rows remain in every truncated table and in `profiles`/`auth.users`, confirm the migration doesn't error on any FK.
- `staff` permission boundary: as described in section 3.
- No test coverage for `scanner_device`'s deferred advanced features (location selection, forced logout, offline-scan preservation) — those tests belong to the scanning sub-project's own spec.

### Out of scope (confirmed explicitly during brainstorming, not just inferred)

- Classification expansion, edit UI, registration links — sub-project 3.
- `scanner_device` advanced behavior — sub-project 5.
- New RLS restriction on "conference settings" for `staff` — sub-project 4.
- Any change to the import pipeline, QR/attendee-code system, session/allocation machinery, or email provider — all confirmed already mature and functionally untouched by this spec.
