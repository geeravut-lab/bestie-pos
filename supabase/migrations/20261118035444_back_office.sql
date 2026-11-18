-- Bestie POS · migration 11 · back office: shops, module guard, staff invites + PINs, devices.
--
--  * create_store(): an owner adds another shop to the chain (same org, same or chosen legal entity);
--  * module_overrides guard: only known module ids, boolean values, crypto top-up only with the org's legal sign-off;
--  * staff invites: owner/manager creates a one-time code (only its hash is stored, 7 days); the invitee signs in (any method)
--    and redeems it — a manager can never invite an owner;
--  * staff PINs: bcrypt hash, 5 wrong tries lock the PIN for 15 minutes (audited);
--  * devices: tablets with role (cashier / staff / KDS), station and the Revenue Department POS ID.
-- All new functions get explicit grants (migration 8: no defaults).

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ── add a shop ─────────────────────────────────────────────────────────────
create or replace function public.create_store(p_org uuid, p_name text, p_profile text, p_legal_entity uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_entity uuid;
  v_store  uuid;
begin
  if not public.has_permission(p_org, 'settings.manage') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if p_profile not in ('restaurant','cafe','salon','spa','resort','retail','tours') then
    raise exception 'unknown profile' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 120 then
    raise exception 'invalid name' using errcode = '22023';
  end if;
  select le.id into v_entity from public.legal_entities le
   where le.org_id = p_org and (p_legal_entity is null or le.id = p_legal_entity)
   order by le.created_at limit 1;
  if v_entity is null then
    raise exception 'legal entity not found' using errcode = '22023';
  end if;
  insert into public.stores (org_id, legal_entity_id, name, profile, service_charge_bps)
  values (p_org, v_entity, btrim(p_name), p_profile, case when p_profile in ('restaurant','resort') then 1000 else 0 end)
  returning id into v_store;
  return v_store;
end $$;
revoke all on function public.create_store(uuid, text, text, uuid) from public, anon;
grant execute on function public.create_store(uuid, text, text, uuid) to authenticated, service_role;

-- ── module overrides guard ─────────────────────────────────────────────────
create or replace function public.stores_check_modules() returns trigger
language plpgsql set search_path = '' as $$
declare
  k text;
  known text[] := array['tables.floorplan','bill.split','queue.call','kds','order.qr','kiosk','delivery','service.charge',
    'appointments','resources','deposits','commission','packages','slots.booking','folio','pms','stock','recipe.cost',
    'loyalty.network','tender.promptpay','tender.gateway','tender.credit','tender.points','credit.topup.crypto',
    'ai.assistant','line.notify'];
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
create trigger stores_modules_check before insert or update of module_overrides on public.stores
  for each row execute function public.stores_check_modules();

-- ── staff invites ──────────────────────────────────────────────────────────
create table public.staff_invites (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs (id) on delete cascade,
  store_id     uuid references public.stores (id) on delete cascade,   -- null = all stores
  role_id      uuid not null references public.roles (id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  code_hash    bytea not null unique,
  expires_at   timestamptz not null,
  created_by   uuid references auth.users (id) on delete set null,
  used_at      timestamptz,
  used_by      uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index staff_invites_org_idx on public.staff_invites (org_id);
alter table public.staff_invites enable row level security;
create policy staff_invites_read on public.staff_invites for select to authenticated using (public.has_permission(org_id, 'staff.manage'));
revoke all on public.staff_invites from anon, authenticated;
grant select on public.staff_invites to authenticated;

create or replace function public.create_staff_invite(p_org uuid, p_store uuid, p_role uuid, p_name text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_code text;
begin
  if not public.has_permission(p_org, 'staff.manage') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if not exists (select 1 from public.roles r where r.id = p_role and r.org_id = p_org) then
    raise exception 'role not found' using errcode = '22023';
  end if;
  if p_store is not null and not exists (select 1 from public.stores s where s.id = p_store and s.org_id = p_org) then
    raise exception 'store not found' using errcode = '22023';
  end if;
  -- a manager can never hand out the owner role (no self-promotion through a second account)
  if public.role_is_owner(p_role) and not public.is_org_owner(p_org) then
    raise exception 'only an owner can invite an owner' using errcode = '42501';
  end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into public.staff_invites (org_id, store_id, role_id, display_name, code_hash, expires_at, created_by)
  values (p_org, p_store, p_role, btrim(p_name), sha256(convert_to(v_code, 'utf8')), now() + interval '7 days', auth.uid());
  return v_code; -- shown ONCE; only the hash is stored
end $$;
revoke all on function public.create_staff_invite(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.create_staff_invite(uuid, uuid, uuid, text) to authenticated, service_role;

create or replace function public.accept_staff_invite(p_code text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.staff_invites%rowtype;
  v_id  uuid;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  select * into v_inv from public.staff_invites
   where code_hash = sha256(convert_to(upper(btrim(p_code)), 'utf8')) and used_at is null and expires_at > now()
   for update;
  if not found then
    raise exception 'invalid or expired invite' using errcode = 'P0002';
  end if;
  insert into public.staff (org_id, store_id, user_id, display_name, role_id)
  values (v_inv.org_id, v_inv.store_id, auth.uid(), v_inv.display_name, v_inv.role_id)
  returning id into v_id;
  update public.staff_invites set used_at = now(), used_by = auth.uid() where id = v_inv.id;
  return v_id;
end $$;
revoke all on function public.accept_staff_invite(text) from public, anon;
grant execute on function public.accept_staff_invite(text) to authenticated, service_role;

create or replace function public.revoke_staff_invite(p_invite uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.staff_invites where id = p_invite and used_at is null;
  if v_org is null then return false; end if;
  if not public.has_permission(v_org, 'staff.manage') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  delete from public.staff_invites where id = p_invite;
  return true;
end $$;
revoke all on function public.revoke_staff_invite(uuid) from public, anon;
grant execute on function public.revoke_staff_invite(uuid) to authenticated, service_role;

-- ── staff PINs ─────────────────────────────────────────────────────────────
create table public.staff_pins (
  staff_id        uuid primary key references public.staff (id) on delete cascade,
  pin_hash        text not null,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until    timestamptz,
  updated_at      timestamptz not null default now()
);
alter table public.staff_pins enable row level security;   -- no policy: only the functions below touch it
revoke all on public.staff_pins from anon, authenticated;

create or replace function public.set_staff_pin(p_staff uuid, p_pin text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_role uuid;
begin
  select s.org_id, s.role_id into v_org, v_role from public.staff s where s.id = p_staff;
  if v_org is null then raise exception 'staff not found' using errcode = 'P0002'; end if;
  if not public.has_permission(v_org, 'staff.manage') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if public.role_is_owner(v_role) and not public.is_org_owner(v_org) then
    raise exception 'only an owner can change an owner PIN' using errcode = '42501';
  end if;
  if p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'PIN must be 4 to 8 digits' using errcode = '22023';
  end if;
  insert into public.staff_pins (staff_id, pin_hash)
  values (p_staff, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)))
  on conflict (staff_id) do update
    set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, updated_at = now();
end $$;
revoke all on function public.set_staff_pin(uuid, text) from public, anon;
grant execute on function public.set_staff_pin(uuid, text) to authenticated, service_role;

-- A shop tablet asks "is this PIN right for this person?". Only members of the same org may ask; 5 wrong tries lock it 15 min.
create or replace function public.verify_staff_pin(p_staff uuid, p_pin text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_row public.staff_pins%rowtype;
  v_ok  boolean;
begin
  select s.org_id into v_org from public.staff s where s.id = p_staff and s.active;
  if v_org is null or not public.is_org_member(v_org) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  select * into v_row from public.staff_pins where staff_id = p_staff for update;
  if not found then return 'no_pin'; end if;
  if v_row.locked_until is not null and v_row.locked_until > now() then return 'locked'; end if;
  v_ok := v_row.pin_hash = extensions.crypt(p_pin, v_row.pin_hash);
  if v_ok then
    update public.staff_pins set failed_attempts = 0, locked_until = null where staff_id = p_staff;
    return 'ok';
  end if;
  update public.staff_pins
     set failed_attempts = failed_attempts + 1,
         locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else null end
   where staff_id = p_staff;
  if v_row.failed_attempts + 1 >= 5 then
    perform public.audit_record(v_org, null, 'auth.pin_lockout', 'staff', p_staff::text, '{}'::jsonb, 'app');
    return 'locked';
  end if;
  return 'wrong';
end $$;
revoke all on function public.verify_staff_pin(uuid, text) from public, anon;
grant execute on function public.verify_staff_pin(uuid, text) to authenticated, service_role;

-- ── devices ────────────────────────────────────────────────────────────────
create table public.devices (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs (id) on delete cascade,
  store_id         uuid not null references public.stores (id) on delete cascade,
  name             text not null check (length(btrim(name)) between 1 and 60),
  role             text not null check (role in ('cashier', 'staff', 'kds')),
  station          text check (station in ('kitchen', 'bar')),
  revenue_pos_id   text check (revenue_pos_id is null or revenue_pos_id ~ '^[A-Za-z0-9-]{1,40}$'),
  module_allow_list text[],
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index devices_store_idx on public.devices (store_id);
create trigger devices_touch before update on public.devices for each row execute function public.touch_updated_at();

create or replace function public.devices_check_store() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.stores s where s.id = new.store_id and s.org_id = new.org_id) then
    raise exception 'store does not belong to this org' using errcode = '23514';
  end if;
  if new.role <> 'kds' and new.station is not null then
    raise exception 'only a KDS has a station' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger devices_store_check before insert or update of store_id, org_id, role, station on public.devices
  for each row execute function public.devices_check_store();

create or replace function public.audit_trg_devices() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit_record(new.org_id, new.store_id, 'device.register', 'devices', new.id::text, jsonb_build_object('role', new.role), 'db');
  elsif new.revenue_pos_id is distinct from old.revenue_pos_id then
    perform public.audit_record(new.org_id, new.store_id, 'device.pos_id_change', 'devices', new.id::text, jsonb_build_object('changed', true), 'db');
  end if;
  return new;
end $$;
create trigger devices_audit after insert or update on public.devices for each row execute function public.audit_trg_devices();
create trigger devices_live after insert or update or delete on public.devices
  for each row execute function public.live_ping_row('store:{store_id}');

alter table public.devices enable row level security;
create policy devices_read on public.devices for select to authenticated using (public.can_access_store(org_id, store_id));
create policy devices_write on public.devices for all to authenticated
  using (public.has_permission(org_id, 'settings.manage')) with check (public.has_permission(org_id, 'settings.manage'));
revoke all on public.devices from anon, authenticated;
grant select, insert, update, delete on public.devices to authenticated;
