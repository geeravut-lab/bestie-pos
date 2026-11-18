-- Guest QR ordering: token is the only key, prices / options are computed by the database, replay-safe, rate-limited.
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
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme Co','Acme','restaurant')$$, 1, 'owner creates a restaurant');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o
  join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Acme Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'cafe', $$select public.create_store((select org_id::text from public.stores where name='Acme')::uuid, 'Beach Cafe', 'cafe')::text$$);
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.seed_demo_menu((select v::uuid from t_out where k='store'))$$, 1, 'demo restaurant menu');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.seed_demo_menu((select v::uuid from t_out where k='cafe'))$$, 1, 'demo cafe menu');
select t_val(null, 'service_role', 'tok', $$select qr_token from public.dining_tables where store_id = (select v::uuid from t_out where k='store') and name = 'T1'$$);
select t_val(null, 'service_role', 'tok2', $$select qr_token from public.dining_tables where store_id = (select v::uuid from t_out where k='store') and name = 'T2'$$);
select t_val(null, 'service_role', 'padthai', $$select id::text from public.menu_items where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Pad Thai with prawns'$$);
select t_val(null, 'service_role', 'tomyum', $$select id::text from public.menu_items where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Tom yum goong'$$);
select t_val(null, 'service_role', 'egg', $$select id::text from public.modifier_options where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Fried egg'$$);
select t_val(null, 'service_role', 'mild', $$select id::text from public.modifier_options where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Medium'$$);
select t_val(null, 'service_role', 'hot', $$select id::text from public.modifier_options where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Very spicy'$$);
select t_val(null, 'service_role', 'latte', $$select id::text from public.menu_items where store_id = (select v::uuid from t_out where k='cafe') and name ->> 'en' = 'Latte'$$);

-- ── nobody but the server can call these ──
select t_err(null, 'anon', $$select public.guest_table('x')$$, '42501', 'anon cannot read a table by token');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.guest_menu((select v from t_out where k='tok'))$$, '42501', 'a signed-in user cannot either');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.guest_place_order('{}'::jsonb)$$, '42501', 'nor place guest orders');

-- ── reading ──
select t_rows(null, 'service_role', $$select 1 where public.guest_table('nope') is null$$, 1, 'unknown token gives nothing');
select t_rows(null, 'service_role', $$select 1 where public.guest_table((select v from t_out where k='tok')) ->> 'table_name' = 'T1'$$, 1, 'a token names its table');
select t_rows(null, 'service_role', $$select 1 where jsonb_array_length(public.guest_menu((select v from t_out where k='tok')) -> 'items') = 13 and jsonb_array_length(public.guest_menu((select v from t_out where k='tok')) -> 'categories') = 4$$, 1, 'the guest sees the restaurant menu: 13 items, 4 categories');

-- ── ordering ──
create or replace function t_order(tok text, cid text, lines text) returns jsonb language sql as $$
  select jsonb_build_object('token', tok, 'client_id', cid, 'lines', lines::jsonb)
$$;
grant execute on function t_order(text, text, text) to service_role;

select t_val(null, 'service_role', 'o1', $$select public.guest_place_order(t_order((select v from t_out where k='tok'), '20000000-0000-4000-8000-000000000001',
  format('[{"item_id":"%s","quantity":2,"option_ids":["%s"],"note":"no peanuts"},{"item_id":"%s","quantity":1,"option_ids":["%s"]}]',
    (select v from t_out where k='padthai'), (select v from t_out where k='egg'), (select v from t_out where k='tomyum'), (select v from t_out where k='mild'))))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='o1' and (v::jsonb ->> 'number') = 'QR001' and (v::jsonb ->> 'status') = 'waiting' and (v::jsonb ->> 'lines') = '2'$$, 1, 'first guest order opens bill QR001 and waits for staff');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where order_id = (select (v::jsonb ->> 'order_id')::uuid from t_out where k='o1') and status = 'new' and sent_at is null having count(*) = 2$$, 1, 'lines are unsent (staff send them)');
select t_rows(null, 'service_role', $$select 1 from public.order_lines l where l.name ->> 'en' = 'Pad Thai with prawns' and l.unit_price = 19500 and l.quantity = 2 and l.note = 'no peanuts' and l.station = 'kitchen'$$, 1, 'price = dish 180.00 + egg 15.00, computed by the database, station copied');
select t_rows(null, 'service_role', $$select 1 from public.orders where number = 'QR001' and channel = 'dine-in' and table_id is not null and status = 'open'$$, 1, 'the bill is a dine-in bill on the table');

-- replay of the same client id: same answer, no new lines
select t_rows(null, 'service_role', $$select 1 where (public.guest_place_order(t_order((select v from t_out where k='tok'), '20000000-0000-4000-8000-000000000001', '[{"item_id":"00000000-0000-0000-0000-000000000000","quantity":1}]')) ->> 'replay') = 'true'$$, 1, 'a retry is recognised before anything is checked');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where order_id = (select (v::jsonb ->> 'order_id')::uuid from t_out where k='o1') having count(*) = 2$$, 1, 'a retry adds no lines');
-- a second order at the same table joins the same bill
select t_rows(null, 'service_role', $$select 1 where (public.guest_place_order(t_order((select v from t_out where k='tok'), '20000000-0000-4000-8000-000000000002', format('[{"item_id":"%s","quantity":1,"option_ids":["%s"]}]', (select v from t_out where k='tomyum'), (select v from t_out where k='hot')))) ->> 'number') = 'QR001'$$, 1, 'the same table keeps one bill');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where order_id = (select (v::jsonb ->> 'order_id')::uuid from t_out where k='o1') having count(*) = 3$$, 1, 'three lines on it now');
-- another table gets its own number
select t_rows(null, 'service_role', $$select 1 where (public.guest_place_order(t_order((select v from t_out where k='tok2'), '20000000-0000-4000-8000-000000000003', format('[{"item_id":"%s","quantity":1,"option_ids":["%s"]}]', (select v from t_out where k='tomyum'), (select v from t_out where k='mild')))) ->> 'number') = 'QR002'$$, 1, 'another table is QR002');

