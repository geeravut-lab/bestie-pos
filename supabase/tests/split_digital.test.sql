-- PromptPay / card as ONE leg of a split bill: legs ride in the attempt, nothing is booked until the signed webhook, Credit re-checked, mismatches parked.
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

-- ── refusals when asking ──
select t_err('00000000-0000-0000-0000-0000000000c9', 'authenticated', $$select public.begin_payment_attempt(t_att('promptpay', jsonb_build_array(t_leg_cr('70000000-0000-4000-8000-000000000001', 5000))))$$, '42501', 'a waiter cannot start it');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_att('promptpay', jsonb_build_array(jsonb_build_object('id', '70000000-0000-4000-8000-000000000001', 'tender', 'promptpay', 'amount', 5000))))$$, '23514', 'only cash and Credit legs ride along (one digital share)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_att('promptpay', jsonb_build_array(t_leg_cr('70000000-0000-4000-8000-000000000001', 21000))))$$, '23514', 'the digital share cannot be zero');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_att('promptpay', jsonb_build_array(t_leg_cr('70000000-0000-4000-8000-000000000001', 90000))))$$, '23514', 'legs above the bill are refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_att('promptpay', jsonb_build_array(t_leg_cr('70000000-0000-4000-8000-000000000001', 5000)), '10000000-0000-4000-8000-000000000001', 21000, 150))$$, '23514', 'a rounding of more than one baht');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_att('promptpay', jsonb_build_array(jsonb_build_object('id', 'not-a-uuid', 'tender', 'credit', 'amount', 5000))))$$, '23514', 'a leg needs a real id');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_customer('10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='cid'))$$, 1, 'Anna is on bill 1');

-- ── asking works; the attempt is the digital share only ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'att', $$select public.begin_payment_attempt(t_att('promptpay', jsonb_build_array(t_leg_cr('70000000-0000-4000-8000-000000000001', 5000), t_leg_cash('70000000-0000-4000-8000-000000000002', 6000, 10000))))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.payment_attempts where id = (select v::uuid from t_out where k='att') and amount = 10000 and tender = 'promptpay' and status = 'created'$$, 1, 'the attempt asks for 100.00 (210 − 50 Credit − 60 cash)');
select t_rows(null, 'service_role', $$select 1 from public.credit_ledger where kind = 'spend'$$, 0, 'nothing is spent before the provider confirms');
select t_rows(null, 'service_role', $$select 1 from public.payments$$, 0, 'no payment is booked before the provider confirms');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_att('gateway', jsonb_build_array(t_leg_cr('70000000-0000-4000-8000-000000000001', 5000))))$$, '23505', 'one live attempt per bill');

-- ── the provider confirms ──
select t_rows(null, 'service_role', $$select public.attach_payment_intent((select v::uuid from t_out where k='att'), 'pi_split_1', 'https://qr.example/1.png', now() + interval '10 minutes')$$, 1, 'the intent is attached');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='att'), 'pi_split_1', 10000, 'thb')$$, '42501', 'a till cannot confirm');
select t_val(null, 'service_role', 'res', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='att'), 'pi_split_1', 10000, 'thb')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='res' and v = 'paid'$$, 1, 'the signed payment closes the bill');
select t_rows(null, 'service_role', $$select 1 from public.orders where id = '10000000-0000-4000-8000-000000000001' and status = 'paid'$$, 1, 'the bill is paid');
select t_rows(null, 'service_role', $$select 1 from public.payments where order_id = '10000000-0000-4000-8000-000000000001' and status = 'confirmed'$$, 3, 'three payments: Credit, cash, PromptPay');
select t_rows(null, 'service_role', $$select 1 from public.payments where order_id = '10000000-0000-4000-8000-000000000001' and ((tender = 'credit' and amount = 5000) or (tender = 'cash' and amount = 6000 and tendered = 10000 and change = 4000) or (tender = 'promptpay' and amount = 10000 and reference = 'pi_split_1'))$$, 3, 'with the right amounts, cash change and the provider reference');
select t_rows(null, 'service_role', $$select 1 from public.receipts where order_id = '10000000-0000-4000-8000-000000000001' and payable = 21000 and number ~ '\+[0-9]{6}$'$$, 1, 'one receipt in the server + series for 210.00');
select t_rows(null, 'service_role', $$select 1 from public.credit_ledger where kind = 'spend' and amount = -5000 and order_id = '10000000-0000-4000-8000-000000000001'$$, 1, 'one balanced Credit spend of 50.00');
select t_rows(null, 'service_role', $$select 1 from public.points_ledger where kind = 'earn' and order_id = '10000000-0000-4000-8000-000000000001'$$, 1, 'Points are earned on the money paid');
select t_val(null, 'service_role', 'res2', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='att'), 'pi_split_1', 10000, 'thb')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='res2' and v = 'already'$$, 1, 'a webhook delivered twice changes nothing');
select t_rows(null, 'service_role', $$select 1 from public.credit_ledger where kind = 'spend'$$, 1, 'still one Credit spend');

