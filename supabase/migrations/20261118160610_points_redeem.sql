-- Bestie POS · migration 27 · redeeming Bestie Points as a DISCOUNT on a bill.
--
--  * Points are never a tender and never cash: the redemption is a bill discount (it lowers the base of service charge and VAT,
--    like any discount — the shop's accountant should confirm this treatment, see DECISIONS.md).
--  * The points are RESERVED in the ledger the moment they are put on the bill (`redeem`, negative), so a customer cannot spend
--    them twice and the final closing can never fail for lack of points — which matters because a payment confirmed by the
--    payment provider must always be able to close the bill. Taking the points off the bill, changing the customer or voiding
--    the bill releases them (`reverse_redeem`, positive). Closing with a smaller discount than reserved releases the rest.
--  * The discount is capped by the org's Points rule: at most `maxRedeemBps` of the GOODS subtotal of the bill (the part that is
--    computed the same way in the database and on the till), and never more than the customer's balance.
--  * The columns `orders.points_used / points_discount` are written only by these functions (a trigger refuses anything else).

-- one earn per bill (as before); redeem / reverse_redeem may repeat while the bill is being built
drop index if exists public.points_ledger_once_uidx;
create unique index points_ledger_earn_once_uidx on public.points_ledger (order_id) where kind = 'earn';

alter table public.orders add column points_used integer not null default 0 check (points_used >= 0);
alter table public.orders add column points_discount bigint not null default 0 check (points_discount >= 0);
alter table public.receipts add column points_used integer not null default 0 check (points_used >= 0);
alter table public.receipts add column points_discount bigint not null default 0 check (points_discount >= 0);

create or replace function public.orders_points_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (tg_op = 'INSERT' and (new.points_used <> 0 or new.points_discount <> 0))
     or (tg_op = 'UPDATE' and (new.points_used <> old.points_used or new.points_discount <> old.points_discount)) then
    if not public.order_privileged() then
      raise exception 'points on a bill are set by the points function only' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger orders_points_check before insert or update on public.orders for each row execute function public.orders_points_guard();

-- registry: tender.points is on for every profile (plan basic) and depends on loyalty.network
-- registry:tender.points profiles=all plan=basic,pro,resort
create or replace function public.points_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select (s.module_overrides ->> 'tender.points')::boolean from public.stores s where s.id = p_store and s.module_overrides ? 'tender.points'), true)
     and coalesce((select (s.module_overrides ->> 'loyalty.network')::boolean from public.stores s where s.id = p_store and s.module_overrides ? 'loyalty.network'), true)
$$;
revoke all on function public.points_enabled(uuid) from public, anon, authenticated;
grant execute on function public.points_enabled(uuid) to service_role;

