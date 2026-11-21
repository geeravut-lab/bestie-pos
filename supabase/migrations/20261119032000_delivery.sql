-- Bestie POS · migration 77 · DELIVERY (LINE MAN / Grab / own delivery) and per-channel pricing (module `delivery`, plan Pro, off by default).
--
--  * PRICES BY CHANNEL already exist (a menu item's `prices` hold `base` and optional `dine-in` / `takeaway` / `delivery` / `qr`; an option's price change can differ per channel);
--    a delivery order uses the `delivery` price of every item, so a shop can price for the platform's commission.
--  * A PLATFORM (`delivery_platforms`) is a delivery channel the shop sells through: LINE MAN, Grab, its own riders or another one, with the commission the platform keeps
--    (basis points) and an INTAKE TOKEN (shown once, only its SHA-256 stored) for whatever sends the platform's orders to Bestie.
--  * A DELIVERY ORDER is an ordinary bill with channel `delivery`. The till opens one like any bill; `set_delivery_info` attaches the platform, the platform's own order number
--    (unique per platform), and the customer's name / phone / address. Or it arrives by itself through `delivery_intake`: a service-role function behind `/api/delivery/intake`
--    that checks the platform's token, matches every line to a menu item by id / barcode / SKU (an unknown item refuses the whole order: Bestie never invents a price), prices it
--    at the delivery channel price, stores it as an UNSENT bill `DL001…` and tells the managers. The same platform order number again returns the first answer.
--  * The platform pays the SHOP later, so the bill is closed with the new tender `platform` (`close_delivery_order`: exact amount, server "+" receipt series, no Points, never cash in
--    the drawer). The commission the platform keeps is worked out at closing and kept on the bill (`orders.commission_amount`); what the platform has paid out is recorded in
--    `delivery_payouts` (append-only). `delivery_report` shows, per platform and period: bills, gross, commission, net, paid out so far and what the platform still owes.
--  * No real LINE MAN / Grab API is called: their merchant APIs need a partner agreement and credentials. Whatever holds those (the platform's own tablet app, a partner
--    integrator, or a small script) posts to the intake in the format described in docs/DELIVERY.md.

-- registry:delivery profiles= plan=pro,resort depends=
create or replace function public.delivery_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stores s
                  where s.id = p_store and s.deleted_at is null and s.plan in ('pro', 'resort')
                    and coalesce((s.module_overrides ->> 'delivery')::boolean, false))
$$;
revoke all on function public.delivery_enabled(uuid) from public, anon;
grant execute on function public.delivery_enabled(uuid) to authenticated, service_role;

alter table public.payments drop constraint payments_tender_check;
alter table public.payments add constraint payments_tender_check check (tender in ('cash', 'promptpay', 'gateway', 'credit', 'points', 'room', 'platform'));

create table public.delivery_platforms (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs (id) on delete cascade,
  store_id       uuid not null references public.stores (id) on delete cascade,
  code           text not null check (code in ('lineman', 'grab', 'own', 'other')),
  name           text not null check (length(btrim(name)) between 1 and 40),
  commission_bps integer not null default 0 check (commission_bps between 0 and 5000),
  active         boolean not null default true,
  token_hash     text check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  token_hint     text check (token_hint is null or length(token_hint) <= 8),
  created_at     timestamptz not null default now(),
  unique (store_id, name)
);
create unique index delivery_platforms_token_uidx on public.delivery_platforms (token_hash) where token_hash is not null;

alter table public.orders
  add column delivery_platform_id uuid references public.delivery_platforms (id),
  add column external_ref         text check (external_ref is null or length(external_ref) between 1 and 60),
  add column delivery_info        jsonb check (delivery_info is null or jsonb_typeof(delivery_info) = 'object'),
  add column commission_amount    bigint check (commission_amount is null or commission_amount >= 0);
create unique index orders_delivery_ref_uidx on public.orders (delivery_platform_id, external_ref) where delivery_platform_id is not null and external_ref is not null;

