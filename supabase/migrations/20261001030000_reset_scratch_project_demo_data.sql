-- 20261001030000_reset_scratch_project_demo_data.sql
--
-- Maintenance reset for the coy21-dev-scratch3 SCRATCH project only
-- (jgsuguohtjqurnshagup) -- NOT the real COY21 production project. Clears
-- accumulated test fixtures and demo data left over from the many live
-- test suites run against this scratch project during sub-projects 1-3
-- of the COY21 feature roadmap, plus the manual demo data created for a
-- visual walkthrough of sub-project 3.
--
-- Identical in content and reasoning to
-- 20260930000000_reset_all_accounts_and_participant_data.sql (which
-- resets the REAL production project and must never be re-applied there),
-- duplicated here as its own migration specifically so this scratch-only
-- reset is tracked and re-runnable via `supabase db push` like any other
-- migration, without touching that production-reset file's own history.
-- See that file and
-- docs/superpowers/specs/2026-09-30-accounts-reset-and-test-users-design.md
-- for the full FK-dependency research behind every statement below.
--
-- THIS MIGRATION IS DESTRUCTIVE. Before applying, confirm via the CLI's
-- linked project ref that you are connected to coy21-dev-scratch3
-- (jgsuguohtjqurnshagup), never the real production project.

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

update rooms set updated_by = null where updated_by is not null;
update tracks set updated_by = null where updated_by is not null;
update session_types set updated_by = null where updated_by is not null;
update conference_days set updated_by = null where updated_by is not null;
update tags set updated_by = null where updated_by is not null;
update people set updated_by = null, linked_profile_id = null, linked_application_id = null where updated_by is not null or linked_profile_id is not null or linked_application_id is not null;
update sessions set updated_by = null where updated_by is not null;
update session_people set updated_by = null where updated_by is not null;
update session_tags set updated_by = null where updated_by is not null;
update audit_logs set actor_id = null where actor_id is not null;

delete from scanner_assignments;

delete from auth.users;

alter sequence attendee_code_seq_del restart with 1;
alter sequence attendee_code_seq_vol restart with 1;
alter sequence attendee_code_seq_kp restart with 1;
alter sequence attendee_code_seq_yng restart with 1;
alter sequence attendee_code_seq_spk restart with 1;
