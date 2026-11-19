-- Bestie POS · migration 48 · STOCK v2 (module `stock`).
--
--  * Own permissions: `stock.manage` (change stock, recipes, suppliers, orders, transfers) and `stock.view` (look). Until now `menu.edit` /
--    `report.view` did this; every role that had `menu.edit` gets `stock.manage`, every role with `menu.edit` or `report.view` gets
--    `stock.view`, so nobody loses a screen. The owner always passes (the permission helper treats the built-in owner as holding all).
--  * Barcode on a stock item (unique per shop) so a scanner that types the code finds the item.
--  * Suppliers and PURCHASE ORDERS (draft → sent → partial → received, or cancelled); receiving books `receive` moves (cost updated) and may
--    be partial. Every order has a shop number PO-0001….
--  * TRANSFERS between shops of the SAME organisation: sending takes the goods out of the source at once (`transfer_out`), the other shop
--    receives them (`transfer_in`; a matching item is found by name + unit or created), a sent transfer can be cancelled by either side
--    until it is received (`transfer_back` puts the goods back).
--  * Options that use stock (`modifier_option_stock`): choosing "oat milk" can use 150 ml of oat milk AND cancel the dish recipe's dairy
--    milk (`instead_of`). A paid bill deducts recipe + options in one move per ingredient (still once, still never blocks a sale).
--  Everything is append-only history on `stock_moves`; the quantity on hand still changes only through a move.

-- ── permissions ──
create or replace function public.known_permissions() returns text[]
language sql immutable set search_path = '' as $$
  select array['order.create','order.void','order.discount','price.override','refund.create','payment.take','drawer.open',
               'shift.open_close','menu.edit','staff.manage','module.toggle','report.view','customer.view','credit.adjust',
               'audit.view','settings.manage','kds.use','stock.manage','stock.view']::text[]
$$;

update public.roles set permissions = array_append(permissions, 'stock.manage')
 where 'menu.edit' = any (permissions) and not ('stock.manage' = any (permissions));
update public.roles set permissions = array_append(permissions, 'stock.view')
 where ('menu.edit' = any (permissions) or 'report.view' = any (permissions)) and not ('stock.view' = any (permissions));

create or replace function public.roles_defaults() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.built_in in ('manager', 'cashier') and not ('drawer.open' = any (new.permissions)) then
    new.permissions := array_append(new.permissions, 'drawer.open');
  end if;
  if new.built_in = 'manager' then
    if not ('stock.manage' = any (new.permissions)) then new.permissions := array_append(new.permissions, 'stock.manage'); end if;
    if not ('stock.view' = any (new.permissions)) then new.permissions := array_append(new.permissions, 'stock.view'); end if;
  end if;
  return new;
end $$;

create or replace function public.can_manage_stock(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stores s
                  where s.id = p_store and s.deleted_at is null
                    and public.has_permission(s.org_id, 'stock.manage') and public.can_access_store(s.org_id, s.id))
$$;
create or replace function public.can_view_stock(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stores s
                  where s.id = p_store and s.deleted_at is null and public.can_access_store(s.org_id, s.id)
                    and (public.has_permission(s.org_id, 'stock.manage') or public.has_permission(s.org_id, 'stock.view')))
$$;
revoke all on function public.can_manage_stock(uuid), public.can_view_stock(uuid) from public, anon;
grant execute on function public.can_manage_stock(uuid), public.can_view_stock(uuid) to authenticated, service_role;

-- the v1 policies used menu.edit / report.view
drop policy stock_items_read on public.stock_items;
drop policy stock_items_write on public.stock_items;
drop policy stock_moves_read on public.stock_moves;
drop policy recipe_lines_read on public.recipe_lines;
drop policy recipe_lines_write on public.recipe_lines;
create policy stock_items_read on public.stock_items for select to authenticated using (public.can_view_stock(store_id));
create policy stock_items_write on public.stock_items for all to authenticated
  using (public.can_manage_stock(store_id)) with check (public.can_manage_stock(store_id));
create policy stock_moves_read on public.stock_moves for select to authenticated using (public.can_view_stock(store_id));
create policy recipe_lines_read on public.recipe_lines for select to authenticated using (public.can_view_stock(store_id));
create policy recipe_lines_write on public.recipe_lines for all to authenticated
  using (public.can_manage_stock(store_id)) with check (public.can_manage_stock(store_id));

