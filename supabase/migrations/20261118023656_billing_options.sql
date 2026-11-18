-- Bestie POS · migration 10 · owner-selectable billing & points options.
--
-- The accounting choices are DATA, not code: whether the service charge is part of the VAT base, whether it is computed
-- before or after discounts, the cash rounding rule (stores.rounding already existed), and the Points rule. Owners change
-- them (settings.manage); every change is audited (settings.change). Shapes are guarded here so a bad value can never reach
-- the till.

alter table public.stores add column bill_options jsonb not null default '{}'::jsonb
  check (jsonb_typeof(bill_options) = 'object');
alter table public.orgs add column points_rule jsonb not null default '{}'::jsonb
  check (jsonb_typeof(points_rule) = 'object');

create or replace function public.stores_check_billing() returns trigger
language plpgsql set search_path = '' as $$
declare
  k text;
  v text;
begin
  for k in select jsonb_object_keys(new.bill_options) loop
    v := new.bill_options ->> k;
    if not ((k = 'serviceChargeVat' and v in ('taxable', 'not_taxable'))
         or (k = 'serviceChargeBase' and v in ('after_discounts', 'before_discounts'))) then
      raise exception 'invalid bill option %', k using errcode = '23514';
    end if;
  end loop;
  for k in select jsonb_object_keys(new.rounding) loop
    v := new.rounding ->> k;
    if k not in ('cash', 'promptpay', 'gateway', 'credit', 'points')
       or v not in ('none', 'nearest-25', 'nearest-50', 'nearest-baht', 'floor-baht') then
      raise exception 'invalid rounding rule %', k using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;
create trigger stores_billing_check before insert or update of bill_options, rounding on public.stores
  for each row execute function public.stores_check_billing();

create or replace function public.orgs_check_points_rule() returns trigger
language plpgsql set search_path = '' as $$
declare
  k text;
  n numeric;
begin
  for k in select jsonb_object_keys(new.points_rule) loop
    if k = 'creditEarnsPoints' then
      if jsonb_typeof(new.points_rule -> k) <> 'boolean' then raise exception 'invalid %', k using errcode = '23514'; end if;
    elsif k in ('earnSatangPerPoint', 'redeemSatangPerPoint', 'maxRedeemBps') then
      if jsonb_typeof(new.points_rule -> k) <> 'number' then raise exception 'invalid %', k using errcode = '23514'; end if;
      n := (new.points_rule ->> k)::numeric;
      if n <> trunc(n)
         or (k = 'earnSatangPerPoint' and n not between 100 and 1000000)
         or (k = 'redeemSatangPerPoint' and n not between 1 and 10000)
         or (k = 'maxRedeemBps' and n not between 0 and 10000) then
        raise exception 'invalid %', k using errcode = '23514';
      end if;
    else
      raise exception 'unknown points rule key %', k using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;
create trigger orgs_points_rule_check before insert or update of points_rule on public.orgs
  for each row execute function public.orgs_check_points_rule();

-- audit: billing and points changes are recorded as settings.change
create or replace function public.audit_trg_stores() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.module_overrides is distinct from old.module_overrides then
    perform public.audit_record(new.org_id, new.id, 'module.toggle', 'stores', new.id::text,
      jsonb_build_object('overrides_count', (select count(*) from jsonb_object_keys(new.module_overrides))), 'db');
  end if;
  if new.vat_registered is distinct from old.vat_registered or new.vat_bps is distinct from old.vat_bps
     or new.branch_code is distinct from old.branch_code or new.service_charge_bps is distinct from old.service_charge_bps
     or new.price_mode is distinct from old.price_mode or new.plan is distinct from old.plan then
    perform public.audit_record(new.org_id, new.id, 'settings.change', 'stores', new.id::text, jsonb_build_object('area', 'tax_or_plan'), 'db');
  end if;
  if new.bill_options is distinct from old.bill_options or new.rounding is distinct from old.rounding then
    perform public.audit_record(new.org_id, new.id, 'settings.change', 'stores', new.id::text, jsonb_build_object('area', 'billing'), 'db');
  end if;
  return new;
end $$;

create or replace function public.audit_trg_orgs() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.legal_sign_off is distinct from old.legal_sign_off then
    perform public.audit_record(new.id, null, 'org.legal_signoff_change', 'orgs', new.id::text,
      jsonb_build_object('crypto_topup', coalesce((new.legal_sign_off ->> 'cryptoTopup')::boolean, false)), 'db');
  end if;
  if new.points_rule is distinct from old.points_rule then
    perform public.audit_record(new.id, null, 'settings.change', 'orgs', new.id::text, jsonb_build_object('area', 'points'), 'db');
  end if;
  return new;
end $$;
