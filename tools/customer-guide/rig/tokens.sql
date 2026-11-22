-- run on the local demo database, write the result to /tmp/cm/tokens.json (the screenshot scripts read it)
select json_build_object(
  'stores', (select json_agg(json_build_object('name', name, 'profile', profile, 'book', booking_token, 'tour', tour_token, 'kb', karaoke_booking_token)) from stores),
  'tables', (select json_agg(json_build_object('store', s.name, 'kind', t.kind, 'name', t.name, 'token', t.qr_token)) from dining_tables t join stores s on s.id = t.store_id),
  'rooms',  (select json_agg(json_build_object('name', r.name, 'token', r.qr_token)) from karaoke_rooms r),
  'passes', (select json_agg(json_build_object('name', name, 'code', code, 'token', token)) from network_passes));
