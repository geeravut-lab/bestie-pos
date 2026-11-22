-- Bestie POS · migration 91 · MOVE A MEMBER INTO AN EXISTING BUSINESS (owner order 22 Nov: the platform administrator does it from the web, not by SQL).
-- Why: a person who signs up and creates "a shop" always gets a NEW business, even with the same name (a name is not a key). The right way in is an invite
-- code, but when it went wrong the platform administrator had to fix it in the database. Rules: platform administrators only; the person must exist with a
-- confirmed e-mail; the target business, built-in role and shop must exist; leaving the other businesses means deactivating the person there, and when they
-- are the ONLY active owner of an EMPTY business (no bills, no customers, no receipts, nobody else) that accidental business is deleted; a business that is
-- not empty and has no other owner blocks the move (nobody is left without an owner). Every move and every deletion is logged in the platform log.

-- the platform log learns two more kinds and a short detail line
alter table public.platform_admin_log drop constraint if exists platform_admin_log_action_check;
alter table public.platform_admin_log add constraint platform_admin_log_action_check check (action in ('add', 'remove', 'member_move', 'org_delete'));
alter table public.platform_admin_log add column if not exists detail text check (detail is null or length(detail) <= 300);

-- the page of migration 90 now also returns the detail line
create or replace function public.platform_admins_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'platform administrators are for the platform administrator' using errcode = '42501'; end if;
  return jsonb_build_object(
    'admins', coalesce((select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'email', u.email, 'added_at', a.created_at,
                          'added_by_email', b.email, 'is_me', a.user_id = auth.uid()) order by a.created_at, u.email)
                          from public.platform_admins a join auth.users u on u.id = a.user_id left join auth.users b on b.id = a.added_by), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(jsonb_build_object('action', l.action, 'actor_email', l.actor_email, 'target_email', l.target_email, 'detail', l.detail, 'at', l.created_at) order by l.id desc)
                       from (select * from public.platform_admin_log order by id desc limit 50) l), '[]'::jsonb));
end $$;

-- "empty" = nothing was ever sold or collected: no bills, no receipts, no customers
create or replace function public.platform_org_is_empty(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.orders where org_id = p_org)
     and not exists (select 1 from public.receipts where org_id = p_org)
     and not exists (select 1 from public.customers where org_id = p_org)
$$;

-- the businesses for the target list: name, shops, active people, whether it is empty
create or replace function public.platform_orgs_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'platform administrators are for the platform administrator' using errcode = '42501'; end if;
  return jsonb_build_object('orgs', coalesce((select jsonb_agg(jsonb_build_object(
      'id', o.id, 'name', o.name, 'created_at', o.created_at,
      'staff_count', (select count(*) from public.staff s where s.org_id = o.id and s.active),
      'empty', public.platform_org_is_empty(o.id),
      'stores', coalesce((select jsonb_agg(jsonb_build_object('id', st.id, 'name', st.name) order by st.created_at) from public.stores st where st.org_id = o.id and st.deleted_at is null), '[]'::jsonb)
    ) order by o.created_at) from public.orgs o), '[]'::jsonb));
end $$;

