-- Bestie POS · migration 37 · AI usage log: tokens per call, per organisation, per task — so each business owner can see what AI costs.
--  * NO content is ever stored (no prompt, no answer, no guest text): only org / shop, task, provider, model and token counts.
--  * Written by the server only (`log_ai_usage`, service role). Read: the owner / anyone with `report.view` for their own org,
--    the platform admin for every org.
--  * Money is NOT stored: the estimate is computed on read from the model prices (data: `ai_settings.prices` over the code defaults)
--    and the USD→THB rate (`ai_settings.usd_thb`), so a corrected price fixes the past figures too.
alter table public.ai_settings
  add column prices  jsonb not null default '{}'::jsonb check (jsonb_typeof(prices) = 'object'),
  add column usd_thb numeric(8, 3) not null default 36 check (usd_thb between 1 and 1000);

create table public.ai_usage_log (
  id            bigint generated always as identity primary key,
  org_id        uuid references public.orgs (id) on delete cascade,
  store_id      uuid references public.stores (id) on delete set null,
  task          text not null check (task ~ '^[a-z_]{1,40}$'),
  provider      text not null check (length(provider) <= 40),
  model         text not null check (length(model) <= 100),
  input_tokens  integer not null check (input_tokens between 0 and 10000000),
  output_tokens integer not null check (output_tokens between 0 and 10000000),
  source        text not null default 'staff' check (source in ('guest', 'staff')),
  created_at    timestamptz not null default now()
);
create index ai_usage_log_org_idx on public.ai_usage_log (org_id, created_at desc);
alter table public.ai_usage_log enable row level security;
create policy ai_usage_log_read on public.ai_usage_log for select to authenticated
  using (public.is_platform_admin() or (org_id is not null and public.has_permission(org_id, 'report.view')));
revoke all on public.ai_usage_log from anon, authenticated;
grant select on public.ai_usage_log to authenticated;

-- the server writes one row per AI call; a shop id gives the org. Never raises: usage logging must not break an answer.
create or replace function public.log_ai_usage(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_store uuid := nullif(p ->> 'store_id', '')::uuid;
  v_org   uuid;
begin
  select s.org_id into v_org from public.stores s where s.id = v_store;
  insert into public.ai_usage_log (org_id, store_id, task, provider, model, input_tokens, output_tokens, source)
  values (v_org, case when v_org is null then null else v_store end, p ->> 'task', p ->> 'provider', p ->> 'model',
          greatest(coalesce((p ->> 'input_tokens')::integer, 0), 0), greatest(coalesce((p ->> 'output_tokens')::integer, 0), 0),
          coalesce(p ->> 'source', 'staff'));
exception when others then
  raise warning 'log_ai_usage failed: %', sqlerrm;
end $$;
revoke all on function public.log_ai_usage(jsonb) from public, anon, authenticated;
grant execute on function public.log_ai_usage(jsonb) to service_role;

-- usage of one org (or, for the platform admin with a null org, of everybody) between two Bangkok dates, grouped for the screen
create or replace function public.ai_usage_summary(p_org uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_admin boolean := public.is_platform_admin();
begin
  if p_org is null and not v_admin then
    raise exception 'platform admin only' using errcode = '42501';
  end if;
  if p_org is not null and not (v_admin or public.has_permission(p_org, 'report.view')) then
    raise exception 'AI usage needs report.view' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'invalid range' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'usd_thb', (select usd_thb from public.ai_settings where id),
    'prices', (select prices from public.ai_settings where id),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('org_id', g.org_id, 'org_name', g.org_name, 'task', g.task, 'model', g.model, 'source', g.source,
                                         'calls', g.calls, 'input_tokens', g.i, 'output_tokens', g.o) order by g.org_name nulls last, g.task, g.model)
        from (select l.org_id, o.name as org_name, l.task, l.model, l.source, count(*) as calls, sum(l.input_tokens) as i, sum(l.output_tokens) as o
                from public.ai_usage_log l left join public.orgs o on o.id = l.org_id
               where (p_org is null or l.org_id = p_org)
                 and (l.created_at at time zone 'Asia/Bangkok')::date between p_from and p_to
               group by l.org_id, o.name, l.task, l.model, l.source) g), '[]'::jsonb));
end $$;
revoke all on function public.ai_usage_summary(uuid, date, date) from public, anon;
grant execute on function public.ai_usage_summary(uuid, date, date) to authenticated, service_role;
