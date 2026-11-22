-- Bestie POS · migration 88 · TOURS ONLINE (owner order 22 Nov): guests book tour seats themselves from a link, and tour deposits may be CASH that the shift's drawer count includes.
-- Same shape as the karaoke online booking: one random link per shop, rules as data, a cancel code shown once, nothing is paid online (the front desk records the deposit when it arrives),
-- an unpaid online booking is released after its hold time. Money is integer satang.

-- ══ module tours.online ════════════════════════════════════════════════════════════════════════════
do $$
declare r record; src text; dst text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'stores_check_modules' loop
    src := pg_get_functiondef(r.oid);
    dst := replace(src, $a$'waitlist','timeclock'];$a$, $a$'waitlist','timeclock','tours.online'];$a$);
    if dst = src then raise exception 'migration 88: stores_check_modules not changed'; end if;
    execute dst;
  end loop;
end $$;
create or replace function public.tours_online_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.slots_enabled(p_store) and not public.module_killed('tours.online') and exists (
    select 1 from public.stores s where s.id = p_store and s.deleted_at is null and s.plan in ('pro', 'resort')
       and coalesce((s.module_overrides ->> 'tours.online')::boolean, false))
$$;
revoke all on function public.tours_online_enabled(uuid) from public, anon;
grant execute on function public.tours_online_enabled(uuid) to authenticated, service_role;
insert into public.platform_flag_enforced (module_id) values ('tours.online') on conflict do nothing;

-- ══ data ═══════════════════════════════════════════════════════════════════════════════════════════
alter table public.stores add column tour_token text unique check (tour_token is null or tour_token ~ '^[0-9a-f]{32}$');
alter table public.stores add column tour_booking_settings jsonb not null default '{}'::jsonb check (jsonb_typeof(tour_booking_settings) = 'object');
alter table public.tour_bookings add column source text not null default 'staff' check (source in ('staff', 'online'));
alter table public.tour_bookings add column cancel_hash text;
alter table public.tour_bookings add column hold_until timestamptz;
alter table public.tour_bookings add column deposit_due bigint not null default 0 check (deposit_due >= 0);

-- a deposit is its own record (several per booking, any method), so the drawer can count the cash ones when they were taken
create table public.tour_deposits (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.orgs (id) on delete cascade,
  store_id            uuid not null references public.stores (id) on delete cascade,
  booking_id          uuid not null references public.tour_bookings (id) on delete cascade,
  amount              bigint not null check (amount > 0),
  method              text not null check (method in ('cash', 'promptpay', 'gateway')),
  device_id           uuid references public.devices (id),           -- the till for cash
  status              text not null default 'held' check (status in ('held', 'on_bill', 'refunded', 'forfeited')),
  order_id            uuid references public.orders (id),
  created_by          uuid references public.staff (id),
  created_at          timestamptz not null default now(),
  resolved_at         timestamptz,
  refunded_device_id  uuid references public.devices (id),
  check (method <> 'cash' or device_id is not null)
);
create index tour_deposits_booking_idx on public.tour_deposits (booking_id);
alter table public.tour_deposits enable row level security;
create policy tour_deposits_read on public.tour_deposits for select to authenticated using (public.can_access_store(org_id, store_id) and public.has_permission(org_id, 'order.create'));
revoke all on public.tour_deposits from anon, authenticated;
grant select on public.tour_deposits to authenticated;
-- what was already taken (promptpay / card) becomes deposit records
insert into public.tour_deposits (org_id, store_id, booking_id, amount, method, status, order_id)
select b.org_id, b.store_id, b.id, b.deposit, b.deposit_method, case when b.order_id is not null then 'on_bill' else 'held' end, b.order_id
  from public.tour_bookings b where b.deposit > 0 and b.deposit_method in ('promptpay', 'gateway');

