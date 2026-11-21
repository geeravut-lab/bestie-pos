-- Spa / yoga advisor: the gate (module + therapist sign-off), tagging services, what the guest page may read.
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
  ('00000000-0000-0000-0000-0000000000d4', 'poolbar@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Resort Co','Palm Resort','resort')$$, 1, 'the owner creates a resort');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other Co','Other','cafe')$$, 1, 'another business exists');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Resort Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'resort', $$select id::text from public.stores where name = 'Palm Resort'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'bar', $$select public.create_store((select v::uuid from t_out where k='org'), 'Pool Bar', 'cafe')::text$$);
-- the pool bar cashier works in the BAR only
insert into public.staff (org_id, store_id, user_id, display_name, role_id)
select o.id, (select v::uuid from t_out where k='bar'), '00000000-0000-0000-0000-0000000000d4', 'Bar cashier', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Resort Co';
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cashier_staff', $$select id::text from public.staff where display_name = 'Bar cashier'$$);
update public.legal_entities set tax_id = '0105560123456' where name = 'Resort Co';
update public.stores set vat_registered = true, vat_bps = 700, branch_code = '00001' where org_id = (select v::uuid from t_out where k='org');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'bar_dev', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='bar'), 'Bar till', 'cashier', 'POS-BAR') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'desk_dev', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='resort'), 'Front desk', 'cashier', 'POS-FD') returning id::text$$);

-- ── the module: plan Resort only ──
select t_rows(null, 'service_role', $$select 1 where not public.folio_enabled((select v::uuid from t_out where k='resort'))$$, 1, 'a resort-profile shop on the default plan does not have the folio yet');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_folio_room(jsonb_build_object('store_id', (select v from t_out where k='resort'), 'name', '101'))$$, '0A000', 'so rooms cannot be made');
update public.stores set plan = 'resort' where id = (select v::uuid from t_out where k='resort');
select t_rows(null, 'service_role', $$select 1 where public.folio_enabled((select v::uuid from t_out where k='resort')) and not public.folio_enabled((select v::uuid from t_out where k='bar'))$$, 1, 'on the Resort plan the resort profile has it, the cafe does not');

-- ── rooms and check-in ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_folio_room(jsonb_build_object('store_id', (select v from t_out where k='resort'), 'name', '101'))$$, '42501', 'the bar cashier cannot make rooms');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'room1', $$select public.save_folio_room(jsonb_build_object('store_id', (select v from t_out where k='resort'), 'name', '101'))::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'room2', $$select public.save_folio_room(jsonb_build_object('store_id', (select v from t_out where k='resort'), 'name', '102'))::text$$);
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_folio_room(jsonb_build_object('store_id', (select v from t_out where k='resort'), 'name', '101'))$$, '23505', 'a room name is used once');
create or replace function t_in(room text, who text) returns text language sql as $$
  select jsonb_build_object('store_id', (select v from t_out where k='resort'), 'room_id', (select v from t_out where k=room), 'guest_name', who, 'phone', '0811111111')::text $$;
grant execute on function t_in(text, text) to authenticated, service_role;
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.folio_check_in(t_in('room1', 'Anna')::jsonb)$$, '42501', 'the bar cashier cannot check guests in');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'f1', $$select public.folio_check_in(t_in('room1', 'Anna')::jsonb)::text$$);
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.folio_check_in(t_in('room1', 'Bob')::jsonb)$$, '55000', 'a room with a guest cannot be let again');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.folios where status = 'open'$$, 1, 'the bar cashier sees the open stays (to charge to them)');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.folios$$, 0, 'another business sees none');

