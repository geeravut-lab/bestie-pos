-- Bestie POS · migration 36 · the platform admin can see and change the LINE push cap (monthly cap, urgent reserve) and lift a halt.
--  * Only the platform admin reads / updates `notification_settings` (RLS + column grants: nothing else can be changed).
--  * `notify_usage()` answers "how many pushes this month, how many waiting, is delivery halted" for the same person.
create policy notification_settings_admin_read on public.notification_settings for select to authenticated using (public.is_platform_admin());
create policy notification_settings_admin_update on public.notification_settings for update to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());
grant select on public.notification_settings to authenticated;
grant update (line_monthly_cap, line_reserve, halted_until, halted_reason) on public.notification_settings to authenticated;

create or replace function public.notify_usage() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  st public.notification_settings%rowtype;
begin
  if not public.is_platform_admin() then
    raise exception 'platform admin only' using errcode = '42501';
  end if;
  select * into st from public.notification_settings where id;
  return jsonb_build_object(
    'cap', st.line_monthly_cap, 'reserve', st.line_reserve, 'halted_until', st.halted_until, 'halted_reason', st.halted_reason,
    'sent_month', (select count(*) from public.notification_queue q
                    where q.status = 'sent' and q.sent_at >= date_trunc('month', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok'),
    'queued', (select count(*) from public.notification_queue q where q.status = 'queued'),
    'failed_month', (select count(*) from public.notification_queue q
                      where q.status in ('failed', 'blocked') and q.created_at >= date_trunc('month', now() at time zone 'Asia/Bangkok') at time zone 'Asia/Bangkok'));
end $$;
revoke all on function public.notify_usage() from public, anon;
grant execute on function public.notify_usage() to authenticated, service_role;
