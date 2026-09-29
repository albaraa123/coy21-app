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
