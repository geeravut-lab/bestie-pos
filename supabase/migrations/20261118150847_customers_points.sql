-- Bestie POS · migration 23 · customers and the Bestie Points ledger.
--
--  * customers      one profile per person per org (a shop network = one legal entity for now); found by phone or member code
--  * points_ledger  append-only, one row per movement, signed integers; kinds are a CLOSED set (no purchase / cash-out / transfer)
--  * orders.customer_id   who the bill belongs to (set at the till, online)
--  * earning        happens in the one place a bill is closed (finalize_order_payment): floor(eligible spend / earn step),
--                   eligible = cash + PromptPay + card (+ Credit if the org's Points rule says so); never from the Points
--                   portion, never from buying Credit. Replays can never earn twice (unique per order + kind).
--  * redemption and Credit come in the next migrations; manual corrections need `credit.adjust` and a reason, and are audited.

create table public.customers (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs (id) on delete cascade,
  name         text not null check (length(btrim(name)) between 1 and 80),
  phone        text check (phone is null or phone ~ '^[0-9]{8,15}$'),
  member_code  text not null check (member_code ~ '^[0-9A-F]{8}$'),
  consent      boolean not null default false,  -- agreed to receive offers (PDPA); never required to earn points
  created_by   uuid references public.staff (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create unique index customers_phone_uidx on public.customers (org_id, phone) where phone is not null and deleted_at is null;
create unique index customers_code_uidx on public.customers (org_id, member_code);
create trigger customers_touch before update on public.customers for each row execute function public.touch_updated_at();

alter table public.customers enable row level security;
create policy customers_read on public.customers for select to authenticated
  using (public.has_permission(org_id, 'customer.view'));
revoke all on public.customers from anon, authenticated;
grant select on public.customers to authenticated;   -- writes go through the functions below

create table public.points_ledger (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  customer_id uuid not null references public.customers (id),
  store_id    uuid references public.stores (id),
  kind        text not null check (kind in ('earn', 'redeem', 'reverse_earn', 'reverse_redeem', 'expire', 'adjust')),
  points      integer not null check (points <> 0 and abs(points) <= 10000000),
  order_id    uuid references public.orders (id),
  reason      text check (length(reason) <= 200),
  created_by  uuid references public.staff (id),
  created_at  timestamptz not null default now(),
  check ((kind in ('earn', 'reverse_redeem') and points > 0) or (kind in ('redeem', 'reverse_earn', 'expire') and points < 0) or kind = 'adjust'),
  check (kind not in ('earn', 'redeem', 'reverse_earn', 'reverse_redeem') or order_id is not null),
  check (kind <> 'adjust' or length(btrim(coalesce(reason, ''))) > 0)
);
create unique index points_ledger_once_uidx on public.points_ledger (order_id, kind) where kind in ('earn', 'redeem');
create index points_ledger_customer_idx on public.points_ledger (customer_id, created_at desc);

create or replace function public.points_ledger_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'the points ledger is append-only' using errcode = '23514';
end $$;
create trigger points_ledger_no_update before update or delete on public.points_ledger for each row execute function public.points_ledger_append_only();

alter table public.points_ledger enable row level security;
create policy points_ledger_read on public.points_ledger for select to authenticated
  using (public.has_permission(org_id, 'customer.view'));
revoke all on public.points_ledger from anon, authenticated;
grant select on public.points_ledger to authenticated;

alter table public.orders add column customer_id uuid references public.customers (id);
create or replace function public.orders_customer_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.customer_id is not null and not exists (
       select 1 from public.customers c where c.id = new.customer_id and c.org_id = new.org_id and c.deleted_at is null) then
    raise exception 'customer belongs to another org' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger orders_customer_check before insert or update of customer_id on public.orders for each row execute function public.orders_customer_guard();

-- ── balance ────────────────────────────────────────────────────────────────
create or replace function public.points_balance(p_customer uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(l.points), 0)::bigint from public.points_ledger l
   where l.customer_id = p_customer
     and public.has_permission(l.org_id, 'customer.view')
$$;
revoke all on function public.points_balance(uuid) from public, anon;
grant execute on function public.points_balance(uuid) to authenticated, service_role;

-- ── create / find ──────────────────────────────────────────────────────────
create or replace function public.create_customer(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org   uuid := (p ->> 'org_id')::uuid;
  v_name  text := btrim(coalesce(p ->> 'name', ''));
  v_phone text := nullif(regexp_replace(coalesce(p ->> 'phone', ''), '[^0-9]', '', 'g'), '');
  v_staff uuid;
  v_code  text;
  v_id    uuid;
  i       int := 0;
begin
  if not public.has_permission(v_org, 'customer.view') then
    raise exception 'customers need customer.view' using errcode = '42501';
  end if;
  if length(v_name) not between 1 and 80 then raise exception 'name is required' using errcode = '22023'; end if;
  if v_phone is not null and v_phone !~ '^[0-9]{8,15}$' then raise exception 'phone number is not valid' using errcode = '22023'; end if;
  select s.id into v_staff from public.staff s where s.org_id = v_org and s.user_id = auth.uid() and s.active limit 1;
  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    begin
      insert into public.customers (org_id, name, phone, member_code, consent, created_by)
      values (v_org, v_name, v_phone, v_code, coalesce((p ->> 'consent')::boolean, false), v_staff)
      returning id into v_id;
      exit;
    exception when unique_violation then
      -- a repeated phone is the caller's business (23505 → "use the existing one"); only a clashing code is retried
      if exists (select 1 from public.customers c where c.org_id = v_org and c.phone = v_phone and c.deleted_at is null and v_phone is not null) then
        raise;
      end if;
      i := i + 1;
      if i > 5 then raise; end if;
    end;
  end loop;
  return jsonb_build_object('id', v_id, 'name', v_name, 'phone', v_phone, 'member_code', v_code, 'balance', 0);
end $$;
revoke all on function public.create_customer(jsonb) from public, anon;
grant execute on function public.create_customer(jsonb) to authenticated, service_role;

-- phone digits (any part, ≥ 4), exact member code, or a name fragment (≥ 2 letters); at most 10 hits, with balances
create or replace function public.find_customers(p_org uuid, p_query text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  q      text := btrim(coalesce(p_query, ''));
  digits text := regexp_replace(q, '[^0-9]', '', 'g');
  v_out  jsonb;
begin
  if not public.has_permission(p_org, 'customer.view') then
    raise exception 'customers need customer.view' using errcode = '42501';
  end if;
  if length(q) < 2 then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(x order by x ->> 'name'), '[]'::jsonb) into v_out from (
    select jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'member_code', c.member_code,
             'balance', (select coalesce(sum(l.points), 0) from public.points_ledger l where l.customer_id = c.id)) as x
      from public.customers c
     where c.org_id = p_org and c.deleted_at is null
       and ((length(digits) >= 4 and c.phone like '%' || digits || '%')
            or c.member_code = upper(q)
            or (q ~ '[^0-9 +()-]' and c.name ilike '%' || replace(replace(q, '%', ''), '_', '') || '%'))
     limit 10) t;
  return v_out;
end $$;
revoke all on function public.find_customers(uuid, text) from public, anon;
grant execute on function public.find_customers(uuid, text) to authenticated, service_role;

-- ── put a customer on a bill (online action at the till) ───────────────────
create or replace function public.set_order_customer(p_order uuid, p_customer uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders%rowtype;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'order not found' using errcode = 'P0002'; end if;
  if not (public.has_permission(o.org_id, 'order.create') and public.can_access_store(o.org_id, o.store_id)) then
    raise exception 'changing a bill needs order.create' using errcode = '42501';
  end if;
  if o.status in ('paid', 'void') then raise exception 'order is already closed' using errcode = '23514'; end if;
  if p_customer is not null and not public.has_permission(o.org_id, 'customer.view') then
    raise exception 'customers need customer.view' using errcode = '42501';
  end if;
  update public.orders set customer_id = p_customer where id = p_order;
end $$;
revoke all on function public.set_order_customer(uuid, uuid) from public, anon;
grant execute on function public.set_order_customer(uuid, uuid) to authenticated, service_role;

-- ── a manager's correction (reason required, never below zero, critical audit event) ─
create or replace function public.adjust_points(p_customer uuid, p_points integer, p_reason text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  c public.customers%rowtype;
  v_bal bigint;
  v_staff uuid;
begin
  select * into c from public.customers where id = p_customer and deleted_at is null for update;
  if not found then raise exception 'customer not found' using errcode = 'P0002'; end if;
  if not public.has_permission(c.org_id, 'credit.adjust') then
    raise exception 'correcting points needs credit.adjust' using errcode = '42501';
  end if;
  if p_points is null or p_points = 0 or abs(p_points) > 10000000 or length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'an amount and a reason are required' using errcode = '22023';
  end if;
  select coalesce(sum(points), 0) into v_bal from public.points_ledger where customer_id = c.id;
  if v_bal + p_points < 0 then raise exception 'the balance cannot go below zero' using errcode = '23514'; end if;
  select s.id into v_staff from public.staff s where s.org_id = c.org_id and s.user_id = auth.uid() and s.active limit 1;
  insert into public.points_ledger (org_id, customer_id, kind, points, reason, created_by)
  values (c.org_id, c.id, 'adjust', p_points, left(btrim(p_reason), 200), v_staff);
  perform public.audit_record(c.org_id, null, 'points.adjust', 'customers', c.id::text,
    jsonb_build_object('points', p_points), 'app');
  return v_bal + p_points;
end $$;
revoke all on function public.adjust_points(uuid, integer, text) from public, anon;
grant execute on function public.adjust_points(uuid, integer, text) to authenticated, service_role;

-- ── earning, inside the one closing function ───────────────────────────────
create or replace function public.finalize_order_payment(
  p_order uuid, p_device uuid, p_staff uuid, p_receipt_no text, p_issued timestamptz, p_snapshot jsonb, p_payments jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_store public.stores%rowtype;
  v_ent   public.legal_entities%rowtype;
  v_dev   public.devices%rowtype;
  v_sub   bigint;
  v_rule  jsonb;
  v_step  bigint;
  v_spend bigint;
  v_pts   bigint;
  x       jsonb;
begin
  select * into v_order from public.orders where id = p_order;
  select * into v_store from public.stores s where s.id = v_order.store_id;
  select * into v_ent from public.legal_entities e where e.id = v_store.legal_entity_id;
  select * into v_dev from public.devices d where d.id = p_device;
  select coalesce(sum(l.unit_price::bigint * l.quantity), 0) into v_sub
    from public.order_lines l where l.order_id = v_order.id and l.status <> 'void';

  perform set_config('bestie.paying', 'on', true);
  insert into public.receipts (org_id, store_id, order_id, number, device_id, staff_id, issued_at,
      seller_name, seller_tax_id, branch_code, pos_id, vat_registered, vat_bps, service_bps, price_mode,
      subtotal, service_charge, vat, net_before_vat, total, rounding, payable, lang)
  values (v_order.org_id, v_order.store_id, v_order.id, p_receipt_no, v_dev.id, p_staff, p_issued,
      v_ent.name, v_ent.tax_id, v_store.branch_code, v_dev.revenue_pos_id, v_store.vat_registered,
      (p_snapshot ->> 'vat_bps')::integer, (p_snapshot ->> 'service_bps')::integer, p_snapshot ->> 'price_mode',
      v_sub, (p_snapshot ->> 'service_charge')::bigint, (p_snapshot ->> 'vat')::bigint, (p_snapshot ->> 'net_before_vat')::bigint,
      (p_snapshot ->> 'total')::bigint, coalesce((p_snapshot ->> 'rounding')::integer, 0), (p_snapshot ->> 'payable')::bigint,
      coalesce(p_snapshot ->> 'lang', 'th'));
  for x in select * from jsonb_array_elements(p_payments) loop
    insert into public.payments (id, org_id, store_id, order_id, tender, amount, tendered, change, status, reference, staff_id, device_id, created_at)
    values ((x ->> 'id')::uuid, v_order.org_id, v_order.store_id, v_order.id, x ->> 'tender', (x ->> 'amount')::bigint,
            nullif(x ->> 'tendered', '')::bigint, coalesce((x ->> 'change')::bigint, 0), 'confirmed', x ->> 'reference', p_staff, v_dev.id,
            coalesce((x ->> 'created_at')::timestamptz, now()));
  end loop;
  update public.orders set status = 'paid', closed_at = p_issued where id = v_order.id;
  perform public.audit_record(v_order.org_id, v_order.store_id, 'payment.tender', 'orders', v_order.id::text,
    jsonb_build_object('tender', (p_payments -> 0) ->> 'tender', 'amount', (p_snapshot ->> 'payable')::bigint), 'db');

  -- Bestie Points: earned from THB spend only (never the Points portion, never from buying Credit)
  if v_order.customer_id is not null then
    select o.points_rule into v_rule from public.orgs o where o.id = v_order.org_id;
    v_step := coalesce(case when (v_rule ->> 'earnSatangPerPoint') ~ '^[0-9]+$' then (v_rule ->> 'earnSatangPerPoint')::bigint end, 2500);
    if v_step < 100 or v_step > 1000000 then v_step := 2500; end if;
    select coalesce(sum(py.amount), 0) into v_spend from public.payments py
     where py.order_id = v_order.id and py.status = 'confirmed'
       and (py.tender in ('cash', 'promptpay', 'gateway')
            or (py.tender = 'credit' and coalesce((v_rule ->> 'creditEarnsPoints')::boolean, true)));
    v_pts := v_spend / v_step;
    if v_pts > 0 then
      insert into public.points_ledger (org_id, customer_id, store_id, kind, points, order_id, created_by)
      values (v_order.org_id, v_order.customer_id, v_order.store_id, 'earn', v_pts::integer, v_order.id, p_staff)
      on conflict (order_id, kind) where kind in ('earn', 'redeem') do nothing;
    end if;
  end if;
  perform set_config('bestie.paying', '', true);
end $$;
revoke all on function public.finalize_order_payment(uuid, uuid, uuid, text, timestamptz, jsonb, jsonb) from public, anon, authenticated;
