-- 20261025000100_avatars_bucket.sql
--
-- Profile picture storage for My Profile's new IdentityForm. Follows the
-- same conventions as participant-documents and import-uploads buckets:
-- explicit file_size_limit/allowed_mime_types at creation, folder-prefixed
-- path convention ((storage.foldername(name))[1] = auth.uid()::text, NOT
-- a flat {uid}.ext filename), and a single `for all` policy per role
-- (not per-verb -- a missing UPDATE policy elsewhere in this codebase
-- silently broke upsert:true, which avatar replacement needs).
--
-- Staff/admin read-all is deliberately NOT added here -- it needs
-- is_super_admin(), added in a later migration as part of the staff
-- role narrowing (see 2026-10-25-profile-accommodation-staff-narrowing-
-- design.md Item 6, layer 8). This bucket is unusable by nobody except
-- the owning participant until that migration lands, which is fine --
-- both ship in the same PR.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  false,
  5242880, -- 5 MB
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do nothing;

create policy "avatars_all_own"
  on storage.objects for all
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
