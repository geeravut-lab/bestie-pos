-- Bestie POS · migration 75 · ONLINE BOOKING OF KARAOKE ROOMS by guests, with a deposit (module `karaoke.booking`).
--
--  * A karaoke shop has ONE booking link: a random 128-bit token (`stores.karaoke_booking_token`); it is the guest's only key. The owner shows, prints or replaces it and
--    sets the hours, the step, the notice, the days ahead, the deposit percentage, how long an unpaid booking is held and a payment note (e.g. the PromptPay number).
--    The module `karaoke.booking` is OFF for every profile, plan Pro and up, and needs `karaoke.rooms`.
--  * A guest picks a room, a day, a length and a start time (the database lists only free times: no live booking of that room may overlap), types a name and a phone and
--    gets a CANCEL CODE once (only its SHA-256 is kept). The booking is `booked`, `source = 'online'`. A repeated `client_id` returns the first answer.
--  * The DEPOSIT is a share of the estimated room price (rate x length, the shop's percentage). It is NOT taken online: the page shows the amount and how to pay it, the front
--    desk records it when it arrives (`record_karaoke_deposit`, cash into a named till / PromptPay / card machine; payment.take), exactly like a deposit on a salon booking.
--    An unpaid online booking is RELEASED by the tick after the hold window (`karaoke_release_unpaid`). When the room is started for the booking and later billed, the deposits
--    held become already-paid shares of the room's bill (`order_partial_payments`, kind `deposit`); a deposit left over, or the deposit of a cancelled / no-show booking, is
--    settled by a manager (`resolve_karaoke_deposit`: keep it as a fee or refund it). The shift's expected cash counts cash deposits taken and refunded at that till.
--  * A guest can cancel while the booking has not started; the deposit then stays held until a manager settles it under the shop's policy.
--  * Limits: 12 online bookings per shop per 10 minutes, at most 3 upcoming per phone number.

-- registry:karaoke.booking profiles= plan=pro,resort depends=karaoke.rooms
create or replace function public.karaoke_booking_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.karaoke_enabled(p_store) and exists (
    select 1 from public.stores s
     where s.id = p_store and s.plan in ('pro', 'resort')
       and coalesce((s.module_overrides ->> 'karaoke.booking')::boolean, false))
$$;
revoke all on function public.karaoke_booking_enabled(uuid) from public, anon;
grant execute on function public.karaoke_booking_enabled(uuid) to authenticated, service_role;

do $$
declare r record; src text; dst text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'stores_check_modules' loop
    src := pg_get_functiondef(r.oid);
    dst := replace(src, $a$'ai.translate'];$a$, $a$'ai.translate','karaoke.booking'];$a$);
    if dst = src then raise exception 'migration 75: stores_check_modules not changed'; end if;
    execute dst;
  end loop;
end $$;

-- ── data ──
alter table public.stores add column karaoke_booking_token text unique check (karaoke_booking_token is null or karaoke_booking_token ~ '^[0-9a-f]{32}$');
alter table public.stores add column karaoke_booking_settings jsonb not null default '{}'::jsonb check (
  jsonb_typeof(karaoke_booking_settings) = 'object'
  and not (karaoke_booking_settings - 'open' - 'close' - 'step_min' - 'lead_min' - 'max_days' - 'deposit_pct' - 'hold_min' - 'pay_note') <> '{}'::jsonb);

alter table public.karaoke_bookings
  add column source           text not null default 'counter' check (source in ('counter', 'online')),
  add column cancel_hash      text,
  add column online_client_id uuid,
  add column deposit_due      integer not null default 0 check (deposit_due >= 0),
  add column hold_until       timestamptz;
create unique index karaoke_bookings_client_uidx on public.karaoke_bookings (store_id, online_client_id) where online_client_id is not null;
create index karaoke_bookings_hold_idx on public.karaoke_bookings (hold_until) where status = 'booked' and hold_until is not null;

