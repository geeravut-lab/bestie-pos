-- Demo: a KARAOKE shop "Sing Along" in the demo group (needs migrations 70 and 73): three rooms, two time packages, a room running with a package and a song queue, a reservation for tomorrow evening.
-- Safe to run again: it stops when the shop exists.
do $$
declare
  o text := 'owner.demo@bestiedemo.example'; v_org uuid := demo.org(); r record; v_room uuid; v_pk uuid; v_sess text;
  v_tomorrow text := to_char(((now() at time zone 'Asia/Bangkok')::date + 1), 'YYYY-MM-DD');
begin
  if v_org is null then raise exception 'run setup first (there is no demo organisation)'; end if;
  if demo.store('Sing Along') is not null then raise notice 'karaoke demo already there'; return; end if;
  perform demo.val(o, format($q$select public.create_store(%L, 'Sing Along', 'karaoke')::text$q$, v_org));
  for r in select * from (values ('VIP 1', 40000, 60, 15, 1), ('VIP 2', 30000, 60, 15, 2), ('Mini', 20000, 30, 15, 3)) as t(name, rate, min_m, step_m, sort) loop
    perform demo.val(o, format($q$select public.save_karaoke_room(jsonb_build_object('store_id', %L, 'name', %L, 'rate_per_hour', %s, 'min_minutes', %s, 'step_minutes', %s, 'sort', %s))::text$q$,
      demo.store('Sing Along'), r.name, r.rate, r.min_m, r.step_m, r.sort));
  end loop;
  v_pk := demo.val(o, format($q$select public.save_karaoke_package(jsonb_build_object('store_id', %L, 'name', '1 hour', 'minutes', 60, 'price', 30000, 'sort', 1))::text$q$, demo.store('Sing Along')))::uuid;
  perform demo.val(o, format($q$select public.save_karaoke_package(jsonb_build_object('store_id', %L, 'name', '2 hours', 'minutes', 120, 'price', 52000, 'sort', 2))::text$q$, demo.store('Sing Along')));
  select id into v_room from public.karaoke_rooms where store_id = demo.store('Sing Along') and name = 'VIP 1';
  v_sess := demo.val(o, format($q$select public.karaoke_start(%L, 5, %L)::text$q$, v_room, v_pk));
  for r in select * from (values ('dQw4w9WgXcQ', 'Never Gonna Give You Up (karaoke)'), ('fJ9rUzIMcZQ', 'Bohemian Rhapsody (karaoke)'), ('kJQP7kiw5Fk', 'Despacito (karaoke)')) as t(vid, title) loop
    perform demo.val(o, format($q$select public.karaoke_staff_add_song(%L, %L, %L)::text$q$, v_room, r.vid, r.title));
  end loop;
  select id into v_room from public.karaoke_rooms where store_id = demo.store('Sing Along') and name = 'VIP 2';
  perform demo.val(o, format($q$select public.karaoke_book(jsonb_build_object('store_id', %L, 'room_id', %L, 'guest_name', 'Anna Weber', 'phone', '0999000101', 'guests', 6,
     'starts_at', %L, 'minutes', 120, 'note', 'Birthday'))::text$q$, demo.store('Sing Along'), v_room, v_tomorrow || 'T20:00:00+07:00'));
  raise notice 'karaoke demo: 3 rooms, 2 packages, VIP 1 running with 3 songs queued, a reservation for tomorrow 20:00';
end $$;
