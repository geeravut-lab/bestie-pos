-- Network demo, step 4: Dan shows his pass at Lotus Spa (the demo group) and spends the Points he earned at Palm Beach Café — the statement now has a line in the other direction.
do $$
declare
  d text := '@bestiedemo.example'; ra text := 'reception.spa.demo' || d; res text;
begin
  if not exists (select 1 from public.points_ledger l join public.customers c on c.id = l.customer_id where c.phone = '0999000103' and l.kind = 'earn') then raise exception 'run 42_network_spend first'; end if;
  if exists (select 1 from public.points_ledger l join public.customers c on c.id = l.customer_id where c.phone = '0999000103' and l.kind = 'redeem') then return; end if;
  perform demo.val(ra, format($q$select public.link_pass(%L, %L)::text$q$, demo.store('Lotus Spa'), demo.svc($z$select code from public.network_passes where phone = '0999000103'$z$)));
  res := demo.sell(ra, 'Lotus Spa', 'Front desk', 'takeaway', null, '[{"n":"น้ำมันนวดอโรมา 100 มล.","q":2},{"n":"ลูกประคบสมุนไพร","q":1}]', '0999000103', 20, ra, 'Front desk', '[{"t":"cash"}]', null);
  raise notice 'network demo: Dan spent Points at Lotus Spa';
end $$;
