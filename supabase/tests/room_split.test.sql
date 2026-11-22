-- Part of a bill on the room: a room is one leg of a split closing.
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

-- ── the module ──
update public.stores set plan = 'pro' where id = (select v::uuid from t_out where k='resort');  -- a resort shop on Pro (a new resort shop starts on Resort since migration 92)
select t_rows(null, 'service_role', $$select 1 where not public.folio_enabled((select v::uuid from t_out where k='resort'))$$, 1, 'a resort-profile shop on the Pro plan does not have the folio');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_folio_room(jsonb_build_object('store_id', (select v from t_out where k='resort'), 'name', '101'))$$, '0A000', 'so rooms cannot be made');
update public.stores set plan = 'resort' where id = (select v::uuid from t_out where k='resort');
select t_rows(null, 'service_role', $$select 1 where public.folio_enabled((select v::uuid from t_out where k='resort')) and not public.folio_enabled((select v::uuid from t_out where k='bar'))$$, 1, 'on the Resort plan the resort profile has it, the cafe does not');


-- ── a room, a stay, a bill ──
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'room1', $$select public.save_folio_room(jsonb_build_object('store_id', (select v from t_out where k='resort'), 'name', '101'))::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'f1', $$select public.folio_check_in(jsonb_build_object('store_id', (select v from t_out where k='resort'), 'room_id', (select v from t_out where k='room1'), 'guest_name', 'Anna'))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values ('10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='bar'), 'A001', (now() at time zone 'Asia/Bangkok')::date, 'takeaway')$$, 1, 'a bar bill');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, status, sent_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='bar'), '10000000-0000-4000-8000-000000000001', '{"th":"ค็อกเทล"}', 42000, 1, 'sent', now())$$, 1, 'one line of 420.00');
create or replace function t_split(p_order text, p_pays jsonb, p_total bigint default 42000) returns jsonb language sql as $$
  select jsonb_build_object('order_id', p_order, 'device_id', (select v from t_out where k='bar_dev'), 'staff_id', (select v from t_out where k='cashier_staff'), 'issued_at', now(), 'lang', 'en',
    'subtotal', 42000, 'service_charge', 0, 'vat', 2748, 'net_before_vat', p_total - 2748, 'total', p_total, 'rounding', 0, 'payable', p_total,
    'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive', 'payments', p_pays) $$;
grant execute on function t_split(text, jsonb, bigint) to authenticated, service_role;
create or replace function t_room(p_id text, p_amt bigint, p_folio text default 'f1') returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'tender', 'room', 'amount', p_amt, 'folio_id', (select v from t_out where k=p_folio)) $$;
create or replace function t_cash(p_id text, p_amt bigint, p_tend bigint default null) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'tender', 'cash', 'amount', p_amt, 'tendered', coalesce(p_tend, p_amt), 'change', coalesce(p_tend, p_amt) - p_amt) $$;
grant execute on function t_room(text, bigint, text) to authenticated, service_role;
grant execute on function t_cash(text, bigint, bigint) to authenticated, service_role;
select t_val(null, 'service_role', 'f_other', $$select '00000000-0000-4000-8000-00000000dead'$$);

-- ── refusals ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_room('60000000-0000-4000-8000-000000000001', 20000, 'f_other'), t_cash('60000000-0000-4000-8000-000000000002', 22000))))$$, '55000', 'a stay that does not exist is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_room('60000000-0000-4000-8000-000000000001', 20000), t_cash('60000000-0000-4000-8000-000000000002', 20000))))$$, '23514', 'legs that do not cover the bill are refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_room('60000000-0000-4000-8000-000000000001', 20000), t_room('60000000-0000-4000-8000-000000000003', 22000))))$$, '23514', 'only one room can take a share');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_room('60000000-0000-4000-8000-000000000001', 20000), t_cash('60000000-0000-4000-8000-000000000002', 22000))))$$, '42501', 'another business cannot close it');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(jsonb_build_object('id', '60000000-0000-4000-8000-000000000001', 'tender', 'promptpay', 'amount', 42000))))$$, '23514', 'other tenders still cannot be mixed in here');

