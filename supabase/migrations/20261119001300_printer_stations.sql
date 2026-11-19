-- Bestie POS · migration 38 · a printer may be a KITCHEN / BAR ticket printer: `stations` = ["kitchen"] / ["bar"] / both.
-- When staff send an order, the tablet prints one ticket per station that has a printer; a station with no printer prints nothing
-- (the kitchen screen still shows it). Shape guard only: the same function with `stations` allowed (an array of at most the two stations).
create or replace function public.printers_ok(p jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  e jsonb;
  ids text[] := '{}';
begin
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 10 then return false; end if;
  for e in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(e) <> 'object' then return false; end if;
    if (e - 'id' - 'name' - 'kind' - 'paper' - 'cutter' - 'drawer' - 'bridge_url' - 'baud' - 'service' - 'stations') <> '{}'::jsonb then return false; end if;
    if coalesce(e ->> 'id', '') !~ '^[a-z0-9][a-z0-9-]{0,39}$' or (e ->> 'id') in ('pdf', 'browser') then return false; end if;
    if (e ->> 'id') = any (ids) then return false; end if;
    ids := ids || (e ->> 'id');
    if length(btrim(coalesce(e ->> 'name', ''))) not between 1 and 40 then return false; end if;
    if coalesce(e ->> 'kind', '') not in ('usb', 'serial', 'bluetooth', 'network') then return false; end if;
    if coalesce(e ->> 'paper', '') not in ('58', '80') then return false; end if;
    if e ? 'cutter' and jsonb_typeof(e -> 'cutter') <> 'boolean' then return false; end if;
    if e ? 'drawer' and jsonb_typeof(e -> 'drawer') <> 'boolean' then return false; end if;
    if (e ->> 'kind') = 'network' and coalesce(e ->> 'bridge_url', '') !~ '^https?://[^[:space:]]{1,190}$' then return false; end if;
    if e ? 'bridge_url' and coalesce(e ->> 'bridge_url', '') !~ '^https?://[^[:space:]]{1,190}$' then return false; end if;
    if e ? 'baud' and (jsonb_typeof(e -> 'baud') <> 'number' or (e ->> 'baud')::numeric not between 1200 and 921600) then return false; end if;
    if e ? 'stations' and (jsonb_typeof(e -> 'stations') <> 'array' or jsonb_array_length(e -> 'stations') > 2
         or exists (select 1 from jsonb_array_elements(e -> 'stations') s where s <> '"kitchen"'::jsonb and s <> '"bar"'::jsonb)) then return false; end if;
    if e ? 'service' and coalesce(e ->> 'service', '') !~* '^[0-9a-f]{4,8}(-[0-9a-f]{4}){0,4}$' then return false; end if;
  end loop;
  return true;
end $$;
grant execute on function public.printers_ok(jsonb) to authenticated, service_role;
