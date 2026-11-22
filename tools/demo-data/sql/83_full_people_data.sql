-- Demo "full" step, part 4: the people-side data every screen needs to show: hair styles, client notes (colour formula), spa health forms, a stylist's day off and a weekly break,
-- planned shifts and timesheet corrections, an API key (the key itself is thrown away), an AI budget, usage counts for the analytics page and a guest who stops sharing points with one business.
-- Safe to run again: it stops when its marker exists.
do $$
declare
  o text := 'owner.demo@bestiedemo.example'; d text := '@bestiedemo.example'; v_org uuid := demo.org(); mg text := 'manager.demo@bestiedemo.example';
  v_sal uuid := demo.store('Sunset Salon'); v_spa uuid := demo.store('Lotus Spa'); v_ik uuid := demo.store('Island Kitchen'); v_res uuid; v_res2 uuid; r record; v_pass text; v_net uuid; i int;
  v_today text := to_char((now() at time zone 'Asia/Bangkok')::date, 'YYYY-MM-DD');
begin
  if v_org is null then raise exception 'run setup first (there is no demo organisation)'; end if;
  if exists (select 1 from public.hair_styles where store_id = v_sal) then raise notice 'full people data already there'; return; end if;

  -- the salon's hair styles (the guest advisor picks among these by fixed rules)
  for r in select * from (values
    ('{"th":"บ๊อบสั้น","en":"Short bob"}', '{"en":"Chin-length, sleek"}', '["short","medium"]', '["straight","wavy"]', '["oval","heart","round"]', 'low'),
    ('{"th":"เลเยอร์ยาว","en":"Long layers"}', '{"en":"Soft movement, easy to wear"}', '["long"]', '["straight","wavy","curly"]', '["oval","square"]', 'medium'),
    ('{"th":"พิกซี่คัท","en":"Pixie cut"}', '{"en":"Short and bold"}', '["short"]', '["straight","wavy"]', '["oval","heart"]', 'high'))
    as t(name, about, lengths, textures, faces, upkeep) loop
    perform demo.val(mg, format($q$select public.save_hair_style(jsonb_build_object('store_id', %L, 'name', %L::jsonb, 'about', %L::jsonb, 'lengths', %L::jsonb, 'textures', %L::jsonb, 'faces', %L::jsonb, 'upkeep', %L))::text$q$,
      v_sal, r.name, r.about, r.lengths, r.textures, r.faces, r.upkeep));
  end loop;

  -- client records: a colour formula at the salon, two health forms signed at the spa counter (with the guest's consent)
  perform demo.val('reception.salon.demo' || d, format($q$select public.add_client_note(jsonb_build_object('store_id', %L, 'customer_id', %L, 'kind', 'formula', 'title', 'Colour', 'body', '6.1 + 7.0 1:1, 20 vol, 35 min, toner 9.1'))::text$q$, v_sal, demo.cust('66800000101')));
  perform demo.val('reception.salon.demo' || d, format($q$select public.add_client_note(jsonb_build_object('store_id', %L, 'customer_id', %L, 'kind', 'note', 'title', 'Preference', 'body', 'Likes a quiet corner, no head massage'))::text$q$, v_sal, demo.cust('66800000101')));
  perform demo.val('reception.spa.demo' || d, format($q$select public.save_health_intake(jsonb_build_object('store_id', %L, 'customer_id', %L, 'consent', true, 'signed_name', 'Kenji Sato',
    'answers', jsonb_build_object('pregnant', false, 'high_bp', false, 'heart', false, 'diabetes', false, 'skin', false, 'allergies', 'none', 'injuries', 'old knee injury', 'medications', '', 'other', '')))::text$q$, v_spa, demo.cust('66800000102')));
  perform demo.val('reception.spa.demo' || d, format($q$select public.save_health_intake(jsonb_build_object('store_id', %L, 'customer_id', %L, 'consent', true, 'signed_name', 'Dana Cohen',
    'answers', jsonb_build_object('pregnant', true, 'high_bp', false, 'heart', false, 'diabetes', false, 'skin', true, 'allergies', 'nut oils', 'injuries', '', 'medications', '', 'other', 'second trimester')))::text$q$, v_spa, demo.cust('66800000105')));

  -- a stylist's day off (next Monday-ish: 5 days ahead) and a weekly lunch break
  select id into v_res from public.resources where store_id = v_sal and kind = 'stylist' and active order by sort limit 1;
  if v_res is not null then
    perform demo.val(mg, format($q$select public.save_resource_block(jsonb_build_object('store_id', %L, 'resource_id', %L, 'starts_at', %L, 'ends_at', %L, 'reason', 'Day off (demo)'))::text$q$,
      v_sal, v_res, to_char((now() at time zone 'Asia/Bangkok')::date + 5, 'YYYY-MM-DD') || 'T00:00:00+07:00', to_char((now() at time zone 'Asia/Bangkok')::date + 6, 'YYYY-MM-DD') || 'T00:00:00+07:00'));
    perform demo.val(mg, format($q$select public.save_weekly_off(jsonb_build_object('store_id', %L, 'resource_id', %L, 'weekdays', '[1,2,3,4,5]'::jsonb, 'from_time', '12:30', 'to_time', '13:30', 'reason', 'Lunch'))::text$q$, v_sal, v_res))::text;
  end if;

  -- planned shifts for the next three days and the time clock of yesterday (a manager types what the paper sheet said)
  for r in select staff_key from (values ('cashier.kitchen.demo'), ('waiter.kitchen.demo'), ('kds.kitchen.demo')) as t(staff_key) loop
    for i in 1..3 loop
      perform demo.val(mg, format($q$select public.save_planned_shift(jsonb_build_object('store_id', %L, 'staff_id', %L, 'starts_at', %L, 'ends_at', %L))::text$q$,
        v_ik, demo.staff(r.staff_key || d), to_char((now() at time zone 'Asia/Bangkok')::date + i, 'YYYY-MM-DD') || 'T10:00:00+07:00', to_char((now() at time zone 'Asia/Bangkok')::date + i, 'YYYY-MM-DD') || 'T18:00:00+07:00'));
    end loop;
    perform demo.val(mg, format($q$select public.save_time_entry(jsonb_build_object('store_id', %L, 'staff_id', %L, 'clock_in', %L, 'clock_out', %L, 'note', 'From the paper sheet (demo)'))::text$q$,
      v_ik, demo.staff(r.staff_key || d), to_char((now() at time zone 'Asia/Bangkok')::date - 1, 'YYYY-MM-DD') || 'T10:05:00+07:00', to_char((now() at time zone 'Asia/Bangkok')::date - 1, 'YYYY-MM-DD') || 'T18:10:00+07:00'));
  end loop;

  update public.stores set plan = case when plan = 'basic' then 'pro' else plan end, module_overrides = coalesce(module_overrides, '{}'::jsonb) || '{"integration.hub": true}'::jsonb where id in (v_ik, demo.store('Breeze Café'));
  -- the owner's accountant gets a read-only API key (the key is shown once; this demo throws it away), and the AI budget of the business is THB 500 a month
  perform demo.val(o, format($q$select (public.create_api_key(jsonb_build_object('org_id', %L, 'name', 'Accountant software (demo)')) ->> 'id')$q$, v_org));
  perform demo.run(o, format($q$select public.set_ai_budget(%L, 50000)$q$, v_org));

  -- usage counts for the analytics page: each person opens a few screens (the app's own counter, once a day per person and screen)
  for r in select email from (values ('owner.demo'), ('manager.demo'), ('cashier.kitchen.demo'), ('cashier.cafe.demo'), ('reception.spa.demo'), ('stockkeeper.demo'), ('accountant.demo')) as t(email) loop
    perform demo.run(r.email || d, $q$select public.track_event('active')$q$);
    perform demo.run(r.email || d, $q$select public.track_event('page_view', 'sell')$q$);
    perform demo.run(r.email || d, $q$select public.track_event('page_view', 'reports')$q$);
  end loop;

  -- a Tourist Pass holder switches off sharing with one business (the guest page does this with her own link)
  select token, network_id into v_pass, v_net from public.network_passes order by created_at limit 1;
  if v_pass is not null then
    perform demo.svc(format($q$select public.guest_pass_set_block(%L, %L, true)::text$q$, v_pass, (select org_id from public.network_orgs where network_id = v_net order by joined_at desc limit 1)));
  end if;
  raise notice 'full people data: hair styles, notes, health forms, day off + weekly break, planned shifts + timesheet, API key, AI budget, usage counts, pass block';
end $$;
