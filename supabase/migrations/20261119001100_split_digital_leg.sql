-- Bestie POS · migration 36 · PromptPay / card as ONE leg of a split bill.
--
--  * A split bill may now carry cash and Bestie Credit legs plus ONE PromptPay or card share. The cash / Credit legs travel in the
--    payment attempt's snapshot (`legs`); the attempt's amount is the digital share (amount due minus the other legs; cash rounding
--    applies to the cash legs only).
--  * Nothing is booked until the provider's signed webhook confirms the digital share. Then, in one transaction: the Credit spend
--    (balance re-checked: spent meanwhile / Credit switched off / customer removed -> needs_review, money parked), the receipt,
--    every payment (cash, Credit, digital) and the Points earned.
--  * An attempt without `legs` behaves exactly as before.

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
  if jsonb_array_length(v_legs) = 0 then
    if v_pay <> (p ->> 'total')::bigint or coalesce((p ->> 'rounding')::integer, 0) <> 0 or v_pay <= 0 then
      raise exception 'totals do not add up' using errcode = '23514';
    end if;
    v_amount := v_pay;
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
    v_amount := v_pay - v_other;
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
  v_legs   jsonb;
  v_credit bigint := 0;
  v_pays   jsonb;
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
  if v_why is not null then
    update public.payment_attempts set status = 'needs_review', error = v_why, provider_ref = coalesce(provider_ref, p_ref) where id = a.id;
    perform public.audit_record(a.org_id, a.store_id, 'payment.tender', 'payment_attempts', a.id::text,
      jsonb_build_object('review', true, 'why', v_why, 'amount', p_amount), 'db');
    return 'needs_review';
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

