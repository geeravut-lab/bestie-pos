-- Phase 3 network: joining, Tourist Pass, linking, network points, clearing (FIFO), marketplace.
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
  ('00000000-0000-0000-0000-0000000000a1', 'ownerA@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'cashierA@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'ownerB@example.test'),
  ('00000000-0000-0000-0000-0000000000f6', 'cashierB@example.test'),
  ('00000000-0000-0000-0000-0000000000c7', 'ownerC@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Alpha Co','Alpha Cafe','cafe')$$, 1, 'A exists');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Beta Co','Beta Spa','spa')$$, 1, 'B exists');
select t_rows('00000000-0000-0000-0000-0000000000c7', 'authenticated', $$select * from public.create_org('Gamma Co','Gamma Shop','retail')$$, 1, 'C exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('Alpha Co', '00000000-0000-0000-0000-0000000000d4'::uuid, 'CashierA'), ('Beta Co', '00000000-0000-0000-0000-0000000000f6'::uuid, 'CashierB')) as u(org, id, n) on u.org = o.name
  join public.roles r on r.org_id = o.id and r.built_in = 'cashier';
select t_val(null, 'service_role', 'orgA', $$select id::text from public.orgs where name = 'Alpha Co'$$);
select t_val(null, 'service_role', 'orgB', $$select id::text from public.orgs where name = 'Beta Co'$$);
select t_val(null, 'service_role', 'orgC', $$select id::text from public.orgs where name = 'Gamma Co'$$);
select t_val(null, 'service_role', 'stA', $$select id::text from public.stores where name = 'Alpha Cafe'$$);
select t_val(null, 'service_role', 'stB', $$select id::text from public.stores where name = 'Beta Spa'$$);
select t_val(null, 'service_role', 'stC', $$select id::text from public.stores where name = 'Gamma Shop'$$);

-- ── a network, and who may join ──
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.create_network('{"slug":"island","name":{"th":"เกาะ","en":"Island"}}'::jsonb)$$, '42501', 'only a platform administrator makes a network');
insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-0000000000a1');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.create_network('{"slug":"X","name":{"th":"x"}}'::jsonb)$$, '23514', 'a slug is lower-case letters, digits and dashes');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.create_network('{"slug":"island","name":{"th":"เกาะ","en":"Island"}}'::jsonb)$$, 1, 'the platform administrator makes the network');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.join_network((select v::uuid from t_out where k='orgA'), 'island')$$, '42501', 'a cashier cannot join the business to a network');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.join_network((select v::uuid from t_out where k='orgA'), 'nowhere')$$, '22023', 'an unknown network is refused');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.join_network((select v::uuid from t_out where k='orgA'), 'island')$$, 1, 'the owner of A joins');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.join_network((select v::uuid from t_out where k='orgB'), 'island')$$, 1, 'the owner of B joins');

-- ── Tourist Pass ──
select t_rows(null, 'service_role', $$select 1 where (public.guest_pass_register('island', '{"name":"Liu","phone":"12"}'::jsonb) ->> 'error') = 'invalid'$$, 1, 'a short phone number is refused');
select t_rows(null, 'service_role', $$select 1 where (public.guest_pass_register('island', '{"name":"Liu Wei","phone":"0811111111"}'::jsonb) ->> 'error') = 'consent_needed'$$, 1, 'no consent, no pass');
select t_val(null, 'service_role', 'pass', $$select public.guest_pass_register('island', '{"name":"Liu Wei","phone":"081-111-1111","consent":true}'::jsonb)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='pass' and (v::jsonb ->> 'ok') = 'true' and (v::jsonb ->> 'code') ~ '^BP-[A-HJ-NP-Z2-9]{10}$' and length(v::jsonb ->> 'token') = 32$$, 1, 'she gets a page token and a BP- code');
select t_rows(null, 'service_role', $$select 1 where (public.guest_pass_register('island', '{"name":"Someone","phone":"0811111111","consent":true}'::jsonb) ->> 'error') = 'exists'$$, 1, 'the same phone cannot register again (nobody else gets her pass)');
select t_val(null, 'service_role', 'code', $$select (v::jsonb ->> 'code') from t_out where k='pass'$$);
select t_val(null, 'service_role', 'token', $$select (v::jsonb ->> 'token') from t_out where k='pass'$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select * from public.network_passes$$, '42501', 'the pass table (phones) cannot be read by the browser');

