import { describe, expect, it } from 'vitest';
import { ServerEnvError, readServerEnv } from './env';
import { healthReport, healthResponse } from './health';

describe('healthReport', () => {
  it('reports configuration presence without leaking values', async () => {
    const env = {
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'super-secret',
    };
    const res = healthResponse(env);
    const body = await res.text();
    expect(JSON.parse(body).config).toEqual({ supabaseUrl: true, serviceRoleKey: true });
    expect(body).not.toContain('super-secret');
    expect(body).not.toContain('x.supabase.co');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('reports missing configuration as false', () => {
    expect(healthReport({}, new Date('2026-11-18T00:00:00Z')).config).toEqual({
      supabaseUrl: false,
      serviceRoleKey: false,
    });
  });
});

describe('readServerEnv', () => {
  it('returns trimmed values', () => {
    expect(
      readServerEnv({ SUPABASE_URL: ' https://x.supabase.co ', SUPABASE_SERVICE_ROLE_KEY: 'k' }),
    ).toEqual({
      supabaseUrl: 'https://x.supabase.co',
      serviceRoleKey: 'k',
    });
  });

  it('names what is missing but never prints values', () => {
    try {
      readServerEnv({ SUPABASE_URL: 'https://x.supabase.co' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ServerEnvError);
      expect((e as ServerEnvError).message).toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect((e as ServerEnvError).message).not.toContain('x.supabase.co');
    }
  });
});
