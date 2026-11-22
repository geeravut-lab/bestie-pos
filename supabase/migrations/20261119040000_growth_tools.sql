-- Bestie POS · migration 85 · GROWTH TOOLS (owner order, set C of 22 Nov 2026): per-business network consents, café stamp cards and day passes, tours with capacity / guide / check-in / deposit,
-- LINE marketing campaigns (consent first, one tap to stop), and the integration hub (API keys, signed webhooks, accounting export).
-- Money is integer satang; every guest-facing step is a service-role function or a token the guest holds.

-- ── modules ───────────────────────────────────────────────────────────────────
do $$
declare r record; src text; dst text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'stores_check_modules' loop
    src := pg_get_functiondef(r.oid);
    dst := replace(src, $a$'ai.business_manager'];$a$, $a$'ai.business_manager','marketing','integration.hub','stamps'];$a$);
    if dst = src then raise exception 'migration 85: stores_check_modules not changed'; end if;
    execute dst;
  end loop;
end $$;
create or replace function public.marketing_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stores s where s.id = p_store and s.deleted_at is null and s.plan in ('pro', 'resort')
                    and coalesce((s.module_overrides ->> 'marketing')::boolean, false))
$$;
create or replace function public.stamps_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stores s where s.id = p_store and s.deleted_at is null
                    and coalesce((s.module_overrides ->> 'stamps')::boolean, s.profile = 'cafe'))
$$;
create or replace function public.slots_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stores s where s.id = p_store and s.deleted_at is null and s.plan in ('pro', 'resort')
                    and coalesce((s.module_overrides ->> 'slots.booking')::boolean, s.profile = 'tours'))
$$;
create or replace function public.hub_enabled(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stores s where s.org_id = p_org and s.deleted_at is null and s.plan in ('pro', 'resort')
                    and coalesce((s.module_overrides ->> 'integration.hub')::boolean, false))
$$;
revoke all on function public.marketing_enabled(uuid), public.stamps_enabled(uuid), public.slots_enabled(uuid), public.hub_enabled(uuid) from public, anon;
grant execute on function public.marketing_enabled(uuid), public.stamps_enabled(uuid), public.slots_enabled(uuid), public.hub_enabled(uuid) to authenticated, service_role;

-- ══ 1 · NETWORK CONSENTS: a guest can stop sharing her points with one business ══════════════════════
create table public.network_pass_blocks (
  pass_id    uuid not null references public.network_passes (id) on delete cascade,
  org_id     uuid not null references public.orgs (id) on delete cascade,
  blocked_at timestamptz not null default now(),
  primary key (pass_id, org_id)
);
alter table public.network_pass_blocks enable row level security;
revoke all on public.network_pass_blocks from anon, authenticated;     -- functions only

create or replace function public.pass_blocked(p_pass uuid, p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.network_pass_blocks b where b.pass_id = p_pass and b.org_id = p_org)
$$;
revoke all on function public.pass_blocked(uuid, uuid) from public, anon, authenticated;
grant execute on function public.pass_blocked(uuid, uuid) to service_role;

