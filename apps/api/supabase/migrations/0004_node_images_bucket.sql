-- Storage bucket for editor-pasted/dragged images.
-- Public read so embeds in markdown work without signing on every render.
-- Authenticated upload only; service-role bypasses RLS.
-- Path convention: ${workspace_id}/${node_id}/${uuid}.${ext}
-- Constraints: 4MB max, png/jpeg/webp/gif only (enforced both client + bucket).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'node-images',
  'node-images',
  true,
  4194304,
  array['image/png','image/jpeg','image/webp','image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Public read of objects in this bucket.
drop policy if exists "node_images_public_read" on storage.objects;
create policy "node_images_public_read" on storage.objects
  for select using (bucket_id = 'node-images');

-- Authenticated users may upload to this bucket. Workspace scoping is
-- enforced server-side in /api/upload, not via RLS path inspection.
drop policy if exists "node_images_auth_insert" on storage.objects;
create policy "node_images_auth_insert" on storage.objects
  for insert with check (
    bucket_id = 'node-images' and auth.role() = 'authenticated'
  );

-- Allow the owner (uploader) to update/delete their own objects.
drop policy if exists "node_images_owner_update" on storage.objects;
create policy "node_images_owner_update" on storage.objects
  for update using (
    bucket_id = 'node-images' and auth.uid() = owner
  );

drop policy if exists "node_images_owner_delete" on storage.objects;
create policy "node_images_owner_delete" on storage.objects
  for delete using (
    bucket_id = 'node-images' and auth.uid() = owner
  );
