-- Delivery: platforms, the intake, the platform tender, commission, payouts and the report.
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
select t_val(null, 'service_role', 'rice', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, station, barcode) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"ข้าวผัด","en":"Fried rice"}', '{"base": 10000, "delivery": 13000}', 'kitchen', 'RICE-001') returning id::text$$);
select t_val(null, 'service_role', 'tea', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, sku) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"ชา"}', '{"base": 5000}', 'TEA-1') returning id::text$$);
select t_val(null, 'service_role', 'off', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, barcode, available) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"หมด"}', '{"base": 100}', 'GONE-01', false) returning id::text$$);

-- ── the module ──
select t_rows(null, 'service_role', $$select 1 where not public.delivery_enabled((select v::uuid from t_out where k='store'))$$, 1, 'delivery is off by default');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_delivery_platform(jsonb_build_object('store_id', (select v from t_out where k='store'), 'code', 'lineman', 'name', 'LINE MAN', 'commission_bps', 3000))$$, '0A000', 'a platform cannot be added while the module is off');
update public.stores set plan = 'pro', module_overrides = module_overrides || '{"delivery": true}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_rows(null, 'service_role', $$select 1 where public.delivery_enabled((select v::uuid from t_out where k='store'))$$, 1, 'on the Pro plan with the switch on it is enabled');

-- ── platforms ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_delivery_platform(jsonb_build_object('store_id', (select v from t_out where k='store'), 'code', 'lineman', 'name', 'LINE MAN', 'commission_bps', 3000))$$, '42501', 'a cashier cannot set up platforms');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_delivery_platform(jsonb_build_object('store_id', (select v from t_out where k='store'), 'code', 'lineman', 'name', 'LINE MAN', 'commission_bps', 9000))$$, '23514', 'a commission above 50 percent is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_delivery_platform(jsonb_build_object('store_id', (select v from t_out where k='store'), 'code', 'uber', 'name', 'Uber', 'commission_bps', 100))$$, '23514', 'only the known platforms');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'lm', $$select public.save_delivery_platform(jsonb_build_object('store_id', (select v from t_out where k='store'), 'code', 'lineman', 'name', 'LINE MAN', 'commission_bps', 3000))::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'grab', $$select public.save_delivery_platform(jsonb_build_object('store_id', (select v from t_out where k='store'), 'code', 'grab', 'name', 'Grab', 'commission_bps', 2500))::text$$);
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_delivery_platform(jsonb_build_object('store_id', (select v from t_out where k='store'), 'code', 'grab', 'name', 'Grab', 'commission_bps', 1))$$, '23505', 'a platform name is used once');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.delivery_platforms$$, 2, 'the cashier can see the platforms (to pick one on a bill)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select token_hash from public.delivery_platforms$$, '42501', 'but never the token column');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.delivery_platforms$$, 0, 'another business sees none');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.rotate_delivery_token((select v::uuid from t_out where k='lm'))$$, '42501', 'a cashier cannot make a token');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'tok', $$select public.rotate_delivery_token((select v::uuid from t_out where k='lm'))$$);
select t_rows(null, 'service_role', $$select 1 from public.delivery_platforms where id = (select v::uuid from t_out where k='lm') and token_hash = encode(sha256(convert_to((select v from t_out where k='tok'), 'utf8')), 'hex') and token_hash <> (select v from t_out where k='tok') and token_hint = right((select v from t_out where k='tok'), 4)$$, 1, 'only the hash of the token is kept');

