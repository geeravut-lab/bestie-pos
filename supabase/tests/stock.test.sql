-- Stock and recipe cost: moves keep the quantity, recipes are deducted once when a bill is paid, low-stock alerts, rights.
\set ON_ERROR_STOP on
\set QUIET on
alter table public.orgs alter column credit_terms_required set default false;   -- these tests are about the ledger, not the terms (credit_terms.test.sql covers them)

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
  ('00000000-0000-0000-0000-0000000000c9', 'waiter@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme Co','Acme','restaurant')$$, 1, 'owner creates a restaurant');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','cafe')$$, 1, 'a second org exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('00000000-0000-0000-0000-0000000000d4'::uuid, 'Cashier', 'cashier'),
               ('00000000-0000-0000-0000-0000000000c9'::uuid, 'Waiter', 'waiter')) as u(id, n, b) on true
  join public.roles r on r.org_id = o.id and r.built_in = u.b
 where o.name = 'Acme Co';
update public.legal_entities set tax_id = '0105560123456' where name = 'Acme Co';
update public.stores set vat_registered = true, vat_bps = 700, branch_code = '00001' where name = 'Acme';

select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Acme Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Counter', 'cashier', 'POS-77') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cashier_staff', $$select id::text from public.staff where display_name = 'Cashier'$$);

-- two open orders: 210.00 (2 x 90.00 + 30.00) and 30.00
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values ('10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A001', (now() at time zone 'Asia/Bangkok')::date, 'takeaway'), ('10000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A002', (now() at time zone 'Asia/Bangkok')::date, 'takeaway')$$, 2, 'two orders');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', '{"th":"ผัดไทย"}', 9000, 2), ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', '{"th":"ชา"}', 3000, 1), ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', '{"th":"ชา"}', 3000, 1)$$, 3, 'lines');

-- what the till sends (VAT 7 % included in 210.00 = 13.74)
create or replace function t_payload(p_order text, p_no text, p_tendered bigint, p_amount bigint default 21000, p_total bigint default 21000, p_sub bigint default 21000, p_rounding int default 0, p_tender text default 'cash') returns jsonb language sql as $$
  select jsonb_build_object(
    'order_id', p_order, 'receipt_number', p_no, 'device_id', (select v from t_out where k='dev'),
    'staff_id', (select v from t_out where k='cashier_staff'), 'issued_at', now(), 'lang', 'th',
    'subtotal', p_sub, 'service_charge', 0, 'vat', 1374, 'net_before_vat', 19626, 'total', p_total, 'rounding', p_rounding,
    'payable', p_total + p_rounding, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive',
    'payments', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'tender', p_tender, 'amount', p_amount,
       'tendered', p_tendered, 'change', p_tendered - p_amount)));
$$;
grant execute on function t_payload(text, text, bigint, bigint, bigint, bigint, int, text) to authenticated, service_role;


-- ── create / find ──
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.create_customer(jsonb_build_object('org_id', (select v from t_out where k='org'), 'name', 'Mallory'))$$, '42501', 'another org cannot create customers here');
select t_err(null, 'anon', $$select public.find_customers((select v::uuid from t_out where k='org'), 'anna')$$, '42501', 'anon cannot search');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'c1', $$select public.create_customer(jsonb_build_object('org_id', (select v from t_out where k='org'), 'name', 'Anna Smith', 'phone', '+66 81-234-5678', 'consent', true))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='c1' and (v::jsonb ->> 'phone') = '66812345678' and (v::jsonb ->> 'member_code') ~ '^[0-9A-F]{8}$' and (v::jsonb ->> 'balance') = '0'$$, 1, 'the cashier creates a member; the phone is stored as digits and a member code is made');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.create_customer(jsonb_build_object('org_id', (select v from t_out where k='org'), 'name', 'Anna Again', 'phone', '1234567890123456'))$$, '22023', 'a phone with too many digits is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.create_customer(jsonb_build_object('org_id', (select v from t_out where k='org'), 'name', 'Anna Again', 'phone', '66-81-234-5678'))$$, '23505', 'the same phone twice is refused (use the existing member)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.create_customer(jsonb_build_object('org_id', (select v from t_out where k='org'), 'name', '  '))$$, '22023', 'a name is required');


select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cid', $$select (v::jsonb ->> 'id') from t_out where k='c1'$$);
select t_val('00000000-0000-0000-0000-0000000000e5', 'authenticated', 'foreign_org', $$select id::text from public.orgs where name = 'Other'$$);
select t_val('00000000-0000-0000-0000-0000000000e5', 'authenticated', 'fc', $$select (public.create_customer(jsonb_build_object('org_id', (select v from t_out where k='foreign_org'), 'name', 'Foreign Fred')) ->> 'id')$$);
select t_val(null, 'service_role', 'ent1', $$select legal_entity_id::text from public.stores where id = (select v::uuid from t_out where k='store')$$);

