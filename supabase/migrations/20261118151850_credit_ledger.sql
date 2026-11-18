-- Bestie POS · migration 24 · Bestie Credit: prepaid stored value, THB 1:1, a liability until it is spent.
--
--  * Credit is a SEPARATE ledger from Points (never mixed, never convertible).
--  * It belongs to a customer AND the legal entity of the shop that issued it (`legal_entity_id`). A balance is always read
--    per (customer, entity), so Credit can only ever be spent in shops of the same legal entity — that is the BOT
--    "single seller" rule enforced in the database, not in the UI.
--  * Double entry: every row is one balanced posting (debit account / credit account, same amount). Top-up: debit cash (or
--    the payment provider's clearing account) / credit customer_credit. Spend: debit customer_credit / credit sales.
--  * Append-only. There is NO cash-out kind and NO crypto funding: the only funding values are cash / promptpay / gateway.
--    (Crypto top-up is a separate, legally gated module that does not exist yet.)
--  * The tender is off by default per shop (module `tender.credit`) until the lawyer has confirmed the structure.
--  * This migration: the ledger, balances, the liability report and CASH top-ups at the till. Spending Credit on a bill and
--    PromptPay / card top-ups come next.

create table public.credit_ledger (
  id              uuid primary key,                     -- client-made: a repeated request is recognised, never doubled
  org_id          uuid not null references public.orgs (id) on delete cascade,
  legal_entity_id uuid not null references public.legal_entities (id),
  customer_id     uuid not null references public.customers (id),
  store_id        uuid references public.stores (id),
  device_id       uuid references public.devices (id),
  kind            text not null check (kind in ('topup', 'spend', 'adjust')),
  amount          bigint not null check (amount <> 0 and abs(amount) <= 100000000),   -- satang, signed
  funding         text check (funding in ('cash', 'promptpay', 'gateway')),
  debit_account   text not null check (debit_account in ('cash', 'psp_clearing', 'customer_credit', 'adjustment')),
  credit_account  text not null check (credit_account in ('customer_credit', 'sales', 'adjustment')),
  order_id        uuid references public.orders (id),
  reason          text check (length(reason) <= 200),
  created_by      uuid references public.staff (id),
  created_at      timestamptz not null default now(),
  check ((kind = 'topup' and amount > 0 and funding is not null and credit_account = 'customer_credit')
      or (kind = 'spend' and amount < 0 and order_id is not null and debit_account = 'customer_credit' and credit_account = 'sales')
      or (kind = 'adjust' and length(btrim(coalesce(reason, ''))) > 0)),
  check (kind <> 'topup' or (funding = 'cash' and debit_account = 'cash') or (funding in ('promptpay', 'gateway') and debit_account = 'psp_clearing'))
);
create unique index credit_ledger_spend_once_uidx on public.credit_ledger (order_id) where kind = 'spend';
create index credit_ledger_customer_idx on public.credit_ledger (customer_id, legal_entity_id, created_at desc);
create index credit_ledger_device_idx on public.credit_ledger (device_id, created_at) where funding = 'cash';

create or replace function public.credit_ledger_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'the credit ledger is append-only' using errcode = '23514';
  end if;
  if not exists (select 1 from public.customers c where c.id = new.customer_id and c.org_id = new.org_id) then
    raise exception 'customer belongs to another org' using errcode = '23514';
  end if;
  if not exists (select 1 from public.legal_entities e where e.id = new.legal_entity_id and e.org_id = new.org_id) then
    raise exception 'legal entity belongs to another org' using errcode = '23514';
  end if;
  -- a balance never goes below zero (Credit cannot be overspent)
  if new.amount < 0 and (select coalesce(sum(l.amount), 0) from public.credit_ledger l
        where l.customer_id = new.customer_id and l.legal_entity_id = new.legal_entity_id) + new.amount < 0 then
    raise exception 'not enough Credit' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger credit_ledger_guard_ins before insert on public.credit_ledger for each row execute function public.credit_ledger_guard();
create trigger credit_ledger_guard_mod before update or delete on public.credit_ledger for each row execute function public.credit_ledger_guard();

alter table public.credit_ledger enable row level security;
create policy credit_ledger_read on public.credit_ledger for select to authenticated
  using (public.has_permission(org_id, 'customer.view'));
revoke all on public.credit_ledger from anon, authenticated;
grant select on public.credit_ledger to authenticated;

-- ── is Credit switched on in this shop? (mirrors the registry: off for every profile, plan basic and up) ──
-- registry:tender.credit profiles= plan=basic,pro,resort
create or replace function public.credit_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select (s.module_overrides ->> 'tender.credit')::boolean from public.stores s
                    where s.id = p_store and s.module_overrides ? 'tender.credit'), false)
     and coalesce((select s.plan in ('basic', 'pro', 'resort') from public.stores s where s.id = p_store), false)
