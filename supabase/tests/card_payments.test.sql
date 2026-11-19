-- Online payments: attempts, provider confirmation, review cases, server-numbered receipts, internal functions locked.
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
update public.stores set vat_registered = true, vat_bps = 700 where name = 'Acme';

select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Acme Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id, stripe_reader_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Counter', 'cashier', 'POS-77', 'tmr_ABC123xyz') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev2', $$insert into public.devices (org_id, store_id, name, role) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'No reader', 'staff') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cashier_staff', $$select id::text from public.staff where display_name = 'Cashier'$$);
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.devices set stripe_reader_id = 'not a reader' where name = 'Counter'$$, '23514', 'a malformed reader id is refused');

-- card payments are an owner's choice per shop (tender.gateway has no default-on profile)
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(jsonb_build_object('order_id', '10000000-0000-4000-8000-000000000001', 'tender', 'gateway'))$$, 'P0002', 'an unknown bill is not found (before any switch is read)');
update public.stores set module_overrides = '{"tender.gateway": true}' where id = (select v::uuid from t_out where k='store');

-- three bills of 210.00 / 30.00 / 30.00
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values
  ('10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A001', (now() at time zone 'Asia/Bangkok')::date, 'takeaway'),
  ('10000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A002', (now() at time zone 'Asia/Bangkok')::date, 'takeaway'),
  ('10000000-0000-4000-8000-000000000003', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A003', (now() at time zone 'Asia/Bangkok')::date, 'takeaway')$$, 3, 'three orders');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity) values
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', '{"th":"ผัดไทย"}', 9000, 2),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', '{"th":"ชา"}', 3000, 1),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', '{"th":"ชา"}', 3000, 1),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000003', '{"th":"ชา"}', 3000, 1)$$, 4, 'lines');

create or replace function t_begin(p_order text, p_tender text default 'promptpay', p_amount bigint default 21000, p_sub bigint default 21000, p_rounding int default 0, p_device text default null) returns jsonb language sql as $$
  select jsonb_build_object(
    'order_id', p_order, 'device_id', coalesce(p_device, (select v from t_out where k='dev')),
    'staff_id', (select v from t_out where k='cashier_staff'), 'tender', p_tender, 'lang', 'th',
    'subtotal', p_sub, 'service_charge', 0, 'vat', 1374, 'net_before_vat', 19626, 'total', p_amount, 'rounding', p_rounding,
    'payable', p_amount + p_rounding, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive');
$$;
grant execute on function t_begin(text, text, bigint, bigint, int, text) to authenticated, service_role;
create or replace function t_bill_amount(p_order text) returns bigint language sql as $$ select sum(unit_price::bigint * quantity) from public.order_lines where order_id = p_order::uuid and status <> 'void' $$;

-- ── asking for a payment ──
select t_err('00000000-0000-0000-0000-0000000000c9', 'authenticated', $$select public.begin_payment_attempt(t_begin('10000000-0000-4000-8000-000000000001'))$$, '42501', 'a waiter cannot ask for a payment');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.begin_payment_attempt(t_begin('10000000-0000-4000-8000-000000000001'))$$, '42501', 'another org cannot');
select t_err(null, 'anon', $$select public.begin_payment_attempt(t_begin('10000000-0000-4000-8000-000000000001'))$$, '42501', 'anon cannot');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_begin('10000000-0000-4000-8000-000000000001', 'promptpay', 21000, 20000))$$, '23514', 'a subtotal that is not the lines is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_begin('10000000-0000-4000-8000-000000000001', 'promptpay', 21000, 21000, 10))$$, '23514', 'cash rounding does not apply to a digital payment');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_begin('10000000-0000-4000-8000-000000000001', 'bitcoin'))$$, '22023', 'an unknown tender is refused (crypto is never a tender)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_begin('10000000-0000-4000-8000-000000000001', 'gateway', 21000, 21000, 0, (select v from t_out where k='dev2')))$$, '23514', 'a card payment needs a device with a card reader');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_begin('10000000-0000-4000-8000-000000000001') - 'vat')$$, '23514', 'an incomplete snapshot is refused now, not after the guest has paid');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_begin('10000000-0000-4000-8000-0000000000ff'))$$, 'P0002', 'an unknown order is refused');

select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'att1', $$select public.begin_payment_attempt(t_begin('10000000-0000-4000-8000-000000000001'))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.payment_attempts where status = 'created' and amount = 21000 and tender = 'promptpay'$$, 1, 'an attempt was created for 210.00');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_begin('10000000-0000-4000-8000-000000000001', 'gateway'))$$, '23505', 'a second live attempt for the same bill is refused');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.payment_attempts$$, 0, 'another org cannot see attempts');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.payment_attempts (org_id, store_id, order_id, device_id, tender, amount, snapshot) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='dev'), 'promptpay', 1, '{}')$$, '42501', 'the browser cannot write attempts directly');

