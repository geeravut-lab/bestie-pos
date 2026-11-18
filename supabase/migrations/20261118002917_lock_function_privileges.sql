-- Bestie POS · migration 8 · lock down function privileges (found by the Supabase security advisor).
--
-- Supabase grants EXECUTE on new public functions to anon and authenticated by default, so "revoke ... from public" alone
-- left internal SECURITY DEFINER functions callable through /rest/v1/rpc — e.g. an anonymous caller could write audit events
-- for any org (audit_record) or fire pings (live_ping). From now on:
--   * internal functions (audit writers, trigger functions, ping helpers): server / definer only;
--   * RLS helper functions: signed-in users only (policies call them as the caller);
--   * app RPCs (create_org, write_audit, set_audit_settings): signed-in users only;
--   * future functions get NO default grants: every migration must grant what it needs, explicitly.

-- PostgreSQL gives PUBLIC execute on every new function; that default is global, so it must be revoked without `in schema`.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- internal: nobody but the owner / service_role
revoke all on function
  public.audit_record(uuid, uuid, text, text, text, jsonb, text),
  public.audit_clean_detail(jsonb),
  public.audit_block_mutation(),
  public.audit_trg_staff(),
  public.audit_trg_orgs(),
  public.audit_trg_stores(),
  public.live_ping(text),
  public.live_ping_row(),
  public.handle_new_user(),
  public.staff_keep_an_owner(),
  public.stores_check_entity(),
  public.orgs_protect_legal(),
  public.touch_updated_at(),
  public.platform_settings_check_brand(),
  public.ai_prompt_versions_immutable()
from public, anon, authenticated;
grant execute on function public.audit_record(uuid, uuid, text, text, text, jsonb, text), public.live_ping(text) to service_role;

-- RLS helpers + app RPCs: signed-in only
revoke all on function
  public.is_platform_admin(), public.is_org_member(uuid), public.is_org_owner(uuid), public.role_is_owner(uuid),
  public.can_access_store(uuid, uuid), public.has_permission(uuid, text), public.live_can_listen(text),
  public.create_org(text, text, text), public.write_audit(uuid, uuid, text, text, text, jsonb),
  public.set_audit_settings(uuid, boolean, text[])
from public, anon;
grant execute on function
  public.is_platform_admin(), public.is_org_member(uuid), public.is_org_owner(uuid), public.role_is_owner(uuid),
  public.can_access_store(uuid, uuid), public.has_permission(uuid, text), public.live_can_listen(text),
  public.create_org(text, text, text), public.write_audit(uuid, uuid, text, text, text, jsonb),
  public.set_audit_settings(uuid, boolean, text[])
to authenticated, service_role;
