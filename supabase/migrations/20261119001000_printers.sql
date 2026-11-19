-- Bestie POS · migration 39 · receipt printers are DATA: the shop's own list + the shop default (docs/DECISIONS.md "Printing").
--  * `stores.printers`: up to 10 entries { id, name, kind usb|serial|bluetooth|network, paper 58|80, cutter, drawer, bridge_url?, baud?, service? }.
--    The two built-ins (`pdf`, `browser`) are not stored: they always exist, so a shop with no printer set up prints a PDF.
--  * `stores.default_printer`: the id the tablets of the shop use unless a tablet chose its own (kept on the tablet).
--  * The database guards the SHAPE; pairing a USB / serial / Bluetooth printer is a per-browser permission and never stored.
create or replace function public.printers_ok(p jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  e jsonb;
  ids text[] := '{}';
begin
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 10 then return false; end if;
  for e in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(e) <> 'object' then return false; end if;
    if (e - 'id' - 'name' - 'kind' - 'paper' - 'cutter' - 'drawer' - 'bridge_url' - 'baud' - 'service') <> '{}'::jsonb then return false; end if;
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
    if e ? 'service' and coalesce(e ->> 'service', '') !~* '^[0-9a-f]{4,8}(-[0-9a-f]{4}){0,4}$' then return false; end if;
  end loop;
  return true;
end $$;
grant execute on function public.printers_ok(jsonb) to authenticated, service_role;

alter table public.stores
  add column printers jsonb not null default '[]'::jsonb check (public.printers_ok(printers)),
  add column default_printer text check (default_printer is null or default_printer ~ '^[a-z0-9][a-z0-9-]{0,39}$');
