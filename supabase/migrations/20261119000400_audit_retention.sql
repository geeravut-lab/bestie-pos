-- Bestie POS · migration 33 · audit trail retention (docs/DECISIONS.md "Open questions": how many years).
--
--  * The audit log stays append-only for everybody EXCEPT this one scheduled purge: rows older than the retention are deleted
--    in bulk by `audit_purge()` (service role only). Nobody can delete a single row, update one, or truncate the table.
--  * Retention is data: `audit_retention.years`, default 5 (Thai accounting-record retention is commonly cited as 5 years; the
--    knowledge file used 4), never below 4. The accountant / lawyer confirms the number; changing it is a database edit by the
--    platform (no screen yet).
--  * The purge runs from /api/notify/tick (hourly tidy). It returns how many rows it removed and writes nothing about them
--    (the rows are the evidence; a summary line would need its own retention).

create table public.audit_retention (
  id    boolean primary key default true check (id),
  years integer not null default 5 check (years between 4 and 20)
);
insert into public.audit_retention (id) values (true);
alter table public.audit_retention enable row level security;          -- server only
revoke all on public.audit_retention from anon, authenticated;

create index audit_log_created_idx on public.audit_log (created_at);

-- a deletion is allowed only inside the purge function (it sets a transaction-local flag); everything else stays blocked
create or replace function public.audit_block_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('bestie.audit_purge', true), '') = 'on' then
    return old;
  end if;
  raise exception 'audit_log is append-only' using errcode = '42501';
end $$;

create or replace function public.audit_purge() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_years integer;
  n       integer;
begin
  select years into v_years from public.audit_retention where id;
  perform set_config('bestie.audit_purge', 'on', true);          -- this transaction only
  delete from public.audit_log where created_at < now() - make_interval(years => v_years);
  get diagnostics n = row_count;
  perform set_config('bestie.audit_purge', 'off', true);
  return n;
end $$;
revoke all on function public.audit_purge() from public, anon, authenticated;
grant execute on function public.audit_purge() to service_role;