-- ── linking at a shop ──
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (public.link_pass((select v::uuid from t_out where k='stA'), 'BP-NOPENOPENO') ->> 'error') = 'unknown_pass'$$, 1, 'an unknown code attaches nothing');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.link_pass((select v::uuid from t_out where k='stA'), (select v from t_out where k='code'))$$, '42501', 'another business cannot attach a pass at A');
select t_rows('00000000-0000-0000-0000-0000000000c7', 'authenticated', $$select 1 where (public.link_pass((select v::uuid from t_out where k='stC'), (select v from t_out where k='code')) ->> 'error') = 'unknown_pass'$$, 1, 'a business outside the network cannot use the pass');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'lnkA', $$select public.link_pass((select v::uuid from t_out where k='stA'), lower((select v from t_out where k='code')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='lnkA' and (v::jsonb ->> 'ok') = 'true' and (v::jsonb ->> 'name') = 'Liu Wei'$$, 1, 'A cashier attaches the pass (any letter case): the shop gets its own member record');
select t_val('00000000-0000-0000-0000-0000000000f6', 'authenticated', 'lnkB', $$select public.link_pass((select v::uuid from t_out where k='stB'), (select v from t_out where k='code'))::text$$);
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.network_pass_links) = 2 and (select count(distinct customer_id) from public.network_pass_links) = 2$$, 1, 'B has its own record; two links, two member records');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (select (v::jsonb ->> 'customer_id') from t_out where k='lnkA') = (select (public.link_pass((select v::uuid from t_out where k='stA'), (select v from t_out where k='code'))) ->> 'customer_id')$$, 1, 'attaching again returns the same record');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (select (v::jsonb ->> 'customer_id') from t_out where k='lnkA') = (public.link_pass((select v::uuid from t_out where k='stA'), (select v from t_out where k='token')) ->> 'customer_id')$$, 1, 'the pass page QR (its token) attaches the same record as the printed code');
select t_val(null, 'service_role', 'cA', $$select (v::jsonb ->> 'customer_id') from t_out where k='lnkA'$$);
select t_val(null, 'service_role', 'cB', $$select (v::jsonb ->> 'customer_id') from t_out where k='lnkB'$$);

-- ── points earned at A and B; 120 spent at B ──
create or replace function t_order(org text, st text, num text, cust text, used int, disc bigint, paid_ago interval) returns uuid language plpgsql as $$
declare v_o uuid := gen_random_uuid(); v_org uuid := (select v::uuid from t_out where k = org); v_st uuid := (select v::uuid from t_out where k = st);
begin
  insert into public.orders (id, org_id, store_id, number, business_date, channel, status, customer_id)
  values (v_o, v_org, v_st, 'A' || lpad(num, 3, '0'), (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'open', (select v::uuid from t_out where k = cust));
  update public.orders set status = 'paid', points_used = used, points_discount = disc where id = v_o;
  insert into public.receipts (org_id, store_id, order_id, number, issued_at, seller_name, branch_code, vat_registered, vat_bps, service_bps, price_mode, subtotal, service_charge, vat, net_before_vat, total, rounding, payable)
  values (v_org, v_st, v_o, 'A-' || lpad(num, 6, '0'), now() - paid_ago, 'x', '00000', false, 0, 0, 'inclusive', 0, 0, 0, 0, 0, 0, 0);
  return v_o;
end $$;
grant execute on function t_order(text, text, text, text, int, bigint, interval) to service_role;
insert into public.points_ledger (org_id, customer_id, store_id, kind, points, order_id, created_at)
values ((select v::uuid from t_out where k='orgA'), (select v::uuid from t_out where k='cA'), (select v::uuid from t_out where k='stA'), 'earn', 100, (select public.t_order('orgA', 'stA', '1', 'cA', 0, 0, interval '3 days')), now() - interval '3 days'),
       ((select v::uuid from t_out where k='orgB'), (select v::uuid from t_out where k='cB'), (select v::uuid from t_out where k='stB'), 'earn', 50, (select public.t_order('orgB', 'stB', '1', 'cB', 0, 0, interval '2 days')), now() - interval '2 days');
select t_rows(null, 'service_role', $$select 1 where public.points_available((select v::uuid from t_out where k='cB')) = 150 and public.points_available((select v::uuid from t_out where k='cA')) = 150$$, 1, 'at either shop she can spend 150 points: 100 earned at A + 50 earned at B');
select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select 1 where public.points_balance((select v::uuid from t_out where k='cB')) = 150$$, 1, 'B''s cashier sees the network balance');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 where public.points_balance((select v::uuid from t_out where k='cA')) = 0$$, 1, 'but another business sees no balance of this member (0, as before)');

