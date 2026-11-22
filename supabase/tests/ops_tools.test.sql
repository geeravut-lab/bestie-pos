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

select t_val(null, 'service_role', 'orgB', $$select id::text from public.orgs where name = 'Other'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'mgr_id', $$select id::text from public.staff where display_name = 'Manager'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'cashier_id', $$select id::text from public.staff where display_name = 'Cashier'$$);
create or replace function t_order(num text, st text, tbl text, mins int, paid boolean) returns uuid language plpgsql as $$
declare v_o uuid := gen_random_uuid();
begin
  insert into public.orders (id, org_id, store_id, number, business_date, channel, status, table_id, created_at)
  values (v_o, (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k = st), 'A' || lpad(num, 3, '0'), (now() at time zone 'Asia/Bangkok')::date, case when tbl is null then 'takeaway' else 'dine-in' end, 'open',
          (select v::uuid from t_out where k = tbl), now() - make_interval(mins => mins));
  insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, status, sent_at)
  values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k = st), v_o, '{"th":"ผัดไทย","en":"Pad Thai"}', 5000, 2, 'sent', now());
  if paid then
    update public.orders set status = 'paid' where id = v_o;
    insert into public.receipts (org_id, store_id, order_id, number, issued_at, seller_name, branch_code, vat_registered, vat_bps, service_bps, price_mode, subtotal, service_charge, vat, net_before_vat, total, rounding, payable)
    values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k = st), v_o, 'Z-' || lpad(num, 6, '0'), now(), 'Acme Co', '00000', true, 700, 0, 'inclusive', 10000, 0, 654, 9346, 10000, 0, 10000);
    insert into public.payments (org_id, store_id, order_id, tender, amount) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k = st), v_o, 'cash', 10000);
  end if;
  return v_o;
end $$;
grant execute on function t_order(text, text, text, int, boolean) to service_role;

-- ═══ points overview ═══
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'cust', $$select (public.create_customer(jsonb_build_object('org_id', (select v from t_out where k='org'), 'name', 'Noi', 'phone', '0822222222')) ->> 'id')$$);
select t_rows(null, 'service_role', $$insert into public.points_ledger (org_id, customer_id, store_id, kind, points, reason) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='cust'), (select v::uuid from t_out where k='store'), 'adjust', 250, 'test')$$, 1, 'Noi holds 250 points');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.points_overview((select v::uuid from t_out where k='orgB'))$$, '42501', 'another business''s points are not readable');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'pov', $$select public.points_overview((select v::uuid from t_out where k='org'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='pov' and (v::jsonb ->> 'outstanding') = '250' and (v::jsonb ->> 'members') = '1' and (v::jsonb -> 'top' -> 0 ->> 'name') = 'Noi'$$, 1, 'the overview: 250 points, 1 member, Noi on top');

-- ═══ 1 · WAITLIST ═══
select t_rows(null, 'service_role', $$insert into public.dining_tables (org_id, store_id, name, seats) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'T1', 4), ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'T2', 2)$$, 2, 'two tables');
select t_val(null, 'service_role', 't1', $$select id::text from public.dining_tables where name = 'T1'$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.waitlist_quote((select v::uuid from t_out where k='store'), 2) = 25$$, 1, 'no history: 45 min a table, two tables, nobody ahead → 25 minutes');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'w1', $$select (public.waitlist_add(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Anna', 'phone', '0833333333', 'party', 2, 'client_id', '30000000-0000-4000-8000-000000000001')) ->> 'id')$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (public.waitlist_add(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Anna', 'party', 2, 'client_id', '30000000-0000-4000-8000-000000000001')) ->> 'replay') = 'true'$$, 1, 'the same request adds nobody twice');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'w2', $$select (public.waitlist_add(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Ben', 'party', 3, 'client_id', '30000000-0000-4000-8000-000000000002')) ->> 'id')$$);
select t_rows(null, 'service_role', $$select 1 from public.waitlist_entries where name = 'Ben' and quoted_min = 90$$, 1, 'Ben (3 people) fits only the 4-seat table and one party waits: 45 x 2 / 1 = 90 minutes');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.waitlist_add(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'X', 'party', 2))$$, '42501', 'another business cannot add');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.waitlist_set((select v::uuid from t_out where k='w1'), 'called')$$, 1, 'Anna is called');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.waitlist_set((select v::uuid from t_out where k='w1'), 'waiting')$$, '55000', 'a called party cannot go back to waiting');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.waitlist_set((select v::uuid from t_out where k='w1'), 'seated', (select v::uuid from t_out where k='t1'))$$, 1, 'Anna is seated at T1');
select t_rows(null, 'service_role', $$select 1 from public.waitlist_entries where name = 'Anna' and status = 'seated' and seated_at is not null and called_at is not null and table_id = (select v::uuid from t_out where k='t1')$$, 1, 'with her times and the table');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.waitlist_set((select v::uuid from t_out where k='w1'), 'left')$$, '55000', 'a seated party is final');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.waitlist_set((select v::uuid from t_out where k='w2'), 'seated', gen_random_uuid())$$, '22023', 'an unknown table is refused');
update public.stores set module_overrides = module_overrides || '{"waitlist": false}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.waitlist_add(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Cy', 'party', 2))$$, '0A000', 'switched off: no new entries');
update public.stores set module_overrides = module_overrides - 'waitlist' where id = (select v::uuid from t_out where k='store');
select t_rows(null, 'service_role', $$select public.t_order('1', 'store', 't1', 40, true)$$, 1, 'a paid dine-in bill on T1 that stayed open 40 minutes');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.table_turnover(jsonb_build_object('store_id', (select v from t_out where k='store'), 'from', t_ds(-1), 'to', t_ds(0)))$$, '42501', 'a cashier cannot read the table report');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'tt', $$select public.table_turnover(jsonb_build_object('store_id', (select v from t_out where k='store'), 'from', t_ds(-1), 'to', t_ds(0)))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb) e where o.k='tt' and (e ->> 'name') = 'T1' and (e ->> 'bills') = '1' and (e ->> 'avg_min') = '40' and (e ->> 'revenue') = '10000' and (e ->> 'per_hour') = '15000'$$, 1, 'T1: 1 bill, 40 minutes, 100.00, 150.00 per hour of use');

