-- Bestie POS · migration 1 · tenancy, roles, profiles, platform settings, RLS.
--
-- Rules (supabase/README.md):
--  * every tenant table has org_id (and store_id where it belongs to one store) and RLS ENABLED;
--  * ids are uuids the client may generate (offline-first), timestamps are timestamptz;
--  * a role NEVER comes from login/SSO — it lives in public.staff / public.roles only;
--  * service_role bypasses RLS: only server functions use it (never the browser).

-- ── helpers ────────────────────────────────────────────────────────────────
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── profiles (one row per auth user; NO role here) ─────────────────────────
create table public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url   text,
  language     text not null default 'th' check (language in ('th', 'en')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Every new auth user (email, Google, Aivora/LINE SSO) gets a profile. Fill only what the provider gave us.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  )
  on conflict (user_id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── tenancy ────────────────────────────────────────────────────────────────
create table public.orgs (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(btrim(name)) between 1 and 120),
  -- lawyer / regulator gates (CLAUDE.md rule 3). Only service_role may change it (see trigger below).
  legal_sign_off jsonb not null default '{"cryptoTopup": false}'::jsonb,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger orgs_touch before update on public.orgs
  for each row execute function public.touch_updated_at();

create table public.legal_entities (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 120),
  tax_id     text check (tax_id is null or tax_id ~ '^[0-9]{13}$'),
  created_at timestamptz not null default now()
);
create index legal_entities_org_idx on public.legal_entities (org_id);

create table public.stores (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.orgs (id) on delete cascade,
  legal_entity_id    uuid not null references public.legal_entities (id),
  name               text not null check (length(btrim(name)) between 1 and 120),
  profile            text not null check (profile in ('restaurant','cafe','salon','spa','resort','retail','tours')),
  plan               text not null default 'pro' check (plan in ('basic','pro','resort')),
  -- only what differs from the profile default (feature-flag rule): {"kds": false, "queue.call": true}
  module_overrides   jsonb not null default '{}'::jsonb check (jsonb_typeof(module_overrides) = 'object'),
  vat_registered     boolean not null default false,
  vat_bps            integer not null default 0 check (vat_bps between 0 and 10000),
  branch_code        text not null default '00000' check (branch_code ~ '^[0-9]{5}$'),
  service_charge_bps integer not null default 0 check (service_charge_bps between 0 and 10000),
  price_mode         text not null default 'inclusive' check (price_mode in ('inclusive','exclusive')),
  rounding           jsonb not null default '{}'::jsonb check (jsonb_typeof(rounding) = 'object'),
  default_lang       text not null default 'th' check (default_lang in ('th','en')),
  timezone           text not null default 'Asia/Bangkok',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create index stores_org_idx on public.stores (org_id);
create trigger stores_touch before update on public.stores
  for each row execute function public.touch_updated_at();

-- A store's legal entity must belong to the same org (Credit is scoped by legal entity — rule 2).
create or replace function public.stores_check_entity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.legal_entities le where le.id = new.legal_entity_id and le.org_id = new.org_id) then
    raise exception 'legal entity does not belong to this org' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger stores_entity_check before insert or update of legal_entity_id, org_id on public.stores
  for each row execute function public.stores_check_entity();

create table public.roles (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs (id) on delete cascade,
  name           text not null check (length(btrim(name)) between 1 and 60),
  built_in       text check (built_in in ('owner','manager','cashier','waiter','kitchen')),
  permissions    text[] not null default '{}',
  hidden_modules text[] not null default '{}',
  created_at     timestamptz not null default now(),
  unique (org_id, built_in)
);
create index roles_org_idx on public.roles (org_id);

