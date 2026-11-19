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

-- ── food information: closed tag set, consistent tags, guest sees what the shop said ──
select t_rows(null, 'service_role', $$select 1 where (public.guest_menu((select v from t_out where k='tok')) -> 'items' -> 0 ->> 'verified') = 'false' and (public.guest_menu((select v from t_out where k='tok')) -> 'items' -> 0 -> 'tags') = '[]'::jsonb$$, 1, 'a new dish has no tags and is not verified');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.menu_items set tags = array['contains_shellfish','contains_egg','contains_peanut'], spice_level = 1, dietary_verified = true, highlight = true where id = (select v::uuid from t_out where k='padthai')$$, 1, 'the owner sets the food information of a dish');
select t_rows(null, 'service_role', $$select 1 from jsonb_array_elements(public.guest_menu((select v from t_out where k='tok')) -> 'items') i where i ->> 'id' = (select v from t_out where k='padthai') and i -> 'tags' ? 'contains_peanut' and (i ->> 'spice_level') = '1' and (i ->> 'verified') = 'true' and (i ->> 'highlight') = 'true'$$, 1, 'the guest menu carries tags, spice, verified and highlight');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.menu_items set tags = array['contains_unicorn'] where id = (select v::uuid from t_out where k='padthai')$$, '23514', 'a tag outside the closed list is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.menu_items set tags = array['vegetarian','contains_pork'] where id = (select v::uuid from t_out where k='padthai')$$, '23514', 'vegetarian together with pork is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.menu_items set tags = array['vegan','contains_egg'] where id = (select v::uuid from t_out where k='padthai')$$, '23514', 'vegan together with egg is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.menu_items set spice_level = 4 where id = (select v::uuid from t_out where k='padthai')$$, '23514', 'spice level 4 is refused');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.menu_items set tags = array['halal'] where id = (select v::uuid from t_out where k='padthai')$$, 0, 'a cashier cannot edit the food information (menu.edit): no row is changed');

-- ── the guest assistant switch ──
select t_rows(null, 'service_role', $$select 1 where (public.guest_table((select v from t_out where k='tok')) ->> 'ai_enabled') = 'false'$$, 1, 'the assistant is off by default');
update public.stores set module_overrides = '{"ai.guest": true}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_rows(null, 'service_role', $$select 1 where (public.guest_table((select v from t_out where k='tok')) ->> 'ai_enabled') = 'true'$$, 1, 'the owner switches it on (restaurant, Pro plan, QR ordering on)');
update public.stores set module_overrides = '{"ai.guest": true, "order.qr": false}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_rows(null, 'service_role', $$select 1 where (public.guest_table((select v from t_out where k='tok')) ->> 'ai_enabled') = 'false'$$, 1, 'it needs QR ordering');
update public.stores set module_overrides = '{"ai.guest": true}'::jsonb, plan = 'basic' where id = (select v::uuid from t_out where k='store');
select t_rows(null, 'service_role', $$select 1 where (public.guest_table((select v from t_out where k='tok')) ->> 'ai_enabled') = 'false'$$, 1, 'it needs the Pro plan');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.guest_ai_enabled((select v::uuid from t_out where k='store'))$$, '42501', 'the browser cannot ask the internal switch');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 where public.can_edit_menu((select v::uuid from t_out where k='store'))$$, 1, 'the owner may draft food information');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where not public.can_edit_menu((select v::uuid from t_out where k='store'))$$, 1, 'a cashier may not');
select t_err(null, 'anon', $$select public.can_edit_menu(gen_random_uuid())$$, '42501', 'nobody anonymous may');
\echo ALL FOOD TAG TESTS PASSED
