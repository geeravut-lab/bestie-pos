-- Smart operations: forecast, waste, lots, cost alerts, service cases, business manager, ETA, disputes and refunds.
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




-- the shop's calendar day (Bangkok) moves every day: the fixtures are placed relative to TODAY so this test never goes stale
create or replace function t_d(n int) returns date language sql as $$ select (now() at time zone 'Asia/Bangkok')::date + n $$;
create or replace function t_ds(n int) returns text language sql as $$ select ((now() at time zone 'Asia/Bangkok')::date + n)::text $$;
create or replace function t_ts(n int, hhmm text) returns timestamptz language sql as $$ select (((now() at time zone 'Asia/Bangkok')::date + n)::text || ' ' || hhmm || ':00+07')::timestamptz $$;
grant execute on function t_d(int), t_ds(int), t_ts(int, text) to anon, authenticated, service_role;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'manager@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme Co','Acme','restaurant')$$, 1, 'owner creates a restaurant');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','cafe')$$, 1, 'a second org exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('00000000-0000-0000-0000-0000000000b2'::uuid, 'Manager', 'manager'),
               ('00000000-0000-0000-0000-0000000000d4'::uuid, 'Cashier', 'cashier')) as u(id, n, b) on true
  join public.roles r on r.org_id = o.id and r.built_in = u.b
 where o.name = 'Acme Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Acme Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store2', $$select public.create_store((select v::uuid from t_out where k='org'), 'Beach Cafe', 'cafe')::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Counter', 'cashier') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev2', $$insert into public.devices (org_id, store_id, name, role) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), 'Cafe till', 'cashier') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cash_staff', $$select id::text from public.staff where display_name = 'Cashier'$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'mgr_staff', $$select id::text from public.staff where display_name = 'Manager'$$);

-- history, written as the server: 3 paid bills in shop 1 (two days, two hours), 1 in shop 2, 1 void bill, 1 bill with a cancelled line
-- A001 16 Nov 10:15 Bangkok: 2 x Pad Thai 90.00 + Tea 30.00 = 210.00 cash (cashier)
-- A002 16 Nov 19:40: Beer 3 x 60.00 = 180.00 promptpay (manager)
-- A003 17 Nov 10:50: Pad Thai 90.00 + cancelled Soup 70.00 = 90.00 cash (cashier)
-- C001 17 Nov 12:05 (Beach Cafe): Latte 55.00 = 55.00 gateway
-- A004: void bill, must not count
select t_rows(null, 'service_role', $$insert into public.orders (id, org_id, store_id, number, business_date, channel, status) values
  ('10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A001', t_d(-2), 'takeaway', 'paid'),
  ('10000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A002', t_d(-2), 'takeaway', 'paid'),
  ('10000000-0000-4000-8000-000000000003', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A003', t_d(-1), 'takeaway', 'paid'),
  ('10000000-0000-4000-8000-000000000004', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), 'B001', t_d(-1), 'takeaway', 'paid'),
  ('10000000-0000-4000-8000-000000000005', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A004', t_d(-1), 'takeaway', 'void')$$, 5, 'orders');
select t_rows(null, 'service_role', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, status, sent_at) values
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', '{"th":"ผัดไทย","en":"Pad Thai"}', 9000, 2, 'sent', now()),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', '{"th":"ชา","en":"Tea"}', 3000, 1, 'sent', now()),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', '{"th":"เบียร์","en":"Beer"}', 6000, 3, 'sent', now()),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000003', '{"th":"ผัดไทย","en":"Pad Thai"}', 9000, 1, 'sent', now()),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000003', '{"th":"ต้มยำ","en":"Soup"}', 7000, 1, 'sent', now()),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), '10000000-0000-4000-8000-000000000004', '{"th":"ลาเต้","en":"Latte"}', 5500, 1, 'sent', now()),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000005', '{"th":"ผัดไทย","en":"Pad Thai"}', 9000, 9, 'sent', now())$$, 7, 'lines');
select t_rows(null, 'service_role', $$update public.order_lines set status = 'void', void_reason = 'test' where name ->> 'en' = 'Soup' returning id$$, 1, 'one line is cancelled');
select t_rows(null, 'service_role', $$insert into public.receipts (org_id, store_id, order_id, number, device_id, staff_id, issued_at, seller_name, branch_code, vat_registered, vat_bps, service_bps, price_mode, subtotal, service_charge, vat, net_before_vat, total, payable) values
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', 'A-000001', (select v::uuid from t_out where k='dev'), (select v::uuid from t_out where k='cash_staff'), t_ts(-2, '10:15'), 'Acme Co', '00000', true, 700, 0, 'inclusive', 21000, 0, 1374, 19626, 21000, 21000),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', 'A-000002', (select v::uuid from t_out where k='dev'), (select v::uuid from t_out where k='mgr_staff'), t_ts(-2, '19:40'), 'Acme Co', '00000', true, 700, 0, 'inclusive', 18000, 0, 1178, 16822, 18000, 18000),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000003', 'A-000003', (select v::uuid from t_out where k='dev'), (select v::uuid from t_out where k='cash_staff'), t_ts(-1, '10:50'), 'Acme Co', '00000', true, 700, 0, 'inclusive', 9000, 0, 589, 8411, 9000, 9000),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), '10000000-0000-4000-8000-000000000004', 'B-000001', (select v::uuid from t_out where k='dev2'), null, t_ts(-1, '12:05'), 'Acme Co', '00001', true, 700, 0, 'inclusive', 5500, 0, 360, 5140, 5500, 5500)$$, 4, 'receipts');
select t_rows(null, 'service_role', $$insert into public.payments (org_id, store_id, order_id, tender, amount, tendered, change) values
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', 'cash', 21000, 50000, 29000),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', 'promptpay', 18000, null, 0),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000003', 'cash', 9000, 9000, 0),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), '10000000-0000-4000-8000-000000000004', 'gateway', 5500, null, 0)$$, 4, 'payments');

