-- Billing an appointment and deposits: bill from an appointment, deposits applied as already-paid shares, no-show / refund, the drawer.
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





create or replace function t_leg_cash(id text, amount bigint, tendered bigint) returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'tender', 'cash', 'amount', amount, 'tendered', tendered, 'change', tendered - amount) $$;
grant execute on function t_leg_cash(text, bigint, bigint) to authenticated, service_role;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'manager@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test'),
  ('00000000-0000-0000-0000-0000000000c9', 'waiter@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Salon Co','Salon','salon')$$, 1, 'owner creates a salon');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('00000000-0000-0000-0000-0000000000b2'::uuid, 'Manager', 'manager'),
               ('00000000-0000-0000-0000-0000000000d4'::uuid, 'Cashier', 'cashier'),
               ('00000000-0000-0000-0000-0000000000c9'::uuid, 'Waiter', 'waiter')) as u(id, n, b) on true
  join public.roles r on r.org_id = o.id and r.built_in = u.b
 where o.name = 'Salon Co';
update public.legal_entities set tax_id = '0105560123456' where name = 'Salon Co';
update public.stores set vat_registered = true, vat_bps = 700, branch_code = '00001' where name = 'Salon';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Salon Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Salon'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Counter', 'cashier', 'POS-77') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cashier_staff', $$select id::text from public.staff where display_name = 'Cashier'$$);
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'nok', $$insert into public.resources (org_id, store_id, name, kind) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Nok', 'stylist') returning id::text$$);
select t_val(null, 'service_role', 'cat', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"บริการ"}') returning id::text$$);
select t_val(null, 'service_role', 'svc', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, duration_min) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"นวดน้ำมัน","en":"Oil massage"}', '{"base": 100000}', 90) returning id::text$$);
create or replace function t_book(start_ text, guest text default 'Anna') returns jsonb language sql as $$
  select jsonb_build_object('store_id', (select v from t_out where k='store'), 'provider_id', (select v from t_out where k='nok'),
    'service_id', (select v from t_out where k='svc'), 'starts_at', start_, 'guest_name', guest)
$$;
grant execute on function t_book(text, text) to authenticated, service_role;
create or replace function t_dep(appt text, amount bigint, method text, dev text default null) returns jsonb language sql as $$
  select jsonb_build_object('appointment_id', (select v from t_out where k=appt), 'amount', amount, 'method', method,
    'device_id', case when dev is null then null else (select v from t_out where k=dev) end)
$$;
grant execute on function t_dep(text, bigint, text, text) to authenticated, service_role;

select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'a1', $$select public.book_appointment(t_book('2030-01-15T10:00:00+07:00'))::text$$);
-- the drawer: a shift is open on the counter
select t_rows(null, 'service_role', $$insert into public.shifts (org_id, store_id, device_id, opened_at, opening_cash) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='dev'), now() - interval '1 hour', 5000)$$, 1, 'a shift is open with 50.00 in the drawer');

-- ── deposits ──
select t_err('00000000-0000-0000-0000-0000000000c9', 'authenticated', $$select public.record_appointment_deposit(t_dep('a1', 30000, 'cash', 'dev'))$$, '42501', 'a waiter (no payment.take) cannot take a deposit');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.record_appointment_deposit(t_dep('a1', 30000, 'cash', 'dev'))$$, '42501', 'nor another business');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.record_appointment_deposit(t_dep('a1', 100001, 'cash', 'dev'))$$, '22023', 'a deposit cannot be more than the price (1,000.01 > 1,000.00)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.record_appointment_deposit(t_dep('a1', 30000, 'cash'))$$, '22023', 'a cash deposit needs the till it went into');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.record_appointment_deposit(t_dep('a1', 30000, 'bitcoin'))$$, '22023', 'only cash, PromptPay or card');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.record_appointment_deposit(t_dep('a1', 0, 'cash', 'dev'))$$, '22023', 'a deposit is above zero');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'dep1', $$select public.record_appointment_deposit(t_dep('a1', 30000, 'cash', 'dev'))::text$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.record_appointment_deposit(t_dep('a1', 80000, 'promptpay'))$$, '22023', 'all deposits together stay within the price (300 + 800 > 1,000)');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.appointment_deposits where id = (select v::uuid from t_out where k='dep1') and status = 'held' and method = 'cash'$$, 1, 'the 300.00 cash deposit is held');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.appointment_deposits$$, 0, 'another business sees no deposits');

