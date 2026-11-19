-- Payment gateway adapter: the attempt records WHICH provider started it, and the webhook handler only lets a provider settle
-- an attempt that provider started. (The column `provider` has existed since the first card migration, default 'stripe'.)
drop function if exists public.attach_payment_intent(uuid, text, text, timestamptz);

create or replace function public.attach_payment_intent(
  p_attempt uuid, p_ref text, p_qr text, p_expires timestamptz, p_provider text default null
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_provider is not null and p_provider !~ '^[a-z][a-z0-9_]{1,29}$' then
    raise exception 'bad provider' using errcode = '22023';
  end if;
  update public.payment_attempts
     set provider_ref = p_ref, qr_url = p_qr, expires_at = p_expires,
         provider = coalesce(p_provider, provider),
         status = case when status = 'created' then 'pending' else status end
   where id = p_attempt;
end $$;
revoke all on function public.attach_payment_intent(uuid, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.attach_payment_intent(uuid, text, text, timestamptz, text) to service_role;
