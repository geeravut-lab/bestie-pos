import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext } from '@bestie/auth';
import { I18nProvider } from '@bestie/i18n';
import { AppointmentsPage } from './AppointmentsPage';
import { fakeDb } from './fakeDb';
import { ResourcesPage } from './ResourcesPage';

afterEach(cleanup);

const tables = () => ({
  resources: [
    { id: 'nok', name: 'Nok', kind: 'stylist', active: true, sort: 1, staff_id: 'st1' },
    { id: 'mai', name: 'Mai', kind: 'therapist', active: true, sort: 2 },
    { id: 'room1', name: 'Room 1', kind: 'room', active: true, sort: 3 },
  ],
  appointments: [
    {
      id: 'a1',
      provider_id: 'nok',
      place_id: 'room1',
      service_name: { th: 'นวดน้ำมัน', en: 'Oil massage' },
      price: 80000,
      guest_name: 'Anna',
      guest_phone: '081',
      starts_at: '2030-01-15T10:00:00+07:00',
      ends_at: '2030-01-15T11:30:00+07:00',
      status: 'booked',
      source: 'staff',
      note: null,
    },
    {
      id: 'a2',
      provider_id: null,
      place_id: null,
      service_name: { th: 'ตัดผม' },
      price: 30000,
      guest_name: 'Ben',
      guest_phone: null,
      starts_at: '2030-01-15T14:00:00+07:00',
      ends_at: '2030-01-15T14:45:00+07:00',
      status: 'confirmed',
      source: 'online',
      note: null,
    },
    {
      id: 'a3',
      provider_id: 'mai',
      place_id: null,
      service_name: { th: 'นวดเท้า', en: 'Foot massage' },
      price: 60000,
      customer_id: 'm1',
      guest_name: 'Cara',
      guest_phone: null,
      starts_at: '2030-01-15T15:00:00+07:00',
      ends_at: '2030-01-15T16:00:00+07:00',
      status: 'arrived',
      source: 'staff',
      note: null,
      order_id: null,
    },
    {
      id: 'a4',
      provider_id: 'mai',
      place_id: null,
      service_name: { th: 'นวดไทย', en: 'Thai massage' },
      price: 50000,
      guest_name: 'Dan',
      guest_phone: null,
      starts_at: '2030-01-15T17:00:00+07:00',
      ends_at: '2030-01-15T18:00:00+07:00',
      status: 'no_show',
      source: 'staff',
      note: null,
      order_id: null,
    },
    {
      id: 'a5',
      provider_id: 'mai',
      place_id: null,
      service_name: { th: 'สปา', en: 'Spa' },
      price: 90000,
      guest_name: 'Eli',
      guest_phone: null,
      starts_at: '2030-01-15T19:00:00+07:00',
      ends_at: '2030-01-15T20:00:00+07:00',
      status: 'done',
      source: 'staff',
      note: null,
      order_id: 'o9',
    },
    {
      id: 'a6',
      provider_id: 'mai',
      place_id: null,
      service_name: { th: 'นวด', en: 'Massage' },
      price: 100000,
      customer_id: 'm1',
      customer_package_id: 'c1',
      guest_name: 'Fay',
      guest_phone: null,
      starts_at: '2030-01-15T21:00:00+07:00',
      ends_at: '2030-01-15T22:00:00+07:00',
      status: 'done',
      source: 'staff',
      note: null,
      order_id: null,
    },
    {
      id: 'a7',
      provider_id: 'nok',
      place_id: null,
      service_name: { th: 'นวด', en: 'Massage' },
      price: 100000,
      customer_id: 'm1',
      guest_name: 'Gus',
      guest_phone: null,
      starts_at: '2030-01-15T12:00:00+07:00',
      ends_at: '2030-01-15T13:00:00+07:00',
      status: 'booked',
      source: 'staff',
      note: null,
      order_id: null,
    },
  ],
  customer_packages: [
    {
      id: 'c1',
      customer_id: 'm1',
      name: { th: 'นวด 10 ครั้ง', en: 'Massage x10' },
      price: 800000,
      visits_total: 10,
      visits_left: 7,
      valid_until: '2099-05-01',
      status: 'active',
    },
  ],
  package_uses: [{ id: 'u1', appointment_id: 'a6', created_at: '2030-01-15T22:00:00Z' }],
  appointment_deposits: [
    {
      id: 'dp1',
      appointment_id: 'a4',
      amount: 10000,
      method: 'cash',
      status: 'held',
      reference: 'slip 7',
    },
    {
      id: 'dp2',
      appointment_id: 'a3',
      amount: 20000,
      method: 'promptpay',
      status: 'held',
      reference: null,
    },
  ],
  devices: [{ id: 't1', name: 'Counter' }],
  staff: [
    { id: 'st1', display_name: 'Nok Staff' },
    { id: 'st2', display_name: 'Mai Staff' },
  ],
  menu_items: [
    {
      id: 'svc1',
      name: { th: 'นวดน้ำมัน', en: 'Oil massage' },
      prices: { base: 80000 },
      duration_min: 90,
    },
    {
      id: 'svc2',
      name: { th: 'ตัดผม', en: 'Haircut' },
      prices: { base: 30000 },
      duration_min: null,
    },
  ],
});
const ctx = (client: unknown, over: Partial<PageContext> = {}): PageContext => ({
  path: '/calendar',
  navigate: () => {},
  client: client as never,
  orgId: 'o1',
  storeId: 's1',
  permissions: ['order.create'],
  isOwner: false,
  isPlatformAdmin: false,
  isModuleOn: () => true,
  ...over,
});
const mount = (c: PageContext) =>
  render(
    <I18nProvider initialLang="en">
      <AppointmentsPage ctx={c} />
    </I18nProvider>,
  );
