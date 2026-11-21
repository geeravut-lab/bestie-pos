-- An extra demo shop of the RETAIL profile ("Island Mart"): its team, till, catalogue with barcodes and stock, a morning shift,
-- a handful of sales (cash, Bestie Credit, Points) and three product RETURNS (cash + back on the shelf, Credit for a damaged item,
-- cash with Points taken back). Safe to run again: it skips what already exists. Needs the demo to be set up first.
do $$
declare
  o text := 'owner.demo@bestiedemo.example';
  d text := '@bestiedemo.example';
  v_org uuid := demo.org();
  r record; v_role uuid; c uuid; v_item uuid; v_stock uuid;
begin
  if v_org is null then raise exception 'run setup first (there is no demo organisation)'; end if;
  perform demo.make_user('cashier.retail.demo' || d, 'Demo Cashier – Island Mart', '__DEMO_PASSWORD__');
  perform demo.make_user('manager.retail.demo' || d, 'Demo Manager – Island Mart', '__DEMO_PASSWORD__');

  if demo.store('Island Mart') is null then
    perform demo.val(o, format($q$select public.create_store(%L, 'Island Mart', 'retail')::text$q$, v_org));
  end if;
  update public.stores set vat_registered = true, vat_bps = 700, branch_code = '00004',
         module_overrides = '{"tender.credit": true, "stock": true}'::jsonb where id = demo.store('Island Mart');

  for r in select * from (values
    ('cashier.retail.demo', 'Demo Cashier (Mart)', 'cashier'),
    ('manager.retail.demo', 'Demo Manager (Mart)', 'manager')
  ) as t(local_part, name, role_key) loop
    select id into v_role from public.roles where org_id = v_org and built_in = r.role_key limit 1;
    if not exists (select 1 from public.staff where org_id = v_org and user_id = demo.uid(r.local_part || d)) then
      insert into public.staff (org_id, store_id, user_id, display_name, role_id)
      values (v_org, demo.store('Island Mart'), demo.uid(r.local_part || d), r.name, v_role);
      perform demo.run(o, format($q$select public.set_staff_pin(%L, '1234')$q$, demo.staff(r.local_part || d)));
    end if;
  end loop;

  if demo.device('Island Mart', 'Mart counter') is null then
    perform demo.run(o, format($q$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values (%L, %L, 'Mart counter', 'cashier', 'POS-IM-01')$q$, v_org, demo.store('Island Mart')));
  end if;

  -- catalogue: one category, items with barcodes
  if not exists (select 1 from public.menu_categories where store_id = demo.store('Island Mart') and deleted_at is null) then
    perform demo.run(o, format($q$insert into public.menu_categories (org_id, store_id, name, sort) values (%L, %L, '{"th":"เสื้อผ้าและของใช้","en":"Apparel & essentials"}', 10)$q$, v_org, demo.store('Island Mart')));
  end if;
  select id into c from public.menu_categories where store_id = demo.store('Island Mart') and deleted_at is null order by sort limit 1;
  for r in select * from (values
    ('เสื้อยืดเกาะพะงัน', 'Phangan T-shirt', 29000, 'TEE-0001', 'TEE', 12000),
    ('หมวกปีกกว้าง', 'Sun hat', 15000, 'HAT-0001', 'HAT', 6000),
    ('ครีมกันแดด SPF50', 'Sunscreen SPF50', 25900, 'SUN-0001', 'SUN', 11000),
    ('ผ้าเช็ดตัวชายหาด', 'Beach towel', 35000, 'TWL-0001', 'TWL', 15000),
    ('ขวดน้ำใช้ซ้ำ', 'Reusable bottle', 39000, 'BTL-0001', 'BTL', 17000),
    ('รองเท้าแตะ', 'Flip-flops', 19900, 'FLP-0001', 'FLP', 8000)
  ) as t(th, en, price, barcode, sku, cost) loop
    if not exists (select 1 from public.menu_items where store_id = demo.store('Island Mart') and barcode = r.barcode and deleted_at is null) then
      perform demo.run(o, format($q$insert into public.menu_items (org_id, store_id, category_id, name, prices, barcode, sku)
        values (%L, %L, %L, jsonb_build_object('th', %L, 'en', %L), jsonb_build_object('base', %s), %L, %L)$q$,
        v_org, demo.store('Island Mart'), c, r.th, r.en, r.price, r.barcode, r.sku));
    end if;
    -- one stock item per product (pieces), the recipe "one sale uses one piece", and goods in
    v_item := demo.item('Island Mart', r.th);
    if not exists (select 1 from public.recipe_lines where menu_item_id = v_item) then
      perform demo.run(o, format($q$insert into public.stock_items (org_id, store_id, name, unit, cost_per_1000, low_at, barcode)
        values (%L, %L, jsonb_build_object('th', %L, 'en', %L), 'pcs', %s, 3, %L)$q$, v_org, demo.store('Island Mart'), r.th, r.en, r.cost * 1000, r.barcode || '-S'));
      select id into v_stock from public.stock_items where store_id = demo.store('Island Mart') and barcode = r.barcode || '-S';
      perform demo.run(o, format($q$insert into public.recipe_lines (org_id, store_id, menu_item_id, item_id, quantity) values (%L, %L, %L, %L, 1)$q$, v_org, demo.store('Island Mart'), v_item, v_stock));
      perform demo.val(o, format($q$select public.stock_move(jsonb_build_object('item_id', %L, 'kind', 'receive', 'quantity', 30, 'cost_per_1000', %s))::text$q$, v_stock, r.cost * 1000));
    end if;
  end loop;
end $$;
select 'mart items=' || (select count(*) from public.menu_items where store_id = demo.store('Island Mart') and deleted_at is null) || ' stock=' || (select coalesce(sum(quantity), 0) from public.stock_items where store_id = demo.store('Island Mart'));
