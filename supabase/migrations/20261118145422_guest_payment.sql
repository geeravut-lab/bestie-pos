-- Bestie POS · migration 22 · pay at the table (PromptPay QR) from the guest page.
--
-- A guest pays the table's bill by PromptPay through the SAME payment-attempt machinery as the till: the server asks the
-- provider for a QR, and only the provider's signed webhook closes the bill (confirm_payment_attempt). What is new:
--  * stores.qr_pay_device — the shop's device whose POS ID / online receipt series (A+000001…) guest payments use.
--    NULL = pay-at-table is off. The owner (and the shop's accountant) chooses it.
--  * guest_pay_context / guest_begin_payment / guest_cancel_payment / guest_payment_status — service_role only, keyed by
--    the table token; they never trust an amount from the phone (the function computes the bill and passes it in).
--  * a guest cannot add to a bill while a payment on it is waiting (the bill would no longer match what was paid).

alter table public.stores add column qr_pay_device uuid references public.devices (id) on delete set null;

-- everything the handler needs to compute the bill and decide what the guest may do
create or replace function public.guest_pay_context(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with t as (
    select t.id, t.name, t.store_id from public.dining_tables t where t.qr_token = p_token and t.deleted_at is null and t.active),
  s as (
    select s.* from public.stores s where s.id = (select store_id from t) and s.deleted_at is null),
  d as (
    select d.id from public.devices d where d.id = (select qr_pay_device from s) and d.store_id = (select id from s) and d.active),
  o as (
    select ord.id from public.orders ord where ord.table_id = (select id from t) and ord.status not in ('paid', 'void') order by ord.created_at limit 1)
  select case when not exists (select 1 from t) then null else jsonb_build_object(
    'enabled', public.qr_ordering_enabled((select id from s)) and exists (select 1 from d),
    'device_id', (select id from d),
    'order_id', (select id from o),
    'config', jsonb_build_object(
      'vat_bps', (select case when vat_registered then vat_bps else 0 end from s),
      'service_bps', (select service_charge_bps from s),
      'price_mode', (select price_mode from s),
      'bill_options', (select bill_options from s)),
    'unsent', exists (select 1 from public.order_lines l where l.order_id = (select id from o) and l.status = 'new'),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('unit_price', l.unit_price, 'quantity', l.quantity))
        from public.order_lines l where l.order_id = (select id from o) and l.status <> 'void'), '[]'::jsonb),
    'live', (select jsonb_build_object('id', a.id, 'amount', a.amount, 'qr_url', a.qr_url, 'expires_at', a.expires_at,
                                       'status', a.status, 'provider_ref', a.provider_ref)
               from public.payment_attempts a where a.order_id = (select id from o) and a.status in ('created', 'pending'))) end
$$;
revoke all on function public.guest_pay_context(text) from public, anon, authenticated;
grant execute on function public.guest_pay_context(text) to service_role;

