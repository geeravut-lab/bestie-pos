-- Several PromptPay / card shares on one bill: held on the bill, bill locked, last share closes, manager can release, refunds marked.
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
update public.devices set stripe_reader_id = 'tmr_ABC123xyz' where id = (select v::uuid from t_out where k='dev');

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


-- a partial snapshot charges exactly partial_amount; no legs
create or replace function t_part(p_amount bigint, p_tender text default 'promptpay', p_order text default '10000000-0000-4000-8000-000000000001') returns jsonb language sql as $$
  select t_att(p_tender, '[]'::jsonb, p_order) || jsonb_build_object('partial', true, 'partial_amount', p_amount)
$$;
grant execute on function t_part(bigint, text, text) to authenticated, service_role;

select t_err('00000000-0000-0000-0000-0000000000c9', 'authenticated', $$select public.begin_payment_attempt(t_part(7000))$$, '42501', 'a waiter cannot start a share');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_part(21000))$$, '23514', 'a share that is not the last must leave something to pay');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_part(0))$$, '22023', 'a zero share is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_att('promptpay', jsonb_build_array(t_leg_cr('70000000-0000-4000-8000-000000000001', 5000)) ) || jsonb_build_object('partial', true, 'partial_amount', 7000))$$, '22023', 'a share carries no legs');

-- share 1: 70.00 by PromptPay
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'p1', $$select public.begin_payment_attempt(t_part(7000))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.payment_attempts where id = (select v::uuid from t_out where k='p1') and amount = 7000$$, 1, 'the share asks for 70.00');
select t_rows(null, 'service_role', $$select public.attach_payment_intent((select v::uuid from t_out where k='p1'), 'pi_p1', 'https://qr/p1.png', now() + interval '10 minutes')$$, 1, 'intent attached');
select t_val(null, 'service_role', 'r1', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='p1'), 'pi_p1', 7000, 'thb')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r1' and v = 'held'$$, 1, 'the confirmed share is HELD, not closed');
select t_rows(null, 'service_role', $$select 1 from public.orders where id = '10000000-0000-4000-8000-000000000001' and status = 'open'$$, 1, 'the bill is still open');
select t_rows(null, 'service_role', $$select 1 from public.receipts where order_id = '10000000-0000-4000-8000-000000000001'$$, 0, 'no receipt yet');
select t_rows(null, 'service_role', $$select 1 from public.order_partial_payments where amount = 7000 and status = 'held' and provider_ref = 'pi_p1'$$, 1, 'the share is on the bill');
select t_val(null, 'service_role', 'r1b', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='p1'), 'pi_p1', 7000, 'thb')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r1b' and v = 'already'$$, 1, 'a repeated webhook does nothing');
select t_rows(null, 'service_role', $$select 1 from public.order_partial_payments$$, 1, 'still one share');

-- the bill is locked
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', '{"th":"x"}', 100, 1)$$, '55006', 'no new lines on a bill with a paid share');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.orders set status = 'void' where id = '10000000-0000-4000-8000-000000000001'$$, '55006', 'the bill cannot be voided');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.order_lines set status = 'ready' where order_id = '10000000-0000-4000-8000-000000000001' and unit_price = 3000 returning 1$$, 1, 'but the kitchen can still move a line forward');

-- share 2: 70.00 by card; share 3 (last): the rest by whole-bill style attempt
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'p2', $$select public.begin_payment_attempt(t_part(7000, 'gateway'))::text$$);
select t_val(null, 'service_role', 'r2', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='p2'), 'pi_p2', 7000, 'thb')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r2' and v = 'held'$$, 1, 'share 2 held');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_part(7000))$$, '23514', 'a share that leaves nothing for the last one is refused (7000 + 7000 + 7000 = whole bill)');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'p3', $$select public.begin_payment_attempt(t_att('promptpay', '[]'::jsonb))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.payment_attempts where id = (select v::uuid from t_out where k='p3') and amount = 7000$$, 1, 'the last share is what is left: 210 − 70 − 70 = 70.00');
select t_val(null, 'service_role', 'r3', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='p3'), 'pi_p3', 7000, 'thb')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r3' and v = 'paid'$$, 1, 'the last share closes the bill');
select t_rows(null, 'service_role', $$select 1 from public.payments where order_id = '10000000-0000-4000-8000-000000000001' and status = 'confirmed'$$, 3, 'three payments on one receipt');
select t_rows(null, 'service_role', $$select 1 from public.receipts where order_id = '10000000-0000-4000-8000-000000000001' and payable = 21000$$, 1, 'one receipt for 210.00');
select t_rows(null, 'service_role', $$select 1 from public.order_partial_payments where status = 'applied'$$, 2, 'the held shares are applied');
select t_rows(null, 'service_role', $$select 1 from public.points_ledger where kind = 'earn' and order_id = '10000000-0000-4000-8000-000000000001'$$, 1, 'Points are earned on the whole 210.00');

