-- Bestie POS · migration 44 · SEVERAL PromptPay / card shares on one bill (the owner chose: the bill holds the money already paid).
--
--  * A PromptPay / card attempt may be one of several shares (`snapshot.partial`). When the provider confirms it, the share is HELD on the bill
--    (`order_partial_payments`): no receipt, the bill stays open and is LOCKED (no new lines, no changes of quantity / price, no void or merge)
--    so what was paid always matches the bill. The LAST attempt (and any cash / Credit closing) pays what remains and the one closing books
--    the receipt with every share as a payment (`finalize_order_payment` adds the held shares itself and checks the sum).
--  * If the customers give up, a manager with `refund.create` releases the shares (`release_partial_payments`): they become `refund_needed`,
--    the managers are told, the bill is unlocked, and the money is refunded by hand in Stripe, then marked (`mark_partial_refunded`).
create table public.order_partial_payments (
  id          uuid primary key,                         -- the payment attempt's id
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  order_id    uuid not null references public.orders (id),
  tender      text not null check (tender in ('promptpay', 'gateway')),
  amount      bigint not null check (amount > 0),
  provider_ref text not null check (length(provider_ref) <= 100),
  status      text not null default 'held' check (status in ('held', 'applied', 'refund_needed', 'refunded')),
  note        text check (note is null or length(note) <= 200),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);
create index order_partial_payments_order_idx on public.order_partial_payments (order_id);
alter table public.order_partial_payments enable row level security;
create policy order_partial_payments_read on public.order_partial_payments for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.order_partial_payments from anon, authenticated;
grant select on public.order_partial_payments to authenticated;
create trigger order_partial_payments_live after insert or update on public.order_partial_payments for each row execute function public.live_ping_row('store:{store_id}');

create or replace function public.order_held_total(p_order uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(amount), 0)::bigint from public.order_partial_payments where order_id = p_order and status = 'held'
$$;
revoke all on function public.order_held_total(uuid) from public, anon, authenticated;

-- ── the bill is locked while shares are held ──
create or replace function public.lines_locked_by_held() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_order uuid := case when tg_op = 'DELETE' then old.order_id else new.order_id end;
begin
  if coalesce(current_setting('bestie.paying', true), '') = 'on' or public.order_held_total(v_order) = 0 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and new.order_id = old.order_id and new.quantity = old.quantity and new.unit_price = old.unit_price
     and (new.status = old.status or new.status <> 'void') then
    return new;                                    -- the kitchen moving a line forward is fine
  end if;
  raise exception 'a part of this bill is already paid' using errcode = '55006';
end $$;
create trigger order_lines_locked_by_held before insert or update or delete on public.order_lines for each row execute function public.lines_locked_by_held();

create or replace function public.orders_locked_by_held() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if public.order_held_total(new.id) = 0 or coalesce(current_setting('bestie.paying', true), '') = 'on' then return new; end if;
  if (new.status = 'void' and old.status <> 'void')
     or new.points_used is distinct from old.points_used or new.points_discount is distinct from old.points_discount
     or new.customer_id is distinct from old.customer_id then
    raise exception 'a part of this bill is already paid' using errcode = '55006';
  end if;
  return new;
end $$;
create trigger orders_locked_by_held_trg before update on public.orders for each row execute function public.orders_locked_by_held();

