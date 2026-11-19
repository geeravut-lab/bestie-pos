import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { AuthProvider } from './context';
import { LineConnect } from './LineConnect';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const client = () =>
  ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: 'jwt-1', user: { id: 'u1' } } },
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
    }),
    rpc: async () => ({ data: false }),
    channel: () => ({
      on() {
        return this;
      },
      subscribe() {
        return this;
      },
    }),
    removeChannel: async () => 'ok',
  }) as never;

const mount = () =>
  render(
    <I18nProvider initialLang="en">
      <AuthProvider client={client()}>
        <LineConnect />
      </AuthProvider>
    </I18nProvider>,
  );

type Call = { method: string; url: string };
function stubApi(handler: (c: Call) => unknown, status = 200) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const c = { method: init.method ?? 'GET', url };
      calls.push(c);
      return new Response(JSON.stringify(handler(c)), { status });
    }),
  );
  return calls;
}

describe('<LineConnect>', () => {
  beforeEach(() => vi.useRealTimers());

  it('says so plainly when the channel is not configured', async () => {
    stubApi(() => ({ available: false }));
    mount();
    expect(await screen.findByText('The LINE channel is not available yet.')).toBeTruthy();
  });

  it('shows four numbered steps with the code once, the add-friend link and a chat link with the code pre-typed', async () => {
    const calls = stubApi((c) =>
      c.method === 'POST'
        ? {
            available: true,
            code: 'ABCD2345',
            expiresAt: '2026-11-18T10:30:00.000Z',
            basicId: '@bestie',
          }
        : { available: true, basicId: '@bestie', channel: null },
    );
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect LINE' }));
    expect(await screen.findByLabelText('Link code')).toHaveProperty('textContent', 'ABCD2345');
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(
      screen.getByRole('link', { name: 'Open the add-friend page' }).getAttribute('href'),
    ).toBe('https://line.me/R/ti/p/%40bestie');
    expect(
      screen.getByRole('link', { name: 'Open the chat and send the code' }).getAttribute('href'),
    ).toBe('https://line.me/R/oaMessage/%40bestie/?ABCD2345');
    expect(calls.some((c) => c.method === 'POST')).toBe(true);
    expect(screen.getByRole('button', { name: 'Get a new code' })).toBeTruthy();
    // a silent bot gets a hint of what to do next, right under the steps
    expect(screen.getByText('Sent the code and the bot did not answer?')).toBeTruthy();
    expect(screen.getByText(/Check the LINE connection/)).toBeTruthy();
  });

  it(
    'polls every 4 seconds and switches to "connected" by itself, dropping the code from the page',
    { timeout: 15_000 },
    async () => {
      let connected = false;
      stubApi((c) =>
        c.method === 'POST'
          ? {
              available: true,
              code: 'ABCD2345',
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
              basicId: '@bestie',
            }
          : {
              available: true,
              basicId: '@bestie',
              channel: connected ? { status: 'active', expiresAt: null, lastError: null } : null,
            },
      );
      mount();
      await userEvent.click(await screen.findByRole('button', { name: 'Connect LINE' }));
      await screen.findByLabelText('Link code');
      connected = true; // the next 4 s poll sees it
      expect(await screen.findByText('LINE is connected', {}, { timeout: 7000 })).toBeTruthy();
      expect(screen.queryByLabelText('Link code')).toBeNull();
    },
  );

  it('connected: test notification and disconnect; a rate limit becomes a readable message', async () => {
    const calls = stubApi((c) =>
      c.url.includes('op=test')
        ? { outcome: 'sent' }
        : c.method === 'DELETE'
          ? { ok: true }
          : {
              available: true,
              basicId: '@bestie',
              channel: { status: 'active', expiresAt: null, lastError: null },
            },
    );
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Send a test notification' }));
    expect(await screen.findByText('Sent. Please check LINE.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    cleanup();
    stubApi(() => ({}), 429);
    mount();
    expect((await screen.findByRole('alert')).textContent).toContain('Too many attempts');
  });

  it('a stopped channel explains why and offers to connect again', async () => {
    stubApi(() => ({
      available: true,
      basicId: '@bestie',
      channel: { status: 'stopped', expiresAt: null, lastError: 'unfollowed' },
    }));
    mount();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Sending stopped (unfollowed)',
    );
    expect(screen.getByRole('button', { name: 'Connect LINE' })).toBeTruthy();
  });
});
