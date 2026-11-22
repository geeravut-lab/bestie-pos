-- Bestie POS · migration 93 · DELETE A USER ACCOUNT (platform administrator only, owner order 22 Nov).
-- Rules: platform administrators only; never yourself; never another platform administrator (remove the right first); never a person who is the ONLY owner
-- of a business that holds data (bills, receipts or customers) — someone must be made owner first; the only owner of an EMPTY business with nobody else in it
-- takes that accidental business with them. The account (auth.users) goes, and with it the person's membership rows, profile, notices and links (foreign keys
-- cascade); bills, receipts and the audit trail of the shops stay (they belong to the shop). Every deletion is logged in the platform log (e-mail kept in the line).

alter table public.platform_admin_log drop constraint if exists platform_admin_log_action_check;
alter table public.platform_admin_log add constraint platform_admin_log_action_check check (action in ('add', 'remove', 'member_move', 'org_delete', 'user_delete'));

-- the insert-only prompt history may only let go of the author when the account is deleted (foreign key "on delete set null"); nothing else may change
create or replace function public.ai_prompt_versions_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.created_by is not null and new.created_by is null
     and to_jsonb(new) - 'created_by' = to_jsonb(old) - 'created_by' then
    return new;
  end if;
  raise exception 'ai_prompt_versions is insert-only' using errcode = '42501';
end $$;

-- the lookup now also says whether the person is a platform administrator / is you, for the page's warnings
create or replace function public.platform_member_lookup(p_email text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_uid uuid; v_mail text; v_confirmed boolean;
begin
  if not public.is_platform_admin() then raise exception 'platform administrators are for the platform administrator' using errcode = '42501'; end if;
  if length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'not an e-mail address' using errcode = '22023'; end if;
  select u.id, u.email, coalesce(to_jsonb(u) ->> 'email_confirmed_at', '') <> '' into v_uid, v_mail, v_confirmed from auth.users u where lower(u.email) = v_email limit 1;
  if v_uid is null then raise exception 'no account with this e-mail' using errcode = 'P0002'; end if;
  return jsonb_build_object('user_id', v_uid, 'email', v_mail, 'confirmed', v_confirmed,
    'is_admin', exists (select 1 from public.platform_admins a where a.user_id = v_uid), 'is_me', v_uid = auth.uid(),
    'memberships', coalesce((select jsonb_agg(jsonb_build_object('org_id', s.org_id, 'org_name', o.name, 'role', coalesce(r.built_in, r.name), 'store_id', s.store_id, 'store_name', st.name, 'active', s.active,
                                                                  'sole_owner', s.active and r.built_in = 'owner' and not exists (select 1 from public.staff s2 join public.roles r2 on r2.id = s2.role_id where s2.org_id = s.org_id and s2.user_id <> v_uid and s2.active and r2.built_in = 'owner'),
                                                                  'empty', public.platform_org_is_empty(s.org_id)) order by o.created_at)
                               from public.staff s join public.orgs o on o.id = s.org_id join public.roles r on r.id = s.role_id left join public.stores st on st.id = s.store_id
                              where s.user_id = v_uid), '[]'::jsonb));
end $$;

create or replace function public.platform_user_delete(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_email text; v_actor_email text; o record; v_deleted text[] := '{}'; v_memberships int;
begin
  if not public.is_platform_admin() then raise exception 'platform administrators are for the platform administrator' using errcode = '42501'; end if;
  select u.email into v_email from auth.users u where u.id = p_user;
  if v_email is null then raise exception 'no such account' using errcode = 'P0002'; end if;
  if p_user = auth.uid() then raise exception 'you cannot delete your own account' using errcode = '55000'; end if;
  if exists (select 1 from public.platform_admins a where a.user_id = p_user) then
    raise exception 'this person is a platform administrator: remove that right first' using errcode = '23503';
  end if;

  -- every business where this person is the only active owner
  for o in
    select s.org_id, og.name from public.staff s join public.orgs og on og.id = s.org_id join public.roles r on r.id = s.role_id
     where s.user_id = p_user and s.active and r.built_in = 'owner'
       and not exists (select 1 from public.staff s2 join public.roles r2 on r2.id = s2.role_id where s2.org_id = s.org_id and s2.user_id <> p_user and s2.active and r2.built_in = 'owner')
  loop
    if public.platform_org_is_empty(o.org_id) and not exists (select 1 from public.staff s3 where s3.org_id = o.org_id and s3.user_id <> p_user and s3.active) then
      continue;   -- an accidental empty business with nobody else: it goes with its only member (below)
    end if;
    raise exception 'this person is the only owner of a business that is not empty' using errcode = '55006';
  end loop;

  select count(distinct s.org_id) into v_memberships from public.staff s where s.user_id = p_user;
  for o in
    select s.org_id, og.name from public.staff s join public.orgs og on og.id = s.org_id join public.roles r on r.id = s.role_id
     where s.user_id = p_user and s.active and r.built_in = 'owner'
       and not exists (select 1 from public.staff s2 join public.roles r2 on r2.id = s2.role_id where s2.org_id = s.org_id and s2.user_id <> p_user and s2.active and r2.built_in = 'owner')
  loop
    delete from public.orgs where id = o.org_id;
    v_deleted := v_deleted || o.name;
  end loop;

  select u.email into v_actor_email from auth.users u where u.id = auth.uid();
  delete from auth.users where id = p_user;       -- memberships, profile, notices, links go with it (foreign keys)
  insert into public.platform_admin_log (action, actor_id, actor_email, target_id, target_email, detail)
  values ('user_delete', auth.uid(), v_actor_email, p_user, v_email,
          left(v_memberships || ' membership(s)' || case when array_length(v_deleted, 1) is null then '' else ' · empty business deleted: ' || array_to_string(v_deleted, ', ') end, 300));
  return jsonb_build_object('deleted_orgs', to_jsonb(v_deleted), 'memberships', v_memberships);
end $$;

revoke all on function public.platform_member_lookup(text), public.platform_user_delete(uuid) from public, anon, authenticated;
grant execute on function public.platform_member_lookup(text), public.platform_user_delete(uuid) to authenticated, service_role;
