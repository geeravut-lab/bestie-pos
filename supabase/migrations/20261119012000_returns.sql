-- Bestie POS · migration 57 · product returns (Retail profile; works for every profile).
--
-- A RETURN is history, like a receipt: it never edits or deletes the original bill. It records which lines (and how many units)
-- came back, how much money goes back, and by which route:
--   * cash    — paid out of the till's drawer (the shift's expected cash goes down by it),
--   * credit  — back onto the customer's Bestie Credit (only for a bill that was paid with Credit, a member on the bill);
--               booked as an `adjust` row so the ledger stays append-only and Credit still has no cash-out,
--   * manual  — PromptPay / card: the refund is made by hand in the PSP dashboard and only RECORDED here
--               (Bestie has no refund-by-API yet; the same rule as given-up PromptPay shares).
-- A route can never refund more than that route took on the bill (cash ≤ cash paid, credit ≤ Credit paid, manual ≤ PromptPay +
-- card paid, each minus what was already returned that way). One route per return; a mixed refund needs two returns.
--
-- THE AMOUNT is computed here, never typed: the receipt's payable × (value of the units returned so far ÷ value of all lines),
-- cumulative, so the sum of several partial returns is exact and returning everything refunds exactly what was paid (rounding,
-- service charge, VAT and discounts come back in proportion). The points discount a member used is NOT given back in v1.
-- POINTS: the points the bill earned are taken back in proportion (`reverse_earn`, never below the balance).
-- STOCK: lines marked "back on the shelf" add the recipe / option quantities back (`return` moves); a damaged item is not restocked.
-- Needs `refund.create` (manager / owner). Online only: the server decides, so a till cannot invent a refund while offline.

alter table public.stock_moves drop constraint stock_moves_kind_check;
alter table public.stock_moves add constraint stock_moves_kind_check
  check (kind in ('receive', 'waste', 'adjust', 'count', 'sale', 'transfer_out', 'transfer_in', 'transfer_back', 'return'));

create table public.order_returns (
  id            uuid primary key,                       -- client-made: a repeated request returns the first answer
  org_id        uuid not null references public.orgs (id) on delete cascade,
  store_id      uuid not null references public.stores (id) on delete cascade,
  order_id      uuid not null references public.orders (id),
  receipt_id    uuid not null references public.receipts (id),
  number        text not null check (number ~ '^RT-[0-9]{4,9}$'),
  device_id     uuid references public.devices (id),
  staff_id      uuid references public.staff (id),
  customer_id   uuid references public.customers (id),
  refund_method text not null check (refund_method in ('cash', 'credit', 'manual')),
  amount        bigint not null check (amount >= 0 and amount <= 100000000),   -- satang paid back
  reason        text not null check (reason in ('wrong_item', 'defective', 'changed_mind', 'other')),
  note          text check (length(note) <= 200),
  points_reversed integer not null default 0 check (points_reversed >= 0),
  created_at    timestamptz not null default now(),
  unique (store_id, number)
);
create index order_returns_order_idx on public.order_returns (order_id);
create index order_returns_store_day_idx on public.order_returns (store_id, created_at);
create index order_returns_device_cash_idx on public.order_returns (device_id, created_at) where refund_method = 'cash';

create table public.order_return_lines (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs (id) on delete cascade,
  store_id      uuid not null references public.stores (id) on delete cascade,
  return_id     uuid not null references public.order_returns (id),
  order_id      uuid not null references public.orders (id),
  order_line_id uuid not null references public.order_lines (id),
  item_id       uuid references public.menu_items (id),
  name          jsonb not null,
  unit_price    integer not null check (unit_price >= 0),
  quantity      integer not null check (quantity between 1 and 99),
  restocked     boolean not null default false
);
create index order_return_lines_line_idx on public.order_return_lines (order_line_id);
create index order_return_lines_return_idx on public.order_return_lines (return_id);

