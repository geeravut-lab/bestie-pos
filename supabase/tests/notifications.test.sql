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
  ('00000000-0000-0000-0000-0000000000c9', 'waiter@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme Co','Acme','restaurant')$$, 1, 'owner creates a restaurant');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, u.id, u.n, r.id from public.orgs o
  join (values ('00000000-0000-0000-0000-0000000000d4'::uuid, 'Cashier', 'cashier'),
               ('00000000-0000-0000-0000-0000000000c9'::uuid, 'Waiter', 'waiter')) as u(id, n, b) on true
  join public.roles r on r.org_id = o.id and r.built_in = u.b
 where o.name = 'Acme Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select id::text from public.orgs where name = 'Acme Co'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Counter', 'cashier') returning id::text$$);
select t_val('00000000-0000-0000-0000-0000000000c9', 'authenticated', 'waiter_staff', $$select id::text from public.staff where display_name = 'Waiter'$$);

-- the owner linked LINE; the waiter did not
insert into public.notification_channels (owner_id, channel, address, status, verified_at)
values ('00000000-0000-0000-0000-0000000000a1', 'line', 'Uowner', 'active', now());

-- two bills: A001 (open, will be paid online), A002 (the waiter's, kitchen)
insert into public.orders (id, org_id, store_id, number, business_date, channel, opened_by) values
  ('10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A001', (now() at time zone 'Asia/Bangkok')::date, 'takeaway', null),
  ('10000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'A002', (now() at time zone 'Asia/Bangkok')::date, 'dine-in', (select v::uuid from t_out where k='waiter_staff'));
insert into public.order_lines (id, org_id, store_id, order_id, name, unit_price, quantity, station, status, sent_at) values
  ('20000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', '{"th":"ผัดไทย"}', 9000, 2, 'kitchen', 'sent', now()),
  ('20000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', '{"th":"ต้มยำ"}', 12000, 1, 'kitchen', 'sent', now()),
  ('20000000-0000-4000-8000-000000000003', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', '{"th":"ชา"}', 3000, 1, 'bar', 'sent', now());

-- ── a PromptPay payment arrives ────────────────────────────────────────────
insert into public.payment_attempts (id, org_id, store_id, order_id, device_id, tender, amount, snapshot, status) values
  ('30000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', (select v::uuid from t_out where k='dev'), 'promptpay', 18000, '{}', 'pending');
do $$ begin
  if (select count(*) from public.app_notifications) <> 0 then raise exception 'FAIL a pending payment tells nobody'; end if;
  raise notice 'PASS a pending payment tells nobody';
end $$;
update public.payment_attempts set status = 'succeeded' where id = '30000000-0000-4000-8000-000000000001';
do $$ begin
  if (select count(*) from public.app_notifications where user_id = '00000000-0000-0000-0000-0000000000a1' and kind = 'payment.paid' and title like '%180.00%') <> 1 then raise exception 'FAIL owner gets the paid notice'; end if;
  raise notice 'PASS the owner is told about the payment (baht formatted)';
  if (select count(*) from public.app_notifications where user_id in ('00000000-0000-0000-0000-0000000000c9','00000000-0000-0000-0000-0000000000d4')) <> 0 then raise exception 'FAIL waiter / cashier must not get money notices'; end if;
  raise notice 'PASS waiter and cashier are not told about money';
  if (select count(*) from public.notification_queue where user_id = '00000000-0000-0000-0000-0000000000a1' and status = 'queued' and not urgent) <> 1 then raise exception 'FAIL LINE queue row'; end if;
  raise notice 'PASS a LINE message is queued for the linked owner';
  if (select body from public.app_notifications where kind = 'payment.paid') not like '%A001%' then raise exception 'FAIL body names the bill'; end if;
  raise notice 'PASS the body names the bill';
end $$;
-- the same status written again tells nobody twice
update public.payment_attempts set status = 'succeeded', error = 'again' where id = '30000000-0000-4000-8000-000000000001';
select public.notify_managers((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'),
  jsonb_build_object('kind','payment.paid','dedupe','paid:30000000-0000-4000-8000-000000000001','title',jsonb_build_object('th','x')));
do $$ begin
  if (select count(*) from public.app_notifications where kind = 'payment.paid') <> 1 then raise exception 'FAIL dedupe'; end if;
  raise notice 'PASS the same event is never announced twice (dedupe key)';
end $$;

-- ── a payment that needs review is urgent ─────────────────────────────────
update public.orders set status = 'open' where id = '10000000-0000-4000-8000-000000000002';
insert into public.payment_attempts (id, org_id, store_id, order_id, device_id, tender, amount, snapshot, status) values
  ('30000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000002', (select v::uuid from t_out where k='dev'), 'gateway', 15000, '{}', 'pending');
update public.payment_attempts set status = 'needs_review' where id = '30000000-0000-4000-8000-000000000002';
do $$ begin
  if (select count(*) from public.notification_queue where kind = 'payment.review' and urgent) <> 1 then raise exception 'FAIL review is urgent'; end if;
  raise notice 'PASS a payment needing review is queued as urgent';
end $$;

-- ── order ready → the waiter who opened the bill ───────────────────────────
update public.order_lines set status = 'ready' where id = '20000000-0000-4000-8000-000000000002';
do $$ begin
  if (select count(*) from public.app_notifications where kind = 'order.ready') <> 0 then raise exception 'FAIL not all lines ready yet'; end if;
  raise notice 'PASS no notice while part of the bill is still cooking';
end $$;
update public.order_lines set status = 'ready' where id = '20000000-0000-4000-8000-000000000003';
do $$ begin
  if (select count(*) from public.app_notifications where kind = 'order.ready' and user_id = '00000000-0000-0000-0000-0000000000c9') <> 1 then raise exception 'FAIL waiter told'; end if;
  raise notice 'PASS the waiter is told when the whole bill is ready';
  if (select count(*) from public.notification_queue where kind = 'order.ready') <> 0 then raise exception 'FAIL no LINE linked'; end if;
  raise notice 'PASS no LINE message for a person who did not link LINE';
end $$;

-- ── a shift closes with a cash difference ──────────────────────────────────
insert into public.shifts (org_id, store_id, device_id, opened_at, opening_cash, status, closed_at, counted_cash, expected_cash, variance)
values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='dev'), now() - interval '8 hours', 100000, 'open', null, null, null, null);
update public.shifts set status = 'closed', closed_at = now(), counted_cash = 95000, expected_cash = 100000, variance = -5000;
do $$ begin
  if (select count(*) from public.app_notifications where kind = 'shift.variance' and title like '%50.00%') <> 1 then raise exception 'FAIL shift variance notice'; end if;
  raise notice 'PASS the owner is told about a cash difference';
end $$;

-- ── LINE preferences: switched off = in-app only ──────────────────────────
insert into public.notification_prefs (user_id, line_transactional) values ('00000000-0000-0000-0000-0000000000a1', false);
select public.notify_user(jsonb_build_object('user_id','00000000-0000-0000-0000-0000000000a1','kind','test','dedupe','t1','title',jsonb_build_object('th','ทดสอบ','en','Test')));
do $$ begin
  if (select count(*) from public.app_notifications where kind = 'test') <> 1 then raise exception 'FAIL inbox still written'; end if;
  if (select count(*) from public.notification_queue where kind = 'test') <> 0 then raise exception 'FAIL LINE respects opt-out'; end if;
  raise notice 'PASS opting out of LINE keeps the in-app inbox but sends nothing to LINE';
end $$;
-- reminders are opt-IN
update public.notification_prefs set line_transactional = true where user_id = '00000000-0000-0000-0000-0000000000a1';
select public.notify_user(jsonb_build_object('user_id','00000000-0000-0000-0000-0000000000a1','kind','rem','category','reminder','dedupe','r1','title',jsonb_build_object('th','เตือน')));
do $$ begin
  if (select count(*) from public.notification_queue where kind = 'rem') <> 0 then raise exception 'FAIL reminders are opt-in'; end if;
  raise notice 'PASS reminders reach LINE only when the person opted in';
end $$;
-- bad input never raises
do $$ begin
  if public.notify_user('{"user_id":"not-a-uuid"}'::jsonb) then raise exception 'FAIL bad input'; end if;
  if public.notify_user(jsonb_build_object('user_id','00000000-0000-0000-0000-0000000000a1','kind','x','title',jsonb_build_object('th','')))  then raise exception 'FAIL empty title'; end if;
  raise notice 'PASS a broken notice returns false instead of raising';
end $$;
-- an external link is dropped
select public.notify_user(jsonb_build_object('user_id','00000000-0000-0000-0000-0000000000a1','kind','lnk','dedupe','l1','href','https://evil.test/x','title',jsonb_build_object('th','ลิงก์')));
do $$ begin
  if (select href from public.app_notifications where kind = 'lnk') is not null then raise exception 'FAIL external href'; end if;
  raise notice 'PASS only links inside our own site are kept';
end $$;

-- ── daily summary ──────────────────────────────────────────────────────────
update public.orders set status = 'paid', closed_at = now() where id = '10000000-0000-4000-8000-000000000001';
insert into public.receipts (org_id, store_id, order_id, number, issued_at, seller_name, branch_code, vat_registered, vat_bps, service_bps, price_mode,
  subtotal, service_charge, vat, net_before_vat, total, rounding, payable)
values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), '10000000-0000-4000-8000-000000000001', 'A+000001', now(), 'Acme Co', '00000', false, 0, 0, 'inclusive',
  18000, 0, 0, 18000, 18000, 0, 18000);
