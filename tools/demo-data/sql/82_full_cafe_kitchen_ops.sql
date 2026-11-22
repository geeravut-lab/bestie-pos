-- Demo "full" step, part 3: the café's stamp cards, a day pass and a reward used on a bill; a manager's-PIN discount; the delivery bill closed with the platform tender and a payout;
-- stock lots, a transfer between shops, an option that uses stock. Everything is done as the person who would do it. Safe to run again: it stops when its marker exists.
create or replace function demo.open_bill(p_by text, p_store text, p_device text, p_channel text, p_items jsonb, p_customer text) returns uuid language plpgsql as $$
declare
  v_org uuid := demo.org(); v_store uuid := demo.store(p_store); v_order uuid := gen_random_uuid(); v_dev uuid := demo.device(p_store, p_device); v_letter text; v_n int; v_number text;
  it jsonb; mi public.menu_items%rowtype; v_price int; v_date date := (now() at time zone 'Asia/Bangkok')::date;
begin
  select code into v_letter from public.devices where id = v_dev;
  select count(*) + 1 into v_n from public.orders where store_id = v_store and business_date = v_date and number ~ ('^' || v_letter || '[0-9]+$');
  v_number := v_letter || lpad(v_n::text, 3, '0');
  perform demo.run(p_by, format($q$insert into public.orders (id, org_id, store_id, number, business_date, channel, opened_by, device_id) values (%L, %L, %L, %L, %L, %L, %L, %L)$q$,
     v_order, v_org, v_store, v_number, v_date, p_channel, demo.staff(p_by), v_dev));
  for it in select * from jsonb_array_elements(p_items) loop
    select * into mi from public.menu_items where id = demo.item(p_store, it ->> 'n');
    if mi.id is null then raise exception 'unknown menu item %', it ->> 'n'; end if;
    v_price := coalesce((mi.prices ->> p_channel)::int, (mi.prices ->> 'base')::int);
    perform demo.run(p_by, format($q$insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, modifiers, station, created_by)
       values (%L, %L, %L, %L, %L::jsonb, %s, %s, '[]'::jsonb, %L, %L)$q$, v_org, v_store, v_order, mi.id, mi.name::text, v_price, coalesce((it ->> 'q')::int, 1), mi.station, demo.staff(p_by)));
  end loop;
  if p_customer is not null then perform demo.run(p_by, format($q$select public.set_order_customer(%L, %L)$q$, v_order, demo.cust(p_customer))); end if;
  return v_order;
end $$;
grant execute on function demo.open_bill(text, text, text, text, jsonb, text) to authenticated;
-- "send to kitchen": the lines become history (needed before a bill can be paid)
create or replace function demo.send_lines(p_by text, p_order uuid) returns void language plpgsql as $$
begin
  perform demo.run(p_by, format($q$update public.order_lines set status = 'sent', sent_at = now() where order_id = %L and status = 'new'$q$, p_order));
end $$;
grant execute on function demo.send_lines(text, uuid) to authenticated;

do $$
declare
  o text := 'owner.demo@bestiedemo.example'; d text := '@bestiedemo.example'; v_org uuid := demo.org();
  cc text := 'cashier.cafe.demo@bestiedemo.example'; v_bc uuid := demo.store('Breeze Café'); v_ik uuid := demo.store('Island Kitchen');
  v_card uuid; v_prog uuid; v_pass uuid; v_ord uuid; v_res text; v_dl uuid; v_pf uuid; i int; v_item uuid; v_opt uuid; v_milk uuid; v_oat uuid; v_to uuid; v_b jsonb;
