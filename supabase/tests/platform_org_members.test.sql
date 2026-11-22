-- Platform: move a member into an existing business (platform administrator only), with safeguards and a log.
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

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'platform@example.test', now()),   -- platform administrator
  ('00000000-0000-0000-0000-0000000000b2', 'mover@example.test', now()),      -- creates an accidental business, gets moved
  ('00000000-0000-0000-0000-0000000000c3', 'beta.owner@example.test', now()), -- owns a business that is NOT empty
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test', now()),    -- an ordinary user, not an administrator
  ('00000000-0000-0000-0000-0000000000e5', 'unconfirmed@example.test', null),
  ('00000000-0000-0000-0000-0000000000f6', 'owner.acme@example.test', now()), -- owner of the real business "Acme Co"
  ('00000000-0000-0000-0000-0000000000a7', 'cashier.beta@example.test', now()); -- a cashier in Beta
insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-0000000000a1');

select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select * from public.create_org('Acme Co','Acme Main','restaurant')$$, 1, 'the real business exists');
select t_val('00000000-0000-0000-0000-0000000000f6', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Acme Co'$$);
select t_val('00000000-0000-0000-0000-0000000000f6', 'authenticated', 'store1', $$select id::text from public.stores where name = 'Acme Main'$$);
select t_val('00000000-0000-0000-0000-0000000000f6', 'authenticated', 'store2', $$select public.create_store((select v::uuid from t_out where k='org'), 'Acme Beach', 'cafe')::text$$);
select t_rows(null, 'service_role', $$insert into public.customers (org_id, name, phone, member_code) values ((select v::uuid from t_out where k='org'), 'Anna', '0812345678', 'AAAAAAAA')$$, 1, 'Acme has a customer (so it is not empty)');
-- the accident: the same name typed on the create-shop screen makes ANOTHER business
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select * from public.create_org('Acme Co','Acme Main','restaurant')$$, 1, 'the mover creates a business of the same name');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.orgs where name = 'Acme Co') = 2$$, 1, 'two businesses of one name exist (a name is not a key)');
-- Beta: not empty, owned by c3; a cashier a7 works there
select t_rows('00000000-0000-0000-0000-0000000000c3', 'authenticated', $$select * from public.create_org('Beta Co','Beta Main','cafe')$$, 1, 'Beta exists');
select t_val('00000000-0000-0000-0000-0000000000c3', 'authenticated', 'beta', $$select id::text from public.orgs where name = 'Beta Co'$$);
select t_rows(null, 'service_role', $$insert into public.customers (org_id, name, phone, member_code) values ((select v::uuid from t_out where k='beta'), 'Ben', '0899999999', 'BBBBBBBB')$$, 1, 'Beta has a customer');
insert into public.staff (org_id, user_id, display_name, role_id)
select (select v::uuid from t_out where k='beta'), '00000000-0000-0000-0000-0000000000a7', 'Beta cashier', r.id from public.roles r where r.org_id = (select v::uuid from t_out where k='beta') and r.built_in = 'cashier';

-- ═══ who may use it ═══
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.platform_orgs_overview()$$, '42501', 'a non-administrator cannot list the businesses');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.platform_member_lookup('mover@example.test')$$, '42501', 'nor look a person up');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.platform_move_member('{}'::jsonb)$$, '42501', 'nor move anybody');
select t_err('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select public.platform_move_member('{}'::jsonb)$$, '42501', 'not even the owner of a business can move people between businesses this way');
select t_err(null, 'anon', $$select public.platform_orgs_overview()$$, '42501', 'nobody signed out');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_org_is_empty(gen_random_uuid())$$, '42501', 'the helper is not callable by the browser');

