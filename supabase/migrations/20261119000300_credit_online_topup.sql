-- Bestie POS · migration 32 · Bestie Credit top-up by PromptPay QR or card reader (Stripe), through the SAME payment-attempt machinery as a bill.
--
--  * A top-up is a `payment_attempts` row of kind 'credit_topup' (no bill, a customer instead). The till asks
--    (`begin_credit_topup_attempt`: permission, Credit switched on, amount limits, balance cap), the server creates the Stripe
--    PaymentIntent, and ONLY the signed webhook credits the customer (`confirm_payment_attempt` → the ledger row).
--  * The ledger row's id IS the attempt id, so a webhook delivered twice can never credit twice.
--  * Anything unusual (amount / currency / reference differ, Credit switched off meanwhile, cap exceeded) becomes `needs_review`:
--    money may have moved, so it is never silently credited or dropped.
--  * Credit funded this way has funding promptpay / gateway and a psp_clearing debit account. Still no cash-out, still no crypto.
--  * A notice goes to the managers (payment.paid / payment.review) like for a bill, worded as a top-up.


-- ── are PromptPay / card switched on in this shop? (the owner's "payment methods" screen writes module_overrides) ──
-- Mirrors the registry: tender.promptpay is on for every profile, tender.gateway for none; both from the basic plan up.
-- registry:tender.promptpay profiles=all plan=basic,pro,resort
-- registry:tender.gateway profiles= plan=basic,pro,resort
create or replace function public.tender_module_on(p_store uuid, p_tender text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when p_tender in ('promptpay', 'gateway') then
    coalesce((select (s.module_overrides ->> ('tender.' || p_tender))::boolean from public.stores s
               where s.id = p_store and s.module_overrides ? ('tender.' || p_tender)),
             p_tender = 'promptpay')
  else false end
$$;
revoke all on function public.tender_module_on(uuid, text) from public, anon, authenticated;
grant execute on function public.tender_module_on(uuid, text) to service_role;

alter table public.payment_attempts
  add column kind text not null default 'bill' check (kind in ('bill', 'credit_topup')),
  add column customer_id uuid references public.customers (id);
alter table public.payment_attempts alter column order_id drop not null;
alter table public.payment_attempts add constraint payment_attempts_kind_ck check (
  (kind = 'bill' and order_id is not null and customer_id is null)
  or (kind = 'credit_topup' and order_id is null and customer_id is not null));
-- one live top-up per customer (the same idea as one live payment per bill)
create unique index payment_attempts_topup_live_uidx on public.payment_attempts (customer_id)
  where kind = 'credit_topup' and status in ('created', 'pending');

-- ── the till asks for a top-up ─────────────────────────────────────────────
-- p = { customer_id, store_id, device_id, tender: 'promptpay' | 'gateway', amount (satang) }
create or replace function public.begin_credit_topup_attempt(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_store  public.stores%rowtype;
  v_cust   public.customers%rowtype;
  v_dev    public.devices%rowtype;
  v_amount bigint := (p ->> 'amount')::bigint;
  v_tender text := p ->> 'tender';
  v_staff  uuid;
  v_bal    bigint;
  v_id     uuid;
begin
  select * into v_store from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found then raise exception 'shop not found' using errcode = 'P0002'; end if;
  if not (public.has_permission(v_store.org_id, 'payment.take') and public.has_permission(v_store.org_id, 'customer.view')
          and public.can_access_store(v_store.org_id, v_store.id)) then
    raise exception 'topping up needs payment.take' using errcode = '42501';
  end if;
  if not public.credit_enabled(v_store.id) then
    raise exception 'Bestie Credit is switched off in this shop' using errcode = '0A000';
  end if;
  if v_tender not in ('promptpay', 'gateway') then
    raise exception 'unknown tender' using errcode = '22023';
  end if;
  if v_amount is null or v_amount < 10000 or v_amount > 5000000 then
    raise exception 'a top-up is between 100.00 and 50,000.00' using errcode = '22023';
  end if;
  if not public.tender_module_on(v_store.id, v_tender) then
    raise exception 'this payment method is switched off in this shop' using errcode = '0A000';
  end if;
  select * into v_cust from public.customers where id = (p ->> 'customer_id')::uuid and org_id = v_store.org_id and deleted_at is null for update;
  if not found then raise exception 'customer not found' using errcode = 'P0002'; end if;
  select coalesce(sum(amount), 0) into v_bal from public.credit_ledger where customer_id = v_cust.id and legal_entity_id = v_store.legal_entity_id;
  if v_bal + v_amount > 20000000 then
    raise exception 'the balance may not exceed 200,000.00' using errcode = '22023';
  end if;
  select * into v_dev from public.devices d where d.id = (p ->> 'device_id')::uuid and d.store_id = v_store.id and d.active;
  if not found then raise exception 'device is not part of this shop' using errcode = '23514'; end if;
  if v_tender = 'gateway' and v_dev.stripe_reader_id is null then
    raise exception 'this device has no card reader' using errcode = '23514';
  end if;
  select s.id into v_staff from public.staff s where s.org_id = v_store.org_id and s.user_id = auth.uid() and s.active limit 1;
  insert into public.payment_attempts (org_id, store_id, order_id, customer_id, kind, device_id, staff_id, tender, amount, snapshot)
  values (v_store.org_id, v_store.id, null, v_cust.id, 'credit_topup', v_dev.id, v_staff, v_tender, v_amount,
          jsonb_build_object('kind', 'credit_topup', 'customer_id', v_cust.id, 'amount', v_amount))
  returning id into v_id;     -- a second live top-up for the same customer hits the unique index (23505)
  return v_id;
end $$;
revoke all on function public.begin_credit_topup_attempt(jsonb) from public, anon;
grant execute on function public.begin_credit_topup_attempt(jsonb) to authenticated, service_role;

-- ── a bill's online payment now respects the shop's payment-method switches ──
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
  -- no cash rounding on digital tenders: the amount charged is exactly the bill
  if v_pay <> (p ->> 'total')::bigint or coalesce((p ->> 'rounding')::integer, 0) <> 0 or v_pay <= 0 then
    raise exception 'totals do not add up' using errcode = '23514';
  end if;
  v_staff := nullif(p ->> 'staff_id', '')::uuid;
  if v_staff is not null and not exists (select 1 from public.staff s where s.id = v_staff and s.org_id = v_order.org_id) then
    v_staff := null;
  end if;
  insert into public.payment_attempts (org_id, store_id, order_id, device_id, staff_id, tender, amount, snapshot)
  values (v_order.org_id, v_order.store_id, v_order.id, v_dev.id, v_staff, v_tender, v_pay, p)
  returning id into v_id;   -- a second live attempt for the same bill hits the unique index (23505): cancel the first one
  return v_id;
end $$;
revoke all on function public.begin_payment_attempt(jsonb) from public, anon;
grant execute on function public.begin_payment_attempt(jsonb) to authenticated, service_role;

-- ── the provider confirmed: bills close as before, top-ups credit the customer ──
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
  if v_why is not null then
    update public.payment_attempts set status = 'needs_review', error = v_why, provider_ref = coalesce(provider_ref, p_ref) where id = a.id;
    perform public.audit_record(a.org_id, a.store_id, 'payment.tender', 'payment_attempts', a.id::text,
      jsonb_build_object('review', true, 'why', v_why, 'amount', p_amount), 'db');
    return 'needs_review';
  end if;

  -- the server numbers the receipt: consecutive in this device's "+" series, no gaps for failed attempts
  update public.devices set online_receipt_seq = online_receipt_seq + 1 where id = a.device_id returning * into v_dev;
  v_no := v_dev.code || '+' || lpad(v_dev.online_receipt_seq::text, 6, '0');

  perform public.finalize_order_payment(a.order_id, a.device_id, a.staff_id, v_no, now(),
    a.snapshot,
    jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'tender', a.tender, 'amount', a.amount,
                                         'reference', p_ref, 'created_at', now())));
  update public.payment_attempts set status = 'succeeded', provider_ref = coalesce(provider_ref, p_ref) where id = a.id;
  return 'paid';
end $$;
revoke all on function public.confirm_payment_attempt(uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.confirm_payment_attempt(uuid, text, bigint, text) to service_role;

-- ── the managers' notice says "top-up" for a top-up (and there is no bill number) ──
create or replace function public.notify_payment_attempt() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders%rowtype;
  v_amt text := public.fmt_baht(new.amount);
  v_topup boolean := new.kind = 'credit_topup';
  v_how_th text := case new.tender when 'promptpay' then 'PromptPay' else 'บัตร' end;
  v_how_en text := case new.tender when 'promptpay' then 'PromptPay' else 'card' end;
begin
  if new.status is not distinct from old.status or new.status not in ('succeeded', 'needs_review') then return null; end if;
  if not v_topup then select * into o from public.orders where id = new.order_id; end if;
  if new.status = 'succeeded' then
    perform public.notify_managers(new.org_id, new.store_id, jsonb_build_object(
      'kind', 'payment.paid', 'href', case when v_topup then '/customers' else '/receipt/' || new.order_id end, 'dedupe', 'paid:' || new.id,
      'title', jsonb_build_object(
        'th', case when v_topup then 'เติม Credit แล้ว ' else 'รับเงินแล้ว ' end || v_amt,
        'en', case when v_topup then 'Credit top-up received ' else 'Payment received ' end || v_amt),
      'body', jsonb_build_object(
        'th', 'ชำระผ่าน ' || v_how_th || case when v_topup then '' else E'\nบิล: ' || coalesce(o.number, '-') end || E'\nยอด: ' || v_amt,
        'en', 'Paid by ' || v_how_en || case when v_topup then '' else E'\nBill: ' || coalesce(o.number, '-') end || E'\nAmount: ' || v_amt)));
  else
    perform public.notify_managers(new.org_id, new.store_id, jsonb_build_object(
      'kind', 'payment.review', 'urgent', true, 'href', case when v_topup then '/customers' else '/order/' || new.order_id end, 'dedupe', 'review:' || new.id,
      'title', jsonb_build_object('th', 'เงินเข้าแต่ต้องตรวจสอบ ' || v_amt, 'en', 'Money received, needs a check ' || v_amt),
      'body', jsonb_build_object(
        'th', case when v_topup then 'การเติม Credit' else E'บิล: ' || coalesce(o.number, '-') end || E'\nยอด: ' || v_amt || E'\nห้ามรับเงินซ้ำ ให้ตรวจใน Stripe และหลังร้าน',
        'en', case when v_topup then 'Credit top-up' else E'Bill: ' || coalesce(o.number, '-') end || E'\nAmount: ' || v_amt || E'\nDo not take the money again; check Stripe and the shop')));
  end if;
  return null;
exception when others then
  raise warning 'notify_payment_attempt failed: %', sqlerrm;
  return null;
end $$;