-- ── barcode ──
alter table public.stock_items add column barcode text check (barcode is null or barcode ~ '^[0-9A-Za-z-]{4,40}$');
create unique index stock_items_barcode_uidx on public.stock_items (store_id, barcode) where barcode is not null and deleted_at is null;

-- ── more kinds of move, and where they came from ──
alter table public.stock_moves drop constraint stock_moves_kind_check;
alter table public.stock_moves add constraint stock_moves_kind_check
  check (kind in ('receive', 'waste', 'adjust', 'count', 'sale', 'transfer_out', 'transfer_in', 'transfer_back'));

-- ── suppliers ──
create table public.suppliers (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 80),
  phone      text check (phone is null or length(phone) <= 30),
  note       text check (note is null or length(note) <= 200),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index suppliers_store_idx on public.suppliers (store_id) where deleted_at is null;
create trigger suppliers_touch before update on public.suppliers for each row execute function public.touch_updated_at();

-- ── purchase orders ──
create table public.purchase_orders (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  supplier_id uuid not null references public.suppliers (id),
  number      text not null check (number ~ '^PO-[0-9]{4,}$'),
  status      text not null default 'draft' check (status in ('draft', 'sent', 'partial', 'received', 'cancelled')),
  note        text check (note is null or length(note) <= 200),
  expected_on date,
  created_by  uuid references public.staff (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  received_at timestamptz,
  unique (store_id, number)
);
create index purchase_orders_store_idx on public.purchase_orders (store_id, created_at desc);
create trigger purchase_orders_touch before update on public.purchase_orders for each row execute function public.touch_updated_at();

create table public.purchase_order_lines (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs (id) on delete cascade,
  store_id      uuid not null references public.stores (id) on delete cascade,
  po_id         uuid not null references public.purchase_orders (id) on delete cascade,
  item_id       uuid not null references public.stock_items (id),
  qty_ordered   bigint not null check (qty_ordered between 1 and 1000000000),
  qty_received  bigint not null default 0 check (qty_received between 0 and 2000000000),
  cost_per_1000 bigint not null default 0 check (cost_per_1000 between 0 and 100000000),   -- the price agreed, satang per 1,000 base units
  unique (po_id, item_id)
);
create index purchase_order_lines_po_idx on public.purchase_order_lines (po_id);

-- ── transfers between shops of one organisation ──
create table public.stock_transfers (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs (id) on delete cascade,
  from_store_id uuid not null references public.stores (id),
  to_store_id   uuid not null references public.stores (id),
  number        text not null check (number ~ '^TR-[0-9]{4,}$'),
  status        text not null default 'sent' check (status in ('sent', 'received', 'cancelled')),
  note          text check (note is null or length(note) <= 200),
  created_by    uuid references public.staff (id) on delete set null,
  created_at    timestamptz not null default now(),
  closed_at     timestamptz,
  check (from_store_id <> to_store_id),
  unique (org_id, number)
);
create index stock_transfers_from_idx on public.stock_transfers (from_store_id, created_at desc);
create index stock_transfers_to_idx on public.stock_transfers (to_store_id, created_at desc);

create table public.stock_transfer_lines (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs (id) on delete cascade,
  transfer_id   uuid not null references public.stock_transfers (id) on delete cascade,
  from_item_id  uuid not null references public.stock_items (id),
  to_item_id    uuid references public.stock_items (id),        -- filled when the other shop receives
  quantity      bigint not null check (quantity between 1 and 1000000000),
  cost_per_1000 bigint not null default 0 check (cost_per_1000 between 0 and 100000000),
  unique (transfer_id, from_item_id)
);
create index stock_transfer_lines_idx on public.stock_transfer_lines (transfer_id);

alter table public.stock_moves add column po_id uuid references public.purchase_orders (id);
alter table public.stock_moves add column transfer_id uuid references public.stock_transfers (id);

-- ── options that use stock ──
create table public.modifier_option_stock (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  option_id   uuid not null references public.modifier_options (id) on delete cascade,
  item_id     uuid not null references public.stock_items (id),
  quantity    bigint not null check (quantity between 1 and 100000000),      -- base units per ONE time the option is chosen on ONE portion
  instead_of  uuid references public.stock_items (id),                       -- cancels this ingredient in the dish's recipe (oat milk instead of milk)
  unique (option_id, item_id)
);
create index modifier_option_stock_option_idx on public.modifier_option_stock (option_id);

create or replace function public.modifier_option_stock_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.modifier_options o where o.id = new.option_id and o.store_id = new.store_id)
     or not exists (select 1 from public.stock_items i where i.id = new.item_id and i.store_id = new.store_id and i.deleted_at is null)
     or (new.instead_of is not null and not exists (select 1 from public.stock_items i where i.id = new.instead_of and i.store_id = new.store_id)) then
    raise exception 'the option and the ingredients must belong to this shop' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger modifier_option_stock_check_trg before insert or update on public.modifier_option_stock
  for each row execute function public.modifier_option_stock_check();

