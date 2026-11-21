-- Simulation helpers: what the till does, written against the app's own tables and functions, as a real person.

create or replace function demo.round_half_up(x numeric) returns bigint language sql immutable as $$ select floor(x + 0.5)::bigint $$;

-- the numbers of a bill exactly as the core money code computes them (inclusive or exclusive of VAT, service charge on dine-in only)
create or replace function demo.bill(p_order uuid) returns jsonb language plpgsql stable as $$
declare
  o public.orders%rowtype; s public.stores%rowtype;
  v_sub bigint; v_pd bigint; v_disc bigint; v_svc bigint := 0; v_base bigint; v_vat bigint; v_net bigint; v_total bigint;
  v_bps int; v_sbps int;
begin
  select * into o from public.orders where id = p_order;
  select * into s from public.stores where id = o.store_id;
  select coalesce(sum(unit_price::bigint * quantity), 0) into v_sub from public.order_lines where order_id = p_order and status <> 'void';
  v_pd := coalesce((select points_discount from public.orders where id = p_order), 0);
  v_disc := v_sub - least(v_pd, v_sub);
  v_sbps := case when o.channel = 'dine-in' then s.service_charge_bps else 0 end;
  v_svc := demo.round_half_up(v_disc * v_sbps / 10000.0);
  v_base := v_disc + v_svc;
  v_bps := case when s.vat_registered then s.vat_bps else 0 end;
  if s.price_mode = 'inclusive' then
    v_vat := case when v_bps = 0 then 0 else floor((v_base * v_bps + (10000 + v_bps) / 2.0) / (10000 + v_bps))::bigint end;
    v_net := v_base - v_vat; v_total := v_base;
  else
    v_vat := demo.round_half_up(v_base * v_bps / 10000.0); v_net := v_base; v_total := v_base + v_vat;
  end if;
  return jsonb_build_object('subtotal', v_sub, 'service_charge', v_svc, 'vat', v_vat, 'net_before_vat', v_net, 'total', v_total, 'rounding', 0, 'payable', v_total,
    'vat_bps', v_bps, 'service_bps', v_sbps, 'price_mode', s.price_mode, 'points_discount', least(v_pd, v_sub));
end $$;