create or replace function public.tour_deposit_held(p_booking uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(amount), 0)::bigint from public.tour_deposits where booking_id = p_booking and status in ('held', 'on_bill')
$$;
revoke all on function public.tour_deposit_held(uuid) from public, anon;
grant execute on function public.tour_deposit_held(uuid) to authenticated, service_role;

-- ══ staff side: deposits (cash too), the bill, settling a deposit ════════════════════════════════════
-- p = { booking_id, amount, method: promptpay | gateway | cash, device_id? }   (payment.take; cash names the till)
create or replace function public.take_tour_deposit(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.tour_bookings%rowtype; t public.tour_slots%rowtype; v_amt bigint := (p ->> 'amount')::bigint; v_m text := p ->> 'method'; v_dev uuid := nullif(p ->> 'device_id', '')::uuid; v_staff uuid;
begin
  select * into b from public.tour_bookings where id = (p ->> 'booking_id')::uuid for update;
  if not found or not (public.can_access_store(b.org_id, b.store_id) and public.has_permission(b.org_id, 'payment.take')) then
    raise exception 'a deposit needs payment.take in this shop' using errcode = '42501';
  end if;
  select * into t from public.tour_slots where id = b.slot_id;
  if b.status <> 'booked' or v_m not in ('promptpay', 'gateway', 'cash') or v_amt is null or v_amt <= 0 then raise exception 'a deposit cannot be taken now' using errcode = '55000'; end if;
  if v_m = 'cash' and not exists (select 1 from public.devices d where d.id = v_dev and d.store_id = b.store_id and d.active) then raise exception 'a cash deposit goes into a till of this shop' using errcode = '22023'; end if;
  if public.tour_deposit_held(b.id) + v_amt > t.price * b.seats then raise exception 'the deposit is more than the price' using errcode = '22023'; end if;
  select f.id into v_staff from public.staff f where f.org_id = b.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.tour_deposits (org_id, store_id, booking_id, amount, method, device_id, created_by) values (b.org_id, b.store_id, b.id, v_amt, v_m, case when v_m = 'cash' then v_dev end, v_staff);
  update public.tour_bookings set deposit = public.tour_deposit_held(b.id), deposit_method = case when v_m = 'cash' then deposit_method else v_m end where id = b.id;
  perform public.audit_record(b.org_id, b.store_id, 'payment.tender', 'tour_bookings', b.id::text, jsonb_build_object('deposit', v_amt, 'method', v_m), 'db');
end $$;

-- the bill: seats × price, every held deposit already paid on it
create or replace function public.tour_to_order(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b public.tour_bookings%rowtype; t public.tour_slots%rowtype; d public.tour_deposits%rowtype; v_dev uuid := nullif(p ->> 'device_id', '')::uuid; v_order uuid; v_no integer; v_staff uuid; v_left bigint;
begin
  select * into b from public.tour_bookings where id = (p ->> 'booking_id')::uuid for update;
  if not found or not (public.can_access_store(b.org_id, b.store_id) and public.has_permission(b.org_id, 'order.create')) then
    raise exception 'billing a tour needs order.create in this shop' using errcode = '42501';
  end if;
  if b.order_id is not null and exists (select 1 from public.orders o where o.id = b.order_id and o.status <> 'void') then return b.order_id; end if;
  if b.status <> 'checked_in' then raise exception 'check the guests in first' using errcode = '55000'; end if;
  select * into t from public.tour_slots where id = b.slot_id;
  if v_dev is not null and not exists (select 1 from public.devices x where x.id = v_dev and x.store_id = b.store_id and x.active) then v_dev := null; end if;
  select coalesce(max(substr(o.number, 3)::integer), 0) + 1 into v_no from public.orders o
   where o.store_id = b.store_id and o.business_date = (now() at time zone 'Asia/Bangkok')::date and o.number ~ '^TB[0-9]+$';
  select f.id into v_staff from public.staff f where f.org_id = b.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.orders (org_id, store_id, number, business_date, channel, status, note, opened_by, device_id, customer_id)
  values (b.org_id, b.store_id, 'TB' || lpad(v_no::text, 3, '0'), (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'open', left('Tour: ' || b.guest_name, 300), v_staff, v_dev, b.customer_id)
  returning id into v_order;
  insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, status, sent_at)
  values (b.org_id, b.store_id, v_order, null, t.title, t.price::integer, b.seats, 'sent', now());
  v_left := t.price * b.seats;
  for d in select * from public.tour_deposits where booking_id = b.id and status = 'held' order by created_at loop
    exit when v_left <= 0;
    insert into public.order_partial_payments (id, org_id, store_id, order_id, tender, amount, provider_ref, kind, note)
    values (d.id, d.org_id, d.store_id, v_order, d.method, least(d.amount, v_left), 'deposit:' || d.id, 'deposit', 'deposit');
    v_left := v_left - least(d.amount, v_left);
    update public.tour_deposits set status = 'on_bill', order_id = v_order where id = d.id;
  end loop;
  update public.tour_bookings set order_id = v_order where id = b.id;
  return v_order;
end $$;

-- a cancelled / no-show booking's deposit is kept as a fee or given back by a manager (cash comes out of a named till)   p = { deposit_id, action: forfeit | refund, device_id? }
create or replace function public.resolve_tour_deposit(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.tour_deposits%rowtype; b public.tour_bookings%rowtype; v_act text := p ->> 'action'; v_dev uuid := nullif(p ->> 'device_id', '')::uuid;
begin
  select * into d from public.tour_deposits where id = (p ->> 'deposit_id')::uuid for update;
  if not found or not (public.can_access_store(d.org_id, d.store_id) and public.has_permission(d.org_id, 'refund.create')) then
    raise exception 'settling a deposit needs refund.create in this shop' using errcode = '42501';
  end if;
  select * into b from public.tour_bookings where id = d.booking_id;
  if d.status <> 'held' or b.status not in ('cancelled', 'no_show') or v_act not in ('forfeit', 'refund') then raise exception 'this deposit cannot be settled now' using errcode = '55000'; end if;
  if v_act = 'refund' and d.method = 'cash' and not exists (select 1 from public.devices x where x.id = v_dev and x.store_id = d.store_id and x.active) then
    raise exception 'a cash refund comes out of a till of this shop' using errcode = '22023';
  end if;
  update public.tour_deposits set status = case v_act when 'refund' then 'refunded' else 'forfeited' end, resolved_at = now(),
         refunded_device_id = case when v_act = 'refund' and d.method = 'cash' then v_dev end where id = d.id;
  update public.tour_bookings set deposit = public.tour_deposit_held(b.id) where id = b.id;
  perform public.audit_record(d.org_id, d.store_id, 'payment.refund', 'tour_deposits', d.id::text, jsonb_build_object('action', v_act, 'amount', d.amount, 'method', d.method), 'db');
end $$;
revoke all on function public.take_tour_deposit(jsonb), public.tour_to_order(jsonb), public.resolve_tour_deposit(jsonb) from public, anon;
grant execute on function public.take_tour_deposit(jsonb), public.tour_to_order(jsonb), public.resolve_tour_deposit(jsonb) to authenticated, service_role;

-- the drawer: cash tour deposits taken at the till come in, refunded ones go out (an applied deposit is not counted twice: its bill share carries reference 'deposit:…')
do $$
declare r record; src text; dst text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'close_shift' loop
    src := pg_get_functiondef(r.oid);
    dst := replace(src, 'and kd.resolved_at >= s.opened_at and kd.resolved_at <= v_close);', $a$and kd.resolved_at >= s.opened_at and kd.resolved_at <= v_close)
    + (select coalesce(sum(td.amount), 0) from public.tour_deposits td
        where td.device_id = s.device_id and td.method = 'cash' and td.created_at >= s.opened_at and td.created_at <= v_close)
    - (select coalesce(sum(td.amount), 0) from public.tour_deposits td
        where td.refunded_device_id = s.device_id and td.method = 'cash' and td.status = 'refunded'
          and td.resolved_at >= s.opened_at and td.resolved_at <= v_close);$a$);
    if dst = src then raise exception 'migration 88: close_shift not changed'; end if;
    execute dst;
  end loop;
end $$;

-- ══ the booking link and its rules (owner) ═════════════════════════════════════════════════════════
create or replace function public.tour_cfg(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'days_ahead', least(greatest(coalesce((p ->> 'days_ahead')::integer, 60), 1), 365),
    'notice_min', least(greatest(coalesce((p ->> 'notice_min')::integer, 120), 0), 20160),
    'deposit_pct', least(greatest(coalesce((p ->> 'deposit_pct')::integer, 30), 0), 100),
    'hold_min', least(greatest(coalesce((p ->> 'hold_min')::integer, 120), 15), 10080),
    'pay_note', left(coalesce(p ->> 'pay_note', ''), 300))
$$;
-- the owner reads the link and the rules (the token column itself is never selected by the browser)
create or replace function public.tour_link(p_store uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype;
begin
  select * into s from public.stores where id = p_store and deleted_at is null;
  if not found or not public.can_edit_menu(s.id) then raise exception 'the tour link needs menu.edit in this shop' using errcode = '42501'; end if;
  if s.tour_token is null then update public.stores set tour_token = replace(gen_random_uuid()::text, '-', '') where id = s.id returning * into s; end if;
  return jsonb_build_object('token', s.tour_token, 'settings', public.tour_cfg(s.tour_booking_settings), 'enabled', public.tours_online_enabled(s.id));
end $$;
create or replace function public.rotate_tour_token(p_store uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; v text := replace(gen_random_uuid()::text, '-', '');
begin
  select * into s from public.stores where id = p_store and deleted_at is null;
  if not found or not public.can_edit_menu(s.id) then raise exception 'the tour link needs menu.edit in this shop' using errcode = '42501'; end if;
  update public.stores set tour_token = v where id = s.id;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'stores', s.id::text, jsonb_build_object('tour_link_replaced', true), 'db');
  return v;
end $$;
create or replace function public.save_tour_booking_settings(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_edit_menu(s.id) then raise exception 'the tour link needs menu.edit in this shop' using errcode = '42501'; end if;
  update public.stores set tour_booking_settings = public.tour_cfg(p) where id = s.id;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'stores', s.id::text, jsonb_build_object('tour_booking_settings', true), 'db');
end $$;
revoke all on function public.tour_link(uuid), public.rotate_tour_token(uuid), public.save_tour_booking_settings(jsonb) from public, anon;
grant execute on function public.tour_link(uuid), public.rotate_tour_token(uuid), public.save_tour_booking_settings(jsonb) to authenticated, service_role;

-- ══ the guest side (service role only; the link token is the only key) ═══════════════════════════════
create or replace function public.tour_store(p_token text) returns public.stores
language sql stable security definer set search_path = '' as $$
  select s.* from public.stores s where s.tour_token = lower(btrim(coalesce(p_token, ''))) and s.deleted_at is null limit 1
$$;
-- the shop and its open slots with the seats left and what the deposit would be
create or replace function public.guest_tour_info(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype; v_cfg jsonb;
begin
  s := public.tour_store(p_token);
  if s.id is null then return null; end if;
  if not public.tours_online_enabled(s.id) then return jsonb_build_object('store_name', s.name, 'open', false); end if;
  v_cfg := public.tour_cfg(s.tour_booking_settings);
  return jsonb_build_object('open', true, 'store_name', s.name, 'settings', v_cfg,
    'slots', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'starts_at', t.starts_at, 'duration_min', t.duration_min, 'price', t.price,
                'seats_left', greatest(t.capacity - public.tour_seats_taken(t.id), 0), 'note', t.note,
                'deposit_per_seat', (t.price * (v_cfg ->> 'deposit_pct')::integer + 50) / 100) order by t.starts_at)
          from public.tour_slots t where t.store_id = s.id and t.status = 'open'
           and t.starts_at > now() + make_interval(mins => (v_cfg ->> 'notice_min')::integer)
           and t.starts_at < now() + make_interval(days => (v_cfg ->> 'days_ahead')::integer)), '[]'::jsonb));
