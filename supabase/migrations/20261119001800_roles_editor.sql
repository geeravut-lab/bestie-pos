-- Bestie POS · migration 43 · role editor: a new permission `drawer.open`, and a guard so roles can be edited safely by the owner / managers.
--
--  * `drawer.open` (open the cash drawer without a sale) is now its own permission; the built-in Manager and Cashier roles get it (and every
--    new organisation's too), the Owner has everything. `record_drawer_open` checks it instead of `payment.take`.
--  * Custom roles are written through the table (RLS: `staff.manage`, never the built-in ones). A new guard trigger makes that safe:
--    only KNOWN permissions, and nobody can hand out a permission they do not hold themselves (the owner may give any) — so a manager
--    cannot make a role more powerful than themselves. Every change of a custom role is a critical audit event `staff.role_change`.

-- registry:permissions  (mirror of PERMISSIONS in packages/core/src/types.ts, checked by a test)
create or replace function public.known_permissions() returns text[]
language sql immutable set search_path = '' as $$
  select array['order.create','order.void','order.discount','price.override','refund.create','payment.take','drawer.open',
               'shift.open_close','menu.edit','staff.manage','module.toggle','report.view','customer.view','credit.adjust',
               'audit.view','settings.manage','kds.use']::text[]
$$;
grant execute on function public.known_permissions() to authenticated, service_role;

update public.roles set permissions = array_append(permissions, 'drawer.open')
 where built_in in ('manager', 'cashier') and not ('drawer.open' = any (permissions));

create or replace function public.roles_defaults() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.built_in in ('manager', 'cashier') and not ('drawer.open' = any (new.permissions)) then
    new.permissions := array_append(new.permissions, 'drawer.open');
  end if;
  return new;
end $$;
create trigger roles_defaults_trg before insert on public.roles for each row execute function public.roles_defaults();

create or replace function public.roles_permission_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  p text;
begin
  if new.built_in is not null or auth.uid() is null then return new; end if;     -- built-in roles belong to the platform; the server is trusted
  if not (new.permissions <@ public.known_permissions()) then
    raise exception 'unknown permission' using errcode = '22023';
  end if;
  if not public.is_org_owner(new.org_id) then
    foreach p in array new.permissions loop
      if (tg_op = 'INSERT' or not (p = any (old.permissions))) and not public.has_permission(new.org_id, p) then
        raise exception 'you cannot give a permission you do not have' using errcode = '42501';
      end if;
    end loop;
  end if;
  return new;
end $$;
create trigger roles_permission_guard_trg before insert or update of permissions on public.roles for each row execute function public.roles_permission_guard();

create or replace function public.roles_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.roles%rowtype := case when tg_op = 'DELETE' then old else new end;
begin
  if r.built_in is null then
    perform public.audit_record(r.org_id, null, 'staff.role_change', 'roles', r.id::text,
      jsonb_build_object('op', tg_op, 'name', r.name, 'permissions', to_jsonb(r.permissions)), 'db');
  end if;
  return null;
end $$;
create trigger roles_audit_trg after insert or update or delete on public.roles for each row execute function public.roles_audit();

-- opening the drawer needs its own permission now
create or replace function public.record_drawer_open(p_device uuid, p_times timestamptz[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  d public.devices%rowtype;
  t timestamptz;
  n integer := 0;
begin
  select * into d from public.devices where id = p_device and active;
  if not found or not (public.can_access_store(d.org_id, d.store_id) and public.has_permission(d.org_id, 'drawer.open')) then
    raise exception 'opening the drawer needs the drawer.open permission in this shop' using errcode = '42501';
  end if;
  foreach t in array coalesce(p_times, '{}') loop
    exit when n >= 20;
    if t > now() + interval '5 minutes' or t < now() - interval '2 days' then continue; end if;
    perform public.audit_record(d.org_id, d.store_id, 'drawer.open', 'devices', d.id::text,
      jsonb_build_object('device', d.name, 'at', t), 'db');
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.record_drawer_open(uuid, timestamptz[]) from public, anon;
grant execute on function public.record_drawer_open(uuid, timestamptz[]) to authenticated, service_role;
