-- Bestie POS · migration 54 · ONLINE BOOKING by guests (module `booking.online`) + appointment reminders for the staff.
--
--  * A shop has ONE booking link: a random 128-bit token (`stores.booking_token`) the owner can show, print or replace. The token is the
--    only key a guest has; a phone talks to the database only through the service-role functions below (called by /api/guest/booking).
--  * Settings are data (`stores.booking_settings`): opening / closing time of bookable hours, step between start times, the shortest
--    notice (lead minutes) and how many days ahead. Changed through `save_booking_settings` (menu.edit, audited).
--  * The guest picks a SERVICE (a menu item with a length in minutes, available), a stylist / therapist or "anyone", a day and a time.
--    `guest_booking_slots` lists the free start times; `guest_book` re-checks everything (the same `appointment_check_free` the front desk
--    uses), picks a free provider for "anyone", stores the booking as `source = 'online'`, status `booked` (staff confirm), and returns a
--    CANCEL CODE once (only its SHA-256 is stored). A repeated `client_id` returns the first answer. Rooms / beds are not chosen online.
--  * Abuse limits: 12 online bookings per shop per 10 minutes, at most 3 upcoming online bookings per phone number, name 1-80, phone 6-30.
--  * `guest_cancel_booking`: the guest cancels with the booking id + code while it is booked / confirmed and not yet started.
--  * Staff are told: managers get "new online booking" / "cancelled" (app + LINE), the stylist's linked staff member gets it too.
--  * `appointment_reminders()` (called by the notification tick): a booked / confirmed appointment that starts within the next 90 minutes
--    tells the provider's linked staff member once (category `reminder` = opt-in on LINE; always in the app inbox).
--    Reminding the GUEST needs a way to reach them (LINE friend / e-mail) that does not exist yet — see docs/DECISIONS.md.

-- registry:booking.online profiles= plan=pro,resort depends=appointments
create or replace function public.booking_online_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.appointments_enabled(p_store) and exists (
    select 1 from public.stores s
     where s.id = p_store and s.plan in ('pro', 'resort')
       and coalesce((s.module_overrides ->> 'booking.online')::boolean, false))
$$;
revoke all on function public.booking_online_enabled(uuid) from public, anon;
grant execute on function public.booking_online_enabled(uuid) to authenticated, service_role;

create or replace function public.stores_check_modules() returns trigger
language plpgsql set search_path = '' as $$
declare
  k text;
  known text[] := array['tables.floorplan','bill.split','queue.call','kds','order.qr','kiosk','delivery','service.charge',
    'appointments','resources','deposits','commission','packages','booking.online','slots.booking','folio','pms','stock','recipe.cost',
    'loyalty.network','tender.promptpay','tender.gateway','tender.credit','tender.points','credit.topup.crypto',
    'ai.assistant','ai.guest','line.notify'];
  crypto_ok boolean;
begin
  for k in select jsonb_object_keys(new.module_overrides) loop
    if not (k = any (known)) then raise exception 'unknown module %', k using errcode = '23514'; end if;
    if jsonb_typeof(new.module_overrides -> k) <> 'boolean' then raise exception 'module % must be true or false', k using errcode = '23514'; end if;
  end loop;
  if (new.module_overrides ->> 'credit.topup.crypto') = 'true' then
    select coalesce((o.legal_sign_off ->> 'cryptoTopup')::boolean, false) into crypto_ok from public.orgs o where o.id = new.org_id;
    if not coalesce(crypto_ok, false) then
      raise exception 'crypto top-up needs the org legal sign-off' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- ── data ──
alter table public.stores add column booking_token text unique check (booking_token is null or booking_token ~ '^[0-9a-f]{32}$');
alter table public.stores add column booking_settings jsonb not null default '{}'::jsonb check (
  jsonb_typeof(booking_settings) = 'object'
  and not (booking_settings - 'open' - 'close' - 'step_min' - 'lead_min' - 'max_days') <> '{}'::jsonb);

