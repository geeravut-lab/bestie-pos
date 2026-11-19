-- Bestie POS · migration 31 · food information on menu items + the guest menu assistant switch (docs/AI-CUSTOMER-ASSISTANT.md §3A).
--
--  * The SHOP sets the tags; an AI may draft them, a person confirms (`dietary_verified`). "Unknown" is never "safe":
--    the guest page treats a dish that is not verified as "ask the staff" whenever the guest asks for a dietary filter.
--  * The tag list is a CLOSED set (a CHECK), so a typo or a model's invention can never become a tag.
--  * The module `ai.guest` (off by default, Pro, needs QR ordering) switches the assistant on per shop. The guest page itself
--    (menu + filter chips) works without it and without any AI key.

alter table public.menu_items
  add column tags text[] not null default '{}',
  add column spice_level smallint check (spice_level between 0 and 3),
  add column dietary_verified boolean not null default false,
  add column highlight boolean not null default false;

alter table public.menu_items add constraint menu_items_tags_known check (
  tags <@ array['contains_pork','contains_beef','contains_chicken','contains_seafood','contains_shellfish','contains_egg',
                'contains_dairy','contains_gluten','contains_peanut','contains_tree_nut','contains_soy','contains_alcohol',
                'vegetarian','vegan','halal']::text[]
  and cardinality(tags) <= 15);
-- a dish cannot be both vegetarian and contain meat, or vegan and contain egg / dairy / meat
alter table public.menu_items add constraint menu_items_tags_consistent check (
  not ('vegetarian' = any (tags) and tags && array['contains_pork','contains_beef','contains_chicken','contains_seafood','contains_shellfish']::text[])
  and not ('vegan' = any (tags) and tags && array['contains_pork','contains_beef','contains_chicken','contains_seafood','contains_shellfish','contains_egg','contains_dairy']::text[]));

-- ── module guard knows the new id ──────────────────────────────────────────
create or replace function public.stores_check_modules() returns trigger
language plpgsql set search_path = '' as $$
declare
  k text;
  known text[] := array['tables.floorplan','bill.split','queue.call','kds','order.qr','kiosk','delivery','service.charge',
    'appointments','resources','deposits','commission','packages','slots.booking','folio','pms','stock','recipe.cost',
    'loyalty.network','tender.promptpay','tender.gateway','tender.credit','tender.points','credit.topup.crypto',
    'ai.assistant','ai.guest','line.notify'];
  crypto_ok boolean;
begin
  for k in select jsonb_object_keys(new.module_overrides) loop
    if not (k = any (known)) then raise exception 'unknown module %', k using errcode = '23514'; end if;
    if jsonb_typeof(new.module_overrides -> k) <> 'boolean' then raise exception 'module % must be true or false', k using errcode = '23514'; end if;
  end loop;
  if (new.module_overrides ->> 'credit.topup.crypto') = 'true' then
    select coalesce((o.legal_sign_off ->> 'cryptoTopup')::boolean, false) into crypto_ok from public.orgs o where o.id = new.org_id;
    if not coalesce(crypto_ok, false) then
      raise exception 'crypto top-up needs the org legal sign-off' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- ── is the guest menu assistant on for this shop? (mirrors the registry: off for every profile, Pro and up, needs QR ordering) ──
-- registry:ai.guest profiles= plan=pro,resort depends=order.qr
create or replace function public.guest_ai_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select (s.module_overrides ->> 'ai.guest')::boolean from public.stores s where s.id = p_store and s.module_overrides ? 'ai.guest'), false)
     and coalesce((select s.plan in ('pro', 'resort') from public.stores s where s.id = p_store), false)
     and public.qr_ordering_enabled(p_store)
$$;
revoke all on function public.guest_ai_enabled(uuid) from public, anon, authenticated;
grant execute on function public.guest_ai_enabled(uuid) to service_role;

create or replace function public.guest_table(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'table_id', t.id, 'table_name', t.name, 'store_id', s.id, 'org_id', s.org_id, 'store_name', s.name,
    'profile', s.profile, 'plan', s.plan, 'qr_enabled', public.qr_ordering_enabled(s.id), 'auto_send', s.qr_auto_send,
    'ai_enabled', public.guest_ai_enabled(s.id),
    'vat_registered', s.vat_registered, 'vat_bps', s.vat_bps, 'service_charge_bps', s.service_charge_bps)
  from public.dining_tables t
  join public.stores s on s.id = t.store_id and s.deleted_at is null
  where t.qr_token = p_token and t.deleted_at is null and t.active
$$;
revoke all on function public.guest_table(text) from public, anon, authenticated;
grant execute on function public.guest_table(text) to service_role;

-- the guest menu now carries the food information (what the shop said, nothing guessed)
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
          'tags', i.tags, 'spice_level', i.spice_level, 'verified', i.dietary_verified, 'highlight', i.highlight) order by i.sort, i.created_at)
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

-- who may ask the AI to draft food information for a shop's dishes (the server checks this with the person's own token)
create or replace function public.can_edit_menu(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stores s
                  where s.id = p_store and s.deleted_at is null
                    and public.has_permission(s.org_id, 'menu.edit') and public.can_access_store(s.org_id, s.id))
$$;
revoke all on function public.can_edit_menu(uuid) from public, anon;
grant execute on function public.can_edit_menu(uuid) to authenticated, service_role;
