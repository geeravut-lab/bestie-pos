-- Online booking: link + settings, free slots, booking by a guest (anyone / a chosen stylist), limits, cancel, notices, reminders.
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
  ('00000000-0000-0000-0000-0000000000f6', 'nok@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Salon Co','Salon','salon')$$, 1, 'owner creates a salon');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('00000000-0000-0000-0000-0000000000b2'::uuid, 'Manager', 'manager'),
               ('00000000-0000-0000-0000-0000000000d4'::uuid, 'Cashier', 'cashier'),
               ('00000000-0000-0000-0000-0000000000f6'::uuid, 'Stylist Nok', 'waiter')) as u(id, n, b) on true
  join public.roles r on r.org_id = o.id and r.built_in = u.b
 where o.name = 'Salon Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Salon Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Salon'$$);
select t_val(null, 'service_role', 'nok_staff', $$select id::text from public.staff where display_name = 'Stylist Nok'$$);
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'nok', $$insert into public.resources (org_id, store_id, name, kind, staff_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Nok', 'stylist', (select v::uuid from t_out where k='nok_staff')) returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'mai', $$insert into public.resources (org_id, store_id, name, kind, sort) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Mai', 'stylist', 5) returning id::text$$);
select t_val(null, 'service_role', 'cat', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"x"}') returning id::text$$);
select t_val(null, 'service_role', 'svc', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, duration_min) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"นวด","en":"Massage"}', '{"base": 100000}', 60) returning id::text$$);
select t_rows(null, 'service_role', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"ครีม"}', '{"base": 50000}')$$, 1, 'a product (no length) exists too');
create or replace function t_day(n integer) returns text language sql as $$ select ((now() at time zone 'Asia/Bangkok')::date + n)::text $$;
grant execute on function t_day(integer) to authenticated, service_role;
create or replace function t_book(tok text, prov text, d text, tm text, who text, phone text, client text) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('service_id', (select v from t_out where k='svc'), 'provider_id', prov, 'date', d, 'time', tm, 'name', who, 'phone', phone, 'client_id', client)) $$;
grant execute on function t_book(text, text, text, text, text, text, text) to authenticated, service_role;

-- ── the owner's side ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_booking_settings((select v::uuid from t_out where k='store'), '{}')$$, '42501', 'a cashier cannot change booking settings');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_booking_settings((select v::uuid from t_out where k='store'), '{"open":"20:00","close":"09:00"}')$$, '22023', 'opening must be before closing');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_booking_settings((select v::uuid from t_out where k='store'), '{"max_days":500}')$$, '22023', 'too many days ahead is refused');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'tok', $$select (public.save_booking_settings((select v::uuid from t_out where k='store'), '{}') ->> 'token')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='tok' and v ~ '^[0-9a-f]{32}$'$$, 1, 'a booking link now exists');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'tok2', $$select (public.save_booking_settings((select v::uuid from t_out where k='store'), '{"step_min":30}') ->> 'token')$$);
select t_rows(null, 'service_role', $$select 1 from t_out a, t_out b where a.k='tok' and b.k='tok2' and a.v = b.v$$, 1, 'saving settings keeps the same link');

-- ── module off ──
select t_rows(null, 'service_role', $$select 1 where (public.guest_booking_info((select v from t_out where k='tok')) ->> 'open') = 'false'$$, 1, 'with the module off the page says closed');
select t_rows(null, 'service_role', $$select 1 where (public.guest_book((select v from t_out where k='tok'), t_book('', null, t_day(3), '10:00', 'Guest', '0811111111', gen_random_uuid()::text)) ->> 'error') = 'off'$$, 1, 'and nobody can book');
update public.stores set module_overrides = '{"booking.online": true}' where name = 'Salon';

-- ── what the guest sees ──
select t_rows(null, 'service_role', $$select 1 where public.guest_booking_info('0123456789abcdef0123456789abcdef') is null$$, 1, 'a wrong link finds nothing');
select t_rows(null, 'service_role', $$select 1 where (public.guest_booking_info((select v from t_out where k='tok')) -> 'services') @> '[{"duration_min":60}]' and jsonb_array_length(public.guest_booking_info((select v from t_out where k='tok')) -> 'services') = 1 and jsonb_array_length(public.guest_booking_info((select v from t_out where k='tok')) -> 'providers') = 2$$, 1, 'one service with a length (the product is not bookable) and two stylists');
select t_rows(null, 'service_role', $$select 1 where jsonb_array_length(public.guest_booking_slots((select v from t_out where k='tok'), (select v::uuid from t_out where k='svc'), null, t_day(3)::date)) = 21$$, 1, '09:00 to 19:00 every 30 minutes = 21 start times');
select t_rows(null, 'service_role', $$select 1 where public.guest_booking_slots((select v from t_out where k='tok'), (select v::uuid from t_out where k='svc'), null, t_day(-1)::date) = '[]'::jsonb and public.guest_booking_slots((select v from t_out where k='tok'), (select v::uuid from t_out where k='svc'), null, t_day(31)::date) = '[]'::jsonb$$, 1, 'yesterday and 31 days ahead have no times');

