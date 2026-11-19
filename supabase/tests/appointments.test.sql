-- Appointments and resources: module gating, overlap rules, status flow, rescheduling, rights.
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
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Salon Co','Salon','salon')$$, 1, 'owner creates a salon');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','salon')$$, 1, 'another business has a salon too');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('00000000-0000-0000-0000-0000000000b2'::uuid, 'Manager', 'manager'),
               ('00000000-0000-0000-0000-0000000000d4'::uuid, 'Cashier', 'cashier')) as u(id, n, b) on true
  join public.roles r on r.org_id = o.id and r.built_in = u.b
 where o.name = 'Salon Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Salon Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Salon'$$);
select t_val(null, 'service_role', 'resto', $$insert into public.stores (org_id, legal_entity_id, name, profile) select org_id, legal_entity_id, 'Resto', 'restaurant' from public.stores where name = 'Salon' returning id::text$$);
select t_val(null, 'service_role', 'foreign_store', $$select id::text from public.stores where name = 'Other'$$);

-- ── the module switch is enforced in SQL ──
select t_rows(null, 'service_role', $$select 1 where public.appointments_enabled((select v::uuid from t_out where k='store')) and not public.appointments_enabled((select v::uuid from t_out where k='resto'))$$, 1, 'a salon has appointments on, a restaurant has not');
select t_rows(null, 'service_role', $$select 1 where not public.resources_enabled((select v::uuid from t_out where k='store'))$$, 1, 'rooms and beds are off for a salon by default');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_appointment(jsonb_build_object('store_id', (select v from t_out where k='resto'), 'service_name', jsonb_build_object('th', 'x'), 'starts_at', '2030-01-15T10:00:00+07:00', 'guest_name', 'Anna'))$$, '0A000', 'a restaurant cannot take appointments');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.resources (org_id, store_id, name, kind) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Room 1', 'room')$$, '0A000', 'a salon cannot add rooms until the resources module is on');

-- ── resources ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.resources (org_id, store_id, name, kind) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Nok', 'stylist')$$, '42501', 'a cashier cannot add stylists');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'nok', $$insert into public.resources (org_id, store_id, name, kind) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Nok', 'stylist') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'mai', $$insert into public.resources (org_id, store_id, name, kind) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Mai', 'stylist') returning id::text$$);
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$insert into public.resources (org_id, store_id, name, kind) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), ' nok ', 'stylist')$$, '23505', 'a name is unique in a shop (case and spaces ignored)');
update public.stores set module_overrides = '{"resources": true}' where id = (select v::uuid from t_out where k='store');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'room1', $$insert into public.resources (org_id, store_id, name, kind) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Room 1', 'room') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'bed2', $$insert into public.resources (org_id, store_id, name, kind) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Bed 2', 'bed') returning id::text$$);
select t_val(null, 'service_role', 'foreign_res', $$insert into public.resources (org_id, store_id, name, kind) values ((select org_id from public.stores where id = (select v::uuid from t_out where k='foreign_store')), (select v::uuid from t_out where k='foreign_store'), 'Alien', 'stylist') returning id::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.resources where store_id = (select v::uuid from t_out where k='store')$$, 4, 'the front desk sees the shop''s resources');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.resources where store_id = (select v::uuid from t_out where k='store')$$, 0, 'another business sees none');

