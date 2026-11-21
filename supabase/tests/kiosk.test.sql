-- Kiosk: a self-order screen is a guest table of kind 'kiosk' — own bill per order, takeaway prices, unsent lines, its own module.
\set ON_ERROR_STOP on
\set QUIET on

create or replace function t_exec(uid uuid, role_name text, q text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  perform set_config('request.jwt.claim.role', role_name, true);
  execute format('set local role %I', role_name);
  execute q;
  get diagnostics n = row_count;
  execute 'reset role';
  return n;
end $$;
create or replace function t_rows(uid uuid, role_name text, q text, expected bigint, label text) returns void language plpgsql as $$
declare n bigint;
begin
  n := t_exec(uid, role_name, q);
  if n is distinct from expected then raise exception 'FAIL % — expected % rows, got %', label, expected, n; end if;
  raise notice 'PASS %', label;
end $$;
create or replace function t_err(uid uuid, role_name text, q text, state text, label text) returns void language plpgsql as $$
begin
  begin
    perform t_exec(uid, role_name, q);
  exception when others then
    if sqlstate = state then raise notice 'PASS %', label; return; end if;
    raise exception 'FAIL % — expected SQLSTATE %, got % (%)', label, state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL % — expected an error (%), none raised', label, state;
end $$;

-- text-returning helper: run a query as a user, store its single value
create table t_out (k text primary key, v text);
create or replace function t_val(uid uuid, role_name text, key_ text, q text) returns void language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  perform set_config('request.jwt.claim.role', role_name, true);
  execute format('set local role %I', role_name);
  execute q into r;
  execute 'reset role';
  insert into t_out values (key_, r) on conflict (k) do update set v = excluded.v;
end $$;
grant all on t_out to authenticated, service_role;
grant execute on function t_val(uuid, text, text, text) to authenticated, service_role;









insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Cafe Co','Palm Cafe','cafe')$$, 1, 'the owner creates a cafe');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other Co','Other','cafe')$$, 1, 'another business exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Cafe Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Cafe Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Palm Cafe'$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cashier_staff', $$select id::text from public.staff where display_name = 'Cashier'$$);
update public.legal_entities set tax_id = '0105560123456' where name = 'Cafe Co';
update public.stores set vat_registered = true, vat_bps = 700, branch_code = '00001' where org_id = (select v::uuid from t_out where k='org');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Till', 'cashier', 'POS-1') returning id::text$$);
select t_val(null, 'service_role', 'cat', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"อาหาร"}') returning id::text$$);
select t_val(null, 'service_role', 'rice', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, station, barcode) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"ข้าวผัด","en":"Fried rice"}', '{"base": 10000, "takeaway": 9000, "dine-in": 11000}', 'kitchen', 'RICE-001') returning id::text$$);
select t_val(null, 'service_role', 'tea', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, sku) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"ชา"}', '{"base": 5000}', 'TEA-1') returning id::text$$);
select t_val(null, 'service_role', 'off', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, barcode, available) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"หมด"}', '{"base": 100}', 'GONE-01', false) returning id::text$$);

-- ── the module ──
select t_rows(null, 'service_role', $$select 1 where not public.kiosk_enabled((select v::uuid from t_out where k='store'))$$, 1, 'the kiosk module is off by default');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_kiosk(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Kiosk 1'))$$, '0A000', 'a kiosk cannot be made while the module is off');
update public.stores set plan = 'pro', module_overrides = module_overrides || '{"kiosk": true}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_kiosk(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Kiosk 1'))$$, '42501', 'a cashier cannot make a kiosk');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.save_kiosk(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Kiosk 1'))$$, '42501', 'another business cannot either');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'k', $$select public.save_kiosk(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Kiosk 1'))::text$$);
select t_val(null, 'service_role', 'ktok', $$select v::jsonb ->> 'token' from t_out where k='k'$$);
select t_rows(null, 'service_role', $$select 1 from public.dining_tables where id = (select (v::jsonb ->> 'id')::uuid from t_out where k='k') and kind = 'kiosk' and qr_token = (select v from t_out where k='ktok') and length(qr_token) = 32$$, 1, 'the kiosk is a table of kind kiosk with its own random token');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_kiosk(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'kiosk 1'))$$, '23505', 'a name is used once');

