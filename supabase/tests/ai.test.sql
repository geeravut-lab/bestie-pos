-- AI settings: platform-admin only; prompt history is insert-only; events are server-written.
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

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'owner@example.test');
insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-0000000000a1');

select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.ai_settings$$, 1, 'platform admin reads AI settings');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select 1 from public.ai_settings$$, 0, 'a shop owner cannot read AI settings');
select t_err(null, 'anon', $$select 1 from public.ai_settings$$, '42501', 'anon cannot read AI settings');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.ai_settings set route_overrides = '{"ask_shop":{"primary":"google"}}'$$, 1, 'platform admin changes the route');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$update public.ai_settings set route_overrides = '{}'$$, 0, 'a shop owner cannot change the route');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.ai_settings set route_overrides = '[1]'$$, '23514', 'route overrides must be an object');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.ai_settings (id) values (false)$$, '42501', 'the settings row cannot be duplicated');

select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.ai_prompt_versions (task, body, created_by) values ('ask_shop', 'Warm tone.', '00000000-0000-0000-0000-0000000000a1')$$, 1, 'platform admin adds a prompt version');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.ai_prompt_versions (task, body, created_by) values ('ask_shop', 'x', '00000000-0000-0000-0000-0000000000b2')$$, '42501', 'a version cannot be written in someone else''s name');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$insert into public.ai_prompt_versions (task, body, created_by) values ('ask_shop', 'x', auth.uid())$$, '42501', 'a shop owner cannot add prompt versions');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.ai_prompt_versions set body = 'changed'$$, '42501', 'history cannot be edited');
select t_err(null, 'service_role', $$delete from public.ai_prompt_versions$$, '42501', 'history cannot be deleted');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.ai_prompt_versions (task, body, created_by) values ('ask_shop', repeat('x', 1001), auth.uid())$$, '23514', 'additions are at most 1000 characters');

select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.ai_events (provider, task, status) values ('google', 'ask_shop', 'error')$$, '42501', 'even admins cannot write events from the browser');
select t_rows(null, 'service_role', $$insert into public.ai_events (provider, task, status, error_code) values ('google', 'ask_shop', 'fallback', '429')$$, 1, 'the server writes events');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.ai_events$$, 1, 'platform admin reads events');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select 1 from public.ai_events$$, 0, 'a shop owner cannot read events');
select t_err(null, 'service_role', $$insert into public.ai_events (provider, task, status) values ('google', 'x', 'success')$$, '23514', 'only fallbacks and errors are logged');

\echo ALL AI TESTS PASSED
