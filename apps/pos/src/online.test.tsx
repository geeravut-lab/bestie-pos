import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addLine, newOrder, sendNew } from '@bestie/core';
import { getOrder, listOutbox, resetOfflineDb, saveOrder, setDeviceBinding } from '@bestie/offline';
import type { OnlinePay } from './onlinePay';
import { startOnlinePayment } from './onlinePay';
import { OrderPage } from './OrderPage';
import { PaySheet } from './PaySheet';
import { ORG, STORE, baseTables, bindTablet, mountEn, pageCtx, posClient } from './testKit';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setDeviceBinding(null);
});
beforeEach(async () => {
  await resetOfflineDb();
  localStorage.clear();
});

const fakeOnline = (over: Partial<OnlinePay> = {}): OnlinePay => ({
  available: true,
  hasReader: true,
  start: vi.fn(async (tender) => ({
    charge: {
      attemptId: 'att-1',
      tender,
      amount: 16000,
      qrImageUrl: tender === 'promptpay' ? 'https://qr.example/1.png' : null,
    },
  })),
  cancel: vi.fn(async () => {}),
  status: vi.fn(async () => ({ status: 'pending' as const, error: null })),
  findLive: vi.fn(async () => null),
  finish: vi.fn(async () => {}),
  ...over,
});
const sheet = (online: OnlinePay) =>
  mountEn(
    <PaySheet
      total={16000}
      rule="none"
      online={online}
      onPay={async () => null}
      onClose={() => {}}
    />,
  );

