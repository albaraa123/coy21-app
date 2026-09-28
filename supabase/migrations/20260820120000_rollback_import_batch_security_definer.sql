-- 20260820120000_rollback_import_batch_security_definer.sql
--
-- Fixes "permission denied for table applications" when rolling back an
-- import batch through the real UI path (rollback-action.ts calls this RPC
-- via a service-role client, per requireImportStaffCaller). Root cause,
-- confirmed by direct inspection (not assumed):
--
--   1. `applications` has no DELETE grant for `authenticated` OR
--      `service_role` (20260816000000_canonical_authenticated_and_
--      service_role_grants.sql's own comment states DELETE is granted
--      "ONLY where a real, traced code path performs one" at the
--      table-grant level, and explicitly defers every RPC-body DELETE to
--      SECURITY DEFINER instead -- e.g. session_tags).
--   2. There is no staff DELETE policy on `applications` (only
--      applications_delete_own_draft, scoped to a participant's own draft).
--   3. service_role bypasses RLS (rolbypassrls = true) but table-level
--      GRANTs are a SEPARATE mechanism RLS bypass does not cover --
--      confirmed live: service_role has SELECT/INSERT/UPDATE but no
--      DELETE grant on applications, same gap as authenticated.
--
-- So `delete from applications ...` inside rollback_import_batch_
-- transactional (SECURITY INVOKER today) fails for every possible caller,
-- matching the canonical grants migration's own stated design: this
-- function should have been SECURITY DEFINER from the start, like
-- claim_imported_application_transactional (20260726110000) and 17 other
-- functions in this codebase, so its DELETE runs as the function owner
-- (postgres) and needs no table-level grant at all.
--
-- Fixing this by ADDING a table-level DELETE grant instead was explicitly
-- rejected (would open unrestricted staff/service delete access on
-- `applications`, contradicting the canonical grants migration's own
-- "DELETE only where a traced direct-DELETE call site exists" discipline).
--
-- Compared line-by-line against claim_imported_application_transactional's
-- three security properties, per explicit review requirement:
--
--   1. search_path: claim_imported_application_transactional uses
--      `set search_path = public, pg_temp` (20260726110000, closing line).
--      This function already had `set search_path = public, pg_temp` on
--      every prior revision (unaffected by this change) -- confirmed
--      identical, no gap to close.
--   2. Caller identity/authorization check: claim_imported_application_
--      transactional asserts `p_claiming_user_id = auth.uid()` (an
--      IDENTITY check, appropriate there because it's a participant
--      claiming an application FOR THEMSELVES). This function is
--      different: it's a STAFF operation with no "owning user" concept, so
--      the correct analogous check is a ROLE check, not an identity check
--      -- added below via current_user_role(), matching
--      requireImportStaffCaller's real role set (isAgendaStaffRole OR
--      isParticipantsCommunicationsStaffRole: agenda_allocation_manager,
--      participants_communications_manager, super_admin) exactly, so the
--      DB-level check cannot authorize anyone the TS-level gate would
--      reject.
--   3. Narrow EXECUTE grant: claim_imported_application_transactional does
--      `revoke all ... from public; grant execute ... to authenticated`.
--      Applied identically below, to authenticated (the RPC is invoked via
--      PostgREST using the caller's own session in the general case, per
--      Postgres/PostgREST's execution model even when the *application
--      code* happens to use a service-role client -- narrowing to
--      authenticated, not granting to service_role separately, since
--      service_role already bypasses grant restrictions as the bypassrls
--      superrole-adjacent role and needs no explicit EXECUTE grant to call
--      any function).
--
-- Row-level delete scope (the third explicit review requirement): the
-- DELETE at "delete from applications where id = v_application_id" is
-- reached only via v_application_id := v_row.destination_application_id,
-- where v_row is drawn from
--   `for v_row in select * from import_rows where import_batch_id =
--   p_batch_id and action_taken in ('inserted', 'updated') ... loop`
-- (unchanged by this migration) -- so the DELETE can structurally never
-- touch any row outside p_batch_id's own import_rows. SECURITY DEFINER
-- does not weaken this: the WHERE clause is unconditional regardless of
-- executing role.
--
-- No change to apply_import_row_transactional in this migration -- it
-- performs no DELETE on applications (only UPDATE, which authenticated and
-- service_role already have granted), so it is not affected by this gap.
--
-- Body is otherwise byte-for-byte identical to
-- 20260820110000_add_funding_type_to_import.sql's rollback function,
-- except: (a) `security definer` added to the language clause, (b) a new
-- caller-authorization block inserted immediately after the `begin`.

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
    'institution_or_workplace', 'linkedin_url', 'primary_track', 'secondary_track',
    'funding_type'
  ];
  v_array_columns text[] := array[
    'interests', 'track_interests',
    'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas'
  ];
