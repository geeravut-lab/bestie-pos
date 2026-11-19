-- Bestie POS · migration 50 · BILLING an appointment and DEPOSITS (module `deposits`).
--
--  * `appointment_to_order`: an appointment that has started (arrived / in service / done) becomes an ordinary OPEN bill with the service as
--    its one line (numbers AP001…, channel takeaway, the member attached), so the till takes the payment exactly as for any bill: cash,
--    PromptPay, card, Credit, split, receipt, Points. Asking again returns the same bill. When that bill is paid the appointment is marked done.
--  * A DEPOSIT is money the front desk received BEFORE the visit (cash / PromptPay / card). It is recorded against the appointment
--    (`appointment_deposits`); when the bill is made the deposit is put on it as an already-paid share (`order_partial_payments`,
--    kind `deposit`) and the closing adds it to the receipt as a payment of its original method. A deposit share does NOT lock the bill
--    (the guest may still add a product); only PromptPay / card shares held mid-payment (kind `online`) do.
--  * No-show / cancellation: a held deposit is either KEPT (a no-show fee, status `forfeited`) or REFUNDED by hand (status `refunded`, the
--    cash drawer's expected cash goes down), both by someone with `refund.create`, both audited.
--  * The shift's expected cash counts cash deposits taken on the device and subtracts cash deposits refunded from it; a deposit applied on
--    a bill is not counted a second time (its payment carries the reference `deposit:<id>`).
--  The accountant must still say how a deposit and a kept no-show fee are treated for VAT / receipts.

-- ── module mirror ──
-- registry:deposits profiles=salon,spa,resort,tours plan=pro,resort depends=appointments
create or replace function public.deposits_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.appointments_enabled(p_store) and exists (
    select 1 from public.stores s
     where s.id = p_store and s.plan in ('pro', 'resort')
       and coalesce((s.module_overrides ->> 'deposits')::boolean, s.profile in ('salon', 'spa', 'resort', 'tours')))
$$;
revoke all on function public.deposits_enabled(uuid) from public, anon;
grant execute on function public.deposits_enabled(uuid) to authenticated, service_role;

alter table public.appointments add column order_id uuid references public.orders (id);
create index appointments_order_idx on public.appointments (order_id) where order_id is not null;

-- ── held shares come in two kinds; only the online ones lock the bill ──
alter table public.order_partial_payments add column kind text not null default 'online' check (kind in ('online', 'deposit'));
alter table public.order_partial_payments drop constraint order_partial_payments_tender_check;
alter table public.order_partial_payments add constraint order_partial_payments_tender_check check (tender in ('promptpay', 'gateway', 'cash'));

create or replace function public.order_locking_held(p_order uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(amount), 0)::bigint from public.order_partial_payments where order_id = p_order and status = 'held' and kind = 'online'
$$;
revoke all on function public.order_locking_held(uuid) from public, anon, authenticated;

create or replace function public.lines_locked_by_held() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_order uuid := case when tg_op = 'DELETE' then old.order_id else new.order_id end;
begin
  if coalesce(current_setting('bestie.paying', true), '') = 'on' or public.order_locking_held(v_order) = 0 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and new.order_id = old.order_id and new.quantity = old.quantity and new.unit_price = old.unit_price
     and (new.status = old.status or new.status <> 'void') then
    return new;
  end if;
  raise exception 'a part of this bill is already paid' using errcode = '55006';
end $$;

create or replace function public.orders_locked_by_held() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if public.order_locking_held(new.id) = 0 or coalesce(current_setting('bestie.paying', true), '') = 'on' then return new; end if;
  if (new.status = 'void' and old.status <> 'void')
     or new.points_used is distinct from old.points_used or new.points_discount is distinct from old.points_discount
     or new.customer_id is distinct from old.customer_id then
    raise exception 'a part of this bill is already paid' using errcode = '55006';
  end if;
  return new;
end $$;

-- giving up on a bill releases only the PromptPay / card shares (a deposit is handled on the appointment)
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
  v_total := public.order_locking_held(p_order);
  if v_total = 0 then return 0; end if;
  update public.order_partial_payments set status = 'refund_needed', resolved_at = now(), note = left(coalesce(p_note, ''), 200)
   where order_id = p_order and status = 'held' and kind = 'online';
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

-- ── deposits ──
create table public.appointment_deposits (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.orgs (id) on delete cascade,
  store_id           uuid not null references public.stores (id) on delete cascade,
  appointment_id     uuid not null references public.appointments (id),
  amount             bigint not null check (amount between 1 and 100000000),
  method             text not null check (method in ('cash', 'promptpay', 'gateway')),
  device_id          uuid references public.devices (id),                   -- where the cash went in
  reference          text check (reference is null or length(reference) <= 100),
  status             text not null default 'held' check (status in ('held', 'on_bill', 'forfeited', 'refunded')),
  order_id           uuid references public.orders (id),
  note               text check (note is null or length(note) <= 200),
  created_by         uuid references public.staff (id) on delete set null,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz,
  resolved_by        uuid references public.staff (id) on delete set null,
  resolved_device_id uuid references public.devices (id)
);
create index appointment_deposits_appt_idx on public.appointment_deposits (appointment_id);
create index appointment_deposits_cash_idx on public.appointment_deposits (device_id, created_at) where method = 'cash';
alter table public.appointment_deposits enable row level security;
create policy appointment_deposits_read on public.appointment_deposits for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.appointment_deposits from anon, authenticated;
grant select on public.appointment_deposits to authenticated;
create trigger appointment_deposits_live after insert or update on public.appointment_deposits for each row execute function public.live_ping_row('store:{store_id}');

-- p = { appointment_id, amount, method, device_id? (needed for cash), reference? }
create or replace function public.record_appointment_deposit(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  a public.appointments%rowtype;
  v_amount bigint := (p ->> 'amount')::bigint;
  v_method text := p ->> 'method';
  v_dev uuid := nullif(p ->> 'device_id', '')::uuid;
  v_held bigint;
  v_staff uuid;
  v_id uuid;
begin
  select * into a from public.appointments where id = (p ->> 'appointment_id')::uuid for update;
  if not found or not (public.can_access_store(a.org_id, a.store_id) and public.has_permission(a.org_id, 'payment.take')) then
    raise exception 'taking a deposit needs payment.take in this shop' using errcode = '42501';
  end if;
  if not public.deposits_enabled(a.store_id) then raise exception 'the deposits module is off in this shop' using errcode = '0A000'; end if;
  if a.status not in ('booked', 'confirmed', 'arrived') then raise exception 'a deposit is taken before the service' using errcode = '55000'; end if;
  if v_method not in ('cash', 'promptpay', 'gateway') then raise exception 'unknown method' using errcode = '22023'; end if;
  if v_amount is null or v_amount < 1 then raise exception 'the amount must be above zero' using errcode = '22023'; end if;
  if v_method = 'cash' and not exists (select 1 from public.devices d where d.id = v_dev and d.store_id = a.store_id and d.active) then
    raise exception 'a cash deposit needs the till it went into' using errcode = '22023';
  end if;
  if v_method <> 'cash' then v_dev := null; end if;
  select coalesce(sum(amount), 0) into v_held from public.appointment_deposits where appointment_id = a.id and status in ('held', 'on_bill');
  if v_held + v_amount > a.price then raise exception 'deposits cannot be more than the price of the service' using errcode = '22023'; end if;
  select f.id into v_staff from public.staff f where f.org_id = a.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.appointment_deposits (org_id, store_id, appointment_id, amount, method, device_id, reference, created_by)
  values (a.org_id, a.store_id, a.id, v_amount, v_method, v_dev, left(nullif(btrim(coalesce(p ->> 'reference', '')), ''), 100), v_staff)
  returning id into v_id;
  perform public.audit_record(a.org_id, a.store_id, 'payment.tender', 'appointments', a.id::text,
    jsonb_build_object('deposit', v_amount, 'method', v_method), 'db');
  return v_id;
end $$;

-- p = { deposit_id, action: 'forfeit' | 'refund', device_id? (needed to refund cash) } — only for a cancelled / no-show appointment
create or replace function public.resolve_deposit(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  d public.appointment_deposits%rowtype;
  a public.appointments%rowtype;
  v_action text := p ->> 'action';
  v_dev uuid := nullif(p ->> 'device_id', '')::uuid;
  v_staff uuid;
begin
  select * into d from public.appointment_deposits where id = (p ->> 'deposit_id')::uuid for update;
  if not found or not (public.can_access_store(d.org_id, d.store_id) and public.has_permission(d.org_id, 'refund.create')) then
    raise exception 'settling a deposit needs refund.create' using errcode = '42501';
  end if;
  select * into a from public.appointments where id = d.appointment_id;
  if d.status <> 'held' then raise exception 'this deposit is already %', d.status using errcode = '55000'; end if;
  if a.status not in ('cancelled', 'no_show') then raise exception 'a deposit is settled when the appointment is cancelled or a no-show' using errcode = '55000'; end if;
  if v_action not in ('forfeit', 'refund') then raise exception 'unknown action' using errcode = '22023'; end if;
  if v_action = 'refund' and d.method = 'cash' and not exists (select 1 from public.devices x where x.id = v_dev and x.store_id = d.store_id and x.active) then
    raise exception 'a cash refund needs the till it came out of' using errcode = '22023';
  end if;
  select f.id into v_staff from public.staff f where f.org_id = d.org_id and f.user_id = auth.uid() and f.active limit 1;
  update public.appointment_deposits
     set status = case when v_action = 'forfeit' then 'forfeited' else 'refunded' end, resolved_at = now(), resolved_by = v_staff,
         resolved_device_id = case when v_action = 'refund' and d.method = 'cash' then v_dev end
   where id = d.id;
  perform public.audit_record(d.org_id, d.store_id, 'payment.refund', 'appointments', d.appointment_id::text,
    jsonb_build_object('deposit', d.amount, 'action', v_action), 'db');
  return case when v_action = 'forfeit' then 'forfeited' else 'refunded' end;
end $$;

-- p = { appointment_id, device_id? } → the bill's id (the same bill when asked again)
create or replace function public.appointment_to_order(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  a public.appointments%rowtype;
  s public.stores%rowtype;
  v_dev uuid := nullif(p ->> 'device_id', '')::uuid;
  v_order uuid;
  v_no integer;
  v_staff uuid;
  d public.appointment_deposits%rowtype;
begin
  select * into a from public.appointments where id = (p ->> 'appointment_id')::uuid for update;
  if not found or not (public.can_access_store(a.org_id, a.store_id) and public.has_permission(a.org_id, 'order.create')) then
    raise exception 'billing an appointment needs order.create in this shop' using errcode = '42501';
  end if;
  if not public.appointments_enabled(a.store_id) then raise exception 'the appointments module is off in this shop' using errcode = '0A000'; end if;
  if a.order_id is not null and exists (select 1 from public.orders o where o.id = a.order_id and o.status <> 'void') then
    return a.order_id;
  end if;
  if a.status not in ('arrived', 'in_service', 'done') then raise exception 'bill an appointment once the guest has arrived' using errcode = '55000'; end if;
  if v_dev is not null and not exists (select 1 from public.devices x where x.id = v_dev and x.store_id = a.store_id and x.active) then v_dev := null; end if;
  select * into s from public.stores where id = a.store_id for update;
  select coalesce(max(substr(o.number, 3)::integer), 0) + 1 into v_no from public.orders o
   where o.store_id = a.store_id and o.business_date = (now() at time zone 'Asia/Bangkok')::date and o.number ~ '^AP[0-9]+$';
  select f.id into v_staff from public.staff f where f.org_id = a.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.orders (org_id, store_id, number, business_date, channel, status, note, opened_by, device_id, customer_id)
  values (a.org_id, a.store_id, 'AP' || lpad(v_no::text, 3, '0'), (now() at time zone 'Asia/Bangkok')::date, 'takeaway', 'open',
          left('Appointment: ' || a.guest_name, 300), v_staff, v_dev, a.customer_id)
  returning id into v_order;
  insert into public.order_lines (org_id, store_id, order_id, item_id, name, unit_price, quantity, status, sent_at)
  values (a.org_id, a.store_id, v_order, a.service_id, a.service_name, a.price::integer, 1, 'sent', now());
  -- the deposits already received are already-paid shares of this bill
  for d in select * from public.appointment_deposits where appointment_id = a.id and status = 'held' loop
    insert into public.order_partial_payments (id, org_id, store_id, order_id, tender, amount, provider_ref, kind, note)
    values (d.id, d.org_id, d.store_id, v_order, d.method, d.amount, 'deposit:' || d.id, 'deposit', 'deposit');
    update public.appointment_deposits set status = 'on_bill', order_id = v_order where id = d.id;
  end loop;
  update public.appointments set order_id = v_order where id = a.id;
  return v_order;
end $$;

-- the bill of an appointment is paid → the appointment is done
create or replace function public.appointment_done_on_paid() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.appointments set status = 'done' where order_id = new.id and status in ('booked', 'confirmed', 'arrived', 'in_service');
  return null;
end $$;
create trigger orders_appointment_done_trg after update of status on public.orders
  for each row when (new.status = 'paid' and old.status is distinct from 'paid') execute function public.appointment_done_on_paid();

-- ── the drawer: cash deposits come in, refunded ones go out, applied ones are not counted twice ──
create or replace function public.close_shift(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s       public.shifts%rowtype;
  v_close timestamptz := (p ->> 'closed_at')::timestamptz;
  v_count bigint := (p ->> 'counted_cash')::bigint;
  v_cash  bigint;
  v_topup bigint;
  v_depin bigint;
  v_depout bigint;
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
    return jsonb_build_object('expected_cash', s.expected_cash, 'variance', s.variance);
  end if;
  if v_close < s.opened_at then
    raise exception 'a shift cannot close before it opened' using errcode = '23514';
  end if;
  select coalesce(sum(pay.amount), 0) into v_cash from public.payments pay
   where pay.device_id = s.device_id and pay.tender = 'cash' and pay.status = 'confirmed'
     and coalesce(pay.reference, '') not like 'deposit:%'
     and pay.created_at >= s.opened_at and pay.created_at <= v_close;
  select coalesce(sum(l.amount), 0) into v_topup from public.credit_ledger l
   where l.device_id = s.device_id and l.kind = 'topup' and l.funding = 'cash'
     and l.created_at >= s.opened_at and l.created_at <= v_close;
  select coalesce(sum(d.amount), 0) into v_depin from public.appointment_deposits d
   where d.device_id = s.device_id and d.method = 'cash' and d.created_at >= s.opened_at and d.created_at <= v_close;
  select coalesce(sum(d.amount), 0) into v_depout from public.appointment_deposits d
   where d.resolved_device_id = s.device_id and d.method = 'cash' and d.status = 'refunded'
     and d.resolved_at >= s.opened_at and d.resolved_at <= v_close;
  v_exp := s.opening_cash + v_cash + v_topup + v_depin - v_depout;
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

revoke all on function public.record_appointment_deposit(jsonb), public.resolve_deposit(jsonb), public.appointment_to_order(jsonb) from public, anon;
grant execute on function public.record_appointment_deposit(jsonb), public.resolve_deposit(jsonb), public.appointment_to_order(jsonb) to authenticated, service_role;