-- ── the bill ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.appointment_to_order(jsonb_build_object('appointment_id', (select v from t_out where k='a1')))$$, '55000', 'a booking that has not arrived cannot be billed');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_status((select v::uuid from t_out where k='a1'), 'arrived')$$, 1, 'the guest arrives');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.appointment_to_order(jsonb_build_object('appointment_id', (select v from t_out where k='a1')))$$, '42501', 'another business cannot bill it');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'o1', $$select public.appointment_to_order(jsonb_build_object('appointment_id', (select v from t_out where k='a1'), 'device_id', (select v from t_out where k='dev')))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.orders where id = (select v::uuid from t_out where k='o1') and number = 'AP001' and status = 'open' and channel = 'takeaway' and device_id = (select v::uuid from t_out where k='dev')$$, 1, 'the bill is AP001, open, a takeaway bill on the counter');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where order_id = (select v::uuid from t_out where k='o1') and unit_price = 100000 and quantity = 1 and status = 'sent' and name ->> 'th' = 'นวดน้ำมัน'$$, 1, 'with the service as its one line at the booked price');
select t_rows(null, 'service_role', $$select 1 from public.order_partial_payments where order_id = (select v::uuid from t_out where k='o1') and kind = 'deposit' and tender = 'cash' and amount = 30000 and status = 'held'$$, 1, 'the deposit is on the bill as an already-paid share');
select t_rows(null, 'service_role', $$select 1 from public.appointment_deposits where id = (select v::uuid from t_out where k='dep1') and status = 'on_bill' and order_id = (select v::uuid from t_out where k='o1')$$, 1, 'and the deposit says it is on that bill');
select t_rows(null, 'service_role', $$select 1 from public.appointments where id = (select v::uuid from t_out where k='a1') and order_id = (select v::uuid from t_out where k='o1')$$, 1, 'the appointment points at its bill');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'o1b', $$select public.appointment_to_order(jsonb_build_object('appointment_id', (select v from t_out where k='a1')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='o1b' and v = (select v from t_out where k='o1')$$, 1, 'asking again gives the same bill, not a second one');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.orders where number like 'AP%') = 1$$, 1, 'one bill exists');

-- a deposit does not lock the bill: the guest may still add a product; giving up releases nothing (a deposit is settled on the appointment)
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='o1'), '{"th":"แชมพู"}', 5000, 1)$$, 1, 'a product can still be added to the bill (a deposit does not lock it)');
select t_rows(null, 'service_role', $$delete from public.order_lines where order_id = (select v::uuid from t_out where k='o1') and unit_price = 5000$$, 1, 'and removed again');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'rel', $$select public.release_partial_payments((select v::uuid from t_out where k='o1'), 'x')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='rel' and v = '0'$$, 1, 'giving up the bill releases no deposit');
select t_rows(null, 'service_role', $$select 1 from public.order_partial_payments where order_id = (select v::uuid from t_out where k='o1') and status = 'held'$$, 1, 'the deposit is still held');

