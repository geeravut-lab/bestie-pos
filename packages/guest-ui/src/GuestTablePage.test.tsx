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

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function stubFetch(handlers: { menu?: () => Response; order?: (body: unknown) => Response }) {
  const orders: unknown[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('/api/guest/menu')) return (handlers.menu ?? (() => json(MENU)))();
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