$$;
revoke all on function public.credit_enabled(uuid) from public, anon, authenticated;
grant execute on function public.credit_enabled(uuid) to service_role;

-- ── balances ───────────────────────────────────────────────────────────────
create or replace function public.credit_balance(p_customer uuid, p_entity uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(l.amount), 0)::bigint from public.credit_ledger l
   where l.customer_id = p_customer and l.legal_entity_id = p_entity
     and public.has_permission(l.org_id, 'customer.view')
$$;
revoke all on function public.credit_balance(uuid, uuid) from public, anon;
grant execute on function public.credit_balance(uuid, uuid) to authenticated, service_role;

-- outstanding Credit per legal entity: what the company owes its customers (deferred revenue)
create or replace function public.credit_liability(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_permission(p_org, 'report.view') then
    raise exception 'reports need report.view' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(x order by x ->> 'name') from (
    select jsonb_build_object('legal_entity_id', e.id, 'name', e.name,
             'outstanding', coalesce(sum(l.amount), 0),
             'customers', count(distinct l.customer_id) filter (where l.amount is not null)) as x
      from public.legal_entities e
      left join public.credit_ledger l on l.legal_entity_id = e.id
     where e.org_id = p_org
     group by e.id, e.name) t), '[]'::jsonb);
end $$;
revoke all on function public.credit_liability(uuid) from public, anon;
grant execute on function public.credit_liability(uuid) to authenticated, service_role;

-- ── cash top-up at the till (online) ───────────────────────────────────────
-- p = { id uuid (client-made), customer_id, store_id, device_id, amount (satang), funding: 'cash' }
create or replace function public.topup_credit(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id     uuid := (p ->> 'id')::uuid;
  v_store  public.stores%rowtype;
  v_cust   public.customers%rowtype;
  v_amount bigint := (p ->> 'amount')::bigint;
  v_staff  uuid;
  v_old    public.credit_ledger%rowtype;
  v_bal    bigint;
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
  if coalesce(p ->> 'funding', 'cash') <> 'cash' then
    raise exception 'only cash top-ups are available at the till' using errcode = '22023';
  end if;
  if v_amount is null or v_amount < 10000 or v_amount > 5000000 then
    raise exception 'a top-up is between 100.00 and 50,000.00' using errcode = '22023';
  end if;
  select * into v_old from public.credit_ledger where id = v_id;
  if found then
    return jsonb_build_object('balance', public.credit_balance(v_old.customer_id, v_old.legal_entity_id), 'replay', true);
  end if;
  select * into v_cust from public.customers where id = (p ->> 'customer_id')::uuid and org_id = v_store.org_id and deleted_at is null for update;
  if not found then raise exception 'customer not found' using errcode = 'P0002'; end if;
  select coalesce(sum(amount), 0) into v_bal from public.credit_ledger where customer_id = v_cust.id and legal_entity_id = v_store.legal_entity_id;
  if v_bal + v_amount > 20000000 then
    raise exception 'the balance may not exceed 200,000.00' using errcode = '22023';
  end if;
  select s.id into v_staff from public.staff s where s.org_id = v_store.org_id and s.user_id = auth.uid() and s.active limit 1;
  insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, store_id, device_id, kind, amount, funding, debit_account, credit_account, created_by)
  values (v_id, v_store.org_id, v_store.legal_entity_id, v_cust.id, v_store.id,
          (select d.id from public.devices d where d.id = nullif(p ->> 'device_id', '')::uuid and d.store_id = v_store.id),
          'topup', v_amount, 'cash', 'cash', 'customer_credit', v_staff);
  perform public.audit_record(v_store.org_id, v_store.id, 'credit.topup', 'customers', v_cust.id::text,
    jsonb_build_object('amount', v_amount, 'funding', 'cash'), 'app');
  return jsonb_build_object('balance', v_bal + v_amount, 'replay', false);
