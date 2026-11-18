-- Bestie POS · migration 20 · demo menu for pilot / demo shops.
--
-- `seed_demo_menu(store)` fills an EMPTY restaurant or cafe shop with a small realistic menu (categories, add-on
-- groups, items with stations) and, for a restaurant, a floor plan. It never touches a shop that already has a menu,
-- needs `menu.edit` in that shop, and is audited. The owner can edit or delete everything afterwards in the Menu editor.

create or replace function public.seed_demo_menu(p_store uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org     uuid;
  v_profile text;
  v_n       int := 0;
  c1 uuid; c2 uuid; c3 uuid; c4 uuid;
  g1 uuid; g2 uuid; g3 uuid;
  v_tables  int := 0;
  i int;
begin
  select s.org_id, s.profile into v_org, v_profile from public.stores s where s.id = p_store and s.deleted_at is null;
  if v_org is null or not public.can_access_store(v_org, p_store) or not public.has_permission(v_org, 'menu.edit') then
    raise exception 'menu.edit is needed in this shop' using errcode = '42501';
  end if;
  if v_profile not in ('restaurant', 'cafe') then
    raise exception 'demo menus exist for restaurant and cafe shops only' using errcode = '22023';
  end if;
  if exists (select 1 from public.menu_categories where store_id = p_store and deleted_at is null)
     or exists (select 1 from public.menu_items where store_id = p_store and deleted_at is null) then
    raise exception 'this shop already has a menu' using errcode = '22023';
  end if;

  if v_profile = 'restaurant' then
    insert into public.menu_categories (org_id, store_id, name, sort) values (v_org, p_store, '{"th":"อาหารเรียกน้ำย่อย","en":"Starters"}', 1) returning id into c1;
    insert into public.menu_categories (org_id, store_id, name, sort) values (v_org, p_store, '{"th":"จานหลัก","en":"Mains"}', 2) returning id into c2;
    insert into public.menu_categories (org_id, store_id, name, sort) values (v_org, p_store, '{"th":"เครื่องดื่ม","en":"Drinks"}', 3) returning id into c3;
    insert into public.menu_categories (org_id, store_id, name, sort) values (v_org, p_store, '{"th":"ของหวาน","en":"Desserts"}', 4) returning id into c4;

    insert into public.modifier_groups (org_id, store_id, name, min_select, max_select, sort) values (v_org, p_store, '{"th":"ระดับความเผ็ด","en":"Spice level"}', 1, 1, 1) returning id into g1;
    insert into public.modifier_options (org_id, store_id, group_id, name, price_delta, sort) values
      (v_org, p_store, g1, '{"th":"ไม่เผ็ด","en":"Not spicy"}', 0, 1),
      (v_org, p_store, g1, '{"th":"เผ็ดกลาง","en":"Medium"}', 0, 2),
      (v_org, p_store, g1, '{"th":"เผ็ดมาก","en":"Very spicy"}', 0, 3);
    insert into public.modifier_groups (org_id, store_id, name, min_select, max_select, sort) values (v_org, p_store, '{"th":"เพิ่มเติม","en":"Extras"}', 0, 3, 2) returning id into g2;
    insert into public.modifier_options (org_id, store_id, group_id, name, price_delta, sort) values
      (v_org, p_store, g2, '{"th":"ไข่ดาว","en":"Fried egg"}', 1500, 1),
      (v_org, p_store, g2, '{"th":"เพิ่มกุ้ง","en":"Extra prawns"}', 4000, 2),
      (v_org, p_store, g2, '{"th":"ข้าวเพิ่ม","en":"Extra rice"}', 1000, 3);

    insert into public.menu_items (org_id, store_id, category_id, name, prices, station, modifier_group_ids, sort) values
      (v_org, p_store, c1, '{"th":"ปอเปี๊ยะทอด","en":"Spring rolls"}', '{"base":12000}', 'kitchen', '{}', 1),
      (v_org, p_store, c1, '{"th":"ส้มตำไทย","en":"Papaya salad"}', '{"base":13000}', 'kitchen', array[g1], 2),
      (v_org, p_store, c1, '{"th":"ต้มยำกุ้ง","en":"Tom yum goong"}', '{"base":22000}', 'kitchen', array[g1], 3),
      (v_org, p_store, c2, '{"th":"ผัดไทยกุ้งสด","en":"Pad Thai with prawns"}', '{"base":18000}', 'kitchen', array[g2], 1),
      (v_org, p_store, c2, '{"th":"แกงเขียวหวานไก่","en":"Green curry with chicken"}', '{"base":17000}', 'kitchen', array[g1, g2], 2),
      (v_org, p_store, c2, '{"th":"ข้าวกะเพราหมูสับ","en":"Basil pork with rice"}', '{"base":15000}', 'kitchen', array[g1, g2], 3),
      (v_org, p_store, c2, '{"th":"ปลาทอดราดซอสมะขาม","en":"Fried fish with tamarind sauce"}', '{"base":29000}', 'kitchen', '{}', 4),
      (v_org, p_store, c3, '{"th":"น้ำเปล่า","en":"Water"}', '{"base":2000}', 'bar', '{}', 1),
      (v_org, p_store, c3, '{"th":"เบียร์ช้าง","en":"Chang beer"}', '{"base":8000}', 'bar', '{}', 2),
      (v_org, p_store, c3, '{"th":"น้ำมะพร้าว","en":"Coconut water"}', '{"base":6000}', 'bar', '{}', 3),
      (v_org, p_store, c3, '{"th":"ชาเย็น","en":"Thai iced tea"}', '{"base":6500}', 'bar', '{}', 4),
      (v_org, p_store, c4, '{"th":"ข้าวเหนียวมะม่วง","en":"Mango sticky rice"}', '{"base":13000}', 'kitchen', '{}', 1),
      (v_org, p_store, c4, '{"th":"ไอศกรีมกะทิ","en":"Coconut ice cream"}', '{"base":8000}', 'kitchen', '{}', 2);
    v_n := 13;

    for i in 1..6 loop
      insert into public.dining_tables (org_id, store_id, name, zone, seats, sort) values (v_org, p_store, 'T' || i, 'Indoor', case when i <= 4 then 2 else 4 end, i);
    end loop;
    for i in 1..4 loop
      insert into public.dining_tables (org_id, store_id, name, zone, seats, sort) values (v_org, p_store, 'B' || i, 'Beach', 4, 10 + i);
    end loop;
    v_tables := 10;
  else
    insert into public.menu_categories (org_id, store_id, name, sort) values (v_org, p_store, '{"th":"กาแฟ","en":"Coffee"}', 1) returning id into c1;
    insert into public.menu_categories (org_id, store_id, name, sort) values (v_org, p_store, '{"th":"ชาและเครื่องดื่มอื่น ๆ","en":"Tea & other drinks"}', 2) returning id into c2;
    insert into public.menu_categories (org_id, store_id, name, sort) values (v_org, p_store, '{"th":"เบเกอรี่","en":"Bakery"}', 3) returning id into c3;

    insert into public.modifier_groups (org_id, store_id, name, min_select, max_select, sort) values (v_org, p_store, '{"th":"นม","en":"Milk"}', 1, 1, 1) returning id into g1;
    insert into public.modifier_options (org_id, store_id, group_id, name, price_delta, sort) values
      (v_org, p_store, g1, '{"th":"นมวัว","en":"Dairy"}', 0, 1),
      (v_org, p_store, g1, '{"th":"นมโอ๊ต","en":"Oat"}', 2000, 2),
      (v_org, p_store, g1, '{"th":"นมอัลมอนด์","en":"Almond"}', 2000, 3);
    insert into public.modifier_groups (org_id, store_id, name, min_select, max_select, sort) values (v_org, p_store, '{"th":"ความหวาน","en":"Sweetness"}', 1, 1, 2) returning id into g2;
    insert into public.modifier_options (org_id, store_id, group_id, name, price_delta, sort) values
      (v_org, p_store, g2, '{"th":"หวานปกติ","en":"Regular"}', 0, 1),
      (v_org, p_store, g2, '{"th":"หวานน้อย","en":"Less sweet"}', 0, 2),
      (v_org, p_store, g2, '{"th":"ไม่หวาน","en":"No sugar"}', 0, 3);
    insert into public.modifier_groups (org_id, store_id, name, min_select, max_select, sort) values (v_org, p_store, '{"th":"เพิ่มช็อต","en":"Extra shot"}', 0, 2, 3) returning id into g3;
    insert into public.modifier_options (org_id, store_id, group_id, name, price_delta, sort) values
      (v_org, p_store, g3, '{"th":"เอสเปรสโซเพิ่ม 1 ช็อต","en":"Extra espresso shot"}', 1500, 1),
      (v_org, p_store, g3, '{"th":"ช็อตวานิลลา","en":"Vanilla syrup"}', 1000, 2);

    insert into public.menu_items (org_id, store_id, category_id, name, prices, station, modifier_group_ids, sort) values
      (v_org, p_store, c1, '{"th":"เอสเปรสโซ","en":"Espresso"}', '{"base":5500}', 'bar', array[g3], 1),
      (v_org, p_store, c1, '{"th":"อเมริกาโน่","en":"Americano"}', '{"base":6000}', 'bar', array[g3], 2),
      (v_org, p_store, c1, '{"th":"ลาเต้","en":"Latte"}', '{"base":7500}', 'bar', array[g1, g2, g3], 3),
      (v_org, p_store, c1, '{"th":"คาปูชิโน่","en":"Cappuccino"}', '{"base":7500}', 'bar', array[g1, g2, g3], 4),
      (v_org, p_store, c2, '{"th":"ชาเขียวมัทฉะ","en":"Matcha latte"}', '{"base":8500}', 'bar', array[g1, g2], 1),
      (v_org, p_store, c2, '{"th":"ชาไทยเย็น","en":"Thai iced tea"}', '{"base":6500}', 'bar', array[g2], 2),
      (v_org, p_store, c2, '{"th":"น้ำส้มคั้น","en":"Fresh orange juice"}', '{"base":7000}', 'bar', '{}', 3),
      (v_org, p_store, c3, '{"th":"ครัวซองต์เนยสด","en":"Butter croissant"}', '{"base":6500}', 'kitchen', '{}', 1),
      (v_org, p_store, c3, '{"th":"บราวนี่","en":"Brownie"}', '{"base":7000}', 'kitchen', '{}', 2),
      (v_org, p_store, c3, '{"th":"แซนด์วิชแฮมชีส","en":"Ham and cheese sandwich"}', '{"base":11000}', 'kitchen', '{}', 3);
    v_n := 10;
  end if;

  perform public.audit_record(v_org, p_store, 'menu.item_change', 'menu', p_store::text,
    jsonb_build_object('demo', true, 'items', v_n, 'tables', v_tables), 'app');
  return jsonb_build_object('items', v_n, 'tables', v_tables);
end $$;
revoke all on function public.seed_demo_menu(uuid) from public, anon;
grant execute on function public.seed_demo_menu(uuid) to authenticated, service_role;
