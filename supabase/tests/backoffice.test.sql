-- Back office: add shop, module guard, staff invites, PINs, devices.
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
  ('00000000-0000-0000-0000-0000000000c3', 'newbie@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme','Acme','restaurant')$$, 1, 'owner creates a restaurant');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','cafe')$$, 1, 'a second org exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000b2', 'Manager', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'manager' where o.name = 'Acme';
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Acme';

-- ── add a shop ──
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'acme', $$select id::text from public.orgs where name = 'Acme'$$);
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.create_store((select v::uuid from t_out where k='acme'), 'Beach Cafe', 'cafe')$$, 1, 'owner adds a cafe');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.stores where name = 'Beach Cafe' and service_charge_bps = 0$$, 1, 'the cafe has no service charge by default');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.create_store((select v::uuid from t_out where k='acme'), 'Sneaky', 'cafe')$$, '42501', 'a cashier cannot add a shop');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.create_store((select v::uuid from t_out where k='acme'), 'Sneaky', 'cafe')$$, '42501', 'another org cannot add a shop to Acme');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.create_store((select v::uuid from t_out where k='acme'), 'X', 'casino')$$, '22023', 'unknown profile is refused');
select t_err(null, 'anon', $$select public.create_store((select v::uuid from t_out where k='acme'), 'Anon', 'cafe')$$, '42501', 'anon cannot call create_store');

-- ── module overrides guard ──
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.stores set module_overrides = '{"kds": false, "queue.call": true}' where name = 'Acme'$$, 1, 'owner toggles known modules');
select t_err(null, 'service_role', $$update public.stores set module_overrides = '{"warp.drive": true}' where name = 'Acme'$$, '23514', 'unknown module id is refused');
select t_err(null, 'service_role', $$update public.stores set module_overrides = '{"kds": "yes"}' where name = 'Acme'$$, '23514', 'non-boolean value is refused');
select t_err(null, 'service_role', $$update public.stores set module_overrides = '{"credit.topup.crypto": true}' where name = 'Acme'$$, '23514', 'crypto top-up is refused without the legal sign-off');
select t_rows(null, 'service_role', $$update public.orgs set legal_sign_off = '{"cryptoTopup": true}' where name = 'Acme'$$, 1, 'sign-off recorded by the platform');
select t_rows(null, 'service_role', $$update public.stores set module_overrides = '{"credit.topup.crypto": true}' where name = 'Acme'$$, 1, 'crypto top-up allowed once the sign-off exists');
select t_rows(null, 'service_role', $$update public.stores set module_overrides = '{}'$$, 3, 'reset overrides');

-- ── staff invites ──
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'role_cashier', $$select id::text from public.roles where built_in='cashier' and org_id = (select v::uuid from t_out where k='acme')$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'role_owner', $$select id::text from public.roles where built_in='owner' and org_id = (select v::uuid from t_out where k='acme')$$);
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'code', $$select public.create_staff_invite((select v::uuid from t_out where k='acme'), null, (select v::uuid from t_out where k='role_cashier'), 'Nok')$$);
select t_rows(null, 'service_role', $$select 1 from public.staff_invites where code_hash = sha256(convert_to((select v from t_out where k='code'), 'utf8'))$$, 1, 'a manager creates an invite; only the hash is stored');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.create_staff_invite((select v::uuid from t_out where k='acme'), null, (select v::uuid from t_out where k='role_owner'), 'Evil')$$, '42501', 'a manager cannot invite an owner');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.create_staff_invite((select v::uuid from t_out where k='acme'), null, (select v::uuid from t_out where k='role_cashier'), 'Nope')$$, '42501', 'a cashier cannot invite');
select t_err('00000000-0000-0000-0000-0000000000c3', 'authenticated', $$select public.accept_staff_invite('WRONGCODE000')$$, 'P0002', 'a wrong code is refused');
select t_rows('00000000-0000-0000-0000-0000000000c3', 'authenticated', $$select public.accept_staff_invite((select v from t_out where k='code'))$$, 1, 'the invitee joins with the code');
select t_rows(null, 'service_role', $$select 1 from public.staff where user_id = '00000000-0000-0000-0000-0000000000c3' and display_name = 'Nok' and active$$, 1, 'the staff row exists');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.accept_staff_invite((select v from t_out where k='code'))$$, 'P0002', 'the code works only once');
select t_err(null, 'anon', $$select public.accept_staff_invite('ABC')$$, '42501', 'anon cannot redeem');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.staff_invites$$, 0, 'a cashier cannot read invites');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.staff_invites$$, 1, 'the owner can read invites');
select t_rows(null, 'service_role', $$update public.staff_invites set expires_at = now() - interval '1 day'$$, 1, 'expire the invite (test only)');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'code2', $$select public.create_staff_invite((select v::uuid from t_out where k='acme'), null, (select v::uuid from t_out where k='role_cashier'), 'Late')$$);
select t_rows(null, 'service_role', $$update public.staff_invites set expires_at = now() - interval '1 day' where display_name = 'Late'$$, 1, 'expire second invite');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.accept_staff_invite((select v from t_out where k='code2'))$$, 'P0002', 'an expired invite is refused');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.revoke_staff_invite((select id from public.staff_invites where display_name='Late'))$$, 1, 'owner revokes an invite');

