-- Product returns: who may, what is refunded (proportional, exact), the routes, points, stock, the drawer, replay, the report.
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
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Shop Co','Shop','retail')$$, 1, 'owner creates a retail shop');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','retail')$$, 1, 'another business exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('00000000-0000-0000-0000-0000000000b2'::uuid, 'Manager', 'manager'),
               ('00000000-0000-0000-0000-0000000000d4'::uuid, 'Cashier', 'cashier')) as u(id, n, b) on true
  join public.roles r on r.org_id = o.id and r.built_in = u.b
 where o.name = 'Shop Co';
update public.legal_entities set tax_id = '0105560123456' where name = 'Shop Co';
update public.stores set vat_registered = true, vat_bps = 700, branch_code = '00001' where name = 'Shop';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Shop Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Shop'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Counter', 'cashier', 'POS-1') returning id::text$$);
select t_val(null, 'service_role', 'cashier_staff', $$select id::text from public.staff where display_name = 'Cashier'$$);
select t_val(null, 'service_role', 'cat', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"x"}') returning id::text$$);
select t_val(null, 'service_role', 'tee', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"เสื้อ","en":"T-shirt"}', '{"base": 30000}') returning id::text$$);
select t_val(null, 'service_role', 'hat', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"หมวก"}', '{"base": 10000}') returning id::text$$);
select t_val(null, 'service_role', 'stk', $$insert into public.stock_items (org_id, store_id, name, unit) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"เสื้อ"}', 'pcs') returning id::text$$);
select t_rows(null, 'service_role', $$insert into public.stock_moves (org_id, store_id, item_id, kind, qty_delta) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='stk'), 'receive', 10)$$, 1, 'ten T-shirts are received');
select t_rows(null, 'service_role', $$insert into public.recipe_lines (org_id, store_id, menu_item_id, item_id, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='tee'), (select v::uuid from t_out where k='stk'), 1)$$, 1, 'one T-shirt uses one piece of stock');
select t_val(null, 'service_role', 'cust', $$insert into public.customers (org_id, name, phone, member_code) values ((select v::uuid from t_out where k='org'), 'Mali', '0812345678', 'AAAA1111') returning id::text$$);

-- a shift is open on the till, then a bill: 2 T-shirts at 300.00 + 1 hat at 100.00 = 700.00, paid in cash, for the member
select t_rows(null, 'service_role', $$insert into public.shifts (org_id, store_id, device_id, opened_at, opening_cash) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='dev'), now(), 10000)$$, 1, 'a shift opens with 100.00');
select t_rows(null, 'service_role', $$insert into public.orders (id, org_id, store_id, number, business_date, channel, status, opened_by, customer_id) values ('76000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A001', (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'open', (select v::uuid from t_out where k='cashier_staff'), (select v::uuid from t_out where k='cust'))$$, 1, 'a bill for the member');
select t_val(null, 'service_role', 'l_tee', $$insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, status, sent_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '76000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='tee'), '{"th":"เสื้อ","en":"T-shirt"}', 30000, 2, 'sent', now()) returning id::text$$);
select t_val(null, 'service_role', 'l_hat', $$insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, status, sent_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '76000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='hat'), '{"th":"หมวก"}', 10000, 1, 'sent', now()) returning id::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(jsonb_build_object('order_id', '76000000-0000-4000-8000-000000000001', 'device_id', (select v from t_out where k='dev'), 'staff_id', (select v from t_out where k='cashier_staff'), 'issued_at', now(), 'lang', 'en', 'subtotal', 70000, 'service_charge', 0, 'vat', 4579, 'net_before_vat', 65421, 'total', 70000, 'rounding', 0, 'payable', 70000, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive', 'payments', jsonb_build_array(t_leg_cash('74000000-0000-4000-8000-000000000001', 70000, 70000))))$$, 1, 'the 700.00 bill is paid in cash');
select t_rows(null, 'service_role', $$select 1 from public.stock_items where id = (select v::uuid from t_out where k='stk') and quantity = 8$$, 1, 'the sale took 2 T-shirts off the shelf (10 → 8)');
select t_rows(null, 'service_role', $$select 1 from public.points_ledger where order_id = '76000000-0000-4000-8000-000000000001' and kind = 'earn' and points = 28$$, 1, 'the member earned 28 points (700.00 ÷ 25)');