create table public.delivery_payouts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  platform_id uuid not null references public.delivery_platforms (id),
  amount      bigint not null check (amount between 1 and 1000000000),
  period_from date,
  period_to   date,
  reference   text check (reference is null or length(reference) <= 100),
  created_by  uuid references public.staff (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index delivery_payouts_platform_idx on public.delivery_payouts (platform_id, created_at);

alter table public.delivery_platforms enable row level security;
alter table public.delivery_payouts enable row level security;
create policy delivery_platforms_read on public.delivery_platforms for select to authenticated using (public.can_access_store(org_id, store_id));
create policy delivery_payouts_read on public.delivery_payouts for select to authenticated using (public.can_access_store(org_id, store_id) and public.has_permission(org_id, 'report.view'));
revoke all on public.delivery_platforms, public.delivery_payouts from anon, authenticated;
-- the browser never reads the token columns
grant select (id, org_id, store_id, code, name, commission_bps, active, token_hint, created_at) on public.delivery_platforms to authenticated;
grant select on public.delivery_payouts to authenticated;
create trigger delivery_platforms_live after insert or update on public.delivery_platforms for each row execute function public.live_ping_row('store:{store_id}');
create trigger delivery_payouts_live after insert on public.delivery_payouts for each row execute function public.live_ping_row('store:{store_id}');

-- ── the owner's side ──
-- p = { store_id, id?, code, name, commission_bps, active? }   (menu.edit)
create or replace function public.save_delivery_platform(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_edit_menu(s.id) then raise exception 'delivery settings need menu.edit in this shop' using errcode = '42501'; end if;
  if not public.delivery_enabled(s.id) then raise exception 'the delivery module is off in this shop' using errcode = '0A000'; end if;
  if v_id is null then
    insert into public.delivery_platforms (org_id, store_id, code, name, commission_bps, active)
    values (s.org_id, s.id, p ->> 'code', btrim(p ->> 'name'), coalesce((p ->> 'commission_bps')::integer, 0), coalesce((p ->> 'active')::boolean, true)) returning id into v_id;
  else
    update public.delivery_platforms
       set code = coalesce(p ->> 'code', code), name = coalesce(btrim(p ->> 'name'), name),
           commission_bps = coalesce((p ->> 'commission_bps')::integer, commission_bps), active = coalesce((p ->> 'active')::boolean, active)
     where id = v_id and store_id = s.id;
    if not found then raise exception 'unknown platform' using errcode = '22023'; end if;
  end if;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'delivery_platforms', v_id::text, jsonb_build_object('commission_bps', p -> 'commission_bps', 'active', p -> 'active'), 'db');
  return v_id;
end $$;

-- a new intake token (shown ONCE; the old one stops working at once)
create or replace function public.rotate_delivery_token(p_platform uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare d public.delivery_platforms%rowtype; v_token text;
begin
  select * into d from public.delivery_platforms where id = p_platform for update;
  if not found or not public.can_edit_menu(d.store_id) then raise exception 'delivery settings need menu.edit in this shop' using errcode = '42501'; end if;
  if not public.delivery_enabled(d.store_id) then raise exception 'the delivery module is off in this shop' using errcode = '0A000'; end if;
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  update public.delivery_platforms set token_hash = encode(sha256(convert_to(v_token, 'utf8')), 'hex'), token_hint = right(v_token, 4) where id = d.id;
  perform public.audit_record(d.org_id, d.store_id, 'settings.change', 'delivery_platforms', d.id::text, jsonb_build_object('token', 'rotated'), 'db');
  return v_token;
end $$;
revoke all on function public.save_delivery_platform(jsonb), public.rotate_delivery_token(uuid) from public, anon;
grant execute on function public.save_delivery_platform(jsonb), public.rotate_delivery_token(uuid) to authenticated, service_role;

-- ── the till: attach the platform and the customer to a delivery bill ──
-- p = { order_id, platform_id, external_ref?, name?, phone?, address? }   (order.create)
create or replace function public.set_delivery_info(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders%rowtype; d public.delivery_platforms%rowtype; v_ref text := nullif(btrim(coalesce(p ->> 'external_ref', '')), '');
begin
  select * into o from public.orders where id = (p ->> 'order_id')::uuid for update;
  if not found or not (public.can_access_store(o.org_id, o.store_id) and public.has_permission(o.org_id, 'order.create')) then
    raise exception 'delivery details need order.create in this shop' using errcode = '42501';
  end if;
  if not public.delivery_enabled(o.store_id) then raise exception 'the delivery module is off in this shop' using errcode = '0A000'; end if;
  if o.channel <> 'delivery' or o.status not in ('open', 'sent', 'ready', 'served') then raise exception 'this is not an open delivery bill' using errcode = '55000'; end if;
  select * into d from public.delivery_platforms where id = (p ->> 'platform_id')::uuid and store_id = o.store_id and active;
  if not found then raise exception 'unknown platform' using errcode = '22023'; end if;
  update public.orders
     set delivery_platform_id = d.id, external_ref = v_ref,
         delivery_info = jsonb_strip_nulls(jsonb_build_object('name', left(nullif(btrim(coalesce(p ->> 'name', '')), ''), 80),
                                                            'phone', left(nullif(btrim(coalesce(p ->> 'phone', '')), ''), 30),
                                                            'address', left(nullif(btrim(coalesce(p ->> 'address', '')), ''), 200)))
   where id = o.id;
end $$;
revoke all on function public.set_delivery_info(jsonb) from public, anon;
grant execute on function public.set_delivery_info(jsonb) to authenticated, service_role;

-- ── closing: the platform pays the shop later ──
-- the same snapshot the till sends for any closing, plus { payment_id }; the payable is booked as ONE payment of the tender `platform`
create or replace function public.close_delivery_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders%rowtype; v_dev public.devices%rowtype; d public.delivery_platforms%rowtype;
  v_staff uuid := nullif(p ->> 'staff_id', '')::uuid; v_pay uuid := (p ->> 'payment_id')::uuid;
  v_sub bigint; v_total bigint := (p ->> 'total')::bigint; v_payable bigint := (p ->> 'payable')::bigint; v_no text; v_old public.receipts%rowtype; v_comm bigint;
begin
  select * into v_order from public.orders where id = (p ->> 'order_id')::uuid for update;
  if not found then raise exception 'order not found' using errcode = 'P0002'; end if;
  if not (public.has_permission(v_order.org_id, 'payment.take') and public.can_access_store(v_order.org_id, v_order.store_id)) then
    raise exception 'taking payment needs payment.take' using errcode = '42501';
  end if;
  if exists (select 1 from public.payments py where py.id = v_pay and py.order_id = v_order.id) then
    select r.* into v_old from public.receipts r where r.order_id = v_order.id;
    return jsonb_build_object('receipt_number', v_old.number, 'replay', true);
  end if;
  if v_order.status in ('paid', 'void') then raise exception 'order is already closed' using errcode = '23514'; end if;
  if not public.delivery_enabled(v_order.store_id) then raise exception 'the delivery module is off in this shop' using errcode = '0A000'; end if;
  if v_order.channel <> 'delivery' or v_order.delivery_platform_id is null then raise exception 'this bill has no delivery platform' using errcode = '55000'; end if;
  select * into d from public.delivery_platforms where id = v_order.delivery_platform_id;
  select * into v_dev from public.devices x where x.id = (p ->> 'device_id')::uuid and x.store_id = v_order.store_id and x.active;
  if not found then raise exception 'device is not part of this shop' using errcode = '23514'; end if;
  if public.order_held_total(v_order.id) > 0 then raise exception 'a bill with money already paid on it cannot be settled by a platform' using errcode = '55000'; end if;
  select coalesce(sum(l.unit_price::bigint * l.quantity), 0) into v_sub from public.order_lines l where l.order_id = v_order.id and l.status <> 'void';
  if v_sub <> (p ->> 'subtotal')::bigint then raise exception 'the bill changed since it was shown' using errcode = '23514'; end if;
  if v_payable <> v_total or coalesce((p ->> 'rounding')::integer, 0) <> 0 or v_payable <= 0 then raise exception 'totals do not add up' using errcode = '23514'; end if;
  if exists (select 1 from public.order_lines l where l.order_id = v_order.id and l.status = 'new') then
    raise exception 'send the new lines to the kitchen first' using errcode = '55000';
  end if;
  if v_staff is not null and not exists (select 1 from public.staff s where s.id = v_staff and s.org_id = v_order.org_id) then v_staff := null; end if;

  update public.devices set online_receipt_seq = online_receipt_seq + 1 where id = v_dev.id returning * into v_dev;
  v_no := v_dev.code || '+' || lpad(v_dev.online_receipt_seq::text, 6, '0');
  v_comm := (v_payable * d.commission_bps + 5000) / 10000;
  perform public.finalize_order_payment(v_order.id, v_dev.id, v_staff, v_no, coalesce((p ->> 'issued_at')::timestamptz, now()), p,
    jsonb_build_array(jsonb_build_object('id', v_pay, 'tender', 'platform', 'amount', v_payable, 'reference', 'platform:' || d.code || ':' || coalesce(v_order.external_ref, ''))));
  update public.orders set commission_amount = v_comm where id = v_order.id;
  perform public.audit_record(v_order.org_id, v_order.store_id, 'payment.tender', 'orders', v_order.id::text,
    jsonb_build_object('tender', 'platform', 'platform', d.code, 'amount', v_payable, 'commission', v_comm), 'db');
  return jsonb_build_object('receipt_number', v_no, 'replay', false, 'commission', v_comm);
end $$;
revoke all on function public.close_delivery_order(jsonb) from public, anon;
grant execute on function public.close_delivery_order(jsonb) to authenticated, service_role;

-- ── what the platform has paid out ──
-- p = { platform_id, amount, period_from?, period_to?, reference? }   (report.view + payment.take)
create or replace function public.record_delivery_payout(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare d public.delivery_platforms%rowtype; v_staff uuid; v_id uuid; v_amount bigint := (p ->> 'amount')::bigint;
begin
  select * into d from public.delivery_platforms where id = (p ->> 'platform_id')::uuid;
  if not found or not (public.can_access_store(d.org_id, d.store_id) and public.has_permission(d.org_id, 'payment.take') and public.has_permission(d.org_id, 'report.view')) then
    raise exception 'recording a platform payout needs payment.take and report.view' using errcode = '42501';
  end if;
  if v_amount is null or v_amount < 1 then raise exception 'the amount must be above zero' using errcode = '22023'; end if;
  select f.id into v_staff from public.staff f where f.org_id = d.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.delivery_payouts (org_id, store_id, platform_id, amount, period_from, period_to, reference, created_by)
  values (d.org_id, d.store_id, d.id, v_amount, nullif(p ->> 'period_from', '')::date, nullif(p ->> 'period_to', '')::date,
          left(nullif(btrim(coalesce(p ->> 'reference', '')), ''), 100), v_staff) returning id into v_id;
  perform public.audit_record(d.org_id, d.store_id, 'payment.tender', 'delivery_payouts', v_id::text, jsonb_build_object('platform', d.code, 'amount', v_amount), 'db');
  return v_id;
end $$;
revoke all on function public.record_delivery_payout(jsonb) from public, anon;
grant execute on function public.record_delivery_payout(jsonb) to authenticated, service_role;

-- ── the report: per platform, for the Bangkok days asked for (paid delivery bills only) ──
-- p = { store_id, from 'YYYY-MM-DD', to 'YYYY-MM-DD' } → [{ platform_id, name, code, commission_bps, bills, gross, commission, net, paid_out, owed }]
-- `paid_out` and `owed` are all-time (what the platform has paid so far / still owes), `bills` .. `net` are for the period
create or replace function public.delivery_report(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype; v_from date := (p ->> 'from')::date; v_to date := (p ->> 'to')::date;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'report.view')) then
    raise exception 'the delivery report needs report.view' using errcode = '42501';
  end if;
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 366 then raise exception 'the period is not valid' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'platform_id', d.id, 'name', d.name, 'code', d.code, 'commission_bps', d.commission_bps,
      'bills',      (select count(*) from public.orders o join public.receipts r on r.order_id = o.id where o.delivery_platform_id = d.id and o.status = 'paid' and o.business_date between v_from and v_to),
      'gross',      (select coalesce(sum(r.payable), 0) from public.orders o join public.receipts r on r.order_id = o.id where o.delivery_platform_id = d.id and o.status = 'paid' and o.business_date between v_from and v_to),
      'commission', (select coalesce(sum(o.commission_amount), 0) from public.orders o where o.delivery_platform_id = d.id and o.status = 'paid' and o.business_date between v_from and v_to),
      'net',        (select coalesce(sum(r.payable - coalesce(o.commission_amount, 0)), 0) from public.orders o join public.receipts r on r.order_id = o.id where o.delivery_platform_id = d.id and o.status = 'paid' and o.business_date between v_from and v_to),
      'paid_out',   (select coalesce(sum(x.amount), 0) from public.delivery_payouts x where x.platform_id = d.id),
      'owed',       (select coalesce(sum(r.payable - coalesce(o.commission_amount, 0)), 0) from public.orders o join public.receipts r on r.order_id = o.id where o.delivery_platform_id = d.id and o.status = 'paid')
                    - (select coalesce(sum(x.amount), 0) from public.delivery_payouts x where x.platform_id = d.id)
    ) order by d.name) from public.delivery_platforms d where d.store_id = s.id), '[]'::jsonb);
