-- Bestie POS · migration 52 · COMMISSION and TIPS per staff (module `commission`).
--
--  * `commission_rates`: a shop's default rate for SERVICES and for PRODUCTS (percent of the sale, in basis points) and an optional
--    different rate per person. Written by whoever manages staff (`staff.manage`), read by whoever may see reports.
--  * `commission_report`: computed from the FROZEN history — paid bills of the Bangkok business days asked for, lines that were not
--    cancelled. A line is a SERVICE when its menu item has a length in minutes, otherwise a PRODUCT; lines without a menu item
--    (a package sold, a custom line) earn nothing. Who earns it: the stylist / therapist of the appointment that made the bill (the
--    person their resource is linked to), otherwise whoever opened the bill. The base is the line amount as sold (bill-level discounts,
--    Points and service charge are not taken off; VAT is not taken off) — the accountant may want that changed.
--  * TIPS (`staff_tips`): money the guest gave for a person, recorded at the front desk (cash into a drawer, PromptPay / card). A tip is
--    NOT part of the bill, not sales and not VAT. It is owed to the person until a manager pays it out (cash from a drawer), which is
--    audited. The shift's expected cash counts cash tips taken and tips paid out at that drawer.
--  Rates and tips need the module `commission` (on by default for salon and spa, Pro plan and up).

-- registry:commission profiles=salon,spa plan=pro,resort
create or replace function public.commission_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.stores s
     where s.id = p_store and s.deleted_at is null and s.plan in ('pro', 'resort')
       and coalesce((s.module_overrides ->> 'commission')::boolean, s.profile in ('salon', 'spa')))
$$;
revoke all on function public.commission_enabled(uuid) from public, anon;
grant execute on function public.commission_enabled(uuid) to authenticated, service_role;

