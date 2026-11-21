-- Crypto top-up of Bestie Credit: gated by module + lawyer sign-off, KYC tiers, locked rate, unique amounts, confirmations, review, AML.
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


select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cid', $$select (v::jsonb ->> 'id') from t_out where k='c1'$$);
select t_val(null, 'service_role', 'ent1', $$select legal_entity_id::text from public.stores where id = (select v::uuid from t_out where k='store')$$);
-- addresses (format only)
create or replace function t_tron(n int) returns text language sql as $$ select 'T' || lpad(n::text, 33, 'A') $$;
create or replace function t_eth(n int) returns text language sql as $$ select '0x' || lpad(to_hex(n), 40, '0') $$;
grant execute on function t_tron(int), t_eth(int) to authenticated, service_role;

create or replace function t_pre(thb bigint, net text default 'tron') returns jsonb language sql as $$
  select jsonb_build_object('store_id', (select v from t_out where k='store'), 'customer_id', (select v from t_out where k='cid'), 'network', net, 'thb', thb)
$$;
grant execute on function t_pre(bigint, text) to authenticated, service_role;

-- ── gated three ways ──
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.crypto_set_wallet(jsonb_build_object('store_id', (select v from t_out where k='store'), 'network', 'tron', 'address', t_tron(1)))$$, '0A000', 'off by default: module not switched on');
select t_err(null, 'service_role', $$update public.stores set module_overrides = '{"tender.credit": true, "credit.topup.crypto": true}' where id = (select v::uuid from t_out where k='store')$$, '23514', 'the database refuses to switch the module on without the lawyer''s sign-off');
update public.orgs set legal_sign_off = '{"cryptoTopup": true}' where id = (select v::uuid from t_out where k='org');
update public.stores set module_overrides = '{"credit.topup.crypto": true}' where id = (select v::uuid from t_out where k='store');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.crypto_set_wallet(jsonb_build_object('store_id', (select v from t_out where k='store'), 'network', 'tron', 'address', t_tron(1)))$$, '0A000', 'Credit itself must be on (the module depends on it)');
update public.stores set module_overrides = '{"tender.credit": true, "credit.topup.crypto": true}' where id = (select v::uuid from t_out where k='store');
update public.orgs set legal_sign_off = '{"cryptoTopup": false}' where id = (select v::uuid from t_out where k='org');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.crypto_set_wallet(jsonb_build_object('store_id', (select v from t_out where k='store'), 'network', 'tron', 'address', t_tron(1)))$$, '0A000', 'if the sign-off is withdrawn the functions stop at once');
update public.orgs set legal_sign_off = '{"cryptoTopup": true}' where id = (select v::uuid from t_out where k='org');

-- ── wallets ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.crypto_set_wallet(jsonb_build_object('store_id', (select v from t_out where k='store'), 'network', 'tron', 'address', t_tron(1)))$$, '42501', 'a cashier cannot set the company wallet');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.crypto_set_wallet(jsonb_build_object('store_id', (select v from t_out where k='store'), 'network', 'tron', 'address', 'not-an-address'))$$, '23514', 'a malformed address is refused');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'wtron', $$select public.crypto_set_wallet(jsonb_build_object('store_id', (select v from t_out where k='store'), 'network', 'tron', 'address', t_tron(1), 'label', 'Hardware wallet'))::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'weth', $$select public.crypto_set_wallet(jsonb_build_object('store_id', (select v from t_out where k='store'), 'network', 'ethereum', 'address', upper(t_eth(2))))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.crypto_wallets where network = 'ethereum' and address = lower(address)$$, 1, 'Ethereum addresses are stored in lower case');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.crypto_set_wallet(jsonb_build_object('store_id', (select v from t_out where k='store'), 'network', 'tron', 'address', t_tron(9)))$$, '23505', 'a second set is refused: changing needs two people');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'chg', $$select public.crypto_wallet_change_request(jsonb_build_object('store_id', (select v from t_out where k='store'), 'network', 'tron', 'address', t_tron(9)))::text$$);
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.crypto_wallet_change_approve((select v::uuid from t_out where k='chg'))$$, '23514', 'the requester cannot approve their own change');

-- ── KYC ──
create or replace function t_kyc(tier text default 'T1') returns jsonb language sql as $$
  select jsonb_build_object('store_id', (select v from t_out where k='store'), 'customer_id', (select v from t_out where k='cid'), 'tier', tier,
    'full_name', 'Anna Smith', 'nationality', 'British', 'passport_no', 'AB1234567', 'contact', 'anna@example.test')
$$;
grant execute on function t_kyc(text) to authenticated, service_role;

