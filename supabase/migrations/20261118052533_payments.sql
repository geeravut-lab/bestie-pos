-- Bestie POS · migration 15 · closing a bill: payments + receipts + close_order() (cash for now).
--
--  * a bill is closed ONLY by close_order(): it checks the lines it is closing against the totals the till showed, the
--    permission (payment.take), the receipt number series of the device, and that the payments add up to the amount due;
--  * receipts keep a full SNAPSHOT (seller name / tax id / branch / POS ID / rates / totals) — later edits to the shop or the
--    menu never change a receipt that was already given to a guest (Thai abbreviated tax invoice, CLAUDE.md rule 4);
--  * the till may call it offline and again later: replaying the same receipt number is a no-op;
--  * only cash is accepted here. PromptPay / card are confirmed by the payment provider's webhook, Credit and Points by
--    their own server-side ledgers (later migrations) — a till can never declare those "paid" by itself.

create table public.receipts (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.orgs (id) on delete cascade,
  store_id         uuid not null references public.stores (id) on delete cascade,
  order_id         uuid not null unique references public.orders (id),
  number           text not null check (number ~ '^[A-Z]{1,2}-[0-9]{6,9}$'),
  device_id        uuid references public.devices (id),
  staff_id         uuid references public.staff (id),
  issued_at        timestamptz not null,
  -- seller snapshot (filled by the server from the shop, never trusted from the till)
  seller_name      text not null,
  seller_tax_id    text,
  branch_code      text not null,
  pos_id           text,
  vat_registered   boolean not null,
  vat_bps          integer not null check (vat_bps between 0 and 10000),
  service_bps      integer not null check (service_bps between 0 and 10000),
  price_mode       text not null check (price_mode in ('inclusive', 'exclusive')),
  -- totals, integer satang
  subtotal         bigint not null check (subtotal >= 0),
  service_charge   bigint not null check (service_charge >= 0),
  vat              bigint not null check (vat >= 0),
  net_before_vat   bigint not null check (net_before_vat >= 0),
  total            bigint not null check (total >= 0),
  rounding         integer not null default 0 check (rounding between -100 and 100),
  payable          bigint not null check (payable >= 0),
  lang             text not null default 'th' check (lang in ('th', 'en')),
  -- a full tax invoice (Phase 4) fills these; modelled now so the data never needs a rewrite
  customer_name    text,
  customer_tax_id  text check (customer_tax_id is null or customer_tax_id ~ '^[0-9]{13}$'),
  customer_branch  text,
  created_at       timestamptz not null default now(),
  unique (store_id, number),
  check (payable = total + rounding)
);

create table public.payments (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  order_id   uuid not null references public.orders (id),
  tender     text not null check (tender in ('cash', 'promptpay', 'gateway', 'credit', 'points')),
  amount     bigint not null check (amount > 0),          -- applied to the bill
  tendered   bigint check (tendered is null or tendered >= amount), -- cash handed over
  change     bigint not null default 0 check (change >= 0),
  status     text not null default 'confirmed' check (status in ('pending', 'confirmed', 'failed', 'voided')),
  reference  text check (length(reference) <= 100),       -- provider id, never card data
  staff_id   uuid references public.staff (id),
  device_id  uuid references public.devices (id),
  created_at timestamptz not null default now(),
  check (tendered is null or change = tendered - amount)
);
create index payments_order_idx on public.payments (order_id);
create index payments_store_day_idx on public.payments (store_id, created_at);

alter table public.receipts enable row level security;
alter table public.payments enable row level security;
create policy receipts_read on public.receipts for select to authenticated using (public.can_access_store(org_id, store_id));
create policy payments_read on public.payments for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.receipts, public.payments from anon, authenticated;
grant select on public.receipts, public.payments to authenticated;   -- writes: close_order() only

create trigger receipts_live after insert on public.receipts for each row execute function public.live_ping_row('store:{store_id}');
create trigger payments_live after insert or update on public.payments for each row execute function public.live_ping_row('store:{store_id}');

-- a receipt and the payments are history: nobody edits them (not even service_role through normal paths)
create or replace function public.freeze_history() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% rows are history and cannot be changed or removed', tg_table_name using errcode = '23514';
end $$;
create trigger receipts_frozen before update or delete on public.receipts for each row execute function public.freeze_history();
create trigger payments_frozen_del before delete on public.payments for each row execute function public.freeze_history();

