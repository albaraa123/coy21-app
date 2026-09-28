-- document_combined_rpc_conflict_detection.sql
--
-- Documentation-only follow-up to 20260723060000_session_people_transactional_functions.sql,
-- per code review: the header comment on update_session_and_assignments_transactional
-- attributed conflict detection to its own final re-validation block, but in
-- the common "reschedule + assign the same person" case, the pre-existing
-- per-row enforce_speaker_no_conflict trigger fires first during the
-- delete-then-reinsert loop (it fires unconditionally on plain insert) and
-- raises before the final block ever runs. The final block remains a real,
-- intentional defense-in-depth backstop for edge cases the row-level trigger
-- can't see — this comment corrects the attribution, it does not change any
-- behavior.
comment on function update_session_and_assignments_transactional(uuid, timestamptz, timestamptz, uuid, uuid, jsonb) is
  'Combined schedule (start/end/room) + full assignment-set replacement for a session, in one transaction. In the common case, the pre-existing per-row enforce_speaker_no_conflict trigger (fires on every insert during the delete-then-reinsert loop below, since the session''s row is already updated to its new time earlier in this same transaction) is what actually raises the conflict error for a "reschedule + assign the same person" scenario. This function''s own final re-validation block is a defense-in-depth backstop for conflict shapes the row-level trigger does not see on its own, not the primary detection path — both mechanisms roll back the entire transaction on failure, so the atomicity guarantee holds regardless of which one raises first.';
