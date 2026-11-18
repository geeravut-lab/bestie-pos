-- Minimal Supabase look-alike so migrations can be tested on a plain Postgres (see run-local.sh).
-- NOT applied to the real project.
-- roles are cluster-wide: create once, reuse for every test database
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
grant usage on schema auth to anon, authenticated, service_role;

-- Realtime look-alike: messages table (RLS target), topic() and send() that records what would be broadcast.
create schema if not exists realtime;
create table realtime.messages (id bigserial primary key, topic text, extension text default 'broadcast');
create table realtime.sent (id bigserial primary key, topic text, event text, payload jsonb, is_private boolean);
create function realtime.topic() returns text language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;
create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as
  $$ insert into realtime.sent (topic, event, payload, is_private) values (topic, event, payload, private) $$;
alter table realtime.messages enable row level security;
grant usage on schema realtime to anon, authenticated, service_role;
grant select on realtime.messages to authenticated;
grant all on realtime.sent to authenticated, service_role;
grant all on realtime.messages to service_role;
grant usage on all sequences in schema realtime to service_role, authenticated;

-- Storage look-alike (buckets + objects with RLS).
create schema if not exists storage;
create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id bigserial primary key, bucket_id text references storage.buckets (id), name text);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, delete on storage.objects to authenticated;
grant all on storage.objects, storage.buckets to service_role;
grant usage on all sequences in schema storage to authenticated, service_role;