do $$ declare n integer; begin
  n := public.notify_daily_summary((now() at time zone 'Asia/Bangkok')::date);
  if n < 1 then raise exception 'FAIL summary written'; end if;
  if (select body from public.app_notifications where kind = 'daily.summary') not like '%ผัดไทย%' then raise exception 'FAIL top seller'; end if;
  raise notice 'PASS the daily summary names sales, bills and the top seller';
  if public.notify_daily_summary((now() at time zone 'Asia/Bangkok')::date) <> 0 then raise exception 'FAIL summary twice'; end if;
  raise notice 'PASS running the summary again tells nobody twice';
end $$;

-- ── who can see what ───────────────────────────────────────────────────────
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.app_notifications$$, (select count(*) from public.app_notifications where user_id = '00000000-0000-0000-0000-0000000000a1'), 'the owner reads only their own inbox');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select * from public.app_notifications$$, 0, 'the cashier sees nothing of the owner''s inbox');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.app_notifications set read_at = now()$$, (select count(*) from public.app_notifications where user_id = '00000000-0000-0000-0000-0000000000a1'), 'a person can mark their own notices read');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.app_notifications set title = 'hacked'$$, '42501', 'only read_at can be changed');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.notification_queue$$, '42501', 'the LINE queue is server-only');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.notification_settings$$, 0, 'the cap settings are invisible to everybody but the platform admin');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.notify_user('{"user_id":"00000000-0000-0000-0000-0000000000a1","title":{"th":"x"}}'::jsonb)$$, '42501', 'the browser cannot write a notice');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.notify_daily_summary(current_date)$$, '42501', 'the browser cannot run the summary');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.notification_prefs$$, 1, 'a person reads their own LINE preferences');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.notification_prefs (user_id, line_reminders) values ('00000000-0000-0000-0000-0000000000d4', true)$$, 1, 'a person sets their own preferences');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$insert into public.notification_prefs (user_id) values ('00000000-0000-0000-0000-0000000000a1')$$, '42501', 'but not somebody else''s');

