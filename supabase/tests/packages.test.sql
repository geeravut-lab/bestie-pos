-- Packages / memberships: catalogue, sale on a bill, activation on payment, use per visit, expiry, undo, commission.
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
select t_val(null, 'service_role', 'resto', $$insert into public.stores (org_id, legal_entity_id, name, profile) select org_id, legal_entity_id, 'Resto', 'restaurant' from public.stores where name = 'Salon' returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Counter', 'cashier', 'POS-77') returning id::text$$);
select t_val(null, 'service_role', 'cashier_staff', $$select id::text from public.staff where display_name = 'Cashier'$$);
select t_val(null, 'service_role', 'nok_staff', $$select id::text from public.staff where display_name = 'Stylist Nok'$$);
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'nok', $$insert into public.resources (org_id, store_id, name, kind, staff_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Nok', 'stylist', (select v::uuid from t_out where k='nok_staff')) returning id::text$$);
select t_val(null, 'service_role', 'cat', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"x"}') returning id::text$$);
select t_val(null, 'service_role', 'svc', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, duration_min) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"นวด"}', '{"base": 100000}', 60) returning id::text$$);
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.set_commission_rate(jsonb_build_object('store_id', (select v from t_out where k='store'), 'service_bps', 1000, 'product_bps', 500))$$, 1, 'a 10 % service commission is set');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'anna', $$select (public.create_customer(jsonb_build_object('org_id', (select v from t_out where k='org'), 'name', 'Anna')) ->> 'id')$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ben', $$select (public.create_customer(jsonb_build_object('org_id', (select v from t_out where k='org'), 'name', 'Ben')) ->> 'id')$$);

-- ── the catalogue ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.service_packages (org_id, store_id, name, price, visits, valid_days) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"นวด 10 ครั้ง"}', 800000, 10, 180)$$, '42501', 'a cashier cannot make packages');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'pkg', $$insert into public.service_packages (org_id, store_id, name, price, visits, valid_days) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"นวด 10 ครั้ง","en":"Massage x10"}', 800000, 10, 180) returning id::text$$);
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$insert into public.service_packages (org_id, store_id, name, price, visits) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"x"}', 800000, 0)$$, '23514', 'a package has at least one visit');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.service_packages$$, 0, 'another business sees no packages');

-- ── selling ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.sell_package(jsonb_build_object('store_id', (select v from t_out where k='resto'), 'package_id', (select v from t_out where k='pkg'), 'customer_id', (select v from t_out where k='anna')))$$, '0A000', 'a restaurant has no packages module');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.sell_package(jsonb_build_object('store_id', (select v from t_out where k='store'), 'package_id', gen_random_uuid(), 'customer_id', (select v from t_out where k='anna')))$$, '22023', 'an unknown package is refused');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.sell_package(jsonb_build_object('store_id', (select v from t_out where k='store'), 'package_id', (select v from t_out where k='pkg'), 'customer_id', (select v from t_out where k='anna')))$$, '42501', 'another business cannot sell it');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'o1', $$select public.sell_package(jsonb_build_object('store_id', (select v from t_out where k='store'), 'package_id', (select v from t_out where k='pkg'), 'customer_id', (select v from t_out where k='anna'), 'device_id', (select v from t_out where k='dev')))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.orders where id = (select v::uuid from t_out where k='o1') and number = 'PK001' and status = 'open' and customer_id = (select v::uuid from t_out where k='anna')$$, 1, 'the sale is bill PK001 with Anna on it');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where order_id = (select v::uuid from t_out where k='o1') and unit_price = 800000 and quantity = 1 and item_id is null$$, 1, 'one line at 8,000.00');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.customer_packages where order_id = (select v::uuid from t_out where k='o1') and status = 'pending' and visits_left = 10 and visits_total = 10 and price = 800000$$, 1, 'Anna''s package is pending with 10 visits (snapshot of the price)');
select t_val(null, 'service_role', 'cp1', $$select id::text from public.customer_packages where order_id = (select v::uuid from t_out where k='o1')$$);

-- a visit before the package is paid
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'a1', $$select public.book_appointment(jsonb_build_object('store_id', (select v from t_out where k='store'), 'provider_id', (select v from t_out where k='nok'), 'service_id', (select v from t_out where k='svc'), 'customer_id', (select v from t_out where k='anna'), 'starts_at', '2030-01-15T10:00:00+07:00', 'guest_name', 'Anna'))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_status((select v::uuid from t_out where k='a1'), 'arrived')$$, 1, 'Anna arrives');
create or replace function t_use(appt text, cp text default 'cp1') returns jsonb language sql as $$
  select jsonb_build_object('appointment_id', (select v from t_out where k=appt), 'customer_package_id', (select v from t_out where k=cp)) $$;
