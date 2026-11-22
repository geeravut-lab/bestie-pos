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

-- ═══ fixtures: a second business, a network, a platform admin ═══
select t_val(null, 'service_role', 'orgB', $$select id::text from public.orgs where name = 'Other'$$);
select t_val(null, 'service_role', 'stB', $$select id::text from public.stores where name = 'Other'$$);
insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-0000000000a1');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.create_network('{"slug":"island","name":{"th":"เกาะ","en":"Island"}}'::jsonb)$$, 1, 'a network exists');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.join_network((select v::uuid from t_out where k='org'), 'island')$$, 1, 'A joins');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.join_network((select v::uuid from t_out where k='orgB'), 'island')$$, 1, 'B joins');

-- ═══ 1 · NETWORK CONSENTS ═══
select t_val(null, 'service_role', 'pass', $$select public.guest_pass_register('island', '{"name":"Liu Wei","phone":"081-111-1111","consent":true}'::jsonb)::text$$);
select t_val(null, 'service_role', 'token', $$select (v::jsonb ->> 'token') from t_out where k='pass'$$);
select t_val(null, 'service_role', 'code', $$select (v::jsonb ->> 'code') from t_out where k='pass'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'lnkA', $$select public.link_pass((select v::uuid from t_out where k='store'), (select v from t_out where k='code'))::text$$);
select t_val('00000000-0000-0000-0000-0000000000e5', 'authenticated', 'lnkB', $$select public.link_pass((select v::uuid from t_out where k='stB'), (select v from t_out where k='code'))::text$$);
select t_val(null, 'service_role', 'cA', $$select (v::jsonb ->> 'customer_id') from t_out where k='lnkA'$$);
select t_val(null, 'service_role', 'cB', $$select (v::jsonb ->> 'customer_id') from t_out where k='lnkB'$$);
select t_rows(null, 'service_role', $$insert into public.points_ledger (org_id, customer_id, store_id, kind, points, reason) values
  ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='cA'), (select v::uuid from t_out where k='store'), 'adjust', 100, 'test'),
  ((select v::uuid from t_out where k='orgB'), (select v::uuid from t_out where k='cB'), (select v::uuid from t_out where k='stB'), 'adjust', 50, 'test')$$, 2, 'points earned at A and B');
select t_rows(null, 'service_role', $$select 1 where public.points_available((select v::uuid from t_out where k='cA')) = 150 and public.points_available((select v::uuid from t_out where k='cB')) = 150$$, 1, 'shared: 150 at either shop');
select t_rows(null, 'service_role', $$select 1 where jsonb_array_length(public.guest_pass_partners((select v from t_out where k='token'))) = 2$$, 1, 'the guest sees both businesses');
select t_rows(null, 'service_role', $$select 1 where public.guest_pass_partners('nope') is null$$, 1, 'a wrong token shows nothing');
select t_rows(null, 'service_role', $$select 1 where (public.guest_pass_set_block((select v from t_out where k='token'), (select v::uuid from t_out where k='orgB'), true) ->> 'ok') = 'true'$$, 1, 'the guest stops sharing with B');
select t_rows(null, 'service_role', $$select 1 where public.points_available((select v::uuid from t_out where k='cB')) = 50$$, 1, 'B sees only its own 50');
select t_rows(null, 'service_role', $$select 1 where public.points_available((select v::uuid from t_out where k='cA')) = 100$$, 1, 'A no longer pools B''s points: 100');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 where (public.link_pass((select v::uuid from t_out where k='stB'), (select v from t_out where k='code')) ->> 'error') = 'pass_blocked'$$, 1, 'B cannot attach the pass any more');
select t_rows(null, 'service_role', $$select 1 where (public.guest_pass_set_block((select v from t_out where k='token'), gen_random_uuid(), true) ->> 'ok') = 'false'$$, 1, 'a business outside the network cannot be blocked');
select t_rows(null, 'service_role', $$select 1 where (public.guest_pass_set_block((select v from t_out where k='token'), (select v::uuid from t_out where k='orgB'), false) ->> 'ok') = 'true'$$, 1, 'sharing back on');
select t_rows(null, 'service_role', $$select 1 where public.points_available((select v::uuid from t_out where k='cA')) = 150$$, 1, '150 again');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select * from public.network_pass_blocks$$, '42501', 'the browser cannot read the block table');

