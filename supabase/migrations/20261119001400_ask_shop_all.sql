-- Bestie POS · migration 39 · "Ask my shop" for ALL the shops of a business together.
-- Allowed only when the person has `report.view` and EVERY shop they can open has the `ai.assistant` module on (Pro plan and up):
-- the module is a plan feature, so a shop without it never leaks into an "all shops" answer. Returns the org and the shop ids, else null.
create or replace function public.ask_shop_context_all(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('org_id', p_org, 'store_ids', jsonb_agg(s.id order by s.created_at), 'count', count(*))
    from public.stores s
   where s.org_id = p_org and s.deleted_at is null and public.can_access_store(s.org_id, s.id)
  having count(*) > 0
     and public.has_permission(p_org, 'report.view')
     and bool_and(public.ask_shop_enabled(s.id))
$$;
revoke all on function public.ask_shop_context_all(uuid) from public, anon;
grant execute on function public.ask_shop_context_all(uuid) to authenticated, service_role;