describe('<PaySheet> payment-method switches', () => {
  const with_ = (methods: { promptpay: boolean; gateway: boolean }) =>
    mountEn(
      <PaySheet
        total={16000}
        rule="none"
        online={fakeOnline()}
        methods={methods}
        onPay={async () => null}
        onClose={() => {}}
      />,
    );
  it('a method the owner switched off has no tab; cash is always there', () => {
    with_({ promptpay: false, gateway: true });
    expect(screen.getByRole('tab', { name: 'Cash' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'PromptPay QR' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Card' })).toBeTruthy();
    cleanup();
    with_({ promptpay: false, gateway: false });
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });
});

describe('<PaySheet> online tabs', () => {
  it('offers cash first, and PromptPay / card need the network and (for card) a reader', async () => {
    sheet(fakeOnline({ available: false }));
    expect(screen.getByRole('tab', { name: 'Cash', selected: true })).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'PromptPay QR' }));
    expect(screen.getByText('PromptPay and card need an internet connection.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show QR for the guest to scan' })).toBeNull();
    cleanup();
    sheet(fakeOnline({ hasReader: false }));
    await userEvent.click(screen.getByRole('tab', { name: 'Card' }));
    expect(screen.getByText(/no card reader set up/)).toBeTruthy();
  });

  it('shows the QR for the exact amount and waits; cancel returns to the start', async () => {
    const online = fakeOnline();
    sheet(online);
    await userEvent.click(screen.getByRole('tab', { name: 'PromptPay QR' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Show QR for the guest to scan' }),
    );
    expect(online.start).toHaveBeenCalledWith('promptpay');
    expect(
      (await screen.findByAltText('PromptPay QR code for this payment')).getAttribute('src'),
    ).toBe('https://qr.example/1.png');
    expect(screen.getByText(/Amount ฿160/)).toBeTruthy();
    expect(screen.getByText('Waiting for the guest to pay')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel this payment' }));
    expect(online.cancel).toHaveBeenCalledWith('att-1');
    expect(
      await screen.findByRole('button', { name: 'Show QR for the guest to scan' }),
    ).toBeTruthy();
  });

  it('card: sends the amount to the reader and tells the guest to tap', async () => {
    const online = fakeOnline();
    sheet(online);
    await userEvent.click(screen.getByRole('tab', { name: 'Card' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Send the amount to the card reader' }),
    );
    expect(online.start).toHaveBeenCalledWith('gateway');
    expect(await screen.findByText(/tap or insert their card/)).toBeTruthy();
    expect(screen.queryByAltText('PromptPay QR code for this payment')).toBeNull();
  });

  it('polls, and when the server says it succeeded the bill is fetched (finish)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    const online = fakeOnline({
      status: vi.fn(async () => ({
        status: ++n < 3 ? ('pending' as const) : ('succeeded' as const),
        error: null,
      })),
    });
    sheet(online);
    await userEvent.click(screen.getByRole('tab', { name: 'PromptPay QR' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Show QR for the guest to scan' }),
    );
    await screen.findByAltText('PromptPay QR code for this payment');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    expect(online.finish).toHaveBeenCalledTimes(1);
  });

  it('a failed payment says why and lets the cashier try again; a mismatch asks for a manager and never offers a retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sheet(
      fakeOnline({
        status: vi.fn(async () => ({ status: 'failed' as const, error: 'card_declined' })),
      }),
    );
    await userEvent.click(screen.getByRole('tab', { name: 'PromptPay QR' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Show QR for the guest to scan' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(await screen.findByText('The payment did not go through (card_declined)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    cleanup();
    sheet(
      fakeOnline({
        status: vi.fn(async () => ({ status: 'needs_review' as const, error: 'amount differs' })),
      }),
    );
    await userEvent.click(screen.getByRole('tab', { name: 'PromptPay QR' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Show QR for the guest to scan' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(await screen.findByText(/Do not take payment again/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a payment that is already waiting for this bill is shown again instead of starting a second one', async () => {
    const online = fakeOnline({
      findLive: vi.fn(async () => ({
        attemptId: 'old',
        tender: 'promptpay' as const,
        amount: 16000,
        qrImageUrl: 'https://qr.example/old.png',
      })),
    });
    sheet(online);
    await userEvent.click(screen.getByRole('tab', { name: 'PromptPay QR' }));
    expect(
      (await screen.findByAltText('PromptPay QR code for this payment')).getAttribute('src'),
    ).toBe('https://qr.example/old.png');
    expect(screen.getByText(/already had a payment waiting/)).toBeTruthy();
    expect(online.start).not.toHaveBeenCalled();
  });

  it('shows a clear message when starting fails', async () => {
    sheet(fakeOnline({ start: vi.fn(async () => ({ error: 'err_pay_provider' as const })) }));
    await userEvent.click(screen.getByRole('tab', { name: 'PromptPay QR' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Show QR for the guest to scan' }),
    );
    expect(await screen.findByText(/did not answer/)).toBeTruthy();
  });
});

describe('startOnlinePayment', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const binding = {
    deviceId: 'dev-1',
    storeId: STORE,
    orgId: ORG,
    name: 'Counter',
    code: 'A',
    role: 'cashier' as const,
    station: null,
    posId: 'POS-77',
    reader: true,
  };
  const cfg = { priceMode: 'inclusive' as const, vatBps: 700, serviceChargeBps: 0 };
  const seed = async (sent: boolean) => {
    let o = newOrder({
      id: ID,
      orgId: ORG,
      storeId: STORE,
      number: 'A001',
      channel: 'takeaway',
      now: Date.now(),
    });
    o = addLine(o, {
      lineId: 'l1',
      item: { id: 'i1', name: { th: 'ผัดไทย' }, prices: { base: 8000 }, station: 'kitchen' },
      groups: [],
      selected: [],
      quantity: 2,
    });
    if (sent) o = sendNew(o, Date.now()).order;
    await saveOrder(null, o);
  };
  const client = (insertError: unknown = null) =>
    ({
      from: () => ({
        insert: async () => ({ error: insertError }),
        update: () => ({
          eq: () => ({ select: async () => ({ data: [{ id: 'x' }], error: null }) }),
        }),
      }),
      rpc: async () => ({ error: null }),
      auth: { getSession: async () => ({ data: { session: { access_token: 'user-jwt' } } }) },
    }) as never;
  const stubFetch = (status: number, body: unknown) => {
    const f = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', f);
    return f;
  };
  const run = (c = client()) =>
    startOnlinePayment({
      client: c,
      orderId: ID,
      tender: 'promptpay',
      binding,
      billConfig: cfg,
      staffId: 'st1',
      lang: 'th',
    });

  it('sends the unsent lines to the kitchen, flushes the queue, then asks the server with the bill exactly as shown', async () => {
    await seed(false);
    const f = stubFetch(200, {
      attempt_id: 'att-9',
      amount: 16000,
      qr_image_url: 'https://qr/9.png',
    });
    const r = await run();
    expect(r).toEqual({
      charge: {
        attemptId: 'att-9',
        tender: 'promptpay',
        amount: 16000,
        qrImageUrl: 'https://qr/9.png',
      },
    });
    expect((await getOrder(ID))!.lines[0]!.status).toBe('sent');
    expect(await listOutbox()).toEqual([]); // everything reached the server first
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/stripe/charge');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer user-jwt');
    expect(JSON.parse(init.body as string).snapshot).toMatchObject({
      order_id: ID,
      device_id: 'dev-1',
      staff_id: 'st1',
      tender: 'promptpay',
      subtotal: 16000,
      total: 16000,
      payable: 16000,
      rounding: 0,
      vat_bps: 700,
    });
  });

  it('a split bill sends its cash / Credit shares with the digital share and rounds only the cash', async () => {
    await seed(true); // 160.00 total
    const f = stubFetch(200, { attempt_id: 'att-s', amount: 5975, qr_image_url: null });
    const r = await startOnlinePayment({
      client: client(),
      orderId: ID,
      tender: 'promptpay',
      binding,
      billConfig: cfg,
      staffId: 'st1',
      lang: 'en',
      split: {
        rule: 'nearest-50',
        creditBalance: 9000,
        legs: [
          { tender: 'credit', amount: 5000 },
          { tender: 'cash', amount: 5025, tendered: 6000 },
          { tender: 'promptpay', amount: 5975 },
        ],
      },
    });
    expect(r).toMatchObject({ charge: { attemptId: 'att-s', tender: 'promptpay', amount: 5975 } });
    const snap = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
      .snapshot as {
      legs: { id: string; tender: string; amount: number }[];
      rounding: number;
      payable: number;
      total: number;
    };
    expect(snap.legs.map((l) => [l.tender, l.amount])).toEqual([
      ['credit', 5000],
      ['cash', 5050],
    ]);
    expect(snap.legs.every((l) => /^[0-9a-f-]{36}$/.test(l.id))).toBe(true);
    expect(snap.rounding).toBe(25);
    expect(snap.payable).toBe(snap.total + 25);
  });

  it('several PromptPay shares: an earlier one is a HELD share (partial, no legs), the last one carries the cash and closes', async () => {
    await seed(true); // 160.00
    const legs = [
      { tender: 'promptpay' as const, amount: 5000 },
      { tender: 'cash' as const, amount: 5000, tendered: 5000 },
      { tender: 'promptpay' as const, amount: 6000 },
    ];
    const ask = async (shares: typeof legs, held: number) => {
      const f = stubFetch(200, { attempt_id: 'a1', amount: 0, qr_image_url: null });
      await startOnlinePayment({
        client: client(),
        orderId: ID,
        tender: 'promptpay',
        binding,
        billConfig: cfg,
        lang: 'en',
        split: { rule: 'none', creditBalance: null, legs: shares, step: 0, held },
      });
      return JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
        .snapshot as Record<string, unknown>;
    };
    const first = await ask(legs, 0);
    expect(first).toMatchObject({ partial: true, partial_amount: 5000, legs: [], payable: 16000 });
    const last = await ask(legs.slice(1), 5000); // the first share is held now: the rest is the cash and the last QR
    expect(last.partial).toBeUndefined();
    expect((last.legs as { tender: string }[]).map((l) => l.tender)).toEqual(['cash']);
  });

  it('a split that does not add up to the bill is not started', async () => {
    await seed(true);
    const f = stubFetch(200, { attempt_id: 'x' });
    expect(
      await startOnlinePayment({
        client: client(),
        orderId: ID,
        tender: 'promptpay',
        binding,
        billConfig: cfg,
        lang: 'en',
        split: {
          rule: 'none',
          creditBalance: null,
          legs: [
            { tender: 'cash', amount: 5000 },
            { tender: 'promptpay', amount: 5000 },
          ],
        },
      }),
    ).toEqual({ error: 'err_pay_failed' });
    expect(f).not.toHaveBeenCalled();
  });

  it('does not ask the server while the bill has not reached it yet', async () => {
    await seed(true);
    const f = stubFetch(200, { attempt_id: 'x' });
    expect(await run(client({ message: 'Failed to fetch' }))).toEqual({ error: 'err_pay_sync' });
    expect(f).not.toHaveBeenCalled();
  });

  it('offline: no request at all', async () => {
    await seed(true);
    const f = stubFetch(200, {});
    vi.spyOn(globalThis.navigator, 'onLine', 'get').mockReturnValue(false);
    expect(await run()).toEqual({ error: 'err_pay_offline' });
    expect(f).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("maps the server's answers to sentences", async () => {
    await seed(true);
    for (const [status, body, key] of [
      [409, { error: 'attempt_pending' }, 'err_pay_pending'],
      [502, { error: 'provider_error', code: 'x' }, 'err_pay_provider'],
      [503, { error: 'not_configured' }, 'err_pay_not_configured'],
      [403, { error: 'forbidden' }, 'err_forbidden'],
      [422, { error: 'invalid' }, 'err_pay_failed'],
    ] as const) {
      stubFetch(status, body);
      expect(await run(), String(status)).toEqual({ error: key });
    }
  });

  it('a closed or empty bill is not charged', async () => {
    const f = stubFetch(200, { attempt_id: 'x' });
    await saveOrder(
      null,
      newOrder({
        id: ID,
        orgId: ORG,
        storeId: STORE,
        number: 'A001',
        channel: 'takeaway',
        now: Date.now(),
      }),
    );
    expect(await run()).toEqual({ error: 'err_pay_failed' });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('paying a bill by PromptPay from the order screen', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  it('QR → the server closes the bill → the till shows the receipt', async () => {
    bindTablet();
    let o = newOrder({
      id: ID,
      orgId: ORG,
      storeId: STORE,
      number: 'A001',
      channel: 'takeaway',
      now: Date.now(),
    });
    o = sendNew(
      addLine(o, {
        lineId: 'l1',
        item: {
          id: 'i1',
          name: { th: 'ผัดไทย', en: 'Pad Thai' },
          prices: { base: 8000 },
          station: 'kitchen',
        },
        groups: [],
        selected: [],
        quantity: 2,
      }),
      Date.now(),
    ).order;
    await saveOrder(null, o);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              attempt_id: 'att-1',
              amount: 16000,
              qr_image_url: 'https://qr/1.png',
            }),
            { status: 200 },
          ),
      ),
    );
    const tables = baseTables();
    (tables as Record<string, unknown[]>).payment_attempts = [{ status: 'succeeded', error: null }];
    const client = posClient(tables);
    // the queued order + line writes need an insert to flush with
    (client as unknown as { from: (t: string) => unknown }).from = ((orig) => (t: string) => {
      const c = orig(t) as Record<string, unknown>;
      c.insert = async () => ({ error: null });
      return c;
    })(client.from) as never;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ctx = pageCtx(client, { path: `/order/${ID}` });
    mountEn(<OrderPage ctx={ctx} orderId={ID} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Take payment' }));
    const dialog = await screen.findByRole('dialog', { name: 'Payment' });
    await userEvent.click(within(dialog).getByRole('tab', { name: 'PromptPay QR' }));
    await userEvent.click(
      await within(dialog).findByRole('button', { name: 'Show QR for the guest to scan' }),
    );
    await within(dialog).findByAltText('PromptPay QR code for this payment');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    await waitFor(() => expect(ctx.navigate).toHaveBeenCalledWith(`/receipt/${ID}`));
  });
});
