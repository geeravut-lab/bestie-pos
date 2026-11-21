-- Karaoke online booking by guests: the link, free times, the booking, limits, the deposit, release of unpaid bookings, deposits on the room's bill.
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
  ('00000000-0000-0000-0000-0000000000e5', 'other@example.test');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select * from public.create_org('Sing Co','Sing Along','karaoke')$$, 1, 'owner creates a karaoke shop');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select * from public.create_org('Other Co','Other','cafe')$$, 1, 'another business exists');
insert into public.staff (org_id, user_id, display_name, role_id)
select o.id, '00000000-0000-0000-0000-0000000000d4', 'Cashier', r.id from public.orgs o join public.roles r on r.org_id = o.id and r.built_in = 'cashier' where o.name = 'Sing Co';
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'store', $$select id::text from public.stores where name = 'Sing Along'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'org', $$select org_id::text from public.stores where name = 'Sing Along'$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'room', $$select public.save_karaoke_room(jsonb_build_object('store_id', (select v from t_out where k='store'), 'name', 'VIP 1', 'rate_per_hour', 30000, 'min_minutes', 60, 'step_minutes', 15))::text$$);
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'dev', $$insert into public.devices (org_id, store_id, name, role, revenue_pos_id) values ((select v::uuid from t_out where k='org'), (select v::uuid from t_out where k='store'), 'Desk', 'cashier', 'POS-K') returning id::text$$);

