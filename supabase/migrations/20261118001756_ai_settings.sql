-- Bestie POS · migration 6 · AI assistant settings (docs/AI-PROVIDER-MODEL-KNOWLEDGE.md, AI-PROMPTS-RULES-KNOWLEDGE.md).
--
-- Platform admin chooses provider + model per task (and optional fallback) and may ADD instructions per task.
--  * ai_settings:        one row, only what differs from the code defaults;
--  * ai_prompt_versions: insert-only history of the admin's additions (current = latest row per task, empty body = none);
--  * ai_events:          fallbacks and errors only (successes are not logged), written by the server (service_role).
-- API keys never live here: they are server environment variables.

create table public.ai_settings (
  id              boolean primary key default true check (id),
  route_overrides jsonb not null default '{}'::jsonb check (jsonb_typeof(route_overrides) = 'object'),
  model_overrides jsonb not null default '{}'::jsonb check (jsonb_typeof(model_overrides) = 'object'),
  updated_by      uuid references auth.users (id) on delete set null,
  updated_at      timestamptz not null default now()
);
insert into public.ai_settings (id) values (true) on conflict do nothing;
create trigger ai_settings_touch before update on public.ai_settings
  for each row execute function public.touch_updated_at();

create table public.ai_prompt_versions (
  id          bigint generated always as identity primary key,
  task        text not null check (task ~ '^[a-z_]{1,40}$'),
  body        text not null default '' check (length(body) <= 1000),
  review      jsonb not null default '{}'::jsonb check (jsonb_typeof(review) = 'object'),
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index ai_prompt_versions_task_idx on public.ai_prompt_versions (task, id desc);

create table public.ai_events (
  id         bigint generated always as identity primary key,
  provider   text not null,
  task       text not null,
  status     text not null check (status in ('fallback', 'error')),
  error_code text check (error_code is null or length(error_code) <= 64),
  message    text check (message is null or length(message) <= 300),
  created_at timestamptz not null default now()
);
create index ai_events_created_idx on public.ai_events (created_at desc);

-- insert-only history
create or replace function public.ai_prompt_versions_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'ai_prompt_versions is insert-only' using errcode = '42501';
end $$;
create trigger ai_prompt_versions_no_change before update or delete on public.ai_prompt_versions
  for each row execute function public.ai_prompt_versions_immutable();

alter table public.ai_settings        enable row level security;
alter table public.ai_prompt_versions enable row level security;
alter table public.ai_events          enable row level security;

-- Platform admins manage settings and prompts straight from the admin screen; everything else is server-only.
create policy ai_settings_admin_read on public.ai_settings for select to authenticated using (public.is_platform_admin());
create policy ai_settings_admin_update on public.ai_settings for update to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());
create policy ai_prompts_admin_read on public.ai_prompt_versions for select to authenticated using (public.is_platform_admin());
create policy ai_prompts_admin_insert on public.ai_prompt_versions for insert to authenticated
  with check (public.is_platform_admin() and created_by = auth.uid());
create policy ai_events_admin_read on public.ai_events for select to authenticated using (public.is_platform_admin());

revoke all on public.ai_settings, public.ai_prompt_versions, public.ai_events from anon, authenticated;
grant select, update on public.ai_settings to authenticated;
grant select, insert on public.ai_prompt_versions to authenticated;
grant select on public.ai_events to authenticated;