-- ── what the kiosk page reads ──
select t_val(null, 'service_role', 'gt', $$select public.guest_table((select v from t_out where k='ktok'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='gt' and (v::jsonb ->> 'kiosk') = 'true' and (v::jsonb ->> 'qr_enabled') = 'true' and (v::jsonb ->> 'auto_send') is not null$$, 1, 'the page learns it is a kiosk and that ordering is on (the order.qr module is NOT needed)');
select t_val(null, 'service_role', 'gm', $$select public.guest_menu((select v from t_out where k='ktok'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out, jsonb_array_elements(v::jsonb -> 'items') i where k='gm' and (i ->> 'price') = '9000'$$, 1, 'the kiosk menu shows the TAKEAWAY price (90, not the dine-in 110)');

-- ── ordering ──
create or replace function t_order(p_cid text, p_qty int default 2) returns jsonb language sql as $$
  select jsonb_build_object('token', (select v from t_out where k='ktok'), 'client_id', p_cid,
    'lines', jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='rice'), 'quantity', p_qty, 'option_ids', '[]'::jsonb, 'note', 'no chilli'))) $$;
select t_val(null, 'service_role', 'o1', $$select public.guest_place_order(t_order('11111111-1111-4111-8111-111111111111'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='o1' and (v::jsonb ->> 'number') = 'KS001' and (v::jsonb ->> 'lines') = '1' and (v::jsonb ->> 'status') = 'waiting' and (v::jsonb ->> 'replay') = 'false'$$, 1, 'the first order is KS001 and waits for the cashier');
select t_val(null, 'service_role', 'oid1', $$select v::jsonb ->> 'order_id' from t_out where k='o1'$$);
select t_rows(null, 'service_role', $$select 1 from public.orders where id = (select v::uuid from t_out where k='oid1') and channel = 'takeaway' and table_id is null and status = 'open' and number = 'KS001'$$, 1, 'a takeaway bill with no table');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where order_id = (select v::uuid from t_out where k='oid1') and unit_price = 9000 and quantity = 2 and status = 'new' and sent_at is null and note = 'no chilli' and station = 'kitchen'$$, 1, 'priced by the database at the takeaway price, unsent, for the kitchen');
select t_val(null, 'service_role', 'o1b', $$select public.guest_place_order(t_order('11111111-1111-4111-8111-111111111111'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='o1b' and (v::jsonb ->> 'replay') = 'true' and (v::jsonb ->> 'number') = 'KS001'$$, 1, 'the same tap again returns the first answer');
select t_val(null, 'service_role', 'o2', $$select public.guest_place_order(t_order('22222222-2222-4222-8222-222222222222', 1))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='o2' and (v::jsonb ->> 'number') = 'KS002'$$, 1, 'the next customer gets KS002 on a bill of their own');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.orders where number like 'KS%') = 2 and (select count(*) from public.order_lines) = 2$$, 1, 'two bills, one line each: nothing was added to an earlier bill');
select t_rows(null, 'service_role', $$select 1 where (public.guest_bill((select v from t_out where k='ktok'))::jsonb -> 'lines') = '[]'::jsonb or public.guest_bill((select v from t_out where k='ktok')) is null$$, 1, 'the kiosk shows no running bill to the next customer');
select t_err(null, 'service_role', $$select public.guest_place_order(jsonb_build_object('token', (select v from t_out where k='ktok'), 'client_id', '33333333-3333-4333-8333-333333333333', 'lines', '[]'::jsonb))$$, '22023', 'an empty order is refused');
select t_err(null, 'service_role', $$select public.guest_place_order(jsonb_build_object('token', (select v from t_out where k='ktok'), 'client_id', '44444444-4444-4444-8444-444444444444',
  'lines', jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='off'), 'quantity', 1))))$$, '23514', 'a sold-out item is refused');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.orders where number like 'KS%'$$, 2, 'the cashier sees both bills on the till');

-- ── a table still works as before ──
update public.stores set module_overrides = module_overrides || '{"order.qr": true}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'tbl', $$insert into public.dining_tables (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'T1') returning qr_token$$);
select t_val(null, 'service_role', 'ot', $$select public.guest_place_order(jsonb_build_object('token', (select v from t_out where k='tbl'), 'client_id', '55555555-5555-4555-8555-555555555555',
  'lines', jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='rice'), 'quantity', 1))))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='ot' and (v::jsonb ->> 'number') = 'QR001'$$, 1, 'a table order is still QR001');
