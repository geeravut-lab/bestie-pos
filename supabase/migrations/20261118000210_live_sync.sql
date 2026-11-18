-- Bestie POS · migration 4 · live sync (docs/LIVE-SYNC-KNOWLEDGE.md).
--
-- The database sends a content-free "ping" on a PRIVATE Realtime channel when something changes; open screens receive it
-- and re-read the data with the viewer's own RLS rights. A ping carries no data, so nothing can leak through it.
-- Who may listen to which topic is decided HERE (RLS on realtime.messages), not in JavaScript.
--
-- Topics:   platform · org:<org> · store:<store> · audit:<org> · u:<user> · admin · kds:<store>:<station> (later)

-- A ping that fails must never break the write that triggered it.
create or replace function public.live_ping(p_topic text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send('{}'::jsonb, 'ping', p_topic, true);
exception when others then
  null;
end $$;
revoke all on function public.live_ping(text) from public;

-- Generic row trigger: TG_ARGV = topic templates, e.g. 'org:{org_id}', 'store:{id}'.
create or replace function public.live_ping_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r      jsonb := to_jsonb(coalesce(new, old));
  tpl    text;
  topic  text;
begin
  foreach tpl in array tg_argv loop
    topic := tpl;
    topic := replace(topic, '{id}', coalesce(r ->> 'id', ''));
    topic := replace(topic, '{org_id}', coalesce(r ->> 'org_id', ''));
    topic := replace(topic, '{store_id}', coalesce(r ->> 'store_id', ''));
    if topic !~ '[{}]' and topic !~ ':$' and topic !~ '::' then
      perform public.live_ping(topic);
    end if;
  end loop;
  return coalesce(new, old);
end $$;

create trigger staff_live      after insert or update or delete on public.staff
  for each row execute function public.live_ping_row('org:{org_id}');
create trigger roles_live      after insert or update or delete on public.roles
  for each row execute function public.live_ping_row('org:{org_id}');
create trigger stores_live     after insert or update or delete on public.stores
  for each row execute function public.live_ping_row('org:{org_id}', 'store:{id}');
create trigger orgs_live       after update on public.orgs
  for each row execute function public.live_ping_row('org:{id}');
create trigger audit_log_live  after insert on public.audit_log
  for each row execute function public.live_ping_row('audit:{org_id}');
create trigger audit_settings_live after insert or update on public.audit_settings
  for each row execute function public.live_ping_row('audit:{org_id}');
create trigger platform_settings_live after update on public.platform_settings
  for each row execute function public.live_ping_row('platform');

-- Who may listen. Anything unknown or malformed → false.
create or replace function public.live_can_listen(p_topic text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  kind text := split_part(p_topic, ':', 1);
  arg1 text := split_part(p_topic, ':', 2);
  v_org uuid;
begin
  if auth.uid() is null then return false; end if;
  case kind
    when 'platform' then
      return p_topic = 'platform';
    when 'admin' then
      return p_topic = 'admin' and public.is_platform_admin();
    when 'u' then
      return arg1::uuid = auth.uid();
    when 'org' then
      return public.is_org_member(arg1::uuid);
    when 'audit' then
      return public.has_permission(arg1::uuid, 'audit.view');
    when 'store' then
      select s.org_id into v_org from public.stores s where s.id = arg1::uuid;
      return v_org is not null and public.can_access_store(v_org, arg1::uuid);
    else
      return false;
  end case;
exception when others then
  return false;
end $$;
revoke all on function public.live_can_listen(text) from public;
grant execute on function public.live_can_listen(text) to authenticated;

-- Realtime reads authorisation from policies on realtime.messages.
create policy live_signals_listen on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast' and public.live_can_listen(realtime.topic()));
