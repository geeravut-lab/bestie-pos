-- Network demo, step 3: at Palm Beach Café (the second business) Anna and Liu SPEND the Points they earned at Breeze Café, and Dan earns Points there.
do $$
declare
  d text := '@bestiedemo.example'; cb text := 'cashier.beach.demo' || d; res text;
begin
  if not exists (select 1 from public.points_ledger l join public.customers c on c.id = l.customer_id where c.phone = '0999000101' and l.kind = 'earn') then raise exception 'run 41_network_earn first'; end if;
  perform set_config('demo.org_name', '[DEMO] Palm Beach Co', true);
  if exists (select 1 from public.points_ledger l join public.customers c on c.id = l.customer_id where c.phone = '0999000103' and l.kind = 'earn') then return; end if;
  perform demo.val(cb, format($q$select public.link_pass(%L, %L)::text$q$, demo.store('Palm Beach Café'), demo.svc($z$select code from public.network_passes where phone = '0999000101'$z$)));
  perform demo.val(cb, format($q$select public.link_pass(%L, %L)::text$q$, demo.store('Palm Beach Café'), demo.svc($z$select code from public.network_passes where phone = '0999000102'$z$)));
  perform demo.val(cb, format($q$select public.link_pass(%L, %L)::text$q$, demo.store('Palm Beach Café'), demo.svc($z$select code from public.network_passes where phone = '0999000103'$z$)));
  res := demo.sell(cb, 'Palm Beach Café', 'Beach counter', 'takeaway', null, '[{"n":"ข้าวผัดกุ้ง","q":3},{"n":"ชาไทยเย็น","q":3}]', '0999000101', 12, cb, 'Beach counter', '[{"t":"cash"}]', null);
  res := demo.sell(cb, 'Palm Beach Café', 'Beach counter', 'takeaway', null, '[{"n":"ผลไม้รวม","q":2},{"n":"ชาไทยเย็น","q":2}]', '0999000102', 6, cb, 'Beach counter', '[{"t":"cash"}]', null);
  res := demo.sell(cb, 'Palm Beach Café', 'Beach counter', 'takeaway', null, '[{"n":"ข้าวผัดกุ้ง","q":10},{"n":"ผลไม้รวม","q":6}]', '0999000103', 0, cb, 'Beach counter', '[{"t":"cash"}]', null);
  perform set_config('demo.org_name', '', true);
  raise notice 'network demo: Points spent at Palm Beach Café; Dan earned Points there';
end $$;
