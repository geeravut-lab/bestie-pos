-- Sunset Salon (5 paid bills) and Lotus Spa (4 paid bills): walk-in product sales, bookings that become bills, deposits, tips,
-- packages, an online booking, a no-show whose deposit is kept, plus the coming days' calendar.

-- one booking at the front desk; day_offset 0 = today (Bangkok), 'HH:MM' start; returns the booking id
create or replace function demo.appt(p_by text, p_store text, p_provider text, p_place text, p_service text, p_phone text, p_guest text, p_day int, p_time text) returns uuid language plpgsql as $$
begin
  return demo.val(p_by, format($q$select public.book_appointment(jsonb_build_object('store_id', %L, 'provider_id', %L, 'place_id', %L, 'service_id', %L,
      'customer_id', %L, 'guest_name', %L, 'guest_phone', %L, 'starts_at', %L))::text$q$,
    demo.store(p_store), (select id from public.resources where store_id = demo.store(p_store) and name = p_provider),
    (select id from public.resources where store_id = demo.store(p_store) and name = p_place),
    demo.item(p_store, p_service), demo.cust(p_phone), p_guest, p_phone,
    to_char((now() at time zone 'Asia/Bangkok')::date + p_day, 'YYYY-MM-DD') || 'T' || p_time || ':00+07:00'))::uuid;
end $$;
create or replace function demo.arrive(p_by text, p_appt uuid) returns void language plpgsql as $$
begin
  perform demo.val(p_by, format($q$select public.set_appointment_status(%L, 'confirmed')$q$, p_appt));
  perform demo.val(p_by, format($q$select public.set_appointment_status(%L, 'arrived')$q$, p_appt));
end $$;
-- turn an arrived booking into a bill at the front desk and pay it
create or replace function demo.bill_appt(p_by text, p_store text, p_dev text, p_appt uuid, p_legs jsonb) returns text language plpgsql as $$
declare v_order uuid;
begin
  v_order := demo.val(p_by, format($q$select public.appointment_to_order(jsonb_build_object('appointment_id', %L, 'device_id', %L))::text$q$, p_appt, demo.device(p_store, p_dev)))::uuid;
  return demo.pay_order(v_order, p_by, p_dev, p_legs);
end $$;
grant execute on all functions in schema demo to authenticated;

do $$
declare
  sal text := 'Sunset Salon'; spa text := 'Lotus Spa';
  rs text := 'reception.salon.demo@bestiedemo.example'; rp text := 'reception.spa.demo@bestiedemo.example';
  m text := 'manager.demo@bestiedemo.example'; o text := 'owner.demo@bestiedemo.example';
  a uuid; v_order uuid; v_tok text; v_res jsonb; v_pkg uuid; v_cp uuid; v_dep uuid;