create or replace function t_topup(cid text, amount bigint, funding text default 'cash') returns jsonb language sql as $$
  select jsonb_build_object('id', cid, 'customer_id', (select v from t_out where k='cid'), 'store_id', (select v from t_out where k='store'),
    'device_id', (select v from t_out where k='dev'), 'amount', amount, 'funding', funding)
$$;
grant execute on function t_topup(text, bigint, text) to authenticated, service_role;


update public.order_lines set status = 'sent', sent_at = now();
update public.stores set module_overrides = '{"tender.credit": true}' where id = (select v::uuid from t_out where k='store');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.topup_credit(t_topup('50000000-0000-4000-8000-000000000001', 100000))$$, 1, 'Anna has 1,000.00 Credit');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_customer('10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='cid'))$$, 1, 'Anna is on bill 1 (210.00)');
update public.stores set module_overrides = '{"tender.credit": true, "tender.gateway": true}' where id = (select v::uuid from t_out where k='store');
update public.devices set reader_id = 'tmr_ABC123xyz' where id = (select v::uuid from t_out where k='dev');

-- bill 1 = 210.00. Split: 50.00 Credit + 60.00 cash (handed 100.00) + 100.00 PromptPay.
create or replace function t_att(p_tender text, p_legs jsonb, p_order text default '10000000-0000-4000-8000-000000000001', p_total bigint default 21000, p_round int default 0) returns jsonb language sql as $$
  select jsonb_build_object('order_id', p_order, 'device_id', (select v from t_out where k='dev'), 'staff_id', (select v from t_out where k='cashier_staff'),
    'tender', p_tender, 'lang', 'en', 'subtotal', 21000, 'points_discount', 0, 'service_charge', 0, 'vat', 1374, 'net_before_vat', 19626, 'total', p_total, 'rounding', p_round,
    'payable', p_total + p_round, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive', 'legs', p_legs)
$$;
create or replace function t_leg_cash(id text, amount bigint, tendered bigint) returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'tender', 'cash', 'amount', amount, 'tendered', tendered, 'change', tendered - amount) $$;
create or replace function t_leg_cr(id text, amount bigint) returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'tender', 'credit', 'amount', amount) $$;
grant execute on function t_att(text, jsonb, text, bigint, int), t_leg_cash(text, bigint, bigint), t_leg_cr(text, bigint) to authenticated, service_role;


-- a dish with a recipe (service role sets up the menu)
select t_val(null, 'service_role', 'cat', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"จาน"}') returning id::text$$);
select t_val(null, 'service_role', 'dish', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"ผัดไทย"}', '{"base": 8000}') returning id::text$$);

-- ── rights ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.stock_items (org_id, store_id, name, unit) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"แป้ง"}', 'g')$$, '42501', 'a cashier (no menu.edit) cannot create a stock item');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'flour', $$insert into public.stock_items (org_id, store_id, name, unit, cost_per_1000, low_at, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"เส้นจันท์","en":"Rice noodles"}', 'g', 3500, 1000, 999999) returning id::text$$);
select t_rows(null, 'service_role', $$select 1 from public.stock_items where id = (select v::uuid from t_out where k='flour') and quantity = 0$$, 1, 'a new item always starts at zero (a quantity typed in is ignored)');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.stock_items set quantity = 50000 where id = (select v::uuid from t_out where k='flour')$$, '23514', 'the quantity cannot be edited directly');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.stock_items (org_id, store_id, name, unit) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"x"}', 'oz')$$, '23514', 'units are g, ml or pcs');

