-- Smart operations: forecast, waste, lots, cost alerts, service cases, business manager, ETA, disputes and refunds.
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




-- the shop's calendar day (Bangkok) moves every day: the fixtures are placed relative to TODAY so this test never goes stale
create or replace function t_d(n int) returns date language sql as $$ select (now() at time zone 'Asia/Bangkok')::date + n $$;
create or replace function t_ds(n int) returns text language sql as $$ select ((now() at time zone 'Asia/Bangkok')::date + n)::text $$;
create or replace function t_ts(n int, hhmm text) returns timestamptz language sql as $$ select (((now() at time zone 'Asia/Bangkok')::date + n)::text || ' ' || hhmm || ':00+07')::timestamptz $$;
grant execute on function t_d(int), t_ds(int), t_ts(int, text) to anon, authenticated, service_role;

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

-- ═══ platform flags ═══
insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-0000000000a1');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.appointments_enabled((select v::uuid from t_out where k='store'))$$, 1, 'a function exists to ask');
update public.stores set plan = 'pro', module_overrides = module_overrides || '{"kiosk": true, "marketing": true}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_rows(null, 'service_role', $$select 1 where public.kiosk_enabled((select v::uuid from t_out where k='store')) and public.marketing_enabled((select v::uuid from t_out where k='store'))$$, 1, 'kiosk and marketing are on in the shop');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_platform_flag('{"module_id":"kiosk","enabled":false}'::jsonb)$$, '42501', 'a cashier cannot switch a module off for the platform');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.platform_flags_overview()$$, '42501', 'a manager cannot read the overview');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.set_platform_flag('{"module_id":"Bad Id","enabled":false}'::jsonb)$$, '22023', 'a bad module id is refused');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.set_platform_flag('{"module_id":"kiosk","enabled":false,"reason":"bug found"}'::jsonb)$$, 1, 'the platform administrator switches kiosk off for everybody');
select t_rows(null, 'service_role', $$select 1 where not public.kiosk_enabled((select v::uuid from t_out where k='store'))$$, 1, 'the database mirror says off although the shop switched it on');
select t_rows(null, 'service_role', $$select 1 where public.marketing_enabled((select v::uuid from t_out where k='store'))$$, 1, 'another module is untouched');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.platform_flags where module_id = 'kiosk'$$, 1, 'every signed-in screen can see what is off');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'ov', $$select public.platform_flags_overview()::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb -> 'modules') e where o.k='ov' and (e ->> 'module_id') = 'kiosk' and (e ->> 'killed') = 'true' and (e ->> 'db_enforced') = 'true' and (e ->> 'on_count') = '1'$$, 1, 'the overview: kiosk killed, enforced in the database, on in one shop');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.set_platform_flag('{"module_id":"kiosk","enabled":true}'::jsonb)$$, 1, 'switched back on');
select t_rows(null, 'service_role', $$select 1 where public.kiosk_enabled((select v::uuid from t_out where k='store'))$$, 1, 'the shop''s own switch decides again');
select t_rows(null, 'service_role', $$select 1 from public.platform_flag_enforced where module_id in ('kiosk', 'appointments', 'marketing', 'stamps', 'waitlist') having count(*) = 5$$, 1, 'the mirrors of the new modules were patched');

-- ═══ analytics ═══
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.track_event('active')$$, 1, 'a visit is counted');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.track_event('active')$$, 1, 'a second one the same day is ignored (never an error)');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.track_event('active')$$, 1, 'a second person');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.track_event('page_view', 'reports')$$, 1, 'a screen is counted');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.track_event('page_view', 'reports')$$, 1, 'by another person');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.track_event('page_view', 'Bad Name; drop table x')$$, 1, 'a bad name is dropped silently');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.track_event('signup')$$, 1, 'an unknown event is dropped silently');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.product_events) = 4$$, 1, 'four rows: 2 active, 2 reports, nothing else');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.product_events$$, '42501', 'the browser cannot read the events');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.admin_analytics(30)$$, '42501', 'a cashier cannot read the analytics');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'an', $$select public.admin_analytics(14)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='an' and (v::jsonb ->> 'dau') = '2' and (v::jsonb ->> 'wau') = '2' and (v::jsonb ->> 'mau') = '2' and jsonb_array_length(v::jsonb -> 'series') = 14 and (v::jsonb -> 'top_pages' -> 0 ->> 'page') = 'reports' and (v::jsonb -> 'top_pages' -> 0 ->> 'users') = '2'$$, 1, 'DAU / WAU / MAU = 2, 14 days of series, reports is the top screen with 2 people');
select t_rows(null, 'service_role', $$select 1 from t_out where k='an' and (v::jsonb ->> 'businesses') = '2' and (v::jsonb ->> 'shops') = '3' and (v::jsonb -> 'retention_d7') = 'null'::jsonb$$, 1, 'two businesses, three shops, retention still unknown');
-- retention: Anna first seen 10 days ago and again 3 days after → returned
select t_rows(null, 'service_role', $$insert into public.product_events (user_id, event, day) values ('00000000-0000-0000-0000-0000000000e5', 'active', t_d(-10)), ('00000000-0000-0000-0000-0000000000e5', 'active', t_d(-7)), ('00000000-0000-0000-0000-0000000000b2', 'active', t_d(-9))$$, 3, 'older history');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'an2', $$select public.admin_analytics(30)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='an2' and (v::jsonb ->> 'retention_d7') = '50'$$, 1, 'D7 retention: one of two older people came back within a week = 50');

\echo ALL PLATFORM FLAGS TESTS PASSED