-- ── PINs ──
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'staff_nok', $$select id::text from public.staff where display_name = 'Nok'$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_staff_pin((select v::uuid from t_out where k='staff_nok'), '1234')$$, '42501', 'a cashier cannot set a PIN');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.set_staff_pin((select v::uuid from t_out where k='staff_nok'), '12')$$, '22023', 'a short PIN is refused');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.set_staff_pin((select v::uuid from t_out where k='staff_nok'), 'abcd')$$, '22023', 'a non-numeric PIN is refused');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.set_staff_pin((select v::uuid from t_out where k='staff_nok'), '4821')$$, 1, 'a manager sets a PIN');
select t_rows(null, 'service_role', $$select 1 from public.staff_pins where pin_hash like '$2%' and pin_hash not like '%4821%'$$, 1, 'the PIN is stored as a bcrypt hash');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.staff_pins$$, '42501', 'staff_pins is invisible to the browser');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'v1', $$select public.verify_staff_pin((select v::uuid from t_out where k='staff_nok'), '4821')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='v1' and v='ok'$$, 1, 'the right PIN verifies');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'v2', $$select public.verify_staff_pin((select v::uuid from t_out where k='staff_nok'), '0000')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='v2' and v='wrong'$$, 1, 'a wrong PIN says wrong');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'v3', $$select public.verify_staff_pin((select v::uuid from t_out where k='staff_nok'), '0001')$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'v3', $$select public.verify_staff_pin((select v::uuid from t_out where k='staff_nok'), '0002')$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'v3', $$select public.verify_staff_pin((select v::uuid from t_out where k='staff_nok'), '0003')$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'v3', $$select public.verify_staff_pin((select v::uuid from t_out where k='staff_nok'), '0004')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='v3' and v='locked'$$, 1, 'the fifth wrong try locks the PIN');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'v4', $$select public.verify_staff_pin((select v::uuid from t_out where k='staff_nok'), '4821')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='v4' and v='locked'$$, 1, 'even the right PIN is refused while locked');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'auth.pin_lockout'$$, 1, 'the lockout was audited');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.verify_staff_pin((select v::uuid from t_out where k='staff_nok'), '4821')$$, '42501', 'another org cannot probe PINs');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.set_staff_pin((select v::uuid from t_out where k='staff_nok'), '7777')$$, 1, 'resetting the PIN clears the lock');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'v5', $$select public.verify_staff_pin((select v::uuid from t_out where k='staff_nok'), '7777')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='v5' and v='ok'$$, 1, 'the new PIN works');
select t_err(null, 'anon', $$select public.verify_staff_pin(gen_random_uuid(), '1234')$$, '42501', 'anon cannot verify PINs');

-- ── devices ──
select t_val('00000000-0000-0000-0000-0000000000e5', 'authenticated', 'other', $$select id::text from public.orgs where name = 'Other'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store1', $$select id::text from public.stores where name = 'Acme'$$);
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values ((select v::uuid from t_out where k='acme'), (select v::uuid from t_out where k='store1'), 'Counter iPad', 'cashier', 'POS-001')$$, 1, 'owner registers a device');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.devices (org_id, store_id, name, role, station) values ((select v::uuid from t_out where k='acme'), (select v::uuid from t_out where k='store1'), 'Bar screen', 'kds', 'bar')$$, 1, 'owner registers a KDS with a station');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.devices (org_id, store_id, name, role, station) values ((select v::uuid from t_out where k='acme'), (select v::uuid from t_out where k='store1'), 'Bad', 'cashier', 'bar')$$, '23514', 'only a KDS has a station');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values ((select v::uuid from t_out where k='acme'), (select v::uuid from t_out where k='store1'), 'Bad', 'cashier', 'x; drop')$$, '23514', 'a malformed POS ID is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.devices (org_id, store_id, name, role) values ((select v::uuid from t_out where k='other'), (select v::uuid from t_out where k='store1'), 'Cross', 'cashier')$$, '23514', 'a device cannot be registered in another org');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.devices (org_id, store_id, name, role) values ((select v::uuid from t_out where k='acme'), (select v::uuid from t_out where k='store1'), 'Nope', 'cashier')$$, '42501', 'a cashier cannot register a device');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.devices$$, 2, 'a cashier can read the devices of their shop');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.devices$$, 0, 'another org sees none');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.devices set revenue_pos_id = 'POS-002' where name = 'Counter iPad'$$, 1, 'owner changes the POS ID');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'device.register'$$, 2, 'registrations were audited');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'device.pos_id_change'$$, 1, 'the POS ID change was audited (critical)');
select t_err(null, 'anon', $$select * from public.devices$$, '42501', 'anon cannot read devices');

-- ── lock-screen list ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'pinned', $$select count(*)::text from public.staff_with_pin((select v::uuid from t_out where k='acme'))$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='pinned' and v='1'$$, 1, 'a cashier sees which people have a PIN (only Nok has one)');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.staff_with_pin((select v::uuid from t_out where k='acme'))$$, '42501', 'another org cannot list PIN holders');
select t_err(null, 'anon', $$select * from public.staff_with_pin((select v::uuid from t_out where k='acme'))$$, '42501', 'anon cannot list PIN holders');
\echo ALL BACK OFFICE TESTS PASSED
