import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { KaraokeBookingsPage } from './KaraokeBookingsPage';
import { KaraokePage } from './KaraokePage';

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
const ctx = (client: unknown, nav: (p: string) => void = () => {}): PageContext => ({
  path: '/karaoke',
  navigate: nav,
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['order.create', 'menu.edit'],
  isOwner: true,
  isPlatformAdmin: false,
});
const wrap = (ui: React.ReactNode) => render(<I18nProvider initialLang="en">{ui}</I18nProvider>);
const room = {
  id: 'r1',
  name: 'VIP 1',
  rate_per_hour: 30000,
  min_minutes: 60,
  step_minutes: 15,
  active: true,
  sort: 1,
};
const pkgs = [
  { id: 'p1', name: '1 hour', minutes: 60, price: 25000, active: true, sort: 1 },
  { id: 'p2', name: '30 min', minutes: 30, price: 12000, active: true, sort: 2 },
];
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const live = (over: Record<string, unknown> = {}) => ({
  id: 's9',
  room_id: 'r1',
  started_at: ago(70),
  ended_at: null,
  guests: 3,
  rate_per_hour: 30000,
  min_minutes: 60,
  step_minutes: 15,
  billed_minutes: null,
  amount: null,
  order_id: null,
  paused_at: null,
  paused_seconds: 0,
  included_minutes: 0,
  package_total: 0,
  package_name: null,
  booking_id: null,
  ...over,
});

describe('<KaraokePage> pause, packages and extending', () => {
  it('starts a free room with the chosen package', async () => {
    const db = liveDb({ karaoke_rooms: [room], karaoke_packages: pkgs });
    wrap(<KaraokePage ctx={ctx(db.client)} />);
    await userEvent.selectOptions(await screen.findByLabelText('Time package'), 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'Start the timer' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'karaoke_start')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'karaoke_start')!.args).toEqual({
      p_room: 'r1',
      p_guests: null,
      p_package: 'p1',
    });
  });

  it('pauses a running room and resumes a paused one', async () => {
    const db = liveDb({ karaoke_rooms: [room], karaoke_sessions: [live()] });
    wrap(<KaraokePage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Pause the clock' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'karaoke_pause')).toBe(true));
    cleanup();
    const db2 = liveDb({ karaoke_rooms: [room], karaoke_sessions: [live({ paused_at: ago(5) })] });
    wrap(<KaraokePage ctx={ctx(db2.client)} />);
    expect(await screen.findByText(/Paused \(the clock is not counting\)/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Resume the clock' }));
    await waitFor(() => expect(db2.rpcs.some((r) => r.fn === 'karaoke_resume')).toBe(true));
  });

  it('shows the time left in a package, estimates package + overage and extends the room', async () => {
    const db = liveDb({
      karaoke_rooms: [room],
      karaoke_packages: pkgs,
      karaoke_sessions: [
        live({
          started_at: ago(40),
          included_minutes: 60,
          package_total: 25000,
          package_name: '1 hour',
        }),
      ],
    });
    wrap(<KaraokePage ctx={ctx(db.client)} />);
    expect(await screen.findByText(/60 minutes included in the package/)).toBeTruthy();
    expect(screen.getByText(/0:19:5\d left|0:20:00 left/)).toBeTruthy();
    expect(screen.getByText(/Billed 60 minutes/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Extend with'), 'p2');
    await userEvent.click(screen.getByRole('button', { name: 'Extend' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'karaoke_extend')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'karaoke_extend')!.args).toEqual({
      p_session: 's9',
      p_package: 'p2',
    });
  });

  it('saves a package with the price in satang', async () => {
    const db = liveDb({ karaoke_rooms: [room] });
    wrap(<KaraokePage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a package' }));
    const form = screen.getByRole('form', { name: 'Add a package' });
    await userEvent.type(within(form).getByLabelText('Package name'), 'Party');
    await userEvent.clear(within(form).getByLabelText('Minutes'));
    await userEvent.type(within(form).getByLabelText('Minutes'), '180');
    await userEvent.type(within(form).getByLabelText('Price (baht)'), '600');
    await userEvent.click(within(form).getByRole('button', { name: 'Save the package' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'save_karaoke_package')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'save_karaoke_package')!.args).toMatchObject({
      p: { store_id: 's1', id: null, name: 'Party', minutes: 180, price: 60000 },
    });
  });
});

describe('<KaraokeBookingsPage>', () => {
  const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const at = (hh: string) => `${today()}T${hh}:00+07:00`;
  const booking = (over: Record<string, unknown>) => ({
    id: 'b1',
    room_id: 'r1',
    guest_name: 'Anna',
    phone: '0811111111',
    guests: 4,
    starts_at: at('19:00'),
    ends_at: at('21:00'),
    status: 'booked',
    note: null,
    ...over,
  });

  it('lists the day’s reservations and starts the room for one', async () => {
    const nav: string[] = [];
    const db = liveDb({ karaoke_rooms: [room], karaoke_bookings: [booking({})] });
    wrap(<KaraokeBookingsPage ctx={ctx(db.client, (p) => nav.push(p))} />);
    expect(await screen.findByText('Anna')).toBeTruthy();
    expect(screen.getByText('19:00–21:00')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Start the room' }));
    await waitFor(() => expect(nav).toEqual(['/karaoke']));
    expect(db.rpcs.find((r) => r.fn === 'karaoke_start')!.args).toEqual({
      p_room: 'r1',
      p_guests: 4,
      p_booking: 'b1',
    });
  });

  it('warns about an overlap before asking the database, and books a free time', async () => {
    const db = liveDb({ karaoke_rooms: [room], karaoke_bookings: [booking({})] });
    wrap(<KaraokeBookingsPage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a reservation' }));
    const form = screen.getByRole('form', { name: 'Add a reservation' });
    const time = within(form).getByLabelText('Start time');
    await userEvent.clear(time);
    await userEvent.type(time, '20:00');
    await userEvent.type(within(form).getByLabelText('Name of the guest'), 'Liu');
    await userEvent.click(within(form).getByRole('button', { name: 'Save the reservation' }));
    expect(await screen.findByText(/already booked by Anna/)).toBeTruthy();
    expect(db.rpcs.length).toBe(0);
    await userEvent.clear(time);
    await userEvent.type(time, '21:00');
    await userEvent.click(within(form).getByRole('button', { name: 'Save the reservation' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'karaoke_book')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'karaoke_book')!.args).toMatchObject({
      p: { store_id: 's1', room_id: 'r1', guest_name: 'Liu', minutes: 120 },
    });
  });

  it('cancels a reservation', async () => {
    const db = liveDb({ karaoke_rooms: [room], karaoke_bookings: [booking({})] });
    wrap(<KaraokeBookingsPage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel the reservation' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'karaoke_booking_status')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'karaoke_booking_status')!.args).toEqual({
      p_booking: 'b1',
      p_status: 'cancelled',
    });
  });
});
