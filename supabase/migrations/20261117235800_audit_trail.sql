-- Bestie POS · migration 3 · audit trail (docs/AUDIT-TRAIL-KNOWLEDGE.md + admin switches).
--
--  * ONE append-only table; nobody (not even service_role through normal paths) can UPDATE / DELETE / TRUNCATE rows.
--  * Two writers: the app (RPC write_audit, after the action succeeded) and DB triggers on sensitive tables (source = 'db').
--  * The org admin can switch auditing off and untick event types — EXCEPT `critical` events (money, roles, legal
--    sign-off, module toggles, the audit settings themselves, audit exports): those are always recorded.
--  * `detail` holds ids / codes / numbers only; PII-looking keys are stripped on the way in.
--  * No foreign keys to people or stores: the history must survive their deletion.

create table public.audit_event_types (
  id       text primary key,
  grp      text not null,
  critical boolean not null default false
);

insert into public.audit_event_types (id, grp, critical) values
  ('auth.login',               'auth',     false),
  ('auth.login_failed',        'auth',     false),
  ('auth.password_change',     'auth',     true),
  ('auth.pin_lockout',         'auth',     false),
  ('staff.add',                'staff',    false),
  ('staff.role_change',        'staff',    true),
  ('staff.deactivate',         'staff',    true),
  ('menu.item_change',         'menu',     false),
  ('menu.price_change',        'menu',     false),
  ('order.void',               'order',    true),
  ('order.discount',           'order',    false),
  ('order.price_override',     'order',    false),
  ('order.reopen',             'order',    false),
  ('payment.refund',           'payment',  true),
  ('payment.tender',           'payment',  false),
  ('payment.split',            'payment',  false),
  ('credit.topup',             'credit',   true),
  ('credit.spend',             'credit',   true),
  ('credit.adjust',            'credit',   true),
  ('points.redeem',            'points',   false),
  ('points.adjust',            'points',   true),
  ('shift.open',               'shift',    false),
  ('shift.close',              'shift',    false),
  ('shift.cash_variance',      'shift',    false),
  ('device.register',          'device',   false),
  ('device.pos_id_change',     'device',   true),
  ('module.toggle',            'settings', true),
  ('org.legal_signoff_change', 'settings', true),
  ('settings.change',          'settings', false),
  ('brand.change',             'settings', false),
  ('ai.settings_change',       'settings', false),
  ('ai.prompt_change',         'settings', false),
  ('audit.settings_change',    'settings', true),
  ('export.audit',             'export',   true),
  ('export.report',            'export',   false);

create table public.audit_settings (
  org_id          uuid primary key references public.orgs (id) on delete cascade,
  enabled         boolean not null default true,
  -- only the event types that are switched OFF (a new event type therefore defaults to "recorded")
  disabled_events text[] not null default '{}',
  updated_by      uuid,
  updated_at      timestamptz not null default now()
);

create table public.audit_log (
  id         bigint generated always as identity primary key,
  org_id     uuid not null,
  store_id   uuid,
  actor_id   uuid,
  actor_role text,
  action     text not null,
  entity     text,
  entity_id  text,
  detail     jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  source     text not null default 'app' check (source in ('app', 'db')),
  created_at timestamptz not null default now()
);
create index audit_log_org_time_idx on public.audit_log (org_id, created_at desc);
create index audit_log_org_action_idx on public.audit_log (org_id, action);

-- ── append-only ────────────────────────────────────────────────────────────
create or replace function public.audit_block_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_log is append-only' using errcode = '42501';
end $$;
create trigger audit_log_no_update_delete before update or delete on public.audit_log
  for each row execute function public.audit_block_mutation();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function public.audit_block_mutation();