-- ── the module and the link ──
select t_rows(null, 'service_role', $$select 1 where not public.karaoke_booking_enabled((select v::uuid from t_out where k='store'))$$, 1, 'the module is off by default');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.save_karaoke_booking_settings((select v::uuid from t_out where k='store'), '{}'::jsonb)$$, '42501', 'a cashier cannot set up online booking');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'cfg', $$select public.save_karaoke_booking_settings((select v::uuid from t_out where k='store'), '{"deposit_pct":30,"hold_min":120,"pay_note":"PromptPay 0812345678"}'::jsonb)::text$$);
select t_val(null, 'service_role', 'tok', $$select v::jsonb ->> 'token' from t_out where k='cfg'$$);
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_karaoke_booking_settings((select v::uuid from t_out where k='store'), '{"deposit_pct":101}'::jsonb)$$, '22023', 'a deposit above 100 percent is refused');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.save_karaoke_booking_settings((select v::uuid from t_out where k='store'), '{"open":"23:00","close":"12:00"}'::jsonb)$$, '22023', 'opening must be before the last start');
select t_val(null, 'service_role', 'i0', $$select public.guest_karaoke_booking_info((select v from t_out where k='tok'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='i0' and (v::jsonb ->> 'open') = 'false'$$, 1, 'the page says closed while the module is off');
update public.stores set plan = 'pro', module_overrides = module_overrides || '{"karaoke.booking": true}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_rows(null, 'service_role', $$select 1 where public.karaoke_booking_enabled((select v::uuid from t_out where k='store'))$$, 1, 'on the Pro plan the module can be switched on');
select t_val(null, 'service_role', 'i1', $$select public.guest_karaoke_booking_info((select v from t_out where k='tok'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='i1' and (v::jsonb ->> 'open') = 'true' and jsonb_array_length(v::jsonb -> 'rooms') = 1 and (v::jsonb #> '{rooms,0,lengths}') @> '60'::jsonb and not ((v::jsonb #> '{rooms,0,lengths}') @> '45'::jsonb)$$, 1, 'the page lists the room and its lengths (none under the shortest time)');
select t_rows(null, 'service_role', $$select 1 where public.guest_karaoke_booking_info(repeat('0', 32)) is null$$, 1, 'an unknown link finds nothing');
select t_err(null, 'authenticated', $$select public.guest_karaoke_book('x', '{}'::jsonb)$$, '42501', 'the browser cannot call the guest functions');

-- ── free times ──
create or replace function t_day(plus int) returns text language sql as $$ select ((now() at time zone 'Asia/Bangkok')::date + plus)::text $$;
grant execute on function t_day(int) to authenticated, service_role;
select t_val(null, 'service_role', 'sl', $$select public.guest_karaoke_booking_slots((select v from t_out where k='tok'), (select v::uuid from t_out where k='room'), t_day(2)::date, 120)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='sl' and v::jsonb @> '"12:00"'::jsonb and v::jsonb @> '"23:00"'::jsonb and jsonb_array_length(v::jsonb) = 23$$, 1, 'two days ahead every half hour from 12:00 to 23:00 is free');
select t_rows(null, 'service_role', $$select 1 where public.guest_karaoke_booking_slots((select v from t_out where k='tok'), (select v::uuid from t_out where k='room'), t_day(2)::date, 45) = '[]'::jsonb$$, 1, 'a length the room does not offer has no times');
select t_rows(null, 'service_role', $$select 1 where public.guest_karaoke_booking_slots((select v from t_out where k='tok'), (select v::uuid from t_out where k='room'), t_day(-1)::date, 60) = '[]'::jsonb and public.guest_karaoke_booking_slots((select v from t_out where k='tok'), (select v::uuid from t_out where k='room'), t_day(90)::date, 60) = '[]'::jsonb$$, 1, 'yesterday and too far ahead have no times');

-- ── booking ──
create or replace function t_gb(tm text, mins int, who text, cid text, ph text default '0811111111') returns text language sql as $$
  select jsonb_build_object('room_id', (select v from t_out where k='room'), 'date', t_day(2), 'time', tm, 'minutes', mins, 'name', who, 'phone', ph, 'guests', 5, 'client_id', cid)::text $$;
grant execute on function t_gb(text, int, text, text, text) to authenticated, service_role;
select t_val(null, 'service_role', 'g1', $$select public.guest_karaoke_book((select v from t_out where k='tok'), t_gb('20:00', 120, 'Anna', '11111111-1111-1111-1111-111111111111')::jsonb)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='g1' and (v::jsonb ->> 'ok') = 'true' and length(v::jsonb ->> 'code') = 8 and (v::jsonb ->> 'price') = '60000' and (v::jsonb ->> 'deposit_due') = '18000' and (v::jsonb ->> 'hold_until') is not null$$, 1, 'booked: price 600 baht for 2 hours, deposit 30 percent = 180 baht, held until paid');
select t_val(null, 'service_role', 'g1id', $$select v::jsonb ->> 'id' from t_out where k='g1'$$);
select t_val(null, 'service_role', 'g1code', $$select v::jsonb ->> 'code' from t_out where k='g1'$$);
select t_rows(null, 'service_role', $$select 1 from public.karaoke_bookings where id = (select v::uuid from t_out where k='g1id') and source = 'online' and status = 'booked' and cancel_hash is not null and cancel_hash <> (select v from t_out where k='g1code') and guests = 5$$, 1, 'stored as an online booking, only the hash of the code is kept');
select t_val(null, 'service_role', 'g1b', $$select public.guest_karaoke_book((select v from t_out where k='tok'), t_gb('20:00', 120, 'Anna', '11111111-1111-1111-1111-111111111111')::jsonb)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='g1b' and (v::jsonb ->> 'repeat') = 'true' and (v::jsonb ->> 'id') = (select v from t_out where k='g1id') and (v::jsonb -> 'code') = 'null'::jsonb$$, 1, 'the same request again returns the first booking and no second code');
select t_rows(null, 'service_role', $$select 1 from public.karaoke_bookings$$, 1, 'and no second row');
select t_rows(null, 'service_role', $$select 1 where (public.guest_karaoke_book((select v from t_out where k='tok'), t_gb('21:00', 60, 'Overlap', '22222222-2222-2222-2222-222222222222', '0822222222')::jsonb) ->> 'error') = 'taken'$$, 1, 'an overlapping time is refused');
select t_rows(null, 'service_role', $$select 1 where (public.guest_karaoke_book((select v from t_out where k='tok'), t_gb('22:00', 60, 'Back to back', '33333333-3333-3333-3333-333333333333', '0833333333')::jsonb) ->> 'ok') = 'true'$$, 1, 'back to back is fine');
select t_val(null, 'service_role', 'sl2', $$select public.guest_karaoke_booking_slots((select v from t_out where k='tok'), (select v::uuid from t_out where k='room'), t_day(2)::date, 120)::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='sl2' and not (v::jsonb @> '"20:00"'::jsonb) and not (v::jsonb @> '"21:30"'::jsonb) and (v::jsonb @> '"18:00"'::jsonb) and not (v::jsonb @> '"19:00"'::jsonb)$$, 1, 'the taken time and every start that would run into it are no longer offered');
select t_rows(null, 'service_role', $$select 1 where (public.guest_karaoke_book((select v from t_out where k='tok'), t_gb('15:10', 60, 'Odd', '44444444-4444-4444-4444-444444444444', '0844444444')::jsonb) ->> 'error') = 'invalid'$$, 1, 'a start off the step grid is refused');
select t_rows(null, 'service_role', $$select 1 where (public.guest_karaoke_book((select v from t_out where k='tok'), t_gb('15:00', 45, 'Short', '55555555-5555-5555-5555-555555555555', '0855555555')::jsonb) ->> 'error') = 'invalid'$$, 1, 'a length the room does not offer is refused');
select t_rows(null, 'service_role', $$select 1 where (public.guest_karaoke_book((select v from t_out where k='tok'), jsonb_set(t_gb('15:00', 60, 'Past', '66666666-6666-6666-6666-666666666666', '0866666666')::jsonb, '{date}', to_jsonb(t_day(-1))))->> 'error') = 'invalid'$$, 1, 'a day in the past is refused');
select t_rows(null, 'service_role', $$select 1 where (public.guest_karaoke_book((select v from t_out where k='tok'), t_gb('15:00', 60, '', '77777777-7777-7777-7777-777777777777', '0877777777')::jsonb) ->> 'error') = 'invalid'$$, 1, 'a booking needs a name');
-- three upcoming per phone
select t_rows(null, 'service_role', $$select 1 where (public.guest_karaoke_book((select v from t_out where k='tok'), t_gb('12:00', 60, 'Anna', '88888888-8888-8888-8888-888888888881')::jsonb) ->> 'ok') = 'true'$$, 1, 'second booking of the same phone');
select t_rows(null, 'service_role', $$select 1 where (public.guest_karaoke_book((select v from t_out where k='tok'), t_gb('14:00', 60, 'Anna', '88888888-8888-8888-8888-888888888882')::jsonb) ->> 'ok') = 'true'$$, 1, 'third booking of the same phone');
select t_rows(null, 'service_role', $$select 1 where (public.guest_karaoke_book((select v from t_out where k='tok'), t_gb('16:00', 60, 'Anna', '88888888-8888-8888-8888-888888888883')::jsonb) ->> 'error') = 'too_many'$$, 1, 'a fourth upcoming booking of one phone is refused');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.app_notifications where kind = 'karaoke.online'$$, 4, 'the managers were told about each online booking');

-- ── status and cancel ──
select t_val(null, 'service_role', 'st1', $$select public.guest_karaoke_booking_status((select v from t_out where k='tok'), (select v::uuid from t_out where k='g1id'), lower((select v from t_out where k='g1code')))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='st1' and (v::jsonb ->> 'ok') = 'true' and (v::jsonb ->> 'deposit_due') = '18000' and (v::jsonb ->> 'deposit_paid') = '0' and (v::jsonb ->> 'minutes') = '120'$$, 1, 'the guest sees the deposit due and nothing paid yet (the code works in any letter case)');
select t_rows(null, 'service_role', $$select 1 where (public.guest_karaoke_booking_status((select v from t_out where k='tok'), (select v::uuid from t_out where k='g1id'), 'WRONG123') ->> 'ok') = 'false'$$, 1, 'a wrong code shows nothing');
select t_rows(null, 'service_role', $$select 1 where (public.guest_karaoke_cancel((select v from t_out where k='tok'), (select v::uuid from t_out where k='g1id'), 'WRONG123') ->> 'ok') = 'false'$$, 1, 'a wrong code cannot cancel');

-- ── the deposit ──
select t_err('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select public.record_karaoke_deposit(jsonb_build_object('booking_id', (select v from t_out where k='g1id'), 'amount', 18000, 'method', 'promptpay'))$$, '42501', 'another business cannot take a deposit');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.record_karaoke_deposit(jsonb_build_object('booking_id', (select v from t_out where k='g1id'), 'amount', 18000, 'method', 'cash'))$$, '22023', 'a cash deposit needs a till');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.record_karaoke_deposit(jsonb_build_object('booking_id', (select v from t_out where k='g1id'), 'amount', 99999999, 'method', 'promptpay'))$$, '22023', 'a deposit above the room price is refused');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'dp1', $$select public.record_karaoke_deposit(jsonb_build_object('booking_id', (select v from t_out where k='g1id'), 'amount', 18000, 'method', 'cash', 'device_id', (select v from t_out where k='dev')))::text$$);
select t_val(null, 'service_role', 'st2', $$select public.guest_karaoke_booking_status((select v from t_out where k='tok'), (select v::uuid from t_out where k='g1id'), (select v from t_out where k='g1code'))::text$$);
select t_rows(null, 'service_role', $$select 1 from t_out where k='st2' and (v::jsonb ->> 'deposit_paid') = '18000'$$, 1, 'the guest page sees the deposit once the desk recorded it');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'payment.tender' and entity_id = (select v from t_out where k='g1id')$$, 1, 'taking a deposit is audited');

-- ── an unpaid booking is released after the hold window ──
update public.karaoke_bookings set hold_until = now() - interval '1 minute';
select t_rows(null, 'service_role', $$select 1 where public.karaoke_release_unpaid() = 3$$, 1, 'the tick releases the three online bookings whose deposit did not arrive');
select t_rows(null, 'service_role', $$select 1 from public.karaoke_bookings where id = (select v::uuid from t_out where k='g1id') and status = 'booked'$$, 1, 'a booking whose deposit arrived is kept');
select t_rows(null, 'service_role', $$select 1 where public.karaoke_release_unpaid() = 0$$, 1, 'running the tick again changes nothing');
select t_rows(null, 'service_role', $$select 1 where (public.guest_karaoke_book((select v from t_out where k='tok'), t_gb('22:00', 60, 'Takes the freed time', '99999999-9999-9999-9999-999999999991', '0899999999')::jsonb) ->> 'ok') = 'true'$$, 1, 'a released time can be booked again');

-- ── the visit: start for the booking, stop, bill with the deposit applied ──
update public.karaoke_bookings set starts_at = now() - interval '5 minutes', ends_at = now() + interval '115 minutes' where id = (select v::uuid from t_out where k='g1id');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ks', $$select public.karaoke_start((select v::uuid from t_out where k='room'), null, null, (select v::uuid from t_out where k='g1id'))::text$$);
update public.karaoke_sessions set started_at = now() - interval '120 minutes' where id = (select v::uuid from t_out where k='ks');
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'kst', $$select public.karaoke_stop((select v::uuid from t_out where k='ks'))::text$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'ko', $$select public.karaoke_to_order((select v::uuid from t_out where k='ks'), (select v from t_out where k='dev')::uuid)::text$$);
select t_rows(null, 'service_role', $$select 1 from public.order_partial_payments where order_id = (select v::uuid from t_out where k='ko') and kind = 'deposit' and amount = 18000 and tender = 'cash' and provider_ref like 'deposit:%'$$, 1, 'the deposit is an already-paid share of the room bill');
select t_rows(null, 'service_role', $$select 1 from public.karaoke_deposits where id = (select v::uuid from t_out where k='dp1') and status = 'on_bill' and order_id = (select v::uuid from t_out where k='ko')$$, 1, 'and is marked on the bill');
select t_rows(null, 'service_role', $$select 1 where public.order_held_total((select v::uuid from t_out where k='ko')) = 18000$$, 1, 'the bill holds the 180 baht already paid');
select t_rows(null, 'service_role', $$select 1 where public.order_locking_held((select v::uuid from t_out where k='ko')) = 0$$, 1, 'and a deposit does not lock the bill');
select t_err('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select public.resolve_karaoke_deposit(jsonb_build_object('deposit_id', (select v from t_out where k='dp1'), 'action', 'refund', 'device_id', (select v from t_out where k='dev')))$$, '42501', 'a cashier cannot settle a deposit');
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.resolve_karaoke_deposit(jsonb_build_object('deposit_id', (select v from t_out where k='dp1'), 'action', 'refund', 'device_id', (select v from t_out where k='dev')))$$, '55000', 'a deposit already on the bill cannot be settled');

-- ── a cancelled booking: the deposit is settled by a manager ──
select t_val(null, 'service_role', 'g2', $$select public.guest_karaoke_book((select v from t_out where k='tok'), t_gb('15:00', 60, 'Cancels', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '0877000111')::jsonb)::text$$);
select t_val(null, 'service_role', 'g2id', $$select v::jsonb ->> 'id' from t_out where k='g2'$$);
select t_val(null, 'service_role', 'g2code', $$select v::jsonb ->> 'code' from t_out where k='g2'$$);
select t_val('00000000-0000-0000-0000-0000000000d4', 'authenticated', 'dp2', $$select public.record_karaoke_deposit(jsonb_build_object('booking_id', (select v from t_out where k='g2id'), 'amount', 9000, 'method', 'promptpay', 'reference', 'slip 123'))::text$$);
select t_err('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select public.resolve_karaoke_deposit(jsonb_build_object('deposit_id', (select v from t_out where k='dp2'), 'action', 'refund'))$$, '55000', 'a live booking cannot have its deposit settled');
select t_rows(null, 'service_role', $$select 1 where (public.guest_karaoke_cancel((select v from t_out where k='tok'), (select v::uuid from t_out where k='g2id'), (select v from t_out where k='g2code')) ->> 'ok') = 'true'$$, 1, 'the guest cancels with the code');
select t_rows(null, 'service_role', $$select 1 where (public.guest_karaoke_cancel((select v from t_out where k='tok'), (select v::uuid from t_out where k='g2id'), (select v from t_out where k='g2code')) ->> 'error') = 'closed'$$, 1, 'a cancelled booking cannot be cancelled again');
select t_rows(null, 'service_role', $$select 1 from public.karaoke_deposits where id = (select v::uuid from t_out where k='dp2') and status = 'held'$$, 1, 'the deposit stays held after the guest cancels');
select t_rows('00000000-0000-0000-0000-0000000000a1', 'authenticated', $$select 1 from public.app_notifications where kind = 'karaoke.online_cancel'$$, 1, 'the managers were told about the cancellation');
select t_val('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'rs', $$select public.resolve_karaoke_deposit(jsonb_build_object('deposit_id', (select v from t_out where k='dp2'), 'action', 'forfeit'))$$);
select t_rows(null, 'service_role', $$select 1 from public.karaoke_deposits where id = (select v::uuid from t_out where k='dp2') and status = 'forfeited' and resolved_at is not null$$, 1, 'a manager keeps the deposit as a fee');
select t_rows(null, 'service_role', $$select 1 from public.audit_log where action = 'payment.refund' and entity_id = (select v from t_out where k='g2id')$$, 1, 'settling a deposit is a critical audit event');
select t_err(null, 'authenticated', $$insert into public.karaoke_deposits (org_id, store_id, booking_id, amount, method) select org_id, store_id, id, 1, 'cash' from public.karaoke_bookings limit 1$$, '42501', 'no direct writes to deposits');
select t_rows('00000000-0000-0000-0000-0000000000d4', 'authenticated', $$select 1 from public.karaoke_deposits$$, 2, 'the front desk reads the deposits');
select t_rows('00000000-0000-0000-0000-0000000000e5', 'authenticated', $$select 1 from public.karaoke_deposits$$, 0, 'another business reads none');

-- ── the module off: the link answers closed and nothing can be booked ──
update public.stores set module_overrides = module_overrides || '{"karaoke.booking": false}'::jsonb where id = (select v::uuid from t_out where k='store');
select t_rows(null, 'service_role', $$select 1 where (public.guest_karaoke_book((select v from t_out where k='tok'), t_gb('15:00', 60, 'Late', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', '0899000111')::jsonb) ->> 'error') = 'off'$$, 1, 'with the module off nothing can be booked');
select t_rows(null, 'service_role', $$select 1 where public.guest_karaoke_booking_slots((select v from t_out where k='tok'), (select v::uuid from t_out where k='room'), t_day(2)::date, 60) is null$$, 1, 'and no times are listed');
do $$ begin raise notice 'ALL KARAOKE BOOKING TESTS PASSED'; end $$;