-- ═══ lookup and overview ═══
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_member_lookup('nonsense')$$, '22023', 'a bad address is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_member_lookup('nobody@example.test')$$, 'P0002', 'an unknown address is refused');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'look', $$select public.platform_member_lookup(' Mover@Example.test ')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o where o.k = 'look' and (o.v::jsonb ->> 'email') = 'mover@example.test' and jsonb_array_length(o.v::jsonb -> 'memberships') = 1 and (o.v::jsonb -> 'memberships' -> 0 ->> 'org_name') = 'Acme Co' and (o.v::jsonb -> 'memberships' -> 0 ->> 'role') = 'owner' and (o.v::jsonb ->> 'confirmed') = 'true'$$, 1, 'the lookup shows where the person works now (owner of their own Acme Co)');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'ov', $$select public.platform_orgs_overview()::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o where o.k = 'ov' and jsonb_array_length(o.v::jsonb -> 'orgs') = 3 and exists (select 1 from jsonb_array_elements(o.v::jsonb -> 'orgs') e where (e ->> 'id') = (select v from t_out where k = 'org') and (e ->> 'empty') = 'false' and jsonb_array_length(e -> 'stores') = 2)$$, 1, 'the overview lists three businesses; the real Acme is not empty and has two shops');

-- ═══ refusals ═══
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_move_member(jsonb_build_object('user_id','00000000-0000-0000-0000-0000000000b2','org_id',(select v from t_out where k='org'),'role','god'))$$, '22023', 'an unknown role is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_move_member(jsonb_build_object('user_id','00000000-0000-0000-0000-0000000000b2','org_id',gen_random_uuid(),'role','manager'))$$, 'P0002', 'an unknown business is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_move_member(jsonb_build_object('user_id',gen_random_uuid(),'org_id',(select v from t_out where k='org'),'role','manager'))$$, 'P0002', 'an unknown person is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_move_member(jsonb_build_object('user_id','00000000-0000-0000-0000-0000000000e5','org_id',(select v from t_out where k='org'),'role','manager'))$$, '55000', 'a person whose e-mail is not confirmed is refused');
select t_val(null, 'service_role', 'betastore', $$select id::text from public.stores where org_id = (select v::uuid from t_out where k='beta') limit 1$$);
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_move_member(jsonb_build_object('user_id','00000000-0000-0000-0000-0000000000b2','org_id',(select v from t_out where k='org'),'role','manager','store_id',(select v from t_out where k='betastore')))$$, '22023', 'a shop of another business is refused');
-- Beta's owner is the only owner of a business with a customer: moving them out must not leave Beta without an owner
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_move_member(jsonb_build_object('user_id','00000000-0000-0000-0000-0000000000c3','org_id',(select v from t_out where k='org'),'role','manager'))$$, '55000', 'the only owner of a business that is not empty cannot be moved out');
select t_rows(null, 'service_role', $$select 1 where not exists (select 1 from public.staff where org_id = (select v::uuid from t_out where k='org') and user_id = '00000000-0000-0000-0000-0000000000c3') and exists (select 1 from public.staff where org_id = (select v::uuid from t_out where k='beta') and user_id = '00000000-0000-0000-0000-0000000000c3' and active)$$, 1, 'the refused move changed nothing');

