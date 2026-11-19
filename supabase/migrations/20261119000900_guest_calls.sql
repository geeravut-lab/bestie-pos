-- Bestie POS · migration 38 · "Call staff" button on the guest page (docs/AI-CUSTOMER-ASSISTANT.md rule 7: every guest screen has one).
--  * The guest picks a CLOSED reason (help / bill): no free text, nothing to abuse. A table has at most one open call, so tapping again
--    never spams; at most 10 calls per table per 10 minutes.
--  * Staff see open calls on the floor plan (live), and get an in-app notice (LINE is not used for calls: they would eat the monthly quota).
--  * The guest talks to the database only through the service-role function `guest_call_staff` with the table's token.

-- notify_user learns `line: false` (in-app only)
create or replace function public.notify_user(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_user   uuid;
  v_lang   text;
  v_title  text;
  v_body   text;
  v_href   text;
  v_dedupe text;
  v_cat    text;
  v_urgent boolean;
  v_linked boolean;
  v_allow  boolean;
  n        integer;
begin
  v_user := (p ->> 'user_id')::uuid;
  v_href := p ->> 'href';
  v_dedupe := nullif(p ->> 'dedupe', '');
  v_cat := coalesce(p ->> 'category', 'transactional');
  v_urgent := coalesce((p ->> 'urgent')::boolean, false);
  select pr.language into v_lang from public.profiles pr where pr.user_id = v_user;
  v_lang := case when v_lang = 'en' then 'en' else 'th' end;
  v_title := left(coalesce(p -> 'title' ->> v_lang, p -> 'title' ->> 'th', ''), 100);
  v_body := left(coalesce(p -> 'body' ->> v_lang, p -> 'body' ->> 'th', ''), 1000);
  if v_title = '' then return false; end if;
  if v_href is not null and v_href !~ '^/[^/]' then v_href := null; end if;       -- inside our own site only

  insert into public.app_notifications (org_id, user_id, kind, title, body, href, dedupe_key)
  values (nullif(p ->> 'org_id', '')::uuid, v_user, p ->> 'kind', v_title, v_body, v_href, v_dedupe)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics n = row_count;
  if n = 0 then return false; end if;                                              -- told already

  select coalesce((p ->> 'line')::boolean, true)            -- a notice may ask to stay in the app only
         and exists (select 1 from public.notification_channels c where c.owner_id = v_user and c.channel = 'line' and c.status = 'active') into v_linked;
  if v_linked then
    select case when v_cat = 'reminder' then coalesce(np.line_reminders, false) else coalesce(np.line_transactional, true) end
      into v_allow from (select 1) x left join public.notification_prefs np on np.user_id = v_user;
    if coalesce(v_allow, case when v_cat = 'reminder' then false else true end) then
      insert into public.notification_queue (user_id, kind, title, body, href, category, urgent, dedupe_key)
      values (v_user, p ->> 'kind', v_title, v_body, v_href, v_cat, v_urgent, v_dedupe)
      on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
    end if;
  end if;
  return true;
exception when others then
  raise warning 'notify_user failed: %', sqlerrm;
  return false;
end $$;
revoke all on function public.notify_user(jsonb) from public, anon, authenticated;
grant execute on function public.notify_user(jsonb) to service_role;

create table public.guest_calls (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  table_id    uuid not null references public.dining_tables (id) on delete cascade,
  reason      text not null default 'help' check (reason in ('help', 'bill')),
  status      text not null default 'open' check (status in ('open', 'answered')),
  created_at  timestamptz not null default now(),
  answered_at timestamptz,
  answered_by uuid references public.staff (id) on delete set null,
  check ((status = 'open' and answered_at is null) or (status = 'answered' and answered_at is not null))
);
create unique index guest_calls_one_open_uidx on public.guest_calls (table_id) where status = 'open';
create index guest_calls_store_idx on public.guest_calls (store_id, created_at desc);
alter table public.guest_calls enable row level security;
create policy guest_calls_read on public.guest_calls for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.guest_calls from anon, authenticated;
grant select on public.guest_calls to authenticated;
create trigger guest_calls_live after insert or update on public.guest_calls for each row execute function public.live_ping_row('store:{store_id}');

-- the guest taps (service role, with the table's token)
create or replace function public.guest_call_staff(p_token text, p_reason text default 'help') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.dining_tables%rowtype;
  v_id uuid;
begin
  if p_reason not in ('help', 'bill') then
    raise exception 'unknown reason' using errcode = '22023';
  end if;
  select * into t from public.dining_tables where qr_token = p_token and deleted_at is null and active;
  if not found then raise exception 'table not found' using errcode = 'P0002'; end if;
  if not public.qr_ordering_enabled(t.store_id) then
    raise exception 'QR service is switched off in this shop' using errcode = '0A000';
  end if;
  select id into v_id from public.guest_calls where table_id = t.id and status = 'open';
  if found then return jsonb_build_object('status', 'already', 'id', v_id); end if;
  if (select count(*) from public.guest_calls where table_id = t.id and created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'too many calls' using errcode = '53400';
  end if;
  insert into public.guest_calls (org_id, store_id, table_id, reason) values (t.org_id, t.store_id, t.id, p_reason) returning id into v_id;
  return jsonb_build_object('status', 'called', 'id', v_id);
end $$;
revoke all on function public.guest_call_staff(text, text) from public, anon, authenticated;
grant execute on function public.guest_call_staff(text, text) to service_role;

-- a waiter / cashier / manager marks it answered
create or replace function public.answer_guest_call(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.guest_calls%rowtype;
  v_staff uuid;
begin
  select * into c from public.guest_calls where id = p_id for update;
  if not found then raise exception 'call not found' using errcode = 'P0002'; end if;
  if not (public.can_access_store(c.org_id, c.store_id)
          and (public.has_permission(c.org_id, 'order.create') or public.has_permission(c.org_id, 'payment.take'))) then
    raise exception 'answering a call needs order.create' using errcode = '42501';
  end if;
  if c.status = 'answered' then return; end if;
  select s.id into v_staff from public.staff s where s.org_id = c.org_id and s.user_id = auth.uid() and s.active limit 1;
  update public.guest_calls set status = 'answered', answered_at = now(), answered_by = v_staff where id = c.id;
end $$;
revoke all on function public.answer_guest_call(uuid) from public, anon;
grant execute on function public.answer_guest_call(uuid) to authenticated, service_role;

-- everybody on the floor hears about it (in the app only)
create or replace function public.notify_guest_call() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_table text;
  u uuid;
begin
  select name into v_table from public.dining_tables where id = new.table_id;
  for u in
    select distinct s.user_id from public.staff s join public.roles r on r.id = s.role_id
     where s.org_id = new.org_id and s.active and s.user_id is not null
       and (s.store_id is null or s.store_id = new.store_id)
       and (r.built_in in ('owner', 'manager', 'cashier', 'waiter') or 'order.create' = any (r.permissions))
  loop
    perform public.notify_user(jsonb_build_object(
      'user_id', u, 'org_id', new.org_id, 'kind', 'guest.call', 'href', '/tables', 'line', false,
      'dedupe', 'call:' || new.id,
      'title', jsonb_build_object('th', case new.reason when 'bill' then 'โต๊ะ ' || v_table || ' ขอเช็คบิล' else 'โต๊ะ ' || v_table || ' เรียกพนักงาน' end,
                                  'en', case new.reason when 'bill' then 'Table ' || v_table || ' asks for the bill' else 'Table ' || v_table || ' calls the staff' end),
      'body', jsonb_build_object('th', 'ลูกค้ากดปุ่มเรียกที่หน้าจอโต๊ะ', 'en', 'A guest pressed the call button on the table page')));
  end loop;
  return null;
exception when others then
  raise warning 'notify_guest_call failed: %', sqlerrm;
  return null;
end $$;
create trigger guest_calls_notify after insert on public.guest_calls for each row execute function public.notify_guest_call();
