create table if not exists public.lameguard_predictions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  original_image_path text not null,
  original_media_path text,
  annotated_image_path text,
  annotated_video_path text,
  media_type text not null default 'image' check (media_type in ('image', 'video')),
  predicted_class text check (predicted_class in ('healthy-cow', 'limping-cow')),
  confidence numeric check (confidence >= 0 and confidence <= 1),
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  model_version text,
  detection_details jsonb not null default '[]'::jsonb,
  analysis_details jsonb not null default '{}'::jsonb,
  processing_duration_ms bigint check (processing_duration_ms is null or processing_duration_ms >= 0),
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists lameguard_predictions_user_created_idx
  on public.lameguard_predictions(user_id, created_at desc);
create index if not exists lameguard_predictions_user_media_created_idx
  on public.lameguard_predictions(user_id, media_type, created_at desc);

alter table public.lameguard_predictions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'lameguard_predictions'
      and policyname = 'LameGuard users can view their predictions'
  ) then
    create policy "LameGuard users can view their predictions"
      on public.lameguard_predictions for select to authenticated
      using ((select auth.uid()) = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'lameguard_predictions'
      and policyname = 'LameGuard users can insert their predictions'
  ) then
    create policy "LameGuard users can insert their predictions"
      on public.lameguard_predictions for insert to authenticated
      with check ((select auth.uid()) = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'lameguard_predictions'
      and policyname = 'LameGuard row ownership is enforced'
  ) then
    create policy "LameGuard row ownership is enforced"
      on public.lameguard_predictions as restrictive for all to public
      using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
      with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'lameguard_predictions'
      and policyname = 'LameGuard users can delete their predictions'
  ) then
    create policy "LameGuard users can delete their predictions"
      on public.lameguard_predictions for delete to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end
$$;