create or replace function public.returns_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'returns are history and cannot be changed' using errcode = '23514';
end $$;
create trigger order_returns_append_only before update or delete on public.order_returns for each row execute function public.returns_append_only();
create trigger order_return_lines_append_only before update or delete on public.order_return_lines for each row execute function public.returns_append_only();

alter table public.order_returns enable row level security;
alter table public.order_return_lines enable row level security;
create policy order_returns_read on public.order_returns for select to authenticated using (public.can_access_store(org_id, store_id));
create policy order_return_lines_read on public.order_return_lines for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.order_returns, public.order_return_lines from anon, authenticated;
grant select on public.order_returns, public.order_return_lines to authenticated;   -- writes: create_return() only

-- ── the return ──
-- p = { id, order_id, device_id?, staff_id?, reason, note?, refund_method, lines: [{ order_line_id, quantity, restock? }] }
create or replace function public.create_return(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id     uuid := nullif(p ->> 'id', '')::uuid;
  o        public.orders%rowtype;
  r        public.receipts%rowtype;
  st       public.stores%rowtype;
  old      public.order_returns%rowtype;
  v_method text := p ->> 'refund_method';
  v_reason text := p ->> 'reason';
  v_dev    uuid := nullif(p ->> 'device_id', '')::uuid;
  v_staff  uuid := nullif(p ->> 'staff_id', '')::uuid;
  v_lines  jsonb := p -> 'lines';
  v_no     text;
  v_s      bigint;      -- value of every line sold
  v_before bigint;      -- value of the units returned earlier
  v_this   bigint;      -- value of the units returned now
  v_cum    bigint;
  v_prev   bigint;
  v_amount bigint;
  v_avail  bigint;
  v_earned bigint;
  v_rev0   bigint;
  v_rev    bigint;
  v_bal    bigint;
  v_pts    integer := 0;
  v_count  integer;
begin
  if v_id is null then
    raise exception 'a return needs an id' using errcode = '22023';
  end if;
  select * into old from public.order_returns where id = v_id;
  if found then
    if not public.can_access_store(old.org_id, old.store_id) then
      raise exception 'no access to this shop' using errcode = '42501';
    end if;
    return jsonb_build_object('id', old.id, 'number', old.number, 'amount', old.amount, 'refund_method', old.refund_method,
                              'points_reversed', old.points_reversed, 'replay', true);
  end if;

  -- the order row is locked: two returns of the same bill are taken one after the other
  select * into o from public.orders where id = nullif(p ->> 'order_id', '')::uuid for update;
  if not found then
    raise exception 'bill not found' using errcode = 'P0002';
  end if;
  if not (public.has_permission(o.org_id, 'refund.create') and public.can_access_store(o.org_id, o.store_id)) then
    raise exception 'a return needs refund.create' using errcode = '42501';
  end if;
  if o.status <> 'paid' then
    raise exception 'only a paid bill can have a return' using errcode = '55000';
  end if;
  select * into r from public.receipts where order_id = o.id;
  if not found then
    raise exception 'the bill has no receipt' using errcode = '55000';
  end if;
  select * into st from public.stores where id = o.store_id;
  if v_method is null or v_method not in ('cash', 'credit', 'manual') then
    raise exception 'choose how the money goes back' using errcode = '22023';
  end if;
  if v_reason is null or v_reason not in ('wrong_item', 'defective', 'changed_mind', 'other') then
    raise exception 'choose a reason' using errcode = '22023';
  end if;
  if v_dev is not null and not exists (select 1 from public.devices d where d.id = v_dev and d.store_id = o.store_id) then
    raise exception 'that till is not in this shop' using errcode = '22023';
  end if;
  if v_method = 'cash' and v_dev is null then
    raise exception 'a cash refund names the till it comes out of' using errcode = '22023';
  end if;
  if v_staff is not null and not exists (select 1 from public.staff x where x.id = v_staff and x.org_id = o.org_id) then
    v_staff := null;
  end if;
  if v_staff is null then
    select x.id into v_staff from public.staff x where x.org_id = o.org_id and x.user_id = auth.uid() and x.active limit 1;
  end if;
  if jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) not between 1 and 40 then
    raise exception 'choose what is coming back' using errcode = '22023';
  end if;

  -- what is asked for, line by line (a line named twice is refused, so nothing is counted twice)
  create temp table if not exists pg_temp.ret_req (line_id uuid primary key, qty integer not null, restock boolean not null) on commit drop;
  delete from pg_temp.ret_req;
  begin
    insert into pg_temp.ret_req (line_id, qty, restock)
    select (e ->> 'order_line_id')::uuid, (e ->> 'quantity')::integer, coalesce((e ->> 'restock')::boolean, true)
      from jsonb_array_elements(v_lines) e;
  exception when unique_violation then
    raise exception 'a line is listed twice' using errcode = '22023';
  end;
  if exists (select 1 from pg_temp.ret_req where qty < 1 or qty > 99) then
    raise exception 'a quantity is not valid' using errcode = '22023';
  end if;
  select count(*) into v_count from pg_temp.ret_req q
    join public.order_lines l on l.id = q.line_id and l.order_id = o.id and l.status <> 'void';
  if v_count <> (select count(*) from pg_temp.ret_req) then
    raise exception 'a line is not on this bill' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_temp.ret_req q join public.order_lines l on l.id = q.line_id
     where q.qty + coalesce((select sum(rl.quantity) from public.order_return_lines rl where rl.order_line_id = l.id), 0) > l.quantity) then
    raise exception 'more is coming back than was sold' using errcode = '23514';
  end if;

  -- the money, computed here
  select coalesce(sum(l.unit_price::bigint * l.quantity), 0) into v_s from public.order_lines l where l.order_id = o.id and l.status <> 'void';
  select coalesce(sum(rl.unit_price::bigint * rl.quantity), 0) into v_before from public.order_return_lines rl where rl.order_id = o.id;
  select coalesce(sum(l.unit_price::bigint * q.qty), 0) into v_this from pg_temp.ret_req q join public.order_lines l on l.id = q.line_id;
  select coalesce(sum(x.amount), 0) into v_prev from public.order_returns x where x.order_id = o.id;
  if v_s <= 0 then
    v_cum := v_prev;
  elsif v_before + v_this >= v_s then
    v_cum := r.payable;                                    -- everything is back: exactly what was paid
  else
    v_cum := round(r.payable::numeric * (v_before + v_this) / v_s);
  end if;
  v_amount := greatest(v_cum - v_prev, 0);

  -- a route refunds only what that route took
  if v_amount > 0 then
    if v_method = 'credit' then
      if o.customer_id is null then
        raise exception 'a Credit refund needs the member on the bill' using errcode = '22023';
      end if;
      if not public.credit_enabled(o.store_id) then
        raise exception 'Credit is switched off in this shop' using errcode = '0A000';
      end if;
    end if;
    select coalesce(sum(pay.amount), 0) into v_avail from public.payments pay
     where pay.order_id = o.id and pay.status = 'confirmed'
       and ((v_method = 'cash' and pay.tender = 'cash') or (v_method = 'credit' and pay.tender = 'credit')
         or (v_method = 'manual' and pay.tender in ('promptpay', 'gateway')));
    v_avail := v_avail - coalesce((select sum(x.amount) from public.order_returns x where x.order_id = o.id and x.refund_method = v_method), 0);
    if v_amount > v_avail then
      raise exception 'that route took only % on this bill', v_avail using errcode = '23514';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('returns:' || o.store_id::text));
  select 'RT-' || lpad((count(*) + 1)::text, 4, '0') into v_no from public.order_returns where store_id = o.store_id;

  -- the points the bill earned go back in proportion (never below what the member holds)
  if o.customer_id is not null and r.payable > 0 then
    select coalesce(sum(points), 0) into v_earned from public.points_ledger where order_id = o.id and kind = 'earn';
    select coalesce(-sum(points), 0) into v_rev0 from public.points_ledger where order_id = o.id and kind = 'reverse_earn';
    v_rev := floor(v_earned::numeric * least(v_cum, r.payable) / r.payable) - v_rev0;
    select coalesce(sum(points), 0) into v_bal from public.points_ledger where customer_id = o.customer_id;
    v_rev := least(v_rev, greatest(v_bal, 0));
    if v_rev > 0 then v_pts := v_rev::integer; end if;
  end if;

  insert into public.order_returns (id, org_id, store_id, order_id, receipt_id, number, device_id, staff_id, customer_id,
                                    refund_method, amount, reason, note, points_reversed)
  values (v_id, o.org_id, o.store_id, o.id, r.id, v_no, v_dev, v_staff, o.customer_id, v_method, v_amount, v_reason,
          left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 200), v_pts);
  insert into public.order_return_lines (org_id, store_id, return_id, order_id, order_line_id, item_id, name, unit_price, quantity, restocked)
  select o.org_id, o.store_id, v_id, o.id, l.id, l.item_id, l.name, l.unit_price, q.qty, q.restock
    from pg_temp.ret_req q join public.order_lines l on l.id = q.line_id;

  -- Credit back to the member (an adjustment: the ledger has no refund kind and no cash-out)
  if v_method = 'credit' and v_amount > 0 then
    insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, store_id, device_id, kind, amount, debit_account, credit_account, order_id, reason, created_by)
    values (gen_random_uuid(), o.org_id, st.legal_entity_id, o.customer_id, o.store_id, v_dev, 'adjust', v_amount, 'adjustment', 'customer_credit', o.id, 'return ' || v_no, v_staff);
  end if;

  if v_pts > 0 then
    insert into public.points_ledger (org_id, customer_id, store_id, kind, points, order_id, reason, created_by)
    values (o.org_id, o.customer_id, o.store_id, 'reverse_earn', -v_pts, o.id, 'return ' || v_no, v_staff);
  end if;

  -- back on the shelf: the dish's recipe and what its chosen options use, for the lines marked restock
  begin
    insert into public.stock_moves (org_id, store_id, item_id, kind, qty_delta, order_id, note, created_by)
    select o.org_id, o.store_id, u.item_id, 'return', sum(u.q)::bigint, o.id, 'return ' || v_no, v_staff
      from (
        select rl.item_id, rl.quantity * q.qty as q
          from pg_temp.ret_req q
          join public.order_lines l on l.id = q.line_id and l.item_id is not null
          join public.recipe_lines rl on rl.menu_item_id = l.item_id
         where q.restock
           and not exists (
             select 1 from jsonb_array_elements(case when jsonb_typeof(l.modifiers) = 'array' then l.modifiers else '[]'::jsonb end) m
               join public.modifier_option_stock mos on mos.option_id::text = m ->> 'id'
              where mos.instead_of = rl.item_id)
        union all
        select mos.item_id, mos.quantity * q.qty as q
          from pg_temp.ret_req q
          join public.order_lines l on l.id = q.line_id and l.item_id is not null
          cross join lateral jsonb_array_elements(case when jsonb_typeof(l.modifiers) = 'array' then l.modifiers else '[]'::jsonb end) m
          join public.modifier_option_stock mos on mos.option_id::text = m ->> 'id'
         where q.restock
      ) u
      join public.stock_items si on si.id = u.item_id and si.deleted_at is null
     group by u.item_id
    having sum(u.q) > 0;
  exception when others then
    raise warning 'create_return: restock failed: %', sqlerrm;
  end;

  perform public.audit_record(o.org_id, o.store_id, 'payment.refund', 'order_returns', v_id::text,
    jsonb_build_object('number', v_no, 'bill', o.number, 'amount', v_amount, 'method', v_method, 'reason', v_reason, 'points', v_pts), 'db');
  return jsonb_build_object('id', v_id, 'number', v_no, 'amount', v_amount, 'refund_method', v_method, 'points_reversed', v_pts, 'replay', false);
