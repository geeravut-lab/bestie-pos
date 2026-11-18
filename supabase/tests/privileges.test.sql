-- Function privileges: internal functions are not callable from the browser roles.
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

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'u@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme','Acme','cafe')$$, 1, 'signed-in users can still create an org');
create table ids as select (select id from public.orgs limit 1) as org;
grant select on ids to anon, authenticated, service_role;

-- the audit log cannot be polluted from the browser
select t_err(null, 'anon', $$select public.audit_record((select org from ids), null, 'payment.refund', 'x', 'y', '{}', 'app')$$, '42501', 'anon cannot call audit_record');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.audit_record((select org from ids), null, 'payment.refund', 'x', 'y', '{}', 'app')$$, '42501', 'signed-in users cannot call audit_record either');
select t_err(null, 'anon', $$select public.live_ping('platform')$$, '42501', 'anon cannot fire pings');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.live_ping('platform')$$, '42501', 'signed-in users cannot fire pings');
select t_err(null, 'anon', $$select public.handle_new_user()$$, '42501', 'anon cannot call handle_new_user');
select t_err(null, 'anon', $$select public.audit_clean_detail('{}')$$, '42501', 'anon cannot call internal helpers');

-- app RPCs: signed-in only
select t_err(null, 'anon', $$select * from public.create_org('X','X','cafe')$$, '42501', 'anon cannot call create_org');
select t_err(null, 'anon', $$select public.write_audit((select org from ids), null, 'order.reopen')$$, '42501', 'anon cannot call write_audit');
select t_err(null, 'anon', $$select public.set_audit_settings((select org from ids), false, '{}')$$, '42501', 'anon cannot call set_audit_settings');
select t_err(null, 'anon', $$select public.is_platform_admin()$$, '42501', 'anon cannot call RLS helpers');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.write_audit((select org from ids), null, 'order.reopen', 'order', 'o-1')$$, 1, 'signed-in members can still write audit events through the RPC');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.audit_log$$, 2, 'and still read the log (policies still evaluate the helpers)');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.set_audit_settings((select org from ids), true, array['order.discount'])$$, 1, 'owners can still change audit settings');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.stores set name = 'Acme 2'$$, 1, 'DB triggers still fire for signed-in users');

-- the server keeps working
select t_rows(null, 'service_role', $$select public.audit_record((select org from ids), null, 'payment.refund', 'x', 'y', '{}', 'app')$$, 1, 'service_role can still call audit_record');
select t_rows(null, 'service_role', $$select public.live_ping('platform')$$, 1, 'service_role can still ping');

-- future functions get no grants by default
create function public.future_fn() returns int language sql as $$ select 1 $$;
select t_err(null, 'anon', $$select public.future_fn()$$, '42501', 'a NEW function is not executable by anon by default');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.future_fn()$$, '42501', 'nor by authenticated until a migration grants it');

\echo ALL PRIVILEGE TESTS PASSED
