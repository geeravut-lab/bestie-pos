-- Split tender: cash + Credit legs on one bill, server-numbered receipt, one transaction, replay-safe, Credit scoped to the entity.
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

-- what the till sends: 210.00 = 100.00 Credit + 110.00 cash (handed 120.00)
create or replace function t_split(p_order text, p_pay jsonb, p_sub bigint default 21000, p_total bigint default 21000, p_round int default 0) returns jsonb language sql as $$
  select jsonb_build_object('order_id', p_order, 'device_id', (select v from t_out where k='dev'), 'staff_id', (select v from t_out where k='cashier_staff'),
    'issued_at', now(), 'lang', 'en', 'subtotal', p_sub, 'service_charge', 0, 'vat', 1374, 'net_before_vat', 19626, 'total', p_total, 'rounding', p_round,
    'payable', p_total + p_round, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive', 'payments', p_pay)
$$;
grant execute on function t_split(text, jsonb, bigint, bigint, int) to authenticated, service_role;
create or replace function t_cash(id text, amount bigint, tendered bigint) returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'tender', 'cash', 'amount', amount, 'tendered', tendered, 'change', tendered - amount)
$$;
create or replace function t_cr(id text, amount bigint) returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'tender', 'credit', 'amount', amount)
$$;
grant execute on function t_cash(text, bigint, bigint), t_cr(text, bigint) to authenticated, service_role;

-- ── refusals ──
select t_err('00000000-0000-0000-0000-0000000000c9', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_cr('70000000-0000-4000-8000-000000000001', 21000))))$$, '42501', 'a waiter cannot take payment');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_cr('70000000-0000-4000-8000-000000000001', 21000))))$$, '42501', 'another org cannot');
select t_err(null, 'anon', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_cr('70000000-0000-4000-8000-000000000001', 21000))))$$, '42501', 'anon cannot');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_cr('70000000-0000-4000-8000-000000000001', 10000), t_cash('70000000-0000-4000-8000-000000000002', 10000, 10000))))$$, '23514', 'legs that do not cover the amount due');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(jsonb_build_object('id', '70000000-0000-4000-8000-000000000001', 'tender', 'promptpay', 'amount', 21000))))$$, '23514', 'PromptPay cannot be declared by the till');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(jsonb_build_object('id', '70000000-0000-4000-8000-000000000001', 'tender', 'points', 'amount', 21000))))$$, '23514', 'Points are not a tender (they are a discount)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(jsonb_build_object('id', '70000000-0000-4000-8000-000000000001', 'tender', 'cash', 'amount', 21000, 'tendered', 20000, 'change', 0))))$$, '23514', 'cash handed over below the amount');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_cr('70000000-0000-4000-8000-000000000001', 21000)), 20000, 20000))$$, '23514', 'a subtotal that is not the lines');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_cr('70000000-0000-4000-8000-000000000001', 21000), t_cash('70000000-0000-4000-8000-000000000002', 150, 150)), 21000, 21000, 150))$$, '23514', 'a rounding of more than one baht');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000002', jsonb_build_array(t_cr('70000000-0000-4000-8000-000000000001', 3000)), 3000, 3000))$$, '23514', 'Credit needs a customer on the bill (bill 2 has none)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_cr('70000000-0000-4000-8000-000000000001', 21000), t_cash('70000000-0000-4000-8000-000000000002', 100, 100))))$$, '23514', 'over-covered');
update public.stores set module_overrides = '{}' where id = (select v::uuid from t_out where k='store');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_cr('70000000-0000-4000-8000-000000000001', 21000))))$$, '0A000', 'Credit switched off in the shop: refused');
update public.stores set module_overrides = '{"tender.credit": true}' where id = (select v::uuid from t_out where k='store');
select t_rows(null, 'service_role', $$select 1 from public.orders where status = 'open'$$, 2, 'nothing was closed by any refusal');
select t_rows(null, 'service_role', $$select 1 from public.credit_ledger where kind = 'spend'$$, 0, 'and no Credit was spent');

-- Credit owned by ANOTHER legal entity cannot pay here
insert into public.legal_entities (org_id, name) select org_id, 'Second Co' from public.legal_entities where id = (select v::uuid from t_out where k='ent1');
select t_val(null, 'service_role', 'ent2', $$select id::text from public.legal_entities where name = 'Second Co'$$);
insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, kind, amount, funding, debit_account, credit_account)
values (gen_random_uuid(), (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='ent2'), (select v::uuid from t_out where k='cid'), 'topup', 500000, 'cash', 'cash', 'customer_credit');
update public.credit_ledger set created_at = created_at where false;
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_cr('70000000-0000-4000-8000-000000000001', 21000), t_cash('70000000-0000-4000-8000-000000000002', 0, 0))))$$, '23514', 'a zero leg is refused');

