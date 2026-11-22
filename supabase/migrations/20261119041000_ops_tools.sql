-- Bestie POS · migration 86 · OPERATIONS TOOLS (owner order, set D of 22 Nov 2026): points overview, waitlist + table turnover, staff time clock and schedule,
-- manager-approved discounts, e-receipts, owner data export. Money is integer satang; every write is a function that checks the person's right.

-- ══ 0 · POINTS OVERVIEW (the "Points" page of the owner / manager) ═══════════════════════════════════
-- p_org → { rule, outstanding, earned_30d, redeemed_30d, members, top[{customer_id,name,balance}], recent[{kind,points,at,name}] }   (customer.view)
create or replace function public.points_overview(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_permission(p_org, 'customer.view') then raise exception 'the points overview needs customer.view' using errcode = '42501'; end if;
  return jsonb_build_object(
    'rule', (select o.points_rule from public.orgs o where o.id = p_org),
    'outstanding', coalesce((select sum(l.points) from public.points_ledger l where l.org_id = p_org), 0),
    'earned_30d', coalesce((select sum(l.points) from public.points_ledger l where l.org_id = p_org and l.points > 0 and l.created_at > now() - interval '30 days'), 0),
    'redeemed_30d', coalesce((select -sum(l.points) from public.points_ledger l where l.org_id = p_org and l.points < 0 and l.created_at > now() - interval '30 days'), 0),
    'members', (select count(*) from (select l.customer_id from public.points_ledger l where l.org_id = p_org group by l.customer_id having sum(l.points) > 0) x),
    'top', coalesce((select jsonb_agg(jsonb_build_object('customer_id', t.id, 'name', t.name, 'balance', t.bal) order by t.bal desc)
                       from (select c.id, c.name, sum(l.points) as bal from public.points_ledger l join public.customers c on c.id = l.customer_id
                              where l.org_id = p_org group by c.id, c.name having sum(l.points) > 0 order by sum(l.points) desc limit 10) t), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('kind', r.kind, 'points', r.points, 'at', r.created_at, 'name', r.name) order by r.created_at desc)
                          from (select l.kind, l.points, l.created_at, c.name from public.points_ledger l join public.customers c on c.id = l.customer_id
                                 where l.org_id = p_org order by l.created_at desc limit 15) r), '[]'::jsonb));
end $$;
revoke all on function public.points_overview(uuid) from public, anon;
grant execute on function public.points_overview(uuid) to authenticated, service_role;

-- ══ modules: waitlist, time clock ═══════════════════════════════════════════════════════════════════
do $$
declare r record; src text; dst text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'stores_check_modules' loop
    src := pg_get_functiondef(r.oid);
    dst := replace(src, $a$'integration.hub','stamps'];$a$, $a$'integration.hub','stamps','waitlist','timeclock'];$a$);
    if dst = src then raise exception 'migration 86: stores_check_modules not changed'; end if;
    execute dst;
  end loop;
end $$;
create or replace function public.waitlist_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stores s where s.id = p_store and s.deleted_at is null
                    and coalesce((s.module_overrides ->> 'waitlist')::boolean, s.profile in ('restaurant', 'cafe')))
$$;
create or replace function public.timeclock_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stores s where s.id = p_store and s.deleted_at is null
                    and coalesce((s.module_overrides ->> 'timeclock')::boolean, false))
$$;
revoke all on function public.waitlist_enabled(uuid), public.timeclock_enabled(uuid) from public, anon;
grant execute on function public.waitlist_enabled(uuid), public.timeclock_enabled(uuid) to authenticated, service_role;

