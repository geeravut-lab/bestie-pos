-- Bestie POS · migration 61 · hair-style advisor for salons: a catalogue, the guest's answers, and an optional photo.
--
--  * CATALOGUE (`hair_styles`): the shop's own list of styles (name, a short description, and which hair lengths / textures / face
--    shapes it suits, plus how much upkeep it needs). Written with `menu.edit` through `save_hair_style` / `delete_hair_style`.
--  * REQUEST (`hair_requests`): after booking online the guest may answer four closed questions (hair length, texture, face shape,
--    upkeep) and pick a style; the stylist sees it on the booking. The ADVICE (which styles suit those answers) is plain code in the
--    page — no AI reads anything, and no photo ever goes to an AI provider.
--  * PHOTO (`hair_request_photos`): optional; ONLY with an explicit consent tick; for that ONE booking; JPEG / PNG / WebP up to 256 KB;
--    accepted only when the booking starts within 48 hours; the stylist can look at it (`get_hair_photo`); it is DELETED automatically
--    23 hours after the booking ends (hourly clean-up), at once if the booking is cancelled or a no-show, and the guest can remove it.
--    The table has no grant: nothing but the functions below reads it.
-- The guest proves the booking with its code (as for cancelling and the e-mail reminder). All guest functions are service-role only.
-- The consent wording must be checked by the lawyer before the photo is switched on at a pilot shop.

create table public.hair_styles (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete cascade,
  store_id   uuid not null references public.stores (id) on delete cascade,
  name       jsonb not null check (jsonb_typeof(name) = 'object' and length(btrim(coalesce(name ->> 'th', ''))) between 1 and 80),
  about      jsonb check (about is null or (jsonb_typeof(about) = 'object' and length(coalesce(about ->> 'th', '')) <= 200 and length(coalesce(about ->> 'en', '')) <= 200)),
  lengths    text[] not null default '{}' check (lengths <@ array['short', 'medium', 'long']),
  textures   text[] not null default '{}' check (textures <@ array['straight', 'wavy', 'curly']),
  faces      text[] not null default '{}' check (faces <@ array['oval', 'round', 'square', 'heart']),
  upkeep     text check (upkeep is null or upkeep in ('low', 'medium', 'high')),
  active     boolean not null default true,
  sort       integer not null default 0,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index hair_styles_store_idx on public.hair_styles (store_id, sort) where deleted_at is null;

create table public.hair_requests (
  appointment_id   uuid primary key references public.appointments (id) on delete cascade,
  org_id           uuid not null references public.orgs (id) on delete cascade,
  store_id         uuid not null references public.stores (id) on delete cascade,
  style_id         uuid references public.hair_styles (id) on delete set null,
  answers          jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'),
  photo_consent_at timestamptz,
  photo_expires_at timestamptz,
  updated_at       timestamptz not null default now()
);
create table public.hair_request_photos (
  appointment_id uuid primary key references public.hair_requests (appointment_id) on delete cascade,
  mime           text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  data           bytea not null check (octet_length(data) between 100 and 262144)
);

alter table public.hair_styles enable row level security;
alter table public.hair_requests enable row level security;
alter table public.hair_request_photos enable row level security;
create policy hair_styles_read on public.hair_styles for select to authenticated using (public.can_access_store(org_id, store_id));
create policy hair_requests_read on public.hair_requests for select to authenticated using (public.can_access_store(org_id, store_id));
revoke all on public.hair_styles, public.hair_requests, public.hair_request_photos from anon, authenticated;
grant select on public.hair_styles, public.hair_requests to authenticated;
create trigger hair_requests_live after insert or update on public.hair_requests for each row execute function public.live_ping_row('store:{store_id}');

-- p = { id?, store_id, name:{th,en?}, about?:{th?,en?}, lengths?, textures?, faces?, upkeep?, active?, sort? }
create or replace function public.save_hair_style(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_store uuid := (p ->> 'store_id')::uuid;
  s public.stores%rowtype;
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_len text[]; v_tex text[]; v_face text[];
begin
  select * into s from public.stores where id = v_store and deleted_at is null;
  if not found or not public.can_edit_menu(v_store) then
    raise exception 'the style list needs menu.edit in this shop' using errcode = '42501';
  end if;
  if not public.appointments_enabled(v_store) then raise exception 'the appointments module is off in this shop' using errcode = '0A000'; end if;
  select coalesce(array_agg(x), '{}') into v_len from jsonb_array_elements_text(coalesce(p -> 'lengths', '[]'::jsonb)) x;
  select coalesce(array_agg(x), '{}') into v_tex from jsonb_array_elements_text(coalesce(p -> 'textures', '[]'::jsonb)) x;
  select coalesce(array_agg(x), '{}') into v_face from jsonb_array_elements_text(coalesce(p -> 'faces', '[]'::jsonb)) x;
  if v_id is null then
    insert into public.hair_styles (org_id, store_id, name, about, lengths, textures, faces, upkeep, active, sort)
    values (s.org_id, v_store, p -> 'name', p -> 'about', v_len, v_tex, v_face, nullif(p ->> 'upkeep', ''),
            coalesce((p ->> 'active')::boolean, true), coalesce((p ->> 'sort')::integer, 0))
    returning id into v_id;
  else
    update public.hair_styles set name = p -> 'name', about = p -> 'about', lengths = v_len, textures = v_tex, faces = v_face,
           upkeep = nullif(p ->> 'upkeep', ''), active = coalesce((p ->> 'active')::boolean, true), sort = coalesce((p ->> 'sort')::integer, sort)
     where id = v_id and store_id = v_store and deleted_at is null;
    if not found then raise exception 'unknown style' using errcode = '22023'; end if;
  end if;
  perform public.audit_record(s.org_id, v_store, 'settings.change', 'hair_styles', v_id::text, jsonb_build_object('saved', true), 'db');
  return v_id;
end $$;

create or replace function public.delete_hair_style(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare h public.hair_styles%rowtype;
begin
  select * into h from public.hair_styles where id = p_id and deleted_at is null;
  if not found then return; end if;
  if not public.can_edit_menu(h.store_id) then raise exception 'the style list needs menu.edit in this shop' using errcode = '42501'; end if;
  update public.hair_styles set deleted_at = now(), active = false where id = p_id;
end $$;

-- ── the guest ──
create or replace function public.guest_hair_styles(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype;
begin
  s := public.booking_store(p_token);
  if s.id is null then return null; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'name', h.name, 'about', h.about, 'lengths', h.lengths,
            'textures', h.textures, 'faces', h.faces, 'upkeep', h.upkeep) order by h.sort, h.created_at)
          from public.hair_styles h where h.store_id = s.id and h.active and h.deleted_at is null), '[]'::jsonb);
