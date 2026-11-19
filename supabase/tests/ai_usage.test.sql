-- Online payments: attempts, provider confirmation, review cases, server-numbered receipts, internal functions locked.
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
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test'),
  ('00000000-0000-0000-0000-0000000000f6', 'admin@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme Co','Acme','restaurant')$$, 1, 'owner creates a restaurant');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other','Other','cafe')$$, 1, 'a second org exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Acme Co';
insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-0000000000f6');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Acme Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000e5', 'authenticated', 'org2', $$select id::text from public.orgs where name = 'Other'$$);

-- the server writes usage (never from the browser)
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.log_ai_usage('{}'::jsonb)$$, '42501', 'the browser cannot write usage');
select t_rows(null, 'service_role', $$select public.log_ai_usage(jsonb_build_object('store_id', (select v from t_out where k='store'), 'task', 'guest_menu_qa', 'provider', 'anthropic', 'model', 'claude-haiku-5-5', 'input_tokens', 300, 'output_tokens', 60, 'source', 'guest'))$$, 1, 'a guest call is logged against the shop''s org');
select t_rows(null, 'service_role', $$select public.log_ai_usage(jsonb_build_object('store_id', (select v from t_out where k='store'), 'task', 'menu_tags', 'provider', 'google', 'model', 'gemini-flash-lite-latest', 'input_tokens', 100, 'output_tokens', 40))$$, 1, 'a staff call too');
select t_rows(null, 'service_role', $$select public.log_ai_usage(jsonb_build_object('task', 'summary', 'provider', 'x', 'model', 'm', 'input_tokens', 1, 'output_tokens', 1))$$, 1, 'a call with no shop is kept without an org');
select t_rows(null, 'service_role', $$select public.log_ai_usage('{"task":"BAD TASK"}'::jsonb)$$, 1, 'a malformed row never raises (usage logging must not break an answer)');
select t_rows(null, 'service_role', $$select 1 from public.ai_usage_log where org_id = (select v::uuid from t_out where k='org') and input_tokens in (300, 100)$$, 2, 'two rows belong to the org');

-- who reads what
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.ai_usage_log$$, 2, 'the owner reads only their own org''s usage');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select * from public.ai_usage_log$$, 0, 'a cashier (no report.view) reads nothing');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.ai_usage_log$$, 0, 'another org reads nothing');
select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select * from public.ai_usage_log$$, 3, 'the platform admin reads everything');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$delete from public.ai_usage_log$$, '42501', 'nobody deletes usage from the browser');

-- the summary
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'sum', $$select public.ai_usage_summary((select v::uuid from t_out where k='org'), (now() at time zone 'Asia/Bangkok')::date, (now() at time zone 'Asia/Bangkok')::date)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='sum' and jsonb_array_length((v::jsonb) -> 'rows') = 2 and ((v::jsonb) ->> 'usd_thb')::numeric = 36$$, 1, 'the owner''s summary has the two tasks and the USD→THB rate');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.ai_usage_summary(null, current_date, current_date)$$, '42501', 'an owner cannot ask for everybody''s usage');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.ai_usage_summary((select v::uuid from t_out where k='org'), current_date, current_date)$$, '42501', 'nor for another org');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.ai_usage_summary((select v::uuid from t_out where k='org'), current_date, current_date)$$, '42501', 'a cashier cannot');
select t_val('00000000-0000-0000-0000-0000000000f6', 'authenticated', 'all', $$select public.ai_usage_summary(null, current_date - 30, current_date + 1)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='all' and jsonb_array_length((v::jsonb) -> 'rows') = 3$$, 1, 'the platform admin sees every org');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.ai_usage_summary((select v::uuid from t_out where k='org'), current_date, current_date - 1)$$, '22023', 'a backwards range is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.ai_usage_summary((select v::uuid from t_out where k='org'), current_date - 400, current_date)$$, '22023', 'so is a range over a year');
\echo ALL AI USAGE TESTS PASSED
