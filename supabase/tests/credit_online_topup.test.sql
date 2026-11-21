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

-- the shop switches Credit on; a device with a card reader and one without
update public.stores set module_overrides = '{"tender.credit": true, "tender.gateway": true}' where id = (select v::uuid from t_out where k='store');
update public.devices set reader_id = 'tmr_ABC123xyz' where id = (select v::uuid from t_out where k='dev');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev2', $$insert into public.devices (org_id, store_id, name, role) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'No reader', 'staff') returning id::text$$);
create or replace function t_topup(p_tender text, p_amount bigint, p_dev text default 'dev') returns jsonb language sql as $$
  select jsonb_build_object('customer_id', (select v from t_out where k='cid'), 'store_id', (select v from t_out where k='store'),
    'device_id', (select v from t_out where k=p_dev), 'tender', p_tender, 'amount', p_amount)
$$;
grant execute on function t_topup(text, bigint, text) to authenticated, service_role;

-- ── asking ──
select t_err('00000000-0000-0000-0000-0000000000c9', 'authenticated', $$select public.begin_credit_topup_attempt(t_topup('promptpay', 50000))$$, '42501', 'a waiter cannot start a top-up (payment.take)');
select t_err(null, 'anon', $$select public.begin_credit_topup_attempt(t_topup('promptpay', 50000))$$, '42501', 'anon cannot');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_credit_topup_attempt(t_topup('crypto', 50000))$$, '22023', 'crypto is not a tender here');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_credit_topup_attempt(t_topup('promptpay', 5000))$$, '22023', 'under 100 baht is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_credit_topup_attempt(t_topup('promptpay', 5000100))$$, '22023', 'over 50,000 baht is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_credit_topup_attempt(t_topup('gateway', 50000, 'dev2'))$$, '23514', 'card needs a device with a reader');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.begin_credit_topup_attempt(t_topup('promptpay', 50000))$$, '42501', 'another org cannot top up our customer');
update public.stores set module_overrides = '{}' where id = (select v::uuid from t_out where k='store');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_credit_topup_attempt(t_topup('promptpay', 50000))$$, '0A000', 'refused while Credit is switched off');
update public.stores set module_overrides = '{"tender.credit": true, "tender.promptpay": false}' where id = (select v::uuid from t_out where k='store');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_credit_topup_attempt(t_topup('promptpay', 50000))$$, '0A000', 'refused while PromptPay is switched off in the shop');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_credit_topup_attempt(t_topup('gateway', 50000))$$, '0A000', 'card is off by default (tender.gateway has no default-on profile)');
update public.stores set module_overrides = '{"tender.credit": true, "tender.gateway": true}' where id = (select v::uuid from t_out where k='store');
update public.stores set module_overrides = '{"tender.credit": true, "tender.gateway": true}' where id = (select v::uuid from t_out where k='store');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'att', $$select public.begin_credit_topup_attempt(t_topup('promptpay', 50000))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.payment_attempts where id = (select v::uuid from t_out where k='att') and kind = 'credit_topup' and order_id is null and status = 'created' and amount = 50000$$, 1, 'a top-up attempt has a customer, no bill, and waits');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_credit_topup_attempt(t_topup('promptpay', 60000))$$, '23505', 'a second live top-up for the same customer is refused');

