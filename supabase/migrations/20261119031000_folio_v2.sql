-- Bestie POS · migration 76 · FOLIO v2: a nightly room rate posted by itself, a printable stay summary, and returns on bills charged to a room.
--
--  * NIGHT RATE: a room may carry a price per night (`folio_rooms.night_rate`, satang); check-in copies it onto the stay (`folios.night_rate`, the front desk may type another
--    one for this guest), so a later edit never changes a stay in the house. Each night of the stay is ONE charge of kind `night` (`night_date` = the Bangkok date the night
--    starts; unique per stay, so posting twice, or after a manager voided one, never adds a second). Nights are posted by the tick (`folio_post_nights_all`, every 10 minutes)
--    for every date BEFORE today, by the front desk with "Post the nights now" (`folio_post_nights`), and always at check-out (`folio_settle` calls it first), so a stay checked
--    in on the 20th and out on the 23rd owes three nights (20th, 21st, 22nd). A night is a line on the stay, not a POS bill: it has no receipt number (the folio statement
--    lists it; the accountant decides how room nights are invoiced).
--  * RETURNS: a bill that was charged to a room can be returned with the new route `room` while the stay is OPEN: the amount (computed by the database as for every return) goes
--    onto the stay as a negative charge of kind `return`, so the guest owes less at check-out. After check-out the guest has already paid, so only the recorded-only route
--    `manual` (the resort refunds by hand) is allowed for that bill. A route can never carry more than the bill's room payment minus what already went back that way, a charge
--    that was taken off the stay cannot be returned, and a bill charge that has a return cannot be taken off.
--  * Nothing here moves money by itself: a night charge is a receivable like any charge, settled at check-out.

alter table public.folio_rooms add column night_rate integer check (night_rate is null or night_rate between 0 and 100000000);
alter table public.folios add column night_rate integer check (night_rate is null or night_rate between 0 and 100000000);

