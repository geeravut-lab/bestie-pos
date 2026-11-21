-- Days off and group bookings: who may block, the time is refused for bookings and online slots, groups are all-or-nothing.
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
  ('00000000-0000-0000-0000-0000000000b2', 'manager@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Salon Co','Salon','salon')$$, 1, 'owner creates a salon');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','salon')$$, 1, 'another business exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('00000000-0000-0000-0000-0000000000b2'::uuid, 'Manager', 'manager'),
               ('00000000-0000-0000-0000-0000000000d4'::uuid, 'Cashier', 'cashier'),
               (null::uuid, 'Stylist Nok', 'waiter')) as u(id, n, b) on true
  join public.roles r on r.org_id = o.id and r.built_in = u.b
 where o.name = 'Salon Co';
update public.legal_entities set tax_id = '0105560123456' where name = 'Salon Co';
update public.stores set vat_registered = true, vat_bps = 700, branch_code = '00001' where name = 'Salon';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Salon Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Salon'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'resto', $$select id::text from public.stores where name = 'Salon'$$);
select t_val(null, 'service_role', 'resto2', $$insert into public.stores (org_id, legal_entity_id, name, profile) select org_id, legal_entity_id, 'Resto', 'restaurant' from public.stores where name = 'Salon' returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Counter', 'cashier', 'POS-77') returning id::text$$);
select t_val(null, 'service_role', 'cashier_staff', $$select id::text from public.staff where display_name = 'Cashier'$$);
select t_val(null, 'service_role', 'nok_staff', $$select id::text from public.staff where display_name = 'Stylist Nok'$$);
select t_val(null, 'service_role', 'mgr_staff', $$select id::text from public.staff where display_name = 'Manager'$$);
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'nok', $$insert into public.resources (org_id, store_id, name, kind, staff_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Nok', 'stylist', (select v::uuid from t_out where k='nok_staff')) returning id::text$$);
select t_val(null, 'service_role', 'cat', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"x"}') returning id::text$$);
select t_val(null, 'service_role', 'svc', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, duration_min) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"นวด"}', '{"base": 100000}', 60) returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'fon', $$insert into public.resources (org_id, store_id, name, kind) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Fon', 'stylist') returning id::text$$);

create or replace function t_blk(res text, from_ text, to_ text, reason text default null) returns jsonb language sql as $$
  select jsonb_build_object('store_id', (select v from t_out where k='store'), 'resource_id', (select v from t_out where k=res), 'starts_at', from_, 'ends_at', to_, 'reason', reason) $$;
grant execute on function t_blk(text, text, text, text) to authenticated, service_role;
create or replace function t_day(offset_days int, hhmm text) returns text language sql as $$
  select to_char((now() at time zone 'Asia/Bangkok')::date + offset_days, 'YYYY-MM-DD') || 'T' || hhmm || ':00+07:00' $$;
grant execute on function t_day(int, text) to authenticated, service_role;

-- ── blocks: who, and what is refused ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_resource_block(t_blk('nok', t_day(5,'00:00'), t_day(6,'00:00'), 'day off'))$$, '42501', 'a cashier cannot mark a day off');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.save_resource_block(t_blk('nok', t_day(5,'00:00'), t_day(6,'00:00')))$$, '42501', 'another business cannot');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_resource_block(t_blk('nok', t_day(6,'00:00'), t_day(5,'00:00')))$$, '22023', 'an end before the start is refused');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_resource_block(t_blk('nok', t_day(5,'00:00'), t_day(90,'00:00')))$$, '22023', 'more than 62 days is refused');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_resource_block(jsonb_build_object('store_id', (select v from t_out where k='store'), 'resource_id', gen_random_uuid(), 'starts_at', t_day(5,'00:00'), 'ends_at', t_day(6,'00:00')))$$, '22023', 'an unknown person is refused');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_resource_block(t_blk('nok', t_day(5,'00:00'), t_day(6,'00:00')) || jsonb_build_object('store_id', (select v from t_out where k='resto2')))$$, '0A000', 'a shop without the appointments module (the restaurant) is refused');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'b1', $$select public.save_resource_block(t_blk('nok', t_day(5,'00:00'), t_day(6,'00:00'), 'day off'))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.resource_blocks$$, 1, 'everyone in the shop can see the day off');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.resource_blocks$$, 0, 'another business cannot');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_resource_block(t_blk('nok', t_day(5,'12:00'), t_day(7,'00:00')))$$, '23P01', 'two blocks of one person cannot overlap');

