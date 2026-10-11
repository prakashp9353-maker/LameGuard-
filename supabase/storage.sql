do $$
begin
  if exists (
    select 1 from storage.buckets
    where id = 'lameguard-images' and public = true
  ) then
    raise exception 'The lameguard-images bucket exists but is public. Make it private before continuing.';
  end if;

  insert into storage.buckets (id, name, public)
  values ('lameguard-images', 'lameguard-images', false)
  on conflict (id) do update
  set file_size_limit = 262144000,
      allowed_mime_types = array['image/jpeg', 'image/png', 'video/mp4']::text[]
  where storage.buckets.public = false;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'LameGuard users can view their images'
  ) then
    create policy "LameGuard users can view their images"
      on storage.objects for select to authenticated
      using (
        bucket_id = 'lameguard-images'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'LameGuard storage ownership is enforced'
  ) then
    create policy "LameGuard storage ownership is enforced"
      on storage.objects as restrictive for all to public
      using (
        bucket_id <> 'lameguard-images'
        or (
          bucket_id = 'lameguard-images'
          and (select auth.uid()) is not null
          and (storage.foldername(name))[1] = (select auth.uid())::text
        )
      )
      with check (
        bucket_id <> 'lameguard-images'
        or (
          bucket_id = 'lameguard-images'
          and (select auth.uid()) is not null
          and (storage.foldername(name))[1] = (select auth.uid())::text
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'LameGuard users can upload their images'
  ) then
    create policy "LameGuard users can upload their images"
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'lameguard-images'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'LameGuard users can delete their images'
  ) then
    create policy "LameGuard users can delete their images"
      on storage.objects for delete to authenticated
      using (
        bucket_id = 'lameguard-images'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;
end
$$;
