-- "Ask my shop": the gate. Needs report.view, access to the shop and the ai.assistant module (Pro plan and up).
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

select t_val(null, 'service_role', 'plan', $$select plan from public.stores where id = (select v::uuid from t_out where k='store')$$);
-- the module is off by default
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'ctx0', $$select public.ask_shop_context((select v::uuid from t_out where k='store'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='ctx0' and v is null$$, 1, 'off by default for every profile: no context');
update public.stores set module_overrides = '{"ai.assistant": true}' where id = (select v::uuid from t_out where k='store');
update public.stores set plan = 'basic' where id = (select v::uuid from t_out where k='store');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'ctx1', $$select public.ask_shop_context((select v::uuid from t_out where k='store'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='ctx1' and v is null$$, 1, 'switched on but on the Basic plan: still no context');
update public.stores set plan = 'pro' where id = (select v::uuid from t_out where k='store');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'ctx2', $$select public.ask_shop_context((select v::uuid from t_out where k='store'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='ctx2' and (v::jsonb ->> 'name') = 'Acme' and (v::jsonb ->> 'org_id') = (select v from t_out where k='org')$$, 1, 'the owner of a Pro shop with the module on gets the context');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ctx3', $$select public.ask_shop_context((select v::uuid from t_out where k='store'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='ctx3' and v is null$$, 1, 'a cashier (no report.view) gets nothing');
select t_val('00000000-0000-0000-0000-0000000000e5', 'authenticated', 'ctx4', $$select public.ask_shop_context((select v::uuid from t_out where k='store'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='ctx4' and v is null$$, 1, 'another business gets nothing');
select t_err(null, 'anon', $$select public.ask_shop_context((select v::uuid from t_out where k='store'))$$, '42501', 'anon cannot call it');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.ask_shop_enabled((select v::uuid from t_out where k='store'))$$, '42501', 'the bare module check is not callable from a browser');
do $$ begin raise notice 'ALL ASK SHOP TESTS PASSED'; end $$;
