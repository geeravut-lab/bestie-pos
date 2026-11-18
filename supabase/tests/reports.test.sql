-- Sales report: who may read, ranges, totals by day / hour / tender / item / staff / shop, void and cancelled never count.
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
  ('00000000-0000-0000-0000-0000000000b2', 'manager@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme Co','Acme','restaurant')$$, 1, 'owner creates a restaurant');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','cafe')$$, 1, 'a second org exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('00000000-0000-0000-0000-0000000000b2'::uuid, 'Manager', 'manager'),
               ('00000000-0000-0000-0000-0000000000d4'::uuid, 'Cashier', 'cashier')) as u(id, n, b) on true
  join public.roles r on r.org_id = o.id and r.built_in = u.b
 where o.name = 'Acme Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Acme Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store2', $$select public.create_store((select v::uuid from t_out where k='org'), 'Beach Cafe', 'cafe')::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Counter', 'cashier') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev2', $$insert into public.devices (org_id, store_id, name, role) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), 'Cafe till', 'cashier') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cash_staff', $$select id::text from public.staff where display_name = 'Cashier'$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'mgr_staff', $$select id::text from public.staff where display_name = 'Manager'$$);

-- history, written as the server: 3 paid bills in shop 1 (two days, two hours), 1 in shop 2, 1 void bill, 1 bill with a cancelled line
-- A001 16 Nov 10:15 Bangkok: 2 x Pad Thai 90.00 + Tea 30.00 = 210.00 cash (cashier)
-- A002 16 Nov 19:40: Beer 3 x 60.00 = 180.00 promptpay (manager)
-- A003 17 Nov 10:50: Pad Thai 90.00 + cancelled Soup 70.00 = 90.00 cash (cashier)
-- C001 17 Nov 12:05 (Beach Cafe): Latte 55.00 = 55.00 gateway
-- A004: void bill, must not count
select t_rows(null, 'service_role', $$insert into public.orders (id, org_id, store_id, number, business_date, channel, status) values
  ('10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A001', date '2026-11-16', 'takeaway', 'paid'),
  ('10000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A002', date '2026-11-16', 'takeaway', 'paid'),
  ('10000000-0000-4000-8000-000000000003', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A003', date '2026-11-17', 'takeaway', 'paid'),
  ('10000000-0000-4000-8000-000000000004', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), 'B001', date '2026-11-17', 'takeaway', 'paid'),
  ('10000000-0000-4000-8000-000000000005', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A004', date '2026-11-17', 'takeaway', 'void')$$, 5, 'orders');
select t_rows(null, 'service_role', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, status, sent_at) values
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', '{"th":"ผัดไทย","en":"Pad Thai"}', 9000, 2, 'sent', now()),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', '{"th":"ชา","en":"Tea"}', 3000, 1, 'sent', now()),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', '{"th":"เบียร์","en":"Beer"}', 6000, 3, 'sent', now()),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000003', '{"th":"ผัดไทย","en":"Pad Thai"}', 9000, 1, 'sent', now()),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000003', '{"th":"ต้มยำ","en":"Soup"}', 7000, 1, 'sent', now()),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), '10000000-0000-4000-8000-000000000004', '{"th":"ลาเต้","en":"Latte"}', 5500, 1, 'sent', now()),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000005', '{"th":"ผัดไทย","en":"Pad Thai"}', 9000, 9, 'sent', now())$$, 7, 'lines');
select t_rows(null, 'service_role', $$update public.order_lines set status = 'void', void_reason = 'test' where name ->> 'en' = 'Soup' returning id$$, 1, 'one line is cancelled');
select t_rows(null, 'service_role', $$insert into public.receipts (org_id, store_id, order_id, number, device_id, staff_id, issued_at, seller_name, branch_code, vat_registered, vat_bps, service_bps, price_mode, subtotal, service_charge, vat, net_before_vat, total, payable) values
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', 'A-000001', (select v::uuid from t_out where k='dev'), (select v::uuid from t_out where k='cash_staff'), timestamptz '2026-11-16 10:15:00+07', 'Acme Co', '00000', true, 700, 0, 'inclusive', 21000, 0, 1374, 19626, 21000, 21000),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', 'A-000002', (select v::uuid from t_out where k='dev'), (select v::uuid from t_out where k='mgr_staff'), timestamptz '2026-11-16 19:40:00+07', 'Acme Co', '00000', true, 700, 0, 'inclusive', 18000, 0, 1178, 16822, 18000, 18000),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000003', 'A-000003', (select v::uuid from t_out where k='dev'), (select v::uuid from t_out where k='cash_staff'), timestamptz '2026-11-17 10:50:00+07', 'Acme Co', '00000', true, 700, 0, 'inclusive', 9000, 0, 589, 8411, 9000, 9000),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), '10000000-0000-4000-8000-000000000004', 'B-000001', (select v::uuid from t_out where k='dev2'), null, timestamptz '2026-11-17 12:05:00+07', 'Acme Co', '00001', true, 700, 0, 'inclusive', 5500, 0, 360, 5140, 5500, 5500)$$, 4, 'receipts');
select t_rows(null, 'service_role', $$insert into public.payments (org_id, store_id, order_id, tender, amount, tendered, change) values
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', 'cash', 21000, 50000, 29000),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', 'promptpay', 18000, null, 0),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000003', 'cash', 9000, 9000, 0),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), '10000000-0000-4000-8000-000000000004', 'gateway', 5500, null, 0)$$, 4, 'payments');

