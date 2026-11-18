-- Split / merge bills and cash shifts.
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
  ('00000000-0000-0000-0000-0000000000c9', 'kitchen@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme Co','Acme','restaurant')$$, 1, 'owner creates a restaurant');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','cafe')$$, 1, 'a second org exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('00000000-0000-0000-0000-0000000000d4'::uuid, 'Cashier', 'cashier'),
               ('00000000-0000-0000-0000-0000000000c9'::uuid, 'Kitchen', 'kitchen')) as u(id, n, b) on true
  join public.roles r on r.org_id = o.id and r.built_in = u.b
 where o.name = 'Acme Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Acme Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store2', $$select public.create_store((select v::uuid from t_out where k='org'), 'Second', 'cafe')::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Counter', 'cashier') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cashier_staff', $$select id::text from public.staff where display_name = 'Cashier'$$);

-- bill A: 3 beers (sent) 60.00 each + 1 noodles (new) 80.00 ; bill B: 1 tea ; bill C in another shop
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values
  ('10000000-0000-4000-8000-00000000000a', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A001', (now() at time zone 'Asia/Bangkok')::date, 'dine-in'),
  ('10000000-0000-4000-8000-00000000000b', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A002', (now() at time zone 'Asia/Bangkok')::date, 'dine-in')$$, 2, 'two open bills');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (id, org_id, store_id, order_id, name, unit_price, quantity, status, sent_at, seat) values
  ('20000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-00000000000a', '{"th":"เบียร์"}', 6000, 3, 'sent', now(), 1),
  ('20000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-00000000000a', '{"th":"ผัดไทย"}', 8000, 1, 'new', null, 2),
  ('20000000-0000-4000-8000-000000000003', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-00000000000b', '{"th":"ชา"}', 3000, 1, 'new', null, null)$$, 3, 'lines');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.order_lines set quantity = 1 where id = '20000000-0000-4000-8000-000000000001'$$, '23514', 'a sent line still cannot be edited directly');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.order_lines set order_id = '10000000-0000-4000-8000-00000000000b' where id = '20000000-0000-4000-8000-000000000001'$$, '23514', 'a line cannot be re-homed directly');

-- ── split ──
select t_err('00000000-0000-0000-0000-0000000000c9', 'authenticated', $$select public.move_order_lines('{"from_order":"10000000-0000-4000-8000-00000000000a","to_order":"10000000-0000-4000-8000-00000000000b","moves":[{"line_id":"20000000-0000-4000-8000-000000000002","qty":1}]}')$$, '42501', 'a kitchen account cannot move items');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.move_order_lines('{"from_order":"10000000-0000-4000-8000-00000000000a","to_order":"10000000-0000-4000-8000-00000000000b","moves":[{"line_id":"20000000-0000-4000-8000-000000000002","qty":1}]}')$$, '42501', 'another org cannot');
select t_err(null, 'anon', $$select public.move_order_lines('{"from_order":"10000000-0000-4000-8000-00000000000a","to_order":"10000000-0000-4000-8000-00000000000b","moves":[]}')$$, '42501', 'anon cannot');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.move_order_lines('{"from_order":"10000000-0000-4000-8000-00000000000a","to_order":"10000000-0000-4000-8000-00000000000a","moves":[]}')$$, '23514', 'a bill cannot be moved into itself');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.move_order_lines('{"from_order":"10000000-0000-4000-8000-00000000000a","to_order":"10000000-0000-4000-8000-00000000000b","moves":[{"line_id":"20000000-0000-4000-8000-000000000001","qty":4,"new_line_id":"20000000-0000-4000-8000-0000000000f1"}]}')$$, '23514', 'moving more than the line has is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.move_order_lines('{"from_order":"10000000-0000-4000-8000-00000000000a","to_order":"10000000-0000-4000-8000-00000000000b","moves":[{"line_id":"20000000-0000-4000-8000-000000000001","qty":1}]}')$$, '23514', 'a partial move needs the id of the new line');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values ('10000000-0000-4000-8000-00000000000c', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A003', (now() at time zone 'Asia/Bangkok')::date, 'dine-in')$$, 1, 'a third bill');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (id, org_id, store_id, order_id, name, unit_price, quantity) values ('20000000-0000-4000-8000-000000000009', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-00000000000c', '{"th":"กาแฟ"}', 5000, 1)$$, 1, 'with a line on it');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.move_order_lines('{"from_order":"10000000-0000-4000-8000-00000000000a","to_order":"10000000-0000-4000-8000-00000000000b","moves":[{"line_id":"20000000-0000-4000-8000-000000000009","qty":1}]}')$$, '23514', 'a line that is on a THIRD bill cannot be moved between these two');

select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.move_order_lines('{"from_order":"10000000-0000-4000-8000-00000000000a","to_order":"10000000-0000-4000-8000-00000000000b","moves":[{"line_id":"20000000-0000-4000-8000-000000000001","qty":2,"new_line_id":"20000000-0000-4000-8000-0000000000f1"},{"line_id":"20000000-0000-4000-8000-000000000002","qty":1}]}')$$, 1, 'split: 2 of 3 beers (sent) and the noodles go to bill B');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where id = '20000000-0000-4000-8000-000000000001' and order_id = '10000000-0000-4000-8000-00000000000a' and quantity = 1 and status = 'sent'$$, 1, 'one beer stays on bill A, still sent');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where id = '20000000-0000-4000-8000-0000000000f1' and order_id = '10000000-0000-4000-8000-00000000000b' and quantity = 2 and unit_price = 6000 and status = 'sent' and sent_at is not null$$, 1, 'two beers arrive on bill B as sent lines with the same price');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where id = '20000000-0000-4000-8000-000000000002' and order_id = '10000000-0000-4000-8000-00000000000b'$$, 1, 'the noodles moved whole');
select t_rows(null, 'service_role', $$select sum(unit_price::bigint * quantity) from public.order_lines where status <> 'void' having sum(unit_price::bigint * quantity) = 6000 + 12000 + 8000 + 3000 + 5000$$, 1, 'the total across both bills did not change');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.move_order_lines('{"from_order":"10000000-0000-4000-8000-00000000000a","to_order":"10000000-0000-4000-8000-00000000000b","moves":[{"line_id":"20000000-0000-4000-8000-000000000001","qty":2,"new_line_id":"20000000-0000-4000-8000-0000000000f1"},{"line_id":"20000000-0000-4000-8000-000000000002","qty":1}]}')$$, 1, 'the same move arriving again changes nothing');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where id = '20000000-0000-4000-8000-000000000001' and quantity = 1$$, 1, 'still one beer on bill A');

