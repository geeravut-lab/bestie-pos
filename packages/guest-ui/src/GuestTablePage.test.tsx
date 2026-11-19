import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { GuestTablePage } from './GuestTablePage';
import { tableTokenFromPath } from './index';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TOKEN = 'a'.repeat(32);
const MENU = {
  store: { name: 'Acme Kitchen' },
  table: { name: 'T1' },
  autoSend: false,
  menu: {
    categories: [
      { id: 'c1', name: { th: 'จานหลัก', en: 'Mains' } },
      { id: 'c2', name: { th: 'เครื่องดื่ม', en: 'Drinks' } },
    ],
    items: [
      {
        id: 'i1',
        category_id: 'c1',
        name: { th: 'ผัดไทย', en: 'Pad Thai' },
        price: 18000,
        group_ids: ['g1'],
      },
      {
        id: 'i2',
        category_id: 'c2',
        name: { th: 'น้ำเปล่า', en: 'Water' },
        price: 2000,
        group_ids: [],
      },
    ],
    groups: [
      {
        id: 'g1',
        name: { th: 'เผ็ด', en: 'Spice' },
        min: 1,
        max: 1,
        options: [
          { id: 'o1', name: { th: 'น้อย', en: 'Mild' }, delta: 0 },
          { id: 'o2', name: { th: 'มาก', en: 'Hot' }, delta: 500 },
        ],
      },
    ],
  },
  bill: { order_id: null, lines: [] },
};

const ATT = '40000000-0000-4000-8000-000000000001';
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function stubFetch(handlers: {
  menu?: () => Response;
  order?: (body: unknown) => Response;
  pay?: () => Response;
  payStatus?: () => Response;
  payCancel?: () => Response;
}) {
  const orders: unknown[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('/api/guest/menu')) return (handlers.menu ?? (() => json(MENU)))();
    if (u.startsWith('/api/guest/pay?'))
      return (
        handlers.payStatus ?? (() => json({ status: 'pending', amount: 100, receipt: null }))
      )();
    if (u === '/api/guest/pay-cancel')
      return (handlers.payCancel ?? (() => json({ status: 'canceled' })))();
    if (u === '/api/guest/pay')
      return (
        handlers.pay ??
        (() => json({ attempt_id: ATT, amount: 23100, qr_image_url: 'https://q.example/qr.png' }))
      )();
    if (u === '/api/guest/order') {
      const body = JSON.parse(String(init?.body)) as unknown;
      orders.push(body);
      return (handlers.order ?? (() => json({ number: 'QR001', lines: 1, status: 'waiting' })))(
        body,
      );
    }
    return json(null, 404);
  });
  vi.stubGlobal('fetch', f);
  return { f, orders };
}

