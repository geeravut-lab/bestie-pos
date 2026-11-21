-- Bestie Credit: ledger rules, entity scope, cash top-ups, drawer, liability report. No cash-out, no crypto, never below zero.
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

-- ── off by default ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.topup_credit(t_topup('50000000-0000-4000-8000-000000000001', 50000))$$, '0A000', 'Credit is off until the owner switches the module on');
update public.stores set module_overrides = '{"tender.credit": true}' where id = (select v::uuid from t_out where k='store');

-- ── top-up ──
select t_err('00000000-0000-0000-0000-0000000000c9', 'authenticated', $$select public.topup_credit(t_topup('50000000-0000-4000-8000-000000000001', 50000))$$, '42501', 'a waiter (no payment.take) cannot top up');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.topup_credit(t_topup('50000000-0000-4000-8000-000000000001', 50000))$$, '42501', 'another org cannot');
select t_err(null, 'anon', $$select public.topup_credit(t_topup('50000000-0000-4000-8000-000000000001', 50000))$$, '42501', 'anon cannot');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.topup_credit(t_topup('50000000-0000-4000-8000-000000000001', 5000))$$, '22023', 'under 100.00 is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.topup_credit(t_topup('50000000-0000-4000-8000-000000000001', 6000000))$$, '22023', 'over 50,000.00 is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.topup_credit(t_topup('50000000-0000-4000-8000-000000000001', 50000, 'promptpay'))$$, '22023', 'the till only takes cash top-ups for now');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.topup_credit(t_topup('50000000-0000-4000-8000-000000000001', 50000, 'crypto'))$$, '22023', 'crypto is never a top-up funding here');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.topup_credit(jsonb_set(t_topup('50000000-0000-4000-8000-000000000001', 50000), '{customer_id}', to_jsonb((select v from t_out where k='fc'))))$$, 'P0002', 'a customer of another org is not found');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 't1', $$select public.topup_credit(t_topup('50000000-0000-4000-8000-000000000001', 100000))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='t1' and (v::jsonb ->> 'balance') = '100000' and (v::jsonb ->> 'replay') = 'false'$$, 1, 'a 1,000.00 cash top-up: balance 1,000.00');
select t_rows(null, 'service_role', $$select 1 from public.credit_ledger where kind = 'topup' and amount = 100000 and funding = 'cash' and debit_account = 'cash' and credit_account = 'customer_credit' and legal_entity_id = (select v::uuid from t_out where k='ent1')$$, 1, 'one balanced posting: debit cash, credit customer_credit, issued by the shop''s legal entity');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 't1b', $$select public.topup_credit(t_topup('50000000-0000-4000-8000-000000000001', 100000))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='t1b' and (v::jsonb ->> 'replay') = 'true' and (v::jsonb ->> 'balance') = '100000'$$, 1, 'the same request again (lost answer) is recognised and adds nothing');
select t_rows(null, 'service_role', $$select 1 from public.credit_ledger having count(*) = 1$$, 1, 'one row');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'credit.topup'$$, 1, 'audited (critical)');

