-- Bestie POS · migration 56 · PICTURES for menu items.
--
--  * One small raster picture per menu item, kept in the database (`menu_item_images`, JPEG / PNG / WebP, at most 256 KB — the
--    editor shrinks a photo to about 640 px before sending it). `menu_items.image_v` is the picture's version (null = none); it goes
--    into the picture's address (`/api/menu-image?i=<item>&v=<n>`), so a changed picture is a new address and browsers may cache it forever.
--  * Written ONLY through `save_menu_image` / `remove_menu_image` (menu.edit in the item's shop, audited). The table itself has no grant:
--    the picture is read by the server function `/api/menu-image` (service role) which anybody may call for an item id (128-bit, unguessable);
--    that is what lets the guest table page and the till show it without an account.
--  * The file is checked by its first bytes against the declared type, so a script or a PDF cannot be stored as a "picture".
--  * Guests see the version through `guest_menu` (new key `image_v`); staff read `image_v` from the menu rows they already load.

alter table public.menu_items add column image_v integer check (image_v is null or image_v > 0);

create table public.menu_item_images (
  item_id    uuid primary key references public.menu_items (id) on delete cascade,
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  mime       text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  data       bytea not null check (octet_length(data) between 100 and 262144),
  version    integer not null check (version > 0),
  updated_at timestamptz not null default now()
);
create index menu_item_images_store_idx on public.menu_item_images (store_id);
alter table public.menu_item_images enable row level security;
revoke all on public.menu_item_images from anon, authenticated;       -- no policy, no grant: only the functions below and the service role

create or replace function public.menu_image_magic_ok(p_mime text, p_data bytea) returns boolean
language sql immutable set search_path = '' as $$
  select case p_mime
    when 'image/jpeg' then substring(p_data from 1 for 3) = '\xffd8ff'::bytea
    when 'image/png'  then substring(p_data from 1 for 8) = '\x89504e470d0a1a0a'::bytea
    when 'image/webp' then substring(p_data from 1 for 4) = '\x52494646'::bytea and substring(p_data from 9 for 4) = '\x57454250'::bytea
    else false end
$$;

-- p_data = the picture, base64 (no data: prefix)
create or replace function public.save_menu_image(p_item uuid, p_mime text, p_data text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  it public.menu_items%rowtype;
  v_bytes bytea;
  v_ver integer;
begin
  select * into it from public.menu_items where id = p_item and deleted_at is null;
  if not found or not public.can_edit_menu(it.store_id) then
    raise exception 'pictures need menu.edit in this shop' using errcode = '42501';
  end if;
  begin
    v_bytes := decode(coalesce(p_data, ''), 'base64');
  exception when others then
    raise exception 'the picture is not valid base64' using errcode = '22023';
  end;
  if octet_length(v_bytes) not between 100 and 262144 then
    raise exception 'a picture is at most 256 KB' using errcode = '22023';
  end if;
  if not public.menu_image_magic_ok(p_mime, v_bytes) then
    raise exception 'the file is not a JPEG, PNG or WebP picture' using errcode = '22023';
  end if;
  insert into public.menu_item_images (item_id, org_id, store_id, mime, data, version)
  values (it.id, it.org_id, it.store_id, p_mime, v_bytes, 1)
  on conflict (item_id) do update set mime = excluded.mime, data = excluded.data, version = public.menu_item_images.version + 1, updated_at = now()
  returning version into v_ver;
  update public.menu_items set image_v = v_ver where id = it.id;
  perform public.audit_record(it.org_id, it.store_id, 'settings.change', 'menu_item_images', it.id::text,
    jsonb_build_object('version', v_ver, 'bytes', octet_length(v_bytes)), 'db');
  return v_ver;
end $$;

create or replace function public.remove_menu_image(p_item uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare it public.menu_items%rowtype;
begin
  select * into it from public.menu_items where id = p_item and deleted_at is null;
  if not found or not public.can_edit_menu(it.store_id) then
    raise exception 'pictures need menu.edit in this shop' using errcode = '42501';
  end if;
  delete from public.menu_item_images where item_id = it.id;
  update public.menu_items set image_v = null where id = it.id;
  perform public.audit_record(it.org_id, it.store_id, 'settings.change', 'menu_item_images', it.id::text, jsonb_build_object('removed', true), 'db');
end $$;

-- what /api/menu-image reads (service role only): the picture, base64 without line breaks
create or replace function public.menu_image_get(p_item uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('mime', i.mime, 'version', i.version, 'b64', translate(encode(i.data, 'base64'), E'\n', ''))
    from public.menu_item_images i join public.menu_items m on m.id = i.item_id
   where i.item_id = p_item and m.deleted_at is null
$$;

revoke all on function public.save_menu_image(uuid, text, text), public.remove_menu_image(uuid) from public, anon;
grant execute on function public.save_menu_image(uuid, text, text), public.remove_menu_image(uuid) to authenticated, service_role;
revoke all on function public.menu_image_get(uuid), public.menu_image_magic_ok(text, bytea) from public, anon, authenticated;
grant execute on function public.menu_image_get(uuid), public.menu_image_magic_ok(text, bytea) to service_role;

-- the guest menu now carries the picture version of every dish
create or replace function public.guest_menu(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with t as (select t.store_id from public.dining_tables t where t.qr_token = p_token and t.deleted_at is null and t.active)
  select jsonb_build_object(
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.sort, c.created_at)
        from public.menu_categories c where c.store_id = (select store_id from t) and c.deleted_at is null and c.active), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
          'id', i.id, 'category_id', i.category_id, 'name', i.name,
          'price', coalesce((i.prices ->> 'dine-in')::int, (i.prices ->> 'base')::int),
          'group_ids', i.modifier_group_ids,
          'tags', i.tags, 'spice_level', i.spice_level, 'verified', i.dietary_verified, 'highlight', i.highlight,
          'image_v', i.image_v) order by i.sort, i.created_at)
        from public.menu_items i where i.store_id = (select store_id from t) and i.deleted_at is null and i.available), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(jsonb_build_object(
          'id', g.id, 'name', g.name, 'min', g.min_select, 'max', g.max_select,
          'options', coalesce((select jsonb_agg(jsonb_build_object(
                'id', o.id, 'name', o.name, 'delta', coalesce((o.channel_delta ->> 'dine-in')::int, o.price_delta)) order by o.sort, o.created_at)
              from public.modifier_options o where o.group_id = g.id and o.deleted_at is null and o.active), '[]'::jsonb)) order by g.sort, g.created_at)
        from public.modifier_groups g where g.store_id = (select store_id from t) and g.deleted_at is null), '[]'::jsonb))
$$;
revoke all on function public.guest_menu(text) from public, anon, authenticated;
grant execute on function public.guest_menu(text) to service_role;