select t_rows(null, 'service_role', $$select 1 where jsonb_array_length(public.guest_bill((select v from t_out where k='tok')) -> 'lines') = 3$$, 1, 'the guest bill view lists the table''s lines');

-- ── refusals ──
select t_err(null, 'service_role', $$select public.guest_place_order(t_order('nope', '20000000-0000-4000-8000-000000000010', '[]'))$$, 'P0002', 'unknown token');
select t_err(null, 'service_role', $$select public.guest_place_order(t_order((select v from t_out where k='tok'), '20000000-0000-4000-8000-000000000011', '[]'))$$, '22023', 'empty order');
select t_err(null, 'service_role', $$select public.guest_place_order(t_order((select v from t_out where k='tok'), '20000000-0000-4000-8000-000000000012', format('[{"item_id":"%s","quantity":0}]', (select v from t_out where k='padthai'))))$$, '22023', 'quantity 0');
select t_err(null, 'service_role', $$select public.guest_place_order(t_order((select v from t_out where k='tok'), '20000000-0000-4000-8000-000000000013', format('[{"item_id":"%s","quantity":100}]', (select v from t_out where k='padthai'))))$$, '22023', 'quantity 100');
select t_err(null, 'service_role', $$select public.guest_place_order(t_order((select v from t_out where k='tok'), '20000000-0000-4000-8000-000000000014', format('[{"item_id":"%s","quantity":1}]', (select v from t_out where k='latte'))))$$, '23514', 'an item of another shop');
select t_err(null, 'service_role', $$select public.guest_place_order(t_order((select v from t_out where k='tok'), '20000000-0000-4000-8000-000000000015', format('[{"item_id":"%s","quantity":1}]', (select v from t_out where k='tomyum'))))$$, '23514', 'a required option group left empty');
select t_err(null, 'service_role', $$select public.guest_place_order(t_order((select v from t_out where k='tok'), '20000000-0000-4000-8000-000000000016', format('[{"item_id":"%s","quantity":1,"option_ids":["%s","%s"]}]', (select v from t_out where k='tomyum'), (select v from t_out where k='mild'), (select v from t_out where k='hot'))))$$, '23514', 'two options in a pick-one group');
select t_err(null, 'service_role', $$select public.guest_place_order(t_order((select v from t_out where k='tok'), '20000000-0000-4000-8000-000000000017', format('[{"item_id":"%s","quantity":1,"option_ids":["%s"]}]', (select v from t_out where k='padthai'), (select v from t_out where k='hot'))))$$, '23514', 'an option that does not belong to the dish');
select t_err(null, 'service_role', $$select public.guest_place_order(t_order((select v from t_out where k='tok'), '20000000-0000-4000-8000-000000000018', format('[{"item_id":"%s","quantity":1,"option_ids":["%s","%s"]}]', (select v from t_out where k='padthai'), (select v from t_out where k='egg'), (select v from t_out where k='egg'))))$$, '23514', 'the same option twice');
update public.menu_items set available = false where id = (select v::uuid from t_out where k='padthai');
select t_err(null, 'service_role', $$select public.guest_place_order(t_order((select v from t_out where k='tok'), '20000000-0000-4000-8000-000000000019', format('[{"item_id":"%s","quantity":1,"option_ids":[]}]', (select v from t_out where k='padthai'))))$$, '23514', 'a sold-out item');
select t_rows(null, 'service_role', $$select 1 where jsonb_array_length(public.guest_menu((select v from t_out where k='tok')) -> 'items') = 12$$, 1, 'a sold-out item disappears from the guest menu');
update public.menu_items set available = true where id = (select v::uuid from t_out where k='padthai');