-- ── rights ──
alter table public.suppliers enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.stock_transfers enable row level security;
alter table public.stock_transfer_lines enable row level security;
alter table public.modifier_option_stock enable row level security;
create policy suppliers_read on public.suppliers for select to authenticated using (public.can_view_stock(store_id));
create policy suppliers_write on public.suppliers for all to authenticated
  using (public.can_manage_stock(store_id)) with check (public.can_manage_stock(store_id));
create policy purchase_orders_read on public.purchase_orders for select to authenticated using (public.can_view_stock(store_id));
create policy purchase_order_lines_read on public.purchase_order_lines for select to authenticated using (public.can_view_stock(store_id));
create policy stock_transfers_read on public.stock_transfers for select to authenticated
  using (public.can_view_stock(from_store_id) or public.can_view_stock(to_store_id));
create policy stock_transfer_lines_read on public.stock_transfer_lines for select to authenticated
  using (exists (select 1 from public.stock_transfers t where t.id = transfer_id
                   and (public.can_view_stock(t.from_store_id) or public.can_view_stock(t.to_store_id))));
create policy modifier_option_stock_read on public.modifier_option_stock for select to authenticated using (public.can_view_stock(store_id));
create policy modifier_option_stock_write on public.modifier_option_stock for all to authenticated
  using (public.can_manage_stock(store_id)) with check (public.can_manage_stock(store_id));
revoke all on public.suppliers, public.purchase_orders, public.purchase_order_lines, public.stock_transfers,
  public.stock_transfer_lines, public.modifier_option_stock from anon, authenticated;
grant select, insert, update, delete on public.suppliers, public.modifier_option_stock to authenticated;
grant select on public.purchase_orders, public.purchase_order_lines, public.stock_transfers, public.stock_transfer_lines to authenticated;
-- orders and transfers change only through the functions below
create trigger purchase_orders_live after insert or update on public.purchase_orders for each row execute function public.live_ping_row('store:{store_id}');

-- ── the move function and the low-stock notice use the stock permission now ──
create or replace function public.stock_move(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  it public.stock_items%rowtype;
  v_kind text := p ->> 'kind';
  v_qty bigint;
  v_delta bigint;
  v_staff uuid;
begin
  select * into it from public.stock_items where id = (p ->> 'item_id')::uuid and deleted_at is null for update;
  if not found or not public.can_manage_stock(it.store_id) then
    raise exception 'stock changes need stock.manage in this shop' using errcode = '42501';
  end if;
  if v_kind not in ('receive', 'waste', 'adjust', 'count') then raise exception 'unknown kind' using errcode = '22023'; end if;
  if jsonb_typeof(p -> 'quantity') is distinct from 'number' or (p ->> 'quantity') !~ '^-?[0-9]{1,10}$' then
    raise exception 'the quantity must be a whole number' using errcode = '22023';
  end if;
  v_qty := (p ->> 'quantity')::bigint;
  v_delta := case v_kind
    when 'receive' then abs(v_qty)
    when 'waste'   then -abs(v_qty)
    when 'adjust'  then v_qty
    else v_qty - it.quantity end;
  if v_delta = 0 then return it.quantity; end if;
  if v_kind = 'receive' and v_qty = 0 then raise exception 'receive more than nothing' using errcode = '22023'; end if;
  select s.id into v_staff from public.staff s where s.org_id = it.org_id and s.user_id = auth.uid() and s.active limit 1;
  insert into public.stock_moves (org_id, store_id, item_id, kind, qty_delta, cost_per_1000, note, created_by)
  values (it.org_id, it.store_id, it.id, v_kind, v_delta,
          case when v_kind = 'receive' and (p ->> 'cost_per_1000') ~ '^[0-9]{1,9}$' then (p ->> 'cost_per_1000')::bigint end,
          left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 200), v_staff);
  return (select quantity from public.stock_items where id = it.id);
