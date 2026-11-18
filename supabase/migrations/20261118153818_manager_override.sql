-- Bestie POS · migration 26 · manager override with a PIN.
--
-- A cashier's tablet is signed in with the cashier's own account, so the database applies the CASHIER's rights. When a sent
-- line has to be cancelled (void) the manager does not take over the tablet: they type their PIN, the server checks it
-- (the same lock-out rules as the lock screen: 5 wrong tries lock the PIN for 15 minutes), checks that that person's role
-- really has `order.void`, performs the one action, and records WHO approved it in the audit event.
--  * online only (the PIN is never checked on the tablet for this);
--  * one action per approval — nothing is "unlocked" on the tablet afterwards.

-- the managers whose PIN can approve a void (id + name only; no PIN data leaves the server)
create or replace function public.void_approvers(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_org_member(p_org) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.display_name) order by s.display_name)
    from public.staff s
    join public.roles r on r.id = s.role_id
    join public.staff_pins p on p.staff_id = s.id
   where s.org_id = p_org and s.active and (r.built_in = 'owner' or 'order.void' = any (r.permissions))), '[]'::jsonb);
end $$;
revoke all on function public.void_approvers(uuid) from public, anon;
grant execute on function public.void_approvers(uuid) to authenticated, service_role;

-- the audit event of a cancelled line now says who approved it
create or replace function public.audit_trg_order_lines() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.status = 'void' and old.status not in ('new', 'void') then
    perform public.audit_record(new.org_id, new.store_id, 'order.void', 'order_lines', new.id::text,
      jsonb_build_object('order_id', new.order_id, 'was', old.status, 'qty', new.quantity, 'amount', new.unit_price * new.quantity)
        || case when nullif(current_setting('bestie.approved_by', true), '') is not null
                then jsonb_build_object('approved_by', current_setting('bestie.approved_by', true)) else '{}'::jsonb end, 'db');
  end if;
  return new;
end $$;

-- p = { line_id, reason, manager_id (staff), manager_pin }
create or replace function public.void_line_with_manager(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  l       public.order_lines%rowtype;
  o       public.orders%rowtype;
  m       public.staff%rowtype;
  v_ok    boolean;
  v_check text;
  v_reason text := left(btrim(coalesce(p ->> 'reason', '')), 100);
begin
  select * into l from public.order_lines where id = (p ->> 'line_id')::uuid for update;
  if not found then raise exception 'line not found' using errcode = 'P0002'; end if;
  select * into o from public.orders where id = l.order_id for update;
  if not (public.has_permission(o.org_id, 'order.create') and public.can_access_store(o.org_id, o.store_id)) then
    raise exception 'changing a bill needs order.create' using errcode = '42501';
  end if;
  if o.status in ('paid', 'void') then raise exception 'order is already closed' using errcode = '23514'; end if;
  if l.status = 'void' then return jsonb_build_object('ok', true, 'replay', true); end if;
  if l.status = 'new' then raise exception 'an unsent line needs no approval' using errcode = '23514'; end if;
  if length(v_reason) = 0 then raise exception 'a reason is required' using errcode = '22023'; end if;

  select * into m from public.staff s where s.id = (p ->> 'manager_id')::uuid and s.org_id = o.org_id and s.active;
  if not found then raise exception 'approver not found' using errcode = '28000'; end if;
  select exists (select 1 from public.roles r where r.id = m.role_id and (r.built_in = 'owner' or 'order.void' = any (r.permissions))) into v_ok;
  if not v_ok then raise exception 'that person cannot approve a void' using errcode = '28000'; end if;
  v_check := public.verify_staff_pin(m.id, coalesce(p ->> 'manager_pin', ''));
  if v_check <> 'ok' then
    -- NOT an exception: raising would roll back the wrong-PIN counter that verify_staff_pin just advanced, and the
    -- lock-out would never trigger. The answer is the same for every failure reason (wrong / locked / no PIN).
    return jsonb_build_object('ok', false, 'replay', false);
  end if;

  perform set_config('bestie.approved_by', m.id::text, true);
  update public.order_lines set status = 'void', void_reason = v_reason where id = l.id;
  perform set_config('bestie.approved_by', '', true);
  return jsonb_build_object('ok', true, 'replay', false);
end $$;
revoke all on function public.void_line_with_manager(jsonb) from public, anon;
grant execute on function public.void_line_with_manager(jsonb) to authenticated, service_role;
