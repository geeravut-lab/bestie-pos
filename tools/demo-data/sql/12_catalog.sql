-- The menu / service catalogue of every shop. Restaurant and café use the app's own "Load demo menu" function; salon and spa
-- menus are typed in as the owner would (services have a length in minutes, products have a barcode).
do $$
declare
  o text := 'owner.demo@bestiedemo.example';
  v_org uuid := demo.org();
  s text; c uuid; r record;
begin
  foreach s in array array['Island Kitchen', 'Breeze Café'] loop
    if not exists (select 1 from public.menu_items where store_id = demo.store(s) and deleted_at is null) then
      perform demo.val(o, format($q$select public.seed_demo_menu(%L)::text$q$, demo.store(s)));
    end if;
  end loop;

  -- extra sellable things with barcodes (shown by scanning at the till)
  if not exists (select 1 from public.menu_items where store_id = demo.store('Island Kitchen') and barcode = 'WATER-0600') then
    select id into c from public.menu_categories where store_id = demo.store('Island Kitchen') and deleted_at is null order by sort limit 1;
    perform demo.run(o, format($q$insert into public.menu_items (org_id, store_id, category_id, name, prices, barcode, sku, sort) values (%L, %L, %L, '{"th":"น้ำดื่ม 600 มล.","en":"Drinking water 600 ml"}', '{"base": 1500}', 'WATER-0600', 'WATER', 900)$q$, v_org, demo.store('Island Kitchen'), c));
  end if;
  if not exists (select 1 from public.menu_items where store_id = demo.store('Breeze Café') and barcode = 'BEAN-0250') then
    select id into c from public.menu_categories where store_id = demo.store('Breeze Café') and deleted_at is null order by sort limit 1;
    perform demo.run(o, format($q$insert into public.menu_items (org_id, store_id, category_id, name, prices, barcode, sku, sort) values (%L, %L, %L, '{"th":"เมล็ดกาแฟคั่ว 250 ก.","en":"Roasted coffee beans 250 g"}', '{"base": 29000}', 'BEAN-0250', 'BEANS', 900)$q$, v_org, demo.store('Breeze Café'), c));
  end if;

  -- salon and spa: categories, services (minutes) and retail products (barcode)
  for r in select * from (values
    ('Sunset Salon', 'ตัดและจัดทรง', 'Cut & style', 10),
    ('Sunset Salon', 'ทำสีและทรีตเมนต์', 'Colour & treatment', 20),
    ('Sunset Salon', 'ผลิตภัณฑ์', 'Products', 30),
    ('Lotus Spa', 'นวด', 'Massage', 10),
    ('Lotus Spa', 'สปาและสมุนไพร', 'Spa & herbal', 20),
    ('Lotus Spa', 'ผลิตภัณฑ์', 'Products', 30)
  ) as t(store_name, th, en, sort) loop
    if not exists (select 1 from public.menu_categories where store_id = demo.store(r.store_name) and name ->> 'th' = r.th) then
      perform demo.run(o, format($q$insert into public.menu_categories (org_id, store_id, name, sort) values (%L, %L, jsonb_build_object('th', %L, 'en', %L), %s)$q$, v_org, demo.store(r.store_name), r.th, r.en, r.sort));
    end if;
  end loop;

  for r in select * from (values
    ('Sunset Salon', 'ตัดและจัดทรง', 'ตัดผมชาย', 'Men''s haircut', 30000, 45, null, null),
    ('Sunset Salon', 'ตัดและจัดทรง', 'ตัดผมหญิง', 'Women''s haircut', 50000, 60, null, null),
    ('Sunset Salon', 'ตัดและจัดทรง', 'สระ ไดร์ จัดทรง', 'Shampoo & blow-dry', 25000, 30, null, null),
    ('Sunset Salon', 'ทำสีและทรีตเมนต์', 'ทำสีผมทั้งศีรษะ', 'Full hair colour', 180000, 120, null, null),
    ('Sunset Salon', 'ทำสีและทรีตเมนต์', 'ทรีตเมนต์บำรุงผม', 'Hair treatment', 90000, 60, null, null),
    ('Sunset Salon', 'ผลิตภัณฑ์', 'แชมพูสมุนไพร 250 มล.', 'Herbal shampoo 250 ml', 45000, null, 'SHAM-0250', 'SHAMPOO'),
    ('Sunset Salon', 'ผลิตภัณฑ์', 'เซรั่มบำรุงผม 50 มล.', 'Hair serum 50 ml', 69000, null, 'SERUM-0050', 'SERUM'),
    ('Lotus Spa', 'นวด', 'นวดไทย 60 นาที', 'Thai massage 60 min', 60000, 60, null, null),
    ('Lotus Spa', 'นวด', 'นวดไทย 90 นาที', 'Thai massage 90 min', 85000, 90, null, null),
    ('Lotus Spa', 'นวด', 'นวดน้ำมัน 60 นาที', 'Oil massage 60 min', 80000, 60, null, null),
    ('Lotus Spa', 'นวด', 'นวดเท้า 45 นาที', 'Foot massage 45 min', 45000, 45, null, null),
    ('Lotus Spa', 'สปาและสมุนไพร', 'อโรมาเธอราปี 90 นาที', 'Aromatherapy 90 min', 110000, 90, null, null),
    ('Lotus Spa', 'สปาและสมุนไพร', 'ประคบสมุนไพร 90 นาที', 'Herbal compress 90 min', 120000, 90, null, null),
    ('Lotus Spa', 'ผลิตภัณฑ์', 'น้ำมันนวดอโรมา 100 มล.', 'Aroma massage oil 100 ml', 35000, null, 'OIL-0100', 'OIL'),
    ('Lotus Spa', 'ผลิตภัณฑ์', 'ลูกประคบสมุนไพร', 'Herbal compress ball', 25000, null, 'HERB-0001', 'HERBBALL')
  ) as t(store_name, cat, th, en, price, minutes, barcode, sku) loop
    if not exists (select 1 from public.menu_items where store_id = demo.store(r.store_name) and name ->> 'th' = r.th and deleted_at is null) then
      select id into c from public.menu_categories where store_id = demo.store(r.store_name) and name ->> 'th' = r.cat;
      perform demo.run(o, format($q$insert into public.menu_items (org_id, store_id, category_id, name, prices, duration_min, barcode, sku)
        values (%L, %L, %L, jsonb_build_object('th', %L, 'en', %L), jsonb_build_object('base', %s), %s, %L, %L)$q$,
        v_org, demo.store(r.store_name), c, r.th, r.en, r.price, coalesce(r.minutes::text, 'null'), r.barcode, r.sku));
    end if;
  end loop;
end $$;
select 'menu items: ' || (select string_agg(s.name || '=' || n, ', ') from (select st.name, count(*) n from public.menu_items i join public.stores st on st.id = i.store_id where i.org_id = demo.org() and i.deleted_at is null group by st.name order by st.name) s);