end $$;
revoke all on function public.delivery_report(jsonb) from public, anon;
grant execute on function public.delivery_report(jsonb) to authenticated, service_role;

-- ── the intake: an order from a platform arrives (service role only; the platform's token is the key) ──
-- p = { ref, name?, phone?, address?, note?, items: [{ item_id? | barcode? | sku?, quantity, note? }] }
-- → { ok: true, order_id, number, lines, replay } | { ok: false, error: 'unauthorized'|'off'|'invalid'|'unknown_item'|'too_many' }
create or replace function public.delivery_intake(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d public.delivery_platforms%rowtype; s public.stores%rowtype; v_old public.orders%rowtype; v_item public.menu_items%rowtype; e jsonb;
  v_ref text := nullif(btrim(coalesce(p ->> 'ref', '')), ''); v_qty integer; v_order uuid; v_no integer; v_price integer; v_lines integer := 0;
  v_key text; v_note text;
begin
  select * into d from public.delivery_platforms where p_token ~ '^[0-9a-f]{64}$' and token_hash = encode(sha256(convert_to(p_token, 'utf8')), 'hex') and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'unauthorized'); end if;
  select * into s from public.stores where id = d.store_id and deleted_at is null;
  if not found or not public.delivery_enabled(s.id) then return jsonb_build_object('ok', false, 'error', 'off'); end if;
  if v_ref is null or length(v_ref) > 60 or jsonb_typeof(p -> 'items') <> 'array' or jsonb_array_length(p -> 'items') not between 1 and 40 or length(coalesce(p ->> 'note', '')) > 200 then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  -- the same platform order again: the first answer
  select * into v_old from public.orders where delivery_platform_id = d.id and external_ref = v_ref;
  if found then
    return jsonb_build_object('ok', true, 'order_id', v_old.id, 'number', v_old.number, 'replay', true,
                              'lines', (select count(*) from public.order_lines l where l.order_id = v_old.id and l.status <> 'void'));
  end if;
  if (select count(*) from public.orders o where o.delivery_platform_id = d.id and o.created_at > now() - interval '10 minutes') >= 60 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  -- every line must be a real, available item of this shop (checked before anything is written)
  for e in select * from jsonb_array_elements(p -> 'items') loop
    begin
      v_qty := (e ->> 'quantity')::integer;
    exception when others then return jsonb_build_object('ok', false, 'error', 'invalid');
    end;
    if v_qty is null or v_qty not between 1 and 99 or length(coalesce(e ->> 'note', '')) > 200 then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
    v_item := null;
    if nullif(e ->> 'item_id', '') is not null then
      select * into v_item from public.menu_items m where m.id::text = e ->> 'item_id' and m.store_id = s.id and m.deleted_at is null and m.available;
    elsif nullif(e ->> 'barcode', '') is not null then
      select * into v_item from public.menu_items m where lower(m.barcode) = lower(e ->> 'barcode') and m.store_id = s.id and m.deleted_at is null and m.available;
    elsif nullif(e ->> 'sku', '') is not null then
      select * into v_item from public.menu_items m where lower(m.sku) = lower(e ->> 'sku') and m.store_id = s.id and m.deleted_at is null and m.available limit 1;
    else
      return jsonb_build_object('ok', false, 'error', 'invalid');
    end if;
    if v_item.id is null then return jsonb_build_object('ok', false, 'error', 'unknown_item', 'item', coalesce(e ->> 'item_id', e ->> 'barcode', e ->> 'sku')); end if;
  end loop;

  perform 1 from public.stores where id = s.id for update;
  select coalesce(max(substr(o.number, 3)::integer), 0) + 1 into v_no from public.orders o
   where o.store_id = s.id and o.business_date = (now() at time zone 'Asia/Bangkok')::date and o.number ~ '^DL[0-9]+$';
  insert into public.orders (org_id, store_id, number, business_date, channel, status, note, delivery_platform_id, external_ref, delivery_info)
  values (s.org_id, s.id, 'DL' || lpad(v_no::text, 3, '0'), (now() at time zone 'Asia/Bangkok')::date, 'delivery', 'open',
          left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 300), d.id, v_ref,
          jsonb_strip_nulls(jsonb_build_object('name', left(nullif(btrim(coalesce(p ->> 'name', '')), ''), 80), 'phone', left(nullif(btrim(coalesce(p ->> 'phone', '')), ''), 30),
                                               'address', left(nullif(btrim(coalesce(p ->> 'address', '')), ''), 200))))
  returning id into v_order;
  for e in select * from jsonb_array_elements(p -> 'items') loop
    v_qty := (e ->> 'quantity')::integer;
    if nullif(e ->> 'item_id', '') is not null then
      select * into v_item from public.menu_items m where m.id::text = e ->> 'item_id' and m.store_id = s.id;
    elsif nullif(e ->> 'barcode', '') is not null then
      select * into v_item from public.menu_items m where lower(m.barcode) = lower(e ->> 'barcode') and m.store_id = s.id and m.deleted_at is null;
    else
      select * into v_item from public.menu_items m where lower(m.sku) = lower(e ->> 'sku') and m.store_id = s.id and m.deleted_at is null limit 1;
    end if;
    v_price := coalesce((v_item.prices ->> 'delivery')::integer, (v_item.prices ->> 'base')::integer, 0);
    v_note := left(nullif(btrim(coalesce(e ->> 'note', '')), ''), 200);
    insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, note, station, status)
    values (s.org_id, s.id, v_order, v_item.id, v_item.name, v_price, v_qty, v_note, v_item.station, 'new');
    v_lines := v_lines + 1;
  end loop;
  perform public.notify_delivery_order(v_order);
  return jsonb_build_object('ok', true, 'order_id', v_order, 'number', 'DL' || lpad(v_no::text, 3, '0'), 'lines', v_lines, 'replay', false);
