-- Bestie POS · migration 5 · branding (docs/BRANDING-KNOWLEDGE.md).
--
-- The platform admin can rename the product and replace the logo / tab icon. Settings live in platform_settings.brand
-- (only what differs from the defaults); the images live in a PRIVATE bucket and are served publicly by our own
-- function (/brand/logo, /brand/favicon) with an ETag per upload version — never SVG, never overwritten in place.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brand-assets', 'brand-assets', false, 1048576, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy brand_assets_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'brand-assets' and public.is_platform_admin());
create policy brand_assets_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'brand-assets' and public.is_platform_admin());
create policy brand_assets_admin_select on storage.objects for select to authenticated
  using (bucket_id = 'brand-assets' and public.is_platform_admin());

-- Shape guard: a bad row would break every page, so refuse it at the door.
create or replace function public.platform_settings_check_brand() returns trigger
language plpgsql set search_path = '' as $$
declare
  k text;
  img jsonb;
begin
  for k in select jsonb_object_keys(new.brand) loop
    if k not in ('name_th', 'name_en', 'logo', 'favicon') then
      raise exception 'unknown brand key %', k using errcode = '23514';
    end if;
  end loop;
  foreach k in array array['name_th', 'name_en'] loop
    if new.brand ? k then
      if jsonb_typeof(new.brand -> k) <> 'string'
         or length(new.brand ->> k) not between 1 and 40
         or (new.brand ->> k) ~ '[<>\u0000-\u001f]' then
        raise exception 'invalid %', k using errcode = '23514';
      end if;
    end if;
  end loop;
  foreach k in array array['logo', 'favicon'] loop
    if new.brand ? k then
      img := new.brand -> k;
      if jsonb_typeof(img) <> 'object'
         or (img ->> 'mime') not in ('image/png', 'image/jpeg', 'image/webp')
         or jsonb_typeof(img -> 'version') <> 'number' then
        raise exception 'invalid % image reference', k using errcode = '23514';
      end if;
    end if;
  end loop;
  return new;
end $$;
create trigger platform_settings_brand_check before insert or update of brand on public.platform_settings
  for each row execute function public.platform_settings_check_brand();