alter table public.appointments add column cancel_hash text;
alter table public.appointments add column online_client_id uuid;
alter table public.appointments add column reminder_sent_at timestamptz;
create unique index appointments_online_client_uidx on public.appointments (store_id, online_client_id) where online_client_id is not null;
create index appointments_reminder_idx on public.appointments (starts_at) where reminder_sent_at is null and status in ('booked', 'confirmed');

-- the settings with their defaults filled in
create or replace function public.booking_cfg(p_settings jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'open',     coalesce(nullif(p_settings ->> 'open', ''), '09:00'),
    'close',    coalesce(nullif(p_settings ->> 'close', ''), '20:00'),
    'step_min', coalesce((p_settings ->> 'step_min')::integer, 30),
    'lead_min', coalesce((p_settings ->> 'lead_min')::integer, 120),
    'max_days', coalesce((p_settings ->> 'max_days')::integer, 30))
$$;
revoke all on function public.booking_cfg(jsonb) from public, anon;
grant execute on function public.booking_cfg(jsonb) to authenticated, service_role;

-- ── the owner's side ──
-- p = { open?, close?, step_min?, lead_min?, max_days?, rotate? }  → { token, settings }
create or replace function public.save_booking_settings(p_store uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype;
  v jsonb := '{}'::jsonb;
  c jsonb;
  v_token text;
begin
  select * into s from public.stores where id = p_store and deleted_at is null for update;
  if not found or not public.can_access_store(s.org_id, s.id) or not public.can_edit_menu(s.id) then
    raise exception 'booking settings need menu.edit in this shop' using errcode = '42501';
  end if;
  if not public.appointments_enabled(p_store) then raise exception 'the appointments module is off in this shop' using errcode = '0A000'; end if;
  if p ? 'open' then v := v || jsonb_build_object('open', p ->> 'open'); end if;
  if p ? 'close' then v := v || jsonb_build_object('close', p ->> 'close'); end if;
  if p ? 'step_min' then v := v || jsonb_build_object('step_min', (p ->> 'step_min')::integer); end if;
  if p ? 'lead_min' then v := v || jsonb_build_object('lead_min', (p ->> 'lead_min')::integer); end if;
  if p ? 'max_days' then v := v || jsonb_build_object('max_days', (p ->> 'max_days')::integer); end if;
  v := s.booking_settings || v;
  c := public.booking_cfg(v);
  if (c ->> 'open') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or (c ->> 'close') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or (c ->> 'open')::time >= (c ->> 'close')::time then
    raise exception 'opening time must be before closing time (HH:MM)' using errcode = '22023';
  end if;
  if (c ->> 'step_min')::integer not between 5 and 120 or (c ->> 'lead_min')::integer not between 0 and 10080
     or (c ->> 'max_days')::integer not between 1 and 180 then
    raise exception 'booking settings out of range' using errcode = '22023';
  end if;
  v_token := s.booking_token;
  if v_token is null or coalesce((p ->> 'rotate')::boolean, false) then
    v_token := replace(gen_random_uuid()::text, '-', '');
  end if;
  update public.stores set booking_settings = c, booking_token = v_token where id = s.id;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'stores.booking', s.id::text, c || jsonb_build_object('rotated', v_token is distinct from s.booking_token), 'db');
  return jsonb_build_object('token', v_token, 'settings', c);
end $$;
revoke all on function public.save_booking_settings(uuid, jsonb) from public, anon;
grant execute on function public.save_booking_settings(uuid, jsonb) to authenticated, service_role;

-- ── the guest's side (service role only; the token is the key) ──
create or replace function public.booking_store(p_token text) returns public.stores
language sql stable security definer set search_path = '' as $$
  select s.* from public.stores s where p_token ~ '^[0-9a-f]{32}$' and s.booking_token = p_token and s.deleted_at is null limit 1
$$;
revoke all on function public.booking_store(text) from public, anon, authenticated;
grant execute on function public.booking_store(text) to service_role;

