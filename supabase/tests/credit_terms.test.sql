-- Migration 68: Credit terms must be accepted before a top-up; single-entity check; liability detail.
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
update public.stores set module_overrides = '{"tender.credit": true}' where id = (select v::uuid from t_out where k='store');
update public.legal_entities set tax_id = '0105560123456' where org_id = (select v::uuid from t_out where k='org');

-- ── no top-up without the customer's acceptance ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.topup_credit(t_topup('50000000-0000-4000-8000-000000000001', 50000))$$, '55000', 'a cash top-up is refused until the terms are accepted');
select t_err('00000000-0000-0000-0000-0000000000c9', 'authenticated', $$select public.accept_credit_terms((select v::uuid from t_out where k='cid'), (select v::uuid from t_out where k='store'))$$, '42501', 'a waiter (no payment.take) cannot record the acceptance');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.accept_credit_terms((select v::uuid from t_out where k='cid'), (select v::uuid from t_out where k='store'))$$, '42501', 'another business cannot');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.accept_credit_terms((select v::uuid from t_out where k='cid'), (select v::uuid from t_out where k='store'))$$, 1, 'the cashier records that the customer accepted');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.accept_credit_terms((select v::uuid from t_out where k='cid'), (select v::uuid from t_out where k='store'))$$, 1, 'recording it twice changes nothing');
select t_rows(null, 'service_role', $$select 1 from public.credit_terms_acceptances where version = public.credit_terms_version() and channel = 'counter'$$, 1, 'one acceptance of the current version, made at the counter');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.credit_terms_acceptances$$, 1, 'the front desk can read it');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.credit_terms_acceptances$$, 0, 'another business cannot');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'r1', $$select public.topup_credit(t_topup('50000000-0000-4000-8000-000000000001', 50000))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r1' and (v::jsonb ->> 'balance')::bigint = 50000$$, 1, 'after the acceptance the top-up works');

-- ── a new version of the terms needs a new acceptance ──
update public.credit_terms_acceptances set version = 99;   -- stands for "a version that is not the current one"
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.topup_credit(t_topup('50000000-0000-4000-8000-000000000002', 50000))$$, '55000', 'an acceptance of another version does not count');
update public.orgs set credit_terms_required = false where id = (select v::uuid from t_out where k='org');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.topup_credit(t_topup('50000000-0000-4000-8000-000000000002', 50000))$$, 1, 'a lawyer-approved exception (the org switch is off) lets it through');
update public.orgs set credit_terms_required = true where id = (select v::uuid from t_out where k='org');

-- ── single legal entity and the liability ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.credit_entity_check((select v::uuid from t_out where k='org'))$$, '42501', 'a cashier cannot read the entity check');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'chk', $$select public.credit_entity_check((select v::uuid from t_out where k='org'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb) r where o.k = 'chk' and r ->> 'store' = 'Acme' and (r ->> 'credit_on')::boolean and (r ->> 'tax_id_set')::boolean$$, 1, 'the shop sells the Credit of its company, which has a tax ID');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'liab', $$select public.credit_liability_detail((select v::uuid from t_out where k='org'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb) r where o.k = 'liab' and (r ->> 'topped_up')::bigint = 100000 and (r ->> 'topped_up_cash')::bigint = 100000 and (r ->> 'topped_up_crypto')::bigint = 0 and (r ->> 'outstanding')::bigint = 100000 and (r ->> 'customers')::int = 1$$, 1, 'two cash top-ups of 500.00 = 1,000.00 owed to one customer, none from crypto');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'liab0', $$select public.credit_liability_detail((select v::uuid from t_out where k='org'), (now() at time zone 'Asia/Bangkok')::date - 3)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb) r where o.k = 'liab0' and (r ->> 'outstanding')::bigint = 0$$, 1, 'three days ago nothing was owed (as-of date)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.credit_liability_detail((select v::uuid from t_out where k='org'))$$, '42501', 'a cashier cannot read it');
do $$ begin raise notice 'ALL CREDIT TERMS TESTS PASSED'; end $$;
