-- REMOVE ALL DEMO DATA: the organisation "[DEMO] Island Group" with every shop, bill, receipt, ledger row and audit line, and the
-- demo accounts (e-mails ending @bestiedemo.example). Receipts, ledgers and the audit trail are append-only for the app, so for the
-- length of this one transaction the table's USER triggers are switched off (the hosted database does not let us use
-- session_replication_role); foreign keys stay enforced, and ONLY rows of that one organisation are deleted. The triggers are
-- switched back on before the transaction ends (and if anything fails the whole transaction, switch-off included, is rolled back).
do $$
declare
  v_org uuid := demo.org();
  v_users uuid[];
  t record;
  n bigint;
begin
  select coalesce(array_agg(id), '{}') into v_users from auth.users where email like '%@bestiedemo.example';
  if v_org is not null then
    for t in select tablename from pg_tables where schemaname = 'public' loop
      execute format('alter table public.%I disable trigger user', t.tablename);
    end loop;
    delete from public.staff_pins where staff_id in (select id from public.staff where org_id = v_org);
    delete from public.orgs where id = v_org;                       -- everything of the organisation goes with it (foreign keys cascade)
    -- anything of the organisation that did not cascade (tables without a foreign key to it)
    for t in
      select c.table_name from information_schema.columns c
        join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
       where c.table_schema = 'public' and c.column_name = 'org_id' and c.table_name <> 'orgs'
    loop
      execute format('delete from public.%I where org_id = $1', t.table_name) using v_org;
    end loop;
  end if;
  -- what hangs on the demo accounts (notification rows, profiles …) goes with them
  for t in
    select c.table_name from information_schema.columns c
      join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
     where c.table_schema = 'public' and c.column_name = 'user_id' and c.table_name not in ('platform_admins')
  loop
    execute format('delete from public.%I where user_id = any ($1)', t.table_name) using v_users;
  end loop;
  delete from auth.users where id = any (v_users);
  get diagnostics n = row_count;
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable trigger user', t.tablename);
  end loop;
  raise notice 'demo organisation removed; % demo accounts deleted', n;
end $$;
drop schema if exists demo cascade;
select 'demo orgs left=' || (select count(*) from public.orgs where name like '[DEMO]%') || ' demo accounts left=' || (select count(*) from auth.users where email like '%@bestiedemo.example');
