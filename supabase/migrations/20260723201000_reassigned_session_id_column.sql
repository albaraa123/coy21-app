-- reassigned_session_id_column.sql

-- Real gap found during Task 10's live verification: reassign_blocked_
-- participant_transactional flips a blocked draft item to publishable/
-- reassigned, but schedule_publication_draft_items had no column to
-- record WHICH session it was reassigned to. Without this, the this-draft
-- capacity recount couldn't scope by target session (it counted every
-- reassigned item in the whole draft, rejecting an unrelated reassignment
-- to a different, empty session just because some other item filled an
-- unrelated one), and confirm_publication_transactional had no way to
-- publish the reassigned session's data at all — a reassigned run-publish
-- item would silently fall through with no schedule_publication_items row
-- (no allocation_assignments row exists for a blocked mandatory slot,
-- which is exactly why it was blocked in the first place).
alter table schedule_publication_draft_items
  add column reassigned_session_id uuid references sessions(id);

-- Unlike override_reason (descriptive text, app-layer-enforced pairing
-- with resolution = 'override_publish_with_gap' per Task 3's existing
-- convention), reassigned_session_id is load-bearing:
-- confirm_publication_transactional reads it to decide what to actually
-- publish. A resolution = 'reassigned' row with a null
-- reassigned_session_id would degrade to a confusing NOT NULL constraint
-- violation on schedule_publication_items.is_mandatory at confirm time,
-- rather than a clear error at the point the bad data was written — a DB
-- check constraint converts that into an immediate, clear failure at the
-- write site instead of a deferred, cryptic one at confirm.
alter table schedule_publication_draft_items
  add constraint schedule_publication_draft_items_reassigned_session_required
  check (resolution <> 'reassigned' or reassigned_session_id is not null);

comment on column schedule_publication_draft_items.reassigned_session_id is
  'Set by reassign_blocked_participant_transactional when resolution = ''reassigned''. The session this draft item will actually publish against at confirm time, replacing the original blocked mandatory assignment.';
