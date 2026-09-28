-- explicit_answers_with_check.sql
--
-- A security-focused code-quality review found that
-- application_answers_staff_all / application_answers_sensitive_staff_all
-- (20260726105000_import_rls_policies.sql) omit an explicit WITH CHECK
-- clause on their FOR ALL policies. Postgres reuses USING as WITH CHECK
-- automatically when WITH CHECK is omitted — the review traced this through
-- concretely (an agenda_allocation_manager attempting to INSERT a row with
-- is_sensitive = true is correctly rejected, since the reused check clause
-- `not is_sensitive and ...` evaluates false) and found no exploitable gap.
-- Still, relying on that implicit reuse in a security-critical policy file
-- is a maintainability risk (silently breaks if a future policy author adds
-- an explicit narrower WITH CHECK to one sibling without mirroring it) —
-- making both checks explicit removes the ambiguity with zero behavior
-- change, confirmed by the review's own trace.
drop policy application_answers_staff_all on application_answers;
create policy application_answers_staff_all on application_answers
  for all
  using (not is_sensitive and current_user_role() in ('agenda_allocation_manager', 'super_admin'))
  with check (not is_sensitive and current_user_role() in ('agenda_allocation_manager', 'super_admin'));

drop policy application_answers_sensitive_staff_all on application_answers;
create policy application_answers_sensitive_staff_all on application_answers
  for all
  using (is_sensitive and current_user_role() = 'super_admin')
  with check (is_sensitive and current_user_role() = 'super_admin');