create or replace function public.finalize_order_payment(
  p_order uuid, p_device uuid, p_staff uuid, p_receipt_no text, p_issued timestamptz, p_snapshot jsonb, p_payments jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_store public.stores%rowtype;
  v_ent   public.legal_entities%rowtype;
  v_dev   public.devices%rowtype;
  v_sub   bigint;
  v_rule  jsonb;
  v_step  bigint;
  v_spend bigint;
  v_pts   bigint;
  v_disc  bigint := coalesce((p_snapshot ->> 'points_discount')::bigint, 0);
  v_used  bigint := 0;
  v_held  bigint;
  x       jsonb;
begin
  select * into v_order from public.orders where id = p_order;
  select * into v_store from public.stores s where s.id = v_order.store_id;
  select * into v_ent from public.legal_entities e where e.id = v_store.legal_entity_id;
  select * into v_dev from public.devices d where d.id = p_device;
  select coalesce(sum(l.unit_price::bigint * l.quantity), 0) into v_sub
    from public.order_lines l where l.order_id = v_order.id and l.status <> 'void';
  select o.points_rule into v_rule from public.orgs o where o.id = v_order.org_id;
  -- PromptPay / card shares already paid on this bill are part of the closing: the new payments must cover the rest exactly
  v_held := public.order_held_total(p_order);
  if coalesce((select sum((e ->> 'amount')::bigint) from jsonb_array_elements(p_payments) e), 0) + v_held <> (p_snapshot ->> 'payable')::bigint then
    raise exception 'payments do not cover the amount due' using errcode = '23514';
  end if;

  v_step := coalesce(case when (v_rule ->> 'redeemSatangPerPoint') ~ '^[0-9]+$' then (v_rule ->> 'redeemSatangPerPoint')::bigint end, 100);
  if v_step < 1 or v_step > 10000 then v_step := 100; end if;
  if v_disc < 0 or v_disc > v_order.points_discount then
    raise exception 'the points discount is more than the bill holds' using errcode = '23514';
  end if;
  if v_disc > 0 then v_used := (v_disc + v_step - 1) / v_step; end if;     -- points actually consumed (rounded up)
  if v_used > v_order.points_used then v_used := v_order.points_used; end if;

  perform set_config('bestie.paying', 'on', true);
  insert into public.receipts (org_id, store_id, order_id, number, device_id, staff_id, issued_at,
      seller_name, seller_tax_id, branch_code, pos_id, vat_registered, vat_bps, service_bps, price_mode,
      subtotal, service_charge, vat, net_before_vat, total, rounding, payable, lang, points_used, points_discount)
  values (v_order.org_id, v_order.store_id, v_order.id, p_receipt_no, v_dev.id, p_staff, p_issued,
      v_ent.name, v_ent.tax_id, v_store.branch_code, v_dev.revenue_pos_id, v_store.vat_registered,
      (p_snapshot ->> 'vat_bps')::integer, (p_snapshot ->> 'service_bps')::integer, p_snapshot ->> 'price_mode',
      v_sub, (p_snapshot ->> 'service_charge')::bigint, (p_snapshot ->> 'vat')::bigint, (p_snapshot ->> 'net_before_vat')::bigint,
      (p_snapshot ->> 'total')::bigint, coalesce((p_snapshot ->> 'rounding')::integer, 0), (p_snapshot ->> 'payable')::bigint,
      coalesce(p_snapshot ->> 'lang', 'th'), v_used::integer, v_disc);
  for x in select * from jsonb_array_elements(p_payments) loop
    insert into public.payments (id, org_id, store_id, order_id, tender, amount, tendered, change, status, reference, staff_id, device_id, created_at)
    values ((x ->> 'id')::uuid, v_order.org_id, v_order.store_id, v_order.id, x ->> 'tender', (x ->> 'amount')::bigint,
            nullif(x ->> 'tendered', '')::bigint, coalesce((x ->> 'change')::bigint, 0), 'confirmed', x ->> 'reference', p_staff, v_dev.id,
            coalesce((x ->> 'created_at')::timestamptz, now()));
  end loop;
  insert into public.payments (id, org_id, store_id, order_id, tender, amount, tendered, change, status, reference, staff_id, device_id, created_at)
  select h.id, h.org_id, h.store_id, h.order_id, h.tender, h.amount, null, 0, 'confirmed', h.provider_ref, p_staff, v_dev.id, h.created_at
    from public.order_partial_payments h where h.order_id = v_order.id and h.status = 'held';
  update public.order_partial_payments set status = 'applied', resolved_at = now() where order_id = v_order.id and status = 'held';
  update public.orders set status = 'paid', closed_at = p_issued where id = v_order.id;
  perform public.audit_record(v_order.org_id, v_order.store_id, 'payment.tender', 'orders', v_order.id::text,
    jsonb_build_object('tender', (p_payments -> 0) ->> 'tender', 'amount', (p_snapshot ->> 'payable')::bigint), 'db');

  -- points held for this bill but not used (the bill changed): give them back
  if v_order.points_used > v_used and v_order.customer_id is not null then
    insert into public.points_ledger (org_id, customer_id, store_id, kind, points, order_id, created_by)
    values (v_order.org_id, v_order.customer_id, v_order.store_id, 'reverse_redeem', (v_order.points_used - v_used)::integer, v_order.id, p_staff);
  end if;

  -- Bestie Points earned from THB spend only (never the Points discount, never from buying Credit)
  if v_order.customer_id is not null then
    v_step := coalesce(case when (v_rule ->> 'earnSatangPerPoint') ~ '^[0-9]+$' then (v_rule ->> 'earnSatangPerPoint')::bigint end, 2500);
    if v_step < 100 or v_step > 1000000 then v_step := 2500; end if;
    select coalesce(sum(py.amount), 0) into v_spend from public.payments py
     where py.order_id = v_order.id and py.status = 'confirmed'
       and (py.tender in ('cash', 'promptpay', 'gateway')
            or (py.tender = 'credit' and coalesce((v_rule ->> 'creditEarnsPoints')::boolean, true)));
    v_pts := v_spend / v_step;
    if v_pts > 0 then
      insert into public.points_ledger (org_id, customer_id, store_id, kind, points, order_id, created_by)
      values (v_order.org_id, v_order.customer_id, v_order.store_id, 'earn', v_pts::integer, v_order.id, p_staff)
      on conflict (order_id) where kind = 'earn' do nothing;
    end if;
  end if;
  perform set_config('bestie.paying', '', true);
end $$;

revoke all on function public.finalize_order_payment(uuid, uuid, uuid, text, timestamptz, jsonb, jsonb) from public, anon, authenticated;

create or replace function public.begin_payment_attempt(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_dev   public.devices%rowtype;
  v_sub   bigint;
  v_pay   bigint := (p ->> 'payable')::bigint;
  v_tender text := p ->> 'tender';
  v_staff uuid;
  v_id    uuid;
  v_legs  jsonb := coalesce(p -> 'legs', '[]'::jsonb);
  v_other bigint := 0;
  v_credit bigint := 0;
  v_amount bigint;
  v_held  bigint;
  v_partial boolean := coalesce((p ->> 'partial')::boolean, false);
  x       jsonb;
begin
  select * into v_order from public.orders where id = (p ->> 'order_id')::uuid for update;
  if not found then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  if not (public.has_permission(v_order.org_id, 'payment.take') and public.can_access_store(v_order.org_id, v_order.store_id)) then
    raise exception 'taking payment needs payment.take' using errcode = '42501';
  end if;
  if v_order.status in ('paid', 'void') then
    raise exception 'order is already closed' using errcode = '23514';
  end if;
  if v_tender not in ('promptpay', 'gateway') then
    raise exception 'unknown tender' using errcode = '22023';
  end if;
  if not public.tender_module_on(v_order.store_id, v_tender) then
    raise exception 'this payment method is switched off in this shop' using errcode = '0A000';
  end if;
  select * into v_dev from public.devices d where d.id = (p ->> 'device_id')::uuid and d.store_id = v_order.store_id and d.active;
  if not found then
    raise exception 'device is not part of this shop' using errcode = '23514';
  end if;
  if v_tender = 'gateway' and v_dev.stripe_reader_id is null then
    raise exception 'this device has no card reader' using errcode = '23514';
  end if;
  select coalesce(sum(l.unit_price::bigint * l.quantity), 0) into v_sub
    from public.order_lines l where l.order_id = v_order.id and l.status <> 'void';
  if v_sub <> (p ->> 'subtotal')::bigint then
    raise exception 'the bill changed since it was shown' using errcode = '23514';
  end if;
  -- everything the receipt will need must be here NOW: a confirmation arriving after the guest paid must never fail on a missing field
  if exists (
       select 1 from unnest(array['service_charge', 'vat', 'net_before_vat', 'total', 'vat_bps', 'service_bps']) k
       where jsonb_typeof(p -> k) is distinct from 'number' or (p ->> k) !~ '^[0-9]+$')
     or (p ->> 'price_mode') not in ('inclusive', 'exclusive') or coalesce(p ->> 'lang', 'th') not in ('th', 'en') then
    raise exception 'the bill snapshot is incomplete' using errcode = '23514';
  end if;
  -- a whole-bill digital payment is charged to the satang; a split bill carries its cash / Credit legs in the snapshot and the
  -- digital leg is what is left of the amount due (cash rounding applies to the cash legs only)
  if jsonb_typeof(v_legs) is distinct from 'array' or jsonb_array_length(v_legs) > 29 then
    raise exception 'the split legs are not valid' using errcode = '22023';
  end if;
  v_held := public.order_held_total(v_order.id);
  if v_partial then
    -- one of several PromptPay / card shares: it charges exactly `partial_amount`, books nothing until confirmed, and leaves something to pay
    if jsonb_array_length(v_legs) <> 0 or jsonb_typeof(p -> 'partial_amount') is distinct from 'number'
       or (p ->> 'partial_amount') !~ '^[0-9]+$' or (p ->> 'partial_amount')::bigint <= 0 then
      raise exception 'the share is not valid' using errcode = '22023';
    end if;
    if v_pay <> (p ->> 'total')::bigint + coalesce((p ->> 'rounding')::integer, 0) or abs(coalesce((p ->> 'rounding')::integer, 0)) > 100 then
      raise exception 'totals do not add up' using errcode = '23514';
    end if;
    v_amount := (p ->> 'partial_amount')::bigint;
    if v_amount >= v_pay - v_held then
      raise exception 'a share that is not the last must leave something to pay' using errcode = '23514';
    end if;
  elsif jsonb_array_length(v_legs) = 0 then
    if v_pay <> (p ->> 'total')::bigint or coalesce((p ->> 'rounding')::integer, 0) <> 0 or v_pay <= 0 then
      raise exception 'totals do not add up' using errcode = '23514';
    end if;
    v_amount := v_pay - v_held;                 -- what is left after the shares already paid
    if v_amount <= 0 then raise exception 'nothing left to pay' using errcode = '23514'; end if;
  else
    if v_pay <> (p ->> 'total')::bigint + coalesce((p ->> 'rounding')::integer, 0) or abs(coalesce((p ->> 'rounding')::integer, 0)) > 100 then
      raise exception 'totals do not add up' using errcode = '23514';
    end if;
    for x in select * from jsonb_array_elements(v_legs) loop
      if x ->> 'tender' not in ('cash', 'credit') then
        raise exception 'a split bill can mix one PromptPay / card payment with cash and Bestie Credit only' using errcode = '23514';
      end if;
      if jsonb_typeof(x -> 'amount') is distinct from 'number' or (x ->> 'amount') !~ '^[0-9]+$' or (x ->> 'amount')::bigint <= 0
         or (x ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'every payment needs an id and a positive amount' using errcode = '23514';
      end if;
      if x ->> 'tender' = 'cash' then
        if jsonb_typeof(x -> 'tendered') is distinct from 'number' or (x ->> 'tendered')::bigint < (x ->> 'amount')::bigint
           or coalesce((x ->> 'change')::bigint, -1) <> (x ->> 'tendered')::bigint - (x ->> 'amount')::bigint then
          raise exception 'cash amounts do not add up' using errcode = '23514';
        end if;
      else
        v_credit := v_credit + (x ->> 'amount')::bigint;
      end if;
      v_other := v_other + (x ->> 'amount')::bigint;
    end loop;
    v_amount := v_pay - v_held - v_other;
    if v_amount <= 0 then raise exception 'the PromptPay / card share must be more than zero' using errcode = '23514'; end if;
    if v_credit > 0 then
      if not public.credit_enabled(v_order.store_id) then raise exception 'Bestie Credit is switched off in this shop' using errcode = '0A000'; end if;
      if v_order.customer_id is null then raise exception 'put a customer on the bill to use Credit' using errcode = '23514'; end if;
      if (select coalesce(sum(l.amount), 0) from public.credit_ledger l
           where l.customer_id = v_order.customer_id
             and l.legal_entity_id = (select s.legal_entity_id from public.stores s where s.id = v_order.store_id)) < v_credit then
        raise exception 'not enough Credit' using errcode = '23514';
      end if;
    end if;
  end if;
  v_staff := nullif(p ->> 'staff_id', '')::uuid;
  if v_staff is not null and not exists (select 1 from public.staff s where s.id = v_staff and s.org_id = v_order.org_id) then
    v_staff := null;
  end if;
  insert into public.payment_attempts (org_id, store_id, order_id, device_id, staff_id, tender, amount, snapshot)
  values (v_order.org_id, v_order.store_id, v_order.id, v_dev.id, v_staff, v_tender, v_amount, p)
  returning id into v_id;   -- a second live attempt for the same bill hits the unique index (23505): cancel the first one
  return v_id;
end $$;

revoke all on function public.begin_payment_attempt(jsonb) from public, anon;
grant execute on function public.begin_payment_attempt(jsonb) to authenticated, service_role;

create or replace function public.confirm_payment_attempt(p_attempt uuid, p_ref text, p_amount bigint, p_currency text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  a        public.payment_attempts%rowtype;
  v_order  public.orders%rowtype;
  v_dev    public.devices%rowtype;
  v_store  public.stores%rowtype;
  v_sub    bigint;
  v_no     text;
  v_why    text;
  v_bal    bigint;
  v_legs   jsonb;
  v_credit bigint := 0;
  v_pays   jsonb;
  v_held   bigint;
begin
  select * into a from public.payment_attempts where id = p_attempt for update;
  if not found then
    raise exception 'attempt not found' using errcode = 'P0002';
  end if;
  if a.status = 'succeeded' then return 'already'; end if;

  if a.kind = 'credit_topup' then
    select * into v_store from public.stores where id = a.store_id;
    select coalesce(sum(l.amount), 0) into v_bal from public.credit_ledger l
     where l.customer_id = a.customer_id and l.legal_entity_id = v_store.legal_entity_id;
    v_why := case
      when a.provider_ref is not null and a.provider_ref <> p_ref then 'reference mismatch'
      when p_amount <> a.amount then 'amount differs'
      when lower(p_currency) <> 'thb' then 'currency differs'
      when not public.credit_enabled(a.store_id) then 'Credit was switched off'
      when v_bal + a.amount > 20000000 then 'balance cap exceeded'
      when not exists (select 1 from public.customers c where c.id = a.customer_id and c.deleted_at is null) then 'customer removed'
      else null end;
    if v_why is not null then
      update public.payment_attempts set status = 'needs_review', error = v_why, provider_ref = coalesce(provider_ref, p_ref) where id = a.id;
      perform public.audit_record(a.org_id, a.store_id, 'payment.tender', 'payment_attempts', a.id::text,
        jsonb_build_object('review', true, 'why', v_why, 'amount', p_amount, 'kind', 'credit_topup'), 'db');
      return 'needs_review';
    end if;
    insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, store_id, device_id, kind, amount, funding, debit_account, credit_account, created_by)
    values (a.id, a.org_id, v_store.legal_entity_id, a.customer_id, a.store_id, a.device_id, 'topup', a.amount, a.tender, 'psp_clearing', 'customer_credit', a.staff_id);
    update public.payment_attempts set status = 'succeeded', provider_ref = coalesce(provider_ref, p_ref) where id = a.id;
    perform public.audit_record(a.org_id, a.store_id, 'credit.topup', 'customers', a.customer_id::text,
      jsonb_build_object('amount', a.amount, 'funding', a.tender), 'db');
    return 'paid';
  end if;

  select * into v_order from public.orders where id = a.order_id for update;
  select coalesce(sum(l.unit_price::bigint * l.quantity), 0) into v_sub
    from public.order_lines l where l.order_id = a.order_id and l.status <> 'void';

  v_why := case
    when a.provider_ref is not null and a.provider_ref <> p_ref then 'reference mismatch'
    when p_amount <> a.amount then 'amount differs'
    when lower(p_currency) <> 'thb' then 'currency differs'
    when v_order.status in ('paid', 'void') then 'bill already closed'
    when v_sub <> (a.snapshot ->> 'subtotal')::bigint then 'bill changed'
    else null end;
  -- the cash / Credit legs of a split bill ride along in the snapshot; Credit is re-checked now (it may have been spent meanwhile)
  v_legs := coalesce(a.snapshot -> 'legs', '[]'::jsonb);
  select coalesce(sum((e ->> 'amount')::bigint), 0) into v_credit from jsonb_array_elements(v_legs) e where e ->> 'tender' = 'credit';
  if v_why is null and v_credit > 0 then
    select * into v_store from public.stores where id = a.store_id;
    v_why := case
      when not public.credit_enabled(a.store_id) then 'Credit was switched off'
      when v_order.customer_id is null then 'customer removed from the bill'
      when (select coalesce(sum(l.amount), 0) from public.credit_ledger l
             where l.customer_id = v_order.customer_id and l.legal_entity_id = v_store.legal_entity_id) < v_credit then 'not enough Credit any more'
      else null end;
  end if;
  -- shares already held on the bill must still be what this attempt was sized for (a manager may have released one meanwhile)
  v_held := public.order_held_total(a.order_id);
  if v_why is null and not coalesce((a.snapshot ->> 'partial')::boolean, false)
     and (a.snapshot ->> 'payable')::bigint - v_held - coalesce((select sum((e ->> 'amount')::bigint) from jsonb_array_elements(v_legs) e), 0) <> a.amount then
    v_why := 'the shares already paid changed';
  end if;
  if v_why is not null then
    update public.payment_attempts set status = 'needs_review', error = v_why, provider_ref = coalesce(provider_ref, p_ref) where id = a.id;
    perform public.audit_record(a.org_id, a.store_id, 'payment.tender', 'payment_attempts', a.id::text,
      jsonb_build_object('review', true, 'why', v_why, 'amount', p_amount), 'db');
    return 'needs_review';
  end if;

  if coalesce((a.snapshot ->> 'partial')::boolean, false) then
    -- not the last share: hold it on the bill (no receipt, no closing); the bill is locked until it is paid or a manager releases the shares
    insert into public.order_partial_payments (id, org_id, store_id, order_id, tender, amount, provider_ref)
    values (a.id, a.org_id, a.store_id, a.order_id, a.tender, a.amount, p_ref);
    update public.payment_attempts set status = 'succeeded', provider_ref = coalesce(provider_ref, p_ref) where id = a.id;
    perform public.audit_record(a.org_id, a.store_id, 'payment.split', 'orders', a.order_id::text,
      jsonb_build_object('held', a.amount, 'tender', a.tender), 'db');
    return 'held';
  end if;

  -- the server numbers the receipt: consecutive in this device's "+" series, no gaps for failed attempts
  update public.devices set online_receipt_seq = online_receipt_seq + 1 where id = a.device_id returning * into v_dev;
  v_no := v_dev.code || '+' || lpad(v_dev.online_receipt_seq::text, 6, '0');

  if v_credit > 0 then
    insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, store_id, device_id, kind, amount,
                                      debit_account, credit_account, order_id, created_by)
    values (gen_random_uuid(), a.org_id, v_store.legal_entity_id, v_order.customer_id, a.store_id, a.device_id, 'spend', -v_credit,
            'customer_credit', 'sales', a.order_id, a.staff_id);
    perform public.audit_record(a.org_id, a.store_id, 'credit.spend', 'orders', a.order_id::text,
      jsonb_build_object('amount', v_credit), 'db');
  end if;
  v_pays := coalesce((select jsonb_agg(jsonb_build_object('id', e ->> 'id', 'tender', e ->> 'tender', 'amount', (e ->> 'amount')::bigint,
              'tendered', case when e ->> 'tender' = 'cash' then e -> 'tendered' end,
              'change', case when e ->> 'tender' = 'cash' then e -> 'change' end))
            from jsonb_array_elements(v_legs) e), '[]'::jsonb)
         || jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'tender', a.tender, 'amount', a.amount,
                                                 'reference', p_ref, 'created_at', now()));
  perform public.finalize_order_payment(a.order_id, a.device_id, a.staff_id, v_no, now(), a.snapshot, v_pays);
  update public.payment_attempts set status = 'succeeded', provider_ref = coalesce(provider_ref, p_ref) where id = a.id;
  return 'paid';
