-- Bestie POS · migration 74 · Phase 4 start: the FOLIO (charge to room) for resorts (module `folio`, plan Resort, on by default for the resort profile).
--
--  * `folio_rooms` are the rooms / bungalows a resort lets. A STAY (`folios`) is a guest in one room from check-in to check-out; only one open stay per room.
--  * A bill of ANY outlet (restaurant, pool bar, spa, shop — they are all just shops of one business) can be CHARGED TO THE ROOM (`charge_order_to_room`): the bill is closed with
--    ONE payment of the new tender `room`, gets its own receipt in the device's server "+" series (the sale and its VAT are recognised there, as for any sale), and becomes a
--    line on the stay (`folio_charges`). Room charges are exact (no cash rounding) and earn no Points (nothing was paid yet).
--  * CHECK-OUT (`folio_settle`): the guest pays what the stay owes, once, by cash (into a named till: the shift counts it), bank transfer or card on the resort's own terminal
--    (recorded only), and the stay closes. A mistaken charge is voided by a manager (`folio_void_charge`, `refund.create`, reason, critical audit); the receipt stays as history.
--  * NOT built: returns on a bill charged to a room (the return routes refuse it), a room rate / night charge, a PMS link, charging a part of a bill.
--
-- The money rule that did not change: only a server function says "paid"; here the server function is the closing itself, never the browser.

alter table public.payments drop constraint payments_tender_check;
alter table public.payments add constraint payments_tender_check check (tender in ('cash', 'promptpay', 'gateway', 'credit', 'points', 'room'));

create table public.folio_rooms (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 40),
  sort       integer not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (store_id, name)
);
create table public.folios (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  room_id     uuid not null references public.folio_rooms (id) on delete restrict,
  guest_name  text not null check (length(btrim(guest_name)) between 1 and 80),
  phone       text check (phone is null or length(phone) <= 30),
  customer_id uuid references public.customers (id) on delete set null,
  check_in_at timestamptz not null default now(),
  check_out_on date,
  note        text check (note is null or length(note) <= 300),
  status      text not null default 'open' check (status in ('open', 'closed')),
  closed_at   timestamptz,
  created_by  uuid references public.staff (id) on delete set null,
  created_at  timestamptz not null default now(),
  check ((status = 'open') = (closed_at is null))
);
create unique index folios_one_open_per_room on public.folios (room_id) where status = 'open';
create index folios_store_idx on public.folios (store_id, status);
create table public.folio_charges (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs (id) on delete cascade,
  store_id       uuid not null references public.stores (id) on delete cascade,   -- the outlet that sold it
  folio_id       uuid not null references public.folios (id) on delete cascade,
  order_id       uuid not null unique references public.orders (id),
  amount         bigint not null check (amount > 0),
  receipt_number text,
  voided_at      timestamptz,
  void_reason    text check (void_reason is null or length(void_reason) <= 200),
  created_by     uuid references public.staff (id) on delete set null,
  created_at     timestamptz not null default now(),
  check ((voided_at is null) = (void_reason is null))
);
create index folio_charges_folio_idx on public.folio_charges (folio_id);
create table public.folio_settlements (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  folio_id   uuid not null unique references public.folios (id) on delete cascade,
  amount     bigint not null check (amount >= 0),
  method     text not null check (method in ('cash', 'transfer', 'card', 'none')),
  device_id  uuid references public.devices (id),
  reference  text check (reference is null or length(reference) <= 100),
  created_by uuid references public.staff (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((method = 'none') = (amount = 0)),
  check (method <> 'cash' or device_id is not null)
);

alter table public.folio_rooms enable row level security;
alter table public.folios enable row level security;
alter table public.folio_charges enable row level security;
alter table public.folio_settlements enable row level security;
create policy folio_rooms_read on public.folio_rooms for select to authenticated using (public.is_org_member(org_id));
create policy folios_read on public.folios for select to authenticated using (public.is_org_member(org_id));
-- a stay is read by every member of the business (any outlet charges to it): the charges and the settlement too
create policy folio_charges_read on public.folio_charges for select to authenticated using (public.is_org_member(org_id));
create policy folio_settlements_read on public.folio_settlements for select to authenticated using (public.is_org_member(org_id));
revoke all on public.folio_rooms, public.folios, public.folio_charges, public.folio_settlements from anon, authenticated;
grant select on public.folio_rooms, public.folios, public.folio_charges, public.folio_settlements to authenticated;
create trigger folios_live after insert or update on public.folios for each row execute function public.live_ping_row('store:{store_id}');
create trigger folio_charges_live after insert or update on public.folio_charges for each row execute function public.live_ping_row('org:{org_id}');

-- now the cash drawer counts the cash settlements (the function text was prepared above; create it from the changed text)
do $$
declare r record; src text; dst text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'close_shift' loop
    src := pg_get_functiondef(r.oid);
    dst := replace(src, 'v_tipout - v_ret;', $a$v_tipout - v_ret
    + (select coalesce(sum(fs.amount), 0) from public.folio_settlements fs
        where fs.device_id = s.device_id and fs.method = 'cash' and fs.created_at >= s.opened_at and fs.created_at <= v_close);$a$);
    if dst = src then raise exception 'migration 74: close_shift not changed'; end if;
    execute dst;
  end loop;
end $$;

-- ── the module switch (SQL mirror of the registry entry) ─────────────────────
create or replace function public.folio_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stores s
                  where s.id = p_store and s.deleted_at is null and s.plan = 'resort'
                    and coalesce((s.module_overrides ->> 'folio')::boolean, s.profile = 'resort'))
