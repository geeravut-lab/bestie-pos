-- Bestie POS · migration 65 · service-shop accounting policy (owner decisions 2026-11-21, docs/ACCOUNTANT-BRIEF.md).
--  D  a deposit for a service gets a receipt / tax-invoice number the day it is received (`DP-000001…`, VAT shown for a VAT shop);
--     a kept (forfeited) no-show fee is revenue WITH VAT and gets its own number (`NF-000001…`).
--  E  package income is deferred: what a member paid sits as "income received in advance" and is released with every visit and, for what is left,
--     when the package expires; VAT follows the day the money was received (already on the sale's receipt). `package_deferred_report`.
--  F  commission is computed before VAT and after ALL discounts (line, bill, Points) — the default; the shop can choose the old "as sold" base.
--  G  tips stay a pass-through (no VAT, no revenue); service charge is shop revenue with VAT (unchanged).
-- The choices are DATA (`stores.service_policy`, owner only, audited), defaulting to the owner's decisions.

create or replace function public.service_policy_ok(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object'
     and not exists (select 1 from jsonb_object_keys(p) k where k not in ('commission_base', 'deposit_invoice', 'noshow_fee_vat', 'package_revenue'))
     and (not p ? 'commission_base' or p ->> 'commission_base' in ('net', 'as_sold'))
     and (not p ? 'deposit_invoice' or jsonb_typeof(p -> 'deposit_invoice') = 'boolean')
     and (not p ? 'noshow_fee_vat' or jsonb_typeof(p -> 'noshow_fee_vat') = 'boolean')
     and (not p ? 'package_revenue' or p ->> 'package_revenue' in ('deferred', 'at_sale'))
$$;
alter table public.stores add column service_policy jsonb not null default '{}'::jsonb check (public.service_policy_ok(service_policy));

create or replace function public.service_policy(p_store uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select '{"commission_base":"net","deposit_invoice":true,"noshow_fee_vat":true,"package_revenue":"deferred"}'::jsonb
         || coalesce((select s.service_policy from public.stores s where s.id = p_store), '{}'::jsonb)
$$;
revoke all on function public.service_policy(uuid) from public, anon;
grant execute on function public.service_policy(uuid) to authenticated, service_role;

create or replace function public.save_service_policy(p_store uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype;
begin
  select * into s from public.stores where id = p_store and deleted_at is null;
  if not found or not public.is_org_owner(s.org_id) then raise exception 'the accounting policy is the owner''s choice' using errcode = '42501'; end if;
  if not public.service_policy_ok(p) then raise exception 'the policy is not valid' using errcode = '22023'; end if;
  update public.stores set service_policy = p where id = p_store;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'stores', s.id::text, jsonb_build_object('service_policy', p), 'db');
  return public.service_policy(p_store);
end $$;
revoke all on function public.service_policy_ok(jsonb), public.save_service_policy(uuid, jsonb) from public, anon;
grant execute on function public.service_policy_ok(jsonb), public.save_service_policy(uuid, jsonb) to authenticated, service_role;

-- consecutive document numbers per shop and kind (taken under the row lock, so two tablets never get the same one)
create table public.service_doc_counters (
  store_id uuid not null references public.stores (id) on delete cascade,
  kind     text not null check (kind in ('DP', 'NF')),
  last_no  integer not null default 0,
  primary key (store_id, kind)
);
alter table public.service_doc_counters enable row level security;
revoke all on public.service_doc_counters from anon, authenticated;
create or replace function public.next_service_doc(p_store uuid, p_kind text) returns text
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.service_doc_counters (store_id, kind, last_no) values (p_store, p_kind, 1)
  on conflict (store_id, kind) do update set last_no = public.service_doc_counters.last_no + 1
  returning last_no into n;
  return p_kind || '-' || lpad(n::text, 6, '0');
end $$;
revoke all on function public.next_service_doc(uuid, text) from public, anon, authenticated;

-- VAT contained in a gross amount (the same rounding as packages/core vatFromInclusive)
create or replace function public.vat_in_gross(p_gross bigint, p_bps integer) returns bigint
language sql immutable set search_path = '' as $$
  select case when coalesce(p_bps, 0) = 0 then 0::bigint else floor((p_gross * p_bps + (10000 + p_bps) / 2.0) / (10000 + p_bps))::bigint end
$$;
revoke all on function public.vat_in_gross(bigint, integer) from public, anon, authenticated;

alter table public.appointment_deposits
  add column invoice_no     text,
  add column invoice_vat    bigint check (invoice_vat is null or invoice_vat >= 0),
  add column fee_invoice_no text,
  add column fee_vat        bigint check (fee_vat is null or fee_vat >= 0);

create or replace function public.record_appointment_deposit(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  a public.appointments%rowtype;
  v_amount bigint := (p ->> 'amount')::bigint;
  v_method text := p ->> 'method';
  v_dev uuid := nullif(p ->> 'device_id', '')::uuid;
  v_held bigint;
  v_staff uuid;
  v_id uuid;
  v_pol jsonb;
  v_inv text;
  v_vat bigint := 0;
begin
  select * into a from public.appointments where id = (p ->> 'appointment_id')::uuid for update;
  if not found or not (public.can_access_store(a.org_id, a.store_id) and public.has_permission(a.org_id, 'payment.take')) then
    raise exception 'taking a deposit needs payment.take in this shop' using errcode = '42501';
  end if;
  if not public.deposits_enabled(a.store_id) then raise exception 'the deposits module is off in this shop' using errcode = '0A000'; end if;
  if a.status not in ('booked', 'confirmed', 'arrived') then raise exception 'a deposit is taken before the service' using errcode = '55000'; end if;
  if v_method not in ('cash', 'promptpay', 'gateway') then raise exception 'unknown method' using errcode = '22023'; end if;
  if v_amount is null or v_amount < 1 then raise exception 'the amount must be above zero' using errcode = '22023'; end if;
  if v_method = 'cash' and not exists (select 1 from public.devices d where d.id = v_dev and d.store_id = a.store_id and d.active) then
    raise exception 'a cash deposit needs the till it went into' using errcode = '22023';
  end if;
  if v_method <> 'cash' then v_dev := null; end if;
  select coalesce(sum(amount), 0) into v_held from public.appointment_deposits where appointment_id = a.id and status in ('held', 'on_bill');
  if v_held + v_amount > a.price then raise exception 'deposits cannot be more than the price of the service' using errcode = '22023'; end if;
  select f.id into v_staff from public.staff f where f.org_id = a.org_id and f.user_id = auth.uid() and f.active limit 1;
  -- owner's rule (2026-11-21): a deposit for a service gets its own receipt / tax invoice number the day the money is received
  v_pol := public.service_policy(a.store_id);
  if (v_pol ->> 'deposit_invoice')::boolean then
    v_inv := public.next_service_doc(a.store_id, 'DP');
    v_vat := public.vat_in_gross(v_amount, (select case when s.vat_registered then s.vat_bps else 0 end from public.stores s where s.id = a.store_id));
  end if;
  insert into public.appointment_deposits (org_id, store_id, appointment_id, amount, method, device_id, reference, created_by, invoice_no, invoice_vat)
  values (a.org_id, a.store_id, a.id, v_amount, v_method, v_dev, left(nullif(btrim(coalesce(p ->> 'reference', '')), ''), 100), v_staff, v_inv, case when v_inv is not null then v_vat end)
  returning id into v_id;
  perform public.audit_record(a.org_id, a.store_id, 'payment.tender', 'appointments', a.id::text,
    jsonb_build_object('deposit', v_amount, 'method', v_method), 'db');
  return v_id;
end $$;

create or replace function public.resolve_deposit(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  d public.appointment_deposits%rowtype;
  a public.appointments%rowtype;
  v_action text := p ->> 'action';
  v_dev uuid := nullif(p ->> 'device_id', '')::uuid;
  v_staff uuid;
  v_fee text;
  v_fvat bigint := 0;
begin
  select * into d from public.appointment_deposits where id = (p ->> 'deposit_id')::uuid for update;
  if not found or not (public.can_access_store(d.org_id, d.store_id) and public.has_permission(d.org_id, 'refund.create')) then
    raise exception 'settling a deposit needs refund.create' using errcode = '42501';
  end if;
  select * into a from public.appointments where id = d.appointment_id;
  if d.status <> 'held' then raise exception 'this deposit is already %', d.status using errcode = '55000'; end if;
  if a.status not in ('cancelled', 'no_show') then raise exception 'a deposit is settled when the appointment is cancelled or a no-show' using errcode = '55000'; end if;
  if v_action not in ('forfeit', 'refund') then raise exception 'unknown action' using errcode = '22023'; end if;
  if v_action = 'refund' and d.method = 'cash' and not exists (select 1 from public.devices x where x.id = v_dev and x.store_id = d.store_id and x.active) then
    raise exception 'a cash refund needs the till it came out of' using errcode = '22023';
  end if;
  select f.id into v_staff from public.staff f where f.org_id = d.org_id and f.user_id = auth.uid() and f.active limit 1;
  -- a kept no-show fee is revenue of the shop: it carries VAT (owner's rule 2026-11-21) and gets its own document number
  if v_action = 'forfeit' then
    v_fee := public.next_service_doc(d.store_id, 'NF');
    if (public.service_policy(d.store_id) ->> 'noshow_fee_vat')::boolean then
      v_fvat := public.vat_in_gross(d.amount, (select case when s.vat_registered then s.vat_bps else 0 end from public.stores s where s.id = d.store_id));
    end if;
  end if;
  update public.appointment_deposits
     set status = case when v_action = 'forfeit' then 'forfeited' else 'refunded' end, resolved_at = now(), resolved_by = v_staff,
         fee_invoice_no = v_fee, fee_vat = case when v_fee is not null then v_fvat end,
         resolved_device_id = case when v_action = 'refund' and d.method = 'cash' then v_dev end
   where id = d.id;
  perform public.audit_record(d.org_id, d.store_id, 'payment.refund', 'appointments', d.appointment_id::text,
    jsonb_build_object('deposit', d.amount, 'action', v_action), 'db');
  return case when v_action = 'forfeit' then 'forfeited' else 'refunded' end;
end $$;

create or replace function public.commission_report(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org   uuid := (p ->> 'org_id')::uuid;
  v_store uuid := nullif(p ->> 'store_id', '')::uuid;
  v_from  date := (p ->> 'from')::date;
  v_to    date := (p ->> 'to')::date;
  v_rows  jsonb;
begin
  if not public.has_permission(v_org, 'report.view') then raise exception 'reports need report.view' using errcode = '42501'; end if;
  if v_store is not null and not public.can_access_store(v_org, v_store) then raise exception 'no access to this shop' using errcode = '42501'; end if;
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 366 then raise exception 'the date range is not valid' using errcode = '22023'; end if;
  with st as (
    select s.id, (public.service_policy(s.id) ->> 'commission_base') as base from public.stores s
     where s.org_id = v_org and s.deleted_at is null and (v_store is null or s.id = v_store) and public.can_access_store(s.org_id, s.id)
       and public.commission_enabled(s.id)
  ),
  -- what part of every bill line is "net": goods net of VAT after ALL discounts (line, bill, points) = the receipt's net before VAT
  -- minus the service charge's share, spread over the lines in proportion to what they were sold for
  ofac as (
    select r.order_id,
           case when t.tot = 0 or (case when r.price_mode = 'inclusive' then r.total else r.net_before_vat end) = 0 then 1::numeric
                else r.net_before_vat::numeric
                     * ((case when r.price_mode = 'inclusive' then r.total else r.net_before_vat end) - r.service_charge)
                     / (case when r.price_mode = 'inclusive' then r.total else r.net_before_vat end) / t.tot end as factor
      from public.receipts r
      join (select l.order_id, sum(l.unit_price::bigint * l.quantity) as tot from public.order_lines l where l.status <> 'void' group by l.order_id) t on t.order_id = r.order_id
  ),
  lines as (
    select o.store_id,
           coalesce((select r.staff_id from public.appointments a join public.resources r on r.id = a.provider_id
                      where a.order_id = o.id and r.staff_id is not null limit 1), o.opened_by) as staff_id,
           (mi.duration_min is not null) as is_service,
           case when st.base = 'net' then round(l.unit_price::numeric * l.quantity * coalesce(f.factor, 1))::bigint
                else l.unit_price::bigint * l.quantity end as amt
      from public.orders o
      join st on st.id = o.store_id
      left join ofac f on f.order_id = o.id
      join public.order_lines l on l.order_id = o.id and l.status <> 'void' and l.item_id is not null
      join public.menu_items mi on mi.id = l.item_id
     where o.status = 'paid' and o.business_date between v_from and v_to
    union all
    -- a package visit (or its undo) is a service sale of the appointment's stylist, at the visit's value
    select pu.store_id, r.staff_id, true,
           case when st.base = 'net' then round(pu.value::numeric * coalesce(f.factor, 1))::bigint else pu.value end
      from public.package_uses pu
      join st on st.id = pu.store_id
      join public.customer_packages cp on cp.id = pu.customer_package_id
      left join ofac f on f.order_id = cp.order_id
      join public.appointments a on a.id = pu.appointment_id
      join public.resources r on r.id = a.provider_id and r.staff_id is not null
     where (pu.created_at at time zone 'Asia/Bangkok')::date between v_from and v_to
  ),
  per as (
    select store_id, staff_id,
           coalesce(sum(amt) filter (where is_service), 0) as service_sales,
           coalesce(sum(amt) filter (where not is_service), 0) as product_sales
      from lines where staff_id is not null group by store_id, staff_id
  ),
  rated as (
    select per.*, f.display_name as name,
           coalesce(rp.service_bps, rd.service_bps, 0) as service_bps,
           coalesce(rp.product_bps, rd.product_bps, 0) as product_bps
      from per
      join public.staff f on f.id = per.staff_id
      left join public.commission_rates rp on rp.store_id = per.store_id and rp.staff_id = per.staff_id
      left join public.commission_rates rd on rd.store_id = per.store_id and rd.staff_id is null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'staff_id', staff_id, 'name', name, 'store_id', store_id, 'service_sales', service_sales, 'product_sales', product_sales,
           'service_bps', service_bps, 'product_bps', product_bps,
           'commission', round(service_sales * service_bps / 10000.0 + product_sales * product_bps / 10000.0)::bigint)
         order by name, store_id), '[]'::jsonb)
    into v_rows from rated;
  return jsonb_build_object('range', jsonb_build_object('from', v_from, 'to', v_to), 'rows', v_rows);
end $$;

-- ── income received in advance for packages ──
-- p = { org_id, store_id?, as_of? (date, default today in Bangkok) } → { as_of, policy, sold, released_by_visits, released_by_expiry, deferred, rows[] }
create or replace function public.package_deferred_report(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := (p ->> 'org_id')::uuid;
  v_store uuid := nullif(p ->> 'store_id', '')::uuid;
  v_asof date := coalesce(nullif(p ->> 'as_of', '')::date, (now() at time zone 'Asia/Bangkok')::date);
  v_sold bigint; v_visits bigint; v_expiry bigint; v_rows jsonb;
begin
  if not public.has_permission(v_org, 'report.view') then raise exception 'reports need report.view' using errcode = '42501'; end if;
  if v_store is not null and not public.can_access_store(v_org, v_store) then raise exception 'no access to this shop' using errcode = '42501'; end if;
  with base as (
    select cp.id, cp.name, cp.price, c.name as member, cp.valid_until,
           coalesce((select sum(u.value) from public.package_uses u where u.customer_package_id = cp.id and (u.created_at at time zone 'Asia/Bangkok')::date <= v_asof), 0) as used,
           (cp.valid_until is not null and cp.valid_until < v_asof) as expired
      from public.customer_packages cp
      join public.customers c on c.id = cp.customer_id
     where cp.org_id = v_org and (v_store is null or cp.store_id = v_store) and public.can_access_store(cp.org_id, cp.store_id)
       and cp.status not in ('pending', 'cancelled') and cp.activated_at is not null
       and (cp.activated_at at time zone 'Asia/Bangkok')::date <= v_asof
  ), calc as (
    select *, case when expired then greatest(price - used, 0) else 0 end as left_over from base
  )
  select coalesce(sum(price), 0), coalesce(sum(least(used, price)), 0), coalesce(sum(left_over), 0),
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'member', member, 'price', price, 'used', least(used, price),
           'valid_until', valid_until, 'expired', expired, 'released_by_expiry', left_over,
           'deferred', case when expired then 0 else greatest(price - used, 0) end) order by member, id), '[]'::jsonb)
    into v_sold, v_visits, v_expiry, v_rows from calc;
  return jsonb_build_object('as_of', v_asof,
    'policy', case when v_store is null then null else public.service_policy(v_store) ->> 'package_revenue' end,
    'sold', v_sold, 'released_by_visits', v_visits, 'released_by_expiry', v_expiry, 'deferred', v_sold - v_visits - v_expiry, 'rows', v_rows);
end $$;
revoke all on function public.package_deferred_report(jsonb) from public, anon;
grant execute on function public.package_deferred_report(jsonb) to authenticated, service_role;
