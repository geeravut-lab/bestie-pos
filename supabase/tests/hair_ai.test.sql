-- Hair-style advisor: catalogue rights, guest request with the booking code, photo consent / size / type / timing, who may look, deletion.
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
create or replace function t_jpg(n int default 300) returns text language sql as $$
  select encode('\xffd8ffe0'::bytea || convert_to(repeat('x', n), 'utf8'), 'base64') $$;
grant execute on function t_jpg(int) to authenticated, service_role;

-- ── catalogue ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_hair_style(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', '{"th":"บ๊อบ","en":"Bob"}'::jsonb))$$, '42501', 'a cashier cannot edit the style list');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_hair_style(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', '{"th":"บ๊อบ"}'::jsonb, 'lengths', '["tiny"]'::jsonb))$$, '23514', 'a length outside the closed set is refused');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 's1', $$select public.save_hair_style(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', '{"th":"บ๊อบ","en":"Bob"}'::jsonb, 'about', '{"en":"Chin-length"}'::jsonb, 'lengths', '["short","medium"]'::jsonb, 'textures', '["straight"]'::jsonb, 'faces', '["oval","heart"]'::jsonb, 'upkeep', 'low'))::text$$);
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 's2', $$select public.save_hair_style(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', '{"th":"ยาวเลเยอร์","en":"Long layers"}'::jsonb, 'lengths', '["long"]'::jsonb, 'upkeep', 'high'))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.hair_styles$$, 2, 'the front desk can read the catalogue');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.hair_styles$$, 0, 'another business cannot');
select t_rows(null, 'service_role', $$select 1 where jsonb_array_length(public.guest_hair_styles((select v from t_out where k='tok'))) = 2$$, 1, 'a guest (with the booking link) sees both styles');
select t_rows(null, 'service_role', $$select 1 where public.guest_hair_styles('0123456789abcdef0123456789abcdef') is null$$, 1, 'a wrong link sees nothing');

-- ── the guest's request ──
create or replace function t_hr(p jsonb, code text default null) returns jsonb language sql as $$
  select public.guest_hair_request((select v from t_out where k='tok'), (select v::uuid from t_out where k='aid'), coalesce(code, (select v from t_out where k='code')), p) $$;
grant execute on function t_hr(jsonb, text) to authenticated, service_role;
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select t_hr('{}'::jsonb)$$, '42501', 'the browser cannot call it directly');
select t_rows(null, 'service_role', $$select 1 where (t_hr('{}'::jsonb, 'WRONG123') ->> 'error') = 'invalid'$$, 1, 'a wrong booking code is refused');
select t_rows(null, 'service_role', $$select 1 where (t_hr(jsonb_build_object('answers', '{"length":"tiny"}'::jsonb)) ->> 'error') = 'bad_answers'$$, 1, 'an answer outside the closed set is refused');
select t_rows(null, 'service_role', $$select 1 where (t_hr(jsonb_build_object('style_id', gen_random_uuid())) ->> 'error') = 'bad_style'$$, 1, 'a style that is not in this shop is refused');
select t_rows(null, 'service_role', $$select 1 where (t_hr(jsonb_build_object('style_id', (select v from t_out where k='s1'), 'answers', '{"length":"short","texture":"straight","face":"oval","upkeep":"low"}'::jsonb)) ->> 'ok') = 'true'$$, 1, 'answers and a chosen style are saved with the booking');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.hair_requests where style_id = (select v::uuid from t_out where k='s1') and answers ->> 'face' = 'oval'$$, 1, 'the stylist sees them');

-- ── the photo ──
select t_rows(null, 'service_role', $$select 1 where (t_hr(jsonb_build_object('photo', jsonb_build_object('consent', false, 'mime', 'image/jpeg', 'data', t_jpg()))) ->> 'error') = 'consent_needed'$$, 1, 'no consent tick, no photo');
select t_rows(null, 'service_role', $$select 1 where (t_hr(jsonb_build_object('photo', jsonb_build_object('consent', true, 'mime', 'image/jpeg', 'data', t_jpg()))) ->> 'error') = 'photo_too_early'$$, 1, 'a booking 3 days away cannot take a photo yet (only within 48 hours)');
update public.appointments set starts_at = now() + interval '10 hours', ends_at = now() + interval '11 hours';
select t_rows(null, 'service_role', $$select 1 where (t_hr(jsonb_build_object('photo', jsonb_build_object('consent', true, 'mime', 'image/png', 'data', t_jpg()))) ->> 'error') = 'bad_photo'$$, 1, 'a file that is not what it says it is (JPEG bytes as PNG) is refused');
select t_rows(null, 'service_role', $$select 1 where (t_hr(jsonb_build_object('photo', jsonb_build_object('consent', true, 'mime', 'image/jpeg', 'data', t_jpg(300000)))) ->> 'error') = 'bad_photo'$$, 1, 'a photo over 256 KB is refused');
select t_rows(null, 'service_role', $$select 1 where (t_hr(jsonb_build_object('photo', jsonb_build_object('consent', true, 'mime', 'image/jpeg', 'data', 'not base64 !!'))) ->> 'error') = 'bad_photo'$$, 1, 'garbage is refused');
select t_rows(null, 'service_role', $$select 1 where (t_hr(jsonb_build_object('photo', jsonb_build_object('consent', true, 'mime', 'image/jpeg', 'data', t_jpg()))) ->> 'photo') = 'true'$$, 1, 'with consent, a small JPEG within 48 hours is stored');

-- ══ AI reads the photo (migration 71) ══
create or replace function t_ai(fn text, extra text default '') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  execute format('select public.%I((select v from t_out where k=%L), (select v::uuid from t_out where k=%L), (select v from t_out where k=%L)%s)', fn, 'tok', 'aid', 'code', extra) into r;
  return r;
