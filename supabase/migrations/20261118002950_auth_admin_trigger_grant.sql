-- Bestie POS · migration 9 · belt and braces for sign-up.
-- The profile trigger on auth.users fires while the auth service (supabase_auth_admin) inserts a new user. PostgreSQL does not
-- check EXECUTE at firing time, but granting it to exactly that service role costs nothing and removes any doubt that sign-up
-- (e-mail, Google, LINE SSO) could fail with "Database error saving new user" after migration 8.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function public.handle_new_user() to supabase_auth_admin;
  end if;
end $$;