-- ── balance, entity scope ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'b1', $$select public.credit_balance((select v::uuid from t_out where k='cid'), (select v::uuid from t_out where k='ent1'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='b1' and v = '100000'$$, 1, 'balance in the issuing entity');
insert into public.legal_entities (org_id, name) select org_id, 'Second Co' from public.legal_entities where id = (select v::uuid from t_out where k='ent1');
select t_val(null, 'service_role', 'ent2', $$select id::text from public.legal_entities where name = 'Second Co'$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'b2', $$select public.credit_balance((select v::uuid from t_out where k='cid'), (select v::uuid from t_out where k='ent2'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='b2' and v = '0'$$, 1, 'the same customer has NO Credit in another legal entity: Credit cannot cross companies');
select t_val('00000000-0000-0000-0000-0000000000e5', 'authenticated', 'b3', $$select public.credit_balance((select v::uuid from t_out where k='cid'), (select v::uuid from t_out where k='ent1'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='b3' and v = '0'$$, 1, 'another org sees nothing');

-- ── ledger rules ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, kind, amount, funding, debit_account, credit_account) values (gen_random_uuid(), (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='ent1'), (select v::uuid from t_out where k='cid'), 'topup', 99999, 'cash', 'cash', 'customer_credit')$$, '42501', 'a client cannot write the ledger');
select t_err(null, 'service_role', $$update public.credit_ledger set amount = 1$$, '23514', 'append-only: no edits');
select t_err(null, 'service_role', $$delete from public.credit_ledger$$, '23514', 'append-only: no deletes');
select t_err(null, 'service_role', $$insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, kind, amount, debit_account, credit_account) values (gen_random_uuid(), (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='ent1'), (select v::uuid from t_out where k='cid'), 'cash_out', -100, 'customer_credit', 'cash')$$, '23514', 'there is no cash-out kind');
select t_err(null, 'service_role', $$insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, kind, amount, funding, debit_account, credit_account) values (gen_random_uuid(), (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='ent1'), (select v::uuid from t_out where k='cid'), 'topup', 100, 'crypto', 'cash', 'customer_credit')$$, '23514', 'no crypto funding value exists');
select t_err(null, 'service_role', $$insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, kind, amount, funding, debit_account, credit_account) values (gen_random_uuid(), (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='ent1'), (select v::uuid from t_out where k='cid'), 'topup', 100, 'cash', 'psp_clearing', 'customer_credit')$$, '23514', 'a cash top-up must debit the cash account');
select t_err(null, 'service_role', $$insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, kind, amount, debit_account, credit_account, order_id) values (gen_random_uuid(), (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='ent1'), (select v::uuid from t_out where k='cid'), 'spend', -200000, 'customer_credit', 'sales', '10000000-0000-4000-8000-000000000001')$$, '23514', 'Credit cannot be overspent');
select t_err(null, 'service_role', $$insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, kind, amount, debit_account, credit_account, order_id) values (gen_random_uuid(), (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='ent1'), (select v::uuid from t_out where k='fc'), 'spend', -100, 'customer_credit', 'sales', '10000000-0000-4000-8000-000000000001')$$, '23514', 'a customer of another org cannot be charged');
insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, kind, amount, debit_account, credit_account, order_id)
values (gen_random_uuid(), (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='ent1'), (select v::uuid from t_out where k='cid'), 'spend', -21000, 'customer_credit', 'sales', '10000000-0000-4000-8000-000000000001');
select t_err(null, 'service_role', $$insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, kind, amount, debit_account, credit_account, order_id) values (gen_random_uuid(), (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='ent1'), (select v::uuid from t_out where k='cid'), 'spend', -100, 'customer_credit', 'sales', '10000000-0000-4000-8000-000000000001')$$, '23505', 'one Credit spend per bill');

-- ── correction ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.adjust_credit((select v::uuid from t_out where k='cid'), (select v::uuid from t_out where k='store'), 5000, 'x')$$, '42501', 'a cashier cannot correct Credit');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.adjust_credit((select v::uuid from t_out where k='cid'), (select v::uuid from t_out where k='store'), 5000, ' ')$$, '22023', 'a reason is required');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.adjust_credit((select v::uuid from t_out where k='cid'), (select v::uuid from t_out where k='store'), -4000000, 'oops')$$, '23514', 'cannot go below zero');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'adj', $$select public.adjust_credit((select v::uuid from t_out where k='cid'), (select v::uuid from t_out where k='store'), 5000, 'goodwill')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='adj' and v = '84000'$$, 1, 'owner correction: 1,000 − 210 + 50 = 840.00');

-- ── liability report ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.credit_liability((select v::uuid from t_out where k='org'))$$, '42501', 'a cashier cannot read the liability report');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'liab', $$select public.credit_liability((select v::uuid from t_out where k='org'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='liab' and (v::jsonb) @> '[{"name":"Acme Co","outstanding":84000,"customers":1}]'::jsonb and (v::jsonb) @> '[{"name":"Second Co","outstanding":0}]'::jsonb$$, 1, 'outstanding Credit per legal entity');

-- ── the drawer counts cash top-ups ──
insert into public.shifts (id, org_id, store_id, device_id, opened_by, opened_at, opening_cash)
values ('60000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='dev'),
        (select v::uuid from t_out where k='cashier_staff'), now() - interval '1 hour', 100000);
update public.credit_ledger set created_at = created_at where false;
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.topup_credit(t_topup('50000000-0000-4000-8000-000000000009', 30000))$$, 1, 'another top-up during the shift: 300.00');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cs', $$select public.close_shift(jsonb_build_object('id', '60000000-0000-4000-8000-000000000001', 'closed_at', now() + interval '1 minute', 'counted_cash', 230000, 'staff_id', (select v from t_out where k='cashier_staff')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='cs' and (v::jsonb ->> 'expected_cash') = '230000' and (v::jsonb ->> 'variance') = '0'$$, 1, 'expected cash = opening 1,000.00 + cash top-ups taken on this device during the shift (1,000.00 + 300.00)');
\echo ALL CREDIT TESTS PASSED
