-- Bestie POS · migration 49 · APPOINTMENTS and RESOURCES (modules `appointments`, `resources`) — Phase 2 starts here.
--
--  * `resources`: the people and places a booking is made against — stylist / therapist (a PROVIDER: "calendar by stylist") and
--    room / bed / chair (a PLACE: "calendar by room / bed"). Written by whoever can edit the menu (owner, manager).
--  * `appointments`: one booking = one service for one guest at one time, with an optional provider and an optional place. The service
--    is taken from the shop's menu (a menu item can carry `duration_min`) and its name and price are SNAPSHOTTED, so later menu edits
--    never change an old booking. Written ONLY through functions (no insert / update grant) so the rules below always apply:
--      - the module `appointments` must be on in the shop (a SQL copy of the registry entry, kept honest by guestSql.test.ts);
--        places (room / bed / chair) additionally need the module `resources`;
--      - the provider and the place must belong to the shop, be active, and be free for the whole time (no overlap with another
--        booked / confirmed / arrived / in-service appointment; back to back is fine; cancelled / no-show / done free the slot);
--      - a status moves forward only: booked → confirmed → arrived → in service → done, or → cancelled / no-show before service.
--  * Needs `order.create` (front desk: cashier, waiter, manager, owner) to book, move or change the status.
--  Billing the finished appointment on the till and online booking by guests come next; `source` already tells the two apart.

alter table public.menu_items add column duration_min integer check (duration_min is null or duration_min between 5 and 720);

-- ── is the module on in this shop? (mirrors the registry) ──
-- registry:appointments profiles=salon,spa plan=pro,resort
create or replace function public.appointments_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.stores s
     where s.id = p_store and s.deleted_at is null and s.plan in ('pro', 'resort')
       and coalesce((s.module_overrides ->> 'appointments')::boolean, s.profile in ('salon', 'spa')))
$$;
-- registry:resources profiles=spa,resort plan=pro,resort depends=appointments
create or replace function public.resources_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.appointments_enabled(p_store) and exists (
    select 1 from public.stores s
     where s.id = p_store and s.plan in ('pro', 'resort')
       and coalesce((s.module_overrides ->> 'resources')::boolean, s.profile in ('spa', 'resort')))
$$;
revoke all on function public.appointments_enabled(uuid), public.resources_enabled(uuid) from public, anon;
grant execute on function public.appointments_enabled(uuid), public.resources_enabled(uuid) to authenticated, service_role;

-- ── resources ──
create table public.resources (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 60),
  kind       text not null check (kind in ('stylist', 'therapist', 'room', 'bed', 'chair')),
  staff_id   uuid references public.staff (id) on delete set null,          -- the person behind a stylist / therapist, when known
  sort       integer not null default 0 check (sort between -100000 and 100000),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index resources_name_uidx on public.resources (store_id, lower(btrim(name))) where deleted_at is null;
create index resources_store_idx on public.resources (store_id) where deleted_at is null;
create trigger resources_touch before update on public.resources for each row execute function public.touch_updated_at();

create or replace function public.resources_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.stores s where s.id = new.store_id and s.org_id = new.org_id) then
    raise exception 'store does not belong to this org' using errcode = '23514';
  end if;
  if new.staff_id is not null and not exists (select 1 from public.staff f where f.id = new.staff_id and f.org_id = new.org_id) then
    raise exception 'the person belongs to another business' using errcode = '23514';
  end if;
  if new.kind in ('room', 'bed', 'chair') and not public.resources_enabled(new.store_id) then
    raise exception 'rooms and beds need the resources module' using errcode = '0A000';
  end if;
  if new.kind in ('stylist', 'therapist') and not public.appointments_enabled(new.store_id) then
    raise exception 'the appointments module is off in this shop' using errcode = '0A000';
  end if;
  return new;
end $$;
create trigger resources_check_trg before insert or update of kind, store_id, org_id, staff_id on public.resources
  for each row execute function public.resources_check();

