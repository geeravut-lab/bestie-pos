-- Spa / yoga advisor: the gate (module + therapist sign-off), tagging services, what the guest page may read.
\set ON_ERROR_STOP on
\set QUIET on

create or replace function t_exec(uid uuid, role_name text, q text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  perform set_config('request.jwt.claim.role', role_name, true);
  execute format('set local role %I', role_name);
  execute q;
  get diagnostics n = row_count;
  execute 'reset role';
  return n;
end $$;
create or replace function t_rows(uid uuid, role_name text, q text, expected bigint, label text) returns void language plpgsql as $$
declare n bigint;
begin
  n := t_exec(uid, role_name, q);
  if n is distinct from expected then raise exception 'FAIL % — expected % rows, got %', label, expected, n; end if;
  raise notice 'PASS %', label;
end $$;
create or replace function t_err(uid uuid, role_name text, q text, state text, label text) returns void language plpgsql as $$
begin
  begin
    perform t_exec(uid, role_name, q);
  exception when others then
    if sqlstate = state then raise notice 'PASS %', label; return; end if;
    raise exception 'FAIL % — expected SQLSTATE %, got % (%)', label, state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL % — expected an error (%), none raised', label, state;
end $$;

-- text-returning helper: run a query as a user, store its single value
create table t_out (k text primary key, v text);
create or replace function t_val(uid uuid, role_name text, key_ text, q text) returns void language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  perform set_config('request.jwt.claim.role', role_name, true);
  execute format('set local role %I', role_name);
  execute q into r;
  execute 'reset role';
  insert into t_out values (key_, r) on conflict (k) do update set v = excluded.v;
end $$;
grant all on t_out to authenticated, service_role;
grant execute on function t_val(uuid, text, text, text) to authenticated, service_role;








insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('X','X','nightclub')$$, '22023', 'an unknown profile is still refused');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Sing Co','Sing Along','karaoke')$$, 1, 'the owner creates a karaoke shop');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Sing Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Sing Along'$$);
select t_rows(null, 'service_role', $$select 1 where public.karaoke_enabled((select v::uuid from t_out where k='store')) and public.karaoke_songs_enabled((select v::uuid from t_out where k='store'))$$, 1, 'the karaoke profile has rooms and songs on');
update public.stores set module_overrides = '{"karaoke.rooms": true, "karaoke.songs": false}' where name = 'Sing Along';
select t_rows(null, 'service_role', $$select 1 where public.karaoke_enabled((select v::uuid from t_out where k='store')) and not public.karaoke_songs_enabled((select v::uuid from t_out where k='store'))$$, 1, 'the module ids are accepted and each can be switched off');
update public.stores set module_overrides = '{}' where name = 'Sing Along';

-- ── arithmetic ──
select t_rows(null, 'service_role', $$select 1 where public.karaoke_billed_minutes(0, 60, 15) = 60 and public.karaoke_billed_minutes(3600, 60, 15) = 60 and public.karaoke_billed_minutes(3601, 60, 15) = 75
  and public.karaoke_billed_minutes(1, 0, 15) = 15 and public.karaoke_billed_minutes(0, 0, 15) = 0 and public.karaoke_billed_minutes(4200, 30, 30) = 90$$, 1, 'billed minutes: rounded up to a step, never below the shortest time');
select t_rows(null, 'service_role', $$select 1 where public.karaoke_amount(30000, 75) = 37500 and public.karaoke_amount(10000, 20) = 3333 and public.karaoke_amount(10001, 1) = 167 and public.karaoke_amount(0, 60) = 0$$, 1, 'amount: rate x minutes / 60, rounded half up, in whole satang');

