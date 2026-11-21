-- Full tax invoice: issued on request for a paid bill of a VAT shop, numbered, never edited, cancelled with a reason.
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
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Cafe Co','Palm Cafe','cafe')$$, 1, 'the owner creates a cafe');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other Co','Other','cafe')$$, 1, 'another business exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Cafe Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Cafe Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Palm Cafe'$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cashier_staff', $$select id::text from public.staff where display_name = 'Cashier'$$);
update public.legal_entities set tax_id = '0105560123456' where name = 'Cafe Co';
update public.stores set vat_registered = true, vat_bps = 700, branch_code = '00001' where org_id = (select v::uuid from t_out where k='org');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Till', 'cashier', 'POS-1') returning id::text$$);
select t_val(null, 'service_role', 'cat', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"อาหาร"}') returning id::text$$);
select t_val(null, 'service_role', 'rice', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, station, barcode) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"ข้าวผัด","en":"Fried rice"}', '{"base": 10000, "delivery": 13000}', 'kitchen', 'RICE-001') returning id::text$$);
select t_val(null, 'service_role', 'tea', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, sku) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"ชา"}', '{"base": 5000}', 'TEA-1') returning id::text$$);
select t_val(null, 'service_role', 'off', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, barcode, available) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"หมด"}', '{"base": 100}', 'GONE-01', false) returning id::text$$);

-- a paid cash bill (the till closes it)
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values ('10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A001', (now() at time zone 'Asia/Bangkok')::date, 'takeaway')$$, 1, 'a bill');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, status, sent_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', '{"th":"ข้าว"}', 10700, 1, 'sent', now())$$, 1, 'a line of 107.00');
create or replace function t_close(p_order text, p_pay text) returns jsonb language sql as $$
  select jsonb_build_object('order_id', p_order, 'payment_id', p_pay, 'device_id', (select v from t_out where k='dev'), 'staff_id', (select v from t_out where k='cashier_staff'), 'issued_at', now(), 'lang', 'th',
    'subtotal', 10700, 'service_charge', 0, 'vat', 700, 'net_before_vat', 10000, 'total', 10700, 'rounding', 0, 'payable', 10700, 'vat_bps', 700, 'service_bps', 0, 'price_mode', 'inclusive',
    'payments', jsonb_build_array(jsonb_build_object('id', p_pay, 'tender', 'cash', 'amount', 10700, 'tendered', 10700, 'change', 0))) $$;
grant execute on function t_close(text, text) to authenticated, service_role;
create or replace function t_inv(p_order text, p_name text default 'Acme Co., Ltd.', p_tax text default '0105551234567', p_branch text default '00000', p_addr text default '1 Beach Road, Koh Phangan 84280') returns jsonb language sql as $$
  select jsonb_build_object('order_id', p_order, 'buyer_name', p_name, 'buyer_tax_id', p_tax, 'buyer_branch', p_branch, 'buyer_address', p_addr) $$;
grant execute on function t_inv(text, text, text, text, text) to authenticated, service_role;

select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.issue_tax_invoice(t_inv('10000000-0000-4000-8000-000000000001'))$$, '55000', 'an open bill cannot have a tax invoice');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cl', $$select public.close_order_tenders(t_close('10000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.orders where id = '10000000-0000-4000-8000-000000000001' and status = 'paid'$$, 1, 'paid');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.issue_tax_invoice(t_inv('10000000-0000-4000-8000-000000000001'))$$, '55000', 'the seller address must be set first');

-- the owner sets the address
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_tax_profile(jsonb_build_object('store_id', (select v from t_out where k='store'), 'company_address', 'x'))$$, '42501', 'a cashier cannot set the seller address');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_tax_profile(jsonb_build_object('store_id', (select v from t_out where k='store'), 'company_address', '99 Moo 1, Koh Phangan 84280', 'branch_address', 'Haad Rin Beach'))$$, 1, 'the owner sets it');
select t_rows(null, 'service_role', $$select 1 from public.legal_entities where name = 'Cafe Co' and address = '99 Moo 1, Koh Phangan 84280'$$, 1, 'on the company');
select t_rows(null, 'service_role', $$select 1 from public.stores where name = 'Palm Cafe' and address = 'Haad Rin Beach'$$, 1, 'and on the branch');