-- ── appointments ──
create table public.appointments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs (id) on delete cascade,
  store_id     uuid not null references public.stores (id) on delete cascade,
  provider_id  uuid references public.resources (id),
  place_id     uuid references public.resources (id),
  service_id   uuid references public.menu_items (id) on delete set null,
  service_name jsonb not null check (jsonb_typeof(service_name) = 'object' and length(btrim(coalesce(service_name ->> 'th', ''))) between 1 and 120),
  price        bigint not null default 0 check (price between 0 and 100000000),                 -- satang, snapshot
  customer_id  uuid references public.customers (id) on delete set null,
  guest_name   text not null check (length(btrim(guest_name)) between 1 and 80),
  guest_phone  text check (guest_phone is null or length(guest_phone) <= 30),
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  status       text not null default 'booked' check (status in ('booked', 'confirmed', 'arrived', 'in_service', 'done', 'cancelled', 'no_show')),
  source       text not null default 'staff' check (source in ('staff', 'online')),
  note         text check (note is null or length(note) <= 300),
  created_by   uuid references public.staff (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (ends_at > starts_at and ends_at - starts_at <= interval '12 hours')
);
create index appointments_store_idx on public.appointments (store_id, starts_at);
create index appointments_provider_idx on public.appointments (provider_id, starts_at) where provider_id is not null;
create index appointments_place_idx on public.appointments (place_id, starts_at) where place_id is not null;
create trigger appointments_touch before update on public.appointments for each row execute function public.touch_updated_at();

-- ── rights ──
alter table public.resources enable row level security;
alter table public.appointments enable row level security;
create policy resources_read on public.resources for select to authenticated using (public.can_access_store(org_id, store_id));
create policy resources_write on public.resources for all to authenticated
  using (public.can_edit_menu(store_id)) with check (public.can_edit_menu(store_id));
create policy appointments_read on public.appointments for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.resources, public.appointments from anon, authenticated;
grant select, insert, update, delete on public.resources to authenticated;
grant select on public.appointments to authenticated;
create trigger resources_live after insert or update on public.resources for each row execute function public.live_ping_row('store:{store_id}');
create trigger appointments_live after insert or update on public.appointments for each row execute function public.live_ping_row('store:{store_id}');

-- ── the one place that decides whether a time is free ──
-- Locks the provider / place rows so two people booking at once are serialised, then looks for an overlap.
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
  end if;
