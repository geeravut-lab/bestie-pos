import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import type { PageContext } from '@bestie/auth';
import { CreditOnlineTopup } from './CreditOnlineTopup';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** status of the attempt row, and whether a live top-up already exists */
function fakeClient(o: { status?: string; live?: boolean } = {}) {
  const from = () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: { status: o.status ?? 'pending', error: null },
          error: null,
        }),
        eq: () => ({
          in: () => ({
            limit: async () => ({
              data: o.live
                ? [
                    {
                      id: 'att-live',
                      tender: 'promptpay',
                      amount: 50000,
                      qr_url: 'https://qr/l.png',
                    },
                  ]
                : [],
              error: null,
            }),
          }),
        }),
      }),
    }),
  });
  return {
    auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) },
    from,
  } as never;
}
const ctx = (client: unknown): PageContext => ({
  path: '/customers',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: [],
  isOwner: true,
  isPlatformAdmin: false,
});
const mount = (client: unknown, over: Partial<Parameters<typeof CreditOnlineTopup>[0]> = {}) => {
  const props = {
    ctx: ctx(client),
    customerId: 'c1',
    storeId: 's1',
    deviceId: 'd1',
    hasReader: true,
    amount: 50000,
    amountOk: true,
    onBadAmount: vi.fn(),
    onCredited: vi.fn(),
    ...over,
  };
  render(
    <I18nProvider initialLang="en">
      <CreditOnlineTopup {...props} />
    </I18nProvider>,
  );
  return props;
};

describe('<CreditOnlineTopup>', () => {
  it('asks the server for a top-up (never a bill) and shows the QR; Card appears only with a reader', async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ attempt_id: 'att1', amount: 50000, qr_image_url: 'https://qr/1.png' }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', f);
    mount(fakeClient());
    expect(screen.getByRole('button', { name: 'Top up with the card reader' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Top up by PromptPay QR' }));
    expect(await screen.findByAltText('PromptPay QR code for this payment')).toBeTruthy();
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toEqual({
      topup: {
        customer_id: 'c1',
        store_id: 's1',
        device_id: 'd1',
        tender: 'promptpay',
        amount: 50000,
      },
    });
  });

  it('no reader → no card button', () => {
    mount(fakeClient(), { hasReader: false });
    expect(screen.queryByRole('button', { name: 'Top up with the card reader' })).toBeNull();
  });

  it('a bad amount never reaches the server', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const p = mount(fakeClient(), { amountOk: false, amount: null });
    await userEvent.click(screen.getByRole('button', { name: 'Top up by PromptPay QR' }));
    expect(p.onBadAmount).toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });

  it('a refusal from the server is shown as a sentence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ error: 'attempt_pending' }), { status: 409 }),
      ),
    );
    mount(fakeClient());
    await userEvent.click(screen.getByRole('button', { name: 'Top up by PromptPay QR' }));
    expect(await screen.findByText(/already has a top-up waiting/)).toBeTruthy();
  });

  it('a top-up that is already waiting is shown again (not duplicated)', async () => {
    mount(fakeClient({ live: true }));
    expect(await screen.findByText(/still waiting; showing it again/)).toBeTruthy();
  });

  it('tells the till when the money has been credited', async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ attempt_id: 'att1', amount: 50000, qr_image_url: 'https://qr/1.png' }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', f);
    const p = mount(fakeClient({ status: 'succeeded' }));
    await userEvent.click(screen.getByRole('button', { name: 'Top up by PromptPay QR' }));
    await waitFor(() => expect(p.onCredited).toHaveBeenCalled(), { timeout: 4000 });
  });
});
