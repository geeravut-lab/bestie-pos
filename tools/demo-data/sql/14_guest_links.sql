-- What a CUSTOMER opens (no login): a table QR page in the restaurant and the café, a booking page in the salon and the spa.
do $$
declare
  o text := 'owner.demo@bestiedemo.example';
  v_org uuid := demo.org();
  i int;
begin
  -- the café gets three small tables with a QR each, and QR ordering is switched on there
  update public.stores set module_overrides = module_overrides || '{"order.qr": true}'::jsonb where id = demo.store('Breeze Café');
  for i in 1..3 loop
    if not exists (select 1 from public.dining_tables where store_id = demo.store('Breeze Café') and name = 'Q' || i) then
      perform demo.run(o, format($q$insert into public.dining_tables (org_id, store_id, name, zone, seats, sort) values (%L, %L, %L, 'Café', 2, %s)$q$, v_org, demo.store('Breeze Café'), 'Q' || i, i * 10));
    end if;
  end loop;
  -- every booking link exists (the call returns the existing one if there already is one)
  perform demo.val(o, format($q$select public.save_booking_settings(%L, '{}'::jsonb)::text$q$, demo.store('Sunset Salon')));
  perform demo.val(o, format($q$select public.save_booking_settings(%L, '{}'::jsonb)::text$q$, demo.store('Lotus Spa')));
end $$;
select 'links: ' || (select string_agg(s.name || ' ' || coalesce(t.n::text, '0') || ' tables', ', ') from public.stores s left join lateral (select count(*) n from public.dining_tables d where d.store_id = s.id) t on true where s.org_id = demo.org())
  || ' · booking tokens=' || (select count(*) from public.stores where org_id = demo.org() and booking_token is not null);