-- 120 points spent at B on a paid bill: the discount is B's (120 satang x 100 = 12,000)
insert into public.points_ledger (org_id, customer_id, store_id, kind, points, order_id)
select (select v::uuid from t_out where k='orgB'), (select v::uuid from t_out where k='cB'), (select v::uuid from t_out where k='stB'), 'redeem', -120,
       public.t_order('orgB', 'stB', '2', 'cB', 120, 12000, interval '1 day');
select t_rows(null, 'service_role', $$select 1 where public.points_available((select v::uuid from t_out where k='cA')) = 30$$, 1, '150 − 120 = 30 left, seen from either shop');

-- ── clearing: FIFO. The 120 points: 100 came from A (older), 20 from B itself → B owes nothing for its own; A is owed for 100 ──
create or replace function t_clr(org text) returns text language sql as $$
  select coalesce(string_agg(issuer_name || '>' || redeemer_name || ':' || points || ':' || amount, ';' order by issuer_name), '')
    from public.network_clearing((select v::uuid from t_out where k = org), (now() at time zone 'Asia/Bangkok')::date - 7, (now() at time zone 'Asia/Bangkok')::date) $$;
grant execute on function t_clr(text) to authenticated, service_role;
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'clrA', $$select t_clr('orgA')$$);
select t_val('00000000-0000-0000-0000-0000000000e5', 'authenticated', 'clrB', $$select t_clr('orgB')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='clrA' and v = 'Alpha Co>Beta Co:100:10000'$$, 1, 'A is owed 100 points = 100.00 baht by B (the oldest points are spent first)');
select t_rows(null, 'service_role', $$select 1 from t_out where k='clrB' and v = 'Alpha Co>Beta Co:100:10000'$$, 1, 'B sees the same line');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select t_clr('orgA')$$, '42501', 'a cashier cannot read the statement');
select t_val('00000000-0000-0000-0000-0000000000c7', 'authenticated', 'clrC', $$select coalesce((select string_agg('x', '') from public.network_clearing((select v::uuid from t_out where k='orgC'), (now())::date - 7, now()::date)), '')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='clrC' and v = ''$$, 1, 'a business outside the network sees nothing');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'clrOld', $$select coalesce((select string_agg('x', '') from public.network_clearing((select v::uuid from t_out where k='orgA'), (now())::date - 30, (now())::date - 10)), '')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='clrOld' and v = ''$$, 1, 'an earlier period (before the redemption) has no lines');

-- a later redemption at A of 20 points: the next-oldest are B's 50 → B owed 20
insert into public.points_ledger (org_id, customer_id, store_id, kind, points, order_id)
select (select v::uuid from t_out where k='orgA'), (select v::uuid from t_out where k='cA'), (select v::uuid from t_out where k='stA'), 'redeem', -20,
       public.t_order('orgA', 'stA', '3', 'cA', 20, 2000, interval '1 hour');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'clrA2', $$select t_clr('orgA')$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='clrA2' and v = 'Alpha Co>Beta Co:100:10000;Beta Co>Alpha Co:20:2000'$$, 1, 'then A owes B 20 points = 20.00 baht for what B issued and A honoured');

