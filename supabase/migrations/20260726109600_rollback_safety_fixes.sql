-- rollback_safety_fixes.sql
--
-- Dedicated code-quality review of Task 16 found three Important issues in
-- rollback_import_batch_transactional (20260726109000) and
-- apply_import_row_transactional (20260726108000). All three are fixed here
-- via `create or replace function` (both originals are already applied
-- live and immutable).

-- ---------------------------------------------------------------------
-- Fix 1 (review finding A2): apply_import_row_transactional had no guard
-- against being invoked on a batch that has already been rolled back.
-- rollback_import_batch_transactional clears import_rows.action_taken to
-- NULL when it undoes a row (see 20260726109000's comment on that choice),
-- which is exactly what apply_import_row_transactional's own
-- already_applied idempotency guard keys off of. A stale in-flight chunk
-- call, a client retry, or a resumed batch that races a rollback could
-- therefore see action_taken = null and silently RE-APPLY a row into a
-- batch the admin just rolled back, re-creating applications they just
-- deleted. The application-layer lock token in confirm/actions.ts is the
-- current defense, but the rollback itself clears that token (releasing
-- the mutual exclusion, not holding it) — there was no RPC-level backstop.
-- Fixed by checking the batch's status before doing anything else.
-- ---------------------------------------------------------------------
create or replace function apply_import_row_transactional(
  p_import_row_id uuid,
  p_import_batch_id uuid,
  p_actor_id uuid
) returns text as $$
declare
  v_batch_status text;
  v_row import_rows;
  v_normalized jsonb;
  v_email text;
  v_application_id uuid;
  v_previous_application jsonb;
  v_previous_answers jsonb;
  v_raw_values jsonb;
  v_key text;
  v_value jsonb;
  v_is_array boolean;
  v_application_number text;
  v_text_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs'
  ];
  v_array_columns text[] := array['interests', 'track_interests'];
  v_update_sql text;
  v_set_clauses text[] := array[]::text[];
