-- Bestie POS · migration 89 · REMINDERS TO TOUR GUESTS (owner order 22 Nov): a guest who booked a tour (online, or at the counter) gets ONE reminder by LINE and / or e-mail
-- before the trip. Same shape as the appointment reminders: the booking code (online) or a one-time code (counter) is the key, the contact is stored on that booking only,
-- sent once by the notification tick, and erased when the booking is over.

alter table public.tour_bookings add column guest_email text check (guest_email is null or length(guest_email) <= 120);
alter table public.tour_bookings add column guest_line_user_id text check (guest_line_user_id is null or length(guest_line_user_id) between 5 and 64);
alter table public.tour_bookings add column guest_reminded_at timestamptz;
create index tour_bookings_remind_idx on public.tour_bookings (slot_id)
  where guest_reminded_at is null and (guest_email is not null or guest_line_user_id is not null);

-- the guest types an e-mail address on the booking page (with the cancel code as proof; '' removes it)
create or replace function public.guest_tour_contact(p_token text, p_id uuid, p_code text, p_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; b public.tour_bookings%rowtype; v_start timestamptz; v_email text := lower(btrim(coalesce(p_email, '')));
begin
  s := public.tour_store(p_token);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select * into b from public.tour_bookings where id = p_id and store_id = s.id and source = 'online'
     and cancel_hash = encode(sha256(convert_to(upper(btrim(coalesce(p_code, ''))), 'utf8')), 'hex') for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  select starts_at into v_start from public.tour_slots where id = b.slot_id;
  if b.status <> 'booked' or v_start <= now() then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  if v_email <> '' and (length(v_email) > 120 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    return jsonb_build_object('ok', false, 'error', 'bad_email');
  end if;
  update public.tour_bookings set guest_email = nullif(v_email, '') where id = b.id;
  return jsonb_build_object('ok', true);
end $$;

-- the front desk, for a booking made at the counter: the guest's e-mail, and a ONE-TIME code the guest sends to the shop's LINE
create or replace function public.set_tour_contact(p_booking uuid, p_email text) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.tour_bookings%rowtype; v_start timestamptz; v_email text := lower(btrim(coalesce(p_email, '')));
begin
  select * into b from public.tour_bookings where id = p_booking for update;
  if not found or not (public.can_access_store(b.org_id, b.store_id) and public.has_permission(b.org_id, 'order.create')) then
    raise exception 'saving a contact needs order.create in this shop' using errcode = '42501';
  end if;
  select starts_at into v_start from public.tour_slots where id = b.slot_id;
  if b.status <> 'booked' or v_start <= now() then raise exception 'this booking is no longer waiting' using errcode = '55000'; end if;
  if v_email <> '' and (length(v_email) > 120 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then raise exception 'that e-mail address is not valid' using errcode = '22023'; end if;
  update public.tour_bookings set guest_email = nullif(v_email, '') where id = b.id;
end $$;
create or replace function public.tour_guest_code(p_booking uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare b public.tour_bookings%rowtype; v_start timestamptz; v_code text;
begin
  select * into b from public.tour_bookings where id = p_booking for update;
  if not found or not (public.can_access_store(b.org_id, b.store_id) and public.has_permission(b.org_id, 'order.create')) then
    raise exception 'a reminder code needs order.create in this shop' using errcode = '42501';
  end if;
  if b.source <> 'staff' then raise exception 'an online booking already gave its code to the guest' using errcode = '55000'; end if;
  select starts_at into v_start from public.tour_slots where id = b.slot_id;
  if b.status <> 'booked' or v_start <= now() then raise exception 'this booking is no longer waiting' using errcode = '55000'; end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  update public.tour_bookings set cancel_hash = encode(sha256(convert_to(v_code, 'utf8')), 'hex') where id = b.id;
  return v_code;
end $$;
revoke all on function public.set_tour_contact(uuid, text), public.tour_guest_code(uuid) from public, anon;
grant execute on function public.set_tour_contact(uuid, text), public.tour_guest_code(uuid) to authenticated, service_role;
revoke all on function public.guest_tour_contact(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.guest_tour_contact(text, uuid, text, text) to service_role;

-- the LINE webhook: a booking code of a tour binds that booking's reminder channel (appointments are tried first; the codes are random 32-bit values)
do $$
declare r record; src text; dst text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'guest_bind_line' loop
    src := pg_get_functiondef(r.oid);
    dst := replace(src, $a$  if not found then return jsonb_build_object('ok', false); end if;
  update public.appointments set guest_line_user_id$a$, $b$  if not found then
    update public.tour_bookings t set guest_line_user_id = p_line_user_id
     where t.id = (select x.id from public.tour_bookings x join public.tour_slots y on y.id = x.slot_id
                    where x.cancel_hash = v_hash and x.status = 'booked' and y.starts_at > now() order by y.starts_at limit 1);
    if found then return jsonb_build_object('ok', true, 'kind', 'booking'); end if;
    return jsonb_build_object('ok', false);
  end if;
  update public.appointments set guest_line_user_id$b$);
    if dst = src then raise exception 'migration 89: guest_bind_line not changed'; end if;
    execute dst;
  end loop;
end $$;

-- who is due: booked tours starting within the next p_minutes (a day by default: "tomorrow's tour"), one reminder each
create or replace function public.guest_tour_reminders_due(p_minutes integer default 1440) returns table (
  id uuid, starts_at timestamptz, guest_name text, title jsonb, shop_name text, seats integer, guest_email text, guest_line_user_id text
) language sql stable security definer set search_path = '' as $$
  select b.id, t.starts_at, b.guest_name, t.title, s.name, b.seats, b.guest_email, b.guest_line_user_id
    from public.tour_bookings b
    join public.tour_slots t on t.id = b.slot_id
    join public.stores s on s.id = b.store_id
   where b.guest_reminded_at is null and b.status = 'booked' and t.status = 'open'
     and (b.guest_email is not null or b.guest_line_user_id is not null)
     and t.starts_at > now() and t.starts_at <= now() + make_interval(mins => least(greatest(p_minutes, 5), 4320))
   order by t.starts_at limit 100
$$;
create or replace function public.guest_tour_reminder_done(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.tour_bookings set guest_reminded_at = now() where id = p_id and guest_reminded_at is null
$$;
revoke all on function public.guest_tour_reminders_due(integer), public.guest_tour_reminder_done(uuid) from public, anon, authenticated;
grant execute on function public.guest_tour_reminders_due(integer), public.guest_tour_reminder_done(uuid) to service_role;

-- the contacts exist for the reminder only: erased once the booking is over (cancelled / no-show / checked in) or its tour started (the hourly tidy already calls this)
do $$
declare r record; src text; dst text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'guest_contacts_cleanup' loop
    src := pg_get_functiondef(r.oid);
    dst := replace(src, $a$  get diagnostics n = row_count;$a$, $b$  get diagnostics n = row_count;
  update public.tour_bookings b set guest_email = null, guest_line_user_id = null
   where (b.guest_email is not null or b.guest_line_user_id is not null)
     and (b.status in ('cancelled', 'no_show', 'checked_in') or exists (select 1 from public.tour_slots t where t.id = b.slot_id and t.starts_at < now()));$b$);
    if dst = src then raise exception 'migration 89: guest_contacts_cleanup not changed'; end if;
    execute dst;
  end loop;
end $$;
