-- FK delete-rule verification probe (Task 16).
--
-- Task 16 required independently re-verifying, against the LIVE database,
-- that the FK delete rules the rollback function depends on are genuinely in
-- effect — the migration ledger showing a file as applied was explicitly not
-- accepted as sufficient, since this worktree previously had a case of a
-- migration file existing while the live state differed.
--
-- This migration created a temporary introspection function, which was
-- called once to read information_schema.referential_constraints, and is
-- dropped again at the bottom of this same file. It is retained (rather than
-- deleted) because it was already applied to the live database, so removing
-- it would desync the migration ledger for a from-scratch rebuild. It is a
-- no-op on any fresh database: the function is created and immediately
-- dropped, leaving no residue.
--
-- Verified results, live, on project deukwztsmcnxxchrdrfo:
--
--   SET NULL   import_rows.destination_application_id
--   CASCADE    application_answers.application_id
--   CASCADE    application_status_history.application_id
--   CASCADE    participant_invitations.application_id
--   NO ACTION  participant_feature_snapshots.application_id
--   NO ACTION  cluster_memberships.application_id
--   NO ACTION  allocation_assignments.application_id
--   NO ACTION  schedule_publications.application_id
--
-- Conclusions relied upon by
-- 20260726109000_rollback_import_batch_function.sql:
--   * Task 2's `on delete set null` fix on
--     import_rows.destination_application_id is genuinely live, NOT the
--     regressed NO ACTION the plan warned to check for. The rollback's
--     hard-delete of inserted applications will not be refused by that FK.
--   * application_answers / application_status_history really do cascade, so
--     the rollback does not need to delete them explicitly.
--   * participant_invitations really does CASCADE, confirming Task 3's
--     reported gap: without the rollback function's explicit
--     status <> 'not_sent' check, a sent invitation would be silently
--     destroyed. That check is load-bearing, not defensive.
--   * The four downstream pipeline tables are NO ACTION, so they would
--     refuse the delete at the FK level anyway — but the rollback function
--     still checks them first so the admin gets a specific, actionable
--     message naming the blocker instead of a raw FK violation.
create or replace function _tmp_fk_introspect() returns jsonb as $$
  select jsonb_agg(jsonb_build_object(
    'constraint', tc.constraint_name,
    'table', tc.table_name,
    'delete_rule', rc.delete_rule
  ))
  from information_schema.table_constraints tc
  join information_schema.referential_constraints rc on rc.constraint_name = tc.constraint_name
  where tc.constraint_name in (
    'import_rows_destination_application_id_fkey',
    'participant_invitations_application_id_fkey',
    'application_answers_application_id_fkey',
    'application_status_history_application_id_fkey',
    'participant_feature_snapshots_application_id_fkey',
    'cluster_memberships_application_id_fkey',
    'allocation_assignments_application_id_fkey',
    'schedule_publications_application_id_fkey'
  );
$$ language sql;

drop function _tmp_fk_introspect();
