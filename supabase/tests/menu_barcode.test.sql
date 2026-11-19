-- Barcode / SKU on menu items and options: format, one use per shop across items and options, other shops are free.
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







create or replace function t_leg_cash(id text, amount bigint, tendered bigint) returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'tender', 'cash', 'amount', amount, 'tendered', tendered, 'change', tendered - amount) $$;
grant execute on function t_leg_cash(text, bigint, bigint) to authenticated, service_role;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Shop Co','Shop','restaurant')$$, 1, 'owner creates a shop');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','restaurant')$$, 1, 'another business exists');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Shop Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Shop'$$);
select t_val('00000000-0000-0000-0000-0000000000e5', 'authenticated', 'ostore', $$select id::text from public.stores where name = 'Other'$$);
select t_val(null, 'service_role', 'ocat', $$insert into public.menu_categories (org_id, store_id, name) values ((select org_id from public.stores where name = 'Other'), (select v::uuid from t_out where k='ostore'), '{"th":"x"}') returning id::text$$);
select t_val(null, 'service_role', 'cat', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"x"}') returning id::text$$);
select t_val(null, 'service_role', 'grp', $$insert into public.modifier_groups (org_id, store_id, name, min_select, max_select) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"ไซส์"}', 1, 1) returning id::text$$);
create or replace function t_item(bc text, sku text default null, store_key text default 'store', cat_key text default 'cat') returns text language sql as $$
  select format($f$insert into public.menu_items (org_id, store_id, category_id, name, prices, barcode, sku) values ((select org_id from public.stores where id = (select v::uuid from t_out where k=%L)), (select v::uuid from t_out where k=%L), (select v::uuid from t_out where k=%L), '{"th":"เสื้อ"}', '{"base": 29900}', %L, %L) returning id::text$f$, store_key, store_key, cat_key, bc, sku) $$;
grant execute on function t_item(text, text, text, text) to authenticated, service_role;
create or replace function t_opt(bc text) returns text language sql as $$
  select format($f$insert into public.modifier_options (org_id, store_id, group_id, name, price_delta, barcode) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='grp'), '{"th":"L"}', 1000, %L) returning id::text$f$, bc) $$;
grant execute on function t_opt(text) to authenticated, service_role;

-- format
select t_err(null, 'service_role', t_item('abc'), '23514', 'a barcode needs at least 4 characters');
select t_err(null, 'service_role', t_item('has space 1'), '23514', 'a barcode has no spaces');
select t_err(null, 'service_role', t_item('TEE-0001', 'bad sku!'), '23514', 'a SKU has only letters, digits and dashes');
select t_val(null, 'service_role', 'i1', t_item('TEE-0001', 'TEE'));
select t_rows(null, 'service_role', $$select 1 from public.menu_items where id = (select v::uuid from t_out where k='i1') and barcode = 'TEE-0001' and sku = 'TEE'$$, 1, 'an item keeps its barcode and SKU');

-- one use per shop, across items and options, ignoring case
select t_err(null, 'service_role', t_item('tee-0001'), '23505', 'a second item cannot take the same barcode (any letter case)');
select t_err(null, 'service_role', t_opt('TEE-0001'), '23505', 'an option cannot take an item''s barcode');
select t_val(null, 'service_role', 'o1', t_opt('TEE-L-0002'));
select t_err(null, 'service_role', t_item('TEE-L-0002'), '23505', 'an item cannot take an option''s barcode');
select t_err(null, 'service_role', t_opt('tee-l-0002'), '23505', 'two options cannot share a barcode');
select t_rows(null, 'service_role', $$update public.menu_items set barcode = 'TEE-0001', name = '{"th":"เสื้อใหม่"}' where id = (select v::uuid from t_out where k='i1')$$, 1, 'saving an item with its own barcode is fine');
select t_rows(null, 'service_role', $$select 1 where t_item('NEW-0001') is not null$$, 1, 'a new code is free');

-- another shop is independent; a deleted row frees its code
select t_val(null, 'service_role', 'x1', t_item('TEE-0001', null, 'ostore', 'ocat'));
select t_rows(null, 'service_role', $$update public.menu_items set deleted_at = now() where id = (select v::uuid from t_out where k='i1')$$, 1, 'the first item is deleted');
select t_val(null, 'service_role', 'i2', t_item('TEE-0001'));
select t_rows(null, 'service_role', $$select 1 from public.menu_items where id = (select v::uuid from t_out where k='i2')$$, 1, 'its code can be used again');
select t_err(null, 'service_role', $$update public.menu_items set deleted_at = null where id = (select v::uuid from t_out where k='i1')$$, '23505', 'bringing the deleted item back is refused while the code is taken');

select 'ALL MENU BARCODE TESTS PASSED';
