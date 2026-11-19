-- LINE diagnostics: the webhook log is server-only, keeps outcomes (no text), prunes old rows, and summarises 24 hours.
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





select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.log_line_webhook('ok', 1)$$, '42501', 'the browser cannot write the webhook log');
select t_err(null, 'anon', $$select public.line_webhook_summary()$$, '42501', 'nor read the summary');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.line_webhook_log$$, '42501', 'nor the table');
select t_rows(null, 'service_role', $$select public.log_line_webhook('ok', 1)$$, 1, 'the server logs a call');
select t_rows(null, 'service_role', $$select public.log_line_webhook('ok', 2)$$, 1, 'and another');
select t_rows(null, 'service_role', $$select public.log_line_webhook('bad_signature', 1)$$, 1, 'and a bad signature');
select t_rows(null, 'service_role', $$select public.log_line_webhook('a-very-long-outcome-that-goes-on-and-on-and-on-forever-and-ever', 99999)$$, 1, 'an over-long outcome is cut and the count is capped');
select t_rows(null, 'service_role', $$select 1 from public.line_webhook_log where length(outcome) <= 40 and events <= 1000 and outcome like 'a-very-long%'$$, 1, 'to what the table accepts');
select t_rows(null, 'service_role', $$select 1 where (public.line_webhook_summary() ->> 'ok')::int = 2 and (public.line_webhook_summary() ->> 'bad_signature')::int = 1$$, 1, 'the summary groups by outcome');
update public.line_webhook_log set at = now() - interval '2 days' where outcome = 'bad_signature';
select t_rows(null, 'service_role', $$select 1 where not (public.line_webhook_summary() ? 'bad_signature')$$, 1, 'the summary covers 24 hours only');
update public.line_webhook_log set at = now() - interval '8 days' where outcome = 'bad_signature';
select t_rows(null, 'service_role', $$select public.log_line_webhook('ok', 1)$$, 1, 'logging again');
select t_rows(null, 'service_role', $$select 1 where not exists (select 1 from public.line_webhook_log where at < now() - interval '7 days')$$, 1, 'prunes what is older than 7 days');
select t_rows(null, 'service_role', $$select 1 where public.line_pending_links() = 0$$, 1, 'no pending link codes yet');
do $$ begin raise notice 'ALL LINE DIAGNOSTICS TESTS PASSED'; end $$;
