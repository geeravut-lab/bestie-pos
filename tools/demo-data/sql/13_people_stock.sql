-- Customers (members), the stylists / therapists and rooms, packages, commission rates, information cards, and stock.
do $$
declare
  o text := 'owner.demo@bestiedemo.example';
  m text := 'manager.demo@bestiedemo.example';
  sk text := 'stockkeeper.demo@bestiedemo.example';
  v_org uuid := demo.org();
  r record; v_item uuid; v_sup uuid; v_po uuid;
begin
  -- members of the network (fake numbers; consent given)
  for r in select * from (values
    ('Anna Berg (SE)', '66800000101'), ('Kenji Sato (JP)', '66800000102'), ('Somsri Chaiyo', '66800000103'),
    ('Michael Ross (UK)', '66800000104'), ('Dana Cohen (IL)', '66800000105'), ('Nok Wattana', '66800000106'),
    ('Liu Wei (CN)', '66800000107'), ('Oksana Petrova (RU)', '66800000108')
  ) as t(name, phone) loop
    if demo.cust(r.phone) is null then
      perform demo.run('cashier.kitchen.demo@bestiedemo.example', format($q$select public.create_customer(jsonb_build_object('org_id', %L, 'name', %L, 'phone', %L, 'consent', true))$q$, v_org, r.name, r.phone));
    end if;
  end loop;

  -- stylists / therapists (linked to their login) and rooms
  for r in select * from (values
    ('Sunset Salon', 'Nok (stylist)', 'stylist', 'stylist.salon.demo@bestiedemo.example', 10),
    ('Sunset Salon', 'Mai (stylist)', 'stylist', null, 20),
    ('Lotus Spa', 'Fon (therapist)', 'therapist', 'therapist.spa.demo@bestiedemo.example', 10),
    ('Lotus Spa', 'Pim (therapist)', 'therapist', null, 20),
    ('Lotus Spa', 'Room 1', 'room', null, 30),
    ('Lotus Spa', 'Bed A', 'bed', null, 40)
  ) as t(store_name, name, kind, login, sort) loop
    if not exists (select 1 from public.resources where store_id = demo.store(r.store_name) and name = r.name) then
      perform demo.run(m, format($q$insert into public.resources (org_id, store_id, name, kind, staff_id, sort) values (%L, %L, %L, %L, %L, %s)$q$,
        v_org, demo.store(r.store_name), r.name, r.kind, case when r.login is null then null else demo.staff(r.login) end, r.sort));
    end if;
  end loop;
  -- the spa uses rooms and beds
  update public.stores set module_overrides = module_overrides || '{"resources": true}'::jsonb where id = demo.store('Lotus Spa');

  -- packages the shops sell, and commission rates (10 % / 5 % salon, 15 % / 5 % spa)
  for r in select * from (values
    ('Sunset Salon', 'ตัดผมชาย 5 ครั้ง', 'Men''s cut x5', 120000, 5, 180),
    ('Lotus Spa', 'นวดไทย 10 ครั้ง', 'Thai massage x10', 500000, 10, 365),
    ('Lotus Spa', 'นวดน้ำมัน 5 ครั้ง', 'Oil massage x5', 320000, 5, 180)
  ) as t(store_name, th, en, price, visits, days) loop
    if not exists (select 1 from public.service_packages where store_id = demo.store(r.store_name) and name ->> 'th' = r.th) then
      perform demo.run(m, format($q$insert into public.service_packages (org_id, store_id, name, price, visits, valid_days) values (%L, %L, jsonb_build_object('th', %L, 'en', %L), %s, %s, %s)$q$,
        v_org, demo.store(r.store_name), r.th, r.en, r.price, r.visits, r.days));
    end if;
  end loop;
  perform demo.run(m, format($q$select public.set_commission_rate(jsonb_build_object('store_id', %L, 'service_bps', 1000, 'product_bps', 500))$q$, demo.store('Sunset Salon')));
  perform demo.run(m, format($q$select public.set_commission_rate(jsonb_build_object('store_id', %L, 'service_bps', 1500, 'product_bps', 500))$q$, demo.store('Lotus Spa')));

  -- information cards for guests (wifi, hours)
  for r in select * from (values
    ('Island Kitchen', 'ไวไฟ', 'Wifi', 'รหัสผ่าน: islandkitchen', 'Password: islandkitchen', 10),
    ('Island Kitchen', 'เวลาเปิด-ปิด', 'Opening hours', '10:00–22:00 ทุกวัน', '10:00–22:00 every day', 20),
    ('Breeze Café', 'ไวไฟ', 'Wifi', 'รหัสผ่าน: breezecafe', 'Password: breezecafe', 10)
  ) as t(store_name, th, en, body_th, body_en, sort) loop
    if not exists (select 1 from public.shop_info where store_id = demo.store(r.store_name) and title ->> 'th' = r.th) then
      perform demo.run(o, format($q$select public.save_shop_info(jsonb_build_object('store_id', %L, 'title', jsonb_build_object('th', %L, 'en', %L), 'body', jsonb_build_object('th', %L, 'en', %L), 'sort', %s))$q$,
        demo.store(r.store_name), r.th, r.en, r.body_th, r.body_en, r.sort));
    end if;
  end loop;

  -- stock: ingredients, goods in, recipes, one waste, a supplier and a purchase order that is received
  for r in select * from (values
    ('Island Kitchen', 'เส้นจันท์', 'Rice noodle', 'g', 4000, 3000, 20000),
    ('Island Kitchen', 'กุ้งสด', 'Fresh prawns', 'g', 28000, 2000, 8000),
    ('Island Kitchen', 'หมูสับ', 'Minced pork', 'g', 15000, 2000, 10000),
    ('Island Kitchen', 'ข้าวสาร', 'Rice', 'g', 3200, 5000, 40000),
    ('Island Kitchen', 'น้ำมันพืช', 'Vegetable oil', 'ml', 5000, 2000, 10000),
    ('Breeze Café', 'เมล็ดกาแฟ', 'Coffee beans', 'g', 55000, 1000, 6000),
    ('Breeze Café', 'นมสด', 'Fresh milk', 'ml', 6500, 3000, 24000),
    ('Breeze Café', 'นมโอ๊ต', 'Oat milk', 'ml', 14000, 2000, 12000),
    ('Breeze Café', 'ผงมัทฉะ', 'Matcha powder', 'g', 180000, 200, 1000),
    ('Breeze Café', 'ครัวซองต์ (แช่แข็ง)', 'Croissant (frozen)', 'pcs', 1800000, 10, 60)
  ) as t(store_name, th, en, unit, cost, low, qty) loop
    if not exists (select 1 from public.stock_items where store_id = demo.store(r.store_name) and name ->> 'th' = r.th and deleted_at is null) then
      perform demo.run(sk, format($q$insert into public.stock_items (org_id, store_id, name, unit, cost_per_1000, low_at) values (%L, %L, jsonb_build_object('th', %L, 'en', %L), %L, %s, %s)$q$,
        v_org, demo.store(r.store_name), r.th, r.en, r.unit, r.cost, r.low));
      select id into v_item from public.stock_items where store_id = demo.store(r.store_name) and name ->> 'th' = r.th and deleted_at is null;
      perform demo.val(sk, format($q$select public.stock_move(jsonb_build_object('item_id', %L, 'kind', 'receive', 'quantity', %s, 'cost_per_1000', %s, 'note', 'opening stock'))::text$q$, v_item, r.qty, r.cost));
    end if;
  end loop;

  for r in select * from (values
    ('Island Kitchen', 'ผัดไทยกุ้งสด', 'เส้นจันท์', 100), ('Island Kitchen', 'ผัดไทยกุ้งสด', 'กุ้งสด', 60), ('Island Kitchen', 'ผัดไทยกุ้งสด', 'น้ำมันพืช', 15),
    ('Island Kitchen', 'ข้าวกะเพราหมูสับ', 'ข้าวสาร', 200), ('Island Kitchen', 'ข้าวกะเพราหมูสับ', 'หมูสับ', 80), ('Island Kitchen', 'ข้าวกะเพราหมูสับ', 'น้ำมันพืช', 15),
    ('Breeze Café', 'ลาเต้', 'เมล็ดกาแฟ', 18), ('Breeze Café', 'ลาเต้', 'นมสด', 180),
    ('Breeze Café', 'อเมริกาโน่', 'เมล็ดกาแฟ', 18),
    ('Breeze Café', 'ชาเขียวมัทฉะ', 'ผงมัทฉะ', 6), ('Breeze Café', 'ชาเขียวมัทฉะ', 'นมสด', 200),
    ('Breeze Café', 'ครัวซองต์เนยสด', 'ครัวซองต์ (แช่แข็ง)', 1)
  ) as t(store_name, dish, ingredient, qty) loop
    if not exists (select 1 from public.recipe_lines rl where rl.menu_item_id = demo.item(r.store_name, r.dish)
                     and rl.item_id = (select id from public.stock_items where store_id = demo.store(r.store_name) and name ->> 'th' = r.ingredient and deleted_at is null)) then
      perform demo.run(sk, format($q$insert into public.recipe_lines (org_id, store_id, menu_item_id, item_id, quantity) values (%L, %L, %L, %L, %s)$q$,
        v_org, demo.store(r.store_name), demo.item(r.store_name, r.dish),
        (select id from public.stock_items where store_id = demo.store(r.store_name) and name ->> 'th' = r.ingredient and deleted_at is null), r.qty));
    end if;
  end loop;

  if not exists (select 1 from public.stock_moves where kind = 'waste' and store_id = demo.store('Breeze Café')) then
    perform demo.val(sk, format($q$select public.stock_move(jsonb_build_object('item_id', %L, 'kind', 'waste', 'quantity', 500, 'note', 'milk expired'))::text$q$,
      (select id from public.stock_items where store_id = demo.store('Breeze Café') and name ->> 'th' = 'นมสด')));
  end if;

  if not exists (select 1 from public.suppliers where store_id = demo.store('Island Kitchen')) then
    perform demo.run(sk, format($q$insert into public.suppliers (org_id, store_id, name, phone) values (%L, %L, 'Makro Koh Phangan', '077-000-111')$q$, v_org, demo.store('Island Kitchen')));
    select id into v_sup from public.suppliers where store_id = demo.store('Island Kitchen');
    v_po := demo.val(sk, format($q$select public.save_purchase_order(jsonb_build_object('store_id', %L, 'supplier_id', %L, 'note', 'weekly order', 'lines', jsonb_build_array(
        jsonb_build_object('item_id', %L, 'quantity', 20000, 'cost_per_1000', 3300),
        jsonb_build_object('item_id', %L, 'quantity', 5000, 'cost_per_1000', 29000))))::text$q$,
      demo.store('Island Kitchen'), v_sup,
      (select id from public.stock_items where store_id = demo.store('Island Kitchen') and name ->> 'th' = 'ข้าวสาร'),
      (select id from public.stock_items where store_id = demo.store('Island Kitchen') and name ->> 'th' = 'กุ้งสด')))::uuid;
    perform demo.val(sk, format($q$select public.set_purchase_order_status(%L, 'sent')$q$, v_po));
    perform demo.val(sk, format($q$select public.receive_purchase_order(jsonb_build_object('po_id', %L, 'lines', (select jsonb_agg(jsonb_build_object('line_id', l.id, 'quantity', l.qty_ordered)) from public.purchase_order_lines l where l.po_id = %L)))$q$, v_po, v_po));
  end if;
end $$;
select 'customers=' || (select count(*) from public.customers where org_id = demo.org()) || ' resources=' || (select count(*) from public.resources where org_id = demo.org())
  || ' packages=' || (select count(*) from public.service_packages where org_id = demo.org()) || ' stock items=' || (select count(*) from public.stock_items where org_id = demo.org())
  || ' recipe lines=' || (select count(*) from public.recipe_lines where org_id = demo.org()) || ' POs=' || (select count(*) from public.purchase_orders where org_id = demo.org());
