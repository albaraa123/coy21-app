-- fingerprint_fix_followups.sql
--
-- Dedicated review of 20260727010000 (the row_fingerprint idempotent-reimport
-- fix) found two issues, both addressed here via `comment on` statements
-- (the original migration is already applied live and immutable — plpgsql
-- function bodies are unchanged, only documentation is corrected/added).
--
-- ISSUE 1 (Important): computeRowFingerprint (src/lib/import/normalization.ts)
-- hashes ONLY normalizedRow, not the raw cell text or the column mapping that
-- produced it. Two batches whose cells normalize identically but differ in
-- raw form (e.g. "  Acme Corp  " vs "Acme Corp" — both trim to the same
-- normalized value) will fingerprint-match and take the skip path, even
-- though application_answers.raw_value would legitimately have changed
-- between the two imports. The skip is correct for every column this system
-- actually uses downstream (normalized_value, and every applications column,
-- both of which the hash genuinely does cover) — the divergence is bounded
-- to raw_value, which is retained for audit/provenance purposes, not
-- participant-facing content or anything read by feature
-- extraction/clustering/allocation. Widening the hash to also cover
-- raw_row + the column mapping was considered and rejected: it would be a
-- non-trivial change to Task 8's already-reviewed, already-tested
-- computeRowFingerprint (a pure function with no knowledge of mappings,
-- called before per-application resolution even happens), for a benefit
-- bounded to provenance metadata rather than actual participant data. The
-- original migration's comments claimed an equivalence ("identical
-- normalized content was already applied") that is accurate for
-- normalized_value but overstated for raw_value — corrected below to state
-- the real, narrower guarantee honestly rather than leave a claim a future
-- maintainer could rely on incorrectly.
--
-- ISSUE 5 (Minor, documentation accuracy): the original migration's header
-- and `comment on column` both said rollback "clears" last_import_row_
-- fingerprint on the update path. The actual, correct implementation
-- RESTORES it from the before-image snapshot (via v_restorable_columns) —
-- this is the better behavior (see the original migration's own "THE
-- ROLLBACK INTERACTION IS LOAD-BEARING" section, which correctly describes
-- restoring, not clearing), but the summary comments contradicted the code
-- they were describing. Corrected.

comment on column applications.last_import_row_fingerprint is
  'sha256 of the normalized import row most recently APPLIED to this '
  'application by apply_import_row_transactional, matching '
  'import_rows.row_fingerprint (computed by computeRowFingerprint in '
  'src/lib/import/normalization.ts). Read only by '
  'apply_import_row_transactional, to classify an unchanged re-import as '
  '''skipped_unchanged'' per the design spec''s idempotency rules. Written '
  'by exactly two functions: set by apply_import_row_transactional, RESTORED '
  '(from the before-image snapshot, not nulled) by '
  'rollback_import_batch_transactional — a rolled-back application''s '
  'content reverts to its pre-import state, so its recorded fingerprint must '
  'revert too, and restoring from the snapshot (rather than unconditionally '
  'nulling) correctly recovers an earlier batch''s still-valid fingerprint '
  'when imports have stacked. NULL means no un-rolled-back import has '
  'written this application. KNOWN LIMITATION: computeRowFingerprint hashes '
  'only normalizedRow, not raw_row or the column mapping, so two imports '
  'whose cells normalize identically but differ in raw form (e.g. '
  'whitespace, casing collapsed by normalizeEmail/normalizePhone/'
  'normalizeYesNo, or multiselect delimiter/ordering differences) will '
  'match and skip even though application_answers.raw_value would have '
  'legitimately changed. This is accepted: the guarantee holds for '
  'normalized_value and every applications column (both fully covered by '
  'the hash), and the divergence is bounded to raw_value, which is '
  'audit/provenance metadata, not participant-facing content or anything '
  'read by downstream feature extraction/clustering/allocation.';

comment on function apply_import_row_transactional(uuid, uuid, uuid) is
  'Per-row transactional import apply (Task 15). Refuses to apply into a '
  'batch whose status is ''rolled_back'' — without this guard, a stale '
  'in-flight chunk call or a retried request racing a rollback could '
  're-apply a row whose action_taken the rollback just cleared to NULL, '
  're-creating an application the admin just deleted. Task 25: on the '
  'existing_unclaimed/existing_claimed path, compares the row''s '
  'row_fingerprint against the destination application''s '
  'last_import_row_fingerprint (read under the same FOR UPDATE lock) and '
  'classifies an exact match as ''skipped_unchanged'' — no snapshot, no '
  'applications/application_answers write, no status-history row, but still '
  'an ''import_skip_unchanged'' audit_logs entry. Every applied row records '
  'its fingerprint in applications.last_import_row_fingerprint; '
  'rollback_import_batch_transactional RESTORES that column from the '
  'before-image (see the column comment on '
  'applications.last_import_row_fingerprint for why restore-not-clear is '
  'correct), so a rolled-back batch can be cleanly re-imported. KNOWN '
  'LIMITATION: the fingerprint covers normalized_value only, not raw_value — '
  'see the column comment for the accepted, bounded divergence this implies. '
  'The is_sensitive key list inlined in this function''s application_answers '
  'insert must be kept in sync with SENSITIVE_QUESTION_KEYS in '
  'src/lib/validation/import.ts and the fixture in tests/rls/import.test.ts '
  '— all three currently list accessibility_requirements, '
  'dietary_requirements, emergency_contact_name, emergency_contact_phone, '
  'special_needs. If you change one, change all three.';

comment on function rollback_import_batch_transactional(uuid, uuid) is
  'Task 16. Undoes an entire import batch atomically, or refuses entirely. '
  'Blocks on any participant_feature_snapshots / cluster_memberships / '
  'allocation_assignments / schedule_publications / '
  'schedule_publication_draft_items reference, and on any '
  'participant_invitations row whose status has left ''not_sent'' (that FK '
  'cascades, so it has no DB-level backstop — see Task 3''s note; this check '
  'takes FOR UPDATE to close a TOCTOU race with a concurrent send). '
  'application_notes.application_id also cascades and is NOT checked: '
  'internal staff commentary with no external side effect, accepted as a '
  'documented gap. Only ''inserted''/''updated'' rows are restored: '
  '''skipped_unchanged'' rows (whether from a within-file duplicate or from '
  'Task 25''s unchanged-content short-circuit) wrote no participant data and '
  'captured no snapshot, so they are correctly excluded and their '
  'action_taken stamp is left in place as an audit trail. RESTORES (not '
  'clears) last_import_row_fingerprint from the before-image, along with '
  'every other import-writable column — see the column comment on '
  'applications.last_import_row_fingerprint for why. '
  'v_restorable_columns MUST stay in sync with '
  'apply_import_row_transactional''s v_text_columns/v_array_columns plus '
  'last_import_row_fingerprint '
  '(20260726108000_apply_import_row_function.sql, '
  '20260727010000_wire_row_fingerprint_idempotent_reimport.sql): this '
  'function can only restore what that function can write. Update both '
  'together.';
