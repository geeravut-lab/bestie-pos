-- RLS / guard tests for 20261117000001_foundation.sql. Run by supabase/tests/run-local.sh.
\set ON_ERROR_STOP on
\set QUIET on

create function t_exec(uid uuid, role_name text, q text) returns bigint language plpgsql as $$
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

create function t_rows(uid uuid, role_name text, q text, expected bigint, label text) returns void language plpgsql as $$
declare n bigint;
begin
  n := t_exec(uid, role_name, q);
  if n is distinct from expected then raise exception 'FAIL % — expected % rows, got %', label, expected, n; end if;
  raise notice 'PASS %', label;
end $$;

create function t_err(uid uuid, role_name text, q text, state text, label text) returns void language plpgsql as $$
begin
  begin
    perform t_exec(uid, role_name, q);
  exception when others then
    if sqlstate = state then raise notice 'PASS %', label; return; end if;
    raise exception 'FAIL % — expected SQLSTATE %, got % (%)', label, state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL % — expected an error (%), none raised', label, state;
end $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner-a@example.test', '{"full_name":"Owner A","picture":"https://x/y.png"}'),
  ('00000000-0000-0000-0000-0000000000b2', 'owner-b@example.test', '{}'),
  ('00000000-0000-0000-0000-0000000000c3', 'manager@example.test', '{}'),
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test', '{}'),
  ('00000000-0000-0000-0000-0000000000e5', 'admin@example.test', '{}');

select t_rows(null, 'service_role', $$select 1 from public.profiles$$, 5, 'new auth users get profiles');
select t_rows(null, 'service_role', $$select 1 from public.profiles where display_name = 'Owner A' and avatar_url is not null$$, 1, 'profile filled from provider metadata');

-- onboarding
select t_err(null, 'authenticated', $$select * from public.create_org('X','X','cafe')$$, '28000', 'create_org needs a signed-in user');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('X','X','bakery')$$, '22023', 'create_org rejects unknown profile');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme Cafe Co','Acme Cafe','cafe')$$, 1, 'owner A creates org A');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select * from public.create_org('Beta Restaurant','Beta','restaurant')$$, 1, 'owner B creates org B');

do $$ begin
  if (select count(*) from public.roles) <> 10 then raise exception 'FAIL built-in roles'; end if;
  if (select service_charge_bps from public.stores where name = 'Beta') <> 1000 then raise exception 'FAIL restaurant default service charge'; end if;
  if (select service_charge_bps from public.stores where name = 'Acme Cafe') <> 0 then raise exception 'FAIL cafe default service charge'; end if;
  raise notice 'PASS onboarding creates 5 roles per org, entity, store and owner staff';
end $$;

-- tenant isolation
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.orgs$$, 1, 'A sees only org A');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.stores$$, 1, 'A sees only its store');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.staff$$, 1, 'A sees only its staff');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select 1 from public.roles$$, 5, 'B sees only its 5 roles');
select t_rows('00000000-0000-0000-0000-0000000000c3', 'authenticated', $$select 1 from public.orgs$$, 0, 'non-member sees nothing');
select t_err(null, 'anon', $$select 1 from public.orgs$$, '42501', 'anon cannot read orgs');
select t_err(null, 'anon', $$select 1 from public.stores$$, '42501', 'anon cannot read stores');
select t_rows(null, 'anon', $$select 1 from public.platform_settings$$, 1, 'anon can read platform settings (brand on login page)');
select t_err(null, 'anon', $$update public.platform_settings set brand = '{"name_en":"x"}'$$, '42501', 'anon cannot update platform settings');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.orgs set name = 'Hacked' where name = 'Beta Restaurant'$$, 0, 'A cannot update org B');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.stores set name = 'Hacked' where name = 'Beta'$$, 0, 'A cannot update store B');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.orgs (name) values ('Direct insert')$$, '42501', 'no direct org inserts (must use create_org)');

