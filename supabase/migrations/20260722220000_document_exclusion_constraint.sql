-- document_exclusion_constraint.sql
--
-- Review follow-up for 20260722210000_sessions_table.sql: that migration
-- introduced the codebase's first GIST exclusion constraint
-- (sessions_room_no_overlap) but explained only the business rule, not the
-- underlying SQL mechanism, and installed btree_gist without a schema
-- qualifier (inconsistent with this project's established convention of
-- schema-qualifying extensions, e.g. moddatetime -> extensions.moddatetime,
-- reinforced by the two search_path-hardening migrations for functions).
-- This migration is metadata/consistency only: it does not change any
-- table shape, data, or constraint behavior.

do $$
begin
  -- btree_gist may already live in `extensions` (if a prior manual step or
  -- `supabase db push` already placed it there); only move it if needed.
  -- ALTER EXTENSION ... SET SCHEMA is the standard, safe way to relocate an
  -- already-installed *relocatable* extension: btree_gist's control file
  -- declares relocatable = true, so Postgres permits it. The move only
  -- updates pg_extension/pg_namespace bookkeeping and renames the member
  -- objects' schema; it does not drop/recreate anything. In particular, the
  -- existing sessions_room_no_overlap exclusion constraint is unaffected:
  -- its underlying GIST index was already built referencing the concrete
  -- operator class/family by OID at CREATE TIME, not by a schema-qualified
  -- name re-resolved on every query, so moving btree_gist's schema afterward
  -- cannot invalidate it. (Verified functionally below via a throwaway
  -- overlap-insert test run inside this same migration, after the move.)
  if exists (
    select 1 from pg_extension
    where extname = 'btree_gist'
      and extnamespace::regnamespace::text <> 'extensions'
  ) then
    alter extension btree_gist set schema extensions;
  end if;
end $$;

-- Document the mechanism directly on the database objects (queryable via
-- `\d+ sessions`, pg_description, or obj_description()), since a plain SQL
-- comment in the original migration file can't be retroactively attached to
-- already-created objects.
comment on extension btree_gist is 'Supplies GIST operator classes (including equality) for scalar types like uuid, required to combine room_id equality with a time-range overlap check in one exclusion constraint (see sessions_room_no_overlap).';

comment on constraint sessions_room_no_overlap on sessions is 'Exclusion constraint: generalizes UNIQUE to use operators besides "=". Rejects any two rows (draft/published/confirmed sessions only) in the same room whose time ranges overlap. Fires on INSERT/UPDATE, raised as Postgres error 23P01 (exclusion_violation). Requires btree_gist for the uuid equality operator class.';

-- Functional smoke test: prove sessions_room_no_overlap still rejects
-- overlapping rows after the possible schema move above. PL/pgSQL has no
-- explicit SAVEPOINT/ROLLBACK TO SAVEPOINT (it errors with "unsupported
-- transaction command in PL/pgSQL") — instead, a BEGIN...EXCEPTION...END
-- block is itself an implicit savepoint. So the whole test runs inside one
-- such block and deliberately raises a sentinel exception at the end,
-- caught by the outer block, to discard every throwaway row it inserted —
-- they never persist, win or lose.
do $$
declare
  v_day_id uuid;
  v_track_id uuid;
  v_type_id uuid;
  v_room_id uuid;
  v_got_23p01 boolean := false;
begin
  begin
    insert into conference_days (conference_date, label_ar, label_en, display_order)
    values ('2099-01-01', 'يوم اختبار', 'Test Day', 999)
    returning id into v_day_id;

    insert into tracks (code, name_ar, name_en)
    values ('__exclusion_test_track__', 'مسار اختبار', 'Test Track')
    returning id into v_track_id;

    insert into session_types (code, name_ar, name_en)
    values ('__exclusion_test_type__', 'نوع اختبار', 'Test Type')
    returning id into v_type_id;

    insert into rooms (code, name_ar, name_en, capacity)
    values ('__exclusion_test_room__', 'قاعة اختبار', 'Test Room', 10)
    returning id into v_room_id;

    insert into sessions (
      session_code, title_ar, title_en, conference_day_id, start_time, end_time,
      track_id, session_type_id, room_id, language, difficulty_level, capacity, status
    ) values (
      '__exclusion_test_session_1__', 'جلسة 1', 'Session 1', v_day_id,
      '2099-01-01 10:00:00+00', '2099-01-01 11:00:00+00',
      v_track_id, v_type_id, v_room_id, 'en', 'all_levels', 10, 'draft'
    );

    begin
      insert into sessions (
        session_code, title_ar, title_en, conference_day_id, start_time, end_time,
        track_id, session_type_id, room_id, language, difficulty_level, capacity, status
      ) values (
        '__exclusion_test_session_2__', 'جلسة 2', 'Session 2', v_day_id,
        '2099-01-01 10:30:00+00', '2099-01-01 11:30:00+00',
        v_track_id, v_type_id, v_room_id, 'en', 'all_levels', 10, 'draft'
      );
    exception
      when exclusion_violation then
        v_got_23p01 := true;
    end;

    -- Sentinel: always raise, to unwind (via the outer exception handler)
    -- everything inserted in this block, regardless of outcome above.
    raise exception using errcode = 'P0001', message = '__discard_overlap_test_rows__';
  exception
    when others then
      if sqlerrm <> '__discard_overlap_test_rows__' then
        raise;
      end if;
  end;

  if not v_got_23p01 then
    raise exception 'sessions_room_no_overlap did not reject an overlapping insert as expected (exclusion_violation/23P01 not raised) — aborting migration';
  end if;

  raise notice 'sessions_room_no_overlap verified: overlapping insert correctly rejected with 23P01 after btree_gist schema check';
end $$;
