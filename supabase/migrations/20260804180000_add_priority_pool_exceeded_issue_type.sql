-- add_priority_pool_exceeded_issue_type.sql
--
-- allocation_issues.issue_type is a plain text column with a check
-- constraint named allocation_issues_type_valid (confirmed by reading
-- supabase/migrations/20260723100000_allocation_tables.sql directly, and by
-- grepping every later migration touching allocation_issues -- none of
-- 20260723110000_allocation_rls_policies.sql, 20260723190000_schedule_
-- publication_functions.sql, 20260726109600_rollback_safety_fixes.sql, or
-- 20260803120000_program_attendance_manager_rls.sql redefine this
-- constraint -- so the original 5-value list is still the live one), so
-- this is an ordinary constraint update, not an isolated-enum migration.
alter table allocation_issues drop constraint allocation_issues_type_valid;
alter table allocation_issues add constraint allocation_issues_type_valid
  check (issue_type in ('unassigned', 'low_confidence', 'capacity_bottleneck', 'schedule_conflict', 'no_eligible_sessions', 'priority_pool_exceeded'));