-- ── moves ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.stock_move(jsonb_build_object('item_id', (select v from t_out where k='flour'), 'kind', 'receive', 'quantity', 5000))$$, '42501', 'a cashier cannot record goods in');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'q1', $$select public.stock_move(jsonb_build_object('item_id', (select v from t_out where k='flour'), 'kind', 'receive', 'quantity', 5000, 'cost_per_1000', 4000))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='q1' and v = '5000'$$, 1, 'receive 5,000 g → 5,000 g on hand');
select t_rows(null, 'service_role', $$select 1 from public.stock_items where id = (select v::uuid from t_out where k='flour') and cost_per_1000 = 4000$$, 1, 'goods in at a new cost updates the cost');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'q2', $$select public.stock_move(jsonb_build_object('item_id', (select v from t_out where k='flour'), 'kind', 'waste', 'quantity', 200, 'note', 'dropped'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='q2' and v = '4800'$$, 1, 'waste 200 g → 4,800');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'q3', $$select public.stock_move(jsonb_build_object('item_id', (select v from t_out where k='flour'), 'kind', 'count', 'quantity', 4500))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='q3' and v = '4500'$$, 1, 'a count of 4,500 g sets the quantity (move of −300)');
select t_rows(null, 'service_role', $$select 1 from public.stock_moves where kind = 'count' and qty_delta = -300$$, 1, 'and the history shows the difference');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.stock_move(jsonb_build_object('item_id', (select v from t_out where k='flour'), 'kind', 'receive', 'quantity', 1.5))$$, '22023', 'whole numbers only');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.stock_move(jsonb_build_object('item_id', (select v from t_out where k='flour'), 'kind', 'sale', 'quantity', 1))$$, '22023', 'a person cannot make a "sale" move');
select t_err(null, 'service_role', $$update public.stock_moves set note = 'x'$$, '23514', 'history cannot be edited');
select t_err(null, 'service_role', $$delete from public.stock_moves$$, '23514', 'or deleted');

-- ── recipes ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.recipe_lines (org_id, store_id, menu_item_id, item_id, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='dish'), (select v::uuid from t_out where k='flour'), 150)$$, '42501', 'a cashier cannot write recipes');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.recipe_lines (org_id, store_id, menu_item_id, item_id, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='dish'), (select v::uuid from t_out where k='flour'), 150)$$, 1, 'Pad Thai uses 150 g of noodles per portion');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.recipe_lines (org_id, store_id, menu_item_id, item_id, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='dish'), (select v::uuid from t_out where k='flour'), 100)$$, '23505', 'one line per ingredient');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.recipe_lines where false$$ || '; select public.stock_move(jsonb_build_object(''item_id'', (select v from t_out where k=''flour''), ''kind'', ''receive'', ''quantity'', 1))', '42501', 'another business cannot move this shop''s stock');

-- ── a paid bill uses its recipe once ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'o3', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values ('10000000-0000-4000-8000-000000000003', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A003', (now() at time zone 'Asia/Bangkok')::date, 'takeaway') returning id::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, status, sent_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000003', (select v::uuid from t_out where k='dish'), '{"th":"ผัดไทย"}', 8000, 2, 'sent', now())$$, 1, 'a bill with 2 × Pad Thai');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(jsonb_build_object('order_id', '10000000-0000-4000-8000-000000000003', 'device_id', (select v from t_out where k='dev'), 'staff_id', (select v from t_out where k='cashier_staff'), 'issued_at', now(), 'lang', 'en', 'subtotal', 16000, 'service_charge', 0, 'vat', 1047, 'net_before_vat', 14953, 'total', 16000, 'rounding', 0, 'payable', 16000, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive', 'payments', jsonb_build_array(t_leg_cash('72000000-0000-4000-8000-000000000001', 16000, 16000))))$$, 1, 'the bill is paid');
select t_rows(null, 'service_role', $$select 1 from public.stock_moves where kind = 'sale' and qty_delta = -300 and order_id = '10000000-0000-4000-8000-000000000003'$$, 1, '2 portions use 300 g');
select t_rows(null, 'service_role', $$select 1 from public.stock_items where id = (select v::uuid from t_out where k='flour') and quantity = 4200$$, 1, 'stock is 4,200 g');
select t_rows(null, 'service_role', $$update public.orders set status = 'paid' where id = '10000000-0000-4000-8000-000000000003' returning 1$$, 1, 'paying again (a replay)');
select t_rows(null, 'service_role', $$select 1 from public.stock_moves where kind = 'sale'$$, 1, 'does not use the recipe twice');

-- ── low stock: told once a day ──
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'q4', $$select public.stock_move(jsonb_build_object('item_id', (select v from t_out where k='flour'), 'kind', 'waste', 'quantity', 3300))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.app_notifications where kind = 'stock.low' and user_id = '00000000-0000-0000-0000-0000000000a1'$$, 1, 'falling to 900 g (level 1,000) tells the owner');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'q5', $$select public.stock_move(jsonb_build_object('item_id', (select v from t_out where k='flour'), 'kind', 'waste', 'quantity', 100))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.app_notifications where kind = 'stock.low'$$, 1, 'but only once (already below the level)');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'q6', $$select public.stock_move(jsonb_build_object('item_id', (select v from t_out where k='flour'), 'kind', 'waste', 'quantity', 2000))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.stock_items where id = (select v::uuid from t_out where k='flour') and quantity = -1200$$, 1, 'stock may go negative (selling is never blocked)');
do $$ begin raise notice 'ALL STOCK TESTS PASSED'; end $$;
