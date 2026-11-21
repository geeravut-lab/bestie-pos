-- Bestie POS · migration 79 · PART OF A BILL ON THE ROOM: a room can be one leg of a split closing (cash / Credit / room).
--
--  * `close_order_tenders` (the split closing: one transaction, one receipt, server "+" series) now accepts ONE leg of tender `room` with the stay's `folio_id`. The other legs are
--    cash / Credit as before; the legs must add up to the amount due exactly. The room's share is booked as one payment of tender `room` (reference `folio:<id>`) and one line on
--    the stay (`folio_charges`, kind `bill`, the amount of THAT share, the receipt number). The sale and its VAT are on the receipt as for any bill; no Points are earned on the
--    room's share (nothing has been paid yet); a later return through the route `room` can take back at most what the room paid.
--  * The whole-bill closing `charge_order_to_room` is unchanged; this is only for "part on the room, the rest paid now".

do $$
declare r record; src text; dst text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'close_order_tenders' loop
    src := pg_get_functiondef(r.oid);
    dst := src;
    dst := replace(dst, E'  x        jsonb;\nbegin', E'  x        jsonb;\n  v_room   bigint := 0;\n  v_folio  uuid;\n  f        public.folios%rowtype;\nbegin');
    dst := replace(dst, $q$if x ->> 'tender' not in ('cash', 'credit') then
      raise exception 'only cash and Bestie Credit can be mixed here' using errcode = '23514';$q$,
      $q$if x ->> 'tender' not in ('cash', 'credit', 'room') then
      raise exception 'only cash, Bestie Credit and a room can be mixed here' using errcode = '23514';$q$);
    dst := replace(dst, $q$    else
      v_credit := v_credit + (x ->> 'amount')::bigint;
    end if;
    v_paid := v_paid + (x ->> 'amount')::bigint;$q$,
      $q$    elsif x ->> 'tender' = 'credit' then
      v_credit := v_credit + (x ->> 'amount')::bigint;
    else
      if v_room > 0 then raise exception 'only one room can take a share' using errcode = '23514'; end if;
      v_room := (x ->> 'amount')::bigint;
      v_folio := nullif(x ->> 'folio_id', '')::uuid;
    end if;
    v_paid := v_paid + (x ->> 'amount')::bigint;$q$);
    dst := replace(dst, $q$  if v_credit > 0 then
    if not public.credit_enabled(v_store.id) then$q$,
      $q$  if v_room > 0 then
    select * into f from public.folios where id = v_folio for update;
    if not found or f.org_id <> v_order.org_id or f.status <> 'open' then raise exception 'there is no open stay to charge' using errcode = '55000'; end if;
    if not public.folio_enabled(f.store_id) then raise exception 'the folio module is off in the resort shop' using errcode = '0A000'; end if;
    if v_round <> 0 then raise exception 'a room share needs an exact amount (no rounding)' using errcode = '23514'; end if;
    if exists (select 1 from public.folio_charges fc where fc.order_id = v_order.id) then raise exception 'this bill is already on a room' using errcode = '55000'; end if;
  end if;
  if v_credit > 0 then
    if not public.credit_enabled(v_store.id) then$q$);
    dst := replace(dst, $q$          'tendered', case when e ->> 'tender' = 'cash' then e -> 'tendered' end,$q$,
      $q$          'reference', case when e ->> 'tender' = 'room' then 'folio:' || (e ->> 'folio_id') end,
          'tendered', case when e ->> 'tender' = 'cash' then e -> 'tendered' end,$q$);
    dst := replace(dst, $q$  return jsonb_build_object('receipt_number', v_no, 'replay', false);
end $function$
$q$,
      $q$  if v_room > 0 then
    insert into public.folio_charges (org_id, store_id, folio_id, order_id, amount, receipt_number, created_by)
    values (v_order.org_id, v_order.store_id, v_folio, v_order.id, v_room, v_no, v_staff);
    perform public.audit_record(v_order.org_id, v_order.store_id, 'payment.tender', 'folio_charges', v_order.id::text,
      jsonb_build_object('tender', 'room', 'amount', v_room, 'folio', v_folio, 'part', v_room < v_pay), 'db');
  end if;
  return jsonb_build_object('receipt_number', v_no, 'replay', false);
end $function$
$q$);
    if dst = src or position('v_room   bigint' in dst) = 0 or position('only one room can take a share' in dst) = 0 or position('there is no open stay to charge' in dst) = 0
       or position('''reference'', case when e ->> ''tender'' = ''room''' in dst) = 0 or position('insert into public.folio_charges' in dst) = 0
       or position('can be mixed here' in dst) = 0 or position('cash, Bestie Credit and a room' in dst) = 0 then
      raise exception 'migration 79: close_order_tenders not changed as expected';
    end if;
    execute dst;
  end loop;
end $$;
