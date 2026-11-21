-- Bestie POS · migration 70 · Karaoke profile: rooms, a server-side room timer, time billed as an ordinary bill, and a song queue (docs/KARAOKE-AI.md).
--
--  * A shop may choose the profile `karaoke`. Modules `karaoke.rooms` (rooms, timer, billing) and `karaoke.songs` (the guests' song queue) are data, as every module.
--  * A ROOM has a price per hour (satang), a shortest billed time and a rounding step (the time is billed in whole steps, never less than the shortest time).
--  * A SESSION is the time a group uses a room. Its clock is the DATABASE's clock (`started_at` / `ended_at`), so a tablet that is offline, slow or wrong cannot change what is
--    billed. The rate, shortest time and step are copied onto the session when it starts, so editing the room later never changes a running or past session.
--  * Stopping a session fixes the billed minutes and the amount; `karaoke_to_order` turns it into an ordinary open bill `KR001…` (one line), which the cashier pays like any
--    bill (cash, PromptPay, card, Credit, split, Points, receipt). Nothing here takes money by itself.
--  * The SONG QUEUE: a guest scans the room's QR (`/r/<token>`), searches a song and adds it. Only songs that exist on YouTube (an 11-character video id) can be queued — the
--    server looks songs up through the official YouTube Data API or the guest pastes a YouTube link; nothing is ever invented. Rules: the room must be in use, at most 3 songs
--    waiting, the same song not again within 10 minutes, at most 12 requests per room per 10 minutes. Staff can start, finish and remove songs.

-- ── the profile and the module ids ────────────────────────────────────────────
alter table public.stores drop constraint stores_profile_check;
alter table public.stores add constraint stores_profile_check
  check (profile in ('restaurant','cafe','salon','spa','resort','retail','tours','karaoke'));

do $$
declare r record; src text; dst text;
begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('create_org', 'create_store', 'stores_check_modules') loop
    src := pg_get_functiondef(r.oid);
    if r.proname = 'stores_check_modules' then
      dst := replace(src, $a$'advisor.spa'];$a$, $a$'advisor.spa','karaoke.rooms','karaoke.songs'];$a$);
    else
      dst := replace(src, $a$'retail','tours')$a$, $a$'retail','tours','karaoke')$a$);
    end if;
    if dst = src then raise exception 'migration 70: nothing to change in %', r.proname; end if;
    execute dst;
  end loop;
end $$;

create or replace function public.karaoke_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stores s
                  where s.id = p_store and s.deleted_at is null
                    and coalesce((s.module_overrides ->> 'karaoke.rooms')::boolean, s.profile = 'karaoke'))
$$;
revoke all on function public.karaoke_enabled(uuid) from public, anon;
grant execute on function public.karaoke_enabled(uuid) to authenticated, service_role;

create or replace function public.karaoke_songs_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.karaoke_enabled(p_store) and exists (select 1 from public.stores s
                  where s.id = p_store and s.plan in ('pro', 'resort')
                    and coalesce((s.module_overrides ->> 'karaoke.songs')::boolean, s.profile = 'karaoke'))
$$;
revoke all on function public.karaoke_songs_enabled(uuid) from public, anon;
grant execute on function public.karaoke_songs_enabled(uuid) to authenticated, service_role;

-- ── billing arithmetic (mirrored in packages/core/src/karaoke.ts, kept equal by a test) ─────────────
-- billed minutes = elapsed time rounded UP to a whole step, never below the shortest time
create or replace function public.karaoke_billed_minutes(p_elapsed_seconds integer, p_min integer, p_step integer) returns integer
language sql immutable set search_path = '' as $$
  select greatest(p_min, (((greatest(p_elapsed_seconds, 0) + 60 * p_step - 1) / (60 * p_step)) * p_step))
$$;
-- amount in satang = rate per hour x minutes / 60, rounded half up (integers only)
create or replace function public.karaoke_amount(p_rate integer, p_minutes integer) returns integer
language sql immutable set search_path = '' as $$
  select ((p_rate::bigint * p_minutes + 30) / 60)::integer