create or replace function public.guest_booking_info(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype;
begin
  s := public.booking_store(p_token);
  if s.id is null then return null; end if;
  if not public.booking_online_enabled(s.id) then return jsonb_build_object('store_name', s.name, 'open', false); end if;
  return jsonb_build_object(
    'open', true,
    'store_name', s.name,
    'settings', public.booking_cfg(s.booking_settings),
    'services', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'duration_min', m.duration_min,
                  'price', coalesce((m.prices ->> 'base')::bigint, 0)) order by m.sort, m.created_at)
                from public.menu_items m
               where m.store_id = s.id and m.deleted_at is null and m.available and m.duration_min is not null), '[]'::jsonb),
    'providers', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name) order by r.sort, r.created_at)
                from public.resources r
               where r.store_id = s.id and r.active and r.deleted_at is null and r.kind in ('stylist', 'therapist')), '[]'::jsonb));
end $$;

-- free start times ("HH:MM", Bangkok) of one day for one service; p_provider null = anyone
create or replace function public.guest_booking_slots(p_token text, p_service uuid, p_provider uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.stores%rowtype;
  m public.menu_items%rowtype;
  c jsonb;
  v_open time; v_close time; v_step integer;
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
  v_min timestamptz;
  v_out jsonb := '[]'::jsonb;
  t time;
  v_start timestamptz; v_end timestamptz;
begin
  s := public.booking_store(p_token);
  if s.id is null or not public.booking_online_enabled(s.id) then return null; end if;
  c := public.booking_cfg(s.booking_settings);
  select * into m from public.menu_items where id = p_service and store_id = s.id and deleted_at is null and available and duration_min is not null;
  if not found then return '[]'::jsonb; end if;
  if p_date is null or p_date < v_today or p_date > v_today + (c ->> 'max_days')::integer then return '[]'::jsonb; end if;
  v_open := (c ->> 'open')::time; v_close := (c ->> 'close')::time; v_step := (c ->> 'step_min')::integer;
  v_min := now() + make_interval(mins => (c ->> 'lead_min')::integer);
  t := v_open;
  while t + make_interval(mins => m.duration_min) <= v_close loop
    v_start := (p_date + t) at time zone 'Asia/Bangkok';
    v_end := v_start + make_interval(mins => m.duration_min);
    if v_start >= v_min and exists (
         select 1 from public.resources r
          where r.store_id = s.id and r.active and r.deleted_at is null and r.kind in ('stylist', 'therapist')
            and (p_provider is null or r.id = p_provider)
            and not exists (select 1 from public.appointments a
                             where a.provider_id = r.id and a.status in ('booked', 'confirmed', 'arrived', 'in_service')
                               and a.starts_at < v_end and a.ends_at > v_start)) then
      v_out := v_out || to_jsonb(to_char(t, 'HH24:MI'));
    end if;
    t := t + make_interval(mins => v_step);
    exit when t < v_open;                                  -- wrapped past midnight
  end loop;
  return v_out;
end $$;

-- p = { service_id, provider_id?, date 'YYYY-MM-DD', time 'HH:MM', name, phone, note?, client_id }
-- → { ok: true, id, code, starts_at, provider } | { ok: false, error: 'off'|'invalid'|'taken'|'too_many' }
create or replace function public.guest_book(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype;
  m public.menu_items%rowtype;
  c jsonb;
  v_client uuid;
  v_date date; v_time time;
  v_start timestamptz; v_end timestamptz;
  v_name text := btrim(coalesce(p ->> 'name', ''));
  v_phone text := btrim(coalesce(p ->> 'phone', ''));
  v_digits text;
  v_provider uuid := nullif(p ->> 'provider_id', '')::uuid;
  v_code text;
  v_id uuid;
  v_prov_name text;
  v_first public.appointments%rowtype;
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  s := public.booking_store(p_token);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not public.booking_online_enabled(s.id) then return jsonb_build_object('ok', false, 'error', 'off'); end if;
  c := public.booking_cfg(s.booking_settings);
  begin
    v_client := (p ->> 'client_id')::uuid;
    v_date := (p ->> 'date')::date;
    v_time := (p ->> 'time')::time;
  exception when others then return jsonb_build_object('ok', false, 'error', 'invalid');
  end;
  v_digits := regexp_replace(v_phone, '[^0-9]', '', 'g');
  if v_client is null or v_date is null or v_time is null or length(v_name) not between 1 and 80
     or length(v_phone) not between 6 and 30 or length(v_digits) < 6 or length(coalesce(p ->> 'note', '')) > 300 then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  -- a repeated request returns the first answer
  select * into v_first from public.appointments where store_id = s.id and online_client_id = v_client;
  if found then
    return jsonb_build_object('ok', true, 'id', v_first.id, 'code', null, 'starts_at', v_first.starts_at, 'repeat', true,
      'provider', (select r.name from public.resources r where r.id = v_first.provider_id));
  end if;
  select * into m from public.menu_items where id = nullif(p ->> 'service_id', '')::uuid and store_id = s.id and deleted_at is null and available and duration_min is not null;
  if not found then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  if v_date < v_today or v_date > v_today + (c ->> 'max_days')::integer
     or v_time < (c ->> 'open')::time or v_time + make_interval(mins => m.duration_min) > (c ->> 'close')::time
     or ((extract(epoch from (v_time - (c ->> 'open')::time)) / 60)::integer % (c ->> 'step_min')::integer) <> 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  v_start := (v_date + v_time) at time zone 'Asia/Bangkok';
  v_end := v_start + make_interval(mins => m.duration_min);
  if v_start < now() + make_interval(mins => (c ->> 'lead_min')::integer) then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  -- limits
  if (select count(*) from public.appointments a where a.store_id = s.id and a.source = 'online' and a.created_at > now() - interval '10 minutes') >= 12
     or (select count(*) from public.appointments a where a.store_id = s.id and a.source = 'online' and a.starts_at > now()
            and a.status in ('booked', 'confirmed') and regexp_replace(coalesce(a.guest_phone, ''), '[^0-9]', '', 'g') = v_digits) >= 3 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  -- pick the provider
  if v_provider is not null then
    begin
      perform public.appointment_check_free(s.id, v_provider, null, v_start, v_end);
    exception when sqlstate '23P01' then return jsonb_build_object('ok', false, 'error', 'taken');
              when sqlstate '22023' then return jsonb_build_object('ok', false, 'error', 'invalid');
    end;
  else
    for v_provider in select r.id from public.resources r
                       where r.store_id = s.id and r.active and r.deleted_at is null and r.kind in ('stylist', 'therapist') order by r.sort, r.created_at loop
      begin
        perform public.appointment_check_free(s.id, v_provider, null, v_start, v_end);
        exit;
      exception when sqlstate '23P01' then v_provider := null;
      end;
    end loop;
    if v_provider is null then return jsonb_build_object('ok', false, 'error', 'taken'); end if;
  end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into public.appointments (org_id, store_id, provider_id, service_id, service_name, price, guest_name, guest_phone,
                                   starts_at, ends_at, note, source, cancel_hash, online_client_id)
  values (s.org_id, s.id, v_provider, m.id, m.name, coalesce((m.prices ->> 'base')::bigint, 0), v_name, left(v_phone, 30),
          v_start, v_end, left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 300), 'online',
          encode(sha256(convert_to(v_code, 'utf8')), 'hex'), v_client)
  returning id into v_id;
  select r.name into v_prov_name from public.resources r where r.id = v_provider;
  perform public.notify_online_booking(v_id, 'new');
  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code, 'starts_at', v_start, 'provider', v_prov_name);