-- ── rooms ──
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_karaoke_room(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'VIP 1', 'rate_per_hour', 30000))$$, '42501', 'a cashier cannot create a room');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'room', $$select public.save_karaoke_room(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'VIP 1', 'rate_per_hour', 30000, 'min_minutes', 60, 'step_minutes', 15))::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'room2', $$select public.save_karaoke_room(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Free room', 'rate_per_hour', 0, 'min_minutes', 0))::text$$);
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_karaoke_room(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'Bad', 'rate_per_hour', 100, 'step_minutes', 7))$$, '23514', 'the step is one of the allowed sizes');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into public.karaoke_rooms (org_id, store_id, name, rate_per_hour) select org_id, id, 'Sneaky', 1 from public.stores where name = 'Sing Along'$$, '42501', 'no direct writes');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select qr_token from public.karaoke_rooms$$, '42501', 'the QR token is not readable with a plain select');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_room_links((select v::uuid from t_out where k='store'))$$, '42501', 'a cashier cannot read the room QR tokens');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'tok', $$select e ->> 'token' from jsonb_array_elements(public.karaoke_room_links((select v::uuid from t_out where k='store'))) e where e ->> 'id' = (select v from t_out where k='room')$$);
select t_rows(null, 'service_role', $$select 1 where (select v from t_out where k='tok') = (select qr_token from public.karaoke_rooms where id = (select v::uuid from t_out where k='room'))$$, 1, 'the owner reads the token of the first room');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'tok2', $$select e ->> 'token' from jsonb_array_elements(public.karaoke_room_links((select v::uuid from t_out where k='store'), (select v::uuid from t_out where k='room'))) e where e ->> 'id' = (select v from t_out where k='room')$$);
select t_rows(null, 'service_role', $$select 1 where (select v from t_out where k='tok2') <> (select v from t_out where k='tok')$$, 1, 'a new QR replaces the old token');

-- ── before the room is started the guests cannot queue ──
select t_val(null, 'service_role', 'g0', $$select public.guest_karaoke_request((select v from t_out where k='tok2'), '{"video_id":"dQw4w9WgXcQ","title":"A song"}')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='g0' and (v::jsonb ->> 'error') = 'not_in_use'$$, 1, 'no session, no queue');
select t_val(null, 'service_role', 'info0', $$select public.guest_karaoke_room((select v from t_out where k='tok2'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='info0' and (v::jsonb ->> 'running') = 'false' and (v::jsonb ->> 'room') = 'VIP 1'$$, 1, 'the guest page says the room is not running');
select t_rows(null, 'service_role', $$select 1 where public.guest_karaoke_room('0123456789abcdef0123456789abcdef') is null and public.guest_karaoke_room((select v from t_out where k='tok')) is null$$, 1, 'an unknown link and the replaced old link find nothing');
select t_err(null, 'anon', $$select public.guest_karaoke_room((select v from t_out where k='tok2'))$$, '42501', 'the browser cannot call the guest function');

-- ── the timer ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'sess', $$select public.karaoke_start((select v::uuid from t_out where k='room'), 4)::text$$);
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_start((select v::uuid from t_out where k='room'))$$, '55000', 'a room in use cannot be started again');

-- ── songs ──
select t_val(null, 'service_role', 'g1', $$select public.guest_karaoke_request((select v from t_out where k='tok2'), '{"video_id":"dQw4w9WgXcQ","title":"Song one","client_id":"11111111-1111-1111-1111-111111111111"}')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='g1' and (v::jsonb ->> 'ok') = 'true'$$, 1, 'a guest queues a song');
select t_val(null, 'service_role', 'g1b', $$select public.guest_karaoke_request((select v from t_out where k='tok2'), '{"video_id":"dQw4w9WgXcQ","title":"Song one","client_id":"11111111-1111-1111-1111-111111111111"}')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out a, t_out b where a.k='g1' and b.k='g1b' and (a.v::jsonb ->> 'id') = (b.v::jsonb ->> 'id')$$, 1, 'the same tap again returns the first answer');
select t_val(null, 'service_role', 'g2', $$select public.guest_karaoke_request((select v from t_out where k='tok2'), '{"video_id":"dQw4w9WgXcQ","title":"Song one again","client_id":"22222222-2222-2222-2222-222222222222"}')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='g2' and (v::jsonb ->> 'error') = 'repeat'$$, 1, 'the same song twice is refused');
select t_val(null, 'service_role', 'g3', $$select public.guest_karaoke_request((select v from t_out where k='tok2'), '{"video_id":"not-an-id","title":"x"}')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='g3' and (v::jsonb ->> 'error') = 'invalid'$$, 1, 'only a real 11-character video id is accepted');
select t_val(null, 'service_role', 'g4', $$select public.guest_karaoke_request((select v from t_out where k='tok2'), '{"video_id":"AAAAAAAAAAA","title":"Two"}')::text$$);
select t_val(null, 'service_role', 'g5', $$select public.guest_karaoke_request((select v from t_out where k='tok2'), '{"video_id":"BBBBBBBBBBB","title":"Three"}')::text$$);
select t_val(null, 'service_role', 'g6', $$select public.guest_karaoke_request((select v from t_out where k='tok2'), '{"video_id":"CCCCCCCCCCC","title":"Four"}')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='g6' and (v::jsonb ->> 'error') = 'full'$$, 1, 'at most 3 songs wait');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'staffadd', $$select public.karaoke_staff_add_song((select v::uuid from t_out where k='room'), 'CCCCCCCCCCC', 'Four (staff)')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='staffadd' and (v::jsonb ->> 'ok') = 'true'$$, 1, 'staff may queue past the guest limit');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_song_set((select (v::jsonb ->> 'id')::uuid from t_out where k='g1'), 'playing')$$, 1, 'staff start a song');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_song_set((select (v::jsonb ->> 'id')::uuid from t_out where k='g4'), 'playing')$$, 1, 'starting the next song finishes the one that was playing');
select t_rows(null, 'service_role', $$select 1 where (select status from public.karaoke_songs where id = (select (v::jsonb ->> 'id')::uuid from t_out where k='g1')) = 'done'
  and (select status from public.karaoke_songs where id = (select (v::jsonb ->> 'id')::uuid from t_out where k='g4')) = 'playing'$$, 1, 'one song plays at a time');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_song_set((select (v::jsonb ->> 'id')::uuid from t_out where k='g1'), 'playing')$$, '55000', 'a finished song cannot be started again');
