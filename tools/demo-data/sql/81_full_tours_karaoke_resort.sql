-- Demo "full" step, part 2: real transactions at the three newest shops, all made by the shop's own staff through the app's functions.
--  Island Tours: bookings, a cash deposit into the open shift, check-in, the bill paid with the deposit applied, a no-show whose deposit is kept, a cancellation refunded, the shift closed.
--  Sing Along: three room sessions billed and paid (one with the 1-hour package), the cash deposit of the online booking, the shift closed.
--  Palm Resort: a guest's stay charged from two outlets and checked out with the balance paid in cash.   Safe to run again: it stops when the first marker exists.
do $$
declare
  o text := 'owner.demo@bestiedemo.example'; d text := '@bestiedemo.example'; v_org uuid := demo.org();
  tc text := 'cashier.tours.demo@bestiedemo.example'; kc text := 'cashier.karaoke.demo@bestiedemo.example'; rr text := 'reception.resort.demo@bestiedemo.example';
  v_tt uuid := demo.store('Island Tours'); v_dev uuid := demo.device('Island Tours', 'Tour desk'); v_s1 uuid; v_s2 uuid; v_b uuid; v_ord uuid; v_dep uuid; v_res text;
  v_sa uuid := demo.store('Sing Along'); v_room uuid; v_sess uuid; v_pk uuid; v_kdev uuid := demo.device('Sing Along', 'Karaoke desk'); v_bk uuid;
  v_f uuid; v_pr uuid := demo.store('Palm Resort'); n text;
