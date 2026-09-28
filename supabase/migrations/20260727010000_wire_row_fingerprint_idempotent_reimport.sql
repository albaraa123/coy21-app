-- wire_row_fingerprint_idempotent_reimport.sql
--
-- Task 25. Wires import_rows.row_fingerprint into the confirm-import apply
-- path, closing a real gap between the binding design spec and the
-- implementation.
--
-- THE GAP. The design spec
-- (docs/superpowers/specs/2026-07-25-accepted-participants-import-design.md,
-- "Idempotency and concurrency rules") requires:
--
--   "Same row content across different uploads: row_fingerprint (hash of
--    normalized row) lets the confirm-import step classify a row as
--    skipped_unchanged even across different import_batches — re-importing
--    the same person with identical answers does not create a duplicate
--    application_answers history or a spurious application_status_history
--    entry."
--
-- This was never wired up. Task 8's computeRowFingerprint computes the hash
-- and Task 14's validation step stores it on import_rows, but nothing in the
-- codebase ever READ it back — it was write-only data behind an unused index
-- (import_rows_fingerprint_idx). Consequently EVERY re-import of an unchanged
-- person went through the full update path unconditionally: a before-image
-- snapshot capture, an overwrite of applications columns with byte-identical
-- values, a delete+reinsert of application_answers, and a fresh
-- application_status_history + audit_logs entry — every single time, for no
-- data change. That is precisely the "spurious application_status_history
-- entry" the spec forbids.
--
-- ---------------------------------------------------------------------
-- MECHANISM CHOSEN: a new applications.last_import_row_fingerprint column.
--
-- The question this fix has to answer at apply time is "what was the
-- fingerprint of the content most recently applied to THIS destination
-- application?". Two mechanisms were considered.
--
-- REJECTED — deriving it by querying the most recent prior import_rows row
-- targeting this application. This is not merely awkward, it is
-- unimplementable correctly against the current schema: import_rows has NO
-- timestamp column whatsoever (verified column-by-column against
-- 20260726102000_import_staging_tables.sql — there is no created_at/
-- updated_at, unlike import_batches which has uploaded_at). The only
-- candidate ordering columns are excel_row_number, which is scoped to a
-- single batch and carries no cross-batch meaning, and id, which is a random
-- gen_random_uuid() and is not monotonic. Ordering by either across
-- different import_batches would pick an ARBITRARY prior row, not the most
-- recent one — so a re-import could compare against a stale fingerprint from
-- two batches ago and skip a row that genuinely changed, silently dropping
-- the admin's update. Joining out to import_batches.uploaded_at would order
-- by UPLOAD time, which is not APPLY time (batches can be validated, left
-- sitting, and confirmed out of upload order), so it has the same defect in
-- a less obvious form. Shipping any of these would mean comparing against
-- the wrong "previous" state — the exact failure mode this task warns off.
--
-- CHOSEN — store the fingerprint of the content actually applied, on the
-- application it was applied to. It is O(1) at apply time (already-locked
-- row, no extra query, no new index needed), and it is semantically exact:
-- it records what this application's import-managed content IS, rather than
-- inferring it from staging-table archaeology. The "keeping a new column in
-- sync" cost is genuinely small because there are exactly two writers in the
-- whole system, both in this file: the apply function sets it, and the
-- rollback function clears it.
--
-- THE ROLLBACK INTERACTION IS LOAD-BEARING, NOT AN AFTERTHOUGHT. Rollback
-- restores an application to its pre-import tuple. If
-- last_import_row_fingerprint survived that restore, the application's
-- CONTENT would be the old content while its recorded fingerprint claimed
-- the new content — so re-importing the very file the admin just rolled back
-- would be classified skipped_unchanged and silently do nothing, leaving the
-- admin unable to re-apply a batch they had just undone. Rollback therefore
-- clears the column on the update path and it dies with the row on the
-- insert path (hard delete). This restores the true invariant:
-- last_import_row_fingerprint is non-null if and only if the application's
-- current import-managed content was written by an import that has not been
-- rolled back.
-- ---------------------------------------------------------------------

alter table applications add column last_import_row_fingerprint text;