-- pay an open bill. p_legs: [{"t":"cash"}] one cash payment (the till's own receipt series A-…) ·
--   [{"t":"credit","a":10000},{"t":"cash"}] split (server series A+…; a missing amount = what is left) · [{"t":"cash","equal":3}] three equal cash payers
create or replace function demo.pay_order(p_order uuid, p_pay_by text, p_pay_device text, p_legs jsonb, p_at timestamptz default null) returns text language plpgsql as $$
declare
  o public.orders%rowtype; b jsonb; dev uuid; dcode text; v_held bigint; v_due bigint; v_left bigint;
  leg jsonb; legs jsonb := '[]'::jsonb; a bigint; n int; i int; v_no text; v_pay jsonb;
  v_payload jsonb; v_tender bigint; v_local boolean; v_when timestamptz := coalesce(p_at, now());
begin
  select * into o from public.orders where id = p_order;
  dev := demo.device((select name from public.stores where id = o.store_id), p_pay_device);
  select code into dcode from public.devices where id = dev;
  b := demo.bill(p_order);
  v_held := coalesce((select sum(amount) from public.order_partial_payments where order_id = p_order and status = 'held'), 0);
  v_due := (b ->> 'payable')::bigint - v_held;
  v_left := v_due;

  -- build the legs
  for leg in select * from jsonb_array_elements(p_legs) loop
    if (leg ->> 'equal') is not null then
      n := (leg ->> 'equal')::int;
      for i in 1..n loop
        a := v_left / (n - i + 1);                       -- penny-exact even shares (the last payer takes the rest)
        legs := legs || jsonb_build_object('t', 'cash', 'a', a);
        v_left := v_left - a;
      end loop;
    else
      a := coalesce((leg ->> 'a')::bigint, v_left);
      legs := legs || jsonb_build_object('t', leg ->> 't', 'a', a);
      v_left := v_left - a;
    end if;
  end loop;

  v_local := jsonb_array_length(legs) = 1 and legs -> 0 ->> 't' = 'cash' and v_held = 0;
  v_pay := '[]'::jsonb;
  for leg in select * from jsonb_array_elements(legs) loop
    a := (leg ->> 'a')::bigint;
    if leg ->> 't' = 'cash' then
      v_tender := case when a % 10000 = 0 then a else ((a / 5000) + 1) * 5000 end;   -- the guest hands over a round note
      if v_tender < a then v_tender := a; end if;
      v_pay := v_pay || jsonb_build_object('id', gen_random_uuid(), 'tender', 'cash', 'amount', a, 'tendered', v_tender, 'change', v_tender - a, 'created_at', v_when);
    else
      v_pay := v_pay || jsonb_build_object('id', gen_random_uuid(), 'tender', leg ->> 't', 'amount', a, 'created_at', v_when);
    end if;
  end loop;

  v_payload := b || jsonb_build_object('order_id', p_order, 'device_id', dev, 'staff_id', demo.staff(p_pay_by), 'issued_at', v_when, 'lang', 'th', 'payments', v_pay);
  if v_local then
    v_no := dcode || '-' || lpad(((select count(*) from public.receipts where device_id = dev and number like dcode || '-%') + 1)::text, 6, '0');
    perform demo.run(p_pay_by, format('select public.close_order(%L::jsonb)', (v_payload || jsonb_build_object('receipt_number', v_no))::text));
  else
    perform demo.run(p_pay_by, format('select public.close_order_tenders(%L::jsonb)', v_payload::text));
  end if;
  return (select number from public.receipts where order_id = p_order);
end $$;

-- open a bill, fill it (as the waiter / cashier), send it to the kitchen, let the kitchen bump it, attach a member, use points, pay it
create or replace function demo.sell(
  p_open_by text, p_store text, p_open_device text, p_channel text, p_table text, p_items jsonb,
  p_customer text, p_points int, p_pay_by text, p_pay_device text, p_legs jsonb, p_kds text default null, p_at timestamptz default null
) returns text language plpgsql as $$
declare
  v_org uuid := demo.org(); v_store uuid := demo.store(p_store); v_order uuid := gen_random_uuid();
  v_dev uuid := demo.device(p_store, p_open_device); v_letter text; v_n int; v_number text; v_tbl uuid;
  it jsonb; mi public.menu_items%rowtype; v_price int; v_mods jsonb; v_opt record; v_ids text; v_status text;
  v_at timestamptz := coalesce(p_at, now()); v_date date := (coalesce(p_at, now()) at time zone 'Asia/Bangkok')::date;
begin
  select code into v_letter from public.devices where id = v_dev;
  select count(*) + 1 into v_n from public.orders where store_id = v_store and business_date = v_date and number ~ ('^' || v_letter || '[0-9]+$');
  v_number := v_letter || lpad(v_n::text, 3, '0');
  if p_table is not null then select id into v_tbl from public.dining_tables where store_id = v_store and name = p_table; end if;
  perform demo.run(p_open_by, format($q$insert into public.orders (id, org_id, store_id, number, business_date, channel, table_id, covers, opened_by, device_id, created_at)
     values (%L, %L, %L, %L, %L, %L, %L, %s, %L, %L, %L)$q$,
     v_order, v_org, v_store, v_number, v_date, p_channel, v_tbl, case when v_tbl is null then 'null' else '2' end, demo.staff(p_open_by), v_dev, v_at));

  for it in select * from jsonb_array_elements(p_items) loop
    select * into mi from public.menu_items where id = demo.item(p_store, it ->> 'n');
    if mi.id is null then raise exception 'unknown menu item %', it ->> 'n'; end if;
    v_price := coalesce((mi.prices ->> p_channel)::int, (mi.prices ->> 'base')::int);
    v_mods := '[]'::jsonb;
    for v_opt in
      select o.id, o.name, coalesce((o.channel_delta ->> p_channel)::int, o.price_delta) as delta
        from public.modifier_options o join public.modifier_groups g on g.id = o.group_id
       where g.id = any (mi.modifier_group_ids) and o.deleted_at is null
         and (o.name ->> 'th' in (select jsonb_array_elements_text(coalesce(it -> 'o', '[]'::jsonb))) or o.name ->> 'en' in (select jsonb_array_elements_text(coalesce(it -> 'o', '[]'::jsonb))))
    loop
      v_price := v_price + v_opt.delta;
      v_mods := v_mods || jsonb_build_object('id', v_opt.id, 'name', v_opt.name, 'priceDelta', v_opt.delta);
    end loop;
    perform demo.run(p_open_by, format($q$insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, modifiers, note, station, created_by, created_at)
       values (%L, %L, %L, %L, %L::jsonb, %s, %s, %L::jsonb, %L, %L, %L, %L)$q$,
       v_org, v_store, v_order, mi.id, mi.name::text, v_price, coalesce((it ->> 'q')::int, 1), v_mods::text, it ->> 'note', mi.station, demo.staff(p_open_by), v_at));
  end loop;

  -- "send to kitchen / bar": the lines become history
  perform demo.run(p_open_by, format($q$update public.order_lines set status = 'sent', sent_at = %L where order_id = %L and status = 'new'$q$, v_at + interval '2 minutes', v_order));
  if exists (select 1 from public.order_lines where order_id = v_order and status = 'new') then
    update public.order_lines set status = 'sent', sent_at = v_at + interval '2 minutes' where order_id = v_order and status = 'new';
  end if;
  -- the kitchen / bar screen bumps the dishes, the waiter marks them served
  if p_kds is not null then
    select string_agg(format('"%s"', id), ',') into v_ids from public.order_lines where order_id = v_order and station is not null;
    if v_ids is not null then
      perform demo.val(p_kds, format($q$select public.set_lines_status('{"line_ids":[%s],"status":"ready"}'::jsonb)::text$q$, v_ids));
      perform demo.val(p_open_by, format($q$select public.set_lines_status('{"line_ids":[%s],"status":"served"}'::jsonb)::text$q$, v_ids));
    end if;
  end if;

  if p_customer is not null then
    perform demo.run(p_pay_by, format($q$select public.set_order_customer(%L, %L)$q$, v_order, demo.cust(p_customer)));
    if coalesce(p_points, 0) > 0 then
      perform demo.run(p_pay_by, format($q$select public.set_order_points(%L, %s)$q$, v_order, p_points));
    end if;
  end if;
  v_number := demo.pay_order(v_order, p_pay_by, p_pay_device, p_legs, case when p_at is null then null else p_at + interval '40 minutes' end);
  if p_at is not null then   -- history: the kitchen has long since served it
    update public.order_lines set status = 'served' where order_id = v_order and status in ('sent', 'ready');
  end if;
  return v_number;