end $$;

create or replace function public.stock_moves_apply() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  it public.stock_items%rowtype;
  u uuid;
begin
  perform set_config('bestie.stock', 'on', true);
  update public.stock_items set quantity = quantity + new.qty_delta,
         cost_per_1000 = case when new.kind in ('receive', 'transfer_in') and new.cost_per_1000 is not null then new.cost_per_1000 else cost_per_1000 end
   where id = new.item_id returning * into it;
  perform set_config('bestie.stock', '', true);
  if new.qty_delta < 0 and it.low_at > 0 and it.quantity <= it.low_at and it.quantity - new.qty_delta > it.low_at then
    for u in select distinct s.user_id from public.staff s join public.roles r on r.id = s.role_id
              where s.org_id = it.org_id and s.active and s.user_id is not null and (s.store_id is null or s.store_id = it.store_id)
                and (r.built_in in ('owner', 'manager') or 'stock.manage' = any (r.permissions)) loop
      perform public.notify_user(jsonb_build_object('user_id', u, 'org_id', it.org_id, 'kind', 'stock.low', 'href', '/stock',
        'dedupe', 'stocklow:' || it.id || ':' || ((now() at time zone 'Asia/Bangkok')::date),
        'title', jsonb_build_object('th', 'สต็อกใกล้หมด: ' || (it.name ->> 'th'), 'en', 'Low stock: ' || coalesce(it.name ->> 'en', it.name ->> 'th')),
        'body', jsonb_build_object('th', 'เหลือต่ำกว่าระดับที่ตั้งไว้ ควรสั่งเพิ่ม', 'en', 'Below the level you set. Time to reorder.')));
    end loop;
  end if;
  return null;
end $$;

-- ── purchase orders ──
-- p = { id?, store_id, supplier_id, note?, expected_on?, lines: [{ item_id, quantity, cost_per_1000 }] }; an existing id must still be a draft
create or replace function public.save_purchase_order(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_store uuid := (p ->> 'store_id')::uuid;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  s public.stores%rowtype;
  v_no integer;
  l jsonb;
  v_staff uuid;
begin
  if not public.can_manage_stock(v_store) then raise exception 'purchase orders need stock.manage' using errcode = '42501'; end if;
  select * into s from public.stores where id = v_store for update;
  if jsonb_typeof(p -> 'lines') is distinct from 'array' or jsonb_array_length(p -> 'lines') not between 1 and 100 then
    raise exception 'an order needs 1 to 100 lines' using errcode = '22023';
  end if;
  if not exists (select 1 from public.suppliers x where x.id = (p ->> 'supplier_id')::uuid and x.store_id = v_store and x.deleted_at is null) then
    raise exception 'unknown supplier' using errcode = '22023';
  end if;
  select st.id into v_staff from public.staff st where st.org_id = s.org_id and st.user_id = auth.uid() and st.active limit 1;
  if v_id is null then
    select coalesce(max(substr(number, 4)::integer), 0) + 1 into v_no from public.purchase_orders where store_id = v_store;
    insert into public.purchase_orders (org_id, store_id, supplier_id, number, note, expected_on, created_by)
    values (s.org_id, v_store, (p ->> 'supplier_id')::uuid, 'PO-' || lpad(v_no::text, 4, '0'),
            left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 200), nullif(p ->> 'expected_on', '')::date, v_staff)
    returning id into v_id;
  else
    update public.purchase_orders
       set supplier_id = (p ->> 'supplier_id')::uuid, note = left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 200),
           expected_on = nullif(p ->> 'expected_on', '')::date
     where id = v_id and store_id = v_store and status = 'draft';
    if not found then raise exception 'only a draft order can be changed' using errcode = '55000'; end if;
    delete from public.purchase_order_lines where po_id = v_id;
  end if;
  for l in select * from jsonb_array_elements(p -> 'lines') loop
    if not exists (select 1 from public.stock_items i where i.id = (l ->> 'item_id')::uuid and i.store_id = v_store and i.deleted_at is null) then
      raise exception 'unknown item' using errcode = '22023';
    end if;
    insert into public.purchase_order_lines (org_id, store_id, po_id, item_id, qty_ordered, cost_per_1000)
    values (s.org_id, v_store, v_id, (l ->> 'item_id')::uuid, (l ->> 'quantity')::bigint, coalesce(nullif(l ->> 'cost_per_1000', '')::bigint, 0));
  end loop;
  return v_id;
