-- import_storage_bucket.sql
insert into storage.buckets (id, name, public) values ('import-uploads', 'import-uploads', false);

-- Staff-only access to the bucket's objects, mirroring the table RLS
-- convention. Supabase Storage RLS applies to storage.objects, scoped by
-- bucket_id.
create policy import_uploads_staff_read on storage.objects
  for select using (bucket_id = 'import-uploads' and current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy import_uploads_staff_write on storage.objects
  for insert with check (bucket_id = 'import-uploads' and current_user_role() in ('agenda_allocation_manager', 'super_admin'));
create policy import_uploads_staff_delete on storage.objects
  for delete using (bucket_id = 'import-uploads' and current_user_role() in ('agenda_allocation_manager', 'super_admin'));
