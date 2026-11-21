-- Bestie POS · migration 80 · FULL TAX INVOICE (ใบกำกับภาษีเต็มรูป) on request, for a paid bill of a VAT-registered shop.
--
--  * A receipt printed by the till is an ABBREVIATED tax invoice. A business customer who wants to claim the VAT asks for a FULL tax invoice: the buyer's name, address, 13-digit
--    tax ID and branch (00000 = head office) are added to the SAME sale. `issue_tax_invoice` writes one `tax_invoices` row per receipt (unique), numbered `TI-000001…` per shop
--    (consecutive, gap-free: the counter is taken under a lock inside the same transaction), only for a PAID bill of a VAT-registered shop whose legal entity has a 13-digit tax ID.
--  * The seller's ADDRESS is new data (`legal_entities.address` for the company, `stores.address` for the branch), set by the owner (`save_tax_profile`, audited).
--  * An issued invoice is never edited. A mistake is CANCELLED (`cancel_tax_invoice`, refund.create, reason, critical audit): the row stays, the number stays used, and a new
--    invoice can then be issued for the same receipt (the cancelled one keeps its own row; the unique rule applies to live invoices).
--  * The invoice carries the sale as the frozen receipt has it (VAT breakdown, service charge, discounts) and lists the order lines. It says which abbreviated receipt it belongs to,
--    so the shop and the buyer file ONE of them (the accountant's rule: the full invoice replaces the abbreviated one).
--  * `etax_status` is kept ('none' now) for the day an accredited e-Tax Invoice service provider is connected (docs/ETAX.md): Bestie does not send anything to the Revenue Department.

-- the document counters learn one more kind (TI)
do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'public.service_doc_counters'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%' loop
    execute format('alter table public.service_doc_counters drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.service_doc_counters add constraint service_doc_counters_kind_check check (kind in ('DP', 'NF', 'TI'));

alter table public.legal_entities add column address text check (address is null or length(address) <= 300);
alter table public.stores add column address text check (address is null or length(address) <= 300);

create table public.tax_invoices (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs (id) on delete cascade,
  store_id      uuid not null references public.stores (id) on delete cascade,
  receipt_id    uuid not null references public.receipts (id),
  order_id      uuid not null references public.orders (id),
  number        text not null check (number ~ '^TI-[0-9]{6,9}$'),
  issued_at     timestamptz not null default now(),
  buyer_name    text not null check (length(btrim(buyer_name)) between 1 and 120),
  buyer_tax_id  text not null check (buyer_tax_id ~ '^[0-9]{13}$'),
  buyer_branch  text not null default '00000' check (buyer_branch ~ '^[0-9]{5}$'),
  buyer_address text not null check (length(btrim(buyer_address)) between 5 and 300),
  status        text not null default 'issued' check (status in ('issued', 'cancelled')),
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 200),
  cancelled_at  timestamptz,
  etax_status   text not null default 'none' check (etax_status in ('none', 'sent', 'failed')),
  created_by    uuid references public.staff (id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (store_id, number),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create unique index tax_invoices_live_receipt_uidx on public.tax_invoices (receipt_id) where status = 'issued';
create index tax_invoices_order_idx on public.tax_invoices (order_id);
alter table public.tax_invoices enable row level security;
create policy tax_invoices_read on public.tax_invoices for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.tax_invoices from anon, authenticated;
grant select on public.tax_invoices to authenticated;
create trigger tax_invoices_live after insert or update on public.tax_invoices for each row execute function public.live_ping_row('store:{store_id}');

-- an invoice is history: only its own cancellation may change it, nothing may delete it
create or replace function public.tax_invoices_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a tax invoice cannot be deleted' using errcode = '42501'; end if;
  if (to_jsonb(new) - 'status' - 'cancel_reason' - 'cancelled_at' - 'etax_status') is distinct from (to_jsonb(old) - 'status' - 'cancel_reason' - 'cancelled_at' - 'etax_status') then
    raise exception 'a tax invoice cannot be edited, cancel it and issue a new one' using errcode = '42501';
  end if;
  if old.status = 'cancelled' and new.status <> 'cancelled' then raise exception 'a cancelled invoice stays cancelled' using errcode = '42501'; end if;
  return new;
end $$;
create trigger tax_invoices_no_edit before update or delete on public.tax_invoices for each row execute function public.tax_invoices_guard();

-- the owner sets the seller's address (company and this branch)
-- p = { store_id, company_address?, branch_address? }   (owner)
create or replace function public.save_tax_profile(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.is_org_owner(s.org_id) then raise exception 'the seller address is set by the owner' using errcode = '42501'; end if;
  if p ? 'company_address' then update public.legal_entities set address = left(nullif(btrim(p ->> 'company_address'), ''), 300) where id = s.legal_entity_id; end if;
  if p ? 'branch_address' then update public.stores set address = left(nullif(btrim(p ->> 'branch_address'), ''), 300) where id = s.id; end if;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'tax_profile', s.id::text, jsonb_build_object('address', true), 'db');
end $$;
revoke all on function public.save_tax_profile(jsonb) from public, anon;
grant execute on function public.save_tax_profile(jsonb) to authenticated, service_role;

-- p = { order_id, buyer_name, buyer_tax_id, buyer_branch?, buyer_address }  → { id, number, replay }
create or replace function public.issue_tax_invoice(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders%rowtype; r public.receipts%rowtype; s public.stores%rowtype; le public.legal_entities%rowtype; old public.tax_invoices%rowtype;
  v_staff uuid; v_id uuid; v_no text;
begin
  select * into o from public.orders where id = (p ->> 'order_id')::uuid for update;
  if not found or not (public.can_access_store(o.org_id, o.store_id) and public.has_permission(o.org_id, 'payment.take')) then
    raise exception 'a tax invoice needs payment.take in this shop' using errcode = '42501';
  end if;
  if o.status <> 'paid' then raise exception 'only a paid bill can have a tax invoice' using errcode = '55000'; end if;
  select * into r from public.receipts where order_id = o.id;
  if not found then raise exception 'the bill has no receipt' using errcode = '55000'; end if;
  select * into old from public.tax_invoices where receipt_id = r.id and status = 'issued';
  if found then return jsonb_build_object('id', old.id, 'number', old.number, 'replay', true); end if;
  select * into s from public.stores where id = o.store_id;
  select * into le from public.legal_entities where id = s.legal_entity_id;
  if not r.vat_registered then raise exception 'this shop is not VAT registered' using errcode = '55000'; end if;
  if r.seller_tax_id is null or r.seller_tax_id !~ '^[0-9]{13}$' then raise exception 'the seller has no 13-digit tax ID' using errcode = '55000'; end if;
  if coalesce(btrim(le.address), '') = '' and coalesce(btrim(s.address), '') = '' then raise exception 'set the seller address first' using errcode = '55000'; end if;
  select f.id into v_staff from public.staff f where f.org_id = o.org_id and f.user_id = auth.uid() and f.active limit 1;
  perform pg_advisory_xact_lock(hashtext('taxinv:' || o.store_id::text));
  v_no := public.next_service_doc(o.store_id, 'TI');
  insert into public.tax_invoices (org_id, store_id, receipt_id, order_id, number, buyer_name, buyer_tax_id, buyer_branch, buyer_address, created_by)
  values (o.org_id, o.store_id, r.id, o.id, v_no, btrim(p ->> 'buyer_name'), btrim(p ->> 'buyer_tax_id'), coalesce(nullif(btrim(p ->> 'buyer_branch'), ''), '00000'),
          btrim(p ->> 'buyer_address'), v_staff) returning id into v_id;
  perform public.audit_record(o.org_id, o.store_id, 'payment.tender', 'tax_invoices', v_id::text, jsonb_build_object('number', v_no, 'receipt', r.number), 'db');
  return jsonb_build_object('id', v_id, 'number', v_no, 'replay', false);
end $$;

create or replace function public.cancel_tax_invoice(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.tax_invoices%rowtype;
begin
  select * into t from public.tax_invoices where id = p_id for update;
  if not found or not (public.can_access_store(t.org_id, t.store_id) and public.has_permission(t.org_id, 'refund.create')) then
    raise exception 'cancelling a tax invoice needs refund.create' using errcode = '42501';
  end if;
  if t.status = 'cancelled' then return; end if;
  if length(btrim(coalesce(p_reason, ''))) not between 3 and 200 then raise exception 'a reason is needed' using errcode = '22023'; end if;
  update public.tax_invoices set status = 'cancelled', cancelled_at = now(), cancel_reason = btrim(p_reason) where id = t.id;
  perform public.audit_record(t.org_id, t.store_id, 'payment.refund', 'tax_invoices', t.id::text, jsonb_build_object('number', t.number, 'reason', btrim(p_reason)), 'db');
end $$;
revoke all on function public.issue_tax_invoice(jsonb), public.cancel_tax_invoice(uuid, text) from public, anon;
grant execute on function public.issue_tax_invoice(jsonb), public.cancel_tax_invoice(uuid, text) to authenticated, service_role;
