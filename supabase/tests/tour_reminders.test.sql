-- Reminders to tour guests: e-mail and LINE contact, one reminder a day ahead, erased when the booking is over.
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




-- the shop's calendar day (Bangkok) moves every day: the fixtures are placed relative to TODAY so this test never goes stale
create or replace function t_d(n int) returns date language sql as $$ select (now() at time zone 'Asia/Bangkok')::date + n $$;
create or replace function t_ds(n int) returns text language sql as $$ select ((now() at time zone 'Asia/Bangkok')::date + n)::text $$;
create or replace function t_ts(n int, hhmm text) returns timestamptz language sql as $$ select (((now() at time zone 'Asia/Bangkok')::date + n)::text || ' ' || hhmm || ':00+07')::timestamptz $$;
grant execute on function t_d(int), t_ds(int), t_ts(int, text) to anon, authenticated, service_role;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'manager@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme Co','Acme','restaurant')$$, 1, 'owner creates a restaurant');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','cafe')$$, 1, 'a second org exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('00000000-0000-0000-0000-0000000000b2'::uuid, 'Manager', 'manager'),
               ('00000000-0000-0000-0000-0000000000d4'::uuid, 'Cashier', 'cashier')) as u(id, n, b) on true
  join public.roles r on r.org_id = o.id and r.built_in = u.b
 where o.name = 'Acme Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Acme Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store2', $$select public.create_store((select v::uuid from t_out where k='org'), 'Beach Cafe', 'cafe')::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Counter', 'cashier') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev2', $$insert into public.devices (org_id, store_id, name, role) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), 'Cafe till', 'cashier') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cash_staff', $$select id::text from public.staff where display_name = 'Cashier'$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'mgr_staff', $$select id::text from public.staff where display_name = 'Manager'$$);

update public.stores set plan = 'pro', module_overrides = module_overrides || '{"slots.booking": true}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'slot', $$select public.save_tour_slot(jsonb_build_object('store_id', (select v from t_out where k='store'), 'title', '{"th":"ดำน้ำ","en":"Snorkel"}'::jsonb, 'starts_at', t_ts(3,'09:00'), 'duration_min', 240, 'capacity', 6, 'price', 150000))::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'soon', $$select public.save_tour_slot(jsonb_build_object('store_id', (select v from t_out where k='store'), 'title', '{"th":"เช้านี้"}'::jsonb, 'starts_at', to_char(now() + interval '30 minutes', 'YYYY-MM-DD"T"HH24:MI:SSOF'), 'duration_min', 60, 'capacity', 4, 'price', 50000))::text$$);

-- ═══ the link and its rules ═══
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.tour_link((select v::uuid from t_out where k='store'))$$, '42501', 'a cashier cannot read or make the link');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'lk', $$select public.tour_link((select v::uuid from t_out where k='store'))::text$$);
select t_val(null, 'service_role', 'tok', $$select v::jsonb ->> 'token' from t_out where k='lk'$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='lk' and (v::jsonb ->> 'token') ~ '^[0-9a-f]{32}$' and (v::jsonb -> 'settings' ->> 'deposit_pct') = '30' and (v::jsonb ->> 'enabled') = 'false'$$, 1, 'a link with the default rules (30 % deposit), the module still off');
select t_rows(null, 'service_role', $$select 1 where (public.guest_tour_info((select v from t_out where k='tok')) ->> 'open') = 'false'$$, 1, 'the page says closed while the module is off');
select t_rows(null, 'service_role', $$select 1 where public.guest_tour_info('nope') is null$$, 1, 'a wrong link shows nothing');
update public.stores set module_overrides = module_overrides || '{"tours.online": true}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_tour_booking_settings(jsonb_build_object('store_id', (select v from t_out where k='store'), 'deposit_pct', 50))$$, '42501', 'a cashier cannot change the rules');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_tour_booking_settings(jsonb_build_object('store_id', (select v from t_out where k='store'), 'deposit_pct', 40, 'hold_min', 60, 'pay_note', 'PromptPay 081-234-5678', 'notice_min', 120, 'days_ahead', 30))$$, 1, 'the owner sets 40 %, held 60 minutes');