-- ── booking ──
select t_val(null, 'service_role', 'c1', $$select gen_random_uuid()::text$$);
select t_val(null, 'service_role', 'b1', $$select public.guest_book((select v from t_out where k='tok'), t_book('', (select v from t_out where k='nok'), t_day(3), '10:00', 'Anna', '081-111-1111', (select v from t_out where k='c1')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='b1' and (v::jsonb ->> 'ok') = 'true' and length(v::jsonb ->> 'code') = 8 and (v::jsonb ->> 'provider') = 'Nok'$$, 1, 'a guest books Nok at 10:00 and gets a cancel code');
select t_rows(null, 'service_role', $$select 1 from public.appointments where source = 'online' and status = 'booked' and guest_name = 'Anna' and price = 100000 and ends_at - starts_at = interval '60 minutes'$$, 1, 'it is an online booking, booked, priced from the menu, 60 minutes');
select t_val(null, 'service_role', 'b1r', $$select public.guest_book((select v from t_out where k='tok'), t_book('', (select v from t_out where k='nok'), t_day(3), '10:00', 'Anna', '081-111-1111', (select v from t_out where k='c1')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='b1r' and (v::jsonb ->> 'repeat') = 'true' and (v::jsonb ->> 'id') = ((select v from t_out where k='b1')::jsonb ->> 'id')$$, 1, 'the same request again returns the same booking');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.appointments where source = 'online') = 1$$, 1, 'and makes no second one');
select t_rows(null, 'service_role', $$select 1 where jsonb_array_length(public.guest_booking_slots((select v from t_out where k='tok'), (select v::uuid from t_out where k='svc'), (select v::uuid from t_out where k='nok'), t_day(3)::date)) = 18 and jsonb_array_length(public.guest_booking_slots((select v from t_out where k='tok'), (select v::uuid from t_out where k='svc'), null, t_day(3)::date)) = 21$$, 1, 'Nok loses 09:30, 10:00 and 10:30; "anyone" still has all 21');
select t_rows(null, 'service_role', $$select 1 where (public.guest_book((select v from t_out where k='tok'), t_book('', (select v from t_out where k='nok'), t_day(3), '10:00', 'Bob', '082-222-2222', gen_random_uuid()::text)) ->> 'error') = 'taken'$$, 1, 'Nok at 10:00 again is taken');
select t_val(null, 'service_role', 'b2', $$select public.guest_book((select v from t_out where k='tok'), t_book('', null, t_day(3), '10:00', 'Bob', '082-222-2222', gen_random_uuid()::text))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='b2' and (v::jsonb ->> 'provider') = 'Mai'$$, 1, '"anyone" at 10:00 goes to Mai');
select t_rows(null, 'service_role', $$select 1 where (public.guest_book((select v from t_out where k='tok'), t_book('', null, t_day(3), '10:00', 'Cy', '083-333-3333', gen_random_uuid()::text)) ->> 'error') = 'taken'$$, 1, 'then nobody is left at 10:00');
select t_rows(null, 'service_role', $$select 1 where (public.guest_book((select v from t_out where k='tok'), t_book('', null, t_day(3), '10:15', 'Cy', '083-333-3333', gen_random_uuid()::text)) ->> 'error') = 'invalid' and (public.guest_book((select v from t_out where k='tok'), t_book('', null, t_day(-1), '10:00', 'Cy', '083-333-3333', gen_random_uuid()::text)) ->> 'error') = 'invalid' and (public.guest_book((select v from t_out where k='tok'), t_book('', null, t_day(3), '19:30', 'Cy', '083-333-3333', gen_random_uuid()::text)) ->> 'error') = 'invalid' and (public.guest_book((select v from t_out where k='tok'), t_book('', null, t_day(3), '11:00', 'Cy', '123', gen_random_uuid()::text)) ->> 'error') = 'invalid'$$, 1, 'off-step time, past day, past closing time and a short phone are refused');
select t_rows(null, 'service_role', $$select 1 where (public.guest_book('0123456789abcdef0123456789abcdef', t_book('', null, t_day(3), '11:00', 'Cy', '083-333-3333', gen_random_uuid()::text)) ->> 'error') = 'not_found'$$, 1, 'a wrong link cannot book');

-- ── limits: 3 upcoming bookings per phone ──
select t_rows(null, 'service_role', $$select 1 where (public.guest_book((select v from t_out where k='tok'), t_book('', (select v from t_out where k='nok'), t_day(4), '14:00', 'Dee', '084-444-4444', gen_random_uuid()::text)) ->> 'ok') = 'true' and (public.guest_book((select v from t_out where k='tok'), t_book('', (select v from t_out where k='nok'), t_day(4), '15:00', 'Dee', '0844444444', gen_random_uuid()::text)) ->> 'ok') = 'true' and (public.guest_book((select v from t_out where k='tok'), t_book('', (select v from t_out where k='nok'), t_day(4), '16:00', 'Dee', '084 444 4444', gen_random_uuid()::text)) ->> 'ok') = 'true'$$, 1, 'one phone books three times');
select t_rows(null, 'service_role', $$select 1 where (public.guest_book((select v from t_out where k='tok'), t_book('', (select v from t_out where k='nok'), t_day(4), '17:00', 'Dee', '084-444-4444', gen_random_uuid()::text)) ->> 'error') = 'too_many'$$, 1, 'the fourth is refused (however the number is written)');

-- ── cancelling ──
select t_rows(null, 'service_role', $$select 1 where (public.guest_cancel_booking((select v from t_out where k='tok'), ((select v from t_out where k='b1')::jsonb ->> 'id')::uuid, 'WRONG123') ->> 'error') = 'invalid'$$, 1, 'a wrong code cancels nothing');
select t_rows(null, 'service_role', $$select 1 where (public.guest_cancel_booking((select v from t_out where k='tok'), ((select v from t_out where k='b1')::jsonb ->> 'id')::uuid, lower((select v from t_out where k='b1')::jsonb ->> 'code')) ->> 'ok') = 'true'$$, 1, 'the right code cancels (any letter case)');
select t_rows(null, 'service_role', $$select 1 from public.appointments where id = ((select v from t_out where k='b1')::jsonb ->> 'id')::uuid and status = 'cancelled'$$, 1, 'the booking is cancelled');
select t_rows(null, 'service_role', $$select 1 where jsonb_array_length(public.guest_booking_slots((select v from t_out where k='tok'), (select v::uuid from t_out where k='svc'), (select v::uuid from t_out where k='nok'), t_day(3)::date)) = 21$$, 1, 'and Nok is free again');
select t_rows(null, 'service_role', $$select 1 where (public.guest_cancel_booking((select v from t_out where k='tok'), ((select v from t_out where k='b1')::jsonb ->> 'id')::uuid, (select v from t_out where k='b1')::jsonb ->> 'code') ->> 'error') = 'closed'$$, 1, 'a cancelled booking cannot be cancelled again');

-- ── notices to the shop ──
select t_rows(null, 'service_role', $$select 1 from public.app_notifications where user_id = '00000000-0000-0000-0000-0000000000a1' and kind = 'appointment.online'$$, 5, 'the owner heard about each online booking (5 made)');
select t_rows(null, 'service_role', $$select 1 from public.app_notifications where user_id = '00000000-0000-0000-0000-0000000000a1' and kind = 'appointment.online_cancel'$$, 1, 'and about the cancellation');
select t_rows(null, 'service_role', $$select 1 from public.app_notifications where user_id = '00000000-0000-0000-0000-0000000000f6' and kind = 'appointment.online'$$, 4, 'Nok, as the stylist, heard about the 4 that were hers');

-- ── reminders ──
select t_rows(null, 'service_role', $$insert into public.appointments (org_id, store_id, provider_id, service_name, guest_name, starts_at, ends_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='nok'), '{"th":"นวด"}', 'Soon', now() + interval '30 minutes', now() + interval '90 minutes')$$, 1, 'an appointment starts in 30 minutes');
select t_val(null, 'service_role', 'rem1', $$select public.appointment_reminders(90)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='rem1' and v = '1'$$, 1, 'the tick reminds once (the days-ahead bookings are not due)');
select t_val(null, 'service_role', 'rem2', $$select public.appointment_reminders(90)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='rem2' and v = '0'$$, 1, 'and not again');
select t_rows(null, 'service_role', $$select 1 from public.app_notifications where user_id = '00000000-0000-0000-0000-0000000000f6' and kind = 'appointment.soon'$$, 1, 'Nok has the reminder in the app');

-- ── a new link, and the doors ──
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'tok3', $$select (public.save_booking_settings((select v::uuid from t_out where k='store'), '{"rotate": true}') ->> 'token')$$);
select t_rows(null, 'service_role', $$select 1 from t_out a, t_out b where a.k='tok' and b.k='tok3' and a.v <> b.v$$, 1, 'a new link replaces the old one');
select t_rows(null, 'service_role', $$select 1 where public.guest_booking_info((select v from t_out where k='tok')) is null$$, 1, 'the old link finds nothing');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.guest_book((select v from t_out where k='tok3'), '{}')$$, '42501', 'a signed-in user cannot call the guest door');
select t_err(null, 'anon', $$select public.guest_booking_info((select v from t_out where k='tok3'))$$, '42501', 'nor can the public key');

select 'ALL ONLINE BOOKING TESTS PASSED';