create table public.staff (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs (id) on delete cascade,
  store_id     uuid references public.stores (id) on delete cascade, -- null = all stores of the org
  user_id      uuid references auth.users (id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  role_id      uuid not null references public.roles (id),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index staff_org_idx on public.staff (org_id);
create index staff_user_idx on public.staff (user_id) where user_id is not null;
create unique index staff_user_scope_uidx on public.staff (org_id, user_id, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where user_id is not null;
create trigger staff_touch before update on public.staff
  for each row execute function public.touch_updated_at();

-- ── platform-level (admin app) ─────────────────────────────────────────────
-- Rows only via service_role / SQL function — no RLS policy lets a client write here.
create table public.platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Single row. brand = admin-chosen names/logo refs, feature_flags = ONLY the switches that are off.
create table public.platform_settings (
  id            boolean primary key default true check (id),
  brand         jsonb not null default '{}'::jsonb check (jsonb_typeof(brand) = 'object'),
  feature_flags jsonb not null default '{}'::jsonb check (jsonb_typeof(feature_flags) = 'object'),
  updated_by    uuid references auth.users (id) on delete set null,
  updated_at    timestamptz not null default now()
);
insert into public.platform_settings (id) values (true) on conflict do nothing;
create trigger platform_settings_touch before update on public.platform_settings
  for each row execute function public.touch_updated_at();

-- ── RLS helper functions (security definer: they read tables the caller may not) ─
create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins a where a.user_id = auth.uid());
$$;

create or replace function public.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    where s.org_id = p_org and s.user_id = auth.uid() and s.active
  );
$$;

-- Can the caller work in this store? (staff with store_id null work in every store of the org)
create or replace function public.can_access_store(p_org uuid, p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    where s.org_id = p_org and s.user_id = auth.uid() and s.active
      and (s.store_id is null or s.store_id = p_store)
  );
$$;

create or replace function public.is_org_owner(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s join public.roles r on r.id = s.role_id
    where s.org_id = p_org and s.user_id = auth.uid() and s.active and r.built_in = 'owner'
  );
$$;

create or replace function public.role_is_owner(p_role uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select r.built_in = 'owner' from public.roles r where r.id = p_role), false);
$$;

-- Owner role holds everything; others hold what their role lists.
create or replace function public.has_permission(p_org uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    join public.roles r on r.id = s.role_id
    where s.org_id = p_org and s.user_id = auth.uid() and s.active
      and (r.built_in = 'owner' or p_perm = any (r.permissions))
  );
$$;

revoke all on function public.is_platform_admin(), public.is_org_member(uuid), public.is_org_owner(uuid),
  public.role_is_owner(uuid), public.can_access_store(uuid, uuid), public.has_permission(uuid, text) from public;
grant execute on function public.is_platform_admin(), public.is_org_member(uuid), public.is_org_owner(uuid),
  public.role_is_owner(uuid), public.can_access_store(uuid, uuid), public.has_permission(uuid, text) to authenticated, service_role;

-- ── guards ─────────────────────────────────────────────────────────────────
-- legal_sign_off decides whether crypto top-up may ever be enabled: only the server (service_role) may change it.
create or replace function public.orgs_protect_legal() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.legal_sign_off is distinct from old.legal_sign_off
     and coalesce(auth.role(), current_setting('role', true)) is distinct from 'service_role'
     and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception 'legal_sign_off can only be changed by the platform' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger orgs_legal_guard before update on public.orgs
  for each row execute function public.orgs_protect_legal();

-- The last owner of an org cannot be removed / deactivated / downgraded.
create or replace function public.staff_keep_an_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  was_owner boolean;
  remaining integer;
begin
  select (r.built_in = 'owner') into was_owner from public.roles r where r.id = old.role_id;
  if not coalesce(was_owner, false) or not old.active then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.active and new.role_id = old.role_id then
    return new;
  end if;
  select count(*) into remaining
  from public.staff s join public.roles r on r.id = s.role_id
  where s.org_id = old.org_id and s.active and r.built_in = 'owner' and s.id <> old.id;
  if remaining = 0 then
    raise exception 'an org must keep at least one owner' using errcode = '23514';
  end if;
  return coalesce(new, old);
end $$;
create trigger staff_owner_guard before update or delete on public.staff
  for each row execute function public.staff_keep_an_owner();

