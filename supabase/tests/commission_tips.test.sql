-- Commission and tips: rates, the commission report from paid bills, tips owed and paid out, the drawer.
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






create or replace function t_leg_cash(id text, amount bigint, tendered bigint) returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'tender', 'cash', 'amount', amount, 'tendered', tendered, 'change', tendered - amount) $$;
grant execute on function t_leg_cash(text, bigint, bigint) to authenticated, service_role;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'manager@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Salon Co','Salon','salon')$$, 1, 'owner creates a salon');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','salon')$$, 1, 'another business exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('00000000-0000-0000-0000-0000000000b2'::uuid, 'Manager', 'manager'),
               ('00000000-0000-0000-0000-0000000000d4'::uuid, 'Cashier', 'cashier'),
               (null::uuid, 'Stylist Nok', 'waiter')) as u(id, n, b) on true
  join public.roles r on r.org_id = o.id and r.built_in = u.b
 where o.name = 'Salon Co';
update public.legal_entities set tax_id = '0105560123456' where name = 'Salon Co';
update public.stores set vat_registered = true, vat_bps = 700, branch_code = '00001' where name = 'Salon';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Salon Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Salon'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'resto', $$select id::text from public.stores where name = 'Salon'$$);
select t_val(null, 'service_role', 'resto2', $$insert into public.stores (org_id, legal_entity_id, name, profile) select org_id, legal_entity_id, 'Resto', 'restaurant' from public.stores where name = 'Salon' returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Counter', 'cashier', 'POS-77') returning id::text$$);
select t_val(null, 'service_role', 'cashier_staff', $$select id::text from public.staff where display_name = 'Cashier'$$);
select t_val(null, 'service_role', 'nok_staff', $$select id::text from public.staff where display_name = 'Stylist Nok'$$);
select t_val(null, 'service_role', 'mgr_staff', $$select id::text from public.staff where display_name = 'Manager'$$);
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'nok', $$insert into public.resources (org_id, store_id, name, kind, staff_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Nok', 'stylist', (select v::uuid from t_out where k='nok_staff')) returning id::text$$);
select t_val(null, 'service_role', 'cat', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"x"}') returning id::text$$);
select t_val(null, 'service_role', 'svc', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, duration_min) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"นวด"}', '{"base": 100000}', 60) returning id::text$$);
select t_val(null, 'service_role', 'prod', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"แชมพู"}', '{"base": 20000}') returning id::text$$);

select t_val(null, 'service_role', 'foreign_staff', $$select id::text from public.staff where org_id <> (select v::uuid from t_out where k='org') limit 1$$);
-- ── rates ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_commission_rate(jsonb_build_object('store_id', (select v from t_out where k='store'), 'service_bps', 1000, 'product_bps', 500))$$, '42501', 'a cashier cannot set commission rates');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.set_commission_rate(jsonb_build_object('store_id', (select v from t_out where k='store'), 'service_bps', 10001, 'product_bps', 500))$$, '22023', 'a rate is at most 100 percent');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.set_commission_rate(jsonb_build_object('store_id', (select v from t_out where k='resto2'), 'service_bps', 1000, 'product_bps', 500))$$, '0A000', 'a restaurant has no commission module');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.set_commission_rate(jsonb_build_object('store_id', (select v from t_out where k='store'), 'service_bps', 1000, 'product_bps', 500))$$, 1, 'the manager sets the shop default: 10 % services, 5 % products');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.set_commission_rate(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', (select v from t_out where k='nok_staff'), 'service_bps', 2000, 'product_bps', 500))$$, 1, 'and 20 % services for Nok');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.set_commission_rate(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', (select v from t_out where k='nok_staff'), 'service_bps', 2000, 'product_bps', 500))$$, 1, 'saving again replaces, it does not add a row');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.commission_rates) = 2$$, 1, 'two rates exist');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.set_commission_rate(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', (select v from t_out where k='foreign_staff'), 'service_bps', 1, 'product_bps', 1))$$, '22023', 'a person of another business or none is refused');

-- ── a visit of Nok's (100.00 service + 20.00 shampoo) and a plain bill of the cashier's (50.00 product) ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'a1', $$select public.book_appointment(jsonb_build_object('store_id', (select v from t_out where k='store'), 'provider_id', (select v from t_out where k='nok'), 'service_id', (select v from t_out where k='svc'), 'starts_at', to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM-DD') || 'T10:00:00+07:00', 'guest_name', 'Anna'))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_status((select v::uuid from t_out where k='a1'), 'arrived')$$, 1, 'Anna arrives');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'o1', $$select public.appointment_to_order(jsonb_build_object('appointment_id', (select v from t_out where k='a1'), 'device_id', (select v from t_out where k='dev')))::text$$);
select t_rows(null, 'service_role', $$insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, status, sent_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='o1'), (select v::uuid from t_out where k='prod'), '{"th":"แชมพู"}', 20000, 1, 'sent', now())$$, 1, 'a shampoo is added to her bill');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(jsonb_build_object('order_id', (select v from t_out where k='o1'), 'device_id', (select v from t_out where k='dev'), 'staff_id', (select v from t_out where k='cashier_staff'), 'issued_at', now(), 'lang', 'en', 'subtotal', 120000, 'service_charge', 0, 'vat', 7850, 'net_before_vat', 112150, 'total', 120000, 'rounding', 0, 'payable', 120000, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive', 'payments', jsonb_build_array(t_leg_cash('74000000-0000-4000-8000-000000000001', 120000, 120000))))$$, 1, 'the 1,200.00 bill is paid');
select t_rows(null, 'service_role', $$insert into public.orders (id, org_id, store_id, number, business_date, channel, status, opened_by) values ('76000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A001', (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'open', (select v::uuid from t_out where k='cashier_staff'))$$, 1, 'a plain bill opened by the cashier');
select t_rows(null, 'service_role', $$insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, status, sent_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '76000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='prod'), '{"th":"แชมพู"}', 25000, 2, 'sent', now())$$, 1, 'with 2 shampoos at 250.00');
select t_rows(null, 'service_role', $$update public.orders set status = 'paid' where id = '76000000-0000-4000-8000-000000000001' returning 1$$, 1, 'paid');

create or replace function t_rep(extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('org_id', (select v from t_out where k='org'), 'from', to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM-DD'), 'to', to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM-DD')) || extra
$$;
grant execute on function t_rep(jsonb) to authenticated, service_role;
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.commission_report(t_rep())$$, '42501', 'a cashier cannot read the commission report');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.commission_report(t_rep())$$, '42501', 'another business cannot either');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.commission_report(t_rep('{"from":"2030-02-01","to":"2030-01-01"}'))$$, '22023', 'a backwards range is refused');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'rep', $$select public.commission_report(t_rep())::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out, jsonb_array_elements((v::jsonb) -> 'rows') r where k = 'rep' and r ->> 'name' = 'Stylist Nok' and (r ->> 'service_sales')::bigint = 100000 and (r ->> 'product_sales')::bigint = 20000 and (r ->> 'service_bps')::int = 2000 and (r ->> 'product_bps')::int = 500 and (r ->> 'commission')::bigint = 21000$$, 1, 'Nok: 1,000.00 service at 20 % + 200.00 shampoo at 5 % = 210.00 (the stylist of the appointment earns, not the cashier who opened the bill)');
select t_rows(null, 'service_role', $$select 1 from t_out, jsonb_array_elements((v::jsonb) -> 'rows') r where k = 'rep' and r ->> 'name' = 'Cashier' and (r ->> 'service_sales')::bigint = 0 and (r ->> 'product_sales')::bigint = 50000 and (r ->> 'commission')::bigint = 2500$$, 1, 'the cashier: 500.00 of products at the shop default 5 % = 25.00');
select t_rows(null, 'service_role', $$select 1 where (select jsonb_array_length((v::jsonb) -> 'rows') from t_out where k = 'rep') = 2$$, 1, 'nobody else appears');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'rep2', $$select public.commission_report(t_rep('{"from":"2030-01-01","to":"2030-01-31"}'))::text$$);
select t_rows(null, 'service_role', $$select 1 where (select jsonb_array_length((v::jsonb) -> 'rows') from t_out where k = 'rep2') = 0$$, 1, 'a month without sales has no rows');
update public.orders set status = 'void' where id = '76000000-0000-4000-8000-000000000001' and false;

