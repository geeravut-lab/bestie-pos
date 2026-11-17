-- Bestie POS · migration 2 · Aivora (LINE) SSO account links.
--
-- docs/SSO-Aivora-Supabase.md step 3: link an Aivora hub user to a Supabase user by the hub's user id,
-- NEVER by e-mail (a hub e-mail may be unverified; matching on it would hand an existing account to someone else).
-- Only the server (service_role, inside /api/sso-exchange) reads or writes this table.
create table public.aivora_links (
  aivora_user_id text primary key check (length(aivora_user_id) between 1 and 200),
  user_id        uuid not null unique references auth.users (id) on delete cascade,
  created_at     timestamptz not null default now()
);

alter table public.aivora_links enable row level security;
-- deliberately NO policy and no grants: invisible to anon / authenticated.
revoke all on public.aivora_links from anon, authenticated;
