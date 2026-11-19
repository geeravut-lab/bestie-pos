-- Bestie POS · migration 58 · days off / breaks for a stylist, room or bed, and group (couple / party) bookings.
--
-- DAY OFF: `resource_blocks` marks a time range in which one resource cannot be booked (a day off, a lunch break, a room being
-- cleaned). `appointment_check_free` — the one place that decides whether a time is free, used by the front desk, group booking and
-- the online booking page alike — now refuses a time that touches a block. A block cannot be made over an existing live booking
-- (move or cancel it first) and two blocks of one resource cannot overlap.
-- GROUP BOOKING: `book_group` books 2–8 parts (for example two therapists for a couple, or several stylists for a party) at once
-- in ONE transaction: if any part is taken, nothing is booked. The parts share a `group_id`.
-- Needs `menu.edit` for blocks (like the Resources screen) and `order.create` for groups (like any booking).

alter table public.appointments add column group_id uuid;
create index appointments_group_idx on public.appointments (group_id) where group_id is not null;

create table public.resource_blocks (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  resource_id uuid not null references public.resources (id),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  reason      text check (reason is null or length(reason) <= 100),
  created_by  uuid references public.staff (id) on delete set null,
  created_at  timestamptz not null default now(),
  check (ends_at > starts_at and ends_at - starts_at <= interval '62 days')
);
create index resource_blocks_resource_idx on public.resource_blocks (resource_id, starts_at);
create index resource_blocks_store_idx on public.resource_blocks (store_id, starts_at);
alter table public.resource_blocks enable row level security;
create policy resource_blocks_read on public.resource_blocks for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.resource_blocks from anon, authenticated;
grant select on public.resource_blocks to authenticated;   -- writes: the functions below
create trigger resource_blocks_live after insert or update or delete on public.resource_blocks for each row execute function public.live_ping_row('store:{store_id}');

-- ── the one place that decides whether a time is free: now also refuses a block ──
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
    if exists (select 1 from public.resource_blocks b where b.resource_id = p_provider and b.starts_at < p_end and b.ends_at > p_start) then
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
    if exists (select 1 from public.resource_blocks b where b.resource_id = p_place and b.starts_at < p_end and b.ends_at > p_start) then
      raise exception 'that room / bed is closed at that time' using errcode = '23P01';
    end if;
  end if;
end $$;
revoke all on function public.appointment_check_free(uuid, uuid, uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.appointment_check_free(uuid, uuid, uuid, timestamptz, timestamptz, uuid) to service_role;

-- ── blocks ──
-- p = { store_id, resource_id, starts_at, ends_at, reason? }
create or replace function public.save_resource_block(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_store uuid := (p ->> 'store_id')::uuid;
  s public.stores%rowtype;
  r public.resources%rowtype;
  v_from timestamptz := (p ->> 'starts_at')::timestamptz;
  v_to timestamptz := (p ->> 'ends_at')::timestamptz;
  v_id uuid;
  v_staff uuid;
begin
  select * into s from public.stores where id = v_store and deleted_at is null;
  if not found or not public.can_edit_menu(v_store) then
    raise exception 'days off need menu.edit in this shop' using errcode = '42501';
  end if;
  if not public.appointments_enabled(v_store) then raise exception 'the appointments module is off in this shop' using errcode = '0A000'; end if;
  if v_from is null or v_to is null or v_to <= v_from or v_to - v_from > interval '62 days' then
    raise exception 'the time range is not valid' using errcode = '22023';
  end if;
  select * into r from public.resources where id = (p ->> 'resource_id')::uuid and store_id = v_store and deleted_at is null;
  if not found then raise exception 'unknown person or room' using errcode = '22023'; end if;
  perform 1 from public.resources where id = r.id for update;
  if exists (select 1 from public.appointments a
              where (a.provider_id = r.id or a.place_id = r.id) and a.status in ('booked', 'confirmed', 'arrived', 'in_service')
                and a.starts_at < v_to and a.ends_at > v_from) then
    raise exception 'there are bookings in that time: move or cancel them first' using errcode = '23P01';
  end if;
  if exists (select 1 from public.resource_blocks b where b.resource_id = r.id and b.starts_at < v_to and b.ends_at > v_from) then
    raise exception 'already marked off in that time' using errcode = '23P01';
  end if;
  select x.id into v_staff from public.staff x where x.org_id = s.org_id and x.user_id = auth.uid() and x.active limit 1;
  insert into public.resource_blocks (org_id, store_id, resource_id, starts_at, ends_at, reason, created_by)
  values (s.org_id, v_store, r.id, v_from, v_to, left(nullif(btrim(coalesce(p ->> 'reason', '')), ''), 100), v_staff)
  returning id into v_id;
  perform public.audit_record(s.org_id, v_store, 'settings.change', 'resource_blocks', v_id::text,
    jsonb_build_object('resource', r.id, 'from', v_from, 'to', v_to), 'db');
  return v_id;
end $$;

create or replace function public.delete_resource_block(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.resource_blocks%rowtype;
begin
  select * into b from public.resource_blocks where id = p_id;
  if not found then return; end if;
  if not public.can_edit_menu(b.store_id) then
    raise exception 'days off need menu.edit in this shop' using errcode = '42501';
  end if;
  delete from public.resource_blocks where id = p_id;
  perform public.audit_record(b.org_id, b.store_id, 'settings.change', 'resource_blocks', p_id::text, jsonb_build_object('removed', true), 'db');
end $$;
revoke all on function public.save_resource_block(jsonb), public.delete_resource_block(uuid) from public, anon;
grant execute on function public.save_resource_block(jsonb), public.delete_resource_block(uuid) to authenticated, service_role;

-- ── group booking ──
-- p = { store_id, starts_at, guest_name, guest_phone?, customer_id?, note?,
--       parts: [{ provider_id?, place_id?, service_id? | service_name?, price?, duration_min?, guest_name?, starts_at? }] }
-- Every part is booked by book_appointment (same checks, same snapshots); one clash undoes the whole group.
create or replace function public.book_group(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_parts jsonb := p -> 'parts';
  v_gid uuid := gen_random_uuid();
  v_ids uuid[] := '{}';
  v_id uuid;
  e jsonb;
  v_common jsonb;
  v_n integer := 0;
begin
  if jsonb_typeof(v_parts) <> 'array' or jsonb_array_length(v_parts) not between 2 and 8 then
    raise exception 'a group has 2 to 8 parts' using errcode = '22023';
  end if;
  v_common := jsonb_strip_nulls(jsonb_build_object(
    'store_id', p -> 'store_id', 'starts_at', p -> 'starts_at', 'guest_name', p -> 'guest_name',
    'guest_phone', p -> 'guest_phone', 'customer_id', p -> 'customer_id', 'note', p -> 'note'));
  for e in select * from jsonb_array_elements(v_parts) loop
    v_n := v_n + 1;
    v_id := public.book_appointment(v_common || jsonb_strip_nulls(e));
    update public.appointments set group_id = v_gid where id = v_id;
    v_ids := v_ids || v_id;
  end loop;
  return jsonb_build_object('group_id', v_gid, 'ids', to_jsonb(v_ids));
end $$;
revoke all on function public.book_group(jsonb) from public, anon;
grant execute on function public.book_group(jsonb) to authenticated, service_role;