-- ══ 1 · WAITLIST AND TABLE TURNOVER ═════════════════════════════════════════════════════════════════
create table public.waitlist_entries (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 60),
  phone      text check (phone is null or phone ~ '^[0-9]{8,15}$'),
  party      integer not null check (party between 1 and 50),
  status     text not null default 'waiting' check (status in ('waiting', 'called', 'seated', 'left')),
  quoted_min integer not null default 0 check (quoted_min between 0 and 240),
  note       text check (note is null or length(note) <= 100),
  client_id  uuid unique,
  table_id   uuid references public.dining_tables (id),
  created_by uuid references public.staff (id),
  created_at timestamptz not null default now(),
  called_at  timestamptz,
  seated_at  timestamptz
);
create index waitlist_store_idx on public.waitlist_entries (store_id, status, created_at);
alter table public.waitlist_entries enable row level security;
create policy waitlist_read on public.waitlist_entries for select to authenticated using (public.can_access_store(org_id, store_id) and public.has_permission(org_id, 'order.create'));
revoke all on public.waitlist_entries from anon, authenticated;
grant select on public.waitlist_entries to authenticated;
create trigger waitlist_live after insert or update on public.waitlist_entries for each row execute function public.live_ping_row('store:{store_id}');

-- the wait to quote a party of this size: how long a table has really been occupied lately (dine-in, 28 days, 10–240 min), times the parties ahead, over the tables that fit
create or replace function public.waitlist_quote(p_store uuid, p_party integer) returns integer
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype; v_turn numeric; v_tables integer; v_ahead integer;
begin
  select * into s from public.stores where id = p_store and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'order.create')) then
    raise exception 'the waitlist needs order.create in this shop' using errcode = '42501';
  end if;
  select coalesce(avg(extract(epoch from (r.issued_at - o.created_at)) / 60), 45) into v_turn
    from public.orders o join public.receipts r on r.order_id = o.id
   where o.store_id = s.id and o.channel = 'dine-in' and o.table_id is not null and r.issued_at > now() - interval '28 days'
     and r.issued_at - o.created_at between interval '10 minutes' and interval '240 minutes';
  select count(*) into v_tables from public.dining_tables t where t.store_id = s.id and t.active and t.deleted_at is null and t.seats >= greatest(coalesce(p_party, 1), 1);
  if v_tables = 0 then select count(*) into v_tables from public.dining_tables t where t.store_id = s.id and t.active and t.deleted_at is null; end if;
  select count(*) into v_ahead from public.waitlist_entries w where w.store_id = s.id and w.status in ('waiting', 'called');
  return least(180, greatest(0, (ceil(v_turn * (v_ahead + 1) / greatest(v_tables, 1) / 5) * 5)::integer));
end $$;

-- p = { store_id, name, phone?, party, note?, client_id }   (order.create)
create or replace function public.waitlist_add(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; w public.waitlist_entries%rowtype; v_client uuid := nullif(p ->> 'client_id', '')::uuid; v_party integer := (p ->> 'party')::integer; v_q integer; v_staff uuid; v_pos integer;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'order.create')) then
    raise exception 'the waitlist needs order.create in this shop' using errcode = '42501';
  end if;
  if not public.waitlist_enabled(s.id) then raise exception 'the waitlist module is off in this shop' using errcode = '0A000'; end if;
  if v_client is not null then
    select * into w from public.waitlist_entries where client_id = v_client;
    if found then return jsonb_build_object('id', w.id, 'quoted_min', w.quoted_min, 'replay', true); end if;
  end if;
  v_q := public.waitlist_quote(s.id, v_party);
  select f.id into v_staff from public.staff f where f.org_id = s.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.waitlist_entries (org_id, store_id, name, phone, party, quoted_min, note, client_id, created_by)
  values (s.org_id, s.id, btrim(p ->> 'name'), nullif(regexp_replace(coalesce(p ->> 'phone', ''), '[^0-9]', '', 'g'), ''), v_party, v_q,
          left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 100), v_client, v_staff) returning * into w;
  select count(*) into v_pos from public.waitlist_entries x where x.store_id = s.id and x.status in ('waiting', 'called');
  return jsonb_build_object('id', w.id, 'quoted_min', v_q, 'position', v_pos);
end $$;

