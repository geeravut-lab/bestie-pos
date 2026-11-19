-- Bestie POS · migration 40 · kitchen / bar tickets for orders the SERVER sent to the kitchen (guest QR auto-send).
--
--  * `print_jobs`: one row per (order send, station, ticket printer). Only NETWORK printers with `stations` get jobs (a USB / Bluetooth
--    printer belongs to one tablet; a network printer can be reached by any "print station" screen in the shop).
--  * `enqueue_print_jobs` (internal) is called by `guest_place_order` when the shop auto-sends guest orders. Tablet sends are printed by
--    the tablet itself and never enqueue (so nothing prints twice).
--  * A print station screen (an open tablet / PC) claims jobs for the printers it can reach (`claim_print_jobs`: a job is handed out
--    to one claimer at a time, comes back after 60 s if not reported, at most 3 tries, nothing older than 30 minutes) and reports
--    the result (`report_print_job`). A ticket from half an hour ago is not news.
create table public.print_jobs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs (id) on delete cascade,
  store_id     uuid not null references public.stores (id) on delete cascade,
  order_id     uuid not null references public.orders (id) on delete cascade,
  station      text not null check (station in ('kitchen', 'bar')),
  printer_id   text not null check (printer_id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  order_number text not null,
  table_name   text,
  lines        jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 200),
  sent_at      timestamptz not null,
  status       text not null default 'queued' check (status in ('queued', 'claimed', 'printed', 'failed')),
  attempts     integer not null default 0 check (attempts between 0 and 10),
  claimed_at   timestamptz,
  printed_at   timestamptz,
  created_at   timestamptz not null default now(),
  unique (order_id, station, printer_id, sent_at)
);
create index print_jobs_open_idx on public.print_jobs (store_id, printer_id, created_at) where status in ('queued', 'claimed');
alter table public.print_jobs enable row level security;
create policy print_jobs_read on public.print_jobs for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.print_jobs from anon, authenticated;
grant select on public.print_jobs to authenticated;

create or replace function public.enqueue_print_jobs(p_order uuid, p_sent_at timestamptz) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders%rowtype;
  s public.stores%rowtype;
  v_table text;
  pr jsonb;
  st text;
  v_lines jsonb;
  n integer := 0;
begin
  select * into o from public.orders where id = p_order;
  select * into s from public.stores where id = o.store_id;
  select t.name into v_table from public.dining_tables t where t.id = o.table_id;
  for st in select unnest(array['kitchen', 'bar']) loop
    select coalesce(jsonb_agg(jsonb_build_object(
             'quantity', l.quantity, 'name_th', coalesce(l.name ->> 'th', ''), 'seat', l.seat, 'note', l.note,
             'modifiers', coalesce((select jsonb_agg(coalesce(m -> 'name' ->> 'th', '')) from jsonb_array_elements(l.modifiers) m), '[]'::jsonb))
             order by l.created_at, l.id), '[]'::jsonb)
      into v_lines
      from public.order_lines l
     where l.order_id = p_order and l.station = st and l.status <> 'void' and l.sent_at = p_sent_at;
    if jsonb_array_length(v_lines) = 0 then continue; end if;
    for pr in select * from jsonb_array_elements(s.printers) loop
      if pr ->> 'kind' = 'network' and pr -> 'stations' ? st then
        insert into public.print_jobs (org_id, store_id, order_id, station, printer_id, order_number, table_name, lines, sent_at)
        values (o.org_id, o.store_id, o.id, st, pr ->> 'id', o.number, v_table, v_lines, p_sent_at)
        on conflict (order_id, station, printer_id, sent_at) do nothing;
        n := n + 1;
      end if;
    end loop;
  end loop;
  return n;
end $$;
revoke all on function public.enqueue_print_jobs(uuid, timestamptz) from public, anon, authenticated;

create or replace function public.claim_print_jobs(p_store uuid, p_printers text[], p_limit integer default 5) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_rows jsonb;
begin
  select s.org_id into v_org from public.stores s where s.id = p_store and s.deleted_at is null;
  if v_org is null or not public.can_access_store(v_org, p_store)
     or not (public.has_permission(v_org, 'kds.use') or public.has_permission(v_org, 'order.create') or public.has_permission(v_org, 'payment.take')) then
    raise exception 'printing tickets needs a kitchen, order or payment role in this shop' using errcode = '42501';
  end if;
  with picked as (
    select j.id from public.print_jobs j
     where j.store_id = p_store and j.printer_id = any (coalesce(p_printers, '{}'))
       and j.created_at > now() - interval '30 minutes'
       and (j.status = 'queued' or (j.status = 'claimed' and j.claimed_at < now() - interval '60 seconds'))
       and j.attempts < 3
     order by j.created_at
     limit least(greatest(coalesce(p_limit, 5), 1), 20)
       for update skip locked),
  upd as (
    update public.print_jobs j set status = 'claimed', claimed_at = now(), attempts = j.attempts + 1
      from picked where j.id = picked.id
    returning j.*)
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'station', u.station, 'printer_id', u.printer_id, 'order_number', u.order_number,
           'table_name', u.table_name, 'lines', u.lines, 'sent_at', u.sent_at) order by u.created_at), '[]'::jsonb)
    into v_rows from upd u;
  return v_rows;
