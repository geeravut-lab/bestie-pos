-- Demo "full" step, part 1: the staff, tills and open shifts of the shops that had none (Palm Resort, Sing Along, Island Tours), and a helper that closes a shift with the
-- cash the SERVER expects (it asks the server inside a rolled-back sub-transaction, so every cash source — deposits, settlements, tips — is counted the way the app counts it).
-- Safe to run again: it skips what exists. Needs setup, phase4 and growth first.
create or replace function demo.close_shift_exact(p_by text, p_store text, p_device text, p_diff bigint, p_note text default null) returns jsonb language plpgsql as $$
declare s public.shifts%rowtype; v_exp bigint; v_res jsonb;
begin
  select * into s from public.shifts where device_id = demo.device(p_store, p_device) and status = 'open';
  if s.id is null then return null; end if;
  begin
    v_res := demo.val(p_by, format($q$select public.close_shift(jsonb_build_object('id', %L, 'staff_id', %L, 'closed_at', now(), 'counted_cash', 0, 'note', 'probe'))::text$q$, s.id, demo.staff(p_by)))::jsonb;
    raise exception 'EXP:%', v_res ->> 'expected_cash';
  exception when others then
    v_exp := nullif(split_part(sqlerrm, 'EXP:', 2), '')::bigint;
  end;
  if v_exp is null then raise exception 'could not read the expected cash of %', p_device; end if;
  return demo.val(p_by, format($q$select public.close_shift(jsonb_build_object('id', %L, 'staff_id', %L, 'closed_at', now(), 'counted_cash', %s, 'note', %L))::text$q$,
    s.id, demo.staff(p_by), v_exp + p_diff, p_note))::jsonb;
end $$;
grant execute on function demo.close_shift_exact(text, text, text, bigint, text) to authenticated;

do $$
declare
  o text := 'owner.demo@bestiedemo.example'; d text := '@bestiedemo.example'; v_org uuid := demo.org(); r record; v_role uuid;
begin
  if v_org is null then raise exception 'run setup first (there is no demo organisation)'; end if;
  if demo.store('Palm Resort') is null or demo.store('Sing Along') is null or demo.store('Island Tours') is null then
    raise exception 'run phase4 and growth first (Palm Resort, Sing Along or Island Tours is missing)';
  end if;
  for r in select * from (values
    ('reception.resort.demo', 'Demo Reception (Resort)', 'cashier', 'Palm Resort'),
    ('manager.resort.demo',   'Demo Manager (Resort)',   'manager', 'Palm Resort'),
    ('cashier.karaoke.demo',  'Demo Cashier (Karaoke)',  'cashier', 'Sing Along'),
    ('manager.karaoke.demo',  'Demo Manager (Karaoke)',  'manager', 'Sing Along'),
    ('cashier.tours.demo',    'Demo Cashier (Tours)',    'cashier', 'Island Tours'),
    ('guide.tours.demo',      'Demo Guide (Tours)',      'waiter',  'Island Tours')
  ) as t(local_part, name, role_key, store) loop
    perform demo.make_user(r.local_part || d, r.name, '__DEMO_PASSWORD__');
    -- the new accounts share the password the owner already chose for the demo (copied from the owner's own demo account, so this step never needs to know it)
    if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'encrypted_password') then
      execute format('update auth.users set encrypted_password = (select encrypted_password from auth.users where email = %L) where email = %L', 'owner.demo' || d, r.local_part || d);
    end if;
    select id into v_role from public.roles where org_id = v_org and built_in = r.role_key limit 1;
    if not exists (select 1 from public.staff where org_id = v_org and user_id = demo.uid(r.local_part || d)) then
      insert into public.staff (org_id, store_id, user_id, display_name, role_id) values (v_org, demo.store(r.store), demo.uid(r.local_part || d), r.name, v_role);
      perform demo.run(o, format($q$select public.set_staff_pin(%L, '1234')$q$, demo.staff(r.local_part || d)));
    end if;
  end loop;
  for r in select * from (values ('Palm Resort', 'Front desk', 'POS-PR-01'), ('Sing Along', 'Karaoke desk', 'POS-SA-01')) as t(store, name, pos) loop
    if demo.device(r.store, r.name) is null then
      perform demo.run(o, format($q$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values (%L, %L, %L, 'cashier', %L)$q$, v_org, demo.store(r.store), r.name, r.pos));
    end if;
  end loop;
  -- the three shops are VAT shops like the others, so their receipts carry the POS ID
  update public.stores set vat_registered = true, vat_bps = 700, branch_code = case name when 'Palm Resort' then '00005' when 'Sing Along' then '00006' else '00007' end
   where id in (demo.store('Palm Resort'), demo.store('Sing Along'), demo.store('Island Tours')) and not vat_registered;
  update public.devices set revenue_pos_id = 'POS-IT-01' where id = demo.device('Island Tours', 'Tour desk') and revenue_pos_id is null;
  perform demo.open_shift('reception.resort.demo' || d, 'Palm Resort', 'Front desk', 100000);
  perform demo.open_shift('cashier.karaoke.demo' || d, 'Sing Along', 'Karaoke desk', 100000);
  perform demo.open_shift('cashier.tours.demo' || d, 'Island Tours', 'Tour desk', 100000);
  raise notice 'full/accounts: 6 accounts (PIN 1234), 2 tills, 3 shifts open';
end $$;
