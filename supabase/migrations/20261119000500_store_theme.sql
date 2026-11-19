-- Bestie POS · migration 34 · per-shop colours: the owner chooses up to five (primary, brand, accent, sun, mint).
-- The database only guards the SHAPE (known keys, #rrggbb); the contrast rules (WCAG AA) are checked by the screen and by
-- packages/core/src/storeTheme.ts before saving. A bad theme can only hurt the shop that chose it, and "Use the default
-- colours" (an empty object) is always one click away.
create or replace function public.store_theme_ok(t jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(t) = 'object'
     and (t - 'primary' - 'brand' - 'accent' - 'sun' - 'mint') = '{}'::jsonb
     and not exists (select 1 from jsonb_each(t) e where jsonb_typeof(e.value) <> 'string' or (e.value #>> '{}') !~ '^#[0-9a-fA-F]{6}$')
$$;
revoke all on function public.store_theme_ok(jsonb) from public, anon;
grant execute on function public.store_theme_ok(jsonb) to authenticated, service_role;
alter table public.stores add column theme jsonb not null default '{}'::jsonb check (public.store_theme_ok(theme));