create table public.karaoke_deposits (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.orgs (id) on delete cascade,
  store_id           uuid not null references public.stores (id) on delete cascade,
  booking_id         uuid not null references public.karaoke_bookings (id),
  amount             bigint not null check (amount between 1 and 100000000),
  method             text not null check (method in ('cash', 'promptpay', 'gateway')),
  device_id          uuid references public.devices (id),
  reference          text check (reference is null or length(reference) <= 100),
  status             text not null default 'held' check (status in ('held', 'on_bill', 'forfeited', 'refunded')),
  order_id           uuid references public.orders (id),
  created_by         uuid references public.staff (id) on delete set null,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz,
  resolved_by        uuid references public.staff (id) on delete set null,
  resolved_device_id uuid references public.devices (id)
);
create index karaoke_deposits_booking_idx on public.karaoke_deposits (booking_id);
create index karaoke_deposits_cash_idx on public.karaoke_deposits (device_id, created_at) where method = 'cash';
alter table public.karaoke_deposits enable row level security;
create policy karaoke_deposits_read on public.karaoke_deposits for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.karaoke_deposits from anon, authenticated;
grant select on public.karaoke_deposits to authenticated;
create trigger karaoke_deposits_live after insert or update on public.karaoke_deposits for each row execute function public.live_ping_row('store:{store_id}');

-- the settings with their defaults filled in
create or replace function public.karaoke_booking_cfg(p_settings jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'open',        coalesce(nullif(p_settings ->> 'open', ''), '12:00'),
    'close',       coalesce(nullif(p_settings ->> 'close', ''), '23:00'),
    'step_min',    coalesce((p_settings ->> 'step_min')::integer, 30),
    'lead_min',    coalesce((p_settings ->> 'lead_min')::integer, 60),
    'max_days',    coalesce((p_settings ->> 'max_days')::integer, 30),
    'deposit_pct', coalesce((p_settings ->> 'deposit_pct')::integer, 30),
    'hold_min',    coalesce((p_settings ->> 'hold_min')::integer, 120),
    'pay_note',    coalesce(p_settings ->> 'pay_note', ''))
$$;
revoke all on function public.karaoke_booking_cfg(jsonb) from public, anon;
grant execute on function public.karaoke_booking_cfg(jsonb) to authenticated, service_role;

-- deposit for a room price: the shop's percentage, half up, in satang
create or replace function public.karaoke_deposit_for(p_price integer, p_pct integer) returns integer
language sql immutable set search_path = '' as $$
  select ((p_price::bigint * greatest(least(p_pct, 100), 0) + 50) / 100)::integer
$$;
revoke all on function public.karaoke_deposit_for(integer, integer) from public, anon;
grant execute on function public.karaoke_deposit_for(integer, integer) to authenticated, service_role;

-- ── the owner's side ──
-- p = { open?, close?, step_min?, lead_min?, max_days?, deposit_pct?, hold_min?, pay_note?, rotate? } → { token, settings }
create or replace function public.save_karaoke_booking_settings(p_store uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype;
  v jsonb := '{}'::jsonb;
  c jsonb;
  k text;
  v_token text;
begin
  select * into s from public.stores where id = p_store and deleted_at is null for update;
  if not found or not public.can_access_store(s.org_id, s.id) or not public.can_edit_menu(s.id) then
    raise exception 'booking settings need menu.edit in this shop' using errcode = '42501';
  end if;
  if not public.karaoke_enabled(p_store) then raise exception 'the karaoke module is off in this shop' using errcode = '0A000'; end if;
  foreach k in array array['open', 'close', 'pay_note'] loop
    if p ? k then v := v || jsonb_build_object(k, p ->> k); end if;
  end loop;
  foreach k in array array['step_min', 'lead_min', 'max_days', 'deposit_pct', 'hold_min'] loop
    if p ? k then v := v || jsonb_build_object(k, (p ->> k)::integer); end if;
  end loop;
  v := s.karaoke_booking_settings || v;
  c := public.karaoke_booking_cfg(v);
  if (c ->> 'open') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or (c ->> 'close') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or (c ->> 'open')::time >= (c ->> 'close')::time then
    raise exception 'opening time must be before the last start time (HH:MM)' using errcode = '22023';
  end if;
  if (c ->> 'step_min')::integer not between 5 and 120 or (c ->> 'lead_min')::integer not between 0 and 10080
     or (c ->> 'max_days')::integer not between 1 and 180 or (c ->> 'deposit_pct')::integer not between 0 and 100
     or (c ->> 'hold_min')::integer not between 15 and 2880 or length(c ->> 'pay_note') > 200 then
    raise exception 'booking settings out of range' using errcode = '22023';
  end if;
  v_token := s.karaoke_booking_token;
  if v_token is null or coalesce((p ->> 'rotate')::boolean, false) then
    v_token := replace(gen_random_uuid()::text, '-', '');
  end if;
  update public.stores set karaoke_booking_settings = c, karaoke_booking_token = v_token where id = s.id;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'stores.karaoke_booking', s.id::text,
    (c - 'pay_note') || jsonb_build_object('rotated', v_token is distinct from s.karaoke_booking_token), 'db');
  return jsonb_build_object('token', v_token, 'settings', c);
