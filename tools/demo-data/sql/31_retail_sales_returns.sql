-- Island Mart: a morning shift, five sales and three returns (skipped if the shop already has bills).
do $$
declare
  c text := 'cashier.retail.demo@bestiedemo.example';
  m text := 'manager.retail.demo@bestiedemo.example';
  s text := 'Island Mart';
  t text := 'Mart counter';
  n1 text; n4 text; n5 text;
  v_store uuid := demo.store('Island Mart');
  v_dev uuid := demo.device('Island Mart', 'Mart counter');
  v_o uuid;
  v_line uuid;
begin
  if exists (select 1 from public.orders where store_id = v_store) then return; end if;
  perform demo.open_shift(c, s, t, 30000);
  -- Liu Wei tops up 1,000.00 Credit in cash
  perform demo.val(c, format($q$select public.topup_credit(jsonb_build_object('id', gen_random_uuid(), 'customer_id', %L, 'store_id', %L, 'device_id', %L, 'amount', 100000, 'funding', 'cash'))::text$q$, demo.cust('66800000107'), v_store, v_dev));

  n1 := demo.sell(c, s, t, 'takeaway', null, '[{"n":"เสื้อยืดเกาะพะงัน","q":2},{"n":"หมวกปีกกว้าง","q":1}]', null, 0, c, t, '[{"t":"cash"}]');
  perform demo.sell(c, s, t, 'takeaway', null, '[{"n":"ผ้าเช็ดตัวชายหาด","q":1},{"n":"ครีมกันแดด SPF50","q":1}]', null, 0, c, t, '[{"t":"cash"}]');
  perform demo.sell(c, s, t, 'takeaway', null, '[{"n":"รองเท้าแตะ","q":2}]', null, 0, c, t, '[{"t":"cash"}]');
  n4 := demo.sell(c, s, t, 'takeaway', null, '[{"n":"ขวดน้ำใช้ซ้ำ","q":1},{"n":"เสื้อยืดเกาะพะงัน","q":1}]', '66800000107', 0, c, t, '[{"t":"credit"}]');
  n5 := demo.sell(c, s, t, 'takeaway', null, '[{"n":"เสื้อยืดเกาะพะงัน","q":3}]', '66800000108', 0, c, t, '[{"t":"cash"}]');

  -- 1 · a customer changes their mind about one T-shirt: cash from the drawer, back on the shelf
  select order_id into v_o from public.receipts where store_id = v_store and number = n1;
  select id into v_line from public.order_lines where order_id = v_o and item_id = demo.item(s, 'เสื้อยืดเกาะพะงัน');
  perform demo.val(m, format($q$select public.create_return(jsonb_build_object('id', gen_random_uuid(), 'order_id', %L, 'device_id', %L, 'staff_id', %L, 'reason', 'changed_mind', 'refund_method', 'cash',
    'lines', jsonb_build_array(jsonb_build_object('order_line_id', %L, 'quantity', 1, 'restock', true))))::text$q$, v_o, v_dev, demo.staff(m), v_line));

  -- 2 · the reusable bottle bought with Credit was damaged: the money goes back onto the member's Credit, not on the shelf
  select order_id into v_o from public.receipts where store_id = v_store and number = n4;
  select id into v_line from public.order_lines where order_id = v_o and item_id = demo.item(s, 'ขวดน้ำใช้ซ้ำ');
  perform demo.val(m, format($q$select public.create_return(jsonb_build_object('id', gen_random_uuid(), 'order_id', %L, 'device_id', %L, 'staff_id', %L, 'reason', 'defective', 'refund_method', 'credit',
    'lines', jsonb_build_array(jsonb_build_object('order_line_id', %L, 'quantity', 1, 'restock', false))))::text$q$, v_o, v_dev, demo.staff(m), v_line));

  -- 3 · wrong size: one of three T-shirts comes back for cash; the Points earned on it are taken back
  select order_id into v_o from public.receipts where store_id = v_store and number = n5;
  select id into v_line from public.order_lines where order_id = v_o and item_id = demo.item(s, 'เสื้อยืดเกาะพะงัน');
  perform demo.val(m, format($q$select public.create_return(jsonb_build_object('id', gen_random_uuid(), 'order_id', %L, 'device_id', %L, 'staff_id', %L, 'reason', 'wrong_item', 'refund_method', 'cash',
    'lines', jsonb_build_array(jsonb_build_object('order_line_id', %L, 'quantity', 1, 'restock', true))))::text$q$, v_o, v_dev, demo.staff(m), v_line));

  perform demo.close_shift(c, s, t, 0);
end $$;
select 'mart bills=' || (select count(*) from public.orders where store_id = demo.store('Island Mart') and status = 'paid')
  || ' returns=' || (select count(*) from public.order_returns where store_id = demo.store('Island Mart'))
  || ' refunded=' || (select coalesce(sum(amount), 0) from public.order_returns where store_id = demo.store('Island Mart'));
