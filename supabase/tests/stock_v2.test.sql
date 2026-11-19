-- Stock and recipe cost: moves keep the quantity, recipes are deducted once when a bill is paid, low-stock alerts, rights.
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
  ('00000000-0000-0000-0000-0000000000b2', 'manager@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test'),
  ('00000000-0000-0000-0000-0000000000f6', 'viewer@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme Co','Acme','restaurant')$$, 1, 'owner creates a restaurant');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','cafe')$$, 1, 'a second business exists');
insert into public.roles (org_id, name, permissions)
select id, 'Stock viewer', array['stock.view'] from public.orgs where name = 'Acme Co';
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('00000000-0000-0000-0000-0000000000b2'::uuid, 'Manager', 'manager', null),
               ('00000000-0000-0000-0000-0000000000d4'::uuid, 'Cashier', 'cashier', null),
               ('00000000-0000-0000-0000-0000000000f6'::uuid, 'Viewer', null, 'Stock viewer')) as u(id, n, b, rn) on true
  join public.roles r on r.org_id = o.id and (r.built_in = u.b or r.name = u.rn)
 where o.name = 'Acme Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Acme Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Acme'$$);
-- a second shop of the same business and a shop of another business
select t_val(null, 'service_role', 'branch', $$insert into public.stores (org_id, legal_entity_id, name, profile) select org_id, legal_entity_id, 'Branch', 'cafe' from public.stores where name = 'Acme' returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000e5', 'authenticated', 'foreign_store', $$select id::text from public.stores where name = 'Other'$$);

-- ── permissions ──
select t_rows(null, 'service_role', $$select 1 from unnest(public.known_permissions()) p where p in ('stock.manage', 'stock.view') having count(*) = 2$$, 1, 'the two stock permissions are known');
select t_rows(null, 'service_role', $$select 1 from public.roles where built_in = 'manager' and 'stock.manage' = any (permissions) and 'stock.view' = any (permissions) having count(*) >= 1$$, 1, 'the built-in manager holds both');
select t_rows(null, 'service_role', $$select 1 from public.roles where built_in = 'cashier' and ('stock.manage' = any (permissions) or 'stock.view' = any (permissions))$$, 0, 'the cashier holds neither');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.stock_items (org_id, store_id, name, unit) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"นม"}', 'ml')$$, '42501', 'a cashier cannot create stock items');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'milk', $$insert into public.stock_items (org_id, store_id, name, unit, cost_per_1000, low_at, barcode) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"นม","en":"Milk"}', 'ml', 6000, 500, '8851234567890') returning id::text$$);
select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select 1 from public.stock_items where store_id = (select v::uuid from t_out where k='store')$$, 1, 'a role with only stock.view can look');
select t_err('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select public.stock_move(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'kind', 'receive', 'quantity', 100))$$, '42501', 'but not change');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.stock_items$$, 0, 'a cashier sees no stock');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.stock_items$$, 0, 'another business sees none either');

-- ── barcode ──
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$insert into public.stock_items (org_id, store_id, name, unit, barcode) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"นมสำรอง"}', 'ml', '8851234567890')$$, '23505', 'a barcode is unique in a shop');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$insert into public.stock_items (org_id, store_id, name, unit, barcode) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"x"}', 'ml', 'bad code!')$$, '23514', 'and has a plain shape');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select 1 from public.stock_items where barcode = '8851234567890'$$, 1, 'a scanned code finds the item');

-- ── suppliers and purchase orders ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.suppliers (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Makro')$$, '42501', 'a cashier cannot add suppliers');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'sup', $$insert into public.suppliers (org_id, store_id, name, phone) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Makro', '02-123-4567') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'rice', $$insert into public.stock_items (org_id, store_id, name, unit, cost_per_1000, low_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"ข้าวสาร"}', 'g', 3000, 0) returning id::text$$);
create or replace function t_po(lines jsonb, po text default null) returns jsonb language sql as $$
  select jsonb_build_object('id', po, 'store_id', (select v from t_out where k='store'), 'supplier_id', (select v from t_out where k='sup'), 'note', 'weekly', 'lines', lines)