begin
  ------------------------------------------------------------------
  -- SECURITY DEFINER means RLS provides ZERO protection inside this body,
  -- so this check IS the entire authorization boundary for this function.
  -- Mirrors requireImportStaffCaller's exact role set (src/lib/import/
  -- server-helpers.ts): isAgendaStaffRole OR
  -- isParticipantsCommunicationsStaffRole -- agenda_allocation_manager,
  -- participants_communications_manager, or super_admin. current_user_role()
  -- is the existing security-definer helper (20260721212035_rls_policies.sql)
  -- already used throughout this schema's RLS policies, reused unchanged
  -- here rather than re-implemented.
  ------------------------------------------------------------------
  if current_user_role() not in ('agenda_allocation_manager', 'participants_communications_manager', 'super_admin') then
    raise exception 'Not authorized to roll back an import batch';
  end if;

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
        coalesce(e->>'section', 'application'),
        (e->>'created_at')::timestamptz,
        (e->>'updated_at')::timestamptz
      from jsonb_array_elements(v_answers) as e;

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
$$ language plpgsql security definer set search_path = public, pg_temp;

comment on function rollback_import_batch_transactional(uuid, uuid) is
  'Undoes an entire import batch atomically, or refuses entirely. SECURITY '
  'DEFINER as of 20260820120000 (was invoker; applications has no DELETE '
  'grant for authenticated or service_role, matching the canonical grants '
  'migration''s design that RPC-body deletes run as definer, not via a '
  'table grant) -- the current_user_role() check at the top of this '
  'function is therefore the ENTIRE authorization boundary and must never '
  'be removed or loosened without an equivalent replacement. Restores '
  'application_travel_info/application_health_info on an updated-row '
  'rollback via delete-then-conditionally-reinsert from import_rows.'
  'previous_travel_snapshot/previous_health_snapshot, mirroring '
  'application_answers'' own pattern -- an inserted-row rollback needs no '
  'new logic since both tables cascade-delete from applications(id) for '
  'free. v_restorable_columns/v_array_columns MUST stay in sync with '
  'apply_import_row_transactional''s own arrays -- update both together.';

-- Narrow EXECUTE grant, mirroring claim_imported_application_transactional's
-- own pattern exactly (20260726110000_claim_application_function.sql): the
-- default on a newly (re)created function is EXECUTE to PUBLIC, which for a
-- SECURITY DEFINER function would expose it to `anon` too. anon has no
-- current_user_role() match (not authenticated, current_user_role() reads
-- profiles by auth.uid() which is null), so the check above would reject it
-- anyway -- but revoking first and granting narrowly means that protection
-- does not rest on a single `if` statement.
revoke all on function rollback_import_batch_transactional(uuid, uuid) from public;
grant execute on function rollback_import_batch_transactional(uuid, uuid) to authenticated;

-- authenticated alone is not sufficient: rollback_import_batch_transactional
-- is actually invoked via a SERVICE-ROLE client in the real production path
-- (rollback-action.ts's rollbackImportBatchForCaller receives its caller
-- from requireImportStaffCaller, which returns createServiceRoleClient() --
-- confirmed by direct inspection, unlike claim_imported_application_
-- transactional, whose own doc comment states it is deliberately called
-- with the participant's OWN session, never service-role). `revoke all`
-- above strips service_role's default EXECUTE too, so it needs its own
-- explicit grant here -- discovered live: the authenticated-only grant
-- (mirrored from claim_imported_application_transactional without
-- accounting for this difference) produced "permission denied for
-- function" for the real service-role caller.
grant execute on function rollback_import_batch_transactional(uuid, uuid) to service_role;
