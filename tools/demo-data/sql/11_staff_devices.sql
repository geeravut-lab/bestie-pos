-- Roles beyond the built-in ones, the team of every shop, PINs for the lock screen, and the tablets / screens.
do $$
declare
  d text := '@bestiedemo.example';
  o text := 'owner.demo@bestiedemo.example';
  v_org uuid := demo.org();
  r record;
  v_role uuid;
begin
  -- custom roles made by the owner in the role editor (the database refuses permissions the owner does not hold)
  for r in select * from (values
    ('Accountant', '{report.view,customer.view,audit.view,stock.view}'),
    ('Stock keeper', '{stock.manage,stock.view,customer.view}'),
    ('Stylist / Therapist', '{order.create,customer.view}')
  ) as t(name, perms) loop
    if not exists (select 1 from public.roles where org_id = v_org and name = r.name) then
      perform demo.run(o, format($q$insert into public.roles (org_id, name, permissions) values (%L, %L, %L::text[])$q$, v_org, r.name, r.perms));
    end if;
  end loop;

  -- the team (what accepting a staff invite does), per role
  for r in select * from (values
    ('manager.demo',         'Demo Manager',        'manager',             null),
    ('accountant.demo',      'Demo Accountant',     'Accountant',          null),
    ('stockkeeper.demo',     'Demo Stock keeper',   'Stock keeper',        null),
    ('cashier.kitchen.demo', 'Demo Cashier (Kitchen)', 'cashier',          'Island Kitchen'),
    ('waiter.kitchen.demo',  'Demo Waiter (Kitchen)',  'waiter',           'Island Kitchen'),
    ('kds.kitchen.demo',     'Demo Kitchen screen', 'kitchen',             'Island Kitchen'),
    ('bar.kitchen.demo',     'Demo Bar screen',     'kitchen',             'Island Kitchen'),
    ('cashier.cafe.demo',    'Demo Cashier (Café)', 'cashier',             'Breeze Café'),
    ('kds.cafe.demo',        'Demo Barista screen', 'kitchen',             'Breeze Café'),
    ('reception.salon.demo', 'Demo Reception (Salon)', 'cashier',          'Sunset Salon'),
    ('stylist.salon.demo',   'Demo Stylist (Salon)',   'Stylist / Therapist', 'Sunset Salon'),
    ('reception.spa.demo',   'Demo Reception (Spa)',   'cashier',          'Lotus Spa'),
    ('therapist.spa.demo',   'Demo Therapist (Spa)',   'Stylist / Therapist', 'Lotus Spa')
  ) as t(local_part, name, role_key, store_name) loop
    select id into v_role from public.roles where org_id = v_org and (built_in = r.role_key or name = r.role_key) order by (built_in is null) limit 1;
    if not exists (select 1 from public.staff where org_id = v_org and user_id = demo.uid(r.local_part || d)) then
      insert into public.staff (org_id, store_id, user_id, display_name, role_id)
      values (v_org, case when r.store_name is null then null else demo.store(r.store_name) end, demo.uid(r.local_part || d), r.name, v_role);
    end if;
  end loop;

  -- lock-screen PINs (4 digits; bcrypt on the server)
  for r in select s.id from public.staff s where s.org_id = v_org loop
    perform demo.run(o, format($q$select public.set_staff_pin(%L, '1234')$q$, r.id));
  end loop;

  -- tablets and screens, registered by the owner (the order-number letter A, B… is given by the database)
  for r in select * from (values
    ('Island Kitchen', 'Counter 1',     'cashier', null,      'POS-IK-01'),
    ('Island Kitchen', 'Waiter handheld','staff',  null,      null),
    ('Island Kitchen', 'Kitchen screen', 'kds',    'kitchen', null),
    ('Island Kitchen', 'Bar screen',     'kds',    'bar',     null),
    ('Breeze Café',    'Café counter',   'cashier', null,     'POS-BC-01'),
    ('Breeze Café',    'Barista screen', 'kds',    'bar',     null),
    ('Sunset Salon',   'Front desk',     'cashier', null,     'POS-SS-01'),
    ('Lotus Spa',      'Front desk',     'cashier', null,     'POS-LS-01')
  ) as t(store_name, name, role, station, pos_id) loop
    if demo.device(r.store_name, r.name) is null then
      perform demo.run(o, format($q$insert into public.devices (org_id, store_id, name, role, station, revenue_pos_id) values (%L, %L, %L, %L, %L, %L)$q$,
        v_org, demo.store(r.store_name), r.name, r.role, r.station, r.pos_id));
    end if;
  end loop;
end $$;
select 'staff=' || (select count(*) from public.staff where org_id = demo.org()) || ' devices=' || (select count(*) from public.devices where org_id = demo.org());