end $$;
revoke all on function public.save_karaoke_booking_settings(uuid, jsonb) from public, anon;
grant execute on function public.save_karaoke_booking_settings(uuid, jsonb) to authenticated, service_role;

-- ── the guest's side (service role only; the token is the key) ──
create or replace function public.karaoke_booking_store(p_token text) returns public.stores
language sql stable security definer set search_path = '' as $$
  select s.* from public.stores s where p_token ~ '^[0-9a-f]{32}$' and s.karaoke_booking_token = p_token and s.deleted_at is null limit 1
$$;
revoke all on function public.karaoke_booking_store(text) from public, anon, authenticated;
grant execute on function public.karaoke_booking_store(text) to service_role;

-- the lengths a guest may pick for one room: whole steps, at least the room's shortest time, up to 6 hours
create or replace function public.karaoke_booking_lengths(p_min integer, p_step integer) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(m order by m), '[]'::jsonb)
    from unnest(array[60, 90, 120, 180, 240, 300, 360]) m
   where m >= greatest(p_min, 15) and m % p_step = 0
$$;
revoke all on function public.karaoke_booking_lengths(integer, integer) from public, anon;
grant execute on function public.karaoke_booking_lengths(integer, integer) to authenticated, service_role;

create or replace function public.guest_karaoke_booking_info(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype;
begin
  s := public.karaoke_booking_store(p_token);
  if s.id is null then return null; end if;
  if not public.karaoke_booking_enabled(s.id) then return jsonb_build_object('store_name', s.name, 'open', false); end if;
  return jsonb_build_object(
    'open', true,
    'store_name', s.name,
    'settings', public.karaoke_booking_cfg(s.karaoke_booking_settings),
    'rooms', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'rate_per_hour', r.rate_per_hour,
                  'lengths', public.karaoke_booking_lengths(r.min_minutes, r.step_minutes)) order by r.sort, r.created_at)
                from public.karaoke_rooms r where r.store_id = s.id and r.active), '[]'::jsonb));
end $$;

