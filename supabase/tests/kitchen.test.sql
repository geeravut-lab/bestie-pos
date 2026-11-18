-- Kitchen display: kds.use, set_lines_status, undo, frozen sent lines stay frozen.
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
  ('00000000-0000-0000-0000-0000000000f6', 'kitchen@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme Co','Acme','restaurant')$$, 1, 'owner creates a restaurant');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','cafe')$$, 1, 'a second org exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('00000000-0000-0000-0000-0000000000d4'::uuid, 'Cashier', 'cashier'),
               ('00000000-0000-0000-0000-0000000000f6'::uuid, 'Kitchen', 'kitchen')) as u(id, n, b) on true
  join public.roles r on r.org_id = o.id and r.built_in = u.b
 where o.name = 'Acme Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Acme Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Acme'$$);

select t_rows(null, 'service_role', $$select 1 from public.roles where built_in = 'kitchen' and permissions = array['kds.use']$$, 2, 'every kitchen role (both orgs, including ones made before the migration) got kds.use');
select t_rows(null, 'service_role', $$select 1 from public.roles where built_in = 'cashier' and 'kds.use' = any (permissions)$$, 0, 'other roles did not');

select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values ('10000000-0000-4000-8000-00000000000a', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A001', (now() at time zone 'Asia/Bangkok')::date, 'dine-in')$$, 1, 'an order');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (id, org_id, store_id, order_id, name, unit_price, quantity, station, status, sent_at) values
  ('20000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-00000000000a', '{"th":"ผัดไทย"}', 8000, 2, 'kitchen', 'sent', now()),
  ('20000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-00000000000a', '{"th":"เบียร์"}', 6000, 1, 'bar', 'sent', now()),
  ('20000000-0000-4000-8000-000000000003', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-00000000000a', '{"th":"ชา"}', 3000, 1, 'bar', 'new', null)$$, 3, 'lines: two sent, one not');

-- the kitchen account cannot touch lines directly (no order.create) …
select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$update public.order_lines set status = 'ready' where id = '20000000-0000-4000-8000-000000000001'$$, 0, 'a kitchen account cannot update lines directly');
select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select 1 from public.order_lines where status = 'sent'$$, 2, 'but it can read them');
-- … only through set_lines_status
select t_err(null, 'anon', $$select public.set_lines_status('{"line_ids":["20000000-0000-4000-8000-000000000001"],"status":"ready"}')$$, '42501', 'anon cannot');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.set_lines_status('{"line_ids":["20000000-0000-4000-8000-000000000001"],"status":"ready"}')$$, '42501', 'another org cannot');
select t_err('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select public.set_lines_status('{"line_ids":["20000000-0000-4000-8000-000000000001"],"status":"void"}')$$, '22023', 'it cannot void through it (unknown status)');
select t_err('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select public.set_lines_status('{"line_ids":["20000000-0000-4000-8000-000000000003"],"status":"ready"}')$$, '23514', 'a line that was never sent has no kitchen status');
select t_err('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select public.set_lines_status('{"line_ids":["20000000-0000-4000-8000-0000000000ff"],"status":"ready"}')$$, 'P0002', 'an unknown line is refused');
select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select public.set_lines_status('{"line_ids":["20000000-0000-4000-8000-000000000001"],"status":"ready"}')$$, 1, 'the kitchen marks the noodles ready');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where id = '20000000-0000-4000-8000-000000000001' and status = 'ready' and unit_price = 8000 and quantity = 2$$, 1, 'ready — price and quantity untouched');
select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select public.set_lines_status('{"line_ids":["20000000-0000-4000-8000-000000000001"],"status":"ready"}')$$, 1, 'the same call again is harmless');
select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select public.set_lines_status('{"line_ids":["20000000-0000-4000-8000-000000000001"],"status":"sent"}')$$, 1, 'undo: ready goes back to sent');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where id = '20000000-0000-4000-8000-000000000001' and status = 'sent'$$, 1, 'back to sent');
select t_val('00000000-0000-0000-0000-0000000000f6', 'authenticated', 'bumped', $$select public.set_lines_status('{"line_ids":["20000000-0000-4000-8000-000000000001","20000000-0000-4000-8000-000000000002"],"status":"ready"}')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k = 'bumped' and v = '2'$$, 1, 'a whole ticket (two lines) is bumped in one call and the count is returned');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_lines_status('{"line_ids":["20000000-0000-4000-8000-000000000001"],"status":"served"}')$$, 1, 'a cashier / waiter (order.create) marks it served');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_lines_status('{"line_ids":["20000000-0000-4000-8000-000000000001"],"status":"sent"}')$$, '23514', 'but cannot undo more than one step (served → sent)');
select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select public.set_lines_status('{"line_ids":["20000000-0000-4000-8000-000000000001"],"status":"ready"}')$$, 1, 'one step back (served → ready) is allowed');

-- a cancelled line is skipped, not resurrected
select t_rows(null, 'service_role', $$update public.order_lines set status = 'void' where id = '20000000-0000-4000-8000-000000000002'$$, 1, 'a line gets voided meanwhile');
select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select public.set_lines_status('{"line_ids":["20000000-0000-4000-8000-000000000002"],"status":"served"}')$$, 1, 'the call succeeds');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where id = '20000000-0000-4000-8000-000000000002' and status = 'void'$$, 1, 'and the cancelled line stayed cancelled');

-- everything else about sent lines is still frozen, also for the kitchen
select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$update public.order_lines set quantity = 9 where id = '20000000-0000-4000-8000-000000000001'$$, 0, 'the kitchen cannot edit a quantity');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.order_lines set status = 'sent' where id = '20000000-0000-4000-8000-000000000001'$$, '23514', 'a direct backwards update is still refused for everyone');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.order_lines set quantity = 5 where id = '20000000-0000-4000-8000-000000000001'$$, '23514', 'a sent line still cannot be edited directly');
\echo ALL KITCHEN TESTS PASSED