-- 2 time clock
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.clock_toggle(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', (select v from t_out where k='cashier_id')))$$, '0A000', 'the time clock is off until the owner switches it on');
update public.stores set module_overrides = module_overrides || '{"timeclock": true}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.clock_toggle(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', gen_random_uuid()))$$, '22023', 'an unknown person cannot clock in');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (public.clock_toggle(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', (select v from t_out where k='cashier_id'))) ->> 'state') = 'in'$$, 1, 'the cashier clocks in');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ts', $$select public.time_status((select v::uuid from t_out where k='store'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='ts' and jsonb_array_length(v::jsonb) = 1 and (v::jsonb -> 0 ->> 'name') = 'Cashier'$$, 1, 'she shows as in');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (public.clock_toggle(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', (select v from t_out where k='cashier_id'))) ->> 'state') = 'out'$$, 1, 'the next press clocks her out');
select t_rows(null, 'service_role', $$select 1 from public.time_entries where clock_out is not null and clock_out >= clock_in$$, 1, 'one closed entry');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_time_entry(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', (select v from t_out where k='cashier_id'), 'clock_in', t_ts(-1,'09:00'), 'clock_out', t_ts(-1,'17:00')))$$, '42501', 'a cashier cannot correct hours');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_time_entry(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', (select v from t_out where k='cashier_id'), 'clock_in', t_ts(-1,'09:00'), 'clock_out', t_ts(-1,'17:00'), 'note', 'forgot'))$$, 1, 'the manager adds yesterday''s 8 hours');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_time_entry(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', (select v from t_out where k='cashier_id'), 'clock_in', t_ts(-1,'17:00'), 'clock_out', t_ts(-1,'09:00')))$$, '23514', 'an entry cannot end before it starts');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_planned_shift(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', (select v from t_out where k='cashier_id'), 'starts_at', t_ts(-1,'09:00'), 'ends_at', t_ts(-1,'18:00')))$$, 1, 'a planned shift of 9 hours');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_planned_shift(jsonb_build_object('store_id', (select v from t_out where k='store'), 'staff_id', (select v from t_out where k='cashier_id'), 'starts_at', t_ts(-1,'01:00'), 'ends_at', t_ts(-1,'23:00')))$$, '23514', 'a shift cannot be longer than 16 hours');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'sheet', $$select public.timesheet(jsonb_build_object('store_id', (select v from t_out where k='store'), 'from', t_ds(-1), 'to', t_ds(0)))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb) e where o.k='sheet' and (e ->> 'name') = 'Cashier' and (e ->> 'worked_min')::int between 480 and 482 and (e ->> 'planned_min') = '540' and (e ->> 'days') = '2'$$, 1, 'the timesheet: about 480 minutes worked on 2 days, 540 planned');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.timesheet(jsonb_build_object('store_id', (select v from t_out where k='store'), 'from', t_ds(-1), 'to', t_ds(0)))$$, '42501', 'a cashier cannot read the timesheet');
select t_rows(null, 'service_role', $$insert into public.time_entries (org_id, store_id, staff_id, clock_in) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='mgr_id'), now() - interval '20 hours')$$, 1, 'the manager forgot to clock out 20 hours ago');
select t_rows(null, 'service_role', $$select 1 where public.timeclock_autoclose() = 1$$, 1, 'the tick closes it');
select t_rows(null, 'service_role', $$select 1 from public.time_entries where source = 'auto' and clock_out = clock_in + interval '16 hours'$$, 1, 'at 16 hours, marked automatic');

