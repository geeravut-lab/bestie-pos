-- Bestie POS · migration 45 · STOCK and RECIPE COST (modules `stock`, `recipe.cost`).
--
--  * `stock_items`: ingredients / products of a shop in a base unit (g, ml or pcs — whole numbers, never floats), a cost per 1,000 base
--    units (satang), a low-stock level. The quantity on hand is never written directly: it is the sum of `stock_moves`.
--  * `stock_moves`: append-only history — receive (goods in, may update the cost), waste, adjust, count (set to a counted figure) and sale
--    (made by the system when a bill is paid). A trigger keeps `stock_items.quantity` equal to the sum; a guard refuses any other change.
--  * `recipe_lines`: what one portion of a menu item uses. When a bill is PAID (trigger on orders), every non-void line's recipe is deducted
--    once (a unique key makes it safe to replay). Stock may go negative (selling is never blocked); the screen flags it.
--  * Low stock: when an item falls to / below its level the managers are told (in the app and LINE), once per item per day.
--  Needs `menu.edit` to change anything and `menu.edit` or `report.view` to read. Disabling the module hides the screens and keeps the data.
create table public.stock_items (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs (id) on delete cascade,
  store_id      uuid not null references public.stores (id) on delete cascade,
  name          jsonb not null check (jsonb_typeof(name) = 'object' and (name - 'th' - 'en') = '{}'::jsonb
                                      and length(btrim(coalesce(name ->> 'th', ''))) between 1 and 80
                                      and (not name ? 'en' or length(name ->> 'en') <= 80)),
  unit          text not null check (unit in ('g', 'ml', 'pcs')),
  quantity      bigint not null default 0 check (quantity between -1000000000 and 1000000000),
  cost_per_1000 bigint not null default 0 check (cost_per_1000 between 0 and 100000000),   -- satang per 1,000 base units
  low_at        bigint not null default 0 check (low_at between 0 and 1000000000),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index stock_items_store_idx on public.stock_items (store_id) where deleted_at is null;
create trigger stock_items_touch before update on public.stock_items for each row execute function public.touch_updated_at();

create table public.stock_moves (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  item_id     uuid not null references public.stock_items (id),
  kind        text not null check (kind in ('receive', 'waste', 'adjust', 'count', 'sale')),
  qty_delta   bigint not null check (qty_delta between -1000000000 and 1000000000 and qty_delta <> 0),
  cost_per_1000 bigint check (cost_per_1000 is null or cost_per_1000 between 0 and 100000000),
  order_id    uuid references public.orders (id),
  note        text check (note is null or length(note) <= 200),
  created_by  uuid references public.staff (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index stock_moves_item_idx on public.stock_moves (item_id, created_at desc);
create unique index stock_moves_sale_uidx on public.stock_moves (order_id, item_id) where kind = 'sale';

create table public.recipe_lines (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  menu_item_id uuid not null references public.menu_items (id) on delete cascade,
  item_id     uuid not null references public.stock_items (id),
  quantity    bigint not null check (quantity between 1 and 100000000),         -- base units per ONE portion
  unique (menu_item_id, item_id)
);
create index recipe_lines_menu_idx on public.recipe_lines (menu_item_id);

-- ── rights ──
alter table public.stock_items enable row level security;
alter table public.stock_moves enable row level security;
alter table public.recipe_lines enable row level security;
create policy stock_items_read on public.stock_items for select to authenticated
  using (public.can_access_store(org_id, store_id) and (public.has_permission(org_id, 'menu.edit') or public.has_permission(org_id, 'report.view')));
create policy stock_items_write on public.stock_items for all to authenticated
  using (public.can_edit_menu(store_id)) with check (public.can_edit_menu(store_id));
create policy stock_moves_read on public.stock_moves for select to authenticated
  using (public.can_access_store(org_id, store_id) and (public.has_permission(org_id, 'menu.edit') or public.has_permission(org_id, 'report.view')));
create policy recipe_lines_read on public.recipe_lines for select to authenticated
  using (public.can_access_store(org_id, store_id) and (public.has_permission(org_id, 'menu.edit') or public.has_permission(org_id, 'report.view')));
create policy recipe_lines_write on public.recipe_lines for all to authenticated
  using (public.can_edit_menu(store_id)) with check (public.can_edit_menu(store_id));
revoke all on public.stock_items, public.stock_moves, public.recipe_lines from anon, authenticated;
grant select, insert, update, delete on public.stock_items, public.recipe_lines to authenticated;
grant select on public.stock_moves to authenticated;
create trigger stock_items_live after insert or update on public.stock_items for each row execute function public.live_ping_row('store:{store_id}');

-- the quantity on hand is only ever changed by a move
create or replace function public.stock_items_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.quantity := 0;                                           -- starts empty; receive / count to put goods in
  elsif new.quantity is distinct from old.quantity and coalesce(current_setting('bestie.stock', true), '') <> 'on' then
    raise exception 'the quantity changes only through stock moves' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger stock_items_guard_trg before insert or update on public.stock_items for each row execute function public.stock_items_guard();

-- a recipe line must belong to the same shop as its dish and ingredient
create or replace function public.recipe_lines_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.menu_items m where m.id = new.menu_item_id and m.store_id = new.store_id)
     or not exists (select 1 from public.stock_items i where i.id = new.item_id and i.store_id = new.store_id and i.deleted_at is null) then
    raise exception 'the dish and the ingredient must belong to this shop' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger recipe_lines_check_trg before insert or update on public.recipe_lines for each row execute function public.recipe_lines_check();

-- ── moves keep the quantity; history cannot be edited ──
create or replace function public.stock_moves_apply() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  it public.stock_items%rowtype;
  u uuid;
begin
  perform set_config('bestie.stock', 'on', true);
  update public.stock_items set quantity = quantity + new.qty_delta,
         cost_per_1000 = case when new.kind = 'receive' and new.cost_per_1000 is not null then new.cost_per_1000 else cost_per_1000 end
   where id = new.item_id returning * into it;
  perform set_config('bestie.stock', '', true);
  -- low stock: told once per item per day, when it falls to the level
  if new.qty_delta < 0 and it.low_at > 0 and it.quantity <= it.low_at and it.quantity - new.qty_delta > it.low_at then
    for u in select distinct s.user_id from public.staff s join public.roles r on r.id = s.role_id
              where s.org_id = it.org_id and s.active and s.user_id is not null and (s.store_id is null or s.store_id = it.store_id)
                and (r.built_in in ('owner', 'manager') or 'menu.edit' = any (r.permissions)) loop
      perform public.notify_user(jsonb_build_object('user_id', u, 'org_id', it.org_id, 'kind', 'stock.low', 'href', '/stock',
        'dedupe', 'stocklow:' || it.id || ':' || ((now() at time zone 'Asia/Bangkok')::date),
        'title', jsonb_build_object('th', 'สต็อกใกล้หมด: ' || (it.name ->> 'th'), 'en', 'Low stock: ' || coalesce(it.name ->> 'en', it.name ->> 'th')),
        'body', jsonb_build_object('th', 'เหลือต่ำกว่าระดับที่ตั้งไว้ ควรสั่งเพิ่ม', 'en', 'Below the level you set. Time to reorder.')));
    end loop;
  end if;
  return null;
end $$;
create trigger stock_moves_apply_trg after insert on public.stock_moves for each row execute function public.stock_moves_apply();

create or replace function public.stock_moves_frozen() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'stock history cannot be changed' using errcode = '23514';
end $$;
create trigger stock_moves_frozen_trg before update or delete on public.stock_moves for each row execute function public.stock_moves_frozen();

-- ── a person records goods in / waste / a correction / a count ──
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
  if not found or not public.can_edit_menu(it.store_id) then
    raise exception 'stock changes need menu.edit in this shop' using errcode = '42501';
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
    else v_qty - it.quantity end;                      -- count: the figure counted on the shelf
  if v_delta = 0 then return it.quantity; end if;
  if v_kind = 'receive' and v_qty = 0 then raise exception 'receive more than nothing' using errcode = '22023'; end if;
  select s.id into v_staff from public.staff s where s.org_id = it.org_id and s.user_id = auth.uid() and s.active limit 1;
  insert into public.stock_moves (org_id, store_id, item_id, kind, qty_delta, cost_per_1000, note, created_by)
  values (it.org_id, it.store_id, it.id, v_kind, v_delta,
          case when v_kind = 'receive' and (p ->> 'cost_per_1000') ~ '^[0-9]{1,9}$' then (p ->> 'cost_per_1000')::bigint end,
          left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 200), v_staff);
  return (select quantity from public.stock_items where id = it.id);
end $$;
revoke all on function public.stock_move(jsonb) from public, anon;
grant execute on function public.stock_move(jsonb) to authenticated, service_role;

-- ── a paid bill uses up its recipes, once ──
create or replace function public.deduct_stock_for_order() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
    insert into public.stock_moves (org_id, store_id, item_id, kind, qty_delta, order_id)
    select new.org_id, new.store_id, rl.item_id, 'sale', -sum(rl.quantity * l.quantity)::bigint, new.id
      from public.order_lines l
      join public.recipe_lines rl on rl.menu_item_id = l.item_id
      join public.stock_items si on si.id = rl.item_id and si.deleted_at is null
     where l.order_id = new.id and l.status <> 'void' and l.item_id is not null
     group by rl.item_id
    having sum(rl.quantity * l.quantity) > 0
    on conflict (order_id, item_id) where kind = 'sale' do nothing;
  end if;
  return null;
exception when others then
  raise warning 'deduct_stock_for_order failed: %', sqlerrm;   -- a stock problem must never stop a sale from closing
  return null;
end $$;
create trigger orders_deduct_stock_trg after update of status on public.orders for each row execute function public.deduct_stock_for_order();
