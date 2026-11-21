-- Bestie POS · migration 62 · (1) the guest fills in the spa HEALTH FORM on her own phone, (2) BEFORE / AFTER photos in the client record.
--
-- (1) `guest_health_form` (service role): the guest proves her booking with its code (as for cancelling), ticks the consent box, types her
--     full name as the signature and answers the same closed questions as the counter form. The form is stored in `health_intakes`
--     with `source = 'guest'` and the booking it came from (`appointment_id`); it is tied to the member when the booking has one.
--     Only spa shops offer it (`guest_health_form_info`). Never edited; erasable by a manager; content never audited.
-- (2) `client_photos` + `client_photo_data` (no grant): a front-desk person adds a before / after / other photo of a MEMBER, only with the
--     client's consent tick (`consent_at`); JPEG / PNG / WebP up to 256 KB (checked by its first bytes); kept 12 months, then erased by the hourly
--     clean-up; a manager (`staff.manage`) can erase one any time; viewing needs `customer.view`. Nothing is sent to an AI provider.
-- The consent wording must be checked by the lawyer before use at a pilot shop.

alter table public.health_intakes alter column customer_id drop not null;
alter table public.health_intakes add column appointment_id uuid references public.appointments (id) on delete set null;
alter table public.health_intakes add column source text not null default 'staff' check (source in ('staff', 'guest'));
alter table public.health_intakes add constraint health_intakes_who_ck check (customer_id is not null or appointment_id is not null);
create index health_intakes_appt_idx on public.health_intakes (appointment_id) where appointment_id is not null;

