-- Bestie POS · migration 72 · assistant extras for staff: (a) the figures behind "Explain this shift", (b) the module `ai.translate` (live translation for staff).
--
-- (a) `shift_figures(shift)` hands the owner / manager the numbers of ONE closed shift — the same numbers the shift page shows — so that a model can EXPLAIN them and code can check
--     every number in its answer (the "Ask my shop" pattern). It needs `report.view` and the module `ai.assistant` (Pro) in that shop; it never reads outside the shift's window
--     and device, and returns no customer data.
-- (b) `ai.translate` (off by default, Pro): staff type a sentence and get it in another language (a guest's note, a message across a language gap). `translate_context(shop)` tells the
--     server whether this person may use it (order.create in that shop + module on). The text is not stored; only token counts are logged per business like every AI task.

do $$
declare r record; src text; dst text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'stores_check_modules' loop
    src := pg_get_functiondef(r.oid);
    dst := replace(src, $a$'ai.hair'];$a$, $a$'ai.hair','ai.translate'];$a$);
    if dst = src then raise exception 'migration 72: stores_check_modules not changed'; end if;
    execute dst;
  end loop;
end $$;

create or replace function public.translate_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stores s
                  where s.id = p_store and s.deleted_at is null and s.plan in ('pro', 'resort')
                    and coalesce((s.module_overrides ->> 'ai.translate')::boolean, false))
$$;
revoke all on function public.translate_enabled(uuid) from public, anon;
grant execute on function public.translate_enabled(uuid) to authenticated, service_role;

create or replace function public.translate_context(p_store uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('org_id', s.org_id, 'store_id', s.id)
    from public.stores s
   where s.id = p_store and s.deleted_at is null
     and public.can_access_store(s.org_id, s.id)
     and public.has_permission(s.org_id, 'order.create')
     and public.translate_enabled(s.id)
$$;
revoke all on function public.translate_context(uuid) from public, anon;
grant execute on function public.translate_context(uuid) to authenticated, service_role;

create or replace function public.shift_figures(p_shift uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  sh public.shifts%rowtype; st public.stores%rowtype; d public.devices%rowtype;
  v_bills integer; v_sales bigint; v_by jsonb;
begin
  select * into sh from public.shifts where id = p_shift;
  if not found then return null; end if;
  select * into st from public.stores where id = sh.store_id;
  if not (public.can_access_store(sh.org_id, sh.store_id) and public.has_permission(sh.org_id, 'report.view') and public.ask_shop_enabled(sh.store_id)) then
    return null;
  end if;
  if sh.status <> 'closed' then return null; end if;
  select * into d from public.devices where id = sh.device_id;
  select count(*), coalesce(sum(r.payable), 0) into v_bills, v_sales
    from public.receipts r where r.device_id = sh.device_id and r.issued_at >= sh.opened_at and r.issued_at <= sh.closed_at;
  select coalesce(jsonb_object_agg(x.tender, x.total), '{}'::jsonb) into v_by
    from (select p.tender, sum(p.amount) as total from public.payments p
           where p.device_id = sh.device_id and p.status = 'confirmed' and p.created_at >= sh.opened_at and p.created_at <= sh.closed_at
           group by p.tender) x;
  return jsonb_build_object(
    'store_id', st.id, 'shop', st.name, 'device', d.name,
    'opened_at', sh.opened_at, 'closed_at', sh.closed_at,
    'opening_cash', sh.opening_cash, 'expected_cash', sh.expected_cash, 'counted_cash', sh.counted_cash, 'variance', sh.variance,
    'bills', v_bills, 'sales', v_sales, 'by_tender', v_by);
end $$;
revoke all on function public.shift_figures(uuid) from public, anon;
grant execute on function public.shift_figures(uuid) to authenticated, service_role;
