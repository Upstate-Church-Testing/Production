-- A photo for every device type, stored in the public "gear-photos" bucket.
-- The app saves two files per photo: <path>.jpg (1000 px) and <path>-t.jpg (thumbnail).

alter table public.device_types
  add column photo_path text check (photo_path is null or length(photo_path) between 1 and 300);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gear-photos', 'gear-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Anyone with the link can view a photo (pictures of gear aren't sensitive);
-- only staff add, replace or remove them.
create policy "approved users list gear photos" on storage.objects
  for select to authenticated using (bucket_id = 'gear-photos' and (select public.has_role('volunteer')));
create policy "staff add gear photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'gear-photos' and (select public.has_role('staff')));
create policy "staff replace gear photos" on storage.objects
  for update to authenticated
  using (bucket_id = 'gear-photos' and (select public.has_role('staff')))
  with check (bucket_id = 'gear-photos' and (select public.has_role('staff')));
create policy "staff remove gear photos" on storage.objects
  for delete to authenticated using (bucket_id = 'gear-photos' and (select public.has_role('staff')));
