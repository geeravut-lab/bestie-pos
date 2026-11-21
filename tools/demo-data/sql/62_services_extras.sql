-- Demo: the newest modules, switched on where they make sense (needs migrations 75–81; safe to run again — it stops when the delivery platform exists):
--  Island Kitchen: delivery (LINE MAN, one incoming order), seller address + a full tax invoice; Breeze Café: kiosk, online-order page, a bill split between a room and cash;
--  Palm Resort: concierge page, a nightly room rate and a guest who stayed two nights; Sing Along: online booking of rooms with a deposit.
do $$
declare
  o text := 'owner.demo@bestiedemo.example'; v_org uuid := demo.org(); v_ik uuid := demo.store('Island Kitchen'); v_bc uuid := demo.store('Breeze Café');
  v_pr uuid := demo.store('Palm Resort'); v_sa uuid := demo.store('Sing Along'); v_pf text; v_tok text; v_res text; v_f text; v_room uuid; v_ord uuid; v_cfg text;
  v_bk text; v_tomorrow text := to_char(((now() at time zone 'Asia/Bangkok')::date + 1), 'YYYY-MM-DD');
begin
  if v_org is null then raise exception 'run setup first (there is no demo organisation)'; end if;
  if v_pr is null or v_sa is null then raise exception 'run the phase4 step first (Palm Resort and Sing Along are missing)'; end if;
  if exists (select 1 from public.delivery_platforms where store_id = v_ik) then raise notice 'services extras already there'; return; end if;

  -- switch the modules on (the owner does this on the module screen; it is a setup row here) and give the shops the Pro plan the modules need
  update public.stores set plan = case when plan = 'basic' then 'pro' else plan end, module_overrides = coalesce(module_overrides, '{}'::jsonb) || jsonb_build_object('delivery', true, 'kiosk', true, 'guest.concierge', true)
   where id in (v_ik, v_bc);
  update public.stores set plan = case when plan = 'basic' then 'pro' else plan end, module_overrides = coalesce(module_overrides, '{}'::jsonb) || jsonb_build_object('karaoke.booking', true) where id = v_sa;
  update public.stores set module_overrides = coalesce(module_overrides, '{}'::jsonb) || jsonb_build_object('guest.concierge', true) where id = v_pr;

  -- delivery: a platform with 30 % commission and one incoming order through the intake function (as the server does it with the platform's token)
  v_pf := demo.val(o, format($q$select public.save_delivery_platform(jsonb_build_object('store_id', %L, 'code', 'lineman', 'name', 'LINE MAN', 'commission_bps', 3000))::text$q$, v_ik));
  v_tok := demo.val(o, format($q$select public.rotate_delivery_token(%L)$q$, v_pf));
  v_res := demo.svc(format($q$select public.delivery_intake(%L, jsonb_build_object('ref', 'LM-DEMO-1', 'name', 'Somchai', 'phone', '0999000111', 'address', 'Haad Rin, Koh Phangan',
      'items', jsonb_build_array(jsonb_build_object('item_id', %L, 'quantity', 2), jsonb_build_object('item_id', %L, 'quantity', 1))))::text$q$,
      v_tok, demo.item('Island Kitchen', 'ข้าวกะเพราหมูสับ'), demo.item('Island Kitchen', 'ชาเย็น')));
  raise notice 'delivery intake: %', v_res;

  -- the seller address and a full tax invoice for the latest paid bill of the restaurant
  perform demo.run(o, format($q$select public.save_tax_profile(jsonb_build_object('store_id', %L, 'company_address', '99 Moo 1, Koh Phangan, Surat Thani 84280', 'branch_address', 'Island Kitchen, Haad Rin, Koh Phangan'))$q$, v_ik));
  select order_id into v_ord from public.receipts where store_id = v_ik and vat_registered order by issued_at desc limit 1;
  if v_ord is not null then
    v_res := demo.val('cashier.kitchen.demo@bestiedemo.example', format($q$select public.issue_tax_invoice(jsonb_build_object('order_id', %L, 'buyer_name', 'Phangan Dive Co., Ltd.', 'buyer_tax_id', '0845551234567',
      'buyer_branch', '00000', 'buyer_address', '12 Moo 6, Thong Sala, Koh Phangan, Surat Thani 84280'))::text$q$, v_ord));
    raise notice 'tax invoice: %', v_res;
  end if;

  -- kiosk, online-order page (Breeze Café) and an information page for the resort
  perform demo.val(o, format($q$select public.save_kiosk(jsonb_build_object('store_id', %L, 'kind', 'kiosk', 'name', 'Kiosk 1'))::text$q$, v_bc));
  perform demo.val(o, format($q$select public.save_kiosk(jsonb_build_object('store_id', %L, 'kind', 'web', 'name', 'Order online'))::text$q$, v_bc));
  perform demo.val(o, format($q$select public.save_kiosk(jsonb_build_object('store_id', %L, 'kind', 'info', 'name', 'Guest information'))::text$q$, v_pr));

  -- the resort: a nightly rate on the rooms, and a guest who checked in two days ago (the nights that have passed are posted)
  for v_room in select id from public.folio_rooms where store_id = v_pr loop
    perform demo.val(o, format($q$select public.save_folio_room(jsonb_build_object('store_id', %L, 'id', %L, 'name', (select name from public.folio_rooms where id = %L), 'night_rate', 150000))::text$q$, v_pr, v_room, v_room));
  end loop;
  v_f := demo.val(o, format($q$select public.folio_check_in(jsonb_build_object('store_id', %L, 'room_id', %L, 'guest_name', 'Mia Chen', 'phone', '0999000103'))::text$q$,
    v_pr, (select id from public.folio_rooms where store_id = v_pr and name = '103')));
  update public.folios set check_in_at = now() - interval '2 days' where id = v_f::uuid;   -- setup row: she arrived two days ago
  perform demo.val(o, format($q$select public.folio_post_nights(%L)::text$q$, v_f));
  -- a bill of the café split between her room (THB 100) and cash
  v_res := demo.sell('cashier.cafe.demo@bestiedemo.example', 'Breeze Café', 'Café counter', 'takeaway', null, '[{"n":"ลาเต้","q":2},{"n":"ครัวซองต์เนยสด","q":1}]', null, 0,
                     'cashier.cafe.demo@bestiedemo.example', 'Café counter', jsonb_build_array(jsonb_build_object('t', 'room', 'f', v_f, 'a', 10000), jsonb_build_object('t', 'cash')), null);
  raise notice 'split bill % (THB 100 on room 103, the rest in cash)', v_res;

  -- karaoke: online booking of rooms with a 30 % deposit, one guest booking and its deposit
  v_cfg := demo.val(o, format($q$select public.save_karaoke_booking_settings(%L, jsonb_build_object('deposit_pct', 30, 'hold_min', 60, 'pay_note', 'PromptPay 099-900-0000 (demo)'))::text$q$, v_sa));
  v_bk := demo.svc(format($q$select public.guest_karaoke_book(%L, jsonb_build_object('room_id', %L, 'date', %L, 'time', '21:00', 'minutes', 60, 'name', 'Dan Fischer', 'phone', '0999000104', 'guests', 4,
      'client_id', gen_random_uuid()))::text$q$, v_cfg::jsonb ->> 'token', (select id from public.karaoke_rooms where store_id = v_sa and name = 'Mini'), v_tomorrow));
  raise notice 'karaoke online booking: %', left(v_bk, 160);
  raise notice 'services extras: delivery order, tax invoice, kiosk + web + info pages, 2 nights posted for room 103, a split bill, an online karaoke booking';
end $$;
