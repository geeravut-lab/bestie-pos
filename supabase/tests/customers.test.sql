-- Customers and Bestie Points: lookup, create, attach, earn on close (once), append-only ledger, manual adjust.
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

select t_val('00000000-0000-0000-0000-0000000000e5', 'authenticated', 'foreign_org', $$select id::text from public.orgs where name = 'Other'$$);
select t_val('00000000-0000-0000-0000-0000000000e5', 'authenticated', 'fc', $$select (public.create_customer(jsonb_build_object('org_id', (select v from t_out where k='foreign_org'), 'name', 'Foreign Fred')) ->> 'id')$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cid', $$select (v::jsonb ->> 'id') from t_out where k='c1'$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'code', $$select (v::jsonb ->> 'member_code') from t_out where k='c1'$$);

select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where jsonb_array_length(public.find_customers((select v::uuid from t_out where k='org'), '5678')) = 1$$, 1, 'found by the end of the phone number');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where jsonb_array_length(public.find_customers((select v::uuid from t_out where k='org'), (select lower(v) from t_out where k='code'))) = 1$$, 1, 'found by member code (any case)');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where jsonb_array_length(public.find_customers((select v::uuid from t_out where k='org'), 'ann')) = 1$$, 1, 'found by a name fragment');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.find_customers((select v::uuid from t_out where k='org'), 'a') = '[]'::jsonb and public.find_customers((select v::uuid from t_out where k='org'), '123') = '[]'::jsonb$$, 1, 'too short a query finds nothing');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.find_customers((select v::uuid from t_out where k='org'), 'anna')$$, '42501', 'another org cannot search this org');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.customers where name = 'Anna Smith'$$, 0, 'RLS: another org cannot read the customer');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.customers where name = 'Anna Smith'$$, 1, 'RLS: this org''s cashier can');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.customers (org_id, name, member_code) values ((select v::uuid from t_out where k='org'), 'Direct', 'ABCDEF12')$$, '42501', 'a client cannot write customers directly');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.points_ledger (org_id, customer_id, kind, points, reason) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='cid'), 'adjust', 1000, 'free points')$$, '42501', 'nor the points ledger');

