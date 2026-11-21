import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { FolioPage } from './FolioPage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const liveDb = (...args: Parameters<typeof fakeDb>) => {
  const db = fakeDb(...args);
  Object.assign(db.client as object, {
    channel: vi.fn(() => {
      const ch: Record<string, unknown> = {};
      ch.on = () => ch;
      ch.subscribe = (cb?: (s: string) => void) => {
        cb?.('SUBSCRIBED');
        return ch;
      };
      return ch;
    }),
    removeChannel: vi.fn(async () => 'ok'),
  });
  return db;
};
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/folio',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 'resort',
  permissions: ['order.create', 'payment.take', 'menu.edit', 'refund.create'],
  isOwner: true,
  isPlatformAdmin: false,
  ...over,
});
const wrap = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);
const tables = () => ({
  folio_rooms: [
    { id: 'r1', store_id: 'resort', name: '101', active: true, sort: 1, night_rate: 150000 },
    { id: 'r2', store_id: 'resort', name: '102', active: true, sort: 2, night_rate: null },
  ],
  folios: [
    {
      id: 'f1',
      room_id: 'r1',
      guest_name: 'Anna',
      phone: '0811',
      check_in_at: '2026-11-18T05:00:00Z',
      check_out_on: null,
      note: null,
      status: 'open',
      closed_at: null,
      night_rate: 150000,
    },
    {
      id: 'f9',
      room_id: 'r2',
      guest_name: 'Old guest',
      phone: null,
      check_in_at: '2026-11-10T05:00:00Z',
      check_out_on: null,
      note: null,
      status: 'closed',
      closed_at: '2026-11-12T05:00:00Z',
      night_rate: null,
    },
  ],
  folio_charges: [
    {
      id: 'n1',
      folio_id: 'f1',
      store_id: 'resort',
      kind: 'night',
      order_id: null,
      night_date: '2026-11-18',
      amount: 150000,
      receipt_number: null,
      voided_at: null,
      void_reason: null,
      created_at: '2026-11-19T00:10:00Z',
    },
    {
      id: 'n2',
      folio_id: 'f1',
      store_id: 'resort',
      kind: 'night',
      order_id: null,
      night_date: '2026-11-19',
      amount: 150000,
      receipt_number: null,
      voided_at: null,
      void_reason: null,
      created_at: '2026-11-20T00:10:00Z',
    },
    {
      id: 'c1',
      folio_id: 'f1',
      store_id: 'bar',
      kind: 'bill',
      order_id: 'o1',
      night_date: null,
      amount: 21000,
      receipt_number: 'A+000001',
      voided_at: null,
      void_reason: null,
      created_at: '2026-11-19T06:00:00Z',
    },
    {
      id: 'rt1',
      folio_id: 'f1',
      store_id: 'bar',
      kind: 'return',
      order_id: null,
      night_date: null,
      amount: -21000,
      receipt_number: null,
      voided_at: null,
      void_reason: null,
      created_at: '2026-11-19T08:00:00Z',
    },
  ],
  folio_settlements: [{ folio_id: 'f9', amount: 0, method: 'none' }],
  stores: [
    { id: 'resort', name: 'Palm Resort' },
    { id: 'bar', name: 'Pool Bar' },
  ],
  devices: [{ id: 'd1', name: 'Front desk' }],
});

