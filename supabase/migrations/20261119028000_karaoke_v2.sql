-- Bestie POS · migration 73 · Karaoke v2: pause / resume, hour PACKAGES and extending a running room, and a room reservation calendar.
--
--  * PAUSE: a paused session stops counting. `karaoke_elapsed()` = time since the start minus the time spent paused, all on the database clock.
--  * PACKAGES (`karaoke_packages`: name, minutes, price): a session may start with a package (a block of time sold at its own price). The package's minutes are INCLUDED; the
--    time beyond them is billed at the room's rate, rounded up to the room's step (`karaoke_overage_minutes`). "Extend" adds another package block to a running session.
--    A session with no package bills exactly as before (rate x time, shortest time, step). Prices, minutes and the package name are copied onto the session.
--  * RESERVATIONS (`karaoke_bookings`): a room is booked ahead for a time range; two live bookings of one room can never overlap; starting the room for a booking marks it
--    "arrived", stopping the room marks it "done". Bookings are written only through functions (`karaoke_book`, `karaoke_booking_status`).

alter table public.karaoke_sessions
  add column paused_at        timestamptz,
  add column paused_seconds   integer not null default 0 check (paused_seconds >= 0),
  add column included_minutes integer not null default 0 check (included_minutes between 0 and 2000),
  add column package_total    integer not null default 0 check (package_total >= 0),
  add column package_name     text check (package_name is null or length(package_name) <= 60),
  add column booking_id       uuid;

create table public.karaoke_packages (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 60),
  minutes    integer not null check (minutes between 15 and 600),
  price      integer not null check (price between 0 and 10000000),
  active     boolean not null default true,
  sort       integer not null default 0,
  created_at timestamptz not null default now(),
  unique (store_id, name)
);
create table public.karaoke_bookings (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  room_id    uuid not null references public.karaoke_rooms (id) on delete cascade,
  guest_name text not null check (length(btrim(guest_name)) between 1 and 80),
  phone      text check (phone is null or length(phone) <= 30),
  guests     integer check (guests is null or guests between 1 and 200),
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  status     text not null default 'booked' check (status in ('booked', 'arrived', 'cancelled', 'no_show', 'done')),
  note       text check (note is null or length(note) <= 300),
  session_id uuid references public.karaoke_sessions (id) on delete set null,
  created_by uuid references public.staff (id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at and ends_at - starts_at <= interval '12 hours')
);
create index karaoke_bookings_room_idx on public.karaoke_bookings (room_id, starts_at);
alter table public.karaoke_sessions add constraint karaoke_sessions_booking_fk foreign key (booking_id) references public.karaoke_bookings (id) on delete set null;

alter table public.karaoke_packages enable row level security;
alter table public.karaoke_bookings enable row level security;
create policy karaoke_packages_read on public.karaoke_packages for select to authenticated using (public.can_access_store(org_id, store_id));
create policy karaoke_bookings_read on public.karaoke_bookings for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.karaoke_packages, public.karaoke_bookings from anon, authenticated;
grant select on public.karaoke_packages, public.karaoke_bookings to authenticated;
create trigger karaoke_packages_live after insert or update on public.karaoke_packages for each row execute function public.live_ping_row('store:{store_id}');
create trigger karaoke_bookings_live after insert or update on public.karaoke_bookings for each row execute function public.live_ping_row('store:{store_id}');

