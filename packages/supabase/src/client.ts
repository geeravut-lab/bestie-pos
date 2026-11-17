import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PublicEnv } from './env';

/**
 * One browser client per app. Uses the anon key + the signed-in user's JWT, so every query is
 * subject to Row Level Security. Never create a service_role client in browser code.
 *
 * `Database` generics arrive with the first migration (`supabase gen types`).
 */
export function createBrowserClient(env: PublicEnv): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}