-- ── merge ──
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.move_order_lines('{"from_order":"10000000-0000-4000-8000-00000000000a","to_order":"10000000-0000-4000-8000-00000000000b","void_source_if_empty":true,"moves":[{"line_id":"20000000-0000-4000-8000-000000000001","qty":1}]}')$$, 1, 'merge A into B');
select t_rows(null, 'service_role', $$select 1 from public.orders where id = '10000000-0000-4000-8000-00000000000a' and status = 'void' and note like '%merged into A002%'$$, 1, 'the empty source bill is closed as void with a note');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where order_id = '10000000-0000-4000-8000-00000000000b'$$, 4, 'bill B now has everything from A and its own (4 lines)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.move_order_lines('{"from_order":"10000000-0000-4000-8000-00000000000b","to_order":"10000000-0000-4000-8000-00000000000a","moves":[{"line_id":"20000000-0000-4000-8000-000000000003","qty":1}]}')$$, '23514', 'a closed (void) bill cannot take part any more');

-- ── shifts ──
select t_err('00000000-0000-0000-0000-0000000000c9', 'authenticated', $$select public.open_shift(jsonb_build_object('id', gen_random_uuid(), 'device_id', (select v from t_out where k='dev'), 'opened_at', now() - interval '1 hour', 'opening_cash', 100000))$$, '42501', 'a kitchen account cannot open a shift');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.open_shift(jsonb_build_object('id', gen_random_uuid(), 'device_id', (select v from t_out where k='dev'), 'opened_at', now() - interval '1 hour', 'opening_cash', -5))$$, '23514', 'a negative opening cash is refused');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.open_shift(jsonb_build_object('id', '30000000-0000-4000-8000-000000000001', 'device_id', (select v from t_out where k='dev'), 'staff_id', (select v from t_out where k='cashier_staff'), 'opened_at', now() - interval '1 hour', 'opening_cash', 100000))$$, 1, 'the cashier opens a shift with 1,000.00 in the drawer');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.open_shift(jsonb_build_object('id', '30000000-0000-4000-8000-000000000001', 'device_id', (select v from t_out where k='dev'), 'opened_at', now() - interval '1 hour', 'opening_cash', 100000))$$, 1, 'opening the same shift again is a no-op');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.open_shift(jsonb_build_object('id', gen_random_uuid(), 'device_id', (select v from t_out where k='dev'), 'opened_at', now(), 'opening_cash', 0))$$, '23505', 'a device cannot have two open shifts');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.shifts where status = 'open'$$, 1, 'a cashier can read the shifts of the shop');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.shifts$$, 0, 'another org sees none');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.shifts (org_id, store_id, device_id, opened_at, opening_cash) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='dev'), now(), 0)$$, '42501', 'the browser cannot write shifts directly');

