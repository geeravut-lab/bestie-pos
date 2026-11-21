-- Bestie POS · migration 71 · AI reads a hair photo (owner order 2026-11-21: separate consent, off by default, a vision model).
--
--  * Module `ai.hair` (off for every profile, Pro and up, needs online booking). Without it nothing below can run.
--  * A SEPARATE consent: the guest ticks it AFTER the photo is saved (`guest_hair_ai_consent`); it belongs to that photo only (a new photo, or removing the photo, clears it).
--  * The photo goes to the AI provider ONCE per press of "Let AI read my hair", through `guest_hair_ai_input` (booking code + module + consent + a photo that has not expired).
--  * What comes back is closed labels only (length, texture, thickness, coloured, condition), checked by `hair_labels_ok` and kept in `hair_request_photos.ai_labels`:
--    it is erased with the photo (same table, same hourly clean-up). No text from a model is ever stored or shown.

do $$
declare r record; src text; dst text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'stores_check_modules' loop
    src := pg_get_functiondef(r.oid);
    dst := replace(src, $a$'karaoke.songs'];$a$, $a$'karaoke.songs','ai.hair'];$a$);
    if dst = src then raise exception 'migration 71: stores_check_modules not changed'; end if;
    execute dst;
  end loop;
end $$;

create or replace function public.hair_ai_enabled(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.booking_online_enabled(p_store) and exists (
    select 1 from public.stores s
     where s.id = p_store and s.plan in ('pro', 'resort') and coalesce((s.module_overrides ->> 'ai.hair')::boolean, false))
$$;
revoke all on function public.hair_ai_enabled(uuid) from public, anon;
grant execute on function public.hair_ai_enabled(uuid) to authenticated, service_role;

alter table public.hair_request_photos
  add column ai_consent_at timestamptz,
  add column ai_labels jsonb;

create or replace function public.hair_labels_ok(j jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select j is null or (
    jsonb_typeof(j) = 'object'
    and not exists (select 1 from jsonb_object_keys(j) k where k not in ('length', 'texture', 'thickness', 'colored', 'condition'))
    and (j ->> 'length' is null or j ->> 'length' in ('short', 'medium', 'long'))
    and (j ->> 'texture' is null or j ->> 'texture' in ('straight', 'wavy', 'curly'))
    and (j ->> 'thickness' is null or j ->> 'thickness' in ('fine', 'medium', 'thick'))
    and (j ->> 'colored' is null or j ->> 'colored' in ('true', 'false'))
    and (j ->> 'condition' is null or j ->> 'condition' in ('healthy', 'dry_damaged')))
$$;
alter table public.hair_request_photos add constraint hair_ai_labels_closed check (public.hair_labels_ok(ai_labels));

-- a replaced picture is a different picture: the AI consent and what the AI said about the old one do not carry over
create or replace function public.hair_photo_reset_ai() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.data is distinct from old.data then new.ai_consent_at := null; new.ai_labels := null; end if;
  return new;
end $$;
create trigger hair_photo_reset_ai before update on public.hair_request_photos for each row execute function public.hair_photo_reset_ai();

-- the booking behind a code, with a live (unexpired) photo; null when anything is off
create or replace function public.hair_ai_target(p_token text, p_id uuid, p_code text) returns public.appointments
language plpgsql stable security definer set search_path = '' as $$
declare s public.stores%rowtype; a public.appointments%rowtype;
begin
  s := public.booking_store(p_token);
  if s.id is null or not public.hair_ai_enabled(s.id) then return null; end if;
  select * into a from public.appointments where id = p_id and store_id = s.id and source = 'online';
  if not found or a.cancel_hash is null or a.cancel_hash <> encode(sha256(convert_to(upper(btrim(coalesce(p_code, ''))), 'utf8')), 'hex') then return null; end if;
  if a.status not in ('booked', 'confirmed') or a.starts_at <= now() then return null; end if;
  if not exists (select 1 from public.hair_requests r join public.hair_request_photos ph on ph.appointment_id = r.appointment_id
                  where r.appointment_id = a.id and r.photo_expires_at > now()) then return null; end if;
  return a;
end $$;
revoke all on function public.hair_ai_target(text, uuid, text) from public, anon, authenticated;
grant execute on function public.hair_ai_target(text, uuid, text) to service_role;

-- give (p_on = true) or withdraw the AI consent for this photo; withdrawing also erases what the AI said
create or replace function public.guest_hair_ai_consent(p_token text, p_id uuid, p_code text, p_on boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.appointments%rowtype;
begin
  a := public.hair_ai_target(p_token, p_id, p_code);
  if a.id is null then return jsonb_build_object('ok', false, 'error', 'unavailable'); end if;
  update public.hair_request_photos
     set ai_consent_at = case when p_on then now() else null end, ai_labels = case when p_on then ai_labels else null end
   where appointment_id = a.id;
  return jsonb_build_object('ok', true, 'consent', coalesce(p_on, false));
end $$;

-- the photo for the AI call: only with the consent of THIS photo
create or replace function public.guest_hair_ai_input(p_token text, p_id uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.appointments%rowtype; ph public.hair_request_photos%rowtype;
begin
  a := public.hair_ai_target(p_token, p_id, p_code);
  if a.id is null then return jsonb_build_object('ok', false, 'error', 'unavailable'); end if;
  select * into ph from public.hair_request_photos where appointment_id = a.id;
  if ph.ai_consent_at is null then return jsonb_build_object('ok', false, 'error', 'consent_needed'); end if;
  return jsonb_build_object('ok', true, 'store_id', a.store_id, 'mime', ph.mime, 'data', encode(ph.data, 'base64'));
end $$;

-- keep what the AI read (closed labels only); refused when the consent was withdrawn meanwhile
create or replace function public.guest_hair_ai_save(p_token text, p_id uuid, p_code text, p_labels jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.appointments%rowtype; n integer;
begin
  a := public.hair_ai_target(p_token, p_id, p_code);
  if a.id is null then return jsonb_build_object('ok', false, 'error', 'unavailable'); end if;
  if not public.hair_labels_ok(p_labels) or p_labels is null then return jsonb_build_object('ok', false, 'error', 'bad_labels'); end if;
  update public.hair_request_photos set ai_labels = p_labels where appointment_id = a.id and ai_consent_at is not null;
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('ok', false, 'error', 'consent_needed'); end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.guest_hair_ai_consent(text, uuid, text, boolean), public.guest_hair_ai_input(text, uuid, text), public.guest_hair_ai_save(text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.guest_hair_ai_consent(text, uuid, text, boolean), public.guest_hair_ai_input(text, uuid, text), public.guest_hair_ai_save(text, uuid, text, jsonb) to service_role;

-- the page learns whether to offer the AI step, and whether it already read this photo
create or replace function public.guest_hair_ai_state(p_token text, p_id uuid, p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.appointments%rowtype; ph public.hair_request_photos%rowtype;
begin
  a := public.hair_ai_target(p_token, p_id, p_code);
  if a.id is null then return jsonb_build_object('enabled', false); end if;
  select * into ph from public.hair_request_photos where appointment_id = a.id;
  return jsonb_build_object('enabled', true, 'consent', ph.ai_consent_at is not null, 'labels', ph.ai_labels);
end $$;
revoke all on function public.guest_hair_ai_state(text, uuid, text) from public, anon, authenticated;
grant execute on function public.guest_hair_ai_state(text, uuid, text) to service_role;

-- the stylist also sees what the AI read (labels only)
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
  return jsonb_build_object('mime', ph.mime, 'data', encode(ph.data, 'base64'), 'ai_labels', ph.ai_labels);
end $$;
