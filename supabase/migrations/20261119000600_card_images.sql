-- Bestie POS · migration 35 · home-card pictures the platform admin can upload instead of the built-in illustrations
-- (docs/UX-DESIGN.md §7). Same pipeline as the brand images: PRIVATE bucket, a NEW versioned file per upload (never overwritten),
-- served publicly by our own function (/api/card-image) with an ETag, the settings pointing at the current file.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('card-images', 'card-images', false, 1048576, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy card_images_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'card-images' and public.is_platform_admin());
create policy card_images_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'card-images' and public.is_platform_admin());
create policy card_images_admin_select on storage.objects for select to authenticated
  using (bucket_id = 'card-images' and public.is_platform_admin());

-- { "<card id>": { "mime": "image/png", "version": 1760000000000 } } — readable by everybody like the brand (the home page needs it)
alter table public.platform_settings add column card_images jsonb not null default '{}'::jsonb check (jsonb_typeof(card_images) = 'object');

create or replace function public.platform_settings_check_card_images() returns trigger
language plpgsql set search_path = '' as $$
declare
  k text;
  v jsonb;
begin
  for k in select jsonb_object_keys(new.card_images) loop
    v := new.card_images -> k;
    if k !~ '^[a-zA-Z]{2,20}$'
       or jsonb_typeof(v) <> 'object'
       or (v ->> 'mime') not in ('image/png', 'image/jpeg', 'image/webp')
       or jsonb_typeof(v -> 'version') <> 'number'
       or (v - 'mime' - 'version') <> '{}'::jsonb then
      raise exception 'invalid card image entry %', k using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;
create trigger platform_settings_card_images_check before insert or update of card_images on public.platform_settings
  for each row execute function public.platform_settings_check_card_images();
