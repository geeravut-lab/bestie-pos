-- Bestie POS · migration 51 · LINE connection diagnostics.
-- Owner report: the LINE link code was typed into the Official Account chat and nothing answered (the link stayed "pending",
-- attempts = 0): no webhook call ever reached the server. To tell WHY without guessing, every call to /api/line/webhook now leaves one
-- row here: only the outcome ("ok", "bad_signature", "reply_failed_401" …) and how many events it carried — never the message text,
-- never a LINE user id. The platform admin's "check the LINE connection" button reads the last 24 hours next to LINE's own view of the
-- bot (token, webhook address, "use webhook" switch, a test call). Only the server (service role) writes or reads this table.
create table public.line_webhook_log (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  outcome text not null check (length(outcome) <= 40),
  events  integer not null default 0 check (events between 0 and 1000)
);
create index line_webhook_log_at_idx on public.line_webhook_log (at desc);
alter table public.line_webhook_log enable row level security;       -- no policy: invisible to the browser
revoke all on public.line_webhook_log from anon, authenticated;

create or replace function public.log_line_webhook(p_outcome text, p_events integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.line_webhook_log (outcome, events) values (left(coalesce(p_outcome, 'unknown'), 40), least(greatest(coalesce(p_events, 0), 0), 1000));
  delete from public.line_webhook_log where at < now() - interval '7 days';
end $$;
revoke all on function public.log_line_webhook(text, integer) from public, anon, authenticated;
grant execute on function public.log_line_webhook(text, integer) to service_role;

-- last 24 hours, grouped: what the diagnosis shows
create or replace function public.line_webhook_summary() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(outcome, n), '{}'::jsonb) from (
    select outcome, count(*) as n from public.line_webhook_log where at > now() - interval '24 hours' group by outcome
  ) x
$$;
revoke all on function public.line_webhook_summary() from public, anon, authenticated;
grant execute on function public.line_webhook_summary() to service_role;

create or replace function public.line_pending_links() returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer from public.notification_channels where channel = 'line' and status = 'pending' and code_expires_at > now()
$$;
revoke all on function public.line_pending_links() from public, anon, authenticated;
grant execute on function public.line_pending_links() to service_role;