-- ── pay the rest: 700.00 cash; the deposit joins the receipt ──
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(jsonb_build_object('order_id', (select v from t_out where k='o1'), 'device_id', (select v from t_out where k='dev'), 'staff_id', (select v from t_out where k='cashier_staff'), 'issued_at', now(), 'lang', 'en', 'subtotal', 100000, 'service_charge', 0, 'vat', 6542, 'net_before_vat', 93458, 'total', 100000, 'rounding', 0, 'payable', 100000, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive', 'payments', jsonb_build_array(t_leg_cash('73000000-0000-4000-8000-000000000001', 70000, 70000))))$$, 1, 'the bill is paid: 700.00 cash + the 300.00 deposit');
select t_rows(null, 'service_role', $$select 1 from public.payments where order_id = (select v::uuid from t_out where k='o1') and status = 'confirmed' having sum(amount) = 100000 and count(*) = 2$$, 1, 'two payments add up to the whole bill');
select t_rows(null, 'service_role', $$select 1 from public.payments where order_id = (select v::uuid from t_out where k='o1') and tender = 'cash' and amount = 30000 and reference = 'deposit:' || (select v from t_out where k='dep1')$$, 1, 'the deposit is a payment of its own method that names the deposit');
select t_rows(null, 'service_role', $$select 1 from public.order_partial_payments where order_id = (select v::uuid from t_out where k='o1') and status = 'applied'$$, 1, 'the deposit share is applied');
select t_rows(null, 'service_role', $$select 1 from public.appointments where id = (select v::uuid from t_out where k='a1') and status = 'done'$$, 1, 'paying the bill finishes the appointment');
select t_rows(null, 'service_role', $$select 1 from public.receipts where order_id = (select v::uuid from t_out where k='o1') and payable = 100000$$, 1, 'one receipt for the whole 1,000.00');

-- ── the drawer: 50.00 opening + 300.00 deposit taken + 700.00 cash sale = 1,050.00 (the deposit is not counted twice) ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'sh1', $$select id::text from public.shifts where status = 'open' and device_id = (select v::uuid from t_out where k='dev')$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'close1', $$select public.close_shift(jsonb_build_object('id', (select v from t_out where k='sh1'), 'closed_at', now(), 'counted_cash', 105000, 'staff_id', (select v from t_out where k='cashier_staff')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='close1' and (v::jsonb ->> 'expected_cash')::bigint = 105000 and (v::jsonb ->> 'variance')::bigint = 0$$, 1, 'expected cash 1,050.00, variance 0: the cash deposit is counted once');

-- ── no-show: a deposit is kept (a fee) or refunded ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'a2', $$select public.book_appointment(t_book('2030-01-15T14:00:00+07:00', 'Ben'))::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'dep2', $$select public.record_appointment_deposit(t_dep('a2', 20000, 'promptpay'))::text$$);
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.resolve_deposit(jsonb_build_object('deposit_id', (select v from t_out where k='dep2'), 'action', 'forfeit'))$$, '55000', 'a deposit is settled only after a cancellation or no-show');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_status((select v::uuid from t_out where k='a2'), 'no_show')$$, 1, 'Ben does not come');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.resolve_deposit(jsonb_build_object('deposit_id', (select v from t_out where k='dep2'), 'action', 'forfeit'))$$, '42501', 'a cashier cannot settle it (refund.create)');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.resolve_deposit(jsonb_build_object('deposit_id', (select v from t_out where k='dep2'), 'action', 'give-away'))$$, '22023', 'only keep or refund');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'r2', $$select public.resolve_deposit(jsonb_build_object('deposit_id', (select v from t_out where k='dep2'), 'action', 'forfeit'))$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r2' and v = 'forfeited'$$, 1, 'the manager keeps the 200.00 as a no-show fee');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.resolve_deposit(jsonb_build_object('deposit_id', (select v from t_out where k='dep2'), 'action', 'refund'))$$, '55000', 'a settled deposit stays settled');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.record_appointment_deposit(t_dep('a2', 1000, 'promptpay'))$$, '55000', 'and no deposit is taken for a no-show');

