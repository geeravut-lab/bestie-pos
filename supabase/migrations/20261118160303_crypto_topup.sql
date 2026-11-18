-- Bestie POS · migration 28 · crypto top-up of Bestie Credit (module `credit.topup.crypto`).
-- Spec: docs/modules/CRYPTO_TOPUP.md · knowledge: docs/CRYPTO_TRANSFER_KNOWLEDGE.md · rules: CLAUDE.md 2–3.
--
-- OFF by default and legally gated: every function refuses unless the shop switched the module on AND the org record has
-- `legal_sign_off.cryptoTopup = true` (the lawyer's opinion) AND Credit itself is on. Crypto is never a way to pay a bill:
-- it only becomes Bestie Credit (THB, 1:1 at the rate locked in the request), and Credit has no cash-out.
-- No private key exists anywhere in the system: the table holds PUBLIC receiving addresses (watch-only) and what the chain showed.

-- ── Credit ledger learns the new funding (and nothing else: still no cash-out kind) ──
do $$ declare c record; begin
  for c in select conname from pg_constraint where conrelid = 'public.credit_ledger'::regclass and contype = 'c' loop
    execute format('alter table public.credit_ledger drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.credit_ledger add column crypto_request_id uuid;
alter table public.credit_ledger add constraint credit_ledger_amount_ck check (amount <> 0 and abs(amount) <= 100000000);
alter table public.credit_ledger add constraint credit_ledger_kind_ck check (kind in ('topup', 'spend', 'adjust'));
alter table public.credit_ledger add constraint credit_ledger_funding_ck check (funding in ('cash', 'promptpay', 'gateway', 'crypto'));
alter table public.credit_ledger add constraint credit_ledger_debit_ck check (debit_account in ('cash', 'psp_clearing', 'crypto_wallet', 'customer_credit', 'adjustment'));
alter table public.credit_ledger add constraint credit_ledger_credit_ck check (credit_account in ('customer_credit', 'sales', 'adjustment'));
alter table public.credit_ledger add constraint credit_ledger_reason_len_ck check (length(reason) <= 200);
alter table public.credit_ledger add constraint credit_ledger_shape_ck check (
     (kind = 'topup' and amount > 0 and funding is not null and credit_account = 'customer_credit')
  or (kind = 'spend' and amount < 0 and order_id is not null and debit_account = 'customer_credit' and credit_account = 'sales')
  or (kind = 'adjust' and length(btrim(coalesce(reason, ''))) > 0));
alter table public.credit_ledger add constraint credit_ledger_funding_account_ck check (
  kind <> 'topup'
  or (funding = 'cash' and debit_account = 'cash')
  or (funding in ('promptpay', 'gateway') and debit_account = 'psp_clearing')
  or (funding = 'crypto' and debit_account = 'crypto_wallet' and crypto_request_id is not null and crypto_request_id = id));

-- ── is the module usable in this shop? (module switch + Credit on + the lawyer's sign-off, all checked here) ──
-- registry:credit.topup.crypto profiles= plan=basic,pro,resort legal=cryptoTopup depends=tender.credit
create or replace function public.crypto_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select (s.module_overrides ->> 'credit.topup.crypto')::boolean from public.stores s
                    where s.id = p_store and s.module_overrides ? 'credit.topup.crypto'), false)
     and public.credit_enabled(p_store)
     and coalesce((select (o.legal_sign_off ->> 'cryptoTopup')::boolean from public.orgs o join public.stores s on s.org_id = o.id where s.id = p_store), false)
$$;
revoke all on function public.crypto_enabled(uuid) from public, anon, authenticated;
grant execute on function public.crypto_enabled(uuid) to service_role;

create or replace function public.crypto_required_confirmations(p_network text) returns integer
language sql immutable set search_path = '' as $$
  select case p_network when 'tron' then 20 when 'ethereum' then 12 end
$$;
revoke all on function public.crypto_required_confirmations(text) from public, anon, authenticated;
grant execute on function public.crypto_required_confirmations(text) to service_role;

-- ── company receiving addresses (public, watch-only) ───────────────────────
create table public.crypto_wallets (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.orgs (id) on delete cascade,
  legal_entity_id uuid not null references public.legal_entities (id),
  network         text not null check (network in ('tron', 'ethereum')),
  token           text not null default 'USDT' check (token = 'USDT'),
  address         text not null,
  label           text check (length(label) <= 60),
  active          boolean not null default true,
  poll_cursor_ms  bigint not null default 0,                    -- watcher: newest block time already read
  created_at      timestamptz not null default now(),
  check ((network = 'tron' and address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$') or (network = 'ethereum' and address ~ '^0x[0-9a-f]{40}$'))
);
create unique index crypto_wallets_active_uidx on public.crypto_wallets (legal_entity_id, network, token) where active;
create unique index crypto_wallets_addr_uidx on public.crypto_wallets (network, address) where active;
alter table public.crypto_wallets enable row level security;
create policy crypto_wallets_read on public.crypto_wallets for select to authenticated using (public.has_permission(org_id, 'customer.view'));
revoke all on public.crypto_wallets from anon, authenticated;
grant select on public.crypto_wallets to authenticated;

create table public.crypto_wallet_changes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  legal_entity_id uuid not null references public.legal_entities (id),
  network     text not null check (network in ('tron', 'ethereum')),
  new_address text not null,
  requested_by uuid not null references public.staff (id),
  approved_by  uuid references public.staff (id),
  status      text not null default 'pending' check (status in ('pending', 'applied', 'rejected')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  check ((network = 'tron' and new_address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$') or (network = 'ethereum' and new_address ~ '^0x[0-9a-f]{40}$')),
  check (approved_by is null or approved_by <> requested_by)       -- two DIFFERENT people
);
alter table public.crypto_wallet_changes enable row level security;
create policy crypto_wallet_changes_read on public.crypto_wallet_changes for select to authenticated using (public.has_permission(org_id, 'credit.adjust'));
revoke all on public.crypto_wallet_changes from anon, authenticated;
grant select on public.crypto_wallet_changes to authenticated;

-- ── KYC (passport etc.): personal data, readable only by people who may correct Credit; never deleted ──
create table public.crypto_kyc (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs (id) on delete cascade,
  customer_id   uuid not null references public.customers (id),
  tier          text not null check (tier in ('T1', 'T2')),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  full_name     text not null check (length(btrim(full_name)) between 2 and 120),
  nationality   text not null check (length(btrim(nationality)) between 2 and 60),
  passport_no   text not null check (passport_no ~ '^[A-Za-z0-9]{5,20}$'),
  doc_path      text check (length(doc_path) <= 300),
  contact       text not null check (length(btrim(contact)) between 3 and 120),
  owned_addresses jsonb not null default '[]'::jsonb check (jsonb_typeof(owned_addresses) = 'array'),   -- [{network,address,proof}]
  source_of_funds text check (length(source_of_funds) <= 500),
  risk_check    jsonb,
  decided_by    uuid references public.staff (id),
  decided_at    timestamptz,
  note          text check (length(note) <= 300),
  created_by    uuid references public.staff (id),
  created_at    timestamptz not null default now(),
  check (tier = 'T1' or (length(btrim(coalesce(source_of_funds, ''))) > 0 and jsonb_array_length(owned_addresses) > 0))
);
create index crypto_kyc_customer_idx on public.crypto_kyc (customer_id, created_at desc);
create or replace function public.crypto_kyc_keep() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'KYC records are kept for at least 5 years' using errcode = '23514'; end if;
  if new.passport_no <> old.passport_no or new.full_name <> old.full_name or new.customer_id <> old.customer_id then
    raise exception 'a KYC record cannot be rewritten; submit a new one' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger crypto_kyc_keep_trg before update or delete on public.crypto_kyc for each row execute function public.crypto_kyc_keep();
alter table public.crypto_kyc enable row level security;
create policy crypto_kyc_read on public.crypto_kyc for select to authenticated using (public.has_permission(org_id, 'credit.adjust'));
revoke all on public.crypto_kyc from anon, authenticated;
grant select on public.crypto_kyc to authenticated;

-- ── payment requests ("ใบเรียกเก็บ") ────────────────────────────────────────
create table public.crypto_requests (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.orgs (id) on delete cascade,
  legal_entity_id uuid not null references public.legal_entities (id),
  store_id        uuid not null references public.stores (id),
  customer_id     uuid not null references public.customers (id),
  kyc_id          uuid not null references public.crypto_kyc (id),
  wallet_id       uuid not null references public.crypto_wallets (id),
  network         text not null check (network in ('tron', 'ethereum')),
  token           text not null default 'USDT',
  receive_address text not null,
  thb_amount      bigint not null check (thb_amount between 50000 and 10000000),   -- satang
  rate            integer not null check (rate > 0),                              -- satang per 1.000000 USDT, LOCKED here
  rate_sources    jsonb not null,
  amount_units    bigint not null check (amount_units > 0),                       -- USDT base units (6 decimals)
  expires_at      timestamptz not null,
  status          text not null default 'open' check (status in ('open', 'paid_pending', 'credited', 'expired', 'review', 'cancelled')),
  tx_hash         text,
  created_by      uuid references public.staff (id),
  created_at      timestamptz not null default now(),
  credited_at     timestamptz
);
create unique index crypto_requests_live_uidx on public.crypto_requests (network, receive_address, amount_units) where status in ('open', 'paid_pending');
create index crypto_requests_customer_idx on public.crypto_requests (customer_id, created_at desc);
alter table public.crypto_requests enable row level security;
create policy crypto_requests_read on public.crypto_requests for select to authenticated using (public.has_permission(org_id, 'customer.view'));
revoke all on public.crypto_requests from anon, authenticated;
grant select on public.crypto_requests to authenticated;

create table public.crypto_transfers (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs (id) on delete cascade,
  wallet_id     uuid not null references public.crypto_wallets (id),
  network       text not null,
  token         text not null default 'USDT',
  tx_hash       text not null check (length(tx_hash) between 10 and 100),
  log_index     integer not null default 0,
  from_address  text not null,
  to_address    text not null,
  amount_units  bigint not null check (amount_units > 0),
  block_time    timestamptz not null,
  confirmations integer not null default 0,
  status        text not null default 'seen' check (status in ('seen', 'matched', 'credited', 'review', 'ignored', 'rejected')),
  reason        text check (length(reason) <= 100),
  request_id    uuid references public.crypto_requests (id),
  first_seen_at timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index crypto_transfers_tx_uidx on public.crypto_transfers (network, tx_hash, log_index);
create unique index crypto_transfers_request_uidx on public.crypto_transfers (request_id) where request_id is not null and status in ('matched', 'credited');
alter table public.crypto_transfers enable row level security;
create policy crypto_transfers_read on public.crypto_transfers for select to authenticated using (public.has_permission(org_id, 'credit.adjust'));
revoke all on public.crypto_transfers from anon, authenticated;
grant select on public.crypto_transfers to authenticated;

create table public.crypto_flags (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  customer_id uuid references public.customers (id),
  request_id  uuid references public.crypto_requests (id),
  rule        text not null check (rule in ('many_topups_24h', 'near_limit_repeated', 'address_shared', 'many_addresses_30d', 'blocked_sender', 'sender_not_proven')),
  detail      jsonb not null default '{}'::jsonb,
  status      text not null default 'open' check (status in ('open', 'closed')),
  created_at  timestamptz not null default now(),
  closed_by   uuid references public.staff (id),
  closed_at   timestamptz
);
alter table public.crypto_flags enable row level security;
create policy crypto_flags_read on public.crypto_flags for select to authenticated using (public.has_permission(org_id, 'credit.adjust'));
revoke all on public.crypto_flags from anon, authenticated;
grant select on public.crypto_flags to authenticated;

create table public.crypto_blocklist (
  network text not null check (network in ('tron', 'ethereum')),
  address text not null,
  reason  text not null check (length(reason) <= 200),
  source  text not null default 'own' check (source in ('own', 'sanctions', 'issuer_frozen')),
  created_at timestamptz not null default now(),
  primary key (network, address)
);
alter table public.crypto_blocklist enable row level security;   -- service role / owner functions only
revoke all on public.crypto_blocklist from anon, authenticated;

-- ── wallets: first address by an owner, every change by TWO different people ──
create or replace function public.crypto_staff_id(p_org uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select s.id from public.staff s where s.org_id = p_org and s.user_id = auth.uid() and s.active limit 1
$$;
revoke all on function public.crypto_staff_id(uuid) from public, anon, authenticated;

create or replace function public.crypto_set_wallet(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_store public.stores%rowtype;
  v_id uuid;
  v_net text := p ->> 'network';
  v_addr text := p ->> 'address';
begin
  select * into v_store from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found then raise exception 'shop not found' using errcode = 'P0002'; end if;
  if not (public.has_permission(v_store.org_id, 'credit.adjust') and public.can_access_store(v_store.org_id, v_store.id)) then
    raise exception 'setting a wallet needs credit.adjust' using errcode = '42501';
  end if;
  if not public.crypto_enabled(v_store.id) then raise exception 'crypto top-up is switched off' using errcode = '0A000'; end if;
  if v_net = 'ethereum' then v_addr := lower(v_addr); end if;
  if exists (select 1 from public.crypto_wallets w where w.legal_entity_id = v_store.legal_entity_id and w.network = v_net and w.active) then
    raise exception 'a wallet exists: change it with two approvals' using errcode = '23505';
  end if;
  insert into public.crypto_wallets (org_id, legal_entity_id, network, address, label)
  values (v_store.org_id, v_store.legal_entity_id, v_net, v_addr, left(p ->> 'label', 60)) returning id into v_id;
  perform public.audit_record(v_store.org_id, v_store.id, 'credit.adjust', 'crypto_wallets', v_id::text,
    jsonb_build_object('kind', 'crypto_wallet_set', 'network', v_net), 'app');
  return v_id;
end $$;
revoke all on function public.crypto_set_wallet(jsonb) from public, anon;
grant execute on function public.crypto_set_wallet(jsonb) to authenticated, service_role;

create or replace function public.crypto_wallet_change_request(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_store public.stores%rowtype;
  v_staff uuid;
  v_id uuid;
  v_net text := p ->> 'network';
  v_addr text := p ->> 'address';
begin
  select * into v_store from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found then raise exception 'shop not found' using errcode = 'P0002'; end if;
  if not (public.has_permission(v_store.org_id, 'credit.adjust') and public.can_access_store(v_store.org_id, v_store.id)) then
    raise exception 'changing a wallet needs credit.adjust' using errcode = '42501';
  end if;
  if not public.crypto_enabled(v_store.id) then raise exception 'crypto top-up is switched off' using errcode = '0A000'; end if;
  v_staff := public.crypto_staff_id(v_store.org_id);
  if v_net = 'ethereum' then v_addr := lower(v_addr); end if;
  insert into public.crypto_wallet_changes (org_id, legal_entity_id, network, new_address, requested_by)
  values (v_store.org_id, v_store.legal_entity_id, v_net, v_addr, v_staff) returning id into v_id;
  perform public.audit_record(v_store.org_id, v_store.id, 'credit.adjust', 'crypto_wallet_changes', v_id::text,
    jsonb_build_object('kind', 'crypto_wallet_change_requested', 'network', v_net), 'app');
  return v_id;
end $$;
revoke all on function public.crypto_wallet_change_request(jsonb) from public, anon;
grant execute on function public.crypto_wallet_change_request(jsonb) to authenticated, service_role;

create or replace function public.crypto_wallet_change_approve(p_change uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c public.crypto_wallet_changes%rowtype;
  v_staff uuid;
  v_new uuid;
begin
  select * into c from public.crypto_wallet_changes where id = p_change for update;
  if not found then raise exception 'change not found' using errcode = 'P0002'; end if;
  if not public.has_permission(c.org_id, 'credit.adjust') then raise exception 'approving needs credit.adjust' using errcode = '42501'; end if;
  v_staff := public.crypto_staff_id(c.org_id);
  if c.status <> 'pending' then raise exception 'already decided' using errcode = '23514'; end if;
  if v_staff is null or v_staff = c.requested_by then raise exception 'a different person must approve' using errcode = '23514'; end if;
  update public.crypto_wallets set active = false where legal_entity_id = c.legal_entity_id and network = c.network and active;
  insert into public.crypto_wallets (org_id, legal_entity_id, network, address) values (c.org_id, c.legal_entity_id, c.network, c.new_address) returning id into v_new;
  update public.crypto_wallet_changes set status = 'applied', approved_by = v_staff, decided_at = now() where id = c.id;
  perform public.audit_record(c.org_id, null, 'credit.adjust', 'crypto_wallets', v_new::text,
    jsonb_build_object('kind', 'crypto_wallet_changed', 'network', c.network), 'app');
  return v_new;
end $$;
revoke all on function public.crypto_wallet_change_approve(uuid) from public, anon;
grant execute on function public.crypto_wallet_change_approve(uuid) to authenticated, service_role;

-- ── KYC ────────────────────────────────────────────────────────────────────
-- p = { store_id, customer_id, tier, full_name, nationality, passport_no, doc_path?, contact, owned_addresses?, source_of_funds? }
create or replace function public.crypto_kyc_submit(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_store public.stores%rowtype;
  v_id uuid;
begin
  select * into v_store from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found then raise exception 'shop not found' using errcode = 'P0002'; end if;
  if not (public.has_permission(v_store.org_id, 'customer.view') and public.has_permission(v_store.org_id, 'payment.take')
          and public.can_access_store(v_store.org_id, v_store.id)) then
    raise exception 'KYC needs payment.take' using errcode = '42501';
  end if;
  if not public.crypto_enabled(v_store.id) then raise exception 'crypto top-up is switched off' using errcode = '0A000'; end if;
  if not exists (select 1 from public.customers c where c.id = (p ->> 'customer_id')::uuid and c.org_id = v_store.org_id and c.deleted_at is null) then
    raise exception 'customer not found' using errcode = 'P0002';
  end if;
  insert into public.crypto_kyc (org_id, customer_id, tier, full_name, nationality, passport_no, doc_path, contact, owned_addresses, source_of_funds, created_by)
  values (v_store.org_id, (p ->> 'customer_id')::uuid, p ->> 'tier', btrim(p ->> 'full_name'), btrim(p ->> 'nationality'), p ->> 'passport_no',
          p ->> 'doc_path', btrim(p ->> 'contact'), coalesce(p -> 'owned_addresses', '[]'::jsonb), nullif(btrim(coalesce(p ->> 'source_of_funds', '')), ''),
          public.crypto_staff_id(v_store.org_id))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.crypto_kyc_submit(jsonb) from public, anon;
grant execute on function public.crypto_kyc_submit(jsonb) to authenticated, service_role;

create or replace function public.crypto_kyc_decide(p_kyc uuid, p_approve boolean, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k public.crypto_kyc%rowtype;
  v_staff uuid;
begin
  select * into k from public.crypto_kyc where id = p_kyc for update;
  if not found then raise exception 'KYC not found' using errcode = 'P0002'; end if;
  if not public.has_permission(k.org_id, 'credit.adjust') then raise exception 'deciding KYC needs credit.adjust' using errcode = '42501'; end if;
  if k.status <> 'pending' then raise exception 'already decided' using errcode = '23514'; end if;
  v_staff := public.crypto_staff_id(k.org_id);
  -- T2 (higher limits) is the owner's decision
  if p_approve and k.tier = 'T2' and not exists (
       select 1 from public.staff s join public.roles r on r.id = s.role_id where s.id = v_staff and r.built_in = 'owner') then
    raise exception 'T2 needs the owner' using errcode = '42501';
  end if;
  update public.crypto_kyc set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = v_staff, decided_at = now(), note = left(p_note, 300) where id = k.id;
  perform public.audit_record(k.org_id, null, 'credit.adjust', 'crypto_kyc', k.id::text,
    jsonb_build_object('kind', 'crypto_kyc', 'tier', k.tier, 'approved', p_approve), 'app');
end $$;
revoke all on function public.crypto_kyc_decide(uuid, boolean, text) from public, anon;
grant execute on function public.crypto_kyc_decide(uuid, boolean, text) to authenticated, service_role;

-- what a cashier may see about a customer's KYC (never the personal data)
create or replace function public.crypto_customer_status(p_customer uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c public.customers%rowtype;
begin
  select * into c from public.customers where id = p_customer;
  if not found or not public.has_permission(c.org_id, 'customer.view') then raise exception 'permission denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_build_object('kyc_id', k.id, 'tier', k.tier, 'status', k.status)
    from public.crypto_kyc k where k.customer_id = p_customer order by (k.status = 'approved') desc, k.created_at desc limit 1), 'null'::jsonb);
end $$;
revoke all on function public.crypto_customer_status(uuid) from public, anon;
grant execute on function public.crypto_customer_status(uuid) to authenticated, service_role;

-- ── limits and checks shared by the pre-check and the creation ─────────────
create or replace function public.crypto_check_internal(p_customer uuid, p_store uuid, p_network text, p_thb bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_store public.stores%rowtype;
  v_kyc   public.crypto_kyc%rowtype;
  v_wallet public.crypto_wallets%rowtype;
  v_day bigint;
  v_30 bigint;
  v_bal bigint;
  v_problems text[] := '{}';
  v_per_tx bigint; v_per_day bigint; v_per_30 bigint;
  v_min bigint := case p_network when 'tron' then 50000 when 'ethereum' then 100000 else 100000000000 end;
begin
  select * into v_store from public.stores where id = p_store and deleted_at is null;
  if not public.crypto_enabled(p_store) then return jsonb_build_object('ok', false, 'problem', 'switched_off'); end if;
  select * into v_kyc from public.crypto_kyc k where k.customer_id = p_customer and k.org_id = v_store.org_id and k.status = 'approved'
    order by (k.tier = 'T2') desc, k.created_at desc limit 1;
  if not found then return jsonb_build_object('ok', false, 'problem', 'kyc_required'); end if;
  select * into v_wallet from public.crypto_wallets w where w.legal_entity_id = v_store.legal_entity_id and w.network = p_network and w.active;
  if not found then return jsonb_build_object('ok', false, 'problem', 'no_wallet'); end if;

  v_per_tx := case v_kyc.tier when 'T1' then 3000000 else 10000000 end;
  v_per_day := v_per_tx;
  v_per_30 := case v_kyc.tier when 'T1' then 5000000 else 50000000 end;
  select coalesce(sum(r.thb_amount) filter (where r.created_at > now() - interval '24 hours'), 0),
         coalesce(sum(r.thb_amount) filter (where r.created_at > now() - interval '30 days'), 0)
    into v_day, v_30
    from public.crypto_requests r where r.customer_id = p_customer and r.status in ('open', 'paid_pending', 'credited', 'review');
  select coalesce(sum(l.amount), 0) into v_bal from public.credit_ledger l where l.customer_id = p_customer and l.legal_entity_id = v_store.legal_entity_id;

  if p_thb < greatest(50000, v_min) then v_problems := array_append(v_problems, 'below_minimum'); end if;
  if p_thb > v_per_tx then v_problems := array_append(v_problems, 'per_transaction'); end if;
  if v_day + p_thb > v_per_day then v_problems := array_append(v_problems, 'per_day'); end if;
  if v_30 + p_thb > v_per_30 then v_problems := array_append(v_problems, 'per_30_days'); end if;
  if v_bal + p_thb > 10000000 then v_problems := array_append(v_problems, 'balance_cap'); end if;
  if array_length(v_problems, 1) > 0 then return jsonb_build_object('ok', false, 'problem', v_problems[1], 'problems', to_jsonb(v_problems)); end if;
  return jsonb_build_object('ok', true, 'kyc_id', v_kyc.id, 'tier', v_kyc.tier, 'wallet_id', v_wallet.id, 'address', v_wallet.address,
    'taken_suffixes', coalesce((select jsonb_agg((r.amount_units % 1000)::int) from public.crypto_requests r
                                where r.network = p_network and r.receive_address = v_wallet.address and r.status in ('open', 'paid_pending')), '[]'::jsonb));
end $$;
revoke all on function public.crypto_check_internal(uuid, uuid, text, bigint) from public, anon, authenticated;

-- staff asks "may this customer top up this much?" (answers; the handler then fetches prices)
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
  v_res := public.crypto_check_internal((p ->> 'customer_id')::uuid, v_store.id, p ->> 'network', (p ->> 'thb')::bigint);
  return v_res || jsonb_build_object('staff_id', public.crypto_staff_id(v_store.org_id));
end $$;
revoke all on function public.crypto_request_precheck(jsonb) from public, anon;
grant execute on function public.crypto_request_precheck(jsonb) to authenticated, service_role;

-- the handler (service role) issues the request after fetching two prices and locking the rate
-- p = { store_id, customer_id, network, thb, rate, rate_sources, amount_units, staff_id }
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
revoke all on function public.crypto_create_request(jsonb) from public, anon, authenticated;
grant execute on function public.crypto_create_request(jsonb) to service_role;

create or replace function public.crypto_cancel_request(p_request uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.crypto_requests%rowtype;
begin
  select * into r from public.crypto_requests where id = p_request for update;
  if not found then raise exception 'request not found' using errcode = 'P0002'; end if;
  if not (public.has_permission(r.org_id, 'payment.take') and public.can_access_store(r.org_id, r.store_id)) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if r.status = 'open' then update public.crypto_requests set status = 'cancelled' where id = r.id; end if;
end $$;
revoke all on function public.crypto_cancel_request(uuid) from public, anon;
grant execute on function public.crypto_cancel_request(uuid) to authenticated, service_role;

-- open requests past their time wait 24 h more for a late payment (to be reviewed by a person), then close
create or replace function public.crypto_expire_requests() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.crypto_requests set status = 'expired' where status = 'open' and expires_at < now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.crypto_expire_requests() from public, anon, authenticated;
grant execute on function public.crypto_expire_requests() to service_role;

-- ── crediting (one place; idempotent: the ledger id IS the request id) ──────
create or replace function public.crypto_credit_internal(p_request uuid, p_transfer uuid, p_thb bigint, p_staff uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.crypto_requests%rowtype;
  t public.crypto_transfers%rowtype;
  v_today int; v_near int; v_cust_on_addr int; v_addrs int;
  v_k public.crypto_kyc%rowtype;
begin
  select * into r from public.crypto_requests where id = p_request for update;
  select * into t from public.crypto_transfers where id = p_transfer for update;
  if r.status = 'credited' then return; end if;
  insert into public.credit_ledger (id, org_id, legal_entity_id, customer_id, store_id, kind, amount, funding, debit_account, credit_account, crypto_request_id, created_by)
  values (r.id, r.org_id, r.legal_entity_id, r.customer_id, r.store_id, 'topup', p_thb, 'crypto', 'crypto_wallet', 'customer_credit', r.id, p_staff)
  on conflict (id) do nothing;
  update public.crypto_requests set status = 'credited', credited_at = now(), tx_hash = t.tx_hash where id = r.id;
  update public.crypto_transfers set status = 'credited', request_id = r.id, updated_at = now() where id = t.id;
  perform public.audit_record(r.org_id, r.store_id, 'credit.topup', 'customers', r.customer_id::text,
    jsonb_build_object('amount', p_thb, 'funding', 'crypto', 'network', r.network, 'request', r.id), 'db');

  -- automatic review flags (they alert; they do not undo a payment that already arrived)
  select count(*) into v_today from public.crypto_requests x where x.customer_id = r.customer_id and x.status = 'credited' and x.credited_at > now() - interval '24 hours';
  select count(*) into v_near from public.crypto_requests x join public.crypto_kyc k on k.id = x.kyc_id
   where x.customer_id = r.customer_id and x.status = 'credited' and x.credited_at > now() - interval '30 days'
     and x.thb_amount >= (case k.tier when 'T1' then 3000000 else 10000000 end) * 0.9;
  select count(distinct x.customer_id) into v_cust_on_addr from public.crypto_transfers tr join public.crypto_requests x on x.id = tr.request_id
   where tr.from_address = t.from_address and tr.network = t.network and tr.status = 'credited';
  select count(distinct tr.from_address) into v_addrs from public.crypto_transfers tr join public.crypto_requests x on x.id = tr.request_id
   where x.customer_id = r.customer_id and tr.status = 'credited' and tr.first_seen_at > now() - interval '30 days';
  if v_today > 3 then insert into public.crypto_flags (org_id, customer_id, request_id, rule, detail) values (r.org_id, r.customer_id, r.id, 'many_topups_24h', jsonb_build_object('count', v_today)); end if;
  if v_near >= 2 then insert into public.crypto_flags (org_id, customer_id, request_id, rule, detail) values (r.org_id, r.customer_id, r.id, 'near_limit_repeated', jsonb_build_object('count', v_near)); end if;
  if v_cust_on_addr > 1 then insert into public.crypto_flags (org_id, customer_id, request_id, rule, detail) values (r.org_id, r.customer_id, r.id, 'address_shared', jsonb_build_object('customers', v_cust_on_addr)); end if;
  if v_addrs > 3 then insert into public.crypto_flags (org_id, customer_id, request_id, rule, detail) values (r.org_id, r.customer_id, r.id, 'many_addresses_30d', jsonb_build_object('addresses', v_addrs)); end if;
end $$;
revoke all on function public.crypto_credit_internal(uuid, uuid, bigint, uuid) from public, anon, authenticated;

-- ── what the chain watcher reports ─────────────────────────────────────────
-- p = { network, tx_hash, log_index, from, to, units, block_time (iso), confirmations, success }
create or replace function public.crypto_record_transfer(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_net text := p ->> 'network';
  v_to text := case when p ->> 'network' = 'ethereum' then lower(p ->> 'to') else p ->> 'to' end;
  v_from text := case when p ->> 'network' = 'ethereum' then lower(p ->> 'from') else p ->> 'from' end;
  v_units bigint := (p ->> 'units')::bigint;
  v_conf integer := coalesce((p ->> 'confirmations')::integer, 0);
  v_btime timestamptz := (p ->> 'block_time')::timestamptz;
  w public.crypto_wallets%rowtype;
  t public.crypto_transfers%rowtype;
  r public.crypto_requests%rowtype;
  v_cands int;
  v_best bigint; v_second bigint;
  v_need integer := public.crypto_required_confirmations(p ->> 'network');
  v_k public.crypto_kyc%rowtype;
begin
  select * into w from public.crypto_wallets where network = v_net and address = v_to and active;
  if not found then return jsonb_build_object('status', 'ignored', 'reason', 'not_our_wallet'); end if;

  select * into t from public.crypto_transfers where network = v_net and tx_hash = p ->> 'tx_hash' and log_index = coalesce((p ->> 'log_index')::integer, 0) for update;
  if not found then
    insert into public.crypto_transfers (org_id, wallet_id, network, tx_hash, log_index, from_address, to_address, amount_units, block_time, confirmations)
    values (w.org_id, w.id, v_net, p ->> 'tx_hash', coalesce((p ->> 'log_index')::integer, 0), v_from, v_to, v_units, v_btime, v_conf)
    returning * into t;
  else
    update public.crypto_transfers set confirmations = greatest(confirmations, v_conf), updated_at = now() where id = t.id returning * into t;
  end if;
  if t.status in ('credited', 'ignored', 'rejected', 'review') then return jsonb_build_object('status', t.status); end if;

  if coalesce((p ->> 'success')::boolean, true) is not true then
    update public.crypto_transfers set status = 'ignored', reason = 'failed_transaction' where id = t.id;
    return jsonb_build_object('status', 'ignored', 'reason', 'failed_transaction');
  end if;
  if v_units < 10000 and t.request_id is null then
    update public.crypto_transfers set status = 'ignored', reason = 'dust' where id = t.id;   -- address-poisoning dust is never matched
    return jsonb_build_object('status', 'ignored', 'reason', 'dust');
  end if;

  if t.request_id is null then
    -- not matched yet: blocked sender → review; else find the nearest open request within tolerance
    if exists (select 1 from public.crypto_blocklist b where b.network = v_net and b.address = v_from) then
      update public.crypto_transfers set status = 'review', reason = 'blocked_sender' where id = t.id;
      insert into public.crypto_flags (org_id, rule, detail) values (w.org_id, 'blocked_sender', jsonb_build_object('tx', t.tx_hash));
      return jsonb_build_object('status', 'review', 'reason', 'blocked_sender');
    end if;
    select count(*), min(abs(x.amount_units - v_units))
      into v_cands, v_best
      from public.crypto_requests x
     where x.wallet_id = w.id and x.status = 'open' and x.created_at <= v_btime and x.expires_at >= v_btime
       and abs(x.amount_units - v_units) <= least((x.amount_units * 50) / 10000, 100000);
    if v_cands = 0 then
      update public.crypto_transfers set status = 'review',
             reason = case when exists (select 1 from public.crypto_requests x where x.wallet_id = w.id and x.status in ('open', 'expired')
                                         and abs(x.amount_units - v_units) <= least((x.amount_units * 50) / 10000, 100000)) then 'late_or_expired' else 'unmatched' end
       where id = t.id;
      return jsonb_build_object('status', 'review', 'reason', (select reason from public.crypto_transfers where id = t.id));
    end if;
    select x.* into r from public.crypto_requests x
     where x.wallet_id = w.id and x.status = 'open' and x.created_at <= v_btime and x.expires_at >= v_btime
       and abs(x.amount_units - v_units) = v_best
       and abs(x.amount_units - v_units) <= least((x.amount_units * 50) / 10000, 100000)
     order by x.created_at limit 1 for update;
    select min(abs(x.amount_units - v_units)) into v_second from public.crypto_requests x
     where x.wallet_id = w.id and x.status = 'open' and x.created_at <= v_btime and x.expires_at >= v_btime and x.id <> r.id
       and abs(x.amount_units - v_units) <= least((x.amount_units * 50) / 10000, 100000);
    if v_second is not null and v_second - v_best <= 2 then
      update public.crypto_transfers set status = 'review', reason = 'ambiguous' where id = t.id;
      return jsonb_build_object('status', 'review', 'reason', 'ambiguous');
    end if;
    update public.crypto_requests set status = 'paid_pending', tx_hash = t.tx_hash where id = r.id;
    update public.crypto_transfers set status = 'matched', request_id = r.id where id = t.id returning * into t;
  else
    select * into r from public.crypto_requests where id = t.request_id for update;
  end if;

  if t.confirmations < v_need then return jsonb_build_object('status', 'matched', 'confirmations', t.confirmations, 'needed', v_need); end if;

  -- T2 customers must send from a wallet they proved is theirs
  select * into v_k from public.crypto_kyc where id = r.kyc_id;
  if v_k.tier = 'T2' and not exists (select 1 from jsonb_array_elements(v_k.owned_addresses) a
        where lower(a ->> 'address') = lower(v_from) and a ->> 'network' = v_net) then
    update public.crypto_transfers set status = 'review', reason = 'sender_not_proven' where id = t.id;
    update public.crypto_requests set status = 'review' where id = r.id;
    insert into public.crypto_flags (org_id, customer_id, request_id, rule, detail) values (r.org_id, r.customer_id, r.id, 'sender_not_proven', jsonb_build_object('tx', t.tx_hash));
    return jsonb_build_object('status', 'review', 'reason', 'sender_not_proven');
  end if;

  perform public.crypto_credit_internal(r.id, t.id, r.thb_amount, null);
  return jsonb_build_object('status', 'credited', 'thb', r.thb_amount);
end $$;
revoke all on function public.crypto_record_transfer(jsonb) from public, anon, authenticated;
grant execute on function public.crypto_record_transfer(jsonb) to service_role;

-- ── a person decides a transfer that was not credited automatically ──
-- p_action: 'credit' (credit the amount actually received at the rate locked in p_request) or 'reject' (money is handled outside the system)
create or replace function public.crypto_resolve_review(p_transfer uuid, p_action text, p_request uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.crypto_transfers%rowtype;
  r public.crypto_requests%rowtype;
  v_staff uuid;
  v_thb bigint;
  v_chk jsonb;
begin
  select * into t from public.crypto_transfers where id = p_transfer for update;
  if not found then raise exception 'transfer not found' using errcode = 'P0002'; end if;
  if not public.has_permission(t.org_id, 'credit.adjust') then raise exception 'reviewing needs credit.adjust' using errcode = '42501'; end if;
  if t.status <> 'review' then raise exception 'this transfer is not waiting for review' using errcode = '23514'; end if;
  if length(btrim(coalesce(p_note, ''))) = 0 then raise exception 'a note is required' using errcode = '22023'; end if;
  v_staff := public.crypto_staff_id(t.org_id);

  if p_action = 'reject' then
    update public.crypto_transfers set status = 'rejected', reason = left(p_note, 100), updated_at = now() where id = t.id;
    perform public.audit_record(t.org_id, null, 'credit.adjust', 'crypto_transfers', t.id::text, jsonb_build_object('kind', 'crypto_review_rejected'), 'app');
    return jsonb_build_object('status', 'rejected');
  elsif p_action = 'credit' then
    select * into r from public.crypto_requests where id = p_request and org_id = t.org_id and wallet_id = t.wallet_id for update;
    if not found then raise exception 'choose the request this payment belongs to' using errcode = 'P0002'; end if;
    if r.status = 'credited' then raise exception 'that request is already credited' using errcode = '23514'; end if;
    if exists (select 1 from public.crypto_blocklist b where b.network = t.network and b.address = t.from_address) then
      raise exception 'the sender is blocked' using errcode = '23514';
    end if;
    if t.confirmations < public.crypto_required_confirmations(t.network) then raise exception 'not final yet' using errcode = '23514'; end if;
    v_thb := floor(t.amount_units::numeric * r.rate / 1000000);                    -- what was actually received, at the locked rate
    v_thb := least(v_thb, r.thb_amount);                                           -- never more than the request (an over-payment is the customer's gift, not extra Credit)
    if v_thb < 50000 then raise exception 'less than the minimum top-up' using errcode = '23514'; end if;
    update public.crypto_transfers set request_id = r.id, status = 'matched' where id = t.id;
    perform public.crypto_credit_internal(r.id, t.id, v_thb, v_staff);
    perform public.audit_record(t.org_id, null, 'credit.adjust', 'crypto_transfers', t.id::text,
      jsonb_build_object('kind', 'crypto_review_credited', 'thb', v_thb), 'app');
    return jsonb_build_object('status', 'credited', 'thb', v_thb);
  end if;
  raise exception 'unknown action' using errcode = '22023';
end $$;
revoke all on function public.crypto_resolve_review(uuid, text, uuid, text) from public, anon;
grant execute on function public.crypto_resolve_review(uuid, text, uuid, text) to authenticated, service_role;

-- ── AML report: every crypto top-up that became Credit, with who, which wallet, which tx, which rate ──
create or replace function public.crypto_aml_report(p_org uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_permission(p_org, 'credit.adjust') then raise exception 'the AML report needs credit.adjust' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'the date range is not valid' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(x order by x ->> 'credited_at') from (
    select jsonb_build_object(
      'credited_at', r.credited_at, 'request_id', r.id, 'customer', k.full_name, 'nationality', k.nationality,
      'passport_last4', right(k.passport_no, 4), 'tier', k.tier, 'contact', k.contact,
      'network', r.network, 'token', r.token, 'tx_hash', tr.tx_hash, 'from_address', tr.from_address, 'to_address', tr.to_address,
      'units', tr.amount_units, 'thb', r.thb_amount, 'rate', r.rate, 'rate_sources', r.rate_sources,
      'flags', coalesce((select jsonb_agg(f.rule) from public.crypto_flags f where f.request_id = r.id), '[]'::jsonb)) as x
      from public.crypto_requests r
      join public.crypto_kyc k on k.id = r.kyc_id
      join public.crypto_transfers tr on tr.request_id = r.id and tr.status = 'credited'
     where r.org_id = p_org and r.status = 'credited'
       and (r.credited_at at time zone 'Asia/Bangkok')::date between p_from and p_to) t), '[]'::jsonb);
end $$;
revoke all on function public.crypto_aml_report(uuid, date, date) from public, anon;
grant execute on function public.crypto_aml_report(uuid, date, date) to authenticated, service_role;

-- watcher bookkeeping
create or replace function public.crypto_set_cursor(p_wallet uuid, p_ms bigint) returns void
language sql security definer set search_path = '' as $$
  update public.crypto_wallets set poll_cursor_ms = greatest(poll_cursor_ms, p_ms) where id = p_wallet
$$;
revoke all on function public.crypto_set_cursor(uuid, bigint) from public, anon, authenticated;
grant execute on function public.crypto_set_cursor(uuid, bigint) to service_role;
