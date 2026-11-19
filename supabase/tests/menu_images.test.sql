-- Menu pictures: who may save one, what is accepted, versions, removal, the guest menu, no direct table access.
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
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Pic Co','Pic','restaurant')$$, 1, 'owner creates a shop');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','restaurant')$$, 1, 'another business exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Pic Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Pic Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Pic'$$);
select t_val(null, 'service_role', 'cat', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"x"}') returning id::text$$);
select t_val(null, 'service_role', 'item', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"ผัดไทย"}', '{"base": 8000}') returning id::text$$);
select t_val(null, 'service_role', 'table', $$insert into public.dining_tables (org_id, store_id, name, seats) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'T1', 4) returning qr_token$$);

-- a tiny but valid-looking JPEG / PNG / WebP header + padding (the check is on the first bytes and the size)
create or replace function t_pic(kind text, n int default 300) returns text language sql as $$
  select encode(case kind
    when 'jpeg' then '\xffd8ffe0'::bytea
    when 'png'  then '\x89504e470d0a1a0a'::bytea
    when 'webp' then '\x52494646'::bytea || '\x00000000'::bytea || '\x57454250'::bytea
    else '\x25504446'::bytea end || decode(repeat('ab', n), 'hex'), 'base64') $$;
grant execute on function t_pic(text, int) to authenticated, service_role;

select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_menu_image((select v::uuid from t_out where k='item'), 'image/jpeg', t_pic('jpeg'))$$, '42501', 'a cashier (no menu.edit) cannot set a picture');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.save_menu_image((select v::uuid from t_out where k='item'), 'image/jpeg', t_pic('jpeg'))$$, '42501', 'another business cannot');
select t_err(null, 'anon', $$select public.save_menu_image((select v::uuid from t_out where k='item'), 'image/jpeg', t_pic('jpeg'))$$, '42501', 'nor the public key');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_menu_image((select v::uuid from t_out where k='item'), 'image/jpeg', t_pic('pdf'))$$, '22023', 'a PDF is not a JPEG');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_menu_image((select v::uuid from t_out where k='item'), 'image/png', t_pic('jpeg'))$$, '22023', 'a JPEG declared as PNG is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_menu_image((select v::uuid from t_out where k='item'), 'image/svg+xml', t_pic('jpeg'))$$, '22023', 'SVG is never accepted (it can carry script)');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_menu_image((select v::uuid from t_out where k='item'), 'image/jpeg', t_pic('jpeg', 270000))$$, '22023', 'more than 256 KB is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_menu_image((select v::uuid from t_out where k='item'), 'image/jpeg', '!!!not base64!!!')$$, '22023', 'garbage is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_menu_image(gen_random_uuid(), 'image/jpeg', t_pic('jpeg'))$$, '42501', 'an unknown item has no picture');

select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'v1', $$select public.save_menu_image((select v::uuid from t_out where k='item'), 'image/jpeg', t_pic('jpeg'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='v1' and v = '1'$$, 1, 'the first picture is version 1');
select t_rows(null, 'service_role', $$select 1 from public.menu_items where id = (select v::uuid from t_out where k='item') and image_v = 1$$, 1, 'the item knows its picture version');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'v2', $$select public.save_menu_image((select v::uuid from t_out where k='item'), 'image/webp', t_pic('webp'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='v2' and v = '2'$$, 1, 'a new picture is version 2 (a new address, so no old copy is shown)');
select t_rows(null, 'service_role', $$select 1 from public.menu_item_images where item_id = (select v::uuid from t_out where k='item') and mime = 'image/webp' and version = 2$$, 1, 'one row per item (replaced)');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'settings.change' and entity = 'menu_item_images' having count(*) = 2$$, 1, 'each change is audited');

-- nobody reads the table directly
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.menu_item_images$$, '42501', 'the owner cannot select the table (the server function serves pictures)');
select t_err(null, 'anon', $$select public.menu_image_get((select v::uuid from t_out where k='item'))$$, '42501', 'the public key cannot call the server read');
select t_rows(null, 'service_role', $$select 1 where (public.menu_image_get((select v::uuid from t_out where k='item')) ->> 'mime') = 'image/webp' and (public.menu_image_get((select v::uuid from t_out where k='item')) ->> 'b64') !~ E'\\n'$$, 1, 'the server read returns the picture as one base64 line');

-- the guest menu shows the version
select t_rows(null, 'service_role', $$select 1 where ((public.guest_menu((select v from t_out where k='table')) -> 'items') -> 0 ->> 'image_v') = '2'$$, 1, 'the guest menu carries image_v');

-- removing
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.remove_menu_image((select v::uuid from t_out where k='item'))$$, '42501', 'a cashier cannot remove it');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.remove_menu_image((select v::uuid from t_out where k='item'))$$, 1, 'the owner removes it');
select t_rows(null, 'service_role', $$select 1 from public.menu_items where id = (select v::uuid from t_out where k='item') and image_v is null$$, 1, 'no version any more');
select t_rows(null, 'service_role', $$select 1 from public.menu_item_images$$, 0, 'and no bytes kept');
select t_rows(null, 'service_role', $$select 1 where public.menu_image_get((select v::uuid from t_out where k='item')) is null$$, 1, 'the server read finds nothing');
-- a deleted item's picture goes with the item row; a soft-deleted item is not served
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'v3', $$select public.save_menu_image((select v::uuid from t_out where k='item'), 'image/png', t_pic('png'))::text$$);
select t_rows(null, 'service_role', $$update public.menu_items set deleted_at = now() where id = (select v::uuid from t_out where k='item')$$, 1, 'the item is soft-deleted');
select t_rows(null, 'service_role', $$select 1 where public.menu_image_get((select v::uuid from t_out where k='item')) is null$$, 1, 'a deleted dish''s picture is not served');
select 'ALL MENU IMAGES TESTS PASSED';