describe('<FolioPage> v2', () => {
  it('lists the nights, the bills and the returns of a stay, with the balance', async () => {
    const db = liveDb(tables());
    wrap(<FolioPage ctx={ctx(db.client)} />);
    expect(await screen.findByText(/Room night of 2026-11-18/)).toBeTruthy();
    expect(screen.getByText(/Room night of 2026-11-19/)).toBeTruthy();
    expect(screen.getByText(/A\+000001/)).toBeTruthy();
    expect(screen.getByText(/Return/)).toBeTruthy();
    // 2 nights of 1,500 + a 210 bill - a 210 return
    expect(screen.getByText(/Balance: ฿3,000/)).toBeTruthy();
    expect(screen.getByText(/฿1,500 per night/, { selector: 'p' })).toBeTruthy();
  });

  it('a return line cannot be taken off, a night can', async () => {
    const db = liveDb(tables());
    wrap(<FolioPage ctx={ctx(db.client)} />);
    await screen.findByText(/Room night of 2026-11-18/);
    expect(screen.getAllByRole('button', { name: /take.*off|void/i }).length).toBe(3);
  });

  it('posts the nights that have passed and says how many', async () => {
    const db = liveDb(tables(), { rpc: { folio_post_nights: { data: 2 } } });
    wrap(<FolioPage ctx={ctx(db.client)} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Post the nights that have passed now' }),
    );
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'folio_post_nights')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'folio_post_nights')!.args).toEqual({ p_folio: 'f1' });
    expect(await screen.findByText('2 night(s) posted')).toBeTruthy();
  });

  it('does not offer the nights button to someone who cannot take payments', async () => {
    const db = liveDb(tables());
    wrap(<FolioPage ctx={ctx(db.client, { isOwner: false, permissions: ['order.create'] })} />);
    await screen.findByText(/Room night of 2026-11-18/);
    expect(
      screen.queryByRole('button', { name: 'Post the nights that have passed now' }),
    ).toBeNull();
  });

  it('posts the nights before it shows what is due at check-out', async () => {
    const db = liveDb(tables(), { rpc: { folio_post_nights: { data: 0 } } });
    wrap(<FolioPage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check out' }));
    await waitFor(() => expect(db.rpcs.map((r) => r.fn)).toContain('folio_post_nights'));
    expect(await screen.findByRole('form', { name: /Anna/ })).toBeTruthy();
  });

  it('checks a guest in at the price of the room and lets the desk type another price', async () => {
    const db = liveDb(tables());
    wrap(<FolioPage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check a guest in' }));
    const form = screen.getByRole('form', { name: 'Check a guest in' });
    // the only free room is 102, which has no price
    expect(
      (within(form).getByLabelText('Price per night (baht, optional)') as HTMLInputElement).value,
    ).toBe('');
    await userEvent.type(within(form).getByLabelText('Guest name'), 'Liu');
    await userEvent.type(within(form).getByLabelText('Price per night (baht, optional)'), '900');
    await userEvent.click(within(form).getByRole('button', { name: /Save|Check/ }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'folio_check_in')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'folio_check_in')!.args).toMatchObject({
      p: { room_id: 'r2', guest_name: 'Liu', night_rate: 90000 },
    });
  });

  it('refuses a price that is not a number', async () => {
    const db = liveDb(tables());
    wrap(<FolioPage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check a guest in' }));
    const form = screen.getByRole('form', { name: 'Check a guest in' });
    await userEvent.type(within(form).getByLabelText('Guest name'), 'Liu');
    await userEvent.type(within(form).getByLabelText('Price per night (baht, optional)'), 'abc');
    await userEvent.click(within(form).getByRole('button', { name: /Save|Check/ }));
    expect(db.rpcs.length).toBe(0);
  });

  it('sets the price of a room', async () => {
    const db = liveDb(tables());
    wrap(<FolioPage ctx={ctx(db.client)} />);
    const rooms = await screen.findByRole('region', { name: 'Rooms' });
    await userEvent.click(
      within(rooms).getAllByRole('button', { name: 'Price per night (baht, optional)' })[1]!,
    );
    await userEvent.type(within(rooms).getByLabelText('Price per night (baht, optional)'), '1200');
    await userEvent.click(within(rooms).getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'save_folio_room')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'save_folio_room')!.args).toEqual({
      p: { store_id: 'resort', id: 'r2', night_rate: 120000 },
    });
  });

  it('prints the folio statement with the nights, the bill, the return and the total', async () => {
    let printed = '';
    const print = vi.spyOn(window, 'print').mockImplementation(() => {
      printed = document.getElementById('print-root')?.textContent ?? '';
    });
    const db = liveDb(tables());
    wrap(<FolioPage ctx={ctx(db.client)} />);
    await userEvent.click(
      (await screen.findAllByRole('button', { name: 'Print the folio statement' }))[0]!,
    );
    await waitFor(() => expect(print).toHaveBeenCalled());
    expect(printed).toContain('Folio statement');
    expect(printed).toContain('Palm Resort');
    expect(printed).toContain('Anna');
    expect(printed).toContain('Room night of 2026-11-18');
    expect(printed).toContain('฿3,000');
    expect(printed).toContain('not a tax invoice');
  });
});