end $$;

create or replace function demo.open_shift(p_by text, p_store text, p_device text, p_cash bigint) returns void language plpgsql as $$
begin
  if exists (select 1 from public.shifts where device_id = demo.device(p_store, p_device) and status = 'open') then return; end if;
  perform demo.run(p_by, format($q$select public.open_shift(jsonb_build_object('id', gen_random_uuid(), 'device_id', %L, 'staff_id', %L, 'opened_at', now(), 'opening_cash', %s))$q$,
    demo.device(p_store, p_device), demo.staff(p_by), p_cash));
end $$;

-- close with the cash the drawer should hold (+ a small difference for the story), counted by the cashier
create or replace function demo.close_shift(p_by text, p_store text, p_device text, p_diff bigint, p_note text default null) returns jsonb language plpgsql as $$
declare s public.shifts%rowtype; v_exp bigint;
begin
  select * into s from public.shifts where device_id = demo.device(p_store, p_device) and status = 'open';
  if s.id is null then return null; end if;
  v_exp := s.opening_cash
    + coalesce((select sum(amount) from public.payments where device_id = s.device_id and tender = 'cash' and status = 'confirmed' and coalesce(reference, '') not like 'deposit:%' and created_at >= s.opened_at), 0)
    + coalesce((select sum(amount) from public.credit_ledger where device_id = s.device_id and kind = 'topup' and funding = 'cash' and created_at >= s.opened_at), 0)
    + coalesce((select sum(amount) from public.appointment_deposits where device_id = s.device_id and method = 'cash' and created_at >= s.opened_at), 0)
    - coalesce((select sum(amount) from public.appointment_deposits where resolved_device_id = s.device_id and method = 'cash' and status = 'refunded' and resolved_at >= s.opened_at), 0)
    + coalesce((select sum(amount) from public.staff_tips where device_id = s.device_id and method = 'cash' and created_at >= s.opened_at), 0)
    - coalesce((select sum(amount) from public.staff_tips where paid_device_id = s.device_id and status = 'paid' and paid_at >= s.opened_at), 0)
    - coalesce((select sum(amount) from public.order_returns where device_id = s.device_id and refund_method = 'cash' and created_at >= s.opened_at), 0);
  return demo.val(p_by, format($q$select public.close_shift(jsonb_build_object('id', %L, 'staff_id', %L, 'closed_at', now(), 'counted_cash', %s, 'note', %L))::text$q$,
    s.id, demo.staff(p_by), v_exp + p_diff, p_note))::jsonb;
end $$;
grant execute on all functions in schema demo to authenticated;
