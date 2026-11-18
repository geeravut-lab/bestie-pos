-- Bestie POS · migration 14 · floor plan + orders + order lines (+ a short code per device for order numbers).
--
--  * every row carries org_id + store_id, a client-generated uuid, updated_at (offline-first, rule 5 + 7);
--  * an order number is  <device code><3+ digits>  (e.g. A012): two devices offline on the same day can never collide;
--  * lines are history once SENT: price, quantity, name and options are frozen, only the kitchen status moves forward;
--  * voiding something already sent needs `order.void`; an order can only become PAID through the payment function
--    (migration 15) — never by a plain client update;
--  * writing needs `order.create` (the signed-in tablet account), reading needs access to the shop.

-- ── device codes ───────────────────────────────────────────────────────────
alter table public.devices add column code text check (code ~ '^[A-Z]{1,2}$');

create or replace function public.devices_assign_code() returns trigger
language plpgsql set search_path = '' as $$
declare
  n integer := 1;
  c text;
begin
  if new.code is null then
    loop
      c := case when n <= 26 then chr(64 + n) else chr(64 + ((n - 1) / 26)) || chr(65 + ((n - 1) % 26)) end;
      exit when not exists (select 1 from public.devices d where d.store_id = new.store_id and d.code = c);
      n := n + 1;
    end loop;
    new.code := c;
  end if;
  return new;
end $$;
create trigger devices_code before insert on public.devices for each row execute function public.devices_assign_code();

-- existing devices get A, B, C … per shop, in the order they were registered
do $$
declare r record; n integer; prev uuid := null;
begin
  for r in select id, store_id from public.devices where code is null order by store_id, created_at loop
    if prev is distinct from r.store_id then n := 0; prev := r.store_id; end if;
    n := n + 1;
    update public.devices set code = case when n <= 26 then chr(64 + n) else chr(64 + ((n - 1) / 26)) || chr(65 + ((n - 1) % 26)) end where id = r.id;
  end loop;
end $$;
create unique index devices_store_code_uidx on public.devices (store_id, code);

-- ── tables of the floor plan ───────────────────────────────────────────────
create table public.dining_tables (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 40),
  zone       text not null default '' check (length(zone) <= 40),
  seats      integer not null default 2 check (seats between 1 and 50),
  sort       integer not null default 0 check (sort between -100000 and 100000),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index dining_tables_name_uidx on public.dining_tables (store_id, lower(btrim(name))) where deleted_at is null;
create index dining_tables_store_idx on public.dining_tables (store_id) where deleted_at is null;

create or replace function public.dining_tables_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.stores s where s.id = new.store_id and s.org_id = new.org_id) then
    raise exception 'store does not belong to this org' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger dining_tables_check before insert or update on public.dining_tables for each row execute function public.dining_tables_guard();
create trigger dining_tables_touch before update on public.dining_tables for each row execute function public.touch_updated_at();
create trigger dining_tables_live after insert or update on public.dining_tables for each row execute function public.live_ping_row('store:{store_id}');