-- ═══ 2 · STAMP CARDS AND DAY PASSES (store2 = Beach Cafe, a cafe: on by default) ═══
select t_val(null, 'service_role', 'cat', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), '{"th":"กาแฟ","en":"Coffee"}') returning id::text$$);
select t_val(null, 'service_role', 'latte', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), (select v::uuid from t_out where k='cat')::uuid, '{"th":"ลาเต้","en":"Latte"}', '{"base":6000}') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'cust', $$select (public.create_customer(jsonb_build_object('org_id', (select v from t_out where k='org'), 'name', 'Noi', 'phone', '0822222222')) ->> 'id')$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_stamp_program(jsonb_build_object('store_id', (select v from t_out where k='store2'), 'kind', 'stamps', 'name', '{"th":"บัตรสะสม"}'::jsonb, 'reward_item_id', (select v from t_out where k='latte'), 'stamps_needed', 3))$$, '42501', 'a cashier cannot make a program');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'prog', $$select public.save_stamp_program(jsonb_build_object('store_id', (select v from t_out where k='store2'), 'kind', 'stamps', 'name', '{"th":"บัตรสะสม","en":"Stamp card"}'::jsonb, 'reward_item_id', (select v from t_out where k='latte'), 'stamps_needed', 3, 'min_spend', 5000))::text$$);
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_stamp_program(jsonb_build_object('store_id', (select v from t_out where k='store2'), 'kind', 'stamps', 'name', '{"th":"x"}'::jsonb, 'reward_item_id', gen_random_uuid(), 'stamps_needed', 3))$$, '22023', 'the reward must be a dish of this shop');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_stamp_program(jsonb_build_object('store_id', (select v from t_out where k='store2'), 'kind', 'stamps', 'name', '{"th":"x"}'::jsonb, 'reward_item_id', (select v from t_out where k='latte'), 'stamps_needed', 1))$$, '23514', 'a card needs at least 2 stamps');

-- three paid bills of 60.00 with the member: three stamps → one reward ready.  A bill under the minimum spend gives none.
create or replace function t_paid(num text, price int, cust text) returns uuid language plpgsql as $$
declare v_o uuid := gen_random_uuid();
begin
  insert into public.orders (id, org_id, store_id, number, business_date, channel, status, customer_id)
  values (v_o, (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), num, (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'open', (select v::uuid from t_out where k = cust));
  insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, status, sent_at)
  values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), v_o, (select v::uuid from t_out where k='latte'), '{"th":"ลาเต้"}', price, 1, 'sent', now());
  update public.orders set status = 'paid' where id = v_o;
  return v_o;
end $$;
select t_rows(null, 'service_role', $$select public.t_paid('Z001', 6000, 'cust')$$, 1, 'paid bill 1');
select t_rows(null, 'service_role', $$select public.t_paid('Z002', 6000, 'cust')$$, 1, 'paid bill 2');
select t_rows(null, 'service_role', $$select public.t_paid('Z003', 3000, 'cust')$$, 1, 'a 30.00 bill is under the minimum spend');
select t_rows(null, 'service_role', $$select 1 from public.stamp_cards where stamps = 2$$, 1, 'two stamps so far');
select t_rows(null, 'service_role', $$select public.t_paid('Z004', 6000, 'cust')$$, 1, 'paid bill 4');
select t_rows(null, 'service_role', $$select 1 from public.stamp_cards where stamps = 3$$, 1, 'three stamps');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'st', $$select public.stamp_status(jsonb_build_object('store_id', (select v from t_out where k='store2'), 'customer_id', (select v from t_out where k='cust')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb) e where o.k='st' and (e ->> 'stamps') = '3' and (e ->> 'rewards_ready') = '1'$$, 1, 'the cashier sees one reward ready');

