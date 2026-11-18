-- Bestie POS · migration 12 · menu: categories, items, modifier groups + options.
--
--  * every row carries org_id + store_id (rule 7), a client-generated uuid, updated_at and a soft delete (offline-first);
--  * money = bigint/integer satang; per-channel prices live in jsonb {base, dine-in?, takeaway?, delivery?, qr?};
--  * names are jsonb {th (required), en?, …} — Thai is the source language;
--  * everything is shape-guarded in the database (a screen bug cannot store garbage the POS would choke on);
--  * only people with `menu.edit` can write; everyone who may enter the store can read;
--  * price changes and item changes are audited (menu.price_change / menu.item_change) and pinged live.

-- ── shared guards ──────────────────────────────────────────────────────────
create or replace function public.menu_text_ok(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(case when jsonb_typeof(p) is distinct from 'object' then false
    else jsonb_typeof(p -> 'th') = 'string'
     and length(btrim(p ->> 'th')) between 1 and 120
     and not exists (
       select 1 from jsonb_each(p) e
       where e.key not in ('th', 'en', 'ru', 'he', 'de', 'zh')
          or jsonb_typeof(e.value) <> 'string'
          or length(e.value #>> '{}') > 120) end, false);
$$;

-- whole satang, within ±1,000,000 baht, for the allowed channel keys only
create or replace function public.menu_money_map_ok(p jsonb, p_allow_base boolean, p_allow_negative boolean)
returns boolean language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p) is distinct from 'object' then false
    else not exists (
       select 1 from jsonb_each(p) e
       where case -- CASE keeps the order: the numeric cast only runs on values already known to be integers
         when not (e.key in ('dine-in', 'takeaway', 'delivery', 'qr') or (p_allow_base and e.key = 'base')) then true
         when jsonb_typeof(e.value) <> 'number' then true
         when (e.value #>> '{}') !~ '^-?[0-9]+$' then true
         when not p_allow_negative and (e.value #>> '{}')::numeric < 0 then true
         when abs((e.value #>> '{}')::numeric) > 100000000 then true
         else false end) end;
$$;

-- pure helpers called from the guard triggers (which run as the signed-in user): explicit grants, no defaults
revoke all on function public.menu_text_ok(jsonb), public.menu_money_map_ok(jsonb, boolean, boolean) from public, anon;
grant execute on function public.menu_text_ok(jsonb), public.menu_money_map_ok(jsonb, boolean, boolean) to authenticated, service_role;

create or replace function public.menu_check_store() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.stores s where s.id = new.store_id and s.org_id = new.org_id) then
    raise exception 'store does not belong to this org' using errcode = '23514';
  end if;
  if not public.menu_text_ok(new.name) then
    raise exception 'invalid name (Thai name 1-120 characters is required)' using errcode = '23514';
  end if;
  return new;
end $$;

-- ── categories ─────────────────────────────────────────────────────────────
create table public.menu_categories (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  name       jsonb not null,
  sort       integer not null default 0 check (sort between -100000 and 100000),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index menu_categories_store_idx on public.menu_categories (store_id) where deleted_at is null;

-- ── modifier groups + options ──────────────────────────────────────────────
create table public.modifier_groups (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  name       jsonb not null,
  min_select integer not null default 0 check (min_select between 0 and 50),
  max_select integer not null default 1 check (max_select between 1 and 50),
  sort       integer not null default 0 check (sort between -100000 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (min_select <= max_select)
);
create index modifier_groups_store_idx on public.modifier_groups (store_id) where deleted_at is null;

create table public.modifier_options (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs (id) on delete cascade,
  store_id      uuid not null references public.stores (id) on delete cascade,
  group_id      uuid not null references public.modifier_groups (id) on delete cascade,
  name          jsonb not null,
  price_delta   integer not null default 0 check (price_delta between -100000000 and 100000000),
  channel_delta jsonb not null default '{}'::jsonb,
  sort          integer not null default 0 check (sort between -100000 and 100000),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index modifier_options_group_idx on public.modifier_options (group_id) where deleted_at is null;

create or replace function public.modifier_options_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.modifier_groups g where g.id = new.group_id and g.store_id = new.store_id and g.org_id = new.org_id) then
    raise exception 'group belongs to another store' using errcode = '23514';
  end if;
  if not public.menu_money_map_ok(new.channel_delta, false, true) then
    raise exception 'invalid channel prices for the option' using errcode = '23514';
  end if;
  return new;
end $$;

-- ── items ──────────────────────────────────────────────────────────────────
create table public.menu_items (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.orgs (id) on delete cascade,
  store_id           uuid not null references public.stores (id) on delete cascade,
  category_id        uuid not null references public.menu_categories (id),
  name               jsonb not null,
  prices             jsonb not null,
  station            text check (station in ('kitchen', 'bar')),
  modifier_group_ids uuid[] not null default '{}' check (cardinality(modifier_group_ids) <= 20),
  available          boolean not null default true,
  sort               integer not null default 0 check (sort between -100000 and 100000),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create index menu_items_store_idx on public.menu_items (store_id) where deleted_at is null;
create index menu_items_category_idx on public.menu_items (category_id);

create or replace function public.menu_items_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.menu_categories c where c.id = new.category_id and c.store_id = new.store_id and c.org_id = new.org_id) then
    raise exception 'category belongs to another store' using errcode = '23514';
  end if;
  if not coalesce(public.menu_money_map_ok(new.prices, true, false) and jsonb_typeof(new.prices -> 'base') = 'number', false) then
    raise exception 'invalid prices (base price in whole satang is required)' using errcode = '23514';
  end if;
  if exists (select 1 from unnest(new.modifier_group_ids) g group by g having count(*) > 1) then
    raise exception 'duplicate modifier group' using errcode = '23514';
  end if;
  if (select count(*) from public.modifier_groups g
       where g.id = any (new.modifier_group_ids) and g.store_id = new.store_id and g.org_id = new.org_id)
     <> cardinality(new.modifier_group_ids) then
    raise exception 'modifier group belongs to another store' using errcode = '23514';
  end if;
  return new;
end $$;

-- guards + housekeeping
create trigger menu_categories_check before insert or update on public.menu_categories
  for each row execute function public.menu_check_store();
create trigger modifier_groups_check before insert or update on public.modifier_groups
  for each row execute function public.menu_check_store();
create trigger modifier_options_check before insert or update on public.modifier_options
  for each row execute function public.menu_check_store();
create trigger modifier_options_check2 before insert or update on public.modifier_options
  for each row execute function public.modifier_options_guard();
create trigger menu_items_check before insert or update on public.menu_items
  for each row execute function public.menu_check_store();
create trigger menu_items_check2 before insert or update on public.menu_items
  for each row execute function public.menu_items_guard();
create trigger menu_categories_touch before update on public.menu_categories for each row execute function public.touch_updated_at();
create trigger modifier_groups_touch before update on public.modifier_groups for each row execute function public.touch_updated_at();
create trigger modifier_options_touch before update on public.modifier_options for each row execute function public.touch_updated_at();
create trigger menu_items_touch before update on public.menu_items for each row execute function public.touch_updated_at();

-- ── audit (price changes and item changes; sort order and touch-ups are not worth a row) ─
create or replace function public.audit_trg_menu_items() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit_record(new.org_id, new.store_id, 'menu.item_change', 'menu_items', new.id::text, jsonb_build_object('op', 'create'), 'db');
  else
    if new.prices is distinct from old.prices then
      perform public.audit_record(new.org_id, new.store_id, 'menu.price_change', 'menu_items', new.id::text,
        jsonb_build_object('from_base', (old.prices ->> 'base')::bigint, 'to_base', (new.prices ->> 'base')::bigint), 'db');
    end if;
    if new.name is distinct from old.name or new.station is distinct from old.station or new.available is distinct from old.available
       or new.category_id is distinct from old.category_id or new.modifier_group_ids is distinct from old.modifier_group_ids
       or (new.deleted_at is not null) is distinct from (old.deleted_at is not null) then
      perform public.audit_record(new.org_id, new.store_id, 'menu.item_change', 'menu_items', new.id::text,
        jsonb_build_object('op', case when new.deleted_at is not null and old.deleted_at is null then 'delete' else 'update' end), 'db');
    end if;
  end if;
  return new;
end $$;
create trigger menu_items_audit after insert or update on public.menu_items for each row execute function public.audit_trg_menu_items();

create or replace function public.audit_trg_modifier_options() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.price_delta is distinct from old.price_delta or new.channel_delta is distinct from old.channel_delta
     or (new.deleted_at is not null) is distinct from (old.deleted_at is not null) then
    perform public.audit_record(new.org_id, new.store_id, 'menu.price_change', 'modifier_options', new.id::text,
      jsonb_build_object('to_delta', new.price_delta), 'db');
  end if;
  return new;
end $$;
create trigger modifier_options_audit after insert or update on public.modifier_options for each row execute function public.audit_trg_modifier_options();

-- ── live sync: POS, KDS and QR screens re-read the menu when it changes ────
create trigger menu_categories_live after insert or update on public.menu_categories for each row execute function public.live_ping_row('store:{store_id}');
create trigger menu_items_live after insert or update on public.menu_items for each row execute function public.live_ping_row('store:{store_id}');
create trigger modifier_groups_live after insert or update on public.modifier_groups for each row execute function public.live_ping_row('store:{store_id}');
create trigger modifier_options_live after insert or update on public.modifier_options for each row execute function public.live_ping_row('store:{store_id}');

-- ── RLS: read where you work, write with menu.edit; no hard deletes (soft delete = update) ─
alter table public.menu_categories enable row level security;
alter table public.modifier_groups enable row level security;
alter table public.modifier_options enable row level security;
alter table public.menu_items enable row level security;

create policy menu_categories_read on public.menu_categories for select to authenticated using (public.can_access_store(org_id, store_id));
create policy modifier_groups_read on public.modifier_groups for select to authenticated using (public.can_access_store(org_id, store_id));
create policy modifier_options_read on public.modifier_options for select to authenticated using (public.can_access_store(org_id, store_id));
create policy menu_items_read on public.menu_items for select to authenticated using (public.can_access_store(org_id, store_id));

create policy menu_categories_insert on public.menu_categories for insert to authenticated with check (public.has_permission(org_id, 'menu.edit') and public.can_access_store(org_id, store_id));
create policy menu_categories_update on public.menu_categories for update to authenticated
  using (public.has_permission(org_id, 'menu.edit') and public.can_access_store(org_id, store_id))
  with check (public.has_permission(org_id, 'menu.edit') and public.can_access_store(org_id, store_id));
create policy modifier_groups_insert on public.modifier_groups for insert to authenticated with check (public.has_permission(org_id, 'menu.edit') and public.can_access_store(org_id, store_id));
create policy modifier_groups_update on public.modifier_groups for update to authenticated
  using (public.has_permission(org_id, 'menu.edit') and public.can_access_store(org_id, store_id))
  with check (public.has_permission(org_id, 'menu.edit') and public.can_access_store(org_id, store_id));
create policy modifier_options_insert on public.modifier_options for insert to authenticated with check (public.has_permission(org_id, 'menu.edit') and public.can_access_store(org_id, store_id));
create policy modifier_options_update on public.modifier_options for update to authenticated
  using (public.has_permission(org_id, 'menu.edit') and public.can_access_store(org_id, store_id))
  with check (public.has_permission(org_id, 'menu.edit') and public.can_access_store(org_id, store_id));
create policy menu_items_insert on public.menu_items for insert to authenticated with check (public.has_permission(org_id, 'menu.edit') and public.can_access_store(org_id, store_id));
create policy menu_items_update on public.menu_items for update to authenticated
  using (public.has_permission(org_id, 'menu.edit') and public.can_access_store(org_id, store_id))
  with check (public.has_permission(org_id, 'menu.edit') and public.can_access_store(org_id, store_id));

revoke all on public.menu_categories, public.modifier_groups, public.modifier_options, public.menu_items from anon, authenticated;
grant select, insert, update on public.menu_categories, public.modifier_groups, public.modifier_options, public.menu_items to authenticated;