-- the points a person can spend: her own record, plus (when neither side is blocked) the other businesses' records of the same pass
create or replace function public.points_available(p_customer uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  with me as (select l.pass_id, l.org_id from public.network_pass_links l where l.customer_id = p_customer)
  select coalesce(sum(pl.points), 0)::bigint from public.points_ledger pl
   where pl.customer_id = p_customer
      or (not exists (select 1 from me join public.network_pass_blocks b on b.pass_id = me.pass_id and b.org_id = me.org_id)
          and pl.customer_id in (select l2.customer_id from me join public.network_pass_links l2 on l2.pass_id = me.pass_id
                                  where not exists (select 1 from public.network_pass_blocks b2 where b2.pass_id = l2.pass_id and b2.org_id = l2.org_id)))
$$;

create or replace function public.link_pass(p_store uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; ps public.network_passes%rowtype; v_staff uuid; v_c uuid; c public.customers%rowtype;
begin
  select * into s from public.stores where id = p_store and deleted_at is null;
  if not found or not public.can_access_store(s.org_id, s.id) or not public.has_permission(s.org_id, 'order.create') or not public.has_permission(s.org_id, 'customer.view') then
    raise exception 'attaching a pass needs order.create' using errcode = '42501';
  end if;
  select * into ps from public.network_passes where code = upper(btrim(coalesce(p_code, ''))) or token = lower(btrim(coalesce(p_code, '')));
  if not found or not public.in_network(ps.network_id, s.org_id) then
    return jsonb_build_object('ok', false, 'error', 'unknown_pass');
  end if;
  if public.pass_blocked(ps.id, s.org_id) then return jsonb_build_object('ok', false, 'error', 'pass_blocked'); end if;
  select x.id into v_staff from public.staff x where x.org_id = s.org_id and x.user_id = auth.uid() and x.active limit 1;
  v_c := public.pass_member_for(ps.id, s.org_id, v_staff);
  select * into c from public.customers where id = v_c;
  return jsonb_build_object('ok', true, 'customer_id', c.id, 'name', c.name, 'member_code', c.member_code, 'points', public.points_available(c.id));
end $$;

do $$
declare r record; src text; dst text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'staff_issue_pass' loop
    src := pg_get_functiondef(r.oid);
    dst := replace(src, $a$  v_c := public.pass_member_for(ps.id, s.org_id, v_staff);
  return jsonb_build_object('token', ps.token$a$, $a$  if public.pass_blocked(ps.id, s.org_id) then raise exception 'this guest does not share her points with this business' using errcode = '55000'; end if;
  v_c := public.pass_member_for(ps.id, s.org_id, v_staff);
  return jsonb_build_object('token', ps.token$a$);
    if dst = src then raise exception 'migration 85: staff_issue_pass not changed'; end if;
    execute dst;
  end loop;
end $$;

-- the guest's page: which businesses of the network see her points, and the switch
create or replace function public.guest_pass_partners(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare ps public.network_passes%rowtype;
begin
  select * into ps from public.network_passes where token = lower(btrim(coalesce(p_token, '')));
  if not found then return null; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('org_id', o.id, 'name', o.name, 'blocked', public.pass_blocked(ps.id, o.id)) order by o.name)
                     from public.network_orgs no join public.orgs o on o.id = no.org_id
                    where no.network_id = ps.network_id and no.left_at is null), '[]'::jsonb);
end $$;
create or replace function public.guest_pass_set_block(p_token text, p_org uuid, p_blocked boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ps public.network_passes%rowtype;
begin
  select * into ps from public.network_passes where token = lower(btrim(coalesce(p_token, '')));
  if not found or not public.in_network(ps.network_id, p_org) then return jsonb_build_object('ok', false); end if;
  if p_blocked then
    insert into public.network_pass_blocks (pass_id, org_id) values (ps.id, p_org) on conflict do nothing;
  else
    delete from public.network_pass_blocks where pass_id = ps.id and org_id = p_org;
  end if;
  return jsonb_build_object('ok', true, 'blocked', p_blocked);
end $$;
revoke all on function public.guest_pass_partners(text), public.guest_pass_set_block(text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.guest_pass_partners(text), public.guest_pass_set_block(text, uuid, boolean) to service_role;

-- ══ 2 · STAMP CARDS AND DAY PASSES (café) ═════════════════════════════════════════════════════════
create table public.stamp_programs (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs (id) on delete cascade,
  store_id       uuid not null references public.stores (id) on delete cascade,
  kind           text not null check (kind in ('stamps', 'pass')),
  name           jsonb not null,
  reward_item_id uuid not null references public.menu_items (id),
  stamps_needed  integer check (stamps_needed is null or stamps_needed between 2 and 50),
  min_spend      bigint not null default 0 check (min_spend >= 0),
  pass_price     bigint check (pass_price is null or pass_price > 0),
  pass_days      integer check (pass_days is null or pass_days between 1 and 366),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  check ((kind = 'stamps' and stamps_needed is not null) or (kind = 'pass' and pass_price is not null and pass_days is not null))
);
create table public.stamp_cards (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  program_id  uuid not null references public.stamp_programs (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  stamps      integer not null default 0 check (stamps >= 0),
  rewards_used integer not null default 0 check (rewards_used >= 0),
  updated_at  timestamptz not null default now(),
  unique (program_id, customer_id)
);
create table public.stamp_events (
  card_id    uuid not null references public.stamp_cards (id) on delete cascade,
  order_id   uuid not null references public.orders (id),
  created_at timestamptz not null default now(),
  primary key (card_id, order_id)
);
create table public.customer_passes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  program_id  uuid not null references public.stamp_programs (id),
  customer_id uuid not null references public.customers (id) on delete cascade,
  order_id    uuid not null references public.orders (id),
  status      text not null default 'pending' check (status in ('pending', 'active', 'cancelled')),
  valid_from  date,
  valid_until date,
  created_at  timestamptz not null default now()
);
create table public.stamp_redemptions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs (id) on delete cascade,
  store_id      uuid not null references public.stores (id) on delete cascade,
  program_id    uuid not null references public.stamp_programs (id),
  card_id       uuid references public.stamp_cards (id),
  pass_id       uuid references public.customer_passes (id),
  order_id      uuid not null references public.orders (id),
  line_id       uuid not null references public.order_lines (id),
  business_date date not null,
  value         bigint not null default 0,
  created_at    timestamptz not null default now(),
  released_at   timestamptz,
  check ((card_id is not null) <> (pass_id is not null))
);
create index stamp_redemptions_order_idx on public.stamp_redemptions (order_id);
create index stamp_cards_customer_idx on public.stamp_cards (customer_id);
create index customer_passes_customer_idx on public.customer_passes (customer_id, status);
alter table public.stamp_programs enable row level security;
alter table public.stamp_cards enable row level security;
alter table public.stamp_events enable row level security;
alter table public.customer_passes enable row level security;
alter table public.stamp_redemptions enable row level security;
create policy stamp_programs_read on public.stamp_programs for select to authenticated using (public.can_access_store(org_id, store_id));
create policy stamp_cards_read on public.stamp_cards for select to authenticated using (public.can_access_store(org_id, store_id) and public.has_permission(org_id, 'customer.view'));
create policy customer_passes_read on public.customer_passes for select to authenticated using (public.can_access_store(org_id, store_id) and public.has_permission(org_id, 'customer.view'));
revoke all on public.stamp_programs, public.stamp_cards, public.stamp_events, public.customer_passes, public.stamp_redemptions from anon, authenticated;
grant select on public.stamp_programs, public.stamp_cards, public.customer_passes to authenticated;

-- p = { id?, store_id, kind, name {th,en?}, reward_item_id, stamps_needed?, min_spend?, pass_price?, pass_days?, active? }   (menu.edit)
create or replace function public.save_stamp_program(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; v_id uuid := nullif(p ->> 'id', '')::uuid; v_kind text := p ->> 'kind';
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_edit_menu(s.id) then raise exception 'stamp programs need menu.edit in this shop' using errcode = '42501'; end if;
  if v_kind not in ('stamps', 'pass') then raise exception 'unknown kind' using errcode = '22023'; end if;
  if not exists (select 1 from public.menu_items m where m.id = (p ->> 'reward_item_id')::uuid and m.store_id = s.id and m.deleted_at is null) then
    raise exception 'the reward must be a dish of this shop' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.stamp_programs (org_id, store_id, kind, name, reward_item_id, stamps_needed, min_spend, pass_price, pass_days, active)
    values (s.org_id, s.id, v_kind, p -> 'name', (p ->> 'reward_item_id')::uuid, nullif(p ->> 'stamps_needed', '')::integer, coalesce((p ->> 'min_spend')::bigint, 0),
            nullif(p ->> 'pass_price', '')::bigint, nullif(p ->> 'pass_days', '')::integer, coalesce((p ->> 'active')::boolean, true)) returning id into v_id;
  else
    -- what a customer already holds must not change under her: only the name, the switch and the minimum spend
    update public.stamp_programs set name = p -> 'name', active = coalesce((p ->> 'active')::boolean, active), min_spend = coalesce((p ->> 'min_spend')::bigint, min_spend)
     where id = v_id and store_id = s.id and deleted_at is null;
    if not found then raise exception 'unknown program' using errcode = '22023'; end if;
  end if;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'stamp_programs', v_id::text, jsonb_build_object('kind', v_kind), 'db');
  return v_id;
end $$;
create or replace function public.delete_stamp_program(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.stamp_programs%rowtype;
begin
  select * into r from public.stamp_programs where id = p_id and deleted_at is null;
  if not found or not public.can_edit_menu(r.store_id) then raise exception 'stamp programs need menu.edit in this shop' using errcode = '42501'; end if;
  update public.stamp_programs set deleted_at = now(), active = false where id = r.id;
  perform public.audit_record(r.org_id, r.store_id, 'settings.change', 'stamp_programs', r.id::text, jsonb_build_object('deleted', true), 'db');
end $$;

-- the bill of a day pass: a member buys it like any bill
create or replace function public.sell_stamp_pass(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype; pr public.stamp_programs%rowtype; v_cust uuid := (p ->> 'customer_id')::uuid; v_dev uuid := nullif(p ->> 'device_id', '')::uuid;
  v_order uuid; v_no integer; v_staff uuid;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null for update;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'order.create')) then
    raise exception 'selling a pass needs order.create in this shop' using errcode = '42501';
  end if;
  if not public.stamps_enabled(s.id) then raise exception 'the stamp cards module is off in this shop' using errcode = '0A000'; end if;
  select * into pr from public.stamp_programs where id = (p ->> 'program_id')::uuid and store_id = s.id and kind = 'pass' and active and deleted_at is null;
  if not found then raise exception 'unknown or inactive pass' using errcode = '22023'; end if;
  if not exists (select 1 from public.customers c where c.id = v_cust and c.org_id = s.org_id and c.deleted_at is null) then raise exception 'unknown member' using errcode = '22023'; end if;
  if v_dev is not null and not exists (select 1 from public.devices d where d.id = v_dev and d.store_id = s.id and d.active) then v_dev := null; end if;
  select coalesce(max(substr(o.number, 3)::integer), 0) + 1 into v_no from public.orders o
   where o.store_id = s.id and o.business_date = (now() at time zone 'Asia/Bangkok')::date and o.number ~ '^SP[0-9]+$';
  select f.id into v_staff from public.staff f where f.org_id = s.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.orders (org_id, store_id, number, business_date, channel, status, note, opened_by, device_id, customer_id)
  values (s.org_id, s.id, 'SP' || lpad(v_no::text, 3, '0'), (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'open', left('Pass: ' || (pr.name ->> 'th'), 300), v_staff, v_dev, v_cust)
  returning id into v_order;
  insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, status, sent_at)
  values (s.org_id, s.id, v_order, null, pr.name, pr.pass_price::integer, 1, 'sent', now());
  insert into public.customer_passes (org_id, store_id, program_id, customer_id, order_id) values (s.org_id, s.id, pr.id, v_cust, v_order);
  return v_order;
end $$;

-- a paid bill: stamps for the member, a pass starts; a void bill: the pass is cancelled and a used reward comes back
create or replace function public.stamps_on_order() returns trigger
language plpgsql security definer set search_path = '' as $$
declare pr record; v_card uuid; v_sub bigint;
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
    update public.customer_passes cp
       set status = 'active', valid_from = (now() at time zone 'Asia/Bangkok')::date,
           valid_until = (now() at time zone 'Asia/Bangkok')::date + (select pass_days from public.stamp_programs where id = cp.program_id) - 1
     where cp.order_id = new.id and cp.status = 'pending';
    if new.customer_id is not null and new.number !~ '^(SP|PK|KR|DL|WB|KS)[0-9]+$' then
      select coalesce(sum(l.unit_price::bigint * l.quantity), 0) into v_sub from public.order_lines l where l.order_id = new.id and l.status <> 'void';
      for pr in select * from public.stamp_programs g where g.store_id = new.store_id and g.kind = 'stamps' and g.active and g.deleted_at is null and public.stamps_enabled(g.store_id) and v_sub >= g.min_spend loop
        insert into public.stamp_cards (org_id, store_id, program_id, customer_id) values (new.org_id, new.store_id, pr.id, new.customer_id)
        on conflict (program_id, customer_id) do nothing;
        select id into v_card from public.stamp_cards where program_id = pr.id and customer_id = new.customer_id;
        insert into public.stamp_events (card_id, order_id) values (v_card, new.id) on conflict do nothing;
        if found then update public.stamp_cards set stamps = stamps + 1, updated_at = now() where id = v_card; end if;
      end loop;
    end if;
  elsif new.status = 'void' and old.status is distinct from 'void' then
    update public.customer_passes set status = 'cancelled' where order_id = new.id and status = 'pending';
    update public.stamp_cards c set rewards_used = greatest(c.rewards_used - x.n, 0)
      from (select card_id, count(*) as n from public.stamp_redemptions where order_id = new.id and released_at is null and card_id is not null group by card_id) x where c.id = x.card_id;
    update public.stamp_redemptions set released_at = now() where order_id = new.id and released_at is null;
  end if;
  return null;
end $$;
create trigger orders_stamps_trg after update of status on public.orders for each row execute function public.stamps_on_order();

-- a removed reward line gives the reward back
create or replace function public.stamps_on_line_void() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.stamp_redemptions%rowtype;
begin
  select * into r from public.stamp_redemptions where line_id = new.id and released_at is null;
  if found then
    update public.stamp_redemptions set released_at = now() where id = r.id;
    if r.card_id is not null then update public.stamp_cards set rewards_used = greatest(rewards_used - 1, 0) where id = r.card_id; end if;
  end if;
  return null;
end $$;
create trigger order_lines_stamps_trg after update of status on public.order_lines for each row when (new.status = 'void' and old.status is distinct from 'void') execute function public.stamps_on_line_void();

-- what a member holds in this shop: p = { store_id, customer_id } → programs with her card / pass and whether a reward can be used today
create or replace function public.stamp_status(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype; v_cust uuid := (p ->> 'customer_id')::uuid; v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_access_store(s.org_id, s.id) or not public.has_permission(s.org_id, 'order.create') then
    raise exception 'stamp cards need order.create in this shop' using errcode = '42501';
  end if;
  if not public.stamps_enabled(s.id) then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('program_id', g.id, 'kind', g.kind, 'name', g.name, 'reward_item_id', g.reward_item_id, 'stamps_needed', g.stamps_needed,
             'pass_price', g.pass_price, 'pass_days', g.pass_days,
             'stamps', coalesce(c.stamps, 0), 'rewards_ready', case when g.kind = 'stamps' then greatest(coalesce(c.stamps, 0) / g.stamps_needed - coalesce(c.rewards_used, 0), 0) else 0 end,
             'pass_until', ps.valid_until,
             'pass_used_today', case when ps.id is null then null else exists (select 1 from public.stamp_redemptions r where r.pass_id = ps.id and r.business_date = v_today and r.released_at is null) end)
             order by g.created_at)
      from public.stamp_programs g
      left join public.stamp_cards c on c.program_id = g.id and c.customer_id = v_cust
      left join lateral (select x.id, x.valid_until from public.customer_passes x where x.program_id = g.id and x.customer_id = v_cust and x.status = 'active' and x.valid_until >= v_today order by x.valid_until desc limit 1) ps on true
     where g.store_id = s.id and g.active and g.deleted_at is null), '[]'::jsonb);
end $$;

-- use a reward on an open bill: one unsent line of the reward dish becomes free.  p = { order_id, program_id }   (online only)
create or replace function public.redeem_stamp_reward(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders%rowtype; pr public.stamp_programs%rowtype; c public.stamp_cards%rowtype; ps public.customer_passes%rowtype; l public.order_lines%rowtype;
  v_today date := (now() at time zone 'Asia/Bangkok')::date; v_new uuid;
begin
  select * into o from public.orders where id = (p ->> 'order_id')::uuid for update;
  if not found or not (public.can_access_store(o.org_id, o.store_id) and public.has_permission(o.org_id, 'order.create')) then
    raise exception 'using a reward needs order.create in this shop' using errcode = '42501';
  end if;
  if o.status <> 'open' then raise exception 'the bill is closed' using errcode = '55000'; end if;
  if o.customer_id is null then raise exception 'put the member on the bill first' using errcode = '55000'; end if;
  select * into pr from public.stamp_programs where id = (p ->> 'program_id')::uuid and store_id = o.store_id and active and deleted_at is null;
  if not found or not public.stamps_enabled(o.store_id) then raise exception 'unknown program' using errcode = '22023'; end if;
  select * into l from public.order_lines where order_id = o.id and item_id = pr.reward_item_id and status = 'new' and unit_price > 0 order by created_at limit 1 for update;
  if not found then raise exception 'add the reward dish to the bill first' using errcode = '55000'; end if;
  if pr.kind = 'stamps' then
    select * into c from public.stamp_cards where program_id = pr.id and customer_id = o.customer_id for update;
    if not found or c.stamps / pr.stamps_needed - c.rewards_used < 1 then raise exception 'no reward is ready on this card' using errcode = '55000'; end if;
  else
    select * into ps from public.customer_passes where program_id = pr.id and customer_id = o.customer_id and status = 'active' and valid_until >= v_today order by valid_until desc limit 1 for update;
    if not found then raise exception 'this member has no active pass' using errcode = '55000'; end if;
    if exists (select 1 from public.stamp_redemptions r where r.pass_id = ps.id and r.business_date = v_today and r.released_at is null) then
      raise exception 'the pass was already used today' using errcode = '55000';
    end if;
  end if;
  v_new := l.id;
  if l.quantity > 1 then   -- only one unit becomes free: split it off
    update public.order_lines set quantity = quantity - 1 where id = l.id;
    insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, list_price, quantity, status, modifiers, note, seat)
    values (l.org_id, l.store_id, l.order_id, l.item_id, l.name, 0, l.unit_price, 1, 'new', l.modifiers, l.note, l.seat) returning id into v_new;
  else
    update public.order_lines set list_price = coalesce(list_price, unit_price), unit_price = 0 where id = l.id;
  end if;
  insert into public.stamp_redemptions (org_id, store_id, program_id, card_id, pass_id, order_id, line_id, business_date, value)
  values (o.org_id, o.store_id, pr.id, c.id, ps.id, o.id, v_new, v_today, l.unit_price);
  if pr.kind = 'stamps' then update public.stamp_cards set rewards_used = rewards_used + 1, updated_at = now() where id = c.id; end if;
  return jsonb_build_object('ok', true, 'line_id', v_new, 'value', l.unit_price);
end $$;
revoke all on function public.save_stamp_program(jsonb), public.delete_stamp_program(uuid), public.sell_stamp_pass(jsonb), public.stamp_status(jsonb), public.redeem_stamp_reward(jsonb) from public, anon;
grant execute on function public.save_stamp_program(jsonb), public.delete_stamp_program(uuid), public.sell_stamp_pass(jsonb), public.stamp_status(jsonb), public.redeem_stamp_reward(jsonb) to authenticated, service_role;

-- p = { store_id, from, to } → { stamps_given, rewards_used, reward_value, passes_sold, passes_active }   (report.view)
create or replace function public.stamps_report(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype; v_from date := (p ->> 'from')::date; v_to date := (p ->> 'to')::date;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'report.view')) then
    raise exception 'the stamp report needs report.view in this shop' using errcode = '42501';
  end if;
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 366 then raise exception 'bad range' using errcode = '22023'; end if;
  return jsonb_build_object(
    'stamps_given', (select count(*) from public.stamp_events e join public.stamp_cards c on c.id = e.card_id where c.store_id = s.id and (e.created_at at time zone 'Asia/Bangkok')::date between v_from and v_to),
    'rewards_used', (select count(*) from public.stamp_redemptions r where r.store_id = s.id and r.released_at is null and r.business_date between v_from and v_to),
    'reward_value', coalesce((select sum(r.value) from public.stamp_redemptions r where r.store_id = s.id and r.released_at is null and r.business_date between v_from and v_to), 0),
    'passes_sold', (select count(*) from public.customer_passes x where x.store_id = s.id and x.status = 'active' and x.valid_from between v_from and v_to),
    'passes_active', (select count(*) from public.customer_passes x where x.store_id = s.id and x.status = 'active' and x.valid_until >= (now() at time zone 'Asia/Bangkok')::date));