-- ── delivery: claim / report / cap / halt ──────────────────────────────────
delete from public.notification_queue;
update public.notification_channels set status = 'active' where owner_id = '00000000-0000-0000-0000-0000000000a1';
update public.notification_settings set line_monthly_cap = 5, line_reserve = 2, halted_until = null;
insert into public.notification_queue (user_id, kind, title, body, urgent, created_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'k1', 'n1', 'b', false, now() - interval '5 minutes'),
  ('00000000-0000-0000-0000-0000000000a1', 'k2', 'n2', 'b', false, now() - interval '4 minutes'),
  ('00000000-0000-0000-0000-0000000000a1', 'k3', 'n3', 'b', false, now() - interval '3 minutes'),
  ('00000000-0000-0000-0000-0000000000a1', 'k4', 'n4', 'b', false, now() - interval '2 minutes'),
  ('00000000-0000-0000-0000-0000000000a1', 'u1', 'urgent', 'b', true,  now() - interval '1 minutes'),
  ('00000000-0000-0000-0000-0000000000a1', 'old', 'stale', 'b', false, now() - interval '2 days');
do $$ declare r record; n integer := 0; first_title text; begin
  select title into first_title from public.notify_claim(20) limit 1;
  if first_title <> 'urgent' then raise exception 'FAIL urgent goes first, got %', first_title; end if;
  raise notice 'PASS urgent messages are handed out first';
end $$;
do $$ begin
  if (select count(*) from public.notification_queue where status = 'skipped' and last_error = 'stale') <> 1 then raise exception 'FAIL stale'; end if;
  raise notice 'PASS a non-urgent notice older than a day is skipped, never sent late';
  -- cap 5, reserve 2: normal ones may use 3 slots, so of 4 normal + 1 urgent we got urgent + 3 normal
  if (select count(*) from public.notification_queue where attempts = 1) <> 4 then raise exception 'FAIL cap: % claimed', (select count(*) from public.notification_queue where attempts = 1); end if;
  raise notice 'PASS the monthly cap keeps a reserve: 1 urgent + 3 normal handed out, 1 normal waits';
end $$;
-- the same call a second later hands out nothing (tried less than a minute ago)
do $$ begin
  if (select count(*) from public.notify_claim(20)) <> 0 then raise exception 'FAIL not before a minute passes'; end if;
  raise notice 'PASS a message just handed out is not handed out twice';