create or replace function t_ret(id text, lines jsonb, method text default 'cash', reason text default 'changed_mind') returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'order_id', '76000000-0000-4000-8000-000000000001', 'device_id', (select v from t_out where k='dev'),
    'staff_id', (select v from t_out where k='cashier_staff'), 'reason', reason, 'refund_method', method, 'lines', lines)
$$;
grant execute on function t_ret(text, jsonb, text, text) to authenticated, service_role;
create or replace function t_rl(line text, qty int, restock boolean default true) returns jsonb language sql as $$
  select jsonb_build_object('order_line_id', (select v from t_out where k=line), 'quantity', qty, 'restock', restock) $$;
grant execute on function t_rl(text, int, boolean) to authenticated, service_role;

-- ── who may, and what is refused ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.create_return(t_ret('77000000-0000-4000-8000-000000000001', jsonb_build_array(t_rl('l_tee', 1))))$$, '42501', 'a cashier (no refund.create) cannot take a return');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.create_return(t_ret('77000000-0000-4000-8000-000000000001', jsonb_build_array(t_rl('l_tee', 1))))$$, '42501', 'another business cannot');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.create_return(t_ret('77000000-0000-4000-8000-000000000001', jsonb_build_array(t_rl('l_tee', 3))))$$, '23514', 'more than was sold (3 of 2) is refused');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.create_return(t_ret('77000000-0000-4000-8000-000000000001', jsonb_build_array(t_rl('l_tee', 1), t_rl('l_tee', 1))))$$, '22023', 'a line listed twice is refused');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.create_return(t_ret('77000000-0000-4000-8000-000000000001', '[]'::jsonb))$$, '22023', 'a return of nothing is refused');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.create_return(t_ret('77000000-0000-4000-8000-000000000001', jsonb_build_array(t_rl('l_tee', 1)), 'barter'))$$, '22023', 'an unknown route is refused');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.create_return(t_ret('77000000-0000-4000-8000-000000000001', jsonb_build_array(t_rl('l_tee', 1)), 'cash', 'because'))$$, '22023', 'an unknown reason is refused');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.create_return(t_ret('77000000-0000-4000-8000-000000000001', jsonb_build_array(t_rl('l_tee', 1)), 'manual'))$$, '23514', 'a bill paid only in cash has nothing to refund by hand (PromptPay / card)');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.create_return(t_ret('77000000-0000-4000-8000-000000000001', jsonb_build_array(t_rl('l_tee', 1)), 'credit'))$$, '0A000', 'Credit is off in this shop, so a Credit refund is refused');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.create_return(jsonb_build_object('id', '77000000-0000-4000-8000-000000000001', 'order_id', '76000000-0000-4000-8000-000000000001', 'reason', 'other', 'refund_method', 'cash', 'lines', jsonb_build_array(t_rl('l_tee', 1))))$$, '22023', 'a cash refund names the till');

-- ── the first return: 1 of 2 T-shirts, cash, back on the shelf ──
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'r1', $$select public.create_return(t_ret('77000000-0000-4000-8000-000000000001', jsonb_build_array(t_rl('l_tee', 1))))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k = 'r1' and (v::jsonb ->> 'amount')::bigint = 30000 and v::jsonb ->> 'number' = 'RT-0001' and (v::jsonb ->> 'points_reversed')::int = 12 and (v::jsonb ->> 'replay')::boolean = false$$, 1, 'RT-0001 pays back 300.00 and takes 12 of the 28 points back');
select t_rows(null, 'service_role', $$select 1 from public.stock_items where id = (select v::uuid from t_out where k='stk') and quantity = 9$$, 1, 'the T-shirt is back on the shelf (8 → 9)');
select t_rows(null, 'service_role', $$select 1 from public.points_ledger where order_id = '76000000-0000-4000-8000-000000000001' and kind = 'reverse_earn' and points = -12$$, 1, 'the points ledger shows a reverse_earn of 12');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select 1 from public.order_returns where number = 'RT-0001' and refund_method = 'cash' and amount = 30000$$, 1, 'the manager can read the return');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.order_returns$$, 0, 'another business sees no returns');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'r1b', $$select public.create_return(t_ret('77000000-0000-4000-8000-000000000001', jsonb_build_array(t_rl('l_tee', 1))))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k = 'r1b' and (v::jsonb ->> 'replay')::boolean = true and v::jsonb ->> 'number' = 'RT-0001'$$, 1, 'sending the same return again answers with the first one');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.order_returns) = 1$$, 1, 'and no second return exists');
select t_rows(null, 'service_role', $$select 1 from public.stock_items where id = (select v::uuid from t_out where k='stk') and quantity = 9$$, 1, 'nor a second restock');

