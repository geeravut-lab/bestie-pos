-- Guest QR ordering: token is the only key, prices / options are computed by the database, replay-safe, rate-limited.
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
  ('00000000-0000-0000-0000-0000000000e5', 'stranger@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme Co','Acme','restaurant')$$, 1, 'owner creates a restaurant');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o
  join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Acme Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'cafe', $$select public.create_store((select org_id::text from public.stores where name='Acme')::uuid, 'Beach Cafe', 'cafe')::text$$);
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.seed_demo_menu((select v::uuid from t_out where k='store'))$$, 1, 'demo restaurant menu');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.seed_demo_menu((select v::uuid from t_out where k='cafe'))$$, 1, 'demo cafe menu');
select t_val(null, 'service_role', 'tok', $$select qr_token from public.dining_tables where store_id = (select v::uuid from t_out where k='store') and name = 'T1'$$);
select t_val(null, 'service_role', 'tok2', $$select qr_token from public.dining_tables where store_id = (select v::uuid from t_out where k='store') and name = 'T2'$$);
select t_val(null, 'service_role', 'padthai', $$select id::text from public.menu_items where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Pad Thai with prawns'$$);
select t_val(null, 'service_role', 'tomyum', $$select id::text from public.menu_items where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Tom yum goong'$$);
select t_val(null, 'service_role', 'egg', $$select id::text from public.modifier_options where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Fried egg'$$);
select t_val(null, 'service_role', 'mild', $$select id::text from public.modifier_options where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Medium'$$);
select t_val(null, 'service_role', 'hot', $$select id::text from public.modifier_options where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Very spicy'$$);
select t_val(null, 'service_role', 'latte', $$select id::text from public.menu_items where store_id = (select v::uuid from t_out where k='cafe') and name ->> 'en' = 'Latte'$$);

-- ── nobody but the server can call these ──
select t_err(null, 'anon', $$select public.guest_table('x')$$, '42501', 'anon cannot read a table by token');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.guest_menu((select v from t_out where k='tok'))$$, '42501', 'a signed-in user cannot either');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.guest_place_order('{}'::jsonb)$$, '42501', 'nor place guest orders');

-- ── reading ──
select t_rows(null, 'service_role', $$select 1 where public.guest_table('nope') is null$$, 1, 'unknown token gives nothing');
select t_rows(null, 'service_role', $$select 1 where public.guest_table((select v from t_out where k='tok')) ->> 'table_name' = 'T1'$$, 1, 'a token names its table');
select t_rows(null, 'service_role', $$select 1 where jsonb_array_length(public.guest_menu((select v from t_out where k='tok')) -> 'items') = 13 and jsonb_array_length(public.guest_menu((select v from t_out where k='tok')) -> 'categories') = 4$$, 1, 'the guest sees the restaurant menu: 13 items, 4 categories');

-- ── ordering ──
create or replace function t_order(tok text, cid text, lines text) returns jsonb language sql as $$
  select jsonb_build_object('token', tok, 'client_id', cid, 'lines', lines::jsonb)
$$;
grant execute on function t_order(text, text, text) to service_role;


update public.stores set qr_auto_send = true,
  printers = '[{"id":"hot","name":"Hot kitchen","kind":"network","paper":80,"bridge_url":"http://192.168.1.60:9101/print","stations":["kitchen"]},{"id":"usb1","name":"USB","kind":"usb","paper":80,"stations":["kitchen"]},{"id":"counter","name":"Counter","kind":"network","paper":80,"bridge_url":"http://192.168.1.61:9101/print"}]'::jsonb
 where id = (select v::uuid from t_out where k='store');
select t_val(null, 'service_role', 'o1', $$select public.guest_place_order(t_order((select v from t_out where k='tok'), '20000000-0000-4000-8000-000000000001',
  format('[{"item_id":"%s","quantity":2,"option_ids":["%s"],"note":"no peanuts"}]', (select v from t_out where k='padthai'), (select v from t_out where k='egg'))))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='o1' and (v::jsonb ->> 'status') = 'sent'$$, 1, 'auto-send: the guest line went to the kitchen');
select t_rows(null, 'service_role', $$select 1 from public.print_jobs where printer_id = 'hot' and station = 'kitchen' and order_number = 'QR001' and table_name = 'T1'
  and (lines -> 0 ->> 'quantity') = '2' and (lines -> 0 ->> 'note') = 'no peanuts' and (lines -> 0 -> 'modifiers' ->> 0) <> ''$$, 1, 'one ticket job for the kitchen network printer, with the line, note and option');
select t_rows(null, 'service_role', $$select 1 from public.print_jobs$$, 1, 'no job for a USB printer (belongs to a tablet), for a receipt printer, or for a station without lines');
select t_rows(null, 'service_role', $$select 1 from public.print_jobs where status = 'queued'$$, 1, 'it waits to be claimed');

-- a replayed order does not queue a second ticket
select t_val(null, 'service_role', 'o1b', $$select public.guest_place_order(t_order((select v from t_out where k='tok'), '20000000-0000-4000-8000-000000000001', '[{"item_id":"00000000-0000-0000-0000-000000000000","quantity":1}]'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.print_jobs$$, 1, 'a replay queues nothing more');

-- ── claiming ──
select t_err(null, 'anon', $$select public.claim_print_jobs((select v::uuid from t_out where k='store'), array['hot'])$$, '42501', 'anon cannot claim');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.claim_print_jobs((select v::uuid from t_out where k='store'), array['hot'])$$, '42501', 'a person from another business cannot claim');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'c1', $$select public.claim_print_jobs((select v::uuid from t_out where k='store'), array['hot'])::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='c1' and jsonb_array_length(v::jsonb) = 1 and (v::jsonb -> 0 ->> 'order_number') = 'QR001' and (v::jsonb -> 0 ->> 'station') = 'kitchen'$$, 1, 'a cashier tablet (payment.take) claims the ticket');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'c2', $$select public.claim_print_jobs((select v::uuid from t_out where k='store'), array['hot'])::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='c2' and v = '[]'$$, 1, 'a claimed job is not handed to a second screen');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'c3', $$select public.claim_print_jobs((select v::uuid from t_out where k='store'), array['other'])::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='c3' and v = '[]'$$, 1, 'a screen that serves another printer gets nothing');

-- a failed print goes back to the queue, three tries then it is failed; an unreported claim comes back after 60 seconds
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.report_print_job((select id from public.print_jobs limit 1), false)$$, 1, 'failure reported: back to the queue');
select t_rows(null, 'service_role', $$select 1 from public.print_jobs where status = 'queued' and attempts = 1$$, 1, 'queued again after 1 try');
update public.print_jobs set status = 'claimed', claimed_at = now() - interval '2 minutes', attempts = 1;
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'c4', $$select public.claim_print_jobs((select v::uuid from t_out where k='store'), array['hot'])::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='c4' and jsonb_array_length(v::jsonb) = 1$$, 1, 'a claim nobody reported is handed out again after 60 s');
select t_rows(null, 'service_role', $$select 1 from public.print_jobs where attempts = 2$$, 1, 'second try');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.report_print_job((select id from public.print_jobs limit 1), true)$$, 1, 'printed');
select t_rows(null, 'service_role', $$select 1 from public.print_jobs where status = 'printed' and printed_at is not null$$, 1, 'the job is done');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'c5', $$select public.claim_print_jobs((select v::uuid from t_out where k='store'), array['hot'])::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='c5' and v = '[]'$$, 1, 'a printed job is never printed again');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.report_print_job((select id from public.print_jobs limit 1), true)$$, '42501', 'a stranger cannot report on it');

-- stale tickets are not printed (30 minutes)
update public.print_jobs set status = 'queued', created_at = now() - interval '40 minutes', attempts = 0;
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'c6', $$select public.claim_print_jobs((select v::uuid from t_out where k='store'), array['hot'])::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='c6' and v = '[]'$$, 1, 'a ticket older than 30 minutes is not news');

-- tablet-sent lines (an update to sent) never queue a job; the internal functions are not callable from a browser
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.enqueue_print_jobs(gen_random_uuid(), now())$$, '42501', 'enqueue is internal');
do $$ begin raise notice 'ALL PRINT JOB TESTS PASSED'; end $$;
