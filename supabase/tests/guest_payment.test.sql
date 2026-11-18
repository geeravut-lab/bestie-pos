-- Pay at the table: only with a chosen device, only for confirmed lines, server-side amounts, one live attempt, order lock.
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
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme Co','Acme','restaurant')$$, 1, 'owner creates a restaurant');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o
  join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Acme Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'cafe', $$select public.create_store((select org_id::text from public.stores where name='Acme')::uuid, 'Beach Cafe', 'cafe')::text$$);
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.seed_demo_menu((select v::uuid from t_out where k='store'))$$, 1, 'demo restaurant menu');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.seed_demo_menu((select v::uuid from t_out where k='cafe'))$$, 1, 'demo cafe menu');
select t_val(null, 'service_role', 'tok', $$select qr_token from public.dining_tables where store_id = (select v::uuid from t_out where k='store') and name = 'T1'$$);
select t_val(null, 'service_role', 'tok2', $$select qr_token from public.dining_tables where store_id = (select v::uuid from t_out where k='store') and name = 'T2'$$);
select t_val(null, 'service_role', 'padthai', $$select id::text from public.menu_items where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Pad Thai with prawns'$$);
select t_val(null, 'service_role', 'tomyum', $$select id::text from public.menu_items where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Tom yum goong'$$);
select t_val(null, 'service_role', 'egg', $$select id::text from public.modifier_options where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Fried egg'$$);
select t_val(null, 'service_role', 'mild', $$select id::text from public.modifier_options where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Medium'$$);
select t_val(null, 'service_role', 'hot', $$select id::text from public.modifier_options where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Very spicy'$$);
select t_val(null, 'service_role', 'latte', $$select id::text from public.menu_items where store_id = (select v::uuid from t_out where k='cafe') and name ->> 'en' = 'Latte'$$);


update public.stores set qr_auto_send = false where id = (select v::uuid from t_out where k='store');
select t_val(null, 'service_role', 'dev', $$insert into public.devices (org_id, store_id, name, role) values ((select org_id from public.stores where id = (select v::uuid from t_out where k='store')), (select v::uuid from t_out where k='store'), 'Counter', 'cashier') returning id::text$$);

create or replace function t_order(tok text, cid text, lines text) returns jsonb language sql as $$
  select jsonb_build_object('token', tok, 'client_id', cid, 'lines', lines::jsonb)
$$;
grant execute on function t_order(text, text, text) to service_role;
create or replace function t_snap(order_id text, device text, subtotal int, total int) returns jsonb language sql as $$
  select jsonb_build_object('order_id', order_id, 'device_id', device, 'staff_id', null, 'tender', 'promptpay', 'lang', 'en',
    'subtotal', subtotal, 'service_charge', 0, 'vat', 0, 'net_before_vat', total, 'total', total, 'rounding', 0, 'payable', total,
    'vat_bps', 0, 'service_bps', 0, 'price_mode', 'inclusive')
$$;
grant execute on function t_snap(text, text, int, int) to service_role;

select t_err(null, 'anon', $$select public.guest_pay_context('x')$$, '42501', 'anon cannot read the pay context');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.guest_begin_payment('x', '{}'::jsonb)$$, '42501', 'nor start a payment');

-- an order with one unconfirmed line
select t_val(null, 'service_role', 'o1', $$select public.guest_place_order(t_order((select v from t_out where k='tok'), '30000000-0000-4000-8000-000000000001',
  format('[{"item_id":"%s","quantity":2,"option_ids":[]}]', (select id::text from public.menu_items where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Water'))))::text$$);
select t_val(null, 'service_role', 'oid', $$select (v::jsonb ->> 'order_id') from t_out where k='o1'$$);

-- off until the owner chooses a device
select t_rows(null, 'service_role', $$select 1 where (public.guest_pay_context((select v from t_out where k='tok')) ->> 'enabled') = 'false'$$, 1, 'pay at the table is off until a device is chosen');
select t_err(null, 'service_role', $$select public.guest_begin_payment((select v from t_out where k='tok'), t_snap((select v from t_out where k='oid'), (select v from t_out where k='dev'), 4000, 4000))$$, '0A000', 'and refuses an attempt');
update public.stores set qr_pay_device = (select v::uuid from t_out where k='dev') where id = (select v::uuid from t_out where k='store');
select t_rows(null, 'service_role', $$select 1 where (public.guest_pay_context((select v from t_out where k='tok')) ->> 'enabled') = 'true' and (public.guest_pay_context((select v from t_out where k='tok')) ->> 'unsent') = 'true'$$, 1, 'on with a device; the context says some lines are unconfirmed');
select t_err(null, 'service_role', $$select public.guest_begin_payment((select v from t_out where k='tok'), t_snap((select v from t_out where k='oid'), (select v from t_out where k='dev'), 4000, 4000))$$, '55000', 'a bill with lines the staff have not confirmed cannot be paid');

-- staff send the lines
update public.order_lines set status = 'sent', sent_at = now() where order_id = (select v::uuid from t_out where k='oid');
select t_rows(null, 'service_role', $$select 1 where jsonb_array_length(public.guest_pay_context((select v from t_out where k='tok')) -> 'lines') = 1 and (public.guest_pay_context((select v from t_out where k='tok')) #>> '{lines,0,quantity}') = '2'$$, 1, 'the context carries the lines the handler prices');

select t_err(null, 'service_role', $$select public.guest_begin_payment('nope', t_snap((select v from t_out where k='oid'), (select v from t_out where k='dev'), 4000, 4000))$$, 'P0002', 'unknown token');
select t_err(null, 'service_role', $$select public.guest_begin_payment((select v from t_out where k='tok2'), t_snap((select v from t_out where k='oid'), (select v from t_out where k='dev'), 4000, 4000))$$, 'P0002', 'a bill of another table cannot be paid with this table''s token');
select t_err(null, 'service_role', $$select public.guest_begin_payment((select v from t_out where k='tok'), t_snap((select v from t_out where k='oid'), (select v from t_out where k='dev'), 3000, 3000))$$, '23514', 'a subtotal that does not match the lines is refused');
select t_err(null, 'service_role', $$select public.guest_begin_payment((select v from t_out where k='tok'), jsonb_set(t_snap((select v from t_out where k='oid'), (select v from t_out where k='dev'), 4000, 4000), '{payable}', '3000'))$$, '23514', 'a payable amount that differs from the total is refused');
select t_err(null, 'service_role', $$select public.guest_begin_payment((select v from t_out where k='tok'), t_snap((select v from t_out where k='oid'), gen_random_uuid()::text, 4000, 4000))$$, '23514', 'the wrong device is refused');
select t_err(null, 'service_role', $$select public.guest_begin_payment((select v from t_out where k='tok'), jsonb_set(t_snap((select v from t_out where k='oid'), (select v from t_out where k='dev'), 4000, 4000), '{tender}', '"gateway"'))$$, '23514', 'only PromptPay');

select t_val(null, 'service_role', 'att', $$select public.guest_begin_payment((select v from t_out where k='tok'), t_snap((select v from t_out where k='oid'), (select v from t_out where k='dev'), 4000, 4000))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.payment_attempts where id = (select v::uuid from t_out where k='att') and amount = 4000 and status = 'created' and staff_id is null$$, 1, 'an attempt of 40.00 exists');
select t_err(null, 'service_role', $$select public.guest_begin_payment((select v from t_out where k='tok'), t_snap((select v from t_out where k='oid'), (select v from t_out where k='dev'), 4000, 4000))$$, '23505', 'only one live attempt per bill');
select t_rows(null, 'service_role', $$select 1 where (public.guest_pay_context((select v from t_out where k='tok')) #>> '{live,id}') = (select v from t_out where k='att')$$, 1, 'the context shows the live attempt (so a reload resumes it)');

-- the bill is locked for ordering while a payment waits
select t_err(null, 'service_role', $$select public.guest_place_order(t_order((select v from t_out where k='tok'), '30000000-0000-4000-8000-000000000002',
  format('[{"item_id":"%s","quantity":1,"option_ids":[]}]', (select id::text from public.menu_items where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Water'))))$$, '55006', 'no new lines while a payment is waiting');

-- status and cancel are tied to the table's token
select t_rows(null, 'service_role', $$select 1 where (public.guest_payment_status((select v from t_out where k='tok'), (select v::uuid from t_out where k='att')) ->> 'status') = 'created'$$, 1, 'status by token');
select t_rows(null, 'service_role', $$select 1 where public.guest_payment_status((select v from t_out where k='tok2'), (select v::uuid from t_out where k='att')) is null$$, 1, 'another table''s token sees nothing');
select t_err(null, 'service_role', $$select public.guest_cancel_payment((select v from t_out where k='tok2'), (select v::uuid from t_out where k='att'))$$, 'P0002', 'another table cannot cancel it');
select t_rows(null, 'service_role', $$select 1 where (public.guest_cancel_payment((select v from t_out where k='tok'), (select v::uuid from t_out where k='att')) ->> 'status') = 'canceled'$$, 1, 'the guest cancels');
select t_rows(null, 'service_role', $$select 1 where public.guest_pay_context((select v from t_out where k='tok')) -> 'live' = 'null'::jsonb or (public.guest_pay_context((select v from t_out where k='tok')) -> 'live') is null$$, 1, 'no live attempt after cancelling');

-- ordering works again, then pay and confirm through the provider path
select t_rows(null, 'service_role', $$select 1 where (public.guest_place_order(t_order((select v from t_out where k='tok'), '30000000-0000-4000-8000-000000000003',
  format('[{"item_id":"%s","quantity":1,"option_ids":[]}]', (select id::text from public.menu_items where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Water')))) ->> 'lines') = '1'$$, 1, 'ordering again after the cancel');
update public.order_lines set status = 'sent', sent_at = now() where order_id = (select v::uuid from t_out where k='oid');
select t_val(null, 'service_role', 'att2', $$select public.guest_begin_payment((select v from t_out where k='tok'), t_snap((select v from t_out where k='oid'), (select v from t_out where k='dev'), 6000, 6000))::text$$);
select t_rows(null, 'service_role', $$select 1 where public.confirm_payment_attempt((select v::uuid from t_out where k='att2'), 'pi_test_1', 6000, 'thb') = 'paid'$$, 1, 'the provider confirms: the bill closes');
select t_rows(null, 'service_role', $$select 1 where (public.guest_payment_status((select v from t_out where k='tok'), (select v::uuid from t_out where k='att2')) ->> 'receipt') like '%+000001'$$, 1, 'the guest sees the online receipt number');
select t_rows(null, 'service_role', $$select 1 from public.orders where id = (select v::uuid from t_out where k='oid') and status = 'paid'$$, 1, 'the order is paid');
\echo ALL GUEST PAYMENT TESTS PASSED