-- ── onboarding RPC: org + legal entity + store + built-in roles + owner, atomically ─
create or replace function public.create_org(p_org_name text, p_store_name text, p_profile text)
returns table (org_id uuid, store_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_user  uuid := auth.uid();
  v_org   uuid;
  v_entity uuid;
  v_store uuid;
  v_owner uuid;
  v_all   text[] := array['order.create','order.void','order.discount','price.override','refund.create','payment.take',
    'shift.open_close','menu.edit','staff.manage','module.toggle','report.view','customer.view','credit.adjust','audit.view','settings.manage'];
  v_name  text;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if p_profile not in ('restaurant','cafe','salon','spa','resort','retail','tours') then
    raise exception 'unknown profile' using errcode = '22023';
  end if;
  v_name := coalesce(nullif(btrim(p_store_name), ''), btrim(p_org_name));

  insert into public.orgs (name, created_by) values (btrim(p_org_name), v_user) returning id into v_org;
  insert into public.legal_entities (org_id, name) values (v_org, btrim(p_org_name)) returning id into v_entity;
  insert into public.stores (org_id, legal_entity_id, name, profile,
                             service_charge_bps)
  values (v_org, v_entity, v_name, p_profile, case when p_profile in ('restaurant','resort') then 1000 else 0 end)
  returning id into v_store;

  insert into public.roles (org_id, name, built_in, permissions) values
    (v_org, 'Owner', 'owner', v_all),
    (v_org, 'Manager', 'manager', array['order.create','order.void','order.discount','refund.create','payment.take',
       'shift.open_close','menu.edit','staff.manage','report.view','customer.view','audit.view']),
    (v_org, 'Cashier', 'cashier', array['order.create','payment.take','shift.open_close','customer.view']),
    (v_org, 'Waiter', 'waiter', array['order.create','customer.view']),
    (v_org, 'Kitchen', 'kitchen', array[]::text[]);
  select r.id into v_owner from public.roles r where r.org_id = v_org and r.built_in = 'owner';

  insert into public.staff (org_id, store_id, user_id, display_name, role_id)
  values (v_org, null, v_user,
          coalesce((select display_name from public.profiles where user_id = v_user), 'Owner'), v_owner);

  return query select v_org, v_store;
end $$;
revoke all on function public.create_org(text, text, text) from public;
grant execute on function public.create_org(text, text, text) to authenticated;

-- ── Row Level Security ─────────────────────────────────────────────────────
alter table public.profiles          enable row level security;
alter table public.orgs              enable row level security;
alter table public.legal_entities    enable row level security;
alter table public.stores            enable row level security;
alter table public.roles             enable row level security;
alter table public.staff             enable row level security;
alter table public.platform_admins   enable row level security;
alter table public.platform_settings enable row level security;

create policy profiles_select_own on public.profiles for select to authenticated using (user_id = auth.uid());
create policy profiles_update_own on public.profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy orgs_select_member on public.orgs for select to authenticated using (public.is_org_member(id));
create policy orgs_update_settings on public.orgs for update to authenticated
  using (public.has_permission(id, 'settings.manage')) with check (public.has_permission(id, 'settings.manage'));

create policy entities_select_member on public.legal_entities for select to authenticated using (public.is_org_member(org_id));
create policy entities_write on public.legal_entities for all to authenticated
  using (public.has_permission(org_id, 'settings.manage')) with check (public.has_permission(org_id, 'settings.manage'));

create policy stores_select_member on public.stores for select to authenticated using (public.can_access_store(org_id, id));
create policy stores_write on public.stores for all to authenticated
  using (public.has_permission(org_id, 'settings.manage')) with check (public.has_permission(org_id, 'settings.manage'));

create policy roles_select_member on public.roles for select to authenticated using (public.is_org_member(org_id));
create policy roles_write on public.roles for all to authenticated
  using (public.has_permission(org_id, 'staff.manage') and built_in is null)
  with check (public.has_permission(org_id, 'staff.manage') and built_in is null); -- built-in roles are managed by the platform

create policy staff_select_member on public.staff for select to authenticated using (public.is_org_member(org_id));
-- A manager can manage staff but can neither touch an owner nor hand out the owner role (no self-promotion).
create policy staff_write on public.staff for all to authenticated
  using (public.has_permission(org_id, 'staff.manage') and (not public.role_is_owner(role_id) or public.is_org_owner(org_id)))
  with check (public.has_permission(org_id, 'staff.manage') and (not public.role_is_owner(role_id) or public.is_org_owner(org_id)));

-- platform_admins: deliberately NO policy → invisible and unwritable for clients (service_role only).

-- Brand must be readable on the login page (logo + name before sign-in).
create policy platform_settings_read on public.platform_settings for select to anon, authenticated using (true);
create policy platform_settings_admin_update on public.platform_settings for update to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Least privilege on the tables themselves (RLS is the second lock). Future tables must not leak to anon either.
alter default privileges in schema public revoke all on tables from anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;
grant select on public.platform_settings to anon;
grant select, insert, update, delete on public.legal_entities, public.stores, public.roles, public.staff to authenticated;
grant select, update on public.orgs, public.profiles to authenticated;
grant select, update on public.platform_settings to authenticated;