$$;
revoke all on function public.folio_enabled(uuid) from public, anon;
grant execute on function public.folio_enabled(uuid) to authenticated, service_role;

-- ── rooms and stays ──────────────────────────────────────────────────────────
-- p = { store_id, id?, name, sort?, active? }   (menu.edit)
create or replace function public.save_folio_room(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_edit_menu(s.id) then raise exception 'editing rooms needs menu.edit in this shop' using errcode = '42501'; end if;
  if not public.folio_enabled(s.id) then raise exception 'the folio module is off in this shop' using errcode = '0A000'; end if;
  if v_id is null then
    insert into public.folio_rooms (org_id, store_id, name, sort, active)
    values (s.org_id, s.id, btrim(p ->> 'name'), coalesce((p ->> 'sort')::integer, 0), coalesce((p ->> 'active')::boolean, true)) returning id into v_id;
  else
    update public.folio_rooms set name = coalesce(btrim(p ->> 'name'), name), sort = coalesce((p ->> 'sort')::integer, sort), active = coalesce((p ->> 'active')::boolean, active)
     where id = v_id and store_id = s.id;
    if not found then raise exception 'unknown room' using errcode = '22023'; end if;
  end if;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'folio_rooms', v_id::text, jsonb_build_object('active', p -> 'active'), 'db');
  return v_id;
end $$;

