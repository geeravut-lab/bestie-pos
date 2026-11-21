-- Bestie POS · migration 69 · provider-neutral names (owner order 6.4): `devices.stripe_reader_id` -> `reader_id`, `stripe_events` -> `payment_events`.
-- The payment gateway interface (functions/src/gateway.ts) already lets a second provider be added; these two names were the last Stripe-shaped leftovers.
-- Every function whose body mentions an old name is re-created from its own definition with the new names (so nothing is retyped by hand and no grant is lost).

alter table public.devices rename column stripe_reader_id to reader_id;
alter table public.stripe_events rename to payment_events;
do $$
declare r record; v_def text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.prosrc like '%stripe_reader_id%' or p.prosrc like '%stripe_events%') loop
    v_def := pg_get_functiondef(r.oid);
    v_def := replace(replace(v_def, 'stripe_reader_id', 'reader_id'), 'stripe_events', 'payment_events');
    execute v_def;
  end loop;
end $$;

alter function public.record_stripe_event(text, text) rename to record_payment_event;
