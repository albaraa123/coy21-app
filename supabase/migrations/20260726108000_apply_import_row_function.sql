-- apply_import_row_function.sql
--
-- Task 15, Step 2. The entire per-row import apply, as ONE Postgres
-- transaction.
--
-- Why this exists at all: the plan's illustrative `applyImportRow` did the
-- before-image snapshot capture and the overwrite as two separate supabase-js
-- `await` calls. That is not atomic — a concurrent reader/writer can observe
-- (or interleave with) the half-applied state between them, and a crash
-- between the two leaves an application overwritten with NO recoverable
-- snapshot, which silently breaks Task 16's rollback. supabase-js has no
-- client-side multi-statement transaction primitive, so a plpgsql function is
-- the correct mechanism, exactly as Phase 5's
-- confirm_publication_transactional established.
--
-- Atomicity guarantee: PostgREST executes each RPC call inside its own
-- transaction, and a plpgsql function body runs entirely within the calling
-- transaction. This function deliberately contains NO exception-handling
-- block, so any error raised anywhere inside it aborts the whole call and
-- rolls back every write it made — snapshot, application insert/update,
-- answers, status history, and the import_rows.action_taken stamp either all
-- land together or none of them do. (An `exception when others` block here
-- would create an implicit subtransaction that could swallow a real error and
-- commit a partial apply — precisely what must not happen. Same reasoning
-- documented in confirm_publication_transactional.)
--
-- Idempotency / re-entrancy: the function takes a row-level FOR UPDATE lock
-- on the import_rows row and returns 'already_applied' if action_taken is
-- already set. A duplicate/retried chunk call therefore cannot produce a
-- second application for the same source row. This is the last line of
-- defence behind the batch-level lock token in actions.ts.