$$;
grant execute on function t_po(jsonb, text) to authenticated, service_role;
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_purchase_order(t_po(jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'quantity', 10000, 'cost_per_1000', 6500))))$$, '42501', 'a cashier cannot raise an order');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_purchase_order(t_po('[]'::jsonb))$$, '22023', 'an order needs lines');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'po1', $$select public.save_purchase_order(t_po(jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'quantity', 10000, 'cost_per_1000', 6500), jsonb_build_object('item_id', (select v from t_out where k='rice'), 'quantity', 20000, 'cost_per_1000', 3200))))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.purchase_orders where id = (select v::uuid from t_out where k='po1') and number = 'PO-0001' and status = 'draft'$$, 1, 'the first order is PO-0001, a draft');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'po2', $$select public.save_purchase_order(t_po(jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'quantity', 500))))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.purchase_orders where id = (select v::uuid from t_out where k='po2') and number = 'PO-0002'$$, 1, 'the next is PO-0002');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'po1b', $$select public.save_purchase_order(t_po(jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'quantity', 10000, 'cost_per_1000', 6500), jsonb_build_object('item_id', (select v from t_out where k='rice'), 'quantity', 20000, 'cost_per_1000', 3200)), (select v from t_out where k='po1')))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.purchase_orders where id = (select v::uuid from t_out where k='po1') and number = 'PO-0001'$$, 1, 'saving a draft again keeps its number');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.receive_purchase_order(jsonb_build_object('po_id', (select v from t_out where k='po1'), 'lines', '[]'::jsonb))$$, '22023', 'receiving nothing is refused');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.set_purchase_order_status((select v::uuid from t_out where k='po1'), 'sent')$$, 1, 'the order is sent to the supplier');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_purchase_order(t_po(jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'quantity', 1)), (select v from t_out where k='po1')))$$, '55000', 'a sent order can no longer be edited');
-- part of the milk arrives, at a better price
select t_val(null, 'service_role', 'line_milk', $$select id::text from public.purchase_order_lines where po_id = (select v::uuid from t_out where k='po1') and item_id = (select v::uuid from t_out where k='milk')$$);
select t_val(null, 'service_role', 'line_rice', $$select id::text from public.purchase_order_lines where po_id = (select v::uuid from t_out where k='po1') and item_id = (select v::uuid from t_out where k='rice')$$);
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'r1', $$select public.receive_purchase_order(jsonb_build_object('po_id', (select v from t_out where k='po1'), 'lines', jsonb_build_array(jsonb_build_object('line_id', (select v from t_out where k='line_milk'), 'quantity', 4000, 'cost_per_1000', 6400))))$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r1' and v = 'partial'$$, 1, 'a part delivery makes the order partial');
select t_rows(null, 'service_role', $$select 1 from public.stock_items where id = (select v::uuid from t_out where k='milk') and quantity = 4000 and cost_per_1000 = 6400$$, 1, 'milk is in stock at the price paid');
select t_rows(null, 'service_role', $$select 1 from public.stock_moves where kind = 'receive' and po_id = (select v::uuid from t_out where k='po1') and note = 'PO-0001'$$, 1, 'with a move that names the order');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.set_purchase_order_status((select v::uuid from t_out where k='po1'), 'cancelled')$$, '55000', 'an order with goods received cannot be cancelled');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'r2', $$select public.receive_purchase_order(jsonb_build_object('po_id', (select v from t_out where k='po1'), 'lines', jsonb_build_array(jsonb_build_object('line_id', (select v from t_out where k='line_milk'), 'quantity', 6000), jsonb_build_object('line_id', (select v from t_out where k='line_rice'), 'quantity', 20500))))$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r2' and v = 'received'$$, 1, 'the rest (a little extra rice) completes it');
select t_rows(null, 'service_role', $$select 1 from public.stock_items where id = (select v::uuid from t_out where k='rice') and quantity = 20500$$, 1, 'more than ordered is accepted');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.receive_purchase_order(jsonb_build_object('po_id', (select v from t_out where k='po1'), 'lines', jsonb_build_array(jsonb_build_object('line_id', (select v from t_out where k='line_milk'), 'quantity', 1))))$$, '55000', 'a completed order cannot receive again');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.set_purchase_order_status((select v::uuid from t_out where k='po2'), 'cancelled')$$, 1, 'a draft with nothing received can be cancelled');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.receive_purchase_order(jsonb_build_object('po_id', (select v from t_out where k='po1'), 'lines', '[]'::jsonb))$$, '42501', 'another business cannot touch the order');