grant execute on function t_use(text, text) to authenticated, service_role;
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.use_package(t_use('a1'))$$, '55000', 'an unpaid package has no visits to use yet');

-- pay the package bill: 8,000.00 cash
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(jsonb_build_object('order_id', (select v from t_out where k='o1'), 'device_id', (select v from t_out where k='dev'), 'staff_id', (select v from t_out where k='cashier_staff'), 'issued_at', now(), 'lang', 'en', 'subtotal', 800000, 'service_charge', 0, 'vat', 52336, 'net_before_vat', 747664, 'total', 800000, 'rounding', 0, 'payable', 800000, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive', 'payments', jsonb_build_array(t_leg_cash('75000000-0000-4000-8000-000000000001', 800000, 800000))))$$, 1, 'the package bill is paid');
select t_rows(null, 'service_role', $$select 1 from public.customer_packages where id = (select v::uuid from t_out where k='cp1') and status = 'active' and activated_at is not null and valid_until = (now() at time zone 'Asia/Bangkok')::date + 180$$, 1, 'paying activates it and starts the 180 days');

-- ── using a visit ──
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'a_far', $$select public.book_appointment(jsonb_build_object('store_id', (select v from t_out where k='store'), 'provider_id', (select v from t_out where k='nok'), 'service_id', (select v from t_out where k='svc'), 'starts_at', '2030-01-16T10:00:00+07:00', 'guest_name', 'Walk-in'))::text$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.use_package(t_use('a_far'))$$, '22023', 'a booking of nobody (or of another member) cannot use Anna''s package');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'a_ben', $$select public.book_appointment(jsonb_build_object('store_id', (select v from t_out where k='store'), 'provider_id', (select v from t_out where k='nok'), 'service_id', (select v from t_out where k='svc'), 'customer_id', (select v from t_out where k='ben'), 'starts_at', '2030-01-17T10:00:00+07:00', 'guest_name', 'Ben'))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_appointment_status((select v::uuid from t_out where k='a_ben'), 'arrived')$$, 1, 'Ben arrives');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.use_package(t_use('a_ben'))$$, '22023', 'Ben cannot use Anna''s package');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.use_package(t_use('a1'))$$, '42501', 'another business cannot use it');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'u1', $$select public.use_package(t_use('a1'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.customer_packages where id = (select v::uuid from t_out where k='cp1') and visits_left = 9 and status = 'active'$$, 1, 'one visit is used: 9 left');
select t_rows(null, 'service_role', $$select 1 from public.appointments where id = (select v::uuid from t_out where k='a1') and status = 'done' and customer_package_id = (select v::uuid from t_out where k='cp1')$$, 1, 'the appointment is done and covered by the package');
select t_rows(null, 'service_role', $$select 1 from public.package_uses where id = (select v::uuid from t_out where k='u1') and kind = 'use' and value = 80000$$, 1, 'the visit is worth 800.00 (8,000.00 ÷ 10)');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'u1b', $$select public.use_package(t_use('a1'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='u1b' and v = (select v from t_out where k='u1')$$, 1, 'asking again for the same visit gives the same answer');
select t_rows(null, 'service_role', $$select 1 from public.customer_packages where id = (select v::uuid from t_out where k='cp1') and visits_left = 9$$, 1, 'and takes no second visit');

-- ── commission: the visit is a service sale of Nok ──
create or replace function t_rep() returns jsonb language sql as $$
  select jsonb_build_object('org_id', (select v from t_out where k='org'), 'from', to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM-DD'), 'to', to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM-DD')) $$;
grant execute on function t_rep() to authenticated, service_role;
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'rep', $$select public.commission_report(t_rep())::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out, jsonb_array_elements((v::jsonb) -> 'rows') r where k = 'rep' and r ->> 'name' = 'Stylist Nok' and (r ->> 'service_sales')::bigint = 74766 and (r ->> 'commission')::bigint = 7477$$, 1, 'Nok earns 10 % of the 800.00 visit before its 7 % VAT (747.66); the package sale itself earns nobody');