-- ── the intake ──
create or replace function t_items(extra text default '[{"item_id":"x","quantity":1}]') returns jsonb language sql as $$ select extra::jsonb $$;
select t_err(null, 'authenticated', $$select public.delivery_intake('x', '{}'::jsonb)$$, '42501', 'the browser cannot call the intake');
select t_rows(null, 'service_role', $$select 1 where (public.delivery_intake(repeat('a', 64), '{}'::jsonb) ->> 'error') = 'unauthorized'$$, 1, 'a wrong token is refused');
select t_rows(null, 'service_role', $$select 1 where (public.delivery_intake((select v from t_out where k='tok'), '{"items":[{"barcode":"RICE-001","quantity":1}]}'::jsonb) ->> 'error') = 'invalid'$$, 1, 'an order without the platform reference is refused');
select t_rows(null, 'service_role', $$select 1 where (public.delivery_intake((select v from t_out where k='tok'), '{"ref":"LM-1","items":[]}'::jsonb) ->> 'error') = 'invalid'$$, 1, 'an order without items is refused');
select t_rows(null, 'service_role', $$select 1 where (public.delivery_intake((select v from t_out where k='tok'), '{"ref":"LM-1","items":[{"barcode":"NOPE-99","quantity":1}]}'::jsonb) ->> 'error') = 'unknown_item'$$, 1, 'an item Bestie does not know refuses the whole order');
select t_rows(null, 'service_role', $$select 1 where (public.delivery_intake((select v from t_out where k='tok'), '{"ref":"LM-1","items":[{"barcode":"GONE-01","quantity":1}]}'::jsonb) ->> 'error') = 'unknown_item'$$, 1, 'a sold-out item is refused too');
select t_rows(null, 'service_role', $$select 1 where (public.delivery_intake((select v from t_out where k='tok'), '{"ref":"LM-1","items":[{"barcode":"RICE-001","quantity":0}]}'::jsonb) ->> 'error') = 'invalid'$$, 1, 'a quantity of 0 is refused');
select t_rows(null, 'service_role', $$select 1 where not exists (select 1 from public.orders where channel = 'delivery')$$, 1, 'nothing was written by the refusals');
select t_val(null, 'service_role', 'in1', $$select public.delivery_intake((select v from t_out where k='tok'), jsonb_build_object('ref', 'LM-1', 'name', 'Somchai', 'phone', '0811111111', 'address', 'Bungalow 4', 'note', 'no chilli',
  'items', jsonb_build_array(jsonb_build_object('barcode', 'rice-001', 'quantity', 2, 'note', 'spicy'), jsonb_build_object('sku', 'tea-1', 'quantity', 1))))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='in1' and (v::jsonb ->> 'ok') = 'true' and (v::jsonb ->> 'number') = 'DL001' and (v::jsonb ->> 'lines') = '2' and (v::jsonb ->> 'replay') = 'false'$$, 1, 'a good order is taken as DL001 with two lines (barcode and SKU, any letter case)');
select t_val(null, 'service_role', 'o1', $$select v::jsonb ->> 'order_id' from t_out where k='in1'$$);
select t_rows(null, 'service_role', $$select 1 from public.order_lines where order_id = (select v::uuid from t_out where k='o1') and unit_price = 13000 and quantity = 2 and status = 'new' and station = 'kitchen' and note = 'spicy'$$, 1, 'the dish is priced at the DELIVERY price (130, not 100), unsent, for the kitchen');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where order_id = (select v::uuid from t_out where k='o1') and unit_price = 5000 and item_id = (select v::uuid from t_out where k='tea')$$, 1, 'an item with no delivery price uses the base price');
select t_rows(null, 'service_role', $$select 1 from public.orders where id = (select v::uuid from t_out where k='o1') and channel = 'delivery' and status = 'open' and external_ref = 'LM-1' and delivery_platform_id = (select v::uuid from t_out where k='lm') and delivery_info ->> 'name' = 'Somchai' and delivery_info ->> 'address' = 'Bungalow 4'$$, 1, 'the order carries the platform, its reference and the customer');
select t_val(null, 'service_role', 'in1b', $$select public.delivery_intake((select v from t_out where k='tok'), jsonb_build_object('ref', 'LM-1', 'items', jsonb_build_array(jsonb_build_object('barcode', 'RICE-001', 'quantity', 9))))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='in1b' and (v::jsonb ->> 'replay') = 'true' and (v::jsonb ->> 'order_id') = (select v from t_out where k='o1')$$, 1, 'the same platform order again returns the first answer');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.orders where channel = 'delivery') = 1$$, 1, 'and no second bill');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.app_notifications where kind = 'delivery.new'$$, 1, 'the managers were told');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.delivery_platforms set token_hash = null where id = (select v::uuid from t_out where k='lm')$$, '42501', 'the browser cannot write a token');
-- a rotated token stops the old one
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'tok2', $$select public.rotate_delivery_token((select v::uuid from t_out where k='lm'))$$);
select t_rows(null, 'service_role', $$select 1 where (public.delivery_intake((select v from t_out where k='tok'), '{"ref":"LM-2","items":[{"barcode":"RICE-001","quantity":1}]}'::jsonb) ->> 'error') = 'unauthorized'$$, 1, 'the old token stops working at once');
-- a platform switched off cannot send
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_delivery_platform(jsonb_build_object('store_id', (select v from t_out where k='store'), 'id', (select v from t_out where k='grab'), 'active', false))$$, 1, 'a platform can be switched off');