create or replace function t_r(p_store text, p_from text, p_to text) returns jsonb language sql as $$
  select jsonb_build_object('store_id', p_store, 'from', p_from, 'to', p_to)
$$;
grant execute on function t_r(text, text, text) to authenticated, service_role;
select t_val(null, 'service_role', 'owner_staff', $$select id::text from public.staff where org_id = (select v::uuid from t_out where k='org') and display_name <> 'Cashier' and display_name <> 'Manager' limit 1$$);

-- ── stock fixtures: milk (cost 80/kg), ten days of use ──
select t_val(null, 'service_role', 'milk', $$insert into public.stock_items (org_id, store_id, name, unit, cost_per_1000, low_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"นม","en":"Milk"}', 'ml', 8000, 0) returning id::text$$);
select t_rows(null, 'service_role', $$insert into public.stock_moves (org_id, store_id, item_id, kind, qty_delta, cost_per_1000, created_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='milk'), 'receive', 10000, 5000, now() - interval '40 days')$$, 1, 'milk received 40 days ago at 50.00 a litre');
update public.stock_items set cost_per_1000 = 8000 where id = (select v::uuid from t_out where k='milk');   -- the price went up since that old delivery
select t_rows(null, 'service_role', $$insert into public.stock_moves (org_id, store_id, item_id, kind, qty_delta, created_at) select (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='milk'), 'sale', -300, now() - make_interval(days => g) from generate_series(1, 28) g$$, 28, '28 days of selling 300 ml');
select t_rows(null, 'service_role', $$select 1 from public.stock_items where id = (select v::uuid from t_out where k='milk') and quantity = 1600$$, 1, 'the shelf holds 1,600 ml');