create or replace function public.guest_health_form_info(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype;
begin
  s := public.booking_store(p_token);
  if s.id is null then return null; end if;
  return jsonb_build_object('enabled', s.profile = 'spa' and public.appointments_enabled(s.id));
end $$;

-- p = { consent, signed_name, answers }
create or replace function public.guest_health_form(p_token text, p_id uuid, p_code text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype;
  a public.appointments%rowtype;
  v_id uuid;
begin
  s := public.booking_store(p_token);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if s.profile <> 'spa' or not public.appointments_enabled(s.id) then return jsonb_build_object('ok', false, 'error', 'off'); end if;
  select * into a from public.appointments where id = p_id and store_id = s.id and source = 'online' for update;
  if not found or a.cancel_hash is null or a.cancel_hash <> encode(sha256(convert_to(upper(btrim(coalesce(p_code, ''))), 'utf8')), 'hex') then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if a.status not in ('booked', 'confirmed', 'arrived') then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  if coalesce((p ->> 'consent')::boolean, false) is not true then return jsonb_build_object('ok', false, 'error', 'consent_needed'); end if;
  if length(btrim(coalesce(p ->> 'signed_name', ''))) not between 2 and 80 then return jsonb_build_object('ok', false, 'error', 'bad_name'); end if;
  if not public.health_answers_ok(coalesce(p -> 'answers', 'null'::jsonb)) then return jsonb_build_object('ok', false, 'error', 'bad_answers'); end if;
  if (select count(*) from public.health_intakes where appointment_id = a.id) >= 3 then return jsonb_build_object('ok', false, 'error', 'too_many'); end if;
  insert into public.health_intakes (org_id, store_id, customer_id, appointment_id, answers, consent, signed_name, source)
  values (a.org_id, a.store_id, a.customer_id, a.id, p -> 'answers', true, btrim(p ->> 'signed_name'), 'guest')
  returning id into v_id;
  perform public.audit_record(a.org_id, a.store_id, 'settings.change', 'health_intakes', v_id::text, jsonb_build_object('saved', true, 'by', 'guest'), 'db');
  return jsonb_build_object('ok', true);
end $$;

-- ── before / after photos ──
create table public.client_photos (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  customer_id uuid not null references public.customers (id),
  kind        text not null check (kind in ('before', 'after', 'other')),
  appointment_id uuid references public.appointments (id) on delete set null,
  note        text check (note is null or length(note) <= 200),
  consent_at  timestamptz not null,
  expires_at  timestamptz not null,
  created_by  uuid references public.staff (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index client_photos_customer_idx on public.client_photos (customer_id, created_at desc);
create table public.client_photo_data (
  photo_id uuid primary key references public.client_photos (id) on delete cascade,
  mime     text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  data     bytea not null check (octet_length(data) between 100 and 262144)
);
alter table public.client_photos enable row level security;
alter table public.client_photo_data enable row level security;
create policy client_photos_read on public.client_photos for select to authenticated using (public.has_permission(org_id, 'customer.view'));
revoke all on public.client_photos, public.client_photo_data from anon, authenticated;
grant select on public.client_photos to authenticated;

-- p = { store_id, customer_id, kind, consent, mime, data (base64), note?, appointment_id? }
create or replace function public.add_client_photo(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_store uuid := (p ->> 'store_id')::uuid;
  v_cust uuid := (p ->> 'customer_id')::uuid;
  v_staff uuid;
  s public.stores%rowtype;
  v_bytes bytea;
  v_id uuid;
begin
  v_staff := public.client_record_guard(v_store, v_cust);
  select * into s from public.stores where id = v_store;
  if coalesce((p ->> 'consent')::boolean, false) is not true then raise exception 'the client must agree to the photo first' using errcode = '22023'; end if;
  if coalesce(p ->> 'kind', '') not in ('before', 'after', 'other') then raise exception 'unknown kind' using errcode = '22023'; end if;
  if nullif(p ->> 'appointment_id', '') is not null
     and not exists (select 1 from public.appointments a where a.id = (p ->> 'appointment_id')::uuid and a.store_id = v_store) then
    raise exception 'unknown booking' using errcode = '22023';
  end if;
  begin
    v_bytes := decode(coalesce(p ->> 'data', ''), 'base64');
  exception when others then
    raise exception 'the picture is not valid base64' using errcode = '22023';
  end;
  if octet_length(v_bytes) not between 100 and 262144 or not public.menu_image_magic_ok(coalesce(p ->> 'mime', ''), v_bytes) then
    raise exception 'a picture is a JPEG, PNG or WebP of at most 256 KB' using errcode = '22023';
  end if;
  insert into public.client_photos (org_id, store_id, customer_id, kind, appointment_id, note, consent_at, expires_at, created_by)
  values (s.org_id, v_store, v_cust, p ->> 'kind', nullif(p ->> 'appointment_id', '')::uuid, left(nullif(btrim(coalesce(p ->> 'note', '')), ''), 200),
          now(), now() + interval '12 months', v_staff)
  returning id into v_id;
  insert into public.client_photo_data (photo_id, mime, data) values (v_id, p ->> 'mime', v_bytes);
  perform public.audit_record(s.org_id, v_store, 'settings.change', 'client_photos', v_id::text, jsonb_build_object('saved', true), 'db');
  return v_id;
end $$;

create or replace function public.get_client_photo(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.client_photos%rowtype; d public.client_photo_data%rowtype;
begin
  select * into c from public.client_photos where id = p_id;
  if not found then return null; end if;
  if not public.has_permission(c.org_id, 'customer.view') or not public.can_access_store(c.org_id, c.store_id) then
    raise exception 'client photos need customer.view in this shop' using errcode = '42501';
  end if;
  if c.expires_at <= now() then return null; end if;
  select * into d from public.client_photo_data where photo_id = p_id;
  if not found then return null; end if;
  return jsonb_build_object('mime', d.mime, 'data', encode(d.data, 'base64'));
end $$;

create or replace function public.delete_client_photo(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare c public.client_photos%rowtype;
begin
  select * into c from public.client_photos where id = p_id;
  if not found then return; end if;
  if not (public.has_permission(c.org_id, 'staff.manage') and public.can_access_store(c.org_id, c.store_id)) then
    raise exception 'erasing a client photo needs staff.manage' using errcode = '42501';
  end if;
  delete from public.client_photos where id = p_id;
  perform public.audit_record(c.org_id, c.store_id, 'settings.change', 'client_photos', p_id::text, jsonb_build_object('erased', true), 'db');
end $$;

create or replace function public.client_photos_cleanup() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from public.client_photos where expires_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.add_client_photo(jsonb), public.get_client_photo(uuid), public.delete_client_photo(uuid) from public, anon;
grant execute on function public.add_client_photo(jsonb), public.get_client_photo(uuid), public.delete_client_photo(uuid) to authenticated, service_role;
revoke all on function public.guest_health_form_info(text), public.guest_health_form(text, uuid, text, jsonb), public.client_photos_cleanup() from public, anon, authenticated;
grant execute on function public.guest_health_form_info(text), public.guest_health_form(text, uuid, text, jsonb), public.client_photos_cleanup() to service_role;