-- ── a bill at the till, tied to Grab by hand ──
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values ('10000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A001', (now() at time zone 'Asia/Bangkok')::date, 'delivery')$$, 1, 'the till opens a delivery bill');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, status, sent_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', '{"th":"ข้าว"}', 20000, 1, 'sent', now())$$, 1, 'one line of 200.00');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_delivery_order(jsonb_build_object('order_id', '10000000-0000-4000-8000-000000000002', 'payment_id', '60000000-0000-4000-8000-000000000001', 'device_id', (select v from t_out where k='dev'), 'subtotal', 20000, 'total', 20000, 'rounding', 0, 'payable', 20000))$$, '55000', 'a bill with no platform cannot be settled by one');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_delivery_info(jsonb_build_object('order_id', '10000000-0000-4000-8000-000000000002', 'platform_id', (select v from t_out where k='grab')))$$, '22023', 'a switched-off platform cannot be picked');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_delivery_platform(jsonb_build_object('store_id', (select v from t_out where k='store'), 'id', (select v from t_out where k='grab'), 'active', true))$$, 1, 'Grab is switched on again');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.set_delivery_info(jsonb_build_object('order_id', '10000000-0000-4000-8000-000000000002', 'platform_id', (select v from t_out where k='grab')))$$, '42501', 'another business cannot touch this bill');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_delivery_info(jsonb_build_object('order_id', '10000000-0000-4000-8000-000000000002', 'platform_id', (select v from t_out where k='grab'), 'external_ref', 'GF-77', 'name', 'Mia'))$$, 1, 'the cashier ties the bill to Grab order GF-77');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values ('10000000-0000-4000-8000-000000000003', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A002', (now() at time zone 'Asia/Bangkok')::date, 'delivery')$$, 1, 'a second delivery bill');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_delivery_info(jsonb_build_object('order_id', '10000000-0000-4000-8000-000000000003', 'platform_id', (select v from t_out where k='grab'), 'external_ref', 'GF-77'))$$, '23505', 'a platform order number is used once per platform');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_delivery_info(jsonb_build_object('order_id', '10000000-0000-4000-8000-000000000003', 'platform_id', (select v from t_out where k='lm'), 'external_ref', 'GF-77'))$$, 1, 'the same number on another platform is fine');

-- ── closing: the platform pays later ──
create or replace function t_close(p_order text, p_pay text, p_sub bigint, p_total bigint, p_round int default 0) returns jsonb language sql as $$
  select jsonb_build_object('order_id', p_order, 'payment_id', p_pay, 'device_id', (select v from t_out where k='dev'), 'staff_id', (select v from t_out where k='cashier_staff'), 'issued_at', now(), 'lang', 'en',
    'subtotal', p_sub, 'service_charge', 0, 'vat', 0, 'net_before_vat', p_total, 'total', p_total, 'rounding', p_round, 'payable', p_total + p_round, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive') $$;
grant execute on function t_close(text, text, bigint, bigint, int) to authenticated, service_role;
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_delivery_order(t_close('10000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000001', 19000, 19000))$$, '23514', 'a bill that is not what the till showed is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_delivery_order(t_close('10000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000001', 20000, 20000, 5))$$, '23514', 'a platform payment is exact (no rounding)');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.close_delivery_order(t_close('10000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000001', 20000, 20000))$$, '42501', 'another business cannot close it');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cl', $$select public.close_delivery_order(t_close('10000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000001', 20000, 20000))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='cl' and (v::jsonb ->> 'receipt_number') ~ '^[A-Z]\+000001$' and (v::jsonb ->> 'commission') = '5000' and (v::jsonb ->> 'replay') = 'false'$$, 1, 'closed with a server receipt; Grab keeps 25 percent of 200.00 = 50.00');
select t_rows(null, 'service_role', $$select 1 from public.payments where order_id = '10000000-0000-4000-8000-000000000002' and tender = 'platform' and amount = 20000 and status = 'confirmed' and reference = 'platform:grab:GF-77'$$, 1, 'its one payment is the platform tender');
select t_rows(null, 'service_role', $$select 1 from public.orders where id = '10000000-0000-4000-8000-000000000002' and status = 'paid' and commission_amount = 5000$$, 1, 'the bill is paid and the commission is kept on it');
select t_rows(null, 'service_role', $$select 1 where not exists (select 1 from public.points_ledger where order_id = '10000000-0000-4000-8000-000000000002')$$, 1, 'no Points were earned');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cl2', $$select public.close_delivery_order(t_close('10000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000001', 20000, 20000))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='cl2' and (v::jsonb ->> 'replay') = 'true'$$, 1, 'the same request again returns the same receipt');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_delivery_order(t_close('10000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000009', 20000, 20000))$$, '23514', 'a closed bill cannot be closed again');
-- the intake bill (DL001): 2 x 130 + 50 = 310.00, LINE MAN keeps 30 percent = 93.00
update public.order_lines set status = 'sent', sent_at = now() where order_id = (select v::uuid from t_out where k='o1');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cl3', $$select public.close_delivery_order(t_close((select v from t_out where k='o1'), '60000000-0000-4000-8000-000000000002', 31000, 31000))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='cl3' and (v::jsonb ->> 'commission') = '9300'$$, 1, 'the LINE MAN bill: commission 30 percent of 310.00 = 93.00');
select t_rows(null, 'service_role', $$select 1 where exists (select 1 from public.audit_log where action = 'payment.tender' and entity_id = '10000000-0000-4000-8000-000000000002' and detail ->> 'platform' = 'grab')$$, 1, 'closing is in the audit trail with the platform');

