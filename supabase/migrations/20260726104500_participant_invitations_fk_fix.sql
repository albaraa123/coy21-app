-- participant_invitations_fk_fix.sql
--
-- Fixes a real bug found in code-quality review of
-- 20260726104000_participant_invitations_table.sql — the same bug class
-- already found and fixed once in this phase for
-- import_rows.destination_application_id (see
-- 20260726103500_import_rows_fk_and_index_fixes.sql).
--
-- participant_invitations.invited_user_id had no `on delete` clause
-- (default NO ACTION/restrict). revokeInvitation (a later task) calls
-- admin.auth.admin.deleteUser(invitation.invited_user_id) for unclaimed
-- invitations — profiles.id references auth.users(id) on delete cascade, so
-- deleting the auth.users row cascades to delete the profiles row, which
-- this FK would then block. `on delete set null` lets the invitation row
-- survive (with status already set to 'revoked' by the caller before the
-- delete, so no meaningful state is lost by nulling the now-deleted user's
-- id) rather than blocking the revoke.
alter table participant_invitations drop constraint participant_invitations_invited_user_id_fkey;
alter table participant_invitations add constraint participant_invitations_invited_user_id_fkey
  foreign key (invited_user_id) references profiles(id) on delete set null;
