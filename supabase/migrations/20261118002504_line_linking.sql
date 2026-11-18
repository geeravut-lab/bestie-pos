-- Bestie POS · migration 7 · LINE account linking (docs/LINE-ACCOUNT-LINKING-KNOWLEDGE.md).
--
-- A signed-in user asks the server for a one-time code, sends it to the LINE Official Account, and the LINE webhook binds
-- their LINE userId to their account. Only the SERVER touches these tables (service_role): the browser gets a masked
-- status through /api/line/link, never the LINE userId and never a code hash.

create table public.notification_channels (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  channel         text not null check (channel in ('line')),
  address         text,                         -- LINE userId; null while pending
  status          text not null default 'pending' check (status in ('pending', 'active', 'stopped')),
  code_hash       text,                         -- HMAC of the code; the code itself is never stored
  code_expires_at timestamptz,
  attempts        integer not null default 0 check (attempts >= 0),
  last_error      text check (last_error is null or length(last_error) <= 200),
  created_at      timestamptz not null default now(),
  verified_at     timestamptz,
  unique (owner_id, channel)                    -- one row per user per channel: starting again overwrites it
);
create index notification_channels_line_address_idx on public.notification_channels (address) where channel = 'line';
create unique index notification_channels_line_active_address_uidx on public.notification_channels (address)
  where channel = 'line' and status = 'active';  -- one LINE account can be linked to ONE Bestie account

create table public.message_log (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  owner_id uuid references auth.users (id) on delete cascade,
  channel  text not null,
  kind     text,
  status   text not null check (status in ('sent', 'failed')),
  error    text check (error is null or length(error) <= 200)
);
create index message_log_channel_at_idx on public.message_log (channel, at desc);

alter table public.notification_channels enable row level security;   -- no policy: invisible to the browser
alter table public.message_log           enable row level security;
create policy message_log_admin_read on public.message_log for select to authenticated using (public.is_platform_admin());
revoke all on public.notification_channels, public.message_log from anon, authenticated;
grant select on public.message_log to authenticated;