-- ── transfers ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.send_stock_transfer(jsonb_build_object('from_store_id', (select v from t_out where k='store'), 'to_store_id', (select v from t_out where k='branch'), 'lines', jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'quantity', 1000))))$$, '42501', 'a cashier cannot send stock');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.send_stock_transfer(jsonb_build_object('from_store_id', (select v from t_out where k='store'), 'to_store_id', (select v from t_out where k='foreign_store'), 'lines', jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'quantity', 1000))))$$, '42501', 'stock cannot be sent to another business');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.send_stock_transfer(jsonb_build_object('from_store_id', (select v from t_out where k='store'), 'to_store_id', (select v from t_out where k='store'), 'lines', jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'quantity', 1000))))$$, '22023', 'nor to the same shop');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.send_stock_transfer(jsonb_build_object('from_store_id', (select v from t_out where k='store'), 'to_store_id', (select v from t_out where k='branch'), 'lines', jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'quantity', 99999999))))$$, '22023', 'more than is on the shelf cannot be sent');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'tr1', $$select public.send_stock_transfer(jsonb_build_object('from_store_id', (select v from t_out where k='store'), 'to_store_id', (select v from t_out where k='branch'), 'note', 'for the cafe', 'lines', jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'quantity', 3000))))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.stock_items where id = (select v::uuid from t_out where k='milk') and quantity = 7000$$, 1, 'sending takes the goods out of the source at once');
select t_rows(null, 'service_role', $$select 1 from public.stock_transfers where id = (select v::uuid from t_out where k='tr1') and number = 'TR-0001' and status = 'sent'$$, 1, 'the transfer is TR-0001, sent');
select t_rows(null, 'service_role', $$select 1 from public.stock_items where store_id = (select v::uuid from t_out where k='branch')$$, 0, 'nothing exists at the branch yet');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'n1', $$select public.receive_stock_transfer(jsonb_build_object('transfer_id', (select v from t_out where k='tr1')))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.stock_items where store_id = (select v::uuid from t_out where k='branch') and name ->> 'th' = 'นม' and quantity = 3000 and unit = 'ml' and cost_per_1000 = 6500$$, 1, 'receiving creates the item at the branch with the goods and the cost');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.receive_stock_transfer(jsonb_build_object('transfer_id', (select v from t_out where k='tr1')))$$, '55000', 'a transfer is received once');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.cancel_stock_transfer((select v::uuid from t_out where k='tr1'))$$, '55000', 'and cannot be cancelled after that');
-- a second one: matched by name and unit, and a third one called off
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'tr2', $$select public.send_stock_transfer(jsonb_build_object('from_store_id', (select v from t_out where k='store'), 'to_store_id', (select v from t_out where k='branch'), 'lines', jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'quantity', 1000))))::text$$);
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'n2', $$select public.receive_stock_transfer(jsonb_build_object('transfer_id', (select v from t_out where k='tr2')))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.stock_items where store_id = (select v::uuid from t_out where k='branch') and quantity = 4000$$, 1, 'the same item is found again (4,000 ml), not duplicated');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'tr3', $$select public.send_stock_transfer(jsonb_build_object('from_store_id', (select v from t_out where k='store'), 'to_store_id', (select v from t_out where k='branch'), 'lines', jsonb_build_array(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'quantity', 2000))))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.stock_items where id = (select v::uuid from t_out where k='milk') and quantity = 4000$$, 1, 'a third transfer is on the way (4,000 ml left)');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.cancel_stock_transfer((select v::uuid from t_out where k='tr3'))$$, 1, 'it is called off');
select t_rows(null, 'service_role', $$select 1 from public.stock_items where id = (select v::uuid from t_out where k='milk') and quantity = 6000$$, 1, 'and the goods go back to the sender (6,000 ml)');
select t_rows(null, 'service_role', $$select 1 from public.stock_moves where kind = 'transfer_back'$$, 1, 'with its own move');
select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select 1 from public.stock_transfers$$, 3, 'a viewer can read the transfers');