-- 3 discount with a manager's PIN
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.set_staff_pin((select v::uuid from t_out where k='mgr_id'), '4321')$$, 1, 'the manager has a PIN');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.set_staff_pin((select v::uuid from t_out where k='cashier_id'), '1111')$$, 1, 'the cashier has one too');
select t_val(null, 'service_role', 'ob', $$select public.t_order('2', 'store', null, 0, false)::text$$);
create or replace function t_disc(kind text, val bigint, reason text, who text, pin text) returns jsonb language sql as $$
  select jsonb_build_object('order_id', (select v from t_out where k='ob'), 'kind', kind, 'value', val, 'reason', reason, 'manager_id', (select v from t_out where k = who), 'manager_pin', pin)
$$;
grant execute on function t_disc(text, bigint, text, text, text) to authenticated;
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'approvers', $$select public.discount_approvers((select v::uuid from t_out where k='store'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='approvers' and v::jsonb @> '[{"name":"Manager"}]'::jsonb and not v::jsonb @> '[{"name":"Cashier"}]'::jsonb$$, 1, 'the cashier''s list has the manager and not herself');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.discount_with_manager(t_disc('percent', 1000, '', 'mgr_id', '4321'))$$, '22023', 'a reason is needed');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.discount_with_manager(t_disc('percent', 10001, 'x', 'mgr_id', '4321'))$$, '22023', 'more than 100% is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.discount_with_manager(t_disc('percent', 1000, 'regular', 'cashier_id', '1111'))$$, '28000', 'a cashier cannot approve');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (public.discount_with_manager(t_disc('percent', 1000, 'regular guest', 'mgr_id', '9999')) ->> 'ok') = 'false'$$, 1, 'a wrong PIN is an answer, not an error');
select t_rows(null, 'service_role', $$select 1 where (select sum(unit_price * quantity) from public.order_lines where order_id = (select v::uuid from t_out where k='ob')) = 10000$$, 1, 'nothing changed');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (public.discount_with_manager(t_disc('percent', 1000, 'regular guest', 'mgr_id', '4321')) ->> 'applied') = '1000'$$, 1, 'with the right PIN: 10% = 10.00 off');
select t_rows(null, 'service_role', $$select 1 where (select sum(unit_price * quantity) from public.order_lines where order_id = (select v::uuid from t_out where k='ob')) = 9000 and (select min(list_price) from public.order_lines where order_id = (select v::uuid from t_out where k='ob')) = 5000$$, 1, 'the sent lines now total 90.00 and remember their list price');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'order.discount' and detail ->> 'approved_by' = (select v from t_out where k='mgr_id') and (detail ->> 'applied') = '1000'$$, 1, 'audited with the approver');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (public.discount_with_manager(t_disc('amount', 500, 'sorry', 'mgr_id', '4321')) ->> 'applied')::int between 498 and 500$$, 1, 'a further 5.00 off (rounded down per unit)');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.discount_with_manager(t_disc('percent', 1000, 'x', 'mgr_id', '4321'))$$, '42501', 'another business cannot touch the bill');
select t_val(null, 'service_role', 'pb', $$select public.t_order('3', 'store', null, 0, true)::text$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.discount_with_manager(jsonb_build_object('order_id', (select v from t_out where k='pb'), 'kind', 'percent', 'value', 1000, 'reason', 'x', 'manager_id', (select v from t_out where k='mgr_id'), 'manager_pin', '4321'))$$, '23514', 'a paid bill is closed');

