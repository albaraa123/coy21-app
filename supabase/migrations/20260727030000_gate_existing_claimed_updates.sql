-- gate_existing_claimed_updates.sql
--
-- Task 28's final whole-phase spec-compliance review found a real,
-- verified gap between the binding design spec and the shipped code, not a
-- deliberate deviation: the design spec
-- (docs/superpowers/specs/2026-07-25-accepted-participants-import-design.md,
-- "Exact flow: upload -> invitation", step 10, second bullet) requires that
-- a re-import row matching an ALREADY-CLAIMED application (an active
-- participant, not a staging row) be treated as a "review-required
-- update, never silently applied ... requiring the admin to explicitly
-- confirm the update before it's included in the batch's importable set,
-- since overwriting a claimed participant's data is a materially different
-- risk than updating an unclaimed staging row."
--
-- This was never built. `apply_import_row_transactional` has always
-- collapsed `existing_unclaimed` and `existing_claimed` into the identical
-- update branch (`if v_row.duplicate_status in ('existing_unclaimed',
-- 'existing_claimed') then ...`), auto-applying overwrites to active
-- participants with no distinct safeguard. Confirmed by tracing the plan's
-- own illustrative code (docs/superpowers/plans/2026-07-26-...-plan.md) --
-- the collapsed form was drafted there from the start, so no per-task
-- review ever compared it back to the spec's step-10 wording.
--
-- This is worth fixing carefully rather than deferring, because the
-- existing safety net (rollback) is usually UNAVAILABLE for exactly the
-- population this gap affects: rollback_import_batch_transactional blocks
-- on any participant_invitations row whose status has left 'not_sent', and
-- a claimed participant is BY DEFINITION one who was already invited and
-- accepted. So an unreviewed overwrite of a claimed participant's data
-- often cannot be cleanly undone after the fact.
--
-- MECHANISM CHOSEN: a per-row approval flag, set at the batch level (this
-- preview UI has no per-row action infrastructure of any kind yet -- see
-- preview-table.tsx, every control is batch-scoped), defaulting to false.
-- apply_import_row_transactional now classifies an unapproved
-- existing_claimed row as 'blocked' (the same terminal, no-write outcome
-- already used for blocked_downstream), rather than taking the update
-- branch. Approving is a new explicit admin action
-- (approveClaimedUpdatesForCaller in preview/actions.ts) that flips the
-- flag for every existing_claimed row in the batch and is itself audited --
-- matching the spec's rule 6 ("every sensitive administrative action ...
-- is audited") and its own step-10 language ("requiring the admin to
-- explicitly confirm the update").
alter table import_rows add column claimed_update_approved boolean not null default false;

comment on column import_rows.claimed_update_approved is
  'Design-spec-required gate (Task 28 fix): an existing_claimed row is only '
  'applied as an update if this is true. Set only by '
  'approveClaimedUpdatesForCaller (preview/actions.ts), an explicit, '
  'audited admin action distinct from validation/mapping/confirm. Ignored '
  'for every other duplicate_status value -- an existing_unclaimed row '
  'applies regardless of this flag, matching the spec''s distinction that '
  'only ALREADY-CLAIMED (active participant) overwrites need this review '
  'step.';

-- ---------------------------------------------------------------------
-- apply_import_row_transactional, replaced.
--
-- `create or replace function` because every prior revision
-- (20260726108000, 20260726109600, 20260727010000) is already applied live
-- and immutable -- the established pattern for this function. The full
-- body is restated because plpgsql has no partial-replace form; the ONLY
-- change versus 20260727010000 is marked NEW below: the existing_claimed
-- branch now requires claimed_update_approved before taking the update
-- path, refusing (classifying as 'blocked') otherwise. existing_unclaimed
-- is completely unaffected -- it still applies unconditionally, exactly as
-- before, since the spec's distinction is specifically about CLAIMED
-- (active participant) records.
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
  v_existing_fingerprint text;
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

  ------------------------------------------------------------------
  -- NEW: existing_claimed requires explicit prior approval (design spec
  -- step 10's "review-required update"). Checked before any lock is taken
  -- on the destination application and before the normalized-row parsing
  -- below, mirroring blocked_downstream's shape immediately above: nothing
  -- is going to be applied, so nothing further needs to be prepared.
  --
  -- existing_unclaimed is deliberately NOT covered by this check -- the
  -- spec's risk distinction is specifically about an ALREADY-CLAIMED
  -- (active, logged-in) participant's data being silently overwritten.
  -- An unclaimed staging row carries no such risk and continues to apply
  -- unconditionally, exactly as every revision of this function has always
  -- done.
  ------------------------------------------------------------------
  if v_row.duplicate_status = 'existing_claimed' and not v_row.claimed_update_approved then
    update import_rows set action_taken = 'blocked' where id = v_row.id;
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

    select last_import_row_fingerprint into v_existing_fingerprint
    from applications where id = v_application_id;

    if v_existing_fingerprint = v_row.row_fingerprint then
      update import_rows set
        action_taken = 'skipped_unchanged',
        destination_application_id = v_application_id
      where id = v_row.id;

      insert into audit_logs (entity_type, entity_id, action, actor_type, actor_id, metadata)
      values (
        'application',
        v_application_id,
        'import_skip_unchanged',
        'admin',
        p_actor_id,
        jsonb_build_object(
          'batchId', p_import_batch_id,
          'importRowId', v_row.id,
          'excelRowNumber', v_row.excel_row_number,
          'rowFingerprint', v_row.row_fingerprint
        )
      );

      return 'skipped';
    end if;

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

  v_set_clauses := v_set_clauses || format('last_import_row_fingerprint = %L', v_row.row_fingerprint);

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

comment on function apply_import_row_transactional(uuid, uuid, uuid) is
  'Per-row transactional import apply (Task 15, currently on its 4th '
  'revision -- see 20260726108000, 20260726109600, 20260727010000, and this '
  'file, each via create or replace function). Refuses to apply into a '
  'batch whose status is ''rolled_back''. On the existing_unclaimed/'
  'existing_claimed path, compares the row''s row_fingerprint against the '
  'destination application''s last_import_row_fingerprint and classifies an '
  'exact match as ''skipped_unchanged''. NEW in this revision: an '
  'existing_claimed row additionally requires import_rows.'
  'claimed_update_approved = true (set only by an explicit, audited admin '
  'action, approveClaimedUpdatesForCaller in preview/actions.ts) or it is '
  'classified ''blocked'' rather than applied -- the design spec''s '
  '"review-required update" requirement for overwriting an already-claimed, '
  'active participant''s data. existing_unclaimed is unaffected by this '
  'check and continues to apply unconditionally. The is_sensitive key list '
  'inlined in this function''s application_answers insert must be kept in '
  'sync with SENSITIVE_QUESTION_KEYS in src/lib/validation/import.ts and '
  'the fixture in tests/rls/import.test.ts.';
