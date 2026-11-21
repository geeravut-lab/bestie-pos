-- Bestie POS · migration 66 · Spa / yoga advisor (owner order 2026-11-21: rules to common international practice, switched on only after a therapist has read and signed them).
-- The advisor is a FIXED rule set in packages/core/src/spaAdvisor.ts (closed questions, a safety screen, a ranking of the shop's own services). No AI, nothing stored.
-- It reaches a guest only when ALL hold (`spa_advisor_enabled`): online booking is on, the shop switched the module `advisor.spa` on (Pro plan), and a THERAPIST SIGN-OFF
-- recorded by the owner for the CURRENT rules version is on file. Raising the rules version voids every earlier sign-off.

create or replace function public.stores_check_modules() returns trigger
language plpgsql set search_path = '' as $$
declare
  k text;
  known text[] := array['tables.floorplan','bill.split','queue.call','kds','order.qr','kiosk','delivery','service.charge',
    'appointments','resources','deposits','commission','packages','booking.online','slots.booking','folio','pms','stock','recipe.cost',
    'loyalty.network','tender.promptpay','tender.gateway','tender.credit','tender.points','credit.topup.crypto',
    'ai.assistant','ai.guest','line.notify','advisor.spa'];
  crypto_ok boolean;
begin
  for k in select jsonb_object_keys(new.module_overrides) loop
    if not (k = any (known)) then raise exception 'unknown module %', k using errcode = '23514'; end if;
    if jsonb_typeof(new.module_overrides -> k) <> 'boolean' then raise exception 'module % must be true or false', k using errcode = '23514'; end if;
  end loop;
  if (new.module_overrides ->> 'credit.topup.crypto') = 'true' then
    select coalesce((o.legal_sign_off ->> 'cryptoTopup')::boolean, false) into crypto_ok from public.orgs o where o.id = new.org_id;
    if not coalesce(crypto_ok, false) then
      raise exception 'crypto top-up needs the org legal sign-off' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create or replace function public.spa_rules_version() returns integer language sql immutable set search_path = '' as $$ select 1 $$;
revoke all on function public.spa_rules_version() from public, anon;
grant execute on function public.spa_rules_version() to authenticated, service_role;

alter table public.menu_items add column spa_tags text[] not null default '{}'::text[]
  check (spa_tags <@ array['thai_massage','oil_massage','aromatherapy','foot_massage','head_neck','hot_compress','scrub','facial','yoga_gentle','yoga_flow','yoga_restorative','meditation']::text[] and cardinality(spa_tags) <= 6);
alter table public.stores add column spa_rules_signoff jsonb
  check (spa_rules_signoff is null or (jsonb_typeof(spa_rules_signoff) = 'object' and (spa_rules_signoff ->> 'version') ~ '^[0-9]+$'
         and length(btrim(coalesce(spa_rules_signoff ->> 'name', ''))) between 2 and 80));

create or replace function public.spa_advisor_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.booking_online_enabled(p_store) and exists (
    select 1 from public.stores s
     where s.id = p_store
       and coalesce((s.module_overrides ->> 'advisor.spa')::boolean, false)
       and (s.spa_rules_signoff ->> 'version')::integer = public.spa_rules_version())
$$;
revoke all on function public.spa_advisor_enabled(uuid) from public, anon;
grant execute on function public.spa_advisor_enabled(uuid) to authenticated, service_role;

-- the shop ticks what each of its services is (menu.edit)
create or replace function public.save_spa_tags(p_item uuid, p_tags text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.menu_items%rowtype;
begin
  select * into m from public.menu_items where id = p_item and deleted_at is null;
  if not found or not public.can_edit_menu(m.store_id) then raise exception 'tagging a service needs menu.edit in this shop' using errcode = '42501'; end if;
  if m.duration_min is null then raise exception 'only a service (an item with a length in minutes) is tagged' using errcode = '22023'; end if;
  update public.menu_items set spa_tags = coalesce(p_tags, '{}'::text[]) where id = p_item;   -- the CHECK refuses an unknown or too long list
end $$;

-- the OWNER records that a therapist has read and approved the current rules (null name = withdraw the sign-off)
create or replace function public.confirm_spa_rules(p_store uuid, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype;
begin
  select * into s from public.stores where id = p_store and deleted_at is null;
  if not found or not public.is_org_owner(s.org_id) then raise exception 'the sign-off is recorded by the owner' using errcode = '42501'; end if;
  if p_name is null then
    update public.stores set spa_rules_signoff = null where id = p_store;
  else
    if length(btrim(p_name)) not between 2 and 80 then raise exception 'the therapist''s name is needed' using errcode = '22023'; end if;
    update public.stores set spa_rules_signoff = jsonb_build_object('name', btrim(p_name), 'at', now(), 'version', public.spa_rules_version()) where id = p_store;
  end if;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'stores', s.id::text,
    jsonb_build_object('spa_rules_signoff', p_name is not null, 'version', public.spa_rules_version()), 'db');
end $$;
revoke all on function public.save_spa_tags(uuid, text[]), public.confirm_spa_rules(uuid, text) from public, anon;
grant execute on function public.save_spa_tags(uuid, text[]), public.confirm_spa_rules(uuid, text) to authenticated, service_role;

-- what the guest page needs: is the advisor on for this booking link, and the tags of the bookable services
create or replace function public.guest_spa_info(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype;
begin
  s := public.booking_store(p_token);
  if s.id is null then return null; end if;
  if not public.spa_advisor_enabled(s.id) then return jsonb_build_object('enabled', false, 'services', '[]'::jsonb); end if;
  return jsonb_build_object('enabled', true, 'services', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'tags', to_jsonb(m.spa_tags)) order by m.sort, m.created_at)
      from public.menu_items m where m.store_id = s.id and m.deleted_at is null and m.available and m.duration_min is not null), '[]'::jsonb));
end $$;
revoke all on function public.guest_spa_info(text) from public, anon, authenticated;
grant execute on function public.guest_spa_info(text) to service_role;
