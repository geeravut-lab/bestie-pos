-- Bestie POS · migration 67 · (a) weekly days off that repeat by themselves, (b) reminders for appointments made at the counter.
--
-- (a) `resource_weekly_offs`: "every Monday", "every Tuesday and Wednesday 12:00-13:00" for a stylist, room or bed. The ONE rule that decides whether a time is free
--     (`appointment_check_free`, shared by the front desk, group booking and the online booking page) now also refuses a time inside a weekly off. A weekly off cannot be
--     put over a live booking (move it first). Weekdays are ISO 1 = Monday ... 7 = Sunday, in Bangkok time.
-- (b) A booking made at the counter has no cancel code and no guest contact. The front desk can now (1) store the guest's e-mail on the booking (`set_appointment_contact`)
--     and (2) hand the guest a ONE-TIME code to send to the shop's LINE (`appointment_guest_code`); both reuse the existing reminder tick and are erased with the other
--     guest contacts once the booking is over (migration 59).

create table public.resource_weekly_offs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  resource_id uuid not null references public.resources (id) on delete cascade,
  weekday     smallint not null check (weekday between 1 and 7),
  from_time   time not null default '00:00',
  to_time     time,                                                  -- null = until the end of the day
  reason      text check (reason is null or length(reason) <= 100),
  created_by  uuid references public.staff (id) on delete set null,
  created_at  timestamptz not null default now(),
  check (to_time is null or to_time > from_time),
  unique (resource_id, weekday, from_time)
);
create index resource_weekly_offs_resource_idx on public.resource_weekly_offs (resource_id);
alter table public.resource_weekly_offs enable row level security;
create policy resource_weekly_offs_read on public.resource_weekly_offs for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.resource_weekly_offs from anon, authenticated;
grant select on public.resource_weekly_offs to authenticated;

-- does the weekly pattern (weekday, from, to) touch the time range [p_start, p_end)? Bangkok days; null p_to = end of day
create or replace function public.weekly_pattern_hit(p_weekday integer, p_from time, p_to time, p_start timestamptz, p_end timestamptz) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  d date := (p_start at time zone 'Asia/Bangkok')::date;
  last_day date := ((p_end - interval '1 microsecond') at time zone 'Asia/Bangkok')::date;
  s timestamptz; e timestamptz; n integer := 0;
begin
  while d <= last_day and n < 70 loop
    if extract(isodow from d)::integer = p_weekday then
      s := (d + p_from) at time zone 'Asia/Bangkok';
      e := case when p_to is null then ((d + 1)::timestamp) at time zone 'Asia/Bangkok' else (d + p_to) at time zone 'Asia/Bangkok' end;
      if s < p_end and e > p_start then return true; end if;
    end if;
    d := d + 1; n := n + 1;
  end loop;
  return false;
end $$;
revoke all on function public.weekly_pattern_hit(integer, time, time, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.weekly_pattern_hit(integer, time, time, timestamptz, timestamptz) to service_role;

create or replace function public.weekly_off_hit(p_resource uuid, p_start timestamptz, p_end timestamptz) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.resource_weekly_offs w
                  where w.resource_id = p_resource and public.weekly_pattern_hit(w.weekday, w.from_time, w.to_time, p_start, p_end))