end $$;
revoke all on function public.stamps_report(jsonb) from public, anon;
grant execute on function public.stamps_report(jsonb) to authenticated, service_role;

-- ══ 3 · TOURS: slots with a capacity, a guide, check-in, a deposit and a bill ═══════════════════════
create table public.tour_slots (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs (id) on delete cascade,
  store_id       uuid not null references public.stores (id) on delete cascade,
  title          jsonb not null,
  starts_at      timestamptz not null,
  duration_min   integer not null check (duration_min between 15 and 1440),
  capacity       integer not null check (capacity between 1 and 500),
  price          bigint not null check (price >= 0),
  guide_staff_id uuid references public.staff (id) on delete set null,
  status         text not null default 'open' check (status in ('open', 'cancelled')),
  note           text check (note is null or length(note) <= 300),
  created_at     timestamptz not null default now()
);
create table public.tour_bookings (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs (id) on delete cascade,
  store_id       uuid not null references public.stores (id) on delete cascade,
  slot_id        uuid not null references public.tour_slots (id) on delete cascade,
  guest_name     text not null check (length(btrim(guest_name)) between 1 and 80),
  phone          text check (phone is null or phone ~ '^[0-9]{8,15}$'),
  seats          integer not null check (seats between 1 and 50),
  status         text not null default 'booked' check (status in ('booked', 'checked_in', 'cancelled', 'no_show')),
  deposit        bigint not null default 0 check (deposit >= 0),
  deposit_method text check (deposit_method is null or deposit_method in ('promptpay', 'gateway')),
  customer_id    uuid references public.customers (id) on delete set null,
  order_id       uuid references public.orders (id),
  client_id      uuid unique,
  created_by     uuid references public.staff (id),
  created_at     timestamptz not null default now()
);
create index tour_slots_store_idx on public.tour_slots (store_id, starts_at);
create index tour_bookings_slot_idx on public.tour_bookings (slot_id, status);
alter table public.tour_slots enable row level security;
alter table public.tour_bookings enable row level security;
create policy tour_slots_read on public.tour_slots for select to authenticated using (public.can_access_store(org_id, store_id));
create policy tour_bookings_read on public.tour_bookings for select to authenticated using (public.can_access_store(org_id, store_id) and public.has_permission(org_id, 'order.create'));
revoke all on public.tour_slots, public.tour_bookings from anon, authenticated;
grant select on public.tour_slots, public.tour_bookings to authenticated;
create trigger tour_slots_live after insert or update on public.tour_slots for each row execute function public.live_ping_row('store:{store_id}');
create trigger tour_bookings_live after insert or update on public.tour_bookings for each row execute function public.live_ping_row('store:{store_id}');