-- p_email → the person and where they work now
create or replace function public.platform_member_lookup(p_email text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_uid uuid; v_mail text; v_confirmed boolean;
begin
  if not public.is_platform_admin() then raise exception 'platform administrators are for the platform administrator' using errcode = '42501'; end if;
  if length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'not an e-mail address' using errcode = '22023'; end if;
  select u.id, u.email, coalesce(to_jsonb(u) ->> 'email_confirmed_at', '') <> '' into v_uid, v_mail, v_confirmed from auth.users u where lower(u.email) = v_email limit 1;
  if v_uid is null then raise exception 'no account with this e-mail' using errcode = 'P0002'; end if;
  return jsonb_build_object('user_id', v_uid, 'email', v_mail, 'confirmed', v_confirmed,
    'memberships', coalesce((select jsonb_agg(jsonb_build_object('org_id', s.org_id, 'org_name', o.name, 'role', coalesce(r.built_in, r.name), 'store_id', s.store_id, 'store_name', st.name, 'active', s.active) order by o.created_at)
                               from public.staff s join public.orgs o on o.id = s.org_id join public.roles r on r.id = s.role_id left join public.stores st on st.id = s.store_id
                              where s.user_id = v_uid), '[]'::jsonb));
end $$;

-- p = { user_id, org_id, role: owner|manager|cashier|waiter|kitchen, store_id?: null = all shops, leave_others?: true }
create or replace function public.platform_move_member(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := nullif(p ->> 'user_id', '')::uuid;
  v_org uuid := nullif(p ->> 'org_id', '')::uuid;
  v_key text := p ->> 'role';
  v_store uuid := nullif(p ->> 'store_id', '')::uuid;
  v_leave boolean := coalesce((p ->> 'leave_others')::boolean, true);
  v_email text; v_confirmed boolean; v_org_name text; v_role uuid; v_store_name text; v_existing uuid; v_actor_email text;
  o record; v_deleted text[] := '{}'; v_left text[] := '{}'; v_sole_owner boolean;
begin
  if not public.is_platform_admin() then raise exception 'platform administrators are for the platform administrator' using errcode = '42501'; end if;
  if v_key is null or v_key not in ('owner', 'manager', 'cashier', 'waiter', 'kitchen') then raise exception 'unknown role' using errcode = '22023'; end if;
  select u.email, coalesce(to_jsonb(u) ->> 'email_confirmed_at', '') <> '' into v_email, v_confirmed from auth.users u where u.id = v_user;
  if v_email is null then raise exception 'no such account' using errcode = 'P0002'; end if;
  if not v_confirmed then raise exception 'the e-mail of this account is not confirmed' using errcode = '55000'; end if;
  select o2.name into v_org_name from public.orgs o2 where o2.id = v_org;
  if v_org_name is null then raise exception 'no such business' using errcode = 'P0002'; end if;
  select r.id into v_role from public.roles r where r.org_id = v_org and r.built_in = v_key;
  if v_role is null then raise exception 'the business has no such role' using errcode = 'P0002'; end if;
  if v_store is not null then
    select st.name into v_store_name from public.stores st where st.id = v_store and st.org_id = v_org and st.deleted_at is null;
    if v_store_name is null then raise exception 'no such shop in this business' using errcode = '22023'; end if;
  end if;

  -- the target: update the existing membership or add one (one membership per business)
  select s.id into v_existing from public.staff s where s.org_id = v_org and s.user_id = v_user order by s.created_at limit 1;
  if v_existing is not null then
    update public.staff set role_id = v_role, store_id = v_store, active = true where id = v_existing;
    delete from public.staff where org_id = v_org and user_id = v_user and id <> v_existing;
  else
    insert into public.staff (org_id, store_id, user_id, display_name, role_id, active)
    values (v_org, v_store, v_user, left(split_part(v_email, '@', 1), 80), v_role, true);
  end if;

  -- the other businesses of this person
  if v_leave then
    for o in select distinct s.org_id, og.name from public.staff s join public.orgs og on og.id = s.org_id where s.user_id = v_user and s.org_id <> v_org loop
      v_sole_owner := exists (select 1 from public.staff s join public.roles r on r.id = s.role_id where s.org_id = o.org_id and s.user_id = v_user and s.active and r.built_in = 'owner')
                  and not exists (select 1 from public.staff s join public.roles r on r.id = s.role_id where s.org_id = o.org_id and s.user_id <> v_user and s.active and r.built_in = 'owner');
      if v_sole_owner then
        if public.platform_org_is_empty(o.org_id) and not exists (select 1 from public.staff s where s.org_id = o.org_id and s.user_id <> v_user and s.active) then
          delete from public.orgs where id = o.org_id;          -- the accidental, empty business this person created for themselves
          v_deleted := v_deleted || o.name;
        else
          raise exception 'this person is the only owner of a business that is not empty' using errcode = '55000';
        end if;
      else
        update public.staff set active = false where org_id = o.org_id and user_id = v_user and active;
        v_left := v_left || o.name;
      end if;
    end loop;
  end if;

  select u.email into v_actor_email from auth.users u where u.id = auth.uid();
  insert into public.platform_admin_log (action, actor_id, actor_email, target_id, target_email, detail)
  values ('member_move', auth.uid(), v_actor_email, v_user, v_email, left(v_org_name || ' · ' || v_key || ' · ' || coalesce(v_store_name, 'all shops'), 300));
  if array_length(v_deleted, 1) is not null then
    insert into public.platform_admin_log (action, actor_id, actor_email, target_id, target_email, detail)
    values ('org_delete', auth.uid(), v_actor_email, v_user, v_email, left(array_to_string(v_deleted, ', '), 300));
  end if;
  return jsonb_build_object('org_id', v_org, 'deleted', to_jsonb(v_deleted), 'left', to_jsonb(v_left));
end $$;

revoke all on function public.platform_admins_list(), public.platform_org_is_empty(uuid), public.platform_orgs_overview(), public.platform_member_lookup(text), public.platform_move_member(jsonb) from public, anon, authenticated;
grant execute on function public.platform_admins_list(), public.platform_orgs_overview(), public.platform_member_lookup(text), public.platform_move_member(jsonb) to authenticated, service_role;
grant execute on function public.platform_org_is_empty(uuid) to service_role;