begin
  if v_org is null or v_tt is null or v_dev is null then raise exception 'run the full accounts file first'; end if;
  if exists (select 1 from public.tour_bookings where store_id = v_tt and guest_name = 'Family Lee') then raise notice 'full tours/karaoke/resort already there'; return; end if;

  -- ── tours ──────────────────────────────────────────────────────────────────────────────────
  select id into v_s1 from public.tour_slots where store_id = v_tt order by starts_at limit 1;
  select id into v_s2 from public.tour_slots where store_id = v_tt order by starts_at offset 1 limit 1;
  -- a family books at the desk, pays a CASH deposit into this till, is checked in, and the bill is paid with the deposit applied
  v_b := (demo.val(tc, format($q$select public.book_tour(jsonb_build_object('slot_id', %L, 'guest_name', 'Family Lee', 'phone', '0999000201', 'seats', 4, 'client_id', gen_random_uuid()) )->> 'id'$q$, v_s1)))::uuid;
  perform demo.run(tc, format($q$select public.take_tour_deposit(jsonb_build_object('booking_id', %L, 'amount', 150000, 'method', 'cash', 'device_id', %L))$q$, v_b, v_dev));
  perform demo.run(tc, format($q$select public.set_tour_booking_status(%L, 'checked_in')$q$, v_b));
  v_ord := demo.val(tc, format($q$select public.tour_to_order(jsonb_build_object('booking_id', %L, 'device_id', %L))::text$q$, v_b, v_dev))::uuid;
  v_res := demo.pay_order(v_ord, tc, 'Tour desk', '[{"t":"cash"}]'::jsonb);
  -- a no-show with a PromptPay deposit: the manager keeps it as a fee; a cancellation with a cash deposit: refunded from the till
  v_b := (demo.val(tc, format($q$select public.book_tour(jsonb_build_object('slot_id', %L, 'guest_name', 'Nina No-show', 'phone', '0999000202', 'seats', 2, 'client_id', gen_random_uuid()))->> 'id'$q$, v_s2)))::uuid;
  perform demo.run(tc, format($q$select public.take_tour_deposit(jsonb_build_object('booking_id', %L, 'amount', 54000, 'method', 'promptpay'))$q$, v_b));
  perform demo.run(tc, format($q$select public.set_tour_booking_status(%L, 'no_show')$q$, v_b));
  select id into v_dep from public.tour_deposits where booking_id = v_b;
  perform demo.run('manager.demo' || d, format($q$select public.resolve_tour_deposit(jsonb_build_object('deposit_id', %L, 'action', 'forfeit'))$q$, v_dep));
  v_b := (demo.val(tc, format($q$select public.book_tour(jsonb_build_object('slot_id', %L, 'guest_name', 'Carl Cancelled', 'phone', '0999000203', 'seats', 1, 'client_id', gen_random_uuid()))->> 'id'$q$, v_s2)))::uuid;
  perform demo.run(tc, format($q$select public.take_tour_deposit(jsonb_build_object('booking_id', %L, 'amount', 27000, 'method', 'cash', 'device_id', %L))$q$, v_b, v_dev));
  perform demo.run(tc, format($q$select public.set_tour_booking_status(%L, 'cancelled')$q$, v_b));
  select id into v_dep from public.tour_deposits where booking_id = v_b;
  perform demo.run('manager.demo' || d, format($q$select public.resolve_tour_deposit(jsonb_build_object('deposit_id', %L, 'action', 'refund', 'device_id', %L))$q$, v_dep, v_dev));
  -- a walk-in group and a couple still to travel (live bookings on the guest list)
  perform demo.val(tc, format($q$select public.book_tour(jsonb_build_object('slot_id', %L, 'guest_name', 'Walk-in group', 'phone', '0999000204', 'seats', 3, 'client_id', gen_random_uuid()))::text$q$, v_s2));
  perform demo.close_shift_exact(tc, 'Island Tours', 'Tour desk', 0, 'Counted: matches');

  -- ── karaoke ────────────────────────────────────────────────────────────────────────────────
  select id into v_pk from public.karaoke_packages where store_id = v_sa and name = '1 hour' limit 1;
  for n in select unnest(array['Mini', 'VIP 2', 'Mini']) loop
    select id into v_room from public.karaoke_rooms where store_id = v_sa and name = n and not exists (select 1 from public.karaoke_sessions x where x.room_id = karaoke_rooms.id and x.ended_at is null) limit 1;
    exit when v_room is null;
    v_sess := demo.val(kc, format($q$select public.karaoke_start(%L, 4, %s)::text$q$, v_room, case when n = 'VIP 2' then format('%L', v_pk) else 'null' end))::uuid;
    perform demo.val(kc, format($q$select public.karaoke_stop(%L)::text$q$, v_sess));
    v_ord := demo.val(kc, format($q$select public.karaoke_to_order(%L, %L)::text$q$, v_sess, v_kdev))::uuid;
    v_res := demo.pay_order(v_ord, kc, 'Karaoke desk', case when n = 'VIP 2' then '[{"t":"cash","equal":2}]' else '[{"t":"cash"}]' end::jsonb);
  end loop;
  select id into v_bk from public.karaoke_bookings where store_id = v_sa and guest_name in ('Dan Fischer', 'Anna Weber') and status in ('booked', 'arrived') order by (guest_name = 'Dan Fischer') desc limit 1;
  if v_bk is not null then
    perform demo.run(kc, format($q$select public.record_karaoke_deposit(jsonb_build_object('booking_id', %L, 'amount', 6000, 'method', 'cash', 'device_id', %L))$q$, v_bk, v_kdev));
  end if;
  perform demo.close_shift_exact(kc, 'Sing Along', 'Karaoke desk', -2000, 'THB 20.00 short');

  -- ── resort ─────────────────────────────────────────────────────────────────────────────────
  select id into v_f from public.folios where store_id = v_pr and guest_name = 'Liu Wei' and status = 'open' limit 1;
  if v_f is not null then
    v_res := demo.sell('cashier.kitchen.demo' || d, 'Island Kitchen', 'Counter 1', 'takeaway', null, '[{"n":"ข้าวกะเพราหมูสับ","q":2},{"n":"ชาเย็น","q":2}]', null, 0,
                       'cashier.kitchen.demo' || d, 'Counter 1', jsonb_build_array(jsonb_build_object('t', 'room', 'f', v_f::text)), null);
    perform demo.val(rr, format($q$select public.folio_post_nights(%L)::text$q$, v_f));
    perform demo.val(rr, format($q$select public.folio_settle(jsonb_build_object('folio_id', %L, 'method', 'cash', 'device_id', %L))::text$q$, v_f, demo.device('Palm Resort', 'Front desk')));
  end if;
  raise notice 'full tours/karaoke/resort: tour bill paid with deposit, no-show fee kept, cancellation refunded, 3 karaoke bills, Liu checked out in cash';
end $$;
