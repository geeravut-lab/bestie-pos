-- Accounts (one per role), the organisation, four shops, staff, PINs and devices.
-- The accounts themselves (a login) are created directly (the app has no screen for it); everything after that goes through the app's functions as the owner.
do $$
declare
  pw text := '__DEMO_PASSWORD__';
  d text := 'bestiedemo.example';
  u record;
  v_org uuid;
begin
  for u in select * from (values
    ('owner.demo', 'Demo Owner (เจ้าของกลุ่ม)'),
    ('manager.demo', 'Demo Manager (ผู้จัดการกลุ่ม)'),
    ('accountant.demo', 'Demo Accountant (บัญชี)'),
    ('stockkeeper.demo', 'Demo Stock keeper (คลังสินค้า)'),
    ('cashier.kitchen.demo', 'Demo Cashier – Island Kitchen'),
    ('waiter.kitchen.demo', 'Demo Waiter – Island Kitchen'),
    ('kds.kitchen.demo', 'Demo Kitchen screen – Island Kitchen'),
    ('bar.kitchen.demo', 'Demo Bar screen – Island Kitchen'),
    ('cashier.cafe.demo', 'Demo Cashier – Breeze Café'),
    ('kds.cafe.demo', 'Demo Barista screen – Breeze Café'),
    ('reception.salon.demo', 'Demo Reception – Sunset Salon'),
    ('stylist.salon.demo', 'Demo Stylist – Sunset Salon'),
    ('reception.spa.demo', 'Demo Reception – Lotus Spa'),
    ('therapist.spa.demo', 'Demo Therapist – Lotus Spa')
  ) as t(local_part, name) loop
    perform demo.make_user(u.local_part || '@' || d, u.name, pw);
  end loop;

  -- the organisation + its first shop, as the owner (the app's own onboarding function)
  if demo.org() is null then
    perform demo.val('owner.demo@' || d, $q$select (public.create_org('[DEMO] Island Group', 'Island Kitchen', 'restaurant')).org_id::text$q$);
  end if;
end $$;

-- the legal entity (what the receipts print) and the first shop's billing
update public.legal_entities set name = '[DEMO] Island Group Co., Ltd.', tax_id = '0105560000017' where org_id = demo.org();
update public.stores set vat_registered = true, vat_bps = 700, branch_code = '00000', service_charge_bps = 1000 where id = demo.store('Island Kitchen');

do $$
declare d text := 'bestiedemo.example'; o text := 'owner.demo@bestiedemo.example';
begin
  -- more shops of other kinds, same company
  if demo.store('Breeze Café') is null then perform demo.val(o, format($q$select public.create_store(%L, 'Breeze Café', 'cafe')::text$q$, demo.org())); end if;
  if demo.store('Sunset Salon') is null then perform demo.val(o, format($q$select public.create_store(%L, 'Sunset Salon', 'salon')::text$q$, demo.org())); end if;
  if demo.store('Lotus Spa') is null then perform demo.val(o, format($q$select public.create_store(%L, 'Lotus Spa', 'spa')::text$q$, demo.org())); end if;
end $$;

update public.stores set vat_registered = true, vat_bps = 700, branch_code = '00001' where id = demo.store('Breeze Café');
update public.stores set vat_registered = true, vat_bps = 700, branch_code = '00002' where id = demo.store('Sunset Salon');
update public.stores set vat_registered = true, vat_bps = 700, branch_code = '00003' where id = demo.store('Lotus Spa');
-- modules the owner switches on per shop (the toggle screen writes exactly this)
update public.stores set module_overrides = '{"tender.credit": true, "stock": true}'::jsonb where id in (demo.store('Island Kitchen'), demo.store('Breeze Café'));
update public.stores set module_overrides = '{"tender.credit": true, "booking.online": true}'::jsonb where id in (demo.store('Sunset Salon'), demo.store('Lotus Spa'));