-- 4 e-receipt
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'rs', $$select public.receipt_send_data((select v::uuid from t_out where k='pb'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='rs' and (v::jsonb -> 'receipt' ->> 'number') = 'Z-000003' and (v::jsonb -> 'receipt' ->> 'payable') = '10000' and jsonb_array_length(v::jsonb -> 'lines') = 1 and (v::jsonb -> 'payments' -> 0 ->> 'tender') = 'cash' and (v::jsonb ->> 'member_line') = 'false'$$, 1, 'the receipt data: number, total, line, payment, no LINE');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.receipt_send_data((select v::uuid from t_out where k='pb'))$$, '42501', 'another business cannot read it');
select t_rows(null, 'service_role', $$select 1 where public.receipt_line_target((select v::uuid from t_out where k='pb')) is null$$, 1, 'no member, no LINE address');
select t_rows(null, 'service_role', $$update public.orders set customer_id = (select v::uuid from t_out where k='cust') where id = (select v::uuid from t_out where k='pb')$$, 1, 'the bill has a member');
select t_rows(null, 'service_role', $$insert into public.customer_contacts (customer_id, org_id, line_user_id) values ((select v::uuid from t_out where k='cust'), (select v::uuid from t_out where k='org'), 'Unoi00000001')$$, 1, 'the member linked her LINE');
select t_rows(null, 'service_role', $$select 1 where public.receipt_line_target((select v::uuid from t_out where k='pb')) = 'Unoi00000001'$$, 1, 'the server finds her address');
select t_rows(null, 'service_role', $$update public.customer_contacts set line_stopped_at = now()$$, 1, 'she typed STOP');
select t_rows(null, 'service_role', $$select 1 where public.receipt_line_target((select v::uuid from t_out where k='pb')) is null$$, 1, 'no receipt by LINE any more');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.receipt_line_target((select v::uuid from t_out where k='pb'))$$, '42501', 'the browser cannot ask for a LINE address');

-- 5 data export
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.export_data(jsonb_build_object('org_id', (select v from t_out where k='org'), 'dataset', 'customers'))$$, '42501', 'a manager cannot export');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.export_data(jsonb_build_object('org_id', (select v from t_out where k='org'), 'dataset', 'secrets'))$$, '22023', 'an unknown dataset');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'ex1', $$select public.export_data(jsonb_build_object('org_id', (select v from t_out where k='org'), 'dataset', 'customers'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='ex1' and (v::jsonb -> 0 ->> 'name') = 'Noi' and (v::jsonb -> 0 ->> 'phone') = '0822222222'$$, 1, 'the owner gets the members');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'ex2', $$select public.export_data(jsonb_build_object('org_id', (select v from t_out where k='org'), 'dataset', 'staff'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='ex2' and v not ilike '%pin%' and v not ilike '%hash%' and jsonb_array_length(v::jsonb) >= 3$$, 1, 'the staff list carries no PIN');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'ex3', $$select public.export_data(jsonb_build_object('org_id', (select v from t_out where k='org'), 'dataset', 'orders'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb) e where o.k='ex3' and (e ->> 'receipt') = 'Z-000003'$$, 1, 'orders with their receipt numbers');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'ex4', $$select public.export_data(jsonb_build_object('org_id', (select v from t_out where k='org'), 'dataset', 'points'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='ex4' and (v::jsonb -> 0 ->> 'points') = '250'$$, 1, 'points balances');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.export_data(jsonb_build_object('org_id', (select v from t_out where k='orgB'), 'dataset', 'customers'))$$, '42501', 'not another business''s data');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'export.report' and entity = 'export_data' limit 1$$, 1, 'exports are audited');

-- 6 AI budget
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.set_ai_budget((select v::uuid from t_out where k='org'), 5000)$$, '42501', 'a manager cannot set the AI budget');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.set_ai_budget((select v::uuid from t_out where k='org'), 5000)$$, 1, 'the owner sets 50.00 a month');
select t_rows(null, 'service_role', $$insert into public.ai_usage_log (org_id, store_id, task, provider, model, input_tokens, output_tokens, source) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'summary', 'anthropic', 'claude-haiku-5-5', 1000, 200, 'staff')$$, 1, 'one AI call this month');
select t_val(null, 'service_role', 'bs', $$select public.ai_budget_state((select v::uuid from t_out where k='store'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='bs' and (v::jsonb ->> 'cap') = '5000' and (v::jsonb -> 'usage' -> 0 ->> 'model') = 'claude-haiku-5-5' and (v::jsonb -> 'usage' -> 0 ->> 'input') = '1000'$$, 1, 'the server sees the cap and the tokens used');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.ai_budget_state((select v::uuid from t_out where k='store'))$$, '42501', 'the browser cannot ask for it');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.set_ai_budget((select v::uuid from t_out where k='org'), null)$$, 1, 'the owner removes the cap');
select t_rows(null, 'service_role', $$select 1 where public.ai_budget_state((select v::uuid from t_out where k='store')) ->> 'cap' is null$$, 1, 'no cap');

\echo ALL OPS TOOLS TESTS PASSED