const mount = () =>
  render(
    <I18nProvider initialLang="en">
      <GuestTablePage token={TOKEN} />
    </I18nProvider>,
  );

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', {
    randomUUID: (() => {
      let n = 0;
      return () => `20000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    })(),
  });
});

describe('tableTokenFromPath', () => {
  it('only accepts /t/<hex token>', () => {
    expect(tableTokenFromPath(`/t/${TOKEN}`)).toBe(TOKEN);
    expect(tableTokenFromPath(`/t/${TOKEN}/`)).toBe(TOKEN);
    expect(tableTokenFromPath('/t/short')).toBeNull();
    expect(tableTokenFromPath('/tables')).toBeNull();
    expect(tableTokenFromPath('/')).toBeNull();
  });
});

describe('<GuestTablePage>', () => {
  it('shows the shop, the table and the menu in the chosen language', async () => {
    stubFetch({});
    mount();
    expect(await screen.findByRole('heading', { name: 'Acme Kitchen' })).toBeTruthy();
    expect(screen.getByText('Table T1')).toBeTruthy();
    expect(screen.getByText('Pad Thai')).toBeTruthy();
    expect(screen.getByText('฿180')).toBeTruthy();
  });

  it('filters by category', async () => {
    stubFetch({});
    mount();
    await screen.findByText('Pad Thai');
    await userEvent.click(screen.getByRole('button', { name: 'Drinks' }));
    expect(screen.queryByText('Pad Thai')).toBeNull();
    expect(screen.getByText('Water')).toBeTruthy();
  });

  it('will not add a dish before its required option is chosen, then adds it with the option price', async () => {
    stubFetch({});
    mount();
    await userEvent.click(await screen.findByText('Pad Thai'));
    const dialog = screen.getByRole('dialog');
    const add = within(dialog).getByRole('button', { name: /Add to basket/ }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await userEvent.click(within(dialog).getByLabelText(/Hot/));
    expect(add.disabled).toBe(false);
    expect(add.textContent).toContain('฿185');
    await userEvent.click(add);
    const cart = screen.getByRole('region', { name: 'Your basket' });
    expect(within(cart).getByText('Pad Thai')).toBeTruthy();
    expect(within(cart).getByText('Hot')).toBeTruthy();
  });

  it('sends only ids, quantities and options — then shows the "waiting for staff" confirmation', async () => {
    const { orders } = stubFetch({});
    mount();
    await userEvent.click(await screen.findByText('Water'));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /Add to basket/ }),
    );
    await userEvent.click(screen.getByRole('button', { name: /Place order/ }));
    expect(await screen.findByText('Order sent')).toBeTruthy();
    expect(screen.getByText('The staff will confirm your order shortly.')).toBeTruthy();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      token: TOKEN,
      lines: [{ item_id: 'i2', quantity: 1, option_ids: [], note: '' }],
    });
    expect(JSON.stringify(orders[0])).not.toMatch(/price|total|amount/i);
  });

  it('the basket survives closing the page (kept on this phone), and is emptied once the order is sent', async () => {
    localStorage.clear();
    const { orders } = stubFetch({});
    const first = mount();
    await userEvent.click(await screen.findByText('Water'));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /Add to basket/ }),
    );
    expect(localStorage.getItem(`bestie-guest-cart:${TOKEN}`)).toContain('i2');
    first.unmount(); // the guest closes the browser
    mount(); // … and opens the same table page again
    const cart = await screen.findByRole('region', { name: 'Your basket' });
    expect(within(cart).getByText('Water')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Place order/ }));
    expect(await screen.findByText('Order sent')).toBeTruthy();
    expect(orders).toHaveLength(1);
    expect(localStorage.getItem(`bestie-guest-cart:${TOKEN}`)).toBeNull(); // sent: nothing left to restore
  });

  it('a basket from another table is not mixed in, and a dish that is gone is dropped', async () => {
    localStorage.clear();
    localStorage.setItem(
      `bestie-guest-cart:${'b'.repeat(32)}`,
      JSON.stringify({
        at: Date.now(),
        lines: [{ key: 'k', itemId: 'i2', quantity: 1, optionIds: [], note: '' }],
      }),
    );
    localStorage.setItem(
      `bestie-guest-cart:${TOKEN}`,
      JSON.stringify({
        at: Date.now(),
        lines: [{ key: 'k2', itemId: 'gone', quantity: 1, optionIds: [], note: '' }],
      }),
    );
    stubFetch({});
    mount();
    await screen.findByText('Water');
    expect(screen.queryByRole('button', { name: /Place order/ })).toBeNull();
  });

  it('a failed send keeps the basket and a retry reuses the same order id (no double order)', async () => {
    let n = 0;
    const { orders } = stubFetch({
      order: () =>
        ++n === 1
          ? json({ error: 'server_error' }, 502)
          : json({ number: 'QR001', lines: 1, status: 'sent' }),
    });
    mount();
    await userEvent.click(await screen.findByText('Water'));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /Add to basket/ }),
    );
    await userEvent.click(screen.getByRole('button', { name: /Place order/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not send the order');
    await userEvent.click(screen.getByRole('button', { name: /Place order/ }));
    expect(await screen.findByText('Your order has reached the kitchen.')).toBeTruthy();
    const ids = (orders as { clientId: string }[]).map((o) => o.clientId);
    expect(ids[0]).toBe(ids[1]);
  });

  it('changing the basket after a failure starts a new order id', async () => {
    const { orders } = stubFetch({ order: () => json({ error: 'unavailable' }, 422) });
    mount();
    await userEvent.click(await screen.findByText('Water'));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /Add to basket/ }),
    );
    await userEvent.click(screen.getByRole('button', { name: /Place order/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('sold out');
    await userEvent.click(screen.getByRole('button', { name: 'One more Water' }));
    await userEvent.click(screen.getByRole('button', { name: /Place order/ }));
    await waitFor(() => expect(orders).toHaveLength(2));
    const ids = (orders as { clientId: string }[]).map((o) => o.clientId);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('lists what is already on the table with a guest-friendly status', async () => {
    stubFetch({
      menu: () =>
        json({
          ...MENU,
          bill: {
            order_id: 'o',
            lines: [
              {
                name: { th: 'ผัดไทย', en: 'Pad Thai' },
                quantity: 2,
                status: 'ready',
                amount: 36000,
              },
            ],
          },
        }),
    });
    mount();
    const bill = await screen.findByRole('region', { name: 'Already ordered' });
    expect(within(bill).getByText('2 × Pad Thai')).toBeTruthy();
    expect(within(bill).getByText('Ready to serve')).toBeTruthy();
  });

  it('says so when the QR is unknown or ordering is off', async () => {
    stubFetch({ menu: () => json({ error: 'not_found' }, 404) });
    mount();
    expect((await screen.findByRole('alert')).textContent).toContain('no longer works');
    cleanup();
    stubFetch({
      menu: () =>
        json({ error: 'ordering_off', store: { name: 'Acme' }, table: { name: 'T1' } }, 403),
    });
    mount();
    expect((await screen.findByRole('alert')).textContent).toContain('does not take orders by QR');
    expect(screen.getByRole('heading', { name: 'Acme' })).toBeTruthy();
  });

  it('offers a retry when the network is down', async () => {
    const f = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', f);
    mount();
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('<GuestTablePage> pay at the table', () => {
  const withBill = (pay: Record<string, unknown>) => () =>
    json({
      ...MENU,
      bill: {
        order_id: 'o',
        lines: [
          { name: { th: 'ผัดไทย', en: 'Pad Thai' }, quantity: 1, status: 'sent', amount: 18000 },
        ],
      },
      pay,
    });

  it('offers payment with the server’s total; pressing it shows the QR and the amount', async () => {
    stubFetch({ menu: withBill({ enabled: true, total: 23100, unconfirmed: false, live: null }) });
    mount();
    const region = await screen.findByRole('region', { name: 'Pay with PromptPay' });
    expect(within(region).getByText('฿231')).toBeTruthy();
    await userEvent.click(within(region).getByRole('button', { name: 'Pay with PromptPay' }));
    expect(await screen.findByRole('img', { name: /PromptPay QR/ })).toBeTruthy();
    expect(screen.getByText(/Scan this QR with your banking app to pay ฿231/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel payment' })).toBeTruthy();
  });

  it('is not offered when the shop has not switched it on, or there is nothing on the bill', async () => {
    stubFetch({ menu: withBill({ enabled: false, total: 23100, unconfirmed: false, live: null }) });
    mount();
    await screen.findByText('Pad Thai');
    expect(screen.queryByRole('region', { name: 'Pay with PromptPay' })).toBeNull();
  });

  it('waits for the staff when lines are unconfirmed (no pay button)', async () => {
    stubFetch({ menu: withBill({ enabled: true, total: 23100, unconfirmed: true, live: null }) });
    mount();
    expect(await screen.findByText(/staff are confirming your latest order/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pay with PromptPay' })).toBeNull();
  });

  it('resumes a QR that is already live after a reload', async () => {
    stubFetch({
      menu: withBill({
        enabled: true,
        total: 23100,
        unconfirmed: false,
        live: { attemptId: ATT, amount: 23100, qrImageUrl: 'https://q.example/live.png' },
      }),
    });
    mount();
    const img = (await screen.findByRole('img', { name: /PromptPay QR/ })) as HTMLImageElement;
    expect(img.src).toBe('https://q.example/live.png');
  });

  it('cancelling clears the QR and tells the server', async () => {
    const { f } = stubFetch({
      menu: withBill({
        enabled: true,
        total: 23100,
        unconfirmed: false,
        live: { attemptId: ATT, amount: 23100, qrImageUrl: 'https://q.example/live.png' },
      }),
    });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel payment' }));
    await waitFor(() => expect(screen.queryByRole('img', { name: /PromptPay QR/ })).toBeNull());
    expect(f.mock.calls.some((c) => String(c[0]) === '/api/guest/pay-cancel')).toBe(true);
  });

  it('a refused start shows the reason', async () => {
    stubFetch({
      menu: withBill({ enabled: true, total: 23100, unconfirmed: false, live: null }),
      pay: () => json({ error: 'unconfirmed' }, 409),
    });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Pay with PromptPay' }));
    expect((await screen.findByRole('alert')).textContent).toContain('waiting for the staff');
  });

  it('shows "paid" with the receipt number when the bank confirms', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stubFetch({
        menu: withBill({
          enabled: true,
          total: 23100,
          unconfirmed: false,
          live: { attemptId: ATT, amount: 23100, qrImageUrl: 'https://q.example/live.png' },
        }),
        payStatus: () => json({ status: 'succeeded', amount: 23100, receipt: 'A+000007' }),
      });
      mount();
      await screen.findByRole('img', { name: /PromptPay QR/ });
      await vi.advanceTimersByTimeAsync(3_500);
      expect(await screen.findByText('Paid. Thank you!')).toBeTruthy();
      expect(screen.getByText('Receipt A+000007')).toBeTruthy();
      expect(screen.queryByRole('img', { name: /PromptPay QR/ })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when the payment failed or needs review', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stubFetch({
        menu: withBill({
          enabled: true,
          total: 23100,
          unconfirmed: false,
          live: { attemptId: ATT, amount: 23100, qrImageUrl: 'https://q.example/live.png' },
        }),
        payStatus: () => json({ status: 'needs_review', amount: 23100, receipt: null }),
      });
      mount();
      await screen.findByRole('img', { name: /PromptPay QR/ });
      await vi.advanceTimersByTimeAsync(3_500);
      expect((await screen.findByRole('alert')).textContent).toContain('do not pay again');
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the discount from the customer's points above the amount to pay", async () => {
    stubFetch({
      menu: withBill({
        enabled: true,
        total: 19800,
        pointsDiscount: 3000,
        unconfirmed: false,
        live: null,
      }),
    });
    mount();
    const region = await screen.findByRole('region', { name: 'Pay with PromptPay' });
    expect(within(region).getByText('Discount from your points')).toBeTruthy();
    expect(within(region).getByText('−฿30')).toBeTruthy();
    expect(within(region).getByText('฿198')).toBeTruthy();
  });
});