select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.crypto_request_precheck(t_pre(100000)) ->> 'problem' = 'kyc_required'$$, 1, 'no KYC yet: the precheck says KYC is required');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.crypto_request_precheck(t_pre(100000))$$, '42501', 'another org cannot precheck');
select t_err(null, 'anon', $$select public.crypto_request_precheck(t_pre(100000))$$, '42501', 'anon cannot');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.crypto_kyc_submit(jsonb_set(t_kyc('T2'), '{source_of_funds}', 'null'))$$, '23514', 'T2 needs a source of funds and a proven wallet');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.crypto_kyc_submit(jsonb_set(t_kyc(), '{passport_no}', '"x"'))$$, '23514', 'a bad passport number');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'kyc1', $$select public.crypto_kyc_submit(t_kyc())::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.crypto_kyc$$, 0, 'a cashier cannot read the personal data');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.crypto_kyc where passport_no = 'AB1234567'$$, 1, 'the owner can');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.crypto_kyc_decide((select v::uuid from t_out where k='kyc1'), true, 'ok')$$, '42501', 'a cashier cannot approve KYC');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.crypto_request_precheck(t_pre(100000)) ->> 'problem' = 'kyc_required'$$, 1, 'a pending KYC is not enough');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.crypto_kyc_decide((select v::uuid from t_out where k='kyc1'), true, 'passport checked')$$, 1, 'the owner approves T1');
select t_err(null, 'service_role', $$update public.crypto_kyc set passport_no = 'ZZ9999999'$$, '23514', 'a KYC record cannot be rewritten');
select t_err(null, 'service_role', $$delete from public.crypto_kyc$$, '23514', 'or deleted (kept 5 years)');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.crypto_customer_status((select v::uuid from t_out where k='cid')) ->> 'tier' = 'T1'$$, 1, 'a cashier sees the tier and status only');

-- ── limits ──
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.crypto_request_precheck(t_pre(40000)) ->> 'problem' = 'below_minimum'$$, 1, 'under 500 baht');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.crypto_request_precheck(t_pre(60000, 'ethereum')) ->> 'problem' = 'below_minimum'$$, 1, 'Ethereum needs 1,000 baht');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.crypto_request_precheck(t_pre(3500000)) ->> 'problem' = 'per_transaction'$$, 1, 'T1: over 30,000 per transaction');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'pre', $$select public.crypto_request_precheck(t_pre(100000))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='pre' and (v::jsonb ->> 'ok') = 'true' and (v::jsonb ->> 'tier') = 'T1' and (v::jsonb ->> 'address') = t_tron(1)$$, 1, 'a 1,000 baht top-up is allowed and the address comes from the server');

-- ── requests ──
create or replace function t_req(thb bigint, units bigint, net text default 'tron', rate int default 3650) returns jsonb language sql as $$
  select jsonb_build_object('store_id', (select v from t_out where k='store'), 'customer_id', (select v from t_out where k='cid'), 'network', net, 'thb', thb,
    'rate', rate, 'rate_sources', '{"a":{"name":"x","price":3650},"b":{"name":"y","price":3662}}'::jsonb, 'amount_units', units,
    'staff_id', (select v from t_out where k='cashier_id'))
$$;
grant execute on function t_req(bigint, bigint, text, int) to authenticated, service_role;
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cashier_id', $$select id::text from public.staff where display_name = 'Cashier'$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.crypto_create_request(t_req(100000, 27400317))$$, '42501', 'a client cannot create a request itself (only the server, after fetching two prices)');
select t_err(null, 'service_role', $$select public.crypto_create_request(t_req(100000, 27400000))$$, '22023', 'an amount without the unique suffix is refused');
select t_err(null, 'service_role', $$select public.crypto_create_request(t_req(40000, 10960317))$$, '23514', 'limits are checked again at creation');
select t_val(null, 'service_role', 'rq1', $$select public.crypto_create_request(t_req(100000, 27400317))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.crypto_requests where status = 'open' and rate = 3650 and amount_units = 27400317 and expires_at > now() + interval '14 minutes' and receive_address = t_tron(1)$$, 1, 'an open request: locked rate, exact amount, 15 minutes');
select t_err(null, 'service_role', $$select public.crypto_create_request(t_req(100000, 27400317))$$, '23505', 'the same amount on the same address cannot be live twice');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.crypto_requests$$, 1, 'staff can read requests (to show the QR)');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.crypto_requests$$, 0, 'another org cannot');

-- ── the chain watcher ──
create or replace function t_tx(hash text, to_addr text, units bigint, conf int, from_addr text default null, success boolean default true) returns jsonb language sql as $$
  select jsonb_build_object('network', 'tron', 'tx_hash', hash, 'log_index', 0, 'from', coalesce(from_addr, t_tron(77)), 'to', to_addr, 'units', units,
    'block_time', now(), 'confirmations', conf, 'success', success)