-- ── a service with a length ──
select t_val(null, 'service_role', 'cat', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"บริการ"}') returning id::text$$);
select t_val(null, 'service_role', 'svc', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, duration_min) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"นวดน้ำมัน","en":"Oil massage"}', '{"base": 80000}', 90) returning id::text$$);
select t_err(null, 'service_role', $$update public.menu_items set duration_min = 3 where id = (select v::uuid from t_out where k='svc')$$, '23514', 'a service lasts at least 5 minutes');
create or replace function t_book(prov text, place text, start_ text, extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('store_id', (select v from t_out where k='store'), 'provider_id', (select v from t_out where k=prov), 'place_id', (select v from t_out where k=place),
    'service_id', (select v from t_out where k='svc'), 'starts_at', start_, 'guest_name', 'Anna') || extra
$$;
grant execute on function t_book(text, text, text, jsonb) to authenticated, service_role;

-- ── booking ──
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.book_appointment(t_book('nok', null, '2030-01-15T10:00:00+07:00'))$$, '42501', 'another business cannot book here');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.appointments (org_id, store_id, service_name, guest_name, starts_at, ends_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"x"}', 'Eve', now(), now() + interval '1 hour')$$, '42501', 'nobody writes appointments directly');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'a1', $$select public.book_appointment(t_book('nok', 'room1', '2030-01-15T10:00:00+07:00', '{"guest_phone":"081-234-5678","note":"first visit"}'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.appointments where id = (select v::uuid from t_out where k='a1') and service_name ->> 'th' = 'นวดน้ำมัน' and price = 80000 and ends_at - starts_at = interval '90 minutes' and status = 'booked' and source = 'staff'$$, 1, 'the cashier books: service name, price and length are snapshotted (90 min)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_appointment(t_book('nok', null, '2030-01-15T11:00:00+07:00'))$$, '23P01', 'the same stylist cannot be double booked (11:00 is inside 10:00–11:30)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_appointment(t_book('mai', 'room1', '2030-01-15T10:30:00+07:00'))$$, '23P01', 'nor the same room, even with another stylist');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'a2', $$select public.book_appointment(t_book('mai', 'bed2', '2030-01-15T10:00:00+07:00', '{"guest_name":"Ben"}'))::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'a3', $$select public.book_appointment(t_book('nok', 'room1', '2030-01-15T11:30:00+07:00', '{"guest_name":"Cara"}'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.appointments where store_id = (select v::uuid from t_out where k='store')$$, 3, 'back to back is fine: 11:30 starts exactly when the 90 minutes end');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_appointment(t_book('nok', null, '2030-01-15T10:00:00+07:00', '{"duration_min": 3}'))$$, '22023', 'a booking lasts at least 5 minutes');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_appointment(t_book('nok', null, '2030-01-16T10:00:00+07:00', '{"guest_name":"  "}'))$$, '23514', 'a guest name is required');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_appointment(jsonb_build_object('store_id', (select v from t_out where k='store'), 'provider_id', (select v from t_out where k='foreign_res'), 'service_name', jsonb_build_object('th', 'x'), 'starts_at', '2030-01-16T10:00:00+07:00', 'guest_name', 'Anna'))$$, '22023', 'a stylist of another shop is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_appointment(jsonb_build_object('store_id', (select v from t_out where k='store'), 'provider_id', (select v from t_out where k='room1'), 'service_name', jsonb_build_object('th', 'x'), 'starts_at', '2030-01-16T10:00:00+07:00', 'guest_name', 'Anna'))$$, '22023', 'a room cannot be the provider');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'a4', $$select public.book_appointment(jsonb_build_object('store_id', (select v from t_out where k='store'), 'service_name', jsonb_build_object('th', 'ตัดผม', 'en', 'Haircut'), 'price', 30000, 'duration_min', 45, 'starts_at', '2030-01-16T09:00:00+07:00', 'guest_name', 'Dan'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.appointments where id = (select v::uuid from t_out where k='a4') and price = 30000 and provider_id is null and place_id is null and service_id is null$$, 1, 'a custom service with no provider and no room can be booked');

-- ── status flow ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_status((select v::uuid from t_out where k='a1'), 'done')$$, '55000', 'a booking cannot jump to done');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_status((select v::uuid from t_out where k='a1'), 'confirmed')$$, 1, 'booked → confirmed');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_status((select v::uuid from t_out where k='a1'), 'arrived')$$, 1, 'confirmed → arrived');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_status((select v::uuid from t_out where k='a1'), 'no_show')$$, '55000', 'a guest who arrived is not a no-show');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_status((select v::uuid from t_out where k='a1'), 'in_service')$$, 1, 'arrived → in service');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_status((select v::uuid from t_out where k='a1'), 'done')$$, 1, 'in service → done');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_status((select v::uuid from t_out where k='a1'), 'cancelled')$$, '55000', 'a finished appointment stays finished');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.set_appointment_status((select v::uuid from t_out where k='a2'), 'confirmed')$$, '42501', 'another business cannot change it');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_status((select v::uuid from t_out where k='a2'), 'no_show')$$, 1, 'a guest who did not come is a no-show');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'a5', $$select public.book_appointment(t_book('mai', 'bed2', '2030-01-15T10:00:00+07:00', '{"guest_name":"Eli"}'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.appointments where id = (select v::uuid from t_out where k='a5')$$, 1, 'a no-show frees Mai and Bed 2 at 10:00');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_status((select v::uuid from t_out where k='a5'), 'cancelled')$$, 1, 'cancelled');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'a6', $$select public.book_appointment(t_book('mai', 'bed2', '2030-01-15T10:00:00+07:00', '{"guest_name":"Fay"}'))::text$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_status((select v::uuid from t_out where k='a5'), 'confirmed')$$, '55000', 'and cancelled stays cancelled');

-- ── moving ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.reschedule_appointment(jsonb_build_object('id', (select v from t_out where k='a3'), 'starts_at', '2030-01-15T10:30:00+07:00', 'place_id', (select v from t_out where k='bed2')))$$, '23P01', 'moving onto a busy bed is refused (Fay has Bed 2 until 11:30)');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.reschedule_appointment(jsonb_build_object('id', (select v from t_out where k='a3'), 'starts_at', '2030-01-15T10:30:00+07:00'))$$, 1, 'but 10:30 is free for Nok in Room 1, because the 10:00 booking there is finished');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.reschedule_appointment(jsonb_build_object('id', (select v from t_out where k='a3'), 'starts_at', '2030-01-15T14:00:00+07:00'))$$, 1, 'moving to a free time works');
select t_rows(null, 'service_role', $$select 1 from public.appointments where id = (select v::uuid from t_out where k='a3') and starts_at = '2030-01-15T14:00:00+07:00' and ends_at = '2030-01-15T15:30:00+07:00'$$, 1, 'and the length stays 90 minutes');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.reschedule_appointment(jsonb_build_object('id', (select v from t_out where k='a3'), 'starts_at', '2030-01-15T14:30:00+07:00'))$$, 1, 'moving within its own time is not a clash with itself');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.reschedule_appointment(jsonb_build_object('id', (select v from t_out where k='a1'), 'starts_at', '2030-01-20T10:00:00+07:00'))$$, '55000', 'a finished appointment cannot be moved');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.reschedule_appointment(jsonb_build_object('id', (select v from t_out where k='a3'), 'starts_at', '2030-01-15T14:30:00+07:00', 'place_id', null))$$, 1, 'a null room takes the booking out of the room');
select t_rows(null, 'service_role', $$select 1 from public.appointments where id = (select v::uuid from t_out where k='a3') and place_id is null$$, 1, 'it has no room now');

-- ── an inactive stylist cannot be booked; the screen can still read history ──
update public.resources set active = false where id = (select v::uuid from t_out where k='mai');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_appointment(t_book('mai', null, '2030-02-01T10:00:00+07:00'))$$, '22023', 'a stylist who left cannot be booked');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.appointments where provider_id = (select v::uuid from t_out where k='mai')$$, 3, 'but her old bookings stay readable');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.appointments$$, 0, 'another business sees no appointments');
do $$ begin raise notice 'ALL APPOINTMENT TESTS PASSED'; end $$;
