-- import_storage_policy_consolidation.sql
--
-- A code-quality review found the original per-verb (select/insert/delete)
-- policy split on storage.objects was a real, if safe, deviation from this
-- phase's established convention of a single `for all` policy per staff-only
-- resource (see import_rls_policies.sql, every policy there uses `for all`).
-- It also meant UPDATE had no matching policy — Postgres RLS default-denies
-- any unmatched operation, so this was never an access-control hole, but it
-- would silently break a future `upsert: true` call (Supabase Storage
-- performs an UPDATE under the hood for an upsert), which is easy to miss
-- since nothing about the omission was intentional-looking versus
-- oversight-looking. Consolidated into one `for all` policy per operation
-- type actually needed (select/insert/update/delete, all staff-gated),
-- matching the rest of this phase's RLS style exactly.
drop policy import_uploads_staff_read on storage.objects;
drop policy import_uploads_staff_write on storage.objects;
drop policy import_uploads_staff_delete on storage.objects;

create policy import_uploads_staff_all on storage.objects
  for all using (bucket_id = 'import-uploads' and current_user_role() in ('agenda_allocation_manager', 'super_admin'))
  with check (bucket_id = 'import-uploads' and current_user_role() in ('agenda_allocation_manager', 'super_admin'));