-- an open bill with the member and a 60.00 latte: the reward makes it free
select t_val(null, 'service_role', 'ob', $$insert into public.orders (org_id, store_id, number, business_date, channel, status, customer_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), 'Z010', (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'open', (select v::uuid from t_out where k='cust')) returning id::text$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.redeem_stamp_reward(jsonb_build_object('order_id', (select v from t_out where k='ob'), 'program_id', (select v from t_out where k='prog')))$$, '55000', 'the reward dish must be on the bill first');
select t_rows(null, 'service_role', $$insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, status) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), (select v::uuid from t_out where k='ob')::uuid, (select v::uuid from t_out where k='latte'), '{"th":"ลาเต้"}', 6000, 2, 'new')$$, 1, 'two lattes on the bill');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.redeem_stamp_reward(jsonb_build_object('order_id', (select v from t_out where k='ob'), 'program_id', (select v from t_out where k='prog')))$$, 1, 'the cashier uses the reward');
select t_rows(null, 'service_role', $$select 1 where (select sum(unit_price::bigint * quantity) from public.order_lines where order_id = (select v::uuid from t_out where k='ob')) = 6000 and (select count(*) from public.order_lines where order_id = (select v::uuid from t_out where k='ob')) = 2$$, 1, 'only ONE of the two lattes is free (the line was split)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.redeem_stamp_reward(jsonb_build_object('order_id', (select v from t_out where k='ob'), 'program_id', (select v from t_out where k='prog')))$$, '55000', 'no second reward: the card is used up');
-- the bill is voided: the reward comes back
select t_rows(null, 'service_role', $$update public.orders set status = 'void' where id = (select v::uuid from t_out where k='ob')$$, 1, 'the bill is voided');
select t_rows(null, 'service_role', $$select 1 from public.stamp_cards where rewards_used = 0$$, 1, 'the reward is back on the card');

-- a day pass: 300.00 for 30 days, one free latte a day
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'pp', $$select public.save_stamp_program(jsonb_build_object('store_id', (select v from t_out where k='store2'), 'kind', 'pass', 'name', '{"th":"พาสรายเดือน","en":"Monthly pass"}'::jsonb, 'reward_item_id', (select v from t_out where k='latte'), 'pass_price', 30000, 'pass_days', 30))::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'pbill', $$select public.sell_stamp_pass(jsonb_build_object('store_id', (select v from t_out where k='store2'), 'program_id', (select v from t_out where k='pp'), 'customer_id', (select v from t_out where k='cust')))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.customer_passes where status = 'pending'$$, 1, 'the pass is pending until the bill is paid');
select t_rows(null, 'service_role', $$update public.orders set status = 'paid' where id = (select v::uuid from t_out where k='pbill')$$, 1, 'the pass bill is paid');
select t_rows(null, 'service_role', $$select 1 from public.customer_passes where status = 'active' and valid_until = valid_from + 29$$, 1, 'the pass is active for 30 days');
select t_rows(null, 'service_role', $$select 1 from public.stamp_cards where stamps = 3$$, 1, 'buying a pass gives no stamp');
select t_val(null, 'service_role', 'ob2', $$insert into public.orders (org_id, store_id, number, business_date, channel, status, customer_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), 'Z011', (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'open', (select v::uuid from t_out where k='cust')) returning id::text$$);
select t_rows(null, 'service_role', $$insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, status) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store2'), (select v::uuid from t_out where k='ob2')::uuid, (select v::uuid from t_out where k='latte'), '{"th":"ลาเต้"}', 6000, 2, 'new')$$, 1, 'two lattes');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.redeem_stamp_reward(jsonb_build_object('order_id', (select v from t_out where k='ob2'), 'program_id', (select v from t_out where k='pp')))$$, 1, 'the pass gives today''s free latte');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.redeem_stamp_reward(jsonb_build_object('order_id', (select v from t_out where k='ob2'), 'program_id', (select v from t_out where k='pp')))$$, '55000', 'but only one a day');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'sr', $$select public.stamps_report(jsonb_build_object('store_id', (select v from t_out where k='store2'), 'from', t_ds(-1), 'to', t_ds(0)))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='sr' and (v::jsonb ->> 'rewards_used') = '1' and (v::jsonb ->> 'passes_active') = '1' and (v::jsonb ->> 'stamps_given') = '3'$$, 1, 'the report counts the stamps, the used reward and the pass');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.stamps_report(jsonb_build_object('store_id', (select v from t_out where k='store2'), 'from', t_ds(-1), 'to', t_ds(0)))$$, '42501', 'a cashier cannot read the report');

