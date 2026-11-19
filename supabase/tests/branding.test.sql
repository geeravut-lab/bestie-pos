-- Branding: only platform admins write brand + files; the brand JSON shape is guarded.
\set ON_ERROR_STOP on
\set QUIET on

create or replace function t_exec(uid uuid, role_name text, q text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  perform set_config('request.jwt.claim.role', role_name, true);
  execute format('set local role %I', role_name);
  execute q;
  get diagnostics n = row_count;
  execute 'reset role';
  return n;
end $$;
create or replace function t_rows(uid uuid, role_name text, q text, expected bigint, label text) returns void language plpgsql as $$
declare n bigint;
begin
  n := t_exec(uid, role_name, q);
  if n is distinct from expected then raise exception 'FAIL % — expected % rows, got %', label, expected, n; end if;
  raise notice 'PASS %', label;
end $$;
create or replace function t_err(uid uuid, role_name text, q text, state text, label text) returns void language plpgsql as $$
begin
  begin
    perform t_exec(uid, role_name, q);
  exception when others then
    if sqlstate = state then raise notice 'PASS %', label; return; end if;
    raise exception 'FAIL % — expected SQLSTATE %, got % (%)', label, state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL % — expected an error (%), none raised', label, state;
end $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'owner@example.test');
insert into public.platform_admins (user_id) values ('00000000-0000-0000-0000-0000000000a1');

select t_rows(null, 'service_role', $$select 1 from storage.buckets where id = 'brand-assets' and public = false and 'image/svg+xml' <> all (allowed_mime_types)$$, 1, 'bucket is private and does not accept SVG');

-- files
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$insert into storage.objects (bucket_id, name) values ('brand-assets', 'logo-1.png')$$, 1, 'platform admin can upload a brand file');
select t_err('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$insert into storage.objects (bucket_id, name) values ('brand-assets', 'logo-2.png')$$, '42501', 'a shop owner cannot upload brand files');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$select 1 from storage.objects where bucket_id = 'brand-assets'$$, 0, 'a shop owner cannot list brand files');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$delete from storage.objects where name = 'logo-1.png'$$, 1, 'platform admin can delete the old file');

-- brand JSON
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.platform_settings set brand = '{"name_th":"ร้านเพื่อนซี้","name_en":"Bestie","logo":{"mime":"image/png","version":1761234567890}}'$$, 1, 'admin saves a valid brand');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$update public.platform_settings set brand = '{"name_en":"Hacked"}'$$, 0, 'a shop owner cannot change the brand');
select t_rows(null, 'anon', $$select 1 from public.platform_settings where brand ->> 'name_en' = 'Bestie'$$, 1, 'the brand is readable before sign-in (login page)');
select t_err(null, 'service_role', $$update public.platform_settings set brand = '{"evil":"x"}'$$, '23514', 'unknown brand keys are refused');
select t_err(null, 'service_role', $$update public.platform_settings set brand = '{"name_en":"<script>"}'$$, '23514', 'names cannot contain < or >');
select t_err(null, 'service_role', $$update public.platform_settings set brand = ('{"name_en":"' || repeat('x', 41) || '"}')::jsonb$$, '23514', 'names are at most 40 characters');
select t_err(null, 'service_role', $$update public.platform_settings set brand = '{"name_en":""}'$$, '23514', 'names cannot be empty');
select t_err(null, 'service_role', $$update public.platform_settings set brand = '{"logo":{"mime":"image/svg+xml","version":1}}'$$, '23514', 'SVG images are refused');
select t_err(null, 'service_role', $$update public.platform_settings set brand = '{"favicon":{"mime":"image/png","version":"x"}}'$$, '23514', 'image version must be a number');
select t_rows(null, 'service_role', $$update public.platform_settings set brand = '{}'$$, 1, 'restoring defaults = empty brand');

-- ── home card pictures ──
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$update public.platform_settings set card_images = '{"sell":{"mime":"image/png","version":1761234567890}}'$$, 1, 'the admin points a card at an uploaded picture');
select t_rows('00000000-0000-0000-0000-0000000000b2', 'authenticated', $$update public.platform_settings set card_images = '{}'$$, 0, 'a shop owner cannot change the card pictures');
select t_rows(null, 'anon', $$select 1 from public.platform_settings where card_images ? 'sell'$$, 1, 'the pictures are readable like the brand');
select t_err(null, 'service_role', $$update public.platform_settings set card_images = '{"sell":{"mime":"image/svg+xml","version":1}}'$$, '23514', 'SVG is refused (it can carry script)');
select t_err(null, 'service_role', $$update public.platform_settings set card_images = '{"s e l l":{"mime":"image/png","version":1}}'$$, '23514', 'a card id must be plain letters');
select t_err(null, 'service_role', $$update public.platform_settings set card_images = '{"sell":{"mime":"image/png","version":"x"}}'$$, '23514', 'the version must be a number');
select t_err(null, 'service_role', $$update public.platform_settings set card_images = '{"sell":{"mime":"image/png","version":1,"url":"https://evil"}}'$$, '23514', 'no extra fields (no URLs) can be smuggled in');
select t_rows(null, 'service_role', $$update public.platform_settings set card_images = '{}'$$, 1, 'restoring the built-in pictures = empty');
\echo ALL BRANDING TESTS PASSED