-- a cancelled booking: the cash deposit goes back out of the drawer
select t_rows(null, 'service_role', $$insert into public.shifts (org_id, store_id, device_id, opened_at, opening_cash) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='dev'), now(), 2000)$$, 1, 'a second shift opens with 20.00');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'a3', $$select public.book_appointment(t_book('2030-01-15T16:00:00+07:00', 'Cara'))::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'dep3', $$select public.record_appointment_deposit(t_dep('a3', 10000, 'cash', 'dev'))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_status((select v::uuid from t_out where k='a3'), 'cancelled')$$, 1, 'Cara cancels in time');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.resolve_deposit(jsonb_build_object('deposit_id', (select v from t_out where k='dep3'), 'action', 'refund'))$$, '22023', 'a cash refund needs the till it comes out of');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'r3', $$select public.resolve_deposit(jsonb_build_object('deposit_id', (select v from t_out where k='dep3'), 'action', 'refund', 'device_id', (select v from t_out where k='dev')))$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r3' and v = 'refunded'$$, 1, 'the manager refunds the 100.00');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'sh2', $$select id::text from public.shifts where status = 'open' and device_id = (select v::uuid from t_out where k='dev')$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'close2', $$select public.close_shift(jsonb_build_object('id', (select v from t_out where k='sh2'), 'closed_at', now(), 'counted_cash', 2000, 'staff_id', (select v from t_out where k='cashier_staff')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='close2' and (v::jsonb ->> 'expected_cash')::bigint = 2000 and (v::jsonb ->> 'variance')::bigint = 0$$, 1, 'the drawer: 20.00 + 100.00 in − 100.00 out = 20.00');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'payment.refund' and entity_id = (select v from t_out where k='a3')$$, 1, 'the refund is in the audit trail');
select t_rows(null, 'service_role', $$select 1 where public.deposits_enabled((select v::uuid from t_out where k='store'))$$, 1, 'deposits are on for a salon by default');

-- ── migration 65: documents for a deposit and for a kept no-show fee (owner rules D) ──
select t_rows(null, 'service_role', $$select 1 from public.appointment_deposits d where d.id = (select v::uuid from t_out where k='dep1') and d.invoice_no = 'DP-000001' and d.invoice_vat = 1963$$, 1, 'the 300.00 deposit has its own number and the VAT inside it (7 % of 300.00 incl. = 19.63)');
select t_rows(null, 'service_role', $$select 1 from public.appointment_deposits d where d.id = (select v::uuid from t_out where k='dep2') and d.invoice_no = 'DP-000002' and d.fee_invoice_no = 'NF-000001' and d.fee_vat = 1308$$, 1, 'the kept 200.00 no-show fee has VAT (13.08) and its own number');
select t_rows(null, 'service_role', $$select 1 from public.appointment_deposits d where d.id = (select v::uuid from t_out where k='dep3') and d.fee_invoice_no is null$$, 1, 'a refunded deposit makes no fee document');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_service_policy((select v::uuid from t_out where k='store'), '{"commission_base":"net"}'::jsonb)$$, '42501', 'a manager cannot change the accounting policy');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_service_policy((select v::uuid from t_out where k='store'), '{"commission_base":"gross"}'::jsonb)$$, '22023', 'an unknown choice is refused');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_service_policy((select v::uuid from t_out where k='store'), '{"noshow_fee_vat":false,"deposit_invoice":false}'::jsonb)$$, 1, 'the owner switches the fee VAT and the deposit document off');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'a9', $$select public.book_appointment(t_book('2030-01-15T18:00:00+07:00', 'Dee'))::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'dep9', $$select public.record_appointment_deposit(t_dep('a9', 5000, 'promptpay'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.appointment_deposits d where d.id = (select v::uuid from t_out where k='dep9') and d.invoice_no is null and d.invoice_vat is null$$, 1, 'with the document switched off the deposit has no number');
select t_rows(null, 'service_role', $$select 1 where (public.service_policy((select v::uuid from t_out where k='store')) ->> 'commission_base') = 'net' and (public.service_policy((select v::uuid from t_out where k='store')) ->> 'package_revenue') = 'deferred'$$, 1, 'the other choices keep the owner''s defaults');
do $$ begin raise notice 'ALL APPOINTMENT BILLING TESTS PASSED'; end $$;
