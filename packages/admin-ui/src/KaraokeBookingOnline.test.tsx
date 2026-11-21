import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { fakeDb } from './fakeDb';
import { KaraokeBookingLinkPanel } from './KaraokeBookingLinkPanel';
import { KaraokeBookingsPage } from './KaraokeBookingsPage';

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
  path: '/karaoke/bookings',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['order.create', 'menu.edit', 'payment.take', 'refund.create'],
  isOwner: true,
  isPlatformAdmin: false,
  ...over,
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
const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const at = (hh: string) => `${today()}T${hh}:00+07:00`;
const booking = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  room_id: 'r1',
  guest_name: 'Anna',
  phone: '0811111111',
  guests: 4,
  starts_at: at('19:00'),
  ends_at: at('21:00'),
  status: 'booked',
  note: null,
  source: 'online',
  deposit_due: 18000,
  hold_until: at('23:30'),
  ...over,
});
const till = { id: 'd1', name: 'Front desk' };

describe('deposits on a karaoke reservation', () => {
  it('shows an online booking with the deposit due and nothing received', async () => {
    const db = liveDb({
      karaoke_rooms: [room],
      karaoke_bookings: [booking()],
      karaoke_deposits: [],
      devices: [till],
    });
    wrap(<KaraokeBookingsPage ctx={ctx(db.client)} />);
    expect(await screen.findByText('Anna')).toBeTruthy();
    expect(screen.getByText('Online booking')).toBeTruthy();
    expect(screen.getByText(/Deposit due ฿180/)).toBeTruthy();
    expect(screen.getByText('Received ฿0')).toBeTruthy();
    expect(screen.getByText(/Held until/)).toBeTruthy();
  });

  it('records a PromptPay deposit with the amount still due filled in', async () => {
    const db = liveDb({
      karaoke_rooms: [room],
      karaoke_bookings: [booking()],
      karaoke_deposits: [],
      devices: [till],
    });
    wrap(<KaraokeBookingsPage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Take a deposit' }));
    expect((screen.getByLabelText('Amount (baht)') as HTMLInputElement).value).toBe('180');
    await userEvent.click(screen.getByRole('button', { name: 'Save the deposit' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'record_karaoke_deposit')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'record_karaoke_deposit')!.args).toEqual({
      p: { booking_id: 'b1', amount: 18000, method: 'promptpay', device_id: null },
    });
  });

  it('asks for the till when the deposit is cash and refuses a bad amount', async () => {
    const db = liveDb({
      karaoke_rooms: [room],
      karaoke_bookings: [booking({ deposit_due: 0 })],
      karaoke_deposits: [],
      devices: [till],
    });
    wrap(<KaraokeBookingsPage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Take a deposit' }));
    await userEvent.selectOptions(screen.getByLabelText('How it was paid'), 'cash');
    await userEvent.selectOptions(screen.getByLabelText('Till / drawer it went into'), '');
    await userEvent.type(screen.getByLabelText('Amount (baht)'), '100');
    await userEvent.click(screen.getByRole('button', { name: 'Save the deposit' }));
    expect(await screen.findByText('A cash deposit needs the till it went into.')).toBeTruthy();
    expect(db.rpcs.length).toBe(0);
    await userEvent.selectOptions(screen.getByLabelText('Till / drawer it went into'), 'd1');
    await userEvent.click(screen.getByRole('button', { name: 'Save the deposit' }));
    await waitFor(() => expect(db.rpcs.length).toBe(1));
    expect(db.rpcs[0]!.args).toEqual({
      p: { booking_id: 'b1', amount: 10000, method: 'cash', device_id: 'd1' },
    });
  });

  it('adds up what was received and offers keep / refund only for a cancelled booking', async () => {
    const deposit = {
      id: 'k1',
      booking_id: 'b1',
      amount: 18000,
      method: 'promptpay',
      status: 'held',
    };
    const live = liveDb({
      karaoke_rooms: [room],
      karaoke_bookings: [booking()],
      karaoke_deposits: [deposit],
      devices: [till],
    });
    wrap(<KaraokeBookingsPage ctx={ctx(live.client)} />);
    expect(await screen.findByText('Received ฿180')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep as a fee' })).toBeNull();
    cleanup();
    const db = liveDb({
      karaoke_rooms: [room],
      karaoke_bookings: [booking({ status: 'cancelled' })],
      karaoke_deposits: [deposit],
      devices: [till],
    });
    wrap(<KaraokeBookingsPage ctx={ctx(db.client)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Keep as a fee' }));
    await waitFor(() => expect(db.rpcs.some((r) => r.fn === 'resolve_karaoke_deposit')).toBe(true));
    expect(db.rpcs.find((r) => r.fn === 'resolve_karaoke_deposit')!.args).toEqual({
      p: { deposit_id: 'k1', action: 'forfeit', device_id: null },
    });
  });

  it('hides the money buttons from someone who cannot take payments', async () => {
    const deposit = { id: 'k1', booking_id: 'b1', amount: 18000, method: 'cash', status: 'held' };
    const db = liveDb({
      karaoke_rooms: [room],
      karaoke_bookings: [booking({ status: 'cancelled' })],
      karaoke_deposits: [deposit],
      devices: [till],
    });
    wrap(
      <KaraokeBookingsPage
        ctx={ctx(db.client, { isOwner: false, permissions: ['order.create'] })}
      />,
    );
    expect(await screen.findByText('Received ฿180')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Take a deposit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep as a fee' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Online karaoke room booking' })).toBeNull();
  });
});

describe('<KaraokeBookingLinkPanel>', () => {
  const store = {
    name: 'Sing Along',
    karaoke_booking_token: 'e'.repeat(32),
    karaoke_booking_settings: { deposit_pct: 40, hold_min: 90, pay_note: 'PromptPay 0812345678' },
  };
  it('shows the link and the saved rules', async () => {
    const db = liveDb({ stores: [store] });
    wrap(<KaraokeBookingLinkPanel ctx={ctx(db.client)} storeId="s1" />);
    const link = (await screen.findByLabelText('The shop booking link')) as HTMLInputElement;
    expect(link.value.endsWith(`/kb/${'e'.repeat(32)}`)).toBe(true);
    expect(
      (screen.getByLabelText('Deposit (% of the room price, 0 = none)') as HTMLInputElement).value,
    ).toBe('40');
    expect(
      (screen.getByLabelText('Hold a booking for its deposit (minutes)') as HTMLInputElement).value,
    ).toBe('90');
    expect((screen.getByLabelText(/How to pay the deposit/) as HTMLTextAreaElement).value).toBe(
      'PromptPay 0812345678',
    );
  });

  it('saves the rules and can make a new link', async () => {
    const db = liveDb(
      { stores: [store] },
      { rpc: { save_karaoke_booking_settings: { data: { token: 'f'.repeat(32), settings: {} } } } },
    );
    wrap(<KaraokeBookingLinkPanel ctx={ctx(db.client)} storeId="s1" />);
    const pct = await screen.findByLabelText('Deposit (% of the room price, 0 = none)');
    await userEvent.clear(pct);
    await userEvent.type(pct, '25');
    await userEvent.click(screen.getByRole('button', { name: 'Save booking settings' }));
    await waitFor(() => expect(db.rpcs.length).toBe(1));
    expect(db.rpcs[0]).toMatchObject({
      fn: 'save_karaoke_booking_settings',
      args: { p_store: 's1', p: { deposit_pct: 25, hold_min: 90, rotate: false } },
    });
    await userEvent.click(screen.getByRole('button', { name: /new link/i }));
    await waitFor(() => expect(db.rpcs.length).toBe(2));
    expect((db.rpcs[1]!.args as { p: { rotate: boolean } }).p.rotate).toBe(true);
    await waitFor(() =>
      expect(
        (screen.getByLabelText('The shop booking link') as HTMLInputElement).value.endsWith(
          'f'.repeat(32),
        ),
      ).toBe(true),
    );
  });

  it('refuses a deposit above 100 percent without asking the database', async () => {
    const db = liveDb({ stores: [store] });
    wrap(<KaraokeBookingLinkPanel ctx={ctx(db.client)} storeId="s1" />);
    const pct = await screen.findByLabelText('Deposit (% of the room price, 0 = none)');
    await userEvent.clear(pct);
    await userEvent.type(pct, '150');
    await userEvent.click(screen.getByRole('button', { name: 'Save booking settings' }));
    expect(await screen.findByText(/Those values do not work/)).toBeTruthy();
    expect(db.rpcs.length).toBe(0);
  });

  it('says the module is off', async () => {
    const db = liveDb({ stores: [store] });
    wrap(
      <KaraokeBookingLinkPanel ctx={ctx(db.client, { isModuleOn: () => false })} storeId="s1" />,
    );
    expect(await screen.findByText(/is off in this shop/)).toBeTruthy();
    void within;
  });
});
