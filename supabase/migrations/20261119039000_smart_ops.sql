-- Bestie POS · migration 84 · SMART OPERATIONS (owner order, set B of 21 Nov 2026): stock forecast + suggested purchase orders + supplier prices, waste reasons + lots with expiry + cost alerts,
-- service cases (feedback → case with an answer time), the business manager (insights with evidence and an approve / dismiss step), waiting-time estimate, payment disputes and refunds.
-- Everything here is computed from records the shop already has; nothing is invented. Money is integer satang.

-- ── module: the business manager (proactive insights) ──────────────────────────
do $$
declare r record; src text; dst text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'stores_check_modules' loop
    src := pg_get_functiondef(r.oid);
    dst := replace(src, $a$'guest.concierge'];$a$, $a$'guest.concierge','ai.business_manager'];$a$);
    if dst = src then raise exception 'migration 84: stores_check_modules not changed'; end if;
    execute dst;
  end loop;
end $$;
create or replace function public.business_manager_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stores s where s.id = p_store and s.deleted_at is null and s.plan in ('pro', 'resort')
                    and coalesce((s.module_overrides ->> 'ai.business_manager')::boolean, false))
$$;
revoke all on function public.business_manager_enabled(uuid) from public, anon;
grant execute on function public.business_manager_enabled(uuid) to authenticated, service_role;

-- ── waste reasons ─────────────────────────────────────────────────────────────
alter table public.stock_moves add column reason text check (reason is null or reason in ('expired', 'damaged', 'overproduced', 'spilled', 'returned', 'other'));
do $$
declare r record; src text; dst text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'stock_move' loop
    src := pg_get_functiondef(r.oid);
    dst := replace(src, 'insert into public.stock_moves (org_id, store_id, item_id, kind, qty_delta, cost_per_1000, note, created_by)', 'insert into public.stock_moves (org_id, store_id, item_id, kind, qty_delta, cost_per_1000, note, created_by, reason)');
    dst := replace(dst, $b$left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 200), v_staff);$b$,
      $b$left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 200), v_staff,
          case when v_kind = 'waste' and (p ->> 'reason') in ('expired', 'damaged', 'overproduced', 'spilled', 'returned', 'other') then p ->> 'reason' end);$b$);
    if dst = src or position('created_by, reason)' in dst) = 0 or position('v_staff,' in dst) = 0 then raise exception 'migration 84: stock_move not changed'; end if;
    execute dst;
  end loop;
end $$;

