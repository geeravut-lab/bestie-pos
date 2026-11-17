/**
 * Server-side environment. This is the ONLY place that may read SUPABASE_SERVICE_ROLE_KEY.
 * service_role bypasses Row Level Security: it must never be imported from browser code,
 * never logged, never returned in a response.
 */
export type ServerEnv = {
  supabaseUrl: string;
  serviceRoleKey: string;
};

export class ServerEnvError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    // Names only — never echo values.
    super(`Missing server environment variables: ${missing.join(', ')}`);
    this.name = 'ServerEnvError';
    this.missing = missing;
  }
}

export function readServerEnv(env: Record<string, string | undefined> = process.env): ServerEnv {
  const supabaseUrl = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const missing = [
    !supabaseUrl && 'SUPABASE_URL',
    !serviceRoleKey && 'SUPABASE_SERVICE_ROLE_KEY',
  ].filter((v): v is string => Boolean(v));
  if (missing.length || !supabaseUrl || !serviceRoleKey) throw new ServerEnvError(missing);
  return { supabaseUrl, serviceRoleKey };
}