begin
  -- NEW: refuse to apply into a rolled-back batch. Without this, a race
  -- between a rollback and a stale/retried chunk call could re-create
  -- applications the admin just deleted (review finding A2).
  select status into v_batch_status from import_batches where id = p_import_batch_id;
  if v_batch_status = 'rolled_back' then
    raise exception 'Import batch % has been rolled back; cannot apply row %', p_import_batch_id, p_import_row_id;
  end if;

  select * into v_row from import_rows
  where id = p_import_row_id and import_batch_id = p_import_batch_id
  for update;

  if v_row.id is null then
    raise exception 'Import row % not found in batch %', p_import_row_id, p_import_batch_id;
  end if;

  if v_row.action_taken is not null then
    return 'already_applied';
  end if;

  if v_row.validation_status = 'invalid' then
    update import_rows set action_taken = 'skipped_error' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'blocked_downstream' then
    update import_rows set action_taken = 'blocked' where id = v_row.id;
    return 'skipped';
  end if;

  if v_row.duplicate_status = 'duplicate_in_file' then
    update import_rows set action_taken = 'skipped_unchanged' where id = v_row.id;
    return 'skipped';
  end if;

  v_normalized := coalesce(v_row.normalized_row, '{}'::jsonb);
  v_email := v_normalized->>'email';
  if v_email is null or v_email = '' then
    raise exception 'Import row % has no normalized email but passed validation', v_row.id;
  end if;

  select coalesce(jsonb_object_agg(m.target_key, to_jsonb(v_row.raw_row->>m.source_column_index)), '{}'::jsonb)
  into v_raw_values
  from import_column_mappings m
  where m.import_batch_id = p_import_batch_id
    and m.target_key is not null
    and m.target_kind <> 'ignored';

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    v_application_id := v_row.destination_application_id;
    if v_application_id is null then
      raise exception 'Import row % is marked % but has no destination_application_id', v_row.id, v_row.duplicate_status;
    end if;

    perform 1 from applications where id = v_application_id for update;

    select to_jsonb(a.*) into v_previous_application from applications a where a.id = v_application_id;
    if v_previous_application is null then
      raise exception 'Destination application % for import row % no longer exists', v_application_id, v_row.id;
    end if;

    select coalesce(jsonb_agg(to_jsonb(aa.*)), '[]'::jsonb) into v_previous_answers
    from application_answers aa where aa.application_id = v_application_id;

    update import_rows set
      action_taken = 'updated',
      previous_application_snapshot = v_previous_application,
      previous_answers_snapshot = v_previous_answers,
      destination_application_id = v_application_id
    where id = v_row.id;
  else
    v_application_number := next_application_number();

    insert into applications (applicant_id, imported_email, import_batch_id, status, application_number)
    values (null, v_email, p_import_batch_id, 'accepted', v_application_number)
    returning id into v_application_id;

    update import_rows set
      action_taken = 'inserted',
      destination_application_id = v_application_id
    where id = v_row.id;
  end if;

  foreach v_key in array v_text_columns loop
    if v_normalized ? v_key then
      v_value := v_normalized->v_key;
      v_is_array := jsonb_typeof(v_value) = 'array';
      v_set_clauses := v_set_clauses || format(
        '%I = %L',
        v_key,
        case
          when v_value is null or jsonb_typeof(v_value) = 'null' then null
          when v_is_array then (select string_agg(e, ', ') from jsonb_array_elements_text(v_value) as e)
          else v_value #>> '{}'
        end
      );
    end if;
  end loop;

  foreach v_key in array v_array_columns loop
    if v_normalized ? v_key then
      v_value := v_normalized->v_key;
      v_set_clauses := v_set_clauses || format(
        '%I = %L::text[]',
        v_key,
        case
          when v_value is null or jsonb_typeof(v_value) = 'null' then null
          when jsonb_typeof(v_value) = 'array' then (
            select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_value) as e
          )
          else array[v_value #>> '{}']
        end
      );
    end if;
  end loop;

  if v_normalized ? 'birth_date' then
    declare
      v_birth_raw text := v_normalized->>'birth_date';
      v_birth_date date;
    begin
      if v_birth_raw is not null and v_birth_raw <> '' then
        begin
          v_birth_date := v_birth_raw::date;
          v_set_clauses := v_set_clauses || format('birth_date = %L::date', v_birth_date);
        exception when others then
          null;
        end;
      end if;
    end;
  end if;

  if array_length(v_set_clauses, 1) > 0 then
    v_update_sql := format(
      'update applications set %s where id = %L',
      array_to_string(v_set_clauses, ', '),
      v_application_id
    );
    execute v_update_sql;
  end if;

  for v_key, v_value in select * from jsonb_each(v_normalized) loop
    insert into application_answers (
      application_id, question_key, normalized_value, raw_value, value_type,
      source, is_sensitive, import_batch_id
    ) values (
      v_application_id,
      v_key,
      case
        when jsonb_typeof(v_value) = 'string' then v_value #>> '{}'
        else v_value::text
      end,
      coalesce(
        v_raw_values->>v_key,
        case
          when jsonb_typeof(v_value) = 'string' then v_value #>> '{}'
          else v_value::text
        end
      ),
      case when jsonb_typeof(v_value) = 'array' then 'multiselect' else 'text' end,
      'import',
      v_key in (
        'accessibility_requirements', 'dietary_requirements',
        'emergency_contact_name', 'emergency_contact_phone', 'special_needs'
      ),
      p_import_batch_id
    )
    on conflict (application_id, question_key, source) do update set
      normalized_value = excluded.normalized_value,
      raw_value = excluded.raw_value,
      value_type = excluded.value_type,
      is_sensitive = excluded.is_sensitive,
      import_batch_id = excluded.import_batch_id;
  end loop;

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    insert into application_status_history (application_id, old_status, new_status, changed_by, note)
    values (
      v_application_id,
      (v_previous_application->>'status')::application_status,
      'accepted',
      p_actor_id,
      format('Updated by import batch %s', p_import_batch_id)
    );
  else
    insert into application_status_history (application_id, old_status, new_status, changed_by, note)
    values (v_application_id, null, 'accepted', p_actor_id, format('Created by import batch %s', p_import_batch_id));
  end if;

  insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
  values (
    'application',
    v_application_id,
    case when v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then 'import_update' else 'import_insert' end,
    'admin',
    p_actor_id,
    jsonb_build_object('batchId', p_import_batch_id, 'importRowId', v_row.id)
  );

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    return 'updated';
  end if;
  return 'inserted';
end;
$$ language plpgsql set search_path = public, pg_temp;