-- ═══ the guest ═══
select t_val(null, 'service_role', 'info', $$select public.guest_tour_info((select v from t_out where k='tok'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='info' and (v::jsonb ->> 'open') = 'true' and jsonb_array_length(v::jsonb -> 'slots') = 1 and (v::jsonb -> 'slots' -> 0 ->> 'seats_left') = '6' and (v::jsonb -> 'slots' -> 0 ->> 'deposit_per_seat') = '60000'$$, 1, 'one slot is offered (the one 30 minutes away is inside the notice time); 40 % of 1,500.00 = 600.00 a seat');
select t_val(null, 'service_role', 'bk', $$select public.guest_tour_book((select v from t_out where k='tok'), jsonb_build_object('slot_id', (select v from t_out where k='slot'), 'name', 'Anna', 'phone', '083-333-3333', 'seats', 2, 'client_id', '40000000-0000-4000-8000-000000000001'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='bk' and (v::jsonb ->> 'ok') = 'true' and (v::jsonb ->> 'code') ~ '^[0-9A-F]{8}$' and (v::jsonb ->> 'deposit_due') = '120000' and (v::jsonb ->> 'hold_until') is not null$$, 1, 'booked: a cancel code, 1,200.00 deposit due, a hold deadline');
select t_val(null, 'service_role', 'bid', $$select v::jsonb ->> 'id' from t_out where k='bk'$$);
select t_val(null, 'service_role', 'bcode', $$select v::jsonb ->> 'code' from t_out where k='bk'$$);

-- ═══ contacts ═══
select t_rows(null, 'service_role', $$select 1 where (public.guest_tour_contact((select v from t_out where k='tok'), (select v::uuid from t_out where k='bid'), 'WRONGCODE', 'a@example.com') ->> 'error') = 'invalid'$$, 1, 'a wrong code stores nothing');
select t_rows(null, 'service_role', $$select 1 where (public.guest_tour_contact((select v from t_out where k='tok'), (select v::uuid from t_out where k='bid'), (select v from t_out where k='bcode'), 'not-an-email') ->> 'error') = 'bad_email'$$, 1, 'a bad address is refused');
select t_rows(null, 'service_role', $$select 1 where (public.guest_tour_contact((select v from t_out where k='tok'), (select v::uuid from t_out where k='bid'), lower((select v from t_out where k='bcode')), ' Anna@Example.COM ') ->> 'ok') = 'true'$$, 1, 'the code (any case) stores the e-mail, lower-cased');
select t_rows(null, 'service_role', $$select 1 from public.tour_bookings where id = (select v::uuid from t_out where k='bid') and guest_email = 'anna@example.com'$$, 1, 'it is on that booking');
select t_rows(null, 'service_role', $$select 1 where (public.guest_bind_line((select v from t_out where k='bcode'), 'Uabc123456') ->> 'ok') = 'true'$$, 1, 'the LINE webhook binds the same code to the tour booking');
select t_rows(null, 'service_role', $$select 1 from public.tour_bookings where id = (select v::uuid from t_out where k='bid') and guest_line_user_id = 'Uabc123456'$$, 1, 'the LINE user is on the tour booking');
select t_rows(null, 'service_role', $$select 1 where (public.guest_bind_line('ZZZZ9999', 'Uabc123456') ->> 'ok') = 'false'$$, 1, 'an unknown code still binds nothing');

-- ═══ who is due: the tour is 3 days away ═══
select t_rows(null, 'service_role', $$select 1 from public.guest_tour_reminders_due(1440)$$, 0, 'a tour in 3 days is not due within a day');
update public.tour_slots set starts_at = now() + interval '20 hours' where id = (select v::uuid from t_out where k='slot');
select t_rows(null, 'service_role', $$select 1 from public.guest_tour_reminders_due(1440) d where d.guest_email = 'anna@example.com' and d.guest_line_user_id = 'Uabc123456' and d.shop_name = 'Acme' and d.seats = 2$$, 1, 'tomorrow it is due with both contacts, the shop and the seats');
select t_rows(null, 'service_role', $$select 1 from public.guest_tour_reminders_due(60)$$, 0, 'not within the next hour');
select t_rows(null, 'service_role', $$select public.guest_tour_reminder_done((select v::uuid from t_out where k='bid'))$$, 1, 'one reminder is marked done');
select t_rows(null, 'service_role', $$select 1 from public.guest_tour_reminders_due(1440)$$, 0, 'and is never due again');

-- ═══ the front desk, for a counter booking ═══
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cbk', $$select (public.book_tour(jsonb_build_object('slot_id', (select v from t_out where k='slot'), 'guest_name', 'Ben', 'phone', '0844444444', 'seats', 1, 'client_id', '50000000-0000-4000-8000-000000000001')) ->> 'id')$$);
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.set_tour_contact((select v::uuid from t_out where k='cbk'), 'ben@example.com')$$, '42501', 'a person of another business cannot');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_tour_contact((select v::uuid from t_out where k='cbk'), 'nope')$$, '22023', 'a bad address is refused');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_tour_contact((select v::uuid from t_out where k='cbk'), 'Ben@Example.com')$$, 1, 'the cashier stores the e-mail');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ccode', $$select public.tour_guest_code((select v::uuid from t_out where k='cbk'))$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='ccode' and v ~ '^[0-9A-F]{8}$'$$, 1, 'a one-time code is shown');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.tour_guest_code((select v::uuid from t_out where k='bid'))$$, '55000', 'an online booking already gave its code to the guest');
select t_rows(null, 'service_role', $$select 1 where (public.guest_bind_line((select v from t_out where k='ccode'), 'Uben123456') ->> 'ok') = 'true'$$, 1, 'the guest sends the code to the shop LINE');
select t_rows(null, 'service_role', $$select 1 from public.guest_tour_reminders_due(1440) d where d.guest_name = 'Ben' and d.guest_email = 'ben@example.com' and d.guest_line_user_id = 'Uben123456'$$, 1, 'the counter booking is due too');

-- ═══ erased when the booking is over ═══
select t_rows(null, 'service_role', $$update public.tour_bookings set status = 'cancelled' where id = (select v::uuid from t_out where k='cbk')$$, 1, 'Ben cancels');
select t_rows(null, 'service_role', $$select public.guest_contacts_cleanup()$$, 1, 'the tidy runs');
select t_rows(null, 'service_role', $$select 1 from public.tour_bookings where id = (select v::uuid from t_out where k='cbk') and guest_email is null and guest_line_user_id is null$$, 1, 'a cancelled booking keeps no contact');
select t_rows(null, 'service_role', $$select 1 from public.tour_bookings where id = (select v::uuid from t_out where k='bid') and guest_email is not null$$, 1, 'a live booking keeps its contact until the tour is over');
update public.tour_slots set starts_at = now() - interval '2 hours' where id = (select v::uuid from t_out where k='slot');
select t_rows(null, 'service_role', $$select public.guest_contacts_cleanup()$$, 1, 'after the tour started');
select t_rows(null, 'service_role', $$select 1 from public.tour_bookings where guest_email is not null or guest_line_user_id is not null$$, 0, 'no tour contact is left');

\echo ALL TOUR REMINDER TESTS PASSED
