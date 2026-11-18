-- Bestie POS · migration 25 · split tender: one bill paid with a mix of cash and Bestie Credit (any number of payers).
--
-- `close_order_tenders` is the ONLINE closing function for bills that are not a single cash payment from the till:
--  * legs: cash (amount, tendered, change) and credit (amount); the legs must add up to the amount due exactly;
--  * a Credit leg needs a customer on the bill, the Credit module switched on in the shop, and a balance — the Credit
--    balance is read for the shop's own legal entity only (Credit cannot cross companies);
--  * the receipt is numbered by the SERVER in the device's "+" series (online receipts), so it needs no offline counter;
--  * everything is one transaction: the receipt, the payments, the Credit spend (one balanced posting) and Points earned;
--  * sending the same request again (lost answer) returns the first receipt and changes nothing.
-- PromptPay / card legs are not mixed in yet: those stay a whole-bill payment through the payment provider.

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
  if v_paid <> v_pay then raise exception 'payments do not cover the amount due' using errcode = '23514'; end if;

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