$$;
grant execute on function t_tx(text, text, bigint, int, text, boolean) to service_role;
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.crypto_record_transfer(t_tx('tx00000001', t_tron(1), 27400317, 30))$$, '42501', 'only the server may report transfers');
select t_rows(null, 'service_role', $$select 1 where public.crypto_record_transfer(t_tx('tx00000002', t_tron(55), 27400317, 30)) ->> 'reason' = 'not_our_wallet'$$, 1, 'a transfer to someone else''s address is ignored');
select t_rows(null, 'service_role', $$select 1 where public.crypto_record_transfer(t_tx('tx00000003', t_tron(1), 1000, 30)) ->> 'reason' = 'dust'$$, 1, 'dust (address poisoning) is never matched');
select t_rows(null, 'service_role', $$select 1 where public.crypto_record_transfer(t_tx('tx00000004', t_tron(1), 27400317, 30, null, false)) ->> 'reason' = 'failed_transaction'$$, 1, 'a failed transaction is ignored');
select t_rows(null, 'service_role', $$select 1 where public.crypto_record_transfer(t_tx('tx00000010', t_tron(1), 27400317, 5)) ->> 'status' = 'matched'$$, 1, 'the right amount is matched to the request, but 5 confirmations are not enough');
select t_rows(null, 'service_role', $$select 1 from public.crypto_requests where status = 'paid_pending' and tx_hash = 'tx00000010'$$, 1, 'the request waits (paid_pending)');
select t_rows(null, 'service_role', $$select 1 from public.credit_ledger where funding = 'crypto'$$, 0, 'and no Credit has been added');
select t_rows(null, 'service_role', $$select 1 where public.crypto_record_transfer(t_tx('tx00000010', t_tron(1), 27400317, 20)) ->> 'status' = 'credited'$$, 1, 'with 20 confirmations the Credit is added');
select t_rows(null, 'service_role', $$select 1 from public.credit_ledger where funding = 'crypto' and amount = 100000 and debit_account = 'crypto_wallet' and credit_account = 'customer_credit' and id = crypto_request_id$$, 1, 'one balanced posting: THB 1,000.00 at the locked rate; the ledger id is the request id');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.credit_balance((select v::uuid from t_out where k='cid'), (select v::uuid from t_out where k='ent1')) = 100000$$, 1, 'balance 1,000.00');
select t_rows(null, 'service_role', $$select 1 where public.crypto_record_transfer(t_tx('tx00000010', t_tron(1), 27400317, 40)) ->> 'status' = 'credited'$$, 1, 'the same transfer reported again');
select t_rows(null, 'service_role', $$select 1 from public.credit_ledger where funding = 'crypto' having count(*) = 1$$, 1, 'is never credited twice');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'credit.topup' and detail ->> 'funding' = 'crypto'$$, 1, 'audited (critical)');
select t_err(null, 'service_role', $$insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, kind, amount, funding, debit_account, credit_account) values (gen_random_uuid(), (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='ent1'), (select v::uuid from t_out where k='cid'), 'topup', 100, 'crypto', 'crypto_wallet', 'customer_credit')$$, '23514', 'Credit cannot be funded "by crypto" without a matching request');
select t_err(null, 'service_role', $$insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, kind, amount, debit_account, credit_account, reason) values (gen_random_uuid(), (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='ent1'), (select v::uuid from t_out where k='cid'), 'cash_out', -100, 'customer_credit', 'crypto_wallet', 'x')$$, '23514', 'there is still no cash-out kind (crypto-funded Credit cannot leave as cash)');

-- ── a payment that is not an exact match goes to a person ──
select t_val(null, 'service_role', 'rq2', $$select public.crypto_create_request(t_req(100000, 27400500))::text$$);
select t_rows(null, 'service_role', $$select 1 where public.crypto_record_transfer(t_tx('tx00000020', t_tron(1), 20000000, 30)) ->> 'reason' = 'unmatched'$$, 1, 'an under-payment (20.00 for 27.40) is not credited');
select t_val(null, 'service_role', 'tr20', $$select id::text from public.crypto_transfers where tx_hash = 'tx00000020'$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.crypto_resolve_review((select v::uuid from t_out where k='tr20'), 'credit', ((select v::jsonb ->> 'id' from t_out where k='rq2'))::uuid, 'ok')$$, '42501', 'a cashier cannot resolve a review');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.crypto_resolve_review((select v::uuid from t_out where k='tr20'), 'credit', ((select v::jsonb ->> 'id' from t_out where k='rq2'))::uuid, ' ')$$, '22023', 'a note is required');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 where public.crypto_resolve_review((select v::uuid from t_out where k='tr20'), 'credit', ((select v::jsonb ->> 'id' from t_out where k='rq2'))::uuid, 'customer confirmed the short payment') ->> 'thb' = '73000'$$, 1, 'the owner credits what was actually received: 20.00 USDT × 36.50 = 730.00');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.credit_balance((select v::uuid from t_out where k='cid'), (select v::uuid from t_out where k='ent1')) = 173000$$, 1, 'balance 1,730.00');