comment on column applications.last_import_row_fingerprint is
  'sha256 of the normalized import row most recently APPLIED to this '
  'application by apply_import_row_transactional, matching '
  'import_rows.row_fingerprint (computed by computeRowFingerprint in '
  'src/lib/import/normalization.ts). Read only by '
  'apply_import_row_transactional, to classify an unchanged re-import as '
  '''skipped_unchanged'' per the design spec''s idempotency rules. Written '
  'by exactly two functions: set by apply_import_row_transactional, cleared '
  'by rollback_import_batch_transactional (a restored application''s content '
  'is once again pre-import, so its recorded fingerprint must not claim '
  'otherwise — leaving it set would make re-importing a just-rolled-back '
  'batch a silent no-op). NULL means no un-rolled-back import has written '
  'this application.';

-- ---------------------------------------------------------------------
-- apply_import_row_transactional, replaced.
--
-- `create or replace function` because the original (20260726108000) and its
-- first follow-up (20260726109600) are both already applied live and
-- immutable — the same pattern 20260726109600 established for exactly this
-- function. The full body is restated because plpgsql has no partial-replace
-- form; the ONLY changes versus 20260726109600 are marked NEW below.
--
-- Scope of the change, precisely: a fingerprint short-circuit at the top of
-- the existing_unclaimed/existing_claimed branch, and a write of
-- last_import_row_fingerprint on both apply paths. The INSERT path's
-- classification logic is untouched — a brand-new application has no prior
-- fingerprint by definition, so the comparison is unreachable there by
-- construction, not by an added guard.
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
  -- NEW: the fingerprint currently recorded on the destination application.
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

    ------------------------------------------------------------------
    -- NEW: unchanged-content short-circuit (design spec, "Same row content
    -- across different uploads").
    --
    -- Read under the FOR UPDATE lock taken immediately above, so the
    -- comparison cannot race a concurrent apply to the same application:
    -- two batches importing the same person serialize here, and the second
    -- one sees the first one's committed fingerprint.
    --
    -- Ordering matters. This runs BEFORE the before-image snapshot capture,
    -- deliberately: on this path nothing is going to change, so there is
    -- nothing to snapshot, and writing a snapshot would be actively wrong —
    -- it would make the row look restorable to Task 16's rollback when
    -- there is nothing to restore.
    --
    -- Null-safe by intent, and `is distinct from` is NOT wanted here: a
    -- NULL v_existing_fingerprint means no un-rolled-back import has ever
    -- written this application (a pre-existing self-registered application,
    -- or one whose import was rolled back), and that MUST fall through to
    -- the normal update path. Plain `=` yields NULL for that case, which is
    -- not true, so the branch is correctly not taken.
    ------------------------------------------------------------------
    select last_import_row_fingerprint into v_existing_fingerprint
    from applications where id = v_application_id;

    if v_existing_fingerprint = v_row.row_fingerprint then
      -- Identical normalized content was already applied to this exact
      -- application by a prior import. Touch no participant data at all: no
      -- snapshot, no applications write, no application_answers
      -- delete/reinsert, no application_status_history row.
      update import_rows set
        action_taken = 'skipped_unchanged',
        destination_application_id = v_application_id
      where id = v_row.id;

      -- A no-op outcome is still a processed row, and this plan's rule is
      -- that every sensitive admin action is audited — including one that
      -- deliberately changed nothing. Without this there would be no trace
      -- distinguishing "this row was evaluated and correctly skipped" from
      -- "this row was never reached". Written inside the same transaction
      -- as the action_taken stamp, for the same reason the other audit
      -- writes in this function are: an audit row outside it could survive
      -- a rolled-back call or be lost after a committed one.
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

    -- Fingerprints differ (content genuinely changed), or there is no prior
    -- applied fingerprint. Proceed with the pre-existing update path,
    -- unchanged.
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

  -- NEW: record the fingerprint of the content being applied, so a later
  -- import of identical content can take the short-circuit above. Appended
  -- to the same dynamic UPDATE the mapped columns already use rather than
  -- issued as a separate statement — one write, and it is impossible for
  -- the recorded fingerprint to land without the content it describes.
  --
  -- Appended UNCONDITIONALLY, outside the `? v_key` presence tests above:
  -- v_set_clauses can legitimately be empty (a row whose normalized keys
  -- map to no applications column at all, e.g. full_name only), and the
  -- fingerprint must still be recorded in that case, because the
  -- application_answers write below is a real content change even when no
  -- applications column moves. This also guarantees array_length(...) > 0
  -- below is now always true, so the mapped-column UPDATE is no longer
  -- conditionally skipped; the guard is retained anyway as it costs nothing
  -- and keeps the statement's shape honest if the list ever changes again.
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

-- ---------------------------------------------------------------------
-- rollback_import_batch_transactional, replaced.
--
-- Two points, one verified and one changed.
--
-- VERIFIED, NOT CHANGED: the restoration loop's
-- `action_taken in ('inserted', 'updated')` filter already excludes rows
-- reaching 'skipped_unchanged' via the new path above, by construction —
-- 'skipped_unchanged' has never been in that IN-list. This is correct and
-- required: a skipped_unchanged row wrote no participant data and captured
-- no snapshot, so there is nothing to restore and any restoration action on
-- it would be a fabrication. The same filter in the v_scope_application_ids
-- union is also correct to leave alone: a skipped row's destination
-- application is not in the rollback's blast radius via THIS batch (if the
-- batch also inserted it, it is already in scope via
-- applications.import_batch_id; if a PRIOR batch wrote it, undoing that is
-- that batch's rollback to perform, not this one's). Note the loop's
-- trailing `update import_rows set action_taken = null` is likewise scoped
-- to the loop, so a skipped_unchanged stamp is correctly left in place as
-- the audit trail of a row that was evaluated and skipped — consistent with
-- review finding A8's reasoning about skipped_error/blocked stamps.
--
-- CHANGED: the update path now clears last_import_row_fingerprint. See the
-- rollback-interaction note at the top of this file — without this, a
-- restored application would keep a fingerprint describing content it no
-- longer has, and re-importing the just-rolled-back batch would be
-- classified skipped_unchanged and silently do nothing. The insert path
-- needs no change: it hard-deletes the application, taking the column with
-- it. Cleared via the existing dynamic UPDATE by adding the column to
-- v_restorable_columns, which is exactly right for it — the snapshot is
-- to_jsonb(applications.*) taken BEFORE the import wrote the fingerprint,
-- so `%L` of v_snapshot->>'last_import_row_fingerprint' restores the true
-- prior value: NULL for a first-ever import, or the PRECEDING import's
-- fingerprint when several batches have touched the row in sequence. That
-- is strictly more correct than unconditionally nulling it, which would
-- lose the earlier batch's still-valid record.
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
  -- last_import_row_fingerprint added (Task 25): restored from the
  -- before-image like every other import-writable column, which correctly
  -- yields NULL for a first-ever import and the preceding batch's
  -- fingerprint when imports have stacked.
  v_restorable_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs',
    'birth_date', 'last_import_row_fingerprint'
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

  select count(*) into v_blocker_count
  from schedule_publication_draft_items spdi
  where spdi.application_id = any(v_scope_application_ids);
  if v_blocker_count > 0 then
    raise exception 'Cannot roll back import batch %: % schedule_publication_draft_items row(s) reference applications from this batch. Discard the schedule draft first.',
      p_batch_id, v_blocker_count;
  end if;

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

        delete from applications where id = v_application_id;
      end if;

    else
      v_snapshot := v_row.previous_application_snapshot;

      if v_application_id is null or v_snapshot is null then
        raise exception 'Cannot roll back import batch %: import row % is marked ''updated'' but has no recoverable snapshot (destination_application_id=%, previous_application_snapshot is null).',
          p_batch_id, v_row.id, v_application_id;
      end if;

      perform 1 from applications where id = v_application_id for update;

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
  'rollback_import_batch_transactional restores that column from the '
  'before-image, so a rolled-back batch can be cleanly re-imported. The '
  'is_sensitive key list inlined in this function''s application_answers '
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
  'action_taken stamp is left in place as an audit trail. '
  'v_restorable_columns MUST stay in sync with '
  'apply_import_row_transactional''s v_text_columns/v_array_columns plus '
  'last_import_row_fingerprint '
  '(20260726108000_apply_import_row_function.sql, '
  '20260727010000_wire_row_fingerprint_idempotent_reimport.sql): this '
  'function can only restore what that function can write. Update both '
  'together.';