select t_rows(null, 'service_role', $$select 1 from public.orders o join public.order_lines l on l.order_id = o.id where o.number = 'QR001' and o.channel = 'dine-in' and o.table_id is not null and l.unit_price = 11000$$, 1, 'on the table, at the dine-in price');
select t_val(null, 'service_role', 'ot2', $$select public.guest_place_order(jsonb_build_object('token', (select v from t_out where k='tbl'), 'client_id', '66666666-6666-4666-8666-666666666666',
  'lines', jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='tea'), 'quantity', 1))))::text$$);
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.order_lines l join public.orders o on o.id = l.order_id where o.number = 'QR001') = 2$$, 1, 'and a second table order is added to the same table bill');
select t_val(null, 'service_role', 'gt2', $$select public.guest_table((select v from t_out where k='tbl'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='gt2' and (v::jsonb ->> 'kiosk') = 'false'$$, 1, 'a table is not a kiosk');

-- ── ordering food online (kind web) ──
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_kiosk(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Order online', 'kind', 'pizza'))$$, '22023', 'an unknown kind of page is refused');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'w', $$select public.save_kiosk(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Order online', 'kind', 'web'))::text$$);
select t_val(null, 'service_role', 'wtok', $$select v::jsonb ->> 'token' from t_out where k='w'$$);
select t_val(null, 'service_role', 'gtw', $$select public.guest_table((select v from t_out where k='wtok'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='gtw' and (v::jsonb ->> 'kind') = 'web' and (v::jsonb ->> 'kiosk') = 'true' and (v::jsonb ->> 'qr_enabled') = 'true'$$, 1, 'the page learns it is an online-order page');
create or replace function t_web(p_cid text, p_name text, p_phone text) returns jsonb language sql as $$
  select jsonb_build_object('token', (select v from t_out where k='wtok'), 'client_id', p_cid, 'contact', jsonb_build_object('name', p_name, 'phone', p_phone),
    'lines', jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='rice'), 'quantity', 1, 'option_ids', '[]'::jsonb))) $$;
select t_err(null, 'service_role', $$select public.guest_place_order(t_web('a0000000-0000-4000-8000-000000000001', '', '0811111111'))$$, '22023', 'a name is needed');
select t_err(null, 'service_role', $$select public.guest_place_order(t_web('a0000000-0000-4000-8000-000000000001', 'Anna', '123'))$$, '22023', 'a phone number is needed');
select t_err(null, 'service_role', $$select public.guest_place_order(jsonb_build_object('token', (select v from t_out where k='wtok'), 'client_id', 'a0000000-0000-4000-8000-000000000001',
  'lines', jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='rice'), 'quantity', 1))))$$, '22023', 'no contact at all is refused');
