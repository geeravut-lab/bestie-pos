-- Bestie POS · migration 68 · Bestie Credit for real customers (owner order 2026-11-21: the lawyer allows Credit inside ONE legal entity).
--  * TERMS: before a member's first top-up the front desk shows the Credit terms (docs/LEGAL-DRAFTS.md §7; the wording is in the dictionary, the VERSION is
--    `credit_terms_version()`) and records that the customer accepted them for THIS legal entity (`credit_terms_acceptances`). Every way of topping up (cash at the
--    till, PromptPay / card, crypto request) refuses without a current acceptance. A new terms version needs a new acceptance. `orgs.credit_terms_required`
--    (default on) lets a lawyer-approved exception exist as DATA; nothing is hidden in code.
--  * SINGLE ENTITY: balances were already per (customer, legal entity). `credit_entity_check` lists, for every shop with Credit on, the company whose Credit it sells and whether
--    that company has a tax ID, so the owner can see which shops share Credit and which do not.
--  * LIABILITY: `credit_liability_detail` = per company, as of a date: what customers were topped up (by funding, crypto shown separately), spent, corrected and what is
--    still owed (deferred revenue); the Reports screen exports it (audited).

alter table public.orgs add column credit_terms_required boolean not null default true;

create or replace function public.credit_terms_version() returns integer language sql immutable set search_path = '' as $$ select 1 $$;
revoke all on function public.credit_terms_version() from public, anon;
grant execute on function public.credit_terms_version() to authenticated, service_role;

create table public.credit_terms_acceptances (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.orgs (id) on delete cascade,
  legal_entity_id uuid not null references public.legal_entities (id),
  customer_id     uuid not null references public.customers (id),
  version         integer not null check (version >= 1),
  channel         text not null default 'counter' check (channel in ('counter')),
  accepted_by     uuid references public.staff (id) on delete set null,
  accepted_at     timestamptz not null default now(),
  unique (customer_id, legal_entity_id, version)
);
alter table public.credit_terms_acceptances enable row level security;
create policy credit_terms_read on public.credit_terms_acceptances for select to authenticated using (public.has_permission(org_id, 'customer.view'));
revoke all on public.credit_terms_acceptances from anon, authenticated;
grant select on public.credit_terms_acceptances to authenticated;

create or replace function public.credit_terms_accepted(p_customer uuid, p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not coalesce((select o.credit_terms_required from public.legal_entities e join public.orgs o on o.id = e.org_id where e.id = p_entity), true)
      or exists (select 1 from public.credit_terms_acceptances a
                  where a.customer_id = p_customer and a.legal_entity_id = p_entity and a.version = public.credit_terms_version())
$$;
revoke all on function public.credit_terms_accepted(uuid, uuid) from public, anon, authenticated;
grant execute on function public.credit_terms_accepted(uuid, uuid) to service_role;

-- the front desk records that the customer has read and accepted the terms (in front of them)
create or replace function public.accept_credit_terms(p_customer uuid, p_store uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; c public.customers%rowtype; v_staff uuid;
begin
  select * into s from public.stores where id = p_store and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'payment.take') and public.has_permission(s.org_id, 'customer.view')) then
    raise exception 'recording the terms needs payment.take' using errcode = '42501';
  end if;
  if not public.credit_enabled(s.id) then raise exception 'Bestie Credit is switched off in this shop' using errcode = '0A000'; end if;
  select * into c from public.customers where id = p_customer and org_id = s.org_id and deleted_at is null;
  if not found then raise exception 'customer not found' using errcode = 'P0002'; end if;
  select f.id into v_staff from public.staff f where f.org_id = s.org_id and f.user_id = auth.uid() and f.active limit 1;
  insert into public.credit_terms_acceptances (org_id, legal_entity_id, customer_id, version, accepted_by)
  values (s.org_id, s.legal_entity_id, c.id, public.credit_terms_version(), v_staff)
  on conflict (customer_id, legal_entity_id, version) do nothing;
  perform public.audit_record(s.org_id, s.id, 'credit.topup', 'customers', c.id::text, jsonb_build_object('terms_accepted', public.credit_terms_version()), 'db');
end $$;
revoke all on function public.accept_credit_terms(uuid, uuid) from public, anon;
grant execute on function public.accept_credit_terms(uuid, uuid) to authenticated, service_role;

-- the top-ups now need the acceptance
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
  if not public.credit_terms_accepted(v_cust.id, v_store.legal_entity_id) then
    raise exception 'the customer has not accepted the Credit terms' using errcode = '55000';
  end if;
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
  if not public.credit_terms_accepted(v_cust.id, v_store.legal_entity_id) then
    raise exception 'the customer has not accepted the Credit terms' using errcode = '55000';
  end if;
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