end $$;
select public.notify_report(id, 'sent') from public.notification_queue where attempts = 1;
do $$ begin
  if (select count(*) from public.notification_queue where status = 'sent') <> 4 then raise exception 'FAIL sent'; end if;
  if (select count(*) from public.message_log where kind in ('k1','k2','k3','u1') and status = 'sent') <> 4 then raise exception 'FAIL log'; end if;
  raise notice 'PASS sent messages are recorded and logged';
end $$;
-- 4 sent of 5: the normal one is held back by the reserve, an urgent one may still use it
update public.notification_queue set last_try_at = now() - interval '5 minutes' where status = 'queued';
do $$ begin
  if (select count(*) from public.notify_claim(20)) <> 0 then raise exception 'FAIL reserve held for urgent'; end if;
  raise notice 'PASS with the reserve left, ordinary messages wait for next month';
end $$;
insert into public.notification_queue (user_id, kind, title, body, urgent) values ('00000000-0000-0000-0000-0000000000a1', 'u2', 'urgent 2', 'b', true);
do $$ begin
  if (select count(*) from public.notify_claim(20) where urgent) <> 1 then raise exception 'FAIL urgent uses reserve'; end if;
  raise notice 'PASS an urgent message may use the reserve';
end $$;
-- a rejected token halts everything for 6 hours
select public.notify_report(id, 'auth_failed') from public.notification_queue where kind = 'u2';
do $$ begin
  if (select halted_until from public.notification_settings) is null then raise exception 'FAIL halted'; end if;
  if (select attempts from public.notification_queue where kind = 'u2') <> 0 then raise exception 'FAIL attempt not counted against the message'; end if;
  update public.notification_settings set line_monthly_cap = 100;
  update public.notification_queue set last_try_at = null where kind = 'u2';
  if (select count(*) from public.notify_claim(20)) <> 0 then raise exception 'FAIL halt'; end if;
  raise notice 'PASS a rejected LINE token halts delivery and does not blame the message';
end $$;
update public.notification_settings set halted_until = null;
-- retries: 3 attempts, then failed
update public.notification_queue set status = 'queued', attempts = 2, last_try_at = null where kind = 'u2';
select public.notify_report(id, 'retry') from public.notification_queue where kind = 'u2';
do $$ begin
  if (select status from public.notification_queue where kind = 'u2') <> 'queued' then raise exception 'FAIL attempts < 3 may retry'; end if;
  update public.notification_queue set attempts = 3 where kind = 'u2';
  perform public.notify_report((select id from public.notification_queue where kind = 'u2'), 'retry');
  if (select status from public.notification_queue where kind = 'u2') <> 'failed' then raise exception 'FAIL after 3 attempts it fails'; end if;
  raise notice 'PASS a message is tried 3 times, then marked failed';
end $$;
-- blocked: the channel is stopped
insert into public.notification_queue (user_id, kind, title, body) values ('00000000-0000-0000-0000-0000000000a1', 'bl', 'x', 'b');
select public.notify_report(id, 'blocked') from public.notification_queue where kind = 'bl';
do $$ begin
  if (select status from public.notification_channels where owner_id = '00000000-0000-0000-0000-0000000000a1') <> 'stopped' then raise exception 'FAIL stopped'; end if;
  raise notice 'PASS a recipient who blocked us is not messaged again';
end $$;
-- housekeeping removes only old finished rows
update public.notification_queue set created_at = now() - interval '90 days' where kind = 'k1';
do $$ begin
  if public.notify_housekeeping() < 1 then raise exception 'FAIL housekeeping'; end if;
  if (select count(*) from public.notification_queue where kind = 'k1') <> 0 then raise exception 'FAIL old gone'; end if;
  if (select count(*) from public.notification_queue where kind = 'k2') <> 1 then raise exception 'FAIL recent kept'; end if;
  raise notice 'PASS housekeeping removes only old finished queue rows';
end $$;
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.notify_claim(5)$$, '42501', 'the browser cannot claim the queue');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.notify_report(gen_random_uuid(), 'sent')$$, '42501', 'the browser cannot report a delivery');

-- ── the platform admin's cap settings ──
insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-0000000000a1');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.notify_usage()$$, 1, 'the platform admin reads the LINE usage');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.notify_usage()$$, '42501', 'nobody else can');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.notification_settings set line_monthly_cap = 500, line_reserve = 50$$, 1, 'the platform admin changes the cap and the reserve');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.notification_settings set line_monthly_cap = 1$$, 0, 'a cashier changes nothing');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.notification_settings set line_reserve = 900$$, '23514', 'a reserve above the cap is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.notification_settings set id = false$$, '42501', 'no other column can be changed from the browser');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.notification_settings set halted_until = null, halted_reason = null$$, 1, 'a halt can be lifted by hand');

do $$ begin raise notice 'ALL NOTIFICATION TESTS PASSED'; end $$;
