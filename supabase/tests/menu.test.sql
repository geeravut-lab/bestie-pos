-- Menu: who may edit, shape guards, store isolation, soft delete, audit.
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
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme','Acme','restaurant')$$, 1, 'owner creates a restaurant');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','cafe')$$, 1, 'a second org exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000b2', 'Manager', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'manager' where o.name = 'Acme';
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Acme';

select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store2', $$select public.create_store((select v::uuid from t_out where k='org'), 'Second', 'cafe')::text$$);
select t_val('00000000-0000-0000-0000-0000000000e5', 'authenticated', 'oorg', $$select id::text from public.orgs where name = 'Other'$$);

-- ── categories ──
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"อาหารจานเดียว","en":"One dish"}')$$, 1, 'a manager (menu.edit) adds a category');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"x"}')$$, '42501', 'a cashier cannot add a category');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"x"}')$$, '23514', 'another org cannot add to this menu');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"en":"no thai"}')$$, '23514', 'the Thai name is required');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '"just a string"')$$, '23514', 'a name must be an object');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"ก","fr":"x"}')$$, '23514', 'unknown language keys are refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":""}')$$, '23514', 'an empty Thai name is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='oorg'), (select v::uuid from t_out where k='store'), '{"th":"x"}')$$, '23514', 'a store from another org is refused');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'cat', $$select id::text from public.menu_categories limit 1$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.menu_categories$$, 1, 'a cashier can read the menu');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.menu_categories$$, 0, 'another org sees nothing');
select t_err(null, 'anon', $$select * from public.menu_categories$$, '42501', 'anon cannot read the menu tables');

-- ── modifier groups & options ──
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$insert into public.modifier_groups (org_id, store_id, name, min_select, max_select) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"ความหวาน"}', 1, 1)$$, 1, 'add a required choose-one group');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.modifier_groups (org_id, store_id, name, min_select, max_select) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"x"}', 2, 1)$$, '23514', 'min above max is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.modifier_groups (org_id, store_id, name, min_select, max_select) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"x"}', 0, 0)$$, '23514', 'max below one is refused');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'grp', $$select id::text from public.modifier_groups limit 1$$);
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$insert into public.modifier_options (org_id, store_id, group_id, name, price_delta, channel_delta) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='grp'), '{"th":"หวานน้อย"}', -500, '{"delivery": 1000}')$$, 1, 'add an option with a negative price change and a channel override');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.modifier_options (org_id, store_id, group_id, name, channel_delta) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='grp'), '{"th":"x"}', '{"drive-thru": 100}')$$, '23514', 'unknown channel in an option is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.modifier_options (org_id, store_id, group_id, name, channel_delta) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='grp'), '{"th":"x"}', '{"qr": 10.5}')$$, '23514', 'fractions of a satang are refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.modifier_options (org_id, store_id, group_id, name, channel_delta) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='grp'), '{"th":"x"}', '{"qr": "free"}')$$, '23514', 'a non-number price is refused (and does not crash the guard)');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.modifier_options (org_id, store_id, group_id, name, price_delta) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='grp'), '{"th":"x"}', 999999999)$$, '23514', 'an absurd price change is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.modifier_options (org_id, store_id, group_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), (select v::uuid from t_out where k='grp'), '{"th":"x"}')$$, '23514', 'an option cannot sit in a group of another shop');

-- ── items ──
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, station, modifier_group_ids) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"ผัดไทย","en":"Pad Thai"}', '{"base": 8000, "delivery": 9500}', 'kitchen', array[(select v::uuid from t_out where k='grp')])$$, 1, 'a manager adds an item with a delivery price and a modifier group');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'item', $$select id::text from public.menu_items limit 1$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"x"}', '{"base": 100}')$$, '42501', 'a cashier cannot add an item');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"x"}', '{"delivery": 100}')$$, '23514', 'a base price is required');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"x"}', '{"base": -100}')$$, '23514', 'a negative price is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"x"}', '{"base": 55.5}')$$, '23514', 'a price with a fraction of a satang is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"x"}', '[100]')$$, '23514', 'prices must be an object');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, station) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"x"}', '{"base": 100}', 'garage')$$, '23514', 'an unknown station is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), (select v::uuid from t_out where k='cat'), '{"th":"x"}', '{"base": 100}')$$, '23514', 'an item cannot use a category of another shop');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, modifier_group_ids) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"x"}', '{"base": 100}', array[gen_random_uuid()])$$, '23514', 'an unknown modifier group is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, modifier_group_ids) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"x"}', '{"base": 100}', array[(select v::uuid from t_out where k='grp'), (select v::uuid from t_out where k='grp')])$$, '23514', 'the same group twice is refused');

-- ── changes, soft delete, audit ──
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$update public.menu_items set prices = '{"base": 8500}' where id = (select v::uuid from t_out where k='item')$$, 1, 'a manager changes the price');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'menu.price_change' and entity = 'menu_items' and detail = '{"from_base":8000,"to_base":8500}'$$, 1, 'the price change was audited with old and new base price');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.menu_items set prices = '{"base": 1}'$$, 0, 'a cashier cannot change prices');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$update public.menu_items set sort = 5 where id = (select v::uuid from t_out where k='item')$$, 1, 'sort order can change');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'menu.item_change' and detail = '{"op":"update"}'$$, 0, 'a sort change is not audited');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$update public.menu_items set deleted_at = now() where id = (select v::uuid from t_out where k='item')$$, 1, 'soft delete');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'menu.item_change' and detail = '{"op":"delete"}'$$, 1, 'the delete was audited');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$delete from public.menu_items$$, '42501', 'no hard delete from the browser');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'menu.item_change' and detail = '{"op":"create"}'$$, 1, 'the create was audited');
select t_rows(null, 'service_role', $$select 1 from public.modifier_options where price_delta = -500$$, 1, 'the negative option price was stored');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where entity = 'modifier_options' and action = 'menu.price_change'$$, 1, 'an option price is audited');
\echo ALL MENU TESTS PASSED
