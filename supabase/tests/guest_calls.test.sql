-- Food tags: token is the only key, prices / options are computed by the database, replay-safe, rate-limited.
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

-- QR service is on for the demo restaurant (pro plan, restaurant profile)
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c9', 'waiter@example.test') on conflict do nothing;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000e5', 'other@example.test') on conflict do nothing;
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000c9', 'Waiter', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'waiter' where o.name = 'Acme Co';

select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.guest_call_staff((select v from t_out where k='tok'), 'help')$$, '42501', 'the browser cannot press the guest button');
select t_err(null, 'service_role', $$select public.guest_call_staff('nope', 'help')$$, 'P0002', 'an unknown token finds no table');
select t_err(null, 'service_role', $$select public.guest_call_staff((select v from t_out where k='tok'), 'free text here')$$, '22023', 'only the closed reasons are accepted');
select t_val(null, 'service_role', 'call', $$select public.guest_call_staff((select v from t_out where k='tok'), 'help')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='call' and (v::jsonb ->> 'status') = 'called'$$, 1, 'a guest calls the staff');
select t_val(null, 'service_role', 'again', $$select public.guest_call_staff((select v from t_out where k='tok'), 'bill')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='again' and (v::jsonb ->> 'status') = 'already' and (v::jsonb ->> 'id') = (select (v::jsonb ->> 'id') from t_out where k='call')$$, 1, 'tapping again does not add a second call');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.guest_calls where status = 'open') = 1$$, 1, 'one open call');

-- staff hear about it, in the app only
do $$ begin
  if (select count(*) from public.app_notifications where kind = 'guest.call' and user_id = '00000000-0000-0000-0000-0000000000a1') <> 1 then raise exception 'FAIL owner told'; end if;
  if (select count(*) from public.app_notifications where kind = 'guest.call' and user_id = '00000000-0000-0000-0000-0000000000c9') <> 1 then raise exception 'FAIL waiter told'; end if;
  if (select count(*) from public.app_notifications where kind = 'guest.call' and user_id = '00000000-0000-0000-0000-0000000000d4') <> 1 then raise exception 'FAIL cashier told'; end if;
  if (select count(*) from public.notification_queue where kind = 'guest.call') <> 0 then raise exception 'FAIL calls must not use the LINE quota'; end if;
  raise notice 'PASS owner, cashier and waiter are told in the app; no LINE message is queued';
end $$;

-- who sees and answers
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select * from public.guest_calls$$, 1, 'a cashier of the shop sees the call');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.guest_calls$$, 0, 'another org sees nothing');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.answer_guest_call((select (v::jsonb ->> 'id')::uuid from t_out where k='call'))$$, '42501', 'another org cannot answer it');
select t_rows('00000000-0000-0000-0000-0000000000c9', 'authenticated', $$select public.answer_guest_call((select (v::jsonb ->> 'id')::uuid from t_out where k='call'))$$, 1, 'a waiter answers it');
select t_rows(null, 'service_role', $$select 1 from public.guest_calls where status = 'answered' and answered_at is not null and answered_by is not null$$, 1, 'it is answered, with who and when');
select t_rows('00000000-0000-0000-0000-0000000000c9', 'authenticated', $$select public.answer_guest_call((select (v::jsonb ->> 'id')::uuid from t_out where k='call'))$$, 1, 'answering twice is harmless');
select t_val(null, 'service_role', 'call2', $$select public.guest_call_staff((select v from t_out where k='tok'), 'bill')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='call2' and (v::jsonb ->> 'status') = 'called'$$, 1, 'once answered, the table can call again');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.guest_calls set status = 'answered'$$, '42501', 'status cannot be changed directly');

-- the shop switched QR off: no calls
update public.stores set module_overrides = '{"order.qr": false}' where id = (select v::uuid from t_out where k='store');
select t_err(null, 'service_role', $$select public.guest_call_staff((select v from t_out where k='tok2'), 'help')$$, '0A000', 'with QR service off the button is refused');
\echo ALL GUEST CALL TESTS PASSED