-- ── tips ──
select t_rows(null, 'service_role', $$insert into public.shifts (org_id, store_id, device_id, opened_at, opening_cash) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='dev'), now(), 20000)$$, 1, 'a shift opens with 200.00');
create or replace function t_tip(amount bigint, method text, dev text default null, who text default 'nok_staff') returns jsonb language sql as $$
  select jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', (select v from t_out where k=who), 'amount', amount, 'method', method,
    'device_id', case when dev is null then null else (select v from t_out where k=dev) end)
$$;
grant execute on function t_tip(bigint, text, text, text) to authenticated, service_role;
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.record_tip(t_tip(5000, 'cash', 'dev'))$$, '42501', 'another business cannot take a tip here');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.record_tip(t_tip(0, 'cash', 'dev'))$$, '22023', 'a tip is above zero');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.record_tip(t_tip(5000, 'cash'))$$, '22023', 'a cash tip needs the till');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.record_tip(t_tip(5000, 'barter', 'dev'))$$, '22023', 'only cash, PromptPay or card');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.record_tip(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', gen_random_uuid(), 'amount', 100, 'method', 'promptpay'))$$, '22023', 'a tip is for a person of this business');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'tip1', $$select public.record_tip(t_tip(5000, 'cash', 'dev'))::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'tip2', $$select public.record_tip(t_tip(3000, 'promptpay'))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.staff_tips where status = 'owed'$$, 2, 'two tips are owed to Nok (50.00 cash, 30.00 PromptPay)');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.staff_tips$$, 0, 'another business sees none');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.pay_out_tips(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', (select v from t_out where k='nok_staff'), 'device_id', (select v from t_out where k='dev')))$$, '42501', 'a cashier cannot pay tips out');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.pay_out_tips(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', (select v from t_out where k='nok_staff')))$$, '22023', 'a pay-out names the drawer it comes out of');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'paid', $$select public.pay_out_tips(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', (select v from t_out where k='nok_staff'), 'device_id', (select v from t_out where k='dev')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='paid' and v = '8000'$$, 1, 'the manager pays Nok 80.00 in cash');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'paid2', $$select public.pay_out_tips(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', (select v from t_out where k='nok_staff'), 'device_id', (select v from t_out where k='dev')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='paid2' and v = '0'$$, 1, 'paying again pays nothing');
select t_rows(null, 'service_role', $$select 1 from public.staff_tips where status = 'paid' and paid_device_id = (select v::uuid from t_out where k='dev') and paid_at is not null$$, 2, 'both tips are marked paid');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'payment.refund' and entity = 'staff_tips'$$, 1, 'the pay-out is audited');

-- ── the drawer ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'sh', $$select id::text from public.shifts where status = 'open' and device_id = (select v::uuid from t_out where k='dev')$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'close', $$select public.close_shift(jsonb_build_object('id', (select v from t_out where k='sh'), 'closed_at', now(), 'counted_cash', 17000, 'staff_id', (select v from t_out where k='cashier_staff')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='close' and (v::jsonb ->> 'expected_cash')::bigint = 17000 and (v::jsonb ->> 'variance')::bigint = 0$$, 1, 'expected 170.00 = opening 200.00 + 50.00 cash tip taken − 80.00 paid out (the PromptPay tip is paid out of the drawer too)');
do $$ begin raise notice 'ALL COMMISSION AND TIPS TESTS PASSED'; end $$;