-- refusals
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.issue_tax_invoice(t_inv('10000000-0000-4000-8000-000000000001'))$$, '42501', 'another business cannot');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.issue_tax_invoice(t_inv('10000000-0000-4000-8000-000000000001', 'Acme', '12345'))$$, '23514', 'a buyer tax ID has 13 digits');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.issue_tax_invoice(t_inv('10000000-0000-4000-8000-000000000001', 'Acme', '0105551234567', '1'))$$, '23514', 'a branch has 5 digits');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.issue_tax_invoice(t_inv('10000000-0000-4000-8000-000000000001', '', '0105551234567'))$$, '23514', 'a buyer needs a name');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.issue_tax_invoice(t_inv('10000000-0000-4000-8000-000000000001', 'Acme', '0105551234567', '00000', 'x'))$$, '23514', 'and an address');

-- issue
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ti', $$select public.issue_tax_invoice(t_inv('10000000-0000-4000-8000-000000000001'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='ti' and (v::jsonb ->> 'number') = 'TI-000001' and (v::jsonb ->> 'replay') = 'false'$$, 1, 'numbered TI-000001');
select t_val(null, 'service_role', 'tiid', $$select v::jsonb ->> 'id' from t_out where k='ti'$$);
select t_rows(null, 'service_role', $$select 1 from public.tax_invoices t join public.receipts r on r.id = t.receipt_id where t.id = (select v::uuid from t_out where k='tiid') and t.buyer_tax_id = '0105551234567' and t.buyer_branch = '00000' and t.status = 'issued' and t.etax_status = 'none' and r.vat = 700$$, 1, 'tied to the receipt, whose VAT breakdown it uses');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ti2', $$select public.issue_tax_invoice(t_inv('10000000-0000-4000-8000-000000000001', 'Someone else'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='ti2' and (v::jsonb ->> 'replay') = 'true' and (v::jsonb ->> 'number') = 'TI-000001'$$, 1, 'asking again returns the same invoice, never a second one');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.tax_invoices$$, 1, 'the till reads it');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.tax_invoices$$, 0, 'another business reads none');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.tax_invoices set buyer_name = 'Forged'$$, '42501', 'the browser cannot edit one');
select t_err(null, 'service_role', $$update public.tax_invoices set buyer_name = 'Forged'$$, '42501', 'nor can the server by accident');
select t_err(null, 'service_role', $$delete from public.tax_invoices$$, '42501', 'nobody deletes one');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'payment.tender' and entity_id = (select v from t_out where k='tiid')$$, 1, 'issuing is in the audit trail');

-- cancel and reissue
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.cancel_tax_invoice((select v::uuid from t_out where k='tiid'), 'wrong buyer')$$, '42501', 'a cashier cannot cancel');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.cancel_tax_invoice((select v::uuid from t_out where k='tiid'), 'x')$$, '22023', 'a reason is needed');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.cancel_tax_invoice((select v::uuid from t_out where k='tiid'), 'wrong buyer name')$$, 1, 'the manager cancels it');
select t_rows(null, 'service_role', $$select 1 from public.tax_invoices where id = (select v::uuid from t_out where k='tiid') and status = 'cancelled' and cancel_reason = 'wrong buyer name' and cancelled_at is not null$$, 1, 'it stays on record, cancelled');
select t_err(null, 'service_role', $$update public.tax_invoices set status = 'issued', cancelled_at = null, cancel_reason = null$$, '42501', 'a cancelled invoice cannot be revived');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ti3', $$select public.issue_tax_invoice(t_inv('10000000-0000-4000-8000-000000000001', 'Acme Corrected Co., Ltd.'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='ti3' and (v::jsonb ->> 'number') = 'TI-000002' and (v::jsonb ->> 'replay') = 'false'$$, 1, 'a new one is TI-000002: the cancelled number is never reused');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.tax_invoices) = 2 and (select count(*) from public.tax_invoices where status = 'issued') = 1$$, 1, 'two rows, one live');

-- a shop that is not VAT registered
update public.stores set vat_registered = false where id = (select v::uuid from t_out where k='store');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.orders (id, org_id, store_id, number, business_date, channel) values ('10000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A002', (now() at time zone 'Asia/Bangkok')::date, 'takeaway')$$, 1, 'another bill');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, status, sent_at) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', '{"th":"ข้าว"}', 10700, 1, 'sent', now())$$, 1, 'its line');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'cl2', $$select public.close_order_tenders(t_close('10000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000002') || jsonb_build_object('vat', 0, 'net_before_vat', 10700))::text$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.issue_tax_invoice(t_inv('10000000-0000-4000-8000-000000000002'))$$, '55000', 'a shop that is not VAT registered issues no tax invoice');
do $$ begin raise notice 'ALL TAX INVOICE TESTS PASSED'; end $$;
