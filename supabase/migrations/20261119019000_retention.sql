-- Bestie POS · migration 64 · data retention that matches the consent wording (docs/LEGAL-DRAFTS.md §3).
--  * health forms (sensitive data) are erased 24 months after they were signed;
--  * a Tourist Pass that nobody used for 36 months is erased (name and phone); each shop's own member record stays under that shop's rules.
-- Both are called by the hourly tidy of /api/notify/tick (service role only). Deletion writes nothing about the content.

create or replace function public.health_intakes_cleanup() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.health_intakes where signed_at < now() - interval '24 months';
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.network_passes_cleanup() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.network_passes p
   where p.created_at < now() - interval '36 months'
     and not exists (
       select 1 from public.points_ledger l
        where l.created_at >= now() - interval '36 months'
          and l.customer_id in (select k.customer_id from public.network_pass_links k where k.pass_id = p.id));
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.health_intakes_cleanup(), public.network_passes_cleanup() from public, anon, authenticated;
grant execute on function public.health_intakes_cleanup(), public.network_passes_cleanup() to service_role;
