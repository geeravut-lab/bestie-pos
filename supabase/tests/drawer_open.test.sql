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
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'stranger@example.test');
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




select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role) values ((select org_id from public.stores where id = (select v::uuid from t_out where k='store')), (select v::uuid from t_out where k='store'), 'Counter', 'cashier') returning id::text$$);
select t_err(null, 'anon', $$select public.record_drawer_open((select v::uuid from t_out where k='dev'), array[now()])$$, '42501', 'anon cannot');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.record_drawer_open((select v::uuid from t_out where k='dev'), array[now()])$$, '42501', 'another business cannot');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'n1', $$select public.record_drawer_open((select v::uuid from t_out where k='dev'), array[now(), now() - interval '10 minutes'])::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='n1' and v = '2'$$, 1, 'a cashier (payment.take) records two openings');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'drawer.open'$$, 2, 'they are in the audit log');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'n2', $$select public.record_drawer_open((select v::uuid from t_out where k='dev'), array[now() + interval '1 hour', now() - interval '5 days'])::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='n2' and v = '0'$$, 1, 'a timestamp in the future or older than 2 days is not accepted');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'n3', $$select public.record_drawer_open((select v::uuid from t_out where k='dev'), array[now()])::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='n3' and v = '1'$$, 1, 'the owner can too');
do $$ begin raise notice 'ALL DRAWER TESTS PASSED'; end $$;