$$;
revoke all on function public.weekly_off_hit(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.weekly_off_hit(uuid, timestamptz, timestamptz) to service_role;

create or replace function public.appointment_check_free(
  p_store uuid, p_provider uuid, p_place uuid, p_start timestamptz, p_end timestamptz, p_ignore uuid default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.resources%rowtype;
begin
  perform 1 from public.resources where id in (p_provider, p_place) order by id for update;
  if p_provider is not null then
    select * into r from public.resources where id = p_provider and store_id = p_store and active and deleted_at is null and kind in ('stylist', 'therapist');
    if not found then raise exception 'unknown or inactive provider' using errcode = '22023'; end if;
    if exists (select 1 from public.appointments a
                where a.provider_id = p_provider and a.status in ('booked', 'confirmed', 'arrived', 'in_service')
                  and a.starts_at < p_end and a.ends_at > p_start and a.id is distinct from p_ignore) then
      raise exception 'that provider is busy at that time' using errcode = '23P01';
    end if;
    if exists (select 1 from public.resource_blocks b where b.resource_id = p_provider and b.starts_at < p_end and b.ends_at > p_start)
       or public.weekly_off_hit(p_provider, p_start, p_end) then
      raise exception 'that provider is off at that time' using errcode = '23P01';
    end if;
  end if;
  if p_place is not null then
    if not public.resources_enabled(p_store) then raise exception 'rooms and beds need the resources module' using errcode = '0A000'; end if;
    select * into r from public.resources where id = p_place and store_id = p_store and active and deleted_at is null and kind in ('room', 'bed', 'chair');
    if not found then raise exception 'unknown or inactive room / bed' using errcode = '22023'; end if;
    if exists (select 1 from public.appointments a
                where a.place_id = p_place and a.status in ('booked', 'confirmed', 'arrived', 'in_service')
                  and a.starts_at < p_end and a.ends_at > p_start and a.id is distinct from p_ignore) then
      raise exception 'that room / bed is taken at that time' using errcode = '23P01';
    end if;
    if exists (select 1 from public.resource_blocks b where b.resource_id = p_place and b.starts_at < p_end and b.ends_at > p_start)
       or public.weekly_off_hit(p_place, p_start, p_end) then
      raise exception 'that room / bed is closed at that time' using errcode = '23P01';
    end if;
  end if;
end $$;

-- p = { store_id, resource_id, weekdays: [1..7], from_time?: 'HH:MM', to_time?: 'HH:MM', reason? } → how many weekdays were added
create or replace function public.save_weekly_off(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_store uuid := (p ->> 'store_id')::uuid;
  s public.stores%rowtype;
  r public.resources%rowtype;
  v_from time := coalesce(nullif(p ->> 'from_time', '')::time, '00:00');
  v_to time := nullif(p ->> 'to_time', '')::time;
  v_days integer[];
  d integer;
  v_staff uuid;
  n integer := 0;
begin
  select * into s from public.stores where id = v_store and deleted_at is null;
  if not found or not public.can_edit_menu(v_store) then raise exception 'days off need menu.edit in this shop' using errcode = '42501'; end if;
  if not public.appointments_enabled(v_store) then raise exception 'the appointments module is off in this shop' using errcode = '0A000'; end if;
  select * into r from public.resources where id = (p ->> 'resource_id')::uuid and store_id = v_store and deleted_at is null;
  if not found then raise exception 'unknown person or room' using errcode = '22023'; end if;
  select array_agg(distinct x::integer) into v_days from jsonb_array_elements_text(coalesce(p -> 'weekdays', '[]'::jsonb)) x;
  if v_days is null or exists (select 1 from unnest(v_days) z where z not between 1 and 7) then raise exception 'choose weekdays 1 (Monday) to 7 (Sunday)' using errcode = '22023'; end if;
  if v_to is not null and v_to <= v_from then raise exception 'the end must be after the start' using errcode = '22023'; end if;
  perform 1 from public.resources where id = r.id for update;
  foreach d in array v_days loop
    if exists (select 1 from public.appointments a
                where (a.provider_id = r.id or a.place_id = r.id) and a.status in ('booked', 'confirmed', 'arrived', 'in_service') and a.ends_at > now()
                  and public.weekly_pattern_hit(d, v_from, v_to, a.starts_at, a.ends_at)) then
      raise exception 'there are bookings in that time: move or cancel them first' using errcode = '23P01';
    end if;
  end loop;
  select x.id into v_staff from public.staff x where x.org_id = s.org_id and x.user_id = auth.uid() and x.active limit 1;
  foreach d in array v_days loop
    insert into public.resource_weekly_offs (org_id, store_id, resource_id, weekday, from_time, to_time, reason, created_by)
    values (s.org_id, v_store, r.id, d, v_from, v_to, left(nullif(btrim(coalesce(p ->> 'reason', '')), ''), 100), v_staff)
    on conflict (resource_id, weekday, from_time) do update set to_time = excluded.to_time, reason = excluded.reason;
    n := n + 1;
  end loop;
  perform public.audit_record(s.org_id, v_store, 'settings.change', 'resource_weekly_offs', r.id::text,
    jsonb_build_object('weekdays', v_days, 'from', v_from, 'to', v_to), 'db');
  return n;
end $$;

create or replace function public.delete_weekly_off(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare w public.resource_weekly_offs%rowtype;
begin
  select * into w from public.resource_weekly_offs where id = p_id;
  if not found or not public.can_edit_menu(w.store_id) then raise exception 'days off need menu.edit in this shop' using errcode = '42501'; end if;
  delete from public.resource_weekly_offs where id = p_id;
  perform public.audit_record(w.org_id, w.store_id, 'settings.change', 'resource_weekly_offs', w.resource_id::text, jsonb_build_object('removed', p_id), 'db');
end $$;
revoke all on function public.save_weekly_off(jsonb), public.delete_weekly_off(uuid) from public, anon;
grant execute on function public.save_weekly_off(jsonb), public.delete_weekly_off(uuid) to authenticated, service_role;

-- ── (b) reminders for a booking made at the counter ──
-- the guest's e-mail, typed by the front desk ('' removes it); only a booking that has not started
create or replace function public.set_appointment_contact(p_appt uuid, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.appointments%rowtype; v_email text := lower(btrim(coalesce(p_email, '')));
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found or not (public.can_access_store(a.org_id, a.store_id) and public.has_permission(a.org_id, 'order.create')) then
    raise exception 'saving a contact needs order.create in this shop' using errcode = '42501';
  end if;
  if a.status not in ('booked', 'confirmed') or a.starts_at <= now() then raise exception 'this booking is no longer waiting' using errcode = '55000'; end if;
  if v_email <> '' and (length(v_email) > 120 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then raise exception 'that e-mail address is not valid' using errcode = '22023'; end if;
  update public.appointments set guest_email = nullif(v_email, '') where id = a.id;
end $$;

-- a one-time code for a counter booking: the guest sends it to the shop's LINE (the webhook binds that LINE user to THIS booking). Only the hash is kept.
create or replace function public.appointment_guest_code(p_appt uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare a public.appointments%rowtype; v_code text;
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found or not (public.can_access_store(a.org_id, a.store_id) and public.has_permission(a.org_id, 'order.create')) then
    raise exception 'a reminder code needs order.create in this shop' using errcode = '42501';
  end if;
  if a.source <> 'staff' then raise exception 'an online booking already gave its code to the guest' using errcode = '55000'; end if;
  if a.status not in ('booked', 'confirmed') or a.starts_at <= now() then raise exception 'this booking is no longer waiting' using errcode = '55000'; end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  update public.appointments set cancel_hash = encode(sha256(convert_to(v_code, 'utf8')), 'hex') where id = a.id;
  return v_code;
end $$;
revoke all on function public.set_appointment_contact(uuid, text), public.appointment_guest_code(uuid) from public, anon;
grant execute on function public.set_appointment_contact(uuid, text), public.appointment_guest_code(uuid) to authenticated, service_role;

-- the LINE binding accepted online bookings only; a counter booking with a code from `appointment_guest_code` is accepted too
create or replace function public.guest_bind_line(p_code text, p_line_user_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.appointments%rowtype;
  v_hash text := encode(sha256(convert_to(upper(btrim(coalesce(p_code, ''))), 'utf8')), 'hex');
begin
  if p_line_user_id is null or length(p_line_user_id) not between 5 and 64 then return jsonb_build_object('ok', false); end if;
  select * into a from public.appointments
   where cancel_hash = v_hash and status in ('booked', 'confirmed') and starts_at > now()
   order by starts_at limit 1 for update;
  if not found then return jsonb_build_object('ok', false); end if;
  update public.appointments set guest_line_user_id = p_line_user_id where id = a.id;
  return jsonb_build_object('ok', true, 'starts_at', a.starts_at);
end $$;
