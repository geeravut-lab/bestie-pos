-- Bestie POS · migration 53 · PACKAGES / MEMBERSHIPS (module `packages`): "10 visits for the price of 8".
--
--  * `service_packages`: what the shop sells — a name, a price, a number of visits and (optionally) how many days they stay valid.
--  * SELLING (`sell_package`): the package is sold on an ordinary bill (`PK001…`, one line, the member attached) that the till pays like
--    any bill. The member's package starts as `pending`; when the bill is PAID it becomes `active` and the validity starts from that day
--    (Bangkok); a voided bill cancels it. A package belongs to ONE member and has no cash value (never refunded here, never transferred).
--  * USING (`use_package`): on a booking of that member that has started (arrived / in service / done) and is not already billed, one
--    visit is taken off, the appointment is marked done, and a row is added to the append-only `package_uses` (what the visit was worth:
--    price ÷ visits). A manager can undo a mistaken use (`undo_package_use`): the visit comes back, the appointment goes back to arrived.
--  * COMMISSION: a package visit counts as service sales of the stylist of that appointment, at the visit's value (the commission report
--    below replaces the one of migration 52 and adds package uses; an undone use subtracts).
--  Needs `order.create` to sell / use (front desk) and `refund.create` to undo. The accountant must say when package income is
--  recognised (at the sale, as here, or per visit).

-- registry:packages profiles=salon,spa plan=pro,resort
create or replace function public.packages_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.stores s
     where s.id = p_store and s.deleted_at is null and s.plan in ('pro', 'resort')
       and coalesce((s.module_overrides ->> 'packages')::boolean, s.profile in ('salon', 'spa')))
$$;
revoke all on function public.packages_enabled(uuid) from public, anon;
grant execute on function public.packages_enabled(uuid) to authenticated, service_role;

