-- Bestie POS · migration 13 · device lock screen: which people on this org have a PIN?
-- The PIN table itself stays invisible to the browser; this returns only the ids of active staff who have one.
create or replace function public.staff_with_pin(p_org uuid) returns setof uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_org_member(p_org) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  return query
    select s.id from public.staff s
    join public.staff_pins p on p.staff_id = s.id
    where s.org_id = p_org and s.active;
end $$;
revoke all on function public.staff_with_pin(uuid) from public, anon;
grant execute on function public.staff_with_pin(uuid) to authenticated, service_role;
