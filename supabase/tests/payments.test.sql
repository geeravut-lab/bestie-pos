-- Closing a bill: close_order() checks, receipts snapshot, idempotent replay, history is frozen.
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

-- ── refusals ──
select t_err('00000000-0000-0000-0000-0000000000c9', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000001', 'A-000001', 21000))$$, '42501', 'a waiter (no payment.take) cannot close a bill');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000001', 'A-000001', 21000))$$, '42501', 'another org cannot close it');
select t_err(null, 'anon', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000001', 'A-000001', 21000))$$, '42501', 'anon cannot call close_order');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000001', 'A-000001', 21000, 21000, 21000, 20000))$$, '23514', 'a subtotal that is not the lines is refused (the bill changed)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000001', 'A-000001', 20000))$$, '23514', 'cash handed over below the amount is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000001', 'A-000001', 21000, 20000))$$, '23514', 'payments that do not cover the amount due are refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000001', 'A-000001', 21000, 21000, 21000, 21000, 0, 'promptpay'))$$, '23514', 'the till cannot declare PromptPay paid by itself');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000001', 'B-000001', 21000))$$, '23514', 'a receipt number from another device series is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000001', 'bad', 21000))$$, '23514', 'a malformed receipt number is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000001', 'A-000001', 21200, 21000, 21000, 21000, 150))$$, '23514', 'a rounding of more than one baht is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-0000000000ff', 'A-000001', 21000))$$, 'P0002', 'an unknown order is refused');
select t_rows(null, 'service_role', $$select 1 from public.orders where status = 'open'$$, 2, 'nothing was closed by the refused attempts');

-- ── a good cash payment with change ──
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000001', 'A-000001', 50000))$$, 1, 'the cashier closes the bill: 210.00 paid with 500.00');
select t_rows(null, 'service_role', $$select 1 from public.orders where id = '10000000-0000-4000-8000-000000000001' and status = 'paid' and closed_at is not null$$, 1, 'the order is paid');
select t_rows(null, 'service_role', $$select 1 from public.payments where order_id = '10000000-0000-4000-8000-000000000001' and tender = 'cash' and amount = 21000 and tendered = 50000 and change = 29000 and status = 'confirmed'$$, 1, 'the payment records amount, cash handed over and change');
select t_rows(null, 'service_role', $$select 1 from public.receipts where number = 'A-000001' and seller_name = 'Acme Co' and seller_tax_id = '0105560123456' and branch_code = '00001' and pos_id = 'POS-77' and vat_registered and total = 21000 and vat = 1374$$, 1, 'the receipt snapshots the seller, tax id, branch and POS ID from the server');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'payment.tender' and detail = '{"tender":"cash","amount":21000}'$$, 1, 'the payment was audited');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000001', 'A-000001', 50000))$$, 1, 'the same close arriving again (lost answer) is a harmless no-op');
select t_rows(null, 'service_role', $$select 1 from public.payments where order_id = '10000000-0000-4000-8000-000000000001'$$, 1, 'no second payment was written');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000001', 'A-000002', 21000))$$, '23514', 'a DIFFERENT close of an already closed bill is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000002', 'A-000001', 3000, 3000, 3000, 3000))$$, '23505', 'a receipt number cannot be used twice in a shop');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.receipts$$, 1, 'a cashier can read the receipts of their shop');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.receipts$$, 0, 'another org sees none');

-- ── cash rounded to the baht: total 29.90 + 0.10 rounding = 30.00 ──
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order(t_payload('10000000-0000-4000-8000-000000000002', 'A-000002', 5000, 3000, 2990, 3000, 10))$$, 1, 'a rounded cash payment closes the bill');
select t_rows(null, 'service_role', $$select 1 from public.receipts where number = 'A-000002' and total = 2990 and rounding = 10 and payable = 3000$$, 1, 'the rounding is its own line on the receipt');

-- ── history is frozen ──
select t_err(null, 'service_role', $$update public.receipts set total = 1$$, '23514', 'a receipt cannot be edited, even by the server role');
select t_err(null, 'service_role', $$delete from public.receipts$$, '23514', 'a receipt cannot be deleted');
select t_err(null, 'service_role', $$delete from public.payments$$, '23514', 'a payment cannot be deleted');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.payments (org_id, store_id, order_id, tender, amount) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', 'cash', 100)$$, '42501', 'the browser cannot write payments directly');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.receipts (org_id, store_id, order_id, number, issued_at, seller_name, branch_code, vat_registered, vat_bps, service_bps, price_mode, subtotal, service_charge, vat, net_before_vat, total, payable) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', 'A-000009', now(), 'x', '00000', false, 0, 0, 'inclusive', 0, 0, 0, 0, 0, 0)$$, '42501', 'the browser cannot write receipts directly');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.orders set note = 'late' where id = '10000000-0000-4000-8000-000000000001'$$, '23514', 'a paid order cannot be edited afterwards');
select t_err(null, 'anon', $$select * from public.payments$$, '42501', 'anon cannot read payments');
\echo ALL PAYMENT TESTS PASSED
