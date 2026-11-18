-- Bestie POS · migration 21 · guest ordering from the table QR.
--
-- A guest has no account. The QR on a table carries a long random token; the token is the ONLY thing that lets a
-- phone talk to that table, and only through server functions (service role) — the browser never touches a table
-- directly. Prices, option rules and availability are computed HERE from the shop's own menu; nothing the phone sends
-- is trusted except which items, how many and which options.
--
--  * dining_tables.qr_token        random 128-bit token per table (staff of the shop can read it to print the QR)
--  * stores.qr_auto_send           false (default) = guest lines wait on the bill as unsent lines until staff send them;
--                                   true = they go straight to the kitchen / bar
--  * guest_table / guest_menu / guest_bill / guest_place_order    service_role only
--  * guest_submissions             replay protection (a phone that retries never orders twice) + rate limit

alter table public.dining_tables add column qr_token text;
update public.dining_tables set qr_token = replace(gen_random_uuid()::text, '-', '') where qr_token is null;
alter table public.dining_tables alter column qr_token set not null;
alter table public.dining_tables alter column qr_token set default replace(gen_random_uuid()::text, '-', '');
alter table public.dining_tables add constraint dining_tables_qr_token_len check (length(qr_token) between 24 and 64);
create unique index dining_tables_qr_token_uidx on public.dining_tables (qr_token);

alter table public.stores add column qr_auto_send boolean not null default false;

create table public.guest_submissions (
  id         uuid primary key,
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  table_id   uuid not null references public.dining_tables (id) on delete cascade,
  order_id   uuid not null references public.orders (id) on delete cascade,
  lines      integer not null,
  created_at timestamptz not null default now()
);
create index guest_submissions_table_idx on public.guest_submissions (table_id, created_at desc);
alter table public.guest_submissions enable row level security;
revoke all on public.guest_submissions from anon, authenticated;

-- a staff member rotates a table's QR (a leaked or photographed code stops working at once)
create or replace function public.rotate_table_qr(p_table uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  t public.dining_tables%rowtype;
  v_new text := replace(gen_random_uuid()::text, '-', '');
begin
  select * into t from public.dining_tables where id = p_table and deleted_at is null;
  if not found then raise exception 'table not found' using errcode = 'P0002'; end if;
  if not (public.has_permission(t.org_id, 'menu.edit') and public.can_access_store(t.org_id, t.store_id)) then
    raise exception 'changing tables needs menu.edit' using errcode = '42501';
  end if;
  update public.dining_tables set qr_token = v_new where id = p_table;
  return v_new;
end $$;
revoke all on function public.rotate_table_qr(uuid) from public, anon;
grant execute on function public.rotate_table_qr(uuid) to authenticated, service_role;

-- Is QR ordering on for this shop? Mirrors the module registry entry `order.qr` (default-on profiles + plan tier) plus the owner's
-- explicit switch; packages/core/src/guestSql.test.ts fails if the registry and these two lines ever disagree.
-- registry:order.qr profiles=restaurant,resort plan=pro,resort
create or replace function public.qr_ordering_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
           (select (s.module_overrides ->> 'order.qr')::boolean from public.stores s where s.id = p_store and s.module_overrides ? 'order.qr'),
           (select s.profile in ('restaurant', 'resort') from public.stores s where s.id = p_store), false)
     and coalesce((select s.plan in ('pro', 'resort') from public.stores s where s.id = p_store), false)
$$;
revoke all on function public.qr_ordering_enabled(uuid) from public, anon, authenticated;
grant execute on function public.qr_ordering_enabled(uuid) to service_role;

-- ── what the handler needs to decide "is QR ordering on here" ───────────────
create or replace function public.guest_table(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'table_id', t.id, 'table_name', t.name, 'store_id', s.id, 'org_id', s.org_id, 'store_name', s.name,
    'profile', s.profile, 'plan', s.plan, 'qr_enabled', public.qr_ordering_enabled(s.id), 'auto_send', s.qr_auto_send,
    'vat_registered', s.vat_registered, 'vat_bps', s.vat_bps, 'service_charge_bps', s.service_charge_bps)
  from public.dining_tables t
  join public.stores s on s.id = t.store_id and s.deleted_at is null
  where t.qr_token = p_token and t.deleted_at is null and t.active
$$;
revoke all on function public.guest_table(text) from public, anon, authenticated;
grant execute on function public.guest_table(text) to service_role;

