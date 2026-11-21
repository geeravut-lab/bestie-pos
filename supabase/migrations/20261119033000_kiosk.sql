-- Bestie POS · migration 78 · SELF-ORDER KIOSK (module `kiosk`, plan Pro, off by default).
--
--  * A KIOSK is a screen at the counter (a tablet on a stand, or a guest's own phone scanning its QR) where a customer builds an order from the menu with pictures, options and
--    notes, then taps "Send". It reuses the guest table-QR ordering (`/t/<token>`): a kiosk is a row of `dining_tables` with `kind = 'kiosk'` and its own random token, so the
--    database prices every line (never the phone), checks every option and its min / max, refuses unavailable items and applies the same limits and replay protection.
--  * What differs for a kiosk, all decided in the database:
--      - every order is its OWN bill: channel `takeaway`, number `KS001…` (the queue number the customer takes), no table; it is never added to an earlier bill;
--      - prices are the TAKEAWAY channel prices (a kiosk is not table service: no service charge, no dine-in price);
--      - the lines wait unsent (the cashier takes payment, and the till sends the lines to the kitchen as part of paying) — the kiosk never auto-sends and never takes money;
--      - up to 60 orders per kiosk per 10 minutes (a busy counter), instead of 12 per table;
--      - the module `kiosk` (not `order.qr`) switches it on or off.
--  * Kiosks are made and replaced by the owner (`save_kiosk`, menu.edit, audited); a kiosk never appears on the floor plan.
--  * NOT built: paying at the kiosk (cash or PromptPay at the counter for now), a printed queue ticket from the kiosk, idle-screen branding, a kiosk-only menu.

-- registry:kiosk profiles= plan=pro,resort depends=
create or replace function public.kiosk_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stores s
                  where s.id = p_store and s.deleted_at is null and s.plan in ('pro', 'resort')
                    and coalesce((s.module_overrides ->> 'kiosk')::boolean, false))
$$;
revoke all on function public.kiosk_enabled(uuid) from public, anon;
grant execute on function public.kiosk_enabled(uuid) to authenticated, service_role;

alter table public.dining_tables add column kind text not null default 'table' check (kind in ('table', 'kiosk'));

