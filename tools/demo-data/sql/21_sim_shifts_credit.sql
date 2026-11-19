-- Morning: every till opens its shift with a cash float; members top up Bestie Credit with cash.
do $$
begin
  perform demo.open_shift('cashier.kitchen.demo@bestiedemo.example', 'Island Kitchen', 'Counter 1', 100000);
  perform demo.open_shift('cashier.cafe.demo@bestiedemo.example', 'Breeze Café', 'Café counter', 80000);
  perform demo.open_shift('reception.salon.demo@bestiedemo.example', 'Sunset Salon', 'Front desk', 50000);
  perform demo.open_shift('reception.spa.demo@bestiedemo.example', 'Lotus Spa', 'Front desk', 50000);

  if not exists (select 1 from public.credit_ledger where org_id = demo.org() and kind = 'topup') then
    -- (customer phone, amount in satang, who takes the cash, shop, till)
    perform demo.val(r.by, format($q$select public.topup_credit(jsonb_build_object('id', gen_random_uuid(), 'customer_id', %L, 'store_id', %L, 'device_id', %L, 'amount', %s, 'funding', 'cash'))::text$q$,
      demo.cust(r.phone), demo.store(r.store), demo.device(r.store, r.dev), r.amount))
    from (values
      ('66800000101', 100000, 'cashier.kitchen.demo@bestiedemo.example', 'Island Kitchen', 'Counter 1'),
      ('66800000102',  50000, 'cashier.kitchen.demo@bestiedemo.example', 'Island Kitchen', 'Counter 1'),
      ('66800000103',  30000, 'cashier.cafe.demo@bestiedemo.example',    'Breeze Café',    'Café counter'),
      ('66800000104',  80000, 'cashier.cafe.demo@bestiedemo.example',    'Breeze Café',    'Café counter'),
      ('66800000105', 200000, 'reception.spa.demo@bestiedemo.example',   'Lotus Spa',      'Front desk'),
      ('66800000106',  50000, 'reception.salon.demo@bestiedemo.example', 'Sunset Salon',   'Front desk')
    ) as r(phone, amount, by, store, dev);
  end if;
end $$;
select 'open shifts=' || (select count(*) from public.shifts where org_id = demo.org() and status = 'open') || ' credit topups=' || (select count(*) from public.credit_ledger where org_id = demo.org() and kind = 'topup');
