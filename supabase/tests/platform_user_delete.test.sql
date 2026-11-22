-- Platform: delete a user account (platform administrator only), with safeguards and a log.
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
  ('00000000-0000-0000-0000-0000000000a1', 'platform@example.test', now()),   -- platform administrator (acts)
  ('00000000-0000-0000-0000-0000000000a2', 'platform2@example.test', now()),  -- another platform administrator
  ('00000000-0000-0000-0000-0000000000b2', 'oops@example.test', now()),       -- made an accidental empty business
  ('00000000-0000-0000-0000-0000000000c3', 'beta.owner@example.test', now()), -- only owner of a business that holds data
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test', now()),    -- an ordinary user, not an administrator
  ('00000000-0000-0000-0000-0000000000a7', 'cashier.beta@example.test', now()), -- cashier in Beta, wrote a prompt version
  ('00000000-0000-0000-0000-0000000000e8', 'nobody@example.test', now());     -- no business at all
insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2');

select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select * from public.create_org('Oops Co','Oops Main','cafe')$$, 1, 'the accident: an empty business');
select t_rows('00000000-0000-0000-0000-0000000000c3', 'authenticated', $$select * from public.create_org('Beta Co','Beta Main','cafe')$$, 1, 'Beta exists');
select t_val('00000000-0000-0000-0000-0000000000c3', 'authenticated', 'beta', $$select id::text from public.orgs where name = 'Beta Co'$$);
select t_rows(null, 'service_role', $$insert into public.customers (org_id, name, phone, member_code) values ((select v::uuid from t_out where k='beta'), 'Ben', '0899999999', 'BBBBBBBB')$$, 1, 'Beta holds a customer (so it is not empty)');
insert into public.staff (org_id, user_id, display_name, role_id)
select (select v::uuid from t_out where k='beta'), '00000000-0000-0000-0000-0000000000a7', 'Beta cashier', r.id from public.roles r where r.org_id = (select v::uuid from t_out where k='beta') and r.built_in = 'cashier';
insert into public.ai_prompt_versions (task, body, created_by) values ('menu_translate', 'be brief', '00000000-0000-0000-0000-0000000000a7');

-- ═══ who may ═══
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.platform_user_delete('00000000-0000-0000-0000-0000000000e8')$$, '42501', 'a non-administrator cannot delete an account');
select t_err('00000000-0000-0000-0000-0000000000c3', 'authenticated', $$select public.platform_user_delete('00000000-0000-0000-0000-0000000000e8')$$, '42501', 'not even a business owner');
select t_err(null, 'anon', $$select public.platform_user_delete('00000000-0000-0000-0000-0000000000e8')$$, '42501', 'nobody signed out');

-- ═══ refusals ═══
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_user_delete(gen_random_uuid())$$, 'P0002', 'an unknown account is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_user_delete('00000000-0000-0000-0000-0000000000a1')$$, '55000', 'you cannot delete yourself');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_user_delete('00000000-0000-0000-0000-0000000000a2')$$, '23503', 'another platform administrator must lose the right first');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.platform_user_delete('00000000-0000-0000-0000-0000000000c3')$$, '55006', 'the only owner of a business that holds data cannot be deleted');
select t_rows(null, 'postgres', $$select 1 where exists (select 1 from auth.users where id = '00000000-0000-0000-0000-0000000000c3') and exists (select 1 from public.orgs where id = (select v::uuid from t_out where k='beta'))$$, 1, 'the refused deletions changed nothing');

-- ═══ lookup warnings ═══
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'look', $$select public.platform_member_lookup('beta.owner@example.test')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o where o.k = 'look' and (o.v::jsonb ->> 'is_admin') = 'false' and (o.v::jsonb -> 'memberships' -> 0 ->> 'sole_owner') = 'true' and (o.v::jsonb -> 'memberships' -> 0 ->> 'empty') = 'false'$$, 1, 'the lookup says: only owner of a business that is not empty');

-- ═══ deletions that work ═══
-- a person with no business
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'd1', $$select public.platform_user_delete('00000000-0000-0000-0000-0000000000e8')::text$$);
select t_rows(null, 'postgres', $$select 1 where not exists (select 1 from auth.users where id = '00000000-0000-0000-0000-0000000000e8')$$, 1, 'an account with no business is deleted');
-- the accidental owner of an empty business: the business goes with them
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'd2', $$select public.platform_user_delete('00000000-0000-0000-0000-0000000000b2')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o where o.k = 'd2' and (o.v::jsonb -> 'deleted_orgs' ->> 0) = 'Oops Co'$$, 1, 'the answer names the empty business that was deleted');
select t_rows(null, 'postgres', $$select 1 where not exists (select 1 from auth.users where id = '00000000-0000-0000-0000-0000000000b2') and not exists (select 1 from public.orgs where name = 'Oops Co')$$, 1, 'the account and its empty business are gone');
-- a cashier in a business that holds data: the membership goes, the business stays; the prompt history keeps its row without an author
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'd3', $$select public.platform_user_delete('00000000-0000-0000-0000-0000000000a7')::text$$);
select t_rows(null, 'postgres', $$select 1 where not exists (select 1 from auth.users where id = '00000000-0000-0000-0000-0000000000a7') and not exists (select 1 from public.staff where user_id = '00000000-0000-0000-0000-0000000000a7') and exists (select 1 from public.orgs where id = (select v::uuid from t_out where k='beta'))$$, 1, 'the cashier is gone, Beta stays');
select t_rows(null, 'service_role', $$select 1 where exists (select 1 from public.ai_prompt_versions where body = 'be brief' and created_by is null)$$, 1, 'the insert-only prompt history lets go of the author only');
select t_err(null, 'service_role', $$update public.ai_prompt_versions set body = 'changed' where body = 'be brief'$$, '42501', 'and is still insert-only for anything else');

-- ═══ the log ═══
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.platform_admin_log where action = 'user_delete') = 3 and exists (select 1 from public.platform_admin_log where action = 'user_delete' and target_email = 'oops@example.test' and actor_email = 'platform@example.test' and detail like '%Oops Co%')$$, 1, 'three deletions logged with who did it (refused ones left nothing)');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'list', $$select public.platform_admins_list()::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out o where o.k = 'list' and exists (select 1 from jsonb_array_elements(o.v::jsonb -> 'log') e where (e ->> 'action') = 'user_delete')$$, 1, 'the platform page shows the deletions');

\echo ALL PLATFORM USER DELETE TESTS PASSED
