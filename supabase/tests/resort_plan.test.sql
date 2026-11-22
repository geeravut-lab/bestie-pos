-- A shop created with the resort profile starts on the resort plan (so the folio can be switched on); other profiles stay on pro.
\set ON_ERROR_STOP on
\set QUIET on
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
select * from public.create_org('Plan Co', 'Plan Cafe', 'cafe');
select public.create_store((select id from public.orgs where name = 'Plan Co'), 'Plan Resort', 'resort');
select public.create_store((select id from public.orgs where name = 'Plan Co'), 'Plan Tours', 'tours');
reset role;
do $$
begin
  if (select plan from public.stores where name = 'Plan Resort') is distinct from 'resort' then raise exception 'FAIL a resort shop did not get the resort plan'; end if;
  raise notice 'PASS a shop created with the resort profile starts on the resort plan';
  if (select plan from public.stores where name = 'Plan Cafe') is distinct from 'pro' then raise exception 'FAIL a cafe changed plan'; end if;
  if (select plan from public.stores where name = 'Plan Tours') is distinct from 'pro' then raise exception 'FAIL a tours shop changed plan'; end if;
  raise notice 'PASS other profiles stay on the pro plan';
end $$;
\echo ALL RESORT PLAN TESTS PASSED