-- ---------------------------------------------------------------------
-- Fix 2 (review finding A3): the participant_invitations blocking check
-- was a plain, unlocked SELECT under READ COMMITTED. An invitation
-- transitioning not_sent -> sent in a concurrently-committing transaction,
-- between this check and the loop's cascade-delete, would not be seen —
-- and that FK has no DB-level backstop (CASCADE, not NO ACTION), so the
-- sent invitation would be silently destroyed. This is the exact outcome
-- the check exists to prevent, and the only one of the five blocking
-- checks with a real external side effect (a delivered email, an existing
-- Supabase Auth user for the recipient). Fixed by adding FOR UPDATE, so
-- any concurrent writer to a participant_invitations row in scope
-- serializes against this check rather than racing it.
--
-- Fix 3 (review finding A1): the blocking checks covered 4 downstream
-- pipeline tables but missed schedule_publication_draft_items.application_id
-- (NO ACTION, not null) — a real, reachable state, since the draft tables
-- exist precisely for the pre-publication review step. Without this check,
-- rollback would fail late with a raw "violates foreign key constraint"
-- error instead of one of the five friendly, actionable messages. Added as
-- check 6. (allocation_issues.application_id is also NO ACTION but
-- nullable and low-stakes; application_notes.application_id CASCADEs and
-- is now explicitly documented below as an accepted, low-stakes gap —
-- staff-authored commentary on an application that is itself being
-- deleted, no external side effect, unlike the invitations case.)
-- ---------------------------------------------------------------------
create or replace function rollback_import_batch_transactional(
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
  v_restorable_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs',
    'birth_date'
  ];
  v_array_columns text[] := array['interests', 'track_interests'];
