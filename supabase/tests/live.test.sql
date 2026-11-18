-- Live sync: who may listen to which topic, and that data changes emit content-free pings.
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
create or replace function t_bool(uid uuid, topic text, expected boolean, label text) returns void language plpgsql as $$
declare got boolean;
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  got := public.live_can_listen(topic);
  if got is distinct from expected then raise exception 'FAIL % — expected %, got %', label, expected, got; end if;
  raise notice 'PASS %', label;
end $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'other@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme','Acme','cafe')$$, 1, 'owner creates org A');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select * from public.create_org('Other','Other','cafe')$$, 1, 'owner creates org B');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Acme';

create table ids as select (select id from public.orgs where name = 'Acme') as org_a, (select id from public.orgs where name = 'Other') as org_b,
  (select id from public.stores where name = 'Acme') as store_a, (select id from public.stores where name = 'Other') as store_b;
grant select on ids to authenticated, service_role;

-- ── who may listen ──
select t_bool('00000000-0000-0000-0000-0000000000a1', 'org:' || (select org_a from ids), true, 'member listens to own org');
select t_bool('00000000-0000-0000-0000-0000000000a1', 'org:' || (select org_b from ids), false, 'member cannot listen to another org');
select t_bool('00000000-0000-0000-0000-0000000000a1', 'store:' || (select store_a from ids), true, 'member listens to own store');
select t_bool('00000000-0000-0000-0000-0000000000a1', 'store:' || (select store_b from ids), false, 'member cannot listen to another org store');
select t_bool('00000000-0000-0000-0000-0000000000d4', 'audit:' || (select org_a from ids), false, 'cashier cannot listen to audit pings');
select t_bool('00000000-0000-0000-0000-0000000000a1', 'audit:' || (select org_a from ids), true, 'owner listens to audit pings');
select t_bool('00000000-0000-0000-0000-0000000000a1', 'u:00000000-0000-0000-0000-0000000000a1', true, 'user listens to own topic');
select t_bool('00000000-0000-0000-0000-0000000000a1', 'u:00000000-0000-0000-0000-0000000000b2', false, 'user cannot listen to another user topic');
select t_bool('00000000-0000-0000-0000-0000000000a1', 'platform', true, 'everyone signed in may hear platform changes');
select t_bool('00000000-0000-0000-0000-0000000000a1', 'admin', false, 'admin topic is for platform admins only');
select t_bool('00000000-0000-0000-0000-0000000000a1', 'org:not-a-uuid', false, 'malformed topic is refused, not an error');
select t_bool('00000000-0000-0000-0000-0000000000a1', 'whatever:1', false, 'unknown topic kinds are refused');
select t_bool('00000000-0000-0000-0000-0000000000a1', 'platform:extra', false, 'platform topic must match exactly');
select t_bool(null, 'platform', false, 'anonymous cannot listen');
insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-0000000000b2');
select t_bool('00000000-0000-0000-0000-0000000000b2', 'admin', true, 'platform admin listens to admin topic');

-- the policy on realtime.messages applies the same rule
select t_rows('00000000-0000-0000-0000-0000000000a1', 'service_role', $$insert into realtime.messages (topic) values ('org:' || (select org_a from ids)), ('org:' || (select org_b from ids)), ('store:' || (select store_a from ids))$$, 3, 'seed messages');
create or replace function t_msgs(uid uuid, p_topic text, expected bigint, label text) returns void language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('realtime.topic', p_topic, true);
  set local role authenticated;
  select count(*) into n from realtime.messages m where m.topic = realtime.topic();
  reset role;
  if n <> expected then raise exception 'FAIL % — expected %, got %', label, expected, n; end if;
  raise notice 'PASS %', label;
end $$;
select t_msgs('00000000-0000-0000-0000-0000000000a1', 'org:' || (select org_a from ids), 1, 'RLS lets the owner see own-org broadcast');
select t_msgs('00000000-0000-0000-0000-0000000000a1', 'org:' || (select org_b from ids), 0, 'RLS hides another org broadcast');

-- ── pings are emitted, empty, and only on private channels ──
delete from realtime.sent;
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.stores set name = 'Acme Cafe' where name = 'Acme'$$, 1, 'owner renames the store');
select t_rows(null, 'service_role', $$select 1 from realtime.sent where topic = 'org:' || (select org_a from ids) and event = 'ping' and payload = '{}' and is_private$$, 1, 'store change pings the org topic (empty payload, private)');
select t_rows(null, 'service_role', $$select 1 from realtime.sent where topic = 'store:' || (select store_a from ids)$$, 1, 'store change pings the store topic');
select t_rows(null, 'service_role', $$select 1 from realtime.sent where topic like '%' || (select org_b from ids)::text$$, 0, 'nothing is sent to the other org');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.write_audit((select org_a from ids), null, 'order.reopen', 'order', 'o-1')$$, 1, 'an audit event is written');
select t_rows(null, 'service_role', $$select 1 from realtime.sent where topic = 'audit:' || (select org_a from ids)$$, 1, 'audit insert pings the audit topic');
select t_rows(null, 'service_role', $$update public.platform_settings set brand = '{"name_en":"X"}'$$, 1, 'platform settings change');
select t_rows(null, 'service_role', $$select 1 from realtime.sent where topic = 'platform'$$, 1, 'platform change pings the platform topic');
select t_rows(null, 'service_role', $$select 1 from realtime.sent where payload <> '{}'$$, 0, 'no ping ever carries data');

-- a failing broadcast must not break the business write
create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language plpgsql as $$ begin raise exception 'realtime is down'; end $$;
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.stores set name = 'Acme Cafe 2' where name = 'Acme Cafe'$$, 1, 'a broken Realtime does not break the update');

\echo ALL LIVE TESTS PASSED