select t_val(null, 'service_role', 'rm', $$select public.guest_karaoke_remove((select v from t_out where k='tok2'), (select (v::jsonb ->> 'id')::uuid from t_out where k='g5'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='rm' and v = 'true'$$, 1, 'a guest can take a waiting song off');
select t_val(null, 'service_role', 'info1', $$select public.guest_karaoke_room((select v from t_out where k='tok2'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='info1' and (v::jsonb ->> 'running') = 'true' and jsonb_array_length(v::jsonb -> 'queue') = 2 and (v::jsonb -> 'queue' -> 0 ->> 'status') = 'playing'$$, 1, 'the page lists the playing song first, then the waiting ones');

-- ── stop the clock: the database clock decides ──
update public.karaoke_sessions set started_at = now() - interval '70 minutes';
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'stop', $$select public.karaoke_stop((select v::uuid from t_out where k='sess'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='stop' and (v::jsonb ->> 'billed_minutes') = '75' and (v::jsonb ->> 'amount') = '37500'$$, 1, '70 minutes at 300 baht an hour is billed as 75 minutes = 375 baht');
select t_rows(null, 'service_role', $$select 1 where not exists (select 1 from public.karaoke_songs where status in ('queued','playing'))$$, 1, 'stopping the room clears the queue');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'stop2', $$select public.karaoke_stop((select v::uuid from t_out where k='sess'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='stop2' and (v::jsonb ->> 'amount') = '37500'$$, 1, 'stopping twice gives the same answer');
select t_val(null, 'service_role', 'g7', $$select public.guest_karaoke_request((select v from t_out where k='tok2'), '{"video_id":"DDDDDDDDDDD","title":"Late"}')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='g7' and (v::jsonb ->> 'error') = 'not_in_use'$$, 1, 'after the stop the guests cannot queue');

-- ── the bill ──
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ord', $$select public.karaoke_to_order((select v::uuid from t_out where k='sess'))::text$$);
select t_rows(null, 'service_role', $$select 1 from public.orders o join public.order_lines l on l.order_id = o.id
   where o.id = (select v::uuid from t_out where k='ord') and o.number = 'KR001' and o.status = 'open' and o.channel = 'takeaway' and l.unit_price = 37500 and l.quantity = 1$$, 1, 'an ordinary open bill KR001 with one line at the billed amount');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ord2', $$select public.karaoke_to_order((select v::uuid from t_out where k='sess'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out a, t_out b where a.k='ord' and b.k='ord2' and a.v = b.v$$, 1, 'asking twice returns the same bill');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'sess2', $$select public.karaoke_start((select v::uuid from t_out where k='room2'))::text$$);
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_stop((select v::uuid from t_out where k='sess2'))$$, 1, 'a free room can be stopped');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_to_order((select v::uuid from t_out where k='sess2'))$$, '22023', 'a session worth nothing makes no bill');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_to_order((select v::uuid from t_out where k='sess'), null) where false union all select public.karaoke_to_order(gen_random_uuid())$$, '42501', 'an unknown session is refused');

-- a switched-off module stops the timer
update public.stores set module_overrides = '{"karaoke.rooms": false}' where name = 'Sing Along';
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.karaoke_start((select v::uuid from t_out where k='room'))$$, '0A000', 'with the module off a room cannot be started');

select 'ALL KARAOKE TESTS PASSED';