begin
  select * into v_batch from import_batches where id = p_batch_id for update;

  if v_batch.id is null then
    raise exception 'Import batch % not found', p_batch_id;
  end if;

  if v_batch.status = 'rolled_back' then
    raise exception 'Import batch % has already been rolled back', p_batch_id;
  end if;

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

  select count(*) into v_blocker_count
  from participant_feature_snapshots s
  where s.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_feature_snapshots row(s) reference applications from this batch. Delete the feature extraction run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from cluster_memberships c
  where c.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % cluster_memberships row(s) reference applications from this batch. Delete the clustering run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from allocation_assignments al
  where al.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % allocation_assignments row(s) reference applications from this batch. Delete the allocation run first.',
      p_batch_id, v_blocker_count;
  end if;

  select count(*) into v_blocker_count
  from schedule_publications sp
  where sp.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publications row(s) reference applications from this batch. Retract the publication first.',
      p_batch_id, v_blocker_count;
  end if;

  -- NEW check 6 (review finding A1): schedule_publication_draft_items is
  -- NO ACTION and would otherwise abort the transaction with a raw FK
  -- error rather than a named, actionable blocker.
  select count(*) into v_blocker_count
  from schedule_publication_draft_items spdi
  where spdi.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publication_draft_items row(s) reference applications from this batch. Discard the schedule draft first.',
      p_batch_id, v_blocker_count;
  end if;

  -- Row lock added (review finding A3): serializes against a concurrent
  -- writer transitioning an invitation out of not_sent between this check
  -- and the delete below. participant_invitations.application_id CASCADEs
  -- with no DB-level backstop, so this check must not race. `FOR UPDATE`
  -- cannot be combined with aggregate functions in the same statement
  -- (Postgres rejects `count(*) ... for update` outright), so the lock is
  -- taken in a separate, non-aggregating statement first — the lock is
  -- held for the rest of this transaction regardless of which statement
  -- acquired it, so the subsequent aggregate query still runs under it.
  perform 1
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
  for update of pi;

  select count(*), string_agg(distinct pi.status, ', ' order by pi.status)
  into v_blocker_count, v_blocker_detail
  from participant_invitations pi
  where pi.application_id = any(v_scope_application_ids)
    and pi.status <> 'not_sent';
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % participant_invitations row(s) for applications in this batch are no longer in ''not_sent'' status (found: %). An invitation has already been sent to a real recipient and an auth user may exist for them; revoke the invitation(s) before rolling back.',
      p_batch_id, v_blocker_count, v_blocker_detail;
  end if;

  for v_row in
    select * from import_rows
    where import_batch_id = p_batch_id
      and action_taken in ('inserted', 'updated')
    order by excel_row_number
    for update
  loop
    v_application_id := v_row.destination_application_id;

    if v_row.action_taken = 'inserted' then
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

        -- application_notes.application_id CASCADEs (verified against
        -- 20260722170415_assigned_reviewer_and_notes.sql) and is not
        -- checked as a blocker: staff-authored review notes are internal
        -- commentary with no external side effect, unlike a sent
        -- invitation, and the application they annotate is itself being
        -- deleted here. Any notes are silently lost with this delete —
        -- an accepted, documented gap, not an oversight.
        delete from applications where id = v_application_id;
      end if;

    else
      v_snapshot := v_row.previous_application_snapshot;

      if v_application_id is null or v_snapshot is null then
        raise exception 'Cannot roll back import batch %: import row % is marked ''updated'' but has no recoverable snapshot (destination_application_id=%, previous_application_snapshot is null).',
          p_batch_id, v_row.id, v_application_id;
      end if;

      perform 1 from applications where id = v_application_id for update;

      -- Current status is read BEFORE the restoring UPDATE so the status-
      -- history row below records the real transition, not a fictitious
      -- accepted -> accepted (or accepted -> <snapshot status>, which was
      -- previously wrong whenever the pre-import status was not
      -- 'accepted' — the apply path's update branch never writes status,
      -- so this was silently inaccurate for any non-'accepted' pre-import
      -- application).
      select status into v_old_status from applications where id = v_application_id;

      v_set_clauses := array[]::text[];

      foreach v_key in array v_restorable_columns loop
        v_set_clauses := v_set_clauses || format('%I = %L', v_key, v_snapshot->>v_key);
      end loop;

      foreach v_key in array v_array_columns loop
        v_set_clauses := v_set_clauses || format(
          '%I = %L::text[]',
          v_key,
          case
            when v_snapshot->v_key is null or jsonb_typeof(v_snapshot->v_key) = 'null' then null
            else (select coalesce(array_agg(e), array[]::text[]) from jsonb_array_elements_text(v_snapshot->v_key) as e)
          end
        );
      end loop;

      v_set_clauses := v_set_clauses || format('status = %L::application_status', (v_snapshot->>'status')::application_status);

      v_update_sql := format(
        'update applications set %s where id = %L',
        array_to_string(v_set_clauses, ', '),
        v_application_id
      );
      execute v_update_sql;

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

      insert into application_status_history (application_id, old_status, new_status, changed_by, note)
      values (
        v_application_id,
        v_old_status,
        (v_snapshot->>'status')::application_status,
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

    update import_rows set
      action_taken = null,
      previous_application_snapshot = null,
      previous_answers_snapshot = null
    where id = v_row.id;
  end loop;

  -- skipped_count is no longer zeroed (review finding A8): skipped rows
  -- were never applied, so the rollback does not undo them, and their
  -- action_taken is intentionally left untouched by the loop above (which
  -- only processes 'inserted'/'updated' rows). Reporting 0 skipped while
  -- import_rows still carries skipped_error/blocked stamps would be an
  -- internal inconsistency in the very audit trail this design otherwise
  -- takes care to preserve.
  update import_batches set
    status = 'rolled_back',
    inserted_count = 0,
    updated_count = 0,
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
  'allocation_assignments / schedule_publications / '
  'schedule_publication_draft_items reference, and on any '
  'participant_invitations row whose status has left ''not_sent'' (that FK '
  'cascades, so it has no DB-level backstop — see Task 3''s note; this check '
  'takes FOR UPDATE to close a TOCTOU race with a concurrent send). '
  'application_notes.application_id also cascades and is NOT checked: '
  'internal staff commentary with no external side effect, accepted as a '
  'documented gap. v_restorable_columns MUST stay in sync with '
  'apply_import_row_transactional''s v_text_columns/v_array_columns '
  '(20260726108000_apply_import_row_function.sql): this function can only '
  'restore what that function can write. Update both together.';

comment on function apply_import_row_transactional(uuid, uuid, uuid) is
  'Per-row transactional import apply (Task 15). Refuses to apply into a '
  'batch whose status is ''rolled_back'' — without this guard, a stale '
  'in-flight chunk call or a retried request racing a rollback could '
  're-apply a row whose action_taken the rollback just cleared to NULL, '
  're-creating an application the admin just deleted. The is_sensitive key '
  'list inlined in this function''s application_answers insert must be kept '
  'in sync with SENSITIVE_QUESTION_KEYS in src/lib/validation/import.ts and '
  'the fixture in tests/rls/import.test.ts — all three currently list '
  'accessibility_requirements, dietary_requirements, emergency_contact_name, '
  'emergency_contact_phone, special_needs. If you change one, change all '
  'three.';