-- p = { store_id, id?, name, active?, rotate? } → { id, token }   (menu.edit; the token is also readable by staff of the shop, like a table's)
create or replace function public.save_kiosk(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; v_id uuid := nullif(p ->> 'id', '')::uuid; v_token text;
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_edit_menu(s.id) then raise exception 'kiosks need menu.edit in this shop' using errcode = '42501'; end if;
  if not public.kiosk_enabled(s.id) then raise exception 'the kiosk module is off in this shop' using errcode = '0A000'; end if;
  if v_id is null then
    insert into public.dining_tables (org_id, store_id, name, zone, seats, kind, active)
    values (s.org_id, s.id, btrim(p ->> 'name'), 'kiosk', 1, 'kiosk', coalesce((p ->> 'active')::boolean, true)) returning id, qr_token into v_id, v_token;
  else
    update public.dining_tables
       set name = coalesce(btrim(p ->> 'name'), name), active = coalesce((p ->> 'active')::boolean, active),
           qr_token = case when coalesce((p ->> 'rotate')::boolean, false) then replace(gen_random_uuid()::text, '-', '') else qr_token end
     where id = v_id and store_id = s.id and kind = 'kiosk' and deleted_at is null
     returning qr_token into v_token;
    if not found then raise exception 'unknown kiosk' using errcode = '22023'; end if;
  end if;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'kiosks', v_id::text, jsonb_build_object('active', p -> 'active', 'rotated', coalesce((p ->> 'rotate')::boolean, false)), 'db');
  return jsonb_build_object('id', v_id, 'token', v_token);
end $$;
revoke all on function public.save_kiosk(jsonb) from public, anon;
grant execute on function public.save_kiosk(jsonb) to authenticated, service_role;

-- ── the guest functions learn about kiosks (re-created from their own definitions; the migration fails if a text did not change) ──
do $$
declare r record; src text; dst text;
begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('guest_table', 'guest_menu', 'guest_place_order') loop
    src := pg_get_functiondef(r.oid);
    dst := src;
    if r.proname = 'guest_table' then
      dst := replace(dst, $a$'qr_enabled', public.qr_ordering_enabled(s.id)$a$,
        $a$'qr_enabled', case when t.kind = 'kiosk' then public.kiosk_enabled(s.id) else public.qr_ordering_enabled(s.id) end, 'kiosk', t.kind = 'kiosk'$a$);
    elsif r.proname = 'guest_menu' then
      dst := replace(dst, 'with t as (select t.store_id from public.dining_tables t',
        $a$with t as (select t.store_id, case when t.kind = 'kiosk' then 'takeaway' else 'dine-in' end as ch from public.dining_tables t$a$);
      dst := replace(dst, $a$(i.prices ->> 'dine-in')$a$, $a$(i.prices ->> (select ch from t))$a$);
      dst := replace(dst, $a$(o.channel_delta ->> 'dine-in')$a$, $a$(o.channel_delta ->> (select ch from t))$a$);
    else
      dst := replace(dst, E'  v_now    timestamptz := now();\nbegin', E'  v_now    timestamptz := now();\n  v_ch     text := ''dine-in'';\nbegin');
      dst := replace(dst, $a$  if not public.qr_ordering_enabled(s.id) then raise exception 'ordering from the table is switched off' using errcode = '0A000'; end if;$a$,
        $a$  if t.kind = 'kiosk' then
    if not public.kiosk_enabled(s.id) then raise exception 'the kiosk is switched off' using errcode = '0A000'; end if;
    v_ch := 'takeaway';
  elsif not public.qr_ordering_enabled(s.id) then raise exception 'ordering from the table is switched off' using errcode = '0A000'; end if;$a$);
      dst := replace(dst, 'if v_count >= 12 then', $a$if v_count >= (case when t.kind = 'kiosk' then 60 else 12 end) then$a$);
      dst := replace(dst, $a$   where ord.table_id = t.id and ord.status not in ('paid', 'void') order by ord.created_at limit 1 for update;$a$,
        $a$   where t.kind <> 'kiosk' and ord.table_id = t.id and ord.status not in ('paid', 'void') order by ord.created_at limit 1 for update;$a$);
      dst := replace(dst, $a$     where store_id = s.id and business_date = v_date and number ~ '^QR[0-9]+$';
    v_number := 'QR' || lpad(v_next::text, 3, '0');
    insert into public.orders (org_id, store_id, number, business_date, channel, table_id)
    values (s.org_id, s.id, v_number, v_date, 'dine-in', t.id) returning id into v_order;$a$,
        $a$     where store_id = s.id and business_date = v_date and number ~ (case when t.kind = 'kiosk' then '^KS[0-9]+$' else '^QR[0-9]+$' end);
    v_number := case when t.kind = 'kiosk' then 'KS' else 'QR' end || lpad(v_next::text, 3, '0');
    insert into public.orders (org_id, store_id, number, business_date, channel, table_id)
    values (s.org_id, s.id, v_number, v_date, v_ch, case when t.kind = 'kiosk' then null else t.id end) returning id into v_order;$a$);
      dst := replace(dst, $a$(v_item.prices ->> 'dine-in')$a$, $a$(v_item.prices ->> v_ch)$a$);
      dst := replace(dst, $a$(o.channel_delta ->> 'dine-in')$a$, $a$(o.channel_delta ->> v_ch)$a$);
      dst := replace(dst, 's.qr_auto_send', '(s.qr_auto_send and t.kind <> ''kiosk'')');
    end if;
    if dst = src then raise exception 'migration 78: % not changed', r.proname; end if;
    if r.proname = 'guest_place_order' and (position('v_ch     text' in dst) = 0 or position('KS' in dst) = 0 or position('kiosk_enabled' in dst) = 0
         or position('->> v_ch' in dst) = 0 or position('(case when t.kind = ''kiosk'' then 60' in dst) = 0 or position('t.kind <> ''kiosk'' and ord.table_id' in dst) = 0) then
      raise exception 'migration 78: guest_place_order not changed as expected';
    end if;
    if r.proname = 'guest_menu' and position('(select ch from t)' in dst) = 0 then raise exception 'migration 78: guest_menu not changed as expected'; end if;
    execute dst;
  end loop;
end $$;
