-- rollback_import_batch_function.sql
--
-- Task 16, Step 1. Undo an entire import batch, as ONE Postgres transaction.
--
-- Atomicity guarantee: identical reasoning to
-- apply_import_row_transactional (20260726108000). PostgREST executes each
-- RPC call inside its own transaction and a plpgsql function body runs
-- entirely within the calling transaction. This function deliberately
-- contains NO exception-handling block around any write, so any error raised
-- anywhere inside it aborts the whole call and rolls back every write it
-- made. An `exception when others` block would create an implicit
-- subtransaction that could swallow a real error and commit a PARTIAL
-- rollback — a half-undone import is strictly worse than a refused one,
-- because the admin would have no way to tell which rows were reverted.
--
-- Safety model: this function is all-or-nothing by construction. Every
-- blocking check runs BEFORE the first write, and any blocker raises, so a
-- refused rollback provably touches nothing. This is why the checks are not
-- interleaved with the per-row restoration loop.

create function rollback_import_batch_transactional(
  p_batch_id uuid,
  p_actor_id uuid
) returns void as $$
declare
  v_batch import_batches;
  v_blocker_count int;
  v_blocker_detail text;
  v_scope_application_ids uuid[];
  v_row record;
  v_snapshot jsonb;
  v_answers jsonb;
  v_application_id uuid;
  v_old_status application_status;
  v_update_sql text;
  v_set_clauses text[];
  v_key text;
  -- Columns restored from previous_application_snapshot. Deliberately a
  -- fixed allowlist rather than "every key in the snapshot": the snapshot is
  -- to_jsonb(applications.*), which also contains id, applicant_id,
  -- created_at, application_number, import_batch_id and imported_email.
  -- Restoring id/applicant_id/application_number would be meaningless or
  -- actively harmful (identity churn, unique-index collisions), and
  -- created_at must not move. This list is exactly the set of columns
  -- apply_import_row_transactional is capable of WRITING on the update path
  -- (its v_text_columns + v_array_columns + birth_date + status), so it
  -- restores precisely what the import could have changed and nothing else.
  -- Kept deliberately in sync with that function's lists; see the
  -- COMMENT ON FUNCTION at the bottom of this file.
  v_restorable_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs',
    'birth_date'
  ];
  v_array_columns text[] := array['interests', 'track_interests'];