-- ── forecast ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.stock_forecast(jsonb_build_object('store_id', (select v from t_out where k='store')))$$, '42501', 'a cashier cannot read the forecast');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'fc', $$select public.stock_forecast(jsonb_build_object('store_id', (select v from t_out where k='store')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb) e where o.k='fc' and (e ->> 'avg_daily')::numeric = 300 and (e ->> 'days_left')::numeric = 5.3 and (e ->> 'forecast') = '2700' and (e ->> 'suggested') = '1100'$$, 1, 'milk: 300 a day, 5.3 days left, 9 days need 2,700, order 1,100');
select t_val(null, 'service_role', 'sup', $$insert into public.suppliers (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Dairy Co') returning id::text$$);
select t_val(null, 'service_role', 'po', $$insert into public.purchase_orders (org_id, store_id, supplier_id, number, status) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='sup'), 'PO-0001', 'sent') returning id::text$$);
select t_rows(null, 'service_role', $$insert into public.purchase_order_lines (org_id, store_id, po_id, item_id, qty_ordered, qty_received, cost_per_1000) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='po'), (select v::uuid from t_out where k='milk'), 500, 0, 6000)$$, 1, 'an order of 500 ml is on its way');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'fc2', $$select public.stock_forecast(jsonb_build_object('store_id', (select v from t_out where k='store')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb) e where o.k='fc2' and (e ->> 'on_order') = '500' and (e ->> 'suggested') = '600' and (e ->> 'supplier_name') = 'Dairy Co'$$, 1, 'what is on order is taken off the suggestion, and the supplier is the last one used');
select t_rows(null, 'service_role', $$update public.purchase_order_lines set qty_received = 500 where po_id = (select v::uuid from t_out where k='po')$$, 1, 'the goods arrive');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'sp', $$select public.supplier_prices(jsonb_build_object('store_id', (select v from t_out where k='store')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb) e where o.k='sp' and (e ->> 'supplier_name') = 'Dairy Co' and (e ->> 'cost_per_1000') = '6000'$$, 1, 'the supplier price list shows the price paid');

-- ── waste reasons and report ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.stock_move(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'kind', 'waste', 'quantity', 100, 'reason', 'expired'))$$, '42501', 'a cashier cannot book waste');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.stock_move(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'kind', 'waste', 'quantity', 100, 'reason', 'expired'))$$, 1, 'the owner books 100 ml of waste: expired');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.stock_move(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'kind', 'waste', 'quantity', 50, 'reason', 'nonsense'))$$, 1, 'a reason outside the list is simply not stored');
select t_rows(null, 'service_role', $$select 1 from public.stock_moves where kind = 'waste' and reason = 'expired' and qty_delta = -100$$, 1, 'the reason is on the move');
select t_rows(null, 'service_role', $$select 1 from public.stock_moves where kind = 'waste' and reason is null and qty_delta = -50$$, 1, 'and missing on the other');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'wr', $$select public.waste_report(t_r((select v from t_out where k='store'), t_ds(-1), t_ds(0)))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='wr' and (v::jsonb ->> 'total') = '1200' and (v::jsonb #>> '{by_reason,0,reason}') = 'expired' and (v::jsonb #>> '{by_reason,0,cost}') = '800'$$, 1, 'waste costs 12.00: 8.00 expired, 4.00 without a reason');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.waste_report(t_r((select v from t_out where k='store'), t_ds(-1), t_ds(0)))$$, '42501', 'a cashier cannot read it');

-- ── lots ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_stock_batch(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'qty', 500, 'expires_on', t_ds(2)))$$, '42501', 'a cashier cannot add a lot');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'lot', $$select public.save_stock_batch(jsonb_build_object('item_id', (select v from t_out where k='milk'), 'qty', 500, 'expires_on', t_ds(2), 'code', 'L-1'))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select 1 from public.stock_batches where expires_on <= t_d(3) and used_at is null$$, 1, 'the manager sees the lot that expires in 2 days');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.stock_batches$$, 0, 'another business does not');

-- ── cost alerts ──
select t_rows(null, 'service_role', $$insert into public.recipe_lines (org_id, store_id, menu_item_id, item_id, quantity) select (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), id, (select v::uuid from t_out where k='milk'), 200 from public.menu_items where false$$, 0, 'no dish yet');
select t_val(null, 'service_role', 'cat', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"x"}') returning id::text$$);
select t_val(null, 'service_role', 'latte', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"ลาเต้","en":"Latte"}', '{"base":6000}') returning id::text$$);
select t_rows(null, 'service_role', $$insert into public.recipe_lines (org_id, store_id, menu_item_id, item_id, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='latte'), (select v::uuid from t_out where k='milk'), 200)$$, 1, 'a latte uses 200 ml of milk');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'ca', $$select public.cost_alerts(jsonb_build_object('store_id', (select v from t_out where k='store')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb) e where o.k='ca' and (e ->> 'cost_before')::int = 1000 and (e ->> 'cost_now')::int = 1600$$, 1, 'the milk went from 50.00 to 80.00 a litre: the latte cost rose from 10.00 to 16.00');