-- the provider-side functions cannot be called from the browser at all
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='att1'), 'pi_1', 21000, 'thb')$$, '42501', 'a cashier cannot confirm a payment');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='att1'), 'pi_1', 21000, 'thb')$$, '42501', 'not even the owner can confirm a payment from the browser');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.attach_payment_intent((select v::uuid from t_out where k='att1'), 'pi_1', 'x', null)$$, '42501', 'attach is server only');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.record_stripe_event('evt_1', 'x')$$, '42501', 'recording provider events is server only');
select t_err(null, 'anon', $$select public.confirm_payment_attempt(gen_random_uuid(), 'pi_1', 1, 'thb')$$, '42501', 'anon cannot confirm');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.finalize_order_payment(gen_random_uuid(), gen_random_uuid(), null, 'A-000001', now(), '{}', '[]')$$, '42501', 'the internal closing function is not callable');

-- ── give up, then ask again ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cancel1', $$select public.cancel_payment_attempt((select v::uuid from t_out where k='att1'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.payment_attempts where id = (select v::uuid from t_out where k='att1') and status = 'canceled'$$, 1, 'cancelling marks the attempt canceled');
select t_err('00000000-0000-0000-0000-0000000000c9', 'authenticated', $$select public.cancel_payment_attempt((select v::uuid from t_out where k='att1'))$$, '42501', 'a waiter cannot cancel');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'att2', $$select public.begin_payment_attempt(t_begin('10000000-0000-4000-8000-000000000001'))::text$$);
select t_rows(null, 'service_role', $$select public.attach_payment_intent((select v::uuid from t_out where k='att2'), 'pi_good', 'https://qr.example/1.png', now() + interval '1 hour')$$, 1, 'the server attaches the provider reference');
select t_rows(null, 'service_role', $$select 1 from public.payment_attempts where id = (select v::uuid from t_out where k='att2') and status = 'pending' and provider_ref = 'pi_good' and qr_url is not null$$, 1, 'the attempt is pending with its QR');

-- ── confirmation: wrong things go to review, nothing closes ──
select t_val(null, 'service_role', 'r1', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='att2'), 'pi_good', 20000, 'thb')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r1' and v='needs_review'$$, 1, 'the wrong amount is parked for a person');
select t_rows(null, 'service_role', $$select 1 from public.orders where id = '10000000-0000-4000-8000-000000000001' and status = 'open'$$, 1, 'the bill stayed open');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'payment.tender' and detail ->> 'review' = 'true'$$, 1, 'the review case was audited');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'att3', $$select public.begin_payment_attempt(t_begin('10000000-0000-4000-8000-000000000001'))::text$$);
select t_rows(null, 'service_role', $$select public.attach_payment_intent((select v::uuid from t_out where k='att3'), 'pi_usd', null, null)$$, 1, 'attach');
select t_val(null, 'service_role', 'r2', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='att3'), 'pi_usd', 21000, 'usd')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r2' and v='needs_review'$$, 1, 'a payment in another currency is parked');
select t_rows(null, 'service_role', $$select 1 from public.payment_attempts where id = (select v::uuid from t_out where k='att3') and status = 'needs_review' and error = 'currency differs'$$, 1, 'with the reason on the attempt');

-- ── the good confirmation ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'att4', $$select public.begin_payment_attempt(t_begin('10000000-0000-4000-8000-000000000001'))::text$$);
select t_rows(null, 'service_role', $$select public.attach_payment_intent((select v::uuid from t_out where k='att4'), 'pi_ok', 'https://qr.example/2.png', now() + interval '1 hour')$$, 1, 'attach');
select t_val(null, 'service_role', 'r3', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='att4'), 'pi_ok', 21000, 'THB')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r3' and v='paid'$$, 1, 'the provider confirmation closes the bill');
select t_rows(null, 'service_role', $$select 1 from public.orders where id = '10000000-0000-4000-8000-000000000001' and status = 'paid'$$, 1, 'the order is paid');
select t_rows(null, 'service_role', $$select 1 from public.receipts where order_id = '10000000-0000-4000-8000-000000000001' and number = 'A+000001' and pos_id = 'POS-77' and seller_tax_id = '0105560123456' and payable = 21000$$, 1, 'the server numbered the receipt in the + series (failed attempts left no gap)');
select t_rows(null, 'service_role', $$select 1 from public.payments where order_id = '10000000-0000-4000-8000-000000000001' and tender = 'promptpay' and reference = 'pi_ok' and amount = 21000 and tendered is null and change = 0$$, 1, 'the payment keeps the provider reference and no card data');
select t_val(null, 'service_role', 'r4', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='att4'), 'pi_ok', 21000, 'thb')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r4' and v='already'$$, 1, 'the same webhook delivered twice is harmless');
select t_rows(null, 'service_role', $$select 1 from public.payments where order_id = '10000000-0000-4000-8000-000000000001'$$, 1, 'still one payment');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(jsonb_build_object('order_id', '10000000-0000-4000-8000-000000000002', 'receipt_number', 'A+000002', 'device_id', (select v from t_out where k='dev'), 'issued_at', now(), 'subtotal', 3000, 'total', 3000, 'rounding', 0, 'payable', 3000, 'service_charge', 0, 'vat', 0, 'net_before_vat', 3000, 'vat_bps', 0, 'service_bps', 0, 'price_mode', 'inclusive', 'payments', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'tender', 'cash', 'amount', 3000, 'tendered', 3000, 'change', 0))))$$, '23514', 'the till cannot use the server''s + series for cash');

