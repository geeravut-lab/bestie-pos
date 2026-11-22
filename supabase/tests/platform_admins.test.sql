-- Platform administrators: add / remove from the app, with safeguards (no self-removal, never the last, confirmed e-mail only, log, tell the others).
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
  ('00000000-0000-0000-0000-0000000000a1', 'admin1@example.test', now()),
  ('00000000-0000-0000-0000-0000000000b2', 'Second.Admin@Example.test', now()),
  ('00000000-0000-0000-0000-0000000000c3', 'third@example.test', now()),
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test', now()),
  ('00000000-0000-0000-0000-0000000000e5', 'unconfirmed@example.test', null);
insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-0000000000a1');

-- ═══ who may touch it ═══
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.platform_admins_list()$$, '42501', 'a cashier cannot read the administrators');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.platform_admin_add('third@example.test')$$, '42501', 'a cashier cannot add an administrator');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.platform_admin_remove('00000000-0000-0000-0000-0000000000a1')$$, '42501', 'a cashier cannot remove an administrator');
select t_err(null, 'anon', $$select public.platform_admin_add('third@example.test')$$, '42501', 'nobody signed out can add one');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-0000000000d4')$$, '42501', 'the table cannot be written by a signed-in browser (cannot make oneself an administrator)');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.platform_admins$$, '42501', 'not even an administrator can read the table directly');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.platform_admin_log$$, '42501', 'nor the log table');

-- ═══ adding ═══
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_admin_add('not an address')$$, '22023', 'a bad address is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_admin_add('')$$, '22023', 'an empty address is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_admin_add('nobody@example.test')$$, 'P0002', 'an e-mail without an account is refused (no account is created)');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_admin_add('unconfirmed@example.test')$$, '55000', 'an account whose e-mail is not confirmed is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_admin_add('admin1@example.test')$$, '23505', 'adding somebody who already is one is refused');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_admin_add('  Second.Admin@Example.test ')$$, 1, 'the administrator adds an existing confirmed account (letter case and spaces do not matter)');
select t_rows(null, 'service_role', $$select 1 from public.platform_admins where user_id = '00000000-0000-0000-0000-0000000000b2' and added_by = '00000000-0000-0000-0000-0000000000a1'$$, 1, 'it records who added them');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.platform_admins_list()$$, 1, 'the new administrator can use the platform pages at once');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'list', $$select public.platform_admins_list()::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o where o.k = 'list' and jsonb_array_length(o.v::jsonb -> 'admins') = 2 and jsonb_array_length(o.v::jsonb -> 'log') = 1 and (o.v::jsonb -> 'log' -> 0 ->> 'action') = 'add' and (o.v::jsonb -> 'log' -> 0 ->> 'target_email') = 'second.admin@example.test' and (o.v::jsonb -> 'admins' -> 1 ->> 'added_by_email') = 'admin1@example.test' and (o.v::jsonb -> 'admins' -> 0 ->> 'is_me') = 'true'$$, 1, 'the list shows two administrators, who added whom and one log line');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.app_notifications where user_id = '00000000-0000-0000-0000-0000000000a1' and kind = 'platform.admin_added') = 0 and (select count(*) from public.app_notifications where user_id = '00000000-0000-0000-0000-0000000000b2') = 0$$, 1, 'the one who did it and the one added are not told (nobody else exists yet)');

-- a third administrator: the second one is told
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_admin_add('third@example.test')$$, 1, 'a third administrator');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.app_notifications where user_id = '00000000-0000-0000-0000-0000000000b2' and kind = 'platform.admin_added') = 1 and (select count(*) from public.app_notifications where user_id = '00000000-0000-0000-0000-0000000000a1') = 0 and (select count(*) from public.app_notifications where user_id = '00000000-0000-0000-0000-0000000000c3') = 0$$, 1, 'the other administrator is told, not the actor and not the new one');
select t_rows(null, 'service_role', $$select 1 from public.app_notifications where user_id = '00000000-0000-0000-0000-0000000000b2' and body not like '%@%' and title <> '' and href = '/admin/platform-admins'$$, 1, 'the notice has a link to the page and no e-mail address in the text');

-- ═══ removing ═══
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_admin_remove('00000000-0000-0000-0000-0000000000a1')$$, '55000', 'nobody removes themselves');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_admin_remove('00000000-0000-0000-0000-0000000000d4')$$, 'P0002', 'removing somebody who is not an administrator is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_admin_remove(null)$$, 'P0002', 'removing nobody is refused');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_admin_remove('00000000-0000-0000-0000-0000000000c3')$$, 1, 'an administrator removes another');
select t_rows(null, 'service_role', $$select 1 where not exists (select 1 from public.platform_admins where user_id = '00000000-0000-0000-0000-0000000000c3')$$, 1, 'the third is no longer an administrator');
select t_err('00000000-0000-0000-0000-0000000000c3', 'authenticated', $$select public.platform_admins_list()$$, '42501', 'the removed one loses the platform pages at once');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.app_notifications where user_id = '00000000-0000-0000-0000-0000000000b2' and kind = 'platform.admin_removed') = 1$$, 1, 'the remaining administrator is told about the removal');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_admin_remove('00000000-0000-0000-0000-0000000000b2')$$, 1, 'down to one administrator');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_admin_remove('00000000-0000-0000-0000-0000000000a1')$$, '55000', 'the last administrator cannot be removed (not even by themselves)');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.platform_admins) = 1$$, 1, 'one administrator is left');

-- ═══ the log ═══
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.platform_admin_log) = 4 and (select count(*) from public.platform_admin_log where action = 'add') = 2 and (select count(*) from public.platform_admin_log where action = 'remove') = 2$$, 1, 'four log lines: two adds, two removes');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'list2', $$select public.platform_admins_list()::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o where o.k = 'list2' and jsonb_array_length(o.v::jsonb -> 'admins') = 1 and jsonb_array_length(o.v::jsonb -> 'log') = 4 and (o.v::jsonb -> 'log' -> 0 ->> 'action') = 'remove'$$, 1, 'the list: one administrator, newest log line first');
select t_err(null, 'service_role', $$update public.platform_admin_log set action = 'add'$$, '42501', 'the log cannot be edited');
select t_err(null, 'service_role', $$delete from public.platform_admin_log$$, '42501', 'the log cannot be deleted from');
-- an account that acted and is deleted later: the log line stays and the deletion is not blocked
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f6', 'gone@example.test');
insert into public.platform_admin_log (action, actor_id, actor_email) values ('add', '00000000-0000-0000-0000-0000000000f6', 'gone@example.test');
delete from auth.users where id = '00000000-0000-0000-0000-0000000000f6';
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.platform_admin_log where actor_email = 'gone@example.test') = 1$$, 1, 'a log line of a deleted account stays (deleting the account is not blocked by the log)');

\echo ALL PLATFORM ADMINS TESTS PASSED
