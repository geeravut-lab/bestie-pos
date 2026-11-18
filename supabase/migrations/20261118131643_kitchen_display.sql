-- Bestie POS · migration 18 · kitchen display: the `kds.use` permission and set_lines_status().
--
--  * a kitchen / bar screen signs in with a Kitchen account, which cannot take orders (no order.create) — it gets the narrow
--    permission `kds.use`, enough to move lines through ready → served and to undo a mis-tap, nothing else;
--  * set_lines_status() is the only way the kitchen changes a line, in whole tickets, replay-safe and forward-moving
--    (with a one-step undo); sent / ready / served lines keep their price and quantity as always.

-- existing kitchen roles + any future one
update public.roles set permissions = array['kds.use'] where built_in = 'kitchen' and permissions = '{}';
create or replace function public.roles_kitchen_default() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.built_in = 'kitchen' and new.permissions = '{}' then
    new.permissions := array['kds.use'];
  end if;
  return new;
end $$;
create trigger roles_kitchen_default before insert on public.roles for each row execute function public.roles_kitchen_default();

-- the line guard learns the one-step undo
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
  -- a line only moves forward — except the kitchen's "undo" (ready → sent, served → ready), which only set_lines_status() may do
  if new.status <> 'void' and rank_new < rank_old
     and not (public.order_privileged() and old.status in ('ready', 'served') and new.status in ('sent', 'ready') and rank_old - rank_new = 1) then
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


create or replace function public.set_lines_status(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_status text := p ->> 'status';
  l        public.order_lines%rowtype;
  v_id     text;
  v_done   integer := 0;
begin
  if v_status not in ('sent', 'ready', 'served') then
    raise exception 'unknown status' using errcode = '22023';
  end if;
  for v_id in select jsonb_array_elements_text(p -> 'line_ids') loop
    select * into l from public.order_lines where id = v_id::uuid for update;
    if not found then
      raise exception 'line not found' using errcode = 'P0002';
    end if;
    if not ((public.has_permission(l.org_id, 'kds.use') or public.has_permission(l.org_id, 'order.create'))
            and public.can_access_store(l.org_id, l.store_id)) then
      raise exception 'changing a line status needs kds.use' using errcode = '42501';
    end if;
    if l.status = 'void' or l.status = v_status then
      continue; -- cancelled meanwhile, or already there (the same call arriving twice)
    end if;
    if l.status = 'new' then
      raise exception 'a line that was not sent has no kitchen status' using errcode = '23514';
    end if;
    if (case l.status when 'sent' then 1 when 'ready' then 2 else 3 end) - (case v_status when 'sent' then 1 when 'ready' then 2 else 3 end) > 1 then
      raise exception 'a line can only be undone one step' using errcode = '23514';
    end if;
    update public.order_lines set status = v_status where id = l.id;
    v_done := v_done + 1;
  end loop;
  return v_done;
end $$;
revoke all on function public.set_lines_status(jsonb) from public, anon;
grant execute on function public.set_lines_status(jsonb) to authenticated, service_role;