-- ── an open bill at the pool bar: 210.00 (VAT 7 % included = 13.74) ──
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values ('10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='bar'), 'A001', (now() at time zone 'Asia/Bangkok')::date, 'takeaway')$$, 1, 'an open bill at the pool bar');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='bar'), '10000000-0000-4000-8000-000000000001', '{"th":"ค็อกเทล"}', 21000, 1)$$, 1, 'one line of 210.00');
update public.order_lines set status = 'sent', sent_at = now();
create or replace function t_charge(p_order text, p_folio text, p_pay text default null, p_sub bigint default 21000, p_total bigint default 21000, p_round int default 0) returns jsonb language sql as $$
  select jsonb_build_object('order_id', p_order, 'folio_id', (select v from t_out where k=p_folio), 'payment_id', coalesce(p_pay, '60000000-0000-4000-8000-000000000001'),
    'device_id', (select v from t_out where k='bar_dev'), 'staff_id', (select v from t_out where k='cashier_staff'), 'issued_at', now(), 'lang', 'en',
    'subtotal', p_sub, 'service_charge', 0, 'vat', 1374, 'net_before_vat', 19626, 'total', p_total, 'rounding', p_round, 'payable', p_total + p_round,
    'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive') $$;
grant execute on function t_charge(text, text, text, bigint, bigint, int) to authenticated, service_role;

select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.charge_order_to_room(t_charge('10000000-0000-4000-8000-000000000001', 'f1'))$$, '42501', 'another business cannot charge this bill');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.charge_order_to_room(t_charge('10000000-0000-4000-8000-000000000001', 'f1', null, 20000, 20000))$$, '23514', 'a bill that is not what the till showed is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.charge_order_to_room(t_charge('10000000-0000-4000-8000-000000000001', 'f1', null, 21000, 21000, 5))$$, '23514', 'a room charge is exact: no rounding');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.charge_order_to_room(t_charge('10000000-0000-4000-8000-000000000001', 'room1'))$$, '55000', 'only an open stay can be charged (a room id is not a stay)');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'rc', $$select public.charge_order_to_room(t_charge('10000000-0000-4000-8000-000000000001', 'f1'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='rc' and (v::jsonb ->> 'receipt_number') ~ '^[A-Z]\+000001$' and (v::jsonb ->> 'replay') = 'false'$$, 1, 'the bill closes with a receipt in the server series');
select t_rows(null, 'service_role', $$select 1 from public.payments where order_id = '10000000-0000-4000-8000-000000000001' and tender = 'room' and amount = 21000 and status = 'confirmed'$$, 1, 'its one payment is the room tender');
select t_rows(null, 'service_role', $$select 1 from public.orders where id = '10000000-0000-4000-8000-000000000001' and status = 'paid'$$, 1, 'the bill is paid');
select t_rows(null, 'service_role', $$select 1 from public.receipts where order_id = '10000000-0000-4000-8000-000000000001' and payable = 21000 and vat = 1374$$, 1, 'the sale and its VAT are on the receipt');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.folio_balance((select v::uuid from t_out where k='f1')) = 21000$$, 1, 'the stay owes 210.00');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'rc2', $$select public.charge_order_to_room(t_charge('10000000-0000-4000-8000-000000000001', 'f1'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out a, t_out b where a.k='rc' and b.k='rc2' and (b.v::jsonb ->> 'replay') = 'true' and (a.v::jsonb ->> 'receipt_number') = (b.v::jsonb ->> 'receipt_number')$$, 1, 'the same request again returns the same receipt');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.folio_charges) = 1$$, 1, 'and no second charge');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.charge_order_to_room(t_charge('10000000-0000-4000-8000-000000000001', 'f1', '60000000-0000-4000-8000-000000000002'))$$, '23514', 'a closed bill cannot be charged again');

-- a second bill, then a manager takes it off
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values ('10000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='bar'), 'A002', (now() at time zone 'Asia/Bangkok')::date, 'takeaway')$$, 1, 'a second bill');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, status, sent_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='bar'), '10000000-0000-4000-8000-000000000002', '{"th":"เบียร์"}', 21000, 1, 'sent', now())$$, 1, 'its line');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'rc3', $$select public.charge_order_to_room(t_charge('10000000-0000-4000-8000-000000000002', 'f1', '60000000-0000-4000-8000-000000000003'))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.folio_balance((select v::uuid from t_out where k='f1')) = 42000$$, 1, 'two charges: 420.00');
select t_val(null, 'service_role', 'ch2', $$select id::text from public.folio_charges where order_id = '10000000-0000-4000-8000-000000000002'$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.folio_void_charge((select v::uuid from t_out where k='ch2'), 'wrong room')$$, '42501', 'a cashier cannot take a charge off');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.folio_void_charge((select v::uuid from t_out where k='ch2'), 'x')$$, '22023', 'a reason is needed');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.folio_void_charge((select v::uuid from t_out where k='ch2'), 'charged to the wrong room')$$, 1, 'the manager takes it off');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 where public.folio_balance((select v::uuid from t_out where k='f1')) = 21000$$, 1, 'the stay owes 210.00 again');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'payment.refund' and entity_id = (select v from t_out where k='ch2')$$, 1, 'taking a charge off is in the audit trail');