-- ── the second return: the other T-shirt (damaged, not restocked) and the hat → everything is back, exactly what was paid ──
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'r2', $$select public.create_return(t_ret('77000000-0000-4000-8000-000000000002', jsonb_build_array(t_rl('l_tee', 1, false), t_rl('l_hat', 1)), 'cash', 'defective'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k = 'r2' and (v::jsonb ->> 'amount')::bigint = 40000 and v::jsonb ->> 'number' = 'RT-0002' and (v::jsonb ->> 'points_reversed')::int = 16$$, 1, 'RT-0002 pays back the remaining 400.00 (total 700.00 = what was paid) and the other 16 points');
select t_rows(null, 'service_role', $$select 1 from public.stock_items where id = (select v::uuid from t_out where k='stk') and quantity = 9$$, 1, 'the damaged T-shirt was not put back (still 9)');
select t_rows(null, 'service_role', $$select 1 where (select coalesce(sum(points), 0) from public.points_ledger where customer_id = (select v::uuid from t_out where k='cust')) = 0$$, 1, 'the member is back to 0 points');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.create_return(t_ret('77000000-0000-4000-8000-000000000003', jsonb_build_array(t_rl('l_hat', 1))))$$, '23514', 'nothing is left to return');
select t_rows(null, 'service_role', $$select 1 where (select sum(amount) from public.order_returns) = 70000$$, 1, 'all returns together = the 700.00 paid');

-- ── history cannot be edited ──
select t_err(null, 'service_role', $$update public.order_returns set amount = 1$$, '23514', 'a return cannot be edited');
select t_err(null, 'service_role', $$delete from public.order_return_lines$$, '23514', 'nor its lines deleted');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$insert into public.order_returns (id, org_id, store_id, order_id, receipt_id, number, refund_method, amount, reason) select gen_random_uuid(), org_id, store_id, order_id, id, 'RT-9999', 'cash', 1, 'other' from public.receipts$$, '42501', 'nobody can write a return directly');

-- ── the drawer: 100.00 + 700.00 sold − 700.00 paid back = 100.00 ──
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'close', $$select public.close_shift(jsonb_build_object('id', (select id::text from public.shifts limit 1), 'closed_at', now() + interval '1 minute', 'counted_cash', 10000))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k = 'close' and (v::jsonb ->> 'expected_cash')::bigint = 10000 and (v::jsonb ->> 'variance')::bigint = 0$$, 1, 'the shift expects 100.00 in the drawer (cash refunds leave it)');

