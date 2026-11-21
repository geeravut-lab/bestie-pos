-- Bestie POS · migration 59 · reminders to the GUEST before an appointment (LINE and e-mail).
--
-- A guest has no account. After booking online the page shows the cancel code (migration 54). The SAME code now also lets the guest
--  (a) send it to the LINE Official Account after adding it as a friend → `guest_bind_line` remembers that LINE user for that
--      booking only (the webhook calls it; service role), and
--  (b) type an e-mail address on the booking page → `guest_booking_contact` stores it on that booking only (needs the cancel code).
-- `guest_reminders_due` lists bookings starting within the next N minutes that have a contact and were not reminded;
-- `guest_reminder_done` marks one; `guest_contacts_cleanup` erases the e-mail and the LINE id once the booking is over, cancelled
-- or a day past (PDPA: the contact exists for the reminder only). All of these are service-role only.

alter table public.appointments add column guest_email text
  check (guest_email is null or (length(guest_email) <= 120 and guest_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));
alter table public.appointments add column guest_line_user_id text check (guest_line_user_id is null or length(guest_line_user_id) between 5 and 64);
alter table public.appointments add column guest_reminded_at timestamptz;
create index appointments_guest_remind_idx on public.appointments (starts_at)
  where guest_reminded_at is null and (guest_email is not null or guest_line_user_id is not null);

-- the e-mail of a booking, given by the guest with the cancel code ('' removes it)
create or replace function public.guest_booking_contact(p_token text, p_id uuid, p_code text, p_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype;
  a public.appointments%rowtype;
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  s := public.booking_store(p_token);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select * into a from public.appointments where id = p_id and store_id = s.id and source = 'online' for update;
  if not found or a.cancel_hash is null or a.cancel_hash <> encode(sha256(convert_to(upper(btrim(coalesce(p_code, ''))), 'utf8')), 'hex') then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if a.status not in ('booked', 'confirmed') or a.starts_at <= now() then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  if v_email <> '' and (length(v_email) > 120 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    return jsonb_build_object('ok', false, 'error', 'bad_email');
  end if;
  update public.appointments set guest_email = nullif(v_email, '') where id = a.id;
  return jsonb_build_object('ok', true);
end $$;

-- the LINE webhook: a guest sent their booking code to the Official Account
create or replace function public.guest_bind_line(p_code text, p_line_user_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  a public.appointments%rowtype;
  v_hash text := encode(sha256(convert_to(upper(btrim(coalesce(p_code, ''))), 'utf8')), 'hex');
begin
  if p_line_user_id is null or length(p_line_user_id) not between 5 and 64 then return jsonb_build_object('ok', false); end if;
  select * into a from public.appointments
   where cancel_hash = v_hash and source = 'online' and status in ('booked', 'confirmed') and starts_at > now()
   order by starts_at limit 1 for update;
  if not found then return jsonb_build_object('ok', false); end if;
  update public.appointments set guest_line_user_id = p_line_user_id where id = a.id;
  return jsonb_build_object('ok', true, 'starts_at', a.starts_at);
end $$;

create or replace function public.guest_reminders_due(p_minutes integer default 180) returns table (
  id uuid, starts_at timestamptz, guest_name text, service_name jsonb, shop_name text, provider_name text, guest_email text, guest_line_user_id text
) language sql stable security definer set search_path = '' as $$
  select a.id, a.starts_at, a.guest_name, a.service_name, s.name, r.name, a.guest_email, a.guest_line_user_id
    from public.appointments a
    join public.stores s on s.id = a.store_id
    left join public.resources r on r.id = a.provider_id
   where a.guest_reminded_at is null and a.status in ('booked', 'confirmed')
     and (a.guest_email is not null or a.guest_line_user_id is not null)
     and a.starts_at > now() and a.starts_at <= now() + make_interval(mins => least(greatest(p_minutes, 5), 1440))
   order by a.starts_at limit 100
$$;

create or replace function public.guest_reminder_done(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.appointments set guest_reminded_at = now() where id = p_id and guest_reminded_at is null
$$;

create or replace function public.guest_contacts_cleanup() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.appointments set guest_email = null, guest_line_user_id = null
   where (guest_email is not null or guest_line_user_id is not null)
     and (status in ('cancelled', 'no_show', 'done') or ends_at < now() - interval '1 day');
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.guest_booking_contact(text, uuid, text, text), public.guest_bind_line(text, text),
  public.guest_reminders_due(integer), public.guest_reminder_done(uuid), public.guest_contacts_cleanup() from public, anon, authenticated;
grant execute on function public.guest_booking_contact(text, uuid, text, text), public.guest_bind_line(text, text),
  public.guest_reminders_due(integer), public.guest_reminder_done(uuid), public.guest_contacts_cleanup() to service_role;