-- ── a good split: 100.00 Credit + 110.00 cash (120.00 handed over, 10.00 change) ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'sp', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_cr('70000000-0000-4000-8000-000000000001', 10000), t_cash('70000000-0000-4000-8000-000000000002', 11000, 12000))))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='sp' and (v::jsonb ->> 'receipt_number') = 'A+000001' and (v::jsonb ->> 'replay') = 'false'$$, 1, 'the server numbers the receipt in the device''s + series');
select t_rows(null, 'service_role', $$select 1 from public.orders where id = '10000000-0000-4000-8000-000000000001' and status = 'paid'$$, 1, 'the bill is paid');
select t_rows(null, 'service_role', $$select 1 from public.payments where order_id = '10000000-0000-4000-8000-000000000001' and tender = 'credit' and amount = 10000 and tendered is null$$, 1, 'a Credit payment of 100.00');
select t_rows(null, 'service_role', $$select 1 from public.payments where order_id = '10000000-0000-4000-8000-000000000001' and tender = 'cash' and amount = 11000 and tendered = 12000 and change = 1000$$, 1, 'a cash payment of 110.00 with change');
select t_rows(null, 'service_role', $$select 1 from public.receipts where order_id = '10000000-0000-4000-8000-000000000001' and number = 'A+000001' and payable = 21000 and seller_name = 'Acme Co'$$, 1, 'one receipt');
select t_rows(null, 'service_role', $$select 1 from public.credit_ledger where kind = 'spend' and amount = -10000 and order_id = '10000000-0000-4000-8000-000000000001' and debit_account = 'customer_credit' and credit_account = 'sales' and legal_entity_id = (select v::uuid from t_out where k='ent1')$$, 1, 'one balanced spend posting in the shop''s own legal entity');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'bal', $$select public.credit_balance((select v::uuid from t_out where k='cid'), (select v::uuid from t_out where k='ent1'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='bal' and v = '90000'$$, 1, 'Credit in this company: 1,000.00 − 100.00 = 900.00 (the other company''s 5,000.00 untouched)');
select t_rows(null, 'service_role', $$select 1 from public.points_ledger where kind = 'earn' and points = 8$$, 1, 'Points earned on the 210.00 spend (Credit earns by default)');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'credit.spend'$$, 1, 'Credit spend audited');

-- replay: first payment id already used → same receipt, nothing doubled
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'sp2', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_cr('70000000-0000-4000-8000-000000000001', 10000), t_cash('70000000-0000-4000-8000-000000000002', 11000, 12000))))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='sp2' and (v::jsonb ->> 'receipt_number') = 'A+000001' and (v::jsonb ->> 'replay') = 'true'$$, 1, 'the same request again answers with the first receipt');
select t_rows(null, 'service_role', $$select 1 from public.credit_ledger where kind = 'spend' having count(*) = 1$$, 1, 'no second spend');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_cr('70000000-0000-4000-8000-000000000009', 21000))))$$, '23514', 'a different close of a closed bill is refused');

-- ── equal shares between payers, all cash, with the shop's rounding done by the till ──
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000002', jsonb_build_array(t_cash('70000000-0000-4000-8000-000000000011', 1000, 1000), t_cash('70000000-0000-4000-8000-000000000012', 1000, 2000), t_cash('70000000-0000-4000-8000-000000000013', 1000, 1000)), 3000, 3000))$$, 1, 'three payers share 30.00 equally in cash');
select t_rows(null, 'service_role', $$select 1 from public.payments where order_id = '10000000-0000-4000-8000-000000000002' and tender = 'cash' having count(*) = 3 and sum(amount) = 3000$$, 1, 'three cash payments on one receipt');
select t_rows(null, 'service_role', $$select 1 from public.receipts where order_id = '10000000-0000-4000-8000-000000000002' and number = 'A+000002'$$, 1, 'receipt numbers are consecutive');
select t_rows(null, 'service_role', $$select 1 from public.points_ledger$$, 1, 'a bill with no customer earns nothing');
\echo ALL SPLIT TENDER TESTS PASSED