-- ── arithmetic ───────────────────────────────────────────────────────────────
-- seconds counted so far: start → (end | pause | now), minus the paused time
create or replace function public.karaoke_elapsed(p_session uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select greatest(0, floor(extract(epoch from (coalesce(x.ended_at, x.paused_at, now()) - x.started_at)))::integer - x.paused_seconds)
    from public.karaoke_sessions x where x.id = p_session
$$;
revoke all on function public.karaoke_elapsed(uuid) from public, anon;
grant execute on function public.karaoke_elapsed(uuid) to authenticated, service_role;

-- minutes beyond the included ones, rounded UP to a whole step (0 while still inside the package)
create or replace function public.karaoke_overage_minutes(p_elapsed_seconds integer, p_included integer, p_step integer) returns integer
language sql immutable set search_path = '' as $$
  select case when greatest(p_elapsed_seconds, 0) <= p_included * 60 then 0
              else (((p_elapsed_seconds - p_included * 60) + 60 * p_step - 1) / (60 * p_step)) * p_step end
$$;
revoke all on function public.karaoke_overage_minutes(integer, integer, integer) from public, anon;
grant execute on function public.karaoke_overage_minutes(integer, integer, integer) to authenticated, service_role;

-- ── packages ─────────────────────────────────────────────────────────────────
-- p = { store_id, id?, name, minutes, price, active?, sort? }   (menu.edit)
create or replace function public.save_karaoke_package(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_edit_menu(s.id) then raise exception 'editing packages needs menu.edit in this shop' using errcode = '42501'; end if;
  if not public.karaoke_enabled(s.id) then raise exception 'the karaoke module is off in this shop' using errcode = '0A000'; end if;
  if v_id is null then
    insert into public.karaoke_packages (org_id, store_id, name, minutes, price, active, sort)
    values (s.org_id, s.id, btrim(p ->> 'name'), (p ->> 'minutes')::integer, (p ->> 'price')::integer, coalesce((p ->> 'active')::boolean, true), coalesce((p ->> 'sort')::integer, 0))
    returning id into v_id;
  else
    update public.karaoke_packages set name = coalesce(btrim(p ->> 'name'), name), minutes = coalesce((p ->> 'minutes')::integer, minutes), price = coalesce((p ->> 'price')::integer, price),
           active = coalesce((p ->> 'active')::boolean, active), sort = coalesce((p ->> 'sort')::integer, sort)
     where id = v_id and store_id = s.id;
    if not found then raise exception 'unknown package' using errcode = '22023'; end if;
  end if;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'karaoke_packages', v_id::text, jsonb_build_object('minutes', p -> 'minutes', 'price', p -> 'price', 'active', p -> 'active'), 'db');
  return v_id;
end $$;
revoke all on function public.save_karaoke_package(jsonb) from public, anon;
grant execute on function public.save_karaoke_package(jsonb) to authenticated, service_role;

-- ── the timer: start (now with an optional package and booking), pause, resume, extend, stop ──
drop function public.karaoke_start(uuid, integer);
create or replace function public.karaoke_start(p_room uuid, p_guests integer default null, p_package uuid default null, p_booking uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.karaoke_rooms%rowtype; v_staff uuid; v_id uuid; pk public.karaoke_packages%rowtype; b public.karaoke_bookings%rowtype;
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
  if p_package is not null then
    select * into pk from public.karaoke_packages where id = p_package and store_id = r.store_id and active;
    if not found then raise exception 'unknown or inactive package' using errcode = '22023'; end if;
  end if;
  if p_booking is not null then
    select * into b from public.karaoke_bookings where id = p_booking and room_id = r.id for update;
    if not found or b.status <> 'booked' then raise exception 'that reservation cannot be started' using errcode = '55000'; end if;
  end if;
  select f.id into v_staff from public.staff f where f.org_id = r.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.karaoke_sessions (org_id, store_id, room_id, guests, rate_per_hour, min_minutes, step_minutes, started_by, included_minutes, package_total, package_name, booking_id)
  values (r.org_id, r.store_id, r.id, coalesce(p_guests, b.guests), r.rate_per_hour, r.min_minutes, r.step_minutes, v_staff,
          coalesce(pk.minutes, 0), coalesce(pk.price, 0), pk.name, p_booking) returning id into v_id;
  if p_booking is not null then update public.karaoke_bookings set status = 'arrived', session_id = v_id where id = p_booking; end if;
  return v_id;
end $$;

create or replace function public.karaoke_pause(p_session uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare x public.karaoke_sessions%rowtype;
begin
  select * into x from public.karaoke_sessions where id = p_session for update;
  if not found or not (public.can_access_store(x.org_id, x.store_id) and public.has_permission(x.org_id, 'order.create')) then
    raise exception 'pausing a room needs order.create in this shop' using errcode = '42501';
  end if;
  if x.ended_at is not null or x.paused_at is not null then raise exception 'this room is not running' using errcode = '55000'; end if;
  update public.karaoke_sessions set paused_at = now() where id = x.id;
end $$;

create or replace function public.karaoke_resume(p_session uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare x public.karaoke_sessions%rowtype;
begin
  select * into x from public.karaoke_sessions where id = p_session for update;
  if not found or not (public.can_access_store(x.org_id, x.store_id) and public.has_permission(x.org_id, 'order.create')) then
    raise exception 'resuming a room needs order.create in this shop' using errcode = '42501';
  end if;
  if x.ended_at is not null or x.paused_at is null then raise exception 'this room is not paused' using errcode = '55000'; end if;
  update public.karaoke_sessions set paused_seconds = paused_seconds + floor(extract(epoch from (now() - x.paused_at)))::integer, paused_at = null where id = x.id;
end $$;

-- add another block of time to a running room
create or replace function public.karaoke_extend(p_session uuid, p_package uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare x public.karaoke_sessions%rowtype; pk public.karaoke_packages%rowtype;
begin
  select * into x from public.karaoke_sessions where id = p_session for update;
  if not found or not (public.can_access_store(x.org_id, x.store_id) and public.has_permission(x.org_id, 'order.create')) then
    raise exception 'extending a room needs order.create in this shop' using errcode = '42501';
  end if;
  if x.ended_at is not null then raise exception 'this room is not running' using errcode = '55000'; end if;
  select * into pk from public.karaoke_packages where id = p_package and store_id = x.store_id and active;
  if not found then raise exception 'unknown or inactive package' using errcode = '22023'; end if;
  update public.karaoke_sessions
     set included_minutes = included_minutes + pk.minutes, package_total = package_total + pk.price, package_name = coalesce(package_name, pk.name)
   where id = x.id;
  return jsonb_build_object('included_minutes', x.included_minutes + pk.minutes, 'package_total', x.package_total + pk.price);
end $$;

create or replace function public.karaoke_stop(p_session uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare x public.karaoke_sessions%rowtype; v_secs integer; v_min integer; v_amt integer; v_over integer;
begin
  select * into x from public.karaoke_sessions where id = p_session for update;
  if not found or not (public.can_access_store(x.org_id, x.store_id) and public.has_permission(x.org_id, 'order.create')) then
    raise exception 'stopping a room needs order.create in this shop' using errcode = '42501';
  end if;
  if x.ended_at is not null then
    return jsonb_build_object('billed_minutes', x.billed_minutes, 'amount', x.amount, 'order_id', x.order_id);   -- asked twice: the same answer
  end if;
  if x.paused_at is not null then   -- stopping a paused room: the pause ends here, it is not counted
    update public.karaoke_sessions set paused_seconds = paused_seconds + floor(extract(epoch from (now() - x.paused_at)))::integer, paused_at = null where id = x.id;
  end if;
  v_secs := public.karaoke_elapsed(x.id) ;
  if x.included_minutes = 0 then
    v_min := public.karaoke_billed_minutes(v_secs, x.min_minutes, x.step_minutes);
    v_amt := public.karaoke_amount(x.rate_per_hour, v_min);
  else
    v_over := public.karaoke_overage_minutes(v_secs, x.included_minutes, x.step_minutes);
    v_min := x.included_minutes + v_over;
    v_amt := x.package_total + public.karaoke_amount(x.rate_per_hour, v_over);
  end if;
  update public.karaoke_sessions set ended_at = now(), billed_minutes = v_min, amount = v_amt where id = x.id;
  update public.karaoke_songs set status = 'removed' where session_id = x.id and status in ('queued', 'playing');
  if x.booking_id is not null then update public.karaoke_bookings set status = 'done' where id = x.booking_id and status = 'arrived'; end if;
  return jsonb_build_object('billed_minutes', v_min, 'amount', v_amt, 'order_id', null);
end $$;

-- the guest page: the clock without the pauses, whether the room is paused, and the time left in the package
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
    'paused', x.paused_at is not null,
    'elapsed_seconds', case when x.id is null then null else public.karaoke_elapsed(x.id) end,
    'included_minutes', case when x.id is null or x.included_minutes = 0 then null else x.included_minutes end,
    'queue', case when x.id is null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'video_id', g.video_id, 'title', g.title, 'status', g.status)
        order by (g.status = 'playing') desc, g.requested_at) from public.karaoke_songs g where g.session_id = x.id and g.status in ('queued', 'playing')), '[]'::jsonb) end);
end $$;

-- ── reservations ─────────────────────────────────────────────────────────────
-- p = { store_id, room_id, guest_name, phone?, guests?, starts_at, minutes, note? }   (order.create)
create or replace function public.karaoke_book(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.karaoke_rooms%rowtype; v_staff uuid; v_id uuid; v_start timestamptz := (p ->> 'starts_at')::timestamptz; v_min integer := (p ->> 'minutes')::integer;
begin
  select * into r from public.karaoke_rooms where id = (p ->> 'room_id')::uuid and store_id = (p ->> 'store_id')::uuid for update;
  if not found or not (public.can_access_store(r.org_id, r.store_id) and public.has_permission(r.org_id, 'order.create')) then
    raise exception 'booking a room needs order.create in this shop' using errcode = '42501';
  end if;
  if not public.karaoke_enabled(r.store_id) then raise exception 'the karaoke module is off in this shop' using errcode = '0A000'; end if;
  if not r.active then raise exception 'this room is switched off' using errcode = '55000'; end if;
  if v_min is null or v_min not between 15 and 720 or v_start is null or v_start < now() - interval '15 minutes' or v_start > now() + interval '180 days' then
    raise exception 'the reservation time is not valid' using errcode = '22023';
  end if;
  if exists (select 1 from public.karaoke_bookings b where b.room_id = r.id and b.status in ('booked', 'arrived')
              and b.starts_at < v_start + make_interval(mins => v_min) and b.ends_at > v_start) then
    raise exception 'this room is already booked at that time' using errcode = '23P01';
  end if;
  select f.id into v_staff from public.staff f where f.org_id = r.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.karaoke_bookings (org_id, store_id, room_id, guest_name, phone, guests, starts_at, ends_at, note, created_by)
  values (r.org_id, r.store_id, r.id, btrim(p ->> 'guest_name'), nullif(btrim(coalesce(p ->> 'phone', '')), ''), nullif(p ->> 'guests', '')::integer,
          v_start, v_start + make_interval(mins => v_min), nullif(btrim(coalesce(p ->> 'note', '')), ''), v_staff) returning id into v_id;
  return v_id;
end $$;

create or replace function public.karaoke_booking_status(p_booking uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.karaoke_bookings%rowtype;
begin
  select * into b from public.karaoke_bookings where id = p_booking for update;
  if not found or not (public.can_access_store(b.org_id, b.store_id) and public.has_permission(b.org_id, 'order.create')) then
    raise exception 'changing a reservation needs order.create in this shop' using errcode = '42501';
  end if;
  if p_status not in ('cancelled', 'no_show') or b.status <> 'booked' then raise exception 'that reservation cannot be changed this way' using errcode = '55000'; end if;
  if p_status = 'no_show' and b.starts_at > now() then raise exception 'the reservation has not started yet' using errcode = '55000'; end if;
  update public.karaoke_bookings set status = p_status where id = b.id;
end $$;
revoke all on function public.karaoke_start(uuid, integer, uuid, uuid), public.karaoke_pause(uuid), public.karaoke_resume(uuid), public.karaoke_extend(uuid, uuid),
  public.karaoke_stop(uuid), public.karaoke_book(jsonb), public.karaoke_booking_status(uuid, text) from public, anon;
grant execute on function public.karaoke_start(uuid, integer, uuid, uuid), public.karaoke_pause(uuid), public.karaoke_resume(uuid), public.karaoke_extend(uuid, uuid),
  public.karaoke_stop(uuid), public.karaoke_book(jsonb), public.karaoke_booking_status(uuid, text) to authenticated, service_role;
revoke all on function public.guest_karaoke_room(text) from public, anon, authenticated;
grant execute on function public.guest_karaoke_room(text) to service_role;