-- ═══ the move ═══
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'mv', $$select public.platform_move_member(jsonb_build_object('user_id','00000000-0000-0000-0000-0000000000b2','org_id',(select v from t_out where k='org'),'role','manager','store_id',(select v from t_out where k='store1')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o where o.k = 'mv' and jsonb_array_length(o.v::jsonb -> 'deleted') = 1 and (o.v::jsonb -> 'deleted' ->> 0) = 'Acme Co'$$, 1, 'the accidental empty business of the mover was deleted');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.orgs where name = 'Acme Co') = 1$$, 1, 'one Acme Co is left: the real one');
select t_rows(null, 'service_role', $$select 1 from public.staff s join public.roles r on r.id = s.role_id where s.org_id = (select v::uuid from t_out where k='org') and s.user_id = '00000000-0000-0000-0000-0000000000b2' and r.built_in = 'manager' and s.store_id = (select v::uuid from t_out where k='store1') and s.active$$, 1, 'the person is a manager of the real Acme, at one shop');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select 1 from public.stores where org_id = (select v::uuid from t_out where k='org') and id = (select v::uuid from t_out where k='store1')$$, 1, 'and can see that shop through the ordinary rules');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select 1 from public.stores where org_id = (select v::uuid from t_out where k='org') and id = (select v::uuid from t_out where k='store2')$$, 0, 'but not the other shop (the scope was one shop)');
-- again: already a member → the role and scope change, no second membership
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_move_member(jsonb_build_object('user_id','00000000-0000-0000-0000-0000000000b2','org_id',(select v from t_out where k='org'),'role','cashier'))$$, 1, 'moved again with another role and all shops');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.staff where org_id = (select v::uuid from t_out where k='org') and user_id = '00000000-0000-0000-0000-0000000000b2') = 1 and exists (select 1 from public.staff s join public.roles r on r.id = s.role_id where s.org_id = (select v::uuid from t_out where k='org') and s.user_id = '00000000-0000-0000-0000-0000000000b2' and r.built_in = 'cashier' and s.store_id is null)$$, 1, 'still one membership, now a cashier of all shops');

-- a person who is only a cashier elsewhere is deactivated there, not deleted; their old business stays
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'mv2', $$select public.platform_move_member(jsonb_build_object('user_id','00000000-0000-0000-0000-0000000000a7','org_id',(select v from t_out where k='org'),'role','waiter'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o where o.k = 'mv2' and jsonb_array_length(o.v::jsonb -> 'deleted') = 0 and (o.v::jsonb -> 'left' ->> 0) = 'Beta Co'$$, 1, 'the cashier left Beta (reported), nothing deleted');
select t_rows(null, 'service_role', $$select 1 from public.staff where org_id = (select v::uuid from t_out where k='beta') and user_id = '00000000-0000-0000-0000-0000000000a7' and not active$$, 1, 'their Beta membership is switched off, not erased');
select t_rows(null, 'service_role', $$select 1 where exists (select 1 from public.orgs where id = (select v::uuid from t_out where k='beta'))$$, 1, 'Beta is untouched');
-- leave_others = false keeps the other membership
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_move_member(jsonb_build_object('user_id','00000000-0000-0000-0000-0000000000a7','org_id',(select v from t_out where k='beta'),'role','cashier'))$$, 1, 'back to Beta');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_move_member(jsonb_build_object('user_id','00000000-0000-0000-0000-0000000000a7','org_id',(select v from t_out where k='org'),'role','waiter','leave_others',false))$$, 1, 'moved into Acme but asked to stay in Beta');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.staff where user_id = '00000000-0000-0000-0000-0000000000a7' and active) = 2$$, 1, 'active in both businesses');

-- ═══ the log ═══
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'list', $$select public.platform_admins_list()::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o where o.k = 'list' and exists (select 1 from jsonb_array_elements(o.v::jsonb -> 'log') e where (e ->> 'action') = 'member_move' and (e ->> 'target_email') = 'mover@example.test' and (e ->> 'detail') = 'Acme Co · manager · Acme Main') and exists (select 1 from jsonb_array_elements(o.v::jsonb -> 'log') e where (e ->> 'action') = 'org_delete' and (e ->> 'detail') = 'Acme Co' and (e ->> 'actor_email') = 'platform@example.test')$$, 1, 'the log has the move (with business, role and shop) and the deletion, with who did it');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.platform_admin_log where action = 'member_move') = 5 and (select count(*) from public.platform_admin_log where action = 'org_delete') = 1$$, 1, 'five moves and one deletion were logged (the refused ones left nothing)');
select t_rows(null, 'service_role', $$select 1 where exists (select 1 from public.audit_log where org_id = (select v::uuid from t_out where k='org') and action = 'staff.add')$$, 1, 'the business''s own audit trail also shows the person being added');

\echo ALL PLATFORM ORG MEMBERS TESTS PASSED
