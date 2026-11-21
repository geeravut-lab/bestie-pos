-- Guest health form on her own phone, and before / after client photos.
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
select t_val(null, 'service_role', 'code', $$select (v::jsonb ->> 'code') from t_out where k='b1'$$);
select t_val(null, 'service_role', 'aid', $$select (v::jsonb ->> 'id') from t_out where k='b1'$$);
select t_val(null, 'service_role', 'cust', $$insert into public.customers (org_id, name, phone, member_code) values ((select v::uuid from t_out where k='org'), 'Mali', '0812345678', 'AAAA1111') returning id::text$$);
create or replace function t_jpg(n int default 300) returns text language sql as $$ select encode('\xffd8ffe0'::bytea || convert_to(repeat('x', n), 'utf8'), 'base64') $$;
grant execute on function t_jpg(int) to authenticated, service_role;
create or replace function t_hf(cons boolean, nm text, ans jsonb default '{"high_bp":true,"allergies":"nuts"}', code text default null) returns jsonb language sql as $$
  select public.guest_health_form((select v from t_out where k='tok'), (select v::uuid from t_out where k='aid'), coalesce(code, (select v from t_out where k='code')), jsonb_build_object('consent', cons, 'signed_name', nm, 'answers', ans)) $$;
grant execute on function t_hf(boolean, text, jsonb, text) to authenticated, service_role;

-- ── guest health form: only a spa ──
select t_rows(null, 'service_role', $$select 1 where (public.guest_health_form_info((select v from t_out where k='tok')) ->> 'enabled') = 'false'$$, 1, 'a salon does not offer the health form');
select t_rows(null, 'service_role', $$select 1 where (t_hf(true, 'Anna Lee') ->> 'error') = 'off'$$, 1, 'and refuses it');
update public.stores set profile = 'spa' where name = 'Salon';
select t_rows(null, 'service_role', $$select 1 where (public.guest_health_form_info((select v from t_out where k='tok')) ->> 'enabled') = 'true'$$, 1, 'a spa offers it');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select t_hf(true, 'Anna Lee')$$, '42501', 'the browser cannot call it directly');
select t_rows(null, 'service_role', $$select 1 where (t_hf(true, 'Anna Lee', '{"high_bp":true}', 'WRONG123') ->> 'error') = 'invalid'$$, 1, 'a wrong booking code is refused');
select t_rows(null, 'service_role', $$select 1 where (t_hf(false, 'Anna Lee') ->> 'error') = 'consent_needed'$$, 1, 'no consent, no form');
select t_rows(null, 'service_role', $$select 1 where (t_hf(true, 'A') ->> 'error') = 'bad_name'$$, 1, 'a signature needs a real name');
select t_rows(null, 'service_role', $$select 1 where (t_hf(true, 'Anna Lee', '{"cancer_stage":"x"}') ->> 'error') = 'bad_answers'$$, 1, 'answers outside the closed set are refused');
select t_rows(null, 'service_role', $$select 1 where (t_hf(true, 'Anna Lee') ->> 'ok') = 'true'$$, 1, 'the guest signs the form on her phone');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.health_intakes where source = 'guest' and appointment_id = (select v::uuid from t_out where k='aid') and customer_id is null and signed_name = 'Anna Lee' and answers ->> 'allergies' = 'nuts'$$, 1, 'the front desk sees it on the booking (no member needed)');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where entity = 'health_intakes' and detail::text not like '%nuts%' and detail::text not like '%Anna%'$$, 1, 'the audit line never carries the content');
select t_rows(null, 'service_role', $$select 1 where (t_hf(true, 'Anna Lee') ->> 'ok') = 'true' and (t_hf(true, 'Anna Lee') ->> 'ok') = 'true'$$, 1, 'she may send it again (a newer one is the latest)');
select t_rows(null, 'service_role', $$select 1 where (t_hf(true, 'Anna Lee') ->> 'error') = 'too_many'$$, 1, 'but no more than three per booking');

-- ── before / after photos ──
create or replace function t_cp(kind text, cons boolean, data text default null, cust text default 'cust') returns jsonb language sql as $$
  select jsonb_build_object('store_id', (select v from t_out where k='store'), 'customer_id', (select v from t_out where k=cust), 'kind', kind, 'consent', cons, 'mime', 'image/jpeg', 'data', coalesce(data, t_jpg())) $$;
grant execute on function t_cp(text, boolean, text, text) to authenticated, service_role;
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.add_client_photo(t_cp('before', false))$$, '22023', 'no consent tick, no photo');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.add_client_photo(t_cp('selfie', true))$$, '22023', 'only before / after / other');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.add_client_photo(t_cp('before', true, t_jpg(300000)))$$, '22023', 'over 256 KB is refused');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.add_client_photo(t_cp('before', true))$$, '42501', 'another business cannot');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'p1', $$select public.add_client_photo(t_cp('before', true))::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'p2', $$select public.add_client_photo(t_cp('after', true))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select 1 from public.client_photos where kind in ('before', 'after') and expires_at > now() + interval '11 months'$$, 2, 'the manager sees both, kept 12 months');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select * from public.client_photo_data$$, '42501', 'the picture table cannot be read by the browser');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'g1', $$select public.get_client_photo((select v::uuid from t_out where k='p1'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k = 'g1' and (v::jsonb ->> 'mime') = 'image/jpeg'$$, 1, 'the front desk can look at one');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.get_client_photo((select v::uuid from t_out where k='p1'))$$, '42501', 'another business cannot');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.delete_client_photo((select v::uuid from t_out where k='p1'))$$, '42501', 'a cashier cannot erase');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.delete_client_photo((select v::uuid from t_out where k='p1'))$$, 1, 'a manager erases one');
update public.client_photos set expires_at = now() - interval '1 minute';
select t_rows(null, 'service_role', $$select 1 where public.client_photos_cleanup() = 1$$, 1, 'an expired photo is erased by the clean-up');
select t_rows(null, 'service_role', $$select 1 from public.client_photo_data$$, 0, 'and its picture is gone');
do $$ begin raise notice 'ALL GUEST HEALTH AND CLIENT PHOTO TESTS PASSED'; end $$;
