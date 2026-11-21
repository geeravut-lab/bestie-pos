-- Spa / yoga advisor: the gate (module + therapist sign-off), tagging services, what the guest page may read.
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
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Sing Co','Sing Along','karaoke')$$, 1, 'owner creates a karaoke shop');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other Co','Other','cafe')$$, 1, 'another business exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Sing Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Sing Along'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'room', $$select public.save_karaoke_room(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'VIP 1', 'rate_per_hour', 30000, 'min_minutes', 60, 'step_minutes', 15))::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'tok', $$select e ->> 'token' from jsonb_array_elements(public.karaoke_room_links((select v::uuid from t_out where k='store'))) e where e ->> 'id' = (select v from t_out where k='room')$$);

-- ── arithmetic ──
select t_rows(null, 'service_role', $$select 1 where public.karaoke_overage_minutes(3600, 60, 15) = 0 and public.karaoke_overage_minutes(3601, 60, 15) = 15 and public.karaoke_overage_minutes(4500, 60, 15) = 15
  and public.karaoke_overage_minutes(4501, 60, 15) = 30 and public.karaoke_overage_minutes(100, 60, 15) = 0$$, 1, 'overage: nothing inside the package, then rounded up to a step');

-- ── packages ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_karaoke_package(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Hour', 'minutes', 60, 'price', 25000))$$, '42501', 'a cashier cannot create a package');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_karaoke_package(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Tiny', 'minutes', 10, 'price', 100))$$, '23514', 'a package is at least 15 minutes');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'pk1', $$select public.save_karaoke_package(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', '1 hour', 'minutes', 60, 'price', 25000))::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'pk2', $$select public.save_karaoke_package(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', '30 minutes', 'minutes', 30, 'price', 12000))::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'pk3', $$select public.save_karaoke_package(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Off', 'minutes', 60, 'price', 1, 'active', false))::text$$);

-- ── pause and resume ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 's1', $$select public.karaoke_start((select v::uuid from t_out where k='room'), 3)::text$$);
update public.karaoke_sessions set started_at = now() - interval '60 minutes';
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_pause((select v::uuid from t_out where k='s1'))$$, 1, 'staff pause the room');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_pause((select v::uuid from t_out where k='s1'))$$, '55000', 'a paused room cannot be paused again');
update public.karaoke_sessions set paused_at = now() - interval '20 minutes';
select t_rows(null, 'service_role', $$select 1 where public.karaoke_elapsed((select v::uuid from t_out where k='s1')) between 2399 and 2405$$, 1, 'while paused the clock stands at 40 minutes (60 minus the 20 paused)');
select t_val(null, 'service_role', 'g_p', $$select public.guest_karaoke_room((select v from t_out where k='tok'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='g_p' and (v::jsonb ->> 'paused') = 'true' and (v::jsonb ->> 'elapsed_seconds')::int between 2399 and 2405$$, 1, 'the guest page shows the pause and the frozen clock');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_resume((select v::uuid from t_out where k='s1'))$$, 1, 'staff resume');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_resume((select v::uuid from t_out where k='s1'))$$, '55000', 'a running room cannot be resumed');
select t_rows(null, 'service_role', $$select 1 from public.karaoke_sessions where id = (select v::uuid from t_out where k='s1') and paused_at is null and paused_seconds between 1199 and 1205$$, 1, 'the paused 20 minutes are kept');
select t_rows(null, 'service_role', $$select 1 where public.karaoke_elapsed((select v::uuid from t_out where k='s1')) between 2399 and 2410$$, 1, 'the clock continues from 40 minutes');
-- stopping a paused room: the pause is not billed
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_pause((select v::uuid from t_out where k='s1'))$$, 1, 'paused again');
update public.karaoke_sessions set paused_at = now() - interval '30 minutes';
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'stop1', $$select public.karaoke_stop((select v::uuid from t_out where k='s1'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='stop1' and (v::jsonb ->> 'billed_minutes') = '60' and (v::jsonb ->> 'amount') = '30000'$$, 1, 'only 10 minutes were counted, so the 60-minute minimum applies = 300 baht');

-- ── package, extend ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_start((select v::uuid from t_out where k='room'), null, (select v::uuid from t_out where k='pk3'))$$, '22023', 'an inactive package cannot be used');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 's2', $$select public.karaoke_start((select v::uuid from t_out where k='room'), 2, (select v::uuid from t_out where k='pk1'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.karaoke_sessions where id = (select v::uuid from t_out where k='s2') and included_minutes = 60 and package_total = 25000 and package_name = '1 hour'$$, 1, 'the package is copied onto the session');
select t_val(null, 'service_role', 'g_pk', $$select public.guest_karaoke_room((select v from t_out where k='tok'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='g_pk' and (v::jsonb ->> 'included_minutes') = '60'$$, 1, 'the guest page knows the minutes included');
update public.karaoke_sessions set started_at = now() - interval '40 minutes' where id = (select v::uuid from t_out where k='s2');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ext', $$select public.karaoke_extend((select v::uuid from t_out where k='s2'), (select v::uuid from t_out where k='pk2'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='ext' and (v::jsonb ->> 'included_minutes') = '90' and (v::jsonb ->> 'package_total') = '37000'$$, 1, 'extending adds the block and its price');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_extend((select v::uuid from t_out where k='s2'), gen_random_uuid())$$, '22023', 'an unknown package is refused');
update public.karaoke_sessions set started_at = now() - interval '100 minutes' where id = (select v::uuid from t_out where k='s2');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'stop2', $$select public.karaoke_stop((select v::uuid from t_out where k='s2'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='stop2' and (v::jsonb ->> 'billed_minutes') = '105' and (v::jsonb ->> 'amount') = '44500'$$, 1, '100 minutes with 90 included: 15 minutes over = 370 + 75 = 445 baht');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_extend((select v::uuid from t_out where k='s2'), (select v::uuid from t_out where k='pk2'))$$, '55000', 'a stopped room cannot be extended');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ord', $$select public.karaoke_to_order((select v::uuid from t_out where k='s2'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.order_lines l where l.order_id = (select v::uuid from t_out where k='ord') and l.unit_price = 44500$$, 1, 'the bill carries the package plus the overage');
-- inside the package: no overage
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 's3', $$select public.karaoke_start((select v::uuid from t_out where k='room'), null, (select v::uuid from t_out where k='pk1'))::text$$);
update public.karaoke_sessions set started_at = now() - interval '20 minutes' where id = (select v::uuid from t_out where k='s3');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'stop3', $$select public.karaoke_stop((select v::uuid from t_out where k='s3'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='stop3' and (v::jsonb ->> 'billed_minutes') = '60' and (v::jsonb ->> 'amount') = '25000'$$, 1, 'leaving early inside the package still costs the package');

-- ── reservations ──
create or replace function t_bk(at_min int, mins int, who text default 'Guest') returns text language sql as $$
  select jsonb_build_object('store_id', (select v from t_out where k='store'), 'room_id', (select v from t_out where k='room'), 'guest_name', who, 'phone', '0811111111', 'guests', 4,
    'starts_at', (now() + make_interval(mins => at_min))::text, 'minutes', mins)::text $$;
grant execute on function t_bk(int, int, text) to authenticated, service_role;
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'b1', $$select public.karaoke_book(t_bk(120, 90, 'Anna')::jsonb)::text$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_book(t_bk(150, 60)::jsonb)$$, '23P01', 'an overlapping reservation is refused');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'b2', $$select public.karaoke_book(t_bk(210, 60, 'Back to back')::jsonb)::text$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_book(t_bk(-600, 60)::jsonb)$$, '22023', 'a reservation in the past is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_book(t_bk(500, 5)::jsonb)$$, '22023', 'a reservation under 15 minutes is refused');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.karaoke_book(t_bk(900, 60)::jsonb)$$, '42501', 'another business cannot book this room');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.karaoke_bookings (org_id, store_id, room_id, guest_name, starts_at, ends_at) select org_id, store_id, id, 'x', now(), now() + interval '1 hour' from public.karaoke_rooms$$, '42501', 'no direct writes');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_booking_status((select v::uuid from t_out where k='b2'), 'cancelled')$$, 1, 'a reservation can be cancelled');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'b3', $$select public.karaoke_book(t_bk(210, 60, 'Takes the freed slot')::jsonb)::text$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_booking_status((select v::uuid from t_out where k='b3'), 'no_show')$$, '55000', 'a reservation cannot be a no-show before it starts');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_start((select v::uuid from t_out where k='room'), null, null, (select v::uuid from t_out where k='b2'))$$, '55000', 'a cancelled reservation cannot be started');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 's4', $$select public.karaoke_start((select v::uuid from t_out where k='room'), null, null, (select v::uuid from t_out where k='b1'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.karaoke_bookings b join public.karaoke_sessions x on x.id = b.session_id where b.id = (select v::uuid from t_out where k='b1') and b.status = 'arrived' and x.guests = 4$$, 1, 'starting for a reservation marks it arrived and takes its guest count');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'stop4', $$select public.karaoke_stop((select v::uuid from t_out where k='s4'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.karaoke_bookings where id = (select v::uuid from t_out where k='b1') and status = 'done'$$, 1, 'stopping the room finishes the reservation');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.karaoke_bookings$$, 3, 'the front desk reads the reservations');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.karaoke_bookings$$, 0, 'another business reads none');
do $$ begin raise notice 'ALL KARAOKE V2 TESTS PASSED'; end $$;