-- ── close_order ────────────────────────────────────────────────────────────
create or replace function public.close_order(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_order  public.orders%rowtype;
  v_store  public.stores%rowtype;
  v_dev    public.devices%rowtype;
  v_ent    public.legal_entities%rowtype;
  v_staff  uuid;
  v_no     text := p ->> 'receipt_number';
  v_sub    bigint;
  v_total  bigint := (p ->> 'total')::bigint;
  v_round  integer := coalesce((p ->> 'rounding')::integer, 0);
  v_pay    bigint := (p ->> 'payable')::bigint;
  v_paid   bigint := 0;
  x        jsonb;
begin
  select * into v_order from public.orders where id = (p ->> 'order_id')::uuid for update;
  if not found then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  if not (public.has_permission(v_order.org_id, 'payment.take') and public.can_access_store(v_order.org_id, v_order.store_id)) then
    raise exception 'taking payment needs payment.take' using errcode = '42501';
  end if;

  -- the same close arriving twice (the first answer was lost): nothing more to do
  if exists (select 1 from public.receipts r where r.order_id = v_order.id and r.number = v_no) then
    return;
  end if;
  if v_order.status in ('paid', 'void') then
    raise exception 'order is already closed' using errcode = '23514';
  end if;

  select * into v_dev from public.devices d where d.id = (p ->> 'device_id')::uuid and d.store_id = v_order.store_id;
  if not found then
    raise exception 'device is not part of this shop' using errcode = '23514';
  end if;
  if v_no !~ ('^' || v_dev.code || '-[0-9]{6,9}$') then
    raise exception 'receipt number must come from this device''s series' using errcode = '23514';
  end if;

  select coalesce(sum(l.unit_price::bigint * l.quantity), 0) into v_sub
    from public.order_lines l where l.order_id = v_order.id and l.status <> 'void';
  if v_sub <> (p ->> 'subtotal')::bigint then
    raise exception 'the bill changed since it was shown' using errcode = '23514';
  end if;
  if v_pay <> v_total + v_round or abs(v_round) > 100 or v_pay < 0 then
    raise exception 'totals do not add up' using errcode = '23514';
  end if;

  for x in select * from jsonb_array_elements(p -> 'payments') loop
    if x ->> 'tender' <> 'cash' then
      raise exception 'only cash can be closed from the till' using errcode = '23514';
    end if;
    if (x ->> 'amount')::bigint <= 0 or (x ->> 'tendered')::bigint < (x ->> 'amount')::bigint
       or (x ->> 'change')::bigint <> (x ->> 'tendered')::bigint - (x ->> 'amount')::bigint then
      raise exception 'cash amounts do not add up' using errcode = '23514';
    end if;
    v_paid := v_paid + (x ->> 'amount')::bigint;
  end loop;
  if v_paid <> v_pay then
    raise exception 'payments do not cover the amount due' using errcode = '23514';
  end if;

  select * into v_store from public.stores s where s.id = v_order.store_id;
  select * into v_ent from public.legal_entities e where e.id = v_store.legal_entity_id;
  v_staff := nullif(p ->> 'staff_id', '')::uuid;
  if v_staff is not null and not exists (select 1 from public.staff s where s.id = v_staff and s.org_id = v_order.org_id) then
    v_staff := null;
  end if;

  perform set_config('bestie.paying', 'on', true);

  insert into public.receipts (org_id, store_id, order_id, number, device_id, staff_id, issued_at,
      seller_name, seller_tax_id, branch_code, pos_id, vat_registered, vat_bps, service_bps, price_mode,
      subtotal, service_charge, vat, net_before_vat, total, rounding, payable, lang)
  values (v_order.org_id, v_order.store_id, v_order.id, v_no, v_dev.id, v_staff, (p ->> 'issued_at')::timestamptz,
      v_ent.name, v_ent.tax_id, v_store.branch_code, v_dev.revenue_pos_id, v_store.vat_registered,
      (p ->> 'vat_bps')::integer, (p ->> 'service_bps')::integer, p ->> 'price_mode',
      v_sub, (p ->> 'service_charge')::bigint, (p ->> 'vat')::bigint, (p ->> 'net_before_vat')::bigint,
      v_total, v_round, v_pay, coalesce(p ->> 'lang', 'th'));

  for x in select * from jsonb_array_elements(p -> 'payments') loop
    insert into public.payments (id, org_id, store_id, order_id, tender, amount, tendered, change, status, staff_id, device_id, created_at)
    values ((x ->> 'id')::uuid, v_order.org_id, v_order.store_id, v_order.id, 'cash',
            (x ->> 'amount')::bigint, (x ->> 'tendered')::bigint, (x ->> 'change')::bigint, 'confirmed', v_staff, v_dev.id,
            coalesce((x ->> 'created_at')::timestamptz, now()));
  end loop;

  update public.orders set status = 'paid', closed_at = coalesce((p ->> 'issued_at')::timestamptz, now()) where id = v_order.id;
  perform public.audit_record(v_order.org_id, v_order.store_id, 'payment.tender', 'orders', v_order.id::text,
    jsonb_build_object('tender', 'cash', 'amount', v_pay), 'db');
  perform set_config('bestie.paying', '', true);
end $$;
revoke all on function public.close_order(jsonb) from public, anon;
grant execute on function public.close_order(jsonb) to authenticated, service_role;
