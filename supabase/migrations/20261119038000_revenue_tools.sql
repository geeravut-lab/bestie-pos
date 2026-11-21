-- Bestie POS · migration 83 · REVENUE TOOLS (owner order, set A of 21 Nov 2026): menu profitability, promotions with a margin guard, upsell rules, KPI report, menu import.
--  * `order_lines.list_price / promo_id`: a promotion lowers the price of lines that are NOT sent yet (the till does it, offline too); the price before the promotion and the promotion are kept
--    on the line so the discount can be reported. Sent lines are history and never change.
--  * `order_lines.ready_at`: when the kitchen marked a line ready (set by a trigger) — the base of preparation-time figures.
--  * `menu_profit_report`, `pair_stats`, `kpi_report`: read-only reports computed from paid bills (Bangkok business days), `report.view`.
--  * `promotions`, `upsell_rules`: shop data written through functions (`menu.edit`, audited). A promotion that would sell an item below its cost (plus the minimum margin) is saved switched OFF
--    and the answer lists the items, unless the owner forces it.
--  * `import_menu`: creates categories and items from a list typed / pasted by the owner (CSV parsed in the browser); the same guards as the menu editor apply.
alter table public.order_lines
  add column list_price integer check (list_price is null or list_price between 0 and 100000000),
  add column promo_id uuid,
  add column ready_at timestamptz;

create or replace function public.order_lines_ready_stamp() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status in ('ready', 'served') and old.status = 'sent' and new.ready_at is null then new.ready_at := now(); end if;
  if new.status = 'served' and old.status = 'sent' and new.ready_at is null then new.ready_at := now(); end if;
  return new;
end $$;
create trigger order_lines_ready before update on public.order_lines for each row execute function public.order_lines_ready_stamp();

-- cost of one portion of a dish: recipe lines × the stock item's cost (satang; null when the dish has no recipe)
create or replace function public.menu_item_cost(p_item uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when count(*) = 0 then null else sum(r.quantity * s.cost_per_1000 / 1000.0) end
    from public.recipe_lines r join public.stock_items s on s.id = r.item_id where r.menu_item_id = p_item
$$;
revoke all on function public.menu_item_cost(uuid) from public, anon;
grant execute on function public.menu_item_cost(uuid) to service_role;

-- ── menu profitability ─────────────────────────────────────────────────────────
-- p = { store_id, from 'YYYY-MM-DD', to 'YYYY-MM-DD' } → [{ item_id, name, qty, revenue, cost_unit|null }]   (report.view)
-- revenue = what was sold before VAT (inclusive prices are divided by the bill's VAT rate); bill-level discounts and the service charge are not spread over items.
create or replace function public.menu_profit_report(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype; v_from date := (p ->> 'from')::date; v_to date := (p ->> 'to')::date;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'report.view')) then
    raise exception 'the profit report needs report.view in this shop' using errcode = '42501';
  end if;
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 366 then raise exception 'bad range' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('item_id', x.item_id, 'name', x.name, 'qty', x.qty, 'revenue', x.revenue, 'cost_unit', public.menu_item_cost(x.item_id)) order by x.revenue desc)
    from (
      select l.item_id, (array_agg(l.name order by l.created_at desc))[1] as name, sum(l.quantity) as qty,
             round(sum(case when r.vat_registered and r.price_mode = 'inclusive' then (l.unit_price::numeric * l.quantity) * 10000 / (10000 + r.vat_bps) else l.unit_price::numeric * l.quantity end)) as revenue
        from public.orders o join public.receipts r on r.order_id = o.id join public.order_lines l on l.order_id = o.id
       where o.store_id = s.id and o.status = 'paid' and o.business_date between v_from and v_to and l.status <> 'void' and l.item_id is not null
       group by l.item_id
    ) x), '[]'::jsonb);
end $$;
revoke all on function public.menu_profit_report(jsonb) from public, anon;
grant execute on function public.menu_profit_report(jsonb) to authenticated, service_role;

