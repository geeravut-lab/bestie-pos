-- Smart operations: forecast, waste, lots, cost alerts, service cases, business manager, ETA, disputes and refunds.
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
select t_rows(null, 'service_role', $$select 1 where (public.guest_tour_book((select v from t_out where k='tok'), jsonb_build_object('slot_id', (select v from t_out where k='slot'), 'name', 'Anna', 'phone', '0833333333', 'seats', 2, 'client_id', '40000000-0000-4000-8000-000000000001')) ->> 'replay') = 'true'$$, 1, 'the same request books nothing twice');
select t_rows(null, 'service_role', $$select 1 where (public.guest_tour_book((select v from t_out where k='tok'), jsonb_build_object('slot_id', (select v from t_out where k='slot'), 'name', 'Ben', 'phone', '0844444444', 'seats', 5, 'client_id', '40000000-0000-4000-8000-000000000002')) ->> 'error') = 'full'$$, 1, 'only 4 seats are left: 5 is refused');
select t_rows(null, 'service_role', $$select 1 where (public.guest_tour_book((select v from t_out where k='tok'), jsonb_build_object('slot_id', (select v from t_out where k='soon'), 'name', 'Cy', 'phone', '0855555555', 'seats', 1, 'client_id', '40000000-0000-4000-8000-000000000003')) ->> 'error') = 'unavailable'$$, 1, 'a slot inside the notice time cannot be booked online');
select t_rows(null, 'service_role', $$select 1 where (public.guest_tour_book((select v from t_out where k='tok'), jsonb_build_object('slot_id', (select v from t_out where k='slot'), 'name', '', 'phone', '0855555555', 'seats', 1, 'client_id', '40000000-0000-4000-8000-000000000004')) ->> 'error') = 'invalid'$$, 1, 'a missing name is refused');
select t_rows(null, 'service_role', $$select 1 where (public.guest_tour_book('0000', jsonb_build_object('slot_id', (select v from t_out where k='slot'), 'name', 'X', 'phone', '0855555555', 'seats', 1)) ->> 'error') = 'not_found'$$, 1, 'a wrong link books nothing');
select t_val(null, 'service_role', 'st', $$select public.guest_tour_status((select v from t_out where k='tok'), (select v::uuid from t_out where k='bid'), (select v from t_out where k='bcode'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='st' and (v::jsonb ->> 'status') = 'booked' and (v::jsonb ->> 'deposit_received') = '0' and (v::jsonb ->> 'deposit_due') = '120000'$$, 1, 'the guest sees: booked, nothing received yet');
select t_rows(null, 'service_role', $$select 1 where public.guest_tour_status((select v from t_out where k='tok'), (select v::uuid from t_out where k='bid'), 'WRONGCODE') is null$$, 1, 'a wrong code shows nothing');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.tour_bookings where source = 'online' and deposit_due = 120000$$, 1, 'the front desk sees the online booking and what is due');

-- ═══ cash deposits and the drawer ═══
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.take_tour_deposit(jsonb_build_object('booking_id', (select v from t_out where k='bid'), 'amount', 120000, 'method', 'cash'))$$, '22023', 'a cash deposit must name a till');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.take_tour_deposit(jsonb_build_object('booking_id', (select v from t_out where k='bid'), 'amount', 999999999, 'method', 'cash', 'device_id', (select v from t_out where k='dev')))$$, '22023', 'more than the price is refused');
select t_rows(null, 'service_role', $$insert into public.shifts (org_id, store_id, device_id, opened_at, opening_cash) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='dev'), now() - interval '1 hour', 5000)$$, 1, 'a shift is open with 50.00');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.take_tour_deposit(jsonb_build_object('booking_id', (select v from t_out where k='bid'), 'amount', 120000, 'method', 'cash', 'device_id', (select v from t_out where k='dev')))$$, 1, 'the deposit is paid in cash at the till');
select t_val(null, 'service_role', 'st2', $$select public.guest_tour_status((select v from t_out where k='tok'), (select v::uuid from t_out where k='bid'), (select v from t_out where k='bcode'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='st2' and (v::jsonb ->> 'deposit_received') = '120000'$$, 1, 'the guest page now shows the deposit as received');
select t_rows(null, 'service_role', $$select 1 where public.tour_release_unpaid() = 0$$, 1, 'a paid booking is never released');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'sh1', $$select id::text from public.shifts where status = 'open' and device_id = (select v::uuid from t_out where k='dev')$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'close1', $$select public.close_shift(jsonb_build_object('id', (select v from t_out where k='sh1'), 'closed_at', now(), 'counted_cash', 125000, 'staff_id', (select v from t_out where k='cash_staff')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='close1' and (v::jsonb ->> 'expected_cash') = '125000' and (v::jsonb ->> 'variance') = '0'$$, 1, 'the drawer expects 50.00 opening + 1,200.00 cash deposit = 1,250.00; counted 1,250.00, no difference');

-- ═══ the bill takes the deposit as already paid; check-in first ═══
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.tour_to_order(jsonb_build_object('booking_id', (select v from t_out where k='bid')))$$, '55000', 'billing needs check-in');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_tour_booking_status((select v::uuid from t_out where k='bid'), 'checked_in')$$, 1, 'checked in');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'tb', $$select public.tour_to_order(jsonb_build_object('booking_id', (select v from t_out where k='bid')))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.order_partial_payments where order_id = (select v::uuid from t_out where k='tb') and tender = 'cash' and amount = 120000 and kind = 'deposit' and provider_ref like 'deposit:%'$$, 1, 'the cash deposit is a paid share of the bill (with a deposit reference: the drawer does not count it twice)');
select t_rows(null, 'service_role', $$select 1 from public.tour_deposits where status = 'on_bill'$$, 1, 'the deposit is marked as on the bill');