-- ── service cases ──
select t_val(null, 'service_role', 'fb1', $$insert into public.guest_feedback (org_id, store_id, rating, topic, comment) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 1, 'food', 'cold soup') returning id::text$$);
select t_rows(null, 'service_role', $$insert into public.guest_feedback (org_id, store_id, rating, topic) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 5, 'food')$$, 1, 'a happy guest');
select t_rows(null, 'service_role', $$select 1 from public.service_cases where source = 'feedback' and feedback_id = (select v::uuid from t_out where k='fb1') and status = 'open' and summary like '1/5%cold soup%'$$, 1, 'a rating of 1 opened a case; a 5 did not');
select t_rows(null, 'service_role', $$select 1 from public.service_cases$$, 1, 'one case only');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'case1', $$select id::text from public.service_cases limit 1$$);
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.service_cases$$, 0, 'another business cannot read it');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.case_ack((select v::uuid from t_out where k='case1'))$$, 1, 'the cashier takes the case');
select t_rows(null, 'service_role', $$select 1 from public.service_cases where status = 'acknowledged' and first_response_at is not null and assignee is not null$$, 1, 'the clock stops and the case has an owner');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.case_assign((select v::uuid from t_out where k='case1'), (select v::uuid from t_out where k='mgr_staff'))$$, '42501', 'a cashier cannot hand a case to someone');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.case_assign((select v::uuid from t_out where k='case1'), (select v::uuid from t_out where k='mgr_staff'))$$, 1, 'a manager can');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.case_resolve((select v::uuid from t_out where k='case1'), '  ', true)$$, '22023', 'a case is closed with what was done');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.case_resolve((select v::uuid from t_out where k='case1'), 'new soup and an apology', true)$$, 1, 'resolved');
select t_rows(null, 'service_role', $$select 1 from public.guest_feedback where id = (select v::uuid from t_out where k='fb1') and handled and handled_at is not null$$, 1, 'the feedback is marked handled by the case');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.case_reopen((select v::uuid from t_out where k='case1'))$$, '42501', 'a cashier cannot reopen');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.case_reopen((select v::uuid from t_out where k='case1'))$$, 1, 'a manager can');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'case2', $$select public.open_case(jsonb_build_object('store_id', (select v from t_out where k='store'), 'summary', 'Table 4 waits for the bill', 'sla_min', 5))::text$$);
select t_rows(null, 'service_role', $$select 1 where public.service_cases_escalate() = 0$$, 1, 'nothing is late yet');
update public.service_cases set created_at = now() - interval '30 minutes' where id = (select v::uuid from t_out where k='case2');
select t_rows(null, 'service_role', $$select 1 where public.service_cases_escalate() = 1$$, 1, 'the case nobody answered in 5 minutes escalates');
select t_rows(null, 'service_role', $$select 1 where public.service_cases_escalate() = 0$$, 1, 'and only once');
select t_rows(null, 'service_role', $$select 1 from public.app_notifications where kind = 'guest.case_overdue'$$, 2, 'the owner and the manager each have a notice');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'ck', $$select public.case_kpi(t_r((select v from t_out where k='store'), t_ds(-1), t_ds(0)))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='ck' and (v::jsonb ->> 'cases') = '2' and (v::jsonb ->> 'late') = '1'$$, 1, 'case figures: 2 cases, 1 late');