-- ── a block refuses a booking, for the front desk and for the online slot rule ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_appointment(jsonb_build_object('store_id', (select v from t_out where k='store'), 'provider_id', (select v from t_out where k='nok'), 'service_id', (select v from t_out where k='svc'), 'starts_at', t_day(5,'10:00'), 'guest_name', 'Anna'))$$, '23P01', 'Nok cannot be booked on her day off');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ok1', $$select public.book_appointment(jsonb_build_object('store_id', (select v from t_out where k='store'), 'provider_id', (select v from t_out where k='nok'), 'service_id', (select v from t_out where k='svc'), 'starts_at', t_day(6,'10:00'), 'guest_name', 'Anna'))::text$$);
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.appointments) = 1$$, 1, 'the day after the block is bookable');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_resource_block(t_blk('nok', t_day(6,'09:00'), t_day(6,'11:00'), 'lunch'))$$, '23P01', 'a block cannot be put over a live booking');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_resource_block(t_blk('nok', t_day(6,'12:00'), t_day(6,'13:00'), 'lunch'))$$, 1, 'a lunch break after the booking is fine');
select t_err(null, 'service_role', $$select public.appointment_check_free((select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='nok'), null, t_day(6,'12:30')::timestamptz, t_day(6,'13:30')::timestamptz)$$, '23P01', 'the shared rule (used by online booking) refuses the lunch break too');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.delete_resource_block((select v::uuid from t_out where k='b1'))$$, 1, 'the manager removes the day off');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.delete_resource_block((select id from public.resource_blocks limit 1))$$, '42501', 'a cashier cannot remove a block');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ok2', $$select public.book_appointment(jsonb_build_object('store_id', (select v from t_out where k='store'), 'provider_id', (select v from t_out where k='nok'), 'service_id', (select v from t_out where k='svc'), 'starts_at', t_day(5,'10:00'), 'guest_name', 'Bea'))::text$$);
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.appointments) = 2$$, 1, 'and Nok can be booked on that day again');

-- ── group booking ──
create or replace function t_grp(parts jsonb, start_ text default null) returns jsonb language sql as $$
  select jsonb_build_object('store_id', (select v from t_out where k='store'), 'starts_at', coalesce(start_, t_day(8,'14:00')), 'guest_name', 'Couple Lee', 'guest_phone', '0812345678', 'parts', parts) $$;
grant execute on function t_grp(jsonb, text) to authenticated, service_role;
create or replace function t_part(res text, guest text default null) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('provider_id', (select v from t_out where k=res), 'service_id', (select v from t_out where k='svc'), 'guest_name', guest)) $$;
grant execute on function t_part(text, text) to authenticated, service_role;
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_group(t_grp(jsonb_build_array(t_part('nok'))))$$, '22023', 'a group needs at least 2 parts');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.book_group(t_grp(jsonb_build_array(t_part('nok'), t_part('fon'))))$$, '42501', 'another business cannot book a group here');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'g1', $$select public.book_group(t_grp(jsonb_build_array(t_part('nok', 'Lee A'), t_part('fon', 'Lee B'))))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.appointments where group_id = ((select v::jsonb ->> 'group_id' from t_out where k='g1')::uuid) and starts_at = t_day(8,'14:00')::timestamptz$$, 2, 'a couple is booked at the same time with two stylists');
select t_rows(null, 'service_role', $$select 1 from public.appointments where guest_name in ('Lee A', 'Lee B')$$, 2, 'each part keeps its own guest name');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_group(t_grp(jsonb_build_array(t_part('nok'), t_part('fon')), t_day(8,'14:30')))$$, '23P01', 'one clash (both are busy) refuses the group');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'b3', $$select public.save_resource_block(t_blk('fon', t_day(9,'00:00'), t_day(10,'00:00'), 'sick'))::text$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_group(t_grp(jsonb_build_array(t_part('nok'), t_part('fon')), t_day(9,'10:00')))$$, '23P01', 'a group is refused when one stylist is off');
select t_rows(null, 'service_role', $$select 1 where not exists (select 1 from public.appointments where starts_at = t_day(9,'10:00')::timestamptz)$$, 1, 'and nothing of it was booked (all or nothing: Nok is NOT booked either)');
do $$ begin raise notice 'ALL DAYS OFF AND GROUP TESTS PASSED'; end $$;
