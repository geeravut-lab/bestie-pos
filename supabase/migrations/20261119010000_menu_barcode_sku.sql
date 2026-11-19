-- Bestie POS · migration 55 · BARCODE and SKU on menu items and on options (variants) — the base of the Retail profile.
--
--  * A menu item may carry a `barcode` (what the scanner reads) and a `sku` (the shop's own stock code). An OPTION may carry them
--    too: a variant such as size or colour is an option of a required choice group, so it keeps its own price change, its own
--    stock use (migration 48) and now its own barcode. Scanning an option's code adds the item with that option chosen.
--  * A barcode is letters / digits / dashes, 4–40 characters (like the stock barcode), and is used ONCE per shop across items and
--    options (ignoring letter case, ignoring deleted rows): the scanner must never be able to mean two things. A SKU is free text
--    of the same shape but may repeat (it is a label, not a key).
--  * Nothing else changes: prices, the order, the receipt and the stock deduction all work as before; the till finds the code in
--    its cached menu, so scanning works offline.

alter table public.menu_items add column sku text check (sku is null or sku ~ '^[0-9A-Za-z-]{1,40}$');
alter table public.menu_items add column barcode text check (barcode is null or barcode ~ '^[0-9A-Za-z-]{4,40}$');
alter table public.modifier_options add column sku text check (sku is null or sku ~ '^[0-9A-Za-z-]{1,40}$');
alter table public.modifier_options add column barcode text check (barcode is null or barcode ~ '^[0-9A-Za-z-]{4,40}$');
create index menu_items_barcode_idx on public.menu_items (store_id, lower(barcode)) where barcode is not null and deleted_at is null;
create index modifier_options_barcode_idx on public.modifier_options (store_id, lower(barcode)) where barcode is not null and deleted_at is null;

create or replace function public.menu_code_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.barcode is null or new.deleted_at is not null then return new; end if;
  if exists (select 1 from public.menu_items i
              where i.store_id = new.store_id and lower(i.barcode) = lower(new.barcode) and i.deleted_at is null
                and not (tg_table_name = 'menu_items' and i.id = new.id))
     or exists (select 1 from public.modifier_options o
              where o.store_id = new.store_id and lower(o.barcode) = lower(new.barcode) and o.deleted_at is null
                and not (tg_table_name = 'modifier_options' and o.id = new.id)) then
    raise exception 'this barcode is already used in this shop' using errcode = '23505';
  end if;
  return new;
end $$;
revoke all on function public.menu_code_guard() from public, anon, authenticated;
create trigger menu_items_code_guard before insert or update of barcode, deleted_at on public.menu_items
  for each row execute function public.menu_code_guard();
create trigger modifier_options_code_guard before insert or update of barcode, deleted_at on public.modifier_options
  for each row execute function public.menu_code_guard();