-- waiting → called → seated | left (also waiting → seated | left)   p_table is the table she was given
create or replace function public.waitlist_set(p_id uuid, p_status text, p_table uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare w public.waitlist_entries%rowtype;
begin
  select * into w from public.waitlist_entries where id = p_id for update;
  if not found or not (public.can_access_store(w.org_id, w.store_id) and public.has_permission(w.org_id, 'order.create')) then
    raise exception 'the waitlist needs order.create in this shop' using errcode = '42501';
  end if;
  if not ((w.status = 'waiting' and p_status in ('called', 'seated', 'left')) or (w.status = 'called' and p_status in ('seated', 'left'))) then
    raise exception 'this change is not allowed' using errcode = '55000';
  end if;
  if p_table is not null and not exists (select 1 from public.dining_tables t where t.id = p_table and t.store_id = w.store_id and t.deleted_at is null) then
    raise exception 'unknown table' using errcode = '22023';
  end if;
  update public.waitlist_entries set status = p_status,
         called_at = case when p_status = 'called' then now() else called_at end,
         seated_at = case when p_status = 'seated' then now() else seated_at end,
         table_id = case when p_status = 'seated' then p_table else table_id end
   where id = w.id;
end $$;

-- how the tables are used: p = { store_id, from, to } → per table bills, average minutes a bill stays open, takings and takings per hour of use   (report.view)
create or replace function public.table_turnover(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype; v_from date := (p ->> 'from')::date; v_to date := (p ->> 'to')::date;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'report.view')) then
    raise exception 'the table report needs report.view in this shop' using errcode = '42501';
  end if;
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 92 then raise exception 'bad range' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('table_id', x.id, 'name', x.name, 'seats', x.seats, 'bills', x.bills, 'avg_min', x.avg_min, 'revenue', x.revenue,
             'per_hour', case when x.mins > 0 then round(x.revenue * 60.0 / x.mins) else 0 end) order by x.revenue desc)
      from (select t.id, t.name, t.seats, count(*) as bills, round(avg(extract(epoch from (r.issued_at - o.created_at)) / 60)) as avg_min,
                   sum(r.payable) as revenue, sum(extract(epoch from (r.issued_at - o.created_at)) / 60) as mins
              from public.orders o join public.receipts r on r.order_id = o.id join public.dining_tables t on t.id = o.table_id
             where o.store_id = s.id and o.status = 'paid' and o.business_date between v_from and v_to
               and r.issued_at - o.created_at between interval '5 minutes' and interval '300 minutes'
             group by t.id, t.name, t.seats) x), '[]'::jsonb);
end $$;
revoke all on function public.waitlist_quote(uuid, integer), public.waitlist_add(jsonb), public.waitlist_set(uuid, text, uuid), public.table_turnover(jsonb) from public, anon;
grant execute on function public.waitlist_quote(uuid, integer), public.waitlist_add(jsonb), public.waitlist_set(uuid, text, uuid), public.table_turnover(jsonb) to authenticated, service_role;

-- ══ 2 · STAFF TIME CLOCK AND SCHEDULE ═══════════════════════════════════════════════════════════════
create table public.time_entries (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  staff_id   uuid not null references public.staff (id) on delete cascade,
  clock_in   timestamptz not null default now(),
  clock_out  timestamptz,
  source     text not null default 'clock' check (source in ('clock', 'manager', 'auto')),
  note       text check (note is null or length(note) <= 100),
  created_at timestamptz not null default now(),
  check (clock_out is null or clock_out > clock_in)
);
create unique index time_entries_open_uidx on public.time_entries (staff_id) where clock_out is null;
create index time_entries_store_idx on public.time_entries (store_id, clock_in);
create table public.staff_schedule (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  staff_id   uuid not null references public.staff (id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  note       text check (note is null or length(note) <= 100),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at and ends_at - starts_at <= interval '16 hours')
);
create index staff_schedule_store_idx on public.staff_schedule (store_id, starts_at);
alter table public.time_entries enable row level security;
alter table public.staff_schedule enable row level security;
create policy time_entries_read on public.time_entries for select to authenticated using (public.can_access_store(org_id, store_id) and (public.has_permission(org_id, 'staff.manage') or staff_id in (select s.id from public.staff s where s.user_id = auth.uid())));
create policy staff_schedule_read on public.staff_schedule for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.time_entries, public.staff_schedule from anon, authenticated;
grant select on public.time_entries, public.staff_schedule to authenticated;
create trigger time_entries_live after insert or update on public.time_entries for each row execute function public.live_ping_row('store:{store_id}');

