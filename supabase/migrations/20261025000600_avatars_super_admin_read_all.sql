-- 20261025000600_avatars_super_admin_read_all.sql
--
-- Deferred from the avatars bucket's original creation
-- (20261025000100_avatars_bucket.sql) until is_super_admin() existed
-- (added in 20261025000400). super_admin gets read-all access to
-- participant avatars for admin/support purposes; narrowed staff does
-- NOT get this -- viewing participant photos is not an attendance
-- capability.
create policy "avatars_select_super_admin"
  on storage.objects for select
  using (
    bucket_id = 'avatars'
    and is_super_admin()
  );
