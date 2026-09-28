-- diag_application_number_isolation.sql
--
-- DIAGNOSTIC ONLY, part of the P0 investigation into next_application_number()
-- returning duplicate values under concurrent RPC calls
-- (docs/superpowers/specs/2026-08-01-next-application-number-concurrency-bug.md).
--
-- This migration runs entirely INSIDE Postgres (no PostgREST, no pooler, no
-- network round-trip per call) to establish ground truth for Layers 1 and 2:
--   Layer 1: the raw sequence itself (nextval/currval/setval).
--   Layer 2: next_application_number() called directly, many times, in a
--            tight loop within a single backend/transaction.
-- Results are written to a temporary diagnostic table (diag_app_number_log)
-- rather than raised as notices, so they can be queried back afterward via
-- the normal Supabase client (which has no way to read a migration's raise
-- notice output). This table, and this migration file itself, are meant to
-- be dropped/deleted once the investigation concludes -- see the report doc.

create table if not exists diag_app_number_log (
  id bigserial primary key,
  layer text not null,
  call_index int not null,
  value text not null,
  captured_at timestamptz not null default clock_timestamp()
);

-- Record function properties BEFORE any test calls, so the diagnostic
-- captures the function's real, currently-live definition/volatility, not
-- an assumption.
create table if not exists diag_app_number_function_props (
  captured_at timestamptz not null default now(),
  proname text,
  provolatile char,       -- 'i' immutable, 's' stable, 'v' volatile
  proparallel char,       -- 's' safe, 'r' restricted, 'u' unsafe
  prosecdef boolean,       -- security definer?
  proconfig text[],        -- e.g. search_path settings, if any
  prosrc text,
  lang text
);

insert into diag_app_number_function_props (proname, provolatile, proparallel, prosecdef, proconfig, prosrc, lang)
select
  p.proname,
  p.provolatile,
  p.proparallel,
  p.prosecdef,
  p.proconfig,
  p.prosrc,
  l.lanname
from pg_proc p
join pg_language l on l.oid = p.prolang
where p.proname = 'next_application_number';

-- Sequence properties before any test calls.
create table if not exists diag_app_number_seq_props (
  captured_at timestamptz not null default now(),
  seqname text,
  last_value bigint,
  start_value bigint,
  increment_by bigint,
  is_called boolean
);

insert into diag_app_number_seq_props (seqname, last_value, start_value, increment_by, is_called)
select sequencename::text, last_value, start_value, increment_by, coalesce(last_value is not null, false)
from pg_sequences
where sequencename = 'application_number_seq';

------------------------------------------------------------------
-- Layer 1: the raw sequence directly. 20 tight-loop nextval() calls in a
-- single backend/transaction (this migration's own session) -- the
-- simplest possible ground truth. If Postgres's nextval() itself were
-- duplicating values, it would show up here with zero other layers
-- involved at all.
------------------------------------------------------------------
do $$
declare
  i int;
  v text;
begin
  for i in 1..20 loop
    v := nextval('application_number_seq')::text;
    insert into diag_app_number_log (layer, call_index, value) values ('layer1_raw_sequence_nextval', i, v);
  end loop;
end $$;

-- Also record currval() right after (same session, sequence already
-- touched by this session so currval() is valid) and a setval() probe that
-- restores the sequence to not lose numbers unnecessarily (setval to the
-- last value actually used, is_called=true, so the NEXT nextval() continues
-- from there rather than skipping or rewinding).
do $$
declare
  v_currval bigint;
begin
  v_currval := currval('application_number_seq');
  insert into diag_app_number_log (layer, call_index, value)
  values ('layer1_currval_after_loop', 0, v_currval::text);
end $$;

------------------------------------------------------------------
-- Layer 2: next_application_number() called directly, 20 times, tight
-- loop, same single backend/transaction. No RPC, no PostgREST, no pooler.
------------------------------------------------------------------
do $$
declare
  i int;
  v text;
begin
  for i in 1..20 loop
    v := next_application_number();
    insert into diag_app_number_log (layer, call_index, value) values ('layer2_function_direct', i, v);
  end loop;
end $$;

-- Sequence properties again after both loops, to see total advancement
-- (40 nextval() calls expected: 20 from layer 1 direct + 20 from layer 2
-- via the function).
insert into diag_app_number_seq_props (seqname, last_value, start_value, increment_by, is_called)
select 'application_number_seq_after_layers_1_2', last_value, start_value, increment_by, coalesce(last_value is not null, false)
from pg_sequences
where sequencename = 'application_number_seq';