-- ── the report ──
create or replace function t_rep(extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('org_id', (select v from t_out where k='org'), 'from', to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM-DD'), 'to', to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM-DD')) || extra
$$;
grant execute on function t_rep(jsonb) to authenticated, service_role;
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.returns_report(t_rep())$$, '42501', 'a cashier cannot read the returns report');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.returns_report(t_rep('{"from":"2030-02-01","to":"2030-01-01"}'))$$, '22023', 'a backwards range is refused');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'rep', $$select public.returns_report(t_rep())::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k = 'rep' and (v::jsonb -> 'totals' ->> 'returns')::int = 2 and (v::jsonb -> 'totals' ->> 'refunded')::bigint = 70000 and (v::jsonb -> 'totals' ->> 'units')::int = 3$$, 1, 'the report: 2 returns, 700.00 refunded, 3 units');
select t_rows(null, 'service_role', $$select 1 from t_out, jsonb_array_elements((v::jsonb) -> 'by_item') i where k = 'rep' and i ->> 'name_en' = 'T-shirt' and (i ->> 'quantity')::int = 2 and (i ->> 'amount')::bigint = 60000$$, 1, 'by item: 2 T-shirts, 600.00 of goods');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'rep2', $$select public.returns_report(t_rep('{"from":"2030-01-01","to":"2030-01-31"}'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k = 'rep2' and (v::jsonb -> 'totals' ->> 'returns')::int = 0$$, 1, 'a month without returns is empty');

-- ── a Credit refund: Credit on, a bill paid with Credit, the money goes back onto the member's Credit ──
update public.stores set module_overrides = module_overrides || '{"tender.credit": true}'::jsonb where name = 'Shop';
select t_rows(null, 'service_role', $$insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, store_id, device_id, kind, amount, funding, debit_account, credit_account, created_by)
  select '78000000-0000-4000-8000-000000000001', s.org_id, s.legal_entity_id, (select v::uuid from t_out where k='cust'), s.id, (select v::uuid from t_out where k='dev'), 'topup', 100000, 'cash', 'cash', 'customer_credit', null from public.stores s where s.name = 'Shop'$$, 1, 'the member tops up 1,000.00 in cash');
select t_rows(null, 'service_role', $$insert into public.orders (id, org_id, store_id, number, business_date, channel, status, opened_by, customer_id) values ('76000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A002', (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'open', (select v::uuid from t_out where k='cashier_staff'), (select v::uuid from t_out where k='cust'))$$, 1, 'a second bill for the member');
select t_val(null, 'service_role', 'l2', $$insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, status, sent_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '76000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='hat'), '{"th":"หมวก"}', 10000, 1, 'sent', now()) returning id::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.close_order_tenders(jsonb_build_object('order_id', '76000000-0000-4000-8000-000000000002', 'device_id', (select v from t_out where k='dev'), 'staff_id', (select v from t_out where k='cashier_staff'), 'issued_at', now(), 'lang', 'en', 'subtotal', 10000, 'service_charge', 0, 'vat', 654, 'net_before_vat', 9346, 'total', 10000, 'rounding', 0, 'payable', 10000, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive', 'payments', jsonb_build_array(jsonb_build_object('id', '74000000-0000-4000-8000-000000000002', 'tender', 'credit', 'amount', 10000))))$$, 1, 'the hat (100.00) is paid with Credit');
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'r3', $$select public.create_return(jsonb_build_object('id', '77000000-0000-4000-8000-000000000004', 'order_id', '76000000-0000-4000-8000-000000000002', 'device_id', (select v from t_out where k='dev'), 'reason', 'wrong_item', 'refund_method', 'credit', 'lines', jsonb_build_array(jsonb_build_object('order_line_id', (select v from t_out where k='l2'), 'quantity', 1))))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k = 'r3' and (v::jsonb ->> 'amount')::bigint = 10000 and v::jsonb ->> 'number' = 'RT-0003'$$, 1, 'RT-0003 refunds 100.00');
select t_rows(null, 'service_role', $$select 1 from public.credit_ledger where order_id = '76000000-0000-4000-8000-000000000002' and kind = 'adjust' and amount = 10000 and reason = 'return RT-0003'$$, 1, 'the Credit comes back as an adjustment row, not a cash-out');
select t_rows(null, 'service_role', $$select 1 where (select coalesce(sum(amount), 0) from public.credit_ledger) = 100000$$, 1, 'the member holds 1,000.00 again (top-up − spend + refund)');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.create_return(jsonb_build_object('id', '77000000-0000-4000-8000-000000000005', 'order_id', '76000000-0000-4000-8000-000000000002', 'device_id', (select v from t_out where k='dev'), 'reason', 'other', 'refund_method', 'cash', 'lines', jsonb_build_array(jsonb_build_object('order_line_id', (select v from t_out where k='l2'), 'quantity', 1))))$$, '23514', 'the hat is already back');

do $$ begin raise notice 'ALL RETURNS TESTS PASSED'; end $$;
