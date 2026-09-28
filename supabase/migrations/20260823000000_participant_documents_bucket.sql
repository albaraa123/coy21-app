-- 20260823000000_participant_documents_bucket.sql
--
-- Creates the participant-documents storage bucket and its RLS policies.
-- Participants may upload/read only their own files (path prefix = their user id).
-- Staff (registration_admission_manager, super_admin) may read all files.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'participant-documents',
  'participant-documents',
  false,
  10485760, -- 10 MB
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- Participants: read own files (path must start with their user id)
create policy "participant_documents_select_own"
  on storage.objects for select
  using (
    bucket_id = 'participant-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Participants: upload own files
create policy "participant_documents_insert_own"
  on storage.objects for insert
  with check (
    bucket_id = 'participant-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Participants: replace/update own files
create policy "participant_documents_update_own"
  on storage.objects for update
  using (
    bucket_id = 'participant-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Participants: delete own files
create policy "participant_documents_delete_own"
  on storage.objects for delete
  using (
    bucket_id = 'participant-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Staff: read all participant documents
create policy "participant_documents_select_staff"
  on storage.objects for select
  using (
    bucket_id = 'participant-documents'
    and current_user_role() in ('registration_admission_manager', 'super_admin')
  );
