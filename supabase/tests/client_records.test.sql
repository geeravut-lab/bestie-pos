-- Client records: notes and the health intake form — who may write / read, the closed answers, consent, erase.
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
select t_val(null, 'service_role', 'cust', $$insert into public.customers (org_id, name, phone, member_code) values ((select v::uuid from t_out where k='org'), 'Mali', '0812345678', 'AAAA1111') returning id::text$$);
select t_val(null, 'service_role', 'ocust', $$insert into public.customers (org_id, name, phone, member_code) select o.id, 'Other', '0899999999', 'BBBB2222' from public.orgs o where o.name = 'Other' returning id::text$$);
create or replace function t_note(kind text, title text, body text, cust text default 'cust') returns jsonb language sql as $$
  select jsonb_build_object('store_id', (select v from t_out where k='store'), 'customer_id', (select v from t_out where k=cust), 'kind', kind, 'title', title, 'body', body) $$;
grant execute on function t_note(text, text, text, text) to authenticated, service_role;
create or replace function t_hi(cons boolean, nm text, ans jsonb default '{"pregnant":false,"high_bp":true,"allergies":"nuts"}', cust text default 'cust') returns jsonb language sql as $$
  select jsonb_build_object('store_id', (select v from t_out where k='store'), 'customer_id', (select v from t_out where k=cust), 'consent', cons, 'signed_name', nm, 'answers', ans) $$;
grant execute on function t_hi(boolean, text, jsonb, text) to authenticated, service_role;

-- ── notes ──
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.add_client_note(t_note('formula', 'Colour', '6.1 + 7.0 1:1, 20 vol'))$$, '42501', 'another business cannot write a note here');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.add_client_note(t_note('secret', 'x', 'y'))$$, '22023', 'only formula or note');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.add_client_note(t_note('note', ' ', 'y'))$$, '23514', 'a note needs a title');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.add_client_note(t_note('note', 'x', 'y', 'ocust'))$$, '22023', 'a member of another business is refused');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'n1', $$select public.add_client_note(t_note('formula', 'Colour', '6.1 + 7.0 1:1, 20 vol, 35 min'))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.client_notes where kind = 'formula' and customer_id = (select v::uuid from t_out where k='cust')$$, 1, 'the cashier who wrote it can read it back (customer.view)');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.client_notes$$, 0, 'another business sees nothing');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.client_notes (org_id, store_id, customer_id, kind, title, body) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cust'), 'note', 'a', 'b')$$, '42501', 'no direct writes from the browser');

-- ── health intake ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_health_intake(t_hi(false, 'Mali Sue'))$$, '22023', 'no consent, no form');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_health_intake(t_hi(true, 'M'))$$, '23514', 'a signature needs a real name');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_health_intake(t_hi(true, 'Mali Sue', '{"cancer_stage":"x"}'))$$, '22023', 'an answer outside the closed set is refused');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_health_intake(t_hi(true, 'Mali Sue', '{"heart":"yes"}'))$$, '22023', 'a yes / no answer must be a boolean');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_health_intake(t_hi(true, 'Mali Sue', jsonb_build_object('allergies', repeat('x', 301))))$$, '22023', 'free text is short');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'h1', $$select public.save_health_intake(t_hi(true, 'Mali Sue'))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select 1 from public.health_intakes where signed_name = 'Mali Sue' and consent and answers ->> 'allergies' = 'nuts'$$, 1, 'the manager can read the signed form');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.health_intakes$$, 0, 'another business cannot');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where entity = 'health_intakes' and detail::text not like '%nuts%' and detail::text not like '%Mali%'$$, 1, 'the audit line says it was saved, never what it holds');

-- ── erase ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.delete_client_record('health', (select v::uuid from t_out where k='h1'))$$, '42501', 'a cashier cannot erase a form');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.delete_client_record('health', (select v::uuid from t_out where k='h1'))$$, 1, 'the manager erases it on the guest''s request');
select t_rows(null, 'service_role', $$select 1 from public.health_intakes$$, 0, 'it is gone');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.delete_client_record('note', (select v::uuid from t_out where k='n1'))$$, 1, 'and a mistaken note can be removed');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.delete_client_record('other', gen_random_uuid())$$, '22023', 'unknown kind');
do $$ begin raise notice 'ALL CLIENT RECORD TESTS PASSED'; end $$;
