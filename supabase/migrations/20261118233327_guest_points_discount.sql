-- Bestie POS · migration 29 · the guest's bill knows about a Points discount the staff put on it (so the amount the guest pays is the real one).

create or replace function public.guest_pay_context(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with t as (
    select t.id, t.name, t.store_id from public.dining_tables t where t.qr_token = p_token and t.deleted_at is null and t.active),
  s as (
    select s.* from public.stores s where s.id = (select store_id from t) and s.deleted_at is null),
  d as (
    select d.id from public.devices d where d.id = (select qr_pay_device from s) and d.store_id = (select id from s) and d.active),
  o as (
    select ord.id from public.orders ord where ord.table_id = (select id from t) and ord.status not in ('paid', 'void') order by ord.created_at limit 1)
  select case when not exists (select 1 from t) then null else jsonb_build_object(
    'enabled', public.qr_ordering_enabled((select id from s)) and exists (select 1 from d),
    'device_id', (select id from d),
    'order_id', (select id from o),
    'points_discount', coalesce((select ord.points_discount from public.orders ord where ord.id = (select id from o)), 0),
    'config', jsonb_build_object(
      'vat_bps', (select case when vat_registered then vat_bps else 0 end from s),
      'service_bps', (select service_charge_bps from s),
      'price_mode', (select price_mode from s),
      'bill_options', (select bill_options from s)),
    'unsent', exists (select 1 from public.order_lines l where l.order_id = (select id from o) and l.status = 'new'),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('unit_price', l.unit_price, 'quantity', l.quantity))
        from public.order_lines l where l.order_id = (select id from o) and l.status <> 'void'), '[]'::jsonb),
    'live', (select jsonb_build_object('id', a.id, 'amount', a.amount, 'qr_url', a.qr_url, 'expires_at', a.expires_at,
                                       'status', a.status, 'provider_ref', a.provider_ref)
               from public.payment_attempts a where a.order_id = (select id from o) and a.status in ('created', 'pending'))) end
$$;
revoke all on function public.guest_pay_context(text) from public, anon, authenticated;
grant execute on function public.guest_pay_context(text) to service_role;
