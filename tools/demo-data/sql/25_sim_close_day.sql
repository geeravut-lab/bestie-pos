-- End of the day: every till counts its drawer (one is 20 baht short, to show the variance report), then a summary.
do $$
begin
  perform demo.close_shift('cashier.kitchen.demo@bestiedemo.example', 'Island Kitchen', 'Counter 1', 0);
  perform demo.close_shift('cashier.cafe.demo@bestiedemo.example', 'Breeze Café', 'Café counter', -2000, 'short 20 baht — change given wrongly');
  perform demo.close_shift('reception.salon.demo@bestiedemo.example', 'Sunset Salon', 'Front desk', 0);
  perform demo.close_shift('reception.spa.demo@bestiedemo.example', 'Lotus Spa', 'Front desk', 0);
end $$;
select jsonb_pretty(jsonb_build_object(
  'paid bills today', (select count(*) from public.receipts where org_id = demo.org() and (issued_at at time zone 'Asia/Bangkok')::date = (now() at time zone 'Asia/Bangkok')::date),
  'paid bills all days', (select count(*) from public.receipts where org_id = demo.org()),
  'sales total THB (all days)', (select round(sum(payable) / 100.0, 2) from public.receipts where org_id = demo.org()),
  'days with sales', (select count(distinct (issued_at at time zone 'Asia/Bangkok')::date) from public.receipts where org_id = demo.org()),
  'by shop (all days)', (select jsonb_object_agg(name, n) from (select s.name, count(*) n from public.receipts r join public.stores s on s.id = r.store_id where r.org_id = demo.org() group by s.name) x),
  'by tender', (select jsonb_object_agg(tender, n) from (select tender, count(*) n from public.payments where org_id = demo.org() group by tender) x),
  'appointments', (select count(*) from public.appointments where org_id = demo.org()),
  'members', (select count(*) from public.customers where org_id = demo.org()),
  'closed shifts', (select count(*) from public.shifts where org_id = demo.org() and status = 'closed'),
  'audit events', (select count(*) from public.audit_log where org_id = demo.org())));
