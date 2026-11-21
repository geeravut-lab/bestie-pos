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









insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Cafe Co','Cafe Nok','cafe')$$, 1, 'owner creates a cafe');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other Co','Other','cafe')$$, 1, 'another business exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Cafe Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Cafe Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Cafe Nok'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Till A', 'cashier', 'POS-1') returning id::text$$);
-- a closed shift (inserted directly: the shift functions are tested elsewhere)
select t_val(null, 'service_role', 'sh', $$insert into public.shifts (org_id, store_id, device_id, opened_at, opening_cash, status, closed_at, counted_cash, expected_cash, variance)
  values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='dev'), now() - interval '8 hours', 100000, 'closed', now() - interval '1 hour', 480050, 482550, -2500) returning id::text$$);
select t_val(null, 'service_role', 'sh_open', $$insert into public.shifts (org_id, store_id, device_id, opened_at, opening_cash, status)
  values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='dev'), now(), 0, 'open') returning id::text$$);

-- ── explain this shift: gates ──
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 where public.shift_figures((select v::uuid from t_out where k='sh')) is null$$, 1, 'with the assistant module off nothing is handed out');
update public.stores set module_overrides = '{"ai.assistant": true}' where name = 'Cafe Nok';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'fig', $$select public.shift_figures((select v::uuid from t_out where k='sh'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='fig' and (v::jsonb ->> 'variance') = '-2500' and (v::jsonb ->> 'expected_cash') = '482550' and (v::jsonb ->> 'shop') = 'Cafe Nok' and (v::jsonb ->> 'bills') = '0'$$, 1, 'the owner gets the shift’s own figures');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.shift_figures((select v::uuid from t_out where k='sh')) is null$$, 1, 'a cashier (no report.view) gets nothing');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 where public.shift_figures((select v::uuid from t_out where k='sh')) is null$$, 1, 'another business gets nothing');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 where public.shift_figures((select v::uuid from t_out where k='sh_open')) is null$$, 1, 'a shift that is still open is not explained');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 where public.shift_figures(gen_random_uuid()) is null$$, 1, 'an unknown shift gives nothing');
select t_err(null, 'anon', $$select public.shift_figures((select v::uuid from t_out where k='sh'))$$, '42501', 'not callable without signing in');

-- ── translation for staff ──
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.translate_context((select v::uuid from t_out where k='store')) is null$$, 1, 'off by default: nobody may translate');
update public.stores set module_overrides = '{"ai.assistant": true, "ai.translate": true}' where name = 'Cafe Nok';
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where (public.translate_context((select v::uuid from t_out where k='store')) ->> 'org_id') = (select v from t_out where k='org')$$, 1, 'with the module on the front desk may translate');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 where public.translate_context((select v::uuid from t_out where k='store')) is null$$, 1, 'a person of another business may not');
update public.stores set plan = 'basic' where name = 'Cafe Nok';
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 where public.translate_context((select v::uuid from t_out where k='store')) is null$$, 1, 'a Basic plan does not include it');
update public.stores set plan = 'pro' where name = 'Cafe Nok';
select t_err(null, 'service_role', $$update public.stores set module_overrides = '{"ai.translated": true}' where name = 'Cafe Nok'$$, '23514', 'unknown module ids are still refused');
do $$ begin raise notice 'ALL SHIFT SUMMARY + TRANSLATE TESTS PASSED'; end $$;
