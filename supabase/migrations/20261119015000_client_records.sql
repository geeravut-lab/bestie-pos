-- Bestie POS · migration 60 · client records for salon / spa: service notes (colour formula …) and the health intake form with e-signature.
--
-- NOTES (`client_notes`): a dated note on a member — kind `formula` (hair colour recipe, product used) or `note` (preferences, things to
-- remember). Written by the front desk (`order.create`) through `add_client_note`; read with `customer.view`.
-- HEALTH INTAKE (`health_intakes`): the spa's questionnaire, filled in WITH the guest at the counter: a closed set of yes / no answers
-- (pregnancy, blood pressure, heart, diabetes, skin) plus short free text (allergies, injuries / surgery, medications, other), the guest's
-- explicit consent tick and a typed full name as the electronic signature, with the time. It is health data: it is never edited (a new
-- one replaces it as "latest"), readable only with `customer.view`, and a manager (`staff.manage`) can erase one on the guest's request.
-- Nothing of the content is written to the audit log or any notification. Both need the `appointments` module in the shop that writes them.
-- The consent wording on the screen must be checked by the lawyer before the form is used at a pilot shop.

create or replace function public.health_answers_ok(a jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(a) = 'object'
     and not exists (select 1 from jsonb_object_keys(a) k
                      where k not in ('pregnant', 'high_bp', 'heart', 'diabetes', 'skin', 'allergies', 'injuries', 'medications', 'other'))
     and not exists (select 1 from jsonb_each(a) e
                      where (e.key in ('pregnant', 'high_bp', 'heart', 'diabetes', 'skin') and jsonb_typeof(e.value) <> 'boolean')
                         or (e.key in ('allergies', 'injuries', 'medications', 'other') and (jsonb_typeof(e.value) <> 'string' or length(e.value #>> '{}') > 300)))
$$;

create table public.client_notes (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs (id) on delete cascade,
  store_id       uuid not null references public.stores (id) on delete cascade,
  customer_id    uuid not null references public.customers (id),
  kind           text not null check (kind in ('formula', 'note')),
  title          text not null check (length(btrim(title)) between 1 and 80),
  body           text not null check (length(btrim(body)) between 1 and 2000),
  appointment_id uuid references public.appointments (id) on delete set null,
  created_by     uuid references public.staff (id) on delete set null,
  created_at     timestamptz not null default now()
);
create index client_notes_customer_idx on public.client_notes (customer_id, created_at desc);

create table public.health_intakes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs (id) on delete cascade,
  store_id    uuid not null references public.stores (id) on delete cascade,
  customer_id uuid not null references public.customers (id),
  answers     jsonb not null check (public.health_answers_ok(answers)),
  consent     boolean not null check (consent),
  signed_name text not null check (length(btrim(signed_name)) between 2 and 80),
  signed_at   timestamptz not null default now(),
  created_by  uuid references public.staff (id) on delete set null
);
create index health_intakes_customer_idx on public.health_intakes (customer_id, signed_at desc);

alter table public.client_notes enable row level security;
alter table public.health_intakes enable row level security;
create policy client_notes_read on public.client_notes for select to authenticated using (public.has_permission(org_id, 'customer.view'));
create policy health_intakes_read on public.health_intakes for select to authenticated using (public.has_permission(org_id, 'customer.view'));
revoke all on public.client_notes, public.health_intakes from anon, authenticated;
grant select on public.client_notes, public.health_intakes to authenticated;   -- writes: the functions below

create or replace function public.client_record_guard(p_store uuid, p_customer uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.stores%rowtype; v_staff uuid;
begin
  select * into s from public.stores where id = p_store and deleted_at is null;
  if not found or not public.can_access_store(s.org_id, s.id) or not public.has_permission(s.org_id, 'order.create') then
    raise exception 'client records need order.create in this shop' using errcode = '42501';
  end if;
  if not public.appointments_enabled(p_store) then raise exception 'the appointments module is off in this shop' using errcode = '0A000'; end if;
  if not exists (select 1 from public.customers c where c.id = p_customer and c.org_id = s.org_id and c.deleted_at is null) then
    raise exception 'unknown member' using errcode = '22023';
  end if;
  select x.id into v_staff from public.staff x where x.org_id = s.org_id and x.user_id = auth.uid() and x.active limit 1;
  return v_staff;
end $$;
revoke all on function public.client_record_guard(uuid, uuid) from public, anon, authenticated;

-- p = { store_id, customer_id, kind: 'formula' | 'note', title, body, appointment_id? }
create or replace function public.add_client_note(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_store uuid := (p ->> 'store_id')::uuid;
  v_cust uuid := (p ->> 'customer_id')::uuid;
  v_staff uuid;
  v_id uuid;
  s public.stores%rowtype;
begin
  v_staff := public.client_record_guard(v_store, v_cust);
  select * into s from public.stores where id = v_store;
  if coalesce(p ->> 'kind', '') not in ('formula', 'note') then raise exception 'unknown kind' using errcode = '22023'; end if;
  if nullif(p ->> 'appointment_id', '') is not null
     and not exists (select 1 from public.appointments a where a.id = (p ->> 'appointment_id')::uuid and a.store_id = v_store) then
    raise exception 'unknown booking' using errcode = '22023';
  end if;
  insert into public.client_notes (org_id, store_id, customer_id, kind, title, body, appointment_id, created_by)
  values (s.org_id, v_store, v_cust, p ->> 'kind', btrim(coalesce(p ->> 'title', '')), btrim(coalesce(p ->> 'body', '')),
          nullif(p ->> 'appointment_id', '')::uuid, v_staff)
  returning id into v_id;
  return v_id;
end $$;

-- p = { store_id, customer_id, answers, consent, signed_name }
create or replace function public.save_health_intake(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_store uuid := (p ->> 'store_id')::uuid;
  v_cust uuid := (p ->> 'customer_id')::uuid;
  v_staff uuid;
  v_id uuid;
  s public.stores%rowtype;
begin
  v_staff := public.client_record_guard(v_store, v_cust);
  select * into s from public.stores where id = v_store;
  if coalesce((p ->> 'consent')::boolean, false) is not true then raise exception 'the guest must agree first' using errcode = '22023'; end if;
  if not public.health_answers_ok(coalesce(p -> 'answers', 'null'::jsonb)) then raise exception 'the answers are not valid' using errcode = '22023'; end if;
  insert into public.health_intakes (org_id, store_id, customer_id, answers, consent, signed_name, created_by)
  values (s.org_id, v_store, v_cust, p -> 'answers', true, btrim(coalesce(p ->> 'signed_name', '')), v_staff)
  returning id into v_id;
  perform public.audit_record(s.org_id, v_store, 'settings.change', 'health_intakes', v_id::text, jsonb_build_object('saved', true), 'db');   -- no content
  return v_id;
end $$;

-- a mistaken note, or a form erased on the guest's request: managers only
create or replace function public.delete_client_record(p_kind text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_store uuid;
begin
  if p_kind = 'note' then select org_id, store_id into v_org, v_store from public.client_notes where id = p_id;
  elsif p_kind = 'health' then select org_id, store_id into v_org, v_store from public.health_intakes where id = p_id;
  else raise exception 'unknown kind' using errcode = '22023'; end if;
  if v_org is null then return; end if;
  if not (public.has_permission(v_org, 'staff.manage') and public.can_access_store(v_org, v_store)) then
    raise exception 'erasing a client record needs staff.manage' using errcode = '42501';
  end if;
  if p_kind = 'note' then delete from public.client_notes where id = p_id; else delete from public.health_intakes where id = p_id; end if;
  perform public.audit_record(v_org, v_store, 'settings.change', 'client_records', p_id::text, jsonb_build_object('erased', p_kind), 'db');
end $$;

revoke all on function public.add_client_note(jsonb), public.save_health_intake(jsonb), public.delete_client_record(text, uuid) from public, anon;
grant execute on function public.add_client_note(jsonb), public.save_health_intake(jsonb), public.delete_client_record(text, uuid) to authenticated, service_role;