-- ═══ an unpaid online booking is released; a guest cancels; a manager settles the deposit ═══
select t_val(null, 'service_role', 'bk2', $$select public.guest_tour_book((select v from t_out where k='tok'), jsonb_build_object('slot_id', (select v from t_out where k='slot'), 'name', 'Ben', 'phone', '0844444444', 'seats', 2, 'client_id', '40000000-0000-4000-8000-000000000005'))::text$$);
select t_rows(null, 'service_role', $$select 1 where public.tour_release_unpaid() = 0$$, 1, 'inside the hold time nothing is released');
select t_rows(null, 'service_role', $$update public.tour_bookings set hold_until = now() - interval '1 minute' where guest_name = 'Ben'$$, 1, 'an hour passes');
select t_rows(null, 'service_role', $$select 1 where public.tour_release_unpaid() = 1$$, 1, 'Ben''s unpaid booking is released');
select t_rows(null, 'service_role', $$select 1 where public.tour_seats_taken((select v::uuid from t_out where k='slot')) = 2$$, 1, 'his seats are free again (only Anna''s 2 remain)');
select t_val(null, 'service_role', 'bk3', $$select public.guest_tour_book((select v from t_out where k='tok'), jsonb_build_object('slot_id', (select v from t_out where k='slot'), 'name', 'Dee', 'phone', '0866666666', 'seats', 1, 'client_id', '40000000-0000-4000-8000-000000000006'))::text$$);
select t_val(null, 'service_role', 'b3id', $$select v::jsonb ->> 'id' from t_out where k='bk3'$$);
select t_val(null, 'service_role', 'b3code', $$select v::jsonb ->> 'code' from t_out where k='bk3'$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.take_tour_deposit(jsonb_build_object('booking_id', (select v from t_out where k='b3id'), 'amount', 60000, 'method', 'cash', 'device_id', (select v from t_out where k='dev')))$$, 1, 'Dee pays 600.00 in cash');
select t_rows(null, 'service_role', $$select 1 where (public.guest_tour_cancel((select v from t_out where k='tok'), (select v::uuid from t_out where k='b3id'), 'WRONGCODE') ->> 'error') = 'not_found'$$, 1, 'a wrong code cannot cancel');
select t_rows(null, 'service_role', $$select 1 where (public.guest_tour_cancel((select v from t_out where k='tok'), (select v::uuid from t_out where k='b3id'), (select v from t_out where k='b3code')) ->> 'deposit_received') = '60000'$$, 1, 'Dee cancels with her code; her 600.00 stays held for a manager');
select t_rows(null, 'service_role', $$select 1 where (public.guest_tour_cancel((select v from t_out where k='tok'), (select v::uuid from t_out where k='b3id'), (select v from t_out where k='b3code')) ->> 'error') = 'too_late'$$, 1, 'cancelling twice is refused');
select t_val(null, 'service_role', 'dep3', $$select id::text from public.tour_deposits where booking_id = (select v::uuid from t_out where k='b3id')$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.resolve_tour_deposit(jsonb_build_object('deposit_id', (select v from t_out where k='dep3'), 'action', 'refund', 'device_id', (select v from t_out where k='dev')))$$, '42501', 'a cashier cannot settle a deposit');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.resolve_tour_deposit(jsonb_build_object('deposit_id', (select v from t_out where k='dep3'), 'action', 'refund'))$$, '22023', 'a cash refund names a till');
select t_rows(null, 'service_role', $$insert into public.shifts (org_id, store_id, device_id, opened_at, opening_cash) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='dev'), now(), 1000)$$, 1, 'a new shift opens with 10.00');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.resolve_tour_deposit(jsonb_build_object('deposit_id', (select v from t_out where k='dep3'), 'action', 'refund', 'device_id', (select v from t_out where k='dev')))$$, 1, 'the owner refunds Dee in cash from the till');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.resolve_tour_deposit(jsonb_build_object('deposit_id', (select v from t_out where k='dep3'), 'action', 'refund', 'device_id', (select v from t_out where k='dev')))$$, '55000', 'a deposit is settled once');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'sh2', $$select id::text from public.shifts where status = 'open' and device_id = (select v::uuid from t_out where k='dev')$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'close2', $$select public.close_shift(jsonb_build_object('id', (select v from t_out where k='sh2'), 'closed_at', now(), 'counted_cash', 1000, 'staff_id', (select v from t_out where k='cash_staff')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='close2' and (v::jsonb ->> 'expected_cash') = '-59000'$$, 1, 'this shift: 10.00 opening − 600.00 refunded in cash (the deposits taken before it opened are not in it) = −590.00');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.audit_log where action = 'payment.refund' and entity = 'tour_deposits') = 1$$, 1, 'the refund is a critical audit event');
-- ═══ the kitchen account can use the time clock (role audit) ═══
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f6', 'kitchen@example.test');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000f6'::uuid, 'Cook', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'kitchen' where o.name = 'Acme Co';
update public.stores set module_overrides = module_overrides || '{"timeclock": true}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_val('00000000-0000-0000-0000-0000000000f6', 'authenticated', 'cook', $$select id::text from public.staff where display_name = 'Cook'$$);
select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select 1 where (public.clock_toggle(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', (select v from t_out where k='cook'))) ->> 'state') = 'in'$$, 1, 'the kitchen account clocks in');
select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select 1 where jsonb_array_length(public.time_status((select v::uuid from t_out where k='store'))) = 1$$, 1, 'and sees who is in');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.time_status((select v::uuid from t_out where k='store'))$$, '42501', 'a person of another business still cannot');
-- platform kill switch also reaches the new module
select t_rows(null, 'service_role', $$insert into public.platform_flags (module_id) values ('tours.online')$$, 1, 'the platform switches tours.online off');
select t_rows(null, 'service_role', $$select 1 where (public.guest_tour_info((select v from t_out where k='tok')) ->> 'open') = 'false'$$, 1, 'the guest page says closed, whatever the shop chose');

\echo ALL TOURS ONLINE TESTS PASSED