-- two cash sales on this device during the shift (210.00 and 30.00) + one PromptPay sale that must NOT count
select t_rows(null, 'service_role', $$insert into public.orders (id, org_id, store_id, number, business_date, channel, status) values
  ('10000000-0000-4000-8000-0000000000c1', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A010', (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'paid'),
  ('10000000-0000-4000-8000-0000000000c2', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A011', (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'paid'),
  ('10000000-0000-4000-8000-0000000000c3', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A012', (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'paid')$$, 3, 'three paid orders (set up as the server role)');
select t_rows(null, 'service_role', $$insert into public.payments (org_id, store_id, order_id, tender, amount, tendered, change, device_id, created_at) values
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-0000000000c1', 'cash', 21000, 50000, 29000, (select v::uuid from t_out where k='dev'), now() - interval '30 minutes'),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-0000000000c2', 'cash', 3000, 3000, 0, (select v::uuid from t_out where k='dev'), now() - interval '10 minutes'),
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-0000000000c3', 'promptpay', 9900, null, 0, (select v::uuid from t_out where k='dev'), now() - interval '5 minutes')$$, 3, 'payments');

select t_err('00000000-0000-0000-0000-0000000000c9', 'authenticated', $$select public.close_shift(jsonb_build_object('id', '30000000-0000-4000-8000-000000000001', 'closed_at', now(), 'counted_cash', 124000))$$, '42501', 'a kitchen account cannot close a shift');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_shift(jsonb_build_object('id', '30000000-0000-4000-8000-000000000001', 'closed_at', now() - interval '3 hours', 'counted_cash', 124000))$$, '23514', 'a shift cannot close before it opened');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'closed', $$select public.close_shift(jsonb_build_object('id', '30000000-0000-4000-8000-000000000001', 'staff_id', (select v from t_out where k='cashier_staff'), 'closed_at', now(), 'counted_cash', 123500, 'note', 'short by 5 baht'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.shifts where status = 'closed' and opening_cash = 100000 and expected_cash = 124000 and counted_cash = 123500 and variance = -500 and note = 'short by 5 baht'$$, 1, 'the SERVER computed expected cash = 1,000.00 + 210.00 + 30.00 (PromptPay not counted) and the variance');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'shift.cash_variance' and detail = '{"variance":-500}'$$, 1, 'a cash variance is audited');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action in ('shift.open', 'shift.close')$$, 2, 'opening and closing were audited');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'closed2', $$select public.close_shift(jsonb_build_object('id', '30000000-0000-4000-8000-000000000001', 'closed_at', now(), 'counted_cash', 1))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.shifts where counted_cash = 123500$$, 1, 'closing again does not change the counted cash');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.open_shift(jsonb_build_object('id', gen_random_uuid(), 'device_id', (select v from t_out where k='dev'), 'opened_at', now(), 'opening_cash', 50000))$$, 1, 'after closing, a new shift can be opened');
select t_rows(null, 'service_role', $$update public.stores set shift_required = true$$, 3, 'shift_required is a plain store setting');
\echo ALL SPLIT AND SHIFT TESTS PASSED