-- p = { store_id, staff_id }  → clocks the person in, or out when she is in.  A shop tablet (order.create) does it for whoever unlocked it with their PIN.
create or replace function public.clock_toggle(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; f public.staff%rowtype; e public.time_entries%rowtype;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'order.create')) then
    raise exception 'the time clock needs order.create in this shop' using errcode = '42501';
  end if;
  if not public.timeclock_enabled(s.id) then raise exception 'the time clock module is off in this shop' using errcode = '0A000'; end if;
  select * into f from public.staff where id = (p ->> 'staff_id')::uuid and org_id = s.org_id and active;
  if not found then raise exception 'unknown staff member' using errcode = '22023'; end if;
  select * into e from public.time_entries where staff_id = f.id and clock_out is null for update;
  if found then
    update public.time_entries set clock_out = now() where id = e.id;
    return jsonb_build_object('state', 'out', 'at', now(), 'since', e.clock_in);
  end if;
  insert into public.time_entries (org_id, store_id, staff_id) values (s.org_id, s.id, f.id);
  return jsonb_build_object('state', 'in', 'at', now());
end $$;

-- who is in now: p = { store_id } → [{ staff_id, name, since }]   (order.create)
create or replace function public.time_status(p_store uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype;
begin
  select * into s from public.stores where id = p_store and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'order.create')) then
    raise exception 'the time clock needs order.create in this shop' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('staff_id', e.staff_id, 'name', f.display_name, 'since', e.clock_in) order by e.clock_in)
                     from public.time_entries e join public.staff f on f.id = e.staff_id where e.store_id = s.id and e.clock_out is null), '[]'::jsonb);
end $$;

-- a manager corrects or adds an entry.  p = { id?, store_id, staff_id, clock_in, clock_out?, note? }   (staff.manage)
create or replace function public.save_time_entry(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; v_id uuid := nullif(p ->> 'id', '')::uuid; v_out timestamptz := nullif(p ->> 'clock_out', '')::timestamptz;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'staff.manage')) then
    raise exception 'time entries need staff.manage in this shop' using errcode = '42501';
  end if;
  if not exists (select 1 from public.staff f where f.id = (p ->> 'staff_id')::uuid and f.org_id = s.org_id) then raise exception 'unknown staff member' using errcode = '22023'; end if;
  if v_id is null then
    insert into public.time_entries (org_id, store_id, staff_id, clock_in, clock_out, source, note)
    values (s.org_id, s.id, (p ->> 'staff_id')::uuid, (p ->> 'clock_in')::timestamptz, v_out, 'manager', left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 100)) returning id into v_id;
  else
    update public.time_entries set clock_in = (p ->> 'clock_in')::timestamptz, clock_out = v_out, source = 'manager', note = left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 100)
     where id = v_id and store_id = s.id;
    if not found then raise exception 'unknown entry' using errcode = '22023'; end if;
  end if;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'time_entries', v_id::text, '{}'::jsonb, 'db');
  return v_id;
end $$;

create or replace function public.save_planned_shift(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'staff.manage')) then
    raise exception 'the schedule needs staff.manage in this shop' using errcode = '42501';
  end if;
  if not exists (select 1 from public.staff f where f.id = (p ->> 'staff_id')::uuid and f.org_id = s.org_id and f.active) then raise exception 'unknown staff member' using errcode = '22023'; end if;
  if v_id is null then
    insert into public.staff_schedule (org_id, store_id, staff_id, starts_at, ends_at, note)
    values (s.org_id, s.id, (p ->> 'staff_id')::uuid, (p ->> 'starts_at')::timestamptz, (p ->> 'ends_at')::timestamptz, left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 100)) returning id into v_id;
  else
    update public.staff_schedule set staff_id = (p ->> 'staff_id')::uuid, starts_at = (p ->> 'starts_at')::timestamptz, ends_at = (p ->> 'ends_at')::timestamptz, note = left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 100)
     where id = v_id and store_id = s.id;
    if not found then raise exception 'unknown shift' using errcode = '22023'; end if;
  end if;
  return v_id;