$$;
revoke all on function public.karaoke_billed_minutes(integer, integer, integer), public.karaoke_amount(integer, integer) from public, anon;
grant execute on function public.karaoke_billed_minutes(integer, integer, integer), public.karaoke_amount(integer, integer) to authenticated, service_role;

-- ── tables ───────────────────────────────────────────────────────────────────
create table public.karaoke_rooms (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs (id) on delete cascade,
  store_id      uuid not null references public.stores (id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 60),
  rate_per_hour integer not null check (rate_per_hour between 0 and 10000000),
  min_minutes   integer not null default 60 check (min_minutes between 0 and 600),
  step_minutes  integer not null default 15 check (step_minutes in (1, 5, 10, 15, 30, 60)),
  qr_token      text not null unique default replace(gen_random_uuid()::text, '-', '') check (qr_token ~ '^[0-9a-f]{32}$'),
  active        boolean not null default true,
  sort          integer not null default 0,
  created_at    timestamptz not null default now(),
  unique (store_id, name)
);
create index karaoke_rooms_store_idx on public.karaoke_rooms (store_id);

create table public.karaoke_sessions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs (id) on delete cascade,
  store_id       uuid not null references public.stores (id) on delete cascade,
  room_id        uuid not null references public.karaoke_rooms (id) on delete restrict,
  started_at     timestamptz not null default now(),
  ended_at       timestamptz,
  guests         integer check (guests is null or guests between 1 and 200),
  rate_per_hour  integer not null,
  min_minutes    integer not null,
  step_minutes   integer not null,
  billed_minutes integer,
  amount         integer,
  order_id       uuid references public.orders (id) on delete set null,
  started_by     uuid references public.staff (id) on delete set null,
  created_at     timestamptz not null default now(),
  check ((ended_at is null) = (billed_minutes is null) and (ended_at is null) = (amount is null)),
  check (ended_at is null or ended_at >= started_at)
);
create unique index karaoke_one_running on public.karaoke_sessions (room_id) where ended_at is null;
create index karaoke_sessions_store_idx on public.karaoke_sessions (store_id, started_at desc);

create table public.karaoke_songs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs (id) on delete cascade,
  store_id     uuid not null references public.stores (id) on delete cascade,
  room_id      uuid not null references public.karaoke_rooms (id) on delete cascade,
  session_id   uuid not null references public.karaoke_sessions (id) on delete cascade,
  video_id     text not null check (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  title        text not null check (length(btrim(title)) between 1 and 150),
  status       text not null default 'queued' check (status in ('queued', 'playing', 'done', 'removed')),
  source       text not null default 'guest' check (source in ('guest', 'staff')),
  client_id    uuid,
  requested_at timestamptz not null default now(),
  started_at   timestamptz,
  unique (room_id, client_id)
);
create index karaoke_songs_room_idx on public.karaoke_songs (room_id, requested_at);

alter table public.karaoke_rooms enable row level security;
alter table public.karaoke_sessions enable row level security;
alter table public.karaoke_songs enable row level security;
create policy karaoke_rooms_read on public.karaoke_rooms for select to authenticated using (public.can_access_store(org_id, store_id));
create policy karaoke_sessions_read on public.karaoke_sessions for select to authenticated using (public.can_access_store(org_id, store_id));
create policy karaoke_songs_read on public.karaoke_songs for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.karaoke_rooms, public.karaoke_sessions, public.karaoke_songs from anon, authenticated;
-- the QR token is the guests' only key: staff with menu.edit read it through `karaoke_room_links`, never a plain select
grant select (id, org_id, store_id, name, rate_per_hour, min_minutes, step_minutes, active, sort, created_at) on public.karaoke_rooms to authenticated;
grant select on public.karaoke_sessions, public.karaoke_songs to authenticated;

