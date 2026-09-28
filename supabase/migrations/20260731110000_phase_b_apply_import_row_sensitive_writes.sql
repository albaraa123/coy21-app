-- phase_b_apply_import_row_sensitive_writes.sql
--
-- Phase B (design doc section 13.6): extends apply_import_row_transactional
-- to write applications.full_name (never overwriting an existing non-blank
-- value with a blank import), the four new structured allocation array
-- columns, and conditional upserts into application_travel_info /
-- application_health_info. Also extends rollback_import_batch_transactional
-- to restore all of the above on an updated-row rollback, per the two
-- functions' documented "must stay in sync" invariant
-- (20260726109600_rollback_safety_fixes.sql's trailing comment).
--
-- `create or replace function` because every prior revision is already
-- applied live and immutable -- the established pattern for both functions.
-- The full body of each is restated because plpgsql has no partial-replace
-- form.

------------------------------------------------------------------
-- import_rows gains two more before-image snapshot columns, mirroring
-- previous_application_snapshot/previous_answers_snapshot exactly (same
-- nullable jsonb shape, same "only ever set on the update path, cleared by
-- rollback" lifecycle) -- needed so an updated-row rollback can restore
-- application_travel_info/application_health_info the same way it already
-- restores application_answers.
------------------------------------------------------------------
alter table import_rows add column previous_travel_snapshot jsonb;
alter table import_rows add column previous_health_snapshot jsonb;
--
-- Transactional behavior (design doc section 13.6, decision recorded here):
-- a single participant row's sensitive-data write failure rolls back that
-- row's ENTIRE apply (application + answers + travel + health) and the row
-- is stamped skipped_error by the caller (confirm/actions.ts's existing
-- per-row catch, unchanged) -- never a silent partial import. This falls
-- out of the existing invariant that this function has no swallowing
-- `exception when others` block and runs as one Postgres transaction per
-- row: the new travel/health upserts below are simply more statements
-- inside that same existing transaction, so any error they raise aborts
-- everything else in the same per-row apply exactly like any other
-- statement in this function already does.

------------------------------------------------------------------
-- apply_import_row_transactional
------------------------------------------------------------------
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
  v_previous_travel jsonb;
  v_previous_health jsonb;
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
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs',
    -- Phase B: profile columns approved for direct applications writes.
    -- full_name is handled separately below (never-overwrite-with-blank
    -- rule), not through this generic array.
    'gender', 'whatsapp_number', 'education_level', 'institution_or_workplace',
    'linkedin_url', 'primary_track', 'secondary_track'
  ];
  v_array_columns text[] := array[
    'interests', 'track_interests',
    -- Phase B: structured allocation columns (design doc section 13.2/13.4,
    -- approved decision #2) -- normalized text[] arrays, read directly by
    -- feature extraction, never derived from application_answers.
    'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas'
  ];
  -- Phase B: target_key -> application_travel_info column. Kept in this
  -- function (not a lookup table) for the same reason v_text_columns/
  -- v_array_columns already are: this function's own arrays are the runtime
  -- authority (defense in depth alongside the TS-side manifest in
  -- src/lib/import/known-application-columns.ts, which rejects an invalid
  -- mapping earlier, at confirmMapping time).
  v_travel_columns text[] := array[
    'support_level_requested', 'can_attend_without_full_support', 'departure_airport',
    'visa_required', 'invitation_letter_required', 'passport_full_name',
    'passport_full_name_ar', 'passport_place_of_issue', 'passport_copy_url', 'passport_photo_url'
  ];
  v_travel_date_columns text[] := array['passport_issue_date', 'passport_expiry_date', 'passport_birth_date'];
  v_health_columns text[] := array[
    'allergies', 'medical_conditions', 'emergency_medication', 'accessibility_requirements',
    'dietary_requirements', 'accommodation_preference', 'cultural_or_religious_requirements',
    'emergency_contact_name', 'emergency_contact_relationship', 'emergency_contact_phone'
  ];
  v_health_bool_columns text[] := array['consent_given'];
  v_full_name text;
  v_update_sql text;
  v_set_clauses text[] := array[]::text[];
  -- Phase B (design doc section 13.7): which section an application_answers
  -- row is tagged with. Determined once per key from which of the new
  -- travel/health arrays (or neither) it belongs to -- every key still
  -- lands in application_answers regardless of section, preserving the
  -- original imported value exactly as before.
  v_section text;
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

    -- Phase B: snapshot the existing travel/health rows too (each is at
    -- most one row, 1:1 on application_id), so an updated-row rollback can
    -- restore them exactly like application_answers below.
    select to_jsonb(t.*) into v_previous_travel from application_travel_info t where t.application_id = v_application_id;
    select to_jsonb(h.*) into v_previous_health from application_health_info h where h.application_id = v_application_id;

    update import_rows set
      action_taken = 'updated',
      previous_application_snapshot = v_previous_application,
      previous_answers_snapshot = v_previous_answers,
      previous_travel_snapshot = v_previous_travel,
      previous_health_snapshot = v_previous_health,
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

  ------------------------------------------------------------------
  -- Phase B: applications.full_name -- never overwrite an existing
  -- non-blank value with a blank imported one (approved decision #1). A
  -- non-blank imported name always overwrites (matching every other
  -- re-importable column's existing behavior); a blank/absent imported name
  -- leaves whatever full_name the application already has untouched.
  ------------------------------------------------------------------
  if v_normalized ? 'full_name' then
    v_full_name := nullif(trim(both from (v_normalized->>'full_name')), '');
    if v_full_name is not null then
      v_set_clauses := v_set_clauses || format('full_name = %L', v_full_name);
    end if;
  end if;

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

  ------------------------------------------------------------------
  -- Phase B: application_travel_info -- conditional upsert. Only executed
  -- if at least one mapped travel target_key has a non-blank value in this
  -- row (design doc section 13.6: "avoid creating empty sensitive rows when
  -- all related fields are blank"). Text/boolean columns via
  -- v_travel_columns; the three passport dates handled separately since an
  -- unparseable date must not abort the row (matches birth_date's existing
  -- swallow-and-skip-that-one-field pattern) but IS still flagged upstream
  -- as a row-validation warning (see row-validation.ts's isPlausibleDate) --
  -- the SQL layer's job here is only to not crash on a bad date string, not
  -- to be the sole place that catches it.
  ------------------------------------------------------------------
  -- Built with real bind-style placeholders via a single parameterized
  -- INSERT ... ON CONFLICT, not dynamic-SQL column assembly: every
  -- application_travel_info column is always present in the statement (as
  -- NULL where this row has no value for it), and ON CONFLICT DO UPDATE SET
  -- col = COALESCE(EXCLUDED.col, application_travel_info.col) means an
  -- absent/blank field in THIS import never clobbers a value a previous
  -- import (or manual edit) already set for that same participant -- while
  -- a present, non-blank field always overwrites, matching every other
  -- re-importable column's existing behavior. has_travel_data guards
  -- against creating an empty row when nothing in this section was mapped
  -- at all.
  declare
    v_has_travel_data boolean := false;
    v_passport_issue_date date;
    v_passport_expiry_date date;
    v_passport_birth_date date;
  begin
    foreach v_key in array v_travel_columns || v_travel_date_columns loop
      if v_normalized ? v_key and v_normalized->>v_key is not null and v_normalized->>v_key <> '' then
        v_has_travel_data := true;
      end if;
    end loop;

    if v_has_travel_data then
      begin v_passport_issue_date := nullif(v_normalized->>'passport_issue_date', '')::date; exception when others then v_passport_issue_date := null; end;
      begin v_passport_expiry_date := nullif(v_normalized->>'passport_expiry_date', '')::date; exception when others then v_passport_expiry_date := null; end;
      begin v_passport_birth_date := nullif(v_normalized->>'passport_birth_date', '')::date; exception when others then v_passport_birth_date := null; end;

      insert into application_travel_info (
        application_id, support_level_requested, can_attend_without_full_support,
        departure_airport, visa_required, invitation_letter_required,
        passport_full_name, passport_full_name_ar, passport_place_of_issue,
        passport_issue_date, passport_expiry_date, passport_birth_date,
        passport_copy_url, passport_photo_url
      ) values (
        v_application_id,
        nullif(v_normalized->>'support_level_requested', ''),
        nullif(v_normalized->>'can_attend_without_full_support', '')::boolean,
        nullif(v_normalized->>'departure_airport', ''),
        nullif(v_normalized->>'visa_required', '')::boolean,
        nullif(v_normalized->>'invitation_letter_required', '')::boolean,
        nullif(v_normalized->>'passport_full_name', ''),
        nullif(v_normalized->>'passport_full_name_ar', ''),
        nullif(v_normalized->>'passport_place_of_issue', ''),
        v_passport_issue_date,
        v_passport_expiry_date,
        v_passport_birth_date,
        nullif(v_normalized->>'passport_copy_url', ''),
        nullif(v_normalized->>'passport_photo_url', '')
      )
      on conflict (application_id) do update set
        support_level_requested = coalesce(excluded.support_level_requested, application_travel_info.support_level_requested),
        can_attend_without_full_support = coalesce(excluded.can_attend_without_full_support, application_travel_info.can_attend_without_full_support),
        departure_airport = coalesce(excluded.departure_airport, application_travel_info.departure_airport),
        visa_required = coalesce(excluded.visa_required, application_travel_info.visa_required),
        invitation_letter_required = coalesce(excluded.invitation_letter_required, application_travel_info.invitation_letter_required),
        passport_full_name = coalesce(excluded.passport_full_name, application_travel_info.passport_full_name),
        passport_full_name_ar = coalesce(excluded.passport_full_name_ar, application_travel_info.passport_full_name_ar),
        passport_place_of_issue = coalesce(excluded.passport_place_of_issue, application_travel_info.passport_place_of_issue),
        passport_issue_date = coalesce(excluded.passport_issue_date, application_travel_info.passport_issue_date),
        passport_expiry_date = coalesce(excluded.passport_expiry_date, application_travel_info.passport_expiry_date),
        passport_birth_date = coalesce(excluded.passport_birth_date, application_travel_info.passport_birth_date),
        passport_copy_url = coalesce(excluded.passport_copy_url, application_travel_info.passport_copy_url),
        passport_photo_url = coalesce(excluded.passport_photo_url, application_travel_info.passport_photo_url),
        updated_at = now();
    end if;
  end;

  ------------------------------------------------------------------
  -- Phase B: application_health_info -- same real-INSERT-ON-CONFLICT shape
  -- as application_travel_info above (see that block's comment for the full
  -- rationale). consent_given is boolean, cast defensively via nullif so a
  -- malformed value never aborts the whole row.
  ------------------------------------------------------------------
  declare
    v_has_health_data boolean := false;
    v_consent_given boolean;
  begin
    foreach v_key in array v_health_columns || v_health_bool_columns loop
      if v_normalized ? v_key and v_normalized->>v_key is not null and v_normalized->>v_key <> '' then
        v_has_health_data := true;
      end if;
    end loop;

    if v_has_health_data then
      begin v_consent_given := nullif(v_normalized->>'consent_given', '')::boolean; exception when others then v_consent_given := null; end;

      insert into application_health_info (
        application_id, allergies, medical_conditions, emergency_medication,
        accessibility_requirements, dietary_requirements, accommodation_preference,
        cultural_or_religious_requirements, emergency_contact_name,
        emergency_contact_relationship, emergency_contact_phone, consent_given
      ) values (
        v_application_id,
        nullif(v_normalized->>'allergies', ''),
        nullif(v_normalized->>'medical_conditions', ''),
        nullif(v_normalized->>'emergency_medication', ''),
        nullif(v_normalized->>'accessibility_requirements', ''),
        nullif(v_normalized->>'dietary_requirements', ''),
        nullif(v_normalized->>'accommodation_preference', ''),
        nullif(v_normalized->>'cultural_or_religious_requirements', ''),
        nullif(v_normalized->>'emergency_contact_name', ''),
        nullif(v_normalized->>'emergency_contact_relationship', ''),
        nullif(v_normalized->>'emergency_contact_phone', ''),
        v_consent_given
      )
      on conflict (application_id) do update set
        allergies = coalesce(excluded.allergies, application_health_info.allergies),
        medical_conditions = coalesce(excluded.medical_conditions, application_health_info.medical_conditions),
        emergency_medication = coalesce(excluded.emergency_medication, application_health_info.emergency_medication),
        accessibility_requirements = coalesce(excluded.accessibility_requirements, application_health_info.accessibility_requirements),
        dietary_requirements = coalesce(excluded.dietary_requirements, application_health_info.dietary_requirements),
        accommodation_preference = coalesce(excluded.accommodation_preference, application_health_info.accommodation_preference),
        cultural_or_religious_requirements = coalesce(excluded.cultural_or_religious_requirements, application_health_info.cultural_or_religious_requirements),
        emergency_contact_name = coalesce(excluded.emergency_contact_name, application_health_info.emergency_contact_name),
        emergency_contact_relationship = coalesce(excluded.emergency_contact_relationship, application_health_info.emergency_contact_relationship),
        emergency_contact_phone = coalesce(excluded.emergency_contact_phone, application_health_info.emergency_contact_phone),
        consent_given = coalesce(excluded.consent_given, application_health_info.consent_given),
        updated_at = now();
    end if;
  end;

  ------------------------------------------------------------------
  -- application_answers: every normalized key, regardless of section,
  -- exactly as before (design doc section 13.7: original imported answers
  -- are preserved even for keys that also land on a first-class column or a
  -- travel/health table). Phase B adds `section` tagging so a future admin
  -- view can filter without re-deriving section from question_key.
  ------------------------------------------------------------------
  for v_key, v_value in select * from jsonb_each(v_normalized) loop
    v_section := case
      when v_key = any(v_travel_columns) or v_key = any(v_travel_date_columns) then 'travel'
      when v_key = any(v_health_columns) or v_key = any(v_health_bool_columns) then 'health'
      when v_key in (
        'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas',
        'language_ability', 'organization', 'organization_role', 'experience_level', 'interests',
        'topics_to_learn', 'volunteer_experience_years', 'previous_conference_participation',
        'initiative_or_organization_name', 'expected_contribution', 'expected_skills_experiences'
      ) then 'allocation'
      when v_key in (
        'gender', 'whatsapp_number', 'education_level', 'institution_or_workplace', 'linkedin_url',
        'primary_track', 'secondary_track', 'full_name', 'nationality', 'city', 'country', 'age_group', 'preferred_language'
      ) then 'profile'
      else 'application'
    end;

    insert into application_answers (
      application_id, question_key, normalized_value, raw_value, value_type,
      source, is_sensitive, import_batch_id, section
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
        'emergency_contact_name', 'emergency_contact_relationship', 'emergency_contact_phone',
        'special_needs', 'allergies', 'medical_conditions', 'emergency_medication',
        'accommodation_preference', 'cultural_or_religious_requirements', 'consent_given'
      ),
      p_import_batch_id,
      v_section
    )
    on conflict (application_id, question_key, source) do update set
      normalized_value = excluded.normalized_value,
      raw_value = excluded.raw_value,
      value_type = excluded.value_type,
      is_sensitive = excluded.is_sensitive,
      import_batch_id = excluded.import_batch_id,
      section = excluded.section;
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
  'Per-row transactional import apply. Phase B (design doc section 13) adds: '
  'applications.full_name (never overwrites an existing non-blank value with '
  'a blank import), 4 new structured allocation array columns '
  '(session_languages, track_1/2/3_focus_areas), and conditional upserts '
  'into application_travel_info/application_health_info (only when at least '
  'one mapped field for that section is non-blank). v_travel_columns/'
  'v_health_columns MUST stay in sync with '
  'src/lib/import/known-application-columns.ts (the TS-side manifest '
  'confirmMapping validates against) and with rollback_import_batch_'
  'transactional''s own restore arrays -- update all three together. The '
  'is_sensitive key list is sourced from SENSITIVE_QUESTION_KEYS in '
  'src/lib/validation/import.ts -- keep both in sync.';

------------------------------------------------------------------
-- rollback_import_batch_transactional -- extended per the two functions'
-- documented "must stay in sync" invariant. Only the updated-row branch
-- needs new logic: an inserted row's application_travel_info/
-- application_health_info rows already cascade-delete for free (both
-- tables are `on delete cascade` from applications(id),
-- 20260730110000_application_travel_and_health_info_tables.sql), so the
-- existing `delete from applications where id = v_application_id` on the
-- inserted-row branch already fully undoes them with zero new code.
------------------------------------------------------------------
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
    'birth_date',
    -- Phase B
    'full_name', 'gender', 'whatsapp_number', 'education_level',
    'institution_or_workplace', 'linkedin_url', 'primary_track', 'secondary_track'
  ];
  v_array_columns text[] := array[
    'interests', 'track_interests',
    'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas'
  ];
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

        -- Phase B: application_travel_info/application_health_info rows for
        -- this application are cascade-deleted automatically by this same
        -- delete (both tables are `on delete cascade` from
        -- applications(id)) -- no new statement needed here.
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
        section, created_at, updated_at
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
        -- Phase B: section was added after some pre-existing snapshots may
        -- have been captured without it; coalesce to the column default so
        -- a snapshot taken before this migration still restores cleanly.
        coalesce(e->>'section', 'application'),
        (e->>'created_at')::timestamptz,
        (e->>'updated_at')::timestamptz
      from jsonb_array_elements(v_answers) as e;

      -- Phase B: restore application_travel_info/application_health_info to
      -- their pre-update state. Each is delete-then-conditionally-reinsert
      -- (mirroring application_answers' own delete-and-reinsert pattern
      -- immediately above) rather than an UPDATE, since the row may not
      -- have existed at all before this apply (e.g. the first import that
      -- added travel data to a previously travel-less application) --
      -- deleting and only reinserting if a real snapshot exists correctly
      -- restores that "no row" state too.
      delete from application_travel_info where application_id = v_application_id;
      if v_row.previous_travel_snapshot is not null then
        insert into application_travel_info (
          application_id, support_level_requested, can_attend_without_full_support,
          departure_airport, visa_required, invitation_letter_required,
          passport_full_name, passport_full_name_ar, passport_birth_date,
          passport_place_of_issue, passport_issue_date, passport_expiry_date,
          passport_copy_url, passport_photo_url, created_at, updated_at
        )
        select
          v_application_id,
          e->>'support_level_requested',
          (e->>'can_attend_without_full_support')::boolean,
          e->>'departure_airport',
          (e->>'visa_required')::boolean,
          (e->>'invitation_letter_required')::boolean,
          e->>'passport_full_name',
          e->>'passport_full_name_ar',
          (e->>'passport_birth_date')::date,
          e->>'passport_place_of_issue',
          (e->>'passport_issue_date')::date,
          (e->>'passport_expiry_date')::date,
          e->>'passport_copy_url',
          e->>'passport_photo_url',
          (e->>'created_at')::timestamptz,
          (e->>'updated_at')::timestamptz
        from (select v_row.previous_travel_snapshot as e) s;
      end if;

      delete from application_health_info where application_id = v_application_id;
      if v_row.previous_health_snapshot is not null then
        insert into application_health_info (
          application_id, allergies, medical_conditions, emergency_medication,
          accessibility_requirements, dietary_requirements, accommodation_preference,
          cultural_or_religious_requirements, emergency_contact_name,
          emergency_contact_relationship, emergency_contact_phone, consent_given,
          created_at, updated_at
        )
        select
          v_application_id,
          e->>'allergies',
          e->>'medical_conditions',
          e->>'emergency_medication',
          e->>'accessibility_requirements',
          e->>'dietary_requirements',
          e->>'accommodation_preference',
          e->>'cultural_or_religious_requirements',
          e->>'emergency_contact_name',
          e->>'emergency_contact_relationship',
          e->>'emergency_contact_phone',
          (e->>'consent_given')::boolean,
          (e->>'created_at')::timestamptz,
          (e->>'updated_at')::timestamptz
        from (select v_row.previous_health_snapshot as e) s;
      end if;

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
      previous_answers_snapshot = null,
      previous_travel_snapshot = null,
      previous_health_snapshot = null
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

comment on function rollback_import_batch_transactional(uuid, uuid) is
  'Undoes an entire import batch atomically, or refuses entirely. Phase B '
  'adds restoring application_travel_info/application_health_info on an '
  'updated-row rollback (delete-then-conditionally-reinsert from '
  'import_rows.previous_travel_snapshot/previous_health_snapshot, mirroring '
  'application_answers'' own pattern) -- an inserted-row rollback needs no '
  'new logic since both tables cascade-delete from applications(id) for '
  'free. v_restorable_columns/v_array_columns MUST stay in sync with '
  'apply_import_row_transactional''s own arrays -- update both together.';