-- ═══ 3 · TOURS (store 1 gets the tours module) ═══
update public.stores set plan = 'pro', module_overrides = module_overrides || '{"slots.booking": true}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_tour_slot(jsonb_build_object('store_id', (select v from t_out where k='store'), 'title', '{"th":"ดำน้ำ"}'::jsonb, 'starts_at', t_ts(2,'09:00'), 'duration_min', 240, 'capacity', 6, 'price', 150000))$$, '42501', 'a cashier cannot make a slot');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'slot', $$select public.save_tour_slot(jsonb_build_object('store_id', (select v from t_out where k='store'), 'title', '{"th":"ดำน้ำ","en":"Snorkel"}'::jsonb, 'starts_at', t_ts(2,'09:00'), 'duration_min', 240, 'capacity', 6, 'price', 150000, 'guide_staff_id', (select v from t_out where k='mgr_staff')))::text$$);
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_tour_slot(jsonb_build_object('store_id', (select v from t_out where k='store'), 'title', '{"th":"x"}'::jsonb, 'starts_at', t_ts(2,'09:00'), 'duration_min', 60, 'capacity', 6, 'price', 1000, 'guide_staff_id', gen_random_uuid()))$$, '22023', 'the guide must be a staff member');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_tour(jsonb_build_object('slot_id', (select v from t_out where k='slot'), 'guest_name', 'Anna', 'phone', '0833333333', 'seats', 4, 'client_id', '20000000-0000-4000-8000-000000000001'))$$, 1, 'Anna books 4 seats');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (public.book_tour(jsonb_build_object('slot_id', (select v from t_out where k='slot'), 'guest_name', 'Anna', 'seats', 4, 'client_id', '20000000-0000-4000-8000-000000000001')) ->> 'replay') = 'true'$$, 1, 'the same request again books nothing twice');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_tour(jsonb_build_object('slot_id', (select v from t_out where k='slot'), 'guest_name', 'Ben', 'seats', 3, 'client_id', '20000000-0000-4000-8000-000000000002'))$$, '55000', 'only 2 seats left: 3 are refused');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'bk', $$select (public.book_tour(jsonb_build_object('slot_id', (select v from t_out where k='slot'), 'guest_name', 'Ben', 'seats', 2, 'client_id', '20000000-0000-4000-8000-000000000003')) ->> 'id')$$);
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_tour_slot(jsonb_build_object('id', (select v from t_out where k='slot'), 'store_id', (select v from t_out where k='store'), 'title', '{"th":"x"}'::jsonb, 'starts_at', t_ts(2,'09:00'), 'duration_min', 60, 'capacity', 5, 'price', 1000))$$, '55000', 'the capacity cannot go below the seats booked');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.tour_to_order(jsonb_build_object('booking_id', (select v from t_out where k='bk')))$$, '55000', 'a booking is billed only after check-in');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_tour_booking_status((select v::uuid from t_out where k='bk'), 'cancelled')$$, 1, 'Ben cancels');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.tour_seats_taken((select v::uuid from t_out where k='slot')) = 4$$, 1, 'the 2 seats are free again');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_tour_booking_status((select v::uuid from t_out where k='bk'), 'checked_in')$$, '55000', 'a cancelled booking cannot check in');
select t_val(null, 'service_role', 'ab', $$select id::text from public.tour_bookings where guest_name = 'Anna'$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.take_tour_deposit(jsonb_build_object('booking_id', (select v from t_out where k='ab'), 'amount', 700000, 'method', 'promptpay'))$$, '22023', 'a deposit above the price is refused (4 × 1,500.00 = 6,000.00)');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.take_tour_deposit(jsonb_build_object('booking_id', (select v from t_out where k='ab'), 'amount', 200000, 'method', 'promptpay'))$$, 1, '2,000.00 deposit by PromptPay');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.take_tour_deposit(jsonb_build_object('booking_id', (select v from t_out where k='ab'), 'amount', 1000, 'method', 'cash'))$$, '22023', 'a cash deposit must name a till');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.set_tour_booking_status((select v::uuid from t_out where k='ab'), 'checked_in')$$, 1, 'Anna checks in');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'tb', $$select public.tour_to_order(jsonb_build_object('booking_id', (select v from t_out where k='ab')))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.order_lines where order_id = (select v::uuid from t_out where k='tb') and quantity = 4 and unit_price = 150000$$, 1, 'the bill: 4 seats at 1,500.00');
select t_rows(null, 'service_role', $$select 1 from public.order_partial_payments where order_id = (select v::uuid from t_out where k='tb') and amount = 200000 and kind = 'deposit'$$, 1, 'the deposit is already paid on the bill');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.tour_to_order(jsonb_build_object('booking_id', (select v from t_out where k='ab'))) = (select v::uuid from t_out where k='tb')$$, 1, 'asking again returns the same bill');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'mf', $$select public.tour_manifest((select v::uuid from t_out where k='slot'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='mf' and (v::jsonb ->> 'guide') = 'Manager' and (v::jsonb ->> 'seats_taken') = '4' and jsonb_array_length(v::jsonb -> 'bookings') = 1$$, 1, 'the manifest: the guide, 4 seats, one booking (the cancelled one is left out)');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.cancel_tour_slot((select v::uuid from t_out where k='slot'))$$, 1, 'the owner cancels the slot (nothing booked is left: Anna is checked in)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.book_tour(jsonb_build_object('slot_id', (select v from t_out where k='slot'), 'guest_name', 'Cy', 'seats', 1, 'client_id', '20000000-0000-4000-8000-000000000004'))$$, '55000', 'a cancelled slot takes no booking');

-- ═══ 4 · MARKETING (store 1: Pro + module on) ═══
update public.stores set module_overrides = module_overrides || '{"marketing": true}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'mc', $$select (public.create_customer(jsonb_build_object('org_id', (select v from t_out where k='org'), 'name', 'Mali', 'phone', '0844444444')) ->> 'id')$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.marketing_line_code(jsonb_build_object('store_id', (select v from t_out where k='store2'), 'customer_id', (select v from t_out where k='mc')))$$, '0A000', 'the module is off in the café');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'lc', $$select public.marketing_line_code(jsonb_build_object('store_id', (select v from t_out where k='store'), 'customer_id', (select v from t_out where k='mc')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='lc' and (v::jsonb ->> 'code') ~ '^[0-9A-F]{8}$'$$, 1, 'the front desk gets an 8-character code');
select t_val(null, 'service_role', 'lcode', $$select (v::jsonb ->> 'code') from t_out where k='lc'$$);
select t_rows(null, 'service_role', $$select 1 where (public.guest_bind_line('FFFFFFFF', 'Umali0000001') ->> 'ok') = 'false'$$, 1, 'a wrong code binds nothing');
select t_rows(null, 'service_role', $$select 1 where (public.guest_bind_line((select v from t_out where k='lcode'), 'Umali0000001') ->> 'kind') = 'marketing'$$, 1, 'the member sends the code to the LINE account: bound');
select t_rows(null, 'service_role', $$select 1 where (public.guest_bind_line((select v from t_out where k='lcode'), 'Umali0000002') ->> 'ok') = 'false'$$, 1, 'the code works once');
select t_rows(null, 'service_role', $$select 1 from public.customers where id = (select v::uuid from t_out where k='mc') and consent$$, 1, 'sending the code recorded her consent');
-- a campaign: win back members idle for 30 days
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_marketing_campaign(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Come back', 'kind', 'winback', 'idle_days', 30, 'message', '{"th":"คิดถึงนะ","en":"We miss you"}'::jsonb, 'active', true))$$, '42501', 'a cashier cannot make a campaign');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_marketing_campaign(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Empty', 'kind', 'winback', 'idle_days', 30, 'message', '{"th":""}'::jsonb))$$, '22023', 'an empty message is refused');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'camp', $$select public.save_marketing_campaign(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Come back', 'kind', 'winback', 'idle_days', 30, 'message', '{"th":"คิดถึงนะ","en":"We miss you"}'::jsonb, 'active', true))::text$$);
-- Mali's last paid bill was 45 days ago → eligible; Noi (café customer) has no LINE → not
alter table public.orders disable trigger user;
insert into public.orders (org_id, store_id, number, business_date, channel, status, customer_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'M001', t_d(-45), 'takeaway', 'paid', (select v::uuid from t_out where k='mc'));
alter table public.orders enable trigger user;
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'pv', $$select public.marketing_preview((select v::uuid from t_out where k='camp'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='pv' and (v::jsonb ->> 'eligible') = '1' and (v::jsonb ->> 'linked') = '1'$$, 1, 'the preview: 1 person would receive it');
select t_rows(null, 'service_role', $$select 1 where public.marketing_run_all() = 1$$, 1, 'the daily run queues 1 message');
select t_rows(null, 'service_role', $$select 1 where public.marketing_run_all() = 0$$, 1, 'a second run the same day queues nothing');
select t_val(null, 'service_role', 'cl', $$select public.marketing_claim(10)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb) e where o.k='cl' and (e ->> 'line_user_id') = 'Umali0000001' and (e ->> 'th') = 'คิดถึงนะ'$$, 1, 'the tick receives the message and the LINE address');
select t_rows(null, 'service_role', $$select 1 where jsonb_array_length(public.marketing_claim(10)) = 0$$, 1, 'a message in flight is not handed out twice');
select t_rows(null, 'service_role', $$select public.marketing_report((select (e ->> 'id')::uuid from t_out o, jsonb_array_elements(o.v::jsonb) e where o.k='cl'), 'sent')$$, 1, 'reported as sent');
select t_rows(null, 'service_role', $$select 1 from public.marketing_sends where status = 'sent'$$, 1, 'logged');
-- the 14-day cap and STOP
select t_rows(null, 'service_role', $$update public.marketing_campaigns set last_run_at = now() - interval '2 days'$$, 1, 'a day later');
select t_rows(null, 'service_role', $$select 1 where public.marketing_run_all() = 0$$, 1, 'no second message within 14 days');
select t_rows(null, 'service_role', $$select 1 where public.marketing_stop('Umali0000001') = 1$$, 1, 'STOP in the chat');
select t_rows(null, 'service_role', $$select 1 from public.customers where id = (select v::uuid from t_out where k='mc') and not consent$$, 1, 'the consent is withdrawn');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'pv2', $$select public.marketing_preview((select v::uuid from t_out where k='camp'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='pv2' and (v::jsonb ->> 'linked') = '0'$$, 1, 'nobody is linked any more');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select * from public.customer_contacts$$, '42501', 'the browser cannot read the LINE addresses');

-- ═══ 5 · INTEGRATION HUB ═══
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.create_api_key(jsonb_build_object('org_id', (select v from t_out where k='org'), 'name', 'Books'))$$, '0A000', 'the hub is off until the owner switches it on');
update public.stores set module_overrides = module_overrides || '{"integration.hub": true}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.create_api_key(jsonb_build_object('org_id', (select v from t_out where k='org'), 'name', 'Books'))$$, '42501', 'a manager cannot make an API key');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'key', $$select (public.create_api_key(jsonb_build_object('org_id', (select v from t_out where k='org'), 'name', 'Books')) ->> 'key')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='key' and v ~ '^bk_[0-9a-f]{48}$'$$, 1, 'the key is shown once');
select t_rows(null, 'service_role', $$select 1 from public.api_keys where key_hash = encode(sha256(convert_to((select v from t_out where k='key'), 'utf8')), 'hex') and prefix = left((select v from t_out where k='key'), 7)$$, 1, 'only its hash is stored');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select key_hash from public.api_keys$$, '42501', 'the hash cannot be read by the browser');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select id, name, prefix from public.api_keys$$, 1, 'the owner lists the key without the hash');
select t_val(null, 'service_role', 'lk', $$select public.api_key_lookup(encode(sha256(convert_to((select v from t_out where k='key'), 'utf8')), 'hex'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='lk' and (v::jsonb ->> 'org_id') = (select v from t_out where k='org')$$, 1, 'a request with the key finds the business');
select t_rows(null, 'service_role', $$select 1 where public.api_key_lookup('00') is null$$, 1, 'a wrong key finds nothing');
-- webhooks
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_webhook_endpoint(jsonb_build_object('org_id', (select v from t_out where k='org'), 'url', 'http://example.test/hook', 'events', jsonb_build_array('order.paid')))$$, '23514', 'only https addresses');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_webhook_endpoint(jsonb_build_object('org_id', (select v from t_out where k='org'), 'url', 'https://example.test/hook', 'events', jsonb_build_array('nonsense')))$$, '23514', 'only known events');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'wh', $$select public.save_webhook_endpoint(jsonb_build_object('org_id', (select v from t_out where k='org'), 'url', 'https://example.test/hook', 'events', jsonb_build_array('order.paid', 'tour.booked')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='wh' and (v::jsonb ->> 'secret') ~ '^whsec_'$$, 1, 'the secret is shown once');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select secret from public.webhook_endpoints$$, '42501', 'the secret cannot be read');
-- a paid bill makes a delivery
select t_rows(null, 'service_role', $$select public.t_paid('Z020', 6000, 'cust')$$, 1, 'a paid bill in the café (same business)');
select t_rows(null, 'service_role', $$select 1 from public.webhook_deliveries where event = 'order.paid' and status = 'queued' and (payload -> 'data' ->> 'number') = 'Z020'$$, 1, 'an order.paid delivery is queued');
select t_val(null, 'service_role', 'wc', $$select public.webhook_claim(10)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb) e where o.k='wc' and (e ->> 'url') = 'https://example.test/hook' and (e ->> 'secret') = (select (v::jsonb ->> 'secret') from t_out where k='wh')$$, 1, 'the tick receives url, secret and body');
select t_rows(null, 'service_role', $$select 1 where jsonb_array_length(public.webhook_claim(10)) = 0$$, 1, 'a delivery is not handed out again before its retry time');
select t_rows(null, 'service_role', $$select public.webhook_report((select (e ->> 'id')::uuid from t_out o, jsonb_array_elements(o.v::jsonb) e where o.k='wc' limit 1), false, 500)$$, 1, 'a 500 answer');
select t_rows(null, 'service_role', $$select 1 from public.webhook_deliveries where status = 'queued' and tries = 1 and last_status = 500 and next_try_at > now()$$, 1, 'it will be retried later');
select t_rows(null, 'service_role', $$update public.webhook_deliveries set next_try_at = now() - interval '1 second' returning id$$, 1, 'time passes');
select t_val(null, 'service_role', 'wc2', $$select public.webhook_claim(10)::text$$);
select t_rows(null, 'service_role', $$select public.webhook_report((select (e ->> 'id')::uuid from t_out o, jsonb_array_elements(o.v::jsonb) e where o.k='wc2' limit 1), true, 200)$$, 1, 'a 200 answer');
select t_rows(null, 'service_role', $$select 1 from public.webhook_deliveries where status = 'sent'$$, 1, 'delivered');
select t_rows(null, 'service_role', $$select 1 from public.tour_bookings where false$$, 0, 'placeholder');
-- twenty failed deliveries in a row switch the address off
select t_rows(null, 'service_role', $$update public.webhook_endpoints set fail_count = 19$$, 1, 'nineteen failures in a row');
select t_rows(null, 'service_role', $$insert into public.webhook_deliveries (endpoint_id, org_id, event, payload, tries) select id, org_id, 'order.paid', '{}', 5 from public.webhook_endpoints returning id$$, 1, 'one more delivery that ran out of tries');
select t_rows(null, 'service_role', $$select public.webhook_report((select id from public.webhook_deliveries where tries = 5 limit 1), false, 502)$$, 1, 'its last failure');
select t_rows(null, 'service_role', $$select 1 from public.webhook_endpoints where not active$$, 1, 'the address is switched off');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.list_webhook_endpoints((select v::uuid from t_out where k='org'))$$, '42501', 'only the owner lists webhooks');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.delete_webhook_endpoint((select (public.list_webhook_endpoints((select v::uuid from t_out where k='org')) -> 0 ->> 'id')::uuid))$$, 1, 'the owner removes it');
-- API data and the accountant's export
select t_rows(null, 'service_role', $$select 1 where public.api_sales((select v::uuid from t_out where k='org'), t_d(-3), t_d(0)) is not null$$, 1, 'sales for a range');
select t_err(null, 'service_role', $$select public.api_sales((select v::uuid from t_out where k='org'), t_d(-200), t_d(0))$$, '22023', 'a range over 93 days is refused');
select t_rows(null, 'service_role', $$select 1 where jsonb_array_length(public.api_menu((select v::uuid from t_out where k='org'))) = 1$$, 1, 'the menu has the one latte');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.accounting_export(jsonb_build_object('org_id', (select v from t_out where k='org'), 'from', t_ds(-5), 'to', t_ds(0)))$$, '42501', 'a cashier cannot export');
select t_rows(null, 'service_role', $$insert into public.receipts (org_id, store_id, order_id, number, issued_at, seller_name, branch_code, vat_registered, vat_bps, service_bps, price_mode, subtotal, service_charge, vat, net_before_vat, total, rounding, payable)
  select org_id, store_id, id, 'Z-000020', now(), 'Acme', '00000', true, 700, 0, 'inclusive', 6000, 0, 393, 5607, 6000, 0, 6000 from public.orders where number = 'Z020'$$, 1, 'a receipt for the café bill');
select t_rows(null, 'service_role', $$insert into public.payments (org_id, store_id, order_id, tender, amount) select org_id, store_id, id, 'cash', 6000 from public.orders where number = 'Z020'$$, 1, 'paid in cash');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'ex', $$select public.accounting_export(jsonb_build_object('org_id', (select v from t_out where k='org'), 'from', t_ds(-5), 'to', t_ds(0)))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o, jsonb_array_elements(o.v::jsonb) e where o.k='ex' and (e ->> 'receipt') = 'Z-000020' and (e ->> 'vat') = '393' and (e ->> 'cash') = '6000' and (e ->> 'payable') = '6000'$$, 1, 'the export row: VAT 3.93, paid in cash 60.00');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'export.report'$$, 1, 'the export is audited');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.revoke_api_key((select id from public.api_keys limit 1))$$, 1, 'the owner revokes the key');
select t_rows(null, 'service_role', $$select 1 where public.api_key_lookup(encode(sha256(convert_to((select v from t_out where k='key'), 'utf8')), 'hex')) is null$$, 1, 'a revoked key finds nothing');

\echo ALL GROWTH TOOLS TESTS PASSED