-- pairs of dishes bought together: p = { store_id, days (default 60) } → [{ a, b, a_name, b_name, together, a_count }]   (report.view)
create or replace function public.pair_stats(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype; v_days integer := least(greatest(coalesce((p ->> 'days')::integer, 60), 7), 366);
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'report.view')) then
    raise exception 'pair statistics need report.view in this shop' using errcode = '42501';
  end if;
  return coalesce((
    with lines as (
      select distinct l.order_id, l.item_id from public.order_lines l join public.orders o on o.id = l.order_id
       where o.store_id = s.id and o.status = 'paid' and o.business_date >= current_date - v_days and l.status <> 'void' and l.item_id is not null),
    cnt as (select item_id, count(*) as n from lines group by item_id),
    pairs as (select a.item_id as a, b.item_id as b, count(*) as together from lines a join lines b on a.order_id = b.order_id and a.item_id <> b.item_id group by 1, 2 having count(*) >= 3)
    select jsonb_agg(jsonb_build_object('a', pr.a, 'b', pr.b, 'a_name', (select name from public.menu_items where id = pr.a), 'b_name', (select name from public.menu_items where id = pr.b),
                                       'together', pr.together, 'a_count', c.n) order by pr.together desc)
      from (select * from pairs order by together desc limit 40) pr join cnt c on c.item_id = pr.a), '[]'::jsonb);
end $$;
revoke all on function public.pair_stats(jsonb) from public, anon;
grant execute on function public.pair_stats(jsonb) to authenticated, service_role;

-- ── promotions ─────────────────────────────────────────────────────────────────
create table public.promotions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs (id) on delete cascade,
  store_id       uuid not null references public.stores (id) on delete cascade,
  name           text not null check (length(btrim(name)) between 1 and 60),
  code           text check (code is null or code ~ '^[A-Z0-9-]{3,20}$'),
  kind           text not null check (kind in ('percent', 'amount')),
  value          integer not null check (value between 1 and 100000000),          -- percent: basis points (1 = 0.01 %), amount: satang
  scope          text not null default 'bill' check (scope in ('bill', 'item')),
  item_ids       uuid[] not null default '{}' check (cardinality(item_ids) <= 50),
  min_subtotal   bigint not null default 0 check (min_subtotal between 0 and 100000000),
  channels       text[] not null default '{}' check (channels <@ array['dine-in', 'takeaway', 'delivery', 'qr']),
  weekdays       integer[] not null default '{}' check (weekdays <@ array[1, 2, 3, 4, 5, 6, 7]),
  from_time      time,
  to_time        time,
  starts_on      date,
  ends_on        date,
  min_margin_bps integer not null default 0 check (min_margin_bps between 0 and 9000),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  check ((kind = 'percent' and value <= 10000) or kind = 'amount'),
  check ((scope = 'item') = (cardinality(item_ids) > 0)),
  check ((from_time is null) = (to_time is null))
);
create unique index promotions_code_uidx on public.promotions (store_id, code) where code is not null and deleted_at is null;
alter table public.promotions enable row level security;
create policy promotions_read on public.promotions for select to authenticated using (deleted_at is null and public.can_access_store(org_id, store_id));
revoke all on public.promotions from anon, authenticated;
grant select on public.promotions to authenticated;
create trigger promotions_live after insert or update on public.promotions for each row execute function public.live_ping_row('store:{store_id}');