begin
  if v_org is null then raise exception 'run setup first (there is no demo organisation)'; end if;
  if exists (select 1 from public.stamp_cards where store_id = v_bc) then raise notice 'full cafe/kitchen ops already there'; return; end if;
  select id into v_prog from public.stamp_programs where store_id = v_bc and kind = 'stamps' and deleted_at is null limit 1;
  select id into v_pass from public.stamp_programs where store_id = v_bc and kind = 'pass' and deleted_at is null limit 1;

  -- Somsri collects five stamps (a bill of THB 60 or more each), then uses the free latte on her sixth bill; Nok has two stamps
  for i in 1..5 loop
    v_res := demo.sell(cc, 'Breeze Café', 'Café counter', 'takeaway', null, '[{"n":"ลาเต้","q":2}]', '66800000103', 0, cc, 'Café counter', '[{"t":"cash"}]'::jsonb, null);
  end loop;
  for i in 1..2 loop
    v_res := demo.sell(cc, 'Breeze Café', 'Café counter', 'takeaway', null, '[{"n":"ลาเต้","q":1},{"n":"ครัวซองต์เนยสด","q":1}]', '66800000106', 0, cc, 'Café counter', '[{"t":"cash"}]'::jsonb, null);
  end loop;
  v_ord := demo.open_bill(cc, 'Breeze Café', 'Café counter', 'takeaway', '[{"n":"ลาเต้","q":1},{"n":"ครัวซองต์เนยสด","q":1}]', '66800000103');
  perform demo.run(cc, format($q$select public.redeem_stamp_reward(jsonb_build_object('order_id', %L, 'program_id', %L))$q$, v_ord, v_prog));
  perform demo.send_lines(cc, v_ord);
  v_res := demo.pay_order(v_ord, cc, 'Café counter', '[{"t":"cash"}]'::jsonb);

  -- Kenji buys the monthly coffee pass (a bill the cashier pays) and uses today's free coffee on his next bill
  v_ord := demo.val(cc, format($q$select public.sell_stamp_pass(jsonb_build_object('store_id', %L, 'program_id', %L, 'customer_id', %L, 'device_id', %L))::text$q$,
    v_bc, v_pass, demo.cust('66800000102'), demo.device('Breeze Café', 'Café counter')))::uuid;
  v_res := demo.pay_order(v_ord, cc, 'Café counter', '[{"t":"cash"}]'::jsonb);
  v_ord := demo.open_bill(cc, 'Breeze Café', 'Café counter', 'takeaway', '[{"n":"ลาเต้","q":1},{"n":"ครัวซองต์เนยสด","q":1}]', '66800000102');
  perform demo.run(cc, format($q$select public.redeem_stamp_reward(jsonb_build_object('order_id', %L, 'program_id', %L))$q$, v_ord, v_pass));
  perform demo.send_lines(cc, v_ord);
  v_res := demo.pay_order(v_ord, cc, 'Café counter', '[{"t":"cash"}]'::jsonb);

  -- a manager's-PIN discount: the cashier asks, the manager types the PIN, 10 % comes off, then the bill is paid
  v_ord := demo.open_bill(cc, 'Breeze Café', 'Café counter', 'takeaway', '[{"n":"ลาเต้","q":3}]', null);
  perform demo.val(cc, format($q$select public.discount_with_manager(jsonb_build_object('order_id', %L, 'kind', 'percent', 'value', 1000, 'reason', 'Regular customer, birthday', 'manager_id', %L, 'manager_pin', '1234'))::text$q$,
    v_ord, demo.staff('manager.demo' || d)));
  perform demo.send_lines(cc, v_ord);
  v_res := demo.pay_order(v_ord, cc, 'Café counter', '[{"t":"cash"}]'::jsonb);

  -- delivery: the LINE MAN order of the extras step is paid by the platform; the platform has paid out part of it
  select id into v_dl from public.orders where store_id = v_ik and number like 'DL%' and status <> 'paid' order by created_at limit 1;
  select id into v_pf from public.delivery_platforms where store_id = v_ik limit 1;
  if v_dl is not null then
    perform demo.send_lines('cashier.kitchen.demo' || d, v_dl);   -- the order is sent to the kitchen before it can be closed
    v_b := demo.bill(v_dl);
    perform demo.run('cashier.kitchen.demo' || d, format($q$select public.close_delivery_order(%L::jsonb)$q$,
      (v_b || jsonb_build_object('order_id', v_dl, 'payment_id', gen_random_uuid(), 'device_id', demo.device('Island Kitchen', 'Counter 1'), 'staff_id', demo.staff('cashier.kitchen.demo' || d), 'issued_at', now(), 'lang', 'th'))::text));
    perform demo.val(o, format($q$select public.record_delivery_payout(jsonb_build_object('platform_id', %L, 'amount', 5000, 'reference', 'LINE MAN weekly transfer (demo)'))::text$q$, v_pf));
  end if;

  -- stock: a lot of milk and of prawns that expire soon (the business manager watches these), a transfer of oil to the café, oat milk that uses stock instead of milk
  select id into v_milk from public.stock_items where store_id = v_bc and name ->> 'en' = 'Fresh milk';
  select id into v_oat from public.stock_items where store_id = v_bc and name ->> 'en' = 'Oat milk';
  perform demo.val('stockkeeper.demo' || d, format($q$select public.save_stock_batch(jsonb_build_object('item_id', %L, 'qty', 6000, 'expires_on', (now() at time zone 'Asia/Bangkok')::date + 2, 'code', 'MILK-D1'))::text$q$, v_milk));
  perform demo.val('stockkeeper.demo' || d, format($q$select public.save_stock_batch(jsonb_build_object('item_id', %L, 'qty', 3000, 'expires_on', (now() at time zone 'Asia/Bangkok')::date + 1, 'code', 'PRAWN-D1'))::text$q$,
    (select id from public.stock_items where store_id = v_ik and name ->> 'en' = 'Fresh prawns')));
  v_to := demo.val('stockkeeper.demo' || d, format($q$select public.send_stock_transfer(jsonb_build_object('from_store_id', %L, 'to_store_id', %L, 'note', 'Oil for the café kitchen (demo)', 'lines',
      jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 2000))))::text$q$, v_ik, v_bc, (select id from public.stock_items where store_id = v_ik and name ->> 'en' = 'Vegetable oil')))::uuid;
  perform demo.val('manager.demo' || d, format($q$select public.receive_stock_transfer(jsonb_build_object('transfer_id', %L))::text$q$, v_to));
  select o2.id into v_opt from public.modifier_options o2 join public.modifier_groups g on g.id = o2.group_id where g.store_id = v_bc and o2.name ->> 'en' = 'Oat' limit 1;
  if v_opt is not null and v_oat is not null and v_milk is not null then
    perform demo.run(o, format($q$insert into public.modifier_option_stock (org_id, store_id, option_id, item_id, quantity, instead_of) values (%L, %L, %L, %L, 150, %L)$q$, v_org, v_bc, v_opt, v_oat, v_milk));
  end if;
  raise notice 'full cafe/kitchen ops: stamps (card + reward + pass), manager discount, delivery paid + payout, stock lots, transfer, option stock';
end $$;