-- ── the business manager ──
select t_rows(null, 'service_role', $$insert into public.stock_moves (org_id, store_id, item_id, kind, qty_delta) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='milk'), 'adjust', -600)$$, 1, 'a spill of 600 ml is booked: the shelf now holds 850 ml, under 3 days');
select t_rows(null, 'service_role', $$select 1 where public.generate_insights((select v::uuid from t_out where k='store')) = 0$$, 1, 'with the module off nothing is generated');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.brief_context((select v::uuid from t_out where k='store'))$$, '42501', 'and the page is closed');
update public.stores set plan = 'pro', module_overrides = module_overrides || '{"ai.business_manager": true}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_rows(null, 'service_role', $$select 1 where public.generate_insights((select v::uuid from t_out where k='store')) >= 2$$, 1, 'with it on: low stock and the overdue case are found');
select t_rows(null, 'service_role', $$select 1 where public.generate_insights((select v::uuid from t_out where k='store')) = 0$$, 1, 'a second look the same day finds nothing new');
select t_rows(null, 'service_role', $$select 1 from public.business_insights where kind = 'low_stock' and severity = 'act' and action ->> 'type' = 'draft_po' and evidence #>> '{items,0,days_left}' = '2.8'$$, 1, 'the low-stock finding carries its evidence and a proposed purchase');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.business_insights$$, 0, 'a cashier cannot read insights');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'brief', $$select public.brief_context((select v::uuid from t_out where k='store'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='brief' and jsonb_array_length(v::jsonb -> 'insights') >= 2$$, 1, 'the manager reads the brief');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'ins', $$select id::text from public.business_insights where kind = 'low_stock'$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.decide_insight((select v::uuid from t_out where k='ins'), 'approved')$$, '42501', 'a cashier cannot decide');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dec', $$select public.decide_insight((select v::uuid from t_out where k='ins'), 'approved', 'ok')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='dec' and (v::jsonb ->> 'status') = 'approved' and jsonb_array_length(v::jsonb -> 'purchase_orders') = 1$$, 1, 'approving made one purchase draft (one supplier)');
select t_rows(null, 'service_role', $$select 1 from public.purchase_orders po join public.purchase_order_lines l on l.po_id = po.id where po.status = 'draft' and po.note like 'Business manager%' and l.qty_ordered = 1850$$, 1, 'the draft asks for 1,850 ml (9 days need 2,700, 850 are on the shelf)');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dec2', $$select public.decide_insight((select v::uuid from t_out where k='ins'), 'dismissed')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='dec2' and (v::jsonb ->> 'status') = 'approved'$$, 1, 'a decided insight cannot be decided again');

-- ── waiting time for a guest ──
select t_val(null, 'service_role', 'tbl', $$insert into public.dining_tables (org_id, store_id, name, seats) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'T9', 4) returning id::text$$);
select t_val(null, 'service_role', 'tok', $$select qr_token from public.dining_tables where id = (select v::uuid from t_out where k='tbl')$$);
select t_rows(null, 'service_role', $$insert into public.orders (id, org_id, store_id, number, business_date, channel, status, table_id) values ('10000000-0000-4000-8000-0000000000e1', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A099', t_d(0), 'dine-in', 'open', (select v::uuid from t_out where k='tbl'))$$, 1, 'a bill on table T9');
select t_val(null, 'service_role', 'eta0', $$select public.guest_eta((select v from t_out where k='tok'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='eta0' and (v::jsonb -> 'minutes') = 'null'::jsonb$$, 1, 'nothing sent yet: no estimate');
select t_rows(null, 'service_role', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, status, sent_at) values
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', '{"th":"ก"}', 100, 1, 'sent', now() - interval '2 days'),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', '{"th":"ข"}', 100, 1, 'sent', now() - interval '1 day')$$, 2, 'two lines sent in the past');
select t_rows(null, 'service_role', $$update public.order_lines set status = 'served', ready_at = sent_at + interval '10 minutes' where name ->> 'th' in ('ก', 'ข') returning id$$, 2, 'the kitchen took 10 minutes for each');
select t_rows(null, 'service_role', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, status, sent_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-0000000000e1', '{"th":"ค"}', 100, 1, 'sent', now())$$, 1, 'the guest''s line is sent');
select t_val(null, 'service_role', 'eta1', $$select public.guest_eta((select v from t_out where k='tok'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='eta1' and (v::jsonb ->> 'minutes')::int between 10 and 15 and (v::jsonb ->> 'waiting') = '1'$$, 1, 'about 10 minutes plus a little for the lines already waiting ahead');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.guest_eta('x')$$, '42501', 'the browser cannot call it');

-- ── disputes, refunds, reconciliation ──
select t_rows(null, 'service_role', $$insert into public.payment_attempts (org_id, store_id, order_id, device_id, tender, amount, snapshot, provider, provider_ref, status) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='dev'), 'promptpay', 21000, '{}', 'stripe', 'pi_1', 'succeeded')$$, 1, 'a PromptPay payment through the provider');
select t_val(null, 'service_role', 'dsp', $$select public.record_payment_dispute(jsonb_build_object('provider', 'stripe', 'dispute_ref', 'dp_1', 'payment_ref', 'pi_1', 'amount', 21000, 'reason', 'fraudulent', 'status', 'needs_response'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='dsp' and v = 'true'$$, 1, 'a dispute is recorded as new');
select t_val(null, 'service_role', 'dsp2', $$select public.record_payment_dispute(jsonb_build_object('provider', 'stripe', 'dispute_ref', 'dp_1', 'payment_ref', 'pi_1', 'amount', 21000, 'status', 'won'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='dsp2' and v = 'false'$$, 1, 'the same dispute again is an update');
select t_rows(null, 'service_role', $$select 1 from public.payment_disputes where dispute_ref = 'dp_1' and status = 'won' and order_id = '10000000-0000-4000-8000-000000000001'$$, 1, 'with its new status');
select t_val(null, 'service_role', 'dsp3', $$select public.record_payment_dispute(jsonb_build_object('provider', 'stripe', 'dispute_ref', 'dp_x', 'payment_ref', 'pi_unknown', 'amount', 1, 'status', 'open'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='dsp3' and v = 'false'$$, 1, 'a dispute for a payment Bestie does not know is ignored, not an error');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.refund_context('10000000-0000-4000-8000-000000000001', 5000)$$, '42501', 'a cashier cannot refund');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.refund_context('10000000-0000-4000-8000-000000000001', 99999)$$, '22023', 'more than was paid is refused');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.refund_context('10000000-0000-4000-8000-000000000003', 100)$$, '55000', 'a cash bill has nothing to refund through the provider');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'rc', $$select public.refund_context('10000000-0000-4000-8000-000000000001', 5000)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='rc' and (v::jsonb ->> 'provider_ref') = 'pi_1' and (v::jsonb ->> 'max') = '21000'$$, 1, 'the manager may refund up to 210.00 of this payment');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'rf', $$select public.record_provider_refund(jsonb_build_object('order_id', '10000000-0000-4000-8000-000000000001', 'attempt_id', (select v::jsonb ->> 'attempt_id' from t_out where k='rc'), 'provider', 'stripe', 'refund_ref', 're_1', 'amount', 5000, 'reason', 'wrong dish'))::text$$);
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'rf2', $$select coalesce(public.record_provider_refund(jsonb_build_object('order_id', '10000000-0000-4000-8000-000000000001', 'provider', 'stripe', 'refund_ref', 're_1', 'amount', 5000))::text, 'none')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='rf2' and v = 'none'$$, 1, 'the same refund id again changes nothing');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'rc2', $$select public.refund_context('10000000-0000-4000-8000-000000000001', 1000)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='rc2' and (v::jsonb ->> 'max') = '16000' and (v::jsonb ->> 'count') = '1'$$, 1, 'what is left to refund went down by what was refunded');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'rr', $$select public.reconcile_rows(jsonb_build_object('store_id', (select v from t_out where k='store'), 'from', (now() - interval '2 days')::text, 'to', (now() + interval '1 day')::text))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='rr' and (v::jsonb #>> '{attempts,0,provider_ref}') = 'pi_1' and (v::jsonb #>> '{attempts,0,order_number}') = 'A001' and jsonb_array_length(v::jsonb -> 'refunds') = 1 and jsonb_array_length(v::jsonb -> 'disputes') = 1$$, 1, 'the reconciliation list has the payment, the refund and the dispute');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.reconcile_rows(jsonb_build_object('store_id', (select v from t_out where k='store'), 'from', (now() - interval '2 days')::text, 'to', now()::text))$$, '42501', 'a cashier cannot see it');
\echo ALL SMART OPS TESTS PASSED