const openDay = async () => {
  fireEvent.change(await screen.findByLabelText('Date'), { target: { value: '2030-01-15' } });
};

describe('<AppointmentsPage>', () => {
  it('says so when the module is off in this shop', async () => {
    mount(ctx(fakeDb(tables()).client, { isModuleOn: () => false }));
    expect(await screen.findByText(/appointments module is off/i)).toBeTruthy();
  });

  it('shows a column per stylist with the bookings, and an Unassigned column for bookings with nobody', async () => {
    mount(ctx(fakeDb(tables()).client));
    await openDay();
    const nok = await screen.findByRole('region', { name: 'Nok' });
    expect(within(nok).getByText('10:00 Anna')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Mai' })).toBeTruthy();
    const none = screen.getByRole('region', { name: 'Unassigned' });
    expect(within(none).getByText('14:00 Ben')).toBeTruthy();
  });

  it('switches to the room / bed view', async () => {
    mount(ctx(fakeDb(tables()).client));
    await openDay();
    await userEvent.click(await screen.findByRole('tab', { name: 'By room / bed' }));
    const room = await screen.findByRole('region', { name: 'Room 1' });
    expect(within(room).getByText('10:00 Anna')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Nok' })).toBeNull();
  });

  it('books from a column: the service fills the length, the time is Bangkok time on the chosen day', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openDay();
    await userEvent.click(await screen.findByRole('button', { name: 'New booking: Mai' }));
    expect((screen.getByLabelText('Stylist / therapist') as HTMLSelectElement).value).toBe('mai');
    expect((screen.getByLabelText('Length (minutes)') as HTMLInputElement).value).toBe('90');
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '15:30' } });
    await userEvent.type(screen.getByLabelText('Guest name'), 'Cara');
    await userEvent.click(screen.getByRole('button', { name: 'Save booking' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'book_appointment',
      args: {
        p: {
          store_id: 's1',
          provider_id: 'mai',
          place_id: null,
          service_id: 'svc1',
          duration_min: 90,
          starts_at: '2030-01-15T15:30:00+07:00',
          customer_id: null,
          guest_name: 'Cara',
          guest_phone: null,
          note: undefined,
        },
      },
    });
  });

  it('warns before saving when the stylist is already booked then, and refuses an empty guest name', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openDay();
    await userEvent.click(await screen.findByRole('button', { name: 'New booking: Nok' }));
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '11:00' } }); // inside 10:00–11:30
    expect(await screen.findByText(/Clashes with Anna at 10:00/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save booking' }));
    expect(await screen.findByText(/Enter the guest name/)).toBeTruthy();
    expect(db.rpcs).toHaveLength(0);
  });

  it('a custom service needs a name; the database refusing a busy stylist is shown as such', async () => {
    const db = fakeDb(tables(), {
      rpc: {
        book_appointment: {
          error: { code: '23P01', message: 'that provider is busy at that time' },
        },
      },
    });
    mount(ctx(db.client));
    await openDay();
    await userEvent.click(await screen.findByRole('button', { name: 'New booking: Nok' }));
    await userEvent.selectOptions(screen.getByLabelText('Service'), '');
    await userEvent.type(screen.getByLabelText('Guest name'), 'Dan');
    await userEvent.click(screen.getByRole('button', { name: 'Save booking' }));
    expect(await screen.findByText(/Enter the guest name/)).toBeTruthy(); // no service name yet
    await userEvent.type(screen.getByLabelText('Service name'), 'Nails');
    await userEvent.type(screen.getByLabelText('Price (baht)'), '250');
    await userEvent.click(screen.getByRole('button', { name: 'Save booking' }));
    expect(await screen.findByText('That stylist is busy then')).toBeTruthy();
    expect(db.rpcs[0]!.args).toMatchObject({
      p: { service_name: { th: 'Nails' }, price: 25000, duration_min: 90 },
    });
  });

  it('a booking opens its details with only the next steps; confirming goes through the database function', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openDay();
    await userEvent.click(await screen.findByText('10:00 Anna'));
    const card = screen.getByRole('region', { name: 'Anna' });
    expect(within(card).getByText('Booked')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Finish' })).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'set_appointment_status',
      args: { p_id: 'a1', p_status: 'confirmed' },
    });
  });

  it('moves a booking to another time', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client));
    await openDay();
    await userEvent.click(await screen.findByText('10:00 Anna'));
    await userEvent.click(screen.getByRole('button', { name: 'Move' }));
    fireEvent.change(screen.getByLabelText('Move to'), { target: { value: '16:00' } });
    await userEvent.click(screen.getByRole('button', { name: 'Move booking' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'reschedule_appointment',
      args: {
        p: {
          id: 'a1',
          starts_at: '2030-01-15T16:00:00+07:00',
          provider_id: 'nok',
          place_id: 'room1',
        },
      },
    });
  });

  it('someone without order.create can look but not book or change', async () => {
    mount(ctx(fakeDb(tables()).client, { permissions: [] }));
    await openDay();
    await userEvent.click(await screen.findByText('10:00 Anna'));
    expect(screen.queryByRole('button', { name: /New booking/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move' })).toBeNull();
  });
});

describe('<AppointmentsPage> billing and deposits', () => {
  const full = ['order.create', 'payment.take', 'refund.create'] as PageContext['permissions'];

  it('opens the bill of an arrived guest on the till and goes to it', async () => {
    const db = fakeDb(tables(), { rpc: { appointment_to_order: { data: 'order-77' } } });
    const navigate = vi.fn();
    mount(ctx(db.client, { permissions: full, navigate }));
    await openDay();
    await userEvent.click(await screen.findByText('15:00 Cara'));
    await userEvent.click(screen.getByRole('button', { name: 'Open the bill' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'appointment_to_order',
      args: { p: { appointment_id: 'a3', device_id: 't1' } },
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/order/order-77'));
  });

  it('a guest who has not arrived cannot be billed yet; one that has a bill goes straight to it', async () => {
    mount(ctx(fakeDb(tables()).client, { permissions: full }));
    await openDay();
    await userEvent.click(await screen.findByText('10:00 Anna'));
    expect(screen.queryByRole('button', { name: 'Open the bill' })).toBeNull();
    cleanup();
    mount(ctx(fakeDb(tables()).client, { permissions: full }));
    await openDay();
    await userEvent.click(await screen.findByText('19:00 Eli'));
    expect(screen.getByRole('button', { name: "Go to this visit's bill" })).toBeTruthy();
  });

  it('takes a deposit: 30 % suggested, cash into the counter till, sent in satang', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client, { permissions: full }));
    await openDay();
    await userEvent.click(await screen.findByText('10:00 Anna')); // price 800.00
    await userEvent.click(screen.getByRole('button', { name: 'Take a deposit' }));
    expect((screen.getByLabelText('Amount (baht)') as HTMLInputElement).value).toBe('240');
    expect((screen.getByLabelText('Cash went into the till of') as HTMLSelectElement).value).toBe(
      't1',
    );
    await userEvent.type(screen.getByLabelText('Reference / note (optional)'), 'slip 9');
    await userEvent.click(screen.getByRole('button', { name: 'Save the deposit' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'record_appointment_deposit',
      args: {
        p: {
          appointment_id: 'a1',
          amount: 24000,
          method: 'cash',
          device_id: 't1',
          reference: 'slip 9',
        },
      },
    });
  });

  it('a PromptPay deposit needs no till; a wrong amount is refused before anything is sent', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client, { permissions: full }));
    await openDay();
    await userEvent.click(await screen.findByText('10:00 Anna'));
    await userEvent.click(screen.getByRole('button', { name: 'Take a deposit' }));
    await userEvent.selectOptions(screen.getByLabelText('Paid by'), 'promptpay');
    expect(screen.queryByLabelText('Cash went into the till of')).toBeNull();
    const amount = screen.getByLabelText('Amount (baht)');
    await userEvent.clear(amount);
    await userEvent.type(amount, 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save the deposit' }));
    expect(await screen.findByText(/Enter a valid amount/)).toBeTruthy();
    expect(db.rpcs).toHaveLength(0);
    await userEvent.clear(amount);
    await userEvent.type(amount, '200');
    await userEvent.click(screen.getByRole('button', { name: 'Save the deposit' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]!.args).toMatchObject({
      p: { amount: 20000, method: 'promptpay', device_id: null },
    });
  });

  it('shows what is held and how much more can be taken', async () => {
    mount(ctx(fakeDb(tables()).client, { permissions: full }));
    await openDay();
    await userEvent.click(await screen.findByText('15:00 Cara')); // price 600.00, 200.00 held
    expect(screen.getByText(/Holding ฿200 in deposits/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Take a deposit' }));
    expect(screen.getByText(/up to ฿400 more/)).toBeTruthy();
  });

  it('a no-show: the manager keeps the deposit or refunds it (cash refund needs the till)', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client, { permissions: full }));
    await openDay();
    await userEvent.click(await screen.findByText('17:00 Dan'));
    await userEvent.click(screen.getByRole('button', { name: 'Refund the deposit' }));
    expect(await screen.findByText(/pick the till that took the cash/)).toBeTruthy();
    expect(db.rpcs).toHaveLength(0);
    await userEvent.selectOptions(
      screen.getByLabelText('If refunding cash, take it from the till of'),
      't1',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Refund the deposit' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'resolve_deposit',
      args: { p: { deposit_id: 'dp1', action: 'refund', device_id: 't1' } },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Keep it (no-show fee)' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(2));
    expect(db.rpcs[1]).toEqual({
      fn: 'resolve_deposit',
      args: { p: { deposit_id: 'dp1', action: 'forfeit', device_id: null } },
    });
  });

  it('without payment.take there is no deposit button; without refund.create no keep / refund', async () => {
    mount(ctx(fakeDb(tables()).client, { permissions: ['order.create'] }));
    await openDay();
    await userEvent.click(await screen.findByText('10:00 Anna'));
    expect(screen.queryByRole('button', { name: 'Take a deposit' })).toBeNull();
    await userEvent.click(screen.getByText('17:00 Dan'));
    expect(screen.queryByRole('button', { name: 'Refund the deposit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep it (no-show fee)' })).toBeNull();
  });

  it('with the deposits module off nothing about deposits is shown', async () => {
    mount(
      ctx(fakeDb(tables()).client, { permissions: full, isModuleOn: (id) => id !== 'deposits' }),
    );
    await openDay();
    await userEvent.click(await screen.findByText('10:00 Anna'));
    expect(screen.queryByRole('button', { name: 'Take a deposit' })).toBeNull();
  });
});

describe('<AppointmentsPage> packages and members', () => {
  const full = ['order.create', 'payment.take', 'refund.create'] as PageContext['permissions'];

  it('an arrived guest of a member with a package can use one visit: it goes through the database function', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client, { permissions: full }));
    await openDay();
    await userEvent.click(await screen.findByText('15:00 Cara'));
    await userEvent.click(
      screen.getByRole('button', { name: 'Use 1 visit of Massage x10 (7 left)' }),
    );
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'use_package',
      args: { p: { appointment_id: 'a3', customer_package_id: 'c1' } },
    });
  });

  it('a guest who has not arrived yet sees the package but cannot use it', async () => {
    mount(ctx(fakeDb(tables()).client, { permissions: full }));
    await openDay();
    await userEvent.click(await screen.findByText('12:00 Gus'));
    expect(
      (
        screen.getByRole('button', {
          name: 'Use 1 visit of Massage x10 (7 left)',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('a visit already covered by a package says so; a manager can take the visit back', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client, { permissions: full }));
    await openDay();
    await userEvent.click(await screen.findByText('21:00 Fay'));
    expect(screen.getByText(/Paid with the package: Massage x10/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Take the visit back' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({ fn: 'undo_package_use', args: { p_use: 'u1' } });
  });

  it('without refund.create there is no take-back; a guest without a member shows no package block', async () => {
    mount(ctx(fakeDb(tables()).client, { permissions: ['order.create'] }));
    await openDay();
    await userEvent.click(await screen.findByText('21:00 Fay'));
    expect(screen.queryByRole('button', { name: 'Take the visit back' })).toBeNull();
    await userEvent.click(screen.getByText('10:00 Anna')); // no member
    expect(screen.queryByText('Package')).toBeNull();
  });

  it('with the packages module off nothing about packages is shown', async () => {
    mount(
      ctx(fakeDb(tables()).client, { permissions: full, isModuleOn: (id) => id !== 'packages' }),
    );
    await openDay();
    await userEvent.click(await screen.findByText('15:00 Cara'));
    expect(screen.queryByRole('button', { name: /Use 1 visit/ })).toBeNull();
  });

  it('a member can be linked to a new booking; the booking then carries the member', async () => {
    const db = fakeDb(tables(), {
      rpc: {
        find_customers: {
          data: [
            { id: 'm1', name: 'Anna Smith', phone: '6681', member_code: 'ABCD1234', points: 0 },
          ],
        },
      },
    });
    mount(ctx(db.client, { permissions: full }));
    await openDay();
    await userEvent.click(await screen.findByRole('button', { name: 'New booking: Mai' }));
    await userEvent.click(screen.getByRole('button', { name: 'Link a member' }));
    await userEvent.type(screen.getByLabelText('Find a member'), 'anna');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.click(await screen.findByRole('button', { name: /Anna Smith/ }));
    expect((screen.getByLabelText('Guest name') as HTMLInputElement).value).toBe('Anna Smith');
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '23:00' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save booking' }));
    await waitFor(() => expect(db.rpcs.some((c) => c.fn === 'book_appointment')).toBe(true));
    expect(db.rpcs.find((c) => c.fn === 'book_appointment')!.args).toMatchObject({
      p: { customer_id: 'm1', guest_name: 'Anna Smith' },
    });
  });
});

describe('<AppointmentsPage> tips', () => {
  const full = ['order.create', 'payment.take'] as PageContext['permissions'];
  it('takes a tip for the stylist of the visit (linked person preselected), cash into the till, in satang', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client, { permissions: full }));
    await openDay();
    await userEvent.click(await screen.findByText('10:00 Anna')); // Nok, linked to Nok Staff
    await userEvent.click(screen.getByRole('button', { name: 'Take a tip' }));
    expect((screen.getByLabelText('Tip for') as HTMLSelectElement).value).toBe('st1');
    await userEvent.type(screen.getByLabelText('Amount (baht)'), '50');
    await userEvent.click(screen.getByRole('button', { name: 'Save the tip' }));
    await waitFor(() => expect(db.rpcs).toHaveLength(1));
    expect(db.rpcs[0]).toEqual({
      fn: 'record_tip',
      args: {
        p: {
          store_id: 's1',
          staff_id: 'st1',
          amount: 5000,
          method: 'cash',
          device_id: 't1',
          appointment_id: 'a1',
        },
      },
    });
    expect(await screen.findByText('Tip saved')).toBeTruthy();
  });

  it('refuses a tip without an amount before anything is sent; no tips for a cancelled or missed visit; none without payment.take', async () => {
    const db = fakeDb(tables());
    mount(ctx(db.client, { permissions: full }));
    await openDay();
    await userEvent.click(await screen.findByText('10:00 Anna'));
    await userEvent.click(screen.getByRole('button', { name: 'Take a tip' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save the tip' }));
    expect(await screen.findByText(/Pick a person, enter the amount/)).toBeTruthy();
    expect(db.rpcs).toHaveLength(0);
    await userEvent.click(screen.getByText('17:00 Dan')); // no-show
    expect(screen.queryByRole('button', { name: 'Take a tip' })).toBeNull();
    cleanup();
    mount(ctx(fakeDb(tables()).client, { permissions: ['order.create'] }));
    await openDay();
    await userEvent.click(await screen.findByText('10:00 Anna'));
    expect(screen.queryByRole('button', { name: 'Take a tip' })).toBeNull();
  });

  it('with the commission module off there is no tip button', async () => {
    mount(
      ctx(fakeDb(tables()).client, { permissions: full, isModuleOn: (id) => id !== 'commission' }),
    );
    await openDay();
    await userEvent.click(await screen.findByText('10:00 Anna'));
    expect(screen.queryByRole('button', { name: 'Take a tip' })).toBeNull();
  });
});

describe('<ResourcesPage>', () => {
  const mountR = (c: PageContext) =>
    render(
      <I18nProvider initialLang="en">
        <ResourcesPage ctx={c} />
      </I18nProvider>,
    );
  const rctx = (client: unknown, over: Partial<PageContext> = {}) =>
    ctx(client, { path: '/resources', permissions: ['menu.edit'], ...over });

  it('lists stylists and rooms and adds a stylist', async () => {
    const db = fakeDb(tables());
    mountR(rctx(db.client));
    expect(await screen.findByText('Nok')).toBeTruthy();
    expect(screen.getByText('Room 1')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Fon');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'resources',
      op: 'insert',
      values: { name: 'Fon', kind: 'stylist', store_id: 's1' },
    });
  });

  it('offers rooms and beds only when the resources module is on', async () => {
    mountR(rctx(fakeDb(tables()).client, { isModuleOn: (id) => id !== 'resources' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add' }));
    const kinds = within(screen.getByLabelText('Type'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(kinds).toEqual(['Stylist / beautician', 'Therapist']);
  });

  it('stops using a stylist who left', async () => {
    const db = fakeDb(tables());
    mountR(rctx(db.client));
    const row = (await screen.findByText('Nok')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Stop using' }));
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'resources',
      op: 'update',
      values: { active: false },
    });
  });

  it('links a stylist to the staff member behind them', async () => {
    const db = fakeDb(tables());
    mountR(rctx(db.client));
    const row = (await screen.findByText('Nok')).closest('li')!;
    await userEvent.selectOptions(
      within(row).getByLabelText(/Staff member behind this stylist/),
      'st2',
    );
    await waitFor(() => expect(db.writes).toHaveLength(1));
    expect(db.writes[0]).toMatchObject({
      table: 'resources',
      op: 'update',
      values: { staff_id: 'st2' },
    });
    // a room has nobody behind it
    expect(
      within(screen.getByText('Room 1').closest('li')!).queryByLabelText(/Staff member behind/),
    ).toBeNull();
  });

  it('someone without menu.edit only looks', async () => {
    mountR(rctx(fakeDb(tables()).client, { permissions: [] }));
    expect(await screen.findByText('Nok')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop using' })).toBeNull();
  });
});