-- ── orders ─────────────────────────────────────────────────────────────────
create table public.orders (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs (id) on delete cascade,
  store_id      uuid not null references public.stores (id) on delete cascade,
  number        text not null check (number ~ '^[A-Z]{1,2}[0-9]{3,5}$'),
  business_date date not null,
  channel       text not null check (channel in ('dine-in', 'takeaway', 'delivery', 'qr')),
  status        text not null default 'open' check (status in ('open', 'sent', 'ready', 'served', 'paid', 'void')),
  table_id      uuid references public.dining_tables (id),
  covers        integer check (covers between 1 and 99),
  note          text check (length(note) <= 300),
  opened_by     uuid references public.staff (id),
  device_id     uuid references public.devices (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  closed_at     timestamptz,
  unique (store_id, business_date, number)
);
create index orders_store_open_idx on public.orders (store_id, status) where status not in ('paid', 'void');
create index orders_table_idx on public.orders (table_id) where table_id is not null;

create table public.order_lines (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  order_id    uuid not null references public.orders (id) on delete cascade,
  item_id     uuid references public.menu_items (id),
  name        jsonb not null,
  unit_price  integer not null check (unit_price between 0 and 100000000),
  quantity    integer not null check (quantity between 1 and 99),
  modifiers   jsonb not null default '[]'::jsonb,
  note        text check (length(note) <= 200),
  station     text check (station in ('kitchen', 'bar')),
  status      text not null default 'new' check (status in ('new', 'sent', 'ready', 'served', 'void')),
  sent_at     timestamptz,
  void_reason text check (length(void_reason) <= 100),
  seat        integer check (seat between 1 and 30),
  created_by  uuid references public.staff (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index order_lines_order_idx on public.order_lines (order_id);
create index order_lines_station_idx on public.order_lines (store_id, station, status) where status in ('sent', 'ready');

-- the payment function (next migration) runs with this flag set; nobody else can
create or replace function public.order_privileged() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('bestie.paying', true), '') = 'on'
      or current_user in ('service_role', 'postgres', 'supabase_admin')
$$;
revoke all on function public.order_privileged() from public, anon;
grant execute on function public.order_privileged() to authenticated, service_role;

create or replace function public.orders_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  if not exists (select 1 from public.stores s where s.id = new.store_id and s.org_id = new.org_id) then
    raise exception 'store does not belong to this org' using errcode = '23514';
  end if;
  if new.table_id is not null and not exists (
       select 1 from public.dining_tables t where t.id = new.table_id and t.store_id = new.store_id) then
    raise exception 'table belongs to another shop' using errcode = '23514';
  end if;
  if new.device_id is not null and not exists (
       select 1 from public.devices d where d.id = new.device_id and d.store_id = new.store_id) then
    raise exception 'device belongs to another shop' using errcode = '23514';
  end if;
  if new.opened_by is not null and not exists (
       select 1 from public.staff s where s.id = new.opened_by and s.org_id = new.org_id) then
    raise exception 'staff belongs to another org' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.business_date not between today - 2 and today + 1 then
      raise exception 'business date is not today' using errcode = '23514';
    end if;
    if new.status in ('paid', 'void') and not public.order_privileged() then
      raise exception 'an order is closed by payment, not directly' using errcode = '23514';
    end if;
  else
    if new.org_id <> old.org_id or new.store_id <> old.store_id or new.number <> old.number
       or new.business_date <> old.business_date or new.channel <> old.channel then
      raise exception 'order identity cannot change' using errcode = '23514';
    end if;
    if old.status in ('paid', 'void') and not public.order_privileged() then
      raise exception 'order is closed' using errcode = '23514';
    end if;
    if new.status = 'paid' and old.status <> 'paid' and not public.order_privileged() then
      raise exception 'an order is closed by payment, not directly' using errcode = '23514';
    end if;
    if new.status = 'void' and old.status <> 'void' and not public.order_privileged()
       and not public.has_permission(new.org_id, 'order.void') then
      raise exception 'voiding an order needs order.void' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger orders_check before insert or update on public.orders for each row execute function public.orders_guard();
create trigger orders_touch before update on public.orders for each row execute function public.touch_updated_at();

create or replace function public.order_lines_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  o public.orders%rowtype;
  m jsonb;
  rank_old integer;
  rank_new integer;
begin
  select * into o from public.orders where id = new.order_id;
  if not found or o.store_id <> new.store_id or o.org_id <> new.org_id then
    raise exception 'order belongs to another shop' using errcode = '23514';
  end if;
  if o.status in ('paid', 'void') and not public.order_privileged() then
    raise exception 'order is closed' using errcode = '23514';
  end if;
  if not public.menu_text_ok(new.name) then
    raise exception 'invalid line name' using errcode = '23514';
  end if;
  if new.item_id is not null and not exists (
       select 1 from public.menu_items i where i.id = new.item_id and i.store_id = new.store_id) then
    raise exception 'item belongs to another shop' using errcode = '23514';
  end if;
  if jsonb_typeof(new.modifiers) is distinct from 'array' or jsonb_array_length(new.modifiers) > 30 then
    raise exception 'modifiers must be a short list' using errcode = '23514';
  end if;
  for m in select * from jsonb_array_elements(new.modifiers) loop
    if jsonb_typeof(m) is distinct from 'object'
       or jsonb_typeof(m -> 'id') is distinct from 'string'
       or jsonb_typeof(m -> 'priceDelta') is distinct from 'number'
       or (m ->> 'priceDelta') !~ '^-?[0-9]+$'
       or not public.menu_text_ok(m -> 'name') then
      raise exception 'invalid modifier' using errcode = '23514';
    end if;
  end loop;

  if tg_op = 'INSERT' then
    if new.status not in ('new', 'sent') then
      raise exception 'a line starts as new' using errcode = '23514';
    end if;
    return new;
  end if;

  -- UPDATE
  if new.order_id <> old.order_id or new.org_id <> old.org_id or new.store_id <> old.store_id then
    raise exception 'line identity cannot change' using errcode = '23514';
  end if;
  rank_old := case old.status when 'new' then 0 when 'sent' then 1 when 'ready' then 2 when 'served' then 3 else 9 end;
  rank_new := case new.status when 'new' then 0 when 'sent' then 1 when 'ready' then 2 when 'served' then 3 else 9 end;
  if old.status = 'void' and new.status <> 'void' then
    raise exception 'a voided line stays void' using errcode = '23514';
  end if;
  if new.status <> 'void' and rank_new < rank_old then
    raise exception 'a line only moves forward' using errcode = '23514';
  end if;
  -- once sent, a line is history: only its kitchen status (and the void) may change
  if old.status <> 'new' and (new.unit_price <> old.unit_price or new.quantity <> old.quantity
       or new.name <> old.name or new.modifiers <> old.modifiers or new.item_id is distinct from old.item_id
       or new.note is distinct from old.note) then
    raise exception 'a sent line cannot be edited' using errcode = '23514';
  end if;
  if new.status = 'void' and old.status not in ('new', 'void') and not public.order_privileged()
     and not public.has_permission(new.org_id, 'order.void') then
    raise exception 'voiding a sent line needs order.void' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger order_lines_check before insert or update on public.order_lines for each row execute function public.order_lines_guard();
create trigger order_lines_touch before update on public.order_lines for each row execute function public.touch_updated_at();

create or replace function public.audit_trg_order_lines() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.status = 'void' and old.status not in ('new', 'void') then
    perform public.audit_record(new.org_id, new.store_id, 'order.void', 'order_lines', new.id::text,
      jsonb_build_object('order_id', new.order_id, 'was', old.status, 'qty', new.quantity, 'amount', new.unit_price * new.quantity), 'db');
  end if;
  return new;
end $$;
create trigger order_lines_audit after update on public.order_lines for each row execute function public.audit_trg_order_lines();

create trigger orders_live after insert or update on public.orders for each row execute function public.live_ping_row('store:{store_id}');
create trigger order_lines_live after insert or update on public.order_lines for each row execute function public.live_ping_row('store:{store_id}');

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table public.dining_tables enable row level security;
alter table public.orders enable row level security;
alter table public.order_lines enable row level security;

create policy dining_tables_read on public.dining_tables for select to authenticated using (public.can_access_store(org_id, store_id));
create policy dining_tables_insert on public.dining_tables for insert to authenticated
  with check (public.has_permission(org_id, 'menu.edit') and public.can_access_store(org_id, store_id));
create policy dining_tables_update on public.dining_tables for update to authenticated
  using (public.has_permission(org_id, 'menu.edit') and public.can_access_store(org_id, store_id))
  with check (public.has_permission(org_id, 'menu.edit') and public.can_access_store(org_id, store_id));

create policy orders_read on public.orders for select to authenticated using (public.can_access_store(org_id, store_id));
create policy orders_insert on public.orders for insert to authenticated
  with check (public.has_permission(org_id, 'order.create') and public.can_access_store(org_id, store_id));
create policy orders_update on public.orders for update to authenticated
  using (public.has_permission(org_id, 'order.create') and public.can_access_store(org_id, store_id))
  with check (public.has_permission(org_id, 'order.create') and public.can_access_store(org_id, store_id));

create policy order_lines_read on public.order_lines for select to authenticated using (public.can_access_store(org_id, store_id));
create policy order_lines_insert on public.order_lines for insert to authenticated
  with check (public.has_permission(org_id, 'order.create') and public.can_access_store(org_id, store_id));
create policy order_lines_update on public.order_lines for update to authenticated
  using (public.has_permission(org_id, 'order.create') and public.can_access_store(org_id, store_id))
  with check (public.has_permission(org_id, 'order.create') and public.can_access_store(org_id, store_id));

revoke all on public.dining_tables, public.orders, public.order_lines from anon, authenticated;
grant select, insert, update on public.dining_tables, public.orders, public.order_lines to authenticated;
