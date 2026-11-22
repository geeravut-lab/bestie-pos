-- Demo: the modules of sets A–D and tours online (needs migrations 82–88 and the setup step; safe to run again — it stops when the promotion exists):
--  Island Kitchen: a happy-hour promotion, an upsell rule, a waiting list with two parties, a staff member clocked in; Breeze Café: a stamp card + a monthly day pass;
--  Island Tours (a new tours shop): two tour slots, an online booking with a cash deposit into a till, a staff booking with a PromptPay deposit.
do $$
declare
  o text := 'owner.demo@bestiedemo.example'; v_org uuid := demo.org(); v_ik uuid := demo.store('Island Kitchen'); v_bc uuid := demo.store('Breeze Café'); v_it uuid;
  v_dev uuid; v_slot1 text; v_slot2 text; v_cfg text; v_bk text; v_book uuid; v_res text;
begin
  if v_org is null then raise exception 'run setup first (there is no demo organisation)'; end if;
  if exists (select 1 from public.promotions where store_id = v_ik and name = 'Happy hour (demo)') then raise notice 'growth sets already there'; return; end if;

  -- modules on (the owner does this on the module screen; here it is a setup row) and the Pro plan they need
  update public.stores set plan = case when plan = 'basic' then 'pro' else plan end,
         module_overrides = coalesce(module_overrides, '{}'::jsonb) || jsonb_build_object('waitlist', true, 'timeclock', true)
   where id = v_ik;
  update public.stores set plan = case when plan = 'basic' then 'pro' else plan end,
         module_overrides = coalesce(module_overrides, '{}'::jsonb) || jsonb_build_object('stamps', true, 'timeclock', true)
   where id = v_bc;

  -- set A: a happy-hour promotion (20 % on weekdays 15:00–17:00) and an upsell rule (the basil rice suggests iced tea)
  perform demo.val(o, format($q$select public.save_promotion(jsonb_build_object('store_id', %L, 'name', 'Happy hour (demo)', 'kind', 'percent', 'value', 2000,
      'weekdays', jsonb_build_array(1, 2, 3, 4, 5), 'from_time', '15:00', 'to_time', '17:00'))::text$q$, v_ik));
  perform demo.val(o, format($q$select public.save_upsell_rule(jsonb_build_object('store_id', %L, 'item_id', %L, 'suggest_id', %L))::text$q$,
    v_ik, demo.item('Island Kitchen', 'ข้าวกะเพราหมูสับ'), demo.item('Island Kitchen', 'ชาเย็น')));

  -- set D: a waiting list with two parties, and the cashier clocked in
  perform demo.val('cashier.kitchen.demo@bestiedemo.example', format($q$select public.waitlist_add(jsonb_build_object('store_id', %L, 'name', 'Anna', 'phone', '0999000101', 'party', 2, 'client_id', gen_random_uuid()))::text$q$, v_ik));
  perform demo.val('cashier.kitchen.demo@bestiedemo.example', format($q$select public.waitlist_add(jsonb_build_object('store_id', %L, 'name', 'Liu', 'phone', '0999000102', 'party', 4, 'client_id', gen_random_uuid()))::text$q$, v_ik));
  perform demo.val('cashier.kitchen.demo@bestiedemo.example', format($q$select public.clock_toggle(jsonb_build_object('store_id', %L, 'staff_id', %L))::text$q$, v_ik, demo.staff('cashier.kitchen.demo@bestiedemo.example')));

  -- set C: a stamp card (5 stamps = a free latte) and a monthly day pass at the café
  perform demo.val(o, format($q$select public.save_stamp_program(jsonb_build_object('store_id', %L, 'kind', 'stamps', 'name', '{"th":"บัตรสะสมแต้มกาแฟ","en":"Coffee stamp card"}'::jsonb,
      'reward_item_id', %L, 'stamps_needed', 5, 'min_spend', 6000))::text$q$, v_bc, demo.item('Breeze Café', 'ลาเต้')));
  perform demo.val(o, format($q$select public.save_stamp_program(jsonb_build_object('store_id', %L, 'kind', 'pass', 'name', '{"th":"พาสกาแฟรายเดือน","en":"Monthly coffee pass"}'::jsonb,
      'reward_item_id', %L, 'pass_price', 30000, 'pass_days', 30))::text$q$, v_bc, demo.item('Breeze Café', 'ลาเต้')));

  -- tours: a new shop with two slots, an online booking (cash deposit into the till) and a counter booking (PromptPay deposit)
  v_it := demo.store('Island Tours');
  if v_it is null then
    v_it := demo.val(o, format($q$select public.create_store(%L, 'Island Tours', 'tours')::text$q$, v_org))::uuid;
  end if;
  update public.stores set plan = 'pro', module_overrides = coalesce(module_overrides, '{}'::jsonb) || jsonb_build_object('slots.booking', true, 'tours.online', true) where id = v_it;
  select id into v_dev from public.devices where store_id = v_it and name = 'Tour desk';
  if v_dev is null then
    insert into public.devices (org_id, store_id, name, role) values (v_org, v_it, 'Tour desk', 'cashier') returning id into v_dev;
  end if;
  v_slot1 := demo.val(o, format($q$select public.save_tour_slot(jsonb_build_object('store_id', %L, 'title', '{"th":"ดำน้ำตื้นเกาะนางยวน","en":"Nang Yuan snorkelling"}'::jsonb,
      'starts_at', (((now() at time zone 'Asia/Bangkok')::date + 2)::text || ' 09:00:00+07')::timestamptz, 'duration_min', 240, 'capacity', 8, 'price', 120000))::text$q$, v_it));
  v_slot2 := demo.val(o, format($q$select public.save_tour_slot(jsonb_build_object('store_id', %L, 'title', '{"th":"ชมพระอาทิตย์ตกบนเรือ","en":"Sunset boat trip"}'::jsonb,
      'starts_at', (((now() at time zone 'Asia/Bangkok')::date + 3)::text || ' 16:30:00+07')::timestamptz, 'duration_min', 120, 'capacity', 12, 'price', 90000))::text$q$, v_it));
  v_cfg := demo.val(o, format($q$select public.tour_link(%L)::text$q$, v_it));
  perform demo.run(o, format($q$select public.save_tour_booking_settings(jsonb_build_object('store_id', %L, 'deposit_pct', 30, 'hold_min', 180, 'pay_note', 'PromptPay 099-900-0000 (demo)', 'notice_min', 120, 'days_ahead', 60))$q$, v_it));
  v_bk := demo.svc(format($q$select public.guest_tour_book(%L, jsonb_build_object('slot_id', %L, 'name', 'Tom Becker', 'phone', '0999000105', 'seats', 2, 'client_id', gen_random_uuid()))::text$q$,
    v_cfg::jsonb ->> 'token', v_slot1));
  v_book := (v_bk::jsonb ->> 'id')::uuid;
  perform demo.run(o, format($q$select public.take_tour_deposit(jsonb_build_object('booking_id', %L, 'amount', 72000, 'method', 'cash', 'device_id', %L))$q$, v_book, v_dev));
  v_res := demo.val(o, format($q$select public.book_tour(jsonb_build_object('slot_id', %L, 'guest_name', 'Mia Chen', 'phone', '0999000103', 'seats', 3, 'client_id', gen_random_uuid()))::text$q$, v_slot2));
  perform demo.run(o, format($q$select public.take_tour_deposit(jsonb_build_object('booking_id', %L, 'amount', 81000, 'method', 'promptpay'))$q$, (v_res::jsonb ->> 'id')::uuid));
  raise notice 'growth sets: promotion, upsell, waiting list (2), clock-in, stamp card + pass, Island Tours with 2 slots, an online booking (cash deposit 720.00) and a counter booking';
end $$;
