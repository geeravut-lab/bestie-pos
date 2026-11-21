-- Bestie POS · migration 82 · PMS link (owner order 1 of 21 Nov 2026): a stay in the folio may be linked to a reservation in the hotel's own system
-- (Mews / Cloudbeds). Bestie's folio stays the book of record for what the outlets sold; the PMS gets each room charge as one posting.
--  * `folios.pms_reservation_id` — the reservation (or account) id in the PMS; set by the front desk after "Import from the PMS" or by hand.
--  * `folio_charges.pms_posted_at / pms_ref / pms_error / pms_tries` — what happened to the posting of a BILL charge (nights are the PMS's own business, returns are not posted).
--  * the tick takes `pms_pending_charges()` (service role), posts each charge with the receipt number as the reference, and reports with `pms_mark_posted()`;
--    a failure is kept (error text, tries) and retried up to 5 times; a charge taken off (voided) before it was posted is never posted.
--  * the module `pms` (Resort plan, needs `folio`) must be on in the shop; `pms_context()` lets the page ask (with the person's own token) whether the front desk may use it.
alter table public.folios add column pms_reservation_id text check (pms_reservation_id is null or length(pms_reservation_id) between 1 and 80);
alter table public.folio_charges
  add column pms_posted_at timestamptz,
  add column pms_ref       text check (pms_ref is null or length(pms_ref) <= 120),
  add column pms_error     text check (pms_error is null or length(pms_error) <= 300),
  add column pms_tries     integer not null default 0 check (pms_tries between 0 and 20);
create unique index folios_pms_open_uidx on public.folios (store_id, pms_reservation_id) where pms_reservation_id is not null and status = 'open';

create or replace function public.pms_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.folio_enabled(p_store) and exists (select 1 from public.stores s where s.id = p_store and coalesce((s.module_overrides ->> 'pms')::boolean, false))
$$;
revoke all on function public.pms_enabled(uuid) from public, anon;
grant execute on function public.pms_enabled(uuid) to authenticated, service_role;

-- the page asks (with the person's own token) before it calls the server's PMS reader
create or replace function public.pms_context(p_store uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype;
begin
  select * into s from public.stores where id = p_store and deleted_at is null;
  if not found or not (public.can_access_store(s.org_id, s.id) and public.has_permission(s.org_id, 'order.create')) then
    raise exception 'the PMS link needs order.create in this shop' using errcode = '42501';
  end if;
  if not public.pms_enabled(s.id) then raise exception 'the PMS module is off in this shop' using errcode = '0A000'; end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.pms_context(uuid) from public, anon;
grant execute on function public.pms_context(uuid) to authenticated, service_role;

-- link (or unlink with an empty id) an open stay to a PMS reservation (order.create at the resort shop)
create or replace function public.folio_link_pms(p_folio uuid, p_reservation text) returns void
language plpgsql security definer set search_path = '' as $$
declare f public.folios%rowtype; v text := nullif(btrim(coalesce(p_reservation, '')), '');
begin
  select * into f from public.folios where id = p_folio for update;
  if not found or not (public.can_access_store(f.org_id, f.store_id) and public.has_permission(f.org_id, 'order.create')) then
    raise exception 'linking a stay needs order.create in the resort shop' using errcode = '42501';
  end if;
  if not public.pms_enabled(f.store_id) then raise exception 'the PMS module is off in this shop' using errcode = '0A000'; end if;
  if f.status <> 'open' then raise exception 'only an open stay can be linked' using errcode = '55000'; end if;
  update public.folios set pms_reservation_id = v where id = f.id;
  perform public.audit_record(f.org_id, f.store_id, 'settings.change', 'folios.pms', f.id::text, jsonb_build_object('linked', v is not null), 'db');
end $$;
revoke all on function public.folio_link_pms(uuid, text) from public, anon;
grant execute on function public.folio_link_pms(uuid, text) to authenticated, service_role;

-- the tick: bill charges not yet posted to the PMS
create or replace function public.pms_pending_charges(p_limit integer default 20) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select c.id, f.pms_reservation_id as reservation, c.amount,
           coalesce(c.receipt_number, '') as receipt, (select s.name from public.stores s where s.id = c.store_id) as outlet
      from public.folio_charges c join public.folios f on f.id = c.folio_id
     where c.kind = 'bill' and c.voided_at is null and c.pms_posted_at is null and c.pms_tries < 5
       and f.pms_reservation_id is not null and f.status = 'open' and public.pms_enabled(f.store_id)
     order by c.created_at limit greatest(1, least(coalesce(p_limit, 20), 100))
  ) x
$$;
revoke all on function public.pms_pending_charges(integer) from public, anon, authenticated;
grant execute on function public.pms_pending_charges(integer) to service_role;

create or replace function public.pms_mark_posted(p_charge uuid, p_ok boolean, p_ref text, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_ok then
    update public.folio_charges set pms_posted_at = now(), pms_ref = left(p_ref, 120), pms_error = null, pms_tries = pms_tries + 1 where id = p_charge and pms_posted_at is null;
  else
    update public.folio_charges set pms_error = left(coalesce(p_error, 'failed'), 300), pms_tries = pms_tries + 1 where id = p_charge and pms_posted_at is null;
  end if;
end $$;
revoke all on function public.pms_mark_posted(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.pms_mark_posted(uuid, boolean, text, text) to service_role;