-- put `p_wanted` points (0 = none) of the bill's customer on the bill; answers what was actually applied
create or replace function public.set_order_points(p_order uuid, p_wanted integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o       public.orders%rowtype;
  v_rule  jsonb;
  v_step  bigint;
  v_bps   bigint;
  v_sub   bigint;
  v_cap   bigint;
  v_bal   bigint;
  v_held  bigint;
  v_used  bigint;
  v_staff uuid;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'order not found' using errcode = 'P0002'; end if;
  if not (public.has_permission(o.org_id, 'order.create') and public.has_permission(o.org_id, 'customer.view')
          and public.can_access_store(o.org_id, o.store_id)) then
    raise exception 'using points needs order.create' using errcode = '42501';
  end if;
  if o.status in ('paid', 'void') then raise exception 'order is already closed' using errcode = '23514'; end if;
  if o.customer_id is null then raise exception 'put a customer on the bill first' using errcode = '23514'; end if;
  if p_wanted is null or p_wanted < 0 or p_wanted > 10000000 then raise exception 'points must be 0 or more' using errcode = '22023'; end if;
  if not public.points_enabled(o.store_id) then raise exception 'Bestie Points are switched off in this shop' using errcode = '0A000'; end if;
  if exists (select 1 from public.payment_attempts a where a.order_id = o.id and a.status in ('created', 'pending')) then
    raise exception 'a payment on this bill is waiting' using errcode = '55006';
  end if;

  select points_rule into v_rule from public.orgs where id = o.org_id;
  v_step := coalesce(case when (v_rule ->> 'redeemSatangPerPoint') ~ '^[0-9]+$' then (v_rule ->> 'redeemSatangPerPoint')::bigint end, 100);
  if v_step < 1 or v_step > 10000 then v_step := 100; end if;
  v_bps := coalesce(case when (v_rule ->> 'maxRedeemBps') ~ '^[0-9]+$' then (v_rule ->> 'maxRedeemBps')::bigint end, 5000);
  if v_bps > 10000 then v_bps := 10000; end if;

  select coalesce(sum(l.unit_price::bigint * l.quantity), 0) into v_sub
    from public.order_lines l where l.order_id = o.id and l.status <> 'void';
  v_cap := (v_sub * v_bps / 10000) / v_step;                      -- most points the rule allows on this bill

  select coalesce(sum(points), 0) into v_bal from public.points_ledger where customer_id = o.customer_id;
  v_held := o.points_used;
  v_used := least(p_wanted::bigint, v_cap, v_bal + v_held);        -- points already held count as available

  if v_used > v_held then
    insert into public.points_ledger (org_id, customer_id, store_id, kind, points, order_id, created_by)
    values (o.org_id, o.customer_id, o.store_id, 'redeem', -(v_used - v_held)::integer, o.id,
            (select s.id from public.staff s where s.org_id = o.org_id and s.user_id = auth.uid() and s.active limit 1));
  elsif v_used < v_held then
    insert into public.points_ledger (org_id, customer_id, store_id, kind, points, order_id, created_by)
    values (o.org_id, o.customer_id, o.store_id, 'reverse_redeem', (v_held - v_used)::integer, o.id,
            (select s.id from public.staff s where s.org_id = o.org_id and s.user_id = auth.uid() and s.active limit 1));
  end if;
  perform set_config('bestie.paying', 'on', true);
  update public.orders set points_used = v_used::integer, points_discount = v_used * v_step where id = o.id;
  perform set_config('bestie.paying', '', true);
  if v_used <> v_held then
    perform public.audit_record(o.org_id, o.store_id, 'points.redeem', 'orders', o.id::text,
      jsonb_build_object('points', v_used, 'discount', v_used * v_step), 'app');
  end if;
  return jsonb_build_object('points_used', v_used, 'discount', v_used * v_step, 'cap_points', v_cap, 'balance', v_bal + v_held - v_used);
end $$;
revoke all on function public.set_order_points(uuid, integer) from public, anon;
grant execute on function public.set_order_points(uuid, integer) to authenticated, service_role;

-- changing or removing the customer releases whatever was reserved for the old one
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
  if o.points_used > 0 and o.customer_id is distinct from p_customer then
    if exists (select 1 from public.payment_attempts a where a.order_id = o.id and a.status in ('created', 'pending')) then
      raise exception 'a payment on this bill is waiting' using errcode = '55006';
    end if;
    insert into public.points_ledger (org_id, customer_id, store_id, kind, points, order_id)
    values (o.org_id, o.customer_id, o.store_id, 'reverse_redeem', o.points_used, o.id);
    perform set_config('bestie.paying', 'on', true);
    update public.orders set points_used = 0, points_discount = 0 where id = o.id;
    perform set_config('bestie.paying', '', true);
  end if;
  update public.orders set customer_id = p_customer where id = p_order;
end $$;
revoke all on function public.set_order_customer(uuid, uuid) from public, anon;
grant execute on function public.set_order_customer(uuid, uuid) to authenticated, service_role;

-- a bill that is voided (e.g. merged away) gives its reserved points back
create or replace function public.orders_release_points() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'void' and old.status <> 'void' and old.points_used > 0 and old.customer_id is not null then
    insert into public.points_ledger (org_id, customer_id, store_id, kind, points, order_id)
    values (old.org_id, old.customer_id, old.store_id, 'reverse_redeem', old.points_used, old.id);
    perform set_config('bestie.paying', 'on', true);
    update public.orders set points_used = 0, points_discount = 0 where id = old.id;
    perform set_config('bestie.paying', '', true);
  end if;
  return null;
end $$;
create trigger orders_release_points_trg after update of status on public.orders for each row execute function public.orders_release_points();

-- a payment attempt may not claim a bigger points discount than the bill holds
create or replace function public.payment_attempts_points_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_held bigint;
begin
  select o.points_discount into v_held from public.orders o where o.id = new.order_id;
  if coalesce((new.snapshot ->> 'points_discount')::bigint, 0) > coalesce(v_held, 0) then
    raise exception 'the points discount is not what the bill holds' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payment_attempts_points_check before insert on public.payment_attempts for each row execute function public.payment_attempts_points_guard();

-- ── the one closing function: receipts record the discount, unused reservation is released ──
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
  v_disc  bigint := coalesce((p_snapshot ->> 'points_discount')::bigint, 0);
  v_used  bigint := 0;
  x       jsonb;
begin
  select * into v_order from public.orders where id = p_order;
  select * into v_store from public.stores s where s.id = v_order.store_id;
  select * into v_ent from public.legal_entities e where e.id = v_store.legal_entity_id;
  select * into v_dev from public.devices d where d.id = p_device;
  select coalesce(sum(l.unit_price::bigint * l.quantity), 0) into v_sub
    from public.order_lines l where l.order_id = v_order.id and l.status <> 'void';
  select o.points_rule into v_rule from public.orgs o where o.id = v_order.org_id;

  v_step := coalesce(case when (v_rule ->> 'redeemSatangPerPoint') ~ '^[0-9]+$' then (v_rule ->> 'redeemSatangPerPoint')::bigint end, 100);
  if v_step < 1 or v_step > 10000 then v_step := 100; end if;
  if v_disc < 0 or v_disc > v_order.points_discount then
    raise exception 'the points discount is more than the bill holds' using errcode = '23514';
  end if;
  if v_disc > 0 then v_used := (v_disc + v_step - 1) / v_step; end if;     -- points actually consumed (rounded up)
  if v_used > v_order.points_used then v_used := v_order.points_used; end if;

  perform set_config('bestie.paying', 'on', true);
  insert into public.receipts (org_id, store_id, order_id, number, device_id, staff_id, issued_at,
      seller_name, seller_tax_id, branch_code, pos_id, vat_registered, vat_bps, service_bps, price_mode,
      subtotal, service_charge, vat, net_before_vat, total, rounding, payable, lang, points_used, points_discount)
  values (v_order.org_id, v_order.store_id, v_order.id, p_receipt_no, v_dev.id, p_staff, p_issued,
      v_ent.name, v_ent.tax_id, v_store.branch_code, v_dev.revenue_pos_id, v_store.vat_registered,
      (p_snapshot ->> 'vat_bps')::integer, (p_snapshot ->> 'service_bps')::integer, p_snapshot ->> 'price_mode',
      v_sub, (p_snapshot ->> 'service_charge')::bigint, (p_snapshot ->> 'vat')::bigint, (p_snapshot ->> 'net_before_vat')::bigint,
      (p_snapshot ->> 'total')::bigint, coalesce((p_snapshot ->> 'rounding')::integer, 0), (p_snapshot ->> 'payable')::bigint,
      coalesce(p_snapshot ->> 'lang', 'th'), v_used::integer, v_disc);
  for x in select * from jsonb_array_elements(p_payments) loop
    insert into public.payments (id, org_id, store_id, order_id, tender, amount, tendered, change, status, reference, staff_id, device_id, created_at)
    values ((x ->> 'id')::uuid, v_order.org_id, v_order.store_id, v_order.id, x ->> 'tender', (x ->> 'amount')::bigint,
            nullif(x ->> 'tendered', '')::bigint, coalesce((x ->> 'change')::bigint, 0), 'confirmed', x ->> 'reference', p_staff, v_dev.id,
            coalesce((x ->> 'created_at')::timestamptz, now()));
  end loop;
  update public.orders set status = 'paid', closed_at = p_issued where id = v_order.id;
  perform public.audit_record(v_order.org_id, v_order.store_id, 'payment.tender', 'orders', v_order.id::text,
    jsonb_build_object('tender', (p_payments -> 0) ->> 'tender', 'amount', (p_snapshot ->> 'payable')::bigint), 'db');

  -- points held for this bill but not used (the bill changed): give them back
  if v_order.points_used > v_used and v_order.customer_id is not null then
    insert into public.points_ledger (org_id, customer_id, store_id, kind, points, order_id, created_by)
    values (v_order.org_id, v_order.customer_id, v_order.store_id, 'reverse_redeem', (v_order.points_used - v_used)::integer, v_order.id, p_staff);
  end if;

  -- Bestie Points earned from THB spend only (never the Points discount, never from buying Credit)
  if v_order.customer_id is not null then
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
      on conflict (order_id) where kind = 'earn' do nothing;
    end if;
  end if;
  perform set_config('bestie.paying', '', true);
end $$;
revoke all on function public.finalize_order_payment(uuid, uuid, uuid, text, timestamptz, jsonb, jsonb) from public, anon, authenticated;
