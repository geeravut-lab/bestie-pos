-- Points as a discount: reserved on the bill, capped by the rule, released when changed / voided / unused, receipt records it.
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


select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cid', $$select (v::jsonb ->> 'id') from t_out where k='c1'$$);
update public.order_lines set status = 'sent', sent_at = now();
-- Anna has 100 points
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.adjust_points((select v::uuid from t_out where k='cid'), 100, 'welcome')$$, 1, 'Anna has 100 points');
create or replace function t_bal() returns bigint language sql as $$ select coalesce(sum(points), 0)::bigint from public.points_ledger where customer_id = (select v::uuid from t_out where k='cid') $$;
grant execute on function t_bal() to authenticated, service_role;

-- ── refusals ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_points('10000000-0000-4000-8000-000000000001', 10)$$, '23514', 'no customer on the bill yet');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_customer('10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='cid'))$$, 1, 'Anna is on bill 1 (210.00)');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.set_order_points('10000000-0000-4000-8000-000000000001', 10)$$, '42501', 'another org cannot');
select t_err(null, 'anon', $$select public.set_order_points('10000000-0000-4000-8000-000000000001', 10)$$, '42501', 'anon cannot');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_points('10000000-0000-4000-8000-000000000001', -1)$$, '22023', 'negative points');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.orders set points_used = 50, points_discount = 5000 where id = '10000000-0000-4000-8000-000000000001'$$, '23514', 'a client cannot write the points columns directly');

-- ── reserve ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'r1', $$select public.set_order_points('10000000-0000-4000-8000-000000000001', 30)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r1' and (v::jsonb ->> 'points_used') = '30' and (v::jsonb ->> 'discount') = '3000'$$, 1, '30 points = 30.00 discount (1 point = 1.00)');
select t_rows(null, 'service_role', $$select 1 from public.orders where id = '10000000-0000-4000-8000-000000000001' and points_used = 30 and points_discount = 3000$$, 1, 'stored on the bill');
select t_rows(null, 'service_role', $$select 1 where t_bal() = 70$$, 1, 'reserved at once: balance 100 → 70 (cannot be spent twice)');
-- cap: 50 % of the 210.00 goods = 105.00 → 105 points even if more are asked
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'r2', $$select public.set_order_points('10000000-0000-4000-8000-000000000001', 5000)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r2' and (v::jsonb ->> 'points_used') = '100'$$, 1, 'never more than the customer has (100)');
select t_rows(null, 'service_role', $$select 1 where t_bal() = 0$$, 1, 'balance 0 while all 100 are on the bill');
update public.orgs set points_rule = '{"maxRedeemBps": 1000}' where id = (select v::uuid from t_out where k='org');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'r3', $$select public.set_order_points('10000000-0000-4000-8000-000000000001', 100)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r3' and (v::jsonb ->> 'points_used') = '21'$$, 1, 'the owner''s cap (10 % of 210.00 = 21.00 = 21 points) applies and the rest is released');
select t_rows(null, 'service_role', $$select 1 where t_bal() = 79$$, 1, 'released points are back: 100 − 21');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_points('10000000-0000-4000-8000-000000000001', 0)$$, 1, 'taking them off the bill');
select t_rows(null, 'service_role', $$select 1 where t_bal() = 100$$, 1, 'all released');
select t_rows(null, 'service_role', $$select 1 from public.points_ledger where kind in ('redeem', 'reverse_redeem') and order_id = '10000000-0000-4000-8000-000000000001' having sum(points) = 0$$, 1, 'the ledger nets to zero');
update public.orgs set points_rule = '{}' where id = (select v::uuid from t_out where k='org');

-- changing the customer releases the reservation
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_points('10000000-0000-4000-8000-000000000001', 40)$$, 1, '40 on the bill');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_customer('10000000-0000-4000-8000-000000000001', null)$$, 1, 'the customer is removed');
select t_rows(null, 'service_role', $$select 1 where t_bal() = 100$$, 1, 'the reserved points are released');
select t_rows(null, 'service_role', $$select 1 from public.orders where id = '10000000-0000-4000-8000-000000000001' and points_used = 0 and points_discount = 0 and customer_id is null$$, 1, 'and the bill has no points');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_customer('10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='cid'))$$, 1, 'back on');

-- a payment attempt cannot claim more than the bill holds
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_points('10000000-0000-4000-8000-000000000001', 40)$$, 1, '40 points = 40.00 on the bill');
select t_err(null, 'service_role', $$insert into public.payment_attempts (org_id, store_id, order_id, device_id, tender, amount, snapshot) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='dev'), 'promptpay', 17000, '{"points_discount": 9000}')$$, '23514', 'an attempt claiming 90.00 of points on a bill that holds 40.00');
insert into public.payment_attempts (org_id, store_id, order_id, device_id, tender, amount, snapshot) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='dev'), 'promptpay', 17000, '{"points_discount": 4000}');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_points('10000000-0000-4000-8000-000000000001', 10)$$, '55006', 'points cannot change while a payment is waiting');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_customer('10000000-0000-4000-8000-000000000001', null)$$, '55006', 'nor the customer');
update public.payment_attempts set status = 'canceled';

