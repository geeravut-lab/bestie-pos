-- Bestie POS · migration 41 · Phase 5b: concierge basics (the shop's own information cards) and guest feedback.
--
--  * `shop_info`: cards the SHOP writes (wifi, opening hours, check-out, island tips…), Thai required / English optional. The guest page
--    lists them; with the AI module on, the model only POINTS at the cards that answer a question — the guest always reads the shop's
--    own words, never text the model wrote. Written through `save_shop_info` / `delete_shop_info` (menu.edit).
--  * `guest_feedback`: a rating 1–5, a closed topic and a short comment from the table page (service role + the table's token, ≤ 3 per
--    table per 10 minutes, no account, no contact data). A rating of 1–2 tells the managers at once (in the app and LINE); the
--    owner / manager (`report.view`) reads and marks them handled.

create table public.shop_info (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  title      jsonb not null check (jsonb_typeof(title) = 'object' and (title - 'th' - 'en') = '{}'::jsonb
                                   and length(btrim(coalesce(title ->> 'th', ''))) between 1 and 80
                                   and (not title ? 'en' or length(title ->> 'en') <= 80)),
  body       jsonb not null check (jsonb_typeof(body) = 'object' and (body - 'th' - 'en') = '{}'::jsonb
                                   and length(btrim(coalesce(body ->> 'th', ''))) between 1 and 1000
                                   and (not body ? 'en' or length(body ->> 'en') <= 1000)),
  sort       integer not null default 100 check (sort between 0 and 100000),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index shop_info_store_idx on public.shop_info (store_id, sort) where deleted_at is null;
create trigger shop_info_touch before update on public.shop_info for each row execute function public.touch_updated_at();
alter table public.shop_info enable row level security;
create policy shop_info_read on public.shop_info for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.shop_info from anon, authenticated;
grant select on public.shop_info to authenticated;

create or replace function public.save_shop_info(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_store uuid := (p ->> 'store_id')::uuid;
  v_org   uuid;
  v_id    uuid := nullif(p ->> 'id', '')::uuid;
begin
  select s.org_id into v_org from public.stores s where s.id = v_store and s.deleted_at is null;
  if v_org is null or not (public.can_access_store(v_org, v_store) and public.has_permission(v_org, 'menu.edit')) then
    raise exception 'editing shop information needs menu.edit' using errcode = '42501';
  end if;
  if v_id is null then
    if (select count(*) from public.shop_info where store_id = v_store and deleted_at is null) >= 40 then
      raise exception 'at most 40 information cards per shop' using errcode = '54000';
    end if;
    insert into public.shop_info (org_id, store_id, title, body, sort, active)
    values (v_org, v_store, p -> 'title', p -> 'body', coalesce((p ->> 'sort')::integer, 100), coalesce((p ->> 'active')::boolean, true))
    returning id into v_id;
  else
    update public.shop_info set title = p -> 'title', body = p -> 'body', sort = coalesce((p ->> 'sort')::integer, sort),
           active = coalesce((p ->> 'active')::boolean, active)
     where id = v_id and store_id = v_store and deleted_at is null;
    if not found then raise exception 'card not found' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end $$;
revoke all on function public.save_shop_info(jsonb) from public, anon;
grant execute on function public.save_shop_info(jsonb) to authenticated, service_role;

create or replace function public.delete_shop_info(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.shop_info%rowtype;
begin
  select * into r from public.shop_info where id = p_id and deleted_at is null;
  if not found or not (public.can_access_store(r.org_id, r.store_id) and public.has_permission(r.org_id, 'menu.edit')) then
    raise exception 'editing shop information needs menu.edit' using errcode = '42501';
  end if;
  update public.shop_info set deleted_at = now() where id = p_id;
end $$;
revoke all on function public.delete_shop_info(uuid) from public, anon;
grant execute on function public.delete_shop_info(uuid) to authenticated, service_role;

-- what the guest page may read (service role, with the table's token): active cards of the table's shop
create or replace function public.guest_info(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when t.id is null then null else coalesce((
    select jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'body', i.body) order by i.sort, i.created_at)
      from public.shop_info i where i.store_id = t.store_id and i.active and i.deleted_at is null), '[]'::jsonb) end
    from (select 1) x left join public.dining_tables t on t.qr_token = p_token and t.deleted_at is null and t.active
$$;
revoke all on function public.guest_info(text) from public, anon, authenticated;
grant execute on function public.guest_info(text) to service_role;

-- ── feedback ──
create table public.guest_feedback (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  table_id   uuid references public.dining_tables (id) on delete set null,
  rating     smallint not null check (rating between 1 and 5),
  topic      text not null default 'other' check (topic in ('food', 'service', 'place', 'price', 'other')),
  comment    text check (comment is null or length(comment) <= 500),
  handled    boolean not null default false,
  handled_at timestamptz,
  created_at timestamptz not null default now()
);
create index guest_feedback_store_idx on public.guest_feedback (store_id, created_at desc);
alter table public.guest_feedback enable row level security;
create policy guest_feedback_read on public.guest_feedback for select to authenticated
  using (public.can_access_store(org_id, store_id) and public.has_permission(org_id, 'report.view'));
revoke all on public.guest_feedback from anon, authenticated;
grant select on public.guest_feedback to authenticated;

create or replace function public.guest_feedback_submit(p_token text, p_rating integer, p_topic text, p_comment text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t public.dining_tables%rowtype;
  v_id uuid;
  v_comment text := nullif(left(regexp_replace(btrim(coalesce(p_comment, '')), '[[:cntrl:]]', ' ', 'g'), 500), '');
begin
  if p_rating is null or p_rating not between 1 and 5 or coalesce(p_topic, 'other') not in ('food', 'service', 'place', 'price', 'other') then
    raise exception 'invalid feedback' using errcode = '22023';
  end if;
  select * into t from public.dining_tables where qr_token = p_token and deleted_at is null and active;
  if not found then raise exception 'table not found' using errcode = 'P0002'; end if;
  if not public.qr_ordering_enabled(t.store_id) then raise exception 'QR service is switched off in this shop' using errcode = '0A000'; end if;
  if (select count(*) from public.guest_feedback where table_id = t.id and created_at > now() - interval '10 minutes') >= 3 then
    raise exception 'too much feedback' using errcode = '53400';
  end if;
  insert into public.guest_feedback (org_id, store_id, table_id, rating, topic, comment)
  values (t.org_id, t.store_id, t.id, p_rating, coalesce(p_topic, 'other'), v_comment) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.guest_feedback_submit(text, integer, text, text) from public, anon, authenticated;
grant execute on function public.guest_feedback_submit(text, integer, text, text) to service_role;

create or replace function public.handle_feedback(p_id uuid, p_handled boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare f public.guest_feedback%rowtype;
begin
  select * into f from public.guest_feedback where id = p_id;
  if not found or not (public.can_access_store(f.org_id, f.store_id) and public.has_permission(f.org_id, 'report.view')) then
    raise exception 'feedback needs report.view' using errcode = '42501';
  end if;
  update public.guest_feedback set handled = coalesce(p_handled, true), handled_at = case when coalesce(p_handled, true) then now() end where id = p_id;
end $$;
revoke all on function public.handle_feedback(uuid, boolean) from public, anon;
grant execute on function public.handle_feedback(uuid, boolean) to authenticated, service_role;

-- a rating of 1–2: the managers hear about it at once (in the app and, if they linked LINE, there too)
create or replace function public.notify_low_feedback() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_table text;
  u uuid;
begin
  if new.rating > 2 then return null; end if;
  select name into v_table from public.dining_tables where id = new.table_id;
  for u in
    select distinct s.user_id from public.staff s join public.roles r on r.id = s.role_id
     where s.org_id = new.org_id and s.active and s.user_id is not null
       and (s.store_id is null or s.store_id = new.store_id)
       and (r.built_in in ('owner', 'manager') or 'report.view' = any (r.permissions))
  loop
    perform public.notify_user(jsonb_build_object(
      'user_id', u, 'org_id', new.org_id, 'kind', 'guest.feedback', 'href', '/feedback', 'dedupe', 'feedback:' || new.id,
      'title', jsonb_build_object('th', 'ลูกค้าให้คะแนนต่ำ ' || new.rating || '/5' || coalesce(' (โต๊ะ ' || v_table || ')', ''),
                                  'en', 'A guest gave ' || new.rating || '/5' || coalesce(' (table ' || v_table || ')', '')),
      'body', jsonb_build_object('th', 'เปิดดูคำติชมและตามเรื่อง', 'en', 'Open the feedback to follow up')));
  end loop;
  return null;
exception when others then
  raise warning 'notify_low_feedback failed: %', sqlerrm;
  return null;
end $$;
create trigger guest_feedback_notify after insert on public.guest_feedback for each row execute function public.notify_low_feedback();