-- ── Credit spent meanwhile / amount differs → parked for a person, nothing booked ──
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_customer('10000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='cid'))$$, 1, 'Anna is on bill 2 (30.00)');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'att2', $$select public.begin_payment_attempt(jsonb_build_object('order_id', '10000000-0000-4000-8000-000000000002', 'device_id', (select v from t_out where k='dev'), 'staff_id', (select v from t_out where k='cashier_staff'), 'tender', 'gateway', 'lang', 'en', 'subtotal', 3000, 'points_discount', 0, 'service_charge', 0, 'vat', 196, 'net_before_vat', 2804, 'total', 3000, 'rounding', 0, 'payable', 3000, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive', 'legs', jsonb_build_array(t_leg_cr('70000000-0000-4000-8000-000000000009', 2000))))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.payment_attempts where id = (select v::uuid from t_out where k='att2') and amount = 1000$$, 1, 'bill 2: 20.00 Credit + 10.00 by card');
-- Anna's Credit is used up elsewhere (a correction by the owner)
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.adjust_credit((select v::uuid from t_out where k='cid'), (select v::uuid from t_out where k='store'), -10000, 'test: used elsewhere')$$, 1, 'the balance drops a little');
select t_val(null, 'service_role', 'res3', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='att2'), 'pi_split_2', 1000, 'thb')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='res3' and v = 'paid'$$, 1, 'enough Credit is left for 20.00: still paid');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'o3', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values ('10000000-0000-4000-8000-000000000003', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A003', (now() at time zone 'Asia/Bangkok')::date, 'takeaway') returning id::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, status, sent_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000003', '{"th":"ชา"}', 3000, 1, 'sent', now())$$, 1, 'bill 3 (30.00)');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_order_customer('10000000-0000-4000-8000-000000000003', (select v::uuid from t_out where k='cid'))$$, 1, 'Anna is on bill 3');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'att3', $$select public.begin_payment_attempt(jsonb_build_object('order_id', '10000000-0000-4000-8000-000000000003', 'device_id', (select v from t_out where k='dev'), 'staff_id', (select v from t_out where k='cashier_staff'), 'tender', 'promptpay', 'lang', 'en', 'subtotal', 3000, 'points_discount', 0, 'service_charge', 0, 'vat', 196, 'net_before_vat', 2804, 'total', 3000, 'rounding', 0, 'payable', 3000, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive', 'legs', jsonb_build_array(t_leg_cr('70000000-0000-4000-8000-000000000008', 2000))))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.adjust_credit((select v::uuid from t_out where k='cid'), (select v::uuid from t_out where k='store'), -83000, 'test: spent meanwhile')$$, 1, 'the balance drops below the 20.00 leg');
select t_val(null, 'service_role', 'res4', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='att3'), 'pi_split_3', 1000, 'thb')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='res4' and v = 'needs_review'$$, 1, 'Credit spent meanwhile → parked for a person');
select t_rows(null, 'service_role', $$select 1 from public.orders where id = '10000000-0000-4000-8000-000000000003' and status <> 'paid'$$, 1, 'the bill stays open');
select t_rows(null, 'service_role', $$select 1 from public.credit_ledger where order_id = '10000000-0000-4000-8000-000000000003'$$, 0, 'and nothing was spent');

-- ── a whole-bill attempt (no legs) is untouched ──
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.cancel_payment_attempt((select v::uuid from t_out where k='att3'))$$, 1, 'the parked attempt can be left alone');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_att('promptpay', '[]'::jsonb, '10000000-0000-4000-8000-000000000003', 3000, 25))$$, '23514', 'without legs a digital payment still has no cash rounding');
do $$ begin raise notice 'ALL SPLIT DIGITAL TESTS PASSED'; end $$;
