-- Floor plan + orders: who may write, the guards, frozen lines, closing only through payment, device codes.
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
  ('00000000-0000-0000-0000-0000000000f6', 'kitchen@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme','Acme','restaurant')$$, 1, 'owner creates a restaurant');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','cafe')$$, 1, 'a second org exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('00000000-0000-0000-0000-0000000000b2'::uuid, 'Manager', 'manager'),
               ('00000000-0000-0000-0000-0000000000d4'::uuid, 'Cashier', 'cashier'),
               ('00000000-0000-0000-0000-0000000000f6'::uuid, 'Kitchen', 'kitchen')) as u(id, n, b) on true
  join public.roles r on r.org_id = o.id and r.built_in = u.b
 where o.name = 'Acme';

select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store2', $$select public.create_store((select v::uuid from t_out where k='org'), 'Second', 'cafe')::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Counter', 'cashier') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cashier_staff', $$select id::text from public.staff where display_name = 'Cashier'$$);

-- ── device codes ──
select t_rows(null, 'service_role', $$select 1 from public.devices where code = 'A'$$, 1, 'the first device of a shop gets code A');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.devices (org_id, store_id, name, role) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Bar', 'staff')$$, 1, 'the second gets B');
select t_rows(null, 'service_role', $$select 1 from public.devices where code = 'B' and name = 'Bar'$$, 1, 'code B was assigned');
select t_err(null, 'service_role', $$insert into public.devices (org_id, store_id, name, role, code) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Dup', 'staff', 'A')$$, '23505', 'two devices of a shop cannot share a code');

-- ── tables ──
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$insert into public.dining_tables (org_id, store_id, name, zone, seats) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'T1', 'Terrace', 4)$$, 1, 'a manager adds a table');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'tbl', $$select id::text from public.dining_tables limit 1$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.dining_tables (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'T9')$$, '42501', 'a cashier cannot add a table');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.dining_tables (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), ' t1 ')$$, '23505', 'table names are unique per shop (ignoring case and spaces)');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.dining_tables$$, 1, 'a cashier can read the floor plan');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.dining_tables$$, 0, 'another org sees nothing');

-- ── orders ──
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', format($$insert into public.orders (org_id, store_id, number, business_date, channel, table_id, covers, opened_by, device_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A001', (now() at time zone 'Asia/Bangkok')::date, 'dine-in', (select v::uuid from t_out where k='tbl'), 2, %L, (select v::uuid from t_out where k='dev'))$$, (select v from t_out where k='cashier_staff')), 1, 'a cashier opens an order on a table');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'ord', $$select id::text from public.orders limit 1$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (org_id, store_id, number, business_date, channel) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A001', (now() at time zone 'Asia/Bangkok')::date, 'takeaway')$$, '23505', 'the same number twice on a day is refused');
select t_err('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$insert into public.orders (org_id, store_id, number, business_date, channel) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'K001', (now() at time zone 'Asia/Bangkok')::date, 'takeaway')$$, '42501', 'a kitchen account cannot open orders');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (org_id, store_id, number, business_date, channel) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'bad number', (now() at time zone 'Asia/Bangkok')::date, 'takeaway')$$, '23514', 'a malformed number is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (org_id, store_id, number, business_date, channel) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A002', date '2020-01-01', 'takeaway')$$, '23514', 'an order dated far from today is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (org_id, store_id, number, business_date, channel, table_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), 'A003', (now() at time zone 'Asia/Bangkok')::date, 'dine-in', (select v::uuid from t_out where k='tbl'))$$, '23514', 'a table of another shop is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (org_id, store_id, number, business_date, channel, status) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A004', (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'paid')$$, '23514', 'an order cannot be created already paid');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.orders set status = 'paid' where id = (select v::uuid from t_out where k='ord')$$, '23514', 'a cashier cannot mark an order paid by hand');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.orders set number = 'A999' where id = (select v::uuid from t_out where k='ord')$$, '23514', 'the number of an order cannot change');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.orders set note = 'birthday', covers = 3 where id = (select v::uuid from t_out where k='ord')$$, 1, 'covers and note can change');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.orders$$, 0, 'another org cannot see the order');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.orders set status = 'void' where id = (select v::uuid from t_out where k='ord')$$, '42501', 'a cashier cannot void a whole order');

-- ── lines ──
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, modifiers, station) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='ord'), '{"th":"ผัดไทย"}', 9000, 2, '[{"id":"m1","name":{"th":"ไข่"},"priceDelta":1000}]', 'kitchen')$$, 1, 'add a line with a modifier');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'line', $$select id::text from public.order_lines limit 1$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='ord'), '{"th":"x"}', 100, 0)$$, '23514', 'quantity 0 is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='ord'), '{"th":"x"}', -100, 1)$$, '23514', 'a negative unit price is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, modifiers) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='ord'), '{"th":"x"}', 100, 1, '[{"id":"m1"}]')$$, '23514', 'a malformed modifier is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, modifiers) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='ord'), '{"th":"x"}', 100, 1, '{"a":1}')$$, '23514', 'modifiers must be a list');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), (select v::uuid from t_out where k='ord'), '{"th":"x"}', 100, 1)$$, '23514', 'a line cannot point at an order of another shop');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.order_lines set quantity = 3, note = 'no spice' where id = (select v::uuid from t_out where k='line')$$, 1, 'an unsent line can be edited');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.order_lines set status = 'sent', sent_at = now() where id = (select v::uuid from t_out where k='line')$$, 1, 'send to the kitchen');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.order_lines set quantity = 1 where id = (select v::uuid from t_out where k='line')$$, '23514', 'a sent line cannot be edited (quantity)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.order_lines set unit_price = 1 where id = (select v::uuid from t_out where k='line')$$, '23514', 'a sent line cannot be edited (price)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.order_lines set status = 'new' where id = (select v::uuid from t_out where k='line')$$, '23514', 'a line never moves backwards');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.order_lines set status = 'void', void_reason = 'oops' where id = (select v::uuid from t_out where k='line')$$, '42501', 'a cashier cannot void a sent line');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$update public.order_lines set status = 'void', void_reason = 'guest left' where id = (select v::uuid from t_out where k='line')$$, 1, 'a manager can void a sent line');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'order.void' and entity = 'order_lines'$$, 1, 'the void of a sent line was audited (critical)');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$update public.order_lines set status = 'sent' where id = (select v::uuid from t_out where k='line')$$, '23514', 'a voided line stays void');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='ord'), '{"th":"ชา"}', 3000, 1)$$, 1, 'a second line');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.order_lines set status = 'void' where name = '{"th":"ชา"}'$$, 1, 'an unsent line can simply be removed (void while new)');

-- ── closing goes through payment only ──
select t_rows(null, 'service_role', $$update public.orders set status = 'paid', closed_at = now() where id = (select v::uuid from t_out where k='ord')$$, 1, 'the server side (payment function) can close an order');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.orders set note = 'late edit' where id = (select v::uuid from t_out where k='ord')$$, '23514', 'a closed order cannot be edited');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='ord'), '{"th":"x"}', 100, 1)$$, '23514', 'nothing can be added to a closed order');
select t_err(null, 'anon', $$select * from public.orders$$, '42501', 'anon cannot read orders');
\echo ALL ORDER TESTS PASSED
