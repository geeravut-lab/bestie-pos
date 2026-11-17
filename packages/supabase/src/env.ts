/**
 * Browser-side environment handling. Only PUBLIC values may reach the browser:
 * the Supabase URL and the *anon* key (protected by Row Level Security, not secrecy).
 * The service_role key bypasses RLS and must exist only in server functions
 * (docs/ENVIRONMENT.md, docs/SSO-Aivora-Supabase.md).
 */

export type PublicEnv = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  siteUrl: string;
};

type RawEnv = Record<string, string | boolean | undefined>;

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

const CLIENT_PREFIXES = ['VITE_', 'NEXT_PUBLIC_', 'PUBLIC_'];
const SECRET_HINT = /(SERVICE_ROLE|SECRET|PRIVATE)/;

/** Throws if anything that looks like a server secret was given a browser-exposed prefix. */
export function assertNoServerSecretsInClientEnv(env: RawEnv): void {
  for (const key of Object.keys(env)) {
    if (CLIENT_PREFIXES.some((p) => key.startsWith(p)) && SECRET_HINT.test(key)) {
      throw new EnvError(
        `${key} looks like a server secret but has a browser-exposed prefix. ` +
          'Rename it (no VITE_/NEXT_PUBLIC_/PUBLIC_) and read it only inside a server function.',
      );
    }
  }
}

const str = (v: string | boolean | undefined): string => (typeof v === 'string' ? v.trim() : '');

/** Reads the public config from `import.meta.env`. Missing pieces → undefined (app shows setup hint). */
export function readPublicEnv(env: RawEnv): PublicEnv | undefined {
  assertNoServerSecretsInClientEnv(env);
  const supabaseUrl = str(env.VITE_SUPABASE_URL);
  const supabaseAnonKey = str(env.VITE_SUPABASE_ANON_KEY);
  if (!supabaseUrl || !supabaseAnonKey) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(supabaseUrl);
  } catch {
    throw new EnvError('VITE_SUPABASE_URL is not a valid URL');
  }
  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '127.0.0.1'
  ) {
    throw new EnvError(
      'VITE_SUPABASE_URL must be https (or localhost for the local Supabase stack)',
    );
  }

  return {
    supabaseUrl: parsed.origin,
    supabaseAnonKey,
    siteUrl: str(env.VITE_SITE_URL) || (typeof location !== 'undefined' ? location.origin : ''),
  };
}