create table public.service_packages (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  name       jsonb not null check (jsonb_typeof(name) = 'object' and length(btrim(coalesce(name ->> 'th', ''))) between 1 and 80
                                   and (not name ? 'en' or length(name ->> 'en') <= 80)),
  price      bigint not null check (price between 100 and 100000000),
  visits     integer not null check (visits between 1 and 100),
  valid_days integer check (valid_days is null or valid_days between 1 and 3650),
  active     boolean not null default true,
  sort       integer not null default 0 check (sort between -100000 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index service_packages_store_idx on public.service_packages (store_id) where deleted_at is null;
create trigger service_packages_touch before update on public.service_packages for each row execute function public.touch_updated_at();

create table public.customer_packages (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs (id) on delete cascade,
  store_id     uuid not null references public.stores (id) on delete cascade,
  package_id   uuid references public.service_packages (id) on delete set null,
  customer_id  uuid not null references public.customers (id),
  name         jsonb not null,                                                -- snapshot
  price        bigint not null check (price >= 0),                            -- snapshot
  visits_total integer not null check (visits_total between 1 and 100),
  visits_left  integer not null check (visits_left >= 0),
  valid_days   integer,
  valid_until  date,                                                          -- set when the bill is paid
  status       text not null default 'pending' check (status in ('pending', 'active', 'used_up', 'cancelled')),
  order_id     uuid references public.orders (id),                            -- the bill the package was sold on
  sold_by      uuid references public.staff (id) on delete set null,
  created_at   timestamptz not null default now(),
  activated_at timestamptz,
  check (visits_left <= visits_total)
);
create index customer_packages_customer_idx on public.customer_packages (customer_id, status);
create index customer_packages_order_idx on public.customer_packages (order_id) where order_id is not null;

create table public.package_uses (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.orgs (id) on delete cascade,
  store_id            uuid not null references public.stores (id) on delete cascade,
  customer_package_id uuid not null references public.customer_packages (id),
  appointment_id      uuid references public.appointments (id),
  kind                text not null check (kind in ('use', 'undo')),
  value               bigint not null,                                        -- + for a use, − for an undo (satang)
  note                text check (note is null or length(note) <= 200),
  created_by          uuid references public.staff (id) on delete set null,
  created_at          timestamptz not null default now()
);
create index package_uses_pkg_idx on public.package_uses (customer_package_id, created_at);
create index package_uses_appt_idx on public.package_uses (appointment_id) where appointment_id is not null;
alter table public.appointments add column customer_package_id uuid references public.customer_packages (id);

alter table public.service_packages enable row level security;
alter table public.customer_packages enable row level security;
alter table public.package_uses enable row level security;
create policy service_packages_read on public.service_packages for select to authenticated using (public.can_access_store(org_id, store_id));
create policy service_packages_write on public.service_packages for all to authenticated
  using (public.can_edit_menu(store_id)) with check (public.can_edit_menu(store_id));
create policy customer_packages_read on public.customer_packages for select to authenticated using (public.can_access_store(org_id, store_id));
create policy package_uses_read on public.package_uses for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.service_packages, public.customer_packages, public.package_uses from anon, authenticated;
grant select, insert, update, delete on public.service_packages to authenticated;
grant select on public.customer_packages, public.package_uses to authenticated;
create trigger customer_packages_live after insert or update on public.customer_packages for each row execute function public.live_ping_row('store:{store_id}');

-- p = { store_id, package_id, customer_id, device_id? } → the bill (PK001…) to pay
create or replace function public.sell_package(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype;
  pk public.service_packages%rowtype;
  v_cust uuid := (p ->> 'customer_id')::uuid;
  v_dev uuid := nullif(p ->> 'device_id', '')::uuid;
  v_order uuid;
  v_no integer;
  v_staff uuid;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null for update;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'order.create')) then
    raise exception 'selling a package needs order.create in this shop' using errcode = '42501';
  end if;
  if not public.packages_enabled(s.id) then raise exception 'the packages module is off in this shop' using errcode = '0A000'; end if;
  select * into pk from public.service_packages where id = (p ->> 'package_id')::uuid and store_id = s.id and deleted_at is null and active;
  if not found then raise exception 'unknown or inactive package' using errcode = '22023'; end if;
  if not exists (select 1 from public.customers c where c.id = v_cust and c.org_id = s.org_id) then raise exception 'unknown member' using errcode = '22023'; end if;
  if v_dev is not null and not exists (select 1 from public.devices d where d.id = v_dev and d.store_id = s.id and d.active) then v_dev := null; end if;
  select coalesce(max(substr(o.number, 3)::integer), 0) + 1 into v_no from public.orders o
   where o.store_id = s.id and o.business_date = (now() at time zone 'Asia/Bangkok')::date and o.number ~ '^PK[0-9]+$';
  select f.id into v_staff from public.staff f where f.org_id = s.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.orders (org_id, store_id, number, business_date, channel, status, note, opened_by, device_id, customer_id)
  values (s.org_id, s.id, 'PK' || lpad(v_no::text, 3, '0'), (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'open',
          left('Package: ' || (pk.name ->> 'th'), 300), v_staff, v_dev, v_cust)
  returning id into v_order;
  insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, status, sent_at)
  values (s.org_id, s.id, v_order, null, pk.name, pk.price::integer, 1, 'sent', now());
  insert into public.customer_packages (org_id, store_id, package_id, customer_id, name, price, visits_total, visits_left, valid_days, order_id, sold_by)
  values (s.org_id, s.id, pk.id, v_cust, pk.name, pk.price, pk.visits, pk.visits, pk.valid_days, v_order, v_staff);
  return v_order;
end $$;

-- the package bill is paid → the package starts; the bill is void → the package is cancelled
create or replace function public.customer_packages_on_order() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'paid' then
    update public.customer_packages
       set status = 'active', activated_at = now(),
           valid_until = case when valid_days is null then null else (now() at time zone 'Asia/Bangkok')::date + valid_days end
     where order_id = new.id and status = 'pending';
  elsif new.status = 'void' then
    update public.customer_packages set status = 'cancelled' where order_id = new.id and status = 'pending';
  end if;
  return null;
end $$;
create trigger orders_customer_packages_trg after update of status on public.orders
  for each row when (new.status in ('paid', 'void') and old.status is distinct from new.status) execute function public.customer_packages_on_order();

-- p = { customer_package_id, appointment_id } — one visit of the package pays for this appointment
create or replace function public.use_package(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  cp public.customer_packages%rowtype;
  a public.appointments%rowtype;
  v_use uuid;
  v_staff uuid;
begin
  select * into a from public.appointments where id = (p ->> 'appointment_id')::uuid for update;
  if not found or not (public.can_access_store(a.org_id, a.store_id) and public.has_permission(a.org_id, 'order.create')) then
    raise exception 'using a package needs order.create in this shop' using errcode = '42501';
  end if;
  if not public.packages_enabled(a.store_id) then raise exception 'the packages module is off in this shop' using errcode = '0A000'; end if;
  select * into cp from public.customer_packages where id = (p ->> 'customer_package_id')::uuid for update;
  if not found or cp.org_id <> a.org_id then raise exception 'unknown package' using errcode = '22023'; end if;
  -- again for the same visit and package: the same answer
  if a.customer_package_id = cp.id then
    select id into v_use from public.package_uses where appointment_id = a.id and kind = 'use' and customer_package_id = cp.id order by created_at desc limit 1;
    return v_use;
  end if;
  if a.customer_id is distinct from cp.customer_id then raise exception 'this package belongs to another member' using errcode = '22023'; end if;
  if a.status not in ('arrived', 'in_service', 'done') then raise exception 'use a package once the guest has arrived' using errcode = '55000'; end if;
  if a.order_id is not null or a.customer_package_id is not null then raise exception 'this visit is already billed or covered' using errcode = '55000'; end if;
  if cp.status <> 'active' or cp.visits_left < 1 then raise exception 'this package has no visits to use' using errcode = '55000'; end if;
  if cp.valid_until is not null and cp.valid_until < (now() at time zone 'Asia/Bangkok')::date then raise exception 'this package has expired' using errcode = '55000'; end if;
  select f.id into v_staff from public.staff f where f.org_id = a.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.package_uses (org_id, store_id, customer_package_id, appointment_id, kind, value, created_by)
  values (a.org_id, a.store_id, cp.id, a.id, 'use', (cp.price + cp.visits_total / 2) / cp.visits_total, v_staff)
  returning id into v_use;
  update public.customer_packages set visits_left = visits_left - 1, status = case when visits_left - 1 = 0 then 'used_up' else status end where id = cp.id;
  update public.appointments set customer_package_id = cp.id, status = 'done' where id = a.id;
  return v_use;
end $$;

-- a manager takes back a mistaken use: the visit returns, the appointment is open again
create or replace function public.undo_package_use(p_use uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  u public.package_uses%rowtype;
  v_staff uuid;
begin
  select * into u from public.package_uses where id = p_use for update;
  if not found or not (public.can_access_store(u.org_id, u.store_id) and public.has_permission(u.org_id, 'refund.create')) then
    raise exception 'undoing a package visit needs refund.create' using errcode = '42501';
  end if;
  -- only the latest use of an appointment that is still covered by this package can be taken back
  if u.kind <> 'use'
     or not exists (select 1 from public.appointments a where a.id = u.appointment_id and a.customer_package_id = u.customer_package_id)
     or u.id <> (select x.id from public.package_uses x where x.appointment_id = u.appointment_id and x.kind = 'use' order by x.created_at desc limit 1) then
    raise exception 'this visit was already taken back' using errcode = '55000';
  end if;
  select f.id into v_staff from public.staff f where f.org_id = u.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.package_uses (org_id, store_id, customer_package_id, appointment_id, kind, value, created_by)
  values (u.org_id, u.store_id, u.customer_package_id, u.appointment_id, 'undo', -u.value, v_staff);
  update public.customer_packages set visits_left = visits_left + 1, status = case when status = 'used_up' then 'active' else status end where id = u.customer_package_id;
  update public.appointments set customer_package_id = null, status = 'arrived' where id = u.appointment_id and customer_package_id = u.customer_package_id;
  perform public.audit_record(u.org_id, u.store_id, 'payment.refund', 'package_uses', u.id::text, jsonb_build_object('visit_returned', true), 'db');
end $$;

revoke all on function public.sell_package(jsonb), public.use_package(jsonb), public.undo_package_use(uuid) from public, anon;
grant execute on function public.sell_package(jsonb), public.use_package(jsonb), public.undo_package_use(uuid) to authenticated, service_role;

-- ── commission: package visits are service sales of the stylist of the appointment ──
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
    union all
    -- a package visit (or its undo) is a service sale of the appointment's stylist, at the visit's value
    select pu.store_id, r.staff_id, true, pu.value
      from public.package_uses pu
      join st on st.id = pu.store_id
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