-- free start times ("HH:MM", Bangkok) of one day for one room and one length
create or replace function public.guest_karaoke_booking_slots(p_token text, p_room uuid, p_date date, p_minutes integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.stores%rowtype;
  r public.karaoke_rooms%rowtype;
  c jsonb;
  v_open time; v_close time; v_step integer;
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
  v_min timestamptz;
  v_out jsonb := '[]'::jsonb;
  t time;
  v_start timestamptz; v_end timestamptz;
begin
  s := public.karaoke_booking_store(p_token);
  if s.id is null or not public.karaoke_booking_enabled(s.id) then return null; end if;
  c := public.karaoke_booking_cfg(s.karaoke_booking_settings);
  select * into r from public.karaoke_rooms where id = p_room and store_id = s.id and active;
  if not found or not (public.karaoke_booking_lengths(r.min_minutes, r.step_minutes) @> to_jsonb(p_minutes)) then return '[]'::jsonb; end if;
  if p_date is null or p_date < v_today or p_date > v_today + (c ->> 'max_days')::integer then return '[]'::jsonb; end if;
  v_open := (c ->> 'open')::time; v_close := (c ->> 'close')::time; v_step := (c ->> 'step_min')::integer;
  v_min := now() + make_interval(mins => (c ->> 'lead_min')::integer);
  t := v_open;
  while t <= v_close loop
    v_start := (p_date + t) at time zone 'Asia/Bangkok';
    v_end := v_start + make_interval(mins => p_minutes);
    if v_start >= v_min and not exists (
         select 1 from public.karaoke_bookings b
          where b.room_id = r.id and b.status in ('booked', 'arrived') and b.starts_at < v_end and b.ends_at > v_start) then
      v_out := v_out || to_jsonb(to_char(t, 'HH24:MI'));
    end if;
    t := t + make_interval(mins => v_step);
    exit when t < v_open;                                  -- wrapped past midnight
  end loop;
  return v_out;
end $$;

-- p = { room_id, date 'YYYY-MM-DD', time 'HH:MM', minutes, name, phone, guests?, note?, client_id }
-- → { ok: true, id, code, starts_at, minutes, room, price, deposit_due, hold_until } | { ok: false, error: 'off'|'invalid'|'taken'|'too_many'|'not_found' }
create or replace function public.guest_karaoke_book(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype;
  r public.karaoke_rooms%rowtype;
  c jsonb;
  v_client uuid;
  v_date date; v_time time;
  v_min integer;
  v_start timestamptz; v_end timestamptz;
  v_name text := btrim(coalesce(p ->> 'name', ''));
  v_phone text := btrim(coalesce(p ->> 'phone', ''));
  v_digits text;
  v_guests integer;
  v_code text;
  v_id uuid;
  v_price integer; v_dep integer; v_hold timestamptz;
  v_first public.karaoke_bookings%rowtype;
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  s := public.karaoke_booking_store(p_token);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not public.karaoke_booking_enabled(s.id) then return jsonb_build_object('ok', false, 'error', 'off'); end if;
  c := public.karaoke_booking_cfg(s.karaoke_booking_settings);
  begin
    v_client := (p ->> 'client_id')::uuid;
    v_date := (p ->> 'date')::date;
    v_time := (p ->> 'time')::time;
    v_min := (p ->> 'minutes')::integer;
    v_guests := nullif(p ->> 'guests', '')::integer;
  exception when others then return jsonb_build_object('ok', false, 'error', 'invalid');
  end;
  v_digits := regexp_replace(v_phone, '[^0-9]', '', 'g');
  if v_client is null or v_date is null or v_time is null or v_min is null or length(v_name) not between 1 and 80
     or length(v_phone) not between 6 and 30 or length(v_digits) < 6 or length(coalesce(p ->> 'note', '')) > 300
     or (v_guests is not null and v_guests not between 1 and 200) then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  -- a repeated request returns the first answer (the code was shown once)
  select * into v_first from public.karaoke_bookings where store_id = s.id and online_client_id = v_client;
  if found then
    return jsonb_build_object('ok', true, 'id', v_first.id, 'code', null, 'starts_at', v_first.starts_at, 'repeat', true,
      'minutes', (extract(epoch from (v_first.ends_at - v_first.starts_at)) / 60)::integer,
      'room', (select k.name from public.karaoke_rooms k where k.id = v_first.room_id),
      'deposit_due', v_first.deposit_due, 'hold_until', v_first.hold_until);
  end if;
  select * into r from public.karaoke_rooms where id = nullif(p ->> 'room_id', '')::uuid and store_id = s.id and active for update;
  if not found or not (public.karaoke_booking_lengths(r.min_minutes, r.step_minutes) @> to_jsonb(v_min)) then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if v_date < v_today or v_date > v_today + (c ->> 'max_days')::integer
     or v_time < (c ->> 'open')::time or v_time > (c ->> 'close')::time
     or ((extract(epoch from (v_time - (c ->> 'open')::time)) / 60)::integer % (c ->> 'step_min')::integer) <> 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  v_start := (v_date + v_time) at time zone 'Asia/Bangkok';
  v_end := v_start + make_interval(mins => v_min);
  if v_start < now() + make_interval(mins => (c ->> 'lead_min')::integer) then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  if (select count(*) from public.karaoke_bookings b where b.store_id = s.id and b.source = 'online' and b.created_at > now() - interval '10 minutes') >= 12
     or (select count(*) from public.karaoke_bookings b where b.store_id = s.id and b.source = 'online' and b.starts_at > now() and b.status = 'booked'
            and regexp_replace(coalesce(b.phone, ''), '[^0-9]', '', 'g') = v_digits) >= 3 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  if exists (select 1 from public.karaoke_bookings b where b.room_id = r.id and b.status in ('booked', 'arrived') and b.starts_at < v_end and b.ends_at > v_start) then
    return jsonb_build_object('ok', false, 'error', 'taken');
  end if;
  v_price := public.karaoke_amount(r.rate_per_hour, v_min);
  v_dep := public.karaoke_deposit_for(v_price, (c ->> 'deposit_pct')::integer);
  v_hold := case when v_dep > 0 then least(now() + make_interval(mins => (c ->> 'hold_min')::integer), v_start) end;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into public.karaoke_bookings (org_id, store_id, room_id, guest_name, phone, guests, starts_at, ends_at, note, source, cancel_hash, online_client_id, deposit_due, hold_until)
  values (s.org_id, s.id, r.id, v_name, left(v_phone, 30), v_guests, v_start, v_end, left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 300), 'online',
          encode(sha256(convert_to(v_code, 'utf8')), 'hex'), v_client, v_dep, v_hold)
  returning id into v_id;
  perform public.notify_karaoke_booking(v_id, 'new');
  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code, 'starts_at', v_start, 'minutes', v_min, 'room', r.name,
    'price', v_price, 'deposit_due', v_dep, 'hold_until', v_hold);