begin
  ------------------------------------------------------------------
  -- Lock the batch. Serializes two concurrent rollback attempts and, more
  -- importantly, serializes against anything else keying off batch status.
  -- The second caller finds status already 'rolled_back' and is rejected
  -- below rather than double-restoring.
  ------------------------------------------------------------------
  select * into v_batch from import_batches where id = p_batch_id for update;

  if v_batch.id is null then
    raise exception 'Import batch % not found', p_batch_id;
  end if;

  if v_batch.status = 'rolled_back' then
    raise exception 'Import batch % has already been rolled back', p_batch_id;
  end if;

  ------------------------------------------------------------------
  -- BLOCKING CHECKS. All of these run before ANY write. Each names the
  -- specific blocking dependency in its message, because a generic "cannot
  -- roll back" gives the admin no path forward — they need to know which
  -- downstream artifact to retract first.
  --
  -- Each check joins through applications.import_batch_id = p_batch_id.
  -- Note this deliberately covers applications the batch INSERTED. Rows the
  -- batch merely UPDATED keep whatever import_batch_id they had, so a
  -- pre-existing application that the batch updated is matched via
  -- import_rows.destination_application_id instead — both sets are unioned
  -- into v_batch_application_ids below so no application in scope is missed.
  ------------------------------------------------------------------
  -- Held as a plain uuid[] local rather than a temporary table: a temp table
  -- would persist for the session under PostgREST's connection pooling if a
  -- later statement ever ran outside this transaction, and `on commit drop`
  -- makes the function non-reentrant within one transaction. An array is
  -- transaction-agnostic and these batches are bounded by spreadsheet size.
  select coalesce(array_agg(distinct id), array[]::uuid[])
  into v_scope_application_ids
  from (
    select a.id
    from applications a
    where a.import_batch_id = p_batch_id
    union
    select r.destination_application_id as id
    from import_rows r
    where r.import_batch_id = p_batch_id
      and r.destination_application_id is not null
      and r.action_taken in ('inserted', 'updated')
  ) scope;

  -- 1. Feature extraction
  select count(*) into v_blocker_count
  from participant_feature_snapshots s
  where s.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_feature_snapshots row(s) reference applications from this batch. Delete the feature extraction run first.',
      p_batch_id, v_blocker_count;
  end if;

  -- 2. Clustering
  select count(*) into v_blocker_count
  from cluster_memberships c
  where c.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % cluster_memberships row(s) reference applications from this batch. Delete the clustering run first.',
      p_batch_id, v_blocker_count;
  end if;

  -- 3. Allocation
  select count(*) into v_blocker_count
  from allocation_assignments al
  where al.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % allocation_assignments row(s) reference applications from this batch. Delete the allocation run first.',
      p_batch_id, v_blocker_count;
  end if;

  -- 4. Schedule publication
  select count(*) into v_blocker_count
  from schedule_publications sp
  where sp.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publications row(s) reference applications from this batch. Retract the publication first.',
      p_batch_id, v_blocker_count;
  end if;

  -- 5. Participant invitations that have left 'not_sent'.
  --
  -- REQUIRED per Task 3's post-implementation note, and the single most
  -- dangerous case in this function. participant_invitations.application_id
  -- is `on delete cascade` (verified against
  -- 20260726104000_participant_invitations_table.sql), so unlike checks 1-4
  -- — whose FKs are NO ACTION and would themselves refuse the delete — this
  -- one has NO database-level backstop. Without this explicit check a
  -- 'sent' or 'accepted' invitation would be silently deleted along with its
  -- application, destroying the record of an email already delivered to a
  -- real external person for whom a real Supabase Auth user already exists.
  -- The invitation row would vanish with no trace and no way to reconcile
  -- the orphaned Auth user. Blocking is mandatory; the FK must never be
  -- allowed to decide this.
  select count(*), string_agg(distinct pi.status, ', ' order by pi.status)
  into v_blocker_count, v_blocker_detail
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
    and pi.status <> 'not_sent';
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_invitations row(s) for applications in this batch are no longer in ''not_sent'' status (found: %). An invitation has already been sent to a real recipient and an auth user may exist for them; revoke the invitation(s) before rolling back.',
      p_batch_id, v_blocker_count, v_blocker_detail;
  end if;

  ------------------------------------------------------------------
  -- No blockers. Perform the rollback.
  --
  -- Rows are processed with FOR UPDATE on the import row, mirroring
  -- apply_import_row_transactional, so a rollback cannot interleave with a
  -- still-running chunked import writing the same rows.
  ------------------------------------------------------------------
  for v_row in
    select * from import_rows
    where import_batch_id = p_batch_id
      and action_taken in ('inserted', 'updated')
    order by excel_row_number
    for update
  loop
    v_application_id := v_row.destination_application_id;

    if v_row.action_taken = 'inserted' then
      ------------------------------------------------------------------
      -- INSERT PATH: hard-delete the application the import created.
      --
      -- application_answers, application_status_history (and email_log) all
      -- carry `on delete cascade` on application_id — verified against
      -- 20260726101000_application_answers_table.sql and
      -- 20260721210419_status_history_and_email_log.sql — so they go with
      -- it. import_rows.destination_application_id is `on delete set null`
      -- (Task 2's follow-up fix, 20260726103500), so this staging row
      -- survives as an audit trail with its destination reference cleared,
      -- rather than the FK refusing the delete. Any not_sent
      -- participant_invitations row cascades away, which is correct: an
      -- unsent invitation has no external side effect. Sent ones were
      -- already refused above.
      --
      -- The audit row is written BEFORE the delete: audit_logs.entity_id has
      -- no FK to applications, but writing first keeps the ordering
      -- unambiguous and guarantees the audit exists in the same transaction
      -- as the deletion it describes. No status-history row is written for
      -- this path — it would cascade away with the application microseconds
      -- later, so it could never be read.
      ------------------------------------------------------------------
      if v_application_id is not null then
        insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
        values (
          'application',
          v_application_id,
          'import_rollback_delete',
          'admin',
          p_actor_id,
          jsonb_build_object(
            'batchId', p_batch_id,
            'importRowId', v_row.id,
            'excelRowNumber', v_row.excel_row_number
          )
        );

        delete from applications where id = v_application_id;
      end if;

    else
      ------------------------------------------------------------------
      -- UPDATE PATH: restore the application and its answers from the
      -- before-image snapshots apply_import_row_transactional captured.
      ------------------------------------------------------------------
      v_snapshot := v_row.previous_application_snapshot;

      if v_application_id is null or v_snapshot is null then
        -- An 'updated' row with no snapshot means Task 15's invariant (write
        -- the snapshot in the same transaction as the overwrite) was
        -- violated. There is no recoverable before-image, so restoring is
        -- impossible. Refuse the WHOLE rollback rather than silently leaving
        -- this application overwritten while reverting its neighbours.
        raise exception 'Cannot roll back import batch %: import row % is marked ''updated'' but has no recoverable snapshot (destination_application_id=%, previous_application_snapshot is null).',
          p_batch_id, v_row.id, v_application_id;
      end if;

      -- Lock the target application for the rest of the transaction, same
      -- as the apply path does, so no concurrent writer can interleave
      -- between the restore and the answers rebuild below.
      perform 1 from applications where id = v_application_id for update;

      -- Build the restoring UPDATE dynamically over the fixed allowlist.
      -- Every allowlisted column is set unconditionally — including to NULL
      -- when the snapshot's value was NULL. This is the crucial difference
      -- from the apply path, which only touches keys PRESENT in the
      -- incoming row: a restore must reinstate the exact prior tuple, so a
      -- column the import populated from empty must go back to empty. Using
      -- the apply path's "only if present" logic here would leave
      -- import-written values stranded in columns that were NULL before.
      v_set_clauses := array[]::text[];

      foreach v_key in array v_restorable_columns loop
        v_set_clauses := v_set_clauses || format('%I = %L', v_key, v_snapshot->>v_key);
      end loop;

      foreach v_key in array v_array_columns loop
        -- to_jsonb() renders a text[] column as a JSON array (or JSON null).
        -- Rebuild it as a real text[]; a NULL snapshot value restores NULL,
        -- which is distinct from an empty array and must stay distinct.
        v_set_clauses := v_set_clauses || format(
          '%I = %L::text[]',
          v_key,
          case
            when v_snapshot->v_key is null or jsonb_typeof(v_snapshot->v_key) = 'null' then null
            else (select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_snapshot->v_key) as e)
          end
        );
      end loop;

      -- status is an enum column and is restored explicitly with its cast.
      v_old_status := (v_snapshot->>'status')::application_status;
      v_set_clauses := v_set_clauses || format('status = %L::application_status', v_old_status);

      -- imported_email / import_batch_id are restored too: the apply path
      -- does not change them on the update path, but restoring them from the
      -- snapshot is harmless and keeps the tuple exactly as it was.
      v_update_sql := format(
        'update applications set %s where id = %L',
        array_to_string(v_set_clauses, ', '),
        v_application_id
      );
      execute v_update_sql;

      ------------------------------------------------------------------
      -- Restore application_answers.
      --
      -- THIS IS THE SUBTLEST PART OF THE FUNCTION. previous_answers_snapshot
      -- is jsonb_agg(to_jsonb(aa.*)) over ALL application_answers rows for
      -- this application at the instant before the import overwrote them
      -- (see apply_import_row_transactional's update path). It therefore
      -- contains complete rows, including their original `id`s.
      --
      -- A value-by-value "revert" would be WRONG: the import upserts one
      -- answer row per key in the normalized row, so it can CREATE answer
      -- rows for question_keys that did not exist before. Those rows have no
      -- counterpart in the snapshot, so reverting values alone would leave
      -- them behind as phantom answers that predate nothing.
      --
      -- The correct semantics are "make the answer set equal the snapshot":
      -- delete every current answer row for this application, then re-insert
      -- the snapshot rows verbatim, preserving their original ids. This
      -- necessarily drops import-created keys (not in the snapshot) and
      -- restores pre-existing ones to their exact prior tuple — including
      -- source, is_sensitive, question_label, value_type, import_batch_id and
      -- created_at, all of which the import's `on conflict do update` could
      -- have modified and none of which a value-only revert would restore.
      --
      -- Deleting ALL answers (not just source='import' ones) is intentional
      -- and safe precisely BECAUSE ids are preserved on re-insert: a
      -- manually-entered (source='manual') answer that existed pre-import is
      -- in the snapshot and comes back with the same id, so nothing that
      -- predates the import is lost. The only rows that fail to return are
      -- those that did not exist when the snapshot was taken — which is
      -- exactly the set that should not survive a rollback.
      --
      -- Known and accepted limitation: a manual answer added AFTER the
      -- import but BEFORE the rollback is also not in the snapshot and is
      -- therefore removed. Restoring a point-in-time snapshot cannot
      -- preserve later edits without merge semantics the plan does not
      -- define, and preserving them would make the restored state match
      -- neither the pre-import nor the post-import tuple. This is documented
      -- rather than silently handled.
      ------------------------------------------------------------------
      delete from application_answers where application_id = v_application_id;

      v_answers := coalesce(v_row.previous_answers_snapshot, '[]'::jsonb);

      insert into application_answers (
        id, application_id, question_key, question_label, normalized_value,
        raw_value, value_type, source, is_sensitive, import_batch_id,
        created_at, updated_at
      )
      select
        (e->>'id')::uuid,
        (e->>'application_id')::uuid,
        e->>'question_key',
        e->>'question_label',
        e->>'normalized_value',
        e->>'raw_value',
        e->>'value_type',
        e->>'source',
        (e->>'is_sensitive')::boolean,
        (e->>'import_batch_id')::uuid,
        (e->>'created_at')::timestamptz,
        (e->>'updated_at')::timestamptz
      from jsonb_array_elements(v_answers) as e;

      ------------------------------------------------------------------
      -- Document the restoration. Unlike the insert path, this application
      -- survives, so both a status-history row and an audit row are
      -- readable afterwards and both are written, as the plan requires.
      ------------------------------------------------------------------
      insert into application_status_history (application_id, old_status, new_status, changed_by, note)
      values (
        v_application_id,
        'accepted',
        v_old_status,
        p_actor_id,
        format('Restored by rollback of import batch %s', p_batch_id)
      );

      insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata, new_values)
      values (
        'application',
        v_application_id,
        'import_rollback_restore',
        'admin',
        p_actor_id,
        jsonb_build_object(
          'batchId', p_batch_id,
          'importRowId', v_row.id,
          'excelRowNumber', v_row.excel_row_number,
          'restoredAnswerCount', jsonb_array_length(v_answers)
        ),
        v_snapshot
      );
    end if;

    -- Clear the applied state so the staging row reflects that its effect
    -- has been undone. action_taken is nulled rather than the row being
    -- deleted, keeping import_rows as a complete audit trail of what the
    -- batch did (and, via the surviving raw_row/normalized_row, what it
    -- would do if re-imported). The snapshots are cleared because they no
    -- longer describe a live overwrite and retaining them would imply a
    -- pending restore that has already happened.
    update import_rows set
      action_taken = null,
      previous_application_snapshot = null,
      previous_answers_snapshot = null
    where id = v_row.id;
  end loop;

  ------------------------------------------------------------------
  -- Mark the batch rolled back and zero the applied counters, which now
  -- describe writes that no longer exist.
  ------------------------------------------------------------------
  update import_batches set
    status = 'rolled_back',
    inserted_count = 0,
    updated_count = 0,
    skipped_count = 0,
    processing_lock_token = null,
    processing_lock_expires_at = null,
    next_chunk_offset = 0
  where id = p_batch_id;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'import_batch',
    p_batch_id,
    'import_rollback',
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_batch_id)
  );
end;
$$ language plpgsql set search_path = public, pg_temp;

comment on function rollback_import_batch_transactional(uuid, uuid) is
  'Task 16. Undoes an entire import batch atomically, or refuses entirely. '
  'Blocks on any participant_feature_snapshots / cluster_memberships / '
  'allocation_assignments / schedule_publications reference, and on any '
  'participant_invitations row whose status has left ''not_sent'' (that FK '
  'cascades, so it has no DB-level backstop — see Task 3''s note). '
  'v_restorable_columns MUST stay in sync with '
  'apply_import_row_transactional''s v_text_columns/v_array_columns '
  '(20260726108000_apply_import_row_function.sql): this function can only '
  'restore what that function can write. Update both together.';