end $$;
revoke all on function public.create_return(jsonb) from public, anon;
grant execute on function public.create_return(jsonb) to authenticated, service_role;

-- ── the shift's expected cash now also loses the cash paid back from this drawer ──
create or replace function public.close_shift(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s       public.shifts%rowtype;
  v_close timestamptz := (p ->> 'closed_at')::timestamptz;
  v_count bigint := (p ->> 'counted_cash')::bigint;
  v_cash  bigint;
  v_topup bigint;
  v_depin bigint;
  v_depout bigint;
  v_tipin bigint;
  v_tipout bigint;
  v_ret   bigint;
  v_exp   bigint;
  v_staff uuid := nullif(p ->> 'staff_id', '')::uuid;
begin
  select * into s from public.shifts where id = (p ->> 'id')::uuid for update;
  if not found then
    raise exception 'shift not found' using errcode = 'P0002';
  end if;
  if not (public.has_permission(s.org_id, 'shift.open_close') and public.can_access_store(s.org_id, s.store_id)) then
    raise exception 'closing a shift needs shift.open_close' using errcode = '42501';
  end if;
  if s.status = 'closed' then
    return jsonb_build_object('expected_cash', s.expected_cash, 'variance', s.variance);
  end if;
  if v_close < s.opened_at then
    raise exception 'a shift cannot close before it opened' using errcode = '23514';
  end if;
  select coalesce(sum(pay.amount), 0) into v_cash from public.payments pay
   where pay.device_id = s.device_id and pay.tender = 'cash' and pay.status = 'confirmed'
     and coalesce(pay.reference, '') not like 'deposit:%'
     and pay.created_at >= s.opened_at and pay.created_at <= v_close;
  select coalesce(sum(l.amount), 0) into v_topup from public.credit_ledger l
   where l.device_id = s.device_id and l.kind = 'topup' and l.funding = 'cash'
     and l.created_at >= s.opened_at and l.created_at <= v_close;
  select coalesce(sum(d.amount), 0) into v_depin from public.appointment_deposits d
   where d.device_id = s.device_id and d.method = 'cash' and d.created_at >= s.opened_at and d.created_at <= v_close;
  select coalesce(sum(d.amount), 0) into v_depout from public.appointment_deposits d
   where d.resolved_device_id = s.device_id and d.method = 'cash' and d.status = 'refunded'
     and d.resolved_at >= s.opened_at and d.resolved_at <= v_close;
  select coalesce(sum(t.amount), 0) into v_tipin from public.staff_tips t
   where t.device_id = s.device_id and t.method = 'cash' and t.created_at >= s.opened_at and t.created_at <= v_close;
  select coalesce(sum(t.amount), 0) into v_tipout from public.staff_tips t
   where t.paid_device_id = s.device_id and t.status = 'paid' and t.paid_at >= s.opened_at and t.paid_at <= v_close;
  select coalesce(sum(x.amount), 0) into v_ret from public.order_returns x
   where x.device_id = s.device_id and x.refund_method = 'cash' and x.created_at >= s.opened_at and x.created_at <= v_close;
  v_exp := s.opening_cash + v_cash + v_topup + v_depin - v_depout + v_tipin - v_tipout - v_ret;
  if v_staff is not null and not exists (select 1 from public.staff x where x.id = v_staff and x.org_id = s.org_id) then
    v_staff := null;
  end if;
  update public.shifts
     set status = 'closed', closed_at = v_close, closed_by = v_staff, counted_cash = v_count,
         expected_cash = v_exp, variance = v_count - v_exp, note = nullif(left(p ->> 'note', 300), '')
   where id = s.id;
  perform public.audit_record(s.org_id, s.store_id, 'shift.close', 'shifts', s.id::text,
    jsonb_build_object('counted', v_count, 'expected', v_exp), 'db');
  if v_count <> v_exp then
    perform public.audit_record(s.org_id, s.store_id, 'shift.cash_variance', 'shifts', s.id::text,
      jsonb_build_object('variance', v_count - v_exp), 'db');
  end if;
  return jsonb_build_object('expected_cash', v_exp, 'variance', v_count - v_exp);
end $$;
revoke all on function public.close_shift(jsonb) from public, anon;
grant execute on function public.close_shift(jsonb) to authenticated, service_role;

-- ── the returns report (the sales report stays as it was; this one is shown next to it) ──
-- p = { org_id, store_id?, from, to }; the Bangkok day of the RETURN (not of the original sale); needs report.view
create or replace function public.returns_report(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org   uuid := (p ->> 'org_id')::uuid;
  v_store uuid := nullif(p ->> 'store_id', '')::uuid;
  v_from  date := (p ->> 'from')::date;
  v_to    date := (p ->> 'to')::date;
  v_out   jsonb;
begin
  if not public.has_permission(v_org, 'report.view') then
    raise exception 'reports need report.view' using errcode = '42501';
  end if;
  if v_store is not null and not public.can_access_store(v_org, v_store) then
    raise exception 'no access to this shop' using errcode = '42501';
  end if;
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 366 then
    raise exception 'the date range is not valid' using errcode = '22023';
  end if;
  with ret as (
    select x.*, (x.created_at at time zone 'Asia/Bangkok')::date as day
      from public.order_returns x
     where x.org_id = v_org and (v_store is null or x.store_id = v_store) and public.can_access_store(x.org_id, x.store_id)
       and (x.created_at at time zone 'Asia/Bangkok')::date between v_from and v_to
  )
  select jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_to),
    'totals', (select jsonb_build_object('returns', count(*), 'refunded', coalesce(sum(amount), 0),
                 'units', coalesce((select sum(rl.quantity) from public.order_return_lines rl join ret on ret.id = rl.return_id), 0)) from ret),
    'by_day', coalesce((select jsonb_agg(x order by x ->> 'date') from (
        select jsonb_build_object('date', day, 'returns', count(*), 'refunded', sum(amount)) as x from ret group by day) d), '[]'::jsonb),
    'by_method', coalesce((select jsonb_agg(x order by (x ->> 'amount')::bigint desc) from (
        select jsonb_build_object('method', refund_method, 'returns', count(*), 'amount', sum(amount)) as x from ret group by refund_method) m), '[]'::jsonb),
    'by_reason', coalesce((select jsonb_agg(x order by (x ->> 'returns')::bigint desc) from (
        select jsonb_build_object('reason', reason, 'returns', count(*)) as x from ret group by reason) q), '[]'::jsonb),
    'by_item', coalesce((select jsonb_agg(x order by (x ->> 'amount')::bigint desc) from (
        select jsonb_build_object('name_th', coalesce(rl.name ->> 'th', ''), 'name_en', coalesce(max(rl.name ->> 'en'), ''),
                                  'quantity', sum(rl.quantity), 'amount', sum(rl.unit_price::bigint * rl.quantity)) as x
          from public.order_return_lines rl join ret on ret.id = rl.return_id
         group by coalesce(rl.name ->> 'th', '') order by sum(rl.unit_price::bigint * rl.quantity) desc limit 100) i), '[]'::jsonb),
    'rows', coalesce((select jsonb_agg(x order by x ->> 'at' desc) from (
        select jsonb_build_object('number', ret.number, 'bill', o.number, 'amount', ret.amount, 'method', ret.refund_method,
                                  'reason', ret.reason, 'at', ret.created_at, 'staff', coalesce(s.display_name, '')) as x
          from ret join public.orders o on o.id = ret.order_id left join public.staff s on s.id = ret.staff_id
         order by ret.created_at desc limit 200) r), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.returns_report(jsonb) from public, anon;
grant execute on function public.returns_report(jsonb) to authenticated, service_role;
