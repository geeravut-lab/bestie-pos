-- Bestie POS · migration 87 · PLATFORM FLAGS (a kill switch per module for the whole platform) and USAGE ANALYTICS (owner order 22 Nov: the two empty platform pages).
-- Flags: stored as "only what is off" (FEATURE-FLAGS-KNOWLEDGE): a row means the module is switched off for every business; no row = the shop's own switches decide.
-- The switch is enforced in three places: the screens (the app treats a killed module as switched off), the database (every `<module>_enabled()` mirror that exists is patched below) and the menu.
-- Analytics: a small event table of our own (no outside SDK, no content): who was active on which day and which screens were opened. Read only by the platform administrator.

-- ══ platform flags ═══════════════════════════════════════════════════════════════════════════════════
create table public.platform_flags (
  module_id  text primary key check (module_id ~ '^[a-z][a-z0-9.]{1,40}$'),
  reason     text check (reason is null or length(reason) <= 200),
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now()
);
alter table public.platform_flags enable row level security;
create policy platform_flags_read on public.platform_flags for select to authenticated using (true);   -- everybody's screens must know what is off
revoke all on public.platform_flags from anon, authenticated;
grant select on public.platform_flags to authenticated;
create trigger platform_flags_live after insert or update or delete on public.platform_flags for each row execute function public.live_ping_row('platform');

create table public.platform_flag_enforced (module_id text primary key);   -- the modules whose database mirror honours the switch (filled by the patch below)
alter table public.platform_flag_enforced enable row level security;
create policy platform_flag_enforced_read on public.platform_flag_enforced for select to authenticated using (public.is_platform_admin());
revoke all on public.platform_flag_enforced from anon, authenticated;
grant select on public.platform_flag_enforced to authenticated;

create or replace function public.module_killed(p_module text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_flags f where f.module_id = p_module)
$$;
revoke all on function public.module_killed(text) from public, anon;
grant execute on function public.module_killed(text) to authenticated, service_role;