-- ── 200.00 on the room, 220.00 in cash ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cl', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_room('60000000-0000-4000-8000-000000000001', 20000), t_cash('60000000-0000-4000-8000-000000000002', 22000, 25000))))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='cl' and (v::jsonb ->> 'receipt_number') ~ '^[A-Z]\+000001$' and (v::jsonb ->> 'replay') = 'false'$$, 1, 'one receipt in the server series');
select t_rows(null, 'service_role', $$select 1 from public.payments where order_id = '10000000-0000-4000-8000-000000000001' and tender = 'room' and amount = 20000 and reference = 'folio:' || (select v from t_out where k='f1')$$, 1, 'a room payment of 200.00 that names the stay');
select t_rows(null, 'service_role', $$select 1 from public.payments where order_id = '10000000-0000-4000-8000-000000000001' and tender = 'cash' and amount = 22000 and tendered = 25000 and change = 3000$$, 1, 'and a cash payment of 220.00 with its change');
select t_rows(null, 'service_role', $$select 1 from public.folio_charges where order_id = '10000000-0000-4000-8000-000000000001' and folio_id = (select v::uuid from t_out where k='f1') and amount = 20000 and kind = 'bill' and receipt_number = (select v::jsonb ->> 'receipt_number' from t_out where k='cl')$$, 1, 'the stay owes only the room''s share, with the receipt number');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.folio_balance((select v::uuid from t_out where k='f1')) = 20000$$, 1, 'balance 200.00');
select t_rows(null, 'service_role', $$select 1 from public.orders where id = '10000000-0000-4000-8000-000000000001' and status = 'paid'$$, 1, 'the bill is paid');
select t_rows(null, 'service_role', $$select 1 from public.receipts where order_id = '10000000-0000-4000-8000-000000000001' and payable = 42000$$, 1, 'the receipt is for the whole bill');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cl2', $$select public.close_order_tenders(t_split('10000000-0000-4000-8000-000000000001', jsonb_build_array(t_room('60000000-0000-4000-8000-000000000001', 20000), t_cash('60000000-0000-4000-8000-000000000002', 22000, 25000))))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='cl2' and (v::jsonb ->> 'replay') = 'true'$$, 1, 'the same closing again returns the same receipt');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.folio_charges where order_id = '10000000-0000-4000-8000-000000000001') = 1$$, 1, 'and no second charge');

-- ── a return of the whole bill: the room route takes back only the room's 200.00 ──
select t_val(null, 'service_role', 'line1', $$select id::text from public.order_lines where order_id = '10000000-0000-4000-8000-000000000001'$$);
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.create_return(jsonb_build_object('id', '70000000-0000-4000-8000-000000000001', 'order_id', '10000000-0000-4000-8000-000000000001', 'refund_method', 'room', 'reason', 'other',
  'lines', jsonb_build_array(jsonb_build_object('order_line_id', (select v from t_out where k='line1'), 'quantity', 1, 'restock', false))))$$, '23514', 'returning the whole bill on the room route is refused: the room took only 200.00 of it');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.create_return(jsonb_build_object('id', '70000000-0000-4000-8000-000000000002', 'order_id', '10000000-0000-4000-8000-000000000001', 'refund_method', 'cash', 'reason', 'other', 'device_id', (select v from t_out where k='bar_dev'),
  'lines', jsonb_build_array(jsonb_build_object('order_line_id', (select v from t_out where k='line1'), 'quantity', 1, 'restock', false))))$$, '23514', 'and cash took only 220.00, so it cannot carry it either (two returns of two routes are needed)');
do $$ begin raise notice 'ALL ROOM SPLIT TESTS PASSED'; end $$;