-- ── detail hygiene: ids, codes, numbers, booleans only ─────────────────────
create or replace function public.audit_clean_detail(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(
    (select jsonb_object_agg(e.key, e.value)
       from jsonb_each(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) e
      where e.key !~* '(name|e-?mail|phone|tel|address|passw|pin|token|secret|note|message|text|comment|card)'
        and jsonb_typeof(e.value) in ('string', 'number', 'boolean', 'null')
        and length(e.value::text) <= 200),
    '{}'::jsonb);
$$;

-- ── the one place that decides whether an event is stored ──────────────────
create or replace function public.audit_record(
  p_org uuid, p_store uuid, p_action text, p_entity text, p_entity_id text, p_detail jsonb, p_source text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_critical boolean;
  v_enabled  boolean := true;
  v_disabled text[]  := '{}';
  v_role     text;
begin
  select t.critical into v_critical from public.audit_event_types t where t.id = p_action;
  if not found then return; end if; -- unknown event types are never written

  select s.enabled, s.disabled_events into v_enabled, v_disabled from public.audit_settings s where s.org_id = p_org;
  v_enabled := coalesce(v_enabled, true);
  v_disabled := coalesce(v_disabled, '{}');

  -- critical events ignore the admin's switches (they would hide fraud and break tax / AML evidence)
  if not v_critical and (not v_enabled or p_action = any (v_disabled)) then return; end if;

  select coalesce(r.built_in, r.name) into v_role
  from public.staff s join public.roles r on r.id = s.role_id
  where s.org_id = p_org and s.user_id = auth.uid() and s.active
  order by (r.built_in = 'owner') desc nulls last limit 1;

  insert into public.audit_log (org_id, store_id, actor_id, actor_role, action, entity, entity_id, detail, source)
  values (p_org, p_store, auth.uid(), v_role, p_action, left(p_entity, 60), left(p_entity_id, 80),
          public.audit_clean_detail(p_detail), p_source);
exception when others then
  -- an audit failure must never break the business action (the DB triggers still see the change)
  raise warning 'audit_record failed: %', sqlerrm;
end $$;
revoke all on function public.audit_record(uuid, uuid, text, text, text, jsonb, text) from public;

-- ── RPCs for the app ───────────────────────────────────────────────────────
create or replace function public.write_audit(
  p_org uuid, p_store uuid, p_action text, p_entity text default null, p_entity_id text default null, p_detail jsonb default '{}'::jsonb
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_org_member(p_org) then
    raise exception 'not a member of this org' using errcode = '42501';
  end if;
  if p_store is not null and not public.can_access_store(p_org, p_store) then
    raise exception 'no access to this store' using errcode = '42501';
  end if;
  perform public.audit_record(p_org, p_store, p_action, p_entity, p_entity_id, p_detail, 'app');
end $$;
revoke all on function public.write_audit(uuid, uuid, text, text, text, jsonb) from public;
grant execute on function public.write_audit(uuid, uuid, text, text, text, jsonb) to authenticated;

create or replace function public.set_audit_settings(p_org uuid, p_enabled boolean, p_disabled text[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_bad text[];
begin
  if not public.has_permission(p_org, 'settings.manage') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  p_disabled := coalesce(p_disabled, '{}');

  select array_agg(x) into v_bad from unnest(p_disabled) x
   where not exists (select 1 from public.audit_event_types t where t.id = x);
  if v_bad is not null then
    raise exception 'unknown event type(s): %', v_bad using errcode = '22023';
  end if;
  select array_agg(x) into v_bad from unnest(p_disabled) x
   where exists (select 1 from public.audit_event_types t where t.id = x and t.critical);
  if v_bad is not null then
    raise exception 'critical events cannot be switched off: %', v_bad using errcode = '23514';
  end if;

  insert into public.audit_settings (org_id, enabled, disabled_events, updated_by)
  values (p_org, p_enabled, (select coalesce(array_agg(distinct x order by x), '{}') from unnest(p_disabled) x), auth.uid())
  on conflict (org_id) do update
    set enabled = excluded.enabled, disabled_events = excluded.disabled_events, updated_by = excluded.updated_by, updated_at = now();

  -- changing the switches is ALWAYS recorded
  perform public.audit_record(p_org, null, 'audit.settings_change', 'audit_settings', p_org::text,
    jsonb_build_object('enabled', p_enabled, 'disabled_count', coalesce(array_length(p_disabled, 1), 0)), 'app');
end $$;
revoke all on function public.set_audit_settings(uuid, boolean, text[]) from public;
grant execute on function public.set_audit_settings(uuid, boolean, text[]) to authenticated;

-- ── DB-side writers on sensitive tables (source = 'db') ────────────────────
create or replace function public.audit_trg_staff() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform public.audit_record(new.org_id, new.store_id, 'staff.add', 'staff', new.id::text, jsonb_build_object('role_id', new.role_id), 'db');
  elsif tg_op = 'UPDATE' then
    if new.role_id is distinct from old.role_id then
      perform public.audit_record(new.org_id, new.store_id, 'staff.role_change', 'staff', new.id::text,
        jsonb_build_object('from_role_id', old.role_id, 'to_role_id', new.role_id), 'db');
    end if;
    if old.active and not new.active then
      perform public.audit_record(new.org_id, new.store_id, 'staff.deactivate', 'staff', new.id::text, '{}'::jsonb, 'db');
    end if;
  elsif tg_op = 'DELETE' then
    perform public.audit_record(old.org_id, old.store_id, 'staff.deactivate', 'staff', old.id::text, jsonb_build_object('deleted', true), 'db');
  end if;
  return coalesce(new, old);
end $$;
create trigger staff_audit after insert or update or delete on public.staff
  for each row execute function public.audit_trg_staff();

create or replace function public.audit_trg_orgs() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.legal_sign_off is distinct from old.legal_sign_off then
    perform public.audit_record(new.id, null, 'org.legal_signoff_change', 'orgs', new.id::text,
      jsonb_build_object('crypto_topup', coalesce((new.legal_sign_off ->> 'cryptoTopup')::boolean, false)), 'db');
  end if;
  return new;
end $$;
create trigger orgs_audit after update on public.orgs
  for each row execute function public.audit_trg_orgs();

create or replace function public.audit_trg_stores() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.module_overrides is distinct from old.module_overrides then
    perform public.audit_record(new.org_id, new.id, 'module.toggle', 'stores', new.id::text,
      jsonb_build_object('overrides_count', (select count(*) from jsonb_object_keys(new.module_overrides))), 'db');
  end if;
  if new.vat_registered is distinct from old.vat_registered or new.vat_bps is distinct from old.vat_bps
     or new.branch_code is distinct from old.branch_code or new.service_charge_bps is distinct from old.service_charge_bps
     or new.price_mode is distinct from old.price_mode or new.plan is distinct from old.plan then
    perform public.audit_record(new.org_id, new.id, 'settings.change', 'stores', new.id::text, jsonb_build_object('area', 'tax_or_plan'), 'db');
  end if;
  return new;
end $$;
create trigger stores_audit after update on public.stores
  for each row execute function public.audit_trg_stores();

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table public.audit_event_types enable row level security;
alter table public.audit_settings    enable row level security;
alter table public.audit_log         enable row level security;

create policy audit_types_read on public.audit_event_types for select to authenticated using (true);
create policy audit_settings_read on public.audit_settings for select to authenticated
  using (public.has_permission(org_id, 'audit.view') or public.has_permission(org_id, 'settings.manage'));
create policy audit_log_read on public.audit_log for select to authenticated
  using (public.has_permission(org_id, 'audit.view'));
-- no insert / update / delete policies: writes only through the SECURITY DEFINER functions above.

revoke all on public.audit_event_types, public.audit_settings, public.audit_log from anon, authenticated;
grant select on public.audit_event_types, public.audit_settings, public.audit_log to authenticated;
