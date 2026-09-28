-- diag_raw_nextval_rpc.sql
-- DIAGNOSTIC ONLY, part of the P0 next_application_number() investigation.
-- Exposes the raw, untruncated nextval() result via its own RPC, so
-- concurrent-call tests can compare the true underlying sequence integers
-- against next_application_number()'s truncated formatted output for the
-- SAME burst of calls -- proving whether the raw integers are unique under
-- real concurrency (they should be, per Postgres's nextval() guarantee),
-- isolated from the separate, already-proven lpad() truncation bug.
create or replace function diag_raw_nextval() returns bigint as $$
  select nextval('application_number_seq');
$$ language sql;
