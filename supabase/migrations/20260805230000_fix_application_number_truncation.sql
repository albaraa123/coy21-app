-- fix_application_number_truncation.sql
--
-- Fixes the root cause identified in
-- docs/superpowers/specs/2026-08-01-application-number-isolation-report.md:
-- lpad(nextval(...)::text, 5, '0') silently TRUNCATES (not just pads) once
-- the sequence value exceeds 5 digits, which it now has via ordinary
-- cumulative usage -- collapsing every 10 consecutive sequence values into
-- one identical formatted string and causing the observed
-- applications_application_number_key unique-constraint failures. Proven
-- via 5-layer isolation to have zero connection to concurrency, PostgREST,
-- or connection pooling -- reproduces deterministically with a single
-- sequential call, no concurrency required.
--
-- Fix: evaluate nextval() exactly once via a CTE, then pad to a WIDTH
-- computed as GREATEST(5, length(the value)) instead of a fixed 5. This
-- preserves the existing minimum-5-digit zero-padded display format for
-- all values that fit (identical output to today, including the 42
-- existing historical application_number values, none of which this
-- migration touches), while a value that has genuinely grown past 5 digits
-- is padded to its own length (a no-op -- GREATEST(5, length(v)) equals
-- length(v) once length(v) > 5) rather than truncated to 5.
--
-- Kept as a single `language sql` function (unchanged from the original)
-- rather than converting to plpgsql: a `with` CTE binds nextval()'s result
-- once and every reference to it in the final select reads that same
-- bound value, so `nextval()` is still evaluated exactly once per call --
-- the same single-evaluation guarantee a plpgsql local variable would give,
-- achieved without a language change. `create or replace function` (not
-- drop+create) so existing GRANTs are preserved automatically -- Postgres
-- does not reset a function's ACL on CREATE OR REPLACE. Return type
-- (text), volatility (left unmarked, i.e. the same default VOLATILE the
-- original had -- correctly proven NOT the cause by the isolation report's
-- layer 3/4 concurrent-RPC results, which showed the raw sequence is
-- unique under real concurrency regardless of this function's volatility
-- marking), security mode (not security definer, unchanged), and the
-- absence of an explicit search_path (this function references only
-- application_number_seq, a single unqualified object with no ambiguity
-- risk -- unchanged from the original, not something the isolation report
-- found reason to add) are all preserved exactly as documented in the
-- isolation report's "Function definition and properties" section.
--
-- Does NOT reset, restart, or setval() the live sequence. Does NOT
-- renumber or backfill any existing applications.application_number value.
-- Does NOT touch the `unique` constraint on that column (still named
-- applications_application_number_key, retained exactly as-is).
create or replace function next_application_number() returns text as $$
  with generated as (
    select nextval('application_number_seq')::text as value
  )
  select 'RCOY-2026-' || lpad(value, greatest(5, length(value)), '0')
  from generated;
$$ language sql;