end $$;

-- p = { style_id?, answers?: {length?, texture?, face?, upkeep?}, photo?: { consent, mime, data (base64) }, remove_photo? }
create or replace function public.guest_hair_request(p_token text, p_id uuid, p_code text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.stores%rowtype;
  a public.appointments%rowtype;
  v_style uuid := nullif(p ->> 'style_id', '')::uuid;
  v_ans jsonb := coalesce(p -> 'answers', '{}'::jsonb);
  v_clean jsonb := '{}'::jsonb;
  v_bytes bytea;
  v_mime text := p #>> '{photo,mime}';
  k text;
  v_has_photo boolean;
begin
  s := public.booking_store(p_token);
  if s.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select * into a from public.appointments where id = p_id and store_id = s.id and source = 'online' for update;
  if not found or a.cancel_hash is null or a.cancel_hash <> encode(sha256(convert_to(upper(btrim(coalesce(p_code, ''))), 'utf8')), 'hex') then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if a.status not in ('booked', 'confirmed') or a.starts_at <= now() then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  if v_style is not null and not exists (select 1 from public.hair_styles h where h.id = v_style and h.store_id = s.id and h.active and h.deleted_at is null) then
    return jsonb_build_object('ok', false, 'error', 'bad_style');
  end if;
  if jsonb_typeof(v_ans) <> 'object' then return jsonb_build_object('ok', false, 'error', 'bad_answers'); end if;
  for k in select jsonb_object_keys(v_ans) loop
    if not ((k = 'length' and v_ans ->> k in ('short', 'medium', 'long', 'any'))
         or (k = 'texture' and v_ans ->> k in ('straight', 'wavy', 'curly', 'any'))
         or (k = 'face' and v_ans ->> k in ('oval', 'round', 'square', 'heart', 'unknown'))
         or (k = 'upkeep' and v_ans ->> k in ('low', 'medium', 'high', 'any'))) then
      return jsonb_build_object('ok', false, 'error', 'bad_answers');
    end if;
    v_clean := v_clean || jsonb_build_object(k, v_ans ->> k);
  end loop;
  insert into public.hair_requests (appointment_id, org_id, store_id, style_id, answers)
  values (a.id, a.org_id, a.store_id, v_style, v_clean)
  on conflict (appointment_id) do update set style_id = excluded.style_id, answers = excluded.answers, updated_at = now();

  if coalesce((p ->> 'remove_photo')::boolean, false) then
    delete from public.hair_request_photos where appointment_id = a.id;
    update public.hair_requests set photo_consent_at = null, photo_expires_at = null where appointment_id = a.id;
  end if;
  if p ? 'photo' and jsonb_typeof(p -> 'photo') = 'object' then
    if coalesce((p #>> '{photo,consent}')::boolean, false) is not true then
      return jsonb_build_object('ok', false, 'error', 'consent_needed');
    end if;
    if a.starts_at > now() + interval '48 hours' then return jsonb_build_object('ok', false, 'error', 'photo_too_early'); end if;
    begin
      v_bytes := decode(coalesce(p #>> '{photo,data}', ''), 'base64');
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'bad_photo');
    end;
    if octet_length(v_bytes) not between 100 and 262144 or not public.menu_image_magic_ok(coalesce(v_mime, ''), v_bytes) then
      return jsonb_build_object('ok', false, 'error', 'bad_photo');
    end if;
    insert into public.hair_request_photos (appointment_id, mime, data) values (a.id, v_mime, v_bytes)
    on conflict (appointment_id) do update set mime = excluded.mime, data = excluded.data;
    update public.hair_requests set photo_consent_at = now(), photo_expires_at = a.ends_at + interval '23 hours' where appointment_id = a.id;
  end if;
  select exists (select 1 from public.hair_request_photos where appointment_id = a.id) into v_has_photo;
  return jsonb_build_object('ok', true, 'photo', v_has_photo);
end $$;

-- the stylist looks at the photo of a booking (front desk, same shop)
create or replace function public.get_hair_photo(p_appointment uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.hair_requests%rowtype; ph public.hair_request_photos%rowtype;
begin
  select * into r from public.hair_requests where appointment_id = p_appointment;
  if not found then return null; end if;
  if not (public.can_access_store(r.org_id, r.store_id) and public.has_permission(r.org_id, 'order.create')) then
    raise exception 'photos are for the front desk of this shop' using errcode = '42501';
  end if;
  if r.photo_expires_at is null or r.photo_expires_at <= now() then return null; end if;
  select * into ph from public.hair_request_photos where appointment_id = p_appointment;
  if not found then return null; end if;
  return jsonb_build_object('mime', ph.mime, 'data', encode(ph.data, 'base64'));
end $$;

-- hourly: photos past their time, or of a cancelled / no-show booking, are erased
create or replace function public.hair_photos_cleanup() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  with gone as (
    delete from public.hair_request_photos ph using public.hair_requests r, public.appointments a
     where r.appointment_id = ph.appointment_id and a.id = r.appointment_id
       and (r.photo_expires_at is null or r.photo_expires_at <= now() or a.status in ('cancelled', 'no_show'))
    returning ph.appointment_id)
  select count(*) into n from gone;
  update public.hair_requests r set photo_consent_at = null, photo_expires_at = null
   where r.photo_expires_at is not null and not exists (select 1 from public.hair_request_photos ph where ph.appointment_id = r.appointment_id);
  return n;
end $$;

revoke all on function public.save_hair_style(jsonb), public.delete_hair_style(uuid), public.get_hair_photo(uuid) from public, anon;
grant execute on function public.save_hair_style(jsonb), public.delete_hair_style(uuid), public.get_hair_photo(uuid) to authenticated, service_role;
revoke all on function public.guest_hair_styles(text), public.guest_hair_request(text, uuid, text, jsonb), public.hair_photos_cleanup() from public, anon, authenticated;
grant execute on function public.guest_hair_styles(text), public.guest_hair_request(text, uuid, text, jsonb), public.hair_photos_cleanup() to service_role;
