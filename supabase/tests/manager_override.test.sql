-- Manager override: a cashier voids a sent line only with a manager's PIN; wrong PIN locks; audit names the approver.
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
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test'),
  ('00000000-0000-0000-0000-0000000000c9', 'waiter@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme Co','Acme','restaurant')$$, 1, 'owner creates a restaurant');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','cafe')$$, 1, 'a second org exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('00000000-0000-0000-0000-0000000000d4'::uuid, 'Cashier', 'cashier'),
               ('00000000-0000-0000-0000-0000000000c9'::uuid, 'Waiter', 'waiter')) as u(id, n, b) on true
  join public.roles r on r.org_id = o.id and r.built_in = u.b
 where o.name = 'Acme Co';
update public.legal_entities set tax_id = '0105560123456' where name = 'Acme Co';
update public.stores set vat_registered = true, vat_bps = 700, branch_code = '00001' where name = 'Acme';

select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Acme Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Counter', 'cashier', 'POS-77') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cashier_staff', $$select id::text from public.staff where display_name = 'Cashier'$$);

-- two open orders: 210.00 (2 x 90.00 + 30.00) and 30.00
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values ('10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A001', (now() at time zone 'Asia/Bangkok')::date, 'takeaway'), ('10000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A002', (now() at time zone 'Asia/Bangkok')::date, 'takeaway')$$, 2, 'two orders');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', '{"th":"ผัดไทย"}', 9000, 2), ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', '{"th":"ชา"}', 3000, 1), ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', '{"th":"ชา"}', 3000, 1)$$, 3, 'lines');

-- what the till sends (VAT 7 % included in 210.00 = 13.74)
create or replace function t_payload(p_order text, p_no text, p_tendered bigint, p_amount bigint default 21000, p_total bigint default 21000, p_sub bigint default 21000, p_rounding int default 0, p_tender text default 'cash') returns jsonb language sql as $$
  select jsonb_build_object(
    'order_id', p_order, 'receipt_number', p_no, 'device_id', (select v from t_out where k='dev'),
    'staff_id', (select v from t_out where k='cashier_staff'), 'issued_at', now(), 'lang', 'th',
    'subtotal', p_sub, 'service_charge', 0, 'vat', 1374, 'net_before_vat', 19626, 'total', p_total, 'rounding', p_rounding,
    'payable', p_total + p_rounding, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive',
    'payments', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'tender', p_tender, 'amount', p_amount,
       'tendered', p_tendered, 'change', p_tendered - p_amount)));
$$;
grant execute on function t_payload(text, text, bigint, bigint, bigint, bigint, int, text) to authenticated, service_role;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000b2', 'manager@example.test');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000b2', 'Manager', r.id from public.orgs o
  join public.roles r on r.org_id = o.id and r.built_in = 'manager' where o.name = 'Acme Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'mgr', $$select id::text from public.staff where display_name = 'Manager'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'cashier_id', $$select id::text from public.staff where display_name = 'Cashier'$$);
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.set_staff_pin((select v::uuid from t_out where k='mgr'), '4321')$$, 1, 'the manager has a PIN');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.set_staff_pin((select v::uuid from t_out where k='cashier_id'), '1111')$$, 1, 'the cashier has a PIN too');
update public.order_lines set status = 'sent', sent_at = now() where order_id = '10000000-0000-4000-8000-000000000001';
select t_val(null, 'service_role', 'line', $$select id::text from public.order_lines where order_id = '10000000-0000-4000-8000-000000000001' limit 1$$);

create or replace function t_void(pin text, mgr text default null, reason text default 'guest left') returns jsonb language sql as $$
  select jsonb_build_object('line_id', (select v from t_out where k='line'), 'reason', reason,
    'manager_id', coalesce(mgr, (select v from t_out where k='mgr')), 'manager_pin', pin)
$$;
grant execute on function t_void(text, text, text) to authenticated, service_role;

-- a cashier cannot void a sent line on their own
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.order_lines set status = 'void', void_reason = 'x' where id = (select v::uuid from t_out where k='line')$$, '42501', 'the cashier alone cannot void a sent line');

-- who may approve
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.void_approvers((select v::uuid from t_out where k='org')) @> '[{"name":"Manager"}]'::jsonb and not (public.void_approvers((select v::uuid from t_out where k='org')) @> '[{"name":"Cashier"}]'::jsonb)$$, 1, 'the approver list has the manager (a cashier is not on it)');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.void_approvers((select v::uuid from t_out where k='org'))$$, '42501', 'another org cannot list approvers');

-- refusals
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.void_line_with_manager(t_void('4321'))$$, '42501', 'another org cannot use it');
select t_err(null, 'anon', $$select public.void_line_with_manager(t_void('4321'))$$, '42501', 'anon cannot');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.void_line_with_manager(t_void('4321', (select v from t_out where k='cashier_id')))$$, '28000', 'a cashier cannot approve (even with the right PIN)');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.void_line_with_manager(t_void('4321', gen_random_uuid()::text))$$, '28000', 'an unknown approver');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.void_line_with_manager(t_void('4321', null, ' '))$$, '22023', 'a reason is required');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (public.void_line_with_manager(t_void('0000')) ->> 'ok') = 'false'$$, 1, 'a wrong PIN is refused (an answer, not an error, so the counter is kept)');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where id = (select v::uuid from t_out where k='line') and status = 'sent'$$, 1, 'and the line is untouched');

-- five wrong tries lock the PIN, and then even the right one is refused (15 minutes)
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (public.void_line_with_manager(t_void('0001')) ->> 'ok') = 'false'$$, 1, 'wrong 2');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (public.void_line_with_manager(t_void('0002')) ->> 'ok') = 'false'$$, 1, 'wrong 3');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (public.void_line_with_manager(t_void('0003')) ->> 'ok') = 'false'$$, 1, 'wrong 4');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (public.void_line_with_manager(t_void('0004')) ->> 'ok') = 'false'$$, 1, 'wrong 5 (locks)');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (public.void_line_with_manager(t_void('4321')) ->> 'ok') = 'false'$$, 1, 'the right PIN is refused while locked');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'auth.pin_lockout'$$, 1, 'the lock-out is audited');
update public.staff_pins set failed_attempts = 0, locked_until = null;   -- time passes

-- the good path
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (public.void_line_with_manager(t_void('4321')) ->> 'ok') = 'true'$$, 1, 'the manager''s PIN voids the line');
select t_rows(null, 'service_role', $$select 1 from public.order_lines where id = (select v::uuid from t_out where k='line') and status = 'void' and void_reason = 'guest left'$$, 1, 'the line is void with its reason');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'order.void' and detail ->> 'approved_by' = (select v from t_out where k='mgr')$$, 1, 'the audit event names the approving manager');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (public.void_line_with_manager(t_void('4321')) ->> 'replay') = 'true'$$, 1, 'sending it again is a harmless no-op');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'order.void'$$, 1, 'and does not write a second event');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.order_lines set status = 'sent' where id = (select v::uuid from t_out where k='line')$$, '23514', 'a void line stays void');
\echo ALL MANAGER OVERRIDE TESTS PASSED