-- ── payouts and the report ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.delivery_report(jsonb_build_object('store_id', (select v from t_out where k='store'), 'from', current_date::text, 'to', current_date::text))$$, '42501', 'a cashier cannot read the report');
create or replace function t_rep() returns text language sql as $$
  select public.delivery_report(jsonb_build_object('store_id', (select v from t_out where k='store'), 'from', (current_date - 1)::text, 'to', (current_date + 1)::text))::text $$;
grant execute on function t_rep() to authenticated, service_role;
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'rep', $$select t_rep()$$);
select t_rows(null, 'service_role', $$select 1 from t_out, jsonb_array_elements(v::jsonb) e where k='rep' and e ->> 'code' = 'lineman' and (e ->> 'bills') = '1' and (e ->> 'gross') = '31000' and (e ->> 'commission') = '9300' and (e ->> 'net') = '21700' and (e ->> 'paid_out') = '0' and (e ->> 'owed') = '21700'$$, 1, 'LINE MAN: 310.00 sold, 93.00 kept, 217.00 net and owed');
select t_rows(null, 'service_role', $$select 1 from t_out, jsonb_array_elements(v::jsonb) e where k='rep' and e ->> 'code' = 'grab' and (e ->> 'gross') = '20000' and (e ->> 'net') = '15000' and (e ->> 'owed') = '15000'$$, 1, 'Grab: 200.00 sold, 150.00 net and owed');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.record_delivery_payout(jsonb_build_object('platform_id', (select v from t_out where k='grab'), 'amount', 15000))$$, '42501', 'a cashier cannot record a payout');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.record_delivery_payout(jsonb_build_object('platform_id', (select v from t_out where k='grab'), 'amount', 0))$$, '22023', 'a payout is above zero');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'po', $$select public.record_delivery_payout(jsonb_build_object('platform_id', (select v from t_out where k='grab'), 'amount', 10000, 'reference', 'weekly transfer'))::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'rep2', $$select t_rep()$$);
select t_rows(null, 'service_role', $$select 1 from t_out, jsonb_array_elements(v::jsonb) e where k='rep2' and e ->> 'code' = 'grab' and (e ->> 'paid_out') = '10000' and (e ->> 'owed') = '5000'$$, 1, 'after a 100.00 payout Grab still owes 50.00');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.delivery_payouts set amount = 1$$, '42501', 'payouts cannot be edited from the browser');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.delivery_payouts$$, 0, 'a cashier does not read payouts');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'payment.tender' and entity_id = (select v from t_out where k='po')$$, 1, 'a payout is in the audit trail');
do $$ begin raise notice 'ALL DELIVERY TESTS PASSED'; end $$;
