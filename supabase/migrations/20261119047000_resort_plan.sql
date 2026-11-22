-- Bestie POS · migration 92 · A RESORT SHOP GETS THE RESORT PLAN (owner order 22 Nov: find what is built but cannot be used).
-- Why: the modules `folio` (charge to room, check-in / out) and `pms` need the plan "resort", every new shop starts on "pro", and nothing in the app
-- changes a shop's plan, so an owner who chose the Resort profile could never switch the folio on. The registry says the folio is "on by default for the
-- resort profile", so a shop that is created with the resort profile now starts on the resort plan (plans are cumulative: resort includes pro and basic).
-- Prices of the plans are still an open question; this only removes a lock that nobody could open.
create or replace function public.stores_resort_plan() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.profile = 'resort' and new.plan = 'pro' then new.plan := 'resort'; end if;
  return new;
end $$;
drop trigger if exists stores_resort_plan on public.stores;
create trigger stores_resort_plan before insert on public.stores
  for each row execute function public.stores_resort_plan();

-- resort shops that already exist on the pro plan
update public.stores set plan = 'resort' where profile = 'resort' and plan = 'pro';