-- ── attach to a bill ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_customer('10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='fc'))$$, '23514', 'a customer of another org cannot be put on this bill');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.set_order_customer('10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='cid'))$$, '42501', 'another org cannot touch the bill');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_customer('10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='cid'))$$, 1, 'the cashier puts Anna on bill 1');
select t_rows(null, 'service_role', $$select 1 from public.orders where id = '10000000-0000-4000-8000-000000000001' and customer_id = (select v::uuid from t_out where k='cid')$$, 1, 'attached');

-- ── earning ──
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000001', 'A-000001', 50000))$$, 1, 'bill 1 (210.00 cash) is closed');
select t_rows(null, 'service_role', $$select 1 from public.points_ledger where kind = 'earn' and points = 8 and order_id = '10000000-0000-4000-8000-000000000001' and customer_id = (select v::uuid from t_out where k='cid')$$, 1, '210.00 at 1 point per 25.00 earns 8 points');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000001', 'A-000001', 50000))$$, 1, 'the same close arriving again');
select t_rows(null, 'service_role', $$select 1 from public.points_ledger where kind = 'earn' having count(*) = 1$$, 1, 'a replayed close never earns twice');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000002', 'A-000002', 3000, 3000, 3000, 3000))$$, 1, 'bill 2 without a customer is closed');
select t_rows(null, 'service_role', $$select 1 from public.points_ledger$$, 1, 'a bill with no customer earns nothing');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'bal', $$select public.points_balance((select v::uuid from t_out where k='cid'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='bal' and v = '8'$$, 1, 'balance 8');
select t_val('00000000-0000-0000-0000-0000000000e5', 'authenticated', 'balx', $$select public.points_balance((select v::uuid from t_out where k='cid'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='balx' and v = '0'$$, 1, 'another org sees no balance');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_customer('10000000-0000-4000-8000-000000000001', null)$$, '23514', 'a closed bill cannot change customer');

-- internal closing with Credit under the org's own rule (the Credit tender arrives with its own migration; this proves the earn rule)
insert into public.orders (id, org_id, store_id, number, business_date, channel, customer_id)
values ('10000000-0000-4000-8000-000000000003', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A003', (now() at time zone 'Asia/Bangkok')::date, 'takeaway', (select v::uuid from t_out where k='cid')),
       ('10000000-0000-4000-8000-000000000004', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A004', (now() at time zone 'Asia/Bangkok')::date, 'takeaway', (select v::uuid from t_out where k='cid'));
insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, status)
select (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), o, '{"th":"x"}', 10000, 1, 'new'
  from unnest(array['10000000-0000-4000-8000-000000000003'::uuid, '10000000-0000-4000-8000-000000000004'::uuid]) o;
update public.orgs set points_rule = '{"creditEarnsPoints": false}' where id = (select v::uuid from t_out where k='org');
select public.finalize_order_payment('10000000-0000-4000-8000-000000000003', (select v::uuid from t_out where k='dev'), null, 'A+000001', now(),
  jsonb_build_object('vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive', 'service_charge', 0, 'vat', 654, 'net_before_vat', 9346, 'total', 10000, 'rounding', 0, 'payable', 10000),
  jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'tender', 'credit', 'amount', 10000)));
select t_rows(null, 'service_role', $$select 1 from public.points_ledger where order_id = '10000000-0000-4000-8000-000000000003'$$, 0, 'with "Credit earns no points" a Credit-paid bill earns nothing');
update public.orgs set points_rule = '{"earnSatangPerPoint": 1000}' where id = (select v::uuid from t_out where k='org');
select public.finalize_order_payment('10000000-0000-4000-8000-000000000004', (select v::uuid from t_out where k='dev'), null, 'A+000002', now(),
  jsonb_build_object('vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive', 'service_charge', 0, 'vat', 654, 'net_before_vat', 9346, 'total', 10000, 'rounding', 0, 'payable', 10000),
  jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'tender', 'credit', 'amount', 6000), jsonb_build_object('id', gen_random_uuid(), 'tender', 'points', 'amount', 4000)));
select t_rows(null, 'service_role', $$select 1 from public.points_ledger where order_id = '10000000-0000-4000-8000-000000000004' and kind = 'earn' and points = 6$$, 1, 'the owner''s rule (1 point per 10.00) applies and the Points portion earns nothing: 60.00 → 6 points');

-- ── append-only ──
select t_err(null, 'service_role', $$update public.points_ledger set points = 999$$, '23514', 'the ledger cannot be edited');
select t_err(null, 'service_role', $$delete from public.points_ledger$$, '23514', 'nor emptied');
select t_err(null, 'service_role', $$insert into public.points_ledger (org_id, customer_id, kind, points, reason) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='cid'), 'purchase', 100, 'x')$$, '23514', 'a "purchase" kind does not exist');
select t_err(null, 'service_role', $$insert into public.points_ledger (org_id, customer_id, kind, points, reason) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='cid'), 'cash_out', -1, 'x')$$, '23514', 'neither does "cash_out"');
select t_err(null, 'service_role', $$insert into public.points_ledger (org_id, customer_id, kind, points) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='cid'), 'earn', -5)$$, '23514', 'an earn with a negative amount is refused');

-- ── manual correction ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.adjust_points((select v::uuid from t_out where k='cid'), 50, 'goodwill')$$, '42501', 'a cashier cannot correct points');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.adjust_points((select v::uuid from t_out where k='cid'), 50, '  ')$$, '22023', 'a reason is required');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.adjust_points((select v::uuid from t_out where k='cid'), -999, 'oops')$$, '23514', 'the balance cannot go below zero');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.adjust_points((select v::uuid from t_out where k='cid'), 50, 'goodwill for a late order')$$, 1, 'the owner adds 50 points with a reason');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'points.adjust'$$, 1, 'and it is audited');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'bal2', $$select public.points_balance((select v::uuid from t_out where k='cid'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='bal2' and v = '64'$$, 1, 'balance 8 + 6 + 50');
\echo ALL CUSTOMER TESTS PASSED
