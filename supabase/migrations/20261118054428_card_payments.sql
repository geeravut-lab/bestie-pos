-- Bestie POS · migration 16 · PromptPay QR + card reader payments through the payment provider (Stripe).
--
--  * a till asks for a payment ATTEMPT (begin_payment_attempt); the provider confirms it by signed webhook, and only then
--    does the SERVER close the bill (confirm_payment_attempt) — the till never declares these tenders paid;
--  * every confirmation is checked: amount and currency equal the attempt, the bill is still open and its lines still add up;
--    anything else becomes `needs_review` for a person (money may have moved) instead of silently closing or ignoring;
--  * receipts for server-confirmed payments use their own consecutive series per device ("A+000001"), numbered by the server,
--    so a failed / cancelled attempt never leaves a gap and the till's offline cash series ("A-000001") is untouched;
--  * the shared closing code is one internal function, used by cash (close_order) and by the provider path.

-- ── schema ─────────────────────────────────────────────────────────────────
alter table public.receipts drop constraint if exists receipts_number_check;
alter table public.receipts add constraint receipts_number_check check (number ~ '^[A-Z]{1,2}[-+][0-9]{6,9}$');

alter table public.devices add column stripe_reader_id text check (stripe_reader_id is null or stripe_reader_id ~ '^tmr_[A-Za-z0-9]{6,60}$');
alter table public.devices add column online_receipt_seq integer not null default 0 check (online_receipt_seq >= 0);

create table public.payment_attempts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  order_id    uuid not null references public.orders (id),
  device_id   uuid not null references public.devices (id),
  staff_id    uuid references public.staff (id),
  tender      text not null check (tender in ('promptpay', 'gateway')),
  amount      bigint not null check (amount > 0 and amount <= 100000000),
  snapshot    jsonb not null,
  provider    text not null default 'stripe',
  provider_ref text unique check (length(provider_ref) <= 100),
  status      text not null default 'created' check (status in ('created', 'pending', 'succeeded', 'failed', 'canceled', 'needs_review')),
  qr_url      text check (length(qr_url) <= 1000),
  error       text check (length(error) <= 200),
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index payment_attempts_live_uidx on public.payment_attempts (order_id) where status in ('created', 'pending');
create index payment_attempts_store_idx on public.payment_attempts (store_id, created_at);
create trigger payment_attempts_touch before update on public.payment_attempts for each row execute function public.touch_updated_at();
create trigger payment_attempts_live after insert or update on public.payment_attempts for each row execute function public.live_ping_row('store:{store_id}');

alter table public.payment_attempts enable row level security;
create policy payment_attempts_read on public.payment_attempts for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.payment_attempts from anon, authenticated;
grant select on public.payment_attempts to authenticated;