end $$;
revoke all on function public.delivery_intake(text, jsonb) from public, anon, authenticated;
grant execute on function public.delivery_intake(text, jsonb) to service_role;

create or replace function public.notify_delivery_order(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders%rowtype; d public.delivery_platforms%rowtype; v_n jsonb;
begin
  select * into o from public.orders where id = p_order;
  if not found then return; end if;
  select * into d from public.delivery_platforms where id = o.delivery_platform_id;
  v_n := jsonb_build_object('kind', 'delivery.new', 'href', '/order/' || o.id, 'dedupe', 'delivery:' || o.id,
    'title', jsonb_build_object('th', 'ออเดอร์เดลิเวอรี่ใหม่ ' || o.number || ' (' || coalesce(d.name, '') || ')', 'en', 'New delivery order ' || o.number || ' (' || coalesce(d.name, '') || ')'),
    'body', jsonb_build_object('th', 'เลขออเดอร์แพลตฟอร์ม: ' || coalesce(o.external_ref, '-'), 'en', 'Platform order: ' || coalesce(o.external_ref, '-')));
  perform public.notify_managers(o.org_id, o.store_id, v_n);
exception when others then
  raise warning 'notify_delivery_order failed: %', sqlerrm;
end $$;
revoke all on function public.notify_delivery_order(uuid) from public, anon, authenticated;