-- ── the menu the guest sees: available items, dine-in prices, option groups with their rules ──
create or replace function public.guest_menu(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with t as (select t.store_id from public.dining_tables t where t.qr_token = p_token and t.deleted_at is null and t.active)
  select jsonb_build_object(
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.sort, c.created_at)
        from public.menu_categories c where c.store_id = (select store_id from t) and c.deleted_at is null and c.active), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
          'id', i.id, 'category_id', i.category_id, 'name', i.name,
          'price', coalesce((i.prices ->> 'dine-in')::int, (i.prices ->> 'base')::int),
          'group_ids', i.modifier_group_ids) order by i.sort, i.created_at)
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

-- ── what is on the table's bill right now (names, quantities, kitchen state; no prices of other people's choices) ──
create or replace function public.guest_bill(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with t as (select t.id, t.store_id from public.dining_tables t where t.qr_token = p_token and t.deleted_at is null and t.active),
  o as (
    select ord.id from public.orders ord
     where ord.table_id = (select id from t) and ord.status not in ('paid', 'void')
     order by ord.created_at limit 1)
  select jsonb_build_object(
    'order_id', (select id from o),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
          'name', l.name, 'quantity', l.quantity, 'status', l.status,
          'amount', l.unit_price::bigint * l.quantity) order by l.created_at)
        from public.order_lines l where l.order_id = (select id from o) and l.status <> 'void'), '[]'::jsonb))
$$;
revoke all on function public.guest_bill(text) from public, anon, authenticated;
grant execute on function public.guest_bill(text) to service_role;

-- ── place an order ─────────────────────────────────────────────────────────
-- p = { token, client_id uuid, lines: [ { item_id, quantity, option_ids: [uuid], note } ] }
-- Returns { order_id, number, lines, status: 'sent' | 'waiting' }. Replaying the same client_id returns the first answer.
create or replace function public.guest_place_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t        public.dining_tables%rowtype;
  s        public.stores%rowtype;
  v_cid    uuid := (p ->> 'client_id')::uuid;
  v_old    public.guest_submissions%rowtype;
  v_order  uuid;
  v_number text;
  v_date   date := (now() at time zone 'Asia/Bangkok')::date;
  v_next   integer;
  v_line   jsonb;
  v_item   public.menu_items%rowtype;
  v_qty    integer;
  v_note   text;
  v_price  integer;
  v_mods   jsonb;
  v_status text;
  v_opt    text;
  g        public.modifier_groups%rowtype;
  o        public.modifier_options%rowtype;
  v_count  integer;
  v_picked integer;
  v_total  integer := 0;
  v_now    timestamptz := now();
