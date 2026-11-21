-- Bestie POS · migration 63 · PHASE 3: the island network — Tourist Pass, network points with clearing, a shop marketplace.
--
-- A NETWORK groups independent businesses (organisations) of one island. An organisation joins with its owner's action (`join_network`).
--  * TOURIST PASS (`network_passes`): one pass per person per network (unique phone). The pass has an unguessable page token and a short
--    code the cashier scans / types (`BP-XXXXXXXXXX`). Registering needs only a name and a phone number.
--  * LINKS (`network_pass_links`): when a cashier of a member shop attaches a pass (`link_pass`), the shop's own member record for that phone
--    is found or created and linked to the pass. The member earns Points at that shop exactly as before (the shop's own ledger, the
--    shop's own rule, issued by the shop).
--  * NETWORK POINTS: the points a person can spend = the sum of the Points ledgers of all the member records linked to her pass
--    (`points_available`). `set_order_points` (a Points discount on a bill) now uses that balance, so points earned at one shop buy a
--    discount at another. The discount is the redeeming shop's own bill discount: bill maths, receipt and VAT treatment are unchanged.
--    Credit is NOT shared: it stays within one legal entity (CLAUDE.md rule 2).
--  * CLEARING (`network_clearing`): who owes whom for points earned at one business and spent at another. Not stored: recomputed from the
--    ledgers by replaying every earn and every paid redemption in time order; a redemption consumes the OLDEST earned points first (FIFO),
--    and the discount value of the paying bill is split by the points taken from each issuer. Only redemptions in the asked period count.
--    Each organisation sees only the lines in which it is issuer or redeemer.
--  * MARKETPLACE (`network_listings`): each member shop may list itself (category, title, description) on the public island page, with
--    its online booking link when that is switched on. No commission is taken.
-- Everything a guest does goes through service-role functions called by `/api/guest/pass` and `/api/guest/island`.
-- LEGAL: a points coalition between independent companies and the money settled between them need the lawyer's opinion before launch.

create table public.networks (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  name       jsonb not null check (jsonb_typeof(name) = 'object' and length(btrim(coalesce(name ->> 'th', ''))) between 1 and 80),
  about      jsonb check (about is null or jsonb_typeof(about) = 'object'),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.network_orgs (
  network_id uuid not null references public.networks (id) on delete cascade,
  org_id     uuid not null references public.orgs (id) on delete cascade,
  joined_at  timestamptz not null default now(),
  left_at    timestamptz,
  primary key (network_id, org_id)
);
create table public.network_listings (
  store_id   uuid primary key references public.stores (id) on delete cascade,
  network_id uuid not null references public.networks (id) on delete cascade,
  org_id     uuid not null references public.orgs (id) on delete cascade,
  category   text not null check (category in ('food', 'cafe', 'beauty', 'spa', 'stay', 'shop', 'tour', 'other')),
  title      jsonb not null check (jsonb_typeof(title) = 'object' and length(btrim(coalesce(title ->> 'th', ''))) between 1 and 80),
  about      jsonb check (about is null or (jsonb_typeof(about) = 'object' and length(coalesce(about ->> 'th', '')) <= 300 and length(coalesce(about ->> 'en', '')) <= 300)),
  visible    boolean not null default true,
  sort       integer not null default 0
);
create table public.network_passes (
  id         uuid primary key default gen_random_uuid(),
  network_id uuid not null references public.networks (id) on delete cascade,
  code       text not null unique check (code ~ '^BP-[A-HJ-NP-Z2-9]{10}$'),
  token      text not null unique check (token ~ '^[0-9a-f]{32}$'),
  name       text not null check (length(btrim(name)) between 1 and 80),
  phone      text not null check (phone ~ '^[0-9]{8,15}$'),
  created_at timestamptz not null default now(),
  unique (network_id, phone)
);
create table public.network_pass_links (
  pass_id     uuid not null references public.network_passes (id) on delete cascade,
  org_id      uuid not null references public.orgs (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  linked_at   timestamptz not null default now(),
  primary key (pass_id, org_id),
  unique (customer_id)
);
alter table public.networks enable row level security;
alter table public.network_orgs enable row level security;
alter table public.network_listings enable row level security;
alter table public.network_passes enable row level security;
alter table public.network_pass_links enable row level security;
create policy networks_read on public.networks for select to authenticated using (true);
create policy network_orgs_read on public.network_orgs for select to authenticated using (public.is_org_member(org_id) or public.is_platform_admin());
create policy network_listings_read on public.network_listings for select to authenticated using (public.is_org_member(org_id));
create policy network_pass_links_read on public.network_pass_links for select to authenticated using (public.has_permission(org_id, 'customer.view'));
revoke all on public.networks, public.network_orgs, public.network_listings, public.network_passes, public.network_pass_links from anon, authenticated;
grant select on public.networks, public.network_orgs, public.network_listings, public.network_pass_links to authenticated;   -- passes: functions only (they hold phones)

create or replace function public.in_network(p_network uuid, p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.network_orgs n where n.network_id = p_network and n.org_id = p_org and n.left_at is null)
$$;
revoke all on function public.in_network(uuid, uuid) from public, anon, authenticated;
grant execute on function public.in_network(uuid, uuid) to service_role;

-- a platform administrator makes a network
create or replace function public.create_network(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.is_platform_admin() then raise exception 'only the platform administrator makes a network' using errcode = '42501'; end if;
  insert into public.networks (slug, name, about) values (lower(btrim(p ->> 'slug')), p -> 'name', p -> 'about') returning id into v_id;
  return v_id;
end $$;

-- the owner of an organisation joins (or leaves) a network
create or replace function public.join_network(p_org uuid, p_slug text, p_join boolean default true) returns void
language plpgsql security definer set search_path = '' as $$
declare n public.networks%rowtype;
begin
  if not public.is_org_owner(p_org) then raise exception 'only the owner joins a network' using errcode = '42501'; end if;
  select * into n from public.networks where slug = lower(btrim(coalesce(p_slug, ''))) and active;
  if not found then raise exception 'unknown network' using errcode = '22023'; end if;
  if p_join then
    insert into public.network_orgs (network_id, org_id) values (n.id, p_org)
    on conflict (network_id, org_id) do update set left_at = null, joined_at = now();
  else
    update public.network_orgs set left_at = now() where network_id = n.id and org_id = p_org;
    update public.network_listings set visible = false where network_id = n.id and org_id = p_org;
  end if;
  perform public.audit_record(p_org, null, 'settings.change', 'network_orgs', n.id::text, jsonb_build_object('join', p_join), 'db');
end $$;

-- p = { store_id, category, title:{th,en?}, about?, visible?, sort? }
create or replace function public.save_network_listing(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_store uuid := (p ->> 'store_id')::uuid; s public.stores%rowtype; v_net uuid;
begin
  select * into s from public.stores where id = v_store and deleted_at is null;
  if not found or not public.can_edit_menu(v_store) then raise exception 'the listing needs menu.edit in this shop' using errcode = '42501'; end if;
  select n.network_id into v_net from public.network_orgs n where n.org_id = s.org_id and n.left_at is null order by n.joined_at limit 1;
  if v_net is null then raise exception 'join a network first' using errcode = '0A000'; end if;
  insert into public.network_listings (store_id, network_id, org_id, category, title, about, visible, sort)
  values (v_store, v_net, s.org_id, p ->> 'category', p -> 'title', p -> 'about', coalesce((p ->> 'visible')::boolean, true), coalesce((p ->> 'sort')::integer, 0))
  on conflict (store_id) do update set category = excluded.category, title = excluded.title, about = excluded.about, visible = excluded.visible, sort = excluded.sort;
end $$;

create or replace function public.pass_code() returns text
language plpgsql volatile set search_path = '' as $$
declare a text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; s text := ''; i int;
begin
  for i in 1..10 loop s := s || substr(a, 1 + floor(random() * 32)::int, 1); end loop;
  return 'BP-' || s;
end $$;

-- a tourist registers herself (service role; the API limits the rate)
create or replace function public.guest_pass_register(p_slug text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n public.networks%rowtype;
  v_name text := btrim(coalesce(p ->> 'name', ''));
  v_phone text := regexp_replace(coalesce(p ->> 'phone', ''), '[^0-9]', '', 'g');
  v_id uuid; v_code text; v_token text; i int := 0;
begin
  select * into n from public.networks where slug = lower(btrim(coalesce(p_slug, ''))) and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if length(v_name) not between 1 and 80 or v_phone !~ '^[0-9]{8,15}$' then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  if coalesce((p ->> 'consent')::boolean, false) is not true then return jsonb_build_object('ok', false, 'error', 'consent_needed'); end if;
  if exists (select 1 from public.network_passes where network_id = n.id and phone = v_phone) then
    return jsonb_build_object('ok', false, 'error', 'exists');   -- never hand out an existing pass: ask a shop
  end if;
  loop
    v_code := public.pass_code();
    v_token := replace(gen_random_uuid()::text, '-', '');
    begin
      insert into public.network_passes (network_id, code, token, name, phone) values (n.id, v_code, v_token, v_name, v_phone) returning id into v_id;
      exit;
    exception when unique_violation then
      i := i + 1; if i > 5 then raise; end if;
    end;
  end loop;
  return jsonb_build_object('ok', true, 'token', v_token, 'code', v_code);
end $$;

-- the shop's member record for this pass (find by phone or make), linked
create or replace function public.pass_member_for(p_pass uuid, p_org uuid, p_staff uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare ps public.network_passes%rowtype; v_c uuid; v_code text; i int := 0;
begin
  select customer_id into v_c from public.network_pass_links where pass_id = p_pass and org_id = p_org;
  if v_c is not null then return v_c; end if;
  select * into ps from public.network_passes where id = p_pass;
  select c.id into v_c from public.customers c where c.org_id = p_org and c.phone = ps.phone and c.deleted_at is null;
  if v_c is null then
    loop
      v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
      begin
        insert into public.customers (org_id, name, phone, member_code, consent, created_by) values (p_org, ps.name, ps.phone, v_code, false, p_staff) returning id into v_c;
        exit;
      exception when unique_violation then
        i := i + 1; if i > 5 then raise; end if;
      end;
    end loop;
  end if;
  insert into public.network_pass_links (pass_id, org_id, customer_id) values (p_pass, p_org, v_c)
  on conflict (pass_id, org_id) do nothing;
  return v_c;
end $$;
revoke all on function public.pass_member_for(uuid, uuid, uuid) from public, anon, authenticated;

-- a cashier attaches a pass by its code (scanned or typed): returns the shop's member record
create or replace function public.link_pass(p_store uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; ps public.network_passes%rowtype; v_staff uuid; v_c uuid; c public.customers%rowtype;
begin
  select * into s from public.stores where id = p_store and deleted_at is null;
  if not found or not public.can_access_store(s.org_id, s.id) or not public.has_permission(s.org_id, 'order.create') or not public.has_permission(s.org_id, 'customer.view') then
    raise exception 'attaching a pass needs order.create' using errcode = '42501';
  end if;
  -- the cashier scans the pass page's QR (its token) or types the printed code
  select * into ps from public.network_passes where code = upper(btrim(coalesce(p_code, ''))) or token = lower(btrim(coalesce(p_code, '')));
  if not found or not public.in_network(ps.network_id, s.org_id) then
    return jsonb_build_object('ok', false, 'error', 'unknown_pass');
  end if;
  select x.id into v_staff from public.staff x where x.org_id = s.org_id and x.user_id = auth.uid() and x.active limit 1;
  v_c := public.pass_member_for(ps.id, s.org_id, v_staff);
  select * into c from public.customers where id = v_c;
  return jsonb_build_object('ok', true, 'customer_id', c.id, 'name', c.name, 'member_code', c.member_code, 'points', public.points_available(c.id));
end $$;

-- a cashier issues a pass for a tourist at the counter (name + phone); an existing pass of that phone is returned to staff
create or replace function public.staff_issue_pass(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype; n uuid; r jsonb; ps public.network_passes%rowtype; v_staff uuid; v_c uuid;
  v_phone text := regexp_replace(coalesce(p ->> 'phone', ''), '[^0-9]', '', 'g');
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_access_store(s.org_id, s.id) or not public.has_permission(s.org_id, 'order.create') or not public.has_permission(s.org_id, 'customer.view') then
    raise exception 'issuing a pass needs order.create' using errcode = '42501';
  end if;
  select no.network_id into n from public.network_orgs no where no.org_id = s.org_id and no.left_at is null order by no.joined_at limit 1;
  if n is null then raise exception 'join a network first' using errcode = '0A000'; end if;
  select * into ps from public.network_passes where network_id = n and phone = v_phone;
  if not found then
    r := public.guest_pass_register((select slug from public.networks where id = n), p || jsonb_build_object('consent', true));
    if (r ->> 'ok') <> 'true' then raise exception 'the name or phone number is not valid' using errcode = '22023'; end if;
    select * into ps from public.network_passes where token = r ->> 'token';
  end if;
  select x.id into v_staff from public.staff x where x.org_id = s.org_id and x.user_id = auth.uid() and x.active limit 1;
  v_c := public.pass_member_for(ps.id, s.org_id, v_staff);
  return jsonb_build_object('token', ps.token, 'code', ps.code, 'name', ps.name, 'customer_id', v_c);
end $$;

-- the points a person can spend: all member records linked to her pass, else the one record
create or replace function public.points_available(p_customer uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(l.points), 0)::bigint from public.points_ledger l
   where l.customer_id = p_customer
      or l.customer_id in (select l2.customer_id from public.network_pass_links l1
                            join public.network_pass_links l2 on l2.pass_id = l1.pass_id where l1.customer_id = p_customer)
$$;
revoke all on function public.points_available(uuid) from public, anon, authenticated;
grant execute on function public.points_available(uuid) to service_role;

create or replace function public.points_balance(p_customer uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select case when exists (select 1 from public.customers c where c.id = p_customer and public.has_permission(c.org_id, 'customer.view'))
              then public.points_available(p_customer) else 0::bigint end
$$;
revoke all on function public.points_balance(uuid) from public, anon;
grant execute on function public.points_balance(uuid) to authenticated, service_role;

-- a Points discount uses the whole network balance
create or replace function public.set_order_points(p_order uuid, p_wanted integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o       public.orders%rowtype;
  v_rule  jsonb;
  v_step  bigint;
  v_bps   bigint;
  v_sub   bigint;
  v_cap   bigint;
  v_bal   bigint;
  v_held  bigint;
  v_used  bigint;
  v_staff uuid;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'order not found' using errcode = 'P0002'; end if;
  if not (public.has_permission(o.org_id, 'order.create') and public.has_permission(o.org_id, 'customer.view')
          and public.can_access_store(o.org_id, o.store_id)) then
    raise exception 'using points needs order.create' using errcode = '42501';
  end if;
  if o.status in ('paid', 'void') then raise exception 'order is already closed' using errcode = '23514'; end if;
  if o.customer_id is null then raise exception 'put a customer on the bill first' using errcode = '23514'; end if;
  if p_wanted is null or p_wanted < 0 or p_wanted > 10000000 then raise exception 'points must be 0 or more' using errcode = '22023'; end if;
  if not public.points_enabled(o.store_id) then raise exception 'Bestie Points are switched off in this shop' using errcode = '0A000'; end if;
  if exists (select 1 from public.payment_attempts a where a.order_id = o.id and a.status in ('created', 'pending')) then
    raise exception 'a payment on this bill is waiting' using errcode = '55006';
  end if;

  select points_rule into v_rule from public.orgs where id = o.org_id;
  v_step := coalesce(case when (v_rule ->> 'redeemSatangPerPoint') ~ '^[0-9]+$' then (v_rule ->> 'redeemSatangPerPoint')::bigint end, 100);
  if v_step < 1 or v_step > 10000 then v_step := 100; end if;
  v_bps := coalesce(case when (v_rule ->> 'maxRedeemBps') ~ '^[0-9]+$' then (v_rule ->> 'maxRedeemBps')::bigint end, 5000);
  if v_bps > 10000 then v_bps := 10000; end if;

  select coalesce(sum(l.unit_price::bigint * l.quantity), 0) into v_sub
    from public.order_lines l where l.order_id = o.id and l.status <> 'void';
  v_cap := (v_sub * v_bps / 10000) / v_step;                      -- most points the rule allows on this bill

  v_bal := public.points_available(o.customer_id);   -- the whole network balance when the member has a Tourist Pass
  v_held := o.points_used;
  v_used := least(p_wanted::bigint, v_cap, v_bal + v_held);        -- points already held count as available

  if v_used > v_held then
    insert into public.points_ledger (org_id, customer_id, store_id, kind, points, order_id, created_by)
    values (o.org_id, o.customer_id, o.store_id, 'redeem', -(v_used - v_held)::integer, o.id,
            (select s.id from public.staff s where s.org_id = o.org_id and s.user_id = auth.uid() and s.active limit 1));
  elsif v_used < v_held then
    insert into public.points_ledger (org_id, customer_id, store_id, kind, points, order_id, created_by)
    values (o.org_id, o.customer_id, o.store_id, 'reverse_redeem', (v_held - v_used)::integer, o.id,
            (select s.id from public.staff s where s.org_id = o.org_id and s.user_id = auth.uid() and s.active limit 1));
  end if;
  perform set_config('bestie.paying', 'on', true);
  update public.orders set points_used = v_used::integer, points_discount = v_used * v_step where id = o.id;
  perform set_config('bestie.paying', '', true);
  if v_used <> v_held then
    perform public.audit_record(o.org_id, o.store_id, 'points.redeem', 'orders', o.id::text,
      jsonb_build_object('points', v_used, 'discount', v_used * v_step), 'app');
  end if;
  return jsonb_build_object('points_used', v_used, 'discount', v_used * v_step, 'cap_points', v_cap, 'balance', v_bal + v_held - v_used);
end $$;
revoke all on function public.set_order_points(uuid, integer) from public, anon;
grant execute on function public.set_order_points(uuid, integer) to authenticated, service_role;

-- ── the guest's pass page ──
create or replace function public.guest_pass(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare ps public.network_passes%rowtype; n public.networks%rowtype; v_links uuid[]; v_points bigint; v_act jsonb;
begin
  select * into ps from public.network_passes where token = p_token;
  if not found then return null; end if;
  select * into n from public.networks where id = ps.network_id;
  select coalesce(array_agg(customer_id), '{}') into v_links from public.network_pass_links where pass_id = ps.id;
  select coalesce(sum(points), 0) into v_points from public.points_ledger where customer_id = any (v_links);
  select coalesce(jsonb_agg(x order by x ->> 'at' desc), '[]'::jsonb) into v_act from (
    select jsonb_build_object('kind', l.kind, 'points', l.points, 'at', l.created_at, 'shop', coalesce(s.name, o.name)) as x
      from public.points_ledger l join public.orgs o on o.id = l.org_id left join public.stores s on s.id = l.store_id
     where l.customer_id = any (v_links) and l.kind in ('earn', 'redeem', 'reverse_earn', 'reverse_redeem', 'adjust')
     order by l.created_at desc limit 15) q;
  return jsonb_build_object('name', ps.name, 'code', ps.code, 'network', jsonb_build_object('slug', n.slug, 'name', n.name),
                            'points', v_points, 'activity', v_act, 'shops', public.guest_island(n.slug) -> 'shops');
end $$;

-- the public island page: the listed shops, with the online booking link where there is one
create or replace function public.guest_island(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare n public.networks%rowtype;
begin
  select * into n from public.networks where slug = lower(btrim(coalesce(p_slug, ''))) and active;
  if not found then return null; end if;
  return jsonb_build_object('network', jsonb_build_object('slug', n.slug, 'name', n.name, 'about', n.about),
    'shops', coalesce((select jsonb_agg(jsonb_build_object('category', l.category, 'title', l.title, 'about', l.about,
              'booking_token', case when public.booking_online_enabled(l.store_id) then s.booking_token end) order by l.sort, l.title ->> 'th')
         from public.network_listings l join public.stores s on s.id = l.store_id
        where l.network_id = n.id and l.visible and public.in_network(n.id, l.org_id) and s.deleted_at is null), '[]'::jsonb));
end $$;

-- ── clearing: who owes whom for points earned at one business and spent at another ──
create or replace function public.network_clearing(p_org uuid, p_from date, p_to date) returns table (
  issuer_org uuid, issuer_name text, redeemer_org uuid, redeemer_name text, points bigint, amount bigint
) language plpgsql security definer set search_path = '' as $$
declare
  v_net uuid; ps record; ev record; q_org uuid[]; q_pts bigint[]; need bigint; take bigint; i int; k int;
begin
  if not public.has_permission(p_org, 'report.view') then raise exception 'the clearing statement needs report.view' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'the date range is not valid' using errcode = '22023'; end if;
  select n.network_id into v_net from public.network_orgs n where n.org_id = p_org and n.left_at is null order by n.joined_at limit 1;
  if v_net is null then return; end if;
  create temp table if not exists pg_temp.clr (i_org uuid, r_org uuid, pts bigint, amt numeric) on commit drop;
  delete from pg_temp.clr;
  for ps in select id from public.network_passes where network_id = v_net loop
    q_org := '{}'; q_pts := '{}';
    for ev in
      select * from (
        select l.created_at as ts, l.id::text as tie,
               case when l.kind = 'earn' or (l.kind = 'adjust' and l.points > 0) then 'in'
                    when l.kind in ('reverse_earn', 'expire') or (l.kind = 'adjust' and l.points < 0) then 'out' end as kind,
               l.org_id as org, abs(l.points)::bigint as pts, 0::bigint as discount, 0 as used
          from public.points_ledger l
         where l.customer_id in (select customer_id from public.network_pass_links where pass_id = ps.id)
           and l.kind in ('earn', 'reverse_earn', 'expire', 'adjust')
        union all
        select r.issued_at, o.id::text, 'redeem', o.org_id, o.points_used::bigint, o.points_discount, o.points_used
          from public.orders o join public.receipts r on r.order_id = o.id
         where o.status = 'paid' and o.points_used > 0
           and o.customer_id in (select customer_id from public.network_pass_links where pass_id = ps.id)
      ) x where x.kind is not null order by x.ts, x.tie
    loop
      if ev.kind = 'in' then
        q_org := q_org || ev.org; q_pts := q_pts || ev.pts;
      elsif ev.kind = 'out' then
        need := ev.pts;
        for k in 1 .. coalesce(array_length(q_pts, 1), 0) loop
          exit when need <= 0;
          if q_org[k] = ev.org and q_pts[k] > 0 then
            take := least(q_pts[k], need); q_pts[k] := q_pts[k] - take; need := need - take;
          end if;
        end loop;
      else
        need := ev.pts;
        for k in 1 .. coalesce(array_length(q_pts, 1), 0) loop
          exit when need <= 0;
          if q_pts[k] > 0 then
            take := least(q_pts[k], need);
            if q_org[k] <> ev.org and (ev.ts at time zone 'Asia/Bangkok')::date between p_from and p_to then
              insert into pg_temp.clr values (q_org[k], ev.org, take, take * ev.discount::numeric / ev.used);
            end if;
            q_pts[k] := q_pts[k] - take; need := need - take;
          end if;
        end loop;
      end if;
    end loop;
  end loop;
  return query
    select c.i_org, (select o.name from public.orgs o where o.id = c.i_org), c.r_org, (select o.name from public.orgs o where o.id = c.r_org),
           sum(c.pts)::bigint, round(sum(c.amt))::bigint
      from pg_temp.clr c where c.i_org = p_org or c.r_org = p_org
     group by c.i_org, c.r_org order by 2, 4;
end $$;

revoke all on function public.create_network(jsonb), public.join_network(uuid, text, boolean), public.save_network_listing(jsonb),
  public.link_pass(uuid, text), public.staff_issue_pass(jsonb), public.network_clearing(uuid, date, date) from public, anon;
grant execute on function public.create_network(jsonb), public.join_network(uuid, text, boolean), public.save_network_listing(jsonb),
  public.link_pass(uuid, text), public.staff_issue_pass(jsonb), public.network_clearing(uuid, date, date) to authenticated, service_role;
revoke all on function public.guest_pass_register(text, jsonb), public.guest_pass(text), public.guest_island(text), public.pass_code() from public, anon, authenticated;
grant execute on function public.guest_pass_register(text, jsonb), public.guest_pass(text), public.guest_island(text), public.pass_code() to service_role;