-- p = { store_id, id?, name, code?, kind, value, scope?, item_ids?, min_subtotal?, channels?, weekdays?, from_time?, to_time?, starts_on?, ends_on?, min_margin_bps?, active?, force? } → { id, active, below_margin: [name…] }   (menu.edit)
create or replace function public.save_promotion(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype; v_id uuid := nullif(p ->> 'id', '')::uuid; v_kind text := p ->> 'kind'; v_val integer := (p ->> 'value')::integer;
  v_scope text := coalesce(nullif(p ->> 'scope', ''), 'bill'); v_items uuid[] := coalesce(array(select jsonb_array_elements_text(p -> 'item_ids'))::uuid[], '{}');
  v_margin integer := coalesce((p ->> 'min_margin_bps')::integer, 0); v_active boolean := coalesce((p ->> 'active')::boolean, true);
  v_below text[] := '{}'; i record; v_price numeric; v_cost numeric; v_new numeric;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_edit_menu(s.id) then raise exception 'promotions need menu.edit in this shop' using errcode = '42501'; end if;
  -- margin guard: any dish with a known cost that the promotion would sell below cost + the minimum margin
  for i in select m.id, m.name, (m.prices ->> 'base')::numeric as price from public.menu_items m
            where m.store_id = s.id and m.deleted_at is null and (v_scope = 'bill' or m.id = any (v_items)) loop
    v_cost := public.menu_item_cost(i.id);
    continue when v_cost is null or i.price is null;
    v_new := case when v_kind = 'percent' then i.price * (10000 - v_val) / 10000.0 else i.price - case when v_scope = 'item' then v_val else 0 end end;
    if v_new < v_cost * (10000 + v_margin) / 10000.0 then v_below := v_below || (i.name ->> 'th'); end if;
  end loop;
  if cardinality(v_below) > 0 and not coalesce((p ->> 'force')::boolean, false) then v_active := false; end if;
  if v_id is null then
    insert into public.promotions (org_id, store_id, name, code, kind, value, scope, item_ids, min_subtotal, channels, weekdays, from_time, to_time, starts_on, ends_on, min_margin_bps, active)
    values (s.org_id, s.id, btrim(p ->> 'name'), nullif(upper(btrim(coalesce(p ->> 'code', ''))), ''), v_kind, v_val, v_scope, v_items, coalesce((p ->> 'min_subtotal')::bigint, 0),
            coalesce(array(select jsonb_array_elements_text(p -> 'channels')), '{}'), coalesce(array(select jsonb_array_elements_text(p -> 'weekdays'))::integer[], '{}'),
            nullif(p ->> 'from_time', '')::time, nullif(p ->> 'to_time', '')::time, nullif(p ->> 'starts_on', '')::date, nullif(p ->> 'ends_on', '')::date, v_margin, v_active)
    returning id into v_id;
  else
    update public.promotions set name = btrim(p ->> 'name'), code = nullif(upper(btrim(coalesce(p ->> 'code', ''))), ''), kind = v_kind, value = v_val, scope = v_scope, item_ids = v_items,
           min_subtotal = coalesce((p ->> 'min_subtotal')::bigint, 0), channels = coalesce(array(select jsonb_array_elements_text(p -> 'channels')), '{}'),
           weekdays = coalesce(array(select jsonb_array_elements_text(p -> 'weekdays'))::integer[], '{}'),
           from_time = nullif(p ->> 'from_time', '')::time, to_time = nullif(p ->> 'to_time', '')::time,
           starts_on = nullif(p ->> 'starts_on', '')::date, ends_on = nullif(p ->> 'ends_on', '')::date, min_margin_bps = v_margin, active = v_active, updated_at = now()
     where id = v_id and store_id = s.id and deleted_at is null;
    if not found then raise exception 'unknown promotion' using errcode = '22023'; end if;
  end if;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'promotions', v_id::text, jsonb_build_object('active', v_active, 'below_margin', cardinality(v_below)), 'db');
  return jsonb_build_object('id', v_id, 'active', v_active, 'below_margin', to_jsonb(v_below));
end $$;
revoke all on function public.save_promotion(jsonb) from public, anon;
grant execute on function public.save_promotion(jsonb) to authenticated, service_role;

create or replace function public.delete_promotion(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.promotions%rowtype;
begin
  select * into r from public.promotions where id = p_id and deleted_at is null;
  if not found or not public.can_edit_menu(r.store_id) then raise exception 'promotions need menu.edit in this shop' using errcode = '42501'; end if;
  update public.promotions set deleted_at = now(), active = false where id = r.id;
  perform public.audit_record(r.org_id, r.store_id, 'settings.change', 'promotions', r.id::text, jsonb_build_object('deleted', true), 'db');
end $$;
revoke all on function public.delete_promotion(uuid) from public, anon;
grant execute on function public.delete_promotion(uuid) to authenticated, service_role;

-- what the promotions gave away: p = { store_id, from, to } → [{ promo_id, name, bills, lines, given }]   (report.view)
create or replace function public.promotions_report(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype; v_from date := (p ->> 'from')::date; v_to date := (p ->> 'to')::date;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'report.view')) then
    raise exception 'the promotions report needs report.view in this shop' using errcode = '42501';
  end if;
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 366 then raise exception 'bad range' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('promo_id', g.promo_id, 'name', g.name, 'bills', g.bills, 'lines', g.lines, 'given', g.given) order by g.given desc)
      from (
        select l.promo_id, coalesce(max(pr.name), '—') as name, count(distinct l.order_id) as bills, count(*) as lines, sum((l.list_price - l.unit_price)::bigint * l.quantity) as given
          from public.order_lines l join public.orders o on o.id = l.order_id left join public.promotions pr on pr.id = l.promo_id
         where o.store_id = s.id and o.status = 'paid' and o.business_date between v_from and v_to and l.status <> 'void' and l.promo_id is not null and l.list_price is not null
         group by l.promo_id
      ) g), '[]'::jsonb);
end $$;
revoke all on function public.promotions_report(jsonb) from public, anon;
grant execute on function public.promotions_report(jsonb) to authenticated, service_role;

-- ── upsell rules ───────────────────────────────────────────────────────────────
create table public.upsell_rules (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  item_id     uuid not null references public.menu_items (id) on delete cascade,        -- when this is on the bill …
  suggest_id  uuid not null references public.menu_items (id) on delete cascade,        -- … offer this
  sort        integer not null default 0 check (sort between -1000 and 1000),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (store_id, item_id, suggest_id),
  check (item_id <> suggest_id)
);
alter table public.upsell_rules enable row level security;
create policy upsell_rules_read on public.upsell_rules for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.upsell_rules from anon, authenticated;
grant select on public.upsell_rules to authenticated;
create trigger upsell_rules_live after insert or update or delete on public.upsell_rules for each row execute function public.live_ping_row('store:{store_id}');

