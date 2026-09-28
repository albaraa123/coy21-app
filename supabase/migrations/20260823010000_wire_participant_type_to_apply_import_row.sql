-- 20260823010000_wire_participant_type_to_apply_import_row.sql
--
-- COY21 Phase 1 Task 1 (wire-up): passes participant_type from the import
-- row's normalized data through to:
--   1. next_application_number(p_type) — so the generated code uses the
--      correct COY21-TYPE-NNNN prefix rather than the delegate fallback.
--   2. The applications INSERT — so applications.participant_type is
--      populated at creation time.
--   3. import_rows.participant_type — stored for reference and rollback.
--
-- The previous migration (20260822000000_coy21_attendee_codes.sql) added
-- the participant_type column to both tables and the typed function; this
-- migration wires it into the existing import function body.
--
-- This is a CREATE OR REPLACE of apply_import_row_transactional, carrying
-- forward the full function body from 20260820140000. The only diffs from
-- that version are:
--   a. Declare v_participant_type public.participant_type
--   b. Extract participant_type from v_normalized before the INSERT branch
--   c. Pass v_participant_type to next_application_number()
--   d. Include participant_type in the applications INSERT
--   e. Update import_rows.participant_type = v_participant_type
--   f. Update the function comment

create or replace function apply_import_row_transactional(
  p_import_row_id  uuid,
  p_import_batch_id uuid,
  p_actor_id        uuid
) returns text as $$
declare
  v_batch_status text;
  v_row import_rows%rowtype;
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
  v_participant_type public.participant_type;
  v_text_columns text[] := array[
    'phone', 'country', 'nationality', 'age_group', 'city',
    'organization', 'field_of_work', 'preferred_language', 'experience_level',
    'climate_experience', 'past_initiatives', 'participation_goals',
    'topics_to_learn', 'content_type_pref', 'priority_sessions', 'special_needs',
    'gender', 'whatsapp_number', 'education_level', 'institution_or_workplace',
    'linkedin_url', 'primary_track', 'secondary_track',
    'funding_type',
    'attendance_confirmation'
  ];
  v_array_columns text[] := array[
    'interests', 'track_interests',
    'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas'
  ];
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

  -- Extract participant_type early; used both for code generation and the INSERT.
  -- Cast from text is safe: invalid values resolve to NULL (no exception),
  -- and next_application_number(NULL) falls back to the delegate sequence.
  begin
    v_participant_type := (v_normalized->>'participant_type')::public.participant_type;
  exception when invalid_text_representation then
    v_participant_type := null;
  end;

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

    select to_jsonb(t.*) into v_previous_travel from application_travel_info t where t.application_id = v_application_id;
    select to_jsonb(h.*) into v_previous_health from application_health_info h where h.application_id = v_application_id;

    update import_rows set
      action_taken = 'updated',
      participant_type = v_participant_type,
      previous_application_snapshot = v_previous_application,
      previous_answers_snapshot = v_previous_answers,
      previous_travel_snapshot = v_previous_travel,
      previous_health_snapshot = v_previous_health,
      destination_application_id = v_application_id
    where id = v_row.id;
  else
    v_application_number := next_application_number(v_participant_type);

    insert into applications (applicant_id, imported_email, import_batch_id, status, application_number, participant_type)
    values (null, v_email, p_import_batch_id, 'accepted', v_application_number, v_participant_type)
    returning id into v_application_id;

    update import_rows set
      action_taken = 'inserted',
      participant_type = v_participant_type,
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

  if v_normalized ? 'full_name' then
    v_full_name := nullif(trim(both from (v_normalized->>'full_name')), '');
    if v_full_name is not null then
      v_set_clauses := v_set_clauses || format('full_name = %L', v_full_name);
    end if;
  end if;

  if v_normalized ? 'birth_date' then
    declare
      v_birth_raw text := v_normalized->>'birth_date';
      v_birth_parsed date;
    begin
      v_birth_parsed := v_birth_raw::date;
      v_set_clauses := v_set_clauses || format('birth_date = %L::date', v_birth_parsed);
    exception when others then
      null;
    end;
  end if;

  -- participant_type on the existing application (update branch)
  if v_participant_type is not null then
    v_set_clauses := v_set_clauses || format('participant_type = %L::public.participant_type', v_participant_type::text);
  end if;

  if array_length(v_set_clauses, 1) > 0 then
    v_update_sql := format(
      'update applications set %s, last_import_row_fingerprint = %L where id = %L',
      array_to_string(v_set_clauses, ', '),
      v_row.row_fingerprint,
      v_application_id
    );
    execute v_update_sql;
  else
    update applications set last_import_row_fingerprint = v_row.row_fingerprint where id = v_application_id;
  end if;

  declare
    v_consent_given boolean;
    v_has_travel boolean := false;
    v_has_health boolean := false;
    v_travel_key text;
    v_health_key text;
  begin
    foreach v_travel_key in array v_travel_columns || v_travel_date_columns loop
      if v_normalized ? v_travel_key and (v_normalized->v_travel_key) is not null and jsonb_typeof(v_normalized->v_travel_key) <> 'null' and (v_normalized->>v_travel_key) <> '' then
        v_has_travel := true;
      end if;
    end loop;

    foreach v_health_key in array v_health_columns || v_health_bool_columns loop
      if v_normalized ? v_health_key and (v_normalized->v_health_key) is not null and jsonb_typeof(v_normalized->v_health_key) <> 'null' and (v_normalized->>v_health_key) <> '' then
        v_has_health := true;
      end if;
    end loop;

    if v_has_travel then
      insert into application_travel_info (
        application_id,
        support_level_requested, can_attend_without_full_support, departure_airport,
        visa_required, invitation_letter_required, passport_full_name,
        passport_full_name_ar, passport_place_of_issue, passport_copy_url, passport_photo_url,
        passport_issue_date, passport_expiry_date, passport_birth_date
      ) values (
        v_application_id,
        nullif(v_normalized->>'support_level_requested', ''),
        case when v_normalized->>'can_attend_without_full_support' = 'true' then true
             when v_normalized->>'can_attend_without_full_support' = 'false' then false
             else null end,
        nullif(v_normalized->>'departure_airport', ''),
        case when v_normalized->>'visa_required' = 'true' then true
             when v_normalized->>'visa_required' = 'false' then false
             else null end,
        case when v_normalized->>'invitation_letter_required' = 'true' then true
             when v_normalized->>'invitation_letter_required' = 'false' then false
             else null end,
        nullif(v_normalized->>'passport_full_name', ''),
        nullif(v_normalized->>'passport_full_name_ar', ''),
        nullif(v_normalized->>'passport_place_of_issue', ''),
        nullif(v_normalized->>'passport_copy_url', ''),
        nullif(v_normalized->>'passport_photo_url', ''),
        case when nullif(v_normalized->>'passport_issue_date', '') is not null
             then (v_normalized->>'passport_issue_date')::date else null end,
        case when nullif(v_normalized->>'passport_expiry_date', '') is not null
             then (v_normalized->>'passport_expiry_date')::date else null end,
        case when nullif(v_normalized->>'passport_birth_date', '') is not null
             then (v_normalized->>'passport_birth_date')::date else null end
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
        passport_copy_url = coalesce(excluded.passport_copy_url, application_travel_info.passport_copy_url),
        passport_photo_url = coalesce(excluded.passport_photo_url, application_travel_info.passport_photo_url),
        passport_issue_date = coalesce(excluded.passport_issue_date, application_travel_info.passport_issue_date),
        passport_expiry_date = coalesce(excluded.passport_expiry_date, application_travel_info.passport_expiry_date),
        passport_birth_date = coalesce(excluded.passport_birth_date, application_travel_info.passport_birth_date),
        updated_at = now();
    end if;

    if v_has_health then
      v_consent_given := case
        when v_normalized->>'consent_given' = 'true' then true
        when v_normalized->>'consent_given' = 'false' then false
        else null
      end;

      insert into application_health_info (
        application_id,
        allergies, medical_conditions, emergency_medication,
        accessibility_requirements, dietary_requirements, accommodation_preference,
        cultural_or_religious_requirements,
        emergency_contact_name, emergency_contact_relationship, emergency_contact_phone,
        consent_given
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
        'primary_track', 'secondary_track', 'full_name', 'nationality', 'city', 'country', 'age_group', 'preferred_language',
        'funding_type', 'attendance_confirmation'
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
      case
        when jsonb_typeof(v_value) = 'boolean' then 'boolean'
        when jsonb_typeof(v_value) = 'number' then 'number'
        when jsonb_typeof(v_value) = 'array' then 'array'
        else 'text'
      end,
      'import',
      v_key in (
        'passport_copy_url', 'passport_photo_url',
        'allergies', 'medical_conditions', 'emergency_medication',
        'accessibility_requirements', 'emergency_contact_name',
        'emergency_contact_relationship', 'emergency_contact_phone'
      ),
      p_import_batch_id,
      v_section
    )
    on conflict (application_id, question_key) do update set
      normalized_value = excluded.normalized_value,
      raw_value = coalesce(excluded.raw_value, application_answers.raw_value),
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
  'Per-row transactional import apply. COY21 extension: extracts participant_type '
  'from normalized_row and passes it to next_application_number(p_type) so the '
  'generated attendee code uses the correct COY21-TYPE-NNNN prefix. Stores '
  'participant_type on both applications (INSERT branch) and import_rows. '
  'Invalid or missing participant_type values fall back to the delegate sequence. '
  'Carries forward: attendance_confirmation, funding_type, full_name, structured '
  'allocation array columns, and conditional travel/health upserts from 20260820140000.';
