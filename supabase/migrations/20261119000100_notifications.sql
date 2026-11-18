-- Bestie POS · migration 30 · notifications: in-app inbox + LINE queue (docs/LINE-NOTIFICATIONS-KNOWLEDGE.md).
--
--  * ONE writer: `notify_user(p)` writes the in-app inbox AND (if the person linked LINE and allows it) a queue row. It never
--    raises (an event has already happened; a lost message must not undo it), and a repeated `dedupe` key tells nobody twice.
--  * The queue copies title / body / href, so clearing the inbox never loses a message waiting for LINE.
--  * Delivery is a separate step (a scheduled tick, /api/notify/tick): monthly cap with a reserve for urgent messages,
--    retry up to 3 times, halt for 6 h when LINE's token is rejected.
--  * Text leaves the app only as "what happened + a link to open the app": amounts and bill numbers, never customer data.
--  * First notices: PromptPay / card paid, payment that needs a person's review (urgent), order ready for the waiter,
--    shift closed with a cash difference, daily sales summary. (Low stock arrives with the stock module.)

create table public.app_notifications (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid references public.orgs (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (length(kind) between 1 and 60),
  title      text not null check (length(title) between 1 and 100),
  body       text not null default '' check (length(body) <= 1000),
  href       text check (href is null or (href ~ '^/[^/]' and length(href) <= 200)),
  dedupe_key text check (length(dedupe_key) <= 200),
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create unique index app_notifications_dedupe_uidx on public.app_notifications (user_id, dedupe_key) where dedupe_key is not null;
create index app_notifications_user_idx on public.app_notifications (user_id, created_at desc);
alter table public.app_notifications enable row level security;
create policy app_notifications_own_read on public.app_notifications for select to authenticated using (user_id = auth.uid());
create policy app_notifications_own_update on public.app_notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy app_notifications_own_delete on public.app_notifications for delete to authenticated using (user_id = auth.uid());
revoke all on public.app_notifications from anon, authenticated;
grant select, delete on public.app_notifications to authenticated;
grant update (read_at) on public.app_notifications to authenticated;     -- only "read" can be changed by the person

create table public.notification_queue (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text not null default '',
  href       text,
  category   text not null default 'transactional' check (category in ('transactional', 'reminder')),
  urgent     boolean not null default false,
  dedupe_key text,
  status     text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'blocked', 'skipped')),
  attempts   integer not null default 0,
  last_error text check (length(last_error) <= 200),
  last_try_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
create unique index notification_queue_dedupe_uidx on public.notification_queue (user_id, dedupe_key) where dedupe_key is not null;
create index notification_queue_due_idx on public.notification_queue (urgent desc, created_at) where status = 'queued';
create index notification_queue_sent_idx on public.notification_queue (sent_at) where status = 'sent';
alter table public.notification_queue enable row level security;          -- server only
revoke all on public.notification_queue from anon, authenticated;

create table public.notification_prefs (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  line_transactional boolean not null default true,    -- service messages (money, orders): on once LINE is linked
  line_reminders    boolean not null default false,    -- reminders / habits: opt-in
  updated_at        timestamptz not null default now()
);
alter table public.notification_prefs enable row level security;
create policy notification_prefs_own on public.notification_prefs for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.notification_prefs from anon, authenticated;
grant select, insert, update on public.notification_prefs to authenticated;

create table public.notification_settings (
  id               boolean primary key default true check (id),
  line_monthly_cap integer not null default 200 check (line_monthly_cap between 0 and 1000000),
  line_reserve     integer not null default 20 check (line_reserve >= 0),
  halted_until     timestamptz,
  halted_reason    text check (length(halted_reason) <= 200),
  check (line_reserve <= line_monthly_cap)
);
insert into public.notification_settings (id) values (true);
alter table public.notification_settings enable row level security;      -- server only
revoke all on public.notification_settings from anon, authenticated;

-- ── helpers ────────────────────────────────────────────────────────────────
create or replace function public.fmt_baht(p_satang bigint) returns text
language sql immutable set search_path = '' as $$
  select '฿' || to_char(round(p_satang / 100.0, 2), 'FM999,999,999,990.00')
$$;

-- the people of a shop who should hear about money and problems: owners and anyone who may view reports
create or replace function public.notice_managers(p_org uuid, p_store uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct s.user_id from public.staff s join public.roles r on r.id = s.role_id
   where s.org_id = p_org and s.active and s.user_id is not null
     and (r.built_in = 'owner' or 'report.view' = any (r.permissions))
     and (s.store_id is null or p_store is null or s.store_id = p_store)
$$;
revoke all on function public.notice_managers(uuid, uuid) from public, anon, authenticated;

-- ── THE writer ─────────────────────────────────────────────────────────────
-- p = { user_id, org_id?, kind, title:{th,en}, body:{th,en}, href?, dedupe?, category?, urgent? }  → true if somebody was told now
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

  select exists (select 1 from public.notification_channels c where c.owner_id = v_user and c.channel = 'line' and c.status = 'active') into v_linked;
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

-- tell every manager of a shop (same notice, each in their own language)
create or replace function public.notify_managers(p_org uuid, p_store uuid, p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare u uuid; n integer := 0;
begin
  for u in select * from public.notice_managers(p_org, p_store) loop
    if public.notify_user(p || jsonb_build_object('user_id', u, 'org_id', p_org)) then n := n + 1; end if;
  end loop;
  return n;
exception when others then
  raise warning 'notify_managers failed: %', sqlerrm;
  return 0;
end $$;
revoke all on function public.notify_managers(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.notify_managers(uuid, uuid, jsonb) to service_role;

-- ── first notice 1 + 2: a payment that arrived through the provider ────────
create or replace function public.notify_payment_attempt() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders%rowtype;
  v_amt text := public.fmt_baht(new.amount);
begin
  if new.status is not distinct from old.status or new.status not in ('succeeded', 'needs_review') then return null; end if;
  select * into o from public.orders where id = new.order_id;
  if new.status = 'succeeded' then
    perform public.notify_managers(new.org_id, new.store_id, jsonb_build_object(
      'kind', 'payment.paid', 'href', '/receipt/' || new.order_id, 'dedupe', 'paid:' || new.id,
      'title', jsonb_build_object('th', 'รับเงินแล้ว ' || v_amt, 'en', 'Payment received ' || v_amt),
      'body', jsonb_build_object(
        'th', 'ชำระผ่าน ' || case new.tender when 'promptpay' then 'PromptPay' else 'บัตร' end || E'\nบิล: ' || coalesce(o.number, '-') || E'\nยอด: ' || v_amt,
        'en', 'Paid by ' || case new.tender when 'promptpay' then 'PromptPay' else 'card' end || E'\nBill: ' || coalesce(o.number, '-') || E'\nAmount: ' || v_amt)));
  else
    perform public.notify_managers(new.org_id, new.store_id, jsonb_build_object(
      'kind', 'payment.review', 'urgent', true, 'href', '/order/' || new.order_id, 'dedupe', 'review:' || new.id,
      'title', jsonb_build_object('th', 'เงินเข้าแต่ต้องตรวจสอบ ' || v_amt, 'en', 'Money received, needs a check ' || v_amt),
      'body', jsonb_build_object(
        'th', E'บิล: ' || coalesce(o.number, '-') || E'\nยอด: ' || v_amt || E'\nห้ามรับเงินซ้ำ ให้ตรวจใน Stripe และหลังร้าน',
        'en', E'Bill: ' || coalesce(o.number, '-') || E'\nAmount: ' || v_amt || E'\nDo not take the money again; check Stripe and the shop')));
  end if;
  return null;
exception when others then
  raise warning 'notify_payment_attempt failed: %', sqlerrm;
  return null;
end $$;
create trigger payment_attempts_notify after update of status on public.payment_attempts for each row execute function public.notify_payment_attempt();

-- ── first notice 3: the order is ready for the waiter ──────────────────────
create or replace function public.notify_order_ready() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  o public.orders%rowtype;
  v_user uuid;
begin
  if new.status is not distinct from old.status or new.status <> 'ready' then return null; end if;
  if exists (select 1 from public.order_lines l where l.order_id = new.order_id and l.status in ('new', 'sent')) then return null; end if;   -- not everything is ready yet
  select * into o from public.orders where id = new.order_id;
  if o.status in ('paid', 'void') or o.opened_by is null then return null; end if;
  select s.user_id into v_user from public.staff s where s.id = o.opened_by and s.active;
  if v_user is null then return null; end if;
  perform public.notify_user(jsonb_build_object(
    'user_id', v_user, 'org_id', o.org_id, 'kind', 'order.ready', 'href', '/ready',
    'dedupe', 'ready:' || o.id || ':' || to_char(now(), 'YYYYMMDDHH24MI'),
    'title', jsonb_build_object('th', 'ออเดอร์ ' || o.number || ' พร้อมเสิร์ฟ', 'en', 'Order ' || o.number || ' is ready'),
    'body', jsonb_build_object('th', 'บิล: ' || o.number || E'\nสถานะ: พร้อมเสิร์ฟ', 'en', 'Bill: ' || o.number || E'\nStatus: ready to serve')));
  return null;
exception when others then
  raise warning 'notify_order_ready failed: %', sqlerrm;
  return null;
end $$;
create trigger order_lines_notify_ready after update of status on public.order_lines for each row execute function public.notify_order_ready();

-- ── first notice 4: a shift closed with a cash difference ──────────────────
create or replace function public.notify_shift_variance() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_amt text;
begin
  if new.status <> 'closed' or old.status = 'closed' or coalesce(new.variance, 0) = 0 then return null; end if;
  v_amt := (case when new.variance > 0 then '+' else '−' end) || public.fmt_baht(abs(new.variance));
  perform public.notify_managers(new.org_id, new.store_id, jsonb_build_object(
    'kind', 'shift.variance', 'urgent', abs(new.variance) >= 10000, 'href', '/shift', 'dedupe', 'shift:' || new.id,
    'title', jsonb_build_object('th', 'ปิดกะ เงินสดต่างกัน ' || v_amt, 'en', 'Shift closed, cash differs ' || v_amt),
    'body', jsonb_build_object(
      'th', E'ส่วนต่าง: ' || v_amt || E'\nนับได้: ' || public.fmt_baht(new.counted_cash) || E'\nควรมี: ' || public.fmt_baht(new.expected_cash),
      'en', E'Difference: ' || v_amt || E'\nCounted: ' || public.fmt_baht(new.counted_cash) || E'\nExpected: ' || public.fmt_baht(new.expected_cash))));
  return null;
exception when others then
  raise warning 'notify_shift_variance failed: %', sqlerrm;
  return null;
end $$;
create trigger shifts_notify_variance after update of status on public.shifts for each row execute function public.notify_shift_variance();

-- ── first notice 5: the day's sales (called by the scheduled tick after closing time; safe to call again) ──
create or replace function public.notify_daily_summary(p_date date) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  s record;
  v_bills bigint; v_total bigint; v_top text;
  n integer := 0;
begin
  for s in select st.id, st.org_id, st.name from public.stores st where st.deleted_at is null loop
    select count(*), coalesce(sum(r.payable), 0) into v_bills, v_total
      from public.orders o join public.receipts r on r.order_id = o.id
     where o.store_id = s.id and o.status = 'paid' and o.business_date = p_date;
    if v_bills = 0 then continue; end if;
    select coalesce(l.name ->> 'th', '') into v_top
      from public.order_lines l join public.orders o on o.id = l.order_id
     where o.store_id = s.id and o.status = 'paid' and o.business_date = p_date and l.status <> 'void'
     group by l.name ->> 'th' order by sum(l.quantity) desc limit 1;
    n := n + public.notify_managers(s.org_id, s.id, jsonb_build_object(
      'kind', 'daily.summary', 'category', 'reminder', 'href', '/reports', 'dedupe', 'daily:' || s.id || ':' || p_date,
      'title', jsonb_build_object('th', 'สรุปยอดขาย ' || s.name || ' ' || public.fmt_baht(v_total), 'en', 'Sales summary ' || s.name || ' ' || public.fmt_baht(v_total)),
      'body', jsonb_build_object(
        'th', E'วันที่: ' || p_date || E'\nยอดขาย: ' || public.fmt_baht(v_total) || E'\nจำนวนบิล: ' || v_bills || case when v_top <> '' then E'\nขายดี: ' || v_top else '' end,
        'en', E'Date: ' || p_date || E'\nSales: ' || public.fmt_baht(v_total) || E'\nBills: ' || v_bills || case when v_top <> '' then E'\nTop seller: ' || v_top else '' end)));
  end loop;
  return n;
end $$;
revoke all on function public.notify_daily_summary(date) from public, anon, authenticated;
grant execute on function public.notify_daily_summary(date) to service_role;

-- ── delivery (called by /api/notify/tick with the service role) ────────────
-- Hand out the messages that are due, honouring: the halt after a rejected token, the monthly LINE cap (urgent ones may use the
-- reserve), and "stale news is not news" (a non-urgent notice older than 24 h is skipped, never sent late).
create or replace function public.notify_claim(p_limit integer default 20) returns table (
  id uuid, user_id uuid, kind text, title text, body text, href text, urgent boolean, attempts integer, address text, lang text
) language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  st public.notification_settings%rowtype;
  v_sent integer;
  v_room_normal integer;
  v_room_urgent integer;
begin
  select * into st from public.notification_settings where notification_settings.id;
  if st.halted_until is not null and st.halted_until > now() then return; end if;

  update public.notification_queue q set status = 'skipped', last_error = 'stale'
   where q.status = 'queued' and not q.urgent and q.created_at < now() - interval '24 hours';

  select count(*) into v_sent from public.notification_queue q
   where (q.status = 'sent' and q.sent_at >= date_trunc('month', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok')
      or (q.status = 'queued' and q.last_try_at >= now() - interval '1 minute');        -- handed out a moment ago, result not reported yet
  v_room_urgent := greatest(st.line_monthly_cap - v_sent, 0);
  v_room_normal := greatest(st.line_monthly_cap - st.line_reserve - v_sent, 0);
  if v_room_urgent = 0 then return; end if;

  return query
  with locked as (
    select q.id as qid, q.urgent as u, q.created_at as at
      from public.notification_queue q
     where q.status = 'queued' and q.attempts < 3 and (q.last_try_at is null or q.last_try_at < now() - interval '1 minute')
     order by q.urgent desc, q.created_at
     limit greatest(least(p_limit, 100), 0)
     for update skip locked
  ), due as (
    select qid, u, row_number() over (order by u desc, at) as rn, row_number() over (partition by u order by at) as rn_same from locked
  ), pick as (
    select qid from due where rn <= v_room_urgent and (u or rn_same <= v_room_normal)
  ), upd as (
    update public.notification_queue q set attempts = q.attempts + 1, last_try_at = now()
      from pick where q.id = pick.qid
    returning q.*
  )
  select u.id, u.user_id, u.kind, u.title, u.body, u.href, u.urgent, u.attempts, c.address, case when pr.language = 'en' then 'en' else 'th' end
    from upd u
    left join public.notification_channels c on c.owner_id = u.user_id and c.channel = 'line' and c.status = 'active'
    left join public.profiles pr on pr.user_id = u.user_id
   order by u.urgent desc, u.created_at;
end $$;
revoke all on function public.notify_claim(integer) from public, anon, authenticated;
grant execute on function public.notify_claim(integer) to service_role;

-- record what happened to one message
create or replace function public.notify_report(p_id uuid, p_outcome text, p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.notification_queue%rowtype;
begin
  select * into q from public.notification_queue where id = p_id;
  if not found then return; end if;
  if p_outcome = 'sent' then
    update public.notification_queue set status = 'sent', sent_at = now(), last_error = null where id = p_id;
  elsif p_outcome = 'no_channel' then
    update public.notification_queue set status = 'skipped', last_error = 'no LINE linked' where id = p_id;
  elsif p_outcome = 'blocked' then
    update public.notification_queue set status = 'blocked', last_error = 'recipient blocked' where id = p_id;
    update public.notification_channels set status = 'stopped', last_error = 'blocked' where owner_id = q.user_id and channel = 'line';
  elsif p_outcome = 'auth_failed' then
    update public.notification_queue set attempts = greatest(attempts - 1, 0), last_error = 'auth_failed' where id = p_id;     -- our token, not this message
    update public.notification_settings set halted_until = now() + interval '6 hours', halted_reason = 'LINE rejected the access token' where id;
  else                                                                                                                 -- retry / rate_limited
    update public.notification_queue set status = case when attempts >= 3 then 'failed' else 'queued' end, last_error = left(coalesce(p_error, p_outcome), 200) where id = p_id;
  end if;
  insert into public.message_log (owner_id, channel, kind, status, error)
  values (q.user_id, 'line', q.kind, case when p_outcome = 'sent' then 'sent' else 'failed' end, case when p_outcome = 'sent' then null else left(p_outcome, 200) end);
end $$;
revoke all on function public.notify_report(uuid, text, text) from public, anon, authenticated;
grant execute on function public.notify_report(uuid, text, text) to service_role;

-- housekeeping: sent queue rows after 60 days (the monthly count only needs this month), read inbox notices after 90 days
create or replace function public.notify_housekeeping() returns integer
language plpgsql security definer set search_path = '' as $$
declare a integer; b integer;
begin
  delete from public.notification_queue where status in ('sent', 'skipped', 'blocked', 'failed') and created_at < now() - interval '60 days';
  get diagnostics a = row_count;
  delete from public.app_notifications where read_at is not null and created_at < now() - interval '90 days';
  get diagnostics b = row_count;
  return a + b;
end $$;
revoke all on function public.notify_housekeeping() from public, anon, authenticated;
grant execute on function public.notify_housekeeping() to service_role;

-- ── live bell: a new notice pings the person's own private channel `u:<user id>` ──
create or replace function public.live_ping_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r      jsonb := to_jsonb(coalesce(new, old));
  tpl    text;
  topic  text;
begin
  foreach tpl in array tg_argv loop
    topic := tpl;
    topic := replace(topic, '{id}', coalesce(r ->> 'id', ''));
    topic := replace(topic, '{org_id}', coalesce(r ->> 'org_id', ''));
    topic := replace(topic, '{store_id}', coalesce(r ->> 'store_id', ''));
    topic := replace(topic, '{user_id}', coalesce(r ->> 'user_id', ''));
    if topic !~ '[{}]' and topic !~ ':$' and topic !~ '::' then
      perform public.live_ping(topic);
    end if;
  end loop;
  return coalesce(new, old);
end $$;
create trigger app_notifications_live after insert on public.app_notifications
  for each row execute function public.live_ping_row('u:{user_id}');