end $$;

-- draft → sent; draft / sent → cancelled (nothing received yet)
create or replace function public.set_purchase_order_status(p_po uuid, p_status text) returns text
language plpgsql security definer set search_path = '' as $$
declare po public.purchase_orders%rowtype;
begin
  select * into po from public.purchase_orders where id = p_po for update;
  if not found or not public.can_manage_stock(po.store_id) then raise exception 'purchase orders need stock.manage' using errcode = '42501'; end if;
  if p_status = 'sent' and po.status = 'draft' then null;
  elsif p_status = 'cancelled' and po.status in ('draft', 'sent')
        and not exists (select 1 from public.purchase_order_lines x where x.po_id = po.id and x.qty_received > 0) then null;
  else raise exception 'that change is not allowed from %', po.status using errcode = '55000'; end if;
  update public.purchase_orders set status = p_status where id = po.id;
  return p_status;
end $$;

-- p = { po_id, lines: [{ line_id, quantity, cost_per_1000? }] } — goods in against an order; may be partial; may exceed what was ordered
create or replace function public.receive_purchase_order(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  po public.purchase_orders%rowtype;
  l jsonb;
  pl public.purchase_order_lines%rowtype;
  v_qty bigint;
  v_cost bigint;
  v_staff uuid;
  v_open integer;
  v_any boolean := false;
begin
  select * into po from public.purchase_orders where id = (p ->> 'po_id')::uuid for update;
  if not found or not public.can_manage_stock(po.store_id) then raise exception 'purchase orders need stock.manage' using errcode = '42501'; end if;
  if po.status not in ('draft', 'sent', 'partial') then raise exception 'this order cannot receive goods' using errcode = '55000'; end if;
  select st.id into v_staff from public.staff st where st.org_id = po.org_id and st.user_id = auth.uid() and st.active limit 1;
  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    v_qty := coalesce(nullif(l ->> 'quantity', '')::bigint, 0);
    if v_qty <= 0 then continue; end if;
    select * into pl from public.purchase_order_lines where id = (l ->> 'line_id')::uuid and po_id = po.id for update;
    if not found then raise exception 'unknown line' using errcode = '22023'; end if;
    v_cost := coalesce(nullif(l ->> 'cost_per_1000', '')::bigint, pl.cost_per_1000);
    update public.purchase_order_lines set qty_received = qty_received + v_qty where id = pl.id;
    insert into public.stock_moves (org_id, store_id, item_id, kind, qty_delta, cost_per_1000, po_id, note, created_by)
    values (po.org_id, po.store_id, pl.item_id, 'receive', v_qty, v_cost, po.id, po.number, v_staff);
    v_any := true;
  end loop;
  if not v_any then raise exception 'nothing to receive' using errcode = '22023'; end if;
  select count(*) into v_open from public.purchase_order_lines where po_id = po.id and qty_received < qty_ordered;
  update public.purchase_orders set status = case when v_open = 0 then 'received' else 'partial' end,
         received_at = case when v_open = 0 then now() else received_at end
   where id = po.id;
  return case when v_open = 0 then 'received' else 'partial' end;
end $$;

-- ── transfers ──
-- p = { from_store_id, to_store_id, note?, lines: [{ item_id, quantity }] }
create or replace function public.send_stock_transfer(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_from uuid := (p ->> 'from_store_id')::uuid;
  v_to uuid := (p ->> 'to_store_id')::uuid;
  sf public.stores%rowtype;
  v_org uuid;
  v_no integer;
  v_id uuid;
  l jsonb;
  it public.stock_items%rowtype;
  v_qty bigint;
  v_staff uuid;
begin
  if v_from = v_to then raise exception 'choose another shop' using errcode = '22023'; end if;
  if not public.can_manage_stock(v_from) then raise exception 'transfers need stock.manage in the sending shop' using errcode = '42501'; end if;
  select * into sf from public.stores where id = v_from;
  select org_id into v_org from public.stores where id = v_to and deleted_at is null;
  if v_org is distinct from sf.org_id then raise exception 'transfers stay inside one organisation' using errcode = '42501'; end if;
  if jsonb_typeof(p -> 'lines') is distinct from 'array' or jsonb_array_length(p -> 'lines') not between 1 and 100 then
    raise exception 'a transfer needs 1 to 100 lines' using errcode = '22023';
  end if;
  perform 1 from public.orgs where id = sf.org_id for update;
  select coalesce(max(substr(number, 4)::integer), 0) + 1 into v_no from public.stock_transfers where org_id = sf.org_id;
  select st.id into v_staff from public.staff st where st.org_id = sf.org_id and st.user_id = auth.uid() and st.active limit 1;
  insert into public.stock_transfers (org_id, from_store_id, to_store_id, number, note, created_by)
  values (sf.org_id, v_from, v_to, 'TR-' || lpad(v_no::text, 4, '0'), left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 200), v_staff)
  returning id into v_id;
  for l in select * from jsonb_array_elements(p -> 'lines') loop
    v_qty := (l ->> 'quantity')::bigint;
    if v_qty is null or v_qty <= 0 then raise exception 'quantity must be above zero' using errcode = '22023'; end if;
    select * into it from public.stock_items where id = (l ->> 'item_id')::uuid and store_id = v_from and deleted_at is null for update;
    if not found then raise exception 'unknown item' using errcode = '22023'; end if;
    if it.quantity < v_qty then raise exception 'not enough on hand' using errcode = '22023'; end if;    -- goods that are not there cannot be sent
    insert into public.stock_transfer_lines (org_id, transfer_id, from_item_id, quantity, cost_per_1000)
    values (sf.org_id, v_id, it.id, v_qty, it.cost_per_1000);
    insert into public.stock_moves (org_id, store_id, item_id, kind, qty_delta, transfer_id, note, created_by)
    values (sf.org_id, v_from, it.id, 'transfer_out', -v_qty, v_id, 'TR-' || lpad(v_no::text, 4, '0'), v_staff);
  end loop;
  return v_id;
end $$;

-- p = { transfer_id, mapping?: [{ line_id, to_item_id }] } — the receiving shop; unmatched items are matched by name + unit or created
create or replace function public.receive_stock_transfer(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  t public.stock_transfers%rowtype;
  tl public.stock_transfer_lines%rowtype;
  src public.stock_items%rowtype;
  v_to uuid;
  v_map text;
  v_staff uuid;
  n integer := 0;
begin
  select * into t from public.stock_transfers where id = (p ->> 'transfer_id')::uuid for update;
  if not found or not public.can_manage_stock(t.to_store_id) then raise exception 'receiving needs stock.manage in the receiving shop' using errcode = '42501'; end if;
  if t.status <> 'sent' then raise exception 'this transfer is already %', t.status using errcode = '55000'; end if;
  select st.id into v_staff from public.staff st where st.org_id = t.org_id and st.user_id = auth.uid() and st.active limit 1;
  for tl in select * from public.stock_transfer_lines where transfer_id = t.id loop
    select * into src from public.stock_items where id = tl.from_item_id;
    v_to := null;
    select m ->> 'to_item_id' into v_map from jsonb_array_elements(coalesce(p -> 'mapping', '[]'::jsonb)) m where m ->> 'line_id' = tl.id::text limit 1;
    if v_map is not null then
      select id into v_to from public.stock_items where id = v_map::uuid and store_id = t.to_store_id and deleted_at is null and unit = src.unit;
      if v_to is null then raise exception 'the chosen item does not fit' using errcode = '22023'; end if;
    else
      select id into v_to from public.stock_items
       where store_id = t.to_store_id and deleted_at is null and unit = src.unit and lower(name ->> 'th') = lower(src.name ->> 'th') limit 1;
    end if;
    if v_to is null then
      insert into public.stock_items (org_id, store_id, name, unit, cost_per_1000, low_at)
      values (t.org_id, t.to_store_id, src.name, src.unit, tl.cost_per_1000, 0) returning id into v_to;
    end if;
    update public.stock_transfer_lines set to_item_id = v_to where id = tl.id;
    insert into public.stock_moves (org_id, store_id, item_id, kind, qty_delta, cost_per_1000, transfer_id, note, created_by)
    values (t.org_id, t.to_store_id, v_to, 'transfer_in', tl.quantity, tl.cost_per_1000, t.id, t.number, v_staff);
    n := n + 1;
  end loop;
  update public.stock_transfers set status = 'received', closed_at = now() where id = t.id;
  return n;
end $$;

-- either side may call a sent transfer off; the goods go back to the sender
create or replace function public.cancel_stock_transfer(p_transfer uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.stock_transfers%rowtype;
  tl public.stock_transfer_lines%rowtype;
  v_staff uuid;
begin
  select * into t from public.stock_transfers where id = p_transfer for update;
  if not found or not (public.can_manage_stock(t.from_store_id) or public.can_manage_stock(t.to_store_id)) then
    raise exception 'transfers need stock.manage' using errcode = '42501';
  end if;
  if t.status <> 'sent' then raise exception 'this transfer is already %', t.status using errcode = '55000'; end if;
  select st.id into v_staff from public.staff st where st.org_id = t.org_id and st.user_id = auth.uid() and st.active limit 1;
  for tl in select * from public.stock_transfer_lines where transfer_id = t.id loop
    insert into public.stock_moves (org_id, store_id, item_id, kind, qty_delta, transfer_id, note, created_by)
    values (t.org_id, t.from_store_id, tl.from_item_id, 'transfer_back', tl.quantity, t.id, t.number, v_staff);
  end loop;
  update public.stock_transfers set status = 'cancelled', closed_at = now() where id = t.id;
end $$;

revoke all on function public.save_purchase_order(jsonb), public.set_purchase_order_status(uuid, text), public.receive_purchase_order(jsonb),
  public.send_stock_transfer(jsonb), public.receive_stock_transfer(jsonb), public.cancel_stock_transfer(uuid) from public, anon;
grant execute on function public.save_purchase_order(jsonb), public.set_purchase_order_status(uuid, text), public.receive_purchase_order(jsonb),
  public.send_stock_transfer(jsonb), public.receive_stock_transfer(jsonb), public.cancel_stock_transfer(uuid) to authenticated, service_role;
revoke all on function public.stock_move(jsonb) from public, anon;
grant execute on function public.stock_move(jsonb) to authenticated, service_role;

-- ── a paid bill uses up recipes AND chosen options, once per ingredient ──
create or replace function public.deduct_stock_for_order() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
    insert into public.stock_moves (org_id, store_id, item_id, kind, qty_delta, order_id)
    select new.org_id, new.store_id, u.item_id, 'sale', -sum(u.q)::bigint, new.id
      from (
        -- the dish's recipe, except an ingredient an option on that line stands in for
        select rl.item_id, rl.quantity * l.quantity as q
          from public.order_lines l
          join public.recipe_lines rl on rl.menu_item_id = l.item_id
         where l.order_id = new.id and l.status <> 'void' and l.item_id is not null
           and not exists (
             select 1 from jsonb_array_elements(case when jsonb_typeof(l.modifiers) = 'array' then l.modifiers else '[]'::jsonb end) m
               join public.modifier_option_stock mos on mos.option_id::text = m ->> 'id'
              where mos.instead_of = rl.item_id)
        union all
        -- what each chosen option uses
        select mos.item_id, mos.quantity * l.quantity as q
          from public.order_lines l
          cross join lateral jsonb_array_elements(case when jsonb_typeof(l.modifiers) = 'array' then l.modifiers else '[]'::jsonb end) m
          join public.modifier_option_stock mos on mos.option_id::text = m ->> 'id'
         where l.order_id = new.id and l.status <> 'void' and l.item_id is not null
      ) u
      join public.stock_items si on si.id = u.item_id and si.deleted_at is null
     group by u.item_id
    having sum(u.q) > 0
    on conflict (order_id, item_id) where kind = 'sale' do nothing;
  end if;
  return null;
exception when others then
  raise warning 'deduct_stock_for_order failed: %', sqlerrm;
  return null;
end $$;