-- p = { store_id, from, to } → { total, by_reason: [{reason, cost, qty}], by_item: [{item_id, name, unit, qty, cost}] }   (stock.view)
create or replace function public.waste_report(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype; v_from date := (p ->> 'from')::date; v_to date := (p ->> 'to')::date;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_view_stock(s.id) then raise exception 'the waste report needs stock.view in this shop' using errcode = '42501'; end if;
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 366 then raise exception 'bad range' using errcode = '22023'; end if;
  return jsonb_build_object(
    'total', coalesce((select sum(abs(m.qty_delta) * i.cost_per_1000 / 1000) from public.stock_moves m join public.stock_items i on i.id = m.item_id
                        where m.store_id = s.id and m.kind = 'waste' and (m.created_at at time zone 'Asia/Bangkok')::date between v_from and v_to), 0)::bigint,
    'by_reason', coalesce((select jsonb_agg(jsonb_build_object('reason', coalesce(x.reason, 'other'), 'cost', x.cost, 'qty', x.n) order by x.cost desc) from (
        select m.reason, sum(abs(m.qty_delta) * i.cost_per_1000 / 1000)::bigint as cost, count(*) as n from public.stock_moves m join public.stock_items i on i.id = m.item_id
         where m.store_id = s.id and m.kind = 'waste' and (m.created_at at time zone 'Asia/Bangkok')::date between v_from and v_to group by m.reason) x), '[]'::jsonb),
    'by_item', coalesce((select jsonb_agg(jsonb_build_object('item_id', x.item_id, 'name', x.name, 'unit', x.unit, 'qty', x.qty, 'cost', x.cost) order by x.cost desc) from (
        select i.id as item_id, i.name, i.unit, sum(abs(m.qty_delta)) as qty, sum(abs(m.qty_delta) * i.cost_per_1000 / 1000)::bigint as cost from public.stock_moves m join public.stock_items i on i.id = m.item_id
         where m.store_id = s.id and m.kind = 'waste' and (m.created_at at time zone 'Asia/Bangkok')::date between v_from and v_to group by i.id, i.name, i.unit order by 5 desc limit 20) x), '[]'::jsonb));
end $$;
revoke all on function public.waste_report(jsonb) from public, anon;
grant execute on function public.waste_report(jsonb) to authenticated, service_role;

-- ── lots with a date of expiry (information kept next to the stock quantity; the quantity itself still moves only through stock moves) ──
create table public.stock_batches (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  item_id    uuid not null references public.stock_items (id) on delete cascade,
  code       text check (code is null or length(code) <= 40),
  qty        bigint not null check (qty between 1 and 1000000000),
  expires_on date not null,
  note       text check (note is null or length(note) <= 100),
  used_at    timestamptz,                                         -- set when the lot is used up or thrown away
  created_at timestamptz not null default now()
);
create index stock_batches_expiry_idx on public.stock_batches (store_id, expires_on) where used_at is null;
alter table public.stock_batches enable row level security;
create policy stock_batches_read on public.stock_batches for select to authenticated using (public.can_view_stock(store_id));
revoke all on public.stock_batches from anon, authenticated;
grant select on public.stock_batches to authenticated;

-- p = { item_id, qty, expires_on, code?, note? }   (stock.manage)
create or replace function public.save_stock_batch(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare it public.stock_items%rowtype; v_id uuid;
begin
  select * into it from public.stock_items where id = (p ->> 'item_id')::uuid and deleted_at is null;
  if not found or not public.can_manage_stock(it.store_id) then raise exception 'lots need stock.manage in this shop' using errcode = '42501'; end if;
  insert into public.stock_batches (org_id, store_id, item_id, code, qty, expires_on, note)
  values (it.org_id, it.store_id, it.id, left(nullif(btrim(coalesce(p ->> 'code', '')), ''), 40), (p ->> 'qty')::bigint, (p ->> 'expires_on')::date, left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 100))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.save_stock_batch(jsonb) from public, anon;
grant execute on function public.save_stock_batch(jsonb) to authenticated, service_role;

create or replace function public.close_stock_batch(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.stock_batches%rowtype;
begin
  select * into b from public.stock_batches where id = p_id;
  if not found or not public.can_manage_stock(b.store_id) then raise exception 'lots need stock.manage in this shop' using errcode = '42501'; end if;
  update public.stock_batches set used_at = coalesce(used_at, now()) where id = b.id;
end $$;
revoke all on function public.close_stock_batch(uuid) from public, anon;
grant execute on function public.close_stock_batch(uuid) to authenticated, service_role;

-- ── forecast, suggested purchase, supplier prices ──────────────────────────────
-- p = { store_id, horizon? (days, default 7), lead? (days to deliver, default 2) } → [{ item_id, name, unit, quantity, low_at, avg_daily, days_left|null, on_order, forecast, suggested, supplier_id|null, supplier_name|null, last_cost }]   (stock.view)
-- avg_daily = what the paid bills used in the last 28 days ÷ 28; the forecast adds the typical use of each coming WEEKDAY (a Saturday looks like past Saturdays) when there are past days for it.
create or replace function public.stock_forecast_core(p_store uuid, p_horizon integer, p_lead integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype; v_h integer := least(greatest(coalesce(p_horizon, 7), 1), 30); v_lead integer := least(greatest(coalesce(p_lead, 2), 0), 30);
begin
  select * into s from public.stores where id = p_store and deleted_at is null;
  if not found then return '[]'::jsonb; end if;
  return coalesce((
    with use_day as (
      select m.item_id, (m.created_at at time zone 'Asia/Bangkok')::date as d, -sum(m.qty_delta) as u from public.stock_moves m
       where m.store_id = s.id and m.kind = 'sale' and (m.created_at at time zone 'Asia/Bangkok')::date between (now() at time zone 'Asia/Bangkok')::date - 28 and (now() at time zone 'Asia/Bangkok')::date - 1 group by 1, 2),
    avg_all as (select item_id, sum(u)::numeric / 28 as a from use_day group by 1),
    avg_dow as (select item_id, extract(isodow from d)::int as dw, avg(u) as a from use_day group by 1, 2),
    horizon as (select g as day_off, extract(isodow from ((now() at time zone 'Asia/Bangkok')::date + g))::int as dw from generate_series(1, v_h + v_lead) g),
    fc as (select i.id as item_id, sum(coalesce(ad.a, aa.a, 0)) as f
             from public.stock_items i join horizon h on true left join avg_all aa on aa.item_id = i.id left join avg_dow ad on ad.item_id = i.id and ad.dw = h.dw
            where i.store_id = s.id group by i.id),
    ord as (select l.item_id, sum(l.qty_ordered - l.qty_received) as o from public.purchase_order_lines l join public.purchase_orders po on po.id = l.po_id
             where po.store_id = s.id and po.status in ('sent', 'partial') and l.qty_ordered > l.qty_received group by 1),
    sup as (select distinct on (l.item_id) l.item_id, po.supplier_id, l.cost_per_1000 from public.purchase_order_lines l join public.purchase_orders po on po.id = l.po_id
             where po.store_id = s.id and po.status <> 'cancelled' order by l.item_id, po.created_at desc)
    select jsonb_agg(jsonb_build_object(
        'item_id', i.id, 'name', i.name, 'unit', i.unit, 'quantity', i.quantity, 'low_at', i.low_at,
        'avg_daily', round(coalesce(aa.a, 0), 1), 'days_left', case when coalesce(aa.a, 0) > 0 then round((i.quantity / aa.a)::numeric, 1) end,
        'on_order', coalesce(o.o, 0), 'forecast', ceil(coalesce(fc.f, 0)),
        'suggested', greatest(0, ceil(coalesce(fc.f, 0) + i.low_at - i.quantity - coalesce(o.o, 0))),
        'supplier_id', sp.supplier_id, 'supplier_name', (select name from public.suppliers where id = sp.supplier_id), 'last_cost', coalesce(sp.cost_per_1000, i.cost_per_1000)
      ) order by case when coalesce(aa.a, 0) > 0 then i.quantity / aa.a else 99999 end)
      from public.stock_items i left join avg_all aa on aa.item_id = i.id left join fc on fc.item_id = i.id left join ord o on o.item_id = i.id left join sup sp on sp.item_id = i.id
     where i.store_id = s.id and i.deleted_at is null and i.active), '[]'::jsonb);
end $$;
revoke all on function public.stock_forecast_core(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.stock_forecast_core(uuid, integer, integer) to service_role;

-- p = { store_id, horizon?, lead? }   (stock.view)
create or replace function public.stock_forecast(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.can_view_stock((p ->> 'store_id')::uuid) then raise exception 'the forecast needs stock.view in this shop' using errcode = '42501'; end if;
  return public.stock_forecast_core((p ->> 'store_id')::uuid, (p ->> 'horizon')::integer, (p ->> 'lead')::integer);
end $$;
revoke all on function public.stock_forecast(jsonb) from public, anon;
grant execute on function public.stock_forecast(jsonb) to authenticated, service_role;

-- the last price of an item at each supplier that delivered it (from purchase orders with goods received): [{ item_id, supplier_id, supplier_name, cost_per_1000, at }]   (stock.view)
create or replace function public.supplier_prices(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_view_stock(s.id) then raise exception 'prices need stock.view in this shop' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('item_id', x.item_id, 'supplier_id', x.supplier_id, 'supplier_name', x.name, 'cost_per_1000', x.cost_per_1000, 'at', x.at) order by x.item_id, x.cost_per_1000)
      from (select distinct on (l.item_id, po.supplier_id) l.item_id, po.supplier_id, sp.name, l.cost_per_1000, coalesce(po.received_at, po.updated_at) as at
              from public.purchase_order_lines l join public.purchase_orders po on po.id = l.po_id join public.suppliers sp on sp.id = po.supplier_id
             where po.store_id = s.id and l.qty_received > 0 order by l.item_id, po.supplier_id, coalesce(po.received_at, po.updated_at) desc) x), '[]'::jsonb);
end $$;
revoke all on function public.supplier_prices(jsonb) from public, anon;
grant execute on function public.supplier_prices(jsonb) to authenticated, service_role;

-- dishes whose cost rose by 10 % or more compared with 30 days ago: [{ item_id, name, price, cost_now, cost_before, margin_bps }]   (report.view)
create or replace function public.cost_alerts(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'report.view')) then raise exception 'cost alerts need report.view in this shop' using errcode = '42501'; end if;
  return coalesce((
    with price_then as (
      select i.id as item_id, coalesce((select m.cost_per_1000 from public.stock_moves m where m.item_id = i.id and m.cost_per_1000 is not null and m.created_at < now() - interval '30 days' order by m.created_at desc limit 1), i.cost_per_1000) as then_cost
        from public.stock_items i where i.store_id = s.id),
    dish as (
      select mi.id, mi.name, (mi.prices ->> 'base')::numeric as price,
             sum(r.quantity * si.cost_per_1000 / 1000.0) as cost_now, sum(r.quantity * pt.then_cost / 1000.0) as cost_before
        from public.menu_items mi join public.recipe_lines r on r.menu_item_id = mi.id join public.stock_items si on si.id = r.item_id join price_then pt on pt.item_id = si.id
       where mi.store_id = s.id and mi.deleted_at is null group by mi.id, mi.name, mi.prices)
    select jsonb_agg(jsonb_build_object('item_id', id, 'name', name, 'price', price, 'cost_now', round(cost_now), 'cost_before', round(cost_before),
                                        'margin_bps', case when price > 0 then round(10000 * (price - cost_now) / price) end) order by (cost_now - cost_before) desc)
      from dish where cost_before > 0 and cost_now >= cost_before * 1.10), '[]'::jsonb);
end $$;
revoke all on function public.cost_alerts(jsonb) from public, anon;
grant execute on function public.cost_alerts(jsonb) to authenticated, service_role;

-- ── service cases ─────────────────────────────────────────────────────────────
create table public.service_cases (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.orgs (id) on delete cascade,
  store_id           uuid not null references public.stores (id) on delete cascade,
  feedback_id        uuid unique references public.guest_feedback (id) on delete set null,
  source             text not null default 'manual' check (source in ('feedback', 'manual')),
  summary            text not null check (length(btrim(summary)) between 1 and 200),
  status             text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  assignee           uuid references public.staff (id) on delete set null,
  sla_min            integer not null default 15 check (sla_min between 1 and 1440),
  created_at         timestamptz not null default now(),
  first_response_at  timestamptz,
  resolved_at        timestamptz,
  resolution         text check (resolution is null or length(resolution) <= 300),
  customer_confirmed boolean,
  escalated_at       timestamptz,
  check ((status = 'resolved') = (resolved_at is not null))
);
create index service_cases_open_idx on public.service_cases (store_id, created_at) where status <> 'resolved';
alter table public.service_cases enable row level security;
create policy service_cases_read on public.service_cases for select to authenticated using (public.can_access_store(org_id, store_id) and (public.has_permission(org_id, 'order.create') or public.has_permission(org_id, 'report.view')));
revoke all on public.service_cases from anon, authenticated;
grant select on public.service_cases to authenticated;
create trigger service_cases_live after insert or update on public.service_cases for each row execute function public.live_ping_row('store:{store_id}');

-- a low rating opens a case by itself
create or replace function public.feedback_opens_case() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.rating <= 2 then
    insert into public.service_cases (org_id, store_id, feedback_id, source, summary)
    values (new.org_id, new.store_id, new.id, 'feedback', left(new.rating || '/5 · ' || new.topic || coalesce(' · ' || nullif(btrim(new.comment), ''), ''), 200)) on conflict do nothing;
  end if;
  return null;
exception when others then
  raise warning 'feedback_opens_case failed: %', sqlerrm;
  return null;
end $$;
create trigger guest_feedback_case after insert on public.guest_feedback for each row execute function public.feedback_opens_case();

create or replace function public.case_staff(p_org uuid) returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.staff where org_id = p_org and user_id = auth.uid() and active limit 1
$$;
revoke all on function public.case_staff(uuid) from public, anon;
grant execute on function public.case_staff(uuid) to authenticated, service_role;

-- p = { store_id, summary, sla_min? }   (order.create)
create or replace function public.open_case(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; v_id uuid;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'order.create')) then raise exception 'cases need order.create in this shop' using errcode = '42501'; end if;
  insert into public.service_cases (org_id, store_id, source, summary, sla_min) values (s.org_id, s.id, 'manual', btrim(p ->> 'summary'), coalesce((p ->> 'sla_min')::integer, 15)) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.open_case(jsonb) from public, anon;
grant execute on function public.open_case(jsonb) to authenticated, service_role;

-- take the case (the first answer stops the clock)
create or replace function public.case_ack(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.service_cases%rowtype;
begin
  select * into c from public.service_cases where id = p_id for update;
  if not found or not (public.can_access_store(c.org_id, c.store_id) and public.has_permission(c.org_id, 'order.create')) then raise exception 'cases need order.create in this shop' using errcode = '42501'; end if;
  if c.status = 'resolved' then raise exception 'the case is already resolved' using errcode = '55000'; end if;
  update public.service_cases set status = 'acknowledged', first_response_at = coalesce(first_response_at, now()), assignee = coalesce(assignee, public.case_staff(c.org_id)) where id = c.id;
end $$;
revoke all on function public.case_ack(uuid) from public, anon;
grant execute on function public.case_ack(uuid) to authenticated, service_role;

-- hand the case to somebody (report.view = a manager)
create or replace function public.case_assign(p_id uuid, p_staff uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.service_cases%rowtype;
begin
  select * into c from public.service_cases where id = p_id for update;
  if not found or not (public.can_access_store(c.org_id, c.store_id) and public.has_permission(c.org_id, 'report.view')) then raise exception 'assigning needs report.view in this shop' using errcode = '42501'; end if;
  if not exists (select 1 from public.staff where id = p_staff and org_id = c.org_id and active) then raise exception 'unknown staff member' using errcode = '22023'; end if;
  update public.service_cases set assignee = p_staff where id = c.id;
end $$;
revoke all on function public.case_assign(uuid, uuid) from public, anon;
grant execute on function public.case_assign(uuid, uuid) to authenticated, service_role;

-- close it with what was done and whether the guest agreed it is fixed (null = not asked)
create or replace function public.case_resolve(p_id uuid, p_note text, p_confirmed boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.service_cases%rowtype;
begin
  select * into c from public.service_cases where id = p_id for update;
  if not found or not (public.can_access_store(c.org_id, c.store_id) and public.has_permission(c.org_id, 'order.create')) then raise exception 'cases need order.create in this shop' using errcode = '42501'; end if;
  if c.status = 'resolved' then return; end if;
  if length(btrim(coalesce(p_note, ''))) = 0 then raise exception 'say what was done' using errcode = '22023'; end if;
  update public.service_cases set status = 'resolved', resolved_at = now(), first_response_at = coalesce(first_response_at, now()), resolution = left(btrim(p_note), 300),
         customer_confirmed = p_confirmed, assignee = coalesce(assignee, public.case_staff(c.org_id)) where id = c.id;
  if c.feedback_id is not null then update public.guest_feedback set handled = true, handled_at = coalesce(handled_at, now()) where id = c.feedback_id; end if;
end $$;
revoke all on function public.case_resolve(uuid, text, boolean) from public, anon;
grant execute on function public.case_resolve(uuid, text, boolean) to authenticated, service_role;

create or replace function public.case_reopen(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.service_cases%rowtype;
begin
  select * into c from public.service_cases where id = p_id for update;
  if not found or not (public.can_access_store(c.org_id, c.store_id) and public.has_permission(c.org_id, 'report.view')) then raise exception 'reopening needs report.view in this shop' using errcode = '42501'; end if;
  update public.service_cases set status = 'acknowledged', resolved_at = null, resolution = null, customer_confirmed = null where id = c.id and status = 'resolved';
end $$;
revoke all on function public.case_reopen(uuid) from public, anon;
grant execute on function public.case_reopen(uuid) to authenticated, service_role;

-- the tick: a case nobody answered within its time tells the managers once (urgent)
create or replace function public.service_cases_escalate() returns integer
language plpgsql security definer set search_path = '' as $$
declare c record; n integer := 0;
begin
  for c in select * from public.service_cases where status = 'open' and first_response_at is null and escalated_at is null and created_at < now() - make_interval(mins => sla_min) loop
    update public.service_cases set escalated_at = now() where id = c.id;
    perform public.notify_managers(c.org_id, c.store_id, jsonb_build_object('kind', 'guest.case_overdue', 'href', '/cases', 'dedupe', 'case:' || c.id, 'urgent', true,
      'title', jsonb_build_object('th', 'มีเรื่องร้องเรียนที่ยังไม่มีใครรับ เกิน ' || c.sla_min || ' นาที', 'en', 'A complaint nobody has answered for over ' || c.sla_min || ' minutes'),
      'body', jsonb_build_object('th', left(c.summary, 120), 'en', left(c.summary, 120))));
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.service_cases_escalate() from public, anon, authenticated;
grant execute on function public.service_cases_escalate() to service_role;

-- answer times of the cases of a period: { cases, answered, avg_first_response_sec, avg_resolution_sec, confirmed, late }   (report.view)
create or replace function public.case_kpi(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype; v_from date := (p ->> 'from')::date; v_to date := (p ->> 'to')::date;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'report.view')) then raise exception 'case figures need report.view in this shop' using errcode = '42501'; end if;
  return (select jsonb_build_object('cases', count(*), 'answered', count(first_response_at),
            'avg_first_response_sec', round(avg(extract(epoch from (first_response_at - created_at)))), 'avg_resolution_sec', round(avg(extract(epoch from (resolved_at - created_at)))),
            'confirmed', count(*) filter (where customer_confirmed), 'late', count(*) filter (where escalated_at is not null))
            from public.service_cases c where c.store_id = s.id and (c.created_at at time zone 'Asia/Bangkok')::date between v_from and v_to);
end $$;
revoke all on function public.case_kpi(jsonb) from public, anon;
grant execute on function public.case_kpi(jsonb) to authenticated, service_role;

-- ── waiting-time estimate for a guest (service role, by the table's token) ────────
-- average preparation time of lines of the same station in the last 14 days, scaled by how many lines are still waiting ahead
create or replace function public.guest_eta(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.dining_tables%rowtype; v_bill uuid; v_waiting integer; v_avg numeric; v_ahead integer;
begin
  select * into t from public.dining_tables where qr_token = p_token and deleted_at is null;
  if not found then return jsonb_build_object('ok', false); end if;
  select id into v_bill from public.orders where table_id = t.id and status not in ('paid', 'void') order by created_at desc limit 1;
  if v_bill is null then return jsonb_build_object('ok', true, 'minutes', null, 'waiting', 0); end if;
  select count(*) into v_waiting from public.order_lines where order_id = v_bill and status = 'sent';
  if v_waiting = 0 then return jsonb_build_object('ok', true, 'minutes', null, 'waiting', 0); end if;
  select avg(extract(epoch from (l.ready_at - l.sent_at))) into v_avg from public.order_lines l
   where l.store_id = t.store_id and l.sent_at > now() - interval '14 days' and l.ready_at is not null and l.ready_at >= l.sent_at and l.ready_at < l.sent_at + interval '3 hours';
  select count(*) into v_ahead from public.order_lines l where l.store_id = t.store_id and l.status = 'sent' and l.order_id <> v_bill and l.sent_at < (select min(sent_at) from public.order_lines where order_id = v_bill and status = 'sent');
  if v_avg is null then return jsonb_build_object('ok', true, 'minutes', null, 'waiting', v_waiting); end if;
  -- the average already contains the usual queue; add a little for lines far ahead of this table (never more than +50 %)
  return jsonb_build_object('ok', true, 'waiting', v_waiting, 'minutes', greatest(1, ceil((v_avg * (1 + least(0.5, v_ahead / 40.0))) / 60.0)));
end $$;
revoke all on function public.guest_eta(text) from public, anon, authenticated;
grant execute on function public.guest_eta(text) to service_role;

-- ── insights of the business manager ───────────────────────────────────────────
create table public.business_insights (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  kind       text not null check (kind in ('low_stock', 'thin_margin', 'sales_drop', 'waste_high', 'expiring', 'cases_overdue', 'cost_rise')),
  severity   text not null default 'info' check (severity in ('info', 'watch', 'act')),
  evidence   jsonb not null default '{}'::jsonb,
  action     jsonb,                                             -- what "approve" would do: { type: 'draft_po', items: [{ item_id, supplier_id, qty, cost_per_1000 }] }
  status     text not null default 'new' check (status in ('new', 'approved', 'dismissed')),
  dedupe     text not null,
  decided_by uuid references public.staff (id) on delete set null,
  decided_at timestamptz,
  note       text check (note is null or length(note) <= 200),
  created_at timestamptz not null default now(),
  unique (store_id, dedupe)
);
create index business_insights_new_idx on public.business_insights (store_id, created_at desc);
alter table public.business_insights enable row level security;
create policy business_insights_read on public.business_insights for select to authenticated using (public.can_access_store(org_id, store_id) and public.has_permission(org_id, 'report.view'));
revoke all on public.business_insights from anon, authenticated;
grant select on public.business_insights to authenticated;
create trigger business_insights_live after insert or update on public.business_insights for each row execute function public.live_ping_row('store:{store_id}');

-- the daily look (tick, service role; only shops with the module on): rules over the shop's own figures; each finding is kept once per day
create or replace function public.generate_insights(p_store uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype; v_today date := (now() at time zone 'Asia/Bangkok')::date; n integer := 0; v_ev jsonb; v_fc jsonb; v_yday bigint; v_avg numeric; v_cnt integer; v_sales bigint; v_waste bigint;
begin
  select * into s from public.stores where id = p_store and deleted_at is null;
  if not found or not public.business_manager_enabled(s.id) then return 0; end if;
  -- 1. stock that runs out within 3 days at the usual use
  select jsonb_agg(jsonb_build_object('item_id', e ->> 'item_id', 'name', e -> 'name', 'unit', e ->> 'unit', 'quantity', e -> 'quantity', 'days_left', e -> 'days_left', 'suggested', e -> 'suggested',
                                      'supplier_id', e -> 'supplier_id', 'cost_per_1000', e -> 'last_cost'))
    into v_ev from jsonb_array_elements(public.stock_forecast_core(s.id, 7, 2)) e where (e ->> 'days_left') is not null and (e ->> 'days_left')::numeric < 3 and (e ->> 'suggested')::bigint > 0;
  if v_ev is not null then
    insert into public.business_insights (org_id, store_id, kind, severity, evidence, action, dedupe)
    values (s.org_id, s.id, 'low_stock', 'act', jsonb_build_object('items', v_ev),
            jsonb_build_object('type', 'draft_po', 'items', (select jsonb_agg(jsonb_build_object('item_id', x ->> 'item_id', 'supplier_id', x -> 'supplier_id', 'qty', (x ->> 'suggested')::bigint, 'cost_per_1000', coalesce((x ->> 'cost_per_1000')::bigint, 0))) from jsonb_array_elements(v_ev) x where x -> 'supplier_id' <> 'null'::jsonb)),
            'low_stock:' || v_today) on conflict do nothing;
    if found then n := n + 1; end if;
  end if;
  -- 2. dishes sold in the last 30 days whose recipe leaves less than 30 % of the price
  select jsonb_agg(jsonb_build_object('item_id', x.item_id, 'name', x.name, 'price', x.price, 'cost', round(x.cost), 'margin_bps', round(10000 * (x.price - x.cost) / x.price)))
    into v_ev from (
      select mi.id as item_id, mi.name, (mi.prices ->> 'base')::numeric as price, sum(r.quantity * si.cost_per_1000 / 1000.0) as cost
        from public.menu_items mi join public.recipe_lines r on r.menu_item_id = mi.id join public.stock_items si on si.id = r.item_id
       where mi.store_id = s.id and mi.deleted_at is null and (mi.prices ->> 'base')::numeric > 0
         and exists (select 1 from public.order_lines l join public.orders o on o.id = l.order_id where l.item_id = mi.id and o.status = 'paid' and o.business_date >= v_today - 30 and l.status <> 'void')
       group by mi.id, mi.name, mi.prices) x where x.price > 0 and (x.price - x.cost) / x.price < 0.30;
  if v_ev is not null then
    insert into public.business_insights (org_id, store_id, kind, severity, evidence, dedupe) values (s.org_id, s.id, 'thin_margin', 'watch', jsonb_build_object('items', v_ev), 'thin_margin:' || to_char(v_today, 'IYYY-IW')) on conflict do nothing;
    if found then n := n + 1; end if;
  end if;
  -- 3. yesterday's sales far below the same weekday of the 4 weeks before
  select coalesce(sum(r.payable), 0) into v_yday from public.orders o join public.receipts r on r.order_id = o.id where o.store_id = s.id and o.status = 'paid' and o.business_date = v_today - 1;
  select avg(d.t), count(*) into v_avg, v_cnt from (
    select o.business_date, sum(r.payable) as t from public.orders o join public.receipts r on r.order_id = o.id
     where o.store_id = s.id and o.status = 'paid' and o.business_date in (v_today - 8, v_today - 15, v_today - 22, v_today - 29) group by o.business_date) d;
  if v_cnt >= 3 and v_avg > 0 and v_yday < v_avg * 0.7 then
    insert into public.business_insights (org_id, store_id, kind, severity, evidence, dedupe)
    values (s.org_id, s.id, 'sales_drop', 'watch', jsonb_build_object('yesterday', v_yday, 'usual', round(v_avg), 'weeks', v_cnt), 'sales_drop:' || v_today) on conflict do nothing;
    if found then n := n + 1; end if;
  end if;
  -- 4. waste above 5 % of the sales of the last 7 days
  select coalesce(sum(r.payable), 0) into v_sales from public.orders o join public.receipts r on r.order_id = o.id where o.store_id = s.id and o.status = 'paid' and o.business_date > v_today - 8;
  select coalesce(sum(abs(m.qty_delta) * i.cost_per_1000 / 1000), 0)::bigint into v_waste from public.stock_moves m join public.stock_items i on i.id = m.item_id where m.store_id = s.id and m.kind = 'waste' and m.created_at > now() - interval '7 days';
  if v_sales > 0 and v_waste * 20 > v_sales then
    insert into public.business_insights (org_id, store_id, kind, severity, evidence, dedupe) values (s.org_id, s.id, 'waste_high', 'watch', jsonb_build_object('waste', v_waste, 'sales', v_sales), 'waste_high:' || to_char(v_today, 'IYYY-IW')) on conflict do nothing;
    if found then n := n + 1; end if;
  end if;
  -- 5. lots that expire within 3 days
  select jsonb_agg(jsonb_build_object('item', (select name from public.stock_items where id = b.item_id), 'qty', b.qty, 'expires_on', b.expires_on, 'code', b.code)) into v_ev
    from public.stock_batches b where b.store_id = s.id and b.used_at is null and b.expires_on <= v_today + 3;
  if v_ev is not null then
    insert into public.business_insights (org_id, store_id, kind, severity, evidence, dedupe) values (s.org_id, s.id, 'expiring', 'act', jsonb_build_object('lots', v_ev), 'expiring:' || v_today) on conflict do nothing;
    if found then n := n + 1; end if;
  end if;
  -- 6. complaints nobody has answered in time
  select count(*) into v_cnt from public.service_cases where store_id = s.id and status = 'open' and first_response_at is null and created_at < now() - make_interval(mins => sla_min);
  if v_cnt > 0 then
    insert into public.business_insights (org_id, store_id, kind, severity, evidence, dedupe) values (s.org_id, s.id, 'cases_overdue', 'act', jsonb_build_object('cases', v_cnt), 'cases_overdue:' || v_today) on conflict do nothing;
    if found then n := n + 1; end if;
  end if;
  return n;
end $$;
revoke all on function public.generate_insights(uuid) from public, anon, authenticated;
grant execute on function public.generate_insights(uuid) to service_role;

-- all shops with the module on (the tick)
create or replace function public.generate_insights_all() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n integer := 0;
begin
  for r in select id from public.stores where deleted_at is null and plan in ('pro', 'resort') and coalesce((module_overrides ->> 'ai.business_manager')::boolean, false) loop
    n := n + public.generate_insights(r.id);
  end loop;
  return n;
end $$;
revoke all on function public.generate_insights_all() from public, anon, authenticated;
grant execute on function public.generate_insights_all() to service_role;

-- approve (do what the proposal says, if it can be done) or dismiss; report.view to dismiss, stock.manage to approve a purchase draft
create or replace function public.decide_insight(p_id uuid, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.business_insights%rowtype; v_made jsonb := '[]'::jsonb; r record; v_po uuid; v_staff uuid;
begin
  select * into i from public.business_insights where id = p_id for update;
  if not found or not (public.can_access_store(i.org_id, i.store_id) and public.has_permission(i.org_id, 'report.view')) then raise exception 'insights need report.view in this shop' using errcode = '42501'; end if;
  if p_decision not in ('approved', 'dismissed') then raise exception 'unknown decision' using errcode = '22023'; end if;
  if i.status <> 'new' then return jsonb_build_object('status', i.status, 'purchase_orders', v_made); end if;
  if p_decision = 'approved' and i.action ->> 'type' = 'draft_po' then
    if not public.can_manage_stock(i.store_id) then raise exception 'a purchase draft needs stock.manage in this shop' using errcode = '42501'; end if;
    for r in select (x ->> 'supplier_id')::uuid as supplier_id,
                    jsonb_agg(jsonb_build_object('item_id', x ->> 'item_id', 'quantity', (x ->> 'qty')::bigint, 'cost_per_1000', coalesce((x ->> 'cost_per_1000')::bigint, 0))) as lines
               from jsonb_array_elements(coalesce(i.action -> 'items', '[]'::jsonb)) x where x ->> 'supplier_id' is not null group by 1 loop
      v_po := public.save_purchase_order(jsonb_build_object('store_id', i.store_id, 'supplier_id', r.supplier_id, 'note', 'Business manager: low stock', 'lines', r.lines));
      v_made := v_made || to_jsonb(v_po);
    end loop;
  end if;
  v_staff := public.case_staff(i.org_id);
  update public.business_insights set status = p_decision, decided_by = v_staff, decided_at = now(), note = left(btrim(coalesce(p_note, '')), 200) where id = i.id;
  perform public.audit_record(i.org_id, i.store_id, 'settings.change', 'business_insights', i.id::text, jsonb_build_object('decision', p_decision, 'kind', i.kind), 'db');
  return jsonb_build_object('status', p_decision, 'purchase_orders', v_made);
end $$;
revoke all on function public.decide_insight(uuid, text, text) from public, anon;
grant execute on function public.decide_insight(uuid, text, text) to authenticated, service_role;

-- what the page and the morning brief read (report.view): the open findings and the figures they come from
create or replace function public.brief_context(p_store uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype;
begin
  select * into s from public.stores where id = p_store and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'report.view') and public.business_manager_enabled(s.id)) then
    raise exception 'the business manager needs report.view and the module in this shop' using errcode = '42501';
  end if;
  return jsonb_build_object('org_id', s.org_id, 'store_id', s.id, 'insights', coalesce((
    select jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'severity', i.severity, 'evidence', i.evidence, 'action', i.action, 'status', i.status, 'created_at', i.created_at) order by i.created_at desc)
      from (select * from public.business_insights where store_id = s.id order by created_at desc limit 30) i), '[]'::jsonb));
end $$;
revoke all on function public.brief_context(uuid) from public, anon;
grant execute on function public.brief_context(uuid) to authenticated, service_role;

-- ── payment disputes and provider refunds ──────────────────────────────────────
create table public.payment_disputes (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs (id) on delete cascade,
  store_id     uuid references public.stores (id) on delete set null,
  order_id     uuid references public.orders (id),
  provider     text not null,
  dispute_ref  text not null,
  payment_ref  text,
  amount       bigint not null check (amount >= 0),
  currency     text not null default 'thb',
  reason       text check (reason is null or length(reason) <= 60),
  status       text not null check (length(status) <= 40),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (provider, dispute_ref)
);
alter table public.payment_disputes enable row level security;
create policy payment_disputes_read on public.payment_disputes for select to authenticated using (store_id is not null and public.can_access_store(org_id, store_id) and public.has_permission(org_id, 'refund.create'));
revoke all on public.payment_disputes from anon, authenticated;
grant select on public.payment_disputes to authenticated;

-- the webhook tells us a dispute opened or changed (service role); the managers hear of a new one at once
create or replace function public.record_payment_dispute(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare a public.payment_attempts%rowtype; v_new boolean := false; v_id uuid;
begin
  select * into a from public.payment_attempts where provider_ref = p ->> 'payment_ref' limit 1;
  insert into public.payment_disputes (org_id, store_id, order_id, provider, dispute_ref, payment_ref, amount, currency, reason, status)
  values (coalesce(a.org_id, (select org_id from public.stores limit 0)), a.store_id, a.order_id, coalesce(p ->> 'provider', 'stripe'), p ->> 'dispute_ref', p ->> 'payment_ref', coalesce((p ->> 'amount')::bigint, 0), lower(coalesce(p ->> 'currency', 'thb')), left(p ->> 'reason', 60), left(coalesce(p ->> 'status', 'open'), 40))
  on conflict (provider, dispute_ref) do update set status = excluded.status, updated_at = now()
  returning id, (xmax = 0) into v_id, v_new;
  if v_new and a.id is not null then
    perform public.notify_managers(a.org_id, a.store_id, jsonb_build_object('kind', 'payment.dispute', 'href', '/reconcile', 'dedupe', 'dispute:' || v_id, 'urgent', true,
      'title', jsonb_build_object('th', 'ลูกค้าโต้แย้งรายการชำระเงิน (chargeback)', 'en', 'A customer disputed a payment (chargeback)'),
      'body', jsonb_build_object('th', 'ตอบกลับผู้ให้บริการชำระเงินภายในเวลาที่กำหนด', 'en', 'Answer the payment provider before its deadline')));
  end if;
  return v_new;
exception when not_null_violation then
  return false;   -- a dispute for a payment Bestie does not know (no organisation to show it to)
end $$;
revoke all on function public.record_payment_dispute(jsonb) from public, anon, authenticated;
grant execute on function public.record_payment_dispute(jsonb) to service_role;

create table public.provider_refunds (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  order_id    uuid not null references public.orders (id),
  attempt_id  uuid references public.payment_attempts (id),
  provider    text not null,
  refund_ref  text not null,
  amount      bigint not null check (amount > 0),
  reason      text check (reason is null or length(reason) <= 100),
  created_by  uuid references public.staff (id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (provider, refund_ref)
);
alter table public.provider_refunds enable row level security;
create policy provider_refunds_read on public.provider_refunds for select to authenticated using (public.can_access_store(org_id, store_id) and public.has_permission(org_id, 'refund.create'));
revoke all on public.provider_refunds from anon, authenticated;
grant select on public.provider_refunds to authenticated;

-- before the server calls the provider: may this person refund this much of this bill? → { provider, provider_ref, attempt_id, max, number } (refund.create, the money must have gone through the provider)
create or replace function public.refund_context(p_order uuid, p_amount bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.orders%rowtype; a public.payment_attempts%rowtype; v_done bigint;
begin
  select * into o from public.orders where id = p_order;
  if not found or o.status <> 'paid' or not (public.can_access_store(o.org_id, o.store_id) and public.has_permission(o.org_id, 'refund.create')) then raise exception 'refunds need refund.create in this shop' using errcode = '42501'; end if;
  select * into a from public.payment_attempts where order_id = o.id and status = 'succeeded' and provider_ref is not null order by created_at desc limit 1;
  if not found then raise exception 'this bill was not paid through a payment provider' using errcode = '55000'; end if;
  select coalesce(sum(amount), 0) into v_done from public.provider_refunds where order_id = o.id;
  if p_amount is null or p_amount < 1 or p_amount > a.amount - v_done then raise exception 'the amount is more than is left to refund' using errcode = '22023'; end if;
  return jsonb_build_object('provider', a.provider, 'provider_ref', a.provider_ref, 'attempt_id', a.id, 'max', a.amount - v_done, 'count', (select count(*) from public.provider_refunds where order_id = o.id));
end $$;
revoke all on function public.refund_context(uuid, bigint) from public, anon;
grant execute on function public.refund_context(uuid, bigint) to authenticated, service_role;

-- after the provider accepted it: keep the record (refund.create); a repeat of the same refund id changes nothing
create or replace function public.record_provider_refund(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.orders%rowtype; v_id uuid;
begin
  select * into o from public.orders where id = (p ->> 'order_id')::uuid;
  if not found or not (public.can_access_store(o.org_id, o.store_id) and public.has_permission(o.org_id, 'refund.create')) then raise exception 'refunds need refund.create in this shop' using errcode = '42501'; end if;
  insert into public.provider_refunds (org_id, store_id, order_id, attempt_id, provider, refund_ref, amount, reason, created_by)
  values (o.org_id, o.store_id, o.id, nullif(p ->> 'attempt_id', '')::uuid, p ->> 'provider', p ->> 'refund_ref', (p ->> 'amount')::bigint, left(p ->> 'reason', 100), public.case_staff(o.org_id))
  on conflict (provider, refund_ref) do nothing returning id into v_id;
  if v_id is not null then perform public.audit_record(o.org_id, o.store_id, 'payment.refund', 'provider_refunds', v_id::text, jsonb_build_object('amount', (p ->> 'amount')::bigint, 'via', 'api'), 'db'); end if;
  return v_id;
end $$;
revoke all on function public.record_provider_refund(jsonb) from public, anon;
grant execute on function public.record_provider_refund(jsonb) to authenticated, service_role;

-- what Bestie believes was paid through the provider in a period (for the reconciliation) (report.view): [{ provider_ref, amount, order_number, created_at, status }] + disputes + refunds
create or replace function public.reconcile_rows(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype; v_from timestamptz := (p ->> 'from')::timestamptz; v_to timestamptz := (p ->> 'to')::timestamptz;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'report.view')) then raise exception 'reconciliation needs report.view in this shop' using errcode = '42501'; end if;
  if v_from is null or v_to is null or v_to <= v_from or v_to - v_from > interval '92 days' then raise exception 'bad range' using errcode = '22023'; end if;
  return jsonb_build_object(
    'attempts', coalesce((select jsonb_agg(jsonb_build_object('provider', a.provider, 'provider_ref', a.provider_ref, 'amount', a.amount, 'status', a.status, 'created_at', a.created_at,
                                         'order_number', (select number from public.orders where id = a.order_id)) order by a.created_at)
                             from public.payment_attempts a where a.store_id = s.id and a.provider_ref is not null and a.created_at >= v_from and a.created_at < v_to), '[]'::jsonb),
    'disputes', coalesce((select jsonb_agg(jsonb_build_object('dispute_ref', d.dispute_ref, 'payment_ref', d.payment_ref, 'amount', d.amount, 'reason', d.reason, 'status', d.status, 'created_at', d.created_at) order by d.created_at desc)
                             from public.payment_disputes d where d.store_id = s.id and public.has_permission(s.org_id, 'refund.create')), '[]'::jsonb),
    'refunds', coalesce((select jsonb_agg(jsonb_build_object('refund_ref', r.refund_ref, 'amount', r.amount, 'order_number', (select number from public.orders where id = r.order_id), 'created_at', r.created_at) order by r.created_at desc)
                             from public.provider_refunds r where r.store_id = s.id and r.created_at >= v_from and r.created_at < v_to), '[]'::jsonb));
end $$;
revoke all on function public.reconcile_rows(jsonb) from public, anon;
grant execute on function public.reconcile_rows(jsonb) to authenticated, service_role;
