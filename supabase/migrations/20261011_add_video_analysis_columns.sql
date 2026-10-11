alter table public.lameguard_predictions
  add column if not exists original_media_path text,
  add column if not exists media_type text not null default 'image',
  add column if not exists annotated_video_path text,
  add column if not exists analysis_details jsonb not null default '{}'::jsonb,
  add column if not exists processing_duration_ms bigint;

update public.lameguard_predictions
set original_media_path = original_image_path
where original_media_path is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.lameguard_predictions'::regclass
      and conname = 'lameguard_predictions_media_type_check'
  ) then
    alter table public.lameguard_predictions
      add constraint lameguard_predictions_media_type_check
      check (media_type in ('image', 'video'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.lameguard_predictions'::regclass
      and conname = 'lameguard_predictions_processing_duration_check'
  ) then
    alter table public.lameguard_predictions
      add constraint lameguard_predictions_processing_duration_check
      check (processing_duration_ms is null or processing_duration_ms >= 0);
  end if;
end
$$;

create index if not exists lameguard_predictions_user_media_created_idx
  on public.lameguard_predictions(user_id, media_type, created_at desc);
