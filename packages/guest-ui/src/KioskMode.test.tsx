import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@bestie/i18n';
import { GuestTablePage } from './GuestTablePage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('crypto', {
    randomUUID: (() => {
      let n = 0;
      return () => `20000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    })(),
  });
});

const TOKEN = 'b'.repeat(32);
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const KIOSK = {
  store: { name: 'Palm Cafe' },
  table: { name: 'Front kiosk' },
  autoSend: false,
  kiosk: true,
  menu: {
    categories: [{ id: 'c1', name: { th: 'อาหาร', en: 'Food' } }],
    items: [
      { id: 'i2', category_id: 'c1', name: { th: 'น้ำ', en: 'Water' }, price: 2000, group_ids: [] },
    ],
    groups: [],
  },
  bill: { order_id: null, lines: [] },
  pay: { enabled: true, total: 5000, live: null, unconfirmed: false, pointsDiscount: 0 },
};
function stub(menu: unknown = KIOSK) {
  const orders: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('/api/guest/menu')) return json(menu);
      if (u === '/api/guest/order') {
        orders.push(JSON.parse(String(init?.body)));
        return json({ number: 'KS007', lines: 1, status: 'waiting' });
      }
      return json(null, 404);
    }),
  );
  return orders;
}
const mount = () =>
  render(
    <I18nProvider initialLang="en">
      <GuestTablePage token={TOKEN} />
    </I18nProvider>,
  );
const orderOne = async () => {
  await userEvent.click(await screen.findByText('Water'));
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: /Add to basket/ }),
  );
  await userEvent.click(screen.getByRole('button', { name: /Place order/ }));
};

describe('the self-order kiosk page', () => {
  it('shows the menu and the kiosk hint, but no call-staff, bill, payment or feedback', async () => {
    stub();
    mount();
    await screen.findByText('Water');
    expect(screen.getByText(/You pay at the counter/)).toBeTruthy();
    expect(screen.queryByText('Call the staff')).toBeNull();
    expect(screen.queryByRole('region', { name: /feedback/i })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Pay the bill' })).toBeNull();
  });

  it('after ordering shows the queue number big with the pay-at-the-counter message, then starts a new order', async () => {
    const orders = stub();
    mount();
    await orderOne();
    expect(await screen.findByText('KS007')).toBeTruthy();
    expect(screen.getByText('Your queue number')).toBeTruthy();
    expect(screen.getByText(/Please pay at the counter/)).toBeTruthy();
    expect(orders).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Start a new order' }));
    await waitFor(() => expect(screen.queryByText('KS007')).toBeNull());
    // a second customer: a fresh client id, so the order is a new one and not a repeat of the first
    await orderOne();
    expect(await screen.findByText('KS007')).toBeTruthy();
    expect(orders).toHaveLength(2);
    const ids = (orders as { clientId?: string; client_id?: string }[]).map(
      (o) => o.clientId ?? o.client_id,
    );
    expect(new Set(ids).size).toBe(2);
  });

  it('an ordinary table still shows the bill and the call-staff button', async () => {
    stub({ ...KIOSK, kiosk: false });
    mount();
    await screen.findByText('Water');
    expect(screen.getByText('Call the staff')).toBeTruthy();
    expect(screen.queryByText(/You pay at the counter/)).toBeNull();
  });
});

describe('the online-order page (kind web)', () => {
  const WEB = { ...KIOSK, kind: 'web' };
  it('asks for a name and a phone before the order can be sent, and sends them with it', async () => {
    const orders = stub(WEB);
    mount();
    await userEvent.click(await screen.findByText('Water'));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /Add to basket/ }),
    );
    const send = screen.getByRole('button', { name: /Place order/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Your name'), 'Anna');
    await userEvent.type(screen.getByLabelText(/^Phone/), '081 11');
    expect(send.disabled).toBe(true); // a phone needs at least 6 digits
    await userEvent.type(screen.getByLabelText(/^Phone/), '11111');
    expect(send.disabled).toBe(false);
    await userEvent.click(send);
    expect(await screen.findByText('KS007')).toBeTruthy();
    expect(screen.getByText(/Pay when you pick it up/)).toBeTruthy();
    expect((orders[0] as { contact: unknown }).contact).toEqual({
      name: 'Anna',
      phone: '081 1111111',
    });
    expect(localStorage.getItem(`bestie-guest-contact:${TOKEN}`)).toContain('Anna');
  });
  it('a kiosk asks for no contact details', async () => {
    stub();
    mount();
    await userEvent.click(await screen.findByText('Water'));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /Add to basket/ }),
    );
    expect(screen.queryByLabelText('Your name')).toBeNull();
    expect(
      (screen.getByRole('button', { name: /Place order/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe('the concierge page (kind info)', () => {
  it('shows information and call-the-staff, with no menu and no basket', async () => {
    stub({ ...KIOSK, kiosk: false, kind: 'info' });
    mount();
    expect(await screen.findByText(/Information and help for guests/)).toBeTruthy();
    expect(screen.getByText('Call the staff')).toBeTruthy();
    expect(screen.queryByText('Water')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Your basket' })).toBeNull();
  });
});