end $$;
grant execute on function t_ai(text, text) to authenticated, service_role;

-- module off (the default): nothing works
select t_rows(null, 'service_role', $$select 1 where not public.hair_ai_enabled((select v::uuid from t_out where k='store'))$$, 1, 'the AI step is off by default');
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_state') ->> 'enabled') = 'false'$$, 1, 'the page is told it is off');
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_input') ->> 'error') = 'unavailable'$$, 1, 'no photo goes out while the module is off');
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_consent', ', true') ->> 'error') = 'unavailable'$$, 1, 'and no consent can be recorded');
update public.stores set module_overrides = '{"booking.online": true, "ai.hair": true}' where name = 'Salon';
select t_rows(null, 'service_role', $$select 1 where public.hair_ai_enabled((select v::uuid from t_out where k='store'))$$, 1, 'with the module on and online booking on, it is enabled');
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_state') ->> 'enabled') = 'true' and (t_ai('guest_hair_ai_state') ->> 'consent') = 'false'$$, 1, 'enabled but no consent yet');

-- the separate consent comes first
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_input') ->> 'error') = 'consent_needed'$$, 1, 'without the AI tick the photo is not handed out');
select t_rows(null, 'service_role', $$select 1 where (public.guest_hair_ai_input((select v from t_out where k='tok'), (select v::uuid from t_out where k='aid'), 'WRONG123') ->> 'error') = 'unavailable'$$, 1, 'a wrong booking code gets nothing');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select t_ai('guest_hair_ai_input')$$, '42501', 'the browser cannot call it');
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_save', ', ''{"length":"long"}''::jsonb') ->> 'error') = 'consent_needed'$$, 1, 'labels cannot be saved without the consent');
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_consent', ', true') ->> 'ok') = 'true'$$, 1, 'the guest gives the separate consent');
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_input') ->> 'ok') = 'true' and (t_ai('guest_hair_ai_input') ->> 'mime') = 'image/jpeg' and length(t_ai('guest_hair_ai_input') ->> 'data') > 100$$, 1, 'now the photo is handed to the server for the AI call');

-- only closed labels are kept
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_save', ', ''{"length":"enormous"}''::jsonb') ->> 'error') = 'bad_labels'$$, 1, 'a label outside the lists is refused');
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_save', ', ''{"length":"long","name":"Ann"}''::jsonb') ->> 'error') = 'bad_labels'$$, 1, 'an extra field (free text) is refused');
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_save', ', ''{"length":"long","texture":"wavy","thickness":"fine","colored":true,"condition":"healthy"}''::jsonb') ->> 'ok') = 'true'$$, 1, 'closed labels are saved');
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_state') -> 'labels' ->> 'texture') = 'wavy' and (t_ai('guest_hair_ai_state') ->> 'consent') = 'true'$$, 1, 'the page can show what was read');
select t_err(null, 'service_role', $$update public.hair_request_photos set ai_labels = '{"hair":"red"}'::jsonb$$, '23514', 'the table itself refuses anything but the closed labels');

-- the stylist sees the labels with the photo
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ph2', $$select public.get_hair_photo((select v::uuid from t_out where k='aid'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='ph2' and (v::jsonb -> 'ai_labels' ->> 'length') = 'long'$$, 1, 'the front desk sees the labels');

-- a new photo, or a withdrawal, erases the consent and the labels
select t_rows(null, 'service_role', $$select 1 where (t_hr(jsonb_build_object('photo', jsonb_build_object('consent', true, 'mime', 'image/jpeg', 'data', t_jpg(500)))) ->> 'photo') = 'true'$$, 1, 'the guest replaces the photo');
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_state') ->> 'consent') = 'false' and (t_ai('guest_hair_ai_state') -> 'labels') = 'null'::jsonb$$, 1, 'the consent and the labels of the old photo are gone');
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_consent', ', true') ->> 'ok') = 'true' and (t_ai('guest_hair_ai_save', ', ''{"length":"short"}''::jsonb') ->> 'ok') = 'true'$$, 1, 'consent again for the new photo and labels again');
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_consent', ', false') ->> 'ok') = 'true'$$, 1, 'the guest withdraws');
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_state') ->> 'consent') = 'false' and (t_ai('guest_hair_ai_state') -> 'labels') = 'null'::jsonb and (t_ai('guest_hair_ai_input') ->> 'error') = 'consent_needed'$$, 1, 'withdrawing erases what the AI read and blocks the next call');

-- the labels go with the photo
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_consent', ', true') ->> 'ok') = 'true' and (t_ai('guest_hair_ai_save', ', ''{"length":"short"}''::jsonb') ->> 'ok') = 'true'$$, 1, 'consent and labels once more');
update public.hair_requests set photo_expires_at = now() - interval '1 minute';
select t_rows(null, 'service_role', $$select 1 where public.hair_photos_cleanup() = 1$$, 1, 'the clean-up erases the photo');
select t_rows(null, 'service_role', $$select 1 from public.hair_request_photos$$, 0, 'with it the labels and the consent are gone (same row)');
select t_rows(null, 'service_role', $$select 1 where (t_ai('guest_hair_ai_input') ->> 'error') = 'unavailable'$$, 1, 'nothing can be read any more');

-- an unknown module id is still refused, the new one accepted
update public.stores set module_overrides = '{"ai.hair": true}' where name = 'Salon';
select t_err(null, 'service_role', $$update public.stores set module_overrides = '{"ai.nope": true}' where name = 'Salon'$$, '23514', 'unknown module ids are still refused');
do $$ begin raise notice 'ALL HAIR AI TESTS PASSED'; end $$;
