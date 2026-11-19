-- Island Kitchen (restaurant): 15 paid bills — waiter takes the order on the handheld, the kitchen / bar screens bump it,
-- the cashier takes the money (cash, split, Credit, Points) — plus two bills the guests ordered themselves from the table QR.
do $$
declare
  w text := 'waiter.kitchen.demo@bestiedemo.example';
  c text := 'cashier.kitchen.demo@bestiedemo.example';
  k text := 'kds.kitchen.demo@bestiedemo.example';
  b text := 'bar.kitchen.demo@bestiedemo.example';
  n text := 'Island Kitchen'; h text := 'Waiter handheld'; t text := 'Counter 1';
  no text; v_tok text; v_res jsonb; v_order uuid; v_ids text;
begin
  if exists (select 1 from public.receipts where store_id = demo.store(n) and (issued_at at time zone 'Asia/Bangkok')::date = (now() at time zone 'Asia/Bangkok')::date) then raise notice 'restaurant already simulated'; return; end if;
  perform demo.sell(w, n, h, 'dine-in', 'T1', '[{"n":"ผัดไทยกุ้งสด","q":2,"o":["ไข่ดาว"]},{"n":"ชาเย็น","q":1}]', null, 0, c, t, '[{"t":"cash"}]', k);
  perform demo.sell(w, n, h, 'dine-in', 'T2', '[{"n":"ต้มยำกุ้ง","q":1,"o":["เผ็ดกลาง"]},{"n":"ข้าวกะเพราหมูสับ","q":2,"o":["เผ็ดมาก","ไข่ดาว"]},{"n":"น้ำเปล่า","q":3},{"n":"เบียร์ช้าง","q":2}]', null, 0, c, t, '[{"t":"cash"}]', k);
  -- three friends share the bill equally in cash
  perform demo.sell(w, n, h, 'dine-in', 'T3', '[{"n":"ปลาทอดราดซอสมะขาม","q":1},{"n":"ส้มตำไทย","q":1,"o":["ไม่เผ็ด"]},{"n":"แกงเขียวหวานไก่","q":1,"o":["เผ็ดกลาง"]},{"n":"ข้าวเหนียวมะม่วง","q":2},{"n":"น้ำมะพร้าว","q":2}]', null, 0, c, t, '[{"t":"cash","equal":3}]', k);
  perform demo.sell(w, n, h, 'dine-in', 'B1', '[{"n":"เบียร์ช้าง","q":3},{"n":"ปอเปี๊ยะทอด","q":1}]', null, 0, c, t, '[{"t":"cash"}]', b);
  -- a member pays everything with Bestie Credit (earns Points)
  perform demo.sell(w, n, h, 'dine-in', 'T4', '[{"n":"ผัดไทยกุ้งสด","q":1},{"n":"ต้มยำกุ้ง","q":1,"o":["ไม่เผ็ด"]},{"n":"น้ำมะพร้าว","q":2}]', '66800000101', 0, c, t, '[{"t":"credit"}]', k);
  -- a member pays part with Credit and the rest in cash
  perform demo.sell(w, n, h, 'dine-in', 'T5', '[{"n":"ปลาทอดราดซอสมะขาม","q":2},{"n":"ข้าวกะเพราหมูสับ","q":2,"o":["เผ็ดกลาง"]},{"n":"เบียร์ช้าง","q":4}]', '66800000102', 0, c, t, '[{"t":"credit","a":30000},{"t":"cash"}]', k);
  -- the first member comes back and uses some of the Points she earned as a discount
  perform demo.sell(w, n, h, 'dine-in', 'T1', '[{"n":"ข้าวกะเพราหมูสับ","q":2,"o":["ไม่เผ็ด"]},{"n":"ไอศกรีมกะทิ","q":2}]', '66800000101', 10, c, t, '[{"t":"cash"}]', k);
  perform demo.sell(w, n, h, 'dine-in', 'T6', '[{"n":"แกงเขียวหวานไก่","q":1,"o":["เผ็ดมาก","ข้าวเพิ่ม"]},{"n":"ส้มตำไทย","q":1,"o":["เผ็ดมาก"]},{"n":"ชาเย็น","q":2}]', null, 0, c, t, '[{"t":"cash"}]', k);
  perform demo.sell(w, n, h, 'dine-in', 'B2', '[{"n":"น้ำดื่ม 600 มล.","q":2},{"n":"ปอเปี๊ยะทอด","q":2}]', null, 0, c, t, '[{"t":"cash"}]', b);
  perform demo.sell(w, n, h, 'dine-in', 'T2', '[{"n":"ต้มยำกุ้ง","q":2,"o":["เผ็ดกลาง"]},{"n":"ข้าวเหนียวมะม่วง","q":1}]', '66800000103', 0, c, t, '[{"t":"cash"}]', k);
  -- a couple split the bill in two cash payments
  perform demo.sell(w, n, h, 'dine-in', 'T6', '[{"n":"ต้มยำกุ้ง","q":1,"o":["เผ็ดกลาง"]},{"n":"ผัดไทยกุ้งสด","q":1,"o":["เพิ่มกุ้ง"]},{"n":"เบียร์ช้าง","q":2},{"n":"ไอศกรีมกะทิ","q":1}]', null, 0, c, t, '[{"t":"cash","equal":2}]', k);
  -- takeaway at the counter (no service charge): the cashier opens and pays
  perform demo.sell(c, n, t, 'takeaway', null, '[{"n":"ผัดไทยกุ้งสด","q":3}]', null, 0, c, t, '[{"t":"cash"}]', null);
  perform demo.sell(c, n, t, 'takeaway', null, '[{"n":"ข้าวกะเพราหมูสับ","q":2,"o":["เผ็ดกลาง"]},{"n":"น้ำเปล่า","q":2}]', null, 0, c, t, '[{"t":"cash"}]', null);

  -- two bills the guests started themselves from the table QR (the database prices them), then the cashier sends and collects
  for i in 1..2 loop
    select qr_token into v_tok from public.dining_tables where store_id = demo.store(n) and name = case i when 1 then 'T3' else 'T4' end;
    v_res := demo.svc(format($q$select public.guest_place_order(jsonb_build_object('token', %L, 'client_id', gen_random_uuid(), 'lines', jsonb_build_array(
        jsonb_build_object('item_id', %L, 'quantity', %s, 'option_ids', jsonb_build_array(%L)),
        jsonb_build_object('item_id', %L, 'quantity', 2))))::text$q$, v_tok,
        demo.item(n, 'ผัดไทยกุ้งสด'), i + 1, (select id from public.modifier_options where store_id = demo.store(n) and name ->> 'th' = 'ไข่ดาว' limit 1), demo.item(n, 'ชาเย็น')))::jsonb;
    v_order := (v_res ->> 'order_id')::uuid;
    perform demo.run(c, format($q$update public.order_lines set status = 'sent', sent_at = now() where order_id = %L and status = 'new'$q$, v_order));
    select string_agg(format('"%s"', id), ',') into v_ids from public.order_lines where order_id = v_order and station is not null;
    perform demo.val(k, format($q$select public.set_lines_status('{"line_ids":[%s],"status":"ready"}'::jsonb)::text$q$, v_ids));
    perform demo.pay_order(v_order, c, t, '[{"t":"cash"}]');
  end loop;

  -- guests leave feedback and press the call button
  select qr_token into v_tok from public.dining_tables where store_id = demo.store(n) and name = 'T5';
  perform demo.svc(format($q$select public.guest_feedback_submit(%L, 5, 'food', 'อร่อยมาก ผัดไทยสุดยอด!')::text$q$, v_tok));
  perform demo.svc(format($q$select public.guest_feedback_submit(%L, 2, 'service', 'Waited 30 minutes for the beer')::text$q$, v_tok));
  perform demo.svc(format($q$select public.guest_call_staff(%L, 'bill')::text$q$, v_tok));
end $$;
select 'restaurant receipts=' || (select count(*) from public.receipts where store_id = demo.store('Island Kitchen'));
