import { describe, expect, it } from 'vitest';
import { EnvError, assertNoServerSecretsInClientEnv, readPublicEnv } from './env';

const good = {
  VITE_SUPABASE_URL: 'https://pqomylchauwecpgqxoad.supabase.co/',
  VITE_SUPABASE_ANON_KEY: 'anon-key',
  VITE_SITE_URL: 'https://bestie-pos.vercel.app',
};

describe('readPublicEnv', () => {
  it('returns the public config and normalises the URL to its origin', () => {
    expect(readPublicEnv(good)).toEqual({
      supabaseUrl: 'https://pqomylchauwecpgqxoad.supabase.co',
      supabaseAnonKey: 'anon-key',
      siteUrl: 'https://bestie-pos.vercel.app',
    });
  });

  it('returns undefined (not a crash) when the config is incomplete', () => {
    expect(readPublicEnv({})).toBeUndefined();
    expect(readPublicEnv({ ...good, VITE_SUPABASE_ANON_KEY: '  ' })).toBeUndefined();
  });

  it('rejects malformed or insecure URLs', () => {
    expect(() => readPublicEnv({ ...good, VITE_SUPABASE_URL: 'nope' })).toThrow(EnvError);
    expect(() => readPublicEnv({ ...good, VITE_SUPABASE_URL: 'http://evil.example' })).toThrow(
      EnvError,
    );
    expect(readPublicEnv({ ...good, VITE_SUPABASE_URL: 'http://127.0.0.1:54321' })).toBeDefined();
  });
});

describe('assertNoServerSecretsInClientEnv', () => {
  it('blocks a service_role key that would ship to the browser', () => {
    expect(() => assertNoServerSecretsInClientEnv({ VITE_SUPABASE_SERVICE_ROLE_KEY: 'x' })).toThrow(
      /server secret/,
    );
    expect(() => assertNoServerSecretsInClientEnv({ NEXT_PUBLIC_JWT_SECRET: 'x' })).toThrow(
      EnvError,
    );
  });

  it('allows server-side names and ordinary public names', () => {
    expect(() =>
      assertNoServerSecretsInClientEnv({ SUPABASE_SERVICE_ROLE_KEY: 'x', ...good }),
    ).not.toThrow();
  });
});