-- p = { store_id, item_id, suggest_id, sort?, active? }   (menu.edit; both dishes must belong to the shop)
create or replace function public.save_upsell_rule(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; v_id uuid;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_edit_menu(s.id) then raise exception 'suggestions need menu.edit in this shop' using errcode = '42501'; end if;
  if (select count(*) from public.menu_items where store_id = s.id and deleted_at is null and id in ((p ->> 'item_id')::uuid, (p ->> 'suggest_id')::uuid)) <> 2 then
    raise exception 'both dishes must be on this shop menu' using errcode = '22023';
  end if;
  insert into public.upsell_rules (org_id, store_id, item_id, suggest_id, sort, active)
  values (s.org_id, s.id, (p ->> 'item_id')::uuid, (p ->> 'suggest_id')::uuid, coalesce((p ->> 'sort')::integer, 0), coalesce((p ->> 'active')::boolean, true))
  on conflict (store_id, item_id, suggest_id) do update set sort = excluded.sort, active = excluded.active
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.save_upsell_rule(jsonb) from public, anon;
grant execute on function public.save_upsell_rule(jsonb) to authenticated, service_role;

create or replace function public.delete_upsell_rule(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.upsell_rules%rowtype;
begin
  select * into r from public.upsell_rules where id = p_id;
  if not found or not public.can_edit_menu(r.store_id) then raise exception 'suggestions need menu.edit in this shop' using errcode = '42501'; end if;
  delete from public.upsell_rules where id = r.id;
end $$;
revoke all on function public.delete_upsell_rule(uuid) from public, anon;
grant execute on function public.delete_upsell_rule(uuid) to authenticated, service_role;

-- ── KPI report ────────────────────────────────────────────────────────────────
-- p = { store_id, from, to } → the figures of docs in the owner's KPI table (report.view); each value is null when there is nothing to measure
--   bills, sales (before VAT not taken: receipt net), aov, order_to_kitchen_sec (order opened → first line sent), prep_sec (line sent → ready), waste_cost, stockouts (stock items at or below zero NOW),
--   noshow_rate_bps (no-shows ÷ finished + no-show appointments), repeat_rate_bps (members with ≥ 2 paid bills in the period ÷ members with a paid bill), feedback_resolution_sec
create or replace function public.kpi_report(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype; v_from date := (p ->> 'from')::date; v_to date := (p ->> 'to')::date; r jsonb;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'report.view')) then
    raise exception 'the KPI report needs report.view in this shop' using errcode = '42501';
  end if;
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 366 then raise exception 'bad range' using errcode = '22023'; end if;
  select jsonb_build_object(
    'bills', (select count(*) from public.orders o where o.store_id = s.id and o.status = 'paid' and o.business_date between v_from and v_to),
    'sales', (select coalesce(sum(r2.payable), 0) from public.orders o join public.receipts r2 on r2.order_id = o.id where o.store_id = s.id and o.status = 'paid' and o.business_date between v_from and v_to),
    'order_to_kitchen_sec', (select round(avg(extract(epoch from (f.first_sent - o.created_at)))) from public.orders o
        join lateral (select min(l.sent_at) as first_sent from public.order_lines l where l.order_id = o.id and l.sent_at is not null) f on true
       where o.store_id = s.id and o.status = 'paid' and o.business_date between v_from and v_to and f.first_sent is not null and f.first_sent >= o.created_at and f.first_sent < o.created_at + interval '6 hours'),
    'prep_sec', (select round(avg(extract(epoch from (l.ready_at - l.sent_at)))) from public.order_lines l join public.orders o on o.id = l.order_id
       where o.store_id = s.id and o.business_date between v_from and v_to and l.sent_at is not null and l.ready_at is not null and l.ready_at >= l.sent_at and l.ready_at < l.sent_at + interval '3 hours'),
    'waste_cost', (select coalesce(sum(abs(m.qty_delta) * i.cost_per_1000 / 1000), 0)::bigint from public.stock_moves m join public.stock_items i on i.id = m.item_id
       where m.store_id = s.id and m.kind = 'waste' and (m.created_at at time zone 'Asia/Bangkok')::date between v_from and v_to),
    'stockouts', (select count(*) from public.stock_items i where i.store_id = s.id and i.deleted_at is null and i.active and i.quantity <= 0),
    'noshow_rate_bps', (select case when count(*) = 0 then null else round(10000.0 * count(*) filter (where status = 'no_show') / count(*)) end from public.appointments a
       where a.store_id = s.id and a.status in ('done', 'no_show') and (a.starts_at at time zone 'Asia/Bangkok')::date between v_from and v_to),
    'repeat_rate_bps', (select case when count(*) = 0 then null else round(10000.0 * count(*) filter (where n >= 2) / count(*)) end from (
        select o.customer_id, count(*) as n from public.orders o where o.store_id = s.id and o.status = 'paid' and o.customer_id is not null and o.business_date between v_from and v_to group by o.customer_id) t),
    'feedback_resolution_sec', (select round(avg(extract(epoch from (f.handled_at - f.created_at)))) from public.guest_feedback f
       where f.store_id = s.id and f.handled and f.handled_at is not null and (f.created_at at time zone 'Asia/Bangkok')::date between v_from and v_to)
  ) into r;
  return r;
end $$;
revoke all on function public.kpi_report(jsonb) from public, anon;
grant execute on function public.kpi_report(jsonb) to authenticated, service_role;

-- ── menu import ───────────────────────────────────────────────────────────────
-- p = { store_id, rows: [{ category, name_th, name_en?, price (satang), barcode?, sku?, station? }] } → { categories, items, skipped: [{ row, reason }] }   (menu.edit, at most 500 rows)
-- A row whose name already exists in the category, or whose barcode is already used, is skipped (nothing is overwritten).
create or replace function public.import_menu(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype; e jsonb; n integer := 0; v_cat uuid; v_ncat integer := 0; v_nitem integer := 0; v_skipped jsonb := '[]'::jsonb; v_th text; v_price integer;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_edit_menu(s.id) then raise exception 'importing a menu needs menu.edit in this shop' using errcode = '42501'; end if;
  if jsonb_typeof(p -> 'rows') <> 'array' or jsonb_array_length(p -> 'rows') > 500 then raise exception 'at most 500 rows' using errcode = '22023'; end if;
  for e in select * from jsonb_array_elements(p -> 'rows') loop
    n := n + 1;
    v_th := btrim(coalesce(e ->> 'name_th', ''));
    begin
      v_price := (e ->> 'price')::integer;
      if v_th = '' or length(v_th) > 80 or v_price is null or v_price < 0 or v_price > 100000000 then
        v_skipped := v_skipped || jsonb_build_object('row', n, 'reason', 'invalid'); continue;
      end if;
      select id into v_cat from public.menu_categories where store_id = s.id and deleted_at is null and name ->> 'th' = btrim(coalesce(nullif(e ->> 'category', ''), 'Imported'));
      if v_cat is null then
        insert into public.menu_categories (org_id, store_id, name, sort) values (s.org_id, s.id, jsonb_build_object('th', left(btrim(coalesce(nullif(e ->> 'category', ''), 'Imported')), 60)),
          coalesce((select max(sort) + 1 from public.menu_categories where store_id = s.id), 1)) returning id into v_cat;
        v_ncat := v_ncat + 1;
      end if;
      if exists (select 1 from public.menu_items where store_id = s.id and deleted_at is null and category_id = v_cat and name ->> 'th' = v_th) then
        v_skipped := v_skipped || jsonb_build_object('row', n, 'reason', 'exists'); continue;
      end if;
      insert into public.menu_items (org_id, store_id, category_id, name, prices, station, barcode, sku, sort)
      values (s.org_id, s.id, v_cat,
              case when nullif(btrim(coalesce(e ->> 'name_en', '')), '') is null then jsonb_build_object('th', v_th) else jsonb_build_object('th', v_th, 'en', left(btrim(e ->> 'name_en'), 80)) end,
              jsonb_build_object('base', v_price), nullif(e ->> 'station', ''), nullif(btrim(coalesce(e ->> 'barcode', '')), ''), nullif(btrim(coalesce(e ->> 'sku', '')), ''), n);
      v_nitem := v_nitem + 1;
    exception when others then
      v_skipped := v_skipped || jsonb_build_object('row', n, 'reason', case when sqlstate = '23505' then 'barcode_used' else 'invalid' end);
    end;
  end loop;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'menu.import', s.id::text, jsonb_build_object('items', v_nitem, 'skipped', jsonb_array_length(v_skipped)), 'db');
  return jsonb_build_object('categories', v_ncat, 'items', v_nitem, 'skipped', v_skipped);
end $$;
revoke all on function public.import_menu(jsonb) from public, anon;
grant execute on function public.import_menu(jsonb) to authenticated, service_role;