begin
  select * into t from public.dining_tables where qr_token = (p ->> 'token') and deleted_at is null and active;
  if not found then raise exception 'unknown table' using errcode = 'P0002'; end if;
  select * into s from public.stores where id = t.store_id and deleted_at is null;
  if not found then raise exception 'unknown table' using errcode = 'P0002'; end if;
  if not public.qr_ordering_enabled(s.id) then raise exception 'ordering from the table is switched off' using errcode = '0A000'; end if;
  if v_cid is null or jsonb_typeof(p -> 'lines') is distinct from 'array' or jsonb_array_length(p -> 'lines') not between 1 and 30 then
    raise exception 'the order is empty or too long' using errcode = '22023';
  end if;

  -- serialise everything that happens at this shop's numbering and this table's bill
  perform pg_advisory_xact_lock(hashtext('guest:' || s.id::text));

  select * into v_old from public.guest_submissions where id = v_cid;
  if found then
    if v_old.table_id <> t.id then raise exception 'unknown table' using errcode = 'P0002'; end if;
    select o2.number into v_number from public.orders o2 where o2.id = v_old.order_id;
    return jsonb_build_object('order_id', v_old.order_id, 'number', v_number, 'lines', v_old.lines,
                              'status', case when s.qr_auto_send then 'sent' else 'waiting' end, 'replay', true);
  end if;

  select count(*) into v_count from public.guest_submissions
   where table_id = t.id and created_at > v_now - interval '10 minutes';
  if v_count >= 12 then raise exception 'too many orders from this table, ask the staff' using errcode = '54000'; end if;

  -- the table's open bill, or a new one (numbers QR001, QR002 … per day; device letters are single letters, so they never clash)
  select ord.id, ord.number into v_order, v_number from public.orders ord
   where ord.table_id = t.id and ord.status not in ('paid', 'void') order by ord.created_at limit 1 for update;
  if v_order is null then
    select coalesce(max(substr(number, 3)::integer), 0) + 1 into v_next from public.orders
     where store_id = s.id and business_date = v_date and number ~ '^QR[0-9]+$';
    v_number := 'QR' || lpad(v_next::text, 3, '0');
    insert into public.orders (org_id, store_id, number, business_date, channel, table_id)
    values (s.org_id, s.id, v_number, v_date, 'dine-in', t.id) returning id into v_order;
  end if;
  if (select count(*) from public.order_lines where order_id = v_order and status <> 'void') + jsonb_array_length(p -> 'lines') > 150 then
    raise exception 'this bill is too long, ask the staff' using errcode = '54000';
  end if;

  v_status := case when s.qr_auto_send then 'sent' else 'new' end;
  for v_line in select * from jsonb_array_elements(p -> 'lines') loop
    if jsonb_typeof(v_line) is distinct from 'object' or (v_line ->> 'quantity') !~ '^[0-9]{1,2}$' then
      raise exception 'bad line' using errcode = '22023';
    end if;
    v_qty := (v_line ->> 'quantity')::integer;
    if v_qty not between 1 and 99 then raise exception 'bad quantity' using errcode = '22023'; end if;
    select * into v_item from public.menu_items i
     where i.id = (v_line ->> 'item_id')::uuid and i.store_id = s.id and i.deleted_at is null and i.available;
    if not found then raise exception 'an item is not available any more' using errcode = '23514'; end if;
    v_note := nullif(btrim(coalesce(v_line ->> 'note', '')), '');
    if v_note is not null then v_note := left(regexp_replace(v_note, '[[:cntrl:]]', ' ', 'g'), 200); end if;

    v_price := coalesce((v_item.prices ->> 'dine-in')::integer, (v_item.prices ->> 'base')::integer);
    v_mods := '[]'::jsonb;
    if jsonb_typeof(v_line -> 'option_ids') is distinct from 'array' and (v_line -> 'option_ids') is not null then
      raise exception 'bad options' using errcode = '22023';
    end if;
    -- every option must belong to a group of THIS item and be live; a group's min / max must hold
    for v_opt in select * from jsonb_array_elements_text(coalesce(v_line -> 'option_ids', '[]'::jsonb)) loop
      select op.* into o from public.modifier_options op
       where op.id = v_opt::uuid and op.store_id = s.id and op.deleted_at is null and op.active
         and op.group_id = any (v_item.modifier_group_ids);
      if not found then raise exception 'an option is not available' using errcode = '23514'; end if;
      v_mods := v_mods || jsonb_build_array(jsonb_build_object(
        'id', o.id, 'name', o.name, 'priceDelta', coalesce((o.channel_delta ->> 'dine-in')::integer, o.price_delta)));
      v_price := v_price + coalesce((o.channel_delta ->> 'dine-in')::integer, o.price_delta);
    end loop;
    if (select count(distinct x) from jsonb_array_elements(v_mods) m, lateral (select m ->> 'id') as d(x)) <> jsonb_array_length(v_mods) then
      raise exception 'an option was chosen twice' using errcode = '23514';
    end if;
    for g in select mg.* from public.modifier_groups mg
              where mg.id = any (v_item.modifier_group_ids) and mg.deleted_at is null loop
      select count(*) into v_picked from jsonb_array_elements(v_mods) m
       where exists (select 1 from public.modifier_options op where op.id = (m ->> 'id')::uuid and op.group_id = g.id);
      if v_picked < g.min_select or v_picked > g.max_select then
        raise exception 'choose the options this dish needs' using errcode = '23514';
      end if;
    end loop;
    if v_price < 0 then v_price := 0; end if;

    insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, modifiers, note, station, status, sent_at)
    values (s.org_id, s.id, v_order, v_item.id, v_item.name, v_price, v_qty, v_mods, v_note, v_item.station, v_status,
            case when v_status = 'sent' then v_now end);
    v_total := v_total + 1;
  end loop;

  insert into public.guest_submissions (id, org_id, store_id, table_id, order_id, lines) values (v_cid, s.org_id, s.id, t.id, v_order, v_total);
  return jsonb_build_object('order_id', v_order, 'number', v_number, 'lines', v_total,
                            'status', case when s.qr_auto_send then 'sent' else 'waiting' end, 'replay', false);
end $$;
revoke all on function public.guest_place_order(jsonb) from public, anon, authenticated;
grant execute on function public.guest_place_order(jsonb) to service_role;
