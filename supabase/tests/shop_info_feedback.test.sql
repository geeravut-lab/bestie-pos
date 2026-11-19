-- Guest QR ordering: token is the only key, prices / options are computed by the database, replay-safe, rate-limited.
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

-- text-returning helper: run a query as a user, store its single value
create table t_out (k text primary key, v text);
create or replace function t_val(uid uuid, role_name text, key_ text, q text) returns void language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  perform set_config('request.jwt.claim.role', role_name, true);
  execute format('set local role %I', role_name);
  execute q into r;
  execute 'reset role';
  insert into t_out values (key_, r) on conflict (k) do update set v = excluded.v;
end $$;
grant all on t_out to authenticated, service_role;
grant execute on function t_val(uuid, text, text, text) to authenticated, service_role;



insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@example.test'),
  ('00000000-0000-0000-0000-0000000000d4', 'cashier@example.test'),
  ('00000000-0000-0000-0000-0000000000e5', 'stranger@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Acme Co','Acme','restaurant')$$, 1, 'owner creates a restaurant');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o
  join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Acme Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Acme'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'cafe', $$select public.create_store((select org_id::text from public.stores where name='Acme')::uuid, 'Beach Cafe', 'cafe')::text$$);
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.seed_demo_menu((select v::uuid from t_out where k='store'))$$, 1, 'demo restaurant menu');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.seed_demo_menu((select v::uuid from t_out where k='cafe'))$$, 1, 'demo cafe menu');
select t_val(null, 'service_role', 'tok', $$select qr_token from public.dining_tables where store_id = (select v::uuid from t_out where k='store') and name = 'T1'$$);
select t_val(null, 'service_role', 'tok2', $$select qr_token from public.dining_tables where store_id = (select v::uuid from t_out where k='store') and name = 'T2'$$);
select t_val(null, 'service_role', 'padthai', $$select id::text from public.menu_items where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Pad Thai with prawns'$$);
select t_val(null, 'service_role', 'tomyum', $$select id::text from public.menu_items where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Tom yum goong'$$);
select t_val(null, 'service_role', 'egg', $$select id::text from public.modifier_options where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Fried egg'$$);
select t_val(null, 'service_role', 'mild', $$select id::text from public.modifier_options where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Medium'$$);
select t_val(null, 'service_role', 'hot', $$select id::text from public.modifier_options where store_id = (select v::uuid from t_out where k='store') and name ->> 'en' = 'Very spicy'$$);
select t_val(null, 'service_role', 'latte', $$select id::text from public.menu_items where store_id = (select v::uuid from t_out where k='cafe') and name ->> 'en' = 'Latte'$$);

-- ── nobody but the server can call these ──
select t_err(null, 'anon', $$select public.guest_table('x')$$, '42501', 'anon cannot read a table by token');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.guest_menu((select v from t_out where k='tok'))$$, '42501', 'a signed-in user cannot either');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.guest_place_order('{}'::jsonb)$$, '42501', 'nor place guest orders');

-- ── reading ──
select t_rows(null, 'service_role', $$select 1 where public.guest_table('nope') is null$$, 1, 'unknown token gives nothing');
select t_rows(null, 'service_role', $$select 1 where public.guest_table((select v from t_out where k='tok')) ->> 'table_name' = 'T1'$$, 1, 'a token names its table');
select t_rows(null, 'service_role', $$select 1 where jsonb_array_length(public.guest_menu((select v from t_out where k='tok')) -> 'items') = 13 and jsonb_array_length(public.guest_menu((select v from t_out where k='tok')) -> 'categories') = 4$$, 1, 'the guest sees the restaurant menu: 13 items, 4 categories');

-- ── ordering ──
create or replace function t_order(tok text, cid text, lines text) returns jsonb language sql as $$
  select jsonb_build_object('token', tok, 'client_id', cid, 'lines', lines::jsonb)
$$;
grant execute on function t_order(text, text, text) to service_role;



-- ── shop info ──
create or replace function t_info(store text, th text, body_th text, sort int default 10) returns jsonb language sql as $$
  select jsonb_build_object('store_id', store, 'title', jsonb_build_object('th', th, 'en', th || ' EN'), 'body', jsonb_build_object('th', body_th), 'sort', sort)
$$;
grant execute on function t_info(text, text, text, int) to authenticated, service_role;
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_shop_info(t_info((select v from t_out where k='store'), 'wifi', 'รหัส 12345'))$$, '42501', 'a cashier (no menu.edit) cannot write information cards');
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.save_shop_info(t_info((select v from t_out where k='store'), 'wifi', 'x'))$$, '42501', 'another business cannot');
select t_err(null, 'anon', $$select public.guest_info('x')$$, '42501', 'anon cannot read the guest information');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'i1', $$select public.save_shop_info(t_info((select v from t_out where k='store'), 'wifi', 'รหัสไวไฟ 12345', 20))::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'i2', $$select public.save_shop_info(t_info((select v from t_out where k='store'), 'เวลาเปิด', 'เปิด 8:00-22:00', 10))::text$$);
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_shop_info(jsonb_build_object('store_id', (select v from t_out where k='store'), 'title', '{"th":""}'::jsonb, 'body', '{"th":"x"}'::jsonb))$$, '23514', 'an empty title is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_shop_info(jsonb_build_object('store_id', (select v from t_out where k='store'), 'title', '{"th":"a","fr":"b"}'::jsonb, 'body', '{"th":"x"}'::jsonb))$$, '23514', 'only th / en');
select t_val(null, 'service_role', 'gi', $$select public.guest_info((select v from t_out where k='tok'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='gi' and jsonb_array_length(v::jsonb) = 2 and (v::jsonb -> 0 -> 'title' ->> 'th') = 'เวลาเปิด'$$, 1, 'the guest reads the active cards in the shop''s order');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_shop_info(jsonb_build_object('id', (select v from t_out where k='i1'), 'store_id', (select v from t_out where k='store'), 'title', '{"th":"wifi"}'::jsonb, 'body', '{"th":"x"}'::jsonb, 'active', false))$$, 1, 'a card can be switched off');
select t_val(null, 'service_role', 'gi2', $$select public.guest_info((select v from t_out where k='tok'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='gi2' and jsonb_array_length(v::jsonb) = 1$$, 1, 'a switched-off card is not shown');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.delete_shop_info((select v::uuid from t_out where k='i2'))$$, 1, 'delete a card');
select t_val(null, 'service_role', 'gi3', $$select public.guest_info((select v from t_out where k='tok'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='gi3' and v = '[]'$$, 1, 'a deleted card is gone for the guest');
select t_rows(null, 'service_role', $$select 1 where public.guest_info('nope') is null$$, 1, 'an unknown token gets nothing');

-- ── feedback ──
select t_err(null, 'anon', $$select public.guest_feedback_submit('x', 5, 'food', 'good')$$, '42501', 'anon cannot submit directly');
select t_err(null, 'service_role', $$select public.guest_feedback_submit((select v from t_out where k='tok'), 6, 'food', 'x')$$, '22023', 'rating is 1 to 5');
select t_err(null, 'service_role', $$select public.guest_feedback_submit((select v from t_out where k='tok'), 3, 'weather', 'x')$$, '22023', 'the topic is a closed list');
select t_err(null, 'service_role', $$select public.guest_feedback_submit('nope', 3, 'food', 'x')$$, 'P0002', 'unknown table');
select t_rows(null, 'service_role', $$select public.guest_feedback_submit((select v from t_out where k='tok'), 5, 'food', 'delicious')$$, 1, 'a 5-star comment is stored');
select t_rows(null, 'service_role', $$select 1 from public.app_notifications where kind = 'guest.feedback'$$, 0, 'a good rating tells nobody');
select t_rows(null, 'service_role', $$select public.guest_feedback_submit((select v from t_out where k='tok'), 1, 'service', 'waited 40 minutes')$$, 1, 'a 1-star comment is stored');
select t_rows(null, 'service_role', $$select 1 from public.app_notifications n where n.kind = 'guest.feedback' and n.user_id = '00000000-0000-0000-0000-0000000000a1'$$, 1, 'the owner is told at once about a low rating');
select t_rows(null, 'service_role', $$select 1 from public.app_notifications n where n.kind = 'guest.feedback' and n.user_id = '00000000-0000-0000-0000-0000000000d4'$$, 0, 'a cashier is not');
select t_rows(null, 'service_role', $$select public.guest_feedback_submit((select v from t_out where k='tok'), 4, 'place', null)$$, 1, 'a rating without a comment is fine');
select t_err(null, 'service_role', $$select public.guest_feedback_submit((select v from t_out where k='tok'), 4, 'place', 'again')$$, '53400', 'at most 3 per table per 10 minutes');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.guest_feedback$$, 3, 'the owner reads the feedback');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.guest_feedback$$, 0, 'a cashier (no report.view) cannot');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.guest_feedback$$, 0, 'another business cannot');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.handle_feedback((select id from public.guest_feedback limit 1), true)$$, '42501', 'a cashier cannot mark handled');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.handle_feedback((select id from public.guest_feedback where rating = 1), true)$$, 1, 'the owner marks it handled');
select t_rows(null, 'service_role', $$select 1 from public.guest_feedback where rating = 1 and handled and handled_at is not null$$, 1, 'it stays on record, marked');
do $$ begin raise notice 'ALL INFO AND FEEDBACK TESTS PASSED'; end $$;