-- legal gate + platform tables
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.orgs set legal_sign_off = '{"cryptoTopup": true}' where name = 'Acme Cafe Co'$$, '42501', 'owner cannot self-grant crypto legal sign-off');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.orgs set name = 'Acme Cafe Company' where name = 'Acme Cafe Co'$$, 1, 'owner can rename org');
select t_rows(null, 'service_role', $$update public.orgs set legal_sign_off = '{"cryptoTopup": true}' where name = 'Acme Cafe Company'$$, 1, 'service_role can record legal sign-off');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.platform_admins$$, '42501', 'platform_admins is not readable by clients');

-- staff, roles and privilege escalation
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000c3', 'Manager', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'manager' where o.name = 'Acme Cafe Company';
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Acme Cafe Company';

select t_rows('00000000-0000-0000-0000-0000000000c3', 'authenticated', $$select 1 from public.staff$$, 3, 'manager sees the org staff');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.stores set name = 'Cashier edit'$$, 0, 'cashier cannot edit store settings');
select t_rows('00000000-0000-0000-0000-0000000000c3', 'authenticated', $$update public.stores set name = 'Manager edit'$$, 0, 'manager lacks settings.manage');
select t_err('00000000-0000-0000-0000-0000000000c3', 'authenticated',
  $$update public.staff set role_id = (select id from public.roles where built_in = 'owner' and org_id = staff.org_id) where display_name = 'Manager'$$,
  '42501', 'manager cannot promote self to owner');
select t_err('00000000-0000-0000-0000-0000000000c3', 'authenticated',
  $$insert into public.staff (org_id, user_id, display_name, role_id) select org_id, '00000000-0000-0000-0000-0000000000e5', 'Sneaky', id from public.roles where built_in = 'owner' and org_id = (select id from public.orgs limit 1)$$,
  '42501', 'manager cannot hand out the owner role');
select t_rows('00000000-0000-0000-0000-0000000000c3', 'authenticated', $$update public.staff set active = false where display_name = 'Cashier'$$, 1, 'manager can deactivate a cashier');
select t_rows('00000000-0000-0000-0000-0000000000c3', 'authenticated', $$update public.staff set active = false where display_name = 'Owner A'$$, 0, 'manager cannot touch the owner row');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.staff set active = false where display_name = 'Owner A'$$, '23514', 'the last owner cannot be deactivated');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$delete from public.staff where display_name = 'Owner A'$$, '23514', 'the last owner cannot be deleted');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$delete from public.roles where built_in = 'owner'$$, 0, 'built-in roles are invisible to client writes');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.roles (org_id, name, permissions) select id, 'Barista', array['order.create'] from public.orgs$$, 1, 'owner can create a custom role');

-- cross-org legal entity is rejected (Credit scope depends on it)
select t_err(null, 'service_role',
  $$insert into public.stores (org_id, legal_entity_id, name, profile) select a.id, le.id, 'Mismatch', 'cafe' from public.orgs a, public.legal_entities le join public.orgs b on b.id = le.org_id where a.name = 'Acme Cafe Company' and b.name = 'Beta Restaurant'$$,
  '23514', 'store cannot use another org''s legal entity');

-- profiles
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.profiles set language = 'en' where user_id = auth.uid()$$, 1, 'user can update own profile');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.profiles set display_name = 'x' where user_id <> auth.uid()$$, 0, 'user cannot update others'' profiles');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.profiles$$, 1, 'user reads only own profile');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.profiles set language = 'fr' where user_id = auth.uid()$$, '23514', 'language is constrained');

-- platform settings: only platform admins write
insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-0000000000e5');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.platform_settings set brand = '{"name_en":"Hacked"}'$$, 0, 'org owner cannot change platform settings');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$update public.platform_settings set brand = '{"name_en":"Bestie"}'$$, 1, 'platform admin can change platform settings');

-- constraint spot checks
select t_err(null, 'service_role', $$update public.stores set vat_bps = 20000$$, '23514', 'vat_bps is bounded');
select t_err(null, 'service_role', $$update public.stores set branch_code = '12'$$, '23514', 'branch code is 5 digits');
select t_err(null, 'service_role', $$update public.legal_entities set tax_id = '123'$$, '23514', 'tax id is 13 digits');

\echo ALL FOUNDATION TESTS PASSED
