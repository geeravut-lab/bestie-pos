-- The ISLAND NETWORK demo (Phase 3): a SECOND business ("[DEMO] Palm Beach Co", one café) joins the network "koh-phangan" next to the demo group, three tourists get a
-- Tourist Pass, earn Points at one business and spend them at the other, so the clearing statement (/network) has lines in BOTH directions, and three shops have a marketplace listing.
-- Needs the demo to be set up first, and migration 63 (network). Safe to run again: it stops when the first tourist's pass already exists.
-- The sales are in separate files (41-43) on purpose: each file is its own transaction, so the Points earned and spent have DIFFERENT times and the clearing statement's
-- first-in-first-out order is real (inside one transaction every row would carry the same `now()`).
-- Fake phone numbers 0999000101..103 mark the demo passes; cleanup removes them.
do $$
declare
  d text := '@bestiedemo.example';
  oa text := 'owner.demo' || d;                      -- owner of the demo group
  ob text := 'owner.beach.demo' || d;                -- owner of the second business
  ca text := 'cashier.cafe.demo' || d;               -- Breeze Café (group)
  ra text := 'reception.spa.demo' || d;              -- Lotus Spa (group)
  cb text := 'cashier.beach.demo' || d;              -- Palm Beach Café (second business)
  v_a uuid := demo.org(); v_b uuid; v_net uuid; v_cat uuid; v_role uuid; r record;
begin
  if v_a is null then raise exception 'run setup first (there is no demo organisation)'; end if;
  if exists (select 1 from public.network_passes where phone = '0999000101') then raise notice 'network demo already there'; return; end if;
  if to_regclass('public.networks') is null then raise exception 'migration 63 (network) is not applied'; end if;

  -- the network (the platform administrator makes it; on the hosted project it exists already)
  insert into public.networks (slug, name, about) values ('koh-phangan', '{"th":"เกาะพะงัน","en":"Koh Phangan"}', '{"th":"ร้านในเครือข่ายเกาะพะงัน สะสมและใช้แต้มได้ทุกร้าน","en":"Shops of the Koh Phangan network: earn and spend points at any of them"}')
  on conflict (slug) do nothing;

  -- the second business: an owner, a café, a cashier, a counter and a small menu
  perform demo.make_user(ob, 'Demo Owner – Palm Beach', '__DEMO_PASSWORD__');
  perform demo.make_user(cb, 'Demo Cashier – Palm Beach', '__DEMO_PASSWORD__');
  if demo.val(ob, $q$select count(*)::text from public.orgs$q$) = '0' then
    perform demo.val(ob, $q$select (public.create_org('[DEMO] Palm Beach Co', 'Palm Beach Café', 'cafe')).org_id::text$q$);
  end if;
  perform set_config('demo.org_name', '[DEMO] Palm Beach Co', true);
  v_b := demo.org();
  select id into v_role from public.roles where org_id = v_b and built_in = 'cashier';
  if not exists (select 1 from public.staff where org_id = v_b and user_id = demo.uid(cb)) then
    insert into public.staff (org_id, store_id, user_id, display_name, role_id) values (v_b, demo.store('Palm Beach Café'), demo.uid(cb), 'Demo Cashier (Palm Beach)', v_role);
    perform demo.run(ob, format($q$select public.set_staff_pin(%L, '1234')$q$, demo.staff(cb)));
  end if;
  if demo.device('Palm Beach Café', 'Beach counter') is null then
    perform demo.run(ob, format($q$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values (%L, %L, 'Beach counter', 'cashier', 'POS-PB-01')$q$, v_b, demo.store('Palm Beach Café')));
  end if;
  if not exists (select 1 from public.menu_categories where store_id = demo.store('Palm Beach Café')) then
    perform demo.run(ob, format($q$insert into public.menu_categories (org_id, store_id, name, sort) values (%L, %L, '{"th":"เมนูริมหาด","en":"Beach menu"}', 10)$q$, v_b, demo.store('Palm Beach Café')));
  end if;
  select id into v_cat from public.menu_categories where store_id = demo.store('Palm Beach Café') order by sort limit 1;
  for r in select * from (values ('ข้าวผัดกุ้ง', 'Shrimp fried rice', 16000), ('ชาไทยเย็น', 'Iced Thai tea', 6500), ('ผลไม้รวม', 'Fruit plate', 9000)) as t(th, en, price) loop
    if demo.item('Palm Beach Café', r.th) is null then
      perform demo.run(ob, format($q$insert into public.menu_items (org_id, store_id, category_id, name, prices) values (%L, %L, %L, jsonb_build_object('th', %L, 'en', %L), jsonb_build_object('base', %s))$q$,
        v_b, demo.store('Palm Beach Café'), v_cat, r.th, r.en, r.price));
    end if;
  end loop;
  perform set_config('demo.org_name', '', true);

  -- both businesses join; three shops list themselves on the island page
  perform demo.run(oa, format($q$select public.join_network(%L, 'koh-phangan')$q$, v_a));
  perform demo.run(ob, format($q$select public.join_network(%L, 'koh-phangan')$q$, v_b));
  perform demo.run(oa, format($q$select public.save_network_listing(jsonb_build_object('store_id', %L, 'category', 'cafe', 'title', '{"th":"บรีซ คาเฟ่","en":"Breeze Café"}'::jsonb, 'about', '{"th":"กาแฟและขนมอบ","en":"Coffee and fresh pastries"}'::jsonb))$q$, demo.store('Breeze Café')));
  perform demo.run(oa, format($q$select public.save_network_listing(jsonb_build_object('store_id', %L, 'category', 'spa', 'title', '{"th":"โลตัส สปา","en":"Lotus Spa"}'::jsonb, 'about', '{"th":"นวดไทยและสปาสมุนไพร","en":"Thai massage and herbal spa"}'::jsonb))$q$, demo.store('Lotus Spa')));
  perform set_config('demo.org_name', '[DEMO] Palm Beach Co', true);
  perform demo.run(ob, format($q$select public.save_network_listing(jsonb_build_object('store_id', %L, 'category', 'food', 'title', '{"th":"ปาล์มบีช คาเฟ่","en":"Palm Beach Café"}'::jsonb, 'about', '{"th":"อาหารไทยริมหาด","en":"Thai food on the beach"}'::jsonb))$q$, demo.store('Palm Beach Café')));
  perform set_config('demo.org_name', '', true);

  -- three tourists register themselves (the guest page's own function)
  perform demo.svc($q$select (public.guest_pass_register('koh-phangan', '{"name":"Anna Weber","phone":"0999000101","consent":true}'::jsonb) ->> 'code')$q$);
  perform demo.svc($q$select (public.guest_pass_register('koh-phangan', '{"name":"Liu Wei","phone":"0999000102","consent":true}'::jsonb) ->> 'code')$q$);
  perform demo.svc($q$select (public.guest_pass_register('koh-phangan', '{"name":"Dan Cohen","phone":"0999000103","consent":true}'::jsonb) ->> 'code')$q$);
  raise notice 'network demo: 2 businesses joined, 3 Tourist Passes, 3 listings';
end $$;