-- ── marketplace ──
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.save_network_listing(jsonb_build_object('store_id', (select v from t_out where k='stC'), 'category', 'shop', 'title', '{"th":"x"}'::jsonb))$$, '42501', 'a business cannot list another''s shop');
select t_err('00000000-0000-0000-0000-0000000000c7', 'authenticated', $$select public.save_network_listing(jsonb_build_object('store_id', (select v from t_out where k='stC'), 'category', 'shop', 'title', '{"th":"x"}'::jsonb))$$, '0A000', 'a shop of a business outside the network cannot list');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.save_network_listing(jsonb_build_object('store_id', (select v from t_out where k='stB'), 'category', 'weird', 'title', '{"th":"x"}'::jsonb))$$, '23514', 'only the known categories');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.save_network_listing(jsonb_build_object('store_id', (select v from t_out where k='stB'), 'category', 'spa', 'title', '{"th":"บีต้าสปา","en":"Beta Spa"}'::jsonb, 'about', '{"en":"Massage by the sea"}'::jsonb))$$, 1, 'B lists its spa');
select t_rows(null, 'service_role', $$select 1 where jsonb_array_length(public.guest_island('island') -> 'shops') = 1 and public.guest_island('nowhere') is null$$, 1, 'the public island page shows the listed shop');
select t_rows(null, 'service_role', $$select 1 where (public.guest_island('island') -> 'shops' -> 0 ->> 'booking_token') is null$$, 1, 'no booking link while online booking is off');
update public.stores set module_overrides = '{"booking.online": true}', plan = 'pro' where name = 'Beta Spa';
select t_val('00000000-0000-0000-0000-0000000000e5', 'authenticated', 'bt', $$select (public.save_booking_settings((select v::uuid from t_out where k='stB'), '{}') ->> 'token')$$);
select t_rows(null, 'service_role', $$select 1 where (public.guest_island('island') -> 'shops' -> 0 ->> 'booking_token') = (select v from t_out where k='bt')$$, 1, 'with online booking on, the island page carries the booking link');
select t_val(null, 'service_role', 'gp', $$select public.guest_pass((select v from t_out where k='token'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='gp' and (v::jsonb ->> 'points') = '10' and jsonb_array_length(v::jsonb -> 'activity') = 4 and (v::jsonb ->> 'name') = 'Liu Wei'$$, 1, 'the pass page shows her 10 points left and her four movements');
select t_rows(null, 'service_role', $$select 1 where public.guest_pass('0123456789abcdef0123456789abcdef') is null$$, 1, 'a wrong token finds nothing');

-- ── staff issue a pass at the counter ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'iss', $$select public.staff_issue_pass(jsonb_build_object('store_id', (select v from t_out where k='stA'), 'name', 'Kenji', 'phone', '0822222222'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='iss' and (v::jsonb ->> 'code') like 'BP-%' and (v::jsonb ->> 'customer_id') is not null$$, 1, 'a cashier issues a pass for a tourist at the counter, with her shop record');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'iss2', $$select public.staff_issue_pass(jsonb_build_object('store_id', (select v from t_out where k='stA'), 'name', 'Kenji', 'phone', '082-222-2222'))::text$$);
select t_rows(null, 'service_role', $$select 1 where (select v::jsonb ->> 'code' from t_out where k='iss') = (select v::jsonb ->> 'code' from t_out where k='iss2')$$, 1, 'asking again returns the same pass (to staff only)');
select t_err('00000000-0000-0000-0000-0000000000c7', 'authenticated', $$select public.staff_issue_pass(jsonb_build_object('store_id', (select v from t_out where k='stC'), 'name', 'X', 'phone', '0833333333'))$$, '0A000', 'a business outside the network cannot issue passes');
do $$ begin raise notice 'ALL NETWORK TESTS PASSED'; end $$;