-- start an attempt for the table's open bill; p is the snapshot the handler computed (same shape as the till's)
create or replace function public.guest_begin_payment(p_token text, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t   public.dining_tables%rowtype;
  s   public.stores%rowtype;
  v_order public.orders%rowtype;
  v_sub bigint;
  v_pay bigint := (p ->> 'payable')::bigint;
  v_id uuid;
begin
  select * into t from public.dining_tables where qr_token = p_token and deleted_at is null and active;
  if not found then raise exception 'unknown table' using errcode = 'P0002'; end if;
  select * into s from public.stores where id = t.store_id and deleted_at is null;
  if not public.qr_ordering_enabled(s.id) or s.qr_pay_device is null
     or not exists (select 1 from public.devices d where d.id = s.qr_pay_device and d.store_id = s.id and d.active) then
    raise exception 'paying at the table is switched off' using errcode = '0A000';
  end if;
  select * into v_order from public.orders where id = (p ->> 'order_id')::uuid and table_id = t.id for update;
  if not found then raise exception 'order not found' using errcode = 'P0002'; end if;
  if v_order.status in ('paid', 'void') then raise exception 'order is already closed' using errcode = '23514'; end if;
  if exists (select 1 from public.order_lines l where l.order_id = v_order.id and l.status = 'new') then
    raise exception 'some lines are not confirmed by the staff yet' using errcode = '55000';
  end if;
  if (p ->> 'device_id')::uuid <> s.qr_pay_device or p ->> 'tender' <> 'promptpay' then
    raise exception 'wrong device or tender' using errcode = '23514';
  end if;
  select coalesce(sum(l.unit_price::bigint * l.quantity), 0) into v_sub
    from public.order_lines l where l.order_id = v_order.id and l.status <> 'void';
  if v_sub <> (p ->> 'subtotal')::bigint then
    raise exception 'the bill changed since it was shown' using errcode = '23514';
  end if;
  if exists (
       select 1 from unnest(array['service_charge', 'vat', 'net_before_vat', 'total', 'vat_bps', 'service_bps']) k
       where jsonb_typeof(p -> k) is distinct from 'number' or (p ->> k) !~ '^[0-9]+$')
     or (p ->> 'price_mode') not in ('inclusive', 'exclusive') or coalesce(p ->> 'lang', 'th') not in ('th', 'en') then
    raise exception 'the bill snapshot is incomplete' using errcode = '23514';
  end if;
  if v_pay <> (p ->> 'total')::bigint or coalesce((p ->> 'rounding')::integer, 0) <> 0 or v_pay <= 0 then
    raise exception 'totals do not add up' using errcode = '23514';
  end if;
  insert into public.payment_attempts (org_id, store_id, order_id, device_id, staff_id, tender, amount, snapshot)
  values (s.org_id, s.id, v_order.id, s.qr_pay_device, null, 'promptpay', v_pay, p)
  returning id into v_id;   -- a second live attempt for the same bill hits the unique index (23505)
  return v_id;
end $$;
revoke all on function public.guest_begin_payment(text, jsonb) from public, anon, authenticated;
grant execute on function public.guest_begin_payment(text, jsonb) to service_role;

-- the guest (or an expired page) gives up on a waiting attempt; the handler then cancels it at the provider
create or replace function public.guest_cancel_payment(p_token text, p_attempt uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.payment_attempts%rowtype;
begin
  select pa.* into a from public.payment_attempts pa
    join public.orders o on o.id = pa.order_id
    join public.dining_tables t on t.id = o.table_id
   where pa.id = p_attempt and t.qr_token = p_token and t.deleted_at is null for update of pa;
  if not found then raise exception 'attempt not found' using errcode = 'P0002'; end if;
  if a.status in ('created', 'pending') then
    update public.payment_attempts set status = 'canceled' where id = a.id;
  end if;
  return jsonb_build_object('status', case when a.status in ('created', 'pending') then 'canceled' else a.status end,
                            'provider_ref', a.provider_ref);
end $$;
revoke all on function public.guest_cancel_payment(text, uuid) from public, anon, authenticated;
grant execute on function public.guest_cancel_payment(text, uuid) to service_role;

-- what the page polls while the QR is on screen
create or replace function public.guest_payment_status(p_token text, p_attempt uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('status', pa.status, 'amount', pa.amount,
           'receipt', (select r.number from public.receipts r where r.order_id = pa.order_id limit 1))
    from public.payment_attempts pa
    join public.orders o on o.id = pa.order_id
    join public.dining_tables t on t.id = o.table_id
   where pa.id = p_attempt and t.qr_token = p_token and t.deleted_at is null
$$;
revoke all on function public.guest_payment_status(text, uuid) from public, anon, authenticated;
grant execute on function public.guest_payment_status(text, uuid) to service_role;

-- ordering is refused while a payment on the bill is waiting: the bill would no longer match what the guest pays
create or replace function public.guest_place_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t        public.dining_tables%rowtype;
  s        public.stores%rowtype;
  v_cid    uuid := (p ->> 'client_id')::uuid;
  v_old    public.guest_submissions%rowtype;
  v_order  uuid;
  v_number text;
  v_date   date := (now() at time zone 'Asia/Bangkok')::date;
  v_next   integer;
  v_line   jsonb;
  v_item   public.menu_items%rowtype;
  v_qty    integer;
  v_note   text;
  v_price  integer;
  v_mods   jsonb;
  v_status text;
  v_opt    text;
  g        public.modifier_groups%rowtype;
  o        public.modifier_options%rowtype;
  v_count  integer;
  v_picked integer;
  v_total  integer := 0;
  v_now    timestamptz := now();
begin
  select * into t from public.dining_tables where qr_token = (p ->> 'token') and deleted_at is null and active;
  if not found then raise exception 'unknown table' using errcode = 'P0002'; end if;
  select * into s from public.stores where id = t.store_id and deleted_at is null;
  if not found then raise exception 'unknown table' using errcode = 'P0002'; end if;
  if not public.qr_ordering_enabled(s.id) then raise exception 'ordering from the table is switched off' using errcode = '0A000'; end if;
  if v_cid is null or jsonb_typeof(p -> 'lines') is distinct from 'array' or jsonb_array_length(p -> 'lines') not between 1 and 30 then
    raise exception 'the order is empty or too long' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('guest:' || s.id::text));

  select * into v_old from public.guest_submissions where id = v_cid;
  if found then
    if v_old.table_id <> t.id then raise exception 'unknown table' using errcode = 'P0002'; end if;
    select o2.number into v_number from public.orders o2 where o2.id = v_old.order_id;
    return jsonb_build_object('order_id', v_old.order_id, 'number', v_number, 'lines', v_old.lines,
                              'status', case when s.qr_auto_send then 'sent' else 'waiting' end, 'replay', true);
  end if;

  select count(*) into v_count from public.guest_submissions
   where table_id = t.id and created_at > v_now - interval '10 minutes';
  if v_count >= 12 then raise exception 'too many orders from this table, ask the staff' using errcode = '54000'; end if;

  select ord.id, ord.number into v_order, v_number from public.orders ord
   where ord.table_id = t.id and ord.status not in ('paid', 'void') order by ord.created_at limit 1 for update;
  if v_order is not null and exists (
       select 1 from public.payment_attempts pa where pa.order_id = v_order and pa.status in ('created', 'pending')) then
    raise exception 'a payment on this bill is waiting' using errcode = '55006';
  end if;
  if v_order is null then
    select coalesce(max(substr(number, 3)::integer), 0) + 1 into v_next from public.orders
     where store_id = s.id and business_date = v_date and number ~ '^QR[0-9]+$';
    v_number := 'QR' || lpad(v_next::text, 3, '0');
    insert into public.orders (org_id, store_id, number, business_date, channel, table_id)
    values (s.org_id, s.id, v_number, v_date, 'dine-in', t.id) returning id into v_order;
  end if;
  if (select count(*) from public.order_lines where order_id = v_order and status <> 'void') + jsonb_array_length(p -> 'lines') > 150 then
    raise exception 'this bill is too long, ask the staff' using errcode = '54000';
  end if;

  v_status := case when s.qr_auto_send then 'sent' else 'new' end;
  for v_line in select * from jsonb_array_elements(p -> 'lines') loop
    if jsonb_typeof(v_line) is distinct from 'object' or (v_line ->> 'quantity') !~ '^[0-9]{1,2}$' then
      raise exception 'bad line' using errcode = '22023';
    end if;
    v_qty := (v_line ->> 'quantity')::integer;
    if v_qty not between 1 and 99 then raise exception 'bad quantity' using errcode = '22023'; end if;
    select * into v_item from public.menu_items i
     where i.id = (v_line ->> 'item_id')::uuid and i.store_id = s.id and i.deleted_at is null and i.available;
    if not found then raise exception 'an item is not available any more' using errcode = '23514'; end if;
    v_note := nullif(btrim(coalesce(v_line ->> 'note', '')), '');
    if v_note is not null then v_note := left(regexp_replace(v_note, '[[:cntrl:]]', ' ', 'g'), 200); end if;

    v_price := coalesce((v_item.prices ->> 'dine-in')::integer, (v_item.prices ->> 'base')::integer);
    v_mods := '[]'::jsonb;
    if jsonb_typeof(v_line -> 'option_ids') is distinct from 'array' and (v_line -> 'option_ids') is not null then
      raise exception 'bad options' using errcode = '22023';
    end if;
    for v_opt in select * from jsonb_array_elements_text(coalesce(v_line -> 'option_ids', '[]'::jsonb)) loop
      select op.* into o from public.modifier_options op
       where op.id = v_opt::uuid and op.store_id = s.id and op.deleted_at is null and op.active
         and op.group_id = any (v_item.modifier_group_ids);
      if not found then raise exception 'an option is not available' using errcode = '23514'; end if;
      v_mods := v_mods || jsonb_build_array(jsonb_build_object(
        'id', o.id, 'name', o.name, 'priceDelta', coalesce((o.channel_delta ->> 'dine-in')::integer, o.price_delta)));
      v_price := v_price + coalesce((o.channel_delta ->> 'dine-in')::integer, o.price_delta);
    end loop;
    if (select count(distinct x) from jsonb_array_elements(v_mods) m, lateral (select m ->> 'id') as d(x)) <> jsonb_array_length(v_mods) then
      raise exception 'an option was chosen twice' using errcode = '23514';
    end if;
    for g in select mg.* from public.modifier_groups mg
              where mg.id = any (v_item.modifier_group_ids) and mg.deleted_at is null loop
      select count(*) into v_picked from jsonb_array_elements(v_mods) m
       where exists (select 1 from public.modifier_options op where op.id = (m ->> 'id')::uuid and op.group_id = g.id);
      if v_picked < g.min_select or v_picked > g.max_select then
        raise exception 'choose the options this dish needs' using errcode = '23514';
      end if;
    end loop;
    if v_price < 0 then v_price := 0; end if;

    insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, modifiers, note, station, status, sent_at)
    values (s.org_id, s.id, v_order, v_item.id, v_item.name, v_price, v_qty, v_mods, v_note, v_item.station, v_status,
            case when v_status = 'sent' then v_now end);
    v_total := v_total + 1;
  end loop;

  insert into public.guest_submissions (id, org_id, store_id, table_id, order_id, lines) values (v_cid, s.org_id, s.id, t.id, v_order, v_total);
  return jsonb_build_object('order_id', v_order, 'number', v_number, 'lines', v_total,
                            'status', case when s.qr_auto_send then 'sent' else 'waiting' end, 'replay', false);
end $$;
revoke all on function public.guest_place_order(jsonb) from public, anon, authenticated;
grant execute on function public.guest_place_order(jsonb) to service_role;