-- p = { store_id (the resort / front desk shop that owns the room), room_id, guest_name, phone?, customer_id?, check_out_on?, note? }   (order.create)
create or replace function public.folio_check_in(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.folio_rooms%rowtype; v_staff uuid; v_id uuid;
begin
  select * into r from public.folio_rooms where id = (p ->> 'room_id')::uuid and store_id = (p ->> 'store_id')::uuid for update;
  if not found or not (public.can_access_store(r.org_id, r.store_id) and public.has_permission(r.org_id, 'order.create')) then
    raise exception 'checking in needs order.create in this shop' using errcode = '42501';
  end if;
  if not public.folio_enabled(r.store_id) then raise exception 'the folio module is off in this shop' using errcode = '0A000'; end if;
  if not r.active then raise exception 'this room is switched off' using errcode = '55000'; end if;
  if exists (select 1 from public.folios f where f.room_id = r.id and f.status = 'open') then raise exception 'this room already has a guest' using errcode = '55000'; end if;
  if nullif(p ->> 'customer_id', '') is not null and not exists (select 1 from public.customers c where c.id = (p ->> 'customer_id')::uuid and c.org_id = r.org_id) then
    raise exception 'unknown member' using errcode = '22023';
  end if;
  select f.id into v_staff from public.staff f where f.org_id = r.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.folios (org_id, store_id, room_id, guest_name, phone, customer_id, check_out_on, note, created_by)
  values (r.org_id, r.store_id, r.id, btrim(p ->> 'guest_name'), nullif(btrim(coalesce(p ->> 'phone', '')), ''), nullif(p ->> 'customer_id', '')::uuid,
          nullif(p ->> 'check_out_on', '')::date, nullif(btrim(coalesce(p ->> 'note', '')), ''), v_staff) returning id into v_id;
  return v_id;
end $$;

-- ── charge a bill to a stay ──────────────────────────────────────────────────
-- the same snapshot the till sends for any closing, plus { folio_id, payment_id }; the payable is charged in full
create or replace function public.charge_order_to_room(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders%rowtype; v_store public.stores%rowtype; v_dev public.devices%rowtype; f public.folios%rowtype;
  v_staff uuid := nullif(p ->> 'staff_id', '')::uuid; v_pay uuid := (p ->> 'payment_id')::uuid;
  v_sub bigint; v_total bigint := (p ->> 'total')::bigint; v_payable bigint := (p ->> 'payable')::bigint; v_no text; v_old public.receipts%rowtype; v_charge uuid;
begin
  select * into v_order from public.orders where id = (p ->> 'order_id')::uuid for update;
  if not found then raise exception 'order not found' using errcode = 'P0002'; end if;
  if not (public.has_permission(v_order.org_id, 'payment.take') and public.can_access_store(v_order.org_id, v_order.store_id)) then
    raise exception 'taking payment needs payment.take' using errcode = '42501';
  end if;
  -- the same request again: the receipt it already made
  if exists (select 1 from public.payments py where py.id = v_pay and py.order_id = v_order.id) then
    select r.* into v_old from public.receipts r where r.order_id = v_order.id;
    return jsonb_build_object('receipt_number', v_old.number, 'replay', true);
  end if;
  if v_order.status in ('paid', 'void') then raise exception 'order is already closed' using errcode = '23514'; end if;
  select * into v_store from public.stores where id = v_order.store_id;
  select * into f from public.folios where id = (p ->> 'folio_id')::uuid for update;
  if not found or f.org_id <> v_order.org_id or f.status <> 'open' then raise exception 'there is no open stay to charge' using errcode = '55000'; end if;
  if not public.folio_enabled(f.store_id) then raise exception 'the folio module is off in the resort shop' using errcode = '0A000'; end if;
  select * into v_dev from public.devices d where d.id = (p ->> 'device_id')::uuid and d.store_id = v_order.store_id and d.active;
  if not found then raise exception 'device is not part of this shop' using errcode = '23514'; end if;
  if public.order_held_total(v_order.id) > 0 then raise exception 'a bill with money already paid on it cannot be charged to a room' using errcode = '55000'; end if;
  select coalesce(sum(l.unit_price::bigint * l.quantity), 0) into v_sub from public.order_lines l where l.order_id = v_order.id and l.status <> 'void';
  if v_sub <> (p ->> 'subtotal')::bigint then raise exception 'the bill changed since it was shown' using errcode = '23514'; end if;
  if v_payable <> v_total or coalesce((p ->> 'rounding')::integer, 0) <> 0 or v_payable <= 0 then raise exception 'totals do not add up' using errcode = '23514'; end if;
  if exists (select 1 from public.order_lines l where l.order_id = v_order.id and l.status = 'new') then
    raise exception 'send the new lines to the kitchen first' using errcode = '55000';
  end if;
  if v_staff is not null and not exists (select 1 from public.staff s where s.id = v_staff and s.org_id = v_order.org_id) then v_staff := null; end if;

  update public.devices set online_receipt_seq = online_receipt_seq + 1 where id = v_dev.id returning * into v_dev;
  v_no := v_dev.code || '+' || lpad(v_dev.online_receipt_seq::text, 6, '0');
  perform public.finalize_order_payment(v_order.id, v_dev.id, v_staff, v_no, coalesce((p ->> 'issued_at')::timestamptz, now()), p,
    jsonb_build_array(jsonb_build_object('id', v_pay, 'tender', 'room', 'amount', v_payable, 'reference', 'folio:' || f.id)));
  insert into public.folio_charges (org_id, store_id, folio_id, order_id, amount, receipt_number, created_by)
  values (v_order.org_id, v_order.store_id, f.id, v_order.id, v_payable, v_no, v_staff) returning id into v_charge;
  perform public.audit_record(v_order.org_id, v_order.store_id, 'payment.tender', 'folio_charges', v_charge::text, jsonb_build_object('tender', 'room', 'amount', v_payable, 'folio', f.id), 'db');
  return jsonb_build_object('receipt_number', v_no, 'replay', false, 'charge_id', v_charge);
end $$;

-- what the stay owes now (charges not voided)
create or replace function public.folio_balance(p_folio uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select case when exists (select 1 from public.folios f where f.id = p_folio and public.is_org_member(f.org_id))
              then (select coalesce(sum(c.amount), 0) from public.folio_charges c where c.folio_id = p_folio and c.voided_at is null) else 0 end
$$;
revoke all on function public.folio_balance(uuid) from public, anon;
grant execute on function public.folio_balance(uuid) to authenticated, service_role;

-- a manager takes a mistaken charge off an OPEN stay (the receipt of the bill stays as history; a credit note, if one is needed, is the accountant's)
create or replace function public.folio_void_charge(p_charge uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.folio_charges%rowtype; f public.folios%rowtype;
begin
  select * into c from public.folio_charges where id = p_charge for update;
  if not found or not (public.can_access_store(c.org_id, c.store_id) and public.has_permission(c.org_id, 'refund.create')) then
    raise exception 'taking a charge off needs refund.create' using errcode = '42501';
  end if;
  if c.voided_at is not null then return; end if;
  select * into f from public.folios where id = c.folio_id;
  if f.status <> 'open' then raise exception 'the stay is already closed' using errcode = '55000'; end if;
  if length(btrim(coalesce(p_reason, ''))) not between 3 and 200 then raise exception 'a reason is needed' using errcode = '22023'; end if;
  update public.folio_charges set voided_at = now(), void_reason = btrim(p_reason) where id = c.id;
  perform public.audit_record(c.org_id, c.store_id, 'payment.refund', 'folio_charges', c.id::text, jsonb_build_object('amount', c.amount, 'folio', c.folio_id, 'reason', btrim(p_reason)), 'db');
end $$;

-- check-out: the guest pays what the stay owes, once; p = { folio_id, method, device_id?, reference? }   (payment.take)
create or replace function public.folio_settle(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f public.folios%rowtype; v_amt bigint; v_method text := p ->> 'method'; v_dev uuid := nullif(p ->> 'device_id', '')::uuid; v_staff uuid;
begin
  select * into f from public.folios where id = (p ->> 'folio_id')::uuid for update;
  if not found or not (public.can_access_store(f.org_id, f.store_id) and public.has_permission(f.org_id, 'payment.take')) then
    raise exception 'checking out needs payment.take in this shop' using errcode = '42501';
  end if;
  if f.status <> 'open' then raise exception 'the stay is already closed' using errcode = '55000'; end if;
  v_amt := public.folio_balance(f.id);
  if v_amt = 0 then v_method := 'none'; end if;
  if v_method not in ('cash', 'transfer', 'card', 'none') then raise exception 'unknown way to pay' using errcode = '22023'; end if;
  if v_method = 'none' and v_amt > 0 then raise exception 'the stay still owes money' using errcode = '22023'; end if;
  if v_method = 'cash' and (v_dev is null or not exists (select 1 from public.devices d where d.id = v_dev and d.store_id = f.store_id and d.active)) then
    raise exception 'cash goes into a till of this shop' using errcode = '22023';
  end if;
  if v_method <> 'cash' then v_dev := null; end if;
  select s.id into v_staff from public.staff s where s.org_id = f.org_id and s.user_id = auth.uid() and s.active limit 1;
  insert into public.folio_settlements (org_id, store_id, folio_id, amount, method, device_id, reference, created_by)
  values (f.org_id, f.store_id, f.id, v_amt, v_method, v_dev, left(nullif(btrim(coalesce(p ->> 'reference', '')), ''), 100), v_staff);
  update public.folios set status = 'closed', closed_at = now() where id = f.id;
  perform public.audit_record(f.org_id, f.store_id, 'payment.tender', 'folios', f.id::text, jsonb_build_object('tender', 'folio_settlement', 'method', v_method, 'amount', v_amt), 'db');
  return jsonb_build_object('amount', v_amt, 'method', v_method);
end $$;

revoke all on function public.save_folio_room(jsonb), public.folio_check_in(jsonb), public.charge_order_to_room(jsonb), public.folio_void_charge(uuid, text), public.folio_settle(jsonb) from public, anon;
grant execute on function public.save_folio_room(jsonb), public.folio_check_in(jsonb), public.charge_order_to_room(jsonb), public.folio_void_charge(uuid, text), public.folio_settle(jsonb) to authenticated, service_role;