end $$;
create or replace function public.delete_planned_shift(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.staff_schedule%rowtype;
begin
  select * into r from public.staff_schedule where id = p_id;
  if not found or not (public.can_access_store(r.org_id, r.store_id) and public.has_permission(r.org_id, 'staff.manage')) then raise exception 'the schedule needs staff.manage in this shop' using errcode = '42501'; end if;
  delete from public.staff_schedule where id = r.id;
end $$;

-- hours per person for a period (by the Bangkok day the shift began; an open entry counts until now):  p = { store_id, from, to }   (staff.manage)
create or replace function public.timesheet(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype; v_from date := (p ->> 'from')::date; v_to date := (p ->> 'to')::date;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'staff.manage')) then
    raise exception 'the timesheet needs staff.manage in this shop' using errcode = '42501';
  end if;
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 92 then raise exception 'bad range' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('staff_id', f.id, 'name', f.display_name, 'worked_min', coalesce(w.mins, 0), 'days', coalesce(w.days, 0), 'planned_min', coalesce(pl.mins, 0)) order by f.display_name)
      from public.staff f
      left join (select e.staff_id, round(sum(extract(epoch from (coalesce(e.clock_out, now()) - e.clock_in)) / 60))::integer as mins, count(distinct (e.clock_in at time zone 'Asia/Bangkok')::date) as days
                   from public.time_entries e where e.store_id = s.id and (e.clock_in at time zone 'Asia/Bangkok')::date between v_from and v_to group by e.staff_id) w on w.staff_id = f.id
      left join (select x.staff_id, round(sum(extract(epoch from (x.ends_at - x.starts_at)) / 60))::integer as mins
                   from public.staff_schedule x where x.store_id = s.id and (x.starts_at at time zone 'Asia/Bangkok')::date between v_from and v_to group by x.staff_id) pl on pl.staff_id = f.id
     where f.org_id = s.org_id and f.active and (w.mins is not null or pl.mins is not null)), '[]'::jsonb);
end $$;

-- somebody forgot to clock out: an entry open for 16 hours is closed at 16 hours and marked automatic (the tick calls this)
create or replace function public.timeclock_autoclose() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.time_entries set clock_out = clock_in + interval '16 hours', source = 'auto', note = 'closed automatically' where clock_out is null and clock_in < now() - interval '16 hours';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.timeclock_autoclose() from public, anon, authenticated;
grant execute on function public.timeclock_autoclose() to service_role;
revoke all on function public.clock_toggle(jsonb), public.time_status(uuid), public.save_time_entry(jsonb), public.save_planned_shift(jsonb), public.delete_planned_shift(uuid), public.timesheet(jsonb) from public, anon;
grant execute on function public.clock_toggle(jsonb), public.time_status(uuid), public.save_time_entry(jsonb), public.save_planned_shift(jsonb), public.delete_planned_shift(uuid), public.timesheet(jsonb) to authenticated, service_role;

