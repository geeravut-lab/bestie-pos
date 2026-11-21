-- Migration 67: weekly days off that repeat by themselves, and reminders for counter bookings.
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

-- a weekday number that is surely "next Thursday" and one day earlier, computed in Bangkok time
create or replace function t_wd(offset_days int) returns int language sql as $$
  select extract(isodow from (now() at time zone 'Asia/Bangkok')::date + offset_days)::int $$;
grant execute on function t_wd(int) to authenticated, service_role;
create or replace function t_w(res text, days text, f text default null, t text default null) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('store_id', (select v from t_out where k='store'), 'resource_id', (select v from t_out where k=res), 'weekdays', days::jsonb, 'from_time', f, 'to_time', t, 'reason', 'weekly')) $$;
grant execute on function t_w(text, text, text, text) to authenticated, service_role;
create or replace function t_bk(offset_days int, hhmm text, who text default 'Anna') returns jsonb language sql as $$
  select jsonb_build_object('store_id', (select v from t_out where k='store'), 'provider_id', (select v from t_out where k='nok'), 'service_id', (select v from t_out where k='svc'), 'starts_at', t_day(offset_days, hhmm), 'guest_name', who) $$;
grant execute on function t_bk(int, text, text) to authenticated, service_role;

-- ── who may, and what is refused ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_weekly_off(t_w('nok', '[1]'))$$, '42501', 'a cashier cannot set a weekly day off');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.save_weekly_off(t_w('nok', '[1]'))$$, '42501', 'another business cannot');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_weekly_off(t_w('nok', '[8]'))$$, '22023', 'weekday 8 does not exist');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_weekly_off(t_w('nok', '[]'))$$, '22023', 'at least one weekday');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_weekly_off(t_w('nok', '[1]', '13:00', '12:00'))$$, '22023', 'the end must be after the start');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_weekly_off(t_w('nok', '[1]') || jsonb_build_object('store_id', (select v from t_out where k='resto2')))$$, '0A000', 'a shop without the appointments module is refused');

-- ── a booking over the pattern must be moved first ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ok1', $$select public.book_appointment(t_bk(10, '10:00'))::text$$);
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_weekly_off(t_w('nok', jsonb_build_array(t_wd(10))::text))$$, '23P01', 'a weekly off cannot be put over a live booking (10 days ahead)');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_weekly_off(t_w('nok', jsonb_build_array(t_wd(10))::text, '13:00', '14:00'))$$, 1, 'but a lunch break that day after the booking is fine');

-- ── the pattern refuses bookings by itself, every week ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_appointment(t_bk(10, '13:15', 'Ben'))$$, '23P01', 'lunch of that weekday: refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_appointment(t_bk(17, '13:15', 'Ben'))$$, '23P01', 'and one week later, with no new entry');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_appointment(t_bk(24, '12:30', 'Ben'))$$, '23P01', 'a booking that runs into the break (12:30-13:30) is refused too');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ok2', $$select public.book_appointment(t_bk(17, '14:00', 'Cara'))::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ok3', $$select public.book_appointment(t_bk(11, '13:15', 'Dee'))::text$$);
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.appointments) = 3$$, 1, 'another weekday, and just after the break, are bookable');
select t_err(null, 'service_role', $$select public.appointment_check_free((select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='nok'), null, t_day(31,'13:15')::timestamptz, t_day(31,'14:15')::timestamptz)$$, '23P01', 'the shared rule (online booking uses it) refuses the weekly lunch too');

-- ── whole days: every Sunday ──
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_weekly_off(t_w('fon', '[7]'))$$, 1, 'Fon is off every Sunday (all day)');
select t_rows(null, 'service_role', $$select 1 where public.weekly_pattern_hit(7, '00:00', null, '2030-01-06T03:00:00+07:00', '2030-01-06T04:00:00+07:00') and not public.weekly_pattern_hit(7, '00:00', null, '2030-01-07T03:00:00+07:00', '2030-01-07T04:00:00+07:00')$$, 1, '6 Jan 2030 is a Sunday, 7 Jan a Monday');
select t_rows(null, 'service_role', $$select 1 where public.weekly_pattern_hit(1, '00:00', null, '2030-01-06T23:30:00+07:00', '2030-01-07T00:30:00+07:00')$$, 1, 'a booking over midnight touches the Monday');
select t_rows(null, 'service_role', $$select 1 where not public.weekly_pattern_hit(7, '00:00', null, '2030-01-05T22:00:00+07:00', '2030-01-06T00:00:00+07:00')$$, 1, 'ending exactly at midnight does not touch the Sunday');

-- ── seeing and removing ──
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.resource_weekly_offs$$, 2, 'everyone in the shop can see the weekly days off');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.resource_weekly_offs$$, 0, 'another business cannot');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.delete_weekly_off((select id from public.resource_weekly_offs limit 1))$$, '42501', 'a cashier cannot remove one');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.delete_weekly_off((select id from public.resource_weekly_offs where weekday = t_wd(10)))$$, 1, 'the manager removes the lunch break');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ok4', $$select public.book_appointment(t_bk(24, '13:15', 'Eve'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.audit_log where entity = 'resource_weekly_offs'$$, 3, 'every change is in the audit trail (2 saves, 1 removal... one save for each call)');

-- ── (b) reminders for a counter booking ──
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.set_appointment_contact((select v::uuid from t_out where k='ok1'), 'a@b.co')$$, '42501', 'another business cannot save a contact');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.set_appointment_contact((select v::uuid from t_out where k='ok1'), 'not an email')$$, '22023', 'a bad e-mail is refused');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_contact((select v::uuid from t_out where k='ok1'), ' Anna@Example.com ')$$, 1, 'the front desk saves the e-mail');
select t_rows(null, 'service_role', $$select 1 from public.appointments where id = (select v::uuid from t_out where k='ok1') and guest_email = 'anna@example.com'$$, 1, 'lower-cased');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_contact((select v::uuid from t_out where k='ok1'), '')$$, 1, 'an empty address removes it');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'code', $$select public.appointment_guest_code((select v::uuid from t_out where k='ok1'))$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='code' and v ~ '^[0-9A-F]{8}$'$$, 1, 'the guest gets an 8-character code');
select t_rows(null, 'service_role', $$select 1 from public.appointments a where a.id = (select v::uuid from t_out where k='ok1') and a.cancel_hash = encode(sha256(convert_to((select v from t_out where k='code'), 'utf8')), 'hex')$$, 1, 'only its hash is kept');
select t_rows(null, 'service_role', $$select 1 where (public.guest_bind_line((select v from t_out where k='code'), 'Uabcdef123456') ->> 'ok') = 'true'$$, 1, 'the LINE webhook binds the guest to THIS counter booking with that code');
select t_rows(null, 'service_role', $$select 1 from public.appointments where id = (select v::uuid from t_out where k='ok1') and guest_line_user_id = 'Uabcdef123456'$$, 1, 'the LINE user is on the booking');
select t_rows(null, 'service_role', $$select 1 where (public.guest_bind_line('00000000', 'Uabcdef123456') ->> 'ok') = 'false'$$, 1, 'a wrong code binds nothing');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.appointment_guest_code((select v::uuid from t_out where k='ok1')) || public.appointment_guest_code(gen_random_uuid())$$, '42501', 'an unknown booking is refused');
do $$ begin raise notice 'ALL WEEKLY OFF AND CONTACT TESTS PASSED'; end $$;