create or replace function t_rep(p_store text, p_from text, p_to text) returns jsonb language sql as $$
  select jsonb_build_object('org_id', (select v from t_out where k='org'), 'store_id', p_store, 'from', p_from, 'to', p_to)
$$;
grant execute on function t_rep(text, text, text) to authenticated, service_role;

-- ── who may read ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.sales_report(t_rep('', '2026-11-16', '2026-11-17'))$$, '42501', 'a cashier (no report.view) cannot read reports');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.sales_report(t_rep('', '2026-11-16', '2026-11-17'))$$, '42501', 'another org cannot');
select t_err(null, 'anon', $$select public.sales_report(t_rep('', '2026-11-16', '2026-11-17'))$$, '42501', 'anon cannot');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.sales_report(t_rep('', '2026-11-17', '2026-11-16'))$$, '22023', 'an upside-down range is refused');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.sales_report(t_rep('', '2020-01-01', '2026-11-16'))$$, '22023', 'a range longer than a year is refused');

-- ── all shops, both days ──
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'all', $$select public.sales_report(t_rep('', '2026-11-16', '2026-11-17'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='all' and (v::jsonb #>> '{totals,bills}') = '4' and (v::jsonb #>> '{totals,payable}') = '53500' and (v::jsonb #>> '{totals,vat}') = '3501' and (v::jsonb #>> '{totals,average}') = '13375'$$, 1, 'all shops: 4 bills, 535.00 payable, VAT 35.01, average 133.75 (the void bill is not counted)');
select t_rows(null, 'service_role', $$select 1 from t_out where k='all' and jsonb_array_length(v::jsonb -> 'by_day') = 2 and (v::jsonb #>> '{by_day,0,date}') = '2026-11-16' and (v::jsonb #>> '{by_day,0,payable}') = '39000' and (v::jsonb #>> '{by_day,1,payable}') = '14500'$$, 1, 'by day: 390.00 on the 16th, 145.00 on the 17th');
select t_rows(null, 'service_role', $$select 1 from t_out where k='all' and (v::jsonb #>> '{by_hour,0,hour}') = '10' and (v::jsonb #>> '{by_hour,0,bills}') = '2' and jsonb_array_length(v::jsonb -> 'by_hour') = 3$$, 1, 'by hour in Bangkok time: two bills in the 10 o''clock hour');
select t_rows(null, 'service_role', $$select 1 from t_out where k='all' and (v::jsonb #>> '{by_tender,0,tender}') = 'cash' and (v::jsonb #>> '{by_tender,0,amount}') = '30000' and jsonb_array_length(v::jsonb -> 'by_tender') = 3$$, 1, 'by tender: cash first with 300.00, then promptpay and card');
select t_rows(null, 'service_role', $$select 1 from t_out where k='all' and (v::jsonb #>> '{by_item,0,name_th}') = 'ผัดไทย' and (v::jsonb #>> '{by_item,0,quantity}') = '3' and (v::jsonb #>> '{by_item,0,revenue}') = '27000' and (v::jsonb #>> '{by_item,0,name_en}') = 'Pad Thai'$$, 1, 'by item: Pad Thai 3 sold, 270.00 (the void bill''s 9 are not counted)');
select t_rows(null, 'service_role', $$select 1 from t_out where k='all' and not (v::jsonb -> 'by_item') @> '[{"name_en":"Soup"}]'$$, 1, 'a cancelled line never appears');
select t_rows(null, 'service_role', $$select 1 from t_out where k='all' and jsonb_array_length(v::jsonb -> 'by_store') = 2$$, 1, 'by shop: both shops');
select t_rows(null, 'service_role', $$select 1 from t_out where k='all' and (v::jsonb -> 'by_staff') @> '[{"name":"Cashier","bills":2,"payable":30000}]' and (v::jsonb -> 'by_staff') @> '[{"name":"Manager","bills":1,"payable":18000}]'$$, 1, 'by staff: Cashier 2 bills 300.00, Manager 1 bill 180.00 (and the till-only bill has no name)');

-- ── one shop, one day ──
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'one', $$select public.sales_report(t_rep((select v from t_out where k='store2'), '2026-11-17', '2026-11-17'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='one' and (v::jsonb #>> '{totals,bills}') = '1' and (v::jsonb #>> '{totals,payable}') = '5500' and jsonb_array_length(v::jsonb -> 'by_store') = 1$$, 1, 'one shop, one day: only its bill');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'empty', $$select public.sales_report(t_rep('', '2026-01-01', '2026-01-02'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='empty' and (v::jsonb #>> '{totals,bills}') = '0' and (v::jsonb #>> '{totals,average}') = '0' and (v::jsonb -> 'by_day') = '[]'::jsonb$$, 1, 'an empty range gives zeros and empty lists, not an error');
\echo ALL REPORT TESTS PASSED