-- ══ 3 · DISCOUNT WITH A MANAGER'S PIN ═══════════════════════════════════════════════════════════════
-- A cashier asks, a manager types their PIN; the prices of the bill's lines (sent ones too) come down in proportion.  Every closing path already reads those prices,
-- so receipts, VAT, split tender, Points and returns all see the discounted bill.  p = { order_id, kind: percent | amount, value (percent: basis points; amount: satang), reason, manager_id, manager_pin }
create or replace function public.discount_with_manager(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders%rowtype; m public.staff%rowtype; l record; v_ok boolean; v_check text; v_reason text := left(btrim(coalesce(p ->> 'reason', '')), 100);
  v_kind text := p ->> 'kind'; v_val bigint := (p ->> 'value')::bigint; v_total bigint; v_disc bigint; v_cut integer; v_applied bigint := 0;
begin
  select * into o from public.orders where id = (p ->> 'order_id')::uuid for update;
  if not found or not (public.can_access_store(o.org_id, o.store_id) and public.has_permission(o.org_id, 'order.create')) then
    raise exception 'changing a bill needs order.create' using errcode = '42501';
  end if;
  if o.status in ('paid', 'void') then raise exception 'order is already closed' using errcode = '23514'; end if;
  if public.order_locking_held(o.id) > 0 or exists (select 1 from public.payment_attempts a where a.order_id = o.id and a.status in ('created', 'pending')) then
    raise exception 'the bill is waiting for a payment' using errcode = '55006';
  end if;
  if length(v_reason) = 0 then raise exception 'a reason is required' using errcode = '22023'; end if;
  if v_kind not in ('percent', 'amount') or v_val is null or v_val < 1 or (v_kind = 'percent' and v_val > 10000) then raise exception 'bad discount' using errcode = '22023'; end if;
  select * into m from public.staff s where s.id = (p ->> 'manager_id')::uuid and s.org_id = o.org_id and s.active;
  if not found then raise exception 'approver not found' using errcode = '28000'; end if;
  select exists (select 1 from public.roles r where r.id = m.role_id and (r.built_in = 'owner' or 'order.discount' = any (r.permissions))) into v_ok;
  if not v_ok then raise exception 'that person cannot approve a discount' using errcode = '28000'; end if;
  v_check := public.verify_staff_pin(m.id, coalesce(p ->> 'manager_pin', ''));
  if v_check <> 'ok' then return jsonb_build_object('ok', false); end if;   -- an answer, not an exception: the wrong-PIN counter must survive
  select coalesce(sum(unit_price::bigint * quantity), 0) into v_total from public.order_lines where order_id = o.id and status <> 'void';
  if v_total = 0 then raise exception 'the bill is empty' using errcode = '55000'; end if;
  v_disc := least(case when v_kind = 'percent' then v_total * v_val / 10000 else v_val end, v_total);
  perform set_config('bestie.paying', 'on', true);   -- the one door through which sent lines may change price
  for l in select id, unit_price, quantity from public.order_lines where order_id = o.id and status <> 'void' loop
    v_cut := least(l.unit_price, floor(l.unit_price::numeric * v_disc / v_total)::integer);
    continue when v_cut <= 0;
    update public.order_lines set list_price = coalesce(list_price, unit_price), unit_price = unit_price - v_cut where id = l.id;
    v_applied := v_applied + v_cut::bigint * l.quantity;
  end loop;
  perform set_config('bestie.paying', '', true);
  perform public.audit_record(o.org_id, o.store_id, 'order.discount', 'orders', o.id::text,
    jsonb_build_object('kind', v_kind, 'value', v_val, 'applied', v_applied, 'reason', v_reason, 'approved_by', m.id), 'db');
  return jsonb_build_object('ok', true, 'applied', v_applied, 'total_before', v_total);
end $$;
revoke all on function public.discount_with_manager(jsonb) from public, anon;
grant execute on function public.discount_with_manager(jsonb) to authenticated, service_role;
-- who may approve (managers with a PIN), for the screen's list
create or replace function public.discount_approvers(p_store uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype;
begin
  select * into s from public.stores where id = p_store and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'order.create')) then raise exception 'needs order.create' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.display_name) order by f.display_name)
                     from public.staff f join public.roles r on r.id = f.role_id
                    where f.org_id = s.org_id and f.active and (r.built_in = 'owner' or 'order.discount' = any (r.permissions))
                      and exists (select 1 from public.staff_pins sp where sp.staff_id = f.id)), '[]'::jsonb);
end $$;
revoke all on function public.discount_approvers(uuid) from public, anon;
grant execute on function public.discount_approvers(uuid) to authenticated, service_role;

