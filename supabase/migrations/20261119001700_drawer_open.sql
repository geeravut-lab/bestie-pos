-- Bestie POS · migration 42 · opening the cash drawer WITHOUT a sale ("no sale") is an audited, critical event.
-- The tablet sends the open command to the receipt printer's drawer port by itself (works offline); this function records who did it
-- and when. A tablet that was offline keeps the timestamps and reports them with the next open, so the record is complete but never
-- blocks the cashier. Needs `payment.take` in a shop the person can open and a device of that shop.
insert into public.audit_event_types (id, grp, critical) values ('drawer.open', 'shift', true) on conflict (id) do nothing;

create or replace function public.record_drawer_open(p_device uuid, p_times timestamptz[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  d public.devices%rowtype;
  t timestamptz;
  n integer := 0;
begin
  select * into d from public.devices where id = p_device and active;
  if not found or not (public.can_access_store(d.org_id, d.store_id) and public.has_permission(d.org_id, 'payment.take')) then
    raise exception 'opening the drawer needs payment.take in this shop' using errcode = '42501';
  end if;
  foreach t in array coalesce(p_times, '{}') loop
    exit when n >= 20;
    if t > now() + interval '5 minutes' or t < now() - interval '2 days' then continue; end if;   -- only recent, honest timestamps
    perform public.audit_record(d.org_id, d.store_id, 'drawer.open', 'devices', d.id::text,
      jsonb_build_object('device', d.name, 'at', t), 'db');
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.record_drawer_open(uuid, timestamptz[]) from public, anon;
grant execute on function public.record_drawer_open(uuid, timestamptz[]) to authenticated, service_role;
