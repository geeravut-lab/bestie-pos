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
--  * The same mechanism carries two more guest pages, each of its own `kind`:
--      - `web` = ORDER FOOD ONLINE from the island page / LINE (module `kiosk`): like a kiosk (own takeaway bill, takeaway prices, unsent lines) but the guest must leave a name and a
--        phone number (kept on the bill's `delivery_info`), the bill is `WB001…`, at most 3 unpaid web orders per phone and 20 per page per 10 minutes, and the managers get a notice;
--        the shop pays / hands it over at pickup. The island marketplace lists an **Order food** button for a shop that has an active web page.
--      - `info` = a CONCIERGE page for a resort / tour / any shop (module `guest.concierge`, Basic): the shop's information cards, the "ask" box (when `ai.guest` is on),
--        call the staff and feedback — and no menu, no basket: ordering from it is refused.
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

alter table public.dining_tables add column kind text not null default 'table' check (kind in ('table', 'kiosk', 'web', 'info'));

-- registry:guest.concierge profiles= plan=basic,pro,resort depends=
create or replace function public.guest_concierge_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stores s
                  where s.id = p_store and s.deleted_at is null and coalesce((s.module_overrides ->> 'guest.concierge')::boolean, false))
$$;
revoke all on function public.guest_concierge_enabled(uuid) from public, anon;
grant execute on function public.guest_concierge_enabled(uuid) to authenticated, service_role;

do $$
declare r record; src text; dst text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'stores_check_modules' loop
    src := pg_get_functiondef(r.oid);
    dst := replace(src, $a$'karaoke.booking'];$a$, $a$'karaoke.booking','guest.concierge'];$a$);
    if dst = src then raise exception 'migration 78: stores_check_modules not changed'; end if;
    execute dst;
  end loop;
end $$;

