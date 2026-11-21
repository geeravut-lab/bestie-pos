-- Demo data helpers (schema `demo`). Everything here only READS or calls the app's own functions as a real user; nothing bypasses a rule
-- except where a comment says so (setup rows the app has no screen for, such as the account itself).
create schema if not exists demo;
grant usage on schema demo to authenticated;

create or replace function demo.uid(p_email text) returns uuid language sql stable as $$ select id from auth.users where email = p_email $$;
create or replace function demo.org() returns uuid language sql stable as $$ select id from public.orgs where name = coalesce(nullif(current_setting('demo.org_name', true), ''), '[DEMO] Island Group') $$;
create or replace function demo.store(p_name text) returns uuid language sql stable as $$ select id from public.stores where org_id = demo.org() and name = p_name and deleted_at is null $$;
create or replace function demo.staff(p_email text) returns uuid language sql stable as $$ select id from public.staff where org_id = demo.org() and user_id = demo.uid(p_email) $$;
create or replace function demo.device(p_store text, p_name text) returns uuid language sql stable as $$ select id from public.devices where store_id = demo.store(p_store) and name = p_name $$;
create or replace function demo.item(p_store text, p_name text) returns uuid language sql stable as $$
  select id from public.menu_items where store_id = demo.store(p_store) and deleted_at is null and (name ->> 'th' = p_name or name ->> 'en' = p_name) limit 1 $$;
create or replace function demo.cust(p_phone text) returns uuid language sql stable as $$ select id from public.customers where org_id = demo.org() and phone = p_phone $$;

-- run one statement as a signed-in person (RLS and the app's permission checks apply); returns the first column of the first row
create or replace function demo.val(p_email text, p_q text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claim.sub', demo.uid(p_email)::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', demo.uid(p_email), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute p_q into r;
  exception when others then
    execute 'reset role';
    raise;
  end;
  execute 'reset role';
  return r;
end $$;
-- the same for a statement without a result
create or replace function demo.run(p_email text, p_q text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', demo.uid(p_email)::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', demo.uid(p_email), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute p_q;
  exception when others then
    execute 'reset role';
    raise;
  end;
  execute 'reset role';
end $$;
-- the guest's phone / the server: the service role
create or replace function demo.svc(p_q text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  execute 'set local role service_role';
  begin
    execute p_q into r;
  exception when others then
    execute 'reset role';
    raise;
  end;
  execute 'reset role';
  return r;
end $$;
grant execute on all functions in schema demo to authenticated;

-- an account the app has no screen for (the login itself). Works on the hosted project (full auth.users) and on the local stub.
create or replace function demo.make_user(p_email text, p_name text, p_password text) returns uuid language plpgsql as $$
declare v uuid;
begin
  select id into v from auth.users where email = p_email;
  if v is not null then return v; end if;
  v := gen_random_uuid();
  if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'encrypted_password') then
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                            created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change,
                            email_change_token_current, phone_change, phone_change_token, reauthentication_token, is_sso_user, is_anonymous)
    values ('00000000-0000-0000-0000-000000000000', v, 'authenticated', 'authenticated', p_email,
            extensions.crypt(p_password, extensions.gen_salt('bf', 10)), now(),
            '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('full_name', p_name, 'demo', true),
            now(), now(), '', '', '', '', '', '', '', '', false, false);
    if exists (select 1 from information_schema.tables where table_schema = 'auth' and table_name = 'identities') then
      insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (v::text, v, jsonb_build_object('sub', v::text, 'email', p_email, 'email_verified', true, 'phone_verified', false), 'email', now(), now(), now());
    end if;
  else
    insert into auth.users (id, email, raw_user_meta_data) values (v, p_email, jsonb_build_object('full_name', p_name, 'demo', true));
  end if;
  return v;
end $$;
