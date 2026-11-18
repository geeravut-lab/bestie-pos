-- Bestie POS · migration 17 · split / merge bills and cash shifts.
--
--  * move_order_lines(): the ONLY way a line changes bill (or a sent line's quantity is split): checked, replay-safe, audited by
--    the lines' own history; a bill that ends up empty after a merge is closed as void;
--  * shifts: a cash drawer session per device — opening cash, counted cash at the end, and the EXPECTED cash computed by the
--    server from the confirmed cash payments of that device in the shift window, so the till cannot choose its own variance;
--  * stores.shift_required lets an owner insist on an open shift before any payment (off by default).

-- the line guard now lets the privileged move function re-home a line / split a sent line's quantity
create or replace function public.order_lines_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  o public.orders%rowtype;
  m jsonb;
  rank_old integer;
  rank_new integer;
begin
  select * into o from public.orders where id = new.order_id;
  if not found or o.store_id <> new.store_id or o.org_id <> new.org_id then
    raise exception 'order belongs to another shop' using errcode = '23514';
  end if;
  if o.status in ('paid', 'void') and not public.order_privileged() then
    raise exception 'order is closed' using errcode = '23514';
  end if;
  if not public.menu_text_ok(new.name) then
    raise exception 'invalid line name' using errcode = '23514';
  end if;
  if new.item_id is not null and not exists (
       select 1 from public.menu_items i where i.id = new.item_id and i.store_id = new.store_id) then
    raise exception 'item belongs to another shop' using errcode = '23514';
  end if;
  if jsonb_typeof(new.modifiers) is distinct from 'array' or jsonb_array_length(new.modifiers) > 30 then
    raise exception 'modifiers must be a short list' using errcode = '23514';
  end if;
  for m in select * from jsonb_array_elements(new.modifiers) loop
    if jsonb_typeof(m) is distinct from 'object'
       or jsonb_typeof(m -> 'id') is distinct from 'string'
       or jsonb_typeof(m -> 'priceDelta') is distinct from 'number'
       or (m ->> 'priceDelta') !~ '^-?[0-9]+$'
       or not public.menu_text_ok(m -> 'name') then
      raise exception 'invalid modifier' using errcode = '23514';
    end if;
  end loop;

  if tg_op = 'INSERT' then
    if new.status not in ('new', 'sent') then
      raise exception 'a line starts as new' using errcode = '23514';
    end if;
    return new;
  end if;

  -- UPDATE
  -- moving a line to another bill is the job of move_order_lines() (privileged); nothing else may change a line's identity
  if (new.order_id <> old.order_id and not public.order_privileged()) or new.org_id <> old.org_id or new.store_id <> old.store_id then
    raise exception 'line identity cannot change' using errcode = '23514';
  end if;
  rank_old := case old.status when 'new' then 0 when 'sent' then 1 when 'ready' then 2 when 'served' then 3 else 9 end;
  rank_new := case new.status when 'new' then 0 when 'sent' then 1 when 'ready' then 2 when 'served' then 3 else 9 end;
  if old.status = 'void' and new.status <> 'void' then
    raise exception 'a voided line stays void' using errcode = '23514';
  end if;
  if new.status <> 'void' and rank_new < rank_old then
    raise exception 'a line only moves forward' using errcode = '23514';
  end if;
  -- once sent, a line is history: only its kitchen status (and the void) may change
  if old.status <> 'new' and not public.order_privileged() and (new.unit_price <> old.unit_price or new.quantity <> old.quantity
       or new.name <> old.name or new.modifiers <> old.modifiers or new.item_id is distinct from old.item_id
       or new.note is distinct from old.note) then
    raise exception 'a sent line cannot be edited' using errcode = '23514';
  end if;
  if new.status = 'void' and old.status not in ('new', 'void') and not public.order_privileged()
     and not public.has_permission(new.org_id, 'order.void') then
    raise exception 'voiding a sent line needs order.void' using errcode = '42501';
  end if;
  return new;
end $$;

-- ── split / merge ──────────────────────────────────────────────────────────
create or replace function public.move_order_lines(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_from public.orders%rowtype;
  v_to   public.orders%rowtype;
  v_a    uuid := (p ->> 'from_order')::uuid;
  v_b    uuid := (p ->> 'to_order')::uuid;
  m      jsonb;
  l      public.order_lines%rowtype;
  v_qty  integer;
  v_new  uuid;
begin
  if v_a = v_b then
    raise exception 'a bill cannot be moved into itself' using errcode = '23514';
  end if;
  -- lock both bills in a fixed order so two tablets splitting at once cannot deadlock
  perform 1 from public.orders where id in (v_a, v_b) order by id for update;
  select * into v_from from public.orders where id = v_a;
  select * into v_to from public.orders where id = v_b;
  if v_from.id is null or v_to.id is null then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  if not (public.has_permission(v_from.org_id, 'order.create') and public.can_access_store(v_from.org_id, v_from.store_id)) then
    raise exception 'moving items needs order.create' using errcode = '42501';
  end if;
  if v_from.org_id <> v_to.org_id or v_from.store_id <> v_to.store_id then
    raise exception 'bills are in different shops' using errcode = '23514';
  end if;
  if v_from.status in ('paid', 'void') or v_to.status in ('paid', 'void') then
    raise exception 'a closed bill cannot take part' using errcode = '23514';
  end if;

  for m in select * from jsonb_array_elements(p -> 'moves') loop
    v_qty := (m ->> 'qty')::integer;
    v_new := nullif(m ->> 'new_line_id', '')::uuid;
    -- a partial move that already happened (the same call arriving again)
    if v_new is not null and exists (select 1 from public.order_lines x where x.id = v_new) then
      continue;
    end if;
    select * into l from public.order_lines where id = (m ->> 'line_id')::uuid;
    if not found then
      raise exception 'line not found' using errcode = 'P0002';
    end if;
    if l.order_id = v_to.id then
      continue; -- a whole-line move that already happened
    end if;
    if l.order_id <> v_from.id or l.status = 'void' then
      raise exception 'line is not on the bill it is moved from' using errcode = '23514';
    end if;
    if v_qty is null or v_qty < 1 or v_qty > l.quantity then
      raise exception 'quantity to move is out of range' using errcode = '23514';
    end if;
    if v_qty = l.quantity then
      update public.order_lines set order_id = v_to.id where id = l.id;
    else
      if v_new is null then
        raise exception 'a partial move needs the new line id' using errcode = '23514';
      end if;
      update public.order_lines set quantity = l.quantity - v_qty where id = l.id;
      insert into public.order_lines (id, org_id, store_id, order_id, item_id, name, unit_price, quantity, modifiers, note, station,
                                      status, sent_at, seat, created_by)
      values (v_new, l.org_id, l.store_id, v_to.id, l.item_id, l.name, l.unit_price, v_qty, l.modifiers, l.note, l.station,
              l.status, l.sent_at, l.seat, l.created_by);
    end if;
  end loop;

  -- a merge leaves the source bill empty: close it (it is not a sale)
  if coalesce((p ->> 'void_source_if_empty')::boolean, false)
     and not exists (select 1 from public.order_lines x where x.order_id = v_from.id and x.status <> 'void') then
    update public.orders set status = 'void', note = left(coalesce(note, '') || ' [merged into ' || v_to.number || ']', 300) where id = v_from.id;
  end if;
end $$;
revoke all on function public.move_order_lines(jsonb) from public, anon;
grant execute on function public.move_order_lines(jsonb) to authenticated, service_role;

-- ── shifts ─────────────────────────────────────────────────────────────────
alter table public.stores add column shift_required boolean not null default false;

create table public.shifts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs (id) on delete cascade,
  store_id      uuid not null references public.stores (id) on delete cascade,
  device_id     uuid not null references public.devices (id),
  opened_by     uuid references public.staff (id),
  opened_at     timestamptz not null,
  opening_cash  bigint not null check (opening_cash between 0 and 100000000),
  status        text not null default 'open' check (status in ('open', 'closed')),
  closed_by     uuid references public.staff (id),
  closed_at     timestamptz,
  counted_cash  bigint check (counted_cash between 0 and 1000000000),
  expected_cash bigint,
  variance      bigint,
  note          text check (length(note) <= 300),
  created_at    timestamptz not null default now(),
  check ((status = 'open' and closed_at is null and counted_cash is null)
      or (status = 'closed' and closed_at is not null and counted_cash is not null and expected_cash is not null and variance is not null))
);
create unique index shifts_one_open_per_device on public.shifts (device_id) where status = 'open';
create index shifts_store_idx on public.shifts (store_id, opened_at);
alter table public.shifts enable row level security;
create policy shifts_read on public.shifts for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.shifts from anon, authenticated;
grant select on public.shifts to authenticated;     -- writes: open_shift() / close_shift() only
create trigger shifts_live after insert or update on public.shifts for each row execute function public.live_ping_row('store:{store_id}');

create or replace function public.open_shift(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_dev   public.devices%rowtype;
  v_id    uuid := (p ->> 'id')::uuid;
  v_staff uuid := nullif(p ->> 'staff_id', '')::uuid;
begin
  select * into v_dev from public.devices where id = (p ->> 'device_id')::uuid and active;
  if not found then
    raise exception 'device not found' using errcode = 'P0002';
  end if;
  if not (public.has_permission(v_dev.org_id, 'shift.open_close') and public.can_access_store(v_dev.org_id, v_dev.store_id)) then
    raise exception 'opening a shift needs shift.open_close' using errcode = '42501';
  end if;
  if exists (select 1 from public.shifts s where s.id = v_id) then
    return; -- the same call arriving again
  end if;
  if v_staff is not null and not exists (select 1 from public.staff s where s.id = v_staff and s.org_id = v_dev.org_id) then
    v_staff := null;
  end if;
  insert into public.shifts (id, org_id, store_id, device_id, opened_by, opened_at, opening_cash)
  values (v_id, v_dev.org_id, v_dev.store_id, v_dev.id, v_staff, (p ->> 'opened_at')::timestamptz, (p ->> 'opening_cash')::bigint);
  perform public.audit_record(v_dev.org_id, v_dev.store_id, 'shift.open', 'shifts', v_id::text,
    jsonb_build_object('opening_cash', (p ->> 'opening_cash')::bigint), 'db');
end $$;
revoke all on function public.open_shift(jsonb) from public, anon;
grant execute on function public.open_shift(jsonb) to authenticated, service_role;

create or replace function public.close_shift(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s       public.shifts%rowtype;
  v_close timestamptz := (p ->> 'closed_at')::timestamptz;
  v_count bigint := (p ->> 'counted_cash')::bigint;
  v_cash  bigint;
  v_exp   bigint;
  v_staff uuid := nullif(p ->> 'staff_id', '')::uuid;
begin
  select * into s from public.shifts where id = (p ->> 'id')::uuid for update;
  if not found then
    raise exception 'shift not found' using errcode = 'P0002';
  end if;
  if not (public.has_permission(s.org_id, 'shift.open_close') and public.can_access_store(s.org_id, s.store_id)) then
    raise exception 'closing a shift needs shift.open_close' using errcode = '42501';
  end if;
  if s.status = 'closed' then
    return jsonb_build_object('expected_cash', s.expected_cash, 'variance', s.variance); -- again: nothing to do
  end if;
  if v_close < s.opened_at then
    raise exception 'a shift cannot close before it opened' using errcode = '23514';
  end if;
  -- the server decides what SHOULD be in the drawer: opening cash + confirmed cash taken on this device during the shift
  select coalesce(sum(pay.amount), 0) into v_cash from public.payments pay
   where pay.device_id = s.device_id and pay.tender = 'cash' and pay.status = 'confirmed'
     and pay.created_at >= s.opened_at and pay.created_at <= v_close;
  v_exp := s.opening_cash + v_cash;
  if v_staff is not null and not exists (select 1 from public.staff x where x.id = v_staff and x.org_id = s.org_id) then
    v_staff := null;
  end if;
  update public.shifts
     set status = 'closed', closed_at = v_close, closed_by = v_staff, counted_cash = v_count,
         expected_cash = v_exp, variance = v_count - v_exp, note = nullif(left(p ->> 'note', 300), '')
   where id = s.id;
  perform public.audit_record(s.org_id, s.store_id, 'shift.close', 'shifts', s.id::text,
    jsonb_build_object('counted', v_count, 'expected', v_exp), 'db');
  if v_count <> v_exp then
    perform public.audit_record(s.org_id, s.store_id, 'shift.cash_variance', 'shifts', s.id::text,
      jsonb_build_object('variance', v_count - v_exp), 'db');
  end if;
  return jsonb_build_object('expected_cash', v_exp, 'variance', v_count - v_exp);
end $$;
revoke all on function public.close_shift(jsonb) from public, anon;
grant execute on function public.close_shift(jsonb) to authenticated, service_role;