create trigger karaoke_rooms_live after insert or update on public.karaoke_rooms for each row execute function public.live_ping_row('store:{store_id}');
create trigger karaoke_sessions_live after insert or update on public.karaoke_sessions for each row execute function public.live_ping_row('store:{store_id}');
create trigger karaoke_songs_live after insert or update on public.karaoke_songs for each row execute function public.live_ping_row('store:{store_id}');

-- ── staff: rooms ─────────────────────────────────────────────────────────────
-- p = { store_id, id?, name, rate_per_hour, min_minutes?, step_minutes?, active?, sort? }   (menu.edit)
create or replace function public.save_karaoke_room(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; v_id uuid := nullif(p ->> 'id', '')::uuid; r public.karaoke_rooms%rowtype;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_edit_menu(s.id) then raise exception 'editing rooms needs menu.edit in this shop' using errcode = '42501'; end if;
  if not public.karaoke_enabled(s.id) then raise exception 'the karaoke module is off in this shop' using errcode = '0A000'; end if;
  if v_id is null then
    insert into public.karaoke_rooms (org_id, store_id, name, rate_per_hour, min_minutes, step_minutes, active, sort)
    values (s.org_id, s.id, btrim(p ->> 'name'), (p ->> 'rate_per_hour')::integer, coalesce((p ->> 'min_minutes')::integer, 60),
            coalesce((p ->> 'step_minutes')::integer, 15), coalesce((p ->> 'active')::boolean, true), coalesce((p ->> 'sort')::integer, 0))
    returning id into v_id;
  else
    select * into r from public.karaoke_rooms where id = v_id and store_id = s.id;
    if not found then raise exception 'unknown room' using errcode = '22023'; end if;
    update public.karaoke_rooms set name = coalesce(btrim(p ->> 'name'), name), rate_per_hour = coalesce((p ->> 'rate_per_hour')::integer, rate_per_hour),
           min_minutes = coalesce((p ->> 'min_minutes')::integer, min_minutes), step_minutes = coalesce((p ->> 'step_minutes')::integer, step_minutes),
           active = coalesce((p ->> 'active')::boolean, active), sort = coalesce((p ->> 'sort')::integer, sort)
     where id = v_id;
  end if;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'karaoke_rooms', v_id::text,
    jsonb_build_object('rate_per_hour', p -> 'rate_per_hour', 'min_minutes', p -> 'min_minutes', 'step_minutes', p -> 'step_minutes', 'active', p -> 'active'), 'db');
  return v_id;
end $$;

-- the QR address of every room (menu.edit only); p_rotate replaces ONE room's token (the old QR stops at once)
create or replace function public.karaoke_room_links(p_store uuid, p_rotate uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype;
begin
  select * into s from public.stores where id = p_store and deleted_at is null;
  if not found or not public.can_edit_menu(s.id) then raise exception 'the room QR needs menu.edit in this shop' using errcode = '42501'; end if;
  if p_rotate is not null then
    update public.karaoke_rooms set qr_token = replace(gen_random_uuid()::text, '-', '') where id = p_rotate and store_id = s.id;
    perform public.audit_record(s.org_id, s.id, 'settings.change', 'karaoke_rooms.qr', p_rotate::text, jsonb_build_object('rotated', true), 'db');
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'token', r.qr_token) order by r.sort, r.name) from public.karaoke_rooms r where r.store_id = s.id), '[]'::jsonb);
end $$;