-- ── the provider tells us ──
select t_rows(null, 'service_role', $$select public.attach_payment_intent((select v::uuid from t_out where k='att'), 'pi_topup1', 'https://qr/x.png', now() + interval '15 minutes')$$, 1, 'the server records the provider reference');
select t_rows(null, 'service_role', $$select 1 where public.confirm_payment_attempt((select v::uuid from t_out where k='att'), 'pi_OTHER', 50000, 'thb') = 'needs_review'$$, 1, 'a different reference goes to review, nothing credited');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.credit_ledger) = 0$$, 1, 'and no Credit was added');
update public.payment_attempts set status = 'pending', error = null where id = (select v::uuid from t_out where k='att');
select t_rows(null, 'service_role', $$select 1 where public.confirm_payment_attempt((select v::uuid from t_out where k='att'), 'pi_topup1', 49999, 'thb') = 'needs_review'$$, 1, 'a different amount goes to review');
update public.payment_attempts set status = 'pending', error = null where id = (select v::uuid from t_out where k='att');
select t_rows(null, 'service_role', $$select 1 where public.confirm_payment_attempt((select v::uuid from t_out where k='att'), 'pi_topup1', 50000, 'usd') = 'needs_review'$$, 1, 'a different currency goes to review');
update public.payment_attempts set status = 'pending', error = null where id = (select v::uuid from t_out where k='att');
select t_rows(null, 'service_role', $$select 1 where public.confirm_payment_attempt((select v::uuid from t_out where k='att'), 'pi_topup1', 50000, 'thb') = 'paid'$$, 1, 'the signed confirmation credits the customer');
select t_rows(null, 'service_role', $$select 1 from public.credit_ledger where id = (select v::uuid from t_out where k='att') and kind = 'topup' and funding = 'promptpay' and debit_account = 'psp_clearing' and credit_account = 'customer_credit' and amount = 50000 and device_id is not null$$, 1, 'one balanced ledger row: PromptPay funding, provider clearing account, the attempt id as its id');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'bal', $$select public.credit_balance((select v::uuid from t_out where k='cid'), (select legal_entity_id from public.stores where id = (select v::uuid from t_out where k='store')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k = 'bal' and v = '50000'$$, 1, 'the balance is 500.00');
select t_rows(null, 'service_role', $$select 1 where public.confirm_payment_attempt((select v::uuid from t_out where k='att'), 'pi_topup1', 50000, 'thb') = 'already'$$, 1, 'the provider delivering the same event again changes nothing');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.credit_ledger) = 1$$, 1, 'still one ledger row');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'credit.topup' and (detail ->> 'funding') = 'promptpay'$$, 1, 'the top-up is audited');

-- ── limits are checked again when the money arrives ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'att2', $$select public.begin_credit_topup_attempt(t_topup('gateway', 100000))::text$$);
update public.stores set module_overrides = '{}' where id = (select v::uuid from t_out where k='store');
select t_rows(null, 'service_role', $$select 1 where public.confirm_payment_attempt((select v::uuid from t_out where k='att2'), 'pi_topup2', 100000, 'thb') = 'needs_review'$$, 1, 'Credit switched off meanwhile: the money is parked for a person, never silently credited');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.credit_ledger) = 1$$, 1, 'nothing was credited');

-- ── cancelling and the browser ──
update public.stores set module_overrides = '{"tender.credit": true, "tender.gateway": true}' where id = (select v::uuid from t_out where k='store');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'att3', $$select public.begin_credit_topup_attempt(t_topup('promptpay', 20000))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.cancel_payment_attempt((select v::uuid from t_out where k='att3'))$$, 1, 'the till can cancel a waiting top-up');
select t_rows(null, 'service_role', $$select 1 from public.payment_attempts where id = (select v::uuid from t_out where k='att3') and status = 'canceled'$$, 1, 'and it is canceled');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='att3'), 'x', 1, 'thb')$$, '42501', 'the browser cannot confirm a payment');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select * from public.payment_attempts where kind = 'credit_topup'$$, 3, 'the till reads the attempts of its shop (to poll the status)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.payment_attempts set status = 'succeeded' where id = (select v::uuid from t_out where k='att3')$$, '42501', 'but cannot write them');
select t_err(null, 'service_role', $$insert into public.payment_attempts (org_id, store_id, order_id, customer_id, kind, device_id, tender, amount, snapshot) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='cid'), 'credit_topup', (select v::uuid from t_out where k='dev'), 'promptpay', 100, '{}')$$, '23514', 'an attempt is either a bill or a top-up, never both');
\echo ALL ONLINE TOP-UP TESTS PASSED
