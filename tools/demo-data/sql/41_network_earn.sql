-- Network demo, step 2: Anna and Liu show their Tourist Pass at Breeze Café (the demo group) and earn Points there. (Own file = own transaction, see 40_network.sql.)
do $$
declare
  d text := '@bestiedemo.example'; ca text := 'cashier.cafe.demo' || d; res text;
begin
  if not exists (select 1 from public.network_passes where phone = '0999000101') then raise exception 'run 40_network first'; end if;
  if exists (select 1 from public.points_ledger l join public.customers c on c.id = l.customer_id where c.phone = '0999000101' and l.kind = 'earn') then return; end if;
  perform demo.val(ca, format($q$select public.link_pass(%L, %L)::text$q$, demo.store('Breeze Café'), demo.svc($z$select code from public.network_passes where phone = '0999000101'$z$)));
  perform demo.val(ca, format($q$select public.link_pass(%L, %L)::text$q$, demo.store('Breeze Café'), demo.svc($z$select code from public.network_passes where phone = '0999000102'$z$)));
  res := demo.sell(ca, 'Breeze Café', 'Café counter', 'takeaway', null, '[{"n":"อเมริกาโน่","q":12},{"n":"ครัวซองต์เนยสด","q":8}]', '0999000101', 0, ca, 'Café counter', '[{"t":"cash"}]', null);
  res := demo.sell(ca, 'Breeze Café', 'Café counter', 'takeaway', null, '[{"n":"อเมริกาโน่","q":10},{"n":"บราวนี่","q":6}]', '0999000102', 0, ca, 'Café counter', '[{"t":"cash"}]', null);
  raise notice 'network demo: Anna and Liu earned Points at Breeze Café';
end $$;
