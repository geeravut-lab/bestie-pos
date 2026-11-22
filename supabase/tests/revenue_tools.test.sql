-- Revenue tools: menu profitability, promotions + margin guard, upsell rules, KPI report, menu import.
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

-- dishes for the fixture lines, a recipe with a cost
select t_val(null, 'service_role', 'cat', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"จานหลัก"}') returning id::text$$);
select t_val(null, 'service_role', 'm_pad', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"ผัดไทย","en":"Pad Thai"}', '{"base":9000}') returning id::text$$);
select t_val(null, 'service_role', 'm_tea', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"ชา","en":"Tea"}', '{"base":3000}') returning id::text$$);
select t_val(null, 'service_role', 'm_beer', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"เบียร์","en":"Beer"}', '{"base":6000}') returning id::text$$);
update public.order_lines set item_id = (select v::uuid from t_out where k='m_pad') where name ->> 'en' = 'Pad Thai' and store_id = (select v::uuid from t_out where k='store');
update public.order_lines set item_id = (select v::uuid from t_out where k='m_tea') where name ->> 'en' = 'Tea';
update public.order_lines set item_id = (select v::uuid from t_out where k='m_beer') where name ->> 'en' = 'Beer';

-- ── menu profitability ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.menu_profit_report(t_r((select v from t_out where k='store'), t_ds(-2), t_ds(-1)))$$, '42501', 'a cashier cannot read the profit report');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.menu_profit_report(t_r((select v from t_out where k='store'), t_ds(-2), t_ds(-1)))$$, '42501', 'another business cannot');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'mp1', $$select public.menu_profit_report(t_r((select v from t_out where k='store'), t_ds(-2), t_ds(-1)))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb) e where o.k='mp1' and (e ->> 'qty') = '3' and (e ->> 'revenue') = '25234' and e -> 'cost_unit' = 'null'::jsonb and (e -> 'name' ->> 'en') = 'Pad Thai'$$, 1, 'Pad Thai: 3 sold, revenue 252.34 before VAT (inclusive prices ÷ 1.07), no recipe = cost unknown');
select t_rows(null, 'service_role', $$select 1 from t_out o where o.k='mp1' and jsonb_array_length(o.v::jsonb) = 3$$, 1, 'the cancelled soup and the void bill are not in it (3 dishes)');
select t_val(null, 'service_role', 'stock1', $$insert into public.stock_items (org_id, store_id, name, unit, quantity, cost_per_1000) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"เส้น"}', 'g', 5000, 8000) returning id::text$$);
select t_rows(null, 'service_role', $$insert into public.recipe_lines (org_id, store_id, menu_item_id, item_id, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='m_pad'), (select v::uuid from t_out where k='stock1'), 500)$$, 1, 'a recipe: 500 g at 80.00 a kg');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'mp2', $$select public.menu_profit_report(t_r((select v from t_out where k='store'), t_ds(-2), t_ds(-1)))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb) e where o.k='mp2' and (e ->> 'cost_unit')::numeric = 4000$$, 1, 'with a recipe the cost of one portion is 40.00');

-- ── promotions and the margin guard ──
create or replace function t_promo(extra text) returns jsonb language sql as $$
  select (jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Test promo', 'kind', 'percent', 'value', 2000) || extra::jsonb)
$$;
grant execute on function t_promo(text) to authenticated, service_role;
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_promotion(t_promo('{}'))$$, '42501', 'a cashier cannot make a promotion');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'pr1', $$select public.save_promotion(t_promo('{"code":"happy20","weekdays":[1,2,3],"from_time":"15:00","to_time":"17:00"}'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='pr1' and (v::jsonb ->> 'active') = 'true' and jsonb_array_length(v::jsonb -> 'below_margin') = 0$$, 1, '20 % off keeps Pad Thai above its cost: saved and active');
select t_rows(null, 'service_role', $$select 1 from public.promotions where code = 'HAPPY20' and weekdays = '{1,2,3}' and from_time = '15:00'$$, 1, 'the code is stored in capitals with its days and hours');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_promotion(t_promo('{"code":"HAPPY20"}'))$$, '23505', 'a code is used once per shop');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_promotion(t_promo('{"value":20000}'))$$, '23514', 'a percentage above 100 % is refused');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'pr2', $$select public.save_promotion(t_promo('{"name":"Half price","value":6000}'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='pr2' and (v::jsonb ->> 'active') = 'false' and (v::jsonb -> 'below_margin' ->> 0) = 'ผัดไทย'$$, 1, '60 % off would sell Pad Thai below cost: saved SWITCHED OFF and the dish is named');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'pr3', $$select public.save_promotion(t_promo('{"name":"Half price","value":6000,"force":true}'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='pr3' and (v::jsonb ->> 'active') = 'true'$$, 1, 'the owner may force it');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.promotions$$, 3, 'the cashier can read the promotions (the till applies them)');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.promotions$$, 0, 'another business cannot');
-- a line that had a promotion
update public.order_lines set list_price = 9000, unit_price = 7200, promo_id = (select (v::jsonb ->> 'id')::uuid from t_out where k='pr1') where order_id = '10000000-0000-4000-8000-000000000001' and name ->> 'en' = 'Pad Thai';
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'prr', $$select public.promotions_report(t_r((select v from t_out where k='store'), t_ds(-2), t_ds(-1)))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb) e where o.k='prr' and (e ->> 'name') = 'Test promo' and (e ->> 'given') = '3600' and (e ->> 'bills') = '1'$$, 1, 'the promotions report: 2 portions × 18.00 given away on 1 bill');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.delete_promotion((select (v::jsonb ->> 'id')::uuid from t_out where k='pr3'))$$, '42501', 'a cashier cannot delete one');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.delete_promotion((select (v::jsonb ->> 'id')::uuid from t_out where k='pr3'))$$, 1, 'the owner deletes one');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.promotions$$, 2, 'it is gone from the list');

