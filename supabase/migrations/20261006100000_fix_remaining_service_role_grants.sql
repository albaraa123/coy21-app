-- 20261006100000_fix_remaining_service_role_grants.sql
--
-- Follow-up to 20261006080000_fix_missing_service_role_grants.sql: that
-- migration's own audit only checked for a missing SELECT grant per
-- table, which missed that `service_role` was ALSO missing DELETE on
-- 36 tables (and UPDATE/INSERT on several more) across the whole public
-- schema, not just the 22 tables that migration listed.
--
-- Found 2026-10-06 during sub-project 5a's third-round branch
-- re-review, which caught this live test file's own `afterAll` cleanup
-- silently failing: `service_role` has no DELETE on scan_attempts (nor
-- several other fixture tables this sub-project's and 4e's live tests
-- write to), so cleanup deletes fail, their errors go unchecked, and
-- every live test run since 20261006080000 landed has been leaking
-- fixture rows into deukwztsmcnxxchrdrfo permanently. Confirmed ~148
-- junk `OPS-*` sessions had accumulated in `sessions` by the time this
-- was caught. See the separate cleanup this same session ran to purge
-- the accumulated junk (not itself a migration, since it's one-time
-- data cleanup, not a schema change).
--
-- `service_role` has `rolbypassrls = true` and exists specifically to
-- be the unrestricted administrative/service connection -- there is no
-- legitimate reason for it to be missing ANY privilege on ANY table in
-- this schema, unlike `authenticated`/`anon`, where per-table/per-
-- operation scoping is a real security boundary (see
-- 20261006090000_fix_missing_authenticated_grants.sql's much more
-- careful, deliberately narrow scoping for that role). A second
-- manually-curated table list for service_role would risk repeating
-- the exact mistake that caused this gap -- auditing one privilege
-- instead of all four. A blanket grant is the correct, complete fix.
grant select, insert, update, delete, truncate, references, trigger
  on all tables in schema public to service_role;
grant usage, select, update on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