create or replace function public.crypto_request_precheck(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_store public.stores%rowtype;
  v_res jsonb;
begin
  select * into v_store from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found then raise exception 'shop not found' using errcode = 'P0002'; end if;
  if not (public.has_permission(v_store.org_id, 'payment.take') and public.has_permission(v_store.org_id, 'customer.view')
          and public.can_access_store(v_store.org_id, v_store.id)) then
    raise exception 'topping up needs payment.take' using errcode = '42501';
  end if;
  if not public.credit_terms_accepted((p ->> 'customer_id')::uuid, v_store.legal_entity_id) then
    raise exception 'the customer has not accepted the Credit terms' using errcode = '55000';
  end if;
  v_res := public.crypto_check_internal((p ->> 'customer_id')::uuid, v_store.id, p ->> 'network', (p ->> 'thb')::bigint);
  return v_res || jsonb_build_object('staff_id', public.crypto_staff_id(v_store.org_id));
end $$;

create or replace function public.crypto_create_request(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_store public.stores%rowtype;
  v_chk jsonb;
  v_id uuid;
  v_exp timestamptz := now() + interval '15 minutes';
begin
  select * into v_store from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found then raise exception 'shop not found' using errcode = 'P0002'; end if;
  if not public.credit_terms_accepted((p ->> 'customer_id')::uuid, v_store.legal_entity_id) then
    raise exception 'the customer has not accepted the Credit terms' using errcode = '55000';
  end if;
  v_chk := public.crypto_check_internal((p ->> 'customer_id')::uuid, v_store.id, p ->> 'network', (p ->> 'thb')::bigint);
  if (v_chk ->> 'ok') <> 'true' then raise exception 'request refused: %', v_chk ->> 'problem' using errcode = '23514'; end if;
  if ((p ->> 'amount_units')::bigint % 1000) = 0 then raise exception 'the amount needs its unique suffix' using errcode = '22023'; end if;
  insert into public.crypto_requests (org_id, legal_entity_id, store_id, customer_id, kyc_id, wallet_id, network, receive_address,
                                      thb_amount, rate, rate_sources, amount_units, expires_at, created_by)
  values (v_store.org_id, v_store.legal_entity_id, v_store.id, (p ->> 'customer_id')::uuid, (v_chk ->> 'kyc_id')::uuid, (v_chk ->> 'wallet_id')::uuid,
          p ->> 'network', v_chk ->> 'address', (p ->> 'thb')::bigint, (p ->> 'rate')::integer, p -> 'rate_sources',
          (p ->> 'amount_units')::bigint, v_exp, nullif(p ->> 'staff_id', '')::uuid)
  returning id into v_id;      -- a clash on (network, address, amount) is 23505: the handler picks another suffix
  return jsonb_build_object('id', v_id, 'address', v_chk ->> 'address', 'expires_at', v_exp);
end $$;

-- ── single legal entity: which company's Credit does each shop sell? ──
create or replace function public.credit_entity_check(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_permission(p_org, 'report.view') then raise exception 'reports need report.view' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('store_id', s.id, 'store', s.name, 'entity_id', e.id, 'entity', e.name,
            'tax_id_set', coalesce(e.tax_id, '') ~ '^[0-9]{13}$', 'credit_on', public.credit_enabled(s.id)) order by e.name, s.name)
          from public.stores s join public.legal_entities e on e.id = s.legal_entity_id
         where s.org_id = p_org and s.deleted_at is null and public.can_access_store(s.org_id, s.id)), '[]'::jsonb);
end $$;

-- ── what each company owes its customers, as of a date (Bangkok) ──
create or replace function public.credit_liability_detail(p_org uuid, p_as_of date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_end timestamptz := (coalesce(p_as_of, (now() at time zone 'Asia/Bangkok')::date) + 1)::timestamp at time zone 'Asia/Bangkok';
begin
  if not public.has_permission(p_org, 'report.view') then raise exception 'reports need report.view' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by x ->> 'name') from (
    select jsonb_build_object('legal_entity_id', e.id, 'name', e.name, 'tax_id', e.tax_id,
      'topped_up', coalesce(sum(l.amount) filter (where l.kind = 'topup'), 0),
      'topped_up_cash', coalesce(sum(l.amount) filter (where l.kind = 'topup' and l.funding = 'cash'), 0),
      'topped_up_psp', coalesce(sum(l.amount) filter (where l.kind = 'topup' and l.funding in ('promptpay', 'gateway')), 0),
      'topped_up_crypto', coalesce(sum(l.amount) filter (where l.kind = 'topup' and l.funding = 'crypto'), 0),
      'spent', -coalesce(sum(l.amount) filter (where l.kind = 'spend'), 0),
      'adjusted', coalesce(sum(l.amount) filter (where l.kind = 'adjust'), 0),
      'outstanding', coalesce(sum(l.amount), 0),
      'customers', (select count(*) from (select l2.customer_id from public.credit_ledger l2
                      where l2.legal_entity_id = e.id and l2.created_at < v_end group by l2.customer_id having sum(l2.amount) > 0) q)) as x
      from public.legal_entities e
      left join public.credit_ledger l on l.legal_entity_id = e.id and l.created_at < v_end
     where e.org_id = p_org
     group by e.id, e.name, e.tax_id) t), '[]'::jsonb);
end $$;
revoke all on function public.credit_entity_check(uuid), public.credit_liability_detail(uuid, date) from public, anon;
grant execute on function public.credit_entity_check(uuid), public.credit_liability_detail(uuid, date) to authenticated, service_role;
