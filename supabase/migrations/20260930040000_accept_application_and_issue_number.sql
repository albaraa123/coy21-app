-- 20260930040000_accept_application_and_issue_number.sql
--
-- Generates and persists application_number exactly once, atomically, when
-- an application is accepted — closing the gap where application_number
-- previously existed on a self-registered application from the moment of
-- submission (draft -> submitted), well before any staff review. See
-- docs/superpowers/specs/2026-09-30-import-classification-approval-design.md
-- §2.1 for the full reasoning, including why this needs to be a single
-- atomic statement rather than a read-then-write from the caller: two
-- concurrent accept-attempts on the SAME application (e.g. a double-click)
-- must not each generate a number for the one application. The
-- coalesce(...) inside a single UPDATE makes the check-and-generate
-- atomic; nextval()-based generation itself is already race-free
-- regardless, per the same section's reasoning.
--
-- Only ever called from updateApplicationStatus's Server Action after that
-- function has already validated the transition and performed its own
-- optimistic-concurrency status write — this function does not repeat
-- that check, it only handles the number.
create function accept_application_and_issue_number(p_application_id uuid)
returns text language sql as $$
  update applications
  set application_number = coalesce(application_number, next_application_number(participant_type))
  where id = p_application_id
  returning application_number;
$$;

-- Sibling function, defined here rather than in Task 4's own migration
-- because it is thematically identical (same table, same generation
-- function, same single-statement-atomicity reasoning) and this keeps
-- every application_number-writing function in one place. Used by Task 4's
-- reclassifyApplication helper when an ALREADY-accepted application is
-- reclassified — that case must genuinely REPLACE the existing number
-- (the old code, per spec §3.4, becomes invalid and a new one is issued),
-- unlike accept_application_and_issue_number above, which must NOT replace
-- an existing number (a waitlisted/rejected -> accepted re-entry keeps its
-- original code). The coalesce() in the function above and its absence
-- here is the entire difference between these two functions — do not
-- collapse them into one parameterized function; the two call sites' safety
-- properties depend on this being enforced unconditionally at the SQL
-- level, not by trusting every future caller to pass the right flag.
create function regenerate_application_number(p_application_id uuid)
returns text language sql as $$
  update applications
  set application_number = next_application_number(participant_type)
  where id = p_application_id
  returning application_number;
$$;