-- the return route `room`
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.order_returns'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%refund_method%' loop
    execute format('alter table public.order_returns drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.order_returns add constraint order_returns_refund_method_check check (refund_method in ('cash', 'credit', 'manual', 'room'));

-- charges: a bill, a night, or a return
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.folio_charges'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%amount > 0%' loop
    execute format('alter table public.folio_charges drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.folio_charges
  add column kind       text not null default 'bill' check (kind in ('bill', 'night', 'return')),
  add column night_date date,
  add column return_id  uuid references public.order_returns (id),
  add column note       text check (note is null or length(note) <= 100);
alter table public.folio_charges alter column order_id drop not null;
alter table public.folio_charges add constraint folio_charges_shape check (
  (kind = 'bill'   and order_id is not null and amount > 0 and night_date is null and return_id is null) or
  (kind = 'night'  and order_id is null and amount > 0 and night_date is not null and return_id is null) or
  (kind = 'return' and order_id is null and amount < 0 and night_date is null and return_id is not null));
create unique index folio_charges_night_uidx on public.folio_charges (folio_id, night_date) where kind = 'night';
create unique index folio_charges_return_uidx on public.folio_charges (return_id) where return_id is not null;

-- ── rooms and check-in carry the rate ──
-- p = { store_id, id?, name, sort?, active?, night_rate? (satang; '' or null = none) }   (menu.edit)
create or replace function public.save_folio_room(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; v_id uuid := nullif(p ->> 'id', '')::uuid; v_rate integer := nullif(p ->> 'night_rate', '')::integer;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_edit_menu(s.id) then raise exception 'editing rooms needs menu.edit in this shop' using errcode = '42501'; end if;
  if not public.folio_enabled(s.id) then raise exception 'the folio module is off in this shop' using errcode = '0A000'; end if;
  if v_id is null then
    insert into public.folio_rooms (org_id, store_id, name, sort, active, night_rate)
    values (s.org_id, s.id, btrim(p ->> 'name'), coalesce((p ->> 'sort')::integer, 0), coalesce((p ->> 'active')::boolean, true), v_rate) returning id into v_id;
  else
    update public.folio_rooms
       set name = coalesce(btrim(p ->> 'name'), name), sort = coalesce((p ->> 'sort')::integer, sort), active = coalesce((p ->> 'active')::boolean, active),
           night_rate = case when p ? 'night_rate' then v_rate else night_rate end
     where id = v_id and store_id = s.id;
    if not found then raise exception 'unknown room' using errcode = '22023'; end if;
  end if;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'folio_rooms', v_id::text, jsonb_build_object('active', p -> 'active', 'night_rate', v_rate), 'db');
  return v_id;
end $$;

-- p = { store_id, room_id, guest_name, phone?, customer_id?, check_out_on?, note?, night_rate? (satang; default = the room's) }   (order.create)
create or replace function public.folio_check_in(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r public.folio_rooms%rowtype; v_staff uuid; v_id uuid; v_rate integer;
begin
  select * into r from public.folio_rooms where id = (p ->> 'room_id')::uuid and store_id = (p ->> 'store_id')::uuid for update;
  if not found or not (public.can_access_store(r.org_id, r.store_id) and public.has_permission(r.org_id, 'order.create')) then
    raise exception 'checking in needs order.create in this shop' using errcode = '42501';
  end if;
  if not public.folio_enabled(r.store_id) then raise exception 'the folio module is off in this shop' using errcode = '0A000'; end if;
  if not r.active then raise exception 'this room is switched off' using errcode = '55000'; end if;
  if exists (select 1 from public.folios f where f.room_id = r.id and f.status = 'open') then raise exception 'this room already has a guest' using errcode = '55000'; end if;
  if nullif(p ->> 'customer_id', '') is not null and not exists (select 1 from public.customers c where c.id = (p ->> 'customer_id')::uuid and c.org_id = r.org_id) then
    raise exception 'unknown member' using errcode = '22023';
  end if;
  v_rate := case when p ? 'night_rate' then nullif(p ->> 'night_rate', '')::integer else r.night_rate end;
  if v_rate is not null and v_rate not between 0 and 100000000 then raise exception 'the night rate is not valid' using errcode = '22023'; end if;
  select f.id into v_staff from public.staff f where f.org_id = r.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.folios (org_id, store_id, room_id, guest_name, phone, customer_id, check_out_on, note, night_rate, created_by)
  values (r.org_id, r.store_id, r.id, btrim(p ->> 'guest_name'), nullif(btrim(coalesce(p ->> 'phone', '')), ''), nullif(p ->> 'customer_id', '')::uuid,
          nullif(p ->> 'check_out_on', '')::date, nullif(btrim(coalesce(p ->> 'note', '')), ''), v_rate, v_staff) returning id into v_id;
  return v_id;
end $$;

-- ── posting the nights ──
-- every night from the check-in date up to YESTERDAY (Bangkok) that is not on the stay yet; safe to repeat; returns the number added
create or replace function public.folio_post_nights_core(p_folio uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare f public.folios%rowtype; v_today date := (now() at time zone 'Asia/Bangkok')::date; v_from date; v_to date; n integer;
begin
  select * into f from public.folios where id = p_folio and status = 'open';
  if not found or coalesce(f.night_rate, 0) <= 0 then return 0; end if;
  v_from := (f.check_in_at at time zone 'Asia/Bangkok')::date;
  v_to := least(v_today - 1, v_from + 365);
  if v_to < v_from then return 0; end if;
  insert into public.folio_charges (org_id, store_id, folio_id, kind, night_date, amount, note)
  select f.org_id, f.store_id, f.id, 'night', d::date, f.night_rate, 'night'
    from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') d
  on conflict (folio_id, night_date) where kind = 'night' do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.folio_post_nights_core(uuid) from public, anon, authenticated;

-- the front desk: "post the nights now" for one stay
create or replace function public.folio_post_nights(p_folio uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare f public.folios%rowtype;
begin
  select * into f from public.folios where id = p_folio;
  if not found or not (public.can_access_store(f.org_id, f.store_id) and public.has_permission(f.org_id, 'payment.take')) then
    raise exception 'posting the nights needs payment.take in this shop' using errcode = '42501';
  end if;
  return public.folio_post_nights_core(f.id);
end $$;
revoke all on function public.folio_post_nights(uuid) from public, anon;
grant execute on function public.folio_post_nights(uuid) to authenticated, service_role;

-- the tick: every open stay with a rate
create or replace function public.folio_post_nights_all() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n integer := 0;
begin
  for r in select f.id from public.folios f where f.status = 'open' and coalesce(f.night_rate, 0) > 0 order by f.created_at limit 1000 loop
    n := n + public.folio_post_nights_core(r.id);
  end loop;
  return n;
end $$;
revoke all on function public.folio_post_nights_all() from public, anon, authenticated;
grant execute on function public.folio_post_nights_all() to service_role;

-- ── check-out posts the nights first; a charge with a return cannot be taken off; a return line cannot be taken off ──
do $$
declare r record; src text; dst text;
begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('folio_settle', 'folio_void_charge') loop
    src := pg_get_functiondef(r.oid);
    if r.proname = 'folio_settle' then
      dst := replace(src, 'v_amt := public.folio_balance(f.id);', E'perform public.folio_post_nights_core(f.id);\n  v_amt := public.folio_balance(f.id);');
    else
      dst := replace(src, 'if c.voided_at is not null then return; end if;', E'if c.voided_at is not null then return; end if;\n  if c.kind = ''return'' then raise exception ''a return cannot be taken off the stay'' using errcode = ''55000''; end if;\n  if c.kind = ''bill'' and exists (select 1 from public.folio_charges x join public.order_returns rt on rt.id = x.return_id where x.folio_id = c.folio_id and x.kind = ''return'' and x.voided_at is null and rt.order_id = c.order_id) then\n    raise exception ''this bill has a return on the stay'' using errcode = ''55000'';\n  end if;');
    end if;
    if dst = src then raise exception 'migration 76: % not changed', r.proname; end if;
    execute dst;
  end loop;
end $$;

-- ── returns: the route `room` ──
do $$
declare r record; src text; dst text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'create_return' loop
    src := pg_get_functiondef(r.oid);
    dst := src;
    dst := replace(dst, 'v_count  integer;', E'v_count  integer;\n  fch      public.folio_charges%rowtype;');
    dst := replace(dst, $a$v_method not in ('cash', 'credit', 'manual')$a$, $a$v_method not in ('cash', 'credit', 'manual', 'room')$a$);
    dst := replace(dst, $a$or (v_method = 'manual' and pay.tender in ('promptpay', 'gateway')));$a$,
      $a$or (v_method = 'manual' and (pay.tender in ('promptpay', 'gateway')
              or (pay.tender = 'room' and exists (select 1 from public.folio_charges fc2 join public.folios fo2 on fo2.id = fc2.folio_id where fc2.order_id = o.id and fo2.status = 'closed'))))
         or (v_method = 'room' and pay.tender = 'room'));$a$);
    dst := replace(dst, E'  -- Credit back to the member (an adjustment', E'  -- a bill charged to a room: the amount comes off the stay (an open stay only)\n  if v_method = ''room'' and v_amount > 0 then\n    select fc.* into fch from public.folio_charges fc where fc.order_id = o.id and fc.voided_at is null;\n    if not found or not exists (select 1 from public.folios fo where fo.id = fch.folio_id and fo.status = ''open'') then\n      raise exception ''the stay is closed or the charge was taken off: refund the guest by hand'' using errcode = ''55000'';\n    end if;\n    insert into public.folio_charges (org_id, store_id, folio_id, kind, return_id, amount, note, created_by)\n    values (o.org_id, o.store_id, fch.folio_id, ''return'', v_id, -v_amount, left(''return '' || v_no, 100), v_staff);\n  end if;\n\n  -- Credit back to the member (an adjustment');
    if dst = src or position('fch      public.folio_charges' in dst) = 0 or position('''room'')' in dst) = 0 or position('refund the guest by hand' in dst) = 0 or position('fo2.status' in dst) = 0 then
      raise exception 'migration 76: create_return not changed as expected';
    end if;
    execute dst;
  end loop;
end $$;