end $$;

-- the state of one booking for its guest (the code proves ownership): is the deposit in, how long is the booking held?
create or replace function public.guest_karaoke_booking_status(p_token text, p_id uuid, p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.stores%rowtype;
  b public.karaoke_bookings%rowtype;
begin
  s := public.karaoke_booking_store(p_token);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select * into b from public.karaoke_bookings where id = p_id and store_id = s.id and source = 'online';
  if not found or b.cancel_hash is null or b.cancel_hash <> encode(sha256(convert_to(upper(btrim(coalesce(p_code, ''))), 'utf8')), 'hex') then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  return jsonb_build_object('ok', true, 'status', b.status, 'starts_at', b.starts_at,
    'minutes', (extract(epoch from (b.ends_at - b.starts_at)) / 60)::integer,
    'room', (select k.name from public.karaoke_rooms k where k.id = b.room_id),
    'deposit_due', b.deposit_due, 'hold_until', b.hold_until,
    'deposit_paid', coalesce((select sum(d.amount) from public.karaoke_deposits d where d.booking_id = b.id and d.status in ('held', 'on_bill')), 0));
end $$;

create or replace function public.guest_karaoke_cancel(p_token text, p_id uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype;
  b public.karaoke_bookings%rowtype;
begin
  s := public.karaoke_booking_store(p_token);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select * into b from public.karaoke_bookings where id = p_id and store_id = s.id and source = 'online' for update;
  if not found or b.cancel_hash is null or b.cancel_hash <> encode(sha256(convert_to(upper(btrim(coalesce(p_code, ''))), 'utf8')), 'hex') then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if b.status <> 'booked' or b.starts_at <= now() then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  update public.karaoke_bookings set status = 'cancelled' where id = b.id;
  perform public.notify_karaoke_booking(b.id, 'cancelled');
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.guest_karaoke_booking_info(text), public.guest_karaoke_booking_slots(text, uuid, date, integer),
  public.guest_karaoke_book(text, jsonb), public.guest_karaoke_booking_status(text, uuid, text), public.guest_karaoke_cancel(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.guest_karaoke_booking_info(text), public.guest_karaoke_booking_slots(text, uuid, date, integer),
  public.guest_karaoke_book(text, jsonb), public.guest_karaoke_booking_status(text, uuid, text), public.guest_karaoke_cancel(text, uuid, text)
  to service_role;

-- ── telling the shop ──
create or replace function public.notify_karaoke_booking(p_id uuid, p_what text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  b public.karaoke_bookings%rowtype;
  v_room text;
  v_when text;
  v_n jsonb;
begin
  select * into b from public.karaoke_bookings where id = p_id;
  if not found then return; end if;
  select r.name into v_room from public.karaoke_rooms r where r.id = b.room_id;
  v_when := to_char(b.starts_at at time zone 'Asia/Bangkok', 'DD/MM HH24:MI');
  v_n := jsonb_build_object(
    'kind', case p_what when 'new' then 'karaoke.online' else 'karaoke.online_cancel' end,
    'href', '/karaoke/bookings', 'dedupe', 'karaoke-online:' || p_what || ':' || b.id,
    'title', jsonb_build_object(
      'th', case p_what when 'new' then 'มีคนจองห้องคาราโอเกะออนไลน์ ' else 'ลูกค้ายกเลิกการจองห้อง ' end || v_when,
      'en', case p_what when 'new' then 'New online room booking ' else 'Room booking cancelled by the guest ' end || v_when),
    'body', jsonb_build_object(
      'th', 'ห้อง: ' || coalesce(v_room, '-') || E'\nลูกค้า: ' || b.guest_name || E'\nโทร: ' || coalesce(b.phone, '-')
            || case when b.deposit_due > 0 then E'\nมัดจำ: ' || to_char(b.deposit_due / 100.0, 'FM999,990.00') || ' บาท' else '' end,
      'en', 'Room: ' || coalesce(v_room, '-') || E'\nGuest: ' || b.guest_name || E'\nPhone: ' || coalesce(b.phone, '-')
            || case when b.deposit_due > 0 then E'\nDeposit: THB ' || to_char(b.deposit_due / 100.0, 'FM999,990.00') else '' end));
  perform public.notify_managers(b.org_id, b.store_id, v_n);
exception when others then
  raise warning 'notify_karaoke_booking failed: %', sqlerrm;
end $$;
revoke all on function public.notify_karaoke_booking(uuid, text) from public, anon, authenticated;

-- the tick: an online booking whose deposit did not arrive in time is released (the room is free again)
create or replace function public.karaoke_release_unpaid() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  with due as (
    select b.id from public.karaoke_bookings b
     where b.status = 'booked' and b.source = 'online' and b.deposit_due > 0 and b.hold_until is not null and b.hold_until <= now()
       and coalesce((select sum(d.amount) from public.karaoke_deposits d where d.booking_id = b.id and d.status in ('held', 'on_bill')), 0) < b.deposit_due
     for update skip locked limit 200)
  update public.karaoke_bookings b set status = 'cancelled', note = left(coalesce(b.note || ' · ', '') || 'released: deposit not received', 300)
    from due where b.id = due.id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.karaoke_release_unpaid() from public, anon, authenticated;
grant execute on function public.karaoke_release_unpaid() to service_role;

-- ── deposits at the counter ──
-- p = { booking_id, amount, method, device_id? (needed for cash), reference? }
create or replace function public.record_karaoke_deposit(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b public.karaoke_bookings%rowtype;
  r public.karaoke_rooms%rowtype;
  v_amount bigint := (p ->> 'amount')::bigint;
  v_method text := p ->> 'method';
  v_dev uuid := nullif(p ->> 'device_id', '')::uuid;
  v_held bigint;
  v_staff uuid;
  v_id uuid;
begin
  select * into b from public.karaoke_bookings where id = (p ->> 'booking_id')::uuid for update;
  if not found or not (public.can_access_store(b.org_id, b.store_id) and public.has_permission(b.org_id, 'payment.take')) then
    raise exception 'taking a deposit needs payment.take in this shop' using errcode = '42501';
  end if;
  if not public.karaoke_enabled(b.store_id) then raise exception 'the karaoke module is off in this shop' using errcode = '0A000'; end if;
  if b.status not in ('booked', 'arrived') then raise exception 'a deposit is taken before the visit' using errcode = '55000'; end if;
  if v_method not in ('cash', 'promptpay', 'gateway') then raise exception 'unknown method' using errcode = '22023'; end if;
  if v_amount is null or v_amount < 1 then raise exception 'the amount must be above zero' using errcode = '22023'; end if;
  if v_method = 'cash' and not exists (select 1 from public.devices d where d.id = v_dev and d.store_id = b.store_id and d.active) then
    raise exception 'a cash deposit needs the till it went into' using errcode = '22023';
  end if;
  if v_method <> 'cash' then v_dev := null; end if;
  select * into r from public.karaoke_rooms where id = b.room_id;
  select coalesce(sum(amount), 0) into v_held from public.karaoke_deposits where booking_id = b.id and status in ('held', 'on_bill');
  if v_held + v_amount > public.karaoke_amount(r.rate_per_hour, (extract(epoch from (b.ends_at - b.starts_at)) / 60)::integer) then
    raise exception 'deposits cannot be more than the price of the booked time' using errcode = '22023';
  end if;
  select f.id into v_staff from public.staff f where f.org_id = b.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.karaoke_deposits (org_id, store_id, booking_id, amount, method, device_id, reference, created_by)
  values (b.org_id, b.store_id, b.id, v_amount, v_method, v_dev, left(nullif(btrim(coalesce(p ->> 'reference', '')), ''), 100), v_staff)
  returning id into v_id;
  perform public.audit_record(b.org_id, b.store_id, 'payment.tender', 'karaoke_bookings', b.id::text,
    jsonb_build_object('deposit', v_amount, 'method', v_method), 'db');
  return v_id;
end $$;

-- p = { deposit_id, action: 'forfeit' | 'refund', device_id? (needed to refund cash) } — for a cancelled / no-show booking, or a deposit left over after the visit was billed
create or replace function public.resolve_karaoke_deposit(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  d public.karaoke_deposits%rowtype;
  b public.karaoke_bookings%rowtype;
  v_action text := p ->> 'action';
  v_dev uuid := nullif(p ->> 'device_id', '')::uuid;
  v_staff uuid;
begin
  select * into d from public.karaoke_deposits where id = (p ->> 'deposit_id')::uuid for update;
  if not found or not (public.can_access_store(d.org_id, d.store_id) and public.has_permission(d.org_id, 'refund.create')) then
    raise exception 'settling a deposit needs refund.create' using errcode = '42501';
  end if;
  select * into b from public.karaoke_bookings where id = d.booking_id;
  if d.status <> 'held' then raise exception 'this deposit is already %', d.status using errcode = '55000'; end if;
  if b.status not in ('cancelled', 'no_show', 'done') then raise exception 'a deposit is settled when the booking is cancelled, a no-show or finished' using errcode = '55000'; end if;
  if v_action not in ('forfeit', 'refund') then raise exception 'unknown action' using errcode = '22023'; end if;
  if v_action = 'refund' and d.method = 'cash' and not exists (select 1 from public.devices x where x.id = v_dev and x.store_id = d.store_id and x.active) then
    raise exception 'a cash refund needs the till it came out of' using errcode = '22023';
  end if;
  select f.id into v_staff from public.staff f where f.org_id = d.org_id and f.user_id = auth.uid() and f.active limit 1;
  update public.karaoke_deposits
     set status = case when v_action = 'forfeit' then 'forfeited' else 'refunded' end, resolved_at = now(), resolved_by = v_staff,
         resolved_device_id = case when v_action = 'refund' and d.method = 'cash' then v_dev end
   where id = d.id;
  perform public.audit_record(d.org_id, d.store_id, 'payment.refund', 'karaoke_bookings', d.booking_id::text,
    jsonb_build_object('deposit', d.amount, 'action', v_action), 'db');
  return case when v_action = 'forfeit' then 'forfeited' else 'refunded' end;
end $$;
revoke all on function public.record_karaoke_deposit(jsonb), public.resolve_karaoke_deposit(jsonb) from public, anon;
grant execute on function public.record_karaoke_deposit(jsonb), public.resolve_karaoke_deposit(jsonb) to authenticated, service_role;

-- ── the room's bill takes the deposits held for the booking as already-paid shares ──
create or replace function public.karaoke_to_order(p_session uuid, p_device uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  x public.karaoke_sessions%rowtype; r public.karaoke_rooms%rowtype; v_dev uuid := p_device; v_order uuid; v_no integer; v_staff uuid;
  d public.karaoke_deposits%rowtype; v_in bigint := 0;
begin
  select * into x from public.karaoke_sessions where id = p_session for update;
  if not found or not (public.can_access_store(x.org_id, x.store_id) and public.has_permission(x.org_id, 'order.create')) then
    raise exception 'billing a room needs order.create in this shop' using errcode = '42501';
  end if;
  if x.order_id is not null and exists (select 1 from public.orders o where o.id = x.order_id and o.status <> 'void') then return x.order_id; end if;
  if x.ended_at is null then raise exception 'stop the room before billing it' using errcode = '55000'; end if;
  if x.amount <= 0 then raise exception 'there is nothing to bill for this room' using errcode = '22023'; end if;
  select * into r from public.karaoke_rooms where id = x.room_id;
  if v_dev is not null and not exists (select 1 from public.devices d2 where d2.id = v_dev and d2.store_id = x.store_id and d2.active) then v_dev := null; end if;
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
  -- the deposits received for the booking are already-paid shares of this bill (never more than the bill; a rest stays held for a manager to settle)
  if x.booking_id is not null then
    for d in select * from public.karaoke_deposits where booking_id = x.booking_id and status = 'held' order by created_at loop
      exit when v_in + d.amount > x.amount;
      insert into public.order_partial_payments (id, org_id, store_id, order_id, tender, amount, provider_ref, kind, note)
      values (d.id, d.org_id, d.store_id, v_order, d.method, d.amount, 'deposit:' || d.id, 'deposit', 'deposit');
      update public.karaoke_deposits set status = 'on_bill', order_id = v_order where id = d.id;
      v_in := v_in + d.amount;
    end loop;
  end if;
  update public.karaoke_sessions set order_id = v_order where id = x.id;
  return v_order;
end $$;

-- ── the drawer: cash deposits come in, refunded ones go out (a deposit applied to a bill is not counted twice: its payment reference starts with 'deposit:') ──
do $$
declare r record; src text; dst text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'close_shift' loop
    src := pg_get_functiondef(r.oid);
    dst := replace(src, 'fs.created_at <= v_close);', $a$fs.created_at <= v_close)
    + (select coalesce(sum(kd.amount), 0) from public.karaoke_deposits kd
        where kd.device_id = s.device_id and kd.method = 'cash' and kd.created_at >= s.opened_at and kd.created_at <= v_close)
    - (select coalesce(sum(kd.amount), 0) from public.karaoke_deposits kd
        where kd.resolved_device_id = s.device_id and kd.method = 'cash' and kd.status = 'refunded'
          and kd.resolved_at >= s.opened_at and kd.resolved_at <= v_close);$a$);
    if dst = src then raise exception 'migration 75: close_shift not changed'; end if;
    execute dst;
  end loop;
end $$;