end $$;

-- p = { slot_id, name, phone, seats, client_id }  → { ok, id, code (once), deposit_due, hold_until } | { ok:false, error }
create or replace function public.guest_tour_book(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype; t public.tour_slots%rowtype; b public.tour_bookings%rowtype; v_cfg jsonb; v_client uuid := nullif(p ->> 'client_id', '')::uuid; v_seats integer := (p ->> 'seats')::integer;
  v_phone text := regexp_replace(coalesce(p ->> 'phone', ''), '[^0-9]', '', 'g'); v_code text; v_due bigint; v_hold timestamptz;
begin
  s := public.tour_store(p_token);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not public.tours_online_enabled(s.id) then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  v_cfg := public.tour_cfg(s.tour_booking_settings);
  if v_client is not null then
    select * into b from public.tour_bookings where client_id = v_client and store_id = s.id and source = 'online';
    if found then return jsonb_build_object('ok', true, 'replay', true, 'id', b.id, 'deposit_due', b.deposit_due, 'hold_until', b.hold_until); end if;
  end if;
  if v_seats is null or v_seats < 1 or v_seats > 20 or length(btrim(coalesce(p ->> 'name', ''))) not between 1 and 80 or length(v_phone) not between 8 and 15 then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  select * into t from public.tour_slots where id = (p ->> 'slot_id')::uuid and store_id = s.id for update;
  if not found or t.status <> 'open' then return jsonb_build_object('ok', false, 'error', 'unavailable'); end if;
  if t.starts_at <= now() + make_interval(mins => (v_cfg ->> 'notice_min')::integer) or t.starts_at >= now() + make_interval(days => (v_cfg ->> 'days_ahead')::integer) then
    return jsonb_build_object('ok', false, 'error', 'unavailable');
  end if;
  if (select count(*) from public.tour_bookings x where x.store_id = s.id and x.source = 'online' and x.created_at > now() - interval '10 minutes') >= 12 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  if (select count(*) from public.tour_bookings x join public.tour_slots y on y.id = x.slot_id where x.store_id = s.id and x.phone = v_phone and x.status = 'booked' and y.starts_at > now()) >= 3 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  if public.tour_seats_taken(t.id) + v_seats > t.capacity then return jsonb_build_object('ok', false, 'error', 'full'); end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  v_due := (t.price * v_seats * (v_cfg ->> 'deposit_pct')::integer + 50) / 100;
  v_hold := case when v_due > 0 then least(now() + make_interval(mins => (v_cfg ->> 'hold_min')::integer), t.starts_at) end;
  insert into public.tour_bookings (org_id, store_id, slot_id, guest_name, phone, seats, client_id, source, cancel_hash, deposit_due, hold_until)
  values (s.org_id, s.id, t.id, btrim(p ->> 'name'), v_phone, v_seats, v_client, 'online', encode(sha256(convert_to(v_code, 'utf8')), 'hex'), v_due, v_hold) returning * into b;
  begin
    perform public.notify_managers(s.org_id, s.id, jsonb_build_object('kind', 'tour.online', 'href', '/tours', 'dedupe', 'tour-online:' || b.id,
      'title', jsonb_build_object('th', 'มีคนจองทัวร์ออนไลน์', 'en', 'New online tour booking'),
      'body', jsonb_build_object('th', 'ทัวร์: ' || coalesce(t.title ->> 'th', '-') || E'\nลูกค้า: ' || b.guest_name || ' × ' || b.seats || E'\nมัดจำที่ต้องรับ: ' || (v_due / 100) || ' บาท',
                                 'en', 'Tour: ' || coalesce(t.title ->> 'en', t.title ->> 'th', '-') || E'\nGuest: ' || b.guest_name || ' x ' || b.seats || E'\nDeposit due: ' || (v_due / 100) || ' THB')));
  exception when others then
    raise warning 'tour online notice failed: %', sqlerrm;
  end;
  return jsonb_build_object('ok', true, 'id', b.id, 'code', v_code, 'deposit_due', v_due, 'hold_until', v_hold);
end $$;

-- p_id + the cancel code prove the booking is hers
create or replace function public.guest_tour_status(p_token text, p_id uuid, p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype; b public.tour_bookings%rowtype;
begin
  s := public.tour_store(p_token);
  if s.id is null then return null; end if;
  select * into b from public.tour_bookings where id = p_id and store_id = s.id and source = 'online'
     and cancel_hash = encode(sha256(convert_to(upper(btrim(coalesce(p_code, ''))), 'utf8')), 'hex');
  if not found then return null; end if;
  return jsonb_build_object('status', b.status, 'seats', b.seats, 'deposit_due', b.deposit_due, 'deposit_received', public.tour_deposit_held(b.id), 'hold_until', b.hold_until,
    'starts_at', (select starts_at from public.tour_slots where id = b.slot_id), 'title', (select title from public.tour_slots where id = b.slot_id));
end $$;
create or replace function public.guest_tour_cancel(p_token text, p_id uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; b public.tour_bookings%rowtype; v_start timestamptz;
begin
  s := public.tour_store(p_token);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select * into b from public.tour_bookings where id = p_id and store_id = s.id and source = 'online'
     and cancel_hash = encode(sha256(convert_to(upper(btrim(coalesce(p_code, ''))), 'utf8')), 'hex') for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select starts_at into v_start from public.tour_slots where id = b.slot_id;
  if b.status <> 'booked' or v_start <= now() then return jsonb_build_object('ok', false, 'error', 'too_late'); end if;
  update public.tour_bookings set status = 'cancelled' where id = b.id;
  -- any deposit already received stays HELD until a manager decides (refund or keep as a fee) under the shop's own policy
  return jsonb_build_object('ok', true, 'deposit_received', public.tour_deposit_held(b.id));
end $$;
revoke all on function public.tour_store(text), public.guest_tour_info(text), public.guest_tour_book(text, jsonb), public.guest_tour_status(text, uuid, text), public.guest_tour_cancel(text, uuid, text) from public, anon, authenticated;
grant execute on function public.tour_store(text), public.guest_tour_info(text), public.guest_tour_book(text, jsonb), public.guest_tour_status(text, uuid, text), public.guest_tour_cancel(text, uuid, text) to service_role;

-- the tick: an online booking whose deposit did not arrive in time is released (its seats are free again)
create or replace function public.tour_release_unpaid() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.tour_bookings b set status = 'cancelled'
   where b.source = 'online' and b.status = 'booked' and b.deposit_due > 0 and b.hold_until is not null and b.hold_until < now()
     and public.tour_deposit_held(b.id) < b.deposit_due;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.tour_release_unpaid() from public, anon, authenticated;
grant execute on function public.tour_release_unpaid() to service_role;

-- ══ the time clock for every role that shows its card (role audit, 22 Nov) ═════════════════════════════
-- The kitchen role has no order.create, yet its home now carries the time clock: let kds.use (the kitchen screen's account) punch in and out and see who is in, like a till.
do $$
declare r record; src text; dst text; n integer := 0;
begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('clock_toggle', 'time_status') loop
    src := pg_get_functiondef(r.oid);
    dst := replace(src, $a$public.has_permission(s.org_id, 'order.create')$a$,
                        $a$(public.has_permission(s.org_id, 'order.create') or public.has_permission(s.org_id, 'kds.use'))$a$);
    if dst = src then raise exception 'migration 88: % not changed', r.proname; end if;
    execute dst;
    n := n + 1;
  end loop;
  if n <> 2 then raise exception 'migration 88: expected 2 clock functions, patched %', n; end if;
end $$;
