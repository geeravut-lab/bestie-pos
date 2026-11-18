-- Billing & points options: who may change them, shape guards, audit.
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
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme','Acme','restaurant')$$, 1, 'owner creates a restaurant');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier';

select t_rows(null, 'service_role', $$select 1 from public.stores where bill_options = '{}' and rounding = '{}'$$, 1, 'defaults are empty (= code defaults)');

-- stores
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.stores set bill_options = '{"serviceChargeVat":"not_taxable","serviceChargeBase":"before_discounts"}', rounding = '{"cash":"nearest-25"}'$$, 1, 'owner picks billing options and cash rounding');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.stores set bill_options = '{}'$$, 0, 'a cashier cannot change billing options');
select t_err(null, 'service_role', $$update public.stores set bill_options = '{"serviceChargeVat":"sometimes"}'$$, '23514', 'unknown option value is refused');
select t_err(null, 'service_role', $$update public.stores set bill_options = '{"evil":"x"}'$$, '23514', 'unknown option key is refused');
select t_err(null, 'service_role', $$update public.stores set rounding = '{"cash":"nearest-7"}'$$, '23514', 'unknown rounding rule is refused');
select t_err(null, 'service_role', $$update public.stores set rounding = '{"bitcoin":"none"}'$$, '23514', 'unknown tender is refused');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'settings.change' and detail = '{"area":"billing"}' and source = 'db'$$, 1, 'the billing change was audited');

-- points rule
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.orgs set points_rule = '{"earnSatangPerPoint":5000,"maxRedeemBps":3000,"creditEarnsPoints":false}'$$, 1, 'owner sets the points rule');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$update public.orgs set points_rule = '{}'$$, 0, 'a cashier cannot change the points rule');
select t_err(null, 'service_role', $$update public.orgs set points_rule = '{"earnSatangPerPoint":0}'$$, '23514', 'earn rate below the minimum is refused');
select t_err(null, 'service_role', $$update public.orgs set points_rule = '{"maxRedeemBps":20000}'$$, '23514', 'redeem cap above 100 % is refused');
select t_err(null, 'service_role', $$update public.orgs set points_rule = '{"earnSatangPerPoint":2500.5}'$$, '23514', 'fractions are refused');
select t_err(null, 'service_role', $$update public.orgs set points_rule = '{"creditEarnsPoints":"yes"}'$$, '23514', 'flag must be a boolean');
select t_err(null, 'service_role', $$update public.orgs set points_rule = '{"purchasable":true}'$$, '23514', 'unknown keys (e.g. anything that would make points purchasable) are refused');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'settings.change' and detail = '{"area":"points"}'$$, 1, 'the points rule change was audited');

\echo ALL BILLING TESTS PASSED