end $$;
revoke all on function public.appointment_check_free(uuid, uuid, uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.appointment_check_free(uuid, uuid, uuid, timestamptz, timestamptz, uuid) to service_role;

-- p = { store_id, provider_id?, place_id?, service_id? | service_name?, price?, duration_min?, starts_at, guest_name, guest_phone?, customer_id?, note? }
create or replace function public.book_appointment(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_store uuid := (p ->> 'store_id')::uuid;
  s public.stores%rowtype;
  mi public.menu_items%rowtype;
  v_name jsonb;
  v_price bigint := 0;
  v_dur integer;
  v_start timestamptz := (p ->> 'starts_at')::timestamptz;
  v_end timestamptz;
  v_staff uuid;
  v_id uuid;
begin
  select * into s from public.stores where id = v_store and deleted_at is null;
  if not found or not public.can_access_store(s.org_id, s.id) or not public.has_permission(s.org_id, 'order.create') then
    raise exception 'booking needs order.create in this shop' using errcode = '42501';
  end if;
  if not public.appointments_enabled(v_store) then raise exception 'the appointments module is off in this shop' using errcode = '0A000'; end if;
  if v_start is null then raise exception 'a start time is required' using errcode = '22023'; end if;

  if nullif(p ->> 'service_id', '') is not null then
    select * into mi from public.menu_items where id = (p ->> 'service_id')::uuid and store_id = v_store and deleted_at is null;
    if not found then raise exception 'unknown service' using errcode = '22023'; end if;
    v_name := mi.name;
    v_price := coalesce((mi.prices ->> 'base')::bigint, 0);
  else
    v_name := jsonb_build_object('th', btrim(coalesce(p #>> '{service_name,th}', '')));
    if p #>> '{service_name,en}' is not null then v_name := v_name || jsonb_build_object('en', p #>> '{service_name,en}'); end if;
    v_price := coalesce(nullif(p ->> 'price', '')::bigint, 0);
  end if;
  v_dur := coalesce(nullif(p ->> 'duration_min', '')::integer, mi.duration_min, 60);
  if v_dur not between 5 and 720 then raise exception 'a booking lasts 5 minutes to 12 hours' using errcode = '22023'; end if;
  v_end := v_start + make_interval(mins => v_dur);

  if nullif(p ->> 'customer_id', '') is not null
     and not exists (select 1 from public.customers c where c.id = (p ->> 'customer_id')::uuid and c.org_id = s.org_id) then
    raise exception 'unknown customer' using errcode = '22023';
  end if;
  perform public.appointment_check_free(v_store, nullif(p ->> 'provider_id', '')::uuid, nullif(p ->> 'place_id', '')::uuid, v_start, v_end);
  select f.id into v_staff from public.staff f where f.org_id = s.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.appointments (org_id, store_id, provider_id, place_id, service_id, service_name, price, customer_id,
                                   guest_name, guest_phone, starts_at, ends_at, note, created_by)
  values (s.org_id, v_store, nullif(p ->> 'provider_id', '')::uuid, nullif(p ->> 'place_id', '')::uuid, mi.id, v_name, v_price,
          nullif(p ->> 'customer_id', '')::uuid, btrim(coalesce(p ->> 'guest_name', '')), left(nullif(btrim(coalesce(p ->> 'guest_phone', '')), ''), 30),
          v_start, v_end, left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 300), v_staff)
  returning id into v_id;
  return v_id;
end $$;

-- forward-only status changes
create or replace function public.set_appointment_status(p_id uuid, p_status text) returns text
language plpgsql security definer set search_path = '' as $$
declare a public.appointments%rowtype;
begin
  select * into a from public.appointments where id = p_id for update;
  if not found or not public.can_access_store(a.org_id, a.store_id) or not public.has_permission(a.org_id, 'order.create') then
    raise exception 'appointments need order.create in this shop' using errcode = '42501';
  end if;
  if not (
       (a.status = 'booked'     and p_status in ('confirmed', 'arrived', 'cancelled', 'no_show'))
    or (a.status = 'confirmed'  and p_status in ('arrived', 'cancelled', 'no_show'))
    or (a.status = 'arrived'    and p_status in ('in_service', 'cancelled'))
    or (a.status = 'in_service' and p_status = 'done')) then
    raise exception 'an appointment cannot go from % to %', a.status, p_status using errcode = '55000';
  end if;
  update public.appointments set status = p_status where id = a.id;
  return p_status;
end $$;

-- p = { id, starts_at, provider_id?, place_id? } — a booked / confirmed appointment keeps its length; null provider / place keeps it as it was
create or replace function public.reschedule_appointment(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  a public.appointments%rowtype;
  v_start timestamptz := (p ->> 'starts_at')::timestamptz;
  v_end timestamptz;
  v_provider uuid;
  v_place uuid;
begin
  select * into a from public.appointments where id = (p ->> 'id')::uuid for update;
  if not found or not public.can_access_store(a.org_id, a.store_id) or not public.has_permission(a.org_id, 'order.create') then
    raise exception 'appointments need order.create in this shop' using errcode = '42501';
  end if;
  if a.status not in ('booked', 'confirmed') then raise exception 'only a booked or confirmed appointment can be moved' using errcode = '55000'; end if;
  if v_start is null then raise exception 'a start time is required' using errcode = '22023'; end if;
  v_end := v_start + (a.ends_at - a.starts_at);
  v_provider := case when p ? 'provider_id' then nullif(p ->> 'provider_id', '')::uuid else a.provider_id end;
  v_place := case when p ? 'place_id' then nullif(p ->> 'place_id', '')::uuid else a.place_id end;
  perform public.appointment_check_free(a.store_id, v_provider, v_place, v_start, v_end, a.id);
  update public.appointments set starts_at = v_start, ends_at = v_end, provider_id = v_provider, place_id = v_place where id = a.id;
end $$;

revoke all on function public.book_appointment(jsonb), public.set_appointment_status(uuid, text), public.reschedule_appointment(jsonb) from public, anon;
grant execute on function public.book_appointment(jsonb), public.set_appointment_status(uuid, text), public.reschedule_appointment(jsonb) to authenticated, service_role;
