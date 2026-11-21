-- Spa / yoga advisor: the gate (module + therapist sign-off), tagging services, what the guest page may read.
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
  ('00000000-0000-0000-0000-0000000000f6', 'nok@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Salon Co','Salon','salon')$$, 1, 'owner creates a salon');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('00000000-0000-0000-0000-0000000000b2'::uuid, 'Manager', 'manager'),
               ('00000000-0000-0000-0000-0000000000d4'::uuid, 'Cashier', 'cashier'),
               ('00000000-0000-0000-0000-0000000000f6'::uuid, 'Stylist Nok', 'waiter')) as u(id, n, b) on true
  join public.roles r on r.org_id = o.id and r.built_in = u.b
 where o.name = 'Salon Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Salon Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Salon'$$);
select t_val(null, 'service_role', 'nok_staff', $$select id::text from public.staff where display_name = 'Stylist Nok'$$);
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'nok', $$insert into public.resources (org_id, store_id, name, kind, staff_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Nok', 'stylist', (select v::uuid from t_out where k='nok_staff')) returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'mai', $$insert into public.resources (org_id, store_id, name, kind, sort) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Mai', 'stylist', 5) returning id::text$$);
select t_val(null, 'service_role', 'cat', $$insert into public.menu_categories (org_id, store_id, name) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '{"th":"x"}') returning id::text$$);
select t_val(null, 'service_role', 'svc', $$insert into public.menu_items (org_id, store_id, category_id, name, prices, duration_min) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"นวด","en":"Massage"}', '{"base": 100000}', 60) returning id::text$$);
select t_rows(null, 'service_role', $$insert into public.menu_items (org_id, store_id, category_id, name, prices) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='cat'), '{"th":"ครีม"}', '{"base": 50000}')$$, 1, 'a product (no length) exists too');
create or replace function t_day(n integer) returns text language sql as $$ select ((now() at time zone 'Asia/Bangkok')::date + n)::text $$;
grant execute on function t_day(integer) to authenticated, service_role;

select t_val('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'tok', $$select (public.save_booking_settings((select v::uuid from t_out where k='store'), '{}') ->> 'token')$$);
update public.stores set module_overrides = '{"booking.online": true}' where name = 'Salon';
select t_rows(null, 'service_role', $$select 1 where not public.spa_advisor_enabled((select v::uuid from t_out where k='store'))$$, 1, 'booking is on but the advisor is off: no module, no sign-off');

-- ── tagging a service ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_spa_tags((select v::uuid from t_out where k='svc'), array['facial'])$$, '42501', 'a cashier cannot tag a service');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_spa_tags((select v::uuid from t_out where k='svc'), array['cure_cancer'])$$, '23514', 'only the closed list of tags is accepted');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_spa_tags((select v::uuid from t_out where k='svc'), array['facial','scrub','oil_massage','thai_massage','foot_massage','head_neck','aromatherapy'])$$, '23514', 'at most six tags on a service');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_spa_tags((select v::uuid from t_out where k='svc'), array['oil_massage','aromatherapy'])$$, 1, 'the manager tags the service');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.save_spa_tags((select id from public.menu_items where duration_min is null limit 1), array['facial'])$$, '22023', 'an item with no length is not a service');

-- ── the therapist's sign-off ──
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.confirm_spa_rules((select v::uuid from t_out where k='store'), 'Somchai')$$, '42501', 'only the owner records the sign-off');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.confirm_spa_rules((select v::uuid from t_out where k='store'), 'x')$$, '22023', 'the therapist''s name is needed');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.confirm_spa_rules((select v::uuid from t_out where k='store'), 'Somchai (therapist)')$$, 1, 'the owner records that a therapist has signed');
select t_rows(null, 'service_role', $$select 1 where not public.spa_advisor_enabled((select v::uuid from t_out where k='store'))$$, 1, 'a sign-off alone is not enough: the shop must also switch the module on');
update public.stores set module_overrides = '{"booking.online": true, "advisor.spa": true}' where name = 'Salon';
select t_rows(null, 'service_role', $$select 1 where public.spa_advisor_enabled((select v::uuid from t_out where k='store'))$$, 1, 'booking + module + sign-off: the advisor is on');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where entity_id = (select v from t_out where k='store') and action = 'settings.change' and (detail ->> 'spa_rules_signoff') = 'true'$$, 1, 'the sign-off is in the audit trail');

-- ── what the guest page may read ──
select t_val(null, 'service_role', 'info', $$select public.guest_spa_info((select v from t_out where k='tok'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='info' and (v::jsonb ->> 'enabled') = 'true' and jsonb_array_length(v::jsonb -> 'services') = 1 and (v::jsonb -> 'services' -> 0 -> 'tags') = '["oil_massage","aromatherapy"]'::jsonb$$, 1, 'the guest page gets the bookable services with their tags and nothing else');
select t_rows(null, 'service_role', $$select 1 where public.guest_spa_info('0123456789abcdef0123456789abcdef') is null$$, 1, 'an unknown link finds nothing');
select t_err(null, 'anon', $$select public.guest_spa_info((select v from t_out where k='tok'))$$, '42501', 'the browser cannot call it');

-- raising the rules version would void the sign-off: simulate an older sign-off
update public.stores set spa_rules_signoff = jsonb_set(spa_rules_signoff, '{version}', '0') where name = 'Salon';
select t_rows(null, 'service_role', $$select 1 where not public.spa_advisor_enabled((select v::uuid from t_out where k='store'))$$, 1, 'a sign-off of an older rules version no longer counts');
select t_rows(null, 'service_role', $$select 1 where (public.guest_spa_info((select v from t_out where k='tok')) ->> 'enabled') = 'false'$$, 1, 'and the guest page hides the advisor');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.confirm_spa_rules((select v::uuid from t_out where k='store'), null)$$, 1, 'the owner can withdraw the sign-off');
do $$ begin raise notice 'ALL SPA ADVISOR TESTS PASSED'; end $$;
