-- Bestie Song Bridge: the room key, polling, reporting; only its own room.
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
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Sing Co','Sing Along','karaoke')$$, 1, 'owner creates a karaoke shop');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other Co','Other','cafe')$$, 1, 'another business exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Sing Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Sing Along'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'room', $$select public.save_karaoke_room(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'VIP 1', 'rate_per_hour', 30000, 'min_minutes', 60, 'step_minutes', 15))::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'tok', $$select e ->> 'token' from jsonb_array_elements(public.karaoke_room_links((select v::uuid from t_out where k='store'))) e where e ->> 'id' = (select v from t_out where k='room')$$);

select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 's1', $$select public.karaoke_start((select v::uuid from t_out where k='room'), 3)::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'g1', $$select (public.karaoke_staff_add_song((select v::uuid from t_out where k='room'), 'dQw4w9WgXcQ', 'Song one') ->> 'id')$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'g2', $$select (public.karaoke_staff_add_song((select v::uuid from t_out where k='room'), 'aaaaaaaaaaa', 'Song two') ->> 'id')$$);

-- the key
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.rotate_karaoke_bridge((select v::uuid from t_out where k='room'))$$, '42501', 'a cashier cannot make a bridge key');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'bt', $$select public.rotate_karaoke_bridge((select v::uuid from t_out where k='room'))$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='bt' and v ~ '^[0-9a-f]{64}$'$$, 1, 'the key is 64 hex characters');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select bridge_hash from public.karaoke_rooms$$, '42501', 'the key hash cannot be read from the browser');
select t_rows(null, 'service_role', $$select 1 from public.karaoke_rooms where bridge_hash is not null and bridge_hash <> (select v from t_out where k='bt')$$, 1, 'only the hash is stored');

-- polling
select t_val(null, 'service_role', 'p0', $$select public.bridge_karaoke_poll('00')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='p0' and (v::jsonb ->> 'ok') = 'false'$$, 1, 'a wrong key is refused');
select t_val(null, 'service_role', 'p1', $$select public.bridge_karaoke_poll((select v from t_out where k='bt'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='p1' and (v::jsonb ->> 'running') = 'true' and jsonb_array_length(v::jsonb -> 'queue') = 2 and (v::jsonb -> 'now') = 'null'::jsonb and (v::jsonb -> 'queue' -> 0 ->> 'video_id') = 'dQw4w9WgXcQ'$$, 1, 'the queue comes in order');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from jsonb_array_elements(public.karaoke_bridge_status((select v::uuid from t_out where k='store'))) e where (e ->> 'on') = 'true' and e ->> 'seen_at' is not null$$, 1, 'the owner sees the bridge was seen');
select t_err(null, 'authenticated', $$select public.bridge_karaoke_poll('00')$$, '42501', 'the browser cannot call the bridge function');

-- reporting
select t_val(null, 'service_role', 'r1', $$select public.bridge_karaoke_song((select v from t_out where k='bt'), (select v::uuid from t_out where k='g1'), 'playing')::text$$);
select t_rows(null, 'service_role', $$select 1 from public.karaoke_songs where id = (select v::uuid from t_out where k='g1') and status = 'playing'$$, 1, 'a queued song starts');
select t_val(null, 'service_role', 'r2', $$select public.bridge_karaoke_song((select v from t_out where k='bt'), (select v::uuid from t_out where k='g2'), 'playing')::text$$);
select t_rows(null, 'service_role', $$select 1 from public.karaoke_songs where id = (select v::uuid from t_out where k='g1') and status = 'done'$$, 1, 'starting the next one finishes the previous');
select t_val(null, 'service_role', 'r3', $$select public.bridge_karaoke_song((select v from t_out where k='bt'), (select v::uuid from t_out where k='g1'), 'playing')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r3' and (v::jsonb ->> 'ok') = 'false'$$, 1, 'a finished song cannot start again');
select t_val(null, 'service_role', 'r4', $$select public.bridge_karaoke_song((select v from t_out where k='bt'), (select v::uuid from t_out where k='g2'), 'done')::text$$);
select t_rows(null, 'service_role', $$select 1 from public.karaoke_songs where id = (select v::uuid from t_out where k='g2') and status = 'done'$$, 1, 'the bridge finishes a song');
select t_val(null, 'service_role', 'r5', $$select public.bridge_karaoke_song((select v from t_out where k='bt'), gen_random_uuid(), 'done')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r5' and (v::jsonb ->> 'error') = 'unknown_song'$$, 1, 'an unknown song is refused');

-- a second room's key cannot touch the first room's songs
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'room2', $$select public.save_karaoke_room(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'VIP 2', 'rate_per_hour', 30000))::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'bt2', $$select public.rotate_karaoke_bridge((select v::uuid from t_out where k='room2'))$$);
select t_val(null, 'service_role', 'r6', $$select public.bridge_karaoke_song((select v from t_out where k='bt2'), (select v::uuid from t_out where k='g1'), 'removed')::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='r6' and (v::jsonb ->> 'error') = 'unknown_song'$$, 1, 'a key of another room cannot change this room');

-- replacing and revoking
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'bt_new', $$select public.rotate_karaoke_bridge((select v::uuid from t_out where k='room'))$$);
select t_val(null, 'service_role', 'p2', $$select public.bridge_karaoke_poll((select v from t_out where k='bt'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='p2' and (v::jsonb ->> 'ok') = 'false'$$, 1, 'the old key stops at once');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.revoke_karaoke_bridge((select v::uuid from t_out where k='room'))$$, 1, 'the owner switches the bridge off');
select t_val(null, 'service_role', 'p3', $$select public.bridge_karaoke_poll((select v from t_out where k='bt_new'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='p3' and (v::jsonb ->> 'ok') = 'false'$$, 1, 'a revoked key is refused');
\echo ALL SONG BRIDGE TESTS PASSED