end $$;
revoke all on function public.topup_credit(jsonb) from public, anon;
grant execute on function public.topup_credit(jsonb) to authenticated, service_role;

-- ── a manager's correction (reason required) ───────────────────────────────
create or replace function public.adjust_credit(p_customer uuid, p_store uuid, p_amount bigint, p_reason text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_store public.stores%rowtype;
  v_staff uuid;
  v_bal bigint;
begin
  select * into v_store from public.stores where id = p_store and deleted_at is null;
  if not found then raise exception 'shop not found' using errcode = 'P0002'; end if;
  if not (public.has_permission(v_store.org_id, 'credit.adjust') and public.can_access_store(v_store.org_id, v_store.id)) then
    raise exception 'correcting Credit needs credit.adjust' using errcode = '42501';
  end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 5000000 or length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'an amount and a reason are required' using errcode = '22023';
  end if;
  perform 1 from public.customers c where c.id = p_customer and c.org_id = v_store.org_id and c.deleted_at is null for update;
  if not found then raise exception 'customer not found' using errcode = 'P0002'; end if;
  select s.id into v_staff from public.staff s where s.org_id = v_store.org_id and s.user_id = auth.uid() and s.active limit 1;
  insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, store_id, kind, amount, debit_account, credit_account, reason, created_by)
  values (gen_random_uuid(), v_store.org_id, v_store.legal_entity_id, p_customer, v_store.id, 'adjust', p_amount,
          case when p_amount > 0 then 'adjustment' else 'customer_credit' end,
          case when p_amount > 0 then 'customer_credit' else 'adjustment' end,
          left(btrim(p_reason), 200), v_staff);
  select coalesce(sum(amount), 0) into v_bal from public.credit_ledger where customer_id = p_customer and legal_entity_id = v_store.legal_entity_id;
  perform public.audit_record(v_store.org_id, v_store.id, 'credit.adjust', 'customers', p_customer::text,
    jsonb_build_object('amount', p_amount), 'app');
  return v_bal;
end $$;
revoke all on function public.adjust_credit(uuid, uuid, bigint, text) from public, anon;
grant execute on function public.adjust_credit(uuid, uuid, bigint, text) to authenticated, service_role;

-- ── cash top-ups are cash in the drawer: the shift's expected cash counts them ──
create or replace function public.close_shift(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s       public.shifts%rowtype;
  v_close timestamptz := (p ->> 'closed_at')::timestamptz;
  v_count bigint := (p ->> 'counted_cash')::bigint;
  v_cash  bigint;
  v_topup bigint;
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
    return jsonb_build_object('expected_cash', s.expected_cash, 'variance', s.variance); -- again: nothing to do
  end if;
  if v_close < s.opened_at then
    raise exception 'a shift cannot close before it opened' using errcode = '23514';
  end if;
  -- the server decides what SHOULD be in the drawer: opening cash + confirmed cash taken on this device + cash top-ups of Credit
  select coalesce(sum(pay.amount), 0) into v_cash from public.payments pay
   where pay.device_id = s.device_id and pay.tender = 'cash' and pay.status = 'confirmed'
     and pay.created_at >= s.opened_at and pay.created_at <= v_close;
  select coalesce(sum(l.amount), 0) into v_topup from public.credit_ledger l
   where l.device_id = s.device_id and l.kind = 'topup' and l.funding = 'cash'
     and l.created_at >= s.opened_at and l.created_at <= v_close;
  v_exp := s.opening_cash + v_cash + v_topup;
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