select t_val(null, 'service_role', 'w1', $$select public.guest_place_order(t_web('a0000000-0000-4000-8000-000000000001', 'Anna', '081-111-1111'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='w1' and (v::jsonb ->> 'number') = 'WB001' and (v::jsonb ->> 'status') = 'waiting'$$, 1, 'the online order is WB001 and waits for the shop');
select t_rows(null, 'service_role', $$select 1 from public.orders where number = 'WB001' and channel = 'takeaway' and table_id is null and delivery_info ->> 'name' = 'Anna' and delivery_info ->> 'phone' = '081-111-1111'$$, 1, 'a takeaway bill with the guest''s name and phone');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.app_notifications where kind = 'web.order'$$, 1, 'the managers were told');
select t_rows(null, 'service_role', $$select 1 from public.order_lines l join public.orders o on o.id = l.order_id where o.number = 'WB001' and l.unit_price = 9000 and l.status = 'new'$$, 1, 'takeaway price, unsent');
select t_val(null, 'service_role', 'w2', $$select public.guest_place_order(t_web('a0000000-0000-4000-8000-000000000002', 'Anna', '0811111111'))::text$$);
select t_val(null, 'service_role', 'w3', $$select public.guest_place_order(t_web('a0000000-0000-4000-8000-000000000003', 'Anna', '0811111111'))::text$$);
select t_err(null, 'service_role', $$select public.guest_place_order(t_web('a0000000-0000-4000-8000-000000000004', 'Anna', '081 111 1111'))$$, '54000', 'a fourth unpaid order from one phone is refused (digits are compared)');
select t_val(null, 'service_role', 'w5', $$select public.guest_place_order(t_web('a0000000-0000-4000-8000-000000000005', 'Bob', '0822222222'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='w5' and (v::jsonb ->> 'number') = 'WB004'$$, 1, 'another phone is fine');

-- ── the island lists an Order food button for a shop with a web page ──
insert into public.networks (slug, name) values ('koh-test', '{"th":"เกาะทดสอบ","en":"Test Island"}');
insert into public.network_orgs (network_id, org_id) select n.id, (select v::uuid from t_out where k='org') from public.networks n where n.slug = 'koh-test';
insert into public.network_listings (store_id, network_id, org_id, category, title) select (select v::uuid from t_out where k='store'), n.id, (select v::uuid from t_out where k='org'), 'food', '{"th":"คาเฟ่"}' from public.networks n where n.slug = 'koh-test';
select t_val(null, 'service_role', 'isl', $$select public.guest_island('koh-test')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='isl' and (v::jsonb #>> '{shops,0,order_token}') = (select v from t_out where k='wtok')$$, 1, 'the island shows the shop''s online-order link');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_kiosk(jsonb_build_object('store_id', (select v from t_out where k='store'), 'id', (select v::jsonb ->> 'id' from t_out where k='w'), 'active', false))$$, 1, 'switching the page off');
select t_val(null, 'service_role', 'isl2', $$select public.guest_island('koh-test')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='isl2' and (v::jsonb #> '{shops,0,order_token}') = 'null'::jsonb$$, 1, 'a page switched off is no longer on the island');
select t_err(null, 'service_role', $$select public.guest_place_order(t_web('a0000000-0000-4000-8000-000000000009', 'Cy', '0833333333'))$$, 'P0002', 'and cannot be ordered from');

-- ── a concierge page (kind info): no ordering ──
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_kiosk(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Room 1 info', 'kind', 'info'))$$, '0A000', 'a concierge page needs its own module');
update public.stores set module_overrides = module_overrides || '{"guest.concierge": true}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'inf', $$select public.save_kiosk(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Room 1 info', 'kind', 'info'))::text$$);
select t_val(null, 'service_role', 'itok', $$select v::jsonb ->> 'token' from t_out where k='inf'$$);
select t_val(null, 'service_role', 'gti', $$select public.guest_table((select v from t_out where k='itok'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='gti' and (v::jsonb ->> 'kind') = 'info' and (v::jsonb ->> 'qr_enabled') = 'true' and (v::jsonb ->> 'kiosk') = 'false'$$, 1, 'the page learns it is a concierge page');
select t_err(null, 'service_role', $$select public.guest_place_order(jsonb_build_object('token', (select v from t_out where k='itok'), 'client_id', 'b0000000-0000-4000-8000-000000000001',
  'lines', jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='rice'), 'quantity', 1))))$$, '0A000', 'nothing can be ordered from it');

-- ── off, switched off, replaced ──
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_kiosk(jsonb_build_object('store_id', (select v from t_out where k='store'), 'id', (select v::jsonb ->> 'id' from t_out where k='k'), 'rotate', true))$$, 1, 'the owner makes a new token');
select t_err(null, 'service_role', $$select public.guest_place_order(t_order('77777777-7777-4777-8777-777777777777'))$$, 'P0002', 'the old token stops working at once');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'ktok2', $$select (public.save_kiosk(jsonb_build_object('store_id', (select v from t_out where k='store'), 'id', (select v::jsonb ->> 'id' from t_out where k='k')))::jsonb) ->> 'token'$$) ;
update public.stores set module_overrides = module_overrides || '{"kiosk": false}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_rows(null, 'service_role', $$select 1 from public.dining_tables where kind = 'kiosk' and qr_token = (select v from t_out where k='ktok2')$$, 1, 'the new token is the kiosk''s');
select t_err(null, 'service_role', $$select public.guest_place_order(jsonb_build_object('token', (select v from t_out where k='ktok2'), 'client_id', '88888888-8888-4888-8888-888888888888',
  'lines', jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='rice'), 'quantity', 1))))$$, '0A000', 'with the kiosk module off nothing can be ordered');
select t_val(null, 'service_role', 'gt3', $$select public.guest_table((select v from t_out where k='ktok2'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='gt3' and (v::jsonb ->> 'qr_enabled') = 'false'$$, 1, 'and the page is told it is off');
do $$ begin raise notice 'ALL KIOSK TESTS PASSED'; end $$;
