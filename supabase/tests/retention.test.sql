-- migration 64: retention (health forms 24 months, unused passes 36 months).
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






create or replace function t_leg_cash(id text, amount bigint, tendered bigint) returns jsonb language sql as $$
  select jsonb_build_object('id', id, 'tender', 'cash', 'amount', amount, 'tendered', tendered, 'change', tendered - amount) $$;
grant execute on function t_leg_cash(text, bigint, bigint) to authenticated, service_role;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'ownerA@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Alpha Co','Alpha Spa','spa')$$, 1, 'A exists');
select t_val(null, 'service_role', 'orgA', $$select id::text from public.orgs where name = 'Alpha Co'$$);
select t_val(null, 'service_role', 'stA', $$select id::text from public.stores where name = 'Alpha Spa'$$);
insert into public.customers (org_id, name, phone, member_code, consent) select o.id, n, p, c, false from public.orgs o, (values ('Old Liu','0811111111','AAAA1111'), ('New Liu','0822222222','BBBB2222'), ('Busy Liu','0833333333','CCCC3333')) v(n,p,c) where o.name = 'Alpha Co';
insert into public.health_intakes (org_id, store_id, customer_id, answers, consent, signed_name, signed_at)
select (select v::uuid from t_out where k='orgA'), (select v::uuid from t_out where k='stA'), c.id, '{"pregnant":false}'::jsonb, true, 'Liu Wei',
       case c.name when 'Old Liu' then now() - interval '25 months' else now() - interval '23 months' end
  from public.customers c;
select t_rows(null, 'service_role', $$select public.health_intakes_cleanup()$$, 1, 'the cleanup runs');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.health_intakes) = 2 and not exists (select 1 from public.health_intakes h join public.customers c on c.id = h.customer_id where c.name = 'Old Liu')$$, 1, 'only the form older than 24 months is erased');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.health_intakes_cleanup()$$, '42501', 'nobody but the service role can run it');

insert into public.networks (slug, name) values ('island', '{"th":"เกาะ"}'::jsonb);
insert into public.network_passes (network_id, code, token, name, phone, created_at)
select n.id, v.code, v.token, v.name, v.phone, now() - interval '40 months'
  from public.networks n, (values ('BP-AAAAAAAAAA', repeat('a', 32), 'Idle', '0811111111'), ('BP-BBBBBBBBBB', repeat('b', 32), 'Active', '0822222222')) v(code, token, name, phone);
insert into public.network_pass_links (pass_id, org_id, customer_id)
select p.id, (select v::uuid from t_out where k='orgA'), c.id from public.network_passes p join public.customers c on c.name = case p.name when 'Idle' then 'Old Liu' else 'New Liu' end;
create or replace function t_order(org text, st text, num text, cust text, used int, disc bigint, paid_ago interval) returns uuid language plpgsql as $$
declare v_o uuid := gen_random_uuid(); v_org uuid := (select v::uuid from t_out where k = org); v_st uuid := (select v::uuid from t_out where k = st);
begin
  insert into public.orders (id, org_id, store_id, number, business_date, channel, status, customer_id)
  values (v_o, v_org, v_st, 'A' || lpad(num, 3, '0'), (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'open', (select v::uuid from t_out where k = cust));
  update public.orders set status = 'paid', points_used = used, points_discount = disc where id = v_o;
  insert into public.receipts (org_id, store_id, order_id, number, issued_at, seller_name, branch_code, vat_registered, vat_bps, service_bps, price_mode, subtotal, service_charge, vat, net_before_vat, total, rounding, payable)
  values (v_org, v_st, v_o, 'A-' || lpad(num, 6, '0'), now() - paid_ago, 'x', '00000', false, 0, 0, 'inclusive', 0, 0, 0, 0, 0, 0, 0);
  return v_o;
end $$;
grant execute on function t_order(text, text, text, text, int, bigint, interval) to service_role;
select t_val(null, 'service_role', 'cNew', $$select id::text from public.customers where name = 'New Liu'$$);
insert into public.points_ledger (org_id, customer_id, store_id, kind, points, order_id)
select (select v::uuid from t_out where k='orgA'), (select v::uuid from t_out where k='cNew'), (select v::uuid from t_out where k='stA'), 'earn', 5, public.t_order('orgA', 'stA', '1', 'cNew', 0, 0, interval '1 day');
select t_rows(null, 'service_role', $$select public.network_passes_cleanup()$$, 1, 'the pass cleanup runs');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.network_passes) = 1 and exists (select 1 from public.network_passes where name = 'Active')$$, 1, 'the pass nobody used for 36 months is erased, the one with recent points stays');
select t_rows(null, 'service_role', $$select 1 where (select count(*) from public.customers) = 3$$, 1, 'the shop''s own member records stay');
do $$ begin raise notice 'ALL RETENTION TESTS PASSED'; end $$;