-- ── undo ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.undo_package_use((select v::uuid from t_out where k='u1'))$$, '42501', 'a cashier cannot take a visit back');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.undo_package_use((select v::uuid from t_out where k='u1'))$$, 1, 'the manager takes it back');
select t_rows(null, 'service_role', $$select 1 from public.customer_packages where id = (select v::uuid from t_out where k='cp1') and visits_left = 10$$, 1, 'the visit returns: 10 left');
select t_rows(null, 'service_role', $$select 1 from public.appointments where id = (select v::uuid from t_out where k='a1') and status = 'arrived' and customer_package_id is null$$, 1, 'the appointment is open again');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.undo_package_use((select v::uuid from t_out where k='u1'))$$, '55000', 'it cannot be taken back twice');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'rep2', $$select public.commission_report(t_rep())::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out, jsonb_array_elements((v::jsonb) -> 'rows') r where k = 'rep2' and r ->> 'name' = 'Stylist Nok' and (r ->> 'service_sales')::bigint = 0 and (r ->> 'commission')::bigint = 0$$, 1, 'and the commission goes with it');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'u2', $$select public.use_package(t_use('a1'))::text$$);
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.package_uses) = 3$$, 1, 'use, undo, use: three rows of history');

-- ── expiry and the last visit ──
update public.customer_packages set valid_until = (now() at time zone 'Asia/Bangkok')::date - 1 where id = (select v::uuid from t_out where k='cp1');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.undo_package_use((select v::uuid from t_out where k='u2'))$$, 1, 'back to arrived for the next checks');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.use_package(t_use('a1'))$$, '55000', 'an expired package cannot be used');
update public.customer_packages set valid_until = null, visits_left = 1 where id = (select v::uuid from t_out where k='cp1');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'u3', $$select public.use_package(t_use('a1'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.customer_packages where id = (select v::uuid from t_out where k='cp1') and visits_left = 0 and status = 'used_up'$$, 1, 'the last visit makes it used up');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.undo_package_use((select v::uuid from t_out where k='u3'))$$, 1, 'undoing the last visit makes it active again');
select t_rows(null, 'service_role', $$select 1 from public.customer_packages where id = (select v::uuid from t_out where k='cp1') and visits_left = 1 and status = 'active'$$, 1, 'with that visit back');

-- ── a package whose bill is voided is cancelled ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'o2', $$select public.sell_package(jsonb_build_object('store_id', (select v from t_out where k='store'), 'package_id', (select v from t_out where k='pkg'), 'customer_id', (select v from t_out where k='ben')))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.orders where id = (select v::uuid from t_out where k='o2') and number = 'PK002'$$, 1, 'the next sale is PK002');
select t_rows(null, 'service_role', $$update public.orders set status = 'void' where id = (select v::uuid from t_out where k='o2') returning 1$$, 1, 'the bill is voided');
select t_rows(null, 'service_role', $$select 1 from public.customer_packages where order_id = (select v::uuid from t_out where k='o2') and status = 'cancelled'$$, 1, 'and the package never starts');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.customer_packages$$, 0, 'another business sees no member packages');

-- ── migration 65: income received in advance (owner rule E) ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'u4', $$select public.use_package(t_use('a1'))::text$$);
update public.customer_packages set valid_until = (now() at time zone 'Asia/Bangkok')::date - 1 where id = (select v::uuid from t_out where k='cp1');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'def', $$select public.package_deferred_report(jsonb_build_object('org_id', (select v from t_out where k='org'), 'store_id', (select v from t_out where k='store')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, public.customer_packages cp where o.k = 'def' and cp.id = (select v::uuid from t_out where k='cp1')
   and (o.v::jsonb ->> 'sold')::bigint = cp.price
   and (o.v::jsonb ->> 'released_by_visits')::bigint = (select sum(value) from public.package_uses where customer_package_id = cp.id)
   and (o.v::jsonb ->> 'released_by_expiry')::bigint = cp.price - (select sum(value) from public.package_uses where customer_package_id = cp.id)
   and (o.v::jsonb ->> 'deferred')::bigint = 0$$, 1, 'an expired package: what was paid is released by the visits used and the rest by the expiry; nothing is still deferred');
select t_rows(null, 'service_role', $$select 1 from t_out o where o.k = 'def' and o.v::jsonb ->> 'policy' = 'deferred' and (o.v::jsonb -> 'rows' -> 0 ->> 'expired')::boolean$$, 1, 'the report shows the policy and marks the package expired');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.package_deferred_report(jsonb_build_object('org_id', (select v from t_out where k='org')))$$, '42501', 'a cashier cannot read it');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'def0', $$select public.package_deferred_report(jsonb_build_object('org_id', (select v from t_out where k='org'), 'store_id', (select v from t_out where k='store'), 'as_of', (now() at time zone 'Asia/Bangkok')::date - 5))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, public.customer_packages cp where o.k = 'def0' and cp.id = (select v::uuid from t_out where k='cp1') and (o.v::jsonb ->> 'sold')::bigint = 0 and (o.v::jsonb ->> 'deferred')::bigint = 0$$, 1, 'five days ago the package had not been bought: nothing sold, nothing deferred (as-of date)');
do $$ begin raise notice 'ALL PACKAGE TESTS PASSED'; end $$;