end $$;

revoke all on function public.confirm_payment_attempt(uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.confirm_payment_attempt(uuid, text, bigint, text) to service_role;

create or replace function public.close_order_tenders(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_order  public.orders%rowtype;
  v_store  public.stores%rowtype;
  v_dev    public.devices%rowtype;
  v_staff  uuid := nullif(p ->> 'staff_id', '')::uuid;
  v_sub    bigint;
  v_total  bigint := (p ->> 'total')::bigint;
  v_round  integer := coalesce((p ->> 'rounding')::integer, 0);
  v_pay    bigint := (p ->> 'payable')::bigint;
  v_paid   bigint := 0;
  v_credit bigint := 0;
  v_held   bigint;
  v_no     text;
  v_first  uuid;
  v_old    public.receipts%rowtype;
  x        jsonb;
begin
  select * into v_order from public.orders where id = (p ->> 'order_id')::uuid for update;
  if not found then raise exception 'order not found' using errcode = 'P0002'; end if;
  if not (public.has_permission(v_order.org_id, 'payment.take') and public.can_access_store(v_order.org_id, v_order.store_id)) then
    raise exception 'taking payment needs payment.take' using errcode = '42501';
  end if;
  if jsonb_typeof(p -> 'payments') is distinct from 'array' or jsonb_array_length(p -> 'payments') not between 1 and 30 then
    raise exception 'between 1 and 30 payments are needed' using errcode = '22023';
  end if;

  -- the same close arriving twice: answer with the receipt it already made
  v_first := ((p -> 'payments') -> 0 ->> 'id')::uuid;
  if exists (select 1 from public.payments py where py.id = v_first and py.order_id = v_order.id) then
    select r.* into v_old from public.receipts r where r.order_id = v_order.id;
    return jsonb_build_object('receipt_number', v_old.number, 'replay', true);
  end if;
  if v_order.status in ('paid', 'void') then raise exception 'order is already closed' using errcode = '23514'; end if;

  select * into v_store from public.stores where id = v_order.store_id;
  select * into v_dev from public.devices d where d.id = (p ->> 'device_id')::uuid and d.store_id = v_order.store_id and d.active;
  if not found then raise exception 'device is not part of this shop' using errcode = '23514'; end if;

  select coalesce(sum(l.unit_price::bigint * l.quantity), 0) into v_sub
    from public.order_lines l where l.order_id = v_order.id and l.status <> 'void';
  if v_sub <> (p ->> 'subtotal')::bigint then raise exception 'the bill changed since it was shown' using errcode = '23514'; end if;
  if v_pay <> v_total + v_round or abs(v_round) > 100 or v_pay <= 0 then raise exception 'totals do not add up' using errcode = '23514'; end if;
  if exists (select 1 from public.order_lines l where l.order_id = v_order.id and l.status = 'new') then
    raise exception 'send the new lines to the kitchen first' using errcode = '55000';
  end if;

  for x in select * from jsonb_array_elements(p -> 'payments') loop
    if x ->> 'tender' not in ('cash', 'credit') then
      raise exception 'only cash and Bestie Credit can be mixed here' using errcode = '23514';
    end if;
    if jsonb_typeof(x -> 'amount') is distinct from 'number' or (x ->> 'amount') !~ '^[0-9]+$' or (x ->> 'amount')::bigint <= 0 then
      raise exception 'every payment needs a positive amount' using errcode = '23514';
    end if;
    if x ->> 'tender' = 'cash' then
      if jsonb_typeof(x -> 'tendered') is distinct from 'number' or (x ->> 'tendered')::bigint < (x ->> 'amount')::bigint
         or coalesce((x ->> 'change')::bigint, -1) <> (x ->> 'tendered')::bigint - (x ->> 'amount')::bigint then
        raise exception 'cash amounts do not add up' using errcode = '23514';
      end if;
    else
      v_credit := v_credit + (x ->> 'amount')::bigint;
    end if;
    v_paid := v_paid + (x ->> 'amount')::bigint;
  end loop;
  v_held := public.order_held_total(v_order.id);
  if v_paid + v_held <> v_pay then raise exception 'payments do not cover the amount due' using errcode = '23514'; end if;

  if v_credit > 0 then
    if not public.credit_enabled(v_store.id) then raise exception 'Bestie Credit is switched off in this shop' using errcode = '0A000'; end if;
    if v_order.customer_id is null then raise exception 'put a customer on the bill to use Credit' using errcode = '23514'; end if;
    if (select coalesce(sum(l.amount), 0) from public.credit_ledger l
         where l.customer_id = v_order.customer_id and l.legal_entity_id = v_store.legal_entity_id) < v_credit then
      raise exception 'not enough Credit' using errcode = '23514';
    end if;
  end if;
  if v_staff is not null and not exists (select 1 from public.staff s where s.id = v_staff and s.org_id = v_order.org_id) then
    v_staff := null;
  end if;

  -- the server numbers the receipt (consecutive "+" series of this device)
  update public.devices set online_receipt_seq = online_receipt_seq + 1 where id = v_dev.id returning * into v_dev;
  v_no := v_dev.code || '+' || lpad(v_dev.online_receipt_seq::text, 6, '0');

  if v_credit > 0 then
    insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, store_id, device_id, kind, amount,
                                      debit_account, credit_account, order_id, created_by)
    values (gen_random_uuid(), v_order.org_id, v_store.legal_entity_id, v_order.customer_id, v_store.id, v_dev.id, 'spend', -v_credit,
            'customer_credit', 'sales', v_order.id, v_staff);
    perform public.audit_record(v_order.org_id, v_store.id, 'credit.spend', 'orders', v_order.id::text,
      jsonb_build_object('amount', v_credit), 'db');
  end if;

  perform public.finalize_order_payment(v_order.id, v_dev.id, v_staff, v_no, coalesce((p ->> 'issued_at')::timestamptz, now()),
    p, (select jsonb_agg(jsonb_build_object('id', e ->> 'id', 'tender', e ->> 'tender', 'amount', (e ->> 'amount')::bigint,
          'tendered', case when e ->> 'tender' = 'cash' then e -> 'tendered' end,
          'change', case when e ->> 'tender' = 'cash' then e -> 'change' end))
        from jsonb_array_elements(p -> 'payments') e));
  return jsonb_build_object('receipt_number', v_no, 'replay', false);
end $$;

revoke all on function public.close_order_tenders(jsonb) from public, anon;
grant execute on function public.close_order_tenders(jsonb) to authenticated, service_role;

-- ── a manager gives up on a bill that holds shares ──
create or replace function public.release_partial_payments(p_order uuid, p_note text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders%rowtype;
  v_total bigint;
  u uuid;
begin
  select * into o from public.orders where id = p_order for update;
  if not found or not (public.can_access_store(o.org_id, o.store_id) and public.has_permission(o.org_id, 'refund.create')) then
    raise exception 'releasing paid shares needs refund.create' using errcode = '42501';
  end if;
  if o.status in ('paid', 'void') then raise exception 'order is already closed' using errcode = '23514'; end if;
  v_total := public.order_held_total(p_order);
  if v_total = 0 then return 0; end if;
  update public.order_partial_payments set status = 'refund_needed', resolved_at = now(), note = left(coalesce(p_note, ''), 200)
   where order_id = p_order and status = 'held';
  perform public.audit_record(o.org_id, o.store_id, 'payment.refund', 'orders', p_order::text,
    jsonb_build_object('refund_needed', v_total), 'db');
  for u in select distinct s.user_id from public.staff s join public.roles r on r.id = s.role_id
            where s.org_id = o.org_id and s.active and s.user_id is not null and (s.store_id is null or s.store_id = o.store_id)
              and (r.built_in in ('owner', 'manager') or 'refund.create' = any (r.permissions)) loop
    perform public.notify_user(jsonb_build_object('user_id', u, 'org_id', o.org_id, 'kind', 'payment.review', 'urgent', true, 'href', '/orders',
      'dedupe', 'release:' || p_order || ':' || v_total,
      'title', jsonb_build_object('th', 'ต้องคืนเงินลูกค้าที่ Stripe ' || (v_total / 100) || ' บาท (บิล ' || o.number || ')',
                                  'en', 'Refund ' || (v_total / 100) || ' THB in Stripe (bill ' || o.number || ')'),
      'body', jsonb_build_object('th', 'ลูกค้าจ่ายบางส่วนแล้วยกเลิกบิล ให้คืนเงินด้วยมือที่ Stripe แล้วกดว่าคืนแล้ว', 'en', 'Guests paid part of the bill, then gave up. Refund in Stripe by hand, then mark it refunded.')));
  end loop;
  return v_total;
end $$;
revoke all on function public.release_partial_payments(uuid, text) from public, anon;
grant execute on function public.release_partial_payments(uuid, text) to authenticated, service_role;

create or replace function public.mark_partial_refunded(p_partial uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare h public.order_partial_payments%rowtype;
begin
  select * into h from public.order_partial_payments where id = p_partial for update;
  if not found or not (public.can_access_store(h.org_id, h.store_id) and public.has_permission(h.org_id, 'refund.create')) then
    raise exception 'marking a refund needs refund.create' using errcode = '42501';
  end if;
  if h.status = 'refund_needed' then
    update public.order_partial_payments set status = 'refunded', resolved_at = now() where id = h.id;
    perform public.audit_record(h.org_id, h.store_id, 'payment.refund', 'orders', h.order_id::text, jsonb_build_object('refunded', h.amount), 'db');
  end if;
end $$;
revoke all on function public.mark_partial_refunded(uuid) from public, anon;
grant execute on function public.mark_partial_refunded(uuid) to authenticated, service_role;