-- every `<x>_enabled(uuid)` mirror gets "not module_killed('<its module>')" in front of its first exists(...)
do $$
declare r record; src text; dst text; v_mod text; n integer := 0;
begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname like '%\_enabled' and pg_get_function_identity_arguments(p.oid) = 'p_store uuid'
              and p.proname not in ('module_killed') loop
    src := pg_get_functiondef(r.oid);
    v_mod := substring(src from $re$module_overrides ->> '([a-z][a-z0-9.]*)'$re$);
    continue when v_mod is null or position('module_killed' in src) > 0;
    dst := regexp_replace(src, 'exists \(', 'not public.module_killed(''' || v_mod || ''') and exists (');
    if dst = src then continue; end if;
    execute dst;
    insert into public.platform_flag_enforced (module_id) values (v_mod) on conflict do nothing;
    n := n + 1;
  end loop;
  raise notice 'platform flags: % module mirrors patched', n;
end $$;
-- the org-level mirror of the hub, and the table of tender switches
do $$
declare src text; dst text;
begin
  select pg_get_functiondef(p.oid) into src from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname = 'public' and p.proname = 'hub_enabled';
  if src is not null and position('module_killed' in src) = 0 then
    dst := regexp_replace(src, 'exists \(', 'not public.module_killed(''integration.hub'') and exists (');
    execute dst;
    insert into public.platform_flag_enforced (module_id) values ('integration.hub') on conflict do nothing;
  end if;
end $$;

-- p = { module_id, enabled: bool, reason? } → the platform administrator switches a module off (enabled = false) or back on
create or replace function public.set_platform_flag(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_mod text := p ->> 'module_id'; v_on boolean := coalesce((p ->> 'enabled')::boolean, true);
begin
  if not public.is_platform_admin() then raise exception 'platform flags are for the platform administrator' using errcode = '42501'; end if;
  if v_mod is null or v_mod !~ '^[a-z][a-z0-9.]{1,40}$' then raise exception 'unknown module' using errcode = '22023'; end if;
  if v_on then
    delete from public.platform_flags where module_id = v_mod;
  else
    insert into public.platform_flags (module_id, reason, changed_by) values (v_mod, left(nullif(btrim(coalesce(p ->> 'reason', '')), ''), 200), auth.uid())
    on conflict (module_id) do update set reason = excluded.reason, changed_by = excluded.changed_by, changed_at = now();
  end if;
end $$;

-- the table of the page: for every module id that any shop has a switch for, how many shops switched it on / off, whether it is killed, and whether the database honours the kill
create or replace function public.platform_flags_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then raise exception 'platform flags are for the platform administrator' using errcode = '42501'; end if;
  return jsonb_build_object(
    'shops', (select count(*) from public.stores where deleted_at is null),
    'modules', coalesce((select jsonb_agg(jsonb_build_object('module_id', k.id, 'on_count', k.on_n, 'off_count', k.off_n, 'killed', f.module_id is not null, 'reason', f.reason,
                          'changed_at', f.changed_at, 'db_enforced', e.module_id is not null) order by k.id)
        from (select kv.key as id, count(*) filter (where kv.value = 'true') as on_n, count(*) filter (where kv.value = 'false') as off_n
                from public.stores s, jsonb_each_text(s.module_overrides) kv where s.deleted_at is null group by kv.key) k
        left join public.platform_flags f on f.module_id = k.id
        left join public.platform_flag_enforced e on e.module_id = k.id), '[]'::jsonb),
    'killed', coalesce((select jsonb_agg(jsonb_build_object('module_id', f.module_id, 'reason', f.reason, 'changed_at', f.changed_at, 'db_enforced', e.module_id is not null) order by f.module_id)
        from public.platform_flags f left join public.platform_flag_enforced e on e.module_id = f.module_id), '[]'::jsonb));
end $$;
revoke all on function public.set_platform_flag(jsonb), public.platform_flags_overview() from public, anon;
grant execute on function public.set_platform_flag(jsonb), public.platform_flags_overview() to authenticated, service_role;

-- ══ usage analytics ══════════════════════════════════════════════════════════════════════════════════
create table public.product_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  event      text not null check (event in ('active', 'page_view')),
  day        date not null default ((now() at time zone 'Asia/Bangkok')::date),
  detail     text check (detail is null or detail ~ '^[a-z0-9_.]{1,40}$'),
  created_at timestamptz not null default now()
);
create unique index product_events_active_uidx on public.product_events (user_id, day) where event = 'active';
create unique index product_events_page_uidx on public.product_events (user_id, day, detail) where event = 'page_view';
create index product_events_day_idx on public.product_events (day, event);
alter table public.product_events enable row level security;
revoke all on public.product_events from anon, authenticated;

-- the app calls this once a day per person ('active') and once a day per screen ('page_view', the screen's name): never any content, never raises
create or replace function public.track_event(p_event text, p_detail text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or p_event not in ('active', 'page_view') then return; end if;
  if p_event = 'page_view' and (p_detail is null or p_detail !~ '^[a-z0-9_.]{1,40}$') then return; end if;
  insert into public.product_events (user_id, event, detail) values (auth.uid(), p_event, case when p_event = 'page_view' then p_detail end) on conflict do nothing;
exception when others then
  null;   -- counting a visit must never break the visit
end $$;
revoke all on function public.track_event(text, text) from public, anon;
grant execute on function public.track_event(text, text) to authenticated, service_role;

-- p_days (7–90) → the whole analytics page in one call (platform administrator)
create or replace function public.admin_analytics(p_days integer default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'Asia/Bangkok')::date; v_days integer := least(greatest(coalesce(p_days, 30), 7), 90);
begin
  if not public.is_platform_admin() then raise exception 'analytics are for the platform administrator' using errcode = '42501'; end if;
  return jsonb_build_object(
    'dau', (select count(distinct user_id) from public.product_events where event = 'active' and day = v_today),
    'wau', (select count(distinct user_id) from public.product_events where event = 'active' and day > v_today - 7),
    'mau', (select count(distinct user_id) from public.product_events where event = 'active' and day > v_today - 30),
    'series', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'users', coalesce(x.n, 0)) order by d.day)
                          from (select generate_series(v_today - v_days + 1, v_today, interval '1 day')::date as day) d
                          left join (select day, count(*) as n from public.product_events where event = 'active' and day > v_today - v_days group by day) x on x.day = d.day), '[]'::jsonb),
    'top_pages', coalesce((select jsonb_agg(jsonb_build_object('page', t.detail, 'users', t.n) order by t.n desc)
                             from (select detail, count(distinct user_id) as n from public.product_events where event = 'page_view' and day > v_today - 30 group by detail order by 2 desc limit 15) t), '[]'::jsonb),
    'accounts', (select count(*) from auth.users),
    'businesses', (select count(*) from public.orgs),
    'shops', (select count(*) from public.stores where deleted_at is null),
    'new_businesses_30d', (select count(*) from public.orgs where created_at > now() - interval '30 days'),
    'paid_bills_30d', (select count(*) from public.orders where status = 'paid' and business_date > v_today - 30),
    'paid_bills_prev_30d', (select count(*) from public.orders where status = 'paid' and business_date > v_today - 60 and business_date <= v_today - 30),
    -- people first seen 8+ days ago who came back at least once in the 7 days after their first day
    'retention_d7', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where f.returned) / count(*)) end
                       from (select e.user_id, min(e.day) as first_day,
                                    exists (select 1 from public.product_events e2 where e2.user_id = e.user_id and e2.event = 'active' and e2.day > min(e.day) and e2.day <= min(e.day) + 7) as returned
                               from public.product_events e where e.event = 'active' group by e.user_id having min(e.day) <= v_today - 8) f));
end $$;
revoke all on function public.admin_analytics(integer) from public, anon;
grant execute on function public.admin_analytics(integer) to authenticated, service_role;
