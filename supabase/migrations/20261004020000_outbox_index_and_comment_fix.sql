-- 20261004020000_outbox_index_and_comment_fix.sql
--
-- Two cheap follow-ups from code review of 20261004010000:
--
-- 1. The outbox-processing cron (added in a later migration) fetches
--    pending rows ordered by created_at ascending. The original
--    session_notification_outbox_pending_idx only indexed (status), so
--    Postgres could find pending rows via the index but still had to sort
--    them all by created_at before applying LIMIT. Replacing it with a
--    composite (status, created_at) partial index lets that query satisfy
--    both the filter and the ORDER BY directly from the index -- same
--    storage/maintenance cost (still a partial index), strictly better.
--
-- 2. The RLS-lockdown comment on session_notification_outbox cited
--    "the allocation_assignments RLS pattern" as the precedent, but that
--    table actually has an explicit staff-only policy, not zero policies.
--    The real reason this table's zero-policy RLS is safe is this repo's
--    actual "always-revoked by default" GRANT discipline (no table ever
--    gets a GRANT to authenticated/anon unless a traced code path needs
--    it -- see 20260816000000_canonical_authenticated_and_service_role_grants.sql),
--    so authenticated/anon get "permission denied" at the GRANT layer
--    before RLS is even evaluated. RLS-with-zero-policies is a correct,
--    redundant second layer, not the sole mechanism -- fixing the comment
--    to say so accurately.

drop index if exists session_notification_outbox_pending_idx;

create index session_notification_outbox_pending_idx
  on session_notification_outbox (status, created_at) where status = 'pending';

comment on table session_notification_outbox is
  'No client-facing RLS policies by design -- written only by enforce_session_lifecycle_booking_sync() and read only by the outbox-processing cron''s service-role client. Safe because this repo never grants authenticated/anon access to a table unless a traced code path needs it (see 20260816000000_canonical_authenticated_and_service_role_grants.sql); those roles get "permission denied" at the GRANT layer before RLS is evaluated. RLS-with-zero-policies is a redundant second layer here, not the sole lockdown mechanism.';