create or replace function public.tour_seats_taken(p_slot uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(seats), 0)::integer from public.tour_bookings where slot_id = p_slot and status in ('booked', 'checked_in')
$$;
revoke all on function public.tour_seats_taken(uuid) from public, anon;
grant execute on function public.tour_seats_taken(uuid) to authenticated, service_role;

-- p = { id?, store_id, title {th,en?}, starts_at, duration_min, capacity, price, guide_staff_id?, note? }   (menu.edit)
create or replace function public.save_tour_slot(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; v_id uuid := nullif(p ->> 'id', '')::uuid; v_cap integer := (p ->> 'capacity')::integer; v_guide uuid := nullif(p ->> 'guide_staff_id', '')::uuid;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_edit_menu(s.id) then raise exception 'tour slots need menu.edit in this shop' using errcode = '42501'; end if;
  if not public.slots_enabled(s.id) then raise exception 'the slot booking module is off in this shop' using errcode = '0A000'; end if;
  if v_guide is not null and not exists (select 1 from public.staff f where f.id = v_guide and f.org_id = s.org_id and f.active) then raise exception 'unknown guide' using errcode = '22023'; end if;
  if v_id is null then
    insert into public.tour_slots (org_id, store_id, title, starts_at, duration_min, capacity, price, guide_staff_id, note)
    values (s.org_id, s.id, p -> 'title', (p ->> 'starts_at')::timestamptz, (p ->> 'duration_min')::integer, v_cap, (p ->> 'price')::bigint, v_guide, left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 300))
    returning id into v_id;
  else
    perform 1 from public.tour_slots where id = v_id and store_id = s.id for update;
    if not found then raise exception 'unknown slot' using errcode = '22023'; end if;
    if v_cap < public.tour_seats_taken(v_id) then raise exception 'the capacity is lower than the seats already booked' using errcode = '55000'; end if;
    update public.tour_slots set title = p -> 'title', starts_at = (p ->> 'starts_at')::timestamptz, duration_min = (p ->> 'duration_min')::integer, capacity = v_cap,
           price = (p ->> 'price')::bigint, guide_staff_id = v_guide, note = left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 300) where id = v_id;
  end if;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'tour_slots', v_id::text, '{}'::jsonb, 'db');
  return v_id;
end $$;