-- ── a card reader payment of another bill: consecutive number, tender gateway ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'att5', $$select public.begin_payment_attempt(t_begin('10000000-0000-4000-8000-000000000002', 'gateway', 3000, 3000))::text$$);
select t_rows(null, 'service_role', $$select public.attach_payment_intent((select v::uuid from t_out where k='att5'), 'pi_card', null, null)$$, 1, 'attach');
select t_val(null, 'service_role', 'r5', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='att5'), 'pi_card', 3000, 'thb')$$);
select t_rows(null, 'service_role', $$select 1 from public.receipts where number = 'A+000002' and payable = 3000$$, 1, 'the next server number is A+000002');
select t_rows(null, 'service_role', $$select 1 from public.payments where tender = 'gateway' and reference = 'pi_card'$$, 1, 'a card reader payment is a gateway payment');

-- ── confirmation after the bill changed / was closed meanwhile ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'att6', $$select public.begin_payment_attempt(t_begin('10000000-0000-4000-8000-000000000003', 'promptpay', 3000, 3000))::text$$);
select t_rows(null, 'service_role', $$select public.attach_payment_intent((select v::uuid from t_out where k='att6'), 'pi_late', 'x', null)$$, 1, 'attach');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000003', '{"th":"เพิ่ม"}', 1000, 1)$$, 1, 'someone adds a line while the guest is paying');
select t_val(null, 'service_role', 'r6', $$select public.confirm_payment_attempt((select v::uuid from t_out where k='att6'), 'pi_late', 3000, 'thb')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r6' and v='needs_review'$$, 1, 'a changed bill is parked, not closed at the old amount');
select t_rows(null, 'service_role', $$select 1 from public.payment_attempts where id = (select v::uuid from t_out where k='att6') and error = 'bill changed'$$, 1, 'with the reason');

-- ── events seen once ──
select t_val(null, 'service_role', 'e1', $$select public.record_stripe_event('evt_100', 'payment_intent.succeeded')::text$$);
select t_val(null, 'service_role', 'e2', $$select public.record_stripe_event('evt_100', 'payment_intent.succeeded')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='e1' and v='true'$$, 1, 'the first delivery of an event is new');
select t_rows(null, 'service_role', $$select 1 from t_out where k='e2' and v='false'$$, 1, 'the second is a repeat');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.stripe_events$$, '42501', 'the event table is invisible to the browser');

-- the owner can switch a payment method off: no new attempt of that kind
update public.stores set module_overrides = '{"tender.gateway": true, "tender.promptpay": false}' where id = (select v::uuid from t_out where k='store');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.begin_payment_attempt(t_begin('10000000-0000-4000-8000-000000000003'))$$, '0A000', 'PromptPay switched off in the shop: refused');
-- the gateway adapter records which provider started an attempt
select t_rows(null, 'service_role', $$select public.attach_payment_intent((select v::uuid from t_out where k='att4'), 'pi_ok', 'https://qr.example/2.png', now() + interval '1 hour', 'acme')$$, 1, 'attach with a provider name');
select t_rows(null, 'service_role', $$select 1 from public.payment_attempts where id = (select v::uuid from t_out where k='att4') and provider = 'acme'$$, 1, 'the provider is stored on the attempt');
select t_err(null, 'service_role', $$select public.attach_payment_intent((select v::uuid from t_out where k='att4'), 'pi_ok', null, null, 'Bad Name!')$$, '22023', 'a malformed provider name is refused');
select t_rows(null, 'service_role', $$select 1 from public.payment_attempts where id = (select v::uuid from t_out where k='att1') and provider = 'stripe'$$, 1, 'older attempts and calls without a provider keep stripe');
\echo ALL CARD PAYMENT TESTS PASSED