-- ── check-out ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.folio_settle(jsonb_build_object('folio_id', (select v from t_out where k='f1'), 'method', 'transfer'))$$, '42501', 'the bar cashier cannot check the guest out of the resort');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.folio_settle(jsonb_build_object('folio_id', (select v from t_out where k='f1'), 'method', 'cash'))$$, '22023', 'cash needs a till of the resort shop');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.folio_settle(jsonb_build_object('folio_id', (select v from t_out where k='f1'), 'method', 'cash', 'device_id', (select v from t_out where k='bar_dev')))$$, '22023', 'a till of another shop does not count');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.folio_settle(jsonb_build_object('folio_id', (select v from t_out where k='f1'), 'method', 'barter'))$$, '22023', 'an unknown way to pay is refused');
-- the front desk till has an open shift with 1,000.00
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.open_shift(jsonb_build_object('id', '30000000-0000-4000-8000-000000000001', 'device_id', (select v from t_out where k='desk_dev'), 'opened_at', now() - interval '1 hour', 'opening_cash', 100000))$$, 1, 'the front desk opens a shift');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'st', $$select public.folio_settle(jsonb_build_object('folio_id', (select v from t_out where k='f1'), 'method', 'cash', 'device_id', (select v from t_out where k='desk_dev')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='st' and (v::jsonb ->> 'amount') = '21000'$$, 1, 'the guest pays 210.00 in cash');
select t_rows(null, 'service_role', $$select 1 from public.folios where id = (select v::uuid from t_out where k='f1') and status = 'closed' and closed_at is not null$$, 1, 'the stay is closed');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.folio_settle(jsonb_build_object('folio_id', (select v from t_out where k='f1'), 'method', 'cash', 'device_id', (select v from t_out where k='desk_dev')))$$, '55000', 'a closed stay cannot be settled twice');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values ('10000000-0000-4000-8000-000000000003', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='bar'), 'A003', (now() at time zone 'Asia/Bangkok')::date, 'takeaway')$$, 1, 'a third bill');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, status, sent_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='bar'), '10000000-0000-4000-8000-000000000003', '{"th":"น้ำ"}', 21000, 1, 'sent', now())$$, 1, 'its line');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.charge_order_to_room(t_charge('10000000-0000-4000-8000-000000000003', 'f1', '60000000-0000-4000-8000-000000000009'))$$, '55000', 'a closed stay cannot be charged');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'cs', $$select public.close_shift(jsonb_build_object('id', '30000000-0000-4000-8000-000000000001', 'closed_at', now(), 'counted_cash', 121000))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='cs' and (v::jsonb ->> 'expected_cash') = '121000' and (v::jsonb ->> 'variance') = '0'$$, 1, 'the shift expects the opening 1,000.00 plus the 210.00 settled in cash');
-- an empty stay closes with no payment
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'f2', $$select public.folio_check_in(t_in('room2', 'Carla')::jsonb)::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'st2', $$select public.folio_settle(jsonb_build_object('folio_id', (select v from t_out where k='f2'), 'method', 'cash', 'device_id', (select v from t_out where k='desk_dev')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='st2' and (v::jsonb ->> 'method') = 'none' and (v::jsonb ->> 'amount') = '0'$$, 1, 'a stay with nothing owed closes with no payment');
select t_err(null, 'anon', $$select public.folio_balance((select v::uuid from t_out where k='f1'))$$, '42501', 'not callable without signing in');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.folios (org_id, store_id, room_id, guest_name) select org_id, store_id, id, 'x' from public.folio_rooms$$, '42501', 'no direct writes');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.payments where tender = 'room'$$, 2, 'room payments exist for the two charged bills');
do $$ begin raise notice 'ALL FOLIO TESTS PASSED'; end $$;