-- is the guest page of this kind switched on in this shop?
create or replace function public.guest_kind_enabled(p_kind text, p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case p_kind when 'kiosk' then public.kiosk_enabled(p_store) when 'web' then public.kiosk_enabled(p_store)
                     when 'info' then public.guest_concierge_enabled(p_store) else public.qr_ordering_enabled(p_store) end
$$;
revoke all on function public.guest_kind_enabled(text, uuid) from public, anon;
grant execute on function public.guest_kind_enabled(text, uuid) to authenticated, service_role;

-- p = { store_id, id?, kind? ('kiosk' | 'web' | 'info', default kiosk, only when making one), name, active?, rotate? } → { id, token }   (menu.edit)
create or replace function public.save_kiosk(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; v_id uuid := nullif(p ->> 'id', '')::uuid; v_token text; v_kind text := coalesce(nullif(p ->> 'kind', ''), 'kiosk');
begin
  select * into s from public.stores where id = (p ->> 'store_id')::uuid and deleted_at is null;
  if not found or not public.can_edit_menu(s.id) then raise exception 'guest pages need menu.edit in this shop' using errcode = '42501'; end if;
  if v_id is not null then
    select t.kind into v_kind from public.dining_tables t where t.id = v_id and t.store_id = s.id and t.kind <> 'table' and t.deleted_at is null;
    if not found then raise exception 'unknown guest page' using errcode = '22023'; end if;
  elsif v_kind not in ('kiosk', 'web', 'info') then
    raise exception 'unknown kind of guest page' using errcode = '22023';
  end if;
  if not public.guest_kind_enabled(v_kind, s.id) then raise exception 'this guest page is switched off in this shop' using errcode = '0A000'; end if;
  if v_id is null then
    insert into public.dining_tables (org_id, store_id, name, zone, seats, kind, active)
    values (s.org_id, s.id, btrim(p ->> 'name'), v_kind, 1, v_kind, coalesce((p ->> 'active')::boolean, true)) returning id, qr_token into v_id, v_token;
  else
    update public.dining_tables
       set name = coalesce(btrim(p ->> 'name'), name), active = coalesce((p ->> 'active')::boolean, active),
           qr_token = case when coalesce((p ->> 'rotate')::boolean, false) then replace(gen_random_uuid()::text, '-', '') else qr_token end
     where id = v_id and store_id = s.id and kind = v_kind and deleted_at is null
     returning qr_token into v_token;
  end if;
  perform public.audit_record(s.org_id, s.id, 'settings.change', 'guest_pages', v_id::text, jsonb_build_object('kind', v_kind, 'active', p -> 'active', 'rotated', coalesce((p ->> 'rotate')::boolean, false)), 'db');
  return jsonb_build_object('id', v_id, 'token', v_token);
end $$;
revoke all on function public.save_kiosk(jsonb) from public, anon;
grant execute on function public.save_kiosk(jsonb) to authenticated, service_role;

-- ── the guest functions learn about kiosks, online ordering and concierge pages (re-created from their own definitions; the migration fails if a text did not change) ──
do $$
declare r record; src text; dst text;
begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('guest_table', 'guest_menu', 'guest_place_order', 'guest_island') loop
    src := pg_get_functiondef(r.oid);
    dst := src;
    if r.proname = 'guest_table' then
      dst := replace(dst, $a$'qr_enabled', public.qr_ordering_enabled(s.id)$a$,
        $a$'qr_enabled', public.guest_kind_enabled(t.kind, s.id), 'kiosk', t.kind in ('kiosk', 'web'), 'kind', t.kind$a$);
    elsif r.proname = 'guest_menu' then
      dst := replace(dst, 'with t as (select t.store_id from public.dining_tables t',
        $a$with t as (select t.store_id, case when t.kind in ('kiosk', 'web') then 'takeaway' else 'dine-in' end as ch from public.dining_tables t$a$);
      dst := replace(dst, $a$(i.prices ->> 'dine-in')$a$, $a$(i.prices ->> (select ch from t))$a$);
      dst := replace(dst, $a$(o.channel_delta ->> 'dine-in')$a$, $a$(o.channel_delta ->> (select ch from t))$a$);
    elsif r.proname = 'guest_island' then
      dst := replace(dst, $a$'booking_token', case when public.booking_online_enabled(l.store_id) then s.booking_token end)$a$,
        $a$'booking_token', case when public.booking_online_enabled(l.store_id) then s.booking_token end,
              'order_token', (select t.qr_token from public.dining_tables t
                               where t.store_id = l.store_id and t.kind = 'web' and t.active and t.deleted_at is null and public.kiosk_enabled(l.store_id)
                               order by t.created_at limit 1))$a$);
    else
      dst := replace(dst, E'  v_now    timestamptz := now();\nbegin', E'  v_now    timestamptz := now();\n  v_ch     text := ''dine-in'';\n  v_k      boolean := false;\n  v_cname  text;\n  v_cphone text;\nbegin');
      dst := replace(dst, $a$  if not public.qr_ordering_enabled(s.id) then raise exception 'ordering from the table is switched off' using errcode = '0A000'; end if;$a$,
        $a$  if t.kind = 'info' then raise exception 'ordering is not possible from this page' using errcode = '0A000'; end if;
  if not public.guest_kind_enabled(t.kind, s.id) then raise exception 'ordering from here is switched off' using errcode = '0A000'; end if;
  if t.kind in ('kiosk', 'web') then v_k := true; v_ch := 'takeaway'; end if;
  if t.kind = 'web' then
    v_cname := left(btrim(coalesce(p -> 'contact' ->> 'name', '')), 80);
    v_cphone := left(btrim(coalesce(p -> 'contact' ->> 'phone', '')), 30);
    if length(v_cname) < 1 or length(regexp_replace(v_cphone, '[^0-9]', '', 'g')) < 6 then raise exception 'a name and a phone number are needed' using errcode = '22023'; end if;
    if (select count(*) from public.orders o3 where o3.store_id = s.id and o3.status = 'open' and o3.number like 'WB%'
          and regexp_replace(coalesce(o3.delivery_info ->> 'phone', ''), '[^0-9]', '', 'g') = regexp_replace(v_cphone, '[^0-9]', '', 'g')) >= 3 then
      raise exception 'too many unpaid orders for this phone, please call the shop' using errcode = '54000';
    end if;
  end if;$a$);
      dst := replace(dst, 'if v_count >= 12 then', $a$if v_count >= (case when t.kind = 'kiosk' then 60 when t.kind = 'web' then 20 else 12 end) then$a$);
      dst := replace(dst, $a$   where ord.table_id = t.id and ord.status not in ('paid', 'void') order by ord.created_at limit 1 for update;$a$,
        $a$   where not v_k and ord.table_id = t.id and ord.status not in ('paid', 'void') order by ord.created_at limit 1 for update;$a$);
      dst := replace(dst, $a$     where store_id = s.id and business_date = v_date and number ~ '^QR[0-9]+$';
    v_number := 'QR' || lpad(v_next::text, 3, '0');
    insert into public.orders (org_id, store_id, number, business_date, channel, table_id)
    values (s.org_id, s.id, v_number, v_date, 'dine-in', t.id) returning id into v_order;$a$,
        $a$     where store_id = s.id and business_date = v_date and number ~ ('^' || (case t.kind when 'kiosk' then 'KS' when 'web' then 'WB' else 'QR' end) || '[0-9]+$');
    v_number := (case t.kind when 'kiosk' then 'KS' when 'web' then 'WB' else 'QR' end) || lpad(v_next::text, 3, '0');
    insert into public.orders (org_id, store_id, number, business_date, channel, table_id, delivery_info)
    values (s.org_id, s.id, v_number, v_date, v_ch, case when v_k then null else t.id end,
            case when t.kind = 'web' then jsonb_build_object('name', v_cname, 'phone', v_cphone) end) returning id into v_order;$a$);
      dst := replace(dst, $a$(v_item.prices ->> 'dine-in')$a$, $a$(v_item.prices ->> v_ch)$a$);
      dst := replace(dst, $a$(o.channel_delta ->> 'dine-in')$a$, $a$(o.channel_delta ->> v_ch)$a$);
      dst := replace(dst, 's.qr_auto_send', '(s.qr_auto_send and not v_k)');
      dst := replace(dst, $a$  if v_status = 'sent' then perform public.enqueue_print_jobs(v_order, v_now); end if;$a$,
        $a$  if v_status = 'sent' then perform public.enqueue_print_jobs(v_order, v_now); end if;
  if t.kind = 'web' then perform public.notify_web_order(v_order); end if;$a$);
    end if;
    if dst = src then raise exception 'migration 78: % not changed', r.proname; end if;
    if r.proname = 'guest_place_order' and (position('v_k      boolean' in dst) = 0 or position('''WB''' in dst) = 0 or position('guest_kind_enabled' in dst) = 0
         or position('->> v_ch' in dst) = 0 or position('when t.kind = ''kiosk'' then 60' in dst) = 0 or position('not v_k and ord.table_id' in dst) = 0
         or position('notify_web_order' in dst) = 0 or position('delivery_info' in dst) = 0) then
      raise exception 'migration 78: guest_place_order not changed as expected';
    end if;
    if r.proname = 'guest_menu' and position('(select ch from t)' in dst) = 0 then raise exception 'migration 78: guest_menu not changed as expected'; end if;
    if r.proname = 'guest_table' and position('guest_kind_enabled' in dst) = 0 then raise exception 'migration 78: guest_table not changed as expected'; end if;
    if r.proname = 'guest_island' and position('order_token' in dst) = 0 then raise exception 'migration 78: guest_island not changed as expected'; end if;
    execute dst;
  end loop;
end $$;

-- the managers hear about an online food order (the bill waits unsent until the shop confirms it)
create or replace function public.notify_web_order(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.orders%rowtype; v_n jsonb;
begin
  select * into o from public.orders where id = p_order;
  if not found then return; end if;
  v_n := jsonb_build_object('kind', 'web.order', 'href', '/order/' || o.id, 'dedupe', 'web-order:' || o.id,
    'title', jsonb_build_object('th', 'ออเดอร์ออนไลน์ใหม่ ' || o.number, 'en', 'New online food order ' || o.number),
    'body', jsonb_build_object('th', 'ลูกค้า: ' || coalesce(o.delivery_info ->> 'name', '-') || E'\nโทร: ' || coalesce(o.delivery_info ->> 'phone', '-'),
                               'en', 'Customer: ' || coalesce(o.delivery_info ->> 'name', '-') || E'\nPhone: ' || coalesce(o.delivery_info ->> 'phone', '-')));
  perform public.notify_managers(o.org_id, o.store_id, v_n);
exception when others then
  raise warning 'notify_web_order failed: %', sqlerrm;
end $$;
revoke all on function public.notify_web_order(uuid) from public, anon, authenticated;
