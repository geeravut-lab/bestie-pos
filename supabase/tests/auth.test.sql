-- Aivora SSO links: server-only table; fresh database per file (run-local.sh).
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

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000f6', 'aivora+u-123@bestie.example', '{"display_name":"Line User"}')
  on conflict do nothing;

select t_rows(null, 'service_role', $$insert into public.aivora_links (aivora_user_id, user_id) values ('hub-user-123', '00000000-0000-0000-0000-0000000000f6')$$, 1, 'server can link a hub user');
select t_err(null, 'service_role', $$insert into public.aivora_links (aivora_user_id, user_id) values ('hub-user-123', '00000000-0000-0000-0000-0000000000f6')$$, '23505', 'a hub user links only once');
select t_err(null, 'service_role', $$insert into public.aivora_links (aivora_user_id, user_id) values ('hub-user-999', '00000000-0000-0000-0000-0000000000f6')$$, '23505', 'a Supabase user links to only one hub user');
select t_err('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select * from public.aivora_links$$, '42501', 'signed-in users cannot read links');
select t_err('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$insert into public.aivora_links (aivora_user_id, user_id) values ('x', auth.uid())$$, '42501', 'signed-in users cannot write links');
select t_err(null, 'anon', $$select * from public.aivora_links$$, '42501', 'anon cannot read links');
select t_rows(null, 'service_role', $$select 1 from public.profiles where user_id = '00000000-0000-0000-0000-0000000000f6' and display_name = 'Line User'$$, 1, 'SSO-created users get a profile (synthetic aivora+ e-mail is accepted)');
-- An SSO user has no role until an owner adds them: nothing in the data model grants one from login.
select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select 1 from public.staff$$, 0, 'a fresh SSO user has no staff role / org access');
select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select * from public.create_org('LINE Shop','LINE Shop','cafe')$$, 1, 'a fresh SSO user can create their own shop (becomes its owner)');
select t_rows('00000000-0000-0000-0000-0000000000f6', 'authenticated', $$select 1 from public.staff$$, 1, 'and then sees only their own staff row');

\echo ALL AUTH TESTS PASSED