create function apply_import_row_transactional(
  p_import_row_id uuid,
  p_import_batch_id uuid,
  p_actor_id uuid
) returns text as $$
declare
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
  -- Columns that genuinely exist on `applications` today. Re-derived
  -- column-by-column against 20260721202027_applications_table.sql and
  -- src/types/database.ts's applications Row type at implementation time
  -- rather than trusting the plan's comment, as the plan required.
  --
  -- Deviation from the plan's KNOWN_APPLICATION_COLUMNS list, both
  -- directions:
  --   * REMOVED 'topics_to_learn' from the array-typed handling: the plan
  --     lists it as a known column (it is one — `text`), but
  --     row-validation.ts's MULTISELECT_KEYS normalizes it to a JSON ARRAY.
  --     Writing an array into a `text` column would either error or stringify
  --     unpredictably, so it is handled as a scalar text column below and the
  --     array form is joined back to a comma-separated string. The full
  --     structured array is still preserved losslessly in
  --     application_answers.normalized_value as JSON.
  --   * ADDED the columns the plan's list omitted but which really exist and
  --     can legitimately be imported: climate_experience, past_initiatives,
  --     participation_goals, content_type_pref, priority_sessions,
  --     special_needs, track_interests.
  -- Text[]-typed application columns (interests, track_interests) are the
  -- only ones that take the array form directly.
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
  -- Lock this import row for the duration of the transaction. Two concurrent
  -- callers that somehow both reach the same row (stale lock token, retried
  -- chunk) serialize here, and the second one sees action_taken already set.
  select * into v_row from import_rows
  where id = p_import_row_id and import_batch_id = p_import_batch_id
  for update;

  if v_row.id is null then
    raise exception 'Import row % not found in batch %', p_import_row_id, p_import_batch_id;
  end if;

  -- Already applied by an earlier (or concurrent, now-serialized) call.
  -- Returning a distinct sentinel rather than raising lets the caller treat a
  -- retry as a clean no-op instead of failing an entire chunk.
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

  -- A within-file duplicate must not be applied twice: the FIRST occurrence
  -- of the email carries duplicate_status null and is imported normally; this
  -- later occurrence is skipped. Without this branch the second row would
  -- fall through to the insert path and violate
  -- applications_imported_email_unclaimed_unique, failing the whole chunk.
  -- The plan's illustrative code omitted this case entirely — an additional
  -- gap found during implementation, not one of the three flagged ones.
  if v_row.duplicate_status = 'duplicate_in_file' then
    update import_rows set action_taken = 'skipped_unchanged' where id = v_row.id;
    return 'skipped';
  end if;

  v_normalized := coalesce(v_row.normalized_row, '{}'::jsonb);
  v_email := v_normalized->>'email';
  if v_email is null or v_email = '' then
    raise exception 'Import row % has no normalized email but passed validation', v_row.id;
  end if;

  -- GAP #2 RESOLUTION: re-derive the TRUE original cell text for every mapped
  -- column from import_rows.raw_row (the stored original cell array, written
  -- by Task 14) joined against this batch's import_column_mappings, keyed by
  -- target_key. This is the real pre-normalization value the admin typed,
  -- NOT the normalized value the plan's draft incorrectly reused.
  --
  -- Chosen over extending Task 10's RowValidationResult because raw_row +
  -- the mapping are both already persisted and are the authoritative record
  -- of the source cell; deriving here keeps the raw value correct even for
  -- rows validated before this task existed, and avoids a signature change
  -- rippling through Task 14's caller. `->>` on a jsonb array by integer
  -- index yields the element as text (null when absent/JSON null).
  select coalesce(jsonb_object_agg(m.target_key, to_jsonb(v_row.raw_row->>m.source_column_index)), '{}'::jsonb)
  into v_raw_values
  from import_column_mappings m
  where m.import_batch_id = p_import_batch_id
    and m.target_key is not null
    and m.target_kind <> 'ignored';

  if v_row.duplicate_status in ('existing_unclaimed', 'existing_claimed') then
    ------------------------------------------------------------------
    -- UPDATE PATH
    ------------------------------------------------------------------
    v_application_id := v_row.destination_application_id;
    if v_application_id is null then
      raise exception 'Import row % is marked % but has no destination_application_id', v_row.id, v_row.duplicate_status;
    end if;

    -- Lock the target application, then capture the before-image. Both the
    -- snapshot and the overwrite below happen inside this one transaction
    -- with the row held, so no concurrent writer can slip between them —
    -- this is precisely the interleaving the plan's two-await draft allowed.
    perform 1 from applications where id = v_application_id for update;

    select to_jsonb(a.*) into v_previous_application from applications a where a.id = v_application_id;
    if v_previous_application is null then
      raise exception 'Destination application % for import row % no longer exists', v_application_id, v_row.id;
    end if;

    select coalesce(jsonb_agg(to_jsonb(aa.*)), '[]'::jsonb) into v_previous_answers
    from application_answers aa where aa.application_id = v_application_id;

    -- Snapshot is persisted BEFORE the overwrite statements below, in the
    -- same transaction, so Task 16's rollback always has a recoverable
    -- before-image for anything this function changed.
    update import_rows set
      action_taken = 'updated',
      previous_application_snapshot = v_previous_application,
      previous_answers_snapshot = v_previous_answers,
      destination_application_id = v_application_id
    where id = v_row.id;
  else
    ------------------------------------------------------------------
    -- INSERT PATH
    ------------------------------------------------------------------
    v_application_number := next_application_number();

    insert into applications (applicant_id, imported_email, import_batch_id, status, application_number)
    values (null, v_email, p_import_batch_id, 'accepted', v_application_number)
    returning id into v_application_id;

    update import_rows set
      action_taken = 'inserted',
      destination_application_id = v_application_id
    where id = v_row.id;
  end if;

  ------------------------------------------------------------------
  -- Apply the mapped column values to `applications` (both paths).
  -- Built as a dynamic UPDATE so only keys actually present in the
  -- normalized row are touched — an absent column must keep its existing
  -- value on the update path rather than being nulled out.
  ------------------------------------------------------------------
  foreach v_key in array v_text_columns loop
    if v_normalized ? v_key then
      v_value := v_normalized->v_key;
      v_is_array := jsonb_typeof(v_value) = 'array';
      -- An array-normalized value (topics_to_learn) collapses to a
      -- comma-separated string for its text column; the structured form
      -- survives in application_answers.
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
          -- A scalar arriving for an array column (mapping produced a plain
          -- string) is wrapped rather than dropped.
          else array[v_value #>> '{}']
        end
      );
    end if;
  end loop;

  -- birth_date is handled separately: it is a `date` column and the
  -- normalized value is free text from a spreadsheet cell. A non-parseable
  -- value must not abort the whole import, so it is cast defensively and
  -- simply left unset (still preserved verbatim in application_answers) when
  -- it cannot be interpreted as a date.
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
          -- Unparseable date: skip the typed column only. This is the one
          -- place an exception block is appropriate and safe — it guards a
          -- single pure cast with no side effects, and swallowing it cannot
          -- hide a partial write.
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

  ------------------------------------------------------------------
  -- application_answers upsert: every key present in the normalized row,
  -- with raw_value sourced from v_raw_values (gap #2).
  ------------------------------------------------------------------
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
      -- raw_value is NOT NULL on this table. The true original cell text is
      -- used whenever the column was mapped; when a normalized key has no
      -- corresponding source column (nothing produces this today, but a
      -- future derived key would), fall back to the normalized rendering so
      -- the NOT NULL constraint can never abort a whole import.
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

  ------------------------------------------------------------------
  -- Status history + audit trail, same transaction.
  ------------------------------------------------------------------
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

  -- Audited inside the transaction rather than via writeAuditLog from JS:
  -- an audit row written outside this transaction could survive a rolled-back
  -- apply (claiming a write that never happened) or be lost after a committed
  -- one. Column set matches writeAuditLog's own insert in
  -- src/lib/agenda/server-helpers.ts.
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
