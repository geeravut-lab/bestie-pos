-- LINE linking tables: server-only; one LINE account per Bestie account.
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
  ('00000000-0000-0000-0000-0000000000a1', 'a@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'b@example.test');
insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-0000000000b2');

select t_rows(null, 'service_role', $$insert into public.notification_channels (owner_id, channel, code_hash, code_expires_at) values ('00000000-0000-0000-0000-0000000000a1', 'line', 'hash', now() + interval '30 minutes')$$, 1, 'server starts a pending link');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.notification_channels$$, '42501', 'a user cannot read channels from the browser (no LINE userId, no code hash)');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.notification_channels set status = 'active'$$, '42501', 'a user cannot activate a link themselves');
select t_err(null, 'anon', $$select * from public.notification_channels$$, '42501', 'anon cannot read channels');
select t_err(null, 'service_role', $$insert into public.notification_channels (owner_id, channel) values ('00000000-0000-0000-0000-0000000000a1', 'line')$$, '23505', 'one row per user per channel');
select t_err(null, 'service_role', $$insert into public.notification_channels (owner_id, channel) values ('00000000-0000-0000-0000-0000000000a1', 'sms')$$, '23514', 'only known channels');
select t_rows(null, 'service_role', $$update public.notification_channels set address = 'Uline123', status = 'active', code_hash = null, verified_at = now() where owner_id = '00000000-0000-0000-0000-0000000000a1'$$, 1, 'server binds the LINE account');
select t_rows(null, 'service_role', $$insert into public.notification_channels (owner_id, channel, address, status) values ('00000000-0000-0000-0000-0000000000b2', 'line', 'Uline123', 'pending')$$, 1, 'a pending row may carry the same address');
select t_err(null, 'service_role', $$update public.notification_channels set status = 'active' where owner_id = '00000000-0000-0000-0000-0000000000b2'$$, '23505', 'one LINE account cannot be ACTIVE for two Bestie accounts');
delete from auth.users where id = '00000000-0000-0000-0000-0000000000a1'; -- the account is deleted (PDPA)
select t_rows(null, 'service_role', $$select 1 from public.notification_channels where owner_id = '00000000-0000-0000-0000-0000000000a1'$$, 0, 'the link is deleted with the user (PDPA)');

select t_rows(null, 'service_role', $$insert into public.message_log (owner_id, channel, kind, status) values ('00000000-0000-0000-0000-0000000000b2', 'line', 'test', 'sent')$$, 1, 'server logs a message');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select 1 from public.message_log$$, 1, 'platform admin reads the message log');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.message_log$$, 0, 'other users cannot');
select t_err(null, 'service_role', $$insert into public.message_log (channel, status) values ('line', 'maybe')$$, '23514', 'log status is sent or failed');

\echo ALL LINE TESTS PASSED