end $$;
revoke all on function public.claim_print_jobs(uuid, text[], integer) from public, anon;
grant execute on function public.claim_print_jobs(uuid, text[], integer) to authenticated, service_role;

create or replace function public.report_print_job(p_job uuid, p_ok boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  j public.print_jobs%rowtype;
begin
  select * into j from public.print_jobs where id = p_job for update;
  if not found or not public.can_access_store(j.org_id, j.store_id)
     or not (public.has_permission(j.org_id, 'kds.use') or public.has_permission(j.org_id, 'order.create') or public.has_permission(j.org_id, 'payment.take')) then
    raise exception 'printing tickets needs a kitchen, order or payment role in this shop' using errcode = '42501';
  end if;
  if j.status in ('printed', 'failed') then return; end if;
  if p_ok then
    update public.print_jobs set status = 'printed', printed_at = now() where id = j.id;
  else
    update public.print_jobs set status = case when j.attempts >= 3 then 'failed' else 'queued' end where id = j.id;
  end if;
end $$;
revoke all on function public.report_print_job(uuid, boolean) from public, anon;
grant execute on function public.report_print_job(uuid, boolean) to authenticated, service_role;

create or replace function public.guest_place_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t        public.dining_tables%rowtype;
  s        public.stores%rowtype;
  v_cid    uuid := (p ->> 'client_id')::uuid;
  v_old    public.guest_submissions%rowtype;
  v_order  uuid;
  v_number text;
  v_date   date := (now() at time zone 'Asia/Bangkok')::date;
  v_next   integer;
  v_line   jsonb;
  v_item   public.menu_items%rowtype;
  v_qty    integer;
  v_note   text;
  v_price  integer;
  v_mods   jsonb;
  v_status text;
  v_opt    text;
  g        public.modifier_groups%rowtype;
  o        public.modifier_options%rowtype;
  v_count  integer;
  v_picked integer;
  v_total  integer := 0;
  v_now    timestamptz := now();
begin
  select * into t from public.dining_tables where qr_token = (p ->> 'token') and deleted_at is null and active;
  if not found then raise exception 'unknown table' using errcode = 'P0002'; end if;
  select * into s from public.stores where id = t.store_id and deleted_at is null;
  if not found then raise exception 'unknown table' using errcode = 'P0002'; end if;
  if not public.qr_ordering_enabled(s.id) then raise exception 'ordering from the table is switched off' using errcode = '0A000'; end if;
  if v_cid is null or jsonb_typeof(p -> 'lines') is distinct from 'array' or jsonb_array_length(p -> 'lines') not between 1 and 30 then
    raise exception 'the order is empty or too long' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('guest:' || s.id::text));

  select * into v_old from public.guest_submissions where id = v_cid;
  if found then
    if v_old.table_id <> t.id then raise exception 'unknown table' using errcode = 'P0002'; end if;
    select o2.number into v_number from public.orders o2 where o2.id = v_old.order_id;
    return jsonb_build_object('order_id', v_old.order_id, 'number', v_number, 'lines', v_old.lines,
                              'status', case when s.qr_auto_send then 'sent' else 'waiting' end, 'replay', true);
  end if;

  select count(*) into v_count from public.guest_submissions
   where table_id = t.id and created_at > v_now - interval '10 minutes';
  if v_count >= 12 then raise exception 'too many orders from this table, ask the staff' using errcode = '54000'; end if;

  select ord.id, ord.number into v_order, v_number from public.orders ord
   where ord.table_id = t.id and ord.status not in ('paid', 'void') order by ord.created_at limit 1 for update;
  if v_order is not null and exists (
       select 1 from public.payment_attempts pa where pa.order_id = v_order and pa.status in ('created', 'pending')) then
    raise exception 'a payment on this bill is waiting' using errcode = '55006';
  end if;
  if v_order is null then
    select coalesce(max(substr(number, 3)::integer), 0) + 1 into v_next from public.orders
     where store_id = s.id and business_date = v_date and number ~ '^QR[0-9]+$';
    v_number := 'QR' || lpad(v_next::text, 3, '0');
    insert into public.orders (org_id, store_id, number, business_date, channel, table_id)
    values (s.org_id, s.id, v_number, v_date, 'dine-in', t.id) returning id into v_order;
  end if;
  if (select count(*) from public.order_lines where order_id = v_order and status <> 'void') + jsonb_array_length(p -> 'lines') > 150 then
    raise exception 'this bill is too long, ask the staff' using errcode = '54000';
  end if;

  v_status := case when s.qr_auto_send then 'sent' else 'new' end;
  for v_line in select * from jsonb_array_elements(p -> 'lines') loop
    if jsonb_typeof(v_line) is distinct from 'object' or (v_line ->> 'quantity') !~ '^[0-9]{1,2}$' then
      raise exception 'bad line' using errcode = '22023';
    end if;
    v_qty := (v_line ->> 'quantity')::integer;
    if v_qty not between 1 and 99 then raise exception 'bad quantity' using errcode = '22023'; end if;
    select * into v_item from public.menu_items i
     where i.id = (v_line ->> 'item_id')::uuid and i.store_id = s.id and i.deleted_at is null and i.available;
    if not found then raise exception 'an item is not available any more' using errcode = '23514'; end if;
    v_note := nullif(btrim(coalesce(v_line ->> 'note', '')), '');
    if v_note is not null then v_note := left(regexp_replace(v_note, '[[:cntrl:]]', ' ', 'g'), 200); end if;

    v_price := coalesce((v_item.prices ->> 'dine-in')::integer, (v_item.prices ->> 'base')::integer);
    v_mods := '[]'::jsonb;
    if jsonb_typeof(v_line -> 'option_ids') is distinct from 'array' and (v_line -> 'option_ids') is not null then
      raise exception 'bad options' using errcode = '22023';
    end if;
    for v_opt in select * from jsonb_array_elements_text(coalesce(v_line -> 'option_ids', '[]'::jsonb)) loop
      select op.* into o from public.modifier_options op
       where op.id = v_opt::uuid and op.store_id = s.id and op.deleted_at is null and op.active
         and op.group_id = any (v_item.modifier_group_ids);
      if not found then raise exception 'an option is not available' using errcode = '23514'; end if;
      v_mods := v_mods || jsonb_build_array(jsonb_build_object(
        'id', o.id, 'name', o.name, 'priceDelta', coalesce((o.channel_delta ->> 'dine-in')::integer, o.price_delta)));
      v_price := v_price + coalesce((o.channel_delta ->> 'dine-in')::integer, o.price_delta);
    end loop;
    if (select count(distinct x) from jsonb_array_elements(v_mods) m, lateral (select m ->> 'id') as d(x)) <> jsonb_array_length(v_mods) then
      raise exception 'an option was chosen twice' using errcode = '23514';
    end if;
    for g in select mg.* from public.modifier_groups mg
              where mg.id = any (v_item.modifier_group_ids) and mg.deleted_at is null loop
      select count(*) into v_picked from jsonb_array_elements(v_mods) m
       where exists (select 1 from public.modifier_options op where op.id = (m ->> 'id')::uuid and op.group_id = g.id);
      if v_picked < g.min_select or v_picked > g.max_select then
        raise exception 'choose the options this dish needs' using errcode = '23514';
      end if;
    end loop;
    if v_price < 0 then v_price := 0; end if;

    insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, modifiers, note, station, status, sent_at)
    values (s.org_id, s.id, v_order, v_item.id, v_item.name, v_price, v_qty, v_mods, v_note, v_item.station, v_status,
            case when v_status = 'sent' then v_now end);
    v_total := v_total + 1;
  end loop;

  insert into public.guest_submissions (id, org_id, store_id, table_id, order_id, lines) values (v_cid, s.org_id, s.id, t.id, v_order, v_total);
  -- lines the server sent to the kitchen by itself have no tablet to print them: queue tickets for the shop's network printers
  if v_status = 'sent' then perform public.enqueue_print_jobs(v_order, v_now); end if;
  return jsonb_build_object('order_id', v_order, 'number', v_number, 'lines', v_total,
                            'status', case when s.qr_auto_send then 'sent' else 'waiting' end, 'replay', false);
end $$;
revoke all on function public.guest_place_order(jsonb) from public, anon, authenticated;
grant execute on function public.guest_place_order(jsonb) to service_role;
