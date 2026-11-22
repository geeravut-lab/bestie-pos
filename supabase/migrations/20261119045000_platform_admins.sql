-- Bestie POS · migration 90 · PLATFORM ADMINISTRATORS (owner order 22 Nov: add / remove platform administrators from the app, not only by SQL).
-- Rules decided with the owner: the platform administrator adds an EXISTING account by e-mail (no account is created here, and the e-mail must be confirmed so
-- nobody can claim an address they do not own); nobody removes themselves and the last administrator can never be removed; every add / remove is written to
-- an append-only platform log and tells the other administrators at once (app + LINE, urgent). `platform_admins` itself stays unreadable and unwritable for the browser.

-- who added each administrator (null for the first ones, added by hand)
alter table public.platform_admins add column if not exists added_by uuid references auth.users (id) on delete set null;

-- the platform's own audit log (audit_log is per business, this one has no business). Append-only; read only through platform_admins_list().
create table public.platform_admin_log (
  id           bigint generated always as identity primary key,
  action       text not null check (action in ('add', 'remove')),
  actor_id     uuid,                                   -- no foreign key: the log is append-only and must survive a deleted account (the e-mail is kept in the line)
  actor_email  text,
  target_id    uuid,
  target_email text,
  created_at   timestamptz not null default now()
);
create index platform_admin_log_time_idx on public.platform_admin_log (created_at desc);
alter table public.platform_admin_log enable row level security;
revoke all on public.platform_admin_log from anon, authenticated;
create or replace function public.platform_admin_log_block() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'platform_admin_log is append-only' using errcode = '42501';
end $$;
create trigger platform_admin_log_no_change before update or delete on public.platform_admin_log
  for each row execute function public.platform_admin_log_block();

-- the page: administrators (with who added them) and the last 50 log lines
create or replace function public.platform_admins_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'platform administrators are for the platform administrator' using errcode = '42501'; end if;
  return jsonb_build_object(
    'admins', coalesce((select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'email', u.email, 'added_at', a.created_at,
                          'added_by_email', b.email, 'is_me', a.user_id = auth.uid()) order by a.created_at, u.email)
                          from public.platform_admins a join auth.users u on u.id = a.user_id left join auth.users b on b.id = a.added_by), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(jsonb_build_object('action', l.action, 'actor_email', l.actor_email, 'target_email', l.target_email, 'at', l.created_at) order by l.id desc)
                       from (select * from public.platform_admin_log order by id desc limit 50) l), '[]'::jsonb));
end $$;

-- every administrator except the one who did it and the one it is about is told at once (app inbox + LINE when linked); the text carries no address
create or replace function public.platform_admin_tell_others(p_kind text, p_actor uuid, p_target uuid, p_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select a.user_id from public.platform_admins a where a.user_id is distinct from p_actor and a.user_id is distinct from p_target loop
    perform public.notify_user(jsonb_build_object('user_id', r.user_id, 'kind', p_kind, 'urgent', true, 'href', '/admin/platform-admins', 'dedupe', p_key || ':' || r.user_id,
      'title', case when p_kind = 'platform.admin_added' then jsonb_build_object('th', 'มีผู้ดูแลแพลตฟอร์มคนใหม่', 'en', 'A platform administrator was added')
                    else jsonb_build_object('th', 'มีผู้ดูแลแพลตฟอร์มถูกถอดสิทธิ์', 'en', 'A platform administrator was removed') end,
      'body', jsonb_build_object('th', 'เปิดหน้าผู้ดูแลแพลตฟอร์มเพื่อดูว่าใครทำและเมื่อไร ถ้าไม่ใช่คุณหรือทีมที่รู้เรื่อง ให้ตรวจสอบทันที', 'en', 'Open the platform administrators page to see who did it and when. If this was not you or your team, check it now.')));
  end loop;
end $$;

-- p_email → the platform administrator makes an EXISTING account with a confirmed e-mail a platform administrator
create or replace function public.platform_admin_add(p_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_uid uuid; v_confirmed boolean; v_actor_email text;
begin
  if not public.is_platform_admin() then raise exception 'platform administrators are for the platform administrator' using errcode = '42501'; end if;
  if length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'not an e-mail address' using errcode = '22023'; end if;
  perform 1 from public.platform_admins for update;                                  -- one add / remove at a time
  select u.id, coalesce(to_jsonb(u) ->> 'email_confirmed_at', '') <> '' into v_uid, v_confirmed from auth.users u where lower(u.email) = v_email limit 1;
  if v_uid is null then raise exception 'no account with this e-mail' using errcode = 'P0002'; end if;
  if not v_confirmed then raise exception 'the e-mail of this account is not confirmed' using errcode = '55000'; end if;
  if exists (select 1 from public.platform_admins where user_id = v_uid) then raise exception 'already a platform administrator' using errcode = '23505'; end if;
  insert into public.platform_admins (user_id, added_by) values (v_uid, auth.uid());
  select u.email into v_actor_email from auth.users u where u.id = auth.uid();
  insert into public.platform_admin_log (action, actor_id, actor_email, target_id, target_email) values ('add', auth.uid(), v_actor_email, v_uid, v_email);
  perform public.platform_admin_tell_others('platform.admin_added', auth.uid(), v_uid, 'padd:' || v_uid || ':' || extract(epoch from clock_timestamp())::bigint);
  return jsonb_build_object('user_id', v_uid, 'email', v_email);
end $$;

-- p_user → removed. Never yourself, never the last administrator.
create or replace function public.platform_admin_remove(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_email text; v_actor_email text;
begin
  if not public.is_platform_admin() then raise exception 'platform administrators are for the platform administrator' using errcode = '42501'; end if;
  perform 1 from public.platform_admins for update;
  if p_user is null or not exists (select 1 from public.platform_admins where user_id = p_user) then raise exception 'not a platform administrator' using errcode = 'P0002'; end if;
  if p_user = auth.uid() then raise exception 'you cannot remove yourself' using errcode = '55000'; end if;
  if (select count(*) from public.platform_admins) <= 1 then raise exception 'the last platform administrator cannot be removed' using errcode = '55000'; end if;
  select u.email into v_email from auth.users u where u.id = p_user;
  select u.email into v_actor_email from auth.users u where u.id = auth.uid();
  delete from public.platform_admins where user_id = p_user;
  insert into public.platform_admin_log (action, actor_id, actor_email, target_id, target_email) values ('remove', auth.uid(), v_actor_email, p_user, v_email);
  perform public.platform_admin_tell_others('platform.admin_removed', auth.uid(), p_user, 'prem:' || p_user || ':' || extract(epoch from clock_timestamp())::bigint);
  return jsonb_build_object('user_id', p_user);
end $$;

revoke all on function public.platform_admins_list(), public.platform_admin_add(text), public.platform_admin_remove(uuid), public.platform_admin_tell_others(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.platform_admins_list(), public.platform_admin_add(text), public.platform_admin_remove(uuid) to authenticated, service_role;
grant execute on function public.platform_admin_tell_others(text, uuid, uuid, text) to service_role;