-- late payment (request expired)
select t_val(null, 'service_role', 'rq3', $$select public.crypto_create_request(t_req(100000, 27400700))::text$$);
update public.crypto_requests set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = ((select v::jsonb ->> 'id' from t_out where k='rq3'))::uuid;
select t_rows(null, 'service_role', $$select 1 where public.crypto_expire_requests() >= 1$$, 1, 'expired requests are closed');
select t_rows(null, 'service_role', $$select 1 where public.crypto_record_transfer(t_tx('tx00000030', t_tron(1), 27400700, 30)) ->> 'reason' = 'late_or_expired'$$, 1, 'paying after the time is not credited automatically');

-- blocked sender
insert into public.crypto_blocklist (network, address, reason, source) values ('tron', t_tron(66), 'sanctioned', 'sanctions');
select t_val(null, 'service_role', 'rq4', $$select public.crypto_create_request(t_req(100000, 27400900))::text$$);
select t_rows(null, 'service_role', $$select 1 where public.crypto_record_transfer(t_tx('tx00000040', t_tron(1), 27400900, 30, t_tron(66))) ->> 'reason' = 'blocked_sender'$$, 1, 'a blocklisted sender goes to review');
select t_val(null, 'service_role', 'tr40', $$select id::text from public.crypto_transfers where tx_hash = 'tx00000040'$$);
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.crypto_resolve_review((select v::uuid from t_out where k='tr40'), 'credit', ((select v::jsonb ->> 'id' from t_out where k='rq4'))::uuid, 'try')$$, '23514', 'and a person cannot credit it either');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 where public.crypto_resolve_review((select v::uuid from t_out where k='tr40'), 'reject', null, 'sanctioned sender; handled outside the system') ->> 'status' = 'rejected'$$, 1, 'rejecting is recorded');

-- ambiguous: two live requests only 1 unit apart
select t_val(null, 'service_role', 'rq5', $$select public.crypto_create_request(t_req(100000, 27401100))::text$$);
select t_val(null, 'service_role', 'rq6', $$select public.crypto_create_request(t_req(100000, 27401101))::text$$);
select t_rows(null, 'service_role', $$select 1 where public.crypto_record_transfer(t_tx('tx00000050', t_tron(1), 27401100, 30)) ->> 'reason' = 'ambiguous'$$, 1, 'two requests that cannot be told apart: a person decides');

-- ── the AML report ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.crypto_aml_report((select v::uuid from t_out where k='org'), current_date - 1, current_date + 1)$$, '42501', 'a cashier cannot export the AML report');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.crypto_aml_report((select v::uuid from t_out where k='org'), current_date + 1, current_date)$$, '22023', 'a bad range');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'aml', $$select public.crypto_aml_report((select v::uuid from t_out where k='org'), current_date - 1, current_date + 1)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='aml' and jsonb_array_length(v::jsonb) = 2 and (v::jsonb #>> '{0,passport_last4}') = '4567' and (v::jsonb #>> '{0,tx_hash}') = 'tx00000010'$$, 1, 'the report lists both credited top-ups with tx hash and only the last 4 passport digits');

-- ── a second approver for a wallet change ──
select t_rows(null, 'service_role', $$select 1 from public.crypto_wallets where active and network = 'tron' and address = t_tron(1)$$, 1, 'the wallet is still the old one until a second person approves');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000b2', 'owner2@example.test');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000b2', 'Second owner', r.id from public.orgs o
  join public.roles r on r.org_id = o.id and r.built_in = 'owner' where o.name = 'Acme Co';
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select 1 where public.crypto_wallet_change_approve((select v::uuid from t_out where k='chg')) is not null$$, 1, 'a DIFFERENT person approves: the new Tron address becomes active');
select t_rows(null, 'service_role', $$select 1 from public.crypto_wallets where network = 'tron' and active and address = t_tron(9)$$, 1, 'new wallet active');
select t_rows(null, 'service_role', $$select 1 from public.crypto_wallets where network = 'tron' and not active and address = t_tron(1)$$, 1, 'old wallet closed');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.crypto_wallet_change_approve((select v::uuid from t_out where k='chg'))$$, '23514', 'a decided change cannot be approved again');
\echo ALL CRYPTO TESTS PASSED
