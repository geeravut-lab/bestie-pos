-- PMS link: a stay linked to a hotel reservation, the pending charges for the tick, marking posted / failed.
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
  ('00000000-0000-0000-0000-0000000000d4', 'poolbar@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Resort Co','Palm Resort','resort')$$, 1, 'the owner creates a resort');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other Co','Other','cafe')$$, 1, 'another business exists');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Resort Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'resort', $$select id::text from public.stores where name = 'Palm Resort'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'bar', $$select public.create_store((select v::uuid from t_out where k='org'), 'Pool Bar', 'cafe')::text$$);
-- the pool bar cashier works in the BAR only
insert into public.staff (org_id, store_id, user_id, display_name, role_id)
select o.id, (select v::uuid from t_out where k='bar'), '00000000-0000-0000-0000-0000000000d4', 'Bar cashier', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Resort Co';
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cashier_staff', $$select id::text from public.staff where display_name = 'Bar cashier'$$);
update public.legal_entities set tax_id = '0105560123456' where name = 'Resort Co';
update public.stores set vat_registered = true, vat_bps = 700, branch_code = '00001' where org_id = (select v::uuid from t_out where k='org');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'bar_dev', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='bar'), 'Bar till', 'cashier', 'POS-BAR') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'desk_dev', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='resort'), 'Front desk', 'cashier', 'POS-FD') returning id::text$$);

-- ── the module ──
update public.stores set plan = 'pro' where id = (select v::uuid from t_out where k='resort');  -- a resort shop on Pro (a new resort shop starts on Resort since migration 92)
select t_rows(null, 'service_role', $$select 1 where not public.folio_enabled((select v::uuid from t_out where k='resort'))$$, 1, 'a resort-profile shop on the Pro plan does not have the folio');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_folio_room(jsonb_build_object('store_id', (select v from t_out where k='resort'), 'name', '101'))$$, '0A000', 'so rooms cannot be made');
update public.stores set plan = 'resort' where id = (select v::uuid from t_out where k='resort');
select t_rows(null, 'service_role', $$select 1 where public.folio_enabled((select v::uuid from t_out where k='resort')) and not public.folio_enabled((select v::uuid from t_out where k='bar'))$$, 1, 'on the Resort plan the resort profile has it, the cafe does not');


-- ── rooms with a rate ──
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'room1', $$select public.save_folio_room(jsonb_build_object('store_id', (select v from t_out where k='resort'), 'name', '101', 'night_rate', 150000))::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'room2', $$select public.save_folio_room(jsonb_build_object('store_id', (select v from t_out where k='resort'), 'name', '102'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.folio_rooms where name = '101' and night_rate = 150000 and not exists (select 1 from public.folio_rooms where name = '102' and night_rate is not null)$$, 1, 'a room may carry a price per night');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_folio_room(jsonb_build_object('store_id', (select v from t_out where k='resort'), 'id', (select v from t_out where k='room2'), 'night_rate', -5))$$, '23514', 'a negative rate is refused');
create or replace function t_in(room text, who text, extra text default '{}') returns text language sql as $$
  select (jsonb_build_object('store_id', (select v from t_out where k='resort'), 'room_id', (select v from t_out where k=room), 'guest_name', who, 'phone', '0811111111') || extra::jsonb)::text $$;
grant execute on function t_in(text, text, text) to authenticated, service_role;
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'f1', $$select public.folio_check_in(t_in('room1', 'Anna')::jsonb)::text$$);
select t_rows(null, 'service_role', $$select 1 from public.folios where id = (select v::uuid from t_out where k='f1') and night_rate = 150000$$, 1, 'check-in copies the room rate onto the stay');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'f2', $$select public.folio_check_in(t_in('room2', 'Liu', '{"night_rate": 90000}')::jsonb)::text$$);
select t_rows(null, 'service_role', $$select 1 from public.folios where id = (select v::uuid from t_out where k='f2') and night_rate = 90000$$, 1, 'the front desk may type another rate for one guest');
update public.folio_rooms set night_rate = 999999 where name = '101';
select t_rows(null, 'service_role', $$select 1 from public.folios where id = (select v::uuid from t_out where k='f1') and night_rate = 150000$$, 1, 'a later change of the room rate does not change the stay in the house');

