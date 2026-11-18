import { describe, expect, it, vi } from 'vitest';
import { hubExchangeUrl, ssoExchangeResponse } from './sso-handler.js';

const post = (body: unknown) =>
  new Request('https://x/api/sso-exchange', { method: 'POST', body: JSON.stringify(body) });

describe('hubExchangeUrl', () => {
  it('prefers the explicit URL, then derives it from AIVORA_HUB_URL, then the default hub', () => {
    expect(
      hubExchangeUrl({
        AIVORA_HUB_EXCHANGE_URL: 'https://x/exchange',
        AIVORA_HUB_URL: 'https://hub',
      }),
    ).toBe('https://x/exchange');
    expect(hubExchangeUrl({ AIVORA_HUB_URL: 'https://hub.example/' })).toBe(
      'https://hub.example/api/public/sso/exchange',
    );
    expect(hubExchangeUrl({})).toBe('https://aivora-lc.netlify.app/api/public/sso/exchange');
  });
});

describe('ssoExchangeResponse', () => {
  it('only accepts POST', async () => {
    const res = await ssoExchangeResponse(new Request('https://x/api/sso-exchange'), {});
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('answers 500 (not a crash, not a leak) when the server is not configured, and logs the cause', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await ssoExchangeResponse(post({ ticket: 'ticket-123456' }), {
      SUPABASE_URL: 'https://secret-project.supabase.co',
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'server_error' });
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0])).toContain('SUPABASE_SERVICE_ROLE_KEY'); // names are logged…
    expect(String(spy.mock.calls[0])).not.toContain('secret-project'); // …values never
    spy.mockRestore();
  });

  it('answers 401 for a bad ticket body once configured, never 502', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = {
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
      AIVORA_APP_SLUG: 'bestie-pos',
    };
    const res = await ssoExchangeResponse(post({ nope: 1 }), env);
    expect(res.status).toBe(400);
    spy.mockRestore();
  });
});