-- ══ 4 · E-RECEIPT ═══════════════════════════════════════════════════════════════════════════════════
-- What the server needs to send a receipt by e-mail or LINE.  Nothing about the buyer is stored: an e-mail address is typed, used once, forgotten.
create or replace function public.receipt_send_data(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.orders%rowtype; r public.receipts%rowtype;
begin
  select * into o from public.orders where id = p_order;
  if not found or not (public.can_access_store(o.org_id, o.store_id) and public.has_permission(o.org_id, 'order.create')) then
    raise exception 'sending a receipt needs order.create in this shop' using errcode = '42501';
  end if;
  select * into r from public.receipts where order_id = o.id;
  if not found then return null; end if;
  return jsonb_build_object(
    'receipt', jsonb_build_object('number', r.number, 'issued_at', r.issued_at, 'seller_name', r.seller_name, 'seller_tax_id', r.seller_tax_id, 'branch', r.branch_code,
       'pos_id', r.pos_id, 'vat_registered', r.vat_registered, 'subtotal', r.subtotal, 'service_charge', r.service_charge, 'vat', r.vat, 'total', r.total, 'rounding', r.rounding, 'payable', r.payable, 'lang', r.lang),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('name', l.name, 'qty', l.quantity, 'unit_price', l.unit_price) order by l.created_at) from public.order_lines l where l.order_id = o.id and l.status <> 'void'), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('tender', y.tender, 'amount', y.amount)) from public.payments y where y.order_id = o.id and y.status = 'confirmed'), '[]'::jsonb),
    'member_line', exists (select 1 from public.customer_contacts k where k.customer_id = o.customer_id and k.line_user_id is not null and k.line_stopped_at is null));
end $$;
-- the member's LINE address (service role only; used once by the send handler after the person was checked)
create or replace function public.receipt_line_target(p_order uuid) returns text
language sql stable security definer set search_path = '' as $$
  select k.line_user_id from public.orders o join public.customer_contacts k on k.customer_id = o.customer_id
   where o.id = p_order and k.line_user_id is not null and k.line_stopped_at is null
$$;
revoke all on function public.receipt_send_data(uuid) from public, anon;
grant execute on function public.receipt_send_data(uuid) to authenticated, service_role;
revoke all on function public.receipt_line_target(uuid) from public, anon, authenticated;
grant execute on function public.receipt_line_target(uuid) to service_role;