-- ── bill 2 (30.00): one share held, then the rest closes with CASH ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'q1', $$select public.begin_payment_attempt(t_att('promptpay', '[]'::jsonb, '10000000-0000-4000-8000-000000000002', 3000) || jsonb_build_object('subtotal', 3000, 'partial', true, 'partial_amount', 1000))::text$$);
select t_val(null, 'service_role', 'rq1', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='q1'), 'pi_q1', 1000, 'thb')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='rq1' and v = 'held'$$, 1, 'bill 2: 10.00 held');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(jsonb_build_object('order_id', '10000000-0000-4000-8000-000000000002', 'device_id', (select v from t_out where k='dev'), 'staff_id', (select v from t_out where k='cashier_staff'), 'issued_at', now(), 'lang', 'en', 'subtotal', 3000, 'service_charge', 0, 'vat', 196, 'net_before_vat', 2804, 'total', 3000, 'rounding', 0, 'payable', 3000, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive', 'payments', jsonb_build_array(t_leg_cash('71000000-0000-4000-8000-000000000001', 3000, 3000))))$$, '23514', 'cash for the WHOLE bill is refused when 10.00 is already paid');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(jsonb_build_object('order_id', '10000000-0000-4000-8000-000000000002', 'device_id', (select v from t_out where k='dev'), 'staff_id', (select v from t_out where k='cashier_staff'), 'issued_at', now(), 'lang', 'en', 'subtotal', 3000, 'service_charge', 0, 'vat', 196, 'net_before_vat', 2804, 'total', 3000, 'rounding', 0, 'payable', 3000, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive', 'payments', jsonb_build_array(t_leg_cash('71000000-0000-4000-8000-000000000002', 2000, 2500))))$$, 1, 'cash for the remaining 20.00 closes the bill');
select t_rows(null, 'service_role', $$select 1 from public.payments where order_id = '10000000-0000-4000-8000-000000000002' and status = 'confirmed'$$, 2, 'bill 2 has the QR share and the cash');

-- ── bill 3: a share is held, the guests give up ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'o3', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values ('10000000-0000-4000-8000-000000000003', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A003', (now() at time zone 'Asia/Bangkok')::date, 'takeaway') returning id::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, status, sent_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000003', '{"th":"ชา"}', 3000, 1, 'sent', now())$$, 1, 'bill 3 (30.00)');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 's1', $$select public.begin_payment_attempt(t_att('promptpay', '[]'::jsonb, '10000000-0000-4000-8000-000000000003', 3000) || jsonb_build_object('subtotal', 3000, 'partial', true, 'partial_amount', 1500))::text$$);
select t_val(null, 'service_role', 'rs1', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='s1'), 'pi_s1', 1500, 'thb')$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.release_partial_payments('10000000-0000-4000-8000-000000000003', 'guests left')$$, '42501', 'a cashier (no refund.create) cannot release the paid shares');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'rel', $$select public.release_partial_payments('10000000-0000-4000-8000-000000000003', 'guests left')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='rel' and v = '1500'$$, 1, 'the owner releases 15.00');
select t_rows(null, 'service_role', $$select 1 from public.order_partial_payments where status = 'refund_needed' and order_id = '10000000-0000-4000-8000-000000000003'$$, 1, 'it is marked: refund needed');
select t_rows(null, 'service_role', $$select 1 from public.app_notifications where kind = 'payment.review' and user_id = '00000000-0000-0000-0000-0000000000a1' and title like '%1500%' or kind = 'payment.review' and title like '%15%'$$, 1, 'the owner is told to refund 15 THB in Stripe');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.orders set status = 'void' where id = '10000000-0000-4000-8000-000000000003' returning 1$$, 1, 'the bill is unlocked and can be voided now');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.mark_partial_refunded((select id from public.order_partial_payments where status = 'refund_needed'))$$, '42501', 'a cashier cannot mark it refunded');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.mark_partial_refunded((select id from public.order_partial_payments where status = 'refund_needed'))$$, 1, 'the owner marks it refunded');
select t_rows(null, 'service_role', $$select 1 from public.order_partial_payments where status = 'refunded'$$, 1, 'after the manual refund in Stripe');
do $$ begin raise notice 'ALL PARTIAL DIGITAL TESTS PASSED'; end $$;