-- ── upsell rules ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_upsell_rule(jsonb_build_object('store_id', (select v from t_out where k='store'), 'item_id', (select v from t_out where k='m_pad'), 'suggest_id', (select v from t_out where k='m_tea')))$$, '42501', 'a cashier cannot make a rule');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_upsell_rule(jsonb_build_object('store_id', (select v from t_out where k='store'), 'item_id', (select v from t_out where k='m_pad'), 'suggest_id', (select v from t_out where k='m_tea')))$$, 1, 'the owner makes a rule: Pad Thai → Tea');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_upsell_rule(jsonb_build_object('store_id', (select v from t_out where k='store'), 'item_id', (select v from t_out where k='m_pad'), 'suggest_id', (select v from t_out where k='m_tea'), 'sort', 3))$$, 1, 'the same pair again only updates it');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.upsell_rules$$, 1, 'still one rule');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_upsell_rule(jsonb_build_object('store_id', (select v from t_out where k='store'), 'item_id', (select v from t_out where k='m_pad'), 'suggest_id', gen_random_uuid()))$$, '22023', 'a dish of another shop (or none) is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_upsell_rule(jsonb_build_object('store_id', (select v from t_out where k='store'), 'item_id', (select v from t_out where k='m_pad'), 'suggest_id', (select v from t_out where k='m_pad')))$$, '22023', 'a dish cannot suggest itself');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.upsell_rules$$, 1, 'the cashier reads the rules');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'pairs', $$select public.pair_stats(jsonb_build_object('store_id', (select v from t_out where k='store'), 'days', 30))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='pairs' and v = '[]'$$, 1, 'pair statistics need at least 3 bills with the pair (here none)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.pair_stats(jsonb_build_object('store_id', (select v from t_out where k='store')))$$, '42501', 'a cashier cannot read them');

-- ── KPI report ──
select t_rows(null, 'service_role', $$insert into public.stock_moves (org_id, store_id, item_id, kind, qty_delta) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='stock1'), 'waste', -100)$$, 1, 'waste of 100 g');
select t_rows(null, 'service_role', $$update public.order_lines set status = 'ready' where order_id = '10000000-0000-4000-8000-000000000001' and name ->> 'en' = 'Tea' returning id$$, 1, 'the kitchen marks a line ready');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where name ->> 'en' = 'Tea' and ready_at is not null$$, 1, 'the time is stamped');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.kpi_report(t_r((select v from t_out where k='store'), t_ds(-2), t_ds(-1)))$$, '42501', 'a cashier cannot read KPIs');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'kpi', $$select public.kpi_report(t_r((select v from t_out where k='store'), t_ds(-2), t_ds(0)))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='kpi' and (v::jsonb ->> 'bills') = '3' and (v::jsonb ->> 'sales') = '48000' and (v::jsonb ->> 'waste_cost') = '800' and (v::jsonb ->> 'stockouts') = '1'$$, 1, 'KPIs: 3 bills, 480.00 sales, waste 8.00, one stock item at or below zero');
select t_rows(null, 'service_role', $$select 1 from t_out where k='kpi' and (v::jsonb -> 'noshow_rate_bps') = 'null'::jsonb and (v::jsonb -> 'repeat_rate_bps') = 'null'::jsonb$$, 1, 'rates with nothing to measure are null, not zero');

-- ── menu import ──
create or replace function t_imp(rows text) returns jsonb language sql as $$ select jsonb_build_object('store_id', (select v from t_out where k='store'), 'rows', rows::jsonb) $$;
grant execute on function t_imp(text) to authenticated, service_role;
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.import_menu(t_imp('[]'))$$, '42501', 'a cashier cannot import a menu');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'imp', $$select public.import_menu(t_imp('[{"category":"Snacks","name_th":"ขนมปัง","price":5000,"barcode":"BREAD-01"},{"category":"Snacks","name_th":"ขนมปัง","price":5000},{"category":"Snacks","name_th":"","price":1},{"category":"Snacks","name_th":"คุกกี้","price":4000,"barcode":"BREAD-01"},{"name_th":"น้ำ","price":1500,"name_en":"Water"}]'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='imp' and (v::jsonb ->> 'items') = '2' and (v::jsonb ->> 'categories') = '2' and jsonb_array_length(v::jsonb -> 'skipped') = 3$$, 1, 'import: 2 dishes and 2 categories made, 3 rows skipped (duplicate, empty name, barcode already used)');
select t_rows(null, 'service_role', $$select 1 from public.menu_items where name ->> 'th' = 'น้ำ' and name ->> 'en' = 'Water' and prices ->> 'base' = '1500'$$, 1, 'a dish with an English name and a price');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'imp2', $$select public.import_menu(t_imp('[{"category":"Snacks","name_th":"ขนมปัง","price":5000,"barcode":"BREAD-01"}]'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='imp2' and (v::jsonb ->> 'items') = '0'$$, 1, 'running the same import again makes nothing new');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.import_menu(jsonb_build_object('store_id', (select v from t_out where k='store'), 'rows', (select jsonb_agg(jsonb_build_object('name_th','x','price',1)) from generate_series(1,501))))$$, '22023', 'more than 500 rows are refused');
\echo ALL REVENUE TOOLS TESTS PASSED
