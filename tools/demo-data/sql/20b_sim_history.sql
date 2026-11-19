-- The last nine days of trading, so the reports and charts have a story. These are ordinary bills made the same way as today's
-- (as the waiter / cashier / reception), only dated in the past: the order, its lines, the payments and the receipt carry that time.
-- The "business date is today" guard of the order table is switched off INSIDE this one transaction (it exists for offline tills
-- that sync a day late, and allows two days); nothing else is relaxed.

create or replace function demo.rand_items(p_store text, p_n int) returns jsonb language plpgsql as $$
declare r record; g record; res jsonb := '[]'::jsonb; opts jsonb;
begin
  for r in select i.id, i.name ->> 'th' as th, i.modifier_group_ids from public.menu_items i
            where i.store_id = demo.store(p_store) and i.deleted_at is null and i.available order by random() limit p_n loop
    opts := '[]'::jsonb;
    for g in select id from public.modifier_groups where id = any (r.modifier_group_ids) and min_select >= 1 loop
      opts := opts || coalesce((select jsonb_build_array(o.name ->> 'th') from public.modifier_options o where o.group_id = g.id and o.deleted_at is null order by random() limit 1), '[]'::jsonb);
    end loop;
    res := res || jsonb_build_object('n', r.th, 'q', 1 + floor(random() * 2)::int, 'o', opts);
  end loop;
  return res;
end $$;

create or replace function demo.at(p_day date, p_hour int, p_min int) returns timestamptz language sql immutable as $$
  select ((p_day::text || ' ' || lpad(p_hour::text, 2, '0') || ':' || lpad(p_min::text, 2, '0') || ':00+07')::timestamptz) $$;

do $$
declare
  today date := (now() at time zone 'Asia/Bangkok')::date;
  d date; off int; i int; n int; dow int; hr int; legs jsonb;
  w text := 'waiter.kitchen.demo@bestiedemo.example'; kc text := 'cashier.kitchen.demo@bestiedemo.example';
  cc text := 'cashier.cafe.demo@bestiedemo.example';
  rs text := 'reception.salon.demo@bestiedemo.example'; rp text := 'reception.spa.demo@bestiedemo.example';
  tbl text[] := array['T1','T2','T3','T4','T5','T6','B1','B2'];
begin
  if exists (select 1 from public.orders where org_id = demo.org() and business_date < today) then raise notice 'history already simulated'; return; end if;
  perform setseed(0.37);                                       -- the same story every time
  alter table public.orders disable trigger orders_check;
  for off in reverse 9..1 loop
    d := today - off;
    dow := extract(isodow from d)::int;                       -- 5 = Fri, 6 = Sat, 7 = Sun are busier
    -- Island Kitchen: lunch and dinner
    n := 4 + floor(random() * 4)::int + case when dow >= 5 then 3 else 0 end;
    for i in 1..n loop
      hr := case when random() < 0.45 then 11 + floor(random() * 3)::int else 18 + floor(random() * 3)::int end;
      legs := case when random() < 0.8 then '[{"t":"cash"}]'::jsonb else '[{"t":"cash","equal":2}]'::jsonb end;
      if random() < 0.85 then
        perform demo.sell(w, 'Island Kitchen', 'Waiter handheld', 'dine-in', tbl[1 + floor(random() * 8)::int], demo.rand_items('Island Kitchen', 2 + floor(random() * 3)::int), null, 0, kc, 'Counter 1', legs, null, demo.at(d, hr, floor(random() * 50)::int));
      else
        perform demo.sell(kc, 'Island Kitchen', 'Counter 1', 'takeaway', null, demo.rand_items('Island Kitchen', 1 + floor(random() * 2)::int), null, 0, kc, 'Counter 1', '[{"t":"cash"}]', null, demo.at(d, hr, floor(random() * 50)::int));
      end if;
    end loop;
    -- Breeze Café: morning rush and afternoon
    n := 5 + floor(random() * 5)::int + case when dow >= 6 then 3 else 0 end;
    for i in 1..n loop
      hr := case when random() < 0.6 then 8 + floor(random() * 3)::int else 13 + floor(random() * 4)::int end;
      perform demo.sell(cc, 'Breeze Café', 'Café counter', 'takeaway', null, demo.rand_items('Breeze Café', 1 + floor(random() * 3)::int), null, 0, cc, 'Café counter', '[{"t":"cash"}]', null, demo.at(d, hr, floor(random() * 55)::int));
    end loop;
    -- Sunset Salon and Lotus Spa: a few services and products a day
    for i in 1..(1 + floor(random() * 3)::int) loop
      perform demo.sell(rs, 'Sunset Salon', 'Front desk', 'takeaway', null, demo.rand_items('Sunset Salon', 1 + floor(random() * 2)::int), null, 0, rs, 'Front desk', '[{"t":"cash"}]', null, demo.at(d, 10 + floor(random() * 8)::int, floor(random() * 50)::int));
    end loop;
    for i in 1..(1 + floor(random() * 3)::int + case when dow >= 5 then 1 else 0 end) loop
      perform demo.sell(rp, 'Lotus Spa', 'Front desk', 'takeaway', null, demo.rand_items('Lotus Spa', 1 + floor(random() * 2)::int), null, 0, rp, 'Front desk', '[{"t":"cash"}]', null, demo.at(d, 11 + floor(random() * 9)::int, floor(random() * 50)::int));
    end loop;
  end loop;
  alter table public.orders enable trigger orders_check;
end $$;
select 'history bills=' || (select count(*) from public.receipts where org_id = demo.org() and issued_at < now() - interval '12 hours');