create table public.commission_rates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  staff_id    uuid references public.staff (id) on delete cascade,          -- null = the shop's default
  service_bps integer not null default 0 check (service_bps between 0 and 10000),
  product_bps integer not null default 0 check (product_bps between 0 and 10000),
  updated_at  timestamptz not null default now()
);
create unique index commission_rates_scope_uidx on public.commission_rates (store_id, coalesce(staff_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table public.commission_rates enable row level security;
create policy commission_rates_read on public.commission_rates for select to authenticated
  using (public.can_access_store(org_id, store_id) and (public.has_permission(org_id, 'report.view') or public.has_permission(org_id, 'staff.manage')));
revoke all on public.commission_rates from anon, authenticated;
grant select on public.commission_rates to authenticated;

-- p = { store_id, staff_id?, service_bps, product_bps }
create or replace function public.set_commission_rate(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype;
  v_staff uuid := nullif(p ->> 'staff_id', '')::uuid;
  v_svc integer := (p ->> 'service_bps')::integer;
  v_prod integer := (p ->> 'product_bps')::integer;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'staff.manage')) then
    raise exception 'commission rates need staff.manage in this shop' using errcode = '42501';
  end if;
  if not public.commission_enabled(s.id) then raise exception 'the commission module is off in this shop' using errcode = '0A000'; end if;
  if v_svc is null or v_prod is null or v_svc not between 0 and 10000 or v_prod not between 0 and 10000 then
    raise exception 'a rate is 0 to 100 percent' using errcode = '22023';
  end if;
  if v_staff is not null and not exists (select 1 from public.staff f where f.id = v_staff and f.org_id = s.org_id) then
    raise exception 'unknown person' using errcode = '22023';
  end if;
  insert into public.commission_rates (org_id, store_id, staff_id, service_bps, product_bps)
  values (s.org_id, s.id, v_staff, v_svc, v_prod)
  on conflict (store_id, (coalesce(staff_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  do update set service_bps = excluded.service_bps, product_bps = excluded.product_bps, updated_at = now();
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'commission_rates', coalesce(v_staff::text, 'default'),
    jsonb_build_object('service_bps', v_svc, 'product_bps', v_prod), 'db');
end $$;

-- p = { org_id, store_id?, from, to } → { range, rows: [{ staff_id, name, store_id, service_sales, product_sales, service_bps, product_bps, commission }] }
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
    select s.id from public.stores s
     where s.org_id = v_org and s.deleted_at is null and (v_store is null or s.id = v_store) and public.can_access_store(s.org_id, s.id)
       and public.commission_enabled(s.id)
  ),
  lines as (
    select o.store_id,
           coalesce((select r.staff_id from public.appointments a join public.resources r on r.id = a.provider_id
                      where a.order_id = o.id and r.staff_id is not null limit 1), o.opened_by) as staff_id,
           (mi.duration_min is not null) as is_service,
           l.unit_price::bigint * l.quantity as amt
      from public.orders o
      join st on st.id = o.store_id
      join public.order_lines l on l.order_id = o.id and l.status <> 'void' and l.item_id is not null
      join public.menu_items mi on mi.id = l.item_id
     where o.status = 'paid' and o.business_date between v_from and v_to
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

-- ── tips ──
create table public.staff_tips (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs (id) on delete cascade,
  store_id       uuid not null references public.stores (id) on delete cascade,
  staff_id       uuid not null references public.staff (id),
  appointment_id uuid references public.appointments (id),
  amount         bigint not null check (amount between 1 and 10000000),
  method         text not null check (method in ('cash', 'promptpay', 'gateway')),
  device_id      uuid references public.devices (id),                      -- where cash went in
  note           text check (note is null or length(note) <= 200),
  status         text not null default 'owed' check (status in ('owed', 'paid')),
  created_by     uuid references public.staff (id) on delete set null,
  created_at     timestamptz not null default now(),
  paid_at        timestamptz,
  paid_by        uuid references public.staff (id) on delete set null,
  paid_device_id uuid references public.devices (id)                       -- the drawer the pay-out came from
);
create index staff_tips_staff_idx on public.staff_tips (staff_id, status);
create index staff_tips_store_idx on public.staff_tips (store_id, created_at desc);
alter table public.staff_tips enable row level security;
create policy staff_tips_read on public.staff_tips for select to authenticated
  using (public.can_access_store(org_id, store_id) and (public.has_permission(org_id, 'report.view') or public.has_permission(org_id, 'payment.take')));
revoke all on public.staff_tips from anon, authenticated;
grant select on public.staff_tips to authenticated;
create trigger staff_tips_live after insert or update on public.staff_tips for each row execute function public.live_ping_row('store:{store_id}');

-- p = { store_id, staff_id, amount, method, device_id? (cash), appointment_id?, note? }
create or replace function public.record_tip(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype;
  v_staff uuid := (p ->> 'staff_id')::uuid;
  v_amount bigint := (p ->> 'amount')::bigint;
  v_method text := p ->> 'method';
  v_dev uuid := nullif(p ->> 'device_id', '')::uuid;
  v_appt uuid := nullif(p ->> 'appointment_id', '')::uuid;
  v_by uuid;
  v_id uuid;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'payment.take')) then
    raise exception 'taking a tip needs payment.take in this shop' using errcode = '42501';
  end if;
  if not public.commission_enabled(s.id) then raise exception 'the commission module is off in this shop' using errcode = '0A000'; end if;
  if v_amount is null or v_amount < 1 then raise exception 'the amount must be above zero' using errcode = '22023'; end if;
  if v_method not in ('cash', 'promptpay', 'gateway') then raise exception 'unknown method' using errcode = '22023'; end if;
  if not exists (select 1 from public.staff f where f.id = v_staff and f.org_id = s.org_id and f.active) then
    raise exception 'unknown person' using errcode = '22023';
  end if;
  if v_appt is not null and not exists (select 1 from public.appointments a where a.id = v_appt and a.store_id = s.id) then
    raise exception 'unknown appointment' using errcode = '22023';
  end if;
  if v_method = 'cash' and not exists (select 1 from public.devices d where d.id = v_dev and d.store_id = s.id and d.active) then
    raise exception 'a cash tip needs the till it went into' using errcode = '22023';
  end if;
  if v_method <> 'cash' then v_dev := null; end if;
  select f.id into v_by from public.staff f where f.org_id = s.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.staff_tips (org_id, store_id, staff_id, appointment_id, amount, method, device_id, note, created_by)
  values (s.org_id, s.id, v_staff, v_appt, v_amount, v_method, v_dev, left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 200), v_by)
  returning id into v_id;
  perform public.audit_record(s.org_id, s.id, 'payment.tender', 'staff_tips', v_id::text, jsonb_build_object('tip', v_amount, 'method', v_method), 'db');
  return v_id;
end $$;

-- p = { store_id, staff_id, device_id } — everything owed to that person at this shop is paid out in cash from this drawer
create or replace function public.pay_out_tips(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype;
  v_staff uuid := (p ->> 'staff_id')::uuid;
  v_dev uuid := nullif(p ->> 'device_id', '')::uuid;
  v_total bigint;
  v_by uuid;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'refund.create')) then
    raise exception 'paying out tips needs refund.create in this shop' using errcode = '42501';
  end if;
  if not exists (select 1 from public.devices d where d.id = v_dev and d.store_id = s.id and d.active) then
    raise exception 'a pay-out needs the till it comes out of' using errcode = '22023';
  end if;
  select coalesce(sum(amount), 0) into v_total from public.staff_tips where store_id = s.id and staff_id = v_staff and status = 'owed';
  if v_total = 0 then return 0; end if;
  select f.id into v_by from public.staff f where f.org_id = s.org_id and f.user_id = auth.uid() and f.active limit 1;
  update public.staff_tips set status = 'paid', paid_at = now(), paid_by = v_by, paid_device_id = v_dev
   where store_id = s.id and staff_id = v_staff and status = 'owed';
  perform public.audit_record(s.org_id, s.id, 'payment.refund', 'staff_tips', v_staff::text, jsonb_build_object('tips_paid_out', v_total), 'db');
  return v_total;
end $$;

-- ── the drawer counts cash tips in and tip pay-outs out ──
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
  v_exp := s.opening_cash + v_cash + v_topup + v_depin - v_depout + v_tipin - v_tipout;
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

revoke all on function public.set_commission_rate(jsonb), public.commission_report(jsonb), public.record_tip(jsonb), public.pay_out_tips(jsonb) from public, anon;
grant execute on function public.set_commission_rate(jsonb), public.commission_report(jsonb), public.record_tip(jsonb), public.pay_out_tips(jsonb) to authenticated, service_role;