create or replace function public.cancel_tour_slot(p_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare t public.tour_slots%rowtype; n integer;
begin
  select * into t from public.tour_slots where id = p_id for update;
  if not found or not public.can_edit_menu(t.store_id) then raise exception 'tour slots need menu.edit in this shop' using errcode = '42501'; end if;
  update public.tour_slots set status = 'cancelled' where id = t.id;
  update public.tour_bookings set status = 'cancelled' where slot_id = t.id and status = 'booked';
  get diagnostics n = row_count;
  perform public.audit_record(t.org_id, t.store_id, 'settings.change', 'tour_slots', t.id::text, jsonb_build_object('cancelled', true, 'bookings', n), 'db');
  return n;
end $$;

-- p = { slot_id, guest_name, phone?, seats, customer_id?, client_id }   (order.create)
create or replace function public.book_tour(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tour_slots%rowtype; b public.tour_bookings%rowtype; v_client uuid := (p ->> 'client_id')::uuid; v_seats integer := (p ->> 'seats')::integer; v_staff uuid;
begin
  select * into t from public.tour_slots where id = (p ->> 'slot_id')::uuid for update;
  if not found or not (public.can_access_store(t.org_id, t.store_id) and public.has_permission(t.org_id, 'order.create')) then
    raise exception 'booking a tour needs order.create in this shop' using errcode = '42501';
  end if;
  if not public.slots_enabled(t.store_id) then raise exception 'the slot booking module is off in this shop' using errcode = '0A000'; end if;
  if v_client is not null then
    select * into b from public.tour_bookings where client_id = v_client;
    if found then return jsonb_build_object('id', b.id, 'seats_left', t.capacity - public.tour_seats_taken(t.id), 'replay', true); end if;
  end if;
  if t.status <> 'open' then raise exception 'this tour is cancelled' using errcode = '55000'; end if;
  if t.starts_at < now() - interval '1 hour' then raise exception 'this tour has already started' using errcode = '55000'; end if;
  if v_seats is null or v_seats < 1 then raise exception 'seats must be at least 1' using errcode = '22023'; end if;
  if public.tour_seats_taken(t.id) + v_seats > t.capacity then raise exception 'not enough seats left' using errcode = '55000'; end if;
  select f.id into v_staff from public.staff f where f.org_id = t.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.tour_bookings (org_id, store_id, slot_id, guest_name, phone, seats, customer_id, client_id, created_by)
  values (t.org_id, t.store_id, t.id, btrim(p ->> 'guest_name'), nullif(regexp_replace(coalesce(p ->> 'phone', ''), '[^0-9]', '', 'g'), ''), v_seats,
          (select c.id from public.customers c where c.id = nullif(p ->> 'customer_id', '')::uuid and c.org_id = t.org_id), v_client, v_staff)
  returning * into b;
  return jsonb_build_object('id', b.id, 'seats_left', t.capacity - public.tour_seats_taken(t.id));
end $$;

create or replace function public.set_tour_booking_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.tour_bookings%rowtype;
begin
  select * into b from public.tour_bookings where id = p_id for update;
  if not found or not (public.can_access_store(b.org_id, b.store_id) and public.has_permission(b.org_id, 'order.create')) then
    raise exception 'tour bookings need order.create in this shop' using errcode = '42501';
  end if;
  if not (b.status = 'booked' and p_status in ('checked_in', 'cancelled', 'no_show')) then raise exception 'this change is not allowed' using errcode = '55000'; end if;
  update public.tour_bookings set status = p_status where id = b.id;
end $$;

-- a deposit received before the tour: promptpay (transfer) or card, recorded by the desk   p = { booking_id, amount, method }   (payment.take)
create or replace function public.take_tour_deposit(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.tour_bookings%rowtype; t public.tour_slots%rowtype; v_amt bigint := (p ->> 'amount')::bigint; v_m text := p ->> 'method';
begin
  select * into b from public.tour_bookings where id = (p ->> 'booking_id')::uuid for update;
  if not found or not (public.can_access_store(b.org_id, b.store_id) and public.has_permission(b.org_id, 'payment.take')) then
    raise exception 'a deposit needs payment.take in this shop' using errcode = '42501';
  end if;
  select * into t from public.tour_slots where id = b.slot_id;
  if b.status <> 'booked' or v_m not in ('promptpay', 'gateway') or v_amt is null or v_amt <= 0 then raise exception 'a deposit cannot be taken now' using errcode = '55000'; end if;
  if b.deposit + v_amt > t.price * b.seats then raise exception 'the deposit is more than the price' using errcode = '22023'; end if;
  update public.tour_bookings set deposit = deposit + v_amt, deposit_method = v_m where id = b.id;
  perform public.audit_record(b.org_id, b.store_id, 'payment.tender', 'tour_bookings', b.id::text, jsonb_build_object('deposit', v_amt, 'method', v_m), 'db');
end $$;

-- once the guests have checked in the booking becomes an ordinary bill (TB001…): seats × price, the deposit already paid
create or replace function public.tour_to_order(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b public.tour_bookings%rowtype; t public.tour_slots%rowtype; v_dev uuid := nullif(p ->> 'device_id', '')::uuid; v_order uuid; v_no integer; v_staff uuid; v_id uuid := gen_random_uuid();
begin
  select * into b from public.tour_bookings where id = (p ->> 'booking_id')::uuid for update;
  if not found or not (public.can_access_store(b.org_id, b.store_id) and public.has_permission(b.org_id, 'order.create')) then
    raise exception 'billing a tour needs order.create in this shop' using errcode = '42501';
  end if;
  if b.order_id is not null and exists (select 1 from public.orders o where o.id = b.order_id and o.status <> 'void') then return b.order_id; end if;
  if b.status <> 'checked_in' then raise exception 'check the guests in first' using errcode = '55000'; end if;
  select * into t from public.tour_slots where id = b.slot_id;
  if v_dev is not null and not exists (select 1 from public.devices x where x.id = v_dev and x.store_id = b.store_id and x.active) then v_dev := null; end if;
  select coalesce(max(substr(o.number, 3)::integer), 0) + 1 into v_no from public.orders o
   where o.store_id = b.store_id and o.business_date = (now() at time zone 'Asia/Bangkok')::date and o.number ~ '^TB[0-9]+$';
  select f.id into v_staff from public.staff f where f.org_id = b.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.orders (org_id, store_id, number, business_date, channel, status, note, opened_by, device_id, customer_id)
  values (b.org_id, b.store_id, 'TB' || lpad(v_no::text, 3, '0'), (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'open', left('Tour: ' || b.guest_name, 300), v_staff, v_dev, b.customer_id)
  returning id into v_order;
  insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, status, sent_at)
  values (b.org_id, b.store_id, v_order, null, t.title, t.price::integer, b.seats, 'sent', now());
  if b.deposit > 0 then
    insert into public.order_partial_payments (id, org_id, store_id, order_id, tender, amount, provider_ref, kind, note)
    values (v_id, b.org_id, b.store_id, v_order, b.deposit_method, least(b.deposit, t.price * b.seats), 'deposit:' || v_id, 'deposit', 'deposit');
  end if;
  update public.tour_bookings set order_id = v_order where id = b.id;
  return v_order;
end $$;

-- the list the guide takes along: p = { slot_id } → slot, guide and the people booked   (order.create)
create or replace function public.tour_manifest(p_slot uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.tour_slots%rowtype;
begin
  select * into t from public.tour_slots where id = p_slot;
  if not found or not (public.can_access_store(t.org_id, t.store_id) and public.has_permission(t.org_id, 'order.create')) then
    raise exception 'the manifest needs order.create in this shop' using errcode = '42501';
  end if;
  return jsonb_build_object('slot', to_jsonb(t), 'seats_taken', public.tour_seats_taken(t.id),
    'guide', (select f.display_name from public.staff f where f.id = t.guide_staff_id),
    'bookings', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'guest_name', b.guest_name, 'phone', b.phone, 'seats', b.seats, 'status', b.status, 'deposit', b.deposit, 'order_id', b.order_id) order by b.created_at)
                            from public.tour_bookings b where b.slot_id = t.id and b.status <> 'cancelled'), '[]'::jsonb));
end $$;
revoke all on function public.save_tour_slot(jsonb), public.cancel_tour_slot(uuid), public.book_tour(jsonb), public.set_tour_booking_status(uuid, text), public.take_tour_deposit(jsonb), public.tour_to_order(jsonb), public.tour_manifest(uuid) from public, anon;
grant execute on function public.save_tour_slot(jsonb), public.cancel_tour_slot(uuid), public.book_tour(jsonb), public.set_tour_booking_status(uuid, text), public.take_tour_deposit(jsonb), public.tour_to_order(jsonb), public.tour_manifest(uuid) to authenticated, service_role;

-- ══ 4 · MARKETING: consent first, a code the guest sends to the LINE account, STOP always works ═════
create table public.customer_contacts (
  customer_id     uuid primary key references public.customers (id) on delete cascade,
  org_id          uuid not null references public.orgs (id) on delete cascade,
  line_user_id    text check (line_user_id is null or length(line_user_id) between 5 and 64),
  line_bound_at   timestamptz,
  line_stopped_at timestamptz
);
create index customer_contacts_line_idx on public.customer_contacts (line_user_id) where line_user_id is not null;
create table public.customer_line_codes (
  code_hash   text primary key,
  customer_id uuid not null references public.customers (id) on delete cascade,
  org_id      uuid not null references public.orgs (id) on delete cascade,
  expires_at  timestamptz not null
);
create table public.marketing_campaigns (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 80),
  kind       text not null check (kind in ('winback', 'rebook', 'welcome')),
  idle_days  integer not null default 30 check (idle_days between 7 and 365),
  message    jsonb not null,
  active     boolean not null default false,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table public.marketing_sends (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  campaign_id uuid not null references public.marketing_campaigns (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  bucket      date not null,
  status      text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  tries       integer not null default 0,
  claimed_at  timestamptz,
  sent_at     timestamptz,
  error       text,
  queued_at   timestamptz not null default now(),
  unique (campaign_id, customer_id, bucket)
);
create index marketing_sends_due_idx on public.marketing_sends (status, claimed_at) where status = 'queued';
alter table public.customer_contacts enable row level security;
alter table public.customer_line_codes enable row level security;
alter table public.marketing_campaigns enable row level security;
alter table public.marketing_sends enable row level security;
create policy marketing_campaigns_read on public.marketing_campaigns for select to authenticated using (public.can_access_store(org_id, store_id) and public.has_permission(org_id, 'customer.view'));
create policy marketing_sends_read on public.marketing_sends for select to authenticated using (public.has_permission(org_id, 'customer.view'));
revoke all on public.customer_contacts, public.customer_line_codes, public.marketing_campaigns, public.marketing_sends from anon, authenticated;
grant select on public.marketing_campaigns, public.marketing_sends to authenticated;

-- the front desk shows a one-time code; the member sends it to the shop's LINE Official Account.  Sending it IS the consent.
create or replace function public.marketing_line_code(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; v_cust uuid := (p ->> 'customer_id')::uuid; v_code text;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'order.create') and public.has_permission(s.org_id, 'customer.view')) then
    raise exception 'a LINE code needs order.create in this shop' using errcode = '42501';
  end if;
  if not public.marketing_enabled(s.id) then raise exception 'the marketing module is off in this shop' using errcode = '0A000'; end if;
  if not exists (select 1 from public.customers c where c.id = v_cust and c.org_id = s.org_id and c.deleted_at is null) then raise exception 'unknown member' using errcode = '22023'; end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  delete from public.customer_line_codes where customer_id = v_cust or expires_at < now();
  insert into public.customer_line_codes (code_hash, customer_id, org_id, expires_at)
  values (encode(sha256(convert_to(v_code, 'utf8')), 'hex'), v_cust, s.org_id, now() + interval '30 minutes');
  return jsonb_build_object('code', v_code, 'minutes', 30);
end $$;

-- the webhook: a code that belongs to a member binds her LINE account (and records her consent); otherwise the old booking-code rule
create or replace function public.guest_bind_line(p_code text, p_line_user_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.appointments%rowtype; cl public.customer_line_codes%rowtype;
  v_hash text := encode(sha256(convert_to(upper(btrim(coalesce(p_code, ''))), 'utf8')), 'hex');
begin
  if p_line_user_id is null or length(p_line_user_id) not between 5 and 64 then return jsonb_build_object('ok', false); end if;
  select * into cl from public.customer_line_codes where code_hash = v_hash and expires_at > now();
  if found then
    insert into public.customer_contacts (customer_id, org_id, line_user_id, line_bound_at, line_stopped_at) values (cl.customer_id, cl.org_id, p_line_user_id, now(), null)
    on conflict (customer_id) do update set line_user_id = excluded.line_user_id, line_bound_at = now(), line_stopped_at = null;
    update public.customers set consent = true where id = cl.customer_id;
    delete from public.customer_line_codes where code_hash = v_hash;
    return jsonb_build_object('ok', true, 'kind', 'marketing');
  end if;
  select * into a from public.appointments
   where cancel_hash = v_hash and status in ('booked', 'confirmed') and starts_at > now()
   order by starts_at limit 1 for update;
  if not found then return jsonb_build_object('ok', false); end if;
  update public.appointments set guest_line_user_id = p_line_user_id where id = a.id;
  return jsonb_build_object('ok', true, 'starts_at', a.starts_at, 'kind', 'booking');
end $$;

-- STOP in the chat: nothing more is sent, and the consent is withdrawn
create or replace function public.marketing_stop(p_line_user_id text) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.customer_contacts set line_stopped_at = now() where line_user_id = p_line_user_id and line_stopped_at is null;
  get diagnostics n = row_count;
  update public.customers set consent = false where id in (select customer_id from public.customer_contacts where line_user_id = p_line_user_id);
  return n;
end $$;
revoke all on function public.guest_bind_line(text, text), public.marketing_stop(text) from public, anon, authenticated;
grant execute on function public.guest_bind_line(text, text), public.marketing_stop(text) to service_role;
revoke all on function public.marketing_line_code(jsonb) from public, anon;
grant execute on function public.marketing_line_code(jsonb) to authenticated, service_role;

-- p = { id?, store_id, name, kind, idle_days, message {th,en?}, active }   (menu.edit)
create or replace function public.save_marketing_campaign(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_edit_menu(s.id) then raise exception 'campaigns need menu.edit in this shop' using errcode = '42501'; end if;
  if not public.marketing_enabled(s.id) then raise exception 'the marketing module is off in this shop' using errcode = '0A000'; end if;
  if jsonb_typeof(p -> 'message') is distinct from 'object' or length(coalesce(p -> 'message' ->> 'th', '')) not between 1 and 400 or length(coalesce(p -> 'message' ->> 'en', '')) > 400 then
    raise exception 'the message must be 1–400 characters' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.marketing_campaigns (org_id, store_id, name, kind, idle_days, message, active)
    values (s.org_id, s.id, btrim(p ->> 'name'), p ->> 'kind', coalesce((p ->> 'idle_days')::integer, 30), p -> 'message', coalesce((p ->> 'active')::boolean, false)) returning id into v_id;
  else
    update public.marketing_campaigns set name = btrim(p ->> 'name'), kind = p ->> 'kind', idle_days = coalesce((p ->> 'idle_days')::integer, idle_days), message = p -> 'message',
           active = coalesce((p ->> 'active')::boolean, active) where id = v_id and store_id = s.id and deleted_at is null;
    if not found then raise exception 'unknown campaign' using errcode = '22023'; end if;
  end if;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'marketing_campaigns', v_id::text, jsonb_build_object('active', coalesce((p ->> 'active')::boolean, false)), 'db');
  return v_id;
end $$;
create or replace function public.delete_marketing_campaign(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.marketing_campaigns%rowtype;
begin
  select * into r from public.marketing_campaigns where id = p_id and deleted_at is null;
  if not found or not public.can_edit_menu(r.store_id) then raise exception 'campaigns need menu.edit in this shop' using errcode = '42501'; end if;
  update public.marketing_campaigns set deleted_at = now(), active = false where id = r.id;
  delete from public.marketing_sends where campaign_id = r.id and status = 'queued';
end $$;

-- who a campaign would reach today (consented, LINE linked, not stopped, nothing sent to them in the last 14 days)
create or replace function public.marketing_eligible(p_campaign uuid) returns table (customer_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare c public.marketing_campaigns%rowtype; v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  select * into c from public.marketing_campaigns where id = p_campaign and deleted_at is null;
  if not found then return; end if;
  return query
  select k.customer_id from public.customer_contacts k
    join public.customers cu on cu.id = k.customer_id and cu.deleted_at is null and cu.consent and cu.org_id = c.org_id
   where k.org_id = c.org_id and k.line_user_id is not null and k.line_stopped_at is null
     and not exists (select 1 from public.marketing_sends m where m.customer_id = k.customer_id and m.status in ('queued', 'sent') and m.queued_at > now() - interval '14 days')
     and case c.kind
       when 'winback' then exists (select 1 from public.orders o where o.customer_id = k.customer_id and o.org_id = c.org_id and o.status = 'paid')
                           and not exists (select 1 from public.orders o where o.customer_id = k.customer_id and o.org_id = c.org_id and o.status = 'paid' and o.business_date > v_today - c.idle_days)
       when 'rebook' then exists (select 1 from public.appointments a where a.customer_id = k.customer_id and a.org_id = c.org_id and a.status = 'done')
                          and not exists (select 1 from public.appointments a where a.customer_id = k.customer_id and a.org_id = c.org_id and a.status = 'done' and (a.starts_at at time zone 'Asia/Bangkok')::date > v_today - c.idle_days)
                          and not exists (select 1 from public.appointments a where a.customer_id = k.customer_id and a.org_id = c.org_id and a.status in ('booked', 'confirmed') and a.starts_at > now())
       else (select count(*) from public.orders o where o.customer_id = k.customer_id and o.org_id = c.org_id and o.status = 'paid') = 1
            and exists (select 1 from public.orders o where o.customer_id = k.customer_id and o.org_id = c.org_id and o.status = 'paid' and o.business_date >= v_today - 2)
     end;
end $$;

-- a manager looks before switching on: p = { campaign_id } → { eligible, linked }
create or replace function public.marketing_preview(p_campaign uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.marketing_campaigns%rowtype;
begin
  select * into c from public.marketing_campaigns where id = p_campaign and deleted_at is null;
  if not found or not (public.can_access_store(c.org_id, c.store_id) and public.has_permission(c.org_id, 'customer.view')) then raise exception 'campaigns need customer.view in this shop' using errcode = '42501'; end if;
  return jsonb_build_object('eligible', (select count(*) from public.marketing_eligible(c.id)),
    'linked', (select count(*) from public.customer_contacts k join public.customers cu on cu.id = k.customer_id where k.org_id = c.org_id and k.line_user_id is not null and k.line_stopped_at is null and cu.consent));
end $$;

-- queue today's messages for every active campaign (up to 100 each, 300 per business per month); the tick calls this once a day
create or replace function public.marketing_run_all() returns integer
language plpgsql security definer set search_path = '' as $$
declare c record; v_n integer := 0; v_add integer; v_month integer; v_bucket date := (now() at time zone 'Asia/Bangkok')::date;
begin
  for c in select * from public.marketing_campaigns where active and deleted_at is null and public.marketing_enabled(store_id)
              and (last_run_at is null or last_run_at < now() - interval '20 hours') loop
    select count(*) into v_month from public.marketing_sends m where m.org_id = c.org_id and m.queued_at >= date_trunc('month', now());
    insert into public.marketing_sends (org_id, campaign_id, customer_id, bucket)
    select c.org_id, c.id, e.customer_id, v_bucket from public.marketing_eligible(c.id) e limit greatest(least(100, 300 - v_month), 0)
    on conflict do nothing;
    get diagnostics v_add = row_count;
    v_n := v_n + v_add;
    update public.marketing_campaigns set last_run_at = now() where id = c.id;
  end loop;
  return v_n;
end $$;

-- the tick: hand out due messages (max 3 tries, each held for 10 minutes while a delivery is in flight)
create or replace function public.marketing_claim(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  with due as (
    select m.id from public.marketing_sends m where m.status = 'queued' and m.tries < 3 and (m.claimed_at is null or m.claimed_at < now() - interval '10 minutes')
     order by m.queued_at limit least(greatest(coalesce(p_limit, 20), 1), 50) for update skip locked),
  upd as (
    update public.marketing_sends m set claimed_at = now(), tries = tries + 1 from due where m.id = due.id returning m.*)
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'line_user_id', k.line_user_id, 'th', c.message ->> 'th', 'en', c.message ->> 'en')), '[]'::jsonb) into r
    from upd u join public.marketing_campaigns c on c.id = u.campaign_id
    join public.customer_contacts k on k.customer_id = u.customer_id and k.line_user_id is not null and k.line_stopped_at is null;
  -- a send whose person has stopped meanwhile is dropped
  update public.marketing_sends m set status = 'failed', error = 'stopped' where m.status = 'queued'
     and not exists (select 1 from public.customer_contacts k where k.customer_id = m.customer_id and k.line_user_id is not null and k.line_stopped_at is null);
  return r;
end $$;
create or replace function public.marketing_report(p_id uuid, p_outcome text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_outcome = 'sent' then
    update public.marketing_sends set status = 'sent', sent_at = now(), error = null where id = p_id;
  elsif p_outcome = 'blocked' then   -- the person blocked the account: no more messages
    update public.marketing_sends set status = 'failed', error = 'blocked' where id = p_id;
    update public.customer_contacts set line_stopped_at = now() where customer_id = (select customer_id from public.marketing_sends where id = p_id);
  else
    update public.marketing_sends set status = case when tries >= 3 then 'failed' else 'queued' end, error = left(p_outcome, 60) where id = p_id;
  end if;
end $$;
revoke all on function public.marketing_eligible(uuid), public.marketing_run_all(), public.marketing_claim(integer), public.marketing_report(uuid, text) from public, anon, authenticated;
grant execute on function public.marketing_eligible(uuid), public.marketing_run_all(), public.marketing_claim(integer), public.marketing_report(uuid, text) to service_role;
revoke all on function public.save_marketing_campaign(jsonb), public.delete_marketing_campaign(uuid), public.marketing_preview(uuid) from public, anon;
grant execute on function public.save_marketing_campaign(jsonb), public.delete_marketing_campaign(uuid), public.marketing_preview(uuid) to authenticated, service_role;

-- ══ 5 · INTEGRATION HUB: API keys, signed webhooks, accounting export ═══════════════════════════════
create table public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs (id) on delete cascade,
  name         text not null check (length(btrim(name)) between 1 and 60),
  key_hash     text not null unique,
  prefix       text not null,
  scopes       text[] not null default '{sales,menu}' check (scopes <@ array['sales', 'menu']),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create table public.webhook_endpoints (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  url         text not null check (url ~ '^https://[^\s]{4,255}$'),
  secret      text not null,
  events      text[] not null check (events <@ array['order.paid', 'appointment.created', 'tour.booked'] and cardinality(events) > 0),
  active      boolean not null default true,
  fail_count  integer not null default 0,
  created_at  timestamptz not null default now()
);
create table public.webhook_deliveries (
  id          uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.webhook_endpoints (id) on delete cascade,
  org_id      uuid not null references public.orgs (id) on delete cascade,
  event       text not null,
  payload     jsonb not null,
  status      text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  tries       integer not null default 0,
  next_try_at timestamptz not null default now(),
  last_status integer,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index webhook_deliveries_due_idx on public.webhook_deliveries (next_try_at) where status = 'queued';
alter table public.api_keys enable row level security;
alter table public.webhook_endpoints enable row level security;
alter table public.webhook_deliveries enable row level security;
create policy api_keys_read on public.api_keys for select to authenticated using (public.is_org_owner(org_id));
create policy webhook_deliveries_read on public.webhook_deliveries for select to authenticated using (public.is_org_owner(org_id));
revoke all on public.api_keys, public.webhook_endpoints, public.webhook_deliveries from anon, authenticated;
grant select (id, org_id, name, prefix, scopes, created_at, last_used_at, revoked_at) on public.api_keys to authenticated;
grant select (id, org_id, event, status, tries, last_status, created_at, sent_at, endpoint_id) on public.webhook_deliveries to authenticated;
-- an endpoint's list is read through a function (it holds the signing secret)

create or replace function public.create_api_key(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (p ->> 'org_id')::uuid; v_key text; v_scopes text[] := coalesce(array(select jsonb_array_elements_text(p -> 'scopes')), '{sales,menu}');
begin
  if not public.is_org_owner(v_org) then raise exception 'API keys are for the owner' using errcode = '42501'; end if;
  if not public.hub_enabled(v_org) then raise exception 'the integration hub is off' using errcode = '0A000'; end if;
  if (select count(*) from public.api_keys where org_id = v_org and revoked_at is null) >= 10 then raise exception 'at most 10 active keys' using errcode = '54000'; end if;
  v_key := 'bk_' || substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 48);
  insert into public.api_keys (org_id, name, key_hash, prefix, scopes)
  values (v_org, btrim(p ->> 'name'), encode(sha256(convert_to(v_key, 'utf8')), 'hex'), left(v_key, 7), v_scopes);
  perform public.audit_record(v_org, null, 'settings.change', 'api_keys', null, jsonb_build_object('created', true), 'db');
  return jsonb_build_object('key', v_key);   -- shown once; only its hash is kept
end $$;
create or replace function public.revoke_api_key(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare k public.api_keys%rowtype;
begin
  select * into k from public.api_keys where id = p_id;
  if not found or not public.is_org_owner(k.org_id) then raise exception 'API keys are for the owner' using errcode = '42501'; end if;
  update public.api_keys set revoked_at = now() where id = k.id and revoked_at is null;
  perform public.audit_record(k.org_id, null, 'settings.change', 'api_keys', k.id::text, jsonb_build_object('revoked', true), 'db');
end $$;

-- p = { org_id, url, events[] }   → { id, secret }  (the secret is shown once)
create or replace function public.save_webhook_endpoint(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (p ->> 'org_id')::uuid; v_id uuid; v_secret text := 'whsec_' || substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 48);
begin
  if not public.is_org_owner(v_org) then raise exception 'webhooks are for the owner' using errcode = '42501'; end if;
  if not public.hub_enabled(v_org) then raise exception 'the integration hub is off' using errcode = '0A000'; end if;
  if (select count(*) from public.webhook_endpoints where org_id = v_org) >= 5 then raise exception 'at most 5 webhook addresses' using errcode = '54000'; end if;
  insert into public.webhook_endpoints (org_id, url, secret, events)
  values (v_org, btrim(p ->> 'url'), v_secret, coalesce(array(select jsonb_array_elements_text(p -> 'events')), '{}')) returning id into v_id;
  perform public.audit_record(v_org, null, 'settings.change', 'webhook_endpoints', v_id::text, jsonb_build_object('created', true), 'db');
  return jsonb_build_object('id', v_id, 'secret', v_secret);
end $$;
create or replace function public.delete_webhook_endpoint(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.webhook_endpoints%rowtype;
begin
  select * into e from public.webhook_endpoints where id = p_id;
  if not found or not public.is_org_owner(e.org_id) then raise exception 'webhooks are for the owner' using errcode = '42501'; end if;
  delete from public.webhook_endpoints where id = e.id;
  perform public.audit_record(e.org_id, null, 'settings.change', 'webhook_endpoints', e.id::text, jsonb_build_object('deleted', true), 'db');
end $$;
create or replace function public.list_webhook_endpoints(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_org_owner(p_org) then raise exception 'webhooks are for the owner' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'url', e.url, 'events', e.events, 'active', e.active, 'fail_count', e.fail_count,
            'queued', (select count(*) from public.webhook_deliveries d where d.endpoint_id = e.id and d.status = 'queued'),
            'last_status', (select d.last_status from public.webhook_deliveries d where d.endpoint_id = e.id order by d.created_at desc limit 1)) order by e.created_at)
          from public.webhook_endpoints e where e.org_id = p_org), '[]'::jsonb);
end $$;

-- the one place that queues a delivery
create or replace function public.webhook_emit(p_org uuid, p_event text, p_payload jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.webhook_deliveries (endpoint_id, org_id, event, payload)
  select e.id, e.org_id, p_event, jsonb_build_object('event', p_event, 'id', gen_random_uuid(), 'created_at', now(), 'data', p_payload)
    from public.webhook_endpoints e where e.org_id = p_org and e.active and p_event = any (e.events);
exception when others then
  null;   -- a webhook problem must never undo the sale
end $$;
revoke all on function public.webhook_emit(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.webhook_on_order() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.receipts%rowtype;
begin
  if not exists (select 1 from public.webhook_endpoints e where e.org_id = new.org_id and e.active and 'order.paid' = any (e.events)) then return null; end if;
  select * into r from public.receipts where order_id = new.id;
  perform public.webhook_emit(new.org_id, 'order.paid', jsonb_build_object('order_id', new.id, 'number', new.number, 'store_id', new.store_id, 'channel', new.channel,
    'receipt_number', r.number, 'total', r.total, 'payable', r.payable, 'vat', r.vat, 'service_charge', r.service_charge));
  return null;
end $$;
create trigger orders_webhook_trg after update of status on public.orders for each row when (new.status = 'paid' and old.status is distinct from 'paid') execute function public.webhook_on_order();
create or replace function public.webhook_on_appointment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.webhook_emit(new.org_id, 'appointment.created', jsonb_build_object('appointment_id', new.id, 'store_id', new.store_id, 'starts_at', new.starts_at, 'service', new.service_name, 'source', new.source));
  return null;
end $$;
create trigger appointments_webhook_trg after insert on public.appointments for each row execute function public.webhook_on_appointment();
create or replace function public.webhook_on_tour() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.webhook_emit(new.org_id, 'tour.booked', jsonb_build_object('booking_id', new.id, 'slot_id', new.slot_id, 'store_id', new.store_id, 'seats', new.seats));
  return null;
end $$;
create trigger tour_bookings_webhook_trg after insert on public.tour_bookings for each row execute function public.webhook_on_tour();

-- the tick: due deliveries (5 tries: 1 min, 5 min, 30 min, 2 h), a failing address is switched off after 20 failed deliveries in a row
create or replace function public.webhook_claim(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  with due as (
    select d.id from public.webhook_deliveries d join public.webhook_endpoints e on e.id = d.endpoint_id and e.active
     where d.status = 'queued' and d.next_try_at <= now() order by d.next_try_at limit least(greatest(coalesce(p_limit, 20), 1), 50) for update of d skip locked),
  upd as (
    update public.webhook_deliveries d set tries = tries + 1, next_try_at = now() + case tries when 0 then interval '1 minute' when 1 then interval '5 minutes' when 2 then interval '30 minutes' else interval '2 hours' end
      from due where d.id = due.id returning d.*)
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'url', e.url, 'secret', e.secret, 'event', u.event, 'payload', u.payload)), '[]'::jsonb) into r
    from upd u join public.webhook_endpoints e on e.id = u.endpoint_id;
  return r;
end $$;
create or replace function public.webhook_report(p_id uuid, p_ok boolean, p_status integer) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.webhook_deliveries%rowtype;
begin
  select * into d from public.webhook_deliveries where id = p_id;
  if not found then return; end if;
  if p_ok then
    update public.webhook_deliveries set status = 'sent', sent_at = now(), last_status = p_status where id = d.id;
    update public.webhook_endpoints set fail_count = 0 where id = d.endpoint_id;
  else
    update public.webhook_deliveries set last_status = p_status, status = case when d.tries >= 5 then 'failed' else 'queued' end where id = d.id;
    if d.tries >= 5 then
      update public.webhook_endpoints set fail_count = fail_count + 1, active = (fail_count + 1) < 20 where id = d.endpoint_id;
    end if;
  end if;
end $$;
create or replace function public.webhook_cleanup() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.webhook_deliveries where created_at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.webhook_claim(integer), public.webhook_report(uuid, boolean, integer), public.webhook_cleanup() from public, anon, authenticated;
grant execute on function public.webhook_claim(integer), public.webhook_report(uuid, boolean, integer), public.webhook_cleanup() to service_role;
revoke all on function public.create_api_key(jsonb), public.revoke_api_key(uuid), public.save_webhook_endpoint(jsonb), public.delete_webhook_endpoint(uuid), public.list_webhook_endpoints(uuid) from public, anon;
grant execute on function public.create_api_key(jsonb), public.revoke_api_key(uuid), public.save_webhook_endpoint(jsonb), public.delete_webhook_endpoint(uuid), public.list_webhook_endpoints(uuid) to authenticated, service_role;

-- the public API reads through these (service role only; the handler has already checked the key)
create or replace function public.api_key_lookup(p_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k public.api_keys%rowtype;
begin
  select * into k from public.api_keys where key_hash = p_hash and revoked_at is null;
  if not found or not public.hub_enabled(k.org_id) then return null; end if;
  update public.api_keys set last_used_at = now() where id = k.id and (last_used_at is null or last_used_at < now() - interval '1 minute');
  return jsonb_build_object('org_id', k.org_id, 'scopes', to_jsonb(k.scopes));
end $$;
create or replace function public.api_sales(p_org uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then raise exception 'the range is at most 93 days' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('date', x.d, 'store_id', x.store_id, 'store', x.name, 'bills', x.bills, 'subtotal', x.subtotal, 'service_charge', x.sc, 'vat', x.vat, 'total', x.total) order by x.d, x.name)
    from (select o.business_date as d, o.store_id, s.name, count(*) as bills, sum(r.subtotal) as subtotal, sum(r.service_charge) as sc, sum(r.vat) as vat, sum(r.payable) as total
            from public.orders o join public.receipts r on r.order_id = o.id join public.stores s on s.id = o.store_id
           where o.org_id = p_org and o.status = 'paid' and o.business_date between p_from and p_to group by o.business_date, o.store_id, s.name) x), '[]'::jsonb);
end $$;
create or replace function public.api_menu(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'store_id', m.store_id, 'name', m.name, 'price', (m.prices ->> 'base')::bigint, 'available', m.available, 'barcode', m.barcode, 'sku', m.sku) order by m.store_id, m.sort), '[]'::jsonb)
    from public.menu_items m where m.org_id = p_org and m.deleted_at is null
$$;
revoke all on function public.api_key_lookup(text), public.api_sales(uuid, date, date), public.api_menu(uuid) from public, anon, authenticated;
grant execute on function public.api_key_lookup(text), public.api_sales(uuid, date, date), public.api_menu(uuid) to service_role;

-- the accountant's file: one row per receipt with the tax figures and how it was paid.  p = { org_id, store_id?, from, to }   (report.view)
create or replace function public.accounting_export(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (p ->> 'org_id')::uuid; v_store uuid := nullif(p ->> 'store_id', '')::uuid; v_from date := (p ->> 'from')::date; v_to date := (p ->> 'to')::date; v_rows jsonb;
begin
  if not public.has_permission(v_org, 'report.view') then raise exception 'the accounting export needs report.view' using errcode = '42501'; end if;
  if v_store is not null and not public.can_access_store(v_org, v_store) then raise exception 'no access to this shop' using errcode = '42501'; end if;
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 366 then raise exception 'the date range is not valid' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('date', o.business_date, 'receipt', r.number, 'store', s.name, 'branch', r.branch_code, 'seller_tax_id', r.seller_tax_id,
           'net_before_vat', r.net_before_vat, 'service_charge', r.service_charge, 'vat', r.vat, 'total', r.total, 'rounding', r.rounding, 'payable', r.payable,
           'cash', coalesce(pm.cash, 0), 'promptpay', coalesce(pm.promptpay, 0), 'gateway', coalesce(pm.gateway, 0), 'credit', coalesce(pm.credit, 0), 'points', coalesce(pm.points, 0), 'other', coalesce(pm.other, 0),
           'customer_tax_id', r.customer_tax_id) order by o.business_date, r.number), '[]'::jsonb) into v_rows
    from public.receipts r
    join public.orders o on o.id = r.order_id and o.status = 'paid'
    join public.stores s on s.id = r.store_id
    left join lateral (select sum(amount) filter (where tender = 'cash') as cash, sum(amount) filter (where tender = 'promptpay') as promptpay, sum(amount) filter (where tender = 'gateway') as gateway,
                              sum(amount) filter (where tender = 'credit') as credit, sum(amount) filter (where tender = 'points') as points,
                              sum(amount) filter (where tender not in ('cash', 'promptpay', 'gateway', 'credit', 'points')) as other
                         from public.payments py where py.order_id = o.id and py.status = 'confirmed') pm on true
   where r.org_id = v_org and (v_store is null or r.store_id = v_store) and public.can_access_store(r.org_id, r.store_id) and o.business_date between v_from and v_to;
  perform public.audit_record(v_org, v_store, 'export.report', 'accounting_export', null, jsonb_build_object('from', v_from, 'to', v_to), 'db');
  return v_rows;
end $$;
revoke all on function public.accounting_export(jsonb) from public, anon;
grant execute on function public.accounting_export(jsonb) to authenticated, service_role;