begin
  if exists (select 1 from public.receipts where store_id = demo.store(sal) and (issued_at at time zone 'Asia/Bangkok')::date = (now() at time zone 'Asia/Bangkok')::date) then raise notice 'salon / spa already simulated'; return; end if;

  -- ── Sunset Salon ──
  -- 1) a walk-in buys two products (found by barcode)
  perform demo.sell(rs, sal, 'Front desk', 'takeaway', null, '[{"n":"แชมพูสมุนไพร 250 มล.","q":1},{"n":"เซรั่มบำรุงผม 50 มล.","q":1}]', null, 0, rs, 'Front desk', '[{"t":"cash"}]', null);
  -- 2) a member's booking is paid with Bestie Credit
  a := demo.appt(rs, sal, 'Nok (stylist)', null, 'ตัดผมหญิง', '66800000106', 'Nok Wattana', 0, '10:00');
  perform demo.arrive(rs, a);
  perform demo.bill_appt(rs, sal, 'Front desk', a, '[{"t":"credit"}]');
  -- 3) a colour job: a deposit when booking, the rest in cash, a tip for the stylist
  a := demo.appt(rs, sal, 'Nok (stylist)', null, 'ทำสีผมทั้งศีรษะ', '66800000102', 'Kenji Sato', 0, '13:00');
  perform demo.val(rs, format($q$select public.record_appointment_deposit(jsonb_build_object('appointment_id', %L, 'amount', 54000, 'method', 'cash', 'device_id', %L))::text$q$, a, demo.device(sal, 'Front desk')));
  perform demo.arrive(rs, a);
  perform demo.bill_appt(rs, sal, 'Front desk', a, '[{"t":"cash"}]');
  perform demo.val(rs, format($q$select public.record_tip(jsonb_build_object('store_id', %L, 'staff_id', %L, 'amount', 10000, 'method', 'cash', 'device_id', %L))::text$q$,
    demo.store(sal), demo.staff('stylist.salon.demo@bestiedemo.example'), demo.device(sal, 'Front desk')));
  -- 4) a package is sold (paid in cash), then one visit is used
  select id into v_pkg from public.service_packages where store_id = demo.store(sal) and name ->> 'th' = 'ตัดผมชาย 5 ครั้ง';
  v_order := demo.val(rs, format($q$select public.sell_package(jsonb_build_object('store_id', %L, 'package_id', %L, 'customer_id', %L, 'device_id', %L))::text$q$,
    demo.store(sal), v_pkg, demo.cust('66800000107'), demo.device(sal, 'Front desk')))::uuid;
  perform demo.pay_order(v_order, rs, 'Front desk', '[{"t":"cash"}]');
  a := demo.appt(rs, sal, 'Mai (stylist)', null, 'ตัดผมชาย', '66800000107', 'Liu Wei', 0, '15:00');
  perform demo.arrive(rs, a);
  select id into v_cp from public.customer_packages where customer_id = demo.cust('66800000107') and status = 'active' limit 1;
  perform demo.val(rs, format($q$select public.use_package(jsonb_build_object('appointment_id', %L, 'customer_package_id', %L))::text$q$, a, v_cp));
  -- 5) a guest books online (the shop's booking link), staff confirm, she arrives and pays
  v_tok := (demo.val(o, format($q$select (public.save_booking_settings(%L, '{}'::jsonb) ->> 'token')$q$, demo.store(sal))));
  v_res := demo.svc(format($q$select public.guest_book(%L, jsonb_build_object('service_id', %L, 'date', %L, 'time', '14:00', 'name', 'Emma Johnson', 'phone', '+44 7700 900123', 'client_id', gen_random_uuid()))::text$q$,
    v_tok, demo.item(sal, 'ทรีตเมนต์บำรุงผม'), to_char((now() at time zone 'Asia/Bangkok')::date + 1, 'YYYY-MM-DD')))::jsonb;
  a := (v_res ->> 'id')::uuid;
  perform demo.arrive(rs, a);
  perform demo.bill_appt(rs, sal, 'Front desk', a, '[{"t":"cash"}]');
  -- the coming days on the calendar
  perform demo.appt(rs, sal, 'Nok (stylist)', null, 'ตัดผมชาย', '66800000103', 'Somsri Chaiyo', 1, '11:00');
  perform demo.appt(rs, sal, 'Mai (stylist)', null, 'สระ ไดร์ จัดทรง', '66800000105', 'Dana Cohen', 1, '16:00');
  perform demo.appt(rs, sal, 'Nok (stylist)', null, 'ตัดผมหญิง', '66800000108', 'Oksana Petrova', 2, '10:30');

  -- ── Lotus Spa ──
  -- 1) a booking with a deposit, a tip, the rest in cash
  a := demo.appt(rp, spa, 'Fon (therapist)', 'Room 1', 'นวดไทย 90 นาที', '66800000108', 'Oksana Petrova', 0, '11:00');
  perform demo.val(rp, format($q$select public.record_appointment_deposit(jsonb_build_object('appointment_id', %L, 'amount', 25500, 'method', 'cash', 'device_id', %L))::text$q$, a, demo.device(spa, 'Front desk')));
  perform demo.arrive(rp, a);
  perform demo.bill_appt(rp, spa, 'Front desk', a, '[{"t":"cash"}]');
  perform demo.val(rp, format($q$select public.record_tip(jsonb_build_object('store_id', %L, 'staff_id', %L, 'amount', 10000, 'method', 'cash', 'device_id', %L))::text$q$,
    demo.store(spa), demo.staff('therapist.spa.demo@bestiedemo.example'), demo.device(spa, 'Front desk')));
  -- 2) a 10-visit package paid with Credit + cash, and one visit used straight away
  select id into v_pkg from public.service_packages where store_id = demo.store(spa) and name ->> 'th' = 'นวดไทย 10 ครั้ง';
  v_order := demo.val(rp, format($q$select public.sell_package(jsonb_build_object('store_id', %L, 'package_id', %L, 'customer_id', %L, 'device_id', %L))::text$q$,
    demo.store(spa), v_pkg, demo.cust('66800000105'), demo.device(spa, 'Front desk')))::uuid;
  perform demo.pay_order(v_order, rp, 'Front desk', '[{"t":"credit","a":200000},{"t":"cash"}]');
  a := demo.appt(rp, spa, 'Pim (therapist)', 'Bed A', 'นวดไทย 60 นาที', '66800000105', 'Dana Cohen', 0, '14:00');
  perform demo.arrive(rp, a);
  select id into v_cp from public.customer_packages where customer_id = demo.cust('66800000105') and status = 'active' limit 1;
  perform demo.val(rp, format($q$select public.use_package(jsonb_build_object('appointment_id', %L, 'customer_package_id', %L))::text$q$, a, v_cp));
  -- 3) a walk-in buys products
  perform demo.sell(rp, spa, 'Front desk', 'takeaway', null, '[{"n":"น้ำมันนวดอโรมา 100 มล.","q":1},{"n":"ลูกประคบสมุนไพร","q":2}]', null, 0, rp, 'Front desk', '[{"t":"cash"}]', null);
  -- 4) an oil massage paid in cash
  a := demo.appt(rp, spa, 'Fon (therapist)', 'Room 1', 'นวดน้ำมัน 60 นาที', '66800000104', 'Michael Ross', 0, '16:00');
  perform demo.arrive(rp, a);
  perform demo.bill_appt(rp, spa, 'Front desk', a, '[{"t":"cash"}]');
  -- a no-show: the deposit was taken, the guest never came, the manager keeps it as a no-show fee
  a := demo.appt(rp, spa, 'Pim (therapist)', 'Bed A', 'อโรมาเธอราปี 90 นาที', null, 'Tom Becker (no-show)', 0, '17:30');
  v_dep := demo.val(rp, format($q$select public.record_appointment_deposit(jsonb_build_object('appointment_id', %L, 'amount', 33000, 'method', 'cash', 'device_id', %L))::text$q$, a, demo.device(spa, 'Front desk')))::uuid;
  perform demo.val(rp, format($q$select public.set_appointment_status(%L, 'no_show')$q$, a));
  perform demo.val(m, format($q$select public.resolve_deposit(jsonb_build_object('deposit_id', %L, 'action', 'forfeit'))$q$, v_dep));
  -- the coming days
  perform demo.appt(rp, spa, 'Fon (therapist)', 'Room 1', 'ประคบสมุนไพร 90 นาที', '66800000101', 'Anna Berg', 1, '10:00');
  perform demo.appt(rp, spa, 'Pim (therapist)', 'Bed A', 'นวดเท้า 45 นาที', '66800000102', 'Kenji Sato', 1, '15:00');
  perform demo.appt(rp, spa, 'Fon (therapist)', 'Room 1', 'อโรมาเธอราปี 90 นาที', '66800000106', 'Nok Wattana', 2, '13:00');
  -- managers pay the tips out in cash
  perform demo.val(m, format($q$select public.pay_out_tips(jsonb_build_object('store_id', %L, 'staff_id', %L, 'device_id', %L))::text$q$, demo.store(sal), demo.staff('stylist.salon.demo@bestiedemo.example'), demo.device(sal, 'Front desk')));
end $$;
select 'salon receipts=' || (select count(*) from public.receipts where store_id = demo.store('Sunset Salon')) || ' spa receipts=' || (select count(*) from public.receipts where store_id = demo.store('Lotus Spa'))
  || ' appointments=' || (select count(*) from public.appointments where org_id = demo.org());
