-- Demo: a RESORT shop "Palm Resort" (needs migration 74): four rooms (plan Resort), two guests checked in, and bills of two other outlets of the group charged to their rooms.
-- Safe to run again: it stops when the shop exists.
do $$
declare
  o text := 'owner.demo@bestiedemo.example'; v_org uuid := demo.org(); r record; v_f1 text; res text;
begin
  if v_org is null then raise exception 'run setup first (there is no demo organisation)'; end if;
  if demo.store('Palm Resort') is not null then raise notice 'resort demo already there'; return; end if;
  perform demo.val(o, format($q$select public.create_store(%L, 'Palm Resort', 'resort')::text$q$, v_org));
  update public.stores set plan = 'resort' where id = demo.store('Palm Resort');
  for r in select * from (values ('101', 1), ('102', 2), ('103', 3), ('104', 4)) as t(name, sort) loop
    perform demo.val(o, format($q$select public.save_folio_room(jsonb_build_object('store_id', %L, 'name', %L, 'sort', %s))::text$q$, demo.store('Palm Resort'), r.name, r.sort));
  end loop;
  v_f1 := demo.val(o, format($q$select public.folio_check_in(jsonb_build_object('store_id', %L, 'room_id', %L, 'guest_name', 'Anna Weber', 'phone', '0999000101', 'check_out_on', %L))::text$q$,
    demo.store('Palm Resort'), (select id from public.folio_rooms where store_id = demo.store('Palm Resort') and name = '101'), to_char(((now() at time zone 'Asia/Bangkok')::date + 3), 'YYYY-MM-DD')));
  perform demo.val(o, format($q$select public.folio_check_in(jsonb_build_object('store_id', %L, 'room_id', %L, 'guest_name', 'Liu Wei', 'phone', '0999000102'))::text$q$,
    demo.store('Palm Resort'), (select id from public.folio_rooms where store_id = demo.store('Palm Resort') and name = '102')));
  -- two outlets of the group charge to Anna's room
  res := demo.sell('cashier.cafe.demo@bestiedemo.example', 'Breeze Café', 'Café counter', 'takeaway', null, '[{"n":"ลาเต้","q":2},{"n":"ครัวซองต์เนยสด","q":1}]', null, 0,
                   'cashier.cafe.demo@bestiedemo.example', 'Café counter', jsonb_build_array(jsonb_build_object('t', 'room', 'f', v_f1)), null);
  res := demo.sell('reception.spa.demo@bestiedemo.example', 'Lotus Spa', 'Front desk', 'takeaway', null, '[{"n":"น้ำมันนวดอโรมา 100 มล.","q":1}]', null, 0,
                   'reception.spa.demo@bestiedemo.example', 'Front desk', jsonb_build_array(jsonb_build_object('t', 'room', 'f', v_f1)), null);
  raise notice 'resort demo: 4 rooms, Anna in 101 with two charged bills, Liu in 102';
end $$;