create table public.stripe_events (
  id          text primary key check (length(id) <= 100),
  type        text not null check (length(type) <= 100),
  received_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;   -- no policy: service role only
revoke all on public.stripe_events from anon, authenticated;

-- ── the one place a bill gets closed (internal: no grants) ──────────────────
create or replace function public.finalize_order_payment(
  p_order uuid, p_device uuid, p_staff uuid, p_receipt_no text, p_issued timestamptz, p_snapshot jsonb, p_payments jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_store public.stores%rowtype;
  v_ent   public.legal_entities%rowtype;
  v_dev   public.devices%rowtype;
  v_sub   bigint;
  x       jsonb;
begin
  select * into v_order from public.orders where id = p_order;
  select * into v_store from public.stores s where s.id = v_order.store_id;
  select * into v_ent from public.legal_entities e where e.id = v_store.legal_entity_id;
  select * into v_dev from public.devices d where d.id = p_device;
  select coalesce(sum(l.unit_price::bigint * l.quantity), 0) into v_sub
    from public.order_lines l where l.order_id = v_order.id and l.status <> 'void';

  perform set_config('bestie.paying', 'on', true);
  insert into public.receipts (org_id, store_id, order_id, number, device_id, staff_id, issued_at,
      seller_name, seller_tax_id, branch_code, pos_id, vat_registered, vat_bps, service_bps, price_mode,
      subtotal, service_charge, vat, net_before_vat, total, rounding, payable, lang)
  values (v_order.org_id, v_order.store_id, v_order.id, p_receipt_no, v_dev.id, p_staff, p_issued,
      v_ent.name, v_ent.tax_id, v_store.branch_code, v_dev.revenue_pos_id, v_store.vat_registered,
      (p_snapshot ->> 'vat_bps')::integer, (p_snapshot ->> 'service_bps')::integer, p_snapshot ->> 'price_mode',
      v_sub, (p_snapshot ->> 'service_charge')::bigint, (p_snapshot ->> 'vat')::bigint, (p_snapshot ->> 'net_before_vat')::bigint,
      (p_snapshot ->> 'total')::bigint, coalesce((p_snapshot ->> 'rounding')::integer, 0), (p_snapshot ->> 'payable')::bigint,
      coalesce(p_snapshot ->> 'lang', 'th'));
  for x in select * from jsonb_array_elements(p_payments) loop
    insert into public.payments (id, org_id, store_id, order_id, tender, amount, tendered, change, status, reference, staff_id, device_id, created_at)
    values ((x ->> 'id')::uuid, v_order.org_id, v_order.store_id, v_order.id, x ->> 'tender', (x ->> 'amount')::bigint,
            nullif(x ->> 'tendered', '')::bigint, coalesce((x ->> 'change')::bigint, 0), 'confirmed', x ->> 'reference', p_staff, v_dev.id,
            coalesce((x ->> 'created_at')::timestamptz, now()));
  end loop;
  update public.orders set status = 'paid', closed_at = p_issued where id = v_order.id;
  perform public.audit_record(v_order.org_id, v_order.store_id, 'payment.tender', 'orders', v_order.id::text,
    jsonb_build_object('tender', (p_payments -> 0) ->> 'tender', 'amount', (p_snapshot ->> 'payable')::bigint), 'db');
  perform set_config('bestie.paying', '', true);
end $$;
revoke all on function public.finalize_order_payment(uuid, uuid, uuid, text, timestamptz, jsonb, jsonb) from public, anon, authenticated;

-- ── cash from the till (same checks as before, now sharing the closing code) ─
create or replace function public.close_order(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_order  public.orders%rowtype;
  v_dev    public.devices%rowtype;
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
  if exists (select 1 from public.receipts r where r.order_id = v_order.id and r.number = v_no) then
    return; -- the same close arriving twice
  end if;
  if v_order.status in ('paid', 'void') then
    raise exception 'order is already closed' using errcode = '23514';
  end if;
  select * into v_dev from public.devices d where d.id = (p ->> 'device_id')::uuid and d.store_id = v_order.store_id;
  if not found then
    raise exception 'device is not part of this shop' using errcode = '23514';
  end if;
  -- the till's offline series is the "-" one; the "+" series belongs to the server
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
  v_staff := nullif(p ->> 'staff_id', '')::uuid;
  if v_staff is not null and not exists (select 1 from public.staff s where s.id = v_staff and s.org_id = v_order.org_id) then
    v_staff := null;
  end if;
  perform public.finalize_order_payment(v_order.id, v_dev.id, v_staff, v_no, (p ->> 'issued_at')::timestamptz, p, p -> 'payments');
end $$;
revoke all on function public.close_order(jsonb) from public, anon;
grant execute on function public.close_order(jsonb) to authenticated, service_role;

-- ── asking for an online payment ────────────────────────────────────────────
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

-- the till (or a manager) gives up on a pending attempt; the server then cancels it at the provider
create or replace function public.cancel_payment_attempt(p_attempt uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.payment_attempts%rowtype;
  v_reader text;
begin
  select * into a from public.payment_attempts where id = p_attempt for update;
  if not found then
    raise exception 'attempt not found' using errcode = 'P0002';
  end if;
  if not (public.has_permission(a.org_id, 'payment.take') and public.can_access_store(a.org_id, a.store_id)) then
    raise exception 'taking payment needs payment.take' using errcode = '42501';
  end if;
  select d.stripe_reader_id into v_reader from public.devices d where d.id = a.device_id;
  if a.status in ('created', 'pending') then
    update public.payment_attempts set status = 'canceled' where id = a.id;
  end if;
  return jsonb_build_object('status', case when a.status in ('created', 'pending') then 'canceled' else a.status end,
                            'provider_ref', a.provider_ref, 'tender', a.tender, 'reader_id', v_reader);
end $$;
revoke all on function public.cancel_payment_attempt(uuid) from public, anon;
grant execute on function public.cancel_payment_attempt(uuid) to authenticated, service_role;

-- ── server side only (service role): the provider told us something ─────────
create or replace function public.attach_payment_intent(p_attempt uuid, p_ref text, p_qr text, p_expires timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.payment_attempts
     set provider_ref = p_ref, qr_url = p_qr, expires_at = p_expires,
         status = case when status = 'created' then 'pending' else status end
   where id = p_attempt;
end $$;
revoke all on function public.attach_payment_intent(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.attach_payment_intent(uuid, text, text, timestamptz) to service_role;

create or replace function public.fail_payment_attempt(p_attempt uuid, p_status text, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('failed', 'canceled') then
    raise exception 'bad status' using errcode = '22023';
  end if;
  update public.payment_attempts set status = p_status, error = left(p_error, 200)
   where id = p_attempt and status in ('created', 'pending');
end $$;
revoke all on function public.fail_payment_attempt(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fail_payment_attempt(uuid, text, text) to service_role;

-- true the first time an event id is seen (the provider may deliver the same event more than once)
create or replace function public.record_stripe_event(p_id text, p_type text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.stripe_events (id, type) values (p_id, p_type) on conflict (id) do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke all on function public.record_stripe_event(text, text) from public, anon, authenticated;
grant execute on function public.record_stripe_event(text, text) to service_role;

/**
 * The provider says the payment succeeded. Close the bill — or, if anything does not match, park it for a person:
 *   'paid' · 'already' (replay) · 'needs_review' (amount / currency differs, bill already closed or changed).
 */
create or replace function public.confirm_payment_attempt(p_attempt uuid, p_ref text, p_amount bigint, p_currency text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  a        public.payment_attempts%rowtype;
  v_order  public.orders%rowtype;
  v_dev    public.devices%rowtype;
  v_sub    bigint;
  v_no     text;
  v_why    text;
begin
  select * into a from public.payment_attempts where id = p_attempt for update;
  if not found then
    raise exception 'attempt not found' using errcode = 'P0002';
  end if;
  if a.status = 'succeeded' then return 'already'; end if;
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
