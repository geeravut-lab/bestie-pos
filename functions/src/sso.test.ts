import { describe, expect, it, vi } from 'vitest';
import { SsoError, exchangeTicket, parseHubPayload, syntheticEmail } from './sso.js';
import type { SsoAdmin, SsoConfig } from './sso.js';

const config: SsoConfig = {
  hubExchangeUrl: 'https://hub.example/exchange',
  appSlug: 'bestie-pos',
  siteHost: 'bestie-pos.vercel.app',
};
const hubBody = (over: Record<string, unknown> = {}) => ({
  user: { id: 'hub-1', display_name: 'Nok', avatar_url: null, email: null, roles: ['admin'] },
  app_slug: 'bestie-pos',
  firebase: null,
  ...over,
});
const fetchOk = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

function fakeAdmin(over: Partial<SsoAdmin> = {}): SsoAdmin & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    findLinkedUser: vi.fn(async () => null),
    createLinkedUser: vi.fn(async (i) => {
      calls.push(`create:${i.email}`);
      return { userId: 'u-new', email: i.email };
    }),
    issueSession: vi.fn(async (email) => {
      calls.push(`session:${email}`);
      return { access_token: 'a', refresh_token: 'r' };
    }),
    fillProfile: vi.fn(async () => {
      calls.push('fill');
    }),
    ...over,
  };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'no error';
  } catch (e) {
    return e instanceof SsoError ? e.code : `other:${String(e)}`;
  }
};

describe('parseHubPayload', () => {
  it('accepts null display_name / avatar_url / email (LINE users often have no e-mail)', () => {
    const { user } = parseHubPayload(hubBody());
    expect(user).toEqual({ id: 'hub-1', display_name: 'Nok', avatar_url: null, email: null });
  });

  it('requires a non-empty string user id and an app_slug', () => {
    expect(() => parseHubPayload(hubBody({ user: { id: '' } }))).toThrow(SsoError);
    expect(() => parseHubPayload(hubBody({ user: { id: 5 } }))).toThrow(SsoError);
    expect(() => parseHubPayload(hubBody({ app_slug: undefined }))).toThrow(SsoError);
    expect(() => parseHubPayload(null)).toThrow(SsoError);
  });

  it('does not care that firebase is null and never exposes hub roles', () => {
    expect(JSON.stringify(parseHubPayload(hubBody()))).not.toContain('admin');
  });
});

describe('syntheticEmail', () => {
  it('builds a safe, deterministic address', () => {
    expect(syntheticEmail('Hub User/1', 'bestie-pos.vercel.app')).toBe(
      'aivora+hub-user-1@bestie-pos.vercel.app',
    );
  });
});

describe('exchangeTicket', () => {
  it('creates a new user for a first login, links by hub id, and returns only tokens + profile', async () => {
    const admin = fakeAdmin();
    const res = await exchangeTicket({
      ticket: 'ticket-123456',
      config,
      admin,
      fetchImpl: fetchOk(hubBody()),
    });
    expect(res).toEqual({
      access_token: 'a',
      refresh_token: 'r',
      profile: { display_name: 'Nok', avatar_url: null },
    });
    expect(admin.findLinkedUser).toHaveBeenCalledWith('hub-1'); // looked up by HUB id
    expect(admin.calls).toEqual([
      'create:aivora+hub-1@bestie-pos.vercel.app',
      'session:aivora+hub-1@bestie-pos.vercel.app',
    ]);
  });

  it('uses the synthetic address even when the hub supplies an e-mail (no account takeover / squatting)', async () => {
    const admin = fakeAdmin();
    await exchangeTicket({
      ticket: 'ticket-123456',
      config,
      admin,
      fetchImpl: fetchOk(
        hubBody({
          user: { id: 'hub-2', display_name: null, avatar_url: null, email: 'victim@example.com' },
        }),
      ),
    });
    expect(admin.createLinkedUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'aivora+hub-2@bestie-pos.vercel.app',
        hubEmail: 'victim@example.com',
      }),
    );
    expect(admin.findLinkedUser).not.toHaveBeenCalledWith('victim@example.com');
  });

  it('reuses the linked user and only fills empty profile fields on later logins', async () => {
    const admin = fakeAdmin({
      findLinkedUser: vi.fn(async () => ({ userId: 'u-1', email: 'aivora+hub-1@x' })),
    });
    await exchangeTicket({ ticket: 'ticket-123456', config, admin, fetchImpl: fetchOk(hubBody()) });
    expect(admin.createLinkedUser).not.toHaveBeenCalled();
    expect(admin.calls).toEqual(['fill', 'session:aivora+hub-1@x']);
  });

  it('rejects a ticket issued for another app', async () => {
    expect(
      await code(
        exchangeTicket({
          ticket: 'ticket-123456',
          config,
          admin: fakeAdmin(),
          fetchImpl: fetchOk(hubBody({ app_slug: 'other-app' })),
        }),
      ),
    ).toBe('slug_mismatch');
  });

  it.each([400, 401, 403, 404, 410])(
    'maps hub status %i to invalid_ticket (401), not 502',
    async (status) => {
      const err = await exchangeTicket({
        ticket: 'ticket-123456',
        config,
        admin: fakeAdmin(),
        fetchImpl: fetchOk({ error: 'x' }, status),
      }).catch((e: SsoError) => e);
      expect((err as SsoError).code).toBe('invalid_ticket');
      expect((err as SsoError).status).toBe(401);
    },
  );

  it('502 only when the hub is really unreachable or broken', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(
      await code(
        exchangeTicket({ ticket: 'ticket-123456', config, admin: fakeAdmin(), fetchImpl: down }),
      ),
    ).toBe('hub_unreachable');
    expect(
      await code(
        exchangeTicket({
          ticket: 'ticket-123456',
          config,
          admin: fakeAdmin(),
          fetchImpl: fetchOk({}, 500),
        }),
      ),
    ).toBe('hub_unreachable');
    expect(
      await code(
        exchangeTicket({
          ticket: 'ticket-123456',
          config,
          admin: fakeAdmin(),
          fetchImpl: fetchOk({ nonsense: true }),
        }),
      ),
    ).toBe('bad_payload');
  });

  it('validates the ticket and the configuration before calling the hub', async () => {
    const fetchSpy = fetchOk(hubBody());
    expect(
      await code(
        exchangeTicket({ ticket: undefined, config, admin: fakeAdmin(), fetchImpl: fetchSpy }),
      ),
    ).toBe('bad_request');
    expect(
      await code(exchangeTicket({ ticket: 'x', config, admin: fakeAdmin(), fetchImpl: fetchSpy })),
    ).toBe('bad_request');
    expect(
      await code(
        exchangeTicket({
          ticket: 'ticket-123456',
          config: { ...config, appSlug: '' },
          admin: fakeAdmin(),
          fetchImpl: fetchSpy,
        }),
      ),
    ).toBe('not_configured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never leaks service credentials or hub roles in the result', async () => {
    const res = await exchangeTicket({
      ticket: 'ticket-123456',
      config,
      admin: fakeAdmin(),
      fetchImpl: fetchOk(hubBody()),
    });
    const text = JSON.stringify(res);
    expect(text).not.toMatch(/service_role|roles|firebase/);
  });
});