-- ── staff: the timer ─────────────────────────────────────────────────────────
create or replace function public.karaoke_start(p_room uuid, p_guests integer default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.karaoke_rooms%rowtype; v_staff uuid; v_id uuid;
begin
  select * into r from public.karaoke_rooms where id = p_room for update;
  if not found or not (public.can_access_store(r.org_id, r.store_id) and public.has_permission(r.org_id, 'order.create')) then
    raise exception 'starting a room needs order.create in this shop' using errcode = '42501';
  end if;
  if not public.karaoke_enabled(r.store_id) then raise exception 'the karaoke module is off in this shop' using errcode = '0A000'; end if;
  if not r.active then raise exception 'this room is switched off' using errcode = '55000'; end if;
  if exists (select 1 from public.karaoke_sessions x where x.room_id = r.id and x.ended_at is null) then
    raise exception 'this room is already in use' using errcode = '55000';
  end if;
  select f.id into v_staff from public.staff f where f.org_id = r.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.karaoke_sessions (org_id, store_id, room_id, guests, rate_per_hour, min_minutes, step_minutes, started_by)
  values (r.org_id, r.store_id, r.id, p_guests, r.rate_per_hour, r.min_minutes, r.step_minutes, v_staff) returning id into v_id;
  return v_id;
end $$;

-- stop the clock: the billed minutes and the amount are fixed from the DATABASE clock; waiting songs are dropped
create or replace function public.karaoke_stop(p_session uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare x public.karaoke_sessions%rowtype; v_secs integer; v_min integer; v_amt integer;
begin
  select * into x from public.karaoke_sessions where id = p_session for update;
  if not found or not (public.can_access_store(x.org_id, x.store_id) and public.has_permission(x.org_id, 'order.create')) then
    raise exception 'stopping a room needs order.create in this shop' using errcode = '42501';
  end if;
  if x.ended_at is not null then
    return jsonb_build_object('billed_minutes', x.billed_minutes, 'amount', x.amount, 'order_id', x.order_id);   -- asked twice: the same answer
  end if;
  v_secs := floor(extract(epoch from (now() - x.started_at)))::integer;
  v_min := public.karaoke_billed_minutes(v_secs, x.min_minutes, x.step_minutes);
  v_amt := public.karaoke_amount(x.rate_per_hour, v_min);
  update public.karaoke_sessions set ended_at = now(), billed_minutes = v_min, amount = v_amt where id = x.id;
  update public.karaoke_songs set status = 'removed' where session_id = x.id and status in ('queued', 'playing');
  return jsonb_build_object('billed_minutes', v_min, 'amount', v_amt, 'order_id', null);
end $$;

-- the finished session becomes an ordinary open bill `KR001…` with one line (the same shape as an appointment's bill); asked twice = the same bill
create or replace function public.karaoke_to_order(p_session uuid, p_device uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare x public.karaoke_sessions%rowtype; r public.karaoke_rooms%rowtype; v_dev uuid := p_device; v_order uuid; v_no integer; v_staff uuid;
begin
  select * into x from public.karaoke_sessions where id = p_session for update;
  if not found or not (public.can_access_store(x.org_id, x.store_id) and public.has_permission(x.org_id, 'order.create')) then
    raise exception 'billing a room needs order.create in this shop' using errcode = '42501';
  end if;
  if x.order_id is not null and exists (select 1 from public.orders o where o.id = x.order_id and o.status <> 'void') then return x.order_id; end if;
  if x.ended_at is null then raise exception 'stop the room before billing it' using errcode = '55000'; end if;
  if x.amount <= 0 then raise exception 'there is nothing to bill for this room' using errcode = '22023'; end if;
  select * into r from public.karaoke_rooms where id = x.room_id;
  if v_dev is not null and not exists (select 1 from public.devices d where d.id = v_dev and d.store_id = x.store_id and d.active) then v_dev := null; end if;
  perform 1 from public.stores where id = x.store_id for update;
  select coalesce(max(substr(o.number, 3)::integer), 0) + 1 into v_no from public.orders o
   where o.store_id = x.store_id and o.business_date = (now() at time zone 'Asia/Bangkok')::date and o.number ~ '^KR[0-9]+$';
  select f.id into v_staff from public.staff f where f.org_id = x.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.orders (org_id, store_id, number, business_date, channel, status, note, opened_by, device_id)
  values (x.org_id, x.store_id, 'KR' || lpad(v_no::text, 3, '0'), (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'open',
          left('Karaoke: ' || r.name, 300), v_staff, v_dev) returning id into v_order;
  insert into public.order_lines (org_id, store_id, order_id, name, unit_price, quantity, status, sent_at)
  values (x.org_id, x.store_id, v_order,
          jsonb_build_object('th', 'ห้องคาราโอเกะ ' || r.name || ' · ' || x.billed_minutes || ' นาที', 'en', 'Karaoke ' || r.name || ' · ' || x.billed_minutes || ' min'),
          x.amount, 1, 'sent', now());
  update public.karaoke_sessions set order_id = v_order where id = x.id;
  return v_order;
end $$;

-- a bill paid → nothing else to do (the session already holds the order id); a voided bill frees the session to be billed again (handled by the order_id check above)

-- ── the song queue ───────────────────────────────────────────────────────────
-- the one door for adding a song; p_limit = songs allowed to wait (3 for a guest)
create or replace function public.karaoke_add_song(p_room uuid, p_video text, p_title text, p_client uuid, p_source text, p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.karaoke_rooms%rowtype; x public.karaoke_sessions%rowtype; v_id uuid;
begin
  select * into r from public.karaoke_rooms where id = p_room and active;
  if not found or not public.karaoke_songs_enabled(r.store_id) then return jsonb_build_object('ok', false, 'error', 'unavailable'); end if;
  if p_video is null or p_video !~ '^[A-Za-z0-9_-]{11}$' or length(btrim(coalesce(p_title, ''))) not between 1 and 150 then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  select * into x from public.karaoke_sessions where room_id = r.id and ended_at is null;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_in_use'); end if;
  if p_client is not null then
    select s.id into v_id from public.karaoke_songs s where s.room_id = r.id and s.client_id = p_client;
    if found then return jsonb_build_object('ok', true, 'id', v_id); end if;      -- the same tap again: the first answer
  end if;
  if (select count(*) from public.karaoke_songs s where s.room_id = r.id and s.requested_at > now() - interval '10 minutes') >= 12 then
    return jsonb_build_object('ok', false, 'error', 'rate');
  end if;
  if (select count(*) from public.karaoke_songs s where s.session_id = x.id and s.status = 'queued') >= p_limit then
    return jsonb_build_object('ok', false, 'error', 'full');
  end if;
  if exists (select 1 from public.karaoke_songs s where s.room_id = r.id and s.video_id = p_video and s.status <> 'removed'
                and (s.status in ('queued', 'playing') or s.requested_at > now() - interval '10 minutes')) then
    return jsonb_build_object('ok', false, 'error', 'repeat');
  end if;
  insert into public.karaoke_songs (org_id, store_id, room_id, session_id, video_id, title, source, client_id)
  values (r.org_id, r.store_id, r.id, x.id, p_video, btrim(p_title), p_source, p_client) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
revoke all on function public.karaoke_add_song(uuid, text, text, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.karaoke_add_song(uuid, text, text, uuid, text, integer) to service_role;

-- staff add a song for the room (more may wait than for a guest)
create or replace function public.karaoke_staff_add_song(p_room uuid, p_video text, p_title text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.karaoke_rooms%rowtype;
begin
  select * into r from public.karaoke_rooms where id = p_room;
  if not found or not (public.can_access_store(r.org_id, r.store_id) and public.has_permission(r.org_id, 'order.create')) then
    raise exception 'queueing a song needs order.create in this shop' using errcode = '42501';
  end if;
  return public.karaoke_add_song(p_room, p_video, p_title, null, 'staff', 30);
end $$;

-- staff move a song on: queued → playing (the song that was playing is done), playing → done, queued / playing → removed
create or replace function public.karaoke_song_set(p_song uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.karaoke_songs%rowtype;
begin
  select * into g from public.karaoke_songs where id = p_song for update;
  if not found or not (public.can_access_store(g.org_id, g.store_id) and public.has_permission(g.org_id, 'order.create')) then
    raise exception 'changing the song queue needs order.create in this shop' using errcode = '42501';
  end if;
  if p_status = 'playing' and g.status = 'queued' then
    update public.karaoke_songs set status = 'done' where room_id = g.room_id and status = 'playing';
    update public.karaoke_songs set status = 'playing', started_at = now() where id = g.id;
  elsif p_status = 'done' and g.status = 'playing' then
    update public.karaoke_songs set status = 'done' where id = g.id;
  elsif p_status = 'removed' and g.status in ('queued', 'playing') then
    update public.karaoke_songs set status = 'removed' where id = g.id;
  else
    raise exception 'that song cannot be changed this way' using errcode = '55000';
  end if;
end $$;
revoke all on function public.save_karaoke_room(jsonb), public.karaoke_room_links(uuid, uuid), public.karaoke_start(uuid, integer), public.karaoke_stop(uuid),
  public.karaoke_to_order(uuid, uuid), public.karaoke_staff_add_song(uuid, text, text), public.karaoke_song_set(uuid, text) from public, anon;
grant execute on function public.save_karaoke_room(jsonb), public.karaoke_room_links(uuid, uuid), public.karaoke_start(uuid, integer), public.karaoke_stop(uuid),
  public.karaoke_to_order(uuid, uuid), public.karaoke_staff_add_song(uuid, text, text), public.karaoke_song_set(uuid, text) to authenticated, service_role;

-- ── guests (service role only; the room's QR token is the only key) ────────────────
create or replace function public.karaoke_room_by_token(p_token text) returns public.karaoke_rooms
language sql stable security definer set search_path = '' as $$
  select r.* from public.karaoke_rooms r where p_token ~ '^[0-9a-f]{32}$' and r.qr_token = p_token and r.active limit 1
$$;
revoke all on function public.karaoke_room_by_token(text) from public, anon, authenticated;
grant execute on function public.karaoke_room_by_token(text) to service_role;

create or replace function public.guest_karaoke_room(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.karaoke_rooms%rowtype; x public.karaoke_sessions%rowtype; s public.stores%rowtype;
begin
  r := public.karaoke_room_by_token(p_token);
  if r.id is null then return null; end if;
  select * into s from public.stores where id = r.store_id;
  if not public.karaoke_enabled(r.store_id) then return null; end if;
  select * into x from public.karaoke_sessions where room_id = r.id and ended_at is null;
  return jsonb_build_object(
    'shop', s.name, 'room', r.name,
    'songs_enabled', public.karaoke_songs_enabled(r.store_id),
    'running', x.id is not null,
    'elapsed_seconds', case when x.id is null then null else floor(extract(epoch from (now() - x.started_at)))::integer end,
    'queue', case when x.id is null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'video_id', g.video_id, 'title', g.title, 'status', g.status)
        order by (g.status = 'playing') desc, g.requested_at) from public.karaoke_songs g where g.session_id = x.id and g.status in ('queued', 'playing')), '[]'::jsonb) end);
end $$;

create or replace function public.guest_karaoke_request(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.karaoke_rooms%rowtype;
begin
  r := public.karaoke_room_by_token(p_token);
  if r.id is null then return jsonb_build_object('ok', false, 'error', 'unavailable'); end if;
  return public.karaoke_add_song(r.id, p ->> 'video_id', p ->> 'title', nullif(p ->> 'client_id', '')::uuid, 'guest', 3);
end $$;

create or replace function public.guest_karaoke_remove(p_token text, p_song uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.karaoke_rooms%rowtype; n integer;
begin
  r := public.karaoke_room_by_token(p_token);
  if r.id is null then return false; end if;
  update public.karaoke_songs set status = 'removed' where id = p_song and room_id = r.id and status = 'queued';
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke all on function public.guest_karaoke_room(text), public.guest_karaoke_request(text, jsonb), public.guest_karaoke_remove(text, uuid) from public, anon, authenticated;
grant execute on function public.guest_karaoke_room(text), public.guest_karaoke_request(text, jsonb), public.guest_karaoke_remove(text, uuid) to service_role;
