import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { FolioPage } from './FolioPage';

afterEach(cleanup);

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
    { id: 'r1', store_id: 'resort', name: '101', active: true, sort: 1 },
    { id: 'r2', store_id: 'resort', name: '102', active: true, sort: 2 },
  ],
  folios: [
    {
      id: 'f1',
      room_id: 'r1',
      guest_name: 'Anna',
      phone: '0811',
      check_in_at: '2026-11-20T05:00:00Z',
      check_out_on: null,
      note: null,
      status: 'open',
      closed_at: null,
    },
  ],
  folio_charges: [
    {
      id: 'c1',
      folio_id: 'f1',
      store_id: 'bar',
      order_id: 'o1',
      amount: 21000,
      receipt_number: 'A+000001',
      voided_at: null,
      void_reason: null,
      created_at: '2026-11-20T06:00:00Z',
    },
    {
      id: 'c2',
      folio_id: 'f1',
      store_id: 'bar',
      order_id: 'o2',
      amount: 9000,
      receipt_number: 'A+000002',
      voided_at: '2026-11-20T07:00:00Z',
      void_reason: 'wrong room',
      created_at: '2026-11-20T06:30:00Z',
    },
  ],
  stores: [
    { id: 'bar', name: 'Pool Bar' },
    { id: 'resort', name: 'Palm Resort' },
  ],
  devices: [{ id: 'desk', name: 'Front desk' }],
});

describe('<FolioPage>', () => {
  it('shows the guests in the house with the balance and the charges (a taken-off one struck through)', async () => {
    const db = liveDb(tables());
    wrap(<FolioPage ctx={ctx(db.client)} />);
    expect(await screen.findByText('Anna')).toBeTruthy();
    expect(screen.getByText(/Balance: .*210/)).toBeTruthy();
    expect(screen.getByText(/Pool Bar · A\+000001/)).toBeTruthy();
    expect(screen.getByText(/Taken off: wrong room/)).toBeTruthy();
  });

  it('checks a guest into a free room only', async () => {
    const db = liveDb(tables());
    wrap(<FolioPage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check a guest in' }));
    const form = screen.getByRole('form', { name: 'Check a guest in' });
    const room = within(form).getByLabelText('Room') as HTMLSelectElement;
    expect(Array.from(room.options).map((o) => o.textContent)).toEqual(['102']); // 101 is taken
    await userEvent.type(within(form).getByLabelText('Guest name'), 'Bob');
    await userEvent.click(within(form).getByRole('button', { name: 'Check in' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'folio_check_in')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'folio_check_in')!.args).toMatchObject({
      p: { store_id: 'resort', room_id: 'r2', guest_name: 'Bob' },
    });
  });

  it('checks out with the way to pay; cash names the till', async () => {
    const db = liveDb(tables());
    wrap(<FolioPage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check out' }));
    const form = screen.getByRole('form', { name: /Check out Anna/ });
    expect(within(form).getByText(/210/)).toBeTruthy();
    await userEvent.selectOptions(within(form).getByLabelText('Paid by'), 'cash');
    await userEvent.click(within(form).getByRole('button', { name: 'Take payment and check out' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'folio_settle')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'folio_settle')!.args).toMatchObject({
      p: { folio_id: 'f1', method: 'cash', device_id: 'desk' },
    });
  });

  it('takes a charge off with a reason (managers only)', async () => {
    const db = liveDb(tables());
    wrap(<FolioPage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Take the charge off' }));
    await userEvent.type(screen.getByLabelText('Reason'), 'charged to the wrong room');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm: take it off' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'folio_void_charge')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'folio_void_charge')!.args).toEqual({
      p_charge: 'c1',
      p_reason: 'charged to the wrong room',
    });
    cleanup();
    const db2 = liveDb(tables());
    wrap(
      <FolioPage
        ctx={ctx(db2.client, { isOwner: false, permissions: ['order.create', 'payment.take'] })}
      />,
    );
    await screen.findByText('Anna');
    expect(screen.queryByRole('button', { name: 'Take the charge off' })).toBeNull();
  });

  it('closes a stay with nothing owed without asking how to pay', async () => {
    const t = tables();
    t.folio_charges = [];
    const db = liveDb(t);
    wrap(<FolioPage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check out' }));
    expect(screen.queryByLabelText('Paid by')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Close the stay (nothing owed)' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'folio_settle')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'folio_settle')!.args).toMatchObject({
      p: { folio_id: 'f1', method: 'none' },
    });
  });

  it('adds a room', async () => {
    const db = liveDb(tables());
    wrap(<FolioPage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a room' }));
    await userEvent.type(screen.getByLabelText('Room name / number'), '201');
    await userEvent.click(screen.getByRole('button', { name: 'Save the room' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'save_folio_room')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'save_folio_room')!.args).toMatchObject({
      p: { store_id: 'resort', name: '201' },
    });
  });
});
