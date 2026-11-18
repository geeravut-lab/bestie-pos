-- Bestie POS · migration 19 · sales report for one shop or all shops of an org.
--
-- One read-only function, computed from the FROZEN history (paid orders + their receipts + payments + lines), in the
-- Bangkok business date. Needs `report.view` and access to the shops it covers. Cancelled lines and void bills never count.
-- Returned as one jsonb document so the screen, the CSV export and (later) "Ask my shop" read exactly the same numbers.

create or replace function public.sales_report(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org   uuid := (p ->> 'org_id')::uuid;
  v_store uuid := nullif(p ->> 'store_id', '')::uuid;
  v_from  date := (p ->> 'from')::date;
  v_to    date := (p ->> 'to')::date;
  v_out   jsonb;
begin
  if not public.has_permission(v_org, 'report.view') then
    raise exception 'reports need report.view' using errcode = '42501';
  end if;
  if v_store is not null and not public.can_access_store(v_org, v_store) then
    raise exception 'no access to this shop' using errcode = '42501';
  end if;
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 366 then
    raise exception 'the date range is not valid' using errcode = '22023';
  end if;

  with st as (
    select s.id, s.name from public.stores s
     where s.org_id = v_org and s.deleted_at is null and (v_store is null or s.id = v_store)
       and public.can_access_store(s.org_id, s.id)
  ),
  bills as (
    select o.id as order_id, o.store_id, o.business_date, r.issued_at, r.subtotal, r.service_charge, r.vat, r.total,
           r.rounding, r.payable, r.staff_id
      from public.orders o
      join public.receipts r on r.order_id = o.id
      join st on st.id = o.store_id
     where o.status = 'paid' and o.business_date between v_from and v_to
  )
  select jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_to),
    'totals', (select jsonb_build_object(
        'bills', count(*), 'subtotal', coalesce(sum(subtotal), 0), 'service_charge', coalesce(sum(service_charge), 0),
        'vat', coalesce(sum(vat), 0), 'rounding', coalesce(sum(rounding), 0), 'payable', coalesce(sum(payable), 0),
        'average', case when count(*) = 0 then 0 else round(sum(payable)::numeric / count(*)) end) from bills),
    'by_day', coalesce((select jsonb_agg(x order by x ->> 'date') from (
        select jsonb_build_object('date', business_date, 'bills', count(*), 'payable', sum(payable)) as x
          from bills group by business_date) d), '[]'::jsonb),
    'by_hour', coalesce((select jsonb_agg(x order by (x ->> 'hour')::int) from (
        select jsonb_build_object('hour', extract(hour from issued_at at time zone 'Asia/Bangkok')::int, 'bills', count(*), 'payable', sum(payable)) as x
          from bills group by extract(hour from issued_at at time zone 'Asia/Bangkok')::int) h), '[]'::jsonb),
    'by_tender', coalesce((select jsonb_agg(x order by (x ->> 'amount')::bigint desc) from (
        select jsonb_build_object('tender', pay.tender, 'amount', sum(pay.amount), 'bills', count(distinct pay.order_id)) as x
          from public.payments pay join bills b on b.order_id = pay.order_id
         where pay.status = 'confirmed' group by pay.tender) t), '[]'::jsonb),
    'by_item', coalesce((select jsonb_agg(x order by (x ->> 'revenue')::bigint desc) from (
        select jsonb_build_object('name_th', coalesce(l.name ->> 'th', ''), 'name_en', coalesce(max(l.name ->> 'en'), ''),
                                  'quantity', sum(l.quantity), 'revenue', sum(l.unit_price::bigint * l.quantity)) as x
          from public.order_lines l join bills b on b.order_id = l.order_id
         where l.status <> 'void' group by coalesce(l.name ->> 'th', '') order by sum(l.unit_price::bigint * l.quantity) desc limit 200) i), '[]'::jsonb),
    'by_staff', coalesce((select jsonb_agg(x order by (x ->> 'payable')::bigint desc) from (
        select jsonb_build_object('staff_id', b.staff_id, 'name', coalesce(s.display_name, ''), 'bills', count(*), 'payable', sum(b.payable)) as x
          from bills b left join public.staff s on s.id = b.staff_id group by b.staff_id, s.display_name) q), '[]'::jsonb),
    'by_store', coalesce((select jsonb_agg(x order by (x ->> 'payable')::bigint desc) from (
        select jsonb_build_object('store_id', st.id, 'name', st.name, 'bills', count(b.order_id), 'payable', coalesce(sum(b.payable), 0)) as x
          from st left join bills b on b.store_id = st.id group by st.id, st.name) z), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.sales_report(jsonb) from public, anon;
grant execute on function public.sales_report(jsonb) to authenticated, service_role;