-- ── the nights ──
select t_rows(null, 'service_role', $$select 1 where public.folio_post_nights_all() = 0$$, 1, 'the tick posts nothing on the day of check-in (no night has passed)');
update public.folios set check_in_at = now() - interval '3 days' where id = (select v::uuid from t_out where k='f1');
update public.folios set check_in_at = now() - interval '2 days' where id = (select v::uuid from t_out where k='f2');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.folio_post_nights((select v::uuid from t_out where k='f1'))$$, '42501', 'a bar cashier cannot post the nights of the resort');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 where public.folio_post_nights((select v::uuid from t_out where k='f1')) = 3$$, 1, 'three nights have passed: the front desk posts them');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 where public.folio_post_nights((select v::uuid from t_out where k='f1')) = 0$$, 1, 'posting again adds nothing');
select t_rows(null, 'service_role', $$select 1 where public.folio_post_nights_all() = 2$$, 1, 'the tick posts the other stay (2 nights) and none twice');
select t_rows(null, 'service_role', $$select 1 from public.folio_charges where folio_id = (select v::uuid from t_out where k='f1') and kind = 'night' and amount = 150000 and receipt_number is null and order_id is null$$, 3, 'a night is a line on the stay with no receipt number');
select t_rows(null, 'service_role', $$select 1 where (select min(night_date) from public.folio_charges where folio_id = (select v::uuid from t_out where k='f1') and kind = 'night') = ((now() - interval '3 days') at time zone 'Asia/Bangkok')::date and (select max(night_date) from public.folio_charges where folio_id = (select v::uuid from t_out where k='f1') and kind = 'night') = ((now() at time zone 'Asia/Bangkok')::date - 1)$$, 1, 'the nights are the check-in date up to yesterday');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.folio_balance((select v::uuid from t_out where k='f1')) = 450000$$, 1, 'the stay owes 3 x 1,500.00');
select t_err(null, 'service_role', $$insert into public.folio_charges (org_id, store_id, folio_id, kind, night_date, amount) select org_id, store_id, id, 'night', ((now() - interval '3 days') at time zone 'Asia/Bangkok')::date, 1 from public.folios where id = (select v::uuid from t_out where k='f1')$$, '23505', 'a night can be on a stay only once');
select t_err(null, 'service_role', $$insert into public.folio_charges (org_id, store_id, folio_id, kind, amount) select org_id, store_id, id, 'night', 1 from public.folios where id = (select v::uuid from t_out where k='f1')$$, '23514', 'a night needs its date');
-- a manager takes one night off; it never comes back
select t_val(null, 'service_role', 'n1', $$select id::text from public.folio_charges where folio_id = (select v::uuid from t_out where k='f1') and kind = 'night' order by night_date limit 1$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.folio_void_charge((select v::uuid from t_out where k='n1'), 'guest was moved')$$, '42501', 'a cashier cannot take a night off');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.folio_void_charge((select v::uuid from t_out where k='n1'), 'guest was moved')$$, 1, 'a manager takes a night off');
select t_rows(null, 'service_role', $$select 1 where public.folio_post_nights_all() = 0$$, 1, 'a voided night is not posted again');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.folio_balance((select v::uuid from t_out where k='f1')) = 300000$$, 1, 'the stay owes 2 nights now');