-- ── options that use stock: oat milk instead of milk ──
select t_val(null, 'service_role', 'oat', $$insert into public.stock_items (org_id, store_id, name, unit, cost_per_1000, low_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"นมโอ๊ต"}', 'ml', 9000, 0) returning id::text$$);
select t_val(null, 'service_role', 'cat', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"กาแฟ"}') returning id::text$$);
select t_val(null, 'service_role', 'latte', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"ลาเต้"}', '{"base": 8000}') returning id::text$$);
select t_val(null, 'service_role', 'grp', $$insert into public.modifier_groups (org_id, store_id, name, min_select, max_select) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"นม"}', 0, 1) returning id::text$$);
select t_val(null, 'service_role', 'opt_oat', $$insert into public.modifier_options (org_id, store_id, group_id, name, price_delta) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='grp'), '{"th":"โอ๊ต"}', 2000) returning id::text$$);
select t_val(null, 'service_role', 'opt_extra', $$insert into public.modifier_options (org_id, store_id, group_id, name, price_delta) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='grp'), '{"th":"ช็อตเพิ่ม"}', 1000) returning id::text$$);
select t_val(null, 'service_role', 'beans', $$insert into public.stock_items (org_id, store_id, name, unit, cost_per_1000, low_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"เมล็ดกาแฟ"}', 'g', 90000, 0) returning id::text$$);
select t_rows(null, 'service_role', $$insert into public.recipe_lines (org_id, store_id, menu_item_id, item_id, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='latte'), (select v::uuid from t_out where k='milk'), 150)$$, 1, 'a latte uses 150 ml of milk');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.modifier_option_stock (org_id, store_id, option_id, item_id, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='opt_oat'), (select v::uuid from t_out where k='oat'), 150)$$, '42501', 'a cashier cannot link options to stock');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$insert into public.modifier_option_stock (org_id, store_id, option_id, item_id, quantity, instead_of) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='opt_oat'), (select v::uuid from t_out where k='oat'), 150, (select v::uuid from t_out where k='milk'))$$, 1, 'oat milk uses 150 ml of oat milk INSTEAD OF the milk');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$insert into public.modifier_option_stock (org_id, store_id, option_id, item_id, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='opt_extra'), (select v::uuid from t_out where k='beans'), 9)$$, 1, 'an extra shot uses 9 g of beans on top of the recipe');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$insert into public.modifier_option_stock (org_id, store_id, option_id, item_id, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='opt_oat'), (select v::uuid from t_out where k='rice'), 0)$$, '23514', 'a quantity must be above zero');
select t_err(null, 'service_role', $$insert into public.modifier_option_stock (org_id, store_id, option_id, item_id, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='branch'), (select v::uuid from t_out where k='opt_oat'), (select v::uuid from t_out where k='oat'), 5)$$, '23514', 'an option and an ingredient must be of the same shop');

-- two paid bills: one latte with oat + extra shot (x2 portions), one plain latte
select t_val(null, 'service_role', 'dev', $$insert into public.devices (org_id, store_id, name, role) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Counter', 'cashier') returning id::text$$);
insert into public.orders (id, org_id, store_id, number, business_date, channel, status)
select x.id::uuid, o.org_id, o.store_id, x.no, (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'open'
  from (select v::uuid as org_id, (select v::uuid from t_out where k='store') as store_id from t_out where k='org') o
  cross join (values ('20000000-0000-4000-8000-000000000001', 'A001'), ('20000000-0000-4000-8000-000000000002', 'A002')) x(id, no);
insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, modifiers, status, sent_at)
select (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '20000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='latte'), '{"th":"ลาเต้"}', 11000, 2,
       jsonb_build_array(jsonb_build_object('id', (select v from t_out where k='opt_oat'), 'name', '{"th":"โอ๊ต"}'::jsonb, 'priceDelta', 2000), jsonb_build_object('id', (select v from t_out where k='opt_extra'), 'name', '{"th":"ช็อตเพิ่ม"}'::jsonb, 'priceDelta', 1000)), 'sent', now();
insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, modifiers, status, sent_at)
select (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '20000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='latte'), '{"th":"ลาเต้"}', 8000, 1, '[]'::jsonb, 'sent', now();
select t_rows(null, 'service_role', $$update public.orders set status = 'paid' where id in ('20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002') returning 1$$, 2, 'both bills are paid');
select t_rows(null, 'service_role', $$select 1 from public.stock_items where id = (select v::uuid from t_out where k='oat') and quantity = -300$$, 1, 'oat milk: 2 portions × 150 ml');
select t_rows(null, 'service_role', $$select 1 from public.stock_items where id = (select v::uuid from t_out where k='milk') and quantity = 5850$$, 1, 'milk: only the plain latte used it (6,000 − 150)');
select t_rows(null, 'service_role', $$select 1 from public.stock_items where id = (select v::uuid from t_out where k='beans') and quantity = -18$$, 1, 'beans: 2 portions × 9 g for the extra shot');
select t_rows(null, 'service_role', $$update public.orders set status = 'paid' where id = '20000000-0000-4000-8000-000000000001' returning 1$$, 1, 'paying again (a replay)');
select t_rows(null, 'service_role', $$select 1 from public.stock_moves where kind = 'sale'$$, 3, 'adds no more sale moves (one each for oat milk, milk and beans)');
do $$ begin raise notice 'ALL STOCK V2 TESTS PASSED'; end $$;