-- ── closing: the discount is on the receipt, 40 points are consumed, Points are earned on the money actually paid ──
create or replace function t_close_pts(p_disc bigint, p_total bigint) returns jsonb language sql as $$
  select jsonb_build_object('order_id', '10000000-0000-4000-8000-000000000001', 'receipt_number', 'A-000001', 'device_id', (select v from t_out where k='dev'),
    'staff_id', (select v from t_out where k='cashier_staff'), 'issued_at', now(), 'lang', 'th', 'subtotal', 21000, 'service_charge', 0, 'vat', 1113,
    'net_before_vat', 15887, 'total', p_total, 'rounding', 0, 'payable', p_total, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive', 'points_discount', p_disc,
    'payments', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'tender', 'cash', 'amount', p_total, 'tendered', p_total, 'change', 0)))
$$;
grant execute on function t_close_pts(bigint, bigint) to authenticated, service_role;
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_close_pts(9000, 12000))$$, '23514', 'a close that claims more discount than the bill holds is refused');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_close_pts(4000, 17000))$$, 1, 'the bill is closed with a 40.00 points discount: 170.00 paid in cash');
select t_rows(null, 'service_role', $$select 1 from public.receipts where order_id = '10000000-0000-4000-8000-000000000001' and points_discount = 4000 and points_used = 40$$, 1, 'the receipt records the discount and the points used');
select t_rows(null, 'service_role', $$select 1 where t_bal() = 100 - 40 + 6$$, 1, 'balance: 100 − 40 used + 6 earned (170.00 / 25.00 = 6)');
select t_rows(null, 'service_role', $$select 1 from public.points_ledger where order_id = '10000000-0000-4000-8000-000000000001' and kind = 'earn' and points = 6$$, 1, 'earned only on the money paid, not on the discount');

-- unused reservation is released at the close: hold 50, close with a 20.00 discount
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_customer('10000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='cid'))$$, 1, 'Anna on bill 2 (30.00)');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'h2', $$select public.set_order_points('10000000-0000-4000-8000-000000000002', 15)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='h2' and (v::jsonb ->> 'points_used') = '15' and (v::jsonb ->> 'cap_points') = '15'$$, 1, 'half of 30.00 = 15 points at most');
select t_rows(null, 'service_role', $$select 1 where t_bal() = 60 + 6 - 15$$, 1, '15 reserved');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(jsonb_set(jsonb_set(jsonb_set(jsonb_set(t_close_pts(1000, 2000), '{order_id}', '"10000000-0000-4000-8000-000000000002"'), '{receipt_number}', '"A-000002"'), '{subtotal}', '3000'), '{vat}', '131'))$$, 1, 'closed with only a 10.00 discount (10 points used)');
select t_rows(null, 'service_role', $$select 1 where t_bal() = 60 + 6 - 10 + 0$$, 1, 'the 5 unused points came back; 20.00 in cash earns 0');
select t_rows(null, 'service_role', $$select 1 from public.receipts where order_id = '10000000-0000-4000-8000-000000000002' and points_used = 10 and points_discount = 1000$$, 1, 'receipt 2: 10 points / 10.00');

-- voiding a bill gives its reservation back
insert into public.orders (id, org_id, store_id, number, business_date, channel, customer_id)
values ('10000000-0000-4000-8000-000000000005', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A005', (now() at time zone 'Asia/Bangkok')::date, 'takeaway', (select v::uuid from t_out where k='cid'));
insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, status, sent_at)
values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000005', '{"th":"x"}', 10000, 1, 'sent', now());
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_points('10000000-0000-4000-8000-000000000005', 20)$$, 1, '20 points on bill 5');
select t_rows(null, 'service_role', $$select 1 where t_bal() = 56 - 20$$, 1, 'reserved');
update public.orders set status = 'void' where id = '10000000-0000-4000-8000-000000000005';
select t_rows(null, 'service_role', $$select 1 where t_bal() = 56$$, 1, 'a voided bill releases its points');
select t_rows(null, 'service_role', $$select 1 from public.orders where id = '10000000-0000-4000-8000-000000000005' and points_used = 0$$, 1, 'and holds none');
\echo ALL POINTS REDEEM TESTS PASSED
