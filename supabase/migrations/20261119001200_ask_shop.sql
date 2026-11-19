-- Bestie POS · migration 37 · "Ask my shop": who may ask, and for which shop.
--
-- The assistant only EXPLAINS figures the server reads with `sales_report()` (code and SQL compute every number). This function is the
-- gate the server asks first, with the PERSON's own token: it answers with the shop's name and org only when
--   * the person may open the shop, and has `report.view`,
--   * the module `ai.assistant` is switched on for the shop (off for every profile, Pro plan and up),
-- otherwise null. Reading the figures afterwards goes through `sales_report()` with the same token, which checks the same rights again.

-- registry:ai.assistant profiles= plan=pro,resort
create or replace function public.ask_shop_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select (s.module_overrides ->> 'ai.assistant')::boolean from public.stores s where s.id = p_store and s.module_overrides ? 'ai.assistant'), false)
     and coalesce((select s.plan in ('pro', 'resort') from public.stores s where s.id = p_store), false)
$$;
revoke all on function public.ask_shop_enabled(uuid) from public, anon, authenticated;
grant execute on function public.ask_shop_enabled(uuid) to service_role;

create or replace function public.ask_shop_context(p_store uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('org_id', s.org_id, 'store_id', s.id, 'name', s.name)
    from public.stores s
   where s.id = p_store and s.deleted_at is null
     and public.can_access_store(s.org_id, s.id)
     and public.has_permission(s.org_id, 'report.view')
     and public.ask_shop_enabled(s.id)
$$;
revoke all on function public.ask_shop_context(uuid) from public, anon;
grant execute on function public.ask_shop_context(uuid) to authenticated, service_role;
