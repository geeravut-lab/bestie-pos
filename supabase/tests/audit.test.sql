-- Audit trail: switches, critical events, append-only, RLS, PII stripping, DB triggers.
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
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'other@example.test'),
  ('00000000-0000-0000-0000-0000000000c3', 'cashier@example.test');

select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme','Acme','cafe')$$, 1, 'owner creates org');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select * from public.create_org('Other','Other','cafe')$$, 1, 'other org exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000c3', 'Cashier', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Acme';

create temp table ids as select (select id from public.orgs where name = 'Acme') as org, (select id from public.stores where name = 'Acme') as store, (select id from public.orgs where name = 'Other') as org_b;
grant select on ids to authenticated;

-- the DB trigger on staff already logged the cashier being added (default settings: everything on)
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'staff.add' and source = 'db'$$, 3, 'DB trigger recorded staff additions (two owners via create_org + cashier)');

-- app writer
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.write_audit((select org from ids), (select store from ids), 'order.discount', 'order', 'o-1', '{"percent": 10}')$$, 1, 'member can write an audit event');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'order.discount' and detail = '{"percent": 10}' and actor_role = 'owner'$$, 1, 'event stored with actor role and clean detail');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select public.write_audit((select org from ids), null, 'order.discount')$$, '42501', 'non-member cannot write to another org');
select t_err('00000000-0000-0000-0000-0000000000c3', 'authenticated', $$select public.write_audit((select org_b from ids), null, 'order.discount')$$, '42501', 'cashier cannot write to an org they do not belong to');

-- PII hygiene
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.write_audit((select org from ids), null, 'settings.change', 'x', '1', ('{"customer_name":"Somchai","phone":"081","email":"a@b.c","note":"free text","ok_code":"E1","amount":5000,"nested":{"a":1},"long":"' || repeat('x', 300) || '"}')::jsonb)$$, 1, 'write with PII-looking keys');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'settings.change' and detail = '{"ok_code":"E1","amount":5000}'$$, 1, 'PII keys, nested objects and long values were stripped');

-- unknown events are ignored
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.write_audit((select org from ids), null, 'made.up.event')$$, 1, 'unknown event type is accepted but ignored');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'made.up.event'$$, 0, 'unknown event was not stored');

-- switches
select t_err('00000000-0000-0000-0000-0000000000c3', 'authenticated', $$select public.set_audit_settings((select org from ids), false, '{}')$$, '42501', 'cashier cannot change audit settings');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.set_audit_settings((select org from ids), true, array['order.void'])$$, '23514', 'critical events cannot be switched off');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.set_audit_settings((select org from ids), true, array['nope'])$$, '22023', 'unknown event types are rejected');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.set_audit_settings((select org from ids), true, array['order.discount'])$$, 1, 'owner unticks one event type');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'audit.settings_change'$$, 1, 'the settings change itself was recorded');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.write_audit((select org from ids), null, 'order.discount', 'order', 'o-2')$$, 1, 'write (unticked type)');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where entity_id = 'o-2'$$, 0, 'unticked event type is NOT recorded');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.write_audit((select org from ids), null, 'order.reopen', 'order', 'o-3')$$, 1, 'write (still ticked type)');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where entity_id = 'o-3'$$, 1, 'ticked event type is recorded');

-- master switch off: ordinary events stop, critical events continue
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.set_audit_settings((select org from ids), false, '{}')$$, 1, 'owner switches auditing off');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.write_audit((select org from ids), null, 'order.reopen', 'order', 'o-4')$$, 1, 'write ordinary event while off');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where entity_id = 'o-4'$$, 0, 'ordinary events are not recorded while off');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.write_audit((select org from ids), null, 'payment.refund', 'payment', 'p-1', '{"amount":10000}')$$, 1, 'write critical event while off');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where entity_id = 'p-1'$$, 1, 'critical events are ALWAYS recorded');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.set_audit_settings((select org from ids), true, '{}')$$, 1, 'owner switches auditing back on');

-- DB triggers
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.stores set module_overrides = '{"kds": false}' where name = 'Acme'$$, 1, 'owner toggles a module');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'module.toggle' and source = 'db'$$, 1, 'module toggle recorded by the DB trigger');
select t_rows(null, 'service_role', $$update public.orgs set legal_sign_off = '{"cryptoTopup": true}' where name = 'Acme'$$, 1, 'platform records crypto sign-off');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'org.legal_signoff_change' and detail = '{"crypto_topup": true}'$$, 1, 'legal sign-off change recorded');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.staff set role_id = (select id from public.roles where built_in = 'manager' and org_id = staff.org_id) where display_name = 'Cashier'$$, 1, 'owner changes a role');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'staff.role_change'$$, 1, 'role change recorded by the DB trigger');

-- append-only
select t_err(null, 'service_role', $$update public.audit_log set action = 'x'$$, '42501', 'audit_log cannot be updated (even by service_role)');
select t_err(null, 'service_role', $$delete from public.audit_log$$, '42501', 'audit_log cannot be deleted from');
select t_err(null, 'service_role', $$truncate public.audit_log$$, '42501', 'audit_log cannot be truncated');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.audit_log (org_id, action) values ((select org from ids), 'order.void')$$, '42501', 'clients cannot insert directly');

-- reading (d4 is a plain cashier; c3 was promoted to manager above)
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d4', 'cashier2@example.test');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier2', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Acme';
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.audit_log$$, 13, 'owner reads the org log') ;
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select 1 from public.audit_log where org_id = (select org from ids)$$, 0, 'other org cannot read this org log');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.audit_log$$, 0, 'cashier has no audit.view');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.audit_settings$$, 1, 'owner reads the audit settings');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.audit_settings$$, 0, 'cashier cannot read the audit settings');
select t_rows('00000000-0000-0000-0000-0000000000c3', 'authenticated', $$select 1 from public.audit_event_types$$, 36, 'everyone signed in can read the event catalogue');

-- ── retention: only the scheduled purge may delete, and only rows older than the retention ──
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.audit_purge()$$, '42501', 'a person cannot run the purge');
select t_err(null, 'anon', $$select public.audit_purge()$$, '42501', 'anon cannot run the purge');
select t_err(null, 'service_role', $$delete from public.audit_log$$, '42501', 'a plain delete is still refused after the purge function exists');
select t_err(null, 'service_role', $$update public.audit_retention set years = 2$$, '23514', 'retention below 4 years is refused');
-- age two rows past the retention by writing them with an old timestamp (as the migration owner, bypassing the guard once)
do $$
declare before_n bigint; n integer;
begin
  select count(*) into before_n from public.audit_log;
  perform set_config('bestie.audit_purge', 'on', true);
  insert into public.audit_log (org_id, action, entity, detail, source, created_at)
  values ((select id from public.orgs limit 1), 'settings.change', 'x', '{}', 'db', now() - interval '6 years'),
         ((select id from public.orgs limit 1), 'settings.change', 'x', '{}', 'db', now() - interval '4 years 6 months');
  perform set_config('bestie.audit_purge', 'off', true);
  n := public.audit_purge();
  if n <> 1 then raise exception 'FAIL the purge removed % rows, expected 1 (only the 6-year-old one)', n; end if;
  if (select count(*) from public.audit_log) <> before_n + 1 then raise exception 'FAIL recent rows must stay'; end if;
  raise notice 'PASS the purge removes only rows older than the retention (5 years) and keeps everything newer';
end $$;
select t_err(null, 'service_role', $$delete from public.audit_log$$, '42501', 'and the flag does not leak: deleting is refused again');
\echo ALL AUDIT TESTS PASSED
