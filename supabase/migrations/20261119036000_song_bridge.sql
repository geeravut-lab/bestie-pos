-- Bestie Song Bridge (owner order 8.1): a small program in the room (a mini PC, a Raspberry Pi, a phone) that asks Bestie "which song is next?" and drives the
-- venue's own karaoke system (a command the shop chooses: adb to an Android TV, a keyboard emulator, an IR blaster, a player on the PC).
-- It only ever PULLS over HTTPS (nothing opens a port in the shop). Its key is one random token per room, shown once; only the SHA-256 is stored.
alter table public.karaoke_rooms add column bridge_hash text check (bridge_hash is null or bridge_hash ~ '^[0-9a-f]{64}$');
alter table public.karaoke_rooms add column bridge_hint text check (bridge_hint is null or length(bridge_hint) = 4);
alter table public.karaoke_rooms add column bridge_seen_at timestamptz;
create unique index karaoke_rooms_bridge_uidx on public.karaoke_rooms (bridge_hash) where bridge_hash is not null;
-- (the browser's column-level select grant on karaoke_rooms does not include these columns, so a token hash is never readable by a person)

-- staff: make (or replace) the bridge key of ONE room; the key is shown once (menu.edit, audited)
create or replace function public.rotate_karaoke_bridge(p_room uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare r public.karaoke_rooms%rowtype; v_token text;
begin
  select * into r from public.karaoke_rooms where id = p_room;
  if not found or not public.can_edit_menu(r.store_id) then raise exception 'the song bridge key needs menu.edit in this shop' using errcode = '42501'; end if;
  if not public.karaoke_songs_enabled(r.store_id) then raise exception 'the karaoke songs module is off in this shop' using errcode = '0A000'; end if;
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  update public.karaoke_rooms set bridge_hash = encode(sha256(convert_to(v_token, 'utf8')), 'hex'), bridge_hint = right(v_token, 4), bridge_seen_at = null where id = r.id;
  perform public.audit_record(r.org_id, r.store_id, 'settings.change', 'karaoke_rooms.bridge', r.id::text, jsonb_build_object('rotated', true), 'db');
  return v_token;
end $$;
revoke all on function public.rotate_karaoke_bridge(uuid) from public, anon;
grant execute on function public.rotate_karaoke_bridge(uuid) to authenticated, service_role;

-- staff: switch the bridge of a room off
create or replace function public.revoke_karaoke_bridge(p_room uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.karaoke_rooms%rowtype;
begin
  select * into r from public.karaoke_rooms where id = p_room;
  if not found or not public.can_edit_menu(r.store_id) then raise exception 'the song bridge key needs menu.edit in this shop' using errcode = '42501'; end if;
  update public.karaoke_rooms set bridge_hash = null, bridge_hint = null, bridge_seen_at = null where id = r.id;
  perform public.audit_record(r.org_id, r.store_id, 'settings.change', 'karaoke_rooms.bridge', r.id::text, jsonb_build_object('revoked', true), 'db');
end $$;
revoke all on function public.revoke_karaoke_bridge(uuid) from public, anon;
grant execute on function public.revoke_karaoke_bridge(uuid) to authenticated, service_role;

-- when each room's bridge key was made / last used (menu.edit)
create or replace function public.karaoke_bridge_status(p_store uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can_edit_menu(p_store) then raise exception 'needs menu.edit in this shop' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('room_id', r.id, 'on', r.bridge_hash is not null, 'hint', r.bridge_hint, 'seen_at', r.bridge_seen_at) order by r.sort, r.name)
                   from public.karaoke_rooms r where r.store_id = p_store), '[]'::jsonb);
end $$;
revoke all on function public.karaoke_bridge_status(uuid) from public, anon;
grant execute on function public.karaoke_bridge_status(uuid) to authenticated, service_role;

-- the bridge asks (service role, behind /api/karaoke/bridge): what is playing and what waits, in order
create or replace function public.bridge_karaoke_poll(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.karaoke_rooms%rowtype; x public.karaoke_sessions%rowtype;
begin
  select * into r from public.karaoke_rooms where p_token ~ '^[0-9a-f]{64}$' and bridge_hash = encode(sha256(convert_to(p_token, 'utf8')), 'hex') and active;
  if not found or not public.karaoke_songs_enabled(r.store_id) then return jsonb_build_object('ok', false, 'error', 'unauthorized'); end if;
  update public.karaoke_rooms set bridge_seen_at = now() where id = r.id;
  select * into x from public.karaoke_sessions where room_id = r.id and ended_at is null order by started_at desc limit 1;
  if not found then return jsonb_build_object('ok', true, 'room', r.name, 'running', false, 'now', null, 'queue', '[]'::jsonb); end if;
  return jsonb_build_object('ok', true, 'room', r.name, 'running', true,
    'now', (select jsonb_build_object('id', g.id, 'video_id', g.video_id, 'title', g.title) from public.karaoke_songs g where g.session_id = x.id and g.status = 'playing' order by g.started_at desc limit 1),
    'queue', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'video_id', g.video_id, 'title', g.title) order by g.requested_at)
                       from (select * from public.karaoke_songs where session_id = x.id and status = 'queued' order by requested_at limit 20) g), '[]'::jsonb));
end $$;
revoke all on function public.bridge_karaoke_poll(text) from public, anon, authenticated;
grant execute on function public.bridge_karaoke_poll(text) to service_role;

-- the bridge reports: it started a song ('playing'), the song ended ('done') or it cannot be played ('removed'); only songs of its own room
create or replace function public.bridge_karaoke_song(p_token text, p_song uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.karaoke_rooms%rowtype; g public.karaoke_songs%rowtype;
begin
  select * into r from public.karaoke_rooms where p_token ~ '^[0-9a-f]{64}$' and bridge_hash = encode(sha256(convert_to(p_token, 'utf8')), 'hex') and active;
  if not found or not public.karaoke_songs_enabled(r.store_id) then return jsonb_build_object('ok', false, 'error', 'unauthorized'); end if;
  select * into g from public.karaoke_songs where id = p_song and room_id = r.id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'unknown_song'); end if;
  update public.karaoke_rooms set bridge_seen_at = now() where id = r.id;
  if p_status = 'playing' and g.status = 'queued' then
    update public.karaoke_songs set status = 'done' where room_id = g.room_id and status = 'playing';
    update public.karaoke_songs set status = 'playing', started_at = now() where id = g.id;
  elsif p_status = 'playing' and g.status = 'playing' then
    null; -- a repeated report is fine
  elsif p_status = 'done' and g.status in ('playing', 'done') then
    update public.karaoke_songs set status = 'done' where id = g.id and status = 'playing';
  elsif p_status = 'removed' and g.status in ('queued', 'playing', 'removed') then
    update public.karaoke_songs set status = 'removed' where id = g.id and status <> 'removed';
  else
    return jsonb_build_object('ok', false, 'error', 'invalid_state');
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.bridge_karaoke_song(text, uuid, text) from public, anon, authenticated;
grant execute on function public.bridge_karaoke_song(text, uuid, text) to service_role;
