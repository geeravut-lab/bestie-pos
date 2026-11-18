-- Demo menu: only for empty restaurant / cafe shops, only with menu.edit, audited, all rows pass the menu guards.
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
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme Co','Acme','restaurant')$$, 1, 'owner creates a restaurant');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','cafe')$$, 1, 'a second org exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o
  join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Acme Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Acme Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'rest', $$select id::text from public.stores where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'cafe', $$select public.create_store((select v::uuid from t_out where k='org'), 'Beach Cafe', 'cafe')::text$$);
select t_val('00000000-0000-0000-0000-0000000000e5', 'authenticated', 'foreign', $$select id::text from public.stores where name = 'Other'$$);

select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.seed_demo_menu((select v::uuid from t_out where k='rest'))$$, '42501', 'a cashier (no menu.edit) cannot load a demo menu');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.seed_demo_menu((select v::uuid from t_out where k='foreign'))$$, '42501', 'nobody can fill another org''s shop');
select t_err(null, 'anon', $$select public.seed_demo_menu((select v::uuid from t_out where k='rest'))$$, '42501', 'anon cannot');

select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'r1', $$select public.seed_demo_menu((select v::uuid from t_out where k='rest'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r1' and (v::jsonb ->> 'items') = '13' and (v::jsonb ->> 'tables') = '10'$$, 1, 'a restaurant gets 13 items and 10 tables');
select t_rows(null, 'service_role', $$select 1 from public.menu_items where store_id = (select v::uuid from t_out where k='rest') and deleted_at is null having count(*) = 13$$, 1, '13 items exist');
select t_rows(null, 'service_role', $$select 1 from public.menu_categories where store_id = (select v::uuid from t_out where k='rest') having count(*) = 4$$, 1, '4 categories');
select t_rows(null, 'service_role', $$select 1 from public.dining_tables where store_id = (select v::uuid from t_out where k='rest') having count(*) = 10$$, 1, '10 tables');
select t_rows(null, 'service_role', $$select 1 from public.menu_items where store_id = (select v::uuid from t_out where k='rest') and station is not null having count(*) = 13$$, 1, 'every item has a station (so the kitchen / bar screens see it)');
select t_rows(null, 'service_role', $$select 1 from public.menu_items i where store_id = (select v::uuid from t_out where k='rest') and exists (select 1 from unnest(i.modifier_group_ids) g where not exists (select 1 from public.modifier_groups m where m.id = g))$$, 0, 'every linked option group exists');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'menu.item_change' and detail ->> 'demo' = 'true'$$, 1, 'the load is audited');

select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.seed_demo_menu((select v::uuid from t_out where k='rest'))$$, '22023', 'a shop that already has a menu is never touched');

select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'c1', $$select public.seed_demo_menu((select v::uuid from t_out where k='cafe'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='c1' and (v::jsonb ->> 'items') = '10' and (v::jsonb ->> 'tables') = '0'$$, 1, 'a cafe gets 10 items and no tables');
select t_rows(null, 'service_role', $$select 1 from public.dining_tables where store_id = (select v::uuid from t_out where k='cafe')$$, 0, 'a cafe has no floor plan');
\echo ALL DEMO MENU TESTS PASSED