end $$;

create or replace function public.guest_cancel_booking(p_token text, p_id uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype;
  a public.appointments%rowtype;
begin
  s := public.booking_store(p_token);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select * into a from public.appointments where id = p_id and store_id = s.id and source = 'online' for update;
  if not found or a.cancel_hash is null or a.cancel_hash <> encode(sha256(convert_to(upper(btrim(coalesce(p_code, ''))), 'utf8')), 'hex') then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if a.status not in ('booked', 'confirmed') or a.starts_at <= now() then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  update public.appointments set status = 'cancelled' where id = a.id;
  perform public.notify_online_booking(a.id, 'cancelled');
  return jsonb_build_object('ok', true);
end $$;

-- ── telling the shop ──
create or replace function public.notify_online_booking(p_id uuid, p_what text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  a public.appointments%rowtype;
  v_when_th text; v_when_en text;
  v_who uuid;
  v_n jsonb;
begin
  select * into a from public.appointments where id = p_id;
  if not found then return; end if;
  v_when_th := to_char(a.starts_at at time zone 'Asia/Bangkok', 'DD/MM HH24:MI');
  v_when_en := v_when_th;
  v_n := jsonb_build_object(
    'kind', case p_what when 'new' then 'appointment.online' else 'appointment.online_cancel' end,
    'href', '/calendar', 'dedupe', 'online:' || p_what || ':' || a.id,
    'title', jsonb_build_object(
      'th', case p_what when 'new' then 'มีคนจองออนไลน์ ' else 'ลูกค้ายกเลิกการจอง ' end || v_when_th,
      'en', case p_what when 'new' then 'New online booking ' else 'Booking cancelled by the guest ' end || v_when_en),
    'body', jsonb_build_object(
      'th', 'บริการ: ' || coalesce(a.service_name ->> 'th', '-') || E'\nลูกค้า: ' || a.guest_name || E'\nโทร: ' || coalesce(a.guest_phone, '-'),
      'en', 'Service: ' || coalesce(a.service_name ->> 'en', a.service_name ->> 'th', '-') || E'\nGuest: ' || a.guest_name || E'\nPhone: ' || coalesce(a.guest_phone, '-')));
  perform public.notify_managers(a.org_id, a.store_id, v_n);
  select st.user_id into v_who from public.resources r join public.staff st on st.id = r.staff_id
   where r.id = a.provider_id and st.active and st.user_id is not null;
  if v_who is not null then
    perform public.notify_user(v_n || jsonb_build_object('user_id', v_who, 'org_id', a.org_id));
  end if;
exception when others then
  raise warning 'notify_online_booking failed: %', sqlerrm;
end $$;

-- the tick: an appointment starting within the next p_minutes tells the provider's linked staff member (once)
create or replace function public.appointment_reminders(p_minutes integer default 90) returns integer
language plpgsql security definer set search_path = '' as $$
declare a record; n integer := 0;
begin
  for a in
    select ap.id, ap.org_id, ap.starts_at, ap.guest_name, ap.service_name, st.user_id
      from public.appointments ap
      join public.resources r on r.id = ap.provider_id
      join public.staff st on st.id = r.staff_id and st.active and st.user_id is not null
     where ap.reminder_sent_at is null and ap.status in ('booked', 'confirmed')
       and ap.starts_at > now() and ap.starts_at <= now() + make_interval(mins => least(greatest(p_minutes, 5), 1440))
     order by ap.starts_at limit 200
  loop
    perform public.notify_user(jsonb_build_object(
      'user_id', a.user_id, 'org_id', a.org_id, 'kind', 'appointment.soon', 'category', 'reminder', 'href', '/calendar',
      'dedupe', 'apt-soon:' || a.id,
      'title', jsonb_build_object('th', 'นัดถัดไป ' || to_char(a.starts_at at time zone 'Asia/Bangkok', 'HH24:MI'),
                                  'en', 'Next appointment ' || to_char(a.starts_at at time zone 'Asia/Bangkok', 'HH24:MI')),
      'body', jsonb_build_object('th', 'ลูกค้า: ' || a.guest_name || E'\nบริการ: ' || coalesce(a.service_name ->> 'th', '-'),
                                 'en', 'Guest: ' || a.guest_name || E'\nService: ' || coalesce(a.service_name ->> 'en', a.service_name ->> 'th', '-'))));
    update public.appointments set reminder_sent_at = now() where id = a.id;
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.guest_booking_info(text), public.guest_booking_slots(text, uuid, uuid, date), public.guest_book(text, jsonb),
  public.guest_cancel_booking(text, uuid, text), public.notify_online_booking(uuid, text), public.appointment_reminders(integer)
  from public, anon, authenticated;
grant execute on function public.guest_booking_info(text), public.guest_booking_slots(text, uuid, uuid, date), public.guest_book(text, jsonb),
  public.guest_cancel_booking(text, uuid, text), public.notify_online_booking(uuid, text), public.appointment_reminders(integer) to service_role;