-- ══ 5 · OWNER DATA EXPORT ═══════════════════════════════════════════════════════════════════════════
-- p = { org_id, dataset: customers | menu | orders | stock | staff | points }  → an array of flat objects (the screen turns it into CSV / JSON).  Owner only, 50,000 rows at most.
create or replace function public.export_data(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (p ->> 'org_id')::uuid; v_set text := p ->> 'dataset'; r jsonb;
begin
  if not public.is_org_owner(v_org) then raise exception 'exporting data is for the owner' using errcode = '42501'; end if;
  if v_set = 'customers' then
    select coalesce(jsonb_agg(jsonb_build_object('member_code', c.member_code, 'name', c.name, 'phone', c.phone, 'agreed_to_offers', c.consent, 'created_at', c.created_at) order by c.created_at), '[]'::jsonb) into r
      from (select * from public.customers where org_id = v_org and deleted_at is null order by created_at limit 50000) c;
  elsif v_set = 'menu' then
    select coalesce(jsonb_agg(jsonb_build_object('shop', s.name, 'name_th', m.name ->> 'th', 'name_en', m.name ->> 'en', 'price_satang', (m.prices ->> 'base')::bigint, 'available', m.available, 'barcode', m.barcode, 'sku', m.sku) order by s.name, m.sort), '[]'::jsonb) into r
      from (select * from public.menu_items where org_id = v_org and deleted_at is null limit 50000) m join public.stores s on s.id = m.store_id;
  elsif v_set = 'orders' then
    select coalesce(jsonb_agg(jsonb_build_object('date', o.business_date, 'shop', s.name, 'number', o.number, 'channel', o.channel, 'status', o.status, 'receipt', rc.number, 'payable_satang', rc.payable) order by o.business_date, o.number), '[]'::jsonb) into r
      from (select * from public.orders where org_id = v_org order by business_date desc limit 50000) o join public.stores s on s.id = o.store_id left join public.receipts rc on rc.order_id = o.id;
  elsif v_set = 'stock' then
    select coalesce(jsonb_agg(jsonb_build_object('shop', s.name, 'name_th', i.name ->> 'th', 'name_en', i.name ->> 'en', 'unit', i.unit, 'quantity', i.quantity, 'cost_per_1000_satang', i.cost_per_1000) order by s.name, i.name ->> 'th'), '[]'::jsonb) into r
      from (select * from public.stock_items where org_id = v_org limit 50000) i join public.stores s on s.id = i.store_id;
  elsif v_set = 'staff' then
    select coalesce(jsonb_agg(jsonb_build_object('name', f.display_name, 'role', coalesce(ro.built_in, ro.name), 'active', f.active) order by f.display_name), '[]'::jsonb) into r
      from public.staff f join public.roles ro on ro.id = f.role_id where f.org_id = v_org;   -- never a PIN or a password
  elsif v_set = 'points' then
    select coalesce(jsonb_agg(jsonb_build_object('member_code', c.member_code, 'name', c.name, 'points', x.bal) order by x.bal desc), '[]'::jsonb) into r
      from (select customer_id, sum(points) as bal from public.points_ledger where org_id = v_org group by customer_id having sum(points) <> 0 limit 50000) x join public.customers c on c.id = x.customer_id;
  else
    raise exception 'unknown dataset' using errcode = '22023';
  end if;
  perform public.audit_record(v_org, null, 'export.report', 'export_data', v_set, jsonb_build_object('dataset', v_set), 'db');
  return r;
end $$;
revoke all on function public.export_data(jsonb) from public, anon;
grant execute on function public.export_data(jsonb) to authenticated, service_role;

-- ══ 6 · AI BUDGET PER BUSINESS ══════════════════════════════════════════════════════════════════════
-- The business owner pays for the AI its guests and staff use (owner answer, 19 Nov).  A monthly cap in baht stops guest / staff AI answers for that business when the month's estimated cost reaches it.
create table public.ai_budgets (
  org_id      uuid primary key references public.orgs (id) on delete cascade,
  monthly_cap bigint not null check (monthly_cap between 0 and 100000000),   -- satang; 0 = no AI at all
  updated_at  timestamptz not null default now()
);
alter table public.ai_budgets enable row level security;
create policy ai_budgets_read on public.ai_budgets for select to authenticated using (public.is_org_owner(org_id) or public.is_platform_admin());
revoke all on public.ai_budgets from anon, authenticated;
grant select on public.ai_budgets to authenticated;
-- p_cap null = no cap.  The owner of the business, or the platform administrator.
create or replace function public.set_ai_budget(p_org uuid, p_cap bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (public.is_org_owner(p_org) or public.is_platform_admin()) then raise exception 'the AI budget is for the owner' using errcode = '42501'; end if;
  if p_cap is null then delete from public.ai_budgets where org_id = p_org;
  else insert into public.ai_budgets (org_id, monthly_cap) values (p_org, p_cap) on conflict (org_id) do update set monthly_cap = excluded.monthly_cap, updated_at = now();
  end if;
  perform public.audit_record(p_org, null, 'settings.change', 'ai_budgets', p_org::text, jsonb_build_object('cap', p_cap), 'db');
end $$;
-- for the server before an AI call: the cap and this month's tokens per model (Bangkok month).  Service role only.
create or replace function public.ai_budget_state(p_store uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid; v_cap bigint; v_start timestamptz := date_trunc('month', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok';
begin
  select org_id into v_org from public.stores where id = p_store;
  if v_org is null then return jsonb_build_object('cap', null, 'usage', '[]'::jsonb); end if;
  select monthly_cap into v_cap from public.ai_budgets where org_id = v_org;
  if v_cap is null then return jsonb_build_object('cap', null, 'usage', '[]'::jsonb); end if;
  return jsonb_build_object('cap', v_cap,
    'usd_thb', (select usd_thb from public.ai_settings where id), 'prices', (select prices from public.ai_settings where id),
    'usage', coalesce((select jsonb_agg(jsonb_build_object('model', u.model, 'input', u.i, 'output', u.o))
                         from (select model, sum(input_tokens) as i, sum(output_tokens) as o from public.ai_usage_log where org_id = v_org and created_at >= v_start group by model) u), '[]'::jsonb));
end $$;
revoke all on function public.set_ai_budget(uuid, bigint) from public, anon;
grant execute on function public.set_ai_budget(uuid, bigint) to authenticated, service_role;
revoke all on function public.ai_budget_state(uuid) from public, anon, authenticated;
grant execute on function public.ai_budget_state(uuid) to service_role;