-- ── a bill charged to the room, then returned ──
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values ('10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='bar'), 'A001', (now() at time zone 'Asia/Bangkok')::date, 'takeaway')$$, 1, 'an open bill at the pool bar');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, status, sent_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='bar'), '10000000-0000-4000-8000-000000000001', '{"th":"ค็อกเทล"}', 21000, 1, 'sent', now())$$, 1, 'one line of 210.00');
create or replace function t_charge(p_order text, p_folio text, p_pay text) returns jsonb language sql as $$
  select jsonb_build_object('order_id', p_order, 'folio_id', (select v from t_out where k=p_folio), 'payment_id', p_pay,
    'device_id', (select v from t_out where k='bar_dev'), 'staff_id', (select v from t_out where k='cashier_staff'), 'issued_at', now(), 'lang', 'en',
    'subtotal', 21000, 'service_charge', 0, 'vat', 1374, 'net_before_vat', 19626, 'total', 21000, 'rounding', 0, 'payable', 21000,
    'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive') $$;
grant execute on function t_charge(text, text, text) to authenticated, service_role;
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'rc', $$select public.charge_order_to_room(t_charge('10000000-0000-4000-8000-000000000001', 'f1', '60000000-0000-4000-8000-000000000001'))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.folio_balance((select v::uuid from t_out where k='f1')) = 321000$$, 1, 'the stay owes 2 nights and the bar bill: 3,210.00');
select t_val(null, 'service_role', 'line1', $$select id::text from public.order_lines where order_id = '10000000-0000-4000-8000-000000000001'$$);
select t_val(null, 'service_role', 'chb', $$select id::text from public.folio_charges where order_id = '10000000-0000-4000-8000-000000000001'$$);

-- ── the PMS module ──
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.folio_link_pms((select v::uuid from t_out where k='f1'), 'R-100')$$, '0A000', 'linking needs the PMS module');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.pms_context((select v::uuid from t_out where k='resort'))$$, '0A000', 'the context says the module is off');
update public.stores set module_overrides = module_overrides || '{"pms": true}'::jsonb where id = (select v::uuid from t_out where k='resort');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 where (public.pms_context((select v::uuid from t_out where k='resort')) ->> 'ok') = 'true'$$, 1, 'with the module on the front desk may use it');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.pms_context((select v::uuid from t_out where k='resort'))$$, '42501', 'another business may not');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.folio_link_pms((select v::uuid from t_out where k='f1'), 'R-100')$$, '42501', 'a bar cashier cannot link a resort stay');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.folio_link_pms((select v::uuid from t_out where k='f1'), 'R-100')$$, 1, 'the owner links a stay to a reservation');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.folio_link_pms((select v::uuid from t_out where k='f2'), 'R-100')$$, '23505', 'one reservation cannot be on two open stays');

-- ── pending charges for the tick ──
select t_rows(null, 'service_role', $$select 1 from jsonb_array_elements(public.pms_pending_charges(10)) e where (e ->> 'id') = (select v from t_out where k='chb') and (e ->> 'reservation') = 'R-100' and (e ->> 'amount')::int > 0$$, 1, 'the bill charge of the linked stay is pending (nights and unlinked stays are not)');
select t_rows(null, 'service_role', $$select 1 from jsonb_array_elements(public.pms_pending_charges(10)) e where (e ->> 'reservation') <> 'R-100'$$, 0, 'no other stay is in the list');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.pms_pending_charges(5)$$, '42501', 'only the server can read the list');
select t_rows(null, 'service_role', $$select public.pms_mark_posted((select v::uuid from t_out where k='chb'), false, null, 'Mews 401')$$, 1, 'a failure is kept');
select t_rows(null, 'service_role', $$select 1 from public.folio_charges where id = (select v::uuid from t_out where k='chb') and pms_tries = 1 and pms_error = 'Mews 401' and pms_posted_at is null$$, 1, 'with its text and a try');
select t_rows(null, 'service_role', $$select public.pms_mark_posted((select v::uuid from t_out where k='chb'), true, 'ORDER-9', null)$$, 1, 'a success is kept');
select t_rows(null, 'service_role', $$select 1 from public.folio_charges where id = (select v::uuid from t_out where k='chb') and pms_posted_at is not null and pms_ref = 'ORDER-9' and pms_error is null$$, 1, 'with the reference and no error');
select t_rows(null, 'service_role', $$select 1 from jsonb_array_elements(public.pms_pending_charges(10)) e where (e ->> 'id') = (select v from t_out where k='chb')$$, 0, 'a posted charge is not pending again');
select t_rows(null, 'service_role', $$select public.pms_mark_posted((select v::uuid from t_out where k='chb'), false, null, 'late')$$, 1, 'a late failure report does not undo a success');
select t_rows(null, 'service_role', $$select 1 from public.folio_charges where id = (select v::uuid from t_out where k='chb') and pms_posted_at is not null and pms_error is null$$, 1, 'it stays posted');
\echo ALL PMS LINK TESTS PASSED