-- ── auto send ──
update public.stores set qr_auto_send = true where id = (select v::uuid from t_out where k='store');
select t_rows(null, 'service_role', $$select 1 where (public.guest_place_order(t_order((select v from t_out where k='tok2'), '20000000-0000-4000-8000-000000000020', format('[{"item_id":"%s","quantity":1,"option_ids":[]}]', (select v from t_out where k='padthai')))) ->> 'status') = 'sent'$$, 1, 'with auto-send the order goes to the kitchen');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where status = 'sent' and sent_at is not null and note is null and name ->> 'en' = 'Pad Thai with prawns' having count(*) = 1$$, 1, 'the line is sent with a time');

-- ── rate limit: 12 orders per table per 10 minutes ──
insert into public.guest_submissions (id, org_id, store_id, table_id, order_id, lines)
select gen_random_uuid(), o.org_id, o.store_id, o.table_id, o.id, 1 from public.orders o, generate_series(1, 12) where o.number = 'QR002';
select t_err(null, 'service_role', $$select public.guest_place_order(t_order((select v from t_out where k='tok2'), '20000000-0000-4000-8000-000000000021', format('[{"item_id":"%s","quantity":1,"option_ids":[]}]', (select v from t_out where k='padthai'))))$$, '54000', 'a table that floods the system is stopped');

-- ── rotate the QR ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.rotate_table_qr((select id from public.dining_tables where qr_token = (select v from t_out where k='tok')))$$, '42501', 'a cashier cannot rotate a QR');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'newtok', $$select public.rotate_table_qr((select id from public.dining_tables where qr_token = (select v from t_out where k='tok')))$$);
select t_rows(null, 'service_role', $$select 1 where public.guest_table((select v from t_out where k='tok')) is null and public.guest_table((select v from t_out where k='newtok')) is not null$$, 1, 'the old code is dead, the new one works');

-- ── the module switch ──
select t_val(null, 'service_role', 'ctable', $$insert into public.dining_tables (org_id, store_id, name) values ((select org_id from public.stores where id = (select v::uuid from t_out where k='cafe')), (select v::uuid from t_out where k='cafe'), 'Counter 1') returning qr_token$$);
select t_rows(null, 'service_role', $$select 1 where (public.guest_table((select v from t_out where k='ctable')) ->> 'qr_enabled') = 'false'$$, 1, 'a cafe does not take table orders by default');
select t_err(null, 'service_role', $$select public.guest_place_order(t_order((select v from t_out where k='ctable'), '20000000-0000-4000-8000-000000000030', format('[{"item_id":"%s","quantity":1,"option_ids":[]}]', (select v from t_out where k='latte'))))$$, '0A000', 'and refuses the order itself');
update public.stores set module_overrides = '{"order.qr": true}'::jsonb where id = (select v::uuid from t_out where k='cafe');
select t_rows(null, 'service_role', $$select 1 where (public.guest_table((select v from t_out where k='ctable')) ->> 'qr_enabled') = 'true'$$, 1, 'the owner switches it on');
update public.stores set module_overrides = '{"order.qr": false}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_err(null, 'service_role', $$select public.guest_place_order(t_order((select v from t_out where k='tok2'), '20000000-0000-4000-8000-000000000031', format('[{"item_id":"%s","quantity":1,"option_ids":[]}]', (select v from t_out where k='padthai'))))$$, '0A000', 'a restaurant that switched it off refuses');
update public.stores set module_overrides = '{}'::jsonb, plan = 'basic' where id = (select v::uuid from t_out where k='store');
select t_rows(null, 'service_role', $$select 1 where (public.guest_table((select v from t_out where k='tok2')) ->> 'qr_enabled') = 'false'$$, 1, 'the basic plan does not include QR ordering');
\echo ALL GUEST ORDERING TESTS PASSED
